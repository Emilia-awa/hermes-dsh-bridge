/**
 * dsh-harness-mcp-server — 在 Harness 内部启动 MCP server, 暴露 Harness 能力给 Hermes(大脑)。
 *
 * 工具集:
 *   - echo                : 验证 MCP server 连通
 *   - harness_list_tools  : 列出 Harness 工具注册表
 *   - agent_run           : 同步执行任务(改代码/分析/跑命令), 返回结构化结果
 *   - task_inbox          : Hermes push 结构化任务(任务+记忆上下文)到 Harness 队列, 异步执行, 返回 taskId
 *                           v0.8.0: 新增可选 callback —— 任务终态(done/error/cancelled)时主动
 *                           HTTP POST 回执(带 HMAC 签名/SSRF 防护/超时, 非阻塞), 不传即 v0.7.0 行为
 *   - task_result         : 取回任务的结构化结果(changes/verification/leftovers)
 *   - attach_session      : 把会话归组到其 cwd 对应的工作区(手动补给站)
 *   - rename_session      : 给已有会话改名
 *
 *   -- P0 批次新增 --
 *   - fs_read / fs_list / fs_stat : 受路径安全策略约束的文件查看(~/.dsh + 工作区白名单)
 *   - session_list / session_log  : 会话列表与会话日志查看(日志过 stripReasoning 过滤)
 *   - status_get / config_get     : 运行状态与配置摘要(authToken 打码)
 *   - preset_list / preset_get    : agent preset 花名册与当前会话 preset 解析
 *
 *   -- P1 批次新增 --
 *   - session_stats               : 会话统计(rounds/steps/llmTime/toolTime/ttft/tokensPerSec/cacheHitRate/tokens)
 *   - task_list                   : 异步任务队列快照(id/status/createdAt/error)
 *   - preset_set                  : 切换 preset(new-default 更新运行时默认; session 仅空白会话可切换)
 *   - fs_write                    : 写文件(opt-in: enableFsWrite, 仅限 workspaceRoots 内的路径 jail)
 *   - agent_run 结果新增 stats    : 本次执行的增量会话统计(同 session_stats 字段)
 *
 *   -- P2 批次新增 --
 *   - task_cancel                 : 取消队列任务(queued 移除 / running 尽力中止 / 终态报错)
 *   - session_search              : 跨会话搜索(标题 + 尽力内容, 单会话 2s 超时)
 *   - agent_run/task_inbox 新增 preset?: 请求级 preset 覆盖(仅影响新建/resume 的会话组合)
 *
 *   -- P3 批次新增 --
 *   - set_policy                  : 切换 live 会话的文件权限档(追加 sandbox/mode 事件; 冷会话需先 resume)
 *   - policy_get                  : 查询会话生效策略(sandboxMode/source/workspaceRoot/approvalPolicy)
 *   - approval_list               : 列出挂起审批(权限提档等; 审批桥维护的内存表)
 *   - approval_respond            : 回答挂起审批(allowed-once/rejected; 与 Web UI 先答者胜)
 *   - agent_run/task_inbox 新增 sandbox?: 请求级权限三档覆盖(read-only/workspace-write/danger-full-access;
 *     仅影响新建/resume 的会话组合; 池 key 纳入档位防同 cwd 三档互相污染)
 *   - status_get/config_get 新增 sandboxPolicy/审批桥字段; session_list 行可选 sandboxMode
 *
 *   -- P0 批次新增(v0.8.0: 任务终态主动回调) --
 *   - task_inbox 新增 callback?: 任务终态后向发起方指定端点 HTTP POST 回执
 *     (event: task:done|task:error|task:cancelled; X-DSH-Signature HMAC-SHA256 防伪造;
 *      X-DSH-Timestamp epoch_ms 防重放; replyContext opaque 原样透传用于会话路由唤醒)
 *   - 安全: 仅 http/https; 私网/链路本地(含云 metadata 169.254.169.254)默认拒绝;
 *      部署可用 allowedCallbackHosts 显式放行内网端点; 非 2xx 视为投递失败(仅告警不重试不抛错)
 *   - 兼容: 不传 callback 时 TaskItem 不携带任何回调状态, runner 收尾路径零改动, 返回体与 v0.7.0 一致
 *   - task_result/task_list/status_get 回显 notify 投递状态(delivered/failed/skipped)
 *
 * sessionId 续接: 指定 sessionId 时按 本进程池 → live 会话(UI 手开)→ 持久化 resume 三级接管,
 * 前两者都找不到才报错, 所以进程重启前/UI 手开的会话也能续接。
 * 工作区分组: cwd 先 realpath 规范化再 `workspaceRegistry.resolveByPath ?? create` + attachSession;
 * 启动时对存量未分组会话补挂一次(存量捞回)。
 *
 * 回路: Hermes 记忆 →(context)→ task_inbox → Harness agent 执行 → 结果进队列 → task_result → Hermes 持久化
 */

// ── Context 声明合并: 让 ctx.tools / ctx.llm / ctx.agents 有类型 ──
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
// 加载 'approval/request' waterfall 事件与 ApprovalOutcome 的类型声明(dsh-user-approval 已是依赖)
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// dsh-llm 0.1.2 移除了 '@deepseek-ai/dsh-llm/message' 的 isTokenDelta 导出, 改为下方内联判断(语义不变)
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
// dsh-agent-presets 0.1.2 移除了 resolveSessionPreset 导出, presetFromEvents 改为本地实现(语义不变)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'node:crypto'
// [P0 回调] HMAC 签名与恒时比较(防伪造/防时序侧信道)
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readdir, readFile, realpath, stat, writeFile, appendFile, mkdir, unlink } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
// [P0 回调] X-DSH-Timestamp 取值(签名材料与重放窗口判定共用同一时钟源)
import { performance } from 'node:perf_hooks'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join as joinPath, resolve, dirname, basename } from 'node:path'

/** Cordis 插件名 */
export const name = 'harness-mcp-server'

/** 插件版本(status_get 上报; 与 package.json 保持同步) */
const PLUGIN_VERSION = '0.9.0'

/**
 * 会话文件权限三档(与 dsh-sandbox 的 SandboxMode 一一对应; 不直接 import 该包, 免新增运行时依赖):
 *   - read-only         : 只读(仅 /dev/null 等必要 sink 可写)
 *   - workspace-write   : 工作区 + 后端临时区可写(默认)
 *   - danger-full-access: 完全绕过文件围栏 + bash 解禁, 全程无审批 —— 仅限可信环境
 * 写入路径与 dsh-sandbox-policy 的 setSandboxMode 相同: session.append('sandbox/mode', {mode}),
 * 下一次受限调用生效, 重启靠 replay 保持。
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 全部合法档位(schema 枚举与运行时校验共用) */
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** 审批桥形态: web=订阅 apiProxy mux 复用 Web 审批通道(默认; dsh 0.1.2 起 headless 组合无 apiProxy 服务, 该模式自动降级 builtin); builtin=插件内建应答器; off=关闭桥 */
export type ApprovalsBridge = 'web' | 'builtin' | 'off' | 'file-push'

/**
 * 声明依赖的核心服务。
 * workspaceRegistry/sessionPersistence/sessions 是续接/归组三个增量用到的服务——
 * 漏声明会在真实启动时拿不到服务(本插件曾经踩过, 务必与代码里的 ctx.get 对齐)。
 */
export const inject = ['tools', 'llm', 'agents', 'agentPresets', 'workspaceRegistry', 'sessionPersistence', 'sessions']

// [r2] C 项适配核查结论(dsh 0.1.2-rc.1 → 0.1.5-rc.2, 只查不重构):
//   1) ctx.agent(单数)移除: 全文件 grep `ctx.agent` 精确匹配 0 处直接访问 —— 本插件只用
//      ctx.agents(11 处, 0.1.5 仍在, dsh-agent 声明合并 `agents: AgentRegistry`)与
//      ctx.agentPresets(10 处, 仍在)。无 0.1.5 移除后崩溃的风险。
//   2) P3 面板/sidebar slot('conversation' → 'main')变化: 本插件是纯 MCP server + HTTP transport,
//      不注册任何 web 面板/UI slot(grep slot|sidebar|conversation|panel 无命中), 不受影响。
//      唯一与 web 通道相关的是可选审批桥的 apiProxy 订阅, 已按 undefined 安全降级(见 apiProxyOf)。
//   3) 会话 v3 格式(session.v3.jsonl.zstd + 无 session- 前缀目录): 已在
//      unwrapPersistedEntry / persistedInspect / persistedRowMeta 里适配, 并用真实会话文件
//      /root/.dsh/sessions/--tmp--/f9a31258-.../session.v3.jsonl.zstd 验证通过
//      (见 tests/probe_v3_real.mjs: 20/20, 含原崩溃的根因复现)。

/** 插件配置 */
export interface Config {
  http?: boolean
  port?: number
  host?: string
  /** 后端 provider(默认 deepseek-official) */
  provider?: string
  /** 执行任务的模型(默认空 = 跟随 dsh 的用户/默认设置; 配置了才覆盖) */
  model?: string
  /** 挂载的 agent preset(默认 standard) */
  preset?: string
  /** 任务队列容量上限(默认 100) */
  maxQueue?: number
  /** 已完成任务保留毫秒数(默认 10 分钟) */
  taskTtlMs?: number
  /** 常驻 agent 会话上限(默认 8, LRU 淘汰) */
  maxAgents?: number
  /** Bearer token 认证(设置后所有请求必须带 Authorization: Bearer <token>) */
  authToken?: string
  /** cwd 白名单(设置后 agent 只能在列出的目录下干活) */
  workspaceRoots?: string[]
  /** 是否注册 fs_write 工具(P1, 默认关闭; 打开后也仅限 workspaceRoots 内) */
  enableFsWrite?: boolean
  /** 新建/resume 会话的默认文件权限档(默认 'workspace-write'; danger-full-access=无审批任意读写, 仅限可信环境) */
  defaultSandbox?: SandboxMode
  /** 审批桥模式(P3, 默认 'web'; deprecated: dsh 0.1.2 起不 inject apiProxy, headless 组合下 web 自动降级 builtin): web=订阅 apiProxy mux 复用 Web 审批通道; builtin=插件内建应答器(apiProxy 缺失时自动降级); off=关闭桥(审批回到 fail-closed) */
  approvalsBridge?: ApprovalsBridge
  /** 审批等待超时毫秒(P3, 默认 300000)。超时 settle cancelled(builtin)/rejected(web 协议无 cancelled) —— 绝不超时放行 */
  approvalTimeoutMs?: number
  /** 审批文件推送目录(P3 file-push 桥, 默认 ~/.dsh/approvals/)。Hermes 将在该目录下发现 pending_<id>.json 并写 response_<id>.json 回答 */
  approvalFileDir?: string
  /** [P0 回调] 任务回调全局开关(默认 true; false 时所有 callback 参数直接 skipped, 纯逃生阀) */
  notifyEnabled?: boolean
  /** [P0 回调] 默认回调密钥(任务级 callback.secret 缺省时使用; 空=不签名) */
  defaultCallbackSecret?: string
  /** [P0 回调] 私网/回环回调目标放行名单(精确 host:port 或 host; 命中即放行 SSRF 私网拦截; 用于本机内网 Hermes 网关) */
  allowedCallbackHosts?: string[]
  /**
   * [r1 回调预设] 部署级默认回调(task_inbox 不传 callback, 或只传部分字段时自动套用; 任务级覆盖部署级)。
   * 目的: 把"url/headers/events/replyContext 每次手写、漏一个就静默失效"收敛成配一次。
   * 不配 = 与旧版完全一致(零行为变化)。
   */
  callbackPreset?: CallbackPresetConfig
}

/**
 * [r1] 部署级回调预设(PLAN_r1 §2.3)。
 * 注意: **不设 secret 字段**(裁决 D7) —— secret 是安全凭据, 唯一权威来源是 defaultCallbackSecret;
 * 需要自定义头(如 Hermes 只认的 X-Gitlab-Token)时用 headers 显式承载。
 * 预设**不放宽任何安全策略**(裁决 D9): SSRF 守卫在合并之后照常执行。
 */
export interface CallbackPresetConfig {
  /** 默认回调接收地址(有了它, 调用方可以完全不传 callback) */
  url?: string
  /** 默认 HTTP 方法(默认 POST) */
  method?: 'POST' | 'PUT'
  /** 默认请求头(与任务级 headers 浅合并, 任务级同名覆盖; 保留头一律剔除) */
  headers?: Record<string, string>
  /** 默认订阅事件(缺省 = ['done','error']; 显式 [] = 订阅全部, 对齐 Hermes 桥侧语义) */
  events?: Array<'done' | 'error' | 'cancelled'>
  /** 默认 replyContext(与任务级 replyContext 深合并一层, 任务级优先; 静态字段放这里) */
  replyContext?: Record<string, unknown>
  /** 默认投递超时毫秒(默认 5000, 范围 [1000,30000]) */
  timeoutMs?: number
  /** 是否允许"不传 callback"也自动套用预设(默认 true) */
  autoApply?: boolean
  /**
   * (可选, 默认 false)是否强制要求本次回调能解析出路由字段。
   * 背景: Hermes 侧已按 replyContext 路由(deliver_extra.chat_id = {replyContext.replyChatId}),
   * 而 Hermes 模板取不到值时会**原样返回字面量串**当 chat_id → 静默误投。开启本项后,
   * 若合并结果里没有任何 *ChatId/chatId 字段则直接报错, 用一次配置换掉一整类静默故障。
   */
  requireReplyRoute?: boolean
}

/** [r1] config_get 用的预设摘要(只回显结构, 绝不回显 secret / header 值) */
function describeCallbackPreset(): Record<string, unknown> {
  const p = runtimeConfig.callbackPreset
  if (!p || p.url === undefined) return { configured: false }
  return {
    configured: true,
    url: p.url,
    method: p.method ?? 'POST',
    // [r1] 头名走与投递同款的净化(保留头会被剔除), 避免回显与实际投递不一致
    headerNames: Object.keys(sanitizeCallbackHeaders(p.headers) ?? {}),
    events: p.events ?? ['done', 'error'],
    timeoutMs: p.timeoutMs ?? 5000,
    hasReplyContext: p.replyContext !== undefined,
    replyContextKeys: Object.keys(p.replyContext ?? {}),
    autoApply: p.autoApply !== false,
    requireReplyRoute: p.requireReplyRoute === true,
  }
}

/**
 * [r1] 部署配置校验: 非法 callbackPreset 一律回落到"未配置"(并告警), 不阻断启动。
 * 逐字段校验, 任何一项类型不对就整体判非法 —— 回调配置错配会导致静默失效, 宁可显式告警。
 * @returns 规范化后的预设; undefined = 非法
 */
function normalizeCallbackPreset(raw: unknown): CallbackPresetConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: CallbackPresetConfig = {}
  if (r.url !== undefined) {
    if (typeof r.url !== 'string' || !r.url.trim()) return undefined
    out.url = r.url.trim()
  }
  if (r.method !== undefined) {
    if (r.method !== 'POST' && r.method !== 'PUT') return undefined
    out.method = r.method
  }
  if (r.headers !== undefined) {
    if (typeof r.headers !== 'object' || r.headers === null || Array.isArray(r.headers)) return undefined
    if (!Object.values(r.headers as Record<string, unknown>).every((v) => typeof v === 'string')) return undefined
    out.headers = { ...(r.headers as Record<string, string>) }
  }
  if (r.events !== undefined) {
    if (!Array.isArray(r.events) || !r.events.every((e) => e === 'done' || e === 'error' || e === 'cancelled')) return undefined
    out.events = [...(r.events as Array<'done' | 'error' | 'cancelled'>)]
  }
  if (r.replyContext !== undefined) {
    if (typeof r.replyContext !== 'object' || r.replyContext === null || Array.isArray(r.replyContext)) return undefined
    out.replyContext = { ...(r.replyContext as Record<string, unknown>) }
  }
  if (r.timeoutMs !== undefined) {
    const t = Number(r.timeoutMs)
    if (!Number.isInteger(t) || t < 1000 || t > 30000) return undefined
    out.timeoutMs = t
  }
  if (r.autoApply !== undefined) {
    if (typeof r.autoApply !== 'boolean') return undefined
    out.autoApply = r.autoApply
  }
  if (r.requireReplyRoute !== undefined) {
    if (typeof r.requireReplyRoute !== 'boolean') return undefined
    out.requireReplyRoute = r.requireReplyRoute
  }
  // 完全不配 url 的预设没有任何意义(不会触发任何回调), 视为"未配置"
  if (out.url === undefined) return undefined
  return out
}

/** 运行时配置默认值(apply 时重置再叠加 config, 保证重复 apply 幂等不残留上一次的状态) */
const runtimeConfigDefaults = () => ({
  provider: 'deepseek-official',
  // 空字符串 = 不覆盖 model, 跟随 dsh 的用户/默认设置; 显式配置则覆盖
  model: '',
  preset: 'standard',
  maxQueue: 100,
  taskTtlMs: 10 * 60 * 1000,
  maxAgents: 8,
  authToken: '',
  workspaceRoots: [] as string[],
  enableFsWrite: false,
  defaultSandbox: 'workspace-write' as SandboxMode,
  approvalsBridge: 'web' as ApprovalsBridge,
  approvalTimeoutMs: 300 * 1000,
  approvalFileDir: joinPath(homedir(), '.dsh', 'approvals'),
  // [P0 回调] 任务终态主动回调默认值(不传 callback 时零成本: 不构建任何对象/不进任何分支)
  notifyEnabled: true,
  defaultCallbackSecret: '',
  allowedCallbackHosts: [] as string[],
  // [r1] 部署级回调预设默认不配(undefined = 与旧版完全一致; 配了才生效)
  callbackPreset: undefined as CallbackPresetConfig | undefined,
})

/** 运行时配置(apply 时从 config 初始化, 提供安全默认值) */
const runtimeConfig = runtimeConfigDefaults()

/** HTTP server 运行信息(apply 时记录, status_get/config_get 上报) */
const serverRuntime = {
  port: 0 as number,
  host: '' as string,
  startedAt: Date.now(),
}

// ═══════════════════════ logfilter: reasoning/thinking 剥离 ═══════════════════════

/** 属于推理块的 content block type(extractText 遇到直接整块跳过) */
const REASONING_BLOCK_TYPES = new Set(['thinking', 'reasoning'])

/** 文本内嵌的推理块正则: 标签对 + 围栏代码块(<think> 为 DeepSeek R1 风格, 一并剥除) */
const REASONING_TEXT_PATTERNS: RegExp[] = [
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /<think>[\s\S]*?<\/think>/gi,
  /```thinking[^\n]*\n[\s\S]*?```/gi,
]

/**
 * 从 assistant 文本中剥离 thinking/reasoning 块, 只保留最终 assistant 文本。
 * 对非字符串输入返回空串; 剥离后压缩 3 连以上空行并 trim。
 */
function stripReasoning(text: unknown): string {
  if (typeof text !== 'string' || !text) return ''
  let cleaned = text
  for (const re of REASONING_TEXT_PATTERNS) cleaned = cleaned.replace(re, '')
  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

/** 该 content block 是否为推理块(type === 'thinking'|'reasoning') */
function isReasoningBlock(rec: Record<string, unknown>): boolean {
  return typeof rec.type === 'string' && REASONING_BLOCK_TYPES.has(rec.type)
}

/**
 * 共享文本收集器: 递归收集 obj 里所有 string 型 text/content 字段。
 * - 整块跳过 type==='thinking'|'reasoning' 的对象(不递归其内部);
 * - 跳过名为 thinking/reasoning/reasoning_content 的字段。
 * executeTask 的 tool/result 提取与 session_log 的日志摘录共用此实现。
 */
function collectText(obj: unknown, out: string[]): void {
  if (Array.isArray(obj)) {
    for (const x of obj) collectText(x, out)
    return
  }
  if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>
    if (isReasoningBlock(rec)) return
    if (typeof rec.text === 'string' && rec.text.trim()) out.push(rec.text)
    if (typeof rec.content === 'string' && rec.content.trim()) out.push(rec.content)
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'thinking' || k === 'reasoning' || k === 'reasoning_content') continue
      collectText(v, out)
    }
  }
}

// ═══════════════════════ 输出硬上限(fs/session 工具共用) ═══════════════════════

const FS_READ_MAX_CHARS = 48 * 1024 // fs_read 单次返回内容上限
const FS_READ_MAX_FILE_BYTES = 8 * 1024 * 1024 // 超过直接拒绝读取
const FS_LIST_MAX_ENTRIES = 1000 // fs_list 条目上限
const FS_WRITE_MAX_BYTES = 4 * 1024 * 1024 // fs_write 单次内容上限(防滥用)
const SESSION_LOG_MAX_CHARS = 60 * 1024 // session_log 全局输出上限
const SESSION_LOG_MAX_EVENTS = 50 // [r3] A1: session_log 默认事件条数上限(超限返回首尾 + truncated)
const SESSION_LOG_HEAD_EVENTS = 5 // [r3] A1: 截断时额外保留的最旧事件数
const SESSION_LIST_MAX_ROWS = 50 // session_list 行数硬上限
// [r1] B2: session_list detail:'full' 时逐行检视的并发度与单会话超时。
// 并发 4 与官方 SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY 对齐(PLAN_r1 §1.7 B2)。
const SESSION_LIST_INSPECT_CONCURRENCY = 4
const SESSION_LIST_INSPECT_TIMEOUT_MS = 3000
const DEFAULT_LOG_TYPES = ['user/message', 'assistant/message', 'tool/call', 'tool/result']

/** 工具回调统一返回 MCP text content */
function out(content: string) {
  return { content: [{ type: 'text' as const, text: content }] }
}

/** 工作区视图(ctx.get('workspaceRegistry')): 可选依赖, headless/无 workspace 插件的环境自动跳过 */
interface WorkspaceView {
  id: string
  path: string
  sessionIds: readonly SessionId[]
  attachSession?: (sessionId: SessionId) => Promise<void>
}
interface WorkspaceRegistryView {
  create?: (path: string) => Promise<WorkspaceView>
  resolveByPath?: (path: string) => Promise<WorkspaceView | undefined>
  list?: () => WorkspaceView[]
}

/**
 * cwd realpath 规范化: 解析符号链接与 .. 段, 使 cwd 能与 workspace.path(存储时为 realpath 规范化值)
 * 精确比对——这是官方 attachSession 强校验通过的前提。目录不存在时回退 resolve 结果, 由调用方告警不阻断。
 */
async function canonicalCwd(raw: string): Promise<string> {
  try {
    return await realpath(raw)
  } catch {
    return resolve(raw)
  }
}

// ═══════════════════════ fs 工具: 路径安全策略 ═══════════════════════

/** fs 工具允许读取的根: ~/.dsh + 进程 cwd + 配置 workspaceRoots + 已注册工作区(realpath 规范化) */
async function fsAllowedRoots(ctx: Context): Promise<string[]> {
  const roots = new Set<string>()
  try {
    roots.add(await realpath(joinPath(homedir(), '.dsh')))
  } catch { /* ~/.dsh 不存在时跳过 */ }
  try {
    roots.add(await realpath(process.cwd()))
  } catch {
    roots.add(resolve(process.cwd()))
  }
  for (const r of runtimeConfig.workspaceRoots) roots.add(await canonicalCwd(r))
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryView | undefined
  for (const ws of registry?.list?.() ?? []) {
    try {
      roots.add(await realpath(ws.path))
    } catch { /* 已注销目录跳过 */ }
  }
  return [...roots]
}

/**
 * 敏感路径判定(对 realpath 规范化后的绝对路径逐段检查):
 * .ssh 目录及其内部 / .env 或 .env.* / 名字含 token / *.pem
 */
function isSensitivePath(canonical: string): boolean {
  for (const seg of canonical.split('/')) {
    const s = seg.toLowerCase()
    if (!s) continue
    if (s === '.ssh') return true
    if (s === '.env' || s.startsWith('.env.')) return true
    if (s.includes('token')) return true
    if (s.endsWith('.pem')) return true
  }
  return false
}

/** fs 工具统一准入: realpath 规范化 → 敏感名拒绝 → 白名单根包含校验。通过返回 canonical, 否则返回 error。 */
async function gateFsPath(ctx: Context, rawPath: string): Promise<{ canonical?: string; error?: string }> {
  const resolved = resolve(rawPath ?? '.')
  let canonical: string
  try {
    canonical = await realpath(resolved)
  } catch {
    return { error: `path not found: ${rawPath}` }
  }
  // 敏感名先拒: 即使落在白名单内也不允许读(.ssh/.env/*token*/*.pem)
  if (isSensitivePath(canonical)) return { error: `path denied by policy (sensitive name): ${rawPath}` }
  const roots = await fsAllowedRoots(ctx)
  const allowed = roots.some((r) => canonical === r || canonical.startsWith(r + '/'))
  if (!allowed) return { error: `path outside allowed roots (~/.dsh + workspaces): ${canonical}` }
  return { canonical }
}

/**
 * fs_stat 专用软准入: 目标不存在(realpath 失败)时不报错, 改用 resolve 结果做策略判定,
 * 通过则交回 {missing:true} 让调用方返回 exists:false(不泄露白名单外路径的存在性)。
 */
async function gateFsPathSoft(ctx: Context, rawPath: string): Promise<{ canonical?: string; missing?: boolean; error?: string }> {
  const resolved = resolve(rawPath ?? '.')
  const hard = await gateFsPath(ctx, resolved)
  // 存在且通过/明确拒绝(敏感名/越界) → 照搬硬准入结论
  if (!hard.error || !hard.error.startsWith('path not found')) return hard
  // 目标不存在 → 软判定: 仍按策略校验 resolve 结果, 通过则交回 missing 标记
  if (isSensitivePath(resolved)) return { error: `path denied by policy (sensitive name): ${rawPath}` }
  const roots = await fsAllowedRoots(ctx)
  const allowed = roots.some((r) => resolved === r || resolved.startsWith(r + '/'))
  if (!allowed) return { error: `path outside allowed roots (~/.dsh + workspaces): ${resolved}` }
  return { canonical: resolved, missing: true }
}

// ═══════════════════════ [r2] B: 调用路径简化(默认值 + 自解释提示) ═══════════════════════

/**
 * [r2] B: 任务类工具的默认工作目录。
 * 远程 agent 调用时 process.cwd() 通常是 dsh 进程的启动目录(对 Hermes 无意义),
 * 因此优先用插件配置的 workspaceRoots[0](部署方显式声明的工作区), 没配才回落 process.cwd()。
 * 该默认值在 agent_run/task_inbox 的 cwd 参数描述里明写, 让 agent 不用猜。
 */
function defaultTaskCwd(): string {
  return runtimeConfig.workspaceRoots[0] ?? process.cwd()
}

/** [r2] B: 默认工作目录的人类可读描述(拼进工具描述与参数描述) */
function defaultCwdHint(): string {
  return runtimeConfig.workspaceRoots.length > 0
    ? `默认工作区 ${runtimeConfig.workspaceRoots[0]} (来自插件配置 workspaceRoots[0])`
    : `默认进程当前目录 ${process.cwd()} (未配置 workspaceRoots)`
}

/**
 * [r2] A/B: 统一的"下一步怎么办"提示片段 —— 让每个错误/结果都能自解释, agent 不用猜链路。
 * 抽成常量便于 26 个工具的描述与错误文案保持措辞一致。
 */
const HINT = {
  /** 拿到 taskId 之后干什么 */
  pollTask: '用 task_result(taskId=...) 取结果; 想看队列全貌用 task_list; 想中途放弃用 task_cancel(taskId=...)',
  /** 拿到 sessionId 之后干什么 */
  resumeSession: '续接此会话时把 sessionId 传给 agent_run 或 task_inbox; 看对话历史用 session_log(sessionId=...)',
  /** 会话找不到 */
  sessionMissing: 'session not found',
  /** 长任务建议 */
  longTask: '预计耗时 > 5 分钟或需要中途取消的任务, 请改用 task_inbox(异步队列)',
} as const

/** [r2] A: 会话类错误的统一后缀(下一步动作) */
/** [r3] C7: 会话不存在 —— 走统一句式 `<错误>: <关键值> (<原因>; <下一步>)` */
function sessionNotFoundError(sessionId: string): string {
  return idNotFoundError('session', sessionId, '用 session_list 查看当前会话列表, 或先用 agent_run 建一个')
}

/** [r2] A / [r3] C7: 任务类错误 —— 统一句式 + 保留 TTL 提示 */
function taskNotFoundError(taskId: string): string {
  return idNotFoundError('task', taskId, `用 task_list 查看当前队列; 任务默认保留 ${Math.round(runtimeConfig.taskTtlMs / 60000)} 分钟`)
}

// ═══════════════════ [r3] A: 输出精简/格式化 + C: 错误文案与参数预校验 ═══════════════════
//
// R2 已把 26 个工具描述写成"面向 agent"; R3 处理 agent 真正拿到的返回体与错误串:
//   A: 时间戳统一 ISO8601(本地时区) + *_at_epoch 保留原始 epoch; 字节/时长带人类可读单位;
//      列表类返回分页(offset/limit)+ total/truncated; session_log 默认限 50 条并给 truncated 取更多提示。
//   C: 三类错误(必传参数缺失 / id 不存在 / 会话为空)统一为
//      `<错误>: <关键值> (<原因一句话>; <下一步动作>)`; 入口先做类型/必填校验并回显 expected/got;
//      dsh 服务未启动/连接拒绝统一提示检查 dsh.service。

/**
 * [r3] C: 三类错误统一文案构造器 —— `<错误>: <关键值> (<原因一句话>; <下一步动作>)`。
 * 所有工具的错误串都经此拼装(不再各自手写后缀), 保证 agent 每次都能读到"下一步动作"。
 */
function errText(code: string, key: string, reason: string, next: string): string {
  return `${code}: ${key} (${reason}; ${next})`
}

/** [r3] C: 必传参数缺失(含期望类型, 便于 agent 直接改对) */
function missingParamError(tool: string, param: string, expected: string): string {
  return errText('missing required parameter', `${tool}.${param}`, `expected ${expected}, got nothing`, `补上 ${param} 后重试; 参数说明见 ${tool} 的工具描述`)
}

/** [r3] C: id 不存在(会话/任务/preset 三类共用同一句式) */
function idNotFoundError(kind: 'session' | 'task' | 'preset', id: string, next: string): string {
  const reason = kind === 'session' ? '不存在或已过期' : kind === 'task' ? '已过期或从未存在' : '不在当前部署的 preset 名单里'
  return errText(`${kind} not found`, id, reason, next)
}

/** [r3] C: 会话为空(存在但没有任何事件) */
function emptySessionError(sessionId: string): string {
  return errText('session is empty', sessionId, '该会话存在但还没有任何事件', '先跑一轮 agent_run/task_inbox 带上这个 sessionId, 或用 session_list 另选一个会话')
}

/**
 * [r3] C: dsh 服务未启动/连接拒绝的判定(错误串或 error.code 命中即算)。
 * 命中后统一附「检查 dsh.service 状态」指引, 避免 agent 只看到裸 ECONNREFUSED。
 */
function isDshServiceDown(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown; cause?: { code?: unknown } } | undefined
  const code = String(err?.code ?? err?.cause?.code ?? '')
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT') return true
  const msg = String(err?.message ?? e ?? '')
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|socket hang up|connection refused|fetch failed|connect failed/i.test(msg)
}

/** [r3] C: dsh 服务不可用的统一指引(检查 dsh.service 状态) */
const DSH_DOWN_NEXT = 'dsh 服务可能未启动或已断开; 检查 dsh.service 状态(systemctl status dsh.service, 必要时 systemctl restart dsh.service)后重试'

/** [r3] C: 所有工具 catch 分支的兜底包装 —— 服务类错误走 dsh.service 指引, 其余原样补原因 */
function toolFailure(tool: string, e: unknown): string {
  if (isDshServiceDown(e)) return errText(`${tool} failed`, 'dsh service unreachable', '连接被拒绝或服务未监听', DSH_DOWN_NEXT)
  return errText(`${tool} failed`, (e as Error)?.message ?? String(e), '工具执行过程中抛错', `确认参数正确后重试; 仍失败请用 status_get 检查服务运行态`)
}

/**
 * [r3] C: 参数预校验(在工具入口统一调用, 早于任何业务逻辑)。
 * 只校验"必填存在 + 类型"两类, 报错回显 `expected X, got Y`; 全部通过返回 undefined。
 */
function validateArgs(tool: string, args: Record<string, unknown>, spec: { name: string; type: 'string' | 'number' | 'boolean' | 'array' | 'object'; required?: boolean }[]): string | undefined {
  const got = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
  for (const s of spec) {
    const v = args[s.name]
    if (v === undefined || v === null) {
      if (s.required) return missingParamError(tool, s.name, s.type)
      continue
    }
    if (got(v) !== s.type) {
      return errText('invalid parameter type', `${tool}.${s.name}`, `expected ${s.type}, got ${got(v)}`, `改成 ${s.type} 后重试`)
    }
  }
  return undefined
}

/** [r3] A: 时间戳统一输出形态 —— 人类可读 ISO8601(本地时区) + 原始 epoch 供排序 */
interface HumanTime { at: string; at_epoch: number }

/** [r3] A: epoch(ms) → { at: <ISO8601 本地时区>, at_epoch: <原始 ms> }; 非法/缺失值原样回显 */
function humanTime(at: number | undefined): HumanTime | undefined {
  if (at === undefined || !Number.isFinite(at)) return undefined
  // 本地时区 ISO8601(带 ±HH:MM 偏移), 秒级: 2024-05-01T12:34:56+08:00
  const d = new Date(at)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return { at: iso, at_epoch: Math.round(at) }
}

/** [r3] A: 时间戳展开成两个字段: <prefix> 为 ISO8601 人类可读, <prefix>_epoch 为原始毫秒 */
function timeFields(prefix: string, at: number | undefined): Record<string, unknown> {
  const h = humanTime(at)
  return h === undefined ? {} : { [prefix]: h.at, [`${prefix}_epoch`]: h.at_epoch }
}

/** [r3] A: 字节数 → 人类可读(9.4KB / 1.2MB); 原始值由调用方以 <name>_bytes 保留 */
function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? Math.round(kb * 10) / 10 : Math.round(kb)}KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)}MB`
  return `${Math.round((mb / 1024) * 10) / 10}GB`
}

/** [r3] A: 毫秒 → 人类可读时长(8.8s / 1.5m / 250ms); 原始值由调用方以 <name>Ms 保留 */
function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const m = s / 60
  if (m < 60) return `${Math.round(m * 10) / 10}m`
  return `${Math.round((m / 60) * 10) / 10}h`
}

/** [r3] A: 列表类返回的通用分页常量(超 20 条截断, 并给 total/truncated/next) */
const LIST_PAGE_DEFAULT = 20
const LIST_PAGE_MAX = 100

/** [r3] A: 列表分页参数解析(offset 从 0 开始; limit 夹在 [1, LIST_PAGE_MAX]) */
function parsePage(offset: unknown, limit: unknown, def = LIST_PAGE_DEFAULT): { offset: number; limit: number } {
  const off = Number.isFinite(Number(offset)) ? Math.max(0, Math.trunc(Number(offset))) : 0
  const lim = Number.isFinite(Number(limit)) ? Math.min(Math.max(1, Math.trunc(Number(limit))), LIST_PAGE_MAX) : def
  return { offset: off, limit: lim }
}

/** [r3] A: 列表类返回的统一分页信封(total=过滤后总数, count=本页条数, truncated + next 提示) */
function pageEnvelope<T>(rows: readonly T[], offset: number, limit: number, tool: string): {
  page: T[]
  meta: { total: number; count: number; offset: number; limit: number; truncated: boolean; hasMore: boolean; next?: string }
} {
  const page = rows.slice(offset, offset + limit)
  const hasMore = offset + page.length < rows.length
  return {
    page: [...page],
    meta: {
      total: rows.length,
      count: page.length,
      offset,
      limit,
      truncated: hasMore,
      hasMore,
      ...(hasMore ? { next: `结果超过 ${limit} 条已截断; 用 ${tool}(offset=${offset + page.length}, limit=${limit}) 取下一页` } : {}),
    },
  }
}

/** [r3] A: 分页参数 schema(列表类工具共用, 保证 26 个工具的分页口径一致) */
const pageArgSchema = {
  offset: z.number().int().min(0).optional().describe('跳过前 N 条(默认 0; 配合 limit 翻页)'),
  limit: z.number().int().min(1).max(LIST_PAGE_MAX).optional().describe(`本页最多返回条数(默认 ${LIST_PAGE_DEFAULT}, 最大 ${LIST_PAGE_MAX})`),
}

// ═══════════════════════ P0: 任务终态主动回调 schema(v0.8.0, REQ_CALLBACK_IMPL.md §1) ═══════════════════════
//
// 与 REQ §1 的字段逐一对应: url/method/headers/secret/events/replyContext/timeoutMs。
// - replyContext 为 opaque(z.unknown), 序列化 ≤4KB 在 resolveCallback 里校验(schema 层无法表达);
// - url 的 SSRF 防护(scheme/私网/metadata/白名单)在 resolveCallback 运行时层做, schema 只挡明显非法。
// - [r1] **url / method / events / timeoutMs 一律不设 schema 层 .default()**:
//   部署级回调预设(callbackPreset)必须能区分"调用方没传"(→ 用预设值)与"调用方显式传了"
//   (→ 任务级优先, 含 events:[] 这种"显式空"), schema 的 default 会把两者压成同一个值, 必须先去掉。
//   缺省语义统一在 resolveCallback 里按"任务级 > 预设 > 内置默认"三级回落(PLAN_r1 §2.4)。
const callbackSchema = z.object({
  // [r1] url 在 schema 层必须是 **optional**: MCP SDK 在进入 handler 之前就按 schema 校验,
  // 若这里写 required, 那么"部署配了 callbackPreset.url、调用方只传 replyContext"这条路径
  // 会被 SDK 直接以 -32602 拒掉, 根本走不到 resolveCallback 里的预设合并。
  // 真正的"必须能解析出 url"约束下沉到 resolveCallback(合并后仍为空才报错)。
  url: z.string().url().optional().describe('回调接收地址(仅 http/https; 私网/回环/云 metadata 地址默认拒绝, 内网端点用部署配置 allowedCallbackHosts 放行); 若部署配置了 callbackPreset.url 则可不传'),
  method: z.enum(['POST', 'PUT']).optional().describe('回调 HTTP 方法(默认取部署预设, 否则 POST)'),
  headers: z.record(z.string(), z.string()).optional().describe('自定义请求头(host/content-length/connection/transfer-encoding 为保留头会被忽略; 与部署预设浅合并, 任务级同名覆盖)'),
  secret: z.string().optional().describe('HMAC-SHA256 签名密钥(缺省用部署配置 defaultCallbackSecret; 两者皆空 = 不签名), 用于在 X-DSH-Signature 头中防伪造'),
  events: z.array(z.enum(['done', 'error', 'cancelled'])).optional().describe('订阅哪些终态事件(缺省取部署预设, 否则 ["done","error"]; 传 [] = 订阅全部, 对齐 Hermes 桥侧语义; "cancelled" 该事件不含 result)'),
  replyContext: z.unknown().optional().describe('调用方自定义上下文(如 replyChatId/platform 等), opaque 原样在回调载荷 replyContext 字段中回传(序列化后 ≤4KB), 供发起方会话路由/唤醒; 与部署预设深合并(任务级优先)'),
  timeoutMs: z.number().int().min(1000).max(30000).optional().describe('单次投递超时毫秒(缺省取部署预设, 否则 5000; 上限 30000)'),
})

// fs_write 专用路径 jail(P1): 只允许 workspaceRoots 内的路径(比 fs_read 的 ~/.dsh+工作区 更严),
// 且拒绝敏感名(.ssh / .env / 含 token / .pem 结尾)。目标文件本身可以尚不存在: 向上找到最近存在祖先做
// realpath, 再把剩余段词法拼回(resolve 处理 .. 段), 最后仍按白名单包含校验——不存在的中间目录不会被
// 符号链接劫持。未配置 workspaceRoots 时整体不可用(fs_write 无 jail 不开门)。
async function gateFsWritePath(rawPath: string): Promise<{ canonical?: string; error?: string }> {
  if (runtimeConfig.workspaceRoots.length === 0) {
    return { error: 'fs_write unavailable: no workspaceRoots configured (fs_write is jailed to workspaceRoots)' }
  }
  const resolved = resolve(rawPath ?? '.')
  // 最近存在祖先 realpath + 剩余段词法回拼
  let anchor = resolved
  const tail: string[] = []
  for (;;) {
    try {
      anchor = await realpath(anchor)
      break
    } catch {
      const parent = dirname(anchor)
      if (parent === anchor) return { error: `path not resolvable: ${rawPath}` }
      tail.unshift(basename(anchor))
      anchor = parent
    }
  }
  const canonical = tail.length > 0 ? resolve(anchor, ...tail) : anchor
  // 敏感名先拒(写比读更严: 即使在白名单内也拒绝)
  if (isSensitivePath(canonical)) return { error: `path denied by policy (sensitive name): ${rawPath}` }
  const roots = await Promise.all(runtimeConfig.workspaceRoots.map((r) => canonicalCwd(r)))
  const allowed = roots.some((r) => canonical === r || canonical.startsWith(r + '/'))
  if (!allowed) return { error: `path outside workspaceRoots (fs_write jail): ${canonical}` }
  return { canonical }
}

/** 官方 session.create RPC 同款姿势: resolveByPath ?? create, 幂等; 无 workspaceRegistry 时返回 undefined */
async function ensureWorkspace(ctx: Context, canonical: string): Promise<WorkspaceView | undefined> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryView | undefined
  if (!registry) return undefined
  return (await registry.resolveByPath?.(canonical)) ?? (await registry.create?.(canonical))
}

/** 把会话挂名到其 cwd 对应的工作区。attachSession 内部强校验 realpath(header.cwd) 精确等于 workspace.path,
 *  所以 canonical 必须是 header.cwd 的 realpath 规范化值。失败告警不阻断任务(分组是锦上添花)。 */
async function attachToWorkspace(ctx: Context, canonical: string, sessionId: SessionId): Promise<void> {
  try {
    const ws = await ensureWorkspace(ctx, canonical)
    if (ws?.attachSession) await ws.attachSession(sessionId)
  } catch (e) {
    console.warn('[harness-mcp-server] workspace attach failed:', (e as Error)?.message ?? e)
  }
}

/** 按会话 header 的 cwd(realpath 规范化后)补挂工作区; header 无 cwd 时静默跳过 */
async function attachSessionCwd(ctx: Context, sessionId: SessionId, cwd: string | undefined): Promise<void> {
  if (cwd === undefined) return
  await attachToWorkspace(ctx, await canonicalCwd(cwd), sessionId)
}

/** 常驻 agent 会话(按 cwd 复用, 省 token: 避免每次全量加载项目上下文); preset/sandbox 记录组合时所固化值 */
const liveAgents = new Map<string, { sessionId: SessionId; handle: AgentHandle; preset: string; sandbox: SandboxMode }>()

/** sessionId → cwd 索引(支持按 session 续接: 指定 sessionId 时定位到对应 cwd 的常驻会话) */
const sessionToCwd = new Map<string, string>()

/** 每个 cwd 的串行执行锁(防同一 agent 会话被并发 followup 冲突) */
const agentLocks = new Map<string, Promise<unknown>>()

/** getAgent 的返回: handle 恒有 .agent; resume 出来的独占句柄带 disposeAfter 标记, 任务结束后应 flush+dispose */
interface ResolvedAgent {
  sessionId: SessionId
  handle: AgentHandle
  /** true = 本插件 resume 出来的独占句柄; false/缺省 = 常驻池会话或 live 接管(生命周期归池/owner) */
  disposeAfter?: boolean
}

/** 获取(或创建)指定 cwd 的常驻 agent 会话; 传 sessionId 时接管指定会话; 传 title 时给新会话命名;
 *  传 requestPreset 时本次组装用该 preset(A: 请求级覆盖, 仅影响新建/resume, 已有会话组合固化不换);
 *  传 requestSandbox 时本次组装用该文件权限档(P3: 同 preset 语义 —— 新建/resume 成功后种 sandbox/mode
 *  事件, 池 key 纳入档位(请求档≠会话固化档不复用、非默认档不入池), 防同 cwd 三档互相污染) */
async function getAgent(ctx: Context, cwd: string, sessionId?: string, title?: string, requestPreset?: string, requestSandbox?: SandboxMode): Promise<ResolvedAgent> {
  // A/P3: 生效值 = 请求级覆盖 ?? 运行时默认(三级覆盖链里的 request 级)
  const effectivePreset = requestPreset ?? runtimeConfig.preset
  const effectiveSandbox = requestSandbox ?? runtimeConfig.defaultSandbox
  // 指定 sessionId: 接管已有会话(长任务分多轮投喂 / 中断后恢复 / UI 手开的会话)
  if (sessionId) {
    // 先看本进程常驻池(指定 sessionId 时定位到对应 cwd 的常驻会话; 命中 LRU 移到末尾, 保留上游语义)
    const targetCwd = sessionToCwd.get(sessionId)
    if (targetCwd !== undefined) {
      const existing = liveAgents.get(targetCwd)
      if (existing) {
        liveAgents.delete(targetCwd)
        liveAgents.set(targetCwd, existing)
        return existing
      }
    }
    const sid = SessionId(sessionId)
    // 不在常驻池: 看 live(UI 手开的、别的插件持有的会话), 直接接管、不持有 dispose(归其 owner)
    const live = ctx.agents.get(sid)
    if (live) {
      // live 会话也补挂工作区(幂等): 用户手开的会话若尚未归组, 这里一并挂名
      await attachSessionCwd(ctx, sid, live.session.header.cwd)
      // no-op dispose 兜底: executeTask 只在 disposeAfter 为 true 时调用 dispose
      return { sessionId: sid, handle: { agent: live, dispose: () => Promise.resolve() }, disposeAfter: false }
    }
    // live 也没有: 从持久化会话存储 resume 并接管(进程重启前的会话、LRU 淘汰后被释放的会话)
    let handle: AgentHandle
    try {
      handle = await ctx.agents.resume({
        resumeSessionId: sid,
        agentOptions: {
          provider: runtimeConfig.provider,
          // model 为空则省略, 让 dsh 跟随用户/默认设置; 显式配置则覆盖
          ...(runtimeConfig.model ? { model: runtimeConfig.model } : {}),
        },
        setup: async (agentCtx) => {
          // 同 create 路径: dsh rc.6 agent ctx 可能丢 scope tag, 检测不到就跳过挂载(降级为无工具 agent)
          if (scopeOf(agentCtx) === undefined) {
            console.warn('[harness-mcp-server] agent ctx unscoped (dsh rc.6 bug); preset mount skipped — upgrade dsh for full tool support')
            return
          }
          await ctx.agentPresets.mount(agentCtx, effectivePreset)
        },
      })
    } catch (e) {
      // 恢复失败返回明确错误(沿用上游错误风格): 不在常驻池、不是 live、持久化里也没有(或 resume 失败)
      throw new Error(`session not found for resume: ${sessionId} (not live and not persisted; ${(e as Error)?.message ?? e})`)
    }
    await attachSessionCwd(ctx, sid, handle.agent.session.header.cwd)
    // P3: resume 成功后种 sandbox/mode 事件(dsh setSandboxMode 同款), 本次组装档位固化
    try {
      appendSandboxMode(handle.agent.session as unknown as PolicySessionLike, effectiveSandbox)
    } catch (e) {
      console.warn('[harness-mcp-server] sandbox mode seed failed on resume:', String(e))
    }
    return { sessionId: sid, handle, disposeAfter: true }
  }
  const existing = liveAgents.get(cwd)
  // A/P3: 池会话的 preset/sandbox 在组合时已固化; 请求级覆盖与其不一致时不复用, 落到下方创建不入池的专用会话
  if (existing
    && (requestPreset === undefined || existing.preset === requestPreset)
    && (requestSandbox === undefined || existing.sandbox === requestSandbox)) {
    // LRU: 命中则移到末尾(最近使用)
    liveAgents.delete(cwd)
    liveAgents.set(cwd, existing)
    // 自愈: 幂等补挂(已在花名册则 no-op; 首次挂名失败的池会话在此被捞回)
    await attachToWorkspace(ctx, await canonicalCwd(cwd), existing.sessionId)
    return existing
  }
  // LRU 淘汰: 超过上限时逐出最久未用的会话
  while (liveAgents.size >= runtimeConfig.maxAgents) {
    const oldestKey = liveAgents.keys().next().value as string | undefined
    if (oldestKey === undefined) break
    const old = liveAgents.get(oldestKey)
    liveAgents.delete(oldestKey)
    if (old) {
      sessionToCwd.delete(String(old.sessionId))
      try { (old.handle as { dispose?: () => void } | undefined)?.dispose?.() } catch { /* 忽略 */ }
    }
  }
  const newSessionId = SessionId(randomUUID())
  // cwd 先 realpath 规范化: session header 的 cwd 与 workspace.path 必须精确相等,
  // 否则 attachSession 强校验 reject(只会 create 注册而 UI 仍落未分组)
  const canonical = await canonicalCwd(cwd)
  const handle = await ctx.agents.create({
    sessionId: newSessionId,
    // 声明 preset: 为未来 Harness 版本消费 meta.agentPreset 做准备; 当前版本靠 setup 里手动 mount 兜底。
    meta: { cwd: canonical, agentPreset: effectivePreset },
    agentOptions: {
      provider: runtimeConfig.provider,
      // model 为空则省略, 让 dsh 跟随用户/默认设置; 显式配置则覆盖
      ...(runtimeConfig.model ? { model: runtimeConfig.model } : {}),
    },
    setup: async (agentCtx) => {
      // 关键: 通过 setup 挂载 preset(含 bash/fs/todo/web 等完整工具)。
      // dsh rc.6 的 agent-loop 有 bug: setup 收到的 agent ctx 丢失 scope tag,
      // 导致 mount 抛 'refusing to compose an unscoped context'。
      // 这里检测 scope, 无 scope 时跳过挂载(降级为无工具 agent), 避免 agent_run 整体崩溃。
      // master 及后续版本已修复, 会正常走 mount。
      if (scopeOf(agentCtx) === undefined) {
        console.warn('[harness-mcp-server] agent ctx unscoped (dsh rc.6 bug); preset mount skipped — upgrade dsh for full tool support')
        return
      }
      await ctx.agentPresets.mount(agentCtx, effectivePreset)
    },
  })
  // P3: 新会话组合完成后立即种 sandbox/mode 事件(dsh setSandboxMode 同款: session.append('sandbox/mode',{mode}));
  // 下一次受限调用生效, 重启靠 replay 保持。失败只告警不阻断(降级为部署默认档)。
  try {
    appendSandboxMode(handle.agent.session as unknown as PolicySessionLike, effectiveSandbox)
  } catch (e) {
    console.warn('[harness-mcp-server] sandbox mode seed failed on create:', String(e))
  }
  const rec = { sessionId: newSessionId, handle, preset: effectivePreset, sandbox: effectiveSandbox }
  // A/P3: 只有默认 preset + 默认档位的会话进 cwd 池; 任一请求级覆盖的专用会话不入池
  // (避免污染后续默认调用的复用键 —— 同 cwd 三档互不复用)
  if ((requestPreset === undefined || requestPreset === runtimeConfig.preset)
    && (requestSandbox === undefined || requestSandbox === runtimeConfig.defaultSandbox)) {
    liveAgents.set(cwd, rec)
    sessionToCwd.set(String(newSessionId), cwd)
  }

  // 分组: 把会话归属到 cwd 对应的工作区(resolveByPath ?? create + attachSession; 可选依赖; headless 环境自动跳过)
  void (async () => {
    try {
      const ws = await ensureWorkspace(ctx, canonical)
      if (ws?.attachSession) await ws.attachSession(newSessionId)
    } catch (e) {
      console.warn('[harness-mcp-server] workspace attach failed:', String(e))
    }
  })()

  // title 命名(可选): 创建会话后立即命名(走 sessionTitle 服务的 rename)
  if (title) {
    try {
      const session = handle.agent.session as { id?: unknown }
      const st = ctx.get('sessionTitle') as { rename?: (s: unknown, t: string) => unknown } | undefined
      st?.rename?.(session, title)
    } catch (e) {
      console.warn('[harness-mcp-server] session title set failed:', String(e))
    }
  }

  return rec
}

/** 同一 cwd 串行执行, 避免并发 followup 同一会话 */
async function withLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = agentLocks.get(cwd) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  agentLocks.set(cwd, next.catch(() => {}))
  return next
}

/** 结构化任务结果 */
interface TaskResult {
  taskId: string
  sessionId: string
  assistantText: string
  toolCalls: { name: string; args: string }[]
  toolResults: string[]
  changes: string
  verification: string
  leftovers: string
  /** P1: 本次执行的增量会话统计(scope:'run'; 全会话累计用 session_stats 工具) */
  stats?: Record<string, unknown>
  /** P3: 本次请求的权限三档(仅当显式传入时回显; 缺省 = 运行时 defaultSandbox) */
  sandbox?: string
}

/** 从 agent 最终回答里解析 changes/verification/leftovers(从后往前找候选, 更可靠) */
function parseSummary(assistantText: string): { changes: string; verification: string; leftovers: string } {
  const empty = { changes: '', verification: '', leftovers: '' }
  // 收集所有 {...} 候选(agent 被要求输出一行 summary JSON)
  const candidates: string[] = []
  const re = /\{[\s\S]*?\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(assistantText)) !== null) {
    candidates.push(m[0])
  }
  // 从后往前: 最后出现的候选最可能是最终 summary, 逐个尝试解析
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i] as string) as Record<string, unknown>
      const s = (v: unknown) => (typeof v === 'string' ? v : '')
      const changes = s(obj.changes) || s(obj.改动)
      const verification = s(obj.verification) || s(obj.验证)
      const leftovers = s(obj.leftovers) || s(obj.遗留) || s(obj.leftover)
      // 只要含任一 summary 字段就采纳, 否则继续尝试更早的候选
      if (changes || verification || leftovers) {
        return { changes, verification, leftovers }
      }
    } catch {
      // 非合法 JSON, 继续尝试下一个候选
    }
  }
  return empty
}

/**
 * [r3] B4: 从 agent 产出文本里抽取"看起来是文件绝对路径"的片段。
 * 优先取 / 开头的绝对路径(去掉行尾标点), 用于判断结果是否已带可点击的落点。
 */
function extractAbsPaths(text: string | undefined): string[] {
  if (!text) return []
  const out: string[] = []
  const re = /(?:^|[\s`'"(【\[])(\/[^\s`'"()【】\[\],;:]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const p = (m[1] ?? '').replace(/[.。;；,，]+$/, '')
    if (p.length > 1 && !out.includes(p)) out.push(p)
  }
  return out
}

/**
 * [r3] B4: agent_run 结果的"落点提示"。
 * 结果文本提到「已写入文件」但没有任何绝对路径时, 补一条 hint 指向沙箱 cwd(常见落点),
 * 避免 agent 拿着 changes 描述却不知道文件到底写在哪。
 */
function fileLandingHint(result: TaskResult, cwd: string): { hint: string; likelyDir: string; mentionedWrite: boolean; pathsInResult: string[] } | undefined {
  const blob = `${result.changes}\n${result.verification}\n${result.assistantText}`
  const mentionedWrite = /已写入|已创建|已保存|写入了|写入文件|保存到|created file|written to|saved to|wrote to/i.test(blob)
  const pathsInResult = extractAbsPaths(blob)
  if (!mentionedWrite) return undefined
  if (pathsInResult.length > 0) return undefined
  return {
    hint: `结果提到写入了文件但没有给出绝对路径; 文件通常落在本次沙箱工作目录 cwd=${cwd} 下, 用 fs_list(path="${cwd}") 或 fs_stat 定位具体文件`,
    likelyDir: cwd,
    mentionedWrite,
    pathsInResult,
  }
}

/** 分字段限长, 保证返回的永远是完整合法 JSON(避免 slice(-16000) 截断开头导致非法 JSON) */
function truncateResult(result: TaskResult): TaskResult {
  return {
    ...result,
    assistantText: result.assistantText.slice(0, 8000),
    toolCalls: result.toolCalls.slice(0, 50).map((c) => ({ ...c, args: c.args.slice(0, 2000) })),
    toolResults: result.toolResults.slice(0, 20).map((r) => r.slice(0, 2000)),
  }
}

/** 核心执行: 组装任务(注入记忆上下文+结构化要求) → agent 执行 → 读结构化结果。
 *  P2 opts: preset=请求级覆盖; onSessionStart=拿到 agent 会话后回调(B 登记 taskRunSessions);
 *  isCancelled=协作取消探测(B: 锁内/followup 前两个检查点)。
 *  P3 opts: sandbox=请求级权限三档覆盖(透传 getAgent; 仅影响新建/resume 组合)。 */
async function executeTask(
  ctx: Context,
  task: string,
  context: string,
  cwd: string,
  resumeSessionId?: string,
  title?: string,
  opts?: { preset?: string; sandbox?: SandboxMode; onSessionStart?: (sid: string) => void; isCancelled?: () => boolean },
): Promise<TaskResult> {
  // 规范化 cwd: realpath 解析符号链接与 .. 段, 避免 /a、/a/.、相对路径、符号链接成为不同 Map key
  // 导致重复创建会话/并发冲突; 同时也是与 workspace.path 精确比对的唯一 canon
  const workdir = await canonicalCwd(cwd ? resolve(cwd) : process.cwd())
  // cwd 白名单: 配置了 workspaceRoots 时, 只允许在列出的目录下干活(防路径穿越)
  if (runtimeConfig.workspaceRoots.length > 0) {
    const allowed = runtimeConfig.workspaceRoots.some((root) => {
      const r = resolve(root)
      return workdir === r || workdir.startsWith(r + '/')
    })
    if (!allowed) {
      throw new Error(`cwd not allowed (outside workspaceRoots): ${workdir}`)
    }
  }
  // sessionId 用 session 锁, 否则用 cwd 锁——都防同一 agent 会话被并发 followup
  const lockKey = resumeSessionId ? `session:${resumeSessionId}` : workdir
  return withLock(lockKey, async () => {
    // B 协作取消点 1: 还在等锁/未起 agent 时被取消 → 直接放弃执行
    if (opts?.isCancelled?.()) throw new Error('task cancelled before execution')
    const { sessionId, handle, disposeAfter } = await getAgent(ctx, workdir, resumeSessionId, title, opts?.preset, opts?.sandbox)
    opts?.onSessionStart?.(String(sessionId))
    lastAgentSessionId = String(sessionId) // 供 session_stats 无参调用返回"当前 Agent 会话"
    // B 协作取消点 2: 等锁期间被取消、刚拿到 agent → followup 前放弃(不发 LLM 请求)
    if (opts?.isCancelled?.()) throw new Error('task cancelled before execution')
    const baseline = ((handle.agent.session as unknown as { log?: unknown[] }).log ?? []).length

    // 组装完整任务文本: 记忆上下文 + 任务 + 结构化输出要求
    const fullTask = [
      context ? `【记忆/上下文(供参考, 来自 Hermes 大脑)】\n${context}\n` : '',
      `【任务】\n${task}\n`,
      `【完成后必须】用一行 JSON 总结(不要 markdown 代码块包裹, 直接输出这一行):`,
      `{"changes":"改了什么","verification":"怎么验证的","leftovers":"遗留问题"}`,
    ].filter(Boolean).join('\n')

    handle.agent.followup(
      // dsh 0.1.7: MessageSourceMap 只剩 user|model|tool|system-prompt 四种(注释明写
      // "there is no shared catch-all `plugin` kind"); 插件自带的 kind:'plugin' 会被判非法,
      // message 被静默丢弃 → agent 0 token 空跑(loop 的 kick() 里 catch(_error){} 吞掉异常)。
      // 官方调用点(dsh-headless / dsh-acp)全部用 source:{kind:'user'}。
      createUserMessage({ content: [{ type: 'text', text: fullTask }], source: { kind: 'user' } }),
    )
    await handle.agent.whenIdle()

    // 结构化读输出
    const result: TaskResult = {
      taskId: '', sessionId, assistantText: '', toolCalls: [], toolResults: [],
      changes: '', verification: '', leftovers: '',
    }
    try {
      const log = ((handle.agent.session as unknown as { log?: unknown[] }).log ?? []).slice(baseline)
      for (const e of log) {
        const ev = e as {
          type?: string
          message?: { content?: { type?: string; text?: string }[] }
          data?: unknown
        }
        if (ev.type === 'assistant/message') {
          const d = ev.data as { message?: { content?: { type?: string; text?: string }[] } } | undefined
          const content = d?.message?.content
          if (content) {
            // 只保留 text 块, 再过 stripReasoning 剥离内嵌 thinking/reasoning 文本
            const texts = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text as string)
            const cleaned = stripReasoning(texts.join('\n'))
            if (cleaned) result.assistantText += cleaned + '\n'
          }
        } else if (ev.type === 'tool/call') {
          const d = ev.data as { name?: string; arguments?: string; input?: unknown } | undefined
          result.toolCalls.push({
            name: d?.name ?? '?',
            args: (d?.arguments ?? JSON.stringify(d?.input ?? null) ?? '').slice(0, 2000),
          })
        } else if (ev.type === 'tool/result') {
          const texts: string[] = []
          collectText(ev.data ?? ev, texts)
          if (texts.length) result.toolResults.push(stripReasoning(texts.join('\n')).slice(0, 3000))
        }
      }
    } catch (e) {
      result.assistantText = `[读输出异常] ${String(e)}`
    }

    // 解析结构化 summary
    const summary = parseSummary(result.assistantText)
    result.changes = summary.changes
    result.verification = summary.verification
    result.leftovers = summary.leftovers
    // P3: 回显本次请求档位(仅显式传入时)
    if (opts?.sandbox !== undefined) result.sandbox = opts.sandbox

    // P1: 本次执行的增量会话统计(对 baseline 之后的日志段做 sessionStats 折叠)
    try {
      const runLog = ((handle.agent.session as unknown as { log?: unknown[] }).log ?? []).slice(baseline)
      result.stats = presentSessionStats(foldSessionStats(runLog), { scope: 'run', sessionId: String(sessionId) })
    } catch (e) {
      console.warn('[harness-mcp-server] stats fold failed:', (e as Error)?.message ?? e)
    }

    // resume 兜底分支: 尽力 flush 持久化, 再释放我们 resume 出来的句柄(不留给僵尸 live agent)
    if (disposeAfter) {
      try {
        await (ctx.get('sessions') as { flush?: (session: unknown) => Promise<unknown> } | undefined)?.flush?.(handle.agent.session)
      } catch {
        /* flush 失败不阻断结果返回 */
      }
      try {
        await handle.dispose()
      } catch {
        /* 释放失败不影响结果 */
      }
    }

    return result
  })
}

/** 异步任务队列(进程内存, 骨架阶段; 后续可持久化) */
const taskQueue = new Map<string, TaskItem>()

/** 异步任务队列条目 */
interface TaskItem {
  id: string
  task: string
  context: string
  cwd: string
  sessionId?: string
  title?: string
  /** A: 请求级 preset 覆盖(缺省用运行时默认) */
  preset?: string
  /** P3: 请求级权限三档覆盖(缺省用运行时 defaultSandbox) */
  sandbox?: SandboxMode
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  /** B: 已请求取消(running 中止 / 锁内协作取消), 收尾时置 status='cancelled' 并丢弃结果 */
  cancelled?: boolean
  result?: TaskResult
  error?: string
  createdAt: number
  finishedAt?: number
  /** [P0 回调] 任务级主动回调配置(仅当调用方传入且解析成功时存在; 不传 = undefined, 收尾路径与 v0.7.0 完全一致) */
  callback?: TaskCallbackConfig
  /** [P0 回调] 回调投递状态回显(task_result/task_list/status_get 用; 未配置回调恒 undefined) */
  notify?: CallbackNotifyState
}

/**
 * [P0 回调] 任务级主动回调配置(task_inbox 新增可选 callback 参数经 schema 校验后的运行时形态)。
 * 字段语义: url/method/headers/events/secret/replyContext/timeoutMs 与 REQ_CALLBACK_IMPL.md 逐一对应。
 */
interface TaskCallbackConfig {
  url: string
  method: 'POST' | 'PUT'
  headers?: Record<string, string>
  /** HMAC-SHA256 签名密钥(缺省回填部署级 defaultCallbackSecret; 两者皆空 = 不签名并在返回体提示) */
  secret?: string
  /**
   * 订阅的终态事件。缺省 ['done','error']; 'cancelled' 需显式订阅且不含 result。
   * [r1] 空数组 `[]` = **订阅全部**(对齐 Hermes 桥侧 events:[] 语义, 裁决 D6);
   * 判定见 dispatchTaskCallback: `events.length === 0 || events.includes(status)`。
   */
  events: Array<'done' | 'error' | 'cancelled'>
  /** 调用方自定义上下文(opaque, 原样放回 payload.replyContext; 用于发起方会话路由/唤醒) */
  replyContext?: unknown
  /** 单次投递超时毫秒(默认 5000, schema 限 [1000,30000]) */
  timeoutMs: number
}

/** [P0 回调] 投递状态(不可变快照; delivered/failed 均为终态, 状态回显与调度零耦合) */
interface CallbackNotifyState {
  /** delivered=2xx 已投递; failed=网络失败/超时/非2xx/SSRF 拒绝(仅告警, 不重试不抛错); skipped=未订阅该事件或全局关闭 */
  state: 'delivered' | 'failed' | 'skipped'
  /** 尝试次数(恒 1; P0 无重试) */
  attempts: number
  /** 投递完成时刻(epoch ms) */
  notifiedAt: number
  /** 失败原因(仅 failed 时存在; 不含 url path/query, 防泄漏) */
  lastError?: string
}

// ═══════════════════════ P0: 任务终态主动回调(v0.8.0) ═══════════════════════
//
// 设计报告: DESIGN_TASK_CALLBACK.md; 需求: REQ_CALLBACK_IMPL.md。
// 触发点 = task_inbox 内嵌 runner 收尾处(终态 done/error/cancelled 收敛后), void 异步发射,
// 绝不阻塞 taskQueue/主任务收尾; 投递失败仅 console.warn, 严禁抛错拖垮主进程。
// 安全: 仅 http/https; SSRF 私网/链路本地拦截(allowedCallbackHosts 显式放行内网端点);
//       secret → X-DSH-Signature: sha256=<hex(HMAC_SHA256(secret, ts.body))> 防伪造;
//       X-DSH-Timestamp(epoch ms, performance.timeOrigin+performance.now())供接收方做重放窗口判定。
// 兼容: 不传 callback 时 TaskItem 无 callback/notify 字段, runner 收尾路径与 v0.7.0 逐字节一致。

/** 回调 URL 端口显式白名单: 仅 http/https 的默认端口可省略; 其他端口必须显式写出(拒绝奇 scheme 借默认端口伪装) */
const CALLBACK_ALLOWED_SCHEMES = new Set(['http:', 'https:'])

/** 云 metadata / 链路本地地址: 无合法回调用途, standard 档恒拒(即使部署在云上也应走白名单显式放行) */
const CALLBACK_METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal'])

/** 私网/回环判定(CIDR 掩码按位比较; IPv6 只做常见形式前缀判断) */
const CALLBACK_PRIVATE_RANGES: { net: string; bits: number }[] = [
  { net: '10.0.0.0', bits: 8 },
  { net: '172.16.0.0', bits: 12 },
  { net: '192.168.0.0', bits: 16 },
  { net: '127.0.0.0', bits: 8 },
  { net: '169.254.0.0', bits: 16 },
  { net: '0.0.0.0', bits: 8 },
  { net: '100.64.0.0', bits: 10 },
  { net: 'fc00::', bits: 7 },
  { net: 'fe80::', bits: 10 },
]

/** IPv4 字符串 → 32 位整数(非法返回 null) */
function ipv4ToInt(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  let n = 0
  for (let i = 1; i <= 4; i++) {
    const oct = Number(m[i])
    if (!Number.isInteger(oct) || oct < 0 || oct > 255) return null
    n = n * 256 + oct
  }
  return n
}

/** 目标 IP 是否落在私网/回环/链路本地/CGNAT 段 */
function isPrivateIp(ip: string): boolean {
  const v4 = ipv4ToInt(ip)
  if (v4 !== null) {
    return CALLBACK_PRIVATE_RANGES.some(({ net, bits }) => {
      const base = ipv4ToInt(net)
      if (base === null) return false
      const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
      return ((v4 >>> 0) & mask) === ((base >>> 0) & mask)
    })
  }
  const low = ip.toLowerCase()
  return low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80')
}

/**
 * [P0 回调] SSRF 防护判定(P0 口径, 同步纯函数)。
 * 返回 undefined = 允许; 字符串 = 拒绝原因(不含原始 url, 防泄漏)。
 * 规则(REQ §3): 仅 http/https; 私网/回环/链路本地(含 169.254.169.254 云 metadata)默认拒绝;
 * allowedCallbackHosts(部署配置)显式放行(精确 'host' / 'host:port' / 通配 '*.suffix')。
 * P0 限制(已知): 域名解析后指向私网的 DNS rebinding 不在此拦截(DNS 解析在 http.request 内部,
 * 同步入口拿不到解析结果); 需要更强保证的部署请用 allowedCallbackHosts 白名单。
 */
function ssrfGuardCheck(rawUrl: string, allowedHosts: readonly string[]): string | undefined {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return 'callback.url is not a valid absolute URL'
  }
  if (!CALLBACK_ALLOWED_SCHEMES.has(u.protocol)) return `callback.url scheme "${u.protocol}" not allowed (http/https only)`
  const host = (u.hostname || '').toLowerCase()
  if (!host) return 'callback.url has no host'
  const port = u.port
  // 白名单命中 → 直接放行(部署方显式声明的内网端点)
  if (matchesCallbackAllowlist(host, port, allowedHosts)) return undefined
  if (CALLBACK_METADATA_HOSTS.has(host)) return `callback host "${host}" is a cloud metadata endpoint (denied; add to allowedCallbackHosts only if intentional)`
  const ip = ipv4ToInt(host) // 仅字面量 IP 可同步判定; 域名走 http.request 的系统解析(P0 已知限制)
  if (ip !== null && isPrivateIp(host)) {
    return `callback host "${host}" is a private/loopback address (denied; use allowedCallbackHosts to allow an internal gateway)`
  }
  // 0.0.0.0 / [::] 等未指定地址
  if (host === '0.0.0.0' || host === '[::]' || host === '::') return 'callback host "0.0.0.0" is not a routable callback target'
  return undefined
}

/** [P0 回调] 白名单匹配: 'host' / 'host:port' / '*.suffix'(大小写不敏感; *.suffix 匹配任意子域, 不含 suffix 本身) */
function matchesCallbackAllowlist(host: string, port: string, allowedHosts: readonly string[]): boolean {
  for (const raw of allowedHosts) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const entry = raw.trim().toLowerCase()
    const eHost = entry.includes(':') ? entry.slice(0, entry.indexOf(':')) : entry
    const ePort = entry.includes(':') ? entry.slice(entry.indexOf(':') + 1) : ''
    if (eHost.startsWith('*.')) {
      const suffix = eHost.slice(1) // ".suffix"
      if (host.endsWith(suffix) && host.length > suffix.length && (!ePort || ePort === port)) return true
      continue
    }
    if (eHost !== host) continue
    if (ePort && ePort !== port) continue
    return true
  }
  return false
}

/**
 * [P0 回调] 解析 task_inbox.callback → 运行时配置(入口一次性完成: schema 已过, 这里只做
 * SSRF 判定 + secret 缺省回填 + 保留头剔除 + replyContext 序列化体积上限)。
 * [r1] 增加部署级预设(callbackPreset)支持: 合并语义为"任务级 > 预设 > 内置默认"(PLAN_r1 §2.4),
 *      SSRF 守卫**置于合并之后**(预设不放宽任何安全策略, 裁决 D9)。
 * 成功返回 { config, signed, source }, 失败返回 { error }(文案走 errText 统一句式)。
 */
function resolveCallback(raw: unknown): { config?: TaskCallbackConfig; signed?: boolean; source?: CallbackSource; error?: string } {
  // [r1] 预设必须是"启用状态"才参与合并(autoApply === false 视为不存在)
  const preset = runtimeConfig.callbackPreset?.autoApply === false ? undefined : runtimeConfig.callbackPreset

  // [r1] 入口分支重写: 旧版是 `raw == null → {}`(直接不回调)。现在若部署配了预设 url,
  // "不传 callback" 也应当自动套用预设 —— 这正是本议题要的"配一次, 之后一行调用"。
  if (raw === undefined || raw === null) {
    if (preset?.url) return finishResolvedCallback(buildPresetOnlyConfig(preset), 'preset')
    return {}
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: errText('invalid parameter type', 'task_inbox.callback', 'expected object, got ' + (Array.isArray(raw) ? 'array' : typeof raw), 'callback 需为对象 {url, method?, headers?, events?, secret?, replyContext?, timeoutMs?}') }
  const rec = raw as Record<string, unknown>
  // [r1] 空对象 {} 同样视为"没传" → 套预设(调用方只想用预设但 schema 要求提供 callback 对象时)
  if (Object.keys(rec).length === 0 && preset?.url) {
    return finishResolvedCallback(buildPresetOnlyConfig(preset), 'preset')
  }

  // ── url: 任务级 > 预设 ──
  const taskUrl = typeof rec.url === 'string' ? rec.url.trim() : ''
  const url = taskUrl || (preset?.url ?? '')
  if (!url) {
    return {
      error: errText('missing required parameter', 'task_inbox.callback.url', 'expected string url (http/https), got nothing',
        '补上 callback.url 后重试; 或在部署配置里设 callbackPreset.url, 之后不传 callback 也能发回调'),
    }
  }
  // SSRF 判定: 用【合并后】的 url(预设的 url 同样要过守卫; 白名单仍是唯一放行手段)
  const ssrf = ssrfGuardCheck(url, runtimeConfig.allowedCallbackHosts)
  if (ssrf !== undefined) return { error: errText('callback.url rejected by ssrf guard', url.split('?')[0] ?? url, ssrf, '如目标确为内网可信端点, 在部署配置 allowedCallbackHosts 中显式放行') }

  const usedPresetUrl = !taskUrl
  // ── method: 任务级 > 预设 > POST ──
  const method: 'POST' | 'PUT' = rec.method === 'PUT' ? 'PUT' : rec.method === 'POST' ? 'POST' : (preset?.method ?? 'POST')
  // ── events: 任务级(含显式 []) > 预设 > ['done','error'] ──
  // [r1] 修复现状矛盾(裁决 D6): events === [] 合法 = 订阅全部(对齐 Hermes 桥侧 events:[] 语义)。
  // 旧实现把 [] 判成"无效列表"直接报错, 而文档/实际调用方都传 []。
  let events: Array<'done' | 'error' | 'cancelled'>
  if (Array.isArray(rec.events)) {
    // 显式传了(含 []): 过滤出合法项; 过滤后为空且原数组非空 → 说明全是非法值, 报错
    const filtered = (rec.events as unknown[]).filter((e): e is 'done' | 'error' | 'cancelled' => e === 'done' || e === 'error' || e === 'cancelled')
    if (filtered.length === 0 && rec.events.length > 0) {
      return { error: errText('invalid parameter value', 'task_inbox.callback.events', 'no valid event in list (valid: done|error|cancelled)', '从 ["done","error","cancelled"] 里挑选要订阅的终态事件, 或传 [] 订阅全部') }
    }
    events = filtered // [] 合法: 表示订阅全部
  } else if (preset?.events !== undefined) {
    events = [...preset.events]
  } else {
    events = ['done', 'error']
  }
  // ── headers: 浅合并(一层 key 覆盖), 任务级优先; 合并后再整体剔除保留头 ──
  const headers = mergeCallbackHeaders(preset?.headers, sanitizeCallbackHeaders(rec.headers))
  if (rec.headers !== undefined && rec.headers !== null && (typeof rec.headers !== 'object' || Array.isArray(rec.headers))) {
    return { error: errText('invalid parameter type', 'task_inbox.callback.headers', 'expected object, got ' + (Array.isArray(rec.headers) ? 'array' : typeof rec.headers), 'headers 需为 { "头名": "值" } 的平面对象') }
  }
  // secret: 任务级优先, 缺省回填部署级 defaultCallbackSecret(预设不参与 —— 裁决 D7: 唯一权威来源)
  const secret = typeof rec.secret === 'string' && rec.secret.length > 0 ? rec.secret : (runtimeConfig.defaultCallbackSecret || undefined)
  // replyContext: 预设与任务级**深合并一层**, 任务级优先
  let replyContext: unknown
  const merged = mergeReplyContext(preset?.replyContext, rec.replyContext)
  if (merged !== undefined) {
    // [r1] 防"把 Hermes 模板串直接塞进来"这类误用(取不到值时 Hermes 会原样当 chat_id → 静默误投)
    const literalTemplate = findLiteralTemplateValue(merged)
    if (literalTemplate !== undefined) {
      return { error: errText('invalid parameter value', 'task_inbox.callback.replyContext', `field "${literalTemplate}" is a literal template placeholder`, '这里要填真实值, 不是 {replyContext.xxx} 模板串; 模板只在 Hermes 订阅配置里写') }
    }
    try {
      const s = JSON.stringify(merged)
      if (s !== undefined && s.length > 4096) return { error: errText('invalid parameter value', 'task_inbox.callback.replyContext', `serialized size ${s.length} > 4096`, '精简 replyContext 内容后重试(会话路由只需 id 类字段, 无需整段上下文)') }
    } catch {
      return { error: errText('invalid parameter value', 'task_inbox.callback.replyContext', 'not JSON-serializable (circular?)', 'replyContext 必须可 JSON 序列化(去掉循环引用后重试)') }
    }
    replyContext = merged
  }
  // [r1] 路由字段守卫(默认关闭, 需部署显式 requireReplyRoute:true)
  if (preset?.requireReplyRoute === true && !hasReplyRouteField(replyContext)) {
    return { error: errText('invalid parameter value', 'task_inbox.callback.replyContext', 'no chat routing field (expected *ChatId/chatId)', '本次回调无法路由到目标会话(Hermes 侧按 replyContext.replyChatId 路由); 在 callback.replyContext 里补上 replyChatId') }
  }
  let timeoutMs = preset?.timeoutMs ?? 5000
  if (rec.timeoutMs !== undefined && rec.timeoutMs !== null) {
    const t = Number(rec.timeoutMs)
    if (!Number.isInteger(t) || t < 1000 || t > 30000) return { error: errText('invalid parameter value', 'task_inbox.callback.timeoutMs', `expected int in [1000,30000], got ${String(rec.timeoutMs)}`, 'timeoutMs 取 1000~30000 之间的整数毫秒') }
    timeoutMs = t
  }
  const source: CallbackSource = preset?.url !== undefined ? (usedPresetUrl ? 'preset' : 'preset+task') : 'task'
  return { config: { url, method, headers, secret, events, replyContext, timeoutMs }, signed: secret !== undefined, source }
}

/** [r1] 回调配置的实际来源(用于 task_inbox 返回体自解释) */
export type CallbackSource = 'preset' | 'preset+task' | 'task'

/** [r1] 只用预设构造配置(调用方完全没传 callback 的路径) */
function buildPresetOnlyConfig(preset: CallbackPresetConfig): TaskCallbackConfig | undefined {
  const url = preset.url
  if (!url) return undefined
  const secret = runtimeConfig.defaultCallbackSecret || undefined
  return {
    url,
    method: preset.method ?? 'POST',
    headers: sanitizeCallbackHeaders(preset.headers),
    secret,
    events: preset.events !== undefined ? [...preset.events] : ['done', 'error'],
    replyContext: preset.replyContext,
    timeoutMs: preset.timeoutMs ?? 5000,
  }
}

/** [r1] 预设路径的统一收尾(SSRF 守卫 + 体积校验与任务级路径同款, 预设不放宽任何策略) */
function finishResolvedCallback(config: TaskCallbackConfig | undefined, source: CallbackSource): { config?: TaskCallbackConfig; signed?: boolean; source?: CallbackSource; error?: string } {
  if (!config) return {}
  const ssrf = ssrfGuardCheck(config.url, runtimeConfig.allowedCallbackHosts)
  if (ssrf !== undefined) return { error: errText('callback.url rejected by ssrf guard', config.url.split('?')[0] ?? config.url, ssrf, '如目标确为内网可信端点, 在部署配置 allowedCallbackHosts 中显式放行') }
  if (config.replyContext !== undefined) {
    const literalTemplate = findLiteralTemplateValue(config.replyContext)
    if (literalTemplate !== undefined) {
      return { error: errText('invalid parameter value', 'callbackPreset.replyContext', `field "${literalTemplate}" is a literal template placeholder`, '部署预设的 replyContext 要填真实值; {replyContext.xxx} 模板串只写在 Hermes 订阅配置里') }
    }
    try {
      const s = JSON.stringify(config.replyContext)
      if (s !== undefined && s.length > 4096) return { error: errText('invalid parameter value', 'callbackPreset.replyContext', `serialized size ${s.length} > 4096`, '精简部署预设的 replyContext 内容(会话路由只需 id 类字段)') }
    } catch {
      return { error: errText('invalid parameter value', 'callbackPreset.replyContext', 'not JSON-serializable (circular?)', '部署预设的 replyContext 必须可 JSON 序列化') }
    }
  }
  if (runtimeConfig.callbackPreset?.requireReplyRoute === true && !hasReplyRouteField(config.replyContext)) {
    return { error: errText('invalid parameter value', 'callbackPreset.replyContext', 'no chat routing field (expected *ChatId/chatId)', '本次回调无法路由到目标会话; 在 callbackPreset.replyContext 里配静态 chat id, 或每次调用时传 callback.replyContext.replyChatId') }
  }
  return { config, signed: config.secret !== undefined, source }
}

/** [r1] headers 净化: 仅接受 string→string 平面映射, 剔除保留头(host/content-length/connection/transfer-encoding) */
function sanitizeCallbackHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') continue
    const name = k.trim()
    if (!name) continue
    if (CALLBACK_RESERVED_HEADERS.includes(name.toLowerCase())) continue // 保留头剔除
    out[name] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** [r1] headers 浅合并: 任务级同名覆盖预设; 任一侧缺失就取另一侧(合并后再净化一次, 防预设里夹带保留头) */
function mergeCallbackHeaders(
  base: Record<string, string> | undefined,
  override: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (base === undefined && override === undefined) return undefined
  const merged: Record<string, string> = { ...(base ?? {}), ...(override ?? {}) }
  return sanitizeCallbackHeaders(merged)
}

/** [r1] replyContext 深合并(一层): 两侧都是平面对象才逐键合并(任务级优先), 否则任务级整体覆盖 */
function mergeReplyContext(base: unknown, override: unknown): unknown {
  if (override === undefined) return base
  if (base === undefined) return override
  const isPlain = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!isPlain(base) || !isPlain(override)) return override
  return { ...base, ...override }
}

/** [r1] 检测形如 "{replyContext.xxx}" 的字面量模板串(Hermes 模板取不到值时会原样当值用 → 静默误投) */
function findLiteralTemplateValue(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && /^\{[\w.]+\}$/.test(v.trim())) return k
  }
  return undefined
}

/** [r1] replyContext 里是否存在聊天路由字段(键名含 chatid, 大小写与分隔符不敏感; Hermes 用 replyChatId) */
function hasReplyRouteField(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // 归一化: chat_id / chat-id / chatId / replyChatId / REPLY_CHAT_ID 都算
    if (!k.toLowerCase().replace(/[_-]/g, '').includes('chatid')) continue
    if (typeof v === 'string' && v.trim() !== '') return true
    if (typeof v === 'number' && Number.isFinite(v)) return true
  }
  return false
}

/**
 * [P0 回调] 组装标准回调 Envelope 载荷(REQ §2 字段逐一对应)。
 * result 仅 done 且存在时携带(经 truncateResult 裁剪); cancelled 不携带 result/error(收尾时已删);
 * replyContext opaque 原样回传。
 */
function buildCallbackPayload(item: TaskItem): Record<string, unknown> {
  return {
    event: `task:${item.status}`,
    taskId: item.id,
    sessionId: item.sessionId,
    title: item.title,
    status: item.status,
    createdAt: item.createdAt,
    finishedAt: item.finishedAt,
    durationMs: (item.finishedAt ?? Date.now()) - item.createdAt,
    replyContext: item.callback?.replyContext,
    // done 的结果经 truncateResult 裁剪(assistantText 8000/toolCalls 50×2000/toolResults 20×2000), 防 payload 超大
    result: item.status === 'done' && item.result ? truncateResult(item.result) : undefined,
    error: item.status === 'error' ? item.error : undefined,
  }
}

/**
 * [P0 回调] HMAC-SHA256 签名(secret 存在时)。
 * 签名材料 = `${timestamp}.${rawBody}`; 时间戳入签 → 接收方校验 X-DSH-Timestamp 窗口即可防重放。
 */
function signCallbackPayload(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
}

/** [P0 回调] 恒时字符串比较(验签用; 长度不等时直接 false, 不比较) */
function safeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
  } catch {
    return false
  }
}

/**
 * [P0 回调] 投递一次回调(http → https): REQ §2 的 sendCallback。
 * - 2xx 即成功(响应体丢弃式消费, 不解析内容, 防恶意端点借响应注入);
 * - 超时/网络失败/非 2xx → { delivered:false, error } —— **绝不抛错**;
 * - 超时实现: req.setTimeout(timeoutMs) + destroy(整体超时, 含连接与响应窗口)。
 */
function sendCallback(url: string, method: 'POST' | 'PUT', headers: Record<string, string> | undefined, body: string, timeoutMs: number): Promise<{ delivered: boolean; status?: number; error?: string }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (r: { delivered: boolean; status?: number; error?: string }) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    let u: URL
    try {
      u = new URL(url)
    } catch (e) {
      finish({ delivered: false, error: `invalid url: ${(e as Error)?.message ?? 'parse failed'}` })
      return
    }
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body).toString(),
        ...CALLBACK_BASE_HEADERS,
        ...(headers ?? {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      res.resume() // ACK 语义只看状态码; body 丢弃不解析
      const code = res.statusCode ?? 0
      const ok = code >= 200 && code < 300
      finish(ok ? { delivered: true, status: code } : { delivered: false, status: code, error: `non-2xx status ${code}` })
    })
    req.on('timeout', () => {
      req.destroy(new Error(`callback timeout after ${timeoutMs}ms`))
    })
    req.on('error', (e) => {
      finish({ delivered: false, error: (e as Error)?.message ?? 'request failed' })
    })
    req.end(body, 'utf8')
  })
}

/** 回调投递的固定附加头(集中定义防散落) */
const CALLBACK_BASE_HEADERS = { 'user-agent': 'hermes-dsh-bridge-task-callback' }

/** [r1] 回调自定义头里的保留头(由运行时固定, 一律剔除; 部署预设与任务级都适用) */
const CALLBACK_RESERVED_HEADERS = ['host', 'content-length', 'connection', 'transfer-encoding']

/** [P0 回调] 提取回调 URL 的 host(:port)(日志/回显脱敏用, 不含 path/query) */
function hostOfCallbackUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.host
  } catch {
    return '(invalid-url)'
  }
}

/**
 * [P0 回调] 任务终态回调发射器(runner 收尾处调用; 语义 = REQ §2 的 void sendCallback 非阻塞发射)。
 * - 未配置/未订阅该终态/全局开关关闭 → item.notify = skipped(或不动);
 * - 组装 Envelope(REQ §2 字段逐一对应) → 签名(secret 存在时) → sendCallback;
 * - 结果写回 item.notify(delivered/failed + lastError); **全程 try/catch, 严禁抛错拖垮主进程**。
 */
function dispatchTaskCallback(item: TaskItem): void {
  const cb = item.callback
  if (!cb) return // 不传 callback 的任务: 收尾路径零改动
  if (runtimeConfig.notifyEnabled === false) {
    item.notify = { state: 'skipped', attempts: 0, notifiedAt: Date.now() }
    return
  }
  // [r1] 事件订阅判定(D6): events === [] 表示"订阅全部"(对齐 Hermes 桥侧 events:[] 语义)
  if (!(cb.events.length === 0 || cb.events.includes(item.status as 'done' | 'error' | 'cancelled'))) {
    item.notify = { state: 'skipped', attempts: 0, notifiedAt: Date.now() }
    return
  }
  let body: string
  try {
    body = JSON.stringify(buildCallbackPayload(item))
  } catch (e) {
    item.notify = { state: 'failed', attempts: 1, notifiedAt: Date.now(), lastError: `payload serialize failed: ${(e as Error)?.message ?? '?'}` }
    return
  }
  const ts = Math.floor(performance.timeOrigin + performance.now())
  const signature = cb.secret !== undefined ? signCallbackPayload(cb.secret, ts, body) : undefined
  // 非阻塞发射(detached async; 网络行为绝不阻塞 runner 与 taskQueue)
  void (async () => {
    let outcome: { delivered: boolean; status?: number; error?: string }
    try {
      outcome = await sendCallback(cb.url, cb.method, { ...(cb.headers ?? {}), ...(signature !== undefined ? { 'x-dsh-signature': `sha256=${signature}`, 'x-dsh-timestamp': String(ts) } : {}) }, body, cb.timeoutMs)
    } catch (e) {
      outcome = { delivered: false, error: (e as Error)?.message ?? 'callback dispatch threw' }
    }
    item.notify = outcome.delivered
      ? { state: 'delivered', attempts: 1, notifiedAt: Date.now() }
      : { state: 'failed', attempts: 1, notifiedAt: Date.now(), ...(outcome.error !== undefined ? { lastError: outcome.error.slice(0, 200) } : {}) }
    if (outcome.delivered) {
      console.log(`[harness-mcp-server] task callback delivered (taskId=${item.id}, event=task:${item.status}, urlHost=${hostOfCallbackUrl(cb.url)})`)
    } else {
      console.warn(`[harness-mcp-server] task callback failed (taskId=${item.id}, event=task:${item.status}): ${outcome.error ?? `status ${outcome.status}`}`)
    }
  })()
}
/** B: 执行中任务 → agent 会话 id(task_cancel 用它定位要中止的 Agent; executeTask onSessionStart 登记) */
const taskRunSessions = new Map<string, string>()

/** 找会话 header: live 优先, 其次持久化 list(轻量元数据扫描, 不加载整日志; [r2] 兼容 0.1.5 snapshot) */
async function findSessionHeader(ctx: Context, sessionId: SessionId): Promise<SessionHeader | undefined> {
  const sessions = ctx.get('sessions') as { get?: (id: SessionId) => { header: SessionHeader } | undefined } | undefined
  const live = sessions?.get?.(sessionId)
  if (live !== undefined) return live.header
  const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
  let listed: readonly unknown[] | undefined
  try {
    listed = await persistence?.list?.()
  } catch { return undefined }
  for (const entry of listed ?? []) {
    // [r2] 逐行容错 + snapshot 解包: 单条畸形不影响后续条目
    const row = unwrapPersistedEntry(entry)
    if (row !== undefined && String(row.header.id) === String(sessionId)) return row.header
  }
  return undefined
}

// ── [r2] dsh 0.1.5 会话存储适配层 ──
//
// 0.1.2 → 0.1.5 变更(sessionPersistence 服务):
//   1) `list()` 返回的是 SessionPersistenceSnapshot[] ({header, revision, sizeBytes?}), 不再是裸 SessionHeader[]。
//      旧代码直接 `h.id`/`h.cwd` → undefined, 再被 SessionId(undefined) 喂进 inspect/locate, 触发
//      `Cannot read properties of undefined (reading 'length')`, 无参 session_list 整体炸掉。
//   2) `inspect(id)` 已从服务契约移除(改为 `open(id,'read')` + `handle.read()`); 旧代码 `persistence.inspect?.()`
//      恒为 undefined → 回退 live store, 于是冷会话(session_list/session_log/session_search)全部查不到内容。
//   3) `locate(meta)` 仍在, 且 0.1.5 会自己解析 v3 目录名(session.v3.jsonl.zstd + 无 session- 前缀目录), 适配后即可复用。
//   4) `stat(id)` 是 0.1.5 新增的轻量元数据入口(含 sizeBytes), 用于 updatedAt 的 mtime 语义替代。
//
// 适配策略: 全部读写走下面的 helper, 同时兼容 0.1.2(裸 header + inspect)与 0.1.5(snapshot + open/read),
// 单一会话的行级失败一律不外抛(由调用方决定跳过还是回退)。

/** 持久化 list() 的原始元素: 0.1.5 snapshot 或 0.1.2 裸 header(两者靠 `.header` 是否存在区分) */
type PersistedListEntry = unknown

/**
 * [r2] 把持久化 list() 的元素归一成 { header, sizeBytes? }。
 * 0.1.5: { header, revision, sizeBytes? }; 0.1.2: header 本身。无法识别的元素返回 undefined(调用方计入 skipped)。
 */
function unwrapPersistedEntry(entry: PersistedListEntry): { header: SessionHeader; sizeBytes?: number } | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const rec = entry as { header?: unknown; sizeBytes?: unknown; id?: unknown }
  // 0.1.5 snapshot 形态: 内层 header 必须自带 id
  if (rec.header && typeof rec.header === 'object' && (rec.header as { id?: unknown }).id !== undefined) {
    return {
      header: rec.header as SessionHeader,
      ...(typeof rec.sizeBytes === 'number' ? { sizeBytes: rec.sizeBytes } : {}),
    }
  }
  // 0.1.2 裸 header 形态
  if (rec.id !== undefined) return { header: entry as SessionHeader }
  return undefined
}

/** [r2] 事件数组安全取值: 0.1.5/0.1.2 的 inspect/read 结果里 events 缺失或非数组时返回 undefined(不抛) */
function asEvents(v: unknown): unknown[] | undefined {
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object' && Array.isArray((v as { events?: unknown }).events)) {
    return (v as { events: unknown[] }).events
  }
  return undefined
}

/**
 * [r2] 读一个持久化会话: 0.1.2 inspect(meta+events) → 0.1.5 open('read')+handle.read(0,∞)。
 * handle 无论成败都会 close(释放读句柄)。都不可得返回 undefined。
 */
async function persistedInspect(
  ctx: Context,
  sid: SessionId,
): Promise<{ meta: SessionHeader; events: unknown[] } | undefined> {
  const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
  if (persistence?.inspect) {
    try {
      const insp = await persistence.inspect(sid)
      const events = asEvents(insp?.events)
      if (insp?.meta && events) return { meta: insp.meta, events }
    } catch { /* 0.1.5 无 inspect 或有 inspect 但读取失败 → 走 open/read */ }
  }
  if (persistence?.open) {
    let handle: PersistenceHandleView | undefined
    try {
      handle = await persistence.open(sid, 'read')
      const header = handle?.header as SessionHeader | undefined
      if (!header?.id) return undefined
      const read = await handle?.read?.(0)
      const events = asEvents(read)
      if (!events) return undefined
      return { meta: header, events }
    } catch {
      return undefined
    } finally {
      try { await handle?.close?.() } catch { /* 释放失败不阻断 */ }
    }
  }
  return undefined
}

/**
 * [r2] live + 持久化 header 合并(live 优先), 按 id 去重(session_list / 存量捞回 / session_search 共用)。
 * 逐行容错: 单个持久化条目失败只计入 skipped, 绝不让整表炸掉。
 */
async function listMergedHeaders(ctx: Context): Promise<{ headers: Map<string, SessionHeader>; skipped: number }> {
  const headers = new Map<string, SessionHeader>()
  const store = ctx.get('sessions') as SessionsStoreView | undefined
  try {
    for (const s of store?.list?.() ?? []) {
      try {
        if (s?.header?.id !== undefined) headers.set(String(s.header.id), s.header)
      } catch { /* 单个 live 条目异常 → 跳过 */ }
    }
  } catch { /* live store 不可用 → 只用持久化 */ }
  let skipped = 0
  const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
  let listed: readonly PersistedListEntry[] | undefined
  try {
    listed = await persistence?.list?.()
  } catch { /* 列表整体失败 → 只有 live 部分 */ }
  for (const entry of listed ?? []) {
    const row = unwrapPersistedEntry(entry)
    if (row === undefined || row.header.id === undefined) { skipped++; continue }
    if (!headers.has(String(row.header.id))) headers.set(String(row.header.id), row.header)
  }
  return { headers, skipped }
}

// ═══════════════════════ [r1] 会话列表快路径: listCorpus + batchUpdatedAt ═══════════════════════
//
// 背景(PLAN_r1 §1.2–§1.5, 主控实测): 旧路径 session_list 会逐条 roughUpdatedAt → persistedRowMeta
// → persistence.stat(id), 而宿主 jsonl 后端的 stat() 是 **O(项目目录数)** 的(内部 findLog 遍历
// 所有 project dir): 本机 30 个目录 × 197 个会话 = 9.3s, 仅 limit=1 就要 10.18s。
// 且 locate() 恒用当前格式版本(4)拼文件名, 忽略会话实际落盘 generation, 本机 198 个会话里
// 186 个(94%)返回的路径根本不存在。
// 修法: ① 整批拿 header(0.1.7 走官方 sessionQuery.listSessions(), 否则 persistence.list());
//       ② mtime 整批拿, 逐条 stat() 一律不调; ③ 任何失败都不能让整表崩, 兜底 header.createdAt。

/** [r1] 官方 sessionQuery 的最小结构视图(运行时探测, 不做版本号硬判断 → 保 0.1.2/0.1.5 兼容) */
interface SessionQueryView {
  /** 官方 live 优先全量列表(只读 header, 不读事件流); 不存在时插件回退 persistence 路径 */
  listSessions?: (signal?: AbortSignal) => Promise<readonly unknown[]>
  /** 官方索引搜索(openAt:'never' 或索引未就绪时会抛错, 调用方必须静默回退) */
  searchSessions?: (request: unknown, exec?: unknown) => Promise<unknown>
}

/** [r1] 取 ctx.sessionQuery(探测式; 未挂载返回 undefined —— 0.1.2/0.1.5 无此服务) */
function sessionQueryOf(ctx: Context): SessionQueryView | undefined {
  try {
    const q = ctx.get('sessionQuery') as SessionQueryView | undefined
    return q && typeof q === 'object' ? q : undefined
  } catch {
    return undefined
  }
}

/** [r1] 一条会话语料行: header + 免费排序键(sizeBytes 来自 list(), mtime 来自批量探测) */
interface CorpusRow {
  header: SessionHeader
  /** 该 id 当前是否存在于 ctx.sessions(live) */
  live: boolean
  /** 排序键: live 末事件 time > 盘上 mtime > header.createdAt */
  updatedAt: number
  /** 物理落盘字节数(list() 免费提供; 拿不到则缺省) */
  sizeBytes?: number
}

/** [r1] 项目目录名编码: header.cwd → 物理目录名。
 *  实测本机布局为 `--<cwd 去前导 / 且 / → ->--`, 且 '@' 会被编码成 '~0040'
 *  (例: /root/.dsh/profiles/web/node_modules/@chushixixin/dsh-harness-mcp-server
 *   → --root-.dsh-profiles-web-node_modules-~0040chushixixin-dsh-harness-mcp-server--)。
 *  这是宿主私有布局的 best-effort 推导: 推错只会让该行退回 createdAt, 不影响正确性。 */
function projectDirNameOf(cwd: string): string | undefined {
  try {
    const trimmed = cwd.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!trimmed) return undefined
    return '--' + trimmed.replace(/\//g, '-').replace(/@/g, '~0040') + '--'
  } catch {
    return undefined
  }
}

/** [r1] 会话目录内取 `session.v*.jsonl.*` 最新 mtime(单目录一次 readdir + stat; 失败返回 undefined) */
async function newestSessionFileMtime(sessionDir: string): Promise<number | undefined> {
  let names: string[]
  try {
    names = await readdir(sessionDir)
  } catch {
    return undefined
  }
  let newest: number | undefined
  for (const name of names) {
    if (!/^session\.v\d+\.jsonl(\..+)?$/.test(name)) continue
    try {
      const st = await stat(joinPath(sessionDir, name))
      if (st.isFile() && (newest === undefined || st.mtimeMs > newest)) newest = st.mtimeMs
    } catch { /* 单个文件失败跳过 */ }
  }
  return newest
}

/**
 * [r1] A2: 整批取"盘上真实 mtime"(绝不调用 persistence.stat() —— 那是 O(树) 的, 实测 47~60ms/次)。
 * 三级策略, 全部失败不影响正确性:
 *   ① locate(header) 命中就用(便宜, 但本机 94% 因上游 locate() bug 拿不到, 只能当优化);
 *   ② 未命中的用 header.cwd 推导项目目录名 + readdir 该会话目录, 取 session.v*.jsonl.* 最新 mtime;
 *   ③ 仍失败 → 不返回该 id(调用方回退 header.createdAt, 如实体现不伪造)。
 * @param headers 需要 mtime 的 header 列表(冷会话)
 * @returns sessionId(str) → mtimeMs
 */
async function batchUpdatedAt(
  ctx: Context,
  headers: readonly SessionHeader[],
  sessionsRoot: string | undefined,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
  for (const header of headers) {
    const id = String(header.id)
    if (out.has(id)) continue
    // ① locate() 命中(路径真实存在才算命中 —— locate 本身不做存在性检查)
    try {
      const path = persistence?.locate?.(header)?.path
      if (path) {
        const st = await stat(path)
        if (st.isFile()) { out.set(id, st.mtimeMs); continue }
      }
    } catch { /* → ② */ }
    // ② cwd 推导项目目录 + readdir 会话目录
    if (sessionsRoot && header.cwd) {
      try {
        const dirName = projectDirNameOf(header.cwd)
        if (dirName) {
          const m = await newestSessionFileMtime(joinPath(sessionsRoot, dirName, id))
          if (m !== undefined) { out.set(id, m); continue }
        }
      } catch { /* → ③ */ }
    }
    // ③ 不回填 → 调用方用 createdAt
  }
  return out
}

/**
 * [r1] A1: 一次拿到全量会话的 header 与排序键(替代 listMergedHeaders + N×roughUpdatedAt)。
 * 数据源优先级:
 *   ① ctx.sessionQuery.listSessions()(0.1.7 官方, live 优先 + newest-first, 只读 header; 实测 646ms/198 会话);
 *   ② 回退 persistence.list() + live store 手工合并(0.1.2/0.1.5/0.1.7 服务缺失时同样快)。
 * 排序键优先级: live 末事件 time(纯内存) > 批量 mtime > header.createdAt。
 * @returns rows(未排序) / skipped(畸形条目) / skippedNoCwd(cwd 缺失) / source(实际数据源)
 */
async function listCorpus(ctx: Context): Promise<{
  rows: CorpusRow[]
  skipped: number
  skippedNoCwd: number
  source: 'sessionQuery' | 'persistence' | 'live-only'
}> {
  const rows: CorpusRow[] = []
  const byId = new Map<string, CorpusRow>()
  let skipped = 0
  let skippedNoCwd = 0
  let source: 'sessionQuery' | 'persistence' | 'live-only' = 'live-only'

  // live 集合: 用于 ① 标记 live 标志 ② 取内存末事件时间(零 IO, 与旧 roughUpdatedAt 前半段同款)
  const liveEndTime = new Map<string, number>()
  const store = ctx.get('sessions') as SessionsStoreView | undefined
  try {
    for (const s of store?.list?.() ?? []) {
      try {
        const id = s?.header?.id
        if (id === undefined) continue
        liveEndTime.set(String(id), 0) // 占位: 下面若有 log 再覆盖
      } catch { /* 单个 live 条目异常 → 跳过 */ }
    }
  } catch { /* live store 不可用 → 只用持久化 */ }

  // ── 数据源 ①: 官方 sessionQuery.listSessions() ──
  let usedSessionQuery = false
  const query = sessionQueryOf(ctx)
  if (query?.listSessions) {
    try {
      const records = await query.listSessions()
      for (const raw of records ?? []) {
        const rec = raw as { header?: SessionHeader; live?: unknown } | undefined
        const header = rec?.header
        if (!header || header.id === undefined) { skipped++; continue }
        const row: CorpusRow = {
          header,
          live: rec?.live === true,
          updatedAt: header.createdAt ?? 0,
        }
        byId.set(String(header.id), row)
        rows.push(row)
      }
      usedSessionQuery = true
      source = 'sessionQuery'
    } catch { /* 服务异常 → 回退 ② (不留半截数据) */
      rows.length = 0
      byId.clear()
      skipped = 0
    }
  }

  // ── 数据源 ②: persistence.list() + live store 手工合并(live 优先, 按 id 去重) ──
  if (!usedSessionQuery) {
    for (const id of liveEndTime.keys()) {
      const sess = store?.get?.(SessionId(id)) as { header?: SessionHeader } | undefined
      const header = sess?.header
      if (!header || header.id === undefined) continue
      if (byId.has(id)) continue
      const row: CorpusRow = { header, live: true, updatedAt: header.createdAt ?? 0 }
      byId.set(id, row)
      rows.push(row)
    }
    const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
    let listed: readonly PersistedListEntry[] | undefined
    try {
      listed = await persistence?.list?.()
    } catch { /* 列表整体失败 → 只有 live 部分 */ }
    for (const entry of listed ?? []) {
      const row = unwrapPersistedEntry(entry)
      if (row === undefined || row.header.id === undefined) { skipped++; continue }
      const id = String(row.header.id)
      if (byId.has(id)) {
        // live 优先: 已存在则只补 sizeBytes(持久化侧的物理大小)
        const existing = byId.get(id)
        if (existing && existing.sizeBytes === undefined && row.sizeBytes !== undefined) existing.sizeBytes = row.sizeBytes
        continue
      }
      const item: CorpusRow = {
        header: row.header,
        live: false,
        updatedAt: row.header.createdAt ?? 0,
        ...(row.sizeBytes !== undefined ? { sizeBytes: row.sizeBytes } : {}),
      }
      byId.set(id, item)
      rows.push(item)
    }
    // [r1] 数据源标记必须在填充之后判定: 只要持久化列表真的贡献了行才算 'persistence',
    // 否则是 'live-only'(live store 有会话但持久化列表为空/失败)。
    source = rows.some((r) => r.live === false) ? 'persistence' : 'live-only'
  }

  // ── 排序键 stage 1: live 内存末事件时间(零 IO) ──
  for (const row of rows) {
    if (!row.live) continue
    try {
      const sess = store?.get?.(SessionId(String(row.header.id))) as { log?: { time?: number }[] } | undefined
      const log = sess?.log
      if (log && log.length > 0) {
        const t = Number(log[log.length - 1]?.time)
        if (Number.isFinite(t) && t > 0) row.updatedAt = t
      }
    } catch { /* 单行失败 → 保留 createdAt */ }
  }

  // ── 排序键 stage 2: 冷会话批量 mtime(整批一次, 绝不逐条 stat()) ──
  const cold = rows.filter((r) => !r.live)
  if (cold.length > 0) {
    const sessionsRoot = process.env.DSH_SESSIONS_DIR || joinPath(homedir(), '.dsh', 'sessions')
    let mtimes: Map<string, number>
    try {
      mtimes = await batchUpdatedAt(ctx, cold.map((r) => r.header), sessionsRoot)
    } catch {
      mtimes = new Map() // 整批失败 → 全部回退 createdAt
    }
    for (const row of cold) {
      const m = mtimes.get(String(row.header.id))
      if (m !== undefined && Number.isFinite(m) && m > 0) row.updatedAt = m
    }
  }

  // ── cwd 缺失计数(D2: 旧实现静默跳过, 会让"过滤后为空"被误诊) ──
  for (const row of rows) if (row.header.cwd === undefined) skippedNoCwd++

  return { rows, skipped, skippedNoCwd, source }
}

/**
 * [r2] 持久化侧的轻量元数据(updatedAt 用): 0.1.5 优先 stat(id)(含 sizeBytes/mtime 语义),
 * 退回 locate(header) + stat(path) 落盘 mtime; 都不可得返回 undefined(调用方回退 createdAt/最后事件时间)。
 * 单会话任何失败都不外抛。
 */
async function persistedRowMeta(
  ctx: Context,
  header: SessionHeader,
): Promise<{ updatedAt?: number; sizeBytes?: number }> {
  const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
  if (persistence?.stat) {
    try {
      const snap = await persistence.stat(SessionId(String(header.id)))
      const snapRec = snap as { header?: SessionHeader; sizeBytes?: unknown } | undefined
      const path = snapRec?.header ? persistence.locate?.(snapRec.header)?.path : undefined
      const mtime = path ? await stat(path).then((s) => s.mtimeMs, () => undefined) : undefined
      return {
        ...(mtime !== undefined ? { updatedAt: mtime } : {}),
        ...(typeof snapRec?.sizeBytes === 'number' ? { sizeBytes: snapRec.sizeBytes } : {}),
      }
    } catch { /* → locate 兜底 */ }
  }
  try {
    const loc = persistence?.locate?.(header)
    if (loc?.path) return { updatedAt: (await stat(loc.path)).mtimeMs }
  } catch { /* 未落盘 */ }
  return {}
}

// ═══════════════════════ 会话查看(session_list / session_log)辅助 ═══════════════════════

interface SessionsStoreView {
  list?: () => { header: SessionHeader }[]
  get?: (id: SessionId) => (unknown & { header?: SessionHeader; log?: unknown[] }) | undefined
}
/** [r2] 0.1.5 的持久化句柄最小面(open('read') 返回; read 读事件切片, close 释放) */
interface PersistenceHandleView {
  id?: unknown
  header?: SessionHeader
  read?: (offset?: number, length?: number, options?: { signal?: AbortSignal }) => Promise<unknown>
  close?: () => Promise<void>
}
/**
 * 持久化服务视图(同时兼容 0.1.2 与 0.1.5):
 *   - 0.1.2: list() → SessionHeader[](裸 header), inspect(id) → { meta, events }
 *   - 0.1.5: list() → SessionPersistenceSnapshot[]({ header, revision, sizeBytes? }), stat(id) → snapshot,
 *            open(id,'read') → handle; inspect 已移除(用 open+read 顶替)
 * 字段全部 optional: 版本差异靠运行时探测, 不做版本号硬判断。
 */
interface PersistenceView {
  list?: (signal?: AbortSignal) => Promise<readonly unknown[]>
  /** 0.1.2 旧契约(0.1.5 已移除, 探测不到就走 open/read) */
  inspect?: (id: SessionId, signal?: AbortSignal) => Promise<{ meta: SessionHeader; events: readonly unknown[] } | undefined>
  /** 0.1.5 新增: 轻量元数据(不存在返回 undefined) */
  stat?: (id: SessionId, options?: { signal?: AbortSignal }) => Promise<unknown>
  /** 0.1.5 新增: 打开读句柄(v3 格式兼容的关键路径) */
  open?: (id: SessionId, access: 'read' | 'write', options?: { signal?: AbortSignal }) => Promise<PersistenceHandleView>
  locate?: (meta: SessionHeader) => { kind: string; path: string } | undefined
}

/** 从事件流里取最新 session/title 事件的标题(live/persisted 通用的只读扫描) */
function titleFromEvents(events: readonly unknown[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { title?: unknown } } | undefined
    if (e?.type === 'session/title' && typeof e.data?.title === 'string' && e.data.title) return e.data.title
  }
  return undefined
}

/** 从事件流解析会话实际运行的 preset: 最后一条 agent-preset/selected 优先, 其次 header.agentPreset(dsh-agent-presets 0.1.2 移除 resolveSessionPreset 后的本地实现, 语义同旧版) */
function presetFromEvents(header: SessionHeader | undefined, events: readonly unknown[]): string | undefined {
  if (header === undefined) return undefined
  try {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i] as { type?: string; data?: { preset?: unknown } } | undefined
      if (e?.type === 'agent-preset/selected' && typeof e.data?.preset === 'string' && e.data.preset) {
        return e.data.preset
      }
    }
    return header.agentPreset
  } catch {
    return header.agentPreset
  }
}

/**
 * A: 请求级 preset 覆盖预检(与 preset_set new-default 同款 resolve 校验)。
 * 可用返回 undefined; 未知返回错误文案 `unknown preset <id>; available: [...]`
 * (available 优先取 UnknownPresetError.available, 缺失时回退 list() 花名册)。
 */
async function presetOverrideError(ctx: Context, presetId: string): Promise<string | undefined> {
  try {
    await ctx.agentPresets.resolve(presetId)
    return undefined
  } catch (e) {
    const fromErr = (e as { available?: readonly string[] })?.available
    let names: string[] = fromErr ? [...fromErr] : []
    if (names.length === 0) {
      try {
        const svc = ctx.agentPresets as unknown as { list?: () => Promise<{ id: string }[]> } | undefined
        names = ((await svc?.list?.()) ?? []).map((p) => p.id)
      } catch { /* 服务缺失 → 空名单 */ }
    }
    return `unknown preset ${presetId}; available: [${names.join(', ')}]`
  }
}

// ═══════════════════════ P3: 权限三档(sandbox/mode) + 审批转接桥(approvals) ═══════════════════════
//
// 权限三档与 dsh-sandbox-policy 同款语义但不直接依赖该包(免新增运行时依赖):
//   - 写入 = session.append('sandbox/mode', {mode})(dsh setSandboxMode 的一行实现);
//   - 折叠 = 最后一条 sandbox/mode 事件(dsh effectiveSandboxMode); 无 override 时用部署默认。
// 审批桥复用 dsh-host-apiproxy 的 Web 审批通道: 订阅 ctx.apiProxy.events.mux() 拿到每个待审帧的
// rpcId, approval_respond 经 ctx.apiProxy.respond()(公开服务方法)以 client-response 回答 ——
// 应答器仍是 apiproxy 本身(绕开 cordis waterfall 的注册顺序陷阱), 与 Web UI 双通道先答者胜。
// apiProxy 缺失时降级为自注册 'approval/request' answerer(builtin, 照 apiproxy 先例扫 asked/decided)。

/** 结构化视图: 只需要 session 的 id/header/事件流/append(dsh Session 的最小面) */
interface PolicySessionLike {
  id?: unknown
  header?: SessionHeader
  events?: readonly unknown[]
  log?: readonly unknown[]
  append?: (type: string, data: unknown) => unknown
}

/** dsh setSandboxMode 同款写入路径: 追加一条 sandbox/mode 事件(下一次受限调用生效, 重启靠 replay 保持) */
function appendSandboxMode(session: PolicySessionLike, mode: SandboxMode): void {
  session.append?.('sandbox/mode', { mode })
}

/** 折叠事件流里最后一条 sandbox/mode(dsh effectiveSandboxMode 同款); 无 override 返回 undefined */
function sandboxModeFromEvents(events: readonly unknown[]): SandboxMode | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { mode?: unknown } } | undefined
    if (e?.type === 'sandbox/mode' && typeof e.data?.mode === 'string') return e.data.mode as SandboxMode
  }
  return undefined
}

/** 折叠事件流里最后一条 approval/policy(dsh effectiveApprovalPolicy 同款); 无 override 返回 undefined */
function approvalPolicyFromEvents(events: readonly unknown[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { policy?: unknown } } | undefined
    if (e?.type === 'approval/policy' && typeof e.data?.policy === 'string') return e.data.policy
  }
  return undefined
}

/** 部署级审批策略默认(ctx.approval.config.policy ?? 'ask'; 服务缺失时按 dsh 默认 'ask') */
function deploymentApprovalPolicy(ctx: Context): string {
  try {
    const p = (ctx.get('approval') as { config?: { policy?: string } } | undefined)?.config?.policy
    if (p === 'ask' || p === 'never') return p
  } catch { /* 服务缺失 */ }
  return 'ask'
}

/** apiProxy 最小结构视图(内部契约: events.mux 广播 MuxFrame; respond 接收 client-response 返回 RpcReceipt) */
interface ApiProxyView {
  events?: {
    mux?: (request: { rpcId: string; payload: Record<string, unknown> }, signal: AbortSignal) => AsyncIterable<{
      rpcId: string
      payload: {
        type?: string
        sessionId?: unknown
        approvalId?: unknown
        toolName?: unknown
        callId?: unknown
        reason?: unknown
        outcome?: unknown
      }
    }>
  }
  respond?: (message: {
    type: 'client-response'
    rpcId: string
    result: { ok: true; value: Record<string, unknown> }
  }) => Promise<{ accepted: boolean; reason?: string }>
}

/** 取 apiProxy(强转结构视图; 纯 headless 组合没有该服务时返回 undefined。dsh 0.1.2 起不 inject 的服务禁止直接读 ctx.apiProxy, 必须 ctx.get(key, false) 宽松读取) */
function apiProxyOf(ctx: Context): ApiProxyView | undefined {
  // [r2] C 项适配核查: dsh 0.1.5 已不再随包发布 dsh-host-apiproxy(实测 node_modules 里无该包),
  // 本插件也未把它写进 inject, 因此这里用 ctx.get('apiProxy', false) 宽松探测: 服务缺失返回 undefined,
  // 绝不抛错。startApprovalsBridge 据此自动降级 builtin/file-push —— 0.1.5 下审批桥仍可用(已跑通 p3)。
  return ctx.get('apiProxy', false) as ApiProxyView | undefined
}

/** 挂起审批条目(web 桥来自 mux 帧, 带 rpcId; builtin 桥来自 answerer 直收, 带 settle) */
interface PendingApproval {
  approvalId: string
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
  requestedAt: number
  /** web 桥: 回答所需 rpcId(apiProxy.respond 按 rpcId 路由) */
  rpcId?: string
  /** builtin 桥: 直接 settle answerer promise(outcome 原样返回给审批链) */
  settle?: (outcome: ApprovalOutcome) => void
  /** 超时定时器(approvalTimeoutMs 后收尾, 绝不超时放行) */
  timer?: ReturnType<typeof setTimeout>
}

/** 内存挂起审批表(approvalId 键 —— ApprovalRequestId 全局唯一) */
const pendingApprovals = new Map<string, PendingApproval>()

/** 当前生效的审批桥形态(status_get/approval_list 上报) */
let activeBridgeKind: ApprovalsBridge = 'off'

/** file-push 桥活动状态({dir: 审批文件目录}); 非 file-push 形态为 null(全部文件操作 no-op) */
let approvalBridgeFiles: { dir: string } | null = null

/** file-push 响应文件轮询间隔(ms; 协议要求 ≥500) */
const APPROVAL_FILE_POLL_MS = 500

function clearApprovalTimer(entry: PendingApproval): void {
  if (entry.timer !== undefined) {
    clearTimeout(entry.timer)
    entry.timer = undefined
  }
}

/** 从挂起表摘除条目(清定时器; 幂等) */
function removePendingApproval(entry: PendingApproval): void {
  clearApprovalTimer(entry)
  if (pendingApprovals.get(entry.approvalId) === entry) pendingApprovals.delete(entry.approvalId)
}

/**
 * 登记挂起审批并武装超时定时器。超时语义(P3 铁律 —— 绝不超时放行):
 *   - builtin 桥: settle 'cancelled'(host 侧撤回, 模型在原 turn 内收到取消继续收尾);
 *   - web 桥: 客户端协议没有 cancelled, 以 'rejected' 回答(fail-closed, 同样让模型原 turn 收尾)。
 */
function armPendingApproval(ctx: Context, entry: PendingApproval): void {
  pendingApprovals.set(entry.approvalId, entry)
  const timer = setTimeout(() => {
    // 已被回答/摘除 → 定时器作废(先答者胜)
    if (pendingApprovals.get(entry.approvalId) !== entry) return
    removePendingApproval(entry)
    removePendingApprovalFile(entry.approvalId)
    console.warn(`[harness-mcp-server] approval ${entry.approvalId} timed out after ${runtimeConfig.approvalTimeoutMs}ms -> ${entry.settle ? 'cancelled' : 'rejected'} (never allow on timeout)`)
    if (entry.settle) {
      entry.settle('cancelled')
      return
    }
    const proxy = apiProxyOf(ctx)
    if (proxy?.respond && entry.rpcId !== undefined) {
      void proxy.respond({
        type: 'client-response',
        rpcId: entry.rpcId,
        result: { ok: true, value: { sessionId: entry.sessionId, approvalId: entry.approvalId, outcome: 'rejected' } },
      }).catch(() => { /* 超时兜底回答失败不影响主流程 */ })
    }
  }, Math.max(1, runtimeConfig.approvalTimeoutMs))
  timer.unref?.()
  entry.timer = timer
}

/**
 * 审批回答主流程: web 桥走 apiProxy.respond(rpcId 路由), builtin 桥直接 settle。
 * 返回 receipt 视图({accepted:true} | {accepted:false, reason:'not-pending'})——
 * 双通道竞态先答者胜: 本表条目已摘除后第二路回答拿到 not-pending, 原样透传给调用方。
 */
async function respondToApproval(ctx: Context, entry: PendingApproval, outcome: 'allowed-once' | 'rejected'): Promise<{ accepted: boolean; reason?: string }> {
  // 先摘除再回答: 保证同一 approvalId 只被 settle 一次(败者在入口处就被 not-pending 挡下)
  removePendingApproval(entry)
  clearApprovalTimer(entry)
  removePendingApprovalFile(entry.approvalId)
  if (entry.settle) {
    entry.settle(outcome)
    return { accepted: true }
  }
  const proxy = apiProxyOf(ctx)
  if (!proxy?.respond || entry.rpcId === undefined) return { accepted: false, reason: 'not-pending' }
  try {
    const receipt = await proxy.respond({
      type: 'client-response',
      rpcId: entry.rpcId,
      result: { ok: true, value: { sessionId: entry.sessionId, approvalId: entry.approvalId, outcome } },
    })
    return receipt.accepted ? { accepted: true } : { accepted: false, reason: receipt.reason ?? 'not-pending' }
  } catch (e) {
    console.warn('[harness-mcp-server] approval respond failed:', (e as Error)?.message ?? e)
    return { accepted: false, reason: 'not-pending' }
  }
}

/** 写 pending_<approvalId>.json(文件推送协议: 通知 Hermes 有审批待答)。仅 file-push 形态生效; 失败有 warn。 */
async function writePendingApprovalFile(entry: { approvalId: string; sessionId: string; toolName: string; callId?: string; reason?: string; requestedAt: number; rpcId?: string }): Promise<void> {
  const bridge = approvalBridgeFiles
  if (bridge === null) return
  try {
    await mkdir(bridge.dir, { recursive: true })
    await writeFile(joinPath(bridge.dir, `pending_${entry.approvalId}.json`), `${JSON.stringify({
      approvalId: entry.approvalId,
      sessionId: entry.sessionId,
      toolName: entry.toolName,
      reason: entry.reason ?? null,
      requestedAt: entry.requestedAt,
      rpcId: entry.rpcId ?? null,
      callbackDir: bridge.dir,
      outcome: null,
    }, null, 2)}\n`, 'utf8')
  } catch (e) {
    console.warn(`[harness-mcp-server] pending approval file write failed (${entry.approvalId}): ${(e as Error)?.message ?? e}`)
  }
}
/** 删除 pending_<approvalId>.json(已应答/超时/卸载清理)。仅 file-push 形态生效; 不存在或失败静默。 */
async function removePendingApprovalFile(approvalId: string): Promise<void> {
  const bridge = approvalBridgeFiles
  if (bridge === null) return
  try {
    await unlink(joinPath(bridge.dir, `pending_${approvalId}.json`))
  } catch { /* 文件不存在或无法删除, 静默 */ }
}
/** 扫描会话事件流定位本次 ask 的 ApprovalRequestId(builtin/file-push answerer 共用; 返回 undefined 表示交给 next)。
 *  照 apiproxy 先例: 倒序扫 asked/decided 配对, 跳过已挂起/已决, callId 必须与本次请求一致。 */
function findApprovalFromEvents(req: { callId?: string }, events: readonly unknown[]): string | undefined {
  const decided = new Set<string>()
  let approvalId: string | undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as { type?: string; data?: { id?: unknown; callId?: unknown } } | undefined
    if (ev?.type === 'approval/decided') decided.add(String(ev.data?.id))
    else if (ev?.type === 'approval/asked') {
      const id = String(ev.data?.id)
      if (decided.has(id) || pendingApprovals.has(id)) continue
      if ((req.callId ?? null) !== (ev.data?.callId ?? null)) continue
      approvalId = id
      break
    }
  }
  return approvalId
}
/** 构造 builtin 式 'approval/request' answerer: 定位 approvalId → armPendingApproval(settle 实际应答)。
 *  filePush=true(file-push 桥)时先写 pending_<approvalId>.json 通知 Hermes; 其余行为与 builtin 完全一致。 */
function makeApprovalRequestAnswerer(ctx: Context, filePush: boolean) {
  return async (req: { signal?: { aborted: boolean }; agent?: { session?: unknown }; callId?: string; toolName?: string; reason?: string }, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
    if (req.signal?.aborted === true) return 'cancelled'
    const sess = req.agent?.session as unknown as PolicySessionLike | undefined
    const events = ((sess?.events ?? sess?.log) ?? []) as readonly unknown[]
    const approvalId = findApprovalFromEvents(req, events)
    if (approvalId === undefined) return next()
    const base = {
      approvalId,
      sessionId: String(sess?.id ?? ''),
      toolName: typeof req.toolName === 'string' ? req.toolName : '?',
      ...(req.callId !== undefined ? { callId: String(req.callId) } : {}),
      ...(req.reason !== undefined ? { reason: String(req.reason) } : {}),
      requestedAt: Date.now(),
    }
    if (filePush) await writePendingApprovalFile(base)
    return new Promise<ApprovalOutcome>((resolve) => {
      armPendingApproval(ctx, { ...base, settle: resolve } as PendingApproval)
    })
  }
}
/** 处理单个 response_<approvalId>.json: 内容有效且审批仍挂起 → respondToApproval; 其余(not-pending/非法/名实不符)仅删文件。
 *  无论结果如何都消费该响应文件, 防堆积; 半写文件(JSON 解析失败)留待下一轮轮询。 */
async function handleApprovalResponseFile(ctx: Context, filePath: string, approvalId: string): Promise<void> {
  let payload: { approvalId?: string; outcome?: string }
  try {
    payload = JSON.parse(await readFile(filePath, 'utf8'))
  } catch { return }
  const mismatch = payload?.approvalId !== approvalId
  const outcome = payload?.outcome
  const entry = pendingApprovals.get(approvalId)
  if (!mismatch && (outcome === 'allowed-once' || outcome === 'rejected') && entry !== undefined) {
    const receipt = await respondToApproval(ctx, entry, outcome)
    if (receipt.accepted) console.log(`[harness-mcp-server] approval ${approvalId} answered via file-push: ${outcome}`)
    else console.warn(`[harness-mcp-server] approval ${approvalId} file answer not accepted (${receipt.reason ?? '?'}); response file removed`)
  } else {
    console.warn(`[harness-mcp-server] approval response file ignored (${approvalId} -> ${String(outcome)}${mismatch ? `; payload approvalId=${String(payload?.approvalId)} mismatch` : ''}): not-pending or invalid; response file removed`)
  }
  try { await unlink(filePath) } catch { /* 删除失败静默, 防残留 */ }
}
/** file-push 轮询: 扫描 approvalFileDir 下所有 response_*.json(定期检测, 间隔 ≥500ms) */
async function scanApprovalResponseFiles(ctx: Context): Promise<void> {
  const bridge = approvalBridgeFiles
  if (bridge === null) return
  let names: string[]
  try {
    names = await readdir(bridge.dir)
  } catch { return } // 目录未创建/不可读 → 下一轮
  for (const name of names) {
    if (!name.startsWith('response_') || !name.endsWith('.json')) continue
    await handleApprovalResponseFile(ctx, joinPath(bridge.dir, name), name.slice('response_'.length, -'.json'.length))
  }
}


/**
 * 启动审批转接桥(P3)。apply() 末尾调用一次, 返回 dispose(卸载时清定时器/订阅/挂起表)。
 * 形态选择:
 *   - off            : 不做任何事(activeBridgeKind='off'; 审批回到部署默认行为 —— 无应答器即 fail-closed)。
 *   - web + apiProxy : activeBridgeKind='web'。订阅 apiProxy mux 流维护内存挂起表(open 时 apiproxy
 *                      会重放 still-pending 帧); 应答器是 apiproxy 自己, approval_respond 经它回答,
 *                      与 Web UI 双通道先答者胜(mux 收到 approval/resolved 即同步摘除)。
 *   - file-push       : activeBridgeKind='file-push'。builtin answerer(settle 实际应答)+ 文件通知:
 *                       approval/request 时写 pending_<approvalId>.json, 轮询(≥500ms)检测 Hermes 的
 *                       response_<approvalId>.json → respondToApproval → 删响应文件; resolved/超时清理 pending 文件。
 *   - 其余(builtin)  : activeBridgeKind='builtin'。自注册 'approval/request' answerer(waterfall;
 *                      照 apiproxy 先例扫 asked/decided 配对定位本次 ask 的 ApprovalRequestId),
 *                      approval_respond 直接 settle。apiProxy 缺失时自动落到这里(降级保底)。
 */
function startApprovalsBridge(ctx: Context): () => void {
  // 重复 apply 幂等: 清残留挂起表与定时器(上一实例未触发的超时不许跨实例触发)
  for (const old of [...pendingApprovals.values()]) clearApprovalTimer(old)
  pendingApprovals.clear()
  activeBridgeKind = 'off'

  const bridge = runtimeConfig.approvalsBridge
  if (bridge === 'off') return () => {}

  const proxy = apiProxyOf(ctx)
  if (bridge === 'web' && proxy?.events?.mux && proxy.respond) {
    activeBridgeKind = 'web'
    const controller = new AbortController()
    void (async () => {
      try {
        // mux 是全会话聚合流: 每帧包一层 RpcRequest{rpcId,payload}; requested 帧的 rpcId 即回答路由键
        const stream = proxy.events!.mux!({ rpcId: `harness-mcp-${randomUUID()}`, payload: {} }, controller.signal)
        for await (const msg of stream) {
          const f = msg.payload
          if (f.type === 'approval/requested' && typeof f.approvalId === 'string' && typeof f.sessionId === 'string') {
            if (pendingApprovals.has(f.approvalId)) continue
            armPendingApproval(ctx, {
              approvalId: f.approvalId,
              sessionId: f.sessionId,
              toolName: typeof f.toolName === 'string' ? f.toolName : '?',
              ...(typeof f.callId === 'string' ? { callId: f.callId } : {}),
              ...(typeof f.reason === 'string' ? { reason: f.reason } : {}),
              requestedAt: Date.now(),
              rpcId: String(msg.rpcId),
            })
          } else if (f.type === 'approval/resolved' && typeof f.approvalId === 'string') {
            // Web UI/Hermes 他路先答: 同步摘除(本桥再 respond 会拿 not-pending)
            const entry = pendingApprovals.get(f.approvalId)
            if (entry) removePendingApproval(entry)
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          console.warn('[harness-mcp-server] approvals mux stream ended:', (e as Error)?.message ?? e)
        }
      }
    })()
    return () => {
      controller.abort()
      for (const entry of [...pendingApprovals.values()]) clearApprovalTimer(entry)
      pendingApprovals.clear()
      approvalBridgeFiles = null
      activeBridgeKind = 'off'
    }
  }

  // builtin/file-push 降级/显式: 自注册 answerer(waterfall; 不调 next 即认领本次请求)
  if (typeof (ctx as { on?: unknown }).on !== 'function') {
    // 无事件能力的宿主(如部分 mock/headless 组合)无法注册 waterfall answerer → 关闭桥,
    // 避免 ctx.on is not a function 崩溃; 审批请求按 fail-closed 无 answerer 处理。
    activeBridgeKind = 'off'
    approvalBridgeFiles = null
    console.warn('[approvals] host 无 ctx.on 事件能力, builtin/file-push 桥关闭(approvalsBridge=off)')
    return () => {}
  }
  const filePush = bridge === 'file-push'
  activeBridgeKind = filePush ? 'file-push' : 'builtin'
  if (filePush) {
    approvalBridgeFiles = { dir: runtimeConfig.approvalFileDir }
    try { void mkdir(runtimeConfig.approvalFileDir, { recursive: true }).catch(() => {}) } catch { /* ignore */ }
  }
  ctx.on('approval/request', makeApprovalRequestAnswerer(ctx, filePush))
  /** 启动响应文件轮询(仅 file-push; 兜底即使没有 fs.watch 也能工作, 间隔 ≥500ms) */
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  if (filePush) {
    const tick = () => {
      const b = approvalBridgeFiles
      if (b === null) return
      scanApprovalResponseFiles(ctx).catch((e) => {
        console.warn('[harness-mcp-server] approval response scan failed:', (e as Error)?.message ?? e)
      }).finally(() => {
        if (approvalBridgeFiles !== null) pollTimer = setTimeout(tick, APPROVAL_FILE_POLL_MS)
      })
    }
    pollTimer = setTimeout(tick, APPROVAL_FILE_POLL_MS)
  }
  return () => {
    if (pollTimer !== undefined) clearTimeout(pollTimer)
    for (const entry of [...pendingApprovals.values()]) {
      clearApprovalTimer(entry)
      removePendingApprovalFile(entry.approvalId)
    }
    pendingApprovals.clear()
    approvalBridgeFiles = null
    activeBridgeKind = 'off'
  }
}

/** 会话粗粒度 updatedAt: live 取最后事件 time, persisted 取 stat/locate 的落盘 mtime, 都没有用 createdAt(单会话失败不外抛) */
async function roughUpdatedAt(ctx: Context, header: SessionHeader): Promise<number> {
  const store = ctx.get('sessions') as SessionsStoreView | undefined
  const live = store?.get?.(header.id) as { log?: { time?: number }[] } | undefined
  const log = live?.log
  if (log && log.length > 0) {
    const t = Number(log[log.length - 1]?.time)
    if (Number.isFinite(t) && t > 0) return t
  }
  // [r2] 0.1.5: stat(id)(+locate 取路径算 mtime) / 0.1.2: locate(header) → 落盘 mtime
  try {
    const meta = await persistedRowMeta(ctx, header)
    if (meta.updatedAt !== undefined) return meta.updatedAt
  } catch { /* 未落盘回退 createdAt */ }
  return header.createdAt ?? 0
}

/**
 * [r1] B2: 批量检视会话行, 并发 4 + 单会话超时。
 * 旧实现串行 inspectSessionRow: 单会话读数约 655ms, 50 行串行 ≈ 33s。
 * 并发度取 4 与官方 SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY 对齐(最稳)。
 * 单会话超时(默认 3000ms)超时即放弃该行(调用方计入 skipped), 不让一行拖垮整表。
 * @returns id(str) → 检视结果; 读不到/超时的会话不在 map 里
 */
async function inspectRowsConcurrent(
  ctx: Context,
  rows: readonly CorpusRow[],
  onSkipped: () => void,
): Promise<Map<string, NonNullable<Awaited<ReturnType<typeof inspectSessionRow>>>>> {
  const out = new Map<string, NonNullable<Awaited<ReturnType<typeof inspectSessionRow>>>>()
  const queue = [...rows]
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      const id = String(item.header.id)
      try {
        const r = await withTimeout(inspectSessionRow(ctx, item.header), SESSION_LIST_INSPECT_TIMEOUT_MS)
        if (r === undefined) { onSkipped(); continue }
        out.set(id, r)
      } catch { onSkipped() }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SESSION_LIST_INSPECT_CONCURRENCY, queue.length) }, worker))
  return out
}

/**
 * 单个会话的轻量检视: 消息条数 + 标题 + 统计摘要 + 权限档。
 * [r2] persistedInspect 兼容 0.1.2 inspect 与 0.1.5 open/read; 失败回退 live log。
 * 返回 undefined = 两路都读不到(调用方应计入 skipped, 而不是伪造一行 messageCount:0 的假数据)。
 */
async function inspectSessionRow(ctx: Context, header: SessionHeader): Promise<{
  messageCount: number
  title?: string
  inputTokens?: number
  outputTokens?: number
  llmTimeSec?: number
  sandboxMode?: SandboxMode
} | undefined> {
  // [r2] header.id 缺失(畸形持久化条目)直接判为不可读, 不再喂 SessionId(undefined)
  if (header.id === undefined) return undefined
  try {
    const insp = await persistedInspect(ctx, SessionId(String(header.id)))
    if (insp) {
      const events = insp.events
      return summarizeRow(events.length, titleFromEvents(events), events)
    }
  } catch { /* 回退 live */ }
  const store = ctx.get('sessions') as SessionsStoreView | undefined
  const live = store?.get?.(SessionId(String(header.id))) as { log?: unknown[] } | undefined
  if (live?.log) return summarizeRow(live.log.length, titleFromEvents(live.log), live.log)
  // [r2] 两路都读不到: 返回 undefined 交由调用方跳过并计数(旧行为是返回 messageCount:0, 会污染列表)
  return undefined
}

/** 从事件流汇总行级统计摘要(messageCount/title + token/llm 摘要字段 + P3 sandboxMode 折叠) */
function summarizeRow(count: number, title: string | undefined, events: readonly unknown[]): {
  messageCount: number
  title?: string
  inputTokens?: number
  outputTokens?: number
  llmTimeSec?: number
  sandboxMode?: SandboxMode
} {
  try {
    const f = foldSessionStats(events)
    const mode = sandboxModeFromEvents(events)
    return {
      messageCount: count,
      ...(title !== undefined ? { title } : {}),
      inputTokens: f.inputTokens,
      outputTokens: f.outputTokens,
      llmTimeSec: Math.round(f.llmMs / 100) / 10,
      ...(mode !== undefined ? { sandboxMode: mode } : {}),
    }
  } catch {
    return { messageCount: count, ...(title !== undefined ? { title } : {}) }
  }
}

// ═══════════════════════ P1: 会话统计(sessionStats 折叠) ═══════════════════════
//
// 与官方 @deepseek-ai/dsh-session-stats 投影单元同款语义的纯折叠(本插件不依赖该包, 直接扫事件流):
//   - rounds  = turn/end 事件数(完成的轮次; 官方 turns 只数含闭合 step 的轮, 这里按需求取 turn/end 口径)
//   - steps   = step/end 事件数(完成/失败/取消的步都算, step 生命周期权威事件)
//   - llmMs   = Σ (step/start → assistant/message), 只计组装出消息的步(与官方窗口口径一致)
//   - toolMs  = Σ (tool/call → tool/result) 按 callId 配对; turn/end 时丢弃未回配对的悬挂 call
//   - ttftMs  = Σ (step/start → 首个非空 delta chunk); ttftSteps 为样本数
//   - decodeMs/decodeTokens: 首 token → assistant/message 的解码窗, 只计上报了 outputTokens 的步
//   - tokens  = assistant/message.usage 累加(inputTokens/outputTokens/cacheRead/cacheWrite/reasoning)
// 取消步组装不出消息, 其半截流时间不计入任何时间口径(与官方一致)。

/** 会话统计折叠结果(内部毫秒口径; 对外呈现见 presentSessionStats) */
interface SessionStatsFold {
  rounds: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

function emptyStatsFold(): SessionStatsFold {
  return {
    rounds: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  }
}

/** usage 字段的安全数值读取 */
function usageNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** 把一段会话事件流折叠成统计(纯函数, 不修改输入)。 */
function foldSessionStats(events: readonly unknown[]): SessionStatsFold {
  const s = emptyStatsFold()
  let openStep: { turn: number; step: number; startTime: number; firstTokenTime: number | null } | null = null
  const pendingCalls = new Map<string, number>()
  for (const raw of events) {
    const e = raw as { type?: string; time?: number; data?: Record<string, unknown> }
    if (typeof e?.type !== 'string') continue
    const t = typeof e.time === 'number' && Number.isFinite(e.time) ? e.time : 0
    const d = (e.data ?? {}) as Record<string, unknown>
    switch (e.type) {
      case 'step/start':
        openStep = { turn: Number(d.turn), step: Number(d.step), startTime: t, firstTokenTime: null }
        break
      case 'assistant/chunk': {
        const cd = d.chunk as { type?: string; text?: string; argumentsDelta?: string; name?: string } | undefined
        if (openStep === null || openStep.turn !== Number(d.turn) || openStep.step !== Number(d.step)) break
        // 内联 token-delta 判断(dsh-llm 0.1.2 移除 isTokenDelta; 语义与旧版一致:
        // text/reasoning-delta 看非空 text, tool-call-delta 看非空 argumentsDelta 或带 name)
        if (openStep.firstTokenTime === null && cd !== undefined) {
          const isTok =
            cd.type === 'text-delta' ? (cd.text ?? '') !== ''
            : cd.type === 'reasoning-delta' ? (cd.text ?? '') !== ''
            : cd.type === 'tool-call-delta' ? (cd.argumentsDelta ?? '') !== '' || cd.name !== undefined
            : false
          if (isTok) openStep.firstTokenTime = t
        }
        break
      }
      case 'assistant/message': {
        // [r2] 0.1.5 v3 事件流的 assistant/message 可能不带 turn/step(真实会话文件实证:
        // {"type":"assistant/message","turn":1,"step":1,...} 有, 但折叠出的历史/迁移事件可能缺)。
        // 旧代码 `openStep===null || turn/step 不匹配 → break` 会把这类消息的 usage 整条丢掉,
        // 导致 session_list 的 input/outputTokens 恒为 0。改为: 时间口径仍要求 step 匹配,
        // usage 累加不再受 step 绑定(与官方 session-stats"有 usage 就计账"一致)。
        const stepMatches = openStep !== null && openStep.turn === Number(d.turn) && openStep.step === Number(d.step)
        if (stepMatches) {
          const open = openStep as { startTime: number; firstTokenTime: number | null }
          s.llmMs += Math.max(0, t - open.startTime)
          if (open.firstTokenTime !== null) {
            s.ttftMs += Math.max(0, open.firstTokenTime - open.startTime)
            s.ttftSteps += 1
            const out1 = usageNum((d.usage as Record<string, unknown> | undefined)?.outputTokens)
            if (out1 > 0) {
              s.decodeMs += Math.max(0, t - open.firstTokenTime)
              s.decodeTokens += out1
            }
          }
          openStep = null
        }
        // token 用量累加(所有上报 usage 的消息; [r2] 不再要求 step 匹配)
        const u = d.usage as Record<string, unknown> | undefined
        if (u && typeof u === 'object') {
          s.inputTokens += usageNum(u.inputTokens)
          s.outputTokens += usageNum(u.outputTokens)
          s.cacheReadTokens += usageNum(u.cacheReadTokens)
          s.cacheWriteTokens += usageNum(u.cacheWriteTokens)
          s.reasoningTokens += usageNum(u.reasoningTokens)
        }
        break
      }
      case 'tool/call': {
        if (d.callId !== undefined) pendingCalls.set(String(d.callId), t)
        break
      }
      case 'tool/result': {
        // callId 在 message.source.callId(与官方投影同款); 自有键检查防原型链污染
        const msg = d.message as { source?: { callId?: unknown } } | undefined
        const cid = String(msg?.source?.callId ?? '')
        const dispatched = Object.hasOwn(Object.fromEntries(pendingCalls), cid) ? pendingCalls.get(cid) : undefined
        if (dispatched !== undefined) {
          pendingCalls.delete(cid)
          s.toolMs += Math.max(0, t - dispatched)
        }
        break
      }
      case 'step/end':
        s.steps += 1
        openStep = null
        break
      case 'turn/end':
        s.rounds += 1
        if (pendingCalls.size > 0) pendingCalls.clear() // 悬挂 call 归属被取消/失败的轮, 丢弃防泄漏
        break
      default:
        break
    }
  }
  return s
}

/**
 * 缓存命中率: 有 cacheRead 上报才计算。
 * 分母自适应两种 token 口径:
 *   - DeepSeek 式(inputTokens 已含缓存命中): cacheRead ≤ input → 分母 = inputTokens;
 *   - Anthropic 式(inputTokens 不含缓存): cacheRead ≫ input → 分母 = input+read+write(总提示 token)。
 * 结果 clamp 到 [0,1]。
 */
function cacheHitRateOf(s: SessionStatsFold): number | null {
  if (s.cacheReadTokens <= 0) return null
  let denom: number
  if (s.inputTokens > 0 && s.cacheReadTokens <= s.inputTokens) {
    denom = s.inputTokens
  } else {
    denom = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens
  }
  if (denom <= 0) return null
  return Math.min(1, Math.round((s.cacheReadTokens / denom) * 10000) / 10000)
}

/** 统计对外呈现: 秒 + 毫秒双口径, 均值类字段无样本时为 null */
function presentSessionStats(s: SessionStatsFold, opts: { scope: 'run' | 'session'; sessionId?: string }): Record<string, unknown> {
  const r3 = (n: number) => Math.round(n * 1000) / 1000
  return {
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    scope: opts.scope,
    rounds: s.rounds,
    steps: s.steps,
    llmTime: r3(s.llmMs / 1000),
    llmTimeMs: Math.round(s.llmMs),
    toolTime: r3(s.toolMs / 1000),
    toolTimeMs: Math.round(s.toolMs),
    // [r3] A3: 时长附人类可读形态(原始秒/毫秒口径保持不变)
    llmTimeHuman: formatDuration(s.llmMs),
    toolTimeHuman: formatDuration(s.toolMs),
    ttft: s.ttftSteps > 0 ? Math.round(s.ttftMs / s.ttftSteps) : null,
    ttftHuman: s.ttftSteps > 0 ? formatDuration(s.ttftMs / s.ttftSteps) : null,
    ttftSteps: s.ttftSteps,
    tokensPerSec: s.decodeMs > 0 ? Math.round((s.decodeTokens / (s.decodeMs / 1000)) * 10) / 10 : null,
    cacheHitRate: cacheHitRateOf(s),
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheWriteTokens: s.cacheWriteTokens,
    reasoningTokens: s.reasoningTokens,
  }
}

// ═══════════════════════ P2: session_search 辅助 ═══════════════════════

/** 单会话内容搜索的读取时限(毫秒) */
const SESSION_SEARCH_TIMEOUT_MS = 2000
/** 单会话参与内容匹配的文本上限(chars), 防超大日志拖垮整体扫描 */
const SESSION_SEARCH_MAX_TEXT_CHARS = 2 * 1024 * 1024
/** zstd 帧魔数(小端 0xFD2FB528) */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 解压 dsh 落盘的 session.jsonl.zstd: 多个 zstd 帧顺序拼接(每次 flush 追加一帧),
 * 整文件单次 sync 解压只能拿到首帧。按魔数切分逐帧解压; 魔数若误现于帧载荷内,
 * 向后合并相邻分段直到解压成功(合并到文件尾仍失败则该帧损坏, 跳过)。
 */
function decompressZstdFile(buf: Buffer): string {
  const offs: number[] = []
  for (let p = buf.indexOf(ZSTD_MAGIC); p !== -1; p = buf.indexOf(ZSTD_MAGIC, p + 4)) offs.push(p)
  if (offs.length === 0) return ''
  let text = ''
  let k = 0
  while (k < offs.length) {
    const start = offs[k] as number
    let end = k + 1
    let decoded: string | null = null
    for (;;) {
      const seg = end < offs.length ? buf.subarray(start, offs[end] as number) : buf.subarray(start)
      try {
        decoded = zstdDecompressSync(seg).toString('utf8')
        break
      } catch {
        if (end < offs.length) end += 1
        else break
      }
    }
    if (decoded !== null) text += decoded
    k = decoded !== null ? end : k + 1
  }
  return text
}

/** Promise 限时: 超时返回 undefined(不中断原 promise, 只是不再等它) */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((res) => {
    timer = setTimeout(() => res(undefined), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 读单会话事件流(session_search 用): [r2] persistedInspect(0.1.2 inspect / 0.1.5 open+read, 带限时)
 * → live log → locate(path) 落盘文件多帧 zstd 兜底。都不可得返回 undefined。
 */
async function readSessionEventsSearch(ctx: Context, header: SessionHeader): Promise<{ events: unknown[]; source: 'persisted' | 'live' | 'file' } | undefined> {
  const sid = SessionId(String(header.id))
  const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
  try {
    const insp = await withTimeout(persistedInspect(ctx, sid), SESSION_SEARCH_TIMEOUT_MS + 500)
    if (insp) return { events: insp.events, source: 'persisted' }
  } catch { /* 未持久化/超时/中止 → 回退 */ }
  const store = ctx.get('sessions') as SessionsStoreView | undefined
  const live = store?.get?.(sid) as { log?: unknown[] } | undefined
  if (live?.log && live.log.length > 0) return { events: [...live.log], source: 'live' }
  // 兜底: 直接读落盘文件(node:zlib 多帧 zstd)。locate 给真实路径, 不自算目录 slug。
  if (persistence?.locate) {
    try {
      const loc = persistence.locate(header)
      if (loc?.path) {
        const buf = await readFile(loc.path)
        const text = decompressZstdFile(buf)
        if (text) {
          const events: unknown[] = []
          for (const line of text.split('\n')) {
            if (!line.trim()) continue
            try { events.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
          }
          return { events, source: 'file' }
        }
      }
    } catch { /* 读不到/解压失败 → 放弃该会话内容搜索 */ }
  }
  return undefined
}

/** session_search 结果行 */
interface SessionSearchRow {
  sessionId: string
  title: string
  cwd?: string
  updatedAt: number
  matched: 'title' | 'content'
  snippet?: string
}

// ═══════════════════════ [r1] C1/C2: 官方索引搜索(探测 + 静默回退) ═══════════════════════
//
// ctx.sessionQuery.searchSessions 是 0.1.7 的官方全文索引。但在本机默认部署下**不可用**:
//   - dsh-base 默认 `openAt:'never'` → 恒抛 SESSION_QUERY_SEARCH_DISABLED;
//   - 即使打开索引, 上游 locate() 恒按 v4 拼文件名(实际落盘 v3/legacy), 186/198 会话会让
//     SessionCorpus.load 抛 SESSION_QUERY_PERSISTENCE_FAILED(PLAN_r1 §1.5)。
// 因此设计为"探测成功才用, 任何 SESSION_QUERY_* 错误一律静默回退现有扫描实现"(裁决 D10),
// 并在 status_get/config_get 如实上报 backend 与回退原因, 让部署方能看出索引没生效。

/** [r1] 最近一次 session_search 实际生效的后端(供 status_get/config_get 上报) */
let sessionSearchBackend: 'index' | 'scan' = 'scan'
/** [r1] 最近一次回退原因(仅诊断用, 不含敏感信息) */
let sessionSearchFallbackReason: string | undefined = '尚未调用过 session_search'

/**
 * [r1] C1: 尝试走官方索引搜索。
 * 只有**完整成功**才返回 hits; 任何异常(SESSION_QUERY_SEARCH_DISABLED /
 * SESSION_QUERY_PERSISTENCE_FAILED / 未挂载 / 结构不符)都返回 {hits: undefined, reason} 让调用方回退。
 * @returns hits=undefined 表示"索引不可用, 请回退"; reason 为可上报的简短原因
 */
async function tryIndexSearch(
  ctx: Context,
  req: { query: string; cwd?: string; limit: number },
): Promise<{ hits?: SessionSearchRow[]; reason?: string }> {
  const query = sessionQueryOf(ctx)
  if (typeof query?.searchSessions !== 'function') return { reason: 'ctx.sessionQuery.searchSessions 未挂载(非 0.1.7 或服务未激活)' }
  const sessionFilters = req.cwd
    ? [{ kind: 'cwd' as const, values: [req.cwd] }]
    : undefined
  let page: unknown
  try {
    page = await query.searchSessions({
      query: req.query,
      limit: Math.min(Math.max(1, req.limit), 100),
      ...(sessionFilters ? { sessionFilters } : {}),
    })
  } catch (e) {
    // 关键: 绝不把 SESSION_QUERY_* 错误抛给用户 —— 一律转成回退原因
    const code = (e as { code?: unknown })?.code
    return { reason: typeof code === 'string' ? `官方索引不可用: ${code}` : `官方索引不可用: ${(e as Error)?.message ?? String(e)}` }
  }
  // 结构校验: 拿不到 items 数组就当失败回退(不做半截解析)
  const items = (page as { items?: unknown })?.items
  if (!Array.isArray(items)) return { reason: '官方索引返回结构不符(缺 items 数组)' }
  const hits: SessionSearchRow[] = []
  for (const raw of items) {
    const hit = raw as {
      header?: SessionHeader
      bestMatch?: { snippet?: unknown; time?: unknown }
    } | undefined
    const header = hit?.header
    if (!header || header.id === undefined) continue
    const snippet = typeof hit?.bestMatch?.snippet === 'string' ? hit.bestMatch.snippet : undefined
    const t = Number(hit?.bestMatch?.time)
    hits.push({
      sessionId: String(header.id),
      title: `(untitled ${String(header.id).slice(0, 8)})`,
      ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
      updatedAt: Number.isFinite(t) && t > 0 ? t : (header.createdAt ?? 0),
      matched: 'content',
      ...(snippet !== undefined ? { snippet } : {}),
    })
  }
  return { hits }
}

/** 命中判定: 正则模式 re.test, 否则大小写不敏感子串 */
function searchHit(text: string, re: RegExp | undefined, needle: string): boolean {
  if (re) return re.test(text)
  return text.toLowerCase().includes(needle)
}

/** 首个命中位置(正则 exec / 小写子串 indexOf; lowerText 为 text 的小写形式, 非 正则时必传) */
function searchIndexOf(text: string, re: RegExp | undefined, lowerText: string, needle: string): number {
  if (re) {
    const m = re.exec(text)
    return m ? m.index : -1
  }
  return lowerText.indexOf(needle)
}

/** 取命中 ±60 字符的 snippet(空白压缩成单空格) */
function snippetAround(text: string, index: number, matchLen: number): string {
  const start = Math.max(0, index - 60)
  const end = Math.min(text.length, index + matchLen + 60)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

/** 搜索单会话: 标题优先, 未命中再尽力扫内容(collectText 已跳过 reasoning 块)。 */
async function searchOneSession(
  ctx: Context,
  header: SessionHeader,
  updatedAt: number,
  m: { re?: RegExp; needle: string; rawLen: number },
): Promise<{ row?: SessionSearchRow; contentSearched: boolean }> {
  let title = `(untitled ${String(header.id).slice(0, 8)})`
  let found: { events: unknown[]; source: string } | undefined
  try {
    found = await readSessionEventsSearch(ctx, header)
  } catch { /* 单会话读取失败 → 仅标题兜底 */ }
  if (found) {
    const t = titleFromEvents(found.events)
    if (t !== undefined) title = t
  }
  if (searchHit(title, m.re, m.needle)) {
    return {
      row: { sessionId: String(header.id), title, ...(header.cwd !== undefined ? { cwd: header.cwd } : {}), updatedAt, matched: 'title' },
      contentSearched: found !== undefined,
    }
  }
  if (!found) return { contentSearched: false }
  // 内容搜索: 逐文本块匹配(stripReasoning 剥推理), 总量封顶防超大日志
  const texts: string[] = []
  try { collectText(found.events, texts) } catch { /* 忽略畸形事件 */ }
  let budget = SESSION_SEARCH_MAX_TEXT_CHARS
  for (const raw of texts) {
    if (budget <= 0) break
    const chunk = raw.length > 20000 ? raw.slice(0, 20000) : raw
    budget -= chunk.length
    const cleaned = stripReasoning(chunk)
    if (!cleaned) continue
    const idx = searchIndexOf(cleaned, m.re, cleaned.toLowerCase(), m.needle)
    if (idx >= 0) {
      return {
        row: {
          sessionId: String(header.id), title, ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
          updatedAt, matched: 'content', snippet: snippetAround(cleaned, idx, Math.max(1, m.rawLen)),
        },
        contentSearched: true,
      }
    }
  }
  return { contentSearched: true }
}

/** 当前 Agent 会话(最近一次 agent_run/task 执行的会话), 供 session_stats 无参调用 */
let lastAgentSessionId: string | undefined

/**
 * 收集一个会话的完整事件流([r2] persistedInspect 优先: 0.1.2 inspect / 0.1.5 open+read, 回退 live store 日志)。
 * 返回 undefined 表示 live 与持久化里都没有该会话。
 */
async function collectSessionEvents(ctx: Context, sid: SessionId): Promise<{ events: unknown[]; source: 'persisted' | 'live' } | undefined> {
  try {
    const insp = await persistedInspect(ctx, sid)
    if (insp && insp.events.length > 0) return { events: insp.events, source: 'persisted' }
  } catch { /* 未持久化 → 回退 live */ }
  const store = ctx.get('sessions') as SessionsStoreView | undefined
  const live = store?.get?.(sid) as { log?: unknown[] } | undefined
  if (live?.log && live.log.length > 0) return { events: [...live.log], source: 'live' }
  // 两路都空: 若持久化读取成功返回过 meta(空日志会话), 也算找到
  try {
    const insp = await persistedInspect(ctx, sid)
    if (insp) return { events: [], source: 'persisted' }
  } catch { /* ignore */ }
  return undefined
}

/** 单条日志事件 → 紧凑记录(stripReasoning 过滤 + 分字段限长); unknown 类型退化为 data JSON 摘录 */
function compactLogEvent(e: unknown): Record<string, unknown> {
  const ev = e as { type?: string; seq?: number; time?: number; data?: unknown }
  // [r3] A2: 时间戳统一人类可读 —— time 保留字段名但改为 ISO8601(本地时区), 原始 epoch 落到 time_epoch。
  // 用展开顺序保证 time/time_epoch 一定被 timeFields 覆盖(而不是被上面的原始 ev.time 抢占)。
  const base: Record<string, unknown> = { seq: ev.seq, type: ev.type, ...timeFields('time', ev.time) }
  const d = ev.data
  switch (ev.type) {
    case 'user/message': {
      const texts: string[] = []
      collectText(d, texts)
      base.text = stripReasoning(texts.join('\n')).slice(0, 3000)
      break
    }
    case 'assistant/message': {
      const msg = d as { message?: unknown } | undefined
      const texts: string[] = []
      collectText(msg?.message ?? d, texts)
      base.text = stripReasoning(texts.join('\n')).slice(0, 4000)
      break
    }
    case 'tool/call': {
      const call = d as { name?: string; arguments?: string; input?: unknown } | undefined
      base.name = call?.name ?? '?'
      base.arguments = String(call?.arguments ?? JSON.stringify(call?.input ?? null) ?? '').slice(0, 800)
      break
    }
    case 'tool/result': {
      const texts: string[] = []
      collectText(d, texts)
      base.text = stripReasoning(texts.join('\n')).slice(0, 1500)
      break
    }
    default:
      try {
        base.data = JSON.stringify(d)?.slice(0, 300)
      } catch {
        base.data = '[unserializable]'
      }
  }
  return base
}

/**
 * 存量捞回: 启动时把现存未分组的会话补挂到已注册工作区。
 * 条件: header.cwd 的 realpath 等于某已注册 workspace.path, 且该 sessionId 不在其花名册里。
 * 只补挂到"已注册"工作区, 不新建(避免把无关目录刷成新工作区); 单会话失败不影响其余。
 */
async function reattachOrphanSessions(ctx: Context): Promise<{ attached: number; failed: number }> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryView | undefined
  const byPath = new Map<string, WorkspaceView>()
  for (const ws of registry?.list?.() ?? []) byPath.set(ws.path, ws)
  if (byPath.size === 0) return { attached: 0, failed: 0 }

  // live + 持久化 header 合并(live 优先), 按 id 去重(共用实现)
  const { headers } = await listMergedHeaders(ctx)

  let attached = 0
  let failed = 0
  for (const header of headers.values()) {
    if (header.cwd === undefined) continue
    const canonical = await canonicalCwd(header.cwd)
    const ws = byPath.get(canonical)
    if (ws === undefined || !ws.attachSession) continue
    if (ws.sessionIds.includes(header.id)) continue
    try {
      await ws.attachSession(header.id)
      attached++
      console.log(`[harness-mcp-server] 存量捞回: session ${header.id} -> workspace ${ws.path}`)
    } catch (e) {
      failed++
      console.warn(`[harness-mcp-server] 存量捞回失败 session ${header.id}:`, (e as Error)?.message ?? e)
    }
  }
  return { attached, failed }
}

/** 在给定 McpServer 上注册工具 */
function registerTools(mcp: McpServer, ctx: Context): void {
  mcp.tool('echo', '连通性自检: 原样回显 text 并附服务器时间戳。什么时候用: 第一次接上本 server、或怀疑网络/认证断了的时候, 先 ping 一下确认通道活着(比直接调 agent_run 便宜得多)。返回 {收到: "<text>", at: <ISO8601 本地时区>, at_epoch: <毫秒 epoch>}。', { text: z.string().describe('要回显的文本(原样返回)') }, async ({ text }) => {
    const bad = validateArgs('echo', { text }, [{ name: 'text', type: 'string', required: true }])
    if (bad) return out(JSON.stringify({ error: bad }))
    // [r3] A: 服务器时间戳改为人类可读 ISO8601 本地时区 + 原始 epoch
    const now = Date.now()
    return out(JSON.stringify({ 收到: text, ...timeFields('at', now) }))
  })

  mcp.tool('harness_list_tools', '列出 Harness(宿主)自己注册的工具名清单。什么时候用: 想确认某个能力(如 bash/fs/web)在当前部署里是否可用, 或 agent_run 跑的 agent 抱怨没有某个工具时排查用的。返回一个字符串数组(纯名字, 无描述)。注意这是 Harness 内部工具, 与本插件的 26 个 MCP 工具是两回事。', {}, async () => {
    const tools = ctx.tools as unknown as { keys?: () => Iterable<string> } | null
    const names = tools && typeof tools.keys === 'function' ? Array.from(tools.keys()) : []
    return out(JSON.stringify(names))
  })

  mcp.tool('status_get', '看服务器现在活着吗、在用什么模型、有没有卡住的活。什么时候用: ① 调工具前先确认 server 健康 ② agent_run 长时间没返回时查 queueActive/activeSessionsCount 看是不是真在忙 ③ 想知道有没有待审的权限申请(pendingApprovals>0 就去 approval_list)。返回 {version,uptimeSec,uptime,startedAt(ISO8601),startedAt_epoch,provider,model,preset,activeSessionsCount,agentsLive,queueActive,sandboxPolicy:{defaultMode,bridge,pendingApprovals},notify:{enabled,deliveredTotal,failedTotal},node,pid}。', {}, async () => {
    let queueActive = 0
    for (const t of taskQueue.values()) if (t.status === 'queued' || t.status === 'running') queueActive++
    let agentsLive = 0
    try {
      agentsLive = ctx.agents.list().length
    } catch {
      agentsLive = 0
    }
    // [P0 回调] 回调投递汇总(仅统计配置了 callback 的任务; deliveredTotal/failedTotal 为运行期累计)
    let deliveredTotal = 0
    let failedTotal = 0
    for (const t of taskQueue.values()) {
      if (t.notify?.state === 'delivered') deliveredTotal++
      else if (t.notify?.state === 'failed') failedTotal++
    }
    const uptimeMs = Math.round(process.uptime() * 1000)
    return out(JSON.stringify({
      version: PLUGIN_VERSION,
      uptimeSec: Math.round(process.uptime()),
      // [r3] A: 时长带人类可读形态(原始秒仍在 uptimeSec)
      uptime: formatDuration(uptimeMs),
      ...timeFields('startedAt', serverRuntime.startedAt),
      provider: runtimeConfig.provider,
      model: runtimeConfig.model || '(follow dsh default)',
      preset: runtimeConfig.preset,
      activeSessionsCount: liveAgents.size,
      agentsLive,
      queueActive,
      // P3: 权限三档与审批桥状态暴露
      sandboxPolicy: {
        defaultMode: runtimeConfig.defaultSandbox,
        bridge: activeBridgeKind,
        pendingApprovals: pendingApprovals.size,
      },
      // [P0 回调] 任务终态主动回调运行态(全局开关 + 投递累计; 细节看 task_result/task_list 的 notify)
      notify: {
        enabled: runtimeConfig.notifyEnabled !== false,
        deliveredTotal,
        failedTotal,
        // [r1] B3-B8: 部署级回调预设是否生效(只回显结构, 绝不回显 secret/header 值)
        callbackPresetConfigured: runtimeConfig.callbackPreset?.url !== undefined,
      },
      // [r1] C1/C2: session_search 实际后端(如实上报, 让部署方能看出官方索引没生效及原因)
      sessionSearch: {
        backend: sessionSearchBackend,
        ...(sessionSearchFallbackReason !== undefined ? { fallbackReason: sessionSearchFallbackReason } : {}),
      },
      node: process.version,
      pid: process.pid,
    }, null, 2))
  })

  mcp.tool('config_get', '看这个插件是怎么被配置的(排查"为什么默认落到某个目录/为什么没权限"用)。什么时候用: ① agent_run 不传 cwd 时想知道默认工作目录是什么(看 workspaceRoots) ② 想知道默认权限档(defaultSandbox)或审批桥形态(approvalsBridge) ③ 确认 authToken 是否已开启(只回显是否设置, 不泄露值)。返回 {version,http,server:{port,host},provider,model,preset,maxQueue,taskTtlMs,taskTtl,timeouts:{...人类可读},authTokenSet,workspaceRoots,enableFsWrite,defaultSandbox,approvalsBridge,approvalTimeoutMs,approvalFileDir}。与 status_get 的区别: 这里看"配置", status_get 看"运行态"。', {}, async () => {
    return out(JSON.stringify({
      version: PLUGIN_VERSION,
      http: true,
      server: { port: serverRuntime.port, host: serverRuntime.host },
      provider: runtimeConfig.provider,
      model: runtimeConfig.model || '(follow dsh default)',
      preset: runtimeConfig.preset,
      maxQueue: runtimeConfig.maxQueue,
      taskTtlMs: runtimeConfig.taskTtlMs,
      maxAgents: runtimeConfig.maxAgents,
      // [r3] A: 时长类配置附人类可读形态(原始毫秒仍在 *_Ms 字段)
      taskTtl: formatDuration(runtimeConfig.taskTtlMs),
      approvalTimeout: formatDuration(runtimeConfig.approvalTimeoutMs),
      // [r3] A: 内部实现细节(authToken 打码回显)收敛为单一 authTokenSet, 不再回显占位串
      authTokenSet: Boolean(runtimeConfig.authToken),
      workspaceRoots: runtimeConfig.workspaceRoots,
      enableFsWrite: runtimeConfig.enableFsWrite,
      // P3: 权限三档 + 审批桥配置摘要
      defaultSandbox: runtimeConfig.defaultSandbox,
      approvalsBridge: runtimeConfig.approvalsBridge,
      approvalTimeoutMs: runtimeConfig.approvalTimeoutMs,
      approvalFileDir: runtimeConfig.approvalFileDir,
      // [P0 回调] 回调通道配置摘要(secret 只回显是否配置, 不泄露值)
      notify: {
        enabled: runtimeConfig.notifyEnabled !== false,
        defaultCallbackSecretSet: Boolean(runtimeConfig.defaultCallbackSecret),
        allowedCallbackHosts: runtimeConfig.allowedCallbackHosts,
        // [r1] B3-B8: 部署级回调预设摘要 —— 只回显结构与头名, 绝不回显 secret / header 值
        callbackPreset: describeCallbackPreset(),
      },
      // [r1] C1/C2: session_search 后端(如实上报索引是否生效及回退原因)
      sessionSearch: {
        backend: sessionSearchBackend,
        ...(sessionSearchFallbackReason !== undefined ? { fallbackReason: sessionSearchFallbackReason } : {}),
      },
    }, null, 2))
  })

  // ── P0: 文件查看(fs_read / fs_list / fs_stat) — 路径安全: ~/.dsh + 工作区白名单, 拒绝敏感名 ──
  mcp.tool(
    'fs_read',
    '直接读服务器上的文本文件(不用起 agent, 快且免费)。什么时候用: 想确认某个文件现在的内容/某行代码在不在, 又不想为一个只读操作付一次 agent_run 的代价。适合看配置、日志尾部、源码片段。限制: 只能读 ~/.dsh 与已注册工作区白名单内的路径, 且 .ssh/.env/*token*/*.pem 一律拒绝; 单文件 >8MB 拒绝。返回 {path,totalLines,offset,limit,truncated,content}; 文件大就配合 offset/limit 分段读。要看目录列表用 fs_list, 要只看元数据用 fs_stat, 要改文件用 fs_write(需部署开启)。',
    {
      path: z.string().describe('文件绝对路径(会 realpath 规范化)'),
      offset: z.number().int().min(1).optional().describe('起始行(1-based, 默认 1); 接着上次读完的位置继续读就靠它'),
      limit: z.number().int().min(1).max(2000).optional().describe('最多返回行数(默认 400, 最大 2000); content 另有 48KB 上限'),
    },
    async ({ path, offset, limit }) => {
      try {
        // [r3] C8: 入口参数预校验(类型/必填), 早于任何路径解析
        const bad = validateArgs('fs_read', { path, offset, limit }, [
          { name: 'path', type: 'string', required: true },
          { name: 'offset', type: 'number' }, { name: 'limit', type: 'number' },
        ])
        if (bad) return out(JSON.stringify({ error: bad }))
        const gate = await gateFsPath(ctx, path)
        if (gate.error) return out(JSON.stringify({ error: `${gate.error} (改用工作区内的路径, 或先用 fs_list 确认可访问的目录)` }))
        const canonical = gate.canonical as string
        const st = await stat(canonical).catch(() => undefined)
        if (!st) return out(JSON.stringify({ error: errText('path not found', path, 'realpath 解析后文件不存在', '确认路径拼写; 用 fs_list 看父目录里有什么') }))
        if (st.isDirectory()) return out(JSON.stringify({ error: errText('is a directory, use fs_list', canonical, '目标是个目录而不是文件', '改用 fs_list(path=...) 列目录, 或补上文件名') }))
        if (st.size > FS_READ_MAX_FILE_BYTES) return out(JSON.stringify({ error: errText('file too large', formatBytes(st.size) ?? String(st.size), `超过单文件上限 ${formatBytes(FS_READ_MAX_FILE_BYTES)}`, `用 offset/limit 分段读, 或改用 session_log/bash 侧手段`) }))
        const rawAll = await readFile(canonical, 'utf8')
        const lines = rawAll.split('\n')
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop() // 结尾换行不算一行
        const totalLines = lines.length
        const off = Math.max(1, Math.trunc(offset ?? 1))
        const lim = Math.min(Math.max(1, Math.trunc(limit ?? 400)), 2000)
        let content = lines.slice(off - 1, off - 1 + lim).join('\n')
        let truncated = off - 1 + lim < totalLines
        if (content.length > FS_READ_MAX_CHARS) {
          content = content.slice(0, FS_READ_MAX_CHARS)
          truncated = true
        }
        return out(JSON.stringify({
          path: canonical, totalLines, offset: off, limit: lim, truncated, content,
          // [r3] A2/A3: 人类可读大小 + 原始字节数保留
          size: formatBytes(st.size), size_bytes: st.size,
          ...timeFields('modifiedAt', st.mtimeMs),
          // [r2] A: 被截断时直接告诉 agent 下一次该传什么
          ...(truncated ? { next: `文件共 ${totalLines} 行, 本次返回第 ${off}~${Math.min(off + lim - 1, totalLines)} 行; 继续读请传 offset=${off + lim}` } : {}),
        }))
      } catch (e) {
        return out(JSON.stringify({ error: toolFailure('fs_read', e) }))
      }
    },
  )

  mcp.tool(
    'fs_list',
    '列服务器上的目录内容(不用起 agent)。什么时候用: ① 不知道项目文件都在哪, 先看一眼 ② fs_read 报 path not found 时确认父目录里到底有什么 ③ 找某个文件的全路径、或确认 agent 刚才把文件写到哪了。depth 可递归(默认 1 层, 最大 5)。敏感项(.ssh/.env/*token*/*.pem)会从结果里隐藏。返回 {path,depth,count,total,truncated,offset,limit,next?,entries:[{name,type,size,size_bytes,mtime(ISO8601),mtime_epoch}]}(type=dir|file|symlink|other; 默认最多 1000 条, 超限时用 offset/limit 翻页)。拿到文件路径后用 fs_read 读内容。',
    {
      path: z.string().describe('目录绝对路径(必须是目录; 传文件会报错)'),
      depth: z.number().int().min(1).max(5).optional().describe('递归层数(默认 1 只看本层, 最大 5)'),
      ...pageArgSchema,
    },
    async ({ path, depth, offset, limit }) => {
      try {
        // [r3] C8: 入口参数预校验
        const bad = validateArgs('fs_list', { path, depth, offset, limit }, [
          { name: 'path', type: 'string', required: true },
          { name: 'depth', type: 'number' }, { name: 'offset', type: 'number' }, { name: 'limit', type: 'number' },
        ])
        if (bad) return out(JSON.stringify({ error: bad }))
        const gate = await gateFsPath(ctx, path)
        if (gate.error) return out(JSON.stringify({ error: `${gate.error} (改用工作区内的目录; 不知道工作区在哪可以看 config_get 的 workspaceRoots)` }))
        const root = gate.canonical as string
        const maxDepth = Math.min(Math.max(1, Math.trunc(depth ?? 1)), 5)
        const entries: { name: string; type: string; size?: string; size_bytes?: number; mtime?: string; mtime_epoch?: number }[] = []
        let truncated = false
        const walk = async (dir: string, level: number): Promise<void> => {
          if (truncated) return
          let dirents
          try {
            dirents = await readdir(dir, { withFileTypes: true })
          } catch {
            return
          }
          dirents.sort((a, b) => a.name.localeCompare(b.name))
          for (const de of dirents) {
            if (entries.length >= FS_LIST_MAX_ENTRIES) {
              truncated = true
              return
            }
            const full = joinPath(dir, de.name)
            // 敏感项从列表隐藏(与 fs_read 拒绝策略一致)
            if (isSensitivePath(full)) continue
            const type = de.isDirectory() ? 'dir' : de.isSymbolicLink() ? 'symlink' : de.isFile() ? 'file' : 'other'
            let size: string | undefined
            let sizeBytes: number | undefined
            let mtime: string | undefined
            let mtimeEpoch: number | undefined
            try {
              const s = await stat(full)
              sizeBytes = s.size
              // [r3] A2/A3: 大小格式化(原始值保留在 size_bytes); mtime 转 ISO8601(原始值保留在 mtime_epoch)
              size = formatBytes(s.size)
              const h = humanTime(s.mtimeMs)
              mtime = h?.at
              mtimeEpoch = h?.at_epoch
            } catch { /* 断链等: size/mtime 缺省 */ }
            entries.push({ name: full.slice(root.length + 1) || de.name, type, size, size_bytes: sizeBytes, mtime, mtime_epoch: mtimeEpoch })
            if (de.isDirectory() && level < maxDepth) await walk(full, level + 1)
          }
        }
        await walk(root, 1)
        // [r3] A1: 列表类返回统一分页信封(超 20 条默认截断 + total/truncated/next)
        const { offset: off, limit: lim } = parsePage(offset, limit, FS_LIST_MAX_ENTRIES)
        const { page, meta } = pageEnvelope(entries, off, lim, 'fs_list')
        // 硬上限截断(walk 提前退出)与分页截断都给出 next 提示
        const nextHint = meta.next ?? (truncated ? `目录条目达到上限 ${FS_LIST_MAX_ENTRIES} 条已截断; 缩小 depth 或改列子目录` : undefined)
        return out(JSON.stringify({
          path: root, depth: maxDepth,
          count: page.length,
          total: meta.total,
          offset: meta.offset,
          limit: meta.limit,
          truncated: meta.truncated || truncated,
          ...(nextHint !== undefined ? { next: nextHint } : {}),
          entries: page,
        }))
      } catch (e) {
        return out(JSON.stringify({ error: toolFailure('fs_list', e) }))
      }
    },
  )

  mcp.tool(
    'fs_stat',
    '只查文件/目录的元数据, 不读内容(判断"这个文件存在吗/多大/什么时候改的")。什么时候用: ① fs_read 之前先探一下文件在不在、多大, 避免浪费一次大读取 ② 比较两个文件的 mtime 看谁更新 ③ 确认某个路径是文件还是目录 ④ 确认 agent 是否真的把文件写到了某个落点。与 fs_read 的区别: 这个几乎零成本, 且不存在的路径也返回 exists:false 而不是报错。返回 {exists,path,size(如 9.4KB),size_bytes,mtime(ISO8601),mtime_epoch,isDir,isFile}(不存在时只有 exists:false 和 path)。',
    { path: z.string().describe('绝对路径(可以不存在 —— 不存在返回 exists:false 而非报错)') },
    async ({ path }) => {
      try {
        // [r3] C8: 入口参数预校验
        const bad = validateArgs('fs_stat', { path }, [{ name: 'path', type: 'string', required: true }])
        if (bad) return out(JSON.stringify({ error: bad }))
        const gate = await gateFsPathSoft(ctx, path)
        if (gate.error) return out(JSON.stringify({ error: `${gate.error} (该路径被安全策略拒绝; 换到工作区内的路径再试)` }))
        if (gate.missing) return out(JSON.stringify({ exists: false, path: gate.canonical }))
        const canonical = gate.canonical as string
        const st = await stat(canonical).catch(() => undefined)
        if (!st) return out(JSON.stringify({ exists: false, path: canonical }))
        return out(JSON.stringify({
          exists: true,
          path: canonical,
          // [r3] A2/A3: 大小/时间人类可读 + 原始值
          size: formatBytes(st.size), size_bytes: st.size,
          ...timeFields('mtime', st.mtimeMs),
          isDir: st.isDirectory(),
          isFile: st.isFile(),
        }))
      } catch (e) {
        return out(JSON.stringify({ error: `${toolFailure('fs_stat', e)} (路径可能在白名单外; 用 config_get 查 workspaceRoots)` }))
      }
    },
  )

  // ── P1: fs_write(opt-in) — 默认不注册; 打开后仅限 workspaceRoots 内 + 敏感名拒绝 ──
  if (runtimeConfig.enableFsWrite) {
    mcp.tool(
      'fs_write',
      '直接写文本文件(需部署方开启 enableFsWrite; 未开启时本工具不可见)。什么时候用: 确定要落一个已知内容的文件, 且不想为一次简单写入付 agent_run 的代价(如写临时脚本、落配置、追加日志)。若需要 agent 自己判断该改什么, 请用 agent_run/task_inbox。限制: 只能在 workspaceRoots 白名单内(路径 jail), .ssh/.env/*token*/*.pem 一律拒绝, 单次内容 ≤4MB, 父目录会自动创建。返回 {ok,path,bytes(如 9.4KB),bytes_raw,mode}。改完想核对用 fs_read 读回。',
      {
        path: z.string().describe('文件绝对路径(可以不存在, 父目录自动创建; 必须在 workspaceRoots 内)'),
        content: z.string().describe('要写入的 UTF-8 文本(上限 4MB)'),
        mode: z.enum(['overwrite', 'append', 'create-new']).optional().describe('写入模式(默认 overwrite 全量覆盖; append 追加到末尾; create-new 在文件已存在时报错, 用于防误覆盖)'),
      },
      async ({ path, content, mode }) => {
        try {
          // [r3] C8: 入口参数预校验
          const bad = validateArgs('fs_write', { path, content, mode }, [
            { name: 'path', type: 'string', required: true },
            { name: 'content', type: 'string', required: true },
            { name: 'mode', type: 'string' },
          ])
          if (bad) return out(JSON.stringify({ error: bad }))
          const m = mode ?? 'overwrite'
          const bytes = Buffer.byteLength(content, 'utf8')
          if (bytes > FS_WRITE_MAX_BYTES) {
            return out(JSON.stringify({ error: errText('content too large', formatBytes(bytes) ?? String(bytes), `超过单次上限 ${formatBytes(FS_WRITE_MAX_BYTES)}`, '拆成多次 mode=append 写入') }))
          }
          const gate = await gateFsWritePath(path)
          if (gate.error) return out(JSON.stringify({ error: `${gate.error} (fs_write 只能写 workspaceRoots 内的路径; 用 config_get 查看允许的目录)` }))
          const canonical = gate.canonical as string
          if (m === 'create-new') {
            const exists = await stat(canonical).then(() => true, () => false)
            if (exists) return out(JSON.stringify({ error: errText('file already exists', canonical, 'mode=create-new 但目标已存在', '改用 mode=overwrite 覆盖, 或 mode=append 追加, 或换个新路径') }))
          }
          await mkdir(dirname(canonical), { recursive: true })
          if (m === 'append') {
            await appendFile(canonical, content, 'utf8')
          } else {
            await writeFile(canonical, content, 'utf8')
          }
          // [r3] A3: 字节数人类可读(原始值保留在 bytes_raw)
          return out(JSON.stringify({ ok: true, path: canonical, bytes: formatBytes(bytes), bytes_raw: bytes, mode: m, next: `用 fs_read(path="${canonical}") 读回核对` }))
        } catch (e) {
          return out(JSON.stringify({ error: `${toolFailure('fs_write', e)} (确认父目录可写、路径在白名单内)` }))
        }
      },
    )
  }

  // ── P0: 会话管理(session_list / session_log) ──
  mcp.tool(
    'session_list',
    '【最先调用】列出所有会话(live+已持久化合并), 用来找会话 id / 标题 / 工作目录。要 messageCount/token 统计请传 detail:"full"(默认 brief 不读日志, 快; full 会逐行读日志补 messageCount/inputTokens/outputTokens/llmTime/sandboxMode, 较慢)。什么时候用: 不知道 sessionId、想续接某个历史会话(拿到 id 后传给 agent_run/task_inbox 的 sessionId)、或想知道最近在哪些目录干过活。不传 cwd = 列出全部(默认); 传 cwd = 只看该工作区。返回 {total,count,offset,limit,detail,truncated,skipped,skippedNoCwd?,source,detailHint?,next?,sessions:[...]}; brief 行含 {id,title,cwd,createdAt*,updatedAt*,tokensAvailable:false,sizeBytes?,live}, full 行改为含 {messageCount,inputTokens,outputTokens,llmTime,llmTimeHuman,sandboxMode?}(默认最多 20 条, 按 updatedAt 倒序; 超 20 条用 offset/limit 翻页)。skipped=读取失败被跳过的会话数; skippedNoCwd=header 缺 cwd 未参与过滤的会话数(单行失败不影响整表)。拿到 id 后: 看对话用 session_log(sessionId=...), 续接干活用 agent_run(sessionId=...)。',
    {
      cwd: z.string().optional().describe('按工作目录过滤(realpath 规范化后精确匹配); 不传=全部会话'),
      limit: z.number().int().min(1).max(SESSION_LIST_MAX_ROWS).optional().describe('本页最多返回条数(默认 20, 最大 50)'),
      offset: pageArgSchema.offset,
      detail: z.enum(['brief', 'full']).optional().describe('返回详略(默认 brief)。brief=只回 header + 免费字段(id/title/cwd/createdAt/updatedAt/sizeBytes), 快; full=额外逐行读日志补 messageCount/inputTokens/outputTokens/llmTime/sandboxMode, 慢且受单会话超时限制'),
    },
    async ({ cwd, limit, offset, detail }) => {
      try {
        // [r3] C8: 入口参数预校验
        const bad = validateArgs('session_list', { cwd, limit, offset, detail }, [
          { name: 'cwd', type: 'string' }, { name: 'limit', type: 'number' }, { name: 'offset', type: 'number' },
          { name: 'detail', type: 'string' },
        ])
        if (bad) return out(JSON.stringify({ error: bad }))
        const { offset: off, limit: lim } = parsePage(offset, limit, 20)
        const max = Math.min(Math.max(1, lim), SESSION_LIST_MAX_ROWS)
        // [r1] A1/A3: 一次拿全量 header + 免费排序键(替代 listMergedHeaders + 逐条 roughUpdatedAt
        // → stat() O(树), 实测 9.3s/197 会话)。sessionQuery 探测不到时自动回退 persistence 路径。
        const { rows: corpus, skipped: mergeSkipped, skippedNoCwd, source } = await listCorpus(ctx)
        let rows = corpus
        // cwd 过滤: 双侧 realpath 规范化后精确比对(保持 [r2] 实现, 已被 28/27/46 三个数字验证)
        if (cwd) {
          const target = await canonicalCwd(resolve(cwd))
          const filtered: CorpusRow[] = []
          for (const r of rows) {
            if (r.header.cwd === undefined) continue
            if (await canonicalCwd(r.header.cwd) === target) filtered.push(r)
          }
          rows = filtered
        }
        // [r3] C7: 过滤后一个会话都没有 → 统一"会话为空"文案(而不是返回空数组让 agent 猜)
        if (rows.length === 0) {
          return out(JSON.stringify({
            error: cwd
              ? errText('session is empty', cwd, '该工作目录下没有任何会话', '去掉 cwd 参数列出全部会话, 或先用 agent_run(cwd=...) 在该目录建一个会话')
              : errText('session is empty', '(all)', '当前 live 与持久化里都没有会话', '先用 agent_run 或 task_inbox 跑一个任务即可建会话'),
            // [r1] D2: cwd 缺失被跳过的行数(旧实现静默跳过, 会让"空"被误诊)
            ...(skippedNoCwd > 0 ? { skippedNoCwd } : {}),
          }))
        }
        // [r1] 排序键已是免费字段(listCorpus 内完成: live 末事件 time > 盘上 mtime > createdAt)
        rows.sort((a, b) => b.updatedAt - a.updatedAt)
        // [r3] A1: 先分页(offset/limit)再逐行检视, 避免为被截断的行白读大日志
        const selected = rows.slice(off, off + max)
        let skipped = mergeSkipped
        const sessions: Record<string, unknown>[] = []
        // [r1] B1(D1 裁决): 默认 brief —— 完全不读事件流, 只回免费字段;
        // full 才逐行 inspectSessionRow(并发 4 + 单会话 3s 超时, 见 SESSION_LIST_INSPECT_CONCURRENCY)
        if (detail === 'full') {
          const detailById = await inspectRowsConcurrent(ctx, selected, () => { skipped++ })
          for (const r of selected) {
            const h = r.header
            const d = detailById.get(String(h.id))
            if (d === undefined) { skipped++; continue }
            sessions.push({
              id: h.id,
              title: d.title ?? `(untitled ${String(h.id).slice(0, 8)})`,
              cwd: h.cwd,
              // [r3] A2: 时间戳人类可读 ISO8601 + 原始 epoch
              ...timeFields('createdAt', h.createdAt),
              ...timeFields('updatedAt', r.updatedAt),
              messageCount: d.messageCount,
              // P1: 统计摘要(全会话累计)
              inputTokens: d.inputTokens ?? 0,
              outputTokens: d.outputTokens ?? 0,
              llmTime: d.llmTimeSec ?? 0,
              llmTimeHuman: formatDuration((d.llmTimeSec ?? 0) * 1000),
              // P3: 会话生效权限档(有 sandbox/mode 记录才带此字段)
              ...(d.sandboxMode !== undefined ? { sandboxMode: d.sandboxMode } : {}),
            })
          }
        } else {
          for (const r of selected) {
            const h = r.header
            sessions.push({
              id: h.id,
              title: `(untitled ${String(h.id).slice(0, 8)})`,
              cwd: h.cwd,
              ...timeFields('createdAt', h.createdAt),
              ...timeFields('updatedAt', r.updatedAt),
              // brief 不读事件流 → 明确告知 token/messageCount 不可用(不伪造 0)
              tokensAvailable: false,
              ...(r.sizeBytes !== undefined ? { sizeBytes: r.sizeBytes } : {}),
              live: r.live,
            })
          }
        }
        const hasMore = off + selected.length < rows.length
        return out(JSON.stringify({
          total: rows.length,
          count: sessions.length,
          offset: off,
          limit: max,
          detail: detail ?? 'brief',
          truncated: hasMore,
          // [r2] 自解释字段: 有多少会话因单行容错被跳过(0 = 全部正常)
          skipped,
          // [r1] D2: cwd 缺失未参与过滤的行数; [r1] A1: 实际数据源(sessionQuery=0.1.7 官方快路径)
          ...(skippedNoCwd > 0 ? { skippedNoCwd } : {}),
          source,
          // [r1] B1: brief 下提示如何拿到 token 统计
          ...(detail !== 'full' ? { detailHint: "messageCount/inputTokens/outputTokens/llmTime/sandboxMode 需 detail:'full'(会逐行读日志, 较慢)" } : {}),
          // [r3] A1: 截断时明示翻页参数
          ...(hasMore ? { next: `共 ${rows.length} 个会话, 本页 ${sessions.length} 个; 取下一页请传 offset=${off + selected.length}` } : {}),
          sessions,
        }))
      } catch (e) {
        return out(JSON.stringify({ error: `${toolFailure('session_list', e)} (若持续失败, 先用 cwd 过滤缩小范围, 或改用 session_search 按关键词找会话)` }))
      }
    },
  )

  mcp.tool(
    'session_log',
    '读某个会话的对话/工具调用记录(已剥离 thinking/reasoning 推理块)。什么时候用: 拿到了 sessionId(session_list 或 agent_run 返回)想复盘这次到底说了什么/调了什么工具/为什么失败, 或者 agent_run 结果里的 changes/verification 不够、要看原始过程。返回 {sessionId,header:{cwd,createdAt(ISO8601),createdAt_epoch,preset},types,totalMatched,shown,truncated,next?,events:[{seq,type,time(ISO8601),time_epoch,...}]}——events 按时间正序; 默认最多 50 条事件, 超过则返回首尾各若干条并置 truncated:true(提示如何翻页取更多)。不想挑类型就用 preset=「dialog」(只看人机对话)或「tools」(只看工具调用); 要精确控制再用 types。',
    {
      sessionId: z.string().describe('会话 id(session_list 的 sessions[].id 或 agent_run 结果里的 sessionId)'),
      tail: z.number().int().min(1).max(500).optional().describe('只取最后 N 条匹配事件(默认 50, 最大 500); 想看更早的调大这个值'),
      head: z.number().int().min(0).max(200).optional().describe('截断时额外保留的最旧 N 条事件(默认 5, 用于同时看到会话开头); 只要最新就传 0'),
      // [r2] B: 常用预设, 免去让 agent 自己拼 types 数组
      preset: z.enum(['dialog', 'tools', 'all']).optional().describe('常用预设(免拼 types): dialog=只看人机对话(user/message+assistant/message, 最常用); tools=只看工具调用与结果(tool/call+tool/result); all=全部事件类型。不传=默认 dialog+tools 混合'),
      types: z.array(z.string()).optional().describe('精确事件类型过滤(优先级高于 preset); 默认 [user/message, assistant/message, tool/call, tool/result]'),
    },
    async ({ sessionId, tail, preset, types, head }) => {
      try {
        // [r3] C8: 入口参数预校验
        const bad = validateArgs('session_log', { sessionId, tail, head, types }, [
          { name: 'sessionId', type: 'string', required: true },
          { name: 'tail', type: 'number' }, { name: 'head', type: 'number' }, { name: 'types', type: 'array' },
        ])
        if (bad) return out(JSON.stringify({ error: bad }))
        const sid = SessionId(sessionId)
        let meta: SessionHeader | undefined
        let events: unknown[] = []
        // persisted 优先([r2] 0.1.2 inspect / 0.1.5 open+read; 对 live 会话也会给出当前不可变快照)
        try {
          const insp = await persistedInspect(ctx, sid)
          if (insp) {
            meta = insp.meta
            events = insp.events
          }
        } catch { /* 未持久化 → 回退 live */ }
        if (events.length === 0) {
          const store = ctx.get('sessions') as SessionsStoreView | undefined
          const live = store?.get?.(sid) as { header?: SessionHeader; log?: unknown[] } | undefined
          if (live) {
            meta = live.header ?? meta
            events = live.log ?? []
          }
        }
        if (meta === undefined && events.length === 0) {
          return out(JSON.stringify({ error: sessionNotFoundError(sessionId) }))
        }
        // [r3] C7: 会话存在但一条事件都没有 → 统一"会话为空"文案
        if (events.length === 0) {
          return out(JSON.stringify({ error: emptySessionError(sessionId) }))
        }
        // [r2] B: preset 快捷值 → types 预设(显式 types 优先, 再 preset, 最后默认)
        const PRESET_TYPES: Record<string, string[]> = {
          dialog: ['user/message', 'assistant/message'],
          tools: ['tool/call', 'tool/result'],
        }
        const wanted = types && types.length > 0
          ? types
          : preset === 'all'
            ? [] // 空数组 = 不过滤(见下方 filtered 分支)
            : (preset ? PRESET_TYPES[preset] : undefined) ?? DEFAULT_LOG_TYPES
        const filtered = wanted.length === 0 ? events : events.filter((e) => wanted.includes((e as { type?: string })?.type ?? ''))
        const totalMatched = filtered.length
        // [r3] A1: 默认只取最后 50 条(硬上限 500) —— 降低 agent 上下文负担
        const n = Math.min(Math.max(1, Math.trunc(tail ?? SESSION_LOG_MAX_EVENTS)), 500)
        const headN = Math.min(Math.max(0, Math.trunc(head ?? SESSION_LOG_HEAD_EVENTS)), 200)
        const overCap = totalMatched > n
        // 超限: 保留首 headN 条 + 末尾 (n - headN) 条, 中间省略
        const sliced = overCap && headN > 0
          ? [...filtered.slice(0, headN), ...filtered.slice(-(n - headN))]
          : filtered.slice(-n)
        // 全局字节上限: 超限丢弃最旧并置 truncated
        const records: Record<string, unknown>[] = []
        let budget = SESSION_LOG_MAX_CHARS
        for (let i = sliced.length - 1; i >= 0; i--) {
          const rec = compactLogEvent(sliced[i])
          const cost = JSON.stringify(rec)?.length ?? 0
          if (cost > budget) break
          budget -= cost
          records.unshift(rec)
        }
        const shown = records.length
        const omitted = totalMatched - shown
        const truncated = shown < sliced.length || overCap
        return out(JSON.stringify({
          sessionId,
          header: meta
            ? { cwd: meta.cwd, ...timeFields('createdAt', meta.createdAt), preset: presetFromEvents(meta, events) }
            : undefined,
          // [r2] B: 回显生效的过滤口径(preset 生效时 types 是展开后的结果), 便于 agent 确认拿到的是哪一档
          ...(preset !== undefined ? { preset } : {}),
          types: wanted,
          totalMatched,
          shown,
          truncated,
          // [r3] A1: 截断时返回首尾 + 明确"如何取更多"(默认 50 条上限)
          ...(truncated
            ? {
                omitted,
                order: overCap && headN > 0 ? `head(${Math.min(headN, shown)}) + tail(${shown - Math.min(headN, shown)})` : 'tail',
                next: `默认最多返回 ${SESSION_LOG_MAX_EVENTS} 条事件, 本次命中 ${totalMatched} 条(省略 ${omitted} 条); 取更多请调大 tail(最大 500)、传 head=0 只看最新、或用 preset/types 缩小范围`,
              }
            : {}),
          events: records,
        }))
      } catch (e) {
        return out(JSON.stringify({ error: `${toolFailure('session_log', e)} (确认 sessionId 是否正确: 用 session_list 查看; 该会话可能已被清理)` }))
      }
    },
  )

  // ── P1: 会话统计(session_stats) ──
  mcp.tool(
    'session_stats',
    '看一个会话的用量与性能统计(不读内容, 只看数)。什么时候用: ① 想知道刚才那次 agent_run 花了多少 token / 多久 ② 对比不同 preset 或不同任务的效率 ③ 排查"怎么这么慢"(看 ttft/toolTime/cacheHitRate 哪块占大头)。不传 sessionId = 最近一次 agent_run/task_inbox 的会话(最常用); 传 sessionId = 指定会话的全会话累计。返回 {rounds,steps,llmTime,toolTime,ttft,tokensPerSec,cacheHitRate,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens,source}(时间是秒)。想看具体发生了什么用 session_log。',
    { sessionId: z.string().optional().describe('会话 id(缺省 = 最近一次 agent_run/task_inbox 的会话; 也可传 session_list 里的任意 id)') },
    async ({ sessionId }) => {
      try {
        // [r3] C8: 入口参数预校验
        const bad = validateArgs('session_stats', { sessionId }, [{ name: 'sessionId', type: 'string' }])
        if (bad) return out(JSON.stringify({ error: bad }))
        let target = sessionId
        let source: string | undefined
        if (!target) {
          if (lastAgentSessionId === undefined) {
            // [r3] C7: 统一"会话为空"文案(本进程还没跑过任何任务)
            return out(JSON.stringify({ error: errText('session is empty', '(last agent session)', '本进程还没有跑过任何任务, 拿不到"最近会话"', '先调 agent_run 或 task_inbox, 或显式传 sessionId —— 会话 id 可从 session_list 拿') }))
          }
          target = lastAgentSessionId
        }
        const found = await collectSessionEvents(ctx, SessionId(target))
        if (found === undefined) {
          return out(JSON.stringify({ error: sessionNotFoundError(target) }))
        }
        // [r3] C7: 会话存在但无事件 → 统一"会话为空"文案
        if (found.events.length === 0) {
          return out(JSON.stringify({ error: emptySessionError(target) }))
        }
        source = found.source
        const stats = presentSessionStats(foldSessionStats(found.events), { scope: 'session', sessionId: target })
        return out(JSON.stringify({ ...stats, source, next: HINT.resumeSession }, null, 2))
      } catch (e) {
        return out(JSON.stringify({ error: toolFailure('session_stats', e) }))
      }
    },
  )

  // ── P2: 跨会话搜索(session_search) ──
  mcp.tool(
    'session_search',
    '不记得 sessionId, 只记得聊过什么 —— 按关键词跨会话找。什么时候用: ① 想找回"上次讨论 X 的那个会话" ② 确认某个决定/方案在历史会话里出现过没有 ③ session_list 条目太多翻不过来。先匹配标题, 未命中再尽力扫内容(每会话 2s 超时, 跳过慢的)。返回 {query,regex,total,count,offset,limit,truncated,next?,content_search,results:[{sessionId,title,cwd,updatedAt(ISO8601),updatedAt_epoch,matched 为 title 或 content,snippet?}]}(默认最多 20 条, 按 updatedAt 倒序; 超 20 条用 offset/limit 翻页)。找到 sessionId 后用 session_log 看细节、或 agent_run(sessionId=...) 续接。注意: 内容匹配是"尽力而为", content_search=false 说明本次只搜了标题。',
    {
      query: z.string().min(1).describe('搜索词(默认大小写不敏感子串; regex=true 时按正则)'),
      cwd: z.string().optional().describe('只搜这个工作目录下的会话(realpath 精确匹配); 不传=全部'),
      regex: z.boolean().optional().describe('把 query 当正则解释(默认 false 当普通子串)'),
      limit: z.number().int().min(1).max(200).optional().describe('最多扫描最近 N 个会话(默认 50, 最大 200; 调大更全但更慢)'),
      offset: pageArgSchema.offset,
      pageSize: z.number().int().min(1).max(LIST_PAGE_MAX).optional().describe(`本页最多返回条数(默认 ${LIST_PAGE_DEFAULT}, 最大 ${LIST_PAGE_MAX})`),
    },
    async ({ query, cwd, regex, limit, offset, pageSize }) => {
      try {
        // [r3] C8: 入口参数预校验(必填/类型)
        const bad = validateArgs('session_search', { query, cwd, regex, limit, offset, pageSize }, [
          { name: 'query', type: 'string', required: true },
          { name: 'cwd', type: 'string' }, { name: 'regex', type: 'boolean' },
          { name: 'limit', type: 'number' }, { name: 'offset', type: 'number' }, { name: 'pageSize', type: 'number' },
        ])
        if (bad) return out(JSON.stringify({ error: bad }))
        // [r3] C7+C8: 空白 query 走统一句式, 但保留 `query must not be empty` 前缀(R2 契约)
        if (!query || !query.trim()) return out(JSON.stringify({ error: errText('query must not be empty', '(blank)', 'search 需要一个非空关键词', '传一个要搜的关键词后重试; 不知道搜什么可以先 session_list') }))
        let re: RegExp | undefined
        if (regex) {
          try {
            re = new RegExp(query)
          } catch (e) {
            return out(JSON.stringify({ error: errText('invalid regex', query, (e as Error)?.message ?? String(e), '改写成合法正则, 或设 regex=false 按普通文本搜') }))
          }
        }
        const needle = query.toLowerCase()
        const maxScan = Math.min(Math.max(1, Math.trunc(limit ?? 50)), 200)
        // [r1] C1/C2: 优先尝试官方索引搜索(ctx.sessionQuery.searchSessions)。
        // 本机默认 openAt:'never' → 抛 SESSION_QUERY_SEARCH_DISABLED; 且上游 locate() bug 会让
        // 186/198 会话抛 SESSION_QUERY_PERSISTENCE_FAILED(PLAN_r1 §1.5)。两种情况都必须**静默回退**,
        // 绝不把 SESSION_QUERY_* 错误抛给用户(裁决 D10)。

        let indexFallbackReason: string | undefined
        if (regex !== true) {
          const idxRes = await tryIndexSearch(ctx, { query, cwd, limit: maxScan })
          if (idxRes.hits) {
            // 索引命中 → 直接走同一套分页/返回体, backend 标记为 index
            sessionSearchBackend = 'index'
            const { offset: off2, limit: lim2 } = parsePage(offset, pageSize, LIST_PAGE_DEFAULT)
            const { page: page2, meta: meta2 } = pageEnvelope(idxRes.hits, off2, lim2, 'session_search')
            return out(JSON.stringify({
              query,
              regex: false,
              total: idxRes.hits.length,
              count: page2.length,
              offset: meta2.offset,
              limit: meta2.limit,
              truncated: meta2.truncated,
              matched: idxRes.hits.length,
              scanned: idxRes.hits.length,
              content_search: true,
              backend: 'index',
              ...(meta2.truncated ? { next: `共 ${idxRes.hits.length} 条命中, 本页 ${page2.length} 条; 取下一页请传 offset=${meta2.offset + page2.length}` } : {}),
              results: page2.map((r) => {
                const { updatedAt, ...rest } = r
                return { ...rest, ...timeFields('updatedAt', updatedAt) }
              }),
            }))
          }
          indexFallbackReason = idxRes.reason
        } else {
          indexFallbackReason = 'regex=true 需插件侧正则扫描, 索引后端不支持'
        }
        sessionSearchBackend = 'scan'
        sessionSearchFallbackReason = indexFallbackReason
        // [r1] C3: 排序键改用 listCorpus(免费), 不再逐条 roughUpdatedAt → stat() O(树) 全量
        const { rows: corpus, skippedNoCwd: searchSkippedNoCwd } = await listCorpus(ctx)
        let rows = corpus
        // cwd 过滤: 双侧 realpath 规范化后精确比对
        if (cwd) {
          const target = await canonicalCwd(resolve(cwd))
          const filtered: CorpusRow[] = []
          for (const r of rows) {
            if (r.header.cwd === undefined) continue
            if (await canonicalCwd(r.header.cwd) === target) filtered.push(r)
          }
          rows = filtered
        }
        // [r3] C7: 没有任何可搜的会话 → 统一"会话为空"文案
        if (rows.length === 0) {
          return out(JSON.stringify({
            error: cwd
              ? errText('session is empty', cwd, '该工作目录下没有可搜索的会话', '去掉 cwd 或换一个目录再搜; 用 session_list 看全部会话')
              : errText('session is empty', '(all)', '当前 live 与持久化里都没有会话', '先用 agent_run/task_inbox 建会话, 或用 session_list 确认服务状态'),
            ...(searchSkippedNoCwd > 0 ? { skippedNoCwd: searchSkippedNoCwd } : {}),
          }))
        }
        // 粗排(updatedAt desc)取最近 N 个扫描(排序键已在 listCorpus 内免费取得)
        rows.sort((a, b) => b.updatedAt - a.updatedAt)
        const scanned = rows.slice(0, maxScan)
        const scannedRows = scanned.map((r) => ({ h: r.header, at: r.updatedAt }))
        // 并发 8 消费; 单会话读取有 ~2s 时限, 最坏总耗时 ≈ ceil(N/8)*2s
        const hits: SessionSearchRow[] = []
        let contentSearched = false
        const queue = [...scannedRows]
        const worker = async (): Promise<void> => {
          for (;;) {
            const it = queue.shift()
            if (!it) return
            try {
              const r = await searchOneSession(ctx, it.h, Math.round(it.at), { re, needle, rawLen: query.length })
              if (r.contentSearched) contentSearched = true
              if (r.row) hits.push(r.row)
            } catch { /* 单会话失败不影响整体 */ }
          }
        }
        await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker))
        hits.sort((a, b) => b.updatedAt - a.updatedAt)
        // [r3] A1/A2: 统一分页 + 时间戳人类可读
        const { offset: off, limit: lim } = parsePage(offset, pageSize, LIST_PAGE_DEFAULT)
        const { page, meta } = pageEnvelope(hits, off, lim, 'session_search')
        return out(JSON.stringify({
          query,
          regex: Boolean(regex),
          total: scanned.length,
          count: page.length,
          offset: meta.offset,
          limit: meta.limit,
          truncated: meta.truncated,
          // [r3] A1: total=本次实际扫描的会话数(保持 R2 口径); matched=命中总数; scanned 为等价别名
          matched: hits.length,
          scanned: scanned.length,
          content_search: contentSearched,
          // [r1] C1/C2: 实际后端(scan=插件侧扫描; index=官方索引) + 回退原因(诊断用)
          backend: 'scan',
          ...(indexFallbackReason !== undefined ? { indexFallbackReason } : {}),
          ...(searchSkippedNoCwd > 0 ? { skippedNoCwd: searchSkippedNoCwd } : {}),
          results: page.map((r) => {
            const { updatedAt, ...rest } = r
            return { ...rest, ...timeFields('updatedAt', updatedAt) }
          }),
          // [r2] A + [r3] A1: 自解释下一步 —— 找到的 id 怎么用 / 怎么翻页 / 没找到怎么办
          ...(meta.next !== undefined ? { next: meta.next } : {}),
          hint: hits.length > 0
            ? '拿到 sessionId 后: 看细节用 session_log(sessionId=...), 续接干活用 agent_run(sessionId=...)'
            : `没有命中; 可尝试: 调大 limit(当前扫了最近 ${scanned.length} 个)、换更短的关键词、或设 regex=true 用正则; 全部会话列表用 session_list`,
        }, null, 2))
      } catch (e) {
        return out(JSON.stringify({ error: `${toolFailure('session_search', e)} (可去掉 regex 或缩小 cwd 再试; 单会话读取超时会被跳过, 属正常)` }))
      }
    },
  )

  // ── P0: preset(preset_list / preset_get) ──
  mcp.tool(
    'preset_list',
    '列出当前部署可用的 agent preset(能力组合模板)与默认项。什么时候用: ① 想给某类任务换个更合适的 preset(如编码用 code、最小工具集用 minimal), 先来这里查合法 id —— agent_run/task_inbox 的 preset 参数和 preset_set 都只认这里返回的 id ② 传 preset 报 unknown preset 后, 用这里拿 available 名单。返回 {source(agentPresets 或 builtin-fallback),default,presets:[{id,name,description,trust,broken}]}。选好 id 后: 单次任务用 agent_run(preset=...), 改默认用 preset_set(presetId=...)。',
    {},
    async () => {
      try {
        const svc = ctx.agentPresets as unknown as { list?: () => Promise<{ id: string; name?: string; description?: string; trust?: string; broken?: string }[]>; defaultId?: string } | undefined
        const discovered = await svc?.list?.()
        if (discovered && discovered.length > 0) {
          return out(JSON.stringify({
            source: 'agentPresets',
            default: svc?.defaultId ?? runtimeConfig.preset,
            presets: discovered.map((p) => ({ id: p.id, name: p.name ?? p.id, description: p.description ?? '', trust: p.trust, broken: p.broken })),
          }, null, 2))
        }
      } catch { /* 服务缺失 → 内置兜底名单 */ }
      return out(JSON.stringify({
        source: 'builtin-fallback',
        default: runtimeConfig.preset,
        presets: [
          { id: 'standard', name: 'standard', description: '通用全工具 preset' },
          { id: 'code', name: 'code', description: '编码向 preset' },
          { id: 'minimal', name: 'minimal', description: '最小工具集 preset' },
          { id: 'cordis', name: 'cordis', description: 'cordis 插件开发 preset' },
        ],
      }, null, 2))
    },
  )

  mcp.tool(
    'preset_get',
    '查某个会话当前实际用的是哪个 preset —— 用于解释"为什么这个会话没有某个工具"。什么时候用: agent_run 结果不符合预期、怀疑 preset 影响了可用工具集时。不传 sessionId = 只看服务当前默认 preset(便宜)。返回 {sessionId,preset,source(取值 live/persisted/header/default)} 或 {preset,source(取值 plugin-config/agentPresets.defaultId)}。source=default 说明该会话没有 preset 记录(可能不存在)。要改默认用 preset_set。',
    { sessionId: z.string().optional().describe('要查询的会话 id(缺省 = 只返回本服务的默认 preset, 不查具体会话)') },
    async ({ sessionId }) => {
      // [r3] C8: 入口参数预校验
      const bad = validateArgs('preset_get', { sessionId }, [{ name: 'sessionId', type: 'string' }])
      if (bad) return out(JSON.stringify({ error: bad }))
      if (sessionId) {
        const sid = SessionId(sessionId)
        // 1) live agent: header + 当前 log 最新选择
        try {
          const live = ctx.agents.get(sid) as { session?: { header?: SessionHeader; log?: unknown[] } } | undefined
          if (live?.session?.header) {
            const preset = presetFromEvents(live.session.header, live.session.log ?? [])
            if (preset) return out(JSON.stringify({ sessionId, preset, source: 'live' }))
          }
        } catch { /* fallthrough */ }
        // 2) 持久化读取([r2] 0.1.2 inspect / 0.1.5 open+read)
        try {
          const insp = await persistedInspect(ctx, sid)
          if (insp) {
            const preset = presetFromEvents(insp.meta, insp.events)
            if (preset) return out(JSON.stringify({ sessionId, preset, source: 'persisted' }))
          }
        } catch { /* fallthrough */ }
        // 3) 仅 header 兜底
        const headerOnly = await findSessionHeader(ctx, sid)
        if (headerOnly?.agentPreset) {
          return out(JSON.stringify({ sessionId, preset: headerOnly.agentPreset, source: 'header' }))
        }
        return out(JSON.stringify({
          sessionId,
          preset: (ctx.agentPresets as unknown as { defaultId?: string } | undefined)?.defaultId ?? runtimeConfig.preset,
          source: 'default',
          note: `session ${sessionId} 无 preset 记录(不存在或未记录), 返回默认值`,
          next: `确认会话 id 是否正确用 session_list; 想改默认 preset 用 preset_set(presetId=..., scope=「new-default」)`,
        }))
      }
      let def = runtimeConfig.preset
      let source: string = 'plugin-config'
      try {
        const svcDefault = (ctx.agentPresets as unknown as { defaultId?: string } | undefined)?.defaultId
        if (svcDefault) {
          def = svcDefault
          source = 'agentPresets.defaultId'
        }
      } catch { /* 保持 plugin-config */ }
      return out(JSON.stringify({ preset: def, source }))
    },
  )
  // ── P1: preset 切换(preset_set) ──
  mcp.tool(
    'preset_set',
    '改 agent 的能力组合(preset)。两种范围, 先想清楚要哪种: ① scope=「new-default」(默认, 最常用)= 以后新起的会话都用这个 preset, 立刻生效且尽力写进全局用户默认(重启仍在) ② scope=「session」= 只改某一个已存在会话, 且仅限「还没开始任何 turn 的空白会话」(已跑过任务的会话 preset 已固化, 会明确报错)。什么时候用: 发现默认 preset 工具太少/太多, 想换成 code、minimal 等(合法 id 见 preset_list)。返回 {ok,scope,preset,runtimeDefault,globalDefaultUpdated,note?}。若只想给「某一个任务」换 preset, 不用这里 —— 直接 agent_run(preset=...) 更轻。',
    {
      presetId: z.string().describe('目标 preset id(必须是 preset_list 返回的 id)'),
      scope: z.enum(['new-default', 'session']).optional().describe('改哪一层: new-default(默认)=此后新会话都用它; session=只改指定的空白会话'),
      sessionId: z.string().optional().describe('scope=session 时必填的目标会话 id(来自 session_list 或 agent_run 结果)'),
    },
    async ({ presetId, scope, sessionId }) => {
      const kind = scope ?? 'new-default'
      try {
        // [r3] C8: 入口参数预校验(必填/类型)
        const bad = validateArgs('preset_set', { presetId, scope, sessionId }, [
          { name: 'presetId', type: 'string', required: true },
          { name: 'scope', type: 'string' }, { name: 'sessionId', type: 'string' },
        ])
        if (bad) return out(JSON.stringify({ error: bad }))
        if (kind === 'session') {
          // [r3] C7: 必传参数缺失统一文案
          if (!sessionId) return out(JSON.stringify({ error: missingParamError('preset_set', 'sessionId', 'string (scope=session 时必填)') }))
          const sid = SessionId(sessionId)
          // 空白校验先行(官方 api-proxy select 同款: log 里出现过 turn/start 即视为已开始)
          const found = await collectSessionEvents(ctx, sid)
          if (found === undefined) {
            return out(JSON.stringify({ error: sessionNotFoundError(sessionId) }))
          }
          // [r3] C7 注意: preset_set 的空白会话(冷持久化、log 尚未落任何事件)是**合法**目标 ——
          // 官方 api-proxy select 同款流程就是"冷空白会话 → resume → mount → append", 不能按
          // "会话为空" 报错。因此这里刻意不调用 emptySessionError。
          if (found.events.some((e) => (e as { type?: string })?.type === 'turn/start')) {
            return out(JSON.stringify({ error: errText('session has already started', sessionId, '该会话已跑过任务, agent preset 已固化, 只有空白会话能切换', '改用 agent_run(preset=...) 起新会话, 或用 scope=「new-default」改默认') }))
          }
          // live 会话: 官方同款 recompose + 落一条 agent-preset/selected 事件
          let live: { ctx: Context; session: { append: (t: 'agent-preset/selected', d: { agentPreset: string }) => unknown } } | undefined
          try {
            live = ctx.agents.get(sid) as typeof live
          } catch { live = undefined }
          if (live) {
            try {
              const preset = await ctx.agentPresets.recompose(live.ctx as never, presetId)
              live.session.append('agent-preset/selected', { agentPreset: preset.id })
              return out(JSON.stringify({ ok: true, scope: 'session', sessionId, preset: preset.id, source: 'live', next: HINT.resumeSession }))
            } catch (e) {
              return out(JSON.stringify({ error: `${toolFailure('preset_set', e)} (用 preset_list 确认 presetId 合法; 或重启会话后重试)` }))
            }
          }
          // 冷会话: 直接以目标 preset resume(空白会话等价于切换), 落事件后 flush+dispose
          let handle: Awaited<ReturnType<typeof ctx.agents.resume>>
          try {
            handle = await ctx.agents.resume({
              resumeSessionId: sid,
              agentOptions: {
                provider: runtimeConfig.provider,
                ...(runtimeConfig.model ? { model: runtimeConfig.model } : {}),
              },
              setup: async (agentCtx) => {
                if (scopeOf(agentCtx) === undefined) {
                  console.warn('[harness-mcp-server] agent ctx unscoped (dsh rc.6 bug); preset mount skipped')
                  return
                }
                await ctx.agentPresets.mount(agentCtx, presetId)
              },
            })
          } catch (e) {
            return out(JSON.stringify({ error: `${toolFailure('preset_set', e)} (该会话可能已被清理; 用 session_list 确认; 或改用 scope=「new-default」只改默认)` }))
          }
          try {
            ;(handle.agent.session as unknown as { append: (t: 'agent-preset/selected', d: { agentPreset: string }) => unknown })
              .append('agent-preset/selected', { agentPreset: presetId })
          } catch (e) {
            console.warn('[harness-mcp-server] agent-preset/selected append failed:', String(e))
          }
          try {
            await (ctx.get('sessions') as { flush?: (s: unknown) => Promise<unknown> } | undefined)?.flush?.(handle.agent.session)
          } catch { /* flush 失败不阻断 */ }
          try {
            await handle.dispose()
          } catch { /* dispose 失败不阻断 */ }
          return out(JSON.stringify({ ok: true, scope: 'session', sessionId, preset: presetId, source: 'resumed', next: HINT.resumeSession }))
        }
        // scope=new-default: 先验证 preset 存在, 再更新本服务运行时默认 + 尽力写全局用户默认
        try {
          await ctx.agentPresets.resolve(presetId)
        } catch (e) {
          // [r3] C7: id 不存在统一句式。注意保留 `unknown preset` 前缀(R2 已确立的对外契约,
          // preset_list 描述里也引用这个词), 只在后面补统一的 `(<原因>; <下一步>)` 后缀。
          return out(JSON.stringify({ error: errText(`unknown preset`, presetId, `不在当前部署的 preset 名单里 (${(e as Error)?.message ?? String(e)})`, '用 preset_list 查看合法 id') }))
        }
        runtimeConfig.preset = presetId
        let globalDefaultUpdated = false
        let note: string | undefined
        try {
          const settings = ctx.get('settings') as { mutate?: (ns: unknown, ops: readonly unknown[]) => Promise<void> } | undefined
          if (settings?.mutate) {
            // namespace 'agent-presets' 的用户层 default 字段(agentPresets 服务同款写法)
            await settings.mutate('agent-presets', [{ op: 'set', path: ['default'], value: presetId }])
            globalDefaultUpdated = true
          }
        } catch (e) {
          note = `global user-default write skipped: ${(e as Error)?.message ?? String(e)}`
        }
        return out(JSON.stringify({
          ok: true,
          scope: 'new-default',
          preset: presetId,
          runtimeDefault: runtimeConfig.preset,
          globalDefaultUpdated,
          ...(note ? { note } : {}),
        }, null, 2))
      } catch (e) {
        return out(JSON.stringify({ error: toolFailure('preset_set', e) }))
      }
    },
  )

  // ── P3: 权限三档(policy_get / set_policy) ──
  mcp.tool(
    'policy_get',
    '查某个会话现在到底有多少文件权限(沙箱档位), 以及为什么是这个档。什么时候用: ① agent_run 报"拒绝写入/权限不足", 先来这里确认实际档位 ② 想确认 danger-full-access 是否真的没开(安全自查) ③ 查审批策略是 ask 还是 never。不传 sessionId = 只看部署默认档(便宜)。返回 {sessionId,sandboxMode,source(override 或 default),workspaceRoot,approvalPolicy}(source=override 表示该会话有专门的 sandbox/mode 记录)。要改档用 set_policy。',
    { sessionId: z.string().optional().describe('会话 id(缺省 = 只返回部署默认档; 会话 id 来自 session_list 或 agent_run 结果)') },
    async ({ sessionId }) => {
      try {
        // [r3] C8: 入口参数预校验
        const bad = validateArgs('policy_get', { sessionId }, [{ name: 'sessionId', type: 'string' }])
        if (bad) return out(JSON.stringify({ error: bad }))
        if (!sessionId) {
          return out(JSON.stringify({
            sandboxMode: runtimeConfig.defaultSandbox,
            source: 'default',
            workspaceRoot: defaultTaskCwd(), // [r2] B: 与 agent_run 默认工作目录保持一致
            approvalPolicy: deploymentApprovalPolicy(ctx),
            next: '这是部署默认值; 查具体会话请传 sessionId(从 session_list 获取)',
          }, null, 2))
        }
        const sid = SessionId(sessionId)
        const found = await collectSessionEvents(ctx, sid)
        if (found === undefined) {
          return out(JSON.stringify({ error: sessionNotFoundError(sessionId) }))
        }
        const override = sandboxModeFromEvents(found.events)
        const header = await findSessionHeader(ctx, sid)
        return out(JSON.stringify({
          sessionId,
          sandboxMode: override ?? runtimeConfig.defaultSandbox,
          source: override !== undefined ? 'override' : 'default',
          workspaceRoot: header?.cwd !== undefined ? await canonicalCwd(header.cwd) : defaultTaskCwd(),
          approvalPolicy: approvalPolicyFromEvents(found.events) ?? deploymentApprovalPolicy(ctx),
          ...(override === undefined ? { next: '该会话沿用部署默认档; 想单独提档/降档请用 set_policy(sessionId=..., mode=...)' } : {}),
        }, null, 2))
      } catch (e) {
        return out(JSON.stringify({ error: `${toolFailure('policy_get', e)} (可用无参调用看部署默认; 会话 id 用 session_list 确认)` }))
      }
    },
  )

  mcp.tool(
    'set_policy',
    '改某个已存在会话的文件权限档(什么时候用: agent 抱怨写不了文件 / 需要临时放宽或收紧权限)。三档: read-only(只读, 最安全)|workspace-write(工作区可写, 默认)|danger-full-access(完全绕过围栏 + bash 解禁, 无审批任意读写 —— 仅限可信环境!)。重要限制: 只有 live 会话能改(会追加一条 sandbox/mode 事件, 下一次受限调用即生效, 重启后靠 replay 保持); 冷会话必须先跑一轮(agent_run/task_inbox 带该 sessionId)让它活起来再改。只影响这一个会话; 想给新任务定档请直接用 agent_run(sandbox=...)。返回 {ok,sessionId,sandboxMode,source(固定为 live)}。改完用 policy_get 核对。',
    {
      sessionId: z.string().describe('目标会话 id(必须当前是 live 的; 来自 session_list 或 agent_run 结果)'),
      mode: z.enum(SANDBOX_MODES).describe('目标权限档: read-only 只读 | workspace-write 工作区可写 | danger-full-access 无审批任意读写(仅限可信环境)'),
    },
    async ({ sessionId, mode }) => {
      try {
        // [r3] C8: 入口参数预校验(必填/类型)
        const bad = validateArgs('set_policy', { sessionId, mode }, [
          { name: 'sessionId', type: 'string', required: true },
          { name: 'mode', type: 'string', required: true },
        ])
        if (bad) return out(JSON.stringify({ error: bad }))
        const sid = SessionId(sessionId)
        // live agent 优先(preset_set 的 live.session.append 先例), 其次 sessions store 里 attach 的会话
        let target: PolicySessionLike | undefined
        try {
          target = (ctx.agents.get(sid) as { session?: PolicySessionLike } | undefined)?.session
        } catch { target = undefined }
        if (!target?.append) {
          const store = ctx.get('sessions') as SessionsStoreView | undefined
          const attached = store?.get?.(sid) as PolicySessionLike | undefined
          if (attached?.append) target = attached
        }
        if (!target?.append) {
          return out(JSON.stringify({
            error: `session ${sessionId} is not live; cold/persisted sessions must be resumed first (冷会话必须先跑一轮让它活起来: agent_run(task=..., sessionId=...) 或 task_inbox(task=..., sessionId=...), 之后再调 set_policy; 或直接在那一轮里用 sandbox=... 指定档位)`,
          }))
        }
        appendSandboxMode(target, mode)
        return out(JSON.stringify({ ok: true, sessionId, sandboxMode: mode, source: 'live', next: `用 policy_get(sessionId="${sessionId}") 核对生效档位` }))
      } catch (e) {
        return out(JSON.stringify({ error: `${toolFailure('set_policy', e)} (确认 sessionId 正确且会话是 live 的; 用 session_list 查会话, 用 policy_get 查当前档)` }))
      }
    },
  )

  // ── P3: 审批桥(approval_list / approval_respond) ──
  mcp.tool(
    'approval_list',
    '看有没有"卡在等人批准"的请求(agent 想提权/执行敏感操作时, 会一直挂起等回答)。什么时候用: ① agent_run/task_inbox 迟迟不返回, 怀疑卡在审批上 —— 先调这个 ② status_get 显示 pendingApprovals>0 时。返回 {bridge,pending(当前挂起总数, 一眼可读),count(本页条数),total,offset,limit,truncated,next?,timeoutMs,timeout,approvals:[{approvalId,sessionId,toolName,callId?,reason?,requestedAt(ISO8601),requestedAt_epoch,waitedMs,waited}]}。pending/count=0 说明没有待审(任务卡住是别的原因), 无需反复轮询本工具 —— status_get 的 sandboxPolicy.pendingApprovals 也能直接看到该数字。有则立刻用 approval_respond(approvalId=..., sessionId=..., outcome=...) 回答 —— 不回答的话会一直挂到 approvalTimeoutMs 超时(超时按拒绝收尾, 绝不自动放行)。',
    { ...pageArgSchema },
    async ({ offset, limit }) => {
      try {
        // [r3] C8: 入口参数预校验
        const bad = validateArgs('approval_list', { offset, limit }, [
          { name: 'offset', type: 'number' }, { name: 'limit', type: 'number' },
        ])
        if (bad) return out(JSON.stringify({ error: bad }))
        const now = Date.now()
        const all = [...pendingApprovals.values()].map((e) => ({
          approvalId: e.approvalId,
          sessionId: e.sessionId,
          toolName: e.toolName,
          ...(e.callId !== undefined ? { callId: e.callId } : {}),
          ...(e.reason !== undefined ? { reason: e.reason } : {}),
          // [r3] A2/A3: 时间戳人类可读 + 原始 epoch; 等待时长附人类可读形态
          ...timeFields('requestedAt', e.requestedAt),
          waitedMs: now - e.requestedAt,
          waited: formatDuration(now - e.requestedAt),
        }))
        // [r3] A1: 列表类统一分页(超 20 条截断 + total/next)
        const { offset: off, limit: lim } = parsePage(offset, limit, LIST_PAGE_DEFAULT)
        const { page, meta } = pageEnvelope(all, off, lim, 'approval_list')
        // [r3] B6: 当前挂起审批数汇总 —— agent 不必反复轮询列表才知道有没有审批
        return out(JSON.stringify({
          bridge: activeBridgeKind,
          pending: all.length,
          count: page.length,
          total: meta.total,
          offset: meta.offset,
          limit: meta.limit,
          truncated: meta.truncated,
          timeoutMs: runtimeConfig.approvalTimeoutMs,
          timeout: formatDuration(runtimeConfig.approvalTimeoutMs),
          approvals: page,
          ...(meta.next !== undefined ? { next: meta.next } : {}),
          // [r3] B6: 汇总行(无论有无挂起都给), 让 agent 一眼知道要不要继续追问
          summary: all.length > 0
            ? `当前有 ${all.length} 个审批挂起(最久已等 ${formatDuration(Math.max(...all.map((a) => a.waitedMs))) ?? '0ms'}); 用 approval_respond(approvalId=..., sessionId=..., outcome="allowed-once"|"rejected") 回答`
            : '当前挂起审批数: 0 —— 没有待审请求; 任务卡住请改用 task_list/status_get 查队列与运行态',
          ...(all.length > 0
            ? { hint: `用 approval_respond(approvalId="${all[0].approvalId}", sessionId="${all[0].sessionId}", outcome="allowed-once"|"rejected") 回答; 超时 ${Math.round(runtimeConfig.approvalTimeoutMs / 1000)}s 后按拒绝收尾` }
            : {}),
        }, null, 2))
      } catch (e) {
        return out(JSON.stringify({ error: toolFailure('approval_list', e) }))
      }
    },
  )

  mcp.tool(
    'approval_respond',
    '批准或拒绝一个挂起的审批(配合 approval_list 用: 先 list 拿 approvalId, 再 respond)。什么时候用: approval_list 显示 pending/count>0, 或 agent_run/task_inbox 卡住不动。两种结果: outcome=「allowed-once」=只放行这一次(最常用, 不放长期权限); 「rejected」=拒绝该操作, agent 会收到拒绝并自己换路子。返回 {ok,receipt(accepted 或 not-pending),approvalId,sessionId,outcome,pendingRemaining(回答后还剩几个挂起),pendingSummary}(receipt=not-pending 表示你慢了 —— 已被 Web UI 或另一路回答/已超时, 先答者胜)。⚠️ 安全提示: 这个工具等于远程提权按钮, 部署在非 loopback 地址时必须配置 authToken。',
    {
      approvalId: z.string().describe('approval_list 返回的 approvals[].approvalId'),
      sessionId: z.string().describe('发起审批的会话 id(必须与 approval_list 里同一行的 sessionId 完全一致, 否则会被拒绝)'),
      outcome: z.enum(['allowed-once', 'rejected']).describe('allowed-once=仅本次调用放行(最常用); rejected=拒绝该操作'),
    },
    async ({ approvalId, sessionId, outcome }) => {
      try {
        // [r3] C8: 入口参数预校验(必填/类型)
        const bad = validateArgs('approval_respond', { approvalId, sessionId, outcome }, [
          { name: 'approvalId', type: 'string', required: true },
          { name: 'sessionId', type: 'string', required: true },
          { name: 'outcome', type: 'string', required: true },
        ])
        if (bad) return out(JSON.stringify({ error: bad }))
        const entry = pendingApprovals.get(approvalId)
        if (!entry) {
          return out(JSON.stringify({
            ok: false,
            receipt: 'not-pending',
            approvalId,
            // [r3] B6: 即使没答上, 也把当前挂起数一并回报, 省掉一次 approval_list 轮询
            pendingRemaining: pendingApprovals.size,
            pendingSummary: `当前还有 ${pendingApprovals.size} 个审批挂起`,
            note: '不存在/已被回答/已超时(先答者胜)',
            next: '重新调 approval_list 获取最新的 approvalId —— 该条目已被别处(Web UI/另一路调用)处理或超时',
          }))
        }
        if (entry.sessionId !== sessionId) {
          return out(JSON.stringify({
            ok: false,
            error: errText('sessionId mismatch', approvalId, `该审批属于会话 ${entry.sessionId}`, '用属于该审批的 sessionId 重试; 见 approval_list'),
            pendingRemaining: pendingApprovals.size,
          }))
        }
        const r = await respondToApproval(ctx, entry, outcome)
        // [r3] B6: 回答成功后直接给出"还剩几个挂起", agent 不用再 list 一次
        const remaining = pendingApprovals.size
        return out(JSON.stringify({
          ok: r.accepted,
          receipt: r.accepted ? 'accepted' : (r.reason ?? 'not-pending'),
          approvalId,
          sessionId,
          outcome,
          pendingRemaining: remaining,
          pendingSummary: remaining > 0
            ? `回答后仍有 ${remaining} 个审批挂起; 用 approval_list 查看并继续回答`
            : '回答后已无挂起审批(当前挂起数: 0)',
          ...(r.accepted
            ? { next: '已放行; 原本挂起的 agent_run/task_inbox 会继续跑, 稍后用 task_result 或等待 agent_run 返回' }
            : { next: '未生效(已被别处回答或超时); 用 approval_list 确认当前状态' }),
        }))
      } catch (e) {
        return out(JSON.stringify({ error: `${toolFailure('approval_respond', e)} (先 approval_list 刷新审批列表再重试)` }))
      }
    },
  )

  // 同步执行任务(简单场景: Hermes 下发 → 立即拿结果)
  mcp.tool(
    'agent_run',
    '【同步执行】发任务 → 阻塞等结果 → 一次拿到完整产出。适合 < 5 分钟的任务(改代码、分析、跑命令)。什么时候选它而不是 task_inbox: 任务短、你想在这一个调用里直接拿到 changes/verification, 或者需要把长任务分多轮投喂(传 sessionId 续接同一会话)。什么时候别用: 任务可能要跑很久、或你希望中途能取消 —— 那种用 task_inbox(异步队列)+ task_result 轮询。返回结构化结果 {taskId,sessionId,assistantText,changes,verification,leftovers,toolCalls,toolResults,stats,...}; 有会话可续时结果顶部会带 next 提示。若产出提到写入了文件但没给绝对路径, 会额外附 landing.hint/likelyDir 指明常见落点(本次沙箱 cwd), 拿到后用 fs_list/fs_stat 可定位。注意: 若 agent 请求提权, 本调用会一直阻塞到有人回答审批(用 approval_list/approval_respond 回答), 超时按拒绝收尾, 绝不自动放行。',
    {
      task: z.string().describe('要 Harness 执行的自然语言任务(写清楚目标与验收标准, agent 会照此干活)'),
      context: z.string().optional().describe('记忆/上下文, 注入给 agent 参考(来自你之前的对话/笔记)'),
      cwd: z.string().optional().describe(`工作目录; 不传 = ${defaultCwdHint()}`),
      sessionId: z.string().optional().describe('续接已有会话的 id(来自上次 agent_run/task_inbox 结果的 sessionId 字段); 不传 = 新建会话。长任务分多轮投喂就靠它'),
      title: z.string().optional().describe('新会话的标题(只对新建会话生效, 便于之后在 session_list 里认出来)'),
      preset: z.string().optional().describe('本次任务的 preset 覆盖(合法 id 见 preset_list); 只影响新建/resume, 已有会话保持原 preset'),
      sandbox: z.enum(SANDBOX_MODES).optional().describe('本次任务的文件权限档: read-only 只读 | workspace-write 工作区可写(默认) | danger-full-access 无审批任意读写(仅限可信环境); 只影响新建/resume, 已有会话保持原档(要改已有会话用 set_policy)'),
    },
    async ({ task, context, cwd, sessionId, title, preset, sandbox }) => {
      // [r3] C8: 入口参数预校验(必填/类型), 早于任何业务逻辑
      const badArgs = validateArgs('agent_run', { task, context, cwd, sessionId, title, preset, sandbox }, [
        { name: 'task', type: 'string', required: true },
        { name: 'context', type: 'string' }, { name: 'cwd', type: 'string' }, { name: 'sessionId', type: 'string' },
        { name: 'title', type: 'string' }, { name: 'preset', type: 'string' }, { name: 'sandbox', type: 'string' },
      ])
      if (badArgs) return out(JSON.stringify({ error: badArgs }))
      // A/P3: 请求级参数预检(preset 未知即拒带 available 名单; sandbox 由 schema 枚举兜底再校验一次)
      if (preset) {
        const bad = await presetOverrideError(ctx, preset)
        if (bad) return out(JSON.stringify({ error: bad }))
      }
      if (sandbox !== undefined && !(SANDBOX_MODES as readonly string[]).includes(sandbox)) {
        return out(JSON.stringify({ error: `invalid sandbox "${sandbox}"; valid modes: ${SANDBOX_MODES.join('|')}` }))
      }
      const result = await executeTask(ctx, task, context ?? '', cwd ?? defaultTaskCwd(), sessionId, title, {
        ...(preset ? { preset } : {}),
        ...(sandbox !== undefined ? { sandbox } : {}),
      })
      const truncated = truncateResult(result)
      // [r3] B4: 产出提到"已写入文件"但结果里没有绝对路径时, 附 hint 指向本次沙箱 cwd(常见落点)
      const landing = fileLandingHint(result, cwd ?? defaultTaskCwd())
      // [r2] A + [r3] B4: 结果顶部自解释字段 —— 会话续接 + 文件落点提示
      return out(JSON.stringify({
        ...(sessionId !== undefined && sessionId !== ''
          ? { next: `已续接会话; ${HINT.resumeSession}` }
          : { next: `续接此会话时传 sessionId=${String(result.sessionId)} (${HINT.resumeSession})` }),
        ...(landing !== undefined ? { landing } : {}),
        ...truncated,
      }, null, 2))
    },
  )

  // 异步 push 任务到队列(Hermes → Harness 任务入口)
  mcp.tool(
    'task_inbox',
    '【异步队列】把任务丢进队列立刻返回 taskId(不阻塞), 之后自己轮询取结果。适合长任务、或可能需要中途取消的任务。什么时候选它而不是 agent_run: ① 任务可能跑超过 5 分钟(避免 HTTP 调用超时) ② 你想同时推多个任务并行跑 ③ 你希望保留随时取消的能力(task_cancel)。典型流程: task_inbox 拿 taskId → 用 task_result(taskId=...) 轮询 status/result(建议 5~15s 一次, 别高频空转) → done 后取 changes/verification; 中途想停用 task_cancel。v0.8.0 新增主动回调: 传可选 callback{url, secret?, replyContext?, events?, method?, headers?, timeoutMs?} 后, 任务进入终态(done/error/cancelled)时会向你指定的端点 HTTP POST 一条 JSON 回执(event=task:<status>, 含 result 与 replyContext 原样透传), 带 X-DSH-Signature(HMAC-SHA256, 签名材料 "<X-DSH-Timestamp>.<body>")与 X-DSH-Timestamp 头供验签防伪造; 2xx 视为已投递, 失败/超时仅记录不重试、绝不影响任务本身。目标只允许 http/https, 私网/回环/云 metadata 地址默认拒绝(内网网关用部署配置 allowedCallbackHosts 放行)。不传 callback = 与旧版完全一致(纯轮询模式)。返回 {taskId,status:"queued",createdAt(ISO8601),createdAt_epoch,retain,retainMs,notify?,pollAdvice,next}。看队列全貌用 task_list; 任务卡在审批上时用 approval_list → approval_respond 放行。',
    {
      task: z.string().describe('要执行的任务内容(写清楚目标与验收标准)'),
      context: z.string().optional().describe('记忆/上下文, 随任务注入给 agent(这是喂记忆的主入口)'),
      cwd: z.string().optional().describe(`工作目录; 不传 = ${defaultCwdHint()}`),
      sessionId: z.string().optional().describe('续接已有会话的 id(来自上次 agent_run/task_inbox 结果); 不传 = 新建会话'),
      title: z.string().optional().describe('新会话的标题(只对新建会话生效, 便于 session_list 归档识别)'),
      preset: z.string().optional().describe('本次任务的 preset 覆盖(合法 id 见 preset_list); 只影响新建/resume'),
      sandbox: z.enum(SANDBOX_MODES).optional().describe('本次任务的文件权限档: read-only | workspace-write(默认) | danger-full-access(仅限可信环境); 只影响新建/resume'),
      callback: callbackSchema.optional().describe('任务终态主动回调(可选): 任务 done/error/cancelled 后向 url POST 签名 JSON 回执(replyContext 原样透传, X-DSH-Signature HMAC-SHA256 防伪造); 仅 http/https, 私网/metadata 默认拒绝; 不传 = 纯轮询模式, 行为与旧版完全一致'),
    },
    async ({ task, context, cwd, sessionId, title, preset, sandbox, callback }) => {
      // [r3] C8: 入口参数预校验(必填/类型), 入队前即拒, 不占队列容量
      const badArgs = validateArgs('task_inbox', { task, context, cwd, sessionId, title, preset, sandbox, callback }, [
        { name: 'task', type: 'string', required: true },
        { name: 'context', type: 'string' }, { name: 'cwd', type: 'string' }, { name: 'sessionId', type: 'string' },
        { name: 'title', type: 'string' }, { name: 'preset', type: 'string' }, { name: 'sandbox', type: 'string' },
        { name: 'callback', type: 'object' },
      ])
      if (badArgs) return out(JSON.stringify({ error: badArgs }))
      // A/P3: 请求级参数预检(入队前即拒, 不占队列容量)
      if (preset) {
        const bad = await presetOverrideError(ctx, preset)
        if (bad) return out(JSON.stringify({ error: bad }))
      }
      if (sandbox !== undefined && !(SANDBOX_MODES as readonly string[]).includes(sandbox)) {
        return out(JSON.stringify({ error: `invalid sandbox "${sandbox}"; valid modes: ${SANDBOX_MODES.join('|')}` }))
      }
      // [P0 回调] 解析 callback(SSRF/保留头/secret 回填/replyContext 4KB 上限; 入队前即拒, 不占队列容量)
      const cbResolved = resolveCallback(callback)
      if (cbResolved.error) return out(JSON.stringify({ error: cbResolved.error }))
      const now = Date.now()
      // TTL 清理: 删除已完成/失败/已取消且超时的任务
      for (const [tid, t] of taskQueue) {
        if ((t.status === 'done' || t.status === 'error' || t.status === 'cancelled') && t.finishedAt && now - t.finishedAt > runtimeConfig.taskTtlMs) {
          taskQueue.delete(tid)
        }
      }
      // 队列容量上限: 活动任务(排队+执行中)超过上限则拒绝
      let active = 0
      for (const t of taskQueue.values()) if (t.status === 'queued' || t.status === 'running') active++
      if (active >= runtimeConfig.maxQueue) {
        return out(JSON.stringify({ error: `task queue full (${active}/${runtimeConfig.maxQueue})` }))
      }
      const id = randomUUID()
      const item: TaskItem = {
        id, task, context: context ?? '', cwd: cwd ?? defaultTaskCwd(), status: 'queued', createdAt: now,
        ...(sessionId ? { sessionId } : {}),
        ...(title ? { title } : {}),
        ...(preset ? { preset } : {}),
        ...(sandbox !== undefined ? { sandbox } : {}),
        // [P0 回调] 仅当调用方传入且解析成功时携带; 不传 = 该字段不存在, 收尾路径与 v0.7.0 完全一致
        ...(cbResolved.config !== undefined ? { callback: cbResolved.config } : {}),
      }
      taskQueue.set(id, item)
      // 异步执行(不阻塞 Hermes)
      void (async () => {
        item.status = 'running'
        try {
          item.result = await executeTask(ctx, item.task, item.context, item.cwd, item.sessionId, item.title, {
            ...(item.preset ? { preset: item.preset } : {}),
            ...(item.sandbox !== undefined ? { sandbox: item.sandbox } : {}),
            onSessionStart: (sid) => { taskRunSessions.set(id, sid) },
            isCancelled: () => item.cancelled === true,
          })
          item.result.taskId = id
          item.status = 'done'
        } catch (e) {
          item.error = String(e)
          item.status = 'error'
        }
        taskRunSessions.delete(id)
        // B 取消收尾: cancelled 标志压过 done/error(协作取消抛错也归此), 结果丢弃
        if (item.cancelled) {
          item.status = 'cancelled'
          delete item.result
          delete item.error
        }
        item.finishedAt = Date.now()
        // [P0 回调] 唯一权威触发点(REQ §2): 终态收敛完成后发射; void 非阻塞, 失败仅告警绝不抛错
        dispatchTaskCallback(item)
      })()
      return out(JSON.stringify({
        taskId: id,
        status: 'queued',
        // [r3] B5: 任务保留时长 + 轮询节奏建议(提交后就知道"多久内必须来取"以及"别高频空转")
        retainMs: runtimeConfig.taskTtlMs,
        retain: formatDuration(runtimeConfig.taskTtlMs),
        createdAt: humanTime(now)?.at,
        createdAt_epoch: now,
        // [P0 回调] 仅传了 callback 才追加 notify 摘要(不传 = 返回体与 v0.7.0 逐字节一致)
        // [r1] 额外回显 callbackSource, 让调用方一眼看出"我没传 callback 为什么发了回调"(预设生效)
        ...(cbResolved.config !== undefined
          ? {
              notify: {
                enabled: true,
                urlHost: hostOfCallbackUrl(cbResolved.config.url),
                events: cbResolved.config.events,
                signed: cbResolved.signed === true,
                ...(cbResolved.source !== undefined ? { source: cbResolved.source } : {}),
                ...(cbResolved.signed !== true ? { unsignedReason: 'no secret provided (callback.secret 与部署级 defaultCallbackSecret 均未配置); 接收方无法验签, 建议配置 secret' } : {}),
              },
            }
          : {}),
        pollAdvice: `建议每 5~15s 轮询一次, 别高频空转; 完成后 ${formatDuration(runtimeConfig.taskTtlMs) ?? '10m'} 内取走结果, 过期会被清理`,
        // [r2] B/A: 拿到 id 立刻告诉 agent 怎么取结果(链路自解释)
        next: `用 task_result(taskId="${id}") 轮询结果(建议 5~15s 一次); 队列全貌用 task_list; 想中途取消用 task_cancel(taskId="${id}")`,
      }))
    },
  )

  // 取回任务结果(结构化 changes/verification/leftovers)
  mcp.tool(
    'task_result',
    '取回 task_inbox 提交的任务当前结果(这是异步链路的第二半: task_inbox 拿 taskId → 用本工具轮询)。什么时候用: task_inbox 返回 taskId 之后; 或 agent_run 场景外想确认某个后台任务好了没。返回 {taskId,status,error,result,createdAt(ISO8601),createdAt_epoch,finishedAt(ISO8601),finishedAt_epoch,waited,notify?,landing?}(status ∈ queued|running|done|error|cancelled; result 仅 done 时有, 含 changes/verification/leftovers/assistantText/toolCalls 等)。若结果提到写入了文件却没给绝对路径, 会额外附 landing.hint 指向沙箱 cwd(常见落点)。notify 是任务终态主动回调的投递状态(仅提交时传了 callback 才有): delivered=回执已被接收端 2xx 确认; failed=投递失败(看 lastError, 不影响任务本身); skipped=未订阅该事件或回调被部署配置关闭。轮询建议: running 时等几秒再问, 别高频空转; status=done 即可停。任务不见了(task not found)通常是已过期(默认保留 10 分钟)或被取消。看队列全貌用 task_list。',
    { taskId: z.string().describe('task_inbox 返回的 taskId(也可从 task_list 的 tasks[].id 取)') },
    async ({ taskId }) => {
      try {
        // [r3] C8: 入口参数预校验
        const bad = validateArgs('task_result', { taskId }, [{ name: 'taskId', type: 'string', required: true }])
        if (bad) return out(JSON.stringify({ error: bad }))
        const item = taskQueue.get(taskId)
        if (!item) return out(JSON.stringify({ error: taskNotFoundError(taskId) }))
        const done = item.status === 'done'
        // [r3] B4: 任务产出提到"已写入文件"但结果里没有绝对路径时, 指向沙箱 cwd
        const landing = item.result ? fileLandingHint(item.result, item.cwd) : undefined
        return out(JSON.stringify({
          taskId: item.id,
          status: item.status,
          error: item.error,
          // [r3] A2/A3: 时间戳人类可读 + 原始 epoch; 已耗时附人类可读形态
          ...timeFields('createdAt', item.createdAt),
          ...(item.finishedAt !== undefined ? timeFields('finishedAt', item.finishedAt) : {}),
          ...(item.finishedAt !== undefined ? { waitedMs: item.finishedAt - item.createdAt, waited: formatDuration(item.finishedAt - item.createdAt) } : {}),
          result: item.result ? truncateResult(item.result) : undefined,
          // [P0 回调] 投递状态回显(仅配置了 callback 的任务才有; 未配置 = 不追加该字段, 输出与 v0.7.0 一致)
          ...(item.callback !== undefined ? { notify: { ...item.notify } } : {}),
          ...(landing !== undefined ? { landing } : {}),
          // [r2] A + [r3] B4: 按状态给下一步, 免得 agent 无脑轮询或误以为失败
          ...(done
            ? { next: item.result?.sessionId ? `任务完成; ${HINT.resumeSession}` : '任务完成' }
            : item.status === 'running' || item.status === 'queued'
              ? { next: `仍在${item.status === 'running' ? '执行' : '排队'}; 稍后再次调用本工具取结果(建议 5~15s 一次); 卡在审批上可先看 approval_list` }
              : item.status === 'error'
                ? { next: '任务失败; 看 error 字段定位原因 —— 常见是权限不足(用 policy_get 查档位)或会话失效(用 session_list 确认)' }
                : { next: '任务已取消, 结果已丢弃; 需要的话重新用 task_inbox 提交' }),
        }, null, 2))
      } catch (e) {
        return out(JSON.stringify({ error: toolFailure('task_result', e) }))
      }
    },
  )

  // ── P1: 任务队列快照(task_list) ──
  mcp.tool(
    'task_list',
    '看异步任务队列的全貌(有哪些排队/在跑/已完成的)。什么时候用: ① task_result 报 task not found, 来这里确认是不是已过期 ② 不记得 taskId 了, 按标题/cwd 找 ③ 确认没有僵尸任务在跑。与 status_get 的区别: 这里列出每一条任务明细, status_get 只给一个 queueActive 总数。返回 {total,active,count,offset,limit,truncated,next?,tasks:[{id,status,createdAt(ISO8601),createdAt_epoch,finishedAt(ISO8601),finishedAt_epoch,waited?,error?,title?,preset?,sandbox?,cwd,sessionId?,hasResult,notify?}]}(新任务在前, 默认最多 20 条, 超 20 条用 offset/limit 翻页; status ∈ queued|running|done|error|cancelled; notify 仅提交时传了 callback 的任务才有, 见 task_result 说明)。取具体结果用 task_result(taskId=...)。',
    { ...pageArgSchema },
    async ({ offset, limit }) => {
      try {
        // [r3] C8: 入口参数预校验
        const bad = validateArgs('task_list', { offset, limit }, [
          { name: 'offset', type: 'number' }, { name: 'limit', type: 'number' },
        ])
        if (bad) return out(JSON.stringify({ error: bad }))
        const all = [...taskQueue.values()].sort((a, b) => b.createdAt - a.createdAt)
        const active = all.filter((t) => t.status === 'queued' || t.status === 'running').length
        // [r3] A1: 列表类统一分页(超 20 条截断 + total/next)
        const { offset: off, limit: lim } = parsePage(offset, limit, LIST_PAGE_DEFAULT)
        const { page, meta } = pageEnvelope(all, off, lim, 'task_list')
        const tasks = page.map((t) => ({
          id: t.id,
          status: t.status,
          // [r3] A2/A3: 时间戳人类可读 + 原始 epoch; 完成耗时附人类可读形态
          ...timeFields('createdAt', t.createdAt),
          ...(t.finishedAt !== undefined ? timeFields('finishedAt', t.finishedAt) : {}),
          ...(t.finishedAt !== undefined ? { waitedMs: t.finishedAt - t.createdAt, waited: formatDuration(t.finishedAt - t.createdAt) } : {}),
          ...(t.error !== undefined ? { error: t.error } : {}),
          ...(t.title ? { title: t.title } : {}),
          ...(t.preset ? { preset: t.preset } : {}),
          // P3: 请求级权限档回显
          ...(t.sandbox !== undefined ? { sandbox: t.sandbox } : {}),
          cwd: t.cwd,
          ...(t.sessionId ? { sessionId: t.sessionId } : {}),
          hasResult: Boolean(t.result),
          // [P0 回调] 投递状态回显(仅配置了 callback 的任务才有; 未配置 = 不追加该字段)
          ...(t.callback !== undefined ? { notify: { ...t.notify } } : {}),
        }))
        return out(JSON.stringify({
          total: meta.total,
          active,
          count: tasks.length,
          offset: meta.offset,
          limit: meta.limit,
          truncated: meta.truncated,
          ...(meta.next !== undefined ? { next: meta.next } : {}),
          tasks,
        }, null, 2))
      } catch (e) {
        return out(JSON.stringify({ error: toolFailure('task_list', e) }))
      }
    },
  )

  // ── P2: 取消队列任务(task_cancel) ──
  mcp.tool(
    'task_cancel',
    '取消一个还在排队或正在跑的异步任务(这是 task_inbox 相对 agent_run 的核心优势)。什么时候用: 发现任务方向错了 / 不想等了 / 要腾出队列名额。行为: queued(还在排队)=直接出队; running(正在跑)=尽力中止(结果丢弃, 但会话保留, 之后还能用那个 sessionId 续接); 已完成/已失败/已取消/不存在=明确报错(不可取消)。返回 {ok,status:"cancelled",was,taskId,sessionId?,note}。取消后想看队列现状用 task_list。',
    { taskId: z.string().describe('task_inbox 返回的 taskId(也可从 task_list 取)') },
    async ({ taskId }) => {
      try {
        // [r3] C8: 入口参数预校验(必填/类型)
        const bad = validateArgs('task_cancel', { taskId }, [{ name: 'taskId', type: 'string', required: true }])
        if (bad) return out(JSON.stringify({ error: bad }))
        const item = taskQueue.get(taskId)
        if (!item) return out(JSON.stringify({ ok: false, error: `task ${taskId} not cancellable (status=missing) (用 task_list 查看当前队列 —— 该任务可能已过期清理)` }))
        if (item.status === 'queued') {
          // 还没开跑(仅存在于入队同 tick 的窗口): 直接出队即取消
          item.status = 'cancelled'
          taskQueue.delete(taskId)
          return out(JSON.stringify({ ok: true, status: 'cancelled', was: 'queued', taskId, next: '已出队; 需要的话重新用 task_inbox 提交新任务' }))
        }
        if (item.status === 'running') {
          const sid = taskRunSessions.get(taskId)
          let agent: { cancel?: (cause: unknown, opts?: unknown) => void } | undefined
          if (sid) {
            try {
              agent = ctx.agents.get(SessionId(sid)) as typeof agent
            } catch { agent = undefined }
          }
          if (!sid || !agent?.cancel) {
            // 定位不到 agent: 若任务还在等锁(未起 agent), cancelled 标志会在协作检查点生效;
            // 已起但 registry 里找不到(rare race)则无法主动中止 → 明确失败
            const waitingOnLock = sid === undefined
            if (waitingOnLock) {
              item.cancelled = true
              return out(JSON.stringify({ ok: true, status: 'cancelled', was: 'running', taskId, note: 'agent not started yet; will be cancelled at cooperative checkpoint', next: '取消将在协作检查点生效; 用 task_list 确认最终状态' }))
            }
            return out(JSON.stringify({ ok: false, error: 'task running; no abort API', hint: '等待完成或 sessionId 续接接管', next: '该任务已起 agent 但拿不到中止句柄; 等它跑完(用 task_result 轮询), 或拿到 sessionId 后用 agent_run 接管该会话' }))
          }
          // 先置标志再 cancel: 防 whenIdle 恰在此间收敛、runner 抢先落 done 的竞态
          item.cancelled = true
          try {
            agent.cancel({ kind: 'user' })
          } catch (e) {
            delete item.cancelled
            return out(JSON.stringify({ ok: false, error: toolFailure('task_cancel', e), hint: '等待完成或 sessionId 续接接管', next: '重试 task_cancel, 或等任务自然结束' }))
          }
          return out(JSON.stringify({ ok: true, status: 'cancelled', was: 'running', taskId, sessionId: sid, note: 'abort requested; result will be discarded', next: sid ? `会话已保留; ${HINT.resumeSession}` : '结果将被丢弃' }))
        }
        return out(JSON.stringify({ ok: false, error: `task ${taskId} not cancellable (status=${item.status})`, next: '该任务已处于终态, 无需取消; 用 task_result(taskId=...) 取结果, 或 task_list 看队列现状' }))
      } catch (e) {
        return out(JSON.stringify({ error: `${toolFailure('task_cancel', e)} (用 task_list 确认 taskId 与状态)` }))
      }
    },
  )

  // 给已有会话改名(走 sessionTitle 服务, 便于会话列表归档)
  mcp.tool(
    'rename_session',
    '给一个已有会话改标题(纯整理, 不影响会话内容或能力)。什么时候用: agent_run/task_inbox 建的会话越来越多, 想按用途命名便于日后在 session_list 里一眼认出、或让 session_search 更好命中。注意: 只能改当前 live 的会话(冷会话会报 session not found —— 先跑一轮让它活起来)。返回 {ok,sessionId,title}。改完用 session_list 确认。',
    {
      sessionId: z.string().describe('要改名的会话 id(来自 session_list 或 agent_run/task_inbox 结果)'),
      title: z.string().describe('新标题(建议写清用途, 便于日后检索)'),
    },
    async ({ sessionId, title }) => {
      try {
        // [r3] C8: 入口参数预校验(必填/类型)
        const bad = validateArgs('rename_session', { sessionId, title }, [
          { name: 'sessionId', type: 'string', required: true },
          { name: 'title', type: 'string', required: true },
        ])
        if (bad) return out(JSON.stringify({ error: bad }))
        const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
        const session = sessions?.get?.(sessionId)
        if (!session) return out(JSON.stringify({ error: `${sessionNotFoundError(sessionId)}; 注意本工具只能改 live 会话 —— 若该会话是冷的, 先用 agent_run(task=..., sessionId=...) 唤醒它再改名` }))
        const st = ctx.get('sessionTitle') as { rename?: (s: unknown, t: string) => unknown } | undefined
        if (!st?.rename) return out(JSON.stringify({ error: 'sessionTitle service unavailable (该 dsh 部署未加载会话标题服务, 无法改名; 不影响其他功能)' }))
        const snapshot = st.rename(session, title) as { title?: string } | undefined
        return out(JSON.stringify({ ok: true, sessionId, title: snapshot?.title ?? title }))
      } catch (e) {
        return out(JSON.stringify({ error: toolFailure('rename_session', e) }))
      }
    },
  )

  // 手动归组补给站: 官方 UI 没有"移动会话到工作区"功能, 本工具供随时归组
  mcp.tool(
    'attach_session',
    '把一个会话归组到它的工作区下(纯整理操作, 让 dsh Web UI 的工作区侧栏能正确归类)。什么时候用: 会话出现在"未分组"里、或 agent_run 建的会话没自动归到期望的工作区。path 不传 = 用该会话 header 里的 cwd。硬性要求: 目标目录必须真实存在, 且 realpath(header.cwd) 必须与工作区路径精确相等, 否则官方 attachSession 会拒绝(这是官方强校验, 本插件无法绕过)。返回 {sessionId,workspaceId,workspacePath,attached}(attached=false 表示本来就在该工作区下)。本插件只做整理, 不改会话内容。',
    {
      sessionId: z.string().describe('要归组的会话 id(live 或已持久化都可以; 来自 session_list)'),
      path: z.string().optional().describe('目标工作区目录(不传 = 用会话 header 里的 cwd; 必须是已存在的目录)'),
    },
    async ({ sessionId, path }) => {
      // [r3] C8: 入口参数预校验(必填/类型)
      const bad = validateArgs('attach_session', { sessionId, path }, [
        { name: 'sessionId', type: 'string', required: true },
        { name: 'path', type: 'string' },
      ])
      if (bad) return out(JSON.stringify({ error: bad }))
      const sid = SessionId(sessionId)
      const header = await findSessionHeader(ctx, sid)
      if (header === undefined) {
        return out(JSON.stringify({ error: `${sessionNotFoundError(sessionId)} (live 与持久化里都没找到)` }))
      }
      const target = path ?? header.cwd
      if (target === undefined) {
        return out(JSON.stringify({ error: `session ${sessionId} 的 header 没有 cwd, 官方 attachSession 无法校验, 不能归组 (请显式传 path=目标工作区目录)` }))
      }
      try {
        const canonical = await realpath(target) // 目标必须是存在的目录, 否则 ENOENT
        const ws = await ensureWorkspace(ctx, canonical)
        if (!ws?.attachSession) return out(JSON.stringify({ error: 'workspaceRegistry unavailable (该部署未加载工作区注册表服务, 无法归组; 不影响任务执行)' }))
        if (ws.sessionIds.includes(sid)) {
          return out(JSON.stringify({ sessionId, workspaceId: ws.id, workspacePath: ws.path, attached: false, note: 'already attached' }))
        }
        await ws.attachSession(sid)
        return out(JSON.stringify({ sessionId, workspaceId: ws.id, workspacePath: ws.path, attached: true }))
      } catch (e) {
        return out(JSON.stringify({ error: `${toolFailure('attach_session', e)} (确认 path 目录真实存在; 且 realpath(会话 cwd) 必须与该目录完全相等 —— 不一致时官方会拒绝)` }))
      }
    },
  )
}

/**
 * 插件入口: 启动 MCP server(StreamableHTTP, 跨网), 通过 ctx 桥接 Harness 能力。
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  // 初始化运行时配置: 先重置为默认值再叠加 config(重复 apply 幂等, 不残留上一次的状态)
  Object.assign(runtimeConfig, runtimeConfigDefaults())
  if (config.provider) runtimeConfig.provider = config.provider
  if (config.model) runtimeConfig.model = config.model
  if (config.preset) runtimeConfig.preset = config.preset
  if (config.maxQueue !== undefined) runtimeConfig.maxQueue = config.maxQueue
  if (config.taskTtlMs !== undefined) runtimeConfig.taskTtlMs = config.taskTtlMs
  if (config.maxAgents !== undefined) runtimeConfig.maxAgents = config.maxAgents
  if (config.authToken) runtimeConfig.authToken = config.authToken
  if (config.workspaceRoots) runtimeConfig.workspaceRoots = config.workspaceRoots
  if (config.enableFsWrite !== undefined) runtimeConfig.enableFsWrite = config.enableFsWrite
  // P3: 权限三档 + 审批桥配置(非法值告警回落默认, 不阻断启动)
  if (config.defaultSandbox !== undefined) {
    if ((SANDBOX_MODES as readonly string[]).includes(config.defaultSandbox)) {
      runtimeConfig.defaultSandbox = config.defaultSandbox
    } else {
      console.warn(`[harness-mcp-server] invalid defaultSandbox "${config.defaultSandbox}", keep default "${runtimeConfig.defaultSandbox}" (valid: ${SANDBOX_MODES.join('|')})`)
    }
  }
  if (config.approvalsBridge !== undefined) {
    if (config.approvalsBridge === 'web' || config.approvalsBridge === 'builtin' || config.approvalsBridge === 'off' || config.approvalsBridge === 'file-push') {
      runtimeConfig.approvalsBridge = config.approvalsBridge
    } else {
      console.warn(`[harness-mcp-server] invalid approvalsBridge "${String(config.approvalsBridge)}", keep default "web" (valid: web|builtin|file-push|off)`)
    }
  }
  if (config.approvalTimeoutMs !== undefined && Number.isFinite(config.approvalTimeoutMs) && config.approvalTimeoutMs > 0) {
    runtimeConfig.approvalTimeoutMs = Math.trunc(config.approvalTimeoutMs)
  }
  if (config.approvalFileDir !== undefined && typeof config.approvalFileDir === 'string' && config.approvalFileDir.trim()) {
    runtimeConfig.approvalFileDir = config.approvalFileDir
  }
  // [P0 回调] 回调通道配置(非法值告警回落默认, 不阻断启动)
  if (config.notifyEnabled !== undefined) {
    if (typeof config.notifyEnabled === 'boolean') {
      runtimeConfig.notifyEnabled = config.notifyEnabled
    } else {
      console.warn(`[harness-mcp-server] invalid notifyEnabled ${String(config.notifyEnabled)}, keep default true (expected boolean)`)
    }
  }
  if (config.defaultCallbackSecret !== undefined) {
    if (typeof config.defaultCallbackSecret === 'string') {
      runtimeConfig.defaultCallbackSecret = config.defaultCallbackSecret
    } else {
      console.warn('[harness-mcp-server] invalid defaultCallbackSecret, keep default "" (expected string)')
    }
  }
  if (config.allowedCallbackHosts !== undefined) {
    if (Array.isArray(config.allowedCallbackHosts) && config.allowedCallbackHosts.every((h) => typeof h === 'string')) {
      runtimeConfig.allowedCallbackHosts = [...config.allowedCallbackHosts]
    } else {
      console.warn('[harness-mcp-server] invalid allowedCallbackHosts, keep default [] (expected string[])')
    }
  }
  // [r1] 部署级回调预设(非法值告警回落"未配置", 不阻断启动; 不配 = 与旧版完全一致)
  if (config.callbackPreset !== undefined) {
    const p = normalizeCallbackPreset(config.callbackPreset)
    if (p === undefined) {
      console.warn('[harness-mcp-server] invalid callbackPreset, keep unset (expected object {url?,method?,headers?,events?,replyContext?,timeoutMs?,autoApply?,requireReplyRoute?})')
    } else {
      runtimeConfig.callbackPreset = p
    }
  }

  const port = config.port ?? 8090
  // 安全默认: 仅监听本机。暴露公网/局域网前必须自行加认证+反代+TLS(见 README 警告)
  const host = config.host ?? '127.0.0.1'
  serverRuntime.port = port
  serverRuntime.host = host
  serverRuntime.startedAt = Date.now()
  console.log('[harness-mcp-server] apply called, port=', port)

  const servers = new Map<string, McpServer>()
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const server = http.createServer(async (req, res) => {
    // Bearer token 认证(配置了 authToken 时强制所有请求校验)
    if (runtimeConfig.authToken) {
      const auth = req.headers['authorization']
      if (auth !== `Bearer ${runtimeConfig.authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }))
        return
      }
    }
    const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined
    const existing = sessionId ? transports.get(sessionId) : undefined

    // 已有 session: GET/POST/DELETE 都路由到对应 transport(支持 SSE 流 + 会话终止)
    if (existing) {
      if (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') {
        await existing.handleRequest(req as never, res as never)
        return
      }
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Method not allowed' }, id: null }))
      return
    }

    // 新 session 初始化(仅 POST 且无 session id)
    if (req.method === 'POST' && !sessionId) {
      const mcp = new McpServer({ name: 'harness', version: PLUGIN_VERSION })
      registerTools(mcp, ctx)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport)
          servers.set(sid, mcp)
        },
      })
      // 会话关闭时清理映射(避免临时 key 泄漏 + 无效会话累积)
      transport.onclose = () => {
        const sid = transport.sessionId
        if (sid) {
          transports.delete(sid)
          servers.delete(sid)
        }
      }
      await mcp.connect(transport as never)
      await transport.handleRequest(req as never, res as never)
      return
    }

    // 未知 session → 404(不新建 transport, 避免遗留对象)
    if (sessionId) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }))
      return
    }

    // 无 session 的非初始化请求 → 400
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request' }, id: null }))
  })

  server.listen(port, host, () => {
    console.log(`[harness-mcp-server] MCP server listening on ${host}:${port}`)
  })
  server.on('error', (e) => {
    console.error('[harness-mcp-server] HTTP server error:', e.message)
  })

  // 存量捞回: 启动后异步补挂未分组会话, 不阻塞启动; 全程兜底 try/catch 防 unhandled rejection
  void (async () => {
    try {
      const r = await reattachOrphanSessions(ctx)
      console.log(`[harness-mcp-server] 存量捞回完成: attached=${r.attached} failed=${r.failed}`)
    } catch (e) {
      console.warn('[harness-mcp-server] 存量捞回异常:', (e as Error)?.message ?? e)
    }
  })()

  // P3: 审批转接桥(web 订阅 apiProxy mux / builtin 自注册 answerer / off 关闭), 返回 dispose
  const stopApprovalsBridge = startApprovalsBridge(ctx)

  // 标准 cordis 生命周期: 用 ctx.effect 注册清理(卸载时关 server + 清空全部映射/会话/队列)
  ctx.effect(() => {
    return () => {
      server.close()
      stopApprovalsBridge()
      transports.clear()
      servers.clear()
      liveAgents.clear()
      sessionToCwd.clear()
      agentLocks.clear()
      taskQueue.clear()
      taskRunSessions.clear()
      lastAgentSessionId = undefined
    }
  }, 'harness-mcp-server')
}

/** 测试专用内部通道(mock 测试直接操纵队列状态, 绕开异步时序; 非公开 API) */
export const __internals = {
  taskQueue, taskRunSessions, pendingApprovals,
  get activeBridgeKind() { return activeBridgeKind },
  // [r3] 纯函数通道: A(格式化/分页) 与 C(错误文案/参数校验) 可被单测直接断言, 不依赖 HTTP 时序
  errText, missingParamError, idNotFoundError, emptySessionError,
  isDshServiceDown, toolFailure, validateArgs,
  humanTime, timeFields, formatBytes, formatDuration, parsePage, pageEnvelope,
  fileLandingHint, extractAbsPaths,
  SESSION_LOG_MAX_EVENTS, LIST_PAGE_DEFAULT, LIST_PAGE_MAX,
  // [P0 回调] 纯函数通道: SSRF/解析/签名/载荷可被单测直接断言, 不依赖网络时序
  ssrfGuardCheck, resolveCallback, buildCallbackPayload, signCallbackPayload, safeEqualStr, hostOfCallbackUrl,
  // [r1] 回调预设合并语义纯函数(可直接单测)
  mergeReplyContext, mergeCallbackHeaders, sanitizeCallbackHeaders, findLiteralTemplateValue, hasReplyRouteField,
  normalizeCallbackPreset, describeCallbackPreset,
  // [r1] 会话快路径: 供单测断言批量 mtime / 数据源选择 / cwd 目录名推导
  listCorpus, projectDirNameOf, batchUpdatedAt,
  SESSION_LIST_INSPECT_CONCURRENCY, SESSION_LIST_INSPECT_TIMEOUT_MS,
  VERSION: PLUGIN_VERSION,
}

/**
 * dsh-harness-mcp-server — 在 Harness 内部启动 MCP server, 暴露 Harness 能力给 Hermes(大脑)。
 *
 * 工具集:
 *   - echo                : 验证 MCP server 连通
 *   - harness_list_tools  : 列出 Harness 工具注册表
 *   - agent_run           : 同步执行任务(改代码/分析/跑命令), 返回结构化结果
 *   - task_inbox          : Hermes push 结构化任务(任务+记忆上下文)到 Harness 队列, 异步执行, 返回 taskId
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
import { isTokenDelta } from '@deepseek-ai/dsh-llm/message'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, stat, writeFile, appendFile, mkdir } from 'node:fs/promises'
import http from 'node:http'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join as joinPath, resolve, dirname, basename } from 'node:path'

/** Cordis 插件名 */
export const name = 'harness-mcp-server'

/** 插件版本(status_get 上报; 与 package.json 保持同步) */
const PLUGIN_VERSION = '0.5.0'

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

/** 审批桥形态: web=订阅 apiProxy mux 复用 Web 审批通道(默认); builtin=插件内建应答器; off=关闭桥 */
export type ApprovalsBridge = 'web' | 'builtin' | 'off'

/**
 * 声明依赖的核心服务。
 * workspaceRegistry/sessionPersistence/sessions 是续接/归组三个增量用到的服务——
 * 漏声明会在真实启动时拿不到服务(本插件曾经踩过, 务必与代码里的 ctx.get 对齐)。
 */
export const inject = ['tools', 'llm', 'agents', 'agentPresets', 'workspaceRegistry', 'sessionPersistence', 'sessions', 'apiProxy']

/** 插件配置 */
export interface Config {
  http?: boolean
  port?: number
  host?: string
  /** 后端 provider(默认 deepseek-official) */
  provider?: string
  /** 执行任务的模型(默认 deepseek-v4-flash) */
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
  /** 审批桥模式(P3, 默认 'web'): web=订阅 apiProxy mux 复用 Web 审批通道; builtin=插件内建应答器(apiProxy 缺失时自动降级); off=关闭桥(审批回到 fail-closed) */
  approvalsBridge?: ApprovalsBridge
  /** 审批等待超时毫秒(P3, 默认 120000)。超时 settle cancelled(builtin)/rejected(web 协议无 cancelled) —— 绝不超时放行 */
  approvalTimeoutMs?: number
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
  approvalTimeoutMs: 120 * 1000,
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
const SESSION_LIST_MAX_ROWS = 50 // session_list 行数硬上限
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
      createUserMessage({ content: [{ type: 'text', text: fullTask }], source: { kind: 'plugin', plugin: 'harness-mcp-server' } }),
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
}
const taskQueue = new Map<string, TaskItem>()
/** B: 执行中任务 → agent 会话 id(task_cancel 用它定位要中止的 Agent; executeTask onSessionStart 登记) */
const taskRunSessions = new Map<string, string>()

/** 找会话 header: live 优先, 其次持久化 list(轻量元数据扫描, 不加载整日志) */
async function findSessionHeader(ctx: Context, sessionId: SessionId): Promise<SessionHeader | undefined> {
  const sessions = ctx.get('sessions') as { get?: (id: SessionId) => { header: SessionHeader } | undefined } | undefined
  const live = sessions?.get?.(sessionId)
  if (live !== undefined) return live.header
  const persistence = ctx.get('sessionPersistence') as { list?: () => Promise<SessionHeader[]> } | undefined
  for (const header of (await persistence?.list?.()) ?? []) {
    if (header.id === sessionId) return header
  }
  return undefined
}

/** live + 持久化 header 合并(live 优先), 按 id 去重(session_list / 存量捞回 / session_search 共用) */
async function listMergedHeaders(ctx: Context): Promise<Map<string, SessionHeader>> {
  const headers = new Map<string, SessionHeader>()
  const store = ctx.get('sessions') as SessionsStoreView | undefined
  for (const s of store?.list?.() ?? []) headers.set(s.header.id, s.header)
  const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
  for (const h of (await persistence?.list?.()) ?? []) {
    if (!headers.has(h.id)) headers.set(h.id, h)
  }
  return headers
}

// ═══════════════════════ 会话查看(session_list / session_log)辅助 ═══════════════════════

interface SessionsStoreView {
  list?: () => { header: SessionHeader }[]
  get?: (id: SessionId) => (unknown & { header?: SessionHeader; log?: unknown[] }) | undefined
}
interface PersistenceView {
  list?: (signal?: AbortSignal) => Promise<SessionHeader[]>
  inspect?: (id: SessionId, signal?: AbortSignal) => Promise<{ meta: SessionHeader; events: readonly unknown[] }>
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

/** 从事件流解析会话实际运行的 preset: 最后一条 agent-preset/selected 优先, 其次 header.agentPreset(resolveSessionPreset 同款语义) */
function presetFromEvents(header: SessionHeader | undefined, events: readonly unknown[]): string | undefined {
  if (header === undefined) return undefined
  try {
    return resolveSessionPreset({ header, events: events as Parameters<typeof resolveSessionPreset>[0]['events'] })
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

/** 取 apiProxy(强转结构视图; 纯 headless 组合没有该服务时返回 undefined) */
function apiProxyOf(ctx: Context): ApiProxyView | undefined {
  return (ctx as unknown as { apiProxy?: ApiProxyView }).apiProxy
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

/**
 * 启动审批转接桥(P3)。apply() 末尾调用一次, 返回 dispose(卸载时清定时器/订阅/挂起表)。
 * 形态选择:
 *   - off            : 不做任何事(activeBridgeKind='off'; 审批回到部署默认行为 —— 无应答器即 fail-closed)。
 *   - web + apiProxy : activeBridgeKind='web'。订阅 apiProxy mux 流维护内存挂起表(open 时 apiproxy
 *                      会重放 still-pending 帧); 应答器是 apiproxy 自己, approval_respond 经它回答,
 *                      与 Web UI 双通道先答者胜(mux 收到 approval/resolved 即同步摘除)。
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
      activeBridgeKind = 'off'
    }
  }

  // builtin 降级/显式: 自注册 answerer(waterfall; 不调 next 即认领本次请求)
  activeBridgeKind = 'builtin'
  ctx.on('approval/request', (req, next) => {
    if (req.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')
    // 定位本次 ask 的 ApprovalRequestId: 从会话事件流倒序扫 asked/decided 配对(apiproxy 同款),
    // 跳过已 decided / 已在本表挂起的 id, callId 精确配对。
    const sess = req.agent?.session as unknown as PolicySessionLike | undefined
    const events = ((sess?.events ?? sess?.log) ?? []) as readonly unknown[]
    const decided = new Set<string>()
    let approvalId: string | undefined
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i] as { type?: string; data?: { id?: unknown; callId?: unknown } } | undefined
      if (ev?.type === 'approval/decided') {
        decided.add(String(ev.data?.id))
      } else if (ev?.type === 'approval/asked') {
        const id = String(ev.data?.id)
        if (decided.has(id) || pendingApprovals.has(id)) continue
        if ((req.callId ?? null) !== (ev.data?.callId ?? null)) continue
        approvalId = id
        break
      }
    }
    if (approvalId === undefined) return next()
    return new Promise<ApprovalOutcome>((resolve) => {
      armPendingApproval(ctx, {
        approvalId,
        sessionId: String(sess?.id ?? ''),
        toolName: typeof req.toolName === 'string' ? req.toolName : '?',
        ...(req.callId !== undefined ? { callId: String(req.callId) } : {}),
        ...(req.reason !== undefined ? { reason: String(req.reason) } : {}),
        requestedAt: Date.now(),
        settle: resolve,
      })
    })
  })
  return () => {
    for (const entry of [...pendingApprovals.values()]) clearApprovalTimer(entry)
    pendingApprovals.clear()
    activeBridgeKind = 'off'
  }
}

/** 会话粗粒度 updatedAt: live 取最后事件 time, persisted 取落盘文件 mtime, 都没有用 createdAt */
async function roughUpdatedAt(ctx: Context, header: SessionHeader): Promise<number> {
  const store = ctx.get('sessions') as SessionsStoreView | undefined
  const live = store?.get?.(header.id) as { log?: { time?: number }[] } | undefined
  const log = live?.log
  if (log && log.length > 0) {
    const t = Number(log[log.length - 1]?.time)
    if (Number.isFinite(t) && t > 0) return t
  }
  const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
  const loc = persistence?.locate?.(header)
  if (loc?.path) {
    try {
      return (await stat(loc.path)).mtimeMs
    } catch { /* 未落盘回退 createdAt */ }
  }
  return header.createdAt ?? 0
}

/** 单个会话的轻量检视: 消息条数 + 标题 + 统计摘要 + 权限档(persisted inspect 失败时回退 live log) */
async function inspectSessionRow(ctx: Context, header: SessionHeader): Promise<{
  messageCount: number
  title?: string
  inputTokens?: number
  outputTokens?: number
  llmTimeSec?: number
  sandboxMode?: SandboxMode
}> {
  const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
  try {
    const insp = await persistence?.inspect?.(SessionId(header.id))
    if (insp) return summarizeRow(insp.events.length, titleFromEvents(insp.events), insp.events)
  } catch { /* 回退 live */ }
  const store = ctx.get('sessions') as SessionsStoreView | undefined
  const live = store?.get?.(SessionId(header.id)) as { log?: unknown[] } | undefined
  if (live?.log) return summarizeRow(live.log.length, titleFromEvents(live.log), live.log)
  return { messageCount: 0 }
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
        const cd = d.chunk as { type?: string } | undefined
        if (openStep === null || openStep.turn !== Number(d.turn) || openStep.step !== Number(d.step)) break
        if (openStep.firstTokenTime === null && cd !== undefined && isTokenDelta(cd as Parameters<typeof isTokenDelta>[0])) openStep.firstTokenTime = t
        break
      }
      case 'assistant/message': {
        if (openStep === null || openStep.turn !== Number(d.turn) || openStep.step !== Number(d.step)) break
        s.llmMs += Math.max(0, t - openStep.startTime)
        if (openStep.firstTokenTime !== null) {
          s.ttftMs += Math.max(0, openStep.firstTokenTime - openStep.startTime)
          s.ttftSteps += 1
          const out1 = usageNum((d.usage as Record<string, unknown> | undefined)?.outputTokens)
          if (out1 > 0) {
            s.decodeMs += Math.max(0, t - openStep.firstTokenTime)
            s.decodeTokens += out1
          }
        }
        // token 用量累加(所有上报 usage 的消息)
        const u = d.usage as Record<string, unknown> | undefined
        if (u && typeof u === 'object') {
          s.inputTokens += usageNum(u.inputTokens)
          s.outputTokens += usageNum(u.outputTokens)
          s.cacheReadTokens += usageNum(u.cacheReadTokens)
          s.cacheWriteTokens += usageNum(u.cacheWriteTokens)
          s.reasoningTokens += usageNum(u.reasoningTokens)
        }
        openStep = null
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
    ttft: s.ttftSteps > 0 ? Math.round(s.ttftMs / s.ttftSteps) : null,
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
 * 读单会话事件流(session_search 用): persistence.inspect(带 AbortSignal+限时, 已解压事件)
 * → live log → locate(path) 落盘文件多帧 zstd 兜底。都不可得返回 undefined。
 */
async function readSessionEventsSearch(ctx: Context, header: SessionHeader): Promise<{ events: unknown[]; source: 'persisted' | 'live' | 'file' } | undefined> {
  const sid = SessionId(header.id)
  const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
  if (persistence?.inspect) {
    try {
      const insp = await withTimeout(persistence.inspect(sid, AbortSignal.timeout(SESSION_SEARCH_TIMEOUT_MS)), SESSION_SEARCH_TIMEOUT_MS + 500)
      if (insp) return { events: [...insp.events], source: 'persisted' }
    } catch { /* 未持久化/超时/中止 → 回退 */ }
  }
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
 * 收集一个会话的完整事件流(persisted inspect 优先, 回退 live store 日志)。
 * 返回 undefined 表示 live 与持久化里都没有该会话。
 */
async function collectSessionEvents(ctx: Context, sid: SessionId): Promise<{ events: unknown[]; source: 'persisted' | 'live' } | undefined> {
  const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
  try {
    const insp = await persistence?.inspect?.(sid)
    if (insp && insp.events.length > 0) return { events: [...insp.events], source: 'persisted' }
  } catch { /* 未持久化 → 回退 live */ }
  const store = ctx.get('sessions') as SessionsStoreView | undefined
  const live = store?.get?.(sid) as { log?: unknown[] } | undefined
  if (live?.log && live.log.length > 0) return { events: [...live.log], source: 'live' }
  // 两路都空: 若持久化 inspect 成功返回过 meta(空日志会话), 也算找到
  try {
    const insp = await persistence?.inspect?.(sid)
    if (insp) return { events: [], source: 'persisted' }
  } catch { /* ignore */ }
  return undefined
}

/** 单条日志事件 → 紧凑记录(stripReasoning 过滤 + 分字段限长); unknown 类型退化为 data JSON 摘录 */
function compactLogEvent(e: unknown): Record<string, unknown> {
  const ev = e as { type?: string; seq?: number; time?: number; data?: unknown }
  const base: Record<string, unknown> = { seq: ev.seq, type: ev.type, time: ev.time }
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
  const headers = await listMergedHeaders(ctx)

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
  mcp.tool('echo', '回显输入, 验证 MCP server 连通', { text: z.string() }, async ({ text }) => {
    return out(`收到: ${text} @ ${Date.now()}`)
  })

  mcp.tool('harness_list_tools', '列出 Harness 当前注册的所有工具名', {}, async () => {
    const tools = ctx.tools as unknown as { keys?: () => Iterable<string> } | null
    const names = tools && typeof tools.keys === 'function' ? Array.from(tools.keys()) : []
    return out(JSON.stringify(names))
  })

  mcp.tool('status_get', '查询 Harness/MCP 运行状态: 版本/运行时长/provider/model/preset/活动会话数/sandboxPolicy(默认权限档+审批桥形态+挂起审批数)。', {}, async () => {
    let queueActive = 0
    for (const t of taskQueue.values()) if (t.status === 'queued' || t.status === 'running') queueActive++
    let agentsLive = 0
    try {
      agentsLive = ctx.agents.list().length
    } catch {
      agentsLive = 0
    }
    return out(JSON.stringify({
      version: PLUGIN_VERSION,
      uptimeSec: Math.round(process.uptime()),
      startedAt: serverRuntime.startedAt,
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
      node: process.version,
      pid: process.pid,
    }, null, 2))
  })

  mcp.tool('config_get', '查询插件运行时配置摘要(authToken 打码为 ***, 不泄露密钥)。', {}, async () => {
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
      authTokenSet: Boolean(runtimeConfig.authToken),
      authToken: runtimeConfig.authToken ? '***' : '',
      workspaceRoots: runtimeConfig.workspaceRoots,
      enableFsWrite: runtimeConfig.enableFsWrite,
      // P3: 权限三档 + 审批桥配置摘要
      defaultSandbox: runtimeConfig.defaultSandbox,
      approvalsBridge: runtimeConfig.approvalsBridge,
      approvalTimeoutMs: runtimeConfig.approvalTimeoutMs,
    }, null, 2))
  })

  // ── P0: 文件查看(fs_read / fs_list / fs_stat) — 路径安全: ~/.dsh + 工作区白名单, 拒绝敏感名 ──
  mcp.tool(
    'fs_read',
    '读文本文件(仅限 ~/.dsh 与工作区白名单内; 拒绝 .ssh/.env/*token*/*.pem)。返回 {path,totalLines,content,truncated}。',
    {
      path: z.string().describe('绝对路径(会 realpath 规范化)'),
      offset: z.number().int().min(1).optional().describe('起始行(1-based, 默认 1)'),
      limit: z.number().int().min(1).max(2000).optional().describe('最多返回行数(默认 400)'),
    },
    async ({ path, offset, limit }) => {
      try {
        const gate = await gateFsPath(ctx, path)
        if (gate.error) return out(JSON.stringify({ error: gate.error }))
        const canonical = gate.canonical as string
        const st = await stat(canonical).catch(() => undefined)
        if (!st) return out(JSON.stringify({ error: `path not found: ${path}` }))
        if (st.isDirectory()) return out(JSON.stringify({ error: `is a directory, use fs_list: ${canonical}` }))
        if (st.size > FS_READ_MAX_FILE_BYTES) return out(JSON.stringify({ error: `file too large (${st.size} bytes > ${FS_READ_MAX_FILE_BYTES})` }))
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
        return out(JSON.stringify({ path: canonical, totalLines, offset: off, limit: lim, truncated, content }))
      } catch (e) {
        return out(JSON.stringify({ error: `fs_read failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  mcp.tool(
    'fs_list',
    '列目录(递归 depth 层, 默认 1)。敏感项(.ssh/.env/*token*/*.pem)从结果隐藏。返回 {path,entries:[{name,type,size,mtime}],truncated}。',
    {
      path: z.string().describe('目录绝对路径'),
      depth: z.number().int().min(1).max(5).optional().describe('递归层数(默认 1, 最大 5)'),
    },
    async ({ path, depth }) => {
      try {
        const gate = await gateFsPath(ctx, path)
        if (gate.error) return out(JSON.stringify({ error: gate.error }))
        const root = gate.canonical as string
        const maxDepth = Math.min(Math.max(1, Math.trunc(depth ?? 1)), 5)
        const entries: { name: string; type: string; size?: number; mtime?: number }[] = []
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
            let size: number | undefined
            let mtime: number | undefined
            try {
              const s = await stat(full)
              size = s.size
              mtime = Math.round(s.mtimeMs)
            } catch { /* 断链等: size/mtime 缺省 */ }
            entries.push({ name: full.slice(root.length + 1) || de.name, type, size, mtime })
            if (de.isDirectory() && level < maxDepth) await walk(full, level + 1)
          }
        }
        await walk(root, 1)
        return out(JSON.stringify({ path: root, depth: maxDepth, count: entries.length, truncated, entries }))
      } catch (e) {
        return out(JSON.stringify({ error: `fs_list failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  mcp.tool(
    'fs_stat',
    '查文件/目录元数据(同受路径安全策略约束)。返回 {exists,size,mtime,isDir,...}。',
    { path: z.string().describe('绝对路径') },
    async ({ path }) => {
      try {
        const gate = await gateFsPathSoft(ctx, path)
        if (gate.error) return out(JSON.stringify({ error: gate.error }))
        if (gate.missing) return out(JSON.stringify({ exists: false, path: gate.canonical }))
        const canonical = gate.canonical as string
        const st = await stat(canonical).catch(() => undefined)
        if (!st) return out(JSON.stringify({ exists: false, path: canonical }))
        return out(JSON.stringify({
          exists: true,
          path: canonical,
          size: st.size,
          mtime: Math.round(st.mtimeMs),
          isDir: st.isDirectory(),
          isFile: st.isFile(),
        }))
      } catch (e) {
        return out(JSON.stringify({ error: `fs_stat failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // ── P1: fs_write(opt-in) — 默认不注册; 打开后仅限 workspaceRoots 内 + 敏感名拒绝 ──
  if (runtimeConfig.enableFsWrite) {
    mcp.tool(
      'fs_write',
      '写文本文件(P1, opt-in)。仅限 workspaceRoots 白名单内(路径 jail), 拒绝 .ssh/.env/*token*/*.pem。mode: overwrite(默认)|append|create-new。',
      {
        path: z.string().describe('文件绝对路径(可不存在, 父目录自动创建)'),
        content: z.string().describe('要写入的 UTF-8 文本(上限 4MB)'),
        mode: z.enum(['overwrite', 'append', 'create-new']).optional().describe('写入模式(默认 overwrite; create-new 在已存在时报错)'),
      },
      async ({ path, content, mode }) => {
        try {
          const m = mode ?? 'overwrite'
          const bytes = Buffer.byteLength(content, 'utf8')
          if (bytes > FS_WRITE_MAX_BYTES) {
            return out(JSON.stringify({ error: `content too large (${bytes} bytes > ${FS_WRITE_MAX_BYTES})` }))
          }
          const gate = await gateFsWritePath(path)
          if (gate.error) return out(JSON.stringify({ error: gate.error }))
          const canonical = gate.canonical as string
          if (m === 'create-new') {
            const exists = await stat(canonical).then(() => true, () => false)
            if (exists) return out(JSON.stringify({ error: `file already exists (mode=create-new): ${canonical}` }))
          }
          await mkdir(dirname(canonical), { recursive: true })
          if (m === 'append') {
            await appendFile(canonical, content, 'utf8')
          } else {
            await writeFile(canonical, content, 'utf8')
          }
          return out(JSON.stringify({ ok: true, path: canonical, bytes, mode: m }))
        } catch (e) {
          return out(JSON.stringify({ error: `fs_write failed: ${(e as Error)?.message ?? String(e)}` }))
        }
      },
    )
  }

  // ── P0: 会话管理(session_list / session_log) ──
  mcp.tool(
    'session_list',
    '列出会话(live+持久化合并): [{id,title,cwd,updatedAt,messageCount,inputTokens,outputTokens,llmTime}]。cwd 可按工作区过滤。',
    {
      cwd: z.string().optional().describe('按工作目录过滤(realpath 规范化后精确匹配)'),
      limit: z.number().int().min(1).max(SESSION_LIST_MAX_ROWS).optional().describe('返回条数上限(默认 20)'),
    },
    async ({ cwd, limit }) => {
      try {
        const max = Math.min(Math.max(1, Math.trunc(limit ?? 20)), SESSION_LIST_MAX_ROWS)
        // live + 持久化合并(live 优先), 按 id 去重(与存量捞回/session_search 共用)
        const headers = await listMergedHeaders(ctx)
        let rows = [...headers.values()]
        // cwd 过滤: 双侧 realpath 规范化后精确比对
        if (cwd) {
          const target = await canonicalCwd(resolve(cwd))
          const filtered: SessionHeader[] = []
          for (const h of rows) {
            if (h.cwd === undefined) continue
            if (await canonicalCwd(h.cwd) === target) filtered.push(h)
          }
          rows = filtered
        }
        // 粗排(updatedAt desc) → 截断 → 细检视(messageCount/title/统计是重操作, 只对返回行做)
        const withRough = await Promise.all(rows.map(async (h) => ({ h, at: await roughUpdatedAt(ctx, h) })))
        withRough.sort((a, b) => b.at - a.at)
        const selected = withRough.slice(0, max)
        const sessions = await Promise.all(selected.map(async ({ h, at }) => {
          const detail = await inspectSessionRow(ctx, h)
          return {
            id: h.id,
            title: detail.title ?? `(untitled ${String(h.id).slice(0, 8)})`,
            cwd: h.cwd,
            createdAt: h.createdAt,
            updatedAt: Math.round(at),
            messageCount: detail.messageCount,
            // P1: 统计摘要(全会话累计)
            inputTokens: detail.inputTokens ?? 0,
            outputTokens: detail.outputTokens ?? 0,
            llmTime: detail.llmTimeSec ?? 0,
            // P3: 会话生效权限档(有 sandbox/mode 记录才带此字段)
            ...(detail.sandboxMode !== undefined ? { sandboxMode: detail.sandboxMode } : {}),
          }
        }))
        sessions.sort((a, b) => b.updatedAt - a.updatedAt)
        return out(JSON.stringify({ total: rows.length, count: sessions.length, truncated: rows.length > sessions.length, sessions }))
      } catch (e) {
        return out(JSON.stringify({ error: `session_list failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  mcp.tool(
    'session_log',
    '读会话日志(stripReasoning 已剥离 thinking/reasoning 块)。tail 取最后 N 条; types 过滤事件类型。',
    {
      sessionId: z.string().describe('会话 id(live 或已持久化)'),
      tail: z.number().int().min(1).max(500).optional().describe('取最后 N 条匹配事件(默认 50)'),
      types: z.array(z.string()).optional().describe('事件类型过滤(默认 user/message,assistant/message,tool/call,tool/result)'),
    },
    async ({ sessionId, tail, types }) => {
      try {
        const sid = SessionId(sessionId)
        let meta: SessionHeader | undefined
        let events: unknown[] = []
        // persisted 优先(inspect 对 live 会话也会给出当前不可变快照)
        const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
        try {
          const insp = await persistence?.inspect?.(sid)
          if (insp) {
            meta = insp.meta
            events = [...insp.events]
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
          return out(JSON.stringify({ error: `session not found: ${sessionId}` }))
        }
        const wanted = types && types.length > 0 ? types : DEFAULT_LOG_TYPES
        const filtered = events.filter((e) => wanted.includes((e as { type?: string })?.type ?? ''))
        const totalMatched = filtered.length
        const n = Math.min(Math.max(1, Math.trunc(tail ?? 50)), 500)
        const sliced = filtered.slice(-n)
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
        const truncated = shown < sliced.length || totalMatched > shown
        return out(JSON.stringify({
          sessionId,
          header: meta ? { cwd: meta.cwd, createdAt: meta.createdAt, preset: presetFromEvents(meta, events) } : undefined,
          types: wanted,
          totalMatched,
          shown,
          truncated,
          events: records,
        }))
      } catch (e) {
        return out(JSON.stringify({ error: `session_log failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // ── P1: 会话统计(session_stats) ──
  mcp.tool(
    'session_stats',
    '会话统计(rounds/steps/llmTime/toolTime/ttft/tokensPerSec/cacheHitRate/inputTokens/outputTokens)。无 sessionId 返回当前 Agent 会话(最近一次 agent_run/task 的会话); 有 sessionId 返回指定会话的全会话累计。',
    { sessionId: z.string().optional().describe('会话 id(缺省 = 当前 Agent 会话)') },
    async ({ sessionId }) => {
      try {
        let target = sessionId
        let source: string | undefined
        if (!target) {
          if (lastAgentSessionId === undefined) {
            return out(JSON.stringify({ error: 'no active agent session yet (run agent_run first, or pass sessionId)' }))
          }
          target = lastAgentSessionId
        }
        const found = await collectSessionEvents(ctx, SessionId(target))
        if (found === undefined) {
          return out(JSON.stringify({ error: `session not found: ${target}` }))
        }
        source = found.source
        const stats = presentSessionStats(foldSessionStats(found.events), { scope: 'session', sessionId: target })
        return out(JSON.stringify({ ...stats, source }, null, 2))
      } catch (e) {
        return out(JSON.stringify({ error: `session_stats failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // ── P2: 跨会话搜索(session_search) ──
  mcp.tool(
    'session_search',
    '跨会话搜索: 标题匹配 + 尽力内容搜索(持久化事件, 单会话 2s 超时跳过)。返回 {query,regex,total,count,content_search,results:[{sessionId,title,cwd,updatedAt,matched,snippet?}]}(≤20 条)。',
    {
      query: z.string().min(1).describe('搜索词(regex=false 时为大小写不敏感子串)'),
      cwd: z.string().optional().describe('按工作目录过滤(realpath 规范化后精确匹配)'),
      regex: z.boolean().optional().describe('把 query 当正则(默认 false)'),
      limit: z.number().int().min(1).max(200).optional().describe('最多扫描最近 N 个会话(默认 50)'),
    },
    async ({ query, cwd, regex, limit }) => {
      try {
        if (!query || !query.trim()) return out(JSON.stringify({ error: 'query must not be empty' }))
        let re: RegExp | undefined
        if (regex) {
          try {
            re = new RegExp(query)
          } catch (e) {
            return out(JSON.stringify({ error: `invalid regex: ${(e as Error)?.message ?? String(e)}` }))
          }
        }
        const needle = query.toLowerCase()
        const maxScan = Math.min(Math.max(1, Math.trunc(limit ?? 50)), 200)
        const headers = await listMergedHeaders(ctx)
        let rows = [...headers.values()]
        // cwd 过滤: 双侧 realpath 规范化后精确比对
        if (cwd) {
          const target = await canonicalCwd(resolve(cwd))
          const filtered: SessionHeader[] = []
          for (const h of rows) {
            if (h.cwd === undefined) continue
            if (await canonicalCwd(h.cwd) === target) filtered.push(h)
          }
          rows = filtered
        }
        // 粗排(updatedAt desc)取最近 N 个扫描
        const withRough = await Promise.all(rows.map(async (h) => ({ h, at: await roughUpdatedAt(ctx, h) })))
        withRough.sort((a, b) => b.at - a.at)
        const scanned = withRough.slice(0, maxScan)
        // 并发 8 消费; 单会话读取有 ~2s 时限, 最坏总耗时 ≈ ceil(N/8)*2s
        const hits: SessionSearchRow[] = []
        let contentSearched = false
        const queue = [...scanned]
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
        return out(JSON.stringify({
          query,
          regex: Boolean(regex),
          total: scanned.length,
          count: hits.length,
          truncated: hits.length > 20,
          content_search: contentSearched,
          results: hits.slice(0, 20),
        }, null, 2))
      } catch (e) {
        return out(JSON.stringify({ error: `session_search failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // ── P0: preset(preset_list / preset_get) ──
  mcp.tool(
    'preset_list',
    '列出可用 agent preset(standard/code/minimal/cordis 及本地自研)与默认 preset。',
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
    '查询会话实际运行的 preset(header.agentPreset + agent-preset/selected 事件最新者胜); 无 sessionId 时返回默认 preset。',
    { sessionId: z.string().optional().describe('要查询的会话 id(缺省返回默认 preset)') },
    async ({ sessionId }) => {
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
        // 2) 持久化 inspect
        const persistence = ctx.get('sessionPersistence') as PersistenceView | undefined
        try {
          const insp = await persistence?.inspect?.(sid)
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
    '切换 agent preset。scope=new-default(默认): 更新运行时默认 preset(本服务新建会话生效 + 尽力写全局用户默认)。scope=session: 切换指定会话的 preset, 仅空白会话(未开始任何 turn)可切换, 非空白报错。',
    {
      presetId: z.string().describe('目标 preset id(见 preset_list)'),
      scope: z.enum(['new-default', 'session']).optional().describe('切换范围(默认 new-default)'),
      sessionId: z.string().optional().describe('scope=session 时的目标会话 id'),
    },
    async ({ presetId, scope, sessionId }) => {
      const kind = scope ?? 'new-default'
      try {
        if (kind === 'session') {
          if (!sessionId) return out(JSON.stringify({ error: 'scope=session requires sessionId' }))
          const sid = SessionId(sessionId)
          // 空白校验先行(官方 api-proxy select 同款: log 里出现过 turn/start 即视为已开始)
          const found = await collectSessionEvents(ctx, sid)
          if (found === undefined) {
            return out(JSON.stringify({ error: `session not found: ${sessionId}` }))
          }
          if (found.events.some((e) => (e as { type?: string })?.type === 'turn/start')) {
            return out(JSON.stringify({ error: `session ${sessionId} has already started; its agent preset is fixed (only blank sessions can switch)` }))
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
              return out(JSON.stringify({ ok: true, scope: 'session', sessionId, preset: preset.id, source: 'live' }))
            } catch (e) {
              return out(JSON.stringify({ error: `preset switch failed: ${(e as Error)?.message ?? String(e)}` }))
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
            return out(JSON.stringify({ error: `failed to resume blank session ${sessionId}: ${(e as Error)?.message ?? String(e)}` }))
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
          return out(JSON.stringify({ ok: true, scope: 'session', sessionId, preset: presetId, source: 'resumed' }))
        }
        // scope=new-default: 先验证 preset 存在, 再更新本服务运行时默认 + 尽力写全局用户默认
        try {
          await ctx.agentPresets.resolve(presetId)
        } catch (e) {
          return out(JSON.stringify({ error: `unknown preset "${presetId}": ${(e as Error)?.message ?? String(e)}` }))
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
        return out(JSON.stringify({ error: `preset_set failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // ── P3: 权限三档(policy_get / set_policy) ──
  mcp.tool(
    'policy_get',
    '查询会话生效策略: {sessionId,sandboxMode,source:override|default,workspaceRoot,approvalPolicy}。sandboxMode 取最后一条 sandbox/mode 事件(无则 defaultSandbox); approvalPolicy 取最后一条 approval/policy(无则部署默认)。无 sessionId 返回部署默认。',
    { sessionId: z.string().optional().describe('会话 id(缺省返回部署默认档)') },
    async ({ sessionId }) => {
      try {
        if (!sessionId) {
          return out(JSON.stringify({
            sandboxMode: runtimeConfig.defaultSandbox,
            source: 'default',
            workspaceRoot: process.cwd(),
            approvalPolicy: deploymentApprovalPolicy(ctx),
          }, null, 2))
        }
        const sid = SessionId(sessionId)
        const found = await collectSessionEvents(ctx, sid)
        if (found === undefined) {
          return out(JSON.stringify({ error: `session not found: ${sessionId}` }))
        }
        const override = sandboxModeFromEvents(found.events)
        const header = await findSessionHeader(ctx, sid)
        return out(JSON.stringify({
          sessionId,
          sandboxMode: override ?? runtimeConfig.defaultSandbox,
          source: override !== undefined ? 'override' : 'default',
          workspaceRoot: header?.cwd !== undefined ? await canonicalCwd(header.cwd) : process.cwd(),
          approvalPolicy: approvalPolicyFromEvents(found.events) ?? deploymentApprovalPolicy(ctx),
        }, null, 2))
      } catch (e) {
        return out(JSON.stringify({ error: `policy_get failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  mcp.tool(
    'set_policy',
    '切换已存在会话的文件权限档。mode: read-only(只读)|workspace-write(工作区可写)|danger-full-access(完全绕过围栏+bash 解禁, 无审批任意读写, 仅限可信环境)。仅 live 会话可切(追加 sandbox/mode 事件, 下一次受限调用生效, 重启靠 replay 保持); 冷会话需先 resume(agent_run/task_inbox 带该 sessionId 跑一轮)再切。',
    {
      sessionId: z.string().describe('目标会话 id'),
      mode: z.enum(SANDBOX_MODES).describe('目标权限档'),
    },
    async ({ sessionId, mode }) => {
      try {
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
            error: `session ${sessionId} is not live; cold/persisted sessions must be resumed first (run agent_run or task_inbox with this sessionId), then set_policy`,
          }))
        }
        appendSandboxMode(target, mode)
        return out(JSON.stringify({ ok: true, sessionId, sandboxMode: mode, source: 'live' }))
      } catch (e) {
        return out(JSON.stringify({ error: `set_policy failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // ── P3: 审批桥(approval_list / approval_respond) ──
  mcp.tool(
    'approval_list',
    '列出当前挂起的审批(如沙箱提档 escalation): [{approvalId,sessionId,toolName,callId?,reason?,requestedAt,waitedMs}]。配合 approval_respond 回答; 审批未决期间 agent_run/task_inbox 会一直挂起(超时由 approvalTimeoutMs 兜底收尾, 绝不超时放行)。',
    {},
    async () => {
      const now = Date.now()
      const approvals = [...pendingApprovals.values()].map((e) => ({
        approvalId: e.approvalId,
        sessionId: e.sessionId,
        toolName: e.toolName,
        ...(e.callId !== undefined ? { callId: e.callId } : {}),
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
        requestedAt: e.requestedAt,
        waitedMs: now - e.requestedAt,
      }))
      return out(JSON.stringify({
        bridge: activeBridgeKind,
        count: approvals.length,
        timeoutMs: runtimeConfig.approvalTimeoutMs,
        approvals,
      }, null, 2))
    },
  )

  mcp.tool(
    'approval_respond',
    '回答挂起审批: outcome=allowed-once(仅本次调用放行)|rejected(拒绝)。与 Web UI 双通道先答者胜 —— 已被回答/超时/撤销的审批回 receipt=not-pending。⚠️ 这等于远程提权按钮: MCP server 暴露非 loopback 时必须开 authToken。',
    {
      approvalId: z.string().describe('approval_list 返回的审批 id'),
      sessionId: z.string().describe('发起审批的会话 id(须与审批归属一致)'),
      outcome: z.enum(['allowed-once', 'rejected']).describe('allowed-once=本次放行; rejected=拒绝'),
    },
    async ({ approvalId, sessionId, outcome }) => {
      try {
        const entry = pendingApprovals.get(approvalId)
        if (!entry) {
          return out(JSON.stringify({ ok: false, receipt: 'not-pending', approvalId, note: '不存在/已被回答/已超时(先答者胜)' }))
        }
        if (entry.sessionId !== sessionId) {
          return out(JSON.stringify({ ok: false, error: `sessionId mismatch: approval ${approvalId} belongs to session ${entry.sessionId}` }))
        }
        const r = await respondToApproval(ctx, entry, outcome)
        return out(JSON.stringify({
          ok: r.accepted,
          receipt: r.accepted ? 'accepted' : (r.reason ?? 'not-pending'),
          approvalId,
          sessionId,
          outcome,
        }))
      } catch (e) {
        return out(JSON.stringify({ error: `approval_respond failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // 同步执行任务(简单场景: Hermes 下发 → 立即拿结果)
  mcp.tool(
    'agent_run',
    '同步执行任务(改代码/分析/跑命令), 返回结构化结果。可传 sessionId 续接已有会话(长任务分多轮投喂)。需要提档审批(escalation)时会挂起等待审批 —— 审批未决期间本调用阻塞, 可用 approval_list/approval_respond 回答, 超时(approvalTimeoutMs)收尾为取消, 绝不超时放行; 长阻塞场景建议改用 task_inbox。',
    {
      task: z.string().describe('要 Harness 执行的自然语言任务'),
      context: z.string().optional().describe('Hermes 记忆/上下文, 注入给 agent 参考'),
      cwd: z.string().optional().describe('工作目录(默认当前)'),
      sessionId: z.string().optional().describe('续接已有会话的 sessionId(来自上次 agent_run 结果里的 sessionId 字段)'),
      title: z.string().optional().describe('新会话的标题(创建时命名, 便于会话列表归档)'),
      preset: z.string().optional().describe('本次任务的 preset 覆盖(见 preset_list); 仅影响新建/resume 的会话组合, 已有会话保持原 preset'),
      sandbox: z.enum(SANDBOX_MODES).optional().describe('本次任务的文件权限三档覆盖: read-only|workspace-write|danger-full-access; 仅影响新建/resume 的会话组合, 已有会话保持原档位(切换用 set_policy); danger-full-access=无审批任意读写, 仅限可信环境'),
    },
    async ({ task, context, cwd, sessionId, title, preset, sandbox }) => {
      // A/P3: 请求级参数预检(preset 未知即拒带 available 名单; sandbox 由 schema 枚举兜底再校验一次)
      if (preset) {
        const bad = await presetOverrideError(ctx, preset)
        if (bad) return out(JSON.stringify({ error: bad }))
      }
      if (sandbox !== undefined && !(SANDBOX_MODES as readonly string[]).includes(sandbox)) {
        return out(JSON.stringify({ error: `invalid sandbox "${sandbox}"; valid modes: ${SANDBOX_MODES.join('|')}` }))
      }
      const result = await executeTask(ctx, task, context ?? '', cwd ?? process.cwd(), sessionId, title, {
        ...(preset ? { preset } : {}),
        ...(sandbox !== undefined ? { sandbox } : {}),
      })
      return out(JSON.stringify(truncateResult(result), null, 2))
    },
  )

  // 异步 push 任务到队列(Hermes → Harness 任务入口)
  mcp.tool(
    'task_inbox',
    'Hermes 把结构化任务(任务+记忆上下文)推入 Harness 队列, 异步执行, 返回 taskId。记忆喂编码的入口。审批转接(P3)的主路径: 任务挂起等审期间轮询 approval_list → approval_respond 即可续跑。',
    {
      task: z.string().describe('任务内容'),
      context: z.string().optional().describe('Hermes 记忆/上下文, 随任务注入给 agent'),
      cwd: z.string().optional().describe('工作目录'),
      sessionId: z.string().optional().describe('续接已有会话的 sessionId(来自上次 agent_run 结果)'),
      title: z.string().optional().describe('新会话的标题(创建时命名)'),
      preset: z.string().optional().describe('本次任务的 preset 覆盖(见 preset_list); 仅影响新建/resume 的会话组合'),
      sandbox: z.enum(SANDBOX_MODES).optional().describe('本次任务的文件权限三档覆盖: read-only|workspace-write|danger-full-access; 仅影响新建/resume 的会话组合, 已有会话保持原档位'),
    },
    async ({ task, context, cwd, sessionId, title, preset, sandbox }) => {
      // A/P3: 请求级参数预检(入队前即拒, 不占队列容量)
      if (preset) {
        const bad = await presetOverrideError(ctx, preset)
        if (bad) return out(JSON.stringify({ error: bad }))
      }
      if (sandbox !== undefined && !(SANDBOX_MODES as readonly string[]).includes(sandbox)) {
        return out(JSON.stringify({ error: `invalid sandbox "${sandbox}"; valid modes: ${SANDBOX_MODES.join('|')}` }))
      }
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
        id, task, context: context ?? '', cwd: cwd ?? process.cwd(), status: 'queued', createdAt: now,
        ...(sessionId ? { sessionId } : {}),
        ...(title ? { title } : {}),
        ...(preset ? { preset } : {}),
        ...(sandbox !== undefined ? { sandbox } : {}),
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
      })()
      return out(JSON.stringify({ taskId: id, status: 'queued' }))
    },
  )

  // 取回任务结果(结构化 changes/verification/leftovers)
  mcp.tool(
    'task_result',
    '取回 task_inbox 提交任务的结构化结果(changes/verification/leftovers)。',
    { taskId: z.string().describe('task_inbox 返回的 taskId') },
    async ({ taskId }) => {
      const item = taskQueue.get(taskId)
      if (!item) return out(JSON.stringify({ error: `task not found: ${taskId}` }))
      return out(JSON.stringify({
        taskId: item.id,
        status: item.status,
        error: item.error,
        result: item.result ? truncateResult(item.result) : undefined,
      }, null, 2))
    },
  )

  // ── P1: 任务队列快照(task_list) ──
  mcp.tool(
    'task_list',
    '异步任务队列快照: [{id,status,createdAt,error,...}](新任务在前, 最多 100 条)。status ∈ queued|running|done|error|cancelled。',
    {},
    async () => {
      try {
        const all = [...taskQueue.values()].sort((a, b) => b.createdAt - a.createdAt)
        const active = all.filter((t) => t.status === 'queued' || t.status === 'running').length
        const tasks = all.slice(0, 100).map((t) => ({
          id: t.id,
          status: t.status,
          createdAt: t.createdAt,
          ...(t.finishedAt !== undefined ? { finishedAt: t.finishedAt } : {}),
          ...(t.error !== undefined ? { error: t.error } : {}),
          ...(t.title ? { title: t.title } : {}),
          ...(t.preset ? { preset: t.preset } : {}),
          // P3: 请求级权限档回显
          ...(t.sandbox !== undefined ? { sandbox: t.sandbox } : {}),
          cwd: t.cwd,
          ...(t.sessionId ? { sessionId: t.sessionId } : {}),
          hasResult: Boolean(t.result),
        }))
        return out(JSON.stringify({ total: all.length, active, count: tasks.length, truncated: all.length > tasks.length, tasks }, null, 2))
      } catch (e) {
        return out(JSON.stringify({ error: `task_list failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // ── P2: 取消队列任务(task_cancel) ──
  mcp.tool(
    'task_cancel',
    '取消 task_inbox 提交的任务。queued: 直接移除; running: 尽力中止(agent.cancel, 结果丢弃, 会话保留可续接; 未起 agent 时在锁内协作取消); done/error/cancelled/不存在: 明确报错不可取消。',
    { taskId: z.string().describe('task_inbox 返回的 taskId') },
    async ({ taskId }) => {
      try {
        const item = taskQueue.get(taskId)
        if (!item) return out(JSON.stringify({ ok: false, error: `task ${taskId} not cancellable (status=missing)` }))
        if (item.status === 'queued') {
          // 还没开跑(仅存在于入队同 tick 的窗口): 直接出队即取消
          item.status = 'cancelled'
          taskQueue.delete(taskId)
          return out(JSON.stringify({ ok: true, status: 'cancelled', was: 'queued', taskId }))
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
              return out(JSON.stringify({ ok: true, status: 'cancelled', was: 'running', taskId, note: 'agent not started yet; will be cancelled at cooperative checkpoint' }))
            }
            return out(JSON.stringify({ ok: false, error: 'task running; no abort API', hint: '等待完成或 sessionId 续接接管' }))
          }
          // 先置标志再 cancel: 防 whenIdle 恰在此间收敛、runner 抢先落 done 的竞态
          item.cancelled = true
          try {
            agent.cancel({ kind: 'user' })
          } catch (e) {
            delete item.cancelled
            return out(JSON.stringify({ ok: false, error: `cancel failed: ${(e as Error)?.message ?? String(e)}`, hint: '等待完成或 sessionId 续接接管' }))
          }
          return out(JSON.stringify({ ok: true, status: 'cancelled', was: 'running', taskId, sessionId: sid, note: 'abort requested; result will be discarded' }))
        }
        return out(JSON.stringify({ ok: false, error: `task ${taskId} not cancellable (status=${item.status})` }))
      } catch (e) {
        return out(JSON.stringify({ error: `task_cancel failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // 给已有会话改名(走 sessionTitle 服务, 便于会话列表归档)
  mcp.tool(
    'rename_session',
    '给已有会话改名(走 sessionTitle 服务的 rename), 便于会话列表归档区分。',
    {
      sessionId: z.string().describe('要改名的会话 id(来自 agent_run 结果里的 sessionId 字段)'),
      title: z.string().describe('新标题'),
    },
    async ({ sessionId, title }) => {
      try {
        const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
        const session = sessions?.get?.(sessionId)
        if (!session) return out(JSON.stringify({ error: `session not found: ${sessionId}` }))
        const st = ctx.get('sessionTitle') as { rename?: (s: unknown, t: string) => unknown } | undefined
        if (!st?.rename) return out(JSON.stringify({ error: 'sessionTitle service unavailable' }))
        const snapshot = st.rename(session, title) as { title?: string } | undefined
        return out(JSON.stringify({ ok: true, sessionId, title: snapshot?.title ?? title }))
      } catch (e) {
        return out(JSON.stringify({ error: String(e) }))
      }
    },
  )

  // 手动归组补给站: 官方 UI 没有"移动会话到工作区"功能, 本工具供随时归组
  mcp.tool(
    'attach_session',
    '把会话归组到工作区(补给站: 官方 UI 无移动会话功能)。path 缺省用该会话 header 的 cwd; 归组依赖官方 attachSession 的强校验——realpath(header.cwd) 必须与工作区路径精确相等, 不匹配会返回官方报错。',
    {
      sessionId: z.string().describe('要归组的会话 id(live 或已持久化)'),
      path: z.string().optional().describe('目标工作区目录(缺省: 会话 header 的 cwd)'),
    },
    async ({ sessionId, path }) => {
      const sid = SessionId(sessionId)
      const header = await findSessionHeader(ctx, sid)
      if (header === undefined) {
        return out(JSON.stringify({ error: `session not found: ${sessionId}(live 与持久化里都没有)` }))
      }
      const target = path ?? header.cwd
      if (target === undefined) {
        return out(JSON.stringify({ error: `session ${sessionId} 的 header 没有 cwd, 官方 attachSession 无法校验, 不能归组` }))
      }
      try {
        const canonical = await realpath(target) // 目标必须是存在的目录, 否则 ENOENT
        const ws = await ensureWorkspace(ctx, canonical)
        if (!ws?.attachSession) return out(JSON.stringify({ error: 'workspaceRegistry unavailable' }))
        if (ws.sessionIds.includes(sid)) {
          return out(JSON.stringify({ sessionId, workspaceId: ws.id, workspacePath: ws.path, attached: false, note: 'already attached' }))
        }
        await ws.attachSession(sid)
        return out(JSON.stringify({ sessionId, workspaceId: ws.id, workspacePath: ws.path, attached: true }))
      } catch (e) {
        return out(JSON.stringify({ error: `attach failed: ${(e as Error)?.message ?? String(e)}` }))
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
    if (config.approvalsBridge === 'web' || config.approvalsBridge === 'builtin' || config.approvalsBridge === 'off') {
      runtimeConfig.approvalsBridge = config.approvalsBridge
    } else {
      console.warn(`[harness-mcp-server] invalid approvalsBridge "${String(config.approvalsBridge)}", keep default "web" (valid: web|builtin|off)`)
    }
  }
  if (config.approvalTimeoutMs !== undefined && Number.isFinite(config.approvalTimeoutMs) && config.approvalTimeoutMs > 0) {
    runtimeConfig.approvalTimeoutMs = Math.trunc(config.approvalTimeoutMs)
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
export const __internals = { taskQueue, taskRunSessions, pendingApprovals, get activeBridgeKind() { return activeBridgeKind } }

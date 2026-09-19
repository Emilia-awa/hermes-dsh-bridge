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
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { Context } from '@deepseek-ai/cordis';
/** Cordis 插件名 */
export declare const name = "harness-mcp-server";
/**
 * 会话文件权限三档(与 dsh-sandbox 的 SandboxMode 一一对应; 不直接 import 该包, 免新增运行时依赖):
 *   - read-only         : 只读(仅 /dev/null 等必要 sink 可写)
 *   - workspace-write   : 工作区 + 后端临时区可写(默认)
 *   - danger-full-access: 完全绕过文件围栏 + bash 解禁, 全程无审批 —— 仅限可信环境
 * 写入路径与 dsh-sandbox-policy 的 setSandboxMode 相同: session.append('sandbox/mode', {mode}),
 * 下一次受限调用生效, 重启靠 replay 保持。
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
/** 审批桥形态: web=订阅 apiProxy mux 复用 Web 审批通道(默认; dsh 0.1.2 起 headless 组合无 apiProxy 服务, 该模式自动降级 builtin); builtin=插件内建应答器; off=关闭桥 */
export type ApprovalsBridge = 'web' | 'builtin' | 'off' | 'file-push';
/**
 * 声明依赖的核心服务。
 * workspaceRegistry/sessionPersistence/sessions 是续接/归组三个增量用到的服务——
 * 漏声明会在真实启动时拿不到服务(本插件曾经踩过, 务必与代码里的 ctx.get 对齐)。
 */
export declare const inject: string[];
/** 插件配置 */
export interface Config {
    http?: boolean;
    port?: number;
    host?: string;
    /** 后端 provider(默认 deepseek-official) */
    provider?: string;
    /** 执行任务的模型(默认空 = 跟随 dsh 的用户/默认设置; 配置了才覆盖) */
    model?: string;
    /** 挂载的 agent preset(默认 standard) */
    preset?: string;
    /** 任务队列容量上限(默认 100) */
    maxQueue?: number;
    /** 已完成任务保留毫秒数(默认 10 分钟) */
    taskTtlMs?: number;
    /** 常驻 agent 会话上限(默认 8, LRU 淘汰) */
    maxAgents?: number;
    /** Bearer token 认证(设置后所有请求必须带 Authorization: Bearer <token>) */
    authToken?: string;
    /** cwd 白名单(设置后 agent 只能在列出的目录下干活) */
    workspaceRoots?: string[];
    /** 是否注册 fs_write 工具(P1, 默认关闭; 打开后也仅限 workspaceRoots 内) */
    enableFsWrite?: boolean;
    /** 新建/resume 会话的默认文件权限档(默认 'workspace-write'; danger-full-access=无审批任意读写, 仅限可信环境) */
    defaultSandbox?: SandboxMode;
    /** 审批桥模式(P3, 默认 'web'; deprecated: dsh 0.1.2 起不 inject apiProxy, headless 组合下 web 自动降级 builtin): web=订阅 apiProxy mux 复用 Web 审批通道; builtin=插件内建应答器(apiProxy 缺失时自动降级); off=关闭桥(审批回到 fail-closed) */
    approvalsBridge?: ApprovalsBridge;
    /** 审批等待超时毫秒(P3, 默认 300000)。超时 settle cancelled(builtin)/rejected(web 协议无 cancelled) —— 绝不超时放行 */
    approvalTimeoutMs?: number;
    /** 审批文件推送目录(P3 file-push 桥, 默认 ~/.dsh/approvals/)。Hermes 将在该目录下发现 pending_<id>.json 并写 response_<id>.json 回答 */
    approvalFileDir?: string;
    /** [P0 回调] 任务回调全局开关(默认 true; false 时所有 callback 参数直接 skipped, 纯逃生阀) */
    notifyEnabled?: boolean;
    /** [P0 回调] 默认回调密钥(任务级 callback.secret 缺省时使用; 空=不签名) */
    defaultCallbackSecret?: string;
    /** [P0 回调] 私网/回环回调目标放行名单(精确 host:port 或 host; 命中即放行 SSRF 私网拦截; 用于本机内网 Hermes 网关) */
    allowedCallbackHosts?: string[];
}
/**
 * [r3] C: 三类错误统一文案构造器 —— `<错误>: <关键值> (<原因一句话>; <下一步动作>)`。
 * 所有工具的错误串都经此拼装(不再各自手写后缀), 保证 agent 每次都能读到"下一步动作"。
 */
declare function errText(code: string, key: string, reason: string, next: string): string;
/** [r3] C: 必传参数缺失(含期望类型, 便于 agent 直接改对) */
declare function missingParamError(tool: string, param: string, expected: string): string;
/** [r3] C: id 不存在(会话/任务/preset 三类共用同一句式) */
declare function idNotFoundError(kind: 'session' | 'task' | 'preset', id: string, next: string): string;
/** [r3] C: 会话为空(存在但没有任何事件) */
declare function emptySessionError(sessionId: string): string;
/**
 * [r3] C: dsh 服务未启动/连接拒绝的判定(错误串或 error.code 命中即算)。
 * 命中后统一附「检查 dsh.service 状态」指引, 避免 agent 只看到裸 ECONNREFUSED。
 */
declare function isDshServiceDown(e: unknown): boolean;
/** [r3] C: 所有工具 catch 分支的兜底包装 —— 服务类错误走 dsh.service 指引, 其余原样补原因 */
declare function toolFailure(tool: string, e: unknown): string;
/**
 * [r3] C: 参数预校验(在工具入口统一调用, 早于任何业务逻辑)。
 * 只校验"必填存在 + 类型"两类, 报错回显 `expected X, got Y`; 全部通过返回 undefined。
 */
declare function validateArgs(tool: string, args: Record<string, unknown>, spec: {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    required?: boolean;
}[]): string | undefined;
/** [r3] A: 时间戳统一输出形态 —— 人类可读 ISO8601(本地时区) + 原始 epoch 供排序 */
interface HumanTime {
    at: string;
    at_epoch: number;
}
/** [r3] A: epoch(ms) → { at: <ISO8601 本地时区>, at_epoch: <原始 ms> }; 非法/缺失值原样回显 */
declare function humanTime(at: number | undefined): HumanTime | undefined;
/** [r3] A: 时间戳展开成两个字段: <prefix> 为 ISO8601 人类可读, <prefix>_epoch 为原始毫秒 */
declare function timeFields(prefix: string, at: number | undefined): Record<string, unknown>;
/** [r3] A: 字节数 → 人类可读(9.4KB / 1.2MB); 原始值由调用方以 <name>_bytes 保留 */
declare function formatBytes(bytes: number | undefined): string | undefined;
/** [r3] A: 毫秒 → 人类可读时长(8.8s / 1.5m / 250ms); 原始值由调用方以 <name>Ms 保留 */
declare function formatDuration(ms: number | undefined): string | undefined;
/** [r3] A: 列表分页参数解析(offset 从 0 开始; limit 夹在 [1, LIST_PAGE_MAX]) */
declare function parsePage(offset: unknown, limit: unknown, def?: number): {
    offset: number;
    limit: number;
};
/** [r3] A: 列表类返回的统一分页信封(total=过滤后总数, count=本页条数, truncated + next 提示) */
declare function pageEnvelope<T>(rows: readonly T[], offset: number, limit: number, tool: string): {
    page: T[];
    meta: {
        total: number;
        count: number;
        offset: number;
        limit: number;
        truncated: boolean;
        hasMore: boolean;
        next?: string;
    };
};
/** 结构化任务结果 */
interface TaskResult {
    taskId: string;
    sessionId: string;
    assistantText: string;
    toolCalls: {
        name: string;
        args: string;
    }[];
    toolResults: string[];
    changes: string;
    verification: string;
    leftovers: string;
    /** P1: 本次执行的增量会话统计(scope:'run'; 全会话累计用 session_stats 工具) */
    stats?: Record<string, unknown>;
    /** P3: 本次请求的权限三档(仅当显式传入时回显; 缺省 = 运行时 defaultSandbox) */
    sandbox?: string;
}
/**
 * [r3] B4: 从 agent 产出文本里抽取"看起来是文件绝对路径"的片段。
 * 优先取 / 开头的绝对路径(去掉行尾标点), 用于判断结果是否已带可点击的落点。
 */
declare function extractAbsPaths(text: string | undefined): string[];
/**
 * [r3] B4: agent_run 结果的"落点提示"。
 * 结果文本提到「已写入文件」但没有任何绝对路径时, 补一条 hint 指向沙箱 cwd(常见落点),
 * 避免 agent 拿着 changes 描述却不知道文件到底写在哪。
 */
declare function fileLandingHint(result: TaskResult, cwd: string): {
    hint: string;
    likelyDir: string;
    mentionedWrite: boolean;
    pathsInResult: string[];
} | undefined;
/** 异步任务队列条目 */
interface TaskItem {
    id: string;
    task: string;
    context: string;
    cwd: string;
    sessionId?: string;
    title?: string;
    /** A: 请求级 preset 覆盖(缺省用运行时默认) */
    preset?: string;
    /** P3: 请求级权限三档覆盖(缺省用运行时 defaultSandbox) */
    sandbox?: SandboxMode;
    status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
    /** B: 已请求取消(running 中止 / 锁内协作取消), 收尾时置 status='cancelled' 并丢弃结果 */
    cancelled?: boolean;
    result?: TaskResult;
    error?: string;
    createdAt: number;
    finishedAt?: number;
    /** [P0 回调] 任务级主动回调配置(仅当调用方传入且解析成功时存在; 不传 = undefined, 收尾路径与 v0.7.0 完全一致) */
    callback?: TaskCallbackConfig;
    /** [P0 回调] 回调投递状态回显(task_result/task_list/status_get 用; 未配置回调恒 undefined) */
    notify?: CallbackNotifyState;
}
/**
 * [P0 回调] 任务级主动回调配置(task_inbox 新增可选 callback 参数经 schema 校验后的运行时形态)。
 * 字段语义: url/method/headers/events/secret/replyContext/timeoutMs 与 REQ_CALLBACK_IMPL.md 逐一对应。
 */
interface TaskCallbackConfig {
    url: string;
    method: 'POST' | 'PUT';
    headers?: Record<string, string>;
    /** HMAC-SHA256 签名密钥(缺省回填部署级 defaultCallbackSecret; 两者皆空 = 不签名并在返回体提示) */
    secret?: string;
    /** 订阅的终态事件(默认 ['done','error']; 'cancelled' 需显式订阅且不含 result) */
    events: Array<'done' | 'error' | 'cancelled'>;
    /** 调用方自定义上下文(opaque, 原样放回 payload.replyContext; 用于发起方会话路由/唤醒) */
    replyContext?: unknown;
    /** 单次投递超时毫秒(默认 5000, schema 限 [1000,30000]) */
    timeoutMs: number;
}
/** [P0 回调] 投递状态(不可变快照; delivered/failed 均为终态, 状态回显与调度零耦合) */
interface CallbackNotifyState {
    /** delivered=2xx 已投递; failed=网络失败/超时/非2xx/SSRF 拒绝(仅告警, 不重试不抛错); skipped=未订阅该事件或全局关闭 */
    state: 'delivered' | 'failed' | 'skipped';
    /** 尝试次数(恒 1; P0 无重试) */
    attempts: number;
    /** 投递完成时刻(epoch ms) */
    notifiedAt: number;
    /** 失败原因(仅 failed 时存在; 不含 url path/query, 防泄漏) */
    lastError?: string;
}
/**
 * [P0 回调] SSRF 防护判定(P0 口径, 同步纯函数)。
 * 返回 undefined = 允许; 字符串 = 拒绝原因(不含原始 url, 防泄漏)。
 * 规则(REQ §3): 仅 http/https; 私网/回环/链路本地(含 169.254.169.254 云 metadata)默认拒绝;
 * allowedCallbackHosts(部署配置)显式放行(精确 'host' / 'host:port' / 通配 '*.suffix')。
 * P0 限制(已知): 域名解析后指向私网的 DNS rebinding 不在此拦截(DNS 解析在 http.request 内部,
 * 同步入口拿不到解析结果); 需要更强保证的部署请用 allowedCallbackHosts 白名单。
 */
declare function ssrfGuardCheck(rawUrl: string, allowedHosts: readonly string[]): string | undefined;
/**
 * [P0 回调] 解析 task_inbox.callback → 运行时配置(入口一次性完成: schema 已过, 这里只做
 * SSRF 判定 + secret 缺省回填 + 保留头剔除 + replyContext 序列化体积上限)。
 * 成功返回 { config, signed }, 失败返回 { error }(文案走 errText 统一句式)。
 */
declare function resolveCallback(raw: unknown): {
    config?: TaskCallbackConfig;
    signed?: boolean;
    error?: string;
};
/**
 * [P0 回调] 组装标准回调 Envelope 载荷(REQ §2 字段逐一对应)。
 * result 仅 done 且存在时携带(经 truncateResult 裁剪); cancelled 不携带 result/error(收尾时已删);
 * replyContext opaque 原样回传。
 */
declare function buildCallbackPayload(item: TaskItem): Record<string, unknown>;
/**
 * [P0 回调] HMAC-SHA256 签名(secret 存在时)。
 * 签名材料 = `${timestamp}.${rawBody}`; 时间戳入签 → 接收方校验 X-DSH-Timestamp 窗口即可防重放。
 */
declare function signCallbackPayload(secret: string, timestamp: number, rawBody: string): string;
/** [P0 回调] 恒时字符串比较(验签用; 长度不等时直接 false, 不比较) */
declare function safeEqualStr(a: string, b: string): boolean;
/** [P0 回调] 提取回调 URL 的 host(:port)(日志/回显脱敏用, 不含 path/query) */
declare function hostOfCallbackUrl(url: string): string;
/** 挂起审批条目(web 桥来自 mux 帧, 带 rpcId; builtin 桥来自 answerer 直收, 带 settle) */
interface PendingApproval {
    approvalId: string;
    sessionId: string;
    toolName: string;
    callId?: string;
    reason?: string;
    requestedAt: number;
    /** web 桥: 回答所需 rpcId(apiProxy.respond 按 rpcId 路由) */
    rpcId?: string;
    /** builtin 桥: 直接 settle answerer promise(outcome 原样返回给审批链) */
    settle?: (outcome: ApprovalOutcome) => void;
    /** 超时定时器(approvalTimeoutMs 后收尾, 绝不超时放行) */
    timer?: ReturnType<typeof setTimeout>;
}
/**
 * 插件入口: 启动 MCP server(StreamableHTTP, 跨网), 通过 ctx 桥接 Harness 能力。
 */
export declare function apply(ctx: Context, config?: Config): Promise<void>;
/** 测试专用内部通道(mock 测试直接操纵队列状态, 绕开异步时序; 非公开 API) */
export declare const __internals: {
    taskQueue: Map<string, TaskItem>;
    taskRunSessions: Map<string, string>;
    pendingApprovals: Map<string, PendingApproval>;
    readonly activeBridgeKind: ApprovalsBridge;
    errText: typeof errText;
    missingParamError: typeof missingParamError;
    idNotFoundError: typeof idNotFoundError;
    emptySessionError: typeof emptySessionError;
    isDshServiceDown: typeof isDshServiceDown;
    toolFailure: typeof toolFailure;
    validateArgs: typeof validateArgs;
    humanTime: typeof humanTime;
    timeFields: typeof timeFields;
    formatBytes: typeof formatBytes;
    formatDuration: typeof formatDuration;
    parsePage: typeof parsePage;
    pageEnvelope: typeof pageEnvelope;
    fileLandingHint: typeof fileLandingHint;
    extractAbsPaths: typeof extractAbsPaths;
    SESSION_LOG_MAX_EVENTS: number;
    LIST_PAGE_DEFAULT: number;
    LIST_PAGE_MAX: number;
    ssrfGuardCheck: typeof ssrfGuardCheck;
    resolveCallback: typeof resolveCallback;
    buildCallbackPayload: typeof buildCallbackPayload;
    signCallbackPayload: typeof signCallbackPayload;
    safeEqualStr: typeof safeEqualStr;
    hostOfCallbackUrl: typeof hostOfCallbackUrl;
    VERSION: string;
};
export {};

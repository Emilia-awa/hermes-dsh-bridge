import { z } from "zod";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import { zstdDecompressSync } from "node:zlib";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

//#region src/contract.ts
/**
* 宿主契约清单 —— 与 DISCUSS_20261003 §2.1 的核对表逐条对应。
*
* `required` 覆盖桥的 3 个直接 import 符号(`dsh-llm#createUserMessage`、
* `dsh-session#SessionId`、`dsh-scope#scopeOf`)。
* `services` 覆盖 §3.1 骨架里列出的 11 个服务, 并补上 `llm`(桥用它解析 provider/model)。
*
* ⚠️ 注意: `required` 里的符号校验的是**已 import 的绑定**(`probeHostContract` 的入参),
*    不是重新解析模块 —— 因为 import 失败会在插件加载阶段直接炸, 根本到不了 apply();
*    这里校验的是「绑定是否为期望的函数」, 用于捕获**导出被改名 / 变成非函数**这类静默变更。
*/
const HOST_CONTRACT = {
	required: [
		{
			pkg: "@deepseek-ai/dsh-llm",
			export: "createUserMessage",
			kind: "function",
			usage: "构造注入给 agent 的 user message(source.kind=user)"
		},
		{
			pkg: "@deepseek-ai/dsh-session",
			export: "SessionId",
			kind: "function",
			usage: "会话 id 的品牌化构造(运行时是恒等函数)"
		},
		{
			pkg: "@deepseek-ai/dsh-scope",
			export: "scopeOf",
			kind: "function",
			usage: "取 ctx 的 scope key(审批事件订阅用)"
		}
	],
	services: [
		{
			key: "tools",
			required: true,
			methods: ["register", "schemas"],
			usage: "注册 25 个默认 MCP 工具(enableFsWrite 时 26 个); 缺失 = 插件无任何工具。schemas = harness_list_tools 的读取面(r6 补: 此前只校验 register, 于是 harness_list_tools 调了不存在的 keys() 也报绿)"
		},
		{
			key: "llm",
			required: true,
			methods: [],
			usage: "解析 provider/model; 缺失 = agent 组装不出 LLM"
		},
		{
			key: "sessions",
			required: true,
			methods: ["get"],
			usage: "live 会话存取(get/flush); listCorpus 的 live 数据源"
		},
		{
			key: "agents",
			required: true,
			methods: [
				"list",
				"create",
				"resume"
			],
			usage: "agent 生命周期(create/resume/list); status_get 的 agentsLive"
		},
		{
			key: "agentPresets",
			required: true,
			methods: [
				"resolve",
				"mount",
				"recompose"
			],
			usage: "preset 解析与挂载(agent_run 的 preset 覆盖)"
		},
		{
			key: "sessionPersistence",
			required: true,
			methods: ["list"],
			usage: "会话持久化列表与检视(session_list/session_log 的盘上数据源)"
		},
		{
			key: "workspaceRegistry",
			required: false,
			methods: ["resolveByPath", "create"],
			usage: "已注册工作区枚举(fs 白名单根 + cwd 校验); 缺失仅少一层根"
		},
		{
			key: "sessionQuery",
			required: false,
			methods: ["listSessions"],
			usage: "0.1.7+ 官方索引快路径; 缺失回退 sessionPersistence"
		},
		{
			key: "sessionTitle",
			required: false,
			methods: ["rename"],
			usage: "rename_session 工具; 缺失时该工具报不可用"
		},
		{
			key: "settings",
			required: false,
			methods: ["mutate"],
			usage: "set_policy 持久化权限档; 缺失仅本次会话生效"
		},
		{
			key: "approval",
			required: false,
			methods: [],
			usage: "审批策略读取(config.policy); 缺失按默认策略"
		},
		{
			key: "apiProxy",
			required: false,
			methods: [],
			usage: "Web 审批桥通道; 缺失自动降级 builtin/file-push(已按设计降级)"
		}
	]
};
/** `required` 项的稳定 id: `pkg#export` */
function symbolId(s) {
	return `${s.pkg}#${s.export}`;
}
/** 服务项的稳定 id: 服务 key 本身 */
function serviceId(s) {
	return s.key;
}
/** 取单个服务的期望方法缺失名单(key.method 形态) */
function missingMethodsOf(service, impl) {
	const out = [];
	if (!impl || typeof impl !== "object" && typeof impl !== "function") return out;
	const rec = impl;
	for (const m of service.methods) if (typeof rec[m] !== "function") out.push(`${service.key}.${m}`);
	return out;
}
/**
* 运行时探测宿主契约。
*
* - **符号**: `typeof binding === 'function'`(期望 kind 为 function 时);
* - **服务**: `ctx.get(key, false)` 宽松读取 —— 存在性 + 期望方法存在性;
* - **不做版本号比较**, **不抛错**: 探测本身任何异常都被兜底为「该项缺失」,
*   绝不因为探测失败而影响插件启动。
*
* 返回结构稳定(`ContractReport`), 可直接被 status_get 序列化、被 contract_probe.mjs 落盘 diff。
*/
function probeHostContract(input) {
	const missingRequired = [];
	const missingOptional = [];
	const incompleteMethods = [];
	const registered = input.symbols ?? {};
	for (const s of HOST_CONTRACT.required) {
		const id = symbolId(s);
		let ok = false;
		try {
			const v = registered[s.export];
			ok = s.kind === "function" ? typeof v === "function" : typeof v === s.kind;
		} catch {
			ok = false;
		}
		if (!ok) missingRequired.push(id);
	}
	for (const svc of HOST_CONTRACT.services) {
		const id = serviceId(svc);
		let impl;
		try {
			impl = input.ctx.get(svc.key, false);
		} catch {
			impl = void 0;
		}
		if (impl === void 0 || impl === null) {
			(svc.required ? missingRequired : missingOptional).push(id);
			continue;
		}
		const missing = missingMethodsOf(svc, impl);
		if (missing.length > 0) {
			incompleteMethods.push(...missing);
			if (svc.required) missingRequired.push(`${id}(方法缺失)`);
			else missingOptional.push(`${id}(方法缺失)`);
		}
	}
	return {
		ok: missingRequired.length === 0,
		missingRequired,
		missingOptional,
		incompleteMethods,
		checkedAt: Date.now(),
		checkedCount: HOST_CONTRACT.required.length + HOST_CONTRACT.services.length
	};
}

//#endregion
//#region src/index.ts
/** Cordis 插件名 */
const name = "harness-mcp-server";
/** 插件版本(status_get 上报; 与 package.json 保持同步) */
const PLUGIN_VERSION = "0.11.0";
/** 全部合法档位(schema 枚举与运行时校验共用) */
const SANDBOX_MODES = [
	"read-only",
	"workspace-write",
	"danger-full-access"
];
/**
* 声明依赖的核心服务。
* workspaceRegistry/sessionPersistence/sessions 是续接/归组三个增量用到的服务——
* 漏声明会在真实启动时拿不到服务(本插件曾经踩过, 务必与代码里的 ctx.get 对齐)。
*/
const inject = [
	"tools",
	"llm",
	"agents",
	"agentPresets",
	"workspaceRegistry",
	"sessionPersistence",
	"sessions"
];
/** [r1] config_get 用的预设摘要(只回显结构, 绝不回显 secret / header 值) */
function describeCallbackPreset() {
	const p = runtimeConfig.callbackPreset;
	if (!p || p.url === void 0) return { configured: false };
	return {
		configured: true,
		url: p.url,
		method: p.method ?? "POST",
		headerNames: Object.keys(sanitizeCallbackHeaders(p.headers) ?? {}),
		events: p.events ?? ["done", "error"],
		timeoutMs: p.timeoutMs ?? 5e3,
		hasReplyContext: p.replyContext !== void 0,
		replyContextKeys: Object.keys(p.replyContext ?? {}),
		autoApply: p.autoApply !== false,
		requireReplyRoute: p.requireReplyRoute === true
	};
}
/**
* [r1] 部署配置校验: 非法 callbackPreset 一律回落到"未配置"(并告警), 不阻断启动。
* 逐字段校验, 任何一项类型不对就整体判非法 —— 回调配置错配会导致静默失效, 宁可显式告警。
* @returns 规范化后的预设; undefined = 非法
*/
function normalizeCallbackPreset(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
	const r = raw;
	const out = {};
	if (r.url !== void 0) {
		if (typeof r.url !== "string" || !r.url.trim()) return void 0;
		out.url = r.url.trim();
	}
	if (r.method !== void 0) {
		if (r.method !== "POST" && r.method !== "PUT") return void 0;
		out.method = r.method;
	}
	if (r.headers !== void 0) {
		if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return void 0;
		if (!Object.values(r.headers).every((v) => typeof v === "string")) return void 0;
		out.headers = { ...r.headers };
	}
	if (r.events !== void 0) {
		if (!Array.isArray(r.events) || !r.events.every((e) => e === "done" || e === "error" || e === "cancelled")) return void 0;
		out.events = [...r.events];
	}
	if (r.replyContext !== void 0) {
		if (typeof r.replyContext !== "object" || r.replyContext === null || Array.isArray(r.replyContext)) return void 0;
		out.replyContext = { ...r.replyContext };
	}
	if (r.timeoutMs !== void 0) {
		const t = Number(r.timeoutMs);
		if (!Number.isInteger(t) || t < 1e3 || t > 3e4) return void 0;
		out.timeoutMs = t;
	}
	if (r.autoApply !== void 0) {
		if (typeof r.autoApply !== "boolean") return void 0;
		out.autoApply = r.autoApply;
	}
	if (r.requireReplyRoute !== void 0) {
		if (typeof r.requireReplyRoute !== "boolean") return void 0;
		out.requireReplyRoute = r.requireReplyRoute;
	}
	if (out.url === void 0) return void 0;
	return out;
}
/** 运行时配置默认值(apply 时重置再叠加 config, 保证重复 apply 幂等不残留上一次的状态) */
const runtimeConfigDefaults = () => ({
	provider: "deepseek-official",
	model: "",
	preset: "standard",
	maxQueue: 100,
	taskTtlMs: 6e5,
	maxAgents: 8,
	authToken: "",
	workspaceRoots: [],
	enableFsWrite: false,
	defaultSandbox: "workspace-write",
	approvalsBridge: "web",
	approvalTimeoutMs: 3e5,
	approvalFileDir: join(homedir(), ".dsh", "approvals"),
	notifyEnabled: true,
	defaultCallbackSecret: "",
	allowedCallbackHosts: [],
	callbackPreset: void 0,
	questionCallback: void 0,
	contract: void 0
});
/** 运行时配置(apply 时从 config 初始化, 提供安全默认值) */
const runtimeConfig = runtimeConfigDefaults();
/**
* [R7 P1-1] 用户是否**显式**配置过 provider(config.provider 非空)。
* 用来区分「部署方主动选了 deepseek-official」与「只是吃了默认值」——
* 只有后者才值得提示(前者是明确决策, 提示会变噪音)。apply 时随 runtimeConfig 一起重置。
*/
let providerExplicitlyConfigured = false;
const DEGRADATION_KEEP = 20;
/** 已发生的降级留痕(按 scope+reason 聚合, 最近发生的排在前面) */
const degradations = /* @__PURE__ */ new Map();
/** 已告警过的 scope+reason(首次告警后降为静默计数, 避免日志刷屏) */
const degradationWarned = /* @__PURE__ */ new Set();
/** 降级通道键(同一 scope+reason 视为同一条留痕) */
function degradationKey(scope, reason) {
	return `${scope}\u0000${reason}`;
}
/**
* 统一降级通道: 留痕 + 计数 + 首次告警。
*
* - 契约/服务相关的静默 catch 一律改走这里(不允许完全静默);
* - 首次出现时 warn(含 scope/reason/error 摘要), 之后只累加计数 —— 拿得到「坏了多少次」又不刷屏;
* - 结果通过 `status_get.degradations` 暴露给 Hermes 侧。
*
* @param scope  降级范围(建议用服务 key 或功能名, 便于 grep 定位)
* @param reason 人类可读原因(会出现在日志与 status_get 里)
* @param err    原始异常(可选; 只取 message 摘要, 长时间持有对象会阻碍 GC)
*/
function degrade(scope, reason, err) {
	const key = degradationKey(scope, reason);
	const now = Date.now();
	const prev = degradations.get(key);
	if (prev) {
		prev.count++;
		prev.at = now;
		degradations.set(key, prev);
		return;
	}
	const errorText = err === void 0 || err === null ? void 0 : (err instanceof Error ? err.message : String(err)).slice(0, 300);
	degradations.set(key, {
		scope,
		reason,
		at: now,
		count: 1,
		...errorText ? { error: errorText } : {}
	});
	if (!degradationWarned.has(key)) {
		degradationWarned.add(key);
		console.warn(`[harness-mcp-server] 降级 ${scope}: ${reason}${errorText ? ` — ${errorText}` : ""}`);
	}
}
/** 最近 N 条降级留痕(最近发生的在前; 供 status_get 序列化) */
function degradationsSnapshot() {
	return [...degradations.values()].sort((a, b) => b.at - a.at).slice(0, DEGRADATION_KEEP);
}
/** 清空降级留痕(apply 时重置, 保证重复 apply 幂等不残留上一次的状态) */
function resetDegradations() {
	degradations.clear();
	degradationWarned.clear();
}
/** 默认 provider id(与 runtimeConfigDefaults().provider 逐字一致; 探测「用户是否从未显式配置」) */
const DEFAULT_PROVIDER_ID = "deepseek-official";
/** provider 三态探测结果(未探测时为 undefined, status_get 如实返回 null) */
let providerCheck;
/**
* [R7 P1-1] 探测「默认 provider 是否在宿主注册」并给出可操作的引导。
*
* 只在**用户从未显式配置 provider**(即仍在用默认值)且该 provider 未注册时告警 ——
* 否则会骚扰那些明确知道自己配了什么的部署方。
* 全程 try/catch: 探测本身任何异常都不得影响插件启动(与 contract.ts 同款哲学)。
*/
function probeProviderDefault(ctx) {
	const explicit = providerExplicitlyConfigured;
	const provider = runtimeConfig.provider;
	let available = [];
	let probed = false;
	try {
		const llm = ctx.get("llm", false);
		if (llm && typeof llm.listProviders === "function") {
			const list = llm.listProviders();
			if (Array.isArray(list)) {
				available = list.map((p) => p?.id).filter((id) => typeof id === "string" && id.length > 0);
				probed = true;
			}
		}
	} catch (e) {
		degrade("llm.listProviders", "ctx.llm.listProviders() 抛错, 无法确认默认 provider 是否注册", e);
	}
	const registered = probed ? available.includes(provider) : null;
	providerCheck = {
		probed,
		provider,
		registered,
		explicit,
		available
	};
	if (!probed) {
		if (!available.length && registered === null) degrade("provider", "ctx.llm.listProviders() 不可用, 跳过 provider 默认值自检", void 0);
		return;
	}
	if (explicit || provider !== DEFAULT_PROVIDER_ID || registered) return;
	console.warn(`[harness-mcp-server] ⚠️ 你用的是默认 provider '${DEFAULT_PROVIDER_ID}', 但宿主没注册它。如果你用的是自定义 provider, 请在插件 config 里显式写 provider: <你的 provider id>。宿主当前注册的 provider: ${available.length > 0 ? available.join(", ") : "(无)"}`);
	degrade("provider", `默认 provider '${DEFAULT_PROVIDER_ID}' 未在宿主注册, 启动/调用会报上游的凭据或组装错误(指向错误的对象); 请在插件 config 里显式配置 provider(宿主当前注册: ${available.length > 0 ? available.join("/") : "无"})`);
}
/** HTTP server 运行信息(apply 时记录, status_get/config_get 上报) */
const serverRuntime = {
	port: 0,
	host: "",
	startedAt: Date.now()
};
/** 属于推理块的 content block type(extractText 遇到直接整块跳过) */
const REASONING_BLOCK_TYPES = /* @__PURE__ */ new Set(["thinking", "reasoning"]);
/** 文本内嵌的推理块正则: 标签对 + 围栏代码块(<think> 为 DeepSeek R1 风格, 一并剥除) */
const REASONING_TEXT_PATTERNS = [
	/<thinking>[\s\S]*?<\/thinking>/gi,
	/<reasoning>[\s\S]*?<\/reasoning>/gi,
	/<think>[\s\S]*?<\/think>/gi,
	/```thinking[^\n]*\n[\s\S]*?```/gi
];
/**
* 从 assistant 文本中剥离 thinking/reasoning 块, 只保留最终 assistant 文本。
* 对非字符串输入返回空串; 剥离后压缩 3 连以上空行并 trim。
*/
function stripReasoning(text) {
	if (typeof text !== "string" || !text) return "";
	let cleaned = text;
	for (const re of REASONING_TEXT_PATTERNS) cleaned = cleaned.replace(re, "");
	return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}
/** 该 content block 是否为推理块(type === 'thinking'|'reasoning') */
function isReasoningBlock(rec) {
	return typeof rec.type === "string" && REASONING_BLOCK_TYPES.has(rec.type);
}
/**
* 共享文本收集器: 递归收集 obj 里所有 string 型 text/content 字段。
* - 整块跳过 type==='thinking'|'reasoning' 的对象(不递归其内部);
* - 跳过名为 thinking/reasoning/reasoning_content 的字段。
* executeTask 的 tool/result 提取与 session_log 的日志摘录共用此实现。
*/
function collectText(obj, out) {
	if (Array.isArray(obj)) {
		for (const x of obj) collectText(x, out);
		return;
	}
	if (obj && typeof obj === "object") {
		const rec = obj;
		if (isReasoningBlock(rec)) return;
		if (typeof rec.text === "string" && rec.text.trim()) out.push(rec.text);
		if (typeof rec.content === "string" && rec.content.trim()) out.push(rec.content);
		for (const [k, v] of Object.entries(rec)) {
			if (k === "thinking" || k === "reasoning" || k === "reasoning_content") continue;
			collectText(v, out);
		}
	}
}
const FS_READ_MAX_CHARS = 49152;
const FS_READ_MAX_FILE_BYTES = 8388608;
const FS_LIST_MAX_ENTRIES = 1e3;
const FS_WRITE_MAX_BYTES = 4194304;
const SESSION_LOG_MAX_CHARS = 61440;
const SESSION_LOG_MAX_EVENTS = 50;
const SESSION_LOG_HEAD_EVENTS = 5;
const SESSION_LIST_MAX_ROWS = 50;
const SESSION_LIST_INSPECT_CONCURRENCY = 4;
const SESSION_LIST_INSPECT_TIMEOUT_MS = 3e3;
const DEFAULT_LOG_TYPES = [
	"user/message",
	"assistant/message",
	"tool/call",
	"tool/result"
];
/** 工具回调统一返回 MCP text content */
function out(content) {
	return { content: [{
		type: "text",
		text: content
	}] };
}
/**
* cwd realpath 规范化: 解析符号链接与 .. 段, 使 cwd 能与 workspace.path(存储时为 realpath 规范化值)
* 精确比对——这是官方 attachSession 强校验通过的前提。目录不存在时回退 resolve 结果, 由调用方告警不阻断。
*/
async function canonicalCwd(raw) {
	try {
		return await realpath(raw);
	} catch {
		return resolve(raw);
	}
}
/** fs 工具允许读取的根: ~/.dsh + 进程 cwd + 配置 workspaceRoots + 已注册工作区(realpath 规范化) */
async function fsAllowedRoots(ctx) {
	const roots = /* @__PURE__ */ new Set();
	try {
		roots.add(await realpath(join(homedir(), ".dsh")));
	} catch {}
	try {
		roots.add(await realpath(process.cwd()));
	} catch {
		roots.add(resolve(process.cwd()));
	}
	for (const r of runtimeConfig.workspaceRoots) roots.add(await canonicalCwd(r));
	const registry = ctx.get("workspaceRegistry");
	for (const ws of registry?.list?.() ?? []) try {
		roots.add(await realpath(ws.path));
	} catch {}
	return [...roots];
}
/**
* 敏感路径判定(对 realpath 规范化后的绝对路径逐段检查):
* .ssh 目录及其内部 / .env 或 .env.* / 名字含 token / *.pem
*/
function isSensitivePath(canonical) {
	for (const seg of canonical.split("/")) {
		const s = seg.toLowerCase();
		if (!s) continue;
		if (s === ".ssh") return true;
		if (s === ".env" || s.startsWith(".env.")) return true;
		if (s.includes("token")) return true;
		if (s.endsWith(".pem")) return true;
	}
	return false;
}
/** fs 工具统一准入: realpath 规范化 → 敏感名拒绝 → 白名单根包含校验。通过返回 canonical, 否则返回 error。 */
async function gateFsPath(ctx, rawPath) {
	const resolved = resolve(rawPath ?? ".");
	let canonical;
	try {
		canonical = await realpath(resolved);
	} catch {
		return { error: `path not found: ${rawPath}` };
	}
	if (isSensitivePath(canonical)) return { error: `path denied by policy (sensitive name): ${rawPath}` };
	if (!(await fsAllowedRoots(ctx)).some((r) => canonical === r || canonical.startsWith(r + "/"))) return { error: `path outside allowed roots (~/.dsh + workspaces): ${canonical}` };
	return { canonical };
}
/**
* fs_stat 专用软准入: 目标不存在(realpath 失败)时不报错, 改用 resolve 结果做策略判定,
* 通过则交回 {missing:true} 让调用方返回 exists:false(不泄露白名单外路径的存在性)。
*/
async function gateFsPathSoft(ctx, rawPath) {
	const resolved = resolve(rawPath ?? ".");
	const hard = await gateFsPath(ctx, resolved);
	if (!hard.error || !hard.error.startsWith("path not found")) return hard;
	if (isSensitivePath(resolved)) return { error: `path denied by policy (sensitive name): ${rawPath}` };
	if (!(await fsAllowedRoots(ctx)).some((r) => resolved === r || resolved.startsWith(r + "/"))) return { error: `path outside allowed roots (~/.dsh + workspaces): ${resolved}` };
	return {
		canonical: resolved,
		missing: true
	};
}
/**
* [r2] B: 任务类工具的默认工作目录。
* 远程 agent 调用时 process.cwd() 通常是 dsh 进程的启动目录(对 Hermes 无意义),
* 因此优先用插件配置的 workspaceRoots[0](部署方显式声明的工作区), 没配才回落 process.cwd()。
* 该默认值在 agent_run/task_inbox 的 cwd 参数描述里明写, 让 agent 不用猜。
*/
function defaultTaskCwd() {
	return runtimeConfig.workspaceRoots[0] ?? process.cwd();
}
/** [r2] B: 默认工作目录的人类可读描述(拼进工具描述与参数描述) */
function defaultCwdHint() {
	return runtimeConfig.workspaceRoots.length > 0 ? `默认工作区 ${runtimeConfig.workspaceRoots[0]} (来自插件配置 workspaceRoots[0])` : `默认进程当前目录 ${process.cwd()} (未配置 workspaceRoots)`;
}
/**
* [r2] A/B: 统一的"下一步怎么办"提示片段 —— 让每个错误/结果都能自解释, agent 不用猜链路。
* 抽成常量便于 26 个工具的描述与错误文案保持措辞一致。
*/
const HINT = {
	/** 拿到 taskId 之后干什么 */
	pollTask: "用 task_result(taskId=...) 取结果; 想看队列全貌用 task_list; 想中途放弃用 task_cancel(taskId=...)",
	/** 拿到 sessionId 之后干什么 */
	resumeSession: "续接此会话时把 sessionId 传给 agent_run 或 task_inbox; 看对话历史用 session_log(sessionId=...)",
	/** 会话找不到 */
	sessionMissing: "session not found",
	/** 长任务建议 */
	longTask: "预计耗时 > 5 分钟或需要中途取消的任务, 请改用 task_inbox(异步队列)"
};
/** [r2] A: 会话类错误的统一后缀(下一步动作) */
/** [r3] C7: 会话不存在 —— 走统一句式 `<错误>: <关键值> (<原因>; <下一步>)` */
/** [R7 P2-1]: 可选 `next` 覆盖 —— 供调用方把**附加说明**并进 next 参数, 而不是外挂拼接破坏句式 */
function sessionNotFoundError(sessionId, next) {
	return idNotFoundError("session", sessionId, next ?? "用 session_list 查看当前会话列表, 或先用 agent_run 建一个");
}
/** [r2] A / [r3] C7: 任务类错误 —— 统一句式 + 保留 TTL 提示 */
function taskNotFoundError(taskId) {
	return idNotFoundError("task", taskId, `用 task_list 查看当前队列; 任务默认保留 ${Math.round(runtimeConfig.taskTtlMs / 6e4)} 分钟`);
}
/**
* [r3] C: 三类错误统一文案构造器 —— `<错误>: <关键值> (<原因一句话>; <下一步动作>)`。
* 所有工具的错误串都经此拼装(不再各自手写后缀), 保证 agent 每次都能读到"下一步动作"。
*/
function errText(code, key, reason, next) {
	return `${code}: ${key} (${reason}; ${next})`;
}
/** [r3] C: 必传参数缺失(含期望类型, 便于 agent 直接改对) */
function missingParamError(tool, param, expected) {
	return errText("missing required parameter", `${tool}.${param}`, `expected ${expected}, got nothing`, `补上 ${param} 后重试; 参数说明见 ${tool} 的工具描述`);
}
/** [r3] C: id 不存在(会话/任务/preset 三类共用同一句式) */
function idNotFoundError(kind, id, next) {
	const reason = kind === "session" ? "不存在或已过期" : kind === "task" ? "已过期或从未存在" : "不在当前部署的 preset 名单里";
	return errText(`${kind} not found`, id, reason, next);
}
/** [r3] C: 会话为空(存在但没有任何事件) */
function emptySessionError(sessionId) {
	return errText("session is empty", sessionId, "该会话存在但还没有任何事件", "先跑一轮 agent_run/task_inbox 带上这个 sessionId, 或用 session_list 另选一个会话");
}
/**
* [R7 P3-2 / C-3] `session_search` 回退到 scan 时的人话解释。
*
* `indexFallbackReason` 透传的是上游原始错误码(如 `SESSION_QUERY_SEARCH_DISABLED`),
* Hermes 侧读不懂。这里**新增** `indexFallbackHint` 字段给解释, **不改原字段**
* (原始码保留, 便于按码排查; 新增字段向后兼容)。
*/
const INDEX_FALLBACK_HINT = "官方索引不可用, 已自动回退到插件侧扫描(标题先行 + 内容尽力扫), 搜索仍可用但更慢。常见原因: ① 本机把索引搜索设为关闭(上游 code=SESSION_QUERY_SEARCH_DISABLED) ② 上游 locate() 按「当前」会话格式版本拼路径, 而多数历史会话实际落盘的是旧版本, 路径不存在(实测约 84% 落空)。这是上游限制, 插件侧无法修复(见 docs/KNOWN_ISSUES.md)。";
/**
* [R7 P1-2] `fs_read` 的 offset 越界判定(纯函数, 便于单测覆盖全部边界)。
*
* 背景(R6 §B-3): `off > totalLines` 时 `lines.slice()` 返回空数组 →
* 返回体是 `content: ""` + `truncated: false`, **agent 会据此误判「文件是空的」**。
*
* 边界口径(REQ §3 P1-2 明确规定):
*   - `off === totalLines`     → **不算越界**(能读到最后一行, 正常返回);
*   - `off === totalLines + 1` → 算越界(确实一行也读不到);
*   - 更大值 / 极大值          → 算越界。
*
* @returns 越界时返回可直接塞进返回体的 `note` 文案; 未越界返回 undefined(不改动正常路径结构)。
*/
function fsReadOffsetNote(off, totalLines) {
	if (off <= totalLines) return void 0;
	return `offset=${off} 超过总行数 ${totalLines} —— 本次没有任何内容可返回(不是文件为空); 文件共 ${totalLines} 行, 有效 offset 范围是 1~${Math.max(1, totalLines)}`;
}
/**
* [r3] C: dsh 服务未启动/连接拒绝的判定(错误串或 error.code 命中即算)。
* 命中后统一附「检查 dsh.service 状态」指引, 避免 agent 只看到裸 ECONNREFUSED。
*/
function isDshServiceDown(e) {
	const err = e;
	const code = String(err?.code ?? err?.cause?.code ?? "");
	if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ETIMEDOUT") return true;
	const msg = String(err?.message ?? e ?? "");
	return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|socket hang up|connection refused|fetch failed|connect failed/i.test(msg);
}
/** [r3] C: dsh 服务不可用的统一指引(检查 dsh.service 状态) */
const DSH_DOWN_NEXT = "dsh 服务可能未启动或已断开; 检查 dsh.service 状态(systemctl status dsh.service, 必要时 systemctl restart dsh.service)后重试";
/** [r3] C: 所有工具 catch 分支的兜底包装 —— 服务类错误走 dsh.service 指引, 其余原样补原因 */
function toolFailure(tool, e) {
	if (isDshServiceDown(e)) return errText(`${tool} failed`, "dsh service unreachable", "连接被拒绝或服务未监听", DSH_DOWN_NEXT);
	return errText(`${tool} failed`, e?.message ?? String(e), "工具执行过程中抛错", `确认参数正确后重试; 仍失败请用 status_get 检查服务运行态`);
}
/**
* [r3] C: 参数预校验(在工具入口统一调用, 早于任何业务逻辑)。
* 只校验"必填存在 + 类型"两类, 报错回显 `expected X, got Y`; 全部通过返回 undefined。
*/
function validateArgs(tool, args, spec) {
	const got = (v) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
	for (const s of spec) {
		const v = args[s.name];
		if (v === void 0 || v === null) {
			if (s.required) return missingParamError(tool, s.name, s.type);
			continue;
		}
		if (got(v) !== s.type) return errText("invalid parameter type", `${tool}.${s.name}`, `expected ${s.type}, got ${got(v)}`, `改成 ${s.type} 后重试`);
	}
}
/** [r3] A: epoch(ms) → { at: <ISO8601 本地时区>, at_epoch: <原始 ms> }; 非法/缺失值原样回显 */
function humanTime(at) {
	if (at === void 0 || !Number.isFinite(at)) return void 0;
	const d = new Date(at);
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const abs = Math.abs(off);
	return {
		at: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
		at_epoch: Math.round(at)
	};
}
/** [r3] A: 时间戳展开成两个字段: <prefix> 为 ISO8601 人类可读, <prefix>_epoch 为原始毫秒 */
function timeFields(prefix, at) {
	const h = humanTime(at);
	return h === void 0 ? {} : {
		[prefix]: h.at,
		[`${prefix}_epoch`]: h.at_epoch
	};
}
/** [r3] A: 字节数 → 人类可读(9.4KB / 1.2MB); 原始值由调用方以 <name>_bytes 保留 */
function formatBytes(bytes) {
	if (bytes === void 0 || !Number.isFinite(bytes) || bytes < 0) return void 0;
	if (bytes < 1024) return `${bytes}B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb < 10 ? Math.round(kb * 10) / 10 : Math.round(kb)}KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)}MB`;
	return `${Math.round(mb / 1024 * 10) / 10}GB`;
}
/** [r3] A: 毫秒 → 人类可读时长(8.8s / 1.5m / 250ms); 原始值由调用方以 <name>Ms 保留 */
function formatDuration(ms) {
	if (ms === void 0 || !Number.isFinite(ms) || ms < 0) return void 0;
	if (ms < 1e3) return `${Math.round(ms)}ms`;
	const s = ms / 1e3;
	if (s < 60) return `${Math.round(s * 10) / 10}s`;
	const m = s / 60;
	if (m < 60) return `${Math.round(m * 10) / 10}m`;
	return `${Math.round(m / 60 * 10) / 10}h`;
}
/** [r3] A: 列表类返回的通用分页常量(超 20 条截断, 并给 total/truncated/next) */
const LIST_PAGE_DEFAULT = 20;
const LIST_PAGE_MAX = 100;
/** [r3] A: 列表分页参数解析(offset 从 0 开始; limit 夹在 [1, LIST_PAGE_MAX]) */
function parsePage(offset, limit, def = LIST_PAGE_DEFAULT) {
	return {
		offset: Number.isFinite(Number(offset)) ? Math.max(0, Math.trunc(Number(offset))) : 0,
		limit: Number.isFinite(Number(limit)) ? Math.min(Math.max(1, Math.trunc(Number(limit))), LIST_PAGE_MAX) : def
	};
}
/** [r3] A: 列表类返回的统一分页信封(total=过滤后总数, count=本页条数, truncated + next 提示) */
function pageEnvelope(rows, offset, limit, tool) {
	const page = rows.slice(offset, offset + limit);
	const hasMore = offset + page.length < rows.length;
	return {
		page: [...page],
		meta: {
			total: rows.length,
			count: page.length,
			offset,
			limit,
			truncated: hasMore,
			hasMore,
			...hasMore ? { next: `结果超过 ${limit} 条已截断; 用 ${tool}(offset=${offset + page.length}, limit=${limit}) 取下一页` } : {}
		}
	};
}
/** [r3] A: 分页参数 schema(列表类工具共用, 保证 26 个工具的分页口径一致) */
const pageArgSchema = {
	offset: z.number().int().min(0).optional().describe("跳过前 N 条(默认 0; 配合 limit 翻页)"),
	limit: z.number().int().min(1).max(LIST_PAGE_MAX).optional().describe(`本页最多返回条数(默认 ${LIST_PAGE_DEFAULT}, 最大 ${LIST_PAGE_MAX})`)
};
const callbackSchema = z.object({
	url: z.string().url().optional().describe("回调接收地址(仅 http/https; 私网/回环/云 metadata 地址默认拒绝, 内网端点用部署配置 allowedCallbackHosts 放行); 若部署配置了 callbackPreset.url 则可不传"),
	method: z.enum(["POST", "PUT"]).optional().describe("回调 HTTP 方法(默认取部署预设, 否则 POST)"),
	headers: z.record(z.string(), z.string()).optional().describe("自定义请求头(host/content-length/connection/transfer-encoding 为保留头会被忽略; 与部署预设浅合并, 任务级同名覆盖)"),
	secret: z.string().optional().describe("HMAC-SHA256 签名密钥(缺省用部署配置 defaultCallbackSecret; 两者皆空 = 不签名), 用于在 X-DSH-Signature 头中防伪造"),
	events: z.array(z.enum([
		"done",
		"error",
		"cancelled"
	])).optional().describe("订阅哪些终态事件(缺省取部署预设, 否则 [\"done\",\"error\"]; 传 [] = 订阅全部, 对齐 Hermes 桥侧语义; \"cancelled\" 该事件不含 result)"),
	replyContext: z.unknown().optional().describe("调用方自定义上下文(如 replyChatId/platform 等), opaque 原样在回调载荷 replyContext 字段中回传(序列化后 ≤4KB), 供发起方会话路由/唤醒; 与部署预设深合并(任务级优先)"),
	timeoutMs: z.number().int().min(1e3).max(3e4).optional().describe("单次投递超时毫秒(缺省取部署预设, 否则 5000; 上限 30000)")
});
async function gateFsWritePath(rawPath) {
	if (runtimeConfig.workspaceRoots.length === 0) return { error: "fs_write unavailable: no workspaceRoots configured (fs_write is jailed to workspaceRoots)" };
	let anchor = resolve(rawPath ?? ".");
	const tail = [];
	for (;;) try {
		anchor = await realpath(anchor);
		break;
	} catch {
		const parent = dirname(anchor);
		if (parent === anchor) return { error: `path not resolvable: ${rawPath}` };
		tail.unshift(basename(anchor));
		anchor = parent;
	}
	const canonical = tail.length > 0 ? resolve(anchor, ...tail) : anchor;
	if (isSensitivePath(canonical)) return { error: `path denied by policy (sensitive name): ${rawPath}` };
	if (!(await Promise.all(runtimeConfig.workspaceRoots.map((r) => canonicalCwd(r)))).some((r) => canonical === r || canonical.startsWith(r + "/"))) return { error: `path outside workspaceRoots (fs_write jail): ${canonical}` };
	return { canonical };
}
/** 官方 session.create RPC 同款姿势: resolveByPath ?? create, 幂等; 无 workspaceRegistry 时返回 undefined */
async function ensureWorkspace(ctx, canonical) {
	const registry = ctx.get("workspaceRegistry");
	if (!registry) return void 0;
	return await registry.resolveByPath?.(canonical) ?? await registry.create?.(canonical);
}
/** 把会话挂名到其 cwd 对应的工作区。attachSession 内部强校验 realpath(header.cwd) 精确等于 workspace.path,
*  所以 canonical 必须是 header.cwd 的 realpath 规范化值。失败告警不阻断任务(分组是锦上添花)。 */
async function attachToWorkspace(ctx, canonical, sessionId) {
	try {
		const ws = await ensureWorkspace(ctx, canonical);
		if (ws?.attachSession) await ws.attachSession(sessionId);
	} catch (e) {
		degrade("workspaceRegistry", "ensureWorkspace/attachSession 抛错, 会话未归入工作区(分组缺失)", e);
		console.warn("[harness-mcp-server] workspace attach failed:", e?.message ?? e);
	}
}
/** 按会话 header 的 cwd(realpath 规范化后)补挂工作区; header 无 cwd 时静默跳过 */
async function attachSessionCwd(ctx, sessionId, cwd) {
	if (cwd === void 0) return;
	await attachToWorkspace(ctx, await canonicalCwd(cwd), sessionId);
}
/** 常驻 agent 会话(按 cwd 复用, 省 token: 避免每次全量加载项目上下文); preset/sandbox 记录组合时所固化值 */
const liveAgents = /* @__PURE__ */ new Map();
/** sessionId → cwd 索引(支持按 session 续接: 指定 sessionId 时定位到对应 cwd 的常驻会话) */
const sessionToCwd = /* @__PURE__ */ new Map();
/** 每个 cwd 的串行执行锁(防同一 agent 会话被并发 followup 冲突) */
const agentLocks = /* @__PURE__ */ new Map();
/** 获取(或创建)指定 cwd 的常驻 agent 会话; 传 sessionId 时接管指定会话; 传 title 时给新会话命名;
*  传 requestPreset 时本次组装用该 preset(A: 请求级覆盖, 仅影响新建/resume, 已有会话组合固化不换);
*  传 requestSandbox 时本次组装用该文件权限档(P3: 同 preset 语义 —— 新建/resume 成功后种 sandbox/mode
*  事件, 池 key 纳入档位(请求档≠会话固化档不复用、非默认档不入池), 防同 cwd 三档互相污染) */
async function getAgent(ctx, cwd, sessionId, title, requestPreset, requestSandbox) {
	const effectivePreset = requestPreset ?? runtimeConfig.preset;
	const effectiveSandbox = requestSandbox ?? runtimeConfig.defaultSandbox;
	if (sessionId) {
		const targetCwd = sessionToCwd.get(sessionId);
		if (targetCwd !== void 0) {
			const existing = liveAgents.get(targetCwd);
			if (existing) {
				liveAgents.delete(targetCwd);
				liveAgents.set(targetCwd, existing);
				return existing;
			}
		}
		const sid = SessionId(sessionId);
		const live = ctx.agents.get(sid);
		if (live) {
			await attachSessionCwd(ctx, sid, live.session.header.cwd);
			return {
				sessionId: sid,
				handle: {
					agent: live,
					dispose: () => Promise.resolve()
				},
				disposeAfter: false
			};
		}
		let handle;
		try {
			handle = await ctx.agents.resume({
				resumeSessionId: sid,
				agentOptions: {
					provider: runtimeConfig.provider,
					...runtimeConfig.model ? { model: runtimeConfig.model } : {}
				},
				setup: async (agentCtx) => {
					if (scopeOf(agentCtx) === void 0) {
						console.warn("[harness-mcp-server] agent ctx unscoped (dsh rc.6 bug); preset mount skipped — upgrade dsh for full tool support");
						return;
					}
					await ctx.agentPresets.mount(agentCtx, effectivePreset);
				}
			});
		} catch (e) {
			throw new Error(`session not found for resume: ${sessionId} (not live and not persisted; ${e?.message ?? e})`);
		}
		await attachSessionCwd(ctx, sid, handle.agent.session.header.cwd);
		try {
			appendSandboxMode(handle.agent.session, effectiveSandbox);
		} catch (e) {
			console.warn("[harness-mcp-server] sandbox mode seed failed on resume:", String(e));
		}
		return {
			sessionId: sid,
			handle,
			disposeAfter: true
		};
	}
	const existing = liveAgents.get(cwd);
	if (existing && (requestPreset === void 0 || existing.preset === requestPreset) && (requestSandbox === void 0 || existing.sandbox === requestSandbox)) {
		liveAgents.delete(cwd);
		liveAgents.set(cwd, existing);
		await attachToWorkspace(ctx, await canonicalCwd(cwd), existing.sessionId);
		return existing;
	}
	while (liveAgents.size >= runtimeConfig.maxAgents) {
		const oldestKey = liveAgents.keys().next().value;
		if (oldestKey === void 0) break;
		const old = liveAgents.get(oldestKey);
		liveAgents.delete(oldestKey);
		if (old) {
			sessionToCwd.delete(String(old.sessionId));
			try {
				old.handle?.dispose?.();
			} catch {}
		}
	}
	const newSessionId = SessionId(randomUUID());
	let createdScope;
	const canonical = await canonicalCwd(cwd);
	const handle = await ctx.agents.create({
		sessionId: newSessionId,
		meta: {
			cwd: canonical,
			agentPreset: effectivePreset
		},
		agentOptions: {
			provider: runtimeConfig.provider,
			...runtimeConfig.model ? { model: runtimeConfig.model } : {}
		},
		setup: async (agentCtx) => {
			if (scopeOf(agentCtx) === void 0) {
				console.warn("[harness-mcp-server] agent ctx unscoped (dsh rc.6 bug); preset mount skipped — upgrade dsh for full tool support");
				return;
			}
			createdScope = scopeOf(agentCtx);
			await ctx.agentPresets.mount(agentCtx, effectivePreset);
		}
	});
	try {
		appendSandboxMode(handle.agent.session, effectiveSandbox);
	} catch (e) {
		console.warn("[harness-mcp-server] sandbox mode seed failed on create:", String(e));
	}
	const rec = {
		sessionId: newSessionId,
		handle,
		preset: effectivePreset,
		sandbox: effectiveSandbox,
		scope: createdScope
	};
	if ((requestPreset === void 0 || requestPreset === runtimeConfig.preset) && (requestSandbox === void 0 || requestSandbox === runtimeConfig.defaultSandbox)) {
		liveAgents.set(cwd, rec);
		sessionToCwd.set(String(newSessionId), cwd);
	}
	(async () => {
		try {
			const ws = await ensureWorkspace(ctx, canonical);
			if (ws?.attachSession) await ws.attachSession(newSessionId);
		} catch (e) {
			console.warn("[harness-mcp-server] workspace attach failed:", String(e));
		}
	})();
	if (title) try {
		const session = handle.agent.session;
		ctx.get("sessionTitle")?.rename?.(session, title);
	} catch (e) {
		degrade("sessionTitle", "ctx.get(sessionTitle).rename() 抛错, 新会话标题未设置", e);
		console.warn("[harness-mcp-server] session title set failed:", String(e));
	}
	return rec;
}
/** 同一 cwd 串行执行, 避免并发 followup 同一会话 */
async function withLock(cwd, fn) {
	const next = (agentLocks.get(cwd) ?? Promise.resolve()).then(fn, fn);
	agentLocks.set(cwd, next.catch(() => {}));
	return next;
}
/** 从 agent 最终回答里解析 changes/verification/leftovers(从后往前找候选, 更可靠) */
function parseSummary(assistantText) {
	const empty = {
		changes: "",
		verification: "",
		leftovers: ""
	};
	const candidates = [];
	const re = /\{[\s\S]*?\}/g;
	let m;
	while ((m = re.exec(assistantText)) !== null) candidates.push(m[0]);
	for (let i = candidates.length - 1; i >= 0; i--) try {
		const obj = JSON.parse(candidates[i]);
		const s = (v) => typeof v === "string" ? v : "";
		const changes = s(obj.changes) || s(obj.改动);
		const verification = s(obj.verification) || s(obj.验证);
		const leftovers = s(obj.leftovers) || s(obj.遗留) || s(obj.leftover);
		if (changes || verification || leftovers) return {
			changes,
			verification,
			leftovers
		};
	} catch {}
	return empty;
}
/**
* [r3] B4: 从 agent 产出文本里抽取"看起来是文件绝对路径"的片段。
* 优先取 / 开头的绝对路径(去掉行尾标点), 用于判断结果是否已带可点击的落点。
*/
function extractAbsPaths(text) {
	if (!text) return [];
	const out = [];
	const re = /(?:^|[\s`'"(【\[])(\/[^\s`'"()【】\[\],;:]+)/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const p = (m[1] ?? "").replace(/[.。;；,，]+$/, "");
		if (p.length > 1 && !out.includes(p)) out.push(p);
	}
	return out;
}
/**
* [r3] B4: agent_run 结果的"落点提示"。
* 结果文本提到「已写入文件」但没有任何绝对路径时, 补一条 hint 指向沙箱 cwd(常见落点),
* 避免 agent 拿着 changes 描述却不知道文件到底写在哪。
*/
function fileLandingHint(result, cwd) {
	const blob = `${result.changes}\n${result.verification}\n${result.assistantText}`;
	const mentionedWrite = /已写入|已创建|已保存|写入了|写入文件|保存到|created file|written to|saved to|wrote to/i.test(blob);
	const pathsInResult = extractAbsPaths(blob);
	if (!mentionedWrite) return void 0;
	if (pathsInResult.length > 0) return void 0;
	return {
		hint: `结果提到写入了文件但没有给出绝对路径; 文件通常落在本次沙箱工作目录 cwd=${cwd} 下, 用 fs_list(path="${cwd}") 或 fs_stat 定位具体文件`,
		likelyDir: cwd,
		mentionedWrite,
		pathsInResult
	};
}
/** 分字段限长, 保证返回的永远是完整合法 JSON(避免 slice(-16000) 截断开头导致非法 JSON) */
function truncateResult(result) {
	return {
		...result,
		assistantText: result.assistantText.slice(0, 8e3),
		toolCalls: result.toolCalls.slice(0, 50).map((c) => ({
			...c,
			args: c.args.slice(0, 2e3)
		})),
		toolResults: result.toolResults.slice(0, 20).map((r) => r.slice(0, 2e3))
	};
}
/** 核心执行: 组装任务(注入记忆上下文+结构化要求) → agent 执行 → 读结构化结果。
*  P2 opts: preset=请求级覆盖; onSessionStart=拿到 agent 会话后回调(B 登记 taskRunSessions);
*  isCancelled=协作取消探测(B: 锁内/followup 前两个检查点)。
*  P3 opts: sandbox=请求级权限三档覆盖(透传 getAgent; 仅影响新建/resume 组合)。 */
/**
* [P0-1] 0-token 显式告警(定向防御 0.1.7 那类静默失效)。
*
* 判据(与 DISCUSS_20261003 §3.3 落地物 6 一致): `inputTokens === 0 && 会话事件数 === 0`。
*   - 0.1.7 事故: `MessageSourceMap` 收紧后插件自带的 `kind:'plugin'` 被判非法, message 被
*     上游 `catch(_error){}` 静默吞掉 → agent 秒退、inTok=0、会话零事件、零报错。
*   - 正常一次 run 至少会产生一条 `user/message` 事件, 因此「零事件」是强信号;
*     仅 inTok=0 但有事件(如只有 system-prompt)不告警, 避免误报。
*
* 只告警、不改行为: 仍然把结果原样返回给调用方。
*
* @param result   executeTask 已折叠好的结果(stats.inputTokens 取自 assistant/message.usage)
* @param baseline followup 之前的日志长度(事件数 = 本次新增的日志条数)
* @param handle   agent 句柄(读 session.log)
*/
function warnOnEmptyRun(result, baseline, handle) {
	let eventCount = 0;
	try {
		const log = handle.agent.session.log ?? [];
		eventCount = Math.max(0, log.length - baseline);
	} catch {
		return;
	}
	const inputTokens = Number(result.stats?.inputTokens ?? 0);
	if (eventCount !== 0 || inputTokens !== 0) return;
	console.error("[harness-mcp-server] ⛔ 注入的 prompt 未进入会话(inTok=0 且无事件)。");
	console.error("   这几乎总是 MessageSourceMap/source.kind 契约变更的症状。");
	console.error("   参见 docs/TROUBLESHOOTING.md#agent-秒退--0-token--无任何报错");
	console.error(`   sessionId=${String(result.sessionId)} baseline=${baseline} events=${eventCount} inTok=${inputTokens}`);
	degrade("agent_run", `prompt 未进入会话(inTok=0 且无事件; sessionId=${String(result.sessionId)})`);
}
async function executeTask(ctx, task, context, cwd, resumeSessionId, title, opts) {
	const workdir = await canonicalCwd(cwd ? resolve(cwd) : process.cwd());
	if (runtimeConfig.workspaceRoots.length > 0) {
		if (!runtimeConfig.workspaceRoots.some((root) => {
			const r = resolve(root);
			return workdir === r || workdir.startsWith(r + "/");
		})) throw new Error(`cwd not allowed (outside workspaceRoots): ${workdir}`);
	}
	return withLock(resumeSessionId ? `session:${resumeSessionId}` : workdir, async () => {
		if (opts?.isCancelled?.()) throw new Error("task cancelled before execution");
		const { sessionId, handle, disposeAfter } = await getAgent(ctx, workdir, resumeSessionId, title, opts?.preset, opts?.sandbox);
		opts?.onSessionStart?.(String(sessionId));
		lastAgentSessionId = String(sessionId);
		if (opts?.isCancelled?.()) throw new Error("task cancelled before execution");
		const baseline = (handle.agent.session.log ?? []).length;
		const fullTask = [
			context ? `【记忆/上下文(供参考, 来自 Hermes 大脑)】\n${context}\n` : "",
			`【任务】\n${task}\n`,
			`【完成后必须】用一行 JSON 总结(不要 markdown 代码块包裹, 直接输出这一行):`,
			`{"changes":"改了什么","verification":"怎么验证的","leftovers":"遗留问题"}`
		].filter(Boolean).join("\n");
		handle.agent.followup(createUserMessage({
			content: [{
				type: "text",
				text: fullTask
			}],
			source: { kind: "user" }
		}));
		await handle.agent.whenIdle();
		const result = {
			taskId: "",
			sessionId,
			assistantText: "",
			toolCalls: [],
			toolResults: [],
			changes: "",
			verification: "",
			leftovers: ""
		};
		try {
			const log = (handle.agent.session.log ?? []).slice(baseline);
			for (const e of log) {
				const ev = e;
				if (ev.type === "assistant/message") {
					const content = ev.data?.message?.content;
					if (content) {
						const cleaned = stripReasoning(content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n"));
						if (cleaned) result.assistantText += cleaned + "\n";
					}
				} else if (ev.type === "tool/call") {
					const d = ev.data;
					result.toolCalls.push({
						name: d?.name ?? "?",
						args: (d?.arguments ?? JSON.stringify(d?.input ?? null) ?? "").slice(0, 2e3)
					});
				} else if (ev.type === "tool/result") {
					const texts = [];
					collectText(ev.data ?? ev, texts);
					if (texts.length) result.toolResults.push(stripReasoning(texts.join("\n")).slice(0, 3e3));
				}
			}
		} catch (e) {
			result.assistantText = `[读输出异常] ${String(e)}`;
		}
		const summary = parseSummary(result.assistantText);
		result.changes = summary.changes;
		result.verification = summary.verification;
		result.leftovers = summary.leftovers;
		if (opts?.sandbox !== void 0) result.sandbox = opts.sandbox;
		try {
			result.stats = presentSessionStats(foldSessionStats((handle.agent.session.log ?? []).slice(baseline)), {
				scope: "run",
				sessionId: String(sessionId)
			});
		} catch (e) {
			console.warn("[harness-mcp-server] stats fold failed:", e?.message ?? e);
		}
		warnOnEmptyRun(result, baseline, handle);
		if (disposeAfter) {
			try {
				await ctx.get("sessions")?.flush?.(handle.agent.session);
			} catch (e) {
				degrade("sessions.flush", "resume 路径 flush 失败, 本次任务结果未落盘(重启后会话内容会缺失)", e);
			}
			try {
				await handle.dispose();
			} catch {}
		}
		return result;
	});
}
/** 异步任务队列(进程内存, 骨架阶段; 后续可持久化) */
const taskQueue = /* @__PURE__ */ new Map();
/** 回调 URL 端口显式白名单: 仅 http/https 的默认端口可省略; 其他端口必须显式写出(拒绝奇 scheme 借默认端口伪装) */
const CALLBACK_ALLOWED_SCHEMES = /* @__PURE__ */ new Set(["http:", "https:"]);
/** 云 metadata / 链路本地地址: 无合法回调用途, standard 档恒拒(即使部署在云上也应走白名单显式放行) */
const CALLBACK_METADATA_HOSTS = /* @__PURE__ */ new Set(["169.254.169.254", "metadata.google.internal"]);
/** 私网/回环判定(CIDR 掩码按位比较; IPv6 只做常见形式前缀判断) */
const CALLBACK_PRIVATE_RANGES = [
	{
		net: "10.0.0.0",
		bits: 8
	},
	{
		net: "172.16.0.0",
		bits: 12
	},
	{
		net: "192.168.0.0",
		bits: 16
	},
	{
		net: "127.0.0.0",
		bits: 8
	},
	{
		net: "169.254.0.0",
		bits: 16
	},
	{
		net: "0.0.0.0",
		bits: 8
	},
	{
		net: "100.64.0.0",
		bits: 10
	},
	{
		net: "fc00::",
		bits: 7
	},
	{
		net: "fe80::",
		bits: 10
	}
];
/** IPv4 字符串 → 32 位整数(非法返回 null) */
function ipv4ToInt(s) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
	if (!m) return null;
	let n = 0;
	for (let i = 1; i <= 4; i++) {
		const oct = Number(m[i]);
		if (!Number.isInteger(oct) || oct < 0 || oct > 255) return null;
		n = n * 256 + oct;
	}
	return n;
}
/** 目标 IP 是否落在私网/回环/链路本地/CGNAT 段 */
function isPrivateIp(ip) {
	const v4 = ipv4ToInt(ip);
	if (v4 !== null) return CALLBACK_PRIVATE_RANGES.some(({ net, bits }) => {
		const base = ipv4ToInt(net);
		if (base === null) return false;
		const mask = bits === 0 ? 0 : 4294967295 << 32 - bits >>> 0;
		return (v4 >>> 0 & mask) === (base >>> 0 & mask);
	});
	const low = ip.toLowerCase();
	return low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80");
}
/**
* [P0 回调] SSRF 防护判定(P0 口径, 同步纯函数)。
* 返回 undefined = 允许; 字符串 = 拒绝原因(不含原始 url, 防泄漏)。
* 规则(REQ §3): 仅 http/https; 私网/回环/链路本地(含 169.254.169.254 云 metadata)默认拒绝;
* allowedCallbackHosts(部署配置)显式放行(精确 'host' / 'host:port' / 通配 '*.suffix')。
* P0 限制(已知): 域名解析后指向私网的 DNS rebinding 不在此拦截(DNS 解析在 http.request 内部,
* 同步入口拿不到解析结果); 需要更强保证的部署请用 allowedCallbackHosts 白名单。
*/
function ssrfGuardCheck(rawUrl, allowedHosts) {
	let u;
	try {
		u = new URL(rawUrl);
	} catch {
		return "callback.url is not a valid absolute URL";
	}
	if (!CALLBACK_ALLOWED_SCHEMES.has(u.protocol)) return `callback.url scheme "${u.protocol}" not allowed (http/https only)`;
	const host = (u.hostname || "").toLowerCase();
	if (!host) return "callback.url has no host";
	const port = u.port;
	if (matchesCallbackAllowlist(host, port, allowedHosts)) return void 0;
	if (CALLBACK_METADATA_HOSTS.has(host)) return `callback host "${host}" is a cloud metadata endpoint (denied; add to allowedCallbackHosts only if intentional)`;
	if (ipv4ToInt(host) !== null && isPrivateIp(host)) return `callback host "${host}" is a private/loopback address (denied; use allowedCallbackHosts to allow an internal gateway)`;
	if (host === "0.0.0.0" || host === "[::]" || host === "::") return "callback host \"0.0.0.0\" is not a routable callback target";
}
/** [P0 回调] 白名单匹配: 'host' / 'host:port' / '*.suffix'(大小写不敏感; *.suffix 匹配任意子域, 不含 suffix 本身) */
function matchesCallbackAllowlist(host, port, allowedHosts) {
	for (const raw of allowedHosts) {
		if (typeof raw !== "string" || !raw.trim()) continue;
		const entry = raw.trim().toLowerCase();
		const eHost = entry.includes(":") ? entry.slice(0, entry.indexOf(":")) : entry;
		const ePort = entry.includes(":") ? entry.slice(entry.indexOf(":") + 1) : "";
		if (eHost.startsWith("*.")) {
			const suffix = eHost.slice(1);
			if (host.endsWith(suffix) && host.length > suffix.length && (!ePort || ePort === port)) return true;
			continue;
		}
		if (eHost !== host) continue;
		if (ePort && ePort !== port) continue;
		return true;
	}
	return false;
}
/**
* [P0 回调] 解析 task_inbox.callback → 运行时配置(入口一次性完成: schema 已过, 这里只做
* SSRF 判定 + secret 缺省回填 + 保留头剔除 + replyContext 序列化体积上限)。
* [r1] 增加部署级预设(callbackPreset)支持: 合并语义为"任务级 > 预设 > 内置默认"(PLAN_r1 §2.4),
*      SSRF 守卫**置于合并之后**(预设不放宽任何安全策略, 裁决 D9)。
* 成功返回 { config, signed, source }, 失败返回 { error }(文案走 errText 统一句式)。
*/
function resolveCallback(raw) {
	const preset = runtimeConfig.callbackPreset?.autoApply === false ? void 0 : runtimeConfig.callbackPreset;
	if (raw === void 0 || raw === null) {
		if (preset?.url) return finishResolvedCallback(buildPresetOnlyConfig(preset), "preset");
		return {};
	}
	if (typeof raw !== "object" || Array.isArray(raw)) return { error: errText("invalid parameter type", "task_inbox.callback", "expected object, got " + (Array.isArray(raw) ? "array" : typeof raw), "callback 需为对象 {url, method?, headers?, events?, secret?, replyContext?, timeoutMs?}") };
	const rec = raw;
	if (Object.keys(rec).length === 0 && preset?.url) return finishResolvedCallback(buildPresetOnlyConfig(preset), "preset");
	const taskUrl = typeof rec.url === "string" ? rec.url.trim() : "";
	const url = taskUrl || (preset?.url ?? "");
	if (!url) return { error: errText("missing required parameter", "task_inbox.callback.url", "expected string url (http/https), got nothing", "补上 callback.url 后重试; 或在部署配置里设 callbackPreset.url, 之后不传 callback 也能发回调") };
	const ssrf = ssrfGuardCheck(url, runtimeConfig.allowedCallbackHosts);
	if (ssrf !== void 0) return { error: errText("callback.url rejected by ssrf guard", url.split("?")[0] ?? url, ssrf, "如目标确为内网可信端点, 在部署配置 allowedCallbackHosts 中显式放行") };
	const usedPresetUrl = !taskUrl;
	const method = rec.method === "PUT" ? "PUT" : rec.method === "POST" ? "POST" : preset?.method ?? "POST";
	let events;
	if (Array.isArray(rec.events)) {
		const filtered = rec.events.filter((e) => e === "done" || e === "error" || e === "cancelled");
		if (filtered.length === 0 && rec.events.length > 0) return { error: errText("invalid parameter value", "task_inbox.callback.events", "no valid event in list (valid: done|error|cancelled)", "从 [\"done\",\"error\",\"cancelled\"] 里挑选要订阅的终态事件, 或传 [] 订阅全部") };
		events = filtered;
	} else if (preset?.events !== void 0) events = [...preset.events];
	else events = ["done", "error"];
	const headers = mergeCallbackHeaders(preset?.headers, sanitizeCallbackHeaders(rec.headers));
	if (rec.headers !== void 0 && rec.headers !== null && (typeof rec.headers !== "object" || Array.isArray(rec.headers))) return { error: errText("invalid parameter type", "task_inbox.callback.headers", "expected object, got " + (Array.isArray(rec.headers) ? "array" : typeof rec.headers), "headers 需为 { \"头名\": \"值\" } 的平面对象") };
	const secret = typeof rec.secret === "string" && rec.secret.length > 0 ? rec.secret : runtimeConfig.defaultCallbackSecret || void 0;
	let replyContext;
	const merged = mergeReplyContext(preset?.replyContext, rec.replyContext);
	if (merged !== void 0) {
		const literalTemplate = findLiteralTemplateValue(merged);
		if (literalTemplate !== void 0) return { error: errText("invalid parameter value", "task_inbox.callback.replyContext", `field "${literalTemplate}" is a literal template placeholder`, "这里要填真实值, 不是 {replyContext.xxx} 模板串; 模板只在 Hermes 订阅配置里写") };
		try {
			const s = JSON.stringify(merged);
			if (s !== void 0 && s.length > 4096) return { error: errText("invalid parameter value", "task_inbox.callback.replyContext", `serialized size ${s.length} > 4096`, "精简 replyContext 内容后重试(会话路由只需 id 类字段, 无需整段上下文)") };
		} catch {
			return { error: errText("invalid parameter value", "task_inbox.callback.replyContext", "not JSON-serializable (circular?)", "replyContext 必须可 JSON 序列化(去掉循环引用后重试)") };
		}
		replyContext = merged;
	}
	if (preset?.requireReplyRoute === true && !hasReplyRouteField(replyContext)) return { error: errText("invalid parameter value", "task_inbox.callback.replyContext", "no chat routing field (expected *ChatId/chatId)", "本次回调无法路由到目标会话(Hermes 侧按 replyContext.replyChatId 路由); 在 callback.replyContext 里补上 replyChatId") };
	let timeoutMs = preset?.timeoutMs ?? 5e3;
	if (rec.timeoutMs !== void 0 && rec.timeoutMs !== null) {
		const t = Number(rec.timeoutMs);
		if (!Number.isInteger(t) || t < 1e3 || t > 3e4) return { error: errText("invalid parameter value", "task_inbox.callback.timeoutMs", `expected int in [1000,30000], got ${String(rec.timeoutMs)}`, "timeoutMs 取 1000~30000 之间的整数毫秒") };
		timeoutMs = t;
	}
	const source = preset?.url !== void 0 ? usedPresetUrl ? "preset" : "preset+task" : "task";
	return {
		config: {
			url,
			method,
			headers,
			secret,
			events,
			replyContext,
			timeoutMs
		},
		signed: secret !== void 0,
		source
	};
}
/** [r1] 只用预设构造配置(调用方完全没传 callback 的路径) */
function buildPresetOnlyConfig(preset) {
	const url = preset.url;
	if (!url) return void 0;
	const secret = runtimeConfig.defaultCallbackSecret || void 0;
	return {
		url,
		method: preset.method ?? "POST",
		headers: sanitizeCallbackHeaders(preset.headers),
		secret,
		events: preset.events !== void 0 ? [...preset.events] : ["done", "error"],
		replyContext: preset.replyContext,
		timeoutMs: preset.timeoutMs ?? 5e3
	};
}
/** [r1] 预设路径的统一收尾(SSRF 守卫 + 体积校验与任务级路径同款, 预设不放宽任何策略) */
function finishResolvedCallback(config, source) {
	if (!config) return {};
	const ssrf = ssrfGuardCheck(config.url, runtimeConfig.allowedCallbackHosts);
	if (ssrf !== void 0) return { error: errText("callback.url rejected by ssrf guard", config.url.split("?")[0] ?? config.url, ssrf, "如目标确为内网可信端点, 在部署配置 allowedCallbackHosts 中显式放行") };
	if (config.replyContext !== void 0) {
		const literalTemplate = findLiteralTemplateValue(config.replyContext);
		if (literalTemplate !== void 0) return { error: errText("invalid parameter value", "callbackPreset.replyContext", `field "${literalTemplate}" is a literal template placeholder`, "部署预设的 replyContext 要填真实值; {replyContext.xxx} 模板串只写在 Hermes 订阅配置里") };
		try {
			const s = JSON.stringify(config.replyContext);
			if (s !== void 0 && s.length > 4096) return { error: errText("invalid parameter value", "callbackPreset.replyContext", `serialized size ${s.length} > 4096`, "精简部署预设的 replyContext 内容(会话路由只需 id 类字段)") };
		} catch {
			return { error: errText("invalid parameter value", "callbackPreset.replyContext", "not JSON-serializable (circular?)", "部署预设的 replyContext 必须可 JSON 序列化") };
		}
	}
	if (runtimeConfig.callbackPreset?.requireReplyRoute === true && !hasReplyRouteField(config.replyContext)) return { error: errText("invalid parameter value", "callbackPreset.replyContext", "no chat routing field (expected *ChatId/chatId)", "本次回调无法路由到目标会话; 在 callbackPreset.replyContext 里配静态 chat id, 或每次调用时传 callback.replyContext.replyChatId") };
	return {
		config,
		signed: config.secret !== void 0,
		source
	};
}
/** [r1] headers 净化: 仅接受 string→string 平面映射, 剔除保留头(host/content-length/connection/transfer-encoding) */
function sanitizeCallbackHeaders(raw) {
	if (raw === void 0 || raw === null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
	const out = {};
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v !== "string") continue;
		const name = k.trim();
		if (!name) continue;
		if (CALLBACK_RESERVED_HEADERS.includes(name.toLowerCase())) continue;
		out[name] = v;
	}
	return Object.keys(out).length > 0 ? out : void 0;
}
/** [r1] headers 浅合并: 任务级同名覆盖预设; 任一侧缺失就取另一侧(合并后再净化一次, 防预设里夹带保留头) */
function mergeCallbackHeaders(base, override) {
	if (base === void 0 && override === void 0) return void 0;
	return sanitizeCallbackHeaders({
		...base ?? {},
		...override ?? {}
	});
}
/** [r1] replyContext 深合并(一层): 两侧都是平面对象才逐键合并(任务级优先), 否则任务级整体覆盖 */
function mergeReplyContext(base, override) {
	if (override === void 0) return base;
	if (base === void 0) return override;
	const isPlain = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
	if (!isPlain(base) || !isPlain(override)) return override;
	return {
		...base,
		...override
	};
}
/** [r1] 检测形如 "{replyContext.xxx}" 的字面量模板串(Hermes 模板取不到值时会原样当值用 → 静默误投) */
function findLiteralTemplateValue(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	for (const [k, v] of Object.entries(value)) if (typeof v === "string" && /^\{[\w.]+\}$/.test(v.trim())) return k;
}
/** [r1] replyContext 里是否存在聊天路由字段(键名含 chatid, 大小写与分隔符不敏感; Hermes 用 replyChatId) */
function hasReplyRouteField(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	for (const [k, v] of Object.entries(value)) {
		if (!k.toLowerCase().replace(/[_-]/g, "").includes("chatid")) continue;
		if (typeof v === "string" && v.trim() !== "") return true;
		if (typeof v === "number" && Number.isFinite(v)) return true;
	}
	return false;
}
/**
* [P0 回调] 组装标准回调 Envelope 载荷(REQ §2 字段逐一对应)。
* result 仅 done 且存在时携带(经 truncateResult 裁剪); cancelled 不携带 result/error(收尾时已删);
* replyContext opaque 原样回传。
*/
function buildCallbackPayload(item) {
	return {
		event: `task:${item.status}`,
		type: `task:${item.status}`,
		taskId: item.id,
		sessionId: item.sessionId,
		title: item.title,
		status: item.status,
		createdAt: item.createdAt,
		finishedAt: item.finishedAt,
		durationMs: (item.finishedAt ?? Date.now()) - item.createdAt,
		replyContext: item.callback?.replyContext,
		result: item.status === "done" && item.result ? truncateResult(item.result) : void 0,
		error: item.status === "error" ? item.error : void 0
	};
}
/**
* [P0 回调] HMAC-SHA256 签名(secret 存在时)。
* 签名材料 = `${timestamp}.${rawBody}`; 时间戳入签 → 接收方校验 X-DSH-Timestamp 窗口即可防重放。
*/
function signCallbackPayload(secret, timestamp, rawBody) {
	return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}
/** [P0 回调] 恒时字符串比较(验签用; 长度不等时直接 false, 不比较) */
function safeEqualStr(a, b) {
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
	} catch {
		return false;
	}
}
/**
* [P0 回调] 投递一次回调(http → https): REQ §2 的 sendCallback。
* - 2xx 即成功(响应体丢弃式消费, 不解析内容, 防恶意端点借响应注入);
* - 超时/网络失败/非 2xx → { delivered:false, error } —— **绝不抛错**;
* - 超时实现: req.setTimeout(timeoutMs) + destroy(整体超时, 含连接与响应窗口)。
*/
function sendCallback(url, method, headers, body, timeoutMs) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (r) => {
			if (settled) return;
			settled = true;
			resolve(r);
		};
		let u;
		try {
			u = new URL(url);
		} catch (e) {
			finish({
				delivered: false,
				error: `invalid url: ${e?.message ?? "parse failed"}`
			});
			return;
		}
		const req = (u.protocol === "https:" ? https : http).request(u, {
			method,
			headers: {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body).toString(),
				...CALLBACK_BASE_HEADERS,
				...headers ?? {}
			},
			timeout: timeoutMs
		}, (res) => {
			res.resume();
			const code = res.statusCode ?? 0;
			finish(code >= 200 && code < 300 ? {
				delivered: true,
				status: code
			} : {
				delivered: false,
				status: code,
				error: `non-2xx status ${code}`
			});
		});
		req.on("timeout", () => {
			req.destroy(/* @__PURE__ */ new Error(`callback timeout after ${timeoutMs}ms`));
		});
		req.on("error", (e) => {
			finish({
				delivered: false,
				error: e?.message ?? "request failed"
			});
		});
		req.end(body, "utf8");
	});
}
/** 回调投递的固定附加头(集中定义防散落) */
const CALLBACK_BASE_HEADERS = { "user-agent": "hermes-dsh-bridge-task-callback" };
const pendingQuestions = /* @__PURE__ */ new Map();
/** 问题应答的超时(毫秒); 0 = 不超时(不推荐) */
const QUESTION_ANSWER_TIMEOUT_MS = 18e5;
function clearQuestionTimer(entry) {
	if (entry.timer !== void 0) {
		clearTimeout(entry.timer);
		entry.timer = void 0;
	}
}
/** 出队并清定时器(幂等) */
function removePendingQuestion(questionId) {
	const entry = pendingQuestions.get(questionId);
	if (entry === void 0) return void 0;
	pendingQuestions.delete(questionId);
	clearQuestionTimer(entry);
	return entry;
}
/**
* [r8] 发一条「等待回答」回调, 通知发起方会话。
* 与任务终态回调同一条路(webhook → 唤醒发起方会话), 但 event 用 `task:question`,
* 载荷带 questions 全文, 让发起方(或用户)直接能答。
* 非阻塞: 不 await 投递结果, 应答器立刻进入等待文件状态。
*/
function dispatchQuestionCallback(entry) {
	const cb = runtimeConfig.questionCallback;
	if (cb === void 0 || cb.url === "") {
		console.warn(`[harness-mcp-server] user-question ${entry.questionId} 无 questionCallback 配置, 仅写盘等待`);
		return;
	}
	const url = cb.url;
	if (url === void 0 || url === "") return;
	const body = JSON.stringify({
		event: "task:question",
		type: "task:question",
		questionId: entry.questionId,
		sessionId: entry.sessionId,
		questions: entry.questions,
		requestedAt: entry.requestedAt,
		replyContext: cb.replyContext ?? {}
	});
	sendCallback(url, cb.method ?? "POST", cb.headers, body, cb.timeoutMs ?? 5e3).then((r) => {
		if (r.delivered) console.log(`[harness-mcp-server] user-question callback delivered (questionId=${entry.questionId}, urlHost=${hostOfCallbackUrl(url)})`);
		else console.warn(`[harness-mcp-server] user-question callback failed (questionId=${entry.questionId}): ${r.error ?? `status ${r.status}`}`);
	});
}
function makeUserQuestionAnswerer(ctx) {
	return async (req, next) => {
		console.log(`[harness-mcp-server] user-questions answerer INVOKED (questions=${Array.isArray(req.questions) ? req.questions.length : "n/a"}, aborted=${req.signal?.aborted === true})`);
		if (req.signal?.aborted === true) return next();
		const questions = req.questions ?? [];
		if (questions.length === 0) {
			console.warn("[harness-mcp-server] user-questions answerer: 空 questions, 交给 next");
			return next();
		}
		const sess = req.agent?.session;
		const sessionId = String(sess?.id ?? "");
		const questionId = randomUUID();
		const entry = {
			questionId,
			sessionId,
			questions: questions.map((q) => ({
				id: q.id,
				question: q.question,
				...q.header !== void 0 ? { header: q.header } : {},
				...q.options !== void 0 ? { options: q.options } : {},
				...q.multiSelect !== void 0 ? { multiSelect: q.multiSelect } : {}
			})),
			requestedAt: Date.now(),
			settle: () => {},
			fail: () => {}
		};
		writePendingQuestionFile(entry);
		dispatchQuestionCallback(entry);
		return new Promise((resolve, reject) => {
			entry.settle = (answer) => {
				removePendingQuestion(questionId);
				cleanupQuestionFiles(questionId);
				resolve(answer);
			};
			entry.fail = (err) => {
				removePendingQuestion(questionId);
				cleanupQuestionFiles(questionId);
				reject(err);
			};
			pendingQuestions.set(questionId, entry);
			entry.timer = setTimeout(() => {
				const still = removePendingQuestion(questionId);
				if (still === void 0) return;
				cleanupQuestionFiles(questionId);
				still.fail(/* @__PURE__ */ new Error(`ask_user_question 超时未答 (${Math.round(QUESTION_ANSWER_TIMEOUT_MS / 6e4)} 分钟): ${questions.map((q) => q.id).join(", ")}`));
			}, QUESTION_ANSWER_TIMEOUT_MS);
			if (typeof entry.timer === "object" && entry.timer !== null && "unref" in entry.timer) entry.timer.unref?.();
		});
	};
}
/** 问题应答的文件目录(复用审批桥的目录; 未启用时静默跳过) */
function questionFileDir() {
	return approvalBridgeFiles?.dir ?? null;
}
async function writePendingQuestionFile(entry) {
	const dir = questionFileDir();
	if (dir === null) return;
	try {
		await mkdir(dir, { recursive: true });
		const payload = {
			questionId: entry.questionId,
			sessionId: entry.sessionId,
			requestedAt: entry.requestedAt,
			questions: entry.questions,
			answerFile: `question_answer_${entry.questionId}.json`
		};
		await writeFile(`${dir}/question_${entry.questionId}.json`, JSON.stringify(payload, null, 2), "utf8");
	} catch (e) {
		console.warn(`[harness-mcp-server] 写 question 文件失败 (${entry.questionId}): ${String(e)}`);
	}
}
async function cleanupQuestionFiles(questionId) {
	const dir = questionFileDir();
	if (dir === null) return;
	for (const name of [`question_${questionId}.json`, `question_answer_${questionId}.json`]) try {
		await unlink(`${dir}/${name}`);
	} catch {}
}
/**
* [r8] 消费一个问题应答文件: 内容有效且问题仍挂起 → settle。
* 与 handleApprovalResponseFile 同款: 无论结果如何都消费该文件, 防堆积; 半写文件留待下轮。
*/
async function handleQuestionAnswerFile(filePath, questionId) {
	let payload;
	try {
		payload = JSON.parse(await readFile(filePath, "utf8"));
	} catch {
		return;
	}
	const mismatch = payload?.questionId !== void 0 && payload.questionId !== questionId;
	const entry = pendingQuestions.get(questionId);
	const answers = Array.isArray(payload?.answers) ? payload.answers : [];
	if (!mismatch && entry !== void 0 && answers.length > 0) {
		const normalized = answers.filter((a) => typeof a?.id === "string").map((a) => ({
			id: String(a.id),
			selected: Array.isArray(a.selected) ? a.selected.map((s) => String(s)) : [],
			...typeof a.custom === "string" ? { custom: a.custom } : {}
		}));
		if (normalized.length > 0) {
			entry.settle({ answers: normalized });
			console.log(`[harness-mcp-server] user-question ${questionId} answered via file`);
		} else console.warn(`[harness-mcp-server] user-question answer file ignored (${questionId}): 无有效 answers`);
	} else console.warn(`[harness-mcp-server] user-question answer file ignored (${questionId}${mismatch ? `; payload questionId=${String(payload?.questionId)} mismatch` : ""}${entry === void 0 ? "; not-pending" : ""})`);
	try {
		await unlink(filePath);
	} catch {}
}
/** [r8] 轮询 question_answer_*.json(与审批桥同款定时扫描) */
async function scanQuestionAnswerFiles() {
	const dir = questionFileDir();
	if (dir === null) return;
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith("question_answer_") || !name.endsWith(".json")) continue;
		const questionId = name.slice(16, -5);
		if (questionId === "") continue;
		await handleQuestionAnswerFile(`${dir}/${name}`, questionId);
	}
}
/** [r1] 回调自定义头里的保留头(由运行时固定, 一律剔除; 部署预设与任务级都适用) */
const CALLBACK_RESERVED_HEADERS = [
	"host",
	"content-length",
	"connection",
	"transfer-encoding"
];
/** [P0 回调] 提取回调 URL 的 host(:port)(日志/回显脱敏用, 不含 path/query) */
function hostOfCallbackUrl(url) {
	try {
		return new URL(url).host;
	} catch {
		return "(invalid-url)";
	}
}
/**
* [P0 回调] 任务终态回调发射器(runner 收尾处调用; 语义 = REQ §2 的 void sendCallback 非阻塞发射)。
* - 未配置/未订阅该终态/全局开关关闭 → item.notify = skipped(或不动);
* - 组装 Envelope(REQ §2 字段逐一对应) → 签名(secret 存在时) → sendCallback;
* - 结果写回 item.notify(delivered/failed + lastError); **全程 try/catch, 严禁抛错拖垮主进程**。
*/
function dispatchTaskCallback(item) {
	const cb = item.callback;
	if (!cb) return;
	if (runtimeConfig.notifyEnabled === false) {
		item.notify = {
			state: "skipped",
			attempts: 0,
			notifiedAt: Date.now()
		};
		return;
	}
	if (!(cb.events.length === 0 || cb.events.includes(item.status))) {
		item.notify = {
			state: "skipped",
			attempts: 0,
			notifiedAt: Date.now()
		};
		return;
	}
	let body;
	try {
		body = JSON.stringify(buildCallbackPayload(item));
	} catch (e) {
		item.notify = {
			state: "failed",
			attempts: 1,
			notifiedAt: Date.now(),
			lastError: `payload serialize failed: ${e?.message ?? "?"}`
		};
		return;
	}
	const ts = Math.floor(performance.timeOrigin + performance.now());
	const signature = cb.secret !== void 0 ? signCallbackPayload(cb.secret, ts, body) : void 0;
	(async () => {
		let outcome;
		try {
			outcome = await sendCallback(cb.url, cb.method, {
				...cb.headers ?? {},
				...signature !== void 0 ? {
					"x-dsh-signature": `sha256=${signature}`,
					"x-dsh-timestamp": String(ts)
				} : {}
			}, body, cb.timeoutMs);
		} catch (e) {
			outcome = {
				delivered: false,
				error: e?.message ?? "callback dispatch threw"
			};
		}
		item.notify = outcome.delivered ? {
			state: "delivered",
			attempts: 1,
			notifiedAt: Date.now()
		} : {
			state: "failed",
			attempts: 1,
			notifiedAt: Date.now(),
			...outcome.error !== void 0 ? { lastError: outcome.error.slice(0, 200) } : {}
		};
		if (outcome.delivered) console.log(`[harness-mcp-server] task callback delivered (taskId=${item.id}, event=task:${item.status}, urlHost=${hostOfCallbackUrl(cb.url)})`);
		else console.warn(`[harness-mcp-server] task callback failed (taskId=${item.id}, event=task:${item.status}): ${outcome.error ?? `status ${outcome.status}`}`);
	})();
}
/** B: 执行中任务 → agent 会话 id(task_cancel 用它定位要中止的 Agent; executeTask onSessionStart 登记) */
const taskRunSessions = /* @__PURE__ */ new Map();
/** 找会话 header: live 优先, 其次持久化 list(轻量元数据扫描, 不加载整日志; [r2] 兼容 0.1.5 snapshot) */
async function findSessionHeader(ctx, sessionId) {
	const live = ctx.get("sessions")?.get?.(sessionId);
	if (live !== void 0) return live.header;
	const persistence = ctx.get("sessionPersistence");
	let listed;
	try {
		listed = await persistence?.list?.();
	} catch {
		return;
	}
	for (const entry of listed ?? []) {
		const row = unwrapPersistedEntry(entry);
		if (row !== void 0 && String(row.header.id) === String(sessionId)) return row.header;
	}
}
/**
* [r2] 把持久化 list() 的元素归一成 { header, sizeBytes? }。
* 0.1.5: { header, revision, sizeBytes? }; 0.1.2: header 本身。无法识别的元素返回 undefined(调用方计入 skipped)。
*/
function unwrapPersistedEntry(entry) {
	if (!entry || typeof entry !== "object") return void 0;
	const rec = entry;
	if (rec.header && typeof rec.header === "object" && rec.header.id !== void 0) return {
		header: rec.header,
		...typeof rec.sizeBytes === "number" ? { sizeBytes: rec.sizeBytes } : {}
	};
	if (rec.id !== void 0) return { header: entry };
}
/** [r2] 事件数组安全取值: 0.1.5/0.1.2 的 inspect/read 结果里 events 缺失或非数组时返回 undefined(不抛) */
function asEvents(v) {
	if (Array.isArray(v)) return v;
	if (v && typeof v === "object" && Array.isArray(v.events)) return v.events;
}
/**
* [r2] 读一个持久化会话: 0.1.2 inspect(meta+events) → 0.1.5 open('read')+handle.read(0,∞)。
* handle 无论成败都会 close(释放读句柄)。都不可得返回 undefined。
*/
async function persistedInspect(ctx, sid) {
	const persistence = ctx.get("sessionPersistence");
	if (persistence?.inspect) try {
		const insp = await persistence.inspect(sid);
		const events = asEvents(insp?.events);
		if (insp?.meta && events) return {
			meta: insp.meta,
			events
		};
	} catch {}
	if (persistence?.open) {
		let handle;
		try {
			handle = await persistence.open(sid, "read");
			const header = handle?.header;
			if (!header?.id) return void 0;
			const events = asEvents(await handle?.read?.(0));
			if (!events) return void 0;
			return {
				meta: header,
				events
			};
		} catch (e) {
			degrade("sessionPersistence.open", "persistence.open/read 抛错, 该会话内容读不到(与「会话不存在」在调用方看来同形)", e);
			return;
		} finally {
			try {
				await handle?.close?.();
			} catch {}
		}
	}
}
/**
* [r2] live + 持久化 header 合并(live 优先), 按 id 去重(session_list / 存量捞回 / session_search 共用)。
* 逐行容错: 单个持久化条目失败只计入 skipped, 绝不让整表炸掉。
*/
async function listMergedHeaders(ctx) {
	const headers = /* @__PURE__ */ new Map();
	const store = ctx.get("sessions");
	try {
		for (const s of store?.list?.() ?? []) try {
			if (s?.header?.id !== void 0) headers.set(String(s.header.id), s.header);
		} catch {}
	} catch {}
	let skipped = 0;
	const persistence = ctx.get("sessionPersistence");
	let listed;
	try {
		listed = await persistence?.list?.();
	} catch {}
	for (const entry of listed ?? []) {
		const row = unwrapPersistedEntry(entry);
		if (row === void 0 || row.header.id === void 0) {
			skipped++;
			continue;
		}
		if (!headers.has(String(row.header.id))) headers.set(String(row.header.id), row.header);
	}
	return {
		headers,
		skipped
	};
}
/** [r1] 取 ctx.sessionQuery(探测式; 未挂载返回 undefined —— 0.1.2/0.1.5 无此服务) */
function sessionQueryOf(ctx) {
	try {
		const q = ctx.get("sessionQuery");
		return q && typeof q === "object" ? q : void 0;
	} catch (e) {
		degrade("sessionQuery", "ctx.get(sessionQuery) 抛错, 已回退 persistence 数据源", e);
		return;
	}
}
/** [r1] 项目目录名编码: header.cwd → 物理目录名。
*  实测本机布局为 `--<cwd 去前导 / 且 / → ->--`, 且 '@' 会被编码成 '~0040'
*  (例: /root/.dsh/profiles/web/node_modules/@chushixixin/dsh-harness-mcp-server
*   → --root-.dsh-profiles-web-node_modules-~0040chushixixin-dsh-harness-mcp-server--)。
*  这是宿主私有布局的 best-effort 推导: 推错只会让该行退回 createdAt, 不影响正确性。 */
function projectDirNameOf(cwd) {
	try {
		const trimmed = cwd.replace(/^\/+/, "").replace(/\/+$/, "");
		if (!trimmed) return void 0;
		return "--" + trimmed.replace(/\//g, "-").replace(/@/g, "~0040") + "--";
	} catch {
		return;
	}
}
/** [r1] 会话目录内取 `session.v*.jsonl.*` 最新 mtime(单目录一次 readdir + stat; 失败返回 undefined) */
async function newestSessionFileMtime(sessionDir) {
	let names;
	try {
		names = await readdir(sessionDir);
	} catch {
		return;
	}
	let newest;
	for (const name of names) {
		if (!/^session\.v\d+\.jsonl(\..+)?$/.test(name)) continue;
		try {
			const st = await stat(join(sessionDir, name));
			if (st.isFile() && (newest === void 0 || st.mtimeMs > newest)) newest = st.mtimeMs;
		} catch {}
	}
	return newest;
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
async function batchUpdatedAt(ctx, headers, sessionsRoot) {
	const out = /* @__PURE__ */ new Map();
	const persistence = ctx.get("sessionPersistence");
	for (const header of headers) {
		const id = String(header.id);
		if (out.has(id)) continue;
		try {
			const path = persistence?.locate?.(header)?.path;
			if (path) {
				const st = await stat(path);
				if (st.isFile()) {
					out.set(id, st.mtimeMs);
					continue;
				}
			}
		} catch {}
		if (sessionsRoot && header.cwd) try {
			const dirName = projectDirNameOf(header.cwd);
			if (dirName) {
				const m = await newestSessionFileMtime(join(sessionsRoot, dirName, id));
				if (m !== void 0) {
					out.set(id, m);
					continue;
				}
			}
		} catch {}
	}
	return out;
}
/**
* [r1] A1: 一次拿到全量会话的 header 与排序键(替代 listMergedHeaders + N×roughUpdatedAt)。
* 数据源优先级:
*   ① ctx.sessionQuery.listSessions()(0.1.7 官方, live 优先 + newest-first, 只读 header; 实测 646ms/198 会话);
*   ② 回退 persistence.list() + live store 手工合并(0.1.2/0.1.5/0.1.7 服务缺失时同样快)。
* 排序键优先级: live 末事件 time(纯内存) > 批量 mtime > header.createdAt。
* @returns rows(未排序) / skipped(畸形条目) / skippedNoCwd(cwd 缺失) / source(实际数据源)
*/
async function listCorpus(ctx) {
	const rows = [];
	const byId = /* @__PURE__ */ new Map();
	let skipped = 0;
	let skippedNoCwd = 0;
	let source = "live-only";
	const liveEndTime = /* @__PURE__ */ new Map();
	const store = ctx.get("sessions");
	try {
		for (const s of store?.list?.() ?? []) try {
			const id = s?.header?.id;
			if (id === void 0) continue;
			liveEndTime.set(String(id), 0);
		} catch {}
	} catch {}
	let usedSessionQuery = false;
	const query = sessionQueryOf(ctx);
	if (query?.listSessions) try {
		const records = await query.listSessions();
		for (const raw of records ?? []) {
			const rec = raw;
			const header = rec?.header;
			if (!header || header.id === void 0) {
				skipped++;
				continue;
			}
			const row = {
				header,
				live: rec?.live === true,
				updatedAt: header.createdAt ?? 0
			};
			byId.set(String(header.id), row);
			rows.push(row);
		}
		usedSessionQuery = true;
		source = "sessionQuery";
	} catch (e) {
		degrade("sessionQuery.listSessions", "listSessions 抛错, 已回退 sessionPersistence", e);
		rows.length = 0;
		byId.clear();
		skipped = 0;
	}
	if (!usedSessionQuery) {
		for (const id of liveEndTime.keys()) {
			const header = (store?.get?.(SessionId(id)))?.header;
			if (!header || header.id === void 0) continue;
			if (byId.has(id)) continue;
			const row = {
				header,
				live: true,
				updatedAt: header.createdAt ?? 0
			};
			byId.set(id, row);
			rows.push(row);
		}
		const persistence = ctx.get("sessionPersistence");
		let listed;
		try {
			listed = await persistence?.list?.();
		} catch (e) {
			degrade("sessionPersistence.list", "persistence.list() 抛错, 本次只返回 live 会话", e);
		}
		for (const entry of listed ?? []) {
			const row = unwrapPersistedEntry(entry);
			if (row === void 0 || row.header.id === void 0) {
				skipped++;
				continue;
			}
			const id = String(row.header.id);
			if (byId.has(id)) {
				const existing = byId.get(id);
				if (existing && existing.sizeBytes === void 0 && row.sizeBytes !== void 0) existing.sizeBytes = row.sizeBytes;
				continue;
			}
			const item = {
				header: row.header,
				live: false,
				updatedAt: row.header.createdAt ?? 0,
				...row.sizeBytes !== void 0 ? { sizeBytes: row.sizeBytes } : {}
			};
			byId.set(id, item);
			rows.push(item);
		}
		source = rows.some((r) => r.live === false) ? "persistence" : "live-only";
	}
	for (const row of rows) {
		if (!row.live) continue;
		try {
			const log = (store?.get?.(SessionId(String(row.header.id))))?.log;
			if (log && log.length > 0) {
				const t = Number(log[log.length - 1]?.time);
				if (Number.isFinite(t) && t > 0) row.updatedAt = t;
			}
		} catch (e) {
			degrade("sessionPersistence.liveLog", "live 会话 log 末事件时间读取失败, 排序键回退 createdAt(列表顺序可能不符预期)", e);
		}
	}
	const cold = rows.filter((r) => !r.live);
	if (cold.length > 0) {
		const sessionsRoot = process.env.DSH_SESSIONS_DIR || join(homedir(), ".dsh", "sessions");
		let mtimes;
		try {
			mtimes = await batchUpdatedAt(ctx, cold.map((r) => r.header), sessionsRoot);
		} catch {
			mtimes = /* @__PURE__ */ new Map();
		}
		for (const row of cold) {
			const m = mtimes.get(String(row.header.id));
			if (m !== void 0 && Number.isFinite(m) && m > 0) row.updatedAt = m;
		}
	}
	for (const row of rows) if (row.header.cwd === void 0) skippedNoCwd++;
	return {
		rows,
		skipped,
		skippedNoCwd,
		source
	};
}
/** 从事件流里取最新 session/title 事件的标题(live/persisted 通用的只读扫描) */
function titleFromEvents(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e?.type === "session/title" && typeof e.data?.title === "string" && e.data.title) return e.data.title;
	}
}
/** 从事件流解析会话实际运行的 preset: 最后一条 agent-preset/selected 优先, 其次 header.agentPreset(dsh-agent-presets 0.1.2 移除 resolveSessionPreset 后的本地实现, 语义同旧版) */
function presetFromEvents(header, events) {
	if (header === void 0) return void 0;
	try {
		for (let i = events.length - 1; i >= 0; i--) {
			const e = events[i];
			if (e?.type === "agent-preset/selected" && typeof e.data?.preset === "string" && e.data.preset) return e.data.preset;
		}
		return header.agentPreset;
	} catch {
		return header.agentPreset;
	}
}
/**
* A: 请求级 preset 覆盖预检(与 preset_set new-default 同款 resolve 校验)。
* 可用返回 undefined; 未知返回错误文案 `unknown preset <id>; available: [...]`
* (available 优先取 UnknownPresetError.available, 缺失时回退 list() 花名册)。
*/
async function presetOverrideError(ctx, presetId) {
	try {
		await ctx.agentPresets.resolve(presetId);
		return;
	} catch (e) {
		const fromErr = e?.available;
		let names = fromErr ? [...fromErr] : [];
		if (names.length === 0) try {
			names = (await ctx.agentPresets?.list?.() ?? []).map((p) => p.id);
		} catch {}
		return `unknown preset ${presetId}; available: [${names.join(", ")}]`;
	}
}
/** dsh setSandboxMode 同款写入路径: 追加一条 sandbox/mode 事件(下一次受限调用生效, 重启靠 replay 保持) */
function appendSandboxMode(session, mode) {
	session.append?.("sandbox/mode", { mode });
}
/** 折叠事件流里最后一条 sandbox/mode(dsh effectiveSandboxMode 同款); 无 override 返回 undefined */
function sandboxModeFromEvents(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e?.type === "sandbox/mode" && typeof e.data?.mode === "string") return e.data.mode;
	}
}
/** 折叠事件流里最后一条 approval/policy(dsh effectiveApprovalPolicy 同款); 无 override 返回 undefined */
function approvalPolicyFromEvents(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e?.type === "approval/policy" && typeof e.data?.policy === "string") return e.data.policy;
	}
}
/** 部署级审批策略默认(ctx.approval.config.policy ?? 'ask'; 服务缺失时按 dsh 默认 'ask') */
function deploymentApprovalPolicy(ctx) {
	try {
		const p = ctx.get("approval")?.config?.policy;
		if (p === "ask" || p === "never") return p;
	} catch {}
	return "ask";
}
/** 取 apiProxy(强转结构视图; 纯 headless 组合没有该服务时返回 undefined。dsh 0.1.2 起不 inject 的服务禁止直接读 ctx.apiProxy, 必须 ctx.get(key, false) 宽松读取) */
function apiProxyOf(ctx) {
	try {
		return ctx.get("apiProxy", false);
	} catch (e) {
		degrade("apiProxy", "ctx.get(apiProxy, false) 抛错, 审批桥将降级 builtin/file-push", e);
		return;
	}
}
/** 内存挂起审批表(approvalId 键 —— ApprovalRequestId 全局唯一) */
const pendingApprovals = /* @__PURE__ */ new Map();
/** 当前生效的审批桥形态(status_get/approval_list 上报) */
let activeBridgeKind = "off";
/**
* [R2-3] web 桥的 mux 流中断后被调用: 把桥标记为已死, 避免状态与事实不一致。
*
* 为什么必须做: `activeBridgeKind` 是 status_get/approval_list 上报「审批桥现在是什么形态」的依据。
* mux 流断了以后桥实际已不再接收任何待审帧, 但字段仍写 'web' —— 于是
* `approval_list` 恒报 0 条待审、`status_get` 显示桥健康, 与事实相反。
* 这里改成 'off'(语义见上方文档: 不做任何事, 审批回到部署默认行为), 并把原因留在 degradations 里。
*/
function markWebBridgeDead(reason) {
	if (activeBridgeKind !== "web") return;
	activeBridgeKind = "off";
	for (const entry of [...pendingApprovals.values()]) clearApprovalTimer(entry);
	pendingApprovals.clear();
	console.warn(`[harness-mcp-server] 审批桥已停止(web → off): ${reason}`);
}
/** file-push 桥活动状态({dir: 审批文件目录}); 非 file-push 形态为 null(全部文件操作 no-op) */
let approvalBridgeFiles = null;
/** file-push 响应文件轮询间隔(ms; 协议要求 ≥500) */
const APPROVAL_FILE_POLL_MS = 500;
function clearApprovalTimer(entry) {
	if (entry.timer !== void 0) {
		clearTimeout(entry.timer);
		entry.timer = void 0;
	}
}
/** 从挂起表摘除条目(清定时器; 幂等) */
function removePendingApproval(entry) {
	clearApprovalTimer(entry);
	if (pendingApprovals.get(entry.approvalId) === entry) pendingApprovals.delete(entry.approvalId);
}
/**
* 登记挂起审批并武装超时定时器。超时语义(P3 铁律 —— 绝不超时放行):
*   - builtin 桥: settle 'cancelled'(host 侧撤回, 模型在原 turn 内收到取消继续收尾);
*   - web 桥: 客户端协议没有 cancelled, 以 'rejected' 回答(fail-closed, 同样让模型原 turn 收尾)。
*/
function armPendingApproval(ctx, entry) {
	pendingApprovals.set(entry.approvalId, entry);
	const timer = setTimeout(() => {
		if (pendingApprovals.get(entry.approvalId) !== entry) return;
		removePendingApproval(entry);
		removePendingApprovalFile(entry.approvalId);
		console.warn(`[harness-mcp-server] approval ${entry.approvalId} timed out after ${runtimeConfig.approvalTimeoutMs}ms -> ${entry.settle ? "cancelled" : "rejected"} (never allow on timeout)`);
		if (entry.settle) {
			entry.settle("cancelled");
			return;
		}
		const proxy = apiProxyOf(ctx);
		if (proxy?.respond && entry.rpcId !== void 0) proxy.respond({
			type: "client-response",
			rpcId: entry.rpcId,
			result: {
				ok: true,
				value: {
					sessionId: entry.sessionId,
					approvalId: entry.approvalId,
					outcome: "rejected"
				}
			}
		}).catch((e) => {
			degrade("apiProxy.respond", "审批超时兜底回答失败, 该请求可能一直挂到下一次超时被判拒绝", e);
		});
	}, Math.max(1, runtimeConfig.approvalTimeoutMs));
	timer.unref?.();
	entry.timer = timer;
}
/**
* 审批回答主流程: web 桥走 apiProxy.respond(rpcId 路由), builtin 桥直接 settle。
* 返回 receipt 视图({accepted:true} | {accepted:false, reason:'not-pending'})——
* 双通道竞态先答者胜: 本表条目已摘除后第二路回答拿到 not-pending, 原样透传给调用方。
*/
async function respondToApproval(ctx, entry, outcome) {
	removePendingApproval(entry);
	clearApprovalTimer(entry);
	removePendingApprovalFile(entry.approvalId);
	if (entry.settle) {
		entry.settle(outcome);
		return { accepted: true };
	}
	const proxy = apiProxyOf(ctx);
	if (!proxy?.respond || entry.rpcId === void 0) return {
		accepted: false,
		reason: "not-pending"
	};
	try {
		const receipt = await proxy.respond({
			type: "client-response",
			rpcId: entry.rpcId,
			result: {
				ok: true,
				value: {
					sessionId: entry.sessionId,
					approvalId: entry.approvalId,
					outcome
				}
			}
		});
		return receipt.accepted ? { accepted: true } : {
			accepted: false,
			reason: receipt.reason ?? "not-pending"
		};
	} catch (e) {
		degrade("apiProxy.respond", "proxy.respond() 抛错, 审批回答被当作 not-pending 返回", e);
		console.warn("[harness-mcp-server] approval respond failed:", e?.message ?? e);
		return {
			accepted: false,
			reason: "not-pending"
		};
	}
}
/** 写 pending_<approvalId>.json(文件推送协议: 通知 Hermes 有审批待答)。仅 file-push 形态生效; 失败有 warn。 */
async function writePendingApprovalFile(entry) {
	const bridge = approvalBridgeFiles;
	if (bridge === null) return;
	try {
		await mkdir(bridge.dir, { recursive: true });
		await writeFile(join(bridge.dir, `pending_${entry.approvalId}.json`), `${JSON.stringify({
			approvalId: entry.approvalId,
			sessionId: entry.sessionId,
			toolName: entry.toolName,
			reason: entry.reason ?? null,
			requestedAt: entry.requestedAt,
			rpcId: entry.rpcId ?? null,
			callbackDir: bridge.dir,
			outcome: null
		}, null, 2)}\n`, "utf8");
	} catch (e) {
		console.warn(`[harness-mcp-server] pending approval file write failed (${entry.approvalId}): ${e?.message ?? e}`);
	}
}
/** 删除 pending_<approvalId>.json(已应答/超时/卸载清理)。仅 file-push 形态生效; 不存在或失败静默。 */
async function removePendingApprovalFile(approvalId) {
	const bridge = approvalBridgeFiles;
	if (bridge === null) return;
	try {
		await unlink(join(bridge.dir, `pending_${approvalId}.json`));
	} catch {}
}
/** 扫描会话事件流定位本次 ask 的 ApprovalRequestId(builtin/file-push answerer 共用; 返回 undefined 表示交给 next)。
*  照 apiproxy 先例: 倒序扫 asked/decided 配对, 跳过已挂起/已决, callId 必须与本次请求一致。 */
function findApprovalFromEvents(req, events) {
	const decided = /* @__PURE__ */ new Set();
	let approvalId;
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev?.type === "approval/decided") decided.add(String(ev.data?.id));
		else if (ev?.type === "approval/asked") {
			const id = String(ev.data?.id);
			if (decided.has(id) || pendingApprovals.has(id)) continue;
			if ((req.callId ?? null) !== (ev.data?.callId ?? null)) continue;
			approvalId = id;
			break;
		}
	}
	return approvalId;
}
/** 构造 builtin 式 'approval/request' answerer: 定位 approvalId → armPendingApproval(settle 实际应答)。
*  filePush=true(file-push 桥)时先写 pending_<approvalId>.json 通知 Hermes; 其余行为与 builtin 完全一致。 */
function makeApprovalRequestAnswerer(ctx, filePush) {
	return async (req, next) => {
		if (req.signal?.aborted === true) return "cancelled";
		const sess = req.agent?.session;
		const approvalId = findApprovalFromEvents(req, sess?.events ?? sess?.log ?? []);
		if (approvalId === void 0) return next();
		const base = {
			approvalId,
			sessionId: String(sess?.id ?? ""),
			toolName: typeof req.toolName === "string" ? req.toolName : "?",
			...req.callId !== void 0 ? { callId: String(req.callId) } : {},
			...req.reason !== void 0 ? { reason: String(req.reason) } : {},
			requestedAt: Date.now()
		};
		if (filePush) await writePendingApprovalFile(base);
		return new Promise((resolve) => {
			armPendingApproval(ctx, {
				...base,
				settle: resolve
			});
		});
	};
}
/** 处理单个 response_<approvalId>.json: 内容有效且审批仍挂起 → respondToApproval; 其余(not-pending/非法/名实不符)仅删文件。
*  无论结果如何都消费该响应文件, 防堆积; 半写文件(JSON 解析失败)留待下一轮轮询。 */
async function handleApprovalResponseFile(ctx, filePath, approvalId) {
	let payload;
	try {
		payload = JSON.parse(await readFile(filePath, "utf8"));
	} catch {
		return;
	}
	const mismatch = payload?.approvalId !== approvalId;
	const outcome = payload?.outcome;
	const entry = pendingApprovals.get(approvalId);
	if (!mismatch && (outcome === "allowed-once" || outcome === "rejected") && entry !== void 0) {
		const receipt = await respondToApproval(ctx, entry, outcome);
		if (receipt.accepted) console.log(`[harness-mcp-server] approval ${approvalId} answered via file-push: ${outcome}`);
		else console.warn(`[harness-mcp-server] approval ${approvalId} file answer not accepted (${receipt.reason ?? "?"}); response file removed`);
	} else console.warn(`[harness-mcp-server] approval response file ignored (${approvalId} -> ${String(outcome)}${mismatch ? `; payload approvalId=${String(payload?.approvalId)} mismatch` : ""}): not-pending or invalid; response file removed`);
	try {
		await unlink(filePath);
	} catch {}
}
/** file-push 轮询: 扫描 approvalFileDir 下所有 response_*.json(定期检测, 间隔 ≥500ms) */
async function scanApprovalResponseFiles(ctx) {
	const bridge = approvalBridgeFiles;
	if (bridge === null) return;
	let names;
	try {
		names = await readdir(bridge.dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith("response_") || !name.endsWith(".json")) continue;
		await handleApprovalResponseFile(ctx, join(bridge.dir, name), name.slice(9, -5));
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
function startApprovalsBridge(ctx) {
	for (const old of [...pendingApprovals.values()]) clearApprovalTimer(old);
	pendingApprovals.clear();
	activeBridgeKind = "off";
	const bridge = runtimeConfig.approvalsBridge;
	if (bridge === "off") return () => {};
	const proxy = apiProxyOf(ctx);
	if (bridge === "web" && proxy?.events?.mux && proxy.respond) {
		activeBridgeKind = "web";
		const controller = new AbortController();
		(async () => {
			try {
				const stream = proxy.events.mux({
					rpcId: `harness-mcp-${randomUUID()}`,
					payload: {}
				}, controller.signal);
				for await (const msg of stream) {
					const f = msg.payload;
					if (f.type === "approval/requested" && typeof f.approvalId === "string" && typeof f.sessionId === "string") {
						if (pendingApprovals.has(f.approvalId)) continue;
						armPendingApproval(ctx, {
							approvalId: f.approvalId,
							sessionId: f.sessionId,
							toolName: typeof f.toolName === "string" ? f.toolName : "?",
							...typeof f.callId === "string" ? { callId: f.callId } : {},
							...typeof f.reason === "string" ? { reason: f.reason } : {},
							requestedAt: Date.now(),
							rpcId: String(msg.rpcId)
						});
					} else if (f.type === "approval/resolved" && typeof f.approvalId === "string") {
						const entry = pendingApprovals.get(f.approvalId);
						if (entry) removePendingApproval(entry);
					}
				}
			} catch (e) {
				if (!controller.signal.aborted) {
					degrade("apiProxy.mux", "mux 事件流中断, 审批桥不再收到待审帧(approval_list 可能恒为 0)", e);
					console.warn("[harness-mcp-server] approvals mux stream ended:", e?.message ?? e);
					markWebBridgeDead(String(e?.message ?? e));
				}
			}
		})();
		return () => {
			controller.abort();
			for (const entry of [...pendingApprovals.values()]) clearApprovalTimer(entry);
			pendingApprovals.clear();
			approvalBridgeFiles = null;
			activeBridgeKind = "off";
		};
	}
	if (typeof ctx.on !== "function") {
		activeBridgeKind = "off";
		approvalBridgeFiles = null;
		console.warn("[approvals] host 无 ctx.on 事件能力, builtin/file-push 桥关闭(approvalsBridge=off)");
		return () => {};
	}
	const filePush = bridge === "file-push";
	activeBridgeKind = filePush ? "file-push" : "builtin";
	if (filePush) {
		approvalBridgeFiles = { dir: runtimeConfig.approvalFileDir };
		try {
			mkdir(runtimeConfig.approvalFileDir, { recursive: true }).catch(() => {});
		} catch {}
	}
	ctx.on("approval/request", makeApprovalRequestAnswerer(ctx, filePush));
	if (runtimeConfig.questionCallback !== void 0 && typeof ctx.on === "function") {
		ctx.on("user-questions/request", makeUserQuestionAnswerer(ctx), {
			global: true,
			prepend: true
		});
		console.log("[harness-mcp-server] user-questions answerer registered (ask_user_question 挂起将回调通知)");
	}
	/** 启动响应文件轮询(仅 file-push; 兜底即使没有 fs.watch 也能工作, 间隔 ≥500ms) */
	let pollTimer;
	let questionPollTimer;
	if (filePush) {
		const tick = () => {
			if (approvalBridgeFiles === null) return;
			scanApprovalResponseFiles(ctx).catch((e) => {
				console.warn("[harness-mcp-server] approval response scan failed:", e?.message ?? e);
			}).finally(() => {
				if (approvalBridgeFiles !== null) pollTimer = setTimeout(tick, APPROVAL_FILE_POLL_MS);
			});
		};
		pollTimer = setTimeout(tick, APPROVAL_FILE_POLL_MS);
		const qTick = () => {
			if (approvalBridgeFiles === null) return;
			scanQuestionAnswerFiles().catch((e) => {
				console.warn("[harness-mcp-server] question answer scan failed:", e?.message ?? e);
			}).finally(() => {
				if (approvalBridgeFiles !== null) questionPollTimer = setTimeout(qTick, APPROVAL_FILE_POLL_MS);
			});
		};
		questionPollTimer = setTimeout(qTick, APPROVAL_FILE_POLL_MS);
	}
	return () => {
		if (pollTimer !== void 0) clearTimeout(pollTimer);
		if (questionPollTimer !== void 0) clearTimeout(questionPollTimer);
		for (const entry of [...pendingApprovals.values()]) {
			clearApprovalTimer(entry);
			removePendingApprovalFile(entry.approvalId);
		}
		pendingApprovals.clear();
		for (const entry of [...pendingQuestions.values()]) {
			clearQuestionTimer(entry);
			entry.fail(/* @__PURE__ */ new Error("bridge disposed"));
		}
		pendingQuestions.clear();
		approvalBridgeFiles = null;
		activeBridgeKind = "off";
	};
}
/**
* [r1] B2: 批量检视会话行, 并发 4 + 单会话超时。
* 旧实现串行 inspectSessionRow: 单会话读数约 655ms, 50 行串行 ≈ 33s。
* 并发度取 4 与官方 SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY 对齐(最稳)。
* 单会话超时(默认 3000ms)超时即放弃该行(调用方计入 skipped), 不让一行拖垮整表。
* @returns id(str) → 检视结果; 读不到/超时的会话不在 map 里
*/
async function inspectRowsConcurrent(ctx, rows, onSkipped) {
	const out = /* @__PURE__ */ new Map();
	const queue = [...rows];
	const worker = async () => {
		for (;;) {
			const item = queue.shift();
			if (!item) return;
			const id = String(item.header.id);
			try {
				const r = await withTimeout(inspectSessionRow(ctx, item.header), SESSION_LIST_INSPECT_TIMEOUT_MS);
				if (r === void 0) {
					onSkipped();
					continue;
				}
				out.set(id, r);
			} catch {
				onSkipped();
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(SESSION_LIST_INSPECT_CONCURRENCY, queue.length) }, worker));
	return out;
}
/**
* 单个会话的轻量检视: 消息条数 + 标题 + 统计摘要 + 权限档。
* [r2] persistedInspect 兼容 0.1.2 inspect 与 0.1.5 open/read; 失败回退 live log。
* 返回 undefined = 两路都读不到(调用方应计入 skipped, 而不是伪造一行 messageCount:0 的假数据)。
*/
async function inspectSessionRow(ctx, header) {
	if (header.id === void 0) return void 0;
	try {
		const insp = await persistedInspect(ctx, SessionId(String(header.id)));
		if (insp) {
			const events = insp.events;
			return summarizeRow(events.length, titleFromEvents(events), events);
		}
	} catch (e) {
		degrade("sessionPersistence.inspect", "persistedInspect 抛错, session_list 该行回退 live(冷会话可能被计为 skipped)", e);
	}
	const live = ctx.get("sessions")?.get?.(SessionId(String(header.id)));
	if (live?.log) return summarizeRow(live.log.length, titleFromEvents(live.log), live.log);
}
/** 从事件流汇总行级统计摘要(messageCount/title + token/llm 摘要字段 + P3 sandboxMode 折叠) */
function summarizeRow(count, title, events) {
	try {
		const f = foldSessionStats(events);
		const mode = sandboxModeFromEvents(events);
		return {
			messageCount: count,
			...title !== void 0 ? { title } : {},
			inputTokens: f.inputTokens,
			outputTokens: f.outputTokens,
			llmTimeSec: Math.round(f.llmMs / 100) / 10,
			...mode !== void 0 ? { sandboxMode: mode } : {}
		};
	} catch {
		return {
			messageCount: count,
			...title !== void 0 ? { title } : {}
		};
	}
}
function emptyStatsFold() {
	return {
		rounds: 0,
		steps: 0,
		llmMs: 0,
		toolMs: 0,
		ttftMs: 0,
		ttftSteps: 0,
		decodeMs: 0,
		decodeTokens: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0
	};
}
/** usage 字段的安全数值读取 */
function usageNum(v) {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
/** 把一段会话事件流折叠成统计(纯函数, 不修改输入)。 */
function foldSessionStats(events) {
	const s = emptyStatsFold();
	let openStep = null;
	const pendingCalls = /* @__PURE__ */ new Map();
	for (const raw of events) {
		const e = raw;
		if (typeof e?.type !== "string") continue;
		const t = typeof e.time === "number" && Number.isFinite(e.time) ? e.time : 0;
		const d = e.data ?? {};
		switch (e.type) {
			case "step/start":
				openStep = {
					turn: Number(d.turn),
					step: Number(d.step),
					startTime: t,
					firstTokenTime: null
				};
				break;
			case "assistant/chunk": {
				const cd = d.chunk;
				if (openStep === null || openStep.turn !== Number(d.turn) || openStep.step !== Number(d.step)) break;
				if (openStep.firstTokenTime === null && cd !== void 0) {
					if (cd.type === "text-delta" ? (cd.text ?? "") !== "" : cd.type === "reasoning-delta" ? (cd.text ?? "") !== "" : cd.type === "tool-call-delta" ? (cd.argumentsDelta ?? "") !== "" || cd.name !== void 0 : false) openStep.firstTokenTime = t;
				}
				break;
			}
			case "assistant/message": {
				if (openStep !== null && openStep.turn === Number(d.turn) && openStep.step === Number(d.step)) {
					const open = openStep;
					s.llmMs += Math.max(0, t - open.startTime);
					if (open.firstTokenTime !== null) {
						s.ttftMs += Math.max(0, open.firstTokenTime - open.startTime);
						s.ttftSteps += 1;
						const out1 = usageNum(d.usage?.outputTokens);
						if (out1 > 0) {
							s.decodeMs += Math.max(0, t - open.firstTokenTime);
							s.decodeTokens += out1;
						}
					}
					openStep = null;
				}
				const u = d.usage;
				if (u && typeof u === "object") {
					s.inputTokens += usageNum(u.inputTokens);
					s.outputTokens += usageNum(u.outputTokens);
					s.cacheReadTokens += usageNum(u.cacheReadTokens);
					s.cacheWriteTokens += usageNum(u.cacheWriteTokens);
					s.reasoningTokens += usageNum(u.reasoningTokens);
				}
				break;
			}
			case "tool/call":
				if (d.callId !== void 0) pendingCalls.set(String(d.callId), t);
				break;
			case "tool/result": {
				const msg = d.message;
				const cid = String(msg?.source?.callId ?? "");
				const dispatched = Object.hasOwn(Object.fromEntries(pendingCalls), cid) ? pendingCalls.get(cid) : void 0;
				if (dispatched !== void 0) {
					pendingCalls.delete(cid);
					s.toolMs += Math.max(0, t - dispatched);
				}
				break;
			}
			case "step/end":
				s.steps += 1;
				openStep = null;
				break;
			case "turn/end":
				s.rounds += 1;
				if (pendingCalls.size > 0) pendingCalls.clear();
		}
	}
	return s;
}
/**
* 缓存命中率: 有 cacheRead 上报才计算。
* 分母自适应两种 token 口径:
*   - DeepSeek 式(inputTokens 已含缓存命中): cacheRead ≤ input → 分母 = inputTokens;
*   - Anthropic 式(inputTokens 不含缓存): cacheRead ≫ input → 分母 = input+read+write(总提示 token)。
* 结果 clamp 到 [0,1]。
*/
function cacheHitRateOf(s) {
	if (s.cacheReadTokens <= 0) return null;
	let denom;
	if (s.inputTokens > 0 && s.cacheReadTokens <= s.inputTokens) denom = s.inputTokens;
	else denom = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
	if (denom <= 0) return null;
	return Math.min(1, Math.round(s.cacheReadTokens / denom * 1e4) / 1e4);
}
/** 统计对外呈现: 秒 + 毫秒双口径, 均值类字段无样本时为 null */
function presentSessionStats(s, opts) {
	const r3 = (n) => Math.round(n * 1e3) / 1e3;
	return {
		...opts.sessionId !== void 0 ? { sessionId: opts.sessionId } : {},
		scope: opts.scope,
		rounds: s.rounds,
		steps: s.steps,
		llmTime: r3(s.llmMs / 1e3),
		llmTimeMs: Math.round(s.llmMs),
		toolTime: r3(s.toolMs / 1e3),
		toolTimeMs: Math.round(s.toolMs),
		llmTimeHuman: formatDuration(s.llmMs),
		toolTimeHuman: formatDuration(s.toolMs),
		ttft: s.ttftSteps > 0 ? Math.round(s.ttftMs / s.ttftSteps) : null,
		ttftHuman: s.ttftSteps > 0 ? formatDuration(s.ttftMs / s.ttftSteps) : null,
		ttftSteps: s.ttftSteps,
		tokensPerSec: s.decodeMs > 0 ? Math.round(s.decodeTokens / (s.decodeMs / 1e3) * 10) / 10 : null,
		cacheHitRate: cacheHitRateOf(s),
		inputTokens: s.inputTokens,
		outputTokens: s.outputTokens,
		cacheReadTokens: s.cacheReadTokens,
		cacheWriteTokens: s.cacheWriteTokens,
		reasoningTokens: s.reasoningTokens
	};
}
/** 单会话参与内容匹配的文本上限(chars), 防超大日志拖垮整体扫描 */
const SESSION_SEARCH_MAX_TEXT_CHARS = 2097152;
/** zstd 帧魔数(小端 0xFD2FB528) */
const ZSTD_MAGIC = Buffer.from([
	40,
	181,
	47,
	253
]);
/**
* 解压 dsh 落盘的 session.jsonl.zstd: 多个 zstd 帧顺序拼接(每次 flush 追加一帧),
* 整文件单次 sync 解压只能拿到首帧。按魔数切分逐帧解压; 魔数若误现于帧载荷内,
* 向后合并相邻分段直到解压成功(合并到文件尾仍失败则该帧损坏, 跳过)。
*/
function decompressZstdFile(buf) {
	const offs = [];
	for (let p = buf.indexOf(ZSTD_MAGIC); p !== -1; p = buf.indexOf(ZSTD_MAGIC, p + 4)) offs.push(p);
	if (offs.length === 0) return "";
	let text = "";
	let k = 0;
	while (k < offs.length) {
		const start = offs[k];
		let end = k + 1;
		let decoded = null;
		for (;;) {
			const seg = end < offs.length ? buf.subarray(start, offs[end]) : buf.subarray(start);
			try {
				decoded = zstdDecompressSync(seg).toString("utf8");
				break;
			} catch {
				if (end < offs.length) end += 1;
				else break;
			}
		}
		if (decoded !== null) text += decoded;
		k = decoded !== null ? end : k + 1;
	}
	return text;
}
/** Promise 限时: 超时返回 undefined(不中断原 promise, 只是不再等它) */
async function withTimeout(p, ms) {
	let timer;
	const timeout = new Promise((res) => {
		timer = setTimeout(() => res(void 0), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
/**
* 读单会话事件流(session_search 用): [r2] persistedInspect(0.1.2 inspect / 0.1.5 open+read, 带限时)
* → live log → locate(path) 落盘文件多帧 zstd 兜底。都不可得返回 undefined。
*/
async function readSessionEventsSearch(ctx, header) {
	const sid = SessionId(String(header.id));
	const persistence = ctx.get("sessionPersistence");
	try {
		const insp = await withTimeout(persistedInspect(ctx, sid), 2500);
		if (insp) return {
			events: insp.events,
			source: "persisted"
		};
	} catch {}
	const live = ctx.get("sessions")?.get?.(sid);
	if (live?.log && live.log.length > 0) return {
		events: [...live.log],
		source: "live"
	};
	if (persistence?.locate) try {
		const loc = persistence.locate(header);
		if (loc?.path) {
			const text = decompressZstdFile(await readFile(loc.path));
			if (text) {
				const events = [];
				for (const line of text.split("\n")) {
					if (!line.trim()) continue;
					try {
						events.push(JSON.parse(line));
					} catch {}
				}
				return {
					events,
					source: "file"
				};
			}
		}
	} catch {}
}
/** [r1] 最近一次 session_search 实际生效的后端(供 status_get/config_get 上报) */
let sessionSearchBackend = "scan";
/** [r1] 最近一次回退原因(仅诊断用, 不含敏感信息) */
let sessionSearchFallbackReason = "尚未调用过 session_search";
/**
* [r1] C1: 尝试走官方索引搜索。
* 只有**完整成功**才返回 hits; 任何异常(SESSION_QUERY_SEARCH_DISABLED /
* SESSION_QUERY_PERSISTENCE_FAILED / 未挂载 / 结构不符)都返回 {hits: undefined, reason} 让调用方回退。
* @returns hits=undefined 表示"索引不可用, 请回退"; reason 为可上报的简短原因
*/
async function tryIndexSearch(ctx, req) {
	const query = sessionQueryOf(ctx);
	if (typeof query?.searchSessions !== "function") return { reason: "ctx.sessionQuery.searchSessions 未挂载(非 0.1.7 或服务未激活)" };
	const sessionFilters = req.cwd ? [{
		kind: "cwd",
		values: [req.cwd]
	}] : void 0;
	let page;
	try {
		page = await query.searchSessions({
			query: req.query,
			limit: Math.min(Math.max(1, req.limit), 100),
			...sessionFilters ? { sessionFilters } : {}
		});
	} catch (e) {
		const code = e?.code;
		const reason = typeof code === "string" ? `官方索引不可用: ${code}` : `官方索引不可用: ${e?.message ?? String(e)}`;
		degrade("sessionQuery.searchSessions", reason, e);
		return { reason };
	}
	const items = page?.items;
	if (!Array.isArray(items)) {
		degrade("sessionQuery.searchSessions", "官方索引返回结构不符(缺 items 数组)", page);
		return { reason: "官方索引返回结构不符(缺 items 数组)" };
	}
	const hits = [];
	for (const raw of items) {
		const hit = raw;
		const header = hit?.header;
		if (!header || header.id === void 0) continue;
		const snippet = typeof hit?.bestMatch?.snippet === "string" ? hit.bestMatch.snippet : void 0;
		const t = Number(hit?.bestMatch?.time);
		hits.push({
			sessionId: String(header.id),
			title: `(untitled ${String(header.id).slice(0, 8)})`,
			...header.cwd !== void 0 ? { cwd: header.cwd } : {},
			updatedAt: Number.isFinite(t) && t > 0 ? t : header.createdAt ?? 0,
			matched: "content",
			...snippet !== void 0 ? { snippet } : {}
		});
	}
	return { hits };
}
/** 命中判定: 正则模式 re.test, 否则大小写不敏感子串 */
function searchHit(text, re, needle) {
	if (re) return re.test(text);
	return text.toLowerCase().includes(needle);
}
/** 首个命中位置(正则 exec / 小写子串 indexOf; lowerText 为 text 的小写形式, 非 正则时必传) */
function searchIndexOf(text, re, lowerText, needle) {
	if (re) {
		const m = re.exec(text);
		return m ? m.index : -1;
	}
	return lowerText.indexOf(needle);
}
/** 取命中 ±60 字符的 snippet(空白压缩成单空格) */
function snippetAround(text, index, matchLen) {
	const start = Math.max(0, index - 60);
	const end = Math.min(text.length, index + matchLen + 60);
	return text.slice(start, end).replace(/\s+/g, " ").trim();
}
/**
* [R9 P3] 样板文本统计过滤 —— 判断某个 snippet 是否"几乎每个会话都命中"的噪音。
*
* 缺陷(REQ_r9 §2 P3): 搜 "dsh" 时每个会话都命中 Hermes 系统提示词里的同一段样板
* (`plete deliverable, including images, Office documents, spreadsheets, a...`),
* 导致这批"零信息量"命中占据前排, 把真正的命中挤到后面。
*
* 方案选择(为什么不做黑名单): 硬编码某段 Hermes 提示词换个客户端就失效, 脆弱。
* 这里用**统计特征** —— 在本次扫描的样本里, 若某个 snippet 簇占到
* ≥ NOISE_MIN_RATIO 比例的**命中**中(且样本量 ≥ NOISE_MIN_SAMPLE),
* 就认为它是"模板文字"而非区分性证据:
*   - 真命中因会话内容而异, 不会跨会话逐字相同;
*   - 系统提示词样板每个会话都逐字相同, 命中率趋近 100%。
*
* ⚠️ 阈值为什么是 0.6 而不是 0.8(实测校准, 见 REPORT_r9 真链路证据):
* 同一段系统提示词里的**不同片段**会各自聚成簇。本机 184 个会话搜 "policy" 时,
* 174 个命中分成两簇: 76.4%(`so read an existing file first (the defa`)与
* 22.4%(`efore overwriting it with write (the def`) —— 它们是同一段的相邻片段。
* 0.8 会**两簇都不判**(各自都不到 80%)→ P3 等于没修。0.6 能判中占主导的那簇。
* 同时保留"簇必须显著大于零散真命中"的语义: 占比 ≥0.6 意味着一半以上的命中
* 共享同一片段, 真实检索里几乎不可能是巧合。
*
* 只降权/标记, **不删除**(调用方仍能看到), 并且默认开启、可用 `filter_noise=false` 关闭。
*/
const NOISE_MIN_SAMPLE = 5;
const NOISE_MIN_RATIO = .6;
/** 同簇判定: 共同前缀至少这么长(字符), 且占较短 key 的比例不低于 NOISE_MIN_SHARED_RATIO */
const NOISE_MIN_SHARED_PREFIX = 16;
const NOISE_MIN_SHARED_RATIO = .6;
/**
* 规范化 snippet 作为"同一段文字"的比较键(压空白 + 小写 + 截断)。
*
* ⚠️ 为什么不能只取整条 snippet 做全等比较(实测踩坑):
* `snippetAround` 取的是命中位置 **±60 字符**的窗口, 同一个模板片段在不同会话里
* 两侧上下文长度不同(例如文件沙箱策略里的 workspace 路径 `/tmp` vs `/root/.dsh/...`)，
* 逐字比较会把**同一段样板**算成不同 key → 判定失效。
* 实测本机 184 个会话里搜 "policy", 174 个都命中 `fs-observation-policy requires it`
* 这段系统提示词, 但 snippet 因路径差异各不相同。
*
* 因此: 取规范化后的**前 NOISE_KEY_LEN 字符**作为主键(命中点两侧的差异通常出现在窗口后段),
* 并把"一个 key 是另一个 key 的前缀"也视作同簇(见 detectBoilerplateKeys 的簇合并)。
*/
const NOISE_KEY_LEN = 40;
function noiseKey(snippet) {
	return snippet.replace(/\s+/g, " ").trim().toLowerCase().slice(0, NOISE_KEY_LEN);
}
/**
* 统计本次命中的 snippet 频次, 返回"疑似模板"的 key 集合。
*
* 判定分两步:
*   1. **前缀同簇**: 若一个 key 是另一个 key 的前缀(短的那个更短), 归入同一簇
*      —— 处理"窗口起点相同、后段因上下文不同而分叉"的样板;
*   2. **簇占比 ≥ 阈值**(且样本 ≥ 门槛)→ 簇内全部 key 标记为噪音。
*
* 只在样本足够(≥ NOISE_MIN_SAMPLE)时才判定, 避免小样本误杀。
*/
function detectBoilerplateKeys(rows) {
	const counts = /* @__PURE__ */ new Map();
	let withSnippet = 0;
	for (const r of rows) {
		if (typeof r.snippet !== "string" || r.snippet === "") continue;
		withSnippet++;
		const k = noiseKey(r.snippet);
		if (k === "") continue;
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	const noise = /* @__PURE__ */ new Set();
	if (withSnippet < NOISE_MIN_SAMPLE) return noise;
	const keys = [...counts.keys()];
	const parent = new Map(keys.map((k) => [k, k]));
	const find = (x) => {
		let r = x;
		while (parent.get(r) !== r) r = parent.get(r);
		let c = x;
		while (parent.get(c) !== r) {
			const n = parent.get(c);
			parent.set(c, r);
			c = n;
		}
		return r;
	};
	const union = (a, b) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};
	/** 两个 key 的共同前缀长度 */
	const commonPrefixLen = (a, b) => {
		const n = Math.min(a.length, b.length);
		let i = 0;
		while (i < n && a[i] === b[i]) i++;
		return i;
	};
	for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
		const a = keys[i];
		const b = keys[j];
		const shorter = a.length <= b.length ? a : b;
		const longer = a.length <= b.length ? b : a;
		const shared = commonPrefixLen(a, b);
		const minLen = Math.min(a.length, b.length);
		if (shorter.length >= 8 && longer.startsWith(shorter) || shared >= NOISE_MIN_SHARED_PREFIX && shared >= minLen * NOISE_MIN_SHARED_RATIO) union(a, b);
	}
	const clusterCount = /* @__PURE__ */ new Map();
	for (const [k, n] of counts) {
		const root = find(k);
		clusterCount.set(root, (clusterCount.get(root) ?? 0) + n);
	}
	for (const k of keys) if ((clusterCount.get(find(k)) ?? 0) / withSnippet >= NOISE_MIN_RATIO) noise.add(k);
	return noise;
}
/** 搜索单会话: 标题优先, 未命中再尽力扫内容(collectText 已跳过 reasoning 块)。 */
async function searchOneSession(ctx, header, updatedAt, m) {
	let title = `(untitled ${String(header.id).slice(0, 8)})`;
	let found;
	try {
		found = await readSessionEventsSearch(ctx, header);
	} catch {}
	if (found) {
		const t = titleFromEvents(found.events);
		if (t !== void 0) title = t;
	}
	if (searchHit(title, m.re, m.needle)) return {
		row: {
			sessionId: String(header.id),
			title,
			...header.cwd !== void 0 ? { cwd: header.cwd } : {},
			updatedAt,
			matched: "title"
		},
		contentSearched: found !== void 0
	};
	if (!found) return { contentSearched: false };
	const texts = [];
	try {
		collectText(found.events, texts);
	} catch {}
	let budget = SESSION_SEARCH_MAX_TEXT_CHARS;
	for (const raw of texts) {
		if (budget <= 0) break;
		const chunk = raw.length > 2e4 ? raw.slice(0, 2e4) : raw;
		budget -= chunk.length;
		const cleaned = stripReasoning(chunk);
		if (!cleaned) continue;
		const idx = searchIndexOf(cleaned, m.re, cleaned.toLowerCase(), m.needle);
		if (idx >= 0) return {
			row: {
				sessionId: String(header.id),
				title,
				...header.cwd !== void 0 ? { cwd: header.cwd } : {},
				updatedAt,
				matched: "content",
				snippet: snippetAround(cleaned, idx, Math.max(1, m.rawLen))
			},
			contentSearched: true
		};
	}
	return { contentSearched: true };
}
/** 当前 Agent 会话(最近一次 agent_run/task 执行的会话), 供 session_stats 无参调用 */
let lastAgentSessionId;
/**
* 收集一个会话的完整事件流([r2] persistedInspect 优先: 0.1.2 inspect / 0.1.5 open+read, 回退 live store 日志)。
* 返回 undefined 表示 live 与持久化里都没有该会话。
*/
async function collectSessionEvents(ctx, sid) {
	try {
		const insp = await persistedInspect(ctx, sid);
		if (insp && insp.events.length > 0) return {
			events: insp.events,
			source: "persisted"
		};
	} catch {}
	const live = ctx.get("sessions")?.get?.(sid);
	if (live?.log && live.log.length > 0) return {
		events: [...live.log],
		source: "live"
	};
	try {
		if (await persistedInspect(ctx, sid)) return {
			events: [],
			source: "persisted"
		};
	} catch {}
}
/** 单条日志事件 → 紧凑记录(stripReasoning 过滤 + 分字段限长); unknown 类型退化为 data JSON 摘录 */
function compactLogEvent(e) {
	const ev = e;
	const base = {
		seq: ev.seq,
		type: ev.type,
		...timeFields("time", ev.time)
	};
	const d = ev.data;
	switch (ev.type) {
		case "user/message": {
			const texts = [];
			collectText(d, texts);
			base.text = stripReasoning(texts.join("\n")).slice(0, 3e3);
			break;
		}
		case "assistant/message": {
			const msg = d;
			const texts = [];
			collectText(msg?.message ?? d, texts);
			base.text = stripReasoning(texts.join("\n")).slice(0, 4e3);
			break;
		}
		case "tool/call": {
			const call = d;
			base.name = call?.name ?? "?";
			base.arguments = String(call?.arguments ?? JSON.stringify(call?.input ?? null) ?? "").slice(0, 800);
			break;
		}
		case "tool/result": {
			const texts = [];
			collectText(d, texts);
			base.text = stripReasoning(texts.join("\n")).slice(0, 1500);
			break;
		}
		default: try {
			base.data = JSON.stringify(d)?.slice(0, 300);
		} catch {
			base.data = "[unserializable]";
		}
	}
	return base;
}
/**
* 存量捞回: 启动时把现存未分组的会话补挂到已注册工作区。
* 条件: header.cwd 的 realpath 等于某已注册 workspace.path, 且该 sessionId 不在其花名册里。
* 只补挂到"已注册"工作区, 不新建(避免把无关目录刷成新工作区); 单会话失败不影响其余。
*/
async function reattachOrphanSessions(ctx) {
	const registry = ctx.get("workspaceRegistry");
	const byPath = /* @__PURE__ */ new Map();
	for (const ws of registry?.list?.() ?? []) byPath.set(ws.path, ws);
	if (byPath.size === 0) return {
		attached: 0,
		failed: 0
	};
	const { headers } = await listMergedHeaders(ctx);
	let attached = 0;
	let failed = 0;
	for (const header of headers.values()) {
		if (header.cwd === void 0) continue;
		const canonical = await canonicalCwd(header.cwd);
		const ws = byPath.get(canonical);
		if (ws === void 0 || !ws.attachSession) continue;
		if (ws.sessionIds.includes(header.id)) continue;
		try {
			await ws.attachSession(header.id);
			attached++;
			console.log(`[harness-mcp-server] 存量捞回: session ${header.id} -> workspace ${ws.path}`);
		} catch (e) {
			failed++;
			console.warn(`[harness-mcp-server] 存量捞回失败 session ${header.id}:`, e?.message ?? e);
		}
	}
	return {
		attached,
		failed
	};
}
/** 在给定 McpServer 上注册工具 */
function registerTools(mcp, ctx) {
	mcp.tool("echo", "连通性自检: 原样回显 text 并附服务器时间戳。什么时候用: 第一次接上本 server、或怀疑网络/认证断了的时候, 先 ping 一下确认通道活着(比直接调 agent_run 便宜得多)。返回 {收到: \"<text>\", at: <ISO8601 本地时区>, at_epoch: <毫秒 epoch>}。", { text: z.string().describe("要回显的文本(原样返回)") }, async ({ text }) => {
		const bad = validateArgs("echo", { text }, [{
			name: "text",
			type: "string",
			required: true
		}]);
		if (bad) return out(JSON.stringify({ error: bad }));
		return out(JSON.stringify({
			收到: text,
			...timeFields("at", Date.now())
		}));
	});
	mcp.tool("harness_list_tools", "列出 Harness(宿主)自己注册的工具名清单。什么时候用: 想确认某个能力(如 bash/fs/web)在当前部署里是否可用, 或 agent_run 跑的 agent 抱怨没有某个工具时排查用的。返回一个字符串数组(纯名字, 无描述)。注意这是 Harness 内部工具, 与本插件的 26 个 MCP 工具是两回事。", {}, async () => {
		let names = [];
		let usedScope = false;
		try {
			const tools = ctx.tools;
			const schemasFn = tools?.schemas;
			if (tools && typeof schemasFn === "function") {
				const pick = (scope) => schemasFn.call(tools, scope).map((s) => s?.name).filter((n) => typeof n === "string");
				for (const rec of liveAgents.values()) if (rec.scope !== void 0) {
					const scoped = pick(rec.scope);
					if (scoped.length > 0) {
						names = scoped;
						usedScope = true;
						break;
					}
				}
				if (!usedScope) names = pick();
				if (names.length === 0) degrade("tools.schemas", `ctx.tools.schemas() 返回空(无 live agent scope 且全局层为空); liveAgents=${liveAgents.size}`, void 0);
			} else degrade("tools.schemas", "ctx.tools.schemas() 不可用, harness_list_tools 回退空列表", void 0);
		} catch (e) {
			degrade("tools.schemas", "ctx.tools.schemas() 抛错, harness_list_tools 回退空列表", e);
		}
		return out(JSON.stringify(names));
	});
	mcp.tool("status_get", "看服务器现在活着吗、在用什么模型、有没有卡住的活。什么时候用: ① 调工具前先确认 server 健康 ② agent_run 长时间没返回时查 queueActive/activeSessionsCount 看是不是真在忙 ③ 想知道有没有待审的权限申请(pendingApprovals>0 就去 approval_list)。返回 {version,uptimeSec,uptime,startedAt(ISO8601),startedAt_epoch,provider,model,preset,activeSessionsCount,agentsLive,queueActive,sandboxPolicy:{defaultMode,bridge,pendingApprovals},notify:{enabled,deliveredTotal,failedTotal},sessionSearch:{backend,fallbackReason?},contract:{ok,missingRequired,missingOptional,incompleteMethods,checkedAt,checkedCount},providerCheck:{probed,provider,registered,explicit,available},degradationCount,degradations:[{scope,reason,at,count,error?}],node,pid}。契约自检(contract)在启动时探测一次: ok=false 或 missingRequired 非空 = 宿主升级引入了破坏性变更, 功能可能不完整(启动日志同款 ⛔ 告警); providerCheck 看「你用的 provider 宿主到底认不认」—— registered=false 且 explicit=false 表示你吃的是默认 provider 而宿主没注册它(启动日志同款 ⚠️ 告警), 请显式配置 provider; degradations 是契约/服务相关路径的降级留痕(repair 排查\"功能不工作但没报错\"时先看这里)。", {}, async () => {
		let queueActive = 0;
		for (const t of taskQueue.values()) if (t.status === "queued" || t.status === "running") queueActive++;
		let agentsLive = 0;
		try {
			agentsLive = ctx.agents.list().length;
		} catch (e) {
			degrade("agents", "ctx.agents.list() 抛错, status_get.agentsLive 回退 0(不代表真的没有存活 agent)", e);
			agentsLive = 0;
		}
		let deliveredTotal = 0;
		let failedTotal = 0;
		for (const t of taskQueue.values()) if (t.notify?.state === "delivered") deliveredTotal++;
		else if (t.notify?.state === "failed") failedTotal++;
		const uptimeMs = Math.round(process.uptime() * 1e3);
		return out(JSON.stringify({
			version: PLUGIN_VERSION,
			uptimeSec: Math.round(process.uptime()),
			uptime: formatDuration(uptimeMs),
			...timeFields("startedAt", serverRuntime.startedAt),
			provider: runtimeConfig.provider,
			model: runtimeConfig.model || "(follow dsh default)",
			preset: runtimeConfig.preset,
			activeSessionsCount: liveAgents.size,
			agentsLive,
			queueActive,
			sandboxPolicy: {
				defaultMode: runtimeConfig.defaultSandbox,
				bridge: activeBridgeKind,
				pendingApprovals: pendingApprovals.size
			},
			notify: {
				enabled: runtimeConfig.notifyEnabled !== false,
				deliveredTotal,
				failedTotal,
				callbackPresetConfigured: runtimeConfig.callbackPreset?.url !== void 0
			},
			sessionSearch: {
				backend: sessionSearchBackend,
				...sessionSearchFallbackReason !== void 0 ? { fallbackReason: sessionSearchFallbackReason } : {}
			},
			contract: runtimeConfig.contract ?? null,
			providerCheck: providerCheck ?? null,
			degradationCount: degradations.size,
			degradations: degradationsSnapshot(),
			node: process.version,
			pid: process.pid
		}, null, 2));
	});
	mcp.tool("config_get", "看这个插件是怎么被配置的(排查\"为什么默认落到某个目录/为什么没权限\"用)。什么时候用: ① agent_run 不传 cwd 时想知道默认工作目录是什么(看 workspaceRoots) ② 想知道默认权限档(defaultSandbox)或审批桥形态(approvalsBridge) ③ 确认 authToken 是否已开启(只回显是否设置, 不泄露值)。返回 {version,http,server:{port,host},provider,model,preset,maxQueue,taskTtlMs,taskTtl,timeouts:{...人类可读},authTokenSet,workspaceRoots,enableFsWrite,defaultSandbox,approvalsBridge,approvalTimeoutMs,approvalFileDir}。与 status_get 的区别: 这里看\"配置\", status_get 看\"运行态\"。", {}, async () => {
		return out(JSON.stringify({
			version: PLUGIN_VERSION,
			http: true,
			server: {
				port: serverRuntime.port,
				host: serverRuntime.host
			},
			provider: runtimeConfig.provider,
			model: runtimeConfig.model || "(follow dsh default)",
			preset: runtimeConfig.preset,
			maxQueue: runtimeConfig.maxQueue,
			taskTtlMs: runtimeConfig.taskTtlMs,
			maxAgents: runtimeConfig.maxAgents,
			taskTtl: formatDuration(runtimeConfig.taskTtlMs),
			approvalTimeout: formatDuration(runtimeConfig.approvalTimeoutMs),
			authTokenSet: Boolean(runtimeConfig.authToken),
			workspaceRoots: runtimeConfig.workspaceRoots,
			enableFsWrite: runtimeConfig.enableFsWrite,
			defaultSandbox: runtimeConfig.defaultSandbox,
			approvalsBridge: runtimeConfig.approvalsBridge,
			approvalTimeoutMs: runtimeConfig.approvalTimeoutMs,
			approvalFileDir: runtimeConfig.approvalFileDir,
			notify: {
				enabled: runtimeConfig.notifyEnabled !== false,
				defaultCallbackSecretSet: Boolean(runtimeConfig.defaultCallbackSecret),
				allowedCallbackHosts: runtimeConfig.allowedCallbackHosts,
				callbackPreset: describeCallbackPreset()
			},
			sessionSearch: {
				backend: sessionSearchBackend,
				...sessionSearchFallbackReason !== void 0 ? { fallbackReason: sessionSearchFallbackReason } : {}
			}
		}, null, 2));
	});
	mcp.tool("fs_read", "直接读服务器上的文本文件(不用起 agent, 快且免费)。什么时候用: 想确认某个文件现在的内容/某行代码在不在, 又不想为一个只读操作付一次 agent_run 的代价。适合看配置、日志尾部、源码片段。限制: 只能读 ~/.dsh 与已注册工作区白名单内的路径, 且 .ssh/.env/*token*/*.pem 一律拒绝; 单文件 >8MB 拒绝。返回 {path,totalLines,offset,limit,truncated,content,next?,note?}; 文件大就配合 offset/limit 分段读(offset 超过总行数时 content 会是空串, 此时返回体带 note 明确说明\"越界、不是文件为空\"—— 别把 content:\"\" 误判成空文件)。要看目录列表用 fs_list, 要只看元数据用 fs_stat, 要改文件用 fs_write(需部署开启)。", {
		path: z.string().describe("文件绝对路径(会 realpath 规范化)"),
		offset: z.number().int().min(1).optional().describe("起始行(1-based, 默认 1); 接着上次读完的位置继续读就靠它"),
		limit: z.number().int().min(1).max(2e3).optional().describe("最多返回行数(默认 400, 最大 2000); content 另有 48KB 上限")
	}, async ({ path, offset, limit }) => {
		try {
			const bad = validateArgs("fs_read", {
				path,
				offset,
				limit
			}, [
				{
					name: "path",
					type: "string",
					required: true
				},
				{
					name: "offset",
					type: "number"
				},
				{
					name: "limit",
					type: "number"
				}
			]);
			if (bad) return out(JSON.stringify({ error: bad }));
			const gate = await gateFsPath(ctx, path);
			if (gate.error) return out(JSON.stringify({ error: `${gate.error} (改用工作区内的路径, 或先用 fs_list 确认可访问的目录)` }));
			const canonical = gate.canonical;
			const st = await stat(canonical).catch(() => void 0);
			if (!st) return out(JSON.stringify({ error: errText("path not found", path, "realpath 解析后文件不存在", "确认路径拼写; 用 fs_list 看父目录里有什么") }));
			if (st.isDirectory()) return out(JSON.stringify({ error: errText("is a directory, use fs_list", canonical, "目标是个目录而不是文件", "改用 fs_list(path=...) 列目录, 或补上文件名") }));
			if (st.size > FS_READ_MAX_FILE_BYTES) return out(JSON.stringify({ error: errText("file too large", formatBytes(st.size) ?? String(st.size), `超过单文件上限 ${formatBytes(FS_READ_MAX_FILE_BYTES)}`, `用 offset/limit 分段读, 或改用 session_log/bash 侧手段`) }));
			const lines = (await readFile(canonical, "utf8")).split("\n");
			if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
			const totalLines = lines.length;
			const off = Math.max(1, Math.trunc(offset ?? 1));
			const lim = Math.min(Math.max(1, Math.trunc(limit ?? 400)), 2e3);
			const offsetNote = fsReadOffsetNote(off, totalLines);
			let content = lines.slice(off - 1, off - 1 + lim).join("\n");
			let truncated = off - 1 + lim < totalLines;
			if (content.length > FS_READ_MAX_CHARS) {
				content = content.slice(0, FS_READ_MAX_CHARS);
				truncated = true;
			}
			return out(JSON.stringify({
				path: canonical,
				totalLines,
				offset: off,
				limit: lim,
				truncated,
				content,
				size: formatBytes(st.size),
				size_bytes: st.size,
				...timeFields("modifiedAt", st.mtimeMs),
				...truncated ? { next: `文件共 ${totalLines} 行, 本次返回第 ${off}~${Math.min(off + lim - 1, totalLines)} 行; 继续读请传 offset=${off + lim}` } : {},
				...offsetNote !== void 0 ? { note: offsetNote } : {}
			}));
		} catch (e) {
			return out(JSON.stringify({ error: toolFailure("fs_read", e) }));
		}
	});
	mcp.tool("fs_list", "列服务器上的目录内容(不用起 agent)。什么时候用: ① 不知道项目文件都在哪, 先看一眼 ② fs_read 报 path not found 时确认父目录里到底有什么 ③ 找某个文件的全路径、或确认 agent 刚才把文件写到哪了。depth 可递归(默认 1 层, 最大 5)。敏感项(.ssh/.env/*token*/*.pem)会从结果里隐藏。返回 {path,depth,count,total,truncated,offset,limit,next?,entries:[{name,type,size,size_bytes,mtime(ISO8601),mtime_epoch}]}(type=dir|file|symlink|other; 默认最多 1000 条, 超限时用 offset/limit 翻页)。拿到文件路径后用 fs_read 读内容。", {
		path: z.string().describe("目录绝对路径(必须是目录; 传文件会报错)"),
		depth: z.number().int().min(1).max(5).optional().describe("递归层数(默认 1 只看本层, 最大 5)"),
		...pageArgSchema
	}, async ({ path, depth, offset, limit }) => {
		try {
			const bad = validateArgs("fs_list", {
				path,
				depth,
				offset,
				limit
			}, [
				{
					name: "path",
					type: "string",
					required: true
				},
				{
					name: "depth",
					type: "number"
				},
				{
					name: "offset",
					type: "number"
				},
				{
					name: "limit",
					type: "number"
				}
			]);
			if (bad) return out(JSON.stringify({ error: bad }));
			const gate = await gateFsPath(ctx, path);
			if (gate.error) return out(JSON.stringify({ error: `${gate.error} (改用工作区内的目录; 不知道工作区在哪可以看 config_get 的 workspaceRoots)` }));
			const root = gate.canonical;
			const maxDepth = Math.min(Math.max(1, Math.trunc(depth ?? 1)), 5);
			const entries = [];
			let truncated = false;
			const walk = async (dir, level) => {
				if (truncated) return;
				let dirents;
				try {
					dirents = await readdir(dir, { withFileTypes: true });
				} catch {
					return;
				}
				dirents.sort((a, b) => a.name.localeCompare(b.name));
				for (const de of dirents) {
					if (entries.length >= FS_LIST_MAX_ENTRIES) {
						truncated = true;
						return;
					}
					const full = join(dir, de.name);
					if (isSensitivePath(full)) continue;
					const type = de.isDirectory() ? "dir" : de.isSymbolicLink() ? "symlink" : de.isFile() ? "file" : "other";
					let size;
					let sizeBytes;
					let mtime;
					let mtimeEpoch;
					try {
						const s = await stat(full);
						sizeBytes = s.size;
						size = formatBytes(s.size);
						const h = humanTime(s.mtimeMs);
						mtime = h?.at;
						mtimeEpoch = h?.at_epoch;
					} catch {}
					entries.push({
						name: full.slice(root.length + 1) || de.name,
						type,
						size,
						size_bytes: sizeBytes,
						mtime,
						mtime_epoch: mtimeEpoch
					});
					if (de.isDirectory() && level < maxDepth) await walk(full, level + 1);
				}
			};
			await walk(root, 1);
			const { offset: off, limit: lim } = parsePage(offset, limit, FS_LIST_MAX_ENTRIES);
			const { page, meta } = pageEnvelope(entries, off, lim, "fs_list");
			const nextHint = meta.next ?? (truncated ? `目录条目达到上限 ${FS_LIST_MAX_ENTRIES} 条已截断; 缩小 depth 或改列子目录` : void 0);
			return out(JSON.stringify({
				path: root,
				depth: maxDepth,
				count: page.length,
				total: meta.total,
				offset: meta.offset,
				limit: meta.limit,
				truncated: meta.truncated || truncated,
				...nextHint !== void 0 ? { next: nextHint } : {},
				entries: page
			}));
		} catch (e) {
			return out(JSON.stringify({ error: toolFailure("fs_list", e) }));
		}
	});
	mcp.tool("fs_stat", "只查文件/目录的元数据, 不读内容(判断\"这个文件存在吗/多大/什么时候改的\")。什么时候用: ① fs_read 之前先探一下文件在不在、多大, 避免浪费一次大读取 ② 比较两个文件的 mtime 看谁更新 ③ 确认某个路径是文件还是目录 ④ 确认 agent 是否真的把文件写到了某个落点。与 fs_read 的区别: 这个几乎零成本, 且不存在的路径也返回 exists:false 而不是报错。返回 {exists,path,size(如 9.4KB),size_bytes,mtime(ISO8601),mtime_epoch,isDir,isFile}(不存在时只有 exists:false 和 path)。", { path: z.string().describe("绝对路径(可以不存在 —— 不存在返回 exists:false 而非报错)") }, async ({ path }) => {
		try {
			const bad = validateArgs("fs_stat", { path }, [{
				name: "path",
				type: "string",
				required: true
			}]);
			if (bad) return out(JSON.stringify({ error: bad }));
			const gate = await gateFsPathSoft(ctx, path);
			if (gate.error) return out(JSON.stringify({ error: `${gate.error} (该路径被安全策略拒绝; 换到工作区内的路径再试)` }));
			if (gate.missing) return out(JSON.stringify({
				exists: false,
				path: gate.canonical
			}));
			const canonical = gate.canonical;
			const st = await stat(canonical).catch(() => void 0);
			if (!st) return out(JSON.stringify({
				exists: false,
				path: canonical
			}));
			return out(JSON.stringify({
				exists: true,
				path: canonical,
				size: formatBytes(st.size),
				size_bytes: st.size,
				...timeFields("mtime", st.mtimeMs),
				isDir: st.isDirectory(),
				isFile: st.isFile()
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `${toolFailure("fs_stat", e)} (路径可能在白名单外; 用 config_get 查 workspaceRoots)` }));
		}
	});
	if (runtimeConfig.enableFsWrite) mcp.tool("fs_write", "直接写文本文件(需部署方开启 enableFsWrite; 未开启时本工具不可见)。什么时候用: 确定要落一个已知内容的文件, 且不想为一次简单写入付 agent_run 的代价(如写临时脚本、落配置、追加日志)。若需要 agent 自己判断该改什么, 请用 agent_run/task_inbox。限制: 只能在 workspaceRoots 白名单内(路径 jail), .ssh/.env/*token*/*.pem 一律拒绝, 单次内容 ≤4MB, 父目录会自动创建。返回 {ok,path,bytes(如 9.4KB),bytes_raw,mode}。改完想核对用 fs_read 读回。", {
		path: z.string().describe("文件绝对路径(可以不存在, 父目录自动创建; 必须在 workspaceRoots 内)"),
		content: z.string().describe("要写入的 UTF-8 文本(上限 4MB)"),
		mode: z.enum([
			"overwrite",
			"append",
			"create-new"
		]).optional().describe("写入模式(默认 overwrite 全量覆盖; append 追加到末尾; create-new 在文件已存在时报错, 用于防误覆盖)")
	}, async ({ path, content, mode }) => {
		try {
			const bad = validateArgs("fs_write", {
				path,
				content,
				mode
			}, [
				{
					name: "path",
					type: "string",
					required: true
				},
				{
					name: "content",
					type: "string",
					required: true
				},
				{
					name: "mode",
					type: "string"
				}
			]);
			if (bad) return out(JSON.stringify({ error: bad }));
			const m = mode ?? "overwrite";
			const bytes = Buffer.byteLength(content, "utf8");
			if (bytes > FS_WRITE_MAX_BYTES) return out(JSON.stringify({ error: errText("content too large", formatBytes(bytes) ?? String(bytes), `超过单次上限 ${formatBytes(FS_WRITE_MAX_BYTES)}`, "拆成多次 mode=append 写入") }));
			const gate = await gateFsWritePath(path);
			if (gate.error) return out(JSON.stringify({ error: `${gate.error} (fs_write 只能写 workspaceRoots 内的路径; 用 config_get 查看允许的目录)` }));
			const canonical = gate.canonical;
			const fileExistsError = () => errText("file already exists", canonical, "mode=create-new 但目标已存在", "改用 mode=overwrite 覆盖, 或 mode=append 追加, 或换个新路径");
			if (m === "create-new") {
				await mkdir(dirname(canonical), { recursive: true });
				try {
					await writeFile(canonical, content, {
						encoding: "utf8",
						flag: "wx"
					});
				} catch (e) {
					if (e?.code === "EEXIST") return out(JSON.stringify({ error: fileExistsError() }));
					throw e;
				}
				return out(JSON.stringify({
					ok: true,
					path: canonical,
					bytes: formatBytes(bytes),
					bytes_raw: bytes,
					mode: m,
					next: `用 fs_read(path="${canonical}") 读回核对`
				}));
			}
			await mkdir(dirname(canonical), { recursive: true });
			if (m === "append") await appendFile(canonical, content, "utf8");
			else await writeFile(canonical, content, "utf8");
			return out(JSON.stringify({
				ok: true,
				path: canonical,
				bytes: formatBytes(bytes),
				bytes_raw: bytes,
				mode: m,
				next: `用 fs_read(path="${canonical}") 读回核对`
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `${toolFailure("fs_write", e)} (确认父目录可写、路径在白名单内)` }));
		}
	});
	mcp.tool("session_list", "【最先调用】列出所有会话(live+已持久化合并), 用来找会话 id / 标题 / 工作目录。要 messageCount/token 统计请传 detail:\"full\"(默认 brief 不读日志, 快; full 会逐行读日志补 messageCount/inputTokens/outputTokens/llmTime/sandboxMode, 较慢)。什么时候用: 不知道 sessionId、想续接某个历史会话(拿到 id 后传给 agent_run/task_inbox 的 sessionId)、或想知道最近在哪些目录干过活。不传 cwd = 列出全部(默认); 传 cwd = 只看该工作区。返回 {total,count,offset,limit,detail,truncated,skipped,skippedNoCwd?,source,detailHint?,next?,sessions:[...]}; brief 行含 {id,title,cwd,createdAt*,updatedAt*,tokensAvailable:false,sizeBytes?,live}, full 行改为含 {messageCount,inputTokens,outputTokens,llmTime,llmTimeHuman,sandboxMode?}(默认最多 20 条, 按 updatedAt 倒序; 超 20 条用 offset/limit 翻页)。skipped=读取失败被跳过的会话数; skippedNoCwd=header 缺 cwd 未参与过滤的会话数(单行失败不影响整表)。拿到 id 后: 看对话用 session_log(sessionId=...), 续接干活用 agent_run(sessionId=...)。", {
		cwd: z.string().optional().describe("按工作目录过滤(realpath 规范化后精确匹配); 不传=全部会话"),
		limit: z.number().int().min(1).max(SESSION_LIST_MAX_ROWS).optional().describe("本页最多返回条数(默认 20, 最大 50)"),
		offset: pageArgSchema.offset,
		detail: z.enum(["brief", "full"]).optional().describe("返回详略(默认 brief)。brief=只回 header + 免费字段(id/title/cwd/createdAt/updatedAt/sizeBytes), 快; full=额外逐行读日志补 messageCount/inputTokens/outputTokens/llmTime/sandboxMode, 慢且受单会话超时限制")
	}, async ({ cwd, limit, offset, detail }) => {
		try {
			const bad = validateArgs("session_list", {
				cwd,
				limit,
				offset,
				detail
			}, [
				{
					name: "cwd",
					type: "string"
				},
				{
					name: "limit",
					type: "number"
				},
				{
					name: "offset",
					type: "number"
				},
				{
					name: "detail",
					type: "string"
				}
			]);
			if (bad) return out(JSON.stringify({ error: bad }));
			const { offset: off, limit: lim } = parsePage(offset, limit, 20);
			const max = Math.min(Math.max(1, lim), SESSION_LIST_MAX_ROWS);
			const { rows: corpus, skipped: mergeSkipped, skippedNoCwd, source } = await listCorpus(ctx);
			let rows = corpus;
			if (cwd) {
				const target = await canonicalCwd(resolve(cwd));
				const filtered = [];
				for (const r of rows) {
					if (r.header.cwd === void 0) continue;
					if (await canonicalCwd(r.header.cwd) === target) filtered.push(r);
				}
				rows = filtered;
			}
			if (rows.length === 0) return out(JSON.stringify({
				error: cwd ? errText("session is empty", cwd, "该工作目录下没有任何会话", "去掉 cwd 参数列出全部会话, 或先用 agent_run(cwd=...) 在该目录建一个会话") : errText("session is empty", "(all)", "当前 live 与持久化里都没有会话", "先用 agent_run 或 task_inbox 跑一个任务即可建会话"),
				...skippedNoCwd > 0 ? { skippedNoCwd } : {}
			}));
			rows.sort((a, b) => b.updatedAt - a.updatedAt);
			const selected = rows.slice(off, off + max);
			let skipped = mergeSkipped;
			const sessions = [];
			if (detail === "full") {
				const detailById = await inspectRowsConcurrent(ctx, selected, () => {
					skipped++;
				});
				for (const r of selected) {
					const h = r.header;
					const d = detailById.get(String(h.id));
					if (d === void 0) {
						skipped++;
						continue;
					}
					sessions.push({
						id: h.id,
						title: d.title ?? `(untitled ${String(h.id).slice(0, 8)})`,
						cwd: h.cwd,
						...timeFields("createdAt", h.createdAt),
						...timeFields("updatedAt", r.updatedAt),
						messageCount: d.messageCount,
						inputTokens: d.inputTokens ?? 0,
						outputTokens: d.outputTokens ?? 0,
						llmTime: d.llmTimeSec ?? 0,
						llmTimeHuman: formatDuration((d.llmTimeSec ?? 0) * 1e3),
						...d.sandboxMode !== void 0 ? { sandboxMode: d.sandboxMode } : {}
					});
				}
			} else for (const r of selected) {
				const h = r.header;
				sessions.push({
					id: h.id,
					title: `(untitled ${String(h.id).slice(0, 8)})`,
					cwd: h.cwd,
					...timeFields("createdAt", h.createdAt),
					...timeFields("updatedAt", r.updatedAt),
					tokensAvailable: false,
					...r.sizeBytes !== void 0 ? { sizeBytes: r.sizeBytes } : {},
					live: r.live
				});
			}
			const hasMore = off + selected.length < rows.length;
			return out(JSON.stringify({
				total: rows.length,
				count: sessions.length,
				offset: off,
				limit: max,
				detail: detail ?? "brief",
				truncated: hasMore,
				skipped,
				...skippedNoCwd > 0 ? { skippedNoCwd } : {},
				source,
				...detail !== "full" ? { detailHint: "messageCount/inputTokens/outputTokens/llmTime/sandboxMode 需 detail:'full'(会逐行读日志, 较慢)" } : {},
				...hasMore ? { next: `共 ${rows.length} 个会话, 本页 ${sessions.length} 个; 取下一页请传 offset=${off + selected.length}` } : {},
				sessions
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `${toolFailure("session_list", e)} (若持续失败, 先用 cwd 过滤缩小范围, 或改用 session_search 按关键词找会话)` }));
		}
	});
	mcp.tool("session_log", "读某个会话的对话/工具调用记录(已剥离 thinking/reasoning 推理块)。什么时候用: 拿到了 sessionId(session_list 或 agent_run 返回)想复盘这次到底说了什么/调了什么工具/为什么失败, 或者 agent_run 结果里的 changes/verification 不够、要看原始过程。返回 {sessionId,header:{cwd,createdAt(ISO8601),createdAt_epoch,preset},types,totalMatched,shown,truncated,next?,events:[{seq,type,time(ISO8601),time_epoch,...}]}——events 按时间正序; 默认最多 50 条事件, 超过则返回首尾各若干条并置 truncated:true(提示如何翻页取更多)。不想挑类型就用 preset=「dialog」(只看人机对话)或「tools」(只看工具调用); 要精确控制再用 types。", {
		sessionId: z.string().describe("会话 id(session_list 的 sessions[].id 或 agent_run 结果里的 sessionId)"),
		tail: z.number().int().min(1).max(500).optional().describe("只取最后 N 条匹配事件(默认 50, 最大 500); 想看更早的调大这个值"),
		head: z.number().int().min(0).max(200).optional().describe("截断时额外保留的最旧 N 条事件(默认 5, 用于同时看到会话开头); 只要最新就传 0"),
		preset: z.enum([
			"dialog",
			"tools",
			"all"
		]).optional().describe("常用预设(免拼 types): dialog=只看人机对话(user/message+assistant/message, 最常用); tools=只看工具调用与结果(tool/call+tool/result); all=全部事件类型。不传=默认 dialog+tools 混合"),
		types: z.array(z.string()).optional().describe("精确事件类型过滤(优先级高于 preset); 默认 [user/message, assistant/message, tool/call, tool/result]")
	}, async ({ sessionId, tail, preset, types, head }) => {
		try {
			const bad = validateArgs("session_log", {
				sessionId,
				tail,
				head,
				types
			}, [
				{
					name: "sessionId",
					type: "string",
					required: true
				},
				{
					name: "tail",
					type: "number"
				},
				{
					name: "head",
					type: "number"
				},
				{
					name: "types",
					type: "array"
				}
			]);
			if (bad) return out(JSON.stringify({ error: bad }));
			const sid = SessionId(sessionId);
			let meta;
			let events = [];
			try {
				const insp = await persistedInspect(ctx, sid);
				if (insp) {
					meta = insp.meta;
					events = insp.events;
				}
			} catch {}
			if (events.length === 0) {
				const live = ctx.get("sessions")?.get?.(sid);
				if (live) {
					meta = live.header ?? meta;
					events = live.log ?? [];
				}
			}
			if (meta === void 0 && events.length === 0) return out(JSON.stringify({ error: sessionNotFoundError(sessionId) }));
			if (events.length === 0) return out(JSON.stringify({ error: emptySessionError(sessionId) }));
			const wanted = types && types.length > 0 ? types : preset === "all" ? [] : (preset ? {
				dialog: ["user/message", "assistant/message"],
				tools: ["tool/call", "tool/result"]
			}[preset] : void 0) ?? DEFAULT_LOG_TYPES;
			const filtered = wanted.length === 0 ? events : events.filter((e) => wanted.includes(e?.type ?? ""));
			const totalMatched = filtered.length;
			const n = Math.min(Math.max(1, Math.trunc(tail ?? SESSION_LOG_MAX_EVENTS)), 500);
			const headN = Math.min(Math.max(0, Math.trunc(head ?? SESSION_LOG_HEAD_EVENTS)), 200);
			const overCap = totalMatched > n;
			const sliced = overCap && headN > 0 ? [...filtered.slice(0, headN), ...filtered.slice(-(n - headN))] : filtered.slice(-n);
			const records = [];
			let budget = SESSION_LOG_MAX_CHARS;
			for (let i = sliced.length - 1; i >= 0; i--) {
				const rec = compactLogEvent(sliced[i]);
				const cost = JSON.stringify(rec)?.length ?? 0;
				if (cost > budget) break;
				budget -= cost;
				records.unshift(rec);
			}
			const shown = records.length;
			const omitted = totalMatched - shown;
			const truncated = shown < sliced.length || overCap;
			return out(JSON.stringify({
				sessionId,
				header: meta ? {
					cwd: meta.cwd,
					...timeFields("createdAt", meta.createdAt),
					preset: presetFromEvents(meta, events)
				} : void 0,
				...preset !== void 0 ? { preset } : {},
				types: wanted,
				totalMatched,
				shown,
				truncated,
				...truncated ? {
					omitted,
					order: overCap && headN > 0 ? `head(${Math.min(headN, shown)}) + tail(${shown - Math.min(headN, shown)})` : "tail",
					next: `默认最多返回 ${SESSION_LOG_MAX_EVENTS} 条事件, 本次命中 ${totalMatched} 条(省略 ${omitted} 条); 取更多请调大 tail(最大 500)、传 head=0 只看最新、或用 preset/types 缩小范围`
				} : {},
				events: records
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `${toolFailure("session_log", e)} (确认 sessionId 是否正确: 用 session_list 查看; 该会话可能已被清理)` }));
		}
	});
	mcp.tool("session_stats", "看一个会话的用量与性能统计(不读内容, 只看数)。什么时候用: ① 想知道刚才那次 agent_run 花了多少 token / 多久 ② 对比不同 preset 或不同任务的效率 ③ 排查\"怎么这么慢\"(看 ttft/toolTime/cacheHitRate 哪块占大头)。不传 sessionId = 最近一次 agent_run/task_inbox 的会话(最常用); 传 sessionId = 指定会话的全会话累计。返回 {rounds,steps,llmTime,toolTime,ttft,tokensPerSec,cacheHitRate,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens,source}(时间是秒)。想看具体发生了什么用 session_log。", { sessionId: z.string().optional().describe("会话 id(缺省 = 最近一次 agent_run/task_inbox 的会话; 也可传 session_list 里的任意 id)") }, async ({ sessionId }) => {
		try {
			const bad = validateArgs("session_stats", { sessionId }, [{
				name: "sessionId",
				type: "string"
			}]);
			if (bad) return out(JSON.stringify({ error: bad }));
			let target = sessionId;
			let source;
			if (!target) {
				if (lastAgentSessionId === void 0) return out(JSON.stringify({ error: errText("session is empty", "(last agent session)", "本进程还没有跑过任何任务, 拿不到\"最近会话\"", "先调 agent_run 或 task_inbox, 或显式传 sessionId —— 会话 id 可从 session_list 拿") }));
				target = lastAgentSessionId;
			}
			const found = await collectSessionEvents(ctx, SessionId(target));
			if (found === void 0) return out(JSON.stringify({ error: sessionNotFoundError(target) }));
			if (found.events.length === 0) return out(JSON.stringify({ error: emptySessionError(target) }));
			source = found.source;
			const stats = presentSessionStats(foldSessionStats(found.events), {
				scope: "session",
				sessionId: target
			});
			return out(JSON.stringify({
				...stats,
				source,
				next: HINT.resumeSession
			}, null, 2));
		} catch (e) {
			return out(JSON.stringify({ error: toolFailure("session_stats", e) }));
		}
	});
	mcp.tool("session_search", "不记得 sessionId, 只记得聊过什么 —— 按关键词跨会话找。什么时候用: ① 想找回\"上次讨论 X 的那个会话\" ② 确认某个决定/方案在历史会话里出现过没有 ③ session_list 条目太多翻不过来。先匹配标题, 未命中再尽力扫内容(每会话 2s 超时, 跳过慢的)。**两个数字参数分工不同, 别传错**: scan = 最多扫描最近多少个会话(决定\"找得全不全\", 默认 50 最大 200, 调大更慢); limit = 本页最多返回多少条(决定\"一次给多少\", 默认 20 最大 100, 与 session_list/task_list 的 limit 同义), 不够就调大 limit 或用 offset 翻页 —— 调大 limit **不会**加深扫描, 想找得更全请调 scan。返回 {query,regex,total,count,offset,limit,truncated,hasMore,matchedTotal,omitted,scan,scannedSessions?,skippedNoCwd?,next?,content_search,filter_noise,boilerplate_count,backend,indexFallbackReason?,indexFallbackHint?,results:[{sessionId,title,cwd,updatedAt(ISO8601),updatedAt_epoch,matched 为 title 或 content,snippet?,boilerplate?}]}(按 updatedAt 倒序; 默认把\"几乎每个会话都命中的样板文字\"沉底并标 boilerplate=true, 可用 filter_noise=false 关闭)。⚠️ 三个数字口径: total=本次扫描的会话数(不是结果数), matchedTotal=命中总数, count=本页返回条数; 当 matchedTotal > count 时必然给出 omitted(还差多少条)+ hasMore=true + next(怎么取下一页), 绝不会静默丢弃。找到 sessionId 后用 session_log 看细节、或 agent_run(sessionId=...) 续接。注意: 内容匹配是\"尽力而为\", content_search=false 说明本次只搜了标题。", {
		query: z.string().min(1).describe("搜索词(默认大小写不敏感子串; regex=true 时按正则)"),
		cwd: z.string().optional().describe("只搜这个工作目录下的会话(realpath 精确匹配); 不传=全部"),
		regex: z.boolean().optional().describe("把 query 当正则解释(默认 false 当普通子串)"),
		scan: z.number().int().min(1).max(200).optional().describe("最多扫描最近 N 个会话(决定\"找得全不全\", 默认 50, 最大 200; 调大更全但更慢。与 limit 无关)"),
		limit: z.number().int().min(1).max(LIST_PAGE_MAX).optional().describe(`本页最多返回 N 条命中(决定"一次给多少", 默认 ${LIST_PAGE_DEFAULT}, 最大 ${LIST_PAGE_MAX}; 与 session_list 的 limit 同义)。调大不会加深扫描, 想找得更全请调 scan`),
		offset: pageArgSchema.offset,
		pageSize: z.number().int().min(1).max(LIST_PAGE_MAX).optional().describe(`[兼容旧调用方] 与 limit 同义的本页条数; 若同时传 limit 以 limit 为准`),
		filter_noise: z.boolean().optional().describe("是否把\"几乎每个会话都命中的样板文字\"降权沉底(默认 true; 这类命中零信息量, 会挤占前排。设 false 可拿到原始 updatedAt 序)")
	}, async ({ query, cwd, regex, scan, limit, offset, pageSize, filter_noise }) => {
		try {
			const bad = validateArgs("session_search", {
				query,
				cwd,
				regex,
				scan,
				limit,
				offset,
				pageSize,
				filter_noise
			}, [
				{
					name: "query",
					type: "string",
					required: true
				},
				{
					name: "cwd",
					type: "string"
				},
				{
					name: "regex",
					type: "boolean"
				},
				{
					name: "scan",
					type: "number"
				},
				{
					name: "limit",
					type: "number"
				},
				{
					name: "offset",
					type: "number"
				},
				{
					name: "pageSize",
					type: "number"
				},
				{
					name: "filter_noise",
					type: "boolean"
				}
			]);
			if (bad) return out(JSON.stringify({ error: bad }));
			if (!query || !query.trim()) return out(JSON.stringify({ error: errText("query must not be empty", "(blank)", "search 需要一个非空关键词", "传一个要搜的关键词后重试; 不知道搜什么可以先 session_list") }));
			let re;
			if (regex) try {
				re = new RegExp(query);
			} catch (e) {
				return out(JSON.stringify({ error: errText("invalid regex", query, e?.message ?? String(e), "改写成合法正则, 或设 regex=false 按普通文本搜") }));
			}
			const needle = query.toLowerCase();
			const scanDepth = Math.min(Math.max(1, Math.trunc(scan ?? 50)), 200);
			const pageLimit = limit !== void 0 ? limit : pageSize;
			const filterNoise = filter_noise !== false;
			let indexFallbackReason;
			if (regex !== true) {
				const idxRes = await tryIndexSearch(ctx, {
					query,
					cwd,
					limit: scanDepth
				});
				if (idxRes.hits) {
					sessionSearchBackend = "index";
					const { offset: off2, limit: lim2 } = parsePage(offset, pageLimit, LIST_PAGE_DEFAULT);
					const { page: page2, meta: meta2 } = pageEnvelope(idxRes.hits, off2, lim2, "session_search");
					const omitted2 = Math.max(0, idxRes.hits.length - meta2.offset - page2.length);
					return out(JSON.stringify({
						query,
						regex: false,
						total: idxRes.hits.length,
						count: page2.length,
						offset: meta2.offset,
						limit: meta2.limit,
						truncated: meta2.truncated,
						hasMore: meta2.hasMore,
						matched: idxRes.hits.length,
						matchedTotal: idxRes.hits.length,
						scanned: idxRes.hits.length,
						scannedSessions: idxRes.hits.length,
						omitted: omitted2,
						scan: scanDepth,
						content_search: true,
						backend: "index",
						...meta2.truncated ? { next: `共 ${idxRes.hits.length} 条命中, 本页给了 ${page2.length} 条, 还有 ${omitted2} 条没给; 取下一页请传 offset=${meta2.offset + page2.length}` } : {},
						results: page2.map((r) => {
							const { updatedAt, ...rest } = r;
							return {
								...rest,
								...timeFields("updatedAt", updatedAt)
							};
						})
					}, null, 2));
				}
				indexFallbackReason = idxRes.reason;
			} else indexFallbackReason = "regex=true 需插件侧正则扫描, 索引后端不支持";
			sessionSearchBackend = "scan";
			sessionSearchFallbackReason = indexFallbackReason;
			const { rows: corpus, skippedNoCwd: searchSkippedNoCwd } = await listCorpus(ctx);
			let rows = corpus;
			if (cwd) {
				const target = await canonicalCwd(resolve(cwd));
				const filtered = [];
				for (const r of rows) {
					if (r.header.cwd === void 0) continue;
					if (await canonicalCwd(r.header.cwd) === target) filtered.push(r);
				}
				rows = filtered;
			}
			if (rows.length === 0) return out(JSON.stringify({
				error: cwd ? errText("session is empty", cwd, "该工作目录下没有可搜索的会话", "去掉 cwd 或换一个目录再搜; 用 session_list 看全部会话") : errText("session is empty", "(all)", "当前 live 与持久化里都没有会话", "先用 agent_run/task_inbox 建会话, 或用 session_list 确认服务状态"),
				...searchSkippedNoCwd > 0 ? { skippedNoCwd: searchSkippedNoCwd } : {}
			}));
			rows.sort((a, b) => b.updatedAt - a.updatedAt);
			const scanned = rows.slice(0, scanDepth);
			const scannedRows = scanned.map((r) => ({
				h: r.header,
				at: r.updatedAt
			}));
			const hits = [];
			let contentSearched = false;
			const queue = [...scannedRows];
			const worker = async () => {
				for (;;) {
					const it = queue.shift();
					if (!it) return;
					try {
						const r = await searchOneSession(ctx, it.h, Math.round(it.at), {
							re,
							needle,
							rawLen: query.length
						});
						if (r.contentSearched) contentSearched = true;
						if (r.row) hits.push(r.row);
					} catch {}
				}
			};
			await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
			hits.sort((a, b) => b.updatedAt - a.updatedAt);
			const boilerplateKeys = filterNoise ? detectBoilerplateKeys(hits) : /* @__PURE__ */ new Set();
			const isBoilerplateHit = (r) => r.matched === "content" && typeof r.snippet === "string" && boilerplateKeys.has(noiseKey(r.snippet));
			let boilerplateCount = 0;
			let orderedHits = hits;
			if (boilerplateKeys.size > 0) {
				const real = [];
				const noise = [];
				for (const r of hits) if (isBoilerplateHit(r)) {
					noise.push({
						...r,
						boilerplate: true
					});
					boilerplateCount++;
				} else real.push(r);
				if (noise.length > 0) orderedHits = [...real, ...noise];
			}
			const { offset: off, limit: lim } = parsePage(offset, pageLimit, LIST_PAGE_DEFAULT);
			const { page, meta } = pageEnvelope(orderedHits, off, lim, "session_search");
			const omitted = Math.max(0, hits.length - meta.offset - page.length);
			return out(JSON.stringify({
				query,
				regex: Boolean(regex),
				total: scanned.length,
				count: page.length,
				offset: meta.offset,
				limit: meta.limit,
				truncated: meta.truncated,
				hasMore: meta.hasMore,
				matched: hits.length,
				matchedTotal: hits.length,
				scanned: scanned.length,
				scannedSessions: scanned.length,
				omitted,
				scan: scanDepth,
				filter_noise: filterNoise,
				boilerplate_count: boilerplateCount,
				content_search: contentSearched,
				backend: "scan",
				...indexFallbackReason !== void 0 ? { indexFallbackReason } : {},
				...indexFallbackReason !== void 0 ? { indexFallbackHint: INDEX_FALLBACK_HINT } : {},
				...searchSkippedNoCwd > 0 ? { skippedNoCwd: searchSkippedNoCwd } : {},
				results: page.map((r) => {
					const { updatedAt, ...rest } = r;
					return {
						...rest,
						...timeFields("updatedAt", updatedAt)
					};
				}),
				...meta.truncated ? { next: `命中 ${hits.length} 条, 本页给了 ${page.length} 条, 还有 ${omitted} 条没给; 取下一页传 offset=${meta.offset + page.length}&limit=${meta.limit}` } : {},
				hint: hits.length > 0 ? meta.truncated ? `本页只是前 ${page.length} 条; 想一次拿更多请调大 limit(最大 ${LIST_PAGE_MAX}), 想找得更全请调大 scan(当前 ${scanDepth}); 拿到 sessionId 后看细节用 session_log(sessionId=...), 续接干活用 agent_run(sessionId=...)` : "拿到 sessionId 后: 看细节用 session_log(sessionId=...), 续接干活用 agent_run(sessionId=...)" : `没有命中; 可尝试: 调大 scan(当前扫了最近 ${scanned.length} 个会话)、换更短的关键词、或设 regex=true 用正则; 全部会话列表用 session_list`
			}, null, 2));
		} catch (e) {
			return out(JSON.stringify({ error: `${toolFailure("session_search", e)} (可去掉 regex 或缩小 cwd 再试; 单会话读取超时会被跳过, 属正常)` }));
		}
	});
	mcp.tool("preset_list", "列出当前部署可用的 agent preset(能力组合模板)与默认项。什么时候用: ① 想给某类任务换个更合适的 preset(如编码用 code、最小工具集用 minimal), 先来这里查合法 id —— agent_run/task_inbox 的 preset 参数和 preset_set 都只认这里返回的 id ② 传 preset 报 unknown preset 后, 用这里拿 available 名单。返回 {source(agentPresets 或 builtin-fallback),default,presets:[{id,name,description,trust,broken}]}。选好 id 后: 单次任务用 agent_run(preset=...), 改默认用 preset_set(presetId=...)。", {}, async () => {
		try {
			const svc = ctx.agentPresets;
			const discovered = await svc?.list?.();
			if (discovered && discovered.length > 0) return out(JSON.stringify({
				source: "agentPresets",
				default: svc?.defaultId ?? runtimeConfig.preset,
				presets: discovered.map((p) => ({
					id: p.id,
					name: p.name ?? p.id,
					description: p.description ?? "",
					trust: p.trust,
					broken: p.broken
				}))
			}, null, 2));
		} catch (e) {
			degrade("agentPresets", "ctx.agentPresets.list() 抛错, preset_list 已回退内置兜底名单(可能不是本部署真实可用的 preset)", e);
		}
		return out(JSON.stringify({
			source: "builtin-fallback",
			default: runtimeConfig.preset,
			presets: [
				{
					id: "standard",
					name: "standard",
					description: "通用全工具 preset"
				},
				{
					id: "code",
					name: "code",
					description: "编码向 preset"
				},
				{
					id: "minimal",
					name: "minimal",
					description: "最小工具集 preset"
				},
				{
					id: "cordis",
					name: "cordis",
					description: "cordis 插件开发 preset"
				}
			]
		}, null, 2));
	});
	mcp.tool("preset_get", "查某个会话当前实际用的是哪个 preset —— 用于解释\"为什么这个会话没有某个工具\"。什么时候用: agent_run 结果不符合预期、怀疑 preset 影响了可用工具集时。不传 sessionId = 只看服务当前默认 preset(便宜)。返回 {sessionId,preset,source(取值 live/persisted/header/default)} 或 {preset,source(取值 plugin-config/agentPresets.defaultId)}。source=default 说明该会话没有 preset 记录(可能不存在)。要改默认用 preset_set。", { sessionId: z.string().optional().describe("要查询的会话 id(缺省 = 只返回本服务的默认 preset, 不查具体会话)") }, async ({ sessionId }) => {
		const bad = validateArgs("preset_get", { sessionId }, [{
			name: "sessionId",
			type: "string"
		}]);
		if (bad) return out(JSON.stringify({ error: bad }));
		if (sessionId) {
			const sid = SessionId(sessionId);
			try {
				const live = ctx.agents.get(sid);
				if (live?.session?.header) {
					const preset = presetFromEvents(live.session.header, live.session.log ?? []);
					if (preset) return out(JSON.stringify({
						sessionId,
						preset,
						source: "live"
					}));
				}
			} catch {}
			try {
				const insp = await persistedInspect(ctx, sid);
				if (insp) {
					const preset = presetFromEvents(insp.meta, insp.events);
					if (preset) return out(JSON.stringify({
						sessionId,
						preset,
						source: "persisted"
					}));
				}
			} catch {}
			const headerOnly = await findSessionHeader(ctx, sid);
			if (headerOnly?.agentPreset) return out(JSON.stringify({
				sessionId,
				preset: headerOnly.agentPreset,
				source: "header"
			}));
			return out(JSON.stringify({
				sessionId,
				preset: ctx.agentPresets?.defaultId ?? runtimeConfig.preset,
				source: "default",
				note: `session ${sessionId} 无 preset 记录(不存在或未记录), 返回默认值`,
				next: `确认会话 id 是否正确用 session_list; 想改默认 preset 用 preset_set(presetId=..., scope=「new-default」)`
			}));
		}
		let def = runtimeConfig.preset;
		let source = "plugin-config";
		try {
			const svcDefault = ctx.agentPresets?.defaultId;
			if (svcDefault) {
				def = svcDefault;
				source = "agentPresets.defaultId";
			}
		} catch {}
		return out(JSON.stringify({
			preset: def,
			source
		}));
	});
	mcp.tool("preset_set", "改 agent 的能力组合(preset)。两种范围, 先想清楚要哪种: ① scope=「new-default」(默认, 最常用)= 以后新起的会话都用这个 preset, 立刻生效且尽力写进全局用户默认(重启仍在) ② scope=「session」= 只改某一个已存在会话, 且仅限「还没开始任何 turn 的空白会话」(已跑过任务的会话 preset 已固化, 会明确报错)。什么时候用: 发现默认 preset 工具太少/太多, 想换成 code、minimal 等(合法 id 见 preset_list)。返回 {ok,scope,preset,runtimeDefault,globalDefaultUpdated,note?}。若只想给「某一个任务」换 preset, 不用这里 —— 直接 agent_run(preset=...) 更轻。", {
		presetId: z.string().describe("目标 preset id(必须是 preset_list 返回的 id)"),
		scope: z.enum(["new-default", "session"]).optional().describe("改哪一层: new-default(默认)=此后新会话都用它; session=只改指定的空白会话"),
		sessionId: z.string().optional().describe("scope=session 时必填的目标会话 id(来自 session_list 或 agent_run 结果)")
	}, async ({ presetId, scope, sessionId }) => {
		const kind = scope ?? "new-default";
		try {
			const bad = validateArgs("preset_set", {
				presetId,
				scope,
				sessionId
			}, [
				{
					name: "presetId",
					type: "string",
					required: true
				},
				{
					name: "scope",
					type: "string"
				},
				{
					name: "sessionId",
					type: "string"
				}
			]);
			if (bad) return out(JSON.stringify({ error: bad }));
			if (kind === "session") {
				if (!sessionId) return out(JSON.stringify({ error: missingParamError("preset_set", "sessionId", "string (scope=session 时必填)") }));
				const sid = SessionId(sessionId);
				const found = await collectSessionEvents(ctx, sid);
				if (found === void 0) return out(JSON.stringify({ error: sessionNotFoundError(sessionId) }));
				if (found.events.some((e) => e?.type === "turn/start")) return out(JSON.stringify({ error: errText("session has already started", sessionId, "该会话已跑过任务, agent preset 已固化, 只有空白会话能切换", "改用 agent_run(preset=...) 起新会话, 或用 scope=「new-default」改默认") }));
				let live;
				try {
					live = ctx.agents.get(sid);
				} catch {
					live = void 0;
				}
				if (live) try {
					const preset = await ctx.agentPresets.recompose(live.ctx, presetId);
					try {
						live.session.append("agent-preset/selected", { agentPreset: preset.id });
					} catch (e) {
						degrade("agentPresets.append", "agent-preset/selected 事件写入 live 会话失败, preset 看似切换成功但未落盘(重启后不生效)", e);
						throw e;
					}
					return out(JSON.stringify({
						ok: true,
						scope: "session",
						sessionId,
						preset: preset.id,
						source: "live",
						next: HINT.resumeSession
					}));
				} catch (e) {
					return out(JSON.stringify({ error: `${toolFailure("preset_set", e)} (用 preset_list 确认 presetId 合法; 或重启会话后重试)` }));
				}
				let handle;
				try {
					handle = await ctx.agents.resume({
						resumeSessionId: sid,
						agentOptions: {
							provider: runtimeConfig.provider,
							...runtimeConfig.model ? { model: runtimeConfig.model } : {}
						},
						setup: async (agentCtx) => {
							if (scopeOf(agentCtx) === void 0) {
								console.warn("[harness-mcp-server] agent ctx unscoped (dsh rc.6 bug); preset mount skipped");
								return;
							}
							await ctx.agentPresets.mount(agentCtx, presetId);
						}
					});
				} catch (e) {
					return out(JSON.stringify({ error: `${toolFailure("preset_set", e)} (该会话可能已被清理; 用 session_list 确认; 或改用 scope=「new-default」只改默认)` }));
				}
				try {
					handle.agent.session.append("agent-preset/selected", { agentPreset: presetId });
				} catch (e) {
					console.warn("[harness-mcp-server] agent-preset/selected append failed:", String(e));
				}
				try {
					await ctx.get("sessions")?.flush?.(handle.agent.session);
				} catch {}
				try {
					await handle.dispose();
				} catch {}
				return out(JSON.stringify({
					ok: true,
					scope: "session",
					sessionId,
					preset: presetId,
					source: "resumed",
					next: HINT.resumeSession
				}));
			}
			try {
				await ctx.agentPresets.resolve(presetId);
			} catch (e) {
				return out(JSON.stringify({ error: errText(`unknown preset`, presetId, `不在当前部署的 preset 名单里 (${e?.message ?? String(e)})`, "用 preset_list 查看合法 id") }));
			}
			runtimeConfig.preset = presetId;
			let globalDefaultUpdated = false;
			let note;
			try {
				const settings = ctx.get("settings");
				if (settings?.mutate) {
					await settings.mutate("agent-presets", [{
						op: "set",
						path: ["default"],
						value: presetId
					}]);
					globalDefaultUpdated = true;
				}
			} catch (e) {
				degrade("settings", "ctx.get(settings).mutate() 抛错, 全局用户默认 preset 未写入(仅本次运行生效, 重启后失效)", e);
				note = `global user-default write skipped: ${e?.message ?? String(e)}`;
			}
			return out(JSON.stringify({
				ok: true,
				scope: "new-default",
				preset: presetId,
				runtimeDefault: runtimeConfig.preset,
				globalDefaultUpdated,
				...note ? { note } : {}
			}, null, 2));
		} catch (e) {
			return out(JSON.stringify({ error: toolFailure("preset_set", e) }));
		}
	});
	mcp.tool("policy_get", "查某个会话现在到底有多少文件权限(沙箱档位), 以及为什么是这个档。什么时候用: ① agent_run 报\"拒绝写入/权限不足\", 先来这里确认实际档位 ② 想确认 danger-full-access 是否真的没开(安全自查) ③ 查审批策略是 ask 还是 never。不传 sessionId = 只看部署默认档(便宜)。返回 {sessionId,sandboxMode,source(override 或 default),workspaceRoot,approvalPolicy}(source=override 表示该会话有专门的 sandbox/mode 记录)。要改档用 set_policy。", { sessionId: z.string().optional().describe("会话 id(缺省 = 只返回部署默认档; 会话 id 来自 session_list 或 agent_run 结果)") }, async ({ sessionId }) => {
		try {
			const bad = validateArgs("policy_get", { sessionId }, [{
				name: "sessionId",
				type: "string"
			}]);
			if (bad) return out(JSON.stringify({ error: bad }));
			if (!sessionId) return out(JSON.stringify({
				sandboxMode: runtimeConfig.defaultSandbox,
				source: "default",
				workspaceRoot: defaultTaskCwd(),
				approvalPolicy: deploymentApprovalPolicy(ctx),
				next: "这是部署默认值; 查具体会话请传 sessionId(从 session_list 获取)"
			}, null, 2));
			const sid = SessionId(sessionId);
			const found = await collectSessionEvents(ctx, sid);
			if (found === void 0) return out(JSON.stringify({ error: sessionNotFoundError(sessionId) }));
			const override = sandboxModeFromEvents(found.events);
			const header = await findSessionHeader(ctx, sid);
			return out(JSON.stringify({
				sessionId,
				sandboxMode: override ?? runtimeConfig.defaultSandbox,
				source: override !== void 0 ? "override" : "default",
				workspaceRoot: header?.cwd !== void 0 ? await canonicalCwd(header.cwd) : defaultTaskCwd(),
				approvalPolicy: approvalPolicyFromEvents(found.events) ?? deploymentApprovalPolicy(ctx),
				...override === void 0 ? { next: "该会话沿用部署默认档; 想单独提档/降档请用 set_policy(sessionId=..., mode=...)" } : {}
			}, null, 2));
		} catch (e) {
			return out(JSON.stringify({ error: `${toolFailure("policy_get", e)} (可用无参调用看部署默认; 会话 id 用 session_list 确认)` }));
		}
	});
	mcp.tool("set_policy", "改某个已存在会话的文件权限档(什么时候用: agent 抱怨写不了文件 / 需要临时放宽或收紧权限)。三档: read-only(只读, 最安全)|workspace-write(工作区可写, 默认)|danger-full-access(完全绕过围栏 + bash 解禁, 无审批任意读写 —— 仅限可信环境!)。重要限制: 只有 live 会话能改(会追加一条 sandbox/mode 事件, 下一次受限调用即生效, 重启后靠 replay 保持); 冷会话必须先跑一轮(agent_run/task_inbox 带该 sessionId)让它活起来再改。只影响这一个会话; 想给新任务定档请直接用 agent_run(sandbox=...)。返回 {ok,sessionId,sandboxMode,source(固定为 live)}。改完用 policy_get 核对。", {
		sessionId: z.string().describe("目标会话 id(必须当前是 live 的; 来自 session_list 或 agent_run 结果)"),
		mode: z.enum(SANDBOX_MODES).describe("目标权限档: read-only 只读 | workspace-write 工作区可写 | danger-full-access 无审批任意读写(仅限可信环境)")
	}, async ({ sessionId, mode }) => {
		try {
			const bad = validateArgs("set_policy", {
				sessionId,
				mode
			}, [{
				name: "sessionId",
				type: "string",
				required: true
			}, {
				name: "mode",
				type: "string",
				required: true
			}]);
			if (bad) return out(JSON.stringify({ error: bad }));
			const sid = SessionId(sessionId);
			let target;
			try {
				target = ctx.agents.get(sid)?.session;
			} catch (e) {
				degrade("agents", "ctx.agents.get() 抛错, set_policy 会把该会话误报为「不 live 或不存在」", e);
				target = void 0;
			}
			if (!target?.append) {
				const attached = ctx.get("sessions")?.get?.(sid);
				if (attached?.append) target = attached;
			}
			if (!target?.append) return out(JSON.stringify({ error: errText("session is not live", sessionId, "冷/已持久化的会话必须先在某一轮里被唤醒(它当前没有可写的 live 句柄)", "先跑一轮让它活起来: agent_run(task=..., sessionId=...) 或 task_inbox(task=..., sessionId=...), 之后再调 set_policy; 或直接在那一轮里用 sandbox=... 指定档位; 用 session_list 确认该 id 存在") }));
			appendSandboxMode(target, mode);
			return out(JSON.stringify({
				ok: true,
				sessionId,
				sandboxMode: mode,
				source: "live",
				next: `用 policy_get(sessionId="${sessionId}") 核对生效档位`
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `${toolFailure("set_policy", e)} (确认 sessionId 正确且会话是 live 的; 用 session_list 查会话, 用 policy_get 查当前档)` }));
		}
	});
	mcp.tool("approval_list", "看有没有\"卡在等人批准\"的请求(agent 想提权/执行敏感操作时, 会一直挂起等回答)。什么时候用: ① agent_run/task_inbox 迟迟不返回, 怀疑卡在审批上 —— 先调这个 ② status_get 显示 pendingApprovals>0 时。返回 {bridge,pending(当前挂起总数, 一眼可读),count(本页条数),total,offset,limit,truncated,next?,timeoutMs,timeout,approvals:[{approvalId,sessionId,toolName,callId?,reason?,requestedAt(ISO8601),requestedAt_epoch,waitedMs,waited}]}。pending/count=0 说明没有待审(任务卡住是别的原因), 无需反复轮询本工具 —— status_get 的 sandboxPolicy.pendingApprovals 也能直接看到该数字。有则立刻用 approval_respond(approvalId=..., sessionId=..., outcome=...) 回答 —— 不回答的话会一直挂到 approvalTimeoutMs 超时(超时按拒绝收尾, 绝不自动放行)。", { ...pageArgSchema }, async ({ offset, limit }) => {
		try {
			const bad = validateArgs("approval_list", {
				offset,
				limit
			}, [{
				name: "offset",
				type: "number"
			}, {
				name: "limit",
				type: "number"
			}]);
			if (bad) return out(JSON.stringify({ error: bad }));
			const now = Date.now();
			const all = [...pendingApprovals.values()].map((e) => ({
				approvalId: e.approvalId,
				sessionId: e.sessionId,
				toolName: e.toolName,
				...e.callId !== void 0 ? { callId: e.callId } : {},
				...e.reason !== void 0 ? { reason: e.reason } : {},
				...timeFields("requestedAt", e.requestedAt),
				waitedMs: now - e.requestedAt,
				waited: formatDuration(now - e.requestedAt)
			}));
			const { offset: off, limit: lim } = parsePage(offset, limit, LIST_PAGE_DEFAULT);
			const { page, meta } = pageEnvelope(all, off, lim, "approval_list");
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
				...meta.next !== void 0 ? { next: meta.next } : {},
				summary: all.length > 0 ? `当前有 ${all.length} 个审批挂起(最久已等 ${formatDuration(Math.max(...all.map((a) => a.waitedMs))) ?? "0ms"}); 用 approval_respond(approvalId=..., sessionId=..., outcome="allowed-once"|"rejected") 回答` : "当前挂起审批数: 0 —— 没有待审请求; 任务卡住请改用 task_list/status_get 查队列与运行态",
				...all.length > 0 ? { hint: `用 approval_respond(approvalId="${all[0].approvalId}", sessionId="${all[0].sessionId}", outcome="allowed-once"|"rejected") 回答; 超时 ${Math.round(runtimeConfig.approvalTimeoutMs / 1e3)}s 后按拒绝收尾` } : {}
			}, null, 2));
		} catch (e) {
			return out(JSON.stringify({ error: toolFailure("approval_list", e) }));
		}
	});
	mcp.tool("approval_respond", "批准或拒绝一个挂起的审批(配合 approval_list 用: 先 list 拿 approvalId, 再 respond)。什么时候用: approval_list 显示 pending/count>0, 或 agent_run/task_inbox 卡住不动。两种结果: outcome=「allowed-once」=只放行这一次(最常用, 不放长期权限); 「rejected」=拒绝该操作, agent 会收到拒绝并自己换路子。返回 {ok,receipt(accepted 或 not-pending),approvalId,sessionId,outcome,pendingRemaining(回答后还剩几个挂起),pendingSummary}(receipt=not-pending 表示你慢了 —— 已被 Web UI 或另一路回答/已超时, 先答者胜)。⚠️ 安全提示: 这个工具等于远程提权按钮, 部署在非 loopback 地址时必须配置 authToken。", {
		approvalId: z.string().describe("approval_list 返回的 approvals[].approvalId"),
		sessionId: z.string().describe("发起审批的会话 id(必须与 approval_list 里同一行的 sessionId 完全一致, 否则会被拒绝)"),
		outcome: z.enum(["allowed-once", "rejected"]).describe("allowed-once=仅本次调用放行(最常用); rejected=拒绝该操作")
	}, async ({ approvalId, sessionId, outcome }) => {
		try {
			const bad = validateArgs("approval_respond", {
				approvalId,
				sessionId,
				outcome
			}, [
				{
					name: "approvalId",
					type: "string",
					required: true
				},
				{
					name: "sessionId",
					type: "string",
					required: true
				},
				{
					name: "outcome",
					type: "string",
					required: true
				}
			]);
			if (bad) return out(JSON.stringify({ error: bad }));
			const entry = pendingApprovals.get(approvalId);
			if (!entry) return out(JSON.stringify({
				ok: false,
				receipt: "not-pending",
				approvalId,
				pendingRemaining: pendingApprovals.size,
				pendingSummary: `当前还有 ${pendingApprovals.size} 个审批挂起`,
				note: "不存在/已被回答/已超时(先答者胜)",
				next: "重新调 approval_list 获取最新的 approvalId —— 该条目已被别处(Web UI/另一路调用)处理或超时"
			}));
			if (entry.sessionId !== sessionId) return out(JSON.stringify({
				ok: false,
				error: errText("sessionId mismatch", approvalId, `该审批属于会话 ${entry.sessionId}`, "用属于该审批的 sessionId 重试; 见 approval_list"),
				pendingRemaining: pendingApprovals.size
			}));
			const r = await respondToApproval(ctx, entry, outcome);
			const remaining = pendingApprovals.size;
			return out(JSON.stringify({
				ok: r.accepted,
				receipt: r.accepted ? "accepted" : r.reason ?? "not-pending",
				approvalId,
				sessionId,
				outcome,
				pendingRemaining: remaining,
				pendingSummary: remaining > 0 ? `回答后仍有 ${remaining} 个审批挂起; 用 approval_list 查看并继续回答` : "回答后已无挂起审批(当前挂起数: 0)",
				...r.accepted ? { next: "已放行; 原本挂起的 agent_run/task_inbox 会继续跑, 稍后用 task_result 或等待 agent_run 返回" } : { next: "未生效(已被别处回答或超时); 用 approval_list 确认当前状态" }
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `${toolFailure("approval_respond", e)} (先 approval_list 刷新审批列表再重试)` }));
		}
	});
	mcp.tool("agent_run", "【同步执行】发任务 → 阻塞等结果 → 一次拿到完整产出。适合 < 5 分钟的任务(改代码、分析、跑命令)。什么时候选它而不是 task_inbox: 任务短、你想在这一个调用里直接拿到 changes/verification, 或者需要把长任务分多轮投喂(传 sessionId 续接同一会话)。什么时候别用: 任务可能要跑很久、或你希望中途能取消 —— 那种用 task_inbox(异步队列)+ task_result 轮询。返回结构化结果 {taskId,sessionId,assistantText,changes,verification,leftovers,toolCalls,toolResults,stats,...}; 有会话可续时结果顶部会带 next 提示。若产出提到写入了文件但没给绝对路径, 会额外附 landing.hint/likelyDir 指明常见落点(本次沙箱 cwd), 拿到后用 fs_list/fs_stat 可定位。注意: 若 agent 请求提权, 本调用会一直阻塞到有人回答审批(用 approval_list/approval_respond 回答), 超时按拒绝收尾, 绝不自动放行。", {
		task: z.string().describe("要 Harness 执行的自然语言任务(写清楚目标与验收标准, agent 会照此干活)"),
		context: z.string().optional().describe("记忆/上下文, 注入给 agent 参考(来自你之前的对话/笔记)"),
		cwd: z.string().optional().describe(`工作目录; 不传 = ${defaultCwdHint()}`),
		sessionId: z.string().optional().describe("续接已有会话的 id(来自上次 agent_run/task_inbox 结果的 sessionId 字段); 不传 = 新建会话。长任务分多轮投喂就靠它"),
		title: z.string().optional().describe("新会话的标题(只对新建会话生效, 便于之后在 session_list 里认出来)"),
		preset: z.string().optional().describe("本次任务的 preset 覆盖(合法 id 见 preset_list); 只影响新建/resume, 已有会话保持原 preset"),
		sandbox: z.enum(SANDBOX_MODES).optional().describe("本次任务的文件权限档: read-only 只读 | workspace-write 工作区可写(默认) | danger-full-access 无审批任意读写(仅限可信环境); 只影响新建/resume, 已有会话保持原档(要改已有会话用 set_policy)")
	}, async ({ task, context, cwd, sessionId, title, preset, sandbox }) => {
		const badArgs = validateArgs("agent_run", {
			task,
			context,
			cwd,
			sessionId,
			title,
			preset,
			sandbox
		}, [
			{
				name: "task",
				type: "string",
				required: true
			},
			{
				name: "context",
				type: "string"
			},
			{
				name: "cwd",
				type: "string"
			},
			{
				name: "sessionId",
				type: "string"
			},
			{
				name: "title",
				type: "string"
			},
			{
				name: "preset",
				type: "string"
			},
			{
				name: "sandbox",
				type: "string"
			}
		]);
		if (badArgs) return out(JSON.stringify({ error: badArgs }));
		if (preset) {
			const bad = await presetOverrideError(ctx, preset);
			if (bad) return out(JSON.stringify({ error: bad }));
		}
		if (sandbox !== void 0 && !SANDBOX_MODES.includes(sandbox)) return out(JSON.stringify({ error: `invalid sandbox "${sandbox}"; valid modes: ${SANDBOX_MODES.join("|")}` }));
		const result = await executeTask(ctx, task, context ?? "", cwd ?? defaultTaskCwd(), sessionId, title, {
			...preset ? { preset } : {},
			...sandbox !== void 0 ? { sandbox } : {}
		});
		const truncated = truncateResult(result);
		const landing = fileLandingHint(result, cwd ?? defaultTaskCwd());
		return out(JSON.stringify({
			...sessionId !== void 0 && sessionId !== "" ? { next: `已续接会话; ${HINT.resumeSession}` } : { next: `续接此会话时传 sessionId=${String(result.sessionId)} (${HINT.resumeSession})` },
			...landing !== void 0 ? { landing } : {},
			...truncated
		}, null, 2));
	});
	mcp.tool("task_inbox", "【异步队列】把任务丢进队列立刻返回 taskId(不阻塞), 之后自己轮询取结果。适合长任务、或可能需要中途取消的任务。什么时候选它而不是 agent_run: ① 任务可能跑超过 5 分钟(避免 HTTP 调用超时) ② 你想同时推多个任务并行跑 ③ 你希望保留随时取消的能力(task_cancel)。典型流程: task_inbox 拿 taskId → 用 task_result(taskId=...) 轮询 status/result(建议 5~15s 一次, 别高频空转) → done 后取 changes/verification; 中途想停用 task_cancel。v0.8.0 新增主动回调: 传可选 callback{url, secret?, replyContext?, events?, method?, headers?, timeoutMs?} 后, 任务进入终态(done/error/cancelled)时会向你指定的端点 HTTP POST 一条 JSON 回执(event=task:<status>, 含 result 与 replyContext 原样透传), 带 X-DSH-Signature(HMAC-SHA256, 签名材料 \"<X-DSH-Timestamp>.<body>\")与 X-DSH-Timestamp 头供验签防伪造; 2xx 视为已投递, 失败/超时仅记录不重试、绝不影响任务本身。目标只允许 http/https, 私网/回环/云 metadata 地址默认拒绝(内网网关用部署配置 allowedCallbackHosts 放行)。不传 callback = 与旧版完全一致(纯轮询模式)。返回 {taskId,status:\"queued\",createdAt(ISO8601),createdAt_epoch,retain,retainMs,notify?,pollAdvice,next}。看队列全貌用 task_list; 任务卡在审批上时用 approval_list → approval_respond 放行。", {
		task: z.string().describe("要执行的任务内容(写清楚目标与验收标准)"),
		context: z.string().optional().describe("记忆/上下文, 随任务注入给 agent(这是喂记忆的主入口)"),
		cwd: z.string().optional().describe(`工作目录; 不传 = ${defaultCwdHint()}`),
		sessionId: z.string().optional().describe("续接已有会话的 id(来自上次 agent_run/task_inbox 结果); 不传 = 新建会话"),
		title: z.string().optional().describe("新会话的标题(只对新建会话生效, 便于 session_list 归档识别)"),
		preset: z.string().optional().describe("本次任务的 preset 覆盖(合法 id 见 preset_list); 只影响新建/resume"),
		sandbox: z.enum(SANDBOX_MODES).optional().describe("本次任务的文件权限档: read-only | workspace-write(默认) | danger-full-access(仅限可信环境); 只影响新建/resume"),
		callback: callbackSchema.optional().describe("任务终态主动回调(可选): 任务 done/error/cancelled 后向 url POST 签名 JSON 回执(replyContext 原样透传, X-DSH-Signature HMAC-SHA256 防伪造); 仅 http/https, 私网/metadata 默认拒绝; 不传 = 纯轮询模式, 行为与旧版完全一致")
	}, async ({ task, context, cwd, sessionId, title, preset, sandbox, callback }) => {
		const badArgs = validateArgs("task_inbox", {
			task,
			context,
			cwd,
			sessionId,
			title,
			preset,
			sandbox,
			callback
		}, [
			{
				name: "task",
				type: "string",
				required: true
			},
			{
				name: "context",
				type: "string"
			},
			{
				name: "cwd",
				type: "string"
			},
			{
				name: "sessionId",
				type: "string"
			},
			{
				name: "title",
				type: "string"
			},
			{
				name: "preset",
				type: "string"
			},
			{
				name: "sandbox",
				type: "string"
			},
			{
				name: "callback",
				type: "object"
			}
		]);
		if (badArgs) return out(JSON.stringify({ error: badArgs }));
		if (preset) {
			const bad = await presetOverrideError(ctx, preset);
			if (bad) return out(JSON.stringify({ error: bad }));
		}
		if (sandbox !== void 0 && !SANDBOX_MODES.includes(sandbox)) return out(JSON.stringify({ error: `invalid sandbox "${sandbox}"; valid modes: ${SANDBOX_MODES.join("|")}` }));
		const cbResolved = resolveCallback(callback);
		if (cbResolved.error) return out(JSON.stringify({ error: cbResolved.error }));
		const now = Date.now();
		for (const [tid, t] of taskQueue) if ((t.status === "done" || t.status === "error" || t.status === "cancelled") && t.finishedAt && now - t.finishedAt > runtimeConfig.taskTtlMs) taskQueue.delete(tid);
		let active = 0;
		for (const t of taskQueue.values()) if (t.status === "queued" || t.status === "running") active++;
		if (active >= runtimeConfig.maxQueue) return out(JSON.stringify({ error: `task queue full (${active}/${runtimeConfig.maxQueue})` }));
		const id = randomUUID();
		const item = {
			id,
			task,
			context: context ?? "",
			cwd: cwd ?? defaultTaskCwd(),
			status: "queued",
			createdAt: now,
			...sessionId ? { sessionId } : {},
			...title ? { title } : {},
			...preset ? { preset } : {},
			...sandbox !== void 0 ? { sandbox } : {},
			...cbResolved.config !== void 0 ? { callback: cbResolved.config } : {}
		};
		taskQueue.set(id, item);
		(async () => {
			item.status = "running";
			try {
				item.result = await executeTask(ctx, item.task, item.context, item.cwd, item.sessionId, item.title, {
					...item.preset ? { preset: item.preset } : {},
					...item.sandbox !== void 0 ? { sandbox: item.sandbox } : {},
					onSessionStart: (sid) => {
						taskRunSessions.set(id, sid);
					},
					isCancelled: () => item.cancelled === true
				});
				item.result.taskId = id;
				item.status = "done";
			} catch (e) {
				item.error = String(e);
				item.status = "error";
			}
			taskRunSessions.delete(id);
			if (item.cancelled) {
				item.status = "cancelled";
				delete item.result;
				delete item.error;
			}
			item.finishedAt = Date.now();
			dispatchTaskCallback(item);
		})();
		return out(JSON.stringify({
			taskId: id,
			status: "queued",
			retainMs: runtimeConfig.taskTtlMs,
			retain: formatDuration(runtimeConfig.taskTtlMs),
			createdAt: humanTime(now)?.at,
			createdAt_epoch: now,
			...cbResolved.config !== void 0 ? { notify: {
				enabled: true,
				urlHost: hostOfCallbackUrl(cbResolved.config.url),
				events: cbResolved.config.events,
				signed: cbResolved.signed === true,
				...cbResolved.source !== void 0 ? { source: cbResolved.source } : {},
				...cbResolved.signed !== true ? { unsignedReason: "no secret provided (callback.secret 与部署级 defaultCallbackSecret 均未配置); 接收方无法验签, 建议配置 secret" } : {}
			} } : {},
			pollAdvice: `建议每 5~15s 轮询一次, 别高频空转; 完成后 ${formatDuration(runtimeConfig.taskTtlMs) ?? "10m"} 内取走结果, 过期会被清理`,
			next: `用 task_result(taskId="${id}") 轮询结果(建议 5~15s 一次); 队列全貌用 task_list; 想中途取消用 task_cancel(taskId="${id}")`
		}));
	});
	mcp.tool("task_result", "取回 task_inbox 提交的任务当前结果(这是异步链路的第二半: task_inbox 拿 taskId → 用本工具轮询)。什么时候用: task_inbox 返回 taskId 之后; 或 agent_run 场景外想确认某个后台任务好了没。返回 {taskId,status,error,result,createdAt(ISO8601),createdAt_epoch,finishedAt(ISO8601),finishedAt_epoch,waited,notify?,landing?}(status ∈ queued|running|done|error|cancelled; result 仅 done 时有, 含 changes/verification/leftovers/assistantText/toolCalls 等)。若结果提到写入了文件却没给绝对路径, 会额外附 landing.hint 指向沙箱 cwd(常见落点)。notify 是任务终态主动回调的投递状态(仅提交时传了 callback 才有): delivered=回执已被接收端 2xx 确认; failed=投递失败(看 lastError, 不影响任务本身); skipped=未订阅该事件或回调被部署配置关闭。轮询建议: running 时等几秒再问, 别高频空转; status=done 即可停。任务不见了(task not found)通常是已过期(默认保留 10 分钟)或被取消。看队列全貌用 task_list。", { taskId: z.string().describe("task_inbox 返回的 taskId(也可从 task_list 的 tasks[].id 取)") }, async ({ taskId }) => {
		try {
			const bad = validateArgs("task_result", { taskId }, [{
				name: "taskId",
				type: "string",
				required: true
			}]);
			if (bad) return out(JSON.stringify({ error: bad }));
			const item = taskQueue.get(taskId);
			if (!item) return out(JSON.stringify({ error: taskNotFoundError(taskId) }));
			const done = item.status === "done";
			const landing = item.result ? fileLandingHint(item.result, item.cwd) : void 0;
			return out(JSON.stringify({
				taskId: item.id,
				status: item.status,
				error: item.error,
				...timeFields("createdAt", item.createdAt),
				...item.finishedAt !== void 0 ? timeFields("finishedAt", item.finishedAt) : {},
				...item.finishedAt !== void 0 ? {
					waitedMs: item.finishedAt - item.createdAt,
					waited: formatDuration(item.finishedAt - item.createdAt)
				} : {},
				result: item.result ? truncateResult(item.result) : void 0,
				...item.callback !== void 0 ? { notify: { ...item.notify } } : {},
				...landing !== void 0 ? { landing } : {},
				...done ? { next: item.result?.sessionId ? `任务完成; ${HINT.resumeSession}` : "任务完成" } : item.status === "running" || item.status === "queued" ? { next: `仍在${item.status === "running" ? "执行" : "排队"}; 稍后再次调用本工具取结果(建议 5~15s 一次); 卡在审批上可先看 approval_list` } : item.status === "error" ? { next: "任务失败; 看 error 字段定位原因 —— 常见是权限不足(用 policy_get 查档位)或会话失效(用 session_list 确认)" } : { next: "任务已取消, 结果已丢弃; 需要的话重新用 task_inbox 提交" }
			}, null, 2));
		} catch (e) {
			return out(JSON.stringify({ error: toolFailure("task_result", e) }));
		}
	});
	mcp.tool("task_list", "看异步任务队列的全貌(有哪些排队/在跑/已完成的)。什么时候用: ① task_result 报 task not found, 来这里确认是不是已过期 ② 不记得 taskId 了, 按标题/cwd 找 ③ 确认没有僵尸任务在跑。与 status_get 的区别: 这里列出每一条任务明细, status_get 只给一个 queueActive 总数。返回 {total,active,count,offset,limit,truncated,next?,tasks:[{id,status,createdAt(ISO8601),createdAt_epoch,finishedAt(ISO8601),finishedAt_epoch,waited?,error?,title?,preset?,sandbox?,cwd,sessionId?,hasResult,notify?}]}(新任务在前, 默认最多 20 条, 超 20 条用 offset/limit 翻页; status ∈ queued|running|done|error|cancelled; notify 仅提交时传了 callback 的任务才有, 见 task_result 说明)。取具体结果用 task_result(taskId=...)。", { ...pageArgSchema }, async ({ offset, limit }) => {
		try {
			const bad = validateArgs("task_list", {
				offset,
				limit
			}, [{
				name: "offset",
				type: "number"
			}, {
				name: "limit",
				type: "number"
			}]);
			if (bad) return out(JSON.stringify({ error: bad }));
			const all = [...taskQueue.values()].sort((a, b) => b.createdAt - a.createdAt);
			const active = all.filter((t) => t.status === "queued" || t.status === "running").length;
			const { offset: off, limit: lim } = parsePage(offset, limit, LIST_PAGE_DEFAULT);
			const { page, meta } = pageEnvelope(all, off, lim, "task_list");
			const tasks = page.map((t) => ({
				id: t.id,
				status: t.status,
				...timeFields("createdAt", t.createdAt),
				...t.finishedAt !== void 0 ? timeFields("finishedAt", t.finishedAt) : {},
				...t.finishedAt !== void 0 ? {
					waitedMs: t.finishedAt - t.createdAt,
					waited: formatDuration(t.finishedAt - t.createdAt)
				} : {},
				...t.error !== void 0 ? { error: t.error } : {},
				...t.title ? { title: t.title } : {},
				...t.preset ? { preset: t.preset } : {},
				...t.sandbox !== void 0 ? { sandbox: t.sandbox } : {},
				cwd: t.cwd,
				...t.sessionId ? { sessionId: t.sessionId } : {},
				hasResult: Boolean(t.result),
				...t.callback !== void 0 ? { notify: { ...t.notify } } : {}
			}));
			return out(JSON.stringify({
				total: meta.total,
				active,
				count: tasks.length,
				offset: meta.offset,
				limit: meta.limit,
				truncated: meta.truncated,
				...meta.next !== void 0 ? { next: meta.next } : {},
				tasks
			}, null, 2));
		} catch (e) {
			return out(JSON.stringify({ error: toolFailure("task_list", e) }));
		}
	});
	mcp.tool("task_cancel", "取消一个还在排队或正在跑的异步任务(这是 task_inbox 相对 agent_run 的核心优势)。什么时候用: 发现任务方向错了 / 不想等了 / 要腾出队列名额。行为: queued(还在排队)=直接出队; running(正在跑)=尽力中止(结果丢弃, 但会话保留, 之后还能用那个 sessionId 续接); 已完成/已失败/已取消/不存在=明确报错(不可取消)。返回 {ok,status:\"cancelled\",was,taskId,sessionId?,note}。取消后想看队列现状用 task_list。", { taskId: z.string().describe("task_inbox 返回的 taskId(也可从 task_list 取)") }, async ({ taskId }) => {
		try {
			const bad = validateArgs("task_cancel", { taskId }, [{
				name: "taskId",
				type: "string",
				required: true
			}]);
			if (bad) return out(JSON.stringify({ error: bad }));
			const item = taskQueue.get(taskId);
			if (!item) return out(JSON.stringify({
				ok: false,
				error: `task ${taskId} not cancellable (status=missing) (用 task_list 查看当前队列 —— 该任务可能已过期清理)`
			}));
			if (item.status === "queued") {
				item.status = "cancelled";
				taskQueue.delete(taskId);
				return out(JSON.stringify({
					ok: true,
					status: "cancelled",
					was: "queued",
					taskId,
					next: "已出队; 需要的话重新用 task_inbox 提交新任务"
				}));
			}
			if (item.status === "running") {
				const sid = taskRunSessions.get(taskId);
				let agent;
				if (sid) try {
					agent = ctx.agents.get(SessionId(sid));
				} catch {
					agent = void 0;
				}
				if (!sid || !agent?.cancel) {
					if (sid === void 0) {
						item.cancelled = true;
						return out(JSON.stringify({
							ok: true,
							status: "cancelled",
							was: "running",
							taskId,
							note: "agent not started yet; will be cancelled at cooperative checkpoint",
							next: "取消将在协作检查点生效; 用 task_list 确认最终状态"
						}));
					}
					return out(JSON.stringify({
						ok: false,
						error: "task running; no abort API",
						hint: "等待完成或 sessionId 续接接管",
						next: "该任务已起 agent 但拿不到中止句柄; 等它跑完(用 task_result 轮询), 或拿到 sessionId 后用 agent_run 接管该会话"
					}));
				}
				item.cancelled = true;
				try {
					agent.cancel({ kind: "user" });
				} catch (e) {
					degrade("agents.cancel", "agent.cancel() 抛错, task_cancel 未能真正中止运行中的任务(该方法不在宿主类型契约内)", e);
					delete item.cancelled;
					return out(JSON.stringify({
						ok: false,
						error: toolFailure("task_cancel", e),
						hint: "等待完成或 sessionId 续接接管",
						next: "重试 task_cancel, 或等任务自然结束"
					}));
				}
				return out(JSON.stringify({
					ok: true,
					status: "cancelled",
					was: "running",
					taskId,
					sessionId: sid,
					note: "abort requested; result will be discarded",
					next: sid ? `会话已保留; ${HINT.resumeSession}` : "结果将被丢弃"
				}));
			}
			return out(JSON.stringify({
				ok: false,
				error: `task ${taskId} not cancellable (status=${item.status})`,
				next: "该任务已处于终态, 无需取消; 用 task_result(taskId=...) 取结果, 或 task_list 看队列现状"
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `${toolFailure("task_cancel", e)} (用 task_list 确认 taskId 与状态)` }));
		}
	});
	mcp.tool("rename_session", "给一个已有会话改标题(纯整理, 不影响会话内容或能力)。什么时候用: agent_run/task_inbox 建的会话越来越多, 想按用途命名便于日后在 session_list 里一眼认出、或让 session_search 更好命中。注意: 只能改当前 live 的会话(冷会话会报 session not found —— 先跑一轮让它活起来)。返回 {ok,sessionId,title}。改完用 session_list 确认。", {
		sessionId: z.string().describe("要改名的会话 id(来自 session_list 或 agent_run/task_inbox 结果)"),
		title: z.string().describe("新标题(建议写清用途, 便于日后检索)")
	}, async ({ sessionId, title }) => {
		try {
			const bad = validateArgs("rename_session", {
				sessionId,
				title
			}, [{
				name: "sessionId",
				type: "string",
				required: true
			}, {
				name: "title",
				type: "string",
				required: true
			}]);
			if (bad) return out(JSON.stringify({ error: bad }));
			const session = ctx.get("sessions")?.get?.(sessionId);
			if (!session) return out(JSON.stringify({ error: sessionNotFoundError(sessionId, "本工具只能改 live 会话 —— 若该会话是冷的, 先用 agent_run(task=..., sessionId=...) 唤醒它再改名; 用 session_list 查看当前会话列表确认 id 拼写") }));
			const st = ctx.get("sessionTitle");
			if (!st?.rename) return out(JSON.stringify({ error: "sessionTitle service unavailable (该 dsh 部署未加载会话标题服务, 无法改名; 不影响其他功能)" }));
			const snapshot = st.rename(session, title);
			return out(JSON.stringify({
				ok: true,
				sessionId,
				title: snapshot?.title ?? title
			}));
		} catch (e) {
			return out(JSON.stringify({ error: toolFailure("rename_session", e) }));
		}
	});
	mcp.tool("attach_session", "把一个会话归组到它的工作区下(纯整理操作, 让 dsh Web UI 的工作区侧栏能正确归类)。什么时候用: 会话出现在\"未分组\"里、或 agent_run 建的会话没自动归到期望的工作区。path 不传 = 用该会话 header 里的 cwd。硬性要求: 目标目录必须真实存在, 且 realpath(header.cwd) 必须与工作区路径精确相等, 否则官方 attachSession 会拒绝(这是官方强校验, 本插件无法绕过)。返回 {sessionId,workspaceId,workspacePath,attached}(attached=false 表示本来就在该工作区下)。本插件只做整理, 不改会话内容。", {
		sessionId: z.string().describe("要归组的会话 id(live 或已持久化都可以; 来自 session_list)"),
		path: z.string().optional().describe("目标工作区目录(不传 = 用会话 header 里的 cwd; 必须是已存在的目录)")
	}, async ({ sessionId, path }) => {
		const bad = validateArgs("attach_session", {
			sessionId,
			path
		}, [{
			name: "sessionId",
			type: "string",
			required: true
		}, {
			name: "path",
			type: "string"
		}]);
		if (bad) return out(JSON.stringify({ error: bad }));
		const sid = SessionId(sessionId);
		const header = await findSessionHeader(ctx, sid);
		if (header === void 0) return out(JSON.stringify({ error: `${sessionNotFoundError(sessionId)} (live 与持久化里都没找到)` }));
		const target = path ?? header.cwd;
		if (target === void 0) return out(JSON.stringify({ error: `session ${sessionId} 的 header 没有 cwd, 官方 attachSession 无法校验, 不能归组 (请显式传 path=目标工作区目录)` }));
		try {
			const ws = await ensureWorkspace(ctx, await realpath(target));
			if (!ws?.attachSession) return out(JSON.stringify({ error: "workspaceRegistry unavailable (该部署未加载工作区注册表服务, 无法归组; 不影响任务执行)" }));
			if (ws.sessionIds.includes(sid)) return out(JSON.stringify({
				sessionId,
				workspaceId: ws.id,
				workspacePath: ws.path,
				attached: false,
				note: "already attached"
			}));
			await ws.attachSession(sid);
			return out(JSON.stringify({
				sessionId,
				workspaceId: ws.id,
				workspacePath: ws.path,
				attached: true
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `${toolFailure("attach_session", e)} (确认 path 目录真实存在; 且 realpath(会话 cwd) 必须与该目录完全相等 —— 不一致时官方会拒绝)` }));
		}
	});
}
/**
* 插件入口: 启动 MCP server(StreamableHTTP, 跨网), 通过 ctx 桥接 Harness 能力。
*/
async function apply(ctx, config = {}) {
	Object.assign(runtimeConfig, runtimeConfigDefaults());
	providerExplicitlyConfigured = Boolean(config.provider);
	providerCheck = void 0;
	if (config.provider) runtimeConfig.provider = config.provider;
	if (config.model) runtimeConfig.model = config.model;
	if (config.preset) runtimeConfig.preset = config.preset;
	if (config.maxQueue !== void 0) runtimeConfig.maxQueue = config.maxQueue;
	if (config.taskTtlMs !== void 0) runtimeConfig.taskTtlMs = config.taskTtlMs;
	if (config.maxAgents !== void 0) runtimeConfig.maxAgents = config.maxAgents;
	if (config.authToken) runtimeConfig.authToken = config.authToken;
	if (config.workspaceRoots) runtimeConfig.workspaceRoots = config.workspaceRoots;
	if (config.enableFsWrite !== void 0) runtimeConfig.enableFsWrite = config.enableFsWrite;
	if (config.defaultSandbox !== void 0) {
		if (SANDBOX_MODES.includes(config.defaultSandbox)) runtimeConfig.defaultSandbox = config.defaultSandbox;
		else console.warn(`[harness-mcp-server] invalid defaultSandbox "${config.defaultSandbox}", keep default "${runtimeConfig.defaultSandbox}" (valid: ${SANDBOX_MODES.join("|")})`);
	}
	if (config.approvalsBridge !== void 0) {
		if (config.approvalsBridge === "web" || config.approvalsBridge === "builtin" || config.approvalsBridge === "off" || config.approvalsBridge === "file-push") runtimeConfig.approvalsBridge = config.approvalsBridge;
		else console.warn(`[harness-mcp-server] invalid approvalsBridge "${String(config.approvalsBridge)}", keep default "web" (valid: web|builtin|file-push|off)`);
	}
	if (config.approvalTimeoutMs !== void 0 && Number.isFinite(config.approvalTimeoutMs) && config.approvalTimeoutMs > 0) runtimeConfig.approvalTimeoutMs = Math.trunc(config.approvalTimeoutMs);
	if (config.approvalFileDir !== void 0 && typeof config.approvalFileDir === "string" && config.approvalFileDir.trim()) runtimeConfig.approvalFileDir = config.approvalFileDir;
	if (config.notifyEnabled !== void 0) {
		if (typeof config.notifyEnabled === "boolean") runtimeConfig.notifyEnabled = config.notifyEnabled;
		else console.warn(`[harness-mcp-server] invalid notifyEnabled ${String(config.notifyEnabled)}, keep default true (expected boolean)`);
	}
	if (config.defaultCallbackSecret !== void 0) {
		if (typeof config.defaultCallbackSecret === "string") runtimeConfig.defaultCallbackSecret = config.defaultCallbackSecret;
		else console.warn("[harness-mcp-server] invalid defaultCallbackSecret, keep default \"\" (expected string)");
	}
	if (config.allowedCallbackHosts !== void 0) {
		if (Array.isArray(config.allowedCallbackHosts) && config.allowedCallbackHosts.every((h) => typeof h === "string")) runtimeConfig.allowedCallbackHosts = [...config.allowedCallbackHosts];
		else console.warn("[harness-mcp-server] invalid allowedCallbackHosts, keep default [] (expected string[])");
	}
	if (config.callbackPreset !== void 0) {
		const p = normalizeCallbackPreset(config.callbackPreset);
		if (p === void 0) console.warn("[harness-mcp-server] invalid callbackPreset, keep unset (expected object {url?,method?,headers?,events?,replyContext?,timeoutMs?,autoApply?,requireReplyRoute?})");
		else runtimeConfig.callbackPreset = p;
	}
	if (config.questionCallback !== void 0) {
		const q = normalizeCallbackPreset(config.questionCallback);
		if (q === void 0 || q.url === void 0 || q.url === "") console.warn("[harness-mcp-server] invalid questionCallback, keep unset (expected object with url)");
		else runtimeConfig.questionCallback = q;
	}
	const port = config.port ?? 8090;
	const host = config.host ?? "127.0.0.1";
	serverRuntime.port = port;
	serverRuntime.host = host;
	serverRuntime.startedAt = Date.now();
	resetDegradations();
	console.log("[harness-mcp-server] apply called, port=", port);
	probeProviderDefault(ctx);
	const contractReport = probeHostContract({
		ctx,
		symbols: {
			createUserMessage,
			SessionId,
			scopeOf
		}
	});
	if (contractReport.missingRequired.length > 0) {
		console.error("[harness-mcp-server] ⛔ 宿主契约缺失(必需):", contractReport.missingRequired);
		console.error("   → 本次升级可能引入破坏性变更。已降级运行, 功能可能不完整。");
		console.error(`   → 契约清单见 src/contract.ts; 用 node scripts/contract_probe.mjs 落盘基线并 diff。`);
		degrade("contract", "required 宿主契约缺失", contractReport.missingRequired.join(", "));
	}
	if (contractReport.missingOptional.length > 0) console.warn("[harness-mcp-server] ⚠️ 可选宿主能力缺失(已降级):", contractReport.missingOptional);
	runtimeConfig.contract = contractReport;
	const servers = /* @__PURE__ */ new Map();
	const transports = /* @__PURE__ */ new Map();
	const server = http.createServer(async (req, res) => {
		if (runtimeConfig.authToken) {
			if (req.headers["authorization"] !== `Bearer ${runtimeConfig.authToken}`) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32001,
						message: "Unauthorized"
					},
					id: null
				}));
				return;
			}
		}
		const sessionId = req.headers["mcp-session-id"] ?? void 0;
		const existing = sessionId ? transports.get(sessionId) : void 0;
		if (existing) {
			if (req.method === "GET" || req.method === "POST" || req.method === "DELETE") {
				await existing.handleRequest(req, res);
				return;
			}
			res.writeHead(405, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: {
					code: -32600,
					message: "Method not allowed"
				},
				id: null
			}));
			return;
		}
		if (req.method === "POST" && !sessionId) {
			const mcp = new McpServer({
				name: "harness",
				version: PLUGIN_VERSION
			});
			registerTools(mcp, ctx);
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (sid) => {
					transports.set(sid, transport);
					servers.set(sid, mcp);
				}
			});
			transport.onclose = () => {
				const sid = transport.sessionId;
				if (sid) {
					transports.delete(sid);
					servers.delete(sid);
				}
			};
			await mcp.connect(transport);
			await transport.handleRequest(req, res);
			return;
		}
		if (sessionId) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: {
					code: -32001,
					message: "Session not found"
				},
				id: null
			}));
			return;
		}
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			jsonrpc: "2.0",
			error: {
				code: -32600,
				message: "Invalid request"
			},
			id: null
		}));
	});
	server.listen(port, host, () => {
		console.log(`[harness-mcp-server] MCP server listening on ${host}:${port}`);
	});
	server.on("error", (e) => {
		console.error("[harness-mcp-server] HTTP server error:", e.message);
	});
	(async () => {
		try {
			const r = await reattachOrphanSessions(ctx);
			console.log(`[harness-mcp-server] 存量捞回完成: attached=${r.attached} failed=${r.failed}`);
		} catch (e) {
			console.warn("[harness-mcp-server] 存量捞回异常:", e?.message ?? e);
		}
	})();
	const stopApprovalsBridge = startApprovalsBridge(ctx);
	ctx.effect(() => {
		return () => {
			server.close();
			stopApprovalsBridge();
			transports.clear();
			servers.clear();
			liveAgents.clear();
			sessionToCwd.clear();
			agentLocks.clear();
			taskQueue.clear();
			taskRunSessions.clear();
			lastAgentSessionId = void 0;
		};
	}, "harness-mcp-server");
}
/** 测试专用内部通道(mock 测试直接操纵队列状态, 绕开异步时序; 非公开 API) */
const __internals = {
	taskQueue,
	taskRunSessions,
	pendingApprovals,
	get activeBridgeKind() {
		return activeBridgeKind;
	},
	errText,
	missingParamError,
	idNotFoundError,
	emptySessionError,
	sessionNotFoundError,
	isDshServiceDown,
	toolFailure,
	validateArgs,
	humanTime,
	timeFields,
	formatBytes,
	formatDuration,
	parsePage,
	pageEnvelope,
	fileLandingHint,
	extractAbsPaths,
	SESSION_LOG_MAX_EVENTS,
	LIST_PAGE_DEFAULT,
	LIST_PAGE_MAX,
	ssrfGuardCheck,
	resolveCallback,
	buildCallbackPayload,
	signCallbackPayload,
	safeEqualStr,
	hostOfCallbackUrl,
	mergeReplyContext,
	mergeCallbackHeaders,
	sanitizeCallbackHeaders,
	findLiteralTemplateValue,
	hasReplyRouteField,
	normalizeCallbackPreset,
	describeCallbackPreset,
	listCorpus,
	projectDirNameOf,
	batchUpdatedAt,
	SESSION_LIST_INSPECT_CONCURRENCY,
	SESSION_LIST_INSPECT_TIMEOUT_MS,
	degrade,
	probeHostContract,
	HOST_CONTRACT,
	degradationsSnapshot,
	resetDegradations,
	warnOnEmptyRun,
	get contractReport() {
		return runtimeConfig.contract;
	},
	probeProviderDefault,
	get providerCheck() {
		return providerCheck;
	},
	DEFAULT_PROVIDER_ID,
	fsReadOffsetNote,
	INDEX_FALLBACK_HINT,
	pendingQuestions,
	makeUserQuestionAnswerer,
	QUESTION_ANSWER_TIMEOUT_MS,
	handleQuestionAnswerFile,
	cleanupQuestionFiles,
	questionFileDir,
	get approvalBridgeFilesForTest() {
		return approvalBridgeFiles;
	},
	set approvalBridgeFilesForTest(v) {
		approvalBridgeFiles = v;
	},
	detectBoilerplateKeys,
	noiseKey,
	NOISE_MIN_SAMPLE,
	NOISE_MIN_RATIO,
	VERSION: PLUGIN_VERSION
};

//#endregion
export { __internals, apply, degrade, inject, name };
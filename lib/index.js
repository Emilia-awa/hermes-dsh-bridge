import { z } from "zod";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { isTokenDelta } from "@deepseek-ai/dsh-llm/message";
import { SessionId } from "@deepseek-ai/dsh-session";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

//#region src/index.ts
/** Cordis 插件名 */
const name = "harness-mcp-server";
/** 插件版本(status_get 上报; 与 package.json 保持同步) */
const PLUGIN_VERSION = "0.5.0";
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
	"sessions",
	"apiProxy"
];
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
	approvalTimeoutMs: 12e4
});
/** 运行时配置(apply 时从 config 初始化, 提供安全默认值) */
const runtimeConfig = runtimeConfigDefaults();
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
const SESSION_LIST_MAX_ROWS = 50;
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
		sandbox: effectiveSandbox
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
			source: {
				kind: "plugin",
				plugin: "harness-mcp-server"
			}
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
		if (disposeAfter) {
			try {
				await ctx.get("sessions")?.flush?.(handle.agent.session);
			} catch {}
			try {
				await handle.dispose();
			} catch {}
		}
		return result;
	});
}
const taskQueue = /* @__PURE__ */ new Map();
/** B: 执行中任务 → agent 会话 id(task_cancel 用它定位要中止的 Agent; executeTask onSessionStart 登记) */
const taskRunSessions = /* @__PURE__ */ new Map();
/** 找会话 header: live 优先, 其次持久化 list(轻量元数据扫描, 不加载整日志) */
async function findSessionHeader(ctx, sessionId) {
	const live = ctx.get("sessions")?.get?.(sessionId);
	if (live !== void 0) return live.header;
	const persistence = ctx.get("sessionPersistence");
	for (const header of await persistence?.list?.() ?? []) if (header.id === sessionId) return header;
}
/** live + 持久化 header 合并(live 优先), 按 id 去重(session_list / 存量捞回 / session_search 共用) */
async function listMergedHeaders(ctx) {
	const headers = /* @__PURE__ */ new Map();
	const store = ctx.get("sessions");
	for (const s of store?.list?.() ?? []) headers.set(s.header.id, s.header);
	const persistence = ctx.get("sessionPersistence");
	for (const h of await persistence?.list?.() ?? []) if (!headers.has(h.id)) headers.set(h.id, h);
	return headers;
}
/** 从事件流里取最新 session/title 事件的标题(live/persisted 通用的只读扫描) */
function titleFromEvents(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e?.type === "session/title" && typeof e.data?.title === "string" && e.data.title) return e.data.title;
	}
}
/** 从事件流解析会话实际运行的 preset: 最后一条 agent-preset/selected 优先, 其次 header.agentPreset(resolveSessionPreset 同款语义) */
function presetFromEvents(header, events) {
	if (header === void 0) return void 0;
	try {
		return resolveSessionPreset({
			header,
			events
		});
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
/** 取 apiProxy(强转结构视图; 纯 headless 组合没有该服务时返回 undefined) */
function apiProxyOf(ctx) {
	return ctx.apiProxy;
}
/** 内存挂起审批表(approvalId 键 —— ApprovalRequestId 全局唯一) */
const pendingApprovals = /* @__PURE__ */ new Map();
/** 当前生效的审批桥形态(status_get/approval_list 上报) */
let activeBridgeKind = "off";
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
		}).catch(() => {});
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
		console.warn("[harness-mcp-server] approval respond failed:", e?.message ?? e);
		return {
			accepted: false,
			reason: "not-pending"
		};
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
				if (!controller.signal.aborted) console.warn("[harness-mcp-server] approvals mux stream ended:", e?.message ?? e);
			}
		})();
		return () => {
			controller.abort();
			for (const entry of [...pendingApprovals.values()]) clearApprovalTimer(entry);
			pendingApprovals.clear();
			activeBridgeKind = "off";
		};
	}
	activeBridgeKind = "builtin";
	ctx.on("approval/request", (req, next) => {
		if (req.signal?.aborted === true) return Promise.resolve("cancelled");
		const sess = req.agent?.session;
		const events = sess?.events ?? sess?.log ?? [];
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
		if (approvalId === void 0) return next();
		return new Promise((resolve) => {
			armPendingApproval(ctx, {
				approvalId,
				sessionId: String(sess?.id ?? ""),
				toolName: typeof req.toolName === "string" ? req.toolName : "?",
				...req.callId !== void 0 ? { callId: String(req.callId) } : {},
				...req.reason !== void 0 ? { reason: String(req.reason) } : {},
				requestedAt: Date.now(),
				settle: resolve
			});
		});
	});
	return () => {
		for (const entry of [...pendingApprovals.values()]) clearApprovalTimer(entry);
		pendingApprovals.clear();
		activeBridgeKind = "off";
	};
}
/** 会话粗粒度 updatedAt: live 取最后事件 time, persisted 取落盘文件 mtime, 都没有用 createdAt */
async function roughUpdatedAt(ctx, header) {
	const log = (ctx.get("sessions")?.get?.(header.id))?.log;
	if (log && log.length > 0) {
		const t = Number(log[log.length - 1]?.time);
		if (Number.isFinite(t) && t > 0) return t;
	}
	const loc = ctx.get("sessionPersistence")?.locate?.(header);
	if (loc?.path) try {
		return (await stat(loc.path)).mtimeMs;
	} catch {}
	return header.createdAt ?? 0;
}
/** 单个会话的轻量检视: 消息条数 + 标题 + 统计摘要 + 权限档(persisted inspect 失败时回退 live log) */
async function inspectSessionRow(ctx, header) {
	const persistence = ctx.get("sessionPersistence");
	try {
		const insp = await persistence?.inspect?.(SessionId(header.id));
		if (insp) return summarizeRow(insp.events.length, titleFromEvents(insp.events), insp.events);
	} catch {}
	const live = ctx.get("sessions")?.get?.(SessionId(header.id));
	if (live?.log) return summarizeRow(live.log.length, titleFromEvents(live.log), live.log);
	return { messageCount: 0 };
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
				if (openStep.firstTokenTime === null && cd !== void 0 && isTokenDelta(cd)) openStep.firstTokenTime = t;
				break;
			}
			case "assistant/message": {
				if (openStep === null || openStep.turn !== Number(d.turn) || openStep.step !== Number(d.step)) break;
				s.llmMs += Math.max(0, t - openStep.startTime);
				if (openStep.firstTokenTime !== null) {
					s.ttftMs += Math.max(0, openStep.firstTokenTime - openStep.startTime);
					s.ttftSteps += 1;
					const out1 = usageNum(d.usage?.outputTokens);
					if (out1 > 0) {
						s.decodeMs += Math.max(0, t - openStep.firstTokenTime);
						s.decodeTokens += out1;
					}
				}
				const u = d.usage;
				if (u && typeof u === "object") {
					s.inputTokens += usageNum(u.inputTokens);
					s.outputTokens += usageNum(u.outputTokens);
					s.cacheReadTokens += usageNum(u.cacheReadTokens);
					s.cacheWriteTokens += usageNum(u.cacheWriteTokens);
					s.reasoningTokens += usageNum(u.reasoningTokens);
				}
				openStep = null;
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
		ttft: s.ttftSteps > 0 ? Math.round(s.ttftMs / s.ttftSteps) : null,
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
/** 单会话内容搜索的读取时限(毫秒) */
const SESSION_SEARCH_TIMEOUT_MS = 2e3;
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
* 读单会话事件流(session_search 用): persistence.inspect(带 AbortSignal+限时, 已解压事件)
* → live log → locate(path) 落盘文件多帧 zstd 兜底。都不可得返回 undefined。
*/
async function readSessionEventsSearch(ctx, header) {
	const sid = SessionId(header.id);
	const persistence = ctx.get("sessionPersistence");
	if (persistence?.inspect) try {
		const insp = await withTimeout(persistence.inspect(sid, AbortSignal.timeout(SESSION_SEARCH_TIMEOUT_MS)), 2500);
		if (insp) return {
			events: [...insp.events],
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
* 收集一个会话的完整事件流(persisted inspect 优先, 回退 live store 日志)。
* 返回 undefined 表示 live 与持久化里都没有该会话。
*/
async function collectSessionEvents(ctx, sid) {
	const persistence = ctx.get("sessionPersistence");
	try {
		const insp = await persistence?.inspect?.(sid);
		if (insp && insp.events.length > 0) return {
			events: [...insp.events],
			source: "persisted"
		};
	} catch {}
	const live = ctx.get("sessions")?.get?.(sid);
	if (live?.log && live.log.length > 0) return {
		events: [...live.log],
		source: "live"
	};
	try {
		if (await persistence?.inspect?.(sid)) return {
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
		time: ev.time
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
	const headers = await listMergedHeaders(ctx);
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
	mcp.tool("echo", "回显输入, 验证 MCP server 连通", { text: z.string() }, async ({ text }) => {
		return out(`收到: ${text} @ ${Date.now()}`);
	});
	mcp.tool("harness_list_tools", "列出 Harness 当前注册的所有工具名", {}, async () => {
		const tools = ctx.tools;
		const names = tools && typeof tools.keys === "function" ? Array.from(tools.keys()) : [];
		return out(JSON.stringify(names));
	});
	mcp.tool("status_get", "查询 Harness/MCP 运行状态: 版本/运行时长/provider/model/preset/活动会话数/sandboxPolicy(默认权限档+审批桥形态+挂起审批数)。", {}, async () => {
		let queueActive = 0;
		for (const t of taskQueue.values()) if (t.status === "queued" || t.status === "running") queueActive++;
		let agentsLive = 0;
		try {
			agentsLive = ctx.agents.list().length;
		} catch {
			agentsLive = 0;
		}
		return out(JSON.stringify({
			version: PLUGIN_VERSION,
			uptimeSec: Math.round(process.uptime()),
			startedAt: serverRuntime.startedAt,
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
			node: process.version,
			pid: process.pid
		}, null, 2));
	});
	mcp.tool("config_get", "查询插件运行时配置摘要(authToken 打码为 ***, 不泄露密钥)。", {}, async () => {
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
			authTokenSet: Boolean(runtimeConfig.authToken),
			authToken: runtimeConfig.authToken ? "***" : "",
			workspaceRoots: runtimeConfig.workspaceRoots,
			enableFsWrite: runtimeConfig.enableFsWrite,
			defaultSandbox: runtimeConfig.defaultSandbox,
			approvalsBridge: runtimeConfig.approvalsBridge,
			approvalTimeoutMs: runtimeConfig.approvalTimeoutMs
		}, null, 2));
	});
	mcp.tool("fs_read", "读文本文件(仅限 ~/.dsh 与工作区白名单内; 拒绝 .ssh/.env/*token*/*.pem)。返回 {path,totalLines,content,truncated}。", {
		path: z.string().describe("绝对路径(会 realpath 规范化)"),
		offset: z.number().int().min(1).optional().describe("起始行(1-based, 默认 1)"),
		limit: z.number().int().min(1).max(2e3).optional().describe("最多返回行数(默认 400)")
	}, async ({ path, offset, limit }) => {
		try {
			const gate = await gateFsPath(ctx, path);
			if (gate.error) return out(JSON.stringify({ error: gate.error }));
			const canonical = gate.canonical;
			const st = await stat(canonical).catch(() => void 0);
			if (!st) return out(JSON.stringify({ error: `path not found: ${path}` }));
			if (st.isDirectory()) return out(JSON.stringify({ error: `is a directory, use fs_list: ${canonical}` }));
			if (st.size > FS_READ_MAX_FILE_BYTES) return out(JSON.stringify({ error: `file too large (${st.size} bytes > ${FS_READ_MAX_FILE_BYTES})` }));
			const lines = (await readFile(canonical, "utf8")).split("\n");
			if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
			const totalLines = lines.length;
			const off = Math.max(1, Math.trunc(offset ?? 1));
			const lim = Math.min(Math.max(1, Math.trunc(limit ?? 400)), 2e3);
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
				content
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `fs_read failed: ${e?.message ?? String(e)}` }));
		}
	});
	mcp.tool("fs_list", "列目录(递归 depth 层, 默认 1)。敏感项(.ssh/.env/*token*/*.pem)从结果隐藏。返回 {path,entries:[{name,type,size,mtime}],truncated}。", {
		path: z.string().describe("目录绝对路径"),
		depth: z.number().int().min(1).max(5).optional().describe("递归层数(默认 1, 最大 5)")
	}, async ({ path, depth }) => {
		try {
			const gate = await gateFsPath(ctx, path);
			if (gate.error) return out(JSON.stringify({ error: gate.error }));
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
					let mtime;
					try {
						const s = await stat(full);
						size = s.size;
						mtime = Math.round(s.mtimeMs);
					} catch {}
					entries.push({
						name: full.slice(root.length + 1) || de.name,
						type,
						size,
						mtime
					});
					if (de.isDirectory() && level < maxDepth) await walk(full, level + 1);
				}
			};
			await walk(root, 1);
			return out(JSON.stringify({
				path: root,
				depth: maxDepth,
				count: entries.length,
				truncated,
				entries
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `fs_list failed: ${e?.message ?? String(e)}` }));
		}
	});
	mcp.tool("fs_stat", "查文件/目录元数据(同受路径安全策略约束)。返回 {exists,size,mtime,isDir,...}。", { path: z.string().describe("绝对路径") }, async ({ path }) => {
		try {
			const gate = await gateFsPathSoft(ctx, path);
			if (gate.error) return out(JSON.stringify({ error: gate.error }));
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
				size: st.size,
				mtime: Math.round(st.mtimeMs),
				isDir: st.isDirectory(),
				isFile: st.isFile()
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `fs_stat failed: ${e?.message ?? String(e)}` }));
		}
	});
	if (runtimeConfig.enableFsWrite) mcp.tool("fs_write", "写文本文件(P1, opt-in)。仅限 workspaceRoots 白名单内(路径 jail), 拒绝 .ssh/.env/*token*/*.pem。mode: overwrite(默认)|append|create-new。", {
		path: z.string().describe("文件绝对路径(可不存在, 父目录自动创建)"),
		content: z.string().describe("要写入的 UTF-8 文本(上限 4MB)"),
		mode: z.enum([
			"overwrite",
			"append",
			"create-new"
		]).optional().describe("写入模式(默认 overwrite; create-new 在已存在时报错)")
	}, async ({ path, content, mode }) => {
		try {
			const m = mode ?? "overwrite";
			const bytes = Buffer.byteLength(content, "utf8");
			if (bytes > FS_WRITE_MAX_BYTES) return out(JSON.stringify({ error: `content too large (${bytes} bytes > ${FS_WRITE_MAX_BYTES})` }));
			const gate = await gateFsWritePath(path);
			if (gate.error) return out(JSON.stringify({ error: gate.error }));
			const canonical = gate.canonical;
			if (m === "create-new") {
				if (await stat(canonical).then(() => true, () => false)) return out(JSON.stringify({ error: `file already exists (mode=create-new): ${canonical}` }));
			}
			await mkdir(dirname(canonical), { recursive: true });
			if (m === "append") await appendFile(canonical, content, "utf8");
			else await writeFile(canonical, content, "utf8");
			return out(JSON.stringify({
				ok: true,
				path: canonical,
				bytes,
				mode: m
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `fs_write failed: ${e?.message ?? String(e)}` }));
		}
	});
	mcp.tool("session_list", "列出会话(live+持久化合并): [{id,title,cwd,updatedAt,messageCount,inputTokens,outputTokens,llmTime}]。cwd 可按工作区过滤。", {
		cwd: z.string().optional().describe("按工作目录过滤(realpath 规范化后精确匹配)"),
		limit: z.number().int().min(1).max(SESSION_LIST_MAX_ROWS).optional().describe("返回条数上限(默认 20)")
	}, async ({ cwd, limit }) => {
		try {
			const max = Math.min(Math.max(1, Math.trunc(limit ?? 20)), SESSION_LIST_MAX_ROWS);
			let rows = [...(await listMergedHeaders(ctx)).values()];
			if (cwd) {
				const target = await canonicalCwd(resolve(cwd));
				const filtered = [];
				for (const h of rows) {
					if (h.cwd === void 0) continue;
					if (await canonicalCwd(h.cwd) === target) filtered.push(h);
				}
				rows = filtered;
			}
			const withRough = await Promise.all(rows.map(async (h) => ({
				h,
				at: await roughUpdatedAt(ctx, h)
			})));
			withRough.sort((a, b) => b.at - a.at);
			const selected = withRough.slice(0, max);
			const sessions = await Promise.all(selected.map(async ({ h, at }) => {
				const detail = await inspectSessionRow(ctx, h);
				return {
					id: h.id,
					title: detail.title ?? `(untitled ${String(h.id).slice(0, 8)})`,
					cwd: h.cwd,
					createdAt: h.createdAt,
					updatedAt: Math.round(at),
					messageCount: detail.messageCount,
					inputTokens: detail.inputTokens ?? 0,
					outputTokens: detail.outputTokens ?? 0,
					llmTime: detail.llmTimeSec ?? 0,
					...detail.sandboxMode !== void 0 ? { sandboxMode: detail.sandboxMode } : {}
				};
			}));
			sessions.sort((a, b) => b.updatedAt - a.updatedAt);
			return out(JSON.stringify({
				total: rows.length,
				count: sessions.length,
				truncated: rows.length > sessions.length,
				sessions
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `session_list failed: ${e?.message ?? String(e)}` }));
		}
	});
	mcp.tool("session_log", "读会话日志(stripReasoning 已剥离 thinking/reasoning 块)。tail 取最后 N 条; types 过滤事件类型。", {
		sessionId: z.string().describe("会话 id(live 或已持久化)"),
		tail: z.number().int().min(1).max(500).optional().describe("取最后 N 条匹配事件(默认 50)"),
		types: z.array(z.string()).optional().describe("事件类型过滤(默认 user/message,assistant/message,tool/call,tool/result)")
	}, async ({ sessionId, tail, types }) => {
		try {
			const sid = SessionId(sessionId);
			let meta;
			let events = [];
			const persistence = ctx.get("sessionPersistence");
			try {
				const insp = await persistence?.inspect?.(sid);
				if (insp) {
					meta = insp.meta;
					events = [...insp.events];
				}
			} catch {}
			if (events.length === 0) {
				const live = ctx.get("sessions")?.get?.(sid);
				if (live) {
					meta = live.header ?? meta;
					events = live.log ?? [];
				}
			}
			if (meta === void 0 && events.length === 0) return out(JSON.stringify({ error: `session not found: ${sessionId}` }));
			const wanted = types && types.length > 0 ? types : DEFAULT_LOG_TYPES;
			const filtered = events.filter((e) => wanted.includes(e?.type ?? ""));
			const totalMatched = filtered.length;
			const n = Math.min(Math.max(1, Math.trunc(tail ?? 50)), 500);
			const sliced = filtered.slice(-n);
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
			const truncated = shown < sliced.length || totalMatched > shown;
			return out(JSON.stringify({
				sessionId,
				header: meta ? {
					cwd: meta.cwd,
					createdAt: meta.createdAt,
					preset: presetFromEvents(meta, events)
				} : void 0,
				types: wanted,
				totalMatched,
				shown,
				truncated,
				events: records
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `session_log failed: ${e?.message ?? String(e)}` }));
		}
	});
	mcp.tool("session_stats", "会话统计(rounds/steps/llmTime/toolTime/ttft/tokensPerSec/cacheHitRate/inputTokens/outputTokens)。无 sessionId 返回当前 Agent 会话(最近一次 agent_run/task 的会话); 有 sessionId 返回指定会话的全会话累计。", { sessionId: z.string().optional().describe("会话 id(缺省 = 当前 Agent 会话)") }, async ({ sessionId }) => {
		try {
			let target = sessionId;
			let source;
			if (!target) {
				if (lastAgentSessionId === void 0) return out(JSON.stringify({ error: "no active agent session yet (run agent_run first, or pass sessionId)" }));
				target = lastAgentSessionId;
			}
			const found = await collectSessionEvents(ctx, SessionId(target));
			if (found === void 0) return out(JSON.stringify({ error: `session not found: ${target}` }));
			source = found.source;
			const stats = presentSessionStats(foldSessionStats(found.events), {
				scope: "session",
				sessionId: target
			});
			return out(JSON.stringify({
				...stats,
				source
			}, null, 2));
		} catch (e) {
			return out(JSON.stringify({ error: `session_stats failed: ${e?.message ?? String(e)}` }));
		}
	});
	mcp.tool("session_search", "跨会话搜索: 标题匹配 + 尽力内容搜索(持久化事件, 单会话 2s 超时跳过)。返回 {query,regex,total,count,content_search,results:[{sessionId,title,cwd,updatedAt,matched,snippet?}]}(≤20 条)。", {
		query: z.string().min(1).describe("搜索词(regex=false 时为大小写不敏感子串)"),
		cwd: z.string().optional().describe("按工作目录过滤(realpath 规范化后精确匹配)"),
		regex: z.boolean().optional().describe("把 query 当正则(默认 false)"),
		limit: z.number().int().min(1).max(200).optional().describe("最多扫描最近 N 个会话(默认 50)")
	}, async ({ query, cwd, regex, limit }) => {
		try {
			if (!query || !query.trim()) return out(JSON.stringify({ error: "query must not be empty" }));
			let re;
			if (regex) try {
				re = new RegExp(query);
			} catch (e) {
				return out(JSON.stringify({ error: `invalid regex: ${e?.message ?? String(e)}` }));
			}
			const needle = query.toLowerCase();
			const maxScan = Math.min(Math.max(1, Math.trunc(limit ?? 50)), 200);
			let rows = [...(await listMergedHeaders(ctx)).values()];
			if (cwd) {
				const target = await canonicalCwd(resolve(cwd));
				const filtered = [];
				for (const h of rows) {
					if (h.cwd === void 0) continue;
					if (await canonicalCwd(h.cwd) === target) filtered.push(h);
				}
				rows = filtered;
			}
			const withRough = await Promise.all(rows.map(async (h) => ({
				h,
				at: await roughUpdatedAt(ctx, h)
			})));
			withRough.sort((a, b) => b.at - a.at);
			const scanned = withRough.slice(0, maxScan);
			const hits = [];
			let contentSearched = false;
			const queue = [...scanned];
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
			return out(JSON.stringify({
				query,
				regex: Boolean(regex),
				total: scanned.length,
				count: hits.length,
				truncated: hits.length > 20,
				content_search: contentSearched,
				results: hits.slice(0, 20)
			}, null, 2));
		} catch (e) {
			return out(JSON.stringify({ error: `session_search failed: ${e?.message ?? String(e)}` }));
		}
	});
	mcp.tool("preset_list", "列出可用 agent preset(standard/code/minimal/cordis 及本地自研)与默认 preset。", {}, async () => {
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
		} catch {}
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
	mcp.tool("preset_get", "查询会话实际运行的 preset(header.agentPreset + agent-preset/selected 事件最新者胜); 无 sessionId 时返回默认 preset。", { sessionId: z.string().optional().describe("要查询的会话 id(缺省返回默认 preset)") }, async ({ sessionId }) => {
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
			const persistence = ctx.get("sessionPersistence");
			try {
				const insp = await persistence?.inspect?.(sid);
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
				note: `session ${sessionId} 无 preset 记录(不存在或未记录), 返回默认值`
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
	mcp.tool("preset_set", "切换 agent preset。scope=new-default(默认): 更新运行时默认 preset(本服务新建会话生效 + 尽力写全局用户默认)。scope=session: 切换指定会话的 preset, 仅空白会话(未开始任何 turn)可切换, 非空白报错。", {
		presetId: z.string().describe("目标 preset id(见 preset_list)"),
		scope: z.enum(["new-default", "session"]).optional().describe("切换范围(默认 new-default)"),
		sessionId: z.string().optional().describe("scope=session 时的目标会话 id")
	}, async ({ presetId, scope, sessionId }) => {
		const kind = scope ?? "new-default";
		try {
			if (kind === "session") {
				if (!sessionId) return out(JSON.stringify({ error: "scope=session requires sessionId" }));
				const sid = SessionId(sessionId);
				const found = await collectSessionEvents(ctx, sid);
				if (found === void 0) return out(JSON.stringify({ error: `session not found: ${sessionId}` }));
				if (found.events.some((e) => e?.type === "turn/start")) return out(JSON.stringify({ error: `session ${sessionId} has already started; its agent preset is fixed (only blank sessions can switch)` }));
				let live;
				try {
					live = ctx.agents.get(sid);
				} catch {
					live = void 0;
				}
				if (live) try {
					const preset = await ctx.agentPresets.recompose(live.ctx, presetId);
					live.session.append("agent-preset/selected", { agentPreset: preset.id });
					return out(JSON.stringify({
						ok: true,
						scope: "session",
						sessionId,
						preset: preset.id,
						source: "live"
					}));
				} catch (e) {
					return out(JSON.stringify({ error: `preset switch failed: ${e?.message ?? String(e)}` }));
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
					return out(JSON.stringify({ error: `failed to resume blank session ${sessionId}: ${e?.message ?? String(e)}` }));
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
					source: "resumed"
				}));
			}
			try {
				await ctx.agentPresets.resolve(presetId);
			} catch (e) {
				return out(JSON.stringify({ error: `unknown preset "${presetId}": ${e?.message ?? String(e)}` }));
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
			return out(JSON.stringify({ error: `preset_set failed: ${e?.message ?? String(e)}` }));
		}
	});
	mcp.tool("policy_get", "查询会话生效策略: {sessionId,sandboxMode,source:override|default,workspaceRoot,approvalPolicy}。sandboxMode 取最后一条 sandbox/mode 事件(无则 defaultSandbox); approvalPolicy 取最后一条 approval/policy(无则部署默认)。无 sessionId 返回部署默认。", { sessionId: z.string().optional().describe("会话 id(缺省返回部署默认档)") }, async ({ sessionId }) => {
		try {
			if (!sessionId) return out(JSON.stringify({
				sandboxMode: runtimeConfig.defaultSandbox,
				source: "default",
				workspaceRoot: process.cwd(),
				approvalPolicy: deploymentApprovalPolicy(ctx)
			}, null, 2));
			const sid = SessionId(sessionId);
			const found = await collectSessionEvents(ctx, sid);
			if (found === void 0) return out(JSON.stringify({ error: `session not found: ${sessionId}` }));
			const override = sandboxModeFromEvents(found.events);
			const header = await findSessionHeader(ctx, sid);
			return out(JSON.stringify({
				sessionId,
				sandboxMode: override ?? runtimeConfig.defaultSandbox,
				source: override !== void 0 ? "override" : "default",
				workspaceRoot: header?.cwd !== void 0 ? await canonicalCwd(header.cwd) : process.cwd(),
				approvalPolicy: approvalPolicyFromEvents(found.events) ?? deploymentApprovalPolicy(ctx)
			}, null, 2));
		} catch (e) {
			return out(JSON.stringify({ error: `policy_get failed: ${e?.message ?? String(e)}` }));
		}
	});
	mcp.tool("set_policy", "切换已存在会话的文件权限档。mode: read-only(只读)|workspace-write(工作区可写)|danger-full-access(完全绕过围栏+bash 解禁, 无审批任意读写, 仅限可信环境)。仅 live 会话可切(追加 sandbox/mode 事件, 下一次受限调用生效, 重启靠 replay 保持); 冷会话需先 resume(agent_run/task_inbox 带该 sessionId 跑一轮)再切。", {
		sessionId: z.string().describe("目标会话 id"),
		mode: z.enum(SANDBOX_MODES).describe("目标权限档")
	}, async ({ sessionId, mode }) => {
		try {
			const sid = SessionId(sessionId);
			let target;
			try {
				target = ctx.agents.get(sid)?.session;
			} catch {
				target = void 0;
			}
			if (!target?.append) {
				const attached = ctx.get("sessions")?.get?.(sid);
				if (attached?.append) target = attached;
			}
			if (!target?.append) return out(JSON.stringify({ error: `session ${sessionId} is not live; cold/persisted sessions must be resumed first (run agent_run or task_inbox with this sessionId), then set_policy` }));
			appendSandboxMode(target, mode);
			return out(JSON.stringify({
				ok: true,
				sessionId,
				sandboxMode: mode,
				source: "live"
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `set_policy failed: ${e?.message ?? String(e)}` }));
		}
	});
	mcp.tool("approval_list", "列出当前挂起的审批(如沙箱提档 escalation): [{approvalId,sessionId,toolName,callId?,reason?,requestedAt,waitedMs}]。配合 approval_respond 回答; 审批未决期间 agent_run/task_inbox 会一直挂起(超时由 approvalTimeoutMs 兜底收尾, 绝不超时放行)。", {}, async () => {
		const now = Date.now();
		const approvals = [...pendingApprovals.values()].map((e) => ({
			approvalId: e.approvalId,
			sessionId: e.sessionId,
			toolName: e.toolName,
			...e.callId !== void 0 ? { callId: e.callId } : {},
			...e.reason !== void 0 ? { reason: e.reason } : {},
			requestedAt: e.requestedAt,
			waitedMs: now - e.requestedAt
		}));
		return out(JSON.stringify({
			bridge: activeBridgeKind,
			count: approvals.length,
			timeoutMs: runtimeConfig.approvalTimeoutMs,
			approvals
		}, null, 2));
	});
	mcp.tool("approval_respond", "回答挂起审批: outcome=allowed-once(仅本次调用放行)|rejected(拒绝)。与 Web UI 双通道先答者胜 —— 已被回答/超时/撤销的审批回 receipt=not-pending。⚠️ 这等于远程提权按钮: MCP server 暴露非 loopback 时必须开 authToken。", {
		approvalId: z.string().describe("approval_list 返回的审批 id"),
		sessionId: z.string().describe("发起审批的会话 id(须与审批归属一致)"),
		outcome: z.enum(["allowed-once", "rejected"]).describe("allowed-once=本次放行; rejected=拒绝")
	}, async ({ approvalId, sessionId, outcome }) => {
		try {
			const entry = pendingApprovals.get(approvalId);
			if (!entry) return out(JSON.stringify({
				ok: false,
				receipt: "not-pending",
				approvalId,
				note: "不存在/已被回答/已超时(先答者胜)"
			}));
			if (entry.sessionId !== sessionId) return out(JSON.stringify({
				ok: false,
				error: `sessionId mismatch: approval ${approvalId} belongs to session ${entry.sessionId}`
			}));
			const r = await respondToApproval(ctx, entry, outcome);
			return out(JSON.stringify({
				ok: r.accepted,
				receipt: r.accepted ? "accepted" : r.reason ?? "not-pending",
				approvalId,
				sessionId,
				outcome
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `approval_respond failed: ${e?.message ?? String(e)}` }));
		}
	});
	mcp.tool("agent_run", "同步执行任务(改代码/分析/跑命令), 返回结构化结果。可传 sessionId 续接已有会话(长任务分多轮投喂)。需要提档审批(escalation)时会挂起等待审批 —— 审批未决期间本调用阻塞, 可用 approval_list/approval_respond 回答, 超时(approvalTimeoutMs)收尾为取消, 绝不超时放行; 长阻塞场景建议改用 task_inbox。", {
		task: z.string().describe("要 Harness 执行的自然语言任务"),
		context: z.string().optional().describe("Hermes 记忆/上下文, 注入给 agent 参考"),
		cwd: z.string().optional().describe("工作目录(默认当前)"),
		sessionId: z.string().optional().describe("续接已有会话的 sessionId(来自上次 agent_run 结果里的 sessionId 字段)"),
		title: z.string().optional().describe("新会话的标题(创建时命名, 便于会话列表归档)"),
		preset: z.string().optional().describe("本次任务的 preset 覆盖(见 preset_list); 仅影响新建/resume 的会话组合, 已有会话保持原 preset"),
		sandbox: z.enum(SANDBOX_MODES).optional().describe("本次任务的文件权限三档覆盖: read-only|workspace-write|danger-full-access; 仅影响新建/resume 的会话组合, 已有会话保持原档位(切换用 set_policy); danger-full-access=无审批任意读写, 仅限可信环境")
	}, async ({ task, context, cwd, sessionId, title, preset, sandbox }) => {
		if (preset) {
			const bad = await presetOverrideError(ctx, preset);
			if (bad) return out(JSON.stringify({ error: bad }));
		}
		if (sandbox !== void 0 && !SANDBOX_MODES.includes(sandbox)) return out(JSON.stringify({ error: `invalid sandbox "${sandbox}"; valid modes: ${SANDBOX_MODES.join("|")}` }));
		const result = await executeTask(ctx, task, context ?? "", cwd ?? process.cwd(), sessionId, title, {
			...preset ? { preset } : {},
			...sandbox !== void 0 ? { sandbox } : {}
		});
		return out(JSON.stringify(truncateResult(result), null, 2));
	});
	mcp.tool("task_inbox", "Hermes 把结构化任务(任务+记忆上下文)推入 Harness 队列, 异步执行, 返回 taskId。记忆喂编码的入口。审批转接(P3)的主路径: 任务挂起等审期间轮询 approval_list → approval_respond 即可续跑。", {
		task: z.string().describe("任务内容"),
		context: z.string().optional().describe("Hermes 记忆/上下文, 随任务注入给 agent"),
		cwd: z.string().optional().describe("工作目录"),
		sessionId: z.string().optional().describe("续接已有会话的 sessionId(来自上次 agent_run 结果)"),
		title: z.string().optional().describe("新会话的标题(创建时命名)"),
		preset: z.string().optional().describe("本次任务的 preset 覆盖(见 preset_list); 仅影响新建/resume 的会话组合"),
		sandbox: z.enum(SANDBOX_MODES).optional().describe("本次任务的文件权限三档覆盖: read-only|workspace-write|danger-full-access; 仅影响新建/resume 的会话组合, 已有会话保持原档位")
	}, async ({ task, context, cwd, sessionId, title, preset, sandbox }) => {
		if (preset) {
			const bad = await presetOverrideError(ctx, preset);
			if (bad) return out(JSON.stringify({ error: bad }));
		}
		if (sandbox !== void 0 && !SANDBOX_MODES.includes(sandbox)) return out(JSON.stringify({ error: `invalid sandbox "${sandbox}"; valid modes: ${SANDBOX_MODES.join("|")}` }));
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
			cwd: cwd ?? process.cwd(),
			status: "queued",
			createdAt: now,
			...sessionId ? { sessionId } : {},
			...title ? { title } : {},
			...preset ? { preset } : {},
			...sandbox !== void 0 ? { sandbox } : {}
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
		})();
		return out(JSON.stringify({
			taskId: id,
			status: "queued"
		}));
	});
	mcp.tool("task_result", "取回 task_inbox 提交任务的结构化结果(changes/verification/leftovers)。", { taskId: z.string().describe("task_inbox 返回的 taskId") }, async ({ taskId }) => {
		const item = taskQueue.get(taskId);
		if (!item) return out(JSON.stringify({ error: `task not found: ${taskId}` }));
		return out(JSON.stringify({
			taskId: item.id,
			status: item.status,
			error: item.error,
			result: item.result ? truncateResult(item.result) : void 0
		}, null, 2));
	});
	mcp.tool("task_list", "异步任务队列快照: [{id,status,createdAt,error,...}](新任务在前, 最多 100 条)。status ∈ queued|running|done|error|cancelled。", {}, async () => {
		try {
			const all = [...taskQueue.values()].sort((a, b) => b.createdAt - a.createdAt);
			const active = all.filter((t) => t.status === "queued" || t.status === "running").length;
			const tasks = all.slice(0, 100).map((t) => ({
				id: t.id,
				status: t.status,
				createdAt: t.createdAt,
				...t.finishedAt !== void 0 ? { finishedAt: t.finishedAt } : {},
				...t.error !== void 0 ? { error: t.error } : {},
				...t.title ? { title: t.title } : {},
				...t.preset ? { preset: t.preset } : {},
				...t.sandbox !== void 0 ? { sandbox: t.sandbox } : {},
				cwd: t.cwd,
				...t.sessionId ? { sessionId: t.sessionId } : {},
				hasResult: Boolean(t.result)
			}));
			return out(JSON.stringify({
				total: all.length,
				active,
				count: tasks.length,
				truncated: all.length > tasks.length,
				tasks
			}, null, 2));
		} catch (e) {
			return out(JSON.stringify({ error: `task_list failed: ${e?.message ?? String(e)}` }));
		}
	});
	mcp.tool("task_cancel", "取消 task_inbox 提交的任务。queued: 直接移除; running: 尽力中止(agent.cancel, 结果丢弃, 会话保留可续接; 未起 agent 时在锁内协作取消); done/error/cancelled/不存在: 明确报错不可取消。", { taskId: z.string().describe("task_inbox 返回的 taskId") }, async ({ taskId }) => {
		try {
			const item = taskQueue.get(taskId);
			if (!item) return out(JSON.stringify({
				ok: false,
				error: `task ${taskId} not cancellable (status=missing)`
			}));
			if (item.status === "queued") {
				item.status = "cancelled";
				taskQueue.delete(taskId);
				return out(JSON.stringify({
					ok: true,
					status: "cancelled",
					was: "queued",
					taskId
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
							note: "agent not started yet; will be cancelled at cooperative checkpoint"
						}));
					}
					return out(JSON.stringify({
						ok: false,
						error: "task running; no abort API",
						hint: "等待完成或 sessionId 续接接管"
					}));
				}
				item.cancelled = true;
				try {
					agent.cancel({ kind: "user" });
				} catch (e) {
					delete item.cancelled;
					return out(JSON.stringify({
						ok: false,
						error: `cancel failed: ${e?.message ?? String(e)}`,
						hint: "等待完成或 sessionId 续接接管"
					}));
				}
				return out(JSON.stringify({
					ok: true,
					status: "cancelled",
					was: "running",
					taskId,
					sessionId: sid,
					note: "abort requested; result will be discarded"
				}));
			}
			return out(JSON.stringify({
				ok: false,
				error: `task ${taskId} not cancellable (status=${item.status})`
			}));
		} catch (e) {
			return out(JSON.stringify({ error: `task_cancel failed: ${e?.message ?? String(e)}` }));
		}
	});
	mcp.tool("rename_session", "给已有会话改名(走 sessionTitle 服务的 rename), 便于会话列表归档区分。", {
		sessionId: z.string().describe("要改名的会话 id(来自 agent_run 结果里的 sessionId 字段)"),
		title: z.string().describe("新标题")
	}, async ({ sessionId, title }) => {
		try {
			const session = ctx.get("sessions")?.get?.(sessionId);
			if (!session) return out(JSON.stringify({ error: `session not found: ${sessionId}` }));
			const st = ctx.get("sessionTitle");
			if (!st?.rename) return out(JSON.stringify({ error: "sessionTitle service unavailable" }));
			const snapshot = st.rename(session, title);
			return out(JSON.stringify({
				ok: true,
				sessionId,
				title: snapshot?.title ?? title
			}));
		} catch (e) {
			return out(JSON.stringify({ error: String(e) }));
		}
	});
	mcp.tool("attach_session", "把会话归组到工作区(补给站: 官方 UI 无移动会话功能)。path 缺省用该会话 header 的 cwd; 归组依赖官方 attachSession 的强校验——realpath(header.cwd) 必须与工作区路径精确相等, 不匹配会返回官方报错。", {
		sessionId: z.string().describe("要归组的会话 id(live 或已持久化)"),
		path: z.string().optional().describe("目标工作区目录(缺省: 会话 header 的 cwd)")
	}, async ({ sessionId, path }) => {
		const sid = SessionId(sessionId);
		const header = await findSessionHeader(ctx, sid);
		if (header === void 0) return out(JSON.stringify({ error: `session not found: ${sessionId}(live 与持久化里都没有)` }));
		const target = path ?? header.cwd;
		if (target === void 0) return out(JSON.stringify({ error: `session ${sessionId} 的 header 没有 cwd, 官方 attachSession 无法校验, 不能归组` }));
		try {
			const ws = await ensureWorkspace(ctx, await realpath(target));
			if (!ws?.attachSession) return out(JSON.stringify({ error: "workspaceRegistry unavailable" }));
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
			return out(JSON.stringify({ error: `attach failed: ${e?.message ?? String(e)}` }));
		}
	});
}
/**
* 插件入口: 启动 MCP server(StreamableHTTP, 跨网), 通过 ctx 桥接 Harness 能力。
*/
async function apply(ctx, config = {}) {
	Object.assign(runtimeConfig, runtimeConfigDefaults());
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
		if (config.approvalsBridge === "web" || config.approvalsBridge === "builtin" || config.approvalsBridge === "off") runtimeConfig.approvalsBridge = config.approvalsBridge;
		else console.warn(`[harness-mcp-server] invalid approvalsBridge "${String(config.approvalsBridge)}", keep default "web" (valid: web|builtin|off)`);
	}
	if (config.approvalTimeoutMs !== void 0 && Number.isFinite(config.approvalTimeoutMs) && config.approvalTimeoutMs > 0) runtimeConfig.approvalTimeoutMs = Math.trunc(config.approvalTimeoutMs);
	const port = config.port ?? 8090;
	const host = config.host ?? "127.0.0.1";
	serverRuntime.port = port;
	serverRuntime.host = host;
	serverRuntime.startedAt = Date.now();
	console.log("[harness-mcp-server] apply called, port=", port);
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
	}
};

//#endregion
export { __internals, apply, inject, name };
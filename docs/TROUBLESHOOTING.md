# TROUBLESHOOTING

Real-world pitfalls collected from production use. All internal topology details are removed.

## MCP transport

### `Mcp-Session-Id` must be echoed back
`initialize` returns a `Mcp-Session-Id` header; all subsequent requests on the same session must send it back. Forgetting it creates a new session server-side per request (lost context, orphaned agents).

### SSE responses: take the **last** `data:` event
When `Content-Type: text/event-stream`, notifications are appended after the response. Parsing only the first event returns stale data. Iterate all `data: ` lines, parse each as JSON, keep the last.

### `resp.headers` is not a dict
`urllib`'s `resp.headers` is `http.client.HTTPMessage` — `isinstance(headers, dict)` is always `False`. Check `"text/event-stream" in str(resp.headers.get("Content-Type", ""))` instead. (Bitten once: the streaming branch never matched, JSON parse blew up.)

### JSON control characters in shell arguments
Passing multi-line JSON with real newlines through a shell single-quote breaks `json.loads` (Invalid control character). Generate the JSON with `json.dumps` in Python, or use a helper script that reads task args from a JSON file.

## Agent behavior

### `TRANSPORT: terminated` mid-run (llm provider hiccup)
The stream dies; the session may be half-modified or untouched. **Resume with the same `sessionId`** — the agent remembers where it was. A fresh session re-reads all code and re-analyzes (minutes of tokens wasted). Before resuming, check actual file changes: `find <cwd> -name '*.py' -mmin -N` to phrase the resume prompt correctly.

### Headless long tasks produce no stdout for a long time
dsh agent runs output nothing until the final result — 20-40 min of silence with CPU active is **normal** for multi-file edits. A dead task looks like: CPU ≈ 0% + no file changes + elapsed far beyond the task's scale.

### 8KB `assistantText` truncation
Long results (reviews, checklists) get cut at ~8000 chars — the low-priority items live in the cut tail. Fetch the full text from the session log (`session_log` with `types=["assistant/message"]`) or grep the session file for the final `assistant/message` event.

### `minimal` preset + big task = stream timeouts
Minimal persona with `complete: true` thinking long can trip the provider's idle timeout. For big tasks use `standard` and write every implementation detail into the task description.

## Plugin-specific

### agent 秒退 + 0 token + 无任何报错 — `MessageSourceMap`

**This is the highest-value entry in this file.** The symptom is *total silence*: the call
returns "successfully" but nothing happened, and nothing is logged.

Symptoms — all of the following at once:

- `agent_run` / `task_inbox` returns almost instantly (a real agent run takes seconds to
  minutes) and reports `steps: 1` or similar with **`inTok=0`, `outTok=0`**;
- `assistantText` is empty, `toolCalls` / `toolResults` are empty arrays;
- **no error anywhere** — not in the MCP response, not in `session_log`, not in
  `journalctl -u dsh.service`;
- the session itself is created fine (so `session_list` shows it), it just contains nothing.

Root cause: **dsh 0.1.7 tightened `MessageSourceMap`.** It now accepts only
`user | model | tool | system-prompt` — the official comment states there is *"no shared
catch-all `plugin` kind"*. Code that built a user message as
`createUserMessage({ ..., source: { kind: 'plugin', plugin: '...' } })` (the pre-0.1.7 habit,
still found in older forks) produces a message the host rejects as **invalid**, and the
message is **silently dropped**. The task therefore runs against an empty conversation: the
agent has nothing to do, returns immediately, and consumes zero tokens.

Why there is no error: the injection point is wrapped in `catch (_error) {}` inside the loop's
`kick()`, so the rejection never surfaces. This is a *silent* failure by construction — which
is exactly why it is worth its own entry.

Diagnosis — confirm it is this, and not something else:

```bash
# ① 确认 dsh 版本是 0.1.7 或更高(0.1.5 及以前不会触发)
dsh --version

# ② 确认是"进了会话但没有任何事件", 而不是"任务失败"
#    拿到 sessionId 后看事件流: 真正跑过的会话会有 user/message + assistant/message
python3 examples/hermes_dsh_mcp.py call session_log '{"sessionId":"<id>","preset":"all"}'
#    若 user/message 都不存在 → 注入的 prompt 被丢了, 正是本症状
```

Fix: use the same source kind the official call sites use (`dsh-headless` / `dsh-acp`):

```diff
  createUserMessage({
    content: [{ type: 'text', text: fullTask }],
-   source: { kind: 'plugin', plugin: 'harness-mcp-server' },
+   source: { kind: 'user' },
  })
```

Official releases of this plugin already do this (`src/index.ts`, in `executeTask`). You only
need to act if you **forked the plugin and kept your own `kind: 'plugin'`**, or you are
maintaining a different bridge that injects user messages into a 0.1.7 host.

> Rule of thumb for 0.1.7+: a "successful" agent call that finishes instantly with
> `inTok=0` and no events in the session almost always means *the prompt never entered the
> conversation*. Check the message source kind before anything else.

### dual-package hazard: agent has tools but "all broken" ("嘴炮" agent)
Symptoms: `agent_run` answers with `<tool_calls>` text but `toolCalls`/`toolResults` stay empty; log shows `agent ctx unscoped` / `preset mount skipped` / `Cannot read properties of undefined (reading 'prepare')`.

Root cause: Node ESM loaded the same `@deepseek-ai/*` package twice (plugin's own `node_modules` copy vs Harness's global tree) — module-level `Symbol`s differ between instances, so `scopeOf(agentCtx)` is `undefined` and tools silently fail to register.

Fix (both steps):
1. In the plugin source, never inline `kScope`/`scopeOf` — `import { scopeOf } from "@deepseek-ai/dsh-scope"`.
2. Symlink the plugin's `@deepseek-ai/*` copies to the Harness global tree (commands in README "dual-package hazard" section). Restart Harness.

Whenever dsh is upgraded/reinstalled, the symlinks may be restored to real copies — re-apply.

### Empty `{{model}}` crashes agent assembly
The plugin's default provider is `deepseek-official` with an empty model. Without explicit `provider`/`model` in the patch, agent assembly fails with `prompt variable "{{model}}" has no value`. Always declare both.

### Two global npm trees (dsh upgraded but still old behavior)
`npm i -g` may install into a different prefix than the one systemd/profile symlinks point at. Always verify the **actual** bin.js path under the running service (`systemctl show dsh.service -p ExecStart`), not just `dsh --version`.

### `session_list` / `session_search` appears to hang (large session library)

Symptom: the call does not error, it just never comes back — a 20 s client timeout fires
first. Measured on a 197-session library with the 0.8.1 build: `limit:1` ≈ **13 s**,
`limit:50` ≈ **31 s**.

Two things to know:

1. **It is not a contract failure — it is slowness.** The call does eventually return; the
   client gives up first. There are no errors and `skipped` stays `0`.
2. **It is fixed in `0.9.0`** — see the performance table in the README. After upgrading,
   `limit:1` and `limit:50` are both sub-second on the same library.

If you are stuck on 0.8.1 and cannot upgrade yet, the cost is dominated by *scanning the whole
library*, so narrowing helps only a little:

```jsonc
// 0.8.1 缓解手段: 用 cwd 缩小集合(仍会对该目录下每个会话逐条 stat, 只是行数变少)
{"cwd": "/path/to/one/project", "limit": 5}
```

Root cause on 0.8.1: the sort key came from `sessionPersistence.stat(id)` per row, and in the
JSONL backend `stat()` is **O(number of project directories)** — it re-walks the whole tree on
every call (≈50 ms × N). See `docs/KNOWN_ISSUES.md` for the two upstream limitations this
plugin now works around.

### `session_list` rows have no `messageCount` / token numbers

Not a bug: since `0.9.0` the default is `detail: "brief"`, which returns only
header-derived fields and **does not read session logs** (that is what makes it fast).
Rows carry `tokensAvailable: false` to make the absence explicit rather than reporting a
misleading `0`.

```jsonc
{"detail": "full", "limit": 10}   // 需要 messageCount/inputTokens/outputTokens/llmTime/sandboxMode 时
```

`detail: "full"` reads logs for the selected page only (concurrency 4, 3 s per-session
timeout); a session that times out is counted in `skipped` instead of stalling the call.

## Error message reference

Every user-facing error follows one shape: `<错误>: <关键值> (<原因一句话>; <下一步动作>)`.
The table below is the complete list, with cause and fix.

| 症状 / 错误文案 | 原因 | 修复步骤 |
|---|---|---|
| `agent_run` 返回文本但 `toolCalls` 恒空；agent 只输出 `<tool_calls>` 文本 | **dual-package hazard**：插件自己的 `node_modules` 和 Harness 全局树各有一份 `@deepseek-ai/*`，`Symbol` 不匹配 → `scopeOf` 为 `undefined` → preset 挂载被跳过 | ① 重做 symlink 修复（README quickstart 第 ② 步）② 重启 Harness。**dsh 升级/重装后 symlink 可能被还原，需再跑一次**。日志特征：`agent ctx unscoped (dsh rc.6 bug); preset mount skipped` |
| `prompt variable "{{model}}" has no value` | patch 没写 `provider`/`model`（插件默认 provider 是 `deepseek-official`、model 为空） | 在 patch 的 `config` 里补 `provider: <your-provider-id>` 和 `model: <your-model-id>`，**必须是你的 Harness 里已配置好的**，然后重启 |
| `MISSING_CREDENTIAL: <provider>` | API key 没注入 Harness 进程 env | 在 systemd unit 加 `Environment=<KEY>=...`（或 `EnvironmentFile=`），或 `export` 后重启服务 |
| `Cannot find package '@deepseek-ai/cordis-plugin-include'` | symlink 修复漏了 `cordis-plugin-*`；它们没发布到 npm registry，只存在于 Harness 全局树 | 补做 README quickstart 第 ② 步里的 `cordis-plugin-include` / `cordis-plugin-loader` 两个 symlink |
| 版本号对但行为像旧版 | 系统里有双 npm 全局树，装错树 | `which dsh` + `npm prefix -g` 核对；用 `systemctl show dsh.service -p ExecStart` 看**服务实际启动的** bin.js 路径，统一到那棵树 |
| `session_list failed: Cannot read properties of undefined (reading 'length')` | dsh 0.1.5 改了 `sessionPersistence` 契约（`list()` 返回 snapshot、`inspect()` 移除）；v0.7.0 已修 | 升级到 `hermes-dsh-bridge@0.7.0` 并重启。若仍报，是 `lib/index.js` 陈旧 → `npm run build` 或重装 |
| `tools/list` 只返回很少工具，或缺 `fs_write` | `enableFsWrite` 默认 `false`（fs_write 是 opt-in）；或插件没被加载 | `fs_write` 缺失属正常；其他缺失看 doctor 的 `profile patch 已配置插件` 与 `dsh 已装载插件` 两项 |
| MCP 请求返回 `401 {"message":"Unauthorized"}` | 部署开了 `authToken` 但请求没带 | 请求头加 `Authorization: Bearer ***`，用 `--token` / `DSH_MCP_TOKEN` |
| MCP 请求返回 `404 Session not found` | 用了失效的 `Mcp-Session-Id` | 客户端必须回显 `initialize` 响应头里的 `Mcp-Session-Id`；会话过期就重新 `initialize` |
| `session not found: <id>` | 会话不存在或已清理（`rename_session` 还要求会话是 **live**） | `session_list` 取有效 id；冷会话先 `agent_run(sessionId=...)` 唤醒再改名；`attach_session` 支持 live 或持久化 |
| `session is empty: <key>` | 会话存在但完全没有事件（或该 `cwd` 下没有会话） | 先跑一轮 `agent_run` / `task_inbox` 带上这个 `sessionId`，或去掉 `cwd` 过滤 / 换一个会话 |
| `task not found: <id>` | 任务结果已过 TTL（默认 10 分钟）被清理，或 id 从不存在 | `task_list` 看队列现状；结果要在保留期内取走（`taskTtlMs` 可调大） |
| `unknown preset: <id>` | preset id 不在当前部署名单里 | `preset_list` 拿合法 id；单次任务用 `agent_run(preset=...)` |
| `session has already started: <id>` | `preset_set(scope=session)` 只能改**空白**会话（log 里没出现过 `turn/start`） | 已跑过的会话 preset 已固化 → 改用 `agent_run(preset=...)` 起新会话，或用 `scope=new-default` 改默认 |
| `session <id> is not live; cold/persisted sessions must be resumed first` | `set_policy` 只能改 **live** 会话 | 先 `agent_run(task=..., sessionId=...)` 让它活起来再 `set_policy`；或直接在那一轮用 `sandbox=...` 定档 |
| `path outside allowed roots (~/.dsh + workspaces): <p>` | `fs_*` 路径越过了 path jail | 换到 `workspaceRoots` 内的路径；`config_get` 看允许哪些目录 |
| `path denied by policy (sensitive name): <p>` | 命中敏感名黑名单（`.ssh` / `.env` / 含 `token` / `*.pem`） | 这批路径设计上永不开放，换文件 |
| `file too large: <size>` / `content too large: <size>` | `fs_read` 单文件 > 8MB / `fs_write` 单次 > 4MB | `fs_read` 用 `offset`/`limit` 分段；`fs_write` 拆成多次 `mode=append` |
| `<tool> failed: dsh service unreachable (...)` | `ECONNREFUSED`/`ECONNRESET`/`socket hang up` —— Harness 没起或断了 | `systemctl status dsh.service`，必要时 `systemctl restart dsh.service`，再 `status_get` 确认 |
| `task queue full (N/100)` | 活动任务（queued+running）达到 `maxQueue` | 等任务结束、`task_cancel` 取消一些，或调大 `maxQueue` |
| `receipt=not-pending`（`approval_respond`） | 你慢了：审批已被 Web UI / 另一路回答，或已超时/撤回（**先答者胜**） | `approval_list` 刷新拿最新 `approvalId`；`note` 字段会说明原因 |
| `sessionId mismatch: <approvalId>` | `approval_respond` 的 `sessionId` 与该审批不匹配 | 用 `approval_list` 里**同一行**的 `sessionId` 重试 |
| 审批一直挂起不返回 | 没人在回答；超时前会一直等 | `approval_list` 看 `pending`（>0 就回答）；`status_get.sandboxPolicy.pendingApprovals` 也能一眼看到 |
| `TRANSPORT: terminated` 中途断流 | LLM provider 抖了一下，流断 | **用同一个 `sessionId` 续接**，不要新开会话（新会话会重读所有代码） |
| **agent 秒退 + 0 token + 零报错** | dsh 0.1.7 起 message source 只收 `user\|model\|tool\|system-prompt`；自改代码里若仍是 `kind:'plugin'` 会被静默丢弃 | 改用 `source: { kind: 'user' }`。详见本文档上方同名小节 |
| `session_list` 没有 `messageCount`/token 字段 | 本版默认 `detail: "brief"`，不读会话日志（所以快） | 需要统计就传 `detail: "full"`；`brief` 行的 `tokensAvailable: false` 表示"未计算"，不是 0 |
| `assistantText` 只到 ~8000 字符 | 结果字段有意限长（`assistantText` ≤ 8000，`toolCalls` ≤ 50×2000，`toolResults` ≤ 20×2000） | 用 `session_log(sessionId=..., preset="dialog")` 取完整文本 |
| `rename_session` 报 `sessionTitle service unavailable` | 该部署没加载会话标题服务 | 不影响其他功能；改用 `agent_run(title=...)` 在创建时命名 |
| `workspaceRegistry unavailable` | 该部署没加载工作区注册表服务 | 不影响任务执行；`attach_session`（纯整理）不可用而已 |

## Tests in CI

`tests/unit_mock_p*.mjs`, `tests/unit_callback_p0.mjs` and `tests/unit_mock_r1.mjs` run
standalone (mock ctx, no dsh needed) — `npm test` runs all five. Real-Harness integration
tests run locally only, not in CI.

`npm run test:mutation` runs the R1 mutation check: it deliberately breaks each critical piece
of logic, rebuilds, and asserts the suite goes **red** — a green run after a mutation means
that logic is untested. It restores the source and build output when it finishes.

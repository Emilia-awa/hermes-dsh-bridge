# TOOLS — Full Reference (26 tools)

> **Ground truth**: every parameter table below was checked against the tool's actual
> `zod` schema and its `validateArgs` spec in `src/index.ts`, and the live `tools/list`
> output of a running 0.7.0 server. 25 tools are registered by default; `fs_write` is the
> 26th and only appears when the deployment sets `enableFsWrite: true`.

All tools are MCP tools on the StreamableHTTP server (default `http://127.0.0.1:8090/mcp`).
Every response is JSON; because tool results are returned as MCP text content, the object
is serialized into `content[0].text` (clients must `JSON.parse` it).

**Response conventions (v0.7.0 / R3):**

- Timestamps are ISO8601 in the server's local timezone with an explicit offset
  (e.g. `2024-05-01T12:34:56+08:00`). The original epoch is always preserved next to it as
  `<name>_epoch` / `<name>_at_epoch`.
- Durations and byte counts carry a human-readable form (`8.8s`, `1.5m`, `9.4KB`) while the
  raw value stays in `<name>Ms` / `<name>_bytes` / `bytes_raw` / `uptimeSec`.
- List tools use a uniform pagination envelope: `total` / `count` / `offset` / `limit` /
  `truncated` / `next` (default page 20, max 100).
- Errors are strings shaped `<error>: <key> (<one-line reason>; <next action>)`, built by
  `errText` / `missingParamError` / `idNotFoundError` / `emptySessionError` (see Error codes).
- Every parameterised tool runs `validateArgs` at the entrance (type + required) *before*
  business logic and echoes `expected <type>, got <actual>`.
- Output caps on task results: `assistantText` ≤ 8000 chars, `toolCalls` ≤ 50 × 2000,
  `toolResults` ≤ 20 × 2000. Truncation is per-field, so the JSON always stays valid; use
  `session_log` for the full record.

---

## Task execution

### `agent_run`

Synchronously run a task and return a structured result. Use it for tasks expected to finish
in under ~5 minutes; for long-running or cancellable work use `task_inbox` + `task_result`.

| Param | Type | Req | Notes |
|---|---|---|---|
| `task` | string | ✅ | The instruction. State the goal and acceptance criteria. |
| `context` | string | — | Memory/context injected into the prompt. |
| `cwd` | string | — | Working directory. Default: `workspaceRoots[0]` when configured, else `process.cwd()` — the effective default is spelled out in the live parameter description. |
| `sessionId` | string | — | Resume an existing session (3-level takeover: pool → live → persisted). Omit = new session. |
| `title` | string | — | Title for a newly created session (only affects creation). |
| `preset` | string | — | Per-task preset override; validated up front against `preset_list`. Only affects created/resumed compositions. |
| `sandbox` | enum | — | `read-only` \| `workspace-write` \| `danger-full-access`. Per-task tier override; only affects created/resumed compositions. |

**Returns**: `{ next, landing?, ...result }` where `result` is
`{ taskId, sessionId, assistantText, changes, verification, leftovers, toolCalls, toolResults, stats, sandbox? }`.

- `next` — how to resume this session (`sessionId=...`) or confirmation that it was resumed.
- `landing` — only when the output mentions writing a file but carries no absolute path:
  `{ hint, likelyDir, mentionedWrite, pathsInResult }` pointing at the run's sandbox `cwd`.
- `stats` (run-scoped):
  `{ sessionId, scope: "run", rounds, steps, llmTime, llmTimeMs, toolTime, toolTimeMs, llmTimeHuman, toolTimeHuman, ttft, ttftHuman, ttftSteps, tokensPerSec, cacheHitRate, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }`.
- The request's `sandbox` is echoed back as `result.sandbox` when set.

**Notes**: HTTP timeout 120 s; reasoning/thinking blocks are stripped from `assistantText`.
If the stream dies mid-run (`TRANSPORT: terminated`), **resume with the same `sessionId`**.
If the agent hits a sandbox escalation this call blocks while the approval is pending — poll
`approval_list` and answer via `approval_respond`; after `approvalTimeoutMs` (default
300000 ms) it settles cancelled/rejected, **never auto-allowed**.

### `task_inbox`

Push a task to the async in-memory queue and return immediately.

| Param | Type | Req | Notes |
|---|---|---|---|
| `task` | string | ✅ | Task content; state the goal and acceptance criteria. |
| `context` | string | — | Memory/context; the main channel for feeding memory. |
| `cwd` | string | — | Same default rule as `agent_run`. |
| `sessionId` | string | — | Resume an existing session. |
| `title` | string | — | Title for a newly created session. |
| `preset` | string | — | Per-task preset override (validated pre-enqueue; rejected before it takes a queue slot). |
| `sandbox` | enum | — | Three-tier override, same semantics as `agent_run`. |

**Returns**: `{ taskId, status: "queued", retainMs, retain, createdAt, createdAt_epoch, pollAdvice, next }`.

Queue: max `maxQueue` (default 100) active tasks, TTL `taskTtlMs` (default 10 min),
**lost on restart** — do not queue critical long work through this path. This is the primary
path for approval bridging: while a task is suspended on an approval, poll `approval_list`
→ `approval_respond` and the task resumes on its own.

### `task_result`

| Param | Type | Req | Notes |
|---|---|---|---|
| `taskId` | string | ✅ | From `task_inbox` or `task_list[].id`. |

**Returns**: `{ taskId, status, error?, createdAt, createdAt_epoch, finishedAt?, finishedAt_epoch?, waitedMs?, waited?, result?, landing?, next }`.
`status` ∈ `queued` \| `running` \| `done` \| `error` \| `cancelled`. `result` is only present
when `done`, and is the same truncated structured result as `agent_run` (`result.taskId` is
filled in). `landing` behaves exactly as in `agent_run`. `next` explains what to do for the
current status. A missing id returns `task not found: <id> (已过期或从未存在; 用 task_list
查看当前队列; 任务默认保留 N 分钟)`.

### `task_list`

| Param | Type | Req | Notes |
|---|---|---|---|
| `offset` | number | — | Page offset (default 0). |
| `limit` | number | — | Page size, `1..100`, default 20. |

**Returns**: `{ total, active, count, offset, limit, truncated, next?, tasks: [...] }` where
each task is
`{ id, status, createdAt, createdAt_epoch, finishedAt?, finishedAt_epoch?, waitedMs?, waited?, error?, title?, preset?, sandbox?, cwd, sessionId?, hasResult }`.
Newest first; default page 20, max 100. `active` = queued + running.

### `task_cancel`

| Param | Type | Req | Notes |
|---|---|---|---|
| `taskId` | string | ✅ | From `task_inbox` or `task_list`. |

**Returns** by state:

- `queued`: `{ ok: true, status: "cancelled", was: "queued", taskId, next }` (removed from the queue).
- `running`: `{ ok: true, status: "cancelled", was: "running", taskId, sessionId, note, next }` —
  the cancelled flag is set first, then `agent.cancel({ kind: 'user' })`. Result is discarded,
  the session is preserved for `agent_run` resume. If the agent has not started yet it returns
  a cooperative-cancellation note instead.
- terminal (`done`/`error`/`cancelled`): `{ ok: false, error: "task <id> not cancellable (status=...)", next }`.
- missing: `{ ok: false, error: "task <id> not cancellable (status=missing) (用 task_list …)" }`.

Note: the queue starts tasks immediately, so `queued` is a narrow window — the real value is
aborting `running` tasks.

---

## Session inspection

### `session_list`

| Param | Type | Req | Notes |
|---|---|---|---|
| `cwd` | string | — | Filter by working directory (realpath-normalized exact match). Omit = all sessions. |
| `limit` | number | — | Page size, `1..50`, default 20. |
| `offset` | number | — | Skip the first N rows (default 0). |

**Returns**: `{ total, count, offset, limit, truncated, skipped, next?, sessions: [...] }`,
newest first. Each row:
`{ id, title, cwd, createdAt, createdAt_epoch, updatedAt, updatedAt_epoch, messageCount, inputTokens, outputTokens, llmTime, llmTimeHuman, sandboxMode? }`.

- Live + persisted sessions are merged and deduped by id.
- `skipped` counts sessions dropped by per-row fault isolation (`0` = everything read); one
  unreadable/malformed entry never fails the whole listing.
- `sandboxMode` appears only when the session has at least one `sandbox/mode` event.
- If nothing matches, this returns the unified `session is empty: <key> (...)` error rather
  than an empty array.

### `session_log`

| Param | Type | Req | Notes |
|---|---|---|---|
| `sessionId` | string | ✅ | From `session_list[].id` or a result's `sessionId`. |
| `tail` | number | — | Last N matching events, `1..500`, default 50. |
| `head` | number | — | When truncated, additionally keep the oldest N events, `0..200`, default 5. `head: 0` = newest only. |
| `preset` | enum | — | `dialog` (`user/message` + `assistant/message`) \| `tools` (`tool/call` + `tool/result`) \| `all` (no type filter). |
| `types` | string[] | — | Exact event-type filter; **takes precedence over `preset`**. Default `[user/message, assistant/message, tool/call, tool/result]`. |

**Returns**: `{ sessionId, header: { cwd, createdAt, createdAt_epoch, preset }, preset?, types, totalMatched, shown, truncated, omitted?, order?, next?, events: [...] }`.

- Events are chronological (`seq`, `type`, `time`, `time_epoch`, …). Reasoning/thinking
  blocks are stripped.
- When `totalMatched` exceeds the cap it keeps head + tail (`order` describes which), sets
  `truncated: true` and adds `omitted` + `next` with the three ways to get more.
- A global 60 KB budget is applied on top: the oldest records are dropped first.
- A `preset` you pass is echoed back; `types` always shows the effective filter.

### `session_stats`

| Param | Type | Req | Notes |
|---|---|---|---|
| `sessionId` | string | — | Omit = the most recent `agent_run`/`task_inbox` session. |

**Returns** (pretty-printed):
`{ ...stats, source: "live"|"persisted", next }` where stats is
`{ sessionId, scope: "session", rounds, steps, llmTime, llmTimeMs, toolTime, toolTimeMs, llmTimeHuman, toolTimeHuman, ttft, ttftHuman, ttftSteps, tokensPerSec, cacheHitRate, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }`.

Without `sessionId` and with no prior run, it returns the unified `session is empty:
(last agent session) (...)` error with the suggested next action. Aggregation: `rounds` =
count of `turn/end`; `ttft` = average time to first token per step (`null` with no samples);
`cacheHitRate` = hit/(hit+input) with a denominator heuristic covering DeepSeek and Anthropic
token accounting; `tokensPerSec` is `null` when no decode time was recorded.

### `session_search`

| Param | Type | Req | Notes |
|---|---|---|---|
| `query` | string | ✅ | Substring match (case-insensitive), or regex when `regex: true`. Whitespace-only is rejected. |
| `cwd` | string | — | Restrict to sessions under this working directory (realpath exact match). |
| `regex` | boolean | — | Treat `query` as a regex (default false). Invalid regex → `invalid regex: <query> (...)`. |
| `limit` | number | — | Max **sessions to scan**, `1..200`, default 50. |
| `offset` | number | — | Page offset into the hits (default 0). |
| `pageSize` | number | — | Hits per page, `1..100`, default 20. |

**Returns** (pretty-printed):
`{ query, regex, total, count, offset, limit, truncated, matched, scanned, content_search, results: [...], next?, hint }`.

⚠️ `total` means **sessions scanned**, not matches — `matched` is the hit count and `scanned`
is an equivalent alias. `content_search: false` means only titles were searched (content scan
was impossible/skipped). Each result:
`{ sessionId, title, cwd, updatedAt, updatedAt_epoch, matched: "title"|"content", snippet? }`.
Titles are matched first; content matching is best-effort with a per-session 2 s timeout and
concurrency 8. `hint` tells you what to do next (use the id, or how to widen the search).

### `rename_session`

| Param | Type | Req | Notes |
|---|---|---|---|
| `sessionId` | string | ✅ | From `session_list` or a task result. |
| `title` | string | ✅ | New title. |

**Returns**: `{ ok: true, sessionId, title }`. **Only live sessions can be renamed** — a cold
session returns `session not found: <id> (...)` plus a note to wake it with `agent_run` first.
If the deployment has no `sessionTitle` service it returns
`sessionTitle service unavailable (...)`. See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#-6-rename_session-错误文案里的分号拼接)
for a cosmetic shape issue in this tool's error string.

### `attach_session`

| Param | Type | Req | Notes |
|---|---|---|---|
| `sessionId` | string | ✅ | Live **or** persisted session id. |
| `path` | string | — | Target workspace dir; omit = the session header's `cwd`. Must exist. |

**Returns**: `{ sessionId, workspaceId, workspacePath, attached }` (`attached: false` means it
was already grouped there, with `note: "already attached"`). Strong validation:
`realpath(header.cwd)` must exactly equal the workspace path, otherwise upstream
`attachSession` refuses. Returns `workspaceRegistry unavailable (...)` when the deployment has
no workspace registry.

---

## Files (path jail enforced)

All file tools are bound by: configured `workspaceRoots` (when non-empty) → else the union of
registered workspace paths + `~/.dsh` + the process cwd. Sensitive names (`.ssh/**`, `*.pem`,
`*token*`, `.env`) are blacklisted for read and write and hidden from listings.

### `fs_read`

| Param | Type | Req | Notes |
|---|---|---|---|
| `path` | string | ✅ | Absolute path (realpath-normalized). |
| `offset` | number | — | 1-based first line, `>= 1`, default 1. |
| `limit` | number | — | Max lines, `1..2000`, default 400. `content` also has a 48 KB cap. |

**Returns**: `{ path, totalLines, offset, limit, truncated, content, size, size_bytes, modifiedAt, modifiedAt_epoch, next? }`.
A file > 8 MB is refused (`file too large`). A directory returns
`is a directory, use fs_list`. A missing path returns `path not found`. When truncated, `next`
tells you the exact `offset` to continue from. (See
[KNOWN_ISSUES.md #2](./KNOWN_ISSUES.md) for the out-of-range `offset` behaviour.)

### `fs_list`

| Param | Type | Req | Notes |
|---|---|---|---|
| `path` | string | ✅ | Absolute directory path; passing a file errors. |
| `depth` | number | — | Recursion depth, `1..5`, default 1. |
| `offset` | number | — | Page offset (default 0). |
| `limit` | number | — | Page size, `1..100` (the shared pagination maximum). `fs_list` itself collects up to 1000 entries before paging; `parsePage` is called with a default of 1000 here, so omitting `limit` returns up to 1000 rows in one page. |

**Returns**: `{ path, depth, count, total, offset, limit, truncated, next?, entries: [...] }`.
Each entry: `{ name, type, size, size_bytes, mtime, mtime_epoch }` with
`type` ∈ `dir` \| `file` \| `symlink` \| `other`. Sensitive entries are hidden. Sorting is
case-aware alphabetical.

### `fs_stat`

| Param | Type | Req | Notes |
|---|---|---|---|
| `path` | string | ✅ | May not exist — that is not an error. |

**Returns**: `{ exists: true, path, size, size_bytes, mtime, mtime_epoch, isDir, isFile }`, or
just `{ exists: false, path }` when missing. Nearly free, so probe before a big `fs_read`.

> The upstream schema advertises no `symlinkTarget` field; the implementation does not emit
> one. Earlier docs listed it — that was wrong.

### `fs_write` — opt-in

Registered **only** when `enableFsWrite: true`.

| Param | Type | Req | Notes |
|---|---|---|---|
| `path` | string | ✅ | Absolute path; parent dirs are created. Must be inside `workspaceRoots`. |
| `content` | string | ✅ | UTF-8 text, ≤ 4 MB. |
| `mode` | enum | — | `overwrite` (default) \| `append` \| `create-new` (errors if the file exists). |

**Returns**: `{ ok: true, path, bytes, bytes_raw, mode, next }`. Ancestor realpath checks
prevent traversal; the sensitive-name blacklist applies. Over-limit content returns
`content too large`. (See [KNOWN_ISSUES.md #9](./KNOWN_ISSUES.md) for the `create-new` race.)

---

## Status & config

### `status_get`

No parameters. **Returns** (pretty-printed):
`{ version, uptimeSec, uptime, startedAt, startedAt_epoch, provider, model, preset, activeSessionsCount, agentsLive, queueActive, sandboxPolicy: { defaultMode, bridge, pendingApprovals }, node, pid }`.

- `model` is `'(follow dsh default)'` when the plugin does not override it.
- `sandboxPolicy.bridge` is the **live** effective bridge (`web` \| `builtin` \| `file-push`
  \| `off`), so a degraded `web` shows as `builtin`.
- `queueActive` = queued + running tasks; `agentsLive` = `ctx.agents.list().length`.

### `config_get`

No parameters. **Returns** (pretty-printed):
`{ version, http, server: { port, host }, provider, model, preset, maxQueue, taskTtlMs, taskTtl, maxAgents, approvalTimeout, authTokenSet, workspaceRoots, enableFsWrite, defaultSandbox, approvalsBridge, approvalTimeoutMs, approvalFileDir }`.

`authToken` is never echoed — only `authTokenSet: boolean`. Use this for "how is this plugin
configured"; use `status_get` for "how is it doing right now".

> Note: the tool description mentions a `timeouts: {...}` object; the actual response exposes
> the duration configs as `taskTtl` + `taskTtlMs` and `approvalTimeout` +
> `approvalTimeoutMs` (no nested `timeouts` key). The field list above is the code truth.

---

## Presets

### `preset_list`

No parameters. **Returns** (pretty-printed):
`{ source: "agentPresets"|"builtin-fallback", default, presets: [{ id, name, description, trust?, broken? }] }`.
The built-in fallback lists `standard` / `code` / `minimal` / `cordis`.

### `preset_get`

| Param | Type | Req | Notes |
|---|---|---|---|
| `sessionId` | string | — | Omit = this service's default preset (cheap). |

**Returns** with `sessionId`: `{ sessionId, preset, source: "live"|"persisted"|"header"|"default" }`
(plus `note`/`next` when falling back to `default` — that means the session had no preset
record, e.g. it does not exist). Without `sessionId`:
`{ preset, source: "plugin-config"|"agentPresets.defaultId" }`.

### `preset_set`

| Param | Type | Req | Notes |
|---|---|---|---|
| `presetId` | string | ✅ | Must be an id returned by `preset_list`. |
| `scope` | enum | — | `new-default` (default) \| `session`. |
| `sessionId` | string | — | **Required when `scope: "session"`** (missing → unified `missing required parameter` error). |

**Returns**:

- `scope: "new-default"`: `{ ok: true, scope, preset, runtimeDefault, globalDefaultUpdated, note? }`.
  Resolves/validates the id, updates the runtime default immediately, then best-effort writes
  the global user default (`globalDefaultUpdated: false` + `note` when that write was skipped).
- `scope: "session"`, live: `{ ok: true, scope: "session", sessionId, preset, source: "live", next }`.
- `scope: "session"`, cold blank: `{ ok: true, scope: "session", sessionId, preset, source: "resumed", next }`
  (the session is resumed with the target preset, the event recorded, flushed and disposed).

Only **blank** sessions (no `turn/start` event) can switch: otherwise
`session has already started: <id> (该会话已跑过任务, agent preset 已固化, 只有空白会话能切换;
…)`. An unknown id returns `unknown preset: <id> (不在当前部署的 preset 名单里 …; 用 preset_list 查看合法 id)`.

---

## Policy & approvals

Sandbox tiers map 1:1 to the Harness `SandboxMode`; the write path is a session-log
`sandbox/mode` event (durable, replayed on restart), effective on the session's next
confined call.

### `policy_get`

| Param | Type | Req | Notes |
|---|---|---|---|
| `sessionId` | string | — | Omit = deployment defaults. |

**Returns** (pretty-printed): `{ sessionId, sandboxMode, source: "override"|"default", workspaceRoot, approvalPolicy, next? }`.
`source: "override"` = the session has its own `sandbox/mode` event. `approvalPolicy` is the
last `approval/policy` event, else `ctx.approval.config.policy ?? 'ask'`. Without `sessionId`:
`{ sandboxMode, source: "default", workspaceRoot, approvalPolicy, next }`.

### `set_policy`

| Param | Type | Req | Notes |
|---|---|---|---|
| `sessionId` | string | ✅ | Must currently be live. |
| `mode` | enum | ✅ | `read-only` \| `workspace-write` \| `danger-full-access`. |

**Returns**: `{ ok: true, sessionId, sandboxMode, source: "live", next }` (pretty-printed).
Cold/persisted-only sessions return
`session <id> is not live; cold/persisted sessions must be resumed first (...)` — run one round
with that `sessionId` first, or pass `sandbox=` on that round.

### `approval_list`

| Param | Type | Req | Notes |
|---|---|---|---|
| `offset` | number | — | Page offset (default 0). |
| `limit` | number | — | Page size, `1..100`, default 20. |

**Returns** (pretty-printed):
`{ bridge, pending, count, total, offset, limit, truncated, timeoutMs, timeout, approvals: [...], next?, summary, hint? }`.

Each approval:
`{ approvalId, sessionId, toolName, callId?, reason?, requestedAt, requestedAt_epoch, waitedMs, waited }`.

`pending` is the first-class total (`0` means nothing to answer — stop polling) and `summary`
states it in one sentence. `hint` (only when non-empty) gives the exact `approval_respond`
call for the oldest entry.

### `approval_respond`

| Param | Type | Req | Notes |
|---|---|---|---|
| `approvalId` | string | ✅ | From `approval_list[].approvalId`. |
| `sessionId` | string | ✅ | Must exactly match that approval's `sessionId`. |
| `outcome` | enum | ✅ | `allowed-once` (grant this single call) \| `rejected`. |

**Returns**: `{ ok, receipt: "accepted"|"not-pending", approvalId, sessionId, outcome, pendingRemaining, pendingSummary, next }`.

- The Web UI and Hermes answer over two channels — **first responder wins**; the loser gets
  `receipt: "not-pending"` and no side effect (same for an answered/timed-out/withdrawn entry).
- A `sessionId` that does not own the approval returns
  `{ ok: false, error: "sessionId mismatch: <approvalId> (该审批属于会话 <real>; …)", pendingRemaining }`.
- Timeout: after `approvalTimeoutMs` the bridge settles cancelled (builtin/file-push) or
  rejected (web) — it never auto-allows.
- ⚠️ This is a remote privilege-escalation button: always set `authToken` before any
  non-loopback exposure.

---

## Meta

### `echo`

| Param | Type | Req | Notes |
|---|---|---|---|
| `text` | string | ✅ | Echoed back verbatim. |

**Returns**: `{ "收到": "<text>", at, at_epoch }`. The cheapest possible liveness check.

### `harness_list_tools`

No parameters. **Returns** a JSON array of tool names registered **inside Harness** (the
agent's own toolset, e.g. `bash`, `fs`, `web`). This is not the same as this plugin's 26 MCP
tools.

---

## Error codes

The uniform shape is `<error>: <key> (<one-line reason>; <next action>)`. Existing prefixes
that clients match on are preserved.

| Code / prefix | Meaning | Fix |
|---|---|---|
| `missing required parameter: <tool>.<param>` | Required param absent/null | Supply it; the message names the expected type. |
| `invalid parameter type: <tool>.<param>` | Wrong JSON type | Message echoes `expected X, got Y`. |
| `session not found: <id>` | Session absent or expired | `session_list` to pick a valid id. |
| `session is empty: <key>` | Session exists but has no events (or none match) | Run one round with that `sessionId`, or choose another. |
| `task not found: <id>` | Task expired (TTL, default 10 min) or never existed | `task_list`; re-submit via `task_inbox`. |
| `unknown preset: <id>` | Preset not in this deployment | `preset_list`. |
| `invalid sandbox "<v>"; valid modes: …` | `sandbox` outside the three-tier enum | Use one of the three (the zod schema also rejects pre-call). |
| `path outside allowed roots (~/.dsh + workspaces): <p>` | `fs_*` crossed the path jail | Use a path under `workspaceRoots` (see `config_get`). |
| `path denied by policy (sensitive name): <p>` | `fs_*` hit `.ssh` / `.env` / `*token*` / `*.pem` | Choose another file. |
| `path not found: <p>` | realpath resolution found nothing | `fs_list` the parent directory. |
| `is a directory, use fs_list` | `fs_read` aimed at a directory | `fs_list`, or add a filename. |
| `file too large: <size>` | `fs_read` file > 8 MB | Read in `offset`/`limit` chunks (or use `bash` side). |
| `content too large: <size>` | `fs_write` content > 4 MB | Split into multiple `mode=append` writes. |
| `file already exists: <p>` | `fs_write` `mode=create-new` on an existing file | Use `overwrite` / `append`, or a new path. |
| `session has already started: <id>` | `preset_set scope=session` on a non-blank session | Use `agent_run(preset=...)`, or `scope=new-default`. |
| `session <id> is not live; …` | `set_policy` on a cold session | Run one round with that `sessionId` first. |
| `query must not be empty: (blank)` | `session_search` got a blank query | Pass a keyword. |
| `invalid regex: <q>` | Bad regex with `regex: true` | Fix the pattern, or `regex: false`. |
| `sessionId mismatch: <approvalId>` | `approval_respond` with the wrong session | Use the `sessionId` from the same `approval_list` row. |
| `receipt=not-pending` | Lost the first-responder race / already answered / timed out | Re-run `approval_list`. |
| `<tool> failed: dsh service unreachable` | `ECONNREFUSED`/`ECONNRESET`/socket hang up etc. | `systemctl status dsh.service`, restart if needed. |
| `MISSING_CREDENTIAL: <provider>` (upstream) | Provider API key not in the Harness process env | Add it to the systemd unit / environment. |
| `task queue full (N/M)` | `maxQueue` reached | Wait or `task_cancel` something. |

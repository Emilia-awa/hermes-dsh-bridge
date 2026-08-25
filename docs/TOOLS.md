# TOOLS — Full Reference

All tools are MCP tools on the StreamableHTTP server (`http://127.0.0.1:8090/mcp`). Every response is JSON; tool outputs that are JSON strings are double-encoded (the `content[0].text` field holds the serialized object).

Output caps: `assistantText` ≤ 8000 chars, `toolCalls` ≤ 50 × 2000, `toolResults` ≤ 20 × 2000. Truncated payloads set `truncated: true`; read the full session log via `session_log` when you need everything.

## Task execution

### `agent_run(task, context?, cwd?, sessionId?, title?, preset?, sandbox?)`
Synchronously run a task and return a structured result.

| Field | Type | Notes |
|---|---|---|
| `task` | string | required; the instruction |
| `context` | string | memory/context injected into the prompt |
| `cwd` | string | working directory; agent sessions are keyed/reused by cwd |
| `sessionId` | string | resume an existing session (3-level: live pool → live → persisted) |
| `title` | string | session title (shown in `session_list`) |
| `preset` | string | per-task preset override (single-use; does not touch global default). `standard` (default) / `code` (PTC) / `minimal` (bash+str_replace_editor only, cheapest, DeepSeek-friendly) / `cordis` (for authoring new presets). Unknown id → error with `available` list |
| `sandbox` | string | per-task sandbox-mode override: `read-only` \| `workspace-write` \| `danger-full-access`. Only affects newly created/resumed compositions; existing sessions keep their fixed tier (switch explicitly via `set_policy`). A request whose tier differs from the pooled session's is not served from the pool; dedicated (non-default-tier) sessions never enter the pool — the three tiers never pollute each other on the same cwd. Echoed back as `result.sandbox` when set. ⚠️ `danger-full-access` = unrestricted read/write with no approvals |

Result: `{ sessionId, assistantText, toolCalls, toolResults, changes, verification, leftovers, stats, sandbox? }`.

`stats` (run-scoped): `{ sessionId, scope: "run", rounds, steps, llmTime, llmTimeMs, toolTime, toolTimeMs, ttft, ttftSteps, tokensPerSec, cacheHitRate, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }`.

Notes:
- HTTP timeout 120s; heavy reviews/refactors should be launched as background jobs by the client.
- Reasoning/thinking blocks are stripped from `assistantText` (see ARCHITECTURE note in README).
- If the stream dies mid-run (`TRANSPORT: terminated`), **resume with the same `sessionId`** — do not reopen a fresh session (a fresh session re-reads all code from scratch).
- **Approvals**: if the agent hits a sandbox escalation, this call blocks while the approval is pending. Poll `approval_list` and answer via `approval_respond`; after `approvalTimeoutMs` (default 120s) it settles as cancelled/rejected — **never auto-allowed**. Prefer `task_inbox` for approval-prone workloads.

### `task_inbox(task, context?, cwd?, sessionId?, title?, preset?, sandbox?)`
Push a task to the async in-memory queue. Returns `{ taskId, status }`. Queue: max 100, TTL 10 min, **lost on restart** — do not queue long critical work through this path; prefer `agent_run` + `sessionId`. `preset`/`sandbox` behave exactly like their `agent_run` counterparts. This is the **primary path for approval bridging**: while a task is suspended waiting for an approval, poll `approval_list` → `approval_respond` and the task resumes on its own.

### `task_result(taskId)`
Poll a queued task's result: `{ taskId, status: queued|running|done|error, result?, error? }`.

### `task_list()`
Queue snapshot: `{ total, active, count, truncated, tasks: [{ id, status, createdAt, error?, title?, preset?, sandbox?, cwd?, hasResult }] }`.

### `task_cancel(taskId)`
Cancel a queued/running task:
- `queued`: removed from queue → `{ ok: true, status: "cancelled", was: "queued" }`
- `running`: sets the cancelled flag first, then `agent.cancel({kind:'user'})` (real turn abort; result discarded on completion; session preserved for `agent_run` resume). Returns `{ ok: true, status: "cancelled", was: "running", sessionId }`.
- `done`/`error`/`cancelled`/missing: `{ ok: false, error: "task <id> not cancellable (status=...)" }`
- Note: the queue executes immediately (no deferred worker), so `queued` is usually transient; the real value is aborting `running` tasks.

## Session inspection

### `session_list(cwd?, limit?)`
`{ sessions: [{ id, title, cwd, updatedAt, messageCount, inputTokens, outputTokens, llmTime, sandboxMode? }] }` — live + persisted merged, deduped by id. Filter by `cwd` (workspace path). `sandboxMode` (v0.5.0) appears when the session has at least one `sandbox/mode` event (the effective tier).

### `session_log(sessionId, tail?, types?, sinceIndex?)`
Read a session's event log. Default types: `assistant/message`, `tool/call`, `tool/result`. `tail`: last N events. `sinceIndex`: incremental pull. Reasoning/thinking event types are stripped.

### `session_stats(sessionId?)`
`{ sessionId, scope: "session"|"run", rounds, steps, llmTime, llmTimeMs, toolTime, toolTimeMs, ttft, ttftSteps, tokensPerSec, cacheHitRate, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, source: "live"|"persisted" }`.

Without `sessionId`, returns stats for the most recent agent session (error if none yet: `no active agent session yet`).

Aggregation: `rounds` = count of `turn/end` events; `ttft` = avg time-to-first-token per step; `cacheHitRate` = hit/(hit+input) with a denominator heuristic covering DeepSeek and Anthropic token accounting.

### `session_search(query, cwd?, regex?, limit?)`
Cross-session search:
- `query` (required): substring match, or regex when `regex: true` (invalid regex → error).
- Matches session **titles** first, then **content** (persisted events via `persistence.inspect`; falls back to live log / zstd multi-frame decompress of `session.jsonl.zstd` when inspect is unavailable). Content search result reports `content_search: true/false`.
- Per-session 2s timeout (skipped and counted in `total`); concurrency 8; `limit` default 50 (clamp 1..200 sessions scanned); results capped at 20 with ±60-char `snippet`.

Result: `{ query, regex, total, count, content_search, results: [{ sessionId, title, cwd, updatedAt, matched: "title"|"content", snippet? }] }`.

### `rename_session(sessionId, title)`
Rename a session (goes through the session-title service).

### `attach_session(sessionId, path?)`
Group a session into a workspace. `path` defaults to the session header's cwd; strong validation: realpath(header.cwd) must exactly equal the workspace path.

## Files (path-jail enforced)

All file tools are bound by: configured `workspaceRoots` (if any) → else the union of registered workspace paths + `~/.dsh`. Sensitive names (`.ssh/**`, `*.pem`, `*token*`, `.env`) are blacklisted for read and write.

### `fs_read(path, offset?, limit?, maxBytes?)`
Read a text file: `{ path, totalLines, truncated, content }`. Binary (magic-number detect) returns metadata only. Paginate with `offset`/`limit` (lines).

### `fs_list(path, depth?)`
`{ path, entries: [{ name, type, size, mtime }], truncated }`. Sensitive entries hidden.

### `fs_stat(path)`
`{ exists, size, mtime, isDir, isFile, symlinkTarget? }`.

### `fs_write(path, content, mode?)` — opt-in
Registered only when `enableFsWrite: true`. `mode`: `overwrite` (default) | `append` | `create-new`. 4MB content cap. Path must stay inside workspaceRoots and pass the sensitive-name blacklist; ancestor realpath checks prevent traversal.

## Status & config

### `status_get()`
`{ version, uptimeSec, startedAt, provider, model, preset, activeSessionsCount, agentsLive, queueActive, sandboxPolicy: { defaultMode, bridge, pendingApprovals }, node, pid }`. `sandboxPolicy.defaultMode` is the configured tier for new sessions; `bridge` ∈ `web|builtin|off`; `pendingApprovals` is the live count of suspended approvals.

### `config_get()`
Runtime config summary — `authToken` masked as `***` (never leaks secrets). Includes workspace registry list plus the v0.5.0 keys: `defaultSandbox`, `approvalsBridge`, `approvalTimeoutMs`.

## Presets

### `preset_list()`
`{ presets: [{ id, name, description, order }], defaultPreset, runtimeDefault, roots }`.

### `preset_get(sessionId?)`
Effective preset of a session: `agent-preset/selected` event wins (latest), header is the fallback. Without `sessionId`, returns the plugin's runtime default.

### `preset_set(presetId, scope?, sessionId?)`
- `scope: "new-default"` (default): resolve-validate, then update runtime config (new sessions) + best-effort write to user-level settings. Returns `{ ok, scope, preset, runtimeDefault, globalDefaultUpdated }`.
- `scope: "session"` (requires `sessionId`): only **blank** sessions (no `turn/start` in log) can switch — dsh semantics forbid changing presets on sessions with history (toolset inconsistency). Live sessions are recomposed and record an `agent-preset/selected` event; cold sessions resume with the target preset, record the event, flush and dispose. Non-blank ⇒ `{ error: "session not blank; preset can only be set at creation or while blank" }`.

## Policy & approvals (v0.5.0)

Sandbox tiers map 1:1 to Harness `SandboxMode`; the write path is a session-log `sandbox/mode` event (durable, replayed on restart), effective on the session's next confined call.

### `policy_get(sessionId?)`
Effective policy of a session: `{ sessionId, sandboxMode, source: "override"|"default", workspaceRoot, approvalPolicy }`.
- `sandboxMode`: last `sandbox/mode` event; falls back to the configured `defaultSandbox` (`source: "default"`).
- `approvalPolicy`: last `approval/policy` event, else the deployment default (`ctx.approval.config.policy ?? 'ask'`).
- Without `sessionId`: the deployment defaults (`workspaceRoot` = process cwd).

### `set_policy(sessionId, mode)`
Switch an **existing live session's** sandbox tier. `mode`: `read-only` | `workspace-write` | `danger-full-access`. Returns `{ ok: true, sessionId, sandboxMode, source: "live" }`.
- Appends one `sandbox/mode` event — takes effect on the session's next confined call and survives restarts via replay.
- Cold (persisted-only) sessions error out: `"session <id> is not live; cold/persisted sessions must be resumed first (run agent_run or task_inbox with this sessionId), then set_policy"`.
- ⚠️ `danger-full-access` bypasses file confinement AND unblocks bash — unrestricted reads/writes with no approvals. Trusted environments only.

### `approval_list()`
Currently pending approvals (e.g. sandbox escalations): `{ bridge, count, timeoutMs, approvals: [{ approvalId, sessionId, toolName, callId?, reason?, requestedAt, waitedMs }] }`. Poll this while tasks/agent runs are suspended on an approval.

### `approval_respond(approvalId, sessionId, outcome)`
Answer a pending approval. `outcome`: `allowed-once` (grant this single call) | `rejected`. Returns `{ ok, receipt: "accepted"|"not-pending", approvalId, sessionId, outcome }`.
- The Web UI and Hermes answer over two channels — **first responder wins**; the loser gets `receipt=not-pending` and no side effect.
- Timeout handling: after `approvalTimeoutMs` the bridge settles cancelled (builtin) / rejected (web protocol has no `cancelled`) — it never auto-allows.
- ⚠️ This is a remote privilege-escalation button: always set `authToken` before any non-loopback exposure.

## Meta

### `echo(text)`
Verify connectivity; echoes back.

### `harness_list_tools()`
Lists tool names registered inside Harness (the agent's own toolset).

## Error codes

| Code | Meaning |
|---|---|
| `MISSING_CREDENTIAL: <provider>` | Provider API key not injected into the Harness process env |
| `path outside allowed roots` | fs_* tool crossed the path jail |
| `sensitive path` | fs_* tool hit `.ssh/.env/*token*/*.pem` |
| `session not blank; …` | `preset_set` on a non-blank session |
| `UnknownPresetError` | unknown preset id (response carries `available` list) |
| `invalid sandbox "…"; valid modes: …` | `sandbox` value outside the three-tier enum (schema also rejects pre-call) |
| `receipt=not-pending` | `approval_respond` lost the first-responder race, or the approval was answered/timed out/withdrawn already |
| `sessionId mismatch: approval … belongs to …` | `approval_respond` called with a sessionId that doesn't own the approval |
| `session <id> is not live; cold/persisted sessions must be resumed first` | `set_policy` on a non-live session |
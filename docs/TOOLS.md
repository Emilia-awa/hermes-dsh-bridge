# TOOLS — Full Reference

All tools are MCP tools on the StreamableHTTP server (`http://127.0.0.1:8090/mcp`). Every response is JSON; tool outputs that are JSON strings are double-encoded (the `content[0].text` field holds the serialized object).

Output caps: `assistantText` ≤ 8000 chars, `toolCalls` ≤ 50 × 2000, `toolResults` ≤ 20 × 2000. Truncated payloads set `truncated: true`; read the full session log via `session_log` when you need everything.

## Task execution

### `agent_run(task, context?, cwd?, sessionId?, title?)`
Synchronously run a task and return a structured result.

| Field | Type | Notes |
|---|---|---|
| `task` | string | required; the instruction |
| `context` | string | memory/context injected into the prompt |
| `cwd` | string | working directory; agent sessions are keyed/reused by cwd |
| `sessionId` | string | resume an existing session (3-level: live pool → live → persisted) |
| `title` | string | session title (shown in `session_list`) |

Result: `{ sessionId, assistantText, toolCalls, toolResults, changes, verification, leftovers, stats }`.

`stats` (run-scoped): `{ sessionId, scope: "run", rounds, steps, llmTime, llmTimeMs, toolTime, toolTimeMs, ttft, ttftSteps, tokensPerSec, cacheHitRate, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }`.

Notes:
- HTTP timeout 120s; heavy reviews/refactors should be launched as background jobs by the client.
- Reasoning/thinking blocks are stripped from `assistantText` (see ARCHITECTURE note in README).
- If the stream dies mid-run (`TRANSPORT: terminated`), **resume with the same `sessionId`** — do not reopen a fresh session (a fresh session re-reads all code from scratch).

### `task_inbox(task, context?, cwd?, sessionId?, title?)`
Push a task to the async in-memory queue. Returns `{ taskId, status }`. Queue: max 100, TTL 10 min, **lost on restart** — do not queue long critical work through this path; prefer `agent_run` + `sessionId`.

### `task_result(taskId)`
Poll a queued task's result: `{ taskId, status: queued|running|done|error, result?, error? }`.

### `task_list()`
Queue snapshot: `{ total, active, count, truncated, tasks: [{ id, status, createdAt, error?, title?, cwd?, hasResult }] }`.

## Session inspection

### `session_list(cwd?, limit?)`
`{ sessions: [{ id, title, cwd, updatedAt, messageCount, inputTokens, outputTokens, llmTime }] }` — live + persisted merged, deduped by id. Filter by `cwd` (workspace path).

### `session_log(sessionId, tail?, types?, sinceIndex?)`
Read a session's event log. Default types: `assistant/message`, `tool/call`, `tool/result`. `tail`: last N events. `sinceIndex`: incremental pull. Reasoning/thinking event types are stripped.

### `session_stats(sessionId?)`
`{ sessionId, scope: "session"|"run", rounds, steps, llmTime, llmTimeMs, toolTime, toolTimeMs, ttft, ttftSteps, tokensPerSec, cacheHitRate, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, source: "live"|"persisted" }`.

Without `sessionId`, returns stats for the most recent agent session (error if none yet: `no active agent session yet`).

Aggregation: `rounds` = count of `turn/end` events; `ttft` = avg time-to-first-token per step; `cacheHitRate` = hit/(hit+input) with a denominator heuristic covering DeepSeek and Anthropic token accounting.

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
`{ version, uptimeSec, startedAt, provider, model, preset, activeSessionsCount, agentsLive, queueActive, node, pid }`.

### `config_get()`
Runtime config summary — `authToken` masked as `***` (never leaks secrets). Includes workspace registry list.

## Presets

### `preset_list()`
`{ presets: [{ id, name, description, order }], defaultPreset, runtimeDefault, roots }`.

### `preset_get(sessionId?)`
Effective preset of a session: `agent-preset/selected` event wins (latest), header is the fallback. Without `sessionId`, returns the plugin's runtime default.

### `preset_set(presetId, scope?, sessionId?)`
- `scope: "new-default"` (default): resolve-validate, then update runtime config (new sessions) + best-effort write to user-level settings. Returns `{ ok, scope, preset, runtimeDefault, globalDefaultUpdated }`.
- `scope: "session"` (requires `sessionId`): only **blank** sessions (no `turn/start` in log) can switch — dsh semantics forbid changing presets on sessions with history (toolset inconsistency). Live sessions are recomposed and record an `agent-preset/selected` event; cold sessions resume with the target preset, record the event, flush and dispose. Non-blank ⇒ `{ error: "session not blank; preset can only be set at creation or while blank" }`.

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
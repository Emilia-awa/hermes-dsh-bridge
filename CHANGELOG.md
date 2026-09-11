# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased] — 0.7.0

dsh runtime upgraded 0.1.2-rc.1 → **0.1.5-rc.2**. This release fixes the
`session_list` crash reported in R1 and reworks all 26 tool descriptions for
agent callers. No breaking changes: tool names, parameter names and existing
response fields are unchanged — only new fields were added.

### Fixed
- **`session_list` no-argument crash** (`session_list failed: Cannot read properties of undefined (reading 'length')`). Root cause: dsh 0.1.5 changed the `sessionPersistence` service contract — `list()` now returns `SessionPersistenceSnapshot[]` (`{ header, revision, sizeBytes }`) instead of bare `SessionHeader[]`, and `inspect(id)` was removed in favour of `open(id, 'read')` + `handle.read()`. The old code read `snapshot.id` / `snapshot.cwd` (both `undefined`), so `SessionId(undefined)` and `locate(undefined)` fed `undefined` into path building and produced the exact `reading 'length'` `TypeError`. Reproduced against the real 0.1.5 backend plus the real v3 session file, then fixed via a new compatibility layer (`unwrapPersistedEntry` / `persistedInspect` / `persistedRowMeta`) that transparently supports **both** contracts (0.1.2 bare header + `inspect`, and 0.1.5 snapshot + `open`/`read`/`stat`). Persisted sessions now read their events again on 0.1.5 instead of silently falling back to an empty live store.
- **v3 session format support** (`session.v3.jsonl.zstd` in a directory without the `session-` prefix, plus `agentPresets`/`permission/preset` events). `session_list`, `session_log`, `session_search`, `session_stats`, `preset_get` and orphan reattach all verified against a real v3 session (`messageCount`, folded `title`, token stats, `sandboxMode` and `preset` all resolve correctly).
- **Per-row fault isolation** in `session_list`: a single unreadable or malformed persisted entry is now skipped and counted instead of failing the entire listing.
- **Token stats lost when `assistant/message` carries no `turn`/`step`**: the stats fold used to `break` before accumulating `usage`, so such messages contributed 0 to `inputTokens`/`outputTokens`. Usage is now accumulated independently of step binding.

### Added
- `session_list` response gained a self-describing `skipped` counter (number of sessions skipped by per-row fault isolation; `0` means all rows were read). `total` / `count` / `truncated` / `sessions` are unchanged.
- `session_log` gained an optional `preset` parameter: `"dialog"` (user + assistant messages only), `"tools"` (tool calls + results only), `"all"` (no type filter). Explicit `types` still takes precedence; the default behaviour is unchanged. The response echoes the effective `preset`.
- Self-describing `next` field on results: `agent_run` (how to continue the session), `task_inbox` (how to fetch results), `task_result` (what to do per status), `session_search` (how to use the hits, or what to try when nothing matched), `session_stats`, `session_log` (when truncated), `set_policy`, `approval_list`, `approval_respond`, `fs_read` (when truncated), `fs_write`, `policy_get`, `task_cancel`.
- `tests/probe_v3_real.mjs`: real-environment probe that mounts the actual dsh 0.1.5 `dsh-session-persistence-jsonl` backend over the real session store, reproduces the original `reading 'length'` crash on the old code path, then asserts the fix (20/20).

### Changed
- **All 26 tool descriptions rewritten for agent callers** (when to use it / what it returns / what to do next) instead of implementation details. `agent_run` and `task_inbox` now explicitly cross-reference each other and `task_result`, so an agent can pick the right tool at a glance.
- **Every error message now carries a next step**, e.g. `task not found: <id>` → `… (已过期或从未存在; 用 task_list 查看当前队列 …)`; `session not found: <id>` → `… (用 session_list 查看当前会话列表 …)`; `no active agent session yet` → points at `agent_run` / an explicit `sessionId`.
- **Simplified default `cwd`**: `agent_run` / `task_inbox` (and `policy_get`) now default to `workspaceRoots[0]` when configured, instead of the meaningless-for-remote-agents `process.cwd()`. The effective default is stated in the parameter description, and `process.cwd()` remains the fallback when no `workspaceRoots` is configured.
- `status_get` and `config_get` descriptions now explain when to reach for which one.
- Version 0.6.0 → 0.7.0; `tests/unit_mock_p3.mjs` extended with a 0.1.5-contract instance (v3 snapshot shape, `open`/`read` handle close, malformed-entry `skipped` counting, per-row read failure, and the A/B UX contract) — suite now 116 assertions, up from 79.

### Compatibility notes (0.1.5 audit, no refactor required)
- `ctx.agent` (singular) removal: **0 direct accesses** in the plugin — it only uses `ctx.agents` and `ctx.agentPresets`, both still present in 0.1.5.
- P3 panel/sidebar slot change (`'conversation'` → `'main'`): not applicable — this plugin registers no web panel or UI slot. The only web-channel use is the optional approval bridge's `apiProxy` subscription, which already degrades safely to `builtin`/`file-push`; `dsh-host-apiproxy` is no longer shipped in 0.1.5 and `ctx.get('apiProxy', false)` returns `undefined` there instead of throwing.

## [0.6.0] - 2026-09-04

### Added
- `approvalsBridge: 'file-push'` mode: pending approvals are mirrored to a file (default `~/.dsh/approvals/`, `approvalFileDir` config) so an out-of-band MCP client (e.g. Hermes) can detect and answer them while `agent_run` is blocked; first-responder-wins semantics unchanged. Approval timeout default raised 120000 → 300000 to match.

### Changed
- **dsh 0.1.2-rc.1 adaptation** (previous src failed to start under dsh 0.1.2):
  - `isTokenDelta` (removed from `@deepseek-ai/dsh-llm/message` in 0.1.2) replaced with an inline check preserving the old semantics: `text-delta`/`reasoning-delta` → non-empty `text`; `tool-call-delta` → non-empty `argumentsDelta` or `name !== undefined`.
  - `resolveSessionPreset` (removed from `@deepseek-ai/dsh-agent-presets` in 0.1.2) replaced with a local `presetFromEvents` scanning `agent-preset/selected` events newest-first for the last non-empty `data.preset`, falling back to `header.agentPreset`.
  - `apiProxy` removed from the `inject` array (the service no longer exists in dsh 0.1.2 headless compositions; injecting it crashed startup); `apiProxyOf` now reads it leniently via `ctx.get('apiProxy', false)` (returns `undefined`, never throws) — the `web` bridge auto-degrades to `builtin` there as before.
  - `@deepseek-ai/*` dsh dependencies loosened from pinned `0.1.0-rc.6` to `^0.1.2-rc.1`; `peerDependencies.@deepseek-ai/cordis` ^4.0.1 → ^4.0.2.
- Version 0.5.0 → 0.6.0; `tests/unit_mock_p3.mjs` mock ctx now serves `apiProxy` through `ctx.get('apiProxy', false)` (matching the cordis hard rule that non-injected services must not be read as properties) and asserts the new defaults (79 assertions).

## [0.5.0] - 2026-08-26

### Added
- **Sandbox tiers (权限三档)**: `agent_run`/`task_inbox` accept `sandbox: read-only|workspace-write|danger-full-access` — a per-task override that seeds a session-log `sandbox/mode` event on newly created/resumed sessions (same write path as dsh `setSandboxMode`; effective on the next confined call, survives restarts via replay). Pool hygiene follows the preset precedent: requests whose tier differs from the pooled session's fixed tier skip the pool, and non-default-tier dedicated sessions never enter it — the three tiers never pollute each other on one cwd. New `defaultSandbox` config (default `workspace-write`).
- `set_policy(sessionId, mode)` tool: switch an existing **live** session's tier (cold/persisted sessions error with a resume hint).
- `policy_get(sessionId?)` tool: `{ sessionId, sandboxMode, source: "override"|"default", workspaceRoot, approvalPolicy }` (folds last `sandbox/mode` + `approval/policy` events; no-arg returns deployment defaults).
- **Approval bridge (审批桥)**: new `approval_list()` and `approval_respond(approvalId, sessionId, outcome)` tools. Bridge mode `web` (default) subscribes `ctx.apiProxy.events.mux()`, tracks pending approvals in memory, syncs on `approval/resolved` frames (first responder wins across Web UI/Hermes; the loser gets `receipt=not-pending`) and answers through `apiProxy.respond({type:'client-response', …})`. Automatic degradation to a builtin `'approval/request'` answerer (asked/decided scan) when apiProxy is absent or `approvalsBridge: 'builtin'` is set; `'off'` disables bridging. `approvalTimeoutMs` (default 120000) settles timed-out approvals cancelled (builtin) / rejected (web) — **never auto-allows**. `task_inbox` is the primary async path; `agent_run` blocks while an approval is pending.
- Status exposure: `status_get` now reports `sandboxPolicy { defaultMode, bridge, pendingApprovals }`; `config_get` reports `defaultSandbox/approvalsBridge/approvalTimeoutMs`; `session_list` rows carry `sandboxMode` when the session has a tier record; `task_list`/`task_result`/`agent_run` echo the requested tier.

### Changed
- Version 0.4.0 → 0.5.0; docs (README/TOOLS/CONFIG/SECURITY) updated for the 25-tool surface.
- CI runs `tests/unit_mock_p3.mjs` (77 assertions: tier pass-through & pool isolation, set_policy live/cold, approval web/builtin flows incl. not-pending races and timeout cancellation, bridge off/explicit-builtin, status/config exposure).

## [0.4.0] - 2026-08-25

### Added
- `agent_run`/`task_inbox` accept an optional `preset` parameter — per-task preset override (single-use, does not touch the global default; unknown id errors with the `available` list). The live-agent pool skips cached sessions whose preset differs from the request.
- `task_cancel` tool: cancel queued tasks (removed from queue) or running tasks (real turn abort via `agent.cancel({kind:'user'})`; result discarded, session preserved for resume). Done/error/missing ids return explicit errors.
- `session_search` tool: cross-session search over titles + content (persisted events via `persistence.inspect`, zstd multi-frame decompress fallback; per-session 2s timeout, concurrency 8, results capped at 20 with snippets).
- Shared `listMergedHeaders()` helper reused by `session_list`, orphan reattach, and `session_search` (dedup).
- `tests/unit_mock_p2.mjs`: mock-ctx unit suite covering all three features (preset validation/mount/pool-miss, task_cancel branches incl. cooperative cancel, session_search title/content/regex/limits/degradation).

### Changed
- Version 0.3.0 → 0.4.0.

### Added
- `session_stats` tool: session statistics (rounds/steps/llmTime/toolTime/ttft/tokensPerSec/cacheHitRate/inputTokens/outputTokens); no-arg = most recent agent session.
- `agent_run`/`task_inbox` results now carry a `stats` object (run-scoped usage accounting).
- `session_list` rows extended with `inputTokens`/`outputTokens`/`llmTime`.
- `fs_write` tool (opt-in via `enableFsWrite: true`): overwrite/append/create-new, workspaceRoots jail + sensitive-name blacklist + ancestor realpath traversal check, 4MB cap.
- `task_list` tool: async task queue snapshot.
- `preset_set` tool: `scope=new-default` updates the runtime default (best-effort write to user-level settings); `scope=session` switches blank sessions only (live recompose / cold resume, records `agent-preset/selected`).
- `apply()` now resets runtimeConfig before stacking config — idempotent across repeated apply calls (fixed cross-instance state leak).

### Changed
- Version 0.2.0 → 0.3.0.
- License MIT → GPL-3.0-only (upstream MIT portions retained, see NOTICE.md).

## [0.2.0] - 2026-08-24

### Added
- `fs_read` / `fs_list` / `fs_stat` file-viewing tools (path jail + sensitive-name blacklist).
- `session_list` / `session_log` session-inspection tools (reasoning stripped).
- `status_get` / `config_get` status tooling (authToken masked).
- `preset_list` / `preset_get` preset inspection.
- Reasoning/thinking stripping from all textual outputs (double filter: event-type level + text-level regex fallback).

## [0.1.x] - 2026-08-22

### Added
- Initial plugin: MCP server (StreamableHTTP) inside Harness exposing `echo`, `harness_list_tools`, `agent_run`, `task_inbox`/`task_result`, `rename_session`, `attach_session`.
- Structured task results (assistantText/toolCalls/toolResults/changes/verification/leftovers).
- Session reuse per cwd; Bearer token auth support; loopback-only default binding.
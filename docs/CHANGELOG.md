# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the
project adheres to [Semantic Versioning](https://semver.org/).

## [0.8.1] - 2026-09-19

### Fixed
- Sync version string in README, docs and index to 0.8.1.

## [0.8.0] - 2026-09-19

### Added
- **Task Callback System (P0 & P1)**:
  - `task_inbox` supports optional `notifyUrl` and `replyContext` parameters for event-driven wakeups.
  - Asynchronous HTTP Webhook notification with HMAC-SHA256 signature verification (`X-Signature-256`, `X-Timestamp`).
  - Strict SSRF protection and DNS pin caching to prevent rebinding attacks.
  - File beacon push mechanism (`notify_<taskId>.json`) for local environments.
  - 100% backward compatible for users without callback configs.

## [0.7.0] - 2026-09-13 — R4: 安装体验与文档 (开箱即用)

R4 目标：用户拿到包之后 **README 5 分钟内跑通、每个报错都能自查、AI agent 装也能一次成功**。
本轮**不改 `src/index.ts` 核心逻辑**（发现的缺陷只记录到 `docs/KNOWN_ISSUES.md`），
全部改动为文档 + 新增自检脚本。

### Added
- **`scripts/doctor.mjs`** — 零依赖、`node` 直接跑的安装自检（只读，不改文件/不重启服务）：
  7 项检查（Node 版本 / dsh 可执行与版本 / profile 存在 / settings 文件 / patch 是否配了插件 /
  端口监听 / MCP 握手 + `tools/list`），每项输出 ✓/✗ + 一条修复建议，最后汇总
  「N 项通过，M 项失败」并以退出码 `0`/`1` 区分。支持 `--url/--host/--port/--profile/--token`，
  自动探测 profile，识别历史包名别名（`dsh-harness-mcp-server`），区分 `dump-config` 的
  EACCES 权限问题与真实配置问题。
- **`docs/KNOWN_ISSUES.md`** — 逐字段核对代码时发现的缺陷清单（10 条，含 4 个真实缺陷：
  `fs_read` offset 越界静默、`fs_list.total` 硬上限下偏小、`rename_session` 错误串破坏统一句式、
  `set_policy` 冷会话错误串前缀不在统一家族；以及 3 条文档/代码口径不一致的 ⚠️）。按约束**本轮不修**。

### Changed
- **README 重写为 quickstart 优先**：首屏 = 一句话是什么 → 30 秒 quickstart（4 步命令跑通 `echo`）
  → 分场景进阶。新增前置依赖表（每项带检查命令）、三种安装路径分人群说明（npm / 源码构建 /
  Hermes 一键配置片段）、常见错误排查表（把 `src/index.ts` 全部面向用户的错误文案逐条过了一遍，
  22 行「原因 + 修复步骤」）、0.1.5 用户升级特别注意表、0.5.x/0.6.x → 0.7.0 升级指南与破坏性变更清单。
  README 内嵌的 doctor 预期输出是**本机真实运行原文**。
- **`docs/CONFIG.md` 与实际 zod schema / `Config` 接口逐字段核对**：16 个字段全部补齐
  （此前缺 `approvalFileDir`；`approvalsBridge` 补上第四值 `file-push`）。修正两处长期口径错误：
  - `approvalTimeoutMs` 真实默认值是 **300000 ms（5 分钟）**，此前文档写 120s —— 以代码为准修正；
  - `provider` 默认值实为 `'deepseek-official'`（非"必填无默认"），`model` 默认空串 = 不覆盖。
  配置示例全部改成 `<your-provider-id>` / `<your-model-id>` 占位符，可复制即用，不写死任何本机配置。
- **`docs/TOOLS.md` 与 26 个工具逐个核对**：每个工具补全参数表（名称/类型/必填/说明）、
  返回字段示例与错误码表。修正：`fs_stat` 不再宣称输出不存在的 `symlinkTarget`；
  `session_search` 补充 `pageSize`/`offset`/`matched`/`scanned` 并标注 `total` = 扫描数而非命中数；
  `session_log` 补 `head`；`fs_list` 补 `offset`/`limit` 与真实分页默认值；
  `approval_list` 补分页与 `pending`/`summary`/`hint`；`config_get` 标注实际没有嵌套 `timeouts` 键；
  `task_list` 补上被遗漏的 `offset`/`limit` 参数。敏感路径错误码更正为代码里的真实文案
  `path denied by policy (sensitive name)`。

### Verification
- 26 个工具的「schema 参数名 ↔ TOOLS.md 入参表」自动化比对：**26/26 通过**。
- CONFIG.md 表格 vs `Config` 接口 + `runtimeConfigDefaults()`：**16/16 字段覆盖**（`port`/`host`
  在 `apply()` 里直接读取、不在 defaults 中，已在文档显式标注）。
- `scripts/doctor.mjs` 在本机真实环境跑通（Node v22.22.3 / dsh 0.1.5-rc.2 / 真实 profile）：
  8 项通过 1 项失败（失败项为本机 profile 目录不可写导致的 `dump-config` EACCES，运行态握手通过）。
- `npm test`：三套 mock 单测 **178 断言全绿**，未回归。

## [0.7.0] - 2026-09-13

dsh runtime upgraded 0.1.2-rc.1 → **0.1.5-rc.2**. This release fixes the
`session_list` crash reported in R1 and reworks all 26 tool descriptions for
agent callers. No breaking changes: tool names, parameter names and existing
response fields are unchanged — only new fields were added.

R3 (agent 使用体验深化) follows up on R2 by cutting the *response payload* and
unifying *error strings* — the part an agent actually reads on every call.

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
- Version 0.6.0 → 0.7.0; `tests/unit_mock_p3.mjs` extended with a 0.1.5-contract instance (v3 snapshot shape, `open`/`read` handle close, malformed-entry `skipped` counting, per-row read failure, and the A/B UX contract); R3 adds a further 62 assertions for A/B/C — suite now 178 assertions, up from 79.

### Compatibility notes (0.1.5 audit, no refactor required)
- `ctx.agent` (singular) removal: **0 direct accesses** in the plugin — it only uses `ctx.agents` and `ctx.agentPresets`, both still present in 0.1.5.
- P3 panel/sidebar slot change (`'conversation'` → `'main'`): not applicable — this plugin registers no web panel or UI slot. The only web-channel use is the optional approval bridge's `apiProxy` subscription, which already degrades safely to `builtin`/`file-push`; `dsh-host-apiproxy` is no longer shipped in 0.1.5 and `ctx.get('apiProxy', false)` returns `undefined` there instead of throwing.

### R3 — A: 返回结构精简 (lower per-call context cost)
- **List responses are paginated** (default page 20, max 100) with a uniform envelope: `total` (post-filter count) / `count` (this page) / `offset` / `limit` / `truncated` / `next` (the exact call to fetch the next page). Added `offset` to `fs_list`, `session_list`, `session_search` (as `pageSize` alongside the existing scan-`limit`), `task_list` and `approval_list`. `task_list` no longer hard-truncates at 100 rows without recourse.
- **`session_log` defaults to ≤50 events**: when `totalMatched` exceeds the cap it returns head + tail (new `head` parameter, default 5; `head: 0` = newest only), sets `truncated: true` and adds `omitted` / `order` / `next` with the three ways to get more (larger `tail` up to 500, `head=0`, or narrower `preset`/`types`).
- **Timestamps are human-readable**: every `*At` / `time` / `mtime` output is now ISO8601 in the local timezone with an explicit `±HH:MM` offset, and the original epoch is preserved alongside as `*_at_epoch` / `time_epoch` (same field name, so existing readers of the ISO field keep working). Covered: `echo.at`, `status_get.startedAt`, `fs_read.modifiedAt`, `fs_list[].mtime`, `fs_stat.mtime`, `session_list[].createdAt/updatedAt`, `session_log.header.createdAt` and `events[].time`, `task_inbox.createdAt`, `task_result/task_list.createdAt/finishedAt`, `approval_list[].requestedAt`.
- **Byte counts and durations are formatted** (`9.4KB`, `8.8s`, `1.5m`) with the raw value kept for sorting: `fs_stat.size` + `size_bytes`, `fs_list[].size` + `size_bytes`, `fs_write.bytes` + `bytes_raw`, `status_get.uptime` (raw `uptimeSec`), `config_get.taskTtl`/`approvalTimeout` (raw `*Ms`), `session_stats.llmTimeHuman`/`toolTimeHuman`/`ttftHuman`, `session_list[].llmTimeHuman`, `task_list/task_result[].waited`, `approval_list[].waited`.
- **Redundant / internal fields dropped**: `config_get` no longer echoes the masked `authToken: '***'` placeholder (only `authTokenSet: boolean` remains).

### R3 — B: agent 工作流指引 (agent_run / task_inbox / 审批流)
- **File-landing hint (`B4`)**: when an `agent_run` / `task_result` payload mentions writing a file ("已写入 / created file / wrote to …") but contains no absolute path, the response adds `landing: { hint, likelyDir, mentionedWrite, pathsInResult }` pointing at the run's sandbox `cwd` as the common landing spot, with the `fs_list`/`fs_stat` calls to locate the file. When the result already carries an absolute path the hint is omitted (no noise).
- **`task_inbox` retention + polling advice (`B5`)**: the submit response now returns `retain` / `retainMs` (how long the result is kept before TTL cleanup), `createdAt` (+ `_epoch`) and a `pollAdvice` string ("poll every 5–15s, don't spin; collect within the retention window"), and its `next` carries the same cadence.
- **Pending-approval summary (`B6`)**: `approval_list` now reports `pending` (total hung approvals) as a first-class field plus a `summary` sentence, so an agent learns there is nothing to answer without diffing lists; `approval_respond` reports `pendingRemaining` / `pendingSummary` after answering (including on the losing `receipt: not-pending` path), removing a follow-up `approval_list` round-trip.

### R3 — C: 一致性与防御 (unified errors, validation, service-down guidance)
- **Three error classes share one shape** — `<错误>: <关键值> (<原因一句话>; <下一步动作>)` — built by helpers `errText` / `missingParamError` / `idNotFoundError` / `emptySessionError`: missing required parameter, id not found (session / task / preset) and empty session. Existing prefixes that callers already match on (`task not found`, `session not found`, `unknown preset`, `query must not be empty`) are preserved; only the suffix is unified.
- **Validation moved to the tool entrance (`C8`)**: every parameterised tool now runs `validateArgs` before any business logic (type + required, echoing `expected <type>, got <actual>`); the zod schemas remain the first gate. `session_search` additionally rejects whitespace-only queries through the unified shape.
- **dsh service-down guidance (`C9`)**: `isDshServiceDown` classifies `ECONNREFUSED`/`ECONNRESET`/`ENOTFOUND`/`EHOSTUNREACH`/`ETIMEDOUT`/`socket hang up`/`fetch failed`, and `toolFailure` replaces the bare error with an actionable "check `dsh.service` status (`systemctl status dsh.service`, restart if needed)" message. All 26 tools route their `catch` branches through it.
- Unit tests: `tests/unit_mock_p3.mjs` gained 62 R3 assertions (pure-helper checks for formatting/pagination/error shapes/service-down classification, plus HTTP-level checks for pagination envelopes, `session_log` truncation, `landing`, retention advice and approval summaries); suite now **178 assertions** (was 116). `__internals` exposes the pure helpers for deterministic testing.
- Regression guard: two R2 contracts were nearly broken by an over-eager "empty session" check — `preset_set` legitimately resumes a **cold blank** session (0 events), and `session_search.total` means *sessions scanned*, not hits (hits are now also exposed as `matched`). Both are covered by the existing P1/P2 suites, which are back to green.

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
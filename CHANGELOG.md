# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the
project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-08-25

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
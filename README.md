# hermes-dsh-bridge

> Expose [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent capabilities as an **MCP server**, letting any MCP client (e.g. [Hermes](https://hermes-agent.nousresearch.com/)) drive Harness to execute real coding tasks.

**Hermes is the brain, Harness is the arms — 1+1>2.**

[![license](https://img.shields.io/badge/license-GPLv3-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-orange)](https://nodejs.org)

## Why this exists

Harness ships a powerful agent runtime (tools, LLM, agents, sessions), but it is a **Cordis app**, not something another agent can call. This plugin turns Harness inside-out: it starts a real **MCP server** (StreamableHTTP) *inside* Harness and bridges Harness's core services — `ctx.agents`, `ctx.agentPresets`, `ctx.tools` — so an external "brain" can delegate real work to Harness's "arms".

```
Hermes (MCP client, brain)
   │  agent_run / task_inbox / fs_read / session_stats ... (HTTP)
   ▼
hermes-dsh-bridge (MCP server, :8090)
   │  ctx.agents.create → mount 'standard' preset
   ▼
Harness agent — full toolset: bash, fs, todo, web…
```

## Tools (19)

### Tasks
| Tool | Direction | Purpose |
|------|-----------|---------|
| `agent_run` | → Harness | Run a task synchronously; returns structured result + run-scoped `stats` |
| `task_inbox` | → Harness | Push a structured task (task + memory context + cwd) to an async queue |
| `task_result` | ← Harness | Poll a queued task's structured result |
| `task_list` | ← Harness | Snapshot of the async task queue (id/status/createdAt/error) |

### Sessions
| Tool | Direction | Purpose |
|------|-----------|---------|
| `session_list` | ← | List sessions (live + persisted merged), with token/LLM-time summary per row |
| `session_log` | ← | Read a session's event log (reasoning stripped), tail N events, filter by type |
| `session_stats` | ← | Session statistics: rounds/steps/llmTime/toolTime/ttft/tokensPerSec/cacheHitRate/inputTokens/outputTokens |
| `rename_session` | ← | Rename a session (archive-friendly) |
| `attach_session` | ← | Group a session into a workspace |

### Files (jail-enforced)
| Tool | Direction | Purpose |
|------|-----------|---------|
| `fs_read` | ← | Read text files with line-number pagination (path jail + sensitive-name blacklist) |
| `fs_list` | ← | List directories recursively (sensitive entries hidden) |
| `fs_stat` | ← | File/dir metadata |
| `fs_write` | → | Write files (overwrite/append/create-new) — **opt-in** (`enableFsWrite: true`), workspaceRoots only |

### Status & config
| Tool | Direction | Purpose |
|------|-----------|---------|
| `status_get` | ← | Version/uptime/provider/model/preset/live agents/queue depth |
| `config_get` | ← | Runtime config summary (authToken masked as `***`) |

### Presets
| Tool | Direction | Purpose |
|------|-----------|---------|
| `preset_list` | ← | List available agent presets + default |
| `preset_get` | ← | Query the effective preset of a session (or the default) |
| `preset_set` | → | Switch default preset (`scope=new-default`) or a blank session's preset (`scope=session`) |

### Meta
| Tool | Direction | Purpose |
|------|-----------|---------|
| `echo` | — | Verify MCP connectivity |
| `harness_list_tools` | — | List tool names registered inside Harness |

### Structured results & stats

Every `agent_run` result is structured and includes run-level usage stats:

```json
{
  "sessionId": "...",
  "assistantText": "final answer",
  "toolCalls": [{ "name": "bash", "args": "..." }],
  "toolResults": ["command output"],
  "changes": "what was changed",
  "verification": "how it was verified",
  "leftovers": "open issues",
  "stats": {
    "rounds": 1, "steps": 3,
    "llmTime": 13.9, "toolTime": 0.04,
    "ttft": 3349, "tokensPerSec": 40.7,
    "cacheHitRate": 1, "inputTokens": 8831, "outputTokens": 157
  }
}
```

This closes the loop between the client's persistent memory and Harness's coding: memory is fed into each task as `context`, and the result (`changes` / `verification` / `leftovers`) can be persisted back to the client's memory for the next run.

## Install

### Option A — from npm

```bash
npm install hermes-dsh-bridge
```

Then reference the plugin from your Harness profile's cordis patch (see below).

### Option B — from source

```bash
git clone https://github.com/Emilia-awa/hermes-dsh-bridge.git
cd hermes-dsh-bridge
npm install && npm run build
# copy the package (or symlink node_modules) into your Harness profile:
#   ~/.dsh/profiles/<name>/node_modules/hermes-dsh-bridge
```

> ⚠️ **dual-package hazard**: Harness resolves `@deepseek-ai/*` modules from its *global* tree while this plugin's own `node_modules` may contain parallel copies — two module instances ⇒ `Symbol` mismatch ⇒ agents silently lose all tools. Fix: symlink the plugin's `@deepseek-ai/*` deps to the global tree:
> ```bash
> PROFILE=~/.dsh/profiles/web/node_modules
> GLOBAL=$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai
> for pkg in cordis cosmokit dsh-agent dsh-llm dsh-session dsh-tools dsh-scope schemastery; do
>   rm -rf "$PROFILE/@deepseek-ai/$pkg" && ln -sfn "$GLOBAL/$pkg" "$PROFILE/@deepseek-ai/$pkg"
> done
> ```

## Run

```bash
export DEEPSEEK_API_KEY=...            # or any provider key your Harness uses
dsh --profile <name> web --port 3080 --trusted-host your.host
```

The MCP server listens on `127.0.0.1:8090` (StreamableHTTP). Point any MCP client at `http://127.0.0.1:8090/mcp`.

> ⚠️ **Security**: by default the server binds to `127.0.0.1` only. It exposes **remote code execution via `agent_run`** — do **not** bind it to `0.0.0.0` or expose it to the internet/LAN without adding authentication (Bearer token), TLS, and a reverse proxy first. See `docs/SECURITY.md`.

## cordis.yml (patch format)

```yaml
- insert:
    - id: harness-mcp-server
      name: 'hermes-dsh-bridge'
      config:
        http: true
        port: 8090
        host: 127.0.0.1        # 默认仅本机; 暴露前必须加认证
        # authToken: 'your-secret-token'     # 可选: Bearer token 认证
        # workspaceRoots: ['/workspace']      # 可选: cwd 白名单
        # enableFsWrite: true                 # 可选: 开启 fs_write 工具(默认关)
        # ⚠️ 必须显式声明 provider/model, 否则 agent 组装会因空 {model} 崩溃:
        # provider: opencode-go
        # model: deepseek-v4-flash
```

## Docs

- `docs/TOOLS.md` — full tool reference (params/schema/limits/error codes)
- `docs/CONFIG.md` — config fields, security defaults
- `docs/TROUBLESHOOTING.md` — known pitfalls (SSE parsing, 8KB truncation, dual-package hazard, …)
- `docs/SECURITY.md` — threat model
- `examples/hermes_dsh_mcp.py` — dependency-free Python MCP client (stdlib only)

## Positioning

This is best used as a **fallback tool**, not a daily driver: for everyday code edits, drive your primary agent directly. Reach for this when you need **context isolation** (huge refactors that would blow the client's context) or **parallel execution** of unrelated tasks.

- The agent session is **reused per cwd** (avoids re-loading project context on every call).
- Bash runs sandboxed (`workspace-write`): install `bubblewrap` on the host, or the sandbox will refuse write commands.
- Reasoning/thinking chunks are **stripped** from every result (double filter: plugin-side + text-level fallback).

## License

[GPL-3.0-only](./LICENSE), with upstream MIT portions retained — see [NOTICE.md](./NOTICE.md).
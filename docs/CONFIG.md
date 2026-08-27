# CONFIG — Reference

The plugin is configured through the cordis patch entry in your Harness profile (`cordis.patch.yml`).

## Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `http` | boolean | `true` | serve MCP over HTTP (StreamableHTTP) |
| `port` | number | `8090` | listen port |
| `host` | string | `127.0.0.1` | bind address — **keep loopback** |
| `authToken` | string | empty | optional Bearer token; all requests must then send `Authorization: Bearer <token>` |
| `workspaceRoots` | string[] | empty | cwd whitelist for `agent_run` **and** the fs_* path jail. Empty = default visible set (registered workspaces + `~/.dsh`) |
| `enableFsWrite` | boolean | `false` | register `fs_write` (opt-in by design) |
| `defaultSandbox` | string | `workspace-write` | default file-sandbox tier for newly created/resumed sessions: `read-only` \| `workspace-write` \| `danger-full-access`. Invalid values warn and keep the default. ⚠️ `danger-full-access` = unrestricted read/write, no approvals |
| `approvalsBridge` | string | `web` | approval bridge mode: `web` (subscribe the apiProxy mux stream; answers route through `apiProxy.respond`) / `builtin` (plugin-internal answerer; also the automatic fallback when apiProxy is absent) / `off` (no bridge — approvals fall back to deployment defaults, fail-closed) |
| `approvalTimeoutMs` | number | `120000` | how long a pending approval is waited for. On expiry it settles cancelled (builtin) or rejected (web) — **never auto-allows**. `agent_run` blocks while an approval is pending; prefer `task_inbox` for approval-prone workloads |
| `provider` | string | — | **required**: your Harness's LLM provider id for agent assembly (a provider you already configured, e.g. under `llm-*` in your patch) |
| `model` | string | — | **required**: a model id offered by that provider |

## Security defaults (why they are what they are)

| Default | Rationale |
|---|---|
| `host: 127.0.0.1` | `agent_run` is effectively remote code execution on the host. Loopback-only by default; exposing requires auth + TLS + reverse proxy (see SECURITY.md) |
| `authToken` off but supported | convenient for local trust domains; **always enable** before any non-loopback exposure |
| `enableFsWrite: false` | writing files through an agent-control channel widens the attack surface; enable explicitly when you need it |
| sensitive-name blacklist | `.ssh/**`, `*.pem`, `*token*`, `.env` are never readable/writable through fs_* tools |
| `defaultSandbox: workspace-write` | new sessions can work inside their workspace but stay fenced; raise to `danger-full-access` only in trusted environments (it disables confinement and approvals entirely) |
| approvals never auto-allow on timeout | a timed-out approval settles cancelled/rejected after `approvalTimeoutMs`; escalation grants only ever come from an explicit `approval_respond('allowed-once')` (or the Web UI) |
| provider/model explicit | an empty `{{model}}` prompt variable crashes agent assembly — fail loudly at config time |

## Minimal production example

```yaml
- insert:
    - id: harness-mcp-server
      name: 'hermes-dsh-bridge'
      config:
        http: true
        port: 8090
        host: 127.0.0.1
        authToken: '<generate-a-long-random-token>'
        workspaceRoots: ['/srv/app']
        enableFsWrite: false
        defaultSandbox: workspace-write   # read-only | workspace-write | danger-full-access
        approvalsBridge: web              # web | builtin | off
        approvalTimeoutMs: 120000
        # ⚠️ provider/model must be a provider+model your Harness already
        #    has configured (see the llm-* section of your cordis patch);
        #    the plugin does not bring its own LLM provider.
        provider: <your-provider-id>
        model: <your-model-id>
```

If you only ever talk to it from the same host over loopback and trust all local processes, `authToken` may be omitted — but then any local user/process can drive the agent.

## Verification after config change

```bash
# list tools — should show 25 including fs_*, session_*, preset_*, policy_get, set_policy, approval_*
python3 examples/hermes_dsh_mcp.py list
# health
python3 examples/hermes_dsh_mcp.py call status_get '{}'
python3 examples/hermes_dsh_mcp.py call config_get '{}'   # authToken masked
```
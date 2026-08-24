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
| `provider` | string | — | **required**: LLM provider id for agent assembly (e.g. `opencode-go`) |
| `model` | string | — | **required**: model id (e.g. `deepseek-v4-flash`) |

## Security defaults (why they are what they are)

| Default | Rationale |
|---|---|
| `host: 127.0.0.1` | `agent_run` is effectively remote code execution on the host. Loopback-only by default; exposing requires auth + TLS + reverse proxy (see SECURITY.md) |
| `authToken` off but supported | convenient for local trust domains; **always enable** before any non-loopback exposure |
| `enableFsWrite: false` | writing files through an agent-control channel widens the attack surface; enable explicitly when you need it |
| sensitive-name blacklist | `.ssh/**`, `*.pem`, `*token*`, `.env` are never readable/writable through fs_* tools |
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
        provider: opencode-go
        model: deepseek-v4-flash
```

If you only ever talk to it from the same host over loopback and trust all local processes, `authToken` may be omitted — but then any local user/process can drive the agent.

## Verification after config change

```bash
# list tools — should show 19 including fs_*, session_*, preset_*
python3 examples/hermes_dsh_mcp.py list
# health
python3 examples/hermes_dsh_mcp.py call status_get '{}'
python3 examples/hermes_dsh_mcp.py call config_get '{}'   # authToken masked
```
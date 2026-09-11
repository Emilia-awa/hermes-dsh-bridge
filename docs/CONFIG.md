# CONFIG — Configuration Reference

> **Ground truth**: this document is checked field-by-field against the actual code —
> `interface Config` (src/index.ts ~L116), `runtimeConfigDefaults()` (~L149) and the
> `apply()` merge block (~L3519). When this file and the code disagree, **the code wins**;
> please open an issue so the doc gets fixed.

The plugin is configured through the cordis patch entry in your Harness profile
(`cordis.patch.yml`, or any `--patch` overlay). Values are merged at `apply()` time:
the runtime object is first reset to the defaults below, then only the fields you actually
supply are overlaid (so re-applying is idempotent and never leaks state from a previous apply).

## Fields

| Field | Type | Default | Required | Meaning |
|---|---|---|---|---|
| `http` | `boolean` | `true` | no | Serve MCP over HTTP (StreamableHTTP). Only `true` is meaningful today. |
| `port` | `number` | `8090` | no | Listen port. Read directly from `config.port ?? 8090` (not from `runtimeConfig`). |
| `host` | `string` | `'127.0.0.1'` | no | Bind address. Read directly from `config.host ?? '127.0.0.1'`. **Keep loopback** — see Security defaults. |
| `provider` | `string` | **`'deepseek-official'`** | effectively yes | LLM provider id used to assemble agents. Default is `deepseek-official`; if your Harness does not have that provider registered you **must** set your own. |
| `model` | `string` | `''` (empty) | no | Model id. Empty string = **do not override**, follow dsh's user/default model. Non-empty overrides. `status_get`/`config_get` render the empty case as `'(follow dsh default)'`. |
| `preset` | `string` | `'standard'` | no | Agent preset mounted for new sessions. Valid ids come from `preset_list` (`standard` / `code` / `minimal` / `cordis` + whatever your deployment registers). |
| `maxQueue` | `number` | `100` | no | Max number of *active* (queued + running) tasks in the async queue. `task_inbox` rejects with `task queue full (N/100)` when reached. |
| `taskTtlMs` | `number` | `600000` (10 min) | no | How long a finished (`done`/`error`/`cancelled`) task result is retained before TTL cleanup. After expiry `task_result` returns `task not found`. |
| `maxAgents` | `number` | `8` | no | Resident agent-session cap (LRU eviction). Reported by `config_get.maxAgents`. |
| `authToken` | `string` | `''` (off) | no | Bearer token. When set, **every** HTTP request must send `Authorization: Bearer <token>` or it gets `401 Unauthorized`. Never echoed back — `config_get` only returns `authTokenSet: boolean`. |
| `workspaceRoots` | `string[]` | `[]` (empty) | no | cwd whitelist for `agent_run` / `task_inbox` **and** the `fs_*` path jail. Empty = the default visible set (`~/.dsh` + process cwd + registered workspaces). When non-empty it also becomes the default cwd (`workspaceRoots[0]`). |
| `enableFsWrite` | `boolean` | `false` | no | Register the `fs_write` tool. **Opt-in by design** — while `false`, `fs_write` is not in `tools/list` at all (25 tools instead of 26). |
| `defaultSandbox` | `'read-only' \| 'workspace-write' \| 'danger-full-access'` | `'workspace-write'` | no | Default file-sandbox tier for newly created/resumed sessions. Invalid values emit a warning and keep the default. ⚠️ `danger-full-access` = unrestricted read/write **and** bash unblocked, no approvals. |
| `approvalsBridge` | `'web' \| 'builtin' \| 'off' \| 'file-push'` | `'web'` | no | Approval bridge mode. Invalid values warn and keep `'web'`. See the mode table below. |
| `approvalTimeoutMs` | `number` | **`300000`** (5 min) | no | How long a pending approval is waited for. Must be a finite number `> 0` (otherwise the config value is ignored and the default kept). On expiry it settles **cancelled** (builtin/file-push) or **rejected** (web — the protocol has no `cancelled`) — **never auto-allows**. |
| `approvalFileDir` | `string` | `~/.dsh/approvals` | no | Directory for the `file-push` bridge. The plugin writes `pending_<id>.json` there and polls for `response_<id>.json` (poll interval 500 ms). Only accepts a non-blank string. |

### `approvalsBridge` modes

| Value | Behaviour | When it is active |
|---|---|---|
| `web` | Subscribes the `apiProxy` mux stream and keeps the pending-approval table; answers route through `apiProxy.respond`. | Only when the `apiProxy` service exists. Since dsh 0.1.2 `apiProxy` is no longer injected/shipped, so in a headless composition this **auto-degrades** to `builtin`. |
| `builtin` | Registers the plugin's own `approval/request` answerer (waterfall). | When `apiProxy` is unavailable, or when explicitly configured. |
| `file-push` | builtin answerer **plus** file notifications: writes `pending_<id>.json`, polls `response_<id>.json` every 500 ms, answers with the parsed outcome. | Explicitly configured (the local deployment uses this). |
| `off` | No bridge at all. Approvals fall back to the deployment default, which is fail-closed. | Explicitly configured, or when the host has no event capability. |

The mode actually in effect is reported live as `status_get.sandboxPolicy.bridge` and
`approval_list.bridge` (`activeBridgeKind`), so you never have to guess whether `web`
degraded.

## Security defaults (and why)

| Default | Rationale |
|---|---|
| `host: '127.0.0.1'` | `agent_run` is effectively remote code execution on the host. Loopback-only unless you deliberately expose it (then: `authToken` + TLS + reverse proxy, see [SECURITY.md](./SECURITY.md)). |
| `authToken` off but supported | Convenient inside a local trust domain. **Always enable** before any non-loopback exposure. |
| `enableFsWrite: false` | Writing files through an agent-control channel widens the attack surface; enable only when needed. |
| Sensitive-name blacklist | `.ssh/**`, `*.pem`, `*token*`, `.env` / `.env.*` are never readable or writable through `fs_*`, and are hidden from `fs_list`. |
| `defaultSandbox: 'workspace-write'` | New sessions can work inside their workspace but stay fenced. Raise to `danger-full-access` only in trusted environments. |
| Approvals never auto-allow on timeout | A timed-out approval settles cancelled/rejected after `approvalTimeoutMs`; grants only ever come from an explicit `approval_respond('allowed-once')` (or the Web UI). |
| `provider` explicit | An empty `{{model}}` prompt variable crashes agent assembly — fail loudly at config time rather than mid-task. |

> **Upgrade note**: `approvalTimeoutMs` really defaults to **300000 ms (5 min)**. Older
> README revisions said 120 s — that was a documentation error, now fixed. If you want the
> 2-minute behaviour, set `approvalTimeoutMs: 120000` explicitly.

## Minimal production example

Copy-paste runnable. `<your-provider-id>` / `<your-model-id>` are **placeholders** —
replace them with a provider + model your own Harness already has configured (see the
`llm-*` section of your own profile patch). The plugin does not bring its own LLM provider.

```yaml
- insert:
    - id: hermes-dsh-bridge
      name: 'hermes-dsh-bridge'
      config:
        http: true
        port: 8090
        host: 127.0.0.1
        authToken: '<generate-a-long-random-token>'
        workspaceRoots: ['/srv/app']
        enableFsWrite: false
        defaultSandbox: workspace-write   # read-only | workspace-write | danger-full-access
        approvalsBridge: web              # web | builtin | file-push | off
        approvalTimeoutMs: 300000         # 5 min; timeout settles cancelled/rejected, never allows
        # ⚠️ provider/model must be a provider+model your Harness already has configured
        #    (see the llm-* section of your cordis patch). The plugin does not
        #    bring its own LLM provider.
        provider: <your-provider-id>
        model: <your-model-id>
```

Minimal local-only variant (all defaults, loopback, no auth):

```yaml
- insert:
    - id: hermes-dsh-bridge
      name: 'hermes-dsh-bridge'
      config:
        http: true
        port: 8090
        host: 127.0.0.1
        provider: <your-provider-id>
        model: <your-model-id>
```

If you only ever talk to it from the same host over loopback and trust every local process,
`authToken` may be omitted — but then any local user/process can drive the agent.

`file-push` variant (no web channel available; answers arrive as files):

```yaml
- insert:
    - id: hermes-dsh-bridge
      name: 'hermes-dsh-bridge'
      config:
        http: true
        port: 8090
        provider: <your-provider-id>
        model: <your-model-id>
        approvalsBridge: file-push
        approvalFileDir: ~/.dsh/approvals   # default; override if you want another dir
        approvalTimeoutMs: 300000
```

## Verification after a config change

```bash
node scripts/doctor.mjs                 # 7 checks, prints ✓/✗ + fixes (see README)
python3 examples/hermes_dsh_mcp.py list # should show 25 tools (26 with enableFsWrite: true)
python3 examples/hermes_dsh_mcp.py call status_get '{}'   # health + effective sandboxPolicy
python3 examples/hermes_dsh_mcp.py call config_get '{}'   # full runtime config; authTokenSet only
```

`config_get` is the fastest way to confirm what the running process actually believes its
configuration is — it echoes every runtime field above (with `authToken` reduced to a boolean).

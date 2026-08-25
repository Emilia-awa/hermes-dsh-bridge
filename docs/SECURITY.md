# SECURITY — Threat Model

This plugin is an **agent-control channel**: `agent_run` gives the caller a full coding agent with bash on the Harness host. Treat it accordingly.

## Trust boundary

```
[ MCP client (e.g. Hermes) ]
        │  HTTP (StreamableHTTP)
        ▼
[ hermes-dsh-bridge ]  ← in-process plugin inside Harness
        │  ctx.agents / ctx.tools / ctx.agentPresets
        ▼
[ Harness agent: bash, fs, web, todo … sandboxed by bubblewrap ]
```

- The plugin is **not an auth wall** — it is a data path. Authentication must be layered on by configuration.
- Default binding is loopback (`127.0.0.1`): only local processes can connect.

## Attack surfaces & mitigations

| Surface | Risk if exposed | Mitigation |
|---|---|---|
| `agent_run` / `task_inbox` | arbitrary code execution on the Harness host (sandbox is `workspace-write`, not a security boundary); the optional per-task `sandbox` parameter can widen a session to `danger-full-access` | keep loopback; add Bearer token; TLS + reverse proxy before any non-loopback exposure; `workspaceRoots` whitelist; keep `defaultSandbox: workspace-write`, reserve `danger-full-access` for trusted environments |
| `approval_respond` (v0.5.0) | **remote privilege-escalation button**: an attacker who can reach the MCP endpoint can answer pending sandbox escalations with `allowed-once` | mandatory `authToken` on any non-loopback exposure (the 8090 listener must never be public without it); approvals time out to cancelled/rejected — never auto-allow; every grant is one-shot (`allowed-once`) and audit-logged as `approval/asked`+`approval/decided` in the session log |
| `fs_write` (`enableFsWrite: true`) | write anywhere in allowed roots (overwrite/append/create-new) | **off by default**; limited to `workspaceRoots`; sensitive-name blacklist; 4MB cap; ancestor realpath traversal check |
| `fs_read` / `fs_list` / `fs_stat` | read arbitrary files in allowed roots | path jail (workspaceRoots → registered workspaces + `~/.dsh`); `.ssh/**`, `*.pem`, `*token*`, `.env` blacklisted |
| `config_get` | config leak | `authToken` masked as `***`; API keys are env vars, never part of config output |
| `session_log` | internal reasoning/thinking exposure | reasoning event types stripped at the filter layer (double filter: type-level + text-level regex fallback) |
| MITM | credential/session hijack | TLS termination on the reverse proxy; do not expose plaintext HTTP beyond loopback |

## Deployment requirements for non-loopback exposure

1. `authToken` set to a long random value; client sends `Authorization: Bearer <token>`. **Non-negotiable once `approval_respond` is reachable from outside** — it grants sandbox escalations.
2. Reverse proxy with TLS (e.g. cloudflared/nginx/caddy) — deny any plaintext path.
3. Access control at the proxy (e.g. Cloudflare Access / IP allowlist) — this is the real auth wall.
4. Keep `enableFsWrite: false` unless file-writing through the channel is actually required.
5. Keep `defaultSandbox` at `workspace-write` (or lower). `danger-full-access` disables confinement AND approvals entirely.
6. Monitor agent sessions (`session_list` + `session_log`) for unexpected activity; approval decisions are audit-logged per session (`approval/asked` / `approval/decided` events).

## Known non-goals

- The in-agent bash sandbox (`workspace-write` via bubblewrap) is a **reliability** measure (prevents accidental host damage), not a security boundary. Do not rely on it against a malicious caller.
- The async task queue is in-memory (max 100, TTL 10 min, lost on restart) — do not queue anything that must survive.

## Disclosure

Report vulnerabilities via GitHub issues with the `security` label (no private disclosure channel yet).
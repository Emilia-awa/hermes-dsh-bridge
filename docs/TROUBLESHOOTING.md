# TROUBLESHOOTING

Real-world pitfalls collected from production use. All internal topology details are removed.

## MCP transport

### `Mcp-Session-Id` must be echoed back
`initialize` returns a `Mcp-Session-Id` header; all subsequent requests on the same session must send it back. Forgetting it creates a new session server-side per request (lost context, orphaned agents).

### SSE responses: take the **last** `data:` event
When `Content-Type: text/event-stream`, notifications are appended after the response. Parsing only the first event returns stale data. Iterate all `data: ` lines, parse each as JSON, keep the last.

### `resp.headers` is not a dict
`urllib`'s `resp.headers` is `http.client.HTTPMessage` — `isinstance(headers, dict)` is always `False`. Check `"text/event-stream" in str(resp.headers.get("Content-Type", ""))` instead. (Bitten once: the streaming branch never matched, JSON parse blew up.)

### JSON control characters in shell arguments
Passing multi-line JSON with real newlines through a shell single-quote breaks `json.loads` (Invalid control character). Generate the JSON with `json.dumps` in Python, or use a helper script that reads task args from a JSON file.

## Agent behavior

### `TRANSPORT: terminated` mid-run (llm provider hiccup)
The stream dies; the session may be half-modified or untouched. **Resume with the same `sessionId`** — the agent remembers where it was. A fresh session re-reads all code and re-analyzes (minutes of tokens wasted). Before resuming, check actual file changes: `find <cwd> -name '*.py' -mmin -N` to phrase the resume prompt correctly.

### Headless long tasks produce no stdout for a long time
dsh agent runs output nothing until the final result — 20-40 min of silence with CPU active is **normal** for multi-file edits. A dead task looks like: CPU ≈ 0% + no file changes + elapsed far beyond the task's scale.

### 8KB `assistantText` truncation
Long results (reviews, checklists) get cut at ~8000 chars — the low-priority items live in the cut tail. Fetch the full text from the session log (`session_log` with `types=["assistant/message"]`) or grep the session file for the final `assistant/message` event.

### `minimal` preset + big task = stream timeouts
Minimal persona with `complete: true` thinking long can trip the provider's idle timeout. For big tasks use `standard` and write every implementation detail into the task description.

## Plugin-specific

### dual-package hazard: agent has tools but "all broken" ("嘴炮" agent)
Symptoms: `agent_run` answers with `<tool_calls>` text but `toolCalls`/`toolResults` stay empty; log shows `agent ctx unscoped` / `preset mount skipped` / `Cannot read properties of undefined (reading 'prepare')`.

Root cause: Node ESM loaded the same `@deepseek-ai/*` package twice (plugin's own `node_modules` copy vs Harness's global tree) — module-level `Symbol`s differ between instances, so `scopeOf(agentCtx)` is `undefined` and tools silently fail to register.

Fix (both steps):
1. In the plugin source, never inline `kScope`/`scopeOf` — `import { scopeOf } from "@deepseek-ai/dsh-scope"`.
2. Symlink the plugin's `@deepseek-ai/*` copies to the Harness global tree (commands in README "dual-package hazard" section). Restart Harness.

Whenever dsh is upgraded/reinstalled, the symlinks may be restored to real copies — re-apply.

### Empty `{{model}}` crashes agent assembly
The plugin's default provider is `deepseek-official` with an empty model. Without explicit `provider`/`model` in the patch, agent assembly fails with `prompt variable "{{model}}" has no value`. Always declare both.

### Two global npm trees (dsh upgraded but still old behavior)
`npm i -g` may install into a different prefix than the one systemd/profile symlinks point at. Always verify the **actual** bin.js path under the running service (`systemctl show dsh.service -p ExecStart`), not just `dsh --version`.

## Tests in CI

`tests/unit_mock_p1.mjs` runs standalone (mock ctx, no dsh needed). The integration suites (`tests/integration_p1.py`, `tests/integration_p1_phase2.py`) need a real Harness instance with a live LLM provider — run locally, not in CI:
```bash
npm run build
node tests/unit_mock_p1.mjs
# local only:
python3 tests/integration_p1.py
python3 tests/integration_p1_phase2.py
```
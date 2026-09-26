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

### agent 秒退 + 0 token + 无任何报错 — `MessageSourceMap`

**This is the highest-value entry in this file.** The symptom is *total silence*: the call
returns "successfully" but nothing happened, and nothing is logged.

Symptoms — all of the following at once:

- `agent_run` / `task_inbox` returns almost instantly (a real agent run takes seconds to
  minutes) and reports `steps: 1` or similar with **`inTok=0`, `outTok=0`**;
- `assistantText` is empty, `toolCalls` / `toolResults` are empty arrays;
- **no error anywhere** — not in the MCP response, not in `session_log`, not in
  `journalctl -u dsh.service`;
- the session itself is created fine (so `session_list` shows it), it just contains nothing.

Root cause: **dsh 0.1.7 tightened `MessageSourceMap`.** It now accepts only
`user | model | tool | system-prompt` — the official comment states there is *"no shared
catch-all `plugin` kind"*. Code that built a user message as
`createUserMessage({ ..., source: { kind: 'plugin', plugin: '...' } })` (the pre-0.1.7 habit,
still found in older forks) produces a message the host rejects as **invalid**, and the
message is **silently dropped**. The task therefore runs against an empty conversation: the
agent has nothing to do, returns immediately, and consumes zero tokens.

Why there is no error: the injection point is wrapped in `catch (_error) {}` inside the loop's
`kick()`, so the rejection never surfaces. This is a *silent* failure by construction — which
is exactly why it is worth its own entry.

Diagnosis — confirm it is this, and not something else:

```bash
# ① 确认 dsh 版本是 0.1.7 或更高(0.1.5 及以前不会触发)
dsh --version

# ② 确认是"进了会话但没有任何事件", 而不是"任务失败"
#    拿到 sessionId 后看事件流: 真正跑过的会话会有 user/message + assistant/message
python3 examples/hermes_dsh_mcp.py call session_log '{"sessionId":"<id>","preset":"all"}'
#    若 user/message 都不存在 → 注入的 prompt 被丢了, 正是本症状
```

Fix: use the same source kind the official call sites use (`dsh-headless` / `dsh-acp`):

```diff
  createUserMessage({
    content: [{ type: 'text', text: fullTask }],
-   source: { kind: 'plugin', plugin: 'harness-mcp-server' },
+   source: { kind: 'user' },
  })
```

Official releases of this plugin already do this (`src/index.ts`, in `executeTask`). You only
need to act if you **forked the plugin and kept your own `kind: 'plugin'`**, or you are
maintaining a different bridge that injects user messages into a 0.1.7 host.

> Rule of thumb for 0.1.7+: a "successful" agent call that finishes instantly with
> `inTok=0` and no events in the session almost always means *the prompt never entered the
> conversation*. Check the message source kind before anything else.

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

### `session_list` / `session_search` appears to hang (large session library)

Symptom: the call does not error, it just never comes back — a 20 s client timeout fires
first. Measured on a 197-session library with the 0.8.1 build: `limit:1` ≈ **13 s**,
`limit:50` ≈ **31 s**.

Two things to know:

1. **It is not a contract failure — it is slowness.** The call does eventually return; the
   client gives up first. There are no errors and `skipped` stays `0`.
2. **It is fixed in `0.9.0`** — see the performance table in the README. After upgrading,
   `limit:1` and `limit:50` are both sub-second on the same library.

If you are stuck on 0.8.1 and cannot upgrade yet, the cost is dominated by *scanning the whole
library*, so narrowing helps only a little:

```jsonc
// 0.8.1 缓解手段: 用 cwd 缩小集合(仍会对该目录下每个会话逐条 stat, 只是行数变少)
{"cwd": "/path/to/one/project", "limit": 5}
```

Root cause on 0.8.1: the sort key came from `sessionPersistence.stat(id)` per row, and in the
JSONL backend `stat()` is **O(number of project directories)** — it re-walks the whole tree on
every call (≈50 ms × N). See `docs/KNOWN_ISSUES.md` for the two upstream limitations this
plugin now works around.

### `session_list` rows have no `messageCount` / token numbers

Not a bug: since `0.9.0` the default is `detail: "brief"`, which returns only
header-derived fields and **does not read session logs** (that is what makes it fast).
Rows carry `tokensAvailable: false` to make the absence explicit rather than reporting a
misleading `0`.

```jsonc
{"detail": "full", "limit": 10}   // 需要 messageCount/inputTokens/outputTokens/llmTime/sandboxMode 时
```

`detail: "full"` reads logs for the selected page only (concurrency 4, 3 s per-session
timeout); a session that times out is counted in `skipped` instead of stalling the call.

## Tests in CI

`tests/unit_mock_p*.mjs`, `tests/unit_callback_p0.mjs` and `tests/unit_mock_r1.mjs` run
standalone (mock ctx, no dsh needed) — `npm test` runs all five. Real-Harness integration
tests run locally only, not in CI.

`npm run test:mutation` runs the R1 mutation check: it deliberately breaks each critical piece
of logic, rebuilds, and asserts the suite goes **red** — a green run after a mutation means
that logic is untested. It restores the source and build output when it finishes.

#!/usr/bin/env python3
"""A2A P1 集成测试: 对指定 MCP 端点验证新工具(fs_write/session_stats/task_list/preset_set)
+ 旧工具回归(echo/fs_read/fs_list/fs_stat/session_list/session_log/status_get/config_get/
preset_list/preset_get/agent_run/task_inbox/task_result/task_list/rename_session/attach_session/
harness_list_tools)。

用法:
  DSH_MCP_URL=http://127.0.0.1:8091/mcp python3 tests/integration_p1.py
前提(对齐 cordis.patch.yml 测试配置): enableFsWrite=true, workspaceRoots=[<WS>] 且 WS 存在。
"""
import json, os, sys, time, uuid, urllib.request, urllib.error

URL = os.environ.get("DSH_MCP_URL", "http://127.0.0.1:8091/mcp")
WS = os.environ.get("A2A_TEST_WS", "/tmp/a2a-ws")
SESSION = {}
PASS, FAIL = [], []


def rpc(method, params, rid=None, expect_response=True):
    rid = rid or uuid.uuid4().hex[:12]
    body = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
    if not expect_response:
        body.pop("id", None)
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if SESSION.get("id"):
        headers["Mcp-Session-Id"] = SESSION["id"]
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            sid = resp.headers.get("Mcp-Session-Id")
            if sid:
                SESSION["id"] = sid
            data = resp.read().decode()
    except urllib.error.HTTPError as e:
        if not expect_response and e.code in (400, 404, 405):
            return None
        raise
    if not expect_response:
        return None
    ctype = str(resp.headers.get("Content-Type", ""))
    if "text/event-stream" in ctype:
        out = []
        for line in data.splitlines():
            if line.startswith("data: "):
                try:
                    out.append(json.loads(line[6:]))
                except Exception:
                    pass
        return out[-1] if out else {"error": "no sse data"}
    return json.loads(data)


def init():
    r = rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                           "clientInfo": {"name": "a2a-p1-test", "version": "1"}})
    rpc("notifications/initialized", {}, expect_response=False)
    assert "result" in r, f"initialize failed: {r}"
    return r["result"]["serverInfo"]


def call(name, arguments=None):
    r = rpc("tools/call", {"name": name, "arguments": arguments or {}})
    if "error" in r:
        return {"_rpc_error": r["error"]}
    content = r.get("result", {}).get("content", [])
    text = "".join(c.get("text", "") for c in content if c.get("type") == "text")
    try:
        return json.loads(text)
    except Exception:
        return {"_raw": text}


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(f"{name}{(' :: ' + str(detail)[:300]) if detail and not cond else ''}")
    print(("  ✓ " if cond else "  ✗ ") + name + ("" if cond else f"  -> {str(detail)[:300]}"))


def main():
    # 幂等: 清理上次运行留下的测试产物(create-new 用例要求文件不存在)
    import glob as _glob
    for stale in _glob.glob(os.path.join(WS, "w*.txt")) + [os.path.join(WS, "sub", "dir", "w1.txt")]:
        try:
            os.remove(stale)
        except OSError:
            pass
    info = init()
    print(f"serverInfo: {info}")
    check("server version 0.3.0", info.get("version") == "0.3.0", info)

    # ── 1. tools/list: 新旧工具齐全 ──
    t = rpc("tools/list", {})
    names = [x["name"] for x in t["result"]["tools"]]
    print(f"tools ({len(names)}): {names}")
    for n in ["fs_write", "session_stats", "task_list", "preset_set"]:
        check(f"new tool listed: {n}", n in names)
    for n in ["echo", "harness_list_tools", "status_get", "config_get", "fs_read", "fs_list", "fs_stat",
              "session_list", "session_log", "preset_list", "preset_get", "agent_run", "task_inbox",
              "task_result", "rename_session", "attach_session"]:
        check(f"old tool kept: {n}", n in names)

    # ── 2. 旧工具回归(轻量) ──
    r = call("echo", {"text": "ping"})
    check("echo 回归", "_rpc_error" not in r and "ping" in r.get("_raw", "") or "收到" in json.dumps(r, ensure_ascii=False), r)
    r = call("status_get")
    check("status_get 回归", r.get("version") == "0.3.0", r)
    r = call("config_get")
    check("config_get 含 enableFsWrite=true", r.get("enableFsWrite") is True, r)
    check("config_get workspaceRoots=[WS]", r.get("workspaceRoots") == [WS], r)
    r = call("preset_list")
    check("preset_list 回归", isinstance(r.get("presets"), list) and len(r["presets"]) > 0, r)
    std_default = r.get("default")

    # fs_read/fs_stat/fs_list 回归(读 /etc/hostname 不行——白名单外; 用 WS 内文件)
    probe = os.path.join(WS, "probe_read.txt")
    with open(probe, "w") as f:
        f.write("hello-a2a\nline2\n")
    r = call("fs_read", {"path": probe})
    check("fs_read 回归", r.get("content") == "hello-a2a\nline2" and r.get("totalLines") == 2, r)
    r = call("fs_stat", {"path": probe})
    check("fs_stat 回归", r.get("exists") is True and r.get("size") == len("hello-a2a\nline2\n"), r)
    r = call("fs_list", {"path": WS})
    check("fs_list 回归", any(e["name"].endswith("probe_read.txt") for e in r.get("entries", [])), r)

    # ── 3. fs_write ──
    p1 = os.path.join(WS, "sub", "dir", "w1.txt")  # 父目录不存在 → 自动创建
    r = call("fs_write", {"path": p1, "content": "alpha"})
    check("fs_write overwrite 新文件+自动建父目录", r.get("ok") is True and r.get("bytes") == 5 and r.get("mode") == "overwrite", r)
    r = call("fs_write", {"path": p1, "content": "beta"})
    check("fs_write overwrite 覆盖", r.get("ok") is True and open(p1).read() == "beta", r)
    r = call("fs_write", {"path": p1, "content": "-gamma", "mode": "append"})
    check("fs_write append", r.get("ok") is True and open(p1).read() == "beta-gamma", r)
    r = call("fs_write", {"path": p1, "content": "x", "mode": "create-new"})
    check("fs_write create-new 已存在报错", "already exists" in r.get("error", ""), r)
    p2 = os.path.join(WS, "w2.txt")
    r = call("fs_write", {"path": p2, "content": "fresh", "mode": "create-new"})
    check("fs_write create-new 成功", r.get("ok") is True and open(p2).read() == "fresh", r)
    # jail: 白名单外 / 穿越 / 敏感名
    r = call("fs_write", {"path": "/tmp/a2a-outside.txt", "content": "no"})
    check("fs_write 拒绝白名单外", "outside workspaceRoots" in r.get("error", ""), r)
    r = call("fs_write", {"path": os.path.join(WS, "..", "escape.txt"), "content": "no"})
    check("fs_write 拒绝 .. 穿越", "outside workspaceRoots" in r.get("error", ""), r)
    r = call("fs_write", {"path": os.path.join(WS, ".env"), "content": "SECRET=1"})
    check("fs_write 拒绝敏感名 .env", "sensitive name" in r.get("error", ""), r)
    r = call("fs_write", {"path": os.path.join(WS, ".ssh", "id.pem"), "content": "x"})
    check("fs_write 拒绝 .ssh/*.pem", "sensitive name" in r.get("error", ""), r)
    check("白名单外文件未被写入", not os.path.exists("/tmp/a2a-outside.txt"))

    # ── 4. task_list(空队列快照) ──
    r = call("task_list")
    check("task_list 快照结构", isinstance(r.get("tasks"), list) and "total" in r and "active" in r, r)

    # ── 5. agent_run + stats ──
    print("  … agent_run 执行中(小任务)…")
    r = call("agent_run", {"task": "不要使用任何工具。直接输出一行 JSON: {\"changes\":\"无\",\"verification\":\"echo OK\",\"leftovers\":\"无\"}",
                           "cwd": WS, "title": "a2a-p1-test-run"})
    sid = r.get("sessionId")
    stats = r.get("stats")
    check("agent_run 返回 sessionId", bool(sid), r)
    check("agent_run 返回 stats", isinstance(stats, dict), r)
    if isinstance(stats, dict):
        need = ["rounds", "steps", "llmTime", "llmTimeMs", "toolTime", "toolTimeMs", "ttft",
                "tokensPerSec", "cacheHitRate", "inputTokens", "outputTokens"]
        missing = [k for k in need if k not in stats]
        check("stats 字段齐全", not missing, missing)
        check("stats.scope='run'", stats.get("scope") == "run", stats.get("scope"))
        check("stats.rounds>=1", stats.get("rounds", 0) >= 1, stats.get("rounds"))
        check("stats.llmTimeMs>0 或 ttft 有样本", stats.get("llmTimeMs", 0) > 0 or (stats.get("ttftSteps") or 0) > 0, stats)
        check("stats.outputTokens>0", stats.get("outputTokens", 0) > 0, stats.get("outputTokens"))
    check("agent_run changes 解析", "无" in (r.get("changes") or "") or r.get("changes"), (r.get("changes"), r.get("assistantText", "")[:200]))

    # session_stats: 指定会话(全会话累计 ≥ 本轮)
    r2 = call("session_stats", {"sessionId": sid})
    check("session_stats(sessionId) 返回累计", r2.get("scope") == "session" and r2.get("sessionId") == sid, r2)
    check("session_stats rounds≥本轮", r2.get("rounds", 0) >= (stats or {}).get("rounds", 0), (r2, stats))
    check("session_stats source 标注", r2.get("source") in ("persisted", "live"), r2.get("source"))
    # session_stats 无参 = 当前 Agent 会话
    r3 = call("session_stats")
    check("session_stats() 当前会话", r3.get("sessionId") == sid, r3)
    # 未知会话
    r4 = call("session_stats", {"sessionId": str(uuid.uuid4())})
    check("session_stats 未知会话报错", "not found" in r4.get("error", ""), r4)

    # session_list 行含统计摘要
    rl = call("session_list", {"cwd": WS})
    rows = [x for x in rl.get("sessions", []) if x.get("id") == sid]
    check("session_list 命中测试会话", len(rows) == 1, rl)
    if rows:
        row = rows[0]
        has = all(k in row for k in ("inputTokens", "outputTokens", "llmTime", "messageCount"))
        check("session_list 行含 inputTokens/outputTokens/llmTime", has, row)
        check("session_list 行 token 数与 stats 一致(≥)", row.get("outputTokens", 0) >= (stats or {}).get("outputTokens", 0), row)

    # ── 6. preset_set ──
    # 6a. 未知 preset
    r = call("preset_set", {"presetId": "no-such-preset-xyz"})
    check("preset_set 未知 preset 报错", "unknown preset" in r.get("error", ""), r)
    # 6b. new-default 切到 code 再切回
    avail = [p["id"] for p in (call("preset_list").get("presets") or [])]
    target = "code" if "code" in avail else (avail[0] if avail and avail[0] != std_default else None)
    if target:
        r = call("preset_set", {"presetId": target, "scope": "new-default"})
        check("preset_set new-default ok", r.get("ok") is True and r.get("runtimeDefault") == target, r)
        r = call("preset_get")
        check("preset_get 反映新默认", r.get("preset") == target, r)
        r = call("preset_set", {"presetId": std_default or "standard", "scope": "new-default"})
        check("preset_set 还原默认", r.get("ok") is True, r)
    # 6c. scope=session 非空白会话(刚跑过一轮的 sid)必须报错
    r = call("preset_set", {"presetId": target or "standard", "scope": "session", "sessionId": sid})
    check("preset_set session 非空白报错", "already started" in r.get("error", ""), r)
    # 6d. scope=session 缺 sessionId 报错
    r = call("preset_set", {"presetId": target or "standard", "scope": "session"})
    check("preset_set session 缺 sessionId 报错", "requires sessionId" in r.get("error", ""), r)

    # ── 7. task_inbox/task_result/task_list 异步链路 ──
    r = call("task_inbox", {"task": "不要使用任何工具。只输出单词 DONE。", "cwd": WS, "title": "a2a-p1-test-async"})
    tid = r.get("taskId")
    check("task_inbox 返回 taskId", bool(tid), r)
    result = None
    for _ in range(60):
        time.sleep(2)
        tr = call("task_result", {"taskId": tid})
        if tr.get("status") in ("done", "error"):
            result = tr
            break
    check("task_result 终态 done", result and result.get("status") == "done", result)
    check("异步任务结果也带 stats", isinstance((result or {}).get("result", {}).get("stats"), dict), result)
    tl = call("task_list")
    mine = [t for t in tl.get("tasks", []) if t.get("id") == tid]
    check("task_list 出现已完成任务", mine and mine[0].get("status") == "done" and mine[0].get("hasResult") is True, mine)

    # ── 8. 汇总 ──
    print(f"\n══ 结果: PASS={len(PASS)} FAIL={len(FAIL)} ══")
    for f in FAIL:
        print("FAIL:", f)
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()

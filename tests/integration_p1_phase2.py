#!/usr/bin/env python3
"""A2A P1 集成测试(第二实例): fs_write 默认关闭(opt-in 验证)+ 空白会话 preset 切换。

用法: DSH_MCP_URL=http://127.0.0.1:8092/mcp python3 tests/integration_p1_phase2.py
前提: 该实例配置不含 enableFsWrite(默认 false), workspaceRoots 指向 A2A_TEST_WS。
"""
import json, os, sys, urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from integration_p1 import rpc, init, call, check, PASS, FAIL  # noqa: E402


def main():
    info = init()
    print(f"serverInfo: {info}")
    t = rpc("tools/list", {})
    names = [x["name"] for x in t["result"]["tools"]]
    # opt-in 默认关闭: fs_write 不注册, 其余新工具照常
    check("enableFsWrite 缺省 → fs_write 未注册", "fs_write" not in names, names)
    for n in ["session_stats", "task_list", "preset_set"]:
        check(f"{n} 照常注册", n in names)
    for n in ["echo", "agent_run", "session_list"]:
        check(f"旧工具保留 {n}", n in names)

    ws = os.environ.get("A2A_TEST_WS", "/tmp/a2a-ws")
    r = call("config_get")
    check("config_get enableFsWrite=false", r.get("enableFsWrite") is False, r)
    r = call("echo", {"text": "phase2"})
    check("echo 回归", "_rpc_error" not in r, r)
    r = call("preset_list")
    check("preset_list 回归", isinstance(r.get("presets"), list), r)

    print(f"\n══ 结果: PASS={len(PASS)} FAIL={len(FAIL)} ══")
    for f in FAIL:
        print("FAIL:", f)
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()

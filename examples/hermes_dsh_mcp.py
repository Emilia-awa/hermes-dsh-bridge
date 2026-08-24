#!/usr/bin/env python3
"""Minimal dependency-free MCP client for hermes-dsh-bridge (stdlib only).

Usage:
  python3 hermes_dsh_mcp.py list                       # list tools
  python3 hermes_dsh_mcp.py call <tool> '<json>'       # call any tool
  python3 hermes_dsh_mcp.py run '<task>'               # shortcut: agent_run

Environment:
  DSH_MCP_URL   MCP endpoint (default: http://127.0.0.1:8090/mcp)
  DSH_MCP_TOKEN optional Bearer token (set if authToken configured)

Pitfalls this client already handles (see docs/TROUBLESHOOTING.md):
  1. echoes back Mcp-Session-Id on every request
  2. notifications/initialized is a notification (no id, no response) — 400/404/405 ignored
  3. SSE responses: parses every "data: " line and keeps the LAST event
  4. urllib resp.headers is http.client.HTTPMessage, not a dict
  5. agent_run args: task(required)/context/cwd/sessionId/title
"""
import json, os, sys, uuid, urllib.request, urllib.error

URL = os.environ.get("DSH_MCP_URL", "http://127.0.0.1:8090/mcp")
TOKEN = os.environ.get("DSH_MCP_TOKEN", "")
_session = {}


def rpc(method, params, rid=None, expect_response=True):
    rid = rid or uuid.uuid4().hex[:12]
    body = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
    if not expect_response:
        body.pop("id", None)
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if _session.get("id"):
        headers["Mcp-Session-Id"] = _session["id"]
    if TOKEN:
        headers["Authorization"] = "Bearer " + TOKEN
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            sid = resp.headers.get("Mcp-Session-Id")
            if sid:
                _session["id"] = sid
            data = resp.read().decode()
    except urllib.error.HTTPError as e:
        if not expect_response and e.code in (400, 404, 405):
            return None  # notification rejected — fine, ignore
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
        return out[-1] if out else {"error": "no sse data: " + data[:200]}
    try:
        return json.loads(data)
    except Exception:
        return {"raw": data[:500]}


def init():
    rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "hermes-cli", "version": "1.0"}})
    rpc("notifications/initialized", {}, expect_response=False)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        init()
        t = rpc("tools/list", {}, uuid.uuid4().hex[:12])
        for tool in t.get("result", {}).get("tools", []):
            print(f"{tool['name']}: {tool.get('description','')[:120]}")
            schema = tool.get("inputSchema", {})
            print(f"  params: {list(schema.get('properties', {}).keys())} required={schema.get('required', [])}")
    elif cmd == "call":
        tool = sys.argv[2]
        args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        init()
        res = rpc("tools/call", {"name": tool, "arguments": args})
        print(json.dumps(res, ensure_ascii=False, indent=1)[:12000])
    elif cmd == "run":
        task = sys.argv[2]
        init()
        res = rpc("tools/call", {"name": "agent_run", "arguments": {"task": task}})
        print(json.dumps(res, ensure_ascii=False, indent=1)[:12000])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
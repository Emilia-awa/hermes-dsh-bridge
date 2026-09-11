# hermes-dsh-bridge

**一句话**：把 DeepSeek Harness 的 Agent 能力封装成一个 MCP server（跑在 Harness **内部**），
让外部 MCP 客户端（Hermes / Claude Code / Codex / dsh 等）驱动 Harness 去真正干活。
**Hermes 是大脑，Harness 是双手。**

[![license](https://img.shields.io/badge/license-GPLv3-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-orange)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/hermes-dsh-bridge)](https://www.npmjs.com/package/hermes-dsh-bridge)
[![CI](https://github.com/Emilia-awa/hermes-dsh-bridge/workflows/CI/badge.svg)](https://github.com/Emilia-awa/hermes-dsh-bridge/actions)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.2--rc.1-blue)](https://www.npmjs.com/package/@deepseek-ai/dsh)

```
Hermes (MCP client, 大脑)  ──HTTP──▶  harness-mcp-server (:8090)
                                         │  ctx.agents.create → mount preset
                                         ▼
                                   Harness agent（bash / fs / todo / web… 完整工具集）
```

**当前版本 0.7.0**：兼容 **dsh ≥ 0.1.2-rc.1**（已在 **0.1.5-rc.2** 实测）；26 个工具。

---

## 30 秒 quickstart

前置：Node ≥ 22.18、dsh ≥ 0.1.2-rc.1、一个已配置好的 Harness profile。
下面 4 步跑通最小闭环（假设 profile 名是 `<PROFILE>`，端口用默认 8090）。

```bash
# ① 装插件到 profile
cd ~/.dsh/profiles/<PROFILE>/node_modules && npm install hermes-dsh-bridge

# ② 修 dual-package hazard（必做，否则 agent 会「嘴炮」没有工具）
GLOBAL_TREE=$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai
for pkg in cordis cosmokit dsh-agent dsh-llm dsh-session dsh-tools dsh-scope \
           dsh-agent-presets dsh-code-runtime dsh-system-prompt dsh-typert-protocol \
           dsh-attachment dsh-brand dsh-invariants dsh-timeout dsh-settings \
           dsh-home-paths dsh-atomic-write dsh-user-approval \
           cordis-plugin-include cordis-plugin-loader; do
  rm -rf "@deepseek-ai/$pkg" 2>/dev/null; ln -sfn "$GLOBAL_TREE/$pkg" "@deepseek-ai/$pkg"
done

# ③ 在 profile 的 cordis.patch.yml 末尾追加配置
cat >> ~/.dsh/profiles/<PROFILE>/cordis.patch.yml <<'EOF'
- insert:
    - id: hermes-dsh-bridge
      name: 'hermes-dsh-bridge'
      config:
        http: true
        port: 8090
        host: 127.0.0.1
        provider: <your-provider-id>   # ← 你的 Harness 里已配置的 provider
        model: <your-model-id>         # ← 你的 Harness 里已配置的 model
EOF

# ④ 重启 + 自检（doctor 会逐项告诉你哪里没配好）
systemctl restart dsh.service
node scripts/doctor.mjs --profile <PROFILE>
```

看到 `全部通过` 后，验证一次真实连通（最便宜的调用是 `echo`）：

```bash
curl -s -X POST http://127.0.0.1:8090/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"quickstart","version":"1.0"}}}'
# 期望：data: {... "serverInfo":{"name":"harness","version":"0.7.0"}}

python3 examples/hermes_dsh_mcp.py list                 # 应列出 25 个工具
python3 examples/hermes_dsh_mcp.py call echo '{"text":"hi"}'
python3 examples/hermes_dsh_mcp.py run '回复:安装成功'   # 真跑一次 agent（会调 LLM，稍慢）
```

跑通后按需进入下面的分场景进阶。

---

## 前置依赖

| 依赖 | 要求 | 检查命令 | 不满足会怎样 |
|---|---|---|---|
| **Node.js** | **≥ 22.18** | `node --version` | 缺 `zstd` / `stripTypeScriptTypes`，dsh 或插件直接启动失败 |
| **dsh** | **≥ 0.1.2-rc.1**（实测 0.1.5-rc.2） | `dsh --version` | 旧 API：会话存储契约不符、`session_list` 崩溃；v0.5.0 及更早只兼容 dsh ≤ 0.1.1-rc.2 |
| **Harness profile** | 已用 `dsh --profile <name>` 启动过一次 | `ls ~/.dsh/profiles/` | 没有 profile 目录可装 |
| **Harness 全局树** | 含 `@deepseek-ai/*` 包 | `npm root -g` | symlink 修复无从下手 → dual-package hazard |
| **LLM provider** | profile 的 `cordis.patch.yml` 里已配好 `llm-*` 段 | `grep -n 'llm-' ~/.dsh/profiles/<PROFILE>/cordis.patch.yml` | agent 组装崩：`prompt variable "{{model}}" has no value` 或 `MISSING_CREDENTIAL` |
| **bubblewrap**（可选） | 宿主机装了才能跑受限 bash | `which bwrap` | `workspace-write` 档下写命令被拒（读命令仍可用） |

### Hermes 端配置片段

把 MCP server 注册到 Hermes（或任何 MCP 客户端）。最小配置：

```jsonc
{
  "mcpServers": {
    "harness": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:8090/mcp",
      "headers": { "Authorization": "Bearer <你的 authToken；未开启认证则省略>" }
    }
  }
}
```

没有现成客户端时，仓库自带零依赖 Python 客户端可直接用：

```bash
python3 examples/hermes_dsh_mcp.py list
python3 examples/hermes_dsh_mcp.py call status_get '{}'
# 非默认地址/认证：
DSH_MCP_URL=http://127.0.0.1:8090/mcp DSH_MCP_TOKEN=xxx python3 examples/hermes_dsh_mcp.py list
```

---

## 安装（三种路径，按人群选）

### 方式 A — npm 安装（推荐给绝大多数人）

适用于：**只想用，不想改代码**。

```bash
cd ~/.dsh/profiles/<PROFILE>/node_modules
npm install hermes-dsh-bridge
```

装完**必须**做 dual-package hazard 修复（见上面 quickstart 第 ② 步或下方 FAQ），
否则 agent 会失去全部工具。包主页：<https://www.npmjs.com/package/hermes-dsh-bridge>

### 方式 B — 源码构建

适用于：**要改代码 / 要跑最新未发布提交 / 排查问题**。

```bash
git clone https://github.com/Emilia-awa/hermes-dsh-bridge.git
cd hermes-dsh-bridge
npm install && npm run build        # tsc -b && tsdown → 产出 lib/index.js
npm test                            # 三套 mock 单测（不需要真实 dsh）

# 把整个目录放进 profile：
rm -rf ~/.dsh/profiles/<PROFILE>/node_modules/hermes-dsh-bridge
cp -r . ~/.dsh/profiles/<PROFILE>/node_modules/hermes-dsh-bridge
# 然后同样做 dual-package hazard symlink 修复并重启
```

### 方式 C — Hermes 一键配置片段

适用于：**AI agent 帮人装**、或想直接抄一份完整可用的 patch。

```bash
# ① 装包（同方式 A）
cd ~/.dsh/profiles/<PROFILE>/node_modules && npm install hermes-dsh-bridge

# ② 修 symlink（同 quickstart 第 ② 步，略）

# ③ 追加完整配置段
cat >> ~/.dsh/profiles/<PROFILE>/cordis.patch.yml <<'EOF'
- insert:
    - id: hermes-dsh-bridge
      name: 'hermes-dsh-bridge'
      config:
        http: true
        port: 8090
        host: 127.0.0.1
        # authToken: '<随机长token>'      # 非 loopback 暴露时必须开
        workspaceRoots: ['<你的工作区>']  # 限制 agent 能在哪干活
        enableFsWrite: false              # 需 fs_write 才开
        defaultSandbox: workspace-write   # read-only | workspace-write | danger-full-access
        approvalsBridge: web              # web | builtin | file-push | off
        approvalTimeoutMs: 300000         # 超时按拒绝收尾，绝不放行
        provider: <your-provider-id>      # ⚠️ 必填：你 Harness 里已配置的
        model: <your-model-id>            # ⚠️ 必填：该 provider 下的 model
EOF

# ④ 重启并自检
systemctl restart dsh.service
node scripts/doctor.mjs --profile <PROFILE>   # 应全部通过
```

> **给 AI agent 的硬性约束**：`provider` / `model` 一律写成占位符 `<your-provider-id>` /
> `<your-model-id>`，**不要**写死某台机器的真实配置；装完必须跑 `doctor.mjs` 并把失败项的修复建议读完。

---

## 自检：`node scripts/doctor.mjs`

零依赖，`node` 直接跑，**只读**（不改文件、不重启服务）。逐项输出 ✓/✗ + 修复建议，
最后汇总「N 项通过，M 项失败」，退出码 `0`=全通过 / `1`=有失败。

```bash
node scripts/doctor.mjs                      # 默认 127.0.0.1:8090，自动探测 profile
node scripts/doctor.mjs --profile web        # 指定 profile
node scripts/doctor.mjs --port 8091 --host 127.0.0.1
DSH_MCP_TOKEN=xxx node scripts/doctor.mjs    # 开了 authToken 的部署
```

检查 7 项：Node 版本 / dsh 可执行与版本 / profile 存在 / settings 文件 / patch 是否配了插件 /
端口监听 / MCP 握手 + `tools/list`。

### 本机真实运行输出（作为预期输出示例）

以下是在本机（Node v22.22.3 / dsh 0.1.5-rc.2，插件确实装在该 profile）实际跑出来的原文：

```console
$ node scripts/doctor.mjs --profile web
环境
  ✓ Node 版本 — v22.22.3 (需要 >= v22.18.0)

dsh
  ✓ dsh 可执行 + 版本 — dsh 0.1.5-rc.2 (本插件需要 >= 0.1.2-rc.1; 已在 0.1.5-rc.2 实测)
  ✓ dsh profile 存在 — /root/.dsh/profiles/web (--profile 指定)
  ✓ dsh settings 文件 — /root/.dsh/settings.yaml
  ✓ profile patch 已配置插件 — /root/.dsh/profiles/web/cordis.patch.yml → - id: harness-mcp-server
  ✗ dsh --dump-config 可运行 — node:fs:2430 (profile 目录不可写)
      ↳ 修复: dump-config 需要写 /root/.dsh/profiles/web/cordis.yml; 用对该目录有写权限的用户跑, 或直接看下面「MCP 握手」的运行态结论(运行态通过即插件已装载)

运行时
  ✓ 8090 端口监听 — 127.0.0.1:8090 已监听
  ✓ MCP 握手 — serverInfo.name=harness version=0.5.0
  ✓ tools/list 工具可用 — 25 个工具(期望 25~26; 含 agent_run, session_stats, preset_set, fs_read, approval_respond)

────────────────────────────────────────────────────────────
结果: 8 项通过, 1 项失败

失败项一览:
  ✗ dsh --dump-config 可运行: node:fs:2430 (profile 目录不可写)

工具清单(25): echo, harness_list_tools, status_get, config_get, fs_read, fs_list, fs_stat, session_list, session_log, session_stats, session_search, preset_list, preset_get, preset_set, policy_get, set_policy, approval_list, approval_respond, agent_run, task_inbox, task_result, task_list, task_cancel, rename_session, attach_session

按上面每项的 ↳ 修复建议处理后重跑本脚本。
```

**怎么读这份输出**：

- `dsh --dump-config` 那一项 ✗ 是**权限问题**（该目录属 root，当前用户不可写 `cordis.yml`），
  不是插件问题 —— 它只用于静态确认，**运行态的「MCP 握手 + tools/list」通过就说明插件已装载**。
  本机以 `web` profile 启动的服务其实已经在跑本插件（`version=0.5.0` 是该进程启动时的旧版本号，
  升级后重启即变 `0.7.0`）。
- `tools/list` 是 25 个（`enableFsWrite` 未开）；开了 `enableFsWrite: true` 会是 26 个。
- 若 `tools/list` 失败但端口在听，通常是 `authToken` 开了却没带 token —— 用 `--token` 或 `DSH_MCP_TOKEN` 重跑。

---

## 工具（26 个）

默认注册 **25 个**；`enableFsWrite: true` 时多一个 `fs_write`。

| 分类 | 工具 |
|---|---|
| 任务 | `agent_run`（同步）、`task_inbox`（异步队列）、`task_result`、`task_list`、`task_cancel` |
| 会话 | `session_list`、`session_log`、`session_stats`、`session_search`、`rename_session`、`attach_session` |
| 文件 | `fs_read`、`fs_list`、`fs_stat`、`fs_write`（opt-in） |
| 预设 | `preset_list`、`preset_get`、`preset_set` |
| 权限/审批 | `policy_get`、`set_policy`、`approval_list`、`approval_respond` |
| 状态 | `status_get`、`config_get` |
| 元 | `echo`、`harness_list_tools` |

完整的入参表 / 返回字段 / 错误码见 **[docs/TOOLS.md](docs/TOOLS.md)**。

### 典型闭环

```
Hermes 记忆 ──context──▶ task_inbox ──▶ Harness agent 执行 ──▶ 结构化结果 {changes, verification, leftovers}
                                                                        │
                              task_result 轮询 ◀────────────────────────┘
                                                                        ▼
                                                        结果回写 Hermes 记忆（下一轮 context）
```

`agent_run` 返回示例：

```json
{
  "sessionId": "…",
  "assistantText": "最终回答",
  "toolCalls": [{ "name": "bash", "args": "…" }],
  "toolResults": ["命令输出"],
  "changes": "改了什么",
  "verification": "怎么验证的",
  "leftovers": "遗留问题",
  "stats": {
    "rounds": 1, "steps": 3,
    "llmTime": 13.9, "llmTimeMs": 13900,
    "toolTime": 0.04, "toolTimeMs": 40,
    "ttft": 3349, "tokensPerSec": 40.7,
    "cacheHitRate": 1, "inputTokens": 8831, "outputTokens": 157
  }
}
```

---

## 进阶：权限三档与审批桥

### 三档语义

会话文件权限档与 Harness 原生 `SandboxMode` 一一对应，通过会话日志的 `sandbox/mode`
事件固化（重启靠 replay 保持）：

| 档位 | 语义 |
|---|---|
| `read-only` | 只读（仅 `/dev/null` 等必要 sink 可写） |
| `workspace-write` | 工作区 + 后端临时区可写（**默认**，`defaultSandbox` 可改） |
| `danger-full-access` | **完全绕过文件围栏 + bash 解禁，全程无审批任意读写** —— 仅限可信环境 |

- `agent_run` / `task_inbox` 的 `sandbox` 参数是**请求级覆盖**：仅影响新建/resume 的会话组合；
  已有会话保持原档位（显式切换用 `set_policy`）。同 cwd 三档互不污染。
- `session_list` 行在会话有 `sandbox/mode` 记录时带 `sandboxMode` 列。

### 审批转接（approvals 桥）

```
Harness agent 需要提权 → approval/request → [审批桥挂起]
Hermes: approval_list() 轮询 → approval_respond(approvalId, sessionId, 'allowed-once'|'rejected')
→ agent 继续（或收到拒绝）；Web UI 与 Hermes 双通道先答者胜
```

- `approvalsBridge` 四档：`web`（默认，订阅 apiProxy mux；apiProxy 缺失时自动降级 `builtin`）/
  `builtin`（插件内建应答器）/ `file-push`（内建应答 + `pending_<id>.json` 文件通知）/
  `off`（关闭桥，审批回到部署默认 fail-closed）。
- 审批未决期间 `agent_run` **同步阻塞**（长阻塞场景请用 `task_inbox` 异步路径）；
  `approvalTimeoutMs`（默认 **300000ms = 5 分钟**）超时收尾为取消/拒绝 —— **绝不超时放行**。
- ⚠️ `approval_respond` 等于远程提权按钮：MCP server 暴露非 loopback 时必须开 `authToken`
  （见 [docs/SECURITY.md](docs/SECURITY.md)）。

完整配置字段见 **[docs/CONFIG.md](docs/CONFIG.md)**。

---

## FAQ：常见错误排查

把 `src/index.ts` 里所有面向用户的错误文案过了一遍，每条给「原因 + 修复步骤」。
所有错误的统一形状是 `<错误>: <关键值> (<原因一句话>; <下一步动作>)`。

| 症状 / 错误文案 | 原因 | 修复步骤 |
|---|---|---|
| `agent_run` 返回文本但 `toolCalls` 恒空；agent 只输出 `<tool_calls>` 文本 | **dual-package hazard**：插件自己的 `node_modules` 和 Harness 全局树各有一份 `@deepseek-ai/*`，`Symbol` 不匹配 → `scopeOf` 为 `undefined` → preset 挂载被跳过 | ① 重做 symlink 修复（quickstart 第 ② 步）② 重启 Harness。**dsh 升级/重装后 symlink 可能被还原，需再跑一次**。日志特征：`agent ctx unscoped (dsh rc.6 bug); preset mount skipped` |
| `prompt variable "{{model}}" has no value` | patch 没写 `provider`/`model`（插件默认 provider 是 `deepseek-official`、model 为空） | 在 patch 的 `config` 里补 `provider: <your-provider-id>` 和 `model: <your-model-id>`，**必须是你的 Harness 里已配置好的**，然后重启 |
| `MISSING_CREDENTIAL: <provider>` | API key 没注入 Harness 进程 env | 在 systemd unit 加 `Environment=<KEY>=...`（或 `EnvironmentFile=`），或 `export` 后重启服务 |
| `Cannot find package '@deepseek-ai/cordis-plugin-include'` | symlink 修复漏了 `cordis-plugin-*`；它们没发布到 npm registry，只存在于 Harness 全局树 | 补做 quickstart 第 ② 步里的 `cordis-plugin-include` / `cordis-plugin-loader` 两个 symlink |
| 版本号对但行为像旧版 | 系统里有双 npm 全局树，装错树 | `which dsh` + `npm prefix -g` 核对；用 `systemctl show dsh.service -p ExecStart` 看**服务实际启动的** bin.js 路径，统一到那棵树 |
| `session_list failed: Cannot read properties of undefined (reading 'length')` | dsh 0.1.5 改了 `sessionPersistence` 契约（`list()` 返回 snapshot、`inspect()` 移除）；v0.7.0 已修 | 升级到 `hermes-dsh-bridge@0.7.0` 并重启。若仍报，是 `lib/index.js` 陈旧 → `npm run build` 或重装 |
| `tools/list` 只返回很少工具，或缺 `fs_write` | `enableFsWrite` 默认 `false`（fs_write 是 opt-in）；或插件没被加载 | `fs_write` 缺失属正常；其他缺失看 doctor 的 `profile patch 已配置插件` 与 `dsh 已装载插件` 两项 |
| MCP 请求返回 `401 {"message":"Unauthorized"}` | 部署开了 `authToken` 但请求没带 | 请求头加 `Authorization: Bearer <token>`；doctor 用 `--token` / `DSH_MCP_TOKEN` |
| MCP 请求返回 `404 Session not found` | 用了失效的 `Mcp-Session-Id` | 客户端必须回显 `initialize` 响应头里的 `Mcp-Session-Id`；会话过期就重新 `initialize` |
| `session not found: <id>` | 会话不存在或已清理（`rename_session` 还要求会话是 **live**） | `session_list` 取有效 id；冷会话先 `agent_run(sessionId=...)` 唤醒再改名；`attach_session` 支持 live 或持久化 |
| `session is empty: <key>` | 会话存在但完全没有事件（或该 `cwd` 下没有会话） | 先跑一轮 `agent_run` / `task_inbox` 带上这个 `sessionId`，或去掉 `cwd` 过滤 / 换一个会话 |
| `task not found: <id>` | 任务结果已过 TTL（默认 10 分钟）被清理，或 id 从不存在 | `task_list` 看队列现状；结果要在保留期内取走 |
| `unknown preset: <id>` | preset id 不在当前部署名单里 | `preset_list` 拿合法 id；单次任务用 `agent_run(preset=...)` |
| `session has already started: <id>` | `preset_set(scope=session)` 只能改**空白**会话（log 里没出现过 `turn/start`） | 已跑过的会话 preset 已固化 → 改用 `agent_run(preset=...)` 起新会话，或用 `scope=new-default` 改默认 |
| `session <id> is not live; cold/persisted sessions must be resumed first` | `set_policy` 只能改 **live** 会话 | 先 `agent_run(task=..., sessionId=...)` 让它活起来再 `set_policy`；或直接在那一轮用 `sandbox=...` 定档 |
| `path outside allowed roots (~/.dsh + workspaces): <p>` | `fs_*` 路径越过了 path jail | 换到 `workspaceRoots` 内的路径；`config_get` 看允许哪些目录 |
| `path denied by policy (sensitive name): <p>` | 命中敏感名黑名单（`.ssh` / `.env` / 含 `token` / `*.pem`） | 这批路径设计上永不开放，换文件 |
| `file too large: <size>` / `content too large: <size>` | `fs_read` 单文件 > 8MB / `fs_write` 单次 > 4MB | `fs_read` 用 `offset`/`limit` 分段；`fs_write` 拆成多次 `mode=append` |
| `<tool> failed: dsh service unreachable (...)` | `ECONNREFUSED`/`ECONNRESET`/`socket hang up` —— Harness 没起或断了 | `systemctl status dsh.service`，必要时 `systemctl restart dsh.service`，再 `status_get` 确认 |
| `task queue full (N/100)` | 活动任务（queued+running）达到 `maxQueue` | 等任务结束、`task_cancel` 取消一些，或调大 `maxQueue` |
| `receipt=not-pending`（`approval_respond`） | 你慢了：审批已被 Web UI / 另一路回答，或已超时/撤回（**先答者胜**） | `approval_list` 刷新拿最新 `approvalId`；`note` 字段会说明原因 |
| `sessionId mismatch: <approvalId>` | `approval_respond` 的 `sessionId` 与该审批不匹配 | 用 `approval_list` 里**同一行**的 `sessionId` 重试 |
| 审批一直挂起不返回 | 没人在回答；超时前会一直等 | `approval_list` 看 `pending`（>0 就回答）；`status_get.sandboxPolicy.pendingApprovals` 也能一眼看到 |
| `TRANSPORT: terminated` 中途断流 | LLM provider 抖了一下，流断 | **用同一个 `sessionId` 续接**，不要新开会话（新会话会重读所有代码） |
| `assistantText` 只到 ~8000 字符 | 结果字段有意限长（`assistantText` ≤ 8000，`toolCalls` ≤ 50×2000，`toolResults` ≤ 20×2000） | 用 `session_log(sessionId=..., preset="dialog")` 取完整文本 |
| `rename_session` 报 `sessionTitle service unavailable` | 该部署没加载会话标题服务 | 不影响其他功能；改用 `agent_run(title=...)` 在创建时命名 |
| `workspaceRegistry unavailable` | 该部署没加载工作区注册表服务 | 不影响任务执行；`attach_session`（纯整理）不可用而已 |

### 0.1.5 用户从旧版升级特别注意

| 变化 | 旧行为（≤ 0.1.1-rc.2 / dsh ≤ 0.1.1） | 新行为（dsh ≥ 0.1.2，0.1.5 起强制） | 你要做什么 |
|---|---|---|---|
| **会话存储格式** | `session.jsonl.zstd` + 目录带 `session-` 前缀 | **`session.v3.jsonl.zstd`** + 目录**无** `session-` 前缀 | 不用迁数据；升级插件到 0.7.0 即自动兼容两代格式 |
| **`sessionPersistence` 契约** | `list()` 返回裸 header；有 `inspect(id)` | `list()` 返回 snapshot `{header, revision, sizeBytes}`；`inspect()` 移除，改 `open(id,'read')` + `handle.read()` | 升级插件；0.7.0 已做双契约兼容层 |
| **`session_list` 行为** | 单行读取失败可能整表崩 | 逐行容错：坏行跳过并计入新的 `skipped` 字段（`0` = 全部正常） | 检查结果的 `skipped`；非 0 说明有个别会话读不出来，但列表仍可用 |
| **`ctx.agent`（单数）** | 存在 | 移除 | 与本插件无关（只用 `ctx.agents`），但要保证 dsh ≥ 0.1.2 |
| **`apiProxy` 服务** | 随包提供，审批桥走 `web` | 0.1.5 不再随包发布 | 审批桥自动降级 `builtin`（本机部署用 `file-push`）→ `status_get.sandboxPolicy.bridge` 会显示实际生效值 |
| **Web UI 面板 slot** | `'conversation'` | `'main'` | 与本插件无关（不注册任何 UI slot） |

---

## 升级指南

### 0.5.x / 0.6.x → 0.7.0

**破坏性变更：无。** 工具名、参数名、既有返回字段全部保持不变 —— 0.7.0 只**新增**字段
（`next` / `landing` / `skipped` / `preset` / `offset` / `pending` 等）并统一错误串后缀。
按下面步骤迁移：

```bash
# 1) 升级插件
cd ~/.dsh/profiles/<PROFILE>/node_modules && npm install hermes-dsh-bridge@0.7.0

# 2) 重做 symlink（npm install 会把 symlink 还原成实体目录）
#    见 quickstart 第 ② 步

# 3) 检查 dsh 版本（0.7.0 要求 >= 0.1.2-rc.1）
dsh --version

# 4) 重启 + 自检
systemctl restart dsh.service
node scripts/doctor.mjs --profile <PROFILE>
python3 examples/hermes_dsh_mcp.py call status_get '{}'   # version 应为 0.7.0
```

**需要留意的行为变化（非破坏性，但客户端如有硬编码需调整）**：

| 变化 | 影响 | 应对 |
|---|---|---|
| 时间戳改为 ISO8601 本地时区 + `*_epoch` 原值 | 原来读 epoch 数字的客户端若直接展示会看到日期串 | 用 `*_epoch` 字段排序/计算，用 `*At` 字段展示 |
| 列表类返回统一分页（默认 20，最大 100），带 `next` | 之前"一次全返回"，现在可能截断 | 读 `truncated`/`next` 翻页；需要更多一次给 `limit` |
| `session_log` 默认最多 50 条事件 | 长会话默认只给首尾 | 调大 `tail`（最大 500）、`head=0` 只看最新，或用 `preset`/`types` 收窄 |
| 错误串统一加了 `(<原因>; <下一步>)` 后缀 | 用 `==` 精确比对错误串的客户端会失配 | 用前缀匹配（`task not found` / `session not found` / `unknown preset` / `query must not be empty` 均保留） |
| `config_get` 不再回显 `authToken: '***'` | 只有 `authTokenSet: boolean` | 用布尔值判断是否开启 |
| 默认 `cwd` 改为 `workspaceRoots[0]`（配了才生效） | 之前是 `process.cwd()`（对远程调用无意义） | 不配 `workspaceRoots` 则行为不变；配了就是显式工作区 |
| `approvalTimeoutMs` 默认 **300000ms（5 分钟）** | 老文档曾写 120s，是文档错误 | 想回到 2 分钟请显式设 `approvalTimeoutMs: 120000` |

### 0.5.0 以下 → 0.7.0

**跨大版本，有破坏性变更**：v0.5.0 及更早只兼容 **dsh ≤ 0.1.1-rc.2**（旧 API）。

1. 先升级 dsh 到 ≥ 0.1.2-rc.1（建议 0.1.5-rc.2），否则旧插件在 0.1.5 上会因会话存储契约变更崩溃。
2. 升级插件到 0.7.0。
3. 确认 patch 里审批桥配置：0.1.2 起 `apiProxy` 不再注入，`approvalsBridge: web` 会静默降级 `builtin`；
   如需文件通知改用 `file-push`（配套 `approvalFileDir`）。
4. 旧 `sandbox` 相关默认值不变（`workspace-write`），无需迁移数据。
5. 重做 symlink → 重启 → `node scripts/doctor.mjs`。

完整历史见 [CHANGELOG.md](CHANGELOG.md)。

---

## 文档

- [docs/CONFIG.md](docs/CONFIG.md) — 全部配置字段（与代码逐字段核对）、安全默认值、可复制示例
- [docs/TOOLS.md](docs/TOOLS.md) — 26 个工具的完整参考（入参表 / 返回字段 / 错误码）
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — 深度排障（SSE 解析、8KB 截断、dual-package hazard…）
- [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) — 已发现但本轮不修的缺陷（含真实默认值口径）
- [docs/SECURITY.md](docs/SECURITY.md) — 威胁模型
- [scripts/doctor.mjs](scripts/doctor.mjs) — 安装自检
- [examples/hermes_dsh_mcp.py](examples/hermes_dsh_mcp.py) — 零依赖 Python MCP 客户端（仅标准库）

## 定位

适合做**备用工具**而非日常主力：日常改代码请直接驱动你的主 Agent。需要**上下文隔离**
（大重构会撑爆客户端上下文）或**并行执行**不相关任务时再找它。

- Agent 会话按 cwd **复用**（避免每次调用重新加载项目上下文）。
- Bash 沙箱化（`workspace-write`）：宿主机装 `bubblewrap`，否则写命令会被拒。
- reasoning/thinking 块在返回前**剥离**（插件侧 + 文本级兜底双层过滤）。

## License

[GPL-3.0-only](./LICENSE)，上游 MIT 部分保留——见 [NOTICE.md](./NOTICE.md)。

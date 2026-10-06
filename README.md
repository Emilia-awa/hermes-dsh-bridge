# hermes-dsh-bridge

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 Agent 能力
封装成一个 **MCP server**，跑在 Harness **内部**。任何 MCP 客户端都能通过它驱动 Harness 真正干活。

**大脑和手分工**：你的主 Agent 负责思考与决策，Harness 负责执行 —— 上下文隔离、可并行、
不吃你主会话的 token。

```
你的 MCP 客户端（大脑）──HTTP──▶  hermes-dsh-bridge (:8090)
                                      │  ctx.agents.create → mount preset
                                      ▼
                                Harness agent（bash / fs / todo / web… 完整工具集）
```

[![license](https://img.shields.io/badge/license-GPLv3-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-orange)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/hermes-dsh-bridge)](https://www.npmjs.com/package/hermes-dsh-bridge)
[![CI](https://github.com/Emilia-awa/hermes-dsh-bridge/workflows/CI/badge.svg)](https://github.com/Emilia-awa/hermes-dsh-bridge/actions)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.2--rc.1-blue)](https://www.npmjs.com/package/@deepseek-ai/dsh)

---

## 它能做什么

**25 个工具**（`enableFsWrite: true` 时 26 个），分六类：

| 分类 | 工具 | 一句话 |
|---|---|---|
| **任务** | `agent_run` | 同步跑一个任务，直接拿结构化结果 |
| | `task_inbox` / `task_result` / `task_list` / `task_cancel` | 异步队列：丢进去立刻返回，之后取结果、查队列、中途取消 |
| **会话** | `session_list` / `session_log` / `session_stats` / `session_search` | 列出、读日志、看统计、按关键词跨会话搜 |
| | `rename_session` / `attach_session` | 改名、归类到工作区 |
| **文件** | `fs_read` / `fs_list` / `fs_stat` | 读文件（带行号/分页）、列目录、查元数据 |
| | `fs_write` | 写文件（**默认关闭**，需显式打开） |
| **预设** | `preset_list` / `preset_get` / `preset_set` | 查/切 agent 能力组合（standard / code / minimal…） |
| **权限** | `policy_get` / `set_policy` | 查/改会话文件权限档 |
| | `approval_list` / `approval_respond` | 审批提权请求（agent 想干危险操作时） |
| **状态** | `status_get` / `config_get` | 运行态 / 配置摘要 |
| **元** | `echo` / `harness_list_tools` | 连通性自检、列出 Harness 自己的工具 |

完整入参/返回/错误码见 **[docs/TOOLS.md](docs/TOOLS.md)**。

### 四个值得单独说的能力

**① 异步队列 + 终态自动回调（不用轮询）**

`task_inbox` 把任务丢进队列立刻返回。跑完后可以**主动回调**你的 webhook（HMAC-SHA256 验签 +
SSRF 防护），而不是让你一直轮询：

```jsonc
{"task": "把 README 的安装章节改好",
 "callback": {"url": "https://your-host/webhook", "replyContext": {"chatId": "123"}}}
```

更省事的是配一次 `callbackPreset`，之后派发只传每次都变的那点东西：

```jsonc
{"task": "跑一遍回归测试"}                                        // 什么都不传，自动套预设
{"task": "...", "callback": {"replyContext": {"chatId": "123"}}}  // 只传变的
```

**② 提问挂起拦截（不会白等一夜）**

dsh agent 遇到歧义会调 `ask_user_question` 然后**一直等回答**。不处理的话任务状态永远是
`running`、CPU 0%、零产物 —— 肉眼和「正在干活」完全一样，能白等一整夜。

本插件注册应答器接管这类请求：**一提问就回调通知你**，并写盘等回答，**30 分钟无人应答自动报错收尾**
（而不是无限挂起）。

**③ 会话列表快 20–100 倍**

大会话库上旧实现 `limit:1` 要 13 秒、`limit:50` 要 31 秒（客户端 20 秒超时 = 永远不返回）。
本版实测 **< 1.5 秒**，且耗时**不再随会话库规模增长**。原理见[性能](#性能为什么快)。

**④ 权限三档 + 审批转接**

会话文件权限跟 Harness 原生 `SandboxMode` 一一对应，可逐会话切换：

| 档位 | 语义 |
|---|---|
| `read-only` | 只读 |
| `workspace-write` | 工作区可写（**默认**） |
| `danger-full-access` | 完全绕过围栏，**仅限可信环境** |

agent 需要提权时走审批桥（`web` / `builtin` / `file-push` / `off` 四档），
超时**收尾为拒绝，绝不超时放行**。

---

## 安装

**前置**：Node ≥ 22.18、dsh ≥ 0.1.2-rc.1、一个已跑过的 Harness profile。

### 30 秒跑通

```bash
PROFILE=<你的 profile 名>          # 例: web

# ① 装插件（dual-package hazard 修复已由 postinstall 自动完成）
cd ~/.dsh/profiles/$PROFILE
npm install hermes-dsh-bridge

# 装完可以核对一下（应显示「已是正确 symlink 23 / 保留本地副本 2」）：
node node_modules/hermes-dsh-bridge/scripts/link-host-deps.mjs --dry-run

# ② 在 profile 的 cordis.patch.yml 末尾追加配置
cat >> cordis.patch.yml <<'EOF'
- insert:
    - id: hermes-dsh-bridge
      name: 'hermes-dsh-bridge'
      config:
        http: true
        port: 8090
        host: 127.0.0.1
        provider: <你的 provider id>    # ← 必须是 Harness 里已配好的
        model: <你的 model id>          # ← 同上
EOF

# ③ 重启 + 自检
systemctl restart dsh.service
node node_modules/hermes-dsh-bridge/scripts/doctor.mjs --profile $PROFILE
```

> 后面所有 `node .../scripts/*.mjs` 和 `python3 .../examples/*.py` 都从**插件目录**跑，
> 例如 `cd ~/.dsh/profiles/$PROFILE/node_modules/hermes-dsh-bridge`。

看到 `结果: 10 项通过, 0 项失败` 后，验证真实连通（最便宜的调用是 `echo`）：

```bash
cd ~/.dsh/profiles/$PROFILE/node_modules/hermes-dsh-bridge
python3 examples/hermes_dsh_mcp.py list                  # 应列出 25 个工具
python3 examples/hermes_dsh_mcp.py call echo '{"text":"hi"}'
python3 examples/hermes_dsh_mcp.py run '回复:安装成功'    # 真跑一次 agent（会调 LLM）
```

> 用 npm 装的话 `examples/` 也在包里，路径就是上面这个。

### 注册到你的 MCP 客户端

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

仓库自带零依赖 Python 客户端（仅标准库），没现成客户端时可直接用：

```bash
python3 examples/hermes_dsh_mcp.py list
python3 examples/hermes_dsh_mcp.py call status_get '{}'
DSH_MCP_URL=http://127.0.0.1:8090/mcp DSH_MCP_TOKEN=xxx python3 examples/hermes_dsh_mcp.py list
```

### 其他安装方式

**源码构建**（要改代码 / 跑未发布提交）：

```bash
git clone https://github.com/Emilia-awa/hermes-dsh-bridge.git
cd hermes-dsh-bridge
npm install && npm run build     # 产出 lib/index.js
npm test                         # 全套单测（不需要真实 dsh）

rm -rf ~/.dsh/profiles/$PROFILE/node_modules/hermes-dsh-bridge
cp -r . ~/.dsh/profiles/$PROFILE/node_modules/hermes-dsh-bridge
# 然后做上面第 ② 步的 patch 配置并重启（symlink 由 npm install 的 postinstall 自动对齐）
```

**完整配置段**（想直接抄一份带全部选项的）：

```yaml
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
```

> **给 AI agent 的硬性约束**：`provider` / `model` 一律写成占位符，**不要**写死某台机器的
> 真实配置；装完必须跑 `doctor.mjs` 并把失败项的修复建议读完。

### 前置依赖

| 依赖 | 要求 | 检查 | 不满足会怎样 |
|---|---|---|---|
| **Node.js** | **≥ 22.18** | `node --version` | 缺 `zstd` / `stripTypeScriptTypes`，直接启动失败 |
| **dsh** | **≥ 0.1.2-rc.1** | `dsh --version` | 旧 API：会话存储契约不符、`session_list` 崩溃 |
| **Harness profile** | 已启动过一次 | `ls ~/.dsh/profiles/` | 没有目录可装 |
| **Harness 全局树** | 含 `@deepseek-ai/*` | `npm root -g` | symlink 修复无从下手 |
| **LLM provider** | profile 里已配好 `llm-*` 段 | `grep -n 'llm-' ~/.dsh/profiles/$PROFILE/cordis.patch.yml` | agent 组装崩：`{{model}} has no value` / `MISSING_CREDENTIAL` |
| **bubblewrap**（可选） | 装了才能跑受限 bash | `which bwrap` | `workspace-write` 档下写命令被拒（读仍可用） |

---

## 安装自检：`node scripts/doctor.mjs`

从**插件目录**跑（`cd ~/.dsh/profiles/$PROFILE/node_modules/hermes-dsh-bridge`）。

零依赖，**只读**（不改文件、不重启服务）。逐项输出 ✓/✗ + 修复建议，
退出码 `0`=全通过 / `1`=有失败。检查项：Node 版本 / dsh 可执行与版本 / profile 存在 /
patch 是否配了插件 / 依赖树 symlink / 宿主契约 / 端口监听 / MCP 握手 + `tools/list`。

```bash
node scripts/doctor.mjs                      # 默认 127.0.0.1:8090，自动探测 profile
node scripts/doctor.mjs --profile <PROFILE>  # 指定 profile
node scripts/doctor.mjs --port 8091 --host 127.0.0.1
DSH_MCP_TOKEN=xxx node scripts/doctor.mjs    # 开了 authToken 的部署
```

输出长这样（版本号随发版变化）：

```console
$ node scripts/doctor.mjs --profile <PROFILE>
环境
  ✓ Node 版本 — v22.22.3 (需要 >= v22.18.0)

dsh
  ✓ dsh 可执行 + 版本 — dsh 0.2.0-rc.2 (本插件需要 >= 0.1.2-rc.1)
  ✓ dsh profile 存在 — /home/you/.dsh/profiles/<PROFILE> (--profile 指定)
  ✓ profile patch 已配置插件 — .../cordis.patch.yml → - id: hermes-dsh-bridge
  ✓ dsh 已装载插件(dump-config) — dump-config 输出里找到 "- id: hermes-dsh-bridge"

依赖树
  ✓ 依赖树 symlink 状态 — symlink 23 | 本地副本 2 (dsh-agent-presets, dsh-code-runtime)
  ✓ 宿主契约探测 — 必需符号 3/3 + 必需服务 6/6 全部就绪(可选项 6 项)

运行时
  ✓ 8090 端口监听 — 127.0.0.1:8090 已监听
  ✓ MCP 握手 — serverInfo.name=harness version=0.11.4
  ✓ tools/list 工具可用 — 25 个工具(期望 25~26; 含 agent_run, session_stats, preset_set, fs_read, approval_respond)

────────────────────────────────────────────────────────────
结果: 10 项通过, 0 项失败
```

**怎么读**：`tools/list` 是 25 个（`enableFsWrite` 未开）；开了会是 26 个。
若 `tools/list` 失败但端口在听，通常是 `authToken` 开了却没带 token —— 用 `--token` 或
`DSH_MCP_TOKEN` 重跑。

---

## 用法

### 典型闭环

```
你的记忆 ──context──▶ task_inbox ──▶ Harness agent 执行 ──▶ {changes, verification, leftovers}
                                                                    │
                        task_result 轮询 / 回调唤醒 ◀────────────────┘
                                                                    ▼
                                                    结果回写记忆（成为下一轮 context）
```

### `agent_run` 返回长这样

```json
{
  "sessionId": "…",
  "assistantText": "最终回答",
  "toolCalls": [{ "name": "bash", "args": "…" }],
  "toolResults": ["命令输出"],
  "changes": "改了什么",
  "verification": "怎么验证的",
  "leftovers": "遗留问题",
  "stats": { "rounds": 1, "steps": 3, "inputTokens": 8831, "outputTokens": 157 }
}
```

### 回调预设（`callbackPreset`）—— 配一次，之后一行派发

手写整坨 callback 很容易漏字段，**而漏了不报错，回调就是静默不到**。所以提供部署级预设。

**部署配置里配一次**：

```yaml
- insert:
    - id: hermes-dsh-bridge
      name: 'hermes-dsh-bridge'
      config:
        allowedCallbackHosts: ["127.0.0.1:8644"]   # 回调地址，必须白名单放行
        defaultCallbackSecret: "<与接收方共用的密钥>"
        callbackPreset:
          url: "http://127.0.0.1:8644/webhooks/dsh-task-done"
          headers:
            X-Gitlab-Token: "<同一个密钥>"          # 接收方要求的鉴权头
          events: []                                # [] = 订阅全部终态事件
          replyContext:
            origin: hermes                          # 静态路由字段放这里
          requireReplyRoute: true                   # 无法路由时直接报错，别投错地方
```

**之后派发就一行**：`{"task": "…", "callback": {"replyContext": {"replyChatId": "123"}}}`，
甚至什么都不传也会自动套用。

合并语义是 `任务级 → 预设 → 内置默认` 三级回落；`headers` 浅合并、`replyContext` 深合并一层。
`secret` **不在预设里**，唯一来源是 `defaultCallbackSecret` 或任务级传参。
完整字段表见 **[docs/CONFIG.md](docs/CONFIG.md#callbackpreset--configure-the-callback-once)**。

> 不配 `callbackPreset` 时行为与旧版**完全一致**；预设也**不放宽任何安全策略** ——
> SSRF 校验作用在合并之后的 URL 上。

### 提问应答（`questionCallback`）

配了之后，agent 调 `ask_user_question` 时本插件会**立刻回调通知你**，而不是让任务永久挂起：

```yaml
        questionCallback:
          url: "http://127.0.0.1:8644/webhooks/dsh-question"
          replyContext: { origin: "your-session-id" }
          headers: { X-Gitlab-Token: "<密钥>" }
```

收到通知后，回答有两条路：① 走回调链路把答案送回；② 写文件
`~/.dsh/approvals/question_answer_<questionId>.json`：

```json
{"questionId": "<id>", "answers": [{"id": "<问题id>", "selected": ["<选项label>"]}]}
```

**30 分钟**无人应答则该调用报错收尾。不配 `questionCallback` = 不注册应答器，行为与旧版一致。

### `session_list` 的 `detail` 参数

默认 `detail: "brief"` 只回 `id / title / cwd / createdAt / updatedAt / sizeBytes / live`，
**不读会话日志**（所以快）。需要 `messageCount` / token 统计时传 `detail: "full"`（较慢）。
`brief` 行带 `tokensAvailable: false` 表示"统计未计算"，**别当成 0**。

### 权限三档与审批桥

会话文件权限档通过会话日志的 `sandbox/mode` 事件固化（重启靠 replay 保持）：

- `agent_run` / `task_inbox` 的 `sandbox` 参数是**请求级覆盖**：仅影响新建/resume 的会话；
  已有会话保持原档位（显式切换用 `set_policy`）。同 cwd 三档互不污染。
- 审批流程：agent 提权 → 审批桥挂起 → 你 `approval_list` 轮询 →
  `approval_respond(approvalId, sessionId, 'allowed-once'|'rejected')` → agent 继续。
  **Web UI 与 MCP 双通道，先答者胜。**
- 审批未决期间 `agent_run` **同步阻塞**（长阻塞场景请用 `task_inbox`）。
- ⚠️ `approval_respond` 等于远程提权按钮：MCP server 暴露非 loopback 时**必须**开 `authToken`
  （见 [docs/SECURITY.md](docs/SECURITY.md)）。

完整配置字段见 **[docs/CONFIG.md](docs/CONFIG.md)**。

---

## 性能：为什么快

大会话库（197 个会话 / 80MB / 27 个工作目录）上的实测对比：

| 调用 | 旧版 0.8.1 | 本版 | 提升 |
|---|---|---|---|
| `session_list{limit:1}` | **≈ 13 s** | **< 1.5 s**（实测 ~0.3 s） | 约 40× |
| `session_list{limit:50}` | **≈ 31 s** | **< 3 s**（实测 ~0.3 s） | 约 100× |
| `session_search{query:"test"}` | ≈ 8 s | ~0.6 s | 约 14× |

**关键：耗时不再随会话库规模增长。** `limit=1` 和 `limit=50` 现在是同一量级。

旧实现的排序键来自逐条 `sessionPersistence.stat(id)`，而 jsonl 后端下 `stat()` 是
**O(项目目录数)** 的（内部要遍历整棵树）—— 197 次 × ≈50 ms ≈ 9.3 秒，再加上逐行读整条事件流。
本版改成：一次拿全量 header + 整批解析落盘 mtime + 行级统计按需（`detail` 控制）。
详见 [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md)（含两条上游限制的绕过说明）。

> **升级提示**：若你的代码依赖 `session_list` 默认返回 `messageCount` / token，请改传 `detail: "full"`。

---

## 常见问题

完整错误对照表（30 条，含原因与修复步骤）见
**[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#error-message-reference)**。

最高频的三条：

| 症状 | 原因 | 修复 |
|---|---|---|
| agent 返回文本但 `toolCalls` 恒空（"嘴炮"） | **dual-package hazard**：`@deepseek-ai/*` 被加载了两份，`Symbol` 不匹配 → preset 挂载被静默跳过 | 重做安装第 ② 步的 symlink，重启。**dsh 每次升级后都要重做** |
| agent 秒退 + 0 token + 零报错 | dsh 0.1.7 收紧了 message source 合法取值，旧写法被静默丢弃 | 用官方发行版即无此问题；自己 fork 过的见 TROUBLESHOOTING |
| `prompt variable "{{model}}" has no value` | patch 里没写 `provider`/`model` | 补上你 Harness 里已配置的那对，重启 |

---

## 兼容性

| dsh 版本 | 状态 |
|---|---|
| **0.1.2-rc.1 ~ 0.1.7-rc.2** | ✅ 全部支持（运行时探测能力，不做版本号硬判断） |
| 0.2.0-rc.2 | ✅ 实测通过 |
| ≤ 0.1.1-rc.2 | ❌ 需 v0.5.x 或更早的插件版本 |

**dsh 0.1.7 的两处变化**（本版已适配，用户无需处理）：

1. **`MessageSourceMap` 收紧** —— 只接受 `user | model | tool | system-prompt`。
   旧代码用 `kind: 'plugin'` 构造 message 会被**静默丢弃** → agent 秒退、0 token、零报错。
2. **新增 `ctx.sessionQuery`** —— 插件运行时探测：有就用（会话列表更快），没有就回退旧路径。

升级 dsh 后**不需要迁移会话数据**，也不需要改插件配置。**但必须重做安装第 ② 步的 symlink**
（npm 升级会把 symlink 还原成实体目录，导致 dual-package hazard 复发）。

---

## 定位与限制

适合做**备用工具**而非日常主力：日常改代码直接驱动你的主 Agent 更顺。
需要**上下文隔离**（大重构会撑爆主会话上下文）或**并行执行**不相关任务时再找它。

- Agent 会话按 cwd **复用**（避免每次调用重新加载项目上下文）。
- Bash 沙箱化：宿主机装 `bubblewrap`，否则 `workspace-write` 档下写命令被拒。
- reasoning/thinking 块在返回前**剥离**（插件侧 + 文本级兜底双层过滤）。
- `assistantText` 等结果字段**有意限长**（≤ 8000 字符），完整文本用 `session_log` 取。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/CONFIG.md](docs/CONFIG.md) | 全部配置字段（与代码逐字段核对）、安全默认值、可复制示例 |
| [docs/TOOLS.md](docs/TOOLS.md) | 25 个工具的完整参考（入参表 / 返回字段 / 错误码） |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 深度排障 + 30 条错误对照表 |
| [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) | 已知缺陷与两条上游限制的绕过说明 |
| [docs/SECURITY.md](docs/SECURITY.md) | 威胁模型 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 版本变更历史 |
| [scripts/doctor.mjs](scripts/doctor.mjs) | 安装自检 |
| [examples/hermes_dsh_mcp.py](examples/hermes_dsh_mcp.py) | 零依赖 Python MCP 客户端（仅标准库） |

## License

[GPL-3.0-only](./LICENSE)，上游 MIT 部分保留 —— 见 [NOTICE.md](./NOTICE.md)。

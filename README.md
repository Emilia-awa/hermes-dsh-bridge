# hermes-dsh-bridge

> 专门桥接 **Hermes ↔ DeepSeek Harness** 的 MCP 插件：在 Harness 内部启动一个 MCP server，让外部 MCP 客户端（如 [Hermes](https://hermes-agent.nousresearch.com/)）驱动 Harness 的 Agent 执行真实编码任务。

**Hermes 是大脑，Harness 是双手。**

[![license](https://img.shields.io/badge/license-GPLv3-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-orange)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/hermes-dsh-bridge)](https://www.npmjs.com/package/hermes-dsh-bridge)
[![CI](https://github.com/Emilia-awa/hermes-dsh-bridge/workflows/CI/badge.svg)](https://github.com/Emilia-awa/hermes-dsh-bridge/actions)

## 为什么存在

Harness 自带强大的 Agent 运行时（工具、LLM、Agent、会话），但它是 **Cordis 应用**，别的 Agent 调不动它。这个插件把 Harness 翻了个面：在 Harness **内部**启动一个真正的 **MCP server**（StreamableHTTP），桥接 Harness 核心服务（`ctx.agents` / `ctx.agentPresets` / `ctx.tools`），让外部"大脑"把真正的活派给 Harness 的"双手"。

```
Hermes (MCP client, 大脑)
   │  agent_run / task_inbox / fs_read / session_stats ... (HTTP)
   ▼
harness-mcp-server (MCP server, :8090)
   │  ctx.agents.create → mount 'standard' preset
   ▼
Harness agent — 完整工具集: bash, fs, todo, web…
```

## 工具（25 个）

### 任务
| 工具 | 方向 | 用途 |
|------|------|------|
| `agent_run` | → Harness | 同步执行任务；返回结构化结果 + 本轮 `stats` 统计；可选 `preset` 单次覆盖预设、`sandbox` 单次覆盖权限三档；需要提档审批时会挂起等审（见"权限三档与审批桥"） |
| `task_inbox` | → Harness | 推结构化任务（任务+记忆上下文+cwd+可选 `preset`/`sandbox`）进异步队列；**审批转接的主路径**：挂起等审期间轮询 `approval_list` → `approval_respond` 即续跑 |
| `task_result` | ← Harness | 取回队列任务的结构化结果 |
| `task_list` | ← Harness | 异步任务队列快照（id/status/createdAt/error） |
| `task_cancel` | → | 取消队列任务：queued 直接移除；running 尽力中止（agent.cancel，结果丢弃、会话保留可续接） |

### 会话
| 工具 | 方向 | 用途 |
|------|------|------|
| `session_list` | ← | 列会话（live+持久化合并），每行带 token/LLM 用时摘要 |
| `session_log` | ← | 读会话事件日志（已剥离 reasoning），tail N 条、按类型过滤 |
| `session_stats` | ← | 会话统计：rounds/steps/llmTime/toolTime/ttft/tokensPerSec/cacheHitRate/inputTokens/outputTokens |
| `session_search` | ← | 跨会话搜索：标题匹配 + 内容搜索（持久化事件，单会话 2s 超时跳过），正则可选 |
| `rename_session` | ← | 会话改名（便于归档区分） |
| `attach_session` | ← | 会话归组到工作区 |

### 文件（受 path jail 约束）
| 工具 | 方向 | 用途 |
|------|------|------|
| `fs_read` | ← | 读文本文件（行号分页；路径 jail + 敏感名黑名单） |
| `fs_list` | ← | 列目录（递归 depth 层，敏感项自动隐藏） |
| `fs_stat` | ← | 文件/目录元数据 |
| `fs_write` | → | 写文件（overwrite/append/create-new）——**opt-in**（`enableFsWrite: true` 才注册），仅限 workspaceRoots |

### 预设
| 工具 | 方向 | 用途 |
|------|------|------|
| `preset_list` | ← | 列出可用 agent preset + 默认 |
| `preset_get` | ← | 查询会话实际生效的 preset（或默认） |
| `preset_set` | → | 切换默认 preset（`scope=new-default`）或空白会话的 preset（`scope=session`） |

### 元
| 工具 | 方向 | 用途 |
|------|------|------|
| `echo` | — | 验证 MCP 连通 |
| `harness_list_tools` | — | 列出 Harness 内部注册的工具名 |

### 权限与审批
| 工具 | 方向 | 用途 |
|------|------|------|
| `policy_get` | ← | 查询会话生效策略：`{sessionId, sandboxMode, source: override\|default, workspaceRoot, approvalPolicy}`；无参返回部署默认 |
| `set_policy` | → | 切换 **live 会话** 的文件权限档（追加 `sandbox/mode` 事件，下一次受限调用生效，重启靠 replay 保持）；冷会话需先 resume 再切 |
| `approval_list` | ← | 列出挂起审批（沙箱提档 escalation 等）：`[{approvalId, sessionId, toolName, callId?, reason?, requestedAt, waitedMs}]` + bridge 形态/超时配置 |
| `approval_respond` | → | 回答挂起审批：`allowed-once`（仅本次放行）/`rejected`；与 Web UI 双通道**先答者胜**，败者回 `receipt=not-pending` |

### 状态与配置
| 工具 | 方向 | 用途 |
|------|------|------|
| `status_get` | ← | 版本/uptime/provider/model/preset/live agents/队列深度 + `sandboxPolicy{defaultMode,bridge,pendingApprovals}` |
| `config_get` | ← | 运行时配置摘要（authToken 打码为 `***`）+ `defaultSandbox/approvalsBridge/approvalTimeoutMs` |

### 结构化结果与统计

每次 `agent_run` 返回结构化结果，并附带本轮用量统计：

```json
{
  "sessionId": "...",
  "assistantText": "最终回答",
  "toolCalls": [{ "name": "bash", "args": "..." }],
  "toolResults": ["命令输出"],
  "changes": "改了什么",
  "verification": "怎么验证的",
  "leftovers": "遗留问题",
  "stats": {
    "rounds": 1, "steps": 3,
    "llmTime": 13.9, "toolTime": 0.04,
    "ttft": 3349, "tokensPerSec": 40.7,
    "cacheHitRate": 1, "inputTokens": 8831, "outputTokens": 157
  }
}
```

闭环：客户端把记忆作为 `context` 喂进每次任务，结果（`changes`/`verification`/`leftovers`）再存回客户端记忆，供下一轮使用。

## 权限三档与审批桥（v0.5.0）

### 三档语义

会话文件权限档与 Harness 原生 `SandboxMode` 一一对应，通过会话日志的 `sandbox/mode` 事件固化（重启靠 replay 保持）：

| 档位 | 语义 |
|------|------|
| `read-only` | 只读（仅 `/dev/null` 等必要 sink 可写） |
| `workspace-write` | 工作区 + 后端临时区可写（**默认**，`defaultSandbox` 可改） |
| `danger-full-access` | **完全绕过文件围栏 + bash 解禁，全程无审批任意读写** —— 仅限可信环境 |

- `agent_run` / `task_inbox` 的 `sandbox` 参数是**请求级覆盖**：仅影响新建/resume 的会话组合；已有会话保持原档位（显式切换用 `set_policy`）。请求档与会话固化档不一致时不会复用池会话、专用会话不入池——同 cwd 三档互不污染。
- `session_list` 行在会话有 `sandbox/mode` 记录时带 `sandboxMode` 列。

### 审批转接（approvals 桥）

Agent 沙箱提档（escalation）等场景会向审批链提问。本插件把审批**转接到 MCP 侧**：

```
Harness agent 需要提权 → approval/request → [审批桥挂起]
Hermes: approval_list() 轮询 → approval_respond(approvalId, sessionId, 'allowed-once'|'rejected')
→ agent 继续（或收到拒绝）；Web UI 与 Hermes 双通道先答者胜
```

- `approvalsBridge: 'web'`（默认）：订阅 apiProxy 的 mux 流复用 Web 审批通道，回答经 `apiProxy.respond` 路由；apiProxy 缺失时自动降级 `'builtin'`（插件内建应答器）。设为 `'off'` 关闭桥（审批回到部署默认 fail-closed 行为）。
- 审批未决期间 `agent_run` **同步阻塞**（长阻塞场景请用 `task_inbox` 异步路径）；`approvalTimeoutMs`（默认 120s）超时收尾为取消/拒绝——**绝不超时放行**。
- ⚠️ `approval_respond` 等于远程提权按钮：MCP server 暴露非 loopback 时必须开 `authToken`（见 docs/SECURITY.md）。

## 安装

### 方式 A — 从 npm 安装到 Harness profile

```bash
# 在 Harness profile 的 node_modules 下
cd ~/.dsh/profiles/<你的profile>/node_modules
npm install hermes-dsh-bridge
```
> 包主页: https://www.npmjs.com/package/hermes-dsh-bridge

### 方式 B — 源码构建

```bash
git clone https://github.com/Emilia-awa/hermes-dsh-bridge.git
cd hermes-dsh-bridge
npm install && npm run build   # 产出 lib/index.js
# 把构建产物放进 Harness profile:
#   ~/.dsh/profiles/<你的profile>/node_modules/hermes-dsh-bridge
```

> ⚠️ **dual-package hazard（必读）**：Harness 从**全局树**解析 `@deepseek-ai/*`，而插件自身 node_modules 可能带平行副本——两个模块实例 ⇒ `Symbol` 不匹配 ⇒ Agent 悄悄失去全部工具（表现为 `agent_run` 只输出 `<tool_calls>` 文本、`toolCalls` 恒为空数组）。修复：把插件的 `@deepseek-ai/*` 依赖 symlink 到 Harness 全局树：
> ```bash
> PROFILE=~/.dsh/profiles/<你的profile>/node_modules
> GLOBAL=$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai
> for pkg in cordis cosmokit dsh-agent dsh-llm dsh-session dsh-tools dsh-scope \
>            dsh-agent-presets dsh-code-runtime dsh-system-prompt dsh-typert-protocol \
>            dsh-attachment dsh-brand dsh-invariants dsh-timeout dsh-settings \
>            dsh-home-paths dsh-atomic-write dsh-user-approval \
>            cordis-plugin-include cordis-plugin-loader; do
>   rm -rf "$PROFILE/@deepseek-ai/$pkg" && ln -sfn "$GLOBAL/$pkg" "$PROFILE/@deepseek-ai/$pkg"
> done
> ```
> （`cordis-plugin-include/loader` 未发布到 npm registry，只在 Harness 全局树里，必须 symlink。）

### Patch 配置

在你的 Harness profile 的 `cordis.patch.yml`（或等价 patch 文件）末尾追加：

```yaml
- insert:
    - id: hermes-dsh-bridge
      name: 'hermes-dsh-bridge'
      config:
        http: true
        port: 8090
        host: 127.0.0.1        # 默认仅本机; 暴露前必须加认证
        # authToken: '你的随机长token'     # 可选: Bearer token 认证
        # workspaceRoots: ['/workspace']  # 可选: cwd 白名单
        # enableFsWrite: true             # 可选: 开启 fs_write(默认关)
        # defaultSandbox: workspace-write # 可选: 新建会话默认权限档(read-only|workspace-write|danger-full-access)
        # approvalsBridge: web            # 可选: 审批桥(web|builtin|off, 默认 web)
        # approvalTimeoutMs: 120000       # 可选: 审批等待超时(超时收尾为取消/拒绝, 绝不超时放行)
        # ⚠️ 必须显式声明 provider/model(你的 Harness 里已配置好的),
        #    否则 agent 组装会因空 {{model}} 崩溃。改成你自己的, 例如:
        #    provider: <your-provider-id>
        #    model: <your-model-id>
```

### 重启并验证

```bash
systemctl restart dsh.service        # 或你管理 Harness 的方式
# 验证 25 个工具全在线:
python3 examples/hermes_dsh_mcp.py list
python3 examples/hermes_dsh_mcp.py call status_get '{}'
```

## 🤖 AI 一键安装指南（给 AI Agent 看的安装说明）

> 下面的步骤是给 **另一个 AI Agent** 看的：如果你是一个 AI agent，要把这个插件装到你管理的 Harness 环境里，请严格按以下编号步骤执行，每步做完检查输出再继续。

**前置检查（先做这 3 步）**
1. 确认 Node ≥ 22.18：`node --version`（低于 22.18 会报 zstd/`stripTypeScriptTypes` 缺失，先升级 Node）。
2. 确认目标 Harness profile 存在：`ls ~/.dsh/profiles/`（找到你要装的 profile 名，下文用 `<PROFILE>` 代替）。
3. 确认 Harness 全局树存在：`npm root -g`（下文用 `$GLOBAL_TREE` 代替 `npm root -g`）。

**安装步骤（复制即可执行）**
```bash
# ① 安装插件到 profile
cd ~/.dsh/profiles/<PROFILE>/node_modules
npm install hermes-dsh-bridge        # 安装自 npm registry

# ② 修复 dual-package hazard: 把所有 @deepseek-ai/* 和 cordis-plugin-* symlink 到全局树
GLOBAL_TREE=$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai
for pkg in cordis cosmokit dsh-agent dsh-llm dsh-session dsh-tools dsh-scope \
           dsh-agent-presets dsh-code-runtime dsh-system-prompt dsh-typert-protocol \
           dsh-attachment dsh-brand dsh-invariants dsh-timeout dsh-settings \
           dsh-home-paths dsh-atomic-write dsh-user-approval \
           cordis-plugin-include cordis-plugin-loader; do
  rm -rf "@deepseek-ai/$pkg" 2>/dev/null
  ln -sfn "$GLOBAL_TREE/$pkg" "@deepseek-ai/$pkg"
done

# ③ 在 profile 的 cordis patch 文件(cordis.patch.yml)末尾追加配置
#    ⚠️ provider/model 必须填你这个 Harness 已配置好的, 否则 agent 组装会崩
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

# ④ 重启 Harness(注意: 若你正跑在 Harness 里, 用 systemd-run 脱离进程树重启)
systemctl restart dsh.service

# ⑤ 验证: 等 8 秒后检查 MCP server 起来 + 工具列表
sleep 8
curl -s -X POST http://127.0.0.1:8090/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ai-setup","version":"1.0"}}}' \
  | tail -1 | head -c 300
python3 examples/hermes_dsh_mcp.py list | grep -cE "agent_run|session_stats|preset_set"   # 期望 ≥ 3
```

**验收标准**
- `dsh_mcp.py list` 输出 ≥ 25 个工具，其中必须包含 `agent_run`、`session_stats`、`preset_set`、`fs_read`。
- `status_get` 返回的 `version` 为 `0.5.0`，`provider`/`model` 是你配置的值，`sandboxPolicy.bridge` 非空。
- 跑一个冒烟任务 `python3 examples/hermes_dsh_mcp.py run '回复:安装成功'`，返回里含 `stats` 字段。

**常见失败与对策（遇到再查）**
| 症状 | 原因 | 对策 |
|---|---|---|
| `agent_run` 返回文本但 toolCalls 恒空 | dual-package hazard，symlink 被 npm 重装还原 | 重做第②步 symlink，重启 |
| 启动报 `prompt variable "{{model}}" has no value` | patch 没写 provider/model | 补第③步的 provider/model |
| `MISSING_CREDENTIAL: <provider>` | API key 没注入 Harness 进程 env | 在 systemd unit 加 `Environment=KEY=...` 或 export |
| `Cannot find package '@deepseek-ai/cordis-plugin-include'` | 第②步漏了 cordis-plugin-* | 补 symlink 这两个包 |
| 版本号符合但行为像旧版 | 系统里有双 npm 全局树，装错树 | `which dsh` + `npm prefix -g` 核对，统一到实际启动的树 |

完整排障见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

## 文档

- [docs/TOOLS.md](docs/TOOLS.md) — 25 个工具的完整参考（入参/出参/限额/错误码）
- [docs/CONFIG.md](docs/CONFIG.md) — 配置字段、安全默认值
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — 已知坑（SSE 解析、8KB 截断、dual-package hazard…）
- [docs/SECURITY.md](docs/SECURITY.md) — 威胁模型
- [examples/hermes_dsh_mcp.py](examples/hermes_dsh_mcp.py) — 零依赖 Python MCP 客户端（仅标准库）

## 定位

适合做**备用工具**而非日常主力：日常改代码请直接驱动你的主 Agent。需要**上下文隔离**（大重构会撑爆客户端上下文）或**并行执行**不相关任务时再找它。

- Agent 会话按 cwd **复用**（避免每次调用重新加载项目上下文）。
- Bash 沙箱化（`workspace-write`）：宿主机装 `bubblewrap`，否则写命令会被拒。
- reasoning/thinking 块在返回前**剥离**（插件侧 + 文本级兜底双层过滤）。

## License

[GPL-3.0-only](./LICENSE)，上游 MIT 部分保留——见 [NOTICE.md](./NOTICE.md)。
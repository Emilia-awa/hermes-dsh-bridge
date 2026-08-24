# hermes-dsh-bridge

> 将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 能力以 **MCP server** 形式暴露出来，让任意 MCP 客户端（如 [Hermes](https://hermes-agent.nousresearch.com/)）驱动 Harness 执行真实编码任务。

**Hermes 是大脑，Harness 是双手 —— 1+1>2。**

[![license](https://img.shields.io/badge/license-GPLv3-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-orange)](https://nodejs.org)

## 为什么存在

Harness 自带强大的 Agent 运行时（工具、LLM、Agent、会话），但它是 **Cordis 应用**，别的 Agent 调不动它。这个插件把 Harness 翻了个面：在 Harness **内部**启动一个真正的 **MCP server**（StreamableHTTP），桥接 Harness 核心服务（`ctx.agents` / `ctx.agentPresets` / `ctx.tools`），让外部"大脑"把真正的活派给 Harness 的"双手"。

```
Hermes (MCP client, 大脑)
   │  agent_run / task_inbox / fs_read / session_stats ... (HTTP)
   ▼
hermes-dsh-bridge (MCP server, :8090)
   │  ctx.agents.create → mount 'standard' preset
   ▼
Harness agent — 完整工具集: bash, fs, todo, web…
```

## 工具（19 个）

### 任务
| 工具 | 方向 | 用途 |
|------|------|------|
| `agent_run` | → Harness | 同步执行任务；返回结构化结果 + 本轮 `stats` 统计 |
| `task_inbox` | → Harness | 推结构化任务（任务+记忆上下文+cwd）进异步队列 |
| `task_result` | ← Harness | 取回队列任务的结构化结果 |
| `task_list` | ← Harness | 异步任务队列快照（id/status/createdAt/error） |

### 会话
| 工具 | 方向 | 用途 |
|------|------|------|
| `session_list` | ← | 列会话（live+持久化合并），每行带 token/LLM 用时摘要 |
| `session_log` | ← | 读会话事件日志（已剥离 reasoning），tail N 条、按类型过滤 |
| `session_stats` | ← | 会话统计：rounds/steps/llmTime/toolTime/ttft/tokensPerSec/cacheHitRate/inputTokens/outputTokens |
| `rename_session` | ← | 会话改名（便于归档区分） |
| `attach_session` | ← | 会话归组到工作区 |

### 文件（受 path jail 约束）
| 工具 | 方向 | 用途 |
|------|------|------|
| `fs_read` | ← | 读文本文件（行号分页；路径 jail + 敏感名黑名单） |
| `fs_list` | ← | 列目录（递归 depth 层，敏感项自动隐藏） |
| `fs_stat` | ← | 文件/目录元数据 |
| `fs_write` | → | 写文件（overwrite/append/create-new）——**opt-in**（`enableFsWrite: true` 才注册），仅限 workspaceRoots |

### 状态与配置
| 工具 | 方向 | 用途 |
|------|------|------|
| `status_get` | ← | 版本/uptime/provider/model/preset/live agents/队列深度 |
| `config_get` | ← | 运行时配置摘要（authToken 打码为 `***`） |

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

## 安装

### 方式 A — npm

```bash
npm install hermes-dsh-bridge
```

然后在 Harness profile 的 cordis patch 里引用（见下）。

### 方式 B — 源码

```bash
git clone https://github.com/Emilia-awa/hermes-dsh-bridge.git
cd hermes-dsh-bridge
npm install && npm run build
# 把包（或 node_modules symlink）放进你的 Harness profile:
#   ~/.dsh/profiles/<name>/node_modules/hermes-dsh-bridge
```

> ⚠️ **dual-package hazard**：Harness 从**全局树**解析 `@deepseek-ai/*`，而插件自身 node_modules 可能带平行副本——两实例 ⇒ Symbol 不匹配 ⇒ Agent 悄悄失去全部工具。修复：把插件的 `@deepseek-ai/*` 依赖 symlink 到全局树：
> ```bash
> PROFILE=~/.dsh/profiles/web/node_modules
> GLOBAL=$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai
> for pkg in cordis cosmokit dsh-agent dsh-llm dsh-session dsh-tools dsh-scope schemastery; do
>   rm -rf "$PROFILE/@deepseek-ai/$pkg" && ln -sfn "$GLOBAL/$pkg" "$PROFILE/@deepseek-ai/$pkg"
> done
> ```

## 运行

```bash
export DEEPSEEK_API_KEY=...            # 或你的 Harness 用的任意 provider key
dsh --profile <name> web --port 3080 --trusted-host your.host
```

MCP server 监听 `127.0.0.1:8090`（StreamableHTTP）。任意 MCP 客户端指向 `http://127.0.0.1:8090/mcp`。

> ⚠️ **安全**：默认只绑定 `127.0.0.1`。它通过 `agent_run` 暴露**远程代码执行**——不要绑 `0.0.0.0` 或未经认证（Bearer token）、TLS、反代就暴露到公网/局域网。详见 `docs/SECURITY.md`。

## cordis.yml（patch 格式）

```yaml
- insert:
    - id: harness-mcp-server
      name: 'hermes-dsh-bridge'
      config:
        http: true
        port: 8090
        host: 127.0.0.1        # 默认仅本机; 暴露前必须加认证
        # authToken: 'your-secret-token'     # 可选: Bearer token 认证
        # workspaceRoots: ['/workspace']      # 可选: cwd 白名单
        # enableFsWrite: true                 # 可选: 开启 fs_write 工具(默认关)
        # ⚠️ 必须显式声明 provider/model, 否则 agent 组装会因空 {model} 崩溃:
        # provider: opencode-go
        # model: deepseek-v4-flash
```

## 文档

- `docs/TOOLS.md` — 工具全参考（入参/出参/限额/错误码）
- `docs/CONFIG.md` — 配置字段、安全默认值
- `docs/TROUBLESHOOTING.md` — 已知坑（SSE 解析、8KB 截断、dual-package hazard…）
- `docs/SECURITY.md` — 威胁模型
- `examples/hermes_dsh_mcp.py` — 零依赖 Python MCP 客户端（仅标准库）

## 定位

适合做**备用工具**而非日常主力：日常改代码请直接驱动你的主 Agent。需要**上下文隔离**（大重构会撑爆客户端上下文）或**并行执行**不相关任务时再找它。

- Agent 会话按 cwd **复用**（避免每次调用重新加载项目上下文）。
- Bash 沙箱化（`workspace-write`）：宿主机装 `bubblewrap`，否则写命令会被拒。
- reasoning/thinking 块在返回前**剥离**（插件侧 + 文本级兜底双层过滤）。

## License

[GPL-3.0-only](./LICENSE)，上游 MIT 部分保留——见 [NOTICE.md](./NOTICE.md)。
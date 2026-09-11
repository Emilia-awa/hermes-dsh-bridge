# REQ_bridge_r2：hermes-dsh-bridge R2 轮 —— 用户体验优化 + 0.1.5 兼容修复

## 背景
hermes-dsh-bridge 是让外部 AI agent（如 Hermes）通过 MCP 调用 dsh Harness 的桥接插件。
用户明确要求：**让用户易用、尽可能简化操作流程，优化用户和 agent 的体验**。
运行环境已升级 dsh 0.1.2-rc.1 → 0.1.5-rc.2。当前源码在 /tmp/bridge_repo（v0.6.0，git 库，改完要能提交）。

## R1 实测发现的问题（必修）
1. **session_list 无参调用崩溃**：`{"error":"session_list failed: Cannot read properties of undefined (reading 'length')"}`
   - 带 cwd 过滤时正常返回（单会话场景验证 OK）
   - 根因线索：dsh 0.1.5 会话目录格式变了（`--tmp--/f9a31258-.../session.v3.jsonl.zstd`，
     旧格式是 `--tmp--/session-f9a31258-.../session.jsonl.zstd`），
     无参时 listMergedHeaders 合并 live+持久化列表后，某些 header 在 roughUpdatedAt/inspectSessionRow
     阶段触发 undefined.length（persistence.inspect 返回结构与 0.1.2 不同，或 locate 对 v3 格式返回异常）。
   - 修复要求：① 逐行容错（单行失败不炸整个列表，跳过并在结果里加 `skipped: N` 字段）
     ② 兼容 v3 会话格式（session.v3.jsonl.zstd + 无 session- 前缀目录）；
     读 /opt/node22/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-query/lib/index.js
     了解 0.1.5 的 listSessions/inspectPersisted 真实结构后适配。
2. 生产部署的 npm 包是 0.5.0（旧），repo 已 0.6.0：本轮结束后要发布新版本并升级部署。

## 用户体验优化（本轮核心目标）
对 26 个工具逐一过一遍，按以下标准改：

### A. 工具描述面向 agent 调用者优化
- 描述写「什么时候用我 + 返回什么」，别只写实现细节。例：
  - agent_run 描述先说「一次性同步执行：发任务→等结果，适合 <5min 的任务」，再说审批挂起细节
  - task_inbox 先说「异步队列：立即返回 taskId，适合长任务/可能要中途取消的任务，用 task_result 轮询取结果」
  - 两个工具互相引用（「长任务用 task_inbox」「要看结果用 task_result」），让 agent 一读就知道怎么选
- 每个错误信息都要带「下一步怎么办」：
  - 例：`task not found: xxx` → `task not found: xxx (已过期或从未存在; 用 task_list 查看当前队列)`
  - `no active agent session yet` → 附上建议动作
- 结果 JSON 增加自解释字段：agent_run 成功结果顶部加 `next:` 提示字段
  （如 `{"next":"续接此会话时传 sessionId=<id>"}`——只在有会话时可续时给）

### B. 简化调用路径
- 检查必填参数是否真的必填：cwd 不传时用插件配置默认工作区还是 process.cwd()？若后者对远程 agent 无意义，
  考虑默认 runtimeConfig.workspaceRoots[0] 并在描述里写明默认值。
- session_log 的 types 参数给个常用预设说明（或加个 `preset` 快捷值如 "dialog"=user+assistant 消息）。
- 任何「必须先调 A 拿 id 再调 B」的链路，在 A 的返回里显式给提示（如 agent_run 返回含 sessionId，
  task_inbox 返回含 taskId + 「用 task_result(taskId=...) 取结果」）。

### C. 0.1.5 环境适配检查（只查不重构）
- P3 面板/sidebar API 变化（'conversation' slot → 'main'）是否影响本插件（本插件无 web 面板则跳过）。
- `ctx.agent` 移除的影响：grep 全部 `ctx.agent`，逐一确认没有直接访问（0.1.5 移除后会崩）。
- 会话 v3 格式对 session_log/session_search/roughUpdatedAt/inspectSessionRow 的影响全部排查
  （用 /root/.dsh/sessions/--tmp--/f9a31258-31af-486e-8f85-2e266b4797a9/session.v3.jsonl.zstd 真实数据验证）。

## 硬性约束
- 不改插件对外行为契约（工具名/参数名/返回字段名保持兼容，只允许新增字段）。
- 不动 /root/.dsh/profiles/web/（生产），产物只落在 /tmp/bridge_repo。
- 每处修改在代码注释标注 `// [r2]`。
- 测试：tests/unit_mock_p1.mjs、p2、p3 全部跑通（node tests/unit_mock_p*.mjs）；为 session_list 修复新增针对性单测
  （mock 一个 v3 格式 header 触发原崩溃路径，断言不崩且返回 skipped 计数）。
- tsc 类型检查通过（npx tsc --noEmit 或项目现有构建命令）。

## 交付
- 修改摘要：按 A/B/C 分组列出（文件:行号 + 一句说明）
- 测试真实输出（三个 unit_mock 全绿 + 新单测 + tsc）
- 更新 CHANGELOG.md 增加未发布版本段落（版本号定为 0.7.0）

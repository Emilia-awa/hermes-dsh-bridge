# REQ_bridge_r4.md — R4 轮：安装体验与文档（开箱即用）

基线：/tmp/bridge_repo @ 90ebe1e（0.7.0，R2/R3 已完成）
约束：不改 src/index.ts 核心逻辑（如发现 bug 只记录到 docs/KNOWN_ISSUES.md，本轮不修）。

## 目标
用户拿到包之后：README 5 分钟内跑通、每个报错都能自查、AI agent 装（让 Claude Code/Codex/dsh 等帮装）也能一次成功。

## 任务清单

### A. README 重写（quickstart 优先）
1. 首屏结构改为：一句话是什么 → 30 秒 quickstart（最少命令跑通 echo）→ 分场景进阶。
2. 前置依赖表：dsh 版本（>=0.1.2-rc.1，0.1.5-rc.2 实测）、Node 版本、Hermes 端配置片段，每项给检查命令（如 `dsh --version`）。
3. 三种安装路径分开写清：npm 安装（推荐）/ 源码构建 / Hermes 一键配置片段，注明各自适用人群。
4. 常见错误排查表（FAQ）：把 src/index.ts 里所有面向用户的错误文案过一遍，每个错误给「原因 + 修复步骤」，做成表格；特别是 0.1.5 用户从旧版升级的场景（v3 会话格式、session_list 行为变化）。
5. 升级指南：0.5.x/0.6.x → 0.7.0 的变更点、破坏性变更清单、迁移步骤。

### B. 配置文档对齐
6. docs/CONFIG.md 与实际 zod schema 逐字段核对：字段名、默认值、是否必填——以代码为准修文档。
7. patch 配置示例可复制即用：provider/model 用占位符 <your-provider-id>/<your-model-id>（保持既有约定，不得写死作者本机配置）。
8. docs/TOOLS.md 与 26 个工具的最终 description/schema 逐个核对（R2/R3 改过描述、新增 pageSize/preset/next 等参数与字段），补全每个工具的参数表与返回字段示例。

### C. 安装自检脚本
9. 新增 scripts/doctor.mjs（node 直接跑，零依赖）：
   - 检查 node 版本、dsh 可执行与版本、settings.json/profile 是否存在、插件是否被 dsh 识别（dsh --dump-config 输出 grep）、8090 端口监听、MCP 握手（tools/list 调用一次）。
   - 每项输出 ✓/✗ + 修复建议；最后汇总「N 项通过，M 项失败」。
   - 在本机真实环境跑一遍，输出贴进 README（作为预期输出示例）。

## 验收
- README/CONFIG/TOOLS 全部与代码实态一致（抽查 5 个工具的参数名逐一比对 schema）。
- doctor.mjs 在本机真实环境运行成功且输出合理。
- CHANGELOG.md 追加 R4 段落；git commit。
- 最后输出 A/B/C 修改摘要 + doctor.mjs 真实运行输出。

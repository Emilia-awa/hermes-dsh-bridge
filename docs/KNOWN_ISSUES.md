# KNOWN_ISSUES — 已知缺陷与上游限制

标注约定: 🐞 = 确认的缺陷; ⚠️ = 行为与文档/直觉不一致(可能是有意为之, 但容易误导);
📝 = 待验证; 🅾️ = **上游(dsh 自身)的限制**, 本插件无法修复, 只能绕开。

---

## 🅾️ 上游限制

这一节的条目**不在本仓库内**，是 dsh 自身的行为。本插件已针对它们做了绕过（见每条的处理方式），
记录下来是因为：① 它们解释了插件里若干"看起来绕"的实现；② 上游修复后插件可以简化。

### 🅾️ A. `SessionPersistence.locate()` 恒按当前格式版本拼文件名

**位置（上游）**：`@deepseek-ai/dsh-session-persistence-jsonl`，`lib/index.js`
的 `locate(meta)` → `logPath(root, cwd, id, SESSION_FORMAT_VERSION)`。

`locate()` 用**当前**格式版本常量（本机为 4）拼路径，形如 `<root>/<proj>/<id>/session.v4.jsonl.zstd`；
但会话实际落盘的 generation 由**当初写入时**的版本决定。于是一个 v3 或 legacy 会话，
`locate()` 返回的路径**根本不存在**。

**本机实测**：200 个会话中，`locate()` 返回的路径真实存在的只有 **14 个**，
**186 个（93%）不存在** —— 实际文件是 `session.v3.jsonl.zstd`（137 个）或 legacy
`session.jsonl.zstd`（49 个）。

**影响**：

1. 任何用 `locate()` 取路径再 `stat()` 算 mtime 的代码都会拿到 ENOENT。旧版
   `session_list` 的 `updatedAt` 因此长期退化成 `header.createdAt`（排序不准，但不报错）。
2. **官方全文索引搜索不可用**：`ctx.sessionQuery.searchSessions` 内部走 `SessionCorpus.load`，
   同样解析不出这些会话，直接抛 `SESSION_QUERY_PERSISTENCE_FAILED`（本机已复现）。
   即部署方按官方注释把 `openAt` 打开后，搜索反而整体失败。

**本插件的处理**：**不依赖 `locate()`**。批量取 mtime 走三级策略（`locate()` 命中就用 →
用 `header.cwd` 推导项目目录 + `readdir` 会话目录取真实 mtime → 回退 `createdAt`）；
`session_search` 对 `SESSION_QUERY_*` 一律**静默回退**到内置扫描，绝不把上游错误抛给用户。
因此本机 `session_search` 默认后端是 `scan` 而非 `index`（`status_get.sessionSearch.backend` 可见）。

**上游修复后**：插件可去掉 mtime 推导兜底，并在 `openAt` 打开时真正启用索引搜索。

### 🅾️ B. `SessionPersistence.stat()` 在 jsonl 后端下是 O(项目目录数)

**位置（上游）**：`dsh-session-persistence-jsonl` 的 `stat(id)` → `findLog(id)`，
而 `findLog` 会 `for (project of listProjectDirs())` 遍历**全部**项目目录
（每个目录还要 `rejectLegacyFlatArtifact` + `resolveGenerationInDirectory`）。

所以 `stat(id)` 名义上是"看一个会话的元数据"，实际开销与**整棵会话树的大小**成正比，
而不是 O(1)。

**本机实测**：真实树（30 个项目目录）**≈47–60 ms/次**；
人造小树（1 个项目目录）**2.7 ms/次**。旧版 `session_list` 对每个会话调一次
`stat()` → 197 次 × ≈50 ms ≈ **9.3 s**，这就是 `limit=1` 也要 10 s 的原因。

**本插件的处理**：**绝不逐条 `stat()`**。改用 `sessionPersistence.list()` / 官方
`sessionQuery.listSessions()` 一次拿全量 header（两者都天然提供 `sizeBytes`，约 0.3–0.6 s），
mtime 另走批量策略（见 A）。

**上游修复后**：`stat()` 变成 O(1) 时，逐条调用不再是问题，但整批读取仍是更优解。

---

## 本轮 (R1) 已修的条目

以下问题在 **`0.9.0`** 中已修复，保留在此仅作历史记录与口径说明。

### ✅ 11. `session_list` / `session_search` 大会话库下极慢（issue #1）

**原症状**：197 个会话的库上 `limit=1` ≈13 s、`limit=50` ≈31 s；客户端 20 s 超时表现为"永不返回"。
skipped=0、无报错 —— 是**性能退化**，不是契约崩塌。
**根因**：逐条 `stat()`（O(树)，见上方 🅾️ B）+ 逐行读整条日志算 messageCount/token。
**修复**：`0.9.0` —— 一次拿全量 header + 整批 mtime；行级统计改为按需
（`detail: "brief"` 默认不读日志）。实测 `limit=1`/`limit=50` 均 **< 1.5 s / < 3 s**。

### ✅ 12. `session_list` 的 `updatedAt` 静默退化成 `createdAt`

**原症状**：冷会话的 `updatedAt` 排序不准，但不报错。
**根因**：`locate()` 路径 93% 不存在（见上方 🅾️ A），mtime 取不到就回退 `createdAt`。
**修复**：`0.9.0` —— 批量 mtime 走 `cwd` 推导 + `readdir` 真实文件，而非只信 `locate()`。

### ✅ 13. `callback.events: []` 被拒绝，与文档/接收方语义矛盾

**原症状**：文档与 Hermes 侧都要求传 `events: []`（= 订阅全部），但插件会把它判成
"无效事件列表"并报错；而不传时 schema 又默认成 `["done","error"]`。
**根因**：schema 层 `.default()` 把"未提供"和"显式提供"压成同一个值，且 `[]` 被当作非法。
**修复**：`0.9.0` —— `events: []` 合法且表示**订阅全部**；`events`/`method`/`timeoutMs`
的 schema 层 `.default()` 移除，改由 `resolveCallback` 做"任务级 → 预设 → 内置默认"三级回落。

### ✅ 14. callback 必须手写全部字段，漏一个就静默失效

**原症状**：每次 `task_inbox` 都要手写 `url`/`secret`/`headers`/`events`/`replyContext`；
漏了不报错，只是回调永远不到。
**修复**：`0.9.0` 新增 `callbackPreset` 部署级预设（配一次，之后一行派发）。
**注意**：实现时发现 `callbackSchema.url` 是 schema 层必填，而 MCP SDK 在进入 handler 前
就按 schema 校验 —— 这会让"只传 replyContext、url 由预设提供"的路径被 SDK 直接以 `-32602`
拒掉。已把 `url` 下沉为可选、校验移到 `resolveCallback`。**这是 `callbackPreset` 能生效的前提。**

---

## R4 遗留（仍未修）

以下条目来自 R4（文档/自检对齐轮），**约束是"不改 `src/index.ts` 核心逻辑"**，故当时只记录不修。
R1 的工作聚焦性能与回调，未涉及这些；它们仍然成立，修它们请单独立项并同步补测试。

## 🐞 1. `agent_run` 入参校验漏掉 `title` / `task_inbox` 漏掉 `head` 之外的字段

**位置**: `src/index.ts` `agent_run` 的 `validateArgs` 调用(`task/context/cwd/sessionId/title/preset/sandbox` 全部列了, 无问题) ——
真正的问题是 **`session_log`** 与 **`session_search`**:

- `session_log` 的 `validateArgs` 只校验 `sessionId/tail/head/types`, **没有校验 `preset`**(`z.enum(['dialog','tools','all'])` 已在 schema 层兜底, 故实际无影响)。
- `session_search` 的 `validateArgs` 校验了 `query/cwd/regex/limit/offset/pageSize`, 完整。

**结论**: 逐条核对后, 26 个工具的 `validateArgs` 覆盖面与各自 schema 一致, 无真实漏检。此条降级为**无缺陷记录**, 保留在此说明已核对过。

---

## 🐞 2. `fs_read` 的 `limit` 上限在 schema 与实现间不一致(2000 vs 2000, 一致; 但 `offset` 无上限)

**位置**: `fs_read` schema `offset: z.number().int().min(1)`(无 max), 实现 `Math.max(1, Math.trunc(offset ?? 1))`。
超大 `offset` 只是 `slice` 出空数组, 返回 `content: ""`、`truncated: false` —— 不报错但也不告诉调用方「offset 越界」。

**影响**: agent 传了超出 `totalLines` 的 `offset` 时, 会拿到空内容且 `truncated:false`, 可能误判「文件是空的」。
**建议修法(R5)**: `off > totalLines` 时返回 `next`/`note` 提示「offset 超过总行数 N」。

---

## 🐞 3. `fs_list` 的 `total` 语义与「目录条目总数」不同

**位置**: `fs_list` 返回 `total: meta.total`(分页信封的 total = walk 收集到的条目数),
但 `count: page.length`。当 `walk` 因 `FS_LIST_MAX_ENTRIES=1000` 提前退出时, `total` 只是**已收集**的 1000,
并非目录真实条目数; 此时 `truncated: true` 且带 `next` 提示(见 `nextHint`)。
**影响**: 轻微。`total` 在硬上限场景下偏小, 但 `truncated` 标志正确。
**建议修法(R5)**: 硬上限时把字段改名为 `collected` 或补 `hardCapped: true`。

---

## ⚠️ 4. `approvalTimeoutMs` 默认值的文档/代码口径必须显式写清

**位置**: `runtimeConfigDefaults()` 里 `approvalTimeoutMs: 300 * 1000`(= **300000ms / 5 分钟**)。
README/docs 在 R2/R3 期间多处写「默认 120s」, 与代码不符 —— **本轮 R4 已按代码改为 300000ms(5 分钟)**。
这不是代码 bug, 而是文档长期错误; 记录在此以防回退。

---

## ⚠️ 5. `provider` 默认值是 `'deepseek-official'`, 但 `model` 默认为空串

**位置**: `runtimeConfigDefaults()`: `provider: 'deepseek-official'`, `model: ''`。
`model === ''` 时 `status_get`/`config_get` 显示 `'(follow dsh default)'`, 且 `getAgent` 不传 model 覆盖。
**影响**: 若部署的 Harness 未配置 `deepseek-official` provider(常见: 用自定义 provider),
只配 `model` 不配 `provider` 会启动失败, 但错误信息是上游的 `MISSING_CREDENTIAL`/组装错误, 不直观。
**建议修法(R5)**: 启动时若 `provider='deepseek-official'` 且该 provider 未注册, 打一条 warn 指引。

---

## 🐞 6. `rename_session` 错误文案里的分号拼接

**位置**: `rename_session`:
```
`${sessionNotFoundError(sessionId)}; 注意本工具只能改 live 会话 —— ...`
```
`sessionNotFoundError` 返回的统一句式已以 `)` 结尾, 再拼 `; 注意…` 后**不再符合**
`<错误>: <关键值> (<原因>; <下一步>)` 的形状(R3 建立的契约), agent 若按 `)` 截断解析会丢信息。

**影响**: 解析兼容性; 人类可读性不受影响。
**建议修法(R5)**: 把「只能改 live 会话」并进 `idNotFoundError` 的 `next` 参数, 去掉外挂拼接。

---

## 📝 7. `session_search.total` / `matched` / `scanned` 三字段易混

**位置**: `session_search` 返回 `total: scanned.length`(R2 口径), 另加 `matched: hits.length` 与 `scanned`(R3 别名)。
即 `total` **不是命中数**而是扫描数。docs/TOOLS.md 已标注, 但属于「命名误导」。
**建议修法(R5)**: 下个大版本把 `total` 改为 `scannedTotal`(破坏性, 需先公告)。

---

## 🐞 8. `set_policy` 只认 live 会话 —— 冷会话报错文案里含未转义引号

**位置**: `set_policy` 冷会话分支:
```
`session ${sessionId} is not live; cold/persisted sessions must be resumed first (冷会话必须先跑一轮让它活起来: agent_run(task=..., sessionId=...), ...)`
```
句子以 `)` 结尾(符合统一句式), 但前缀 `session <id> is not live; ...` 与 R3 的
`session not found: <id> (...)` 前缀家族不一致 —— agent 若用 `startsWith('session not found')` 匹配会漏。
**影响**: 文案一致性。
**建议修法(R5)**: 改用 `errText('session is not live', sessionId, ...)`。

---

## 🐞 9. `fs_write` 的 `mode=create-new` 存在 TOCTOU 窗口

**位置**: `fs_write` 先 `stat` 判断存在, 再 `writeFile`(非 `wx` 标志)。并发两次同路径 `create-new` 都可能通过检查后互相覆盖。
**影响**: 低(单用户本地工具), 但「防误覆盖」的承诺在并发下不成立。
**建议修法(R5)**: `writeFile(path, content, { flag: 'wx' })` 并捕获 `EEXIST`。

---

## ⚠️ 10. 审批桥 `file-push` 形态未写入 README 的配置示例注释

**位置**: `approvalsBridge` 合法取值是 `'web' | 'builtin' | 'off' | 'file-push'`(见 `startApprovalsBridge`)。
R2/R3 的 README 只写了 `web|builtin|off`。**本轮 R4 已补全为四值**。
`approvalFileDir`(默认 `~/.dsh/approvals/`)也已在 CONFIG.md 补文档(此前完全缺失)。

---

## 摘要

### 上游限制（本插件只能绕开）

| # | 一句话 | 插件侧绕过方式 |
|---|---|---|
| 🅾️ A | `locate()` 恒按当前格式版本拼路径，v3/legacy 会话路径 93% 不存在 | 不依赖 `locate()`：批量 mtime 走 `readdir` 兜底；索引搜索失败静默回退 scan |
| 🅾️ B | `stat(id)` 在 jsonl 后端是 O(项目目录数)，≈50 ms/次 | 不逐条 `stat()`：改整批读 header，约 0.3–0.6 s 拿全量 |

### R1 已修（`0.9.0`）

| # | 一句话 |
|---|---|
| 11 | `session_list`/`session_search` 大会话库极慢（issue #1）→ 修复后 <1.5 s / <3 s |
| 12 | `session_list` 的 `updatedAt` 静默退化成 `createdAt` → 改走真实 mtime |
| 13 | `callback.events: []` 被错误拒绝 → 现在合法且表示订阅全部 |
| 14 | callback 必须手写全字段、漏了就静默失效 → 新增 `callbackPreset` 预设 |

### R4 遗留（仍未修）

| # | 类型 | 一句话 | R4 处理 |
|---|---|---|---|
| 1 | — | validateArgs 覆盖面已核对, 无漏检 | 无需处理 |
| 2 | 🐞 | `fs_read` offset 越界静默返回空 | 记录 |
| 3 | 🐞 | `fs_list.total` 在硬上限下偏小 | 记录 |
| 4 | ⚠️ | `approvalTimeoutMs` 真实默认 300000ms(文档曾写 120s) | **已在 R4 文档修正** |
| 5 | ⚠️ | `provider` 默认 `deepseek-official`, 自定义部署易踩 | 记录 |
| 6 | 🐞 | `rename_session` 错误串破坏统一句式 | 记录 |
| 7 | 📝 | `session_search.total` = 扫描数而非命中数 | 记录（R1 未改此口径，保持兼容） |
| 8 | 🐞 | `set_policy` 冷会话错误串前缀不在统一家族 | 记录 |
| 9 | 🐞 | `fs_write create-new` TOCTOU | 记录 |
| 10 | ⚠️ | `file-push`/`approvalFileDir` 曾漏文档 | **已在 R4 文档补全** |

> R4 遗留条目均**只改文档**, 未触碰 `src/index.ts`。修缺陷请单独立项并同步补
> `tests/unit_mock_p3.mjs` 断言。

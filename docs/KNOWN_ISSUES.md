# KNOWN_ISSUES — 已发现但本轮(R4)不修的缺陷

R4 的约束是「不改 `src/index.ts` 核心逻辑」。以下是做文档/自检对齐时**逐字段核对代码**发现的真实缺陷。
全部**只记录、本轮不修**(修任何一条都会动核心逻辑, 须留到 R5 并配回归测试)。

标注约定: 🐞 = 确认的缺陷; ⚠️ = 行为与文档/直觉不一致(可能是有意为之, 但容易误导); 📝 = 待验证。

---

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

| # | 类型 | 一句话 | 本轮处理 |
|---|---|---|---|
| 1 | — | validateArgs 覆盖面已核对, 无漏检 | 无需处理 |
| 2 | 🐞 | `fs_read` offset 越界静默返回空 | 记录 |
| 3 | 🐞 | `fs_list.total` 在硬上限下偏小 | 记录 |
| 4 | ⚠️ | `approvalTimeoutMs` 真实默认 300000ms(文档曾写 120s) | **已在 R4 文档修正** |
| 5 | ⚠️ | `provider` 默认 `deepseek-official`, 自定义部署易踩 | 记录 |
| 6 | 🐞 | `rename_session` 错误串破坏统一句式 | 记录 |
| 7 | 📝 | `session_search.total` = 扫描数而非命中数 | 记录 |
| 8 | 🐞 | `set_policy` 冷会话错误串前缀不在统一家族 | 记录 |
| 9 | 🐞 | `fs_write create-new` TOCTOU | 记录 |
| 10 | ⚠️ | `file-push`/`approvalFileDir` 曾漏文档 | **已在 R4 文档补全** |

> 本轮所有 🐞/⚠️ 均**只改文档**, 未触碰 `src/index.ts`。修缺陷请开 R5 并同步补 `tests/unit_mock_p3.mjs` 断言。

# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the
project adheres to [Semantic Versioning](https://semver.org/).

## [`0.11.3`] — 照着 README 能真装上了（安装文档三处死路 + 第三个假警报）

**升级收益一眼看**：这一版修的全是**新用户第一次安装就会撞上**的问题。
照 README 的「30 秒跑通」抄命令，过去第 ① 步和第 ③ 步**都会直接报
`Cannot find module`**，第 ④ 步要跑的文件**根本不在 npm 包里**。

### Fixed
- **README 第 ① 步装错位置**：`cd ~/.dsh/profiles/$PROFILE/node_modules && npm install`
  会在 `node_modules/` 里再套一层 `node_modules/`，插件装到错误路径。
  改成在 profile 目录装（`cd ~/.dsh/profiles/$PROFILE`）。
- **README 第 ③ 步路径不成立**：`node scripts/doctor.mjs` 在用户当时的 cwd
  （`.../node_modules`）下解析不到。改成完整路径
  `node node_modules/hermes-dsh-bridge/scripts/doctor.mjs`，并加了一句
  「后面所有脚本都从插件目录跑」。
- **README 让跑 `python3 examples/hermes_dsh_mcp.py`，但 npm 包里没有 `examples/`**：
  `files` 白名单漏了它。已加进白名单 —— 现在 npm 装完 `examples/` 就在包里。
- **`doctor` 的失败指引过时**：让人 `cd ~/.dsh/profiles/<p>/node_modules && npm install`，
  与上面同一处错误。已修。
- **`doctor` 的 `dsh settings 文件` 是第三个假警报**：`settings.yaml` 是 dsh
  **已移除的旧格式** —— 现代 dsh 会把它迁移进 profile 并改名 `.imported`，宿主树里
  **没有任何写入方**会生成它。所以「没有 settings.yaml」是**正常状态**，
  这一项在干净机器上**恒为失败**。改成信息项（只有检测到旧文件时才提示一句迁移）。
- **README 示例输出与实际不符**：`symlink 20`（实测新装是 23）、`9 项通过`
  （改完 settings 后是 10 项）、dsh 版本号、缺 `dump-config` 行 —— 全部按真实输出重写。

### Changed
- **npm 包 `files` 白名单收窄**：过去把整个 `scripts/` 塞进包里，含 9 个
  `mutation_check_*` / `e2e_r7` / `realchain_r9` 等**开发期**脚本，对新用户是噪音。
  现在只保留运行/自检必需的四个（`link-host-deps`、`doctor`、`contract_probe`、
  `check-build-artifacts`）。包内文件数 27 → 21。

### Verification
- **照修好的 README 完整跑一遍干净安装**：`npm install` → symlink 23 自动对齐 →
  `doctor` 报 `10 项通过, 0 项失败` → `examples/` 在包里可执行。全程零手工补救。
- 全量 `npm test`：**700 项全绿**（与 R11 一致，本轮未动逻辑）。

## [`0.11.2`] — 诊断工具不再对新用户误报（干净安装的假警报）

**升级收益一眼看**：干净安装后跑 `doctor` / `contract_probe`，过去会看到
「✗ 宿主契约探测 — 缺失服务 sessionPersistence」和「✗ 依赖树 symlink 状态」两个红叉，
让人以为装坏了。现在正确报绿 —— 这两个都是**诊断工具自己的假警报**，不是插件有问题。

### Fixed
- **契约探针把「服务包不在插件依赖里」误判成缺失**：服务包（`dsh-session-persistence`
  等）**由宿主提供**，本来就不该在插件的 `dependencies` 里。探针只用 `require.resolve`
  从插件自己的位置解析，于是干净安装必然报 required 服务缺失。
  本机之所以「看起来正常」，纯粹是因为 `/root/.dsh/profiles/node_modules` 这个历史遗留
  目录恰好挡在解析路径上 —— **换台机器就红**。
  修法：解析失败时显式回退到宿主全局树（`npm root -g` → 常见安装位置；
  `DSH_HOST_TREE` 可显式指定且**优先于自动探测**，便于复现「宿主不可用」）。
  回退只在插件侧解析不到时生效 —— 宿主也没有时照旧报错，不是「无条件放过」。
- **`doctor` 的依赖树检查只看插件内一层**：与 `link-host-deps` 同样的 hoist 问题
  （npm 会把 `@deepseek-ai/*` 提到上层 `node_modules`）。修法同上：向上查找。
  同时把失败文案从「先在本插件目录跑 npm install」改成符合实际的指引
  （正常 `npm install` 已含 postinstall 自动对齐）。
  实测：新装布局从 `8 通过 / 3 失败` → `10 通过 / 1 失败`，剩下那条是本机确实没有
  `settings.yaml`（dsh 用默认值），属真事实而非误报。

### Tests
- `tests/contract_probe_hostfallback_r11.mjs`：**13 项**，用真实安装产物造出
  「服务包在 / 仅宿主树有 / 宿主树也没有」三种形态，跑真探针断言结论。
  变异验证：去掉宿主树回退 → 6 项变红。
- 全量 `npm test`：**700 项全绿**（R10 基线 687 + R11 新增 13）。

## [`0.11.1`] — 安装自动化（dual-package hazard 修复不再手写）

**升级收益一眼看**：过去装完插件必须手写一段 22 行的 symlink 命令，**不做 agent 就变成
「嘴炮」**（有工具却不执行，且没有任何报错）。现在 `npm install` 时由 `postinstall` 自动完成，
安装从 4 步降到 3 步。忘了手动修的那种静默故障，从根上不会再发生。

### Added
- **`postinstall` 自动对齐宿主依赖**：调用 `scripts/link-host-deps.mjs` 把插件
  `@deepseek-ai/*` 本地副本换成指向宿主全局树的 symlink，消除 dual-package hazard。
  脚本本身幂等、有 `--dry-run`，找不到宿主树时**只警告不阻断安装**（Harness 还没装的人
  依然能装好这个包，之后再手动跑）。

### Fixed
- **`link-host-deps` 在真实安装布局下失效（本版核心）**：npm 会把依赖 **hoist 到上层**
  `node_modules` —— 用户装 `<项目>/node_modules/hermes-dsh-bridge` 时，`@deepseek-ai/*`
  落在 `<项目>/node_modules/@deepseek-ai`，**插件内那个目录根本不存在**。旧脚本只看插件内一层，
  于是 postinstall 永远报「本地目录不存在」并 exit 1，自动化形同虚设（实测：装完 0 个 symlink）。
  现在按 Node 的解析顺序**自下而上查找**第一个存在的 scope 目录，与运行时 `import` 的解析结果
  一致；输出里也会说明「依赖被 hoist 到上层」，不让人误以为装错了。
  实测：修前 `symlink=0`，修后 `symlink=23 / 真实目录=2`（剩下 2 个是宿主树本就没有的孤儿包）。

### Tests
- `tests/link_host_deps_r10.mjs`：**14 项**，用真实文件系统造出 hoist / 自包含 / 未安装三种布局，
  跑真脚本断言定位结果、报错行为与幂等性。变异验证：把「向上查找」改回「只看插件内」→ 6 项变红。
- 全量 `npm test`：**687 项全绿**（R9 基线 673 + R10 新增 14）。

## [`0.11.0`] — `session_search` 参数语义修复（**破坏性变更**）

**升级收益一眼看**：`session_search` 的 `limit` 过去**同时**控制「扫多少个会话」和「返回多少条」，
于是 `matched=44` 时可能只给你 20 条，而响应里**没有任何字段**说明还差 24 条——你会以为
「只有 20 个命中」。现在两个数字彻底分开：`scan` = 扫多少（找得全不全），`limit` = 返回多少
（一次给多少，与 `session_list` / `task_list` / `approval_list` 同义）；**只要命中数 > 返回数，
响应里必然有 `omitted` 告诉你还差几条、`hasMore` 和 `next` 告诉你怎么取**。调大 `limit`
真的能拿到更多条。

### ⚠️ BREAKING CHANGES（破坏性变更，务必先读）

- **`limit` 的语义变了**：过去 `limit` 是**扫描深度**（默认 50，clamp 1..200）；
  现在 `limit` 是**返回条数**（默认 20，clamp 1..100），与同 server 其他列表工具的 `limit` 一致。
  - **老的 `limit`（扫描深度）→ 请改用新参数 `scan`**（默认 50，clamp 1..200，语义与旧 `limit` 完全相同）。
  - 迁移对照：旧 `limit=200` 想「扫得更全」→ 新写法 `scan: 200`；
    想让「一次多返回几条」→ 新写法 `limit: 100`（旧版**做不到**这件事）。
  - `limit` 的取值域也随之收紧（旧 1..200 → 新 1..100）。传 101..200 的 `limit` 会被 schema 拒绝
    （而不是静默按 100 截断）——请改用 `scan` 表达「扫得更深」。
- **旧的「返回条数」参数名 `pageSize` 保留为兼容别名**（`limit` 优先），
  但已标注为兼容用途；新代码请用 `limit`。
- **`total` 字段的含义不变**（仍是「本次扫描的会话数」，不是结果数），
  本次**只新增**语义无歧义的别名，不删不改任何既有字段 —— 见下方 Added。

### Added

- **`session_search` 新增 `scan` 参数**：扫描深度（默认 50，clamp 1..200），接手旧 `limit` 的职责。
  工具描述里写清 `scan` = 扫多少、`limit` = 返回多少，调用方（含 LLM）不必再猜。
- **`session_search` 返回体新增字段（全部为纯新增，向后兼容）**：
  - `omitted`：**还剩多少条命中没给**（分页后真实缺口；没有遗漏时为 `0`）。
    这是本轮的核心：旧实现 `matched=44` / 返回 20 时响应里毫无提示。
  - `hasMore`：布尔，等价于「还有下一页」（与 `pageEnvelope` 其余列表工具口径一致）。
  - `matchedTotal`：命中总数的语义无歧义别名（`matched` 保留，同值）。
  - `scannedSessions`：本次扫描会话数的语义无歧义别名（`total` / `scanned` 保留，同值）。
  - `scan`：本次**生效**的扫描深度（会话池不足时 `scannedSessions < scan`，可据此区分）。
  - `filter_noise` / `boilerplate_count` / 结果项 `boilerplate`：见下 P3。
- **P3：样板文字统计降权**。搜 `"dsh"` 时，每个会话都命中的系统提示词样板
  （如 `plete deliverable, including images, ...`）过去会占据前排，把真命中挤到后面。
  现在用**统计特征**判定：把 snippet 规范化后按「近似前导文本」聚簇（同前缀，或共享前缀 ≥ 60%），
  某一簇占**有 snippet 的命中** ≥ 60% 且样本 ≥ 5 时判为「模板文字」，
  **沉到结果末尾并标 `boilerplate: true`**（只是降权，**不删除**）。
  阈值取 60% 而非 80% 是**实测校准**：同一段系统提示词会产生多个近似片段，各自都不到 80%
  （本机 184 会话真实语料实测分成 76.4% / 22.4% 两簇，80% 规则会两簇都不判 = P3 等于没修）。
  可用新参数 **`filter_noise: false`** 关闭。不做黑名单硬编码 —— 换个客户端不会失效。

### Fixed

- **`session_search` 静默丢弃命中**：`matched > 返回条数` 时不再静默——
  `omitted` + `hasMore` + `next` 三件套必然齐备，`next` 里写明「命中 N 条, 本页给了 M 条, 还有 K 条没给」。
- **`session_search` 的 `limit` 语义分裂**：同一个参数不再兼任两种含义（见 BREAKING CHANGES）。
- **无命中时的引导文案**：过去写「调大 limit」（在新语义下是错的引导），现在写「调大 scan」。
- **有截断时的 `hint`**：明确区分「想一次拿更多 → 调大 `limit`」与「想找得更全 → 调大 `scan`」。

### Tests

- `tests/unit_r9.mjs`：**88 项**（参数语义 schema + 真链路行为 + 不丢数据字段 + 口径别名 +
  `offset` 翻页不重叠 + `scan`/`limit` 解耦 + P3 统计判定/同簇合并/端到端降权/开关 + 描述完整性）。
- `scripts/mutation_check_r9.mjs`：**13 项变异全部被检出**（含把 `limit` 改回扫描深度、
  去掉 `omitted`、`hasMore`、`matchedTotal`、样板阈值失效、同簇合并失效、开关失效、版本未升级等），
  改坏 → 红、还原 → 绿、`src/index.ts` 与备份逐字节一致。
- `scripts/realchain_r9.mjs`：**24 项**真链路断言 —— 起真实 HTTP MCP server，数据源接本机
  **真实会话库**（184 个会话），复现 REQ §4.3 要求的两个场景（`matched=44` → `omitted=24`；
  `limit=44` 真能拿到 44 条）。
- `tests/unit_mock_p2.mjs`：原「`limit` 截取扫描范围」断言的旧语义已随破坏性变更同步为
  `scan` 截取扫描范围，并**新增**一条断言证明 `limit` 不再影响扫描深度。
- 全量 `npm test`：**673 项全绿**（R8 基线 584 + R9 新增 88 + P2 同步改写 1）。

## [`0.10.4`] — `ask_user_question` 挂起拦截（终结最阴的静默挂起）

**升级收益一眼看**：dsh agent 卡在 `ask_user_question` 等回答时，桥**立刻**回调通知发起方
（Hermes 会话），而不是让任务**永久挂起**——过去这种状态 `task_result` 恒 `running`、CPU 0%、
零产物，与「正常干活」肉眼完全无法区分，能白等一整夜。现在：提问即通知、答案可经文件喂回、
30 分钟无人应答自动报错结束（不再是无限等待）。

### Added
- **`ask_user_question` 应答器（R8）**：桥注册 `'user-questions/request'` waterfall answerer，
  在 `ask_user_question` 被调用时接管请求：
  - **立刻**发一条 `task:question` 回调给发起方（复用已打通的 webhook → 唤醒链路），载荷带
    `questionId` + 问题全文 + 选项 + `replyContext`，发起方拿到就能答；
  - 同时写 `question_<questionId>.json` 到审批桥目录（`questionCallback` 未配或回调链路不通时
    的兜底通道），发起方写 `question_answer_<questionId>.json` 即可喂回答案；
  - **30 分钟超时兜底**：无人应答则抛错结束该调用（`QUESTION_ANSWER_TIMEOUT_MS`），
    而不是无限挂起。
- **`questionCallback` 配置项**：不配 = 不注册 answerer、行为与旧版**完全一致**（零破坏性）；
  配上后启动日志打 `user-questions answerer registered`，不是静默生效。

### Fixed
- **两个静默失效点（不加就是白干）**：
  - 注册必须带 **`global: true`** —— 提问的 dispatch 走 `scopeTarget(agent, agent)` 做作用域过滤，
    而桥注册在插件根 `ctx`（不在任何 agent 的 scope 祖先链上），不加会**静默收不到任何事件**；
  - 注册必须带 **`prepend: true`** —— `dsh-api-remotes` 也监听该事件并把请求转发给远程 UI 客户端
    且 `await` 其回答；headless 服务（无 Web UI 连接）下这个 promise 永不 settle，waterfall
    就**卡在它那里**，排在其后的 listener（本 answerer）永远收不到。必须插到队首才能真接管。
- **答案文件消费的三种边界**：`questionId` 不匹配不 settle（防串答）、坏 JSON 保留文件待下轮
  （防半写丢答案）、非挂起 id 仍消费文件（防孤儿堆积）——三种都带告警留痕。

### Tests
- `tests/unit_r8.mjs`：**39 项**（注册形状 / 应答器行为 / 文件协议真跑 / 超时兜底 / 回调载荷）。
- `scripts/mutation_check_r8.mjs`：**7 项变异全部被检出**（含 `global` / `prepend` 两个静默失效点），
  改坏→红、还原→绿、逐字节一致。
- 全量 `npm test`：**584 项全绿**（R7 基线 545 + R8 新增 39）。

## [`0.10.3`] — 契约守护收尾 + 高置信缺陷修复

**升级收益一眼看**：默认 provider 没被宿主注册时会**在启动日志里明确告诉你该配什么**
（不再只拿到指向错误对象的上游 `MISSING_CREDENTIAL`）；`fs_read` 的 offset 越界不再
静默返回空串（agent 不会再把它误判成"空文件"）；`set_policy` / `rename_session` 的错误串
回到统一句式；3 处"看起来成功其实没生效"的静默失败接入降级留痕；`fs_write` 的
`create-new` 改为原子创建。**一处破坏性变更**（`fs_read` 越界新增 `note` 字段，返回结构不变）。

### Added
- **P1-1 `provider` 默认值启动引导（R6 §B-2）**：`runtimeConfigDefaults()` 的 provider 默认是
  `deepseek-official`；部署方用自定义 provider 时若只配 `model` 不配 `provider`，失败会停在
  上游组装阶段并报 `MISSING_CREDENTIAL` 之类**指向错误对象**的信息。现在 `apply()` 里做一次
  **运行时探测**（`ctx.llm.listProviders()`，不做版本号比较），当「用户从未显式配置 provider」
  且「该默认值未在宿主注册」时打一条 ⚠️ warn 并计入 `degradations(scope='provider')`。
  **不抛错、不阻断启动、不替用户改默认值**。探测结果通过
  `status_get.providerCheck = {probed,provider,registered,explicit,available}` 暴露。
- **P3-2 `session_search` 新增 `indexFallbackHint`（R6 §C-3）**：回退到 scan 时，
  `indexFallbackReason` 透传的是上游原始码（如 `SESSION_QUERY_SEARCH_DISABLED`），Hermes 侧读不懂。
  现**新增** `indexFallbackHint` 中文解释（说明已回退扫描、常见原因、属上游限制），
  **原字段保留**（按码排查仍然可用），向后兼容。
- **P2-2 三处降级留痕（R6 §B-9）**：精准补上 3 处「功能不工作但没报错」的静默 catch ——
  ① `executeTask` resume 路径的 `sessions.flush`（静默丢持久化，重启后会话内容缺失）；
  ② `preset_set` 的 `agent-preset/selected` 落盘（写失败仍返回 `ok:true`，用户以为切了）；
  ③ `armPendingApproval` 的超时兜底 `apiProxy.respond`（回答丢失，只看到"超时"）。
  **其余 14 处 catch 一律不接**（同源已留痕 / 属预期内失败），避免给 `degradations` 灌噪音。

### Fixed
- **P1-2 `fs_read` offset 越界静默返回空内容（R6 §B-3）**：`offset` 超过 `totalLines` 时
  `lines.slice()` 返回空数组 → `content: ""` + `truncated: false`，**agent 会据此误判"文件是空的"**。
  现越界时在返回体附加 `note` 显式说明「offset=N 超过总行数 M，本次没有任何内容可返回（不是文件为空）
  —— 有效 offset 范围是 1~M」。边界口径：`off === totalLines` **不算**越界（能读到最后一行）；
  `off === totalLines + 1` 及更大值算越界。**正常路径返回结构不变**（`note` 仅在越界时出现）。
- **P2-1 错误句式收口（R6 §B-4 + B-5）**：两处破坏了 R3 建立的 `<错误>: <关键值> (<原因>; <下一步>)`：
  ① `set_policy` 冷会话分支前缀原是 `session <id> is not live; ...`，与家族前缀
  `session not found: <id> (...)` 不一致，agent 用 `startsWith('session not found')` 匹配会漏 ——
  现改用 `errText('session is not live', ...)`；
  ② `rename_session` 在 `sessionNotFoundError()` 的 `)` 之后**外挂拼接** `; 注意本工具只能改 live 会话…`，
  拼完整体不再符合句式、按 `)` 截断解析会丢信息 —— 现把附加说明并进 `sessionNotFoundError` 的新
  可选 `next` 参数（信息不丢，人类可读性不下降）。
- **P3-1 `fs_write` 的 `create-new` TOCTOU（R6 §B-7）**：旧实现先 `stat` 判存在再 `writeFile`（非 `wx`），
  并发两次同路径 `create-new` 都可能通过检查后互相覆盖。现改用
  `writeFile(path, content, { flag: 'wx' })`（`O_EXCL` 原子创建）并捕获 `EEXIST`，
  映射成与既有「文件已存在」分支**完全相同**的错误文案（未引入新文案）。

### Docs
- **P3-2 工具数口径修正（R6 §C-1）**：README 文档索引的 "25/26 个工具" 与
  `docs/TOOLS.md` 的 "this plugin's 26 MCP tools" 表述统一为
  「默认注册 25 个 + `enableFsWrite` 时追加 `fs_write`（共 26）」；
  `src/contract.ts` 的 `tools.usage` 同步改为 "注册 25 个默认 MCP 工具(enableFsWrite 时 26 个)"。
  **代码行为本就正确**（`fs_write` 是安全默认关闭的 opt-in 工具），错的是文档口径。
- 补充 `src/contract.ts` 维护规则：`methods` 必须覆盖**所有被调用的**宿主方法，
  而不只是核心链路方法（漏登记不会有任何提示 —— 这正是 R6 A-1 能长期潜伏的原因）。

### Notes
- 版本号 `0.10.2` → `0.10.3`（同步 `package.json` / `src/index.ts#PLUGIN_VERSION` / README 三处当前版本引用）。
- 新增测试文件 `tests/unit_r7.mjs`（62 项断言），已并入 `npm test`；新增变异检查脚本
  `scripts/mutation_check_r7.mjs`，并入 `npm run test:mutation`。
- 回归：`npm run build` exit 0、`npm test` 全绿（481 + 62 项）、`contract_probe.mjs` `ok:true`。
- 本轮**未重启 `dsh.service`**（重启由主控执行），**未改 `docs/plan/` 下的历史文件**。

## [`0.10.2`] — harness_list_tools 修复 + 回调事件名兼容 + 契约自检补漏

**升级收益一眼看**：`harness_list_tools` 从**长期静默返回 `[]`** 变成真正列出宿主工具（实测 26 个）；
主动回调的载荷补发 `type` 字段，Hermes webhook 平台不再把事件名解析成 `unknown`；
契约自检补上 `tools.schemas` 必需方法，堵住「自检全绿、工具却坏着」的漏洞。无破坏性变更。

### Fixed
- **`harness_list_tools` 恒返回 `[]`（R6 A-1，最高优先级）**：实现读的是 `ctx.tools.keys()`，
  而宿主 `ToolRuntime` **从来没有** `keys()` 方法（`dsh-tools` 只有 `register` / `get` / `schemas`）。
  旧代码用 `as unknown as { keys?: ... }` 屏蔽了类型检查，于是这个工具自诞生起就没工作过，
  返回值却是语法合法的空数组 —— 调用方无从分辨「宿主真没工具」与「读法坏了」。
  **且工具注册在 scope 层**（`view()` 把 scope 自己的层并入 global），不传 scope 只看全局同样是空。
  修法：改为 `ctx.tools.schemas(scope)` 取 `.name`；scope 从 live agent 池里取
  （`setup(agentCtx)` 里 `scopeOf(agentCtx)` 捕获后存进池记录），无 live agent 时退回全局层。
  实测：修复前 `[]` → 修复后 **26 个真实工具**（read/write/edit/glob/grep/bash/…）。
  失败路径接入 `degrade('tools.schemas', ...)`，不再静默。
- **契约自检漏检 `ctx.tools.schemas`（R6 A-2）**：`src/contract.ts` 把 `tools` 登记为必需服务时
  只校验 `methods: ['register']` —— `register` 确实存在，所以 `contract.ok` 一直报 `true`，
  **自检绿着、工具却坏着**，上面那个 bug 因此长期潜伏。现把 `schemas` 加进必需方法清单。
- **回调事件名在 Hermes 侧落成 `unknown`（R6 新发现）**：`buildCallbackPayload()` 只发
  `event: "task:done"`，而 Hermes webhook 平台只从 `X-GitHub-Event` / `X-GitLab-Event` /
  `payload.event_type` / `payload.type` 四处置取事件名，**不读 `payload.event`**。
  于是 Hermes 日志一律是 `POST event=unknown`；`events: []` 时不影响投递，但**任何按事件名
  过滤的配置都会失效**。修法：补发同值的 `type` 字段（保留 `event` 供既有集成方读取）。
  实测：修复前 `event=unknown` → 修复后 `event=task:done`。

### Notes
- 版本号 `0.10.1` → `0.10.2`（同步 `package.json` / `src/index.ts#PLUGIN_VERSION` / README 三处当前版本引用）。
- 回归：`npm test` 全绿（r1 109 项 + P0-1 38 项）、`contract_probe.mjs` `ok:true` 且必需服务方法含 `schemas`、
  真链路冒烟通过（`agent_run` 有真实 stdout + 回调会话成功取回 `task_result`）。

## [`0.10.1`] — 构建产物修复 + doctor profile 自动选择 + 降级通道补全

**升级收益一眼看**：`npm run build` 之后 `lib/types/index.d.ts` **不再消失**（历史 bug：tsdown 清空
`lib/` 把 `tsc` 刚生成的声明删掉，且**没有任何报错**）；`npm run doctor` 不带 `--profile` 时
**自动选中生产真正在跑的那个 profile**（读 systemd `ExecStart`），不再对无关 profile 报
「patch 里没有插件配置段」这类误导性失败；契约/服务路径的静默 catch 从 10 处补到 **20 处**。
无破坏性变更。

### Fixed
- **构建产物丢失（A8）**：根因是 `build` 脚本 `tsc -b && tsdown` 的顺序，配合
  `tsdown.config.js` 的 `outDir: 'lib'` 会 `Cleaning N files` 清空整个 `lib/`（含 `types/`），
  而 `package.json#types` 指向 `lib/types/index.d.ts` → 每次构建后类型入口必然缺失。
  修法：`build` 改为 `tsdown && tsc -b`（tsc 在后）+ tsdown 显式 `clean: false`（双保险）。
  未改 `package.json#types` / `files` 白名单，改动面最小。
  新增 `scripts/check-build-artifacts.mjs` 作为构建最后一步：产物缺失即**构建失败**，把静默失效变成红灯。
  写守卫时又发现**同类的第二处静默失效**：`tsc -b` 的增量缓存（`lib/tsconfig.tsbuildinfo`）在
  `lib/types/` 被删后会声称「已是最新」而**一个文件都不生成、退出码仍是 0**。守卫因此内置自愈：
  清 `tsbuildinfo` + `tsc -b --force` 重建后复核，仍缺才判失败；另加 `npm run build:clean` 彻底重建。
  自愈**不会掩盖真实损坏**（`types` 指向不存在路径时守卫仍 `exit 1`，已实测）。
- **`doctor` 自动选错 profile**：旧实现取 `readdirSync` 字母序第一个（本机 = `acp`），
  而生产 systemd 跑的是 `web`（`ExecStart=... bin.js web --port 3080`）。
  现按优先级探测：① systemd unit 文件 / `systemctl show -p ExecStart` 的 `ExecStart` →
  ② 唯一含本插件配置段的 profile → ③ 唯一有 `cordis.patch.yml` 的 profile（多命中按 mtime 取最新）
  → ④ 兜底字母序第一个并**显式标注「自动探测(可能不是你想要的 profile)」**。
  同时：探测退到兜底时，profile 级检查失败**降级为提示**(不计入失败项)，消除误导性失败。
- **降级通道补全（A5 修正版）**：按分类表（见 `docs/plan/REPORT_r2_20261004.md`）把
  **契约/服务类**仍静默的 catch 接入 `degrade()`，新增 10 处：`apiProxy.respond`、`apiProxy.mux`、
  `agents`(×2)、`agents.cancel`、`agentPresets`、`settings`、`sessionPersistence.open`、
  `sessionPersistence.inspect`、`sessionPersistence.liveLog`、`sessionTitle`、`workspaceRegistry`。
  **未凑数**：纯预期类（`~/.dsh` 不存在、文件已删）与业务类（JSON 解析、参数校验）保持原状。
- **审批桥盲区**：web 桥的 `apiProxy.events.mux()` 流异常中断后，`activeBridgeKind` 仍报 `web`，
  于是 `approval_list` 恒报 0 条待审、`status_get` 显示桥健康——与事实相反。
  现在流中断会 `degrade()` 留痕**并**把桥标记为 `off`、清空挂起表，状态与事实一致。

### Changed
- 版本号 `0.10.0` → `0.10.1`（同步 `package.json` / `src/index.ts#PLUGIN_VERSION` / README 三处当前版本引用）。
- `scripts/check-build-artifacts.mjs` 加入 `npm run build` 的收尾步骤（含增量缓存自愈）；新增 `npm run build:clean`。

## [`0.10.0`] — 宿主契约启动自检 + symlink 自动化

**升级收益一眼看**：宿主契约变更不再**静默失效** —— 启动日志和 `status_get.contract`
会直接告诉你缺了什么；本地依赖树漂移 `doctor` 会直接指出；历史「agent 秒退 + 0 token +
零报错」变成一条自解释的错误日志。无破坏性变更（纯新增：新字段 + 新脚本 + 新告警）。

### Added
- **宿主契约启动自检（`src/contract.ts`）** — 把「桥插件依赖的全部宿主契约」收敛成一份
  可机读、可 diff、可测试的单一事实来源（`HOST_CONTRACT`），并在 `apply()` 注册工具**之前**
  跑一次运行时探测（`probeHostContract`）：
  - 覆盖 3 个直接 import 符号（`dsh-llm#createUserMessage`、`dsh-session#SessionId`、
    `dsh-scope#scopeOf`）与 12 个宿主服务（6 必需 + 6 可选，含探测式 `apiProxy`）；
  - **不做版本号比较**（延续运行时探测哲学，天然兼容 0.1.2 / 0.1.5 / 0.1.7 / 0.2.x），
    符号用 `typeof` 校验，服务用 `ctx.get(key, false)` 存在性 + 期望方法存在性校验；
  - 必需项缺失 → 醒目 `console.error`（`⛔`），**不抛错阻断启动**（保留降级能力）；
    可选项缺失 → `console.warn`。
- **`status_get.contract`** — 暴露探测结果
  `{ok,missingRequired,missingOptional,incompleteMethods,checkedAt,checkedCount}`，
  让 Hermes 侧也能看到宿主契约状态。
- **统一降级通道 `degrade(scope, reason, err?)`** — 契约/服务相关路径的静默 `catch`
  改为走此通道：留痕 + 计数 + 首次告警（同键只告警一次，避免刷屏）。
  `status_get` 新增 `degradationCount` 与 `degradations`（最近 20 条）。
  本轮**只覆盖契约/服务相关**路径（`sessionQuery`、`sessionPersistence.list`、`apiProxy`、
  官方索引回退），全文 71 处 catch 的完整分类属 P1。
- **0-token 显式告警** — `agent_run` / `task_inbox` 收尾时若 `inputTokens === 0` 且本次
  会话事件数为 0，输出自解释的 `console.error`（指向 `MessageSourceMap`/`source.kind`
  契约变更与 `docs/TROUBLESHOOTING.md`），并同步进 `degradations`。
  这是对 0.1.7 那次「agent 秒退 + 0 token + 零报错」的定向防御。
- **`scripts/link-host-deps.mjs`** — 自动探测宿主全局树，把插件
  `node_modules/@deepseek-ai/*` 里**宿主树也有同名**的包替换成 symlink（消除 dual-package
  hazard）。跳过宿主树没有的包（`dsh-agent-presets` / `dsh-code-runtime`，已知技术债）
  并打印说明；支持 `--dry-run`；幂等。
- **`scripts/contract_probe.mjs`** — 独立可运行的契约探针，输出机器可读 JSON
  （可落盘做基线、可 `diff`）；必需项缺失时退出码 1，可直接被 CI 当红灯。
- **`doctor` 新增 2 项检查** — ①「依赖树 symlink 状态」（列出仍是真实目录的包与断链）
  ②「宿主契约探测」（复用 `contract_probe.mjs`，必需项缺失 → ✗）。
- **`npm run contract` / `npm run link-deps`** 两个便捷脚本入口。
- **`tests/unit_contract_p0.mjs`** — 38 条断言覆盖契约清单结构、正常态/变异态探测、
  服务等级分流、方法缺失、`ctx.get` 抛错不传播、`degrade()` 计数与首告警、0-token 告警的
  触发与三种反例。`npm test` 现在跑 6 个测试文件。

### Changed
- 版本号 `0.9.0` → `0.10.0`（同步 `package.json` / `src/index.ts#PLUGIN_VERSION` /
  README 三处当前版本引用）。
- `tests/p3_ts_loader.mjs` 增加 `resolve` 钩子：源码里 `import './contract.js'` 在
  node 类型剥离模式下不会自动映射到 `contract.ts`，现在显式兜底（仅测试加载器，不影响产物）。

## [`0.9.0`] — 会话列表提速 + callback 预设

**升级收益一眼看**：`session_list` 在大会话库上从 **13 s 降到 < 1.5 s**（`limit=50` 从 31 s 降到 < 3 s），
且**耗时不再随会话库增长**；`task_inbox` 回调可以**配一次、之后一行派发**。
无破坏性变更（有一处默认行为变化，见 Changed）。

### Fixed
- **dsh 0.1.7: user messages are no longer silently dropped.** 0.1.7 tightened
  `MessageSourceMap` to `user | model | tool | system-prompt` (there is no catch-all `plugin`
  kind). The plugin built its injected task message with `source: { kind: 'plugin', ... }`,
  which 0.1.7 rejects as invalid — and the message was dropped **without any error**, because
  the rejection is swallowed by `catch (_error) {}` inside the loop's `kick()`. The visible
  symptom was an agent that returned instantly with **0 input/output tokens and no error
  anywhere**; the session existed but contained no events. Now uses the same
  `source: { kind: 'user' }` as the official `dsh-headless` / `dsh-acp` call sites. See
  `docs/TROUBLESHOOTING.md` for the diagnosis recipe (only affects forks that kept the old
  kind).
- **`session_list` / `session_search` were extremely slow on a large history** (issue #1:
  ~13 s at `limit:1`, ~31 s at `limit:50` — clients with a 20 s timeout saw it as a hang).
  Root causes and fixes:
  - The sort key was obtained via `sessionPersistence.stat(id)` for **every** session. In the
    JSONL backend `stat()` is O(number of project directories) — it re-scans the whole tree
    per call (measured ≈47–60 ms × 197 sessions ≈ **9.3 s**). A new `listCorpus()` now reads
    all headers in one pass (`ctx.sessionQuery.listSessions()` on dsh 0.1.7, else
    `sessionPersistence.list()`) and resolves disk mtimes in one batch (`batchUpdatedAt`),
    **never calling `stat()` per session**.
  - `session_search` used the same per-session `stat()` sweep for its rough ordering; it now
    reuses `listCorpus()`.
  - `persistedRowMeta` relied on `locate()`, but `locate()` builds the filename from the
    *current* format version and ignores the session's actual on-disk generation — on this
    host **186 of 200** sessions resolved to a non-existent path, so `updatedAt` silently
    degraded to `createdAt`. `batchUpdatedAt` prefers `locate()` when it resolves, and
    otherwise derives the project directory and reads the real artifact mtime.
  - Measured after the fix: `limit:1` **13 s → < 1.5 s**, `limit:50` **31 s → < 3 s**,
    and cost is now independent of history size.

### Added
- **`session_list` gained `detail: "brief" | "full"` (default `"brief"`).** `brief` returns
  only header-derived fields plus `sizeBytes` and **never reads an event log** — it reports
  `tokensAvailable: false` so an absent count is never mistaken for a real `0`. `full` adds
  `messageCount` / `inputTokens` / `outputTokens` / `llmTime` / `sandboxMode` for the selected
  page only, using concurrency 4 with a 3 s per-session timeout.
- `session_list` / `session_search` now report `skippedNoCwd` for sessions excluded from a
  `cwd` filter because their header carries no `cwd` (previously those rows were dropped
  silently, so an empty result could be misdiagnosed).
- `session_list` reports `source` (`sessionQuery` | `persistence` | `live-only`), so the
  backend actually used is visible.
- `session_search` reports `backend` (`index` | `scan`) and, when it falls back,
  `indexFallbackReason`. On dsh 0.1.7 it will use the official full-text index
  (`ctx.sessionQuery.searchSessions`) when that index is usable. Any `SESSION_QUERY_*` failure
  (including the default `openAt: "never"` deployment and the `locate()` issue above) is
  swallowed and the built-in scan path runs instead — **an unavailable index can never make
  `session_search` fail**.
- `status_get.sessionSearch` and `config_get.sessionSearch` report the effective search backend
  and the last fallback reason.
- **`callbackPreset`: deployment-wide default task callback.** Configure `url` / `method` /
  `headers` / `events` / `replyContext` / `timeoutMs` once, then `task_inbox` may omit
  `callback` entirely or pass only the per-task parts, e.g.
  `{"callback": {"replyContext": {"replyChatId": "..."}}}`. Merge order per field is
  task → preset → built-in. `headers` shallow-merge; `replyContext` deep-merges one level;
  `secret` is deliberately **not** part of the preset (single source of truth remains
  `defaultCallbackSecret`). The SSRF guard runs on the merged URL, so a preset target still
  has to be in `allowedCallbackHosts`.
  - `callbackPreset.requireReplyRoute` (default `false`) rejects a callback whose merged
    `replyContext` has no `*ChatId`/`chatId` field. Recommended when the receiver routes by
    `replyContext` (e.g. Hermes renders `deliver_extra.chat_id = "{replyContext.replyChatId}"`,
    and renders the *literal* template string when the value is missing).
  - `task_inbox`'s response now includes `notify.source` (`preset` | `preset+task` | `task`).
  - `config_get` echoes the preset's structure only (`notify.callbackPreset`) — never header
    or secret values.

### Changed
- **`session_list` rows are now `brief` by default**, so `messageCount` / token fields are
  absent unless you pass `detail: "full"` (they are expensive: each requires reading the whole
  session log). `title` in `brief` mode falls back to `(untitled <id8>)`.
- **`callback.events: []` is now valid and means "subscribe to all terminal events"**,
  matching the receiver-side webhook semantics. Previously the schema defaulted an omitted
  `events` to `["done","error"]` while explicitly passing `[]` was rejected as an invalid
  list. The schema-level `.default()` on `events` / `method` / `timeoutMs` was removed so that
  "not provided" (→ use the preset) is distinguishable from "explicitly provided" — the
  defaults are now applied in `resolveCallback` in the documented task → preset → built-in
  order.

### Compatibility
- **dsh 0.1.7-rc.2 verified end-to-end** (all 25 tools exercised); 0.1.5-rc.2 remains supported.
- With no `callbackPreset` configured, callback behaviour is unchanged.
- dsh 0.1.2 / 0.1.5 are unaffected: `ctx.sessionQuery` is probed at runtime and the
  `sessionPersistence` / live-store path is used when it is absent.

## [0.8.1] - 2026-09-19

### Fixed
- Sync version string in README, docs and index to 0.8.1.

## [0.8.0] - 2026-09-19

### Added
- **Task Callback System (P0 & P1)**:
  - `task_inbox` supports optional `notifyUrl` and `replyContext` parameters for event-driven wakeups.
  - Asynchronous HTTP Webhook notification with HMAC-SHA256 signature verification (`X-Signature-256`, `X-Timestamp`).
  - Strict SSRF protection and DNS pin caching to prevent rebinding attacks.
  - File beacon push mechanism (`notify_<taskId>.json`) for local environments.
  - 100% backward compatible for users without callback configs.

## [0.7.0] - 2026-09-13 — R4: 安装体验与文档 (开箱即用)

R4 目标：用户拿到包之后 **README 5 分钟内跑通、每个报错都能自查、AI agent 装也能一次成功**。
本轮**不改 `src/index.ts` 核心逻辑**（发现的缺陷只记录到 `docs/KNOWN_ISSUES.md`），
全部改动为文档 + 新增自检脚本。

### Added
- **`scripts/doctor.mjs`** — 零依赖、`node` 直接跑的安装自检（只读，不改文件/不重启服务）：
  7 项检查（Node 版本 / dsh 可执行与版本 / profile 存在 / settings 文件 / patch 是否配了插件 /
  端口监听 / MCP 握手 + `tools/list`），每项输出 ✓/✗ + 一条修复建议，最后汇总
  「N 项通过，M 项失败」并以退出码 `0`/`1` 区分。支持 `--url/--host/--port/--profile/--token`，
  自动探测 profile，识别历史包名别名（`dsh-harness-mcp-server`），区分 `dump-config` 的
  EACCES 权限问题与真实配置问题。
- **`docs/KNOWN_ISSUES.md`** — 逐字段核对代码时发现的缺陷清单（10 条，含 4 个真实缺陷：
  `fs_read` offset 越界静默、`fs_list.total` 硬上限下偏小、`rename_session` 错误串破坏统一句式、
  `set_policy` 冷会话错误串前缀不在统一家族；以及 3 条文档/代码口径不一致的 ⚠️）。按约束**本轮不修**。

### Changed
- **README 重写为 quickstart 优先**：首屏 = 一句话是什么 → 30 秒 quickstart（4 步命令跑通 `echo`）
  → 分场景进阶。新增前置依赖表（每项带检查命令）、三种安装路径分人群说明（npm / 源码构建 /
  Hermes 一键配置片段）、常见错误排查表（把 `src/index.ts` 全部面向用户的错误文案逐条过了一遍，
  22 行「原因 + 修复步骤」）、0.1.5 用户升级特别注意表、0.5.x/0.6.x → 0.7.0 升级指南与破坏性变更清单。
  README 内嵌的 doctor 预期输出是**本机真实运行原文**。
- **`docs/CONFIG.md` 与实际 zod schema / `Config` 接口逐字段核对**：16 个字段全部补齐
  （此前缺 `approvalFileDir`；`approvalsBridge` 补上第四值 `file-push`）。修正两处长期口径错误：
  - `approvalTimeoutMs` 真实默认值是 **300000 ms（5 分钟）**，此前文档写 120s —— 以代码为准修正；
  - `provider` 默认值实为 `'deepseek-official'`（非"必填无默认"），`model` 默认空串 = 不覆盖。
  配置示例全部改成 `<your-provider-id>` / `<your-model-id>` 占位符，可复制即用，不写死任何本机配置。
- **`docs/TOOLS.md` 与 26 个工具逐个核对**：每个工具补全参数表（名称/类型/必填/说明）、
  返回字段示例与错误码表。修正：`fs_stat` 不再宣称输出不存在的 `symlinkTarget`；
  `session_search` 补充 `pageSize`/`offset`/`matched`/`scanned` 并标注 `total` = 扫描数而非命中数；
  `session_log` 补 `head`；`fs_list` 补 `offset`/`limit` 与真实分页默认值；
  `approval_list` 补分页与 `pending`/`summary`/`hint`；`config_get` 标注实际没有嵌套 `timeouts` 键；
  `task_list` 补上被遗漏的 `offset`/`limit` 参数。敏感路径错误码更正为代码里的真实文案
  `path denied by policy (sensitive name)`。

### Verification
- 26 个工具的「schema 参数名 ↔ TOOLS.md 入参表」自动化比对：**26/26 通过**。
- CONFIG.md 表格 vs `Config` 接口 + `runtimeConfigDefaults()`：**16/16 字段覆盖**（`port`/`host`
  在 `apply()` 里直接读取、不在 defaults 中，已在文档显式标注）。
- `scripts/doctor.mjs` 在本机真实环境跑通（Node v22.22.3 / dsh 0.1.5-rc.2 / 真实 profile）：
  8 项通过 1 项失败（失败项为本机 profile 目录不可写导致的 `dump-config` EACCES，运行态握手通过）。
- `npm test`：三套 mock 单测 **178 断言全绿**，未回归。

## [0.7.0] - 2026-09-13

dsh runtime upgraded 0.1.2-rc.1 → **0.1.5-rc.2**. This release fixes the
`session_list` crash reported in R1 and reworks all 26 tool descriptions for
agent callers. No breaking changes: tool names, parameter names and existing
response fields are unchanged — only new fields were added.

R3 (agent 使用体验深化) follows up on R2 by cutting the *response payload* and
unifying *error strings* — the part an agent actually reads on every call.

### Fixed
- **`session_list` no-argument crash** (`session_list failed: Cannot read properties of undefined (reading 'length')`). Root cause: dsh 0.1.5 changed the `sessionPersistence` service contract — `list()` now returns `SessionPersistenceSnapshot[]` (`{ header, revision, sizeBytes }`) instead of bare `SessionHeader[]`, and `inspect(id)` was removed in favour of `open(id, 'read')` + `handle.read()`. The old code read `snapshot.id` / `snapshot.cwd` (both `undefined`), so `SessionId(undefined)` and `locate(undefined)` fed `undefined` into path building and produced the exact `reading 'length'` `TypeError`. Reproduced against the real 0.1.5 backend plus the real v3 session file, then fixed via a new compatibility layer (`unwrapPersistedEntry` / `persistedInspect` / `persistedRowMeta`) that transparently supports **both** contracts (0.1.2 bare header + `inspect`, and 0.1.5 snapshot + `open`/`read`/`stat`). Persisted sessions now read their events again on 0.1.5 instead of silently falling back to an empty live store.
- **v3 session format support** (`session.v3.jsonl.zstd` in a directory without the `session-` prefix, plus `agentPresets`/`permission/preset` events). `session_list`, `session_log`, `session_search`, `session_stats`, `preset_get` and orphan reattach all verified against a real v3 session (`messageCount`, folded `title`, token stats, `sandboxMode` and `preset` all resolve correctly).
- **Per-row fault isolation** in `session_list`: a single unreadable or malformed persisted entry is now skipped and counted instead of failing the entire listing.
- **Token stats lost when `assistant/message` carries no `turn`/`step`**: the stats fold used to `break` before accumulating `usage`, so such messages contributed 0 to `inputTokens`/`outputTokens`. Usage is now accumulated independently of step binding.

### Added
- `session_list` response gained a self-describing `skipped` counter (number of sessions skipped by per-row fault isolation; `0` means all rows were read). `total` / `count` / `truncated` / `sessions` are unchanged.
- `session_log` gained an optional `preset` parameter: `"dialog"` (user + assistant messages only), `"tools"` (tool calls + results only), `"all"` (no type filter). Explicit `types` still takes precedence; the default behaviour is unchanged. The response echoes the effective `preset`.
- Self-describing `next` field on results: `agent_run` (how to continue the session), `task_inbox` (how to fetch results), `task_result` (what to do per status), `session_search` (how to use the hits, or what to try when nothing matched), `session_stats`, `session_log` (when truncated), `set_policy`, `approval_list`, `approval_respond`, `fs_read` (when truncated), `fs_write`, `policy_get`, `task_cancel`.
- `tests/probe_v3_real.mjs`: real-environment probe that mounts the actual dsh 0.1.5 `dsh-session-persistence-jsonl` backend over the real session store, reproduces the original `reading 'length'` crash on the old code path, then asserts the fix (20/20).

### Changed
- **All 26 tool descriptions rewritten for agent callers** (when to use it / what it returns / what to do next) instead of implementation details. `agent_run` and `task_inbox` now explicitly cross-reference each other and `task_result`, so an agent can pick the right tool at a glance.
- **Every error message now carries a next step**, e.g. `task not found: <id>` → `… (已过期或从未存在; 用 task_list 查看当前队列 …)`; `session not found: <id>` → `… (用 session_list 查看当前会话列表 …)`; `no active agent session yet` → points at `agent_run` / an explicit `sessionId`.
- **Simplified default `cwd`**: `agent_run` / `task_inbox` (and `policy_get`) now default to `workspaceRoots[0]` when configured, instead of the meaningless-for-remote-agents `process.cwd()`. The effective default is stated in the parameter description, and `process.cwd()` remains the fallback when no `workspaceRoots` is configured.
- `status_get` and `config_get` descriptions now explain when to reach for which one.
- Version 0.6.0 → 0.7.0; `tests/unit_mock_p3.mjs` extended with a 0.1.5-contract instance (v3 snapshot shape, `open`/`read` handle close, malformed-entry `skipped` counting, per-row read failure, and the A/B UX contract); R3 adds a further 62 assertions for A/B/C — suite now 178 assertions, up from 79.

### Compatibility notes (0.1.5 audit, no refactor required)
- `ctx.agent` (singular) removal: **0 direct accesses** in the plugin — it only uses `ctx.agents` and `ctx.agentPresets`, both still present in 0.1.5.
- P3 panel/sidebar slot change (`'conversation'` → `'main'`): not applicable — this plugin registers no web panel or UI slot. The only web-channel use is the optional approval bridge's `apiProxy` subscription, which already degrades safely to `builtin`/`file-push`; `dsh-host-apiproxy` is no longer shipped in 0.1.5 and `ctx.get('apiProxy', false)` returns `undefined` there instead of throwing.

### R3 — A: 返回结构精简 (lower per-call context cost)
- **List responses are paginated** (default page 20, max 100) with a uniform envelope: `total` (post-filter count) / `count` (this page) / `offset` / `limit` / `truncated` / `next` (the exact call to fetch the next page). Added `offset` to `fs_list`, `session_list`, `session_search` (as `pageSize` alongside the existing scan-`limit`), `task_list` and `approval_list`. `task_list` no longer hard-truncates at 100 rows without recourse.
- **`session_log` defaults to ≤50 events**: when `totalMatched` exceeds the cap it returns head + tail (new `head` parameter, default 5; `head: 0` = newest only), sets `truncated: true` and adds `omitted` / `order` / `next` with the three ways to get more (larger `tail` up to 500, `head=0`, or narrower `preset`/`types`).
- **Timestamps are human-readable**: every `*At` / `time` / `mtime` output is now ISO8601 in the local timezone with an explicit `±HH:MM` offset, and the original epoch is preserved alongside as `*_at_epoch` / `time_epoch` (same field name, so existing readers of the ISO field keep working). Covered: `echo.at`, `status_get.startedAt`, `fs_read.modifiedAt`, `fs_list[].mtime`, `fs_stat.mtime`, `session_list[].createdAt/updatedAt`, `session_log.header.createdAt` and `events[].time`, `task_inbox.createdAt`, `task_result/task_list.createdAt/finishedAt`, `approval_list[].requestedAt`.
- **Byte counts and durations are formatted** (`9.4KB`, `8.8s`, `1.5m`) with the raw value kept for sorting: `fs_stat.size` + `size_bytes`, `fs_list[].size` + `size_bytes`, `fs_write.bytes` + `bytes_raw`, `status_get.uptime` (raw `uptimeSec`), `config_get.taskTtl`/`approvalTimeout` (raw `*Ms`), `session_stats.llmTimeHuman`/`toolTimeHuman`/`ttftHuman`, `session_list[].llmTimeHuman`, `task_list/task_result[].waited`, `approval_list[].waited`.
- **Redundant / internal fields dropped**: `config_get` no longer echoes the masked `authToken: '***'` placeholder (only `authTokenSet: boolean` remains).

### R3 — B: agent 工作流指引 (agent_run / task_inbox / 审批流)
- **File-landing hint (`B4`)**: when an `agent_run` / `task_result` payload mentions writing a file ("已写入 / created file / wrote to …") but contains no absolute path, the response adds `landing: { hint, likelyDir, mentionedWrite, pathsInResult }` pointing at the run's sandbox `cwd` as the common landing spot, with the `fs_list`/`fs_stat` calls to locate the file. When the result already carries an absolute path the hint is omitted (no noise).
- **`task_inbox` retention + polling advice (`B5`)**: the submit response now returns `retain` / `retainMs` (how long the result is kept before TTL cleanup), `createdAt` (+ `_epoch`) and a `pollAdvice` string ("poll every 5–15s, don't spin; collect within the retention window"), and its `next` carries the same cadence.
- **Pending-approval summary (`B6`)**: `approval_list` now reports `pending` (total hung approvals) as a first-class field plus a `summary` sentence, so an agent learns there is nothing to answer without diffing lists; `approval_respond` reports `pendingRemaining` / `pendingSummary` after answering (including on the losing `receipt: not-pending` path), removing a follow-up `approval_list` round-trip.

### R3 — C: 一致性与防御 (unified errors, validation, service-down guidance)
- **Three error classes share one shape** — `<错误>: <关键值> (<原因一句话>; <下一步动作>)` — built by helpers `errText` / `missingParamError` / `idNotFoundError` / `emptySessionError`: missing required parameter, id not found (session / task / preset) and empty session. Existing prefixes that callers already match on (`task not found`, `session not found`, `unknown preset`, `query must not be empty`) are preserved; only the suffix is unified.
- **Validation moved to the tool entrance (`C8`)**: every parameterised tool now runs `validateArgs` before any business logic (type + required, echoing `expected <type>, got <actual>`); the zod schemas remain the first gate. `session_search` additionally rejects whitespace-only queries through the unified shape.
- **dsh service-down guidance (`C9`)**: `isDshServiceDown` classifies `ECONNREFUSED`/`ECONNRESET`/`ENOTFOUND`/`EHOSTUNREACH`/`ETIMEDOUT`/`socket hang up`/`fetch failed`, and `toolFailure` replaces the bare error with an actionable "check `dsh.service` status (`systemctl status dsh.service`, restart if needed)" message. All 26 tools route their `catch` branches through it.
- Unit tests: `tests/unit_mock_p3.mjs` gained 62 R3 assertions (pure-helper checks for formatting/pagination/error shapes/service-down classification, plus HTTP-level checks for pagination envelopes, `session_log` truncation, `landing`, retention advice and approval summaries); suite now **178 assertions** (was 116). `__internals` exposes the pure helpers for deterministic testing.
- Regression guard: two R2 contracts were nearly broken by an over-eager "empty session" check — `preset_set` legitimately resumes a **cold blank** session (0 events), and `session_search.total` means *sessions scanned*, not hits (hits are now also exposed as `matched`). Both are covered by the existing P1/P2 suites, which are back to green.

## [0.6.0] - 2026-09-04

### Added
- `approvalsBridge: 'file-push'` mode: pending approvals are mirrored to a file (default `~/.dsh/approvals/`, `approvalFileDir` config) so an out-of-band MCP client (e.g. Hermes) can detect and answer them while `agent_run` is blocked; first-responder-wins semantics unchanged. Approval timeout default raised 120000 → 300000 to match.

### Changed
- **dsh 0.1.2-rc.1 adaptation** (previous src failed to start under dsh 0.1.2):
  - `isTokenDelta` (removed from `@deepseek-ai/dsh-llm/message` in 0.1.2) replaced with an inline check preserving the old semantics: `text-delta`/`reasoning-delta` → non-empty `text`; `tool-call-delta` → non-empty `argumentsDelta` or `name !== undefined`.
  - `resolveSessionPreset` (removed from `@deepseek-ai/dsh-agent-presets` in 0.1.2) replaced with a local `presetFromEvents` scanning `agent-preset/selected` events newest-first for the last non-empty `data.preset`, falling back to `header.agentPreset`.
  - `apiProxy` removed from the `inject` array (the service no longer exists in dsh 0.1.2 headless compositions; injecting it crashed startup); `apiProxyOf` now reads it leniently via `ctx.get('apiProxy', false)` (returns `undefined`, never throws) — the `web` bridge auto-degrades to `builtin` there as before.
  - `@deepseek-ai/*` dsh dependencies loosened from pinned `0.1.0-rc.6` to `^0.1.2-rc.1`; `peerDependencies.@deepseek-ai/cordis` ^4.0.1 → ^4.0.2.
- Version 0.5.0 → 0.6.0; `tests/unit_mock_p3.mjs` mock ctx now serves `apiProxy` through `ctx.get('apiProxy', false)` (matching the cordis hard rule that non-injected services must not be read as properties) and asserts the new defaults (79 assertions).

## [0.5.0] - 2026-08-26

### Added
- **Sandbox tiers (权限三档)**: `agent_run`/`task_inbox` accept `sandbox: read-only|workspace-write|danger-full-access` — a per-task override that seeds a session-log `sandbox/mode` event on newly created/resumed sessions (same write path as dsh `setSandboxMode`; effective on the next confined call, survives restarts via replay). Pool hygiene follows the preset precedent: requests whose tier differs from the pooled session's fixed tier skip the pool, and non-default-tier dedicated sessions never enter it — the three tiers never pollute each other on one cwd. New `defaultSandbox` config (default `workspace-write`).
- `set_policy(sessionId, mode)` tool: switch an existing **live** session's tier (cold/persisted sessions error with a resume hint).
- `policy_get(sessionId?)` tool: `{ sessionId, sandboxMode, source: "override"|"default", workspaceRoot, approvalPolicy }` (folds last `sandbox/mode` + `approval/policy` events; no-arg returns deployment defaults).
- **Approval bridge (审批桥)**: new `approval_list()` and `approval_respond(approvalId, sessionId, outcome)` tools. Bridge mode `web` (default) subscribes `ctx.apiProxy.events.mux()`, tracks pending approvals in memory, syncs on `approval/resolved` frames (first responder wins across Web UI/Hermes; the loser gets `receipt=not-pending`) and answers through `apiProxy.respond({type:'client-response', …})`. Automatic degradation to a builtin `'approval/request'` answerer (asked/decided scan) when apiProxy is absent or `approvalsBridge: 'builtin'` is set; `'off'` disables bridging. `approvalTimeoutMs` (default 120000) settles timed-out approvals cancelled (builtin) / rejected (web) — **never auto-allows**. `task_inbox` is the primary async path; `agent_run` blocks while an approval is pending.
- Status exposure: `status_get` now reports `sandboxPolicy { defaultMode, bridge, pendingApprovals }`; `config_get` reports `defaultSandbox/approvalsBridge/approvalTimeoutMs`; `session_list` rows carry `sandboxMode` when the session has a tier record; `task_list`/`task_result`/`agent_run` echo the requested tier.

### Changed
- Version 0.4.0 → 0.5.0; docs (README/TOOLS/CONFIG/SECURITY) updated for the 25-tool surface.
- CI runs `tests/unit_mock_p3.mjs` (77 assertions: tier pass-through & pool isolation, set_policy live/cold, approval web/builtin flows incl. not-pending races and timeout cancellation, bridge off/explicit-builtin, status/config exposure).

## [0.4.0] - 2026-08-25

### Added
- `agent_run`/`task_inbox` accept an optional `preset` parameter — per-task preset override (single-use, does not touch the global default; unknown id errors with the `available` list). The live-agent pool skips cached sessions whose preset differs from the request.
- `task_cancel` tool: cancel queued tasks (removed from queue) or running tasks (real turn abort via `agent.cancel({kind:'user'})`; result discarded, session preserved for resume). Done/error/missing ids return explicit errors.
- `session_search` tool: cross-session search over titles + content (persisted events via `persistence.inspect`, zstd multi-frame decompress fallback; per-session 2s timeout, concurrency 8, results capped at 20 with snippets).
- Shared `listMergedHeaders()` helper reused by `session_list`, orphan reattach, and `session_search` (dedup).
- `tests/unit_mock_p2.mjs`: mock-ctx unit suite covering all three features (preset validation/mount/pool-miss, task_cancel branches incl. cooperative cancel, session_search title/content/regex/limits/degradation).

### Changed
- Version 0.3.0 → 0.4.0.

### Added
- `session_stats` tool: session statistics (rounds/steps/llmTime/toolTime/ttft/tokensPerSec/cacheHitRate/inputTokens/outputTokens); no-arg = most recent agent session.
- `agent_run`/`task_inbox` results now carry a `stats` object (run-scoped usage accounting).
- `session_list` rows extended with `inputTokens`/`outputTokens`/`llmTime`.
- `fs_write` tool (opt-in via `enableFsWrite: true`): overwrite/append/create-new, workspaceRoots jail + sensitive-name blacklist + ancestor realpath traversal check, 4MB cap.
- `task_list` tool: async task queue snapshot.
- `preset_set` tool: `scope=new-default` updates the runtime default (best-effort write to user-level settings); `scope=session` switches blank sessions only (live recompose / cold resume, records `agent-preset/selected`).
- `apply()` now resets runtimeConfig before stacking config — idempotent across repeated apply calls (fixed cross-instance state leak).

### Changed
- Version 0.2.0 → 0.3.0.
- License MIT → GPL-3.0-only (upstream MIT portions retained, see NOTICE.md).

## [0.2.0] - 2026-08-24

### Added
- `fs_read` / `fs_list` / `fs_stat` file-viewing tools (path jail + sensitive-name blacklist).
- `session_list` / `session_log` session-inspection tools (reasoning stripped).
- `status_get` / `config_get` status tooling (authToken masked).
- `preset_list` / `preset_get` preset inspection.
- Reasoning/thinking stripping from all textual outputs (double filter: event-type level + text-level regex fallback).

## [0.1.x] - 2026-08-22

### Added
- Initial plugin: MCP server (StreamableHTTP) inside Harness exposing `echo`, `harness_list_tools`, `agent_run`, `task_inbox`/`task_result`, `rename_session`, `attach_session`.
- Structured task results (assistantText/toolCalls/toolResults/changes/verification/leftovers).
- Session reuse per cwd; Bearer token auth support; loopback-only default binding.
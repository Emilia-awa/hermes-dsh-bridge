// [R7] 实施轮六项改动的单元测试(纯函数通道 + 静态源码断言, 不依赖 HTTP 时序)。
//
// 覆盖(与 REQ_r7_20261004.md §3 一一对应):
//   P1-1 provider 默认值引导: probeProviderDefault 三态(注册/未注册/探测不可用) + status_get 暴露字段
//   P1-2 fs_read offset 越界: fsReadOffsetNote 边界(totalLines-1 / totalLines / totalLines+1 / 极大值)
//   P2-1 错误句式收口: sessionNotFoundError 可注入 next + set_policy/rename_session 文案形状(源码级)
//   P2-2 三处降级留痕: sessions.flush / agentPresets.append / apiProxy.respond 超时兜底(源码级)
//   P3-1 fs_write create-new: 使用 wx(O_EXCL) 且 EEXIST 映射为既有文案(源码级)
//   P3-2 文档口径 + indexFallbackHint: INDEX_FALLBACK_HINT 存在且含中文说明
//
// 目标选择与 unit_contract_p0 同款: lib 不落后就用 lib, 否则经 p3_ts_loader 现场剥类型加载 src。
import { readFileSync } from 'node:fs'

const rel = '../lib/index.js'
let internals, target

function fileVersionFor(srcPath) {
  try {
    const s = readFileSync(new URL(srcPath, import.meta.url), 'utf8')
    return s.match(/PLUGIN_VERSION\s*=\s*'([^']+)'/)?.[1]
  } catch { return undefined }
}

const srcV = fileVersionFor('../src/index.ts')
let libV
try {
  const s = readFileSync(new URL(rel, import.meta.url), 'utf8')
  libV = s.match(/PLUGIN_VERSION\s*=\s*'([^']+)'/)?.[1]
} catch { libV = undefined }

if (libV !== undefined && libV === srcV) {
  ;({ __internals: internals } = await import(rel))
  target = 'lib/index.js'
} else {
  const { register } = await import('node:module')
  register('./p3_ts_loader.mjs', import.meta.url)
  ;({ __internals: internals } = await import('../src/index.ts'))
  target = 'src/index.ts'
}

// ── 断言小工具 ──
let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}`) }
}

console.log(`── [R7] 目标: ${target} ──`)

const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const {
  probeProviderDefault, DEFAULT_PROVIDER_ID, fsReadOffsetNote, INDEX_FALLBACK_HINT,
  sessionNotFoundError, errText, idNotFoundError, degradationsSnapshot, resetDegradations,
} = internals
// providerCheck 是 getter: 必须每次经 internals 读取, 不能在模块加载时快照成一个值
const pcheck = () => internals.providerCheck

const warns = []
const origWarn = console.warn
console.warn = (...a) => { warns.push(a.join(' ')) }

try {
  // ═══════════ P1-1 provider 默认值引导 ═══════════
  console.log('── P1-1 provider 默认值引导 ──')
  // 修前形态: 无任何 provider 探测; 修后: DEFAULT_PROVIDER_ID 常量 + probeProviderDefault 函数
  ok(DEFAULT_PROVIDER_ID === 'deepseek-official', 'P1-1 默认 provider id 与 runtimeConfigDefaults 一致')

  // 用例 1: 宿主未注册默认 provider + 用户未显式配置 → 必须 warn + degrade
  // resetDegradations() 同时清空 degradationWarned, 保证"首次告警"在本用例里可被观测
  resetDegradations(); warns.length = 0
  probeProviderDefault({ get: (k, s) => (k === 'llm' && s === false ? { listProviders: () => [{ id: 'kenari', name: 'kenari' }] } : undefined) })
  ok(pcheck()?.probed === true, 'P1-1 宿主 llm.listProviders 可用时 probed=true')
  ok(pcheck()?.registered === false, 'P1-1 默认 provider 未注册 → registered=false')
  ok(pcheck()?.explicit === false, 'P1-1 未显式配置 → explicit=false')
  ok(pcheck()?.available.includes('kenari'), 'P1-1 available 含宿主实际注册的 provider(kenari)')
  ok(warns.some((w) => w.includes("默认 provider 'deepseek-official'") && w.includes('没注册它')), 'P1-1 未注册时打 warn(明确指引)')
  ok(warns.some((w) => w.includes('provider: <你的 provider id>')), 'P1-1 warn 文案给出可操作的配置指引')
  ok(degradationsSnapshot().some((d) => d.scope === 'provider'), 'P1-1 同时计入 degradations(scope=provider, status_get 可见)')
  ok(!degradationsSnapshot().some((d) => d.scope === 'contract'), 'P1-1 不误触 contract 降级(不阻断启动)')

  // 用例 2: 宿主注册了默认 provider → 不该告警
  resetDegradations(); warns.length = 0
  probeProviderDefault({ get: (k, s) => (k === 'llm' && s === false ? { listProviders: () => [{ id: 'deepseek-official' }] } : undefined) })
  ok(pcheck()?.registered === true, 'P1-1 默认 provider 已注册 → registered=true')
  ok(warns.length === 0 && degradationsSnapshot().length === 0, 'P1-1 已注册时不告警、不留痕(避免噪音)')

  // 用例 3: 探测不可用(ctx.llm 缺失) → 不做断言, 不崩
  resetDegradations(); warns.length = 0
  probeProviderDefault({ get: () => undefined })
  ok(pcheck()?.probed === false && pcheck()?.registered === null, 'P1-1 ctx.llm 不可用 → probed=false/registered=null(不断言)')
  ok(!warns.some((w) => w.includes('未注册')), 'P1-1 探测不可用时不打"provider 未注册"的误导性 warn')
  ok(degradationsSnapshot().some((d) => d.scope === 'provider'), 'P1-1 探测不可用时留痕说明"跳过自检"(不静默)')

  // 用例 4: listProviders 抛错 → 留痕但不抛(探测自身绝不炸)
  resetDegradations()
  let threw = false
  try {
    probeProviderDefault({ get: (k, s) => (k === 'llm' && s === false ? { listProviders: () => { throw new Error('boom') } } : undefined) })
  } catch { threw = true }
  ok(!threw, 'P1-1 listProviders 抛错不向上传播(绝不阻断启动)')
  ok(degradationsSnapshot().some((d) => d.scope === 'llm.listProviders'), 'P1-1 listProviders 抛错留痕(不静默)')

  // status_get 暴露面(源码级: 字段必须存在, 否则 Hermes 侧看不到)
  ok(/providerCheck: providerCheck \?\? null/.test(SRC), 'P1-1 status_get 暴露 providerCheck 字段')
  ok(/listProviders\(\)/.test(SRC), 'P1-1 用运行时探测 listProviders(), 未做版本号比较')
  ok(!/semver|compareVersions|version\s*[<>]=?\s*['"]0\./.test(SRC), 'P1-1 未引入版本号比较(符合 contract.ts 设计哲学)')

  // ═══════════ P1-2 fs_read offset 越界 ═══════════
  console.log('── P1-2 fs_read offset 越界 ──')
  const T = 100
  ok(fsReadOffsetNote(T - 1, T) === undefined, 'P1-2 off=totalLines-1 不越界(无 note)')
  ok(fsReadOffsetNote(T, T) === undefined, 'P1-2 off=totalLines 不算越界(能读到最后一行, 无 note)')
  const notePlus1 = fsReadOffsetNote(T + 1, T)
  ok(typeof notePlus1 === 'string', 'P1-2 off=totalLines+1 越界(有 note)')
  // 用 String() 兜底: 越界判定被改坏时返回 undefined, 这里应报 ✗ 而不是抛 TypeError(否则整轮测试中断)
  ok(String(notePlus1).includes(`${T + 1}`) && String(notePlus1).includes(`总行数 ${T}`), 'P1-2 note 明示 offset 值与总行数')
  ok(/不是文件为空|没有任何内容/.test(String(notePlus1)), 'P1-2 note 明确否认"文件是空的"(防误判)')
  const noteHuge = fsReadOffsetNote(999999999, T)
  ok(typeof noteHuge === 'string' && noteHuge.includes('999999999'), 'P1-2 极大 offset 也越界且回显原值')
  ok(fsReadOffsetNote(1, 0) !== undefined, 'P1-2 空文件(totalLines=0)配 off=1 也算越界')
  ok(fsReadOffsetNote(1, 1) === undefined, 'P1-2 单行文件 off=1 正常(不误报)')
  // 源码级: 正常路径返回结构未被破坏, note 只在越界时附加
  ok(/\.\.\.\(offsetNote !== undefined \? \{ note: offsetNote \} : \{\}\)/.test(SRC), 'P1-2 note 以可选展开附加(不改正常路径结构)')
  ok(/const offsetNote = fsReadOffsetNote\(off, totalLines\)/.test(SRC), 'P1-2 fs_read 实际调用了越界判定')
  ok(/path: canonical, totalLines, offset: off, limit: lim, truncated, content,/.test(SRC), 'P1-2 既有返回字段(offset/limit/truncated/content)原样保留')

  // ═══════════ P2-1 错误句式收口 ═══════════
  console.log('── P2-1 错误句式收口 ──')
  const FAMILY_RE = /^[a-z][a-z ,/-]*: \S.* \(.+; .+\)$/
  const sessErr = sessionNotFoundError('abc-123')
  ok(FAMILY_RE.test(sessErr), `P2-1 sessionNotFoundError 匹配家族句式: ${sessErr}`)
  ok(sessErr.startsWith('session not found: abc-123 ('), 'P2-1 家族前缀仍为 session not found(向后兼容 startsWith 匹配)')
  const custom = sessionNotFoundError('abc-123', '本工具只能改 live 会话 —— 先唤醒它')
  ok(FAMILY_RE.test(custom), 'P2-1 注入自定义 next 后仍匹配句式(附加说明并进 next 而不是外挂)')
  ok(custom.includes('本工具只能改 live 会话'), 'P2-1 附加说明未丢失(人类可读性不下降)')
  ok(custom.endsWith(')'), 'P2-1 错误串以 ) 结尾(按 ) 截断解析的 agent 不丢信息)')

  // set_policy 冷会话分支: 前缀必须是 errText 家族形状
  const setPolicyCold = errText('session is not live', 'sess-cold', '冷/已持久化的会话必须先在某一轮里被唤醒(它当前没有可写的 live 句柄)', '先跑一轮让它活起来')
  ok(FAMILY_RE.test(setPolicyCold), `P2-1 set_policy 冷会话文案匹配句式: ${setPolicyCold}`)
  ok(/^session is not live: .+ \(.+; .+\)$/.test(setPolicyCold), 'P2-1 set_policy 匹配 ^session is not live: .+ (.+; .+)$')
  // 源码级: 旧外挂形态必须消失
  ok(!/session \$\{sessionId\} is not live;/.test(SRC), 'P2-1 旧前缀 `session <id> is not live;` 已移除')
  ok(/error: errText\(\s*\n\s*'session is not live'/.test(SRC), 'P2-1 set_policy 改用 errText 家族函数')
  ok(!/\$\{sessionNotFoundError\(sessionId\)\}; 注意/.test(SRC), 'P2-1 rename_session 的外挂拼接 `; 注意…` 已移除')
  ok(/sessionNotFoundError\(sessionId, '本工具只能改 live 会话/.test(SRC), 'P2-1 rename_session 把说明并进 next 参数')
  ok(/function sessionNotFoundError\(sessionId: string, next\?: string\)/.test(SRC), 'P2-1 sessionNotFoundError 支持可选 next 覆盖')
  const idnf = idNotFoundError('session', 'x', 'NEXT')
  ok(idnf === 'session not found: x (不存在或已过期; NEXT)', 'P2-1 idNotFoundError 句式未变(契约稳定)')

  // ═══════════ P2-2 三处降级留痕 ═══════════
  console.log('── P2-2 三处降级留痕 ──')
  ok(/degrade\('sessions\.flush', 'resume 路径 flush 失败/.test(SRC), 'P2-2 ① executeTask resume flush 接入 degrade')
  ok(/degrade\('agentPresets\.append', 'agent-preset\/selected 事件写入 live 会话失败/.test(SRC), 'P2-2 ② preset_set append 接入 degrade')
  ok(/degrade\('apiProxy\.respond', '审批超时兜底回答失败/.test(SRC), 'P2-2 ③ armPendingApproval 超时兜底接入 degrade')
  // 只接 3 处: 不得批量补全(REQ §4 明确不做)
  // R6 基线 28 处 + R7 新增 3 处 = 31。超过即为"批量补全"(REQ §4 明确不做, 会污染 degradations)。
  const degradeCallCount = (SRC.match(/degrade\(/g) ?? []).length
  ok(degradeCallCount === 31, `P2-2 degrade 调用点 = 基线 28 + 新增 3(实得 ${degradeCallCount}, 未批量补全)`)
  // 三处都不得吞掉原异常对象(留痕要能定位)
  ok(/degrade\('sessions\.flush',[^\n]*\n?[^\n]*e\)|degrade\('sessions\.flush', [^\n]*e\)/.test(SRC), 'P2-2 ① 留痕带原始异常')
  ok(/degrade\('agentPresets\.append', [^\n]*e\)/.test(SRC), 'P2-2 ② 留痕带原始异常')
  ok(/degrade\('apiProxy\.respond', [^\n]*e\)/.test(SRC), 'P2-2 ③ 留痕带原始异常')
  // 行为级: degrade 三态可用(留痕 + 计数)
  resetDegradations()
  internals.degrade('sessions.flush', 'P2-2 行为级验证', new Error('x'))
  internals.degrade('sessions.flush', 'P2-2 行为级验证', new Error('x'))
  const flushRec = degradationsSnapshot().find((d) => d.scope === 'sessions.flush')
  ok(flushRec?.count === 2, 'P2-2 留痕按 scope+reason 聚合计数(status_get 能看出坏了几次)')

  // ═══════════ P3-1 fs_write create-new TOCTOU ═══════════
  console.log('── P3-1 fs_write create-new TOCTOU ──')
  ok(/flag: 'wx'/.test(SRC), "P3-1 create-new 使用 flag: 'wx'(O_EXCL 原子创建)")
  ok(/\(e as \{ code\?: unknown \}\)\?\.code === 'EEXIST'/.test(SRC), 'P3-1 捕获 EEXIST')
  ok(/fileExistsError = \(\) => errText\('file already exists', canonical, 'mode=create-new 但目标已存在', '改用 mode=overwrite 覆盖, 或 mode=append 追加, 或换个新路径'\)/.test(SRC),
    'P3-1 EEXIST 映射成与既有分支完全相同的文案(未引入新文案)')
  // 修前形态必须消失: stat 预检 + 非 wx 写
  ok(!/const exists = await stat\(canonical\)\.then\(\(\) => true, \(\) => false\)/.test(SRC), 'P3-1 旧 stat 预检 TOCTOU 已移除')
  // create-new 分支必须早于通用 mkdir/append/overwrite 块返回(不落到非 wx 写)
  const cnIdx = SRC.indexOf("if (m === 'create-new') {")
  const appendIdx = SRC.indexOf("if (m === 'append') {", cnIdx)
  ok(cnIdx > 0 && appendIdx > cnIdx && /return out\(JSON\.stringify\(\{ ok: true/.test(SRC.slice(cnIdx, appendIdx)),
    'P3-1 create-new 分支写完即返回(不落进后面的非 wx 写路径)')
  ok(/await appendFile\(canonical, content, 'utf8'\)/.test(SRC) && /await writeFile\(canonical, content, 'utf8'\)/.test(SRC),
    'P3-1 append/overwrite 路径行为未改变')

  // ═══════════ P3-2 文档口径 + indexFallbackHint ═══════════
  console.log('── P3-2 文档口径 + indexFallbackHint ──')
  ok(typeof INDEX_FALLBACK_HINT === 'string' && INDEX_FALLBACK_HINT.length > 40, 'P3-2 INDEX_FALLBACK_HINT 存在且非空')
  ok(/[\u4e00-\u9fa5]/.test(INDEX_FALLBACK_HINT), 'P3-2 hint 是中文人话(不是上游原始码)')
  ok(INDEX_FALLBACK_HINT.includes('已自动回退'), 'P3-2 hint 说明已回退扫描(不是失败)')
  // 强化(变异验证暴露过弱点): 只断言"源码含该字符串"是不够的 ——
  // 把 `...(cond ? {indexFallbackHint} : {})` 改成 `...(false ? ... : {})` 时字符串仍在。
  // 必须同时验证「展开条件就是 indexFallbackReason 存在」这一绑定关系。
  ok(/indexFallbackHint: INDEX_FALLBACK_HINT/.test(SRC), 'P3-2 session_search 返回体新增 indexFallbackHint')
  ok(/\.\.\.\(indexFallbackReason !== undefined \? \{ indexFallbackHint: INDEX_FALLBACK_HINT \} : \{\}\)/.test(SRC),
    'P3-2 indexFallbackHint 的发出条件绑定 indexFallbackReason(不是恒 false 的死代码)')
  ok(/const INDEX_FALLBACK_HINT =/.test(SRC) && /INDEX_FALLBACK_HINT\.length|INDEX_FALLBACK_HINT\b/.test(SRC),
    'P3-2 INDEX_FALLBACK_HINT 常量被真实引用(非仅声明)')
  ok(/\.\.\.\(indexFallbackReason !== undefined \? \{ indexFallbackReason \} : \{\}\)/.test(SRC), 'P3-2 原 indexFallbackReason 字段保留(向后兼容)')
} finally {
  console.warn = origWarn
  resetDegradations()
}

console.log(`\n══ [R7] 单元级结果: PASS=${pass} FAIL=${fail} ══`)
process.exit(fail === 0 ? 0 : 1)

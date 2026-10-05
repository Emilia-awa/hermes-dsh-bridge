// [P0-1] 宿主契约自检 + 可观测降级的单元测试。
//
// 覆盖:
//   B1 契约清单结构(HOST_CONTRACT 覆盖 3 符号 + 12 服务)
//   B2 probeHostContract 正常态(全齐 → ok, 无 missing)
//   B3 probeHostContract 变异态(删符号 / 改错名字 → missingRequired 非空, ok=false)
//   B4 服务缺失分流(required → missingRequired, optional → missingOptional)
//   B5 服务方法缺失(结构漂移)→ incompleteMethods + 归入对应等级
//   B6 ctx.get 抛错不传播(探测自身绝不炸)
//   B7 degrade(): 留痕 + 计数 + 首次告警只一次
//   C1 0-token 告警: inTok=0 且零事件 → console.error; 有事件/有 token → 不告警
//   C2 emptyRun 同时进降级留痕
//
// 目标选择与 unit_mock_r1 同款: lib 不落后就用 lib, 否则经 p3_ts_loader 现场剥类型加载 src。
import { readFileSync } from 'node:fs'

const rel = '../lib/index.js'
let apply, internals, target

function fileVersionFor(srcPath, libPath) {
  try {
    const s = readFileSync(new URL(srcPath, import.meta.url), 'utf8')
    const m = s.match(/PLUGIN_VERSION\s*=\s*'([^']+)'/)
    return m?.[1]
  } catch { return undefined }
}

const srcV = fileVersionFor('../src/index.ts')
let libV
try {
  const s = readFileSync(new URL(rel, import.meta.url), 'utf8')
  libV = s.match(/PLUGIN_VERSION\s*=\s*'([^']+)'/)?.[1]
} catch { libV = undefined }

if (libV !== undefined && libV === srcV) {
  ;({ apply, __internals: internals } = await import(rel))
  target = 'lib/index.js'
} else {
  const { register } = await import('node:module')
  register('./p3_ts_loader.mjs', import.meta.url)
  ;({ apply, __internals: internals } = await import('../src/index.ts'))
  target = 'src/index.ts'
}

// ── 断言小工具 ──
let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}`) }
}

console.log(`── [P0-1] 目标: ${target} ──`)

const { HOST_CONTRACT, probeHostContract, degrade, degradationsSnapshot, resetDegradations, warnOnEmptyRun } = internals

// ═══ B1 契约清单结构 ═══
ok(Array.isArray(HOST_CONTRACT.required) && HOST_CONTRACT.required.length === 3,
  'B1 HOST_CONTRACT.required 恰好 3 个直接 import 符号')
ok(HOST_CONTRACT.required.every((s) => s.pkg && s.export && s.kind && s.usage),
  'B1 每个必需符号都有 pkg/export/kind/usage(报错可自解释)')
const reqSymbolIds = HOST_CONTRACT.required.map((s) => `${s.pkg}#${s.export}`)
ok(reqSymbolIds.includes('@deepseek-ai/dsh-llm#createUserMessage'), 'B1 覆盖 dsh-llm#createUserMessage')
ok(reqSymbolIds.includes('@deepseek-ai/dsh-session#SessionId'), 'B1 覆盖 dsh-session#SessionId')
ok(reqSymbolIds.includes('@deepseek-ai/dsh-scope#scopeOf'), 'B1 覆盖 dsh-scope#scopeOf')
ok(HOST_CONTRACT.services.length === 12, `B1 services 覆盖 12 个服务(实得 ${HOST_CONTRACT.services.length})`)
const reqSvc = HOST_CONTRACT.services.filter((s) => s.required).map((s) => s.key)
ok(['tools', 'llm', 'sessions', 'agents', 'agentPresets', 'sessionPersistence'].every((k) => reqSvc.includes(k)),
  'B1 6 个必需服务齐备(tools/llm/sessions/agents/agentPresets/sessionPersistence)')
const optSvc = HOST_CONTRACT.services.filter((s) => !s.required).map((s) => s.key)
ok(['workspaceRegistry', 'sessionQuery', 'sessionTitle', 'settings', 'approval', 'apiProxy'].every((k) => optSvc.includes(k)),
  'B1 6 个可选服务齐备(含探测式 apiProxy)')

// ═══ B2 正常态 ═══
/** 构造一个「全部齐备」的假 ctx */
function fullCtx() {
  const impl = {}
  for (const s of HOST_CONTRACT.services) {
    const o = {}
    for (const m of s.methods) o[m] = () => {}
    impl[s.key] = o
  }
  return { get: (k, strict) => (k in impl ? impl[k] : (strict === false ? undefined : impl[k])) }
}
const fullSymbols = { createUserMessage: () => {}, SessionId: () => {}, scopeOf: () => {} }

const good = probeHostContract({ ctx: fullCtx(), symbols: fullSymbols })
ok(good.ok === true, 'B2 正常态 ok=true')
ok(good.missingRequired.length === 0, 'B2 正常态 missingRequired 为空')
ok(good.missingOptional.length === 0, 'B2 正常态 missingOptional 为空')
ok(good.checkedCount === HOST_CONTRACT.required.length + HOST_CONTRACT.services.length,
  `B2 checkedCount=清单总数(${good.checkedCount})`)
ok(typeof good.checkedAt === 'number' && good.checkedAt > 0, 'B2 checkedAt 是 ms epoch')

// ═══ B3 变异态: 删符号 / 改错名字 ═══
const mutSymbols = { createUserMessage: () => {}, SessionId: () => {} } // 删掉 scopeOf
const mut = probeHostContract({ ctx: fullCtx(), symbols: mutSymbols })
ok(mut.ok === false, 'B3 删掉 scopeOf → ok=false')
ok(mut.missingRequired.includes('@deepseek-ai/dsh-scope#scopeOf'),
  'B3 missingRequired 精确报出 @deepseek-ai/dsh-scope#scopeOf')

const wrongKind = probeHostContract({ ctx: fullCtx(), symbols: { ...fullSymbols, scopeOf: 'not-a-function' } })
ok(wrongKind.ok === false && wrongKind.missingRequired.includes('@deepseek-ai/dsh-scope#scopeOf'),
  'B3 scopeOf 变成非函数(改名/改形的等价症状)→ 同样被捕获')

const renamed = probeHostContract({ ctx: fullCtx(), symbols: { createrUserMessage: () => {}, SessionId: () => {}, scopeOf: () => {} } })
ok(renamed.ok === false && renamed.missingRequired.includes('@deepseek-ai/dsh-llm#createUserMessage'),
  'B3 createUserMessage 被写错名字 → 捕获')

// ═══ B4 服务缺失分流 ═══
const noTools = { get: (k, strict) => (k === 'tools' ? undefined : fullCtx().get(k, strict)) }
const r4 = probeHostContract({ ctx: noTools, symbols: fullSymbols })
ok(r4.ok === false && r4.missingRequired.includes('tools'), 'B4 必需服务缺失 → missingRequired')

const noApiProxy = { get: (k, strict) => (k === 'apiProxy' ? undefined : fullCtx().get(k, strict)) }
const r4b = probeHostContract({ ctx: noApiProxy, symbols: fullSymbols })
ok(r4b.ok === true, 'B4 可选服务(apiProxy)缺失 → ok 仍为 true(已按设计降级)')
ok(r4b.missingOptional.includes('apiProxy'), 'B4 可选服务缺失 → missingOptional')

// ═══ B5 方法缺失(结构漂移) ═══
const partialCtx = fullCtx()
partialCtx.get = ((orig) => (k, strict) => {
  const v = orig(k, strict)
  if (k === 'agents' && v) return { list: v.list } // 只剩 list, 缺 create/resume
  return v
})(partialCtx.get)
const r5 = probeHostContract({ ctx: partialCtx, symbols: fullSymbols })
ok(r5.ok === false, 'B5 必需服务方法缺失 → ok=false')
ok(r5.incompleteMethods.includes('agents.create') && r5.incompleteMethods.includes('agents.resume'),
  'B5 incompleteMethods 精确报出 agents.create / agents.resume')

// ═══ B6 ctx.get 抛错不传播 ═══
const throwingCtx = { get: () => { throw new Error('boom') } }
let threw = false
let r6
try { r6 = probeHostContract({ ctx: throwingCtx, symbols: fullSymbols }) } catch { threw = true }
ok(!threw, 'B6 ctx.get 抛错时探测自身不抛(绝不阻断启动)')
ok(r6 && r6.ok === false && r6.missingRequired.includes('tools'), 'B6 抛错的服务按缺失处理并归入必需')

// ═══ B7 degrade(): 留痕 + 计数 + 首次告警只一次 ═══
resetDegradations()
const warns = []
const origWarn = console.warn
console.warn = (...a) => { warns.push(a.join(' ')) }
try {
  degradationsSnapshot()
  degrade('sessionQuery', '测试原因一', new Error('e1'))
  degrade('sessionQuery', '测试原因一', new Error('e1'))
  degrade('sessionQuery', '测试原因一')
  degrade('other', '测试原因二')
} finally {
  console.warn = origWarn
}
const snap = degradationsSnapshot()
ok(snap.length === 2, `B7 按 scope+reason 聚合为 2 条(实得 ${snap.length})`)
const rec = snap.find((s) => s.scope === 'sessionQuery')
ok(rec?.count === 3, `B7 同键累加计数=3(实得 ${rec?.count})`)
ok(rec?.error === 'e1', 'B7 首次记录的 error 摘要被保留')
ok(warns.length === 2, `B7 首次告警只发生一次/同键不重复(实得 ${warns.length} 条 warn)`)
ok(warns.some((w) => w.includes('降级 sessionQuery')), 'B7 告警文案含 scope')
resetDegradations()
ok(degradationsSnapshot().length === 0, 'B7 resetDegradations 清空留痕(apply 幂等)')

// ═══ C1 0-token 告警 ═══
const errs = []
const origErr = console.error
console.error = (...a) => { errs.push(a.join(' ')) }
try {
  const handleNoEvents = { agent: { session: { log: [] } } }
  resetDegradations()
  warnOnEmptyRun({ taskId: '', sessionId: 'sess-1', assistantText: '', toolCalls: [], toolResults: [], changes: '', verification: '', leftovers: '', stats: { inputTokens: 0 } }, 0, handleNoEvents)
  ok(errs.length >= 1, 'C1 inTok=0 且零事件 → console.error 触发')
  ok(errs.join('\n').includes('注入的 prompt 未进入会话'), 'C1 告警文案自解释')
  ok(errs.join('\n').includes('MessageSourceMap'), 'C1 告警指向 MessageSourceMap 契约变更')
  ok(errs.join('\n').includes('TROUBLESHOOTING'), 'C1 告警给出排查文档锚点')
  ok(degradationsSnapshot().some((d) => d.scope === 'agent_run'), 'C2 emptyRun 同时进降级留痕(status_get 可见)')

  // 反例 1: 有事件(inTok 仍为 0)—— 不该告警
  errs.length = 0
  resetDegradations()
  warnOnEmptyRun({ taskId: '', sessionId: 'sess-2', assistantText: '', toolCalls: [], toolResults: [], changes: '', verification: '', leftovers: '', stats: { inputTokens: 0 } }, 0, { agent: { session: { log: [{ type: 'user/message' }] } } })
  ok(errs.length === 0, 'C1 有事件但 inTok=0 → 不告警(避免误报)')

  // 反例 2: 有 token —— 不该告警
  errs.length = 0
  warnOnEmptyRun({ taskId: '', sessionId: 'sess-3', assistantText: '', toolCalls: [], toolResults: [], changes: '', verification: '', leftovers: '', stats: { inputTokens: 123 } }, 0, { agent: { session: { log: [] } } })
  ok(errs.length === 0, 'C1 inTok>0 → 不告警')

  // 反例 3: 基线差值(baseline 之前的旧事件不算本次)
  errs.length = 0
  warnOnEmptyRun({ taskId: '', sessionId: 'sess-4', assistantText: '', toolCalls: [], toolResults: [], changes: '', verification: '', leftovers: '', stats: { inputTokens: 0 } }, 5, { agent: { session: { log: [{}, {}, {}, {}, {}] } } })
  ok(errs.length >= 1, 'C1 baseline 差值=0 时仍告警(旧事件不掩盖本次空跑)')
} finally {
  console.error = origErr
}
resetDegradations()

console.log(`\n══ [P0-1] 契约/降级单元级结果: PASS=${pass} FAIL=${fail} ══`)
process.exit(fail === 0 ? 0 : 1)

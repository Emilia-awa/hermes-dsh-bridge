// [R8] ask_user_question 挂起拦截的单元测试(纯函数 + 文件协议 + 源码级断言, 不依赖真实 agent/HTTP 时序)。
//
// 背景(要修的缺陷): dsh 的 `ask_user_question` 走 `ctx.userQuestions.ask()` → 'user-questions/request'
// waterfall。headless 服务下没有 UI 客户端应答, 该调用**永久挂起**: task 恒 running、CPU 0%、零产物,
// 与「正在干活」肉眼无法区分, 能白等一整夜。R8 让桥注册 answerer 接管: 一到就回调通知发起方 + 写盘
// 等回答 + 超时兜底。
//
// 覆盖:
//   A. 注册形状: global + prepend 两个选项都必须在(缺任一都会静默失效, 见源码注释)
//   B. 应答器行为: 空问题交给 next / 已 abort 交给 next / 正常问题进入挂起表 + 回调 + 落盘
//   C. 文件协议: handleQuestionAnswerFile 消费答案文件 → settle; 不匹配/非挂起 → 忽略但消费文件
//   D. 超时兜底: QUESTION_ANSWER_TIMEOUT_MS > 0 且有限(不是 0/Infinity 的假保护)
//   E. 清理: settle/fail 后挂起表无残留
//
// 目标选择与 unit_r7 同款: lib 不落后就用 lib, 否则经 p3_ts_loader 现场剥类型加载 src。
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

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
const origLog = console.log
const origWarn = console.warn
let pass = 0
let fail = 0
const say = (...a) => origLog(...a)
function ok(cond, name) {
  if (cond) { pass++; say(`  ✓ ${name}`) }
  else { fail++; say(`  ✗ ${name}`) }
}

say(`── [R8] 目标: ${target} ──`)

const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const {
  pendingQuestions, makeUserQuestionAnswerer, QUESTION_ANSWER_TIMEOUT_MS,
  handleQuestionAnswerFile, questionFileDir,
} = internals

const warns = []
console.warn = (...a) => { warns.push(a.join(' ')) }

try {
  // ═══════════ A. 注册形状(源码级) ═══════════
  say('── A. 注册形状 ──')
  // global: 提问 dispatch 走 scopeTarget(agent, agent) 过滤, 桥在插件根 ctx 不在任何 agent 的 scope 链上
  // prepend: dsh-api-remotes 也监听该事件并 await 远程 UI 客户端, headless 下永不 settle → 必须插队首
  ok(/ctx\.on\(\s*'user-questions\/request'/.test(SRC), 'A1 桥注册了 user-questions/request 监听器')
  const regBlock = SRC.slice(SRC.indexOf("ctx.on('user-questions/request'"), SRC.indexOf("ctx.on('user-questions/request'") + 200)
  ok(/global:\s*true/.test(regBlock), 'A2 注册带 global: true(否则静默收不到任何事件)')
  ok(/prepend:\s*true/.test(regBlock), 'A3 注册带 prepend: true(否则被 api-remotes 的 await 卡在后面)')
  // 必须盯**注册处**的守卫, 不能全局搜 'questionCallback !== undefined'
  // —— 配置解析块(config.questionCallback !== undefined)里也有同名字符串, 全局搜会假绿。
  const regIdx = SRC.indexOf("ctx.on('user-questions/request'")
  const guardWindow = SRC.slice(Math.max(0, regIdx - 1200), regIdx)
  ok(/runtimeConfig\.questionCallback !== undefined/.test(guardWindow), 'A4 仅当配置了 questionCallback 才注册(不配 = 旧行为不变)')
  ok(/user-questions answerer registered/.test(SRC), 'A5 注册成功有可见日志(不是静默生效)')

  // ═══════════ B. 应答器行为 ═══════════
  say('── B. 应答器行为 ──')
  const fakeCtx = { on: () => () => {} }
  const answerer = makeUserQuestionAnswerer(fakeCtx)

  // B1: 空 questions → 交给 next(不认领, 不误吞别人的请求)
  let nextCalled = 0
  const next = async () => { nextCalled++; return { answers: [] } }
  const r1 = await answerer({ questions: [] }, next)
  ok(nextCalled === 1, 'B1 空 questions 交给 next(不认领)')
  ok(Array.isArray(r1?.answers), 'B1 next 的返回值原样透传')

  // B2: signal 已 abort → 交给 next
  nextCalled = 0
  await answerer({ questions: [{ id: 'q1', question: 'x' }], signal: { aborted: true } }, next)
  ok(nextCalled === 1, 'B2 signal.aborted 时交给 next')

  // B3: 正常问题 → 进入挂起表(不调 next)
  const before = pendingQuestions.size
  nextCalled = 0
  const p = answerer(
    { questions: [{ id: 'filename', question: '文件名用哪个?', header: '确认', options: [{ label: 'a.txt' }] }], agent: { session: { id: 'sess-1' } } },
    next,
  )
  ok(pendingQuestions.size === before + 1, 'B3 正常问题进入挂起表')
  ok(nextCalled === 0, 'B3 正常问题不调 next(认领本次请求)')
  const [qid, entry] = [...pendingQuestions.entries()].find(([, e]) => e.sessionId === 'sess-1') ?? []
  ok(typeof qid === 'string' && qid.length > 0, 'B3 生成了 questionId')
  ok(entry?.questions?.[0]?.id === 'filename', 'B3 问题原文被完整保留')
  ok(entry?.timer !== undefined, 'B3 挂了超时定时器(不会永久挂起)')

  // B4: settle → promise 解决 + 挂起表摘除
  entry.settle({ answers: [{ id: 'filename', selected: ['a.txt'] }] })
  const ans = await p
  ok(ans.answers[0].selected[0] === 'a.txt', 'B4 settle 后 promise 拿到答案')
  ok(!pendingQuestions.has(qid), 'B4 settle 后挂起表无残留')

  // B5: fail → promise reject + 挂起表摘除
  const p2 = answerer({ questions: [{ id: 'q2', question: 'y' }], agent: { session: { id: 'sess-2' } } }, next)
  const [qid2, entry2] = [...pendingQuestions.entries()].find(([, e]) => e.sessionId === 'sess-2') ?? []
  entry2.fail(new Error('boom'))
  let rejected = false
  try { await p2 } catch { rejected = true }
  ok(rejected, 'B5 fail 后 promise reject')
  ok(!pendingQuestions.has(qid2), 'B5 fail 后挂起表无残留')

  // ═══════════ C. 文件协议 ═══════════
  say('── C. 文件协议 ──')
  // 注入临时目录, 让文件协议真跑(测试进程没走 apply, approvalBridgeFiles 默认 null)
  const testDir = `${tmpdir()}/dsh-r8-${process.pid}-${Date.now()}`
  mkdirSync(testDir, { recursive: true })
  internals.approvalBridgeFilesForTest = { dir: testDir }
  {
    const dir = questionFileDir()
    ok(dir === testDir, 'C0 注入目录后 questionFileDir() 指向它')
    // C1: 合法答案文件 → settle
    const p3 = answerer({ questions: [{ id: 'pick', question: '选一个' }], agent: { session: { id: 'sess-3' } } }, next)
    const [qid3] = [...pendingQuestions.entries()].find(([, e]) => e.sessionId === 'sess-3') ?? []
    const fp = `${dir}/question_answer_${qid3}.json`
    writeFileSync(fp, JSON.stringify({ questionId: qid3, answers: [{ id: 'pick', selected: ['B'] }] }), 'utf8')
    await handleQuestionAnswerFile(fp, qid3)
    const a3 = await p3
    ok(a3.answers[0].selected[0] === 'B', 'C1 合法答案文件 → settle 并喂回答案')
    ok(!existsSync(fp), 'C1 消费后删除答案文件(不堆积)')

    // C2: 问题 id 不匹配 → 忽略但仍消费文件
    const p4 = answerer({ questions: [{ id: 'z', question: 'z?' }], agent: { session: { id: 'sess-4' } } }, next)
    const [qid4] = [...pendingQuestions.entries()].find(([, e]) => e.sessionId === 'sess-4') ?? []
    const fp4 = `${dir}/question_answer_${qid4}.json`
    writeFileSync(fp4, JSON.stringify({ questionId: 'someone-else', answers: [{ id: 'z', selected: ['x'] }] }), 'utf8')
    warns.length = 0
    await handleQuestionAnswerFile(fp4, qid4)
    ok(pendingQuestions.has(qid4), 'C2 questionId 不匹配 → 不 settle(防串答)')
    ok(warns.some((w) => w.includes('mismatch')), 'C2 不匹配有告警留痕')
    ok(!existsSync(fp4), 'C2 不匹配的文件仍被消费(不堆积)')
    pendingQuestions.get(qid4).settle({ answers: [] })

    // C3: 半写/坏 JSON → 保留文件待下轮, 不 settle
    const p5 = answerer({ questions: [{ id: 'w', question: 'w?' }], agent: { session: { id: 'sess-5' } } }, next)
    const [qid5] = [...pendingQuestions.entries()].find(([, e]) => e.sessionId === 'sess-5') ?? []
    const fp5 = `${dir}/question_answer_${qid5}.json`
    writeFileSync(fp5, '{"questionId": "incompl', 'utf8')
    await handleQuestionAnswerFile(fp5, qid5)
    ok(pendingQuestions.has(qid5), 'C3 坏 JSON 不 settle')
    ok(existsSync(fp5), 'C3 坏 JSON 文件保留待下轮(防半写丢答案)')
    rmSync(fp5, { force: true })
    pendingQuestions.get(qid5).settle({ answers: [] })

    // C4: 非挂起问题 id → 忽略但消费(防孤儿文件堆积)
    const fp6 = `${dir}/question_answer_orphan-xyz.json`
    writeFileSync(fp6, JSON.stringify({ questionId: 'orphan-xyz', answers: [{ id: 'a', selected: ['1'] }] }), 'utf8')
    warns.length = 0
    await handleQuestionAnswerFile(fp6, 'orphan-xyz')
    ok(!existsSync(fp6), 'C4 非挂起文件被消费(防孤儿堆积)')
    ok(warns.some((w) => w.includes('not-pending')), 'C4 非挂起有告警留痕')
  }
  internals.approvalBridgeFilesForTest = null
  rmSync(testDir, { recursive: true, force: true })

  // ═══════════ D. 超时兜底 ═══════════
  say('── D. 超时兜底 ──')
  ok(typeof QUESTION_ANSWER_TIMEOUT_MS === 'number', 'D1 超时是数值常量')
  ok(QUESTION_ANSWER_TIMEOUT_MS > 0, 'D1 超时 > 0(不是 0 = 永久挂起)')
  ok(Number.isFinite(QUESTION_ANSWER_TIMEOUT_MS), 'D1 超时有限(不是 Infinity 的假保护)')
  ok(QUESTION_ANSWER_TIMEOUT_MS >= 5 * 60 * 1000, 'D1 超时 ≥5 分钟(给人足够反应时间, 不误杀)')
  ok(/超时未答/.test(SRC), 'D2 超时报错文案明确(不是裸 timeout)')
  ok(/clearQuestionTimer/.test(SRC), 'D3 settle/fail 路径清定时器(不留悬挂 timer)')

  // ═══════════ E. 回调载荷 ═══════════
  say('── E. 回调载荷 ──')
  ok(/event:\s*'task:question'/.test(SRC), 'E1 回调 event 用 task:question(与终态回调区分)')
  ok(/type:\s*'task:question'/.test(SRC), "E2 同时带 type 字段(Hermes webhook 平台只认 type, 不认 event)")
  ok(/questionId:\s*entry\.questionId/.test(SRC), 'E3 载荷带 questionId(发起方按它写回答案文件)')
  ok(/questions:\s*entry\.questions/.test(SRC), 'E4 载荷带问题全文(发起方不必再回查)')
  ok(/replyContext/.test(SRC.slice(SRC.indexOf('function dispatchQuestionCallback'), SRC.indexOf('function dispatchQuestionCallback') + 1500)), 'E5 载荷带 replyContext(路由回发起方会话)')
  ok(/hostOfCallbackUrl/.test(SRC), 'E6 日志只打 host 不打完整 url(防 secret 泄漏)')
} finally {
  console.warn = origWarn
}

say(`══ [R8] 单元级结果: PASS=${pass} FAIL=${fail} ══`)
if (fail > 0) process.exit(1)

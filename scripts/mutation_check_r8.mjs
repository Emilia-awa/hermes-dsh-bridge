#!/usr/bin/env node
/**
 * mutation_check_r8.mjs — [R8] 变异验证: ask_user_question 拦截的测试真的会变红吗?
 *
 * 思路与 mutation_check_r7.mjs / mutation_check_p0_contract.mjs 同款:
 *   **备份 → 施加变异(把改动临时改回错误形态) → 重新构建 → 跑 tests/unit_r8.mjs → 观察红绿 → 还原**。
 *
 * 每一项都做**双向**验证:
 *   - 变异前: tests/unit_r8.mjs 必须 exit 0(绿);
 *   - 变异后: 必须 exit 1(红), **且**失败项里出现该项绑定的期望断言关键词(防"随便红"假阳性);
 *   - 还原后: 必须重新 exit 0(绿), 且文件与备份逐字节一致。
 *
 * 注意: tests/unit_r8.mjs 优先用 lib/index.js; 每个阶段都必须先 build ——
 * 不 build 就仍跑旧代码, 变异"不触发"会被误读成"测试没用"。
 *
 * 运行: node scripts/mutation_check_r8.mjs
 * 退出码: 0 = 全部变异被检出且已完整还原; 1 = 有变异未被检出或还原失败。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_INDEX = join(ROOT, 'src/index.ts')
const TEST_R8 = join(ROOT, 'tests/unit_r8.mjs')
const TSDOWN = process.env.TSDOWN_BIN || join(ROOT, 'node_modules/.bin/tsdown')

function build() {
  execFileSync(process.execPath, [TSDOWN, '--env.DSH_BUILD_FACE', 'host'], { cwd: ROOT, stdio: 'pipe' })
}

/** 跑 tests/unit_r8.mjs; 返回 {code, out}(out 含全部 ✓/✗ 行) */
function runTests() {
  try {
    const out = execFileSync(process.execPath, [TEST_R8], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** 失败行(✗ 开头) */
function failedLines(out) {
  return out.split('\n').filter((l) => l.includes('✗'))
}

/**
 * 变异项。每项:
 *   id       — 项号
 *   desc     — 变异描述(把改动改回"错误形态")
 *   from/to  — 源码里的字面替换(必须唯一命中)
 *   expect   — 变异后**必须**在失败行里出现的断言关键词
 *   file     — 目标源文件(默认 src/index.ts)
 */
const MUTATIONS = [
  {
    id: 'R8-A2',
    desc: '去掉 global: true —— 桥在插件根 ctx, 会静默收不到任何 user-questions 事件(回到"永久挂起"缺陷)',
    file: SRC_INDEX,
    from: "    ctx.on('user-questions/request', makeUserQuestionAnswerer(ctx), { global: true, prepend: true })",
    to: "    ctx.on('user-questions/request', makeUserQuestionAnswerer(ctx), { prepend: true })",
    expect: 'A2 注册带 global: true',
  },
  {
    id: 'R8-A3',
    desc: '去掉 prepend: true —— 被 dsh-api-remotes 的 await(等远程 UI 客户端)卡在队后, answerer 永不触发',
    file: SRC_INDEX,
    from: "    ctx.on('user-questions/request', makeUserQuestionAnswerer(ctx), { global: true, prepend: true })",
    to: "    ctx.on('user-questions/request', makeUserQuestionAnswerer(ctx), { global: true })",
    expect: 'A3 注册带 prepend: true',
  },
  {
    id: 'R8-A4',
    desc: '无条件注册 answerer —— 没配 questionCallback 也接管, 破坏"不配 = 旧行为不变"',
    file: SRC_INDEX,
    from: '  if (runtimeConfig.questionCallback !== undefined && typeof (ctx as { on?: unknown }).on === \'function\') {',
    to: '  if (typeof (ctx as { on?: unknown }).on === \'function\') {',
    expect: 'A4 仅当配置了 questionCallback 才注册',
  },
  {
    id: 'R8-B3',
    desc: '正常问题也交给 next —— answerer 不认领, 请求落到 api-remotes 的 await 上, 等于没修',
    file: SRC_INDEX,
    from: "    const questions = req.questions ?? []\n    if (questions.length === 0) {\n      console.warn('[harness-mcp-server] user-questions answerer: 空 questions, 交给 next')\n      return next()\n    }",
    to: "    const questions = req.questions ?? []\n    if (questions.length === 0 || questions.length > 0) {\n      console.warn('[harness-mcp-server] user-questions answerer: 空 questions, 交给 next')\n      return next()\n    }",
    expect: 'B3 正常问题进入挂起表',
  },
  {
    id: 'R8-D1',
    desc: '超时设为 0(不超时)—— 回到"永久挂起", 正是本次要修的缺陷',
    file: SRC_INDEX,
    from: 'const QUESTION_ANSWER_TIMEOUT_MS = 30 * 60 * 1000',
    to: 'const QUESTION_ANSWER_TIMEOUT_MS = 0',
    expect: 'D1 超时 > 0',
  },
  {
    id: 'R8-E2',
    desc: "回调载荷去掉 type 字段 —— Hermes webhook 平台只认 type, 会解析成 event=unknown",
    file: SRC_INDEX,
    from: "    event: 'task:question',\n    type: 'task:question',",
    to: "    event: 'task:question',",
    expect: 'E2 同时带 type 字段',
  },
  {
    id: 'R8-C1',
    desc: '答案文件校验放宽 —— questionId 不匹配也照喂(串答风险)',
    file: SRC_INDEX,
    from: '  if (!mismatch && entry !== undefined && answers.length > 0) {',
    to: '  if (entry !== undefined && answers.length > 0) {',
    expect: 'C2 questionId 不匹配',
  },
]

let exitCode = 0
function assert(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) exitCode = 1
}

// ══ 阶段 0: 备份 ══
const backupOf = new Map()
for (const m of new Set(MUTATIONS.map((x) => x.file))) backupOf.set(m, readFileSync(m, 'utf8'))

// 锚点自检: 每个 from 必须在对应文件里唯一命中(否则变异静默失效 = 假绿)
for (const m of MUTATIONS) {
  const src = backupOf.get(m.file)
  const n = src.split(m.from).length - 1
  if (n !== 1) {
    console.error(`[mutation] ${m.id} 的变异锚点命中 ${n} 次(要求恰好 1 次), 源码结构可能已变:`)
    console.error(`  ${JSON.stringify(m.from)}`)
    process.exit(1)
  }
}

try {
  // ══ 阶段 1: 基线(变异前必须全绿) ══
  console.log('══ 阶段 1/3: 基线(重建 + 跑 tests/unit_r8.mjs) ══')
  build()
  const base = runTests()
  const baseLine = base.out.split('\n').find((l) => l.includes('[R8] 单元级结果')) ?? '(未取到结果行)'
  console.log(`  ${baseLine.trim()}`)
  assert(base.code === 0 && !base.out.includes('✗'), '变异前 tests/unit_r8.mjs 全绿(基线健康)')

  // ══ 阶段 2: 逐项施加变异 ══
  console.log('\n══ 阶段 2/3: 逐项施加变异(改回错误形态) + 重建 + 观察 ══')
  for (const m of MUTATIONS) {
    const original = backupOf.get(m.file)
    console.log(`\n──── ${m.id}: ${m.desc} ────`)
    writeFileSync(m.file, original.replace(m.from, m.to))
    build()
    const mutated = runTests()
    const fails = failedLines(mutated.out)
    const resultLine = mutated.out.split('\n').find((l) => l.includes('[R8] 单元级结果')) ?? '(未取到结果行)'
    console.log(`  ${resultLine.trim()}`)
    for (const f of fails) console.log(`    ${f.trim()}`)
    assert(mutated.code !== 0, `${m.id} 变异后测试变红(exit !== 0)`)
    assert(fails.length > 0, `${m.id} 变异后出现 ✗ 失败项`)
    assert(fails.some((l) => l.includes(m.expect)), `${m.id} 失败项命中期望断言「${m.expect}」`)
    writeFileSync(m.file, original)
  }
} finally {
  // ══ 阶段 3: 还原 ══
  console.log('\n══ 阶段 3/3: 还原全部源文件 + 重建 + 复验 ══')
  for (const [file, content] of backupOf) writeFileSync(file, content)
  for (const [file, content] of backupOf) {
    const same = readFileSync(file, 'utf8') === content
    if (!same) { console.log(`  ✗ ${file} 还原后与备份不一致`); exitCode = 1 }
  }
  console.log('  ✓ 全部源文件已还原(与备份逐字节一致)')
  build()
  const after = runTests()
  const afterLine = after.out.split('\n').find((l) => l.includes('[R8] 单元级结果')) ?? '(未取到结果行)'
  console.log(`  ${afterLine.trim()}`)
  assert(after.code === 0 && !after.out.includes('✗'), '还原后 tests/unit_r8.mjs 回到全绿')
}

console.log('\n' + '─'.repeat(64))
console.log(exitCode === 0
  ? '变异测试通过: R8 各项改动的测试都能真实检出对应回归, 且已完整还原。'
  : '变异测试失败: 见上面 ✗ 项(某条测试是摆设, 或还原不完整)。')
process.exit(exitCode)

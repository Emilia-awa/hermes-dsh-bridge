#!/usr/bin/env node
/**
 * mutation_check_r9.mjs — [R9] 变异验证: session_search 调用体验修复的测试真的会变红吗?
 *
 * 思路与 mutation_check_r8.mjs / mutation_check_r7.mjs 同款:
 *   **备份 → 施加变异(把改动临时改回错误形态) → 重新构建 → 跑 tests/unit_r9.mjs → 观察红绿 → 还原**。
 *
 * 每一项都做**双向**验证:
 *   - 变异前: tests/unit_r9.mjs 必须 exit 0(绿);
 *   - 变异后: 必须 exit 1(红), **且**失败项里出现该项绑定的期望断言关键词(防"随便红"假阳性);
 *   - 还原后: 必须重新 exit 0(绿), 且文件与备份逐字节一致。
 *
 * 注意: tests/unit_r9.mjs 优先用 lib/index.js; 每个阶段都必须先 build ——
 * 不 build 就仍跑旧代码, 变异"不触发"会被误读成"测试没用"。
 *
 * 运行: node scripts/mutation_check_r9.mjs
 * 退出码: 0 = 全部变异被检出且已完整还原; 1 = 有变异未被检出或还原失败。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_INDEX = join(ROOT, 'src/index.ts')
// 版本号从 package.json 动态取（锚点不写死，见 R9-G5）
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const TEST_R9 = join(ROOT, 'tests/unit_r9.mjs')
const TSDOWN = process.env.TSDOWN_BIN || join(ROOT, 'node_modules/.bin/tsdown')

function build() {
  execFileSync(process.execPath, [TSDOWN, '--env.DSH_BUILD_FACE', 'host'], { cwd: ROOT, stdio: 'pipe' })
}

/** 跑 tests/unit_r9.mjs; 返回 {code, out}(out 含全部 ✓/✗ 行) */
function runTests() {
  try {
    const out = execFileSync(process.execPath, [TEST_R9], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 180000 })
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
 */
const MUTATIONS = [
  {
    id: 'R9-P1a',
    desc: '把 limit 改回"扫描深度"语义(回到本轮要修的语义分裂缺陷)',
    from: '        const scanDepth = Math.min(Math.max(1, Math.trunc(scan ?? 50)), 200)',
    to: '        const scanDepth = Math.min(Math.max(1, Math.trunc(limit ?? 50)), 200)',
    expect: 'E2 limit=3 时扫描深度仍是默认 50',
  },
  {
    id: 'R9-P1b',
    desc: '让 limit 不再控制返回条数(parsePage 只认 pageSize) —— 调大 limit 拿不到更多条',
    from: '        const pageLimit = limit !== undefined ? limit : pageSize',
    to: '        const pageLimit = pageSize',
    expect: 'D2 limit=30 时返回全部 25 条命中',
  },
  {
    id: 'R9-P1c',
    desc: '去掉没有给全时的显式提示(回到"matched=44 但只返回 20 且毫无提示"的静默丢弃)',
    from: '        const omitted = Math.max(0, hits.length - meta.offset - page.length)',
    to: '        const omitted = 0',
    expect: 'B2 omitted 明确"还差 5 条"',
  },
  {
    id: 'R9-P1d',
    desc: '去掉 hasMore 字段(调用方只能靠 truncated 猜, 且不知道差多少)',
    from: '          truncated: meta.truncated,\n          hasMore: meta.hasMore,\n          matched: hits.length,\n          matchedTotal: hits.length,\n          scanned: scanned.length,\n          scannedSessions: scanned.length,\n          // [R9 P1] 明确告知"还有多少条没拿到"; 无遗漏时为 0(调用方可直接判 omitted === 0)\n          omitted,',
    to: '          truncated: meta.truncated,\n          matched: hits.length,\n          matchedTotal: hits.length,\n          scanned: scanned.length,\n          scannedSessions: scanned.length,\n          omitted,',
    expect: 'B1 同时给出 hasMore=true',
  },
  {
    id: 'R9-P1e',
    desc: 'next 只说"已截断"不说"还差多少条"(回到不告诉调用方丢了多少)',
    from: '            ? { next: `命中 ${hits.length} 条, 本页给了 ${page.length} 条, 还有 ${omitted} 条没给; 取下一页传 offset=${meta.offset + page.length}&limit=${meta.limit}` }',
    to: '            ? { next: `结果超过 ${meta.limit} 条已截断; 用 offset 取下一页` }',
    expect: 'B2 next 说明还有几条没给',
  },
  {
    id: 'R9-P2a',
    desc: '去掉语义无歧义的 matchedTotal 别名(total/matched/scanned 三者继续易混)',
    from: '          matched: hits.length,\n          matchedTotal: hits.length,',
    to: '          matched: hits.length,',
    expect: 'C1 matched 与 matchedTotal 同值',
  },
  {
    id: 'R9-P2b',
    desc: '去掉 scannedSessions 别名(total 仍是"扫描会话数"这个反直觉命名, 无解释字段)',
    from: '          scanned: scanned.length,\n          scannedSessions: scanned.length,',
    to: '          scanned: scanned.length,',
    expect: 'C2 scannedSessions 是语义无歧义的别名',
  },
  {
    id: 'R9-P3a',
    desc: '样板判定阈值改成"永不判定"(噪音重新占据前排, P3 等于没修)',
    from: 'const NOISE_MIN_RATIO = 0.6',
    to: 'const NOISE_MIN_RATIO = 1.01',
    expect: 'F2 高命中率(9/10)的样板被判定为噪音',
  },
  {
    id: 'R9-P3b',
    desc: '去掉最小样本量门槛(2 个相同 snippet 就判噪音 → 误杀真命中)',
    from: '  if (withSnippet < NOISE_MIN_SAMPLE) return noise',
    to: '  if (withSnippet < 0) return noise',
    expect: 'F4 样本量 < 门槛时不判定',
  },
  {
    id: 'R9-P3c',
    desc: 'noiseKey 不压空白 —— 同一段样板因换行/多空格差异被当成不同文字, 判不出噪音',
    from: "  return snippet.replace(/\\s+/g, ' ').trim().toLowerCase().slice(0, NOISE_KEY_LEN)",
    to: '  return snippet.trim().toLowerCase().slice(0, NOISE_KEY_LEN)',
    expect: 'F6 noiseKey 压空白后视作同一段文字',
  },
  {
    id: 'R9-P3e',
    desc: '去掉"前缀同簇"合并 —— 同一段样板的相邻片段各自成簇, 都达不到阈值 → 判不出(实测 76.4%/22.4% 两簇都不判)',
    from: `      if ((shorter.length >= 8 && longer.startsWith(shorter)) ||
        (shared >= NOISE_MIN_SHARED_PREFIX && shared >= minLen * NOISE_MIN_SHARED_RATIO)) union(a, b)`,
    to: '      if (shorter.length >= 8 && longer.startsWith(shorter)) union(a, b)',
    expect: 'F8 前缀同簇',
  },
  {
    id: 'R9-P3d',
    desc: 'filter_noise 开关失效(传 false 也被当成 true, 调用方无法关掉降权)',
    from: '        const filterNoise = filter_noise !== false',
    to: '        const filterNoise = true',
    expect: 'H3 filter_noise=false 时不判定样板',
  },
  {
    id: 'R9-G5',
    desc: '版本号被改错(破坏性变更未标注版本)',
    // ⚠️ 锚点从 package.json 动态取，不写死 —— 否则每次发版都会失配，
    //    表现为「锚点命中 0 次」导致 mutation 步骤红灯（已踩过两次）。
    from: `const PLUGIN_VERSION = '${PKG_VERSION}'`,
    to: "const PLUGIN_VERSION = '0.0.0-wrong'",
    expect: 'G5 PLUGIN_VERSION 与 package.json 一致',
  },
]

let exitCode = 0
function assert(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) exitCode = 1
}

// ══ 阶段 0: 备份 ══
const BACKUP = readFileSync(SRC_INDEX, 'utf8')

// 锚点自检: 每个 from 必须唯一命中(否则变异静默失效 = 假绿)
for (const m of MUTATIONS) {
  const n = BACKUP.split(m.from).length - 1
  if (n !== 1) {
    console.error(`[mutation] ${m.id} 的变异锚点命中 ${n} 次(要求恰好 1 次), 源码结构可能已变:`)
    console.error(`  ${JSON.stringify(m.from)}`)
    process.exit(1)
  }
}

try {
  // ══ 阶段 1: 基线(变异前必须全绿) ══
  console.log('══ 阶段 1/3: 基线(重建 + 跑 tests/unit_r9.mjs) ══')
  build()
  const base = runTests()
  const baseLine = base.out.split('\n').find((l) => l.includes('[R9] 单元级结果')) ?? '(未取到结果行)'
  console.log(`  ${baseLine.trim()}`)
  assert(base.code === 0 && !base.out.includes('✗'), '变异前 tests/unit_r9.mjs 全绿(基线健康)')

  // ══ 阶段 2: 逐项施加变异 ══
  console.log('\n══ 阶段 2/3: 逐项施加变异(改回错误形态) + 重建 + 观察 ══')
  for (const m of MUTATIONS) {
    const expect = m.expect
    console.log(`\n──── ${m.id}: ${m.desc} ────`)
    writeFileSync(SRC_INDEX, BACKUP.replace(m.from, m.to))
    build()
    const mutated = runTests()
    const fails = failedLines(mutated.out)
    const resultLine = mutated.out.split('\n').find((l) => l.includes('[R9] 单元级结果')) ?? '(未取到结果行)'
    console.log(`  ${resultLine.trim()}`)
    for (const f of fails.slice(0, 6)) console.log(`    ${f.trim()}`)
    assert(mutated.code !== 0, `${m.id} 变异后测试变红(exit !== 0)`)
    assert(fails.length > 0, `${m.id} 变异后出现 ✗ 失败项`)
    assert(fails.some((l) => l.includes(expect)), `${m.id} 失败项命中期望断言「${expect}」`)
    writeFileSync(SRC_INDEX, BACKUP)
  }
} finally {
  // ══ 阶段 3: 还原 ══
  console.log('\n══ 阶段 3/3: 还原源文件 + 重建 + 复验 ══')
  writeFileSync(SRC_INDEX, BACKUP)
  const same = readFileSync(SRC_INDEX, 'utf8') === BACKUP
  if (!same) { console.log('  ✗ src/index.ts 还原后与备份不一致'); exitCode = 1 }
  else console.log('  ✓ src/index.ts 已还原(与备份逐字节一致)')
  build()
  const after = runTests()
  const afterLine = after.out.split('\n').find((l) => l.includes('[R9] 单元级结果')) ?? '(未取到结果行)'
  console.log(`  ${afterLine.trim()}`)
  assert(after.code === 0 && !after.out.includes('✗'), '还原后 tests/unit_r9.mjs 回到全绿')
}

console.log('\n' + '─'.repeat(64))
console.log(exitCode === 0
  ? '变异测试通过: R9 各项改动的测试都能真实检出对应回归, 且已完整还原。'
  : '变异测试失败: 见上面 ✗ 项(某条测试是摆设, 或还原不完整)。')
process.exit(exitCode)

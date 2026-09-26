#!/usr/bin/env node
// [r1] 变异检查(mutation testing): 逐个改坏关键逻辑, 确认测试**变红**。
// 若某个变异后测试仍然全绿 → 说明该逻辑没有被测试覆盖, 是"摆设测试"。
//
// 做法: 备份 src/index.ts → 施加变异 → 重新构建 lib → 跑 r1 测试 → 恢复。
// 只动 src/index.ts(不动 lib), 结束后确保源码与构建产物都恢复原状。
//
// 运行: node scripts/mutation_check_r1.mjs
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src/index.ts')
const LIB = join(ROOT, 'lib/index.js')
const LIBTYPES = join(ROOT, 'lib/types/index.d.ts')
const BAK = join(ROOT, '.mutation_backup.ts')
const LIBBAK = join(ROOT, '.mutation_backup.js')
const TYPESBAK = join(ROOT, '.mutation_backup.d.ts')
const TSDOWN = process.env.TSDOWN_BIN || join(ROOT, 'node_modules/.bin/tsdown')
const NODE = process.execPath

/**
 * 每个变异: { name, find(源串), replace(替换串), expect: 期望变红的测试文件名 }
 * 变异必须落在**被测试断言覆盖**的逻辑上。
 */
const MUTATIONS = [
  {
    name: 'A2 projectDirNameOf: 不再把 / 换成 -(路径推导失效)',
    find: "return '--' + trimmed.replace(/\\//g, '-').replace(/@/g, '~0040') + '--'",
    replace: "return '--' + trimmed.replace(/@/g, '~0040') + '--'",
    expect: 'unit_mock_r1.mjs',
  },
  {
    name: 'A1 listCorpus: sessionQuery 抛错时不再清空半截数据(留着脏行)',
    find: `    } catch { /* 服务异常 → 回退 ② (不留半截数据) */
      rows.length = 0
      byId.clear()
      skipped = 0
    }`,
    replace: `    } catch { /* MUTATED: 故意不清空 */ }`,
    expect: 'unit_mock_r1.mjs',
  },
  {
    name: 'A1 listCorpus: 不统计 skippedNoCwd(D2 计数失效)',
    find: 'for (const row of rows) if (row.header.cwd === undefined) skippedNoCwd++',
    replace: '/* MUTATED: 不统计 skippedNoCwd */',
    expect: 'unit_mock_r1.mjs',
  },
  {
    name: 'A1 listCorpus: live 会话排序键不再取末事件 time',
    find: `      if (log && log.length > 0) {
        const t = Number(log[log.length - 1]?.time)
        if (Number.isFinite(t) && t > 0) row.updatedAt = t
      }`,
    replace: `      /* MUTATED: 不取 live 末事件时间 */`,
    expect: 'unit_mock_r1.mjs',
  },
  {
    name: 'B4 mergeReplyContext: 不再深合并(直接返回 override, 丢掉预设键)',
    find: '  if (!isPlain(base) || !isPlain(override)) return override\n  return { ...base, ...override }',
    replace: '  return override /* MUTATED: 不深合并 */',
    expect: 'unit_mock_r1.mjs',
  },
  {
    name: 'B4 sanitizeCallbackHeaders: 不再剔除保留头',
    find: "    if (CALLBACK_RESERVED_HEADERS.includes(name.toLowerCase())) continue // 保留头剔除",
    replace: "    /* MUTATED: 不剔除保留头 */",
    expect: 'unit_mock_r1.mjs',
  },
  {
    name: 'D6 dispatchTaskCallback: events:[] 不再表示订阅全部',
    find: "  if (!(cb.events.length === 0 || cb.events.includes(item.status as 'done' | 'error' | 'cancelled'))) {",
    replace: "  if (!cb.events.includes(item.status as 'done' | 'error' | 'cancelled')) {",
    expect: 'unit_mock_r1.mjs',
  },
  {
    name: 'D6 resolveCallback: events:[] 还原成非法(旧矛盾行为)',
    find: `    if (filtered.length === 0 && rec.events.length > 0) {`,
    replace: `    if (filtered.length === 0) {`,
    expect: 'unit_mock_r1.mjs',
  },
  {
    name: 'C2 tryIndexSearch: 不再静默回退, 改成把 SESSION_QUERY_* 抛给用户',
    find: "    const code = (e as { code?: unknown })?.code\n    return { reason: typeof code === 'string' ? `官方索引不可用: ${code}` : `官方索引不可用: ${(e as Error)?.message ?? String(e)}` }",
    replace: "    throw e /* MUTATED: 不静默回退 */",
    expect: 'unit_mock_r1.mjs',
  },
  {
    name: 'B3 normalizeCallbackPreset: 不再要求 url(非法预设也生效)',
    find: '  if (out.url === undefined) return undefined',
    replace: '  /* MUTATED: 不校验 url */',
    expect: 'unit_mock_r1.mjs',
  },
  {
    name: 'B5 resolveCallback: timeoutMs 越界不再报错',
    find: "    if (!Number.isInteger(t) || t < 1000 || t > 30000) return { error: errText('invalid parameter value', 'task_inbox.callback.timeoutMs'",
    replace: "    if (false) return { error: errText('invalid parameter value', 'task_inbox.callback.timeoutMs'",
    expect: 'unit_mock_r1.mjs',
  },
  {
    name: 'B4 hasReplyRouteField: 不再识别 chat_id(下划线形式)',
    find: "    if (!k.toLowerCase().replace(/[_-]/g, '').includes('chatid')) continue",
    replace: "    if (!k.toLowerCase().includes('chatid')) continue",
    expect: 'unit_mock_r1.mjs',
  },
  {
    name: 'B1 session_list: detail 默认改成 full(裁决 D1 被破坏)',
    find: "        if (detail === 'full') {",
    replace: "        if (detail !== 'brief') {",
    expect: 'unit_mock_r1.mjs',
  },
  {
    name: 'B2 并发常量改回串行 1',
    find: 'const SESSION_LIST_INSPECT_CONCURRENCY = 4',
    replace: 'const SESSION_LIST_INSPECT_CONCURRENCY = 1',
    expect: 'unit_mock_r1.mjs',
  },
]

function build() {
  execFileSync(NODE, [TSDOWN, '--env.DSH_BUILD_FACE', 'host'], { cwd: ROOT, stdio: 'pipe' })
  restoreTypes() // tsdown 会清空 lib/, 每次构建后立即补回 tsc 产物
}
function runTest(file) {
  try {
    const out = execFileSync(NODE, [join(ROOT, 'tests', file)], { cwd: ROOT, stdio: 'pipe', timeout: 900000 })
    return { code: 0, out: out.toString() }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

const original = readFileSync(SRC, 'utf8')
copyFileSync(SRC, BAK)
if (existsSync(LIB)) copyFileSync(LIB, LIBBAK)
// tsdown 的 outDir=lib 会先 "Cleaning" 整个 lib 目录 → 会删掉 lib/types/index.d.ts。
// 该文件由 `tsc -b` 生成, 本树缺依赖跑不了 tsc, 所以必须自己备份/还原。
const hadTypes = existsSync(LIBTYPES)
if (hadTypes) copyFileSync(LIBTYPES, TYPESBAK)
function restoreTypes() {
  if (hadTypes && !existsSync(LIBTYPES)) {
    try { mkdirSync(dirname(LIBTYPES), { recursive: true }); copyFileSync(TYPESBAK, LIBTYPES) } catch { /* 汇总里会暴露 */ }
  }
}

const results = []
try {
  // 基线: 未变异时必须全绿
  build()
  const baseline = runTest('unit_mock_r1.mjs')
  console.log(`\n基线(未变异): ${baseline.code === 0 ? 'PASS ✅' : 'FAIL ❌'}  ${(baseline.out.match(/PASS=(\d+) FAIL=(\d+)/) ?? []).slice(1).join('/')}`)
  if (baseline.code !== 0) throw new Error('基线不绿, 变异检查无意义')

  for (const m of MUTATIONS) {
    if (!original.includes(m.find)) {
      results.push({ ...m, status: 'SKIP(未匹配到源码锚点)' })
      console.log(`\n⚠ SKIP  ${m.name}\n        锚点未匹配 —— 变异脚本需要更新`)
      continue
    }
    writeFileSync(SRC, original.replace(m.find, m.replace), 'utf8')
    let built = true
    try { build() } catch { built = false }
    if (!built) {
      results.push({ ...m, status: 'SKIP(变异后无法构建)' })
      console.log(`\n⚠ SKIP  ${m.name} (构建失败, 说明该改动本身就是编译错误)`)
      continue
    }
    const r = runTest(m.expect)
    const isRed = r.code !== 0
    const counts = (r.out.match(/PASS=(\d+) FAIL=(\d+)/) ?? []).slice(1)
    results.push({ ...m, status: isRed ? 'RED ✅' : 'GREEN ❌', counts })
    console.log(`${isRed ? '\n✅ RED  ' : '\n❌ GREEN'} ${m.name}\n        ${counts.length ? `PASS=${counts[0]} FAIL=${counts[1]}` : '(未跑到汇总行)'}`)
    if (!isRed) {
      const fails = r.out.split('\n').filter((l) => l.includes('✗')).slice(0, 3)
      if (fails.length) console.log('        意外失败行: ' + fails.join(' | '))
    }
  }
} finally {
  writeFileSync(SRC, original, 'utf8')
  if (existsSync(LIBBAK)) copyFileSync(LIBBAK, LIB)
  try { build() } catch { /* 恢复构建失败会立刻在汇总里暴露 */ }
  restoreTypes()
  unlinkSync(BAK)
  if (existsSync(LIBBAK)) unlinkSync(LIBBAK)
  if (existsSync(TYPESBAK)) unlinkSync(TYPESBAK)
}

const red = results.filter((r) => r.status.startsWith('RED')).length
const green = results.filter((r) => r.status.startsWith('GREEN')).length
const skip = results.filter((r) => r.status.startsWith('SKIP')).length
console.log(`\n══ 变异检查汇总: RED(测试成功抓到)=${red}  GREEN(测试漏掉)=${green}  SKIP=${skip} / 共 ${MUTATIONS.length} ══`)
if (green > 0) {
  console.log('以下变异未被测试抓到, 需要补测试:')
  for (const r of results.filter((x) => x.status.startsWith('GREEN'))) console.log('  - ' + r.name)
}
// 恢复后自检: 源码与 lib 必须回到全绿状态
const after = runTest('unit_mock_r1.mjs')
console.log(`恢复后自检: ${after.code === 0 ? 'PASS ✅ (源码与 lib 已还原)' : 'FAIL ❌ 未正确还原!'}`)
process.exit(green > 0 || after.code !== 0 ? 1 : 0)

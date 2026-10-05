#!/usr/bin/env node
/**
 * mutation_check_p0_contract.mjs — [P0-1] 变异测试: 契约自检真的会告警吗?
 *
 * 与 scripts/mutation_check_r1.mjs 同款思路(备份 → 施加变异 → 重新构建 → 观察 → 恢复),
 * 但断言的是**启动告警行为**而非单测红绿:
 *
 *   变异前: apply() 后 status_get.contract.ok === true, 且**没有** ⛔ 告警
 *   变异后: 从 contract.ts 删掉一个必需符号(还原成「宿主改名的等价症状」),
 *           重新构建 → apply() 时:
 *             · 启动日志出现 `⛔ 宿主契约缺失(必需)`
 *             · status_get.contract.ok === false 且 missingRequired 非空
 *   还原后: 重建, 告警消失, ok 回到 true
 *
 * 本脚本**不启动 dsh.service**(那会杀掉当前 agent 自身进程), 而是直接 import 构建产物、
 * 用假 ctx 调 apply() —— 走的正是插件启动时的同一条代码路径(probeHostContract + 告警 + degrade)。
 *
 * 运行: node scripts/mutation_check_p0_contract.mjs
 * 退出码: 0 = 变异被检出且已还原; 1 = 变异未被检出(契约自检是摆设)或还原失败。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_CONTRACT = join(ROOT, 'src/contract.ts')
const BAK_CONTRACT = join(ROOT, '.mutation_contract_backup.ts')
const TSDOWN = process.env.TSDOWN_BIN || join(ROOT, 'node_modules/.bin/tsdown')
/** 变异: 把 dsh-scope 的必需符号登记名改错(等价于上游改名后桥没跟上) */
const MUTATION_FROM = "{ pkg: '@deepseek-ai/dsh-scope', export: 'scopeOf',"
const MUTATION_TO = "{ pkg: '@deepseek-ai/dsh-scope', export: 'scopeOfRenamedByUpstream',"

function build() {
  execFileSync(process.execPath, [TSDOWN, '--env.DSH_BUILD_FACE', 'host'], { cwd: ROOT, stdio: 'pipe' })
}

/** 用假 ctx 走一遍 apply(), 捕获 console.error / console.warn, 然后读 status_get 的 contract 字段 */
async function runApplyAndProbe(label) {
  const warns = []
  const origErr = console.error
  const origWarn = console.warn
  const origLog = console.log
  console.error = (...a) => warns.push(['error', a.join(' ')])
  console.warn = (...a) => warns.push(['warn', a.join(' ')])
  console.log = () => {} // 静音 apply 的常规日志
  let contract = null
  let applyErr
  try {
    // 每次都拿全新模块实例(带 query 参数绕过 ESM 缓存)
    const mod = await import(`${join(ROOT, 'lib/index.js')}?t=${Date.now()}`)
    const { HOST_CONTRACT } = mod.__internals
    // 假 ctx: 构造一个「服务全齐 + 符号绑定按 HOST_CONTRACT.required 的名字给」的替身。
    // 关键: 符号替身**按契约清单里登记的 export 名**生成 —— 所以清单被改错名时,
    // 真实绑定(createUserMessage/SessionId/scopeOf)就对不上, 立刻暴露为 missingRequired。
    const services = {}
    for (const s of HOST_CONTRACT.services) {
      const impl = {}
      for (const m of s.methods) impl[m] = () => {}
      services[s.key] = impl
    }
    const ctx = {
      get: (k, strict) => (k in services ? services[k] : (strict === false ? undefined : services[k])),
      effect: () => {},
      on: () => {},
      agents: services.agents,
      agentPresets: services.agentPresets,
      tools: services.tools,
      llm: services.llm,
    }
    await mod.apply(ctx, { port: 0, host: '127.0.0.1' })
    contract = mod.__internals.contractReport
    if (typeof ctx.effect === 'function') { /* effect 已注册清理, 忽略 */ }
  } catch (e) {
    applyErr = e
  } finally {
    console.error = origErr
    console.warn = origWarn
    console.log = origLog
  }
  const errs = warns.filter(([k]) => k === 'error').map(([, v]) => v)
  return { warns, errs, contract, applyErr, label }
}

function report(label, r) {
  console.log(`\n──── ${label} ────`)
  if (r.applyErr) console.log(`  apply 抛错: ${r.applyErr?.message ?? r.applyErr}`)
  console.log(`  ⛔ 告警条数: ${r.errs.length}`)
  for (const e of r.errs) console.log(`     ${e.split('\n')[0]}`)
  const c = r.contract
  if (!c) { console.log('  contract: (null —— 探测未执行)'); return r }
  console.log(`  contract.ok=${c.ok}`)
  console.log(`  contract.missingRequired=${JSON.stringify(c.missingRequired)}`)
  console.log(`  contract.missingOptional=${JSON.stringify(c.missingOptional)}`)
  console.log(`  contract.checkedCount=${c.checkedCount}`)
  return r
}

let exitCode = 0
function assert(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) exitCode = 1
}

// ── 备份 ──
copyFileSync(SRC_CONTRACT, BAK_CONTRACT)
const original = readFileSync(SRC_CONTRACT, 'utf8')
if (!original.includes(MUTATION_FROM)) {
  console.error(`[mutation] 找不到变异锚点, 源码结构可能已变:\n  ${MUTATION_FROM}`)
  process.exit(1)
}

try {
  // ══ 阶段 1: 变异前(基线) ══
  console.log('══ 阶段 1/4: 变异前基线(重建 + apply + 观察) ══')
  build()
  const before = report('变异前', await runApplyAndProbe('before'))
  assert(before.contract?.ok === true, '变异前 contract.ok === true')
  assert((before.contract?.missingRequired ?? []).length === 0, '变异前 missingRequired 为空')
  assert(before.errs.length === 0, '变异前无 ⛔ 告警')

  // ══ 阶段 2: 施加变异 ══
  console.log('\n══ 阶段 2/4: 施加变异(必需符号登记名改错) + 重建 ══')
  writeFileSync(SRC_CONTRACT, original.replace(MUTATION_FROM, MUTATION_TO))
  console.log(`  变异: ${MUTATION_FROM}\n     →  ${MUTATION_TO}`)
  build()
  const mutated = report('变异后', await runApplyAndProbe('mutated'))
  assert(mutated.contract?.ok === false, '变异后 contract.ok === false')
  assert((mutated.contract?.missingRequired ?? []).length > 0, '变异后 missingRequired 非空')
  assert(mutated.errs.some((e) => e.includes('⛔')), '变异后启动日志出现 ⛔ 告警')
  assert(mutated.errs.some((e) => e.includes('宿主契约缺失')), '变异后告警文案含「宿主契约缺失」')
} finally {
  // ══ 阶段 3: 还原源码 ══
  console.log('\n══ 阶段 3/4: 还原 src/contract.ts ══')
  copyFileSync(BAK_CONTRACT, SRC_CONTRACT)
  unlinkSync(BAK_CONTRACT)
  console.log(`  已还原; 与备份逐字节一致: ${readFileSync(SRC_CONTRACT, 'utf8') === original}`)
}

// ══ 阶段 4: 还原后复验 ══
console.log('\n══ 阶段 4/4: 还原后重建 + 复验(告警应消失) ══')
build()
const after = report('还原后', await runApplyAndProbe('after'))
assert(after.contract?.ok === true, '还原后 contract.ok 回到 true')
assert(after.errs.length === 0, '还原后 ⛔ 告警消失')

console.log('\n' + '─'.repeat(60))
console.log(exitCode === 0
  ? '变异测试通过: 契约自检能真实检出宿主符号缺失, 且已完整还原。'
  : '变异测试失败: 见上面 ✗ 项(契约自检可能是摆设, 或还原不完整)。')
process.exit(exitCode)

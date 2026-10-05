#!/usr/bin/env node
/**
 * mutation_check_r7.mjs — [R7] 变异验证: 六项改动的测试真的会变红吗?
 *
 * 思路与 mutation_check_p0_contract.mjs / mutation_check_r1.mjs 同款:
 *   **备份 → 施加变异(把改动临时改回错误形态) → 重新构建 → 跑 tests/unit_r7.mjs → 观察红绿 → 还原**。
 *
 * 每一项都做**双向**验证:
 *   - 变异前: tests/unit_r7.mjs 必须 exit 0(绿);
 *   - 变异后: 必须 exit 1(红), **且**失败项里出现该项绑定的期望断言关键词(防止"随便红"假阳性);
 *   - 还原后: 必须重新 exit 0(绿), 且文件与备份逐字节一致。
 *
 * 注意(REQ §5 的 ⚠️): tests/unit_r7.mjs 优先用 lib/index.js; 每个阶段都必须先 build ——
 * 不 build 就仍跑旧代码, 变异"不触发"会被误读成"测试没用"。
 *
 * 运行: node scripts/mutation_check_r7.mjs
 * 退出码: 0 = 六项变异全部被检出且已完整还原; 1 = 有变异未被检出或还原失败。
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_INDEX = join(ROOT, 'src/index.ts')
const TEST_R7 = join(ROOT, 'tests/unit_r7.mjs')
const TSDOWN = process.env.TSDOWN_BIN || join(ROOT, 'node_modules/.bin/tsdown')

function build() {
  execFileSync(process.execPath, [TSDOWN, '--env.DSH_BUILD_FACE', 'host'], { cwd: ROOT, stdio: 'pipe' })
}

/** 跑 tests/unit_r7.mjs; 返回 {code, out}(out 含全部 ✓/✗ 行) */
function runTests() {
  try {
    const out = execFileSync(process.execPath, [TEST_R7], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
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
 * 六项变异。每项:
 *   id       — 与 REQ §3 的项号一致
 *   desc     — 变异描述(把改动改回"错误形态")
 *   from/to  — 源码里的字面替换(必须唯一命中)
 *   expect   — 变异后**必须**在失败行里出现的断言关键词(证明"对应的那条测试红了")
 *   file     — 目标源文件(默认 src/index.ts)
 */
const MUTATIONS = [
  {
    id: 'P1-1',
    desc: "provider 引导回退成「不探测/不告警」—— 删掉 listProviders 探测分支",
    file: SRC_INDEX,
    from: "    if (llm && typeof llm.listProviders === 'function') {",
    to: "    if (false && llm && typeof llm.listProviders === 'function') {",
    expect: 'P1-1 宿主 llm.listProviders 可用时 probed=true',
  },
  {
    id: 'P1-2',
    desc: 'fs_read 越界判定回退成「静默返回空」(off > totalLines 不再提示)',
    file: SRC_INDEX,
    from: "  if (off <= totalLines) return undefined",
    to: "  if (off <= totalLines || off > totalLines) return undefined",
    expect: 'P1-2 off=totalLines+1 越界(有 note)',
  },
  {
    id: 'P2-1',
    // 变异把整段 errText(...) 调用替换成旧式外挂模板串 —— 必须整段替换,
    // 只换前两行会留下孤立的实参 → 语法错误(那是"编译失败"不是"测试变红", 不构成有效证据)。
    desc: 'set_policy 冷会话错误回退成旧前缀 `session <id> is not live; ...`(外挂形态)',
    file: SRC_INDEX,
    from: `            error: errText(
              'session is not live',
              sessionId,
              '冷/已持久化的会话必须先在某一轮里被唤醒(它当前没有可写的 live 句柄)',
              '先跑一轮让它活起来: agent_run(task=..., sessionId=...) 或 task_inbox(task=..., sessionId=...), 之后再调 set_policy; 或直接在那一轮里用 sandbox=... 指定档位; 用 session_list 确认该 id 存在',
            ),`,
    to: "            error: `session ${sessionId} is not live; cold/persisted sessions must be resumed first`,",
    expect: 'P2-1 旧前缀',
  },
  {
    id: 'P2-1b',
    // P2-1 的第二个点位(REQ §3 P2-1 明确列了两处: set_policy + rename_session)。
    desc: 'rename_session 回退成在 sessionNotFoundError() 之后外挂拼接 `; 注意…`(破坏句式)',
    file: SRC_INDEX,
    from: "if (!session) return out(JSON.stringify({ error: sessionNotFoundError(sessionId, '本工具只能改 live 会话 —— 若该会话是冷的, 先用 agent_run(task=..., sessionId=...) 唤醒它再改名; 用 session_list 查看当前会话列表确认 id 拼写') }))",
    to: "if (!session) return out(JSON.stringify({ error: `${sessionNotFoundError(sessionId)}; 注意本工具只能改 live 会话 —— 若该会话是冷的, 先用 agent_run(task=..., sessionId=...) 唤醒它再改名` }))",
    expect: 'P2-1 rename_session 的外挂拼接',
  },
  {
    id: 'P2-2',
    desc: 'preset_set 的 append 失败留痕回退成静默(去掉 degrade 调用)',
    file: SRC_INDEX,
    from: "                degrade('agentPresets.append', 'agent-preset/selected 事件写入 live 会话失败, preset 看似切换成功但未落盘(重启后不生效)', e)",
    to: "                void e",
    expect: 'P2-2 ② preset_set append 接入 degrade',
  },
  {
    id: 'P3-1',
    desc: "fs_write create-new 回退成非原子的 stat 预检 + 非 wx 写(去掉 O_EXCL)",
    file: SRC_INDEX,
    from: "              await writeFile(canonical, content, { encoding: 'utf8', flag: 'wx' })",
    to: "              await writeFile(canonical, content, { encoding: 'utf8' })",
    expect: "P3-1 create-new 使用 flag: 'wx'",
  },
  {
    id: 'P3-2',
    desc: 'indexFallbackHint 的发出条件被写死为 false(字段恒不发出)',
    file: SRC_INDEX,
    from: "          ...(indexFallbackReason !== undefined ? { indexFallbackHint: INDEX_FALLBACK_HINT } : {}),",
    to: "          ...(false ? { indexFallbackHint: INDEX_FALLBACK_HINT } : {}),",
    expect: 'P3-2 indexFallbackHint 的发出条件绑定 indexFallbackReason',
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
  console.log('══ 阶段 1/3: 基线(重建 + 跑 tests/unit_r7.mjs) ══')
  build()
  const base = runTests()
  const baseLine = base.out.split('\n').find((l) => l.includes('[R7] 单元级结果')) ?? '(未取到结果行)'
  console.log(`  ${baseLine.trim()}`)
  assert(base.code === 0 && !base.out.includes('✗'), '变异前 tests/unit_r7.mjs 全绿(基线健康)')

  // ══ 阶段 2: 逐项施加变异 ══
  console.log('\n══ 阶段 2/3: 逐项施加变异(改回错误形态) + 重建 + 观察 ══')
  for (const m of MUTATIONS) {
    const original = backupOf.get(m.file)
    console.log(`\n──── ${m.id}: ${m.desc} ────`)
    writeFileSync(m.file, original.replace(m.from, m.to))
    build()
    const mutated = runTests()
    const fails = failedLines(mutated.out)
    const resultLine = mutated.out.split('\n').find((l) => l.includes('[R7] 单元级结果')) ?? '(未取到结果行)'
    console.log(`  ${resultLine.trim()}`)
    for (const f of fails) console.log(`    ${f.trim()}`)
    assert(mutated.code !== 0, `${m.id} 变异后测试变红(exit !== 0)`)
    assert(fails.length > 0, `${m.id} 变异后出现 ✗ 失败项`)
    assert(fails.some((l) => l.includes(m.expect)), `${m.id} 失败项命中期望断言「${m.expect}」`)
    // 还原该文件
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
  const afterLine = after.out.split('\n').find((l) => l.includes('[R7] 单元级结果')) ?? '(未取到结果行)'
  console.log(`  ${afterLine.trim()}`)
  assert(after.code === 0 && !after.out.includes('✗'), '还原后 tests/unit_r7.mjs 回到全绿')
}

console.log('\n' + '─'.repeat(64))
console.log(exitCode === 0
  ? '变异测试通过: R7 六项改动的测试都能真实检出对应回归, 且已完整还原。'
  : '变异测试失败: 见上面 ✗ 项(某条测试是摆设, 或还原不完整)。')
process.exit(exitCode)

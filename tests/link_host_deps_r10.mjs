// [R10] link-host-deps 的 hoist 检测测试。
//
// 背景（要修的缺陷）：postinstall 自动化后，脚本必须能在**真实安装布局**下找到依赖。
// 但 npm 会把 `@deepseek-ai/*` **hoist 到上层** node_modules：
//   用户装 `<项目>/node_modules/hermes-dsh-bridge` 时，依赖落在 `<项目>/node_modules/@deepseek-ai`，
//   插件内那个目录**根本不存在**。旧脚本只看 `<插件根>/node_modules/@deepseek-ai`，
//   于是 postinstall 永远报「本地目录不存在」并 exit 1 —— 自动化形同虚设。
//
// 本测试用真实文件系统造出两种布局，跑真脚本，断言：
//   A. hoist 布局（依赖在上层）→ 能定位到、且明确告知是 hoist 的
//   B. 自包含布局（依赖在插件内）→ 能定位到
//   C. 都没装 → 明确报错 exit 1（不是静默通过）
//   D. 幂等：重复跑不产生变化
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT_SRC = join(ROOT, 'scripts/link-host-deps.mjs')

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}`) }
}

const SANDBOX = join(tmpdir(), `link-deps-test-${process.pid}-${Date.now()}`)

/** 造一个假的插件根：<base>/node_modules/hermes-dsh-bridge/scripts/link-host-deps.mjs */
function makePluginRoot(base) {
  const plugin = join(base, 'node_modules', 'hermes-dsh-bridge')
  mkdirSync(join(plugin, 'scripts'), { recursive: true })
  writeFileSync(join(plugin, 'scripts', 'link-host-deps.mjs'),
    readFileSync(SCRIPT_SRC, 'utf8'), 'utf8')
  return plugin
}

/** 造宿主树：<base>/host/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkgs> */
function makeHostTree(base, pkgs) {
  const host = join(base, 'host', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
  for (const p of pkgs) {
    mkdirSync(join(host, p), { recursive: true })
    writeFileSync(join(host, p, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${p}`, version: '9.9.9' }), 'utf8')
  }
  return host
}

function run(plugin, args = []) {
  try {
    const out = execFileSync(process.execPath, [join(plugin, 'scripts', 'link-host-deps.mjs'), ...args],
      { cwd: plugin, encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

console.log('── [R10] link-host-deps hoist 检测 ──')

try {
  const PKGS = ['cordis', 'dsh-tools', 'dsh-scope']

  // ═══ A. hoist 布局（真实安装的样子）═══
  console.log('── A. hoist 布局 ──')
  {
    const base = join(SANDBOX, 'hoisted')
    const plugin = makePluginRoot(base)
    const host = makeHostTree(base, PKGS)
    // 依赖落在**上层** <base>/node_modules/@deepseek-ai（插件内没有）
    const hoist = join(base, 'node_modules', '@deepseek-ai')
    mkdirSync(hoist, { recursive: true })
    for (const p of PKGS) {
      mkdirSync(join(hoist, p), { recursive: true })
      writeFileSync(join(hoist, p, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${p}`, version: '0.1.2-rc.1' }), 'utf8')
    }
    ok(!existsSync(join(plugin, 'node_modules', '@deepseek-ai')), 'A0 前提：插件内确实没有 @deepseek-ai（依赖被 hoist）')
    const r = run(plugin, ['--dry-run', '--tree', host])
    ok(r.code === 0, 'A1 hoist 布局下脚本能定位并成功退出（旧代码在这里 exit 1）')
    ok(r.out.includes(hoist), 'A2 定位到的是**上层**的 hoist 目录')
    ok(/hoist/.test(r.out), 'A3 输出明确说明依赖被 hoist（不让人误以为装错了）')
    ok(!/本地 @deepseek-ai 目录不存在/.test(r.out), 'A4 不再报「目录不存在」')
  }

  // ═══ B. 自包含布局（生产部署的样子）═══
  console.log('── B. 自包含布局 ──')
  {
    const base = join(SANDBOX, 'selfcontained')
    const plugin = makePluginRoot(base)
    const host = makeHostTree(base, PKGS)
    const inner = join(plugin, 'node_modules', '@deepseek-ai')
    mkdirSync(inner, { recursive: true })
    for (const p of PKGS) {
      mkdirSync(join(inner, p), { recursive: true })
      writeFileSync(join(inner, p, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${p}`, version: '0.1.2-rc.1' }), 'utf8')
    }
    const r = run(plugin, ['--dry-run', '--tree', host])
    ok(r.code === 0, 'B1 自包含布局下成功退出')
    ok(r.out.includes(inner), 'B2 定位到的是**插件内**的目录（不越级去找上层）')
    ok(!/hoist/.test(r.out), 'B3 自包含时不误报 hoist')
  }

  // ═══ C. 完全没装 → 明确报错 ═══
  console.log('── C. 依赖未安装 ──')
  {
    const base = join(SANDBOX, 'nothing')
    const plugin = makePluginRoot(base)
    const host = makeHostTree(base, PKGS)
    const r = run(plugin, ['--dry-run', '--tree', host])
    ok(r.code !== 0, 'C1 找不到依赖时 exit !== 0（不静默通过）')
    ok(/向上找不到|还没装依赖/.test(r.out), 'C2 报错文案说明了原因与下一步')
  }

  // ═══ D. 幂等 ═══
  console.log('── D. 幂等 ──')
  {
    const base = join(SANDBOX, 'idem')
    const plugin = makePluginRoot(base)
    const host = makeHostTree(base, PKGS)
    const hoist = join(base, 'node_modules', '@deepseek-ai')
    mkdirSync(hoist, { recursive: true })
    for (const p of PKGS) {
      mkdirSync(join(hoist, p), { recursive: true })
      writeFileSync(join(hoist, p, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${p}` }), 'utf8')
    }
    const r1 = run(plugin, ['--tree', host])
    ok(r1.code === 0, 'D1 首次执行成功')
    const linked = PKGS.filter((p) => {
      try { return readFileSync(join(hoist, p, 'package.json'), 'utf8').length >= 0 } catch { return false }
    })
    ok(linked.length === PKGS.length, 'D2 首次执行后包仍可读')
    const r2 = run(plugin, ['--tree', host])
    ok(r2.code === 0, 'D3 二次执行仍成功（幂等）')
    ok(/无/.test(r2.out) || /跳过/.test(r2.out), 'D4 二次执行无新动作')
  }
} finally {
  rmSync(SANDBOX, { recursive: true, force: true })
}

console.log(`══ [R10] 结果: PASS=${pass} FAIL=${fail} ══`)
if (fail > 0) process.exit(1)

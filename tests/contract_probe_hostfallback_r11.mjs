// [R11] contract_probe 的宿主树回退测试。
//
// 背景（要修的缺陷）：契约探针用 `require.resolve` 从**插件自己的**位置解析服务包，
// 但那些包（dsh-session-persistence 等）**由宿主提供，不在插件的 dependencies 里**。
// 于是干净安装下探针报 required 服务缺失、doctor 报红叉 —— 新用户以为装坏了。
// 本机之所以「看起来正常」，只是因为 `/root/.dsh/profiles/node_modules` 这个历史遗留
// 目录恰好挡在解析路径上。这是诊断工具的假警报，不是插件真坏。
//
// 造场景的办法（贴合 npm 真实布局）：把「已安装的项目」整体复制到隔离目录，
// 保持 hoist 布局不变，只**删掉** @deepseek-ai 里的服务包 —— 这正好复现
// 「插件 dependencies 里没有该服务包、只有宿主树有」的干净安装形态。
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROBE_SRC = join(ROOT, 'scripts', 'contract_probe.mjs')
const HOST_TREE = '/opt/node22/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const REQUIRED_SVC = 'dsh-session-persistence'

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}`) }
}

const SANDBOX = join(tmpdir(), `r11-${process.pid}-${Date.now()}`)
let seq = 0

function runProbe(pluginDir, env = {}) {
  try {
    const out = execFileSync(process.execPath, [join(pluginDir, 'scripts', 'contract_probe.mjs')],
      { cwd: pluginDir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}
function parse(out) { try { return JSON.parse(out) } catch { return undefined } }

/** 复制一份已安装的项目；dropService=true 时删掉 @deepseek-ai 里的服务包（模拟干净安装） */
function makeProject(installedProject, { dropService }) {
  const base = join(SANDBOX, `proj-${++seq}`)
  rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  cpSync(join(installedProject, 'node_modules'), join(base, 'node_modules'), { recursive: true, dereference: false })
  const plugin = join(base, 'node_modules', 'hermes-dsh-bridge')
  if (dropService) {
    // @deepseek-ai 可能被 hoist 到任一层，逐层找并删掉服务包
    let dir = plugin
    for (let i = 0; i < 12; i++) {
      const scope = join(dir, 'node_modules', '@deepseek-ai')
      if (existsSync(scope)) rmSync(join(scope, REQUIRED_SVC), { recursive: true, force: true })
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  // 探针脚本换成当前工作副本（测的是本轮改动）
  cpSync(PROBE_SRC, join(plugin, 'scripts', 'contract_probe.mjs'))
  return plugin
}

console.log('── [R11] contract_probe 宿主树回退 ──')

function hasResolvableDep(start, dep) {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'node_modules', dep))) return true
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return false
}
const CANDIDATES = ['/root/.hermes/cache/scratch/pkgtest']
const installedProject = CANDIDATES.find(
  (p) => existsSync(join(p, 'node_modules', 'hermes-dsh-bridge', 'lib', 'index.js')) && hasResolvableDep(p, 'zod'))

try {
  if (!installedProject) {
    console.log('  ! 找不到「已安装且依赖齐全」的项目做素材 —— 跳过（不影响结论）')
    console.log(`══ [R11] 结果: PASS=${pass} FAIL=${fail} ══`)
    process.exit(0)
  }
  console.log(`  （素材: ${installedProject}）`)

  // ═══ A. 服务包在（正常路径）═══
  console.log('── A. 服务包可解析 ──')
  {
    const plugin = makeProject(installedProject, { dropService: false })
    const d = parse(runProbe(plugin, { DSH_HOST_TREE: HOST_TREE }).out)
    ok(d !== undefined, 'A1 探针输出可解析')
    ok(d?.fatal === undefined, `A2 无 fatal（fatal=${d?.fatal ?? 'none'}）`)
    ok(d?.ok === true, 'A3 ok=true')
    const svc = (d?.services ?? []).find((s) => s.id === 'sessionPersistence')
    ok(svc?.ok === true, 'A4 required 服务解析成功')
  }

  // ═══ B. 关键：插件侧没有，只有宿主树有 ═══
  console.log('── B. 仅宿主树有（干净安装的真实形态）──')
  {
    const plugin = makeProject(installedProject, { dropService: true })
    const d = parse(runProbe(plugin, { DSH_HOST_TREE: HOST_TREE }).out)
    ok(d !== undefined, 'B1 探针输出可解析')
    ok(d?.fatal === undefined, `B2 无 fatal（fatal=${d?.fatal ?? 'none'}）`)
    ok(d?.ok === true, 'B3 ok=true（回退到宿主树生效；旧代码在这里红）')
    const svc = (d?.services ?? []).find((s) => s.id === 'sessionPersistence')
    ok(svc?.ok === true, 'B4 required 服务被解析到（不是被无条件放过）')
    ok(typeof svc?.version === 'string' && svc.version.length > 0, 'B5 解析到真实版本号')
    ok(!(d?.summary?.missingRequiredPackages ?? []).includes('sessionPersistence'),
      'B6 不再误报 required 服务缺失')
  }

  // ═══ C. 回退也不可用 → 必须真报错 ═══
  console.log('── C. 回退不可用（宿主树指空）──')
  {
    const plugin = makeProject(installedProject, { dropService: true })
    const emptyHost = join(SANDBOX, 'emptyhost')
    mkdirSync(emptyHost, { recursive: true })
    const r = runProbe(plugin, { DSH_HOST_TREE: emptyHost })
    const d = parse(r.out)
    ok(d?.ok === false, 'C1 ok=false（回退不是「无条件放过」）')
    ok((d?.summary?.missingRequiredPackages ?? []).includes('sessionPersistence'),
      'C2 明确指出缺哪个 required 服务')
    ok(r.code !== 0, 'C3 exit !== 0（CI 可当红灯）')
  }
} finally {
  rmSync(SANDBOX, { recursive: true, force: true })
}

console.log(`══ [R11] 结果: PASS=${pass} FAIL=${fail} ══`)
if (fail > 0) process.exit(1)

#!/usr/bin/env node
/**
 * doctor.mjs — hermes-dsh-bridge 安装自检(零依赖, node 直接跑)。
 *
 * 用法:
 *   node scripts/doctor.mjs                    # 默认检查 127.0.0.1:8090
 *   node scripts/doctor.mjs --port 8091
 *   node scripts/doctor.mjs --url http://127.0.0.1:8090/mcp
 *   node scripts/doctor.mjs --profile headless # 指定要检查的 dsh profile
 *   DSH_MCP_TOKEN=xxx node scripts/doctor.mjs  # authToken 部署
 *
 * 检查项(每项 ✓/✗ + 修复建议, 最后汇总 N 项通过 / M 项失败):
 *   1. Node 版本          >= 22.18(zstd / stripTypeScriptTypes 需要)
 *   2. dsh 可执行 + 版本  >= 0.1.2-rc.1
 *   3. dsh profile 存在    ~/.dsh/profiles/<profile>
 *   4. settings/profile 文件(settings.yaml / profile 的 cordis.patch.yml)
 *   5. 插件被 dsh 识别(dsh --dump-config 输出里 grep 插件名 —— 尽力而为)
 *   6. 依赖树 symlink 状态  (@deepseek-ai/* 是否对齐宿主全局树, 消除 dual-package hazard)
 *   7. 宿主契约探测         (必需符号/服务是否齐备; 复用 contract_probe.mjs)
 *   8. 8090 端口监听
 *   9. MCP 握手 + tools/list(一次真实调用)
 *
 * 只读: 不修改任何文件、不重启任何服务。exit code 0=全部通过, 1=有失败项。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 常量(与 src/index.ts 的运行时默认值保持一致) ──
const MIN_NODE = [22, 18, 0]
const MIN_DSH = [0, 1, 2] // 0.1.2-rc.1 起为 v0.7.0 支持的最低版本
const PLUGIN_NAME = 'hermes-dsh-bridge'
/** 历史包名(插件早期发布名, patch 里可能仍写这个); 命中任一即视为已配置 */
const PLUGIN_ALIASES = ['hermes-dsh-bridge', 'dsh-harness-mcp-server', 'harness-mcp-server']
const DEFAULT_PORT = 8090
const DEFAULT_HOST = '127.0.0.1'
const EXPECTED_TOOLS = 26 // enableFsWrite=false 时为 25; 两者都算通过
const PROTOCOL_VERSION = '2024-11-05'
/** 本脚本所在仓库根(用于定位本地 node_modules 与 contract_probe.mjs) */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 已知的「宿主树无同名包」清单(技术债, 不在本轮范围; 仍为真实目录属预期, 不算失败) */
const KNOWN_LOCAL_ONLY = ['dsh-agent-presets', 'dsh-code-runtime']

// ── 参数解析 ──
function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, host: DEFAULT_HOST, url: undefined, profile: undefined, token: process.env.DSH_MCP_TOKEN || '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--host') out.host = argv[++i]
    else if (a === '--url') out.url = argv[++i]
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--token') out.token = argv[++i]
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
  }
  return out
}

function printHelp() {
  console.log(`hermes-dsh-bridge doctor — 安装自检(零依赖)

用法: node scripts/doctor.mjs [选项]

选项:
  --url <url>        MCP endpoint(默认 http://127.0.0.1:8090/mcp)
  --host <host>      MCP 主机(默认 127.0.0.1)
  --port <port>      MCP 端口(默认 8090)
  --profile <name>   dsh profile 名(默认自动探测 ~/.dsh/profiles/ 下第一个)
  --token <token>    部署设置了 authToken 时传入(或设 DSH_MCP_TOKEN)
  -h, --help         显示本帮助

退出码: 0 = 全部通过; 1 = 存在失败项。`)
}

const args = parseArgs(process.argv.slice(2))
const mcpUrl = args.url ?? `http://${args.host}:${args.port}/mcp`

// ── 结果记录 ──
const results = []
function record(name, ok, detail, fix) {
  results.push({ name, ok, detail: detail ?? '', fix: ok ? undefined : fix })
}
function section(title) {
  console.log(`\n${title}`)
}
function report(r) {
  const mark = r.ok ? '✓' : '✗'
  console.log(`  ${mark} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
  if (!r.ok && r.fix) console.log(`      ↳ 修复: ${r.fix}`)
}

// ── 工具函数 ──
function run(cmd, argv, timeout = 25000) {
  try {
    const stdout = execFileSync(cmd, argv, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, stdout: stdout ?? '', stderr: '' }
  } catch (e) {
    return { ok: false, stdout: String(e?.stdout ?? ''), stderr: String(e?.stderr ?? e?.message ?? e) }
  }
}

/** patch 文本里是否出现插件(含历史包名别名); 返回命中的那一行 */
function findPluginLine(text) {
  for (const line of text.split('\n')) {
    if (PLUGIN_ALIASES.some((a) => line.includes(a))) return line.trim()
  }
  return ''
}

/** 宽松版本比较: 取前三段数字, 忽略 -rc.N 等预发布后缀(预发布视为小于同段正式版但满足 >= 同段 rc 的最低线) */
function versionAtLeast(actual, min) {
  const seg = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  const a = seg(actual), b = min
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return true
}

// ═══════════════ [R2-2] profile 自动探测: 找出「生产真正在跑的那个 profile」 ═══════════════
//
// 历史根因(REQ_r2_20261004 §R2-2): 旧实现 `profileName = names[0]` 取 readdirSync 字母序第一个,
// 本机得到 `acp`, 而生产 systemd 跑的是 `web`(ExecStart=... bin.js web --port 3080)。
// 后果是 `npm run doctor`(不带 --profile)对**根本没装插件**的 acp 报「patch 里没有插件配置段」——
// 一条针对错误对象的**误导性失败**, 掩盖了「生产其实是好的」这一事实。
//
// 探测优先级(高 → 低), 每步都记录来源, 便于报告与排查:
//   ① systemd unit 的 ExecStart 里的 profile 名 —— 唯一权威的「生产在跑什么」;
//      · system 级: /etc/systemd/system/<unit>.service 及 .d/*.conf
//      · user 级:   ~/.config/systemd/user/<unit>.service 及 .d/*.conf
//      · 用 `systemctl show -p ExecStart` 兜底(能覆盖 drop-in / 模板 / 别名单元)
//   ② 有 cordis.patch.yml 且**含本插件配置段**的 profile —— 装了本插件的 profile 显然更相关;
//      多个命中时按 mtime 取最新(最近被编辑的那个最可能是当前在用的)
//   ③ 有 cordis.patch.yml(无论是否含本插件)的 profile —— 至少是个被真正配置过的 profile;
//      多个命中时按 mtime 取最新
//   ④ 兜底 names[0](字母序第一个), 且输出**明确标注「自动探测(可能不是你想要的 profile)」**
const SERVICE_UNIT_HINTS = ['dsh', 'deepseek-harness', 'harness']

/** 从一行 ExecStart 里解析 profile 名(dsh 的 CLI 形态: `bin.js <profile> [--flags...]`) */
export function profileFromExecStartLine(line) {
  const text = String(line).replace(/^ExecStart=\s*/, '').trim()
  if (!text) return undefined
  // 取 `.../bin.js <profile>` 这段; bin.js 可能带引号
  const m = text.match(/bin\.js["']?\s+([^\s"']+)/)
  if (!m) return undefined
  const candidate = m[1]
  if (!candidate) return undefined
  // 排除看起来像 flag 的 token(Profile 名不会是 --xxx 或 -x)
  if (candidate.startsWith('-')) return undefined
  // 排除明显不是 profile 的命令名(dsh 的其它子命令)
  if (['--help', '--version'].includes(candidate)) return undefined
  return candidate
}

/** 收集候选 unit 文件(路径不经 shell, 直接读) */
function unitCandidatePaths(unitName) {
  const paths = []
  for (const hint of SERVICE_UNIT_HINTS) {
    const unit = unitName ?? `${hint}.service`
    paths.push(join('/etc/systemd/system', unit))
    paths.push(join(dshHomeDir(), '.config', 'systemd', 'user', unit))
    for (const base of ['/etc/systemd/system', join(dshHomeDir(), '.config', 'systemd', 'user')]) {
      try {
        const dir = join(base, `${unit}.d`)
        for (const f of readdirSync(dir)) {
          if (f.endsWith('.conf')) paths.push(join(dir, f))
        }
      } catch { /* drop-in 目录不存在 */ }
    }
  }
  return paths
}

function dshHomeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 从 systemd unit 解析生产 profile 名。
 * @returns { profile, source } —— 解析不到时 profile 为 undefined
 */
function detectProfileFromSystemd(explicitUnit) {
  // ①a 直接读 unit 文件(不依赖 systemctl 可用/权限)
  const explicit = process.argv.find((a) => a.startsWith('--unit='))?.slice('--unit='.length)
  const unitName = explicitUnit ?? explicit
  for (const p of unitCandidatePaths(unitName)) {
    if (!existsSync(p)) continue
    let text
    try { text = readFileSync(p, 'utf8') } catch { continue }
    // drop-in 覆盖主 unit: 先扫 drop-in(.d/*.conf), 再看主文件 —— 反向遍历路径即可(路径顺序是先主后 drop-in)
    for (const line of text.split('\n')) {
      if (!line.trim().startsWith('ExecStart=')) continue
      const profile = profileFromExecStartLine(line)
      if (profile) return { profile, source: `systemd unit ${p} 的 ExecStart` }
    }
  }
  // ①b systemctl show 兜底(能覆盖 drop-in 拼接 / 模板单元 / 单元别名)
  for (const hint of SERVICE_UNIT_HINTS) {
    const unit = unitName ?? `${hint}.service`
    const r = run('systemctl', ['show', '-p', 'ExecStart', '--value', unit], 8000)
    if (!r.ok) continue
    // 输出形如: { path=/opt/node22/bin/node ; argv[]=/opt/node22/bin/node .../bin.js web --port 3080 ; ... }
    for (const line of r.stdout.split('\n')) {
      const profile = profileFromExecStartLine(line)
      if (profile) return { profile, source: `systemctl show ${unit} -p ExecStart` }
    }
  }
  return { profile: undefined, source: '' }
}

/**
 * 从 profile 目录里挑「最可能是生产在跑的那个」。
 * @returns { profile, source, candidates }
 */
function detectProfileFromProfilesDir(names, profilesDir) {
  const withPatch = []
  const withPlugin = []
  for (const name of names) {
    const patch = join(profilesDir, name, 'cordis.patch.yml')
    if (!existsSync(patch)) continue
    let mtime = 0
    let hit = ''
    try {
      mtime = statSync(patch).mtimeMs
      hit = findPluginLine(readFileSync(patch, 'utf8'))
    } catch { continue }
    withPatch.push({ name, mtime })
    if (hit) withPlugin.push({ name, mtime })
  }
  const newestOf = (list) => list.slice().sort((a, b) => b.mtime - a.mtime)[0]?.name
  if (withPlugin.length === 1) return { profile: withPlugin[0].name, source: '唯一含本插件配置段的 profile', candidates: withPlugin }
  if (withPlugin.length > 1) {
    const pick = newestOf(withPlugin)
    return { profile: pick, source: `多个 profile 含本插件配置段, 取最近修改的 (${withPlugin.map((c) => c.name).join('/')})`, candidates: withPlugin }
  }
  if (withPatch.length === 1) return { profile: withPatch[0].name, source: '唯一有 cordis.patch.yml 的 profile', candidates: withPatch }
  if (withPatch.length > 1) {
    const pick = newestOf(withPatch)
    return { profile: pick, source: `多个 profile 有 cordis.patch.yml, 取最近修改的 (${withPatch.map((c) => c.name).join('/')})`, candidates: withPatch }
  }
  return { profile: undefined, source: '', candidates: [] }
}

// ── 1. Node 版本 ──
section('环境')
{
  const v = process.version.replace(/^v/, '')
  const ok = versionAtLeast(v, MIN_NODE)
  const minStr = MIN_NODE.join('.')
  record('Node 版本', ok, `v${v} (需要 >= v${minStr})`,
    `升级 Node 到 >= v${minStr}(低于此版本会缺 zstd / stripTypeScriptTypes, dsh 无法启动); 推荐 nvm install 22 或 https://nodejs.org`)
}
report(results[results.length - 1])

// ── 2. dsh 可执行 + 版本 ──
section('dsh')
let dshVersion = ''
{
  const r = run('dsh', ['--version'])
  if (!r.ok) {
    record('dsh 可执行', false, '未找到 dsh 命令', '安装 DeepSeek Harness CLI(npm i -g @deepseek-ai/dsh), 并确认 PATH 里有 dsh; 装完跑 `dsh --version` 验证')
    report(results[results.length - 1])
  } else {
    dshVersion = r.stdout.trim().split(/\s+/).pop() || r.stdout.trim()
    const ok = versionAtLeast(dshVersion, MIN_DSH)
    record('dsh 可执行 + 版本', ok, `dsh ${dshVersion} (本插件需要 >= 0.1.2-rc.1; 已在 0.1.5-rc.2 实测)`,
      `升级 Harness: npm i -g @deepseek-ai/dsh@latest(本插件 v0.7.0 支持 dsh >= 0.1.2-rc.1; v0.5.0 及更早只兼容 <= 0.1.1-rc.2)`)
    report(results[results.length - 1])
  }
}

// ── 3. dsh profile 存在([R2-2] 自动探测 = 生产在跑的那个, 而非字母序第一个) ──
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profilesDir = join(dshHome, 'profiles')
let profileName = args.profile
/** profile 来源说明(用于输出中标注「这是怎么选出来的」); --profile 时为 '命令行 --profile' */
let profileSource = args.profile ? '命令行 --profile' : ''
/** 自动探测是否退到了「字母序第一个」这一兜底(需要显式警示) */
let profileFallbackWarn = false
/** 所有存在的 profile 名 */
let allProfileNames = []
{
  try {
    allProfileNames = readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { /* 目录不存在 */ }

  if (!profileName) {
    // ① systemd ExecStart(权威: 生产真正在跑什么)
    const sysd = detectProfileFromSystemd()
    if (sysd.profile && allProfileNames.includes(sysd.profile)) {
      profileName = sysd.profile
      profileSource = `自动探测 ← ${sysd.source}`
    } else if (sysd.profile && !allProfileNames.includes(sysd.profile)) {
      // 解析出了名字但 profile 目录不存在 → 不当成可用选择, 但要把这个事实说出来
      profileSource = `systemd 报告 profile "${sysd.profile}"(${sysd.source})但 ${join(profilesDir, sysd.profile)} 不存在; 已回退继续探测`
    }
    // ②/③ profile 目录内容(patch 存在 / patch 含本插件; 多命中取 mtime 最新)
    if (!profileName) {
      const byDir = detectProfileFromProfilesDir(allProfileNames, profilesDir)
      if (byDir.profile) {
        profileName = byDir.profile
        const prior = profileSource ? `${profileSource}; 再回退到 ` : '自动探测 ← '
        profileSource = `${prior}${byDir.source}`
      }
    }
    // ④ 兜底: 字母序第一个 —— 必须显式警示(这就是本 bug 的老行为)
    if (!profileName) {
      profileName = allProfileNames[0]
      profileFallbackWarn = true
      profileSource = '自动探测(可能不是你想要的 profile) —— 未找到 systemd unit / 含插件配置段的 profile, 退回字母序第一个'
    }
  }

  const ok = Boolean(profileName) && allProfileNames.includes(profileName)
  const srcLabel = args.profile ? ' (--profile 指定)' : ` (${profileSource})`
  record('dsh profile 存在', ok,
    ok
      ? `${join(profilesDir, profileName)}${srcLabel}`
      : (allProfileNames.length
        ? `未找到 profile "${profileName ?? ''}"; 现有: ${allProfileNames.join(', ')}`
        : `${profilesDir} 不存在或为空`),
    `创建/确认 profile: ls ~/.dsh/profiles/; 用 dsh --profile <name> 启动过一次即会创建, 或用 --profile <name> 指定要检查的 profile`)
  report(results[results.length - 1])
  if (profileFallbackWarn) {
    console.log(`      ⚠️  自动探测已退到兜底策略(${profileSource})`)
    console.log(`         现有 profile: ${allProfileNames.join(', ') || '(无)'}`)
    console.log(`         若生产用 systemd 托管, 请确认 unit 的 ExecStart 里 profile 名拼写, 或用 --profile <name> 显式指定`)
  }
}

// ── 4. settings / profile 配置文件 ──
{
  const settingsYaml = join(dshHome, 'settings.yaml')
  const settingsJson = join(dshHome, 'settings.json')
  const hasSettings = existsSync(settingsYaml) || existsSync(settingsJson)
  record('dsh settings 文件', hasSettings,
    hasSettings ? (existsSync(settingsYaml) ? settingsYaml : settingsJson) : `未找到 ${settingsYaml} 或 settings.json`,
    '启动一次 dsh 会自动生成 settings.yaml; 若确实缺失, 跑 `dsh --profile <name> --help` 或直接 `dsh --profile <name>` 触发初始化')
  report(results[results.length - 1])
}
{
  const patchPath = profileName ? join(profilesDir, profileName, 'cordis.patch.yml') : ''
  const exists = Boolean(patchPath) && existsSync(patchPath)
  let hit = ''
  if (exists) {
    try { hit = findPluginLine(readFileSync(patchPath, 'utf8')) } catch { /* 读失败按未配置 */ }
  }
  const ok = exists && Boolean(hit)
  // [R2-2] 不带 --profile 时, 若探测到的 profile 只是「可能不是你想要的」那个(兜底/按目录猜),
  // 就**不得**因它没配插件而报失败 —— 那是针对错误对象的误导性失败, 会掩盖「生产其实是好的」。
  // 降级为「提示」: 不计数、不影响退出码, 只如实说明现状与如何确认。
  const auto = !args.profile
  const soft = auto && !ok && profileFallbackWarn
  const detail = !exists
    ? `未找到 ${patchPath || 'profile 的 cordis.patch.yml'}`
    : hit ? `${patchPath} → ${hit}` : `${patchPath} 里没有插件配置段(别名: ${PLUGIN_ALIASES.join(', ')})`
  if (soft) {
    record('profile patch 已配置插件', true, `${detail} — ⚠️ 非失败项(见上方自动探测警示)`)
    console.log(`  · profile patch 已配置插件 — ${detail}`)
    console.log(`      ⚠️  该 profile 是**自动探测兜底**选出来的, 它没配插件不代表生产没配; 请用 --profile <生产 profile> 复核`)
    console.log(`         现有 profile: ${allProfileNames.join(', ')}`)
  } else {
    record('profile patch 已配置插件', ok, detail,
      exists
        ? `在 ${patchPath} 末尾追加 ——\n        - insert:\n            - id: hermes-dsh-bridge\n              name: '${PLUGIN_NAME}'\n              config:\n                http: true\n                port: ${args.port}\n                provider: <your-provider-id>\n                model: <your-model-id>\n        (provider/model 必须是你的 Harness 里已配置好的, 否则 agent 组装会崩)`
        : `确认 profile 名(当前 "${profileName ?? '?'}"); 用 --profile <name> 指定, 然后在该 profile 的 cordis.patch.yml 里追加配置段`)
    report(results[results.length - 1])
  }
}

// ── 5. 插件是否被 dsh 识别(dsh --dump-config; 尽力而为) ──
{
  const r = run('dsh', ['--profile', profileName ?? 'default', '--dump-config'], 30000)
  if (!r.ok) {
    // dump-config 会先重写 profile 的 cordis.yml; EACCES/EROFS 是权限问题而非插件问题
    const perm = /EACCES|EPERM|EROFS/.test(r.stderr)
    const firstLine = (r.stderr.split('\n').find((l) => l.trim() && !l.startsWith('    at ')) || 'unknown error').trim()
    // [R2-2] 与 patch 检查同款: 兜底探测选出的 profile 上失败 → 降级为提示, 不算失败项
    if (!args.profile && profileFallbackWarn) {
      console.log(`  · dsh --dump-config 可运行 — ${firstLine.slice(0, 160)}${perm ? ' (profile 目录不可写)' : ''} — ⚠️ 非失败项(自动探测兜底的 profile)`)
    } else {
      record('dsh --dump-config 可运行', false,
        `${firstLine.slice(0, 160)}${perm ? ' (profile 目录不可写)' : ''}`,
        perm
          ? `dump-config 需要写 ${join(profilesDir, profileName ?? '<profile>', 'cordis.yml')}; 用对该目录有写权限的用户跑, 或直接看下面「MCP 握手」的运行态结论(运行态通过即插件已装载)`
          : `手动跑一次 \`dsh --profile ${profileName ?? '<profile>'} --dump-config\` 看完整报错; 该检查只用于静态确认, 运行态以「MCP 握手」为准`)
      report(results[results.length - 1])
    }
  } else if (!findPluginLine(r.stdout)) {
    if (!args.profile && profileFallbackWarn) {
      console.log('  · dsh 已装载插件(dump-config) — dump-config 输出里没有插件配置段 — ⚠️ 非失败项(自动探测兜底的 profile)')
    } else {
      record('dsh 已装载插件(dump-config)', false, `dump-config 输出里没有插件配置段(别名: ${PLUGIN_ALIASES.join(', ')})`,
        `确认插件已装进 profile 的 node_modules 且 patch 里 name 拼写正确: cd ~/.dsh/profiles/${profileName}/node_modules && npm install ${PLUGIN_NAME}`)
      report(results[results.length - 1])
    }
  } else {
    record('dsh 已装载插件(dump-config)', true, `dump-config 输出里找到 "${findPluginLine(r.stdout)}"`)
    report(results[results.length - 1])
  }
}

// ── 6. 依赖树 symlink 状态(dual-package hazard; DISCUSS_20261003 §2.3 A2) ──
section('依赖树')
{
  const scopeDir = join(REPO_ROOT, 'node_modules', '@deepseek-ai')
  let entries = []
  try {
    entries = readdirSync(scopeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
  } catch { /* 目录不存在 → entries 为空, 下面按失败处理 */ }

  if (entries.length === 0) {
    record('依赖树 symlink 状态', false, `未找到 ${scopeDir}`,
      `先在本插件目录跑 npm install; 然后 node scripts/link-host-deps.mjs 把 @deepseek-ai/* 对齐宿主全局树(消除 dual-package hazard)`)
    report(results[results.length - 1])
  } else {
    const symlinks = []
    const realDirs = []
    const broken = []
    for (const name of entries) {
      const p = join(scopeDir, name)
      let st
      try { st = lstatSync(p) } catch { continue }
      if (st.isSymbolicLink()) {
        // 断链判定: realpath 解析失败 = 目标不存在(典型场景: 宿主升级后包名漂移)
        try {
          realpathSync(p)
          symlinks.push(name)
        } catch {
          broken.push(name)
        }
      } else if (st.isDirectory()) {
        realDirs.push(name)
      }
    }
    // 真实目录里, 减去已知的「宿主树没有同名包」孤儿 → 剩下的才是需要修的漂移
    const unexpectedReal = realDirs.filter((n) => !KNOWN_LOCAL_ONLY.includes(n))
    const ok = broken.length === 0 && unexpectedReal.length === 0
    const parts = [
      `symlink ${symlinks.length}`,
      `本地副本 ${realDirs.length}${realDirs.length ? ` (${realDirs.join(', ')})` : ''}`,
    ]
    if (broken.length) parts.push(`断链 ${broken.length} (${broken.join(', ')})`)
    if (unexpectedReal.length) parts.push(`待对齐 ${unexpectedReal.length} (${unexpectedReal.join(', ')})`)
    record('依赖树 symlink 状态', ok, parts.join(' | '),
      `跑 node scripts/link-host-deps.mjs 把仍是真实目录的包替换成指向宿主全局树的 symlink` +
      (broken.length ? `; 断链项说明宿主树里没这个包(可能包名已漂移), 需人工确认目标` : '') +
      (realDirs.length ? `; 注: ${KNOWN_LOCAL_ONLY.join(' / ')} 属已知技术债(宿主树无同名包), 保持本地副本不算失败` : ''))
    report(results[results.length - 1])
  }
}

// ── 7. 宿主契约探测(必需符号/服务; DISCUSS_20261003 §3.1 第 8 项) ──
{
  const probeScript = join(REPO_ROOT, 'scripts', 'contract_probe.mjs')
  if (!existsSync(probeScript)) {
    record('宿主契约探测', false, `未找到 ${probeScript}`, '确认仓库完整(该脚本是 P0 交付物); 或重新拉取仓库')
    report(results[results.length - 1])
  } else {
    const r = run(process.execPath, [probeScript], 30000)
    // 探针把 JSON 写 stdout; 退出码 1 = 必需项缺失(也可能是脚本自身失败, 看 fatal 字段)
    let parsed = null
    try { parsed = JSON.parse(r.stdout) } catch { /* 非 JSON 输出 */ }
    if (!parsed) {
      const firstLine = (String(r.stderr || r.stdout).split('\n').find((l) => l.trim()) || 'unknown error').trim()
      record('宿主契约探测', false, `contract_probe.mjs 未输出合法 JSON: ${firstLine.slice(0, 160)}`,
        `先跑 node scripts/contract_probe.mjs 看完整输出; 若报 lib/index.js 缺失则先 npm run build(探针从构建产物读契约清单)`)
      report(results[results.length - 1])
    } else if (parsed.fatal) {
      record('宿主契约探测', false, `探针自身失败: ${String(parsed.fatal).slice(0, 160)}`,
        `先跑 npm run build 重建 lib/index.js(探针需要 __internals.HOST_CONTRACT); 再重跑 node scripts/contract_probe.mjs`)
      report(results[results.length - 1])
    } else {
      const summary = parsed.summary ?? {}
      const missSym = summary.missingRequiredSymbols ?? []
      const missSvc = summary.missingRequiredPackages ?? []
      const ok = parsed.ok === true
      const detail = ok
        ? `必需符号 ${summary.requiredSymbols ?? 0}/${summary.requiredSymbols ?? 0} + 必需服务 ${summary.requiredServices ?? 0}/${summary.requiredServices ?? 0} 全部就绪(可选项 ${summary.optionalServices ?? 0} 项)`
        : `缺失符号: ${missSym.join(', ') || '无'}; 缺失服务: ${missSvc.join(', ') || '无'}`
      record('宿主契约探测', ok, detail,
        `宿主契约变更可能导致静默失效(历史: 0.1.5 sessionPersistence / 0.1.7 MessageSourceMap)。` +
        `先 node scripts/contract_probe.mjs 看逐项结果; 契约清单见 src/contract.ts; ` +
        `若确认是新版宿主改了 API, 需按新契约适配后再升级`)
      report(results[results.length - 1])
    }
  }
}

// ── 8. 端口监听(dsh 未在跑时降级为 TCP 探测) ──
section('运行时')
let portListening = false
{
  const r = run('ss', ['-ltn'])
  if (r.ok) {
    portListening = r.stdout.split('\n').some((l) => new RegExp(`[:.]${args.port}\\b`).test(l))
    record(`${args.port} 端口监听`, portListening,
      portListening ? `${args.host}:${args.port} 已监听` : `没有进程监听 ${args.port}`,
      `启动 Harness: systemctl restart dsh.service(或你管理 Harness 的方式); 启动后 `+
      `\`ss -ltn | grep ${args.port}\` 应能看到监听; 端口被占用可改 patch 里的 port`)
  } else {
    // ss 缺失: 用 fetch 探测代替(下一步的 MCP 握手会给出最终结论)
    portListening = true
    record(`${args.port} 端口监听`, true, `ss 不可用, 跳过(下一步 MCP 握手会实际验证)`)
  }
  report(results[results.length - 1])
}

// ── 9. MCP 握手 + tools/list ──
let toolNames = []
{
  let sid = ''
  const callRpc = async (method, params, notify = false) => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (sid) headers['Mcp-Session-Id'] = sid
    if (args.token) headers['Authorization'] = `Bearer ${args.token}`
    const body = { jsonrpc: '2.0', method, params }
    if (!notify) body.id = String(Math.floor(Math.random() * 1e9))
    const res = await fetch(mcpUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
    const s = res.headers.get('mcp-session-id')
    if (s) sid = s
    const text = await res.text()
    if (notify) return { status: res.status, parsed: null }
    let parsed = null
    for (const line of text.split('\n')) if (line.startsWith('data: ')) { try { parsed = JSON.parse(line.slice(6)) } catch { /* 跳过非 JSON 行 */ } }
    if (!parsed) { try { parsed = JSON.parse(text) } catch { /* 非 JSON 响应 */ } }
    return { status: res.status, parsed }
  }
  try {
    const init = await callRpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'hermes-dsh-bridge-doctor', version: '1.0' },
    })
    const serverName = init.parsed?.result?.serverInfo?.name
    const serverVer = init.parsed?.result?.serverInfo?.version
    if (!init.parsed?.result) {
      record('MCP 握手', false, `initialize 未返回 result (HTTP ${init.status})${init.status === 401 ? ' — 未认证' : ''}`,
        init.status === 401 ? '该部署配置了 authToken: 用 `--token <token>` 或 DSH_MCP_TOKEN=<token> 重跑' : `确认 ${mcpUrl} 是 MCP endpoint; 看 Harness 日志里有没有 [harness-mcp-server] 报错`)
      report(results[results.length - 1])
    } else {
      record('MCP 握手', true, `serverInfo.name=${serverName ?? '?'} version=${serverVer ?? '?'}`)
      report(results[results.length - 1])
      await callRpc('notifications/initialized', {}, true).catch(() => { /* 通知失败不影响后续 */ })
      const list = await callRpc('tools/list', {})
      const tools = list.parsed?.result?.tools ?? []
      toolNames = tools.map((t) => t.name)
      const ok = tools.length >= 25
      const spot = ['agent_run', 'session_stats', 'preset_set', 'fs_read', 'approval_respond'].filter((n) => toolNames.includes(n))
      record('tools/list 工具可用', ok,
        ok ? `${tools.length} 个工具(期望 25~${EXPECTED_TOOLS}; 含 ${spot.join(', ')})` : `只列出 ${tools.length} 个工具`,
        ok ? undefined : `期望 >= 25 个: 确认插件版本与 dsh 版本匹配(本插件 v0.7.0 + dsh >= 0.1.2-rc.1), 并查看 Harness 启动日志`)
      report(results[results.length - 1])
    }
  } catch (e) {
    record('MCP 握手', false, `连接 ${mcpUrl} 失败: ${(e?.message ?? String(e)).slice(0, 160)}`,
      `服务可能没起来: 确认 patch 里有 http: true 且 port: ${args.port}, 然后重启 Harness 并看日志里有没有 "[harness-mcp-server] MCP server listening on ${args.host}:${args.port}"`)
    report(results[results.length - 1])
  }
}

// ── 汇总 ──
const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok)
console.log('\n' + '─'.repeat(60))
console.log(`结果: ${passed} 项通过, ${failed.length} 项失败`)
if (failed.length > 0) {
  console.log('\n失败项一览:')
  for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`)
}
if (toolNames.length > 0) {
  console.log(`\n工具清单(${toolNames.length}): ${toolNames.join(', ')}`)
}
if (failed.length === 0) console.log('\n全部通过 —— 可以用 examples/hermes_dsh_mcp.py list 验证端到端连通。')
else console.log('\n按上面每项的 ↳ 修复建议处理后重跑本脚本。')
process.exit(failed.length === 0 ? 0 : 1)

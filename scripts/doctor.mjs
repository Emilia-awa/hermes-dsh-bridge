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
 *   6. 8090 端口监听
 *   7. MCP 握手 + tools/list(一次真实调用)
 *
 * 只读: 不修改任何文件、不重启任何服务。退出码 0=全部通过, 1=有失败项。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

// ── 3. dsh profile 存在 ──
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profilesDir = join(dshHome, 'profiles')
let profileName = args.profile
{
  let names = []
  try {
    names = readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { /* 目录不存在 */ }
  if (!profileName) profileName = names[0]
  const ok = Boolean(profileName) && names.includes(profileName)
  record('dsh profile 存在', ok,
    ok ? `${join(profilesDir, profileName)}${args.profile ? ' (--profile 指定)' : ' (自动探测)'}` : (names.length ? `未找到 profile "${profileName ?? ''}"; 现有: ${names.join(', ')}` : `${profilesDir} 不存在或为空`),
    `创建/确认 profile: ls ~/.dsh/profiles/; 用 dsh --profile <name> 启动过一次即会创建, 或用 --profile <name> 指定要检查的 profile`)
  report(results[results.length - 1])
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
  const detail = !exists
    ? `未找到 ${patchPath || 'profile 的 cordis.patch.yml'}`
    : hit ? `${patchPath} → ${hit}` : `${patchPath} 里没有插件配置段(别名: ${PLUGIN_ALIASES.join(', ')})`
  record('profile patch 已配置插件', ok, detail,
    exists
      ? `在 ${patchPath} 末尾追加 ——\n        - insert:\n            - id: hermes-dsh-bridge\n              name: '${PLUGIN_NAME}'\n              config:\n                http: true\n                port: ${args.port}\n                provider: <your-provider-id>\n                model: <your-model-id>\n        (provider/model 必须是你的 Harness 里已配置好的, 否则 agent 组装会崩)`
      : `确认 profile 名(当前 "${profileName ?? '?'}"); 用 --profile <name> 指定, 然后在该 profile 的 cordis.patch.yml 里追加配置段`)
  report(results[results.length - 1])
}

// ── 5. 插件是否被 dsh 识别(dsh --dump-config; 尽力而为) ──
{
  const r = run('dsh', ['--profile', profileName ?? 'default', '--dump-config'], 30000)
  if (!r.ok) {
    // dump-config 会先重写 profile 的 cordis.yml; EACCES/EROFS 是权限问题而非插件问题
    const perm = /EACCES|EPERM|EROFS/.test(r.stderr)
    const firstLine = (r.stderr.split('\n').find((l) => l.trim() && !l.startsWith('    at ')) || 'unknown error').trim()
    record('dsh --dump-config 可运行', false,
      `${firstLine.slice(0, 160)}${perm ? ' (profile 目录不可写)' : ''}`,
      perm
        ? `dump-config 需要写 ${join(profilesDir, profileName ?? '<profile>', 'cordis.yml')}; 用对该目录有写权限的用户跑, 或直接看下面「MCP 握手」的运行态结论(运行态通过即插件已装载)`
        : `手动跑一次 \`dsh --profile ${profileName ?? '<profile>'} --dump-config\` 看完整报错; 该检查只用于静态确认, 运行态以「MCP 握手」为准`)
  } else if (!findPluginLine(r.stdout)) {
    record('dsh 已装载插件(dump-config)', false, `dump-config 输出里没有插件配置段(别名: ${PLUGIN_ALIASES.join(', ')})`,
      `确认插件已装进 profile 的 node_modules 且 patch 里 name 拼写正确: cd ~/.dsh/profiles/${profileName}/node_modules && npm install ${PLUGIN_NAME}`)
  } else {
    record('dsh 已装载插件(dump-config)', true, `dump-config 输出里找到 "${findPluginLine(r.stdout)}"`)
  }
  report(results[results.length - 1])
}

// ── 6. 端口监听(dsh 未在跑时降级为 TCP 探测) ──
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

// ── 7. MCP 握手 + tools/list ──
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

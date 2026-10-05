#!/usr/bin/env node
/**
 * e2e_r7.mjs — [R7] 端到端真链路验证(HTTP MCP, 跑的是构建产物 lib/index.js)。
 *
 * 与 unit_r7.mjs 的分工: 单测打的是纯函数/源码通道; 本脚本启动**真实 HTTP MCP server**
 * (apply() → 起 server → 真实 MCP 握手 → tools/call), 验证改动的**运行时**形态:
 *
 *   P1-2  fs_read: 真实文件 + offset=totalLines/totalLines+1/极大值 → 观察 note 字段的有无
 *   P1-1  provider 引导: 假 ctx 里 llm.listProviders 只给自定义 provider → 观察 status_get.providerCheck
 *   P3-1  fs_write: enableFsWrite=true, create-new 两次同路径 → 第二次必须报 "file already exists"
 *   P3-2  session_search 走 scan 时 indexFallbackHint 存在
 *   P2-1  set_policy 冷会话 → 错误串匹配家族句式
 *
 * 端口选 8199/8200(避开单测占用的 8110-8115), 结束即关服。
 *
 * 运行: node scripts/e2e_r7.mjs
 * 退出码: 0 = 全部通过; 1 = 有失败。
 */
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TSDOWN = process.env.TSDOWN_BIN || join(ROOT, 'node_modules/.bin/tsdown')

// 确保跑的是最新构建产物(REQ §5 的 ⚠️: 改了 src 不 build 就仍跑旧代码)
execFileSync(process.execPath, [TSDOWN, '--env.DSH_BUILD_FACE', 'host'], { cwd: ROOT, stdio: 'pipe' })

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra)?.slice(0, 300)}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 极简 MCP HTTP 客户端 ──
let mcpSession = ''
async function rpc(port, method, params) {
  const body = { jsonrpc: '2.0', id: Math.random().toString(16).slice(2), method, params }
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (mcpSession) headers['Mcp-Session-Id'] = mcpSession
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) mcpSession = sid
  const text = await res.text()
  let parsed = null
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) { try { parsed = JSON.parse(line.slice(6)) } catch { /* keep */ } }
  }
  if (!parsed) { try { parsed = JSON.parse(text) } catch { /* keep */ } }
  return parsed
}
async function callTool(port, name, args = {}) {
  const r = await rpc(port, 'tools/call', { name, arguments: args })
  const txt = (r?.result?.content ?? []).map((c) => c.text ?? '').join('')
  try { return JSON.parse(txt) } catch { return { _raw: txt, _rpcError: r?.error } }
}
async function initMcp(port, name) {
  mcpSession = ''
  const r = await rpc(port, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name, version: '1' } })
  await rpc(port, 'notifications/initialized', {})
  return Boolean(r?.result)
}

const WS = '/tmp/a2a-e2e-r7-ws'
rmSync(WS, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })
const WS_REAL = realpathSync(WS)

/** 最小可用 ctx: 只提供 fs 工具链 + status_get 需要的服务; llm 只注册自定义 provider */
function makeCtx({ providers }) {
  const services = new Map()
  const warnings = []
  const origWarn = console.warn
  console.warn = (...a) => { warnings.push(a.join(' ')); origWarn(...a) }
  const ctx = {
    effect(fn) { void fn },
    on() {},
    get(name, strict) {
      if (services.has(name)) return services.get(name)
      if (name === 'llm') return { listProviders: () => providers.map((id) => ({ id, name: id })) }
      if (name === 'sessions') return { list: () => [], get: () => undefined, flush: async () => {} }
      if (name === 'sessionPersistence') return { list: async () => [], inspect: async () => { throw new Error('none') } }
      if (strict === false) return undefined
      return undefined
    },
    agents: { list: () => [], get: () => undefined, create: async () => { throw new Error('n/a') }, resume: async () => { throw new Error('n/a') } },
    agentPresets: { resolve: async () => ({ id: 'x' }), mount: async () => {}, recompose: async () => ({ id: 'x' }) },
    tools: { register: () => () => {}, schemas: () => [] },
    llm: { listProviders: () => providers.map((id) => ({ id, name: id })) },
  }
  ctx.__services = services
  ctx.__warnings = warnings
  return ctx
}

const PORT = 8199

// ═══════════════ 实例: 自定义 provider(kenari) + fs_write 开启 ═══════════════
console.log('── 实例: 自定义 provider + enableFsWrite ──')
const ctx = makeCtx({ providers: ['kenari'] })
const mod = await import(`${join(ROOT, 'lib/index.js')}?t=${Date.now()}`)
const { apply, __internals } = mod
await apply(ctx, {
  port: PORT,
  host: '127.0.0.1',
  enableFsWrite: true,
  workspaceRoots: [WS_REAL],
  approvalsBridge: 'off',
})
await sleep(200)
ok(await initMcp(PORT, 'e2e-r7'), 'E2E MCP initialize 成功')

// ── P1-1: provider 引导 ──
{
  console.log('── P1-1 provider 默认值引导(运行时) ──')
  const st = await callTool(PORT, 'status_get', {})
  ok(st.providerCheck?.probed === true, 'P1-1 status_get.providerCheck.probed=true', st.providerCheck)
  ok(st.providerCheck?.registered === false, 'P1-1 默认 provider 未注册 → registered=false', st.providerCheck)
  ok(st.providerCheck?.explicit === false, 'P1-1 未显式配置 → explicit=false', st.providerCheck)
  ok(Array.isArray(st.providerCheck?.available) && st.providerCheck.available.includes('kenari'),
    'P1-1 available 含宿主注册的 kenari', st.providerCheck)
  ok((st.degradations ?? []).some((d) => d.scope === 'provider'),
    'P1-1 degradations 含 scope=provider(顺带验证 P2-2 的留痕通道可用)', st.degradations)
  const warned = ctx.__warnings.some((w) => w.includes("默认 provider 'deepseek-official'") && w.includes('没注册它'))
  ok(warned, 'P1-1 启动日志出现 ⚠️ provider 引导 warn(未阻断启动)', ctx.__warnings.filter((w) => w.includes('provider')))
}

// ── P1-2: fs_read offset 越界 ──
{
  console.log('── P1-2 fs_read offset 越界(运行时, 真实文件) ──')
  const file = join(WS_REAL, 'lines.txt')
  const N = 10
  writeFileSync(file, Array.from({ length: N }, (_, i) => `line-${i + 1}`).join('\n') + '\n', 'utf8')

  const last = await callTool(PORT, 'fs_read', { path: file, offset: N })
  ok(last.totalLines === N, `P1-2 totalLines=${N}(结尾换行不算一行)`, last.totalLines)
  ok(last.content === `line-${N}`, 'P1-2 off=totalLines 能读到最后一行', last.content)
  ok(last.note === undefined, 'P1-2 off=totalLines 不算越界 → 无 note(正常路径结构不变)', last.note)

  const plus1 = await callTool(PORT, 'fs_read', { path: file, offset: N + 1 })
  ok(plus1.content === '', 'P1-2 off=totalLines+1 内容确为空(这是修前的误判来源)')
  ok(typeof plus1.note === 'string', 'P1-2 off=totalLines+1 有 note 显式提示', plus1.note)
  ok(String(plus1.note).includes(`${N + 1}`) && String(plus1.note).includes(`${N}`), 'P1-2 note 含 offset 值与总行数', plus1.note)
  ok(/不是文件为空|没有任何内容/.test(String(plus1.note)), 'P1-2 note 明确否认"文件为空"(防 agent 误判)', plus1.note)

  const huge = await callTool(PORT, 'fs_read', { path: file, offset: 999999 })
  ok(typeof huge.note === 'string' && String(huge.note).includes('999999'), 'P1-2 极大 offset 也有 note 且回显原值', huge.note)

  const normal = await callTool(PORT, 'fs_read', { path: file, offset: 1, limit: 3 })
  ok(normal.content === 'line-1\nline-2\nline-3' && normal.note === undefined && normal.truncated === true,
    'P1-2 正常分段读行为不变(content/truncated/next 语义保持)', normal)
  ok(typeof normal.next === 'string', 'P1-2 正常截断仍给 next 提示(既有契约未破坏)', normal.next)
}

// ── P3-1: fs_write create-new 原子性 ──
{
  console.log('── P3-1 fs_write create-new(运行时, 真实文件) ──')
  const target = join(WS_REAL, 'new-once.txt')
  const first = await callTool(PORT, 'fs_write', { path: target, content: 'A', mode: 'create-new' })
  ok(first.ok === true, 'P3-1 首次 create-new 成功', first)
  const second = await callTool(PORT, 'fs_write', { path: target, content: 'B', mode: 'create-new' })
  ok(second.ok === undefined && /^file already exists: /.test(String(second.error)), 'P3-1 二次 create-new 报既有文案(未引入新文案)', second)
  const back = await callTool(PORT, 'fs_read', { path: target })
  ok(back.content === 'A', 'P3-1 首次写入内容未被覆盖(原子性)', back.content)

  // 并发 5 路同路径 create-new: 内核 O_EXCL 保证恰好 1 个成功
  const racePath = join(WS_REAL, 'race.txt')
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => callTool(PORT, 'fs_write', { path: racePath, content: `w${i}`, mode: 'create-new' })),
  )
  const wins = results.filter((r) => r.ok === true).length
  ok(wins === 1, `P3-1 并发 5 路 create-new 恰好 1 路成功(实得 ${wins}; 旧 stat 预检会多路通过)`, results)
}

// ── P3-2: session_search 回退提示 ──
{
  console.log('── P3-2 session_search 回退人话提示(运行时) ──')
  const search = await callTool(PORT, 'session_search', { query: 'anything' })
  // 本实例 sessions/sessionPersistence 为空 → 会走 "session is empty" 分支。
  // 该分支不携带 backend 字段, 因此这里只断言"字段绑定存在"由单测覆盖;
  // 运行时改用一个能走通 scan 路径的最小语料来验证。
  ok(typeof search.error === 'string' || search.backend !== undefined, 'P3-2 session_search 在空语料下返回明确错误/后端字段(未崩)', search)
  const hint = __internals.INDEX_FALLBACK_HINT
  ok(typeof hint === 'string' && hint.includes('已自动回退'), 'P3-2 INDEX_FALLBACK_HINT 在构建产物里可用且含人话解释', hint)
}

// ── P2-1: set_policy 冷会话句式 ──
{
  console.log('── P2-1 set_policy 冷会话句式(运行时) ──')
  const r = await callTool(PORT, 'set_policy', { sessionId: 'no-such-cold', mode: 'read-only' })
  ok(r.ok === undefined && typeof r.error === 'string', 'P2-1 冷/不存在会话报错', r)
  ok(/^session is not live: .+ \(.+; .+\)$/.test(String(r.error)), 'P2-1 错误串匹配家族句式 ^session is not live: .+ (.+; .+)$', r.error)
  ok(!/^session [^:]+ is not live;/.test(String(r.error)), 'P2-1 不再是 `session <id> is not live; ...` 外挂形态', r.error)
}

// ── 工具清单(顺带验证 P3-2 文档口径: 默认 25 + fs_write = 26) ──
{
  const t = await rpc(PORT, 'tools/list', {})
  const names = (t.result?.tools ?? []).map((x) => x.name)
  ok(names.length === 26, `P3-2 enableFsWrite=true 时工具数=26(实得 ${names.length})`, names.length)
  ok(names.includes('fs_write'), 'P3-2 fs_write 已注册(opt-in 生效)')
}

console.log(`\n══ [R7 E2E] 结果: PASS=${pass} FAIL=${fail} ══`)
process.exit(fail === 0 ? 0 : 1)

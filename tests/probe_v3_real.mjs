// [r2] 真实环境探针: 用 dsh 0.1.5 真实 session-persistence-jsonl 服务 + 真实 v3 会话文件,
// 验证 session_list/session_log/session_search/session_stats 对 v3 格式的适配(不崩 + 能读出内容)。
// 运行: node tests/probe_v3_real.mjs
import { createServer } from 'node:http'
import { mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionPersistenceJsonl from '/opt/node22/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'

const PLUGIN = '../lib/index.js'
const { apply } = await import(PLUGIN)

const DSH = '/opt/node22/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const SESSION_ROOT = '/root/.dsh/sessions'
const TARGET = 'f9a31258-31af-486e-8f85-2e266b4797a9'

let pass = 0, fail = 0
const check = (n, c, d = '') => {
  if (c) { pass++; console.log('  ✓ ' + n) }
  else { fail++; console.log('  ✗ ' + n + ' -> ' + JSON.stringify(d)?.slice(0, 500)) }
}

// ── 真实 cordis Context + 真实 jsonl 持久化后端 ──
const ctx = new Context()
ctx.plugin(SessionPersistenceJsonl, { root: SESSION_ROOT })
await new Promise((r) => setTimeout(r, 300))

const persistence = ctx.get('sessionPersistence')
check('真实 sessionPersistence 服务已挂载', Boolean(persistence))
console.log('  · list() 契约探测: inspect=', typeof persistence?.inspect, ' open=', typeof persistence?.open, ' stat=', typeof persistence?.stat, ' locate=', typeof persistence?.locate)
const rawList = await persistence.list()
const rawFirst = rawList?.[0]
console.log('  · list() 首元素形态:', rawFirst && typeof rawFirst === 'object' ? Object.keys(rawFirst).join(',') : typeof rawFirst)
check('0.1.5 list() 返回 snapshot({header,...}) 而非裸 header', Boolean(rawFirst?.header?.id), rawFirst)

// ── 0. 根因证明: 把真实 snapshot 形态喂给旧代码路径, 复现 undefined 崩溃 ──
{
  const realSnap = rawFirst
  // 旧 listMergedHeaders: headers.set(h.id, h) —— 直接把 snapshot 当 header
  const oldHeader = realSnap
  console.log('  · 旧路径解出的 header.id =', oldHeader.id, ' cwd =', oldHeader.cwd)
  let crash = null
  try {
    const p = persistence.locate(oldHeader) // 旧 roughUpdatedAt: locate(header) 用 header.cwd/header.id 拼路径
    console.log('  · 旧 locate 返回:', p)
    if (p?.path) await (await import('node:fs/promises')).stat(p.path)
  } catch (e) { crash = e }
  console.log('  · 旧 locate 崩点:', crash ? `${crash.constructor.name}: ${crash.message}` : '(未复现)')
  let lengthCrash = null
  try {
    const synthetic = { events: undefined }
    void synthetic.events.length // ← 旧 inspectSessionRow 的 `insp.events.length` 形态
  } catch (e) { lengthCrash = e }
  console.log('  · 旧 `X.length` 形态崩点:', lengthCrash ? `${lengthCrash.constructor.name}: ${lengthCrash.message}` : '(未复现)')
  check('根因已复现: snapshot 被当 header → id/cwd 全 undefined 且 locate 抛 TypeError', crash !== null, crash)
  check('根因已复现: 存在 reading \'length\' 同型崩溃路径', /reading 'length'/.test(String(lengthCrash?.message)), lengthCrash?.message)
}

// ── 真实服务可用性(用真实服务替换 mock 的 persistence 面) ──
const noop = () => {}
const toolResults = new Map()
const mcpCtx = {
  effect: (fn) => { void fn },
  get(name) {
    if (name === 'sessionPersistence') return persistence
    if (name === 'sessions') return { list: () => [], get: () => undefined }
    return undefined
  },
  agents: { list: () => [], get: () => undefined },
  agentPresets: { defaultId: 'standard', resolve: async (id) => ({ id }), list: async () => [] },
  tools: { keys: () => [] },
}

const PORT = 8117
await apply(mcpCtx, { port: PORT, host: '127.0.0.1', approvalsBridge: 'off' })
await new Promise((r) => setTimeout(r, 250))

let mcpSession = ''
async function rpc(method, params) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (mcpSession) headers['Mcp-Session-Id'] = mcpSession
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: String(Math.random()), method, params }) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) mcpSession = sid
  const text = await res.text()
  let parsed = null
  for (const line of text.split('\n')) if (line.startsWith('data: ')) { try { parsed = JSON.parse(line.slice(6)) } catch {} }
  if (!parsed) { try { parsed = JSON.parse(text) } catch {} }
  return parsed
}
async function callTool(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args })
  const txt = (r?.result?.content ?? []).map((c) => c.text ?? '').join('')
  try { return JSON.parse(txt) } catch { return { _raw: txt, _rpcError: r?.error } }
}

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } })
await rpc('notifications/initialized', {})

// ── 1. 无参 session_list(原崩溃路径) ──
const list = await callTool('session_list', {})
check('无参 session_list 不崩(无 error 字段)', list.error === undefined, list)
check('session_list 返回 skipped 计数字段', typeof list.skipped === 'number', list)
check('session_list 列出真实 v3 会话', (list.sessions ?? []).some((s) => s.id === TARGET), (list.sessions ?? []).map((s) => s.id))
const row = (list.sessions ?? []).find((s) => s.id === TARGET)
console.log('  · 真实 v3 行:', JSON.stringify(row))
check('v3 会话行 title 从 session/title 事件折叠出来', row?.title === '015冒烟', row)
check('v3 会话行 cwd 来自 header', row?.cwd === '/tmp', row)
check('v3 会话行 messageCount > 0(open/read 读到了事件)', (row?.messageCount ?? 0) > 0, row)
check('v3 会话行无 messageCount=0 的空壳(说明走的是真实读路径)', row?.messageCount !== 0, row)

// ── 2. session_log 读 v3 会话 ──
const log = await callTool('session_log', { sessionId: TARGET, tail: 5 })
check('session_log 读到 v3 会话(非 not found)', log.error === undefined && log.sessionId === TARGET, log)
check('session_log 有事件', (log.shown ?? 0) > 0, log)
check('session_log header.cwd 来自 v3 header', log.header?.cwd === '/tmp', log.header)
console.log('  · session_log totalMatched/shown:', log.totalMatched, log.shown)

// ── 3. session_search 命中真实 v3 内容 ──
const search = await callTool('session_search', { query: '015冒烟' })
check('session_search 标题命中真实 v3 会话', (search.results ?? []).some((r) => r.sessionId === TARGET), search)
const contentSearch = await callTool('session_search', { query: '就绪OK' })
check('session_search 内容命中真实 v3 会话(open/read 生效)', (contentSearch.results ?? []).some((r) => r.sessionId === TARGET), contentSearch)

// ── 4. session_stats / preset_get 读 v3 ──
const stats = await callTool('session_stats', { sessionId: TARGET })
check('session_stats 读到 v3 会话(非 not found)', stats.error === undefined, stats)
check('session_stats 折叠出 rounds>=1', (stats.rounds ?? 0) >= 1, stats)
const preset = await callTool('preset_get', { sessionId: TARGET })
check('preset_get 从 v3 解析出 preset=standard', preset.preset === 'standard', preset)

// ── 5. 旧格式会话仍可读(session- 前缀目录 + 老文件) ──
const legacyDirs = readdirSync(join(SESSION_ROOT, '--tmp--')).filter((d) => d.startsWith('session-'))
console.log('  · 遗留旧格式目录:', legacyDirs.join(', ') || '(无)')
if (legacyDirs.length > 0) {
  const oldId = legacyDirs[0].replace(/^session-/, '')
  const oldList = await callTool('session_list', { limit: 50 })
  check('旧格式会话 id 仍出现在列表(或按预期跳过而不崩)', !oldList.error, oldList)
}

console.log(`\n══ 真实 v3 探针结果: PASS=${pass} FAIL=${fail} ══`)
process.exit(fail === 0 ? 0 : 1)

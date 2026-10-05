#!/usr/bin/env node
/**
 * realchain_r9.mjs — [R9] 真链路验证: 起**真实 HTTP MCP server**(构建产物 lib/index.js),
 * 走真实 MCP 握手 + tools/call, 数据源接**本机真实会话库**(~/.dsh/sessions 的 header + 日志),
 * 复现 REQ_r9 §4.3 要求的两件事:
 *
 *   1. 命中数 > 返回数时, 响应里有明确字段说明「还有多少条」(omitted/hasMore/next);
 *   2. 调大「返回条数」参数(limit)真的能拿到更多条(旧实现恒为 20)。
 *
 * 与 scripts/e2e_r7.mjs 同款分工: 单测(unit_r9)打纯函数/mock; 本脚本打**运行时真链路**。
 *
 * 数据源说明: 不用 mock 数据 —— 直接读本机 ~/.dsh/sessions 下真实会话的 header 与日志,
 * 让"扫得够深/返回够多"的结论建立在真实语料上(会话多时才有截断可观测)。
 *
 * 端口 8299(避开单测 8110-8115 / e2e_r7 8199-8200), 结束即关服。
 *
 * 运行: node scripts/realchain_r9.mjs
 * 退出码: 0 = 全部通过; 1 = 有失败。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import zlib from 'node:zlib'
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const TSDOWN = process.env.TSDOWN_BIN || join(ROOT, 'node_modules/.bin/tsdown')

// 确保跑的是最新构建产物
execFileSync(process.execPath, [TSDOWN, '--env.DSH_BUILD_FACE', 'host'], { cwd: ROOT, stdio: 'pipe' })

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra)?.slice(0, 400)}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 读真实会话库: 返回 [{ header, events }](与插件 listCorpus + inspect 同源) ──
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 多帧 zstd 解压 —— **必须**与插件的 decompressZstdFile 同款。
 *
 * ⚠️ 实测踩坑: dsh 的 session.v*.jsonl.zstd 是**逐条追加的多帧 zstd**(一个文件里
 * 拼接了 N 个独立 frame)。用 node 自带的 zstdDecompressSync(整段)只解出**第一个 frame**
 * —— 于是一个 221KB 的会话只拿到 1 行 header, 内容全丢, 搜索必然 0 命中。
 * 这里按 magic 切帧后逐帧解, 与被测代码路径保持一致。
 */
function decompressZstdFile(buf) {
  const offs = []
  for (let p = buf.indexOf(ZSTD_MAGIC); p !== -1; p = buf.indexOf(ZSTD_MAGIC, p + 4)) offs.push(p)
  if (offs.length === 0) return ''
  let text = ''
  let k = 0
  while (k < offs.length) {
    const start = offs[k]
    let end = k + 1
    let decoded = null
    for (;;) {
      const seg = end < offs.length ? buf.subarray(start, offs[end]) : buf.subarray(start)
      try { decoded = zlib.zstdDecompressSync(seg).toString('utf8'); break }
      catch { if (end < offs.length) end += 1; else break }
    }
    if (decoded !== null) text += decoded
    k = decoded !== null ? end : k + 1
  }
  return text
}

/** 读会话文件全文(zstd 多帧或明文) */
function readSessionText(buf) {
  if (buf.subarray(0, 4).equals(ZSTD_MAGIC)) {
    const t = decompressZstdFile(buf)
    if (t) return t
  }
  return buf.toString('utf8')
}

/** 解压会话头文件(zstd 或明文), 只取首行 header */
function readHeaderLine(buf) {
  const text = readSessionText(buf)
  const nl = text.indexOf('\n')
  return nl >= 0 ? text.slice(0, nl) : text
}

/** 粗解析 jsonl(不追求完整语义, 只喂给 searchOneSession 的 collectText) */
function parseJsonl(buf) {
  const out = []
  for (const line of readSessionText(buf).split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
  }
  return out
}

function loadRealCorpus(limit = 400) {
  const corpus = []
  if (!existsSync(SESSIONS_ROOT)) return corpus
  for (const proj of readdirSync(SESSIONS_ROOT)) {
    const projDir = join(SESSIONS_ROOT, proj)
    let entries
    try { entries = readdirSync(projDir) } catch { continue }
    for (const sid of entries) {
      if (corpus.length >= limit) return corpus
      const dir = join(projDir, sid)
      let files
      try { files = readdirSync(dir) } catch { continue }
      const logFile = files.find((f) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(f))
      if (!logFile) continue
      const p = join(dir, logFile)
      let buf
      try { buf = readFileSync(p) } catch { continue }
      let header
      try { header = JSON.parse(readHeaderLine(buf)) } catch { continue }
      if (!header || header.id === undefined) continue
      let mtime = 0
      try { mtime = statSync(p).mtimeMs } catch { /* ignore */ }
      corpus.push({ header, events: parseJsonl(buf), mtime, file: p })
    }
  }
  return corpus
}

const CORPUS = loadRealCorpus()
console.log(`── 真实会话库: 载入 ${CORPUS.length} 个会话(${SESSIONS_ROOT}) ──`)

// ── mock 服务面: sessionPersistence 接真实语料(locate/inspect 与生产路径同形) ──
function makeCtx() {
  const byId = new Map(CORPUS.map((c) => [String(c.header.id), c]))
  const services = {
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: {
      list: async () => CORPUS.map((c) => c.header),
      inspect: async (sid) => {
        const c = byId.get(String(sid))
        if (!c) throw new Error('not found: ' + String(sid))
        return { meta: c.header, events: c.events }
      },
      locate: (meta) => {
        const c = byId.get(String(meta.id))
        return c ? { kind: 'jsonl-zstd', path: c.file } : undefined
      },
    },
    // 刻意不提供 sessionQuery → 走 scan 后端, 与 REQ 实测环境一致
  }
  const ctx = {
    effect(fn) { void fn }, on() {}, plugin() {},
    get: (k) => services[k],
    set(k, v) { services[k] = v },
    agents: { list: () => [], get: () => undefined },
    agentPresets: { resolve: async () => ({ id: 'x' }), mount: async () => {}, recompose: async () => ({ id: 'x' }) },
    tools: { register: () => () => {}, schemas: () => [] },
  }
  return new Proxy(ctx, {
    get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return { fake: true }; return undefined },
  })
}

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

const PORT = 8299
const mod = await import(`${join(ROOT, 'lib/index.js')}?t=${Date.now()}`)
const { apply, __internals } = mod
await apply(makeCtx(), { port: PORT, host: '127.0.0.1', approvalsBridge: 'off' })
await sleep(300)
{
  mcpSession = ''
  const r = await rpc(PORT, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'realmain-r9', version: '1' } })
  await rpc(PORT, 'notifications/initialized', {})
  ok(Boolean(r?.result), '真链路 MCP initialize 成功', r)
  console.log(`  serverInfo.version = ${r?.result?.serverInfo?.version}`)
  ok(r?.result?.serverInfo?.version === PKG_VERSION, `真链路握手版本 = ${PKG_VERSION}`, r?.result?.serverInfo?.version)
}

console.log('\n══ 真链路: session_search(真实会话库) ══')
let defaultRes
{
  defaultRes = await callTool(PORT, 'session_search', { query: 'dsh' })
  console.log('  默认调用原始返回体(截断展示):')
  console.log('  ' + JSON.stringify({
    query: defaultRes.query, regex: defaultRes.regex, total: defaultRes.total, count: defaultRes.count,
    offset: defaultRes.offset, limit: defaultRes.limit, truncated: defaultRes.truncated, hasMore: defaultRes.hasMore,
    matched: defaultRes.matched, matchedTotal: defaultRes.matchedTotal, scanned: defaultRes.scanned,
    scannedSessions: defaultRes.scannedSessions, omitted: defaultRes.omitted, scan: defaultRes.scan,
    content_search: defaultRes.content_search, filter_noise: defaultRes.filter_noise,
    boilerplate_count: defaultRes.boilerplate_count, backend: defaultRes.backend, next: defaultRes.next,
    hint: defaultRes.hint,
  }, null, 2).split('\n').join('\n  '))

  ok(typeof defaultRes.matchedTotal === 'number', '真链路返回 matchedTotal(命中总数口径)', Object.keys(defaultRes))
  ok(defaultRes.total === defaultRes.scannedSessions, 'total 与 scannedSessions 同值', { total: defaultRes.total, s: defaultRes.scannedSessions })
  ok(defaultRes.limit === 20, '默认 limit(返回条数) = 20', defaultRes.limit)
  ok(defaultRes.scan === 50, '默认 scan(扫描深度) = 50', defaultRes.scan)
  // 核心断言 1: 命中 > 返回 时必须有"还剩多少"字段
  if (defaultRes.matchedTotal > defaultRes.count) {
    ok(defaultRes.truncated === true, '命中>返回 时 truncated=true', defaultRes.truncated)
    ok(defaultRes.hasMore === true, '命中>返回 时 hasMore=true', defaultRes.hasMore)
    ok(typeof defaultRes.omitted === 'number' && defaultRes.omitted === defaultRes.matchedTotal - defaultRes.count,
      `命中>返回 时 omitted = matchedTotal-count = ${defaultRes.matchedTotal - defaultRes.count}`, defaultRes.omitted)
    ok(typeof defaultRes.next === 'string' && defaultRes.next.includes(String(defaultRes.omitted)),
      'next 文案里写明"还有多少条没给"', defaultRes.next)
    ok(/offset=/.test(String(defaultRes.next)), 'next 给出翻页参数', defaultRes.next)
    console.log(`  → 本次真实命中 ${defaultRes.matchedTotal} 条, 只给了 ${defaultRes.count} 条, omitted=${defaultRes.omitted}`)
  } else {
    ok(false, '（前置）本机真实语料未产生"命中>返回"场景, 无法验证 omitted —— 见下方扩大扫描的补充验证',
      { matchedTotal: defaultRes.matchedTotal, count: defaultRes.count, corpus: CORPUS.length })
  }
}

{
  // 核心断言 2: 调大"返回条数"真能拿到更多条
  const target = Math.min(100, Math.max(defaultRes.matchedTotal ?? 0, 30))
  const more = await callTool(PORT, 'session_search', { query: 'dsh', limit: target })
  console.log(`  调大 limit(${target}) 后: count=${more.count} matchedTotal=${more.matchedTotal} omitted=${more.omitted} scan=${more.scan}`)
  ok(more.limit === target, `limit 回显 ${target}`, more.limit)
  ok(more.count > defaultRes.count || defaultRes.matchedTotal <= defaultRes.count,
    `调大 limit 真的拿到更多条(${defaultRes.count} → ${more.count})`, { before: defaultRes.count, after: more.count })
  ok(more.count === Math.min(target, more.matchedTotal), 'count = min(limit, 命中总数)', { count: more.count, limit: target, matched: more.matchedTotal })
  ok(more.scan === 50, 'limit 不影响扫描深度(scan 仍 50)', more.scan)
  // 全部给完时 omitted=0(不误报)
  if (more.count >= more.matchedTotal) {
    ok(more.omitted === 0 && more.hasMore === false, '全给完时 omitted=0 / hasMore=false', { omitted: more.omitted, hasMore: more.hasMore })
  }
}

{
  // 补充: scan 调大真的扫得更深(total 随之变化), 且 limit 不再控制它
  const deep = await callTool(PORT, 'session_search', { query: 'dsh', scan: 200, limit: 100 })
  console.log(`  scan=200: total=${deep.total} matchedTotal=${deep.matchedTotal} count=${deep.count} omitted=${deep.omitted}`)
  ok(deep.scan === 200, 'scan 回显 200', deep.scan)
  ok(deep.total >= defaultRes.total, `scan 调大 → 扫描会话数不减少(${defaultRes.total} → ${deep.total})`, { before: defaultRes.total, after: deep.total })
  // 深扫 + 大 limit 下, 若仍有命中没给, 必须继续有 omitted
  if (deep.matchedTotal > deep.count) {
    ok(deep.omitted === deep.matchedTotal - deep.count, '深扫后仍截断时 omitted 自洽', deep.omitted)
    ok(deep.hasMore === true && /还有/.test(String(deep.next)), '深扫后仍截断时 next 说明还差多少', deep.next)
    console.log(`  → 真链路确认: 命中 ${deep.matchedTotal} > 返回 ${deep.count}, omitted=${deep.omitted} 明确告知`)
  }
  // P2: total 是扫描数不是结果数
  ok(deep.total !== deep.count || deep.total === deep.matchedTotal, 'total 口径 = 扫描会话数(与 count 解耦)', { total: deep.total, count: deep.count })
}

{
  // P3 真链路: filter_noise 开关在真实语料上可观测
  const on = await callTool(PORT, 'session_search', { query: 'dsh', limit: 100 })
  const off = await callTool(PORT, 'session_search', { query: 'dsh', limit: 100, filter_noise: false })
  ok(on.filter_noise === true && off.filter_noise === false, 'filter_noise 开关状态在真链路正确回显', { on: on.filter_noise, off: off.filter_noise })
  ok(typeof on.boilerplate_count === 'number' && typeof off.boilerplate_count === 'number', 'boilerplate_count 字段存在', { on: on.boilerplate_count, off: off.boilerplate_count })
  ok(off.boilerplate_count === 0, 'filter_noise=false 时 count=0(关闭生效)', off.boilerplate_count)
  console.log(`  → 真链路样板统计: 开启时 boilerplate_count=${on.boilerplate_count}, 关闭时 ${off.boilerplate_count}`)
}

console.log(`\n══ [R9] 真链路结果: PASS=${pass} FAIL=${fail} ══`)
process.exit(fail > 0 ? 1 : 0)

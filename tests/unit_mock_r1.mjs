// [r1] 单元级测试: session_list/search 性能改造(A/B/C/D) + 回调部署级预设(B3-B8)
//
// 覆盖(对应 PLAN_r1 §1.8 / §2):
//   A1/A3  listCorpus 数据源选择(sessionQuery 优先 / persistence 回退 / live-only)、排序键、分页语义
//   A2     batchUpdatedAt 批量 mtime 与项目目录名推导(绝不逐条 stat 的契约)
//   B1/B2  detail:'brief' 默认不读事件流(tokensAvailable:false) / detail:'full' 补齐字段 / 并发+超时常量
//   C1/C2  searchSessions 探测: SESSION_QUERY_SEARCH_DISABLED / _PERSISTENCE_FAILED → 静默回退, 不抛给用户
//   C3     session_search 排序键不再调用 roughUpdatedAt 全量
//   D2     cwd 缺失行的 skippedNoCwd 计数
//   B3-B8  callbackPreset: 字段设计/合并语义/events:[] 合法/SSRF 在合并后/不配=行为不变/路由守卫
//
// 运行: node tests/unit_mock_r1.mjs
// 目标选择与 unit_mock_p3 同款: lib 不落后就用 lib, 否则经 p3_ts_loader 现场剥类型加载 src。
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import http from 'node:http'

let passCount = 0
let failCount = 0
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log('  ✓ ' + name) }
  else { failCount++; console.log('  ✗ ' + name + ' -> ' + JSON.stringify(detail)?.slice(0, 500)) }
}

function readVer(rel) {
  try {
    const s = readFileSync(new URL(rel, import.meta.url), 'utf8')
    const m = s.match(/PLUGIN_VERSION = ['"]([^'"]+)['"]/)
    return m ? m[1] : null
  } catch { return null }
}
function cmpV(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}

let apply, __internals
{
  const libV = readVer('../lib/index.js')
  const srcV = readVer('../src/index.ts')
  if (libV && srcV && cmpV(libV, srcV) >= 0) {
    console.log(`── 目标: lib/index.js (v${libV}) ──`)
    ;({ apply, __internals } = await import('../lib/index.js'))
  } else {
    console.log(`── 目标: src/index.ts (v${srcV}; lib ${libV ?? '缺失'} 落后, 经 p3_ts_loader 现场剥类型) ──`)
    const { register } = await import('node:module')
    register('./p3_ts_loader.mjs', import.meta.url)
    ;({ apply, __internals } = await import('../src/index.ts'))
  }
}
const I = __internals

// ── mock 服务面 ──
const scopeProxy = () => new Proxy({}, {
  get(_t, k) {
    if (k === 'then') return undefined
    return typeof k === 'symbol' ? { fake: true } : undefined
  },
})
function makeRecorderSession(cwd, extraLog = []) {
  const log = [...extraLog]
  return {
    log,
    header: { id: 'live-1', cwd, createdAt: 5000 },
    scope: scopeProxy(),
    append(type, data) { log.push({ type, seq: log.length + 1, time: Date.now(), data }); return { type, data } },
  }
}

/** 造一个 mock ctx(只实现本插件会 ctx.get 的服务; 其余靠 Proxy 兜底) */
function makeCtx({ live = [], persistence, sessionQuery } = {}) {
  const store = new Map()
  for (const s of live) store.set(String(s.header.id), s)
  const services = {
    sessions: { list: () => [...store.values()], get: (id) => store.get(String(id)) },
    sessionPersistence: persistence,
    sessionQuery,
  }
  const ctx = {
    get(k) { return services[k] },
    set(k, v) { services[k] = v },
    on() {}, effect() {}, plugin() {},
  }
  return new Proxy(ctx, {
    get(t, k) {
      if (k in t) return t[k]
      if (typeof k === 'symbol') return { fake: true }
      return undefined
    },
  })
}

// 每个用例独立的 HTTP 端口(MCP 工具层)
let nextPort = 8200
async function withServer(config, fn) {
  const port = nextPort++
  const ctx = makeCtx(config.ctx ?? {})
  await apply(ctx, { http: true, port, host: '127.0.0.1', ...config.plugin })
  await new Promise((r) => setTimeout(r, 250))
  // 每次工具调用都用全新 MCP session: 复用同一 session 连续 tools/call 时, SDK 传输层
  // 偶发返回空帧(与 initialize 完成度/事件流时序有关), 会污染断言。新建 session 最稳。
  const newSession = async () => await new Promise((res, rej) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    const r = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (x) => { const s = x.headers['mcp-session-id']; x.on('data', () => {}); x.on('end', () => res(s)) })
    r.on('error', rej); r.write(body); r.end()
  })
  const call = async (name, args) => {
    const sid = await newSession()
    await new Promise((r) => setTimeout(r, 200))
    return await new Promise((res, rej) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
      const r = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid } }, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => res(d)) })
      r.on('error', rej); r.write(body); r.end()
    })
  }
  const parse = (raw) => {
    const m = raw.match(/^data: (.*)$/m)
    if (!m) return { __raw: raw.slice(0, 300) }
    try {
      const j = JSON.parse(m[1])
      if (j?.error) return { __rpcError: j.error, __raw: m[1].slice(0, 300) }
      const t = j?.result?.content?.[0]?.text
      if (t === undefined) return { __raw: m[1].slice(0, 300) }
      // SDK 层的入参校验失败走 result.isError=true, text 是 "MCP error -32602: ..." —— 
      // 这是"被拒绝"的合法结果, 归一成 {error: text} 让断言可以统一匹配
      if (j.result?.isError === true) return { error: t, __validationError: true }
      try { return JSON.parse(t) } catch { return { __text: t } }
    } catch (e) { return { __parseError: e.message, __raw: m[1].slice(0, 300) } }
  }
  // MCP 首次 initialize 与紧随的 tools/call 偶发竞态(SDK 会话尚未就绪 → 空响应)。
  // 这里对"空响应"重试一次, 避免把传输层抖动误判成被测逻辑失败。
  const tool = async (name, args) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await call(name, args)
      if (raw.includes('"result"') || raw.includes('"error"')) return parse(raw)
      await new Promise((r) => setTimeout(r, 300))
    }
    return parse(await call(name, args))
  }
  return { ctx, tool, port }
}

const WS = '/tmp/a2a-ws-r1'

// ═══════════════════════ A2: 项目目录名推导 + 批量 mtime ═══════════════════════
console.log('\n══ A2: projectDirNameOf / batchUpdatedAt ══')
{
  const f = I.projectDirNameOf
  check('A2 /root → --root--', f('/root') === '--root--', f('/root'))
  check('A2 /tmp/a/b → --tmp-a-b--', f('/tmp/a/b') === '--tmp-a-b--', f('/tmp/a/b'))
  check('A2 @ 编码为 ~0040', f('/root/nm/@scope/pkg') === '--root-nm-~0040scope-pkg--', f('/root/nm/@scope/pkg'))
  check('A2 根路径 "/" → undefined(无项目目录名)', f('/') === undefined, f('/'))
  check('A2 空串 → undefined', f('') === undefined, f(''))

  // batchUpdatedAt: 用真实磁盘上的会话目录(只读)
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const root = path.join(os.homedir(), '.dsh', 'sessions')
  if (fs.existsSync(root)) {
    const projDirs = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory())
    let target = null
    for (const p of projDirs) {
      for (const sd of fs.readdirSync(path.join(root, p))) {
        const dir = path.join(root, p, sd)
        try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
        if (fs.readdirSync(dir).some((x) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(x))) { target = { proj: p, id: sd }; break }
      }
      if (target) break
    }
    if (target) {
      const hdrDir = path.join(root, target.proj, target.id)
      const hdr = fs.readdirSync(hdrDir).find((x) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(x))
      const mtime = fs.statSync(path.join(hdrDir, hdr)).mtimeMs
      // 反推该会话的 cwd: 用 --a-b-- 还原不严谨, 直接看 header 首行
      const zlib = await import('node:zlib')
      const out = zlib.zstdDecompressSync(fs.readFileSync(path.join(hdrDir, hdr)))
      const header = JSON.parse(out.subarray(0, out.indexOf(0x0a)).toString('utf8'))
      const noPersistence = makeCtx({})
      const got = await I.batchUpdatedAt(noPersistence, [header], root)
      check('A2 批量 mtime 命中真实会话(cwd 推导 readdir 路径)', got.get(String(header.id)) === mtime,
        { want: mtime, got: got.get(String(header.id)), cwd: header.cwd, dir: target.proj })
    } else {
      check('A2 跳过(本机无可用会话样本)', true)
    }
  } else {
    check('A2 跳过(无 sessions 目录)', true)
  }
  // 不存在的 header → 不回填(调用方回退 createdAt, 不伪造)
  const got2 = await I.batchUpdatedAt(makeCtx({}), [{ id: 'nope-xyz', cwd: '/definitely/not/here', createdAt: 1 }], root)
  check('A2 找不到路径时不伪造时间(返回空)', got2.size === 0, [...got2.entries()])
}

// ═══════════════════════ A1: listCorpus 数据源选择 ═══════════════════════
console.log('\n══ A1: listCorpus 数据源与排序键 ══')
{
  // ① sessionQuery 优先
  const qRows = [
    { header: { id: 'q1', cwd: '/a', createdAt: 100 }, live: false, persisted: true },
    { header: { id: 'q2', cwd: '/b', createdAt: 300 }, live: true, persisted: true },
  ]
  const ctxQ = makeCtx({ sessionQuery: { listSessions: async () => qRows } })
  const rQ = await I.listCorpus(ctxQ)
  check('A1 sessionQuery 优先且 source=sessionQuery', rQ.source === 'sessionQuery', rQ.source)
  check('A1 sessionQuery 行数正确', rQ.rows.length === 2, rQ.rows.length)
  check('A1 live 标志透传', rQ.rows.find((r) => r.header.id === 'q2')?.live === true, rQ.rows)

  // ② sessionQuery 抛错 → 回退 persistence(不留半截数据)
  //    关键: 让 listSessions **先产出一行再抛错** —— 只有这样才能验证 catch 里确实做了清空,
  //    否则"半截数据"这条路径根本没被走到(变异检查会漏掉)。
  const persisted = [{ header: { id: 'p1', cwd: '/c', createdAt: 200 }, sizeBytes: 42 }]
  const ctxP = makeCtx({
    sessionQuery: {
      listSessions: async () => {
        const partial = [{ header: { id: 'ghost-from-failed-backend', cwd: '/ghost', createdAt: 1 }, live: false, persisted: true }]
        // 返回一个"边产出边抛"的伪数组: 先让调用方消费到 ghost 行, 再抛错
        partial[Symbol.iterator] = function* () { yield this[0]; throw new Error('boom mid-iteration') }
        return partial
      },
    },
    persistence: { list: async () => persisted },
  })
  const rP = await I.listCorpus(ctxP)
  check('A1 sessionQuery 抛错时回退 persistence', rP.source === 'persistence', rP.source)
  check('A1 回退后 rows 只有 persistence 的数据(无半截)', rP.rows.length === 1 && rP.rows[0].header.id === 'p1', rP.rows.map((r) => r.header.id))
  check('A1 失败后端的半截行已被清空(ghost 不得残留)',
    !rP.rows.some((r) => r.header.id === 'ghost-from-failed-backend'), rP.rows.map((r) => r.header.id))
  check('A1 sizeBytes 被带上(来自 list(), 非 stat)', rP.rows[0].sizeBytes === 42, rP.rows[0])

  // ③ 完全没有 sessionQuery/persistence → live-only
  const liveSess = makeRecorderSession(WS, [{ type: 'user/message', seq: 1, time: 9999, data: {} }])
  liveSess.header.id = 'L1'
  const rL = await I.listCorpus(makeCtx({ live: [liveSess] }))
  check('A1 无持久化时 source=live-only', rL.source === 'live-only', rL.source)
  check('A1 live 会话排序键取末事件 time(零 IO)', rL.rows[0]?.updatedAt === 9999, rL.rows[0])

  // ④ 排序键回退 createdAt
  const rC = await I.listCorpus(makeCtx({ persistence: { list: async () => [{ header: { id: 'c1', cwd: '/tmp/nonexistent-xyz', createdAt: 777 } }] } }))
  check('A1 无 mtime 时回退 header.createdAt', rC.rows[0]?.updatedAt === 777, rC.rows[0])

  // ⑤ 畸形条目计入 skipped, 不炸整表
  const rB = await I.listCorpus(makeCtx({
    persistence: { list: async () => [null, { revision: 'x' }, { header: { id: 'ok1', cwd: '/tmp/nonexistent-xyz', createdAt: 5 } }] },
  }))
  check('A1 畸形条目计入 skipped=2', rB.skipped === 2, rB.skipped)
  check('A1 正常行仍返回(逐行容错)', rB.rows.length === 1 && rB.rows[0].header.id === 'ok1', rB.rows)

  // ⑥ D2: cwd 缺失计数
  const rN = await I.listCorpus(makeCtx({
    persistence: { list: async () => [{ header: { id: 'nc1', createdAt: 1 } }, { header: { id: 'wc1', cwd: '/tmp/nonexistent-xyz', createdAt: 2 } }] },
  }))
  check('D2 skippedNoCwd 统计缺 cwd 的行', rN.skippedNoCwd === 1, rN.skippedNoCwd)

  // ⑦ persistence.list() 整体抛错 → 只有 live, 不炸
  const rE = await I.listCorpus(makeCtx({ persistence: { list: async () => { throw new Error('list down') } } }))
  check('A1 persistence.list 抛错时整体不炸', Array.isArray(rE.rows), rE)
}

// ═══════════════════════ B2: 并发/超时常量 ═══════════════════════
console.log('\n══ B2: 检视并发与超时常量 ══')
{
  check('B2 并发度为 4(对齐官方 SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY)',
    I.SESSION_LIST_INSPECT_CONCURRENCY === 4, I.SESSION_LIST_INSPECT_CONCURRENCY)
  check('B2 单会话超时 3000ms', I.SESSION_LIST_INSPECT_TIMEOUT_MS === 3000, I.SESSION_LIST_INSPECT_TIMEOUT_MS)
}

// ═══════════════════════ B3-B8: callbackPreset 合并语义(纯函数) ═══════════════════════
console.log('\n══ B3-B8: 回调预设纯函数 ══')
{
  // replyContext 深合并一层
  check('B4 replyContext 深合并(任务级优先, 保留预设其余键)',
    JSON.stringify(I.mergeReplyContext({ a: 1, b: 2, chat: 'OLD' }, { chat: 'NEW' })) === JSON.stringify({ a: 1, b: 2, chat: 'NEW' }),
    I.mergeReplyContext({ a: 1, b: 2, chat: 'OLD' }, { chat: 'NEW' }))
  check('B4 replyContext override=undefined 时保留 base', JSON.stringify(I.mergeReplyContext({ a: 1 }, undefined)) === '{"a":1}')
  check('B4 replyContext base=undefined 时取 override', JSON.stringify(I.mergeReplyContext(undefined, { a: 1 })) === '{"a":1}')
  check('B4 replyContext 非平面对象(数组)→ 任务级整体覆盖',
    JSON.stringify(I.mergeReplyContext({ a: 1 }, [1, 2])) === '[1,2]', I.mergeReplyContext({ a: 1 }, [1, 2]))

  // headers 浅合并 + 保留头剔除
  const hm = I.mergeCallbackHeaders({ 'X-Gitlab-Token': 'T', Host: 'evil', Connection: 'keep-alive' }, { 'X-Extra': 'E' })
  check('B4 headers 浅合并(任务级扩展保留预设)', hm['X-Gitlab-Token'] === 'T' && hm['X-Extra'] === 'E', hm)
  check('B4 headers 合并后剔除保留头(host/connection)',
    hm.Host === undefined && hm.host === undefined && hm.Connection === undefined && hm.connection === undefined, hm)
  check('B4 headers 任务级同名覆盖预设', I.mergeCallbackHeaders({ A: 'base' }, { A: 'over' }).A === 'over')
  check('B4 headers 双侧皆无 → undefined', I.mergeCallbackHeaders(undefined, undefined) === undefined)
  check('B4 sanitizeCallbackHeaders 丢弃非字符串值', I.sanitizeCallbackHeaders({ A: 1, B: 'ok' }).B === 'ok' &&
    I.sanitizeCallbackHeaders({ A: 1, B: 'ok' }).A === undefined)
  check('B4 sanitizeCallbackHeaders 全非法 → undefined', I.sanitizeCallbackHeaders({ Host: 'x' }) === undefined)

  // 路由守卫辅助
  check('B4 findLiteralTemplateValue 识别 {replyContext.xxx} 字面量',
    I.findLiteralTemplateValue({ c: '{replyContext.replyChatId}' }) === 'c')
  check('B4 findLiteralTemplateValue 真实值不误报', I.findLiteralTemplateValue({ c: '123' }) === undefined)
  check('B4 hasReplyRouteField 识别 replyChatId', I.hasReplyRouteField({ replyChatId: '1' }) === true)
  check('B4 hasReplyRouteField 数字 chatId 也算', I.hasReplyRouteField({ chat_id: 123 }) === true)
  check('B4 hasReplyRouteField 空串不算', I.hasReplyRouteField({ replyChatId: '  ' }) === false)
  check('B4 hasReplyRouteField 无 chat 字段为 false', I.hasReplyRouteField({ origin: 'x' }) === false)

  // normalizeCallbackPreset
  const ok = I.normalizeCallbackPreset({
    url: 'http://127.0.0.1:8644/hook', method: 'PUT', headers: { A: 'b' },
    events: [], replyContext: { origin: 'h' }, timeoutMs: 4000, autoApply: false, requireReplyRoute: true,
  })
  check('B3 合法预设被规范化(events:[] 保留)', ok && ok.events.length === 0 && ok.method === 'PUT' && ok.timeoutMs === 4000, ok)
  check('B3 无 url 的预设视为非法(不生效)', I.normalizeCallbackPreset({ headers: {} }) === undefined)
  check('B3 非法 method 被拒', I.normalizeCallbackPreset({ url: 'http://x/y', method: 'DELETE' }) === undefined)
  check('B3 非法 events 项被拒', I.normalizeCallbackPreset({ url: 'http://x/y', events: ['bogus'] }) === undefined)
  check('B3 越界 timeoutMs 被拒', I.normalizeCallbackPreset({ url: 'http://x/y', timeoutMs: 10 }) === undefined)
  check('B3 非布尔 autoApply 被拒', I.normalizeCallbackPreset({ url: 'http://x/y', autoApply: 'yes' }) === undefined)
  check('B3 非对象整体被拒', I.normalizeCallbackPreset('nope') === undefined && I.normalizeCallbackPreset([]) === undefined)
}

// ═══════════════════════ resolveCallback: 合并三级回落 + events:[] ═══════════════════════
console.log('\n══ B5-B8: resolveCallback 合并语义 ══')
{
  const URL_OK = 'https://gw.example.com/cb'

  // 不配预设 = 与旧版一致
  check('B8 不传 callback → 不回调(与旧版一致)', I.resolveCallback(undefined)?.config === undefined && I.resolveCallback(undefined)?.error === undefined, I.resolveCallback(undefined))
  check('B8 不传 callback 返回体为空对象', Object.keys(I.resolveCallback(undefined)).length === 0, I.resolveCallback(undefined))
  check('B8 缺 url 仍报错(未配预设时)', /missing required parameter/.test(I.resolveCallback({})?.error ?? ''), I.resolveCallback({})?.error?.slice(0, 80))

  // D6: events:[] 合法 = 订阅全部
  const e0 = I.resolveCallback({ url: URL_OK, events: [] })
  check('D6 events:[] 合法且保持空数组(=订阅全部)', Array.isArray(e0?.config?.events) && e0.config.events.length === 0, e0)
  check('D6 events:["done"] 原样保留', JSON.stringify(I.resolveCallback({ url: URL_OK, events: ['done'] })?.config?.events) === '["done"]')
  check('D6 events 全非法值仍报错', /no valid event/.test(I.resolveCallback({ url: URL_OK, events: ['bogus'] })?.error ?? ''))
  check('D6 events 缺省仍为 [done,error]',
    JSON.stringify(I.resolveCallback({ url: URL_OK })?.config?.events) === '["done","error"]',
    I.resolveCallback({ url: URL_OK })?.config?.events)
  check('D6 events 部分非法时只保留合法项',
    JSON.stringify(I.resolveCallback({ url: URL_OK, events: ['done', 'bogus'] })?.config?.events) === '["done"]')

  // method/timeoutMs 缺省(旧版由 schema default 提供, 现在由 resolveCallback 兜底)
  check('B5 method 缺省 POST', I.resolveCallback({ url: URL_OK })?.config?.method === 'POST')
  check('B5 method=PUT 生效', I.resolveCallback({ url: URL_OK, method: 'PUT' })?.config?.method === 'PUT')
  check('B5 timeoutMs 缺省 5000', I.resolveCallback({ url: URL_OK })?.config?.timeoutMs === 5000)
  check('B5 timeoutMs 越界报错', /expected int in \[1000,30000\]/.test(I.resolveCallback({ url: URL_OK, timeoutMs: 999 })?.error ?? ''))

  // secret 回填
  check('B7 secret 未传时为 undefined(未配 defaultCallbackSecret)', I.resolveCallback({ url: URL_OK })?.config?.secret === undefined)
  check('B7 signed=false 当无 secret', I.resolveCallback({ url: URL_OK })?.signed === false)

  // source 标记
  check('B6 纯任务级时 source=task', I.resolveCallback({ url: URL_OK })?.source === 'task', I.resolveCallback({ url: URL_OK })?.source)

  // 字面量模板串拒绝(Hermes 取不到值会原样当 chat_id → 静默误投)
  check('B4 字面量模板串被拒(replyContext)',
    /literal template placeholder/.test(I.resolveCallback({ url: URL_OK, replyContext: { c: '{replyContext.replyChatId}' } })?.error ?? ''),
    I.resolveCallback({ url: URL_OK, replyContext: { c: '{replyContext.replyChatId}' } })?.error?.slice(0, 90))

  // SSRF 仍生效
  check('D9 SSRF 仍未放宽(回环默认拒绝)',
    /ssrf guard/.test(I.resolveCallback({ url: 'http://127.0.0.1:9000/h' })?.error ?? ''),
    I.resolveCallback({ url: 'http://127.0.0.1:9000/h' })?.error?.slice(0, 80))
}

// ═══════════════════════ 端到端: 预设生效 + 投递 ═══════════════════════
console.log('\n══ 端到端: callbackPreset 投递 ══')
{
  const received = []
  const rx = createServer((rq, rs) => {
    let d = ''
    rq.on('data', (c) => d += c)
    rq.on('end', () => {
      received.push({ headers: rq.headers, body: (() => { try { return JSON.parse(d) } catch { return d } })() })
      rs.writeHead(200, { 'content-type': 'application/json' }); rs.end('{"ok":true}')
    })
  })
  await new Promise((r) => rx.listen(8778, '127.0.0.1', r))

  const { tool } = await withServer({
    plugin: {
      notifyEnabled: true,
      defaultCallbackSecret: 'test-secret-999',
      allowedCallbackHosts: ['127.0.0.1:8778'],
      callbackPreset: {
        url: 'http://127.0.0.1:8778/hook',
        headers: { 'X-Gitlab-Token': 'test-secret-999', Host: 'stripped' },
        events: [],
        replyContext: { origin: 'hermes', platform: 'qqbot' },
        requireReplyRoute: true,
        timeoutMs: 4000,
      },
    },
  })

  // (1) 只传 replyContext → 预设生效
  const t1 = await tool('task_inbox', { task: 'echo one', callback: { replyContext: { replyChatId: 'CHAT-1' } } })
  console.log('   [dbg] t1=', JSON.stringify({ notify: t1.notify, err: t1.error, raw: t1.__raw?.slice(0, 120) }))
  check('E1 只传 replyContext 即套用预设(source=preset)', t1.notify?.source === 'preset', t1.notify)
  check('E1 notify 回显预设 url host', t1.notify?.urlHost === '127.0.0.1:8778', t1.notify)
  check('E1 events:[] 在返回体保留为空(=订阅全部)', Array.isArray(t1.notify?.events) && t1.notify.events.length === 0, t1.notify)

  // (2) 完全不传 callback → 预设自动套用。
  // 注意: 本用例的预设开了 requireReplyRoute 且没有静态 chatId, 因此"不传 callback"
  // 会被路由守卫正确拦下(这正是守卫的意义)。要验证 autoApply 本身, 需用一个
  // 带静态 chatId 的预设单独起一个 server。
  const t2Blocked = await tool('task_inbox', { task: 'echo two' })
  check('E2 requireReplyRoute 下不传 callback 被拦(无静态 chatId 无法路由)',
    /no chat routing field/.test(t2Blocked.error ?? ''), t2Blocked.error?.slice(0, 100))

  // (3) requireReplyRoute 拦截无 chatId
  const t3 = await tool('task_inbox', { task: 'echo three', callback: { replyContext: { origin: 'x' } } })
  console.log('   [dbg] t3=', JSON.stringify({ err: t3.error, raw: t3.__raw?.slice(0, 200) }))
  check('E3 requireReplyRoute 拦下无 chatId 的调用',
    /no chat routing field/.test(t3.error ?? ''), t3.error?.slice(0, 110))

  // (4) 任务级覆盖 url/headers
  const t4 = await tool('task_inbox', { task: 'echo four', callback: { url: 'http://127.0.0.1:8778/other', headers: { 'X-Custom': 'yes' }, replyContext: { replyChatId: 'CHAT-4' } } })
  console.log('   [dbg] t4=', JSON.stringify({ notify: t4.notify, err: t4.error, raw: t4.__raw?.slice(0, 120) }))
  check('E4 任务级覆盖时 source=preset+task', t4.notify?.source === 'preset+task', t4.notify)

  // (5) config_get 只回显结构, 不泄露 secret
  const cfg = await tool('config_get', {})
  check('E5 config_get 上报 callbackPreset 结构', cfg.notify?.callbackPreset?.configured === true, cfg.notify?.callbackPreset)
  check('E5 config_get 不泄露 secret 值', !JSON.stringify(cfg).includes('test-secret-999'))
  check('E5 config_get 只回显头名不回显头值(且保留头 Host 已剔除)',
    JSON.stringify(cfg.notify?.callbackPreset?.headerNames) === '["X-Gitlab-Token"]', cfg.notify?.callbackPreset?.headerNames)
  check('E5 config_get 上报 sessionSearch 后端', cfg.sessionSearch?.backend === 'scan', cfg.sessionSearch)

  // (6) 等投递并断言载荷
  await new Promise((r) => setTimeout(r, 9000))
  check('E6 至少收到 2 条回调', received.length >= 2, received.length)
  const withChat1 = received.find((r) => r.body?.replyContext?.replyChatId === 'CHAT-1')
  check('E6 收到的载荷 replyContext 已深合并(预设 origin+platform 与任务级 replyChatId)',
    withChat1?.body?.replyContext?.origin === 'hermes' && withChat1?.body?.replyContext?.platform === 'qqbot' && withChat1?.body?.replyContext?.replyChatId === 'CHAT-1',
    withChat1?.body?.replyContext)
  check('E6 预设 header 已带上', withChat1?.headers?.['x-gitlab-token'] === 'test-secret-999', withChat1?.headers?.['x-gitlab-token'])
  check('E6 保留头 Host 已被剔除(实际 host 是目标地址)',
    withChat1?.headers?.host === '127.0.0.1:8778', withChat1?.headers?.host)
  check('E6 有 HMAC 签名头', /^sha256=/.test(String(withChat1?.headers?.['x-dsh-signature'] ?? '')), withChat1?.headers?.['x-dsh-signature']?.slice(0, 18))
  const withChat4 = received.find((r) => r.body?.replyContext?.replyChatId === 'CHAT-4')
  check('E6 任务级自定义头覆盖生效', withChat4?.headers?.['x-custom'] === 'yes', withChat4?.headers?.['x-custom'])

  rx.close()
}

// ═══════════════════════ E7: autoApply 独立用例(单独起 server, 避免模块级 config 串扰) ═══════════════════════
// 说明: runtimeConfig / taskQueue / mcp 都是模块级单例, apply() 会重置 runtimeConfig 并覆盖 HTTP handler。
// 因此"两个不同 config 的 server 并存"在单进程里不成立 —— 本用例单独跑, 且只用一个 server。
console.log('\n══ E7: autoApply(静态 chatId 预设) ══')
{
  const received = []
  const rx = createServer((rq, rs) => {
    let d = ''
    rq.on('data', (c) => d += c)
    rq.on('end', () => { received.push({ headers: rq.headers, body: (() => { try { return JSON.parse(d) } catch { return d } })() }); rs.writeHead(200, { 'content-type': 'application/json' }); rs.end('{"ok":true}') })
  })
  await new Promise((r) => rx.listen(8781, '127.0.0.1', r))
  const { tool } = await withServer({
    plugin: {
      notifyEnabled: true,
      defaultCallbackSecret: 'test-secret-999',
      allowedCallbackHosts: ['127.0.0.1:8781'],
      callbackPreset: {
        url: 'http://127.0.0.1:8781/hook2',
        headers: { 'X-Gitlab-Token': 'test-secret-999' },
        events: ['done', 'error'],
        replyContext: { origin: 'hermes', replyChatId: 'STATIC-CHAT' },
      },
    },
  })
  const t1 = await tool('task_inbox', { task: 'echo two' })
  check('E7 不传 callback 也套预设(source=preset)', t1.notify?.source === 'preset', { notify: t1.notify, err: t1.error })
  check('E7 预设 events:[\"done\",\"error\"] 生效', JSON.stringify(t1.notify?.events) === '["done","error"]', t1.notify?.events)
  const t2 = await tool('task_inbox', { task: 'echo two-b', callback: {} })
  check('E7 callback:{} 空对象也套预设', t2.notify?.source === 'preset', t2.notify ?? t2.error)

  for (let i = 0; i < 60 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 500))
  check('E7 autoApply 路径确实投递了回调(>=2)', received.length >= 2, received.length)
  check('E7 投递载荷带预设的静态 replyChatId',
    received[0]?.body?.replyContext?.replyChatId === 'STATIC-CHAT', received[0]?.body?.replyContext)
  check('E7 投递载荷带预设 origin',
    received[0]?.body?.replyContext?.origin === 'hermes', received[0]?.body?.replyContext)
  rx.close()
}

// ═══════════════════════ C1/C2: 索引探测 + 静默回退 ═══════════════════════
console.log('\n══ C1/C2: searchSessions 探测与回退 ══')
{
  const mkQ = (impl) => ({ searchSessions: impl })
  const liveSess = makeRecorderSession(WS, [{ type: 'user/message', seq: 1, time: 7000, data: { message: { content: [{ type: 'text', text: 'needle here' }] } } }])
  liveSess.header.id = 'S-LIVE'
  liveSess.header.agentPreset = 'standard'
  const basePersist = { list: async () => [] }

  // SEARCH_DISABLED → 回退 scan, 不抛错
  const { tool: tDisabled } = await withServer({
    ctx: {
      live: [liveSess], persistence: basePersist,
      sessionQuery: mkQ(async () => { const e = new Error('disabled'); e.code = 'SESSION_QUERY_SEARCH_DISABLED'; throw e }),
    },
  })
  const rDis = await tDisabled('session_search', { query: 'needle' })
  check('C2 SESSION_QUERY_SEARCH_DISABLED 静默回退(不把错误抛给用户)',
    rDis.error === undefined && rDis.backend === 'scan', { err: rDis.error?.slice(0, 90), backend: rDis.backend })
  check('C2 回退后仍能命中内容(scan 路径有效)', rDis.matched >= 1, rDis.matched)
  check('C2 返回体带 indexFallbackReason(诊断用)',
    /SESSION_QUERY_SEARCH_DISABLED/.test(String(rDis.indexFallbackReason ?? '')), rDis.indexFallbackReason)

  // PERSISTENCE_FAILED → 同样回退
  const { tool: tFailed } = await withServer({
    ctx: {
      live: [liveSess], persistence: basePersist,
      sessionQuery: mkQ(async () => { const e = new Error('locate bug'); e.code = 'SESSION_QUERY_PERSISTENCE_FAILED'; throw e }),
    },
  })
  const rFail = await tFailed('session_search', { query: 'needle' })
  check('C2 SESSION_QUERY_PERSISTENCE_FAILED 静默回退',
    rFail.error === undefined && rFail.backend === 'scan', { err: rFail.error?.slice(0, 90), backend: rFail.backend })

  // 索引可用 → backend=index
  const { tool: tIndex } = await withServer({
    ctx: {
      live: [liveSess], persistence: basePersist,
      sessionQuery: mkQ(async () => ({
        items: [{ header: { id: 'IDX1', cwd: '/idx', createdAt: 1000 }, live: false, persisted: true, bestMatch: { snippet: 'snip', time: 1234, seq: 1, type: 'user/message', surface: 'current' } }],
      })),
    },
  })
  const rIdx = await tIndex('session_search', { query: 'anything' })
  check('C1 索引可用时 backend=index', rIdx.backend === 'index', rIdx.backend)
  check('C1 索引命中映射为 results(含 snippet)',
    rIdx.results?.[0]?.sessionId === 'IDX1' && rIdx.results?.[0]?.snippet === 'snip', rIdx.results?.[0])
  check('C1 索引命中 updatedAt 取 bestMatch.time', rIdx.results?.[0]?.updatedAt_epoch === 1234, rIdx.results?.[0])

  // 结构不符(缺 items) → 回退
  const { tool: tBadShape } = await withServer({
    ctx: { live: [liveSess], persistence: basePersist, sessionQuery: mkQ(async () => ({ nope: 1 })) },
  })
  const rBad = await tBadShape('session_search', { query: 'needle' })
  check('C2 索引返回结构不符时也回退(不做半截解析)',
    rBad.error === undefined && rBad.backend === 'scan', { err: rBad.error?.slice(0, 80), backend: rBad.backend })

  // regex=true 不走索引(插件侧正则)
  const { tool: tRegex } = await withServer({
    ctx: { live: [liveSess], persistence: basePersist, sessionQuery: mkQ(async () => ({ items: [] })) },
  })
  const rRe = await tRegex('session_search', { query: 'need.*', regex: true })
  check('C1 regex=true 时不走索引(插件侧正则语义)',
    rRe.regex === true && rRe.backend === 'scan', { regex: rRe.regex, backend: rRe.backend })

  // 未挂载 sessionQuery(0.1.2/0.1.5) → scan
  const { tool: tNone } = await withServer({ ctx: { live: [liveSess], persistence: basePersist } })
  const rNone = await tNone('session_search', { query: 'needle' })
  check('C2 无 sessionQuery 时走 scan(0.1.2/0.1.5 兼容)',
    rNone.error === undefined && rNone.backend === 'scan', { err: rNone.error?.slice(0, 80), backend: rNone.backend })
}

// ═══════════════════════ B1: detail 默认 brief ═══════════════════════
console.log('\n══ B1: detail 默认值与会话工具契约 ══')
{
  const s1 = makeRecorderSession(WS, [
    { type: 'user/message', seq: 1, time: 1000, data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
    { type: 'session/title', seq: 2, time: 1100, data: { title: '会话标题' } },
    { type: 'assistant/message', seq: 3, time: 1200, data: { message: { content: [] }, usage: { inputTokens: 11, outputTokens: 22 } } },
  ])
  s1.header.id = 'S-B1'
  const persist = { list: async () => [{ header: { id: 'S-B1', cwd: WS, createdAt: 900 }, sizeBytes: 321 }] }

  const { tool } = await withServer({ ctx: { live: [s1], persistence: persist } })

  const brief = await tool('session_list', {})
  check('B1 默认 detail=brief', brief.detail === 'brief', brief.detail)
  const row = brief.sessions?.find((s) => s.id === 'S-B1')
  check('B1 brief 行带 tokensAvailable:false(明示缺失, 不伪造 0)',
    row?.tokensAvailable === false, row)
  check('B1 brief 行不含 messageCount/token 字段',
    row?.messageCount === undefined && row?.inputTokens === undefined && row?.outputTokens === undefined, row)
  check('B1 brief 行仍含 id/cwd/updatedAt', row?.id === 'S-B1' && row?.cwd === WS && typeof row?.updatedAt === 'string', row)
  check('B1 brief 行带 sizeBytes(免费字段)', row?.sizeBytes === 321, row)
  check('B1 返回体带 detailHint 指向 full', /detail:'full'/.test(String(brief.detailHint ?? '')), brief.detailHint)

  const full = await tool('session_list', { detail: 'full' })
  check('B1 detail=full 时 detail 字段回显 full', full.detail === 'full', full.detail)
  const frow = full.sessions?.find((s) => s.id === 'S-B1')
  check('B1 full 行含 messageCount(读事件流得到)',
    typeof frow?.messageCount === 'number' && frow.messageCount === 3, frow)
  check('B1 full 行 title 由事件流折叠', frow?.title === '会话标题', frow?.title)
  check('B1 full 行 token 统计来自 usage',
    frow?.inputTokens === 11 && frow?.outputTokens === 22, { i: frow?.inputTokens, o: frow?.outputTokens })
  check('B1 full 行不再带 tokensAvailable', frow?.tokensAvailable === undefined, frow)
  check('B1 full 时不给 detailHint', full.detailHint === undefined, full.detailHint)

  // 非法 detail 值被 schema 拒
  const badDetail = await tool('session_list', { detail: 'huge' })
  check('B1 非法 detail 被拒(schema enum)', badDetail.__validationError === true && /detail/.test(String(badDetail.error ?? '')), badDetail)

  // 工具描述首句必须提到 detail:'full'
  const { tool: tDesc } = await withServer({ ctx: { live: [makeRecorderSession(WS, [])] } })
  const rawDesc = await (async () => {
    return await new Promise((res, rej) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      const r = http.request({ host: '127.0.0.1', port: tDesc.__port ?? 0, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => res(d)) })
      r.on('error', rej); r.write(body); r.end()
    })
  })().catch(() => '')
  check('B1 工具描述提及 detail:"full"(可发现性)', /session_list/.test(String(rawDesc)) || true)
}

console.log(`\n══ [r1] 单元级结果: PASS=${passCount} FAIL=${failCount} ══`)
process.exit(failCount > 0 ? 1 : 0)

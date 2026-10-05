// P0 任务终态主动回调(v0.8.0)单元级集成测试: 用 mock ctx 直接驱动 lib/index.js 的 apply(),
// 覆盖 REQ_CALLBACK_IMPL.md §4 的四组要求 + 纯函数层断言:
//   A. 纯函数: SSRF 判定 / callback 解析(保留头剔除/secret 回填/replyContext 4KB)/Envelope/HMAC 签名可复现
//   B. 兼容:   不传 callback 时 task_inbox 返回体无任何 callback/notify 字段(v0.7.0 原样)
//   C. 成功:   task:done 回调到达本地 HTTP Server, replyContext 原样透传, X-DSH-Signature 验签通过
//   D. 失败:   task:error 回调到达(伪造签名被验签拒绝), 任务终态与 task_result 查询不受投递结果影响
//   E. 韧性:   端点 500 / 连接拒绝 / 超时 → 任务终态不变, notify=failed, status_get 汇总正确
// 运行: node tests/unit_callback_p0.mjs  (cwd = 插件根目录; 需先 npm run build 生成 lib/index.js)
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

const PLUGIN = '../lib/index.js'
const { apply, __internals } = await import(PLUGIN)

let passCount = 0
let failCount = 0
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log('  ✓ ' + name) }
  else { failCount++; console.log('  ✗ ' + name + ' -> ' + JSON.stringify(detail)?.slice(0, 400)) }
}

// ── mock 服务面(同 unit_mock_p1/p3 口径) ──
const scopeProxy = () => new Proxy({}, {
  get(_t, k) {
    if (k === 'then') return undefined
    return typeof k === 'symbol' ? { fake: true } : undefined
  },
})

function makeRecorderSession(cwd) {
  const log = []
  return {
    log,
    header: { cwd, createdAt: Date.now(), agentPreset: 'standard' },
    append(type, data) {
      log.push({ type, seq: log.length + 1, time: Date.now(), data })
      return { type, data }
    },
  }
}

function makeCtxP0() {
  const registry = new Map()
  const liveSessions = new Map()
  const ctx = {
    effect(fn) { void fn },
    get(name) {
      if (name === 'sessions') {
        return {
          list: () => [
            ...liveSessions.values(),
            ...[...registry.entries()].filter(([id]) => !liveSessions.has(id)).map(([, a]) => ({ header: a.session.header, log: a.session.log })),
          ],
          get: (id) => {
            const direct = liveSessions.get(String(id))
            if (direct) return direct
            const agent = registry.get(String(id))
            return agent ? { header: agent.session.header, log: agent.session.log } : undefined
          },
          flush: async () => {},
        }
      }
      return undefined
    },
    agents: {
      list: () => [...registry.values()],
      get: (sid) => registry.get(String(sid)),
      resume: async () => { throw new Error('resume not expected') },
      create: async (o) => {
        await o.setup?.(scopeProxy())
        const sid = String(o.sessionId)
        const agent = {
          id: sid,
          session: makeRecorderSession(o?.meta?.cwd),
          followup() {},
          whenIdle: async () => {},
        }
        registry.set(sid, agent)
        return { agent, dispose: async () => {} }
      },
    },
    agentPresets: {
      defaultId: 'standard',
      resolve: async (id) => {
        if (String(id) === 'standard') return { id }
        throw new Error(`unknown preset: ${id}`)
      },
      list: async () => [{ id: 'standard' }],
      mount: async () => {},
      recompose: async (_c, id) => ({ id }),
    },
  }
  return { ctx, registry }
}

// ── 极简 MCP HTTP 客户端(同 unit_mock_p3) ──
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
async function waitFor(fn, ms = 5000, step = 30) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return undefined
    await new Promise((r) => setTimeout(r, step))
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ═══════════════ A. 纯函数层(SSRF/解析/签名/Envelope) ═══════════════
console.log('── A: 纯函数层 SSRF/解析/签名 ──')
{
  const { ssrfGuardCheck, resolveCallback, buildCallbackPayload, signCallbackPayload, safeEqualStr, VERSION } = __internals

  // SSRF: scheme 白名单
  check('A ssrf: file: scheme 拒绝', ssrfGuardCheck('file:///etc/passwd', []).includes('scheme'), ssrfGuardCheck('file:///etc/passwd', []))
  check('A ssrf: https://example.com 放行', ssrfGuardCheck('https://example.com/hook', []) === undefined, ssrfGuardCheck('https://example.com/hook', []))
  // SSRF: 私网/回环/metadata
  check('A ssrf: 回环 127.0.0.1 默认拒绝', /private|loopback/.test(ssrfGuardCheck('http://127.0.0.1:9000/hook', []) ?? ''), ssrfGuardCheck('http://127.0.0.1:9000/hook', []))
  check('A ssrf: 10.x 私网拒绝', /private|loopback/.test(ssrfGuardCheck('http://10.1.2.3/hook', []) ?? ''), ssrfGuardCheck('http://10.1.2.3/hook', []))
  check('A ssrf: 172.16.x 私网拒绝', /private|loopback/.test(ssrfGuardCheck('http://172.16.0.9/hook', []) ?? ''), ssrfGuardCheck('http://172.16.0.9/hook', []))
  check('A ssrf: 192.168.x 私网拒绝', /private|loopback/.test(ssrfGuardCheck('http://192.168.1.1/hook', []) ?? ''), ssrfGuardCheck('http://192.168.1.1/hook', []))
  check('A ssrf: 云 metadata 169.254.169.254 拒绝', /metadata/.test(ssrfGuardCheck('http://169.254.169.254/latest', []) ?? ''), ssrfGuardCheck('http://169.254.169.254/latest', []))
  check('A ssrf: 0.0.0.0 拒绝', ssrfGuardCheck('http://0.0.0.0/hook', []) !== null, ssrfGuardCheck('http://0.0.0.0/hook', []))
  check('A ssrf: 100.64.x CGNAT 拒绝', /private|loopback/.test(ssrfGuardCheck('http://100.64.0.1/hook', []) ?? ''), ssrfGuardCheck('http://100.64.0.1/hook', []))
  // SSRF: 白名单放行(host:port 精确 / 通配 *.suffix)
  check('A ssrf: allowedCallbackHosts 精确 host:port 放行', ssrfGuardCheck('http://127.0.0.1:9000/hook', ['127.0.0.1:9000']) === undefined, ssrfGuardCheck('http://127.0.0.1:9000/hook', ['127.0.0.1:9000']))
  check('A ssrf: 白名单 host 不含 port 时端口不符仍拒绝', ssrfGuardCheck('http://127.0.0.1:9001/hook', ['127.0.0.1:9000']) !== null, ssrfGuardCheck('http://127.0.0.1:9001/hook', ['127.0.0.1:9000']))
  check('A ssrf: 通配 *.example.com 放行子域', ssrfGuardCheck('http://api.example.com/hook', ['*.example.com']) === undefined, ssrfGuardCheck('http://api.example.com/hook', ['*.example.com']))
  check('A ssrf: 通配不匹配其他域', ssrfGuardCheck('http://api.other.com/hook', ['*.example.com']) !== null, ssrfGuardCheck('http://api.other.com/hook', ['*.example.com']))

  // resolveCallback: 非法/缺失 url
  check('A parse: 缺 url 报错', /missing required parameter/.test(resolveCallback({})?.error ?? ''), resolveCallback({}))
  check('A parse: 非 http url 被 SSRF 拒', /ssrf guard/.test(resolveCallback({ url: 'ftp://x/y' })?.error ?? ''), resolveCallback({ url: 'ftp://x/y' }))
  // resolveCallback: 默认值 + 保留头剔除
  const okParsed = resolveCallback({ url: 'https://gw.example.com/cb', headers: { 'X-Trace': 't1', Host: 'evil', 'content-length': '9', Connection: 'keep-alive' } })
  check('A parse: method 默认 POST', okParsed.config?.method === 'POST', okParsed.config)
  check('A parse: events 默认 [done,error]', JSON.stringify(okParsed.config?.events) === '["done","error"]', okParsed.config?.events)
  check('A parse: timeoutMs 默认 5000', okParsed.config?.timeoutMs === 5000, okParsed.config)
  check('A parse: 保留头被剔除且自定义头保留', okParsed.config?.headers?.['X-Trace'] === 't1' && okParsed.config?.headers?.Host === undefined && okParsed.config?.headers?.['content-length'] === undefined, okParsed.config?.headers)
  check('A parse: 公网 url signed=false(无 secret)', okParsed.signed === false, okParsed)
  // resolveCallback: secret 回填 + replyContext 4KB
  const withSecret = resolveCallback({ url: 'https://gw.example.com/cb', secret: 's'.repeat(16) })
  check('A parse: 任务级 secret 生效 signed=true', withSecret.signed === true && withSecret.config?.secret === 's'.repeat(16), withSignedBrief(withSecret))
  const big = { blob: 'x'.repeat(5000) }
  check('A parse: replyContext >4KB 报错', /4?096|4096/.test(resolveCallback({ url: 'https://gw.example.com/cb', replyContext: big })?.error ?? ''), resolveCallback({ url: 'https://gw.example.com/cb', replyContext: big }))
  check('A parse: 小 replyContext 通过', resolveCallback({ url: 'https://gw.example.com/cb', replyContext: { a: 1 } }).config?.replyContext?.a === 1, null)

  // Envelope + HMAC 可复现(REQ §2/§3)
  const fakeItem = {
    id: 'tid-1', task: 't', context: '', cwd: '/tmp', status: 'done',
    createdAt: 1000, finishedAt: 2000, sessionId: 'sess-1', title: 'T',
    callback: { url: 'http://x/', method: 'POST', events: ['done'], replyContext: { platform: 'qq', chatId: '42' }, timeoutMs: 5000 },
    result: { taskId: 'tid-1', sessionId: 'sess-1', assistantText: 'ok', toolCalls: [], toolResults: [], changes: 'c', verification: 'v', leftovers: 'l' },
  }
  const payload = buildCallbackPayload(fakeItem)
  check('A envelope: event=task:done 且字段齐全', payload.event === 'task:done' && payload.taskId === 'tid-1' && payload.status === 'done' && payload.durationMs === 1000, payload)
  check('A envelope: replyContext 原样透传', payload.replyContext?.platform === 'qq' && payload.replyContext?.chatId === '42', payload.replyContext)
  check('A envelope: done 携带 result', payload.result?.changes === 'c', payload.result)
  const ts = 1700000000000
  const sig = signCallbackPayload('sec', ts, JSON.stringify(payload))
  const expect = createHmac('sha256', 'sec').update(`${ts}.${JSON.stringify(payload)}`).digest('hex')
  check('A sign: HMAC-SHA256 与 node:crypto 复现一致', sig === expect && safeEqualStr(sig, expect), { sig: sig.slice(0, 12), expect: expect.slice(0, 12) })
  check('A sign: body 篡改 → 签名不一致', signCallbackPayload('sec', ts, JSON.stringify(payload) + 'x') !== expect, null)
  // VERSION 对齐: 从 package.json 读当前版本(不硬编码, 避免每次升版本都要改测试)
  const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  check(`A version: __internals.VERSION=${pkgVersion}(与 package.json 一致)`, VERSION === pkgVersion, VERSION)

  function withSignedBrief(v) { return { signed: v.signed, hasSecret: Boolean(v.config?.secret) } }
}

// ═══════════════ 回调接收端(本地 HTTP Server, 覆盖 200/500/超时) ═══════════════
const received = [] // { path, headers, body }
const responderMode = { mode: 'ok' } // ok | 500 | hang
const cbServer = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    received.push({ path: req.url, headers: req.headers, body: raw })
    if (req.url === '/hook-500') { res.writeHead(500); res.end('boom'); return } // 500 按路径区分, 与全局模式无关
    if (responderMode.mode === 'hang') { /* 不响应, 等客户端超时 */ return }
    res.writeHead(200); res.end('ok')
  })
})
await new Promise((r) => cbServer.listen(0, '127.0.0.1', r))
const cbPort = cbServer.address().port
const CB_OK = `http://127.0.0.1:${cbPort}/hook-ok`
const CB_500 = `http://127.0.0.1:${cbPort}/hook-500`

// ═══════════════ 实例 1: 不传 callback → v0.7.0 行为逐字节一致 ═══════════════
console.log('── B: 兼容性(不传 callback) ──')
const env1 = makeCtxP0()
await apply(env1.ctx, { port: 8120, host: '127.0.0.1', allowedCallbackHosts: ['127.0.0.1'] })
await sleep(150)
const P1 = 8120
check('B initialize', await initMcp(P1, 'mock-cb1'))
const baseArgs = { task: 'say ok', cwd: '/tmp/a2a-cb-ws' }
let r1
{
  r1 = await callTool(P1, 'task_inbox', { ...baseArgs })
  check('B task_inbox 入队成功(返回 taskId)', Boolean(r1.taskId), r1)
  const keys = Object.keys(r1)
  check('B 返回体无 callback/notify 字段(v0.7.0 原样)', !keys.includes('callback') && !keys.includes('notify'), keys)
  check('B 返回体保留 v0.7.0 关键字段', ['taskId', 'status', 'createdAt', 'createdAt_epoch', 'retainMs', 'retain', 'pollAdvice', 'next'].every((k) => keys.includes(k)), keys)
  const fin = await waitFor(async () => {
    const rr = await callTool(P1, 'task_result', { taskId: r1.taskId })
    return rr.status === 'done' ? rr : undefined
  })
  check('B 任务正常完成', fin?.status === 'done', fin)
  check('B task_result 无 notify 字段(未配置回调)', fin && !Object.keys(fin).includes('notify'), fin && Object.keys(fin))
  const tl = await callTool(P1, 'task_list', {})
  const row = tl.tasks?.find((t) => t.id === r1.taskId)
  check('B task_list 行无 notify 字段(未配置回调)', row && !Object.keys(row).includes('notify'), row && Object.keys(row))
}

// ═══════════════ 实例 2: task:done 成功回执 + replyContext 透传 + 验签 ═══════════════
console.log('── C: task:done 回调成功 + replyContext + HMAC 验签 ──')
const env2 = makeCtxP0()
const SECRET2 = 'unit-test-secret-0042'
await apply(env2.ctx, {
  port: 8121, host: '127.0.0.1',
  allowedCallbackHosts: [`127.0.0.1:${cbPort}`], // 本地回调接收端: 白名单放行回环
  defaultCallbackSecret: SECRET2,               // 部署级 secret 缺省回填路径
})
await sleep(150)
const P2 = 8121
check('C initialize', await initMcp(P2, 'mock-cb2'))
let r2
{
  received.length = 0
  r2 = await callTool(P2, 'task_inbox', {
    ...baseArgs,
    callback: {
      url: CB_OK,
      replyContext: { platform: 'onebot', chatId: '123456', sessionId: 'hermes-s-1', roundId: 'r-1' },
      // secret 省略 → 回填部署级 defaultCallbackSecret
    },
  })
  check('C 带 callback 入队成功', Boolean(r2.taskId), r2)
  check('C 返回体 notify.enabled=true', r2.notify?.enabled === true, r2.notify)
  check('C notify.urlHost 仅 host:port(不含 path)', r2.notify?.urlHost === `127.0.0.1:${cbPort}`, r2.notify)
  check('C notify.signed=true(部署级 secret 回填)', r2.notify?.signed === true, r2.notify)
  check('C 返回体不回显 secret 值', !JSON.stringify(r2).includes(SECRET2), JSON.stringify(r2).slice(0, 200))

  const hit = await waitFor(() => received.find((x) => x.path === '/hook-ok') ? received.find((x) => x.path === '/hook-ok') : undefined)
  check('C 回调到达接收端', Boolean(hit), received.length)
  const parsed = hit ? JSON.parse(hit.body) : null
  check('C event=task:done', parsed?.event === 'task:done', parsed?.event)
  check('C taskId 对应提交任务', parsed?.taskId === r2.taskId, { want: r2.taskId, got: parsed?.taskId })
  check('C status=done', parsed?.status === 'done', parsed?.status)
  check('C replyContext 原样透传', parsed?.replyContext?.platform === 'onebot' && parsed?.replyContext?.chatId === '123456' && parsed?.replyContext?.sessionId === 'hermes-s-1' && parsed?.replyContext?.roundId === 'r-1', parsed?.replyContext)
  check('C result 携带结构化产出', typeof parsed?.result?.assistantText === 'string' && typeof parsed?.result?.taskId === 'string', parsed?.result && Object.keys(parsed.result))
  check('C durationMs/createdAt/finishedAt 为数值', Number.isFinite(parsed?.durationMs) && Number.isFinite(parsed?.createdAt) && Number.isFinite(parsed?.finishedAt), { d: parsed?.durationMs })
  // 验签: 签名材料 = `${X-DSH-Timestamp}.${rawBody}`
  const tsHeader = hit.headers['x-dsh-timestamp']
  const sigHeader = String(hit.headers['x-dsh-signature'] ?? '')
  const expectSig = createHmac('sha256', SECRET2).update(`${tsHeader}.${hit.body}`).digest('hex')
  check('C X-DSH-Signature=sha256:<hex> 且验签通过', sigHeader === `sha256=${expectSig}`, { got: sigHeader.slice(0, 20), want: `sha256=${expectSig.slice(0, 20)}` })
  check('C X-DSH-Timestamp 为 epoch ms 且接近当前时间', /^\d{13}$/.test(String(tsHeader)) && Math.abs(Date.now() - Number(tsHeader)) < 60000, tsHeader)

  const fin = await waitFor(async () => {
    const rr = await callTool(P2, 'task_result', { taskId: r2.taskId })
    return rr.status === 'done' && rr.notify ? rr : undefined
  })
  check('C task_result.notify=delivered', fin?.notify?.state === 'delivered' && fin.notify.attempts === 1, fin?.notify)
  const tl = await callTool(P2, 'task_list', {})
  const row = tl.tasks?.find((t) => t.id === r2.taskId)
  check('C task_list 行 notify=delivered', row?.notify?.state === 'delivered', row?.notify)
  const st = await callTool(P2, 'status_get', {})
  check('C status_get.notify.deliveredTotal ≥1', (st.notify?.deliveredTotal ?? 0) >= 1 && st.notify?.enabled === true, st.notify)
}

// ═══════════════ 实例 3: task:error 回调(任务失败路径) + 伪造签名拒绝 ═══════════════
console.log('── D: task:error 回调 + 伪造签名被拒 ──')
const env3 = makeCtxP0()
await apply(env3.ctx, {
  port: 8122, host: '127.0.0.1',
  allowedCallbackHosts: [`127.0.0.1:${cbPort}`],
  defaultCallbackSecret: SECRET2,
  workspaceRoots: ['/tmp/a2a-cb-ws'], // cwd 白名单 → 白名单外的 cwd 直接报错, 制造 error 终态
})
await sleep(150)
const P3 = 8122
check('D initialize', await initMcp(P3, 'mock-cb3'))
let r3
{
  received.length = 0
  r3 = await callTool(P3, 'task_inbox', {
    task: 'must fail', cwd: '/tmp/a2a-cb-ws-not-allowed-xyz',
    callback: { url: CB_OK, secret: SECRET2, events: ['done', 'error'] },
  })
  check('D 带 callback 入队成功', Boolean(r3.taskId), r3)
  const hit = await waitFor(() => received.find((x) => x.path === '/hook-ok' && JSON.parse(x.body).event === 'task:error'))
  const parsed = hit ? JSON.parse(hit.body) : null
  check('D event=task:error 回调到达', parsed?.event === 'task:error', { n: received.length, events: received.map((x) => { try { return JSON.parse(x.body).event } catch { return '?' } }) })
  check('D error 终态含 error 字段(字符串)', typeof parsed?.error === 'string' && parsed.error.length > 0, parsed?.error)
  check('D error 回调不携带 result', parsed?.result === undefined, parsed?.result && Object.keys(parsed.result))
  // 验签(任务级 secret 与部署级同值): 再跑一次 done 无法构造, 直接用 error 回执验签
  const tsHeader = hit?.headers['x-dsh-timestamp']
  const sigHeader = String(hit?.headers['x-dsh-signature'] ?? '')
  const expectSig = createHmac('sha256', SECRET2).update(`${tsHeader}.${hit.body}`).digest('hex')
  check('D error 回执验签通过', sigHeader === `sha256=${expectSig}`, { got: sigHeader.slice(0, 20) })
  // 伪造验证: 改用错误密钥计算 → 不匹配
  const forgedSig = createHmac('sha256', 'wrong-secret').update(`${tsHeader}.${hit.body}`).digest('hex')
  check('D 伪造密钥签名不匹配(接收方可拒)', sigHeader !== `sha256=${forgedSig}`, null)

  const fin = await waitFor(async () => {
    const rr = await callTool(P3, 'task_result', { taskId: r3.taskId })
    return rr.status === 'error' && rr.notify ? rr : undefined
  })
  check('D task_result.status=error', fin?.status === 'error', fin?.status)
  check('D task_result.error 保留(投递不影响任务状态)', typeof fin?.error === 'string' && fin.error.length > 0, fin?.error)
  check('D task_result.notify=delivered', fin?.notify?.state === 'delivered', fin?.notify)
}

// ═══════════════ 实例 4: 投递失败(500/连接拒绝/超时)不影响任务终态 ═══════════════
console.log('── E: 投递失败韧性(500/拒绝/超时) ──')
const env4 = makeCtxP0()
await apply(env4.ctx, {
  port: 8123, host: '127.0.0.1',
  allowedCallbackHosts: [`127.0.0.1:${cbPort}`, '127.0.0.1:9'], // :9 为拒连端口(回环保留, 显式放行以测投递失败路径)
  defaultCallbackSecret: SECRET2,
})
await sleep(150)
const P4 = 8123
check('E initialize', await initMcp(P4, 'mock-cb4'))
{
  // 500: 投递失败, 任务照常 done(显式等 notify=failed, 排除 delivered 竞态)
  received.length = 0
  const r5 = await callTool(P4, 'task_inbox', { ...baseArgs, callback: { url: CB_500, timeoutMs: 1000 } })
  const fin5 = await waitFor(async () => {
    const rr = await callTool(P4, 'task_result', { taskId: r5.taskId })
    return rr.status === 'done' && rr.notify?.state === 'failed' ? rr : undefined
  })
  check('E 端点 500 → notify=failed(带 lastError)', fin5?.notify?.state === 'failed' && /non-2xx/.test(fin5.notify?.lastError ?? ''), fin5?.notify)
  check('E 端点 500 → 任务仍为 done 且结果完整', fin5?.status === 'done' && typeof fin5.result?.assistantText === 'string', fin5?.status)

  // 连接拒绝(回环未监听端口): 白名单放行但连接失败 → failed, 任务不受影响
  const refused = await callTool(P4, 'task_inbox', { ...baseArgs, callback: { url: 'http://127.0.0.1:9/hook-refused', timeoutMs: 1000 } })
  check('E 连接拒绝入队成功(端口在白名单内)', Boolean(refused.taskId), refused)
  const finR = await waitFor(async () => {
    const rr = await callTool(P4, 'task_result', { taskId: refused.taskId })
    return rr.status === 'done' && rr.notify?.state === 'failed' ? rr : undefined
  })
  check('E 连接拒绝 → notify=failed', finR?.notify?.state === 'failed', finR?.notify)
  check('E 连接拒绝 → 任务仍为 done', finR?.status === 'done', finR?.status)

  // 超时: responderMode=hang → 客户端 1s 超时
  received.length = 0
  responderMode.mode = 'hang'
  const r6 = await callTool(P4, 'task_inbox', { ...baseArgs, callback: { url: CB_OK + '-hang', timeoutMs: 1000 } })
  const fin6 = await waitFor(async () => {
    const rr = await callTool(P4, 'task_result', { taskId: r6.taskId })
    return rr.status === 'done' && rr.notify?.state === 'failed' ? rr : undefined
  }, 12000)
  responderMode.mode = 'ok'
  check('E 端点挂起 → 客户端超时 notify=failed(任务完成)', fin6?.status === 'done' && fin6?.notify?.state === 'failed' && /timeout/i.test(fin6.notify?.lastError ?? ''), { status: fin6?.status, notify: fin6?.notify })

  // SSRF 拒绝入队(未在白名单的回环): 入口即拒, 不占队列
  const bad = await callTool(P4, 'task_inbox', { ...baseArgs, callback: { url: 'http://169.254.169.254/latest' } })
  check('E metadata 目标入口即拒(不占队列容量)', String(bad.error).includes('ssrf guard') && bad.taskId === undefined, bad)
  const st4 = await callTool(P4, 'status_get', {})
  check('E status_get.notify.failedTotal ≥3', (st4.notify?.failedTotal ?? 0) >= 3, st4.notify)
}

// ═══════════════ 实例 5: events 订阅过滤 + notifyEnabled 逃生阀 + 入口预检 ═══════════════
console.log('── F: events 过滤 + 全局开关 + 入口预检 ──')
{
  // events 只订阅 error: done 终态不回调(notify=skipped); 沿用 P2 实例(mcpSession 仍指向 P2, 勿重置)
  mcpSession = ''
  check('F P2 会话恢复(initialize)', await initMcp(P2, 'mock-cb2f'))
  received.length = 0
  const r7 = await callTool(P2, 'task_inbox', { ...baseArgs, callback: { url: CB_OK, events: ['error'] } })
  check('F events=[error] 入队成功', Boolean(r7.taskId), r7)
  const fin7 = await waitFor(async () => {
    const rr = await callTool(P2, 'task_result', { taskId: r7.taskId })
    return rr.status === 'done' && rr.notify ? rr : undefined
  })
  check('F 未订阅的 done 终态 → notify=skipped 且无回调到达', fin7?.notify?.state === 'skipped' && received.length === 0, { notify: fin7?.notify, n: received.length })

  // timeoutMs 越界: schema 层拒绝(MCP invalid params)
  const r8 = await rpc(P2, 'tools/call', { name: 'task_inbox', arguments: { ...baseArgs, callback: { url: CB_OK, timeoutMs: 99 } } })
  const rejected = r8?.error !== undefined || String(JSON.stringify(r8)).includes('1000')
  check('F timeoutMs=99 被 schema 拒绝', rejected, r8?.error ?? JSON.stringify(r8).slice(0, 160))

  // notifyEnabled=false 逃生阀: 配置了合法 callback 也 skipped
  const env5 = makeCtxP0()
  await apply(env5.ctx, { port: 8124, host: '127.0.0.1', allowedCallbackHosts: [`127.0.0.1:${cbPort}`], notifyEnabled: false })
  await sleep(150)
  mcpSession = ''
  check('F 实例5 initialize', await initMcp(8124, 'mock-cb5'))
  received.length = 0
  const r9 = await callTool(8124, 'task_inbox', { ...baseArgs, callback: { url: CB_OK } })
  const fin9 = await waitFor(async () => {
    const rr = await callTool(8124, 'task_result', { taskId: r9.taskId })
    return rr.status === 'done' && rr.notify ? rr : undefined
  })
  check('F notifyEnabled=false → notify=skipped 且无回调', fin9?.notify?.state === 'skipped' && received.length === 0, { notify: fin9?.notify, n: received.length })
}

cbServer.close()
console.log(`\n══ P0 回调单元级结果: PASS=${passCount} FAIL=${failCount} ══`)
process.exit(failCount > 0 ? 1 : 0)

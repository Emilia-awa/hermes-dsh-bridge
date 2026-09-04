// P3 单元级集成测试(v0.6.0): 用 mock ctx 直接驱动插件的 apply(),
// 覆盖权限三档 + 审批桥 + 状态暴露:
//   A: 三档参数透传(create/resume 种 sandbox/mode)、invalid 拒绝、池防污染
//      (请求档≠会话固化档不复用 / 非默认档不入池 / 默认调用不受污染)、set_policy live/冷会话
//   B: 审批桥 web 主路径(mux 帧→approval_list→approval_respond→apiProxy.respond 载荷断言)、
//      resolved 帧同步摘除、双通道先答者胜(not-pending 竞态)、超时收尾(builtin=cancelled,
//      绝不超时放行)、降级 builtin 自注册 answerer(asked/decided 扫描 + settle)、approvalsBridge=off
//   C: status_get.sandboxPolicy{defaultMode,bridge,pendingApprovals}、policy_get(override/default/
//      不存在)、config_get 新字段、session_list 行 sandboxMode、task_inbox/task_list sandbox 回显
// 运行: node tests/unit_mock_p3.mjs
//   目标选择: lib/index.js 版本 ≥ src 时直接测 lib(CI 构建后即此路径); lib 落后(本地未构建)则
//   注册 p3_ts_loader.mjs 现场 strip 类型加载 src —— 不写任何临时文件。
import { readFileSync } from 'node:fs'

let passCount = 0
let failCount = 0
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log('  ✓ ' + name) }
  else { failCount++; console.log('  ✗ ' + name + ' -> ' + JSON.stringify(detail)?.slice(0, 400)) }
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

import { mkdirSync, realpathSync } from 'node:fs'

// ── mock 服务面 ──
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

/**
 * 构造 P3 mock ctx:
 * - opts.apiProxy: 注入假 apiProxy(web 桥路径); 缺省不注入(builtin/off 降级路径)。
 *   dsh 0.1.2 起插件改用 ctx.get('apiProxy', false) 宽松读取(不再允许直接读 ctx.apiProxy 属性),
 *   所以 mock 把服务放进 services 表、由 get() 按名分发 —— 与真实 cordis 宿主同构。
 * - opts.hangWhenIdle: agent whenIdle 挂起(未用, 预留)
 * - ctx.on 收集器: 记录插件注册的事件应答器('approval/request' 等), 测试手工触发
 */
function makeCtxP3(opts = {}) {
  const calls = {
    mount: [], createPresets: [], resume: [], flush: [], dispose: [],
    on: [], respondCalls: [],
  }
  const registry = new Map()   // sessionId -> fake agent(append 可写会话)
  const liveSessions = new Map() // sessions store: id -> {header, log}
  const persisted = new Map()  // id -> {meta, events}
  const resumed = new Map()    // resume 出来的 recorder 会话(断言 resume 种档用)
  const services = new Map()   // cordis 服务表(get('apiProxy', false) 等按名读取)
  if (opts.apiProxy) services.set('apiProxy', opts.apiProxy)

  const ctx = {
    effect(fn) { void fn },
    on(event, handler) { calls.on.push([event, handler]) },
    get(name) {
      if (name === 'apiProxy') return services.get('apiProxy')
      if (name === 'sessions') {
        return {
          // 真实 dsh 里 agent 会话就是 attached session: store.get/list 兜底并入 registry 的会话
          list: () => [
            ...liveSessions.values(),
            ...[...registry.entries()].filter(([id]) => !liveSessions.has(id)).map(([, a]) => ({ header: a.session.header, log: a.session.log })),
          ],
          get: (id) => {
            const direct = liveSessions.get(String(id))
            if (direct) return direct
            const agent = registry.get(String(id))
            if (agent) return { header: agent.session.header, log: agent.session.log }
            return undefined
          },
          flush: async (s) => { calls.flush.push(String(s?.id ?? '?')) },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          list: async () => [...persisted.values()].map((v) => v.meta),
          inspect: async (sid) => {
            const v = persisted.get(String(sid))
            if (!v) throw new Error('not persisted: ' + String(sid))
            return { meta: v.meta, events: v.events }
          },
        }
      }
      if (name === 'settings') return { mutate: async () => {} }
      return undefined
    },
    agents: {
      list: () => [...registry.values()],
      get: (sid) => registry.get(String(sid)),
      resume: async (o) => {
        calls.resume.push(String(o.resumeSessionId))
        await o.setup?.(scopeProxy())
        const session = makeRecorderSession('/tmp/p3-resume')
        resumed.set(String(o.resumeSessionId), session)
        return { agent: { id: String(o.resumeSessionId), session, followup() {}, whenIdle: async () => {} }, dispose: async () => { calls.dispose.push(String(o.resumeSessionId)) } }
      },
      create: async (o) => {
        calls.createPresets.push(o?.meta?.agentPreset)
        await o.setup?.(scopeProxy())
        const sid = String(o.sessionId)
        const agent = {
          id: sid,
          status: 'idle',
          session: makeRecorderSession(o?.meta?.cwd),
          followup() {},
          whenIdle: async () => {},
        }
        registry.set(sid, agent)
        return { agent, dispose: async () => { calls.dispose.push(sid) } }
      },
    },
    agentPresets: {
      defaultId: 'standard',
      resolve: async (id) => {
        if (['standard', 'code', 'minimal'].includes(String(id))) return { id }
        const err = new Error(`unknown preset: ${id}`)
        err.available = ['standard', 'code', 'minimal']
        throw err
      },
      list: async () => [{ id: 'standard' }, { id: 'code' }, { id: 'minimal' }],
      mount: async (_c, id) => { calls.mount.push(id) },
      recompose: async (_c, id) => ({ id }),
    },
  }
  return { ctx, calls, registry, liveSessions, persisted, resumed, services }
}

/** 假 apiProxy: events.mux 异步生成器(测试用 push/broadcast 投帧) + respond(rpcId 挂起表校验, 照真实实现语义) */
function makeFakeApiProxy(calls) {
  let pushSeq = 0
  const queues = [] // 每个 mux 订阅一个 q = {items:[], wake}
  const pendingByRpc = new Map() // rpcId -> {sessionId, approvalId}
  const broadcast = (payload, rpcId) => {
    const msg = { rpcId: rpcId ?? `push-${++pushSeq}`, payload }
    for (const q of queues) { q.items.push(msg); q.wake?.(); q.wake = null }
    return msg.rpcId
  }
  const proxy = {
    events: {
      mux: async function* (_request, signal) {
        const q = { items: [], wake: null }
        queues.push(q)
        signal?.addEventListener('abort', () => { q.wake?.(); q.wake = null }, { once: true })
        try {
          for (;;) {
            if (q.items.length === 0) {
              await new Promise((res) => { q.wake = res })
              continue
            }
            yield q.items.shift()
          }
        } finally {
          const i = queues.indexOf(q)
          if (i >= 0) queues.splice(i, 1)
        }
      },
    },
    respond: async (message) => {
      calls.respondCalls.push(message)
      const p = pendingByRpc.get(message.rpcId)
      if (!p) return { accepted: false, reason: 'not-pending' }
      const v = message?.result?.value ?? {}
      if (message.result?.ok !== true || v.approvalId !== p.approvalId || v.sessionId !== p.sessionId) {
        return { accepted: false, reason: 'bad-response' }
      }
      pendingByRpc.delete(message.rpcId)
      broadcast({ type: 'approval/resolved', sessionId: v.sessionId, approvalId: v.approvalId, outcome: v.outcome })
      return { accepted: true }
    },
    /** 投一帧(requested 帧带稳定 rpcId 并登记挂起表, 其余为纯 push) */
    push(payload, rpcId) {
      const id = payload.type === 'approval/requested' ? (rpcId ?? `rpc-${++pushSeq}`) : (rpcId ?? `push-${++pushSeq}`)
      if (payload.type === 'approval/requested') {
        pendingByRpc.set(id, { sessionId: payload.sessionId, approvalId: payload.approvalId })
      }
      const msg = { rpcId: id, payload }
      for (const q of queues) { q.items.push(msg); q.wake?.(); q.wake = null }
      return id
    },
  }
  void broadcast // resolved 帧由 respond 内部广播; 外部模拟 Web UI 先答时用 push(resolved 帧)
  return proxy
}

// ── 极简 MCP HTTP 客户端(同 unit_mock_p1/p2) ──
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

const WS = '/tmp/a2a-ws-mock-p3'
mkdirSync(WS, { recursive: true })
const WS_REAL = realpathSync(WS)

// ═══════════════ 实例 W: web 桥(fake apiProxy) ═══════════════
console.log('── 实例W: web 桥 + 三档参数 + 池防污染 + set_policy/policy_get ──')
const envW = makeCtxP3({}) // 先建 ctx(拿到 calls 记录器), 再把假 apiProxy 挂进服务表
const fakeW = makeFakeApiProxy(envW.calls)
envW.services.set('apiProxy', fakeW) // apply 前挂载即可: 桥在 apply 时 ctx.get('apiProxy', false) 读取
await apply(envW.ctx, { port: 8110, host: '127.0.0.1' })
await sleep(150)
const PW = 8110
check('W initialize', await initMcp(PW, 'mock-p3w'))

{
  const t = await rpc(PW, 'tools/list', {})
  const names = t.result.tools.map((x) => x.name)
  for (const n of ['set_policy', 'approval_list', 'approval_respond', 'policy_get']) {
    check(`W 新工具 ${n} 已注册`, names.includes(n), names)
  }
  const ar = t.result.tools.find((x) => x.name === 'agent_run')
  check('W agent_run schema 含 sandbox 枚举(三档)', JSON.stringify(ar?.inputSchema?.properties?.sandbox?.enum) === JSON.stringify(['read-only', 'workspace-write', 'danger-full-access']), ar?.inputSchema?.properties?.sandbox)
  const ti = t.result.tools.find((x) => x.name === 'task_inbox')
  check('W task_inbox schema 含 sandbox 枚举', Array.isArray(ti?.inputSchema?.properties?.sandbox?.enum) && ti.inputSchema.properties.sandbox.enum.length === 3, ti?.inputSchema?.properties?.sandbox)
  const sp = t.result.tools.find((x) => x.name === 'set_policy')
  check('W set_policy schema 含 mode 枚举', Array.isArray(sp?.inputSchema?.properties?.mode?.enum) && sp.inputSchema.properties.mode.enum.length === 3, sp?.inputSchema?.properties?.mode)
  check('W 工具总数 ≥ 25(21+4)', names.length >= 25, names.length)
}

{
  const st = await callTool(PW, 'status_get', {})
  check('W status_get.sandboxPolicy.defaultMode=workspace-write', st.sandboxPolicy?.defaultMode === 'workspace-write', st.sandboxPolicy)
  check('W status_get.sandboxPolicy.bridge=web', st.sandboxPolicy?.bridge === 'web', st.sandboxPolicy)
  check('W status_get.sandboxPolicy.pendingApprovals=0', st.sandboxPolicy?.pendingApprovals === 0, st.sandboxPolicy)
  check('W status_get.version=0.6.0', st.version === '0.6.0', st.version)
  const cg = await callTool(PW, 'config_get', {})
  check('W config_get 含 defaultSandbox/approvalsBridge/approvalTimeoutMs', cg.defaultSandbox === 'workspace-write' && cg.approvalsBridge === 'web' && cg.approvalTimeoutMs === 300000, { d: cg.defaultSandbox, b: cg.approvalsBridge, t: cg.approvalTimeoutMs })
}

// ── A: 三档透传 + 池防污染 ──
let S1
{
  const r1 = await callTool(PW, 'agent_run', { task: 't1', cwd: WS })
  S1 = r1.sessionId
  check('A 默认档 create 成功并回 sessionId', typeof S1 === 'string', r1)
  const seeded = envW.registry.get(S1)?.session.log.filter((e) => e.type === 'sandbox/mode') ?? []
  check('A 默认会话种 sandbox/mode=workspace-write', seeded.at(-1)?.data?.mode === 'workspace-write', seeded)
  check('A 未显式传 sandbox 时结果不回显字段', r1.sandbox === undefined, r1.sandbox)
  const c1 = envW.calls.createPresets.length
  const r2 = await callTool(PW, 'agent_run', { task: 't2', cwd: WS })
  check('A 同 cwd 二次调用复用池(不再 create)', envW.calls.createPresets.length === c1 && r2.sessionId === S1, { c: envW.calls.createPresets, r2: r2.sessionId })
}
{
  const c0 = envW.calls.createPresets.length
  const r3 = await callTool(PW, 'agent_run', { task: 't3', cwd: WS, sandbox: 'danger-full-access' })
  const seeded3 = envW.registry.get(r3.sessionId)?.session.log.filter((e) => e.type === 'sandbox/mode') ?? []
  check('A danger-full-access 新建专用会话并种档', envW.calls.createPresets.length === c0 + 1 && seeded3.at(-1)?.data?.mode === 'danger-full-access', { c: envW.calls.createPresets, seeded: seeded3 })
  check('A 结果回显 sandbox=danger-full-access', r3.sandbox === 'danger-full-access', r3.sandbox)
  const c1 = envW.calls.createPresets.length
  await callTool(PW, 'agent_run', { task: 't4', cwd: WS, sandbox: 'danger-full-access' })
  check('A 同档专用会话仍不复用(不入池再建)', envW.calls.createPresets.length === c1 + 1, envW.calls.createPresets)
  const c2 = envW.calls.createPresets.length
  const r5 = await callTool(PW, 'agent_run', { task: 't5', cwd: WS })
  check('A 默认调用不被污染仍复用原池', envW.calls.createPresets.length === c2 && r5.sessionId === S1, { c: envW.calls.createPresets, got: r5.sessionId })
  const c3 = envW.calls.createPresets.length
  await callTool(PW, 'agent_run', { task: 't6', cwd: WS, sandbox: 'read-only' })
  check('A 第三档 read-only 同样走专用会话', envW.calls.createPresets.length === c3 + 1, envW.calls.createPresets)
  const bad = await callTool(PW, 'agent_run', { task: 'x', cwd: WS, sandbox: 'god-mode' })
  const badRejected = Boolean(bad.error) || bad._rpcError !== undefined || /-32602|Invalid arguments/.test(String(bad._raw))
  check('A 非法档位被拒(schema 层或 handler 层)', badRejected, bad)
}

// ── B: web 桥审批流 ──
{
  fakeW.push({ type: 'approval/requested', sessionId: 'sess-web', approvalId: 'apr-1', toolName: 'bash', reason: 'write outside workspace' }, 'rpc-1')
  const listed = await waitFor(async () => {
    const l = await callTool(PW, 'approval_list', {})
    return l.count === 1 ? l : undefined
  })
  check('B mux requested 帧 → approval_list 可见', listed?.approvals?.[0]?.approvalId === 'apr-1' && listed.approvals[0].toolName === 'bash' && listed.approvals[0].reason === 'write outside workspace', listed)
  check('B 挂起条目带 sessionId 与 waitedMs', listed?.approvals?.[0]?.sessionId === 'sess-web' && typeof listed.approvals[0].waitedMs === 'number', listed?.approvals?.[0])
  check('B approval_list 上报 bridge=web/timeoutMs', listed?.bridge === 'web' && listed.timeoutMs === 300000, { b: listed?.bridge, t: listed?.timeoutMs })

  const resp = await callTool(PW, 'approval_respond', { approvalId: 'apr-1', sessionId: 'sess-web', outcome: 'allowed-once' })
  check('B approval_respond 回 accepted', resp.ok === true && resp.receipt === 'accepted', resp)
  const sent = envW.calls.respondCalls.at(-1)
  check('B apiProxy.respond 收到正确 client-response 载荷', sent?.type === 'client-response' && sent.rpcId === 'rpc-1'
    && sent.result?.ok === true && sent.result.value?.sessionId === 'sess-web' && sent.result.value?.approvalId === 'apr-1'
    && sent.result.value?.outcome === 'allowed-once', sent)

  // 双通道竞态 ①: 本桥答过后自己再答 → not-pending(先答者胜)
  fakeW.push({ type: 'approval/requested', sessionId: 'sess-web', approvalId: 'apr-2', toolName: 'fs_write' }, 'rpc-2')
  await waitFor(async () => (await callTool(PW, 'approval_list', {})).count === 1)
  const nBefore = envW.calls.respondCalls.length
  const w1 = await callTool(PW, 'approval_respond', { approvalId: 'apr-2', sessionId: 'sess-web', outcome: 'rejected' })
  const w2 = await callTool(PW, 'approval_respond', { approvalId: 'apr-2', sessionId: 'sess-web', outcome: 'allowed-once' })
  check('B 竞态: 第二路回答 receipt=not-pending', w1.ok === true && w2.ok === false && w2.receipt === 'not-pending', { w1, w2 })
  check('B 竞态: respond 只发出一次(rpc-2)', envW.calls.respondCalls.length === nBefore + 1 && envW.calls.respondCalls.at(-1).rpcId === 'rpc-2', envW.calls.respondCalls.at(-1))

  // 双通道竞态 ②: Web UI 先答(resolved 帧) → 挂起表同步摘除, Hermes 再答拿 not-pending 且不发 respond
  fakeW.push({ type: 'approval/requested', sessionId: 'sess-web', approvalId: 'apr-3', toolName: 'bash' }, 'rpc-3')
  await waitFor(async () => (await callTool(PW, 'approval_list', {})).count === 1)
  fakeW.push({ type: 'approval/resolved', sessionId: 'sess-web', approvalId: 'apr-3', outcome: 'rejected' })
  const emptied = await waitFor(async () => ((await callTool(PW, 'approval_list', {})).count === 0 ? true : undefined))
  check('B resolved 帧 → 挂起表同步摘除', Boolean(emptied), await callTool(PW, 'approval_list', {}))
  const nBefore3 = envW.calls.respondCalls.length
  const late = await callTool(PW, 'approval_respond', { approvalId: 'apr-3', sessionId: 'sess-web', outcome: 'allowed-once' })
  check('B Web UI 先答后 Hermes 补答 → not-pending 且不再发 respond', late.ok === false && late.receipt === 'not-pending' && envW.calls.respondCalls.length === nBefore3, late)

  const wrongSess = await callTool(PW, 'approval_respond', { approvalId: 'apr-1', sessionId: 'other-session', outcome: 'rejected' })
  check('B 不存在的审批 → not-pending(先于归属校验)', wrongSess.ok === false && wrongSess.receipt === 'not-pending', wrongSess)
  // 归属校验: 挂起中的审批用错误 sessionId 回答 → mismatch 明确报错且条目保留
  fakeW.push({ type: 'approval/requested', sessionId: 'sess-web', approvalId: 'apr-m', toolName: 'bash' }, 'rpc-m')
  await waitFor(async () => (await callTool(PW, 'approval_list', {})).count === 1)
  const mismatch = await callTool(PW, 'approval_respond', { approvalId: 'apr-m', sessionId: 'other-session', outcome: 'rejected' })
  check('B sessionId 归属不一致明确报错且条目保留', /mismatch/.test(String(mismatch.error))
    && (await callTool(PW, 'approval_list', {})).count === 1, mismatch)
  fakeW.push({ type: 'approval/resolved', sessionId: 'sess-web', approvalId: 'apr-m', outcome: 'rejected' })
  await waitFor(async () => ((await callTool(PW, 'approval_list', {})).count === 0 ? true : undefined))

  const st = await callTool(PW, 'status_get', {})
  check('B status_get.pendingApprovals 反映挂起数(0)', st.sandboxPolicy?.pendingApprovals === 0, st.sandboxPolicy)
}

// ── C: policy_get / set_policy / session_list 行 ──
{
  const pgDefault = await callTool(PW, 'policy_get', {})
  check('C policy_get 无参返回部署默认', pgDefault.sandboxMode === 'workspace-write' && pgDefault.source === 'default' && pgDefault.approvalPolicy === 'ask', pgDefault)

  envW.persisted.set('sess-cold', {
    meta: { id: 'sess-cold', cwd: WS, createdAt: 1000 },
    events: [{ type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '历史消息' }] } }],
  })
  // live 会话 override: sessions store 里放一条带 sandbox/mode + approval/policy 的记录
  const ovrLog = [
    { type: 'session/title', seq: 1, time: 1, data: { title: 'ovr' } },
    { type: 'sandbox/mode', seq: 2, time: 2, data: { mode: 'read-only' } },
    { type: 'approval/policy', seq: 3, time: 3, data: { policy: 'never' } },
  ]
  envW.liveSessions.set('sess-live-ovr', { header: { id: 'sess-live-ovr', cwd: WS_REAL, createdAt: 2000 }, log: ovrLog })
  const pg = await callTool(PW, 'policy_get', { sessionId: 'sess-live-ovr' })
  check('C policy_get override 折叠(sandbox/mode + approval/policy)', pg.sandboxMode === 'read-only' && pg.source === 'override' && pg.approvalPolicy === 'never', pg)
  check('C policy_get workspaceRoot 来自 header.cwd(realpath 规范化)', pg.workspaceRoot === WS_REAL, pg.workspaceRoot)

  envW.persisted.set('sess-plain', {
    meta: { id: 'sess-plain', cwd: WS, createdAt: 500 },
    events: [{ type: 'session/title', seq: 1, time: 1, data: { title: 'plain' } }],
  })
  const pgPlain = await callTool(PW, 'policy_get', { sessionId: 'sess-plain' })
  check('C 无 override 会话回落 default(source=default)', pgPlain.sandboxMode === 'workspace-write' && pgPlain.source === 'default', pgPlain)
  const pgMissing = await callTool(PW, 'policy_get', { sessionId: 'no-such-session' })
  check('C policy_get 不存在会话报错', /session not found/.test(String(pgMissing.error)), pgMissing)
}

{
  const coldSet = await callTool(PW, 'set_policy', { sessionId: 'sess-cold', mode: 'read-only' })
  check('A 冷会话 set_policy 明确报错(需先 resume)', coldSet.ok === undefined && /not live/.test(String(coldSet.error)) && /resume/.test(String(coldSet.error)), coldSet)

  const liveSet = await callTool(PW, 'set_policy', { sessionId: S1, mode: 'read-only' })
  check('A live 会话 set_policy ok 并回显档位', liveSet.ok === true && liveSet.sandboxMode === 'read-only' && liveSet.source === 'live', liveSet)
  const lastEv = envW.registry.get(S1)?.session.log.at(-1)
  check('A set_policy 追加 sandbox/mode 事件(最新者胜)', lastEv?.type === 'sandbox/mode' && lastEv.data?.mode === 'read-only', lastEv)
  const pgAfter = await callTool(PW, 'policy_get', { sessionId: S1 })
  check('A set_policy 后 policy_get 反映新档(override)', pgAfter.sandboxMode === 'read-only' && pgAfter.source === 'override', pgAfter)

  const sl = await callTool(PW, 'session_list', { cwd: WS_REAL })
  const ovrRow = sl.sessions?.find((s) => s.id === 'sess-live-ovr')
  check('C session_list 行携带 sandboxMode', ovrRow?.sandboxMode === 'read-only', ovrRow)
  const plainRow = sl.sessions?.find((s) => s.id === 'sess-plain')
  check('C 无 override 行不带 sandboxMode 字段', plainRow && plainRow.sandboxMode === undefined, plainRow)
}

// ── A: task_inbox sandbox 透传与回显(独立 cwd: 避免复用已被 set_policy 改档的池会话) ──
const WS_TASK = '/tmp/a2a-ws-mock-p3-task'
mkdirSync(WS_TASK, { recursive: true })
{
  const ok = await callTool(PW, 'task_inbox', { task: 'p3-task', cwd: WS_TASK, sandbox: 'read-only', title: 'p3t' })
  check('A task_inbox 带 sandbox 入队成功', Boolean(ok.taskId), ok)
  const fin = await waitFor(async () => {
    const r = await callTool(PW, 'task_result', { taskId: ok.taskId })
    return r.status === 'done' ? r : undefined
  })
  const taskSessionLog = [...envW.registry.values()]
    .filter((a) => String(a.session.header.cwd).endsWith('a2a-ws-mock-p3-task'))
    .flatMap((a) => a.session.log.filter((e) => e.type === 'sandbox/mode'))
  check('A 任务执行会话种 read-only 档', taskSessionLog.at(-1)?.data?.mode === 'read-only', taskSessionLog)
  check('A task_result 回显 sandbox=read-only', fin?.result?.sandbox === 'read-only', fin?.result?.sandbox)
  const tl = await callTool(PW, 'task_list', {})
  check('A task_list 行回显 sandbox=read-only', tl.tasks?.some((t) => t.id === ok.taskId && t.sandbox === 'read-only'), tl.tasks?.[0])
}

// ── A: resume 路径同样种档(cold 会话经 sessionId 续接时按请求档固化) ──
{
  const r = await callTool(PW, 'agent_run', { task: 'resume-seed', cwd: WS_TASK, sessionId: 'sess-cold', sandbox: 'workspace-write' })
  check('A resume 成功并回显 sandbox', typeof r.sessionId === 'string' && r.sandbox === 'workspace-write', { sid: r.sessionId, sb: r.sandbox })
  check('A resume 路径种 sandbox/mode=workspace-write', envW.resumed.get('sess-cold')?.log.filter((e) => e.type === 'sandbox/mode').at(-1)?.data?.mode === 'workspace-write',
    envW.resumed.get('sess-cold')?.log.filter((e) => e.type === 'sandbox/mode'))
}

// ═══════════════ 实例 B: 降级 builtin(apiProxy 缺失, web 自动降级)+ 超时 cancelled ═══════════════
console.log('── 实例B: builtin 降级 + 超时 cancelled + 内建回答主流程 ──')
const envB = makeCtxP3({}) // 无 apiProxy
await apply(envB.ctx, { port: 8111, host: '127.0.0.1', approvalTimeoutMs: 300 })
await sleep(150)
const PB = 8111
check('B实例 initialize', await initMcp(PB, 'mock-p3b'))

const answerer = envB.calls.on.find(([ev]) => ev === 'approval/request')?.[1]
{
  const st = await callTool(PB, 'status_get', {})
  check('B降级 apiProxy 缺失 → bridge=builtin', st.sandboxPolicy?.bridge === 'builtin', st.sandboxPolicy)
  check('B降级 自注册了 approval/request 应答器', typeof answerer === 'function', envB.calls.on.map((e) => e[0]))
  const al = await callTool(PB, 'approval_list', {})
  check('B降级 approval_list 可用(空表)', al.bridge === 'builtin' && al.count === 0, al)
}

{
  // 超时: approvalTimeoutMs=300 → settle 'cancelled'(绝不超时放行), 之后补答 not-pending
  const askedT = { type: 'approval/asked', seq: 1, time: Date.now(), data: { id: 'apr-t1', toolName: 'bash' } }
  const req = { agent: { session: { id: 'sess-b-timeout', events: [askedT] } }, toolName: 'bash', reason: 'escalation' }
  const p = answerer(req, async () => 'unavailable')
  const seen = await waitFor(async () => {
    const l = await callTool(PB, 'approval_list', {})
    return l.approvals?.some((a) => a.approvalId === 'apr-t1') ? l : undefined
  })
  check('B超时 answerer 挂起期间 approval_list 可见', Boolean(seen), await callTool(PB, 'approval_list', {}))
  await sleep(550)
  const settled = await Promise.race([p.then((v) => v), sleep(1000).then(() => '<<still-pending>>')])
  check('B超时 300ms 后 answerer settle=cancelled(绝不放行)', settled === 'cancelled', settled)
  const late = await callTool(PB, 'approval_respond', { approvalId: 'apr-t1', sessionId: 'sess-b-timeout', outcome: 'rejected' })
  check('B超时 已收尾的审批补答 → not-pending', late.ok === false && late.receipt === 'not-pending', late)
  check('B超时 builtin 路径不发 apiProxy.respond(envB 无 respondCalls)', envB.calls.respondCalls.length === 0, envB.calls.respondCalls)
}

{
  // 内建回答主流程: allowed-once / rejected 各一次
  const askedA = { type: 'approval/asked', seq: 2, time: Date.now(), data: { id: 'apr-a1', toolName: 'fs_write' } }
  const pA = answerer({ agent: { session: { id: 'sess-b-a', events: [askedA] } }, toolName: 'fs_write' }, async () => 'unavailable')
  await waitFor(async () => (await callTool(PB, 'approval_list', {})).count === 1)
  const rA = await callTool(PB, 'approval_respond', { approvalId: 'apr-a1', sessionId: 'sess-b-a', outcome: 'allowed-once' })
  check('B内建 allowed-once → accepted', rA.ok === true && rA.receipt === 'accepted', rA)
  const outA = await Promise.race([pA, sleep(800).then(() => '<<still-pending>>')])
  check('B内建 answerer 以 allowed-once 结案', outA === 'allowed-once', outA)
  const again = await callTool(PB, 'approval_respond', { approvalId: 'apr-a1', sessionId: 'sess-b-a', outcome: 'allowed-once' })
  check('B内建 重复回答 → not-pending(先答者胜)', again.ok === false && again.receipt === 'not-pending', again)

  const askedR = { type: 'approval/asked', seq: 3, time: Date.now(), data: { id: 'apr-r1', toolName: 'bash' } }
  const pR = answerer({ agent: { session: { id: 'sess-b-r', events: [askedR] } }, toolName: 'bash' }, async () => 'unavailable')
  await waitFor(async () => (await callTool(PB, 'approval_list', {})).count === 1)
  const rR = await callTool(PB, 'approval_respond', { approvalId: 'apr-r1', sessionId: 'sess-b-r', outcome: 'rejected' })
  const outR = await Promise.race([pR, sleep(800).then(() => '<<still-pending>>')])
  check('B内建 rejected 结案', rR.ok === true && outR === 'rejected', { rR, outR })

  // decided 配对跳过: 已 decided 的 ask 不再挂起(answerer 直接 next())
  const eventsDecided = [
    { type: 'approval/asked', seq: 4, time: Date.now(), data: { id: 'apr-d1', toolName: 'bash' } },
    { type: 'approval/decided', seq: 5, time: Date.now() + 1, data: { id: 'apr-d1', outcome: 'rejected' } },
  ]
  let nextCalled = false
  const pD = answerer({ agent: { session: { id: 'sess-b-d', events: eventsDecided } }, toolName: 'bash' }, async () => { nextCalled = true; return 'unavailable' })
  const outD = await Promise.race([pD, sleep(800).then(() => '<<still-pending>>')])
  check('B已 decided 的 ask 直接 next()(fail-closed unavailable)', outD === 'unavailable' && nextCalled, outD)
}

// ═══════════════ 实例 O: approvalsBridge=off ═══════════════
console.log('── 实例O: approvalsBridge=off ──')
const envO = makeCtxP3({})
await apply(envO.ctx, { port: 8112, host: '127.0.0.1', approvalsBridge: 'off' })
await sleep(150)
const PO = 8112
check('O initialize', await initMcp(PO, 'mock-p3o'))
{
  const st = await callTool(PO, 'status_get', {})
  check('O bridge=off', st.sandboxPolicy?.bridge === 'off', st.sandboxPolicy)
  check('O 不注册任何 approval/request 应答器', !envO.calls.on.some(([ev]) => ev === 'approval/request'), envO.calls.on.map((e) => e[0]))
  const al = await callTool(PO, 'approval_list', {})
  check('O approval_list 空(off)', al.bridge === 'off' && al.count === 0 && Array.isArray(al.approvals), al)
}

// ═══════════════ 实例 D: 显式 approvalsBridge=builtin(apiProxy 在场也强制内建) ═══════════════
console.log('── 实例D: 显式 builtin 覆盖 web ──')
const envD = makeCtxP3({ apiProxy: makeFakeApiProxy(null) })
await apply(envD.ctx, { port: 8113, host: '127.0.0.1', approvalsBridge: 'builtin', approvalTimeoutMs: 60000 })
await sleep(150)
const PD = 8113
check('D initialize', await initMcp(PD, 'mock-p3d'))
{
  const st = await callTool(PD, 'status_get', {})
  check('D apiProxy 在场但显式 builtin 生效', st.sandboxPolicy?.bridge === 'builtin', st.sandboxPolicy)
  check('D 显式 builtin 自注册应答器', envD.calls.on.some(([ev]) => ev === 'approval/request'), envD.calls.on.map((e) => e[0]))
}

// ═══════════════ 实例 C: defaultSandbox=read-only 的部署默认档(独立 cwd: 模块级池跨实例共享) ═══════════════
console.log('── 实例C: defaultSandbox=read-only 部署默认 ──')
const envC = makeCtxP3({ apiProxy: makeFakeApiProxy(null) })
await apply(envC.ctx, { port: 8114, host: '127.0.0.1', defaultSandbox: 'read-only' })
await sleep(150)
const PC = 8114
check('C实例 initialize', await initMcp(PC, 'mock-p3c'))
{
  const pg = await callTool(PC, 'policy_get', {})
  check('C部署 policy_get 默认=read-only', pg.sandboxMode === 'read-only' && pg.source === 'default', pg)
  const WS_C = '/tmp/a2a-ws-mock-p3-c'
  mkdirSync(WS_C, { recursive: true })
  const r1 = await callTool(PC, 'agent_run', { task: 'c1', cwd: WS_C })
  const seeded = envC.registry.get(r1.sessionId)?.session.log.filter((e) => e.type === 'sandbox/mode').at(-1)
  check('C部署 默认会话种 read-only 档', seeded?.data?.mode === 'read-only', seeded)
  const c0 = envC.calls.createPresets.length
  await callTool(PC, 'agent_run', { task: 'c2', cwd: WS_C })
  check('C部署 同档复用池', envC.calls.createPresets.length === c0, envC.calls.createPresets)
  const c1 = envC.calls.createPresets.length
  await callTool(PC, 'agent_run', { task: 'c3', cwd: WS_C, sandbox: 'workspace-write' })
  check('C部署 提档请求走专用会话(防污染)', envC.calls.createPresets.length === c1 + 1, envC.calls.createPresets)
  const badCfg = makeCtxP3({})
  const warn = []
  const origWarn = console.warn
  console.warn = (...a) => { warn.push(a.join(' ')) }
  try {
    await apply(badCfg.ctx, { port: 8115, host: '127.0.0.1', defaultSandbox: 'yolo', approvalsBridge: 'sometimes' })
  } finally {
    console.warn = origWarn
  }
  check('C部署 非法配置告警并回落默认(defaultSandbox 保持 read-only)', warn.some((w) => w.includes('invalid defaultSandbox')) && warn.some((w) => w.includes('invalid approvalsBridge')), warn)
}

console.log(`\n══ P3 单元级结果: PASS=${passCount} FAIL=${failCount} ══`)
process.exit(failCount > 0 ? 1 : 0)

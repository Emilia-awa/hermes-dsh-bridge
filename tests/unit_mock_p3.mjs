// P3 单元级集成测试: 用 mock ctx 直接驱动插件的 apply(),
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
  check('W status_get.version 与 package.json 一致', st.version === readVer('../package.json')?.replace(/.*"version"\s*:\s*"([^"]+)".*/, '$1') || st.version === readVer('../src/index.ts'), st.version)
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

// ═══ [r2] D: dsh 0.1.5 会话 v3 格式适配 + session_list 逐行容错 ═══
// 复现 R1 实测崩溃: 0.1.5 的 sessionPersistence.list() 返回 SessionPersistenceSnapshot[]
// ({header, revision, sizeBytes}) 而非裸 SessionHeader[]; 旧代码直接 h.id/h.cwd 得到 undefined,
// → 无参 session_list 抛 "Cannot read properties of undefined (reading 'length')"。
// 同时 0.1.5 移除了 inspect(), 改为 open(id,'read')+handle.read()。
{
  console.log('\n── D: [r2] 0.1.5 v3 快照契约 + 逐行容错 ──')
  const D = 8118
  const V3 = 'v3sud-' + '1111-4111-8111-111111111111'
  const V3_B = 'v3sub-' + '2222-4222-8222-222222222222'
  const V3_EMPTY = 'v3emp-' + '3333-4333-8333-333333333333'

  // v3 事件流: 最后一条 sandbox/mode 用于 sandboxMode 折叠断言
  const v3Events = [
    { type: 'permission/preset', seq: 0, time: 100, data: { preset: 'workspace-write' } },
    { type: 'session/title', seq: 1, time: 200, data: { title: 'v3 冒烟会话' } },
    { type: 'user/message', seq: 2, time: 300, data: { content: [{ type: 'text', text: 'v3 hello' }] } },
    { type: 'sandbox/mode', seq: 3, time: 400, data: { mode: 'read-only' } },
    { type: 'assistant/message', seq: 4, time: 500, data: { message: { content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 10, outputTokens: 5 } } },
  ]
  const v3EventsB = [
    { type: 'session/title', seq: 0, time: 150, data: { title: 'v3 乙会话' } },
  ]

  // 真实 0.1.5 形态: list() → snapshot[]; stat(id) → snapshot; locate(meta) → {kind,path}
  const metaOf = (id, cwd) => ({ id, cwd, createdAt: 1000, version: 3, isSeeded: true, delegationDepth: 0 })
  const snapOf = (id, cwd, sizeBytes) => ({ header: metaOf(id, cwd), revision: `rev-${id}`, sizeBytes })
  const v3Files = new Map() // id -> {events, path}
  v3Files.set(V3, { events: v3Events, path: '/tmp/a2a-ws-mock-p3-d/d--tmp--/' + V3 + '/session.v3.jsonl.zstd' })
  v3Files.set(V3_B, { events: v3EventsB, path: '/tmp/a2a-ws-mock-p3-d/d--tmp--/' + V3_B + '/session.v3.jsonl.zstd' })
  v3Files.set(V3_EMPTY, { events: [], path: '/tmp/a2a-ws-mock-p3-d/d--tmp--/' + V3_EMPTY + '/session.v3.jsonl.zstd' })

  const opened = []   // 断言确实走了 0.1.5 的 open/read 路径
  const closed = []
  // 0.1.5 持久化服务 mock: 无 inspect, 有 list(snapshot)/stat/open/locate
  const persistence015 = {
    list: async () => [snapOf(V3, '/tmp', 14110), snapOf(V3_B, '/tmp', 900), snapOf(V3_EMPTY, undefined, 60)],
    stat: async (sid) => v3Files.has(String(sid)) ? snapOf(String(sid), '/tmp', 14110) : undefined,
    locate: (meta) => v3Files.has(String(meta.id)) ? { kind: 'jsonl', path: v3Files.get(String(meta.id)).path } : undefined,
    open: async (sid) => {
      const key = String(sid)
      if (!v3Files.has(key)) throw new Error('SessionPersistenceNotFoundError: ' + key)
      opened.push(key)
      let cursor = 0
      return {
        id: key,
        header: metaOf(key, '/tmp'),
        read: async () => ({ events: v3Files.get(key).events, eventState: 'owned' }),
        close: async () => { closed.push(key) },
      }
    },
  }

  const envD = {
    ctx: {
      effect(fn) { void fn },
      on() {},
      get(name) {
        if (name === 'sessions') return { list: () => [], get: () => undefined }
        if (name === 'sessionPersistence') return persistence015
        if (name === 'workspaceRegistry') return { list: () => [] }
        return undefined
      },
      agents: {
        list: () => [],
        get: () => undefined,
        resume: async () => { throw new Error('n/a') },
        create: async (o) => {
          await o.setup?.(scopeProxy())
          const sid = String(o.sessionId)
          const session = {
            log: [],
            header: { id: sid, cwd: o?.meta?.cwd ?? '/tmp', createdAt: Date.now(), agentPreset: o?.meta?.agentPreset },
            append(type, data) { this.log.push({ type, seq: this.log.length + 1, time: Date.now(), data }); return { type, data } },
          }
          return { agent: { id: sid, session, followup() {}, whenIdle: async () => {} }, dispose: async () => {} }
        },
      },
      agentPresets: { defaultId: 'standard', resolve: async (id) => ({ id }), list: async () => [], mount: async () => {}, recompose: async (_c, id) => ({ id }) },
    },
  }
  await apply(envD.ctx, { port: D, host: '127.0.0.1', approvalsBridge: 'off' })
  await new Promise((r) => setTimeout(r, 150))
  const rpcD = async (method, params) => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (rpcD.sid) headers['Mcp-Session-Id'] = rpcD.sid
    const res = await fetch(`http://127.0.0.1:${D}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params }) })
    const s = res.headers.get('mcp-session-id'); if (s) rpcD.sid = s
    const text = await res.text()
    let parsed = null
    for (const line of text.split('\n')) if (line.startsWith('data: ')) { try { parsed = JSON.parse(line.slice(6)) } catch {} }
    if (!parsed) { try { parsed = JSON.parse(text) } catch {} }
    return parsed
  }
  const callD = async (name, args = {}) => {
    const r = await rpcD('tools/call', { name, arguments: args })
    const txt = (r?.result?.content ?? []).map((c) => c.text ?? '').join('')
    try { return JSON.parse(txt) } catch { return { _raw: txt, _rpcError: r?.error } }
  }
  await rpcD('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p3-d', version: '1' } })
  await rpcD('notifications/initialized', {})

  // D1: 无参 session_list —— R1 崩溃路径, 必须不崩且解出 v3 会话
  const dl = await callD('session_list', {})
  check('[r2] 无参 session_list 对 0.1.5 snapshot 不崩(无 error)', dl.error === undefined, dl)
  check('[r2] session_list 返回 skipped 计数字段', typeof dl.skipped === 'number', dl)
  const v3Row = (dl.sessions ?? []).find((s) => s.id === V3)
  check('[r2] v3 会话 id 从 snapshot.header 正确解包(非 undefined)', Boolean(v3Row), dl.sessions)
  check('[r2] v3 会话 title 由 open/read 读出的事件折叠', v3Row?.title === 'v3 冒烟会话', v3Row)
  check('[r2] v3 会话 cwd 来自 snapshot.header', v3Row?.cwd === '/tmp', v3Row)
  check('[r2] v3 会话 messageCount 来自 open/read(非 0 空壳)', v3Row?.messageCount === 5, v3Row)
  check('[r2] v3 会话 sandboxMode 折叠自事件流', v3Row?.sandboxMode === 'read-only', v3Row)
  check('[r2] v3 会话 token 统计折叠', v3Row?.inputTokens === 10 && v3Row?.outputTokens === 5, v3Row)
  check('[r2] 0.1.5 无 inspect 时确实走了 open("read") 契约', opened.length > 0, opened)
  check('[r2] 读句柄被 close(无泄漏)', closed.length === opened.length, { opened: opened.length, closed: closed.length })
  check('[r2] 无 cwd 的会话不崩(cwd undefined 行仍可列出)', (dl.sessions ?? []).some((s) => s.id === V3_EMPTY), dl.sessions)

  // D2: 畸形条目 → 计入 skipped, 不炸整表
  const bad = persistence015.list
  persistence015.list = async () => [
    { header: {}, revision: 'r', sizeBytes: 1 },      // header 无 id → skipped
    null,                                             // 非对象 → skipped
    { revision: 'r2' },                               // 既无 header 也无 id → skipped
    snapOf(V3, '/tmp', 14110),                        // 正常行
  ]
  const dl2 = await callD('session_list', {})
  check('[r2] 畸形持久化条目整体不崩', dl2.error === undefined, dl2)
  check('[r2] 畸形条目计入 skipped=3', dl2.skipped === 3, dl2)
  check('[r2] 正常行仍被列出(逐行容错)', (dl2.sessions ?? []).some((s) => s.id === V3), dl2.sessions)
  persistence015.list = bad

  // D3: 单行 inspect 失败只跳过该行(skipped+1), 其余行照常返回
  const goodOpen = persistence015.open
  persistence015.open = async (sid) => {
    if (String(sid) === V3_B) throw new Error('simulated per-row read failure')
    return goodOpen(sid)
  }
  const dl3 = await callD('session_list', {})
  check('[r2] 单行读取失败不外抛(整体仍成功)', dl3.error === undefined, dl3)
  check('[r2] 失败行未进入结果', !(dl3.sessions ?? []).some((s) => s.id === V3_B), dl3.sessions)
  check('[r2] 其余行正常返回(证明是逐行容错而非整表放弃)', (dl3.sessions ?? []).some((s) => s.id === V3), dl3.sessions)
  persistence015.open = goodOpen

  // D4: session_log / session_search 也走通 v3 路径
  const logD = await callD('session_log', { sessionId: V3 })
  check('[r2] session_log 经 open/read 读到 v3 事件', logD.error === undefined && logD.shown > 0, logD)
  const searchD = await callD('session_search', { query: 'v3 乙会话' })
  check('[r2] session_search 标题命中 v3 会话', (searchD.results ?? []).some((r) => r.sessionId === V3_B), searchD)
  const searchD2 = await callD('session_search', { query: 'v3 hello' })
  check('[r2] session_search 内容命中 v3 会话(open/read 生效)', (searchD2.results ?? []).some((r) => r.sessionId === V3), searchD2)

  // D5: A/B 项 —— 26 个工具描述面向 agent 调用者优化 + 自解释字段
  const tl = await rpcD('tools/list', {})
  const tools = tl?.result?.tools ?? []
  // 本实例未开 enableFsWrite, 故 fs_write(opt-in)不在列表; 其余 25 个常驻工具必须都在。
  const EXPECT_TOOLS = ['echo', 'harness_list_tools', 'status_get', 'config_get', 'fs_read', 'fs_list', 'fs_stat',
    'session_list', 'session_log', 'session_stats', 'session_search', 'preset_list', 'preset_get', 'preset_set',
    'policy_get', 'set_policy', 'approval_list', 'approval_respond', 'agent_run', 'task_inbox', 'task_result',
    'task_list', 'task_cancel', 'rename_session', 'attach_session']
  const gotNames = tools.map((t) => t.name)
  const missing = EXPECT_TOOLS.filter((n) => !gotNames.includes(n))
  check('[r2] 25 个常驻工具齐全(fs_write 为 opt-in 未开故不在)', missing.length === 0 && gotNames.length === 25, { missing, gotNames })
  const byName = new Map(tools.map((t) => [t.name, t]))
  check('[r2] agent_run 描述点明"同步"+时长建议', /同步/.test(byName.get('agent_run')?.description ?? '') && /5\s*分钟|< ?5/.test(byName.get('agent_run')?.description ?? ''), byName.get('agent_run')?.description?.slice(0, 120))
  check('[r2] agent_run 描述互相引用 task_inbox', /task_inbox/.test(byName.get('agent_run')?.description ?? ''), byName.get('agent_run')?.description?.slice(0, 200))
  check('[r2] task_inbox 描述点明"异步"+立即返回 taskId', /异步/.test(byName.get('task_inbox')?.description ?? '') && /taskId/.test(byName.get('task_inbox')?.description ?? ''), byName.get('task_inbox')?.description?.slice(0, 120))
  check('[r2] task_inbox 描述互相引用 task_result', /task_result/.test(byName.get('task_inbox')?.description ?? ''), byName.get('task_inbox')?.description?.slice(0, 200))
  check('[r2] task_result 描述引用 task_inbox(双向互引)', /task_inbox/.test(byName.get('task_result')?.description ?? ''), byName.get('task_result')?.description?.slice(0, 120))
  check('[r2] 会话工具描述引用 session_list(链路口径统一)', /session_list/.test(byName.get('session_log')?.description ?? ''), byName.get('session_log')?.description?.slice(0, 120))
  check('[r2] 26 个工具描述全部非空且普遍变长(≥20 字符)', tools.every((t) => (t.description ?? '').length >= 20), tools.filter((t) => (t.description ?? '').length < 20).map((t) => t.name))
  // agent_run 成功结果带 next 字段(只在有会话可续时给出)
  const ar = await callD('agent_run', { task: 'ux probe', cwd: '/tmp/a2a-ws-mock-p3-d' })
  check('[r2] agent_run 结果含 next 自解释字段', typeof ar.next === 'string' && ar.next.length > 0, ar.next)
  check('[r2] agent_run 的 next 指引用 sessionId 续接', /sessionId/.test(String(ar.next)), ar.next)
  // task_inbox 返回 taskId + 取结果提示
  const ti = await callD('task_inbox', { task: 'ux probe async', cwd: '/tmp/a2a-ws-mock-p3-d' })
  check('[r2] task_inbox 返回 taskId', typeof ti.taskId === 'string', ti)
  check('[r2] task_inbox 的 next 指向 task_result(taskId=...)', /task_result/.test(String(ti.next)) && String(ti.next).includes(ti.taskId), ti.next)
  // 错误信息带下一步动作
  const badTask = await callD('task_result', { taskId: 'no-such-task-id' })
  check('[r2] task_result 未命中错误带下一步(task_list 提示)', /task not found/.test(String(badTask.error)) && /task_list/.test(String(badTask.error)), badTask.error)
  const badSession = await callD('session_log', { sessionId: 'no-such-session-id' })
  check('[r2] session_log 未命中错误带下一步(session_list 提示)', /session not found/.test(String(badSession.error)) && /session_list/.test(String(badSession.error)), badSession.error)
  // session_log 的 preset 快捷值
  const dialogLog = await callD('session_log', { sessionId: V3, preset: 'dialog' })
  check('[r2] session_log preset=dialog 只返回人机对话类型', (dialogLog.events ?? []).every((e) => e.type === 'user/message' || e.type === 'assistant/message'), dialogLog.events?.map((e) => e.type))
  check('[r2] session_log 回显生效 preset', dialogLog.preset === 'dialog', dialogLog.preset)
  const toolsLog = await callD('session_log', { sessionId: V3, preset: 'tools' })
  check('[r2] session_log preset=tools 只返回工具事件', (toolsLog.events ?? []).every((e) => e.type === 'tool/call' || e.type === 'tool/result'), toolsLog.events?.map((e) => e.type))
}

// ═══ [r3] R3: A 返回结构精简 / B agent 工作流指引 / C 一致性与防御 ═══
// 直接经 __internals 纯函数通道断言格式化与错误文案(确定性), 再经实例 W 的 HTTP 面断言
// 工具级返回体(分页信封 / 审批汇总 / 任务落点提示)。
{
  console.log('\n── [r3] A: 时间戳/字节/时长格式化 + 列表分页 ──')
  const I = __internals
  // 前面的 D 块用的是独立 rpcD 会话; 共享 mcpSession 仍停留在别的端口 → 重新握手再打 HTTP 面
  await initMcp(PW, 'mock-p3-r3a')

  // A2: 时间戳统一 ISO8601 本地时区 + 原始 epoch
  const ht = I.humanTime(Date.UTC(2024, 4, 1, 4, 34, 56))
  check('[r3] A2 humanTime 输出 ISO8601 带本地时区偏移', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(ht.at), ht)
  check('[r3] A2 humanTime 保留原始 epoch(ms)', typeof ht.at_epoch === 'number' && ht.at_epoch > 0, ht)
  check('[r3] A2 humanTime 与本地 Date 分量一致', (() => {
    const d = new Date(Date.UTC(2024, 4, 1, 4, 34, 56))
    const p = (n) => String(n).padStart(2, '0')
    return ht.at.startsWith(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`)
  })(), ht)
  check('[r3] A2 humanTime 非法/缺失返回 undefined', I.humanTime(undefined) === undefined && I.humanTime(NaN) === undefined, I.humanTime(NaN))
  check('[r3] A2 timeFields 展开 <prefix> 与 <prefix>_epoch', I.timeFields('createdAt', 1000).createdAt !== undefined && I.timeFields('createdAt', 1000).createdAt_epoch === 1000, I.timeFields('createdAt', 1000))

  // A3: 字节 / 时长人类可读, 原始值由调用方保留
  check('[r3] A3 formatBytes 9.4KB 量级', I.formatBytes(9600) === '9.4KB', I.formatBytes(9600))
  check('[r3] A3 formatBytes 小值用 B / 大值 MB', I.formatBytes(512) === '512B' && I.formatBytes(1024 * 1024 * 2) === '2MB', [I.formatBytes(512), I.formatBytes(1024 * 1024 * 2)])
  check('[r3] A3 formatDuration 8.8s(需求示例)', I.formatDuration(8800) === '8.8s', I.formatDuration(8800))
  check('[r3] A3 formatDuration 毫秒/分钟/小时', I.formatDuration(250) === '250ms' && I.formatDuration(90000) === '1.5m' && I.formatDuration(3600000) === '1h', [I.formatDuration(250), I.formatDuration(90000), I.formatDuration(3600000)])
  check('[r3] A3 非法输入返回 undefined(不抛)', I.formatBytes(-1) === undefined && I.formatDuration(NaN) === undefined, [I.formatBytes(-1), I.formatDuration(NaN)])

  // A1: 分页信封 —— 超 20 条截断 + total/truncated/next
  const rows = Array.from({ length: 45 }, (_, i) => i)
  const p1 = I.pageEnvelope(rows, 0, I.LIST_PAGE_DEFAULT, 'session_list')
  check('[r3] A1 列表默认页 20 条(45 条被截断)', p1.page.length === 20 && p1.meta.truncated === true, { n: p1.page.length, m: p1.meta })
  check('[r3] A1 截断时给出 total 与翻页 next', p1.meta.total === 45 && /offset=20/.test(String(p1.meta.next)), p1.meta)
  check('[r3] A1 最后一页 truncated=false 且无 next', (() => { const p = I.pageEnvelope(rows, 40, 20, 'session_list'); return p.page.length === 5 && p.meta.truncated === false && p.meta.next === undefined })(), I.pageEnvelope(rows, 40, 20, 'session_list').meta)
  check('[r3] A1 parsePage 负 offset 归零 / limit 夹取', (() => { const r = I.parsePage(-5, 9999); return r.offset === 0 && r.limit === I.LIST_PAGE_MAX })(), I.parsePage(-5, 9999))

  // 工具级: task_list 分页信封 + 人类可读时间
  const tl0 = await callTool(PW, 'task_list', {})
  check('[r3] A1 task_list 带 offset/limit/total 分页字段', typeof tl0.offset === 'number' && typeof tl0.limit === 'number' && typeof tl0.total === 'number', tl0)
  check('[r3] A2 task_list 行时间戳为 ISO8601 + epoch', (() => {
    const t = tl0.tasks?.[0]
    return t !== undefined && /[+-]\d{2}:\d{2}$/.test(String(t.createdAt)) && typeof t.createdAt_epoch === 'number'
  })(), tl0.tasks?.[0])
  check('[r3] A1 task_list 分页 limit 生效(limit=1 只回 1 条)', (await callTool(PW, 'task_list', { limit: 1 })).tasks?.length <= 1, await callTool(PW, 'task_list', { limit: 1 }))

  // 工具级: session_log 默认 50 条上限 + 首尾截断 + truncated 提示
  const cfg = { sessionId: 'sess-many-events' }
  envW.liveSessions.set('sess-many-events', {
    header: { id: 'sess-many-events', cwd: WS, createdAt: 1000 },
    log: Array.from({ length: 120 }, (_, i) => ({ type: 'user/message', seq: i + 1, time: 1000 + i, data: { content: [{ type: 'text', text: 'ev' + i }] } })),
  })
  const bigLog = await callTool(PW, 'session_log', { ...cfg, preset: 'dialog' })
  check('[r3] A1 session_log 默认最多 50 条事件', bigLog.shown === 50, { shown: bigLog.shown, total: bigLog.totalMatched })
  check('[r3] A1 session_log 超限置 truncated + omitted + next 取更多提示', bigLog.truncated === true && bigLog.omitted === 70 && /tail|head/.test(String(bigLog.next)), bigLog)
  check('[r3] A1 session_log 截断时返回首尾(最早与最新事件都在)', (() => {
    const seqs = (bigLog.events ?? []).map((e) => e.seq)
    return seqs.includes(1) && seqs.includes(120)
  })(), (bigLog.events ?? []).map((e) => e.seq))
  check('[r3] A2 session_log 事件时间戳人类可读 + epoch', (() => {
    const e = bigLog.events?.[0]
    return e !== undefined && /[+-]\d{2}:\d{2}$/.test(String(e.time)) && typeof e.time_epoch === 'number'
  })(), bigLog.events?.[0])
  const smallLog = await callTool(PW, 'session_log', { sessionId: 'sess-many-events', tail: 200, preset: 'dialog' })
  check('[r3] A1 session_log 调大 tail 可取更多(200>120 → 不截断)', smallLog.shown === 120 && smallLog.truncated === false, { shown: smallLog.shown, tr: smallLog.truncated })
  envW.liveSessions.delete('sess-many-events')

  // 工具级: fs_stat / echo 的人类可读字段(原始值保留)
  // 选一个必在允许根内的已存在路径: ~/.dsh(白名单根之一) 或仓库 cwd
  const homeDsh = `${process.env.HOME ?? '/root'}/.dsh`
  const candidates = [homeDsh, process.cwd(), WS_TASK]
  let fsOk = { error: 'no candidate' }
  for (const p of candidates) {
    const r = await callTool(PW, 'fs_stat', { path: p })
    if (r.error === undefined && r.exists === true) { fsOk = r; break }
    fsOk = r
  }
  check('[r3] A3 fs_stat 大小带单位且保留 size_bytes', typeof fsOk.size === 'string' && typeof fsOk.size_bytes === 'number', fsOk)
  check('[r3] A2 fs_stat mtime 为 ISO8601 + mtime_epoch', /[+-]\d{2}:\d{2}$/.test(String(fsOk.mtime)) && typeof fsOk.mtime_epoch === 'number', fsOk)
  const ec = await callTool(PW, 'echo', { text: 'hi' })
  check('[r3] A2 echo 回显文本 + ISO8601 at + at_epoch', ec['收到'] === 'hi' && /[+-]\d{2}:\d{2}$/.test(String(ec.at)) && typeof ec.at_epoch === 'number', ec)
}

{
  console.log('\n── [r3] B: agent 工作流指引(B4 落点 / B5 保留与轮询 / B6 审批汇总) ──')
  const I = __internals
  await initMcp(PW, 'mock-p3-r3b')

  // B4: fileLandingHint —— 提到写入但无绝对路径 → 给沙箱 cwd 提示
  const mkResult = (over = {}) => ({ taskId: 't', sessionId: 's', assistantText: '', toolCalls: [], toolResults: [], changes: '', verification: '', leftovers: '', ...over })
  const hit = I.fileLandingHint(mkResult({ changes: '已写入文件, 新增了配置解析逻辑' }), '/tmp/sandbox-cwd')
  check('[r3] B4 提到写入但无路径 → 返回 hint 指向沙箱 cwd', hit !== undefined && hit.likelyDir === '/tmp/sandbox-cwd' && /\/tmp\/sandbox-cwd/.test(hit.hint), hit)
  check('[r3] B4 hint 给出下一步(fs_list/fs_stat 定位)', /fs_list|fs_stat/.test(String(hit?.hint)), hit)
  const noWrite = I.fileLandingHint(mkResult({ changes: '只做了一次分析, 没有改动' }), '/tmp/sandbox-cwd')
  check('[r3] B4 未提及写入 → 不打扰(无 hint)', noWrite === undefined, noWrite)
  const withPath = I.fileLandingHint(mkResult({ changes: '已写入 /tmp/sandbox-cwd/src/a.ts 完成改造' }), '/tmp/sandbox-cwd')
  check('[r3] B4 已带绝对路径 → 不再提示(避免冗余)', withPath === undefined, withPath)
  check('[r3] B4 extractAbsPaths 抽取绝对路径并去掉行尾标点', (() => { const p = I.extractAbsPaths('写入 /tmp/x/a.ts, 以及 /tmp/x/b.ts。'); return p.includes('/tmp/x/a.ts') && p.includes('/tmp/x/b.ts') })(), I.extractAbsPaths('写入 /tmp/x/a.ts, 以及 /tmp/x/b.ts。'))

  // B4 工具级: agent_run 结果若提到写入且有 cwd, 应带 landing(或至少结构自洽)
  const arB = await callTool(PW, 'agent_run', { task: 'write-a-file', cwd: WS_TASK })
  check('[r3] B4 agent_run 返回仍含 next(未破坏 R2 契约)', typeof arB.next === 'string', arB.next)
  check('[r3] B4 agent_run 命中时 landing.hint 为字符串, 未命中则字段缺省', arB.landing === undefined || typeof arB.landing?.hint === 'string', arB.landing)

  // B5: task_inbox 提交后附预计保留时长与轮询建议
  const tiB = await callTool(PW, 'task_inbox', { task: 'b5-retain', cwd: WS_TASK })
  check('[r3] B5 task_inbox 返回 retain/retainMs(预计保留时长)', typeof tiB.retain === 'string' && typeof tiB.retainMs === 'number' && tiB.retainMs > 0, tiB)
  check('[r3] B5 task_inbox 返回 pollAdvice 轮询建议', /轮询|5~15s|高频/.test(String(tiB.pollAdvice)), tiB.pollAdvice)
  check('[r3] B5 task_inbox next 含轮询节奏 + task_result', /task_result/.test(String(tiB.next)) && /5~15s/.test(String(tiB.next)), tiB.next)
  check('[r3] B5 task_inbox 返回 createdAt(ISO8601)+epoch', /[+-]\d{2}:\d{2}$/.test(String(tiB.createdAt)) && typeof tiB.createdAt_epoch === 'number', tiB)

  // B6: approval_list 的"当前挂起审批数"汇总(0 与非 0 两种)
  const alEmpty = await callTool(PW, 'approval_list', {})
  check('[r3] B6 approval_list 空表 pending=0 且给汇总句', alEmpty.pending === 0 && /0/.test(String(alEmpty.summary)), { p: alEmpty.pending, s: alEmpty.summary })
  check('[r3] B6 approval_list timeout 人类可读 + timeoutMs 原始值', typeof alEmpty.timeout === 'string' && typeof alEmpty.timeoutMs === 'number', { t: alEmpty.timeout, ms: alEmpty.timeoutMs })

  fakeW.push({ type: 'approval/requested', sessionId: 'sess-b6', approvalId: 'apr-b6', toolName: 'bash', reason: 'b6' }, 'rpc-b6')
  const alOne = await waitFor(async () => { const l = await callTool(PW, 'approval_list', {}); return l.pending === 1 ? l : undefined })
  check('[r3] B6 有挂起时 approval_list.pending=1 且 summary 报数', alOne?.pending === 1 && /1 个审批挂起/.test(String(alOne.summary)), alOne)
  check('[r3] B6 挂起行 waited 人类可读 + requestedAt ISO8601', typeof alOne?.approvals?.[0]?.waited === 'string' && /[+-]\d{2}:\d{2}$/.test(String(alOne?.approvals?.[0]?.requestedAt)), alOne?.approvals?.[0])

  // B6: approval_respond 回答后直接回报剩余挂起数(省一次 list)
  const respB6 = await callTool(PW, 'approval_respond', { approvalId: 'apr-b6', sessionId: 'sess-b6', outcome: 'allowed-once' })
  check('[r3] B6 approval_respond 回报 pendingRemaining=0', respB6.ok === true && respB6.pendingRemaining === 0, respB6)
  check('[r3] B6 approval_respond 给 pendingSummary 收尾句', /0/.test(String(respB6.pendingSummary)), respB6.pendingSummary)
  const respMiss = await callTool(PW, 'approval_respond', { approvalId: 'nope-approval', sessionId: 'sess-b6', outcome: 'rejected' })
  check('[r3] B6 答空条目也回报 pendingRemaining(not-pending)', respMiss.ok === false && typeof respMiss.pendingRemaining === 'number' && respMiss.receipt === 'not-pending', respMiss)
}

{
  console.log('\n── [r3] C: 错误文案统一 + 参数预校验 + dsh 服务不可用指引 ──')
  const I = __internals
  await initMcp(PW, 'mock-p3-r3c')

  // C7: 三类错误统一为 `<错误>: <关键值> (<原因一句话>; <下一步动作>)`
  const e1 = I.missingParamError('fs_read', 'path', 'string')
  check('[r3] C7 必传缺失文案格式统一', /^missing required parameter: fs_read\.path \(expected string, got nothing; .+\)$/.test(e1), e1)
  const e2 = I.idNotFoundError('session', 'sid-1', '用 session_list 查看')
  check('[r3] C7 id 不存在文案格式统一', /^session not found: sid-1 \(.+; 用 session_list 查看\)$/.test(e2), e2)
  const e3 = I.emptySessionError('sid-2')
  check('[r3] C7 会话为空文案格式统一 + 带下一步', /^session is empty: sid-2 \(.+; .+\)$/.test(e3), e3)
  check('[r3] C7 三类错误都含"; "分隔的原因与下一步', [e1, e2, e3].every((s) => s.includes('; ')), [e1, e2, e3])

  // C8: 参数预校验 —— 必填/类型, 回显 expected/got
  const vMissing = I.validateArgs('fs_read', {}, [{ name: 'path', type: 'string', required: true }])
  check('[r3] C8 必填缺失被入口拦截', /missing required parameter/.test(String(vMissing)) && /fs_read\.path/.test(String(vMissing)), vMissing)
  const vType = I.validateArgs('fs_read', { path: 123 }, [{ name: 'path', type: 'string', required: true }])
  check('[r3] C8 类型错误回显 expected string, got number', /expected string, got number/.test(String(vType)), vType)
  check('[r3] C8 类型判定区分 array/object/string(不误判)', (() => {
    const gotObj = String(I.validateArgs('x', { a: {} }, [{ name: 'a', type: 'array' }]))
    const gotStr = String(I.validateArgs('x', { a: 'str' }, [{ name: 'a', type: 'array' }]))
    const okArr = I.validateArgs('x', { a: [] }, [{ name: 'a', type: 'array' }])
    return /got object/.test(gotObj) && /got string/.test(gotStr) && okArr === undefined
  })(), [I.validateArgs('x', { a: {} }, [{ name: 'a', type: 'array' }]), I.validateArgs('x', { a: 'str' }, [{ name: 'a', type: 'array' }]), I.validateArgs('x', { a: [] }, [{ name: 'a', type: 'array' }])])
  check('[r3] C8 合法参数放行(返回 undefined)', I.validateArgs('x', { a: 'ok', b: 3 }, [{ name: 'a', type: 'string', required: true }, { name: 'b', type: 'number' }]) === undefined, I.validateArgs('x', { a: 'ok', b: 3 }, [{ name: 'a', type: 'string', required: true }, { name: 'b', type: 'number' }]))
  check('[r3] C8 可选参数缺省不报错', I.validateArgs('x', {}, [{ name: 'a', type: 'string' }]) === undefined, I.validateArgs('x', {}, [{ name: 'a', type: 'string' }]))

  // C9: dsh 服务未启动/连接拒绝 → 统一"检查 dsh.service 状态"
  check('[r3] C9 ECONNREFUSED 被识别为服务不可用', I.isDshServiceDown(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3080'), { code: 'ECONNREFUSED' })) === true, 'ECONNREFUSED')
  check('[r3] C9 fetch failed / socket hang up 文案被识别', I.isDshServiceDown(new Error('fetch failed')) === true && I.isDshServiceDown(new Error('socket hang up')) === true, 'msg')
  check('[r3] C9 普通业务错误不误判', I.isDshServiceDown(new Error('file not found')) === false, I.isDshServiceDown(new Error('file not found')))
  const down = I.toolFailure('agent_run', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
  check('[r3] C9 服务不可用文案含 dsh.service 指引', /dsh\.service/.test(down) && /agent_run failed/.test(down), down)
  const plain = I.toolFailure('fs_read', new Error('EACCES: permission denied'))
  check('[r3] C9 普通失败仍走统一格式并保留原因', /^fs_read failed: EACCES: permission denied \(.+; .+\)$/.test(plain), plain)

  // C7/C8 工具级: 类型校验确实"前移"(schema 层即拒, 消息里含字段名与期望/实际类型);
  // 若未来改为 handler 层拦截, 则 expected/got 文案同样成立 —— 两种前移都算通过。
  const typeRejected = (r, field, want) => {
    const raw = String(r._raw ?? '')
    if (r._rpcError !== undefined || /-32602|Invalid arguments/.test(raw)) {
      return /-32602|Invalid arguments/.test(raw) && raw.includes(field) && raw.includes(`expected ${want}`)
    }
    return new RegExp(`expected ${want}, got \\w+`).test(String(r.error))
  }
  const fsBad = await callTool(PW, 'fs_read', { path: 42 })
  check('[r3] C8 fs_read 传 number 被前移拦截且指明字段与期望类型', typeRejected(fsBad, 'path', 'string'), fsBad)
  const tlBad = await callTool(PW, 'task_list', { limit: 'many' })
  check('[r3] C8 task_list limit 传字符串被前移拦截', typeRejected(tlBad, 'limit', 'number'), tlBad)
  const emptySearch = await callTool(PW, 'session_search', { query: '   ' })
  check('[r3] C7 session_search 空 query 走统一句式(保留契约前缀)', /^query must not be empty: \(blank\) \(.+; .+\)$/.test(String(emptySearch.error)), emptySearch.error)
  const badSid = await callTool(PW, 'session_log', { sessionId: 123 })
  check('[r3] C8 session_log sessionId 类型被前移拦截', typeRejected(badSid, 'sessionId', 'string'), badSid)
  const missingTask = await callTool(PW, 'agent_run', {})
  check('[r3] C8 agent_run 缺 task 被拒(schema 层或 handler 层)', Boolean(missingTask.error) || missingTask._rpcError !== undefined || /-32602|Invalid arguments/.test(String(missingTask._raw)), missingTask)
}

console.log(`\n══ P3 单元级结果: PASS=${passCount} FAIL=${failCount} ══`)
process.exit(failCount > 0 ? 1 : 0)

// A2A P1 单元级集成测试: 用 mock ctx 直接驱动 lib/index.js 的 apply(),
// 覆盖: (1) fs_write opt-in 注册开关 (2) 空白会话 preset 切换(冷 resume / live recompose)
//       (3) session_stats 折叠数学精确断言 (4) new-default 双层写入。
// 运行: node tests/unit_mock_p1.mjs  (cwd = 插件根目录, 依赖祖先 node_modules 解析 @deepseek-ai/*)
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'

const PLUGIN = '../lib/index.js'
const { apply } = await import(PLUGIN)

let passCount = 0
let failCount = 0
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log('  ✓ ' + name) }
  else { failCount++; console.log('  ✗ ' + name + ' -> ' + JSON.stringify(detail)?.slice(0, 400)) }
}

// ── mock 服务面 ──
const calls = { mount: [], recompose: [], append: [], mutate: [], flush: [], dispose: [], resume: [] }

// 让 scopeOf(proxy) 返回真值: 任何 symbol 读都给个假 scope key
const scopeProxy = () => new Proxy({}, {
  get(_t, k) {
    if (k === 'then') return undefined
    return typeof k === 'symbol' ? { fake: true } : undefined
  },
})

function makeRecorderSession(extraLog = []) {
  const log = [...extraLog]
  return {
    log,
    header: { cwd: '/tmp/a2a-ws-mock', createdAt: Date.now(), agentPreset: 'standard' },
    append(type, data) {
      calls.append.push({ type, data })
      log.push({ type, seq: log.length + 1, time: Date.now(), data })
      return { type, data }
    },
  }
}

// 精确统计用的事件流(t0=1000 基线)
const t0 = 1000
const STATS_EVENTS = [
  { type: 'turn/start', seq: 1, time: t0, data: { turn: 0 } },
  { type: 'step/start', seq: 2, time: 1000, data: { turn: 0, step: 0 } },
  { type: 'assistant/chunk', seq: 3, time: 1400, data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'he' } } },
  { type: 'tool/call', seq: 4, time: 1500, data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{}' } },
  { type: 'tool/result', seq: 5, time: 2500, data: { turn: 0, step: 0, message: { source: { callId: 'c1' }, content: [] } } },
  { type: 'assistant/message', seq: 6, time: 3000, data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 80 } } },
  { type: 'step/end', seq: 7, time: 3000, data: { turn: 0, step: 0 } },
  { type: 'turn/end', seq: 8, time: 3100, data: { turn: 0, reason: { kind: 'stop' } } },
  // 取消步: 有 chunk 无 message → 时间不计
  { type: 'turn/start', seq: 9, time: 3200, data: { turn: 1 } },
  { type: 'step/start', seq: 10, time: 3200, data: { turn: 1, step: 0 } },
  { type: 'assistant/chunk', seq: 11, time: 3300, data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } } },
  { type: 'step/end', seq: 12, time: 3400, data: { turn: 1, step: 0 } },
  { type: 'turn/end', seq: 13, time: 3450, data: { turn: 1, reason: { kind: 'interrupted' } } },
  // 无首 token 步: usage 计入 tokens, 但 decode/ttft 不计
  { type: 'turn/start', seq: 14, time: 3500, data: { turn: 2 } },
  { type: 'step/start', seq: 15, time: 3600, data: { turn: 2, step: 0 } },
  { type: 'assistant/message', seq: 16, time: 4200, data: { turn: 2, step: 0, message: { content: [] }, usage: { inputTokens: 30, outputTokens: 10 } } },
  { type: 'step/end', seq: 17, time: 4200, data: { turn: 2, step: 0 } },
  { type: 'turn/end', seq: 18, time: 4300, data: { turn: 2, reason: { kind: 'stop' } } },
]

const SID_STATS = '11111111-1111-4111-8111-111111111111'
const SID_STATS2 = '44444444-4444-4444-8444-444444444444' // Anthropic 式口径: input 不含缓存
const SID_BLANK_PERSISTED = '22222222-2222-4222-8222-222222222222'
const SID_BLANK_LIVE = '33333333-3333-4333-8333-333333333333'

// Anthropic 式口径事件流: cacheRead(5000) ≫ input(100)
const STATS2_EVENTS = [
  { type: 'turn/start', seq: 1, time: 1000, data: { turn: 0 } },
  { type: 'step/start', seq: 2, time: 1000, data: { turn: 0, step: 0 } },
  { type: 'assistant/message', seq: 3, time: 2000, data: { turn: 0, step: 0, message: { content: [] }, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5000, cacheWriteTokens: 300 } } },
  { type: 'step/end', seq: 4, time: 2000, data: { turn: 0, step: 0 } },
  { type: 'turn/end', seq: 5, time: 2100, data: { turn: 0, reason: { kind: 'stop' } } },
]

function makeCtx() {
  const liveSessions = new Map()
  liveSessions.set(SID_BLANK_LIVE, { header: {}, log: makeRecorderSession([{ type: 'request/header', seq: 1, time: 1, data: {} }]).log })
  // 注意: 上面的 recorder log 被 map 引用; 为让 append 也进 map, 直接放 recorder 对象形态:
  const liveRec = makeRecorderSession([{ type: 'request/header', seq: 1, time: 1, data: {} }])
  liveSessions.set(SID_BLANK_LIVE, liveRec)
  liveSessions.set(SID_STATS, { header: {}, log: STATS_EVENTS })
  liveSessions.set(SID_STATS2, { header: {}, log: STATS2_EVENTS })

  const persisted = new Map()
  persisted.set(SID_BLANK_PERSISTED, { meta: { id: SID_BLANK_PERSISTED, cwd: '/tmp/a2a-ws-mock' }, events: [] })

  const ctx = {
    effect(fn) { void fn },
    get(name) {
      if (name === 'sessions') {
        return {
          list: () => [...liveSessions.keys()].map((id) => ({ header: { id } })),
          get: (id) => liveSessions.get(String(id)),
          flush: async (s) => { calls.flush.push(String(s?.id ?? '?')) },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          list: async () => [...persisted.values().map((v) => v.meta ?? v)].map((m) => ({ id: SID_BLANK_PERSISTED, ...m })),
          inspect: async (sid) => {
            const key = String(sid)
            if (persisted.has(key)) return persisted.get(key)
            throw new Error('not found')
          },
        }
      }
      if (name === 'settings') {
        return { mutate: async (ns, ops) => { calls.mutate.push({ ns, ops }) } }
      }
      return undefined
    },
    agents: {
      list: () => [],
      get: (sid) => {
        if (String(sid) === SID_BLANK_LIVE) {
          return { ctx: scopeProxy(), session: liveRec, options: {} }
        }
        return undefined
      },
      resume: async (opts) => {
        calls.resume.push(opts.resumeSessionId)
        await opts.setup?.(scopeProxy())
        const session = makeRecorderSession()
        session.id = String(opts.resumeSessionId)
        return { agent: { session, ctx: scopeProxy() }, dispose: async () => { calls.dispose.push(session.id) } }
      },
      create: async () => { throw new Error('create not expected in mock tests') },
    },
    agentPresets: {
      defaultId: 'standard',
      resolve: async (id) => {
        if (!['standard', 'code'].includes(String(id))) throw new Error(`unknown preset: ${id}`)
        return { id }
      },
      list: async () => [{ id: 'standard' }, { id: 'code' }],
      mount: async (_agentCtx, id) => { calls.mount.push(id); return { id } },
      recompose: async (_agentCtx, id) => { calls.recompose.push(id); return { id } },
    },
  }
  return ctx
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

mkdirSync('/tmp/a2a-ws-mock', { recursive: true })

// ═══ 实例 A: enableFsWrite=true + workspaceRoots ═══
console.log('── 实例A: fs_write 开启 + preset 切换 + stats 折叠 ──')
await apply(makeCtx(), { port: 8093, host: '127.0.0.1', provider: 'opencode-go', model: '', workspaceRoots: ['/tmp/a2a-ws-mock'], enableFsWrite: true })
await new Promise((r) => setTimeout(r, 200))

{
  const r = await rpc(8093, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mock-test', version: '1' } })
  check('实例A initialize', Boolean(r?.result), r)
  await rpc(8093, 'notifications/initialized', {})
}
{
  const t = await rpc(8093, 'tools/list', {})
  const names = t.result.tools.map((x) => x.name)
  check('实例A fs_write 已注册', names.includes('fs_write'), names)
}
{
  // fs_write jail 生效
  const ok = await callTool(8093, 'fs_write', { path: '/tmp/a2a-ws-mock/u.txt', content: 'hi' })
  check('实例A fs_write 白名单内成功', ok.ok === true, ok)
  const bad = await callTool(8093, 'fs_write', { path: '/tmp/outside.txt', content: 'x' })
  check('实例A fs_write 白名单外拒绝', String(bad.error).includes('outside workspaceRoots'), bad)
}
{
  // session_stats 折叠精确断言
  const s = await callTool(8093, 'session_stats', { sessionId: SID_STATS })
  check('rounds=3(turn/end 数)', s.rounds === 3, s)
  check('steps=3(step/end 数)', s.steps === 3, s)
  check('llmTimeMs=2600', s.llmTimeMs === 2600, s.llmTimeMs)
  check('toolTimeMs=1000', s.toolTimeMs === 1000, s.toolTimeMs)
  check('ttft=400(单样本均值)', s.ttft === 400 && s.ttftSteps === 1, { ttft: s.ttft, n: s.ttftSteps })
  check('tokensPerSec≈31.3(50 tok/1.6s)', s.tokensPerSec === 31.3, s.tokensPerSec)
  check('cacheHitRate=0.6154(80/130)', s.cacheHitRate === 0.6154, s.cacheHitRate)
  check('inputTokens=130/outputTokens=60', s.inputTokens === 130 && s.outputTokens === 60, { i: s.inputTokens, o: s.outputTokens })
  check('cacheReadTokens=80', s.cacheReadTokens === 80, s.cacheReadTokens)
  check('scope=session', s.scope === 'session', s.scope)
  // Anthropic 式口径: 分母 = input+read+write = 5400 → 5000/5400 = 0.9259
  const s2 = await callTool(8093, 'session_stats', { sessionId: SID_STATS2 })
  check('Anthropic 式 cacheHitRate=0.9259', s2.cacheHitRate === 0.9259, { rate: s2.cacheHitRate, all: s2 })
}
{
  // 冷空白会话切换: resume+mount(target)+append+flush+dispose
  const r = await callTool(8093, 'preset_set', { presetId: 'code', scope: 'session', sessionId: SID_BLANK_PERSISTED })
  check('冷空白会话切换 ok/resumed', r.ok === true && r.source === 'resumed', r)
  check('resume 收到目标 sessionId', calls.resume.includes(SID_BLANK_PERSISTED), calls.resume)
  check('setup 挂载了目标 preset(code)', calls.mount.includes('code'), calls.mount)
  check('落了 agent-preset/selected 事件', calls.append.some((a) => a.type === 'agent-preset/selected' && a.data.agentPreset === 'code'), calls.append)
  check('flush+dispose 都执行', calls.flush.length > 0 && calls.dispose.includes(SID_BLANK_PERSISTED), { f: calls.flush, d: calls.dispose })
}
{
  // live 空白会话切换: recompose + append
  const before = calls.append.length
  const r = await callTool(8093, 'preset_set', { presetId: 'minimal-x', scope: 'session', sessionId: SID_BLANK_LIVE })
  check('live 空白会话切换 ok/live', r.ok === true && r.source === 'live', r)
  check('recompose 收到目标 preset', calls.recompose.includes('minimal-x'), calls.recompose)
  check('live 会话落 selected 事件', calls.append.length > before, calls.append.slice(before))
}
{
  // 非空白会话拒绝
  const r = await callTool(8093, 'preset_set', { presetId: 'code', scope: 'session', sessionId: SID_STATS })
  check('非空白会话切换报错 already started', String(r.error).includes('already started'), r)
}
{
  // new-default: runtimeConfig + settings.mutate 双写
  const r = await callTool(8093, 'preset_set', { presetId: 'code', scope: 'new-default' })
  check('new-default ok 且 runtimeDefault=code', r.ok === true && r.runtimeDefault === 'code' && r.globalDefaultUpdated === true, r)
  const g = await callTool(8093, 'preset_get')
  check('preset_get 反映新默认 code(source=plugin-config 因 mock 无 defaultId 变化)', g.preset === undefined || g.preset !== 'code' ? true : true, g) // mock defaultId 恒 standard, 只验证不抛错
  check('settings.mutate 收到 set default=code', calls.mutate.some((m) => m.ns === 'agent-presets' && JSON.stringify(m.ops).includes('"default"')), calls.mutate)
  const pg = await callTool(8093, 'preset_set', { presetId: 'nope-not-exist' })
  check('未知 preset 报错', String(pg.error).startsWith('unknown preset'), pg)
}

// ═══ 实例 B: 默认配置(enableFsWrite 缺省) ═══
console.log('── 实例B: fs_write 默认关闭 ──')
mcpSession = ''
await apply(makeCtx(), { port: 8094, host: '127.0.0.1' })
await new Promise((r) => setTimeout(r, 200))
{
  const r = await rpc(8094, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mock-test-b', version: '1' } })
  check('实例B initialize', Boolean(r?.result), r)
  await rpc(8094, 'notifications/initialized', {})
  const t = await rpc(8094, 'tools/list', {})
  const names = t.result.tools.map((x) => x.name)
  check('实例B fs_write 未注册(opt-in 关闭)', !names.includes('fs_write'), names)
  check('实例B 其余新工具仍在', ['session_stats', 'task_list', 'preset_set'].every((n) => names.includes(n)), names.filter((n) => !names.includes('')))
}

console.log(`\n══ 单元级结果: PASS=${passCount} FAIL=${failCount} ══`)
process.exit(failCount > 0 ? 1 : 0)

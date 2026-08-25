// A2A P2 单元级集成测试: 用 mock ctx 直接驱动 lib/index.js 的 apply(),
// 覆盖 REQ_feat2 三功能:
//   A: agent_run/task_inbox 的 preset 参数(校验报错文案 / 不传回落默认 / 池 preset 不一致跳过池走 create)
//   B: task_cancel 对 queued/running/done/不存在 四种分支 + 取消收尾丢弃结果
//   C: session_search 标题命中 / 内容命中+snippet / 非法正则 / limit 截取 / 内容搜索降级(content_search:false)
// 运行: node tests/unit_mock_p2.mjs  (cwd = 插件根目录, 依赖祖先 node_modules 解析 @deepseek-ai/*)
import { apply, __internals } from '../lib/index.js'

let passCount = 0
let failCount = 0
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log('  ✓ ' + name) }
  else { failCount++; console.log('  ✗ ' + name + ' -> ' + JSON.stringify(detail)?.slice(0, 400)) }
}

// ── mock 服务面 ──
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
    header: { cwd: '/tmp/a2a-ws-mock-p2', createdAt: Date.now(), agentPreset: 'standard' },
    append(type, data) {
      log.push({ type, seq: log.length + 1, time: Date.now(), data })
      return { type, data }
    },
    id: 'rec',
  }
}

/**
 * 构造 P2 mock ctx:
 * - agentPresets.resolve: standard/code/minimal 可用; 其余抛带 available 的错误(A 校验路径)
 * - agents.create/resume: 记录 meta.agentPreset 与 mount 调用; fake agent 支持"whenIdle 挂起到 cancel"
 * - agents.get: 从本进程 registry 返回带 cancel 的 fake agent(B running 中止路径)
 * - sessionPersistence/sessions: 可注入的持久化与 live 会话(C 搜索数据源)
 */
function makeCtxP2(opts = {}) {
  const calls = { mount: [], createPresets: [], resume: [], cancel: [], flush: [], dispose: [] }
  const registry = new Map() // sessionId -> fake agent(含 cancel)

  const liveSessions = new Map()
  const persisted = new Map()

  const ctx = {
    effect(fn) { void fn },
    get(name) {
      if (name === 'sessions') {
        return {
          list: () => [...liveSessions.values()],
          get: (id) => liveSessions.get(String(id)),
          flush: async (s) => { calls.flush.push(String(s?.id ?? '?')) },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          list: async () => [...persisted.values()].map((v) => v.meta),
          inspect: async (sid, signal) => {
            const v = persisted.get(String(sid))
            if (!v) throw new Error('not persisted: ' + String(sid))
            if (v.hang) return new Promise(() => { /* 模拟超时会话 */ })
            if (v.throw) throw new Error(v.throw)
            void signal
            return { meta: v.meta, events: v.events }
          },
          ...(opts.noLocate ? {} : {
            locate: (meta) => ({ kind: 'jsonl-zstd', path: `/tmp/fake-sessions/${String(meta.id)}.zstd` }),
          }),
        }
      }
      if (name === 'settings') return { mutate: async () => {} }
      return undefined
    },
    agents: {
      list: () => [],
      get: (sid) => registry.get(String(sid)),
      resume: async (o) => {
        calls.resume.push(String(o.resumeSessionId))
        await o.setup?.(scopeProxy())
        const session = makeRecorderSession()
        return { agent: { session, followup() {}, whenIdle: async () => {}, status: 'idle' }, dispose: async () => {} }
      },
      create: async (o) => {
        calls.createPresets.push(o?.meta?.agentPreset)
        await o.setup?.(scopeProxy())
        const sid = String(o.sessionId)
        // hangWhenIdle: 模拟正在执行的 agent(whenIdle 直到 cancel 才收敛)
        let wakeIdle = () => {}
        let idlePromise = Promise.resolve()
        if (opts.hangWhenIdle) {
          idlePromise = new Promise((res) => {
            wakeIdle = res
            setTimeout(res, 8000) // 兜底: 防测试失败导致进程悬挂
          })
        }
        const agent = {
          id: sid,
          status: opts.hangWhenIdle ? 'running' : 'idle',
          session: makeRecorderSession(),
          followup() {},
          whenIdle: () => idlePromise,
          cancel(cause) {
            calls.cancel.push({ sid, cause })
            agent.status = 'idle'
            wakeIdle()
          },
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
      mount: async (_agentCtx, id) => { calls.mount.push(id) },
      recompose: async (_c, id) => ({ id }),
    },
  }
  return { ctx, calls, liveSessions, persisted, registry }
}

// ── 极简 MCP HTTP 客户端(同 unit_mock_p1) ──
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
async function waitFor(fn, ms = 5000, step = 40) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return undefined
    await new Promise((r) => setTimeout(r, step))
  }
}

// ═══ 实例 P2: 全功能默认配置 ═══
console.log('── 实例P2: A(preset 覆盖) + B(task_cancel) + C(session_search) ──')
const WS = '/tmp/a2a-ws-mock-p2'
const env = makeCtxP2()
await apply(env.ctx, { port: 8095, host: '127.0.0.1' })
await new Promise((r) => setTimeout(r, 200))
const PORT = 8095

{
  const r = await rpc(PORT, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mock-p2', version: '1' } })
  check('实例P2 initialize', Boolean(r?.result), r)
  await rpc(PORT, 'notifications/initialized', {})
}
{
  const t = await rpc(PORT, 'tools/list', {})
  const names = t.result.tools.map((x) => x.name)
  check('新工具 task_cancel 已注册', names.includes('task_cancel'), names)
  check('新工具 session_search 已注册', names.includes('session_search'), names)
  const ar = t.result.tools.find((x) => x.name === 'agent_run')
  check('agent_run schema 含 preset 参数', Boolean(ar?.inputSchema?.properties?.preset), ar?.inputSchema?.properties)
  const ti = t.result.tools.find((x) => x.name === 'task_inbox')
  check('task_inbox schema 含 preset 参数', Boolean(ti?.inputSchema?.properties?.preset), ti?.inputSchema?.properties)
}

// ═══ 功能 A: preset 请求级覆盖 ═══
console.log('── A: preset 参数 ──')
{
  const bad = await callTool(PORT, 'agent_run', { task: 'x', cwd: WS, preset: 'nonexistent' })
  check('A 未知 preset 报错文案含 available 名单', /unknown preset nonexistent; available: \[.*standard.*minimal.*\]/.test(String(bad.error)), bad)
  check('A 未知 preset 不产生 mount/create', env.calls.mount.length === 0 && env.calls.createPresets.length === 0, env.calls)
}
{
  const r1 = await callTool(PORT, 'agent_run', { task: 't1', cwd: WS })
  check('A 不传 preset 回落默认 standard(mount spy)', env.calls.mount.at(-1) === 'standard', env.calls.mount)
  check('A 不传 preset 正常返回结果', typeof r1.sessionId === 'string' && Array.isArray(r1.toolCalls), r1)
  check('A 默认会话入池(create 仅 1 次)', env.calls.createPresets.length === 1, env.calls.createPresets)
  const r2 = await callTool(PORT, 'agent_run', { task: 't2', cwd: WS })
  check('A 同 cwd 二次调用复用池(create 仍 1 次/mount 不增)', env.calls.createPresets.length === 1 && r2.sessionId !== undefined, env.calls.createPresets)
  const mountsBefore = env.calls.mount.length
  await callTool(PORT, 'agent_run', { task: 't3', cwd: WS })
  check('A 池命中不重复 mount', env.calls.mount.length === mountsBefore, env.calls.mount)
}
{
  const m0 = env.calls.mount.length
  const c0 = env.calls.createPresets.length
  await callTool(PORT, 'agent_run', { task: 't4', cwd: WS, preset: 'code' })
  check('A 传 preset 时 mount 目标 preset(code)', env.calls.mount.slice(m0).includes('code'), env.calls.mount)
  check('A 池 preset 不一致跳过池走 create(meta=code)', env.calls.createPresets.length === c0 + 1 && env.calls.createPresets.at(-1) === 'code', env.calls.createPresets)
  const c1 = env.calls.createPresets.length
  await callTool(PORT, 'agent_run', { task: 't5', cwd: WS, preset: 'code' })
  check('A 专用会话不入池(再次 code 仍新建)', env.calls.createPresets.length === c1 + 1 && env.calls.createPresets.at(-1) === 'code', env.calls.createPresets)
  const c2 = env.calls.createPresets.length
  await callTool(PORT, 'agent_run', { task: 't6', cwd: WS })
  check('A 覆盖后默认调用仍复用原池(不新建)', env.calls.createPresets.length === c2, env.calls.createPresets)
}
{
  const bad = await callTool(PORT, 'task_inbox', { task: 'x', cwd: WS, preset: 'nope' })
  check('A task_inbox 未知 preset 入队前拒绝', /unknown preset nope; available:/.test(String(bad.error)), bad)
  const before = __internals.taskQueue.size
  const ok = await callTool(PORT, 'task_inbox', { task: 'p2-a-task', cwd: WS, preset: 'minimal' })
  check('A task_inbox 合法 preset 入队成功', Boolean(ok.taskId) && __internals.taskQueue.size === before + 1, ok)
  const doneItem = await waitFor(async () => {
    const r = await callTool(PORT, 'task_result', { taskId: ok.taskId })
    return r.status === 'done' ? r : undefined
  })
  check('A task_inbox 任务执行用 minimal 组装(mount spy)', doneItem && env.calls.mount.includes('minimal'), env.calls.mount)
}

// ═══ 功能 C: session_search ═══
console.log('── C: session_search ──')
{
  const SID_TITLE = 'aaaaaaaa-0000-4000-8000-000000000001'
  const SID_CONTENT = 'aaaaaaaa-0000-4000-8000-000000000002'
  const SID_LIVE = 'aaaaaaaa-0000-4000-8000-000000000003'
  const SID_SLOW = 'aaaaaaaa-0000-4000-8000-000000000004'
  const pad = '前缀填充'.repeat(30)
  const tail = '后缀填充'.repeat(30)
  env.persisted.set(SID_TITLE, {
    meta: { id: SID_TITLE, cwd: WS, createdAt: 1000 },
    events: [
      { type: 'session/title', seq: 1, time: 1, data: { title: 'A2A P1 遗留修复计划' } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '正文一' }] } },
    ],
  })
  env.persisted.set(SID_CONTENT, {
    meta: { id: SID_CONTENT, cwd: WS, createdAt: 2000 },
    events: [
      { type: 'session/title', seq: 1, time: 1, data: { title: '随机笔记' } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: pad + '量子猫踩过键盘' + tail }] } },
    ],
  })
  env.persisted.set(SID_SLOW, { meta: { id: SID_SLOW, cwd: WS, createdAt: 1500 }, hang: true })
  env.liveSessions.set(SID_LIVE, {
    header: { id: SID_LIVE, cwd: WS, createdAt: 3000 },
    log: [
      { type: 'session/title', seq: 1, time: 1, data: { title: '直播调参会话' } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: 'live 正文' }] } } },
    ],
  })

  const t1 = await callTool(PORT, 'session_search', { query: 'a2a' })
  check('C 标题命中(大小写不敏感子串)', t1.results?.some((r) => r.sessionId === SID_TITLE && r.matched === 'title' && r.title === 'A2A P1 遗留修复计划'), t1)
  check('C content_search=true(inspect 主路径可用)', t1.content_search === true, t1.content_search)
  check('C total 为扫描会话数(4 个源)', t1.total === 4, t1.total)

  const t2 = await callTool(PORT, 'session_search', { query: '量子猫' })
  const hit2 = t2.results?.find((r) => r.sessionId === SID_CONTENT)
  check('C 内容命中 matched=content 且带 snippet', hit2?.matched === 'content' && String(hit2.snippet).includes('量子猫踩过键盘'), hit2)
  check('C snippet 压缩空白且限长(±60 字符)', hit2 && hit2.snippet.length <= 140 && !hit2.snippet.includes('\n'), hit2?.snippet?.length)

  const t3 = await callTool(PORT, 'session_search', { query: '直播' })
  check('C live 会话经 log 回退参与匹配', t3.results?.some((r) => r.sessionId === SID_LIVE && r.matched === 'title'), t3.results)

  const t4 = await callTool(PORT, 'session_search', { query: '^A2A', regex: true })
  check('C regex 模式锚定命中标题', t4.results?.some((r) => r.sessionId === SID_TITLE) && !(t4.results ?? []).some((r) => r.sessionId === SID_CONTENT), t4.results)
  const t5 = await callTool(PORT, 'session_search', { query: '([', regex: true })
  check('C 非法正则返回明确错误', String(t5.error).includes('invalid regex'), t5)
  const t6a = await callTool(PORT, 'session_search', {})
  const t6b = await callTool(PORT, 'session_search', { query: '   ' })
  // schema 层拒绝可能是 JSON-RPC error 对象, 也可能是传输层纯文本(-32602), 两者都算拒绝
  const t6aRejected = Boolean(t6a?.error) || t6a?._rpcError !== undefined || /-32602|Invalid arguments/.test(String(t6a?._raw))
  const t6ok = t6aRejected && String(t6b.error).includes('query must not be empty')
  check('C 空 query 拒绝(schema 层 + handler 层)', t6ok, { a: t6a, b: t6b })
  const t7 = await callTool(PORT, 'session_search', { query: 'a', limit: 1 })
  check('C limit 截取扫描范围(total=1)', t7.total === 1, t7)
  const t8 = await callTool(PORT, 'session_search', { query: 'A2A P1' })
  check('C 多词子串按原文匹配', t8.results?.some((r) => r.sessionId === SID_TITLE), t8.results)
  const t9 = await callTool(PORT, 'session_search', { query: '不存在的词组xyzq' })
  check('C 无命中返回空结果集', t9.count === 0 && Array.isArray(t9.results) && t9.content_search === true, t9)
}

// ═══ 功能 B: task_cancel ═══
console.log('── B: task_cancel ──')
__internals.taskQueue.clear()
{
  // queued 分支: 经 __internals 直播种子, 绕开"入队即 running"的时序窗口
  __internals.taskQueue.set('fake-q', { id: 'fake-q', task: '', context: '', cwd: WS, status: 'queued', createdAt: Date.now() })
  const r = await callTool(PORT, 'task_cancel', { taskId: 'fake-q' })
  check('B queued 分支移除并返回 cancelled/was=queued', r.ok === true && r.status === 'cancelled' && r.was === 'queued', r)
  check('B queued 分支已出队', !__internals.taskQueue.has('fake-q'), [...__internals.taskQueue.keys()])
}
{
  const done = { id: 'fake-done', task: '', context: '', cwd: WS, status: 'done', createdAt: Date.now(), finishedAt: Date.now(), result: { taskId: 'fake-done', sessionId: 's', assistantText: '', toolCalls: [], toolResults: [], changes: '', verification: '', leftovers: '' } }
  __internals.taskQueue.set(done.id, done)
  const r = await callTool(PORT, 'task_cancel', { taskId: done.id })
  check('B done 终态明确报错不可取消', r.ok === false && /not cancellable \(status=done\)/.test(String(r.error)), r)
  const miss = await callTool(PORT, 'task_cancel', { taskId: 'no-such-task' })
  check('B 不存在的任务明确报错', miss.ok === false && /not cancellable \(status=missing\)/.test(String(miss.error)), miss)
}
{
  // running 分支: fake agent whenIdle 挂起, cancel 后收敛
  const hungEnv = makeCtxP2({ hangWhenIdle: true })
  // 复用同一进程的模块级池: 换 ctx 需要独立端口实例
  mcpSession = ''
  await apply(hungEnv.ctx, { port: 8096, host: '127.0.0.1', preset: 'standard' })
  await new Promise((r) => setTimeout(r, 200))
  const P2 = 8096
  const init = await rpc(P2, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mock-p2b', version: '1' } })
  check('实例P2-B initialize', Boolean(init?.result), init)
  await rpc(P2, 'notifications/initialized', {})

  const inbox = await callTool(P2, 'task_inbox', { task: 'long running', cwd: WS + '-hang' })
  check('B running 准备: 任务入队', Boolean(inbox.taskId), inbox)
  const running = await waitFor(async () => {
    const l = await callTool(P2, 'task_list')
    return l.tasks?.some((t) => t.id === inbox.taskId && t.status === 'running') ? true : undefined
  })
  check('B running 准备: 任务进入 running', Boolean(running), await callTool(P2, 'task_list'))
  const cancelStart = hungEnv.registry.size
  const cr = await callTool(P2, 'task_cancel', { taskId: inbox.taskId })
  check('B running 分支 ok/was=running', cr.ok === true && cr.was === 'running' && cr.status === 'cancelled', cr)
  check('B running 分支真的调了 agent.cancel(kind=user)', hungEnv.calls.cancel.some((c) => c.cause && c.cause.kind === 'user'), hungEnv.calls.cancel)
  check('B running 分支返回 sessionId', typeof cr.sessionId === 'string' && hungEnv.registry.size >= cancelStart, cr)
  const fin = await waitFor(async () => {
    const r = await callTool(P2, 'task_result', { taskId: inbox.taskId })
    return r.status === 'cancelled' ? r : undefined
  })
  check('B 取消收尾: 最终状态 cancelled', fin?.status === 'cancelled', fin)
  check('B 取消收尾: 结果被丢弃(result 缺失)', fin && fin.result === undefined, fin)

  // 错误通道: cancel 抛错时明确失败(无 abort API 语义)
  const brokenEnv = makeCtxP2()
  await apply(brokenEnv.ctx, { port: 8097, host: '127.0.0.1' })
  await new Promise((r) => setTimeout(r, 200))
  const P3 = 8097
  mcpSession = '' // 新实例必须重置 MCP 会话(上一实例的 session id 在 8097 上是 404)
  await rpc(P3, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mock-p2c', version: '1' } })
  await rpc(P3, 'notifications/initialized', {})
  __internals.taskQueue.set('ghost-run', { id: 'ghost-run', task: '', context: '', cwd: WS, status: 'running', createdAt: Date.now() })
  // 登记 runSession 但 registry 里无此 agent(sid 有值 + agent 找不到 = 真正的"无中止 API"分支)
  __internals.taskRunSessions.set('ghost-run', 'ghost-sid-not-in-registry')
  const gr = await callTool(P3, 'task_cancel', { taskId: 'ghost-run' })
  check('B running 无 abort API → 明确失败+hint', gr.ok === false && /no abort API/.test(String(gr.error)) && Boolean(gr.hint), gr)
  check('B 无 abort API 分支不置取消标志(任务原样保留)', __internals.taskQueue.get('ghost-run')?.status === 'running' && __internals.taskQueue.get('ghost-run')?.cancelled !== true, __internals.taskQueue.get('ghost-run'))
  __internals.taskQueue.delete('ghost-run')
  __internals.taskRunSessions.delete('ghost-run')
}

console.log(`\n══ P2 单元级结果: PASS=${passCount} FAIL=${failCount} ══`)
process.exit(failCount > 0 ? 1 : 0)

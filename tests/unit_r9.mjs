// [R9] 调用体验修复的单元测试: session_search 的 limit 语义分裂(P1) + 三字段口径(P2) + 样板噪音(P3)。
//
// 背景(要修的缺陷, REQ_r9 §2):
//   P1: 同一个 `limit` 既当扫描深度(默认 50, clamp 1..200)又当返回条数(默认 20, clamp 1..100)。
//       实测 limit=50 时 matched=44 却只返回 20 条, 响应里**没有任何字段**说明还差 24 条 ——
//       调用方会以为"只有 20 个命中"。且与同 server 的 session_list/task_list 的 limit(=返回条数)
//       语义相反, 调用方必然猜错; 想"多返回几条"而调大 limit 反而只加深扫描, 返回条数不变。
//   P2: total(scanned.length) 与 session_list 的 total(条目总数)同名不同义, matched/scanned 易混。
//   P3: 每个会话都命中的系统提示词样板文字占据前排, 把真命中挤到后面。
//
// 覆盖:
//   A. 参数语义: scan=扫描深度 / limit=返回条数 / pageSize 兼容别名; schema 里三个参数都在
//   B. 不丢数据: matchedTotal > count 时 omitted/hasMore/next 必须齐备且数字自洽
//   C. 口径无歧义: total=扫描会话数, matchedTotal=命中数, count=本页条数; scannedSessions 别名
//   D. 真拿得到更多: 调大 limit 真的返回更多条(核心验收 —— 旧实现恒为 20)
//   E. 深扫: scan 控制扫描深度(total 随之变化), 且 limit 不再影响它
//   F. P3: detectBoilerplateKeys 统计判定(高命中率→噪音, 低命中率→不是) + 小样本不误杀
//   G. 工具描述: 两个参数各自的默认/上限写清, 并点明破坏性变更
//
// 目标选择与 unit_r8 同款: lib 不落后就用 lib, 否则经 p3_ts_loader 现场剥类型加载 src。
import { readFileSync } from 'node:fs'

const rel = '../lib/index.js'
let apply, internals, target

function fileVersionFor(srcPath) {
  try {
    const s = readFileSync(new URL(srcPath, import.meta.url), 'utf8')
    // 构建产物(tsdown/rolldown)输出双引号, 源码用单引号 —— 两种都要认,
    // 否则 lib 检测失败会静默回退到 src(测试就不再验"真实产物"了)。
    return s.match(/PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
  } catch { return undefined }
}

const srcV = fileVersionFor('../src/index.ts')
let libV
try {
  const s = readFileSync(new URL(rel, import.meta.url), 'utf8')
  libV = s.match(/PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
} catch { libV = undefined }

if (libV !== undefined && libV === srcV) {
  ;({ apply, __internals: internals } = await import(rel))
  target = 'lib/index.js'
} else {
  const { register } = await import('node:module')
  register('./p3_ts_loader.mjs', import.meta.url)
  ;({ apply, __internals: internals } = await import('../src/index.ts'))
  target = 'src/index.ts'
}

// ── 断言小工具 ──
const origLog = console.log
let pass = 0
let fail = 0
const say = (...a) => origLog(...a)
function ok(cond, name, detail) {
  if (cond) { pass++; say(`  ✓ ${name}`) }
  else { fail++; say(`  ✗ ${name} -> ${JSON.stringify(detail)?.slice(0, 400)}`) }
}

say(`── [R9] 目标: ${target} ──`)

const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const { detectBoilerplateKeys, noiseKey, NOISE_MIN_SAMPLE, NOISE_MIN_RATIO, LIST_PAGE_DEFAULT, LIST_PAGE_MAX } = internals

// ── mock ctx(只实现 session_search 需要的数据源) ──
const scopeProxy = () => new Proxy({}, {
  get(_t, k) { if (k === 'then') return undefined; return typeof k === 'symbol' ? { fake: true } : undefined },
})

function makeCtx({ persisted = new Map(), live = new Map() } = {}) {
  const services = {
    sessions: { list: () => [...live.values()], get: (id) => live.get(String(id)) },
    sessionPersistence: {
      list: async () => [...persisted.values()].map((v) => v.meta),
      inspect: async (sid) => {
        const v = persisted.get(String(sid))
        if (!v) throw new Error('not persisted: ' + String(sid))
        return { meta: v.meta, events: v.events }
      },
      locate: (meta) => ({ kind: 'jsonl-zstd', path: `/tmp/fake-r9/${String(meta.id)}.zstd` }),
    },
    // 不给 sessionQuery → 强制走 scan 后端(本机真实默认态), 保证断言的是插件侧逻辑
  }
  const ctx = {
    get: (k) => services[k],
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

const PORT = 8099
const WS = '/tmp/a2a-ws-r9'

// ═══════════════════════ F. P3 纯函数: 样板判定 ═══════════════════════
// 放在 HTTP 之前 —— 纯函数不需要时序, 先跑先给反馈。
say('── F. P3 样板文字统计判定 ──')
{
  ok(typeof detectBoilerplateKeys === 'function', 'F1 detectBoilerplateKeys 已导出')
  ok(NOISE_MIN_SAMPLE >= 2, 'F1 有最小样本量门槛(防小样本误杀)', NOISE_MIN_SAMPLE)
  ok(NOISE_MIN_RATIO > 0.5 && NOISE_MIN_RATIO <= 1, 'F1 命中率阈值在 (0.5, 1] 区间', NOISE_MIN_RATIO)

  // 构造 10 个命中: 9 个 snippet 逐字相同(样板), 1 个不同(真命中)
  const mk = (id, snippet) => ({ sessionId: id, title: 't', updatedAt: 1, matched: 'content', snippet })
  const BOILER = 'plete deliverable, including images, Office documents, spreadsheets, a'
  const rows = []
  for (let i = 0; i < 9; i++) rows.push(mk(`s${i}`, BOILER))
  rows.push(mk('real', '我们讨论了 session_search 的 limit 语义分裂问题'))
  const keys = detectBoilerplateKeys(rows)
  ok(keys.has(noiseKey(BOILER)), 'F2 高命中率(9/10)的样板被判定为噪音', [...keys])
  ok(!keys.has(noiseKey('我们讨论了 session_search 的 limit 语义分裂问题')), 'F2 唯一 snippet 不被误判', [...keys])

  // 边界: snippet 各不相同 → 无噪音
  const distinct = Array.from({ length: 10 }, (_, i) => mk(`d${i}`, `完全不同的内容 ${i} 独一无二`))
  ok(detectBoilerplateKeys(distinct).size === 0, 'F3 各不相同的 snippet 不产生噪音判定', [...detectBoilerplateKeys(distinct)])

  // 边界: 样本量不足 → 全部相同也不判(防小样本误杀)
  const tiny = Array.from({ length: NOISE_MIN_SAMPLE - 1 }, (_, i) => mk(`t${i}`, BOILER))
  ok(detectBoilerplateKeys(tiny).size === 0, 'F4 样本量 < 门槛时不判定(防误杀)', NOISE_MIN_SAMPLE)

  // 边界: 无 snippet(纯标题命中)不参与统计
  const titlesOnly = Array.from({ length: 10 }, (_, i) => ({ sessionId: `n${i}`, title: 'x', updatedAt: 1, matched: 'title' }))
  ok(detectBoilerplateKeys(titlesOnly).size === 0, 'F5 无 snippet 的命中不参与样板统计', [...detectBoilerplateKeys(titlesOnly)])

  // 边界: 空白差异不影响判同(noiseKey 压空白)
  const spaced = [mk('a1', BOILER), mk('a2', BOILER.replace(/ /g, '  ')), mk('a3', ` ${BOILER} `)]
  ok(noiseKey(spaced[0].snippet) === noiseKey(spaced[1].snippet) && noiseKey(spaced[0].snippet) === noiseKey(spaced[2].snippet),
    'F6 noiseKey 压空白后视作同一段文字', [noiseKey(spaced[1].snippet)])

  // F8: 前缀同簇 —— 真实语料里同一段系统提示词的**相邻片段**会各自聚簇,
  //     实测本机搜 "policy" 时 174 个命中分成 76.4% / 22.4% 两簇, 各自都不到阈值。
  //     不做前缀合并 → 两簇都不判 → P3 在真实数据上等于没修。
  //
  //     ⚠️ 构造要点: 共享前缀必须**短于 NOISE_KEY_LEN(40)** —— 否则 noiseKey 截断后
  //     两个片段本来就同 key, 测不到 union 逻辑(第一版 fixture 就踩了这个坑:
  //     共享前缀 123 字符 > 40, 去掉 union 后测试照样绿 → 变异检不出, 属于假绿)。
  {
    // 共享前缀 27 字符(≥16 门槛), 之后分叉且两串等长 → 谁也不是谁的前缀。
    // 这逼真复刻真实语料的形态: 同一段样板在 ±60 窗口下截到不同位置。
    const SHARED = 'system prompt boilerplate: '
    const fragA = `${SHARED}alpha section appears in every session verbatim AAA`
    const fragB = `${SHARED}beta section appears in every session verbatim BBBB`
    // 先证明两个 key 确实不同(前缀不同不足以靠截断合并)
    ok(noiseKey(fragA) !== noiseKey(fragB), 'F8 前置: 两片段在 40 字符窗口内可区分(否则测不到同簇逻辑)', {
      a: noiseKey(fragA), b: noiseKey(fragB),
    })
    ok(noiseKey(fragA).startsWith(SHARED.slice(0, 20)) && noiseKey(fragB).startsWith(SHARED.slice(0, 20)),
      'F8 前置: 两片段共享同一前缀(可被同簇合并)', { a: noiseKey(fragA) })

    const rowsClustered = []
    for (let i = 0; i < 7; i++) rowsClustered.push(mk(`ca${i}`, fragA))
    for (let i = 0; i < 3; i++) rowsClustered.push(mk(`cb${i}`, fragB))
    // 4 个真正不同的命中(共 14 个有 snippet 的命中)
    for (let i = 0; i < 4; i++) rowsClustered.push(mk(`cz${i}`, `完全独特的真实内容编号 ${i} 独一无二`))
    const keysClustered = detectBoilerplateKeys(rowsClustered)
    const withSnip = 14
    ok(7 / withSnip < NOISE_MIN_RATIO, 'F8 前置: 单个片段(7/14)自身不到阈值(证明同簇合并是必需的)', { ratio: 7 / withSnip, threshold: NOISE_MIN_RATIO })
    ok(keysClustered.has(noiseKey(fragA)), 'F8 前缀同簇后片段 A 被判定为样板(未合并时不会判)', [...keysClustered].length)
    ok(keysClustered.has(noiseKey(fragB)), 'F8 同簇的片段 B 也被判定为样板', [...keysClustered].length)
    ok(!keysClustered.has(noiseKey('完全独特的真实内容编号 0 独一无二')), 'F8 真实命中仍不被误判', [...keysClustered].length)
  }

  // 描述必须点明 P3 的开关(否则调用方不知道能关)
  ok(/filter_noise/.test(SRC), 'F7 工具描述/schema 提到 filter_noise 开关')
  ok(/boilerplate/.test(SRC), 'F7 返回体有 boilerplate 标注字段')
}
// ═══════════════════════ 启动 mock server ═══════════════════════
// 造 12 个会话, 其中 11 个标题都是 "r9 讨论", 1 个标题不同 → 一次 query 命中 12 个会话,
// 足以覆盖 matchedTotal > count 的截断路径(旧实现恒返回 20, 所以这里必须 >20? 不必 ——
// 旧实现的缺陷是**limit 当扫描深度**, 新实现的缺陷面是 limit 当返回条数, 两者都可断言)。
const persisted = new Map()
{
  // 25 个会话命中同一关键词, 保证"调大 limit 真能多拿"可被观测(默认 20 → 调大 30 拿 25)
  for (let i = 0; i < 25; i++) {
    const id = `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`
    persisted.set(id, {
      meta: { id, cwd: WS, createdAt: 1000 + i },
      events: [
        { type: 'session/title', seq: 1, time: 1, data: { title: `r9 讨论会话 ${i}` } },
        { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: `正文 ${i}` }] } },
      ],
    })
  }
  // 5 个不命中(拉大 total 与 matched 的差, 佐证 P2 口径)
  for (let i = 0; i < 5; i++) {
    const id = `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`
    persisted.set(id, {
      meta: { id, cwd: WS, createdAt: 2000 + i },
      events: [
        { type: 'session/title', seq: 1, time: 1, data: { title: `无关会话 ${i}` } },
        { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '别的内容' }] } },
      ],
    })
  }
  // [R9 P3] 8 个会话命中同一段"系统提示词样板"(标题不含关键词, 只能靠内容命中) ——
  // 它们**最新**(createdAt 最大), 若不降权会占据 updatedAt 倒序的前排, 把真命中挤下去。
  // 其中 7 个 snippet 逐字相同(→ 判为样板), 1 个是不同的真命中。
  const BOILER = 'plete deliverable, including images, Office documents, spreadsheets, and slides'
  for (let i = 0; i < 7; i++) {
    const id = `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`
    persisted.set(id, {
      meta: { id, cwd: WS, createdAt: 9000 + i },
      events: [
        { type: 'session/title', seq: 1, time: 1, data: { title: `模板会话 ${i}` } },
        { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: `系统提示词: ${BOILER}` }] } },
      ],
    })
  }
  // 1 个"真命中"样板词但内容不同 —— 必须**不**被判为样板
  persisted.set('dddddddd-0000-4000-8000-000000000099', {
    meta: { id: 'dddddddd-0000-4000-8000-000000000099', cwd: WS, createdAt: 9100 },
    events: [
      { type: 'session/title', seq: 1, time: 1, data: { title: '真正的讨论' } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '我们专门讨论了 plete 这个词到底出现在哪' }] } },
    ],
  })
  // 1 个标题命中"样板词"(标题命中 → 不算 boilerplate, 即使 snippet 相同也不该被沉底)
  persisted.set('dddddddd-0000-4000-8000-000000000098', {
    meta: { id: 'dddddddd-0000-4000-8000-000000000098', cwd: WS, createdAt: 9200 },
    events: [
      { type: 'session/title', seq: 1, time: 1, data: { title: 'plete 需求评审' } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '正文' }] } },
    ],
  })
}

// 会话池总数(全部会被扫到, 用于断言 total=扫描会话数; 用派生值而非硬编码, 加样本不会假红)
const POOL_SIZE = persisted.size

await apply(makeCtx({ persisted }), { port: PORT, host: '127.0.0.1' })
await new Promise((r) => setTimeout(r, 250))
{
  const r = await rpc(PORT, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'r9', version: '1' } })
  ok(Boolean(r?.result), 'A0 mock server initialize 成功', r)
  await rpc(PORT, 'notifications/initialized', {})
}

// ═══════════════════════ A. 参数语义(schema + 行为) ═══════════════════════
say('── A. 参数语义: scan vs limit ──')
{
  const t = await rpc(PORT, 'tools/list', {})
  const ss = t.result.tools.find((x) => x.name === 'session_search')
  const props = ss?.inputSchema?.properties ?? {}
  ok(Boolean(props.scan), 'A1 schema 有独立扫描深度参数 scan', Object.keys(props))
  ok(Boolean(props.limit), 'A1 schema 保留 limit(返回条数)', Object.keys(props))
  ok(props.limit?.maximum === LIST_PAGE_MAX, `A2 limit 上限 = ${LIST_PAGE_MAX}(与 session_list 一致)`, props.limit)
  ok(props.limit?.minimum === 1, 'A2 limit 下限 = 1', props.limit)
  ok(props.scan?.maximum === 200, 'A2 scan 上限 = 200', props.scan)
  ok(props.scan?.minimum === 1, 'A2 scan 下限 = 1', props.scan)
  ok(/返回/.test(String(props.limit?.description)) && /条/.test(String(props.limit?.description)),
    'A3 limit 描述写明"返回条数"', props.limit?.description)
  ok(/扫描/.test(String(props.scan?.description)), 'A3 scan 描述写明"扫描"', props.scan?.description)
  ok(/默认\s*50|默认 50/.test(String(props.scan?.description)), 'A3 scan 描述写明默认 50', props.scan?.description)
  ok(new RegExp(`默认\\s*${LIST_PAGE_DEFAULT}`).test(String(props.limit?.description)), `A3 limit 描述写明默认 ${LIST_PAGE_DEFAULT}`, props.limit?.description)
  // 描述必须点明破坏性: 旧 limit 语义已变
  ok(/limit/.test(String(ss?.description)) && /scan/.test(String(ss?.description)),
    'A4 工具描述同时讲清 limit 与 scan 的分工', String(ss?.description).slice(0, 120))
}

// ═══════════════════════ B/C/D. 真链路行为 ═══════════════════════
say('── B/C/D. 返回体: 不丢数据 + 口径无歧义 + 真能多拿 ──')
let defaultPage
{
  // 默认调用: scan 默认 50(池里全部会话 → 全扫), limit 默认 20 → 25 个 'r9' 命中只给 20
  defaultPage = await callTool(PORT, 'session_search', { query: 'r9' })
  ok(defaultPage.matchedTotal === 25, 'D1 默认调用命中 25 个会话', defaultPage.matchedTotal)
  ok(defaultPage.count === LIST_PAGE_DEFAULT, `D1 默认返回 ${LIST_PAGE_DEFAULT} 条`, defaultPage.count)
  ok(defaultPage.results?.length === LIST_PAGE_DEFAULT, 'D1 results 长度与 count 一致', defaultPage.results?.length)

  // ── 核心: 命中数 > 返回数时必须有字段说明差多少 ──
  ok(defaultPage.truncated === true, 'B1 有未返回的命中 → truncated=true', defaultPage.truncated)
  ok(defaultPage.hasMore === true, 'B1 同时给出 hasMore=true', defaultPage.hasMore)
  ok(defaultPage.omitted === 5, 'B2 omitted 明确"还差 5 条"(25 - 20)', defaultPage.omitted)
  ok(typeof defaultPage.next === 'string' && defaultPage.next.includes('5'),
    'B2 next 说明还有几条没给', defaultPage.next)
  // [核心回归] 旧实现正是"matched=44 但 results=20 且无任何提示"
  ok(!(defaultPage.matchedTotal > defaultPage.count && defaultPage.omitted === undefined && defaultPage.hasMore === undefined),
    'B3 绝不出现"命中数>返回数却无任何提示"的状态')
  // next 必须告诉怎么拿下一页
  ok(/offset=/.test(String(defaultPage.next)), 'B3 next 给出下一页的 offset', defaultPage.next)

  // ── P2 口径无歧义 ──
  ok(defaultPage.total === defaultPage.scanned, 'C1 total 与 scanned 同值(向后兼容)', { total: defaultPage.total, scanned: defaultPage.scanned })
  ok(defaultPage.total === POOL_SIZE, `C1 total = 本次扫描的 ${POOL_SIZE} 个会话(不是结果数)`, defaultPage.total)
  ok(defaultPage.matched === defaultPage.matchedTotal, 'C1 matched 与 matchedTotal 同值(向后兼容)', { matched: defaultPage.matched, matchedTotal: defaultPage.matchedTotal })
  ok(defaultPage.matchedTotal === 25, 'C1 matchedTotal = 命中总数 25', defaultPage.matchedTotal)
  ok(defaultPage.scannedSessions === defaultPage.total, 'C2 scannedSessions 是语义无歧义的别名', defaultPage.scannedSessions)
  ok(defaultPage.total !== defaultPage.count, 'C2 total(扫描数) ≠ count(本页条数) —— 正是易混点', { total: defaultPage.total, count: defaultPage.count })
  ok(defaultPage.scan === 50, 'C3 scan 回显本次生效的扫描深度(默认 50)', defaultPage.scan)
  ok(defaultPage.limit === LIST_PAGE_DEFAULT, `C3 limit 回显本次生效的返回条数(默认 ${LIST_PAGE_DEFAULT})`, defaultPage.limit)
}

{
  // ── 核心验收: 调大"返回条数"真的能拿到更多条(旧实现: 调多大都还是 20) ──
  const more = await callTool(PORT, 'session_search', { query: 'r9', limit: 30 })
  ok(more.count === 25, 'D2 limit=30 时返回全部 25 条命中', more.count)
  ok(more.results?.length === 25, 'D2 results 真的有 25 条(不再恒为 20)', more.results?.length)
  ok(more.count > defaultPage.count, 'D2 调大 limit 确实比默认拿到更多条', { big: more.count, def: defaultPage.count })
  ok(more.omitted === 0, 'D2 全给完时 omitted=0', more.omitted)
  ok(more.hasMore === false && more.truncated === false, 'D2 全给完时 hasMore/truncated 均为 false', { hasMore: more.hasMore, truncated: more.truncated })
  ok(more.next === undefined, 'D2 全给完时不给 next(不误导)', more.next)
}

{
  // ── offset 翻页真能拿到剩下的 ──
  const p2 = await callTool(PORT, 'session_search', { query: 'r9', offset: 20 })
  ok(p2.count === 5, 'D3 offset=20 拿到剩余 5 条', p2.count)
  ok(p2.offset === 20, 'D3 offset 回显', p2.offset)
  const ids1 = new Set((defaultPage.results ?? []).map((r) => r.sessionId))
  const ids2 = (p2.results ?? []).map((r) => r.sessionId)
  ok(ids2.every((id) => !ids1.has(id)), 'D3 第 2 页与第 1 页无重叠', { ids2 })
  ok(ids2.length + ids1.size === 25, 'D3 两页合计 = 命中总数 25(无静默丢弃)', { p1: ids1.size, p2: ids2.length })
}

{
  // ── E. scan 控制扫描深度, 且 limit 不再影响它 ──
  const shallow = await callTool(PORT, 'session_search', { query: 'r9', scan: 5 })
  ok(shallow.total === 5, 'E1 scan=5 只扫 5 个会话(total=5)', shallow.total)
  ok(shallow.scan === 5, 'E1 scan 回显 5', shallow.scan)
  // scan=5 时最多命中 5 个, 而 limit 仍为默认 20 → 不会截断
  ok(shallow.matchedTotal <= 5, 'E1 浅扫时命中数受扫描深度限制', shallow.matchedTotal)

  // limit 不再影响扫描深度(旧实现里 limit 就是扫描深度)
  const limited = await callTool(PORT, 'session_search', { query: 'r9', limit: 3 })
  ok(limited.total === POOL_SIZE, `E2 limit=3 时扫描深度仍是默认 50(扫到全部 ${POOL_SIZE} 个会话)`, limited.total)
  ok(limited.count === 3, 'E2 limit=3 只限制返回条数', limited.count)
  ok(limited.matchedTotal === 25, 'E2 limit 不影响命中统计(仍是 25)', limited.matchedTotal)

  // 深扫才有更多命中: scan=3 vs scan=50
  const deep = await callTool(PORT, 'session_search', { query: 'r9', scan: 50, limit: 100 })
  ok(deep.total === POOL_SIZE && deep.matchedTotal === 25, `E3 scan=50 扫全池(${POOL_SIZE}) → 命中 25`, { total: deep.total, matched: deep.matchedTotal })
  ok(deep.total > shallow.total, 'E3 调大 scan 真的扫得更深', { deep: deep.total, shallow: shallow.total })
}

{
  // ── 兼容旧别名 pageSize ──
  const legacy = await callTool(PORT, 'session_search', { query: 'r9', pageSize: 4 })
  ok(legacy.count === 4, 'E4 pageSize 仍可作为返回条数的别名(旧调用方不炸)', legacy.count)
  const both = await callTool(PORT, 'session_search', { query: 'r9', limit: 6, pageSize: 4 })
  ok(both.count === 6, 'E4 同时传 limit 与 pageSize 时 limit 优先', both.count)
}

{
  // ── 无命中时的引导必须指向 scan(旧实现写的是"调大 limit", 在新语义下是错的) ──
  const none = await callTool(PORT, 'session_search', { query: '绝对不存在的词组zzzq' })
  ok(none.count === 0 && none.matchedTotal === 0, 'E5 无命中时 count/matchedTotal 均为 0', none)
  ok(/scan/.test(String(none.hint)), 'E5 无命中引导调大 scan(不是 limit)', none.hint)
  ok(none.omitted === 0 && none.hasMore === false, 'E5 无命中时 omitted=0 / hasMore=false', { omitted: none.omitted, hasMore: none.hasMore })
}

{
  // ── 有截断时的 hint 必须告诉调用方"调大 limit"和"调大 scan"的分工 ──
  ok(/limit/.test(String(defaultPage.hint)) && /scan/.test(String(defaultPage.hint)),
    'B4 截断时 hint 讲清 limit 与 scan 各自的作用', defaultPage.hint)
  ok(/20/.test(String(defaultPage.hint)) || /本页/.test(String(defaultPage.hint)),
    'B4 截断时 hint 点明"本页只是前 N 条"', defaultPage.hint)
}

// ═══════════════════════ F8-H. P3 端到端: 样板真的被沉底且可关闭 ═══════════════════════
say('── H. P3 端到端: 样板降权可观测 + filter_noise 开关生效 ──')
{
  // 搜样板词 "plete": 7 个逐字相同的样板 + 2 个不同内容(1 内容真命中 + 1 标题命中)
  // 样板会话 createdAt 更大(更新) —— 若不降权, 它们会排在前面。
  const on = await callTool(PORT, 'session_search', { query: 'plete', limit: 100 })
  ok(on.boilerplate_count === 7, 'H1 7 个逐字相同的样板被识别(boilerplate_count=7)', on.boilerplate_count)
  ok(on.filter_noise === true, 'H1 默认开着降权(filter_noise=true)', on.filter_noise)
  const firstIdx = (on.results ?? []).findIndex((r) => r.boilerplate === true)
  const realIdx = (on.results ?? []).findIndex((r) => r.boilerplate !== true)
  ok(realIdx >= 0 && firstIdx >= 0, 'H2 结果里既有真命中也有样板命中', { realIdx, firstIdx })
  ok(realIdx < firstIdx, 'H2 真命中排在样板之前(样板被沉底, 不再挤占前排)', { realIdx, firstIdx })
  // 样板条数 = 7, 真命中(标题命中 + 内容不同)在前
  const marked = (on.results ?? []).filter((r) => r.boilerplate === true).length
  ok(marked === 7, 'H2 样板条目带 boilerplate=true 标注(可被调用方识别, 未被删除)', marked)
  ok((on.results ?? []).length === 9, 'H2 样板只是沉底, 没有被丢弃(仍返回全部 9 条)', (on.results ?? []).length)

  // 开关: filter_noise=false → 不做降权, boilerplate_count=0 且顺序回到纯 updatedAt 倒序
  const off = await callTool(PORT, 'session_search', { query: 'plete', limit: 100, filter_noise: false })
  ok(off.boilerplate_count === 0, 'H3 filter_noise=false 时不判定样板(count=0)', off.boilerplate_count)
  ok(off.filter_noise === false, 'H3 开关状态正确回显 false', off.filter_noise)
  ok(!(off.results ?? []).some((r) => r.boilerplate === true), 'H3 关闭时没有 boilerplate 标注', off.results)
  const offFirst = (off.results ?? [])[0]
  ok(offFirst?.boilerplate === undefined, 'H3 关闭时首条是样板(纯 updatedAt 倒序, 证明降权确实生效过)', offFirst)
  ok((off.results ?? []).length === 9, 'H3 开关只影响排序/标注, 不影响返回条数', (off.results ?? []).length)
}

// ═══════════════════════ G. 描述完整性 ═══════════════════════
say('── G. 破坏性变更已在描述中点明 ──')
{
  const t = await rpc(PORT, 'tools/list', {})
  const desc = String(t.result.tools.find((x) => x.name === 'session_search')?.description ?? '')
  ok(/scan/.test(desc) && /limit/.test(desc), 'G1 描述同时提到 scan 与 limit', desc.slice(0, 200))
  ok(/扫描/.test(desc) && /返回/.test(desc), 'G2 描述用中文讲清"扫多少"与"返回多少"', desc.slice(0, 200))
  ok(/200/.test(desc), 'G3 描述写明 scan 上限 200', desc.slice(0, 200))
  ok(/100/.test(desc), 'G3 描述写明 limit 上限 100', desc.slice(0, 200))
  ok(/omitted/.test(desc), 'G4 描述写明 omitted 字段(知道丢了多少)', desc.slice(0, 200))
  // 版本已升
  // ⚠️ 与 package.json 比对，不写死版本号 —— 否则每次发版都要改测试（已踩两次）
  const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  ok(internals.VERSION === pkgVersion, `G5 PLUGIN_VERSION 与 package.json 一致 (${pkgVersion})`, internals.VERSION)
}

say(`══ [R9] 单元级结果: PASS=${pass} FAIL=${fail} ══`)
// 本测试起过 HTTP server(8099), server 句柄会让事件循环常驻 —— 必须显式退出,
// 否则 `node tests/unit_r9.mjs` 永不返回(与 unit_mock_p2 的约定一致)。
process.exit(fail > 0 ? 1 : 0)

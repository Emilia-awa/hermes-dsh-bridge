#!/usr/bin/env node
/**
 * contract_probe.mjs — 宿主契约探针(独立可运行, 输出机器可读 JSON)。
 *
 * 用途(DISCUSS_20261003 §3.2 落地物 3):
 *   把「桥插件依赖的宿主契约」固化成一份可 diff 的基线, 在升级 dsh **之前/之后**各跑一次:
 *
 *     node scripts/contract_probe.mjs > contract_$(dsh --version).json
 *     node scripts/contract_probe.mjs | diff contract_before.json - && echo "契约无变化"
 *
 * 与 src/contract.ts 的关系:
 *   - 契约清单(HOST_CONTRACT)是**唯一事实来源**, 本脚本从 lib/contract.js 读取它,
 *     绝不复制粘贴(避免清单漂移);
 *   - 输出含 `probe`(符号 + 服务的逐项探测结果)与 `packageVersions`(实际解析到的版本),
 *     JSON 键序稳定(固定数组顺序), 保证 diff 只在真正变化时非空。
 *
 * 退出码: 0 = 必需项齐备; 1 = 必需项缺失(可直接被 CI 判定为红)。
 *
 * 零依赖: 只用 node 内置能力 + 本仓库 lib/ 产物。
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/**
 * 加载契约清单与探测器。
 *
 * ⚠️ 实现约束(实测): 本包位于 `node_modules/` 之下, node 22 拒绝对其中的 `.ts` 做类型剥离,
 * 且 `tsdown.config.js` 只把 `src/index.ts` bundle 成单个 `lib/index.js`
 * (不产出 `lib/contract.js`)。因此唯一可靠的来源是 **构建产物 `lib/index.js`**:
 * 契约清单经 `__internals.HOST_CONTRACT` / `__internals.probeHostContract` 暴露。
 *
 * 代价: 跑本脚本前必须 `npm run build` 让产物与 src 同步(与 tests/*.mjs 的约定一致)。
 */
async function loadContractModule() {
  const libIndex = join(ROOT, 'lib/index.js')
  if (!existsSync(libIndex)) {
    throw new Error('lib/index.js 不存在 —— 先跑 `npm run build`(本脚本从构建产物读取契约清单)')
  }
  const mod = await import(libIndex)
  const internals = mod.__internals
  if (!internals?.HOST_CONTRACT || typeof internals.probeHostContract !== 'function') {
    throw new Error('lib/index.js 里的 __internals 缺少 HOST_CONTRACT/probeHostContract —— 产物落后, 请 `npm run build` 重建')
  }
  return { HOST_CONTRACT: internals.HOST_CONTRACT, probeHostContract: internals.probeHostContract }
}

/** 读一个包实际解析到的版本(解析不到返回 undefined, 不抛错) */
function resolvedVersion(pkg) {
  try {
    const p = require.resolve(`${pkg}/package.json`)
    const json = JSON.parse(readFileSync(p, 'utf8'))
    return { version: json.version, path: p }
  } catch {
    return undefined
  }
}

/**
 * 构造一个「只做结构性探测」的假 ctx。
 *
 * 关键设计: 本脚本是**离线**探针, 不能启动 cordis 容器。因此服务探测按
 * 「该服务对应的宿主包是否可解析」判定 —— 包在 ⇒ 宿主大概率提供该服务;
 * 包不在 ⇒ 服务大概率不可用(与桥运行时 `ctx.get(key,false)` 的结论方向一致)。
 * 真正的运行态结论以 status_get.contract 为准(插件启动时用真实 ctx 探测)。
 *
 * 已知例外: `dsh-agent-presets`(0.1.2 旧包名) 与宿主的 `dsh-agent-preset-registry`
 * (0.2.x 新包名)是同一个服务的两代实现, 见 §3.1 的阶段 2 包名漂移说明。
 */
const SERVICE_PACKAGE_HINTS = {
  tools: ['@deepseek-ai/dsh-tools'],
  llm: ['@deepseek-ai/dsh-llm'],
  sessions: ['@deepseek-ai/dsh-session'],
  agents: ['@deepseek-ai/dsh-agent'],
  agentPresets: ['@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-agent-preset-registry'],
  sessionPersistence: ['@deepseek-ai/dsh-session-persistence'],
  workspaceRegistry: ['@deepseek-ai/dsh-workspace'],
  sessionQuery: ['@deepseek-ai/dsh-session-query'],
  sessionTitle: ['@deepseek-ai/dsh-session-title'],
  settings: ['@deepseek-ai/dsh-settings'],
  approval: ['@deepseek-ai/dsh-user-approval'],
  apiProxy: ['@deepseek-ai/dsh-host-apiproxy'],
}

async function main() {
  const contract = await loadContractModule()
  const { HOST_CONTRACT, probeHostContract } = contract

  // ① 必需符号: 直接 import 宿主包并检查导出(离线可做, 无副作用)
  const symbols = []
  for (const s of HOST_CONTRACT.required) {
    let actual = 'missing'
    let error
    try {
      const mod = await import(s.pkg)
      actual = typeof mod[s.export]
    } catch (e) {
      actual = 'unresolvable'
      error = String(e?.message ?? e).slice(0, 200)
    }
    const ok = actual === s.kind
    symbols.push({
      id: `${s.pkg}#${s.export}`,
      pkg: s.pkg,
      export: s.export,
      expected: s.kind,
      actual,
      ok,
      ...(error ? { error } : {}),
      usage: s.usage,
    })
  }

  // ② 服务: 按宿主包可解析性判定(容器以外无法拿到真实 ctx)
  const services = []
  for (const svc of HOST_CONTRACT.services) {
    const hints = SERVICE_PACKAGE_HINTS[svc.key] ?? []
    const resolved = hints.map((p) => ({ pkg: p, ...(resolvedVersion(p) ?? { version: undefined, path: undefined }) }))
    const hit = resolved.find((r) => r.version !== undefined)
    const ok = hit !== undefined
    services.push({
      id: svc.key,
      required: svc.required,
      methods: [...svc.methods],
      package: hit?.pkg ?? null,
      version: hit?.version ?? null,
      ok,
      usage: svc.usage,
    })
  }

  // ③ 探测结果汇总(与插件运行时逻辑同构, 但用上面的离线替身)
  const symbolBindings = {}
  for (const s of symbols) symbolBindings[s.export] = s.ok ? () => {} : undefined
  const fakeServices = {}
  for (const s of services) {
    if (!s.ok) continue
    const impl = {}
    for (const m of s.methods) impl[m] = () => {}
    fakeServices[s.id] = impl
  }
  const report = probeHostContract({
    ctx: { get: (key, strict) => (key in fakeServices ? fakeServices[key] : (strict === false ? undefined : undefined)) },
    symbols: symbolBindings,
  })

  const missingRequiredPackages = services.filter((s) => s.required && !s.ok).map((s) => s.id)
  const missingRequiredSymbols = symbols.filter((s) => !s.ok).map((s) => s.id)
  const ok = report.ok

  const payload = {
    probe: 'host-contract',
    generator: 'scripts/contract_probe.mjs',
    node: process.version,
    probeMode: 'offline-package-resolution',
    ok,
    summary: {
      requiredSymbols: symbols.length,
      requiredServices: HOST_CONTRACT.services.filter((s) => s.required).length,
      optionalServices: HOST_CONTRACT.services.filter((s) => !s.required).length,
      missingRequiredSymbols,
      missingRequiredPackages,
    },
    symbols,
    services,
    checkedAt: report.checkedAt,
  }

  process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  // 必需项缺失 → 退出码 1(CI 可直接当红灯); 可选项缺失只体现在 JSON 里
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  // 探针自身失败也算红(但输出仍是合法 JSON, 便于上层统一解析)
  process.stdout.write(JSON.stringify({
    probe: 'host-contract',
    generator: 'scripts/contract_probe.mjs',
    ok: false,
    fatal: String(e?.message ?? e),
  }, null, 2) + '\n')
  process.exit(1)
})

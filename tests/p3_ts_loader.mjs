// P3 自测专用 module loader hook: 官方 auto type-stripping 拒绝 node_modules 路径下的 .ts,
// 这里显式读源文件并 stripTypeScriptTypes, 让 lib/index.js 构建产物落后时(本地未跑构建)
// unit_mock_p3.mjs 仍能直接加载 src/index.ts 自测 —— 不写任何临时文件。
// CI 里构建先跑、lib 与 src 版本一致, 本 loader 不会被注册。
//
// [P0-1] 扩展: 源文件里 `import ... from './contract.js'` 是 TS 的 ESM 惯例(NodeNext 解析),
// 但 node 的类型剥离模式**不会**做 .js → .ts 的映射, 因此这里显式兜底:
// resolve 阶段把 `./contract.js` 改指到真实存在的 `./contract.ts`。
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

export function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const source = readFileSync(fileURLToPath(url), 'utf8')
    let stripped
    try {
      stripped = stripTypeScriptTypes(source, { mode: 'strip' })
    } catch (e) {
      throw new Error(`[p3_ts_loader] strip failed for ${url}: ${e?.message ?? e}`)
    }
    return { format: 'module', source: stripped, shortCircuit: true }
  }
  return nextLoad(url, context)
}

export function resolve(specifier, context, nextResolve) {
  // 只在「源文件里写的 ./x.js 其实只有 x.ts」时改写, 其余一律交给默认解析。
  // 注意: resolve 钩子是**同步**的(不能 await import), 因此 fs/url 必须在文件顶部静态引入。
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    if (context.parentURL?.startsWith('file:')) {
      const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true, format: 'module' }
      }
    }
  }
  return nextResolve(specifier, context)
}

// P3 自测专用 module loader hook: 官方 auto type-stripping 拒绝 node_modules 路径下的 .ts,
// 这里显式读源文件并 stripTypeScriptTypes, 让 lib/index.js 构建产物落后时(本地未跑构建)
// unit_mock_p3.mjs 仍能直接加载 src/index.ts 自测 —— 不写任何临时文件。
// CI 里构建先跑、lib 与 src 版本一致, 本 loader 不会被注册。
import { readFileSync } from 'node:fs'
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

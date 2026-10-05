#!/usr/bin/env node
/**
 * check-build-artifacts.mjs — 构建产物守卫(R2-1 回归防线)。
 *
 * 背景(REQ_r2_20261004 §R2-1 / DISCUSS A8):
 *   历史根因是 `build` 脚本写成 `tsc -b && tsdown`, 而 tsdown 的 outDir='lib' 会清空整个 lib/,
 *   于是 tsc 先生成的 `lib/types/*.d.ts` 被随后删掉 —— `package.json#types` 指向的
 *   `lib/types/index.d.ts` 在每次 `npm run build` 之后必然缺失, 且**没有任何报错**。
 *
 * 本脚本作为 `npm run build` 的最后一步, 把上述「静默缺失」变成**构建失败**:
 *   ① package.json#types 指向的文件存在;
 *   ② package.json#main 指向的文件存在且能被 node 解析;
 *   ③ 源码里 export 的 degrade() 在类型声明里可见(证明确实是本次源码的声明, 而非陈旧残留)。
 *
 * 自愈(R2-1 补充): 若声明产物缺失**且** tsbuildinfo 存在, 说明是 `tsc -b` 的增量缓存
 * 在骗人 —— 缓存声称"已是最新", 但产物早已被别的东西删掉, 于是 `tsc -b` 什么都不做
 * (实测: 删掉 lib/types/ 后 `tsc -b` 退出码 0 且不重建)。这是与 A8 **同一类**的静默失效,
 * 因此这里自动跑一次 `tsc -b --force` 重建, 再复核; 仍缺才算构建失败。
 *
 * 零依赖。exit 0 = 产物完整; exit 1 = 产物缺失且自愈失败(构建应当视为失败)。
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const failures = []

/**
 * 增量缓存自愈: 删掉 tsbuildinfo + 强制重建声明。
 * @returns {boolean} 是否成功修复
 */
function healStaleTsbuildinfo() {
  const tsbuildinfo = join(REPO_ROOT, 'lib', 'tsconfig.tsbuildinfo')
  const hadCache = existsSync(tsbuildinfo)
  try {
    if (hadCache) unlinkSync(tsbuildinfo)
    execFileSync('npx', ['tsc', '-b', '--force'], { cwd: REPO_ROOT, stdio: 'pipe', timeout: 120000 })
    return true
  } catch (e) {
    console.log(`      (自愈失败: ${String(e?.stderr ?? e?.message ?? e).slice(0, 200)})`)
    return false
  }
}

function ok(label, detail) { console.log(`  ✓ ${label} — ${detail}`) }
function bad(label, detail, fix) {
  console.log(`  ✗ ${label} — ${detail}`)
  if (fix) console.log(`      ↳ 修复: ${fix}`)
  failures.push(label)
}

console.log('构建产物检查')

// ── ① types 入口 ──
const typesRel = pkg.types
if (!typesRel) {
  bad('package.json#types 已声明', '缺失该字段', '在 package.json 里补 "types": "lib/types/index.d.ts"')
} else {
  const typesAbs = join(REPO_ROOT, typesRel)
  // 自愈: 缺失时可能是 tsc -b 的增量缓存在骗人(缓存说"最新"但产物已被删)。
  // 先删缓存强制重建一次, 再往下判定 —— 而不是直接判构建失败。
  let healed = false
  if (!existsSync(typesAbs)) {
    console.log(`  · ${typesRel} 缺失, 尝试自愈(清 tsbuildinfo + tsc -b --force)…`)
    healed = healStaleTsbuildinfo()
  }
  if (existsSync(typesAbs)) {
    const text = readFileSync(typesAbs, 'utf8')
    // ③ 声明内容必须来自本次源码(degrade 是 R1 新增的导出, 出现在声明里说明 tsc 真的跑过)
    if (text.includes('degrade')) {
      const note = healed ? ' [已自愈: 增量缓存失效]' : ''
      ok('package.json#types 指向的声明文件', `${typesRel} (${text.length} 字节, 含 degrade 导出)${note}`)
    } else {
      bad('package.json#types 指向的声明文件', `${typesRel} 存在但内容陈旧(未包含 degrade 导出)`,
        '跑一次干净的 `npm run build:clean`; 若仍失败, 检查 tsconfig.json#declarationDir 是否被别处产物覆盖')
    }
  } else {
    bad('package.json#types 指向的声明文件', `${typesAbs} 不存在`,
      '这是 R2-1 修的历史 bug: build 脚本必须是 `tsdown && tsc -b`(tsc 在后), 且 tsdown.config.js 必须 clean:false; ' +
      '若自愈也失败, 跑 `npm run build:clean`(先 rm -rf lib)')
  }
}

// ── ② main 入口 ──
const mainRel = pkg.main
if (!mainRel) {
  bad('package.json#main 已声明', '缺失该字段', '在 package.json 里补 "main": "lib/index.js"')
} else {
  const mainAbs = join(REPO_ROOT, mainRel)
  if (existsSync(mainAbs)) {
    try {
      const resolved = createRequire(join(REPO_ROOT, 'noop.js')).resolve(`./${mainRel}`)
      ok('package.json#main 可被 node 解析', resolved.replace(REPO_ROOT + '/', ''))
    } catch (e) {
      bad('package.json#main 可被 node 解析', `${mainRel} 存在但解析失败: ${e?.code ?? e?.message}`,
        '确认 lib/index.js 是合法 ESM 产物(tsdown 报告 Build complete)')
    }
  } else {
    bad('package.json#main 指向的产物', `${mainAbs} 不存在`, '跑 `npm run build`(tsdown 负责生成 lib/index.js)')
  }
}

// ── ③ 附带产物(tsc 的增量缓存不能挡住 types 生成) ──
const contractDecl = join(REPO_ROOT, 'lib', 'types', 'contract.d.ts')
if (existsSync(contractDecl)) ok('附加声明 lib/types/contract.d.ts', '存在')
else console.log('  · lib/types/contract.d.ts 不存在 — 视构建配置而定, 不作失败(仅 types 入口必需)')

console.log('─'.repeat(60))
if (failures.length === 0) {
  console.log('构建产物完整: types 入口与 main 入口均可用。')
  process.exit(0)
}
console.log(`构建产物不完整: ${failures.length} 项失败 —— 构建视为失败。`)
process.exit(1)

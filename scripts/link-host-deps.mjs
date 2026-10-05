#!/usr/bin/env node
/**
 * link-host-deps.mjs — 把插件本地 `node_modules/@deepseek-ai/*` 里「宿主树也有同名」的包
 * 全部替换成指向宿主全局树的 symlink(消除 dual-package hazard)。
 *
 * 为什么需要它(DISCUSS_20261003 §2.3 A2 / §3.1 高危隐患):
 *   本机是**双树结构** —— 宿主在 `/opt/node22/lib/node_modules/@deepseek-ai/dsh/...`, 插件工作副本
 *   在 `~/.dsh/profiles/web/node_modules/@chushixixin/dsh-harness-mcp-server`。历史上插件本地
 *   `node_modules` 里 21 个 `@deepseek-ai/*` 只有 3 个是 symlink, 其余 18 个是 **0.1.2-rc.1 的真实副本**
 *   (`cordis` 本地 4.0.1 vs 宿主 4.0.4)。当前只是「恰好没踩到」—— 一旦某个 0.2.x 版本的
 *   `ToolRuntime.register` / `AgentRegistry.create` 签名变化, 本地旧副本会让 TS 编译通过而运行时行为错乱,
 *   又是一次静默失效。且 `npm install` 会**再次**把 symlink 还原成真实目录, 所以必须脚本化。
 *
 * 用法:
 *   node scripts/link-host-deps.mjs --dry-run   # 只打印将做什么, 不改动任何文件
 *   node scripts/link-host-deps.mjs             # 实际执行(幂等)
 *   node scripts/link-host-deps.mjs --tree /path/to/host/@deepseek-ai   # 显式指定宿主树
 *
 * 行为:
 *   - 自动探测宿主全局树(`npm root -g` → `<root>/@deepseek-ai/dsh/node_modules/@deepseek-ai`,
 *     回退 `/opt/node22/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`);
 *   - 只处理**宿主树存在同名包**的项: 已是 symlink 且指向正确 → 跳过;
 *     是真实目录 → 备份式替换(`rm -rf` 后 `ln -sfn`);
 *   - **跳过宿主树没有的包**(如 `dsh-agent-presets` / `dsh-code-runtime`)并打印说明 ——
 *     它们是技术债, 不在本轮范围, 绝不删除;
 *   - 幂等: 重复跑不会产生任何变化。
 *
 * 退出码: 0 = 完成(含无事可做); 1 = 有错误(宿主树探测失败等)。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCOPE = '@deepseek-ai'
const LOCAL_SCOPE_DIR = join(ROOT, 'node_modules', SCOPE)
const HOST_REL = join(SCOPE, 'dsh', 'node_modules', SCOPE)

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const treeIdx = args.indexOf('--tree')
const EXPLICIT_TREE = treeIdx >= 0 ? args[treeIdx + 1] : undefined

if (args.includes('--help') || args.includes('-h')) {
  console.log(`link-host-deps.mjs — 把插件本地 @deepseek-ai/* 对齐到宿主全局树(symlink)

用法: node scripts/link-host-deps.mjs [--dry-run] [--tree <宿主 @deepseek-ai 目录>]

  --dry-run   只打印将做什么, 不改动任何文件
  --tree      显式指定宿主 @deepseek-ai 目录(默认自动探测 npm root -g)

退出码: 0 = 完成; 1 = 探测失败/有错误`)
  process.exit(0)
}

/** 探测宿主 @deepseek-ai 目录(返回绝对路径; 探测不到返回 undefined) */
function detectHostTree() {
  if (EXPLICIT_TREE) {
    const p = resolve(EXPLICIT_TREE)
    return existsSync(p) ? p : undefined
  }
  // ① npm root -g(npm 可能不在 PATH, 失败不致命)
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (globalRoot) {
      const p = join(globalRoot, HOST_REL)
      if (existsSync(p)) return p
    }
  } catch { /* npm 不可用 → 走 ② */ }
  // ② 本机实测的固定路径(与 systemd ExecStart 的 bin.js 同树)
  const fallback = join('/opt/node22/lib/node_modules', HOST_REL)
  if (existsSync(fallback)) return fallback
  return undefined
}

/** 读取一个目录项的状态: 'symlink' | 'real-dir' | 'missing' */
function entryState(path) {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink()) return 'symlink'
    if (st.isDirectory()) return 'real-dir'
    return 'other'
  } catch {
    return 'missing'
  }
}

function main() {
  console.log(`[link-host-deps] 插件本地 scope 目录: ${LOCAL_SCOPE_DIR}`)
  if (!existsSync(LOCAL_SCOPE_DIR)) {
    console.error(`[link-host-deps] ✗ 本地 ${SCOPE} 目录不存在 —— 先在该插件目录跑 npm install`)
    process.exit(1)
  }

  const hostTree = detectHostTree()
  if (!hostTree) {
    console.error('[link-host-deps] ✗ 未探测到宿主 @deepseek-ai 目录')
    console.error('  探测顺序: ① `npm root -g`/@deepseek-ai/dsh/node_modules/@deepseek-ai')
    console.error('           ② /opt/node22/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
    console.error('  可用 --tree <路径> 显式指定。宿主未安装时本脚本无事可做(不报错退出也不改动任何文件)。')
    process.exit(1)
  }
  console.log(`[link-host-deps] 宿主树: ${hostTree}${DRY_RUN ? '  (--dry-run: 只打印, 不修改)' : ''}`)

  const localPkgs = readdirSync(LOCAL_SCOPE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => d.name)
    .sort()

  const linked = []
  const skippedAlreadyLinked = []
  const missingInHost = []

  for (const pkg of localPkgs) {
    const localPath = join(LOCAL_SCOPE_DIR, pkg)
    const hostPath = join(hostTree, pkg)
    const state = entryState(localPath)

    if (!existsSync(hostPath)) {
      // 宿主树没有同名包(如 dsh-agent-presets / dsh-code-runtime): 保留本地副本, 绝不删除
      missingInHost.push({ pkg, state })
      continue
    }

    if (state === 'symlink') {
      // 幂等: 已是指向同一目标的 symlink → 跳过(realpath 比较, 容忍相对/绝对写法差异)
      let sameTarget = false
      try {
        sameTarget = realpathSync(localPath) === realpathSync(hostPath)
      } catch {
        sameTarget = false
      }
      if (sameTarget) {
        skippedAlreadyLinked.push({ pkg, target: readlinkSync(localPath) })
        continue
      }
      // 断链/指向别处 → 重建
      if (!DRY_RUN) rmSync(localPath, { force: true })
      if (!DRY_RUN) symlinkSync(hostPath, localPath, 'dir')
      linked.push({ pkg, from: `symlink(${safeReadlink(localPath) || '断链'})`, action: 'relink' })
      continue
    }

    // 真实目录 → 替换为 symlink(这是本脚本的核心动作)
    if (!DRY_RUN) {
      rmSync(localPath, { recursive: true, force: true })
      symlinkSync(hostPath, localPath, 'dir')
    }
    linked.push({ pkg, from: state, action: 'replace' })
  }

  // ── 汇总输出 ──
  console.log('')
  if (linked.length > 0) {
    console.log(`将建立/修复 symlink (${linked.length}):`)
    for (const l of linked) console.log(`  ${DRY_RUN ? '·' : '✓'} ${SCOPE}/${l.pkg}  [${l.action}] ← ${hostTree}/${l.pkg}`)
  } else {
    console.log('将建立/修复 symlink (0): 无')
  }
  if (skippedAlreadyLinked.length > 0) {
    console.log(`\n已是正确 symlink, 跳过 (${skippedAlreadyLinked.length}):`)
    for (const s of skippedAlreadyLinked) console.log(`  = ${SCOPE}/${s.pkg} → ${s.target}`)
  }
  if (missingInHost.length > 0) {
    console.log(`\n宿主树无同名包, 保留本地副本 (${missingInHost.length}) —— 未改动:`)
    for (const m of missingInHost) console.log(`  ! ${SCOPE}/${m.pkg}  (本地 ${m.state}; 宿主树无此包, 属已知技术债, 本脚本不处理)`)
  }

  const total = localPkgs.length
  console.log('\n' + '─'.repeat(60))
  console.log(`[link-host-deps] ${DRY_RUN ? '(dry-run) ' : ''}扫描 ${total} 个本地包: symlink ${linked.length + skippedAlreadyLinked.length}, 保留本地副本 ${missingInHost.length}`)
  if (DRY_RUN) {
    console.log('dry-run 结束: 未改动任何文件。去掉 --dry-run 实际执行。')
  } else {
    console.log(`完成。核对: ls -la ${LOCAL_SCOPE_DIR}`)
  }
}

/** readlink 的安全包装(路径不存在/不可读返回 undefined, 不抛错) */
function safeReadlink(p) {
  try {
    return readlinkSync(p)
  } catch {
    return undefined
  }
}

main()

// dsh 插件约定产物: ESM 单文件 bundle 到 lib/index.js
// 用 .js 而非 .ts: 包位于 node_modules 内, Node 拒绝对其中文件做 TS 类型剥离
// external 全部 @deepseek-ai/*: 与运行时共享同一实例(scope 等模块级状态不可复制)
export default {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  minify: false,
  // [R2-1] 关键: 禁止 tsdown 清空 outDir。
  // 根因(REQ_r2_20261004 §R2-1): outDir='lib' 时 tsdown 会 `Cleaning N files` 清空整个 lib/,
  // 而 build 脚本是 `tsc -b && tsdown` —— tsc 先生成的 lib/types/*.d.ts 会被随后清掉,
  // 于是 package.json#types 指向的 lib/types/index.d.ts 在构建后必然缺失。
  // 裁决: 保留 lib/ 为唯一产物目录(不改 package.json#types / files 白名单, 最小改动面),
  // 改由 tsdown 不清目录 + build 脚本把 tsc 放到后面(见 package.json#scripts.build)。
  clean: false,
  external: [/^@deepseek-ai\//],
}

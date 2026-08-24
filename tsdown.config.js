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
  external: [/^@deepseek-ai\//],
}

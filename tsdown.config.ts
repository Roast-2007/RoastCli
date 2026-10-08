import { defineConfig } from 'tsdown';

export default defineConfig({
  // 具名入口保持 dist 扁平：bin 指向 dist/cli.js，诊断 host 按相对路径找 dist/diagnostics-worker.js
  entry: { cli: 'src/entrypoints/cli.ts', 'diagnostics-worker': 'src/tools/lsp/diagnostics-worker.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  // Ink/React 等依赖运行时解析，不打进 bundle
  noExternal: [],
  external: [/^node:/],
});

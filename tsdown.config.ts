import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/entrypoints/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  // Ink/React 等依赖运行时解析，不打进 bundle
  noExternal: [],
  external: [/^node:/],
});

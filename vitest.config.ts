import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    // Git and shell integration tests launch external processes; keep file concurrency bounded.
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/entrypoints/**', 'src/ext/*.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
    },
  },
});

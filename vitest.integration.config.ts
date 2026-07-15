import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@insightflow\/contracts$/,
        replacement: new URL('./packages/contracts/src/index.ts', import.meta.url).pathname,
      },
      {
        find: /^@insightflow\/contracts\/(.+)$/,
        replacement: new URL('./packages/contracts/src/$1.ts', import.meta.url).pathname,
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.{test,spec}.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: 'forks',
    fileParallelism: false,
  },
})

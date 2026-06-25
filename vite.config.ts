import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
    environment: 'jsdom',
    include: ['src/test/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: './src/test/setup.ts',
    css: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/recharts/') || id.includes('/node_modules/d3-')) return 'charts'
          if (id.includes('/node_modules/@tabler/icons-react/')) return 'icons'
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) return 'react'
        },
      },
    },
  },
})

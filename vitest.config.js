import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.js', 'api/**/*.test.ts'],
    environment: 'node',
  },
})

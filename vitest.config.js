import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.js', 'api/**/*.test.ts'],
    // happy-dom needed for analytics.test.js (localStorage / document.cookie / window).
    // Other tests are pure-function and unaffected by the environment.
    environment: 'happy-dom',
  },
})

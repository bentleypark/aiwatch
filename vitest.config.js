import { defineConfig } from 'vitest/config'

export default defineConfig({
  // #722 — automatic JSX runtime (matches the production Vite build), so a .test.js can render a
  // .jsx component via react-dom/server without `import React` in scope (e.g. StatusPill render test).
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.js', 'api/**/*.test.ts', 'extension/**/*.test.js'],
    // happy-dom needed for analytics.test.js (localStorage / document.cookie / window).
    // Other tests are pure-function and unaffected by the environment.
    environment: 'happy-dom',
  },
})

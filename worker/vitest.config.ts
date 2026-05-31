import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    root: path.resolve(__dirname),
    include: ['src/**/*.test.ts'],
    // Map global `crypto` to Node's webcrypto when the test runtime doesn't expose it (older Node in
    // CI). The worker uses crypto.subtle (AES-GCM + SHA-256, webhook-subscriptions.ts) as a Workers
    // runtime global; Node 20+ provides it, this is a no-op there and a safety net otherwise.
    setupFiles: ['vitest.setup.ts'],
  },
})

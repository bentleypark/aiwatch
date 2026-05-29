// Vitest (node env) does not expose the Web Crypto API as a global the way the Cloudflare Workers
// runtime does. The worker uses `crypto.subtle` / `crypto.getRandomValues` (e.g. webhook-
// subscriptions.ts AES-GCM + SHA-256, index.ts rate-limit hashing), so map the global to Node's
// webcrypto when missing. No-op in any environment that already provides a working subtle.
import { webcrypto } from 'node:crypto'

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle === 'undefined') {
  // @ts-expect-error — assigning the Node webcrypto implementation to the global slot
  globalThis.crypto = webcrypto
}

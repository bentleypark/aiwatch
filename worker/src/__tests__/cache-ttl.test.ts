import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CACHE_TTL_SECONDS,
  CACHE_STALE_THRESHOLD_MS,
  CRON_CADENCE_MS,
  msUntilCronLooksAgain,
} from '../cache-ttl'

// #1371 — the status snapshot expired before the cron next looked at it, so every Edge is-down page
// served its degraded 503 render until the following tick. The TTL was a literal `900`, sized against
// the /api/status writer's throttle; #1227's cron re-seed is a second writer with a longer period, and
// the TTL was never re-derived against it.
//
// These tests walk the TIMELINE rather than recomputing the constant's own formula. A test shaped like
// `expect(TTL).toBe(STALE + 2 * CADENCE)` would restate the definition and pass on any value the
// definition produced, including a wrong one — it would have been green on the 900 that shipped the bug.

describe('msUntilCronLooksAgain (#1371)', () => {
  it('is longest when the write lands exactly on a tick boundary', () => {
    // The write is fresh for the whole staleness threshold, and the tick that arrives precisely when it
    // goes stale sees an age EQUAL to the threshold, not greater — so it waits one more tick.
    expect(msUntilCronLooksAgain(0)).toBe(CACHE_STALE_THRESHOLD_MS + CRON_CADENCE_MS)
  })

  it('is shortest when the write lands just before the next tick', () => {
    expect(msUntilCronLooksAgain(CRON_CADENCE_MS - 1)).toBe(CACHE_STALE_THRESHOLD_MS + 1)
  })

  it('never exceeds the staleness threshold plus one tick, at any offset', () => {
    const worst = CACHE_STALE_THRESHOLD_MS + CRON_CADENCE_MS
    for (let offset = 0; offset < CRON_CADENCE_MS; offset += 1_000) {  // per-second sweep; the worst case sits at offset 0, which it covers
      expect(msUntilCronLooksAgain(offset)).toBeLessThanOrEqual(worst)
    }
  })
})

describe('CACHE_TTL_SECONDS outlives the cron (#1371)', () => {
  it('survives every write offset in the tick — the property the 900s TTL violated', () => {
    // This is the regression itself. At offset 0 the cron looks again after exactly 15 minutes, which
    // the old 900s TTL matched rather than exceeded — so the key expired at the same instant the cron
    // was due to notice, and any jitter turned that into a real gap.
    const ttlMs = CACHE_TTL_SECONDS * 1_000
    for (let offset = 0; offset < CRON_CADENCE_MS; offset += 1_000) {  // per-second sweep; the worst case sits at offset 0, which it covers
      expect(ttlMs).toBeGreaterThan(msUntilCronLooksAgain(offset))
    }
  })

  it('leaves headroom BEYOND a skipped tick — strictly, because equality is the original bug', () => {
    // Round 1 of review caught this asserting `toBeGreaterThanOrEqual`, which the then-current margin
    // satisfied by exact equality — the same zero-margin condition #1371 exists to fix, one tick
    // further out. Strict, because the recovering tick still has to finish a 45-service live fetch
    // before it can write, and it starts that fetch at the instant the key would otherwise lapse.
    const ttlMs = CACHE_TTL_SECONDS * 1_000
    expect(ttlMs).toBeGreaterThan(msUntilCronLooksAgain(0) + CRON_CADENCE_MS)
  })

  it('is a whole number of seconds — KV expirationTtl rejects a fraction', () => {
    expect(Number.isInteger(CACHE_TTL_SECONDS)).toBe(true)
    // KV also enforces a 60s floor; nothing here approaches it, but the assertion documents the bound.
    expect(CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(60)
  })
})

// #1371 round 2 — the derived TTL hangs entirely off `CRON_CADENCE_MS`, and the schedule that decides
// it lives in TOML, not TypeScript. Nothing in the source can make the two impossible to desynchronise,
// so this reads the real file: change `crons` to `*/15` without touching the constant and the gap
// reopens WIDER than the original, with every other assertion in this file still green (they are all
// self-consistent under any cadence, because they recompute from the same constant).
describe('CRON_CADENCE_MS matches the deployed schedule (#1371)', () => {
  it('equals the interval in worker/wrangler.toml, read from the file', () => {
    const toml = readFileSync(join(process.cwd(), 'worker', 'wrangler.toml'), 'utf8')
    const crons = toml.match(/^\s*crons\s*=\s*\[([^\]]*)\]/m)
    expect(crons, 'no `crons` entry found in worker/wrangler.toml').not.toBeNull()
    const entries = [...crons![1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
    expect(entries, 'expected exactly one cron schedule').toHaveLength(1)
    // Only the `*/N` minute form is modelled; anything else means the timing model needs rewriting,
    // not a new regex — so fail loudly rather than parse more shapes.
    const everyNMinutes = entries[0].match(/^\*\/(\d+) \* \* \* \*$/)
    expect(everyNMinutes, `unmodelled cron shape "${entries[0]}" — msUntilCronLooksAgain assumes */N minutes`).not.toBeNull()
    expect(Number(everyNMinutes![1]) * 60 * 1_000).toBe(CRON_CADENCE_MS)
  })
})

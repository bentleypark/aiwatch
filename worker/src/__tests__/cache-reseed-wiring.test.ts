// #1227 follow-up — `cronAlertCheck` is not exported (same constraint as #1224's
// incidents-past-alert-age.test.ts), so part of this file pins wiring from source text. But
// `kv-read-census.test.ts` (also #1224) already learned the sharper lesson for this exact function:
// a source-text assertion is a hand-written parser, and three of them were once satisfied by an
// UNWIRED variant. So the behavior that matters — does a genuine cache miss actually write CACHE_KEY,
// and does a merely-stale-but-present snapshot NOT — is driven through the real `scheduled()` handler
// below, with `fetchAllServices` mocked so the fresh/cached snapshots can be made to agree exactly
// (no incidental status-diff alert, no service-count-drop alert) and the KV write is the only signal.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { CACHE_TTL_SECONDS } from '../cache-ttl'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServiceStatus } from '../services'
import { TEST_TIMEOUT_MS } from './helpers/unreadable-source'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, CACHE_KEY, fetchAllServices } from '../services'

const INDEX_SRC = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

/** The cronAlertCheck body, bounded by brace matching (mirrors incidents-past-alert-age.test.ts's
 *  helper) so a gate planted below the function cannot satisfy these assertions. */
const cronBody = (() => {
  const start = INDEX_SRC.indexOf('async function cronAlertCheck(')
  expect(start, 'cronAlertCheck not found').toBeGreaterThan(-1)
  let depth = 0
  for (let j = INDEX_SRC.indexOf('{', start); j < INDEX_SRC.length; j++) {
    if (INDEX_SRC[j] === '{') depth++
    else if (INDEX_SRC[j] === '}' && --depth === 0) return INDEX_SRC.slice(start, j + 1)
  }
  throw new Error('unbalanced braces in cronAlertCheck')
})()

describe('source — cron derives snapshotUnusable from cachedServices, not a pre-isCacheStale peek', () => {
  it('derives it from cachedServices.length AFTER isCacheStale runs', () => {
    const staleIdx = cronBody.indexOf('isCacheStale(raw')
    const unusableIdx = cronBody.indexOf('const snapshotUnusable = cachedServices.length === 0')
    expect(staleIdx, 'isCacheStale(raw call not found').toBeGreaterThan(-1)
    expect(unusableIdx, 'snapshotUnusable derivation not found').toBeGreaterThan(-1)
    expect(staleIdx).toBeLessThan(unusableIdx)
  })

  it('awaits the persist with the FRESHLY FETCHED services, not the cached ones (#1371)', () => {
    // #1371 widened this from a re-seed-on-miss to a persist-after-fetch, so the old `snapshotUnusable`
    // argument is gone. What still has to hold is that it writes `freshServices` — passing `services`
    // (the possibly-cached array) would rewrite the stale snapshot with a fresh timestamp, extending
    // its life while leaving the data old, which is worse than the gap this closes.
    expect(cronBody).toMatch(
      /await refreshStatusCacheAfterCronFetch\(\s*env\.STATUS_CACHE,\s*freshServices,\s*freshFeeds,\s*CACHE_KEY,\s*CACHE_TTL_SECONDS\s*\)/,
    )
  })

  it('the re-seed call sits inside the `freshServices.length > 0` branch, after `services` is adopted', () => {
    const branchStart = cronBody.indexOf('if (freshServices.length > 0) {')
    expect(branchStart, 'freshServices.length > 0 branch not found').toBeGreaterThan(-1)
    let depth = 0
    let branchEnd = -1
    for (let j = cronBody.indexOf('{', branchStart); j < cronBody.length; j++) {
      if (cronBody[j] === '{') depth++
      else if (cronBody[j] === '}' && --depth === 0) { branchEnd = j; break }
    }
    expect(branchEnd, 'unbalanced braces in the freshServices branch').toBeGreaterThan(-1)
    const branch = cronBody.slice(branchStart, branchEnd + 1)
    const adoptIdx = branch.indexOf('services = freshServices')
    const reseedIdx = branch.indexOf('refreshStatusCacheAfterCronFetch(')
    expect(adoptIdx, 'services = freshServices not found in branch').toBeGreaterThan(-1)
    expect(reseedIdx, 'refreshStatusCacheAfterCronFetch call not found in branch').toBeGreaterThan(-1)
    expect(adoptIdx).toBeLessThan(reseedIdx)
  })

  it('has exactly one call site', () => {
    const occurrences = cronBody.split('refreshStatusCacheAfterCronFetch(').length - 1
    expect(occurrences).toBe(1)
  })

  it('logs a failed write at ERROR — never warn — and says which of the two states it is (#1371)', () => {
    // Review round 1 caught this branch at `console.warn` while both in-file siblings (#488 at the
    // alert edge, #1057 on the live path) use `console.error` for the same class of failure — and
    // theirs has the weaker symptom (a stale OG card) against this one's 503 across 43 pages.
    // The property pinned here is the severity, plus that the two states are distinguishable; the
    // shape of the branch is not, so a ternary or an if/else both satisfy it.
    // Round 2 caught the positive assertion reading to the END of cronAlertCheck, where later unrelated
    // console.error calls satisfied it — a console.log mutant here survived the whole suite. Scoping it
    // by a character count then broke the moment a comment grew, so the window is the BRACE-MATCHED
    // block: it cannot drift with the length of what is inside it.
    expect(cronBody, 'the failed-write branch must exist').toContain('if (!persisted)')
    const block = (() => {
      const start = cronBody.indexOf('if (!persisted)')
      let depth = 0
      for (let j = cronBody.indexOf('{', start); j < cronBody.length; j++) {
        if (cronBody[j] === '{') depth++
        else if (cronBody[j] === '}' && --depth === 0) return cronBody.slice(start, j + 1)
      }
      throw new Error('unbalanced braces in the !persisted block')
    })()
    expect(block, 'a failed CACHE_KEY write must never be logged below error').not.toMatch(/console\.(warn|log|info|debug)/)
    expect(block).toMatch(/console\.error/)
    expect(block).toMatch(/snapshotUnusable/)
  })
})

// Each case here drives the WHOLE `scheduled()` handler, which is the most expensive thing any test in
// this suite does, and `worker/vitest.config.ts` sets no `testTimeout` — so they ran on vitest's 5s
// default and intermittently died as `Test timed out in 5000ms`, a red at a location with nothing to do
// with whatever change triggered it (this file's own header records an earlier incarnation of the same
// symptom). They now take the same explicit 30s budget every other integration test in this suite
// already uses. The budget is a guard against a hang, not a performance assertion.
//
// Measured rather than assumed, because #1389's review asked whether the raise was masking a slowdown
// that PR introduced. Isolated runs of the first case, no neighbouring file, n=7 each:
//   - on that branch:                          median 3980ms, 2/7 over 5000ms
//   - with its new cron call neutered:         median 3209ms, 1/7 over 5000ms
// So both are true and neither alone is the whole story: this case exceeds the default budget on its
// own, which is what justifies the raise — and #1389 does add measurably to it (~0.8s at the median,
// one extra KV read and an empty sweep in `scheduled()`). Small n, wide overlap; treat the medians as
// indicative and the crossing counts as the finding.
describe('behavior — the real scheduled() handler persists whatever it live-fetched (#1371, widening #1227)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  // The EVENT time is pinned; the cache fixtures below are deliberately NOT. `scheduled()` derives its
  // `scheduledNow` from `event.scheduledTime`, and the daily-summary block fires when that lands in
  // `isInSummaryWindow` (09:00–09:05 and 10:00–10:05 UTC) — so with `Date.now()` these tests ran the
  // whole summary path, including unmocked Analytics Engine reads, for ten minutes every day, failing
  // as a 5s TIMEOUT rather than a legible assertion. Mid-month and off the hour, so no monthly or
  // hourly cron branch is entangled either.
  //
  // The fixtures stay wall-clock-relative because `cronAlertCheck` calls `isCacheStale(raw, threshold)`
  // with TWO arguments — its `now` defaults to `Date.now()` and the scheduled time never reaches it.
  // Pinning `cachedAt` to this constant therefore does not make a snapshot look fresh; it makes it
  // weeks stale, which silently moved the "fresh and unchanged" case onto the stale path and left the
  // not-stale branch covered by nothing. Both fixtures are relative to the same clock `isCacheStale`
  // reads, so they are deterministic without being pinned.
  const event = { scheduledTime: Date.parse('2026-08-12T12:07:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent

  // All-operational, exactly the real roster — matching ids avoids the #221 service-count-drop alert,
  // and matching status against whatever's "cached" below avoids an incidental status-edge (#488)
  // write, so a CACHE_KEY write in these tests can only be this change's re-seed.
  const OPERATIONAL: ServiceStatus[] = SERVICES.map(s => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))

  function fakeKv(cachedRaw: string | null) {
    const store = new Map<string, string>()
    if (cachedRaw !== null) store.set(CACHE_KEY, cachedRaw)
    // #1371 round 2 — options captured too: without them no BEHAVIOUR test pinned that the derived
    // TTL is what actually reaches KV, leaving that to a source-text regex, and this file's own
    // header records a source-text assertion once being satisfied by an unwired variant.
    const puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = []
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => { puts.push({ key, value, options }); store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace
    return { kv, puts }
  }

  async function runCron(cachedRaw: string | null) {
    const { kv, puts } = fakeKv(cachedRaw)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [] })
    await workerModule.scheduled(event, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' } as never, ctx)
    return { puts: puts.filter(p => p.key === CACHE_KEY) }
  }

  it('re-seeds CACHE_KEY when it was genuinely absent (a real KV miss)', async () => {
    const { puts } = await runCron(null)
    expect(puts.length, 'expected exactly one CACHE_KEY write on a genuine miss').toBe(1)
    const parsed = JSON.parse(puts[0].value)
    expect(parsed.services).toHaveLength(SERVICES.length)
  }, TEST_TIMEOUT_MS)

  it('does NOT re-seed when the cached snapshot is fresh and unchanged', async () => {
    // NOTE: `scheduled()` has its own unconditional fetchAllServices call outside cronAlertCheck (probe
    // archival), so this cannot assert "no live fetch at all" — only that a fresh, unchanged cache
    // produces no CACHE_KEY write, which is the behavior this test exists to pin.
    const fresh = JSON.stringify({ services: OPERATIONAL, upstreamFeeds: [], cachedAt: new Date().toISOString() })
    const { puts } = await runCron(fresh)
    expect(puts.length, 'no CACHE_KEY write should happen on a fresh, unchanged snapshot').toBe(0)
  }, TEST_TIMEOUT_MS)

  it('DOES write when the cached snapshot is stale-but-present — the #1371 fix', async () => {
    // Inverted from what this asserted before #1371, and the inversion IS the fix. The old contract
    // ("only a genuine miss qualifies") is what let the key run out its TTL: on a stale tick the cron
    // live-fetches for its alert decisions and used to DISCARD the result, so nothing refreshed the key
    // before it expired and every is-down page served a 503 until the next tick noticed the miss.
    const stale = JSON.stringify({ services: OPERATIONAL, upstreamFeeds: [], cachedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() })
    const { puts } = await runCron(stale)
    expect(fetchAllServices, 'a stale cache should still trigger the alert-decision live fetch').toHaveBeenCalled()
    expect(puts.length, 'the freshly fetched snapshot must be persisted, not discarded').toBe(1)
    const parsed = JSON.parse(puts[0].value)
    expect(parsed.services, 'and it must be the FRESH services, not the stale ones written back').toHaveLength(SERVICES.length)
    expect(puts[0].options?.expirationTtl, 'the derived TTL must be what reaches KV').toBe(CACHE_TTL_SECONDS)
  }, TEST_TIMEOUT_MS)
})

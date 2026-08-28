// #1227 follow-up — `cronAlertCheck` is not exported (same constraint as #1224's
// incidents-past-alert-age.test.ts), so part of this file pins wiring from source text. But
// `kv-read-census.test.ts` (also #1224) already learned the sharper lesson for this exact function:
// a source-text assertion is a hand-written parser, and three of them were once satisfied by an
// UNWIRED variant. So the behavior that matters — does a genuine cache miss actually write CACHE_KEY,
// and does a merely-stale-but-present snapshot NOT — is driven through the real `scheduled()` handler
// below, with `fetchAllServices` mocked so the fresh/cached snapshots can be made to agree exactly
// (no incidental status-diff alert, no service-count-drop alert) and the KV write is the only signal.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServiceStatus } from '../services'

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

  it('awaits refreshStatusCacheOnUnusableSnapshot with the derived flag, not `stale` or a literal', () => {
    expect(cronBody).toMatch(
      /await refreshStatusCacheOnUnusableSnapshot\(\s*env\.STATUS_CACHE,\s*snapshotUnusable,\s*freshServices,\s*freshFeeds,\s*CACHE_KEY,\s*CACHE_TTL_SECONDS\s*\)/,
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
    const reseedIdx = branch.indexOf('refreshStatusCacheOnUnusableSnapshot(')
    expect(adoptIdx, 'services = freshServices not found in branch').toBeGreaterThan(-1)
    expect(reseedIdx, 'refreshStatusCacheOnUnusableSnapshot call not found in branch').toBeGreaterThan(-1)
    expect(adoptIdx).toBeLessThan(reseedIdx)
  })

  it('has exactly one call site', () => {
    const occurrences = cronBody.split('refreshStatusCacheOnUnusableSnapshot(').length - 1
    expect(occurrences).toBe(1)
  })

  it('logs on a failed re-seed, gated on snapshotUnusable — not on every no-op call', () => {
    expect(cronBody).toMatch(/if \(snapshotUnusable && !reseeded\)/)
  })
})

describe('behavior — the real scheduled() handler re-seeds only on a genuine miss (#1227 follow-up)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  const event = { scheduledTime: Date.now(), cron: '*/5 * * * *' } as ScheduledEvent

  // All-operational, exactly the real roster — matching ids avoids the #221 service-count-drop alert,
  // and matching status against whatever's "cached" below avoids an incidental status-edge (#488)
  // write, so a CACHE_KEY write in these tests can only be this change's re-seed.
  const OPERATIONAL: ServiceStatus[] = SERVICES.map(s => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))

  function fakeKv(cachedRaw: string | null) {
    const store = new Map<string, string>()
    if (cachedRaw !== null) store.set(CACHE_KEY, cachedRaw)
    const puts: Array<{ key: string; value: string }> = []
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async (key: string, value: string) => { puts.push({ key, value }); store.set(key, value) },
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
  })

  it('does NOT re-seed when the cached snapshot is fresh and unchanged', async () => {
    // NOTE: `scheduled()` has its own unconditional fetchAllServices call outside cronAlertCheck (probe
    // archival), so this cannot assert "no live fetch at all" — only that a fresh, unchanged cache
    // produces no CACHE_KEY write, which is the behavior this test exists to pin.
    const fresh = JSON.stringify({ services: OPERATIONAL, upstreamFeeds: [], cachedAt: new Date().toISOString() })
    const { puts } = await runCron(fresh)
    expect(puts.length, 'no CACHE_KEY write should happen on a fresh, unchanged snapshot').toBe(0)
  })

  it('does NOT re-seed when the cached snapshot is stale-but-present — only a genuine miss qualifies', async () => {
    const stale = JSON.stringify({ services: OPERATIONAL, upstreamFeeds: [], cachedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() })
    const { puts } = await runCron(stale)
    expect(fetchAllServices, 'a stale cache should still trigger the alert-decision live fetch').toHaveBeenCalled()
    expect(puts.length, 'a stale-but-present snapshot must not be treated as a miss').toBe(0)
  })
})

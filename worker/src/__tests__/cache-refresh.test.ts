import { describe, it, expect, vi } from 'vitest'
import { refreshStatusCacheOnChange } from '../cache-refresh'
import type { ServiceStatus } from '../services'

const CACHE_KEY = 'services:latest'
const TTL = 900

function makeKV() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: async (k: string) => { store.delete(k) },
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string>; put: ReturnType<typeof vi.fn> }
}

const svc = (id: string, status: string): ServiceStatus => ({
  id, name: id, status, incidents: [],
} as unknown as ServiceStatus)

const SERVICES = [svc('chatgpt', 'down'), svc('claude', 'operational')]

describe('refreshStatusCacheOnChange (#488)', () => {
  it('writes the fresh snapshot to CACHE_KEY when an alert fired (sentCount > 0)', async () => {
    const kv = makeKV()
    const ok = await refreshStatusCacheOnChange(kv, SERVICES, 1, CACHE_KEY, TTL, 1_700_000_000_000)
    expect(ok).toBe(true)
    const raw = kv._store.get(CACHE_KEY)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.services).toEqual(SERVICES) // raw ServiceStatus[], cacheWrite contract
    expect(parsed.cachedAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(kv.put).toHaveBeenCalledWith(CACHE_KEY, expect.any(String), { expirationTtl: TTL })
  })

  it('uses Date.now() for cachedAt when `now` is omitted (the production cron call path) and stores a parseable ISO string', async () => {
    // The cron calls refreshStatusCacheOnChange WITHOUT the `now` arg, so the default-Date.now()
    // branch is the real path. Pin that cachedAt is an ISO string parseable back to a timestamp —
    // /api/status/cached + the existing cacheWrite both assume `cachedAt` is an ISO string.
    const kv = makeKV()
    const before = Date.now()
    const ok = await refreshStatusCacheOnChange(kv, SERVICES, 1, CACHE_KEY, TTL)
    expect(ok).toBe(true)
    const parsed = JSON.parse(kv._store.get(CACHE_KEY)!)
    expect(typeof parsed.cachedAt).toBe('string')
    const ts = Date.parse(parsed.cachedAt)
    expect(Number.isNaN(ts)).toBe(false)
    expect(ts).toBeGreaterThanOrEqual(before - 1000)
  })

  it('does NOT write when no alert fired (sentCount === 0)', async () => {
    const kv = makeKV()
    const ok = await refreshStatusCacheOnChange(kv, SERVICES, 0, CACHE_KEY, TTL)
    expect(ok).toBe(false)
    expect(kv.put).not.toHaveBeenCalled()
    expect(kv._store.has(CACHE_KEY)).toBe(false)
  })

  it('does NOT write when services is empty (defensive — never cache a 0-service snapshot)', async () => {
    const kv = makeKV()
    const ok = await refreshStatusCacheOnChange(kv, [], 3, CACHE_KEY, TTL)
    expect(ok).toBe(false)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('returns false (does not throw) when the KV write fails — caller keeps its throttle clock', async () => {
    const kv = makeKV()
    kv.put.mockRejectedValueOnce(new Error('kv down'))
    const ok = await refreshStatusCacheOnChange(kv, SERVICES, 1, CACHE_KEY, TTL)
    expect(ok).toBe(false) // kvPut swallows + returns false; no throw
  })

  // NOTE: the cron wiring in index.ts (setting `lastKvWrite` after a successful refresh, and only
  // calling this on status-change edges) is NOT unit-tested — cronAlertCheck isn't exported, which is
  // why this pure function was extracted. That throttle-bypass alignment is verified by inspection.
  it('has no internal throttle — writes on every qualifying call (the throttle bypass lives in the caller)', async () => {
    // The function has no throttle of its own; it writes whenever sentCount > 0. This pins that
    // contract so a future refactor doesn't accidentally reintroduce a 10-min gate here.
    const kv = makeKV()
    await refreshStatusCacheOnChange(kv, SERVICES, 1, CACHE_KEY, TTL, 1)
    await refreshStatusCacheOnChange(kv, SERVICES, 1, CACHE_KEY, TTL, 2) // immediately again
    expect(kv.put).toHaveBeenCalledTimes(2)
  })
})

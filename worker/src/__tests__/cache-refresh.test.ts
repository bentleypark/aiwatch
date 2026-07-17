import { describe, it, expect, vi } from 'vitest'
import { refreshStatusCacheOnChange, writeStatusCache, hasStatusEdge, refreshStatusCacheOnLiveEdge } from '../cache-refresh'
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

  it('writes byte-identically to the shared writeStatusCache primitive (no drift between #488 and #1057)', async () => {
    // Both event-driven refreshes must produce the SAME { services, cachedAt } JSON that
    // /api/status/cached reads. Pin that refreshStatusCacheOnChange delegates to writeStatusCache so a
    // future edit to one shape can't silently diverge the other (feedback: shared primitive > copies).
    const a = makeKV()
    const b = makeKV()
    await refreshStatusCacheOnChange(a, SERVICES, 1, CACHE_KEY, TTL, 1_700_000_000_000)
    await writeStatusCache(b, SERVICES, CACHE_KEY, TTL, 1_700_000_000_000)
    expect(a._store.get(CACHE_KEY)).toBe(b._store.get(CACHE_KEY))
  })
})

describe('hasStatusEdge (#1057)', () => {
  // The regression this fn exists to catch: cached snapshot says operational, the live poll sees down.
  // Before #1057 the throttled /api/status handler ignored this, so is-down/OG kept previewing the
  // green card until the cron's alert-edge refresh (bound to the Discord alert). This must return true.
  it('detects the operational→down edge that stranded the OG card (the whole-turn root cause)', () => {
    const cached = [svc('claude', 'operational'), svc('openai', 'operational')]
    const fresh = [svc('claude', 'down'), svc('openai', 'operational')]
    expect(hasStatusEdge(fresh, cached)).toBe(true)
  })

  it('detects a recovery edge (down→operational) too, so the card flips back to green promptly', () => {
    const cached = [svc('claude', 'down')]
    const fresh = [svc('claude', 'operational')]
    expect(hasStatusEdge(fresh, cached)).toBe(true)
  })

  it('detects a degraded edge (operational→degraded)', () => {
    expect(hasStatusEdge([svc('mistral', 'degraded')], [svc('mistral', 'operational')])).toBe(true)
  })

  it('returns false when every service status is unchanged (steady state — no forced write)', () => {
    const snap = [svc('claude', 'down'), svc('openai', 'operational')]
    expect(hasStatusEdge(snap, [svc('claude', 'down'), svc('openai', 'operational')])).toBe(false)
  })

  it('returns false when cached is null or empty (nothing to diff — bootstrap is the throttled writer\'s job)', () => {
    expect(hasStatusEdge([svc('claude', 'down')], null)).toBe(false)
    expect(hasStatusEdge([svc('claude', 'down')], undefined)).toBe(false)
    expect(hasStatusEdge([svc('claude', 'down')], [])).toBe(false)
  })

  it('does NOT treat a service present in fresh but ABSENT from cached as an edge (roster change ≠ status flip)', () => {
    // A brand-new service (rollout) would otherwise force a write every poll until the cache caught up.
    const cached = [svc('claude', 'operational')]
    const fresh = [svc('claude', 'operational'), svc('newsvc', 'down')]
    expect(hasStatusEdge(fresh, cached)).toBe(false)
  })

  it('ignores order and cached-only services — edge is decided per shared id', () => {
    const cached = [svc('a', 'operational'), svc('b', 'operational'), svc('gone', 'down')]
    const fresh = [svc('b', 'operational'), svc('a', 'operational')] // reordered, no change
    expect(hasStatusEdge(fresh, cached)).toBe(false)
  })
})

describe('writeStatusCache (#1057 shared primitive)', () => {
  it('writes { services, cachedAt } to cacheKey and returns kvPut success', async () => {
    const kv = makeKV()
    const ok = await writeStatusCache(kv, SERVICES, CACHE_KEY, TTL, 1_700_000_000_000)
    expect(ok).toBe(true)
    const parsed = JSON.parse(kv._store.get(CACHE_KEY)!)
    expect(parsed.services).toEqual(SERVICES)
    expect(parsed.cachedAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(kv.put).toHaveBeenCalledWith(CACHE_KEY, expect.any(String), { expirationTtl: TTL })
  })

  it('returns false (does not throw) when the KV write fails', async () => {
    const kv = makeKV()
    kv.put.mockRejectedValueOnce(new Error('kv down'))
    expect(await writeStatusCache(kv, SERVICES, CACHE_KEY, TTL)).toBe(false)
  })
})

describe('refreshStatusCacheOnLiveEdge (#1057 — the /api/status wiring)', () => {
  // These tests cover the read→edge→write SEQUENCE that IS the #1057 fix — a green hasStatusEdge test
  // alone would also pass against the pre-#1057 handler that never consulted the edge, so the pure fn
  // is not enough (순수fn 초록 ≠ 배선 초록). The handler calls this with `wrote` from cacheWrite and
  // index.ts's `cacheRead`; here we inject a fake reader so the sequence is exercised with makeKV.
  const OPERATIONAL = [svc('claude', 'operational'), svc('openai', 'operational')]
  const CLAUDE_DOWN = [svc('claude', 'down'), svc('openai', 'operational')]

  it('force-writes CACHE_KEY when throttled (wrote=false) AND a status edge exists — the fix', async () => {
    const kv = makeKV()
    const read = vi.fn(async () => ({ services: OPERATIONAL })) // cached snapshot still operational
    const outcome = await refreshStatusCacheOnLiveEdge(kv, false, CLAUDE_DOWN, CACHE_KEY, TTL, read, 1_700_000_000_000)
    expect(outcome).toBe('refreshed')
    const parsed = JSON.parse(kv._store.get(CACHE_KEY)!)
    expect(parsed.services).toEqual(CLAUDE_DOWN) // the fresh down-snapshot is now what OG/SSR will read
  })

  it('does NOT read or write when cacheWrite already wrote (wrote=true) — guards against a per-poll read regression', async () => {
    const kv = makeKV()
    const read = vi.fn(async () => ({ services: OPERATIONAL }))
    const outcome = await refreshStatusCacheOnLiveEdge(kv, true, CLAUDE_DOWN, CACHE_KEY, TTL, read)
    expect(outcome).toBe('skipped')
    expect(read).not.toHaveBeenCalled()   // the read must stay on the throttled path only
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('does NOT write when throttled but status is unchanged (steady state)', async () => {
    const kv = makeKV()
    const read = vi.fn(async () => ({ services: CLAUDE_DOWN })) // cache already reflects the down state
    const outcome = await refreshStatusCacheOnLiveEdge(kv, false, CLAUDE_DOWN, CACHE_KEY, TTL, read)
    expect(outcome).toBe('skipped')
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('does NOT write when the cache is cold/null (bootstrap stays the throttled writer\'s job)', async () => {
    const kv = makeKV()
    const read = vi.fn(async () => null)
    const outcome = await refreshStatusCacheOnLiveEdge(kv, false, CLAUDE_DOWN, CACHE_KEY, TTL, read)
    expect(outcome).toBe('skipped')
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('returns refresh-failed (observable) when the forced write fails — so the failure is not silent', async () => {
    const kv = makeKV()
    kv.put.mockRejectedValueOnce(new Error('kv down'))
    const read = vi.fn(async () => ({ services: OPERATIONAL }))
    const outcome = await refreshStatusCacheOnLiveEdge(kv, false, CLAUDE_DOWN, CACHE_KEY, TTL, read)
    expect(outcome).toBe('refresh-failed') // handler logs console.error on this — the #488-parity fix
  })

  it('is self-silencing: once the forced write lands, the next poll reads the fresh snapshot → no re-fire', async () => {
    // Documents the "no runaway writes" intent: after a refresh the cache equals `fresh`, so the very
    // next call sees no edge. Simulated by a reader returning the just-written snapshot.
    const kv = makeKV()
    const read = vi.fn(async () => ({ services: CLAUDE_DOWN })) // cache now already == fresh
    const outcome = await refreshStatusCacheOnLiveEdge(kv, false, CLAUDE_DOWN, CACHE_KEY, TTL, read)
    expect(outcome).toBe('skipped')
    expect(kv.put).not.toHaveBeenCalled()
  })

  // NOT unit-tested (by inspection, mirroring the #488 note above — both are unexported seams in the
  // fetch handler that mutate module state): (1) `cacheWrite`'s boolean return (throttle-skip → false,
  // pass → true) that SOURCES the `wrote` arg — a two-line early-return; and (2) the 2-line
  // handler call+log inside `ctx.waitUntil`. All the decision logic they feed is exported + tested here,
  // so the residual is argument-binding + log strings only.
})

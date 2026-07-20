import { describe, it, expect } from 'vitest'
import { isCacheStale } from '../utils'

const THRESHOLD = 10 * 60 * 1000 // 10 minutes
const NOW = 1712400000000 // fixed timestamp

describe('isCacheStale', () => {
  it('returns stale when raw is null', () => {
    const result = isCacheStale(null, THRESHOLD, NOW)
    expect(result.stale).toBe(true)
    expect(result.services).toEqual([])
  })

  it('returns stale when raw is invalid JSON', () => {
    const result = isCacheStale('not-json{{{', THRESHOLD, NOW)
    expect(result.stale).toBe(true)
    expect(result.services).toEqual([])
  })

  it('returns stale when services array is empty', () => {
    const raw = JSON.stringify({ services: [], cachedAt: new Date(NOW).toISOString() })
    const result = isCacheStale(raw, THRESHOLD, NOW)
    expect(result.stale).toBe(true)
    expect(result.services).toEqual([])
  })

  it('returns stale when cachedAt is missing', () => {
    const raw = JSON.stringify({ services: [{ id: 'test' }] })
    const result = isCacheStale(raw, THRESHOLD, NOW)
    expect(result.stale).toBe(true)
    expect(result.services).toHaveLength(1)
  })

  it('returns stale when cachedAt is older than threshold', () => {
    const staleTime = new Date(NOW - THRESHOLD - 1000).toISOString() // 11 min ago
    const raw = JSON.stringify({ services: [{ id: 'test' }], cachedAt: staleTime })
    const result = isCacheStale(raw, THRESHOLD, NOW)
    expect(result.stale).toBe(true)
    expect(result.services).toHaveLength(1)
  })

  it('returns not stale when cachedAt is within threshold', () => {
    const freshTime = new Date(NOW - 5 * 60 * 1000).toISOString() // 5 min ago
    const raw = JSON.stringify({ services: [{ id: 'test' }], cachedAt: freshTime })
    const result = isCacheStale(raw, THRESHOLD, NOW)
    expect(result.stale).toBe(false)
    expect(result.services).toHaveLength(1)
  })

  it('returns not stale at exact threshold boundary', () => {
    const boundaryTime = new Date(NOW - THRESHOLD).toISOString() // exactly 10 min ago
    const raw = JSON.stringify({ services: [{ id: 'test' }], cachedAt: boundaryTime })
    const result = isCacheStale(raw, THRESHOLD, NOW)
    expect(result.stale).toBe(false) // not stale at exact boundary
  })

  it('handles legacy format (plain array without wrapper)', () => {
    // Old format was just an array, not { services, cachedAt }
    const raw = JSON.stringify([{ id: 'test' }])
    const result = isCacheStale(raw, THRESHOLD, NOW)
    expect(result.stale).toBe(true) // no cachedAt → stale
    expect(result.services).toHaveLength(1)
  })
})

// #1072 — isCacheStale is the CRON's only parser of the snapshot shape, and the cron's #488
// alert-edge refresh REWRITES that snapshot. So whatever this function fails to extract, the cron
// cannot carry forward, and the next alert-edge write erases it from KV. That write fires exactly
// when an incident starts. Before this block existed, replacing the extraction with a hardcoded `[]`
// left the rest of the worker suite green — nothing else covers this parser (the wiring test's `upstreamFeeds: cachedFeeds` pin is
// a source pin on index.ts and survives the mutation; cache-refresh.test.ts round-trips the WRITER).
describe('isCacheStale — upstreamFeeds extraction (#1072)', () => {
  const FEEDS = [{ id: 'github-platform', name: 'GitHub', status: 'degraded', incidents: [] }]
  const snapshot = (extra: Record<string, unknown>, cachedAt: string | undefined = new Date(NOW).toISOString()) =>
    JSON.stringify({ services: [{ id: 'chatgpt' }], ...(cachedAt ? { cachedAt } : {}), ...extra })

  it('returns the feeds from a current snapshot', () => {
    expect(isCacheStale(snapshot({ upstreamFeeds: FEEDS }), THRESHOLD, NOW).upstreamFeeds).toEqual(FEEDS)
  })

  it('returns the feeds even when the snapshot is STALE (the cron still carries them forward)', () => {
    // The stale branch is not a "give up" path: the cron live-fetches on stale, but if that fetch
    // fails it keeps the cached services — and must keep the matching feeds, from the same snapshot.
    // Returning [] here would erase them on the next alert-edge write.
    const old = new Date(NOW - 60 * 60 * 1000).toISOString()
    const r = isCacheStale(snapshot({ upstreamFeeds: FEEDS }, old), THRESHOLD, NOW)
    expect(r.stale).toBe(true)
    expect(r.upstreamFeeds).toEqual(FEEDS)
  })

  it('returns [] for a pre-#1072 snapshot with no such key (the deploy-skew shape)', () => {
    expect(isCacheStale(snapshot({}), THRESHOLD, NOW).upstreamFeeds).toEqual([])
  })

  it('returns [] for the legacy bare-array snapshot (no room for feeds in that shape)', () => {
    expect(isCacheStale(JSON.stringify([{ id: 'chatgpt' }]), THRESHOLD, NOW).upstreamFeeds).toEqual([])
  })

  it('returns [] when upstreamFeeds is present but not an array (corrupt / hand-edited KV)', () => {
    expect(isCacheStale(snapshot({ upstreamFeeds: 'nope' }), THRESHOLD, NOW).upstreamFeeds).toEqual([])
    expect(isCacheStale(snapshot({ upstreamFeeds: null }), THRESHOLD, NOW).upstreamFeeds).toEqual([])
  })

  it('returns [] on unparseable JSON and on a null snapshot', () => {
    expect(isCacheStale('not-json{{{', THRESHOLD, NOW).upstreamFeeds).toEqual([])
    expect(isCacheStale(null, THRESHOLD, NOW).upstreamFeeds).toEqual([])
  })

  it('returns [] when services is empty — feeds must not survive a rejected snapshot', () => {
    // The early return pairs them deliberately: a snapshot with no services is refused wholesale, and
    // handing back feeds from it would mix a rejected snapshot's data into the next write.
    const r = isCacheStale(JSON.stringify({ services: [], upstreamFeeds: FEEDS, cachedAt: new Date(NOW).toISOString() }), THRESHOLD, NOW)
    expect(r.services).toEqual([])
    expect(r.upstreamFeeds).toEqual([])
  })
})

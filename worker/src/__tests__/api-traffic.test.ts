import { describe, it, expect, vi } from 'vitest'
import {
  v1Variant,
  recordV1Traffic,
  buildV1TrafficSql,
  parseV1TrafficResponse,
  queryV1Traffic,
  feedVariant,
  recordFeedTraffic,
  buildFeedTrafficSql,
  parseFeedTrafficResponse,
  queryFeedTraffic,
  buildExtTrafficSql,
  parseExtTrafficResponse,
  queryExtTraffic,
  buildStatuslineTrafficSql,
  parseStatuslineTrafficResponse,
  queryStatuslineTraffic,
  countFirstSeenWithin24h,
  countNewFeedItems,
} from '../api-traffic'

describe('v1Variant (#518)', () => {
  it('classifies the bare endpoint as all-services', () => {
    expect(v1Variant('/api/v1/status')).toBe('v1-status-all')
    expect(v1Variant('/api/v1/status/')).toBe('v1-status-all')
  })

  it('classifies a per-service path as service', () => {
    expect(v1Variant('/api/v1/status/claude')).toBe('v1-status-service')
    expect(v1Variant('/api/v1/status/openai')).toBe('v1-status-service')
  })
})

describe('recordV1Traffic (#518)', () => {
  it('writes one data point with the pinned blob/double/index shape', () => {
    const wae = { writeDataPoint: vi.fn() }
    recordV1Traffic(wae as unknown as AnalyticsEngineDataset, '/api/v1/status')
    expect(wae.writeDataPoint).toHaveBeenCalledOnce()
    expect(wae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ['v1-status-all'],
      doubles: [1],
      indexes: ['v1-status'],
    })
  })

  it('tags the per-service variant in blob1 but keeps the shared index', () => {
    const wae = { writeDataPoint: vi.fn() }
    recordV1Traffic(wae as unknown as AnalyticsEngineDataset, '/api/v1/status/claude')
    const call = wae.writeDataPoint.mock.calls[0][0]
    expect(call.blobs[0]).toBe('v1-status-service')
    expect(call.indexes[0]).toBe('v1-status') // shared dimension → total-v1 queryable with one filter
  })

  it('keeps the index within the 32-byte WAE cap', () => {
    const wae = { writeDataPoint: vi.fn() }
    recordV1Traffic(wae as unknown as AnalyticsEngineDataset, '/api/v1/status')
    const call = wae.writeDataPoint.mock.calls[0][0]
    expect(call.indexes[0].length).toBeLessThanOrEqual(32)
    expect(call.blobs[0].length).toBeLessThanOrEqual(32)
  })

  it('does not write when the binding is absent (local dev / tests)', () => {
    const wae = { writeDataPoint: vi.fn() }
    recordV1Traffic(undefined, '/api/v1/status')
    expect(wae.writeDataPoint).not.toHaveBeenCalled()
  })

  it('swallows a writeDataPoint failure (best-effort, never aborts the response)', () => {
    const wae = { writeDataPoint: vi.fn(() => { throw new Error('WAE down') }) }
    expect(() => recordV1Traffic(wae as unknown as AnalyticsEngineDataset, '/api/v1/status')).not.toThrow()
  })
})

describe('buildV1TrafficSql (#518)', () => {
  it('sums sample-corrected counts per variant over the last 24h, filtered by the index', () => {
    const sql = buildV1TrafficSql()
    expect(sql).toContain('SUM(_sample_interval)') // sampling-corrected, not COUNT(*)
    expect(sql).toContain("index1 = 'v1-status'")
    expect(sql).toContain("INTERVAL '1' DAY")
    expect(sql).toContain('GROUP BY blob1')
    expect(sql).toContain('FROM aiwatch_statusline') // matches the wrangler.toml dataset
  })
})

describe('parseV1TrafficResponse (#518)', () => {
  it('sums per-variant rows into all/service/total (numeric requests)', () => {
    const r = parseV1TrafficResponse({ data: [
      { variant: 'v1-status-all', requests: 120 },
      { variant: 'v1-status-service', requests: 30 },
    ] })
    expect(r).toEqual({ all: 120, service: 30, total: 150 })
  })

  it('tolerates string-typed requests (AE JSON sometimes stringifies numbers)', () => {
    const r = parseV1TrafficResponse({ data: [{ variant: 'v1-status-all', requests: '42' }] })
    expect(r).toEqual({ all: 42, service: 0, total: 42 })
  })

  it('preserves fractional sample-corrected sums on the string path (not floored)', () => {
    // SUM(_sample_interval) is fractional under sampling; Number() must not truncate like parseInt would.
    const r = parseV1TrafficResponse({ data: [{ variant: 'v1-status-all', requests: '123.7' }] })
    expect(r?.all).toBeCloseTo(123.7)
  })

  it('maps a NaN/garbage requests value to 0', () => {
    const r = parseV1TrafficResponse({ data: [{ variant: 'v1-status-all', requests: 'abc' }] })
    expect(r).toEqual({ all: 0, service: 0, total: 0 })
  })

  it('ignores unknown variants and treats missing data as null', () => {
    expect(parseV1TrafficResponse({ data: [{ variant: 'other', requests: 9 }] }))
      .toEqual({ all: 0, service: 0, total: 0 })
    expect(parseV1TrafficResponse({})).toBeNull()
    expect(parseV1TrafficResponse({ data: 'nope' })).toBeNull()
  })
})

describe('queryV1Traffic (#518)', () => {
  const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response

  it('returns null without an account id or token (not configured)', async () => {
    const fetchSpy = vi.fn()
    expect(await queryV1Traffic(undefined, 'tok', fetchSpy as unknown as typeof fetch)).toBeNull()
    expect(await queryV1Traffic('acct', undefined, fetchSpy as unknown as typeof fetch)).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled() // no HTTP call attempted
  })

  it('POSTs SQL to the AE endpoint with a Bearer token and parses the result', async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init: { method: string; headers: { Authorization: string }; body: string }) =>
        okResponse({ data: [
          { variant: 'v1-status-all', requests: 7 },
          { variant: 'v1-status-service', requests: 3 },
        ] }),
    )
    const r = await queryV1Traffic('acct123', 'secret-tok', fetchSpy as unknown as typeof fetch)
    expect(r).toEqual({ all: 7, service: 3, total: 10 })
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/analytics_engine/sql')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer secret-tok')
    expect(init.body).toContain('SUM(_sample_interval)')
  })

  it('returns null on a non-2xx response (best-effort)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response)
    expect(await queryV1Traffic('acct', 'tok', fetchSpy as unknown as typeof fetch)).toBeNull()
  })

  it('returns null (never throws) when fetch rejects', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('network down') })
    await expect(queryV1Traffic('acct', 'tok', fetchSpy as unknown as typeof fetch)).resolves.toBeNull()
  })
})

// ── Feed-poll traffic (#548) ──────────────────────────────────────────────
describe('feedVariant (#548)', () => {
  it('classifies /feed.xml as feed-all, /feed/:slug as feed-service', () => {
    expect(feedVariant('/feed.xml')).toBe('feed-all')
    expect(feedVariant('/feed/claude-code')).toBe('feed-service')
    expect(feedVariant('/feed/openai')).toBe('feed-service')
  })
})

describe('recordFeedTraffic (#548)', () => {
  it('writes one data point with index feed-poll and the variant blob', () => {
    const writeDataPoint = vi.fn()
    recordFeedTraffic({ writeDataPoint } as unknown as AnalyticsEngineDataset, '/feed.xml')
    expect(writeDataPoint).toHaveBeenCalledWith({ blobs: ['feed-all'], doubles: [1], indexes: ['feed-poll'] })
    recordFeedTraffic({ writeDataPoint } as unknown as AnalyticsEngineDataset, '/feed/claude')
    expect(writeDataPoint).toHaveBeenLastCalledWith({ blobs: ['feed-service'], doubles: [1], indexes: ['feed-poll'] })
  })

  it('is a no-op when the binding is absent (local dev / tests)', () => {
    expect(() => recordFeedTraffic(undefined, '/feed.xml')).not.toThrow()
  })

  it('swallows a writeDataPoint throw (never aborts the response)', () => {
    const writeDataPoint = vi.fn(() => { throw new Error('WAE down') })
    expect(() => recordFeedTraffic({ writeDataPoint } as unknown as AnalyticsEngineDataset, '/feed.xml')).not.toThrow()
  })
})

describe('buildFeedTrafficSql (#548)', () => {
  it('filters on index1 = feed-poll over the last day', () => {
    const sql = buildFeedTrafficSql()
    expect(sql).toContain("index1 = 'feed-poll'")
    expect(sql).toContain("SUM(_sample_interval)")
    expect(sql).toContain("INTERVAL '1' DAY")
  })
})

describe('parseFeedTrafficResponse (#548)', () => {
  it('sums feed-all + feed-service into total', () => {
    const json = { data: [{ variant: 'feed-all', requests: '120' }, { variant: 'feed-service', requests: 45 }] }
    expect(parseFeedTrafficResponse(json)).toEqual({ all: 120, service: 45, total: 165 })
  })

  it('returns null for a malformed payload', () => {
    expect(parseFeedTrafficResponse({})).toBeNull()
    expect(parseFeedTrafficResponse(null)).toBeNull()
  })

  it('ignores unknown variants and coerces NaN to 0', () => {
    const json = { data: [{ variant: 'feed-all', requests: 'oops' }, { variant: 'other', requests: 9 }] }
    expect(parseFeedTrafficResponse(json)).toEqual({ all: 0, service: 0, total: 0 })
  })
})

describe('queryFeedTraffic (#548)', () => {
  it('returns null without account id / token (no SQL call)', async () => {
    const fetchImpl = vi.fn()
    expect(await queryFeedTraffic(undefined, 'tok', fetchImpl)).toBeNull()
    expect(await queryFeedTraffic('acc', undefined, fetchImpl)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns null on a non-OK HTTP response', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 }))
    expect(await queryFeedTraffic('acc', 'tok', fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it('parses a successful response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ variant: 'feed-all', requests: 7 }] }), { status: 200 }))
    expect(await queryFeedTraffic('acc', 'tok', fetchImpl as unknown as typeof fetch)).toEqual({ all: 7, service: 0, total: 7 })
  })
})

describe('countFirstSeenWithin24h (#748)', () => {
  const NOW = new Date('2026-06-23T00:00:00.000Z')
  it('counts only timestamps within the 24h window ending at now', () => {
    const values = [
      '2026-06-22T23:00:00.000Z', // 1h ago — in
      '2026-06-22T00:30:00.000Z', // 23.5h ago — in
      '2026-06-21T23:00:00.000Z', // 25h ago — out
      '2026-06-23T00:00:00.000Z', // exactly now — in (inclusive)
    ]
    expect(countFirstSeenWithin24h(values, NOW)).toBe(3)
  })
  it('skips null / empty / unparseable values', () => {
    expect(countFirstSeenWithin24h([null, undefined, '', 'not-a-date', '2026-06-22T23:00:00.000Z'], NOW)).toBe(1)
  })
  it('returns 0 for an empty list', () => {
    expect(countFirstSeenWithin24h([], NOW)).toBe(0)
  })
})

describe('countNewFeedItems (#748)', () => {
  const NOW = new Date('2026-06-23T00:00:00.000Z')
  const kvOf = (entries: Record<string, string>, opts: { listThrows?: boolean; getThrows?: boolean } = {}) => ({
    list: vi.fn(async () => {
      if (opts.listThrows) throw new Error('kv list down')
      return { keys: Object.keys(entries).map((name) => ({ name })), list_complete: true }
    }),
    get: vi.fn(async (k: string) => {
      if (opts.getThrows) throw new Error('kv get down')
      return entries[k] ?? null
    }),
  }) as unknown as KVNamespace

  it('lists feed:firstseen markers and counts those in the last 24h', async () => {
    const kv = kvOf({
      'feed:firstseen:a': '2026-06-22T23:00:00.000Z', // in
      'feed:firstseen:b': '2026-06-20T00:00:00.000Z', // out (3d ago)
      'feed:firstseen:c': '2026-06-22T12:00:00.000Z', // in
    })
    expect(await countNewFeedItems(kv, NOW)).toBe(2)
  })
  it('returns 0 when there are no markers', async () => {
    expect(await countNewFeedItems(kvOf({}), NOW)).toBe(0)
  })
  it('returns null (best-effort) when KV list throws', async () => {
    expect(await countNewFeedItems(kvOf({}, { listThrows: true }), NOW)).toBeNull()
  })
  it('treats a failed per-key get as absent (not a throw)', async () => {
    const kv = kvOf({ 'feed:firstseen:a': '2026-06-22T23:00:00.000Z' }, { getThrows: true })
    expect(await countNewFeedItems(kv, NOW)).toBe(0)
  })
})

describe('ext-claude traffic (#837)', () => {
  it('buildExtTrafficSql filters index1=ext-claude, 24h window, single total', () => {
    const sql = buildExtTrafficSql()
    expect(sql).toContain("index1 = 'ext-claude'")
    expect(sql).toContain('SUM(_sample_interval) AS requests')
    expect(sql).toContain('FROM aiwatch_statusline')
    expect(sql).toContain("INTERVAL '1' DAY")
    expect(sql).not.toContain('GROUP BY') // single total, no variant split
  })

  it('parseExtTrafficResponse reads the single total (tolerant of string/number)', () => {
    expect(parseExtTrafficResponse({ data: [{ requests: '4212' }] })).toBe(4212)
    expect(parseExtTrafficResponse({ data: [{ requests: 7 }] })).toBe(7)
    expect(parseExtTrafficResponse({ data: [{ requests: 'nope' }] })).toBe(0) // unparseable → 0
    expect(parseExtTrafficResponse({ data: [] })).toBeNull() // no rows → null
    expect(parseExtTrafficResponse({})).toBeNull()
    expect(parseExtTrafficResponse(null)).toBeNull()
  })

  it('queryExtTraffic returns null without creds and never throws on failure', async () => {
    expect(await queryExtTraffic(undefined, undefined)).toBeNull()
    const boom = vi.fn().mockRejectedValue(new Error('network'))
    expect(await queryExtTraffic('acc', 'tok', boom as unknown as typeof fetch)).toBeNull()
    const notOk = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    expect(await queryExtTraffic('acc', 'tok', notOk as unknown as typeof fetch)).toBeNull()
  })

  it('queryExtTraffic parses a successful response', async () => {
    const ok = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ requests: 123 }] }) })
    expect(await queryExtTraffic('acc', 'tok', ok as unknown as typeof fetch)).toBe(123)
  })
})

describe('statusline traffic (#918)', () => {
  it('buildStatuslineTrafficSql filters index1 LIKE statusline-%, 24h window, per-preset group', () => {
    const sql = buildStatuslineTrafficSql()
    expect(sql).toContain("index1 LIKE 'statusline-%'")
    expect(sql).toContain('index1 AS preset')
    expect(sql).toContain('SUM(_sample_interval) AS requests')
    expect(sql).toContain('FROM aiwatch_statusline')
    expect(sql).toContain("INTERVAL '1' DAY")
    expect(sql).toContain('GROUP BY index1') // per-preset (index1 is multi-valued, unlike ext-claude)
  })

  it('parseStatuslineTrafficResponse strips the prefix, sums per-preset + total (string/number tolerant)', () => {
    const json = { data: [
      { preset: 'statusline-branded', requests: '120' },
      { preset: 'statusline-degraded_only', requests: 45 },
      { preset: 'statusline-clickable', requests: 'nope' }, // unparseable → 0
    ] }
    expect(parseStatuslineTrafficResponse(json)).toEqual({
      byPreset: { branded: 120, degraded_only: 45, clickable: 0 },
      total: 165,
    })
  })

  it('parseStatuslineTrafficResponse ignores rows whose index1 is not a statusline- tag', () => {
    const json = { data: [
      { preset: 'statusline-branded', requests: 10 },
      { preset: 'ext-claude', requests: 999 },   // wrong tag (LIKE guard belt-and-suspenders) → skipped
      { preset: null, requests: 5 },             // invalid → skipped
    ] }
    expect(parseStatuslineTrafficResponse(json)).toEqual({ byPreset: { branded: 10 }, total: 10 })
  })

  it('parseStatuslineTrafficResponse returns null on malformed shape, empty on no rows', () => {
    expect(parseStatuslineTrafficResponse({})).toBeNull()
    expect(parseStatuslineTrafficResponse(null)).toBeNull()
    expect(parseStatuslineTrafficResponse({ data: [] })).toEqual({ byPreset: {}, total: 0 })
  })

  it('queryStatuslineTraffic returns null without creds and never throws on failure', async () => {
    expect(await queryStatuslineTraffic(undefined, undefined)).toBeNull()
    const boom = vi.fn().mockRejectedValue(new Error('network'))
    expect(await queryStatuslineTraffic('acc', 'tok', boom as unknown as typeof fetch)).toBeNull()
    const notOk = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    expect(await queryStatuslineTraffic('acc', 'tok', notOk as unknown as typeof fetch)).toBeNull()
  })

  it('queryStatuslineTraffic parses a successful response', async () => {
    const ok = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
      { preset: 'statusline-branded', requests: 88 },
      { preset: 'statusline-scoped', requests: 12 },
    ] }) })
    expect(await queryStatuslineTraffic('acc', 'tok', ok as unknown as typeof fetch)).toEqual({
      byPreset: { branded: 88, scoped: 12 }, total: 100,
    })
  })
})

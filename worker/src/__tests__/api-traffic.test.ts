import { describe, it, expect, vi } from 'vitest'
import {
  v1Variant,
  recordV1Traffic,
  buildV1TrafficSql,
  parseV1TrafficResponse,
  queryV1Traffic,
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
    const fetchSpy = vi.fn(async () => okResponse({ data: [
      { variant: 'v1-status-all', requests: 7 },
      { variant: 'v1-status-service', requests: 3 },
    ] }))
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

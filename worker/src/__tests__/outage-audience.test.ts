import { describe, it, expect, vi } from 'vitest'
import {
  classifyReferrer,
  parsePageviewBody,
  parseOutageAudienceResponse,
  buildOutageAudienceSql,
  queryOutageAudience,
  recordOutageView,
} from '../outage-audience'

describe('classifyReferrer (#842-B)', () => {
  it('classifies X via utm_source (referrer stripped by the X app)', () => {
    expect(classifyReferrer('x', '')).toBe('x')
    expect(classifyReferrer('twitter', '')).toBe('x')
  })
  it('classifies X via referrer host', () => {
    expect(classifyReferrer('', 'x.com')).toBe('x')
    expect(classifyReferrer('', 't.co')).toBe('x')
    expect(classifyReferrer('', 'mobile.twitter.com')).toBe('x')
  })
  it('classifies our feed links via utm_source=rss/feed, and the Discord alert as feed (#936)', () => {
    expect(classifyReferrer('rss', '')).toBe('feed')
    expect(classifyReferrer('feed', '')).toBe('feed')
    expect(classifyReferrer('discord', '')).toBe('feed') // #936 — Discord alert = our notification feed
  })
  it('classifies our own client surfaces (extension/statusline) as owned (#936)', () => {
    expect(classifyReferrer('extension', '')).toBe('owned')
    expect(classifyReferrer('statusline', '')).toBe('owned')
  })
  it('classifies organic search by host', () => {
    expect(classifyReferrer('', 'www.google.com')).toBe('search')
    expect(classifyReferrer('', 'duckduckgo.com')).toBe('search')
    expect(classifyReferrer('', 'search.brave.com')).toBe('search')
  })
  it('falls back to direct for no referrer / unknown / minor share channels', () => {
    expect(classifyReferrer('', '')).toBe('direct')
    expect(classifyReferrer('threads', '')).toBe('direct')
    expect(classifyReferrer('copy-link', '')).toBe('direct')
    expect(classifyReferrer('', 'some-blog.example')).toBe('direct')
  })
  it('buckets the Claude Code plugin is-down links (utm_source=claude-code) as plugin (#920)', () => {
    expect(classifyReferrer('claude-code', '')).toBe('plugin')
    expect(classifyReferrer('Claude-Code', '')).toBe('plugin') // case-insensitive
  })
  it('utm takes priority and is case-insensitive', () => {
    expect(classifyReferrer('X', 'google.com')).toBe('x')
  })
  it('applies branch precedence: X-host wins over a feed utm (documents the ordering)', () => {
    // utm=rss (would be 'feed') but the referrer host is x.com → X-host check runs first → 'x'.
    expect(classifyReferrer('rss', 'x.com')).toBe('x')
  })
})

describe('parsePageviewBody (#842-B)', () => {
  const ids = new Set(['claude', 'openai'])
  it('accepts a valid body and classifies the source', () => {
    expect(parsePageviewBody({ svc: 'claude', utm: 'x', ref: '', active: true }, ids)).toEqual({
      svc: 'claude', source: 'x', active: true,
    })
  })
  it('rejects an unknown / missing service id (abuse guard)', () => {
    expect(parsePageviewBody({ svc: 'evil', utm: 'x' }, ids)).toBeNull()
    expect(parsePageviewBody({ utm: 'x' }, ids)).toBeNull()
    expect(parsePageviewBody(null, ids)).toBeNull()
    expect(parsePageviewBody('nope', ids)).toBeNull()
  })
  it('coerces active to a strict boolean and defaults false', () => {
    expect(parsePageviewBody({ svc: 'openai', active: 'yes' }, ids)?.active).toBe(false)
    expect(parsePageviewBody({ svc: 'openai' }, ids)?.active).toBe(false)
  })
  it('tolerates non-string utm/ref (→ direct) and does not throw on long input', () => {
    const r = parsePageviewBody({ svc: 'claude', utm: 123, ref: 'x'.repeat(500) }, ids)
    expect(r).toEqual({ svc: 'claude', source: 'direct', active: false })
  })
})

describe('parseOutageAudienceResponse (#842-B)', () => {
  it('splits counts by source and active/clear phase', () => {
    const json = { data: [
      { source: 'x', phase: 'active', views: '180' },
      { source: 'x', phase: 'clear', views: '20' },
      { source: 'search', phase: 'clear', views: 40 },
      { source: 'feed', phase: 'active', views: 15 },
      { source: 'owned', phase: 'active', views: 10 }, // #936 — extension/statusline bucket
    ] }
    const r = parseOutageAudienceResponse(json)!
    expect(r.total).toBe(265)
    expect(r.activeTotal).toBe(205)
    expect(r.bySource).toEqual({ x: 200, search: 40, feed: 15, owned: 10, direct: 0, plugin: 0 })
    expect(r.activeBySource).toEqual({ x: 180, search: 0, feed: 15, owned: 10, direct: 0, plugin: 0 })
  })
  it('skips unknown source buckets and tolerates bad views', () => {
    const r = parseOutageAudienceResponse({ data: [
      { source: 'bogus', phase: 'active', views: 999 },
      { source: 'direct', phase: 'active', views: 'NaN' },
      { source: 'direct', phase: 'active', views: 5 },
    ] })!
    expect(r.total).toBe(5)
    expect(r.bySource.direct).toBe(5)
  })
  it('returns a zeroed (NON-null) result for an empty data array → section omitted downstream', () => {
    // Load-bearing: formatAudienceLine omits on total<=0, so {data:[]} must yield total 0, not null.
    const r = parseOutageAudienceResponse({ data: [] })!
    expect(r).not.toBeNull()
    expect(r.total).toBe(0)
    expect(r.activeTotal).toBe(0)
  })
  it('returns null when there is no data array', () => {
    expect(parseOutageAudienceResponse({})).toBeNull()
    expect(parseOutageAudienceResponse(null)).toBeNull()
  })
})

describe('queryOutageAudience (#842-B)', () => {
  const okJson = { data: [{ source: 'x', phase: 'active', views: 7 }] }
  it('returns null without a fetch when creds are absent', async () => {
    const fetchImpl = vi.fn()
    expect(await queryOutageAudience(undefined, 'tok', fetchImpl as unknown as typeof fetch)).toBeNull()
    expect(await queryOutageAudience('acct', undefined, fetchImpl as unknown as typeof fetch)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('posts the SQL and parses a successful response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => okJson })
    const r = await queryOutageAudience('acct', 'tok', fetchImpl as unknown as typeof fetch)
    expect(r?.total).toBe(7)
    expect(r?.activeBySource.x).toBe(7)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('/accounts/acct/analytics_engine/sql')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' })
  })
  it('returns null on a non-OK HTTP status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) })
    expect(await queryOutageAudience('acct', 'tok', fetchImpl as unknown as typeof fetch)).toBeNull()
  })
  it('returns null (never throws) when fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'))
    expect(await queryOutageAudience('acct', 'tok', fetchImpl as unknown as typeof fetch)).toBeNull()
  })
})

describe('recordOutageView (#842-B)', () => {
  it('writes one data point with the source/phase/svc blob order the SQL reads', () => {
    const writeDataPoint = vi.fn()
    recordOutageView({ writeDataPoint } as unknown as AnalyticsEngineDataset, 'x', true, 'claude')
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['x', 'active', 'claude'],
      doubles: [1],
      indexes: ['isdown-view'],
    })
  })
  it('maps active=false → clear and no-ops when the binding is absent', () => {
    const writeDataPoint = vi.fn()
    recordOutageView({ writeDataPoint } as unknown as AnalyticsEngineDataset, 'search', false, 'openai')
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({ blobs: ['search', 'clear', 'openai'] }))
    expect(() => recordOutageView(undefined, 'x', true, 'claude')).not.toThrow()
  })
})

describe('buildOutageAudienceSql (#842-B)', () => {
  it('filters the isdown-view index, groups by source+window, sums sample_interval', () => {
    const sql = buildOutageAudienceSql('ds')
    expect(sql).toContain("index1 = 'isdown-view'")
    expect(sql).toContain('SUM(_sample_interval)')
    expect(sql).toContain('GROUP BY blob1, blob2')
    expect(sql).toContain('FROM ds')
  })
})

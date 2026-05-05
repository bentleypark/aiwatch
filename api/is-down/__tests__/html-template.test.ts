import { describe, it, expect } from 'vitest'
import { buildMetaDescription, renderIncidents, type ServiceData } from '../html-template'
import type { ServiceSEO } from '../seo-content'

function mkSeo(overrides: Partial<ServiceSEO> = {}): ServiceSEO {
  return {
    displayName: 'Claude',
    description: 'desc',
    insight: 'insight',
    whenDown: 'when down',
    faqs: [],
    ...overrides,
  }
}

type Inc = NonNullable<ServiceData['incidents']>[number]

function mkInc(overrides: Partial<Inc> = {}): Inc {
  return {
    id: overrides.id ?? 'x',
    title: overrides.title ?? 'Nomic Embed Text v1.5',
    status: overrides.status ?? 'resolved',
    impact: overrides.impact ?? null,
    startedAt: overrides.startedAt ?? '2026-04-20T10:00:00Z',
    duration: overrides.duration ?? null,
  }
}

function mkService(overrides: Partial<ServiceData> = {}): ServiceData {
  // Use spread so explicit `null` overrides are preserved (??-merging masks them).
  return {
    id: 'claude',
    name: 'Claude API',
    provider: 'Anthropic',
    category: 'api',
    status: 'operational',
    latency: null,
    uptime30d: 99.09,
    lastChecked: new Date().toISOString(),
    incidents: [],
    ...overrides,
  }
}

describe('buildMetaDescription', () => {
  it('operational + uptime + incidents: all clauses in canonical order', () => {
    const svc = mkService({
      status: 'operational',
      uptime30d: 99.09,
      incidents: Array.from({ length: 27 }, (_, i) =>
        mkInc({ id: `${i}`, startedAt: new Date(Date.now() - i * 86_400_000).toISOString() }),
      ),
    })
    const desc = buildMetaDescription(mkSeo(), svc, null)
    // Regression guard on the clause ordering surfaced in SERP snippet
    expect(desc).toMatch(/Check if Claude is down right now\. Current status: Operational\. 30-day uptime: 99\.09%\. 27 incidents tracked \(30d\)\. Updated every 5 minutes\./)
  })

  it('operational with zero 30-day incidents omits the incident clause', () => {
    const svc = mkService({ status: 'operational', uptime30d: 100, incidents: [] })
    const desc = buildMetaDescription(mkSeo(), svc, null)
    expect(desc).not.toContain('incidents tracked')
    expect(desc).toContain('30-day uptime: 100.00%')
  })

  it('omits 30-day uptime clause when uptime30d is null (estimate-less services)', () => {
    const svc = mkService({
      uptime30d: null,
      incidents: [mkInc(), mkInc({ id: '2' }), mkInc({ id: '3' })],
    })
    const desc = buildMetaDescription(mkSeo(), svc, null)
    expect(desc).not.toContain('30-day uptime')
    expect(desc).not.toContain('null')
    expect(desc).toContain('3 incidents tracked (30d)')
  })

  it('filters count to the last 30 days (boundary: 29d in, 31d out)', () => {
    const now = Date.now()
    const svc = mkService({
      incidents: [
        mkInc({ id: 'in', startedAt: new Date(now - 29 * 86_400_000).toISOString() }),
        mkInc({ id: 'out', startedAt: new Date(now - 31 * 86_400_000).toISOString() }),
      ],
    })
    const desc = buildMetaDescription(mkSeo(), svc, null)
    expect(desc).toContain('1 incidents tracked (30d)')
  })

  it('non-operational + aiInsight replaces the clause template with AI analysis copy', () => {
    const svc = mkService({ status: 'degraded' })
    const desc = buildMetaDescription(mkSeo(), svc, {
      summary: 'Elevated error rates on model inference',
      estimatedRecovery: '30m',
    })
    expect(desc).toContain('Claude is currently degraded')
    expect(desc).toContain('AI Analysis: Elevated error rates')
    expect(desc).not.toContain('incidents tracked')
  })

  it('no service (cache miss) falls through to the static fallback copy', () => {
    const desc = buildMetaDescription(mkSeo(), null, null)
    expect(desc).toBe('Check if Claude is down right now. Real-time status monitoring by AIWatch.')
  })
})

describe('renderIncidents — 30-day window + grouping', () => {
  it('returns empty string when service is null or incidents array is empty', () => {
    expect(renderIncidents(null)).toBe('')
    expect(renderIncidents(mkService({ incidents: [] }))).toBe('')
  })

  it('renders "No incidents in the last 30 days" when everything is outside the window', () => {
    const svc = mkService({
      incidents: [
        mkInc({ startedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }),
      ],
    })
    const html = renderIncidents(svc)
    expect(html).toContain('Last 30 days')
    expect(html).toContain('No incidents in the last 30 days')
  })

  it('30-day boundary: 29d included, 31d excluded', () => {
    const now = Date.now()
    const svc = mkService({
      incidents: [
        mkInc({ id: 'in-29d', title: 'Recent', startedAt: new Date(now - 29 * 86_400_000).toISOString() }),
        mkInc({ id: 'out-31d', title: 'Stale', startedAt: new Date(now - 31 * 86_400_000).toISOString() }),
      ],
    })
    const html = renderIncidents(svc)
    expect(html).toContain('Recent')
    expect(html).not.toContain('Stale')
  })

  it('emits <details open class="incident-group"> when 3+ same-day normalized-title entries exist', () => {
    const day = '2026-04-20T'
    const svc = mkService({
      incidents: [
        mkInc({ id: '1', title: 'Nomic Embed Text v1.5', startedAt: day + '10:00:00Z' }),
        mkInc({ id: '2', title: 'Nomic Embed Text v1.5', startedAt: day + '11:00:00Z' }),
        mkInc({ id: '3', title: 'Nomic Embed Text v1.5 — recovered', startedAt: day + '12:00:00Z' }),
      ],
    })
    const html = renderIncidents(svc)
    expect(html).toContain('<details open class="incident-group">')
    expect(html).toContain('Nomic Embed Text v1.5')
    expect(html).toMatch(/3×/)
  })

  it('groups when a same-day bucket has exactly 2 entries (≥2 threshold, lowered from ≥3 in #373)', () => {
    const day = '2026-04-20T'
    const svc = mkService({
      incidents: [
        mkInc({ id: '1', title: 'Nomic Embed', startedAt: day + '10:00:00Z' }),
        mkInc({ id: '2', title: 'Nomic Embed', startedAt: day + '11:00:00Z' }),
      ],
    })
    const html = renderIncidents(svc)
    expect(html).toContain('incident-group')
    expect(html).toMatch(/2×/)
  })

  it('caps rendered rows at INCIDENT_ROW_CAP = 20', () => {
    // 25 unique-title incidents (no grouping) within the window → at most 20 rendered rows
    const now = Date.now()
    const svc = mkService({
      incidents: Array.from({ length: 25 }, (_, i) => mkInc({
        id: `i${i}`,
        title: `Unique title ${i}`,
        startedAt: new Date(now - i * 3600_000).toISOString(),
      })),
    })
    const html = renderIncidents(svc)
    const rows = (html.match(/class="incident-item"/g) ?? []).length
    expect(rows).toBeLessThanOrEqual(20)
    expect(rows).toBeGreaterThan(15) // sanity: we should fill up near the cap
  })

  it('puts an investigating incident above newer resolved rows (#383 SSR regression)', () => {
    // Mirrors the ServiceDetails.jsx fix on the SSR side. groupIncidents alone
    // sorts purely by date — without compareGroupedRows the active incident's
    // title would render below newer resolved rows in the SERP-visible HTML.
    const svc = mkService({
      incidents: [
        mkInc({ id: 'r1',  title: 'Recent resolved A', status: 'resolved',      startedAt: '2026-05-05T00:29:00Z', duration: '1h 41m' }),
        mkInc({ id: 'r2',  title: 'Recent resolved B', status: 'resolved',      startedAt: '2026-05-01T12:55:00Z', duration: '8m' }),
        mkInc({ id: 'inv', title: 'Active partial outage', status: 'investigating', startedAt: '2026-04-30T06:59:00Z' }),
      ],
    })
    const html = renderIncidents(svc)
    const invIdx = html.indexOf('Active partial outage')
    const r1Idx = html.indexOf('Recent resolved A')
    const r2Idx = html.indexOf('Recent resolved B')
    expect(invIdx).toBeGreaterThan(-1)
    expect(invIdx).toBeLessThan(r1Idx)
    expect(invIdx).toBeLessThan(r2Idx)
  })

  it('puts a monitoring incident above newer resolved rows (#383 SSR regression — monitoring tier)', () => {
    const svc = mkService({
      incidents: [
        mkInc({ id: 'r1',  title: 'Recent resolved A', status: 'resolved',  startedAt: '2026-05-05T11:00:00Z', duration: '5m' }),
        mkInc({ id: 'mon', title: 'Active fix verifying', status: 'monitoring', startedAt: '2026-05-04T08:00:00Z' }),
      ],
    })
    const html = renderIncidents(svc)
    const monIdx = html.indexOf('Active fix verifying')
    const r1Idx = html.indexOf('Recent resolved A')
    expect(monIdx).toBeGreaterThan(-1)
    expect(monIdx).toBeLessThan(r1Idx)
  })

  it('row cap does not truncate an ongoing incident in favor of newer resolved rows (#383 SSR regression)', () => {
    // 25 newer resolved rows + 1 older investigating row. Without sort-before-cap
    // the investigating row would be discarded by .slice(0, 20).
    const now = Date.now()
    const svc = mkService({
      incidents: [
        ...Array.from({ length: 25 }, (_, i) => mkInc({
          id: `r${i}`,
          title: `Resolved title ${i}`,
          status: 'resolved' as const,
          startedAt: new Date(now - i * 3600_000).toISOString(),
          duration: '5m',
        })),
        mkInc({ id: 'inv', title: 'Active investigation', status: 'investigating', startedAt: new Date(now - 26 * 3600_000).toISOString() }),
      ],
    })
    const html = renderIncidents(svc)
    expect(html).toContain('Active investigation')
    // Strong guard: investigating must render BEFORE the newest resolved row,
    // not just survive the cap. A bug placing investigating at index 19 would
    // still leave it in the HTML but in the wrong position.
    const invIdx = html.indexOf('Active investigation')
    const newestResolvedIdx = html.indexOf('Resolved title 0')
    expect(invIdx).toBeGreaterThan(-1)
    expect(newestResolvedIdx).toBeGreaterThan(-1)
    expect(invIdx).toBeLessThan(newestResolvedIdx)
  })
})

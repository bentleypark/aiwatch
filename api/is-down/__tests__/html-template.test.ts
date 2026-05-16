import { describe, it, expect } from 'vitest'
import { buildMetaDescription, renderIncidents, renderFooter, type ServiceData } from '../html-template'
import type { ServiceSEO } from '../seo-content'
import { SLUG_TO_SERVICE, RELATED_SLUGS } from '../slug-map'

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

// ── renderFooter — "Also check" category grouping (#424) ─────────────
//
// The footer cross-links were previously a flat blob in SLUG_TO_SERVICE
// insertion order (SEO-rollout phase order — API / app / agent interleaved).
// renderFooter now groups the non-current, non-related links by category
// with API / AI Apps / Coding Agents sub-labels.

describe('renderFooter — Also check category grouping', () => {
  it('emits the three category sub-labels in API → AI Apps → Coding Agents order', () => {
    // Use a slug whose RELATED_SLUGS doesn't drain a whole category, so all
    // three groups are non-empty. `claude` (api) relates to claude-ai, claude-code,
    // openai, chatgpt — leaves api/app/agent all populated.
    const html = renderFooter('claude')
    const apiIdx = html.indexOf('<strong style="color:#8b949e">API:</strong>')
    const appIdx = html.indexOf('<strong style="color:#8b949e">AI Apps:</strong>')
    const agentIdx = html.indexOf('<strong style="color:#8b949e">Coding Agents:</strong>')
    expect(apiIdx, 'API sub-label present').toBeGreaterThan(-1)
    expect(appIdx, 'AI Apps sub-label present').toBeGreaterThan(-1)
    expect(agentIdx, 'Coding Agents sub-label present').toBeGreaterThan(-1)
    // Order: API before AI Apps before Coding Agents.
    expect(apiIdx).toBeLessThan(appIdx)
    expect(appIdx).toBeLessThan(agentIdx)
  })

  it('every non-current, non-related service appears exactly once under exactly one category', () => {
    // Completeness contract: the grouping must not drop any service. For a
    // given page, the footer should account for every SLUG_TO_SERVICE entry =
    // current + related + (sum of category groups).
    const slug = 'claude'
    const html = renderFooter(slug)
    const related = (RELATED_SLUGS[slug] ?? []).filter(s => SLUG_TO_SERVICE[s])
    const expectedInFooter = Object.keys(SLUG_TO_SERVICE).filter(
      s => s !== slug && !related.includes(s),
    )
    // Each expected service's is-down link must be present exactly once.
    for (const s of expectedInFooter) {
      const href = `/is-${s}-down`
      const occurrences = html.split(href).length - 1
      expect(occurrences, `${s} should appear exactly once in the footer "Also check" block`).toBe(1)
    }
    // No related service leaks into the "Also check" groups — related links
    // live on the separate "Related:" line. (They will still match `/is-X-down`
    // via the Related line, so scope the count to the "Also check:" paragraph.)
    const alsoCheckStart = html.indexOf('Also check:')
    const alsoCheckBlock = html.slice(alsoCheckStart)
    for (const r of related) {
      expect(alsoCheckBlock.includes(`/is-${r}-down`), `related service ${r} must NOT appear in "Also check"`).toBe(false)
    }
  })

  it('omits a category sub-label entirely when that category has no remaining services', () => {
    // `claude-code` (agent) relates to claude, cursor, github-copilot, windsurf,
    // codex, junie. Every other agent is either current or related → the
    // Coding Agents group is empty and must not render a stray "Coding Agents:"
    // label. API + AI Apps groups remain.
    const html = renderFooter('claude-code')
    expect(html).not.toContain('<strong style="color:#8b949e">Coding Agents:</strong>')
    expect(html).toContain('<strong style="color:#8b949e">API:</strong>')
    expect(html).toContain('<strong style="color:#8b949e">AI Apps:</strong>')
  })

  it('FOOTER_CATEGORY_ORDER covers every category present in SLUG_TO_SERVICE', () => {
    // Completeness guard. renderFooter buckets `remaining` into the three
    // categories API / AI Apps / Coding Agents. If a future service is added
    // with a 4th category value (the `category` field is typed `string`, not
    // a union, so this compiles silently), its is-down link would vanish from
    // the footer with no other test failure — the exact silent SEO-link-loss
    // this whole #424 change set out to prevent. Fail loudly here instead.
    const present = new Set(Object.values(SLUG_TO_SERVICE).map(e => e.category))
    expect([...present].sort()).toEqual(['agent', 'api', 'app'])
  })

  it('grouped links are category-pure — no cross-category leakage within a group', () => {
    // Pull the API group's text span and assert it contains only api-category
    // service links. A regression that mis-buckets (e.g. category typo) would
    // surface as an agent/app link inside the API <span>.
    // NOTE: the slice below assumes the group markup is a FLAT <span> with no
    // nested <span>. If a future refactor nests spans, update the bounds.
    const html = renderFooter('claude')
    // The API group is a <span> ... up to the next <span> or </p>.
    const apiSpanStart = html.indexOf('<strong style="color:#8b949e">API:</strong>')
    const afterApi = html.slice(apiSpanStart)
    const apiSpanEnd = afterApi.indexOf('</span>')
    const apiSpan = afterApi.slice(0, apiSpanEnd)
    // Every /is-X-down link inside the API span must map to an api-category slug.
    const linkSlugs = [...apiSpan.matchAll(/\/is-([a-z-]+)-down/g)].map(m => m[1])
    expect(linkSlugs.length).toBeGreaterThan(0)
    for (const s of linkSlugs) {
      expect(SLUG_TO_SERVICE[s]?.category, `${s} in API group must be api-category`).toBe('api')
    }
  })
})

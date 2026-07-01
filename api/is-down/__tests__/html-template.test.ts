import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildMetaDescription, renderIncidents, renderFooter, renderRegionRecommendation, renderComponents, renderShareButtons, renderBadgeEmbed, renderPage, linkifyFaqAnswer, FOOTER_CATEGORY_ORDER, type ServiceData } from '../html-template'
import type { ServiceSEO } from '../seo-content'
import { SLUG_TO_SERVICE, RELATED_SLUGS, outboundReferralUrl, SERVICE_SITE_URL } from '../slug-map'
import type { RegionStatusResult } from '../region-status'

// Incidents are filtered to a rolling 30-day window (the `Date.now() - 30 * 86_400_000`
// cutoff in buildMetaDescription / renderIncidents), so test fixtures MUST use relative
// dates — absolute literals silently age out of the window and fail later (#449).
// `daysAgo(n)` = ISO n days before now; `dayAgo(n)` = the 'YYYY-MM-DDT' date prefix
// n days ago, for building same-(UTC)-calendar-day groups.
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10) + 'T'

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
    startedAt: overrides.startedAt ?? daysAgo(5),
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

describe('outboundReferralUrl (#842)', () => {
  it('returns the curated provider URL with a disclosed ref param', () => {
    expect(outboundReferralUrl('gemini')).toBe('https://ai.google.dev?ref=ai-watch.dev')
    expect(outboundReferralUrl('claude')).toBe('https://claude.com?ref=ai-watch.dev')
  })
  it('returns null for a service with no curated URL (graceful)', () => {
    expect(outboundReferralUrl('bedrock')).toBeNull()
    expect(outboundReferralUrl('zzz')).toBeNull()
  })
  it('every curated URL is https', () => {
    for (const u of Object.values(SERVICE_SITE_URL)) expect(u.startsWith('https://')).toBe(true)
  })
})

describe('renderFallbacks — outbound referral wedge (#842)', () => {
  it('renders a prominent disclosed "Open" outbound button (new tab, rel=nofollow unpaid, GA event) per curated alternative', () => {
    const html = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [
      { id: 'gemini', name: 'Gemini API', score: 95, status: 'operational' },
    ])
    expect(html).toContain('class="fallback-try"')
    expect(html).toContain('href="https://ai.google.dev?ref=ai-watch.dev"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="nofollow noopener noreferrer"') // unpaid editorial — NO `sponsored`
    expect(html).not.toContain('sponsored')                      // must not contradict the "not paid" disclosure
    expect(html).toContain('data-ga="outbound_fallback_click"')
    expect(html).toContain('data-ga-to="gemini"')
    expect(html).toContain('ranked by AIWatch Score, not paid') // disclosure
  })
  it('omits the button (and disclosure) when no alternative has a curated URL', () => {
    const html = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [
      { id: 'bedrock', name: 'Amazon Bedrock', score: 90, status: 'operational' },
    ])
    expect(html).not.toContain('class="fallback-try"')
    expect(html).not.toContain('outbound_fallback_click')
    expect(html).not.toContain('ranked by AIWatch Score, not paid')
  })
  it('mixed list — exactly one outbound button for the curated alt, disclosure shown once', () => {
    const html = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [
      { id: 'gemini', name: 'Gemini API', score: 95, status: 'operational' },      // curated → button
      { id: 'bedrock', name: 'Amazon Bedrock', score: 90, status: 'operational' }, // no URL → no button
    ])
    expect((html.match(/class="fallback-try"/g) ?? []).length).toBe(1)
    expect((html.match(/data-ga="outbound_fallback_click"/g) ?? []).length).toBe(1)
    expect((html.match(/ranked by AIWatch Score, not paid/g) ?? []).length).toBe(1)
    expect(html).toContain('href="https://ai.google.dev?ref=ai-watch.dev"') // the one button is Gemini's
  })
})

describe('renderAIInsight — predicted vs actual (#827 F4)', () => {
  const resolvedInsight = {
    summary: 'Auth server overload caused login failures.',
    estimatedRecovery: '30m–1h', estimatedRecoveryHours: 1, affectedScope: ['Login'],
    analyzedAt: new Date(Date.now() - 30 * 60000).toISOString(),
    startedAt: new Date(Date.now() - 164 * 60000).toISOString(), // 2h44m before resolution
    resolvedAt: new Date().toISOString(),
  }
  it('shows "Predicted vs actual" on a resolved (operational) card, replacing the bare estimate', () => {
    const html = renderPage('claude', mkService({ status: 'operational' }), mkSeo(), [], resolvedInsight)
    expect(html).toContain('Predicted vs actual:')
    expect(html).toContain('2h 44m (over ~1h est.)') // actual exceeded the ~1h estimate
    expect(html).not.toContain('Est. Recovery:') // superseded by the comparison once resolved
  })
  it('falls back to "Est. Recovery" when not resolved, or when no numeric estimate / startedAt', () => {
    // active service → still the estimate
    const active = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [], { ...resolvedInsight, resolvedAt: undefined })
    expect(active).toContain('Est. Recovery:')
    expect(active).not.toContain('Predicted vs actual:')
    // resolved but missing the numeric estimate → estimate fallback
    const noHours = renderPage('claude', mkService({ status: 'operational' }), mkSeo(), [], { ...resolvedInsight, estimatedRecoveryHours: undefined })
    expect(noHours).toContain('Est. Recovery:')
    expect(noHours).not.toContain('Predicted vs actual:')
  })
})

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
    // #566: answer-first ("No — X is operational") so the SERP snippet leads with the answer;
    // clause ordering + the "Live status, updated every 5 minutes" freshness hint preserved.
    // #654 — the uptime clause dropped its "30-day" window qualifier (source windows vary) → "Uptime:".
    expect(desc).toMatch(/No — Claude is operational\. Uptime: 99\.09%\. 27 incidents tracked \(30d\)\. Live status, updated every 5 minutes\./)
  })

  it('operational with zero 30-day incidents omits the incident clause', () => {
    const svc = mkService({ status: 'operational', uptime30d: 100, incidents: [] })
    const desc = buildMetaDescription(mkSeo(), svc, null)
    expect(desc).not.toContain('incidents tracked')
    expect(desc).toContain('Uptime: 100.00%')
  })

  it('omits the uptime clause when uptime30d is null (estimate-less services)', () => {
    const svc = mkService({
      uptime30d: null,
      incidents: [mkInc(), mkInc({ id: '2' }), mkInc({ id: '3' })],
    })
    const desc = buildMetaDescription(mkSeo(), svc, null)
    expect(desc).not.toContain('Uptime:')
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

  it('non-operational + aiInsight leads with the answer, then AI analysis copy', () => {
    const svc = mkService({ status: 'degraded' })
    const desc = buildMetaDescription(mkSeo(), svc, {
      summary: 'Elevated error rates on model inference',
      estimatedRecovery: '30m',
    })
    // #566: answer-first, plain language ("Issues — …", not the dev-jargon "degraded").
    expect(desc).toContain('Issues — Claude is having problems right now')
    expect(desc).toContain('AI Analysis: Elevated error rates')
    expect(desc).not.toContain('incidents tracked')
  })

  it('no service (cache miss) falls through to the static fallback copy', () => {
    const desc = buildMetaDescription(mkSeo(), null, null)
    expect(desc).toBe('Check if Claude is down right now. Real-time status monitoring by AIWatch.')
  })

  // #566 — answer-first lead per status (the SERP-CTR change).
  it('leads with the direct answer per status (No / Yes / Issues)', () => {
    const op = buildMetaDescription(mkSeo(), mkService({ status: 'operational', uptime30d: 99.9 }), null)
    expect(op.startsWith('No — Claude is operational.')).toBe(true)

    const down = buildMetaDescription(mkSeo(), mkService({ status: 'down', uptime30d: 99.9 }), null)
    expect(down.startsWith('Yes — Claude is down right now.')).toBe(true)

    const degraded = buildMetaDescription(mkSeo(), mkService({ status: 'degraded', uptime30d: 99.9 }), null)
    expect(degraded.startsWith('Issues — Claude is having problems right now.')).toBe(true)
    // No dev jargon in the user-facing snippet.
    expect(degraded).not.toContain('degraded')
  })
})

describe('renderPage <title> — live status (#566)', () => {
  it('leads the title with the status label, before the brand', () => {
    const opTitle = renderPage('claude', mkService({ status: 'operational' }), mkSeo(), [])
    expect(opTitle).toContain('<title>Is Claude Down? Operational | AIWatch</title>')

    const downTitle = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [])
    expect(downTitle).toContain('<title>Is Claude Down? Down Right Now | AIWatch</title>')

    const degTitle = renderPage('claude', mkService({ status: 'degraded' }), mkSeo(), [])
    expect(degTitle).toContain('<title>Is Claude Down? Having Issues | AIWatch</title>')
  })

  it('falls back to "Live Status" when status data is unavailable', () => {
    const html = renderPage('claude', null, mkSeo(), [])
    expect(html).toContain('<title>Is Claude Down? Live Status | AIWatch</title>')
  })

  it('renders the on-page direct answer (feeds Google auto-snippet)', () => {
    const html = renderPage('claude', mkService({ status: 'operational' }), mkSeo(), [])
    expect(html).toContain('No &mdash; Claude is operational')
  })

  // #572: the header report link is the always-live /reports/ index (reports publish on a
  // lagging, variable cadence, so a date-derived per-month link 404s — see the issue).
  it('links the /reports/ index, not a hardcoded/derived month', () => {
    const html = renderPage('claude', mkService({ status: 'operational', rank: 5, totalRanked: 31 }), mkSeo(), [])
    expect(html).toContain('href="/reports/"')
    expect(html).toContain('Monthly Reports &rarr;')
    expect(html).not.toContain('/reports/2026-03/') // the old hardcoded link is gone
  })

  // #787 — DETERMINISTIC guard for the `${service.rankTied ? ' (tied)' : ''}` render branch. The old
  // e2e (`tests/is-down.spec.js`) asserted a LIVE score tie existed among 6 services, which false-failed
  // whenever scores drifted apart (it blocked unrelated PR #786's Edge E2E). The render path is pure, so
  // it belongs in a unit test driven by an explicit rankTied flag — no live data, no flake.
  it('renders "(tied)" iff rankTied is set', () => {
    const tied = renderPage('claude', mkService({ status: 'operational', rank: 5, totalRanked: 31, rankTied: true }), mkSeo(), [])
    expect(tied).toContain('is ranked <strong>#5 (tied)</strong>')

    const untied = renderPage('claude', mkService({ status: 'operational', rank: 5, totalRanked: 31, rankTied: false }), mkSeo(), [])
    expect(untied).toContain('is ranked <strong>#5</strong>')
    expect(untied).not.toContain('(tied)')
  })

  // #802 — a <30d-coverage service is excluded from the ranked SET (so other services' `of M`
  // denominator matches the dashboard), but is-down adds NO on-page note for it (the page is already
  // information-dense): its rank is simply absent. The exclusion itself lives in is-down.ts's filter.
  it('does NOT render a "recently added" note (no extra is-down clutter for a <30d service)', () => {
    const recent = renderPage('runway', mkService({ status: 'operational', scoreConfidence: 'high' }), mkSeo(), [])
    expect(recent).not.toContain('recently added')
    expect(recent).not.toContain('to go)')
  })
})

// #722/#744 — when a BetterStack service reads operational but `partialCount > 0` (sub-threshold
// component outage), the VISIBLE header reflects a yellow "Partial" state (dot + answer line) so it
// doesn't read flat-green "operational" while the badge/note say partial — but the SEO `<title>` +
// meta description STAY operational (the service IS up overall: no "Is X down? → No" SERP flip).
describe('renderPage — partial-outage header (#722/#744)', () => {
  it('reflects partial in the VISIBLE header (yellow dot + "Partial" answer) but keeps the SEO title operational', () => {
    const html = renderPage('together', mkService({ status: 'operational', partialCount: 1 }), mkSeo(), [])
    expect(html).toContain('&#x1F7E1; Is Claude Down?')            // VISIBLE: yellow dot in the H1
    expect(html).toContain('Partial &mdash; Claude has 1 component affected') // VISIBLE: partial answer line
    expect(html).not.toContain('No &mdash; Claude is operational') // the old flat-green verdict is gone
    expect(html).toContain('Operational | AIWatch')                // SEO title UNCHANGED (no SERP flip)
  })

  it('pluralizes for multiple affected components', () => {
    const html = renderPage('together', mkService({ status: 'operational', partialCount: 3 }), mkSeo(), [])
    expect(html).toContain('3 components affected')
  })

  it('omits the partial header + keeps the green dot when partialCount is 0 or absent', () => {
    const html = renderPage('together', mkService({ status: 'operational' }), mkSeo(), [])
    expect(html).not.toContain('component affected')
    expect(html).not.toContain('components affected')
    expect(html).toContain('&#x1F7E2; Is Claude Down?')            // green dot — fully operational
    expect(html).toContain('No &mdash; Claude is operational')
  })

  it('does not render the note for a degraded service (the badge already conveys it)', () => {
    const html = renderPage('together', mkService({ status: 'degraded', partialCount: 2 }), mkSeo(), [])
    expect(html).not.toContain('components affected')
  })
})

// #591 — a stale-source service (frozen feed; is-down.ts never sets a rank for it) must not surface
// its frozen uptime/score, and must show the honest "source moved/can't reach" note instead.
describe('renderPage — stale incident source (#591)', () => {
  const stale = () => mkService({
    status: 'operational',
    uptime30d: 99.92,            // frozen mirror value — must NOT appear
    aiwatchScore: 88,            // inflated by the empty window — must NOT appear
    scoreGrade: 'good',
    incidentSourceStale: true,
    // rank intentionally unset: is-down.ts excludes stale services from the ranked set
  })

  it('omits the frozen uptime and inflated score from the header meta', () => {
    const html = renderPage('deepseek', stale(), mkSeo(), [])
    expect(html).not.toContain('Uptime: 99.92%')
    expect(html).not.toContain('AIWatch Score: 88')
  })

  it('renders the honest stale-source note', () => {
    const html = renderPage('deepseek', stale(), mkSeo(), [])
    expect(html).toMatch(/status page moved to a source AIWatch can't reach/i)
  })

  it('omits the frozen uptime from the SERP meta description', () => {
    const desc = buildMetaDescription(mkSeo(), stale(), null)
    expect(desc).not.toContain('Uptime: 99.92%')
  })

  it('a NON-stale service still shows uptime + score (no over-suppression)', () => {
    const html = renderPage('deepseek', mkService({ status: 'operational', uptime30d: 99.92, aiwatchScore: 88, scoreGrade: 'good' }), mkSeo(), [])
    expect(html).toContain('Uptime: 99.92%')
    expect(html).toContain('AIWatch Score: 88')
    expect(html).not.toMatch(/can't reach/i)
  })
})

describe('renderIncidents — 7-day window + grouping', () => {
  it('returns empty string when service is null or incidents array is empty', () => {
    expect(renderIncidents(null)).toBe('')
    expect(renderIncidents(mkService({ incidents: [] }))).toBe('')
  })

  it('renders "No incidents in the last 7 days" when everything is outside the window', () => {
    const svc = mkService({
      incidents: [
        mkInc({ startedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }),
      ],
    })
    const html = renderIncidents(svc)
    expect(html).toContain('Last 7 days')
    expect(html).toContain('No incidents in the last 7 days')
  })

  it('#591 stale source: shows "history unavailable", NOT a false "No incidents" all-clear', () => {
    // frozen feed — incidents exist but are all old (can\'t fetch recent), so the 7-day window is empty
    const svc = mkService({
      incidentSourceStale: true,
      incidents: [mkInc({ startedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() })],
    })
    const html = renderIncidents(svc)
    expect(html).toContain('Incident history unavailable')
    expect(html).not.toContain('No incidents in the last 7 days')
  })

  it('#591 stale source with an EMPTY incident array still renders the unavailable message', () => {
    const html = renderIncidents(mkService({ incidentSourceStale: true, incidents: [] }))
    expect(html).toContain('Incident history unavailable')
  })

  it('7-day boundary: 6d included, 8d excluded', () => {
    const now = Date.now()
    const svc = mkService({
      incidents: [
        mkInc({ id: 'in-6d', title: 'Recent', startedAt: new Date(now - 6 * 86_400_000).toISOString() }),
        mkInc({ id: 'out-8d', title: 'Stale', startedAt: new Date(now - 8 * 86_400_000).toISOString() }),
      ],
    })
    const html = renderIncidents(svc)
    expect(html).toContain('Recent')
    expect(html).not.toContain('Stale')
  })

  it('emits <details open class="incident-group"> when 3+ same-day normalized-title entries exist', () => {
    const day = dayAgo(3)
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
    const day = dayAgo(3)
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
        mkInc({ id: 'r1',  title: 'Recent resolved A', status: 'resolved',      startedAt: daysAgo(2), duration: '1h 41m' }),
        mkInc({ id: 'r2',  title: 'Recent resolved B', status: 'resolved',      startedAt: daysAgo(3), duration: '8m' }),
        mkInc({ id: 'inv', title: 'Active partial outage', status: 'investigating', startedAt: daysAgo(4) }),
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
        mkInc({ id: 'r1',  title: 'Recent resolved A', status: 'resolved',  startedAt: daysAgo(2), duration: '5m' }),
        mkInc({ id: 'mon', title: 'Active fix verifying', status: 'monitoring', startedAt: daysAgo(3) }),
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

  it('shows the first 5 rows, collapses the rest behind a "Show N more" toggle (#incident-history-collapse)', () => {
    const now = Date.now()
    // 8 unique-title incidents within the 7-day window → no grouping → 8 single rows.
    const svc = mkService({
      incidents: Array.from({ length: 8 }, (_, i) => mkInc({
        id: `u${i}`,
        title: `Unique incident ${i}`,
        startedAt: new Date(now - i * 3600_000).toISOString(),
      })),
    })
    const html = renderIncidents(svc)
    // All 8 still in the HTML (collapsed content stays crawlable, no JS).
    expect((html.match(/class="incident-item"/g) ?? []).length).toBe(8)
    // The overflow (8 - 5 = 3) is wrapped in exactly one CSS-only reveal container.
    expect((html.match(/class="ih-rest"/g) ?? []).length).toBe(1)
    // Both label states are present; CSS swaps them on the checkbox :checked state.
    expect(html).toContain('Show 3 more')
    expect(html).toContain('Show less')
    // The overflow rows reveal between the preview and the toggle; the toggle label
    // is anchored at the BOTTOM (renders after the last overflow row).
    const restIdx = html.indexOf('class="ih-rest"')
    const fifthIdx = html.indexOf('Unique incident 4')   // 5th newest (index 4) — last preview row
    const sixthIdx = html.indexOf('Unique incident 5')   // 6th newest → inside .ih-rest
    const labelIdx = html.indexOf('ih-more-label')
    expect(fifthIdx).toBeLessThan(restIdx)
    expect(restIdx).toBeLessThan(sixthIdx)
    // Structural anchor (decoupled from title-order/sort internals): the toggle label
    // renders after the LAST incident row, so the overflow reveals above the toggle.
    expect(html.lastIndexOf('class="incident-item"')).toBeLessThan(labelIdx)
  })

  it('exactly 6 rows → "Show 1 more" (singular), 1 row collapsed', () => {
    const now = Date.now()
    const svc = mkService({
      incidents: Array.from({ length: 6 }, (_, i) => mkInc({
        id: `u${i}`,
        title: `Unique incident ${i}`,
        startedAt: new Date(now - i * 3600_000).toISOString(),
      })),
    })
    const html = renderIncidents(svc)
    expect((html.match(/class="incident-item"/g) ?? []).length).toBe(6)
    expect(html).toContain('Show 1 more')
    expect(html).toContain('Show less')
    // Only the 6th row (index 5) is inside the reveal container.
    const restIdx = html.indexOf('class="ih-rest"')
    expect(html.indexOf('Unique incident 4')).toBeLessThan(restIdx) // 5th → preview
    expect(restIdx).toBeLessThan(html.indexOf('Unique incident 5')) // 6th → collapsed
  })

  it('does NOT render the "show more" toggle at exactly 5 rows (boundary: > not >=)', () => {
    const now = Date.now()
    const svc = mkService({
      incidents: Array.from({ length: 5 }, (_, i) => mkInc({
        id: `u${i}`,
        title: `Unique incident ${i}`,
        startedAt: new Date(now - i * 3600_000).toISOString(),
      })),
    })
    const html = renderIncidents(svc)
    expect((html.match(/class="incident-item"/g) ?? []).length).toBe(5)
    expect(html).not.toContain('ih-rest')
    expect(html).not.toContain('ih-more-label')
    expect(html).not.toMatch(/Show \d+ more/)
  })
})

// ── renderFooter — "Also check" category grouping (#424) ─────────────
//
// The footer cross-links were previously a flat blob in SLUG_TO_SERVICE
// insertion order (SEO-rollout phase order — API / app / agent interleaved).
// renderFooter now groups the non-current, non-related links by category
// with API / AI Apps / Coding Agents sub-labels.

describe('renderFooter — Also check category grouping', () => {
  it('footer "Set up alerts" link deep-links with ?focus=alerts so it scrolls to the Alerts section (#566)', () => {
    // Regression: the footer link pointed at bare #settings (no scroll), diverging from the
    // CTA's #settings?focus=alerts (#546/#547). Both must carry focus=alerts.
    const html = renderFooter('claude')
    expect(html).toContain('href="https://ai-watch.dev/#settings?focus=alerts"')
    expect(html).toContain('>Set up alerts</a>')
    // No bare #settings link (without the focus param) may remain in the footer.
    expect(html).not.toMatch(/href="https:\/\/ai-watch\.dev\/#settings"/)
  })

  it('footer carries a GA-tracked methodology link to /methodology#score (#681)', () => {
    const html = renderFooter('claude')
    expect(html).toContain('href="https://ai-watch.dev/methodology#score"')
    expect(html).toContain('>How we measure this</a>')
    // #482 — GA4 fires from the delegated [data-ga] listener (no inline onclick)
    expect(html).toContain('data-ga="click_methodology" data-ga-loc="is_down_page" data-ga-source="footer"')
  })

  it('emits the group sub-labels in FOOTER_CATEGORY_ORDER order', () => {
    // Use a slug whose RELATED_SLUGS doesn't drain a whole group, so every group
    // is non-empty. `claude` (llm) relates to claude-ai, claude-code, openai,
    // chatgpt — leaves llm/apps/voice/inference/video/agents all populated (#658).
    const html = renderFooter('claude')
    const idxs = FOOTER_CATEGORY_ORDER.map(({ label }) => {
      const i = html.indexOf(`<strong style="color:#8b949e">${label}:</strong>`)
      expect(i, `${label} sub-label present`).toBeGreaterThan(-1)
      return i
    })
    // Labels must appear in declared FOOTER_CATEGORY_ORDER order.
    for (let k = 1; k < idxs.length; k++) {
      expect(idxs[k - 1], `${FOOTER_CATEGORY_ORDER[k - 1].label} before ${FOOTER_CATEGORY_ORDER[k].label}`).toBeLessThan(idxs[k])
    }
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
    // label. LLM APIs + AI Apps groups remain.
    const html = renderFooter('claude-code')
    expect(html).not.toContain('<strong style="color:#8b949e">Coding Agents:</strong>')
    expect(html).toContain('<strong style="color:#8b949e">LLM APIs:</strong>')
    expect(html).toContain('<strong style="color:#8b949e">AI Apps:</strong>')
  })

  it('FOOTER_CATEGORY_ORDER covers every category present in SLUG_TO_SERVICE', () => {
    // Completeness guard. renderFooter buckets `remaining` into the six
    // categories (apps/llm/voice/inference/video/agents — #658, mirroring the
    // dashboard SERVICE_CATEGORIES taxonomy). If a future service is added with
    // a category value not in FOOTER_CATEGORY_ORDER (the `category` field is
    // typed `string`, not a union, so this compiles silently), its is-down link
    // would vanish from the footer with no other test failure — the exact
    // silent SEO-link-loss this whole #424 change set out to prevent. Fail
    // loudly here instead.
    const present = new Set(Object.values(SLUG_TO_SERVICE).map(e => e.group))
    const ordered = new Set(FOOTER_CATEGORY_ORDER.map(g => g.key))
    for (const c of present) {
      expect(ordered.has(c), `group "${c}" present in SLUG_TO_SERVICE but missing from FOOTER_CATEGORY_ORDER`).toBe(true)
    }
    expect([...present].sort()).toEqual(['agents', 'apps', 'image', 'inference', 'llm', 'observability', 'video', 'voice'])
  })

  it('`category` stays the COARSE worker vocabulary (api/app/agent) — guards the is-down fallback filter', () => {
    // #658 — `category` and the fine `group` now sit side by side on every entry. `category` MUST
    // remain in the worker's 3-way vocabulary because api/is-down.ts filters fallback candidates with
    // `s.category === entry.category`, where `s.category` is the worker ServiceStatus value (api/app/
    // agent). If a contributor "aligns" category with the fine group (e.g. sets category:'voice'),
    // that equality matches NO operational candidate and the service's fallback list silently goes
    // empty — no runtime error, no other test failure. Pin the coarse vocabulary here so that
    // mistake fails loudly. (The fine taxonomy is asserted on `group` in the test above.)
    const cats = new Set(Object.values(SLUG_TO_SERVICE).map(e => e.category))
    expect([...cats].sort()).toEqual(['agent', 'api', 'app'])
  })

  it('grouped links are category-pure — no cross-category leakage within a group', () => {
    // Pull the LLM APIs group's text span and assert it contains only
    // llm-category service links. A regression that mis-buckets (e.g. category
    // typo) would surface as an agent/app link inside the LLM APIs <span>.
    // NOTE: the slice below assumes the group markup is a FLAT <span> with no
    // nested <span>. If a future refactor nests spans, update the bounds.
    const html = renderFooter('claude')
    // The LLM APIs group is a <span> ... up to the next <span> or </p>.
    const llmSpanStart = html.indexOf('<strong style="color:#8b949e">LLM APIs:</strong>')
    const afterLlm = html.slice(llmSpanStart)
    const llmSpanEnd = afterLlm.indexOf('</span>')
    const llmSpan = afterLlm.slice(0, llmSpanEnd)
    // Every /is-X-down link inside the LLM APIs span must map to an llm-group slug.
    const linkSlugs = [...llmSpan.matchAll(/\/is-([a-z-]+)-down/g)].map(m => m[1])
    expect(linkSlugs.length).toBeGreaterThan(0)
    for (const s of linkSlugs) {
      expect(SLUG_TO_SERVICE[s]?.group, `${s} in LLM APIs group must be llm-group`).toBe('llm')
    }
  })
})

// ── renderRegionRecommendation (refs #422 Phase 2) ───────────────────
//
// Contract: returns '' on all skip conditions; otherwise emits a self-contained
// callout block matching the AI Insight visual language. The function is the
// SSR equivalent of the Overview ActionBanner region line + ServiceDetails
// regional card recommendation — same three skip gates apply.

function mkRegionRec(overrides: Partial<RegionStatusResult> = {}): RegionStatusResult {
  const usEast = { key: 'AWS us-east-1', label: 'AWS US East', status: 'incident' as const, type: 'incident' as const }
  const usWest = { key: 'AWS us-west-2', label: 'AWS US West', status: 'ok' as const, type: 'incident' as const }
  const euWest = { key: 'AWS eu-west-1', label: 'AWS EU West', status: 'ok' as const, type: 'incident' as const }
  const regions = [usEast, usWest, euWest]
  return {
    regions,
    okRegions: [usWest, euWest],
    incidentRegions: [usEast],
    hasRegionSpecific: true,
    allDown: false,
    recommendedRegion: usWest,
    docsUrl: 'https://docs.pinecone.io/troubleshooting/available-cloud-regions',
    ongoingCount: 1,
    ...overrides,
  }
}

describe('renderRegionRecommendation', () => {
  it('returns empty string when rec is null (service has no region map)', () => {
    expect(renderRegionRecommendation(null, 'mistral')).toBe('')
  })

  it('returns empty string when hasRegionSpecific is false (global incident path)', () => {
    // Global-incident fallback marks every region as affected but with hasRegionSpecific=false.
    // Recommending a region in that state would be misleading — the renderer must skip.
    const rec = mkRegionRec({ hasRegionSpecific: false })
    expect(renderRegionRecommendation(rec, 'pinecone')).toBe('')
  })

  it('returns empty string when allDown (no OK region to recommend)', () => {
    const allDown = mkRegionRec({
      allDown: true,
      okRegions: [],
      recommendedRegion: null,
    })
    expect(renderRegionRecommendation(allDown, 'pinecone')).toBe('')
  })

  it('returns empty string when recommendedRegion is null even if other gates pass', () => {
    // Defensive: if a future refactor sets allDown=false but recommendedRegion=null
    // (would indicate a logic bug upstream), the renderer should still bail out.
    const odd = mkRegionRec({ recommendedRegion: null })
    expect(renderRegionRecommendation(odd, 'pinecone')).toBe('')
  })

  it('renders happy-path callout with affected + recommended labels', () => {
    const html = renderRegionRecommendation(mkRegionRec(), 'pinecone')
    expect(html).toContain('Try region:')
    expect(html).toContain('AWS US West')
    expect(html).toContain('AWS US East')
    // Single affected region — joined with ", " (only one entry here so we just see the label)
  })

  it('joins multiple incident regions with ", "', () => {
    const usEast = { key: 'AWS us-east-1', label: 'AWS US East', status: 'incident' as const, type: 'incident' as const }
    const usWest = { key: 'AWS us-west-2', label: 'AWS US West', status: 'incident' as const, type: 'incident' as const }
    const euWest = { key: 'AWS eu-west-1', label: 'AWS EU West', status: 'ok' as const, type: 'incident' as const }
    const rec = mkRegionRec({
      regions: [usEast, usWest, euWest],
      okRegions: [euWest],
      incidentRegions: [usEast, usWest],
      recommendedRegion: euWest,
    })
    const html = renderRegionRecommendation(rec, 'pinecone')
    expect(html).toContain('AWS US East, AWS US West')
    expect(html).toContain('AWS EU West')
  })

  it('renders docs link with target=_blank rel=noopener noreferrer when docsUrl present', () => {
    // Security contract — same as the ActionBanner pin (#422 Phase 1).
    // External link MUST carry rel=noopener noreferrer to prevent reverse-tabnabbing.
    const html = renderRegionRecommendation(mkRegionRec(), 'pinecone')
    expect(html).toMatch(/target="_blank"/)
    expect(html).toMatch(/rel="noopener noreferrer"/)
    expect(html).toContain('docs.pinecone.io')
  })

  it('omits docs anchor when docsUrl is undefined', () => {
    const rec = mkRegionRec({ docsUrl: undefined })
    const html = renderRegionRecommendation(rec, 'pinecone')
    expect(html).toContain('Try region:')
    expect(html).not.toMatch(/<a /)
  })

  it('fires region_switch_intent GA4 via the delegated [data-ga] listener (#482)', () => {
    // Pinned to keep the SSR-driven click attribution distinct from
    // ServiceDetails (service_details) and ActionBanner (action_banner).
    // #482: fires from the delegated [data-ga] listener (no inline onclick) — the region key
    // (a key with spaces, e.g. "AWS us-west-2") rides on data-ga-region with NO JS-string-in-
    // attribute escaping (the old escJsForAttr quote-escape footgun is gone).
    const html = renderRegionRecommendation(mkRegionRec(), 'pinecone')
    const container = document.createElement('div')
    container.innerHTML = html
    const anchor = container.querySelector('a[data-ga]')
    expect(anchor, 'expected an anchor with data-ga to be present').not.toBeNull()
    expect(anchor!.getAttribute('data-ga')).toBe('region_switch_intent')
    expect(anchor!.getAttribute('data-ga-svc')).toBe('pinecone')
    expect(anchor!.getAttribute('data-ga-region')).toBe('AWS us-west-2')
    expect(anchor!.getAttribute('data-ga-loc')).toBe('is_down_page')
    expect(anchor!.getAttribute('onclick')).toBeNull() // no inline handler
  })

  it('escapes label content (defensive vs upstream-injected labels)', () => {
    // Note: regression test for the share-button onclick attributes is in the
    // `renderShareButtons` describe block below, not here — same bug class, same
    // file, but two separate render call sites worth pinning independently so a
    // future refactor that splits or merges them doesn't quietly orphan the fix.
    // SERVICE_REGIONS labels are static + author-controlled today, but the
    // renderer pipes them through `esc()` anyway as a defense-in-depth
    // against a future "regions come from an upstream feed" change. Pin by
    // passing a label with HTML-special chars.
    const xssLabel = '<img src=x onerror="alert(1)">'
    const usWest = { key: 'safe', label: xssLabel, status: 'ok' as const, type: 'incident' as const }
    const usEast = { key: 'aff', label: 'Affected', status: 'incident' as const, type: 'incident' as const }
    const rec = mkRegionRec({
      regions: [usEast, usWest],
      okRegions: [usWest],
      incidentRegions: [usEast],
      recommendedRegion: usWest,
    })
    const html = renderRegionRecommendation(rec, 'pinecone')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })
})

// ── renderComponents (#604 per-component breakdown) ──────────────────
//
// Contract: returns '' when no curated components present; otherwise emits a
// self-contained card with one row per component (dot + name + status label),
// left-border colored by whether any component is non-operational. SSR mirror of
// the dashboard ServiceDetails ComponentBreakdown. esc() guards the page-supplied
// component name; statusColor/statusLabel are exhaustive over the normalized union.

describe('renderComponents (#604)', () => {
  it('returns empty string when service is null', () => {
    expect(renderComponents(null)).toBe('')
  })

  it('returns empty string when components is absent', () => {
    expect(renderComponents(mkService())).toBe('')
  })

  it('returns empty string when components is an empty array', () => {
    expect(renderComponents(mkService({ components: [] }))).toBe('')
  })

  it('renders one row per component; status label visible only for non-operational (#606)', () => {
    const html = renderComponents(mkService({
      components: [
        { id: 'a', name: 'IDE', status: 'operational' },
        { id: 'b', name: 'Cloud Agents', status: 'degraded' },
        { id: 'c', name: 'Automations', status: 'down' },
      ],
    }))
    expect(html).toContain('Component Status')
    expect(html).toContain('IDE')
    expect(html).toContain('Cloud Agents')
    expect(html).toContain('Automations')
    // degraded/down show a visible <span> status label
    expect(html).toContain('>Degraded Performance</span>')
    expect(html).toContain('>Down</span>')
    // operational shows NO visible status <span> — only the dot + the title attribute
    expect(html).not.toContain('>Operational</span>')
    expect(html).toContain('IDE — Operational') // a11y/hover title
  })

  it('uses the green accent border when all components are operational', () => {
    const html = renderComponents(mkService({
      components: [
        { id: 'a', name: 'IDE', status: 'operational' },
        { id: 'b', name: 'CLI', status: 'operational' },
      ],
    }))
    expect(html).toContain('border-left:3px solid #3fb950')
    expect(html).not.toContain('border-left:3px solid #e86235')
  })

  it('flips the accent border to amber when any component is non-operational', () => {
    const html = renderComponents(mkService({
      components: [
        { id: 'a', name: 'IDE', status: 'operational' },
        { id: 'b', name: 'CLI', status: 'down' },
      ],
    }))
    expect(html).toContain('border-left:3px solid #e86235')
  })

  it('escapes a component name containing HTML metacharacters (no injection)', () => {
    const html = renderComponents(mkService({
      components: [
        { id: 'a', name: '<img src=x onerror=alert(1)>', status: 'operational' },
        { id: 'b', name: 'CLI', status: 'operational' },
      ],
    }))
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  // #606 grouped collapse (per-model lists like cohere/groq)
  type C = NonNullable<ServiceData['components']>[number]
  const mkComponents = (n: number, downIdx: number[] = [], group?: string): C[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `m${i}`, name: `model-${i}`,
      status: (downIdx.includes(i) ? 'down' : 'operational') as 'operational' | 'down',
      ...(group ? { group } : {}),
    }))

  it('ungrouped (surface) components render as plain rows, no <details>', () => {
    const html = renderComponents(mkService({
      components: [
        { id: 'api', name: 'API', status: 'operational' },
        { id: 'con', name: 'Console', status: 'operational' },
      ],
    }))
    expect(html).not.toContain('<details')
    expect(html).toContain('API')
    expect(html).toContain('Console')
  })

  it('grouped components collapse under a <details> header with the count, members inside', () => {
    const html = renderComponents(mkService({
      components: [
        { id: 'api', name: 'API', status: 'operational' },          // surface → outside <details>
        ...mkComponents(18, [], 'Models'),                          // grouped
      ],
    }))
    expect(html).toContain('<details')
    expect(html).toContain('Models')
    expect(html).toContain('18 components')
    // surface row is outside the <details>; member rows are inside it
    const detailsIdx = html.indexOf('<details')
    expect(html.indexOf('API')).toBeLessThan(detailsIdx)
    expect(html.indexOf('model-17')).toBeGreaterThan(detailsIdx)
  })

  // #756 — the group toggle uses the comp-group chevron (native marker hidden), rendered next to
  // the count text rather than pushed to the far right edge (margin-left:auto was removed per UX
  // feedback). The chevron sits AFTER the count inside the summary.
  it('group summary uses the comp-group chevron placed after the count (not a far-right marker)', () => {
    const html = renderComponents(mkService({
      components: [
        { id: 'api', name: 'API', status: 'operational' },
        ...mkComponents(11, [], 'Models'),
      ],
    }))
    expect(html).toContain('class="comp-group"')
    const summary = html.slice(html.indexOf('<summary'), html.indexOf('</summary>') + 10)
    expect(summary).toContain('comp-group-chev')
    // chevron comes AFTER the "11 components" count within the summary (next to text, not floated)
    expect(summary.indexOf('11 components')).toBeLessThan(summary.indexOf('comp-group-chev'))
    // the far-right float was removed
    expect(html).not.toContain('.comp-group-chev{margin-left:auto')
  })

  it('group header dot/label reflects the worst member status', () => {
    const html = renderComponents(mkService({ components: mkComponents(18, [5], 'Models') }))
    // one member down → amber card accent + a "Down" status label in the group summary
    expect(html).toContain('border-left:3px solid #e86235')
    const summaryEnd = html.indexOf('</summary>')
    expect(html.slice(0, summaryEnd)).toContain('Down')
  })

  it('group worst-of: down beats degraded for the header dot color + label', () => {
    const members: C[] = [
      { id: 'a', name: 'm-a', status: 'operational', group: 'Models' },
      { id: 'b', name: 'm-b', status: 'degraded', group: 'Models' },
      { id: 'c', name: 'm-c', status: 'down', group: 'Models' },
    ]
    const html = renderComponents(mkService({ components: members }))
    const summary = html.slice(0, html.indexOf('</summary>'))
    // worst-of is `down` → red dot (#f85149) + "Down" label, NOT degraded's amber/label
    expect(summary).toContain('background:#f85149')
    expect(summary).toContain('Down')
    expect(summary).not.toContain('Degraded Performance')
  })
})

// ── renderShareButtons share GA4 (#482 — delegated [data-ga], no inline onclick) ──
//
// The old escJsForAttr quote-escape contract (Phase-2 review rounds 3-4) is retired: the share
// buttons' GA4 `share` event no longer lives in an `onclick="...gtag(...JSON.stringify...)"`
// attribute (which truncated on the inner `"`). It fires from the delegated [data-ga] listener,
// with the display name carried plain on data-ga-item — so there's no JS-string-in-attribute to
// escape, and the whole class of quote-truncation bug is structurally gone.
describe('renderShareButtons share GA4 (#482 — data-ga, no inline onclick)', () => {
  const seo = mkSeo({ displayName: 'Claude API' })
  const service = mkService({ status: 'down' })
  const canonical = 'https://ai-watch.dev/is-claude-down'
  const ogImage = 'https://aiwatch-worker.p2c2kbf.workers.dev/api/og?v=1'

  it('share-x / share-threads carry the GA4 event on data-* attrs, with a plain item_id, no onclick', () => {
    const html = renderShareButtons(seo, service, canonical, ogImage)
    const container = document.createElement('div')
    container.innerHTML = html
    for (const [cls, method] of [['a.share-x', 'x'], ['a.share-threads', 'threads']] as const) {
      const a = container.querySelector(cls)
      expect(a, `${cls} missing`).not.toBeNull()
      expect(a!.getAttribute('data-ga')).toBe('share')
      expect(a!.getAttribute('data-ga-method')).toBe(method)
      // the display name (with its space) rides plain on data-ga-item — no &quot; escaping needed
      expect(a!.getAttribute('data-ga-item')).toBe('Claude API')
      expect(a!.getAttribute('onclick')).toBeNull()
    }
    // the old entity-escaped wire format is gone
    expect(html).not.toContain('item_id:&quot;')
  })
})

// Copy-link share text must carry "AIWatch" on EVERY status — the outage templates dropped it, so a
// share posted during an incident lost the attribution (and the branding e2e went red whenever a real
// incident was live). Deterministic here (no incident-state dependency).
describe('renderShareButtons — copy text keeps AIWatch branding across statuses', () => {
  const seo = mkSeo({ displayName: 'Claude API' })
  const canonical = 'https://ai-watch.dev/is-claude-down'
  const ogImage = 'https://aiwatch-worker.p2c2kbf.workers.dev/api/og?v=1'
  const copyDataText = (status: string): string => {
    const html = renderShareButtons(seo, mkService({ status }), canonical, ogImage)
    const container = document.createElement('div')
    container.innerHTML = html
    return container.querySelector('button.share-copy')!.getAttribute('data-text') ?? ''
  }
  for (const status of ['down', 'degraded', 'operational']) {
    it(`copy data-text contains "AIWatch" when ${status}`, () => {
      expect(copyDataText(status)).toContain('AIWatch')
    })
  }
})

describe('RSS feed surfacing on /is-*-down (#430)', () => {
  it('emits a per-service RSS autodiscovery <link> in <head>', () => {
    const html = renderPage('claude', mkService(), mkSeo({ displayName: 'Claude' }), [])
    expect(html).toContain(
      '<link rel="alternate" type="application/rss+xml" title="Claude incidents — AIWatch" href="https://ai-watch.dev/feed/claude">',
    )
  })

  it('uses the page slug, not the service ID, for the feed URL', () => {
    const html = renderPage('claude-code', mkService({ id: 'claudecode' }), mkSeo({ displayName: 'Claude Code' }), [])
    expect(html).toContain('href="https://ai-watch.dev/feed/claude-code"')
    expect(html).toContain('data-rss="https://ai-watch.dev/feed/claude-code"')
    expect(html).not.toContain('feed/claudecode')
  })

  it('emits /feed/{slug} for every is-down page slug (matches the worker feed-slug map)', () => {
    // The worker /feed/:slug resolves via feedSlug(id) === slug, pinned by
    // feed-slug-sync.test.ts. This guards the template's side: every is-down
    // page must emit /feed/{its own slug} so the autodiscovery link + Copy
    // button never point at a 404-ing feed.
    const seo = mkSeo()
    for (const slug of Object.keys(SLUG_TO_SERVICE)) {
      const html = renderPage(slug, mkService(), seo, [])
      expect(html, `autodiscovery <link> for ${slug}`).toContain(
        `type="application/rss+xml" title="${seo.displayName} incidents — AIWatch" href="https://ai-watch.dev/feed/${slug}">`,
      )
      expect(html, `RSS copy button for ${slug}`).toContain(
        `data-rss="https://ai-watch.dev/feed/${slug}"`,
      )
    }
  })

  it('renders the PRIMARY Slack-feed button (#696 — zero-config action is primary)', () => {
    const html = renderPage('claude', mkService(), mkSeo(), [])
    // #696: Slack /feed (paste a command into any channel) is the lowest-friction ACTION for the
    // dev/team audience, so it owns btn-primary. Lock the exact primary markup + label.
    expect(html).toContain(
      '<button type="button" class="btn btn-primary" data-slack="/feed subscribe https://ai-watch.dev/feed/claude" data-svc="claude" data-action="copy-slack">💬 Get alerts in Slack</button>',
    )
    expect(html).toContain('function copySlackFeed(b)')
    expect(html).toContain("gtag('event','copy_slack_feed',{location:'is_down_page',service_id:b.dataset.svc})")
    // prompt() fallback for insecure-context / writeText-rejection paths
    expect(html).toContain("prompt('Copy Slack command:',c)")
  })

  it('renders the SECONDARY RSS button + the action-explicit helper line (#696)', () => {
    const html = renderPage('claude', mkService(), mkSeo(), [])
    // RSS is demoted to a secondary (.btn, not .btn-primary) and relabeled away from jargon —
    // "Copy alert link (RSS)" + a helper line spelling out where to paste it (the #696 fix for the
    // 9-sessions→0-conversions leak: "Notify me via RSS" copied a URL panic visitors couldn't use).
    expect(html).toContain(
      '<button type="button" class="btn" data-rss="https://ai-watch.dev/feed/claude" data-svc="claude" data-action="copy-rss">🔗 Copy alert link (RSS)</button>',
    )
    expect(html).toContain('function copyRss(b)')
    expect(html).toContain('navigator.clipboard.writeText(u)')
    expect(html).toContain("prompt('Copy RSS URL:',u)")
    // helper line makes each action's destination explicit
    expect(html).toMatch(/<p class="cta-help">.*Slack.*paste the command.*RSS.*paste the link/)
  })

  it('demotes the Discord double-opt-in to a de-emphasized secondary text link (#547/#696)', () => {
    const html = renderPage('claude', mkService(), mkSeo(), [])
    // The heavy Discord per-user push keeps the #546 deep-link (scrolls to the Alerts section)
    // but is no longer a btn-primary; it is a .cta-alt text link tagged status_banner_secondary
    // so the funnel comparison can tell post-reorder clicks from the old primary placement.
    expect(html).toContain('<p class="cta-alt"><a href="https://ai-watch.dev/#settings?focus=alerts"')
    expect(html).toContain('data-ga="click_cta_alerts" data-ga-loc="is_down_page" data-ga-source="status_banner_secondary"')
    // No "email" channel exists yet — the link must not advertise one.
    expect(html).toContain('Prefer Discord push alerts?')
    expect(html).not.toContain('email push')
    // The Discord path must NOT be a btn-primary anchor (the Slack button owns btn-primary, #696).
    expect(html).not.toMatch(/<a[^>]*class="btn btn-primary"/)
  })

  it('keys data-svc on the service ID, not the page slug, so copy_rss matches other per-service events', () => {
    const html = renderPage('claude-code', mkService({ id: 'claudecode' }), mkSeo({ displayName: 'Claude Code' }), [])
    expect(html).toContain('data-svc="claudecode"')
    expect(html).not.toContain('data-svc="claude-code"')
  })

  it('emits the copy_rss gtag call inside the post-copy done() handler', () => {
    const html = renderPage('claude', mkService(), mkSeo(), [])
    expect(html).toContain(
      "gtag('event','copy_rss',{location:'is_down_page',service_id:b.dataset.svc})",
    )
  })
})

// ── Recurrence guard (#443 / #449) ───────────────────────────────────
//
// buildMetaDescription + renderIncidents filter incidents on a
// Date.now()-anchored rolling 30-day window. A hard-coded calendar-date
// literal in any fixture here silently ages out of that window and the
// test starts failing on a future date with no code change — exactly the
// #443 breakage. Every fixture MUST derive its dates from daysAgo(n) /
// dayAgo(n) instead. This meta-test reads its own source and fails if a
// YYYY-MM-DD literal reappears, so the brittle pattern is caught the
// moment it's reintroduced rather than weeks later when the calendar
// happens to roll past the window edge.
describe('date-literal guard (#443)', () => {
  it('contains no hard-coded calendar-date literals — fixtures use relative daysAgo()/dayAgo() only', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    // Matches an ISO-ish YYYY-MM-DD literal (year 19xx/20xx). No trailing
    // boundary: fixture dates are usually followed by `T` (e.g. ...-20T10:00),
    // and a `\b` there would never match. The pattern text itself is
    // digit-class-based, so it never matches its own source line.
    // Scope: this only catches the ISO-dashed form — the sole literal shape
    // used by every fixture in this file (and the one #443 actually broke on).
    // Exotic brittle forms (numeric `new Date(y, m, d)`, epoch-ms literals) are
    // not detected, but they don't occur here and aren't the realistic regression.
    const hits = source.match(/\b(?:19|20)\d\d-\d\d-\d\d/g) ?? []
    expect(
      hits,
      'Hard-coded date literal(s) found — replace with daysAgo(n)/dayAgo(n) so fixtures stay inside the rolling 30-day window (see #443).',
    ).toEqual([])
  })
})

describe('linkifyFaqAnswer (#654 — on-page FAQ URL linking)', () => {
  it('links curated status / dashboard URLs (bare domain → https:// anchor)', () => {
    const out = linkifyFaqAnswer('Check status.openai.com or the AIWatch dashboard at ai-watch.dev.')
    expect(out).toContain('<a href="https://status.openai.com" target="_blank" rel="noopener noreferrer">status.openai.com</a>')
    expect(out).toContain('<a href="https://ai-watch.dev" target="_blank" rel="noopener noreferrer">ai-watch.dev</a>')
  })

  it('links a path/anchor URL (ai-watch.dev/#ranking) and aistudio status', () => {
    expect(linkifyFaqAnswer('compare at ai-watch.dev/#ranking now')).toContain('href="https://ai-watch.dev/#ranking"')
    expect(linkifyFaqAnswer('Google AI Studio status at aistudio.google.com/status here')).toContain('href="https://aistudio.google.com/status"')
  })

  it('does NOT linkify bare brand domains in prose (claude.ai / character.ai)', () => {
    const out = linkifyFaqAnswer('claude.ai depends on Claude API. Check ai-watch.dev for details.')
    expect(out).not.toContain('href="https://claude.ai"')
    expect(out).toContain('claude.ai depends')           // brand stays plain text
    expect(out).toContain('href="https://ai-watch.dev"') // real URL still linked
  })

  it('does not swallow a sentence-ending period into the link', () => {
    const out = linkifyFaqAnswer('See ai-watch.dev.')
    expect(out).toContain('>ai-watch.dev</a>.')          // period stays outside the anchor
  })

  it('escapes non-URL text (no HTML injection)', () => {
    expect(linkifyFaqAnswer('a <script>x</script> b')).toContain('&lt;script&gt;')
  })

  it('links the <provider>status.com shape (groqstatus.com / replicatestatus.com) + multi-dot status hosts', () => {
    expect(linkifyFaqAnswer('check groqstatus.com now')).toContain('href="https://groqstatus.com"')
    expect(linkifyFaqAnswer('check replicatestatus.com now')).toContain('href="https://replicatestatus.com"')
    expect(linkifyFaqAnswer('LangSmith status at status.smith.langchain.com here')).toContain('href="https://status.smith.langchain.com"')
  })

  it('does not double-scheme a domain already prefixed with https:// (no stray https:// before the anchor)', () => {
    const out = linkifyFaqAnswer('see https://status.openai.com here')
    expect(out).not.toContain('https://<a')          // no broken stray scheme
    expect(out).not.toContain('href="https://https://')
  })
})

// #575 — crowd "Report an issue" modal (collect) + GATED recent-reports display.
describe('renderPage — Report an issue modal (#575)', () => {
  it('renders the modal trigger + category/description form on an operational page, honest copy, no public count', () => {
    const html = renderPage('claude', mkService({ status: 'operational' }), mkSeo(), [])
    // Trigger button + modal scaffold present (operational too — the "looks down but we show
    // operational" corroboration case is exactly when a report is most valuable).
    expect(html).toContain('id="report-open"')
    expect(html).toContain('id="report-modal"')
    // Richer input: category dropdown + 80-char description (claudestatus.com parity).
    expect(html).toContain('<option value="outage">Outage</option>')
    expect(html).toContain('<option value="degraded">Degraded performance</option>')
    expect(html).toContain('id="report-desc"')
    expect(html).toContain('maxlength="80"')
    expect(html).toContain('<button type="button" class="btn btn-primary" id="report-submit" data-svc="claude"')
    // POSTs to the worker collect endpoint.
    expect(html).toContain('/api/report-issue')
    // Honest feedback, never a public "N people reporting" verdict.
    expect(html).toContain('we factor this into our monitoring')
    expect(html).not.toMatch(/\d+\s+(people|users)\s+(are\s+)?reporting/i)
  })

  it('renders the modal on a down page too', () => {
    const html = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [])
    expect(html).toContain('id="report-open"')
    expect(html).toContain('data-svc="claude"')
  })

  it('does NOT render the gated "Recent user reports" section when no reports are passed', () => {
    const html = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [], null, null, [])
    expect(html).not.toContain('Recent user reports')
  })

  it('renders the gated reports section when reports are passed, escaping the description (UGC XSS guard)', () => {
    const reports = [
      { cat: 'outage', desc: '500 errors <script>alert(1)</script>', ts: Date.now() - 3 * 60_000 },
      { cat: 'errors', desc: '', ts: Date.now() - 30 * 60_000 },
    ]
    const html = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [], null, null, reports)
    expect(html).toContain('Recent user reports')
    expect(html).toContain('Outage')
    expect(html).toContain('Errors')
    // Description is HTML-escaped — no live script tag in the output.
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    // Explicitly framed as community-submitted, not an AIWatch verdict.
    expect(html).toContain('not an official AIWatch verdict')
  })

  it('collapses report rows past the first 5 behind a "Show N more" toggle', () => {
    const now = Date.now()
    const reports = Array.from({ length: 8 }, (_, i) => ({ cat: 'errors', desc: `report ${i}`, ts: now - i * 60_000 }))
    const html = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [], null, null, reports)
    // All 8 rows present in the HTML (collapsed ones stay crawlable).
    expect((html.match(/report \d/g) ?? []).length).toBe(8)
    // 8 - 5 = 3 collapsed behind the toggle.
    expect(html).toContain('class="rep-rest"')
    expect(html).toContain('Show 3 more')
    expect(html).toContain('Show less')
    // The optimistic-prepend container is present.
    expect(html).toContain('id="report-feed-list"')
  })

  it('does NOT render the report toggle at 5 or fewer reports', () => {
    const now = Date.now()
    const reports = Array.from({ length: 5 }, (_, i) => ({ cat: 'outage', desc: `r${i}`, ts: now - i * 60_000 }))
    const html = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [], null, null, reports)
    // Assert on markup (not the always-present CSS rule .rep-rest{...}).
    expect(html).not.toContain('class="rep-rest"')
    expect(html).not.toContain('id="rep-more"')
    expect(html).not.toMatch(/Show \d+ more/)
  })
})

// OG card status pinned to the social share hint (?e=) so a tweet's card matches the post moment.
describe('renderPage — OG status pinned to share hint (?e=)', () => {
  const ogStatus = (html: string): string | null => {
    const m = html.match(/\/api\/og\?[^"']*status=([a-z]+)/)
    return m ? m[1] : null
  }
  it('pins the og:image status to the hint, overriding live status', () => {
    const op = mkService({ status: 'operational' })
    expect(ogStatus(renderPage('claude', op, mkSeo(), [], null, null, [], 'down'))).toBe('down')
    expect(ogStatus(renderPage('claude', op, mkSeo(), [], null, null, [], 'degraded'))).toBe('degraded')
    // recovery/active hints → an operational card (the generator has no separate "recovered" style)
    expect(ogStatus(renderPage('claude', op, mkSeo(), [], null, null, [], 'resolved'))).toBe('operational')
    expect(ogStatus(renderPage('claude', mkService({ status: 'down' }), mkSeo(), [], null, null, [], 'active'))).toBe('operational')
  })
  it('falls through to live status when the hint is absent or non-status (reddit)', () => {
    const down = mkService({ status: 'down' })
    expect(ogStatus(renderPage('claude', down, mkSeo(), [], null, null, []))).toBe('down')            // no hint → live
    expect(ogStatus(renderPage('claude', down, mkSeo(), [], null, null, [], 'reddit'))).toBe('down')  // reddit → live
    expect(ogStatus(renderPage('claude', down, mkSeo(), [], null, null, [], 'bogus'))).toBe('down')   // unknown → live
  })
})

// og:url + og:title also pin to the hint so the card IDENTITY is distinct per share moment (platforms
// cache by og:url, not the fetched URL) and the headline matches the pinned image. canonical stays
// clean for SEO. (#740 follow-up — a query-less og:url collapsed every share onto one cached card.)
describe('renderPage — og:url + og:title pinned to share hint (?e=)', () => {
  const ogUrl = (html: string): string | null => {
    const m = html.match(/<meta property="og:url" content="([^"]*)"/)
    return m ? m[1] : null
  }
  const ogTitle = (html: string): string | null => {
    const m = html.match(/<meta property="og:title" content="([^"]*)"/)
    return m ? m[1] : null
  }
  const twitterTitle = (html: string): string | null => {
    const m = html.match(/<meta name="twitter:title" content="([^"]*)"/)
    return m ? m[1] : null
  }
  const canonicalHref = (html: string): string | null => {
    const m = html.match(/<link rel="canonical" href="([^"]*)"/)
    return m ? m[1] : null
  }
  const op = mkService({ status: 'operational' })

  it('appends ?e=<hint> to og:url so each share moment is a distinct card identity', () => {
    expect(ogUrl(renderPage('claude', op, mkSeo(), [], null, null, [], 'down'))).toBe('https://ai-watch.dev/is-claude-down?e=down')
    expect(ogUrl(renderPage('claude', op, mkSeo(), [], null, null, [], 'degraded'))).toBe('https://ai-watch.dev/is-claude-down?e=degraded')
    expect(ogUrl(renderPage('claude', op, mkSeo(), [], null, null, [], 'resolved'))).toBe('https://ai-watch.dev/is-claude-down?e=resolved')
  })

  it('keeps og:url clean (no ?e=) when the hint is absent or non-status', () => {
    expect(ogUrl(renderPage('claude', op, mkSeo(), [], null, null, []))).toBe('https://ai-watch.dev/is-claude-down')
    expect(ogUrl(renderPage('claude', op, mkSeo(), [], null, null, [], 'reddit'))).toBe('https://ai-watch.dev/is-claude-down')
    expect(ogUrl(renderPage('claude', op, mkSeo(), [], null, null, [], 'bogus'))).toBe('https://ai-watch.dev/is-claude-down')
  })

  it('pins og:title to the hint status, overriding live (card headline matches the pinned image)', () => {
    expect(ogTitle(renderPage('claude', op, mkSeo(), [], null, null, [], 'down'))).toContain('Down Right Now')
    expect(ogTitle(renderPage('claude', op, mkSeo(), [], null, null, [], 'degraded'))).toContain('Having Issues')
    // no hint → live status
    expect(ogTitle(renderPage('claude', op, mkSeo(), [], null, null, []))).toContain('Operational')
    expect(ogTitle(renderPage('claude', mkService({ status: 'down' }), mkSeo(), [], null, null, []))).toContain('Down Right Now')
  })

  it('twitter:title carries the same pinned status as og:title (parity)', () => {
    const html = renderPage('claude', op, mkSeo(), [], null, null, [], 'down')
    expect(twitterTitle(html)).toBe(ogTitle(html))
    expect(twitterTitle(html)).toContain('Down Right Now')
  })

  it('keeps <link rel="canonical"> clean even when the hint pins the social card (SEO unaffected)', () => {
    expect(canonicalHref(renderPage('claude', op, mkSeo(), [], null, null, [], 'down'))).toBe('https://ai-watch.dev/is-claude-down')
  })
})

// #804 — a per-incident token (`&i=`) on og:url so a NEW outage is a distinct social-card identity
// from the PRIOR `?e=down` share (platforms cache the card by og:url for ~7d, so a byte-identical
// og:url across outages reused the stale card). Token rides og:url only; canonical/<title> stay clean.
describe('renderPage — og:url per-incident token (#804)', () => {
  // og:url is HTML-attribute-escaped (multi-param `&` → `&amp;`, which is correct HTML the platform
  // unescapes); decode it back so assertions read as the semantic URL the platform actually keys on.
  const ogUrl = (html: string): string | null => {
    const m = html.match(/<meta property="og:url" content="([^"]*)"/)
    return m ? m[1].replace(/&amp;/g, '&') : null
  }
  const canonicalHref = (html: string): string | null => {
    const m = html.match(/<link rel="canonical" href="([^"]*)"/)
    return m ? m[1] : null
  }
  // positional args: …reports, ogStatusHint(8th), supplyChainNote(9th), ogIncidentToken(10th)
  const page = (hint: string | null, token: string | null) =>
    renderPage('claude', mkService({ status: 'operational' }), mkSeo(), [], null, null, [], hint, null, token)

  it('appends &i=<token> to og:url alongside the status hint (distinct card per outage)', () => {
    expect(ogUrl(page('down', 'incA'))).toBe('https://ai-watch.dev/is-claude-down?e=down&i=incA')
  })

  it('makes og:url differ across incident tokens — the cross-outage cache-collision fix', () => {
    expect(ogUrl(page('down', 'incA'))).not.toBe(ogUrl(page('down', 'incB')))
  })

  it('includes the token even without a status hint (still a distinct card)', () => {
    expect(ogUrl(page(null, 'incA'))).toBe('https://ai-watch.dev/is-claude-down?i=incA')
  })

  it('omits &i= when no token is passed (unchanged #740 behavior)', () => {
    expect(ogUrl(page('down', null))).toBe('https://ai-watch.dev/is-claude-down?e=down')
    expect(ogUrl(page(null, null))).toBe('https://ai-watch.dev/is-claude-down')
  })

  it('keeps canonical clean — the token rides og:url only, never the SEO canonical', () => {
    expect(canonicalHref(page('down', 'incA'))).toBe('https://ai-watch.dev/is-claude-down')
  })
})

// #574 — supply-chain note: shown when api/is-down.ts passes a supplyChainNote for THIS service
// (it's in the worker banner's affectedNow/mayBeAffected). SEO header/verdict unchanged.
describe('renderPage — supply-chain note (#574)', () => {
  const args = (note: { regions: string; confirmed: boolean } | null) =>
    renderPage('claude', mkService({ status: 'degraded' }), mkSeo(), [], null, null, [], null, note)

  it('confirmed (AWS-attributed) service → "attributes it to an AWS/upstream issue" note with the region', () => {
    const html = args({ regions: 'us-east-1', confirmed: true })
    expect(html).toContain('AWS infrastructure issue (us-east-1)')
    expect(html).toContain('attributes it to an AWS/upstream issue')
  })

  it('estimated (AWS-dependent, not yet degraded) → "runs on AWS and may be affected"', () => {
    const html = args({ regions: 'us-east-1, eu-west-1', confirmed: false })
    expect(html).toContain('AWS infrastructure issue (us-east-1, eu-west-1)')
    expect(html).toContain('runs on AWS and may be affected')
  })

  it('no note → nothing rendered', () => {
    expect(args(null)).not.toContain('AWS infrastructure issue')
  })
})

describe('renderBadgeEmbed (#805 Problem B — discoverability)', () => {
  it('renders the embed markdown linking to the crawlable is-down page (not a hash route)', () => {
    const html = renderBadgeEmbed('claude', mkSeo())
    expect(html).toContain('](https://ai-watch.dev/is-claude-down)')
    expect(html).not.toContain('ai-watch.dev/#claude')
    expect(html).toContain('/badge/claude)') // worker badge image, serviceId == slug here
  })

  it('uses the worker service id (not the slug) for the badge image when they differ', () => {
    // slug "claude-ai" → worker id "claudeai"; the page link keeps the slug, the badge uses the id
    const html = renderBadgeEmbed('claude-ai', mkSeo({ displayName: 'claude.ai' }))
    expect(html).toContain('/badge/claudeai)')
    expect(html).toContain('](https://ai-watch.dev/is-claude-ai-down)')
  })

  it('is wired into the full page after the share buttons', () => {
    const html = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [])
    expect(html).toContain('Embed this status badge')
    expect(html).toContain('](https://ai-watch.dev/is-claude-down)')
  })

  it('does NOT reuse the share-copy class (keeps button.share-copy unique for the e2e selector)', () => {
    // Regression: the badge Copy button originally shared class="share-copy" with the share-bar
    // Copy-Link button → Playwright strict-mode `button.share-copy` matched 2 elements and failed.
    expect(renderBadgeEmbed('claude', mkSeo())).not.toContain('share-copy')
    const page = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [])
    expect(page.match(/class="[^"]*\bshare-copy\b[^"]*"/g) ?? []).toHaveLength(1)
  })
})

// #482 — CSP Phase 2 (option C: HASH-based, so /is-down keeps its edge cache). The page must carry
// NO inline event handlers (all wired via the delegated dispatcher), and every executable inline
// <script> the page renders must be covered by the hash-CSP the handler emits.
describe('renderPage — CSP-clean + hash-covered (#482)', () => {
  const INLINE_HANDLER = /\son(click|change|input|submit|mouseover|mouseout|mousedown|mouseup|keydown|keyup|focus|blur)\s*=/i

  it('has ZERO inline event-handler attributes on a down page (the busiest, most-interactive state)', () => {
    const html = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [
      { id: 'openai', name: 'OpenAI API', score: 90, status: 'operational' },
    ])
    expect(INLINE_HANDLER.test(html)).toBe(false)
  })

  it('renders the delegated dispatcher with both the [data-ga] and [data-action] paths', () => {
    const html = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [])
    expect(html).toMatch(/closest\('\[data-ga\]'\)[\s\S]*gtag\('event'/)
    expect(html).toMatch(/closest\('\[data-action\]'\)/)
    for (const a of ['copy-rss', 'copy-slack', 'copy-link', 'copy-badge', 'share-kakao', 'select']) {
      expect(html, `dispatcher should handle data-action=${a}`).toContain(`case '${a}'`)
    }
  })

  it('the hash-CSP covers EVERY executable inline script the page renders', async () => {
    const { cspForHtml, extractInlineScripts, sha256Base64 } = await import('../../_shared/csp-hash')
    const html = renderPage('claude', mkService({ status: 'down' }), mkSeo(), [
      { id: 'openai', name: 'OpenAI API', score: 90, status: 'operational' },
    ])
    const { value } = await cspForHtml(html)
    const scripts = extractInlineScripts(html)
    expect(scripts.length).toBeGreaterThanOrEqual(3) // consent init + share + kakao + dispatcher (+ CTA)
    for (const body of scripts) {
      expect(value, 'every inline script must be hashed into the CSP').toContain(`'sha256-${await sha256Base64(body)}'`)
    }
    // script-src is hash-locked (no 'unsafe-inline'); style-src keeps it (inline style="" is fine)
    const scriptSrc = value.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))!
    expect(scriptSrc).not.toContain("'unsafe-inline'")
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildMetaDescription, renderIncidents, renderFooter, renderRegionRecommendation, renderShareButtons, renderPage, type ServiceData } from '../html-template'
import type { ServiceSEO } from '../seo-content'
import { SLUG_TO_SERVICE, RELATED_SLUGS } from '../slug-map'
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

  it('fires region_switch_intent GA4 event with location=is_down_page', () => {
    // Pinned to keep the SSR-driven click attribution distinct from
    // ServiceDetails (service_details) and ActionBanner (action_banner).
    // Without this, GA funnel data can't tell which surface drove the click.
    const html = renderRegionRecommendation(mkRegionRec(), 'pinecone')
    expect(html).toContain("gtag('event','region_switch_intent'")
    expect(html).toContain("location:'is_down_page'")
    expect(html).toContain("service_id:'pinecone'")
    // The recommended region key is JSON-encoded so a key with spaces (e.g.
    // "AWS us-west-2") stays valid JS literal — assert that encoding holds.
    // Quote-escape contract: inner `"` from JSON.stringify must be HTML-encoded
    // as `&quot;` so the outer `onclick="..."` attribute doesn't truncate.
    // See the regression test below ("onclick attribute parses as a single
    // intact JS expression") for the DOM-level integrity check.
    expect(html).toContain('recommended_region:&quot;AWS us-west-2&quot;')
  })

  it('onclick attribute parses as a single intact JS expression (regression: quote-escape contract)', () => {
    // Regression pin for the Phase-2 review-round-3 Critical finding: the GA4
    // onclick body contains `recommended_region:"AWS us-west-2"` which, if
    // left as raw `"`, would prematurely close the outer `onclick="..."`
    // attribute. HTML parser truncates at the first inner `"`, the rest of
    // the JS body is interpreted as bogus HTML attributes, and the GA4
    // event silently never fires. We escape inner `"` to `&quot;`.
    //
    // Reparse the rendered HTML through the test environment's DOM and pull
    // the onclick attribute back out to verify it's whole. If a future
    // contributor swaps the escape strategy (single-quoting, delegated
    // listeners, etc.) we want this test to catch any regression that
    // re-breaks the attribute boundary.
    const html = renderRegionRecommendation(mkRegionRec(), 'pinecone')
    const container = document.createElement('div')
    container.innerHTML = html
    const anchor = container.querySelector('a[onclick]')
    expect(anchor, 'expected an anchor with onclick to be present').not.toBeNull()
    const onclick = anchor!.getAttribute('onclick') ?? ''
    // The full JS body must end with `})` — the closing of gtag(...) call.
    // If the attribute was truncated, the value would end at `recommended_region:`
    // and the trailing characters would have become separate attributes.
    expect(onclick).toMatch(/\}\)$/)
    // The recommended_region value is present, contains a space (Pinecone-shaped
    // key), and the JSON.stringify quotes are entity-decoded back to literal `"`
    // by the HTML parser when we read getAttribute (verified below).
    expect(onclick).toContain('recommended_region:"AWS us-west-2"')
    expect(onclick).toContain("location:'is_down_page'")
    expect(onclick).toContain("service_id:'pinecone'")
    // No stray HTML attributes leaked from a truncated onclick — the fix
    // ensures the value is whole, so anchor has exactly the expected attrs.
    const attrNames = anchor!.getAttributeNames().sort()
    expect(attrNames).toEqual(['href', 'onclick', 'rel', 'style', 'target'])
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

// ── renderShareButtons (quote-escape contract — same class as #422 region rec) ──
//
// Phase 2 review round 4 audit caught a pre-existing instance of the same
// quote-truncation bug in the share buttons: `item_id:${jsDisplayName}` from
// JSON.stringify embeds a raw `"` into the double-quoted `onclick="..."`
// attribute. HTML parser truncates → `gtag('event','share',...)` never fires
// → bogus stray attributes leak. The fix (escJsForAttr helper) applies the same
// shape across both call sites; this regression test mirrors the region-rec
// pin so a future split/merge of the helper can't silently revert one side.

describe('renderShareButtons onclick attributes (quote-escape contract)', () => {
  // Minimal SEO fixture — only the display name + faqs are read by the
  // share-button code path. The display name carries an embedded space so the
  // JSON.stringify output has the inner `"` that the bug truncates on.
  const seo = mkSeo({ displayName: 'Claude API' })
  const service = mkService({ status: 'down' })
  const canonical = 'https://ai-watch.dev/is-claude-down'
  const ogImage = 'https://aiwatch-worker.p2c2kbf.workers.dev/api/og?v=1'

  it('share-x onclick attribute parses as a single intact JS expression', () => {
    const html = renderShareButtons(seo, service, canonical, ogImage)
    const container = document.createElement('div')
    container.innerHTML = html
    const anchor = container.querySelector('a.share-x')
    expect(anchor, 'share-x anchor missing').not.toBeNull()
    const onclick = anchor!.getAttribute('onclick') ?? ''
    // Whole gtag call survives.
    expect(onclick).toMatch(/\}\)$/)
    // Entity-decoded inner double quotes around the displayName.
    expect(onclick).toContain('item_id:"Claude API"')
    // No truncation residue — anchor has exactly the documented attrs.
    expect(anchor!.getAttributeNames().sort()).toEqual(['class', 'href', 'onclick', 'rel', 'target'])
  })

  it('share-threads onclick attribute parses as a single intact JS expression', () => {
    const html = renderShareButtons(seo, service, canonical, ogImage)
    const container = document.createElement('div')
    container.innerHTML = html
    const anchor = container.querySelector('a.share-threads')
    expect(anchor, 'share-threads anchor missing').not.toBeNull()
    const onclick = anchor!.getAttribute('onclick') ?? ''
    expect(onclick).toMatch(/\}\)$/)
    expect(onclick).toContain('item_id:"Claude API"')
    expect(anchor!.getAttributeNames().sort()).toEqual(['class', 'href', 'onclick', 'rel', 'target'])
  })

  it('share-x and share-threads onclick wire-format uses the entity-escaped form', () => {
    // Raw HTML inspection — a future refactor that drops escJsForAttr but uses
    // a different fix (delegated listeners, single-quoted attrs) must update
    // this assertion deliberately. Pins the wire format alongside the DOM
    // parse to give both layers their own regression signal.
    const html = renderShareButtons(seo, service, canonical, ogImage)
    // Single quotes inside an HTML attribute value don't need entity-encoding
    // (the attribute is double-quoted, so `'` is just a literal). Only the
    // double quotes from JSON.stringify need the `&quot;` treatment.
    expect(html).toContain(`method:'x',content_type:'is_x_down',item_id:&quot;Claude API&quot;`)
    expect(html).toContain(`method:'threads',content_type:'is_x_down',item_id:&quot;Claude API&quot;`)
  })
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
      expect(html, `Copy RSS URL button for ${slug}`).toContain(
        `data-rss="https://ai-watch.dev/feed/${slug}"`,
      )
    }
  })

  it('renders a secondary "Copy RSS URL" button that copies the feed URL to the clipboard', () => {
    const html = renderPage('claude', mkService(), mkSeo(), [])
    expect(html).toContain(
      '<button type="button" class="btn" data-rss="https://ai-watch.dev/feed/claude" data-svc="claude" onclick="copyRss(this)">Copy RSS URL</button>',
    )
    expect(html).toContain('function copyRss(b)')
    expect(html).toContain('navigator.clipboard.writeText(u)')
    // prompt() fallback for insecure-context / writeText-rejection paths
    expect(html).toContain("prompt('Copy RSS URL:',u)")
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

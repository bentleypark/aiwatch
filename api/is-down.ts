// Vercel Edge Function — "Is X Down?" SSR pages

import { SLUG_TO_SERVICE } from './_is-down/slug-map'
import { getSEOContent } from './_is-down/seo-content'
import { renderPage } from './_is-down/html-template'
import type { EstimateAccuracy, RecoveryBaseline } from '../worker/src/recovery-baseline-text'
import { EXCLUDE_FALLBACK } from '../worker/src/fallback'
import { cspForHtml } from './_shared/csp-hash'
import { notifyEdgeFallback } from './_shared/edge-fallback-alert'
import { hedgedJsonFetch } from './_shared/hedged-fetch'
import { lastGoodView } from './_shared/last-good-copy'
import { isDownCacheControl } from './_shared/is-down-cache'
import { resolveWorkerApi } from './_shared/worker-api'
import { regionStatusOf, type RegionStatusResult } from './_is-down/region-status'
import { buildSupplyChainNote, type SupplyChainBannerLike, type SupplyChainNote } from './_is-down/supply-chain-note'
import { buildUpstreamNote, type UpstreamLinkLike, type UpstreamNote } from './_is-down/upstream-note'

export const config = { runtime: 'edge' }

const WORKER_API = 'https://aiwatch-worker.p2c2kbf.workers.dev'

const workerApi = resolveWorkerApi(WORKER_API)

// #378: notify the Worker when this Edge Function falls back to a degraded render so an operator
// Discord alert fires. Worker handles 5-min KV dedup, so fan-out across concurrent requests
// collapses to a single notice per surface per slug per 5min. Awaited with a tight timeout so the
// user-facing fallback response isn't blocked when the Worker is the very thing that's unhealthy.
//
// #1368 — the body moved to `_shared/edge-fallback-alert.ts`; that module carries the history and
// the reasons. `WORKER_API` stays declared here and is passed in.

// Per-isolate dedup for repeated ops signals — re-fires on cold start / per isolate in
// the fleet, which gives operators enough visibility on deploy without log-volume
// scaling with request rate.
const warnedMissingSlugs = new Set<string>()        // SLUG_TO_SERVICE id not present in API response

export default async function handler(req: Request) {
  try {
    const url = new URL(req.url)
    const slug = url.searchParams.get('slug') ?? ''
    // Social share status hint (`?e=`, #539): pins the OG card status to the share moment so a
    // tweet's unfurled card matches the post (not the live status, which may have drifted by then).
    const ogStatusHint = url.searchParams.get('e')
    // #804 — per-incident token (`&i=`, appended by buildTweetDrafts/buildReplyDraft). Included in
    // og:url ONLY so a NEW outage is a distinct social card from the prior `?e=down` share (platforms
    // cache the card by og:url for ~7d). It only namespaces a cache key, so sanitize defensively:
    // restrict to id-safe chars + cap length (the real ids are short alphanumeric statuspage ids).
    // NOTE colon-bearing ids (e.g. Gemini's `aistudio:`/`vertex:`-prefixed incident ids, reachable via
    // the reply draft) are intentionally COLLAPSED here (`:` stripped) — the strip is deterministic, so
    // the token stays stable across re-shares of the same incident and unique-enough across incidents.
    const rawIncidentToken = url.searchParams.get('i')
    const ogIncidentToken = rawIncidentToken
      ? rawIncidentToken.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || null
      : null

    const entry = SLUG_TO_SERVICE[slug]
    if (!entry) {
      return new Response('Not Found', { status: 404 })
    }

    const seo = getSEOContent(slug)
    if (!seo) {
      return new Response('Not Found', { status: 404 })
    }

    // Single API call to the KV-backed /api/status/cached (fast SSR). The cron refreshes that cache
    // on every status-change edge (#488), so an incident is visible here within one cron cycle —
    // without paying the live all-service fan-out of /api/status on this high-traffic SEO surface.
    let serviceData = null
    let fallbacks: Array<{ id: string; name: string; score: number | null; status: string }> = []
    // #1062 facet B — set when the outage ROUTES to a capability tier (OpenAI 'Images' down → image tier),
    // so the Alternatives block heading names the affected capability ("… for image generation").
    let fallbackCapabilityLabel: string | undefined
    // #1753 — a listed service's substitutes, one entry per use (the card's subheadings).
    let fallbackGroups: Array<{ use: string; items: typeof fallbacks }> | undefined
    let viewMissing = false
    let aiInsight: { summary: string; progress?: string; estimatedRecovery: string; affectedScope: string[]; analyzedAt: string; needsFallback?: boolean; resolvedAt?: string; estimatedRecoveryHours?: number; firstEstimatedRecoveryHours?: number; startedAt?: string } | null = null
    // #926 — the worker returns ONE analysis per active incident (aiAnalysis: Record<svcId, AIAnalysisResult[]>).
    // Keep the FULL array for the visible AI Analysis card (parity with the dashboard AnalysisModal, which
    // renders every incident); `aiInsight` above stays the primary [0] used by the meta/share/OG surfaces,
    // which can only carry a single summary.
    let aiInsights: Array<{ summary: string; progress?: string; estimatedRecovery: string; affectedScope: string[]; analyzedAt: string; needsFallback?: boolean; resolvedAt?: string; estimatedRecoveryHours?: number; firstEstimatedRecoveryHours?: number; startedAt?: string; incidentTitle?: string }> = []
    // #574 — supply-chain note for THIS service (set if it's in the banner's affectedNow/mayBeAffected).
    let supplyChainNote: SupplyChainNote | null = null
    let upstreamNote: UpstreamNote | null = null
    let recoveryBaseline: RecoveryBaseline | null = null
    let estimateAccuracy: EstimateAccuracy | null = null
    // Track the precise reason for the fallback render so the Discord alert can
    // distinguish operational classes (timeout vs HTTP failure vs missing service
    // vs JSON parse error). Defaults to a generic label that should never ship —
    // overwritten below before use.
    let fallbackReason: string = 'unknown'

    const statusUrl = `${workerApi}/api/status/cached?series=0&view=is-down&id=${encodeURIComponent(entry.id)}`
    const statusFetch = await hedgedJsonFetch(statusUrl, { lastGood: lastGoodView<unknown>(statusUrl) })
    if (statusFetch.ok && statusFetch.attempt === 2) console.warn(`[is-down/${slug}] status fetch answered by the hedged second request`)
    const copyReason = statusFetch.ok && statusFetch.attempt === 'copy' ? statusFetch.reason : null
    if (copyReason) console.warn(`[is-down/${slug}] status fetch failed (${copyReason}); served the last-good copy`)

    if (statusFetch.ok) {
      try {
        const data = statusFetch.data as {
          services: Array<{
            id: string; name: string; category: string; status: string
            latency: number | null; uptime30d: number | null; uptimeSource?: string
            lastChecked: string; incidents: unknown[]; aiwatchScore?: number | null
            scoreGrade?: string | null; scoreConfidence?: string; incidentSourceStale?: boolean
            partialCount?: number // #722 — BetterStack sub-threshold affected-resource count
            // #1004 — source liveness. The template renders an honest "Unknown" instead of a Yes/No
            // answer when AIWatch could not READ the provider's page (a `degraded` from the 3-strike
            // fetch-failure fallback is a statement about our fetch, not about the service).
            sourceDead?: boolean; sourceUnknown?: boolean
            probeConfirmed?: boolean; probeContradicted?: boolean
            components?: Array<{ id: string; name: string; status: 'operational' | 'degraded' | 'down'; group?: string }>
            componentGroupsInline?: boolean // array-order (groups interleaved) breakdown layout
            fallbackSuppressed?: boolean // #880 — the outage is outside the service's fallback scope
          }>
          // #926 — the worker returns an ARRAY per service (one entry per active incident). The prior
          // non-array annotation was wrong (a runtime array was silently collapsed to [0]); the Array.isArray
          // guard below still tolerates a stray single object defensively.
          aiAnalysis?: Record<string, Array<{ summary: string; progress?: string; estimatedRecovery: string; affectedScope: string[]; needsFallback?: boolean; analyzedAt: string; incidentId: string; resolvedAt?: string; estimatedRecoveryHours?: number; firstEstimatedRecoveryHours?: number }>>
          // #574 — supply-chain banner: when this service is in affectedNow/mayBeAffected, render a note.
          // Shape declared once, next to the logic that reads it — two copies of one wire contract drift.
          supplyChainBanner?: SupplyChainBannerLike
          // #1053 — cross-provider upstream links (a dependent's own incident blames a provider that is
          // itself down). Optional: a worker predating #1053 omits the key entirely (deploy skew).
          upstreamLinks?: UpstreamLinkLike[]
          recoveryBaseline?: Record<string, RecoveryBaseline>
          estimateAccuracy?: EstimateAccuracy
          fallbacks?: typeof fallbacks
          fallbackGroups?: typeof fallbackGroups
          fallbackCapabilityLabel?: string
        }
        // #1831 — the Worker view carries only the target, already ranked, plus its fallbacks.
        const target = (data.services ?? []).find(s => s.id === entry.id)
        if (target) {
          serviceData = target
        } else {
          // Distinct fallback reason — JSON was valid but the slug isn't in the
          // services array (config drift between SLUG_TO_SERVICE and the Worker's
          // SERVICES list). Different operational class than a parse failure.
          fallbackReason = 'service_missing'
          if (!warnedMissingSlugs.has(slug)) {
            warnedMissingSlugs.add(slug)
            console.error(`[is-down/${slug}] service id "${entry.id}" not in API response — SLUG_TO_SERVICE is out of sync with worker/src/services.ts`)
          }
        }
        viewMissing = !!target && data.fallbacks === undefined
        if (viewMissing) console.error(`[is-down/${slug}] status response has no fallbacks — the Worker did not serve ?view=is-down`)
        fallbacks = data.fallbacks ?? []
        fallbackGroups = data.fallbackGroups
        fallbackCapabilityLabel = data.fallbackCapabilityLabel

        // Extract AI analysis for this service. #926 — take the WHOLE array (one entry per active
        // incident), not just [0], so a multi-incident service renders every AI card (dashboard parity).
        const analyses = data.aiAnalysis?.[entry.id]
        const analysisList = Array.isArray(analyses) ? analyses : analyses ? [analyses] : []
        // Show AI insight if analysis exists (incident may be active even when status is operational)
        if (analysisList.length > 0) {
          // #827 F4 — attach each matching incident's startedAt so a RESOLVED card can show
          // "predicted vs actual" (actual = startedAt→resolvedAt); estimatedRecoveryHours rides on
          // the analysis. Incidents live on the fetched SERVICE (`target`), NOT the slug-config
          // `entry` (which has no `incidents`). `target` may be undefined on the `service_missing`
          // config-drift path (which doesn't return) while `aiAnalysis` still has an entry — optional-
          // chain so we never throw to the fallback render; absent → the card shows the bare estimate.
          const incidents = (target?.incidents as Array<{ id?: string; startedAt?: string; title?: string }> | undefined) ?? []
          aiInsights = analysisList
            .map(a => {
              const inc = incidents.find(i => i.id === a.incidentId)
              // #926 — carry the incident title too so a multi-incident card can label each sub-block
              // (the dashboard modal does the same, keyed on incidentId).
              return { ...a, ...(inc?.startedAt ? { startedAt: inc.startedAt } : {}), ...(inc?.title ? { incidentTitle: inc.title } : {}) }
            })
            // #926 — order newest-incident-first so the AI card lines up with the "Recent Incidents"
            // section on the same page. That section sorts status-tier-then-recency (active before
            // resolved), so this pure startedAt-desc order matches it in the dominant all-active case;
            // a mixed active+recently-resolved set can differ, which is acceptable. startedAt-less last.
            .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
          aiInsight = aiInsights[0] // primary (freshest incident) — meta/share/OG carry a single summary
        }

        // #574/#1000 — supply-chain note (region choice is load-bearing; see supply-chain-note.ts).
        supplyChainNote = buildSupplyChainNote(data.supplyChainBanner, entry.id)
        // #1053 — cross-provider upstream note (the dependent's OWN claim; see upstream-note.ts).
        upstreamNote = buildUpstreamNote(data.upstreamLinks, entry.id)
        recoveryBaseline = data.recoveryBaseline?.[entry.id] ?? null
        estimateAccuracy = data.estimateAccuracy ?? null
      } catch (parseErr) {
        fallbackReason = 'parse_error'
        console.error(`[is-down/${slug}] status payload unreadable:`, parseErr instanceof Error ? parseErr.message : parseErr)
      }
    } else {
      fallbackReason = statusFetch.reason
      console.error(`[is-down/${slug}] status fetch failed: ${statusFetch.reason}`)
    }

    // Region recommendation (refs #422 Phase 2). regionStatusOf returns null
    // when the service has no region map, no relevant incident, or every
    // region is hit — the template's renderRegionRecommendation treats null
    // as "skip the line entirely" so passing it directly is safe.
    let regionRec: RegionStatusResult | null = null
    if (serviceData) {
      try {
        regionRec = regionStatusOf(serviceData)
      } catch (regionErr) {
        // Region computation is best-effort — never block the page render.
        // Edge logs the error so a future drift between the Worker's incident
        // shape and our `IncidentLike` type is visible.
        console.warn(`[is-down/${slug}] regionStatusOf threw:`, regionErr instanceof Error ? regionErr.message : regionErr)
      }
    }

    // #641 — when a region switch is offered (the cheaper same-provider fix for a region-specific
    // outage), suppress the cross-service fallback so the page doesn't push a redundant full provider
    // switch alongside it. Condition mirrors renderRegionRecommendation + the ActionBanner.
    if (regionRec && regionRec.hasRegionSpecific && !regionRec.allDown && regionRec.recommendedRegion) {
      fallbacks = []
    }

    // #575 — GATED crowd-report display. Fetch recent user reports ONLY when an independent signal
    // already shows a problem (official degraded/down, OR a BetterStack sub-threshold `partial`).
    // When the official status is operational with no signal we skip the fetch entirely, so the
    // public report list can NEVER contradict an `operational` page (the load-bearing constraint).
    let reports: Array<{ cat: string; desc: string; ts: number }> = []
    // #1233 — an unreadable source (`unknown`) is NOT that independent signal; it is the absence of one,
    // so it must not open this gate. Matches `shouldSurfaceReports` in worker/src/report.ts, which makes
    // an `unknown` service earn its report display with a probe spike instead of waving it through for
    // merely being non-operational. Spelled out here rather than imported: worker/ and api/ are separate
    // deploy targets and this repo imports only api → worker (slug-map.ts), never the reverse — the same
    // call is-down-group.ts documents for RESOLVED_ANALYSIS_WINDOW_MS.
    const officialSignal = serviceData?.status === 'degraded' || serviceData?.status === 'down'
    if (serviceData && (officialSignal || (serviceData.partialCount ?? 0) > 0)) {
      try {
        const r = await fetch(`${WORKER_API}/api/report-feed?svc=${encodeURIComponent(entry.id)}`, { signal: AbortSignal.timeout(2000) })
        if (r.ok) reports = ((await r.json()) as { reports?: Array<{ cat: string; desc: string; ts: number }> }).reports ?? []
      } catch (err) {
        console.warn(`[is-down/${slug}] report-feed fetch failed:`, err instanceof Error ? err.message : err)
      }
    }

    const html = renderPage(slug, serviceData as Parameters<typeof renderPage>[1], seo, fallbacks, aiInsight, regionRec, reports, ogStatusHint, supplyChainNote, ogIncidentToken, aiInsights, upstreamNote, fallbackCapabilityLabel, recoveryBaseline, (serviceData === null || viewMissing) && !EXCLUDE_FALLBACK.includes(entry.id), fallbackGroups, estimateAccuracy)

    // #378: when the upstream Worker fetch failed and we're rendering the
    // "Status data is temporarily unavailable" fallback, the response must NOT
    // be cached the same way as a successful render. Otherwise a sub-minute
    // Worker blip poisons the Vercel CDN cache for ~6 minutes per region
    // (s-maxage=60 + stale-while-revalidate=300). Diverge both the status code
    // and the Cache-Control so a retry gets a fresh fetch, and notify the
    // Worker so the operator gets a Discord alert.
    const isFallback = serviceData === null
    if (isFallback) await notifyEdgeFallback(WORKER_API, { surface: 'is-down', slug, reason: fallbackReason }, `is-down/${slug}`)
    else if (copyReason) await notifyEdgeFallback(WORKER_API, { surface: 'is-down', slug, reason: `${copyReason}_served_copy` }, `is-down/${slug}`)
    // #482 — HASH-based CSP (not nonce): hash THIS response's inline scripts so the policy is
    // derived from the served content. Unlike a random nonce, a content hash stays valid when the
    // page is edge-cached (the cached header's hashes match the cached body), so /is-down keeps its
    // s-maxage=60 edge cache (it's the busiest, outage-viral SEO surface). ENFORCING (Phase 3); the
    // SPA's vercel.json Report-Only header co-applies but never blocks, so the hash policy enforces.
    const csp = await cspForHtml(html, { enforce: true })
    return new Response(html, {
      status: isFallback ? 503 : 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': isDownCacheControl(isFallback || copyReason !== null),
        [csp.key]: csp.value,
      },
    })
  } catch (err) {
    console.error('[is-down] Unhandled error:', err instanceof Error ? err.stack : err)
    return new Response(
      '<!DOCTYPE html><html><head><title>AIWatch - Temporarily Unavailable</title></head><body style="background:#080c10;color:#e6edf3;font-family:sans-serif;text-align:center;padding:60px"><h1>Something went wrong</h1><p>Please try again or visit <a href="https://ai-watch.dev" style="color:#58a6ff">AIWatch</a>.</p></body></html>',
      { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } },
    )
  }
}

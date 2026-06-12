// Vercel Edge Function — "Is X Down?" SSR pages

import { SLUG_TO_SERVICE } from './is-down/slug-map'
import { getSEOContent } from './is-down/seo-content'
import { renderPage } from './is-down/html-template'
import { regionStatusOf, type RegionStatusResult } from './is-down/region-status'

export const config = { runtime: 'edge' }

const WORKER_API = 'https://aiwatch-worker.p2c2kbf.workers.dev'
// Keep in sync with worker/src/fallback.ts and src/utils/constants.js
const EXCLUDE_FALLBACK = ['replicate', 'huggingface', 'pinecone', 'stability', 'voyageai', 'modal', 'langsmith', 'characterai', 'bedrock', 'azureopenai']

// #378: notify the Worker when this Edge Function falls back to a degraded
// render so an operator Discord alert fires. Worker handles 5-min KV dedup, so
// fan-out across concurrent requests collapses to a single notice per surface
// per slug per 5min. Awaited with a tight timeout so the user-facing fallback
// response isn't blocked when the Worker is the very thing that's unhealthy —
// 500ms is enough for a healthy Worker to respond from the same edge region
// and short enough that a fully-down Worker doesn't compound the user wait.
const ALERT_TIMEOUT_MS = 500

async function notifyEdgeFallback(slug: string, reason: string): Promise<void> {
  const token = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.EDGE_ALERT_TOKEN
  if (!token) return  // not configured → skip silently in local/preview
  try {
    await fetch(`${WORKER_API}/api/internal/edge-fallback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ surface: 'is-down', slug, reason }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    })
  } catch (err) {
    // Swallow — the alert is best-effort. The user-facing fallback render is
    // unaffected; if alerting itself is broken, that is a separate signal.
    console.warn(`[is-down/${slug}] edge-fallback alert dispatch failed:`, err instanceof Error ? err.message : err)
  }
}

// Per-isolate dedup for repeated ops signals — re-fires on cold start / per isolate in
// the fleet, which gives operators enough visibility on deploy without log-volume
// scaling with request rate.
const warnedExcludedSlugs = new Set<string>()       // target passed isFinite but failed hasReliableData
const warnedMissingSlugs = new Set<string>()        // SLUG_TO_SERVICE id not present in API response
const warnedDroppedScoreKeys = new Set<string>()    // services with non-finite aiwatchScore in API response

export default async function handler(req: Request) {
  try {
    const url = new URL(req.url)
    const slug = url.searchParams.get('slug') ?? ''

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
    // without paying the ~34-service live fan-out of /api/status on this high-traffic SEO surface.
    let serviceData = null
    let fallbacks: Array<{ id: string; name: string; score: number | null; status: string }> = []
    let aiInsight: { summary: string; estimatedRecovery: string; affectedScope: string[]; analyzedAt: string; needsFallback?: boolean; resolvedAt?: string } | null = null
    // Track the precise reason for the fallback render so the Discord alert can
    // distinguish operational classes (timeout vs HTTP failure vs missing service
    // vs JSON parse error). Defaults to a generic label that should never ship —
    // overwritten below before use.
    let fallbackReason: string = 'unknown'

    const result = await Promise.allSettled([
      fetch(`${WORKER_API}/api/status/cached`, { signal: AbortSignal.timeout(5000) }),
    ])

    if (result[0].status === 'fulfilled' && result[0].value.ok) {
      try {
        const data = await result[0].value.json() as {
          services: Array<{
            id: string; name: string; category: string; status: string
            latency: number | null; uptime30d: number | null; uptimeSource?: string
            lastChecked: string; incidents: unknown[]; aiwatchScore?: number | null
            scoreGrade?: string | null; scoreConfidence?: string; incidentSourceStale?: boolean
            components?: Array<{ id: string; name: string; status: 'operational' | 'degraded' | 'down' }>
          }>
          aiAnalysis?: Record<string, { summary: string; estimatedRecovery: string; affectedScope: string[]; needsFallback?: boolean; analyzedAt: string; incidentId: string; resolvedAt?: string }>
        }
        const allServices = data.services ?? []

        // Extract target service
        const target = allServices.find(s => s.id === entry.id)
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

        // Calculate rank by AIWatch Score — match dashboard logic (src/pages/Ranking.jsx):
        // 1. Exclude estimate-only services with 0 incidents (insufficient data)
        // 2. Use competition ranking (1, 2, 4=, 4=, 4=, 7=, ...) based on rounded score,
        //    not array index — otherwise tied services display different ranks per service
        if (Number.isFinite(target?.aiwatchScore)) {
          const hasReliableData = (s: { uptimeSource?: string; incidents?: unknown[]; incidentSourceStale?: boolean }) =>
            !(s.uptimeSource === 'estimate' && (s.incidents ?? []).length === 0) && !s.incidentSourceStale
          const targetScore = Math.round(target!.aiwatchScore as number)
          if (!hasReliableData(target!)) {
            // Target itself fails the reliability filter — dedup'd to avoid log spam
            if (!warnedExcludedSlugs.has(slug)) {
              warnedExcludedSlugs.add(slug)
              console.warn(`[is-down/${slug}] target excluded from ranked set (estimate source with 0 incidents, or stale incident source #591) — check SLUG_TO_SERVICE vs uptimeSource/incidentSourceStale`)
            }
          } else {
            // Use Number.isFinite instead of != null so NaN scores (from a corrupt pipeline)
            // don't silently corrupt the sort order or tie-count. Dedup by dropped-ids set
            // so a persistently-NaN service doesn't spam logs on every request.
            const dropped = allServices.filter(s => s.aiwatchScore != null && !Number.isFinite(s.aiwatchScore))
            if (dropped.length > 0) {
              const key = dropped.map(d => d.id).sort().join(',')
              if (!warnedDroppedScoreKeys.has(key)) {
                warnedDroppedScoreKeys.add(key)
                console.error(`[is-down] non-finite aiwatchScore for: ${key}`)
              }
            }
            const scored = allServices
              .filter(s => Number.isFinite(s.aiwatchScore) && hasReliableData(s))
              .sort((a, b) => (b.aiwatchScore as number) - (a.aiwatchScore as number))
            // findIndex by rounded score (not id) — gives the first-tied position, matching competition ranking
            const rank = scored.findIndex(s => Math.round(s.aiwatchScore as number) === targetScore) + 1
            const isTied = scored.filter(s => Math.round(s.aiwatchScore as number) === targetScore).length > 1
            if (rank > 0) {
              (serviceData as any).rank = rank;
              (serviceData as any).rankTied = isTied;
              (serviceData as any).totalRanked = scored.length
            } else {
              // Should be unreachable — target passed all filters but isn't in scored.
              // Log so the asymmetry between target-check and filter-check is visible.
              console.error(
                `[is-down/${slug}] rank lookup failed despite passing filters: ` +
                `targetScore=${targetScore}, scoredLen=${scored.length}, ` +
                `sampleScores=${scored.slice(0, 5).map(s => Math.round(s.aiwatchScore as number)).join(',')}`,
              )
            }
          }
        } else if (target?.aiwatchScore != null) {
          // Target has a non-null but non-finite score (NaN/Infinity) — hard pipeline bug.
          console.error(`[is-down/${slug}] target.aiwatchScore is not finite:`, target.aiwatchScore)
        }

        // Build fallbacks from same data (tier-based priority for API services + coding agents)
        // Cross-mirror sync test (worker/src/__tests__/api-tier-sync.test.ts) reads this file via fs
        // and asserts every key in worker/src/fallback.ts API_TIER appears here, so a partial sync
        // fails CI. The inline copy is necessary because the Edge Function bundle can't pull from
        // worker/src/* (separate compilation surface).
        const API_TIER: Record<string, number> = {
          claude: 1, openai: 1, gemini: 1,
          mistral: 2, cohere: 2, groq: 2, together: 2, fireworks: 2, cerebras: 2, deepseek: 2, xai: 2, perplexity: 2,
          bedrock: 3, azureopenai: 3, openrouter: 3, langsmith: 3,
          elevenlabs: 4, assemblyai: 4, deepgram: 4,
          runway: 5, luma: 5, // Video (#602 / #601 step B) — keep in sync with worker/src/fallback.ts
          claudecode: 11, codex: 11,
          cursor: 12, windsurf: 12,
          copilot: 13, junie: 13,
          chatgpt: 21, claudeai: 21, characterai: 21,
        }
        // Inline tierFor — same warn-once shape as worker/src/fallback.ts and src/utils/constants.js.
        // The Edge Function runs once per request so the warned set is functionally a one-shot per
        // request, not per session — still useful for surfacing typos in the access log.
        const warnedTierIds = new Set<string>()
        const tierFor = (id: string): number => {
          const t = API_TIER[id]
          if (t !== undefined) return t
          if (!warnedTierIds.has(id)) {
            warnedTierIds.add(id)
            console.warn(`[is-down/${slug}] no API_TIER for service "${id}" — falling back to 99 (Score-only ordering)`)
          }
          return 99
        }
        if (!EXCLUDE_FALLBACK.includes(entry.id)) {
          const sourceTier = tierFor(entry.id)
          fallbacks = allServices
            // #550 — exclude candidates with an unresolved incident even if status is still 'operational'.
            .filter(s => s.category === entry.category && s.id !== entry.id && s.status === 'operational'
              && !(s.incidents ?? []).some(i => (i as { status?: string }).status !== 'resolved')
              && !EXCLUDE_FALLBACK.includes(s.id))
            .sort((a, b) => {
              const distA = Math.abs(tierFor(a.id) - sourceTier)
              const distB = Math.abs(tierFor(b.id) - sourceTier)
              if (distA !== distB) return distA - distB
              return ((b as any).aiwatchScore ?? 0) - ((a as any).aiwatchScore ?? 0)
            })
            .slice(0, 2)
            .map(s => ({ id: s.id, name: s.name, score: (s as any).aiwatchScore ?? null, status: s.status }))
        }

        // Extract AI analysis for this service (first active analysis from array)
        const analyses = data.aiAnalysis?.[entry.id]
        const analysis = Array.isArray(analyses) ? analyses[0] : analyses
        // Show AI insight if analysis exists (incident may be active even when status is operational)
        if (analysis) {
          aiInsight = analysis
        }
      } catch (parseErr) {
        fallbackReason = 'parse_error'
        console.error(`[is-down/${slug}] JSON parse failed:`, parseErr instanceof Error ? parseErr.message : parseErr)
      }
    } else if (result[0].status === 'fulfilled' && !result[0].value.ok) {
      fallbackReason = `worker_http_${result[0].value.status}`
      console.error(`[is-down/${slug}] API returned HTTP ${result[0].value.status}`)
    } else if (result[0].status === 'rejected') {
      const err = result[0].reason
      fallbackReason = err?.name === 'AbortError' ? 'worker_timeout' : 'worker_unreachable'
      console.error(`[is-down/${slug}] API fetch ${err?.name === 'AbortError' ? 'timeout' : 'failed'}:`, err?.message)
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

    const html = renderPage(slug, serviceData as Parameters<typeof renderPage>[1], seo, fallbacks, aiInsight, regionRec)

    // #378: when the upstream Worker fetch failed and we're rendering the
    // "Status data is temporarily unavailable" fallback, the response must NOT
    // be cached the same way as a successful render. Otherwise a sub-minute
    // Worker blip poisons the Vercel CDN cache for ~6 minutes per region
    // (s-maxage=60 + stale-while-revalidate=300). Diverge both the status code
    // and the Cache-Control so a retry gets a fresh fetch, and notify the
    // Worker so the operator gets a Discord alert.
    const isFallback = serviceData === null
    if (isFallback) await notifyEdgeFallback(slug, fallbackReason)
    return new Response(html, {
      status: isFallback ? 503 : 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': isFallback
          ? 'no-store, max-age=0, must-revalidate'
          : 'public, s-maxage=60, stale-while-revalidate=300',
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

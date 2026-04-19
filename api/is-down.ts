// Vercel Edge Function — "Is X Down?" SSR pages

import { SLUG_TO_SERVICE } from './is-down/slug-map'
import { getSEOContent } from './is-down/seo-content'
import { renderPage } from './is-down/html-template'

export const config = { runtime: 'edge' }

const WORKER_API = 'https://aiwatch-worker.p2c2kbf.workers.dev'
// Keep in sync with worker/src/fallback.ts and src/utils/constants.js
const EXCLUDE_FALLBACK = ['replicate', 'huggingface', 'pinecone', 'stability', 'voyageai', 'modal', 'characterai', 'bedrock', 'azureopenai']

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

    // Single API call — /api/status always returns real-time data (no KV dependency)
    let serviceData = null
    let fallbacks: Array<{ id: string; name: string; score: number | null; status: string }> = []
    let aiInsight: { summary: string; estimatedRecovery: string; affectedScope: string[]; analyzedAt: string; needsFallback?: boolean; resolvedAt?: string } | null = null

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
            scoreGrade?: string | null; scoreConfidence?: string
          }>
          aiAnalysis?: Record<string, { summary: string; estimatedRecovery: string; affectedScope: string[]; needsFallback?: boolean; analyzedAt: string; incidentId: string; resolvedAt?: string }>
        }
        const allServices = data.services ?? []

        // Extract target service
        const target = allServices.find(s => s.id === entry.id)
        if (target) {
          serviceData = target
        } else if (!warnedMissingSlugs.has(slug)) {
          // Hard config drift: slug references an id that doesn't exist in the API response.
          // Page renders degraded (no status/rank/fallbacks) — log so operators can reconcile.
          warnedMissingSlugs.add(slug)
          console.error(`[is-down/${slug}] service id "${entry.id}" not in API response — SLUG_TO_SERVICE is out of sync with worker/src/services.ts`)
        }

        // Calculate rank by AIWatch Score — match dashboard logic (src/pages/Ranking.jsx):
        // 1. Exclude estimate-only services with 0 incidents (insufficient data)
        // 2. Use competition ranking (1, 2, 4=, 4=, 4=, 7=, ...) based on rounded score,
        //    not array index — otherwise tied services display different ranks per service
        if (Number.isFinite(target?.aiwatchScore)) {
          const hasReliableData = (s: { uptimeSource?: string; incidents?: unknown[] }) =>
            !(s.uptimeSource === 'estimate' && (s.incidents ?? []).length === 0)
          const targetScore = Math.round(target!.aiwatchScore as number)
          if (!hasReliableData(target!)) {
            // Target itself fails the reliability filter — dedup'd to avoid log spam
            if (!warnedExcludedSlugs.has(slug)) {
              warnedExcludedSlugs.add(slug)
              console.warn(`[is-down/${slug}] target excluded from ranked set (estimate source with 0 incidents) — check SLUG_TO_SERVICE vs uptimeSource`)
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

        // Build fallbacks from same data (tier-based priority for API services)
        // Keep in sync with worker/src/fallback.ts API_TIER
        const API_TIER: Record<string, number> = {
          claude: 1, openai: 1, gemini: 1,
          mistral: 2, cohere: 2, groq: 2, together: 2, fireworks: 2, deepseek: 2, xai: 2, perplexity: 2,
          bedrock: 3, azureopenai: 3, openrouter: 3,
          elevenlabs: 4, assemblyai: 4, deepgram: 4,
        }
        if (!EXCLUDE_FALLBACK.includes(entry.id)) {
          const sourceTier = API_TIER[entry.id] ?? 99
          fallbacks = allServices
            .filter(s => s.category === entry.category && s.id !== entry.id && s.status === 'operational' && !EXCLUDE_FALLBACK.includes(s.id))
            .sort((a, b) => {
              const distA = Math.abs((API_TIER[a.id] ?? 99) - sourceTier)
              const distB = Math.abs((API_TIER[b.id] ?? 99) - sourceTier)
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
        console.error(`[is-down/${slug}] JSON parse failed:`, parseErr instanceof Error ? parseErr.message : parseErr)
      }
    } else if (result[0].status === 'fulfilled' && !result[0].value.ok) {
      console.error(`[is-down/${slug}] API returned HTTP ${result[0].value.status}`)
    } else if (result[0].status === 'rejected') {
      const err = result[0].reason
      console.error(`[is-down/${slug}] API fetch ${err?.name === 'AbortError' ? 'timeout' : 'failed'}:`, err?.message)
    }

    const html = renderPage(slug, serviceData as Parameters<typeof renderPage>[1], seo, fallbacks, aiInsight)

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
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

// Vercel Edge Function — "Is X Down?" SSR pages

import { SLUG_TO_SERVICE } from './is-down/slug-map'
import { getSEOContent } from './is-down/seo-content'
import { renderPage } from './is-down/html-template'

export const config = { runtime: 'edge' }

const WORKER_API = 'https://aiwatch-worker.p2c2kbf.workers.dev'
// Keep in sync with worker/src/fallback.ts and src/utils/constants.js
const EXCLUDE_FALLBACK = ['replicate', 'huggingface', 'pinecone', 'stability', 'voyageai', 'modal', 'characterai', 'bedrock', 'azureopenai']

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
      fetch(`${WORKER_API}/api/status/cached`, { signal: AbortSignal.timeout(3000) }),
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
        }

        // Calculate rank by AIWatch Score
        if (target?.aiwatchScore != null) {
          const scored = allServices.filter(s => s.aiwatchScore != null).sort((a, b) => (b.aiwatchScore ?? 0) - (a.aiwatchScore ?? 0))
          const rank = scored.findIndex(s => s.id === entry.id) + 1
          if (rank > 0) (serviceData as any).rank = rank;
          (serviceData as any).totalRanked = scored.length
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

// Vercel Edge Function — "Is X Down?" SSR pages

import { SLUG_TO_SERVICE } from './is-down/slug-map'
import { getSEOContent } from './is-down/seo-content'
import { renderPage } from './is-down/html-template'

export const config = { runtime: 'edge' }

const WORKER_API = 'https://aiwatch-worker.p2c2kbf.workers.dev'
const EXCLUDE_FALLBACK = ['elevenlabs', 'replicate', 'huggingface']

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

    const result = await Promise.allSettled([
      fetch(`${WORKER_API}/api/status`, { signal: AbortSignal.timeout(8000) }),
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

        // Build fallbacks from same data
        if (!EXCLUDE_FALLBACK.includes(entry.id)) {
          fallbacks = allServices
            .filter(s => s.category === entry.category && s.id !== entry.id && s.status === 'operational')
            .sort((a, b) => (b.aiwatchScore ?? 0) - (a.aiwatchScore ?? 0))
            .slice(0, 2)
            .map(s => ({ id: s.id, name: s.name, score: s.aiwatchScore ?? null, status: s.status }))
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

    const html = renderPage(slug, serviceData as Parameters<typeof renderPage>[1], seo, fallbacks)

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

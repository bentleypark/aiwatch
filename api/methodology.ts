// Vercel Edge Function — /methodology page (#673)
//
// Public, indexable Methodology page: how AIWatch measures AI service reliability,
// the AIWatch Score formulas, and an explicit "what we can't measure and why" coverage
// table. Self-contained SSR (no external data fetch) — mirrors api/intro.ts.

import { renderMethodologyPage } from './methodology/html-template'

export const config = { runtime: 'edge' }

export default async function handler(_req: Request) {
  try {
    const html = renderMethodologyPage()

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    })
  } catch (err) {
    console.error('[methodology] Render failed:', err instanceof Error ? err.stack : err)
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>AIWatch</title></head><body style="background:#080c10;color:#e6edf3;font-family:sans-serif;text-align:center;padding:60px"><h1>Something went wrong</h1><p>Please visit <a href="https://ai-watch.dev" style="color:#58a6ff">AIWatch Dashboard</a>.</p></body></html>',
      { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } },
    )
  }
}

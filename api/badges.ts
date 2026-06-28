// Vercel Edge Function — /badges gallery page (#805 Problem B)
//
// Public, indexable gallery of AIWatch's embeddable status badges, one canonical destination to
// grab any service's badge (links to its crawlable /is-{slug}-down page). Self-contained SSR (no
// data fetch) — mirrors api/methodology.ts.

import { renderBadgesPage } from './badges/html-template'

export const config = { runtime: 'edge' }

export default async function handler(_req: Request) {
  try {
    const html = renderBadgesPage()
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    })
  } catch (err) {
    console.error('[badges] Render failed:', err instanceof Error ? err.stack : err)
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>AIWatch</title></head><body style="background:#080c10;color:#e6edf3;font-family:sans-serif;text-align:center;padding:60px"><h1>Something went wrong</h1><p>Please visit <a href="https://ai-watch.dev" style="color:#58a6ff">AIWatch Dashboard</a>.</p></body></html>',
      { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } },
    )
  }
}

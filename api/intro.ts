// Vercel Edge Function — /intro landing page

import { renderLandingPage } from './intro/html-template'
import { resolveAnnouncement } from './intro/announcements'

export const config = { runtime: 'edge' }

export default async function handler(req: Request) {
  try {
    const url = new URL(req.url)
    // Optional campaign banner via ?banner=<key> (#265). Defaults to none.
    const announcement = resolveAnnouncement(url.searchParams.get('banner'))
    const html = renderLandingPage({ announcement })

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    })
  } catch (err) {
    console.error('[intro] Render failed:', err instanceof Error ? err.stack : err)
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>AIWatch</title></head><body style="background:#080c10;color:#e6edf3;font-family:sans-serif;text-align:center;padding:60px"><h1>Something went wrong</h1><p>Please visit <a href="https://ai-watch.dev" style="color:#58a6ff">AIWatch Dashboard</a>.</p></body></html>',
      { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } },
    )
  }
}

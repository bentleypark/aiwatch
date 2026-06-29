// Vercel Edge Function — /intro landing page

import { renderLandingPage } from './intro/html-template'
import { resolveAnnouncement } from './intro/announcements'
import { generateNonce, buildCsp } from './_shared/csp-nonce'

export const config = { runtime: 'edge' }

export default async function handler(req: Request) {
  try {
    const url = new URL(req.url)
    // Optional campaign banner via ?banner=<key> (#265). Defaults to none.
    const announcement = resolveAnnouncement(url.searchParams.get('banner'))
    // #482 — per-response nonce + own CSP header (Report-Only in Phase 2 → enforcing in Phase 3).
    const nonce = generateNonce()
    const csp = buildCsp(nonce)
    const html = renderLandingPage({ announcement, nonce })

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // #482 — per-response nonce is incompatible with caching (a cached page reuses one nonce
        // for every visitor → no XSS protection). no-store.
        'Cache-Control': 'no-store',
        [csp.key]: csp.value,
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

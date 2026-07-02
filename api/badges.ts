// Vercel Edge Function — /badges gallery page (#805 Problem B)
//
// Public, indexable gallery of AIWatch's embeddable status badges, one canonical destination to
// grab any service's badge (links to its crawlable /is-{slug}-down page). Self-contained SSR (no
// data fetch) — mirrors api/methodology.ts.

import { renderBadgesPage } from './_badges/html-template'
import { generateNonce, buildCsp } from './_shared/csp-nonce'

export const config = { runtime: 'edge' }

export default async function handler(_req: Request) {
  try {
    // #482 — per-response nonce: each inline <script> is stamped with it and the page sets its own
    // ENFORCING CSP header carrying 'nonce-…' (Phase 3). The SPA's vercel.json Report-Only header
    // co-applies but Report-Only never blocks, so the nonce policy is what enforces here.
    const nonce = generateNonce()
    const csp = buildCsp(nonce, { enforce: true })
    const html = renderBadgesPage(nonce)
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // #482 — a per-response CSP nonce is incompatible with caching: a cached page would serve
        // the SAME nonce to every visitor for the cache window, defeating the nonce's per-response
        // uniqueness (a publicly-readable static nonce gives no XSS protection). So this page is
        // no-store. Acceptable — /badges is a low-traffic, self-contained SSR page.
        'Cache-Control': 'no-store',
        [csp.key]: csp.value,
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

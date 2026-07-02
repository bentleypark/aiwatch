// Vercel Edge Function — /methodology page (#673)
//
// Public, indexable Methodology page: how AIWatch measures AI service reliability,
// the AIWatch Score formulas, and an explicit "what we can't measure and why" coverage
// table. Self-contained SSR (no external data fetch) — mirrors api/intro.ts.

import { renderMethodologyPage } from './_methodology/html-template'
import { generateNonce, buildCsp } from './_shared/csp-nonce'

export const config = { runtime: 'edge' }

export default async function handler(_req: Request) {
  try {
    // #482 — per-response nonce + own ENFORCING CSP header (Phase 3; SPA stays Report-Only).
    const nonce = generateNonce()
    const csp = buildCsp(nonce, { enforce: true })
    const html = renderMethodologyPage(nonce)

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // #482 — per-response nonce is incompatible with caching (a cached page reuses one nonce
        // for every visitor → no XSS protection). no-store; /methodology is low-traffic SSR.
        'Cache-Control': 'no-store',
        [csp.key]: csp.value,
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

// Vercel Edge Function — /plugin page (#920)
//
// Public, indexable landing/discovery page for the AIWatch Claude Code plugin (outage monitor +
// /aiwatch briefing). Self-contained SSR (no external data fetch) — mirrors api/methodology.ts.
// Edge runtime → does NOT count against the Vercel 12-Serverless-Function cap (#862), so a real
// SEO-crawlable HTML page costs zero function budget (unlike a SPA hash route, which crawlers see
// as an empty shell). The install CTA is gated (api/_shared/plugin-cta.ts) until marketplace approval.

import { renderPluginPage } from './_plugin/html-template'
import { generateNonce, buildCsp } from './_shared/csp-nonce'

export const config = { runtime: 'edge' }

export default async function handler(_req: Request) {
  try {
    // #482 — per-response nonce + own ENFORCING CSP (Phase 3), like methodology/badges/intro.
    const nonce = generateNonce()
    const csp = buildCsp(nonce, { enforce: true })
    const html = renderPluginPage(nonce)

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Per-response nonce is incompatible with caching (a cached page reuses one nonce for every
        // visitor → no XSS protection). no-store; /plugin is low-traffic SSR like /methodology.
        'Cache-Control': 'no-store',
        [csp.key]: csp.value,
      },
    })
  } catch (err) {
    console.error('[plugin] Render failed:', err instanceof Error ? err.stack : err)
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>AIWatch</title></head><body style="background:#080c10;color:#e6edf3;font-family:sans-serif;text-align:center;padding:60px"><h1>Something went wrong</h1><p>Please visit <a href="https://ai-watch.dev" style="color:#58a6ff">AIWatch Dashboard</a>.</p></body></html>',
      { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } },
    )
  }
}

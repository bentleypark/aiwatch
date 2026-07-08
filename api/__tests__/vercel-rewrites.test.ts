import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Guards the #452 fix. The Vercel-proxied `/api/status/cached` rewrite MUST force
// the statusline lite projection (`?src=statusline-*`). Without the tag the Worker
// returns the full ~2.2 MB payload (services + probe:24h + latency:24h + AI
// analysis), and legacy/untagged pollers — statusline snippets copied before #438,
// which poll ~every prompt — re-download all of it through Vercel (uncached proxy,
// billed as Fast Data Transfer). Vercel Observability measured this route at the
// top of Fast Data Transfer (2.9K req × 2.26 MB ≈ 5.74 GB/cycle) when the quota
// overran — forcing lite drops it ~1000× (≈2 KB/req).
//
// Nothing in our own code reads this proxied path: the SPA (usePolling.js),
// Statusline.jsx, and the is-down Edge SSR (api/is-down.ts) all hit the Worker
// domain directly. So it only ever serves external/legacy callers, who need
// exactly {id,name,status} — which the lite projection provides.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const vercelConfig = JSON.parse(
  readFileSync(join(repoRoot, 'vercel.json'), 'utf8'),
) as {
  rewrites: Array<{ source: string; destination: string }>
  redirects?: Array<{ source: string; destination: string; permanent?: boolean }>
}

describe('vercel.json /api/status/cached rewrite (#452)', () => {
  it('forces the statusline lite projection so the proxied path never serves the full payload', () => {
    const rule = vercelConfig.rewrites.find((r) => r.source === '/api/status/cached')
    expect(rule, '/api/status/cached rewrite must exist').toBeDefined()
    // Targets the Worker, still routes to the cached endpoint (a typo'd path like
    // /api/status would pass the tag check but break callers), and carries a
    // ?src=statusline-* tag (isStatuslineRequest matches any src starting with
    // "statusline-" → buildStatuslinePayload).
    expect(rule!.destination).toContain('aiwatch-worker.p2c2kbf.workers.dev')
    expect(rule!.destination).toContain('/api/status/cached')
    expect(rule!.destination).toMatch(/[?&]src=statusline-/)
  })
})

describe('vercel.json /p/:slug plugin redirect (#920)', () => {
  it('redirects the short plugin link to the is-down page WITH the plugin UTM (zero Serverless Functions)', () => {
    // The /aiwatch briefing links `ai-watch.dev/p/<slug>` (short, no query — survives the model
    // relay + terminal); a config REDIRECT (not a function → no 12-fn cap cost) adds the UTM and
    // 307s to the real is-down page, so GA4 + the #842-B beacon attribute the plugin inflow.
    const rule = (vercelConfig.redirects ?? []).find((r) => r.source === '/p/:slug')
    expect(rule, '/p/:slug redirect must exist').toBeDefined()
    expect(rule!.destination).toBe('/is-:slug-down?utm_source=claude-code&utm_medium=plugin&utm_campaign=outage')
    expect(rule!.permanent).toBe(false) // 307 — a service can toggle status; not a permanent move
  })
})

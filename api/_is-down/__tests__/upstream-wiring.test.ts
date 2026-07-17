// #1053 — pin the EDGE wiring.
//
// The worker half got `worker/src/__tests__/upstream-link-wiring.test.ts` on the reasoning that
// "`buildUpstreamLinks` being green proves nothing about whether index.ts ever calls it". That
// reasoning applies identically to the Edge half — the half that actually renders — and it had no pin.
// Three separate deletions each left every OTHER Edge unit test green while the card never reached a user:
//   - the `${renderUpstreamNote(...)}` interpolation in renderPage's body
//   - the `buildUpstreamNote(data.upstreamLinks, entry.id)` call in api/is-down.ts
//   - the 12th positional arg on the renderPage call (a 12-arg positional call is where a silent
//     misbind lives)
// That is #1032's "pure fn green ≠ wiring green" and #1003's half-migrated dual path.
//
// renderPage IS importable, so the interpolation + arg binding are pinned by rendering a real page
// rather than by regex. api/is-down.ts is an Edge Function (it pulls @vercel/edge types and runs a
// fetch at module scope), so its call site is pinned via fs — the `api-tier-sync.test.ts` (#403)
// precedent for a cross-surface pin.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderPage } from '../html-template'
import { buildUpstreamNote, type UpstreamLinkLike } from '../upstream-note'
import { getSEOContent } from '../seo-content'

const IS_DOWN_SRC = readFileSync(join(__dirname, '..', '..', 'is-down.ts'), 'utf8')

// The real 2026-07-17 payload, verbatim from /api/status/cached: claude 06:47:54.909Z →
// cursor 07:17:15.075Z, a 29m20s lead that rounds to 29m.
const LINK: UpstreamLinkLike = {
  id: 'cursor',
  incidentTitle: 'Investigating Anthropic degradation',
  startedAt: '2026-07-17T07:17:15.075Z',
  upstream: [{
    id: 'claude',
    name: 'Claude API',
    status: 'degraded',
    incidentTitle: 'Elevated errors on Sonnet 5 and Haiku 4.5',
    startedAt: '2026-07-17T06:47:54.909Z',
  }],
}

const SERVICE = {
  id: 'cursor', name: 'Cursor', category: 'agent', status: 'degraded',
  latency: null, uptime30d: 99.1, lastChecked: '2026-07-17T07:30:00Z', incidents: [],
} as unknown as Parameters<typeof renderPage>[1]

const seo = getSEOContent('cursor')!
const note = buildUpstreamNote([LINK], 'cursor')

describe('upstreamNote → renderPage wiring (#1053)', () => {
  it('the card reaches the rendered PAGE, not just renderUpstreamNote in isolation', () => {
    const html = renderPage('cursor', SERVICE, seo, [], null, null, [], null, null, null, null, note)
    expect(html).toContain('Related Upstream Incident')
    expect(html).toContain('Elevated errors on Sonnet 5 and Haiku 4.5')
    expect(html).toContain('29m before Cursor&rsquo;s report')
    expect(html).toMatch(/Started \S+ ago/) // the clause, not just its ` · Nm before …` tail
  })

  it('renders no card when the worker made no claim (the deploy-skew / quiet-gate path)', () => {
    const html = renderPage('cursor', SERVICE, seo, [], null, null, [], null, null, null, null, null)
    expect(html).not.toContain('Related Upstream Incident')
  })

  it('sits in the contextual band: after the CTA and the AI Analysis card, before the components', () => {
    // #888's CRO rule keeps it out of the alert cluster; tests/is-down.spec.js pins CTA→AI-Insight.
    // A real insight is rendered here on purpose — with `aiInsight: null` the "after the AI card"
    // half of this claim would be anchored to nothing and the test name would be a lie.
    const insight = { summary: 'Anthropic models degraded.', estimatedRecovery: '~1h', affectedScope: ['API'], analyzedAt: '2026-07-17T07:30:00Z' }
    const withComponents = { ...(SERVICE as object), components: [{ id: 'c1', name: 'API', status: 'degraded' }] } as Parameters<typeof renderPage>[1]
    const html = renderPage('cursor', withComponents, seo, [], insight, null, [], null, null, null, null, note)
    const cta = html.indexOf('cta-help')
    const ai = html.indexOf('Anthropic models degraded.')
    const card = html.indexOf('Related Upstream Incident')
    const components = html.indexOf('Component Status')
    for (const [label, i] of [['cta', cta], ['ai insight', ai], ['card', card], ['components', components]] as const) {
      expect(i, `${label} must render`).toBeGreaterThan(-1)
    }
    expect(card).toBeGreaterThan(cta)
    expect(card).toBeGreaterThan(ai)
    expect(card).toBeLessThan(components)
  })

  it('api/is-down.ts computes the note and passes it to renderPage', () => {
    expect(IS_DOWN_SRC).toMatch(/import\s*\{[^}]*buildUpstreamNote[^}]*\}\s*from\s*'\.\/_is-down\/upstream-note'/)
    expect(IS_DOWN_SRC).toContain('buildUpstreamNote(data.upstreamLinks, entry.id)')
    expect(IS_DOWN_SRC).toMatch(/renderPage\([^)]*upstreamNote\)/)
  })

})

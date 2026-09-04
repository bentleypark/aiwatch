// #378 — Edge SSR `/is-*-down` must NOT cache the fallback render the same way
// as a successful one. A bare `s-maxage=60, stale-while-revalidate=300` on the
// degraded path lets a sub-minute Worker blip poison Vercel's CDN for ~6
// minutes per region. These tests pin the cache-header divergence so a future
// edit can't quietly re-introduce the silent failure.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import handler from '../is-down'

function makeReq(slug: string): Request {
  return new Request(`https://ai-watch.dev/api/is-down?slug=${slug}`, { method: 'GET' })
}

function makeWorkerSuccess(): Response {
  // Minimal payload that lets is-down.ts's parser pull a target and complete render.
  return new Response(JSON.stringify({
    services: [{
      id: 'claude',
      name: 'Claude API',
      category: 'api',
      status: 'operational',
      latency: 250,
      uptime30d: 99.9,
      lastChecked: new Date().toISOString(),
      incidents: [],
      aiwatchScore: 92,
      scoreGrade: 'excellent',
      scoreConfidence: 'high',
    }],
    aiAnalysis: {},
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('is-down.ts cache-header divergence (#378)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchMock.mockRestore()
    // Always clean — the reason-label test sets EDGE_ALERT_TOKEN; without an
    // afterEach the token leaks if any assertion mid-test throws.
    delete process.env.EDGE_ALERT_TOKEN
  })

  it('returns 200 + s-maxage=60 cache headers when Worker fetch succeeds', async () => {
    fetchMock.mockResolvedValueOnce(makeWorkerSuccess())
    const res = await handler(makeReq('claude-api'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300')
  })

  it('returns 503 + no-store when Worker fetch is rejected (timeout / network failure)', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    const res = await handler(makeReq('claude-api'))
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/)
    expect(res.headers.get('Cache-Control')).toMatch(/must-revalidate/)
  })

  it('returns 503 + no-store when Worker returns a non-2xx HTTP status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream error', { status: 502 }))
    const res = await handler(makeReq('claude-api'))
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/)
  })

  it('returns 503 + no-store when the Worker response is missing the target service', async () => {
    // Worker returned 200 but the slug is not present (deploy gap or KV race) —
    // serviceData stays null, so the fallback render fires too.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ services: [], aiAnalysis: {} }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const res = await handler(makeReq('claude-api'))
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/)
  })

  it('alert dispatch carries distinct reason labels per failure class', async () => {
    // Capture every fetch the handler makes; alerts go to /api/internal/edge-fallback
    // and we want to assert the `reason` field encodes the class (not collapsed into
    // a generic 'parse_error' for HTTP-success-but-missing-target, etc).
    process.env.EDGE_ALERT_TOKEN = 'test-token'
    const alertReasons: string[] = []
    fetchMock.mockImplementation(async (url, init) => {
      if (typeof url === 'string' && url.includes('/api/internal/edge-fallback')) {
        const body = JSON.parse((init?.body as string) ?? '{}')
        alertReasons.push(body.reason)
        return new Response(null, { status: 200 })
      }
      throw new Error('upstream-side mock not configured for this case')
    })

    // Worker timeout (AbortError)
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    await handler(makeReq('claude-api'))
    // Worker non-2xx
    fetchMock.mockResolvedValueOnce(new Response('upstream', { status: 502 }))
    await handler(makeReq('openai-api'))
    // Worker 200 but slug missing from services array
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ services: [], aiAnalysis: {} }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    await handler(makeReq('gemini'))

    expect(alertReasons).toEqual(['worker_timeout', 'worker_http_502', 'service_missing'])
  })

  it('returns 404 for an unknown slug regardless of Worker state', async () => {
    fetchMock.mockResolvedValueOnce(makeWorkerSuccess())
    const res = await handler(makeReq('not-a-real-service'))
    expect(res.status).toBe(404)
  })

  it('does NOT cache 5xx responses anywhere on the CDN — `no-store` blocks both edge and shared caches', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    const res = await handler(makeReq('claude-api'))
    const cc = res.headers.get('Cache-Control') ?? ''
    expect(cc).toContain('no-store')
    expect(cc).toContain('max-age=0')
    expect(cc).not.toContain('s-maxage')
    expect(cc).not.toContain('stale-while-revalidate')
  })
})

describe('is-down.ts — #827 F4 predicted-vs-actual on a resolved card', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  beforeEach(() => { fetchMock = vi.spyOn(globalThis, 'fetch') })
  afterEach(() => { fetchMock.mockRestore() })

  function makeWorkerResolved(): Response {
    const now = new Date().toISOString()
    return new Response(JSON.stringify({
      services: [{
        id: 'claude', name: 'Claude API', category: 'api', status: 'operational',
        latency: 145, uptime30d: 99.9, lastChecked: now, aiwatchScore: 92, scoreGrade: 'excellent', scoreConfidence: 'high',
        incidents: [{ id: 'cl-3', title: 'Login Issues', status: 'resolved', impact: 'major', startedAt: new Date(Date.now() - 164 * 60000).toISOString(), resolvedAt: now, duration: '2h 44m', timeline: [] }],
      }],
      aiAnalysis: { claude: [{ summary: 'Auth overload caused login failures.', estimatedRecovery: '30m–1h', estimatedRecoveryHours: 1, affectedScope: ['Login'], needsFallback: false, analyzedAt: new Date(Date.now() - 30 * 60000).toISOString(), incidentId: 'cl-3', resolvedAt: now }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  // Regression: the matching incident's startedAt must come from the fetched SERVICE (`target`),
  // NOT the slug-config `entry` (which has no `incidents`) — the latter threw and dropped the whole
  // page to the fallback render. Handler-level so the data-wiring (not just renderAIInsight) is covered.
  it('renders the predicted-vs-actual line (does not throw to the fallback page)', async () => {
    fetchMock.mockResolvedValueOnce(makeWorkerResolved())
    const res = await handler(makeReq('claude-api'))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Predicted vs actual:')
    expect(html).toContain('2h 44m (over ~1h est.)')
  })

  // Review finding #1 — `target` is undefined on the service_missing config-drift path, but
  // `aiAnalysis` can still carry an entry for the slug. The startedAt lookup must optional-chain
  // `target?.incidents`; the buggy `target.incidents` threw a TypeError that the JSON-parse catch
  // swallowed + MISLABELED as `parse_error` (logged "JSON parse failed"). Asserting that log is
  // absent distinguishes the fixed (clean service_missing) path from the buggy throw.
  it('does NOT throw/mislabel when aiAnalysis has an entry but the service is absent (review #1)', async () => {
    const now = new Date().toISOString()
    const payload = new Response(JSON.stringify({
      services: [{ id: 'openai', name: 'OpenAI', category: 'api', status: 'operational', latency: 1, uptime30d: 99, lastChecked: now, incidents: [], aiwatchScore: 90, scoreGrade: 'excellent', scoreConfidence: 'high' }],
      aiAnalysis: { claude: [{ summary: 's', estimatedRecovery: '30m–1h', estimatedRecoveryHours: 1, affectedScope: [], needsFallback: false, analyzedAt: now, incidentId: 'cl-3', resolvedAt: now }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    fetchMock.mockResolvedValueOnce(payload)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await handler(makeReq('claude-api')) // 'claude' service missing from `services`
    const threwParseError = errSpy.mock.calls.some(c => String(c[0]).includes('JSON parse failed'))
    errSpy.mockRestore()
    expect(threwParseError).toBe(false)   // buggy version logs this; fixed version takes the clean path
    expect(res.status).toBeGreaterThanOrEqual(200) // resolves cleanly (service_missing → 503)
  })

  // #926 — a service with multiple active incidents shows EVERY analysis (not just [0]), ordered
  // newest-incident-first so the AI card matches the "Recent Incidents" list on the same page. The
  // worker delivers aiAnalysis in push order (here OLDEST first) to prove the handler re-sorts.
  it('renders all incidents newest-first, matching the Recent Incidents order', async () => {
    const now = Date.now()
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString()
    const payload = new Response(JSON.stringify({
      services: [
        {
          id: 'claude', name: 'Claude API', category: 'api', status: 'down',
          latency: null, uptime30d: 99.09, lastChecked: iso(0), aiwatchScore: 62, scoreGrade: 'fair', scoreConfidence: 'high',
          incidents: [
            { id: 'old-auth', title: 'Auth failures', status: 'investigating', impact: 'major', startedAt: iso(45 * 60000), duration: null, timeline: [] },
            { id: 'new-stream', title: 'Streaming timeouts', status: 'identified', impact: 'minor', startedAt: iso(20 * 60000), duration: null, timeline: [] },
          ],
        },
        // an operational alternative so the 🔄 Alternatives block resolves
        { id: 'gemini', name: 'Gemini API', category: 'api', status: 'operational', latency: 210, uptime30d: 99.9, lastChecked: iso(0), incidents: [], aiwatchScore: 95, scoreGrade: 'excellent', scoreConfidence: 'high' },
      ],
      // Delivered oldest-first on purpose — the handler must re-sort newest-first.
      aiAnalysis: { claude: [
        { summary: 'OLDER — auth overload.', estimatedRecovery: '30m–1h', affectedScope: ['Login'], needsFallback: true, analyzedAt: iso(9 * 60000), incidentId: 'old-auth' },
        { summary: 'NEWER — streaming stalls.', estimatedRecovery: '1–2h', affectedScope: ['Streaming'], needsFallback: true, analyzedAt: iso(4 * 60000), incidentId: 'new-stream' },
      ] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    fetchMock.mockResolvedValueOnce(payload)
    const res = await handler(makeReq('claude-api'))
    expect(res.status).toBe(200)
    const html = await res.text()
    // Both summaries present (the whole array is rendered, not just [0])…
    expect(html).toContain('OLDER — auth overload.')
    expect(html).toContain('NEWER — streaming stalls.')
    // …and the NEWER incident's card sub-block appears BEFORE the older one.
    expect(html.indexOf('NEWER — streaming stalls.')).toBeLessThan(html.indexOf('OLDER — auth overload.'))
    // Single shared card — one header + one Alternatives block.
    expect((html.match(/AI Analysis</g) ?? []).length).toBe(1)
    expect((html.match(/🔄 Alternatives/g) ?? []).length).toBe(1)
  })
})

// #1186 — the rank/"#N of M" clause must count WITHIN the target's own confidence tier only, mirroring
// the dashboard's split into two independent rank sequences (Ranking.jsx / serviceReliability.js's
// splitByConfidence). Before this fix, is-down.ts computed rank over ALL high+medium services combined
// — the same apples-to-oranges comparison #1186 removed from the dashboard, just on a different surface.
describe('is-down.ts — rank is scoped to the target\'s own confidence tier (#1186)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  beforeEach(() => { fetchMock = vi.spyOn(globalThis, 'fetch') })
  afterEach(() => { fetchMock.mockRestore() })

  const now = new Date().toISOString()
  const svc = (over: Record<string, unknown>) => ({
    category: 'api', status: 'operational', latency: 100, uptime30d: null,
    lastChecked: now, incidents: [], scoreGrade: 'good', ...over,
  })

  it('a medium-confidence target ranks only against OTHER medium-confidence services, not high', async () => {
    const payload = new Response(JSON.stringify({
      services: [
        svc({ id: 'gemini', name: 'Gemini API', aiwatchScore: 86, scoreConfidence: 'medium' }),
        svc({ id: 'xai', name: 'xAI API', aiwatchScore: 70, scoreConfidence: 'medium' }),
        // Two high-confidence services with scores that would change gemini's rank/total if merged in.
        svc({ id: 'claude', name: 'Claude API', aiwatchScore: 99, uptime30d: 99.99, scoreConfidence: 'high' }),
        svc({ id: 'openai', name: 'OpenAI API', aiwatchScore: 95, uptime30d: 99.9, scoreConfidence: 'high' }),
      ],
      aiAnalysis: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    fetchMock.mockResolvedValueOnce(payload)
    const res = await handler(makeReq('gemini'))
    const html = await res.text()
    // #1 of 2 (gemini, xai) — NOT #3 of 4, which is what merging in the two high-confidence services
    // above would have produced.
    expect(html).toContain('is ranked <strong>#1</strong> of 2 AI services')
    // The disclosure qualifier renders for a medium-confidence target.
    expect(html).toContain('with no official uptime metric (scored on incidents, recovery, and responsiveness only)')
  })

  it('a high-confidence target\'s rank/total is unaffected by medium-confidence services in the payload', async () => {
    const payload = new Response(JSON.stringify({
      services: [
        svc({ id: 'claude', name: 'Claude API', aiwatchScore: 92, uptime30d: 99.9, scoreConfidence: 'high' }),
        svc({ id: 'openai', name: 'OpenAI API', aiwatchScore: 80, uptime30d: 99.5, scoreConfidence: 'high' }),
        svc({ id: 'gemini', name: 'Gemini API', aiwatchScore: 999, scoreConfidence: 'medium' }), // would win #1 if tiers merged
      ],
      aiAnalysis: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    fetchMock.mockResolvedValueOnce(payload)
    const res = await handler(makeReq('claude-api'))
    const html = await res.text()
    expect(html).toContain('is ranked <strong>#1</strong> of 2 AI services')
    // No medium-tier disclosure qualifier on a high-confidence target.
    expect(html).not.toContain('with no official uptime metric')
  })
})

// #1186 — is-down.ts's inline orderForFallback (the "🔄 Alternatives" recommendation, a SEPARATE
// feature from the rank/"#N of M" clause tested above, touched in the same file diff) previously had
// only a string-pattern check (fallback-order-sync.test.ts) that the mirror exists and has the right
// shape — never a behavioral test through the real handler. These exercise it end-to-end.
describe('is-down.ts — Alternatives recommendation ordering (#1186)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  beforeEach(() => { fetchMock = vi.spyOn(globalThis, 'fetch') })
  afterEach(() => { fetchMock.mockRestore() })

  const now = new Date().toISOString()
  const svc = (over: Record<string, unknown>) => ({
    category: 'api', status: 'operational', latency: 100, uptime30d: null,
    lastChecked: now, incidents: [], scoreGrade: 'good', ...over,
  })

  // Extract the rendered order of names from the "Alternatives When X is Down" list
  // (`renderFallbacks`'s `<span class="fallback-name">` — wrapped in an `<a>` when a slug is known).
  const bulletOrder = (html: string): string[] =>
    [...html.matchAll(/class="fallback-name">(?:<a[^>]*>)?([^<]+)/g)].map(m => m[1].trim())

  it('a higher medium-confidence score does not outrank a lower high-confidence one', async () => {
    const payload = new Response(JSON.stringify({
      services: [
        svc({ id: 'openai', name: 'OpenAI API', status: 'down', uptime30d: 99, scoreConfidence: 'high', aiwatchScore: 80, incidents: [{ id: 'o-1', title: 'Outage', status: 'investigating', impact: 'major', startedAt: now, duration: null, timeline: [] }] }),
        svc({ id: 'claude', name: 'Claude API', uptime30d: 99.9, scoreConfidence: 'high', aiwatchScore: 85 }),
        svc({ id: 'gemini', name: 'Gemini API', scoreConfidence: 'medium', aiwatchScore: 92 }), // higher raw score
      ],
      aiAnalysis: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    fetchMock.mockResolvedValueOnce(payload)
    const res = await handler(makeReq('openai-api'))
    const html = await res.text()
    const order = bulletOrder(html)
    expect(order.indexOf('Claude API')).toBeLessThan(order.indexOf('Gemini API'))
  })

  it('a low-confidence (score-withheld) candidate never displaces a real-scored peer', async () => {
    const payload = new Response(JSON.stringify({
      services: [
        svc({ id: 'together', name: 'Together AI', status: 'down', scoreConfidence: null, aiwatchScore: null, incidents: [{ id: 't-1', title: 'Outage', status: 'investigating', impact: 'major', startedAt: now, duration: null, timeline: [] }] }),
        svc({ id: 'mistral', name: 'Mistral API', scoreConfidence: 'high', aiwatchScore: 95 }),
        svc({ id: 'cohere', name: 'Cohere API', scoreConfidence: 'high', aiwatchScore: 90 }),
        svc({ id: 'groq', name: 'Groq Cloud', scoreConfidence: 'low', aiwatchScore: null }),
      ],
      aiAnalysis: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    fetchMock.mockResolvedValueOnce(payload)
    const res = await handler(makeReq('together'))
    const html = await res.text()
    const order = bulletOrder(html)
    expect(order).toEqual(['Mistral API', 'Cohere API'])
    expect(order).not.toContain('Groq Cloud')
  })

  it('a candidate with an unrecognized scoreConfidence value sinks below high/medium, never vanishes', async () => {
    // A regression in the proportional-interleave rewrite: only 'low'/undefined were appended after the
    // interleave, so a candidate whose scoreConfidence was neither 'high'/'medium' NOR literally
    // 'low'/undefined (a legacy KV record predating a future confidence value) was bucketed but never
    // rendered — silently dropped instead of sunk.
    const payload = new Response(JSON.stringify({
      services: [
        svc({ id: 'together', name: 'Together AI', status: 'down', scoreConfidence: null, aiwatchScore: null, incidents: [{ id: 't-1', title: 'Outage', status: 'investigating', impact: 'major', startedAt: now, duration: null, timeline: [] }] }),
        svc({ id: 'mistral', name: 'Mistral API', scoreConfidence: 'high', aiwatchScore: 95 }),
        svc({ id: 'cohere', name: 'Cohere API', scoreConfidence: 'high', aiwatchScore: 90 }),
        svc({ id: 'groq', name: 'Groq Cloud', scoreConfidence: 'insufficient', aiwatchScore: 99 }), // would win #1 on raw Score alone
      ],
      aiAnalysis: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    fetchMock.mockResolvedValueOnce(payload)
    const res = await handler(makeReq('together'))
    const html = await res.text()
    const order = bulletOrder(html)
    expect(order).toEqual(['Mistral API', 'Cohere API'])
    expect(order).not.toContain('Groq Cloud')
  })
})

// #1328 - `api/is-down.ts` is the only thing that carries `progress` from the worker payload into
// `aiInsights`, and it does so by a wholesale spread (`{ ...a, ... }`). `is-down-render.test.ts` calls
// `renderPage` directly and never touches this file, so replacing that spread with a hand-picked
// object would drop the feature in production with every render test still green - the repo's
// documented "tested twin vs called path" seam. Handler-level, so the wiring is what is pinned.
describe('is-down.ts - the handler carries the analysis prose halves (#1328)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  beforeEach(() => { fetchMock = vi.spyOn(globalThis, 'fetch') })
  afterEach(() => { fetchMock.mockRestore() })

  const DURABLE = 'Auth overload caused login failures.'
  const PERISHABLE = 'Currently identified and rolling out a fix.'

  function makeWorker(opts: { resolved: boolean; progress?: string }): Response {
    const now = new Date().toISOString()
    const startedAt = new Date(Date.now() - 164 * 60000).toISOString()
    const inc = opts.resolved
      ? { id: 'cl-3', title: 'Login Issues', status: 'resolved', impact: 'major', startedAt, resolvedAt: now, duration: '2h 44m', timeline: [] }
      : { id: 'cl-3', title: 'Login Issues', status: 'identified', impact: 'major', startedAt, duration: null, timeline: [] }
    return new Response(JSON.stringify({
      services: [{
        id: 'claude', name: 'Claude API', category: 'api', status: opts.resolved ? 'operational' : 'down',
        latency: 145, uptime30d: 99.9, lastChecked: now, aiwatchScore: 92, scoreGrade: 'excellent', scoreConfidence: 'high',
        incidents: [inc],
      }],
      aiAnalysis: { claude: [{
        summary: DURABLE,
        ...(opts.progress ? { progress: opts.progress } : {}),
        estimatedRecovery: '30m-1h', estimatedRecoveryHours: 1, affectedScope: ['Login'],
        needsFallback: false, analyzedAt: new Date(Date.now() - 30 * 60000).toISOString(),
        incidentId: 'cl-3', ...(opts.resolved ? { resolvedAt: now } : {}),
      }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  it('a LIVE page shows the progress half - so the field survives the handler', async () => {
    fetchMock.mockResolvedValueOnce(makeWorker({ resolved: false, progress: PERISHABLE }))
    const html = await (await handler(makeReq('claude-api'))).text()
    expect(html).toContain(DURABLE)
    expect(html).toContain(PERISHABLE)
  })

  it('a RESOLVED page drops it - the defect this issue is about, end to end', async () => {
    fetchMock.mockResolvedValueOnce(makeWorker({ resolved: true, progress: PERISHABLE }))
    const html = await (await handler(makeReq('claude-api'))).text()
    expect(html).toContain(DURABLE)
    expect(html).not.toContain(PERISHABLE)
  })

  it('a pre-split payload appends no stray separator on either state', async () => {
    // NOT `not.toContain('undefined')`: `esc()` returns '' for null, so that string can never reach
    // this HTML and the assertion was structurally incapable of failing — it stayed green under
    // every mutation of the guard it was meant to watch. The reachable artifact is a trailing space.
    // Scoped to the CARD paragraph, not the page: the summary also appears in the meta/share text,
    // where a following space is normal — `not.toContain(DURABLE + ' ')` fails on the healthy page.
    // `DURABLE + '</p>'` says the paragraph ends immediately after the summary, which is exactly the
    // stray-separator defect. (`undefined` is unassertable here: `esc()` returns '' for null.)
    fetchMock.mockResolvedValueOnce(makeWorker({ resolved: false }))
    expect(await (await handler(makeReq('claude-api'))).text()).toContain(DURABLE + '</p>')
    fetchMock.mockResolvedValueOnce(makeWorker({ resolved: true }))
    expect(await (await handler(makeReq('claude-api'))).text()).toContain(DURABLE + '</p>')
  })
})

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

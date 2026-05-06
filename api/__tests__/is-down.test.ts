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
    const res = await handler(makeReq('claude'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300')
  })

  it('returns 503 + no-store when Worker fetch is rejected (timeout / network failure)', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    const res = await handler(makeReq('claude'))
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/)
    expect(res.headers.get('Cache-Control')).toMatch(/must-revalidate/)
  })

  it('returns 503 + no-store when Worker returns a non-2xx HTTP status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream error', { status: 502 }))
    const res = await handler(makeReq('claude'))
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/)
  })

  it('returns 503 + no-store when the Worker response is missing the target service', async () => {
    // Worker returned 200 but the slug is not present (deploy gap or KV race) —
    // serviceData stays null, so the fallback render fires too.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ services: [], aiAnalysis: {} }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const res = await handler(makeReq('claude'))
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
    await handler(makeReq('claude'))
    // Worker non-2xx
    fetchMock.mockResolvedValueOnce(new Response('upstream', { status: 502 }))
    await handler(makeReq('openai'))
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
    const res = await handler(makeReq('claude'))
    const cc = res.headers.get('Cache-Control') ?? ''
    expect(cc).toContain('no-store')
    expect(cc).toContain('max-age=0')
    expect(cc).not.toContain('s-maxage')
    expect(cc).not.toContain('stale-while-revalidate')
  })
})

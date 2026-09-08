import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import handler, { toUpstreamPath, reportsAlertSlug } from '../reports'

// Pure-function unit test for the path-stripping logic that maps Vercel
// request paths onto the GH Pages upstream. A regex regression here would
// silently break asset URLs / nested report paths in production, so the
// four documented mappings (#264) are pinned by tests.
describe('toUpstreamPath (#264)', () => {
  it('maps the bare /reports root to /', () => {
    expect(toUpstreamPath('/reports')).toBe('/')
  })

  it('maps /reports/ (trailing slash) to /', () => {
    expect(toUpstreamPath('/reports/')).toBe('/')
  })

  it('strips the /reports prefix from a monthly report path', () => {
    expect(toUpstreamPath('/reports/2026-03/')).toBe('/2026-03/')
  })

  it('strips the prefix from asset paths', () => {
    expect(toUpstreamPath('/reports/assets/main.css')).toBe('/assets/main.css')
  })

  it('handles paths with explicit index.html', () => {
    expect(toUpstreamPath('/reports/2026-03/index.html')).toBe('/2026-03/index.html')
  })

  it('handles deeply nested paths', () => {
    expect(toUpstreamPath('/reports/2026-03/assets/charts/uptime.svg')).toBe(
      '/2026-03/assets/charts/uptime.svg',
    )
  })

  it('preserves a leading slash on the stripped result', () => {
    // Defends against a regex that would strip /reports without preserving the
    // path separator and produce something like 'assets/main.css' (no leading /).
    expect(toUpstreamPath('/reports/anything')).toMatch(/^\//)
  })
})


// #1368 — the reports proxy is the SECOND consumer of the shared Edge-fallback alert, and until now
// it had no coverage at all: deleting either `notifyReportsFallback` call, or mislabelling the
// surface, was green in CI. A green shared module says nothing about a call site
// (`debugging_fix_the_called_path_not_the_tested_twin`).
describe('reportsAlertSlug (#1368)', () => {
  it('falls back to "index" rather than an empty slug the Worker would reject', () => {
    // Defensive: every routed path starts with `/reports`, so this is not reached by a live request.
    // Pinned anyway because an empty `slug` is a Worker 400, and the guard is one `||` from removal.
    expect(reportsAlertSlug('/')).toBe('index')
    expect(reportsAlertSlug('')).toBe('index')
  })

  it('collapses slashes to dashes rather than stripping them', () => {
    // The Worker's own sanitizer STRIPS slashes; if this collapse were dropped the dedup key would
    // silently change from `reports-2026-03` to `reports2026-03` with no error anywhere.
    expect(reportsAlertSlug('/reports/2026-03/')).toBe('reports-2026-03')
  })

  it('lowercases and drops characters outside the allowed set', () => {
    expect(reportsAlertSlug('/Reports/2026-03/Index.HTML?x=1')).toBe('reports-2026-03-indexhtmlx1')
  })

  it('caps the length', () => {
    expect(reportsAlertSlug('/' + 'a'.repeat(200)).length).toBe(64)
  })
})

describe('reports proxy fires the Edge-fallback alert (#1368, #378)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  const alerts: Array<{ surface: string; slug: string; reason: string }> = []

  beforeEach(() => {
    alerts.length = 0
    process.env.EDGE_ALERT_TOKEN = 'test-token'
    process.env.VERCEL_ENV = 'production'
    fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockImplementation(async (url, init) => {
      if (typeof url === 'string' && url.includes('/api/internal/edge-fallback')) {
        alerts.push(JSON.parse((init?.body as string) ?? '{}'))
        return new Response(null, { status: 200 })
      }
      throw new Error('upstream unreachable')
    })
  })

  afterEach(() => {
    fetchMock.mockRestore()
    delete process.env.EDGE_ALERT_TOKEN
    delete process.env.VERCEL_ENV
  })

  const get = (path: string) => handler(new Request(`https://ai-watch.dev${path}`, { method: 'GET' }))

  it('alerts with surface "reports" and the sanitized path when the upstream is unreachable', async () => {
    const res = await get('/reports/2026-03/')
    expect(res.status).toBe(502)
    // surface AND slug are asserted, not just reason: the Worker keys its 5-minute dedup on the pair,
    // so a mislabelled surface would collide the reports window with a service slug space.
    expect(alerts).toEqual([{ surface: 'reports', slug: 'reports-2026-03', reason: 'upstream_unreachable' }])
  })

  it('labels a real upstream TIMEOUT as upstream_timeout, using the name the runtime emits', async () => {
    // #1368 — the `reason` field is the whole value of this alert to an operator, so the timeout
    // label has to survive the name `AbortSignal.timeout()` rejects with.
    fetchMock.mockImplementation(async (url, init) => {
      if (typeof url === 'string' && url.includes('/api/internal/edge-fallback')) {
        alerts.push(JSON.parse((init?.body as string) ?? '{}'))
        return new Response(null, { status: 200 })
      }
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    })

    await get('/reports/2026-03/')

    expect(alerts).toEqual([{ surface: 'reports', slug: 'reports-2026-03', reason: 'upstream_timeout' }])
  })

  it('alerts with the status-bearing reason when the upstream returns 5xx', async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (typeof url === 'string' && url.includes('/api/internal/edge-fallback')) {
        alerts.push(JSON.parse((init?.body as string) ?? '{}'))
        return new Response(null, { status: 200 })
      }
      return new Response('upstream boom', { status: 503, headers: { 'content-type': 'text/html' } })
    })

    await get('/reports/2026-03/')

    // A separate call site from the catch above: an upstream that ANSWERS with a 5xx never throws,
    // so the catch path cannot see it — and that is what a sustained GitHub Pages outage looks like.
    expect(alerts).toEqual([{ surface: 'reports', slug: 'reports-2026-03', reason: 'upstream_503' }])
  })
})

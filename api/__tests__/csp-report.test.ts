import { describe, it, expect, vi } from 'vitest'
import { parseCspReports, summarizeCspReport } from '../csp-report'

// #482 Phase 1 — the CSP violation sink must normalize BOTH wire formats a browser may send:
// the legacy `report-uri` ({ "csp-report": {...} }, kebab-case) and the modern `report-to`
// ([{ type, body:{...} }], camelCase). A garbage/non-JSON body must degrade to [] (never throw —
// the handler 204s regardless), so a malformed beacon can't error the Edge function.

describe('parseCspReports', () => {
  it('parses the report-uri shape ({ "csp-report": {...} })', () => {
    const body = JSON.stringify({
      'csp-report': {
        'document-uri': 'https://ai-watch.dev/is-claude-down',
        'violated-directive': "script-src-elem",
        'blocked-uri': 'inline',
      },
    })
    const out = parseCspReports(body)
    expect(out).toHaveLength(1)
    expect(out[0]['violated-directive']).toBe('script-src-elem')
  })

  it('parses the report-to array shape ([{ type, body }])', () => {
    const body = JSON.stringify([
      { type: 'csp-violation', age: 0, body: { effectiveDirective: 'script-src', blockedURL: 'inline' } },
      { type: 'other', body: { foo: 1 } }, // non-CSP report types are still unwrapped (body kept), filtered only by absence of body
    ])
    const out = parseCspReports(body)
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out[0].effectiveDirective).toBe('script-src')
  })

  it('returns [] for non-JSON / garbage / empty (never throws)', () => {
    expect(parseCspReports('not json')).toEqual([])
    expect(parseCspReports('')).toEqual([])
    expect(parseCspReports('null')).toEqual([])
    expect(parseCspReports('42')).toEqual([])
  })

  it('returns [] when csp-report key holds a non-object', () => {
    expect(parseCspReports(JSON.stringify({ 'csp-report': 'nope' }))).toEqual([])
  })
})

describe('summarizeCspReport', () => {
  it('summarizes the kebab-case (report-uri) fields with source location', () => {
    const s = summarizeCspReport({
      'document-uri': 'https://ai-watch.dev/intro',
      'violated-directive': 'script-src',
      'blocked-uri': 'inline',
      'source-file': 'https://ai-watch.dev/intro',
      'line-number': 1076,
    })
    expect(s).toContain('directive=script-src')
    expect(s).toContain('blocked=inline')
    expect(s).toContain('doc=https://ai-watch.dev/intro')
    expect(s).toContain('src=https://ai-watch.dev/intro:1076')
  })

  it('summarizes the camelCase (report-to) fields and omits source when absent', () => {
    const s = summarizeCspReport({
      documentURL: 'https://ai-watch.dev/',
      effectiveDirective: 'connect-src',
      blockedURL: 'https://evil.example/x',
    })
    expect(s).toBe('directive=connect-src blocked=https://evil.example/x doc=https://ai-watch.dev/')
  })

  it('falls back to ? for missing fields', () => {
    expect(summarizeCspReport({})).toBe('directive=? blocked=? doc=?')
  })
})

// #2026 — the sink forwards each report to the worker, which keeps it past the log window.
describe('forwardCspReports (#2026)', async () => {
  const { forwardCspReports, toViolationRecord, default: handler } = await import('../csp-report')

  it('names the same directive as the log line when a report carries both directive fields', () => {
    const r = { 'violated-directive': 'script-src', 'effective-directive': 'script-src-elem', 'blocked-uri': 'inline', 'document-uri': 'https://ai-watch.dev/intro' }
    expect(summarizeCspReport(r)).toContain(`directive=${toViolationRecord(r).directive} `)
  })

  it('maps both wire formats onto the record the worker parses', () => {
    expect(toViolationRecord({ 'violated-directive': 'connect-src https://x', 'blocked-uri': 'https://www.google.com/g/collect', 'document-uri': 'https://ai-watch.dev/intro' }))
      .toEqual({ directive: 'connect-src', blocked: 'https://www.google.com/g/collect', page: 'https://ai-watch.dev/intro' })
    expect(toViolationRecord({ effectiveDirective: 'img-src', blockedURL: 'https://a.com/p.gif', documentURL: 'https://ai-watch.dev/' }))
      .toEqual({ directive: 'img-src', blocked: 'https://a.com/p.gif', page: 'https://ai-watch.dev/' })
  })

  it('posts one record per report to the worker chosen by the request host, carrying the page origin', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const req = new Request('https://ai-watch.dev/api/csp-report', { method: 'POST', headers: { Origin: 'https://ai-watch.dev' } })
    await forwardCspReports([{ effectiveDirective: 'connect-src', blockedURL: 'https://x.com/' }, { effectiveDirective: 'img-src', blockedURL: 'data' }], req, fetchImpl)
    const calls = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls.map((c) => c[0])).toEqual(['https://aiwatch-worker.p2c2kbf.workers.dev/api/csp-violation', 'https://aiwatch-worker.p2c2kbf.workers.dev/api/csp-violation'])
    expect((calls[0][1].headers as Record<string, string>).Origin).toBe('https://ai-watch.dev')
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ directive: 'connect-src', blocked: 'https://x.com/', page: '' })
  })

  it('a worker failure does not change the 204', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'))
    const res = await handler(new Request('https://ai-watch.dev/api/csp-report', {
      method: 'POST', body: JSON.stringify({ 'csp-report': { 'violated-directive': 'connect-src', 'blocked-uri': 'https://x.com' } }),
    }))
    expect(res.status).toBe(204)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})

describe('forwarding is bounded and reports its failures (#2026)', async () => {
  const { forwardCspReports, forwardableRecords, MAX_FORWARDED } = await import('../csp-report')
  const req = new Request('https://ai-watch.dev/api/csp-report', { method: 'POST', headers: { Origin: 'null' } })

  it('drops duplicates and caps one POST', () => {
    const same = Array.from({ length: 50 }, () => ({ effectiveDirective: 'connect-src', blockedURL: 'https://x.com/' }))
    expect(forwardableRecords(same)).toHaveLength(1)
    const distinct = Array.from({ length: 5000 }, (_, i) => ({ effectiveDirective: 'connect-src', blockedURL: `https://h${i}.com/` }))
    expect(forwardableRecords(distinct)).toHaveLength(MAX_FORWARDED)
  })

  it('an opaque `null` Origin falls back to the request origin', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    await forwardCspReports([{ effectiveDirective: 'img-src', blockedURL: 'data' }], req, fetchImpl)
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1]
    expect((init.headers as Record<string, string>).Origin).toBe('https://ai-watch.dev')
  })

  it('counts and logs refused or failed forwards', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let n = 0
    const fetchImpl = vi.fn(async () => (n++ === 0 ? new Response(null, { status: 403 }) : Promise.reject(new Error('timeout')))) as unknown as typeof fetch
    const failed = await forwardCspReports([{ effectiveDirective: 'a-b', blockedURL: 'https://1.com' }, { effectiveDirective: 'a-b', blockedURL: 'https://2.com' }], req, fetchImpl)
    expect(failed).toBe(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2/2 forwards to the worker failed (HTTP 403)'))
    warn.mockRestore()
  })
})

describe('a Preview does not forward (#2026)', async () => {
  const { forwardCspReports, forwardsFrom } = await import('../csp-report')
  it.each([
    ['https://ai-watch.dev/api/csp-report', true],
    ['http://localhost:3333/api/csp-report', true],
    ['http://127.0.0.1:3333/api/csp-report', true],
    ['https://aiwatch-git-fix-x-bentleys-projects.vercel.app/api/csp-report', false],
    ['https://www.ai-watch.dev/api/csp-report', false],
  ])('%s → %s', (url, want) => {
    expect(forwardsFrom(url)).toBe(want)
  })
  it('a `vercel dev` request goes to the local worker, never the production one', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const req = new Request('http://localhost:3333/api/csp-report', { method: 'POST' })
    await forwardCspReports([{ effectiveDirective: 'connect-src', blockedURL: 'https://x.com' }], req, fetchImpl)
    expect((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]).toBe('http://localhost:8788/api/csp-violation')
  })

  it('sends nothing from a Preview host', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const req = new Request('https://aiwatch-git-fix-x-bentleys-projects.vercel.app/api/csp-report', { method: 'POST' })
    expect(await forwardCspReports([{ effectiveDirective: 'connect-src', blockedURL: 'https://x.com' }], req, fetchImpl)).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi } from 'vitest'
import workerModule from '../index'
import {
  blockedTarget, pagePath, parseCspViolationBody, recordCspViolation, buildCspViolationSql,
  parseCspViolationResponse, queryCspViolations, formatCspViolationLine, CSP_VIOLATION_INDEX,
} from '../csp-violation'

describe('blockedTarget (#2026)', () => {
  it.each([
    ['https://www.google.com/g/collect?v=2&tid=G-X&cid=123', 'www.google.com'],
    ['https://API.github.com/repos/x', 'api.github.com'],
    ['wss://live.example.com:8443/s', 'live.example.com:8443'],
    ['inline', 'inline'],
    ['eval', 'eval'],
    ['data:image/png;base64,AAAA', 'data'],
    ['blob:https://ai-watch.dev/uuid', 'blob'],
    ['', ''],
    [42, ''],
    ['not a url with spaces', ''],
  ])('%s → %s', (raw, want) => {
    expect(blockedTarget(raw)).toBe(want)
  })
})

describe('pagePath', () => {
  it('keeps the path only — the query can carry anything', () => {
    expect(pagePath('https://ai-watch.dev/is-claude-down?e=abc&utm_source=x#top')).toBe('/is-claude-down')
    expect(pagePath('garbage')).toBe('')
  })
})

describe('parseCspViolationBody', () => {
  it('accepts a forwarded record', () => {
    expect(parseCspViolationBody({ directive: 'connect-src', blocked: 'https://www.google.com/g/collect?x=1', page: 'https://ai-watch.dev/intro?a=1' }))
      .toEqual({ directive: 'connect-src', blocked: 'www.google.com', page: '/intro' })
  })
  it.each([
    [null], ['x'], [{}], [{ directive: 'connect-src' }], [{ directive: 'Connect Src!', blocked: 'inline' }],
    [{ directive: 'connect-src', blocked: '' }],
  ])('rejects %o', (body) => {
    expect(parseCspViolationBody(body)).toBeNull()
  })
})

describe('recordCspViolation', () => {
  it('writes one point under its own index', () => {
    const writeDataPoint = vi.fn()
    recordCspViolation({ writeDataPoint } as unknown as AnalyticsEngineDataset, { directive: 'connect-src', blocked: 'www.google.com', page: '/intro' })
    expect(writeDataPoint).toHaveBeenCalledWith({ blobs: ['connect-src', 'www.google.com', '/intro'], doubles: [1], indexes: [CSP_VIOLATION_INDEX] })
  })
  it('no binding → no throw', () => {
    expect(() => recordCspViolation(undefined, { directive: 'a-b', blocked: 'x', page: '' })).not.toThrow()
  })
})

describe('daily read', () => {
  it('reads the last day of its own index, weighted by the sample interval', () => {
    const sql = buildCspViolationSql('ds')
    expect(sql).toContain(`index1 = '${CSP_VIOLATION_INDEX}'`)
    expect(sql).toContain('SUM(_sample_interval)')
    expect(sql).toContain("INTERVAL '1' DAY")
  })

  it('sums and orders rows; drops zero rows; null on a malformed response', () => {
    const counts = parseCspViolationResponse({ data: [
      { directive: 'connect-src', blocked: 'api.github.com', n: '2' },
      { directive: 'connect-src', blocked: 'www.google.com', n: 9 },
      { directive: 'img-src', blocked: 'x.com', n: 0 },
    ] })
    expect(counts).toEqual({ total: 11, rows: [
      { directive: 'connect-src', blocked: 'www.google.com', n: 9 },
      { directive: 'connect-src', blocked: 'api.github.com', n: 2 },
    ] })
    expect(parseCspViolationResponse({})).toBeNull()
  })

  it('returns null without credentials and on an HTTP error, so the line is omitted', async () => {
    expect(await queryCspViolations(undefined, 't')).toBeNull()
    const fail = vi.fn(async () => new Response('no', { status: 500 })) as unknown as typeof fetch
    expect(await queryCspViolations('acct', 't', fail)).toBeNull()
    const ok = vi.fn(async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch
    expect(await queryCspViolations('acct', 't', ok)).toEqual({ total: 0, rows: [] })
  })
})

describe('formatCspViolationLine', () => {
  it('omits the line when the read failed, prints 0 when nothing was blocked', () => {
    expect(formatCspViolationLine(null)).toBe('')
    expect(formatCspViolationLine({ total: 0, rows: [] })).toBe('🛡️ **CSP Violations** (24h): 0')
  })
  it('names the top three and counts the rest', () => {
    const rows = [5, 4, 3, 2, 1].map((n, i) => ({ directive: 'connect-src', blocked: `h${i}.com`, n }))
    expect(formatCspViolationLine({ total: 15, rows })).toBe(
      '🛡️ **CSP Violations** (24h): 15 — connect-src h0.com ×5 · connect-src h1.com ×4 · connect-src h2.com ×3 · +2 more',
    )
  })
})

describe('POST /api/csp-violation → WAE', () => {
  const ORIGIN = 'https://ai-watch.dev'
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  const makeEnv = () => {
    const writeDataPoint = vi.fn()
    return { writeDataPoint, env: { ALLOWED_ORIGIN: ORIGIN, ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset } as never }
  }
  const post = (body: unknown, origin = ORIGIN) => new Request('https://worker.example/api/csp-violation', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  })

  it('records the forwarded violation', async () => {
    const { env, writeDataPoint } = makeEnv()
    const res = await workerModule.fetch(post({ directive: 'connect-src', blocked: 'https://www.google.com/g/collect?x', page: 'https://ai-watch.dev/intro' }), env, ctx)
    expect(res.status).toBe(204)
    expect(writeDataPoint.mock.calls[0][0]).toEqual({ blobs: ['connect-src', 'www.google.com', '/intro'], doubles: [1], indexes: [CSP_VIOLATION_INDEX] })
  })

  it('rejects a foreign origin, an unusable body and non-JSON without recording', async () => {
    const { env, writeDataPoint } = makeEnv()
    expect((await workerModule.fetch(post({ directive: 'connect-src', blocked: 'inline' }, 'https://evil.example'), env, ctx)).status).toBe(403)
    expect((await workerModule.fetch(post({ directive: 'connect-src' }), env, ctx)).status).toBe(400)
    expect((await workerModule.fetch(post('{nope'), env, ctx)).status).toBe(400)
    expect(writeDataPoint).not.toHaveBeenCalled()
  })
})

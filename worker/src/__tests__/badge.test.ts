import { describe, it, expect, vi } from 'vitest'
import { generateBadgeSvg, escapeXml } from '../badge'
import workerModule from '../index'
import { BADGE_UNKNOWN_SERVICE } from '../api-traffic'
import type { ServiceStatus } from '../types'

describe('escapeXml', () => {
  it('escapes & < > "', () => {
    expect(escapeXml('a&b')).toBe('a&amp;b')
    expect(escapeXml('<script>')).toBe('&lt;script&gt;')
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;')
  })

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('')
  })

  it('passes through safe text', () => {
    expect(escapeXml('Claude API')).toBe('Claude API')
  })
})

describe('generateBadgeSvg', () => {
  it('generates valid SVG with label and status', () => {
    const svg = generateBadgeSvg('Claude API', 'operational', '#3fb950', 'flat')
    expect(svg).toContain('<svg')
    expect(svg).toContain('Claude API')
    expect(svg).toContain('operational')
    expect(svg).toContain('fill="#3fb950"')
    expect(svg).toContain('rx="3"') // flat style = rounded
  })

  it('uses rx=0 for flat-square style', () => {
    const svg = generateBadgeSvg('Test', 'up', '#3fb950', 'flat-square')
    expect(svg).toContain('rx="0"')
  })

  it('escapes XSS in label', () => {
    const svg = generateBadgeSvg('<script>alert(1)</script>', 'ok', '#3fb950', 'flat')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })

  it('escapes XSS in status', () => {
    const svg = generateBadgeSvg('Test', '"><img onerror=alert(1)>', '#3fb950', 'flat')
    // The < and > and " are escaped, so the img tag cannot be parsed as HTML
    expect(svg).not.toContain('<img')
    expect(svg).toContain('&lt;img')
    expect(svg).toContain('&quot;&gt;')
  })

  it('sanitizes invalid color to fallback gray', () => {
    const svg = generateBadgeSvg('Test', 'ok', 'javascript:alert(1)', 'flat')
    expect(svg).toContain('fill="#9e9e9e"')
    expect(svg).not.toContain('javascript')
  })

  it('accepts valid hex colors', () => {
    expect(generateBadgeSvg('T', 'ok', '#fff', 'flat')).toContain('fill="#fff"')
    expect(generateBadgeSvg('T', 'ok', '#3fb950', 'flat')).toContain('fill="#3fb950"')
    expect(generateBadgeSvg('T', 'ok', '#FF5733AA', 'flat')).toContain('fill="#FF5733AA"')
  })

  it('includes aria-label and title for accessibility', () => {
    const svg = generateBadgeSvg('Claude API', 'down', '#f85149', 'flat')
    expect(svg).toContain('aria-label="Claude API: down"')
    expect(svg).toContain('<title>Claude API: down</title>')
  })

  it('calculates width based on text length', () => {
    const short = generateBadgeSvg('A', 'B', '#fff', 'flat')
    const long = generateBadgeSvg('Very Long Service Name', 'operational', '#fff', 'flat')
    const shortWidth = parseInt(short.match(/width="(\d+)"/)?.[1] ?? '0')
    const longWidth = parseInt(long.match(/width="(\d+)"/)?.[1] ?? '0')
    expect(longWidth).toBeGreaterThan(shortWidth)
  })
})

// #1157 — the unit tests above pin generateBadgeSvg/escapeXml; this drives the REAL /badge/:serviceId
// handler and asserts recordBadgeTraffic actually fires on the 200/404 branches (and NOT on 400) with
// the right blob1 value. Without this, a future edit that drops or misplaces a `recordBadgeTraffic`
// call (or a `service.id`/`serviceId`/`BADGE_UNKNOWN_SERVICE` mix-up) would leave every api-traffic.test.ts
// test green, because those call recordBadgeTraffic directly rather than through the route — the same
// "tested twin" gap #1068's service-groups-sync.test.ts exists to close.
describe('/badge/:serviceId records WAE traffic on the real handler (#1157)', () => {
  const CACHE_KEY = 'services:latest'
  const svc = (id: string): ServiceStatus => ({
    id, name: id, provider: id, category: 'api', status: 'operational',
    latency: null, uptime30d: 99.9, lastChecked: '2026-07-19T00:00:00Z', incidents: [],
  } as unknown as ServiceStatus)

  function makeEnv(writeDataPoint = vi.fn()) {
    const store = new Map<string, string>()
    store.set(CACHE_KEY, JSON.stringify({ services: [svc('claude')], cachedAt: '2026-07-19T00:00:00Z' }))
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
    } as unknown as KVNamespace
    return {
      env: { STATUS_CACHE: kv, ANALYTICS: { writeDataPoint } } as unknown as Parameters<typeof workerModule.fetch>[1],
      writeDataPoint,
    }
  }

  it('records the real serviceId on a 200 (known service)', async () => {
    const { env, writeDataPoint } = makeEnv()
    const res = await workerModule.fetch(new Request('https://ai-watch.dev/badge/claude'), env, {} as ExecutionContext)
    expect(res.status).toBe(200)
    expect(writeDataPoint).toHaveBeenCalledOnce()
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({ blobs: ['claude'], indexes: ['badge-request'] }))
  })

  it('records the BADGE_UNKNOWN_SERVICE sentinel on a 404 (unknown service), not the raw id', async () => {
    const { env, writeDataPoint } = makeEnv()
    const res = await workerModule.fetch(new Request('https://ai-watch.dev/badge/totally-made-up-svc'), env, {} as ExecutionContext)
    expect(res.status).toBe(404)
    expect(writeDataPoint).toHaveBeenCalledOnce()
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({ blobs: [BADGE_UNKNOWN_SERVICE] }))
  })

  it('collapses a differently-cased miss into the SAME sentinel bucket, not its own blob1 value', async () => {
    const { env, writeDataPoint } = makeEnv()
    // Case-insensitive validation + case-sensitive lookup means this 404s (not a 200) — the case that
    // used to fragment the metric into a per-casing blob1 value before the sentinel fix.
    const res = await workerModule.fetch(new Request('https://ai-watch.dev/badge/Claude'), env, {} as ExecutionContext)
    expect(res.status).toBe(404)
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({ blobs: [BADGE_UNKNOWN_SERVICE] }))
  })

  it('does NOT record on a 400 (invalid id — never a meaningful embed signal)', async () => {
    const { env, writeDataPoint } = makeEnv()
    const res = await workerModule.fetch(new Request('https://ai-watch.dev/badge/bad$id'), env, {} as ExecutionContext)
    expect(res.status).toBe(400)
    expect(writeDataPoint).not.toHaveBeenCalled()
  })

  it('is a no-op (no throw) when ANALYTICS is absent (local dev)', async () => {
    const store = new Map<string, string>()
    store.set(CACHE_KEY, JSON.stringify({ services: [svc('claude')], cachedAt: '2026-07-19T00:00:00Z' }))
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async () => {}, delete: async () => {},
    } as unknown as KVNamespace
    const env = { STATUS_CACHE: kv, ANALYTICS: undefined } as unknown as Parameters<typeof workerModule.fetch>[1]
    const res = await workerModule.fetch(new Request('https://ai-watch.dev/badge/claude'), env, {} as ExecutionContext)
    expect(res.status).toBe(200)
  })
})

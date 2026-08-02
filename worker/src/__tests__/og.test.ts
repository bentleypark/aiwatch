import { describe, it, expect } from 'vitest'
import { generateOgSvg } from '../og'
import workerModule from '../index'

describe('generateOgSvg', () => {
  it('generates valid SVG with service name and status', () => {
    const svg = generateOgSvg('Claude API', 'operational', '90', '99.28')
    expect(svg).toContain('<svg')
    expect(svg).toContain('Is Claude API Down?')
    expect(svg).toContain('Operational')
    expect(svg).toContain('#3fb950') // green
    expect(svg).toContain('Score:')
    expect(svg).toContain('90')
    expect(svg).toContain('Uptime:')
    expect(svg).toContain('99.28%')
  })

  it('uses degraded style for degraded status', () => {
    const svg = generateOgSvg('OpenAI', 'degraded', '', '')
    expect(svg).toContain('Degraded')
    expect(svg).toContain('#e86235') // amber
  })

  it('uses down style for down status', () => {
    const svg = generateOgSvg('Gemini', 'down', '', '')
    expect(svg).toContain('Down')
    expect(svg).toContain('#f85149') // red
  })

  it('falls back to operational for unknown status', () => {
    const svg = generateOgSvg('Test', 'maintenance', '', '')
    expect(svg).toContain('Operational')
    expect(svg).toContain('#3fb950')
  })

  it('omits metrics when score and uptime are empty', () => {
    const svg = generateOgSvg('Claude', 'operational', '', '')
    expect(svg).not.toContain('Score:')
    expect(svg).not.toContain('Uptime:')
  })

  it('escapes XSS in service name', () => {
    const svg = generateOgSvg('<script>alert(1)</script>', 'down', '', '')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })

  it('escapes special characters in score and uptime', () => {
    const svg = generateOgSvg('Test', 'operational', '9"0', '99&5')
    expect(svg).toContain('9&quot;0')
    expect(svg).toContain('99&amp;5%')
  })

  it('truncates long service names', () => {
    const longName = 'A'.repeat(100)
    const svg = generateOgSvg(longName, 'operational', '', '')
    // generateOgSvg slices to 50 chars
    expect(svg).toContain('A'.repeat(50))
    expect(svg).not.toContain('A'.repeat(51))
  })
})

// #1196 — /api/og used to match GET only, so a HEAD request fell through to the router's generic
// 404 handler (found live: `curl -I` against production returned 404 with a mismatched
// content-type/body, while the identical GET succeeded). Not confirmed as the root cause of the
// unfurl report that surfaced it (that turned out to be a transient X-side retry), but a real,
// independently-worth-fixing gap: some link-preview crawlers/validators probe with HEAD before a GET.
describe('GET/HEAD /api/og route (worker/src/index.ts)', () => {
  const env = {} as unknown as Parameters<typeof workerModule.fetch>[1]
  const ctx = {} as ExecutionContext

  it('GET returns an image (PNG, or the SVG fallback if the WASM renderer is unavailable in this env) with a real body', async () => {
    const res = await workerModule.fetch(new Request('https://ai-watch.dev/api/og?service=Claude&status=degraded'), env, ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/^image\/(png|svg\+xml)$/)
    const body = await res.arrayBuffer()
    expect(body.byteLength).toBeGreaterThan(0)
  })

  it('HEAD returns the SAME headers as GET, but an empty body', async () => {
    const [getRes, headRes] = await Promise.all([
      workerModule.fetch(new Request('https://ai-watch.dev/api/og?service=Claude&status=degraded'), env, ctx),
      workerModule.fetch(new Request('https://ai-watch.dev/api/og?service=Claude&status=degraded', { method: 'HEAD' }), env, ctx),
    ])
    expect(headRes.status).toBe(200)
    expect(headRes.headers.get('Content-Type')).toBe(getRes.headers.get('Content-Type'))
    expect(headRes.headers.get('Cache-Control')).toBe(getRes.headers.get('Cache-Control'))
    const headBody = await headRes.arrayBuffer()
    expect(headBody.byteLength).toBe(0)
  })

  it('a non-GET/HEAD method still 404s (no over-widening to POST/PUT/etc.)', async () => {
    const res = await workerModule.fetch(new Request('https://ai-watch.dev/api/og?service=Claude', { method: 'POST' }), env, ctx)
    expect(res.status).not.toBe(200)
  })
})

// #1725 — the inline is-down mirror of the worker's meetsRequiredCapability: Perplexity's alternatives are
// search-capable providers only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import handler from '../is-down'
import { spyFetchWithEmptyReportFeed } from './fetch-stub'

const req = (slug: string) => new Request(`https://ai-watch.dev/api/is-down?slug=${slug}`, { method: 'GET' })
const now = () => new Date().toISOString()
const svc = (id: string, name: string, status: string, score: number, extra: Record<string, unknown> = {}) => ({
  id, name, category: 'api', status, latency: 200, uptime30d: 99.9, lastChecked: now(), aiwatchScore: score, scoreGrade: 'good', scoreConfidence: 'high',
  incidents: status === 'operational' ? [] : [{ id: `${id}-i`, title: 'Degraded', status: 'investigating', impact: 'minor', startedAt: now(), duration: null, timeline: [] }],
  ...extra,
})
const board = (overrides: Record<string, string> = {}) => [
  svc('perplexity', 'Perplexity', 'down', 80),
  svc('cohere', 'Cohere API', overrides.cohere ?? 'operational', 95),
  svc('groq', 'Groq Cloud', overrides.groq ?? 'operational', 94),
  svc('claude', 'Claude API', overrides.claude ?? 'operational', 70),
  svc('gemini', 'Gemini API', overrides.gemini ?? 'operational', 60),
]
const payload = (services: ReturnType<typeof svc>[]) => new Response(JSON.stringify({
  services,
  aiAnalysis: { perplexity: [{ summary: 'S.', estimatedRecovery: '1h', affectedScope: ['API'], needsFallback: true, analyzedAt: now(), incidentId: 'perplexity-i' }] },
}), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('is-down.ts — required capability (#1725)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  beforeEach(() => { fetchMock = spyFetchWithEmptyReportFeed() })
  afterEach(() => { fetchMock.mockRestore() })

  it('Perplexity down → the card names search providers, not Cohere or Groq; the FAQ answer stays as written', async () => {
    fetchMock.mockResolvedValueOnce(payload(board()))
    const html = await (await handler(req('perplexity'))).text()
    const start = html.indexOf('🔄 Alternatives')
    expect(start).toBeGreaterThan(-1)
    const card = html.slice(start, html.indexOf('class="faq', start))
    expect(card).toContain('Claude API')
    expect(card).toContain('Gemini API')
    expect(card).not.toContain('Cohere')
    expect(card).not.toContain('Groq')
    expect(html).not.toContain('top-ranked alternative')
    expect(html).toContain('For search-grounded answers over an API, the OpenAI, Claude, and Gemini APIs offer web search.')
  })

  it('no operational search provider → no alternatives card, never Cohere or Groq', async () => {
    fetchMock.mockResolvedValueOnce(payload(board({ claude: 'down', gemini: 'down' })))
    const html = await (await handler(req('perplexity'))).text()
    expect(html).not.toContain('🔄 Alternatives')
    expect(html).not.toContain('Score: 95')
    expect(html).not.toContain('Score: 94')
  })
})

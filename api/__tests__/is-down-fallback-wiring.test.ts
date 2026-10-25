// #1191 — the is-down Alternatives card through the handler: routing (#1062 facet B / #1119), facet C,
// and the #859 same-tier cap. These were pinned only by source-text matches against an inline copy.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import handler from '../is-down'
import { spyFetchWithEmptyReportFeed } from './fetch-stub'

const req = (slug: string) => new Request(`https://ai-watch.dev/api/is-down?slug=${slug}`, { method: 'GET' })
const now = () => new Date().toISOString()
const svc = (id: string, name: string, category: string, status: string, score: number, extra: Record<string, unknown> = {}) => ({
  id, name, category, status, latency: 200, uptime30d: 99.9, lastChecked: now(), aiwatchScore: score, scoreGrade: 'good', scoreConfidence: 'high',
  incidents: status === 'operational' ? [] : [{ id: `${id}-i`, title: 'Degraded', status: 'investigating', impact: 'minor', startedAt: now(), duration: null, timeline: [] }],
  ...extra,
})
const peers = [
  svc('openai', 'OpenAI API', 'api', 'operational', 95),
  svc('claude', 'Claude API', 'api', 'operational', 94),
  svc('stability', 'Stability AI', 'api', 'operational', 93),
  svc('bfl', 'Black Forest Labs (FLUX)', 'api', 'operational', 92),
  svc('pinecone', 'Pinecone', 'api', 'operational', 91),
  svc('turbopuffer', 'turbopuffer', 'api', 'operational', 90),
  svc('voyageai', 'Voyage AI', 'api', 'operational', 89),
  svc('claudeai', 'claude.ai', 'app', 'operational', 96),
]
const payload = (target: ReturnType<typeof svc>) => new Response(JSON.stringify({
  services: [target, ...peers.filter((p) => p.id !== target.id)],
  aiAnalysis: { [target.id]: [{ summary: 'S.', estimatedRecovery: '1h', affectedScope: ['API'], needsFallback: true, analyzedAt: now(), incidentId: `${target.id}-i` }] },
}), { status: 200, headers: { 'Content-Type': 'application/json' } })
const alternatives = (html: string) => {
  const start = html.indexOf('🔄 Alternatives')
  return start === -1 ? null : html.slice(start, html.indexOf('<div class="card"', start))
}
const chatgpt = (component: string) => svc('chatgpt', 'ChatGPT', 'app', 'degraded', 90, {
  components: [{ name: 'Conversations', status: 'operational' }, { name: component, status: 'degraded' }],
})

describe('is-down.ts — Alternatives card routing and tier gates', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  beforeEach(() => { fetchMock = spyFetchWithEmptyReportFeed() })
  afterEach(() => { fetchMock.mockRestore() })

  it('#1119 — a ChatGPT image-only outage crosses into the api image tier, without OpenAI API', async () => {
    fetchMock.mockResolvedValueOnce(payload(chatgpt('Image Generation')))
    const alt = alternatives(await (await handler(req('chatgpt'))).text())
    expect(alt).toContain('Stability AI')
    expect(alt).toContain('Black Forest Labs')
    expect(alt).not.toContain('OpenAI API')
    expect(alt).not.toContain('claude.ai')
  })

  it('#1119 — a routed outage is held to the source tier: with FLUX down, OpenAI API does not fill the second slot', async () => {
    const body = JSON.parse(await payload(chatgpt('Image Generation')).text())
    body.services = body.services.map((s: { id: string }) => s.id === 'bfl' ? svc('bfl', 'Black Forest Labs (FLUX)', 'api', 'down', 92) : s)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const alt = alternatives(await (await handler(req('chatgpt'))).text())
    expect(alt).toContain('Stability AI')
    expect(alt).not.toContain('Black Forest Labs')
    expect(alt).not.toContain('OpenAI API')
  })

  it('#1119 — an EXCLUDE_FALLBACK service is dropped before any tier lookup, so it never warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const body = JSON.parse(await payload(chatgpt('Image Generation')).text())
      body.services.push(svc('replicate', 'Replicate', 'api', 'operational', 99))
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      const alt = alternatives(await (await handler(req('chatgpt'))).text())
      expect(alt).toContain('Stability AI')
      expect(warn.mock.calls.filter(c => String(c[0]).includes('"replicate"'))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('#1062 facet B — a secondary capability with no peer tier (Realtime) renders no Alternatives card', async () => {
    fetchMock.mockResolvedValueOnce(payload(svc('openai', 'OpenAI API', 'api', 'degraded', 95, {
      components: [{ name: 'Chat Completions', status: 'operational' }, { name: 'Realtime', status: 'degraded' }],
    })))
    expect(alternatives(await (await handler(req('openai-api'))).text())).toBeNull()
  })

  it('#1062 facet C — a Stability outage lists FLUX first, then OpenAI API as the multimodal provider', async () => {
    fetchMock.mockResolvedValueOnce(payload(svc('stability', 'Stability AI', 'api', 'down', 93)))
    const alt = alternatives(await (await handler(req('stability'))).text())!
    expect(alt.indexOf('Black Forest Labs')).toBeGreaterThan(-1)
    expect(alt.indexOf('OpenAI API')).toBeGreaterThan(alt.indexOf('Black Forest Labs'))
  })

  it('#1725 — a routed Perplexity embeddings outage skips the search-provider requirement', async () => {
    fetchMock.mockResolvedValueOnce(payload(svc('perplexity', 'Perplexity', 'api', 'degraded', 88, {
      components: [{ name: 'API', status: 'operational' }, { name: 'Embeddings', status: 'degraded' }],
    })))
    expect(alternatives(await (await handler(req('perplexity'))).text())).toContain('Voyage AI')
  })

  it('#1119 — a non-routed outage stays inside its own category', async () => {
    const body = JSON.parse(await payload(svc('claudecode', 'Claude Code', 'agent', 'down', 88)).text())
    body.services.push(svc('cursor', 'Cursor', 'agent', 'operational', 87))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const alt = alternatives(await (await handler(req('claude-code'))).text())!
    expect(alt).toContain('Cursor')
    expect(alt).not.toContain('claude.ai')
    expect(alt).not.toContain('OpenAI API')
  })

  it('#859 — a vector outage recommends its own tier only', async () => {
    fetchMock.mockResolvedValueOnce(payload(svc('pinecone', 'Pinecone', 'api', 'down', 91)))
    const alt = alternatives(await (await handler(req('pinecone'))).text())!
    expect(alt).toContain('turbopuffer')
    expect(alt).not.toContain('Voyage AI')
    expect(alt).not.toContain('Claude API')
  })
})

// #880 — `fallbackSuppressed` is the worker's verdict that a service's outage is outside its fallback
// scope (Jina: an s.jina.ai outage is not an embeddings outage). The page still renders the outage, but
// no in-outage 🔄 Alternatives block.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import handler from '../is-down'
import { spyFetchWithEmptyReportFeed } from './fetch-stub'

const req = (slug: string) => new Request(`https://ai-watch.dev/api/is-down?slug=${slug}`, { method: 'GET' })

const payload = (fallbackSuppressed: boolean) => {
  const now = new Date().toISOString()
  return new Response(JSON.stringify({
    services: [
      {
        id: 'jina', name: 'Jina AI', category: 'api', status: 'down', latency: null, uptime30d: 99.9, lastChecked: now,
        aiwatchScore: 80, scoreGrade: 'good', scoreConfidence: 'high', ...(fallbackSuppressed ? { fallbackSuppressed: true } : {}),
        incidents: [{ id: 'i1', title: 'Service outage', status: 'investigating', impact: 'major', startedAt: now, duration: null, timeline: [] }],
      },
      { id: 'voyageai', name: 'Voyage AI', category: 'api', status: 'operational', latency: 200, uptime30d: 99.9, lastChecked: now, incidents: [], aiwatchScore: 85, scoreGrade: 'excellent', scoreConfidence: 'high' },
    ],
    aiAnalysis: { jina: [{ summary: 'Outage summary.', estimatedRecovery: '1h', affectedScope: ['API'], needsFallback: true, analyzedAt: now, incidentId: 'i1' }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('is-down.ts — fallbackSuppressed (#880)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>
  beforeEach(() => { fetchMock = spyFetchWithEmptyReportFeed() })
  afterEach(() => { fetchMock.mockRestore() })

  it('recommends Voyage AI for an in-scope outage', async () => {
    fetchMock.mockResolvedValueOnce(payload(false))
    const html = await (await handler(req('jina'))).text()
    expect((html.match(/🔄 Alternatives/g) ?? []).length).toBe(1)
  })

  it('renders the outage but no in-outage Alternatives block when it is outside the fallback scope', async () => {
    fetchMock.mockResolvedValueOnce(payload(true))
    const html = await (await handler(req('jina'))).text()
    expect(html).toContain('Outage summary.')
    expect(html).not.toContain('🔄 Alternatives')
  })
})

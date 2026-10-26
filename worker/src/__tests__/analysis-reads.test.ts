import { describe, it, expect, vi } from 'vitest'
import { liveAnalysisIncidents, recentlyResolvedIncidents, readStatusAnalyses, RECENT_RECOVERY_MS } from '../analysis-reads'
import type { Incident } from '../types'

const NOW = Date.parse('2026-06-30T12:00:00Z')
const inc = (id: string, o: Partial<Incident> = {}) =>
  ({ id, title: id, status: 'resolved', impact: 'minor', startedAt: '2026-06-30T10:00:00Z', duration: null, timeline: [], ...o }) as Incident
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('liveAnalysisIncidents (#1772)', () => {
  it('keeps ongoing phases and drops monitoring + resolved', () => {
    const list = [inc('a', { status: 'investigating' }), inc('b', { status: 'identified' }), inc('m', { status: 'monitoring' }), inc('r')]
    expect(liveAnalysisIncidents(list).map((i) => i.id)).toEqual(['a', 'b'])
    expect(liveAnalysisIncidents(undefined)).toEqual([])
  })
})

describe('recentlyResolvedIncidents (#1772)', () => {
  const svc = (incidents: Incident[], status = 'operational') => ({ status, incidents })

  it('keeps an incident resolved within the window, inclusive of its edge', () => {
    const out = recentlyResolvedIncidents(svc([inc('in', { resolvedAt: ago(60_000) }), inc('edge', { resolvedAt: ago(RECENT_RECOVERY_MS) }), inc('old', { resolvedAt: ago(RECENT_RECOVERY_MS + 1) })]), false, NOW)
    expect(out.map((i) => i.id)).toEqual(['in', 'edge'])
  })

  it('#1292 — skips a synthesized status_history incident', () => {
    expect(recentlyResolvedIncidents(svc([inc('d', { resolvedAt: ago(60_000), derived: 'status_history' })]), false, NOW)).toEqual([])
  })

  it('skips an incident with no resolvedAt', () => {
    expect(recentlyResolvedIncidents(svc([inc('n', { resolvedAt: null })]), false, NOW)).toEqual([])
  })

  it('returns nothing on a non-operational service, or one with a live analysis', () => {
    const list = [inc('r', { resolvedAt: ago(60_000) })]
    expect(recentlyResolvedIncidents(svc(list, 'degraded'), false, NOW)).toEqual([])
    expect(recentlyResolvedIncidents(svc(list), true, NOW)).toEqual([])
  })
})

describe('readStatusAnalyses (#1772)', () => {
  const kvOf = (store: Record<string, string>) => {
    const get = vi.fn(async (k: string) => store[k] ?? null)
    return { get, kv: { get } as unknown as Pick<KVNamespace, 'get'> }
  }
  const a = (incidentId: string, o: Record<string, unknown> = {}) => JSON.stringify({ summary: 'S', incidentId, ...o })

  it('reads live analyses, then the recently resolved ones of a service with none, with their markers', async () => {
    const { kv } = kvOf({
      'ai:analysis:a:live': a('live'),
      'ai:analysis:a:done': a('done', { resolvedAt: ago(60_000) }),
      'ai:analysis:b:done': a('done', { resolvedAt: ago(60_000) }),
      'recovered:c:gone': '1',
      'ai:analysis:d:broken': '{not json',
    })
    const out = await readStatusAnalyses(kv, [
      { id: 'a', status: 'operational', incidents: [inc('live', { status: 'investigating' }), inc('done', { resolvedAt: ago(60_000) })] },
      { id: 'b', status: 'operational', incidents: [inc('done', { resolvedAt: ago(60_000) })] },
      { id: 'c', status: 'operational', incidents: [inc('gone', { resolvedAt: ago(60_000) })] },
      { id: 'd', status: 'degraded', incidents: [inc('broken', { status: 'investigating' })] },
    ], NOW)
    expect(Object.fromEntries(Object.entries(out.aiAnalysis).map(([k, v]) => [k, v.map((x) => x.incidentId)]))).toEqual({ a: ['live'], b: ['done'] })
    expect(out.recentlyRecovered).toEqual({ b: ['done'], c: ['gone'] })
  })

  it('reads no recovered: marker with markers off', async () => {
    const { kv, get } = kvOf({ 'recovered:c:gone': '1' })
    const out = await readStatusAnalyses(kv, [{ id: 'c', status: 'operational', incidents: [inc('gone', { resolvedAt: ago(60_000) })] }], NOW, { markers: false })
    expect(out.recentlyRecovered).toEqual({})
    expect(get.mock.calls.map((c) => c[0])).toEqual(['ai:analysis:c:gone'])
  })
})

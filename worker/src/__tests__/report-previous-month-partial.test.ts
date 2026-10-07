// #1630 — between the UTC month rollover and the 12:00Z build (#1627), the previous month has no
// archive yet. The dashboard opts into a partial for it with `partial=1`; every other caller, the
// aiwatch-reports generator among them, still gets the 404 it reads as "not ready".
import { describe, it, expect, vi, afterEach } from 'vitest'
import workerModule from '../index'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function makeKv(store: Record<string, string>) {
  return {
    get: async (key: string) => store[key] ?? null,
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { store[key] = value },
    delete: async (key: string) => { delete store[key] },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
}

const accumulator = JSON.stringify({
  lastUpdated: '2026-10-01T07:10:00Z',
  services: { together: { count: 1, totalMinutes: 37, longestMinutes: 37, dates: ['2026-09-28'], incidentIds: ['inc-0928'],
    durations: { 'inc-0928': 37 },
    incidents: [{ id: 'inc-0928', title: 'Elevated errors', startedAt: '2026-09-28T19:00:00.000Z', resolvedAt: '2026-09-28T19:37:00.000Z',
      durationMin: 37, finalStatus: 'resolved', impact: 'minor' }] } },
})

async function reportAt(iso: string, query: string, store: Record<string, string> = { 'incidents:monthly:2026-09': accumulator }) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(iso))
  const res = await workerModule.fetch(
    new Request(`https://example.com/api/report?${query}`),
    { ALLOWED_ORIGIN: '*', STATUS_CACHE: makeKv(store) } as Parameters<typeof workerModule.fetch>[1],
    ctx,
  )
  return { status: res.status, body: await res.json() as { partial?: boolean; period?: string; services?: Record<string, { incidentList?: { id: string }[] }> } }
}

describe('#1630 — /api/report for the previous month before its archive is built', () => {
  afterEach(() => { vi.useRealTimers() })

  it('serves a partial from the accumulator when the caller asks with partial=1', async () => {
    const { status, body } = await reportAt('2026-10-01T05:00:00Z', 'month=2026-09&partial=1')
    expect(status).toBe(200)
    expect(body.partial).toBe(true)
    expect(body.services?.together?.incidentList?.map((i) => i.id)).toEqual(['inc-0928'])
  })

  it('still 404s without partial=1 — the reports generator\'s "not ready" signal', async () => {
    expect((await reportAt('2026-10-01T05:00:00Z', 'month=2026-09')).status).toBe(404)
  })

  it('404s with partial=1 once the build window has passed', async () => {
    expect((await reportAt('2026-10-02T05:00:00Z', 'month=2026-09&partial=1')).status).toBe(404)
  })

  it('404s with partial=1 for an older month', async () => {
    expect((await reportAt('2026-10-01T05:00:00Z', 'month=2026-08&partial=1', { 'incidents:monthly:2026-08': accumulator })).status).toBe(404)
  })

  it('serves the built archive, not a partial, once it exists', async () => {
    const { status, body } = await reportAt('2026-10-01T12:30:00Z', 'month=2026-09&partial=1',
      { 'incidents:monthly:2026-09': accumulator, 'archive:monthly:2026-09': JSON.stringify({ period: '2026-09', services: {} }) })
    expect(status).toBe(200)
    expect(body.partial).toBeUndefined()
    expect(body.period).toBe('2026-09')
  })
})

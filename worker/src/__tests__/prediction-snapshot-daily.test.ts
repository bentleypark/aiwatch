// #1695 — drives the real `scheduled()` handler and asserts the daily Discord report carries the
// snapshot coverage line, so the line cannot be disconnected from the handler without a failure.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../types'
import type { IncidentHistoryRecord } from '../incident-history'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

const OPERATIONAL: ServiceStatus[] = SERVICES.map((s) => (
  { id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus
))

const RUN_AT = '2026-09-15T09:02:00.000Z'

function makeKv(seed: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    get: async (key: string) => (key === 'services:latest' ? JSON.stringify(OPERATIONAL) : store.get(key) ?? null),
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
}

async function dailyReport(kv: KVNamespace): Promise<string | undefined> {
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }))
  await workerModule.scheduled({ scheduledTime: Date.parse(RUN_AT), cron: '*/5 * * * *' } as ScheduledEvent, {
    STATUS_CACHE: kv,
    DISCORD_WEBHOOK_URL: 'https://example.invalid/hook',
  } as never, ctx)
  for (const call of fetchMock.mock.calls) {
    if (call[0] !== 'https://example.invalid/hook') continue
    const body = (call[1] as RequestInit | undefined)?.body
    if (typeof body === 'string' && body.includes('AIWatch Daily Report')) return body
  }
  return undefined
}

const rec = (incId: string, over: Partial<IncidentHistoryRecord> = {}): IncidentHistoryRecord => ({
  svcId: 'claude', incId, title: 'Elevated errors', provider: 'Anthropic', category: 'api', impact: 'major',
  startedAt: '2026-09-15T04:00:00.000Z', resolvedAt: '2026-09-15T05:00:00.000Z', durationMin: 60, predictedRecoveryHours: 2, ...over,
})
const snapshot = { at: '2026-09-15T04:10:00.000Z', elapsedMin: 10, stage: 'investigating', updates: 1, sinceLastUpdateMin: 5, impact: 'major', estimateHours: 2, historyMatches: 1 }

describe('#1695 the snapshot coverage line reaches the daily Discord report', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('counts the day\'s resolved forecasts and how many kept their snapshot', async () => {
    const body = await dailyReport(makeKv({
      'incident:history:claude': JSON.stringify([rec('a', { predictionSnapshots: [snapshot] as never }), rec('b')]),
    }))
    expect(body).toBeDefined()
    expect(body).toContain('Prediction snapshots: 1 of 2 resolved forecasts (24h)')
  })

  it('prints nothing when no forecast resolved in the last day', async () => {
    const body = await dailyReport(makeKv({
      'incident:history:claude': JSON.stringify([rec('old', { resolvedAt: '2026-09-10T05:00:00.000Z' })]),
    }))
    expect(body).toBeDefined()
    expect(body).not.toContain('Prediction snapshots')
  })
})

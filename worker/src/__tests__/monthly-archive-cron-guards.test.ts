// #1317 — the permanent month-end archive must not overwrite on an unreadable key or publish
// an all-null score when services:latest cannot establish the score inputs.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const EVENT = { scheduledTime: Date.parse('2026-08-01T00:07:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent
const ARCHIVE_KEY = 'archive:monthly:2026-07'
const OPERATIONAL: ServiceStatus[] = SERVICES.map(s => (
  { id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus
))

function makeKv(options: {
  archiveRaw?: string | null
  faultOnArchive?: boolean
  servicesLatest?: string | null
  faultOnServicesLatest?: boolean
} = {}) {
  const puts: string[] = []
  const failureMarkers = new Set<string>()
  const kv = {
    get: async (key: string) => {
      if (failureMarkers.has(key)) return '1'
      if (key === ARCHIVE_KEY && options.faultOnArchive) throw new Error('archive read unavailable')
      if (key === ARCHIVE_KEY) return options.archiveRaw ?? null
      if (key === 'services:latest' && options.faultOnServicesLatest) throw new Error('latest read unavailable')
      if (key === 'services:latest') return options.servicesLatest ?? null
      if (key.startsWith('incidents:monthly:')) return JSON.stringify({
        lastUpdated: '2026-07-31T00:00:00Z',
        services: {
          claude: {
            count: 1, totalMinutes: 60, longestMinutes: 60,
            dates: ['2026-07-02'], incidentIds: ['inc-1'], durations: { 'inc-1': 60 },
            incidents: [{ id: 'inc-1', title: 'Elevated errors', startedAt: '2026-07-02T00:00:00Z',
              resolvedAt: '2026-07-02T01:00:00Z', durationMin: 60, status: 'resolved' }],
          },
        },
      })
      return null
    },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string) => {
      puts.push(key)
      if (key.startsWith('archive:failed:')) failureMarkers.add(key)
    },
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
  return { kv, puts }
}

async function runCron(kv: KVNamespace, withDiscord = false) {
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [] })
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }))
  await workerModule.scheduled(EVENT, {
    STATUS_CACHE: kv,
    ...(withDiscord ? { DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' } : {}),
  } as never, ctx)
  return fetchMock
}

describe('month-end cron archive guards (#1317)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('uses the UTC previous month and does not re-enter on an archive read fault', async () => {
    const { kv, puts } = makeKv({ faultOnArchive: true })

    await runCron(kv)

    expect(puts).not.toContain(ARCHIVE_KEY)
  })

  it('does not write an archive when services:latest cannot be read', async () => {
    const { kv, puts } = makeKv({ faultOnServicesLatest: true })

    await runCron(kv)

    expect(puts).not.toContain(ARCHIVE_KEY)
  })

  it('alerts Discord when the archive build is skipped', async () => {
    const { kv, puts } = makeKv({ faultOnServicesLatest: true })

    const fetchMock = await runCron(kv, true)

    expect(puts).not.toContain(ARCHIVE_KEY)
    expect(fetchMock).toHaveBeenCalledWith('https://example.invalid/hook', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('Monthly archive build failed'),
    }))
    expect(puts).toContain('archive:failed:2026-07')
  })

  it('deduplicates failure alerts within the archive period', async () => {
    const { kv, puts } = makeKv({ faultOnServicesLatest: true })

    const fetchMock = await runCron(kv, true)
    fetchMock.mockClear()
    await runCron(kv, true)

    expect(fetchMock.mock.calls.filter(([url]) => url === 'https://example.invalid/hook')).toHaveLength(0)
    expect(puts.filter(key => key === 'archive:failed:2026-07')).toHaveLength(1)
  })

  it('does not write an archive when services:latest is malformed', async () => {
    const { kv, puts } = makeKv({ servicesLatest: '{not json' })

    await runCron(kv)

    expect(puts).not.toContain(ARCHIVE_KEY)
  })

  it.each([
    ['absent', null],
    ['an empty services object', JSON.stringify({ services: [] })],
    ['an empty services array', JSON.stringify([])],
  ])('does not write an archive when services:latest is %s', async (_label, servicesLatest) => {
    const { kv, puts } = makeKv({ servicesLatest })

    await runCron(kv)

    expect(puts).not.toContain(ARCHIVE_KEY)
  })

  it('does not overwrite an existing archive', async () => {
    const { kv, puts } = makeKv({ archiveRaw: JSON.stringify({ period: '2026-07', services: {} }) })

    await runCron(kv)

    expect(puts).not.toContain(ARCHIVE_KEY)
  })
})

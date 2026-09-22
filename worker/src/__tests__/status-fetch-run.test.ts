import { afterEach, describe, expect, it, vi } from 'vitest'
import workerModule from '../index'
import { recordStatusFetchRun, STATUS_FETCH_RUN_INDEX } from '../status-fetch-run'
import type { ServiceStatus } from '../types'

const svc = (id: string, uptime30d: number | null) => ({ id, uptime30d }) as unknown as ServiceStatus

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true }),
  }
}

function env(writeDataPoint = vi.fn()) {
  return {
    STATUS_CACHE: kv(),
    ANALYTICS: { writeDataPoint },
    ALLOWED_ORIGIN: '*',
  } as unknown as Parameters<typeof workerModule.fetch>[1]
}

const UPSTREAM_MS = 25
const slowFetch = vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('{}', { status: 404 })), UPSTREAM_MS)))

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function runRows(writeDataPoint: ReturnType<typeof vi.fn>) {
  return writeDataPoint.mock.calls
    .map(([point]) => point as { blobs: string[]; doubles: number[]; indexes: string[] })
    .filter((point) => point.indexes[0] === STATUS_FETCH_RUN_INDEX)
}

describe('#1489 status-fetch-run metric', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('records the route, wall time and how many services came back without uptime', () => {
    const writeDataPoint = vi.fn()
    recordStatusFetchRun({ writeDataPoint }, 'live', 1234, [svc('a', 99.9), svc('b', null), svc('c', null)])
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['live'],
      doubles: [1, 1234, 2, 3],
      indexes: [STATUS_FETCH_RUN_INDEX],
    })
  })

  it('never throws out of a failed write', () => {
    const writeDataPoint = vi.fn(() => { throw new Error('binding gone') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => recordStatusFetchRun({ writeDataPoint }, 'cron', 1, [])).not.toThrow()
    warn.mockRestore()
  })

  it('the live /api/status path writes one live row per fetch', async () => {
    vi.stubGlobal('fetch', slowFetch)
    const writeDataPoint = vi.fn()
    const startedAt = Date.now()
    const res = await workerModule.fetch(new Request('https://aiwatch.test/api/status'), env(writeDataPoint), ctx)
    const elapsed = Date.now() - startedAt
    expect(res.status).toBe(200)
    const rows = runRows(writeDataPoint)
    expect(rows).toHaveLength(1)
    expect(rows[0].blobs).toEqual(['live'])
    expect(rows[0].doubles[1]).toBeGreaterThanOrEqual(UPSTREAM_MS)
    expect(rows[0].doubles[1]).toBeLessThanOrEqual(elapsed)
    expect(rows[0].doubles[3]).toBeGreaterThan(0)
  }, 60_000)

  it('the cron path writes one cron row when it re-fetches', async () => {
    vi.stubGlobal('fetch', slowFetch)
    const writeDataPoint = vi.fn()
    const cronEnv = { ...env(writeDataPoint), DISCORD_WEBHOOK_URL: 'https://discord.test/hook' } as Parameters<typeof workerModule.fetch>[1]
    const startedAt = Date.now()
    await workerModule.scheduled({ cron: '*/5 * * * *', scheduledTime: startedAt - 60_000 } as ScheduledEvent, cronEnv, ctx)
    const elapsed = Date.now() - startedAt
    const rows = runRows(writeDataPoint)
    expect(rows).toHaveLength(1)
    expect(rows[0].blobs).toEqual(['cron'])
    expect(rows[0].doubles[1]).toBeGreaterThanOrEqual(UPSTREAM_MS)
    expect(rows[0].doubles[1]).toBeLessThanOrEqual(elapsed)
    expect(rows[0].doubles[3]).toBeGreaterThan(0)
  }, 60_000)
})

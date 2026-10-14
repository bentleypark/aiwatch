import { afterEach, describe, expect, it, vi } from 'vitest'
import workerModule from '../index'
import { recordStatusFetchRun, STATUS_FETCH_RUN_INDEX, STATUS_FETCH_LEG_INDEX } from '../status-fetch-run'
import type { FetchLegStats } from '../utils'
import type { ServiceStatus } from '../types'

const NO_FAILURES = { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 }
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

type Point = { blobs: string[]; doubles: number[]; indexes: string[] }
const rowsOf = (writeDataPoint: ReturnType<typeof vi.fn>, index: string) =>
  writeDataPoint.mock.calls.map(([point]) => point as Point).filter((point) => point.indexes[0] === index)
const runRows = (writeDataPoint: ReturnType<typeof vi.fn>) => rowsOf(writeDataPoint, STATUS_FETCH_RUN_INDEX)
const legRows = (writeDataPoint: ReturnType<typeof vi.fn>) => rowsOf(writeDataPoint, STATUS_FETCH_LEG_INDEX)

const leg = (over: Partial<FetchLegStats> & Pick<FetchLegStats, 'leg' | 'budgetMs'>): FetchLegStats => ({
  answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, answeredMs: 0, maxAnsweredMs: 0, answeredByBudgetShare: [0, 0, 0, 0, 0], ...over,
})

/** The run row's answered / timeouts / other errors against the leg rows' sum — the legs must add up. */
function expectLegsAddUp(writeDataPoint: ReturnType<typeof vi.fn>) {
  const [run] = runRows(writeDataPoint)
  const legs = legRows(writeDataPoint)
  expect(legs.length).toBeGreaterThan(0)
  const sum = (i: number) => legs.reduce((n, row) => n + row.doubles[i], 0)
  expect(sum(2)).toBe(run.doubles[5])
  expect(sum(3)).toBe(run.doubles[6])
  expect(sum(4)).toBe(run.doubles[7])
  expect(sum(5)).toBe(run.doubles[8])
}

describe('#1489 status-fetch-run metric', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('records the route, wall time, which services came back without uptime and how fetches failed', () => {
    const writeDataPoint = vi.fn()
    const fetchStats = { maxInFlight: 9, answered: 8, timeouts: 3, httpErrors: 4, otherErrors: 5, waitingAtStartAnswered: 20, waitingAtStartTimeouts: 21 }
    recordStatusFetchRun({ writeDataPoint }, 'live', 1234, [svc('c', null), svc('a', 99.9), svc('b', null)], fetchStats)
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['live', 'b,c'],
      doubles: [1, 1234, 2, 3, 9, 8, 3, 4, 5, 20, 21],
      indexes: [STATUS_FETCH_RUN_INDEX],
    })
  })

  it('writes one leg row per leg and timeout that fetched', () => {
    const writeDataPoint = vi.fn()
    const legs = [
      leg({ leg: 'summary', budgetMs: 8000, answered: 5, timeouts: 1, httpErrors: 2, otherErrors: 3, answeredMs: 900, maxAnsweredMs: 400, answeredByBudgetShare: [3, 2, 0, 0, 0] }),
      leg({ leg: 'showcase', budgetMs: 3000, timeouts: 4 }),
      leg({ leg: 'html', budgetMs: 5000, answered: 1, answeredMs: 4100, maxAnsweredMs: 4100, answeredByBudgetShare: [0, 0, 0, 0, 1] }),
      leg({ leg: 'html', budgetMs: 8000, timeouts: 2 }),
    ]
    recordStatusFetchRun({ writeDataPoint }, 'live', 10, [], { ...NO_FAILURES, legs })
    const rows = legRows(writeDataPoint)
    expect(rows.map((r) => [r.blobs, r.doubles[1]])).toEqual([[['live', 'summary'], 8000], [['live', 'showcase'], 3000], [['live', 'html'], 5000], [['live', 'html'], 8000]])
    expect(rows[0].doubles).toEqual([1, 8000, 5, 1, 2, 3, 900, 400, 3, 2, 0, 0, 0])
    expect(rows[1].doubles).toEqual([1, 3000, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(rows[2].doubles).toEqual([1, 5000, 1, 0, 0, 0, 4100, 4100, 0, 0, 0, 0, 1])
    expect(rows.every((r) => r.doubles.length <= 20)).toBe(true)
    expect(runRows(writeDataPoint)).toHaveLength(1)
  })

  it('writes the run row alone when the stats carry no legs', () => {
    const writeDataPoint = vi.fn()
    recordStatusFetchRun({ writeDataPoint }, 'cron', 10, [], NO_FAILURES)
    expect(runRows(writeDataPoint)).toHaveLength(1)
    expect(legRows(writeDataPoint)).toHaveLength(0)
  })

  it('never throws out of a failed write', () => {
    const writeDataPoint = vi.fn(() => { throw new Error('binding gone') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => recordStatusFetchRun({ writeDataPoint }, 'cron', 1, [], NO_FAILURES)).not.toThrow()
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
    expect(rows[0].blobs[0]).toBe('live')
    expect(rows[0].blobs[1].split(',')).toHaveLength(rows[0].doubles[2])
    expect(rows[0].doubles[4]).toBeGreaterThan(0)
    expect(rows[0].doubles[5]).toBeGreaterThan(0)
    expect(rows[0].doubles[7]).toBeGreaterThan(0)
    expect(rows[0].doubles[1]).toBeGreaterThanOrEqual(UPSTREAM_MS)
    expect(rows[0].doubles[1]).toBeLessThanOrEqual(elapsed)
    expect(rows[0].doubles[3]).toBeGreaterThan(0)
    expectLegsAddUp(writeDataPoint)
    expect(legRows(writeDataPoint).every((r) => r.blobs[0] === rows[0].blobs[0])).toBe(true)
    expect(legRows(writeDataPoint).map((r) => r.blobs[1])).toEqual(expect.arrayContaining(['summary', 'incidents']))
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
    expect(rows[0].blobs[0]).toBe('cron')
    expect(rows[0].blobs[1].split(',')).toHaveLength(rows[0].doubles[2])
    expect(rows[0].doubles[4]).toBeGreaterThan(0)
    expect(rows[0].doubles[5]).toBeGreaterThan(0)
    expect(rows[0].doubles[7]).toBeGreaterThan(0)
    expect(rows[0].doubles[1]).toBeGreaterThanOrEqual(UPSTREAM_MS)
    expect(rows[0].doubles[1]).toBeLessThanOrEqual(elapsed)
    expect(rows[0].doubles[3]).toBeGreaterThan(0)
    expectLegsAddUp(writeDataPoint)
    expect(legRows(writeDataPoint).every((r) => r.blobs[0] === rows[0].blobs[0])).toBe(true)
    expect(legRows(writeDataPoint).map((r) => r.blobs[1])).toEqual(expect.arrayContaining(['summary', 'incidents']))
  }, 60_000)
})

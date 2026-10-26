import { afterEach, describe, expect, it, vi } from 'vitest'
import workerModule from '../index'
import { recordStatusFetchRun, encodeFetchTrace, STATUS_FETCH_RUN_INDEX, STATUS_FETCH_LEG_INDEX, STATUS_FETCH_TRACE_INDEX, STATUS_FETCH_TRACE_MAX_CHARS, statusFetchLegIndex } from '../status-fetch-run'
import { createFetchTracker, FETCH_TRACE_MAX, type FetchLegStats, type FetchTraceEntry } from '../utils'
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
const legRows = (writeDataPoint: ReturnType<typeof vi.fn>) =>
  writeDataPoint.mock.calls.map(([point]) => point as Point).filter((point) => point.indexes[0].startsWith(`${STATUS_FETCH_LEG_INDEX}:`))

/** Analytics Engine samples per index: no two points of one run may share one. */
function expectOwnIndexes(rows: Point[]) {
  const indexes = rows.map((r) => r.indexes[0])
  expect(new Set(indexes).size).toBe(indexes.length)
  expect(indexes.every((i) => new TextEncoder().encode(i).length <= 96)).toBe(true)
}

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
      blobs: ['live', 'b,c', ''],
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
    expect(rows.map((r) => r.indexes[0])).toEqual(['status-fetch-leg:summary@8000', 'status-fetch-leg:showcase@3000', 'status-fetch-leg:html@5000', 'status-fetch-leg:html@8000'])
    expectOwnIndexes(rows)
    expect(runRows(writeDataPoint)).toHaveLength(1)
  })

  it('the leg index names the leg and the timeout', () => {
    expect(statusFetchLegIndex({ leg: 'html', budgetMs: 5000 })).toBe('status-fetch-leg:html@5000')
    expect(statusFetchLegIndex({ leg: 'other', budgetMs: 0 })).toBe('status-fetch-leg:other@0')
  })

  it('writes the run row and the trace row, and no leg rows, when the stats carry no legs', () => {
    const writeDataPoint = vi.fn()
    recordStatusFetchRun({ writeDataPoint }, 'cron', 10, [], NO_FAILURES)
    expect(runRows(writeDataPoint)).toHaveLength(1)
    expect(rowsOf(writeDataPoint, STATUS_FETCH_TRACE_INDEX)).toHaveLength(1)
    expect(legRows(writeDataPoint)).toHaveLength(0)
    expect(writeDataPoint).toHaveBeenCalledTimes(2)
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
    expectOwnIndexes(legRows(writeDataPoint))
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
    expectOwnIndexes(legRows(writeDataPoint))
    expect(legRows(writeDataPoint).every((r) => r.blobs[0] === rows[0].blobs[0])).toBe(true)
    expect(legRows(writeDataPoint).map((r) => r.blobs[1])).toEqual(expect.arrayContaining(['summary', 'incidents']))
  }, 60_000)
})

describe('#1489 status-fetch-trace row', () => {
  const entry = (over: Partial<FetchTraceEntry> = {}): FetchTraceEntry => ({ host: 'status.a.test', leg: 'summary', budgetMs: 8000, waiting: 3, outcome: 'a', ms: 420, ...over })

  it('encodes one entry per fetch in start order, an unfinished one with empty outcome and time', () => {
    const { text, written } = encodeFetchTrace([entry(), entry({ host: 'status.b.test', leg: 'showcase', budgetMs: 3000, waiting: 40, outcome: 't', ms: 3001 }), entry({ outcome: undefined, ms: undefined })])
    expect(text).toBe('status.a.test,summary,8000,3,a,420;status.b.test,showcase,3000,40,t,3001;status.a.test,summary,8000,3,,')
    expect(written).toBe(3)
  })

  it('cuts at whole entries and stays under the blob limit', () => {
    const many = Array.from({ length: 2000 }, (_, i) => entry({ host: `status.${i}.example.test` }))
    const { text, written } = encodeFetchTrace(many)
    expect(written).toBeLessThan(many.length)
    expect(text.length).toBeLessThanOrEqual(STATUS_FETCH_TRACE_MAX_CHARS)
    expect(text.split(';')).toHaveLength(written)
    expect(text.split(';').every((p) => p.split(',').length === 6)).toBe(true)
  })

  it('writes one trace point per run under its own index, with the launch order and counts', () => {
    const writeDataPoint = vi.fn()
    const trace = [entry(), entry({ outcome: 't', ms: 8000 })]
    recordStatusFetchRun({ writeDataPoint }, 'cron', 900, [svc('a', 99)], { ...NO_FAILURES, answered: 1, timeouts: 1, launchOrder: 'shuffled', trace })
    const rows = rowsOf(writeDataPoint, STATUS_FETCH_TRACE_INDEX)
    expect(rows).toHaveLength(1)
    expect(rows[0].blobs.slice(0, 2)).toEqual(['cron', 'shuffled'])
    expect(rows[0].blobs[2]).toBe(encodeFetchTrace(trace).text)
    expect(rows[0].doubles).toEqual([1, 2, 2])
    expect(runRows(writeDataPoint)[0].blobs[2]).toBe('shuffled')
    expect(new Set(writeDataPoint.mock.calls.map(([p]) => (p as Point).indexes[0])).size).toBe(writeDataPoint.mock.calls.length)
  })

  it('shows a cut: the tracker traces at most FETCH_TRACE_MAX and the blob holds fewer still', async () => {
    const tracker = createFetchTracker(() => 0)
    for (let i = 0; i < FETCH_TRACE_MAX + 40; i++) await tracker.track(async () => new Response('{}'), `https://status-${i}.${'long-provider-name.'.repeat(3)}example.test/`, 5000)
    const writeDataPoint = vi.fn()
    recordStatusFetchRun({ writeDataPoint }, 'live', 1, [], tracker.stats())
    const [row] = rowsOf(writeDataPoint, STATUS_FETCH_TRACE_INDEX)
    expect(row.doubles[1]).toBe(FETCH_TRACE_MAX)
    expect(row.doubles[2]).toBeLessThan(FETCH_TRACE_MAX)
  })

  it('writes every traced fetch when nothing is cut, one still in flight included', () => {
    const tracker = createFetchTracker(() => 0)
    void tracker.track(() => new Promise<Response>(() => {}), 'https://status.a.test/api/v2/incidents.json', 8000)
    void tracker.track(async () => new Response('{}'), 'https://status.b.test/', 5000)
    const writeDataPoint = vi.fn()
    recordStatusFetchRun({ writeDataPoint }, 'live', 1, [], tracker.stats())
    const [row] = rowsOf(writeDataPoint, STATUS_FETCH_TRACE_INDEX)
    expect(row.doubles).toEqual([1, 2, 2])
  })
})

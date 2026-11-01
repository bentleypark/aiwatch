import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  accumulateIncidentsOnlyIfChanged, formatGuard3Holds, GUARD3_HOLD_LOG_MAX, type Guard3Hold,
  mergeGuard3Holds, parseGuard3HoldRecords, readGuard3Holds, guard3HoldKey, GUARD3_HOLD_RECORD_MAX, GUARD3_HOLD_TTL_SECONDS, type Guard3HoldRecord,
} from '../monthly-archive'
import { formatGuard3HoldLine, buildDailySummary } from '../daily-summary'
import type { MonthlyIncidentEntry, MonthlyIncidents } from '../monthly-archive'
import type { ServiceStatus } from '../types'

const hold = (n: number): Guard3Hold => ({
  svcId: 'openrouter', id: `inc-${n}`, title: `Chat is inaccessible ${n}`,
  startedAt: '2026-07-23T20:57:54.774Z', oldestLiveStart: '2026-07-23T21:17:36.517Z',
})

describe('formatGuard3Holds', () => {
  it('says nothing for no holds', () => {
    expect(formatGuard3Holds([])).toBeNull()
  })

  it('names the service, the id, the title and both instants of one hold', () => {
    expect(formatGuard3Holds([hold(1)])).toBe(
      '[monthly-archive] #1154 phantom prune held 1 unresolved entry absent from the live list: openrouter/inc-1 "Chat is inaccessible 1" (started 2026-07-23T20:57:54.774Z, oldest live start considered 2026-07-23T21:17:36.517Z)',
    )
  })

  it('lists at most GUARD3_HOLD_LOG_MAX and counts the rest', () => {
    const line = formatGuard3Holds(Array.from({ length: GUARD3_HOLD_LOG_MAX + 3 }, (_, i) => hold(i)))!
    expect(line).toContain(`held ${GUARD3_HOLD_LOG_MAX + 3} unresolved entries`)
    expect(line.match(/openrouter\/inc-/g)).toHaveLength(GUARD3_HOLD_LOG_MAX)
    expect(line).toContain(' … +3 more')
  })
})

describe('accumulateIncidentsOnlyIfChanged — the hold line is hourly', () => {
  afterEach(() => vi.restoreAllMocks())

  const PHANTOM: MonthlyIncidentEntry = {
    id: 'YGz9Og5Qm8vO', title: '[Automated] Chat is inaccessible', startedAt: '2026-07-23T20:57:54.774Z',
    resolvedAt: null, durationMin: 0, finalStatus: 'investigating', impact: 'critical',
  }
  const stored = (): MonthlyIncidents => ({
    lastUpdated: '2026-07-23T21:00:00.000Z',
    services: { openrouter: { count: 1, totalMinutes: 0, longestMinutes: 0, dates: ['2026-07-23'], incidentIds: [PHANTOM.id], durations: { [PHANTOM.id]: 0 }, incidents: [PHANTOM] } },
  })
  const live = (): ServiceStatus[] => [{
    id: 'openrouter', name: 'OpenRouter', status: 'operational',
    incidents: [{ id: 'rNB9qLkp-dOw', title: 'Erroneous outage status', status: 'resolved', impact: 'minor', startedAt: '2026-07-23T21:17:36.517Z', resolvedAt: '2026-07-23T21:30:00.000Z', duration: '12m', timeline: [] }],
  } as unknown as ServiceStatus]
  const kvWith = () => {
    const store: Record<string, string> = { 'incidents:monthly:2026-07': JSON.stringify(stored()) }
    return { get: async (k: string) => store[k] ?? null, put: async (k: string, v: string) => { store[k] = v } } as unknown as KVNamespace
  }
  const captureWarns = () => {
    const lines: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((message?: unknown) => { lines.push(String(message)) })
    return () => lines.filter((l) => l.includes('#1154'))
  }

  it.each([['00', 0], ['04', 4]])('writes the line at minute %s', async (_l, minute) => {
    const heldLines = captureWarns()
    await accumulateIncidentsOnlyIfChanged(kvWith(), live(), '2026-07', new Date(Date.UTC(2026, 6, 24, 3, minute)))
    expect(heldLines()).toHaveLength(1)
    expect(heldLines()[0]).toContain('openrouter/YGz9Og5Qm8vO')
  })

  it.each([['05', 5], ['35', 35], ['59', 59]])('stays quiet at minute %s', async (_l, minute) => {
    const heldLines = captureWarns()
    await accumulateIncidentsOnlyIfChanged(kvWith(), live(), '2026-07', new Date(Date.UTC(2026, 6, 24, 3, minute)))
    expect(heldLines()).toEqual([])
  })

  it('stays quiet when nothing is held, at minute 0', async () => {
    const heldLines = captureWarns()
    const kv = { get: async () => null, put: async () => {} } as unknown as KVNamespace
    await accumulateIncidentsOnlyIfChanged(kv, live(), '2026-07', new Date(Date.UTC(2026, 6, 24, 3, 0)))
    expect(heldLines()).toEqual([])
  })
})

const rec = (n: number, over: Partial<Guard3HoldRecord> = {}): Guard3HoldRecord => ({
  svc: 'openrouter', id: `inc-${n}`, title: `Chat is inaccessible ${n}`, startedAt: '2026-07-23T20:57:54.774Z', firstSeen: '2026-07-24T03:00:00.000Z', ...over,
})

describe('mergeGuard3Holds', () => {
  it('records a new hold with the instant it was first seen', () => {
    expect(mergeGuard3Holds(null, [hold(1)], '2026-07-24T03:00:00.000Z')).toEqual({ list: [rec(1)], added: 1 })
  })

  it('keeps the first sighting when the same service and id come round again', () => {
    const first = rec(1, { firstSeen: '2026-07-23T21:00:00.000Z' })
    expect(mergeGuard3Holds([first], [hold(1)], '2026-07-24T03:00:00.000Z')).toEqual({ list: [first], added: 0 })
  })

  it('records a hold reported twice in one cycle once', () => {
    expect(mergeGuard3Holds(null, [hold(1), hold(1)], '2026-07-24T03:00:00.000Z')).toEqual({ list: [rec(1)], added: 1 })
  })

  it('tells the same id on two services apart', () => {
    const out = mergeGuard3Holds([rec(1)], [{ ...hold(1), svcId: 'openai' }], '2026-07-24T03:00:00.000Z')
    expect(out.added).toBe(1)
    expect(out.list.map((r) => r.svc)).toEqual(['openrouter', 'openai'])
  })

  it('stops at GUARD3_HOLD_RECORD_MAX', () => {
    const full = Array.from({ length: GUARD3_HOLD_RECORD_MAX }, (_, i) => rec(i))
    expect(mergeGuard3Holds(full, [hold(999)], 't')).toEqual({ list: full, added: 0 })
  })
})

describe('parseGuard3HoldRecords', () => {
  it.each([[null], ['not json'], ['{"a":1}'], ['[]']])('reads %j as none', (raw) => {
    expect(parseGuard3HoldRecords(raw)).toEqual([])
  })

  it('keeps well-formed records and drops the malformed ones', () => {
    expect(parseGuard3HoldRecords(JSON.stringify([rec(1), { svc: 'x' }, null, 7, rec(2)]))).toEqual([rec(1), rec(2)])
  })
})

describe('readGuard3Holds', () => {
  const kvOf = (store: Record<string, string>, failKey?: string) => ({
    get: async (k: string) => { if (k === failKey) throw new Error('kv down'); return store[k] ?? null },
  }) as unknown as KVNamespace

  it('returns last month then this month, oldest first', async () => {
    const kv = kvOf({ [guard3HoldKey('2026-06')]: JSON.stringify([rec(1)]), [guard3HoldKey('2026-07')]: JSON.stringify([rec(2)]) })
    expect((await readGuard3Holds(kv, '2026-07-24'))!.map((r) => r.id)).toEqual(['inc-1', 'inc-2'])
  })

  it('reads December as last month in January', async () => {
    const kv = kvOf({ [guard3HoldKey('2025-12')]: JSON.stringify([rec(1)]) })
    expect((await readGuard3Holds(kv, '2026-01-15'))!.map((r) => r.id)).toEqual(['inc-1'])
  })

  it('is none, not unreadable, when neither month has a record', async () => {
    expect(await readGuard3Holds(kvOf({}), '2026-07-24')).toEqual([])
  })

  it('is null when a read throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await readGuard3Holds(kvOf({}, guard3HoldKey('2026-07')), '2026-07-24')).toBeNull()
    vi.restoreAllMocks()
  })
})

describe('accumulateIncidentsOnlyIfChanged — the durable hold record', () => {
  afterEach(() => vi.restoreAllMocks())

  const PHANTOM: MonthlyIncidentEntry = {
    id: 'YGz9Og5Qm8vO', title: '[Automated] Chat is inaccessible', startedAt: '2026-07-23T20:57:54.774Z',
    resolvedAt: null, durationMin: 0, finalStatus: 'investigating', impact: 'critical',
  }
  const stored = (): MonthlyIncidents => ({
    lastUpdated: '2026-07-23T21:00:00.000Z',
    services: { openrouter: { count: 1, totalMinutes: 0, longestMinutes: 0, dates: ['2026-07-23'], incidentIds: [PHANTOM.id], durations: { [PHANTOM.id]: 0 }, incidents: [PHANTOM] } },
  })
  const live = (): ServiceStatus[] => [{
    id: 'openrouter', name: 'OpenRouter', status: 'operational',
    incidents: [{ id: 'rNB9qLkp-dOw', title: 'Erroneous outage status', status: 'resolved', impact: 'minor', startedAt: '2026-07-23T21:17:36.517Z', resolvedAt: '2026-07-23T21:30:00.000Z', duration: '12m', timeline: [] }],
  } as unknown as ServiceStatus]
  const makeKV = (seed: Record<string, string>, failKey?: string) => {
    const store: Record<string, string> = { ...seed }
    const puts: Array<{ key: string; opts?: { expirationTtl?: number } }> = []
    const gets: string[] = []
    const kv = {
      get: async (k: string) => { gets.push(k); if (k === failKey) throw new Error('kv down'); return store[k] ?? null },
      put: async (k: string, v: string, opts?: { expirationTtl?: number }) => { store[k] = v; puts.push({ key: k, opts }) },
    } as unknown as KVNamespace
    return { kv, store, puts, gets }
  }
  const seed = () => ({ 'incidents:monthly:2026-07': JSON.stringify(stored()) })
  const NOW = new Date(Date.UTC(2026, 6, 24, 3, 35))

  it('writes the record at any minute, with its TTL', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { kv, store, puts } = makeKV(seed())
    await accumulateIncidentsOnlyIfChanged(kv, live(), '2026-07', NOW)
    expect(JSON.parse(store[guard3HoldKey('2026-07')])).toEqual([
      { svc: 'openrouter', id: 'YGz9Og5Qm8vO', title: PHANTOM.title, startedAt: PHANTOM.startedAt, firstSeen: NOW.toISOString() },
    ])
    expect(puts.find((p) => p.key === guard3HoldKey('2026-07'))?.opts?.expirationTtl).toBe(GUARD3_HOLD_TTL_SECONDS)
  })

  it('does not rewrite it when the same hold comes round on the next cycle', async () => {
    const { kv, puts } = makeKV(seed())
    await accumulateIncidentsOnlyIfChanged(kv, live(), '2026-07', NOW)
    await accumulateIncidentsOnlyIfChanged(kv, live(), '2026-07', new Date(NOW.getTime() + 300_000))
    expect(puts.filter((p) => p.key === guard3HoldKey('2026-07'))).toHaveLength(1)
  })

  it('does not touch the record on a cycle that held nothing', async () => {
    const { kv, gets } = makeKV({})
    await accumulateIncidentsOnlyIfChanged(kv, live(), '2026-07', NOW)
    expect(gets).not.toContain(guard3HoldKey('2026-07'))
  })

  it('a failing record read does not change the accumulation result', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const healthy = makeKV(seed())
    const failing = makeKV(seed(), guard3HoldKey('2026-07'))
    const expected = await accumulateIncidentsOnlyIfChanged(healthy.kv, live(), '2026-07', NOW)
    expect(await accumulateIncidentsOnlyIfChanged(failing.kv, live(), '2026-07', NOW)).toBe(expected)
    expect(JSON.parse(failing.store['incidents:monthly:2026-07']).services).toEqual(JSON.parse(healthy.store['incidents:monthly:2026-07']).services)
    expect(failing.store[guard3HoldKey('2026-07')]).toBeUndefined()
  })
})

describe('the daily summary line', () => {
  it.each([[undefined], [[]]])('is absent for %j', (records) => {
    expect(formatGuard3HoldLine(records)).toBe('')
  })

  it('says the record is unreadable when it could not be read', () => {
    expect(formatGuard3HoldLine(null)).toBe('🕳️ **Phantom prune holds**: record unreadable')
  })

  it('counts one hold and names it', () => {
    expect(formatGuard3HoldLine([rec(1)])).toBe('🕳️ **Phantom prune holds**: 1 hold (this month and last) — latest openrouter/inc-1')
  })

  it('names the latest three of more and counts the earlier ones', () => {
    expect(formatGuard3HoldLine([1, 2, 3, 4, 5].map((n) => rec(n)))).toBe(
      '🕳️ **Phantom prune holds**: 5 holds (this month and last) — latest openrouter/inc-3, openrouter/inc-4, openrouter/inc-5 (+2 earlier)',
    )
  })

  it('reaches the posted summary only when something was held', () => {
    const base = { services: [], aiUsage: null, incidentCountToday: { newCount: 0, resolvedCount: 0 }, redditCount: 0 }
    expect(buildDailySummary({ ...base, guard3Holds: [rec(1)] } as never)).toContain('Phantom prune holds')
    expect(buildDailySummary({ ...base, guard3Holds: [] } as never)).not.toContain('Phantom prune holds')
    expect(buildDailySummary(base as never)).not.toContain('Phantom prune holds')
  })
})

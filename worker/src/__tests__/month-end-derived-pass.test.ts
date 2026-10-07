// #1627 — a west-of-UTC Better Stack page closes its last local day of the month after the UTC month
// has turned. Driven through the real parser and the real accumulator, on the clock that matters.
import { describe, it, expect } from 'vitest'
import { parseBetterStackDowntimeIncidents, type BetterStackIndex } from '../parsers/betterstack'
import { accumulateMonthlyIncidents, previousMonthDerivedPass, accumulateCurrentAndPreviousMonth, previousMonthArchivePending, type MonthlyIncidents } from '../monthly-archive'
import type { Incident, ServiceStatus } from '../types'

const page = (sep30: number, oct1?: number): BetterStackIndex => ({
  data: { attributes: { aggregate_state: 'operational', timezone: 'Pacific Time (US & Canada)' } },
  included: [{ type: 'status_page_resource', id: 'r', attributes: { public_name: 'Qwen', status: 'operational',
    status_history: [{ day: '2026-09-30', status: 'downtime', downtime_duration: sep30, maintenance_duration: 0 },
      ...(oct1 !== undefined ? [{ day: '2026-10-01', status: 'operational', downtime_duration: oct1, maintenance_duration: 0 }] : [])] } }],
})
const svc = (incidents: Incident[]) => ({ id: 'together', name: 'Together', incidents } as unknown as ServiceStatus)

// One 5-minute cron cycle: the current UTC month, then the previous-month derived pass.
function cycle(store: Record<string, MonthlyIncidents | null>, iso: string, services: ServiceStatus[]) {
  const now = new Date(iso)
  const month = iso.slice(0, 7)
  store[month] = accumulateMonthlyIncidents(store[month] ?? null, services, month, [])
  const pass = previousMonthDerivedPass(services, now)
  if (pass) store[pass.month] = accumulateMonthlyIncidents(store[pass.month] ?? null, pass.services, pass.month, [])
}

describe('#1627 — the last local day of the month is banked into its own month', () => {
  it('banks a Pacific page\'s 09-30, which closes at 07:00Z on 10-01, into September', () => {
    const store: Record<string, MonthlyIncidents | null> = {}
    // 23:55Z on 09-30 — still the 30th in Pacific, still accruing.
    cycle(store, '2026-09-30T23:55:00.000Z', [svc(parseBetterStackDowntimeIncidents(page(1800), { now: Date.parse('2026-09-30T23:55:00Z') }))])
    // 07:10Z on 10-01 — Pacific's 30th has closed; the UTC month is October.
    cycle(store, '2026-10-01T07:10:00.000Z', [svc(parseBetterStackDowntimeIncidents(page(2184, 0), { now: Date.parse('2026-10-01T07:10:00Z') }))])
    expect(store['2026-09']?.services.together.incidents).toMatchObject([{ id: 'bs-hist:r:2026-09-30', finalStatus: 'resolved', durationMin: 37 }])
    expect(store['2026-10']?.services.together).toBeUndefined()
  })

  it('runs only on the first UTC day of a month, for the previous month, with derived rows only', () => {
    const feed = { id: 'feed-1', title: 'API errors', status: 'resolved', impact: 'minor', startedAt: '2026-09-30T20:00:00Z', timeline: [] } as unknown as Incident
    const derived = { id: 'bs-hist:r:2026-09-30', derived: 'status_history', derivedDay: '2026-09-30', status: 'resolved' } as unknown as Incident
    expect(previousMonthDerivedPass([svc([feed, derived])], new Date('2026-10-02T00:00:00Z'))).toBeNull()
    expect(previousMonthDerivedPass([svc([feed])], new Date('2026-10-01T05:00:00Z'))).toBeNull()
    expect(previousMonthDerivedPass([svc([feed, derived])], new Date('2026-01-01T05:00:00Z'))?.month).toBe('2025-12')
    const pass = previousMonthDerivedPass([svc([feed, derived])], new Date('2026-10-01T05:00:00Z'))
    expect(pass).toMatchObject({ month: '2026-09' })
    expect(pass?.services[0].incidents.map((i) => i.id)).toEqual(['bs-hist:r:2026-09-30'])
  })

  it('prunes nothing in the previous month — an unresolved feed entry that left the live list stays', () => {
    const stale = { id: 'feed-open', title: 'Elevated errors', status: 'investigating', impact: 'minor', startedAt: '2026-09-29T10:00:00.000Z', timeline: [], duration: null } as unknown as Incident
    let sep = accumulateMonthlyIncidents(null, [svc([stale])], '2026-09', [])
    const derived = parseBetterStackDowntimeIncidents(page(2184, 0), { now: Date.parse('2026-10-01T07:10:00Z') })
    // An older feed row still on the live list is what would let the prune read `feed-open` as missing.
    const older = { id: 'feed-old', title: 'Note', status: 'resolved', impact: 'minor', startedAt: '2026-09-01T10:00:00.000Z',
      resolvedAt: '2026-09-01T11:00:00.000Z', duration: '1h 0m', timeline: [] } as unknown as Incident
    for (let k = 0; k < 4; k++) {
      const pass = previousMonthDerivedPass([svc([older, ...derived])], new Date('2026-10-01T07:10:00Z'))!
      sep = accumulateMonthlyIncidents(sep, pass.services, pass.month, [])
    }
    const open = sep.services.together.incidents?.find((e) => e.id === 'feed-open')
    expect(open).toBeDefined()
    expect(open).not.toHaveProperty('missedRuns')
  })
})

describe('#1627 — the cron entry point banks both months', () => {
  const makeKV = () => {
    const store: Record<string, string> = {}
    return { kv: { get: async (k: string) => store[k] ?? null, put: async (k: string, v: string) => { store[k] = v } } as unknown as KVNamespace, store }
  }

  it('writes the previous month\'s closed last local day on the 1st', async () => {
    const { kv, store } = makeKV()
    const now = new Date('2026-10-01T07:10:00Z')
    const services = [svc(parseBetterStackDowntimeIncidents(page(2184, 0), { now: now.getTime() }))]
    await accumulateCurrentAndPreviousMonth(kv, services, now)
    expect(JSON.parse(store['incidents:monthly:2026-09']).services.together.incidentIds).toEqual(['bs-hist:r:2026-09-30'])
    expect(JSON.parse(store['incidents:monthly:2026-10'] ?? '{"services":{}}').services.together).toBeUndefined()
  })

  it('touches only the current month on any other day', async () => {
    const { kv, store } = makeKV()
    const now = new Date('2026-10-02T07:10:00Z')
    await accumulateCurrentAndPreviousMonth(kv, [svc(parseBetterStackDowntimeIncidents(page(2184, 0), { now: now.getTime() }))], now)
    expect(store['incidents:monthly:2026-09']).toBeUndefined()
  })
})

describe('#1627 — the previous month\'s archive is pending until the 12:00Z build', () => {
  it.each([
    ['2026-10-01T00:05:00Z', true], ['2026-10-01T09:02:00Z', true], ['2026-10-01T13:59:00Z', true],
    ['2026-10-01T14:00:00Z', false], ['2026-10-02T09:02:00Z', false], ['2026-10-15T09:02:00Z', false],
  ])('%s → %s', (iso, pending) => {
    expect(previousMonthArchivePending(new Date(iso))).toBe(pending)
  })
})

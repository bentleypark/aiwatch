import { describe, it, expect } from 'vitest'
import { calendarWindowDays, carryForwardIncidentHistoryStart } from '../services'
import { aistudioHistoryStart } from '../parsers/aistudio'
import { UPTIME_MISSING_ALERT_MS } from '../utils'
import type { ServiceStatus } from '../types'

const NOW = Date.parse('2026-10-26T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()
const msAgo = (ms: number) => new Date(NOW - ms).toISOString()
const svc = (fields: Partial<ServiceStatus> = {}) => ({ id: 'gemini', lastChecked: msAgo(0), ...fields }) as ServiceStatus

describe('#1406 carryForwardIncidentHistoryStart', () => {
  const START = '2024-12-30T12:00:00.000Z'

  it('fills a read that returned no history with the previous snapshot value and its provenance', () => {
    const now = [svc()]
    carryForwardIncidentHistoryStart(now, [svc({ incidentHistoryStart: START, lastChecked: msAgo(60_000) })], NOW)
    expect(now[0].incidentHistoryStart).toBe(START)
    expect(now[0].incidentHistoryCarriedFrom).toBe(msAgo(60_000))
  })

  it('leaves a fresh value alone', () => {
    const now = [svc({ incidentHistoryStart: daysAgo(40) })]
    carryForwardIncidentHistoryStart(now, [svc({ incidentHistoryStart: START })], NOW)
    expect(now[0].incidentHistoryStart).toBe(daysAgo(40))
    expect(now[0].incidentHistoryCarriedFrom).toBeUndefined()
  })

  it('ages a carried value from its original reading and stops past the uptime cap', () => {
    const within = [svc()]
    carryForwardIncidentHistoryStart(within, [svc({ incidentHistoryStart: START, incidentHistoryCarriedFrom: msAgo(UPTIME_MISSING_ALERT_MS) })], NOW)
    expect(within[0].incidentHistoryStart).toBe(START)
    const past = [svc()]
    carryForwardIncidentHistoryStart(past, [svc({ incidentHistoryStart: START, incidentHistoryCarriedFrom: msAgo(UPTIME_MISSING_ALERT_MS + 1) })], NOW)
    expect(past[0].incidentHistoryStart).toBeUndefined()
  })

  it('does nothing without a previous snapshot', () => {
    const now = [svc()]
    carryForwardIncidentHistoryStart(now, null, NOW)
    expect(now[0].incidentHistoryStart).toBeUndefined()
  })
})

describe('#1406 calendarWindowDays', () => {
  it.each([
    ['official uptime', { uptimeSource: 'official' as const }, 30],
    ['platform_avg uptime', { uptimeSource: 'platform_avg' as const }, 30],
    ['a complete per-day record', { dailyImpactComplete: true }, 30],
    ['an incomplete per-day record alone', { dailyImpactComplete: false }, 14],
    ['a capped feed reaching 30 days back', { feedDepthStart: daysAgo(30) }, 30],
    ['a capped feed reaching 29 days back', { feedDepthStart: daysAgo(29) }, 14],
    ['an AI Studio history reaching 665 days back', { incidentHistoryStart: daysAgo(665) }, 30],
    ['an AI Studio history reaching 10 days back', { incidentHistoryStart: daysAgo(10) }, 14],
    ['an unparseable depth', { feedDepthStart: 'not-a-date' }, 14],
    ['no evidence', {}, 14],
  ])('%s → %i days', (_label, svc, days) => {
    expect(calendarWindowDays(svc, NOW)).toBe(days)
  })
})

describe('#1406 aistudioHistoryStart', () => {
  const at = (iso: string) => String(Date.parse(iso) / 1000)
  const entry = (id: string, components: number[], ...isos: string[]) =>
    [id, 't', 1, isos.map((iso) => [1, 'x', [at(iso)], 'Detected']), 1, components]

  it('returns the oldest update across every entry, including ones the component filter drops', () => {
    const payload = [[[
      entry('api', [1], '2026-10-01T14:31:00Z', '2026-10-01T17:20:00Z'),
      entry('ui-only', [3], '2024-12-30T12:00:00Z'),
      entry('live', [2], '2025-06-12T18:10:00Z'),
    ]]]
    expect(aistudioHistoryStart(payload)).toBe('2024-12-30T12:00:00.000Z')
  })

  it('is undefined for an empty or unrecognised payload', () => {
    expect(aistudioHistoryStart([[[]]])).toBeUndefined()
    expect(aistudioHistoryStart({ error: 'x' })).toBeUndefined()
  })
})

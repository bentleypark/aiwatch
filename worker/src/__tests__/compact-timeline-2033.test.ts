import { describe, it, expect } from 'vitest'
import { accumulateMonthlyIncidents, compactTimeline, stripInternalFields } from '../monthly-archive'
import { FIRST_UPDATE_MAX } from '../prediction-snapshot'
import type { Incident, ServiceStatus, TimelineEntry } from '../types'

const T = (stage: TimelineEntry['stage'], at: string, text: string | null): TimelineEntry => ({ stage, at, text })

const OPEN: TimelineEntry[] = [
  T('investigating', '2026-11-10T08:00:00.000Z', 'We are investigating elevated error rates.'),
]
const RESOLVED: TimelineEntry[] = [
  ...OPEN,
  T('identified', '2026-11-10T08:20:00.000Z', 'The cause has been identified.'),
  T('resolved', '2026-11-10T09:00:00.000Z', 'This incident has been resolved.'),
]

function incident(over: Partial<Incident>): Incident {
  return {
    id: 'inc1', title: 'Elevated errors', status: 'investigating', impact: 'major',
    startedAt: '2026-11-10T08:00:00.000Z', duration: null, timeline: OPEN,
    ...over,
  } as Incident
}
const resolved = (over: Partial<Incident> = {}) => incident({
  status: 'resolved', resolvedAt: '2026-11-10T09:00:00.000Z', duration: '1h 0m', timeline: RESOLVED, ...over,
})
const service = (incidents: Incident[]): ServiceStatus =>
  ({ id: 'svc', name: 'svc', status: 'operational', category: 'api', uptime30d: null, latency: null, incidents } as unknown as ServiceStatus)

const rowOf = (acc: ReturnType<typeof accumulateMonthlyIncidents>) => acc.services.svc.incidents![0]

describe('#2033 — compactTimeline', () => {
  it('keeps every update\'s time and stage, and the first text only', () => {
    expect(compactTimeline(resolved())).toEqual([
      { at: '2026-11-10T08:00:00.000Z', stage: 'investigating', text: 'We are investigating elevated error rates.' },
      { at: '2026-11-10T08:20:00.000Z', stage: 'identified' },
      { at: '2026-11-10T09:00:00.000Z', stage: 'resolved' },
    ])
  })

  it('takes the first NON-EMPTY text, on the entry that carries it', () => {
    const out = compactTimeline(incident({ timeline: [T('investigating', '2026-11-10T08:00:00.000Z', '  '), T('identified', '2026-11-10T08:20:00.000Z', 'Found it.')] }))
    expect(out).toEqual([
      { at: '2026-11-10T08:00:00.000Z', stage: 'investigating' },
      { at: '2026-11-10T08:20:00.000Z', stage: 'identified', text: 'Found it.' },
    ])
  })

  it('keeps two updates published at the same instant with different stages (modal shape)', () => {
    const sameAt = [T('investigating', '2026-05-08T02:30:00.000Z', 'All data stores are recovered'), T('resolved', '2026-05-08T02:30:00.000Z', 'All services except queues have recovered')]
    const first = accumulateMonthlyIncidents(null, [service([incident({ timeline: sameAt })])], '2026-11', [])
    const later = accumulateMonthlyIncidents(first, [service([incident({ timeline: sameAt })])], '2026-11', [])
    expect(rowOf(later).timeline!.map(e => e.stage)).toEqual(['investigating', 'resolved'])
  })

  it('stores a source published out of order sorted by time', () => {
    const out = compactTimeline(incident({ timeline: [RESOLVED[2], RESOLVED[0], RESOLVED[1]] }))
    expect(out!.map(e => e.stage)).toEqual(['investigating', 'identified', 'resolved'])
    expect(out![0].text).toBe('We are investigating elevated error rates.')
  })

  it('caps the text at FIRST_UPDATE_MAX', () => {
    const out = compactTimeline(incident({ timeline: [T('investigating', '2026-11-10T08:00:00.000Z', 'x'.repeat(FIRST_UPDATE_MAX + 50))] }))
    expect(out![0].text).toHaveLength(FIRST_UPDATE_MAX)
  })

  it('is undefined for an empty timeline and for a status_history-derived incident', () => {
    expect(compactTimeline(incident({ timeline: [] }))).toBeUndefined()
    expect(compactTimeline(incident({ derived: 'status_history' }))).toBeUndefined()
  })
})

describe('#2033 — the accumulator row carries the compact timeline', () => {
  it('is set on a row first created already resolved', () => {
    const acc = accumulateMonthlyIncidents(null, [service([resolved()])], '2026-11', [])
    expect(rowOf(acc).timeline).toEqual(compactTimeline(resolved()))
  })

  it('is refreshed while the live timeline is present', () => {
    const first = accumulateMonthlyIncidents(null, [service([incident({})])], '2026-11', [])
    expect(rowOf(first).timeline).toHaveLength(1)
    const later = accumulateMonthlyIncidents(first, [service([resolved()])], '2026-11', [])
    expect(rowOf(later).timeline).toEqual(compactTimeline(resolved()))
  })

  it('keeps earlier updates when the source only serves the latest one (cloudflare-status shape)', () => {
    const first = accumulateMonthlyIncidents(null, [service([incident({})])], '2026-11', [])
    const lastOnly = resolved({ timeline: [RESOLVED[2]] })
    const later = accumulateMonthlyIncidents(first, [service([lastOnly])], '2026-11', [])
    expect(rowOf(later).timeline).toEqual([
      { at: '2026-11-10T08:00:00.000Z', stage: 'investigating', text: 'We are investigating elevated error rates.' },
      { at: '2026-11-10T09:00:00.000Z', stage: 'resolved' },
    ])
  })

  it('keeps one text, on the earliest entry that has one, when an earlier entry gains text later', () => {
    const blankFirst = [T('investigating', '2026-11-10T08:00:00.000Z', null), T('identified', '2026-11-10T08:20:00.000Z', 'Found it.')]
    const first = accumulateMonthlyIncidents(null, [service([incident({ timeline: blankFirst })])], '2026-11', [])
    const later = accumulateMonthlyIncidents(first, [service([incident({ timeline: OPEN })])], '2026-11', [])
    expect(rowOf(later).timeline).toEqual([
      { at: '2026-11-10T08:00:00.000Z', stage: 'investigating', text: 'We are investigating elevated error rates.' },
      { at: '2026-11-10T08:20:00.000Z', stage: 'identified' },
    ])
  })

  it('orders an update first seen late among the ones already stored', () => {
    const gap = [RESOLVED[0], RESOLVED[2]]
    const first = accumulateMonthlyIncidents(null, [service([resolved({ timeline: gap })])], '2026-11', [])
    const later = accumulateMonthlyIncidents(first, [service([resolved()])], '2026-11', [])
    expect(rowOf(later).timeline!.map(e => e.stage)).toEqual(['investigating', 'identified', 'resolved'])
  })

  it('keeps the stored text when the same update comes back without one (incident.io text cache miss)', () => {
    const withText = [T('investigating', '2026-11-10T08:00:00.000Z', 'First words'), T('identified', '2026-11-10T08:20:00.000Z', null)]
    const first = accumulateMonthlyIncidents(null, [service([incident({ timeline: withText })])], '2026-11', [])
    const textless = withText.map(e => ({ ...e, text: null }))
    const lost = accumulateMonthlyIncidents(first, [service([incident({ timeline: textless })])], '2026-11', [])
    expect(rowOf(lost).timeline![0].text).toBe('First words')
    const later = [textless[0], T('identified', '2026-11-10T08:20:00.000Z', 'Later words')]
    const moved = accumulateMonthlyIncidents(first, [service([incident({ timeline: later })])], '2026-11', [])
    expect(rowOf(moved).timeline).toEqual([
      { at: '2026-11-10T08:00:00.000Z', stage: 'investigating', text: 'First words' },
      { at: '2026-11-10T08:20:00.000Z', stage: 'identified' },
    ])
  })

  it('is kept when the live timeline comes back empty', () => {
    const first = accumulateMonthlyIncidents(null, [service([resolved()])], '2026-11', [])
    const later = accumulateMonthlyIncidents(first, [service([resolved({ timeline: [] })])], '2026-11', [])
    expect(rowOf(later).timeline).toEqual(compactTimeline(resolved()))
  })

  it('is absent on a row whose source has no timeline', () => {
    const acc = accumulateMonthlyIncidents(null, [service([resolved({ timeline: [] })])], '2026-11', [])
    expect(rowOf(acc)).not.toHaveProperty('timeline')
  })

  it('survives into the public emission', () => {
    const acc = accumulateMonthlyIncidents(null, [service([resolved()])], '2026-11', [])
    expect(stripInternalFields(rowOf(acc)).timeline).toEqual(compactTimeline(resolved()))
  })
})

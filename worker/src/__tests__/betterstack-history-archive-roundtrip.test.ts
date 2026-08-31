// #1292 — the guards must survive the ARCHIVE round-trip.
//
// `derived` is a property of HOW an incident was obtained, and nothing in a stored archive row
// reveals it — exactly the reason `autoMonitor` is persisted (#989). Without it, every guard the live
// path applies is silently bypassed the moment the row comes back: the MONTHLY Score computes MTTR
// from day-buckets while the live Score abstains, and `avgResolutionMin` — rendered as "avg recovery"
// in the monthly report and handed verbatim to the LLM narrative — publishes a fabricated figure.
//
// A source scan cannot pin this: the file legitimately names `derived` in its type and its read path,
// so deleting only the WRITE leaves any grep green. This drives the real functions instead.
import { describe, it, expect } from 'vitest'
import { accumulateMonthlyIncidents, computeMonthlyScore, aggregateIncidentDurations } from '../monthly-archive'
import { calculateAIWatchScore } from '../score'
import type { ServiceStatus, Incident } from '../types'

const PERIOD = '2026-08'
const WINDOW = { startISO: '2026-08-01T00:00:00.000Z', endISO: '2026-09-01T00:00:00.000Z' }

const incident = (over: Partial<Incident>): Incident => ({
  id: 'x', title: 't', status: 'resolved', impact: 'minor',
  startedAt: '2026-08-10T12:00:00.000Z', resolvedAt: '2026-08-10T20:00:00.000Z',
  duration: '8h 0m', timeline: [], ...over,
})

const svc = (incidents: Incident[]): ServiceStatus => ({
  id: 'helicone', name: 'Helicone', provider: 'Helicone', category: 'api', status: 'operational',
  latency: null, uptime30d: 96.68, lastChecked: WINDOW.startISO, incidents,
} as unknown as ServiceStatus)

const derived = incident({ id: 'bs-hist:1:2026-08-10', derived: 'status_history', duration: '17h 18m',
  resolvedAt: '2026-08-11T05:18:00.000Z' })
const real = incident({ id: 'rss-1', duration: '30m', resolvedAt: '2026-08-10T12:30:00.000Z' })

describe('#1292 — the derived tag survives accumulation', () => {
  it('persists on the stored entry, like autoMonitor', () => {
    const acc = accumulateMonthlyIncidents(null, [svc([derived, real])], PERIOD, [])
    const stored = acc.services.helicone.incidents ?? []
    expect(stored.find((e) => e.id === 'bs-hist:1:2026-08-10')?.derived).toBe('status_history')
    expect(stored.find((e) => e.id === 'rss-1')?.derived, 'a normal incident stays untagged').toBeUndefined()
  })

  it('keeps the MONTHLY Score from computing MTTR out of day-buckets', () => {
    // `computeMonthlyScore` exposes only {score, grade, confidence}, so the effect is asserted through
    // the score: with the tag the Recovery component abstains at full marks (no recovery sample), and
    // without it the day-bucket becomes an MTTR of ~17h and craters the same component.
    const acc = accumulateMonthlyIncidents(null, [svc([derived])], PERIOD, [])
    const entries = acc.services.helicone.incidents!
    const stripped = entries.map(({ derived: _drop, ...rest }) => rest)

    const tagged = computeMonthlyScore('helicone', entries, 96.68, new Map(), WINDOW, undefined)
    const untagged = computeMonthlyScore('helicone', stripped, 96.68, new Map(), WINDOW, undefined)

    expect(tagged.score, 'the tag must change the outcome, or it is not being read')
      .not.toBe(untagged.score)
    expect(tagged.score!, 'abstaining scores higher than billing a day-bucket as recovery')
      .toBeGreaterThan(untagged.score!)
  })

  it('excludes the day-bucket from the published "avg recovery"', () => {
    const acc = accumulateMonthlyIncidents(null, [svc([derived, real])], PERIOD, [])
    const entries = acc.services.helicone.incidents!
    const agg = aggregateIncidentDurations(entries, entries.length,
      acc.services.helicone.totalMinutes, acc.services.helicone.longestMinutes)
    // countedCount drives avgResolutionMin = totalMin / countedCount in the report builder.
    expect(agg.countedCount, 'only the real incident is a recovery sample').toBe(1)
  })

  it('keeps the day-bucket out of longestMin but IN totalMin', () => {
    // The three statistics ask different questions of the same number. `longestMin` is published as
    // MonthlyArchive.longestIncidentMin — "the month's longest INCIDENT" — and a day bucket is not one
    // incident: a multi-day outage banks as several rows, so it would report a 24h longest that no
    // incident ever had. `totalMin` is real downtime either way and must keep it.
    const acc = accumulateMonthlyIncidents(null, [svc([derived, real])], PERIOD, [])
    const entries = acc.services.helicone.incidents!
    const agg = aggregateIncidentDurations(entries, entries.length,
      acc.services.helicone.totalMinutes, acc.services.helicone.longestMinutes)

    expect(agg.longestMin, 'the 30m real incident is the longest INCIDENT, not the 17h18m day').toBe(30)
    expect(agg.totalMin, 'the day-bucket downtime is still published').toBe(1038 + 30)
  })

  it('derivedDay survives accumulation and drives the MONTHLY Score window', () => {
    // The string-level sync scan CANNOT catch this: `derivedDay: inc.derivedDay` (the write) and
    // `derivedDay: e.derivedDay` (the read in computeMonthlyScore) match the same regex, so deleting
    // the read alone leaves it green — verified. Only reading the STORED entries back through the
    // real scorer does.
    //
    // What breaks without it: `calculateAIWatchScore`'s window keys on the tag AND the day, so a
    // dropped day falls back to `startedAt` — the page-local anchor. For a page past UTC+12 that
    // anchor is the previous UTC day, so a January outage is banked in January by the accumulator and
    // scored in NEITHER month here. This is the path the reports site publishes.
    //
    // Five days, not one: a single row moves the Score by ~0.7 points, which rounds away. The defect
    // is the same size either way; the fixture has to be large enough to observe it.
    const janWindow = { startISO: '2026-01-01T00:00:00.000Z', endISO: '2026-02-01T00:00:00.000Z' }
    const nzdt = Array.from({ length: 5 }, (_, i) => {
      const day = `2026-01-0${i + 1}`
      return incident({
        id: `bs-hist:1:${day}`, derived: 'status_history', derivedDay: day,
        // NZDT (UTC+13): local noon is 23:00Z on the PREVIOUS day.
        startedAt: `2025-12-3${i === 0 ? '1' : '1'}T23:00:00.000Z`.replace('12-31', i === 0 ? '12-31' : `01-0${i}`),
        resolvedAt: `${day}T16:18:00.000Z`, duration: '17h 18m',
      })
    })

    const acc = accumulateMonthlyIncidents(null, [svc(nzdt)], '2026-01', [])
    const entries = acc.services.helicone.incidents!
    expect(entries, 'all five must be banked in January').toHaveLength(5)
    expect(entries.every((e) => typeof e.derivedDay === 'string'),
      'the day must be PERSISTED, not just the tag').toBe(true)

    // Score the STORED entries — not the live incidents — which is what buildMonthlyArchive does.
    const withDay = computeMonthlyScore('helicone', entries, 96.68, new Map(), janWindow, undefined)
    const withoutDay = computeMonthlyScore('helicone',
      entries.map(({ derivedDay: _drop, ...rest }) => rest), 96.68, new Map(), janWindow, undefined)

    expect(withDay.score, 'the stored day must change the outcome, or it is not being read')
      .not.toBe(withoutDay.score)
    expect(withoutDay.score!, 'without the day these outages are scored in no month at all')
      .toBeGreaterThan(withDay.score!)
  })

  it('the accumulator and the Score select the SAME rows for a month', () => {
    // The failure this pins: on a page past UTC+12 the noon anchor falls on the previous UTC day, so
    // an incident stated for the 1st was banked into the month by `accumulateMonthlyIncidents` (which
    // keys on `incidentDay`) and windowed OUT by `calculateAIWatchScore` (which sliced `startedAt`).
    // Stored in one month, scored in neither.
    const janWindow = { startISO: '2026-01-01T00:00:00.000Z', endISO: '2026-02-01T00:00:00.000Z' }
    const nzdt = incident({ id: 'bs-hist:1:2026-01-01', derived: 'status_history',
      derivedDay: '2026-01-01', startedAt: '2025-12-31T23:00:00.000Z',
      resolvedAt: '2026-01-01T16:18:00.000Z', duration: '17h 18m' })

    const acc = accumulateMonthlyIncidents(null, [svc([nzdt])], '2026-01', [])
    expect(acc.services.helicone?.incidentIds, 'the accumulator banks it in January').toContain('bs-hist:1:2026-01-01')

    const scored = calculateAIWatchScore(svc([nzdt]), 30, { kind: 'unsupported' }, janWindow)
    expect(scored.metrics.affectedDays30d, 'the Score must see the same January row').toBe(1)
  })

  it('does not inflate "avg recovery" by dividing a total that carries day-buckets', () => {
    // The #1210 defect, re-entered from a new direction: `avgResolutionMin = total / countedCount`.
    // Once a day-bucket counts toward `total` but not toward `countedCount`, a single 30m incident
    // beside three day-buckets publishes an "avg recovery" in the tens of hours. Numerator and
    // divisor must range over the SAME rows.
    const acc = accumulateMonthlyIncidents(null, [svc([derived, real])], PERIOD, [])
    const entries = acc.services.helicone.incidents!
    const agg = aggregateIncidentDurations(entries, entries.length,
      acc.services.helicone.totalMinutes, acc.services.helicone.longestMinutes)

    expect(agg.countedTotalMin, 'only the real 30m incident is a recovery sample').toBe(30)
    expect(agg.totalMin, 'the published downtime still carries the day-bucket').toBe(1038 + 30)
    expect(Math.round(agg.countedTotalMin! / agg.countedCount!), 'avg recovery is 30m, not 17h').toBe(30)
  })

  it('reports no longest at all when every row is a day-bucket', () => {
    const acc = accumulateMonthlyIncidents(null, [svc([derived])], PERIOD, [])
    const entries = acc.services.helicone.incidents!
    const agg = aggregateIncidentDurations(entries, entries.length,
      acc.services.helicone.totalMinutes, acc.services.helicone.longestMinutes)

    expect(agg.longestMin, 'inventing a longest incident from a day bucket is the defect').toBeNull()
    expect(agg.totalMin, 'the downtime is still real').toBe(1038)
  })
})

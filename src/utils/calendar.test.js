// Force a known east-of-UTC timezone so a UTC-evening impact provably falls on the NEXT local day.
// Set before importing the module under test so Date methods read it. (#693 follow-up)
const ORIG_TZ = process.env.TZ
process.env.TZ = 'Asia/Seoul' // UTC+9

import { describe, it, expect, afterAll } from 'vitest'
import { buildCalendarFromIncidents } from './calendar'

// Restore TZ so this file's global side effect can't leak into other date-sensitive test files
// sharing the same vitest worker.
afterAll(() => {
  if (ORIG_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIG_TZ
})

// Map the status array (oldest→newest) back to { localDateKey: status } using the same
// today-relative formula the builder uses, so assertions are date-keyed and not index-fragile.
function calMap(arr, days) {
  const today = new Date()
  const m = {}
  arr.forEach((status, i) => {
    const d = new Date(today.getTime() - (days - 1 - i) * 86_400_000)
    m[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = status
  })
  return m
}

const localKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

describe('buildCalendarFromIncidents — dailyImpact key bucketing (#693 follow-up)', () => {
  it('an incident.io ISO key in the UTC evening buckets to the NEXT local day (KST), not the UTC day', () => {
    const now = new Date()
    // 3 days ago at 18:05 UTC → 03:05 next day in KST.
    const utcEvening = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3, 18, 5, 0))
    const iso = utcEvening.toISOString()
    const utcDay = iso.slice(0, 10)
    const localDay = localKey(utcEvening)
    expect(localDay).not.toBe(utcDay) // sanity: TZ stub took effect (+9 shifts the day)

    const m = calMap(buildCalendarFromIncidents([], { [iso]: 'minor' }, 30, 'operational'), 30)
    expect(m[localDay]).toBe('minor') // bucketed to the real local day…
    expect(m[utcDay]).toBe('operational') // …NOT the UTC day (the off-by-one this fix removes)
  })

  // The bare-UTC-date-key noon-anchor case moved to the #1400 describe block below, alongside the
  // incident-precedence rule it now falls back to.
})

describe('buildCalendarFromIncidents — prefer an incident\'s own precise local day over a bare-UTC-date guess (#1400)', () => {
  it('a bare-UTC-date dailyImpact service (Rootly/Flashduty) paints the incident\'s own local day, not the UTC day, and not both', () => {
    const now = new Date()
    // 3 days ago at 22:00 UTC → next day in KST (07:00). Mirrors the real Mistral incident
    // (2026-09-10T16:50:00Z, dailyImpact "2026-09-10": "major") that motivated this fix. The
    // Incident History card already shows this incident's LOCAL time — the calendar must agree
    // with it, not with the UTC day dailyImpact happens to be keyed under.
    const utcEvening = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3, 22, 0, 0))
    const utcDay = utcEvening.toISOString().slice(0, 10)
    const localDay = localKey(utcEvening)
    expect(localDay).not.toBe(utcDay) // sanity: the TZ stub actually shifts the day

    const dailyImpact = { [utcDay]: 'major' }
    const incidents = [{ startedAt: utcEvening.toISOString(), impact: 'major', resolvedAt: new Date(utcEvening.getTime() + 3_600_000).toISOString() }]
    const m = calMap(buildCalendarFromIncidents(incidents, dailyImpact, 14, 'operational'), 14)

    expect(m[localDay]).toBe('major') // the incident's own precise local day, matching Incident History
    expect(m[utcDay]).toBe('operational') // NOT the raw UTC day dailyImpact happens to be keyed under
  })

  it('a bare-UTC-date dailyImpact day with NO matching incident falls back to the noon-UTC guess', () => {
    const now = new Date()
    const dateKey = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3)).toISOString().slice(0, 10)
    // No incidents at all — nothing precise to defer to, so Phase 1 must fall back to its guess.
    const m = calMap(buildCalendarFromIncidents([], { [dateKey]: 'major' }, 30, 'operational'), 30)
    expect(m[dateKey]).toBe('major')
  })

  it('an incident.io-style service (full-ISO dailyImpact) still gets a Phase-2 supplement for an incident dailyImpact does not cover', () => {
    const now = new Date()
    // dailyImpact covers a DIFFERENT, earlier day (5 days ago) — so ONLY Phase 2 can paint the
    // incident's own day (3 days ago). A prior version of this test used the SAME day for both,
    // which passed even with Phase 2 deleted outright (Phase 1 alone painted it) — this one can't.
    const dailyImpactDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 5, 5, 0, 0))
    const utcEvening = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3, 22, 0, 0))
    const localDay = localKey(utcEvening)

    const dailyImpact = { [dailyImpactDay.toISOString()]: 'minor' }
    const incidents = [{ startedAt: utcEvening.toISOString(), impact: 'major', resolvedAt: new Date(utcEvening.getTime() + 3_600_000).toISOString() }]
    const m = calMap(buildCalendarFromIncidents(incidents, dailyImpact, 14, 'operational'), 14)

    // Phase 2 buckets to the LOCAL day (unchanged #693 behavior), because the incident's bare UTC-day
    // string has no matching entry in this full-ISO-keyed dailyImpact.
    expect(m[localDay]).toBe('major')
  })

  it('a service with a MIXED-shape dailyImpact (a full-ISO live map merged with archived bare-UTC-date entries) still agrees per-incident, not per-map', () => {
    const now = new Date()
    const utcEvening = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3, 22, 0, 0))
    const utcDay = utcEvening.toISOString().slice(0, 10)
    const localDay = localKey(utcEvening)
    expect(localDay).not.toBe(utcDay)

    // A full-ISO entry on an unrelated day (simulating the live incident.io map) PLUS a bare-date
    // entry for the incident's own day (simulating an archived-and-merged record) — sampling only the
    // first key would have picked the full-ISO shape and mis-anchored this incident.
    const dailyImpact = {
      [new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 8, 5, 0, 0)).toISOString()]: 'minor',
      [utcDay]: 'major',
    }
    const incidents = [{ startedAt: utcEvening.toISOString(), impact: 'major', resolvedAt: new Date(utcEvening.getTime() + 3_600_000).toISOString() }]
    const m = calMap(buildCalendarFromIncidents(incidents, dailyImpact, 14, 'operational'), 14)

    expect(m[localDay]).toBe('major') // the bare entry defers to its matching incident's local day
    expect(m[utcDay]).toBe('operational') // NOT the raw UTC-day key
  })

  it('a `status_history`-derived incident\'s SYNTHETIC startedAt is not treated as a real instant (Together AI "recovered" entries)', () => {
    const now = new Date()
    // Mirrors the real Together AI incident: dailyImpact "2026-09-11": "minor", but the derived
    // incident's synthetic `startedAt` is 19:00Z on that SAME day — which, naively converted to KST,
    // crosses into the NEXT local day (04:00 the following morning). derivedDay stays "the" day.
    const derivedDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3)).toISOString().slice(0, 10)
    const syntheticAnchor = new Date(`${derivedDay}T19:00:00.000Z`)
    const wrongLocalDay = localKey(syntheticAnchor)
    expect(wrongLocalDay).not.toBe(derivedDay) // sanity: naive conversion WOULD cross midnight

    const dailyImpact = { [derivedDay]: 'minor' }
    const incidents = [{
      startedAt: syntheticAnchor.toISOString(),
      resolvedAt: new Date(syntheticAnchor.getTime() + 30 * 60_000).toISOString(),
      impact: 'minor',
      derived: 'status_history',
      derivedDay,
    }]
    const m = calMap(buildCalendarFromIncidents(incidents, dailyImpact, 30, 'operational'), 30)

    expect(m[derivedDay]).toBe('minor') // stays on its real day (the noon-UTC guess, via derivedDay)
    expect(m[wrongLocalDay]).toBe('operational') // NOT pulled forward by the synthetic anchor's local time
  })

  it('Phase 2\'s single-day branch also does not locally-bucket a derived incident\'s synthetic anchor', () => {
    const now = new Date()
    const derivedDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3)).toISOString().slice(0, 10)
    const syntheticAnchor = new Date(`${derivedDay}T19:00:00.000Z`)
    const wrongLocalDay = localKey(syntheticAnchor)

    // dailyImpact covers a DIFFERENT day only, so Phase 1 doesn't touch derivedDay at all — isolating
    // Phase 2's own `incidentLocalDay` handling (dailyImpact truthy is what routes a RESOLVED derived
    // incident into Phase 2's single-day branch rather than its multi-day spanning branch).
    const unrelatedDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 9)).toISOString().slice(0, 10)
    const dailyImpact = { [unrelatedDay]: 'major' }
    const incidents = [{
      startedAt: syntheticAnchor.toISOString(),
      resolvedAt: new Date(syntheticAnchor.getTime() + 30 * 60_000).toISOString(),
      impact: 'minor',
      derived: 'status_history',
      derivedDay,
    }]
    const m = calMap(buildCalendarFromIncidents(incidents, dailyImpact, 14, 'operational'), 14)

    expect(m[derivedDay]).toBe('minor')
    expect(m[wrongLocalDay]).toBe('operational')
  })

  it('a bare-UTC-date dailyImpact entry falls back to the noon-UTC guess when SEVERAL matching incidents disagree on local day (Mistral 2026-09-04 review finding)', () => {
    const now = new Date()
    // Two unrelated incidents share one UTC day but straddle a local midnight between them — the
    // first one encountered (list order) must NOT win by default; with `calendarDays: 30` Phase 2 is
    // skipped entirely, so this isolates Phase 1's own day-choice with nothing else able to paint
    // either day and mask a wrong answer.
    const utcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 5)).toISOString().slice(0, 10)
    const lateUtc = new Date(`${utcDay}T22:00:00.000Z`) // local day rolls over (KST, UTC+9)
    const earlyUtc = new Date(`${utcDay}T01:00:00.000Z`) // stays on the same local day
    expect(localKey(lateUtc)).not.toBe(localKey(earlyUtc)) // sanity: they really do disagree

    const dailyImpact = { [utcDay]: 'minor' }
    const incidents = [
      { startedAt: lateUtc.toISOString(), impact: 'minor', resolvedAt: new Date(lateUtc.getTime() + 60_000).toISOString() },
      { startedAt: earlyUtc.toISOString(), impact: 'minor', resolvedAt: new Date(earlyUtc.getTime() + 60_000).toISOString() },
    ]
    const m = calMap(buildCalendarFromIncidents(incidents, dailyImpact, 30, 'operational'), 30)

    // The noon-UTC guess for utcDay itself — NOT either incident's own local day, and NOT dropped.
    expect(m[utcDay]).toBe('minor')
  })
})

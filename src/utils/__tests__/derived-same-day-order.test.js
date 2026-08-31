// #1292 — the order of two status_history-derived incidents on the SAME day.
//
// They share one anchor (page-local noon), so the activity axis reduces to `anchor + duration` and two
// rows displaying the same duration end up separated by the sub-second float in `downtime_duration` —
// 62ms apart on helicone's real Aug 16 pair, with nothing on screen to explain the order. The rule is
// now stated: longest first, then resource name, at the minute the row DISPLAYS.
//
// Driven through the REAL page pipeline, not through a comparator in isolation. The first shape of
// this change put the rule in `compareIncidents` and pinned it that way; review reproduced that every
// page renders `groupIncidents(...)` output, which re-sorts by `getLatestActivity` and overwrites it —
// and that `ServiceDetails.jsx`, the page the whole issue is about, never calls `compareIncidents` at
// all. The rule was dead on all three pages while this file was green. So each assertion below runs
// the same call the page runs.
import { describe, it, expect } from 'vitest'
import { groupIncidents } from '../incidentGrouping'
import { compareGroupedRows, displayedMinutes } from '../incidentSort'
import { groupIncidents as edgeGroupIncidents } from '../../../api/_is-down/incident-grouping'

const NOON_16 = '2026-08-16T21:00:00.000Z' // helicone's page is America/Adak (UTC-9): local noon
const NOON_15 = '2026-08-15T21:00:00.000Z'
const H = 3_600_000
const M = 60_000

const derived = (title, day, startedAt, ms) => ({
  id: `bs-hist:${title}:${day}`, title, status: 'resolved', impact: 'minor',
  startedAt, resolvedAt: new Date(new Date(startedAt).getTime() + ms).toISOString(),
  timeline: [], derived: 'status_history', derivedDay: day,
})

// The Aug 16 pair, with the millisecond ordering INVERTED against the name ordering on purpose: `eu…`
// resolves 62ms LATER, so the activity axis puts it first. Both rows still display "11h 36m". Built
// from the production numbers as-is, the ms order and the name order agree and the fixture would pass
// against no rule at all.
const AUG16_API = derived('api.hconeai.com — recovered', '2026-08-16', NOON_16, 11 * H + 36 * M + 30)
const AUG16_EU = derived('eu.api.helicone.ai — recovered', '2026-08-16', NOON_16, 11 * H + 36 * M + 92)
// The Aug 15 pair, straight from production: 24h 0m against 6h 56m.
const AUG15_EU = derived('eu.api.helicone.ai — recovered', '2026-08-15', NOON_15, 24 * H)
const AUG15_API = derived('api.hconeai.com — recovered', '2026-08-15', NOON_15, 6 * H + 56 * M)

// A pair STRADDLING the two roundings: 696m exactly floors AND ceils to 696; 695m+900ms floors to 695
// but ceils to 696. So `ceil` ties them (the name decides, `aaa` first) while `floor` separates them
// (the 696m row `zzz` first) — the names are set against the duration order so the two answers differ.
// Every rounding assertion below runs on THIS pair; a pair inside one bucket discriminates nothing,
// which a first version of this file got wrong and a mutation caught.
const STRADDLE_LONGER_NAME_LAST = derived('zzz — recovered', '2026-08-16', NOON_16, 696 * M)
const STRADDLE_SHORTER_NAME_FIRST = derived('aaa — recovered', '2026-08-16', NOON_16, 695 * M + 900)

/** Exactly what Incidents.jsx / ServiceDetails.jsx / Overview.jsx render. */
const pageOrder = (list) => groupIncidents(list).slice().sort(compareGroupedRows)
  .map((r) => (r.kind === 'single' ? r.incident.title : r.normalizedTitle))

/** Exactly what the is-down card renders (api/_is-down/html-template.ts). */
const edgeOrder = (list) => edgeGroupIncidents(list).slice().sort(compareGroupedRows)
  .map((r) => (r.kind === 'single' ? r.incident.title : r.normalizedTitle))

describe('#1292 — same-day derived incidents order by duration, then name', () => {
  it('puts the LONGER outage first within a day, on the rendered path', () => {
    expect(pageOrder([AUG15_API, AUG15_EU])[0]).toBe(AUG15_EU.title)
    expect(pageOrder([AUG15_EU, AUG15_API])[0]).toBe(AUG15_EU.title) // input order irrelevant
  })

  it('falls to the resource NAME when the displayed durations tie, not to sub-second downtime', () => {
    // Both read "11h 36m"; `eu…` resolves 62ms later. The activity axis would surface it first — a
    // difference no reader can see. This is the assertion that was green on a dead path before.
    expect(pageOrder([AUG16_EU, AUG16_API])).toEqual([AUG16_API.title, AUG16_EU.title])
    expect(pageOrder([AUG16_API, AUG16_EU])).toEqual([AUG16_API.title, AUG16_EU.title])
  })

  it('orders the Edge card identically — the two mirrors do not drift', () => {
    // `api/_is-down/incident-grouping.ts` carries its own copy (the Edge bundle cannot import src/).
    // Driving both through their own pipelines is what makes "they agree" a check rather than a claim.
    expect(edgeOrder([AUG16_EU, AUG16_API])).toEqual(pageOrder([AUG16_EU, AUG16_API]))
    expect(edgeOrder([AUG15_API, AUG15_EU])).toEqual(pageOrder([AUG15_API, AUG15_EU]))
    // The straddling pair, or this assertion cannot see the ROUNDING drifting: on the two production
    // pairs above, `ceil` and `floor` return the same order, so flipping the Edge copy alone was
    // invisible here until this line existed (found by mutation).
    const straddle = [STRADDLE_LONGER_NAME_LAST, STRADDLE_SHORTER_NAME_FIRST]
    expect(edgeOrder(straddle)).toEqual(pageOrder(straddle))
    expect(edgeOrder(straddle)).toEqual([STRADDLE_SHORTER_NAME_FIRST.title, STRADDLE_LONGER_NAME_LAST.title])
  })

  it('compares at the DISPLAYED minute, so a row never sorts below a shorter-reading one', () => {
    // The two rounding failures reproduced in review, both reachable only when a pair straddles an
    // exact minute boundary inside the sub-second gap — the regime these floats live in.
    // A: the straddling pair — see its definition for why a same-bucket pair discriminates nothing.
    expect(displayedMinutes(696 * M)).toBe(displayedMinutes(695 * M + 900))
    expect(pageOrder([STRADDLE_LONGER_NAME_LAST, STRADDLE_SHORTER_NAME_FIRST]))
      .toEqual([STRADDLE_SHORTER_NAME_FIRST.title, STRADDLE_LONGER_NAME_LAST.title]) // name, not the 100ms
    // B: different displayed minute → the longer-READING row must come first.
    const bShort = derived('aaa — recovered', '2026-08-16', NOON_16, 695 * M + 900)
    const bLong = derived('zzz — recovered', '2026-08-16', NOON_16, 696 * M + 100)
    expect(displayedMinutes(696 * M + 100)).toBeGreaterThan(displayedMinutes(695 * M + 900))
    expect(pageOrder([bShort, bLong])).toEqual([bLong.title, bShort.title])
  })

  it('still orders DAYS newest-first — the rule is within a day only', () => {
    const order = pageOrder([AUG15_EU, AUG16_API, AUG15_API, AUG16_EU])
    expect(order.slice(0, 2)).toEqual([AUG16_API.title, AUG16_EU.title])
    // Aug 15's 24h row resolves exactly on Aug 16's anchor; it must not leapfrog an Aug 16 row.
    expect(order[2]).toBe(AUG15_EU.title)
  })

  it('leaves ORDINARY incidents on the activity axis', () => {
    // Guards the rule against widening past derived rows: later resolution wins, name irrelevant.
    const a = { ...derived('zzz service', '2026-08-16', NOON_16, 1 * H), derived: undefined, derivedDay: undefined }
    const b = { ...derived('aaa service', '2026-08-16', NOON_16, 2 * H), derived: undefined, derivedDay: undefined }
    expect(pageOrder([a, b])).toEqual(['aaa service', 'zzz service']) // b resolves later → first
  })

  it('never lifts a derived row above an ongoing one', () => {
    const ongoing = { ...AUG16_API, id: 'live', status: 'ongoing', resolvedAt: null }
    expect(pageOrder([AUG15_EU, ongoing])[0]).toBe(ongoing.title)
  })
})

// #1480 — `zeroLengthRecord` must survive every boundary a #1480 incident crosses, or the dashboard
// tells an archive-served row the #1390 story: "the provider published a recovery before its start,
// and no impact window was available". A zero-length record never said that.
//
// Both populations store `startedAt === resolvedAt` — #1390 collapses them, #1480 had them equal
// already — so the flag CANNOT be re-derived from a frozen row. `monthly-archive.ts`'s own `derived`
// docblock states the rule this pins: a guard that is not persisted is silently bypassed the moment
// the row round-trips through the archive.
//
// The boundaries are asserted as a CHAIN rather than one by one: a new boundary added between two of
// these links fails here without anyone remembering this file exists.
import { describe, it, expect } from 'vitest'
import { accumulateMonthlyIncidents, buildPartialIncidentArchive } from '../monthly-archive'
import { mergeRetainedIncidentHistory } from '../services'
import { markZeroLengthResolvedIncidentsUnknown } from '../utils'
import type { ServiceStatus } from '../types'

const at = '2026-09-11T08:00:00.000Z'

/** A resolved record whose source gave one instant for both ends — the shape every #1480 source emits. */
function serviceWithZeroLength(): ServiceStatus {
  const incidents = markZeroLengthResolvedIncidentsUnknown([{
    id: 'zl-1', title: 'Service disruption', status: 'resolved', impact: 'major',
    startedAt: at, resolvedAt: at, duration: '1m', timeline: [],
  }] as never)
  return {
    id: 'azureopenai', name: 'Azure OpenAI', provider: '', category: 'api', status: 'operational',
    latency: null, uptime30d: null, lastChecked: at, incidents,
  } as unknown as ServiceStatus
}

describe('#1480 zeroLengthRecord survives the archive round trip', () => {
  it('the producer sets it alongside startUnknown', () => {
    const [inc] = serviceWithZeroLength().incidents
    expect(inc).toMatchObject({ startUnknown: true, zeroLengthRecord: true, duration: null })
  })

  it('the accumulator banks it on a NEW entry', () => {
    const acc = accumulateMonthlyIncidents(null, [serviceWithZeroLength()], '2026-09', [])
    const [entry] = acc.services.azureopenai.incidents!
    expect(entry, 'a first-seen zero-length incident lost the flag on the way into the accumulator')
      .toMatchObject({ id: 'zl-1', startUnknown: true, zeroLengthRecord: true })
  })

  it('the accumulator ADDS it to a row banked before the fix shipped', () => {
    // The live case on deploy day: September already holds these ids with the fabricated `1m` and no
    // flag. Re-presenting the same incident is what upgrades the stored row — asserting a row that was
    // already flagged proves nothing, because the update branch is skipped either way.
    const preFix = {
      ...serviceWithZeroLength(),
      incidents: [{
        id: 'zl-1', title: 'Service disruption', status: 'resolved', impact: 'major',
        startedAt: at, resolvedAt: at, duration: '1m', timeline: [],
      }],
    } as unknown as ServiceStatus
    const banked = accumulateMonthlyIncidents(null, [preFix], '2026-09', [])
    expect(banked.services.azureopenai.incidents![0].zeroLengthRecord).toBeUndefined()

    const after = accumulateMonthlyIncidents(banked, [serviceWithZeroLength()], '2026-09', [])
    expect(after.services.azureopenai.incidents![0], 'a pre-fix row never gains the flag')
      .toMatchObject({ startUnknown: true, zeroLengthRecord: true })
  })

  it('the accumulator CLEARS it when the provider later publishes a real window', () => {
    // The `else delete` half. Without it the row keeps `zeroLengthRecord` while correctly losing
    // `startUnknown` — and since the archive→live duration gates on `startUnknown` alone while the
    // note gates on `zeroLengthRecord` alone, the card would show a real duration beside a note
    // saying no duration is derivable.
    const banked = accumulateMonthlyIncidents(null, [serviceWithZeroLength()], '2026-09', [])
    expect(banked.services.azureopenai.incidents![0]).toMatchObject({ zeroLengthRecord: true })

    const corrected = {
      ...serviceWithZeroLength(),
      incidents: [{
        id: 'zl-1', title: 'Service disruption', status: 'resolved', impact: 'major',
        startedAt: at, resolvedAt: '2026-09-11T09:30:00.000Z', duration: '1h 30m', timeline: [],
      }],
    } as unknown as ServiceStatus
    const after = accumulateMonthlyIncidents(banked, [corrected], '2026-09', [])
    const entry = after.services.azureopenai.incidents![0]
    expect(entry.startUnknown, 'a real window must clear the #1390/#1480 flag').toBeUndefined()
    expect(entry.zeroLengthRecord, 'the stale zero-length flag outlived the shape that set it').toBeUndefined()
  })

  it('the /api/report partial projection carries it — the frozen-month emit shares stripInternalFields', () => {
    const acc = accumulateMonthlyIncidents(null, [serviceWithZeroLength()], '2026-09', [])
    const projected = buildPartialIncidentArchive('2026-09', acc)
    const [out] = projected.services.azureopenai.incidentList
    expect(out, 'the frozen row cannot say which population it is without this flag')
      .toMatchObject({ id: 'zl-1', startUnknown: true, zeroLengthRecord: true })
  })

  it('the retained-history bridge carries it back into the live list', () => {
    const acc = accumulateMonthlyIncidents(null, [serviceWithZeroLength()], '2026-09', [])
    const entries = acc.services.azureopenai.incidents!
    const [bridged] = mergeRetainedIncidentHistory([], entries, '2026-08-01T00:00:00.000Z')
    expect(bridged, 'the bridge re-enters the live list without the flag, so it gets the #1390 note')
      .toMatchObject({ id: 'zl-1', startUnknown: true, zeroLengthRecord: true })
  })
})

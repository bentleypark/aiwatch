import { describe, it, expect } from 'vitest'
import { incidentMeta } from '../is-down-group'
import { groupIncidents, GROUP_THRESHOLD, type GroupingIncident } from '../_is-down/incident-grouping'

/**
 * #1292 — BEHAVIOURAL cover for the two Edge guards.
 *
 * Both were registered as applying the derived rule and neither was enforced: deleting the guard in
 * `is-down-group.ts` or `_is-down/incident-grouping.ts` left the whole front-end suite green. The
 * string-level sync test could not catch it, because the token it looked for (`derived`) is supplied
 * by the interface DECLARATION each file carries — so the check passed on the type line alone. These
 * tests call the functions instead.
 */
describe('is-down-group incidentMeta', () => {
  const base = { members: [], title: 'api — recovered', status: 'resolved' as const, duration: '17h 18m' }

  it('says "down … that day", never "resolved after" — the duration is a day total', () => {
    const meta = incidentMeta({ ...base, startedAt: '2026-07-24T12:00:00.000Z',
      derived: 'status_history', derivedDay: '2026-07-24' })
    expect(meta).toContain('down 17h 18m that day')
    expect(meta).not.toContain('resolved after')
  })

  it('prints the STATED day, not the day the anchor falls on', () => {
    // A page past UTC+12 anchors 2026-07-24 at 2026-07-23T23:00Z. Reading the date off the anchor
    // publishes 07-23 for an 07-24 downtime bucket.
    const meta = incidentMeta({ ...base, startedAt: '2026-07-23T23:00:00.000Z',
      derived: 'status_history', derivedDay: '2026-07-24' })
    expect(meta).toContain('2026-07-24')
    expect(meta).not.toContain('2026-07-23')
  })

  it('CONTROL — a provider-published incident still reads "resolved after"', () => {
    const meta = incidentMeta({ ...base, startedAt: '2026-07-24T12:00:00.000Z' })
    expect(meta).toContain('resolved after 17h 18m')
    expect(meta).not.toContain('that day')
  })
})

describe('_is-down/incident-grouping groupIncidents', () => {
  // Same (resource, day) and an identical flap title, repeated past the grouping threshold: exactly
  // what WOULD collapse into one "×N" row. A synthesized incident must never take that path — a group
  // range is rendered from two anchors and carries no day-only treatment.
  const flap = (i: number): GroupingIncident => ({
    id: `bs-hist:1:2026-07-2${i}`, title: 'api.hconeai.com — recovered', status: 'resolved',
    impact: 'minor', startedAt: `2026-07-24T1${i}:00:00.000Z`, resolvedAt: `2026-07-24T1${i}:30:00.000Z`,
    duration: '30m',
  })
  const many = Array.from({ length: GROUP_THRESHOLD + 1 }, (_, i) => flap(i))

  it('CONTROL — identical flaps on one day DO group', () => {
    const rows = groupIncidents(many, 'UTC')
    expect(rows.some((r) => 'count' in r && r.count >= GROUP_THRESHOLD), 'the fixture must be groupable').toBe(true)
  })

  it('the same set tagged status_history does NOT group', () => {
    const rows = groupIncidents(many.map((i) => ({ ...i, derived: 'status_history' as const, derivedDay: '2026-07-24' })), 'UTC')
    expect(rows.some((r) => 'count' in r), 'a synthesized incident was folded into a ×N row').toBe(false)
    expect(rows).toHaveLength(many.length)
  })

  it('a synthesized incident does not absorb a real one into a group either', () => {
    const mixed = [...many.slice(0, GROUP_THRESHOLD).map((i) => ({ ...i, derived: 'status_history' as const })), flap(9)]
    const rows = groupIncidents(mixed, 'UTC')
    expect(rows.some((r) => 'count' in r)).toBe(false)
  })
})

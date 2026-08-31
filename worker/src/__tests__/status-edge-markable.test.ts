import { describe, it, expect } from 'vitest'
import { isMarkableOnStatusEdge } from '../recovery-mark'
import { incidentDay, statedDay } from '../utils'

/**
 * #1292 — the status-edge recovery path maps over the service's WHOLE incident list, so every
 * `status_history`-derived incident on it (up to 30 at once, one per downtime day in the window) would
 * take a `recovered:` marker from a single edge and light the "Recently Resolved" banner claiming a
 * recovery moment the per-day source never stated. The `alerted:res:` path is safe by construction —
 * a derived incident is born `resolved`, so it never fires an `alerted:new:` and never enters
 * `alertedNewMap` — which is exactly why the guard belongs here and not there.
 */
describe('isMarkableOnStatusEdge', () => {
  const base = { id: 'x', status: 'resolved' as const }

  it('marks a real resolved incident', () => {
    expect(isMarkableOnStatusEdge(base)).toBe(true)
  })

  it('marks a monitoring incident (#1003 treats both as terminal)', () => {
    expect(isMarkableOnStatusEdge({ ...base, status: 'monitoring' })).toBe(true)
  })

  it('REFUSES a status_history-derived incident even though it is resolved', () => {
    expect(isMarkableOnStatusEdge({ ...base, derived: 'status_history' })).toBe(false)
  })

  it('refuses a still-running incident (#1003)', () => {
    for (const status of ['investigating', 'identified', 'active', undefined]) {
      expect(isMarkableOnStatusEdge({ ...base, status }), `status=${status}`).toBe(false)
    }
  })

  it('the two exclusions are independent — a derived incident is refused at every status', () => {
    for (const status of ['resolved', 'monitoring', 'investigating']) {
      expect(isMarkableOnStatusEdge({ status, derived: 'status_history' }), status).toBe(false)
    }
  })
})

/**
 * #1292 — `derivedDay` and the `derived` tag are a PAIR. Every producer and forwarder writes both or
 * neither, and both day-consumers key on the tag rather than on the field's presence — so a stray
 * `derivedDay` on a provider-published incident cannot silently re-bucket it.
 */
describe('incidentDay', () => {
  it('reads derivedDay for a tagged incident', () => {
    expect(incidentDay({ startedAt: '2026-07-23T23:00:00.000Z', derived: 'status_history', derivedDay: '2026-07-24' }))
      .toBe('2026-07-24')
  })

  it('IGNORES a derivedDay that arrives without the tag', () => {
    expect(incidentDay({ startedAt: '2026-07-23T23:00:00.000Z', derivedDay: '2026-07-24' }))
      .toBe('2026-07-23')
  })

  it('falls back to the UTC date of startedAt for an ordinary incident', () => {
    expect(incidentDay({ startedAt: '2026-07-23T23:00:00.000Z' })).toBe('2026-07-23')
  })

  it('falls back when the tag is present but the day was dropped in transit', () => {
    expect(incidentDay({ startedAt: '2026-07-23T23:00:00.000Z', derived: 'status_history' }))
      .toBe('2026-07-23')
  })
})

describe('statedDay — the one copy of the pair rule', () => {
  it('returns the day only when the tag vouches for it', () => {
    expect(statedDay({ derived: 'status_history', derivedDay: '2026-07-24' })).toBe('2026-07-24')
    expect(statedDay({ derivedDay: '2026-07-24' }), 'a lone day is not vouched for').toBeNull()
    expect(statedDay({ derived: 'status_history' }), 'a lone tag states no day').toBeNull()
    expect(statedDay({}), 'a provider-published incident states none').toBeNull()
  })

  it('is what incidentDay is built on, so the two can never disagree', () => {
    const tagged = { startedAt: '2026-07-23T23:00:00.000Z', derived: 'status_history', derivedDay: '2026-07-24' }
    expect(incidentDay(tagged)).toBe(statedDay(tagged))

    const plain = { startedAt: '2026-07-23T23:00:00.000Z', derived: undefined }
    expect(statedDay(plain)).toBeNull()
    expect(incidentDay(plain), 'falls back to the anchor only when no day is stated').toBe('2026-07-23')
  })
})

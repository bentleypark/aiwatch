import { describe, it, expect } from 'vitest'
import { computeFlashdutyUptime } from '../flashduty'

// #1017 — computeFlashdutyUptime had zero direct value-level coverage for todayWeightedOutageSec
// before this: the only existing test of the function ran through parseFlashdutyFeed with a real
// captured fixture and asserted uptime30d only. These directly control nowMs to exercise the
// today-window computation with an exact expected value (mirrors the incident-io.test.ts #1017 tests).
describe('computeFlashdutyUptime — todayWeightedOutageSec (#1017)', () => {
  const midDay = Date.parse('2026-07-14T15:00:00Z') // 15h into the UTC day
  const roster = [{ component_id: 'c1', uptime: 100 }]

  it('reflects only the portion of a full_outage impact inside today', () => {
    // 3h outage, entirely inside today (started 3h ago, ended 1h ago — 2h span).
    const impacts = [{ component_id: 'c1', change_id: 1, start_at_seconds: (midDay - 3 * 3_600_000) / 1000, end_at_seconds: (midDay - 1 * 3_600_000) / 1000, status: 'full_outage' }]
    const out = computeFlashdutyUptime(impacts, roster, midDay)
    expect(out?.todayWeightedOutageSec).toBe(2 * 3600) // 2h at full weight (1.0)
  })

  it('an outage entirely before today contributes 0, but still counts toward the 30-day pct', () => {
    const yesterday9pm = midDay - 18 * 3_600_000
    const impacts = [{ component_id: 'c1', change_id: 1, start_at_seconds: (yesterday9pm - 3_600_000) / 1000, end_at_seconds: yesterday9pm / 1000, status: 'full_outage' }]
    const out = computeFlashdutyUptime(impacts, roster, midDay)
    expect(out?.todayWeightedOutageSec).toBe(0)
    expect(out?.pct).toBeLessThan(100)
  })

  it('worst-of\'s todayWeightedOutageSec INDEPENDENTLY of the pct-worst component', () => {
    // c1: small outage today (30min partial). c2: large outage YESTERDAY only (pct-worst overall),
    // clean today. todayWeightedOutageSec must surface c1's value (the only one with today activity),
    // not silently follow c2 (the 30-day pct-worst) and read 0.
    const twoRoster = [{ component_id: 'c1', uptime: 100 }, { component_id: 'c2', uptime: 100 }]
    const impacts = [
      { component_id: 'c1', change_id: 1, start_at_seconds: (midDay - 3600_000) / 1000, end_at_seconds: midDay / 1000, status: 'degraded' },
      { component_id: 'c2', change_id: 2, start_at_seconds: (midDay - 30 * 3_600_000) / 1000, end_at_seconds: (midDay - 20 * 3_600_000) / 1000, status: 'full_outage' },
    ]
    const out = computeFlashdutyUptime(impacts, twoRoster, midDay)
    expect(out?.todayWeightedOutageSec).toBeCloseTo(3600 * 0.3, 5) // c1's 1h partial (0.3 weight)
    expect(out?.pct).toBeLessThan(100) // c2's much larger outage still drives the 30-day pct down
  })

  it('is 0 (not null) for a clean roster with a positive result object', () => {
    const out = computeFlashdutyUptime([], roster, midDay)
    expect(out?.todayWeightedOutageSec).toBe(0)
  })
})

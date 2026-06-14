// #653 — the estimate-uptime gate: an estimate-only service (bedrock/azureopenai) must NOT surface a
// baseless 100% from informational-only incidents. `estimateUptimeFromIncidents` returns null unless
// the set has an IMPACTFUL incident; callers then leave `uptime30d` unset → "— Not provided".
import { describe, it, expect } from 'vitest'
import { hasImpactfulIncident, estimateUptimeFromIncidents } from '../parsers/incident-io'
import type { Incident } from '../types'

const recent = new Date(Date.now() - 2 * 86_400_000).toISOString() // 2 days ago (inside 90d window)
const mk = (o: Partial<Incident> = {}): Incident => ({
  id: 'i1', title: 'X — down', status: 'resolved', impact: null,
  startedAt: recent, resolvedAt: null, duration: null, timeline: [], ...o,
})

describe('hasImpactfulIncident (#653)', () => {
  it('false for empty / informational-only sets', () => {
    expect(hasImpactfulIncident([])).toBe(false)
    expect(hasImpactfulIncident([mk({ impact: null }), mk({ id: 'i2', impact: null })])).toBe(false)
  })
  it('true when any incident carries minor/major/critical impact', () => {
    expect(hasImpactfulIncident([mk({ impact: 'minor' })])).toBe(true)
    expect(hasImpactfulIncident([mk({ impact: null }), mk({ id: 'i2', impact: 'major' })])).toBe(true)
    expect(hasImpactfulIncident([mk({ impact: 'critical' })])).toBe(true)
  })
})

describe('estimateUptimeFromIncidents (#653 — no baseless 100%)', () => {
  it('returns null for an informational-only feed (the Bedrock phantom 100% case)', () => {
    // The exact recurred shape: one keyword-less AWS incident → impact null → no measured basis.
    expect(estimateUptimeFromIncidents([mk({ impact: null, title: 'Service impact: Fable 5 Access' })])).toBeNull()
  })
  it('returns null for an empty set', () => {
    expect(estimateUptimeFromIncidents([])).toBeNull()
  })
  it('returns a real weighted uptime when an impactful incident exists', () => {
    // A resolved 2h major incident over the 90-day window → just under 100, NOT null.
    const u = estimateUptimeFromIncidents([mk({ impact: 'major', status: 'resolved', duration: '2h' })])
    expect(u).not.toBeNull()
    expect(u!).toBeGreaterThan(99)
    expect(u!).toBeLessThan(100)
  })
})

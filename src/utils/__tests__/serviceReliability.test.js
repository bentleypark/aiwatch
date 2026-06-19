import { describe, it, expect } from 'vitest'
import { isEstimateNoData, isEstimateNoIncidents, isUnreliableUptime, hasReliableScoreData } from '../serviceReliability'

// #707 — isEstimateNoIncidents distinguishes "estimate source, no impactful incident in window"
// (honest wording: "No reliability incidents in this period") from the genuinely-unavailable /
// frozen-stale cases ("Not provided"). A null-impact compliance advisory is NOT impactful, so the
// worker leaves uptime30d null and the service lands here.
describe('serviceReliability predicates (#707 isEstimateNoIncidents)', () => {
  const estimateNoData = { uptimeSource: 'estimate', uptime30d: null }
  const estimateWithData = { uptimeSource: 'estimate', uptime30d: 99 }
  const estimateNoDataStale = { uptimeSource: 'estimate', uptime30d: null, incidentSourceStale: true }
  const official = { uptimeSource: 'official', uptime30d: null }

  it('true for an estimate service with a working source but null uptime (no impactful incident)', () => {
    expect(isEstimateNoIncidents(estimateNoData)).toBe(true)
  })

  it('false once the source is frozen/stale — then it really is unknown, not "no incidents"', () => {
    expect(isEstimateNoData(estimateNoDataStale)).toBe(true)       // still estimate-no-data
    expect(isEstimateNoIncidents(estimateNoDataStale)).toBe(false) // but NOT "no incidents" (stale)
  })

  it('false for an estimate service that DOES have a measured uptime', () => {
    expect(isEstimateNoIncidents(estimateWithData)).toBe(false)
  })

  it('false for a non-estimate (official) service with null uptime', () => {
    expect(isEstimateNoIncidents(official)).toBe(false)
  })

  it('does not change the existing exclude-from-ranking semantics', () => {
    // estimate-no-data (incl. our compliance-advisory-only Bedrock) stays excluded from score ranking
    expect(isUnreliableUptime(estimateNoData)).toBe(true)
    expect(hasReliableScoreData(estimateNoData)).toBe(false)
  })
})

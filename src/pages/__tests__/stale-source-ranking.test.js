import { describe, it, expect } from 'vitest'
import { hasReliableScoreData, isUnreliableUptime } from '../../utils/serviceReliability'

// #591 — stale-source services (frozen incident feed, e.g. DeepSeek → Flashduty) must drop out of the
// Score ranking + Uptime ranking: their empty 30-day window inflates the Score (full incidents +
// recovery from MISSING data) and their uptime30d is frozen. The predicates below gate inclusion on
// every ranking surface (Ranking.jsx, Uptime.jsx; api/is-down.ts carries an identical copy).

const stale = { id: 'deepseek', uptimeSource: 'official', uptime30d: 99.9, incidents: [{ id: 'x' }], incidentSourceStale: true }
const estimateNoData = { id: 'bedrock', uptimeSource: 'estimate', uptime30d: null, incidents: [] }
const normal = { id: 'claude', uptimeSource: 'official', uptime30d: 99.95, incidents: [{ id: 'a' }] }
// the key non-false-positive case: an incident-free service with a LIVE official feed (not stale) —
// e.g. Groq, whose newest incident may be months old but whose feed works — must STAY ranked.
const incidentFreeLive = { id: 'groq', uptimeSource: 'official', uptime30d: 100, incidents: [] }
// #653 — estimate basis is worker-derived over the 90-day set: when it has no impactful incident the
// worker leaves uptime30d NULL (informational-only / empty → no baseless 100%). The card incident
// COUNT stays live (an informational incident may still be listed), but a null estimate uptime means
// "no measured basis" → hidden + unranked, exactly like the zero-incident case.
const estimateInformationalOnly = { id: 'bedrock', uptimeSource: 'estimate', uptime30d: null, incidents: [{ id: 'i', impact: null }] }
// estimate-only WITH a measured basis → worker emitted a real uptime30d → stays shown/ranked.
const estimateWithImpact = { id: 'modal', uptimeSource: 'estimate', uptime30d: 99.5, incidents: [{ id: 'j', impact: 'major' }] }

describe('hasReliableScoreData (#591 — Ranking)', () => {
  it('excludes a stale-source service', () => {
    expect(hasReliableScoreData(stale)).toBe(false)
  })
  it('excludes estimate-uptime with no incidents (existing behaviour, unchanged)', () => {
    expect(hasReliableScoreData(estimateNoData)).toBe(false)
  })
  it('keeps a normal service', () => {
    expect(hasReliableScoreData(normal)).toBe(true)
  })
  it('keeps an incident-free service with a LIVE feed (no false-positive exclusion)', () => {
    expect(hasReliableScoreData(incidentFreeLive)).toBe(true)
  })
  it('excludes estimate-only with ONLY informational (null-impact) incidents (#653)', () => {
    expect(hasReliableScoreData(estimateInformationalOnly)).toBe(false)
  })
  it('keeps estimate-only with a real impactful incident (#653 — measured basis)', () => {
    expect(hasReliableScoreData(estimateWithImpact)).toBe(true)
  })
})

describe('isUnreliableUptime (#591 — Uptime)', () => {
  it('flags a stale-source service unreliable (sorted out / N/A)', () => {
    expect(isUnreliableUptime(stale)).toBe(true)
  })
  it('flags estimate-no-data unreliable (existing behaviour)', () => {
    expect(isUnreliableUptime(estimateNoData)).toBe(true)
  })
  it('does NOT flag a normal service', () => {
    expect(isUnreliableUptime(normal)).toBe(false)
  })
  it('does NOT flag an incident-free service with a live feed', () => {
    expect(isUnreliableUptime(incidentFreeLive)).toBe(false)
  })
  it('flags estimate-only with ONLY informational incidents unreliable (#653 — baseless 100%)', () => {
    expect(isUnreliableUptime(estimateInformationalOnly)).toBe(true)
  })
  it('does NOT flag estimate-only with a real impactful incident (#653)', () => {
    expect(isUnreliableUptime(estimateWithImpact)).toBe(false)
  })
})

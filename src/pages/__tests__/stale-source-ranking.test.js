import { describe, it, expect } from 'vitest'
import { hasReliableScoreData, isUnreliableUptime } from '../../utils/serviceReliability'

// #591 — stale-source services (frozen incident feed, e.g. DeepSeek → Flashduty) must drop out of the
// Score ranking + Uptime ranking: their empty 30-day window inflates the Score (full incidents +
// recovery from MISSING data) and their uptime30d is frozen. The predicates below gate inclusion on
// every ranking surface (Ranking.jsx, Uptime.jsx; api/is-down.ts carries an identical copy).

const stale = { id: 'deepseek', uptimeSource: 'official', incidents: [{ id: 'x' }], incidentSourceStale: true }
const estimateNoData = { id: 'bedrock', uptimeSource: 'estimate', incidents: [] }
const normal = { id: 'claude', uptimeSource: 'official', incidents: [{ id: 'a' }] }
// the key non-false-positive case: an incident-free service with a LIVE official feed (not stale) —
// e.g. Groq, whose newest incident may be months old but whose feed works — must STAY ranked.
const incidentFreeLive = { id: 'groq', uptimeSource: 'official', incidents: [] }

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
})

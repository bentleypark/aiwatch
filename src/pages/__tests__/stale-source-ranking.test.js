import { describe, it, expect } from 'vitest'
import { hasReliableScoreData, isUnreliableUptime } from '../../utils/serviceReliability'

// #591 — stale-source services (frozen incident feed, e.g. DeepSeek → Flashduty) must drop out of the
// Score + Uptime rankings: their empty 30-day window inflates the Score from MISSING data and their
// uptime30d is frozen. #713 — services with NO official uptime no longer get an invented estimate;
// ranking inclusion keys on `scoreConfidence` (high=official uptime, medium=probe-only, low=neither).
// The predicates gate every ranking surface (Ranking.jsx, Uptime.jsx; api/is-down.ts mirrors them).

const stale = { id: 'deepseek', uptimeSource: 'official', uptime30d: 99.9, incidents: [{ id: 'x' }], incidentSourceStale: true, scoreConfidence: 'high' }
const normal = { id: 'claude', uptimeSource: 'official', uptime30d: 99.95, incidents: [{ id: 'a' }], scoreConfidence: 'high' }
const incidentFreeLive = { id: 'groq', uptimeSource: 'official', uptime30d: 100, incidents: [], scoreConfidence: 'high' }
// #713 — no official uptime BUT a real probe (responsiveness) signal → confidence 'medium' → still
// ranked on its measured score (incidents + recovery + responsiveness). e.g. Gemini / xAI / OpenRouter.
const probedNoUptime = { id: 'gemini', uptime30d: null, incidents: [{ id: 'i', impact: 'major' }], scoreConfidence: 'medium' }
// #713 — no official uptime AND no probe (only incidents+recovery → over-scores under the rescale) →
// confidence 'low' → shown on its detail page but NOT ranked. e.g. Bedrock / Azure.
const thinNoUptime = { id: 'bedrock', uptime30d: null, incidents: [], scoreConfidence: 'low' }

describe('hasReliableScoreData (#591/#713 — Ranking)', () => {
  it('excludes a stale-source service', () => {
    expect(hasReliableScoreData(stale)).toBe(false)
  })
  it('keeps a normal service', () => {
    expect(hasReliableScoreData(normal)).toBe(true)
  })
  it('keeps an incident-free service with a LIVE feed (no false-positive exclusion)', () => {
    expect(hasReliableScoreData(incidentFreeLive)).toBe(true)
  })
  it('#713 — keeps a no-official-uptime service that HAS a probe (confidence medium)', () => {
    expect(hasReliableScoreData(probedNoUptime)).toBe(true)
  })
  it('#713 — excludes a no-official-uptime + no-probe service (confidence low → over-scores)', () => {
    expect(hasReliableScoreData(thinNoUptime)).toBe(false)
  })
})

describe('isUnreliableUptime (#591/#713 — Uptime)', () => {
  it('flags a stale-source service unreliable (sorted out / N/A)', () => {
    expect(isUnreliableUptime(stale)).toBe(true)
  })
  it('flags any null-uptime service unreliable (no % to show), probe or not', () => {
    expect(isUnreliableUptime(probedNoUptime)).toBe(true)
    expect(isUnreliableUptime(thinNoUptime)).toBe(true)
  })
  it('does NOT flag a normal service', () => {
    expect(isUnreliableUptime(normal)).toBe(false)
  })
  it('does NOT flag an incident-free service with a live feed', () => {
    expect(isUnreliableUptime(incidentFreeLive)).toBe(false)
  })
})

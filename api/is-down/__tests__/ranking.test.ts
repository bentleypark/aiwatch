import { describe, it, expect } from 'vitest'
import { computeRankPosition } from '../ranking'

// #787 — deterministic guard for the rank + tie derivation that the removed flaky e2e
// (tests/is-down.spec.js) only ever covered probabilistically (it needed a LIVE score tie to exist).
const svc = (aiwatchScore: number) => ({ aiwatchScore })

describe('computeRankPosition (#787)', () => {
  it('ranks by position; no tie when the target score is unique', () => {
    // scoredDesc sorted by score desc: 91, 88, 84, 70
    const scored = [svc(91), svc(88), svc(84), svc(70)]
    expect(computeRankPosition(scored, 84)).toEqual({ rank: 3, tied: false, total: 4 })
  })

  it('competition ranking — tied services share the FIRST position, tied:true', () => {
    // two services round to 83 → both rank #2 (the first-tied slot), not #2 and #3
    const scored = [svc(90), svc(83.4), svc(82.6), svc(70)] // 90, 83, 83, 70
    expect(computeRankPosition(scored, 83)).toEqual({ rank: 2, tied: true, total: 4 })
  })

  it('rounds before comparing (82.6 and 83.4 both → 83, a tie)', () => {
    const scored = [svc(83.4), svc(82.6)]
    const r = computeRankPosition(scored, 83)
    expect(r.tied).toBe(true)
    expect(r.rank).toBe(1)
  })

  it('a top-scored unique leader is rank #1, not tied', () => {
    expect(computeRankPosition([svc(95), svc(88), svc(88)], 95)).toEqual({ rank: 1, tied: false, total: 3 })
  })

  it('returns rank 0 when the target score is absent (caller guards rank > 0)', () => {
    expect(computeRankPosition([svc(90), svc(80)], 75)).toEqual({ rank: 0, tied: false, total: 2 })
  })

  it('total reflects the full ranked set, not just the matches', () => {
    expect(computeRankPosition([svc(90), svc(90), svc(90)], 90)).toEqual({ rank: 1, tied: true, total: 3 })
  })
})

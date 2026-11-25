import { describe, it, expect } from 'vitest'
import { classifyWeightedDay, DAY_MAJOR_THRESHOLD_SEC, DAY_CRITICAL_THRESHOLD_SEC } from '../parsers/impact-weights'

describe('classifyWeightedDay (#2060)', () => {
  it('returns null for zero or negative seconds — a clean day', () => {
    expect(classifyWeightedDay(0, true)).toBeNull()
    expect(classifyWeightedDay(-5, true)).toBeNull()
    expect(classifyWeightedDay(NaN, true)).toBeNull()
  })

  it('returns minor for any positive amount under the major cut', () => {
    expect(classifyWeightedDay(1, true)).toBe('minor')
    expect(classifyWeightedDay(DAY_MAJOR_THRESHOLD_SEC - 1, true)).toBe('minor')
  })

  it('returns major from the major cut up to, not including, the critical cut', () => {
    expect(classifyWeightedDay(DAY_MAJOR_THRESHOLD_SEC, true)).toBe('major')
    expect(classifyWeightedDay(DAY_CRITICAL_THRESHOLD_SEC - 1, true)).toBe('major')
  })

  it('returns critical from the critical cut when the day has major-outage seconds', () => {
    expect(classifyWeightedDay(DAY_CRITICAL_THRESHOLD_SEC, true)).toBe('critical')
    expect(classifyWeightedDay(86_400, true)).toBe('critical')
  })

  it('a day without major-outage seconds never goes above major', () => {
    expect(classifyWeightedDay(DAY_CRITICAL_THRESHOLD_SEC, false)).toBe('major')
    expect(classifyWeightedDay(86_400, false)).toBe('major')
    expect(classifyWeightedDay(DAY_MAJOR_THRESHOLD_SEC - 1, false)).toBe('minor')
  })

  it('pins the cuts themselves, since every calendar on every Atlassian card moves with them', () => {
    expect([DAY_MAJOR_THRESHOLD_SEC, DAY_CRITICAL_THRESHOLD_SEC]).toEqual([600, 3000])
  })
})

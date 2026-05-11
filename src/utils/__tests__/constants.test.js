// #403 — pin the frontend `tierFor` / `tierLabelFor` warn-once behavior.
// Mirrors worker/src/__tests__/fallback.test.ts; the parallel implementation is intentional
// because the worker can't import frontend code at runtime.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tierFor, tierLabelFor, API_TIER, TIER_LABEL } from '../constants'

describe('tierFor (#403 frontend warn-once helper)', () => {
  let warnSpy
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warnSpy.mockRestore() })

  it('returns the mapped tier for a known service id (no warning)', () => {
    expect(tierFor('claude')).toBe(API_TIER.claude)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('returns 99 and warns once for an unknown service id', () => {
    const fakeId = '__fe_test_warn_once_a__'
    expect(tierFor(fakeId)).toBe(99)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain(fakeId)
  })

  it('repeated calls for the same unknown id do not re-warn', () => {
    const fakeId = '__fe_test_warn_once_b__'
    tierFor(fakeId)
    tierFor(fakeId)
    tierFor(fakeId)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

describe('tierLabelFor (#403)', () => {
  let warnSpy
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warnSpy.mockRestore() })

  it('returns the mapped label for known tier numbers (no warning)', () => {
    expect(tierLabelFor(1)).toBe('LLM')
    expect(tierLabelFor(11)).toBe('CLI Agent')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('returns undefined and warns once for an unknown tier', () => {
    expect(tierLabelFor(7777)).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('7777')
  })

  it('every API_TIER value has a TIER_LABEL entry — no silent label degradation expected at runtime', () => {
    // Mirrors the cross-mirror sync test at the unit level. If a future contributor adds a tier
    // number to API_TIER without also extending TIER_LABEL, runtime tierLabelFor warnings would
    // fire — this test catches it earlier.
    const tierValues = new Set(Object.values(API_TIER))
    for (const tier of tierValues) {
      expect(TIER_LABEL[tier], `tier ${tier} appears in API_TIER but has no TIER_LABEL entry`).toBeDefined()
    }
  })
})

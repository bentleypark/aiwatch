import { describe, it, expect } from 'vitest'
import { predictedHoursFrom, predictedHoursText, accuracyVerdict, verdictLabel, withinEstimateText, computePredictionOutcome } from '../predictionAccuracy'

describe('predictedHoursFrom', () => {
  it('prefers the numeric estimatedRecoveryHours', () => {
    expect(predictedHoursFrom({ estimatedRecoveryHours: 3, estimatedRecovery: '1–3h' })).toBe(3)
  })
  it('parses the upper bound of the display string when no numeric field', () => {
    expect(predictedHoursFrom({ estimatedRecovery: '1–3h' })).toBe(3)
    expect(predictedHoursFrom({ estimatedRecovery: '30m–1h' })).toBe(1)
    expect(predictedHoursFrom({ estimatedRecovery: '45m' })).toBe(0.75)
    expect(predictedHoursFrom({ estimatedRecovery: '2h' })).toBe(2)
  })
  it('returns null for no usable prediction', () => {
    expect(predictedHoursFrom(null)).toBeNull()
    expect(predictedHoursFrom({})).toBeNull()
    expect(predictedHoursFrom({ estimatedRecovery: 'N/A' })).toBeNull()
    expect(predictedHoursFrom({ estimatedRecovery: 'No historical data for estimation' })).toBeNull()
    expect(predictedHoursFrom({ estimatedRecoveryHours: 0 })).toBeNull()
  })
})

describe('predictedHoursText', () => {
  it('formats whole + fractional hours compactly', () => {
    expect(predictedHoursText(1)).toBe('1h')
    expect(predictedHoursText(3)).toBe('3h')
    expect(predictedHoursText(0.75)).toBe('45m')
    expect(predictedHoursText(1.5)).toBe('1h 30m')
  })
})

describe('accuracyVerdict (mirrors worker accuracyOf bands)', () => {
  it('accurate within [0.5x, 1x] of the bound', () => {
    expect(accuracyVerdict(1, 45)).toBe('accurate')   // 0.75h
    expect(accuracyVerdict(2, 120)).toBe('accurate')  // at bound
    expect(accuracyVerdict(2, 60)).toBe('accurate')   // exactly 0.5x
  })
  it('under when actual exceeds the bound', () => {
    expect(accuracyVerdict(1, 200)).toBe('under')
  })
  it('over when actual is far below the bound (<0.5x)', () => {
    expect(accuracyVerdict(2, 59)).toBe('over')
  })
  it('unknown for bad inputs', () => {
    expect(accuracyVerdict(0, 30)).toBe('unknown')
    expect(accuracyVerdict(1, -5)).toBe('unknown')
  })
})

describe('verdictLabel', () => {
  it('returns plain-language KO/EN labels (within-estimate, not over-claiming)', () => {
    expect(verdictLabel('accurate', 'ko')).toBe('예측 범위 내')
    expect(verdictLabel('accurate', 'en')).toBe('within estimate')
    expect(verdictLabel('under', 'ko')).toBe('예측보다 오래')
    expect(verdictLabel('over', 'en')).toBe('faster than est.')
  })
  it('returns null for unknown', () => {
    expect(verdictLabel('unknown', 'ko')).toBeNull()
  })
})

describe('withinEstimateText (Overview banner phrase, direction-aware)', () => {
  it('within / over / faster for the three verdicts (KO + EN)', () => {
    expect(withinEstimateText({ verdict: 'accurate', predictedText: '1h' }, 'ko')).toBe('예측 ~1h 이내')
    expect(withinEstimateText({ verdict: 'accurate', predictedText: '1h' }, 'en')).toBe('within ~1h est.')
    expect(withinEstimateText({ verdict: 'under', predictedText: '1h' }, 'ko')).toBe('예측 ~1h 초과')
    expect(withinEstimateText({ verdict: 'under', predictedText: '1h' }, 'en')).toBe('over ~1h est.')
    expect(withinEstimateText({ verdict: 'over', predictedText: '3h' }, 'ko')).toBe('예측 ~3h보다 빨리')
    expect(withinEstimateText({ verdict: 'over', predictedText: '3h' }, 'en')).toBe('faster than ~3h est.')
  })
  it('returns null when no outcome', () => {
    expect(withinEstimateText(null, 'ko')).toBeNull()
  })
})

describe('computePredictionOutcome', () => {
  const started = '2026-06-29T10:00:00.000Z'
  const resolved = '2026-06-29T10:52:00.000Z' // 52m later

  it('returns predicted/actual/verdict for a resolved incident', () => {
    const out = computePredictionOutcome(
      { estimatedRecoveryHours: 1, resolvedAt: resolved },
      { startedAt: started },
    )
    expect(out).toEqual({ predictedHours: 1, predictedText: '1h', actualMin: 52, actualText: '52m', verdict: 'accurate' })
  })

  it('formats actual ≥1h via formatRecoveryMin', () => {
    const out = computePredictionOutcome(
      { estimatedRecoveryHours: 1, resolvedAt: '2026-06-29T13:10:00.000Z' }, // 3h10m
      { startedAt: started },
    )
    expect(out.actualText).toBe('3h 10m')
    expect(out.verdict).toBe('under') // 3.17h > 1h
  })

  it('returns null when not resolved', () => {
    expect(computePredictionOutcome({ estimatedRecoveryHours: 1 }, { startedAt: started })).toBeNull()
  })
  it('returns null when no usable prediction', () => {
    expect(computePredictionOutcome({ resolvedAt: resolved, estimatedRecovery: 'N/A' }, { startedAt: started })).toBeNull()
  })
  it('returns null when startedAt missing (actual not derivable)', () => {
    expect(computePredictionOutcome({ estimatedRecoveryHours: 1, resolvedAt: resolved }, {})).toBeNull()
    expect(computePredictionOutcome({ estimatedRecoveryHours: 1, resolvedAt: resolved }, undefined)).toBeNull()
  })
  it('returns null for out-of-order timestamps (no negative duration)', () => {
    expect(computePredictionOutcome(
      { estimatedRecoveryHours: 1, resolvedAt: started },
      { startedAt: resolved },
    )).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { predictedHoursFrom, baselineHoursFrom, predictedHoursText, accuracyVerdict, verdictLabel, withinEstimateText, computePredictionOutcome, estimateExceeded, exceededRecoveryText, approxElapsedText, FAR_EXCEEDED_FACTOR } from '../predictionAccuracy'

describe('#1003 — the modal scores against the FIRST estimate, live text against the current one', () => {
  // Pinecone: first estimate 1–4h, re-analysis inflated it to ~15h at the 4h mark, actual 4h 55m.
  const reanalyzed = {
    estimatedRecovery: '8–15h',
    estimatedRecoveryHours: 15,
    firstEstimatedRecoveryHours: 4,
    resolvedAt: '2026-07-13T08:32:00.000Z',
  }
  const incident = { startedAt: '2026-07-13T03:37:00.000Z' }

  it('baselineHoursFrom prefers the first estimate', () => {
    expect(baselineHoursFrom(reanalyzed)).toBe(4)
  })
  it('falls back to the current estimate for pre-#1003 analyses', () => {
    expect(baselineHoursFrom({ estimatedRecoveryHours: 15 })).toBe(15)
    expect(baselineHoursFrom({ estimatedRecovery: '1–3h' })).toBe(3)
    expect(baselineHoursFrom(null)).toBeNull()
  })
  it('the resolved verdict is the honest near-miss, not "faster than ~15h"', () => {
    const outcome = computePredictionOutcome(reanalyzed, incident)
    expect(outcome.predictedHours).toBe(4)
    expect(outcome.actualText).toBe('4h 55m')
    expect(outcome.verdict).toBe('under') // ran past the original 4h bound
    expect(withinEstimateText(outcome, 'en')).toBe('over ~4h est.')
  })
  it('the ONGOING "exceeded" text still uses the current estimate (a user needs the live ETA)', () => {
    const active = { estimatedRecovery: '8–15h', estimatedRecoveryHours: 15, firstEstimatedRecoveryHours: 4 }
    const now = new Date('2026-07-13T09:37:00.000Z').getTime() // 6h in: past the first 4h, within 15h
    expect(estimateExceeded(active, incident, now)).toBe(false)
    // Had it scored on the stale 4h baseline, this would already claim "exceeded".
  })
})

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

describe('estimateExceeded (Mistral 2–4h on a 2-day incident)', () => {
  const now = new Date('2026-07-02T00:00:00.000Z').getTime()
  it('true when an active incident has run past its estimated upper bound', () => {
    // Started 2 days ago, estimate 4h → long exceeded.
    expect(estimateExceeded(
      { estimatedRecoveryHours: 4, estimatedRecovery: '2–4h' },
      { startedAt: '2026-06-30T00:00:00.000Z' },
      now,
    )).toBe(true)
  })
  it('parses the display upper bound when no numeric field', () => {
    expect(estimateExceeded(
      { estimatedRecovery: '2–4h' },
      { startedAt: '2026-06-30T00:00:00.000Z' },
      now,
    )).toBe(true)
  })
  it('false while still within the estimated window', () => {
    expect(estimateExceeded(
      { estimatedRecoveryHours: 4 },
      { startedAt: '2026-07-01T22:00:00.000Z' }, // 2h ago < 4h
      now,
    )).toBe(false)
  })
  it('false once resolved (predicted-vs-actual takes over)', () => {
    expect(estimateExceeded(
      { estimatedRecoveryHours: 4, resolvedAt: '2026-07-01T00:00:00.000Z' },
      { startedAt: '2026-06-30T00:00:00.000Z' },
      now,
    )).toBe(false)
  })
  it('false without a usable prediction or startedAt', () => {
    expect(estimateExceeded({ estimatedRecovery: 'N/A' }, { startedAt: '2026-06-30T00:00:00.000Z' }, now)).toBe(false)
    expect(estimateExceeded({ estimatedRecoveryHours: 4 }, {}, now)).toBe(false)
    expect(estimateExceeded(null, { startedAt: '2026-06-30T00:00:00.000Z' }, now)).toBe(false)
  })
})

describe('approxElapsedText', () => {
  it('rounds to whole hours / minutes (KO + EN)', () => {
    expect(approxElapsedText(708, 'ko')).toBe('12시간') // 11.8h → 12
    expect(approxElapsedText(708, 'en')).toBe('12h')
    expect(approxElapsedText(40, 'ko')).toBe('40분')
    expect(approxElapsedText(40, 'en')).toBe('40m')
  })
})

describe('exceededRecoveryText (elapsed vs estimate — the user-chosen wording)', () => {
  const now = new Date('2026-07-02T03:24:57.000Z').getTime()
  it('shows "약 12시간째 진행 · 예측(2–4h) 초과" for the Fine-Tuning incident (KO)', () => {
    // startedAt 2026-07-01T15:38 → ~11.8h before `now` → rounds to 12
    expect(exceededRecoveryText(
      { estimatedRecovery: '2–4h', estimatedRecoveryHours: 4 },
      { startedAt: '2026-07-01T15:38:30.837Z' }, 'ko', now,
    )).toBe('약 12시간째 진행 · 예측(2–4h) 초과')
  })
  it('EN form: "Ongoing ~12h · exceeded ~2–4h est."', () => {
    expect(exceededRecoveryText(
      { estimatedRecovery: '2–4h', estimatedRecoveryHours: 4 },
      { startedAt: '2026-07-01T15:38:30.837Z' }, 'en', now,
    )).toBe('Ongoing ~12h · exceeded ~2–4h est.')
  })
  it('derives the range from the numeric bound when the display string is N/A', () => {
    expect(exceededRecoveryText(
      { estimatedRecovery: 'N/A', estimatedRecoveryHours: 4 },
      { startedAt: '2026-07-01T15:38:30.837Z' }, 'en', now,
    )).toBe('Ongoing ~12h · exceeded ~4h est.')
  })
  it('falls back to terse wording when startedAt is missing', () => {
    expect(exceededRecoveryText({ estimatedRecovery: '2–4h' }, {}, 'ko', now)).toBe('일반 패턴 초과 — 예측 불가')
    expect(exceededRecoveryText({ estimatedRecovery: '2–4h' }, {}, 'en', now)).toBe('Exceeded typical pattern')
  })

  // #900 — once FAR past the estimate the stale short range is dropped (else "~4–8h est." repeats on a 69h incident)
  it('drops the stale range when > FAR_EXCEEDED_FACTOR× over (the Mistral 69h vs 4–8h case)', () => {
    const started = new Date(now - 69 * 3_600_000).toISOString() // 69h / 8h upper = 8.6× → far
    const a = { estimatedRecovery: '4–8h', estimatedRecoveryHours: 8 }
    expect(exceededRecoveryText(a, { startedAt: started }, 'ko', now)).toBe('약 69시간째 진행 · 예측 대폭 초과')
    expect(exceededRecoveryText(a, { startedAt: started }, 'en', now)).toBe('Ongoing ~69h · far exceeded est.')
  })
  it('keeps the range at exactly FAR_EXCEEDED_FACTOR× (boundary — still credible), drops just past it', () => {
    const a = { estimatedRecovery: '2–4h', estimatedRecoveryHours: 4 }
    const atThreshold = new Date(now - 4 * FAR_EXCEEDED_FACTOR * 3_600_000).toISOString() // exactly 12h = 3×
    expect(exceededRecoveryText(a, { startedAt: atThreshold }, 'en', now)).toBe('Ongoing ~12h · exceeded ~2–4h est.')
    const justPast = new Date(now - (4 * FAR_EXCEEDED_FACTOR + 1) * 3_600_000).toISOString() // 13h > 12h → far
    expect(exceededRecoveryText(a, { startedAt: justPast }, 'en', now)).toBe('Ongoing ~13h · far exceeded est.')
  })
})

import { describe, it, expect } from 'vitest'
import { recoveryBaselineText, estimateAccuracyText } from '../recoveryBaseline'
import { recoveryBaselineText as workerText, estimateAccuracyText as workerAccuracyText } from '../../../worker/src/recovery-baseline-text'

const b = { n: 50, medianMin: 85, p80Min: 182, since: '2026-08-07' }

describe('recoveryBaselineText (#1697)', () => {
  it('matches the worker EN sentence', () => {
    expect(recoveryBaselineText(b, 'en')).toBe(workerText(b))
    expect(recoveryBaselineText(b, 'en')).toBe('Past incidents on this service: median 1h 25m, 80% resolved within 3h 2m (based on 50 recorded incidents since 2026-08-07)')
  })
  it('renders Korean', () => {
    expect(recoveryBaselineText(b, 'ko')).toBe('이 서비스의 과거 인시던트: 중앙값 1h 25m, 80%가 3h 2m 안에 복구 (2026-08-07 이후 기록된 인시던트 50건 기준)')
  })
  it('returns null without a baseline', () => {
    expect(recoveryBaselineText(undefined, 'en')).toBeNull()
  })
})

describe('estimateAccuracyText (#1205)', () => {
  const a = { total: 32, accurate: 12, overPredicted: 14, underPredicted: 6, since: '2026-09-01' }

  it('is the worker sentence in English, with the three outcomes apart', () => {
    expect(estimateAccuracyText(a, 'en')).toBe(workerAccuracyText(a))
    expect(estimateAccuracyText(a, 'en')).toBe("AIWatch's recovery estimates, all services (32 scored since 2026-09-01): 44% recovered in under half the estimate, 37% in half to all of it, 19% took longer.")
  })

  it('renders Korean with the same percentages', () => {
    expect(estimateAccuracyText(a, 'ko')).toBe('AIWatch의 복구 예측 적중 기록, 전체 서비스 (2026-09-01 이후 결과가 확인된 32건): 예측의 절반 미만 시간에 복구 44%, 예측의 절반~전체 시간에 복구 37%, 예측보다 오래 걸림 19%')
  })

  it.each([
    ['absent', undefined],
    ['below the floor', { ...a, total: 29, accurate: 9 }],
    ['counts that do not add up', { ...a, accurate: 13 }],
    ['a count that is text', { ...a, total: '32' }],
  ])('returns null for %s, in both languages', (_name, bad) => {
    expect(estimateAccuracyText(bad, 'en')).toBeNull()
    expect(estimateAccuracyText(bad, 'ko')).toBeNull()
  })
})

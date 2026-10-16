import { describe, it, expect } from 'vitest'
import { recoveryBaselineText } from '../recoveryBaseline'
import { recoveryBaselineText as workerText } from '../../../worker/src/recovery-baseline-text'

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

// #1697 — the dashboard's sentence for a service's past recovery times (`recoveryBaseline[svcId]` on
// /api/status and /api/status/cached). The EN wording matches worker/src/recovery-baseline-text.ts.
import { fmtMin } from './predictionAccuracy'
import { estimateAccuracyText as workerEstimateAccuracyText, isEstimateAccuracy, wholeShares } from '../../worker/src/recovery-baseline-text'

export function recoveryBaselineText(b, lang) {
  if (!b) return null
  return lang === 'ko'
    ? `이 서비스의 과거 인시던트: 중앙값 ${fmtMin(b.medianMin)}, 80%가 ${fmtMin(b.p80Min)} 안에 복구 (${b.since} 이후 기록된 인시던트 ${b.n}건 기준)`
    : `Past incidents on this service: median ${fmtMin(b.medianMin)}, 80% resolved within ${fmtMin(b.p80Min)} (based on ${b.n} recorded incidents since ${b.since})`
}

export function estimateAccuracyText(a, lang) {
  if (!isEstimateAccuracy(a)) return null
  if (lang !== 'ko') return workerEstimateAccuracyText(a)
  const [within, fast, longer] = wholeShares([a.accurate, a.overPredicted, a.underPredicted])
  return `AIWatch의 복구 예측 적중 기록, 전체 서비스 (${a.since} 이후 결과가 확인된 ${a.total}건): 예측의 절반 미만 시간에 복구 ${fast}%, 예측의 절반~전체 시간에 복구 ${within}%, 예측보다 오래 걸림 ${longer}%`
}

// #1697 — the dashboard's sentence for a service's past recovery times (`recoveryBaseline[svcId]` on
// /api/status and /api/status/cached). The EN wording matches worker/src/recovery-baseline-text.ts.
import { fmtMin } from './predictionAccuracy'

export function recoveryBaselineText(b, lang) {
  if (!b) return null
  return lang === 'ko'
    ? `이 서비스의 과거 인시던트: 중앙값 ${fmtMin(b.medianMin)}, 80%가 ${fmtMin(b.p80Min)} 안에 복구 (${b.since} 이후 기록된 인시던트 ${b.n}건 기준)`
    : `Past incidents on this service: median ${fmtMin(b.medianMin)}, 80% resolved within ${fmtMin(b.p80Min)} (based on ${b.n} recorded incidents since ${b.since})`
}

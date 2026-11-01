// #1697 — the wire shape and the one EN sentence for a service's past recovery times. No imports, so the
// Edge is-down page can use it without pulling the worker's module graph into its bundle.

export interface RecoveryBaseline {
  /** Qualifying incidents the figures are computed over. */
  n: number
  medianMin: number
  /** Nearest-rank 80th percentile: at least 80% of the `n` recovered within it. */
  p80Min: number
  /** UTC date (YYYY-MM-DD) the earliest qualifying incident started. */
  since: string
}

function minText(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function recoveryBaselineText(b: RecoveryBaseline): string {
  return `Past incidents on this service: median ${minText(b.medianMin)}, 80% resolved within ${minText(b.p80Min)} (based on ${b.n} recorded incidents since ${b.since})`
}

export interface EstimateAccuracy {
  total: number
  accurate: number
  overPredicted: number
  underPredicted: number
  since: string
}

export const ESTIMATE_ACCURACY_MIN_N = 30

export function isEstimateAccuracy(v: unknown): v is EstimateAccuracy {
  const a = v as EstimateAccuracy
  return !!a && [a.accurate, a.overPredicted, a.underPredicted].every(Number.isInteger)
    && a.total >= ESTIMATE_ACCURACY_MIN_N
    && a.accurate >= 0 && a.overPredicted >= 0 && a.underPredicted >= 0
    && a.accurate + a.overPredicted + a.underPredicted === a.total
    && typeof a.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.since)
}

/** Whole percentages of `counts` (total > 0) that sum to exactly 100 (largest remainder). */
export function wholeShares(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0)
  const exact = counts.map((c) => (c / total) * 100)
  const out = exact.map(Math.floor)
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r)
  const deficit = 100 - out.reduce((a, b) => a + b, 0)
  for (let k = 0; k < deficit; k++) out[order[k].i]++
  return out
}

export function estimateAccuracyText(a: EstimateAccuracy): string {
  const [within, fast, longer] = wholeShares([a.accurate, a.overPredicted, a.underPredicted])
  return `AIWatch's recovery estimates, all services (${a.total} scored since ${a.since}): ${fast}% recovered in under half the estimate, ${within}% in half to all of it, ${longer}% took longer.`
}

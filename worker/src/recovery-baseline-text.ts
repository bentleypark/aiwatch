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

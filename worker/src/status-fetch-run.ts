/**
 * #1489 — one Analytics Engine row per `fetchAllServices` run: which path ran it, how long it took,
 * which services came back without a freshly read uptime figure, and how the run's fetches failed. The
 * before/after measure for changes to how the status fetch spends its connections. Beside it, rows in
 * `STATUS_FETCH_LEG_INDEX` split the same fetches by leg and timeout.
 */
import type { ServiceStatus } from './types'
import type { FetchRunStats } from './utils'

export const STATUS_FETCH_RUN_INDEX = 'status-fetch-run'
export const STATUS_FETCH_LEG_INDEX = 'status-fetch-leg'

export type StatusFetchRoute = 'cron' | 'live'

export function recordStatusFetchRun(
  analytics: AnalyticsEngineDataset | undefined,
  route: StatusFetchRoute,
  wallMs: number,
  services: ServiceStatus[],
  fetchStats: FetchRunStats,
): void {
  if (!analytics) return
  try {
    const nullIds = services.filter((s) => s.uptime30d == null || s.uptimeCarriedFrom).map((s) => s.id).sort()
    analytics.writeDataPoint({
      // blob1 route, blob2 ids with no uptime read this run (null or carried; comma-joined, sorted).
      // doubles: count, wall-clock ms, services with no uptime read this run, services returned, most fetches
      // waiting for headers at once, fetches answered, timeouts, non-2xx responses, other fetch errors,
      // then the other fetches waiting at each start, summed over the answered and over the timeouts.
      blobs: [route, nullIds.join(',')],
      doubles: [
        1, wallMs, nullIds.length, services.length,
        fetchStats.maxInFlight, fetchStats.answered, fetchStats.timeouts, fetchStats.httpErrors, fetchStats.otherErrors,
        fetchStats.waitingAtStartAnswered, fetchStats.waitingAtStartTimeouts,
      ],
      indexes: [STATUS_FETCH_RUN_INDEX],
    })
    // One row per leg and timeout that made a fetch, index `status-fetch-leg`. blob1 route, blob2 leg.
    // doubles: count, timeout (ms), answered, timeouts, non-2xx, other errors, summed and maximum time to
    // headers of the answered, then the answered count per fifth of the timeout used (`budgetShareBucket`).
    for (const l of fetchStats.legs ?? []) {
      analytics.writeDataPoint({
        blobs: [route, l.leg],
        doubles: [
          1, l.budgetMs, l.answered, l.timeouts, l.httpErrors, l.otherErrors, l.answeredMs, l.maxAnsweredMs,
          ...l.answeredByBudgetShare,
        ],
        indexes: [STATUS_FETCH_LEG_INDEX],
      })
    }
  } catch (err) {
    console.warn('[wae] status-fetch-run write failed:', err instanceof Error ? err.message : err)
  }
}

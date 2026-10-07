/**
 * #1489 — one Analytics Engine row per `fetchAllServices` run: which path ran it, how long it took,
 * which services came back without an uptime figure, and how the run's fetches failed. The
 * before/after measure for changes to how the status fetch spends its connections.
 */
import type { ServiceStatus } from './types'
import type { FetchRunStats } from './utils'

export const STATUS_FETCH_RUN_INDEX = 'status-fetch-run'

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
    const nullIds = services.filter((s) => s.uptime30d == null).map((s) => s.id).sort()
    analytics.writeDataPoint({
      // blob1 route, blob2 null-uptime service ids (comma-joined, sorted).
      // doubles: count, wall-clock ms, services with uptime30d null, services returned, most fetches
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
  } catch (err) {
    console.warn('[wae] status-fetch-run write failed:', err instanceof Error ? err.message : err)
  }
}

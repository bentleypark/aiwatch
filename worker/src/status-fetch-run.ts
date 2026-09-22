/**
 * #1489 — one Analytics Engine row per `fetchAllServices` run: which path ran it, how long it took, and
 * how many services came back without an uptime figure. The before/after measure for changes to how
 * the status fetch spends its connections.
 */
import type { ServiceStatus } from './types'

export const STATUS_FETCH_RUN_INDEX = 'status-fetch-run'

export type StatusFetchRoute = 'cron' | 'live'

export function recordStatusFetchRun(
  analytics: AnalyticsEngineDataset | undefined,
  route: StatusFetchRoute,
  wallMs: number,
  services: ServiceStatus[],
): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint({
      // blob1 route; doubles: count, wall-clock ms, services with uptime30d null, services returned.
      blobs: [route],
      doubles: [1, wallMs, services.filter((s) => s.uptime30d == null).length, services.length],
      indexes: [STATUS_FETCH_RUN_INDEX],
    })
  } catch (err) {
    console.warn('[wae] status-fetch-run write failed:', err instanceof Error ? err.message : err)
  }
}

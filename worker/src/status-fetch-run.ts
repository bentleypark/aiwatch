/**
 * #1489 — what each `fetchAllServices` run writes to Analytics Engine, the before/after measure for changes to
 * how the status fetch spends its connections. Each write call below documents its own row.
 */
import type { ServiceStatus } from './types'
import type { FetchRunStats, FetchTraceEntry } from './utils'

export const STATUS_FETCH_RUN_INDEX = 'status-fetch-run'
export const STATUS_FETCH_LEG_INDEX = 'status-fetch-leg'
export const STATUS_FETCH_TRACE_INDEX = 'status-fetch-trace'

/** Analytics Engine allows 16 KB of blobs per point: https://developers.cloudflare.com/analytics/analytics-engine/limits/ */
export const STATUS_FETCH_TRACE_MAX_CHARS = 12_000

/** One `host,leg,budgetMs,waiting,outcome,ms` per fetch in start order, `;`-joined, cut at whole entries. */
export function encodeFetchTrace(trace: readonly FetchTraceEntry[], maxChars = STATUS_FETCH_TRACE_MAX_CHARS): { text: string; written: number } {
  const parts: string[] = []
  let size = 0
  for (const e of trace) {
    const part = `${e.host},${e.leg},${e.budgetMs},${e.waiting},${e.outcome ?? ''},${e.ms ?? ''}`
    if (size + part.length + 1 > maxChars) break
    parts.push(part)
    size += part.length + 1
  }
  return { text: parts.join(';'), written: parts.length }
}

/** Analytics Engine samples per index: https://developers.cloudflare.com/analytics/analytics-engine/sql-api/ */
export function statusFetchLegIndex(leg: { leg: string; budgetMs: number }): string {
  return `${STATUS_FETCH_LEG_INDEX}:${leg.leg}@${leg.budgetMs}`
}

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
      // blob1 route, blob2 ids with no uptime read this run (null or carried; comma-joined, sorted), blob3 the
      // order the page prefetch was launched in (`fixed` or `shuffled`; empty when the caller did not say).
      // doubles: count, wall-clock ms, services with no uptime read this run, services returned, most fetches
      // waiting for headers at once, fetches answered, timeouts, non-2xx responses, other fetch errors,
      // then the other fetches waiting at each start, summed over the answered and over the timeouts.
      blobs: [route, nullIds.join(','), fetchStats.launchOrder ?? ''],
      doubles: [
        1, wallMs, nullIds.length, services.length,
        fetchStats.maxInFlight, fetchStats.answered, fetchStats.timeouts, fetchStats.httpErrors, fetchStats.otherErrors,
        fetchStats.waitingAtStartAnswered, fetchStats.waitingAtStartTimeouts,
      ],
      indexes: [STATUS_FETCH_RUN_INDEX],
    })
    // One row per run listing the fetches (`encodeFetchTrace`). blob1 route, blob2 launch order, blob3 the trace.
    // doubles: count, fetches traced (the tracker keeps at most `FETCH_TRACE_MAX`), fetches written to blob3.
    const trace = fetchStats.trace ?? []
    const encoded = encodeFetchTrace(trace)
    analytics.writeDataPoint({
      blobs: [route, fetchStats.launchOrder ?? '', encoded.text],
      doubles: [1, trace.length, encoded.written],
      indexes: [STATUS_FETCH_TRACE_INDEX],
    })
    // One row per leg and timeout that made a fetch. blob1 route, blob2 leg.
    // doubles: count, timeout (ms), answered, timeouts, non-2xx, other errors, summed and maximum time to
    // headers of the answered, then the answered count per fifth of the timeout used (`budgetShareBucket`).
    for (const l of fetchStats.legs ?? []) {
      analytics.writeDataPoint({
        blobs: [route, l.leg],
        doubles: [
          1, l.budgetMs, l.answered, l.timeouts, l.httpErrors, l.otherErrors, l.answeredMs, l.maxAnsweredMs,
          ...l.answeredByBudgetShare,
        ],
        indexes: [statusFetchLegIndex(l)],
      })
    }
  } catch (err) {
    console.warn('[wae] status-fetch-run write failed:', err instanceof Error ? err.message : err)
  }
}

// #1910 — the dashboard's background poll reads /api/status/cached; this decides when that read asks
// the StatusRefresher Durable Object for a new live run, and when the run also writes the uptime counters.

/** A snapshot older than this asks for a refresh. */
export const REFRESH_STALE_MS = 60_000
/** One isolate asks the Durable Object at most this often. */
export const REFRESH_REQUEST_GAP_MS = 30_000
/** Runs start at least this far apart. */
export const REFRESH_MIN_GAP_MS = 55_000
/** A run that started longer ago than this is treated as dead (the alarm wall-time limit is 15 min). */
export const REFRESH_RUN_DEAD_MS = 15 * 60_000
/** The daily counters are written at most this often by the refresher. */
export const REFRESH_COUNTER_INTERVAL_MS = 5 * 60_000
/** New status-page components are checked at most this often by the refresher (#992). */
export const REFRESH_COMPONENT_INTERVAL_MS = 10 * 60_000

/** Whether a cached read should ask the Durable Object for a refresh. */
export function shouldRequestRefresh(cachedAt: string | undefined, lastRequestAt: number, nowMs: number): boolean {
  if (nowMs - lastRequestAt < REFRESH_REQUEST_GAP_MS) return false
  const cachedMs = cachedAt ? Date.parse(cachedAt) : NaN
  if (Number.isNaN(cachedMs)) return true
  return nowMs - cachedMs > REFRESH_STALE_MS
}

export interface RefresherState {
  alarmAt: number | null
  runStartedAt: number
  runFinishedAt: number
}

/** Whether the Durable Object should set its alarm for a run now. */
export function shouldScheduleRun(state: RefresherState, nowMs: number): boolean {
  if (state.alarmAt != null) return false
  const running = state.runStartedAt > state.runFinishedAt
  if (running && nowMs - state.runStartedAt < REFRESH_RUN_DEAD_MS) return false
  return nowMs - state.runStartedAt >= REFRESH_MIN_GAP_MS
}

/** Whether a periodic step of the run (counters, component detection) is due again. */
export function isDue(lastAt: number, nowMs: number, intervalMs: number): boolean {
  return nowMs - lastAt >= intervalMs
}

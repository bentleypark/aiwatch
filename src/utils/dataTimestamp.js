// #1910 — the time the data was read, as the Worker reports it (`lastUpdated`; the snapshot time on
// /api/status/cached), falling back to `now` when the response carries none or an unparseable one.
export function dataTimestamp(data, now = new Date()) {
  const ms = typeof data?.lastUpdated === 'string' ? Date.parse(data.lastUpdated) : NaN
  return Number.isNaN(ms) ? now : new Date(ms)
}

/** Snapshot age past which the Worker starts a refresh (worker/src/status-refresh.ts `REFRESH_STALE_MS`). */
export const STALE_SNAPSHOT_MS = 60_000
/** How long after a stale snapshot the dashboard polls once more, to pick up the refresh it started. */
export const FOLLOW_UP_POLL_MS = 20_000

/** The delay before a follow-up poll, or null when the snapshot was fresh enough to need none. */
export function followUpPollDelay(dataAt, nowMs) {
  return nowMs - dataAt.getTime() > STALE_SNAPSHOT_MS ? FOLLOW_UP_POLL_MS : null
}

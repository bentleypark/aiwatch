// #1006 — the shared trailing-window downtime accumulator every INTERVAL-based uptime parser calls
// (incident.io / Instatus / Flashduty / OnlineOrNot). The per-day-seconds sources (Atlassian
// Statuspage, Better Stack) do NOT use this — they already sum non-overlapping daily buckets.
//
// Two correctness rules live here, in ONE place, so the parsers can't drift apart on them (they did:
// a code review found incident.io + Instatus silently DROPPING open incidents while OnlineOrNot +
// Flashduty clamped them, and all four summing overlapping intervals):
//
//  1. An OPEN incident (no end / unparseable end) is clamped to `nowMs` — downtime accrues DURING a
//     live outage, which is exactly when uptime is consulted. Dropping it reads a spotless ~100% next
//     to an active incident, the incoherence #1006 set out to kill.
//  2. OVERLAPPING intervals on the same component are merged by taking the WORST (max) weight active
//     at each instant, never summed. A degraded window escalating into a full outage, or two
//     concurrent incidents on one component, must not double-count — summing can drive weightedSec
//     past the window and floor a service to a misleading 0%.

/** #1017 — start of the current UTC calendar day, in epoch ms. Shared by every interval-based uptime
 *  parser to compute a SECOND, cheap `weightedDowntimeSeconds` call (today's window instead of 30d)
 *  over the SAME `intervals[]` already built for the 30-day figure — the durable per-day archive input
 *  (see `daily:{date}`/`history:{date}` in index.ts's `cacheWrite`, kv-schema.md). */
export function startOfTodayUTC(nowMs: number): number {
  return Date.parse(new Date(nowMs).toISOString().split('T')[0] + 'T00:00:00Z')
}

export interface OutageInterval {
  /** epoch ms; an unparseable start is the caller's signal to drop the interval (can't place it). */
  start: number
  /** epoch ms, or null/NaN for an OPEN incident — clamped to `nowMs` here. */
  end: number | null
  /** severity weight (full 1.0 / partial·degraded 0.3 / maintenance 0). ≤0 is skipped. */
  weight: number
}

/**
 * Weighted downtime seconds over `[windowStart, nowMs]`, overlaps merged (worst-weight-wins).
 *
 * Sweep line: clip every interval to the window (open end → nowMs), collect the boundary instants,
 * and for each elementary sub-segment charge its duration at the MAX weight of the intervals covering
 * it. O(n²) in the interval count — fine for a single component's 30-day record (tens, not thousands).
 */
export function weightedDowntimeSeconds(
  intervals: OutageInterval[],
  windowStart: number,
  nowMs: number,
): number {
  const segs: Array<{ s: number; e: number; w: number }> = []
  for (const iv of intervals) {
    if (!(iv.weight > 0)) continue
    if (Number.isNaN(iv.start)) continue // can't place it — drop (caller already warns on unknowns)
    const rawEnd = iv.end == null || Number.isNaN(iv.end) ? nowMs : iv.end // open incident → now
    const s = Math.max(iv.start, windowStart)
    const e = Math.min(rawEnd, nowMs)
    if (e > s) segs.push({ s, e, w: iv.weight })
  }
  if (segs.length === 0) return 0

  const points = new Set<number>()
  for (const g of segs) {
    points.add(g.s)
    points.add(g.e)
  }
  const sorted = [...points].sort((a, b) => a - b)

  let seconds = 0
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (b <= a) continue
    let maxW = 0
    for (const g of segs) {
      if (g.s <= a && g.e >= b && g.w > maxW) maxW = g.w
    }
    seconds += ((b - a) / 1000) * maxW
  }
  return seconds
}

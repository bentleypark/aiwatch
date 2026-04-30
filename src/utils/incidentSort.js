/**
 * Incident sort helpers shared by the Incidents page and the Overview "Recent
 * Incidents" section.
 *
 * Tier order: investigating/identified ("ongoing") → monitoring → resolved.
 * Within a tier, most-recent-activity first (last timeline update, else
 * resolvedAt, else startedAt). Unknown status falls through to the resolved
 * tier so a malformed payload doesn't sort above real ongoing items.
 *
 * Status values mirror `worker/src/types.ts` Incident.status (4-state:
 * investigating/identified/monitoring/resolved) plus the legacy "ongoing"
 * alias retained for any caller that pre-normalizes. Keep this map aligned
 * with `INC_BAR_CLASS` in `src/pages/Overview.jsx`.
 *
 * See issue #354.
 */

export const STATUS_PRIORITY = {
  investigating: 0,
  identified:    0,
  ongoing:       0,  // legacy alias for pre-normalized data
  monitoring:    1,
  resolved:      2,
}

/**
 * Statuses in priority order, used by `dominantGroupStatus` to derive a
 * representative status for a flap group.
 *
 * Includes BOTH the normalized `'ongoing'` alias (used by `Incidents.jsx`,
 * whose `allIncidents` useMemo collapses `investigating`/`identified` →
 * `'ongoing'` before grouping) AND the raw worker statuses (used directly by
 * `ServiceDetails.jsx`, which does not pre-normalize). Putting `'ongoing'`
 * first makes the normalized path resolve correctly without breaking the
 * raw-status path: when `statusCounts` carries raw statuses, `'ongoing'` is
 * absent and `find` falls through to `investigating`/`identified` as
 * intended.
 *
 * Within a priority tier, the array order is itself the tiebreaker (e.g.
 * `investigating` is chosen over `identified` even though `STATUS_PRIORITY`
 * ties them at 0). Adding a new status to `STATUS_PRIORITY` therefore also
 * requires inserting it at the matching position here — `find()`
 * short-circuits on the first match.
 */
export const STATUS_ORDER = ['ongoing', 'investigating', 'identified', 'monitoring', 'resolved']

/**
 * Pick the highest-priority raw status present in a flap group. Falls back
 * to `resolved` only when `statusCounts` is empty or contains nothing in
 * `STATUS_ORDER` (defensive).
 *
 * Used to drive group-row badge color, badge label, and sort tier on the
 * Incidents page (issue #355). Without `STATUS_ORDER`, an investigating- or
 * identified-only group would fall through to `resolved` and sort below
 * monitoring + resolved rows.
 *
 * @param {{ uniformStatus?: boolean, statusCounts: Record<string, number> }} group
 * @returns {string}
 */
export function dominantGroupStatus(group) {
  if (group.uniformStatus) {
    const keys = Object.keys(group.statusCounts)
    return keys[0] ?? 'resolved'
  }
  return STATUS_ORDER.find((s) => group.statusCounts[s]) ?? 'resolved'
}

/**
 * Format a millisecond duration as `Nh Mm` or `Mm`. Mirrors the worker's
 * `formatDuration` (`worker/src/utils.ts`) so summed group durations on the
 * Incidents page render in the same shape as per-incident `duration` strings
 * coming from the API. Sub-minute durations round up to `1m` to avoid `0m`.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDurationMs(ms) {
  const totalMin = Math.max(1, Math.ceil(ms / 60_000))
  const hours = Math.floor(totalMin / 60)
  const minutes = totalMin % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

/**
 * Sum the cumulative impacted time across a flap group's entries. Returns the
 * total ms across resolved entries plus a flag indicating whether any entry
 * is still active. Wall-clock range (`rangeEnd − rangeStart`) was rejected
 * because it includes recovery gaps between flaps and overstates impact for
 * SLO accounting.
 *
 * Defensive: skips entries with missing/invalid timestamps so a malformed
 * payload doesn't crash the row render.
 *
 * @param {{ entries?: { startedAt?: string, resolvedAt?: string }[] }} group
 * @returns {{ totalMs: number, hasOngoing: boolean, resolvedCount: number }}
 */
export function sumGroupDuration(group) {
  let totalMs = 0
  let hasOngoing = false
  let resolvedCount = 0
  for (const entry of group.entries ?? []) {
    if (entry.resolvedAt && entry.startedAt) {
      const start = new Date(entry.startedAt).getTime()
      const end = new Date(entry.resolvedAt).getTime()
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        totalMs += end - start
        resolvedCount += 1
        continue
      }
      // Inverted or non-finite timestamps indicate an upstream parser/clock bug —
      // unambiguously not a legitimate ongoing incident. Surface in dev so the
      // engineer running `npm run dev` notices; production stays silent so a
      // single bad payload doesn't crash the row render.
      if (typeof console !== 'undefined' && import.meta?.env?.DEV) {
        console.warn('[sumGroupDuration] malformed entry timestamps, treating as ongoing', { startedAt: entry.startedAt, resolvedAt: entry.resolvedAt })
      }
    }
    hasOngoing = true
  }
  return { totalMs, hasOngoing, resolvedCount }
}

/**
 * Resolved timestamp — `resolvedAt` field, or the last `resolved` timeline
 * entry, or null when the incident hasn't resolved yet.
 *
 * @param {{ resolvedAt?: string, timeline?: { stage: string, at: string }[] }} inc
 * @returns {string | null}
 */
export function getResolvedTime(inc) {
  if (inc.resolvedAt) return inc.resolvedAt
  const tl = inc.timeline ?? []
  const resolvedEntry = [...tl].reverse().find((t) => t.stage === 'resolved')
  return resolvedEntry?.at ?? null
}

/**
 * Most-recent-activity timestamp (ms epoch) for sort ordering.
 *
 * Resolved incidents prefer the resolved time so a recently-resolved incident
 * outranks an old resolved one. Active incidents prefer the last timeline
 * update so an incident with a fresh status-page comment outranks a stale one
 * that started earlier but hasn't moved.
 *
 * @param {{ status: string, resolvedAt?: string, startedAt: string, timeline?: { stage: string, at: string }[] }} inc
 * @returns {number}
 */
export function getLatestActivity(inc) {
  if (inc.status === 'resolved') {
    const resolved = getResolvedTime(inc)
    if (resolved) return new Date(resolved).getTime()
  }
  const tl = inc.timeline ?? []
  const lastTimeline = tl.length > 0 ? tl[tl.length - 1] : undefined
  if (lastTimeline?.at) return new Date(lastTimeline.at).getTime()
  return new Date(inc.startedAt).getTime()
}

/**
 * Comparator: tier first, latest-activity desc within tier. Stable on equal
 * keys (relies on Array.prototype.sort being stable per ES2019+).
 *
 * @param {{ status: string }} a
 * @param {{ status: string }} b
 * @returns {number}
 */
export function compareIncidents(a, b) {
  const aPri = STATUS_PRIORITY[a.status] ?? 2
  const bPri = STATUS_PRIORITY[b.status] ?? 2
  if (aPri !== bPri) return aPri - bPri
  return getLatestActivity(b) - getLatestActivity(a)
}

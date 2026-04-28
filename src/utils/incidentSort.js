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

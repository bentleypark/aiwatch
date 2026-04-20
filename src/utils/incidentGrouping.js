/**
 * Group flap-style auto-recovery incidents in the UI without altering source data.
 *
 * Background: BetterStack-based status feeds (Fireworks AI, Together AI) emit a separate
 * "<model> — recovered" entry per transient blip. A single model can flap 10-20 times in a
 * day, swamping the Incident History UI. Grouping pulls these into a single expandable
 * row while leaving raw incident data untouched (Discord pipeline + monthly reports stay raw).
 *
 * Threshold rationale: ≥3 (not ≥2). Two entries don't earn a group row — the UI overhead
 * outweighs the dedup benefit.
 *
 * impact != null is never grouped: real human-tagged incidents stay individually visible.
 *
 * Day boundary: **viewer's local date**. Earlier draft used UTC because cron archival
 * keys on UTC, but that's a server concern. The user reads timestamps rendered in their
 * local timezone — grouping by UTC produced groups that visibly straddle two displayed
 * dates (e.g., a UTC 2026-04-16 20:00 entry shows as 2026-04-17 05:00 KST and got merged
 * with same-day entries that show as 2026-04-16 23:30 KST). Grouping must follow what
 * the eye sees, not what the storage layer uses.
 *
 * The `timeZone` option exists for deterministic tests — production callers omit it
 * and get the runtime default (browser TZ in the SPA).
 *
 * See issue #282.
 */

export const GROUP_THRESHOLD = 3

/**
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  return String(title ?? '').replace(/\s*—\s*recovered\s*$/, '').trim()
}

/**
 * @typedef {Object} Incident
 * @property {string} id
 * @property {string} title
 * @property {string} startedAt - ISO 8601
 * @property {'investigating'|'identified'|'monitoring'|'resolved'} status
 * @property {'minor'|'major'|'critical'|null} [impact]
 * @property {string|null} [duration]
 * @property {string|null} [resolvedAt]
 * @property {Array<unknown>} [timeline]
 */

/**
 * @typedef {Object} GroupRow
 * @property {'group'} kind
 * @property {string} dayKey - YYYY-MM-DD in viewer's local timezone (or supplied `timeZone`)
 * @property {string} normalizedTitle
 * @property {number} count
 * @property {string} rangeStart - ISO 8601, earliest startedAt
 * @property {string} rangeEnd - ISO 8601, latest startedAt
 * @property {Record<string, number>} statusCounts
 * @property {boolean} uniformStatus - true if all entries share the same status
 * @property {Incident[]} entries - in original input order
 */

/**
 * @typedef {Object} SingleRow
 * @property {'single'} kind
 * @property {Incident} incident
 */

/**
 * Format an ISO timestamp as a YYYY-MM-DD calendar day in the given timezone.
 * Uses 'en-CA' locale (always YYYY-MM-DD) — independent of the viewer's locale.
 * @param {string} iso
 * @param {string|undefined} timeZone - omit for runtime default (browser TZ in SPA)
 * @returns {string}
 */
function localDayKey(iso, timeZone) {
  return new Date(iso).toLocaleDateString('en-CA', timeZone ? { timeZone } : undefined)
}

/**
 * Group qualifying incidents; pass others through individually.
 * Output sorted newest-first by representative time
 * (rangeEnd for groups, startedAt for singles).
 *
 * @param {Incident[]} incidents
 * @param {{ timeZone?: string }} [options] - timeZone override (tests). Omit in production.
 * @returns {Array<GroupRow|SingleRow>}
 */
export function groupIncidents(incidents, options = {}) {
  if (!Array.isArray(incidents) || incidents.length === 0) return []
  const { timeZone } = options

  // Bucket by (dayKey, normalizedTitle). Skip non-null impact — those never group.
  const buckets = new Map()
  const ungroupable = []
  incidents.forEach((inc, idx) => {
    if (inc.impact != null) {
      ungroupable.push({ idx, inc })
      return
    }
    const dayKey = localDayKey(inc.startedAt, timeZone)
    const key = `${dayKey}::${normalizeTitle(inc.title)}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { dayKey, normalizedTitle: normalizeTitle(inc.title), entries: [], firstIdx: idx }
      buckets.set(key, bucket)
    }
    bucket.entries.push(inc)
  })

  /** @type {Array<{ row: GroupRow|SingleRow, sortKey: string, idx: number }>} */
  const rows = []

  for (const { dayKey, normalizedTitle: nt, entries, firstIdx } of buckets.values()) {
    if (entries.length >= GROUP_THRESHOLD) {
      const startedAtTimes = entries.map(e => e.startedAt)
      const rangeStart = startedAtTimes.reduce((a, b) => a < b ? a : b)
      const rangeEnd = startedAtTimes.reduce((a, b) => a > b ? a : b)
      const statusCounts = {}
      for (const e of entries) statusCounts[e.status] = (statusCounts[e.status] ?? 0) + 1
      rows.push({
        row: {
          kind: 'group',
          dayKey,
          normalizedTitle: nt,
          count: entries.length,
          rangeStart,
          rangeEnd,
          statusCounts,
          uniformStatus: Object.keys(statusCounts).length === 1,
          entries,
        },
        sortKey: rangeEnd,
        idx: firstIdx,
      })
    } else {
      // Below threshold — render each as a single row.
      entries.forEach((inc) => {
        const idx = incidents.indexOf(inc)
        rows.push({ row: { kind: 'single', incident: inc }, sortKey: inc.startedAt, idx })
      })
    }
  }

  for (const { idx, inc } of ungroupable) {
    rows.push({ row: { kind: 'single', incident: inc }, sortKey: inc.startedAt, idx })
  }

  // Newest first by sortKey; tiebreak by original input index for stable ordering.
  rows.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? 1 : -1
    return a.idx - b.idx
  })

  return rows.map(r => r.row)
}

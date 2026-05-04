// Server-side incident grouping for /is-X-down SSR pages.
//
// Keep in sync with src/utils/incidentGrouping.js (SPA side). The SPA defaults to the
// viewer's local timezone because its output is rendered client-side; the SSR page
// must be deterministic across visitors, so this port defaults to 'UTC'.
//
// Background (same as SPA): BetterStack-backed feeds (Fireworks, Together, HuggingFace,
// Modal) emit a separate "<model> — recovered" entry per transient blip. Same-day
// normalized-title clusters of ≥2 collapse into a single group row so the visible list
// stays readable while the underlying data remains intact for downstream pipelines.
//
// Threshold lowered from ≥3 to ≥2 in #373 (in lockstep with SPA) so Mistral's auto-monitoring
// 2-3-per-day-per-endpoint pattern clusters too — previously they fell just under the old cap.
//
// See #282 (SPA grouping), #321 (SSR 30-day window + grouping), #373 (≥3 → ≥2 retune).

export const GROUP_THRESHOLD = 2

export interface GroupingIncident {
  id: string
  title: string
  startedAt: string
  status: string
  // Non-optional to match the ServiceData.incidents[].impact shape emitted by the worker
  // (`string | null` — never undefined). The JS reference in src/utils/incidentGrouping.js
  // relies on `impact != null` which accepts both — keeping this required here prevents
  // the SSR entry from drifting from the upstream contract.
  impact: string | null
  duration?: string | null
  resolvedAt?: string | null
}

export interface GroupRow {
  kind: 'group'
  dayKey: string
  normalizedTitle: string
  count: number
  rangeStart: string
  rangeEnd: string
  statusCounts: Record<string, number>
  uniformStatus: boolean
  entries: GroupingIncident[]
}

export interface SingleRow {
  kind: 'single'
  incident: GroupingIncident
}

export type GroupedRow = GroupRow | SingleRow

export function normalizeTitle(title: string | null | undefined): string {
  return String(title ?? '').replace(/\s*—\s*recovered\s*$/, '').trim()
}

function localDayKey(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone })
}

export function groupIncidents(
  incidents: GroupingIncident[],
  options: { timeZone?: string } = {},
): GroupedRow[] {
  if (!Array.isArray(incidents) || incidents.length === 0) return []
  const { timeZone = 'UTC' } = options

  const buckets = new Map<string, { dayKey: string; normalizedTitle: string; entries: GroupingIncident[]; firstIdx: number }>()
  const ungroupable: Array<{ idx: number; inc: GroupingIncident }> = []

  incidents.forEach((inc, idx) => {
    if (inc.impact != null) {
      ungroupable.push({ idx, inc })
      return
    }
    const dayKey = localDayKey(inc.startedAt, timeZone)
    const nt = normalizeTitle(inc.title)
    const key = `${dayKey}::${nt}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { dayKey, normalizedTitle: nt, entries: [], firstIdx: idx }
      buckets.set(key, bucket)
    }
    bucket.entries.push(inc)
  })

  const rows: Array<{ row: GroupedRow; sortKey: string; idx: number }> = []

  for (const { dayKey, normalizedTitle: nt, entries, firstIdx } of buckets.values()) {
    if (entries.length >= GROUP_THRESHOLD) {
      const startedAtTimes = entries.map((e) => e.startedAt)
      const rangeStart = startedAtTimes.reduce((a, b) => (a < b ? a : b))
      const rangeEnd = startedAtTimes.reduce((a, b) => (a > b ? a : b))
      const statusCounts: Record<string, number> = {}
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
      entries.forEach((inc) => {
        const idx = incidents.indexOf(inc)
        rows.push({ row: { kind: 'single', incident: inc }, sortKey: inc.startedAt, idx })
      })
    }
  }

  for (const { idx, inc } of ungroupable) {
    rows.push({ row: { kind: 'single', incident: inc }, sortKey: inc.startedAt, idx })
  }

  rows.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? 1 : -1
    return a.idx - b.idx
  })

  return rows.map((r) => r.row)
}

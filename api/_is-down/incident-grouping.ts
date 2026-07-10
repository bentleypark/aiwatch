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

// Generic auto-monitoring title patterns — anchored to match only bare
// Statuspage placeholders. Real human-curated copy must NOT match. See
// `GENERIC_TITLE_PATTERNS` in `worker/src/ai-analysis.ts` (source of truth)
// and `src/utils/incidentGrouping.js` (SPA mirror). #387.
const GENERIC_TITLE_PATTERNS: RegExp[] = [
  /^investigating (an |the |this )?issue\.?$/i,
  /^(service |system )?(disruption|outage|issue|incident)\.?$/i,
  /^we are (currently )?(investigating|aware)( (of )?(an?|this|the) (issue|incident|problem))?\.?$/i,
  /^(scheduled |planned )?maintenance\.?$/i,
  /^(partial |minor |major )?(service )?(degradation|interruption)\.?$/i,
]

/** Stable serialized form for cross-file parity assertions. See worker mirror. */
export const GENERIC_TITLE_PATTERNS_SOURCES: readonly string[] = GENERIC_TITLE_PATTERNS.map(
  (p) => `${p.source}::${p.flags}`,
)

export function isGenericTitle(title: string | null | undefined): boolean {
  const t = String(title ?? '').trim()
  return GENERIC_TITLE_PATTERNS.some((p) => p.test(t))
}

// Latest-activity timestamp in ms for sort ordering — resolved incidents prefer
// `resolvedAt` so a recently-resolved entry outranks an older resolved one,
// matching `getLatestActivity` in `src/utils/incidentSort.js`. SSR's
// `GroupingIncident` shape intentionally omits the `timeline` field, so the
// active branch falls straight to `startedAt`. The SPA's timeline-based
// promotion ("last timeline entry post-dates startedAt → use that") therefore
// has no SSR analogue by design — do NOT add it here without also extending
// the SSR payload contract. Used as the cross-row sort key in `groupIncidents`
// so the visible Incidents / ServiceDetails / Is X Down order matches Overview
// (#411 follow-up to #406).
function getLatestActivityMs(inc: { status: string; startedAt: string; resolvedAt?: string | null }): number {
  if (inc.status === 'resolved' && inc.resolvedAt) {
    return new Date(inc.resolvedAt).getTime()
  }
  return new Date(inc.startedAt).getTime()
}

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
  // #983 — worker-stamped: the provider's auto-monitor opened this incident, so `impact` is
  // component-derived rather than a human severity call. Optional because only opted-in services
  // (ServiceConfig.autoMonitorTitles) emit it.
  autoMonitor?: boolean
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
  return String(title ?? '').replace(/\s*—\s*(recovered|down)\s*$/i, '').trim()
}

// BetterStack auto-recovery flap marker — "<model> — recovered" / "<model> — down".
// BetterStack tags these transient model blips with a `minor` impact (not null), so the
// `impact != null` guard alone leaves them ungrouped and they swamp the history (#597,
// Together/Fireworks). The suffix is machine-emitted (human-curated incidents don't title
// themselves "X — recovered"), and the ≥2 same-(day, normalized-title) GROUP_THRESHOLD
// guards against folding a genuine one-off. Kept in lockstep with the SPA copy
// (`src/utils/incidentGrouping.js`); the alert-side `FLAP_TITLE_RE` in
// `worker/src/alerts.ts` matches the same suffix but is case-sensitive — this display
// copy adds the `/i` flag as a deliberate (BetterStack emits lowercase) widening.
const FLAP_TITLE_RE = /\s*—\s*(recovered|down)\s*$/i
export function isFlapTitle(title: string | null | undefined): boolean {
  return FLAP_TITLE_RE.test(String(title ?? ''))
}

// Instatus auto-monitor noise marker — "<Component> Degraded" / "<Component> Degraded
// Performance", optionally trailed by a "- <model>" or "· <service>" tail. Instatus maps
// DEGRADEDPERFORMANCE → `minor` (not null) by design (#564), so these auto-monitor blips
// escape the `impact != null` guard and swamp the history the same way BetterStack flaps do
// (#599, Mistral). The status word must sit at the end (or before the "-"/"·" tail) so prose
// like "API degraded due to upstream" does NOT match; with the minor gate + ≥2 same-(day,
// normalized-title) GROUP_THRESHOLD this stays tight. "Down" is deliberately excluded
// (broader false-positive surface; the observed noise is all "Degraded"). Lockstep with SPA.
const AUTOMONITOR_TITLE_RE = /\bdegraded(\s+performance)?\b\s*(?:[·\-]\s.*)?$/i
export function isAutoMonitorTitle(title: string | null | undefined): boolean {
  return AUTOMONITOR_TITLE_RE.test(String(title ?? ''))
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
    // Real human-curated incidents (impact != null) skip clustering — EXCEPT
    // (a) Statuspage auto-monitoring placeholders (Character.AI, #387),
    // (b) machine-emitted `minor` auto-monitor noise: BetterStack flap markers
    // "<model> — recovered/down" (#597, Together/Fireworks) + Instatus "<X> Degraded"
    // blips (#599, Mistral), and (c) worker-tagged `autoMonitor` incidents (#983, Twelve Labs),
    // whose `impact` may be 'major' purely because one sub-component read `major_outage`.
    // All cluster because the impact is boilerplate, not curation.
    // Lockstep with src/utils/incidentGrouping.js.
    const isMinorAutoNoise = inc.impact === 'minor' && (isFlapTitle(inc.title) || isAutoMonitorTitle(inc.title))
    if (inc.impact != null && !inc.autoMonitor && !isGenericTitle(inc.title) && !isMinorAutoNoise) {
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

  const rows: Array<{ row: GroupedRow; sortKey: number; idx: number }> = []

  for (const { dayKey, normalizedTitle: nt, entries, firstIdx } of buckets.values()) {
    if (entries.length >= GROUP_THRESHOLD) {
      const startedAtTimes = entries.map((e) => e.startedAt)
      const rangeStart = startedAtTimes.reduce((a, b) => (a < b ? a : b))
      // rangeEnd stays as the displayed time *range* (max startedAt across the
      // bucket). Cross-row sort uses latest activity computed separately so a
      // group's most-recently-resolved entry ranks the group correctly even when
      // startedAt-rangeEnd would have placed it elsewhere (#411).
      const rangeEnd = startedAtTimes.reduce((a, b) => (a > b ? a : b))
      const statusCounts: Record<string, number> = {}
      for (const e of entries) statusCounts[e.status] = (statusCounts[e.status] ?? 0) + 1
      const latestActivityMs = entries.reduce((m, e) => Math.max(m, getLatestActivityMs(e)), 0)
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
        sortKey: latestActivityMs,
        idx: firstIdx,
      })
    } else {
      entries.forEach((inc) => {
        const idx = incidents.indexOf(inc)
        rows.push({ row: { kind: 'single', incident: inc }, sortKey: getLatestActivityMs(inc), idx })
      })
    }
  }

  for (const { idx, inc } of ungroupable) {
    rows.push({ row: { kind: 'single', incident: inc }, sortKey: getLatestActivityMs(inc), idx })
  }

  rows.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return b.sortKey - a.sortKey
    return a.idx - b.idx
  })

  return rows.map((r) => r.row)
}

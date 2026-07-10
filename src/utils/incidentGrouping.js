/**
 * Group flap-style auto-recovery incidents in the UI without altering source data.
 *
 * Background: BetterStack-based status feeds (Fireworks AI, Together AI) emit a separate
 * "<model> — recovered" entry per transient blip. A single model can flap 10-20 times in a
 * day, swamping the Incident History UI. Grouping pulls these into a single expandable
 * row while leaving raw incident data untouched (Discord pipeline + monthly reports stay raw).
 *
 * Threshold rationale: ≥2 (lowered from ≥3 in #373). Originally ≥3 because BetterStack
 * RSS-only services (Together AI, Fireworks AI) tended to flap many times per day, and a
 * threshold of 3 cleanly separated repeat noise from one-off events. After #373 removed the
 * Mistral-only probe corroboration filter, Mistral's auto-monitoring incidents (typically
 * 2-3 per day per endpoint) needed clustering too — and they fell *just* below the old
 * threshold most days. ≥2 captures those without affecting human-classified incidents:
 * Atlassian/incident.io services almost never emit two identical-title incidents on the
 * same calendar day in practice.
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

import { getLatestActivity } from './incidentSort.js'

export const GROUP_THRESHOLD = 2

/**
 * Generic incident-title patterns indicating Atlassian Statuspage's
 * auto-monitoring noise (Character.AI is the canonical case — #387).
 *
 * Each pattern is anchored (`^...$`) and matches only the bare placeholder
 * the status page auto-emits. Real human-curated copy must NOT match — the
 * cost of a false positive is real: the incident gets folded into a flap
 * group AND its AI analysis is skipped on the worker side.
 *
 * MIRROR of `GENERIC_TITLE_PATTERNS` in `worker/src/ai-analysis.ts`. The
 * `GENERIC_TITLE_PATTERNS_SOURCES` array and a shared parity test (#387)
 * lock the three copies (SPA / SSR / Worker) against drift.
 */
const GENERIC_TITLE_PATTERNS = [
  /^investigating (an |the |this )?issue\.?$/i,
  /^(service |system )?(disruption|outage|issue|incident)\.?$/i,
  /^we are (currently )?(investigating|aware)( (of )?(an?|this|the) (issue|incident|problem))?\.?$/i,
  /^(scheduled |planned )?maintenance\.?$/i,
  /^(partial |minor |major )?(service )?(degradation|interruption)\.?$/i,
]

/** Stable serialized form for cross-file parity assertions. See worker mirror. */
export const GENERIC_TITLE_PATTERNS_SOURCES = GENERIC_TITLE_PATTERNS.map((p) => `${p.source}::${p.flags}`)

/** @param {string} title */
export function isGenericTitle(title) {
  const t = String(title ?? '').trim()
  return GENERIC_TITLE_PATTERNS.some((p) => p.test(t))
}

/**
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  return String(title ?? '').replace(/\s*—\s*(recovered|down)\s*$/i, '').trim()
}

/**
 * BetterStack auto-recovery flap marker — "<model> — recovered" / "<model> — down".
 * BetterStack tags these transient model blips with a `minor` impact (not null), so
 * the `impact != null` guard alone leaves them ungrouped and they swamp the history
 * (#597, Together/Fireworks). The suffix is machine-emitted — human-curated incidents
 * don't title themselves "X — recovered" — and the ≥2 same-(day, normalized-title)
 * GROUP_THRESHOLD guards against folding a genuine one-off. Kept in lockstep with the
 * SSR port (`api/_is-down/incident-grouping.ts`); the alert-side `FLAP_TITLE_RE` in
 * `worker/src/alerts.ts` matches the same suffix but is case-sensitive — this display
 * copy adds the `/i` flag as a deliberate (BetterStack emits lowercase) widening.
 * @param {string} title
 * @returns {boolean}
 */
const FLAP_TITLE_RE = /\s*—\s*(recovered|down)\s*$/i
export function isFlapTitle(title) {
  return FLAP_TITLE_RE.test(String(title ?? ''))
}

/**
 * Instatus auto-monitor noise marker — "<Component> Degraded" / "<Component> Degraded
 * Performance", optionally trailed by a "- <model>" or "· <service>" tail
 * ("Completion API Degraded - mistral-tiny-2407 · Chat Completions API"). Instatus maps
 * DEGRADEDPERFORMANCE → `minor` (not null) by design (#564 / status-determination.md), so
 * these auto-monitor blips escape the `impact != null` guard and swamp the history the
 * same way BetterStack flaps do (#599, Mistral). The status word must sit at the end (or
 * before the "-"/"·" tail) so prose like "API degraded due to upstream" does NOT match;
 * combined with the minor gate + the ≥2 same-(day, normalized-title) GROUP_THRESHOLD this
 * stays tight. "Down" is deliberately excluded (broader false-positive surface; the
 * observed Instatus auto-monitor noise is all "Degraded"). Lockstep with the SSR port.
 * @param {string} title
 * @returns {boolean}
 */
const AUTOMONITOR_TITLE_RE = /\bdegraded(\s+performance)?\b\s*(?:[·\-]\s.*)?$/i
export function isAutoMonitorTitle(title) {
  return AUTOMONITOR_TITLE_RE.test(String(title ?? ''))
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
 * Group qualifying incidents; pass others through individually. Output is
 * sorted newest-first by `getLatestActivity` (resolved → resolvedAt, active
 * → last timeline entry / startedAt) — same axis `compareIncidents` uses on
 * Overview so the visible order on Incidents / ServiceDetails / Is X Down
 * matches the order Overview shows (#411 follow-up to #406). For groups, the
 * representative time is the max `getLatestActivity` across entries (replaces
 * the prior `rangeEnd = max(startedAt)` which silently diverged from the sort
 * axis whenever a flap group's most-recently-resolved entry had a different
 * startedAt-vs-resolvedAt rank).
 *
 * @param {Incident[]} incidents
 * @param {{ timeZone?: string }} [options] - timeZone override (tests). Omit in production.
 * @returns {Array<GroupRow|SingleRow>}
 */
export function groupIncidents(incidents, options = {}) {
  if (!Array.isArray(incidents) || incidents.length === 0) return []
  const { timeZone } = options

  // Bucket by (dayKey, normalizedTitle). Skip non-null impact — those represent
  // real human-curated incidents — EXCEPT (a) generic auto-monitoring titles
  // (Statuspage assigns a default impact even to noise — #387, Character.AI),
  // (b) machine-emitted `minor` auto-monitor noise: BetterStack flap markers
  // "<model> — recovered/down" (#597, Together/Fireworks) + Instatus "<X> Degraded"
  // blips (#599, Mistral), and (c) incidents the WORKER tagged `autoMonitor` (#983).
  // All still cluster.
  //
  // (c) is the source-tagged case and needs no title heuristic here: the worker matched the
  // provider's machine-emitted title against an anchored per-service allowlist and serialized the
  // verdict on /api/status. The other two must sniff titles because they predate the tag. It also
  // ignores `impact` entirely — a Twelve Labs auto-monitor blip carries `impact: 'major'` only
  // because one sub-component read `major_outage`, which is exactly the inference (a) and (b) get
  // wrong. Incidents supplemented from a MONTHLY ARCHIVE written before the tag shipped carry no
  // `autoMonitor` field and so still render individually; the archive accumulator is additive and
  // does not self-heal (see #934/#975).
  const buckets = new Map()
  const ungroupable = []
  incidents.forEach((inc, idx) => {
    const isMinorAutoNoise = inc.impact === 'minor' && (isFlapTitle(inc.title) || isAutoMonitorTitle(inc.title))
    if (inc.impact != null && !inc.autoMonitor && !isGenericTitle(inc.title) && !isMinorAutoNoise) {
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

  /** @type {Array<{ row: GroupRow|SingleRow, sortKey: number, idx: number }>} */
  const rows = []

  for (const { dayKey, normalizedTitle: nt, entries, firstIdx } of buckets.values()) {
    if (entries.length >= GROUP_THRESHOLD) {
      const startedAtTimes = entries.map(e => e.startedAt)
      const rangeStart = startedAtTimes.reduce((a, b) => a < b ? a : b)
      // rangeEnd is the bucket's visible time *range*, used for display (#373).
      // Sorting is by latest activity across entries, computed separately so a
      // group whose most-recently-resolved entry resolved later than another
      // group's still ranks newer even if their startedAt ranges coincide.
      const rangeEnd = startedAtTimes.reduce((a, b) => a > b ? a : b)
      const statusCounts = {}
      for (const e of entries) statusCounts[e.status] = (statusCounts[e.status] ?? 0) + 1
      const latestActivityMs = entries.reduce((m, e) => Math.max(m, getLatestActivity(e)), 0)
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
      // Below threshold — render each as a single row.
      entries.forEach((inc) => {
        const idx = incidents.indexOf(inc)
        rows.push({ row: { kind: 'single', incident: inc }, sortKey: getLatestActivity(inc), idx })
      })
    }
  }

  for (const { idx, inc } of ungroupable) {
    rows.push({ row: { kind: 'single', incident: inc }, sortKey: getLatestActivity(inc), idx })
  }

  // Newest first by sortKey (ms epoch); tiebreak by original input index for stable ordering.
  rows.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return b.sortKey - a.sortKey
    return a.idx - b.idx
  })

  return rows.map(r => r.row)
}

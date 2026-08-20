// Statuspage API Parser (Atlassian format)

import type { TimelineEntry, Incident, DailyImpactLevel } from '../types'
import { formatDuration } from '../utils'
import { MAJOR_WEIGHT, MINOR_WEIGHT } from './impact-weights'

export interface StatuspageResponse {
  status: { indicator: string; description: string }
  // `id` is the Atlassian component UUID — read by resolveSvcStatus / resolveSvcComponents
  // (#379, #604) for statusComponentIds matching. Present in every real summary.json
  // component; declared here so those id-based lookups are type-sound.
  components?: Array<{ id: string; name: string; status: string }>
  incidents?: Array<{
    id: string
    name: string
    status: string
    impact: string
    created_at: string
    resolved_at: string | null
    shortlink?: string
    components?: Array<{ name: string }>
    incident_updates?: Array<{
      status: string; body: string; created_at: string; display_at?: string
      // `| null` is not defensive padding: status.claude.com really sends `affected_components: null`
      // on an update that touched no component (9 such updates on the page as of 2026-07-17, including
      // `kqbd7wm6hnnr`'s own resolve). Declaring it non-nullable made the type lie about the payload
      // `resolveComponentNames` reads (#1047).
      affected_components?: Array<{ code: string; name: string; new_status: string }> | null
    }>
  }>
}

export function normalizeStatus(indicator: string): 'operational' | 'degraded' | 'down' {
  switch (indicator) {
    case 'none':
    case 'operational':
      return 'operational'
    case 'minor':
    case 'degraded_performance':
    case 'partial_outage':
      return 'degraded'
    case 'major':
    case 'critical':
    case 'major_outage':
      return 'down'
    default:
      return 'operational'
  }
}

type RawIncident = NonNullable<StatuspageResponse['incidents']>[number]

/**
 * The component names an incident affected (#1047).
 *
 * `inc.components` can be EMPTY on an incident that really did degrade components: a provider may
 * UNLINK them all as it resolves (Anthropic's 2026-07-16 `kqbd7wm6hnnr` went out tagged with 4 and
 * resolved with `components: []`). That destroys attribution for a service scoped by `incidentKeywords`
 * — `filterIncidents` matches those keywords against the title OR these names, so an incident whose
 * title carries no token silently stops being theirs at the moment it resolves. The update history
 * still names the components, so recover from there.
 *
 * ONLY when the live list is empty. Same empty-only rule, and the same deference to a source that
 * starts populating the field again, as `attachIncidentIoComponentNames` (#1004,
 * parsers/incident-io.ts) — the two are the house convention for this field; keep them in step. Do NOT
 * turn it into a union with the history: `filterIncidents` reads these names on EVERY incident, so a
 * union broadens attribution page-wide (the #361 cross-attribution class) to "fix" incidents that were
 * never broken.
 *
 * Updates arrive newest-first, so walk them in reverse. Every consumer that GATES on these names is a
 * membership test, so none is order-sensitive — this is determinism, not correctness. (`supply-chain.ts`
 * joins them into a text blob instead, but only to regex out region tokens, and it skips resolved
 * incidents outright.) It unions ACROSS updates because each one names only the components IT touched,
 * so no single update is guaranteed complete.
 *
 * Two deliberate residuals: a PARTIAL unlink leaves a non-empty list, so this never fires (unobserved —
 * don't widen on speculation); and `new_status` is ignored, so a component named only as `operational`
 * still counts as affected — the alternative loses attribution outright when the resolve update is the
 * only one carrying components, and losing attribution is the bug this exists to fix.
 *
 * Measured blast radius, the downstream emptiness-coupling this reclassifies (#970 / #934 / #359 /
 * `includeUntaggedIncidents`), and why it is inert for incident.io — all with their numbers and dates:
 * docs/reference/status-determination.md, the #1047 bullet.
 */
export function resolveComponentNames(inc: RawIncident): string[] {
  const live = inc.components?.map((c) => c.name) ?? []
  if (live.length > 0) return live

  const recovered: string[] = []
  for (const update of [...(inc.incident_updates ?? [])].reverse()) {
    for (const comp of update.affected_components ?? []) {
      if (comp?.name && !recovered.includes(comp.name)) recovered.push(comp.name)
    }
  }
  return recovered
}

export function parseIncidents(data: StatuspageResponse): Incident[] {
  return (data.incidents ?? []).map((inc) => {
    const duration = inc.resolved_at
      ? formatDuration(new Date(inc.created_at), new Date(inc.resolved_at))
      : null
    const rawTimeline: TimelineEntry[] = (inc.incident_updates ?? [])
      .map((u) => ({
        stage: u.status === 'resolved' ? 'resolved' as const
          : u.status === 'monitoring' ? 'monitoring' as const
          : u.status === 'identified' ? 'identified' as const
          : 'investigating' as const,
        text: u.body || null,
        at: u.display_at ?? u.created_at,
      }))
      .reverse() // oldest first
    // Deduplicate: keep one entry per stage+time (removes duplicate updates)
    const seen = new Set<string>()
    const timeline = rawTimeline.filter((t) => {
      const key = `${t.stage}:${t.at}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const impact = inc.impact === 'critical' ? 'critical' as const
      : inc.impact === 'major' ? 'major' as const
      : inc.impact === 'minor' ? 'minor' as const
      : null

    const componentNames = resolveComponentNames(inc)

    return {
      id: inc.id,
      title: inc.name,
      status: (inc.status === 'resolved' || inc.status === 'postmortem') ? 'resolved'
        : inc.status === 'monitoring' ? 'monitoring'
        : inc.status === 'identified' ? 'identified'
        : 'investigating',
      impact,
      ...(componentNames.length > 0 ? { componentNames } : {}),
      startedAt: inc.created_at,
      resolvedAt: inc.resolved_at ?? null,
      duration,
      timeline,
    }
  })
}

interface UptimeDayEntry {
  date: string
  outages?: { p?: number; m?: number }
  related_events?: Array<{ name: string }>
}


export interface UptimeDataResult {
  dailyImpact: Record<string, DailyImpactLevel>
  /** #1006 — AIWatch's TRAILING-30-DAY uptime. The `days` array Atlassian embeds carries **90 days**
   *  (verified live on status.claude.com / status.cursor.com: 2026-04-16 → 2026-07-14), and the
   *  pre-#1006 code divided by all of them — so the field named `uptime30d` held a NINETY-day figure for
   *  every Atlassian service, and the Score fed it into a 40-point component whose sibling components
   *  (Incidents 25 / Recovery 15) are computed over 30 days. #654 spotted the mismatch and removed the
   *  "30-day" LABEL; it did not touch the number, or the Score that consumes it. */
  uptimePercent: number | null
  /** Days the figure above actually covers — 30 unless the page carries fewer. */
  windowDays: number | null
  /** #1006 — the figure the page shows a DESKTOP visitor: the same formula over every day it embeds
   *  (≈90). Verified: status.claude.com renders "90 days ago … 99.58% uptime" on a wide screen, and this
   *  reproduces it. Shown beside our 30-day number so the reader can check us against the provider —
   *  which is what #41 built AIWatch to do. */
  uptimeReported: number | null
  /** Days `uptimeReported` covers (≈90) — stated in the UI, because the provider's own page does not
   *  commit to one: it renders 30 / 60 / 90 days depending on the viewport. */
  uptimeReportedDays: number | null
  /** #1017 — TODAY's (UTC calendar day) weighted outage seconds, the exact `weighted(day)` value the
   *  loop below already computes per published day — just read off today's entry instead of summed
   *  into the 30-day total. `null` when the page has no entry for today yet (first cycle of the day,
   *  before the provider publishes it) or the component wasn't found. Same weight scheme as
   *  `uptimePercent` (MAJOR_WEIGHT/MINOR_WEIGHT) — the durable per-day archive input, see
   *  ServiceStatus.todayWeightedOutageSec. NOT computed for Better Stack (`platform_avg`), whose
   *  weighting is a genuinely different computation (#1110) — mixing them into one field would be
   *  exactly the "not the same window and weights" mistake that doc warns against. */
  todayWeightedOutageSec: number | null
}

// #1006 — WHY the trailing 30 and not all 90.
//
// An Atlassian page embeds 90 days of per-day records but RENDERS a window that depends on the viewport:
// status.claude.com shows "90 days ago … 99.58% uptime" on a wide screen and "30 days ago … 99.75%" on a
// narrow one. So there is no single figure "the provider publishes" — the window is a rendering choice,
// and BOTH numbers are theirs. The pre-#1006 code divided by all 90 days, i.e. it happened to reproduce
// the wide-screen figure; the field was nonetheless called `uptime30d` and fed a Score whose other
// components (Incidents 25 / Recovery 15) are computed over 30 days. #654 spotted the label was wrong and
// removed the "30-day" wording — it did not touch the number, or the Score that consumes it.
//
// AIWatch picks the trailing 30 days deliberately: it is the window the Score's other components already
// use, and it is the only way services from DIFFERENT sources can be ranked against each other at all.
// It is a choice from the provider's own data, using the provider's own weights — not a copy of a figure
// whose window the provider never commits to. Nothing is disclosed side-by-side for Atlassian for exactly
// that reason: there is no single provider number to compare against.

/** #1006 — `componentId` accepts a LIST (the service's `statusComponentIds` badge scope): the result is
 *  the WORST-OF across them, matching the badge convention (#379) and the impact calendar. Reading a
 *  single component while the badge spans several is what let LangSmith show a partial outage in its
 *  incident list beside a spotless 100% uptime; the same gap exists on the Atlassian side for every
 *  multi-component service (cursor / copilot / windsurf / bfl / runway). */
export function parseUptimeData(html: string, componentId: string | string[], windowDays = 30, nowMs: number = Date.now()): UptimeDataResult {
  const ids = Array.isArray(componentId) ? componentId : [componentId]
  if (ids.length > 1) {
    const results = ids.map((id) => parseUptimeDataSingle(html, id, windowDays, false, nowMs)).filter((r) => r.uptimePercent != null)
    if (results.length === 0) return { dailyImpact: {}, uptimePercent: null, windowDays: null, uptimeReported: null, uptimeReportedDays: null, todayWeightedOutageSec: null }
    if (results.length < ids.length) {
      // A configured badge component no longer resolves on the page (renamed/rotated id, page
      // restructure). The worst-of then shrinks to the survivors → a too-optimistic uptime with no
      // fetch-failure signal. Warn — same guard incident.io's worst-of already carries (#1006).
      console.warn(
        `[parseUptimeData] ${ids.length - results.length}/${ids.length} configured components absent from ` +
        `the status page (upstream id rotation?) — uptime is a worst-of over the ${results.length} that resolved`,
      )
    }
    const worst = results.reduce((a, b) => (b.uptimePercent! < a.uptimePercent! ? b : a))
    // The impact CALENDAR is the union across the scope (a bad day on ANY badge component is a bad day),
    // while the PERCENT is the worst single component — the same split the badge already makes.
    const dailyImpact: Record<string, DailyImpactLevel> = {}
    const rank = { minor: 0, major: 1, critical: 2 }
    for (const r of results) {
      for (const [day, level] of Object.entries(r.dailyImpact)) {
        const cur = dailyImpact[day]
        if (!cur || rank[level] > rank[cur]) dailyImpact[day] = level
      }
    }
    const reported = results.map((r) => r.uptimeReported).filter((v): v is number => v != null)
    // #1017 — worst-of independently like the dailyImpact union above (NOT tied to `worst`, the
    // 30-day-worst component — the most-affected-TODAY component can differ from it).
    const todaySecs = results.map((r) => r.todayWeightedOutageSec).filter((v): v is number => v != null)
    return {
      dailyImpact,
      uptimePercent: worst.uptimePercent,
      windowDays: worst.windowDays,
      uptimeReported: reported.length > 0 ? Math.min(...reported) : null,
      uptimeReportedDays: worst.uptimeReportedDays,
      todayWeightedOutageSec: todaySecs.length > 0 ? Math.max(...todaySecs) : null,
    }
  }
  // #989 — warnOnMiss only on the genuine single-component path; the multi-id branch above owns its own
  // aggregate "N/M configured components absent" warn, so per-id warns here would double-count it.
  return parseUptimeDataSingle(html, ids[0], windowDays, true, nowMs)
}

function parseUptimeDataSingle(html: string, componentId: string, windowDays = 30, warnOnMiss = false, nowMs: number = Date.now()): UptimeDataResult {
  const result: UptimeDataResult = { dailyImpact: {}, uptimePercent: null, windowDays: null, uptimeReported: null, uptimeReportedDays: null, todayWeightedOutageSec: null }
  // Locate the uptimeData JSON object, then extract it by brace counting (50KB+ object).
  // #868 — Atlassian Statuspage now embeds it as `window.uptimeData = {…}` with a
  // `var uptimeData = window.uptimeData;` ALIAS line. The old `html.indexOf('var uptimeData = ')`
  // matched the alias, so JSON.parse got `window.uptimeData;…` → "Unexpected token 'w'" → uptime null
  // (claude.ai, Cursor, Windsurf, Junie, Voyage AI all dropped from the ranking). Match the assignment
  // whose RHS is the JSON object — `\s*=\s*\{` requires `{` (modulo whitespace) right after `=`, so the
  // alias (RHS `window…`, not `{`) never matches, and legacy `var uptimeData = {…}` still does. The
  // whitespace-tolerant identifier match also survives a minified `window.uptimeData={…}` — hardening
  // against the next embed-shape change, which is exactly the bug class that caused #868.
  const assign = /(?:window\.|var\s+)uptimeData\s*=\s*\{/.exec(html)
  if (!assign) return result
  const jsonStart = assign.index + assign[0].length - 1  // index of the opening `{`
  let depth = 0
  let jsonEnd = -1
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break } }
  }
  if (jsonEnd === -1) return result
  try {
    // Structure: { componentId: { component: {...}, days: [{date, outages: {p, m}}] } }
    const data = JSON.parse(html.substring(jsonStart, jsonEnd)) as Record<string, { days?: UptimeDayEntry[] }>
    const comp = data[componentId]
    if (!comp?.days || !Array.isArray(comp.days)) {
      // #989 — a configured single `statusComponentId` that resolves to nothing (typo, or upstream id
      // rotation) silently yields null uptime → confidence 'low' → the Score is withheld, with no
      // operator signal (the #956/#958 silent-null trap). The multi-id branch already warns on a missed
      // id; mirror it here. Guarded on a non-empty parse so a genuinely empty uptimeData stays quiet.
      if (warnOnMiss && Object.keys(data).length > 0) {
        console.warn(`[parseUptimeData] component id '${componentId}' absent from window.uptimeData (${Object.keys(data).length} components present) — uptime will be null; check statusComponentId for upstream id rotation`)
      }
      return result
    }

    // The impact CALENDAR still spans every published day (it renders 30/90-day history), so it is
    // built from the whole array; only the uptime WINDOW is trimmed.
    const weighted = (day: UptimeDayEntry) => {
      const m = day.outages?.m ?? 0
      const p = day.outages?.p ?? 0
      // Atlassian weights — see ./impact-weights.ts (shared with incident-io.ts)
      return MAJOR_WEIGHT * m + MINOR_WEIGHT * p
    }
    for (const day of comp.days) {
      if (!day.date || !day.outages) continue
      const m = day.outages.m ?? 0
      const p = day.outages.p ?? 0
      if (m > 0 && m > p) result.dailyImpact[day.date] = 'critical'  // major outage dominant → red
      else if (p > 0 || m > 0) result.dailyImpact[day.date] = 'major'  // partial outage dominant → orange
    }

    // Compute uptime%: (1 - weightedOutage / windowSec) × 100
    // Use floor to avoid overstating uptime (e.g. 99.998% should not round to 100%)
    const pctOver = (days: UptimeDayEntry[]) => {
      const valid = days.filter((d) => d.date && d.outages !== undefined)
      if (valid.length === 0) return null
      const sec = valid.reduce((acc, d) => acc + weighted(d), 0)
      return Math.floor((1 - sec / (valid.length * 86400)) * 10000) / 100
    }
    // `days` is chronological (oldest first), so the trailing window is the tail.
    const scored = comp.days.filter((d) => d.date && d.outages !== undefined)
    const trailing = scored.slice(-windowDays)
    result.uptimePercent = pctOver(trailing)
    result.windowDays = trailing.length > 0 ? trailing.length : null
    if (scored.length > trailing.length) {
      result.uptimeReported = pctOver(scored)
      result.uptimeReportedDays = scored.length
    }
    // #1017 — the LAST scored day is USUALLY today's (same "tail = trailing window ending today"
    // assumption `trailing` above relies on for windowDays), but verified rather than assumed: if the
    // provider hasn't published today's bucket yet this cycle, the last entry is yesterday's, and
    // silently mislabeling it as today's would bake a stale figure into the `history:{date}`
    // archive (index.ts `cacheWrite`). `weighted()` is the exact per-day figure already computed for
    // the pct sum, just read off the single most-recent entry instead of summed over the window.
    const latest = scored[scored.length - 1]
    const todayStr = new Date(nowMs).toISOString().split('T')[0]
    if (latest && latest.date === todayStr) result.todayWeightedOutageSec = weighted(latest)
  } catch (err) {
    console.warn('[parseUptimeData] failed to parse uptimeData:', err instanceof Error ? err.message : err)
  }
  return result
}

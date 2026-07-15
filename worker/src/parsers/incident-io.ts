// incident.io Parsers — uptime, component impacts, incident text enrichment

import type { TimelineEntry, Incident, DailyImpactLevel } from '../types'
import { fetchWithTimeout } from '../utils'
import { INCIDENT_IO_STATUS_WEIGHTS } from './impact-weights'
import { weightedDowntimeSeconds, type OutageInterval } from './uptime-interval'

// ── Uptime (#1006) ────────────────────────────────────────────────────────────────────────────────
//
// AIWatch computes uptime ITSELF, from the provider's own published impact records, using the weights
// documented on /methodology — for BOTH parser families. Atlassian already worked this way
// (`parseUptimeData` sums the per-day outage SECONDS the page publishes); incident.io was the anomaly:
// it copied the page's published `component_uptimes[].uptime` aggregate straight into `uptime30d`.
//
// That aggregate is not a 30-day figure, and it is not even the same figure page to page. Measured
// 2026-07-14 against the live pages:
//   · LangSmith publishes 98.48% while its component had ZERO impacts in the last 30 days (its true
//     30-day uptime is 100.00%) — the number tracks a ~90-day window and is driven by MAY outages.
//     AIWatch ranked it `Score 67 / fair` on that basis.
//   · Langfuse: same shape (99.96% published, zero impacts in 30 days).
//   · OpenAI's page publishes 100.00% for components with 3-5 impacts in the last 30 days — no window
//     explains that, so that page evidently excludes degraded/partial states from its uptime entirely.
// So the windows AND the downtime definitions differ per page. The Reliability Ranking was comparing
// numbers that are not comparable.
//
// The fix is to stop reading their aggregate and compute from their RAW records (`component_impacts`:
// start_at / end_at / status), which every incident.io page publishes — including the `chart_only`
// pages (ElevenLabs / Replicate / Stability) that hide the percentage and therefore had NO uptime at
// all under the old path. One window, one formula, every service.

export interface IncidentIoUptime {
  /** Uptime % over the window below, floor-rounded to 2dp (never overstate). */
  pct: number
  /** Days the computation actually covers — `windowDays` unless the component is younger than that.
   *  A status-page migration creates a NEW component, so this drops to a handful of days (#1004/junie):
   *  the figure is then honest for the days it has, and the UI says which. */
  days: number
}

/** Every `component_impacts` entry on the page, parsed once. Returns [] when the page has no impacts
 *  array — which callers MUST treat as "no information", never as "no downtime". */
// Returns [] ONLY when the page carries no `component_impacts` at all (a genuinely clean page). When a
// `component_impacts` marker WAS present but its array could not be parsed, returns null — callers must
// then WITHHOLD uptime (#713), never read the empty list as "no downtime" and fabricate a 100%. The
// `data_available_since` gate is a separate regex, so without this signal a component resolves `since`,
// gets [], and reports a phantom 100% while its real impacts sat behind an unparseable blob.
export function parseIncidentIoImpacts(html: string): IncidentIoImpact[] | null {
  const chunks = html.match(/self\.__next_f\.push\(\[1,([\s\S]*?)\]\)\s*<\/script/g) ?? []
  let sawMarker = false
  let failed = false
  const all: IncidentIoImpact[] = []
  // ACCUMULATE across every qualifying chunk: incident.io can split `component_impacts` across RSC
  // pushes, and reading only the first would silently undercount the tail → inflated uptime. Duplicate
  // impacts across chunks are harmless — the sweep-line accumulator merges identical intervals.
  for (const chunk of chunks) {
    if (!chunk.includes('component_impacts')) continue
    const idx1 = chunk.indexOf('component_impacts')
    const idx2 = chunk.indexOf('component_uptimes')
    if (idx1 === -1 || idx2 === -1 || idx2 <= idx1) continue
    sawMarker = true
    const segment = chunk.substring(idx1, idx2)
    const arrStart = segment.indexOf('[')
    const arrEnd = segment.lastIndexOf(']')
    if (arrStart === -1 || arrEnd === -1) { failed = true; continue }
    const raw = segment.substring(arrStart, arrEnd + 1).replace(/\\"/g, '"').replace(/"\$undefined"/g, 'null')
    try {
      all.push(...(JSON.parse(raw) as IncidentIoImpact[]))
    } catch (err) {
      console.warn('[parseIncidentIoImpacts] parse failed:', err instanceof Error ? err.message : err)
      failed = true
    }
  }
  if (!sawMarker) return [] // no component_impacts on the page at all → genuinely clean
  // A marker was present but a chunk was unreadable → withhold (#713), never fabricate a clean 100%.
  return failed ? null : all
}

export interface IncidentIoImpact {
  component_id?: string
  start_at?: string
  end_at?: string
  status?: string
  status_page_incident_id?: string
}

/** #1006 — the percentage the page ITSELF displays for a component (`component_uptimes[].uptime`).
 *  This is NOT the metric any more — it is not a 30-day figure and its downtime definition differs page
 *  to page, which is the whole bug. It is kept as a DISCLOSURE: #41 deliberately made AIWatch reproduce
 *  the provider's published number, and the detail page still shows it beside our own 30-day measure
 *  rather than dropping it silently. null on a `chart_only` page (`$undefined` — Stability / ElevenLabs
 *  / Replicate publish the impact records but hide the %). */
export function parseIncidentIoReportedUptime(
  html: string,
  componentId: string | string[],
  groupId?: string,
): number | null {
  const ids = Array.isArray(componentId) ? componentId : [componentId]
  const chunks = html.match(/self\.__next_f\.push\(\[1,([\s\S]*?)\]\)\s*<\/script/g) ?? []
  let worst: number | null = null
  for (const chunk of chunks) {
    if (!chunk.includes('component_uptimes')) continue
    const section = chunk.substring(chunk.indexOf('component_uptimes'))
    // A page that groups its components DISPLAYS the group aggregate, not the member's own figure
    // (status.openai.com: "APIs 99.97%" while the API component itself publishes 100.00%). Reading the
    // member would put a number on the page that the provider never shows — the very thing this field
    // exists to avoid. Group entries carry component_id=$undefined + status_page_component_group_id.
    if (groupId) {
      const groupMatch = section.match(new RegExp(
        `\\\\"component_id\\\\":\\\\"\\$undefined\\\\"[\\s\\S]{0,300}?\\\\"status_page_component_group_id\\\\":\\\\"${groupId}\\\\"[\\s\\S]{0,300}?\\\\"uptime\\\\":\\\\"([^\\\\"]*)\\\\"`,
      ))
      if (groupMatch) {
        const pct = parseFloat(groupMatch[1])
        if (!Number.isNaN(pct) && pct >= 0 && pct <= 100) return pct
      }
    }
    for (const id of ids) {
      const match = section.match(new RegExp(`\\\\"component_id\\\\":\\\\"${id}\\\\"[\\s\\S]{0,300}?\\\\"uptime\\\\":\\\\"([^\\\\"]*)\\\\"`))
      if (!match) continue
      const raw = match[1]
      if (raw === '$undefined' || raw === '') continue
      const pct = parseFloat(raw)
      if (Number.isNaN(pct) || pct < 0 || pct > 100) continue
      if (worst === null || pct < worst) worst = pct
    }
  }
  return worst
}

/** How far back a component's own records reach (`component_uptimes[].data_available_since`). incident.io
 *  starts that clock when the COMPONENT is created, so a page migration resets it. Also the only proof
 *  that the page TRACKS this component at all — an id absent here yields null, and the caller must then
 *  withhold uptime rather than read "no impacts" as "no downtime". */
export function parseIncidentIoDataAvailableSince(html: string, componentId: string): string | null {
  const chunks = html.match(/self\.__next_f\.push\(\[1,([\s\S]*?)\]\)\s*<\/script/g) ?? []
  for (const chunk of chunks) {
    if (!chunk.includes('component_uptimes')) continue
    const section = chunk.substring(chunk.indexOf('component_uptimes'))
    // Bounded gap: data_available_since sits a few fields from component_id in the SAME entry. An
    // unbounded `[\s\S]*?` would walk into the next entry when this one omits the field.
    const match = section.match(
      new RegExp(`\\\\"component_id\\\\":\\\\"${componentId}\\\\"[\\s\\S]{0,200}?\\\\"data_available_since\\\\":\\\\"([^\\\\"]*)\\\\"`),
    )
    if (!match) continue
    const raw = match[1]
    if (raw === '$undefined' || raw === '' || Number.isNaN(Date.parse(raw))) return null
    return raw
  }
  return null
}

/** Uptime for ONE component over the trailing window, from its impact records.
 *  null when the page doesn't track the component (no `data_available_since`) — absence of impacts is
 *  NOT evidence of absence of downtime, so we withhold rather than invent a 100%. */
function componentUptime(
  impacts: IncidentIoImpact[],
  componentId: string,
  since: string,
  nowMs: number,
  windowDays: number,
): IncidentIoUptime | null {
  const sinceMs = Date.parse(since)
  if (Number.isNaN(sinceMs)) return null
  const covered = Math.min(windowDays, (nowMs - sinceMs) / 86_400_000)
  if (covered <= 0) return null
  const windowStart = nowMs - covered * 86_400_000
  const windowSec = covered * 86_400

  const intervals: OutageInterval[] = []
  for (const impact of impacts) {
    if (impact.component_id !== componentId) continue
    const weight = impact.status ? INCIDENT_IO_STATUS_WEIGHTS[impact.status] : undefined
    if (weight === undefined) {
      // A status incident.io added since this was written. Warn rather than silently score it as zero
      // downtime — a new "major_outage"-like state would otherwise inflate every affected service.
      console.warn(`[incidentIoUptime] unknown component_impacts status "${impact.status}" — ignored`)
      continue
    }
    if (weight === 0) continue // under_maintenance: announced, not downtime
    // An ongoing impact has end_at null (parseIncidentIoImpacts rewrote "$undefined"→null); the shared
    // accumulator clamps that to now and merges overlaps (worst-weight-wins) so an escalation isn't
    // summed on top of itself.
    intervals.push({ start: Date.parse(impact.start_at ?? ''), end: Date.parse(impact.end_at ?? ''), weight })
  }
  const weightedSec = weightedDowntimeSeconds(intervals, windowStart, nowMs)
  // Floor, like parseUptimeData: never round 99.998% up to a clean 100%.
  const pct = Math.max(0, Math.floor((1 - weightedSec / windowSec) * 10000) / 100)
  return { pct, days: Math.floor(covered) }
}

/** #1006 — the trailing-30-day uptime for a service, computed from the provider's impact records.
 *
 *  A LIST of ids is a WORST-OF (the badge convention for a multi-component service, #379/#857 —
 *  turbopuffer's per-region components have no group aggregate, so the honest headline is the worst
 *  region, not an arbitrary one). The reported `days` is the SHORTEST covered window among the ids that
 *  resolved — the conservative bound.
 *
 *  null when NO configured id is tracked by the page. Warns when only some resolve: an incident.io ULID
 *  rotation silently stops matching on a 200-OK page, and a shrinking worst-of could then report a
 *  healthy 100% while a vanished region is down. */
export function computeIncidentIoUptime(
  html: string,
  componentId: string | string[],
  nowMs: number,
  windowDays = 30,
): IncidentIoUptime | null {
  const ids = Array.isArray(componentId) ? componentId : [componentId]
  const impacts = parseIncidentIoImpacts(html)
  // null = a component_impacts marker was present but unreadable → withhold, never fabricate 100% (#713).
  if (impacts === null) {
    console.warn('[computeIncidentIoUptime] component_impacts present but unparseable — withholding uptime')
    return null
  }
  let worstPct = Infinity
  let shortestDays = Infinity
  let resolved = 0

  for (const id of ids) {
    const since = parseIncidentIoDataAvailableSince(html, id)
    if (!since) continue // the page doesn't track this component — withhold, don't assume 100%
    const result = componentUptime(impacts, id, since, nowMs, windowDays)
    if (!result) continue
    resolved++
    worstPct = Math.min(worstPct, result.pct)
    shortestDays = Math.min(shortestDays, result.days)
  }

  if (resolved === 0) return null
  if (ids.length > 1 && resolved < ids.length) {
    console.warn(
      `[computeIncidentIoUptime] ${ids.length - resolved}/${ids.length} configured components absent from ` +
      `component_uptimes (upstream id rotation?) — uptime is a worst-of over the ${resolved} that resolved`,
    )
  }
  return { pct: worstPct, days: shortestDays }
}


// componentId accepts a single id OR a list (the service's statusComponentIds group): the per-day
// result is the WORST impact across all matched components — so a service whose badge spans several
// components (e.g. the OpenAI "APIs" group) gets a calendar reflecting the whole group, not just the
// primary component, matching the official group calendar (#693 follow-up).
export function parseIncidentIoComponentImpacts(html: string, componentId: string | string[]): Record<string, DailyImpactLevel> {
  const idSet = new Set(Array.isArray(componentId) ? componentId : [componentId])
  const result: Record<string, DailyImpactLevel> = {}
  const chunks = html.match(/self\.__next_f\.push\(\[1,([\s\S]*?)\]\)\s*<\/script/g) ?? []
  for (const chunk of chunks) {
    if (!chunk.includes('component_impacts')) continue
    // Extract array between component_impacts and component_uptimes
    const idx1 = chunk.indexOf('component_impacts')
    const idx2 = chunk.indexOf('component_uptimes')
    if (idx1 === -1 || idx2 === -1 || idx2 <= idx1) continue
    const segment = chunk.substring(idx1, idx2)
    const arrStart = segment.indexOf('[')
    const arrEnd = segment.lastIndexOf(']')
    if (arrStart === -1 || arrEnd === -1) continue
    let raw = segment.substring(arrStart, arrEnd + 1)
    // Unescape: \\" → "
    raw = raw.replace(/\\"/g, '"')
    raw = raw.replace(/"\$undefined"/g, 'null')

    try {
      const impacts = JSON.parse(raw) as Array<{
        component_id: string; start_at: string; end_at: string; status: string
      }>
      // Filter to the target component(s); worst-of per day across them (loop below escalates).
      const mine = impacts.filter((i) => idSet.has(i.component_id))
      for (const impact of mine) {
        const start = new Date(impact.start_at)
        const end = new Date(impact.end_at)
        if (isNaN(start.getTime()) || isNaN(end.getTime())) continue
        // Skip impacts shorter than 10 minutes (matches official calendar threshold)
        if (end.getTime() - start.getTime() < 600_000) continue

        // Map status to DailyImpactLevel
        const level: DailyImpactLevel =
          impact.status === 'full_outage' ? 'critical'
          : impact.status === 'partial_outage' ? 'major'
          : 'minor' // degraded_performance

        // Emit one entry per UTC day the impact spans, keyed by an ISO TIMESTAMP within the impact's
        // coverage (NOT a bare UTC date) so the client buckets each to the correct LOCAL day — fixing
        // the UTC-vs-local off-by-one for impacts in the UTC evening, which fall on the next local day
        // for east-of-UTC viewers (#693 follow-up). Start day → real start; end day → real end; full
        // middle days → noon. The client merges worst-of per local day, so no pre-merge needed here;
        // escalate only guards the rare exact-key collision.
        const dayMs = 86_400_000
        const startDayMs = Date.parse(start.toISOString().slice(0, 10) + 'T00:00:00.000Z')
        const endDayMs = Date.parse(end.toISOString().slice(0, 10) + 'T00:00:00.000Z')
        const escalate = (key: string) => {
          const existing = result[key]
          if (!existing || level === 'critical' || (level === 'major' && existing === 'minor')) result[key] = level
        }
        for (let d = startDayMs; d <= endDayMs; d += dayMs) {
          // Single-day impact (startDayMs === endDayMs) → start key only; its end is the same local
          // day, so no separate end key is needed. Multi-day → start ISO + noon(middle) + end ISO.
          const key = d === startDayMs ? start.toISOString()
            : d === endDayMs ? end.toISOString()
            : new Date(d + dayMs / 2).toISOString() // noon of a fully-covered middle day
          escalate(key)
        }
      }
    } catch (err) {
      console.warn('[parseIncidentIoComponentImpacts] parse failed:', err instanceof Error ? err.message : err)
    }
    break
  }
  return result
}

// #1004 — incident.io's Statuspage-compatible API returns `components: []` on EVERY incident. Verified
// across every incident.io page we monitor: status.jetbrains.cloud 0/14, status.smith.langchain.com
// 0/25, status.langfuse.com 0/25, status.openai.com 0/25. So `parseIncidents` yields no
// `componentNames`, and a service scoped by `incidentComponents` (an exact component-NAME allowlist,
// #683) drops EVERY incident — permanently and silently, since the `includeUntaggedIncidents` valve is
// gated on `incidentKeywords`, which such a service does not set. Junie hit exactly this when JetBrains
// moved to incident.io: it would have traded a false `degraded` for a service that could never report
// an incident again (no dashboard list, no Discord alert, no RSS, and a spotless Score).
//
// The mapping is not lost, just not in the JSON: the page HTML's `component_impacts` carries
// `status_page_incident_id` → `component_id`, and that incident id is the SAME id the v2 API returns
// (verified: 13/14 of the JetBrains incidents join). So rebuild the tags from the HTML.
//
// Returns incidentId → component ids (deduped). Empty when the page has no impacts array — callers
// must treat that as "no information", never as "no components".
export function parseIncidentIoIncidentComponentIds(html: string): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  const chunks = html.match(/self\.__next_f\.push\(\[1,([\s\S]*?)\]\)\s*<\/script/g) ?? []
  for (const chunk of chunks) {
    if (!chunk.includes('component_impacts')) continue
    const idx1 = chunk.indexOf('component_impacts')
    const idx2 = chunk.indexOf('component_uptimes')
    if (idx1 === -1 || idx2 === -1 || idx2 <= idx1) continue
    const segment = chunk.substring(idx1, idx2)
    const arrStart = segment.indexOf('[')
    const arrEnd = segment.lastIndexOf(']')
    if (arrStart === -1 || arrEnd === -1) continue
    const raw = segment.substring(arrStart, arrEnd + 1).replace(/\\"/g, '"').replace(/"\$undefined"/g, 'null')
    try {
      const impacts = JSON.parse(raw) as Array<{ component_id?: string; status_page_incident_id?: string }>
      for (const impact of impacts) {
        const incId = impact.status_page_incident_id
        const compId = impact.component_id
        if (!incId || !compId) continue
        const ids = (result[incId] ??= [])
        if (!ids.includes(compId)) ids.push(compId)
      }
    } catch (err) {
      // `continue`, not `break`: a malformed first chunk must not hide a well-formed later one. (The
      // sibling parsers break here; this one carries incident SCOPING, where a silent empty result
      // drops every incident — so it keeps scanning.)
      console.warn('[parseIncidentIoIncidentComponentIds] parse failed:', err instanceof Error ? err.message : err)
      continue
    }
    break
  }
  return result
}

/** #1004 — restore the `componentNames` that incident.io's JSON API drops, from the page HTML (see
 *  `parseIncidentIoIncidentComponentIds`). Only fills incidents that have NO names — an API that starts
 *  populating them again wins. Unknown component ids are skipped rather than emitted raw, so a name
 *  allowlist can never match a ULID. Pure; must run BEFORE `filterIncidents` (#940 — a transform after
 *  the filter is a no-op on already-dropped incidents). */
export function attachIncidentIoComponentNames(
  incidents: Incident[],
  html: string,
  components: ReadonlyArray<{ id: string; name: string }>,
): Incident[] {
  const idsByIncident = parseIncidentIoIncidentComponentIds(html)
  if (Object.keys(idsByIncident).length === 0) return incidents
  const nameById = new Map(components.map((c) => [c.id, c.name]))
  return incidents.map((inc) => {
    if ((inc.componentNames ?? []).length > 0) return inc
    const names = (idsByIncident[inc.id] ?? []).map((id) => nameById.get(id)).filter((n): n is string => !!n)
    return names.length > 0 ? { ...inc, componentNames: names } : inc
  })
}

interface IncidentIoUpdate {
  stage: TimelineEntry['stage']
  text: string
  at: string
}

export function parseIncidentIoUpdates(html: string): IncidentIoUpdate[] {
  const results: IncidentIoUpdate[] = []
  const chunks = html.match(/self\.__next_f\.push\(\[1,([\s\S]*?)\]\)\s*<\/script/g) ?? []
  for (const chunk of chunks) {
    // Quotes inside __next_f JS strings are escaped as \" so match \\"...\\"
    const re = /\\"message_string\\":\\"((?:[^\\"\\\\]|\\\\.)*)\\",\\"published_at\\":\\"([^\\"]+)\\",\\"to_status\\":\\"([^\\"]+)\\"/g
    let m
    while ((m = re.exec(chunk)) !== null) {
      const [, rawText, at, toStatus] = m
      if (!rawText) continue
      // Unescape JS-string double-encoding (\\n → \n, \\\\ → \\, etc.)
      let text: string
      try { text = JSON.parse(`"${rawText}"`) } catch { text = rawText }
      const stage: TimelineEntry['stage'] =
        toStatus === 'resolved' ? 'resolved'
        : toStatus === 'monitoring' ? 'monitoring'
        : toStatus === 'identified' ? 'identified'
        : 'investigating'
      results.push({ stage, text, at })
    }
  }
  return results
}

export interface IncidentTextCache {
  textByKey: Record<string, string | null>  // key = "stage:at" (matches parseIncidents dedup key)
  cachedAt: string
}

async function readIncidentTextCache(kv: KVNamespace, incidentIds: string[]): Promise<Map<string, IncidentTextCache>> {
  const results = await Promise.all(
    incidentIds.map((id) =>
      kv.get(`inctext:${id}`).catch((err) => {
        console.error(`[inctext cache] KV read failed for ${id}:`, err instanceof Error ? err.message : err)
        return null
      })
    )
  )
  const map = new Map<string, IncidentTextCache>()
  results.forEach((raw, i) => {
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      // Runtime shape check — guards against schema changes or corrupt entries causing applyTextCache to throw
      if (parsed && typeof parsed === 'object' && typeof parsed.textByKey === 'object' && parsed.textByKey !== null) {
        map.set(incidentIds[i], parsed as IncidentTextCache)
      } else {
        console.warn(`[inctext cache] unexpected shape for incident ${incidentIds[i]} — discarding`)
      }
    } catch {
      console.warn(`[inctext cache] corrupt KV entry for incident ${incidentIds[i]} — discarding`)
    }
  })
  return map
}

export function applyTextCache(inc: Incident, cache: IncidentTextCache): Incident {
  return {
    ...inc,
    timeline: inc.timeline.map((entry) => {
      if (entry.text !== null) return entry
      const cached = cache.textByKey[`${entry.stage}:${entry.at}`]
      // cached===undefined means key absent (not yet scraped); null means scraped but no text found
      return cached !== undefined ? { ...entry, text: cached } : entry
    }),
  }
}

export function buildTextCache(inc: Incident): IncidentTextCache {
  const textByKey: Record<string, string | null> = {}
  for (const entry of inc.timeline) textByKey[`${entry.stage}:${entry.at}`] = entry.text
  return { textByKey, cachedAt: new Date().toISOString() }
}

// pageUrls: incidentId → direct detail page URL (from Atlassian API shortlink).
// Constructing URLs from inc.id is unreliable because incident.io Atlassian-compat IDs
// may differ from the native ULID used in detail page URLs.
export async function enrichIncidentIoText(incidents: Incident[], baseUrl: string, pageUrls: Map<string, string>, kv?: KVNamespace): Promise<Incident[]> {
  // Phase 1: Apply cached text from KV for all incidents that have null-text entries.
  // KV reads do not count against the per-invocation subrequest cap, so we read for all candidates freely.
  let workingIncidents = incidents
  const needsText = incidents.filter((inc) => inc.timeline.some((t) => !t.text))
  if (kv && needsText.length > 0) {
    const cacheMap = await readIncidentTextCache(kv, needsText.map((i) => i.id))
    if (cacheMap.size > 0) {
      workingIncidents = incidents.map((inc) => {
        const cached = cacheMap.get(inc.id)
        return cached ? applyTextCache(inc, cached) : inc
      })
    }
  }

  // Phase 2: Scrape incidents still missing text after cache application (up to budget=1).
  // Budget = 1 per service: 44 base requests + 6 services × 1 = 50 (kept as a self-imposed cap
  // for CPU-time hygiene — well under the 1,000 subrequest cap on Workers Paid / Standard).
  // Prioritise: non-resolved first (may get new updates), then most recently started.
  const toEnrich = workingIncidents
    .filter((inc) => inc.timeline.some((t) => !t.text))
    .sort((a, b) => {
      const resolvedDiff = (a.status === 'resolved' ? 1 : 0) - (b.status === 'resolved' ? 1 : 0)
      if (resolvedDiff !== 0) return resolvedDiff
      return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    })
    .slice(0, 1)

  if (toEnrich.length === 0) return workingIncidents

  const enriched = new Map<string, Incident>()
  await Promise.all(toEnrich.map(async (inc) => {
    try {
      const url = pageUrls.get(inc.id) ?? `${baseUrl}/${inc.id}`
      const res = await fetchWithTimeout(url, 5000)
      if (!res.ok) {
        console.warn(`[enrichIncidentIoText] ${inc.id} returned HTTP ${res.status}`)
        res.body?.cancel()
        return
      }
      const html = await res.text()
      const allUpdates = parseIncidentIoUpdates(html)
      if (allUpdates.length === 0) {
        console.warn(`[enrichIncidentIoText] ${inc.id} — page fetched OK but no updates parsed (HTML structure may have changed)`)
        return
      }

      // The incident.io SSR payload may include updates from multiple incidents.
      // Scope to updates within the target incident's time window (±1h) to avoid
      // cross-incident pollution (e.g., Pinned chats entries appearing in SSO incident).
      const entryTimes = inc.timeline.map((t) => new Date(t.at).getTime())
      const windowStart = Math.min(...entryTimes) - 3_600_000
      const windowEnd   = Math.max(...entryTimes) + 3_600_000
      const updates = allUpdates.filter((u) => {
        const t = new Date(u.at).getTime()
        return t >= windowStart && t <= windowEnd
      })
      if (updates.length === 0) {
        console.warn(`[enrichIncidentIoText] ${inc.id} — ${allUpdates.length} updates found but all filtered by time window`)
        return
      }

      const STAGE_ORDER: Record<string, number> = { investigating: 0, identified: 1, monitoring: 2, resolved: 3 }
      const usedUpdateIndices = new Set<number>()

      const enrichedIncident: Incident = {
        ...inc,
        timeline: inc.timeline.map((entry) => {
          if (entry.text) return entry
          const entryMs = new Date(entry.at).getTime()
          // 1st: exact match — same stage + within 10 min (handles most cases)
          const exactIdx = updates.findIndex((u, i) =>
            !usedUpdateIndices.has(i) &&
            u.stage === entry.stage &&
            Math.abs(new Date(u.at).getTime() - entryMs) < 600_000
          )
          if (exactIdx !== -1) {
            usedUpdateIndices.add(exactIdx)
            return { ...entry, text: updates[exactIdx].text }
          }
          // 2nd: timestamp-only match within 10 min — handles stage label mismatch between
          // incident.io HTML and Atlassian-compat API (they use different status vocabularies).
          // Only allow adjacent stages (investigating↔identified, identified↔monitoring,
          // monitoring↔resolved) to avoid assigning clearly wrong text across distant stages.
          const candidates = updates
            .map((u, i) => ({ u, i }))
            .filter(({ u, i }) => {
              if (usedUpdateIndices.has(i)) return false
              const dist = Math.abs((STAGE_ORDER[entry.stage] ?? 0) - (STAGE_ORDER[u.stage] ?? 0))
              return dist <= 1 && Math.abs(new Date(u.at).getTime() - entryMs) < 600_000
            })
            .sort((a, b) => Math.abs(new Date(a.u.at).getTime() - entryMs) - Math.abs(new Date(b.u.at).getTime() - entryMs))
          if (candidates.length > 0) {
            usedUpdateIndices.add(candidates[0].i)
            return { ...entry, text: candidates[0].u.text }
          }
          return entry
        }),
      }
      enriched.set(inc.id, enrichedIncident)

      // Phase 3: Persist scraped text to KV. Must be awaited — unawaited KV writes are cancelled
      // when the Worker terminates after the response. Latency is negligible (~10-50ms) since
      // we already spent up to 5s on HTTP scraping. A single write failure is non-critical
      // (next invocation re-scrapes), but persistent failures exhaust the enrichment budget.
      // Resolved: 90-day TTL (rarely changes). Active: 30-min TTL (may receive new updates).
      if (kv) {
        const ttl = enrichedIncident.status === 'resolved' ? 90 * 86_400 : 30 * 60
        try {
          const payload = JSON.stringify(buildTextCache(enrichedIncident))
          await kv.put(`inctext:${inc.id}`, payload, { expirationTtl: ttl })
            .catch((err) => console.error(`[inctext cache] write failed for ${inc.id}:`, err))
        } catch (buildErr) {
          console.error(`[inctext cache] failed to serialize cache for ${inc.id}:`, buildErr instanceof Error ? buildErr.message : buildErr)
        }
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError'
      if (isTimeout) {
        console.error(`[enrichIncidentIoText] timeout enriching ${inc.id}`)
      } else {
        console.warn(`[enrichIncidentIoText] failed to enrich ${inc.id}:`, err instanceof Error ? err.message : err)
      }
    }
  }))

  return workingIncidents.map((inc) => enriched.get(inc.id) ?? inc)
}

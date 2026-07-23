// OnlineOrNot (React Router SSR) Parser — for status pages like OpenRouter

import type { Incident, TimelineEntry } from '../types'
import { formatDuration } from '../utils'
import { MAINTENANCE_TITLE } from './betterstack'
import { weightedDowntimeSeconds, type OutageInterval } from './uptime-interval'

/**
 * Structural exits — we could not see this page's incident list AT ALL. Distinct from "this page
 * genuinely has no incidents", which is `ok: true` with an empty array (#1123 — conflating the two
 * is what published a green badge off a dead read; same class as {@link InstatusParseFailure}, #1089).
 *
 * Values are PERSISTED: `recordParseFailure` books them as KV counter buckets, so they are a
 * vocabulary, not free text — see `docs/reference/kv-schema.md`. `onot-` prefixes the one name that
 * would otherwise collide with an Instatus reason, so an operator aggregating a reason across
 * services never silently sums two different parsers' failures (they need different fixes).
 */
export type OnlineOrNotParseFailure =
  | 'no-payload'            // the streamController.enqueue envelope is absent
  | 'payload-truncated'     // the envelope is there but has no closing bracket
  | 'onot-bad-json'         // the envelope's contents are not valid JSON
  | 'not-status-page'       // valid payload, but the status-page marker is missing
  | 'no-incident-container' // a status page whose incident containers we could not locate
  | 'incidents-unreadable'  // the containers name incidents we failed to turn into records
  | 'fetch-unreadable'      // set by the CALLER: the page fetch returned a transient non-OK

export type OnlineOrNotPageResult =
  | { ok: true; incidents: Incident[]; uptime30d: number }
  | { ok: false; reason: OnlineOrNotParseFailure }

/** `extractData` can only fail on the envelope, never on the three content reasons. */
type ExtractFailure = Extract<OnlineOrNotParseFailure, 'no-payload' | 'payload-truncated' | 'onot-bad-json'>
type ExtractResult = { ok: true; data: unknown[] } | { ok: false; reason: ExtractFailure }

/**
 * Extract the flat data array from OnlineOrNot's React Router SSR HTML.
 * Data is embedded via streamController.enqueue() as an escaped JSON array.
 */
function extractData(html: string): ExtractResult {
  const match = html.match(/streamController\.enqueue\("(\[.*?)"\)/)
  if (!match) {
    console.warn('[onlineornot] no streamController data found — format may have changed')
    return { ok: false, reason: 'no-payload' }
  }

  const raw = match[1]
    .replace(/\\\\\\\\/g, '\\')
    .replace(/\\\\"/g, '"')
    .replace(/\\"/g, '"')

  const endIdx = raw.lastIndexOf(']')
  if (endIdx < 0) {
    console.warn('[onlineornot] streamController data found but no closing bracket — payload truncated?')
    return { ok: false, reason: 'payload-truncated' }
  }

  try {
    return { ok: true, data: JSON.parse(raw.slice(0, endIdx + 1)) }
  } catch (err) {
    console.error('[onlineornot] JSON.parse failed — SSR format may have changed:', err instanceof Error ? err.message : err)
    return { ok: false, reason: 'onot-bad-json' }
  }
}

/**
 * #1123 — the "is this really an OnlineOrNot status page?" test.
 *
 * It MUST key off structure that exists whether or not the page currently has incidents. The
 * original guard asked for the incident-shaped key names (`title` + `started`), which are interned
 * into the flat array only when at least one incident object exists — so a page whose whole
 * published window is incident-free failed the test and reported NO uptime at all. That is the
 * production symptom this issue was filed for: OpenRouter's entire 91-day window was clean, its
 * uptime read `null` instead of 100, and the Score silently dropped its 40-point Uptime component.
 *
 * `statusPage` is the loader field the page's own data hangs off, at index 9 in all three captured
 * payloads (2025-12, 2026-03, 2026-07 — the last incident-free). It is deliberately the ONLY marker:
 * an earlier cut also required `components`, but that string is a `statusPage` field in the 2026-07
 * capture and merely a component-GROUP key (index 2201 / 2218) in the two archived ones, so the
 * conjunction rested on a structure the payload does not guarantee. Since openrouter is the only
 * `onlineOrNotUrl` service, a false negative here routes the whole service to `sourceUnknown`.
 */
function isStatusPagePayload(data: unknown[]): boolean {
  return data.includes('statusPage')
}

/**
 * What the payload SAYS it contains, read independently of the incident-object key names.
 *
 * #1123 review — the marker check proves "this is an OnlineOrNot page"; it proves nothing about
 * "we located this page's incidents". Those are independent structures, so a key rename
 * (`started` → `startedAt`), a type change (an epoch number), or a date-format change would leave
 * {@link collectIncidents} returning `[]` on a page full of outages — and the caller would publish a
 * confident 100% "official" uptime. That is strictly worse than the withheld-data bug being fixed
 * here, so the ids the page NAMES are cross-checked against the ids we actually turned into records.
 *
 * Two id sources, both surviving a change to the incident OBJECT's shape:
 *   - `expectedIds`: every id named by a per-component daily bucket's `incidentIds` string array;
 *   - `activeIds`: the ids of the currently-open incidents (`activeIncidents`), which have no bucket
 *     yet. `activeUnreadable` counts active entries whose id we could not read at all — a page that
 *     claims an open incident we cannot even identify is a shape change, not a clean page.
 *
 * Returns null when the structural containers are absent — `incidents`, `activeIncidents` AND
 * `incidentIds` are all present in every captured payload including the incident-free one, so
 * requiring all three cannot false-negative a healthy page (#1123 round-2 review — an earlier cut
 * failed OPEN on a missing `incidentIds`, which let a coordinated key rename read as a clean 100%).
 *
 * NB: the payload also carries a `noIncidents` boolean, which looks like a tempting positive "this
 * page is clean" signal — but it is NOT one. It tracks only the recent (root-map) window: the
 * 2026-03-08 capture has `noIncidents: true` while its buckets name 24 incidents. Trusting it would
 * reintroduce exactly this bug (a page full of outages read as clean), so we cross-check ids instead.
 */
type IncidentContainers = { expectedIds: Set<string>; activeIds: Set<string>; activeUnreadable: number }

function readIncidentContainers(data: unknown[], readId: (o: Record<string, number>) => string | null): IncidentContainers | null {
  const idsIdx = data.indexOf('incidentIds')
  if (data.indexOf('incidents') < 0 || data.indexOf('activeIncidents') < 0 || idsIdx < 0) return null

  // Ids named by the daily buckets.
  const expectedIds = new Set<string>()
  const idsKey = `_${idsIdx}`
  for (const item of data) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const ref = (item as Record<string, unknown>)[idsKey]
    if (typeof ref !== 'number') continue
    const arr = data[ref]
    if (!Array.isArray(arr)) continue
    for (const el of arr) {
      const v = typeof el === 'number' ? data[el] : el
      if (typeof v === 'string') expectedIds.add(v)
    }
  }

  // Ids of the currently-open incidents. An `activeIncidents` entry is a ref to an incident object
  // that reuses the same id key names, so `readId` resolves it — the SAME reader `collectIncidents`
  // uses, so "the page says this id is active" and "we parsed this id" are compared like-for-like,
  // never by resolution state (which the two container copies legitimately disagree on).
  const activeIds = new Set<string>()
  let activeUnreadable = 0
  const activeKey = `_${data.indexOf('activeIncidents')}`
  for (const item of data) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const ref = (item as Record<string, unknown>)[activeKey]
    if (typeof ref !== 'number') continue
    const arr = data[ref]
    if (!Array.isArray(arr)) continue
    for (const el of arr) {
      const obj = typeof el === 'number' ? data[el] : el
      const id = obj && typeof obj === 'object' && !Array.isArray(obj) ? readId(obj as Record<string, number>) : null
      if (id) activeIds.add(id); else activeUnreadable++
    }
  }

  return { expectedIds, activeIds, activeUnreadable }
}

/** Read an incident id from an object, trying both container spellings (`incidentId` / `id`). */
function makeIdReader(data: unknown[]): (obj: Record<string, number>) => string | null {
  const idKeys = [data.indexOf('incidentId'), data.indexOf('id')]
    .filter((i) => i >= 0)
    .map((i) => `_${i}`)
  return (obj) => {
    for (const idKey of idKeys) {
      const idRaw = obj[idKey] != null ? data[obj[idKey]] : null
      if (typeof idRaw === 'string') return idRaw
    }
    return null
  }
}

/**
 * Collect the object references that belong to the `scheduledMaintenance` collection.
 *
 * OnlineOrNot's SSR loader data separates real incidents (`incidents`/`activeIncidents`)
 * from planned maintenance (`scheduledMaintenance`), but a maintenance entry reuses the
 * SAME `title`/`started` key-name indices as an incident (and carries no `impact`), so the
 * flat-scan in {@link collectIncidents} would otherwise sweep it in as an active
 * `investigating` incident (#894 — OpenRouter "Scheduled Database Maintenance" showed as an
 * incident while `activeIncidents` was empty). We trust the source's own grouping — the
 * authoritative signal — rather than a title regex, so custom-titled maintenance is caught
 * and real incidents are never dropped.
 */
function collectMaintenanceRefs(data: unknown[]): Set<unknown> {
  const excluded = new Set<unknown>()
  const smIdx = data.indexOf('scheduledMaintenance')
  if (smIdx < 0) return excluded
  const smKey = `_${smIdx}`

  for (const item of data) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const ref = (item as Record<string, unknown>)[smKey]
    if (typeof ref !== 'number') continue
    const arr = data[ref]
    if (!Array.isArray(arr)) continue
    for (const mIdx of arr) {
      if (typeof mIdx !== 'number' || mIdx < 0 || mIdx >= data.length) continue
      const mObj = data[mIdx]
      if (typeof mObj === 'object' && mObj !== null && !Array.isArray(mObj)) {
        excluded.add(mObj)
      }
    }
  }
  return excluded
}

/** What a scan of the payload produced, including what it could NOT turn into a record. */
type CollectResult = {
  incidents: Incident[]
  /** ids of rows we turned into an actual Incident record (real ids only). */
  parsedIds: Set<string>
  /** ids of rows we deliberately dropped as planned maintenance (#894/#896) — a non-failing outcome. */
  maintenanceIds: Set<string>
  /** rows that looked like incidents but whose fields we could not read. */
  unreadableRows: number
  /** count of rows dropped as maintenance, for the active-incident excuse. */
  maintenanceRows: number
}

/**
 * Parse the incident objects out of an OnlineOrNot loader payload.
 * Object keys use _N refs where N = index of the key name string in the array.
 *
 * The payload carries the SAME incident twice, in two containers with different key names and
 * different retention (#1123):
 *   - the root `incidents` map — 15 date-keyed entries (today plus the 14 prior days, the window the
 *     page itself labels "the last 14 days"), keyed `id`, carrying `updates` but **no `impact`**;
 *   - the per-component daily buckets `uptime[].data.incidents[].incidentData` — 91 days, keyed
 *     `incidentId`, carrying `impact`.
 * So the id is read from EITHER key name, and the two copies are merged field-wise. Reading only
 * `incidentId` gave the two copies different dedup keys (the `id` copy fell back to `title|started`),
 * which published one incident as two: a doubled incident count into the Score's Incidents component,
 * and two Discord alerts for one outage.
 */
function collectIncidents(data: unknown[]): CollectResult {
  // #894 — exclude planned-maintenance entries (they reuse incident key indices).
  const maintenanceRefs = collectMaintenanceRefs(data)

  // Build key index map: find indices of known key name strings
  const keyMap: Record<string, number> = {}
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 'incidentId') keyMap.incidentId = i
    if (data[i] === 'id') keyMap.id = i
    if (data[i] === 'title') keyMap.title = i
    if (data[i] === 'started') keyMap.started = i
    if (data[i] === 'ended') keyMap.ended = i
    if (data[i] === 'impact') keyMap.impact = i
  }

  const empty: CollectResult = { incidents: [], parsedIds: new Set(), maintenanceIds: new Set(), unreadableRows: 0, maintenanceRows: 0 }
  // No incident-shaped key names at all. On a payload that already passed `isStatusPagePayload` this
  // is usually a real, empty answer — but it is ALSO what a key rename looks like, which is why
  // `parseOnlineOrNotPage` cross-checks the containers rather than trusting this on its own.
  if (keyMap.title == null || keyMap.started == null) return empty

  // Find incident objects: objects with _N keys matching our key indices
  const titleKey = `_${keyMap.title}`
  const startedKey = `_${keyMap.started}`
  const endedKey = keyMap.ended != null ? `_${keyMap.ended}` : null
  const impactKey = keyMap.impact != null ? `_${keyMap.impact}` : null
  // Both container spellings. `id` is a generic key name (the status page and every component carry
  // one), but it is only read off an object that already matched title + started AND survived the
  // #894/#896 maintenance filters — and maintenance entries are the only other rows on this page
  // that carry title + started.
  const readId = makeIdReader(data)

  const byKey = new Map<string, Incident>()
  const parsedIds = new Set<string>()
  const maintenanceIds = new Set<string>()
  let unreadableRows = 0
  let unreadableSample = ''
  let maintenanceRows = 0

  for (const item of data) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const obj = item as Record<string, number>
    if (!(titleKey in obj) || !(startedKey in obj)) continue

    const incId = readId(obj)

    // #894 — skip scheduled-maintenance entries. Recorded as maintenance (NOT parsed), so the
    // container cross-check counts a deliberately-filtered row as accounted, not as one we failed to
    // read — but only for the id it actually names, never blanket-excusing the whole payload.
    if (maintenanceRefs.has(item)) { maintenanceRows++; if (incId) maintenanceIds.add(incId); continue }

    const title = data[obj[titleKey]]
    const started = data[obj[startedKey]]
    if (typeof title !== 'string' || typeof started !== 'string' || !started.includes('T')) {
      // The row IS incident-shaped but its fields are not what we expect — a provider-side type or
      // date-format change. Counted (NOT added to parsedIds), never silent: the container cross-check
      // in `parseOnlineOrNotPage` catches it because the id it names stays unaccounted.
      unreadableRows++
      unreadableSample ||= `title/started types ${typeof title}/${typeof started}`
      continue
    }

    // #896 — title backstop: a COMPLETED maintenance is relocated out of the `scheduledMaintenance`
    // group (so the #894 structural filter misses it) but still carries a maintenance-shaped title.
    if (MAINTENANCE_TITLE.test(title)) {
      maintenanceRows++
      if (incId) maintenanceIds.add(incId)
      continue
    }

    const endedRaw = endedKey && obj[endedKey] != null ? data[obj[endedKey]] : null
    const ended = typeof endedRaw === 'string' ? endedRaw : null
    const impactRaw = impactKey && obj[impactKey] != null ? data[obj[impactKey]] : null
    const impact = typeof impactRaw === 'string' ? impactRaw : null

    const startDate = new Date(started)
    if (isNaN(startDate.getTime())) {
      unreadableRows++
      unreadableSample ||= `unparseable started ${started}`
      continue
    }
    const endDate = ended ? new Date(ended) : null
    const isResolved = endDate != null && !isNaN(endDate.getTime())

    const timeline: TimelineEntry[] = [
      { stage: 'investigating', text: title, at: startDate.toISOString() },
    ]
    if (isResolved) {
      timeline.push({ stage: 'resolved', text: '', at: endDate!.toISOString() })
    }

    const incident: Incident = {
      id: incId || `onot-${started.slice(0, 10)}-${title.slice(0, 20).replace(/\s/g, '-')}`,
      title,
      status: isResolved ? 'resolved' : 'investigating',
      impact: impact === 'MAJOR_OUTAGE' ? 'major'
        : impact === 'PARTIAL_OUTAGE' || impact === 'DEGRADED_PERFORMANCE' ? 'minor'
        : null,
      startedAt: startDate.toISOString(),
      resolvedAt: isResolved && endDate ? endDate.toISOString() : null,
      duration: isResolved ? formatDuration(startDate, endDate!) : null,
      timeline,
    }

    if (incId) parsedIds.add(incId)
    // Deduplicate by id or title+started
    const dedupKey = incId || `${title}|${started}`
    const prev = byKey.get(dedupKey)
    byKey.set(dedupKey, prev ? mergeCopies(prev, incident) : incident)
  }

  // One summary line per parse, not one per row — this runs on every /api/status request, and a
  // completed maintenance sits in the payload ~91 days (#1123 round-2 review).
  if (unreadableRows > 0) console.warn(`[onlineornot] ${unreadableRows} incident row(s) unreadable (e.g. ${unreadableSample}) — shape change?`)
  if (maintenanceRows > 0) console.debug(`[onlineornot] filtered ${maintenanceRows} maintenance row(s)`)

  const incidents = [...byKey.values()]
  incidents.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return { incidents, parsedIds, maintenanceIds, unreadableRows, maintenanceRows }
}

const SEVERITY = { major: 2, critical: 2, minor: 1 } as const
const rank = (i: Incident['impact']) => (i && i in SEVERITY ? SEVERITY[i as keyof typeof SEVERITY] : 0)

/**
 * Merge the two container copies of one incident, FIELD-WISE (#1123 review).
 *
 * The copies are not interchangeable: the root-`incidents` one carries no `impact`, the daily-bucket
 * one is a denormalized snapshot. Neither first-wins nor last-wins is safe — emission order is the
 * payload's, not ours — so each field is taken from the copy that actually knows it:
 *   - `impact`: the worse severity wins (an impact-less copy must never erase a MAJOR_OUTAGE, which
 *     would drop that outage to weight 0 in the uptime computation while still listing it);
 *   - resolution (`status`/`resolvedAt`/`duration`/`timeline`): the RESOLVED copy wins, because a
 *     stale bucket snapshot claiming an incident is still open is what produces a missed recovery.
 */
function mergeCopies(a: Incident, b: Incident): Incident {
  const severe = rank(b.impact) > rank(a.impact) ? b : a
  // The resolved copy wins; if BOTH resolved, the earlier `resolvedAt` — recovery happens once, and
  // the earliest stamp is the true recovery time (emission order is the payload's, not ours).
  const resolved = a.resolvedAt && b.resolvedAt ? (a.resolvedAt <= b.resolvedAt ? a : b)
    : a.resolvedAt ? a : b.resolvedAt ? b : a
  return {
    ...a,
    impact: severe.impact,
    status: resolved.status,
    resolvedAt: resolved.resolvedAt,
    duration: resolved.duration,
    timeline: resolved.timeline,
  }
}

/**
 * #1006 — OnlineOrNot uptime, COMPUTED over the trailing 30 days from the page's own incident records.
 *
 * The page publishes an aggregate % (e.g. "100% uptime"), but its own SSR payload also carries every
 * incident with `started` / `ended` / `impact` — the same start/end/severity shape incident.io exposes.
 * So we compute here with the same window and the same weights as every other source (/methodology),
 * instead of reading an aggregate over the page's unknown period. Impact maps to
 * major = 1.0, minor = 0.3, null (informational) = 0. An unresolved incident is counted to `now`.
 *
 * Takes the FULL deduplicated list, never the display-capped one — the 25-item cap is sorted newest
 * first, so computing over it would drop older incidents that are still inside the window and publish
 * an inflated figure with `uptimeSource: 'official'` attached (#1123 review).
 *
 * The window is fixed at 30 days, not a parameter: the result field is named `uptime30d` and is
 * consumed as a 30-day figure everywhere, so a caller-supplied window would make that name a lie
 * (#1123 review). Known limitation, shared with the other computed sources: the denominator is the
 * full 30 days even if the page's records reach back less far — OpenRouter publishes 91 days, so
 * this is latent, but a second OnlineOrNot service on a freshly-migrated page would read optimistically.
 * The general handling for that is `uptimeWindowDays` + the #802 coverage gate.
 */
const WINDOW_DAYS = 30

function computeUptime(incidents: Incident[], nowMs: number): number {
  const windowStart = nowMs - WINDOW_DAYS * 86_400_000
  const windowSec = WINDOW_DAYS * 86_400
  // Collect (start, end, weight) and let the shared accumulator clamp open incidents to now and merge
  // overlaps (worst-weight-wins) so two concurrent incidents on the service aren't double-counted.
  const intervals: OutageInterval[] = incidents.map((inc) => ({
    start: Date.parse(inc.startedAt),
    end: inc.resolvedAt ? Date.parse(inc.resolvedAt) : null, // open incident → clamped to now
    weight: inc.impact === 'major' || inc.impact === 'critical' ? 1.0 : inc.impact === 'minor' ? 0.3 : 0,
  }))
  const weightedSec = weightedDowntimeSeconds(intervals, windowStart, nowMs)
  // Floor, like every other source — never round 99.998% up to a clean 100%.
  return Math.max(0, Math.floor((1 - weightedSec / windowSec) * 10000) / 100)
}

/** Incidents returned for DISPLAY. Uptime is computed before this cap is applied. */
const DISPLAY_LIMIT = 25

/**
 * Read an OnlineOrNot status page: its incidents AND its computed uptime, from ONE parse of the
 * SSR payload (#1123 — the two used to be separate entry points that each re-decoded the ~70 KB
 * array, and each carried its own idea of what "unreadable" meant).
 *
 * `ok: true` with `incidents: []` and `uptime30d: 100` is a REAL clean window. `ok: false` means the
 * payload could not be read, and the caller must NOT publish that as "operational, no incidents" —
 * route it through the source-unknown path instead.
 *
 * Unlike `InstatusIncidentsResult`, this returns uptime alongside the incidents: on this path there
 * is ONE fetch and ONE payload, and uptime is a pure function of the incident list, so splitting them
 * would recreate exactly the two-entry-points-two-readability-tests structure that caused #1123.
 */
export function parseOnlineOrNotPage(
  html: string,
  nowMs: number = Date.now(),
): OnlineOrNotPageResult {
  const extracted = extractData(html)
  if (!extracted.ok) return extracted
  if (!isStatusPagePayload(extracted.data)) {
    console.warn('[onlineornot] payload parsed but carries no `statusPage` marker — not an OnlineOrNot page?')
    return { ok: false, reason: 'not-status-page' }
  }
  const containers = readIncidentContainers(extracted.data, makeIdReader(extracted.data))
  if (!containers) {
    console.warn('[onlineornot] status page missing `incidents`/`activeIncidents`/`incidentIds` — shape changed?')
    return { ok: false, reason: 'no-incident-container' }
  }

  const { incidents, parsedIds, maintenanceIds, unreadableRows } = collectIncidents(extracted.data)

  // The page NAMES its incidents by id (bucket `incidentIds` + the open `activeIncidents`),
  // independently of the incident OBJECT's shape. An id it names that we did not turn into a record
  // OR deliberately drop as maintenance means we failed to READ the list, not that it is empty.
  // Comparing IDS (not resolution state) is what keeps this from firing when the two container copies
  // merely disagree about whether an incident is resolved (#1123 round-2 review, I2).
  const accounted = (id: string) => parsedIds.has(id) || maintenanceIds.has(id)
  const missing = [...new Set([...containers.expectedIds, ...containers.activeIds])].filter((id) => !accounted(id))
  if (missing.length > 0 || containers.activeUnreadable > 0) {
    console.warn(`[onlineornot] ${missing.length} named + ${containers.activeUnreadable} active incident(s) not parsed (${missing.slice(0, 3).join(', ')}) — shape changed?`)
    return { ok: false, reason: 'incidents-unreadable' }
  }
  // Belt: rows that looked incident-shaped but produced nothing, and were NOT named by any container
  // (no bucket, not active) — so `missing` above could not catch them. A payload where every row is
  // unreadable reads as a failure, never as "no incidents".
  if (unreadableRows > 0 && incidents.length === 0) {
    console.warn(`[onlineornot] every incident row (${unreadableRows}) was unreadable — shape changed?`)
    return { ok: false, reason: 'incidents-unreadable' }
  }

  return {
    ok: true,
    incidents: incidents.slice(0, DISPLAY_LIMIT),
    uptime30d: computeUptime(incidents, nowMs),
  }
}

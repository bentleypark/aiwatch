// OnlineOrNot (React Router SSR) Parser — for status pages like OpenRouter

import type { Incident, TimelineEntry } from '../types'
import { formatDuration } from '../utils'
import { MAINTENANCE_TITLE } from './betterstack'
import { weightedDowntimeSeconds, type OutageInterval } from './uptime-interval'

/**
 * Extract the flat data array from OnlineOrNot's React Router SSR HTML.
 * Data is embedded via streamController.enqueue() as an escaped JSON array.
 * Returns null on format mismatch or malformed JSON (callers treat as "no data").
 */
function extractData(html: string): unknown[] | null {
  const match = html.match(/streamController\.enqueue\("(\[.*?)"\)/)
  if (!match) {
    console.warn('[onlineornot] no streamController data found — format may have changed')
    return null
  }

  const raw = match[1]
    .replace(/\\\\\\\\/g, '\\')
    .replace(/\\\\"/g, '"')
    .replace(/\\"/g, '"')

  const endIdx = raw.lastIndexOf(']')
  if (endIdx < 0) {
    console.warn('[onlineornot] streamController data found but no closing bracket — payload truncated?')
    return null
  }

  try {
    return JSON.parse(raw.slice(0, endIdx + 1))
  } catch (err) {
    console.error('[onlineornot] JSON.parse failed — SSR format may have changed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Collect the object references that belong to the `scheduledMaintenance` collection.
 *
 * OnlineOrNot's SSR loader data separates real incidents (`incidents`/`activeIncidents`)
 * from planned maintenance (`scheduledMaintenance`), but a maintenance entry reuses the
 * SAME `title`/`started` key-name indices as an incident (and carries no `impact`), so the
 * flat-scan in {@link parseOnlineOrNotIncidents} would otherwise sweep it in as an active
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

/**
 * Parse OnlineOrNot status page HTML (React Router SSR format).
 * Object keys use _N refs where N = index of the key name string in the array.
 */
export function parseOnlineOrNotIncidents(html: string): Incident[] {
  const data = extractData(html)
  if (!data) return []

  // #894 — exclude planned-maintenance entries (they reuse incident key indices).
  const maintenanceRefs = collectMaintenanceRefs(data)

  // Build key index map: find indices of known key name strings
  const keyMap: Record<string, number> = {}
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 'incidentId') keyMap.incidentId = i
    if (data[i] === 'title') keyMap.title = i
    if (data[i] === 'started') keyMap.started = i
    if (data[i] === 'ended') keyMap.ended = i
    if (data[i] === 'impact') keyMap.impact = i
  }

  if (keyMap.title == null || keyMap.started == null) return []

  // Find incident objects: objects with _N keys matching our key indices
  const titleKey = `_${keyMap.title}`
  const startedKey = `_${keyMap.started}`
  const endedKey = keyMap.ended != null ? `_${keyMap.ended}` : null
  const impactKey = keyMap.impact != null ? `_${keyMap.impact}` : null
  const idKey = keyMap.incidentId != null ? `_${keyMap.incidentId}` : null

  const seen = new Set<string>()
  const incidents: Incident[] = []

  for (const item of data) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    if (maintenanceRefs.has(item)) continue  // #894 — skip scheduled-maintenance entries
    const obj = item as Record<string, number>
    if (!(titleKey in obj) || !(startedKey in obj)) continue

    const title = data[obj[titleKey]]
    const started = data[obj[startedKey]]
    if (typeof title !== 'string' || typeof started !== 'string' || !started.includes('T')) continue

    // #896 — title backstop: a COMPLETED maintenance is relocated out of the `scheduledMaintenance`
    // group (so the #894 structural filter misses it) but still carries a maintenance-shaped title.
    if (MAINTENANCE_TITLE.test(title)) continue

    const endedRaw = endedKey && obj[endedKey] != null ? data[obj[endedKey]] : null
    const ended = typeof endedRaw === 'string' ? endedRaw : null
    const impactRaw = impactKey && obj[impactKey] != null ? data[obj[impactKey]] : null
    const impact = typeof impactRaw === 'string' ? impactRaw : null
    const idRaw = idKey && obj[idKey] != null ? data[obj[idKey]] : null
    const incId = typeof idRaw === 'string' ? idRaw : null

    // Deduplicate by id or title+started
    const dedupKey = incId || `${title}|${started}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const startDate = new Date(started)
    if (isNaN(startDate.getTime())) continue
    const endDate = ended ? new Date(ended) : null
    const isResolved = endDate != null && !isNaN(endDate.getTime())

    const timeline: TimelineEntry[] = [
      { stage: 'investigating', text: title, at: startDate.toISOString() },
    ]
    if (isResolved) {
      timeline.push({ stage: 'resolved', text: '', at: endDate!.toISOString() })
    }

    incidents.push({
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
    })
  }

  // Sort by startedAt desc, limit to recent
  incidents.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return incidents.slice(0, 25)
}

/**
 * #1006 — OnlineOrNot uptime, COMPUTED over the trailing 30 days from the page's own incident records.
 *
 * The page publishes an aggregate % (e.g. "100% uptime"), but its own SSR payload also carries every
 * incident with `started` / `ended` / `impact` — the same start/end/severity shape incident.io exposes
 * — and `parseOnlineOrNotIncidents` already extracts them. So we compute here with the same window and
 * the same weights as every other source (/methodology), instead of reading an aggregate over the page's
 * unknown period. `parseOnlineOrNotIncidents` maps impact → 'major' | 'minor' | null; we weight
 * major = 1.0, minor = 0.3, null (informational) = 0. An unresolved incident is counted to `now`.
 *
 * Returns 100 when the page is a valid OnlineOrNot page with no qualifying downtime (a clean 30 days),
 * and null only when the payload has no incident structure at all (so a non-OnlineOrNot page — or a
 * shape change — reads as "no official uptime" rather than a fabricated 100%).
 */
export function computeOnlineOrNotUptime(html: string, nowMs: number = Date.now(), windowDays = 30): number | null {
  const data = extractData(html)
  if (!data) return null
  // The page must actually be an OnlineOrNot status page: its loader data names the incident-shape keys
  // (`title` + `started`). Without this guard a random page with no incidents would read as a clean 100%
  // rather than "no official uptime".
  if (!data.includes('title') || !data.includes('started')) return null

  const incidents = parseOnlineOrNotIncidents(html)
  const windowStart = nowMs - windowDays * 86_400_000
  const windowSec = windowDays * 86_400
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

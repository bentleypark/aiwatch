// Merge live /api/status incidents with monthly archive incidentList for the 90d filter.
// Pre-#375 the 90d filter only saw live data, which the upstream status pages cap at
// last-N entries — high-frequency services (Mistral, Together) showed only 3-5 days
// instead of the promised 90. The archive (#375) preserves per-incident detail past
// that window; this module is the client-side consumer.

import { formatRecoveryMin } from './recovery'

const DAY_MS = 86_400_000

/**
 * Months to fetch for a given period filter, INCLUDING the current month (#587).
 *
 * UTC math is load-bearing here: archive:monthly:{YYYY-MM} keys are written by the
 * Worker cron at UTC 00:00 on the 1st of each month, and the Playwright test asserts
 * via `new Date().toISOString().slice(0,7)` which is also UTC. Using local-TZ accessors
 * caused a 9-hour mismatch on UTC+9 runners around month-edge.
 *
 * Current month (#587): the Worker's `/api/report?month={current}` has no built archive yet
 * (the cron builds it on the 1st of next month), so it serves a PARTIAL archive synthesized
 * READ-ONLY from the live `incidents:monthly:{month}` accumulator (incidentList only). That
 * surfaces a current-month incident which already rolled out of the upstream live feed
 * (short-window RSS sources like Azure/Bedrock) before the archive exists. `mergeArchiveIntoMap`
 * dedups by raw incident id with live winning on collision, so an incident still shown by
 * /api/status is never double-rendered. The old "exclude current month" stance (which left
 * rolled-out current-month incidents invisible until the 1st-of-month build) is retired — the
 * write-race concern it cited doesn't apply, since the partial archive never rebuilds/writes
 * archive:monthly.
 *
 * ALL periods fetch (#587, was 90d-only): the original #375 stance ("7d/30d are smaller than the
 * upstream cap, so live covers them") is FALSE for short-window RSS sources (Azure/Bedrock surface
 * only ~5d of live incidents). So a 30d filter would silently drop a 15-day-old Azure incident.
 * Now every period fetches the archive months its window spans (7d → just the current month; 30d →
 * current + prev; 90d → up to 4). Normal multi-day-window services are unaffected — `mergeArchiveIntoMap`
 * dedups by raw id (live wins) so their archive entries are a no-op, and `isWithinPeriod` ages out
 * archive entries older than the window, so a wider partial never over-shows. Reads only (no KV
 * writes); the Worker's `max-age=60` + the client promise cache keep the extra fetches cheap.
 *
 * MAX_ARCHIVE_MONTHS cap is defense-in-depth: a future 180d/365d preset shouldn't
 * spawn 12 parallel /api/report fetches without a deliberate review.
 *
 * @param {number} days  period in days (7 / 30 / 90 today); 0/null = no period filter → no fetch
 * @param {Date}   [now] inject for tests
 * @returns {string[]}   e.g. 90d → ['2026-03', '2026-04', '2026-05', '2026-06'] (includes current month)
 */
export const MAX_ARCHIVE_MONTHS = 6

export function archiveMonthsForPeriod(days, now = new Date()) {
  if (!days) return [] // 0/null (e.g. an "all" filter) → live-only, no archive fetch
  const cutoff = new Date(now.getTime() - days * DAY_MS)
  const months = []
  const cursor = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1))
  // Inclusive of the current month (#587): end = 1st of NEXT month (exclusive).
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  while (cursor < end && months.length < MAX_ARCHIVE_MONTHS) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`)
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return months
}

/**
 * Period-filter predicate for the Incidents list (#587). A genuinely LIVE ongoing incident is
 * always shown (the always-show exemption); a resolved incident — OR an archive-sourced
 * non-resolved entry whose accumulator `finalStatus` is frozen at 'investigating' (an RSS incident
 * that rolled out of the live feed before a resolved update was seen) — ages out by `startedAt`.
 * Without the `!fromArchive` guard a stale archived 'ongoing' would pin to the TOP of the 90d list
 * (compareIncidents lifts ongoing first) for the 60-day accumulator TTL.
 *
 * @param {{status: string, startedAt: string, fromArchive?: boolean}} inc
 * @param {number|null} cutoff  epoch ms lower bound; null/0 = no period filter (show all)
 * @returns {boolean}
 */
export function isWithinPeriod(inc, cutoff) {
  if (!cutoff) return true
  if (inc.status !== 'resolved' && !inc.fromArchive) return true // live ongoing — always shown
  return new Date(inc.startedAt).getTime() >= cutoff
}

/**
 * Shape an archive incidentList entry into the live-incident shape Incidents.jsx
 * already iterates. timeline:[] is intentional — archive only carries summary
 * fields; the DetailPanel must handle empty timelines gracefully (already does).
 */
export function archiveIncidentToLive(archIncident, service) {
  return {
    id: archIncident.id, // raw upstream id; caller composes the `${serviceId}:${id}` view-id
    title: archIncident.title,
    // finalStatus is one of resolved / monitoring / investigating / identified. The status cell
    // renders t(`incidents.status.${status}`) — the investigating/identified locale keys exist so
    // a non-resolved archive entry doesn't show the raw key.
    status: archIncident.finalStatus,
    startedAt: archIncident.startedAt,
    resolvedAt: archIncident.resolvedAt ?? null,
    // Carry the archived duration so a RESOLVED archive incident shows its real duration (e.g.
    // "7h 26m") instead of falling through to the "Ongoing" placeholder (`incident.duration ??`).
    // An unresolved archive entry (resolvedAt null) keeps duration undefined → renders "Ongoing".
    duration: archIncident.resolvedAt ? formatRecoveryMin(archIncident.durationMin ?? 0) : undefined,
    timeline: [],
    serviceName: service.name,
    serviceId: service.id,
    fromArchive: true,
  }
}

/**
 * Add archive incidents into the live-derived incident map. Live wins on ID collision —
 * the live entry has the up-to-date timeline and status; the archive snapshot is older.
 * Returns the same map (mutated for caller-side reuse).
 *
 * Both `liveMap` and the resulting affectedNames accumulation use the **raw** incident ID
 * (not the composite serviceId:id) — that's how Incidents.jsx already deduplicates a
 * single incident that affects multiple services (e.g. Claude API + claude.ai sharing
 * one Anthropic status entry). Without that key shape, an archive entry that appeared
 * across two services would render as two cards.
 */
export function mergeArchiveIntoMap(liveMap, archives, services) {
  for (const month of Object.keys(archives)) {
    const archive = archives[month]
    const archServices = archive?.services
    if (!archServices) continue
    for (const [serviceId, sdata] of Object.entries(archServices)) {
      const incidentList = sdata?.incidentList
      if (!Array.isArray(incidentList) || incidentList.length === 0) continue
      const service = services.find(s => s.id === serviceId)
      if (!service) continue // service renamed/removed since archive was written
      for (const arch of incidentList) {
        const existing = liveMap.get(arch.id)
        if (existing) {
          if (!existing.affectedNames.includes(service.name)) existing.affectedNames.push(service.name)
          continue
        }
        // #587 — skip only the genuinely-active / frozen-mid-incident archive states. `investigating`
        // and `identified` have no STATUS_BADGE_CLASS entry (they fall back to the green "resolved"
        // style) so an archive-only entry frozen in those states renders a misleading "In Progress"
        // phantom (green badge + "Ongoing" duration); a truly-active incident is already shown by live
        // /api/status. `resolved` (green) and `monitoring` (amber, impact ended, real duration) have a
        // defined badge → surfaced.
        if (arch.finalStatus === 'investigating' || arch.finalStatus === 'identified') continue
        const live = archiveIncidentToLive(arch, service)
        liveMap.set(arch.id, { ...live, affectedNames: [service.name] })
      }
    }
  }
  return liveMap
}

/**
 * Service-filtered variant: returns a flat array of archive supplements for a single
 * service that aren't already in the live set. Caller appends these to its live array.
 * Skips the multi-service affectedNames accumulation since the filter view shows only
 * one service at a time.
 *
 * @param {Set<string>} liveCompositeIds  set of `${serviceId}:${incidentId}` already shown
 * @param {string} serviceFilter          service id user selected
 * @param {Record<string, object>} archives
 * @param {Array<{id, name}>} services
 * @returns {Array<object>}  archive incidents in live shape, with composite id assigned
 */
export function archiveSupplementForService(liveCompositeIds, serviceFilter, archives, services) {
  const out = []
  for (const month of Object.keys(archives)) {
    const archive = archives[month]
    const archServices = archive?.services
    if (!archServices) continue
    const sdata = archServices[serviceFilter]
    if (!sdata) continue
    const incidentList = sdata.incidentList
    if (!Array.isArray(incidentList) || incidentList.length === 0) continue
    const service = services.find(s => s.id === serviceFilter)
    if (!service) continue
    for (const arch of incidentList) {
      const cid = `${serviceFilter}:${arch.id}`
      if (liveCompositeIds.has(cid)) continue
      if (arch.finalStatus === 'investigating' || arch.finalStatus === 'identified') continue // #587 (see mergeArchiveIntoMap)
      liveCompositeIds.add(cid)
      const live = archiveIncidentToLive(arch, service)
      out.push({ ...live, id: cid, affectedNames: [service.name] })
    }
  }
  return out
}

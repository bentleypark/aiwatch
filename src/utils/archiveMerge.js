// Merge live /api/status incidents with monthly archive incidentList for the 90d filter.
// Pre-#375 the 90d filter only saw live data, which the upstream status pages cap at
// last-N entries — high-frequency services (Mistral, Together) showed only 3-5 days
// instead of the promised 90. The archive (#375) preserves per-incident detail past
// that window; this module is the client-side consumer.

const DAY_MS = 86_400_000

/**
 * Months to fetch for a given period filter, current month excluded.
 *
 * UTC math is load-bearing here: archive:monthly:{YYYY-MM} keys are written by the
 * Worker cron at UTC 00:00 on the 1st of each month, and the Playwright test asserts
 * via `new Date().toISOString().slice(0,7)` which is also UTC. Using local-TZ accessors
 * caused a 9-hour mismatch on UTC+9 runners around month-edge: the page would request
 * an archive that the backend hadn't yet written (404, silently degrades to live).
 *
 * "Current month excluded" caveat: live data covers the current month for low-frequency
 * services in full, but for high-frequency services (Mistral/Together) upstream still
 * only returns ~5d of live entries. This merge shrinks the pre-#375 gap from ~85d to
 * a few days at most — not a full fill. Acceptable trade-off since the alternative
 * (early-rebuild current-month archive) collides with the daily-summary accumulator.
 *
 * MAX_ARCHIVE_MONTHS cap is defense-in-depth: a future 180d/365d preset shouldn't
 * spawn 12 parallel /api/report fetches without a deliberate review.
 *
 * @param {number} days  period in days (7 / 30 / 90 today)
 * @param {Date}   [now] inject for tests
 * @returns {string[]}   ['2026-02', '2026-03', '2026-04']
 */
export const MAX_ARCHIVE_MONTHS = 6

export function archiveMonthsForPeriod(days, now = new Date()) {
  if (!days || days < 90) return []
  const cutoff = new Date(now.getTime() - days * DAY_MS)
  const months = []
  const cursor = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) // exclusive
  while (cursor < end && months.length < MAX_ARCHIVE_MONTHS) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`)
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return months
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
    // Archive only persists final state ('resolved' | 'monitoring'). The Incidents page
    // status-normalize step already handles both — no extra mapping needed here.
    status: archIncident.finalStatus,
    startedAt: archIncident.startedAt,
    resolvedAt: archIncident.resolvedAt ?? null,
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
      liveCompositeIds.add(cid)
      const live = archiveIncidentToLive(arch, service)
      out.push({ ...live, id: cid, affectedNames: [service.name] })
    }
  }
  return out
}

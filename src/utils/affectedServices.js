// #1959 — the Overview "Affected now" block: affected services ordered by incident start, grouped
// by shared incident id.
import { displayStatusOf, isDisplayAffected, groupWorstStatus } from './statusDisplay.js'

const STATUS_PRIORITY = { down: 0, degraded: 1, partial: 2, operational: 3, unknown: 4 }

/** Worst display state first, then the lower AIWatch Score first. */
export function issueSort(a, b) {
  return (STATUS_PRIORITY[displayStatusOf(a)] - STATUS_PRIORITY[displayStatusOf(b)]) || ((a.aiwatchScore ?? 0) - (b.aiwatchScore ?? 0))
}

/** The open incident a service is listed under: the one with the latest `startedAt`. null for a stale source or
 *  when no open incident has a start. */
export function anchorIncidentOf(service) {
  if (service.incidentSourceStale) return null
  const open = (Array.isArray(service.incidents) ? service.incidents : [])
    .filter((i) => i.status !== 'resolved' && i.derived !== 'status_history' && Number.isFinite(Date.parse(i.startedAt)))
  if (open.length === 0) return null
  const live = open.filter((i) => i.status !== 'monitoring')
  return (live.length > 0 ? live : open).reduce((best, i) => {
    const d = Date.parse(i.startedAt) - Date.parse(best.startedAt)
    return d > 0 || (d === 0 && String(i.id) > String(best.id)) ? i : best
  })
}

export function isEntryExpandable(entry) {
  return (entry?.incident?.timeline ?? []).length > 0
}

/**
 * One entry per incident id that an affected service is listed under, plus one entry per affected
 * service with no usable incident.
 *
 * Entries with an incident come first, newest start first; the rest follow in `issueSort` order.
 *
 * @param {object[]} services
 * @returns {{ key: string, incident: object|null, status: string, members: object[] }[]}
 */
export function buildAffectedEntries(services) {
  const byIncident = new Map()
  const undated = []
  for (const svc of (services ?? []).filter(isDisplayAffected)) {
    const anchor = anchorIncidentOf(svc)
    if (!anchor) { undated.push(svc); continue }
    const entry = byIncident.get(anchor.id)
    if (entry) entry.members.push(svc)
    else byIncident.set(anchor.id, { key: `incident:${anchor.id}`, incident: anchor, members: [svc] })
  }
  const dated = [...byIncident.values()].map((e) => {
    const members = e.members.sort(issueSort)
    return { ...e, members, status: groupWorstStatus(members) }
  })
  dated.sort((a, b) =>
    (Date.parse(b.incident.startedAt) - Date.parse(a.incident.startedAt))
    || (STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status])
    || a.members[0].name.localeCompare(b.members[0].name))
  const rest = undated.sort(issueSort).map((svc) => ({ key: `service:${svc.id}`, incident: null, status: displayStatusOf(svc), members: [svc] }))
  return [...dated, ...rest]
}

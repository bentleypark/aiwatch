// #1338 — the unfiltered Incidents log's rows, keyed by raw incident id. Providers that file one
// incident across services (Anthropic, OpenAI) share an id; xAI files one per card, and the worker tags
// both with the same `crossEventKey`. An incident joining a row is aliased under its own raw id too, so the
// archive merge — which looks rows up by raw id — finds the row instead of adding a second one.
import { mergeArchiveIntoMap } from './archiveMerge'
import { mergeReferenceRows } from './referenceIncidents'

/** A live incident as a log row: composite id, display status. */
export function toLiveRow(inc, svc) {
  return {
    ...inc,
    id: `${svc.id}:${inc.id}`,
    status: inc.status === 'resolved' ? 'resolved'
      : inc.status === 'monitoring' ? 'monitoring'
      : 'ongoing',
    serviceName: svc.name,
    serviceId: svc.id,
  }
}

const OPENNESS = { ongoing: 2, monitoring: 1, resolved: 0 }

/** The more open of two rows of one event: the less resolved status, then the later resolution. */
function moreOpen(a, b) {
  const d = OPENNESS[b.status] - OPENNESS[a.status]
  if (d !== 0) return d > 0 ? b : a
  return (b.resolvedAt ?? '') > (a.resolvedAt ?? '') ? b : a
}

function liveIncidentMap(services) {
  const incMap = new Map()
  const byEvent = new Map()
  for (const svc of services) {
    for (const inc of svc.incidents ?? []) {
      const sameId = incMap.get(inc.id)
      if (sameId) {
        if (!sameId.affectedNames.includes(svc.name)) sameId.affectedNames.push(svc.name)
        continue
      }
      const event = inc.crossEventKey ? byEvent.get(inc.crossEventKey) : undefined
      if (event && !event.affectedNames.includes(svc.name)) {
        const { affectedNames } = event
        affectedNames.push(svc.name)
        const candidate = toLiveRow(inc, svc)
        if (moreOpen(event, candidate) === candidate) {
          for (const k of Object.keys(event)) delete event[k]
          Object.assign(event, candidate, { affectedNames })
        }
        incMap.set(inc.id, event)
        continue
      }
      const row = { ...toLiveRow(inc, svc), affectedNames: [svc.name] }
      incMap.set(inc.id, row)
      if (inc.crossEventKey && !event) byEvent.set(inc.crossEventKey, row)
    }
  }
  return incMap
}

/** Live rows, then archive rows of the selected months, then reference rows — each row once. */
export function unfilteredIncidentRows(services, archives, archiveMonths, toReferenceRow) {
  const incMap = liveIncidentMap(services)
  // Archive supplement uses the same raw-id keying so a single incident that touched
  // multiple services in the archive accumulates into one row, not duplicates.
  if (archiveMonths.length > 0) {
    mergeArchiveIntoMap(incMap, archives, services)
    // Archive-only entries are added under their raw id; give them the live composite id.
    for (const [rawId, entry] of incMap) {
      if (entry.fromArchive) entry.id = `${entry.serviceId}:${rawId}`
    }
  }
  mergeReferenceRows(incMap, services, toReferenceRow)
  return [...new Set(incMap.values())]
}

import { compareIncidents, tierStatus } from './incidentSort'
import { isWithinPeriod } from './archiveMerge'

/**
 * The Incidents page's filtered list: service, status (by `tierStatus`, so a #1622 continuing row is
 * filed with the ongoing ones), then period, newest first within each tier.
 */
export function filterIncidentList(incidents, { serviceFilter, statusFilter, cutoff }) {
  return incidents
    .filter((inc) => serviceFilter === 'all' || inc.serviceId === serviceFilter)
    .filter((inc) => statusFilter === 'all' || tierStatus(inc) === statusFilter)
    // #587 — age out a stale archive-sourced 'ongoing' (frozen finalStatus) by startedAt; only a
    // genuinely LIVE non-resolved incident gets the always-show exemption. See isWithinPeriod.
    .filter((inc) => isWithinPeriod(inc, cutoff))
    .sort(compareIncidents)
}

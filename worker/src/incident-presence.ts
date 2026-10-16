import type { Incident, ServiceStatus } from './types'

/** #1698 — every incident the provider's page carries for this service: counted (`incidents`) and not
 *  counted (`referenceIncidents`, #1669). The answer to "is it still on the page?". */
export type PageCarrier = Pick<ServiceStatus, 'incidents' | 'referenceIncidents'>

export function pageIncidents(svc: PageCarrier): Incident[] {
  return [...(svc.incidents ?? []), ...(svc.referenceIncidents ?? [])]
}

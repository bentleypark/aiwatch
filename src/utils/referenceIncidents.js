// #1669 — incidents on a provider's console component (worker `referenceIncidents`). Not a service:
// listed only in the cross-service incident logs, labelled "Provider · Component", never on a service
// screen or in its counts. A service filter matches a row only when its label names that service
// (#1672 — turbopuffer's Dashboard under turbopuffer; Anthropic's Console is not under Claude API).
export function referenceIncidentRows(services) {
  return (services ?? []).flatMap((svc) =>
    (svc.referenceIncidents ?? []).map((inc) => {
      const label = `${svc.provider} · ${(inc.componentNames ?? []).join(', ')}`
      const serviceId = svc.provider === svc.name ? svc.id : `ref:${svc.id}`
      return { ...inc, serviceName: label, serviceId, affectedNames: [label] }
    }),
  )
}

/** Add reference rows to an incident map keyed by raw id; a row already there wins. */
export function mergeReferenceRows(incMap, services, toRow = (r) => r) {
  for (const ref of referenceIncidentRows(services)) {
    if (!incMap.has(ref.id)) incMap.set(ref.id, toRow(ref))
  }
  return incMap
}

// #1669 — incidents on a provider's console component (worker `referenceIncidents`). Not a service:
// listed only in the cross-service incident logs, labelled "Provider · Component", never on a service
// screen or in its counts. `serviceId` is namespaced so no service filter matches it.
export function referenceIncidentRows(services) {
  return (services ?? []).flatMap((svc) =>
    (svc.referenceIncidents ?? []).map((inc) => {
      const label = `${svc.provider} · ${(inc.componentNames ?? []).join(', ')}`
      return { ...inc, serviceName: label, serviceId: `ref:${svc.id}`, affectedNames: [label] }
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

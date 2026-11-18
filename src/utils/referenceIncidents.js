// #1669 — incidents on a provider's component that is not a service (worker `referenceIncidents`):
// labelled "Provider · Component", never on a service screen or in its counts. A service filter matches a row only when its label names that service
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

/** A reference incident as an Incidents-log row. */
export const toReferenceRow = (r) => ({
  ...r,
  status: r.status === 'resolved' ? 'resolved' : r.status === 'monitoring' ? 'monitoring' : 'ongoing',
})

/** #2027 — the unresolved reference incidents no service counts, one row per id. */
export function openReferenceRows(services) {
  const seen = new Set((services ?? []).flatMap((s) => (s.incidents ?? []).map((i) => i.id)))
  return referenceIncidentRows(services).map(toReferenceRow).filter((r) => {
    if (r.status === 'resolved' || seen.has(r.id)) return false
    seen.add(r.id)
    return true
  })
}

/** Add reference rows to an incident map keyed by raw id; a row already there wins. */
export function mergeReferenceRows(incMap, services, toRow = (r) => r) {
  for (const ref of referenceIncidentRows(services)) {
    if (!incMap.has(ref.id)) incMap.set(ref.id, toRow(ref))
  }
  return incMap
}

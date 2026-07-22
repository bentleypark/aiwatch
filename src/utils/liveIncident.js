// #1104 — "is this service still carrying a live incident?", in one place.
//
// The worker now keeps an incident whose impact on OUR badge component has ended while the incident
// itself stays open, so `operational badge + open incident` went from rare to ordinary. Every surface
// that says "resolved" has to ask the incident, not the badge — and they have to ask it the SAME way,
// or the dashboard and the is-down page answer opposite things about one incident (which is exactly
// what #1104 filed). This module is the SPA's copy; the Edge is-down template carries `hasLiveIncident`
// with the same rule (the two surfaces share no module, so it is duplicated deliberately, not by drift).
//
// `monitoring` is NOT live: that is the provider confirming recovery, and it is the same cut the worker
// makes when choosing which analyses to send ("monitoring = recovery confirmed").
//
// Deliberately OUT of scope: Overview's "Recently Resolved" BANNER (`buildRecoveredRows`). That row is
// per-incident and names the incident it resolved, so "this incident recovered" stays true while a
// sibling is open. Only the service-level chip and pill are claims this rule can falsify.

/** Does this service still carry an incident the provider has not closed?
 *
 *  `Array.isArray`, not `?? []`: a malformed cached payload with a non-array truthy `incidents` would
 *  otherwise throw `.some is not a function` INSIDE a React render and take the page down. The Edge
 *  copy guards the same way — the two must not just agree on the answer, they must agree on how they
 *  fail. Pinned by `liveIncident-sync.test.ts`. */
export function hasLiveIncident(service) {
  const list = Array.isArray(service?.incidents) ? service.incidents : []
  return list.some(i => i?.status !== 'resolved' && i?.status !== 'monitoring')
}

/** May this group of services be presented as resolved (the AI-analysis "Resolved" pill, the service
 *  header's "Recently Resolved" chip)? Every member must be operational AND free of a live incident.
 *
 *  Deliberately NOT "every analysis carries `resolvedAt`": `/api/status/cached` fills its recovered-
 *  analysis branch whenever the ACTIVE branch produced nothing — not when nothing is active — so a card
 *  can hold only resolved analyses while an incident is still open (its own analysis lost the cron's
 *  15s budget, or the provider re-opened it after #1003 stamped `resolvedAt`). Keying on that reads
 *  "Resolved" over a live incident, which is #1104 one level up. */
export function readsResolved(services) {
  const list = Array.isArray(services) ? services : [services]
  // An EMPTY group must not read resolved. `[].every()` is `true`, so without this the fail direction
  // is OPEN — the dangerous one, since claiming "Resolved" over a live incident is the whole bug. No
  // caller can pass one today, but this is a shared primitive written to attract callers.
  if (list.length === 0) return false
  return list.every(s => s?.status === 'operational') && !list.some(hasLiveIncident)
}

/** The "Recently Resolved" chip decision, shared by the Overview card and the ServiceDetails header.
 *  Both render the identical chip and must answer identically: the recovery marker is per-INCIDENT,
 *  but the chip is a claim about the SERVICE, and "one incident recovered while another is still
 *  open" is ordinary now that the worker keeps an incident past our own component's recovery. */
export function showRecoveredChip(recentlyRecovered, service) {
  return !!recentlyRecovered?.[service?.id] && readsResolved(service)
}

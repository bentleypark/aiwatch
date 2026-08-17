// #722 — resolve the DISPLAY status for a service badge from its raw status + source flags.
//
// Display-only: this NEVER changes the underlying `status` field (Score / Ranking / Discord
// alerts all read the raw `status`). It only decides which visual state to render:
//   - sourceDead       → 'unknown'  (#689 — the status source is inactive; component counts
//                                     aren't trustworthy when AIWatch can't confirm the service)
//   - operational + partialCount>0 → 'partial' (#722 — BetterStack sub-threshold partial outage:
//                                     the provider page shows "Some services are down" while the
//                                     overall service reads operational; an intermediate yellow
//                                     state mirrors StatusGator/IsDown "warn" instead of full green)
//   - otherwise        → the raw status ('operational' | 'degraded' | 'down' | 'unknown')
//
// #1233 — `unknown` is now a raw status value, published by the worker for a source it could not read,
// so it needs no mapping at all: it falls through and renders the neutral pill directly. The rule this
// module used to carry for that case (`sourceUnknown` + `degraded` → 'unknown') was one of two
// hand-written copies of the same correction — the other lived in `api/_is-down/html-template.ts`, and
// the surfaces that never wrote a third copy (is-down group, statusline, plugin, extension) published a
// false outage. Deriving the state in the worker instead of correcting it per surface is what removes
// that class; the one line left below is a transitional read of pre-#1233 payloads, not the rule.
export function resolveStatusDisplay(status = 'operational', partialCount = 0, sourceDead = false, sourceUnknown = false) {
  if (sourceDead) return 'unknown'
  // #1233 transitional — a cached payload written before the change encodes an unreadable source as
  // `degraded` + `sourceUnknown`. A no-op on any current payload.
  if (sourceUnknown && status === 'degraded') return 'unknown'
  if (status === 'operational' && partialCount > 0) return 'partial'
  return status
}

/** The two source flags `resolveStatusDisplay` takes, derived from a service once so every surface
 *  applies the SAME guards (#1004 — the Overview card said "Unknown" while the banner above it still
 *  said "Degraded — switch to X"). Spread into the resolver: `resolveStatusDisplay(s.status, s.partialCount, ...sourceFlagsOf(s))`.
 *  - `sourceDead` is suppressed by `probeConfirmed` (#689: the page died but our probe still reaches
 *    the API → we DO know it's up, so keep the operational badge).
 *  - `sourceUnknown` is suppressed by `probeContradicted` — which since #1233 matters only for the
 *    transitional legacy payload above. On a current payload the worker has already resolved that
 *    question into the status itself (a corroborating probe publishes `degraded`, not `unknown`). */
export function sourceFlagsOf(service) {
  return [
    !!service.sourceDead && !service.probeConfirmed,
    !!service.sourceUnknown && !service.probeContradicted,
  ]
}

/** The resolved display state of a whole service — the one-call form every surface should use. */
export function displayStatusOf(service) {
  return resolveStatusDisplay(service.status, service.partialCount, ...sourceFlagsOf(service))
}

/** #1004 — is this service AFFECTED for display purposes? The Overview action banner, the fallback
 *  recommendations and the sidebar issue count all filtered on the raw `status`, so an unreadable-source
 *  service still showed up as "Degraded — try X instead": AIWatch actively recommending users abandon a
 *  service it had just admitted it could not read. Anything the resolver renders as neutral 'unknown'
 *  must not be counted as an outage anywhere. */
export function isDisplayAffected(service) {
  const display = displayStatusOf(service)
  return display === 'down' || display === 'degraded'
}

/** #1004 — is this service UP for display purposes? `partial` counts: the service is operational overall
 *  and only some components are affected (#722/#744 — which is why its is-down answer stays "No").
 *  `unknown` does NOT: we can't claim it's up any more than we can claim it's down, so it belongs to
 *  neither tab. The counterpart of isDisplayAffected — the two must be derived from the SAME resolver as
 *  the lists they label, or a tab badge says N while the tab renders N−1. */
export function isDisplayOperational(service) {
  const display = displayStatusOf(service)
  return display === 'operational' || display === 'partial'
}

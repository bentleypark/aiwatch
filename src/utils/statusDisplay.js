// #722 — resolve the DISPLAY status for a service badge from its raw status + source flags.
//
// Display-only: this NEVER changes the underlying `status` field (Score / Ranking / Discord
// alerts all read the raw `status`). It only decides which visual state to render:
//   - sourceDead       → 'unknown'  (#689 — the status source is inactive; component counts
//                                     aren't trustworthy when AIWatch can't confirm the service)
//   - sourceUnknown + degraded → 'unknown' (#1004 — see below)
//   - operational + partialCount>0 → 'partial' (#722 — BetterStack sub-threshold partial outage:
//                                     the provider page shows "Some services are down" while the
//                                     overall service reads operational; an intermediate yellow
//                                     state mirrors StatusGator/IsDown "warn" instead of full green)
//   - otherwise        → the raw status ('operational' | 'degraded' | 'down')
//
// #1004 — why `sourceUnknown` + `degraded` is not a real outage. That `degraded` is what
// `trackFetchFailure` returns after 3 consecutive failures on the Statuspage fetch path — a statement
// about OUR read (throw / 5xx, #714), not about the service. JetBrains moved Junie's status page and
// 301'd the old host to the new site ROOT, so our fetch got HTML where it expected JSON, `res.json()`
// threw, and Junie showed a false amber `degraded` badge while JetBrains reported all-green. Note the
// asymmetry that hid it: a page DELETION (4xx) is `sourceDead` → neutral badge; a page MIGRATION
// (301 → a 200 HTML body) is `sourceUnknown` → had no display path at all.
//
// Three guards on that mapping:
//   - `sourceUnknown` + `operational` (under the 3-strike threshold) stays operational — a transient
//     blip is not worth a scary badge, and no news is not bad news yet.
//   - `probeContradicted` (#1004) — if the service is probed and the probe is FAILING, the outage is
//     independently corroborated: keep it amber. Neutralising it would be a false reassurance.
//     (A probe that is HEALTHY already flipped the service back to operational server-side, in
//     fetchAllServices' cross-validation — it never reaches this function as `degraded`.)
//   - `down` is never masked: it can only come from a source we actually read.
// Which fetch paths set `sourceUnknown` is deliberately NOT listed here. That list was wrong twice —
// it went stale as paths were added (#1089, #1123, #1212), and the correction was wrong in the other
// direction. `services.ts` owns it; grep the flag there.
export function resolveStatusDisplay(status = 'operational', partialCount = 0, sourceDead = false, sourceUnknown = false) {
  if (sourceDead) return 'unknown'
  if (sourceUnknown && status === 'degraded') return 'unknown'
  if (status === 'operational' && partialCount > 0) return 'partial'
  return status
}

/** The two source flags `resolveStatusDisplay` takes, derived from a service once so every surface
 *  applies the SAME guards (#1004 — the Overview card said "Unknown" while the banner above it still
 *  said "Degraded — switch to X"). Spread into the resolver: `resolveStatusDisplay(s.status, s.partialCount, ...sourceFlagsOf(s))`.
 *  - `sourceDead` is suppressed by `probeConfirmed` (#689: the page died but our probe still reaches
 *    the API → we DO know it's up, so keep the operational badge).
 *  - `sourceUnknown` is suppressed by `probeContradicted` (#1004: the probe says the service is
 *    genuinely failing → the `degraded` is real). */
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

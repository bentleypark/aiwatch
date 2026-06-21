// #722 — resolve the DISPLAY status for a service badge from its raw status + partialCount.
//
// Display-only: this NEVER changes the underlying `status` field (Score / Ranking / Discord
// alerts all read the raw `status`). It only decides which visual pill state to render:
//   - sourceDead       → 'unknown'  (#689 — the status source is inactive; component counts
//                                     aren't trustworthy when AIWatch can't confirm the service)
//   - operational + partialCount>0 → 'partial' (#722 — BetterStack sub-threshold partial outage:
//                                     the provider page shows "Some services are down" while the
//                                     overall service reads operational; an intermediate yellow
//                                     state mirrors StatusGator/IsDown "warn" instead of full green)
//   - otherwise        → the raw status ('operational' | 'degraded' | 'down')
export function resolveStatusDisplay(status = 'operational', partialCount = 0, sourceDead = false) {
  if (sourceDead) return 'unknown'
  if (status === 'operational' && partialCount > 0) return 'partial'
  return status
}

// #883 — Latency metric-card state resolver (ServiceDetails).
//
// Three states, in priority order:
//   'probe'      — the service is directly probed (own endpoint) → show its own latest RTT.
//   'inherited'  — the service runs on an already-probed PARENT API (Claude Code→claude, Codex→openai,
//                  via worker PROBE_INHERIT, surfaced as `service.probeInheritedFrom`). It has no own
//                  probe, but its Score's Responsiveness inherits the parent's — so show the PARENT's
//                  current RTT, labeled, instead of a contradictory "Not provided". Stays OUT of the
//                  Latency ranking (not in probeServiceIds) — the distinction lives on the detail card.
//   'none'       — neither: not measured (#1633 — status-page fetch timing is never shown as latency).
//
// Pure + presentation-free (returns kind/rtt/parentName; the component maps those to label/color).

import { measuredRtt, probeFailureKind } from '../../worker/src/probe'

/** #1644 — the latest probe's failure, when it measured no RTT: `{ status }` (0 = no response). */
function failureOf(result) {
  const kind = result ? probeFailureKind(result) : null
  return kind === 'timeout' || kind === 'http5xx' ? { status: kind === 'timeout' ? 0 : result.status } : null
}

/**
 * @param {object}   service          the ServiceStatus being shown (needs id, latency, probeInheritedFrom)
 * @param {string[]} probeServiceIds  ids with a direct probe snapshot this cycle
 * @param {object}   latestProbe      latest probe snapshot `data` map: { id: { status, rtt } }
 * @param {object[]} services         all services (to resolve the parent's display name)
 * @returns {{ kind: 'probe'|'inherited'|'none', rtt: number|null, parentName: string|null, failure: { status: number }|null }}
 */
export function latencyCardState(service, probeServiceIds, latestProbe, services) {
  const isDirectProbe = (probeServiceIds ?? []).includes(service.id)
  const inheritedFrom = service.probeInheritedFrom

  if (!isDirectProbe && inheritedFrom) {
    const parentName = (services ?? []).find((s) => s.id === inheritedFrom)?.name ?? inheritedFrom
    const probe = latestProbe?.[inheritedFrom]
    return { kind: 'inherited', rtt: measuredRtt(probe), parentName, failure: failureOf(probe) }
  }
  if (isDirectProbe) {
    return { kind: 'probe', rtt: service.latency ?? null, parentName: null, failure: failureOf(latestProbe?.[service.id]) }
  }
  return { kind: 'none', rtt: null, parentName: null, failure: null }
}

/** #1644 — the card's sub-line for a `latencyCardState` result. */
export function latencyCardSub(card, t) {
  if (card.kind === 'none') return t('svc.latency.notMeasured')
  if (card.rtt != null) return card.kind === 'probe' ? t('svc.latency.sub') : t('svc.latency.inherited.sub').replace('{p}', card.parentName)
  if (card.failure) return card.failure.status === 0 ? t('svc.latency.failed.noResponse') : t('svc.latency.failed.http').replace('{code}', String(card.failure.status))
  return t('uptime.collecting')
}

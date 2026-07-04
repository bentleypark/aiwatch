// #883 — Latency metric-card state resolver (ServiceDetails).
//
// Three states, in priority order:
//   'probe'      — the service is directly probed (own endpoint) → show its own latest RTT.
//   'inherited'  — the service runs on an already-probed PARENT API (Claude Code→claude, Codex→openai,
//                  via worker PROBE_INHERIT, surfaced as `service.probeInheritedFrom`). It has no own
//                  probe, but its Score's Responsiveness inherits the parent's — so show the PARENT's
//                  current RTT, labeled, instead of a contradictory "Not provided". Stays OUT of the
//                  Latency ranking (not in probeServiceIds) — the distinction lives on the detail card.
//   'statusPage' — neither: fall back to status-page fetch timing (may be null).
//
// Pure + presentation-free (returns kind/rtt/parentName; the component maps those to label/color).

/**
 * @param {object}   service          the ServiceStatus being shown (needs id, latency, probeInheritedFrom)
 * @param {string[]} probeServiceIds  ids with a direct probe snapshot this cycle
 * @param {object}   latestProbe      latest probe snapshot `data` map: { id: { rtt } }
 * @param {object[]} services         all services (to resolve the parent's display name)
 * @returns {{ kind: 'probe'|'inherited'|'statusPage', rtt: number|null, parentName: string|null }}
 */
export function latencyCardState(service, probeServiceIds, latestProbe, services) {
  const isDirectProbe = (probeServiceIds ?? []).includes(service.id)
  const inheritedFrom = service.probeInheritedFrom

  if (!isDirectProbe && inheritedFrom) {
    const parentName = (services ?? []).find((s) => s.id === inheritedFrom)?.name ?? inheritedFrom
    const rtt = latestProbe?.[inheritedFrom]?.rtt
    return { kind: 'inherited', rtt: rtt > 0 ? rtt : null, parentName }
  }
  if (isDirectProbe) {
    return { kind: 'probe', rtt: service.latency ?? null, parentName: null }
  }
  return { kind: 'statusPage', rtt: service.latency ?? null, parentName: null }
}

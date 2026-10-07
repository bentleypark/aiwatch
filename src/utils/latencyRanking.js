// #1633 — the one rule for which services a latency RANKING lists (Latency page + Overview panel).
// Only a directly probed, non-app service has an API RTT to rank. Character.AI is probed but an app
// (#921: detail card only). With no probe snapshot at all (mock/dev) the probe-membership test is
// skipped so the fixture still renders.

export function rankedByLatency(services, probeServiceIds) {
  const ids = probeServiceIds ?? []
  return (services ?? [])
    .filter((s) => s.latency != null && s.category !== 'app' && (ids.length === 0 || ids.includes(s.id)))
    .sort((a, b) => a.latency - b.latency)
}

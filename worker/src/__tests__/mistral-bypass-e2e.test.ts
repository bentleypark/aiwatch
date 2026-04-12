import { describe, it, expect } from 'vitest'
import { isMistralProbedEndpoint, isCorroboratedByProbe, computeMedianRtt } from '../probe'
import type { ProbeSnapshot } from '../probe'

describe('Mistral bypass E2E: live incident titles from 2026-04-12', () => {
  // Real incident titles from Mistral Instatus page
  const liveIncidents = [
    { title: 'Batch API Degraded', startedAt: '2026-04-12T03:29:11.471Z', resolvedAt: null },
    { title: 'Files API Degraded', startedAt: '2026-04-12T02:41:25.723Z', resolvedAt: null },
    { title: 'Batch API Degraded', startedAt: '2026-04-12T01:13:49.214Z', resolvedAt: '2026-04-12T01:42:59.144Z' },
    { title: 'Files API Degraded', startedAt: '2026-04-12T01:11:33.266Z', resolvedAt: '2026-04-12T01:45:49.092Z' },
    { title: 'Completion API Degraded · Chat Completions API', startedAt: '2026-04-11T08:02:00.353Z', resolvedAt: '2026-04-11T09:15:21.084Z' },
  ]

  // Simulate real probe data: normal RTT (no spikes) during incident window
  const probeSnapshots: ProbeSnapshot[] = Array.from({ length: 20 }, (_, i) => ({
    t: new Date(Date.parse('2026-04-12T02:00:00Z') + i * 300_000).toISOString(),
    data: { mistral: { status: 200, rtt: 55 + Math.floor(Math.random() * 20) } },
  }))

  it('Batch API + Files API bypass cross-validation, Completion API gets filtered', () => {
    const medianRtt = computeMedianRtt(probeSnapshots, 'mistral')
    expect(medianRtt).not.toBeNull()

    const filtered = liveIncidents.filter((inc) =>
      !isMistralProbedEndpoint(inc.title) ||
      isCorroboratedByProbe(probeSnapshots, 'mistral', inc.startedAt, inc.resolvedAt ?? null, medianRtt),
    )

    // Batch + Files (4) bypass probe check. Completion (1) has no probes in its window
    // (probes start at 02:00, Completion was 08:02 previous day) → assumed real (conservative)
    expect(filtered).toHaveLength(5)

    // Now add normal probes during the Completion incident window → it gets filtered
    const withCompletionProbes: ProbeSnapshot[] = [
      ...probeSnapshots,
      { t: '2026-04-11T08:05:00Z', data: { mistral: { status: 200, rtt: 60 } } },
      { t: '2026-04-11T08:10:00Z', data: { mistral: { status: 200, rtt: 55 } } },
    ]
    const median2 = computeMedianRtt(withCompletionProbes, 'mistral')
    const filtered2 = liveIncidents.filter((inc) =>
      !isMistralProbedEndpoint(inc.title) ||
      isCorroboratedByProbe(withCompletionProbes, 'mistral', inc.startedAt, inc.resolvedAt ?? null, median2),
    )
    // Completion filtered (normal RTT, no spike), Batch+Files still bypass
    expect(filtered2).toHaveLength(4)
    expect(filtered2.every((inc) => /batch|files/i.test(inc.title))).toBe(true)
  })

  it('with probe spike, Completion API also survives', () => {
    // Add a spike during the Completion API incident window
    const spikedProbes: ProbeSnapshot[] = [
      ...probeSnapshots,
      { t: '2026-04-11T08:05:00Z', data: { mistral: { status: 200, rtt: 2000 } } },
    ]
    const medianRtt = computeMedianRtt(spikedProbes, 'mistral')

    const filtered = liveIncidents.filter((inc) =>
      !isMistralProbedEndpoint(inc.title) ||
      isCorroboratedByProbe(spikedProbes, 'mistral', inc.startedAt, inc.resolvedAt ?? null, medianRtt),
    )

    // All 5 should survive
    expect(filtered).toHaveLength(5)
  })
})

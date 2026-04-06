import { describe, it, expect } from 'vitest'
import { computeProbeSlot, slotToTimestamp, trimSnapshots, hasSlot, failedProbe, PROBE_TARGETS, computeMedianRtt, isCorroboratedByProbe, detectConsecutiveSpikes } from '../probe'
import type { ProbeSnapshot } from '../probe'

describe('computeProbeSlot', () => {
  it('aligns to 5-minute boundaries', () => {
    expect(computeProbeSlot(new Date('2026-03-24T01:03:00Z'))).toBe('2026-03-24T01:00')
    expect(computeProbeSlot(new Date('2026-03-24T01:05:00Z'))).toBe('2026-03-24T01:05')
    expect(computeProbeSlot(new Date('2026-03-24T01:07:30Z'))).toBe('2026-03-24T01:05')
    expect(computeProbeSlot(new Date('2026-03-24T01:14:59Z'))).toBe('2026-03-24T01:10')
    expect(computeProbeSlot(new Date('2026-03-24T01:59:59Z'))).toBe('2026-03-24T01:55')
  })

  it('handles midnight correctly', () => {
    expect(computeProbeSlot(new Date('2026-03-24T00:00:00Z'))).toBe('2026-03-24T00:00')
    expect(computeProbeSlot(new Date('2026-03-24T00:04:59Z'))).toBe('2026-03-24T00:00')
  })
})

describe('slotToTimestamp', () => {
  it('converts slot to ISO timestamp', () => {
    expect(slotToTimestamp('2026-03-24T01:05')).toBe('2026-03-24T01:05:00Z')
    expect(slotToTimestamp('2026-03-24T00:00')).toBe('2026-03-24T00:00:00Z')
  })
})

describe('trimSnapshots', () => {
  it('keeps last N snapshots', () => {
    const snapshots: ProbeSnapshot[] = Array.from({ length: 300 }, (_, i) => ({
      t: `2026-03-24T${String(Math.floor(i / 12)).padStart(2, '0')}:${String((i % 12) * 5).padStart(2, '0')}:00Z`,
      data: { gemini: { status: 403, rtt: 170 } },
    }))
    const trimmed = trimSnapshots(snapshots, 288)
    expect(trimmed).toHaveLength(288)
    expect(trimmed[0].t).toBe(snapshots[12].t) // first 12 removed
  })

  it('returns all when under limit', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-03-24T01:00:00Z', data: { gemini: { status: 403, rtt: 170 } } },
    ]
    expect(trimSnapshots(snapshots, 288)).toHaveLength(1)
  })
})

describe('hasSlot', () => {
  it('detects existing slot', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-03-24T01:00:00Z', data: {} },
      { t: '2026-03-24T01:05:00Z', data: {} },
    ]
    expect(hasSlot(snapshots, '2026-03-24T01:00:00Z')).toBe(true)
    expect(hasSlot(snapshots, '2026-03-24T01:10:00Z')).toBe(false)
  })

  it('returns false for empty array', () => {
    expect(hasSlot([], '2026-03-24T01:00:00Z')).toBe(false)
  })
})

describe('failedProbe', () => {
  it('returns status 0 and rtt -1', () => {
    const result = failedProbe()
    expect(result.status).toBe(0)
    expect(result.rtt).toBe(-1)
  })
})

describe('PROBE_TARGETS', () => {
  const EXPECTED_IDS = [
    'claude', 'openai', 'gemini', 'mistral', 'cohere', 'groq', 'together',
    'fireworks', 'perplexity', 'huggingface', 'replicate', 'elevenlabs', 'xai', 'deepseek',
    'openrouter', 'stability', 'assemblyai', 'deepgram', 'voyageai',
  ]

  it('has all 19 API service probe targets', () => {
    expect(PROBE_TARGETS).toHaveLength(19)
    const ids = PROBE_TARGETS.map((t) => t.id)
    for (const expected of EXPECTED_IDS) {
      expect(ids).toContain(expected)
    }
  })

  it('all targets have valid HTTPS URLs', () => {
    for (const target of PROBE_TARGETS) {
      expect(target.id).toBeTruthy()
      expect(target.url).toMatch(/^https:\/\//)
    }
  })

  it('has no duplicate IDs', () => {
    const ids = PROBE_TARGETS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has no duplicate URLs', () => {
    const urls = PROBE_TARGETS.map((t) => t.url)
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe('computeMedianRtt', () => {
  it('returns median RTT for a service', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-03-24T01:00:00Z', data: { mistral: { status: 401, rtt: 100 } } },
      { t: '2026-03-24T01:05:00Z', data: { mistral: { status: 401, rtt: 200 } } },
      { t: '2026-03-24T01:10:00Z', data: { mistral: { status: 401, rtt: 300 } } },
    ]
    expect(computeMedianRtt(snapshots, 'mistral')).toBe(200)
  })

  it('ignores failed probes (rtt=-1)', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-03-24T01:00:00Z', data: { mistral: { status: 0, rtt: -1 } } },
      { t: '2026-03-24T01:05:00Z', data: { mistral: { status: 401, rtt: 150 } } },
      { t: '2026-03-24T01:10:00Z', data: { mistral: { status: 401, rtt: 250 } } },
    ]
    expect(computeMedianRtt(snapshots, 'mistral')).toBe(250) // median of [150, 250] → index 1
  })

  it('returns null when no valid probes exist', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-03-24T01:00:00Z', data: { gemini: { status: 403, rtt: 50 } } },
    ]
    expect(computeMedianRtt(snapshots, 'mistral')).toBeNull()
  })

  it('returns null for empty snapshots', () => {
    expect(computeMedianRtt([], 'mistral')).toBeNull()
  })
})

describe('isCorroboratedByProbe', () => {
  const baseSnapshots: ProbeSnapshot[] = [
    { t: '2026-03-24T01:00:00Z', data: { mistral: { status: 401, rtt: 180 } } },
    { t: '2026-03-24T01:05:00Z', data: { mistral: { status: 401, rtt: 190 } } },
    { t: '2026-03-24T01:10:00Z', data: { mistral: { status: 401, rtt: 170 } } },
    { t: '2026-03-24T01:15:00Z', data: { mistral: { status: 401, rtt: 185 } } },
  ]
  const medianRtt = 185 // median of [170, 180, 185, 190]

  it('returns false when no RTT spike in incident window (noise)', () => {
    // Incident at 01:07 — probes at 01:05 (190ms) and 01:10 (170ms) are normal
    expect(isCorroboratedByProbe(
      baseSnapshots, 'mistral',
      '2026-03-24T01:07:00Z', '2026-03-24T01:07:30Z',
      medianRtt,
    )).toBe(false)
  })

  it('returns true when RTT spike detected (real outage)', () => {
    const spikeSnapshots: ProbeSnapshot[] = [
      ...baseSnapshots,
      { t: '2026-03-24T01:20:00Z', data: { mistral: { status: 401, rtt: 800 } } }, // spike > 3x median
    ]
    expect(isCorroboratedByProbe(
      spikeSnapshots, 'mistral',
      '2026-03-24T01:18:00Z', '2026-03-24T01:22:00Z',
      medianRtt,
    )).toBe(true)
  })

  it('returns true when probe failed (rtt=-1)', () => {
    const failSnapshots: ProbeSnapshot[] = [
      ...baseSnapshots,
      { t: '2026-03-24T01:20:00Z', data: { mistral: { status: 0, rtt: -1 } } },
    ]
    expect(isCorroboratedByProbe(
      failSnapshots, 'mistral',
      '2026-03-24T01:18:00Z', '2026-03-24T01:22:00Z',
      medianRtt,
    )).toBe(true)
  })

  it('returns true when no probes in window (conservative)', () => {
    // Incident at 02:00 — no probes exist around that time
    expect(isCorroboratedByProbe(
      baseSnapshots, 'mistral',
      '2026-03-24T02:00:00Z', '2026-03-24T02:01:00Z',
      medianRtt,
    )).toBe(true)
  })

  it('returns true when median is null (no baseline)', () => {
    expect(isCorroboratedByProbe(
      baseSnapshots, 'mistral',
      '2026-03-24T01:07:00Z', '2026-03-24T01:07:30Z',
      null,
    )).toBe(true)
  })

  it('returns true when incidentStart is invalid date', () => {
    expect(isCorroboratedByProbe(
      baseSnapshots, 'mistral',
      'not-a-date', null,
      medianRtt,
    )).toBe(true)
  })

  it('returns true when incidentEnd is invalid date', () => {
    expect(isCorroboratedByProbe(
      baseSnapshots, 'mistral',
      '2026-03-24T01:07:00Z', 'bad-date',
      medianRtt,
    )).toBe(true)
  })

  it('returns true when incidentEnd is null (ongoing)', () => {
    // Ongoing incident — window is start ± 10min
    const spikeSnapshots: ProbeSnapshot[] = [
      ...baseSnapshots,
      { t: '2026-03-24T01:20:00Z', data: { mistral: { status: 401, rtt: 700 } } },
    ]
    expect(isCorroboratedByProbe(
      spikeSnapshots, 'mistral',
      '2026-03-24T01:18:00Z', null,
      medianRtt,
    )).toBe(true)
  })

  it('returns false when service probes exist but all normal', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-03-24T01:05:00Z', data: { gemini: { status: 403, rtt: 50 } } },
      { t: '2026-03-24T01:10:00Z', data: { gemini: { status: 403, rtt: 45 } } },
    ]
    expect(isCorroboratedByProbe(
      snapshots, 'gemini',
      '2026-03-24T01:03:00Z', '2026-03-24T01:12:00Z',
      47, // median
    )).toBe(false) // 50 < 141 (3x47) and 45 < 141
  })
})

describe('Mistral noise filtering pipeline (#91)', () => {
  // Simulates the filtering logic in /api/status handler:
  // compute median → filter incidents where isCorroboratedByProbe is false
  const probeSnapshots: ProbeSnapshot[] = [
    // Baseline: ~170ms median (20 normal probes)
    ...Array.from({ length: 20 }, (_, i) => ({
      t: `2026-04-05T${String(12 + Math.floor(i * 5 / 60)).padStart(2, '0')}:${String((i * 5) % 60).padStart(2, '0')}:00Z`,
      data: { mistral: { status: 401, rtt: 160 + (i % 5) * 5 } }, // 160-180ms
    })),
    // Spike at 13:40 (600ms — real outage)
    { t: '2026-04-05T13:40:00Z', data: { mistral: { status: 401, rtt: 600 } } },
    // Normal at 17:55 (170ms — no spike during noise incident)
    { t: '2026-04-05T17:55:00Z', data: { mistral: { status: 401, rtt: 170 } } },
    { t: '2026-04-05T18:00:00Z', data: { mistral: { status: 401, rtt: 165 } } },
  ]

  function filterMistralIncidents(incidents: { id: string; title: string; startedAt: string; resolvedAt: string | null }[]) {
    const median = computeMedianRtt(probeSnapshots, 'mistral')
    if (median === null) return incidents
    return incidents.filter((inc) =>
      isCorroboratedByProbe(probeSnapshots, 'mistral', inc.startedAt, inc.resolvedAt, median),
    )
  }

  it('filters noise incidents with no RTT spike', () => {
    const incidents = [
      { id: 'noise-1', title: 'Completion API Degraded', startedAt: '2026-04-05T17:53:00Z', resolvedAt: '2026-04-05T17:56:00Z' },
    ]
    expect(filterMistralIncidents(incidents)).toHaveLength(0)
  })

  it('keeps real incidents with RTT spike', () => {
    const incidents = [
      { id: 'real-1', title: 'Audio API Degraded', startedAt: '2026-04-05T13:35:00Z', resolvedAt: '2026-04-05T13:50:00Z' },
    ]
    const result = filterMistralIncidents(incidents)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('real-1')
  })

  it('filters mixed noise and real incidents correctly', () => {
    const incidents = [
      { id: 'real-1', title: 'Audio API Degraded', startedAt: '2026-04-05T13:35:00Z', resolvedAt: '2026-04-05T13:50:00Z' },
      { id: 'noise-1', title: 'Completion API Degraded', startedAt: '2026-04-05T17:53:00Z', resolvedAt: '2026-04-05T17:56:00Z' },
      { id: 'noise-2', title: 'Audio API TTS Degraded', startedAt: '2026-04-05T17:58:00Z', resolvedAt: '2026-04-05T18:01:00Z' },
    ]
    const result = filterMistralIncidents(incidents)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('real-1')
  })

  it('keeps all incidents when no probe data exists', () => {
    const emptyProbes: ProbeSnapshot[] = []
    const median = computeMedianRtt(emptyProbes, 'mistral')
    expect(median).toBeNull()
    const incidents = [
      { id: 'inc-1', title: 'API Degraded', startedAt: '2026-04-05T17:53:00Z', resolvedAt: '2026-04-05T17:56:00Z' },
    ]
    // When median is null, all incidents pass through (conservative — no filtering without baseline)
    const result = incidents.filter((inc) => {
      if (median === null) return true
      return isCorroboratedByProbe(emptyProbes, 'mistral', inc.startedAt, inc.resolvedAt, median)
    })
    expect(result).toHaveLength(1)
  })

  it('does not affect non-mistral services', () => {
    // Probe data only has mistral — computing median for other services returns null
    const otherMedian = computeMedianRtt(probeSnapshots, 'openai')
    expect(otherMedian).toBeNull()
  })
})

describe('detectConsecutiveSpikes', () => {
  it('detects 3+ consecutive spikes at tail', () => {
    // Enough baseline to keep median low (~50ms), so threshold ~150ms
    const snapshots: ProbeSnapshot[] = Array.from({ length: 10 }, (_, i) => ({
      t: `2026-03-24T00:${String(i * 5).padStart(2, '0')}:00Z`,
      data: { gemini: { status: 403, rtt: 45 + (i % 3) * 5 } }, // 45-55ms baseline
    }))
    // 3 consecutive spikes well above threshold
    snapshots.push(
      { t: '2026-03-24T01:00:00Z', data: { gemini: { status: 403, rtt: 200 } } },
      { t: '2026-03-24T01:05:00Z', data: { gemini: { status: 403, rtt: 250 } } },
      { t: '2026-03-24T01:10:00Z', data: { gemini: { status: 403, rtt: 300 } } },
    )
    const spikes = detectConsecutiveSpikes(snapshots, ['gemini'], 3)
    expect(spikes).toHaveLength(1)
    expect(spikes[0].serviceId).toBe('gemini')
    expect(spikes[0].consecutiveCount).toBe(3)
    expect(spikes[0].since).toBe('2026-03-24T01:00:00Z')
    expect(spikes[0].avgRtt).toBe(250) // (200+250+300)/3
  })

  it('returns empty when streak is below threshold', () => {
    const snapshots: ProbeSnapshot[] = Array.from({ length: 10 }, (_, i) => ({
      t: `2026-03-24T00:${String(i * 5).padStart(2, '0')}:00Z`,
      data: { gemini: { status: 403, rtt: 50 } },
    }))
    // Only 2 spikes — below minConsecutive=3
    snapshots.push(
      { t: '2026-03-24T01:00:00Z', data: { gemini: { status: 403, rtt: 200 } } },
      { t: '2026-03-24T01:05:00Z', data: { gemini: { status: 403, rtt: 250 } } },
    )
    expect(detectConsecutiveSpikes(snapshots, ['gemini'], 3)).toHaveLength(0)
  })

  it('streak broken by normal probe', () => {
    const snapshots: ProbeSnapshot[] = Array.from({ length: 10 }, (_, i) => ({
      t: `2026-03-24T00:${String(i * 5).padStart(2, '0')}:00Z`,
      data: { gemini: { status: 403, rtt: 50 } },
    }))
    snapshots.push(
      { t: '2026-03-24T01:00:00Z', data: { gemini: { status: 403, rtt: 200 } } },
      { t: '2026-03-24T01:05:00Z', data: { gemini: { status: 403, rtt: 40 } } }, // normal — breaks streak
      { t: '2026-03-24T01:10:00Z', data: { gemini: { status: 403, rtt: 200 } } },
      { t: '2026-03-24T01:15:00Z', data: { gemini: { status: 403, rtt: 250 } } },
    )
    // Only 2 at tail after break
    expect(detectConsecutiveSpikes(snapshots, ['gemini'], 3)).toHaveLength(0)
  })

  it('counts failed probes (rtt=-1) as spikes', () => {
    const snapshots: ProbeSnapshot[] = Array.from({ length: 10 }, (_, i) => ({
      t: `2026-03-24T00:${String(i * 5).padStart(2, '0')}:00Z`,
      data: { gemini: { status: 403, rtt: 50 } },
    }))
    snapshots.push(
      { t: '2026-03-24T01:00:00Z', data: { gemini: { status: 0, rtt: -1 } } },
      { t: '2026-03-24T01:05:00Z', data: { gemini: { status: 0, rtt: -1 } } },
      { t: '2026-03-24T01:10:00Z', data: { gemini: { status: 0, rtt: -1 } } },
    )
    const spikes = detectConsecutiveSpikes(snapshots, ['gemini'], 3)
    expect(spikes).toHaveLength(1)
    expect(spikes[0].consecutiveCount).toBe(3)
    expect(spikes[0].avgRtt).toBe(0) // all failed, no positive rtt
  })

  it('handles multiple services independently', () => {
    // Need enough baseline to keep median low despite spike values
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-03-24T00:00:00Z', data: { gemini: { status: 403, rtt: 50 }, mistral: { status: 401, rtt: 180 } } },
      { t: '2026-03-24T00:05:00Z', data: { gemini: { status: 403, rtt: 45 }, mistral: { status: 401, rtt: 190 } } },
      { t: '2026-03-24T00:10:00Z', data: { gemini: { status: 403, rtt: 48 }, mistral: { status: 401, rtt: 185 } } },
      { t: '2026-03-24T00:15:00Z', data: { gemini: { status: 403, rtt: 52 }, mistral: { status: 401, rtt: 175 } } },
      { t: '2026-03-24T00:20:00Z', data: { gemini: { status: 403, rtt: 47 }, mistral: { status: 401, rtt: 180 } } },
      { t: '2026-03-24T00:25:00Z', data: { gemini: { status: 403, rtt: 51 }, mistral: { status: 401, rtt: 188 } } },
      { t: '2026-03-24T00:30:00Z', data: { gemini: { status: 403, rtt: 49 }, mistral: { status: 401, rtt: 182 } } },
      // gemini spikes (>3x median ~50 = 150), mistral normal
      { t: '2026-03-24T01:00:00Z', data: { gemini: { status: 403, rtt: 200 }, mistral: { status: 401, rtt: 185 } } },
      { t: '2026-03-24T01:05:00Z', data: { gemini: { status: 403, rtt: 250 }, mistral: { status: 401, rtt: 175 } } },
      { t: '2026-03-24T01:10:00Z', data: { gemini: { status: 403, rtt: 300 }, mistral: { status: 401, rtt: 180 } } },
    ]
    const spikes = detectConsecutiveSpikes(snapshots, ['gemini', 'mistral'], 3)
    expect(spikes).toHaveLength(1)
    expect(spikes[0].serviceId).toBe('gemini')
  })

  it('returns empty for empty snapshots', () => {
    expect(detectConsecutiveSpikes([], ['gemini'], 3)).toHaveLength(0)
  })

  it('detects spikes across many services independently', () => {
    const serviceIds = ['claude', 'openai', 'gemini', 'groq', 'deepseek']
    // 10 baseline snapshots: all services ~50ms
    const snapshots: ProbeSnapshot[] = Array.from({ length: 10 }, (_, i) => ({
      t: `2026-03-24T00:${String(i * 5).padStart(2, '0')}:00Z`,
      data: Object.fromEntries(serviceIds.map(id => [id, { status: 401, rtt: 50 }])),
    }))
    // 3 spike snapshots: only claude and deepseek spike, others normal
    for (let i = 0; i < 3; i++) {
      snapshots.push({
        t: `2026-03-24T01:${String(i * 5).padStart(2, '0')}:00Z`,
        data: {
          claude: { status: 405, rtt: 500 },
          openai: { status: 401, rtt: 55 },
          gemini: { status: 403, rtt: 48 },
          groq: { status: 401, rtt: 52 },
          deepseek: { status: 0, rtt: -1 },
        },
      })
    }
    const spikes = detectConsecutiveSpikes(snapshots, serviceIds, 3)
    expect(spikes).toHaveLength(2)
    const spikeIds = spikes.map(s => s.serviceId).sort()
    expect(spikeIds).toEqual(['claude', 'deepseek'])
  })

  it('handles service with no data in snapshots', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-03-24T01:00:00Z', data: { gemini: { status: 403, rtt: 50 } } },
    ]
    // 'stability' has no data in any snapshot
    const spikes = detectConsecutiveSpikes(snapshots, ['gemini', 'stability'], 3)
    expect(spikes).toHaveLength(0)
  })
})

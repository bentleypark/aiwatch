import { describe, it, expect } from 'vitest'
import { computeProbeSlot, slotToTimestamp, trimSnapshots, hasSlot, failedProbe, PROBE_TARGETS, computeMedianRtt, detectConsecutiveSpikes, isProbeHealthy } from '../probe'
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
    'fireworks', 'cerebras', 'perplexity', 'huggingface', 'replicate', 'fal', 'elevenlabs', 'xai', 'deepseek',
    'openrouter', 'stability', 'bfl', 'assemblyai', 'deepgram', 'voyageai',
    'pinecone', 'langsmith', 'runway', 'luma', // #678 — added (stable representative API path)
  ]

  it('has all 28 API service probe targets', () => {
    expect(PROBE_TARGETS).toHaveLength(28)
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

// `isCorroboratedByProbe` and the `Mistral noise filtering pipeline` describe blocks were
// removed in #373 alongside the corroboration code itself. Same-title incident grouping in
// `src/utils/incidentGrouping.js` now consolidates auto-monitoring noise uniformly across
// services; no probe-based incident-list filter remains in the read path. (Probe-based
// fetch-failure cross-validation in services.ts — "status page down + probe healthy → hold
// operational" — is a different surviving mechanism.)


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

describe('isProbeHealthy', () => {
  const now = Date.now()
  const recentTime = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString()

  it('returns true when recent probes show normal RTT', () => {
    const snapshots: ProbeSnapshot[] = Array.from({ length: 10 }, (_, i) => ({
      t: recentTime(i * 5), // 0, 5, 10, ... minutes ago
      data: { claude: { status: 200, rtt: 200 + i * 5 } },
    }))
    expect(isProbeHealthy(snapshots, 'claude')).toBe(true)
  })

  it('returns true when only 1 of 3 recent probes has an RTT spike (majority healthy)', () => {
    // Majority rule: 2/3 healthy → healthy. A single transient spike is noise, not evidence
    // of genuine degradation. Previously "every" required all probes healthy, which caused
    // false-positive degraded alerts for services with structural status page failures (#507).
    const snapshots: ProbeSnapshot[] = [
      { t: recentTime(0), data: { claude: { status: 200, rtt: 2000 } } }, // spike (1 of 3 recent)
      { t: recentTime(5), data: { claude: { status: 200, rtt: 200 } } },
      { t: recentTime(10), data: { claude: { status: 200, rtt: 210 } } },
      { t: recentTime(20), data: { claude: { status: 200, rtt: 205 } } }, // outside 15-min window
    ]
    expect(isProbeHealthy(snapshots, 'claude')).toBe(true)
  })

  it('returns false when 2 of 3 recent probes have RTT spikes (majority unhealthy)', () => {
    // Establish a healthy median baseline via historical probes (outside the 15-min window),
    // then have 2 of 3 recent probes spike above 3× that median.
    const historical = Array.from({ length: 6 }, (_, i) => ({
      t: recentTime(20 + i * 5), // 20–45 min ago — outside 15-min recent window
      data: { claude: { status: 200, rtt: 200 } },
    }))
    const recent: ProbeSnapshot[] = [
      { t: recentTime(0), data: { claude: { status: 200, rtt: 800 } } }, // >3×200 → spike
      { t: recentTime(5), data: { claude: { status: 200, rtt: 750 } } }, // >3×200 → spike
      { t: recentTime(10), data: { claude: { status: 200, rtt: 210 } } },
    ]
    expect(isProbeHealthy([...recent, ...historical], 'claude')).toBe(false)
  })

  it('returns true when only 1 of 3 recent probes has a failure rtt=-1 (majority healthy)', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: recentTime(0), data: { claude: { status: 0, rtt: -1 } } },  // 1 failure
      { t: recentTime(5), data: { claude: { status: 200, rtt: 200 } } },
      { t: recentTime(10), data: { claude: { status: 200, rtt: 210 } } },
    ]
    expect(isProbeHealthy(snapshots, 'claude')).toBe(true)
  })

  it('returns false when 2 of 3 recent probes have failures rtt=-1 (majority unhealthy)', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: recentTime(0), data: { claude: { status: 0, rtt: -1 } } },
      { t: recentTime(5), data: { claude: { status: 0, rtt: -1 } } },
      { t: recentTime(10), data: { claude: { status: 200, rtt: 200 } } },
    ]
    expect(isProbeHealthy(snapshots, 'claude')).toBe(false)
  })

  it('returns false when no snapshots exist', () => {
    expect(isProbeHealthy([], 'claude')).toBe(false)
  })

  it('returns false when service has no data in recent snapshots', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: recentTime(0), data: { openai: { status: 200, rtt: 200 } } },
      { t: recentTime(5), data: { openai: { status: 200, rtt: 210 } } },
    ]
    expect(isProbeHealthy(snapshots, 'claude')).toBe(false)
  })

  it('returns false when fewer than 2 recent probes', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: recentTime(0), data: { claude: { status: 200, rtt: 200 } } },
    ]
    expect(isProbeHealthy(snapshots, 'claude')).toBe(false)
  })

  it('returns false when probes are too old', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: recentTime(20), data: { claude: { status: 200, rtt: 200 } } },
      { t: recentTime(25), data: { claude: { status: 200, rtt: 210 } } },
    ]
    expect(isProbeHealthy(snapshots, 'claude', 900_000)).toBe(false) // 15min max age
  })
})

// `isMistralProbedEndpoint` describe block was removed in #373 alongside the function itself.
// The Mistral-only endpoint allow/deny list is no longer needed: same-title incident grouping
// in `src/utils/incidentGrouping.js` consolidates noise uniformly across all services.

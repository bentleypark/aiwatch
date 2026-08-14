import { describe, it, expect } from 'vitest'
import { computeProbeSlot, slotToTimestamp, trimSnapshots, hasSlot, failedProbe, PROBE_TARGETS, PROBE_INHERIT, resolveProbeId, computeMedianRtt, detectConsecutiveSpikes, isProbeHealthy, isProbeFailing, PROBE_FAILING_FLOOR_MS } from '../probe'
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
    'kimi', // #989 — Moonshot AI, api.moonshot.ai/v1/models (401, no auth for RTT)
    'openrouter', 'stability', 'bfl', 'assemblyai', 'deepgram', 'voyageai', 'twelvelabs',
    'pinecone', 'langsmith', 'runway', 'luma', // #678 — added (stable representative API path)
    'turbopuffer', // #857 — no official uptime, probe is the sole measured signal
    'cursor', // #883 — coding agent with its own API infra (api2.cursor.sh), independent signal
    'characterai', // #921 — app whose Statuspage died (#689/#800); neo.character.ai/health backend probe
  ]

  it('has all 33 probe targets', () => {
    expect(PROBE_TARGETS).toHaveLength(33)
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

  it('probes cursor directly (own infra, not inherited)', () => {
    const cursor = PROBE_TARGETS.find((t) => t.id === 'cursor')
    expect(cursor?.url).toBe('https://api2.cursor.sh/')
    expect(PROBE_INHERIT.cursor).toBeUndefined() // #883 — cursor is directly probed, never inherits
  })

  it('probes characterai on its backend health endpoint (#921 — Statuspage dead)', () => {
    const ca = PROBE_TARGETS.find((t) => t.id === 'characterai')
    expect(ca?.url).toBe('https://neo.character.ai/health')
    expect(PROBE_INHERIT.characterai).toBeUndefined() // directly probed, own infra
  })
})

describe('resolveProbeId (#883 parent-probe inheritance)', () => {
  it('maps Claude Code → claude and Codex → openai (endpoint-sharing pairs)', () => {
    expect(resolveProbeId('claudecode')).toBe('claude')
    expect(resolveProbeId('codex')).toBe('openai')
  })

  it('is identity for directly-probed and non-inheriting services', () => {
    for (const id of ['claude', 'openai', 'cursor', 'gemini', 'bedrock', 'chatgpt']) {
      expect(resolveProbeId(id)).toBe(id)
    }
  })

  it('every inherited parent is itself an actual probe target (no dangling inheritance)', () => {
    const probedIds = new Set(PROBE_TARGETS.map((t) => t.id))
    for (const parent of Object.values(PROBE_INHERIT)) {
      expect(probedIds.has(parent)).toBe(true)
    }
  })

  it('no service both inherits AND is directly probed (would be a redundant probe)', () => {
    const probedIds = new Set(PROBE_TARGETS.map((t) => t.id))
    for (const child of Object.keys(PROBE_INHERIT)) {
      expect(probedIds.has(child)).toBe(false)
    }
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

  // #1232 — a healthy verdict FORCES a fetch-failed service back to `operational`, so what counts as
  // a healthy sample has to survive the response code, not just the clock.
  it('returns false when the majority of recent probes answer 5xx, however fast', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: recentTime(0), data: { claude: { status: 503, rtt: 80 } } },
      { t: recentTime(5), data: { claude: { status: 500, rtt: 75 } } },
      { t: recentTime(10), data: { claude: { status: 200, rtt: 80 } } },
    ]
    expect(isProbeHealthy(snapshots, 'claude')).toBe(false)
  })

  it('keeps the majority rule: a single 5xx among three is still noise', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: recentTime(0), data: { claude: { status: 503, rtt: 80 } } },
      { t: recentTime(5), data: { claude: { status: 200, rtt: 80 } } },
      { t: recentTime(10), data: { claude: { status: 200, rtt: 75 } } },
    ]
    expect(isProbeHealthy(snapshots, 'claude')).toBe(true)
  })

  it('counts unauthenticated 4xx answers as healthy — the bar is >= 500, not non-2xx', () => {
    // Why the bar is not "non-2xx": most probe targets are hit without credentials.
    const snapshots: ProbeSnapshot[] = [
      { t: recentTime(0), data: { claude: { status: 401, rtt: 80 } } },
      { t: recentTime(5), data: { claude: { status: 403, rtt: 75 } } },
      { t: recentTime(10), data: { claude: { status: 405, rtt: 80 } } },
      { t: recentTime(12), data: { claude: { status: 422, rtt: 78 } } },
    ]
    expect(isProbeHealthy(snapshots, 'claude')).toBe(true)
  })
})

describe('isProbeFailing — the absolute floor under the slow-sample bar', () => {
  const now = Date.now()
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString()

  // A synthetic FAST service: 6 historical samples (outside the 15-min recent window) at 67ms, so the
  // bare `median × 3` bar alone would sit at 201ms and the floor governs instead. Deliberately not
  // presented as a production median — `isProbeFailing` medians raw snapshots, while the figures in
  // `probe:daily` are trimmed (`probe-archival.ts`), so the two are not the same quantity.
  const fastBaseline: ProbeSnapshot[] = Array.from({ length: 6 }, (_, i) => ({
    t: at(20 + i * 5),
    data: { claude: { status: 200, rtt: 67 } },
  }))

  it('ordinary jitter on a fast service no longer contradicts an unreadable source', () => {
    // Against the bare 201ms bar both of these count as failures, set `probeContradicted`, and
    // suppress the neutral unknown badge — while the service answered every probe successfully in
    // under a quarter-second. This is the regression the floor exists to stop.
    const recent: ProbeSnapshot[] = [
      { t: at(0), data: { claude: { status: 200, rtt: 230 } } },
      { t: at(5), data: { claude: { status: 200, rtt: 210 } } },
    ]
    expect(isProbeFailing([...recent, ...fastBaseline], 'claude')).toBe(false)
  })

  it('still contradicts when a fast service is genuinely slow (past the floor)', () => {
    const recent: ProbeSnapshot[] = [
      { t: at(0), data: { claude: { status: 200, rtt: 4000 } } },
      { t: at(5), data: { claude: { status: 200, rtt: 3500 } } },
    ]
    expect(isProbeFailing([...recent, ...fastBaseline], 'claude')).toBe(true)
  })

  it('the floor is exclusive: a sample exactly at it is not a failure, one over it is', () => {
    // The docstring's contract is that a response inside a second is not evidence, so `>` (not `>=`)
    // is load-bearing. Without this the comparison can be loosened with the suite still green.
    const atFloor: ProbeSnapshot[] = [0, 5].map((m) => ({ t: at(m), data: { claude: { status: 200, rtt: PROBE_FAILING_FLOOR_MS } } }))
    const overFloor: ProbeSnapshot[] = [0, 5].map((m) => ({ t: at(m), data: { claude: { status: 200, rtt: PROBE_FAILING_FLOOR_MS + 1 } } }))
    expect(isProbeFailing([...atFloor, ...fastBaseline], 'claude')).toBe(false)
    expect(isProbeFailing([...overFloor, ...fastBaseline], 'claude')).toBe(true)
  })

  it('999ms on a fast service is not a failure — the literal "inside a second" contract', () => {
    // The boundary case above is built out of the constant itself, so it holds for ANY value. This one
    // is a literal: it fails if the floor is lowered (a 300ms floor was verified to pass the whole
    // suite otherwise), which is what stops the docstring's "inside a second" wording drifting away
    // from the number it describes.
    const justUnder: ProbeSnapshot[] = [0, 5].map((m) => ({ t: at(m), data: { claude: { status: 200, rtt: 999 } } }))
    // The literal only means anything while the fixture's own multiplicative bar stays under it —
    // otherwise a deleted floor would leave this green. Tie the two together rather than trusting a
    // baseline defined 30 lines away.
    expect((computeMedianRtt([...justUnder, ...fastBaseline], 'claude') ?? 0) * 3).toBeLessThan(999)
    expect(isProbeFailing([...justUnder, ...fastBaseline], 'claude')).toBe(false)
  })

  it('no input is ever BOTH an all-clear and an outage claim', () => {
    // `services.ts` resolves the two predicates as `if (healthy) … else if (failing)`, so an input
    // that satisfied both would be settled silently in favour of the all-clear — the one direction
    // this floor exists to argue against. A round-2 attempt to add a `status >= 500` clause here DID
    // create such an input (a fast 5xx read as healthy AND failing), which is what this pins against.
    // Both regimes are covered deliberately: the floor binds on a fast service, and `median × 3`
    // governs on a slow one.
    const fastCases: ProbeSnapshot[][] = [
      [0, 5].map((m) => ({ t: at(m), data: { claude: { status: 200, rtt: 230 } } })),   // jitter
      [0, 5].map((m) => ({ t: at(m), data: { claude: { status: 503, rtt: 80 } } })),    // fast 5xx
      [0, 5].map((m) => ({ t: at(m), data: { claude: { status: 200, rtt: 4000 } } })),  // real spike
      [0, 5].map((m) => ({ t: at(m), data: { claude: { status: 0, rtt: -1 } } })),      // hard failure
      [0, 5].map((m) => ({ t: at(m), data: { claude: { status: 401, rtt: 80 } } })),    // normal 4xx
      [0, 5].map((m) => ({ t: at(m), data: { claude: { status: 200, rtt: PROBE_FAILING_FLOOR_MS } } })),
    ]
    for (const recent of fastCases) {
      const snaps = [...recent, ...fastBaseline]
      expect(isProbeHealthy(snaps, 'claude') && isProbeFailing(snaps, 'claude')).toBe(false)
    }

    // Slow regime: median 500 → `median × 3` = 1500, above the floor, and 1200ms sits in the gap
    // between the two bars. Inverting the floor (`Math.max` → `Math.min`) makes this input BOTH —
    // the fast cases above stay green through that mutation, so without this row the comment's claim
    // has no test behind it in the one regime where it can fail.
    const slowBaseline: ProbeSnapshot[] = Array.from({ length: 6 }, (_, i) => ({
      t: at(20 + i * 5),
      data: { slowsvc: { status: 200, rtt: 500 } },
    }))
    const slowRecent: ProbeSnapshot[] = [0, 5].map((m) => ({ t: at(m), data: { slowsvc: { status: 200, rtt: 1200 } } }))
    const slowSnaps = [...slowRecent, ...slowBaseline]
    expect(isProbeHealthy(slowSnaps, 'slowsvc') && isProbeFailing(slowSnaps, 'slowsvc')).toBe(false)
  })

  it('an all-failed probe is unaffected — the floor gates only the slow-but-SUCCEEDED clause', () => {
    // `rtt <= 0` (what failedProbe() writes) is a separate predicate, so a service we cannot reach at
    // all still contradicts however fast it normally is. Losing this would gut the #1004 guard.
    const recent: ProbeSnapshot[] = [
      { t: at(0), data: { claude: { status: 0, rtt: -1 } } },
      { t: at(5), data: { claude: { status: 0, rtt: -1 } } },
    ]
    expect(isProbeFailing([...recent, ...fastBaseline], 'claude')).toBe(true)
  })

  it('MIXED hard-failure + jitter no longer contradicts on a fast service — the accepted cost', () => {
    // A real behaviour change, pinned so it is a decision rather than a surprise: one hard failure
    // alongside successful-but-jittery samples used to clear the 2/3 majority only because those
    // samples were themselves miscounted as failures against the 201ms bar. With the floor they are
    // not, so a single failure no longer carries the verdict alone. A genuine majority still does.
    // Both sets are 3 recent samples so the ONLY thing varying is how many of them actually failed.
    const oneFailure: ProbeSnapshot[] = [
      { t: at(0), data: { claude: { status: 0, rtt: -1 } } },
      { t: at(5), data: { claude: { status: 200, rtt: 230 } } },
      { t: at(10), data: { claude: { status: 200, rtt: 210 } } },
    ]
    const failureMajority: ProbeSnapshot[] = [
      { t: at(0), data: { claude: { status: 0, rtt: -1 } } },
      { t: at(5), data: { claude: { status: 0, rtt: -1 } } },
      { t: at(10), data: { claude: { status: 200, rtt: 230 } } },
    ]
    expect(isProbeFailing([...oneFailure, ...fastBaseline], 'claude')).toBe(false)
    expect(isProbeFailing([...failureMajority, ...fastBaseline], 'claude')).toBe(true)
  })

  it('the floor RAISES the bar and never lowers it — a slow service keeps its multiplicative bar', () => {
    // A synthetic SLOW service: median 500 → `median × 3` = 1500, already above the floor, so the
    // floor must be inert and 1200ms must still read as normal. A `Math.min` would call this failing
    // and manufacture outages on the slowest services. Pins the direction, not the value.
    const slowBaseline: ProbeSnapshot[] = Array.from({ length: 6 }, (_, i) => ({
      t: at(20 + i * 5),
      data: { slowsvc: { status: 200, rtt: 500 } },
    }))
    const recent: ProbeSnapshot[] = [
      { t: at(0), data: { slowsvc: { status: 200, rtt: 1200 } } },
      { t: at(5), data: { slowsvc: { status: 200, rtt: 1200 } } },
    ]
    expect(PROBE_FAILING_FLOOR_MS).toBeLessThan(500 * 3)
    expect(isProbeFailing([...recent, ...slowBaseline], 'slowsvc')).toBe(false)
  })

  it('isProbeHealthy is deliberately NOT floored — the band between the two bars is the point', () => {
    // The same samples are neither an all-clear nor an outage claim. `isProbeHealthy` forces a
    // fetch-failed service back to `operational` (services.ts), so floor it too and a 230ms sample on
    // a 67ms service would publish GREEN off a status source we admittedly could not read. Leaving it
    // unfloored keeps that verdict at "not enough evidence" → the neutral unknown badge (#1004).
    // A future refactor that "makes them symmetric" has to delete this test to do it.
    const recent: ProbeSnapshot[] = [
      { t: at(0), data: { claude: { status: 200, rtt: 230 } } },
      { t: at(5), data: { claude: { status: 200, rtt: 210 } } },
    ]
    const snaps = [...recent, ...fastBaseline]
    expect(isProbeHealthy(snaps, 'claude')).toBe(false)
    expect(isProbeFailing(snaps, 'claude')).toBe(false)
  })
})

// `isMistralProbedEndpoint` describe block was removed in #373 alongside the function itself.
// The Mistral-only endpoint allow/deny list is no longer needed: same-title incident grouping
// in `src/utils/incidentGrouping.js` consolidates noise uniformly across all services.

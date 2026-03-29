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
  it('has gemini and mistral as probe targets', () => {
    expect(PROBE_TARGETS).toHaveLength(2)
    expect(PROBE_TARGETS[0].id).toBe('gemini')
    expect(PROBE_TARGETS[0].url).toContain('generativelanguage.googleapis.com')
    expect(PROBE_TARGETS[1].id).toBe('mistral')
    expect(PROBE_TARGETS[1].url).toContain('api.mistral.ai')
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
})

import { describe, it, expect } from 'vitest'
import { computeProbeSlot, slotToTimestamp, trimSnapshots, hasSlot, failedProbe, PROBE_TARGETS } from '../probe'
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

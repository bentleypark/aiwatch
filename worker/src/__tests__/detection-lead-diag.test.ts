import { describe, it, expect, vi } from 'vitest'
import {
  classifyLead,
  normalizeDiag,
  appendLeadDiag,
  readLeadDiag,
  formatLeadDiagSection,
  detectionLeadDiagKey,
  computeLeadMs,
  MIN_LEAD_MS,
  MAX_LEAD_MS,
  type LeadDiag,
} from '../detection-lead-log'

function mockKV(store: Record<string, string> = {}) {
  return {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string) => { store[k] = v }),
  } as unknown as KVNamespace
}

const now = new Date('2026-05-26T12:00:00Z')
const official = '2026-05-26T12:00:00Z'
const officialMs = new Date(official).getTime()
const at = (msBefore: number) => new Date(officialMs - msBefore).toISOString()

describe('classifyLead', () => {
  it('no_detected for missing/invalid timestamps', () => {
    expect(classifyLead(null, official)).toBe('no_detected')
    expect(classifyLead(undefined, official)).toBe('no_detected')
    expect(classifyLead('not-a-date', official)).toBe('no_detected')
    expect(classifyLead(at(5 * 60_000), 'not-a-date')).toBe('no_detected')
  })

  it('negative when detected at or after official start', () => {
    expect(classifyLead(official, official)).toBe('negative')                 // diff = 0
    expect(classifyLead(at(-30_000), official)).toBe('negative')              // detected 30s AFTER
  })

  it('below_min for sub-minute leads', () => {
    expect(classifyLead(at(30_000), official)).toBe('below_min')              // 30s
    expect(classifyLead(at(MIN_LEAD_MS - 1), official)).toBe('below_min')     // just under 1m
  })

  it('in_window at the inclusive lower bound and just under the upper bound', () => {
    expect(classifyLead(at(MIN_LEAD_MS), official)).toBe('in_window')         // exactly 1m
    expect(classifyLead(at(7 * 60_000), official)).toBe('in_window')          // 7m
    expect(classifyLead(at(MAX_LEAD_MS - 1), official)).toBe('in_window')     // just under 60m
  })

  it('above_max at and beyond the 60m cap', () => {
    expect(classifyLead(at(MAX_LEAD_MS), official)).toBe('above_max')         // exactly 60m
    expect(classifyLead(at(3 * 60 * 60_000), official)).toBe('above_max')     // 3h (stale marker)
  })

  it('agrees with the recorded window (in_window ⇔ a lead would be audited)', () => {
    // Lock the two functions together at every boundary so they can't drift if the window changes:
    // classifyLead(...) === 'in_window'  ⇔  computeLeadMs(...) !== null
    for (const msBefore of [0, -30_000, 30_000, MIN_LEAD_MS - 1, MIN_LEAD_MS, 7 * 60_000, MAX_LEAD_MS - 1, MAX_LEAD_MS, 3 * 60 * 60_000]) {
      const detectedAt = at(msBefore)
      expect(classifyLead(detectedAt, official) === 'in_window').toBe(computeLeadMs(detectedAt, official) !== null)
    }
  })
})

describe('normalizeDiag', () => {
  it('returns all-zero buckets for non-object / null', () => {
    const z = normalizeDiag(null)
    expect(z).toEqual({
      probe: { no_detected: 0, negative: 0, below_min: 0, in_window: 0, above_max: 0 },
      nonProbe: { no_detected: 0, negative: 0, below_min: 0, in_window: 0, above_max: 0 },
    })
    expect(normalizeDiag('garbage')).toEqual(z)
    expect(normalizeDiag(42)).toEqual(z)
  })

  it('keeps valid counts and drops invalid (negative / NaN / non-number / foreign keys)', () => {
    const out = normalizeDiag({
      probe: { in_window: 3, negative: 2, below_min: -1, above_max: NaN, no_detected: '5', bogus: 9 },
      nonProbe: { negative: 4 },
      extra: { in_window: 99 },
    })
    expect(out.probe).toEqual({ no_detected: 0, negative: 2, below_min: 0, in_window: 3, above_max: 0 })
    expect(out.nonProbe).toEqual({ no_detected: 0, negative: 4, below_min: 0, in_window: 0, above_max: 0 })
  })

  it('floors fractional counts', () => {
    expect(normalizeDiag({ probe: { in_window: 2.9 } }).probe.in_window).toBe(2)
  })
})

describe('appendLeadDiag', () => {
  it('creates the day key and increments the correct group + bucket', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    expect(await appendLeadDiag(kv, 'in_window', true, now)).toBe(true)
    const written = JSON.parse(store[detectionLeadDiagKey(now)]) as LeadDiag
    expect(written.probe.in_window).toBe(1)
    expect(written.nonProbe.in_window).toBe(0)
  })

  it('routes non-probe services to the nonProbe group', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    await appendLeadDiag(kv, 'negative', false, now)
    const written = JSON.parse(store[detectionLeadDiagKey(now)]) as LeadDiag
    expect(written.nonProbe.negative).toBe(1)
    expect(written.probe.negative).toBe(0)
  })

  it('accumulates across multiple calls on the same day', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    await appendLeadDiag(kv, 'negative', true, now)
    await appendLeadDiag(kv, 'negative', true, now)
    await appendLeadDiag(kv, 'no_detected', true, now)
    const written = JSON.parse(store[detectionLeadDiagKey(now)]) as LeadDiag
    expect(written.probe.negative).toBe(2)
    expect(written.probe.no_detected).toBe(1)
  })

  it('skips (returns false) on KV read failure without overwriting', async () => {
    const store: Record<string, string> = { [detectionLeadDiagKey(now)]: JSON.stringify({ probe: { in_window: 5 } }) }
    const kv = {
      get: vi.fn(async () => { throw new Error('KV down') }),
      put: vi.fn(async (k: string, v: string) => { store[k] = v }),
    } as unknown as KVNamespace
    expect(await appendLeadDiag(kv, 'in_window', true, now)).toBe(false)
    expect(kv.put).not.toHaveBeenCalled()
    // prior value untouched
    expect(JSON.parse(store[detectionLeadDiagKey(now)]).probe.in_window).toBe(5)
  })

  it('resets the day on an unparseable existing value rather than aborting', async () => {
    const store: Record<string, string> = { [detectionLeadDiagKey(now)]: '{not json' }
    const kv = mockKV(store)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await appendLeadDiag(kv, 'above_max', true, now)).toBe(true)
    expect(JSON.parse(store[detectionLeadDiagKey(now)]).probe.above_max).toBe(1)
    warn.mockRestore()
  })

  it('returns false when the KV write fails (read ok, put throws)', async () => {
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => { throw new Error('KV write down') }),
    } as unknown as KVNamespace
    // kvPut swallows the throw and returns false → appendLeadDiag propagates false (best-effort signal)
    expect(await appendLeadDiag(kv, 'in_window', true, now)).toBe(false)
  })
})

describe('readLeadDiag', () => {
  it('sums counters across the requested days', async () => {
    const yesterday = new Date(now.getTime() - 86_400_000)
    const store: Record<string, string> = {
      [detectionLeadDiagKey(now)]: JSON.stringify({ probe: { negative: 1 }, nonProbe: { no_detected: 2 } }),
      [detectionLeadDiagKey(yesterday)]: JSON.stringify({ probe: { negative: 3, in_window: 1 }, nonProbe: { no_detected: 1 } }),
    }
    const kv = mockKV(store)
    const total = await readLeadDiag(kv, now, 2)
    expect(total.probe.negative).toBe(4)
    expect(total.probe.in_window).toBe(1)
    expect(total.nonProbe.no_detected).toBe(3)
  })

  it('ignores missing and corrupt day keys', async () => {
    const store: Record<string, string> = {
      [detectionLeadDiagKey(now)]: '{corrupt',
    }
    const kv = mockKV(store)
    const total = await readLeadDiag(kv, now, 3)
    expect(total).toEqual({
      probe: { no_detected: 0, negative: 0, below_min: 0, in_window: 0, above_max: 0 },
      nonProbe: { no_detected: 0, negative: 0, below_min: 0, in_window: 0, above_max: 0 },
    })
  })

  it('clamps days into [1,7]', async () => {
    const kv = mockKV({})
    await readLeadDiag(kv, now, 999)
    // 7 day-keys read (clamped), not 999
    expect((kv.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(7)
  })
})

describe('formatLeadDiagSection', () => {
  const empty: LeadDiag = {
    probe: { no_detected: 0, negative: 0, below_min: 0, in_window: 0, above_max: 0 },
    nonProbe: { no_detected: 0, negative: 0, below_min: 0, in_window: 0, above_max: 0 },
  }

  it('returns empty string when nothing was classified', () => {
    expect(formatLeadDiagSection(empty)).toBe('')
  })

  it('renders MTTD framing (#464): total, early-via-RTT, within-cycle, no-detect', () => {
    const diag: LeadDiag = {
      probe: { no_detected: 1, negative: 2, below_min: 0, in_window: 0, above_max: 0 },
      nonProbe: { no_detected: 0, negative: 5, below_min: 0, in_window: 0, above_max: 0 },
    }
    // total = 8, early via RTT (in_window) = 0, no-detect (probe) = 1, within-cycle = 8-0-1 = 7
    const out = formatLeadDiagSection(diag)
    expect(out).toContain('8 incidents')
    expect(out).toContain('0 early via RTT probe')
    expect(out).toContain('7 alerted within ~5-min polling cycle of official')
    expect(out).toContain('1 no-detect')
  })

  it('counts a genuine in_window event as early-via-RTT', () => {
    const diag: LeadDiag = {
      probe: { no_detected: 0, negative: 1, below_min: 0, in_window: 2, above_max: 0 },
      nonProbe: { no_detected: 0, negative: 0, below_min: 0, in_window: 0, above_max: 0 },
    }
    // total = 3, early = 2, no-detect = 0, within-cycle = 3-2-0 = 1
    const out = formatLeadDiagSection(diag)
    expect(out).toContain('3 incidents')
    expect(out).toContain('2 early via RTT probe')
    expect(out).toContain('1 alerted within ~5-min polling cycle of official')
  })

  it('includes non-probe no_detected in the combined no-detect figure (not within-cycle)', () => {
    // A non-probe incident the status-page poll missed is an honest "not detected", NOT a
    // within-cycle alert. no-detect must span both groups (#464 review fix).
    const diag: LeadDiag = {
      probe: { no_detected: 1, negative: 0, below_min: 0, in_window: 0, above_max: 0 },
      nonProbe: { no_detected: 2, negative: 3, below_min: 0, in_window: 0, above_max: 0 },
    }
    // total = 6, early = 0, no-detect = 1+2 = 3, within-cycle = 6-0-3 = 3
    const out = formatLeadDiagSection(diag)
    expect(out).toContain('6 incidents')
    expect(out).toContain('3 alerted within ~5-min polling cycle of official')
    expect(out).toContain('3 no-detect')
  })

  it('never renders a negative within-cycle count (Math.max floor)', () => {
    // All probe no_detected, nothing else — within-cycle must floor at 0, not go negative.
    const diag: LeadDiag = {
      probe: { no_detected: 3, negative: 0, below_min: 0, in_window: 0, above_max: 0 },
      nonProbe: { no_detected: 0, negative: 0, below_min: 0, in_window: 0, above_max: 0 },
    }
    // total = 3, early = 0, no-detect = 3, within-cycle = max(0, 3-0-3) = 0
    const out = formatLeadDiagSection(diag)
    expect(out).toContain('0 alerted within ~5-min polling cycle of official')
    expect(out).not.toMatch(/-\d+ alerted/)
  })
})

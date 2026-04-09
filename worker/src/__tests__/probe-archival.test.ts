import { describe, it, expect, vi } from 'vitest'
import { aggregateProbeDaily, archiveProbeDaily, computeProbeSummaries } from '../probe-archival'
import type { ProbeSnapshot } from '../probe'

describe('aggregateProbeDaily', () => {
  it('computes p50/p75/p95/min/max from probe snapshots', () => {
    const snapshots: ProbeSnapshot[] = Array.from({ length: 20 }, (_, i) => ({
      t: `2026-04-02T${String(i).padStart(2, '0')}:00:00Z`,
      data: {
        claude: { status: 200, rtt: 100 + i * 10 }, // 100, 110, ..., 290
      },
    }))

    const result = aggregateProbeDaily(snapshots)
    expect(result.claude).toBeDefined()
    expect(result.claude.count).toBe(20)
    expect(result.claude.min).toBe(100)
    expect(result.claude.max).toBeLessThanOrEqual(290) // top 1% trimmed
    expect(result.claude.p50).toBeGreaterThanOrEqual(180)
    expect(result.claude.p50).toBeLessThanOrEqual(200)
    expect(result.claude.p75).toBeGreaterThanOrEqual(240)
    expect(result.claude.p95).toBeGreaterThanOrEqual(270)
    expect(result.claude.spikes).toBe(0) // no spikes in linear data
  })

  it('counts failures (rtt=-1) as spikes', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-04-02T00:00:00Z', data: { openai: { status: 200, rtt: 200 } } },
      { t: '2026-04-02T00:05:00Z', data: { openai: { status: 200, rtt: 210 } } },
      { t: '2026-04-02T00:10:00Z', data: { openai: { status: 0, rtt: -1 } } },
      { t: '2026-04-02T00:15:00Z', data: { openai: { status: 200, rtt: 190 } } },
    ]

    const result = aggregateProbeDaily(snapshots)
    expect(result.openai.count).toBe(4)
    expect(result.openai.spikes).toBe(1) // 1 failure
    expect(result.openai.min).toBe(190)
    expect(result.openai.max).toBeLessThanOrEqual(210) // top 1% trimmed
  })

  it('counts RTT spikes (>3x median)', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-04-02T00:00:00Z', data: { groq: { status: 200, rtt: 100 } } },
      { t: '2026-04-02T00:05:00Z', data: { groq: { status: 200, rtt: 110 } } },
      { t: '2026-04-02T00:10:00Z', data: { groq: { status: 200, rtt: 105 } } },
      { t: '2026-04-02T00:15:00Z', data: { groq: { status: 200, rtt: 500 } } }, // >3x median (~105)
      { t: '2026-04-02T00:20:00Z', data: { groq: { status: 200, rtt: 95 } } },
    ]

    const result = aggregateProbeDaily(snapshots)
    expect(result.groq.spikes).toBe(1) // 500 > 3×105
  })

  it('handles all-failure data', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-04-02T00:00:00Z', data: { down: { status: 0, rtt: -1 } } },
      { t: '2026-04-02T00:05:00Z', data: { down: { status: 0, rtt: -1 } } },
    ]

    const result = aggregateProbeDaily(snapshots)
    expect(result.down.count).toBe(2)
    expect(result.down.p50).toBe(0)
    expect(result.down.spikes).toBe(2)
  })

  it('aggregates multiple services independently', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-04-02T00:00:00Z', data: { claude: { status: 200, rtt: 25 }, gemini: { status: 200, rtt: 40 } } },
      { t: '2026-04-02T00:05:00Z', data: { claude: { status: 200, rtt: 30 }, gemini: { status: 200, rtt: 35 } } },
    ]

    const result = aggregateProbeDaily(snapshots)
    expect(Object.keys(result)).toEqual(expect.arrayContaining(['claude', 'gemini']))
    expect(result.claude.min).toBe(25)
    expect(result.gemini.min).toBe(35)
  })

  it('returns empty object for empty snapshots', () => {
    expect(aggregateProbeDaily([])).toEqual({})
  })

  it('applies warm-up filtering: excludes spike RTTs from percentile calculation', () => {
    // 20 normal RTTs (100-290) + 1 extreme spike (5000 > 3×median)
    const snapshots: ProbeSnapshot[] = [
      ...Array.from({ length: 20 }, (_, i) => ({
        t: `2026-04-02T${String(i).padStart(2, '0')}:00:00Z`,
        data: { svc: { status: 200, rtt: 100 + i * 10 } }, // 100-290
      })),
      { t: '2026-04-02T20:00:00Z', data: { svc: { status: 200, rtt: 5000 } } }, // extreme spike
    ]

    const result = aggregateProbeDaily(snapshots)
    // Spike (5000) should be excluded from p50/p95 by warm-up filtering
    // Without filtering: p95 would be near 5000
    // With filtering: p95 stays within normal range
    expect(result.svc.p95).toBeLessThan(300)
    expect(result.svc.spikes).toBe(1) // raw spike count preserved
  })
})

describe('archiveProbeDaily', () => {
  function mockKV(store: Record<string, string> = {}) {
    return {
      get: vi.fn(async (key: string) => store[key] ?? null),
      put: vi.fn(async (key: string, value: string) => { store[key] = value }),
    } as unknown as KVNamespace
  }

  // "now" = 2026-04-03 09:00 UTC → yesterday = 2026-04-02
  const now = new Date('2026-04-03T09:00:00Z')

  const yesterdaySnapshots: ProbeSnapshot[] = [
    { t: '2026-04-02T10:00:00Z', data: { claude: { status: 200, rtt: 25 } } },
    { t: '2026-04-02T15:00:00Z', data: { claude: { status: 200, rtt: 30 } } },
  ]

  it('archives yesterday probe data to KV with 90d TTL', async () => {
    const store: Record<string, string> = {
      'probe:24h': JSON.stringify({ snapshots: [
        ...yesterdaySnapshots,
        { t: '2026-04-03T08:00:00Z', data: { claude: { status: 200, rtt: 28 } } }, // today — excluded
      ] }),
    }
    const kv = mockKV(store)
    const result = await archiveProbeDaily(kv, now)

    expect(result).toBe(true)
    expect(kv.put).toHaveBeenCalledWith(
      'probe:daily:2026-04-02',
      expect.any(String),
      { expirationTtl: 90 * 86400 },
    )
    const archived = JSON.parse(store['probe:daily:2026-04-02'])
    expect(archived.claude.count).toBe(2) // only yesterday's snapshots
    expect(archived.claude.min).toBe(25)
  })

  it('skips if already archived', async () => {
    const kv = mockKV({
      'probe:24h': JSON.stringify({ snapshots: yesterdaySnapshots }),
      'probe:daily:2026-04-02': '{"claude":{}}',
    })
    const result = await archiveProbeDaily(kv, now)
    expect(result).toBe(false)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('returns false when probe:24h is empty', async () => {
    const kv = mockKV({})
    const result = await archiveProbeDaily(kv, now)
    expect(result).toBe(false)
  })

  it('returns false when no yesterday snapshots exist', async () => {
    const kv = mockKV({
      'probe:24h': JSON.stringify({ snapshots: [
        { t: '2026-04-03T08:00:00Z', data: { claude: { status: 200, rtt: 28 } } },
      ] }),
    })
    const result = await archiveProbeDaily(kv, now)
    expect(result).toBe(false)
  })
})

describe('computeProbeSummaries', () => {
  function mockKV(store: Record<string, string> = {}) {
    return {
      get: vi.fn(async (key: string) => store[key] ?? null),
      put: vi.fn(async (key: string, value: string) => { store[key] = value }),
    } as unknown as KVNamespace
  }

  function dayKey(daysAgo: number): string {
    return `probe:daily:${new Date(Date.now() - daysAgo * 86_400_000).toISOString().split('T')[0]}`
  }

  it('computes p50 average, p95 average, and combined CV from daily archives', async () => {
    // 7 days of data required for reliable Responsiveness
    const makeDay = (p50: number, p95: number) => ({
      openai: { p50, p75: p50 * 1.2, p95, min: p50 * 0.5, max: p95 * 1.2, count: 288, spikes: 2 },
    })
    const store: Record<string, string> = {
      [dayKey(1)]: JSON.stringify(makeDay(200, 400)),
      [dayKey(2)]: JSON.stringify(makeDay(180, 360)),
      [dayKey(3)]: JSON.stringify(makeDay(220, 440)),
      [dayKey(4)]: JSON.stringify(makeDay(190, 380)),
      [dayKey(5)]: JSON.stringify(makeDay(210, 420)),
      [dayKey(6)]: JSON.stringify(makeDay(200, 400)),
      [dayKey(7)]: JSON.stringify(makeDay(200, 400)),
    }
    const kv = mockKV(store)
    const summaries = await computeProbeSummaries(kv)

    expect(summaries.has('openai')).toBe(true)
    const openai = summaries.get('openai')!
    expect(openai.p50).toBe(200) // avg of [200,180,220,190,210,200,200] = 200
    expect(openai.p95).toBe(400) // avg of [400,360,440,380,420,400,400] = 400

    // CV combined = 0.3 * dayToDay_CV + 0.7 * (p95-p50)/p50 spread
    // day-to-day p50 mean=200, CV≈0.06
    // Spread: (400-200)/200 = 1.0
    // Combined: 0.3*0.06 + 0.7*1.0 ≈ 0.718
    expect(openai.cvCombined).toBeGreaterThan(0.7)
    expect(openai.cvCombined).toBeLessThan(0.75)
  })

  it('returns empty map when fewer than 7 days of data', async () => {
    // Only 3 days — below MIN_DAYS=7 threshold
    const store: Record<string, string> = {}
    for (let i = 1; i <= 3; i++) {
      store[dayKey(i)] = JSON.stringify({
        claude: { p50: 10, p75: 12, p95: 20, min: 8, max: 30, count: 288, spikes: 0 },
      })
    }
    const kv = mockKV(store)
    const summaries = await computeProbeSummaries(kv)
    expect(summaries.has('claude')).toBe(false)
  })

  it('skips services with p50=0 (no valid data)', async () => {
    const store: Record<string, string> = {}
    for (let i = 1; i <= 7; i++) {
      store[dayKey(i)] = JSON.stringify({
        down: { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 288, spikes: 288 },
      })
    }
    const kv = mockKV(store)
    const summaries = await computeProbeSummaries(kv)
    expect(summaries.has('down')).toBe(false)
  })

  it('handles malformed daily data gracefully', async () => {
    const store: Record<string, string> = {
      [dayKey(1)]: '{ invalid json',
    }
    // 7 valid days + 1 malformed
    for (let i = 2; i <= 8; i++) {
      store[dayKey(i)] = JSON.stringify({
        claude: { p50: 10 + i, p75: 12, p95: 20, min: 8, max: 30, count: 288, spikes: 0 },
      })
    }
    const kv = mockKV(store)
    const summaries = await computeProbeSummaries(kv, 8)
    expect(summaries.has('claude')).toBe(true)
  })

  it('skips spike-dominated days (>= 50% spikes)', async () => {
    const store: Record<string, string> = {}
    // 7 normal days + 1 spike day
    for (let i = 1; i <= 8; i++) {
      if (i === 4) {
        store[dayKey(i)] = JSON.stringify({
          gemini: { p50: 80, p75: 500, p95: 900, min: 20, max: 1200, count: 288, spikes: 150 }, // 52% spikes → skip
        })
      } else {
        store[dayKey(i)] = JSON.stringify({
          gemini: { p50: 25 + i, p75: 30, p95: 40 + i, min: 16, max: 100, count: 288, spikes: 2 },
        })
      }
    }
    const kv = mockKV(store)
    const summaries = await computeProbeSummaries(kv, 8)
    expect(summaries.has('gemini')).toBe(true)
    // Day 4 skipped due to spikes, remaining 7 days used
    const gemini = summaries.get('gemini')!
    expect(gemini.p50).toBeGreaterThan(0)
  })

  it('skips extreme spread days (p95/p50 > 10×)', async () => {
    const store: Record<string, string> = {}
    for (let i = 1; i <= 8; i++) {
      if (i === 3) {
        store[dayKey(i)] = JSON.stringify({
          gemini: { p50: 78, p75: 863, p95: 1026, min: 22, max: 1176, count: 288, spikes: 114 }, // p95/p50=13.2× → skip
        })
      } else {
        store[dayKey(i)] = JSON.stringify({
          gemini: { p50: 30 + i, p75: 40, p95: 60 + i, min: 17, max: 200, count: 288, spikes: 2 },
        })
      }
    }
    const kv = mockKV(store)
    const summaries = await computeProbeSummaries(kv, 8)
    expect(summaries.has('gemini')).toBe(true)
    const gemini = summaries.get('gemini')!
    // Day 3 skipped (extreme spread), remaining 7 days used
    expect(gemini.p50).toBeGreaterThan(30)
    expect(gemini.p50).toBeLessThan(40)
  })
})

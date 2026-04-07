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
    expect(result.claude.max).toBe(290)
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
    expect(result.openai.max).toBe(210)
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
    const store: Record<string, string> = {
      [dayKey(1)]: JSON.stringify({
        claude: { p50: 10, p75: 12, p95: 20, min: 8, max: 30, count: 288, spikes: 0 },
        openai: { p50: 200, p75: 250, p95: 400, min: 100, max: 500, count: 288, spikes: 2 },
      }),
      [dayKey(2)]: JSON.stringify({
        claude: { p50: 8, p75: 10, p95: 16, min: 6, max: 25, count: 288, spikes: 0 },
        openai: { p50: 180, p75: 230, p95: 360, min: 90, max: 480, count: 288, spikes: 1 },
      }),
      [dayKey(3)]: JSON.stringify({
        claude: { p50: 12, p75: 14, p95: 22, min: 9, max: 35, count: 288, spikes: 1 },
        openai: { p50: 220, p75: 270, p95: 440, min: 110, max: 520, count: 288, spikes: 3 },
      }),
    }
    const kv = mockKV(store)
    const summaries = await computeProbeSummaries(kv)

    expect(summaries.has('claude')).toBe(true)
    expect(summaries.has('openai')).toBe(true)

    const claude = summaries.get('claude')!
    expect(claude.p50).toBe(10) // avg of [10, 8, 12] = 10
    expect(claude.p95).toBe(19) // avg of [20, 16, 22] = 19.33 → 19

    const openai = summaries.get('openai')!
    expect(openai.p50).toBe(200) // avg of [200, 180, 220] = 200
    expect(openai.p95).toBe(400) // avg of [400, 360, 440] = 400

    // CV combined = 0.5 * dayToDay_CV + 0.5 * (p95-p50)/p50 spread
    // OpenAI day-to-day p50: [200, 180, 220], mean=200, std=16.33, CV=0.0816
    // Spread: (400-200)/200 = 1.0
    // Combined: 0.5*0.0816 + 0.5*1.0 = 0.5408
    expect(openai.cvCombined).toBeGreaterThan(0.5)
    expect(openai.cvCombined).toBeLessThan(0.6)
  })

  it('returns empty map when fewer than 2 days of data', async () => {
    const store: Record<string, string> = {
      [dayKey(1)]: JSON.stringify({
        claude: { p50: 10, p75: 12, p95: 20, min: 8, max: 30, count: 288, spikes: 0 },
      }),
    }
    const kv = mockKV(store)
    const summaries = await computeProbeSummaries(kv)
    expect(summaries.size).toBe(0)
  })

  it('skips services with p50=0 (no valid data)', async () => {
    const store: Record<string, string> = {
      [dayKey(1)]: JSON.stringify({
        down: { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 288, spikes: 288 },
      }),
      [dayKey(2)]: JSON.stringify({
        down: { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 288, spikes: 288 },
      }),
    }
    const kv = mockKV(store)
    const summaries = await computeProbeSummaries(kv)
    expect(summaries.has('down')).toBe(false)
  })

  it('handles malformed daily data gracefully', async () => {
    const store: Record<string, string> = {
      [dayKey(1)]: '{ invalid json',
      [dayKey(2)]: JSON.stringify({
        claude: { p50: 10, p75: 12, p95: 20, min: 8, max: 30, count: 288, spikes: 0 },
      }),
      [dayKey(3)]: JSON.stringify({
        claude: { p50: 12, p75: 14, p95: 22, min: 9, max: 35, count: 288, spikes: 1 },
      }),
    }
    const kv = mockKV(store)
    const summaries = await computeProbeSummaries(kv)
    // 2 valid days → still enough for computation
    expect(summaries.has('claude')).toBe(true)
  })
})

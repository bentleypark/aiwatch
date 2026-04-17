import { describe, it, expect, vi } from 'vitest'
import { aggregateProbeDaily, archiveProbeDaily, computeProbeSummaries, getCachedProbeSummaries, cacheProbeSummaries } from '../probe-archival'
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
    expect(result.claude.max).toBeLessThanOrEqual(290) // top 1% may be trimmed
    expect(result.claude.p50).toBeGreaterThanOrEqual(180)
    expect(result.claude.p50).toBeLessThanOrEqual(200)
    expect(result.claude.p75).toBeGreaterThanOrEqual(230)
    expect(result.claude.p95).toBeGreaterThanOrEqual(260)
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
    expect(result.openai.max).toBeLessThanOrEqual(210) // top 1% may be trimmed
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

  it('excludes RTT during incident windows', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-04-02T00:00:00Z', data: { claude: { status: 200, rtt: 100 } } },
      { t: '2026-04-02T01:00:00Z', data: { claude: { status: 200, rtt: 5000 } } }, // during incident
      { t: '2026-04-02T02:00:00Z', data: { claude: { status: 200, rtt: 4000 } } }, // during incident
      { t: '2026-04-02T04:00:00Z', data: { claude: { status: 200, rtt: 110 } } },
    ]
    const windows = {
      claude: [{ startedAt: '2026-04-02T00:30:00Z', resolvedAt: '2026-04-02T03:00:00Z' }],
    }

    const result = aggregateProbeDaily(snapshots, windows)
    expect(result.claude.count).toBe(2) // only non-incident snapshots
    expect(result.claude.p50).toBeLessThanOrEqual(110) // no 5000/4000 inflation
  })

  it('excludes RTT for ongoing incident (no resolvedAt)', () => {
    const snapshots: ProbeSnapshot[] = [
      { t: '2026-04-02T00:00:00Z', data: { openai: { status: 200, rtt: 200 } } },
      { t: '2026-04-02T01:00:00Z', data: { openai: { status: 200, rtt: 8000 } } }, // during ongoing incident
    ]
    const windows = {
      openai: [{ startedAt: '2026-04-02T00:30:00Z' }], // no resolvedAt = ongoing
    }

    const result = aggregateProbeDaily(snapshots, windows)
    expect(result.openai.count).toBe(1) // only pre-incident snapshot
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

  // count defaults above 200-snapshot guard threshold so existing tests aren't filtered out (#132)
  function makeDailyData(p50: number, p95: number, count = 250, spikes = 0) {
    return { p50, p75: (p50 + p95) / 2, p95, min: p50 * 0.9, max: p95 * 1.1, count, spikes }
  }

  it('computes summaries with validDays from daily archives', async () => {
    const store: Record<string, string> = {}
    // Create 3 days of data
    for (let i = 1; i <= 3; i++) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().split('T')[0]
      store[`probe:daily:${date}`] = JSON.stringify({
        claude: makeDailyData(120 + i * 5, 250 + i * 10),
      })
    }

    const kv = mockKV(store)
    const result = await computeProbeSummaries(kv, 3)

    expect(result.has('claude')).toBe(true)
    const claude = result.get('claude')!
    expect(claude.validDays).toBe(3)
    expect(claude.p50).toBeGreaterThan(0)
    expect(claude.p95).toBeGreaterThan(claude.p50)
    expect(claude.cvCombined).toBeGreaterThanOrEqual(0)
  })

  it('returns empty map when fewer than 2 days available', async () => {
    const date = new Date(Date.now() - 86_400_000).toISOString().split('T')[0]
    const store: Record<string, string> = {
      [`probe:daily:${date}`]: JSON.stringify({ claude: makeDailyData(120, 250) }),
    }

    const kv = mockKV(store)
    const result = await computeProbeSummaries(kv, 7)
    expect(result.size).toBe(0)
  })

  it('partial KV rejection: 6 of 7 reject + 1 succeeds → empty Map (insufficient days), no throw', async () => {
    // Realistic Cloudflare KV degradation pattern. Locks the per-key continue behavior — a refactor
    // to early-exit on first failure would silently lose surviving days.
    const date = new Date(Date.now() - 86_400_000).toISOString().split('T')[0]
    const surviving = JSON.stringify({
      claude: { p50: 120, p75: 185, p95: 250, min: 108, max: 275, count: 250, spikes: 2 },
    })
    const kv = {
      get: vi.fn(async (key: string) => {
        if (key === `probe:daily:${date}`) return surviving
        throw new Error('KV timeout')
      }),
    } as unknown as KVNamespace
    const result = await computeProbeSummaries(kv, 7)
    expect(result.size).toBe(0) // 1 valid day < required 2 → empty
  })

  it('partial KV rejection: 5 succeed + 2 reject → non-empty result with surviving days', async () => {
    const today = Date.now()
    const validKeys = new Set(
      Array.from({ length: 5 }, (_, i) =>
        `probe:daily:${new Date(today - (i + 1) * 86_400_000).toISOString().split('T')[0]}`
      ),
    )
    const validValue = JSON.stringify({
      claude: { p50: 120, p75: 185, p95: 250, min: 108, max: 275, count: 250, spikes: 2 },
    })
    const kv = {
      get: vi.fn(async (key: string) => {
        if (validKeys.has(key)) return validValue
        throw new Error('KV timeout')
      }),
    } as unknown as KVNamespace
    const result = await computeProbeSummaries(kv, 7)
    expect(result.has('claude')).toBe(true)
    expect(result.get('claude')!.validDays).toBe(5)
  })

  it('skips partial-day data (count < 200 snapshots)', async () => {
    const store: Record<string, string> = {}
    for (let i = 1; i <= 4; i++) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().split('T')[0]
      const count = i === 2 ? 100 : 250 // day 2 is partial (under 200 threshold)
      store[`probe:daily:${date}`] = JSON.stringify({
        claude: makeDailyData(120, 250, count, 2),
      })
    }
    const kv = mockKV(store)
    const result = await computeProbeSummaries(kv, 4)
    expect(result.get('claude')!.validDays).toBe(3) // day 2 excluded by snapshot guard
  })

  it('skips spike-dominated days (spikes >= 50% of count)', async () => {
    const store: Record<string, string> = {}
    for (let i = 1; i <= 4; i++) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().split('T')[0]
      const spikes = i === 2 ? 150 : 5 // day 2 is spike-dominated (>50% of 250)
      store[`probe:daily:${date}`] = JSON.stringify({
        claude: makeDailyData(120, 250, 250, spikes),
      })
    }

    const kv = mockKV(store)
    const result = await computeProbeSummaries(kv, 4)
    expect(result.get('claude')!.validDays).toBe(3) // day 2 excluded
  })
})

describe('getCachedProbeSummaries', () => {
  function mockKV(store: Record<string, string> = {}) {
    return {
      get: vi.fn(async (key: string) => store[key] ?? null),
      put: vi.fn(async (key: string, value: string) => { store[key] = value }),
    } as unknown as KVNamespace
  }

  it('returns cached summaries from KV when available', async () => {
    const cached: [string, { p50: number; p95: number; cvCombined: number; validDays: number }][] = [
      ['claude', { p50: 120, p95: 250, cvCombined: 0.15, validDays: 7 }],
    ]
    const kv = mockKV({ 'probe:summaries': JSON.stringify(cached) })

    const result = await getCachedProbeSummaries(kv)
    expect(result.get('claude')!.p50).toBe(120)
    expect(result.get('claude')!.validDays).toBe(7)
    // Should only read probe:summaries, not daily keys
    expect(kv.get).toHaveBeenCalledTimes(1)
  })

  it('falls back to compute when cache is empty', async () => {
    const kv = mockKV({})

    const result = await getCachedProbeSummaries(kv)
    expect(result.size).toBe(0) // no daily data → empty result
    // Should have attempted probe:summaries + 7 daily keys
    expect(kv.get).toHaveBeenCalledTimes(8) // 1 cache miss + 7 daily reads
  })

  it('recomputes when cached value is a non-array (corrupted shape)', async () => {
    // Locks the Array.isArray guard — defends against accidental Object.fromEntries serialization
    const kv = mockKV({ 'probe:summaries': JSON.stringify({ claude: { p50: 120 } }) })
    const result = await getCachedProbeSummaries(kv)
    expect(result.size).toBe(0) // fell through to compute (no daily data in fixture)
    expect(kv.get).toHaveBeenCalledTimes(8) // 1 cache attempt + 7 recompute reads
  })

  it('recomputes when cached value is unparseable JSON', async () => {
    const kv = mockKV({ 'probe:summaries': 'not-json' })
    const result = await getCachedProbeSummaries(kv)
    expect(result.size).toBe(0)
    expect(kv.get).toHaveBeenCalledTimes(8)
  })

  it('throws when ALL probe:daily KV reads fail (KV degraded → caller maps to unavailable, no penalty)', async () => {
    // Critical regression guard: silent empty Map would 5%-penalize every probed service.
    // Throw lets readProbeSummaries() in index.ts catch and propagate undefined → 'unavailable'.
    const kv = {
      get: vi.fn(async (key: string) => {
        if (key === 'probe:summaries') return null // cache miss → fall through to compute
        throw new Error('KV unavailable')
      }),
      put: vi.fn(),
    } as unknown as KVNamespace

    await expect(getCachedProbeSummaries(kv, 7)).rejects.toThrow(/all 7 probe:daily KV reads failed/)
  })
})

describe('cacheProbeSummaries', () => {
  function mockKV(store: Record<string, string> = {}) {
    return {
      get: vi.fn(async (key: string) => store[key] ?? null),
      put: vi.fn(async (key: string, value: string, opts?: object) => { store[key] = value }),
    } as unknown as KVNamespace
  }

  it('stores computed summaries in KV with 80min TTL and returns true', async () => {
    const store: Record<string, string> = {}
    for (let i = 1; i <= 3; i++) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().split('T')[0]
      store[`probe:daily:${date}`] = JSON.stringify({
        claude: { p50: 120, p75: 185, p95: 250, min: 108, max: 275, count: 250, spikes: 2 },
      })
    }

    const kv = mockKV(store)
    const wrote = await cacheProbeSummaries(kv, 3)

    expect(wrote).toBe(true)
    expect(kv.put).toHaveBeenCalledWith(
      'probe:summaries',
      expect.any(String),
      { expirationTtl: 4800 },
    )
    const stored = JSON.parse(store['probe:summaries'])
    expect(stored).toHaveLength(1)
    expect(stored[0][0]).toBe('claude')
    expect(stored[0][1].validDays).toBe(3)
  })

  it('returns false and does not write when no summaries computed (caller skips slot dedup)', async () => {
    const kv = mockKV({})
    const wrote = await cacheProbeSummaries(kv)
    expect(wrote).toBe(false)
    expect(kv.put).not.toHaveBeenCalled()
  })
})

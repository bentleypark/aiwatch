import { describe, it, expect, vi } from 'vitest'
import { aggregateProbeDaily, archiveProbeDaily } from '../probe-archival'
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

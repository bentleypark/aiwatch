// #1618 — how far a capped feed's `created_at` depth and `updated_at` depth disagree, per feed and per day.
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { FeedDepthGap, ServiceStatus } from '../types'

import workerModule from '../index'
import { cappedFeedDepthGap, widerFeedDepthGaps, recordFeedDepthGaps, fetchAllServices, CACHE_KEY, SERVICES } from '../services'
import { invalidateSuppressionCache } from '../suppression'
import { mockKV, TEST_TIMEOUT_MS } from './helpers/unreadable-source'

const T0 = Date.parse('2026-11-10T00:00:00.000Z')
const hoursAgo = (h: number) => new Date(T0 - h * 3_600_000).toISOString()
const row = (createdH: number, updatedH: number) => ({ created_at: hoursAgo(createdH), updated_at: hoursAgo(updatedH) })
const gap = (gapHoursInWindow: number): FeedDepthGap => ({ gapHoursInWindow, oldestUpdatedAt: hoursAgo(1) })

describe('cappedFeedDepthGap', () => {
  const fill = (extra: Array<ReturnType<typeof row>>) => [...Array.from({ length: 24 }, (_, k) => row((k + 1) * 10, (k + 1) * 10 - 1)), ...extra]

  it('a row closed a day after it opened, inside the window, leaves that long a gap', () => {
    expect(cappedFeedDepthGap(fill([row(400, 374.1)]), T0)).toEqual({ gapHoursInWindow: 25.9, oldestUpdatedAt: hoursAgo(374.1) })
  })

  it('a tail bulk-touched eight months ago leaves no gap in the window, however wide the raw gap', () => {
    const rows = [...Array.from({ length: 5 }, (_, k) => row((k + 1) * 10, (k + 1) * 10)), ...Array.from({ length: 20 }, (_, k) => row(6000 + k * 500, 5800))]
    expect(cappedFeedDepthGap(rows, T0)).toEqual({ gapHoursInWindow: 0, oldestUpdatedAt: hoursAgo(5800) })
  })

  it('counts only the part of the gap inside the trailing 30 days', () => {
    expect(cappedFeedDepthGap(fill([row(800, 710)]), T0)).toEqual({ gapHoursInWindow: 10, oldestUpdatedAt: hoursAgo(710) })
  })

  it('is absent below the cap, where nothing past the list is missing', () => {
    expect(cappedFeedDepthGap(Array.from({ length: 24 }, (_, k) => row(k + 1, k + 1)), T0)).toBeUndefined()
  })

  it('skips unreadable times', () => {
    const rows = [...Array.from({ length: 25 }, (_, k) => row(k + 1, k + 1)), { created_at: 'garbage', updated_at: 'garbage' }, {}]
    expect(cappedFeedDepthGap(rows, T0)).toEqual({ gapHoursInWindow: 0, oldestUpdatedAt: hoursAgo(25) })
  })

  it.each([
    ['updated_at', (k: number) => ({ created_at: hoursAgo(k + 1) })],
    ['created_at', (k: number) => ({ updated_at: hoursAgo(k + 1) })],
  ])('is absent when no row carries %s', (_field, make) => {
    expect(cappedFeedDepthGap(Array.from({ length: 25 }, (_, k) => make(k)), T0)).toBeUndefined()
  })
})

describe('widerFeedDepthGaps', () => {
  const svc = (id: string, feedDepthGap?: FeedDepthGap) => ({ id, feedDepthGap })

  it('takes a first sighting and a wider gap, and keeps the other services', () => {
    expect(widerFeedDepthGaps({ a: gap(2), b: gap(9) }, [svc('a', gap(5)), svc('c', gap(1))])).toEqual({ a: gap(5), b: gap(9), c: gap(1) })
  })

  it('keeps the wider gap the day already holds', () => {
    expect(widerFeedDepthGaps({ a: gap(25.9) }, [svc('a', gap(2.4)), svc('b')])).toBeNull()
  })

  it('an equal gap is not a change', () => {
    expect(widerFeedDepthGaps({ a: gap(3) }, [svc('a', gap(3))])).toBeNull()
  })
})

describe('recordFeedDepthGaps', () => {
  const NOW = Date.parse('2026-11-10T14:30:00.000Z')
  const KEY = 'feed-depth-gap:2026-11-10'
  const services = [{ id: 'openai', feedDepthGap: gap(25.9) }]
  const kvWith = (get: () => Promise<string | null>) => {
    const put = vi.fn(async () => {})
    return { kv: { get, put } as unknown as KVNamespace, put }
  }

  afterEach(() => { vi.restoreAllMocks() })

  it('writes the UTC day key with its retention', async () => {
    const { kv, put } = kvWith(async () => null)
    await recordFeedDepthGaps(kv, services, NOW)
    expect(put).toHaveBeenCalledWith(KEY, JSON.stringify({ openai: gap(25.9) }), { expirationTtl: 2_592_000 })
  })

  it('writes nothing when no gap widened', async () => {
    const { kv, put } = kvWith(async () => JSON.stringify({ openai: gap(30) }))
    await recordFeedDepthGaps(kv, services, NOW)
    expect(put).not.toHaveBeenCalled()
  })

  it.each([
    ['a failed read', async () => { throw new Error('kv down') }],
    ['an unparseable value', async () => '{not json'],
  ])('%s leaves the day record alone', async (_label, get) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { kv, put } = kvWith(get as () => Promise<string | null>)
    await recordFeedDepthGaps(kv, services, NOW)
    expect(put).not.toHaveBeenCalled()
  })
})

describe('scheduled() records the day', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('a service carrying a gap reaches the day record', async () => {
    const event = { scheduledTime: Date.parse('2026-08-12T12:07:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    const live = SERVICES.map((s, i) => ({ id: s.id, name: s.name, status: 'operational', incidents: [], ...(i === 0 ? { feedDepthGap: gap(7) } : {}) })) as unknown as ServiceStatus[]
    const clock = Date.parse('2026-11-10T14:30:00.000Z')
    vi.spyOn(Date, 'now').mockReturnValue(clock)
    const store = new Map<string, string>([[CACHE_KEY, JSON.stringify({ services: live, upstreamFeeds: [], cachedAt: new Date(clock).toISOString() })]])
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async (key: string, value: string) => { store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }))

    await workerModule.scheduled(event, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' } as never, ctx)

    expect(JSON.parse(store.get('feed-depth-gap:2026-11-10')!)).toEqual({ [SERVICES[0].id]: gap(7) })
  }, TEST_TIMEOUT_MS)
})

describe('fetchAllServices measures the gap against the current time', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); invalidateSuppressionCache() })

  it('only the part of the gap inside the last 30 days counts', async () => {
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
    const inc = (id: string, created: string, updated: string) => ({
      id, name: `Elevated errors ${id}`, status: 'resolved', impact: 'minor', created_at: created, updated_at: updated, started_at: created,
      resolved_at: updated, monitoring_at: null, shortlink: '', page_id: 'p', incident_updates: [], components: [],
    })
    const rows = [...Array.from({ length: 24 }, (_, k) => inc(`cur-${k}`, ago(k + 1), ago(k + 1))), inc('old', ago(40), ago(29))]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u === 'https://status.cursor.com/api/v2/summary.json') return new Response(JSON.stringify({
        page: { id: 'p', name: 'Cursor', updated_at: ago(0) },
        status: { indicator: 'none', description: 'All Systems Operational' }, components: [], incidents: [],
      }), { status: 200 })
      if (u === 'https://status.cursor.com/api/v2/incidents.json') return new Response(JSON.stringify({ incidents: rows }), { status: 200 })
      return new Response('unavailable', { status: 503 })
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    invalidateSuppressionCache()
    const { raw } = await fetchAllServices(mockKV({}) as never, [])
    expect(raw.find((s) => s.id === 'cursor')!.feedDepthGap?.gapHoursInWindow).toBe(24)
  }, TEST_TIMEOUT_MS)
})

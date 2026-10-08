// #1650 — an expired Mistral Rootly feed must arm the #500 persistent-failure alert, a readable feed
// must clear it, and a frozen leftover `failSince` must not fire on the first new failure.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'
import { checkPersistentFetchFailures } from '../persistent-failure'
import { MISTRAL_FEED_KV_KEY, type RootlyFeed } from '../parsers/rootly'
import type { TrackingStateBlob } from '../utils'

const mistral = SERVICES.find((s) => s.id === 'mistral')!
const DISCORD = 'https://discord.com/api/webhooks/1/abc'
const T0 = Date.parse('2026-10-08T12:03:00.000Z')
const MIN = 60_000

function feed(): RootlyFeed {
  const scope = mistral.displayComponentIds!
  return {
    fetchedAt: new Date(T0).toISOString(),
    components: scope.map((id) => ({ id, name: `Component ${id.slice(0, 4)}`, status: 'Operational' })),
    incidents: [],
    coverage: { listed: 0, fetched: 0 },
    uptime: scope.map((id) => ({ componentId: id, barCount: 91, unreadBars: 0, coverage: { impacted: 0, fetched: 0 }, days: [] })),
  }
}

function kvWith(feedValue: string | null) {
  const store: Record<string, string> = {}
  return {
    store,
    get: vi.fn(async (k: string) => (k === MISTRAL_FEED_KV_KEY ? feedValue : store[k] ?? null)),
    put: vi.fn(async (k: string, v: string) => { store[k] = v }),
    delete: vi.fn(async (k: string) => { delete store[k] }),
    list: vi.fn(async () => ({ keys: [] })),
  }
}

async function cycle(kv: ReturnType<typeof kvWith>, tracking: TrackingStateBlob, atMs: number) {
  vi.setSystemTime(atMs)
  return fetchService(mistral, undefined, kv as never, tracking)
}

async function sweep(kv: ReturnType<typeof kvWith>, tracking: TrackingStateBlob, atMs: number) {
  kv.store['tracking:state'] = JSON.stringify(tracking)
  const send = vi.fn(async () => true)
  await checkPersistentFetchFailures(kv, DISCORD, [{ id: 'mistral', name: 'Mistral API' }], atMs, send)
  return send
}

afterEach(() => vi.useRealTimers())

describe('#1650 — Mistral feed expiry and the #500 alert', () => {
  it('an hour of absent-feed cycles sends one alert naming the feed, not the status-page URL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const kv = kvWith(null)
    const tracking: TrackingStateBlob = {}
    for (let m = 0; m <= 75; m += 5) {
      const svc = await cycle(kv, tracking, T0 + m * MIN)
      expect(svc.status).toBe('unknown')
    }
    const send = await sweep(kv, tracking, T0 + 75 * MIN)
    expect(send).toHaveBeenCalledTimes(1)
    const embed = (send.mock.calls[0] as unknown as [string, { description: string }])[1]
    expect(embed.description).toContain('Mistral API')
    expect(embed.description).toContain('Observed: Rootly scrape feed (KV, pushed by its GitHub Action) absent.')
    expect(embed.description).not.toContain('configured status-page URL')
  })

  it.each([
    ['unparseable JSON', 'decode', '{not json'],
    ['a value the storable check refuses', 'shape', JSON.stringify({ fetchedAt: new Date(T0).toISOString(), feed: { ...feed(), components: [] } })],
  ])('a present key holding %s is booked as %s, not absent', async (_label, phase, value) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const kv = kvWith(value)
    const tracking: TrackingStateBlob = {}
    await cycle(kv, tracking, T0)
    expect(tracking.mistral?.sourceReadFailure).toEqual({ source: 'rootly-feed', phase })
  })

  it('a KV read that throws is booked as transport, not absent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const kv = kvWith(null)
    kv.get.mockImplementation(async (k: string) => {
      if (k === MISTRAL_FEED_KV_KEY) throw new Error('kv down')
      return kv.store[k] ?? null
    })
    const tracking: TrackingStateBlob = {}
    await cycle(kv, tracking, T0)
    expect(tracking.mistral?.sourceReadFailure).toEqual({ source: 'rootly-feed', phase: 'transport', errorKind: 'unknown' })
  })

  it('does not alert inside the first hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const kv = kvWith(null)
    const tracking: TrackingStateBlob = {}
    for (let m = 0; m <= 40; m += 5) await cycle(kv, tracking, T0 + m * MIN)
    expect(await sweep(kv, tracking, T0 + 40 * MIN)).not.toHaveBeenCalled()
  })

  it('a readable feed clears the failure record', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const absent = kvWith(null)
    const tracking: TrackingStateBlob = {}
    for (let m = 0; m <= 20; m += 5) await cycle(absent, tracking, T0 + m * MIN)
    expect(tracking.mistral?.failSince).toBeDefined()
    const present = kvWith(JSON.stringify({ fetchedAt: new Date(T0).toISOString(), feed: feed() }))
    await cycle(present, tracking, T0 + 25 * MIN)
    expect(tracking.mistral?.failSince).toBeUndefined()
    expect(tracking.mistral?.failCount).toBeUndefined()
  })

  it('a frozen failSince from an older episode does not fire on the first new failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const kv = kvWith(null)
    // The production entry on 2026-10-08, left behind by the Instatus-era path.
    const tracking: TrackingStateBlob = {
      mistral: { failCount: 3, failCountAt: '2026-09-11T08:44:25.761Z', failSince: '2026-09-09T20:16:14.874Z', uptimeSeenAt: '2026-10-08' },
    }
    await cycle(kv, tracking, T0)
    expect(await sweep(kv, tracking, T0)).not.toHaveBeenCalled()
    for (let m = 5; m <= 75; m += 5) await cycle(kv, tracking, T0 + m * MIN)
    expect(tracking.mistral?.failSince).not.toBe('2026-09-09T20:16:14.874Z')
    expect(await sweep(kv, tracking, T0 + 75 * MIN)).toHaveBeenCalledTimes(1)
  })
})

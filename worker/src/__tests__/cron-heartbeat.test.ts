// #1501 — a stopped `*/5` cron cannot report its own absence, so the cron stamps a heartbeat and the
// `fetch` path (the one that stayed alive on 2026-09-23) reads its age. The pure verdict and the two
// entry points are pinned below; the last two describes drive the REAL `fetch` and `scheduled`
// handlers, because a unit-tested watchdog that nothing calls is the failure this issue is about.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseHeartbeat,
  stallVerdict,
  recordCronHeartbeat,
  checkCronHeartbeat,
  createWatchdogThrottle,
  CRON_HEARTBEAT_KEY,
  CRON_STALE_MS,
  STALL_REALERT_MS,
  WATCHDOG_INTERVAL_MS,
} from '../cron-heartbeat'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})
import { SERVICES, fetchAllServices } from '../services'
import type { ServiceStatus } from '../services'
import workerModule from '../index'
import { mockKV, TEST_TIMEOUT_MS } from './helpers/unreadable-source'

const HOOK = 'https://example.invalid/hook'
const T0 = Date.parse('2026-09-23T09:00:00Z')
const min = (n: number) => n * 60_000

const okSend = () => vi.fn(async () => true)
const stored = (kv: ReturnType<typeof mockKV>) => JSON.parse(kv.store[CRON_HEARTBEAT_KEY])

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('parseHeartbeat', () => {
  it('reads a plain and an alerted heartbeat', () => {
    expect(parseHeartbeat(JSON.stringify({ at: 5 }))).toEqual({ at: 5 })
    expect(parseHeartbeat(JSON.stringify({ at: 5, alertedAt: 9 }))).toEqual({ at: 5, alertedAt: 9 })
  })

  it('refuses everything else, so an unreadable value never reads as a fresh or a stalled cron', () => {
    for (const raw of [null, '', 'not json', 'null', '[]', '{}', '{"at":"5"}', '{"at":null}', '{"at":1e999}']) {
      expect(parseHeartbeat(raw), String(raw)).toBeNull()
    }
    expect(parseHeartbeat(JSON.stringify({ at: 5, alertedAt: 'x' }))).toEqual({ at: 5 })
  })
})

describe('stallVerdict', () => {
  it('is fresh up to the threshold and stalled from it', () => {
    expect(stallVerdict({ at: T0 }, T0 + CRON_STALE_MS - 1)).toBe('fresh')
    expect(stallVerdict({ at: T0 }, T0 + CRON_STALE_MS)).toBe('stalled')
  })

  it('does not page on two missed slots plus a third that is only due now', () => {
    // At +15 min the slots at +5 and +10 have been missed and the +15 slot is being dispatched this
    // very minute — a heartbeat that old is a cron one slot behind, not a stopped one.
    expect(stallVerdict({ at: T0 }, T0 + min(15))).toBe('fresh')
  })

  it('treats a heartbeat from a clock ahead of ours as fresh', () => {
    expect(stallVerdict({ at: T0 + min(30) }, T0)).toBe('fresh')
  })

  it('stays quiet inside the re-alert window and repeats once it lapses', () => {
    const hb = { at: T0, alertedAt: T0 + min(20) }
    expect(stallVerdict(hb, hb.alertedAt + STALL_REALERT_MS - 1)).toBe('already-alerted')
    expect(stallVerdict(hb, hb.alertedAt + STALL_REALERT_MS)).toBe('stalled')
  })
})

describe('checkCronHeartbeat', () => {
  it('does nothing without a KV binding or a webhook to alert on', async () => {
    const send = okSend()
    expect(await checkCronHeartbeat(undefined, HOOK, T0, send)).toBe('skipped')
    expect(await checkCronHeartbeat(mockKV(), undefined, T0, send)).toBe('skipped')
    expect(send).not.toHaveBeenCalled()
  })

  it('seeds an absent key instead of ignoring it, so a stall before the first run is still caught', async () => {
    const kv = mockKV()
    const send = okSend()
    expect(await checkCronHeartbeat(kv, HOOK, T0, send)).toBe('seeded')
    expect(stored(kv)).toEqual({ at: T0, seeded: true })
    expect(send).not.toHaveBeenCalled()

    expect(await checkCronHeartbeat(kv, HOOK, T0 + CRON_STALE_MS, send)).toBe('alerted')
  })

  it('never reports a seeded time as a cron run, and the cron clears the mark on its first run', async () => {
    const kv = mockKV()
    const send = okSend()
    await checkCronHeartbeat(kv, HOOK, T0, send)
    await checkCronHeartbeat(kv, HOOK, T0 + min(30), send)
    const [, stall] = send.mock.calls[0] as unknown as [string, { description: string }]
    expect(stall.description).not.toContain('Last run')
    expect(stall.description).toContain('No cron run has been recorded')
    expect(stored(kv)).toEqual({ at: T0, seeded: true, alertedAt: T0 + min(30) })

    await recordCronHeartbeat(kv, HOOK, T0 + min(60), send)
    const [, recovery] = send.mock.calls[1] as unknown as [string, { description: string }]
    expect(recovery.description).not.toContain('last run')
    expect(recovery.description).toContain('no cron run had been recorded')
    expect(stored(kv)).toEqual({ at: T0 + min(60) })
  })

  it('reads a value with a non-true seeded field as an ordinary heartbeat', () => {
    expect(parseHeartbeat(JSON.stringify({ at: 5, seeded: 'yes' }))).toEqual({ at: 5 })
    expect(parseHeartbeat(JSON.stringify({ at: 5, seeded: true }))).toEqual({ at: 5, seeded: true })
  })

  it('does not alert, or write, while the heartbeat is fresh', async () => {
    const kv = mockKV({ [CRON_HEARTBEAT_KEY]: JSON.stringify({ at: T0 }) })
    const send = okSend()
    expect(await checkCronHeartbeat(kv, HOOK, T0 + min(14), send)).toBe('fresh')
    expect(send).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('alerts once for a stall, keeps the last-run time, and dedups the next check', async () => {
    const kv = mockKV({ [CRON_HEARTBEAT_KEY]: JSON.stringify({ at: T0 }) })
    const send = okSend()
    const now = T0 + min(35)

    expect(await checkCronHeartbeat(kv, HOOK, now, send)).toBe('alerted')
    expect(send).toHaveBeenCalledTimes(1)
    const [url, embed] = send.mock.calls[0] as unknown as [string, { title: string; description: string }]
    expect(url).toBe(HOOK)
    expect(embed.title).toContain('Cron stalled')
    expect(embed.description).toContain('35 min')
    expect(embed.description).toContain('~6 missed slots')
    expect(embed.description).toContain(`Last run: ${new Date(T0).toISOString()}`)
    expect(embed.description).not.toContain('No cron run has been recorded')
    expect(embed.description).toContain(new Date(T0).toISOString())
    expect(stored(kv)).toEqual({ at: T0, alertedAt: now })

    expect(await checkCronHeartbeat(kv, HOOK, now + min(3), send)).toBe('deduped')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('repeats the alert hourly while the stall lasts', async () => {
    const kv = mockKV({ [CRON_HEARTBEAT_KEY]: JSON.stringify({ at: T0, alertedAt: T0 + min(20) }) })
    const send = okSend()
    expect(await checkCronHeartbeat(kv, HOOK, T0 + min(20) + STALL_REALERT_MS, send)).toBe('alerted')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not record an alert the webhook refused, so the next check retries it', async () => {
    const kv = mockKV({ [CRON_HEARTBEAT_KEY]: JSON.stringify({ at: T0 }) })
    const send = vi.fn(async () => false)
    expect(await checkCronHeartbeat(kv, HOOK, T0 + min(20), send)).toBe('send-failed')
    expect(kv.put).not.toHaveBeenCalled()
    expect(await checkCronHeartbeat(kv, HOOK, T0 + min(23), send)).toBe('send-failed')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('alerts nobody on an unparseable value or a failed read, and never throws', async () => {
    const send = okSend()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await checkCronHeartbeat(mockKV({ [CRON_HEARTBEAT_KEY]: 'garbage' }), HOOK, T0 + min(60), send)).toBe('unreadable')

    const broken = mockKV()
    broken.get.mockRejectedValue(new Error('kv down'))
    expect(await checkCronHeartbeat(broken, HOOK, T0 + min(60), send)).toBe('unreadable')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('recordCronHeartbeat', () => {
  it('stamps the run and sends nothing when no stall was reported', async () => {
    const kv = mockKV({ [CRON_HEARTBEAT_KEY]: JSON.stringify({ at: T0 - min(5) }) })
    const send = okSend()
    await recordCronHeartbeat(kv, HOOK, T0, send)
    expect(stored(kv)).toEqual({ at: T0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('reports the recovery after an alerted stall and clears the alert state', async () => {
    const kv = mockKV({ [CRON_HEARTBEAT_KEY]: JSON.stringify({ at: T0, alertedAt: T0 + min(20) }) })
    const send = okSend()
    await recordCronHeartbeat(kv, HOOK, T0 + min(185), send)
    expect(send).toHaveBeenCalledTimes(1)
    const [, embed] = send.mock.calls[0] as unknown as [string, { title: string; description: string }]
    expect(embed.title).toContain('Cron resumed')
    expect(embed.description).toContain('185 min')
    expect(embed.description).not.toMatch(/replayed|not sent/)
    expect(embed.description).toContain(`last run before the stall: ${new Date(T0).toISOString()}`)
    expect(embed.description).not.toContain('no cron run had been recorded')
    expect(stored(kv)).toEqual({ at: T0 + min(185) })
  })

  it('sends no recovery notice for a stamp it could not write, so the notice cannot repeat every cycle', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kv = mockKV({ [CRON_HEARTBEAT_KEY]: JSON.stringify({ at: T0, alertedAt: T0 + min(20) }) })
    kv.put.mockRejectedValue(new Error('kv write down'))
    const send = okSend()
    for (const offset of [60, 65, 70]) await recordCronHeartbeat(kv, HOOK, T0 + min(offset), send)
    expect(send).not.toHaveBeenCalled()
  })

  it('stamps the run before the recovery notice is sent, so a webhook that never answers cannot hold the stamp back', async () => {
    const kv = mockKV({ [CRON_HEARTBEAT_KEY]: JSON.stringify({ at: T0, alertedAt: T0 + min(20) }) })
    const hung = vi.fn(() => new Promise<boolean>(() => {}))
    void recordCronHeartbeat(kv, HOOK, T0 + min(60), hung)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(hung).toHaveBeenCalledTimes(1)
    expect(stored(kv)).toEqual({ at: T0 + min(60) })
  })

  it('still stamps the run when the state read fails or the recovery notice is refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unreadable = mockKV()
    unreadable.get.mockRejectedValue(new Error('kv down'))
    await recordCronHeartbeat(unreadable, HOOK, T0, okSend())
    expect(stored(unreadable)).toEqual({ at: T0 })

    const refused = mockKV({ [CRON_HEARTBEAT_KEY]: JSON.stringify({ at: T0 - min(60), alertedAt: T0 - min(40) }) })
    await recordCronHeartbeat(refused, HOOK, T0, vi.fn(async () => false))
    expect(stored(refused)).toEqual({ at: T0 })
  })

  it('does nothing without a KV binding or a webhook', async () => {
    const kv = mockKV()
    await recordCronHeartbeat(kv, undefined, T0, okSend())
    await recordCronHeartbeat(undefined, HOOK, T0, okSend())
    expect(kv.put).not.toHaveBeenCalled()
  })
})

describe('createWatchdogThrottle', () => {
  it('admits one check per interval', () => {
    const t = createWatchdogThrottle(WATCHDOG_INTERVAL_MS)
    expect(t.claim(T0)).toBe(true)
    expect(t.claim(T0 + WATCHDOG_INTERVAL_MS - 1)).toBe(false)
    expect(t.claim(T0 + WATCHDOG_INTERVAL_MS)).toBe(true)
  })
})

// `fetch` and `scheduled` are the real entry points. The system clock is faked (Date only) so the
// module-level throttle in index.ts can be crossed without waiting three minutes.
describe('wiring — the real fetch handler notices a stopped cron', () => {
  const ctx = () => {
    const pending: Promise<unknown>[] = []
    return { ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext, pending, settle: () => Promise.all(pending) }
  }
  const req = () => new Request('https://worker.invalid/api/no-such-route')

  it('alerts a stale heartbeat once, on the first request, then stays quiet inside the throttle and the dedup window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0 + min(40))
    const hookPosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === HOOK) hookPosts.push(JSON.parse(String(init?.body)).embeds[0].title)
      return new Response('', { status: 200 })
    }))
    const kv = mockKV({ [CRON_HEARTBEAT_KEY]: JSON.stringify({ at: T0 }) })
    const env = { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: HOOK } as never

    const first = ctx()
    await workerModule.fetch(req(), env, first.ctx)
    await first.settle()
    expect(hookPosts).toEqual(['🚨 Cron stalled'])
    expect(first.pending, 'the check must be handed to waitUntil, not run loose after the response').toHaveLength(1)

    const readsAfterFirst = kv.get.mock.calls.length
    const second = ctx()
    await workerModule.fetch(req(), env, second.ctx)
    await second.settle()
    expect(second.pending).toHaveLength(0)
    expect(kv.get.mock.calls.length, 'a request inside the throttle must not read KV').toBe(readsAfterFirst)

    vi.setSystemTime(T0 + min(40) + WATCHDOG_INTERVAL_MS + 1)
    const third = ctx()
    await workerModule.fetch(req(), env, third.ctx)
    await third.settle()
    expect(kv.get.mock.calls.length).toBeGreaterThan(readsAfterFirst)
    expect(hookPosts, 'the next check finds the alert recorded and stays quiet').toEqual(['🚨 Cron stalled'])
  })

  it('reads no KV at all when there is no webhook to alert on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0 + min(60))
    const kv = mockKV({ [CRON_HEARTBEAT_KEY]: JSON.stringify({ at: T0 }) })
    const { ctx: c, settle } = ctx()
    await workerModule.fetch(req(), { STATUS_CACHE: kv } as never, c)
    await settle()
    expect(kv.get).not.toHaveBeenCalled()
  })
})

describe('wiring — the real scheduled handler stamps the heartbeat and reports the recovery', () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  // Off the hour and mid-month, so no daily-summary or monthly branch is entangled (see the sibling
  // #1371 wiring test for why the event time is pinned).
  const event = { scheduledTime: Date.parse('2026-08-12T12:07:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent
  const OPERATIONAL: ServiceStatus[] = SERVICES.map(s => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))

  async function runCron(kv: ReturnType<typeof mockKV>) {
    const hookPosts: string[] = []
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== HOOK) throw new Error('network disabled in test')
      hookPosts.push(JSON.parse(String(init?.body)).embeds[0].title)
      return new Response('', { status: 200 })
    }))
    vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [] })
    const before = Date.now()
    await workerModule.scheduled(event, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: HOOK } as never, ctx)
    return { hookPosts, before }
  }

  it('writes the heartbeat as the first KV write of the run', async () => {
    const kv = mockKV()
    const { before } = await runCron(kv)
    expect(kv.put.mock.calls[0][0]).toBe(CRON_HEARTBEAT_KEY)
    expect(stored(kv).at).toBeGreaterThanOrEqual(before)
    expect(stored(kv).alertedAt).toBeUndefined()
  }, TEST_TIMEOUT_MS)

  it('sends the recovery notice once and clears the alert state when the cron comes back', async () => {
    const kv = mockKV({ [CRON_HEARTBEAT_KEY]: JSON.stringify({ at: T0, alertedAt: T0 + min(20) }) })
    const { hookPosts } = await runCron(kv)
    expect(hookPosts.filter(t => t.includes('Cron resumed'))).toHaveLength(1)
    expect(stored(kv).alertedAt).toBeUndefined()
  }, TEST_TIMEOUT_MS)
})

import { describe, it, expect } from 'vitest'
import {
  deliverToSubscribers,
  putConfirmed,
  encryptUrl,
  readConfirmed,
  fanoutDay,
  parseFanout,
  addFanout,
  recordFanout,
  computeTypeDelta,
  readSubscriberReport,
  FANOUT_PREFIX,
  FANOUT_TTL_S,
  type DeliveryStats,
  type SubscriptionFilters,
} from '../webhook-subscriptions'
import { completeInstall, manageSlack, handleSlackManageRequest, buildGoodbyeMessage, parseInstallFilters, slackManageNotice } from '../slack'
import { buildDailySummary, formatTypeDelta, formatFanoutLine } from '../daily-summary'
import type { AlertFeedEntry } from '../alert-feed'

function makeKV() {
  const store = new Map<string, string>()
  const meta = new Map<string, unknown>()
  const puts: Array<{ key: string; opts?: unknown }> = []
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, opts?: { metadata?: unknown }) => {
      store.set(k, v)
      puts.push({ key: k, opts })
      if (opts?.metadata !== undefined) meta.set(k, opts.metadata)
    },
    delete: async (k: string) => { store.delete(k); meta.delete(k) },
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort().map((name) => ({ name, metadata: meta.get(name) })),
      list_complete: true,
    }),
    _store: store,
    _puts: puts,
  } as unknown as KVNamespace & { _store: Map<string, string>; _puts: Array<{ key: string; opts?: unknown }> }
}

const KEY = 'c'.repeat(64)
const NOW = '2026-10-04T00:00:00.000Z'
const HOOK = 'https://hooks.slack.com/services/T1/B1/xxxxxxxxxxxxxxxxxxxxxxxx'
const FILTERS_ALL: SubscriptionFilters = { alertCondition: 'all', alertTarget: 'all', alertServices: [], alertIncidents: true }
const INSTALL = 'https://aiwatch-worker.p2c2kbf.workers.dev/api/slack/install'
const NOTICE = (fetchFn: typeof fetch) => ({ encKey: KEY, fetchFn, site: 'https://ai-watch.dev', installUrl: INSTALL })
const entry = (key = 'alerted:new:i1'): AlertFeedEntry => ({ key, kind: 'new', svcIds: ['claude'], embed: { title: 't', description: 'd', color: 1 }, ts: 1 })

function slackFetch(status: number, body: string) {
  const calls: Array<[string, RequestInit]> = []
  const fn = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    if (this !== undefined) throw new TypeError('Illegal invocation')
    const req = new Request(input, init)
    calls.push([req.url, { ...init, method: req.method }])
    return Promise.resolve(new Response(body, { status }))
  }
  return Object.assign(fn as unknown as typeof fetch, { calls })
}

describe('unsubscribe notice (#1590)', () => {
  async function installed() {
    const kv = makeKV()
    const r = await completeInstall(kv, KEY, { webhookUrl: HOOK, teamId: 'T1', channelId: 'C1' }, FILTERS_ALL, NOW)
    return { kv, ...r! }
  }

  it('posts the goodbye message to the channel, then deletes the subscription', async () => {
    const { kv, manageToken, hash } = await installed()
    const fetchFn = slackFetch(200, 'ok')
    expect(await manageSlack(kv, manageToken, 'unsubscribe', undefined, NOTICE(fetchFn))).toEqual({ ok: true })
    expect(fetchFn.calls).toHaveLength(1)
    expect(fetchFn.calls[0][0]).toBe(HOOK)
    expect(fetchFn.calls[0][1].method).toBe('POST')
    expect(JSON.parse(String(fetchFn.calls[0][1].body))).toEqual(buildGoodbyeMessage('https://ai-watch.dev', INSTALL, FILTERS_ALL))
    expect(await readConfirmed(kv, hash)).toBeNull()
  })

  it('still unsubscribes when the notice cannot be delivered', async () => {
    const { kv, manageToken, hash } = await installed()
    const fetchFn = async () => { throw new Error('reset') }
    expect(await manageSlack(kv, manageToken, 'unsubscribe', undefined, NOTICE(fetchFn as unknown as typeof fetch))).toEqual({ ok: true })
    expect(await readConfirmed(kv, hash)).toBeNull()
  })

  it('posts nothing for get or update', async () => {
    const { kv, manageToken } = await installed()
    const fetchFn = slackFetch(200, 'ok')
    const notice = NOTICE(fetchFn)
    await manageSlack(kv, manageToken, 'get', undefined, notice)
    await manageSlack(kv, manageToken, 'update', FILTERS_ALL, notice)
    expect(fetchFn.calls).toEqual([])
  })

  it('the HTTP handler passes the notice through', async () => {
    const { kv, manageToken } = await installed()
    const fetchFn = slackFetch(200, 'ok')
    const req = new Request('https://w.example/api/slack/manage', { method: 'POST', body: JSON.stringify({ token: manageToken, action: 'unsubscribe' }) })
    expect((await handleSlackManageRequest(req, kv, {}, NOTICE(fetchFn))).status).toBe(200)
    expect(fetchFn.calls).toHaveLength(1)
  })

  it('the message says alerts stopped and offers a one-click re-add with the same services, plus the settings', () => {
    const { text } = buildGoodbyeMessage('https://ai-watch.dev/', INSTALL, { ...FILTERS_ALL, alertTarget: 'custom', alertServices: ['claude', 'openai', 'bogus'] })
    expect(text).toContain('AIWatch alerts are turned off for this channel.')
    expect(text).toContain(`<${INSTALL}?services=claude,openai|Add to Slack>`)
    expect(text).toContain('<https://ai-watch.dev/#settings?focus=alerts|AIWatch settings>')
  })

  it('the re-add link restores every previous setting, not only the services', () => {
    for (const filters of [
      { alertCondition: 'down', alertTarget: 'custom', alertServices: ['claude'], alertIncidents: false },
      { alertCondition: 'down', alertTarget: 'all', alertServices: [], alertIncidents: true },
      { alertCondition: 'all', alertTarget: 'all', alertServices: [], alertIncidents: false },
      FILTERS_ALL,
    ] as SubscriptionFilters[]) {
      const link = /<([^|>]+)\|Add to Slack>/.exec(buildGoodbyeMessage('https://ai-watch.dev', INSTALL, filters).text)![1]
      expect(parseInstallFilters(new URL(link).searchParams)).toEqual(filters)
    }
  })

  it('the worker builds the notice from its env and its own origin', () => {
    const fetchFn = slackFetch(200, 'ok')
    expect(slackManageNotice({ WEBHOOK_ENC_KEY: KEY }, 'https://aiwatch-worker.p2c2kbf.workers.dev', fetchFn)).toEqual(NOTICE(fetchFn))
    expect(slackManageNotice({ WEBHOOK_ENC_KEY: KEY, CONFIRM_BASE_URL: 'https://preview.example' }, 'https://w.example', fetchFn))
      .toEqual({ encKey: KEY, fetchFn, site: 'https://preview.example', installUrl: 'https://w.example/api/slack/install' })
  })

  it('a channel that followed every service gets an unscoped re-add link', () => {
    expect(buildGoodbyeMessage('https://ai-watch.dev', INSTALL, FILTERS_ALL).text).toContain(`<${INSTALL}|Add to Slack>`)
  })
})

describe('fan-out delivery counts (#1590)', () => {
  it('counts delivered and failed per channel type', async () => {
    const kv = makeKV()
    await completeInstall(kv, KEY, { webhookUrl: HOOK, teamId: 'T1', channelId: 'C1' }, FILTERS_ALL, NOW)
    await putConfirmed(kv, 'd'.repeat(64), { encUrl: await encryptUrl('https://discord.com/api/webhooks/1/x', KEY), filters: FILTERS_ALL, type: 'discord', registeredAt: NOW, failCount: 0 })
    const stats = await deliverToSubscribers(kv, KEY, [entry('alerted:new:a'), entry('alerted:new:b')], async () => 500, 0, slackFetch(200, 'ok'))
    expect(stats.byType).toEqual({ discord: { delivered: 0, failed: 2 }, slack: { delivered: 2, failed: 0 } })
  })

  it('a Slack failure counts against Slack, whether Slack rejected the payload or the post failed', async () => {
    for (const [status, body] of [[400, 'invalid_payload'], [500, 'rollup_error']] as const) {
      const kv = makeKV()
      await completeInstall(kv, KEY, { webhookUrl: HOOK, teamId: 'T1', channelId: 'C1' }, FILTERS_ALL, NOW)
      const stats = await deliverToSubscribers(kv, KEY, [entry('alerted:new:a')], async () => 204, 0, slackFetch(status, body))
      expect(stats.byType).toEqual({ discord: { delivered: 0, failed: 0 }, slack: { delivered: 0, failed: 1 } })
    }
  })

  it('a report day is the 24h ending at 09:00 UTC on that date', () => {
    expect(fanoutDay(Date.parse('2026-10-03T09:00:00Z'))).toBe('2026-10-04')
    expect(fanoutDay(Date.parse('2026-10-04T08:59:59Z'))).toBe('2026-10-04')
    expect(fanoutDay(Date.parse('2026-10-04T09:00:00Z'))).toBe('2026-10-05')
  })

  it('accumulates cycles into the report day and writes nothing for a cycle that attempted nothing', async () => {
    const kv = makeKV()
    const now = Date.parse('2026-10-04T01:00:00Z')
    const stats = (slack: number, attempted = slack): DeliveryStats => ({ attempted, delivered: slack, pruned: 0, failed: 0, rejected: 0, byType: { discord: { delivered: 0, failed: 0 }, slack: { delivered: slack, failed: 0 } } })
    await recordFanout(kv, stats(2), now)
    await recordFanout(kv, stats(1), now)
    await recordFanout(kv, stats(0, 0), now)
    expect(parseFanout(kv._store.get(`${FANOUT_PREFIX}2026-10-04`) ?? null)).toEqual({ discord: { delivered: 0, failed: 0 }, slack: { delivered: 3, failed: 0 } })
    expect(kv._puts).toHaveLength(2)
    expect(kv._puts[0].opts).toEqual({ expirationTtl: FANOUT_TTL_S })
  })

  it('a failed read of the day\'s tally skips the cycle instead of overwriting it', async () => {
    const kv = makeKV()
    kv._store.set(`${FANOUT_PREFIX}2026-10-04`, JSON.stringify({ discord: { delivered: 0, failed: 0 }, slack: { delivered: 5, failed: 0 } }))
    ;(kv as { get: unknown }).get = async () => { throw new Error('kv down') }
    const stats: DeliveryStats = { attempted: 1, delivered: 1, pruned: 0, failed: 0, rejected: 0, byType: { discord: { delivered: 0, failed: 0 }, slack: { delivered: 1, failed: 0 } } }
    await recordFanout(kv, stats, Date.parse('2026-10-04T01:00:00Z'))
    expect(kv._puts).toEqual([])
  })

  it('a stored value that is not the expected shape reads as zeros, and garbage as null', () => {
    expect(parseFanout('{"slack":{"delivered":"x"}}')).toEqual({ discord: { delivered: 0, failed: 0 }, slack: { delivered: 0, failed: 0 } })
    expect(parseFanout('not json')).toBeNull()
    expect(parseFanout(null)).toBeNull()
    expect(addFanout(null, { discord: { delivered: 1, failed: 0 }, slack: { delivered: 0, failed: 2 } })).toEqual({ discord: { delivered: 1, failed: 0 }, slack: { delivered: 0, failed: 2 } })
  })
})

describe('the daily summary reads what the cron recorded (#1590)', () => {
  it('a delivery before the 09:00 UTC run shows in that run\'s report, one after it in the next', async () => {
    const kv = makeKV()
    await completeInstall(kv, KEY, { webhookUrl: HOOK, teamId: 'T1', channelId: 'C1' }, FILTERS_ALL, NOW)
    await deliverToSubscribers(kv, KEY, [entry('alerted:new:a')], async () => 204, Date.parse('2026-10-04T08:55:00Z'), slackFetch(200, 'ok'))
    await deliverToSubscribers(kv, KEY, [entry('alerted:new:b')], async () => 204, Date.parse('2026-10-04T09:05:00Z'), slackFetch(200, 'ok'))
    const report = await readSubscriberReport(kv, null, '2026-10-04', '2026-10-03')
    expect(report.fanoutCounts).toEqual({ discord: { delivered: 0, failed: 0 }, slack: { delivered: 1, failed: 0 } })
    expect((await readSubscriberReport(kv, null, '2026-10-05', '2026-10-04')).fanoutCounts?.slack.delivered).toBe(1)
  })

  it('an unreadable KV gives no figures instead of failing the report', async () => {
    const kv = makeKV()
    ;(kv as { get: unknown }).get = async () => { throw new Error('kv down') }
    expect(await readSubscriberReport(kv, { discord: 1, slack: 1 }, '2026-10-04', '2026-10-03')).toEqual({ newTodayByType: null, fanoutCounts: null })
  })

  it('a failed snapshot write still returns the figures', async () => {
    const kv = makeKV()
    kv._store.set(`${FANOUT_PREFIX}2026-10-04`, JSON.stringify({ discord: { delivered: 1, failed: 0 }, slack: { delivered: 0, failed: 0 } }))
    ;(kv as { put: unknown }).put = async () => { throw new Error('kv write failed') }
    expect(await readSubscriberReport(kv, { discord: 1, slack: 1 }, '2026-10-04', '2026-10-03'))
      .toEqual({ newTodayByType: null, fanoutCounts: { discord: { delivered: 1, failed: 0 }, slack: { delivered: 0, failed: 0 } } })
  })

  it('a day\'s per-type snapshot is the next day\'s baseline', async () => {
    const kv = makeKV()
    expect((await readSubscriberReport(kv, { discord: 5, slack: 1 }, '2026-10-03', '2026-10-02')).newTodayByType).toBeNull()
    expect((await readSubscriberReport(kv, { discord: 5, slack: 2 }, '2026-10-04', '2026-10-03')).newTodayByType).toEqual({ discord: 0, slack: 1 })
    expect(kv._puts.map((p) => p.opts)).toEqual([{ expirationTtl: 7 * 86400 }, { expirationTtl: 7 * 86400 }])
  })
})

describe('per-type subscriber delta (#1590)', () => {
  it('diffs against yesterday\'s per-type snapshot', () => {
    expect(computeTypeDelta({ discord: 5, slack: 2 }, '{"discord":5,"slack":1}')).toEqual({ discord: 0, slack: 1 })
  })
  it('no usable baseline gives no delta', () => {
    expect(computeTypeDelta({ discord: 5, slack: 2 }, null)).toBeNull()
    expect(computeTypeDelta({ discord: 5, slack: 2 }, '')).toBeNull()
    expect(computeTypeDelta({ discord: 5, slack: 2 }, '{"discord":5}')).toBeNull()
    expect(computeTypeDelta({ discord: 5, slack: 2 }, 'nope')).toBeNull()
  })
})

describe('daily report lines (#1590)', () => {
  it('formats the per-type change only when something moved', () => {
    expect(formatTypeDelta({ discord: 0, slack: 0 })).toBe('')
    expect(formatTypeDelta({ discord: 0, slack: 1 })).toBe(' (today: Discord ±0 · Slack +1)')
    expect(formatTypeDelta({ discord: -1, slack: 2 })).toBe(' (today: Discord −1 · Slack +2)')
  })
  it('formats what the fan-out sent, and nothing on a quiet day', () => {
    expect(formatFanoutLine(null)).toBe('')
    expect(formatFanoutLine({ discord: { delivered: 0, failed: 0 }, slack: { delivered: 0, failed: 0 } })).toBe('')
    expect(formatFanoutLine({ discord: { delivered: 3, failed: 0 }, slack: { delivered: 2, failed: 1 } })).toBe('📬 **Subscriber Alerts Sent**: Discord 3 · Slack 2 (1 failed)')
  })
  it('the summary uses the per-type change when it has one and the fan-out line when it has counts', () => {
    const base = { services: [], aiUsage: null, latencySnapshots: [], incidentCountToday: { newCount: 0, resolvedCount: 0 }, redditCount: 0 }
    const text = buildDailySummary({
      ...base,
      webhookCounts: { discord: 5, slack: 2, newToday: 1, newTodayByType: { discord: 0, slack: 1 } },
      fanoutCounts: { discord: { delivered: 3, failed: 0 }, slack: { delivered: 2, failed: 0 } },
    } as never)
    expect(text).toContain('🔗 **Active Alert Webhooks**: 7 (Discord 5 · Slack 2) (today: Discord ±0 · Slack +1)')
    expect(text).toContain('📬 **Subscriber Alerts Sent**: Discord 3 · Slack 2')
    const noBaseline = buildDailySummary({ ...base, webhookCounts: { discord: 5, slack: 2, newToday: 1, newTodayByType: null } } as never)
    expect(noBaseline).toContain('(Discord 5 · Slack 2) (+1 today)')
  })
})


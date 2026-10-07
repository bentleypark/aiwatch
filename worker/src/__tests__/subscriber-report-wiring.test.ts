// #1590 — drives the real `scheduled()` handler and asserts on the daily Discord report it sends.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../types'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'
import { FANOUT_PREFIX, TYPECOUNT_PREFIX, readConfirmed } from '../webhook-subscriptions'
import { completeInstall } from '../slack'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

const OPERATIONAL: ServiceStatus[] = SERVICES.map((s) => (
  { id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus
))

const RUN_AT = '2026-09-15T09:02:00.000Z'
const TODAY = '2026-09-15'
const YESTERDAY = '2026-09-14'

function makeKv(seed: Record<string, string>, subs: Array<{ hash: string; type: string }>) {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    get: async (key: string) => (key === 'services:latest' ? JSON.stringify(OPERATIONAL) : store.get(key) ?? null),
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      keys: prefix === 'webhook:sub:' ? subs.map((s) => ({ name: `webhook:sub:${s.hash}`, metadata: { type: s.type } })) : [],
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace
}

async function runCron(kv: KVNamespace): Promise<string | undefined> {
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }))
  await workerModule.scheduled({ scheduledTime: Date.parse(RUN_AT), cron: '*/5 * * * *' } as ScheduledEvent, {
    STATUS_CACHE: kv,
    DISCORD_WEBHOOK_URL: 'https://example.invalid/hook',
  } as never, ctx)
  for (const call of fetchMock.mock.calls) {
    if (call[0] !== 'https://example.invalid/hook') continue
    const body = (call[1] as RequestInit | undefined)?.body
    if (typeof body === 'string' && body.includes('AIWatch Daily Report')) return body
  }
  return undefined
}

const SUBS = [
  { hash: 'a'.repeat(64), type: 'discord' },
  { hash: 'b'.repeat(64), type: 'slack' },
  { hash: 'c'.repeat(64), type: 'slack' },
]

describe('#1590 the subscriber figures reach the daily Discord report', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('prints the per-type change against yesterday and what the fan-out sent into today', async () => {
    const body = await runCron(makeKv({
      [`${TYPECOUNT_PREFIX}${YESTERDAY}`]: JSON.stringify({ discord: 1, slack: 1 }),
      [`${FANOUT_PREFIX}${TODAY}`]: JSON.stringify({ discord: { delivered: 3, failed: 0 }, slack: { delivered: 2, failed: 1 } }),
    }, SUBS))

    expect(body).toBeDefined()
    expect(body).toContain('(today: Discord ±0 · Slack +1)')
    expect(body).toContain('📬 **Subscriber Alerts Sent**: Discord 3 · Slack 2 (1 failed)')
  })

  it('ignores a tally filed under another day and a snapshot written today', async () => {
    const body = await runCron(makeKv({
      [`${TYPECOUNT_PREFIX}${TODAY}`]: JSON.stringify({ discord: 1, slack: 1 }),
      [`${FANOUT_PREFIX}${YESTERDAY}`]: JSON.stringify({ discord: { delivered: 3, failed: 0 }, slack: { delivered: 2, failed: 0 } }),
    }, SUBS))

    expect(body).toBeDefined()
    expect(body).not.toContain('(today: Discord')
    expect(body).not.toContain('Subscriber Alerts Sent')
  })
})

describe('#1590 the manage route posts the goodbye before it deletes', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('unsubscribing through the worker posts to the channel while the subscription still exists', async () => {
    const KEY = 'c'.repeat(64)
    const HOOK = 'https://hooks.slack.com/services/T1/B1/xxxxxxxxxxxxxxxxxxxxxxxx'
    const store = new Map<string, string>()
    const meta = new Map<string, unknown>()
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string, o?: { metadata?: unknown }) => { store.set(k, v); if (o?.metadata !== undefined) meta.set(k, o.metadata) },
      delete: async (k: string) => { store.delete(k); meta.delete(k) },
      list: async ({ prefix }: { prefix?: string } = {}) => ({
        keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name, metadata: meta.get(name) })),
        list_complete: true,
      }),
    } as unknown as KVNamespace
    const installed = await completeInstall(kv, KEY, { webhookUrl: HOOK, teamId: 'T1', channelId: 'C1' },
      { alertCondition: 'down', alertTarget: 'all', alertServices: [], alertIncidents: true }, '2026-10-04T00:00:00.000Z')

    const posts: Array<{ text: string; subStillThere: boolean }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === HOOK) {
        posts.push({ text: JSON.parse(String(init?.body)).text, subStillThere: (await readConfirmed(kv, installed!.hash)) !== null })
      }
      return new Response('ok', { status: 200 })
    })

    const res = await workerModule.fetch(new Request('https://aiwatch-worker.example/api/slack/manage', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
      body: JSON.stringify({ token: installed!.manageToken, action: 'unsubscribe' }),
    }), { STATUS_CACHE: kv, WEBHOOK_ENC_KEY: KEY, ALLOWED_ORIGIN: '*' } as never, ctx)

    expect(res.status).toBe(200)
    expect(posts).toHaveLength(1)
    expect(posts[0].subStillThere).toBe(true)
    expect(posts[0].text).toContain('<https://aiwatch-worker.example/api/slack/install?condition=down|Add to Slack>')
    expect(posts[0].text).toContain('<https://ai-watch.dev/#settings?focus=alerts|AIWatch settings>')
    expect(await readConfirmed(kv, installed!.hash)).toBeNull()
  })
})

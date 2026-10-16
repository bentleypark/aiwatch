import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'
import type { RedditAlert } from '../reddit'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})
vi.mock('../reddit', async () => {
  const actual = await vi.importActual<typeof import('../reddit')>('../reddit')
  return { ...actual, detectRedditPosts: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'
import { detectRedditPosts } from '../reddit'
import { DISCORD_SEND_PREFIX, DISCORD_SEND_TTL_S } from '../discord-send-log'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const event = { scheduledTime: Date.parse('2026-08-12T12:02:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent

const statuses = (): ServiceStatus[] =>
  SERVICES.map(s => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))

const alert = (): RedditAlert => ({
  key: 'reddit:seen:t3_send_log', subreddit: 'ClaudeAI', type: 'outage', statusIds: ['claude'],
  post: { id: 't3_send_log', title: 'Is Claude down?', author: 'a', subreddit: 'ClaudeAI', url: 'https://www.reddit.com/r/ClaudeAI/comments/t3_send_log/', createdUtc: event.scheduledTime / 1000 - 600 },
} as RedditAlert)

type Put = { key: string; value: string; opts?: { expirationTtl?: number; metadata?: { title: string; ok: boolean } } }

// `overlapped` counts work the handler starts while a log put is in flight.
function fakeKv() {
  const puts: Put[] = []
  const probe = { inFlight: 0, overlapped: 0 }
  const touch = () => { if (probe.inFlight > 0) probe.overlapped++ }
  const kv = {
    get: async () => { touch(); return null },
    getWithMetadata: async () => { touch(); return { value: null, metadata: null } },
    put: async (key: string, value: string, opts?: Put['opts']) => {
      if (!key.startsWith(DISCORD_SEND_PREFIX)) { touch(); puts.push({ key, value, opts }); return }
      probe.inFlight++
      await new Promise(r => setTimeout(r, 250))
      probe.inFlight--
      puts.push({ key, value, opts })
    },
    delete: async () => { touch() },
    list: async () => { touch(); return { keys: [], list_complete: true, cacheStatus: null } },
  } as unknown as KVNamespace
  return { kv, puts, probe }
}

async function runCron(webhookStatus: number) {
  const { kv, puts, probe } = fakeKv()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const svc = statuses()
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: svc, enriched: svc, pageComponents: {}, upstreamFeeds: [] } as never)
  vi.mocked(detectRedditPosts).mockResolvedValue([alert()])
  const posted: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('example.invalid')) {
      if (probe.inFlight === 0) {
        for (const e of JSON.parse(String(init?.body ?? '{}')).embeds ?? []) posted.push(e.title)
      } else probe.overlapped++
      return new Response(null, { status: webhookStatus })
    }
    probe.overlapped += probe.inFlight > 0 ? 1 : 0
    return new Response('{}', { status: 200 })
  })
  await workerModule.scheduled(event, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' } as never, ctx)
  return { posted, sendLog: puts.filter(p => p.key.startsWith(DISCORD_SEND_PREFIX)), overlapped: probe.overlapped, unlanded: probe.inFlight }
}

describe('operator Discord send log — driven through the real scheduled() handler', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('writes one log key per delivered embed, carrying that embed\'s own title', async () => {
    const { posted, sendLog } = await runCron(204)
    expect(posted.length).toBeGreaterThan(0)
    expect(sendLog.map(p => p.opts?.metadata?.title)).toEqual(posted)
    for (const p of sendLog) {
      expect(p.opts?.metadata).toMatchObject({ ok: true })
      expect(p.opts?.expirationTtl).toBe(DISCORD_SEND_TTL_S)
    }
  })

  it('waits for the log write: the handler does nothing else while one is in flight', async () => {
    const { overlapped, unlanded } = await runCron(204)
    expect(overlapped).toBe(0)
    expect(unlanded).toBe(0)
  })

  it('logs a send the webhook REJECTED as ok:false', async () => {
    const { posted, sendLog } = await runCron(500)
    expect(posted.length).toBeGreaterThan(0)
    expect(sendLog).toHaveLength(posted.length)
    expect(sendLog.every(p => p.opts?.metadata?.ok === false)).toBe(true)
  })
})

describe('fetch entry', () => {
  it('points the log at the KV before handling a request', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
    expect(src).toMatch(/async handleFetch\([^)]*\)[^{]*\{\s*discordSendLogKv = env\.STATUS_CACHE/)
  })
})

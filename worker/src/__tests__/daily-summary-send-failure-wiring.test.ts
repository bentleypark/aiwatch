// #2050 — drives the real `scheduled()` handler: a daily report Discord rejects is not marked sent.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../types'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const OPERATIONAL: ServiceStatus[] = SERVICES.map((s) => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))
const RUN_AT = '2026-09-15T09:02:00.000Z'
const HOOK = 'https://example.invalid/hook'

async function runCron(reportStatus: number, runAt = RUN_AT, store = new Map<string, string>()) {
  const kv = {
    get: async (key: string) => (key === 'services:latest' ? JSON.stringify(OPERATIONAL) : store.get(key) ?? null),
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
  const posted: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    if (url === HOOK) {
      const title = (JSON.parse(body).embeds?.[0]?.title as string | undefined) ?? ''
      posted.push(title)
      if (title.includes('AIWatch Daily Report')) return new Response('{"embeds": ["0"]}', { status: reportStatus })
      return new Response(null, { status: 204 })
    }
    return new Response('{}', { status: 200 })
  })
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  await workerModule.scheduled({ scheduledTime: Date.parse(runAt), cron: '*/5 * * * *' } as ScheduledEvent, {
    STATUS_CACHE: kv,
    DISCORD_WEBHOOK_URL: HOOK,
  } as never, ctx)
  return { store, marker: store.get('daily-summary:2026-09-15'), posted, errors: errors.mock.calls.map((c) => c.map(String).join(' ')) }
}

describe('#2050 a daily report Discord rejects is not marked sent', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('a delivered report writes the marker', async () => {
    const r = await runCron(200)
    expect(r.posted.some((t) => t.includes('AIWatch Daily Report'))).toBe(true)
    expect(r.marker).toBe('1')
  })

  it('a rejected report writes no marker and the short fallback goes out', async () => {
    const r = await runCron(400)
    expect(r.marker).toBeUndefined()
    expect(r.posted).toContain('📊 Daily Summary')
  })

  it('after a rejected 09:00Z report, the 10:00Z catch-up run sends it again and marks it', async () => {
    const first = await runCron(400)
    vi.restoreAllMocks()
    const retry = await runCron(200, '2026-09-15T10:02:00.000Z', first.store)
    expect(retry.posted.some((t) => t.includes('AIWatch Daily Report'))).toBe(true)
    expect(retry.marker).toBe('1')
  })

  it('the failure log names the rejected description length', async () => {
    const r = await runCron(400)
    expect(r.errors.some((e) => /\[daily-summary\] Expanded report failed: .*description \d+ chars/.test(e))).toBe(true)
  })
})

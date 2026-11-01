import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../types'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'
import { guard3HoldKey } from '../monthly-archive'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

const OPERATIONAL: ServiceStatus[] = SERVICES.map((s) => (
  { id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus
))

const RUN_AT = '2026-09-15T09:02:00.000Z'

function makeKv(seed: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    get: async (key: string) => (key === 'services:latest' ? JSON.stringify(OPERATIONAL) : store.get(key) ?? null),
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
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

const held = (month: string, ids: string[]) => ({
  [guard3HoldKey(month)]: JSON.stringify(ids.map((id) => ({ svc: 'openrouter', id, title: `Chat is inaccessible ${id}`, startedAt: '2026-08-23T20:57:54.774Z', firstSeen: '2026-08-24T03:00:00.000Z' }))),
})

describe('#1154 a recorded guard-3 hold reaches the daily Discord report', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('names the hold from this month', async () => {
    const body = await runCron(makeKv(held('2026-09', ['YGz9Og5Qm8vO'])))
    expect(body).toBeDefined()
    expect(body).toContain('Phantom prune holds')
    expect(body).toContain('openrouter/YGz9Og5Qm8vO')
  })

  it('counts last month\'s hold too', async () => {
    const body = await runCron(makeKv(held('2026-08', ['AUG-ONE'])))
    expect(body).toContain('openrouter/AUG-ONE')
  })

  it('prints nothing when no hold was recorded — the other direction', async () => {
    const body = await runCron(makeKv({}))
    expect(body).toBeDefined()
    expect(body).not.toContain('Phantom prune holds')
  })
})

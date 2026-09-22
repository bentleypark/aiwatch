// #1470 — drives the real `scheduled()` handler and asserts on the Discord payload it sends.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../types'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

const OPERATIONAL: ServiceStatus[] = SERVICES.map((s) => (
  { id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus
))

const RUN_AT = '2026-09-15T09:02:00.000Z' // the daily-summary window, mid-month so no month-end path fires
const TODAY = '2026-09-15'

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
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [] })
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

const crossedThreshold = { [`fetch-fail:daily:claude:${TODAY}`]: '1' }
const recordedReasons = (counts: Record<string, Record<string, number>>) => ({
  [`instatus-parse-fail:${TODAY}`]: JSON.stringify({ counts, slots: {} }),
})

describe('#1470 the recorded reason reaches the daily Discord report', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('prints the reason beside the row it explains', async () => {
    const body = await runCron(makeKv({
      ...crossedThreshold,
      ...recordedReasons({ claude: { 'statuspage-non-json': 1 } }),
    }))

    expect(body).toBeDefined()
    expect(body).toContain('Unreadable Status Sources Today')
    expect(body).toContain('reasons: statuspage-non-json')
  })

  it('still prints the row when nothing was recorded — the other direction', async () => {
    const body = await runCron(makeKv({ ...crossedThreshold }))

    expect(body).toBeDefined()
    expect(body).toContain('1× threshold hit')
    expect(body).not.toContain('reasons:')
  })

  it('attributes each reason to its own service', async () => {
    const body = await runCron(makeKv({
      ...crossedThreshold,
      [`fetch-fail:daily:openai:${TODAY}`]: '2',
      ...recordedReasons({
        claude: { 'statuspage-non-json': 1 },
        openai: { 'statuspage-incidents-unreadable': 4 },
        cohere: { 'statuspage-fetch-unreadable': 9 },
      }),
    }))

    expect(body).toBeDefined()
    expect(body).toContain('reasons: statuspage-non-json')
    expect(body).toContain('reasons: statuspage-incidents-unreadable')
    expect(body).not.toContain('statuspage-fetch-unreadable')
  })

  it('lists every reason a service recorded that day, sorted', async () => {
    const body = await runCron(makeKv({
      ...crossedThreshold,
      ...recordedReasons({ claude: { 'statuspage-summary-unreadable': 2, 'statuspage-non-json': 1 } }),
    }))

    expect(body).toContain('reasons: statuspage-non-json, statuspage-summary-unreadable')
  })
})

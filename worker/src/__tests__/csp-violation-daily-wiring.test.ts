// #2026 — drives the real `scheduled()` handler: the CSP violation read reaches the daily Discord report.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../types'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'
import { CSP_VIOLATION_INDEX } from '../csp-violation'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const OPERATIONAL: ServiceStatus[] = SERVICES.map((s) => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))
const RUN_AT = '2026-09-15T09:02:00.000Z'

function makeKv() {
  const store = new Map<string, string>([['fetch-fail:daily:claude:2026-09-15', '1']])
  return {
    get: async (key: string) => (key === 'services:latest' ? JSON.stringify(OPERATIONAL) : store.get(key) ?? null),
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
}

async function runCron(): Promise<string | undefined> {
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    if (body.includes(`index1 = '${CSP_VIOLATION_INDEX}'`)) {
      return new Response(JSON.stringify({ data: [{ directive: 'connect-src', blocked: 'www.google.com', n: 4 }] }))
    }
    return new Response('{}', { status: 200 })
  })
  await workerModule.scheduled({ scheduledTime: Date.parse(RUN_AT), cron: '*/5 * * * *' } as ScheduledEvent, {
    STATUS_CACHE: makeKv(),
    DISCORD_WEBHOOK_URL: 'https://example.invalid/hook',
    CF_ACCOUNT_ID: 'acct',
    CF_ANALYTICS_TOKEN: 'tok',
  } as never, ctx)
  for (const call of fetchMock.mock.calls) {
    if (call[0] !== 'https://example.invalid/hook') continue
    const body = (call[1] as RequestInit | undefined)?.body
    if (typeof body === 'string' && body.includes('AIWatch Daily Report')) return body
  }
  return undefined
}

describe('#2026 the CSP violation read reaches the daily Discord report', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('prints the line from the WAE read', async () => {
    const body = await runCron()
    expect(body).toBeDefined()
    expect(body).toContain('CSP Violations** (24h): 4 — connect-src www.google.com ×4')
  })
})

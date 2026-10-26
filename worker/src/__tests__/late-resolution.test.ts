// #1797 — a row that starts before a month boundary and resolves after it. The fixture is the real
// 2026-09 chatgpt row: archived `monitoring` at the 2026-10-01 00:01 build, resolved 2026-10-01 23:44.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})
import { fetchAllServices, SERVICES } from '../services'
import workerModule from '../index'
import { TEST_TIMEOUT_MS } from './helpers/unreadable-source'
import {
  lateResolutionPeriods,
  findLateResolutions,
  formatLateResolutionAlert,
  lateResolutionDedupKey,
  checkLateResolutions,
} from '../late-resolution'
import type { ServiceStatus, Incident } from '../types'
import type { MonthlyIncidentEntry } from '../monthly-archive'

const NOW = Date.parse('2026-10-02T06:00:00Z')
const SPACE_ID = '01M3R1T4FCR1337FBBYY9K2RPB'

const row = (over: Partial<MonthlyIncidentEntry> = {}): MonthlyIncidentEntry => ({
  id: SPACE_ID,
  title: 'Elevated errors in ChatGPT Space Pages',
  startedAt: '2026-09-30T02:20:32Z',
  resolvedAt: null,
  durationMin: 0,
  finalStatus: 'monitoring',
  impact: 'minor',
  ...over,
})

const live = (over: Partial<Incident> = {}): Incident => ({
  id: SPACE_ID,
  title: 'Elevated errors in ChatGPT Space Pages and Canvas',
  status: 'resolved',
  impact: 'minor',
  startedAt: '2026-09-30T02:20:32.108Z',
  resolvedAt: '2026-10-01T23:44:57Z',
  duration: '45h 24m',
  timeline: [],
  ...over,
} as Incident)

const svc = (id: string, incidents: Incident[]): ServiceStatus =>
  ({ id, name: id === 'chatgpt' ? 'ChatGPT' : id, incidents } as unknown as ServiceStatus)

const archive = (rows: Record<string, MonthlyIncidentEntry[]>) =>
  ({ services: Object.fromEntries(Object.entries(rows).map(([id, incidentList]) => [id, { incidentList }])) })

describe('lateResolutionPeriods', () => {
  it('names the past month a resolved live incident started in', () => {
    expect(lateResolutionPeriods([svc('chatgpt', [live()])], NOW)).toEqual(['2026-09'])
  })

  it('ignores a current-month start, an unresolved incident, and synthesized or bridged rows', () => {
    const incidents = [
      live({ id: 'a', startedAt: '2026-10-01T10:00:00Z' }),
      live({ id: 'b', status: 'monitoring', resolvedAt: null }),
      live({ id: 'c', derived: 'status_history' } as Partial<Incident>),
      live({ id: 'd', retainedBridge: true } as Partial<Incident>),
      live({ id: 'e', resolvedAt: null }),
      live({ id: 'f', status: 'monitoring' }),
    ]
    expect(lateResolutionPeriods([svc('chatgpt', incidents)], NOW)).toEqual([])
  })
})

describe('findLateResolutions', () => {
  it('finds the boundary row: archived unresolved, resolved upstream', () => {
    expect(findLateResolutions('2026-09', archive({ chatgpt: [row()] }), [svc('chatgpt', [live()])])).toEqual([{
      period: '2026-09',
      svcId: 'chatgpt',
      svcName: 'ChatGPT',
      incId: SPACE_ID,
      title: 'Elevated errors in ChatGPT Space Pages',
      startedAt: '2026-09-30T02:20:32Z',
      resolvedAt: '2026-10-01T23:44:57Z',
      storedStatus: 'monitoring',
    }])
  })

  it('skips a row the archive already holds resolved', () => {
    const done = row({ finalStatus: 'resolved', resolvedAt: '2026-10-01T23:44:57Z', durationMin: 2724 })
    expect(findLateResolutions('2026-09', archive({ chatgpt: [done] }), [svc('chatgpt', [live()])])).toEqual([])
  })

  it('skips an incident still open upstream', () => {
    const open = live({ status: 'monitoring' })
    expect(findLateResolutions('2026-09', archive({ chatgpt: [row()] }), [svc('chatgpt', [open])])).toEqual([])
  })

  it('also reports a row resolved upstream inside its own month', () => {
    const june = row({ id: 'j1', startedAt: '2026-06-09T22:00:00Z', finalStatus: 'investigating' })
    const resolved = live({ id: 'j1', startedAt: '2026-06-09T22:00:00Z', resolvedAt: '2026-06-10T03:00:00Z' })
    expect(findLateResolutions('2026-06', archive({ chatgpt: [june] }), [svc('chatgpt', [resolved])]).map((r) => r.incId)).toEqual(['j1'])
  })

  it('matches only within the same service', () => {
    expect(findLateResolutions('2026-09', archive({ openai: [row()] }), [svc('chatgpt', [live()])])).toEqual([])
  })

  it('reports each service that carries the row', () => {
    const found = findLateResolutions('2026-09', archive({ chatgpt: [row()], openai: [row()] }),
      [svc('chatgpt', [live()]), svc('openai', [live()])])
    expect(found.map((r) => r.svcId)).toEqual(['chatgpt', 'openai'])
  })
})

describe('formatLateResolutionAlert', () => {
  it('names the row, the stored status, the archive key and the correction command', () => {
    const [r] = findLateResolutions('2026-09', archive({ chatgpt: [row()] }), [svc('chatgpt', [live()])])
    const { title, description } = formatLateResolutionAlert(r)
    expect(title).toBe('🗂️ ChatGPT — 2026-09 archive row still open, resolved upstream')
    expect(description).toContain(SPACE_ID)
    expect(description).toContain('resolved upstream 2026-10-01T23:44:57Z')
    expect(description).toContain('`archive:monthly:2026-09` still stores it as `monitoring`')
    expect(description).toContain('--period 2026-09 --correction')
  })
})

function memKV(init: Record<string, string> = {}) {
  const store = new Map(Object.entries(init))
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
  }
}

describe('checkLateResolutions', () => {
  const services = [svc('chatgpt', [live()])]
  const seeded = () => memKV({ 'archive:monthly:2026-09': JSON.stringify(archive({ chatgpt: [row()] })) })

  it('sends once, then stays quiet on the dedup marker', async () => {
    const kv = seeded()
    const send = vi.fn(async () => true)
    await checkLateResolutions(kv as never, 'https://discord.test', services, NOW, send)
    await checkLateResolutions(kv as never, 'https://discord.test', services, NOW, send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(kv.store.has(lateResolutionDedupKey({ period: '2026-09', svcId: 'chatgpt', incId: SPACE_ID }))).toBe(true)
  })

  it('does not mark a failed send, so the next run retries', async () => {
    const kv = seeded()
    const send = vi.fn(async () => false)
    await checkLateResolutions(kv as never, 'https://discord.test', services, NOW, send)
    await checkLateResolutions(kv as never, 'https://discord.test', services, NOW, send)
    expect(send).toHaveBeenCalledTimes(2)
    expect([...kv.store.keys()].some((k) => k.startsWith('alerted:late-res:'))).toBe(false)
  })

  it('reads no archive when no live incident started in a past month', async () => {
    const kv = seeded()
    const send = vi.fn(async () => true)
    await checkLateResolutions(kv as never, 'https://discord.test', [svc('chatgpt', [live({ startedAt: '2026-10-01T10:00:00Z' })])], NOW, send)
    expect(kv.get).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('survives a missing or unparseable archive without sending', async () => {
    const send = vi.fn(async () => true)
    await checkLateResolutions(memKV() as never, 'https://discord.test', services, NOW, send)
    await checkLateResolutions(memKV({ 'archive:monthly:2026-09': '{' }) as never, 'https://discord.test', services, NOW, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('does nothing without a webhook', async () => {
    const kv = seeded()
    const send = vi.fn(async () => true)
    await checkLateResolutions(kv as never, undefined, services, NOW, send)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('scheduled() wiring', () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  async function runAt(iso: string) {
    const store: Record<string, string> = { 'archive:monthly:2026-09': JSON.stringify(archive({ chatgpt: [row()] })) }
    const kv = {
      get: async (k: string) => store[k] ?? null,
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async (k: string, v: string) => { store[k] = v },
      delete: async (k: string) => { delete store[k] },
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace
    const posted: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      if (url.includes('discord')) posted.push(String(init?.body ?? ''))
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const roster = SERVICES.map((c) => ({ id: c.id, name: c.name, status: 'operational', incidents: c.id === 'chatgpt' ? [live()] : [] } as unknown as ServiceStatus))
    vi.mocked(fetchAllServices).mockResolvedValue({ raw: roster, enriched: roster, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
    const event = { scheduledTime: Date.parse(iso), cron: '*/5 * * * *' } as ScheduledEvent
    await workerModule.scheduled(event, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://discord.test/hook' } as never, ctx)
    return { posted: posted.join('\n'), store }
  }

  it('alerts from the real handler in the hourly slot', async () => {
    const { posted, store } = await runAt('2026-10-12T12:02:00.000Z')
    expect(posted).toContain('archive row still open, resolved upstream')
    expect(store[lateResolutionDedupKey({ period: '2026-09', svcId: 'chatgpt', incId: SPACE_ID })]).toBe('1')
  }, TEST_TIMEOUT_MS)

  it('stays out of the cycles between slots', async () => {
    const { posted } = await runAt('2026-10-12T12:07:00.000Z')
    expect(posted).not.toContain('archive row still open, resolved upstream')
  }, TEST_TIMEOUT_MS)
})

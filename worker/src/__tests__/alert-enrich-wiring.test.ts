// #1152 — the cron sends a new-incident alert at once when its inline analysis fails, then edits the
// AI section in on a later run. Driven through the real `scheduled()` handler.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'
import { TEST_TIMEOUT_MS } from './helpers/unreadable-source'
import { ENRICH_PENDING_KEY } from '../alert-enrich'
import { RECOVERY_BASELINE_KEY } from '../recovery-baseline'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, CACHE_KEY, fetchAllServices } from '../services'

const HOOK = 'https://example.invalid/hook'
const event = { scheduledTime: Date.parse('2026-08-12T12:07:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const OPERATIONAL: ServiceStatus[] = SERVICES.map(s => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))
const svcId = SERVICES[0].id

const active = {
  id: 'enr-1', title: 'Elevated error rates on the API', status: 'investigating', impact: 'major',
  startedAt: '2026-08-12T11:30:00.000Z', resolvedAt: null, duration: null,
  timeline: [{ stage: 'investigating', text: 'We are investigating elevated error rates.', at: '2026-08-12T11:32:00.000Z' }],
}
const services = OPERATIONAL.map(s => (s.id === svcId ? { ...s, status: 'degraded', incidents: [active] } : s)) as unknown as ServiceStatus[]
const analysis = { summary: 'Backfilled summary.', estimatedRecovery: '1–2h', estimatedRecoveryHours: 2, affectedScope: ['API'], needsFallback: false, analyzedAt: '2026-08-12T12:00:00.000Z', incidentId: 'enr-1', model: 'gemma', timelineHash: '2026-08-12T11:32:00.000Z' }

function fakeKv(seed: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed))
  store.set(CACHE_KEY, JSON.stringify({ services, upstreamFeeds: [], cachedAt: new Date().toISOString() }))
  return {
    store,
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async (key: string, value: string) => { store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
      list: async ({ prefix }: { prefix: string }) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace,
  }
}

async function run(seed: Record<string, string>, messageId: unknown = '987654321', ai: { run: unknown } | null = { run: vi.fn().mockRejectedValue(new Error('model down')) }, now = event.scheduledTime) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  const { kv, store } = fakeKv(seed)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === `${HOOK}?wait=true`) return messageId === 'reject' ? new Response('', { status: 500 }) : new Response(JSON.stringify({ id: messageId }), { status: 200 })
    if (url.startsWith(HOOK)) return new Response(null, { status: 204 })
    return new Response('', { status: 503 })
  })
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: services, enriched: services, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
  await workerModule.scheduled(event, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: HOOK, ...(ai ? { AI: ai } : {}) } as never, ctx)
  const calls = fetchSpy.mock.calls
    .filter(([u]) => String(u).startsWith(HOOK))
    .map(([u, init]) => ({ url: String(u), method: (init as RequestInit).method, body: String((init as RequestInit).body), embed: JSON.parse(String((init as RequestInit).body)).embeds?.[0] as { title: string; color: number; description: string; timestamp: string } | undefined }))
  const usage = JSON.parse(store.get('ai:usage:2026-08-12') ?? '{}')
  return { store, calls, usage }
}

describe('#1152 — publish, then enrich', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('sends the new-incident alert without waiting, and queues it for the AI section', async () => {
    const { store, calls, usage } = await run({})
    const sent = calls.filter((c) => c.body.includes('New Incident'))
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(`${HOOK}?wait=true`)
    expect(sent[0].body).not.toContain('AI ANALYSIS')
    const queued = JSON.parse(store.get(ENRICH_PENDING_KEY) ?? '[]')
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ messageId: '987654321', svcId, incId: 'enr-1' })
    expect(queued[0].full.startsWith(queued[0].core)).toBe(true)
    expect(queued[0].core.length).toBeLessThan(queued[0].full.length)
    expect(usage.aiLessSent).toBe(1)
  }, TEST_TIMEOUT_MS)

  it('edits the AI section into the sent alert once the analysis exists', async () => {
    const first = await run({})
    vi.restoreAllMocks(); vi.useRealTimers()
    const seed = Object.fromEntries([...first.store].filter(([k]) => k === ENRICH_PENDING_KEY || k.startsWith('alerted:new:')))
    const { store, calls, usage } = await run({ ...seed, [`ai:analysis:${svcId}:enr-1`]: JSON.stringify(analysis) })
    const edits = calls.filter((c) => c.method === 'PATCH')
    expect(edits).toHaveLength(1)
    expect(edits[0].url).toBe(`${HOOK}/messages/987654321`)
    expect(edits[0].body).toContain('AI ANALYSIS')
    expect(edits[0].body).toContain('Backfilled summary.')
    expect(edits[0].body).toContain('New Incident')
    expect(calls.filter((c) => c.body.includes('New Incident') && c.method === 'POST')).toHaveLength(0)
    expect(JSON.parse(store.get(ENRICH_PENDING_KEY) ?? '[]')).toEqual([])
    expect(usage.enriched).toBe(1)
  }, TEST_TIMEOUT_MS)

  it('the edited alert is the alert that would have been sent had the analysis been ready', async () => {
    const inline = { run: vi.fn().mockResolvedValue({ response: JSON.stringify({ summary: 'Backfilled summary.', estimatedRecovery: '1–2h', affectedScope: ['API'], needsFallback: false }) }) }
    const baseline = { [RECOVERY_BASELINE_KEY]: JSON.stringify({ [svcId]: { n: 12, medianMin: 40, p80Min: 95, since: '2026-06-01' } }) }
    const withAi = await run(baseline, '987654321', inline)
    const sentWithAi = withAi.calls.find((c) => c.body.includes('New Incident'))!.embed!
    const stored = withAi.store.get(`ai:analysis:${svcId}:enr-1`)!
    vi.restoreAllMocks(); vi.useRealTimers()
    const first = await run(baseline)
    const sentWithout = first.calls.find((c) => c.body.includes('New Incident'))!.embed!
    vi.restoreAllMocks(); vi.useRealTimers()
    const seed = Object.fromEntries([...first.store].filter(([k]) => k === ENRICH_PENDING_KEY || k.startsWith('alerted:new:')))
    const { calls } = await run({ ...baseline, ...seed, [`ai:analysis:${svcId}:enr-1`]: stored }, '987654321', undefined, event.scheduledTime + 5 * 60_000)
    const edit = calls.find((c) => c.method === 'PATCH')!.embed!
    expect(sentWithAi.description).toContain('AI ANALYSIS')
    expect(sentWithAi.description).toContain('Past incidents on this service')
    expect(edit.description).toBe(sentWithAi.description)
    expect({ title: edit.title, color: edit.color }).toEqual({ title: sentWithAi.title, color: sentWithAi.color })
    expect(edit.timestamp).toBe(sentWithout.timestamp)
  }, TEST_TIMEOUT_MS)

  it('leaves an alert queued while its stored analysis has no summary', async () => {
    const first = await run({})
    vi.restoreAllMocks(); vi.useRealTimers()
    const seed = Object.fromEntries([...first.store].filter(([k]) => k === ENRICH_PENDING_KEY || k.startsWith('alerted:new:')))
    const { store, calls } = await run({ ...seed, [`ai:analysis:${svcId}:enr-1`]: JSON.stringify({ ...analysis, summary: '' }) })
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
    expect(JSON.parse(store.get(ENRICH_PENDING_KEY) ?? '[]')).toHaveLength(1)
  }, TEST_TIMEOUT_MS)

  it('does not queue an alert whose analysis was skipped on purpose', async () => {
    const { store, calls, usage } = await run({}, '987654321', null)
    const sent = calls.filter((c) => c.body.includes('New Incident'))
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(HOOK)
    expect(store.get(ENRICH_PENDING_KEY)).toBeUndefined()
    expect(usage.aiLessSent).toBeUndefined()
  }, TEST_TIMEOUT_MS)

  it('does not count or queue an alert Discord rejected', async () => {
    const { store, usage } = await run({}, 'reject')
    expect(store.get(ENRICH_PENDING_KEY)).toBeUndefined()
    expect(usage.aiLessSent).toBeUndefined()
    expect(usage.enrichFailed).toBeUndefined()
  }, TEST_TIMEOUT_MS)

  it('an alert sent without a usable message id is counted as a failed edit, not queued', async () => {
    const { store, usage } = await run({}, 42)
    expect(JSON.parse(store.get(ENRICH_PENDING_KEY) ?? '[]')).toEqual([])
    expect(usage).toMatchObject({ aiLessSent: 1, enrichFailed: 1 })
  }, TEST_TIMEOUT_MS)
})

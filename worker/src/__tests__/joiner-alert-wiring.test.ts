// #2072 — a joiner's alert, driven through the real `scheduled()` handler: it names the incident it
// joined and carries the prior service's analysis instead of a fresh one.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'
import { TEST_TIMEOUT_MS } from './helpers/unreadable-source'

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
const active = {
  id: 'join-1', title: 'ChatGPT is experiencing elevated conversation errors', status: 'investigating', impact: 'minor',
  startedAt: '2026-08-12T11:30:00.000Z', resolvedAt: null, duration: null,
  timeline: [{ stage: 'investigating', text: 'We are investigating elevated error rates.', at: '2026-08-12T11:32:00.000Z' }],
}
const services = OPERATIONAL.map(s => (s.id === 'chatgpt' || s.id === 'codex' ? { ...s, status: 'degraded', incidents: [active] } : s)) as unknown as ServiceStatus[]
const prior = { summary: 'Prior ChatGPT summary.', estimatedRecovery: '45m–2h', estimatedRecoveryHours: 2, affectedScope: ['ChatGPT Paid Plans'], needsFallback: false, analyzedAt: '2026-08-12T11:40:00.000Z', incidentId: 'join-1', model: 'gemma', timelineHash: '2026-08-12T11:32:00.000Z' }

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

const fresh = () => ({ run: vi.fn().mockResolvedValue({ response: JSON.stringify({ summary: 'Fresh Codex summary.', estimatedRecovery: '2h–5h', affectedScope: ['Conversation Engine'], needsFallback: false }) }) })
const rosterSeed = { 'alerted:new:join-1': JSON.stringify(['chatgpt']) }

describe('#2072 — joiner alert through the cron', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('names the prior service and carries its analysis', async () => {
    const ai = fresh()
    const { calls, store } = await run({ ...rosterSeed, 'ai:analysis:chatgpt:join-1': JSON.stringify(prior) }, '987654321', ai)
    const sent = calls.filter((c) => c.embed?.title.includes('Codex'))
    expect(sent).toHaveLength(1)
    expect(sent[0].embed!.title).toContain('Codex — Now Affected')
    expect(sent[0].embed!.description).toContain('🔗 Already affecting ChatGPT — Codex was added to this incident later.')
    expect(sent[0].embed!.description).toContain('Prior ChatGPT summary.')
    expect(sent[0].embed!.description).not.toContain('Fresh Codex summary.')
    expect(ai.run).not.toHaveBeenCalled()
    expect(JSON.parse(store.get('ai:analysis:codex:join-1')!).summary).toBe('Prior ChatGPT summary.')
  }, TEST_TIMEOUT_MS)

  it("keeps the joiner's own analysis over the prior service's", async () => {
    const own = { ...prior, summary: 'Own Codex summary.' }
    const { calls, store } = await run({ ...rosterSeed, 'ai:analysis:chatgpt:join-1': JSON.stringify(prior), 'ai:analysis:codex:join-1': JSON.stringify(own) }, '987654321', fresh())
    const sent = calls.filter((c) => c.embed?.title.includes('Codex'))
    expect(sent[0].embed!.description).toContain('Own Codex summary.')
    expect(JSON.parse(store.get('ai:analysis:codex:join-1')!).summary).toBe('Own Codex summary.')
  }, TEST_TIMEOUT_MS)

  it('analyzes as before when the prior service has no analysis', async () => {
    const ai = fresh()
    const { calls } = await run(rosterSeed, '987654321', ai)
    const sent = calls.filter((c) => c.embed?.title.includes('Codex'))
    expect(sent).toHaveLength(1)
    expect(sent[0].embed!.description).toContain('Fresh Codex summary.')
    expect(ai.run).toHaveBeenCalled()
  }, TEST_TIMEOUT_MS)
})

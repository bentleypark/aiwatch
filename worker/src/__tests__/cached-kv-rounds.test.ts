// #1531 part 3 — `/api/status/cached?series=0` awaited 9 KV round trips back to back; in Workers Logs a
// SIN request spent 4.9 s of wall time on 17 ms of CPU before the 5 s Edge budget cancelled it.
// The KV below answers every outstanding read together, one round per macrotask, so the round count
// is the number of trips a request waits on back to back.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import workerModule from '../index'
import type { ServiceStatus } from '../types'

const NOW = Date.now()
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const SERVICES = [
  {
    id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', status: 'degraded',
    latency: null, uptime30d: 99.9, lastChecked: iso(0),
    incidents: [{ id: 'inc-live', title: 'Elevated errors', status: 'investigating', impact: 'minor', startedAt: iso(3_600_000), duration: null, timeline: [] }],
  },
  {
    id: 'openai', name: 'OpenAI API', provider: 'OpenAI', category: 'api', status: 'operational',
    latency: null, uptime30d: 99.9, lastChecked: iso(0),
    incidents: [{ id: 'inc-done', title: 'Latency', status: 'resolved', impact: 'minor', startedAt: iso(7_200_000), resolvedAt: iso(1_800_000), duration: '1h', timeline: [] }],
  },
  {
    id: 'gemini', name: 'Gemini API', provider: 'Google', category: 'api', status: 'operational',
    latency: null, uptime30d: 99.9, lastChecked: iso(0),
    incidents: [{ id: 'inc-marker', title: 'Errors', status: 'resolved', impact: 'minor', startedAt: iso(7_200_000), resolvedAt: iso(1_800_000), duration: '1h', timeline: [] }],
  },
] as unknown as ServiceStatus[]

function makeEnv() {
  const store = new Map<string, string>([
    ['services:latest', JSON.stringify({ services: SERVICES, cachedAt: iso(0) })],
    ['ai:analysis:claude:inc-live', JSON.stringify({ summary: 's', estimatedRecovery: '1h', affectedScope: [], analyzedAt: iso(0) })],
    ['recovered:gemini:inc-marker', '1'],
    ['ai:analysis:openai:inc-done', JSON.stringify({ summary: 's', estimatedRecovery: '-', affectedScope: [], analyzedAt: iso(0), resolvedAt: iso(1_800_000) })],
    ['security:seen:osv:X', '1'],
    ['probe:summaries', JSON.stringify([])],
    ['probe:24h', JSON.stringify({ snapshots: [] })],
    ['latency:24h', JSON.stringify({ snapshots: [] })],
  ])
  let rounds = 0
  let queue: Array<() => void> = []
  const reads: Array<[string, number]> = []
  const enqueue = <T>(key: string, answer: () => T): Promise<T> => new Promise((resolve) => {
    reads.push([key, rounds + 1])
    if (queue.length === 0) setTimeout(() => { rounds++; const batch = queue; queue = []; batch.forEach((f) => f()) }, 0)
    queue.push(() => resolve(answer()))
  })
  const kv = {
    get: (k: string) => enqueue(k, () => store.get(k) ?? null),
    getWithMetadata: (k: string) => enqueue(k, () => ({ value: store.get(k) ?? null, metadata: null })),
    list: ({ prefix }: { prefix: string }) => enqueue(`list:${prefix}`, () => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true })),
    put: async () => {}, delete: async () => {},
  } as unknown as KVNamespace
  return { env: { ALLOWED_ORIGIN: '*', STATUS_CACHE: kv } as unknown as Parameters<typeof workerModule.fetch>[1], reads }
}

beforeEach(() => {
  ;(globalThis as unknown as { caches: unknown }).caches = {
    default: { match: async () => undefined, put: async () => {} },
  }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

async function get(query: string) {
  const { env, reads } = makeEnv()
  const res = await workerModule.fetch(
    new Request(`https://example.com/api/status/cached${query}`),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  )
  const inRound = (n: number) => reads.filter(([, r]) => r === n).map(([k]) => k).sort()
  return { body: await res.json() as Record<string, unknown>, inRound, lastRound: Math.max(...reads.map(([, r]) => r)) }
}

const WAVE_READS = [
  'ai:analysis:claude:inc-live', 'alert:feed:recent', 'list:security:seen:', 'probe:summaries', 'report:feed:claude',
]
const DEPENDENT_READS = [
  'ai:analysis:gemini:inc-marker', 'ai:analysis:openai:inc-done',
  'recovered:gemini:inc-marker', 'recovered:openai:inc-done',
  'security:seen:osv:X',
]

describe('/api/status/cached sequential KV round trips (#1531 part 3)', () => {
  it('?series=0: snapshot, then every reader in one wave, then only the reads that depend on it', async () => {
    const { body, inRound, lastRound } = await get('?series=0')
    expect(lastRound).toBe(3)
    expect(inRound(1)).toEqual(['services:latest'])
    expect(inRound(2)).toEqual(WAVE_READS)
    expect(inRound(3)).toEqual(DEPENDENT_READS)
    expect(Object.keys(body.aiAnalysis as object).sort()).toEqual(['claude', 'openai'])
    expect(body.recentlyRecovered).toEqual({ gemini: ['inc-marker'], openai: ['inc-done'] })
  }, 60_000)

  it('the default response reads its time series in the same wave', async () => {
    const { inRound, lastRound } = await get('')
    expect(lastRound).toBe(3)
    expect(inRound(2)).toEqual([...WAVE_READS, 'latency:24h', 'probe:24h'].sort())
    expect(inRound(3)).toEqual(DEPENDENT_READS)
  }, 60_000)
})

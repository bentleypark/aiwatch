// #1224 Phase 3 — the /feed handler computes `feedReq` (which service(s) this request actually
// serves) but two of its three per-incident KV-read loops (`feed:firstseen`, `analysisKey`) used to
// ignore it and iterate EVERY cached service regardless of scope — reading (then discarding) 44/45
// services' worth of KV state on every single-service /feed/{slug} poll. The census (#1224 Phase 2)
// found the residual unattributed reads arrive in sharp bursts and root-caused it to exactly this
// path. Driven behaviourally through the real `fetch` handler, like the sibling census wiring tests
// in kv-read-census.test.ts — a source-text assertion is a hand-written parser that a rename defeats
// (`feedback_pin_the_decision_not_the_spelling`).

import { describe, it, expect, vi, afterEach } from 'vitest'
import workerModule from '../index'
import { analysisKey } from '../ai-analysis'
import type { ServiceStatus, Incident } from '../types'
import { CACHE_KEY } from '../services'

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    title: 'API errors',
    status: 'investigating',
    impact: 'major',
    startedAt: '2026-05-10T12:00:00.000Z',
    resolvedAt: null,
    duration: null,
    timeline: [],
    ...over,
  }
}

function service(over: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    id: 'claude',
    name: 'Claude',
    provider: 'Anthropic',
    category: 'api',
    status: 'operational',
    latency: null,
    uptime30d: null,
    lastChecked: '2026-05-19T00:00:00.000Z',
    incidents: [],
    ...over,
  }
}

/** A KV stand-in that records every `get` key and serves `services:latest` from a fixture. */
function fakeKv(servicesLatest: ServiceStatus[]) {
  const getCalls: string[] = []
  const kv = {
    get: (key: string) => {
      getCalls.push(key)
      if (key === CACHE_KEY) {
        return Promise.resolve(JSON.stringify({ services: servicesLatest, cachedAt: new Date().toISOString() }))
      }
      return Promise.resolve(null) // every other key: clean miss (get-or-set paths still exercise their write)
    },
    getWithMetadata: () => Promise.resolve({ value: null, metadata: null }),
    put: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
  return { kv, getCalls }
}

describe('/feed/{slug} scopes its per-incident KV reads to the requested service (#1224 Phase 3)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const claude = service({
    id: 'claude', name: 'Claude',
    incidents: [incident({ id: 'claude-inc', status: 'investigating' })],
  })
  const openai = service({
    id: 'openai', name: 'OpenAI',
    incidents: [incident({ id: 'openai-inc', status: 'investigating' })],
  })

  async function runFeed(path: string) {
    const { kv, getCalls } = fakeKv([claude, openai])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await workerModule.fetch(
      new Request(`https://example.com${path}`),
      { ALLOWED_ORIGIN: '*', STATUS_CACHE: kv } as never,
      { waitUntil: (p: Promise<unknown>) => { void p.catch(() => {}) }, passThroughOnException: () => {} } as never,
    )
    return { response, getCalls }
  }

  it('a service-scoped request reads only that service\'s feed:firstseen/analysis keys, not the other service\'s', async () => {
    const { response, getCalls } = await runFeed('/feed/claude')
    expect(response.status).toBe(200)

    // The requested service's own per-incident state IS read.
    expect(getCalls).toContain('feed:firstseen:claude-inc')
    expect(getCalls).toContain(analysisKey('claude', 'claude-inc'))

    // #1224 — a service-scoped feed must not spend a KV read on a DIFFERENT service's incident
    // state. Before the fix these two loops iterated `cached.services` unconditionally, so this
    // failed: reverting either `.filter((svc) => inServedScope(svc.id))` added to the
    // feed:firstseen/analysisKey loops in index.ts turns this red again.
    expect(getCalls).not.toContain('feed:firstseen:openai-inc')
    expect(getCalls).not.toContain(analysisKey('openai', 'openai-inc'))
  })

  it('an all-scope /feed.xml request DOES read every service\'s state — the scoping is per-request, not a blanket drop', async () => {
    const { response, getCalls } = await runFeed('/feed.xml')
    expect(response.status).toBe(200)
    expect(getCalls).toContain('feed:firstseen:claude-inc')
    expect(getCalls).toContain(analysisKey('claude', 'claude-inc'))
    expect(getCalls).toContain('feed:firstseen:openai-inc')
    expect(getCalls).toContain(analysisKey('openai', 'openai-inc'))
  })
})

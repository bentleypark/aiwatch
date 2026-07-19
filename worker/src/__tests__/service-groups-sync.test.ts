// #1068 — pin the worker fine-category mirror (service-groups.ts GROUP_MEMBERS) ↔ the frontend source
// of truth (src/utils/constants.js SERVICE_CATEGORIES). The worker exposes this on /api/v1/status as
// `group`; the frontend drives the sidebar/Overview filters. They MUST agree — a service added to one
// side only would make the public API's `group` disagree with the dashboard. Same discipline as
// api-tier-sync.test.ts (#403): a drift fails CI, so it can't be added to one side only.

import { describe, it, expect } from 'vitest'
import workerModule from '../index'
import { GROUP_MEMBERS, serviceGroupOf, type ServiceGroup } from '../service-groups'
import { SERVICES } from '../services'
import type { ServiceStatus } from '../types'
// Data-only import across the frontend boundary — works because both `src/` trees share one repo /
// node_modules (Vitest resolves it), and constants.js reads no env at module load that would throw
// (import.meta.env is undefined here → its `||` fallback applies). Same as api-tier-sync.test.ts.
import { SERVICE_CATEGORIES } from '../../../src/utils/constants'

// The real (rankable) category buckets — every SERVICE_CATEGORIES key except the UI-only `all` (ids:null).
const catGroups = Object.entries(SERVICE_CATEGORIES as Record<string, { ids: string[] | null }>)
  .filter(([, def]) => Array.isArray(def.ids)) as [string, { ids: string[] }][]

describe('service-groups.ts ≡ SERVICE_CATEGORIES cross-mirror (#1068)', () => {
  it('the group SET matches on both sides (no group only in one)', () => {
    expect(Object.keys(GROUP_MEMBERS).sort()).toEqual(catGroups.map(([g]) => g).sort())
  })

  for (const [group, def] of catGroups) {
    it(`${group}: member ids match the frontend exactly`, () => {
      const worker = GROUP_MEMBERS[group as ServiceGroup]
      expect(worker, `group "${group}" missing from worker GROUP_MEMBERS`).toBeDefined()
      expect([...worker].sort()).toEqual([...def.ids].sort())
    })
  }

  it('every monitored SERVICES id has a fine group (completeness)', () => {
    const missing = SERVICES.filter((s) => serviceGroupOf(s.id) === undefined).map((s) => s.id)
    expect(missing, `SERVICES ids with no group: ${missing.join(', ')}`).toEqual([])
  })

  it('every id in GROUP_MEMBERS is a real monitored service (no stale id)', () => {
    const realIds = new Set(SERVICES.map((s) => s.id))
    const stale = Object.values(GROUP_MEMBERS).flat().filter((id) => !realIds.has(id))
    expect(stale, `GROUP_MEMBERS ids not in SERVICES: ${stale.join(', ')}`).toEqual([])
  })

  it('serviceGroupOf returns undefined for an unknown id', () => {
    expect(serviceGroupOf('not-a-service')).toBeUndefined()
  })
})

// #1068 — the sync tests above pin the pure MAP; this drives the real /api/v1/status handler and asserts
// the `group` field actually reaches the response body. Without it, dropping the `group:` line in
// index.ts (or passing `svc.category` instead of `svc.id`) would leave every sync test green — the
// "tested twin" failure this repo has logged repeatedly.
describe('/api/v1/status exposes `group` on the real handler (#1068)', () => {
  const CACHE_KEY = 'services:latest'
  const svc = (id: string, category: 'api' | 'app' | 'agent'): ServiceStatus => ({
    id, name: id, provider: id, category, status: 'operational',
    latency: null, uptime30d: 99.9, lastChecked: '2026-07-19T00:00:00Z', incidents: [],
  } as unknown as ServiceStatus)

  // One service per coarse category, each with a known fine group.
  const fixture = [svc('claude', 'api'), svc('elevenlabs', 'api'), svc('claudecode', 'agent'), svc('chatgpt', 'app')]

  function makeEnv() {
    const store = new Map<string, string>()
    store.set(CACHE_KEY, JSON.stringify({ services: fixture, cachedAt: '2026-07-19T00:00:00Z' }))
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
    } as unknown as KVNamespace
    return { STATUS_CACHE: kv, ANALYTICS: undefined } as unknown as Parameters<typeof workerModule.fetch>[1]
  }

  it('the list route sets group = serviceGroupOf(id) for every service', async () => {
    const res = await workerModule.fetch(new Request('https://ai-watch.dev/api/v1/status'), makeEnv(), {} as ExecutionContext)
    expect(res.status).toBe(200)
    const body = await res.json() as { services: { id: string; group?: string }[] }
    expect(body.services.map((s) => s.group)).toEqual(['llm', 'voice', 'agents', 'apps'])
    for (const s of body.services) expect(s.group, s.id).toBe(serviceGroupOf(s.id))
  })

  it('the single-service route sets group too (catches a wiring drop on the other twin)', async () => {
    const res = await workerModule.fetch(new Request('https://ai-watch.dev/api/v1/status/claude'), makeEnv(), {} as ExecutionContext)
    expect(res.status).toBe(200)
    const body = await res.json() as { service: { id: string; group?: string } }
    expect(body.service.group).toBe('llm')
  })
})

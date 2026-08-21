import { describe, it, expect } from 'vitest'
import workerModule from '../index'
import type { ServiceStatus } from '../types'

// #1268 — `/api/v1/status` is the one consumer that cannot be told about `incidentSourceStale` out of
// band. Every in-repo surface (Ranking, Uptime, is-down, fallback, the archive) reads the flag; an
// external consumer of the public wire contract received no source-liveness field at all, so for the
// reported state it saw:
//
//   {"id":"characterai","status":"operational","uptime30d":null,
//    "incidentCount":0,"aiwatchScore":75,"scoreGrade":"good","scoreConfidence":"medium"}
//
// and could not tell `incidentCount: 0` on a quiet month from `incidentCount: 0` on a status source we
// never read. `uptime30d: null` + `medium` does not discriminate — that pair is the NORMAL shape of a
// healthy probed service with no official uptime.
//
// Driven through the real `workerModule.fetch`, the `service-groups-sync.test.ts` (#1068) pattern, for
// the same reason it was used there: both response shapes are hand-built object literals, so a wiring
// drop on either twin is invisible to any test that does not issue the request.

const CACHE_KEY = 'services:latest'

const svc = (id: string, over: Partial<ServiceStatus> = {}): ServiceStatus => ({
  id, name: id, provider: id, category: 'app', status: 'operational',
  latency: null, uptime30d: null, lastChecked: '2026-08-20T00:00:00Z', incidents: [], ...over,
} as unknown as ServiceStatus)

// The reported state beside a readable control, so every assertion below has something to contrast with.
const fixture = [svc('characterai', { incidentSourceStale: true }), svc('claude', { category: 'api', uptime30d: 99.9 })]

function makeEnv() {
  const store = new Map<string, string>()
  store.set(CACHE_KEY, JSON.stringify({ services: fixture, cachedAt: '2026-08-20T00:00:00Z' }))
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  } as unknown as KVNamespace
  return { STATUS_CACHE: kv, ANALYTICS: undefined } as unknown as Parameters<typeof workerModule.fetch>[1]
}

const get = async (path: string) =>
  workerModule.fetch(new Request(`https://ai-watch.dev${path}`), makeEnv(), {} as ExecutionContext)

describe('#1268 — /api/v1/status carries source liveness', () => {
  it('the list route emits incidentSourceStale for an unread feed', async () => {
    const res = await get('/api/v1/status')
    expect(res.status).toBe(200)
    const body = await res.json() as { services: { id: string; incidentSourceStale?: boolean }[] }
    const target = body.services.find((s) => s.id === 'characterai')!
    expect(target.incidentSourceStale).toBe(true)
  })

  it('the single-service route emits it too (the other hand-built twin)', async () => {
    const res = await get('/api/v1/status/characterai')
    expect(res.status).toBe(200)
    const body = await res.json() as { service: { incidentSourceStale?: boolean } }
    expect(body.service.incidentSourceStale).toBe(true)
  })

  it('a readable service carries no such field on either route — additive, absent when false', async () => {
    // The control that makes the two above mean something, and the compatibility claim: an existing
    // consumer of a healthy service sees a byte-identical payload to before.
    const list = await (await get('/api/v1/status')).json() as { services: { id: string }[] }
    const readable = list.services.find((s) => s.id === 'claude')!
    expect('incidentSourceStale' in readable).toBe(false)

    const one = await (await get('/api/v1/status/claude')).json() as { service: object }
    expect('incidentSourceStale' in one.service).toBe(false)
  })
})

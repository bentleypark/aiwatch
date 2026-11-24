import { describe, it, expect } from 'vitest'
import workerModule, { scoreFor, scoreFields, withScore } from '../index'
import { hasSufficientCoverage, MIN_COVERAGE_DAYS } from '../services'
import type { ServiceStatus } from '../types'

// #2061 — a service under the 30-day coverage gate (#802) is held out of the Ranking, and its Score
// number and grade are null on the routes below. The fixtures differ ONLY in `coverageDays`, so a null
// number can come from nothing else.

const CACHE_KEY = 'services:latest'

const svc = (id: string, over: Partial<ServiceStatus> = {}): ServiceStatus => ({
  id, name: id, provider: id, category: 'api', status: 'operational',
  latency: null, uptime30d: 99.9, lastChecked: '2026-11-24T00:00:00Z', incidents: [], ...over,
} as unknown as ServiceStatus)

const fixture = [
  svc('established'),
  svc('gated', { coverageDays: 12 }),
  svc('edge-29', { coverageDays: MIN_COVERAGE_DAYS - 1 }),
  svc('edge-30', { coverageDays: MIN_COVERAGE_DAYS }),
]

function makeEnv() {
  const store = new Map<string, string>()
  store.set(CACHE_KEY, JSON.stringify({ services: fixture, cachedAt: '2026-11-24T00:00:00Z' }))
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  } as unknown as KVNamespace
  return { STATUS_CACHE: kv, ANALYTICS: undefined } as unknown as Parameters<typeof workerModule.fetch>[1]
}

const get = async (path: string) =>
  workerModule.fetch(new Request(`https://ai-watch.dev${path}`), makeEnv(), {} as ExecutionContext)

type Published = { id: string; aiwatchScore: number | null; scoreGrade: string | null; scoreConfidence: string; coverageDays?: number }

describe('hasSufficientCoverage', () => {
  it.each([
    [undefined, true],
    [0, false],
    [MIN_COVERAGE_DAYS - 1, false],
    [MIN_COVERAGE_DAYS, true],
    [MIN_COVERAGE_DAYS + 1, true],
  ])('coverageDays %s → %s', (coverageDays, expected) => {
    expect(hasSufficientCoverage({ coverageDays })).toBe(expected)
  })
})

describe('scoreFields — the published Score under the coverage gate', () => {
  const scored = (s: ServiceStatus) => scoreFor(s, undefined)

  it('withholds the number and grade below the gate and keeps the evidence', () => {
    const gated = fixture[1]
    const real = scored(gated)
    expect(real.score).not.toBeNull() // the Worker still computes it: the control for the null below
    const out = scoreFields(gated, real)
    expect(out.aiwatchScore).toBeNull()
    expect(out.scoreGrade).toBeNull()
    expect(out.scoreConfidence).toBe(real.confidence)
    expect(out.scoreBreakdown).toEqual(real.breakdown)
    expect(out.scoreMetrics).toEqual(real.metrics)
  })

  it('publishes the same number for 30 days of coverage and for an established service', () => {
    const established = scoreFields(fixture[0], scored(fixture[0]))
    const atGate = scoreFields(fixture[3], scored(fixture[3]))
    expect(established.aiwatchScore).not.toBeNull()
    expect(atGate.aiwatchScore).toBe(established.aiwatchScore)
    expect(atGate.scoreGrade).toBe(established.scoreGrade)
    expect(scoreFields(fixture[2], scored(fixture[2])).aiwatchScore).toBeNull()
  })

  it('withScore carries the same decision', () => {
    expect(withScore(fixture[1], scored(fixture[1])).aiwatchScore).toBeNull()
    expect(withScore(fixture[0], scored(fixture[0])).aiwatchScore).not.toBeNull()
  })
})

describe('the served surfaces', () => {
  it('/api/v1/status withholds the number for a gated service and says why', async () => {
    const body = await (await get('/api/v1/status')).json() as { services: Published[] }
    const by = (id: string) => body.services.find((s) => s.id === id)!
    expect(by('gated').aiwatchScore).toBeNull()
    expect(by('gated').scoreGrade).toBeNull()
    expect(by('gated').scoreConfidence).toBe(by('established').scoreConfidence)
    expect(by('gated').coverageDays).toBe(12)
    expect(by('edge-29').aiwatchScore).toBeNull()
    expect(by('edge-30').aiwatchScore).toBe(by('established').aiwatchScore)
    expect(by('established').aiwatchScore).not.toBeNull()
    expect('coverageDays' in by('established')).toBe(false)
  })

  it('/api/v1/status/:id carries the same decision', async () => {
    const gated = (await (await get('/api/v1/status/gated')).json() as { service: Published }).service
    const established = (await (await get('/api/v1/status/established')).json() as { service: Published }).service
    expect(gated.aiwatchScore).toBeNull()
    expect(gated.scoreGrade).toBeNull()
    expect(gated.coverageDays).toBe(12)
    expect(established.aiwatchScore).not.toBeNull()
    expect('coverageDays' in established).toBe(false)
  })

  it('/api/status/cached, which the dashboard and the Edge pages read, carries the same decision', async () => {
    const res = await get('/api/status/cached')
    expect(res.status).toBe(200)
    const body = await res.json() as { services: Published[] }
    const by = (id: string) => body.services.find((s) => s.id === id)!
    expect(by('gated').aiwatchScore).toBeNull()
    expect(by('gated').scoreGrade).toBeNull()
    expect(by('gated').coverageDays).toBe(12)
    expect(by('edge-30').aiwatchScore).not.toBeNull()
    expect(by('established').aiwatchScore).not.toBeNull()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import workerModule from '../index'
import { carryForwardUptime, CACHE_KEY } from '../services'
import { UPTIME_MISSING_ALERT_MS } from '../utils'
import type { ServiceStatus } from '../types'

const NOW = Date.parse('2026-10-11T09:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const svc = (id: string, fields: Partial<ServiceStatus> = {}) => ({ id, uptime30d: null, lastChecked: iso(0), ...fields }) as ServiceStatus

describe('#1489 carryForwardUptime', () => {
  it('fills a failed read with the previous snapshot figure and its provenance', () => {
    const services = [svc('claude')]
    const prev = [svc('claude', { uptime30d: 99.86, uptimeSource: 'official', uptimeWindowDays: 21, uptimeReported: 99.9, uptimeReportedDays: 90, lastChecked: iso(60_000) })]
    expect(carryForwardUptime(services, prev, NOW)).toEqual(['claude'])
    expect(services[0]).toMatchObject({ uptime30d: 99.86, uptimeSource: 'official', uptimeWindowDays: 21, uptimeReported: 99.9, uptimeReportedDays: 90, uptimeCarriedFrom: iso(60_000) })
  })

  it('leaves a fresh reading alone', () => {
    const services = [svc('claude', { uptime30d: 99.5 })]
    carryForwardUptime(services, [svc('claude', { uptime30d: 99.86, lastChecked: iso(60_000) })], NOW)
    expect(services[0].uptime30d).toBe(99.5)
    expect(services[0].uptimeCarriedFrom).toBeUndefined()
  })

  it('carries nothing for a service that never published uptime', () => {
    const services = [svc('bedrock')]
    expect(carryForwardUptime(services, [svc('bedrock')], NOW)).toEqual([])
    expect(services[0].uptime30d).toBeNull()
  })

  it('stops carrying once the last real reading is older than the uptime-missing alert threshold', () => {
    const fresh = [svc('claude')]
    carryForwardUptime(fresh, [svc('claude', { uptime30d: 99.86, lastChecked: iso(UPTIME_MISSING_ALERT_MS) })], NOW)
    expect(fresh[0].uptime30d).toBe(99.86)
    const stale = [svc('claude')]
    carryForwardUptime(stale, [svc('claude', { uptime30d: 99.86, lastChecked: iso(UPTIME_MISSING_ALERT_MS + 1) })], NOW)
    expect(stale[0].uptime30d).toBeNull()
  })

  it('ages a carried figure from its original reading, not from the snapshot that carried it', () => {
    const services = [svc('claude')]
    const prev = [svc('claude', { uptime30d: 99.86, lastChecked: iso(60_000), uptimeCarriedFrom: iso(UPTIME_MISSING_ALERT_MS + 1) })]
    expect(carryForwardUptime(services, prev, NOW)).toEqual([])
    expect(services[0].uptime30d).toBeNull()
  })

  it("carries today's weighted outage seconds only within the same UTC day", () => {
    const sameDay = [svc('claude')]
    carryForwardUptime(sameDay, [svc('claude', { uptime30d: 99.86, todayWeightedOutageSec: 120, lastChecked: iso(60_000) })], NOW)
    expect(sameDay[0].todayWeightedOutageSec).toBe(120)
    const yesterday = [svc('claude')]
    carryForwardUptime(yesterday, [svc('claude', { uptime30d: 99.86, todayWeightedOutageSec: 120, lastChecked: '2026-10-10T23:59:00.000Z' })], Date.parse('2026-10-11T00:01:00.000Z'))
    expect(yesterday[0].uptime30d).toBe(99.86)
    expect(yesterday[0].todayWeightedOutageSec).toBeUndefined()
  })

  it('does nothing without a previous snapshot', () => {
    const services = [svc('claude')]
    expect(carryForwardUptime(services, null, NOW)).toEqual([])
  })
})

describe('#1489 carry-forward on the live /api/status path', () => {
  afterEach(() => vi.unstubAllGlobals())

  const store = new Map<string, string>()
  function seededEnv(writeDataPoint = vi.fn()) {
    const today = new Date().toISOString().slice(0, 10)
    store.clear()
    for (const [k, v] of [
      ['tracking:state', JSON.stringify({ claude: { uptimeSeenAt: today } })],
      [CACHE_KEY, JSON.stringify({
        services: [{ id: 'claude', status: 'operational', uptime30d: 99.86, uptimeSource: 'official', lastChecked: new Date(Date.now() - 60_000).toISOString(), incidents: [] }],
        upstreamFeeds: [],
        cachedAt: new Date(Date.now() - 60_000).toISOString(),
      })],
    ] as const) store.set(k, v)
    return {
      STATUS_CACHE: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => { store.set(k, v) },
        delete: async (k: string) => { store.delete(k) },
        list: async () => ({ keys: [], list_complete: true }),
      },
      ANALYTICS: { writeDataPoint },
      ALLOWED_ORIGIN: '*',
    } as unknown as Parameters<typeof workerModule.fetch>[1]
  }
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

  it('publishes the last good figure for a service whose read failed, and still counts it as a null read', async () => {
    const healthySummary = JSON.stringify({ page: {}, status: { indicator: 'none', description: 'ok' }, components: [], incidents: [] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(healthySummary, { status: 200, headers: { 'content-type': 'application/json' } })))
    const writeDataPoint = vi.fn()
    const res = await workerModule.fetch(new Request('https://aiwatch.test/api/status'), seededEnv(writeDataPoint), ctx)
    const body = await res.json() as { services: ServiceStatus[] }
    expect(body.services.filter((s) => s.status === 'degraded')).toEqual([])
    const claude = body.services.find((s) => s.id === 'claude')!
    expect(claude.uptime30d).toBe(99.86)
    expect(claude.uptimeCarriedFrom).toBeDefined()
    const row = writeDataPoint.mock.calls.map(([p]) => p as { blobs: string[]; indexes: string[] }).find((p) => p.indexes[0] === 'status-fetch-run')!
    expect(row.blobs[1].split(',')).toContain('claude')
    expect(JSON.parse(store.get('tracking:state')!).claude.uptimeMissingSince).toBeDefined()
  }, 60_000)
})

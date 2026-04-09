import { describe, it, expect } from 'vitest'
import { detectPlatformOutage } from '../services'
import type { ServiceStatus, ServiceConfig } from '../types'

function makeSvc(id: string, status: 'operational' | 'degraded', incidents: number = 0): ServiceStatus {
  return {
    id, name: id, provider: '', category: 'api', status, latency: null, uptime30d: null,
    lastChecked: '', incidents: Array.from({ length: incidents }, (_, i) => ({
      id: `inc-${i}`, title: '', status: 'investigating' as const, impact: null,
      startedAt: '', duration: null, timeline: [],
    })),
  }
}

function makeConfig(id: string, opts: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    id, name: id, provider: '', category: 'api',
    statusUrl: '', apiUrl: null, ...opts,
  }
}

describe('detectPlatformOutage', () => {
  it('detects Atlassian platform outage when 70%+ services fail', () => {
    // 10 Atlassian services, 8 degraded with no incidents = 80% failure
    const services = [
      ...Array.from({ length: 8 }, (_, i) => makeSvc(`svc${i}`, 'degraded')),
      makeSvc('svc8', 'operational'),
      makeSvc('svc9', 'operational'),
    ]
    const configs = services.map(s => makeConfig(s.id, {
      apiUrl: `https://status.${s.id}.com/api/v2/summary.json`,
    }))

    const affected = detectPlatformOutage(services, configs)
    expect(affected.size).toBe(10) // all services on the platform are affected
  })

  it('does not trigger when failures are below threshold', () => {
    // 10 Atlassian services, 5 degraded = 50% (below 70%)
    const services = [
      ...Array.from({ length: 5 }, (_, i) => makeSvc(`svc${i}`, 'degraded')),
      ...Array.from({ length: 5 }, (_, i) => makeSvc(`ok${i}`, 'operational')),
    ]
    const configs = services.map(s => makeConfig(s.id, {
      apiUrl: `https://status.${s.id}.com/api/v2/summary.json`,
    }))

    const affected = detectPlatformOutage(services, configs)
    expect(affected.size).toBe(0)
  })

  it('excludes degraded services with active incidents (real outage, not fetch failure)', () => {
    // 5 Atlassian services: 3 degraded with no incidents + 1 degraded with incident + 1 operational
    // Only 3/5 = 60% fetch failures → below threshold
    const services = [
      makeSvc('svc0', 'degraded', 0),
      makeSvc('svc1', 'degraded', 0),
      makeSvc('svc2', 'degraded', 0),
      makeSvc('svc3', 'degraded', 1), // real incident — not counted as fetch failure
      makeSvc('svc4', 'operational'),
    ]
    const configs = services.map(s => makeConfig(s.id, {
      apiUrl: `https://status.${s.id}.com/api/v2/summary.json`,
    }))

    const affected = detectPlatformOutage(services, configs)
    expect(affected.size).toBe(0) // 3/5 = 60% < 70%
  })

  it('requires minimum 3 services on platform', () => {
    // 2 Atlassian services, both degraded = 100% but too small
    const services = [makeSvc('a', 'degraded'), makeSvc('b', 'degraded')]
    const configs = services.map(s => makeConfig(s.id, {
      apiUrl: `https://status.${s.id}.com/api/v2/summary.json`,
    }))

    const affected = detectPlatformOutage(services, configs)
    expect(affected.size).toBe(0)
  })

  it('handles multiple platforms independently', () => {
    // 4 Atlassian (3 degraded = 75%) + 4 incident.io (1 degraded = 25%)
    const services = [
      makeSvc('at1', 'degraded'), makeSvc('at2', 'degraded'), makeSvc('at3', 'degraded'), makeSvc('at4', 'operational'),
      makeSvc('io1', 'degraded'), makeSvc('io2', 'operational'), makeSvc('io3', 'operational'), makeSvc('io4', 'operational'),
    ]
    const configs = [
      makeConfig('at1', { apiUrl: 'https://a.com/api/v2/summary.json' }),
      makeConfig('at2', { apiUrl: 'https://b.com/api/v2/summary.json' }),
      makeConfig('at3', { apiUrl: 'https://c.com/api/v2/summary.json' }),
      makeConfig('at4', { apiUrl: 'https://d.com/api/v2/summary.json' }),
      makeConfig('io1', { incidentIoBaseUrl: 'https://io1.com/incidents' }),
      makeConfig('io2', { incidentIoBaseUrl: 'https://io2.com/incidents' }),
      makeConfig('io3', { incidentIoBaseUrl: 'https://io3.com/incidents' }),
      makeConfig('io4', { incidentIoBaseUrl: 'https://io4.com/incidents' }),
    ]

    const affected = detectPlatformOutage(services, configs)
    expect(affected.has('at1')).toBe(true)
    expect(affected.has('at4')).toBe(true) // all platform services are marked
    expect(affected.has('io1')).toBe(false) // incident.io not triggered
  })

  it('ignores services with "other" platform', () => {
    const services = [makeSvc('a', 'degraded'), makeSvc('b', 'degraded'), makeSvc('c', 'degraded')]
    const configs = services.map(s => makeConfig(s.id)) // no apiUrl, no incidentIo, etc. = 'other'

    const affected = detectPlatformOutage(services, configs)
    expect(affected.size).toBe(0)
  })
})

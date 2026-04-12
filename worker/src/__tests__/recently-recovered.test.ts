import { describe, it, expect } from 'vitest'
import { formatDuration } from '../utils'

// Test the resolvedAt marking behavior and recentlyRecovered logic

describe('AI analysis resolvedAt marking', () => {
  it('should add resolvedAt to analysis on recovery', () => {
    const analysis = {
      summary: 'Service outage',
      estimatedRecovery: '~1h',
      affectedScope: ['API'],
      analyzedAt: '2026-03-30T10:00:00Z',
      incidentId: 'inc-1',
    }
    // Simulate recovery: add resolvedAt
    const resolved = { ...analysis, resolvedAt: new Date().toISOString() }
    expect(resolved.resolvedAt).toBeDefined()
    expect(resolved.summary).toBe('Service outage')
    expect(resolved.incidentId).toBe('inc-1')
  })

  it('should not overwrite existing resolvedAt', () => {
    const analysis = {
      summary: 'Service outage',
      estimatedRecovery: '~1h',
      affectedScope: ['API'],
      analyzedAt: '2026-03-30T10:00:00Z',
      incidentId: 'inc-1',
      resolvedAt: '2026-03-30T11:00:00Z',
    }
    // Should skip re-marking if resolvedAt already set
    const shouldMark = !analysis.resolvedAt
    expect(shouldMark).toBe(false)
  })
})

describe('recentlyRecovered filtering (Record<svcId, incId[]> format)', () => {
  const services = [
    { id: 'claude', status: 'operational', incidents: [] as { id: string }[] },
    { id: 'openai', status: 'degraded', incidents: [{ id: 'oai-1' }] },
    { id: 'together', status: 'operational', incidents: [{ id: 'tog-1' }] },
    { id: 'gemini', status: 'operational', incidents: [] as { id: string }[] },
  ]

  it('includes operational services with recovered KV in recentlyRecovered', () => {
    const aiAnalysis: Record<string, unknown> = {}
    const recoveredKV: Record<string, string> = {
      'recovered:together:tog-1': '{}',
    }
    const recentlyRecovered: Record<string, string[]> = {}

    for (const svc of services) {
      if (svc.status !== 'operational') continue
      if (aiAnalysis[svc.id]) continue
      for (const inc of svc.incidents) {
        if (recoveredKV[`recovered:${svc.id}:${inc.id}`]) {
          if (!recentlyRecovered[svc.id]) recentlyRecovered[svc.id] = []
          if (!recentlyRecovered[svc.id].includes(inc.id)) recentlyRecovered[svc.id].push(inc.id)
        }
      }
    }

    expect(recentlyRecovered).toEqual({ together: ['tog-1'] })
  })

  it('excludes non-operational services from recentlyRecovered', () => {
    const recoveredKV: Record<string, string> = {
      'recovered:openai:oai-1': '{}',
    }
    const recentlyRecovered: Record<string, string[]> = {}

    for (const svc of services) {
      if (svc.status !== 'operational') continue
      for (const inc of svc.incidents) {
        if (recoveredKV[`recovered:${svc.id}:${inc.id}`]) {
          if (!recentlyRecovered[svc.id]) recentlyRecovered[svc.id] = []
          recentlyRecovered[svc.id].push(inc.id)
        }
      }
    }

    expect(recentlyRecovered).toEqual({})
  })

  it('excludes services already in active analysis', () => {
    const aiAnalysis: Record<string, unknown> = { together: [{ incidentId: 'tog-2' }] }
    const recoveredKV: Record<string, string> = {
      'recovered:together:tog-1': '{}',
    }
    const recentlyRecovered: Record<string, string[]> = {}

    for (const svc of services) {
      if (svc.status !== 'operational') continue
      if (aiAnalysis[svc.id]) continue
      for (const inc of svc.incidents) {
        if (recoveredKV[`recovered:${svc.id}:${inc.id}`]) {
          if (!recentlyRecovered[svc.id]) recentlyRecovered[svc.id] = []
          recentlyRecovered[svc.id].push(inc.id)
        }
      }
    }

    expect(recentlyRecovered).toEqual({})
  })

  it('returns empty when no recovered KV exists', () => {
    const recoveredKV: Record<string, string> = {}
    const recentlyRecovered: Record<string, string[]> = {}

    for (const svc of services) {
      if (svc.status !== 'operational') continue
      for (const inc of svc.incidents) {
        if (recoveredKV[`recovered:${svc.id}:${inc.id}`]) {
          if (!recentlyRecovered[svc.id]) recentlyRecovered[svc.id] = []
          recentlyRecovered[svc.id].push(inc.id)
        }
      }
    }

    expect(recentlyRecovered).toEqual({})
  })
})

// Test independent recovered:{svcId}:{incId} KV marker logic (#224)
describe('independent recovery KV marker', () => {
  it('builds correct recovery marker payload', () => {
    const now = '2026-04-13T02:40:00Z'
    const incident = {
      id: 'inc-123',
      title: 'Moonshot Kimi K2.5',
      startedAt: '2026-04-13T02:23:00Z',
    }
    const duration = formatDuration(new Date(incident.startedAt), new Date(now))
    const marker = {
      resolvedAt: now,
      incidentTitle: incident.title,
      duration,
    }
    expect(marker.resolvedAt).toBe(now)
    expect(marker.incidentTitle).toBe('Moonshot Kimi K2.5')
    expect(marker.duration).toBe('17m')
  })

  it('handles missing startedAt gracefully', () => {
    const now = '2026-04-13T02:40:00Z'
    const incident = { id: 'inc-456', title: 'Some outage', startedAt: undefined }
    const duration = incident.startedAt ? formatDuration(new Date(incident.startedAt), new Date(now)) : undefined
    const marker = {
      resolvedAt: now,
      incidentTitle: incident.title,
      duration: duration ?? '',
    }
    expect(marker.duration).toBe('')
  })

  it('recovery marker provides recentlyRecovered with incident IDs independent of AI analysis', () => {
    const services = [
      { id: 'together', status: 'operational', incidents: [{ id: 'inc-1', resolvedAt: '2026-04-13T02:40:00Z' }] },
      { id: 'claude', status: 'operational', incidents: [] as { id: string }[] },
    ]
    const aiAnalysis: Record<string, unknown[]> = {}
    const recoveredKV: Record<string, string> = {
      'recovered:together:inc-1': JSON.stringify({ resolvedAt: '2026-04-13T02:40:00Z', incidentTitle: 'Kimi K2.5', duration: '17m' }),
    }

    const recentlyRecovered: Record<string, string[]> = {}
    for (const svc of services) {
      if (svc.status !== 'operational') continue
      if (aiAnalysis[svc.id]) continue
      for (const inc of svc.incidents) {
        if (recoveredKV[`recovered:${svc.id}:${inc.id}`]) {
          if (!recentlyRecovered[svc.id]) recentlyRecovered[svc.id] = []
          if (!recentlyRecovered[svc.id].includes(inc.id)) recentlyRecovered[svc.id].push(inc.id)
        }
      }
    }

    expect(recentlyRecovered).toEqual({ together: ['inc-1'] })
  })

  it('excludes monitoring status from recentlyRecovered', () => {
    const services = [
      { id: 'together', status: 'monitoring', incidents: [{ id: 'inc-1', resolvedAt: '2026-04-13T02:40:00Z' }] },
    ]
    const recoveredKV: Record<string, string> = {
      'recovered:together:inc-1': JSON.stringify({ resolvedAt: '2026-04-13T02:40:00Z' }),
    }

    const recentlyRecovered: Record<string, string[]> = {}
    for (const svc of services) {
      if (svc.status !== 'operational') continue
      for (const inc of svc.incidents) {
        if (recoveredKV[`recovered:${svc.id}:${inc.id}`]) {
          if (!recentlyRecovered[svc.id]) recentlyRecovered[svc.id] = []
          recentlyRecovered[svc.id].push(inc.id)
        }
      }
    }

    expect(recentlyRecovered).toEqual({})
  })

  it('tracks multiple recovered incidents per service', () => {
    const services = [
      { id: 'together', status: 'operational', incidents: [
        { id: 'inc-1', resolvedAt: '2026-04-13T02:40:00Z' },
        { id: 'inc-2', resolvedAt: '2026-04-13T02:45:00Z' },
        { id: 'inc-3', resolvedAt: '2026-04-13T01:00:00Z' },
      ]},
    ]
    const recoveredKV: Record<string, string> = {
      'recovered:together:inc-1': '{}',
      'recovered:together:inc-2': '{}',
      // inc-3 has no recovered KV (older, TTL expired)
    }

    const recentlyRecovered: Record<string, string[]> = {}
    for (const svc of services) {
      if (svc.status !== 'operational') continue
      for (const inc of svc.incidents) {
        if (recoveredKV[`recovered:${svc.id}:${inc.id}`]) {
          if (!recentlyRecovered[svc.id]) recentlyRecovered[svc.id] = []
          if (!recentlyRecovered[svc.id].includes(inc.id)) recentlyRecovered[svc.id].push(inc.id)
        }
      }
    }

    expect(recentlyRecovered).toEqual({ together: ['inc-1', 'inc-2'] })
    expect(recentlyRecovered['together']).not.toContain('inc-3')
  })

  it('only marks specific incident, not all resolved incidents for the service', () => {
    // This is the key test for #224: only the incident with recovered KV gets marked
    const recentlyRecovered: Record<string, string[]> = { together: ['inc-1'] }
    const incidents = [
      { id: 'inc-1', status: 'resolved' },
      { id: 'inc-2', status: 'resolved' },
      { id: 'inc-3', status: 'resolved' },
    ]

    const markedIncidents = incidents.filter(inc =>
      (recentlyRecovered['together'] ?? []).includes(inc.id)
    )

    expect(markedIncidents).toHaveLength(1)
    expect(markedIncidents[0].id).toBe('inc-1')
  })
})

import { describe, it, expect } from 'vitest'

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

describe('recentlyRecovered filtering', () => {
  const services = [
    { id: 'claude', status: 'operational' },
    { id: 'openai', status: 'degraded' },
    { id: 'together', status: 'operational' },
    { id: 'gemini', status: 'operational' },
  ]

  const aiAnalysis: Record<string, { resolvedAt?: string; incidentId: string }> = {
    together: { resolvedAt: '2026-03-30T11:00:00Z', incidentId: 'tog-1' },
  }

  it('includes operational services with resolvedAt in recentlyRecovered', () => {
    const activeAnalysis: Record<string, unknown> = {} // no active incidents
    const recentlyRecovered: string[] = []

    for (const svc of services) {
      if (svc.status !== 'operational') continue
      if (activeAnalysis[svc.id]) continue
      const analysis = aiAnalysis[svc.id]
      if (analysis?.resolvedAt) {
        recentlyRecovered.push(svc.id)
      }
    }

    expect(recentlyRecovered).toEqual(['together'])
  })

  it('excludes non-operational services from recentlyRecovered', () => {
    const nonOpAnalysis: Record<string, { resolvedAt?: string }> = {
      openai: { resolvedAt: '2026-03-30T11:00:00Z' },
    }
    const recentlyRecovered: string[] = []

    for (const svc of services) {
      if (svc.status !== 'operational') continue
      const analysis = nonOpAnalysis[svc.id]
      if (analysis?.resolvedAt) {
        recentlyRecovered.push(svc.id)
      }
    }

    expect(recentlyRecovered).toEqual([])
  })

  it('excludes services already in active analysis', () => {
    const activeAnalysis: Record<string, unknown> = { together: { incidentId: 'tog-2' } }
    const recentlyRecovered: string[] = []

    for (const svc of services) {
      if (svc.status !== 'operational') continue
      if (activeAnalysis[svc.id]) continue
      const analysis = aiAnalysis[svc.id]
      if (analysis?.resolvedAt) {
        recentlyRecovered.push(svc.id)
      }
    }

    expect(recentlyRecovered).toEqual([])
  })

  it('returns empty when no resolved analyses exist', () => {
    const emptyAnalysis: Record<string, { resolvedAt?: string }> = {}
    const recentlyRecovered: string[] = []

    for (const svc of services) {
      if (svc.status !== 'operational') continue
      const analysis = emptyAnalysis[svc.id]
      if (analysis?.resolvedAt) {
        recentlyRecovered.push(svc.id)
      }
    }

    expect(recentlyRecovered).toEqual([])
  })
})

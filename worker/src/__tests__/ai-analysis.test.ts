import { describe, it, expect, vi } from 'vitest'
import { findSimilarIncidents, buildAnalysisPrompt, analyzeIncident, refreshOrReanalyze, type KVLike } from '../ai-analysis'
import type { Incident, ServiceStatus } from '../types'

const mockIncident = (overrides: Partial<Incident> = {}): Incident => ({
  id: 'inc1',
  title: 'API Error Rates',
  status: 'resolved',
  impact: 'major',
  startedAt: '2026-03-20T10:00:00Z',
  resolvedAt: '2026-03-20T12:00:00Z',
  duration: '2h 0m',
  timeline: [],
  ...overrides,
})

describe('findSimilarIncidents', () => {
  it('finds incidents with matching keywords', () => {
    const incidents = [
      mockIncident({ id: 'a', title: 'Elevated API Error Rates' }),
      mockIncident({ id: 'b', title: 'Login Page Slow' }),
      mockIncident({ id: 'c', title: 'API Latency Spike' }),
    ]
    const result = findSimilarIncidents('API Error on Opus', incidents)
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].id).toBe('a') // most keyword overlap
  })

  it('returns up to limit results', () => {
    const incidents = Array.from({ length: 10 }, (_, i) =>
      mockIncident({ id: `inc${i}`, title: `Error ${i}` })
    )
    const result = findSimilarIncidents('Error test', incidents, 3)
    expect(result.length).toBeLessThanOrEqual(3)
  })

  it('excludes non-resolved incidents', () => {
    const incidents = [
      mockIncident({ id: 'a', title: 'API Error', status: 'investigating' }),
      mockIncident({ id: 'b', title: 'API Error', status: 'resolved' }),
    ]
    const result = findSimilarIncidents('API Error', incidents)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('b')
  })

  it('returns empty array when no keywords match', () => {
    const incidents = [
      mockIncident({ id: 'a', title: 'Login Page Slow' }),
    ]
    const result = findSimilarIncidents('Completely different topic', incidents)
    expect(result).toHaveLength(0)
  })
})

describe('buildAnalysisPrompt', () => {
  it('includes service name and incident details', () => {
    const prompt = buildAnalysisPrompt(
      'Claude API',
      { title: 'Elevated errors', status: 'investigating', startedAt: '2026-03-26T10:00:00Z', impact: 'major' },
      [],
    )
    expect(prompt).toContain('Claude API')
    expect(prompt).toContain('Elevated errors')
    expect(prompt).toContain('investigating')
    expect(prompt).toContain('major')
  })

  it('includes similar incidents in prompt', () => {
    const similar = [
      mockIncident({ title: 'Past Error 1', duration: '45m' }),
      mockIncident({ title: 'Past Error 2', duration: '1h 20m' }),
    ]
    const prompt = buildAnalysisPrompt(
      'OpenAI',
      { title: 'Current error', status: 'investigating', startedAt: '2026-03-26T10:00:00Z', impact: null },
      similar,
    )
    expect(prompt).toContain('Past Error 1')
    expect(prompt).toContain('45m')
    expect(prompt).toContain('Past Error 2')
  })

  it('handles no similar incidents', () => {
    const prompt = buildAnalysisPrompt(
      'Gemini',
      { title: 'Outage', status: 'investigating', startedAt: '2026-03-26T10:00:00Z', impact: 'critical' },
      [],
    )
    expect(prompt).toContain('No similar past incidents found')
  })

  it('wraps data in incident_data tags for system/user separation', () => {
    const prompt = buildAnalysisPrompt('Test', { title: 't', status: 's', startedAt: '2026-01-01T00:00:00Z', impact: null }, [])
    expect(prompt).toContain('<incident_data>')
    expect(prompt).toContain('</incident_data>')
    // Should NOT contain instructions (those are in SYSTEM_PROMPT)
    expect(prompt).not.toContain('Rules:')
    expect(prompt).not.toContain('JSON format')
  })

  it('caps history text length', () => {
    const longIncidents = Array.from({ length: 20 }, (_, i) =>
      mockIncident({ id: `inc${i}`, title: 'A'.repeat(200), duration: '1h' })
    )
    const prompt = buildAnalysisPrompt('Test', { title: 'error', status: 's', startedAt: '2026-01-01T00:00:00Z', impact: null }, longIncidents)
    // History text capped at 1000 chars
    expect(prompt.length).toBeLessThan(2000)
  })
})

describe('analyzeIncident', () => {
  const mockInc = { id: 'inc1', title: 'API Error', status: 'investigating' as const, startedAt: '2026-03-26T10:00:00Z', impact: 'major' as const }
  const mockIncidents = [mockIncident({ title: 'Past Error', duration: '45m' })]

  it('returns parsed analysis on successful API response', async () => {
    const mockResponse = {
      content: [{ type: 'text', text: '{"summary":"Test analysis","estimatedRecovery":"30-60 min","affectedScope":["API"]}' }],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }))

    const result = await analyzeIncident('fake-key', 'Claude API', mockInc, mockIncidents)
    expect(result).not.toBeNull()
    expect(result!.summary).toBe('Test analysis')
    expect(result!.estimatedRecovery).toBe('30-60 min')
    expect(result!.affectedScope).toEqual(['API'])
    expect(result!.incidentId).toBe('inc1')

    vi.unstubAllGlobals()
  })

  it('handles JSON wrapped in markdown code block', async () => {
    const mockResponse = {
      content: [{ type: 'text', text: '```json\n{"summary":"wrapped","estimatedRecovery":"Unknown","affectedScope":[]}\n```' }],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }))

    const result = await analyzeIncident('fake-key', 'Test', mockInc, [])
    expect(result).not.toBeNull()
    expect(result!.summary).toBe('wrapped')

    vi.unstubAllGlobals()
  })

  it('returns null on API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad request'),
    }))

    const result = await analyzeIncident('fake-key', 'Test', mockInc, [])
    expect(result).toBeNull()

    vi.unstubAllGlobals()
  })

  it('returns null on malformed JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: 'not json at all' }] }),
    }))

    const result = await analyzeIncident('fake-key', 'Test', mockInc, [])
    expect(result).toBeNull()

    vi.unstubAllGlobals()
  })

  it('returns null on network timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))

    const result = await analyzeIncident('fake-key', 'Test', mockInc, [])
    expect(result).toBeNull()

    vi.unstubAllGlobals()
  })
})

// ── refreshOrReanalyze tests ──

function mockKV(store: Record<string, string> = {}): KVLike {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => { store[key] = value }),
  }
}

function mockService(id: string, incidents: Partial<Incident>[] = []): ServiceStatus {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    provider: 'Test',
    status: 'degraded',
    latency: null,
    lastChecked: new Date().toISOString(),
    incidents: incidents.map(i => ({
      id: i.id ?? 'inc-1',
      title: i.title ?? 'Test Incident',
      status: i.status ?? 'investigating',
      impact: i.impact ?? null,
      startedAt: i.startedAt ?? '2026-03-27T06:00:00Z',
      resolvedAt: i.resolvedAt ?? null,
      duration: i.duration ?? null,
      timeline: i.timeline ?? [],
    })),
  }
}

const mockAnalysis = {
  summary: 'Test analysis',
  estimatedRecovery: '30-60min',
  affectedScope: ['API'],
  analyzedAt: '2026-03-27T06:10:00Z',
  incidentId: 'inc-1',
}

describe('refreshOrReanalyze', () => {
  it('refreshes TTL when analysis exists and is 30-59min old', async () => {
    const oldAnalysis = { ...mockAnalysis, analyzedAt: '2026-03-27T05:10:00Z' }
    const kv = mockKV({ 'ai:analysis:claude': JSON.stringify(oldAnalysis) })
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn()

    const now = new Date('2026-03-27T05:50:00Z').getTime() // 40min elapsed (< 1h, > 30min)
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(result.refreshed).toEqual(['claude'])
    expect(result.reanalyzed).toEqual([])
    expect(analyzeFn).not.toHaveBeenCalled()
    expect(kv.put).toHaveBeenCalledWith(
      'ai:analysis:claude',
      expect.stringContaining('_lastRefresh'),
      { expirationTtl: 3600 },
    )
  })

  it('skips TTL refresh when analysis is recent (< 30min)', async () => {
    const recentAnalysis = { ...mockAnalysis, analyzedAt: '2026-03-27T05:50:00Z' }
    const kv = mockKV({ 'ai:analysis:claude': JSON.stringify(recentAnalysis) })
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn()

    const now = new Date('2026-03-27T06:00:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(result.refreshed).toEqual([])
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('re-analyzes when analysis is missing', async () => {
    const kv = mockKV()
    const svc = mockService('chatgpt', [{ id: 'inc-2', status: 'investigating' }])
    const analyzeFn = vi.fn().mockResolvedValue({ ...mockAnalysis, incidentId: 'inc-2' })

    const result = await refreshOrReanalyze([svc], kv, 'api-key', analyzeFn, 2)

    expect(result.reanalyzed).toEqual(['chatgpt'])
    expect(analyzeFn).toHaveBeenCalledOnce()
    expect(kv.put).toHaveBeenCalledWith(
      'ai:analysis:chatgpt',
      expect.stringContaining('inc-2'),
      { expirationTtl: 3600 },
    )
  })

  it('respects cap — only re-analyzes up to cap services', async () => {
    const kv = mockKV()
    const services = [
      mockService('svc1', [{ id: 'i1', status: 'investigating' }]),
      mockService('svc2', [{ id: 'i2', status: 'investigating' }]),
      mockService('svc3', [{ id: 'i3', status: 'investigating' }]),
    ]
    const analyzeFn = vi.fn().mockResolvedValue(mockAnalysis)

    const result = await refreshOrReanalyze(services, kv, 'key', analyzeFn, 2)

    expect(analyzeFn).toHaveBeenCalledTimes(2)
    expect(result.reanalyzed).toHaveLength(2)
    expect(result.skipped).toContain('svc3')
  })

  it('skips re-analysis when cooldown key exists', async () => {
    const kv = mockKV({ 'ai:reanalysis-skip:claude': '1' })
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn()

    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2)

    expect(analyzeFn).not.toHaveBeenCalled()
    expect(result.skipped).toEqual(['claude'])
  })

  it('sets cooldown key when analysis returns null', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockResolvedValue(null)

    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2)

    expect(result.skipped).toEqual(['claude'])
    expect(store['ai:reanalysis-skip:claude']).toBe('1')
  })

  it('sets cooldown key when analysis throws', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockRejectedValue(new Error('API error'))
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2)

    expect(result.skipped).toEqual(['claude'])
    expect(store['ai:reanalysis-skip:claude']).toBe('1')
    spy.mockRestore()
  })

  it('skips re-analysis when no API key', async () => {
    const kv = mockKV()
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn()

    const result = await refreshOrReanalyze([svc], kv, undefined, analyzeFn, 2)

    expect(analyzeFn).not.toHaveBeenCalled()
    expect(result.skipped).toEqual(['claude'])
  })

  it('tracks re-analysis in ai:usage counter', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockResolvedValue(mockAnalysis)

    await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2)

    const usageKey = Object.keys(store).find(k => k.startsWith('ai:usage:'))
    expect(usageKey).toBeDefined()
    const usage = JSON.parse(store[usageKey!])
    expect(usage.calls).toBe(1)
    expect(usage.success).toBe(1)
  })

  it('detects stale analysis and re-analyzes for new incident', async () => {
    // Analysis exists for inc-old (resolved), but inc-new is active
    const staleAnalysis = { ...mockAnalysis, incidentId: 'inc-old' }
    const store: Record<string, string> = {
      'ai:analysis:claude': JSON.stringify(staleAnalysis),
    }
    const kv = mockKV(store)
    const svc = mockService('claude', [
      { id: 'inc-old', status: 'resolved' },
      { id: 'inc-new', status: 'investigating' },
    ])
    const newAnalysis = { ...mockAnalysis, incidentId: 'inc-new' }
    const analyzeFn = vi.fn().mockResolvedValue(newAnalysis)

    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2)

    expect(analyzeFn).toHaveBeenCalledOnce()
    expect(result.reanalyzed).toEqual(['claude'])
    const stored = JSON.parse(store['ai:analysis:claude'])
    expect(stored.incidentId).toBe('inc-new')
  })

  it('keeps analysis when incidentId matches and analysis is recent (<1h)', async () => {
    const analysis = { ...mockAnalysis, incidentId: 'inc-1', analyzedAt: '2026-03-27T05:20:00Z' }
    const kv = mockKV({ 'ai:analysis:claude': JSON.stringify(analysis) })
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn()

    const now = new Date('2026-03-27T05:55:00Z').getTime() // 35min elapsed (< 1h)
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).not.toHaveBeenCalled()
    expect(result.refreshed).toEqual(['claude'])
    expect(result.reanalyzed).toEqual([])
  })

  it('re-analyzes when analysis is 2h+ old for same active incident', async () => {
    const oldAnalysis = { ...mockAnalysis, incidentId: 'inc-1', analyzedAt: '2026-03-27T03:00:00Z' }
    const store: Record<string, string> = { 'ai:analysis:claude': JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const updatedAnalysis = { ...mockAnalysis, incidentId: 'inc-1', summary: 'Updated analysis' }
    const analyzeFn = vi.fn().mockResolvedValue(updatedAnalysis)

    const now = new Date('2026-03-27T05:30:00Z').getTime() // 2.5h elapsed
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).toHaveBeenCalledOnce()
    expect(result.reanalyzed).toEqual(['claude'])
    const stored = JSON.parse(store['ai:analysis:claude'])
    expect(stored.summary).toBe('Updated analysis')
  })

  it('keeps old analysis when 2h+ re-analysis fails', async () => {
    const oldAnalysis = { ...mockAnalysis, incidentId: 'inc-1', analyzedAt: '2026-03-27T03:00:00Z', summary: 'Old analysis' }
    const store: Record<string, string> = { 'ai:analysis:claude': JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockResolvedValue(null) // re-analysis fails

    const now = new Date('2026-03-27T05:30:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).toHaveBeenCalledOnce()
    // Old analysis should be preserved, not deleted
    const stored = JSON.parse(store['ai:analysis:claude'])
    expect(stored.summary).toBe('Old analysis')
    expect(result.refreshed).toEqual(['claude'])
  })

  it('keeps old analysis when 2h+ re-analysis throws', async () => {
    const oldAnalysis = { ...mockAnalysis, incidentId: 'inc-1', analyzedAt: '2026-03-27T03:00:00Z', summary: 'Old analysis' }
    const store: Record<string, string> = { 'ai:analysis:claude': JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockRejectedValue(new Error('API timeout'))

    const now = new Date('2026-03-27T05:30:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    const stored = JSON.parse(store['ai:analysis:claude'])
    expect(stored.summary).toBe('Old analysis')
    expect(result.refreshed).toEqual(['claude'])
  })

  it('does not re-analyze when analysis is less than 2h old', async () => {
    const recentAnalysis = { ...mockAnalysis, incidentId: 'inc-1', analyzedAt: '2026-03-27T04:00:00Z' }
    const kv = mockKV({ 'ai:analysis:claude': JSON.stringify(recentAnalysis) })
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn()

    const now = new Date('2026-03-27T05:30:00Z').getTime() // 1.5h elapsed (< 2h)
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).not.toHaveBeenCalled()
    expect(result.refreshed).toEqual(['claude'])
  })

  it('respects cap for time-based re-analysis', async () => {
    const oldAnalysis1 = { ...mockAnalysis, incidentId: 'inc-1', analyzedAt: '2026-03-27T03:00:00Z' }
    const oldAnalysis2 = { ...mockAnalysis, incidentId: 'inc-2', analyzedAt: '2026-03-27T03:00:00Z' }
    const oldAnalysis3 = { ...mockAnalysis, incidentId: 'inc-3', analyzedAt: '2026-03-27T03:00:00Z' }
    const store: Record<string, string> = {
      'ai:analysis:claude': JSON.stringify(oldAnalysis1),
      'ai:analysis:openai': JSON.stringify(oldAnalysis2),
      'ai:analysis:gemini': JSON.stringify(oldAnalysis3),
    }
    const kv = mockKV(store)
    const svcs = [
      mockService('claude', [{ id: 'inc-1', status: 'investigating' }]),
      mockService('openai', [{ id: 'inc-2', status: 'investigating' }]),
      mockService('gemini', [{ id: 'inc-3', status: 'investigating' }]),
    ]
    const analyzeFn = vi.fn().mockResolvedValue(mockAnalysis)

    const now = new Date('2026-03-27T05:30:00Z').getTime() // 2.5h elapsed
    const result = await refreshOrReanalyze(svcs, kv, 'key', analyzeFn, 2, now)

    // Cap is 2 — only 2 should be re-analyzed, 3rd skipped
    expect(analyzeFn).toHaveBeenCalledTimes(2)
    expect(result.reanalyzed).toHaveLength(2)
  })

  it('dedup: copies analysis from sibling with same incidentId instead of API call', async () => {
    // claude has analysis for inc-shared, claudeai shares same incident but has no analysis
    const sharedAnalysis = { ...mockAnalysis, incidentId: 'inc-shared' }
    const store: Record<string, string> = {
      'ai:analysis:claude': JSON.stringify(sharedAnalysis),
    }
    const kv = mockKV(store)
    const services = [
      mockService('claude', [{ id: 'inc-shared', status: 'investigating' }]),
      mockService('claudeai', [{ id: 'inc-shared', status: 'investigating' }]),
    ]
    const analyzeFn = vi.fn()

    const now = new Date('2026-03-27T06:00:00Z').getTime()
    const result = await refreshOrReanalyze(services, kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).not.toHaveBeenCalled() // no API call needed
    expect(result.reanalyzed).toContain('claudeai')
    expect(store['ai:analysis:claudeai']).toBeDefined()
    const copied = JSON.parse(store['ai:analysis:claudeai'])
    expect(copied.incidentId).toBe('inc-shared')
  })

  it('dedup: does not count copied analysis toward re-analysis cap', async () => {
    const sharedAnalysis = { ...mockAnalysis, incidentId: 'inc-shared' }
    const store: Record<string, string> = {
      'ai:analysis:claude': JSON.stringify(sharedAnalysis),
    }
    const kv = mockKV(store)
    const services = [
      mockService('claude', [{ id: 'inc-shared', status: 'investigating' }]),
      mockService('claudeai', [{ id: 'inc-shared', status: 'investigating' }]),
      mockService('together', [{ id: 'inc-other', status: 'investigating' }]),
    ]
    const analyzeFn = vi.fn().mockResolvedValue({ ...mockAnalysis, incidentId: 'inc-other' })

    const now = new Date('2026-03-27T06:00:00Z').getTime()
    const result = await refreshOrReanalyze(services, kv, 'key', analyzeFn, 1, now)

    // claudeai copied (no API), together analyzed (1 API call, within cap=1)
    expect(analyzeFn).toHaveBeenCalledOnce()
    expect(result.reanalyzed).toContain('claudeai')
    expect(result.reanalyzed).toContain('together')
  })
})

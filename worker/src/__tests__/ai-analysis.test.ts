import { describe, it, expect, vi } from 'vitest'
import { findSimilarIncidents, buildAnalysisPrompt, analyzeIncident, refreshOrReanalyze, analysisKey, isBoilerplate, isGenericIncident, parseRecoveryHours, formatRecoveryDisplay, parseAnalysisResponse, type KVLike } from '../ai-analysis'
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

describe('isBoilerplate', () => {
  it('detects generic investigating messages', () => {
    expect(isBoilerplate('We are currently investigating this issue.')).toBe(true)
    expect(isBoilerplate('We are investigating this issue')).toBe(true)
    expect(isBoilerplate('We are aware of this issue')).toBe(true)
  })

  it('detects generic resolved messages', () => {
    expect(isBoilerplate('This incident has been resolved.')).toBe(true)
    expect(isBoilerplate('The issue has been resolved')).toBe(true)
    expect(isBoilerplate('This issue is resolved')).toBe(true)
  })

  it('detects generic monitoring/fix messages', () => {
    expect(isBoilerplate('A fix has been implemented and we are monitoring the results.')).toBe(true)
    expect(isBoilerplate('We are continuing to monitor')).toBe(true)
    expect(isBoilerplate('We are continuing to investigate')).toBe(true)
  })

  it('detects single-word stage labels', () => {
    expect(isBoilerplate('Investigating')).toBe(true)
    expect(isBoilerplate('Resolved.')).toBe(true)
    expect(isBoilerplate('Monitoring')).toBe(true)
  })

  it('returns true for null/empty/short text', () => {
    expect(isBoilerplate(null)).toBe(true)
    expect(isBoilerplate('')).toBe(true)
    expect(isBoilerplate('OK')).toBe(true)
  })

  it('returns false when boilerplate opener has appended technical detail', () => {
    expect(isBoilerplate('We are currently investigating this issue. Error rates spiked to 40% on /v1/messages endpoint.')).toBe(false)
    expect(isBoilerplate('We are aware of increased latency affecting Claude Sonnet models in us-east-1')).toBe(false)
    expect(isBoilerplate('A fix has been implemented for the database connection pool exhaustion issue')).toBe(false)
  })

  it('returns false for technical detail', () => {
    expect(isBoilerplate('AWS Bedrock is currently experiencing issues that are leading to an increase in errors for Claude models')).toBe(false)
    expect(isBoilerplate('The frequency of those errors has gone down. We are continuing to closely monitor')).toBe(false)
    expect(isBoilerplate('Error rates increased to 15% on us-east-1 region')).toBe(false)
    expect(isBoilerplate('Root cause identified as a database connection pool exhaustion')).toBe(false)
  })
})

describe('isGenericIncident', () => {
  it('detects generic title + boilerplate timeline', () => {
    expect(isGenericIncident('Investigating an issue', [
      { text: 'We are currently investigating this issue.' },
    ])).toBe(true)
  })

  it('detects generic title with no timeline', () => {
    expect(isGenericIncident('Investigating an issue', [])).toBe(true)
    expect(isGenericIncident('Service disruption')).toBe(true)
    expect(isGenericIncident('Scheduled maintenance', undefined)).toBe(true)
  })

  it('detects various generic title patterns', () => {
    expect(isGenericIncident('Investigating the issue', [])).toBe(true)
    expect(isGenericIncident('Service outage', [])).toBe(true)
    expect(isGenericIncident('System disruption', [])).toBe(true)
    expect(isGenericIncident('Partial degradation', [])).toBe(true)
  })

  it('returns false for specific titles', () => {
    expect(isGenericIncident('Opus 4.6 elevated rate of errors', [])).toBe(false)
    expect(isGenericIncident('TTS API Latency Spike', [])).toBe(false)
    expect(isGenericIncident('Database connection pool exhaustion', [])).toBe(false)
  })

  it('returns false when generic title has technical timeline detail', () => {
    expect(isGenericIncident('Investigating an issue', [
      { text: 'We are currently investigating this issue.' },
      { text: 'Error rates spiked to 40% on /v1/messages endpoint.' },
    ])).toBe(false)
  })
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

  it('includes timeline updates in prompt when provided', () => {
    const prompt = buildAnalysisPrompt(
      'AssemblyAI',
      {
        title: 'Error rates increase',
        status: 'identified',
        startedAt: '2026-03-30T18:41:00Z',
        impact: 'minor',
        timeline: [
          { stage: 'identified', text: 'AWS Bedrock issues leading to errors for Claude models', at: '2026-03-30T18:41:00Z' },
          { stage: 'identified', text: 'Errors have gone down but still occurring', at: '2026-03-30T21:54:00Z' },
        ],
      },
      [],
    )
    expect(prompt).toContain('Timeline Updates:')
    expect(prompt).toContain('AWS Bedrock issues')
    expect(prompt).toContain('Errors have gone down')
  })

  it('omits timeline section when no timeline provided', () => {
    const prompt = buildAnalysisPrompt(
      'Test',
      { title: 'Outage', status: 'investigating', startedAt: '2026-01-01T00:00:00Z', impact: null },
      [],
    )
    expect(prompt).not.toContain('Timeline Updates:')
  })

  it('caps history text length', () => {
    const longIncidents = Array.from({ length: 20 }, (_, i) =>
      mockIncident({ id: `inc${i}`, title: 'A'.repeat(200), duration: '1h' })
    )
    const prompt = buildAnalysisPrompt('Test', { title: 'error', status: 's', startedAt: '2026-01-01T00:00:00Z', impact: null }, longIncidents)
    // History text capped at 1000 chars
    expect(prompt.length).toBeLessThan(2000)
  })

  it('includes previous prediction context when prevPrediction is provided', () => {
    const prompt = buildAnalysisPrompt(
      'Deepgram', { title: 'Voice API Error', status: 'investigating', startedAt: '2026-03-27T03:00:00Z', impact: 'major' },
      [], { estimatedRecoveryHours: 6, elapsedHours: 14 },
    )
    expect(prompt).toContain('Previous Prediction')
    expect(prompt).toContain('6h')
    expect(prompt).toContain('14h')
    expect(prompt).toContain('incorrect')
  })

  it('omits previous prediction context when prevPrediction is not provided', () => {
    const prompt = buildAnalysisPrompt(
      'Deepgram', { title: 'Voice API Error', status: 'investigating', startedAt: '2026-03-27T03:00:00Z', impact: 'major' }, [],
    )
    expect(prompt).not.toContain('Previous Prediction')
  })
})

describe('analyzeIncident', () => {
  const mockInc = { id: 'inc1', title: 'API Error', status: 'investigating' as const, startedAt: '2026-03-26T10:00:00Z', impact: 'major' as const }
  const mockIncidents = [mockIncident({ title: 'Past Error', duration: '45m' })]

  it('returns parsed analysis on successful API response', async () => {
    const mockResponse = {
      content: [{ type: 'text', text: '{"summary":"Test analysis","estimatedRecovery":"30-60 min","affectedScope":["API"],"needsFallback":true}' }],
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
    expect(result!.needsFallback).toBe(true)
    expect(result!.incidentId).toBe('inc1')

    vi.unstubAllGlobals()
  })

  it('defaults needsFallback to false when AI omits it', async () => {
    const mockResponse = {
      content: [{ type: 'text', text: '{"summary":"Minor issue","estimatedRecovery":"15m","affectedScope":[]}' }],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }))

    const result = await analyzeIncident('fake-key', 'Test', mockInc, [])
    expect(result).not.toBeNull()
    expect(result!.needsFallback).toBe(false)

    vi.unstubAllGlobals()
  })

  it('parses needsFallback: false correctly', async () => {
    const mockResponse = {
      content: [{ type: 'text', text: '{"summary":"Scheduled maintenance","estimatedRecovery":"1h","affectedScope":["Dashboard"],"needsFallback":false}' }],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }))

    const result = await analyzeIncident('fake-key', 'Test', mockInc, [])
    expect(result).not.toBeNull()
    expect(result!.needsFallback).toBe(false)

    vi.unstubAllGlobals()
  })

  it('coerces needsFallback string "true" to true', async () => {
    const mockResponse = {
      content: [{ type: 'text', text: '{"summary":"Outage","estimatedRecovery":"2h","affectedScope":["API"],"needsFallback":"true"}' }],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }))

    const result = await analyzeIncident('fake-key', 'Test', mockInc, [])
    expect(result).not.toBeNull()
    expect(result!.needsFallback).toBe(true)

    vi.unstubAllGlobals()
  })

  it('treats needsFallback non-boolean values as false', async () => {
    const mockResponse = {
      content: [{ type: 'text', text: '{"summary":"Issue","estimatedRecovery":"1h","affectedScope":[],"needsFallback":"yes"}' }],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }))

    const result = await analyzeIncident('fake-key', 'Test', mockInc, [])
    expect(result).not.toBeNull()
    expect(result!.needsFallback).toBe(false)

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

  it('stores timelineHash from latest timeline entry', async () => {
    const mockResponse = {
      content: [{ type: 'text', text: '{"summary":"Test","estimatedRecovery":"1h","affectedScope":["API"]}' }],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }))

    const incWithTimeline = {
      ...mockInc,
      timeline: [
        { stage: 'investigating' as const, text: 'First update', at: '2026-03-26T10:00:00Z' },
        { stage: 'identified' as const, text: 'Found root cause', at: '2026-03-26T11:30:00Z' },
      ],
    }
    const result = await analyzeIncident('fake-key', 'Test', incWithTimeline, [])
    expect(result).not.toBeNull()
    expect(result!.timelineHash).toBe('2026-03-26T11:30:00Z')

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
    delete: vi.fn(async (key: string) => { delete store[key] }),
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
    const kv = mockKV({ [analysisKey('claude', 'inc-1')]: JSON.stringify(oldAnalysis) })
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn()

    const now = new Date('2026-03-27T05:50:00Z').getTime() // 40min elapsed (< 1h, > 30min)
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(result.refreshed).toEqual(['claude'])
    expect(result.reanalyzed).toEqual([])
    expect(analyzeFn).not.toHaveBeenCalled()
    expect(kv.put).toHaveBeenCalledWith(
      analysisKey('claude', 'inc-1'),
      expect.stringContaining('_lastRefresh'),
      { expirationTtl: 3600 },
    )
  })

  it('skips TTL refresh when analysis is recent (< 30min)', async () => {
    const recentAnalysis = { ...mockAnalysis, analyzedAt: '2026-03-27T05:50:00Z' }
    const kv = mockKV({ [analysisKey('claude', 'inc-1')]: JSON.stringify(recentAnalysis) })
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
      analysisKey('chatgpt', 'inc-2'),
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
    const kv = mockKV({ 'ai:reanalysis-skip:claude:inc-1': '1' })
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
    expect(store['ai:reanalysis-skip:claude:inc-1']).toBe('1')
  })

  it('sets cooldown key when analysis throws', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockRejectedValue(new Error('API error'))
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2)

    expect(result.skipped).toEqual(['claude'])
    expect(store['ai:reanalysis-skip:claude:inc-1']).toBe('1')
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

  it('analyzes new incident independently when old incident is resolved', async () => {
    // Analysis exists for inc-old (resolved), inc-new is active — per-incident keys are independent
    const oldAnalysis = { ...mockAnalysis, incidentId: 'inc-old' }
    const store: Record<string, string> = {
      [analysisKey('claude', 'inc-old')]: JSON.stringify(oldAnalysis),
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
    // New incident has its own key
    const stored = JSON.parse(store[analysisKey('claude', 'inc-new')])
    expect(stored.incidentId).toBe('inc-new')
    // Old key is untouched
    expect(store[analysisKey('claude', 'inc-old')]).toBeDefined()
  })

  it('keeps analysis when analysis is recent (<1h)', async () => {
    const analysis = { ...mockAnalysis, incidentId: 'inc-1', analyzedAt: '2026-03-27T05:20:00Z' }
    const kv = mockKV({ [analysisKey('claude', 'inc-1')]: JSON.stringify(analysis) })
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
    const store: Record<string, string> = { [analysisKey('claude', 'inc-1')]: JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const updatedAnalysis = { ...mockAnalysis, incidentId: 'inc-1', summary: 'Updated analysis' }
    const analyzeFn = vi.fn().mockResolvedValue(updatedAnalysis)

    const now = new Date('2026-03-27T05:30:00Z').getTime() // 2.5h elapsed
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).toHaveBeenCalledOnce()
    expect(result.reanalyzed).toEqual(['claude'])
    const stored = JSON.parse(store[analysisKey('claude', 'inc-1')])
    expect(stored.summary).toBe('Updated analysis')
  })

  it('keeps old analysis when 2h+ re-analysis fails', async () => {
    const oldAnalysis = { ...mockAnalysis, incidentId: 'inc-1', analyzedAt: '2026-03-27T03:00:00Z', summary: 'Old analysis' }
    const store: Record<string, string> = { [analysisKey('claude', 'inc-1')]: JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockResolvedValue(null) // re-analysis fails

    const now = new Date('2026-03-27T05:30:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).toHaveBeenCalledOnce()
    // Old analysis should be preserved, not deleted
    const stored = JSON.parse(store[analysisKey('claude', 'inc-1')])
    expect(stored.summary).toBe('Old analysis')
    expect(result.refreshed).toEqual(['claude'])
  })

  it('keeps old analysis when 2h+ re-analysis throws', async () => {
    const oldAnalysis = { ...mockAnalysis, incidentId: 'inc-1', analyzedAt: '2026-03-27T03:00:00Z', summary: 'Old analysis' }
    const store: Record<string, string> = { [analysisKey('claude', 'inc-1')]: JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockRejectedValue(new Error('API timeout'))

    const now = new Date('2026-03-27T05:30:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    const stored = JSON.parse(store[analysisKey('claude', 'inc-1')])
    expect(stored.summary).toBe('Old analysis')
    expect(result.refreshed).toEqual(['claude'])
  })

  it('does not re-analyze when analysis is less than 2h old', async () => {
    const recentAnalysis = { ...mockAnalysis, incidentId: 'inc-1', analyzedAt: '2026-03-27T04:00:00Z' }
    const kv = mockKV({ [analysisKey('claude', 'inc-1')]: JSON.stringify(recentAnalysis) })
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
      [analysisKey('claude', 'inc-1')]: JSON.stringify(oldAnalysis1),
      [analysisKey('openai', 'inc-2')]: JSON.stringify(oldAnalysis2),
      [analysisKey('gemini', 'inc-3')]: JSON.stringify(oldAnalysis3),
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
      [analysisKey('claude', 'inc-shared')]: JSON.stringify(sharedAnalysis),
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
    expect(store[analysisKey('claudeai', 'inc-shared')]).toBeDefined()
    const copied = JSON.parse(store[analysisKey('claudeai', 'inc-shared')])
    expect(copied.incidentId).toBe('inc-shared')
  })

  it('skips re-analysis when timeline has not changed (timelineHash matches)', async () => {
    const oldAnalysis = {
      ...mockAnalysis,
      incidentId: 'inc-1',
      analyzedAt: '2026-03-27T03:00:00Z',
      timelineHash: '2026-03-27T03:00:00Z',  // matches latest timeline entry
    }
    const store: Record<string, string> = { [analysisKey('claude', 'inc-1')]: JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('claude', [{
      id: 'inc-1',
      status: 'investigating',
      timeline: [{ stage: 'investigating', text: 'Looking into it', at: '2026-03-27T03:00:00Z' }],
    }])
    const analyzeFn = vi.fn()

    const now = new Date('2026-03-27T05:30:00Z').getTime() // 2.5h elapsed
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).not.toHaveBeenCalled() // no API call — timeline unchanged
    expect(result.refreshed).toEqual(['claude'])
    expect(result.reanalyzed).toEqual([])
  })

  it('re-analyzes when timeline has new updates (timelineHash differs)', async () => {
    const oldAnalysis = {
      ...mockAnalysis,
      incidentId: 'inc-1',
      analyzedAt: '2026-03-27T03:00:00Z',
      timelineHash: '2026-03-27T03:00:00Z',
    }
    const store: Record<string, string> = { [analysisKey('claude', 'inc-1')]: JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('claude', [{
      id: 'inc-1',
      status: 'identified',
      timeline: [
        { stage: 'investigating', text: 'Looking into it', at: '2026-03-27T03:00:00Z' },
        { stage: 'identified', text: 'Root cause found', at: '2026-03-27T04:30:00Z' },  // new update
      ],
    }])
    const updatedAnalysis = { ...mockAnalysis, incidentId: 'inc-1', summary: 'Updated with new timeline' }
    const analyzeFn = vi.fn().mockResolvedValue(updatedAnalysis)

    const now = new Date('2026-03-27T05:30:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).toHaveBeenCalledOnce()
    expect(result.reanalyzed).toEqual(['claude'])
  })

  it('skips re-analysis when new timeline entries are all boilerplate', async () => {
    const oldAnalysis = {
      ...mockAnalysis,
      incidentId: 'inc-1',
      analyzedAt: '2026-03-27T03:00:00Z',
      timelineHash: '2026-03-27T03:00:00Z',
    }
    const store: Record<string, string> = { [analysisKey('claude', 'inc-1')]: JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('claude', [{
      id: 'inc-1',
      status: 'monitoring',
      timeline: [
        { stage: 'investigating', text: 'We are investigating this issue', at: '2026-03-27T03:00:00Z' },
        { stage: 'monitoring', text: 'A fix has been implemented and we are monitoring the results.', at: '2026-03-27T04:00:00Z' },
      ],
    }])
    const analyzeFn = vi.fn()

    const now = new Date('2026-03-27T05:30:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).not.toHaveBeenCalled() // boilerplate — skip
    expect(result.refreshed).toEqual(['claude'])
    // timelineHash should be updated to latest entry
    const stored = JSON.parse(store[analysisKey('claude', 'inc-1')])
    expect(stored.timelineHash).toBe('2026-03-27T04:00:00Z')
  })

  it('re-analyzes when new timeline has mix of boilerplate and technical content', async () => {
    const oldAnalysis = {
      ...mockAnalysis,
      incidentId: 'inc-1',
      analyzedAt: '2026-03-27T03:00:00Z',
      timelineHash: '2026-03-27T03:00:00Z',
    }
    const store: Record<string, string> = { [analysisKey('claude', 'inc-1')]: JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('claude', [{
      id: 'inc-1',
      status: 'identified',
      timeline: [
        { stage: 'investigating', text: 'We are investigating this issue', at: '2026-03-27T03:00:00Z' },
        { stage: 'identified', text: 'AWS Bedrock errors affecting Claude Sonnet models in us-east-1', at: '2026-03-27T04:00:00Z' },
      ],
    }])
    const analyzeFn = vi.fn().mockResolvedValue({ ...mockAnalysis, incidentId: 'inc-1' })

    const now = new Date('2026-03-27T05:30:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).toHaveBeenCalledOnce() // technical content — re-analyze
    expect(result.reanalyzed).toEqual(['claude'])
  })

  it('re-analyzes when no timelineHash exists in old analysis (backward compat)', async () => {
    const oldAnalysis = {
      ...mockAnalysis,
      incidentId: 'inc-1',
      analyzedAt: '2026-03-27T03:00:00Z',
      // no timelineHash — old analysis before this feature
    }
    const store: Record<string, string> = { [analysisKey('claude', 'inc-1')]: JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('claude', [{
      id: 'inc-1',
      status: 'investigating',
      timeline: [{ stage: 'investigating', text: 'Looking into it', at: '2026-03-27T03:00:00Z' }],
    }])
    const analyzeFn = vi.fn().mockResolvedValue({ ...mockAnalysis, incidentId: 'inc-1' })

    const now = new Date('2026-03-27T05:30:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).toHaveBeenCalledOnce() // should re-analyze since no hash to compare
    expect(result.reanalyzed).toEqual(['claude'])
  })

  it('dedup: does not count copied analysis toward re-analysis cap', async () => {
    const sharedAnalysis = { ...mockAnalysis, incidentId: 'inc-shared' }
    const store: Record<string, string> = {
      [analysisKey('claude', 'inc-shared')]: JSON.stringify(sharedAnalysis),
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

  it('analyzes multiple active incidents per service independently', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const svc = mockService('elevenlabs', [
      { id: 'el-inc-1', status: 'investigating', title: 'TTS Latency' },
      { id: 'el-inc-2', status: 'investigating', title: 'Voice Cloning Error' },
    ])
    const analyzeFn = vi.fn()
      .mockResolvedValueOnce({ ...mockAnalysis, incidentId: 'el-inc-1', summary: 'TTS analysis' })
      .mockResolvedValueOnce({ ...mockAnalysis, incidentId: 'el-inc-2', summary: 'Voice analysis' })

    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 5)

    expect(analyzeFn).toHaveBeenCalledTimes(2)
    expect(result.reanalyzed).toEqual(['elevenlabs', 'elevenlabs'])
    // Each incident has its own KV key
    const stored1 = JSON.parse(store[analysisKey('elevenlabs', 'el-inc-1')])
    expect(stored1.summary).toBe('TTS analysis')
    const stored2 = JSON.parse(store[analysisKey('elevenlabs', 'el-inc-2')])
    expect(stored2.summary).toBe('Voice analysis')
  })

  it('skips resolved incidents and only analyzes active ones', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const svc = mockService('elevenlabs', [
      { id: 'el-active', status: 'investigating', title: 'Active Issue' },
      { id: 'el-resolved', status: 'resolved', title: 'Old Issue' },
    ])
    const analyzeFn = vi.fn().mockResolvedValue({ ...mockAnalysis, incidentId: 'el-active' })

    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 5)

    expect(analyzeFn).toHaveBeenCalledOnce()
    expect(result.reanalyzed).toEqual(['elevenlabs'])
    expect(store[analysisKey('elevenlabs', 'el-active')]).toBeDefined()
    expect(store[analysisKey('elevenlabs', 'el-resolved')]).toBeUndefined()
  })

  it('refreshes TTL independently per incident in multi-incident service', async () => {
    const analysis1 = { ...mockAnalysis, incidentId: 'el-1', analyzedAt: '2026-03-27T05:10:00Z' }
    const analysis2 = { ...mockAnalysis, incidentId: 'el-2', analyzedAt: '2026-03-27T05:10:00Z' }
    const store: Record<string, string> = {
      [analysisKey('elevenlabs', 'el-1')]: JSON.stringify(analysis1),
      [analysisKey('elevenlabs', 'el-2')]: JSON.stringify(analysis2),
    }
    const kv = mockKV(store)
    const svc = mockService('elevenlabs', [
      { id: 'el-1', status: 'investigating' },
      { id: 'el-2', status: 'investigating' },
    ])
    const analyzeFn = vi.fn()

    const now = new Date('2026-03-27T05:50:00Z').getTime() // 40min elapsed
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).not.toHaveBeenCalled()
    expect(result.refreshed).toEqual(['elevenlabs', 'elevenlabs'])
    // Both keys refreshed independently
    expect(kv.put).toHaveBeenCalledWith(
      analysisKey('elevenlabs', 'el-1'),
      expect.stringContaining('_lastRefresh'),
      { expirationTtl: 3600 },
    )
    expect(kv.put).toHaveBeenCalledWith(
      analysisKey('elevenlabs', 'el-2'),
      expect.stringContaining('_lastRefresh'),
      { expirationTtl: 3600 },
    )
  })

  it('per-incident cooldown does not block other incidents on same service', async () => {
    // el-1 has cooldown, el-2 should still be analyzed
    const store: Record<string, string> = {
      'ai:reanalysis-skip:elevenlabs:el-1': '1',
    }
    const kv = mockKV(store)
    const svc = mockService('elevenlabs', [
      { id: 'el-1', status: 'investigating' },
      { id: 'el-2', status: 'investigating' },
    ])
    const analyzeFn = vi.fn().mockResolvedValue({ ...mockAnalysis, incidentId: 'el-2' })

    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 5)

    expect(analyzeFn).toHaveBeenCalledOnce() // only el-2
    expect(result.skipped).toEqual(['elevenlabs'])
    expect(result.reanalyzed).toEqual(['elevenlabs'])
  })

  it('cap applies across all incidents (multi-incident + multi-service)', async () => {
    const kv = mockKV()
    const svcs = [
      mockService('elevenlabs', [
        { id: 'el-1', status: 'investigating' },
        { id: 'el-2', status: 'investigating' },
      ]),
      mockService('openai', [{ id: 'oi-1', status: 'investigating' }]),
    ]
    const analyzeFn = vi.fn().mockResolvedValue(mockAnalysis)

    const result = await refreshOrReanalyze(svcs, kv, 'key', analyzeFn, 2)

    // Cap=2: el-1 and el-2 analyzed, oi-1 skipped
    expect(analyzeFn).toHaveBeenCalledTimes(2)
    expect(result.skipped).toContain('openai')
  })

  it('dedup shared incidentId across services with per-incident keys', async () => {
    // claude and claudeai share inc-shared, claudecode has different incident
    const sharedAnalysis = { ...mockAnalysis, incidentId: 'inc-shared' }
    const store: Record<string, string> = {
      [analysisKey('claude', 'inc-shared')]: JSON.stringify(sharedAnalysis),
    }
    const kv = mockKV(store)
    const services = [
      mockService('claude', [{ id: 'inc-shared', status: 'investigating' }]),
      mockService('claudeai', [{ id: 'inc-shared', status: 'investigating' }]),
      mockService('claudecode', [{ id: 'inc-shared', status: 'investigating' }]),
    ]
    const analyzeFn = vi.fn()

    const now = new Date('2026-03-27T06:00:00Z').getTime()
    const result = await refreshOrReanalyze(services, kv, 'key', analyzeFn, 5, now)

    expect(analyzeFn).not.toHaveBeenCalled()
    // Both siblings copied from claude
    expect(store[analysisKey('claudeai', 'inc-shared')]).toBeDefined()
    expect(store[analysisKey('claudecode', 'inc-shared')]).toBeDefined()
    expect(result.reanalyzed).toContain('claudeai')
    expect(result.reanalyzed).toContain('claudecode')
  })

  it('re-analyzes when estimated recovery time is exceeded despite unchanged timeline', async () => {
    const oldAnalysis = {
      ...mockAnalysis,
      incidentId: 'inc-1',
      analyzedAt: '2026-03-27T03:00:00Z',
      estimatedRecoveryHours: 6, // predicted 6h recovery
      timelineHash: '2026-03-27T03:00:00Z',
    }
    const store: Record<string, string> = { [analysisKey('deepgram', 'inc-1')]: JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('deepgram', [{
      id: 'inc-1',
      status: 'investigating',
      startedAt: '2026-03-27T02:00:00Z', // incident started 1h before analysis
      timeline: [{ stage: 'investigating', text: 'Looking into it', at: '2026-03-27T03:00:00Z' }],
    }])
    const updatedAnalysis = { ...mockAnalysis, incidentId: 'inc-1', summary: 'Recovery exceeded re-analysis' }
    const analyzeFn = vi.fn().mockResolvedValue(updatedAnalysis)

    // 15h since incident start — well beyond 6h estimate
    const now = new Date('2026-03-27T17:00:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).toHaveBeenCalledOnce()
    expect(result.reanalyzed).toEqual(['deepgram'])
    const stored = JSON.parse(store[analysisKey('deepgram', 'inc-1')])
    expect(stored.summary).toBe('Recovery exceeded re-analysis')
  })

  it('does not trigger recovery-exceeded re-analysis when within estimated time', async () => {
    const oldAnalysis = {
      ...mockAnalysis,
      incidentId: 'inc-1',
      analyzedAt: '2026-03-27T03:00:00Z',
      estimatedRecoveryHours: 6,
      timelineHash: '2026-03-27T03:00:00Z',
    }
    const store: Record<string, string> = { [analysisKey('deepgram', 'inc-1')]: JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('deepgram', [{
      id: 'inc-1',
      status: 'investigating',
      startedAt: '2026-03-27T02:00:00Z',
      timeline: [{ stage: 'investigating', text: 'Looking into it', at: '2026-03-27T03:00:00Z' }],
    }])
    const analyzeFn = vi.fn()

    // 5h since incident start — within 6h estimate
    const now = new Date('2026-03-27T07:00:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).not.toHaveBeenCalled()
    expect(result.refreshed).toEqual(['deepgram'])
  })

  it('passes prevPrediction context to analyzeFn when recovery exceeded', async () => {
    const oldAnalysis = {
      ...mockAnalysis,
      incidentId: 'inc-1',
      analyzedAt: '2026-03-27T03:00:00Z',
      estimatedRecoveryHours: 4,
      timelineHash: '2026-03-27T03:00:00Z',
    }
    const store: Record<string, string> = { [analysisKey('deepgram', 'inc-1')]: JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('deepgram', [{
      id: 'inc-1',
      status: 'investigating',
      startedAt: '2026-03-27T02:00:00Z', // incident started 1h before analysis
      timeline: [{ stage: 'investigating', text: 'Looking into it', at: '2026-03-27T03:00:00Z' }],
    }])
    const analyzeFn = vi.fn().mockResolvedValue({ ...mockAnalysis, incidentId: 'inc-1' })

    // 11h since incident start — 2.75× the 4h estimate
    const now = new Date('2026-03-27T13:00:00Z').getTime()
    await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    // elapsedHours should be incident age (11h), not analysis age (10h)
    expect(analyzeFn).toHaveBeenCalledWith(
      'key', expect.any(String), expect.any(Object), expect.any(Array),
      expect.objectContaining({ estimatedRecoveryHours: 4, elapsedHours: expect.closeTo(11, 0.1) }),
      undefined,
    )
  })

  it('re-analyzes on recovery exceeded even when new timeline entries are boilerplate', async () => {
    const oldAnalysis = {
      ...mockAnalysis,
      incidentId: 'inc-1',
      analyzedAt: '2026-03-27T03:00:00Z',
      estimatedRecoveryHours: 2,
      timelineHash: '2026-03-27T03:00:00Z',
    }
    const store: Record<string, string> = { [analysisKey('deepgram', 'inc-1')]: JSON.stringify(oldAnalysis) }
    const kv = mockKV(store)
    const svc = mockService('deepgram', [{
      id: 'inc-1',
      status: 'monitoring',
      startedAt: '2026-03-27T02:00:00Z',
      timeline: [
        { stage: 'investigating', text: 'We are investigating this issue', at: '2026-03-27T03:00:00Z' },
        { stage: 'monitoring', text: 'We are continuing to monitor', at: '2026-03-27T04:00:00Z' },
      ],
    }])
    const analyzeFn = vi.fn().mockResolvedValue({ ...mockAnalysis, incidentId: 'inc-1' })

    // 9h since incident start — 4.5× the 2h estimate
    const now = new Date('2026-03-27T11:00:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    // Should re-analyze despite boilerplate, because recovery exceeded
    expect(analyzeFn).toHaveBeenCalledOnce()
    expect(result.reanalyzed).toEqual(['deepgram'])
  })
})

describe('parseRecoveryHours', () => {
  it('parses range format with hours', () => {
    expect(parseRecoveryHours('4–6h')).toBe(6)
    expect(parseRecoveryHours('1–3h')).toBe(3)
  })

  it('parses range format with mixed units', () => {
    expect(parseRecoveryHours('30m–1h')).toBe(1)
    expect(parseRecoveryHours('15m–45m')).toBe(0.75)
  })

  it('parses single value', () => {
    expect(parseRecoveryHours('2h')).toBe(2)
    expect(parseRecoveryHours('30m')).toBe(0.5)
    expect(parseRecoveryHours('1h 30m')).toBe(1.5)
  })

  it('returns null for N/A', () => {
    expect(parseRecoveryHours('N/A')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseRecoveryHours('')).toBeNull()
  })

  it('handles hyphen as range separator', () => {
    expect(parseRecoveryHours('2-4h')).toBe(4)
  })
})

describe('formatRecoveryDisplay', () => {
  it('replaces N/A with user-friendly text', () => {
    expect(formatRecoveryDisplay('N/A')).toBe('Exceeded typical pattern')
  })

  it('replaces no-historical-data text', () => {
    expect(formatRecoveryDisplay('No historical data for estimation')).toBe('Monitoring recovery signals...')
  })

  it('passes through normal recovery times', () => {
    expect(formatRecoveryDisplay('1–3h')).toBe('1–3h')
    expect(formatRecoveryDisplay('30m–1h')).toBe('30m–1h')
    expect(formatRecoveryDisplay('5–10m')).toBe('5–10m')
  })

  it('passes through single values', () => {
    expect(formatRecoveryDisplay('~1h')).toBe('~1h')
    expect(formatRecoveryDisplay('Resolved')).toBe('Resolved')
  })
})

// ── New: parseAnalysisResponse + hybrid fallback tests ──

describe('parseAnalysisResponse', () => {
  const incId = 'inc-123'
  const timelineAt = '2026-04-17T10:00:00Z'

  it('parses valid JSON and sets model field', () => {
    const text = JSON.stringify({
      summary: 'API errors spiked.',
      estimatedRecovery: '30m–1h',
      affectedScope: ['Chat completions'],
      needsFallback: true,
    })
    const result = parseAnalysisResponse(text, incId, 'gemma', timelineAt)
    expect(result).not.toBeNull()
    expect(result!.model).toBe('gemma')
    expect(result!.summary).toBe('API errors spiked.')
    expect(result!.incidentId).toBe(incId)
    expect(result!.timelineHash).toBe(timelineAt)
  })

  it('parses JSON wrapped in markdown code block', () => {
    const text = '```json\n{"summary":"Test","estimatedRecovery":"1–2h","affectedScope":[],"needsFallback":false}\n```'
    const result = parseAnalysisResponse(text, incId, 'sonnet', timelineAt)
    expect(result!.model).toBe('sonnet')
  })

  it('normalizes full word recovery format', () => {
    const text = JSON.stringify({ summary: 'Degraded.', estimatedRecovery: '30 minutes to 2 hours', affectedScope: [], needsFallback: false })
    const result = parseAnalysisResponse(text, incId, 'gemma', timelineAt)
    expect(result!.estimatedRecovery).toBe('30m–2h')
    expect(result!.estimatedRecoveryHours).toBe(2)
  })

  it('returns null for non-JSON text', () => {
    expect(parseAnalysisResponse('No JSON here.', incId, 'gemma', timelineAt)).toBeNull()
  })

  it('returns null when summary is missing', () => {
    const text = JSON.stringify({ estimatedRecovery: '1h', affectedScope: [], needsFallback: false })
    expect(parseAnalysisResponse(text, incId, 'gemma', timelineAt)).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseAnalysisResponse('{ summary: bad json }', incId, 'gemma', timelineAt)).toBeNull()
  })

  it('handles needsFallback as string "true"', () => {
    const text = JSON.stringify({ summary: 'Outage.', estimatedRecovery: 'N/A', affectedScope: [], needsFallback: 'true' })
    expect(parseAnalysisResponse(text, incId, 'gemma', timelineAt)!.needsFallback).toBe(true)
  })
})

describe('analyzeIncident — hybrid fallback', () => {
  const incident = {
    id: 'inc-1',
    title: 'Elevated error rates',
    status: 'investigating',
    startedAt: '2026-04-17T08:00:00Z',
    impact: 'major' as const,
    timeline: [],
  }

  it('uses Gemma when AI binding succeeds', async () => {
    const mockAi = {
      run: vi.fn().mockResolvedValue({
        response: JSON.stringify({ summary: 'Gemma result.', estimatedRecovery: '1–2h', affectedScope: ['API'], needsFallback: true }),
      }),
    }
    const result = await analyzeIncident('key', 'Claude API', incident, [], undefined, mockAi as unknown as Ai)
    expect(result!.model).toBe('gemma')
    expect(mockAi.run).toHaveBeenCalledOnce()
  })

  it('falls back to Sonnet when Gemma returns unparseable response', async () => {
    const mockAi = { run: vi.fn().mockResolvedValue({ response: 'Cannot analyze.' }) }
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({ summary: 'Sonnet fallback.', estimatedRecovery: '30m', affectedScope: [], needsFallback: false }) }] }),
    }) as unknown as typeof fetch
    try {
      const result = await analyzeIncident('key', 'Claude API', incident, [], undefined, mockAi as unknown as Ai)
      expect(result!.model).toBe('sonnet')
    } finally { globalThis.fetch = originalFetch }
  })

  it('falls back to Sonnet when Gemma throws', async () => {
    const mockAi = { run: vi.fn().mockRejectedValue(new Error('rate limit')) }
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({ summary: 'Sonnet.', estimatedRecovery: '2h', affectedScope: [], needsFallback: true }) }] }),
    }) as unknown as typeof fetch
    try {
      const result = await analyzeIncident('key', 'Claude API', incident, [], undefined, mockAi as unknown as Ai)
      expect(result!.model).toBe('sonnet')
    } finally { globalThis.fetch = originalFetch }
  })

  it('uses Sonnet directly when no AI binding', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({ summary: 'Sonnet only.', estimatedRecovery: '1h', affectedScope: [], needsFallback: false }) }] }),
    }) as unknown as typeof fetch
    try {
      const result = await analyzeIncident('key', 'Claude API', incident, [])
      expect(result!.model).toBe('sonnet')
    } finally { globalThis.fetch = originalFetch }
  })

  it('returns null when both Gemma and Sonnet fail', async () => {
    const mockAi = { run: vi.fn().mockRejectedValue(new Error('err')) }
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('') }) as unknown as typeof fetch
    try {
      expect(await analyzeIncident('key', 'Claude API', incident, [], undefined, mockAi as unknown as Ai)).toBeNull()
    } finally { globalThis.fetch = originalFetch }
  })

  it('skips Sonnet fallback when apiKey is empty', async () => {
    const mockAi = { run: vi.fn().mockRejectedValue(new Error('err')) }
    const result = await analyzeIncident('', 'Claude API', incident, [], undefined, mockAi as unknown as Ai)
    expect(result).toBeNull()
  })
})

import { describe, it, expect, vi } from 'vitest'
import { findSimilarIncidents, buildAnalysisPrompt, analyzeIncident } from '../ai-analysis'
import type { Incident } from '../types'

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

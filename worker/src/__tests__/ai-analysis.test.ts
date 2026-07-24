import { describe, it, expect, vi } from 'vitest'
import { findSimilarIncidents, buildAnalysisPrompt, buildHistorySection, analyzeIncidentDetailed, refreshOrReanalyze, analysisKey, firstEstimateKey, firstEstimateOf, pinFirstEstimate, FIRST_ESTIMATE_TTL_S, parseAnalysis, isBoilerplate, isGenericIncident, shouldSkipInitialAnalysis, GENERIC_TITLE_PATTERNS_SOURCES, parseRecoveryHours, formatRecoveryDisplay, formatAnalysisEmbedSection, parseAnalysisResponse, reanalysisLockTtlSec, applyAttempt, applyHoldEvent, timedOutAttribution, holdLedger, recordHoldEvent, parseUsage, emptyUsage, summarizeAiUsageTrend, formatAiUsageTrendLine, AI_USAGE_TTL_S, analyzeIncidentWithBudget, INLINE_ANALYSIS_BUDGET_MS, SONNET_MAX_TOKENS, type AIAnalysisResult, type AnalysisAttempt, type AnalysisFailureKind, type KVLike } from '../ai-analysis'
import type { IncidentHistoryRecord } from '../incident-history'
import { ANTHROPIC_TIMEOUT_MS } from '../anthropic'
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

  it('does NOT match human-written copy starting with "We are aware/investigating" (anchor regression #387)', () => {
    // Pre-fix the pattern was unanchored at the end so a real curated title
    // starting with this prose got wrongly skipped. Lock the anchored form.
    expect(isGenericIncident('We are aware of an issue with API requests timing out', [])).toBe(false)
    expect(isGenericIncident('We are investigating elevated 5xx on /v1/messages', [])).toBe(false)
  })
})

describe('GENERIC_TITLE_PATTERNS_SOURCES — cross-file parity (#387)', () => {
  // Worker is source-of-truth. SPA (`src/utils/__tests__/incidentGrouping.test.js`)
  // and SSR (`api/_is-down/__tests__/incident-grouping.test.ts`) pin this same
  // snapshot. Any drift fails one test in each suite — no asymmetric prod
  // behavior survives merge.
  const EXPECTED_SOURCES = [
    '^investigating (an |the |this )?issue\\.?$::i',
    '^(service |system )?(disruption|outage|issue|incident)\\.?$::i',
    '^we are (currently )?(investigating|aware)( (of )?(an?|this|the) (issue|incident|problem))?\\.?$::i',
    '^(scheduled |planned )?maintenance\\.?$::i',
    '^(partial |minor |major )?(service )?(degradation|interruption)\\.?$::i',
  ]

  it('worker pattern sources match the canonical snapshot', () => {
    expect(GENERIC_TITLE_PATTERNS_SOURCES).toEqual(EXPECTED_SOURCES)
  })
})

describe('shouldSkipInitialAnalysis (#387)', () => {
  // Three skip reasons must stay in sync with the re-analysis path. These
  // tests lock the contract AND the discriminated return value so the call
  // site's observability log carries the right reason.

  it('returns "merged" for Together-AI flap-merged alerts', () => {
    expect(
      shouldSkipInitialAnalysis(
        { _mergedKeys: ['alerted:new:a', 'alerted:new:b'] },
        { title: 'Real outage', timeline: [{ text: 'Upstream provider returning 500' }] },
        true,
      ),
    ).toBe('merged')
  })

  it('returns "no-model" when neither AI binding nor Sonnet API key is configured', () => {
    expect(
      shouldSkipInitialAnalysis(
        {},
        { title: 'Real outage', timeline: [{ text: 'Upstream provider returning 500' }] },
        false,
      ),
    ).toBe('no-model')
  })

  it('returns "generic" for Statuspage auto-monitoring placeholder titles', () => {
    // The Character.AI bug (#387) — initial-analysis path was firing on these.
    expect(
      shouldSkipInitialAnalysis(
        {},
        { title: 'Investigating an issue' },
        true,
      ),
    ).toBe('generic')
    expect(
      shouldSkipInitialAnalysis(
        {},
        { title: 'Investigating an issue', timeline: [{ text: 'We are investigating' }] },
        true,
      ),
    ).toBe('generic')
  })

  it('returns null (proceed) for a real human-titled incident with AI available', () => {
    expect(
      shouldSkipInitialAnalysis(
        {},
        { title: 'Elevated error rates on /v1/messages', timeline: [{ text: 'Spike to 40%' }] },
        true,
      ),
    ).toBeNull()
  })

  it('returns null when generic-title carries actionable timeline detail', () => {
    // isGenericIncident is conservative: title alone isn't enough; if the
    // timeline has technical detail, the analysis can still produce useful
    // output. Locks that pass-through.
    expect(
      shouldSkipInitialAnalysis(
        {},
        {
          title: 'Investigating an issue',
          timeline: [
            { text: 'We are investigating' },
            { text: 'Error rates spiked to 40% on /v1/messages endpoint.' },
          ],
        },
        true,
      ),
    ).toBeNull()
  })

  it('precedence: merged > no-model > generic > null', () => {
    // When multiple skip conditions apply, the first-listed reason wins.
    // This locks the order so a future refactor doesn't silently change
    // which reason gets logged at the call site.
    expect(
      shouldSkipInitialAnalysis(
        { _mergedKeys: ['x'] },
        { title: 'Investigating an issue' },
        false,
      ),
    ).toBe('merged')
    expect(
      shouldSkipInitialAnalysis(
        {},
        { title: 'Investigating an issue' },
        false,
      ),
    ).toBe('no-model')
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

  // #827 Feature 2 — RAG grounding from the durable corpus
  const histRec = (over: Partial<IncidentHistoryRecord> = {}): IncidentHistoryRecord => ({
    svcId: 'claude', incId: 'h1', title: 'Elevated errors on Messages API', provider: 'Anthropic',
    category: 'api', impact: 'major', startedAt: '2026-06-01T10:00:00Z', resolvedAt: '2026-06-01T10:52:00Z',
    durationMin: 52, predictedRecoveryHours: 1, predictedSummary: 'Network errors on the API', model: 'gemma', ...over,
  })

  it('prefers the durable-corpus grounding over the title-only list when history is supplied', () => {
    const similar = [mockIncident({ title: 'Old inmemory incident', duration: '45m' })]
    const prompt = buildAnalysisPrompt(
      'Claude API',
      { title: 'Elevated errors', status: 'investigating', startedAt: '2026-06-02T10:00:00Z', impact: 'major' },
      similar,
      undefined,
      [histRec()],
    )
    expect(prompt).toContain('actual recovery 52m')           // actual outcome
    expect(prompt).toContain('we estimated ~1h')              // our prior estimate
    expect(prompt).toContain('Prior read:')                   // prior AI summary
    expect(prompt).toContain('ACTUALLY happened')             // the corpus label
    expect(prompt).not.toContain('Historical Data (last 30 days)') // title-only label suppressed
    expect(prompt).not.toContain('Old inmemory incident')     // title-only list suppressed
  })

  it('falls back to the in-memory title-only list when no corpus records supplied', () => {
    const similar = [mockIncident({ title: 'Past Error 1', duration: '45m' })]
    const prompt = buildAnalysisPrompt(
      'OpenAI',
      { title: 'Current error', status: 'investigating', startedAt: '2026-06-02T10:00:00Z', impact: null },
      similar,
      undefined,
      [],
    )
    expect(prompt).toContain('Historical Data (last 30 days)')
    expect(prompt).toContain('Past Error 1')
    expect(prompt).not.toContain('actual recovery')
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

  // #900 Layer 2 — on re-analysis of a long-running incident, forbid a shorter-than-elapsed estimate
  it('anchors the estimate to elapsed time on re-analysis (do-not-output-shorter + N/A escape hatch)', () => {
    const prompt = buildAnalysisPrompt(
      'Mistral', { title: 'Completion API Degraded', status: 'identified', startedAt: '2026-06-27T00:00:00Z', impact: 'minor' },
      [], { estimatedRecoveryHours: 8, elapsedHours: 69 },
    )
    expect(prompt).toContain('ALREADY been ongoing 69h')
    expect(prompt).toContain('do NOT output')
    expect(prompt).toContain('less than 69h')
    expect(prompt).toContain('"N/A"')
  })

  it('omits previous prediction context when prevPrediction is not provided', () => {
    const prompt = buildAnalysisPrompt(
      'Deepgram', { title: 'Voice API Error', status: 'investigating', startedAt: '2026-03-27T03:00:00Z', impact: 'major' }, [],
    )
    expect(prompt).not.toContain('Previous Prediction')
  })
})

describe('buildHistorySection (#827)', () => {
  const base: IncidentHistoryRecord = {
    svcId: 'claude', incId: 'h1', title: 'Streaming latency', provider: 'Anthropic', category: 'api',
    impact: 'minor', startedAt: '2026-06-01T10:00:00Z', resolvedAt: '2026-06-01T13:10:00Z', durationMin: 190,
  }
  it('renders actual recovery; omits prediction clause when no prediction', () => {
    const out = buildHistorySection([base])
    expect(out).toContain('actual recovery 3h 10m')
    expect(out).not.toContain('we estimated')
    expect(out).not.toContain('Prior read')
  })
  it('labels accuracy: accurate / under-estimated / over-estimated', () => {
    expect(buildHistorySection([{ ...base, durationMin: 50, predictedRecoveryHours: 1 }])).toContain('(accurate)')
    expect(buildHistorySection([{ ...base, durationMin: 200, predictedRecoveryHours: 1 }])).toContain('(we under-estimated)')
    expect(buildHistorySection([{ ...base, durationMin: 20, predictedRecoveryHours: 3 }])).toContain('(we over-estimated)')
  })
  it('includes the prior AI summary when present', () => {
    const out = buildHistorySection([{ ...base, predictedSummary: 'Network errors on the API' }])
    expect(out).toContain('Prior read: "Network errors on the API"')
  })
})

describe('analyzeIncidentDetailed', () => {
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

    const { result } = await analyzeIncidentDetailed('fake-key', 'Claude API', mockInc, mockIncidents)
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

    const { result } = await analyzeIncidentDetailed('fake-key', 'Test', mockInc, [])
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

    const { result } = await analyzeIncidentDetailed('fake-key', 'Test', mockInc, [])
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

    const { result } = await analyzeIncidentDetailed('fake-key', 'Test', mockInc, [])
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

    const { result } = await analyzeIncidentDetailed('fake-key', 'Test', mockInc, [])
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

    const { result } = await analyzeIncidentDetailed('fake-key', 'Test', mockInc, [])
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

    const { result } = await analyzeIncidentDetailed('fake-key', 'Test', mockInc, [])
    expect(result).toBeNull()

    vi.unstubAllGlobals()
  })

  it('returns null on malformed JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: 'not json at all' }] }),
    }))

    const { result } = await analyzeIncidentDetailed('fake-key', 'Test', mockInc, [])
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
    const { result } = await analyzeIncidentDetailed('fake-key', 'Test', incWithTimeline, [])
    expect(result).not.toBeNull()
    expect(result!.timelineHash).toBe('2026-03-26T11:30:00Z')

    vi.unstubAllGlobals()
  })

  it('returns null on network timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))

    const { result } = await analyzeIncidentDetailed('fake-key', 'Test', mockInc, [])
    expect(result).toBeNull()

    vi.unstubAllGlobals()
  })
})

// ── #955: failure classification, lock TTL, usage counters ──

describe('reanalysisLockTtlSec', () => {
  // Only a permanent failure earns the long lock. A transient one used to get the same flat
  // 30min ban, skipping six cron cycles and outliving the #882 AI-hold window.
  it('locks 30min for permanent failures only', () => {
    expect(reanalysisLockTtlSec('permanent')).toBe(1800)
  })

  it('does not lock for transient or aborted failures', () => {
    expect(reanalysisLockTtlSec('transient')).toBe(0)
    expect(reanalysisLockTtlSec('aborted')).toBe(0)
  })

  it('backs off one cron cycle on an unexpected throw', () => {
    expect(reanalysisLockTtlSec('unknown')).toBe(300)
  })

  // The lock must never outlive the #882 AI_HOLD_MS (~10min) window for a retryable failure,
  // or the alert is guaranteed to ship AI-less.
  it('keeps every retryable lock inside the #882 AI-hold window', () => {
    const AI_HOLD_SEC = 600
    for (const failure of ['transient', 'aborted', 'unknown'] as const) {
      expect(reanalysisLockTtlSec(failure)).toBeLessThanOrEqual(AI_HOLD_SEC)
    }
  })
})

describe('applyAttempt / parseUsage', () => {
  const gemmaResult = { ...({} as AIAnalysisResult), model: 'gemma' as const }
  const sonnetResult = { ...({} as AIAnalysisResult), model: 'sonnet' as const }

  it('counts a Gemma success', () => {
    const usage = applyAttempt(emptyUsage(), { result: gemmaResult, failure: null, attempts: { gemma: 1, sonnet: 0 } }, 'claude')
    expect(usage).toMatchObject({ calls: 1, success: 1, failed: 0, gemma: 1, gemmaAttempts: 1 })
    expect(usage.sonnetAttempts).toBeUndefined()
  })

  // The dead-fallback signal: Sonnet was ATTEMPTED but never succeeded. The old counters
  // only tracked successes, so this was indistinguishable from "never reached".
  it('counts a Sonnet attempt even when it fails', () => {
    const usage = applyAttempt(emptyUsage(), { result: null, failure: 'permanent', attempts: { gemma: 1, sonnet: 1 } }, 'claude')
    expect(usage).toMatchObject({ calls: 1, success: 0, failed: 1, gemmaAttempts: 1, sonnetAttempts: 1 })
    expect(usage.sonnet).toBeUndefined()
  })

  it('books an abort as timedOut, not failed', () => {
    const usage = applyAttempt(emptyUsage(), { result: null, failure: 'aborted', attempts: { gemma: 1, sonnet: 0 } }, 'claude')
    expect(usage).toMatchObject({ calls: 1, success: 0, failed: 0, timedOut: 1 })
  })

  // ── #1080 — attribute the overrun (the #882 blind spot) ──

  it('attributes a timedOut to the service that caused it', () => {
    const usage = applyAttempt(emptyUsage(), { result: null, failure: 'aborted', attempts: { gemma: 1, sonnet: 0 } }, 'mistral')
    expect(usage.timedOutBy).toEqual({ mistral: 1 })
  })

  it('accumulates per service and keeps them separate', () => {
    let usage = applyAttempt(emptyUsage(), { result: null, failure: 'aborted', attempts: { gemma: 1, sonnet: 0 } }, 'mistral')
    usage = applyAttempt(usage, { result: null, failure: 'aborted', attempts: { gemma: 1, sonnet: 0 } }, 'mistral')
    usage = applyAttempt(usage, { result: null, failure: 'aborted', attempts: { gemma: 1, sonnet: 0 } }, 'claude')
    expect(usage.timedOut).toBe(3)
    expect(usage.timedOutBy).toEqual({ mistral: 2, claude: 1 })
  })

  // The whole point of #1080: `timedOut: 1` cannot answer #882 without knowing WHICH service overran.
  it('attributes each overrun to its own service', () => {
    let usage = applyAttempt(emptyUsage(), { result: null, failure: 'aborted', attempts: { gemma: 1, sonnet: 0 } }, 'openai')
    usage = applyAttempt(usage, { result: null, failure: 'aborted', attempts: { gemma: 1, sonnet: 0 } }, 'cursor')
    expect(Object.keys(usage.timedOutBy ?? {}).sort()).toEqual(['cursor', 'openai'])
  })

  it('does not attribute a success or a plain failure — only aborts', () => {
    const ok = applyAttempt(emptyUsage(), { result: gemmaResult, failure: null, attempts: { gemma: 1, sonnet: 0 } }, 'mistral')
    expect(ok.timedOutBy).toBeUndefined()
    const bad = applyAttempt(emptyUsage(), { result: null, failure: 'permanent', attempts: { gemma: 1, sonnet: 1 } }, 'mistral')
    expect(bad.timedOutBy).toBeUndefined()
  })

  // `holdSvcId`-style defensive `?? ''` exists upstream; a `""` key would be worse than no key.
  it('skips attribution for an empty service id but still counts the overrun', () => {
    const usage = applyAttempt(emptyUsage(), { result: null, failure: 'aborted', attempts: { gemma: 1, sonnet: 0 } }, '')
    expect(usage.timedOut).toBe(1)
    expect(usage.timedOutBy).toBeUndefined()
  })

  // ── #1080 — absence must read as UNKNOWN, never as zero ──

  it('timedOutAttribution: no overruns at all is a KNOWN empty', () => {
    expect(timedOutAttribution(emptyUsage())).toEqual({ by: {}, unattributed: 0 })
  })

  // The aiwatch-reports#76 trap, in this repo: a pre-#1080 record HAS overruns and NO map. Reporting
  // that as "0 hold-eligible overruns" would be a confident lie about every day before this shipped.
  it('timedOutAttribution: overruns with no map read as null (unknown), not zero', () => {
    expect(timedOutAttribution({ ...emptyUsage(), timedOut: 2 })).toBeNull()
  })

  it('timedOutAttribution: reports the shortfall when a day straddles the deploy', () => {
    const got = timedOutAttribution({ ...emptyUsage(), timedOut: 3, timedOutBy: { mistral: 1 } })
    expect(got).toEqual({ by: { mistral: 1 }, unattributed: 2 })
  })

  it('timedOutAttribution: returns a copy, so a caller cannot mutate the counters', () => {
    const usage = { ...emptyUsage(), timedOut: 1, timedOutBy: { mistral: 1 } }
    const got = timedOutAttribution(usage)
    got!.by.mistral = 99
    expect(usage.timedOutBy).toEqual({ mistral: 1 })
  })

  it('parseUsage: round-trips timedOutBy', () => {
    const usage = parseUsage(JSON.stringify({ calls: 1, success: 0, failed: 0, timedOut: 1, timedOutBy: { mistral: 1 } }))
    expect(usage.timedOutBy).toEqual({ mistral: 1 })
  })

  // A corrupt map must degrade to "unknown", not to a known-empty that reads as "it was nobody".
  it('parseUsage: a garbage timedOutBy is dropped to absent, so it reads as unknown', () => {
    for (const junk of ['"nope"', '[1,2]', '{"mistral":"x"}', '{"mistral":-3}', 'null']) {
      const usage = parseUsage(`{"calls":1,"success":0,"failed":0,"timedOut":1,"timedOutBy":${junk}}`)
      expect(usage.timedOutBy, junk).toBeUndefined()
      expect(timedOutAttribution(usage), junk).toBeNull()
    }
  })

  // ── #1080 / #882 — the hold ledger ──

  it('applyHoldEvent: counts each lifecycle event on its own axis', () => {
    let usage = applyHoldEvent(emptyUsage(), 'held')
    usage = applyHoldEvent(usage, 'held')
    usage = applyHoldEvent(usage, 'releasedWithAi')
    usage = applyHoldEvent(usage, 'releasedWithoutAi')
    expect(usage).toMatchObject({ held: 2, heldReleasedWithAi: 1, heldReleasedWithoutAi: 1 })
  })

  it('applyHoldEvent: leaves the analysis counters untouched', () => {
    const usage = applyHoldEvent(emptyUsage(), 'held')
    expect(usage).toMatchObject({ calls: 0, success: 0, failed: 0 })
    expect(usage.timedOut).toBeUndefined()
  })

  it('holdLedger: a pre-#1080 record reads as null (unknown), not as zero holds', () => {
    expect(holdLedger(emptyUsage())).toBeNull()
    expect(holdLedger({ ...emptyUsage(), calls: 9, timedOut: 2 })).toBeNull()
  })

  it('holdLedger: a held-then-released-with-AI day is the #882 fix working', () => {
    const usage = applyHoldEvent(applyHoldEvent(emptyUsage(), 'held'), 'releasedWithAi')
    expect(holdLedger(usage)).toEqual({ held: 1, releasedWithAi: 1, releasedWithoutAi: 0 })
  })

  // The signal that the hold bought nothing — this is what a rising count would look like.
  it('holdLedger: a fail-open day shows the release carried no AI', () => {
    const usage = applyHoldEvent(applyHoldEvent(emptyUsage(), 'held'), 'releasedWithoutAi')
    expect(holdLedger(usage)).toMatchObject({ held: 1, releasedWithAi: 0, releasedWithoutAi: 1 })
  })

  // #1080 review — `held` and the releases are NOT a balanced pair, so the ledger deliberately does
  // not publish a held-minus-released figure. Two independent reasons, both routine:
  //   (a) the key is per-UTC-day but the ~10min hold window is not, so a 23:58 hold releases against
  //       the NEXT day's key — that day would read as a negative "in flight";
  //   (b) a held incident that RESOLVES inside the window emits no alert at all on the next cycle, so
  //       it never reaches the release site and the marker just TTLs out. Correct, not a lost release.
  it('holdLedger: exposes the raw counters only — no held-minus-released figure to misread', () => {
    const open = holdLedger(applyHoldEvent(emptyUsage(), 'held'))
    expect(open).toEqual({ held: 1, releasedWithAi: 0, releasedWithoutAi: 0 })
    expect(open).not.toHaveProperty('inFlight')
  })

  it('holdLedger: a release landing on the next UTC day is readable, not negative', () => {
    // The day-2 key legitimately carries a release with no matching `held`.
    const dayTwo = applyHoldEvent(emptyUsage(), 'releasedWithAi')
    expect(holdLedger(dayTwo)).toEqual({ held: 0, releasedWithAi: 1, releasedWithoutAi: 0 })
  })

  // ── #1080 review — scalar counters off the wire ──

  it('parseUsage: coerces a string counter instead of letting it concatenate', () => {
    // `"3" + 1 === "31"` — applyHoldEvent would write a string straight back into the ledger.
    const usage = parseUsage('{"calls":1,"success":0,"failed":0,"held":"3"}')
    expect(usage.held).toBeUndefined()
    expect(applyHoldEvent(usage, 'held').held).toBe(1)
  })

  // `calls`/`success`/`failed` are required (they default to 0 rather than going absent), but they must
  // still be coerced: a wire `"3"` would otherwise reach `summarizeAiUsageTrend`'s `a.calls + u.calls`
  // and build the string `"03"`, after which `formatAiUsageTrendLine`'s `=== 0` guard stops matching.
  it('parseUsage: coerces the required base counters too, not just the optional ones', () => {
    const usage = parseUsage('{"calls":"3","success":null,"failed":-2}')
    expect(usage).toMatchObject({ calls: 0, success: 0, failed: 0 })
    expect(typeof usage.calls).toBe('number')
  })

  it('parseUsage: a null counter reads as ABSENT, not as a confident zero', () => {
    const usage = parseUsage('{"calls":1,"success":0,"failed":0,"held":null,"heldReleasedWithAi":null,"heldReleasedWithoutAi":null}')
    expect(holdLedger(usage), 'null must not satisfy the presence test').toBeNull()
  })

  it('parseUsage: drops an empty-string key the writer could never have produced', () => {
    const usage = parseUsage('{"calls":1,"success":0,"failed":0,"timedOut":1,"timedOutBy":{"":3}}')
    expect(usage.timedOutBy).toBeUndefined()
  })

  it('recordHoldEvent: persists to the same daily key and survives a round-trip', async () => {
    const store: Record<string, string> = {}
    await recordHoldEvent(mockKV(store), Date.parse('2026-07-20T04:00:00Z'), 'held')
    await recordHoldEvent(mockKV(store), Date.parse('2026-07-20T04:05:00Z'), 'releasedWithAi')
    expect(holdLedger(parseUsage(store['ai:usage:2026-07-20']))).toMatchObject({ held: 1, releasedWithAi: 1 })
  })

  // Both writers share one key — a hold event must not clobber the analysis counters written that day.
  it('recordHoldEvent: does not clobber the analysis counters already on the key', async () => {
    const store: Record<string, string> = { 'ai:usage:2026-07-20': JSON.stringify({ calls: 4, success: 3, failed: 0, timedOut: 1, timedOutBy: { mistral: 1 } }) }
    await recordHoldEvent(mockKV(store), Date.parse('2026-07-20T04:00:00Z'), 'held')
    const usage = parseUsage(store['ai:usage:2026-07-20'])
    expect(usage).toMatchObject({ calls: 4, success: 3, timedOut: 1, held: 1 })
    expect(usage.timedOutBy).toEqual({ mistral: 1 })
  })

  it('accumulates across attempts', () => {
    let usage = applyAttempt(emptyUsage(), { result: sonnetResult, failure: null, attempts: { gemma: 1, sonnet: 1 } }, 'claude')
    usage = applyAttempt(usage, { result: null, failure: 'transient', attempts: { gemma: 1, sonnet: 1 } }, 'claude')
    expect(usage).toMatchObject({ calls: 2, success: 1, failed: 1, sonnet: 1, sonnetAttempts: 2, gemmaAttempts: 2 })
  })

  it('reads the pre-#955 counter shape without losing counts', () => {
    expect(parseUsage('{"calls":16,"success":9,"failed":7,"gemma":9,"sonnet":0}'))
      .toMatchObject({ calls: 16, success: 9, failed: 7, gemma: 9, sonnet: 0 })
  })

  it('falls back to zeroes on absent or corrupt KV values', () => {
    expect(parseUsage(null)).toEqual({ calls: 0, success: 0, failed: 0 })
    expect(parseUsage('not json')).toEqual({ calls: 0, success: 0, failed: 0 })
  })
})

describe('summarizeAiUsageTrend / formatAiUsageTrendLine (#995)', () => {
  it('sums a multi-day window and computes rates', () => {
    const t = summarizeAiUsageTrend([
      { calls: 5, success: 4, failed: 0, gemma: 4, gemmaAttempts: 5, timedOut: 1 },
      { calls: 3, success: 2, failed: 0, gemma: 2, gemmaAttempts: 3, timedOut: 1 },
      { calls: 2, success: 1, failed: 0, gemma: 0, gemmaAttempts: 2, sonnet: 1, sonnetAttempts: 1, timedOut: 1 },
    ])
    expect(t).toMatchObject({ days: 3, calls: 10, gemma: 6, gemmaAttempts: 10, sonnet: 1, timedOut: 3, failed: 0 })
    expect(t.gemmaSuccessRate).toBeCloseTo(0.6)
    expect(t.timedOutRate).toBeCloseTo(0.3)
  })

  it('rates are null (not NaN/0) when the denominator is zero', () => {
    const t = summarizeAiUsageTrend([{ calls: 0, success: 0, failed: 0 }])
    expect(t.gemmaSuccessRate).toBeNull()
    expect(t.timedOutRate).toBeNull()
  })

  it('empty window → zeros, both rates null', () => {
    const t = summarizeAiUsageTrend([])
    expect(t).toMatchObject({ days: 0, calls: 0, gemma: 0, failed: 0 })
    expect(t.gemmaSuccessRate).toBeNull()
  })

  it('formats a line: failed ALWAYS shown, timedOut only when non-zero, Sonnet only when used', () => {
    const line = formatAiUsageTrendLine(summarizeAiUsageTrend([
      { calls: 10, success: 8, failed: 0, gemma: 8, gemmaAttempts: 9, sonnet: 0, timedOut: 1 },
    ]))
    expect(line).toContain('Gemma 8/9 (89%)')
    expect(line).toContain('1 timed out')
    expect(line).toContain('0 failed')
    expect(line).not.toContain('Sonnet')
    expect(line).toContain('(1d)')
  })

  it('omits the timedOut clause when zero, and shows Sonnet when it was a fallback', () => {
    const line = formatAiUsageTrendLine(summarizeAiUsageTrend([
      { calls: 4, success: 4, failed: 0, gemma: 3, gemmaAttempts: 3, sonnet: 1, sonnetAttempts: 1 },
    ]))
    expect(line).toContain('Sonnet 1 fallback')
    expect(line).not.toContain('timed out')
    expect(line).toContain('0 failed')
  })

  it('returns empty string when there were no calls (nothing to report)', () => {
    expect(formatAiUsageTrendLine(summarizeAiUsageTrend([]))).toBe('')
    expect(formatAiUsageTrendLine(summarizeAiUsageTrend([{ calls: 0, success: 0, failed: 0 }]))).toBe('')
  })

  it('retains ai:usage for 30 days so a weekly trend has data (was 2d — #995)', () => {
    expect(AI_USAGE_TTL_S).toBe(30 * 86400)
  })
})

// ── #955 Part 2: the cron's inline budget (analyzeIncidentWithBudget) ──

describe('analyzeIncidentWithBudget', () => {
  const inc = { id: 'inc-1', title: 'Elevated errors', status: 'investigating', startedAt: '2026-07-09T06:00:00Z', impact: 'major' }
  const NOW = Date.UTC(2026, 6, 9)

  it('passes a live AbortSignal down to the analysis', async () => {
    const store: Record<string, string> = {}
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt(mockAnalysis))
    await analyzeIncidentWithBudget(mockKV(store), 'key', undefined, { id: 'claude', name: 'Claude API' }, inc, [], [], 15_000, NOW, analyzeFn)
    const signal = analyzeFn.mock.calls[0][7]
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
  })

  // The pre-#955 `Promise.race` resolved null on timeout but left the Sonnet fetch running: a
  // response arriving after the deadline was paid for, discarded, and booked as `failed`. The
  // budget must now (a) abort the signal, (b) stop awaiting, (c) book `timedOut`, not `failed`.
  it('aborts the signal and gives up when the budget elapses, even if the analysis never settles', async () => {
    const store: Record<string, string> = {}
    let seen: AbortSignal | undefined
    // Never resolves — stands in for a Workers-AI call that outlives the budget.
    const analyzeFn = vi.fn(async (...args: unknown[]) => {
      seen = args[7] as AbortSignal
      const counter = args[8] as { gemma: number; sonnet: number }
      counter.gemma++
      return new Promise<AnalysisAttempt>(() => {})
    })
    const attempt = await analyzeIncidentWithBudget(mockKV(store), 'key', undefined, { id: 'claude', name: 'Claude API' }, inc, [], [], 5, NOW, analyzeFn as never)
    expect(seen!.aborted).toBe(true)
    expect(attempt.failure).toBe('aborted')
    // The counter is mutated by the still-running analysis — the only honest source of attempts.
    expect(attempt.attempts).toEqual({ gemma: 1, sonnet: 0 })
    // #1080 — behavioral round-trip through the WRITER BODY, not just the call site. Making `svcId`
    // required protects callers (the type checker rejects a missing argument), but nothing stops the
    // body from passing the wrong thing onward — e.g. `service.name` instead of `service.id`, which
    // would compile, keep every pure-fn test green, and yield attribution keyed by display name. The
    // source-scan guard covers the call sites; this covers what the function actually persists.
    expect(parseUsage(store['ai:usage:2026-07-09']).timedOutBy).toEqual({ claude: 1 })
    const usage = JSON.parse(store['ai:usage:2026-07-09'])
    expect(usage).toMatchObject({ calls: 1, failed: 0, timedOut: 1, gemmaAttempts: 1 })
  })

  it('resolves as soon as the analysis does — the budget does not delay a fast success', async () => {
    const store: Record<string, string> = {}
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt(mockAnalysis))
    const t0 = Date.now()
    const attempt = await analyzeIncidentWithBudget(mockKV(store), 'key', undefined, { id: 'claude', name: 'Claude API' }, inc, [], [], 60_000, NOW, analyzeFn)
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(attempt.result).toBeTruthy()
  })

  it('clears the budget timer as soon as the analysis resolves', async () => {
    vi.useFakeTimers()
    try {
      const analyzeFn = vi.fn().mockResolvedValue(okAttempt(mockAnalysis))
      await analyzeIncidentWithBudget(mockKV(), 'key', undefined, { id: 'claude', name: 'Claude API' }, inc, [], [], 15_000, NOW, analyzeFn)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('books a successful inline analysis into ai:usage', async () => {
    const store: Record<string, string> = {}
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({ ...mockAnalysis, model: 'sonnet' }))
    const attempt = await analyzeIncidentWithBudget(mockKV(store), 'key', undefined, { id: 'claude', name: 'Claude API' }, inc, [], [], 15_000, NOW, analyzeFn)
    expect(attempt.result).toBeTruthy()
    expect(JSON.parse(store['ai:usage:2026-07-09'])).toMatchObject({ calls: 1, success: 1, sonnet: 1 })
  })

  it('never throws — a throwing analysis is booked as unknown', async () => {
    const store: Record<string, string> = {}
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const analyzeFn = vi.fn().mockRejectedValue(new Error('boom'))
    const attempt = await analyzeIncidentWithBudget(mockKV(store), 'key', undefined, { id: 'claude', name: 'Claude API' }, inc, [], [], 15_000, NOW, analyzeFn)
    expect(attempt).toEqual({ result: null, failure: 'unknown', attempts: { gemma: 0, sonnet: 0 } })
    expect(JSON.parse(store['ai:usage:2026-07-09'])).toMatchObject({ calls: 1, failed: 1 })
    spy.mockRestore()
  })

  // The budget must be long enough for Gemma-fails → Sonnet-succeeds to complete inline: a
  // NEVER_AI_HELD service is never held by #882, so the inline call is its only chance at an AI section.
  it('gives the Sonnet fallback (10s cap) room to finish after a Gemma failure', () => {
    expect(INLINE_ANALYSIS_BUDGET_MS).toBeGreaterThan(ANTHROPIC_TIMEOUT_MS)
  })
})

// ── refreshOrReanalyze tests ──

// #955 — `analyzeFn` is now `analyzeIncidentDetailed`: it reports WHY it produced nothing so
// refreshOrReanalyze can scale the re-analysis lock (see `reanalysisLockTtlSec`).
const okAttempt = (result: AIAnalysisResult): AnalysisAttempt =>
  ({ result, failure: null, attempts: { gemma: 1, sonnet: 0 } })
const failAttempt = (failure: AnalysisFailureKind): AnalysisAttempt =>
  ({ result: null, failure, attempts: { gemma: 1, sonnet: 1 } })

function mockKV(store: Record<string, string> = {}, ttls: Record<string, number | undefined> = {}): KVLike {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store[key] = value
      ttls[key] = opts?.expirationTtl
    }),
    delete: vi.fn(async (key: string) => { delete store[key] }),
  }
}

function mockService(id: string, incidents: Partial<Incident>[] = []): ServiceStatus {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    provider: 'Test',
    category: 'api',
    status: 'degraded',
    latency: null,
    uptime30d: 99.9,
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

// Typed (not inferred) so the tsc gate catches a drifted AIAnalysisResult here rather than
// letting `vi.fn()`'s `any` swallow it — which is how `needsFallback` went missing for so long.
const mockAnalysis: AIAnalysisResult = {
  summary: 'Test analysis',
  estimatedRecovery: '30-60min',
  affectedScope: ['API'],
  needsFallback: false,
  analyzedAt: '2026-03-27T06:10:00Z',
  incidentId: 'inc-1',
}

describe('firstEstimateOf / pinFirstEstimate (#1003 — pin the scoring baseline to the first estimate)', () => {
  const next = (h?: number): AIAnalysisResult => ({
    ...mockAnalysis,
    estimatedRecovery: h ? `${h}h` : 'N/A',
    ...(h != null && { estimatedRecoveryHours: h }),
  })

  it('adopts the fresh estimate as the first when there is no prior and nothing stored', () => {
    expect(firstEstimateOf(next(4), null, null)).toBe(4)
  })

  it('the durable baseline outranks everything (an analysis-key lapse cannot move it)', () => {
    // The analysis key expired mid-incident → the fresh 15h analysis arrives with NO prior, but the
    // durable key still holds the original 4h. Without this precedence the bug simply re-runs.
    expect(firstEstimateOf(next(15), null, 4)).toBe(4)
  })

  it('keeps the prior first estimate across a re-analysis (the inflated value must not win)', () => {
    expect(firstEstimateOf(next(15), { estimatedRecoveryHours: 4, firstEstimatedRecoveryHours: 4 }, null)).toBe(4)
  })

  it('adopts a pre-#1003 prior\'s current estimate as the baseline (in-flight at deploy time)', () => {
    // The analysis already in KV when this ships carries no `firstEstimatedRecoveryHours`, but its
    // `estimatedRecoveryHours` IS the earlier prediction — so an incident mid-flight still scores honestly.
    expect(firstEstimateOf(next(15), { estimatedRecoveryHours: 4 }, null)).toBe(4)
  })

  it('returns null when nothing usable exists (N/A → no fabricated comparison)', () => {
    expect(firstEstimateOf(next(undefined), null, null)).toBeNull()
    expect(firstEstimateOf(next(undefined), { estimatedRecoveryHours: 0 }, null)).toBeNull()
  })

  it('backfills from the fresh estimate when the prior had none (N/A first, numeric later)', () => {
    expect(firstEstimateOf(next(6), { estimatedRecoveryHours: undefined }, null)).toBe(6)
  })

  it('pins the baseline durably on first sight (write-once, 30d)', async () => {
    const store: Record<string, string> = {}
    const ttls: Record<string, number | undefined> = {}
    const kv = mockKV(store, ttls)

    const first = await pinFirstEstimate(kv, 'pinecone', 'inc-1', next(4), null)
    expect(first.firstEstimatedRecoveryHours).toBe(4)
    expect(store[firstEstimateKey('pinecone', 'inc-1')]).toBe('4')
    expect(ttls[firstEstimateKey('pinecone', 'inc-1')]).toBe(FIRST_ESTIMATE_TTL_S)
  })

  it('never re-writes the durable key on a later re-analysis (get-or-set)', async () => {
    const store: Record<string, string> = { [firstEstimateKey('pinecone', 'inc-1')]: '4' }
    const kv = mockKV(store)

    const merged = await pinFirstEstimate(kv, 'pinecone', 'inc-1', next(15), { estimatedRecoveryHours: 4, firstEstimatedRecoveryHours: 4 })

    expect(merged.firstEstimatedRecoveryHours).toBe(4)  // scored against this
    expect(merged.estimatedRecoveryHours).toBe(15)      // live surfaces still show this
    expect(kv.put).not.toHaveBeenCalled()
    expect(store[firstEstimateKey('pinecone', 'inc-1')]).toBe('4')
  })

  it('is idempotent across repeated re-analyses (the estimate ratchets, the baseline does not)', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    let cur = await pinFirstEstimate(kv, 'pinecone', 'inc-1', next(4), null)
    for (const h of [15, 30, 48]) cur = await pinFirstEstimate(kv, 'pinecone', 'inc-1', next(h), cur)
    expect(cur.firstEstimatedRecoveryHours).toBe(4)
    expect(cur.estimatedRecoveryHours).toBe(48)
  })

  it('degrades to the in-value carry when the durable KV read throws (never drops the estimate)', async () => {
    const kv: KVLike = {
      get: vi.fn(async () => { throw new Error('kv down') }),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    }
    const merged = await pinFirstEstimate(kv, 'pinecone', 'inc-1', next(15), { firstEstimatedRecoveryHours: 4 })
    expect(merged.firstEstimatedRecoveryHours).toBe(4)
  })

  it('ignores a corrupt durable value rather than scoring against NaN', async () => {
    const kv = mockKV({ [firstEstimateKey('pinecone', 'inc-1')]: 'not-a-number' })
    const merged = await pinFirstEstimate(kv, 'pinecone', 'inc-1', next(15), { firstEstimatedRecoveryHours: 4 })
    expect(merged.firstEstimatedRecoveryHours).toBe(4)
  })
})

describe('parseAnalysis (#1003 — a corrupt prior must not abort a write)', () => {
  it('parses a valid analysis object', () => {
    expect(parseAnalysis(JSON.stringify(mockAnalysis))?.incidentId).toBe('inc-1')
  })
  it('returns null for absent / corrupt / non-object values', () => {
    expect(parseAnalysis(null)).toBeNull()
    expect(parseAnalysis('')).toBeNull()
    expect(parseAnalysis('{ broken')).toBeNull()
    expect(parseAnalysis('"a string"')).toBeNull()
    expect(parseAnalysis('[1,2]')).toBeNull()  // an array is `typeof === "object"` in JS
  })
})

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

  it('#1003 — a time-based re-analysis preserves the first estimate in KV (the Pinecone flow)', async () => {
    // First analysis: "1–4h" (bound 4), written 10 min into the incident — seeded in the PRE-#1003
    // shape (no `firstEstimatedRecoveryHours`, no durable key), i.e. an incident already in flight at
    // deploy time. At the 4h mark it has outrun the estimate → recoveryExceeded → re-analysis, whose
    // prompt forces a bound >= elapsed, so the model returns ~15h. That overwrite is where the
    // original prediction used to die.
    const store: Record<string, string> = {
      [analysisKey('pinecone', 'inc-1')]: JSON.stringify({
        ...mockAnalysis,
        analyzedAt: '2026-07-13T03:47:00Z',
        estimatedRecovery: '1–4h',
        estimatedRecoveryHours: 4,
      }),
    }
    const kv = mockKV(store)
    const svc = mockService('pinecone', [{ id: 'inc-1', status: 'investigating', startedAt: '2026-07-13T03:37:00Z' }])
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({
      ...mockAnalysis, estimatedRecovery: '8–15h', estimatedRecoveryHours: 15,
    }))

    const now = new Date('2026-07-13T08:07:00Z').getTime() // 4h30m elapsed > the 4h bound
    const result = await refreshOrReanalyze([svc], kv, 'api-key', analyzeFn, 2, now)

    expect(result.reanalyzed).toEqual(['pinecone'])
    // The re-analysis DID get the previous-prediction context (that's what inflates the estimate)…
    expect(analyzeFn).toHaveBeenCalledWith(
      'api-key', 'Pinecone', expect.anything(), expect.anything(),
      expect.objectContaining({ estimatedRecoveryHours: 4 }), undefined, expect.anything(),
    )
    // …and the written value carries the inflated CURRENT estimate for live surfaces while keeping
    // the hindsight-free baseline that resolution will be scored against — now pinned durably, so a
    // later analysis-key lapse can't move it either.
    const written = parseAnalysis(store[analysisKey('pinecone', 'inc-1')])
    expect(written?.estimatedRecoveryHours).toBe(15)
    expect(written?.firstEstimatedRecoveryHours).toBe(4)
    expect(store[firstEstimateKey('pinecone', 'inc-1')]).toBe('4')
  })

  it('#1003 — a first analysis on an empty key records its own estimate as the baseline', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const svc = mockService('chatgpt', [{ id: 'inc-9', status: 'investigating' }])
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({
      ...mockAnalysis, incidentId: 'inc-9', estimatedRecovery: '2–3h', estimatedRecoveryHours: 3,
    }))

    await refreshOrReanalyze([svc], kv, 'api-key', analyzeFn, 2)

    expect(parseAnalysis(store[analysisKey('chatgpt', 'inc-9')])?.firstEstimatedRecoveryHours).toBe(3)
    expect(store[firstEstimateKey('chatgpt', 'inc-9')]).toBe('3')
  })

  it('#1003 — an analysis-key LAPSE (cap exhaustion) cannot move the baseline', async () => {
    // The 2h+ old analysis stopped being TTL-refreshed while the cap was exhausted, so its key expired.
    // The replacement analysis is made 6h into the incident — NOT a hindsight-free estimate. The durable
    // key is the only thing standing between that and a silently re-inflated baseline.
    const store: Record<string, string> = { [firstEstimateKey('pinecone', 'inc-1')]: '4' }
    const kv = mockKV(store)
    const svc = mockService('pinecone', [{ id: 'inc-1', status: 'investigating', startedAt: '2026-07-13T03:37:00Z' }])
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({
      ...mockAnalysis, estimatedRecovery: '8–15h', estimatedRecoveryHours: 15,
    }))

    await refreshOrReanalyze([svc], kv, 'api-key', analyzeFn, 2, new Date('2026-07-13T09:37:00Z').getTime())

    const written = parseAnalysis(store[analysisKey('pinecone', 'inc-1')])
    expect(written?.estimatedRecoveryHours).toBe(15)
    expect(written?.firstEstimatedRecoveryHours).toBe(4)
  })

  it('#1003 — the sibling-copy dedup path carries the baseline to the sibling service', async () => {
    // claude/claudeai share one incidentId: the second service copies the first's analysis verbatim.
    // A refactor that rebuilt the object field-by-field would silently drop the baseline for every
    // grouped incident, so pin it here.
    const analysis = { ...mockAnalysis, estimatedRecoveryHours: 15, firstEstimatedRecoveryHours: 4 }
    const store: Record<string, string> = { [analysisKey('claude', 'inc-1')]: JSON.stringify(analysis) }
    const kv = mockKV(store)
    const svcs = [
      mockService('claude', [{ id: 'inc-1', status: 'investigating' }]),
      mockService('claudeai', [{ id: 'inc-1', status: 'investigating' }]),
    ]
    const analyzeFn = vi.fn()

    // 40min after the analysis → TTL-refresh for claude, sibling-copy for claudeai (no model call).
    await refreshOrReanalyze(svcs, kv, 'api-key', analyzeFn, 2, new Date('2026-03-27T06:50:00Z').getTime())

    expect(analyzeFn).not.toHaveBeenCalled()
    expect(parseAnalysis(store[analysisKey('claudeai', 'inc-1')])?.firstEstimatedRecoveryHours).toBe(4)
  })

  it('re-analyzes when analysis is missing', async () => {
    const kv = mockKV()
    const svc = mockService('chatgpt', [{ id: 'inc-2', status: 'investigating' }])
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({ ...mockAnalysis, incidentId: 'inc-2' }))

    const result = await refreshOrReanalyze([svc], kv, 'api-key', analyzeFn, 2)

    expect(result.reanalyzed).toEqual(['chatgpt'])
    expect(analyzeFn).toHaveBeenCalledOnce()
    expect(kv.put).toHaveBeenCalledWith(
      analysisKey('chatgpt', 'inc-2'),
      expect.stringContaining('inc-2'),
      { expirationTtl: 3600 },
    )
  })

  it('#633 — skips a held incident (no analysis on a sub-10min flap blip)', async () => {
    // A flap-shaped incident held by the first-seen confirmation gate has no analysis key yet
    // and must NOT be analyzed this cycle — it would burn a Gemma/Sonnet call on a phantom.
    const kv = mockKV()
    const svc = mockService('modal', [{ id: 'flap-held', status: 'investigating' }])
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({ ...mockAnalysis, incidentId: 'flap-held' }))

    const result = await refreshOrReanalyze([svc], kv, 'api-key', analyzeFn, 2, Date.now(), undefined, new Set(['flap-held']))

    expect(analyzeFn).not.toHaveBeenCalled()
    expect(result.reanalyzed).toEqual([])
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('#633 — still analyzes a non-held active incident on the same cron cycle', async () => {
    const kv = mockKV()
    const svc = mockService('modal', [
      { id: 'flap-held', status: 'investigating' },
      { id: 'real-inc', status: 'investigating' },
    ])
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({ ...mockAnalysis, incidentId: 'real-inc' }))

    const result = await refreshOrReanalyze([svc], kv, 'api-key', analyzeFn, 2, Date.now(), undefined, new Set(['flap-held']))

    expect(analyzeFn).toHaveBeenCalledOnce()
    expect(result.reanalyzed).toEqual(['modal'])
  })

  it('respects cap — only re-analyzes up to cap services', async () => {
    const kv = mockKV()
    const services = [
      mockService('svc1', [{ id: 'i1', status: 'investigating' }]),
      mockService('svc2', [{ id: 'i2', status: 'investigating' }]),
      mockService('svc3', [{ id: 'i3', status: 'investigating' }]),
    ]
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt(mockAnalysis))

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

  it('sets a 30min cooldown key on a PERMANENT failure', async () => {
    const store: Record<string, string> = {}
    const ttls: Record<string, number | undefined> = {}
    const kv = mockKV(store, ttls)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockResolvedValue(failAttempt('permanent'))
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2)

    expect(result.skipped).toEqual(['claude'])
    expect(store['ai:reanalysis-skip:claude:inc-1']).toBe('1')
    expect(ttls['ai:reanalysis-skip:claude:inc-1']).toBe(1800)
    spy.mockRestore()
  })

  // #955 Part 4 — the regression this issue exists for. A transient upstream failure used to
  // write the SAME flat 30min lock as a retired model id, so the next six cron cycles skipped
  // the incident entirely. That lock outlived the #882 AI_HOLD_MS (~10min) window, which
  // guaranteed the Discord alert shipped without its AI section.
  it.each(['transient', 'aborted'] as const)('writes NO cooldown key on a %s failure', async (failure) => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockResolvedValue(failAttempt(failure))
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2)

    expect(result.skipped).toEqual(['claude'])
    expect(store['ai:reanalysis-skip:claude:inc-1']).toBeUndefined()
    spy.mockRestore()
  })

  it('sets a one-cycle cooldown key when analysis throws', async () => {
    const store: Record<string, string> = {}
    const ttls: Record<string, number | undefined> = {}
    const kv = mockKV(store, ttls)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockRejectedValue(new Error('API error'))
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2)

    expect(result.skipped).toEqual(['claude'])
    expect(store['ai:reanalysis-skip:claude:inc-1']).toBe('1')
    expect(ttls['ai:reanalysis-skip:claude:inc-1']).toBe(300)
    spy.mockRestore()
  })

  // A throw used to increment NEITHER `calls` NOR `failed` — `usage.calls++` sat after the
  // `await analyzeFn(...)` inside the try block, so thrown failures vanished from the ledger.
  it('books a thrown analysis into the ai:usage counters', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockRejectedValue(new Error('API error'))
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, Date.UTC(2026, 6, 9))

    const usage = JSON.parse(store['ai:usage:2026-07-09'])
    expect(usage.calls).toBe(1)
    expect(usage.failed).toBe(1)
    spy.mockRestore()
  })

  it('books an aborted analysis as timedOut, not failed', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockResolvedValue(failAttempt('aborted'))
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, Date.UTC(2026, 6, 9))

    const usage = JSON.parse(store['ai:usage:2026-07-09'])
    expect(usage.calls).toBe(1)
    expect(usage.failed).toBe(0)
    expect(usage.timedOut).toBe(1)
    expect(usage.sonnetAttempts).toBe(1)
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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt(mockAnalysis))

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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt(newAnalysis))

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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt(updatedAnalysis))

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
    const analyzeFn = vi.fn().mockResolvedValue(failAttempt('transient')) // re-analysis fails
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const now = new Date('2026-03-27T05:30:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).toHaveBeenCalledOnce()
    // Old analysis should be preserved, not deleted
    const stored = JSON.parse(store[analysisKey('claude', 'inc-1')])
    expect(stored.summary).toBe('Old analysis')
    expect(result.refreshed).toEqual(['claude'])
    spy.mockRestore()
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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt(mockAnalysis))

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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt(updatedAnalysis))

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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({ ...mockAnalysis, incidentId: 'inc-1' }))

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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({ ...mockAnalysis, incidentId: 'inc-1' }))

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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({ ...mockAnalysis, incidentId: 'inc-other' }))

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
      .mockResolvedValueOnce(okAttempt({ ...mockAnalysis, incidentId: 'el-inc-1', summary: 'TTS analysis' }))
      .mockResolvedValueOnce(okAttempt({ ...mockAnalysis, incidentId: 'el-inc-2', summary: 'Voice analysis' }))

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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({ ...mockAnalysis, incidentId: 'el-active' }))

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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({ ...mockAnalysis, incidentId: 'el-2' }))

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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt(mockAnalysis))

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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt(updatedAnalysis))

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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({ ...mockAnalysis, incidentId: 'inc-1' }))

    // 11h since incident start — 2.75× the 4h estimate
    const now = new Date('2026-03-27T13:00:00Z').getTime()
    await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    // elapsedHours should be incident age (11h), not analysis age (10h)
    expect(analyzeFn).toHaveBeenCalledWith(
      'key', expect.any(String), expect.any(Object), expect.any(Array),
      expect.objectContaining({ estimatedRecoveryHours: 4, elapsedHours: expect.closeTo(11, 0.1) }),
      undefined,
      expect.any(Array), // #827 — svcHistory (corpus) passed as the 7th arg (empty here)
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
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({ ...mockAnalysis, incidentId: 'inc-1' }))

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
    const { result } = await analyzeIncidentDetailed('key', 'Claude API', incident, [], undefined, mockAi as unknown as Ai)
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
      const { result } = await analyzeIncidentDetailed('key', 'Claude API', incident, [], undefined, mockAi as unknown as Ai)
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
      const { result } = await analyzeIncidentDetailed('key', 'Claude API', incident, [], undefined, mockAi as unknown as Ai)
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
      const { result } = await analyzeIncidentDetailed('key', 'Claude API', incident, [])
      expect(result!.model).toBe('sonnet')
    } finally { globalThis.fetch = originalFetch }
  })

  it('reports transient when Gemma fails and Sonnet 500s', async () => {
    const mockAi = { run: vi.fn().mockRejectedValue(new Error('err')) }
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, headers: { get: () => null }, text: () => Promise.resolve('') }) as unknown as typeof fetch
    try {
      const { result, failure, attempts } = await analyzeIncidentDetailed('key', 'Claude API', incident, [], undefined, mockAi as unknown as Ai)
      expect(result).toBeNull()
      // A 5xx must NOT earn the 30min lock — the next cron cycle should retry.
      expect(failure).toBe('transient')
      expect(attempts).toEqual({ gemma: 1, sonnet: 1 })
    } finally { globalThis.fetch = originalFetch }
  })

  // Guards the Sonnet-5 request shape all the way to the wire, not just at `anthropicRequestBody`:
  // 300 max_tokens (the pre-#955 value) risks truncating the JSON under Sonnet 5's new tokenizer,
  // and omitting `thinking` would spend that budget on adaptive thinking instead.
  it('sends SONNET_MAX_TOKENS and disabled thinking on the wire', async () => {
    const mockAi = { run: vi.fn().mockRejectedValue(new Error('err')) }
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ content: [{ type: 'text', text: '{"summary":"s","estimatedRecovery":"1h","affectedScope":[],"needsFallback":false}' }] }) })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      await analyzeIncidentDetailed('key', 'Claude API', incident, [], undefined, mockAi as unknown as Ai)
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(SONNET_MAX_TOKENS).toBe(600)
      expect(body.max_tokens).toBe(SONNET_MAX_TOKENS)
      expect(body.thinking).toEqual({ type: 'disabled' })
      expect(body.model).not.toMatch(/^claude-sonnet-4/)
    } finally { globalThis.fetch = originalFetch }
  })

  // #955 — a retired model id is permanent: retrying it burns the cron budget forever.
  it('reports permanent when Sonnet returns 404 (retired model id)', async () => {
    const mockAi = { run: vi.fn().mockRejectedValue(new Error('err')) }
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve('not_found_error') })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const { result, failure } = await analyzeIncidentDetailed('key', 'Claude API', incident, [], undefined, mockAi as unknown as Ai)
      expect(result).toBeNull()
      expect(failure).toBe('permanent')
      expect(fetchMock).toHaveBeenCalledOnce() // no retry
    } finally { globalThis.fetch = originalFetch }
  })

  // A Gemma-only deployment must not be frozen for 30min by a transient Gemma glitch.
  it('reports transient (not permanent) when Gemma fails and there is no API key', async () => {
    const mockAi = { run: vi.fn().mockRejectedValue(new Error('err')) }
    const { result, failure } = await analyzeIncidentDetailed(undefined, 'Claude API', incident, [], undefined, mockAi as unknown as Ai)
    expect(result).toBeNull()
    expect(failure).toBe('transient')
  })

  it('reports permanent when neither model is configured', async () => {
    const { result, failure } = await analyzeIncidentDetailed(undefined, 'Claude API', incident, [])
    expect(result).toBeNull()
    expect(failure).toBe('permanent')
  })

  // #955 — the caller's budget must short-circuit before a Gemma call is even issued.
  it('reports aborted without calling Gemma when the signal is pre-aborted', async () => {
    const mockAi = { run: vi.fn() }
    const ctrl = new AbortController()
    ctrl.abort()
    const { result, failure, attempts } = await analyzeIncidentDetailed('key', 'Claude API', incident, [], undefined, mockAi as unknown as Ai, [], ctrl.signal)
    expect(result).toBeNull()
    expect(failure).toBe('aborted')
    expect(attempts).toEqual({ gemma: 0, sonnet: 0 })
    expect(mockAi.run).not.toHaveBeenCalled()
  })

  it('skips Sonnet fallback when apiKey is empty', async () => {
    const mockAi = { run: vi.fn().mockRejectedValue(new Error('err')) }
    const { result } = await analyzeIncidentDetailed('', 'Claude API', incident, [], undefined, mockAi as unknown as Ai)
    expect(result).toBeNull()
  })
})

// #299 — sticky flag: manual operator overrides must survive the cron's
// Gemma-first re-analysis path. refreshOrReanalyze should only refresh TTL.
describe('refreshOrReanalyze — sticky analyses (#299)', () => {
  it('skips re-analysis when existing analysis has sticky=true (only refreshes TTL)', async () => {
    // 3h-old analysis would normally trigger the 2h age-based re-analysis branch.
    // sticky=true must short-circuit BEFORE that check.
    const stickyAnalysis = {
      ...mockAnalysis,
      analyzedAt: '2026-03-27T03:00:00Z',  // 3h old
      sticky: true,
      model: 'sonnet',
    }
    const store: Record<string, string> = {
      [analysisKey('claude', 'inc-1')]: JSON.stringify(stickyAnalysis),
    }
    const kv = mockKV(store)
    const svc = mockService('claude', [{
      id: 'inc-1', status: 'investigating',
      // New timeline entry that would normally trigger re-analysis.
      timeline: [{ stage: 'identified', text: 'Root cause: pool exhaustion', at: '2026-03-27T05:30:00Z' }],
    }])
    const analyzeFn = vi.fn()

    const now = new Date('2026-03-27T06:00:00Z').getTime()
    const result = await refreshOrReanalyze([svc], kv, 'api-key', analyzeFn, 2, now)

    expect(analyzeFn).not.toHaveBeenCalled()
    expect(result.refreshed).toEqual(['claude'])
    expect(result.reanalyzed).toEqual([])
    // Persisted payload still sticky + no overwrite of summary/model.
    const persisted = JSON.parse(store[analysisKey('claude', 'inc-1')])
    expect(persisted.sticky).toBe(true)
    expect(persisted.model).toBe('sonnet')
    expect(persisted.summary).toBe('Test analysis')
  })

  it('still updates _lastRefresh when sticky', async () => {
    // Even though we skip re-analysis, the 1h TTL needs refreshing so the key
    // doesn't expire mid-incident.
    const stickyAnalysis = { ...mockAnalysis, sticky: true }
    const store: Record<string, string> = {
      [analysisKey('chatgpt', 'inc-x')]: JSON.stringify(stickyAnalysis),
    }
    const kv = mockKV(store)
    const svc = mockService('chatgpt', [{ id: 'inc-x', status: 'investigating' }])

    await refreshOrReanalyze([svc], kv, 'key', vi.fn(), 2)

    const persisted = JSON.parse(store[analysisKey('chatgpt', 'inc-x')])
    expect(persisted._lastRefresh).toBeDefined()
    // Assert the KV.put was called with the 1h TTL so the key can't silently leak past resolution.
    expect(kv.put).toHaveBeenCalledWith(
      analysisKey('chatgpt', 'inc-x'),
      expect.stringContaining('sticky'),
      { expirationTtl: 3600 },
    )
  })

  it('non-sticky analyses follow the existing re-analysis path (regression guard)', async () => {
    // If someone accidentally inverts the sticky check, non-sticky would be
    // treated as sticky and never re-analyzed — this test catches that.
    const oldAnalysis = { ...mockAnalysis, analyzedAt: '2026-03-27T03:00:00Z' } // 3h old, no sticky
    const store: Record<string, string> = {
      [analysisKey('claude', 'inc-1')]: JSON.stringify(oldAnalysis),
    }
    const kv = mockKV(store)
    const svc = mockService('claude', [{
      id: 'inc-1', status: 'investigating',
      timeline: [{ stage: 'identified', text: 'Root cause identified', at: '2026-03-27T05:30:00Z' }],
    }])
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({ ...mockAnalysis, model: 'gemma' }))

    const now = new Date('2026-03-27T06:00:00Z').getTime()
    await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2, now)

    expect(analyzeFn).toHaveBeenCalledOnce()
  })

  it('corrupt sticky-analysis JSON falls through to normal re-analysis (does not lock incident)', async () => {
    // Defensive: if stored JSON is corrupt we already log+fallthrough in the
    // existing parse catch, but sticky adds a new branch BEFORE that — confirm
    // corruption still routes through the existing recovery path rather than
    // hanging on the sticky check.
    const store: Record<string, string> = {
      [analysisKey('claude', 'inc-1')]: '{corrupt',
    }
    const kv = mockKV(store)
    const svc = mockService('claude', [{ id: 'inc-1', status: 'investigating' }])
    const analyzeFn = vi.fn().mockResolvedValue(okAttempt({ ...mockAnalysis, model: 'gemma' }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await refreshOrReanalyze([svc], kv, 'key', analyzeFn, 2)

    // The corrupt JSON should trigger re-analysis (not early-return).
    expect(analyzeFn).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })
})

describe('formatAnalysisEmbedSection (#882)', () => {
  const DIV = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈'
  const base: AIAnalysisResult = {
    summary: 'OCR API degraded — new failure type.',
    estimatedRecovery: '5–15m',
    affectedScope: ['OCR API', 'Document Processing'],
    needsFallback: true,
    analyzedAt: new Date(1_700_000_000_000).toISOString(),
    incidentId: 'inc-1',
    model: 'gemma',
  }

  it('renders the 🤖 AI ANALYSIS section with summary, recovery, and scope', () => {
    const out = formatAnalysisEmbedSection(base, DIV)
    expect(out).toContain('🤖 **AI ANALYSIS** [Beta]')
    expect(out).toContain('OCR API degraded — new failure type.')
    expect(out).toContain('⏱ Est. recovery: 5–15m')
    expect(out).toContain('📡 Scope: OCR API, Document Processing')
    expect(out.startsWith(`\n${DIV}\n`)).toBe(true)
  })

  it('omits the Scope line when affectedScope is empty', () => {
    const out = formatAnalysisEmbedSection({ ...base, affectedScope: [] }, DIV)
    expect(out).not.toContain('📡 Scope:')
  })

  it('maps N/A recovery to the friendly phrase (shared formatRecoveryDisplay)', () => {
    const out = formatAnalysisEmbedSection({ ...base, estimatedRecovery: 'N/A' }, DIV)
    expect(out).toContain('⏱ Est. recovery: Exceeded typical pattern')
  })

  it('is byte-identical to the legacy inline template (KV path == inline-success path)', () => {
    const a = base
    const legacy = `\n${DIV}\n🤖 **AI ANALYSIS** [Beta]\n${a.summary}\n⏱ Est. recovery: ${formatRecoveryDisplay(a.estimatedRecovery)}${a.affectedScope.length > 0 ? `\n📡 Scope: ${a.affectedScope.join(', ')}` : ''}`
    expect(formatAnalysisEmbedSection(a, DIV)).toBe(legacy)
  })
})

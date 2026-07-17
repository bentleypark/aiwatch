// Tests for the monthly retrospective narrative generator (#426 / aiwatch-reports#4 Phase 3).

import { describe, it, expect, vi } from 'vitest'
import { ANTHROPIC_MODEL } from '../anthropic'
import {
  formatDurationLabel,
  selectIncidentCandidates,
  buildMonthlyNarrativePrompt,
  parseMonthlyNarrative,
  generateMonthlyNarrative,
} from '../monthly-narrative'
import type { MonthlyArchive, MonthlyIncidentEntry } from '../monthly-archive'

// ── Fixtures ─────────────────────────────────────────────────────────

function mkIncident(overrides: Partial<MonthlyIncidentEntry> = {}): MonthlyIncidentEntry {
  return {
    id: overrides.id ?? 'inc-1',
    title: overrides.title ?? 'Elevated error rates',
    startedAt: overrides.startedAt ?? '2026-05-04T10:00:00Z',
    resolvedAt: overrides.resolvedAt ?? '2026-05-04T11:00:00Z',
    durationMin: overrides.durationMin ?? 60,
    finalStatus: overrides.finalStatus ?? 'resolved',
  }
}

function mkArchive(overrides: Partial<MonthlyArchive> = {}): MonthlyArchive {
  return {
    period: '2026-05',
    generatedAt: '2026-06-01T00:00:00Z',
    daysCollected: 31,
    services: {},
    ...overrides,
  }
}

// ── formatDurationLabel ──────────────────────────────────────────────

describe('formatDurationLabel', () => {
  it('returns "ongoing" for unresolved incidents regardless of duration', () => {
    expect(formatDurationLabel(5000, 'investigating')).toBe('ongoing')
    expect(formatDurationLabel(0, 'monitoring')).toBe('ongoing')
  })

  it('returns "ongoing" for resolved-but-zero-duration (no usable duration data)', () => {
    expect(formatDurationLabel(0, 'resolved')).toBe('ongoing')
  })

  it('formats sub-hour durations as minutes', () => {
    expect(formatDurationLabel(45, 'resolved')).toBe('45m')
  })

  it('formats hour-scale durations as Hh Mm, dropping zero minutes', () => {
    expect(formatDurationLabel(134, 'resolved')).toBe('2h 14m')
    expect(formatDurationLabel(120, 'resolved')).toBe('2h')
  })

  it('collapses multi-day durations to whole days (retrospective scale)', () => {
    // 10 days exactly
    expect(formatDurationLabel(10 * 1440, 'resolved')).toBe('10 days')
    // 1 day exactly — singular
    expect(formatDurationLabel(1440, 'resolved')).toBe('1 day')
    // 2 days + 3h
    expect(formatDurationLabel(2 * 1440 + 180, 'resolved')).toBe('2d 3h')
  })
})

// ── selectIncidentCandidates ─────────────────────────────────────────

describe('selectIncidentCandidates', () => {
  it('flattens every service incidentList and tags it with the service name', () => {
    const archive = mkArchive({
      services: {
        gemini: { uptime: 99, score: 80, grade: 'good', incidents: 1, avgResolutionMin: 60, totalDowntimeMin: 60, longestIncidentMin: 60, avgLatencyMs: 200, officialUptime: 99, p95LatencyMs: 320, latencySpikes: 2, p50LatencyMs: null, cvCombined: null,
          incidentList: [mkIncident({ id: 'g1', title: 'Vertex slowness' })] },
        claude: { uptime: 98, score: 70, grade: 'fair', incidents: 1, avgResolutionMin: 30, totalDowntimeMin: 30, longestIncidentMin: 30, avgLatencyMs: 150, officialUptime: 98, p95LatencyMs: 240, latencySpikes: 1, p50LatencyMs: null, cvCombined: null,
          incidentList: [mkIncident({ id: 'c1', title: 'API errors' })] },
      },
    })
    const out = selectIncidentCandidates(archive, { gemini: 'Gemini API', claude: 'Claude API' })
    expect(out).toHaveLength(2)
    expect(out.map(c => c.serviceName).sort()).toEqual(['Claude API', 'Gemini API'])
  })

  it('falls back to the service id when no display name is supplied', () => {
    const archive = mkArchive({
      services: {
        gemini: { uptime: 99, score: 80, grade: 'good', incidents: 1, avgResolutionMin: 60, totalDowntimeMin: 60, longestIncidentMin: 60, avgLatencyMs: 200, officialUptime: 99, p95LatencyMs: 320, latencySpikes: 2, p50LatencyMs: null, cvCombined: null,
          incidentList: [mkIncident({ id: 'g1' })] },
      },
    })
    const out = selectIncidentCandidates(archive, {})
    expect(out[0].serviceName).toBe('gemini')
  })

  it('ranks unresolved incidents above resolved ones', () => {
    const archive = mkArchive({
      services: {
        a: { uptime: 99, score: 80, grade: 'good', incidents: 2, avgResolutionMin: 60, totalDowntimeMin: 600, longestIncidentMin: 600, avgLatencyMs: 200, officialUptime: 99, p95LatencyMs: 320, latencySpikes: 3, p50LatencyMs: null, cvCombined: null,
          incidentList: [
            mkIncident({ id: 'resolved-long', durationMin: 600, finalStatus: 'resolved' }),
            mkIncident({ id: 'open-short', durationMin: 10, finalStatus: 'investigating', resolvedAt: null }),
          ] },
      },
    })
    const out = selectIncidentCandidates(archive, {})
    // Unresolved floats to the top even though its duration is far shorter.
    expect(out[0].id).toBe('open-short')
    expect(out[1].id).toBe('resolved-long')
  })

  it('ranks resolved incidents by descending duration', () => {
    const archive = mkArchive({
      services: {
        a: { uptime: 99, score: 80, grade: 'good', incidents: 3, avgResolutionMin: 60, totalDowntimeMin: 900, longestIncidentMin: 500, avgLatencyMs: 200, officialUptime: 99, p95LatencyMs: 320, latencySpikes: 4, p50LatencyMs: null, cvCombined: null,
          incidentList: [
            mkIncident({ id: 'mid', durationMin: 200 }),
            mkIncident({ id: 'long', durationMin: 500 }),
            mkIncident({ id: 'short', durationMin: 30 }),
          ] },
      },
    })
    const out = selectIncidentCandidates(archive, {})
    expect(out.map(c => c.id)).toEqual(['long', 'mid', 'short'])
  })

  it('caps the candidate list at 14 entries', () => {
    const incidentList = Array.from({ length: 30 }, (_, i) =>
      mkIncident({ id: `i${i}`, durationMin: i * 10 }))
    const archive = mkArchive({
      services: {
        a: { uptime: 99, score: 80, grade: 'good', incidents: 30, avgResolutionMin: 60, totalDowntimeMin: 4350, longestIncidentMin: 290, avgLatencyMs: 200, officialUptime: 99, p95LatencyMs: 320, latencySpikes: 12, p50LatencyMs: null, cvCombined: null, incidentList },
      },
    })
    const out = selectIncidentCandidates(archive, {})
    expect(out).toHaveLength(14)
    // Highest-duration entry must survive the cap.
    expect(out[0].durationMin).toBe(290)
  })

  it('handles services with no incidentList (undefined) without crashing', () => {
    const archive = mkArchive({
      services: {
        a: { uptime: 100, score: 100, grade: 'excellent', incidents: 0, avgResolutionMin: null, totalDowntimeMin: null, longestIncidentMin: null, avgLatencyMs: 120, officialUptime: 100, p95LatencyMs: null, latencySpikes: null, p50LatencyMs: null, cvCombined: null },
      },
    })
    expect(selectIncidentCandidates(archive, {})).toEqual([])
  })
})

// ── buildMonthlyNarrativePrompt ──────────────────────────────────────

describe('buildMonthlyNarrativePrompt', () => {
  const archive = mkArchive({
    services: {
      gemini: { uptime: 96, score: 61, grade: 'fair', incidents: 3, avgResolutionMin: 240, totalDowntimeMin: 720, longestIncidentMin: 600, avgLatencyMs: 210, officialUptime: 96, p95LatencyMs: 340, latencySpikes: 5, p50LatencyMs: null, cvCombined: null,
        incidentList: [mkIncident({ id: 'g1', title: 'Vertex API key issue', durationMin: 600 })] },
      claude: { uptime: 99.9, score: 95, grade: 'excellent', incidents: 0, avgResolutionMin: null, totalDowntimeMin: null, longestIncidentMin: null, avgLatencyMs: 170, officialUptime: 99.9, p95LatencyMs: null, latencySpikes: null, p50LatencyMs: null, cvCombined: null },
    },
  })

  it('includes the period, day count, incident candidates and service summary', () => {
    const prompt = buildMonthlyNarrativePrompt(archive, { gemini: 'Gemini API', claude: 'Claude API' })
    expect(prompt).toContain('Month: 2026-05')
    expect(prompt).toContain('Days of data collected: 31')
    expect(prompt).toContain('INCIDENT CANDIDATES')
    expect(prompt).toContain('Vertex API key issue')
    expect(prompt).toContain('Gemini API')
    expect(prompt).toContain('PER-SERVICE SUMMARY')
    // Service summary surfaces score + incident count.
    expect(prompt).toContain('Claude API: score 95')
    expect(prompt).toContain('Gemini API: score 61')
  })

  it('shows a placeholder line when the month had zero incidents', () => {
    const calm = mkArchive({
      services: {
        claude: { uptime: 100, score: 100, grade: 'excellent', incidents: 0, avgResolutionMin: null, totalDowntimeMin: null, longestIncidentMin: null, avgLatencyMs: 170, officialUptime: 100, p95LatencyMs: null, latencySpikes: null, p50LatencyMs: null, cvCombined: null },
      },
    })
    const prompt = buildMonthlyNarrativePrompt(calm, { claude: 'Claude API' })
    expect(prompt).toContain('(no incidents recorded this month)')
  })
})

// ── parseMonthlyNarrative ────────────────────────────────────────────

describe('parseMonthlyNarrative', () => {
  const validJson = JSON.stringify({
    notableIncidents: [
      { service: 'Gemini API', title: 'Vertex API key issue', affected: 'Gemini API — EU', durationLabel: '10 days', narrative: 'A key-rotation bug degraded Vertex auth for 10 days.' },
    ],
    observations: ['Prefer Claude for latency-sensitive workloads this month.'],
  })

  it('parses a clean JSON response', () => {
    const out = parseMonthlyNarrative(validJson, 'gemma')
    expect(out).not.toBeNull()
    expect(out!.notableIncidents).toHaveLength(1)
    expect(out!.notableIncidents[0].service).toBe('Gemini API')
    expect(out!.observations).toHaveLength(1)
    expect(out!.model).toBe('gemma')
    expect(out!.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('extracts the JSON block when the model wraps it in prose / fences', () => {
    const wrapped = 'Here is the draft:\n```json\n' + validJson + '\n```\nHope this helps!'
    const out = parseMonthlyNarrative(wrapped, 'sonnet')
    expect(out).not.toBeNull()
    expect(out!.model).toBe('sonnet')
  })

  it('returns null when no JSON object is present', () => {
    expect(parseMonthlyNarrative('I could not complete this request.', 'gemma')).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    expect(parseMonthlyNarrative('{ notableIncidents: [ broken', 'gemma')).toBeNull()
  })

  it('skips incident rows missing service / title / narrative (load-bearing fields)', () => {
    const partial = JSON.stringify({
      notableIncidents: [
        { service: 'A', title: 'T', narrative: 'N' },           // valid
        { service: '', title: 'T', narrative: 'N' },            // empty service → skip
        { service: 'B', title: '', narrative: 'N' },            // empty title → skip
        { service: 'C', title: 'T' },                           // missing narrative → skip
      ],
      observations: [],
    })
    const out = parseMonthlyNarrative(partial, 'gemma')
    expect(out).not.toBeNull()
    expect(out!.notableIncidents).toHaveLength(1)
    expect(out!.notableIncidents[0].service).toBe('A')
  })

  it('defaults affected to service name and durationLabel to N/A when absent', () => {
    const partial = JSON.stringify({
      notableIncidents: [{ service: 'A', title: 'T', narrative: 'N' }],
      observations: [],
    })
    const out = parseMonthlyNarrative(partial, 'gemma')
    expect(out!.notableIncidents[0].affected).toBe('A')
    expect(out!.notableIncidents[0].durationLabel).toBe('N/A')
  })

  it('filters non-string / empty observations', () => {
    const noisy = JSON.stringify({
      notableIncidents: [{ service: 'A', title: 'T', narrative: 'N' }],
      observations: ['good bullet', '', '   ', 42, null, 'another bullet'],
    })
    const out = parseMonthlyNarrative(noisy, 'gemma')
    expect(out!.observations).toEqual(['good bullet', 'another bullet'])
  })

  it('returns null when the response has neither usable incidents nor observations', () => {
    const empty = JSON.stringify({ notableIncidents: [], observations: [] })
    expect(parseMonthlyNarrative(empty, 'gemma')).toBeNull()
  })

  it('returns a draft when only observations are present (incidents empty)', () => {
    const obsOnly = JSON.stringify({ notableIncidents: [], observations: ['Use X.'] })
    const out = parseMonthlyNarrative(obsOnly, 'gemma')
    expect(out).not.toBeNull()
    expect(out!.notableIncidents).toHaveLength(0)
    expect(out!.observations).toEqual(['Use X.'])
  })
})

// ── generateMonthlyNarrative — hybrid fallback + failure isolation ──

describe('generateMonthlyNarrative', () => {
  const archive = mkArchive({
    services: {
      gemini: { uptime: 96, score: 61, grade: 'fair', incidents: 1, avgResolutionMin: 600, totalDowntimeMin: 600, longestIncidentMin: 600, avgLatencyMs: 210, officialUptime: 96, p95LatencyMs: 340, latencySpikes: 5, p50LatencyMs: null, cvCombined: null,
        incidentList: [mkIncident({ id: 'g1', title: 'Vertex API key issue', durationMin: 600 })] },
    },
  })
  const goodJson = JSON.stringify({
    notableIncidents: [{ service: 'Gemini API', title: 'Vertex API key issue', narrative: 'Degraded auth for 10h.' }],
    observations: ['Prefer Claude this month.'],
  })

  it('returns the Gemma draft on the happy path (no Sonnet call)', async () => {
    let sonnetCalled = false
    const ai = { run: async () => ({ response: goodJson }) }
    // apiKey present but Sonnet must not be reached — we assert via sonnetCalled staying false.
    // generateMonthlyNarrative calls fetch() for Sonnet; intercept globally.
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { sonnetCalled = true; return new Response('{}') }) as typeof fetch
    try {
      const out = await generateMonthlyNarrative(archive, { ai, apiKey: 'k', serviceNames: { gemini: 'Gemini API' } })
      expect(out).not.toBeNull()
      expect(out!.model).toBe('gemma')
      expect(sonnetCalled).toBe(false)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('falls back to Sonnet when Gemma throws', async () => {
    const ai = { run: async () => { throw new Error('Workers AI unavailable') } }
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: goodJson }],
    }))) as typeof fetch
    try {
      const out = await generateMonthlyNarrative(archive, { ai, apiKey: 'k', serviceNames: { gemini: 'Gemini API' } })
      expect(out).not.toBeNull()
      expect(out!.model).toBe('sonnet')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  // #955 — this module used to hardcode `claude-sonnet-4-20250514` independently of ai-analysis.ts,
  // so when that id retired BOTH fallbacks died and neither could see the other's breakage. The id
  // now comes from the shared `anthropic.ts`; this pins that it actually reaches the wire.
  it('sends the shared non-retired model id and disabled thinking', async () => {
    const ai = { run: async () => { throw new Error('Workers AI unavailable') } }
    const origFetch = globalThis.fetch
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: goodJson }] })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      await generateMonthlyNarrative(archive, { ai, apiKey: 'k', serviceNames: { gemini: 'Gemini API' } })
      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
      expect(body.model).toBe(ANTHROPIC_MODEL)
      expect(body.model).not.toMatch(/^claude-sonnet-4/)
      expect(body.thinking).toEqual({ type: 'disabled' })
      expect(body.max_tokens).toBe(1800) // headroom for Sonnet 5's new tokenizer (was 1400)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('falls back to Sonnet when Gemma returns an unparseable response', async () => {
    const ai = { run: async () => ({ response: 'no json here at all' }) }
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: goodJson }],
    }))) as typeof fetch
    try {
      const out = await generateMonthlyNarrative(archive, { ai, apiKey: 'k', serviceNames: { gemini: 'Gemini API' } })
      expect(out!.model).toBe('sonnet')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('returns null when Gemma fails and no API key is configured', async () => {
    const ai = { run: async () => { throw new Error('boom') } }
    const out = await generateMonthlyNarrative(archive, { ai, serviceNames: {} })
    expect(out).toBeNull()
  })

  it('returns null (never throws) when both Gemma and Sonnet fail', async () => {
    const ai = { run: async () => { throw new Error('gemma down') } }
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('sonnet down') }) as typeof fetch
    try {
      const out = await generateMonthlyNarrative(archive, { ai, apiKey: 'k', serviceNames: {} })
      expect(out).toBeNull()
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('returns null when no AI binding and no API key are provided', async () => {
    const out = await generateMonthlyNarrative(archive, {})
    expect(out).toBeNull()
  })
})

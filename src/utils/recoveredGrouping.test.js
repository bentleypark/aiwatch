import { describe, it, expect } from 'vitest'
import { buildRecoveredRows, recoveredDetailText, recoveredDurationMin } from './recoveredGrouping'

// One Anthropic incident on three sibling surfaces — the #1045 duplicate-rows case.
const SIBLING_INC = { id: 'anthropic-1', startedAt: '2026-07-17T00:00:00Z', resolvedAt: '2026-07-17T01:07:00Z' }
const anthropicServices = [
  { id: 'claudeapi', name: 'Claude API', incidents: [SIBLING_INC] },
  { id: 'claudecode', name: 'Claude Code', incidents: [SIBLING_INC] },
  { id: 'claudeai', name: 'claude.ai', incidents: [SIBLING_INC] },
]
const anthropicRecovered = { claudeapi: ['anthropic-1'], claudecode: ['anthropic-1'], claudeai: ['anthropic-1'] }
const analysisFor = (incidentId) => ({
  incidentId,
  resolvedAt: '2026-07-17T01:07:00Z',
  firstEstimatedRecoveryHours: 4,
})

describe('recoveredDurationMin', () => {
  it('derives the duration from the incident alone — no analysis needed (#1045 bare-row fix)', () => {
    expect(recoveredDurationMin(SIBLING_INC, undefined)).toBe(67)
  })

  it("prefers the analysis resolvedAt over the incident's", () => {
    const inc = { startedAt: '2026-07-17T00:00:00Z', resolvedAt: '2026-07-17T02:00:00Z' }
    expect(recoveredDurationMin(inc, { resolvedAt: '2026-07-17T00:30:00Z' })).toBe(30)
  })

  it('is null without an incident, without a resolvedAt, or on out-of-order timestamps', () => {
    expect(recoveredDurationMin(undefined, analysisFor('x'))).toBeNull()
    expect(recoveredDurationMin({ startedAt: '2026-07-17T00:00:00Z' }, undefined)).toBeNull()
    expect(recoveredDurationMin({ startedAt: '2026-07-17T02:00:00Z', resolvedAt: '2026-07-17T00:00:00Z' }, undefined)).toBeNull()
  })
})

describe('buildRecoveredRows', () => {
  it('collapses sibling services sharing one incidentId into a single row', () => {
    const rows = buildRecoveredRows(anthropicRecovered, anthropicServices, { claudeapi: [analysisFor('anthropic-1')] })
    expect(rows).toHaveLength(1)
    expect(rows[0].incidentId).toBe('anthropic-1')
    expect(rows[0].services.map(s => s.name)).toEqual(['Claude API', 'Claude Code', 'claude.ai'])
    expect(rows[0].durationMin).toBe(67)
  })

  it('keeps distinct incidents on separate rows', () => {
    const services = [
      { id: 'turbopuffer', name: 'turbopuffer', incidents: [{ id: 'tp-1', startedAt: '2026-07-17T00:00:00Z', resolvedAt: '2026-07-17T01:07:00Z' }] },
      { id: 'cursor', name: 'Cursor', incidents: [{ id: 'cur-1', startedAt: '2026-07-17T00:00:00Z', resolvedAt: '2026-07-17T00:20:00Z' }] },
    ]
    const rows = buildRecoveredRows({ turbopuffer: ['tp-1'], cursor: ['cur-1'] }, services, {})
    expect(rows.map(r => r.incidentId)).toEqual(['tp-1', 'cur-1'])
  })

  // The IMG_7778 case: turbopuffer analyzed, Cursor not — both must still get a duration.
  it('gives an unanalyzed service a duration, and only the analyzed one an outcome', () => {
    const services = [
      { id: 'turbopuffer', name: 'turbopuffer', incidents: [{ id: 'tp-1', startedAt: '2026-07-17T00:00:00Z', resolvedAt: '2026-07-17T01:07:00Z' }] },
      { id: 'cursor', name: 'Cursor', incidents: [{ id: 'cur-1', startedAt: '2026-07-17T00:00:00Z', resolvedAt: '2026-07-17T01:07:00Z' }] },
    ]
    const rows = buildRecoveredRows(
      { turbopuffer: ['tp-1'], cursor: ['cur-1'] },
      services,
      { turbopuffer: [{ incidentId: 'tp-1', resolvedAt: '2026-07-17T01:07:00Z', firstEstimatedRecoveryHours: 3 }] },
    )
    const [tp, cursor] = rows
    expect(tp.durationMin).toBe(67)
    expect(tp.outcome).not.toBeNull()
    expect(cursor.durationMin).toBe(67)
    expect(cursor.outcome).toBeNull()
  })

  it('picks up an outcome from whichever sibling carries the analysis', () => {
    // Only claude.ai (last in display order) was analyzed — the grouped row still gets the outcome.
    const rows = buildRecoveredRows(anthropicRecovered, anthropicServices, { claudeai: [analysisFor('anthropic-1')] })
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome.verdict).toBe('over')
  })

  it('never pairs one incident with another incident\'s analysis (no analyses[0] fallback)', () => {
    const services = [{
      id: 'cursor',
      name: 'Cursor',
      incidents: [{ id: 'cur-2', startedAt: '2026-07-17T00:00:00Z', resolvedAt: '2026-07-17T00:20:00Z' }],
    }]
    // The service carries an analysis, but for a DIFFERENT (older) incident than the recovered marker.
    const rows = buildRecoveredRows({ cursor: ['cur-2'] }, services, { cursor: [analysisFor('cur-1-stale')] })
    expect(rows[0].outcome).toBeNull()
    expect(rows[0].durationMin).toBe(20)
  })

  it('sources the duration and the verdict from the SAME sibling', () => {
    // claudeapi has no analysis and a longer paperwork span; claudecode carries the analysis. The row
    // must not read claudeapi's duration beside claudecode's verdict — they'd grade different numbers.
    const services = [
      { id: 'claudeapi', name: 'Claude API', incidents: [{ id: 'anthropic-1', startedAt: '2026-07-17T00:00:00Z', resolvedAt: '2026-07-17T05:00:00Z' }] },
      { id: 'claudecode', name: 'Claude Code', incidents: [SIBLING_INC] },
    ]
    const rows = buildRecoveredRows(
      { claudeapi: ['anthropic-1'], claudecode: ['anthropic-1'] },
      services,
      { claudecode: [analysisFor('anthropic-1')] },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].durationMin).toBe(67)
    expect(rows[0].outcome.actualMin).toBe(67)
  })

  it('keeps a gradeable sibling\'s fragment regardless of display order', () => {
    // Claude API's analysis has no usable estimate; Claude Code's does. The row must grade off Claude
    // Code either way — otherwise the fragment would blink in and out with the service ordering.
    const ungradeable = { incidentId: 'anthropic-1', resolvedAt: '2026-07-17T01:07:00Z', estimatedRecovery: 'No historical data for estimation' }
    const analysisBySvc = { claudeapi: [ungradeable], claudecode: [analysisFor('anthropic-1')] }
    for (const order of [['claudeapi', 'claudecode'], ['claudecode', 'claudeapi']]) {
      const ordered = order.map(id => anthropicServices.find(s => s.id === id))
      const rows = buildRecoveredRows({ claudeapi: ['anthropic-1'], claudecode: ['anthropic-1'] }, ordered, analysisBySvc)
      expect(rows[0].outcome?.verdict, `order ${order.join(',')}`).toBe('over')
      expect(rows[0].durationMin, `order ${order.join(',')}`).toBe(67)
    }
  })

  it('reports hasAnalysis so the Analyze link gates on visible rows', () => {
    expect(buildRecoveredRows(anthropicRecovered, anthropicServices, { claudeai: [analysisFor('anthropic-1')] })[0].hasAnalysis).toBe(true)
    expect(buildRecoveredRows(anthropicRecovered, anthropicServices, {})[0].hasAnalysis).toBe(false)
    // An analysis for a service whose row was dropped must not light the link.
    expect(buildRecoveredRows({ ghost: ['x'] }, anthropicServices, { ghost: [analysisFor('x')] })).toEqual([])
  })

  it('drops services the payload does not carry, and tolerates empty input', () => {
    expect(buildRecoveredRows({ ghost: ['x'] }, anthropicServices, {})).toEqual([])
    expect(buildRecoveredRows({}, [], {})).toEqual([])
    expect(buildRecoveredRows(undefined, undefined, undefined)).toEqual([])
  })

  it('still yields a row when the incident aged out of the live feed', () => {
    const services = [{ id: 'cursor', name: 'Cursor', incidents: [] }]
    const rows = buildRecoveredRows({ cursor: ['cur-1'] }, services, {})
    expect(rows).toHaveLength(1)
    expect(rows[0].durationMin).toBeNull()
  })
})

describe('recoveredDetailText', () => {
  it('renders duration + prediction fragment when analyzed', () => {
    const [row] = buildRecoveredRows(anthropicRecovered, anthropicServices, { claudeapi: [analysisFor('anthropic-1')] })
    expect(recoveredDetailText(row, 'en')).toBe('recovered in 1h 7m (faster than ~4h est.)')
    expect(recoveredDetailText(row, 'ko')).toBe('1h 7m 만에 복구 (예측 ~4h보다 빨리)')
  })

  it('renders duration alone when there is no analysis — never a bare row', () => {
    expect(recoveredDetailText({ durationMin: 67, outcome: null }, 'en')).toBe('recovered in 1h 7m')
    expect(recoveredDetailText({ durationMin: 67, outcome: null }, 'ko')).toBe('1h 7m 만에 복구')
  })

  it('falls back to a bare verb when even the duration is unknown', () => {
    expect(recoveredDetailText({ durationMin: null, outcome: null }, 'en')).toBe('recovered')
    expect(recoveredDetailText({ durationMin: null, outcome: null }, 'ko')).toBe('복구됨')
  })
})

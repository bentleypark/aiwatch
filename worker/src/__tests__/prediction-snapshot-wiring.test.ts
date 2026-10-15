import { describe, it, expect, vi, afterEach } from 'vitest'
import { analyzeIncidentDetailed, putAnalysis, refreshOrReanalyze, parseAnalysis, analysisKey, type AIAnalysisResult, type AnalysisAttempt } from '../ai-analysis'
import { buildResolvedRecord, markIncidentResolved } from '../recovery-mark'
import { appendIncidentHistoryBatch, historyKey, readIncidentHistory, type IncidentHistoryRecord } from '../incident-history'
import { snapshotKey, ledgerKey, readPredictionSnapshots, type PredictionSnapshot } from '../prediction-snapshot'
import type { ServiceStatus } from '../types'
import type { KVLike } from '../utils'

function mockKV(store: Record<string, string> = {}) {
  const kv: KVLike = {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string) => { store[k] = v }),
    delete: vi.fn(async (k: string) => { delete store[k] }),
  }
  return { kv, store }
}

const INC = {
  id: 'inc-1', title: 'Elevated error rates on the API', status: 'investigating', impact: 'major' as const,
  startedAt: '2026-10-16T09:00:00.000Z',
  timeline: [{ stage: 'investigating', text: 'We are seeing elevated error rates.', at: '2026-10-16T09:05:00.000Z' }],
}
const gemma = () => ({ run: vi.fn().mockResolvedValue({ response: JSON.stringify({ summary: 'Elevated errors.', estimatedRecovery: '1–2h', affectedScope: ['API'], needsFallback: false }) }) })
const SVC = { id: 'claude', provider: 'Anthropic', category: 'api' as const }

function pastRecord(over: Partial<IncidentHistoryRecord> = {}): IncidentHistoryRecord {
  return {
    svcId: 'claude', incId: 'old-1', title: 'Elevated error rates on the API', provider: 'Anthropic', category: 'api', impact: 'major',
    startedAt: '2026-09-01T09:00:00.000Z', resolvedAt: '2026-09-01T10:00:00.000Z', durationMin: 60, ...over,
  }
}

const analysis = { summary: 's', estimatedRecovery: '1–2h', estimatedRecoveryHours: 2, affectedScope: ['API'], needsFallback: false, analyzedAt: '2026-10-16T09:10:00.000Z', incidentId: 'inc-1', model: 'gemma', timelineHash: '' } as AIAnalysisResult
const mkSnap = (at: string, estimateHours: number, historyMatches: number) => ({ at, elapsedMin: 10, stage: 'investigating', updates: 1, sinceLastUpdateMin: 5, impact: 'major', estimateHours, historyMatches }) as PredictionSnapshot

describe('analyzeIncidentDetailed — snapshot', () => {
  afterEach(() => { vi.useRealTimers() })

  it('returns the snapshot of what the prompt carried', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T09:10:00.000Z'))
    const attempt = await analyzeIncidentDetailed('key', 'Claude API', INC, [], undefined, gemma() as unknown as Ai, [pastRecord()])
    expect(attempt.snapshot).toMatchObject({
      stage: 'investigating', updates: 1, impact: 'major', model: 'gemma', historyMatches: 1, estimateHours: 2,
      scope: ['API'], firstUpdate: 'We are seeing elevated error rates.',
      elapsedMin: 10, sinceLastUpdateMin: 5, at: '2026-10-16T09:10:00.000Z',
    })
  })

  it('keeps the snapshot when Gemma fails and the Sonnet fallback makes the estimate', async () => {
    const failing = { run: vi.fn().mockRejectedValue(new Error('workers ai down')) }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({ summary: 's', estimatedRecovery: '2–3h', affectedScope: ['API'], needsFallback: false }) }] }),
    }))
    const attempt = await analyzeIncidentDetailed('key', 'Claude API', INC, [], undefined, failing as unknown as Ai, [pastRecord()])
    vi.unstubAllGlobals()
    expect(attempt.result!.model).toBe('sonnet')
    expect(attempt.snapshot).toMatchObject({ model: 'sonnet', historyMatches: 1, stage: 'investigating' })
  })

  it('records 0 matches when the corpus had nothing similar, and no snapshot when no estimate was made', async () => {
    const none = await analyzeIncidentDetailed('key', 'Claude API', INC, [], undefined, gemma() as unknown as Ai, [])
    expect(none.snapshot!.historyMatches).toBe(0)
    const failing = { run: vi.fn().mockRejectedValue(new Error('workers ai down')) }
    const failed = await analyzeIncidentDetailed(undefined, 'Claude API', INC, [], undefined, failing as unknown as Ai, [])
    expect(failed.result).toBeNull()
    expect(failed.snapshot).toBeUndefined()
  })
})

describe('putAnalysis — snapshot persistence', () => {
  it('appends a snapshot beside a fresh analysis; a write that passes null touches nothing', async () => {
    const { kv, store } = mockKV()
    const snap = mkSnap(analysis.analyzedAt, 2, 1)
    await putAnalysis(kv, 'claude', 'inc-1', analysis, null, 3600, snap)
    expect(JSON.parse(store[snapshotKey('claude', 'inc-1')])).toHaveLength(1)
    const before = store[snapshotKey('claude', 'inc-1')]
    await putAnalysis(kv, 'claude', 'inc-1', analysis, analysis, 3600, null)
    expect(store[snapshotKey('claude', 'inc-1')]).toBe(before)
  })

  it('keeps no snapshot for an analysis that failed to persist', async () => {
    const { kv, store } = mockKV()
    ;(kv.put as ReturnType<typeof vi.fn>).mockImplementation(async (k: string, v: string) => {
      if (k.startsWith('ai:analysis:')) throw new Error('kv down')
      store[k] = v
    })
    const written = await putAnalysis(kv, 'claude', 'inc-1', analysis, null, 3600, mkSnap(analysis.analyzedAt, 2, 1))
    expect(written.ok).toBe(false)
    expect(store[snapshotKey('claude', 'inc-1')]).toBeUndefined()
  })
})

describe('refreshOrReanalyze — both fresh-analysis writes keep their snapshot', () => {
  const NOW = Date.parse('2026-10-16T12:00:00.000Z')
  const svc = (id: string) => ({ id, name: id, status: 'degraded', incidents: [{ ...INC, startedAt: '2026-10-16T09:00:00.000Z', timeline: [...INC.timeline, { stage: 'identified', text: 'Identified.', at: '2026-10-16T11:30:00.000Z' }] }] }) as unknown as ServiceStatus
  const attemptFor = (hours: number, matches: number, at: string): AnalysisAttempt => ({
    result: { ...analysis, estimatedRecoveryHours: hours, analyzedAt: at },
    snapshot: mkSnap(at, hours, matches),
    failure: null,
    attempts: { gemma: 1, sonnet: 0 },
  })

  it('a re-analysis of an old analysis appends to that service\'s list', async () => {
    const { kv, store } = mockKV({ [analysisKey('claude', 'inc-1')]: JSON.stringify({ ...analysis, analyzedAt: '2026-10-16T09:10:00.000Z', timelineHash: '2026-10-16T09:05:00.000Z' }) })
    await refreshOrReanalyze([svc('claude')], kv, 'key', async () => attemptFor(4, 2, '2026-10-16T12:00:00.000Z'), 2, NOW)
    const list = JSON.parse(store[snapshotKey('claude', 'inc-1')]) as PredictionSnapshot[]
    expect(list.map(s => s.estimateHours)).toEqual([4])
  })

  it('a first analysis for an incident with none is kept, and surfaces analysing separately do not share a list', async () => {
    const { kv, store } = mockKV()
    let n = 0
    await refreshOrReanalyze([svc('claude'), svc('claudecode')], kv, 'key', async () => (n++ === 0 ? attemptFor(3, 3, '2026-10-16T12:00:00.000Z') : attemptFor(6, 0, '2026-10-16T12:01:00.000Z')), 2, NOW)
    const claude = store[snapshotKey('claude', 'inc-1')]
    expect(claude).toBeDefined()
    expect(store[snapshotKey('claudecode', 'inc-1')] ?? '[]').not.toBe(claude)
  })

  it('a TTL refresh with no new analysis writes no snapshot', async () => {
    const { kv, store } = mockKV({ [analysisKey('claude', 'inc-1')]: JSON.stringify({ ...analysis, analyzedAt: '2026-10-16T11:30:00.000Z', timelineHash: '2026-10-16T11:30:00.000Z' }) })
    const analyze = vi.fn()
    await refreshOrReanalyze([svc('claude')], kv, 'key', analyze as never, 2, NOW)
    expect(analyze).not.toHaveBeenCalled()
    expect(store[snapshotKey('claude', 'inc-1')]).toBeUndefined()
  })
})

describe('resolution — the record carries the snapshot its analysis was made from', () => {
  const resolved = { ...INC, status: 'resolved', resolvedAt: '2026-10-16T10:30:00.000Z' } as never
  const NOW = '2026-10-16T10:31:00.000Z'

  it('analysis → snapshot → resolved record → corpus and ledger', async () => {
    const { kv, store } = mockKV()
    const attempt = await analyzeIncidentDetailed('key', 'Claude API', INC, [], undefined, gemma() as unknown as Ai, [pastRecord()])
    await putAnalysis(kv, 'claude', 'inc-1', attempt.result!, null, 3600, attempt.snapshot ?? null)

    const done = await markIncidentResolved(kv, 'claude', resolved, NOW)
    const rec = await buildResolvedRecord(kv, SVC, resolved, done, NOW)
    expect(rec!.predictionSnapshots).toHaveLength(1)
    expect(rec!.predictionSnapshots![0]).toMatchObject({ historyMatches: 1, model: 'gemma' })

    expect(await appendIncidentHistoryBatch(kv, 'claude', [rec!])).toBe(true)
    expect((await readIncidentHistory(kv, 'claude'))[0].predictionSnapshots).toHaveLength(1)
    const ledger = JSON.parse(store[ledgerKey('2026-10', 'claude')])
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ incId: 'inc-1', svcId: 'claude', durationMin: 90 })
    expect(ledger[0].predictionSnapshots).toHaveLength(1)
    expect(parseAnalysis(store[analysisKey('claude', 'inc-1')])!.resolvedAt).toBe('2026-10-16T10:30:00.000Z')
  })

  it('two surfaces that analyse one incident separately each keep only their own snapshots', async () => {
    const { kv } = mockKV()
    await putAnalysis(kv, 'claude', 'inc-1', analysis, null, 3600, mkSnap('2026-10-16T09:10:00.000Z', 3, 3))
    await putAnalysis(kv, 'claudecode', 'inc-1', analysis, null, 3600, mkSnap('2026-10-16T09:12:00.000Z', 6, 0))
    const a = await buildResolvedRecord(kv, SVC, resolved, null, NOW)
    const b = await buildResolvedRecord(kv, { ...SVC, id: 'claudecode' }, resolved, null, NOW)
    expect(a!.predictionSnapshots!.map(s => s.estimateHours)).toEqual([3])
    expect(b!.predictionSnapshots!.map(s => s.estimateHours)).toEqual([6])
  })

  it('an incident analysed before this shipped still gets a record, just without snapshots', async () => {
    const { kv } = mockKV()
    const rec = await buildResolvedRecord(kv, SVC, resolved, null, NOW)
    expect(rec).not.toBeNull()
    expect(rec).not.toHaveProperty('predictionSnapshots')
    expect(await readPredictionSnapshots(kv, 'claude', 'inc-1')).toEqual([])
  })

  it('any append of resolved records also writes the ledger — a failed ledger write does not stop the corpus write', async () => {
    const { kv, store } = mockKV()
    ;(kv.put as ReturnType<typeof vi.fn>).mockImplementation(async (k: string, v: string) => {
      if (k.startsWith('incident:ledger:')) throw new Error('ledger kv down')
      store[k] = v
    })
    expect(await appendIncidentHistoryBatch(kv, 'claude', [pastRecord({ resolvedAt: '2026-10-16T10:00:00.000Z' })])).toBe(false)
    expect(JSON.parse(store[historyKey('claude')])).toHaveLength(1)
  })

  it('a failed corpus write is reported even when the ledger write succeeds', async () => {
    const { kv, store } = mockKV()
    ;(kv.put as ReturnType<typeof vi.fn>).mockImplementation(async (k: string, v: string) => {
      if (k.startsWith('incident:history:')) throw new Error('history kv down')
      store[k] = v
    })
    expect(await appendIncidentHistoryBatch(kv, 'claude', [pastRecord({ resolvedAt: '2026-10-16T10:00:00.000Z' })])).toBe(false)
    expect(JSON.parse(store[ledgerKey('2026-10', 'claude')])).toHaveLength(1)
  })

  it('a repeat of an already-recorded batch repairs a ledger that missed it', async () => {
    const { kv, store } = mockKV()
    const rec = pastRecord({ resolvedAt: '2026-10-16T10:00:00.000Z' })
    ;(kv.put as ReturnType<typeof vi.fn>).mockImplementationOnce(async (k: string, v: string) => { store[k] = v }).mockImplementationOnce(async () => { throw new Error('ledger blip') })
    await appendIncidentHistoryBatch(kv, 'claude', [rec])
    expect(store[ledgerKey('2026-10', 'claude')]).toBeUndefined()
    ;(kv.put as ReturnType<typeof vi.fn>).mockImplementation(async (k: string, v: string) => { store[k] = v })
    await appendIncidentHistoryBatch(kv, 'claude', [rec])
    expect(JSON.parse(store[ledgerKey('2026-10', 'claude')])).toHaveLength(1)
  })
})

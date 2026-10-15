import { describe, it, expect, vi } from 'vitest'
import {
  buildPredictionSnapshot, appendPredictionSnapshot, readPredictionSnapshots, appendLedger, summarizeSnapshotCoverage,
  snapshotKey, ledgerKey, SNAPSHOT_CAP, SNAPSHOT_TTL_S, FIRST_UPDATE_MAX, LEDGER_MAX_ENTRIES,
  type PredictionSnapshot,
} from '../prediction-snapshot'
import type { IncidentHistoryRecord } from '../incident-history'
import type { KVLike } from '../utils'

function mockKV(store: Record<string, string> = {}, ttls: Record<string, number | undefined> = {}) {
  const kv: KVLike = {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string, o?: { expirationTtl?: number }) => { store[k] = v; ttls[k] = o?.expirationTtl }),
    delete: vi.fn(async (k: string) => { delete store[k] }),
  }
  return { kv, store, ttls }
}

const NOW = Date.parse('2026-10-16T10:00:00.000Z')
const CTX = { now: NOW, historyMatches: 2 }
const INC = {
  status: 'investigating',
  startedAt: '2026-10-16T09:20:00.000Z',
  impact: 'major' as string | null,
  timeline: [
    { stage: 'investigating', text: 'We are investigating elevated errors.', at: '2026-10-16T09:25:00.000Z' },
    { stage: 'identified', text: 'The cause is identified.', at: '2026-10-16T09:50:00.000Z' },
  ],
}
const RESULT = { analyzedAt: '2026-10-16T10:00:00.000Z', model: 'gemma', estimatedRecoveryHours: 2, affectedScope: ['API'] }

describe('buildPredictionSnapshot', () => {
  it('captures what the estimate was made from', () => {
    expect(buildPredictionSnapshot(INC, RESULT, CTX)).toEqual({
      at: '2026-10-16T10:00:00.000Z',
      elapsedMin: 40,
      stage: 'investigating',
      updates: 2,
      sinceLastUpdateMin: 10,
      impact: 'major',
      scope: ['API'],
      model: 'gemma',
      estimateHours: 2,
      historyMatches: 2,
      firstUpdate: 'We are investigating elevated errors.',
    })
  })

  it('handles an incident with no updates yet', () => {
    const snap = buildPredictionSnapshot({ ...INC, timeline: [] }, RESULT, CTX)
    expect(snap.updates).toBe(0)
    expect(snap.sinceLastUpdateMin).toBeNull()
    expect(snap).not.toHaveProperty('firstUpdate')
  })

  it('reports no elapsed time for an unparseable or future start rather than inventing one', () => {
    expect(buildPredictionSnapshot({ ...INC, startedAt: 'not-a-date' }, RESULT, CTX).elapsedMin).toBeNull()
    expect(buildPredictionSnapshot({ ...INC, startedAt: '2026-10-16T11:00:00.000Z' }, RESULT, CTX).elapsedMin).toBeNull()
  })

  it('caps and flattens the first update, and skips updates with no text', () => {
    const long = 'x'.repeat(FIRST_UPDATE_MAX + 200)
    const snap = buildPredictionSnapshot({ ...INC, timeline: [{ stage: 'investigating', text: null, at: INC.startedAt }, { stage: 'investigating', text: `line one\n\n  line   two ${long}`, at: INC.startedAt }] }, RESULT, CTX)
    expect(snap.firstUpdate!.length).toBeLessThanOrEqual(FIRST_UPDATE_MAX)
    expect(snap.firstUpdate).toMatch(/^line one line two x/)
    expect(snap.firstUpdate).not.toContain('\n')
  })

  it('drops values outside the union instead of storing them', () => {
    const snap = buildPredictionSnapshot({ ...INC, impact: 'catastrophic' }, { ...RESULT, model: 'claude-9', estimatedRecoveryHours: undefined, affectedScope: [] }, { ...CTX, historyMatches: -3 })
    expect(snap.impact).toBeNull()
    expect(snap).not.toHaveProperty('model')
    expect(snap).not.toHaveProperty('scope')
    expect(snap.estimateHours).toBeNull()
    expect(snap.historyMatches).toBe(0)
  })

  it('keeps at most 8 components, each capped at 60 characters, and a stage capped at 20', () => {
    const scope = Array.from({ length: 12 }, (_, i) => `component-${i}`)
    expect(buildPredictionSnapshot(INC, { ...RESULT, affectedScope: scope }, CTX).scope).toEqual(scope.slice(0, 8))
    expect(buildPredictionSnapshot(INC, { ...RESULT, affectedScope: ['c'.repeat(100)] }, CTX).scope![0]).toHaveLength(60)
    expect(buildPredictionSnapshot({ ...INC, status: 's'.repeat(50) }, RESULT, CTX).stage).toHaveLength(20)
  })

  it('records 0 history matches when the prompt used the fallback list', () => {
    expect(buildPredictionSnapshot(INC, RESULT, { ...CTX, historyMatches: 0 }).historyMatches).toBe(0)
  })
})

const snap = (n: number, over: Partial<PredictionSnapshot> = {}): PredictionSnapshot => ({
  at: new Date(Date.UTC(2026, 9, 16, 10 + n)).toISOString(), elapsedMin: n * 120, stage: 'investigating', updates: n, sinceLastUpdateMin: 5, impact: 'major',
  estimateHours: 2, historyMatches: 1, ...over,
})

describe('appendPredictionSnapshot', () => {
  it('writes under the service and incident with the 30-day TTL', async () => {
    const { kv, store, ttls } = mockKV()
    expect(await appendPredictionSnapshot(kv, 'claude', 'inc-1', snap(0, { firstUpdate: 'first' }))).toBe(true)
    expect(JSON.parse(store[snapshotKey('claude', 'inc-1')])).toHaveLength(1)
    expect(ttls[snapshotKey('claude', 'inc-1')]).toBe(SNAPSHOT_TTL_S)
  })

  it('is idempotent on the analysis time', async () => {
    const { kv, store } = mockKV()
    await appendPredictionSnapshot(kv, 'claude', 'inc-1', snap(0))
    await appendPredictionSnapshot(kv, 'claude', 'inc-1', snap(0))
    expect(JSON.parse(store[snapshotKey('claude', 'inc-1')])).toHaveLength(1)
  })

  it('appends a second analysis instead of overwriting the first, and keeps the first update on one snapshot only', async () => {
    const { kv, store } = mockKV()
    await appendPredictionSnapshot(kv, 'claude', 'inc-1', snap(0, { firstUpdate: 'first text' }))
    await appendPredictionSnapshot(kv, 'claude', 'inc-1', snap(1, { firstUpdate: 'first text' }))
    const list = JSON.parse(store[snapshotKey('claude', 'inc-1')]) as PredictionSnapshot[]
    expect(list.map(s => s.updates)).toEqual([0, 1])
    expect(list.filter(s => s.firstUpdate)).toHaveLength(1)
    expect(list[0].firstUpdate).toBe('first text')
  })

  it('keeps the first update from a later snapshot when the first analysis had none', async () => {
    const { kv, store } = mockKV()
    await appendPredictionSnapshot(kv, 'claude', 'inc-1', snap(0))
    await appendPredictionSnapshot(kv, 'claude', 'inc-1', snap(1, { firstUpdate: 'arrived later' }))
    const list = JSON.parse(store[snapshotKey('claude', 'inc-1')]) as PredictionSnapshot[]
    expect(list[1].firstUpdate).toBe('arrived later')
  })

  it('holds the cap by keeping the first snapshot and the most recent ones', async () => {
    const { kv, store } = mockKV()
    for (let n = 0; n < 9; n++) await appendPredictionSnapshot(kv, 'claude', 'inc-1', snap(n))
    const list = JSON.parse(store[snapshotKey('claude', 'inc-1')]) as PredictionSnapshot[]
    expect(list).toHaveLength(SNAPSHOT_CAP)
    expect(list[0].updates).toBe(0)
    expect(list.slice(1).map(s => s.updates)).toEqual([4, 5, 6, 7, 8])
  })

  it('does not overwrite on a failed read, and starts fresh on a corrupt value', async () => {
    const failing = mockKV()
    ;(failing.kv.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('kv down'))
    expect(await appendPredictionSnapshot(failing.kv, 'claude', 'inc-1', snap(0))).toBe(false)
    expect(failing.kv.put).not.toHaveBeenCalled()
    const corrupt = mockKV({ [snapshotKey('claude', 'inc-1')]: '{not json' })
    expect(await appendPredictionSnapshot(corrupt.kv, 'claude', 'inc-1', snap(0))).toBe(true)
    expect(JSON.parse(corrupt.store[snapshotKey('claude', 'inc-1')])).toHaveLength(1)
  })
})

describe('readPredictionSnapshots', () => {
  it('returns [] for a missing, corrupt or failing read and drops entries without an analysis time', async () => {
    expect(await readPredictionSnapshots(mockKV().kv, 'claude', 'x')).toEqual([])
    expect(await readPredictionSnapshots(mockKV({ [snapshotKey('claude', 'x')]: 'nope' }).kv, 'claude', 'x')).toEqual([])
    const failing = mockKV()
    ;(failing.kv.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('down'))
    expect(await readPredictionSnapshots(failing.kv, 'claude', 'x')).toEqual([])
    const mixed = mockKV({ [snapshotKey('claude', 'x')]: JSON.stringify([snap(0), { nope: true }, null]) })
    expect(await readPredictionSnapshots(mixed.kv, 'claude', 'x')).toHaveLength(1)
  })
})

const rec = (over: Partial<IncidentHistoryRecord> = {}): IncidentHistoryRecord => ({
  svcId: 'claude', incId: 'inc-1', title: 'Elevated errors', provider: 'Anthropic', category: 'api', impact: 'major',
  startedAt: '2026-10-16T09:00:00.000Z', resolvedAt: '2026-10-16T10:00:00.000Z', durationMin: 60,
  predictedRecoveryHours: 2, predictedSummary: 'AI prose that the ledger does not keep', ...over,
})

describe('appendLedger', () => {
  const K = ledgerKey('2026-10', 'claude')

  it('writes one entry per incident under the service and the month of resolution, without the AI prose', async () => {
    const { kv, store, ttls } = mockKV()
    expect(await appendLedger(kv, 'claude', [rec({ predictionSnapshots: [snap(0)] })])).toBe(true)
    const list = JSON.parse(store[K])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ svcId: 'claude', incId: 'inc-1', durationMin: 60, predictionSnapshots: [expect.any(Object)] })
    expect(list[0]).not.toHaveProperty('predictedSummary')
    expect(ttls[K]).toBeUndefined()
  })

  it('files an incident under the month it RESOLVED in', async () => {
    const { kv, store } = mockKV()
    await appendLedger(kv, 'claude', [rec({ startedAt: '2026-09-30T23:00:00.000Z', resolvedAt: '2026-10-01T01:00:00.000Z' })])
    expect(store[K]).toBeDefined()
    expect(store[ledgerKey('2026-09', 'claude')]).toBeUndefined()
  })

  it('gives each service its own key, so services resolving in one cycle never write the same key', async () => {
    const { kv, store } = mockKV()
    await appendLedger(kv, 'claude', [rec()])
    await appendLedger(kv, 'claudeai', [rec({ svcId: 'claudeai' })])
    expect(Object.keys(store).sort()).toEqual([ledgerKey('2026-10', 'claude'), ledgerKey('2026-10', 'claudeai')])
  })

  it('ignores a record that belongs to another service', async () => {
    const { kv } = mockKV()
    expect(await appendLedger(kv, 'claude', [rec({ svcId: 'openai' })])).toBe(true)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('is idempotent by incident, and a repeat may fill in snapshots the first copy lacked', async () => {
    const { kv, store } = mockKV()
    await appendLedger(kv, 'claude', [rec()])
    ;(kv.put as ReturnType<typeof vi.fn>).mockClear()
    await appendLedger(kv, 'claude', [rec()])
    expect(kv.put).not.toHaveBeenCalled()
    await appendLedger(kv, 'claude', [rec({ predictionSnapshots: [snap(0)] })])
    const list = JSON.parse(store[K])
    expect(list).toHaveLength(1)
    expect(list[0].predictionSnapshots).toHaveLength(1)
  })

  it('does not treat a failed read as an empty ledger', async () => {
    const { kv, store } = mockKV({ [K]: JSON.stringify([{ incId: 'older' }]) })
    ;(kv.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('kv down'))
    expect(await appendLedger(kv, 'claude', [rec()])).toBe(false)
    expect(kv.put).not.toHaveBeenCalled()
    expect(JSON.parse(store[K])).toHaveLength(1)
  })

  it('starts fresh on a corrupt ledger, skips an unparseable resolution time, and stops at the entry cap', async () => {
    const corrupt = mockKV({ [K]: '{broken' })
    expect(await appendLedger(corrupt.kv, 'claude', [rec()])).toBe(true)
    expect(JSON.parse(corrupt.store[K])).toHaveLength(1)
    const bad = mockKV()
    expect(await appendLedger(bad.kv, 'claude', [rec({ resolvedAt: 'nope' })])).toBe(true)
    expect(bad.kv.put).not.toHaveBeenCalled()
    const full = Array.from({ length: LEDGER_MAX_ENTRIES }, (_, i) => ({ incId: `i${i}` }))
    const capped = mockKV({ [K]: JSON.stringify(full) })
    await appendLedger(capped.kv, 'claude', [rec({ incId: 'one-more' })])
    expect(JSON.parse(capped.store[K])).toHaveLength(LEDGER_MAX_ENTRIES)
  })
})

describe('summarizeSnapshotCoverage', () => {
  const day = (h: number) => `2026-10-16T${String(h).padStart(2, '0')}:00:00.000Z`
  const NOW_MS = Date.parse('2026-10-16T12:00:00.000Z')

  it('counts resolved forecasts of the last day and how many kept a snapshot, siblings once', () => {
    const records = [
      rec({ incId: 'a', resolvedAt: day(10), predictionSnapshots: [snap(0)] }),
      rec({ incId: 'a', svcId: 'claudeai', resolvedAt: day(10) }),
      rec({ incId: 'b', resolvedAt: day(11) }),
    ]
    expect(summarizeSnapshotCoverage(records, NOW_MS)).toEqual({ forecasts: 2, withSnapshot: 1 })
  })

  it('counts an incident as covered when a later sibling record carries the snapshot', () => {
    const records = [
      rec({ incId: 'a', resolvedAt: day(10) }),
      rec({ incId: 'a', svcId: 'claudeai', resolvedAt: day(10), predictionSnapshots: [snap(0)] }),
    ]
    expect(summarizeSnapshotCoverage(records, NOW_MS)).toEqual({ forecasts: 1, withSnapshot: 1 })
  })

  it('ignores records outside the window, in the future, or without a forecast', () => {
    const records = [
      rec({ incId: 'old', resolvedAt: '2026-10-14T10:00:00.000Z' }),
      rec({ incId: 'future', resolvedAt: '2026-10-17T10:00:00.000Z' }),
      rec({ incId: 'noforecast', resolvedAt: day(10), predictedRecoveryHours: undefined }),
    ]
    expect(summarizeSnapshotCoverage(records, NOW_MS)).toEqual({ forecasts: 0, withSnapshot: 0 })
  })
})

import { describe, it, expect, vi } from 'vitest'
import {
  appendIncidentHistory,
  appendIncidentHistoryBatch,
  buildHistoryRecord,
  readIncidentHistory,
  durationMinOf,
  accuracyOf,
  findSimilarHistory,
  formatDurationMin,
  predictedVsActualText,
  summarizeAccuracy,
  historyKey,
  HISTORY_CAP,
  type IncidentHistoryRecord,
} from '../incident-history'
import type { KVLike } from '../utils'

function makeKV(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
    _store: store,
  } as unknown as KVLike & { _store: Map<string, string>; get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }
}

const rec = (over: Partial<IncidentHistoryRecord> = {}): IncidentHistoryRecord => ({
  svcId: 'claude',
  incId: 'inc-1',
  title: 'Elevated errors on Claude API',
  provider: 'Anthropic',
  category: 'api',
  impact: 'major',
  startedAt: '2026-06-29T10:00:00.000Z',
  resolvedAt: '2026-06-29T10:30:00.000Z',
  durationMin: 30,
  ...over,
})

describe('durationMinOf', () => {
  it('computes whole minutes between start and resolve', () => {
    expect(durationMinOf('2026-06-29T10:00:00Z', '2026-06-29T10:30:00Z')).toBe(30)
    expect(durationMinOf('2026-06-29T10:00:00Z', '2026-06-29T11:45:00Z')).toBe(105)
  })
  it('rounds to nearest minute', () => {
    expect(durationMinOf('2026-06-29T10:00:00Z', '2026-06-29T10:00:40Z')).toBe(1)
  })
  it('returns 0 for out-of-order or malformed timestamps (never negative)', () => {
    expect(durationMinOf('2026-06-29T11:00:00Z', '2026-06-29T10:00:00Z')).toBe(0)
    expect(durationMinOf('nonsense', '2026-06-29T10:00:00Z')).toBe(0)
    expect(durationMinOf('2026-06-29T10:00:00Z', 'nonsense')).toBe(0)
  })
})

describe('accuracyOf', () => {
  it('returns unknown when no prediction stored', () => {
    expect(accuracyOf({ durationMin: 30 })).toBe('unknown')
    expect(accuracyOf({ predictedRecoveryHours: 0, durationMin: 30 })).toBe('unknown')
  })
  it('accurate when actual lands within [0.5x, 1x] of the predicted upper bound', () => {
    // predicted 1h; actual 45m → within band
    expect(accuracyOf({ predictedRecoveryHours: 1, durationMin: 45 })).toBe('accurate')
    // predicted 2h; actual exactly 2h → at bound, accurate
    expect(accuracyOf({ predictedRecoveryHours: 2, durationMin: 120 })).toBe('accurate')
  })
  it('under-predicted when actual exceeds the predicted upper bound (too optimistic)', () => {
    expect(accuracyOf({ predictedRecoveryHours: 1, durationMin: 200 })).toBe('under-predicted')
  })
  it('over-predicted when actual is far below the predicted bound (too pessimistic)', () => {
    // predicted 3h; actual 30m (<0.5×) → over-predicted
    expect(accuracyOf({ predictedRecoveryHours: 3, durationMin: 30 })).toBe('over-predicted')
  })
  it('boundary: actual exactly 0.5× the bound is accurate, just under is over-predicted', () => {
    // predicted 2h; actual exactly 60m (= 0.5×) → NOT < 0.5× → accurate
    expect(accuracyOf({ predictedRecoveryHours: 2, durationMin: 60 })).toBe('accurate')
    // predicted 2h; actual 59m (< 0.5×) → over-predicted
    expect(accuracyOf({ predictedRecoveryHours: 2, durationMin: 59 })).toBe('over-predicted')
  })
})

describe('buildHistoryRecord', () => {
  const svc = { id: 'claude', provider: 'Anthropic', category: 'api' as const }
  const baseInc = { id: 'inc-1', title: 'Elevated errors', impact: 'major' as const, status: 'resolved', startedAt: '2026-06-29T10:00:00.000Z', resolvedAt: '2026-06-29T10:40:00.000Z' }
  const NOW = '2026-06-29T11:00:00.000Z'

  it('builds a record for a resolved incident, measuring duration to inc.resolvedAt (not now)', () => {
    const rec = buildHistoryRecord(svc, baseInc, null, NOW)!
    expect(rec).not.toBeNull()
    expect(rec.resolvedAt).toBe('2026-06-29T10:40:00.000Z') // inc.resolvedAt, NOT now
    expect(rec.durationMin).toBe(40)
    expect(rec.svcId).toBe('claude')
    expect(rec.provider).toBe('Anthropic')
  })

  it('records a monitoring incident too (service already operational, may get no later edge), using now', () => {
    const rec = buildHistoryRecord(svc, { ...baseInc, status: 'monitoring', resolvedAt: null }, null, NOW)!
    expect(rec).not.toBeNull()
    expect(rec.resolvedAt).toBe(NOW) // no resolvedAt yet → falls back to now
    expect(rec.durationMin).toBe(60)
  })

  it('skips still-diagnosing incidents (investigating/identified) at a recovery edge', () => {
    expect(buildHistoryRecord(svc, { ...baseInc, status: 'investigating' }, null, NOW)).toBeNull()
    expect(buildHistoryRecord(svc, { ...baseInc, status: 'identified' }, null, NOW)).toBeNull()
  })

  it('skips when startedAt is missing (cannot measure duration)', () => {
    expect(buildHistoryRecord(svc, { ...baseInc, startedAt: undefined }, null, NOW)).toBeNull()
  })

  it('joins prediction fields from the analysis and round-trips affectedScope', () => {
    const analysis = { estimatedRecoveryHours: 1, summary: 'Network errors', affectedScope: ['Messages API', 'Streaming'], model: 'gemma' }
    const rec = buildHistoryRecord(svc, baseInc, analysis, NOW)!
    expect(rec.predictedRecoveryHours).toBe(1)
    expect(rec.predictedSummary).toBe('Network errors')
    expect(rec.affectedScope).toEqual(['Messages API', 'Streaming'])
    expect(rec.model).toBe('gemma')
  })

  it('omits predicted fields when no analysis (actual-only record)', () => {
    const rec = buildHistoryRecord(svc, baseInc, null, NOW)!
    expect(rec.predictedRecoveryHours).toBeUndefined()
    expect(rec.predictedSummary).toBeUndefined()
    expect(rec.affectedScope).toBeUndefined()
    expect(rec.model).toBeUndefined()
  })

  it('normalizes an off-union model value to omitted (defensive)', () => {
    const rec = buildHistoryRecord(svc, baseInc, { model: 'claude-sonnet-4-20250514' }, NOW)!
    expect(rec.model).toBeUndefined()
  })

  it('length-caps title and summary so the stored value stays bounded', () => {
    const longTitle = 'x'.repeat(500)
    const longSummary = 'y'.repeat(900)
    const rec = buildHistoryRecord(svc, { ...baseInc, title: longTitle }, { summary: longSummary }, NOW)!
    expect(rec.title.length).toBe(200)
    expect(rec.predictedSummary!.length).toBe(500)
  })
})

describe('appendIncidentHistoryBatch', () => {
  it('writes multiple records for one service in a SINGLE put (no lost-update race)', async () => {
    const kv = makeKV()
    const ok = await appendIncidentHistoryBatch(kv, 'claude', [
      rec({ incId: 'a' }), rec({ incId: 'b' }), rec({ incId: 'c' }),
    ])
    expect(ok).toBe(true)
    expect(kv.put).toHaveBeenCalledTimes(1) // batched — not one put per record
    const stored = JSON.parse(kv._store.get('incident:history:claude')!) as IncidentHistoryRecord[]
    expect(stored.map(r => r.incId)).toEqual(['a', 'b', 'c'])
  })

  it('dedups within the batch and against existing records', async () => {
    const kv = makeKV()
    await appendIncidentHistoryBatch(kv, 'claude', [rec({ incId: 'a' })])
    await appendIncidentHistoryBatch(kv, 'claude', [rec({ incId: 'a' }), rec({ incId: 'a' }), rec({ incId: 'b' })])
    const stored = JSON.parse(kv._store.get('incident:history:claude')!) as IncidentHistoryRecord[]
    expect(stored.map(r => r.incId)).toEqual(['a', 'b'])
  })

  it('ignores records whose svcId does not match the batch service', async () => {
    const kv = makeKV()
    await appendIncidentHistoryBatch(kv, 'claude', [rec({ incId: 'a' }), rec({ svcId: 'openai', incId: 'x' })])
    const stored = JSON.parse(kv._store.get('incident:history:claude')!) as IncidentHistoryRecord[]
    expect(stored.map(r => r.incId)).toEqual(['a'])
  })

  it('is a no-op (no put) for an empty batch or all-duplicate batch', async () => {
    const kv = makeKV()
    expect(await appendIncidentHistoryBatch(kv, 'claude', [])).toBe(true)
    expect(kv.put).not.toHaveBeenCalled()
    await appendIncidentHistoryBatch(kv, 'claude', [rec({ incId: 'a' })])
    kv.put.mockClear()
    await appendIncidentHistoryBatch(kv, 'claude', [rec({ incId: 'a' })]) // all dup
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('caps a large batch to the most-recent HISTORY_CAP', async () => {
    const kv = makeKV()
    const many = Array.from({ length: HISTORY_CAP + 10 }, (_, i) => rec({ incId: `inc-${i}` }))
    await appendIncidentHistoryBatch(kv, 'claude', many)
    const stored = JSON.parse(kv._store.get('incident:history:claude')!) as IncidentHistoryRecord[]
    expect(stored).toHaveLength(HISTORY_CAP)
    expect(stored[stored.length - 1].incId).toBe(`inc-${HISTORY_CAP + 9}`)
  })

  it('a transient READ throw bails (returns false, no put) — never overwrites the durable corpus', async () => {
    const kv = makeKV()
    await appendIncidentHistoryBatch(kv, 'claude', [rec({ incId: 'a' }), rec({ incId: 'b' })]) // seed 2
    const before = kv._store.get('incident:history:claude')
    kv.get.mockRejectedValueOnce(new Error('KV read hiccup'))
    kv.put.mockClear()
    const ok = await appendIncidentHistoryBatch(kv, 'claude', [rec({ incId: 'c' })])
    expect(ok).toBe(false)
    expect(kv.put).not.toHaveBeenCalled()                 // did NOT overwrite
    expect(kv._store.get('incident:history:claude')).toBe(before) // prior corpus intact
  })
})

describe('appendIncidentHistory', () => {
  it('writes a new rolling list under incident:history:{svcId} with NO ttl (durable)', async () => {
    const kv = makeKV()
    const ok = await appendIncidentHistory(kv, rec())
    expect(ok).toBe(true)
    // No TTL option passed → durable
    expect(kv.put).toHaveBeenCalledWith(historyKey('claude'), expect.any(String), undefined)
    const stored = JSON.parse(kv._store.get('incident:history:claude')!)
    expect(stored).toHaveLength(1)
    expect(stored[0].incId).toBe('inc-1')
  })

  it('appends to an existing list (newest last)', async () => {
    const kv = makeKV()
    await appendIncidentHistory(kv, rec({ incId: 'inc-1' }))
    await appendIncidentHistory(kv, rec({ incId: 'inc-2' }))
    const stored = JSON.parse(kv._store.get('incident:history:claude')!) as IncidentHistoryRecord[]
    expect(stored.map(r => r.incId)).toEqual(['inc-1', 'inc-2'])
  })

  it('is idempotent — a repeated recovery cycle never double-records the same incId', async () => {
    const kv = makeKV()
    await appendIncidentHistory(kv, rec({ incId: 'inc-1' }))
    const ok = await appendIncidentHistory(kv, rec({ incId: 'inc-1', title: 'changed' }))
    expect(ok).toBe(true)
    const stored = JSON.parse(kv._store.get('incident:history:claude')!) as IncidentHistoryRecord[]
    expect(stored).toHaveLength(1)
    expect(stored[0].title).toBe('Elevated errors on Claude API') // first write wins
  })

  it('caps the list to the most-recent HISTORY_CAP records', async () => {
    const kv = makeKV()
    for (let i = 0; i < HISTORY_CAP + 5; i++) {
      await appendIncidentHistory(kv, rec({ incId: `inc-${i}` }))
    }
    const stored = JSON.parse(kv._store.get('incident:history:claude')!) as IncidentHistoryRecord[]
    expect(stored).toHaveLength(HISTORY_CAP)
    // oldest 5 dropped → first kept is inc-5, last is the newest
    expect(stored[0].incId).toBe('inc-5')
    expect(stored[stored.length - 1].incId).toBe(`inc-${HISTORY_CAP + 4}`)
  })

  it('starts fresh on a corrupt existing value rather than losing the write', async () => {
    const kv = makeKV({ 'incident:history:claude': 'not json{' })
    const ok = await appendIncidentHistory(kv, rec({ incId: 'inc-1' }))
    expect(ok).toBe(true)
    const stored = JSON.parse(kv._store.get('incident:history:claude')!) as IncidentHistoryRecord[]
    expect(stored).toHaveLength(1)
  })

  it('best-effort — returns false (does not throw) when KV.put fails', async () => {
    const kv = makeKV()
    kv.put.mockRejectedValueOnce(new Error('KV down'))
    const ok = await appendIncidentHistory(kv, rec())
    expect(ok).toBe(false)
  })

  it('preserves predicted fields when present and omits them when absent', async () => {
    const kv = makeKV()
    await appendIncidentHistory(kv, rec({ incId: 'with', predictedRecoveryHours: 2, predictedSummary: 'x', model: 'gemma' }))
    await appendIncidentHistory(kv, rec({ incId: 'without' }))
    const stored = JSON.parse(kv._store.get('incident:history:claude')!) as IncidentHistoryRecord[]
    const withRec = stored.find(r => r.incId === 'with')!
    const withoutRec = stored.find(r => r.incId === 'without')!
    expect(withRec.predictedRecoveryHours).toBe(2)
    expect(withRec.model).toBe('gemma')
    expect(withoutRec.predictedRecoveryHours).toBeUndefined()
    expect(withoutRec.predictedSummary).toBeUndefined()
  })
})

describe('formatDurationMin', () => {
  it('formats minutes / hours / mixed', () => {
    expect(formatDurationMin(45)).toBe('45m')
    expect(formatDurationMin(60)).toBe('1h')
    expect(formatDurationMin(190)).toBe('3h 10m')
  })
  it('guards non-positive / non-finite', () => {
    expect(formatDurationMin(0)).toBe('0m')
    expect(formatDurationMin(-5)).toBe('0m')
    expect(formatDurationMin(NaN)).toBe('0m')
  })
})

describe('findSimilarHistory', () => {
  const recs: IncidentHistoryRecord[] = [
    rec({ incId: 'a', title: 'Elevated errors on the Messages API', category: 'api', resolvedAt: '2026-06-01T00:00:00Z' }),
    rec({ incId: 'b', title: 'Streaming latency degradation', category: 'api', resolvedAt: '2026-06-02T00:00:00Z' }),
    rec({ incId: 'c', title: 'Console login issue', category: 'api', resolvedAt: '2026-06-03T00:00:00Z' }),
  ]

  it('ranks by title-token overlap', () => {
    const out = findSimilarHistory({ title: 'Elevated errors on Messages API requests' }, recs)
    expect(out[0].incId).toBe('a') // shares "elevated"/"errors"/"messages"
  })

  it('returns [] when no token overlaps any candidate', () => {
    expect(findSimilarHistory({ title: 'zzzz qqqq' }, recs)).toEqual([])
  })

  it('excludes the current incident by id (never grounds on itself)', () => {
    const out = findSimilarHistory({ title: 'Elevated errors Messages' }, recs, 3, 'a')
    expect(out.find(r => r.incId === 'a')).toBeUndefined()
  })

  it('respects the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => rec({ incId: `m${i}`, title: 'Streaming latency spike' }))
    expect(findSimilarHistory({ title: 'Streaming latency' }, many, 2)).toHaveLength(2)
  })

  it('returns [] for a title with no usable tokens', () => {
    expect(findSimilarHistory({ title: 'a b c' }, recs)).toEqual([])
  })

  it('breaks ties by most-recent resolvedAt', () => {
    const tie = [
      rec({ incId: 'old', title: 'Streaming latency', resolvedAt: '2026-05-01T00:00:00Z' }),
      rec({ incId: 'new', title: 'Streaming latency', resolvedAt: '2026-06-30T00:00:00Z' }),
    ]
    expect(findSimilarHistory({ title: 'Streaming latency' }, tie, 1)[0].incId).toBe('new')
  })

  it('matches morphological variants via substring (current "error" → past "errors")', () => {
    const out = findSimilarHistory({ title: 'API error spike' }, [rec({ incId: 'e', title: 'Elevated errors on the API' })])
    expect(out.map(r => r.incId)).toContain('e') // "error" ⊂ "errors", "api"... ("api" is len-3, filtered; "error" carries it)
  })

  it('same-category bonus is a tiebreak ONLY — never surfaces a zero-title-overlap record', () => {
    const recs2 = [
      rec({ incId: 'noOverlap', title: 'Totally unrelated wording', category: 'api' }),
      rec({ incId: 'overlap', title: 'Streaming latency degradation', category: 'app' }),
    ]
    const out = findSimilarHistory({ title: 'Streaming latency', category: 'api' }, recs2)
    expect(out.map(r => r.incId)).toEqual(['overlap'])      // category-only match excluded
  })

  it('same-category bonus ranks an overlapping same-category record above a same-overlap other-category one', () => {
    const recs2 = [
      rec({ incId: 'sameCat', title: 'Streaming latency', category: 'api', resolvedAt: '2026-06-01T00:00:00Z' }),
      rec({ incId: 'otherCat', title: 'Streaming latency', category: 'app', resolvedAt: '2026-06-01T00:00:00Z' }),
    ]
    expect(findSimilarHistory({ title: 'Streaming latency', category: 'api' }, recs2, 1)[0].incId).toBe('sameCat')
  })
})

describe('predictedVsActualText (alert/feed phrase, mirrors SPA wording)', () => {
  it('accurate → "within", under → "over", over → "faster than"', () => {
    expect(predictedVsActualText({ predictedRecoveryHours: 1, durationMin: 42 })).toBe('42m (within ~1h est.)')
    expect(predictedVsActualText({ predictedRecoveryHours: 1, durationMin: 190 })).toBe('3h 10m (over ~1h est.)')
    expect(predictedVsActualText({ predictedRecoveryHours: 3, durationMin: 20 })).toBe('20m (faster than ~3h est.)')
  })
  it('formats a fractional prediction compactly', () => {
    expect(predictedVsActualText({ predictedRecoveryHours: 0.75, durationMin: 30 })).toBe('30m (within ~45m est.)')
  })
  it('returns null when no prediction to compare', () => {
    expect(predictedVsActualText({ durationMin: 42 })).toBeNull()
    expect(predictedVsActualText({ predictedRecoveryHours: 0, durationMin: 42 })).toBeNull()
  })
})

describe('summarizeAccuracy', () => {
  it('ignores records without a prediction (denominator = predicted records only)', () => {
    const recs = [
      rec({ incId: 'p', predictedRecoveryHours: 1, durationMin: 50 }), // accurate
      rec({ incId: 'np1' }),                                            // no prediction
      rec({ incId: 'np2', predictedRecoveryHours: 0, durationMin: 30 }),// 0 prediction → ignored
    ]
    const s = summarizeAccuracy(recs)
    expect(s.total).toBe(1)
    expect(s.accurate).toBe(1)
    expect(s.hitRate).toBe(1)
  })

  it('counts accurate / under / over and computes hit-rate', () => {
    const recs = [
      rec({ incId: 'a', predictedRecoveryHours: 1, durationMin: 50 }),   // accurate (within band)
      rec({ incId: 'b', predictedRecoveryHours: 1, durationMin: 200 }),  // under-predicted
      rec({ incId: 'c', predictedRecoveryHours: 3, durationMin: 20 }),   // over-predicted
      rec({ incId: 'd', predictedRecoveryHours: 2, durationMin: 120 }),  // accurate (at bound)
    ]
    const s = summarizeAccuracy(recs)
    expect(s.total).toBe(4)
    expect(s.accurate).toBe(2)
    expect(s.underPredicted).toBe(1)
    expect(s.overPredicted).toBe(1)
    expect(s.hitRate).toBe(0.5)
  })

  it('computes median absolute error in hours', () => {
    const recs = [
      rec({ incId: 'a', predictedRecoveryHours: 1, durationMin: 90 }),  // |1.5-1| = 0.5
      rec({ incId: 'b', predictedRecoveryHours: 2, durationMin: 120 }), // |2-2| = 0
      rec({ incId: 'c', predictedRecoveryHours: 1, durationMin: 180 }), // |3-1| = 2
    ]
    expect(summarizeAccuracy(recs).medianAbsErrorHours).toBe(0.5) // median of [0, 0.5, 2]
  })

  it('computes an EVEN-length median (averages the two middle errors)', () => {
    const recs = [
      rec({ incId: 'a', predictedRecoveryHours: 1, durationMin: 60 }),  // |1-1| = 0
      rec({ incId: 'b', predictedRecoveryHours: 1, durationMin: 120 }), // |2-1| = 1
      rec({ incId: 'c', predictedRecoveryHours: 1, durationMin: 180 }), // |3-1| = 2
      rec({ incId: 'd', predictedRecoveryHours: 1, durationMin: 300 }), // |5-1| = 4
    ]
    expect(summarizeAccuracy(recs).medianAbsErrorHours).toBe(1.5) // (1 + 2) / 2 of [0,1,2,4]
  })

  it('returns zeroed stats (no NaN) for an empty / prediction-less set', () => {
    expect(summarizeAccuracy([])).toEqual({ total: 0, accurate: 0, underPredicted: 0, overPredicted: 0, hitRate: 0, medianAbsErrorHours: 0 })
    expect(summarizeAccuracy([rec({ incId: 'np' })]).hitRate).toBe(0)
  })
})

describe('readIncidentHistory', () => {
  it('returns the stored list (newest last)', async () => {
    const kv = makeKV()
    await appendIncidentHistory(kv, rec({ incId: 'a' }))
    await appendIncidentHistory(kv, rec({ incId: 'b' }))
    const list = await readIncidentHistory(kv, 'claude')
    expect(list.map(r => r.incId)).toEqual(['a', 'b'])
  })
  it('returns [] on miss', async () => {
    expect(await readIncidentHistory(makeKV(), 'nobody')).toEqual([])
  })
  it('returns [] on corrupt value (never throws)', async () => {
    const kv = makeKV({ 'incident:history:claude': '{bad' })
    expect(await readIncidentHistory(kv, 'claude')).toEqual([])
  })
})

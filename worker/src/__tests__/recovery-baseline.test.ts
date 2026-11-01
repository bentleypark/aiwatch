import { describe, it, expect, vi } from 'vitest'
import {
  summarizeRecoveryHistory,
  buildRecoveryBaselines,
  readRecoveryBaselines,
  readRecoveryValue,
  writeRecoveryBaselines,
  rebuildRecoveryBaselines,
  compareWithRecoveryBaseline,
  summarizeEstimateAccuracy,
  ESTIMATE_ACCURACY_ENTRY,
  RECOVERY_BASELINE_KEY,
} from '../recovery-baseline'
import { recoveryBaselineText, estimateAccuracyText, wholeShares, ESTIMATE_ACCURACY_MIN_N, type EstimateAccuracy } from '../recovery-baseline-text'
import { OVERRIDES_KEY } from '../overrides'
import { SERVICES } from '../services'
import { feedEventTitle, isFeedEventTitle } from '../parsers/betterstack'
import { summarizeAccuracy, type IncidentHistoryRecord } from '../incident-history'
import type { KVLike } from '../utils'

const rec = (i: number, durationMin: number, over: Partial<IncidentHistoryRecord> = {}): IncidentHistoryRecord => ({
  svcId: 'claude',
  incId: `inc-${i}`,
  title: `Elevated errors ${i}`,
  provider: 'Anthropic',
  category: 'api',
  impact: 'major',
  startedAt: `2026-08-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
  resolvedAt: '2026-09-01T00:00:00.000Z',
  durationMin,
  ...over,
})

// Durations 10, 20, … 100 — median 55, nearest-rank p80 = 80.
const ten = () => Array.from({ length: 10 }, (_, i) => rec(i, (i + 1) * 10))

function makeKV(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
    _store: store,
  } as unknown as KVLike & { _store: Map<string, string> }
}

describe('summarizeRecoveryHistory', () => {
  it('computes n, median, nearest-rank p80 and the earliest start date', () => {
    expect(summarizeRecoveryHistory(ten(), [])).toEqual({ n: 10, medianMin: 55, p80Min: 80, since: '2026-08-10' })
  })

  it('returns null below 10 qualifying incidents', () => {
    expect(summarizeRecoveryHistory(ten().slice(1), [])).toBeNull()
  })

  it('counts an incident id once', () => {
    const list = [...ten().slice(1), rec(1, 20)]
    expect(summarizeRecoveryHistory(list, [])).toBeNull()
  })

  it('excludes a record stamped autoMonitor', () => {
    const list = [...ten().slice(1), rec(0, 10, { autoMonitor: true })]
    expect(summarizeRecoveryHistory(list, [])).toBeNull()
  })

  it('excludes a pre-stamp record whose title matches the service autoMonitorTitles', () => {
    const list = [...ten().slice(1), rec(0, 10, { title: 'Some API features are experiencing issues' })]
    expect(summarizeRecoveryHistory(list, [])).not.toBeNull()
    expect(summarizeRecoveryHistory(list, [], { autoMonitorTitles: [/^Some API features are experiencing issues\.?$/i] })).toBeNull()
  })

  it('excludes a pre-stamp record stored under its titleMap translation (kimiapp)', () => {
    const kimi = SERVICES.find((c) => c.id === 'kimiapp')!
    const list = [...ten().slice(1), rec(0, 10, { title: kimi.titleMap!['Agentic 模型错误报警'] })]
    expect(summarizeRecoveryHistory(list, [], kimi)).toBeNull()
  })

  it('excludes a feed-reconstructed record', () => {
    const list = [...ten().slice(1), rec(0, 10, { title: feedEventTitle('Google Gemma 4 31B IT', true) })]
    expect(summarizeRecoveryHistory(list, [])).toBeNull()
  })

  it('excludes a zero-length record', () => {
    const list = [...ten().slice(1), rec(0, 0)]
    expect(summarizeRecoveryHistory(list, [])).toBeNull()
  })

  it('excludes a record whose override zeroes its duration', () => {
    const list = [...ten().slice(1), rec(0, 10)]
    expect(summarizeRecoveryHistory(list, [{ id: 'inc-0', durationMin: 0 }])).toBeNull()
  })

  it('applies a duration override by incident id', () => {
    const list = ten()
    list[9] = rec(9, 800)
    expect(summarizeRecoveryHistory(list, [])!.p80Min).toBe(80)
    list[7] = rec(7, 800)
    expect(summarizeRecoveryHistory(list, [])!.p80Min).toBe(90)
    expect(summarizeRecoveryHistory(list, [{ id: 'inc-7', durationMin: 75 }])!.p80Min).toBe(75)
  })
})

describe('recoveryBaselineText', () => {
  it('states the count and the earliest date, not a recency window', () => {
    expect(recoveryBaselineText({ n: 41, medianMin: 40, p80Min: 90, since: '2026-07-12' }))
      .toBe('Past incidents on this service: median 40m, 80% resolved within 1h 30m (based on 41 recorded incidents since 2026-07-12)')
  })
})

describe('rebuildRecoveryBaselines', () => {
  const history = () => new Map([['claude', ten()]])
  const configs = [{ id: 'claude' }]

  it('writes with the duration overrides applied', async () => {
    const list = ten()
    list[9] = rec(9, 800)
    list[7] = rec(7, 800)
    const kv = makeKV({ [OVERRIDES_KEY]: JSON.stringify([{ id: 'inc-7', durationMin: 85 }]) })
    expect(await rebuildRecoveryBaselines(kv as unknown as KVNamespace, new Map([['claude', list]]), configs)).toBe('written')
    expect(JSON.parse(kv._store.get(RECOVERY_BASELINE_KEY)!).claude.p80Min).toBe(85)
  })

  it('leaves the stored value untouched when the overrides read fails or is malformed', async () => {
    for (const kv of [
      makeKV({ [RECOVERY_BASELINE_KEY]: 'previous', [OVERRIDES_KEY]: '{' }),
      Object.assign(makeKV({ [RECOVERY_BASELINE_KEY]: 'previous' }), { get: async (k: string) => { if (k === OVERRIDES_KEY) throw new Error('kv down'); return null } }),
    ]) {
      expect(await rebuildRecoveryBaselines(kv as unknown as KVNamespace, history(), configs)).not.toBe('written')
      expect(kv._store.get(RECOVERY_BASELINE_KEY)).toBe('previous')
    }
  })
})

describe('feed event title', () => {
  it('recognises both titles the feed parser builds, and not an editorial title', () => {
    expect(isFeedEventTitle(feedEventTitle('API', true))).toBe(true)
    expect(isFeedEventTitle(feedEventTitle('API', false))).toBe(true)
    expect(isFeedEventTitle('API recovered after elevated errors')).toBe(false)
  })
})

describe('buildRecoveryBaselines', () => {
  it('keeps services above the floor and drops the rest', () => {
    const history = new Map([['claude', ten()], ['groq', ten().slice(0, 4)]])
    const out = buildRecoveryBaselines(history, [], [{ id: 'claude' }, { id: 'groq' }, { id: 'none' }])
    expect(Object.keys(out)).toEqual(['claude'])
  })

  it('applies each service its own autoMonitorTitles', () => {
    const twelve = ten().map((r) => ({ ...r, title: 'Some API features are experiencing issues' }))
    const out = buildRecoveryBaselines(new Map([['twelvelabs', twelve]]), [], [{ id: 'twelvelabs', autoMonitorTitles: [/^Some API features are experiencing issues\.?$/i] }])
    expect(out).toEqual({})
  })
})

describe('read/write', () => {
  it('round-trips through KV', async () => {
    const kv = makeKV()
    const baselines = buildRecoveryBaselines(new Map([['claude', ten()]]), [], [{ id: 'claude' }])
    await writeRecoveryBaselines(kv, baselines)
    expect(await readRecoveryBaselines(kv)).toEqual(baselines)
  })

  it('drops an unusable entry and keeps the rest', async () => {
    const good = { n: 12, medianMin: 40, p80Min: 90, since: '2026-07-12' }
    const kv = makeKV({ [RECOVERY_BASELINE_KEY]: JSON.stringify({ claude: good, openai: { n: 3, medianMin: 40, p80Min: 90, since: '2026-07-12' }, x: null }) })
    expect(await readRecoveryBaselines(kv)).toEqual({ claude: good })
  })

  it('returns {} on a miss, a corrupt value and a KV error', async () => {
    expect(await readRecoveryBaselines(makeKV())).toEqual({})
    expect(await readRecoveryBaselines(makeKV({ [RECOVERY_BASELINE_KEY]: '{' }))).toEqual({})
    const failing = { get: async () => { throw new Error('kv down') } } as unknown as KVLike
    expect(await readRecoveryBaselines(failing)).toEqual({})
  })
})

describe('compareWithRecoveryBaseline (#1777)', () => {
  const sept = (incId: string, svcId: string, predictedRecoveryHours: number, durationMin: number): IncidentHistoryRecord =>
    rec(0, durationMin, { svcId, incId, startedAt: '2026-09-10T10:00:00.000Z', resolvedAt: '2026-09-10T12:00:00.000Z', predictedRecoveryHours })

  it('scores the same incidents against the AI estimate, the past median and the past p80', () => {
    const history = new Map([['claude', [
      ...ten(),
      sept('s-in', 'claude', 1, 50),    // AI: 50m of 1h → in range; median 55m → in range; p80 80m → in range
      sept('s-wide', 'claude', 10, 30), // AI: 30m of 10h → under half; median 55m → in range; p80 80m → under half
    ]]])
    const out = compareWithRecoveryBaseline(history, [], SERVICES, '2026-09')
    expect(out?.ai).toMatchObject({ total: 2, accurate: 1, overPredicted: 1, underPredicted: 0 })
    expect(out?.pastMedian).toMatchObject({ total: 2, accurate: 2, overPredicted: 0, underPredicted: 0 })
    expect(out?.pastP80).toMatchObject({ total: 2, accurate: 1, overPredicted: 1, underPredicted: 0 })
  })

  it('builds each baseline only from records resolved before the incident started', () => {
    const nine = ten().slice(0, 9)
    const late = rec(9, 100, { incId: 'late', resolvedAt: '2026-09-20T00:00:00.000Z' })
    const history = new Map([['claude', [...nine, late, sept('s', 'claude', 1, 50)]]])
    expect(compareWithRecoveryBaseline(history, [], SERVICES, '2026-09')).toBeNull()
  })

  it('builds the baseline with the duration overrides applied', () => {
    // inc-0..5 pinned to 600m → past median 600m, so a 50m recovery is under half of it
    const overrides = Array.from({ length: 6 }, (_, i) => ({ id: `inc-${i}`, durationMin: 600 }))
    const history = new Map([['claude', [...ten(), sept('s', 'claude', 1, 50)]]])
    expect(compareWithRecoveryBaseline(history, [], SERVICES, '2026-09')?.pastMedian.accurate).toBe(1)
    expect(compareWithRecoveryBaseline(history, overrides, SERVICES, '2026-09')?.pastMedian.overPredicted).toBe(1)
  })

  it("builds the baseline with the service's auto-monitor titles excluded", () => {
    const history = new Map([['claude', [...ten(), sept('s', 'claude', 1, 50)]]])
    expect(compareWithRecoveryBaseline(history, [], [{ id: 'claude' }], '2026-09')).not.toBeNull()
    expect(compareWithRecoveryBaseline(history, [], [{ id: 'claude', autoMonitorTitles: [/^Elevated errors [0-4]$/] }], '2026-09')).toBeNull()
  })

  it('leaves out other periods and an incident whose service has no baseline', () => {
    const history = new Map([
      ['claude', [...ten(), sept('s', 'claude', 1, 50), { ...sept('aug', 'claude', 1, 50), resolvedAt: '2026-08-31T00:00:00.000Z' }]],
      ['openai', [sept('o', 'openai', 1, 50)]],
    ])
    const out = compareWithRecoveryBaseline(history, [], SERVICES, '2026-09')
    expect(out?.ai.total).toBe(1)
    expect(out?.pastMedian.total).toBe(1)
  })
})

describe('estimate accuracy (#1205)', () => {
  const WITHIN = 90, FAST = 30, LONGER = 180
  const scored = (i: number, durationMin: number, over: Partial<IncidentHistoryRecord> = {}) =>
    rec(i, durationMin, { incId: `s-${i}`, predictedRecoveryHours: 2, resolvedAt: `2026-09-${String((i % 27) + 1).padStart(2, '0')}T12:00:00.000Z`, ...over })
  const mix = (within: number, fast: number, longer: number) =>
    [...Array(within).fill(WITHIN), ...Array(fast).fill(FAST), ...Array(longer).fill(LONGER)].map((d, i) => scored(i, d))
  const stats = (): EstimateAccuracy => ({ total: 32, accurate: 12, overPredicted: 14, underPredicted: 6, since: '2026-09-01' })

  describe('summarizeEstimateAccuracy', () => {
    it('counts the three outcomes apart and names the earliest resolved date', () => {
      expect(summarizeEstimateAccuracy(mix(12, 14, 6))).toEqual(stats())
    })

    it('takes the earliest resolved date wherever that record sits in the input', () => {
      const records = mix(12, 14, 6)
      records[10] = { ...records[10], resolvedAt: '2026-07-03T12:00:00.000Z' }
      expect(records.map((r) => r.resolvedAt).sort()[0]).toBe('2026-07-03T12:00:00.000Z')
      expect(summarizeEstimateAccuracy(records)?.since).toBe('2026-07-03')
    })

    it('names the earliest date among the scored records, not a record with no estimate', () => {
      const earlier = scored(100, WITHIN, { predictedRecoveryHours: undefined, resolvedAt: '2026-07-01T12:00:00.000Z' })
      expect(summarizeEstimateAccuracy([earlier, ...mix(12, 14, 6)])?.since).toBe('2026-09-01')
    })

    it('shows nothing one scored estimate below the floor, and something at it', () => {
      expect(summarizeEstimateAccuracy(mix(ESTIMATE_ACCURACY_MIN_N - 1, 0, 0))).toBeNull()
      expect(summarizeEstimateAccuracy(mix(ESTIMATE_ACCURACY_MIN_N, 0, 0))?.total).toBe(ESTIMATE_ACCURACY_MIN_N)
    })

    it('counts a grouped incident once, so sibling surfaces do not lift it over the floor', () => {
      const distinct = mix(ESTIMATE_ACCURACY_MIN_N - 1, 0, 0)
      const sibling = { ...distinct[0], svcId: 'claudeai' }
      expect(summarizeEstimateAccuracy([...distinct, sibling])).toBeNull()
    })

    it('does not count a record with no estimate toward the floor', () => {
      const noEstimate = Array.from({ length: 5 }, (_, i) => scored(100 + i, WITHIN, { predictedRecoveryHours: undefined }))
      expect(summarizeEstimateAccuracy([...mix(ESTIMATE_ACCURACY_MIN_N - 1, 0, 0), ...noEstimate])).toBeNull()
    })

    it('gives the same counts as the figure the daily Discord line and the monthly report publish', () => {
      const records = mix(12, 14, 6)
      const published = summarizeAccuracy(records)
      const { total, accurate, overPredicted, underPredicted } = summarizeEstimateAccuracy(records)!
      expect({ total, accurate, overPredicted, underPredicted }).toEqual({
        total: published.total, accurate: published.accurate, overPredicted: published.overPredicted, underPredicted: published.underPredicted,
      })
    })
  })

  describe('estimateAccuracyText', () => {
    it('states the count, the earliest date and the three outcomes apart', () => {
      expect(estimateAccuracyText(stats())).toBe(
        "AIWatch's recovery estimates, all services (32 scored since 2026-09-01): 44% recovered in under half the estimate, 37% in half to all of it, 19% took longer.",
      )
    })

    it.each([[1, 1, 1], [1, 2, 3], [7, 7, 7], [100, 1, 1], [0, 1, 0], [33, 33, 34]])('whole percentages of %j add up to 100', (...counts) => {
      expect(wholeShares(counts).reduce((a, b) => a + b, 0)).toBe(100)
    })
  })

  describe('rebuildRecoveryBaselines', () => {
    const configs = [{ id: 'claude' }]

    it('writes the figure beside the service baselines when the corpus clears the floor', async () => {
      const kv = makeKV()
      await rebuildRecoveryBaselines(kv as unknown as KVNamespace, new Map([['claude', [...ten(), ...mix(12, 14, 6)]]]), configs)
      const stored = JSON.parse(kv._store.get(RECOVERY_BASELINE_KEY)!)
      expect(stored[ESTIMATE_ACCURACY_ENTRY]).toEqual(stats())
      expect(stored.claude.n).toBeGreaterThanOrEqual(10)
    })

    it('leaves the figure out below the floor, and drops one stored by an earlier run', async () => {
      const kv = makeKV({ [RECOVERY_BASELINE_KEY]: JSON.stringify({ [ESTIMATE_ACCURACY_ENTRY]: stats() }) })
      await rebuildRecoveryBaselines(kv as unknown as KVNamespace, new Map([['claude', ten()]]), configs)
      expect(Object.keys(JSON.parse(kv._store.get(RECOVERY_BASELINE_KEY)!))).toEqual(['claude'])
    })
  })

  describe('read', () => {
    const base = { n: 12, medianMin: 40, p80Min: 90, since: '2026-07-12' }
    const read = (value: unknown) => readRecoveryValue(makeKV({ [RECOVERY_BASELINE_KEY]: JSON.stringify(value) }))

    it('returns both figures from the one value, and keeps the figure out of the service map', async () => {
      const kv = makeKV()
      await writeRecoveryBaselines(kv, { claude: base }, stats())
      expect(await readRecoveryValue(kv)).toEqual({ baselines: { claude: base }, estimateAccuracy: stats() })
      expect(await readRecoveryBaselines(kv)).toEqual({ claude: base })
    })

    it('reads a figure of exactly the floor', async () => {
      const atFloor = { total: ESTIMATE_ACCURACY_MIN_N, accurate: 10, overPredicted: 10, underPredicted: 10, since: '2026-09-01' }
      expect((await read({ claude: base, [ESTIMATE_ACCURACY_ENTRY]: atFloor })).estimateAccuracy).toEqual(atFloor)
    })

    it('reads a value written before the figure existed as having none', async () => {
      expect(await read({ claude: base })).toEqual({ baselines: { claude: base }, estimateAccuracy: null })
    })

    it.each([
      ['below the floor', { ...stats(), total: ESTIMATE_ACCURACY_MIN_N - 1, accurate: 10, overPredicted: 14, underPredicted: 5 }],
      ['counts that do not add up to the total', { ...stats(), accurate: 13 }],
      ['a negative count', { ...stats(), accurate: -1, overPredicted: 27 }],
      ['a negative over-predicted count', { ...stats(), accurate: 13, overPredicted: -1, underPredicted: 20 }],
      ['a negative under-predicted count', { ...stats(), accurate: 13, overPredicted: 20, underPredicted: -1 }],
      ['a fractional count', { ...stats(), accurate: 11.5, overPredicted: 14.5 }],
      ['a date that is not a day', { ...stats(), since: 'July' }],
      ['a string where a count belongs', { ...stats(), total: '32' }],
      ['an array', [stats()]],
    ])('drops a figure with %s, and still returns the service baselines', async (_name, bad) => {
      expect(await read({ claude: base, [ESTIMATE_ACCURACY_ENTRY]: bad })).toEqual({ baselines: { claude: base }, estimateAccuracy: null })
    })

    it('returns neither on a miss, a corrupt value and a KV error', async () => {
      const none = { baselines: {}, estimateAccuracy: null }
      expect(await readRecoveryValue(makeKV())).toEqual(none)
      expect(await readRecoveryValue(makeKV({ [RECOVERY_BASELINE_KEY]: '{' }))).toEqual(none)
      expect(await readRecoveryValue({ get: async () => { throw new Error('kv down') } } as unknown as KVLike)).toEqual(none)
    })
  })
})

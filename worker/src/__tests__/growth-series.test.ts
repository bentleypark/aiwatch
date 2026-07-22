import { describe, it, expect, vi } from 'vitest'
import {
  buildGrowthDailyRow,
  appendGrowthDaily,
  parseGrowthSeries,
  recordGrowthDaily,
  growthSeriesKey,
  periodOf,
  GROWTH_SERIES_CAP,
  countIncidentsInWindow,
  fillOutageWindows,
  nominalWindowEnd,
  previousPeriod,
  periodsCoveringWindow,
  type GrowthDailyRow,
} from '../growth-series'

const row = (date: string, over: Partial<GrowthDailyRow> = {}): GrowthDailyRow => ({
  date,
  alertedIncidents: 0,
  alertedResolved: 0,
  referralTotal: 0,
  subscribers: 1,
  subscriberNewToday: 0,
  audienceTotal: null,
  audienceActiveTotal: null,
  audienceBySource: null,
  ...over,
})

describe('growthSeriesKey / periodOf', () => {
  it('one permanent key per month', () => {
    expect(periodOf('2026-07-10')).toBe('2026-07')
    expect(growthSeriesKey('2026-07')).toBe('growth:daily:2026-07')
  })
})

describe('buildGrowthDailyRow', () => {
  const base = {
    date: '2026-07-10',
    alertCounts: { incidents: 6, resolved: 4, down: 1, degraded: 0, recovered: 1 },
    referralTotal: 7,
    subscribers: 12,
    subscriberNewToday: 1,
    audience: { total: 40, activeTotal: 31, bySource: { x: 20, search: 11 }, activeBySource: { x: 20 } },
  }

  it('carries the outage-day axis and every consent-free counter', () => {
    expect(buildGrowthDailyRow(base as never)).toEqual({
      date: '2026-07-10',
      alertedIncidents: 6,
      alertedResolved: 4,
      referralTotal: 7,
      subscribers: 12,
      subscriberNewToday: 1,
      audienceTotal: 40,
      audienceActiveTotal: 31,
      audienceBySource: { x: 20, search: 11 },
    })
  })

  // `alertedIncidents` must come from the `alert:count:{date}` daily accumulator rather than
  // `result.newCount` (which counts only the alerts sent by the one 5-minute cycle that fires the
  // 09:00 UTC report). #1117 established that this is still not a whole-day axis — the key is read at
  // 09:00, so 00:00–09:00 is all it can ever hold — which is why `incidentsStartedInWindow` exists
  // below. These assertions pin the narrower fact the field now claims: what the accumulator held.
  it('an absent alert:count key is a genuine quiet day (0), not a gap', () => {
    const r = buildGrowthDailyRow({ ...base, alertCounts: null } as never)
    expect(r.alertedIncidents).toBe(0)
    expect(r.alertedResolved).toBe(0)
  })

  it('a partial accumulator fills missing counters with 0', () => {
    const r = buildGrowthDailyRow({ ...base, alertCounts: { incidents: 2 } } as never)
    expect(r.alertedIncidents).toBe(2)
    expect(r.alertedResolved).toBe(0)
  })

  // A failed read is not "zero". The caller disambiguates and passes null; the row must preserve it.
  it('null inputs survive as null — a broken day must never read as a quiet day', () => {
    const r = buildGrowthDailyRow({
      ...base,
      referralTotal: null,
      subscribers: null,
      subscriberNewToday: null,
      audience: null,
    } as never)
    expect(r.referralTotal).toBeNull()
    expect(r.subscribers).toBeNull()
    expect(r.subscriberNewToday).toBeNull()
    expect(r.audienceTotal).toBeNull()
    expect(r.audienceBySource).toBeNull()
  })

  it('a real zero stays 0 — nobody clicked is a fact, not a gap', () => {
    expect(buildGrowthDailyRow({ ...base, referralTotal: 0 } as never).referralTotal).toBe(0)
  })

  // #1117 — ABSENT, not null, when the incident record could not be read. The incident record is
  // retained ~60 days, so the gap is recoverable by a later run's backfill; writing `null` (the
  // convention the TTL'd counters above use, where a failure IS permanent) would freeze it.
  it('omits the window axis entirely when the incident record was unreadable', () => {
    const r = buildGrowthDailyRow({ ...base, outage: null } as never)
    expect('incidentsStartedInWindow' in r).toBe(false)
    expect('outageWindowEnd' in r).toBe(false)
  })

  it('carries the window axis and the window it was counted over', () => {
    const r = buildGrowthDailyRow({
      ...base,
      outage: { started: 23, windowEnd: '2026-07-22T09:00:00.000Z' },
    } as never)
    expect(r.incidentsStartedInWindow).toBe(23)
    expect(r.outageWindowEnd).toBe('2026-07-22T09:00:00.000Z')
  })

  // A genuinely quiet window is 0 and must survive as 0 — the same null-vs-zero discipline the rest
  // of the row keeps, in the direction that matters here (0 outages is the baseline a lift
  // measurement compares AGAINST; losing it to "absent" would drop the quiet days from the dataset).
  it('a quiet window stays 0', () => {
    const r = buildGrowthDailyRow({
      ...base,
      outage: { started: 0, windowEnd: '2026-07-19T09:00:00.000Z' },
    } as never)
    expect(r.incidentsStartedInWindow).toBe(0)
  })
})

describe('appendGrowthDaily', () => {
  it('appends and keeps the series sorted by date', () => {
    const out = appendGrowthDaily([row('2026-07-02')], row('2026-07-01'))
    expect(out.map((r) => r.date)).toEqual(['2026-07-01', '2026-07-02'])
  })

  // The cron has a catch-up path and could run a date twice. Duplicated rows would double-count an
  // outage day in any later lift comparison.
  it('is idempotent — re-running a date replaces its row instead of duplicating it', () => {
    const first = appendGrowthDaily([], row('2026-07-10', { referralTotal: 1 }))
    const again = appendGrowthDaily(first, row('2026-07-10', { referralTotal: 9 }))
    expect(again).toHaveLength(1)
    expect(again[0].referralTotal).toBe(9)
  })

  it('caps the series, dropping the oldest rows', () => {
    let series: GrowthDailyRow[] = []
    for (let d = 1; d <= GROWTH_SERIES_CAP + 5; d++) {
      series = appendGrowthDaily(series, row(`2026-07-${String(d).padStart(2, '0')}`))
    }
    expect(series).toHaveLength(GROWTH_SERIES_CAP)
    expect(series[0].date).toBe('2026-07-06')
  })

  it('degrades to a fresh series on an absent or corrupt existing value', () => {
    expect(appendGrowthDaily(null, row('2026-07-10'))).toHaveLength(1)
    expect(appendGrowthDaily('not an array', row('2026-07-10'))).toHaveLength(1)
    expect(appendGrowthDaily([{ nope: true }, row('2026-07-09')], row('2026-07-10'))).toHaveLength(2)
  })
})

describe('parseGrowthSeries', () => {
  it('tolerates absence, invalid JSON, and non-array payloads', () => {
    expect(parseGrowthSeries(null)).toEqual([])
    expect(parseGrowthSeries('')).toEqual([])
    expect(parseGrowthSeries('{oops')).toEqual([])
    expect(parseGrowthSeries('{"a":1}')).toEqual([])
  })

  it('round-trips a stored series and drops malformed rows', () => {
    const stored = JSON.stringify([row('2026-07-09'), { junk: 1 }])
    expect(parseGrowthSeries(stored).map((r) => r.date)).toEqual(['2026-07-09'])
  })
})

describe('recordGrowthDaily', () => {
  it('seeds a new month when the key is genuinely absent', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const kv = { get: vi.fn().mockResolvedValue(null), put } as never
    expect(await recordGrowthDaily(kv, row('2026-07-01'))).toBe(true)
    expect(put).toHaveBeenCalledOnce()
    expect(put.mock.calls[0][0]).toBe('growth:daily:2026-07')
    expect(put.mock.calls[0][2]).toBeUndefined() // no expirationTtl → permanent
    expect(JSON.parse(put.mock.calls[0][1])).toHaveLength(1)
  })

  it('merges into the existing month', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const kv = { get: vi.fn().mockResolvedValue(JSON.stringify([row('2026-07-01')])), put } as never
    await recordGrowthDaily(kv, row('2026-07-02'))
    expect(JSON.parse(put.mock.calls[0][1]).map((r: GrowthDailyRow) => r.date)).toEqual(['2026-07-01', '2026-07-02'])
  })

  // The key is a permanent accumulator with no TTL and no recovery path. Collapsing a thrown read to
  // `null` would rewrite the whole month as one row and destroy every day accrued so far. Losing one
  // day is recoverable; overwriting is not.
  it('SKIPS the write when the read throws — never overwrites the month on a transient error', async () => {
    const put = vi.fn()
    const kv = { get: vi.fn().mockRejectedValue(new Error('KV 503')), put } as never
    expect(await recordGrowthDaily(kv, row('2026-07-20'))).toBe(false)
    expect(put).not.toHaveBeenCalled()
  })
})

// ── #1117: the window-aligned outage axis ────────────────────────────────────
//
// The bug this replaces: the row read `alert:count:{date}` at the 09:00 UTC run, so it captured
// 00:00–09:00 of that date and nothing else — measured on production 2026-07-22, KV held 23 incidents
// for 07-21 while the row said 1. These fns count from the durable incident record instead, over the
// SAME 24h window the audience fields were queried over.

// Mirrors what `accumulateMonthlyIncidents` actually writes: `finalStatus: 'resolved'` iff `resolvedAt`
// is set (an unresolved entry carries its in-progress state instead).
const inc = (id: string, startedAt: string | null, resolvedAt: string | null = null) =>
  ({ id, title: id, startedAt, resolvedAt, durationMin: 0, finalStatus: resolvedAt ? 'resolved' : 'monitoring' }) as unknown as { id: string; startedAt: string | null }

// `incidentIds` mirrors the detail list on purpose: the accumulator writes them together, and a
// shorter detail list is precisely the TRUNCATION signal the fold reports. A fixture with
// `incidentIds: []` would be an impossible state that also masks that path.
const monthly = (services: Record<string, Array<{ id: string; startedAt: string | null }>>) =>
  ({
    lastUpdated: '2026-07-22T09:00:00.000Z',
    services: Object.fromEntries(
      Object.entries(services).map(([k, v]) => [k, {
        count: v.length,
        totalMinutes: 0,
        longestMinutes: 0,
        // The accumulator writes one `dates` entry and one `durations[id]` per incident it adds; a
        // fixture that leaves them empty beside a populated `incidents` array is an impossible state.
        dates: [...new Set(v.map((i) => String(i.startedAt ?? '').slice(0, 10)).filter(Boolean))],
        incidentIds: v.map((i) => i.id),
        durations: Object.fromEntries(v.map((i) => [i.id, 0])),
        incidents: v,
      }]),
    ),
  }) as never

const END = Date.parse('2026-07-22T09:00:00.000Z') // window = [07-21 09:00, 07-22 09:00)

describe('countIncidentsInWindow (#1117)', () => {
  it('counts starts inside the window and excludes those outside it', () => {
    const src = monthly({
      claude: [
        inc('a', '2026-07-21T15:35:00Z'), // inside
        inc('b', '2026-07-20T23:00:00Z'), // before the window
        inc('c', '2026-07-22T10:00:00Z'), // after the window
      ],
    })
    expect(countIncidentsInWindow([src], END).started).toBe(1)
  })

  // Half-open [start, end): the run instant belongs to the NEXT window, else an incident opening
  // exactly at 09:00 is counted twice — once here and once tomorrow.
  it('is half-open — start inclusive, end exclusive', () => {
    const src = monthly({
      claude: [inc('lo', '2026-07-21T09:00:00.000Z'), inc('hi', '2026-07-22T09:00:00.000Z')],
    })
    expect(countIncidentsInWindow([src], END).started).toBe(1)
  })

  // STARTS ONLY (see the field docs): an incident that started before the window is not counted here
  // even if it resolved inside it. A resolution axis was dropped because `incidents:monthly` buckets by
  // `startedAt` and only the current month is re-accumulated, so it could only ever be a lower bound.
  it('counts only starts — a resolution inside the window is not one', () => {
    const src = monthly({
      openai: [
        inc('long', '2026-07-01T00:00:00Z', '2026-07-21T18:00:00Z'),
        inc('fresh', '2026-07-21T20:00:00Z', null),
      ],
    })
    expect(countIncidentsInWindow([src], END).started).toBe(1)
  })

  // A window on the 1st of a month reaches into the previous month's key, so both are passed — and an
  // incident present in both must not be double-counted.
  it('dedupes an incident that appears in two month keys', () => {
    const a = monthly({ claude: [inc('dup', '2026-07-21T15:00:00Z')] })
    const b = monthly({ claude: [inc('dup', '2026-07-21T15:00:00Z')] })
    expect(countIncidentsInWindow([a, b], END).started).toBe(1)
  })

  // Same id under two services is two incidents (ids are per status-page, not global).
  it('keys dedup by service AND id', () => {
    const src = monthly({
      claude: [inc('x1', '2026-07-21T15:00:00Z')],
      openai: [inc('x1', '2026-07-21T16:00:00Z')],
    })
    expect(countIncidentsInWindow([src], END).started).toBe(2)
  })

  // An unknown timestamp is not evidence of a start inside the window. Counting it would inflate the
  // axis exactly where the old one deflated it.
  it('skips entries with an absent or unparseable timestamp', () => {
    const src = monthly({ claude: [inc('n', null), inc('bad', 'not-a-date'), inc('ok', '2026-07-21T12:00:00Z')] })
    expect(countIncidentsInWindow([src], END).started).toBe(1)
  })

  // NOTE the `0` here is NOT "a quiet day" — it is "nothing to count in what you handed me". The CALLER
  // must not hand this fn a window whose month keys it failed to read; `periodsCoveringWindow` +
  // the `covered` set at the call site are what enforce that, and are tested below.
  it('tolerates absent / malformed sources and pre-#375 entries with no incident list', () => {
    const legacy = { lastUpdated: 'x', services: {} } as never
    expect(countIncidentsInWindow([null, undefined, legacy, {} as never], END)).toEqual({ started: 0 })
  })

  // A count over an undefined window is not a quiet day. Returning 0 would be indistinguishable
  // from one and would then be FROZEN onto the row (filled rows are never recomputed) — the exact
  // failure #1117 removes. `isRow` only checks that `date` is a string, so a corrupt date can reach here.
  it('throws on a non-finite window end instead of reporting a quiet day', () => {
    expect(() => countIncidentsInWindow([], Date.parse('not-a-date'))).toThrow(RangeError)
    expect(() => countIncidentsInWindow([], Date.parse(nominalWindowEnd('garbage')))).toThrow(RangeError)
  })

  // Id-less entries would otherwise all collapse onto `svc::` and count as one.
  it('skips entries with no id rather than merging them onto one dedup key', () => {
    const src = monthly({ claude: [inc('', '2026-07-21T10:00:00Z'), inc('', '2026-07-21T11:00:00Z')] })
    expect(countIncidentsInWindow([src], END).started).toBe(0)
  })

  // ACCEPTED LOWER BOUND (see the fn docstring): an entry with aggregates but no detail list — a
  // pre-#375 row, or one whose detail was dropped by the 200/service/month cap — contributes 0. A gate
  // on this was drafted and removed: it would have refused correct counts for the rest of the month to
  // avoid a miscount that requires 200+ incidents from ONE service inside a single 24h window.
  it('undercounts an entry with aggregates but no detail list, by accepted design', () => {
    const legacy = { lastUpdated: 'x', services: { claude: { count: 3, totalMinutes: 0, longestMinutes: 0, dates: [], incidentIds: ['a', 'b', 'c'], durations: {} } } } as never
    expect(countIncidentsInWindow([legacy], END)).toEqual({ started: 0 })
  })

  // The whole two-key apparatus (previousPeriod / periodsCoveringWindow) exists for the first-of-month
  // window. Identical-source dedup cannot prove the SECOND source is even read.
  it('counts across both month sources, not just the first', () => {
    const curr = monthly({ claude: [inc('julyone', '2026-07-01T02:00:00Z')] })
    const prev = monthly({ openai: [inc('junelast', '2026-06-30T20:00:00Z')] })
    expect(countIncidentsInWindow([curr, prev], Date.parse('2026-07-01T09:00:00.000Z')).started).toBe(2)
  })
})

// The month arithmetic that a review caught: `setUTCMonth(getUTCMonth() - 1)` keeps the day-of-month,
// so on the 29th-31st it overflows FORWARD and yields the current month back. The first-of-month row's
// window reaches into the previous month, so the wrong key there means a frozen undercount.
describe('previousPeriod / periodsCoveringWindow (#1117)', () => {
  // The regression this replaced: `new Date(d); d.setUTCMonth(d.getUTCMonth() - 1)` KEPT the
  // day-of-month, so the 29th-31st overflowed forward and returned the current month. Feed real dates
  // through the same `slice(0, 7)` the call site uses, so the day-of-month is actually exercised
  // rather than discarded by the fixture.
  it('never returns the current period, for any day of any month', () => {
    for (const d of ['2026-01-31', '2026-03-29', '2026-03-30', '2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31', '2026-10-31', '2026-12-31']) {
      const period = d.slice(0, 7)
      const prev = previousPeriod(period)
      expect(prev, `for ${d}`).not.toBe(period)
      // and it must be the ADJACENT month, not merely a different one
      const gap = (Number(period.slice(0, 4)) * 12 + Number(period.slice(5))) - (Number(prev.slice(0, 4)) * 12 + Number(prev.slice(5)))
      expect(gap, `for ${d}`).toBe(1)
    }
  })

  it('rolls the year back at January', () => {
    expect(previousPeriod('2026-01')).toBe('2025-12')
    expect(previousPeriod('2026-07')).toBe('2026-06')
    expect(previousPeriod('2026-11')).toBe('2026-10')
  })

  it('reports one period mid-month and two across a boundary', () => {
    expect(periodsCoveringWindow('2026-07-22T09:00:00.000Z')).toEqual(['2026-07'])
    expect(periodsCoveringWindow('2026-07-01T09:00:00.000Z')).toEqual(['2026-06', '2026-07'])
    expect(periodsCoveringWindow('2026-01-01T09:00:00.000Z')).toEqual(['2025-12', '2026-01'])
  })

  // An uncoverable window must be reported as such, not silently as "one period".
  it('reports no coverage for an unparseable window end', () => {
    expect(periodsCoveringWindow('nonsense')).toEqual([])
  })
})

describe('fillOutageWindows (#1117)', () => {
  const bare = (date: string) => row(date)

  it('fills rows that predate the axis', () => {
    const out = fillOutageWindows([bare('2026-07-13')], (d) => ({ started: 9, windowEnd: nominalWindowEnd(d) }))
    expect(out[0].incidentsStartedInWindow).toBe(9)
    expect(out[0].outageWindowEnd).toBe('2026-07-13T09:00:00.000Z')
  })

  // The suppression list moves over time, so recomputing an already-counted row would silently
  // restate history — and a re-run must never change a number a reader already used.
  it('never recomputes a row that already carries the axis', () => {
    const existing = { ...bare('2026-07-13'), incidentsStartedInWindow: 1, outageWindowEnd: 'PINNED' }
    const out = fillOutageWindows([existing], () => ({ started: 99, windowEnd: 'NEW' }))
    expect(out[0].incidentsStartedInWindow).toBe(1)
    expect(out[0].outageWindowEnd).toBe('PINNED')
  })

  // 0 is a real count, and `0 !== undefined` — a row counted as quiet must be treated as done, not
  // refilled forever.
  it('treats a counted zero as filled', () => {
    const zero = { ...bare('2026-07-19'), incidentsStartedInWindow: 0, outageWindowEnd: 'PINNED' }
    const out = fillOutageWindows([zero], () => ({ started: 7, windowEnd: 'NEW' }))
    expect(out[0].incidentsStartedInWindow).toBe(0)
  })

  // Out of the record's retention → leave ABSENT so a later run can still try; writing 0 would book a
  // busy day as quiet, which is the very failure #1117 exists to remove.
  it('leaves a row untouched when the window cannot be covered', () => {
    const out = fillOutageWindows([bare('2026-05-01')], () => null)
    expect('incidentsStartedInWindow' in out[0]).toBe(false)
  })

  // Each row must be computed over ITS OWN window. A single-row test cannot see `compute(rows[0].date)`
  // — the whole series then inherits day 1's window, silently.
  it('computes each row over its own window, not the first row\'s', () => {
    const out = fillOutageWindows([bare('2026-07-13'), bare('2026-07-14'), bare('2026-07-15')], (d) => ({
      started: Number(d.slice(-2)), windowEnd: nominalWindowEnd(d),
    }))
    expect(out.map((r) => r.outageWindowEnd)).toEqual([
      '2026-07-13T09:00:00.000Z', '2026-07-14T09:00:00.000Z', '2026-07-15T09:00:00.000Z',
    ])
    expect(out.map((r) => r.incidentsStartedInWindow)).toEqual([13, 14, 15])
  })

  // The steady state from day 2 onward is a MIXED series. An early-exit on the first filled row would
  // leave every later gap unfilled forever, and a single-row test cannot catch it.
  it('fills only the gaps in a mixed series, leaving filled rows byte-identical', () => {
    const filled = (d: string, n: number) => ({ ...bare(d), incidentsStartedInWindow: n, outageWindowEnd: `PINNED-${d}` })
    const out = fillOutageWindows([filled('2026-07-13', 1), bare('2026-07-14'), filled('2026-07-15', 3)], (d) => ({
      started: 99, windowEnd: nominalWindowEnd(d),
    }))
    expect(out.map((r) => r.incidentsStartedInWindow)).toEqual([1, 99, 3])
    expect(out.map((r) => r.outageWindowEnd)).toEqual(['PINNED-2026-07-13', '2026-07-14T09:00:00.000Z', 'PINNED-2026-07-15'])
  })

  it('does not mutate the rows it was given', () => {
    const input = [bare('2026-07-13')]
    const snapshot = JSON.stringify(input)
    fillOutageWindows(input, (d) => ({ started: 5, windowEnd: nominalWindowEnd(d) }))
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('recordGrowthDaily backfill pass (#1117)', () => {
  it('applies the backfill to the whole merged series before writing', async () => {
    const stored = JSON.stringify([row('2026-07-13'), row('2026-07-14')])
    let written = ''
    const kv = { get: vi.fn().mockResolvedValue(stored), put: vi.fn(async (_k: string, v: string) => { written = v }) }
    await recordGrowthDaily(kv as never, row('2026-07-15'), (rows) =>
      fillOutageWindows(rows, (d) => ({ started: 5, windowEnd: nominalWindowEnd(d) })))
    const out = JSON.parse(written) as GrowthDailyRow[]
    expect(out.map((r) => r.date)).toEqual(['2026-07-13', '2026-07-14', '2026-07-15'])
    expect(out.every((r) => r.incidentsStartedInWindow === 5)).toBe(true)
  })

  it('writes the series unchanged when no backfill is supplied', async () => {
    let written = ''
    const kv = { get: vi.fn().mockResolvedValue('[]'), put: vi.fn(async (_k: string, v: string) => { written = v }) }
    await recordGrowthDaily(kv as never, row('2026-07-15'))
    expect(JSON.parse(written)[0].incidentsStartedInWindow).toBeUndefined()
  })

  // `recordGrowthDaily` returns false rather than throwing when the WRITE fails — that boolean is what
  // drives the call site's "this day is unrecoverable" error line.
  it('returns false when the write fails', async () => {
    const kv = { get: vi.fn().mockResolvedValue('[]'), put: vi.fn().mockRejectedValue(new Error('kv down')) }
    expect(await recordGrowthDaily(kv as never, row('2026-07-15'))).toBe(false)
  })

  // A stored axis must survive the daily read-modify-write untouched — a future "normalize the parsed
  // rows" refactor that whitelisted the pre-#1117 fields would silently strip history on every run.
  it('round-trips an already-counted row through the daily write', async () => {
    const stored = JSON.stringify([{ ...row('2026-07-13'), incidentsStartedInWindow: 9, outageWindowEnd: 'PINNED' }])
    let written = ''
    const kv = { get: vi.fn().mockResolvedValue(stored), put: vi.fn(async (_k: string, v: string) => { written = v }) }
    await recordGrowthDaily(kv as never, row('2026-07-15'), (rows) =>
      fillOutageWindows(rows, (d) => ({ started: 1, windowEnd: nominalWindowEnd(d) })))
    const out = JSON.parse(written) as GrowthDailyRow[]
    expect(out[0]).toMatchObject({ date: '2026-07-13', incidentsStartedInWindow: 9, outageWindowEnd: 'PINNED' })
  })

  // The backfill is a bonus pass over arbitrary stored rows. Today's inputs (referral:out 2d,
  // webhook:sub:count 7d, the WAE query) cannot be re-derived tomorrow, so a throw in the bonus pass
  // must never cost the day.
  it('still writes today\'s row when the backfill throws', async () => {
    let written = ''
    const kv = { get: vi.fn().mockResolvedValue('[]'), put: vi.fn(async (_k: string, v: string) => { written = v }) }
    const ok = await recordGrowthDaily(kv as never, row('2026-07-15', { referralTotal: 4 }), () => { throw new Error('boom') })
    expect(ok).toBe(true)
    const out = JSON.parse(written) as GrowthDailyRow[]
    expect(out).toHaveLength(1)
    expect(out[0].referralTotal).toBe(4)
  })
})

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
    // #1280 — a real AudienceCounts always carries `byScreen`; the `as never` below means tsc cannot
    // enforce that here, so the fixture has to stay faithful by hand.
    audience: { total: 40, activeTotal: 31, bySource: { x: 20, search: 11 }, activeBySource: { x: 20 }, byScreen: { service: { claude: 25 }, group: { claude: 15 }, unknown: {} } },
    feedPolls: { verdict: 'failed', polls: null },
    // #1293 — same shape as `feedPolls`: the pair, never the value alone.
    extPolls: { verdict: 'failed', polls: null },
    pluginPolls: { verdict: 'failed', counts: null },
    statuslinePolls: { verdict: 'failed', counts: null },
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
      // #1280 — stored as read: the group page's views stay under `group` rather than being folded
      // into the member id they share, which is the whole reason the field exists.
      audienceByScreen: { service: { claude: 25 }, group: { claude: 15 }, unknown: {} },
      feedPolls: null,
      feedPollsRead: 'failed',
      extPolls: null,
      extPollsRead: 'failed',
      pluginPolls: null,
      pluginPollsRead: 'failed',
      statuslinePolls: null,
      statuslinePollsRead: 'failed',
    })
  })

  // #1293 — `0` keeps its VALUE for these counters rather than collapsing to `null`, so the series can
  // still tell "nobody polled" from "the query broke". It arrives under `zero`, not `ok`: the value is
  // kept and the ambiguity travels with it, because a quiet window and a recorder that wrote nothing
  // produce the same reading.
  it('stores a genuine zero as zero, not as the null that means "could not read"', () => {
    const r = buildGrowthDailyRow({
      ...base,
      extPolls: { verdict: 'zero', polls: 0 },
      pluginPolls: { verdict: 'zero', counts: { monitor: 0, brief: 0 } },
    } as never)
    expect(r.extPolls).toBe(0)
    expect(r.extPolls).not.toBeNull()
    // `zero`, not `ok`: the value is kept (the read succeeded) but flagged as the one reading a dead
    // recorder also produces. With the operator's own client excluded this is the EXPECTED state.
    expect(r.extPollsRead).toBe('zero')
    expect(r.pluginPolls).toEqual({ monitor: 0, brief: 0 })
    expect(r.pluginPolls).not.toBeNull()
    expect(r.pluginPollsRead).toBe('zero')
  })

  // The two counters are two INDEPENDENT AE queries — one can fail while the other succeeds — so a
  // mixed row is a production-realistic state, and it is the only one that discriminates a copy-paste
  // between the four near-identical assignment lines in `buildGrowthDailyRow`.
  it('keeps all three counters\' verdicts independent — a three-way mixed row', () => {
    // Three INDEPENDENT AE reads: any one can fail while another succeeds and a third reads quiet, so a
    // mixed row is production-realistic. It is also the only shape that discriminates a copy-paste
    // between the six near-identical assignment lines in `buildGrowthDailyRow` — and the only test that
    // puts a NON-NULL `statuslinePolls` through the builder at all.
    const sl = { byPreset: {}, serverRenderTotal: 0, legacyProxy: 0, total: 0 }
    const r = buildGrowthDailyRow({
      ...base,
      extPolls: { verdict: 'ok', polls: 2010 },
      pluginPolls: { verdict: 'failed', counts: null },
      statuslinePolls: { verdict: 'zero', counts: sl },
    } as never)
    expect(r.extPolls).toBe(2010)
    expect(r.extPollsRead).toBe('ok')
    expect(r.pluginPolls).toBeNull()
    expect(r.pluginPollsRead).toBe('failed')
    expect(r.statuslinePolls).toEqual(sl)
    expect(r.statuslinePollsRead).toBe('zero')
  })

  it('carries a measured statusline payload through the builder', () => {
    // Without this, hardcoding `statuslinePolls: null` at the write site leaves the field this change
    // exists to add permanently null in every row, with the suite green.
    const sl = { byPreset: { branded: 120 }, serverRenderTotal: 120, legacyProxy: 3, total: 123 }
    const r = buildGrowthDailyRow({ ...base, statuslinePolls: { verdict: 'ok', counts: sl } } as never)
    expect(r.statuslinePolls).toEqual(sl)
    expect(r.statuslinePollsRead).toBe('ok')
  })

  it('carries the ext/plugin poll counts with the verdict that explains them', () => {
    const r = buildGrowthDailyRow({
      ...base,
      extPolls: { verdict: 'ok', polls: 2010 },
      pluginPolls: { verdict: 'ok', counts: { monitor: 1044, brief: 3 } },
    } as never)
    expect(r.extPolls).toBe(2010)
    expect(r.extPollsRead).toBe('ok')
    // The plugin's two indexes stay separate — summing them would make a burst of on-demand
    // briefings read as background-monitor uptime, i.e. as installs.
    expect(r.pluginPolls).toEqual({ monitor: 1044, brief: 3 })
    expect(r.pluginPollsRead).toBe('ok')
  })

  // `alertedIncidents` must come from the `alert:count:{date}` daily accumulator rather than
  // `result.newCount` (which counts only the alerts sent by the one 5-minute cycle that fires the
  // 09:00 UTC report). #1117 established that this is still not a whole-day axis — the key is read at
  // 09:00, so 00:00–09:00 is all it can ever hold — which is why `incidentsStartedInWindow` exists
  // below. These assertions pin the narrower fact the field now claims: what the accumulator held.
  // #1273 — three distinguishable states, and the KV boundary is where it matters: the row is
  // JSON.stringify'd, which KEEPS null and DROPS undefined, so a bug that passes `undefined` for a
  // failed read would silently produce the "not instrumented" shape instead of the "could not read"
  // shape. Asserting on the builder's return value alone cannot see that — `toEqual` treats an
  // undefined property and an absent one as equal — so the null case is re-asserted at `kv.put` below.
  it('carries feedPolls when the AE read succeeded, with the verdict that explains it', () => {
    const r = buildGrowthDailyRow({ ...base, feedPolls: { verdict: 'ok', polls: { claude: { slack: 72 } } } } as never)
    expect(r.feedPolls).toEqual({ claude: { slack: 72 } })
    expect(r.feedPollsRead).toBe('ok')
  })

  // Three causes reach `polls: null` and they call for opposite remedies — a broken query, a quiet
  // window, and a window of thousands of polls carrying no blobs. The row is permanent and has no
  // reader yet, so a `null` whose verdict was dropped is a fact nobody can ever recover.
  it('records WHICH null it stored, so the three causes stay distinguishable', () => {
    for (const verdict of ['failed', 'zero', 'unclassifiable'] as const) {
      const r = buildGrowthDailyRow({ ...base, feedPolls: { verdict, polls: null } } as never)
      expect(r.feedPolls).toBeNull()
      expect(r.feedPolls).not.toEqual({})
      expect(r.feedPollsRead, `verdict ${verdict} was not carried into the row`).toBe(verdict)
    }
  })

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
    // #1280 — `null`, never `undefined`: JSON.stringify drops an undefined-valued key, so the row
    // would store the field ABSENT, and absent means "no screen instrumentation existed then" while
    // null means "the read failed". A day whose WAE query died would become permanently readable as
    // a pre-deploy day.
    expect(r.audienceByScreen).toBeNull()
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

describe('recordGrowthDaily — feedPolls at the KV boundary (#1273)', () => {
  it('serializes a failed AE read as an explicit null, not as a dropped key', async () => {
    let written = ''
    const kv = { get: vi.fn().mockResolvedValue('[]'), put: vi.fn(async (_k: string, v: string) => { written = v }) }
    await recordGrowthDaily(kv as never, row('2026-08-22', { feedPolls: null }))
    // The literal substring, not a parsed round-trip: JSON.parse would collapse `null` and a missing
    // key back into the same `undefined`, which is exactly the confusion this asserts against.
    expect(written).toContain('"feedPolls":null')
    expect(JSON.parse(written)[0]).toHaveProperty('feedPolls', null)
  })

  it('serializes a successful read as the nested map', async () => {
    let written = ''
    const kv = { get: vi.fn().mockResolvedValue('[]'), put: vi.fn(async (_k: string, v: string) => { written = v }) }
    await recordGrowthDaily(kv as never, row('2026-08-22', {
      feedPolls: { claude: { slack: 72 }, __all__: { slack: 77 }, huggingface: { bot: 24 } },
    }))
    expect(JSON.parse(written)[0].feedPolls).toEqual({
      claude: { slack: 72 }, __all__: { slack: 77 }, huggingface: { bot: 24 },
    })
  })

  it('a same-date re-run with a FAILED read must not destroy an already-measured map', () => {
    // The 10:00 catch-up re-runs a date whose 09:00 run wrote a row but not its marker (a Discord
    // throw, or `kvPut` swallowing the marker write). If that run's AE query fails, the whole-row
    // replace would drop a measured 24h window from a key with no TTL and no backfill path.
    // `recordGrowthDaily`'s own docstring states the doctrine: losing a day is recoverable,
    // overwriting is not.
    const prior = [{ ...row('2026-08-22'), feedPolls: { claude: { slack: 72 } } }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { feedPolls: null }))
    expect(out).toHaveLength(1)
    expect(out[0].feedPolls).toEqual({ claude: { slack: 72 } })
  })

  it('carries the preserved map\'s OWN verdict, not the failed re-run\'s', () => {
    // `feedPollsRead` explains `feedPolls`, so the two have to travel together. Carrying the map
    // alone leaves the later run's `failed` sitting beside a measurement — the same one-value-two-
    // stories defect the verdict field was added to end, reintroduced by the guard that fixed it.
    const prior = [{ ...row('2026-08-22'), feedPolls: { claude: { slack: 72 } }, feedPollsRead: 'ok' as const }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { feedPolls: null, feedPollsRead: 'failed' }))
    expect(out[0].feedPolls).toEqual({ claude: { slack: 72 } })
    expect(out[0].feedPollsRead).toBe('ok')
  })

  // #1293 — the same doctrine for the two counters, and its verdict travels too.
  it('a failed ext/plugin re-run must not destroy an already-measured count', () => {
    const prior = [{ ...row('2026-08-22'), extPolls: 2010, extPollsRead: 'ok' as const, pluginPolls: { monitor: 1044, brief: 3 }, pluginPollsRead: 'ok' as const }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { extPolls: null, extPollsRead: 'failed', pluginPolls: null, pluginPollsRead: 'failed' }))
    expect(out).toHaveLength(1)
    expect(out[0].extPolls).toBe(2010)
    expect(out[0].extPollsRead).toBe('ok')
    expect(out[0].pluginPolls).toEqual({ monitor: 1044, brief: 3 })
    expect(out[0].pluginPollsRead).toBe('ok')
  })

  // The OTHER direction, and the one a truthiness check would get wrong. `0` is a successful read of a
  // quiet window: preserving the prior over it would invent traffic that never happened, permanently,
  // in a key with no TTL. This is what makes the guard `== null` rather than `!row.extPolls`.
  it('a genuine ZERO overwrites a measured prior — it is a measurement, not an empty read', () => {
    const prior = [{ ...row('2026-08-22'), extPolls: 2010, extPollsRead: 'ok' as const, pluginPolls: { monitor: 1044, brief: 3 }, pluginPollsRead: 'ok' as const }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { extPolls: 0, extPollsRead: 'ok', pluginPolls: { monitor: 0, brief: 0 }, pluginPollsRead: 'ok' }))
    expect(out[0].extPolls).toBe(0)
    expect(out[0].pluginPolls).toEqual({ monitor: 0, brief: 0 })
  })

  // A pre-#1293 prior has NOTHING to restore, so the preserve branch must not fire and must not
  // invent a value. The re-run's honest `failed` stands. (The old version of this test asserted
  // `'extPolls' in prior[0] === false` — a property of its own fixture, which the spread makes
  // structurally impossible to violate; it could not have failed.)
  it('does not restore anything from a pre-#1293 prior that never carried the fields', () => {
    const prior = [row('2026-08-22')]
    const out = appendGrowthDaily(prior, row('2026-08-22', { extPolls: null, extPollsRead: 'failed', pluginPolls: null, pluginPollsRead: 'failed' }))
    expect(out[0].extPolls).toBeNull()
    expect(out[0].extPollsRead).toBe('failed')
    expect(out[0].pluginPolls).toBeNull()
    expect(out[0].pluginPollsRead).toBe('failed')
  })

  // The guard is `== null` on the re-run side, aimed at ITSELF: with `=== null` an absent field on the
  // re-run would skip the branch and silently drop a measured prior. Unreachable from
  // `buildGrowthDailyRow` today (it always writes both keys), which is exactly why it needs a test —
  // a guard whose default is "passes" proves nothing by being green.
  it('restores over a re-run whose field is ABSENT, not just explicitly null', () => {
    const prior = [{ ...row('2026-08-22'), extPolls: 2010, extPollsRead: 'ok' as const, pluginPolls: { monitor: 1044, brief: 3 }, pluginPollsRead: 'ok' as const }]
    const out = appendGrowthDaily(prior, row('2026-08-22'))
    expect(out[0].extPolls).toBe(2010)
    expect(out[0].extPollsRead).toBe('ok')
    expect(out[0].pluginPolls).toEqual({ monitor: 1044, brief: 3 })
  })

  // A prior that KV handed back corrupt must not be resurrected over an honest failure and filed as
  // measured. `isRow` only checks that `date` is a string, so these all reach `preserveMeasured`.
  // the inline note inside `isMeasuredFeedPolls` records this exact defect happening once already.
  it.each([
    ['a numeric string', '2010'],
    ['a negative count', -5],
    ['a non-finite count', Number.NaN],
    ['an object where a number belongs', { monitor: 1 }],
  ])('refuses to restore %s as a measured extPolls', (_label, corrupt) => {
    const prior = [{ ...row('2026-08-22'), extPolls: corrupt as never, extPollsRead: 'ok' as const }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { extPolls: null, extPollsRead: 'failed' }))
    expect(out[0].extPolls).toBeNull()
    expect(out[0].extPollsRead).toBe('failed')
  })

  it('refuses to restore a half-corrupt pluginPolls prior', () => {
    const prior = [{ ...row('2026-08-22'), pluginPolls: { monitor: null, brief: 3 } as never, pluginPollsRead: 'ok' as const }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { pluginPolls: null, pluginPollsRead: 'failed' }))
    // The harm is in the ROW, not the render: resurrecting this files a half-null count under verdict
    // `ok` in a key with no TTL and no repair path.
    expect(out[0].pluginPolls).toBeNull()
    expect(out[0].pluginPollsRead).toBe('failed')
  })

  // A restored value must never arrive under a verdict that contradicts it — including an ABSENT one,
  // which the field docs define as "this row predates the field".
  // #1293 Part F — the statusline branch of `preserveMeasured`. It shipped with NO coverage: deleting
  // the whole `if (row.statuslinePolls == null && ...)` block left the suite green, on the counter with
  // the most complex predicate (a nested `byPreset` record plus a sum invariant).
  const SL = { byPreset: { branded: 120, clickable: 45 }, serverRenderTotal: 165, legacyProxy: 3, total: 168 }

  it('restores a measured statusline prior over a failed re-run', () => {
    const prior = [{ ...row('2026-08-22'), statuslinePolls: SL, statuslinePollsRead: 'ok' as const }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { statuslinePolls: null, statuslinePollsRead: 'failed' }))
    expect(out[0].statuslinePolls).toEqual(SL)
    expect(out[0].statuslinePollsRead).toBe('ok')
  })

  it('lets a genuine statusline zero overwrite a measured prior, under the zero verdict', () => {
    const quiet = { byPreset: {}, serverRenderTotal: 0, legacyProxy: 0, total: 0 }
    const prior = [{ ...row('2026-08-22'), statuslinePolls: SL, statuslinePollsRead: 'ok' as const }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { statuslinePolls: quiet, statuslinePollsRead: 'zero' }))
    expect(out[0].statuslinePolls).toEqual(quiet)
    expect(out[0].statuslinePollsRead).toBe('zero')
  })

  it('re-derives a restored statusline zero as `zero`, never as `ok`', () => {
    // The prior is a measured all-quiet window. Restoring it must not upgrade it to `ok` — that is the
    // mutation a hardcoded verdict would reintroduce, and inside the operator-exclusion window it is
    // the difference between "nobody used it" and "we could not tell".
    const quiet = { byPreset: {}, serverRenderTotal: 0, legacyProxy: 0, total: 0 }
    const prior = [{ ...row('2026-08-22'), statuslinePolls: quiet, statuslinePollsRead: 'ok' as const }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { statuslinePolls: null, statuslinePollsRead: 'failed' }))
    expect(out[0].statuslinePolls).toEqual(quiet)
    expect(out[0].statuslinePollsRead).toBe('zero')
  })

  it.each([
    ['a desynced total', { byPreset: { branded: 500 }, serverRenderTotal: 500, legacyProxy: 0, total: 0 }],
    ['a byPreset that does not sum to serverRenderTotal', { byPreset: { branded: 1 }, serverRenderTotal: 500, legacyProxy: 0, total: 500 }],
    ['a non-numeric preset count', { byPreset: { branded: null }, serverRenderTotal: 0, legacyProxy: 0, total: 0 }],
    ['a negative component', { byPreset: {}, serverRenderTotal: -1, legacyProxy: 0, total: -1 }],
    ['a missing byPreset', { serverRenderTotal: 0, legacyProxy: 0, total: 0 }],
  ])('refuses to restore %s as a measured statusline prior', (_label, corrupt) => {
    // The desynced cases matter most: the verdict is keyed on `serverRenderTotal`, so a prior whose
    // components disagree with its totals could otherwise be restored AND relabelled `zero` while
    // carrying visible traffic.
    const prior = [{ ...row('2026-08-22'), statuslinePolls: corrupt as never, statuslinePollsRead: 'ok' as const }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { statuslinePolls: null, statuslinePollsRead: 'failed' }))
    expect(out[0].statuslinePolls).toBeNull()
    expect(out[0].statuslinePollsRead).toBe('failed')
  })

  it('re-derives the verdict on restore rather than copying a prior that carried none', () => {
    const prior = [{ ...row('2026-08-22'), extPolls: 2010 }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { extPolls: null, extPollsRead: 'failed' }))
    expect(out[0].extPolls).toBe(2010)
    expect(out[0].extPollsRead).toBe('ok')
  })

  // The DISCRIMINATING case for re-derivation, and the one the test above cannot see: a restored ZERO.
  // Hardcoding `'ok'` in the preserve branch reproduces the test above exactly, so only a zero prior
  // separates re-derivation from a hardcode — and inside the operator-exclusion window a restored zero
  // is the EXPECTED row, not an edge case. Filing it `ok` destroys the whole point of the `zero`
  // verdict, permanently, in a key with no backfill.
  it('re-derives a restored ext ZERO as `zero`, never as `ok`', () => {
    const prior = [{ ...row('2026-08-22'), extPolls: 0, extPollsRead: 'ok' as const }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { extPolls: null, extPollsRead: 'failed' }))
    expect(out[0].extPolls).toBe(0)
    expect(out[0].extPollsRead).toBe('zero')
  })

  it('re-derives a restored plugin monitor ZERO as `zero`, even when briefings are non-zero', () => {
    // Also pins the verdict KEY: `monitor` alone. A hardcode gives `ok`; keying on the pair would too,
    // because `brief: 3` is non-zero.
    const prior = [{ ...row('2026-08-22'), pluginPolls: { monitor: 0, brief: 3 }, pluginPollsRead: 'ok' as const }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { pluginPolls: null, pluginPollsRead: 'failed' }))
    expect(out[0].pluginPolls).toEqual({ monitor: 0, brief: 3 })
    expect(out[0].pluginPollsRead).toBe('zero')
  })

  it('keeps the re-run\'s verdict when the re-run is the one that measured', () => {
    // The mirror: preservation must not fire on a successful re-run and pin a stale verdict to a
    // fresh map. Without this, hard-coding `feedPollsRead: 'ok'` in the preserve branch would pass.
    const prior = [{ ...row('2026-08-22'), feedPolls: null, feedPollsRead: 'failed' as const }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { feedPolls: { claude: { slack: 99 } }, feedPollsRead: 'ok' }))
    expect(out[0].feedPolls).toEqual({ claude: { slack: 99 } })
    expect(out[0].feedPollsRead).toBe('ok')
  })

  it('a same-date re-run with a SUCCESSFUL read replaces the prior map', () => {
    const prior = [{ ...row('2026-08-22'), feedPolls: { claude: { slack: 72 } } }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { feedPolls: { claude: { slack: 99 } } }))
    expect(out[0].feedPolls).toEqual({ claude: { slack: 99 } })
  })

  // #1280 — the same catch-up path was destroying the AUDIENCE group, and the guard's docstring gave
  // a reason that was false for it: the audience fields do NOT read a TTL'd key. `queryOutageAudience`
  // reads the Analytics Engine SQL API and returns `null` on missing creds / non-OK HTTP / an
  // unparseable body — nothing expired, a request failed. The screen split is the most expensive value
  // in the row to lose: no other system holds it and this key has no TTL and no backfill.
  it('a same-date re-run with a FAILED audience read must not destroy the measured screen split', () => {
    const measured = {
      ...row('2026-08-22'),
      audienceTotal: 380, audienceActiveTotal: 78,
      audienceBySource: { x: 200, direct: 180 },
      audienceByScreen: { service: { claude: 300 }, group: { claude: 78 }, unknown: { openai: 2 } },
    }
    const out = appendGrowthDaily([measured], row('2026-08-22', {
      audienceTotal: null, audienceActiveTotal: null, audienceBySource: null, audienceByScreen: null,
    }))
    expect(out[0].audienceByScreen).toEqual({ service: { claude: 300 }, group: { claude: 78 }, unknown: { openai: 2 } })
    // The four travel as ONE group — carrying a subset would leave one run's totals beside another
    // run's breakdown, the same defect `feedPollsRead` travelling with its map exists to prevent.
    expect(out[0].audienceTotal).toBe(380)
    expect(out[0].audienceActiveTotal).toBe(78)
    expect(out[0].audienceBySource).toEqual({ x: 200, direct: 180 })
  })

  it('a SUCCESSFUL audience re-run still replaces the prior measurement', () => {
    // The mirror. Without it, preserving unconditionally would pin the first read of the day forever.
    const prior = [{ ...row('2026-08-22'), audienceTotal: 380, audienceByScreen: { service: { claude: 300 }, group: {}, unknown: {} } }]
    const out = appendGrowthDaily(prior, row('2026-08-22', {
      audienceTotal: 401, audienceByScreen: { service: { claude: 320 }, group: { claude: 81 }, unknown: {} },
    }))
    expect(out[0].audienceTotal).toBe(401)
    expect(out[0].audienceByScreen).toEqual({ service: { claude: 320 }, group: { claude: 81 }, unknown: {} })
  })

  it('a measured QUIET day is preserved, not mistaken for a failed read', () => {
    // `audienceTotal: 0` is a real measurement — AE returns `{data: []}` on a quiet window, which
    // parses to a zeroed object, never `null`. Discriminating on falsiness instead of nullishness
    // would throw the quiet day away and let the failed re-run's `null` win.
    const prior = [{ ...row('2026-08-22'), audienceTotal: 0, audienceActiveTotal: 0, audienceBySource: {}, audienceByScreen: { service: {}, group: {}, unknown: {} } }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { audienceTotal: null, audienceByScreen: null }))
    expect(out[0].audienceTotal).toBe(0)
    expect(out[0].audienceByScreen).toEqual({ service: {}, group: {}, unknown: {} })
  })

  it('a pre-#1280 prior keeps audienceByScreen ABSENT rather than turning it into a null', () => {
    // Absent means "no screen instrumentation existed then"; null means "the read failed". Carrying
    // the group from an old row must not convert the first into the second — that would claim a
    // failure on a day that never had the field.
    const prior = [{ ...row('2026-08-22'), audienceTotal: 40, audienceBySource: { x: 40 } }]
    delete (prior[0] as { audienceByScreen?: unknown }).audienceByScreen
    const out = appendGrowthDaily(prior, row('2026-08-22', { audienceTotal: null, audienceByScreen: null }))
    expect(out[0].audienceTotal).toBe(40)
    expect(out[0].audienceByScreen).toBeUndefined()
  })

  it('an EMPTY incoming map does not replace a measured one either', () => {
    // Defence in depth: `durableFeedPolls` no longer emits `{}`, so this input is unreachable from
    // production. `preserveMeasured` is pure and independently callable, and both ends go through
    // `isMeasuredFeedPolls` — `{}` is not a measurement on either side.
    const prior = [{ ...row('2026-08-22'), feedPolls: { claude: { slack: 72 } } }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { feedPolls: {} }))
    expect(out[0].feedPolls).toEqual({ claude: { slack: 72 } })
  })

  it('an EMPTY prior does not overwrite an honest failed read', () => {
    // The mirror of the case above. A guard built to stop a measurement being destroyed must not
    // destroy a correct failure record and replace it with a fabricated measured-zero.
    const prior = [{ ...row('2026-08-22'), feedPolls: {} }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { feedPolls: null }))
    expect(out[0].feedPolls).toBeNull()
  })

  it('does NOT resurrect a corrupt prior feedPolls value', () => {
    // `isRow` admits any object with a string `date`, so a stored `feedPolls` can be any shape. The
    // guard exists to stop a MEASUREMENT being destroyed, not to carry a non-object forward as one.
    for (const corrupt of ['{}', 42, [], true, {}]) {
      const prior = [{ ...row('2026-08-22'), feedPolls: corrupt as never }]
      const out = appendGrowthDaily(prior, row('2026-08-22', { feedPolls: null }))
      expect(out[0].feedPolls).toBeNull()
    }
  })

  it('preservation is scoped to feedPolls — the TTL-backed fields still take the re-run value', () => {
    // Those read keys that are gone by the next run, so a re-run's null IS the best available value.
    const prior = [{ ...row('2026-08-22'), referralTotal: 9, subscribers: 9 }]
    const out = appendGrowthDaily(prior, row('2026-08-22', { referralTotal: null, subscribers: null }))
    expect(out[0].referralTotal).toBeNull()
    expect(out[0].subscribers).toBeNull()
  })

  it('a row predating #1273 stays readable and does NOT gain a zero', async () => {
    // The deploy boundary: old rows have no `feedPolls` key at all. Reading that as 0 would
    // manufacture a step-up on the deploy date out of nothing.
    const stored = JSON.stringify([{ date: '2026-08-01', audienceTotal: 440 }])
    let written = ''
    const kv = { get: vi.fn().mockResolvedValue(stored), put: vi.fn(async (_k: string, v: string) => { written = v }) }
    await recordGrowthDaily(kv as never, row('2026-08-22', { feedPolls: { claude: { slack: 7 } } }))
    const rows = JSON.parse(written)
    expect(rows[0]).not.toHaveProperty('feedPolls')
    expect(rows[1].feedPolls).toEqual({ claude: { slack: 7 } })
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

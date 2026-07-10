import { describe, it, expect, vi } from 'vitest'
import {
  buildGrowthDailyRow,
  appendGrowthDaily,
  parseGrowthSeries,
  recordGrowthDaily,
  growthSeriesKey,
  periodOf,
  GROWTH_SERIES_CAP,
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

  // The axis MUST come from the `alert:count:{date}` daily accumulator. `result.newCount` counts only
  // the alerts sent by the one 5-minute cron cycle that fires the 09:00 UTC report, so an outage at
  // 04:00 would land here as `0` — the dataset would classify a real outage day as quiet, defeating
  // the single comparison it exists to make.
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

import { describe, it, expect, vi } from 'vitest'
import {
  classifyArchivedDay,
  archiveGapDates,
  dailyImpactHasDate,
  mergeArchivedDailyImpact,
  readArchivedWeightedOutageSec,
  restoreArchivedCalendar,
  ARCHIVE_CRITICAL_THRESHOLD_SEC,
  ARCHIVE_MAJOR_THRESHOLD_SEC,
} from '../uptime-archive'

describe('classifyArchivedDay (#1017)', () => {
  it('returns null for zero or negative seconds — a clean day', () => {
    expect(classifyArchivedDay(0)).toBeNull()
    expect(classifyArchivedDay(-5)).toBeNull()
  })

  it('returns minor for any positive amount under the major threshold', () => {
    expect(classifyArchivedDay(1)).toBe('minor')
    expect(classifyArchivedDay(ARCHIVE_MAJOR_THRESHOLD_SEC - 1)).toBe('minor')
  })

  it('returns major at/above the major threshold, below critical', () => {
    expect(classifyArchivedDay(ARCHIVE_MAJOR_THRESHOLD_SEC)).toBe('major')
    expect(classifyArchivedDay(ARCHIVE_CRITICAL_THRESHOLD_SEC - 1)).toBe('major')
  })

  it('returns critical at/above the critical threshold', () => {
    expect(classifyArchivedDay(ARCHIVE_CRITICAL_THRESHOLD_SEC)).toBe('critical')
    expect(classifyArchivedDay(86_400)).toBe('critical') // a full day
  })
})

describe('archiveGapDates (#1017)', () => {
  it('returns the dates strictly older than the live window, back to the calendar window', () => {
    // today=2026-07-25, calendarDays=30, uptimeWindowDays=6 → gap is days 6..29 back (24 dates)
    const dates = archiveGapDates({ todayISO: '2026-07-25', calendarDays: 30, uptimeWindowDays: 6 })
    expect(dates).toHaveLength(24)
    expect(dates[0]).toBe('2026-07-19') // 6 days back — the oldest day the live window does NOT cover
    expect(dates[dates.length - 1]).toBe('2026-06-26') // 29 days back
  })

  it('returns [] when the window already covers the full calendar', () => {
    expect(archiveGapDates({ todayISO: '2026-07-25', calendarDays: 30, uptimeWindowDays: 30 })).toEqual([])
    expect(archiveGapDates({ todayISO: '2026-07-25', calendarDays: 30, uptimeWindowDays: 31 })).toEqual([])
  })

  it('does not cross a month boundary incorrectly', () => {
    const dates = archiveGapDates({ todayISO: '2026-08-02', calendarDays: 5, uptimeWindowDays: 2 })
    expect(dates).toEqual(['2026-07-31', '2026-07-30', '2026-07-29'])
  })
})

describe('dailyImpactHasDate (#1017)', () => {
  it('matches a bare-date key exactly (Statuspage/Better Stack form)', () => {
    expect(dailyImpactHasDate({ '2026-07-19': 'major' }, '2026-07-19')).toBe(true)
    expect(dailyImpactHasDate({ '2026-07-19': 'major' }, '2026-07-20')).toBe(false)
  })

  it('matches a full-ISO-timestamp key by prefix (incident.io form, #693 follow-up)', () => {
    expect(dailyImpactHasDate({ '2026-07-19T14:23:00Z': 'critical' }, '2026-07-19')).toBe(true)
  })

  it('returns false for an undefined map', () => {
    expect(dailyImpactHasDate(undefined, '2026-07-19')).toBe(false)
  })
})

describe('mergeArchivedDailyImpact (#1017)', () => {
  it('adds archived days the live map has nothing for', () => {
    const merged = mergeArchivedDailyImpact({}, { '2026-07-19': ARCHIVE_CRITICAL_THRESHOLD_SEC })
    expect(merged).toEqual({ '2026-07-19': 'critical' })
  })

  it('NEVER overwrites a live entry, even if the archive disagrees', () => {
    const merged = mergeArchivedDailyImpact({ '2026-07-19': 'minor' }, { '2026-07-19': ARCHIVE_CRITICAL_THRESHOLD_SEC })
    expect(merged).toEqual({ '2026-07-19': 'minor' }) // live wins, archive's 'critical' is discarded
  })

  it('respects the ISO-prefix form when deciding what live already covers', () => {
    const merged = mergeArchivedDailyImpact({ '2026-07-19T09:00:00Z': 'major' }, { '2026-07-19': ARCHIVE_CRITICAL_THRESHOLD_SEC })
    expect(merged).toEqual({ '2026-07-19T09:00:00Z': 'major' }) // archive's day skipped, not added under a second key
  })

  it('a zero/negative archived value contributes no entry', () => {
    expect(mergeArchivedDailyImpact({}, { '2026-07-19': 0 })).toEqual({})
  })

  it('handles an undefined live map (a fully-blanked service)', () => {
    const merged = mergeArchivedDailyImpact(undefined, { '2026-07-19': ARCHIVE_MAJOR_THRESHOLD_SEC })
    expect(merged).toEqual({ '2026-07-19': 'major' })
  })
})

describe('readArchivedWeightedOutageSec (#1017)', () => {
  function makeKv(store: Record<string, string>): KVNamespace {
    return { get: async (k: string) => store[k] ?? null } as unknown as KVNamespace
  }

  it('extracts the service\'s weightedOutageSec for each date that has one', async () => {
    const kv = makeKv({
      'history:2026-07-19': JSON.stringify({ claude: { ok: 10, total: 10, weightedOutageSec: 3600 } }),
      'history:2026-07-20': JSON.stringify({ claude: { ok: 10, total: 10, weightedOutageSec: 0 } }),
    })
    const out = await readArchivedWeightedOutageSec(kv, 'claude', ['2026-07-19', '2026-07-20'])
    expect(out).toEqual({ '2026-07-19': 3600 }) // the 0-second day is correctly omitted
  })

  it('skips a date with no key at all (never archived / expired past 90d)', async () => {
    const kv = makeKv({})
    expect(await readArchivedWeightedOutageSec(kv, 'claude', ['2026-07-19'])).toEqual({})
  })

  it('skips a date where the service has no entry that day', async () => {
    const kv = makeKv({ 'history:2026-07-19': JSON.stringify({ openai: { ok: 10, total: 10 } }) })
    expect(await readArchivedWeightedOutageSec(kv, 'claude', ['2026-07-19'])).toEqual({})
  })

  it('best-effort: a corrupt value for ONE date does not block the others', async () => {
    const kv = makeKv({
      'history:2026-07-19': 'not json',
      'history:2026-07-20': JSON.stringify({ claude: { ok: 10, total: 10, weightedOutageSec: 1800 } }),
    })
    expect(await readArchivedWeightedOutageSec(kv, 'claude', ['2026-07-19', '2026-07-20'])).toEqual({ '2026-07-20': 1800 })
  })

  it('best-effort: a rejected kv.get for ONE date does not block the others', async () => {
    const kv = {
      get: async (k: string) => {
        if (k === 'history:2026-07-19') throw new Error('KV down')
        return JSON.stringify({ claude: { ok: 10, total: 10, weightedOutageSec: 1800 } })
      },
    } as unknown as KVNamespace
    expect(await readArchivedWeightedOutageSec(kv, 'claude', ['2026-07-19', '2026-07-20'])).toEqual({ '2026-07-20': 1800 })
  })
})

describe('restoreArchivedCalendar (#1017) — the orchestrator', () => {
  it('never touches KV when uptimeWindowDays is absent (the normal, common-path case)', async () => {
    const get = vi.fn()
    const kv = { get } as unknown as KVNamespace
    const result = await restoreArchivedCalendar(kv, { serviceId: 'claude', liveDailyImpact: { '2026-07-24': 'minor' }, calendarDays: 30, uptimeWindowDays: undefined, todayISO: '2026-07-25' })
    expect(result).toEqual({ '2026-07-24': 'minor' }) // unchanged
    expect(get).not.toHaveBeenCalled()
  })

  it('never touches KV when the window already covers the whole calendar', async () => {
    const get = vi.fn()
    const kv = { get } as unknown as KVNamespace
    const result = await restoreArchivedCalendar(kv, { serviceId: 'claude', liveDailyImpact: {}, calendarDays: 30, uptimeWindowDays: 30, todayISO: '2026-07-25' })
    expect(get).not.toHaveBeenCalled()
    expect(result).toEqual({})
  })

  // #1017 checklist — "a service whose live page blanked (migration) still renders its calendar
  // from the archive". Simulates exactly the #1004 Junie scenario: the live source only covers the
  // last 6 days (uptimeWindowDays=6, dailyImpact empty/sparse), but AIWatch's own archive has the
  // older days on file.
  it('restores a migrated service\'s blanked calendar from the archive', async () => {
    const store: Record<string, string> = {
      'history:2026-07-19': JSON.stringify({ claude: { ok: 10, total: 10, weightedOutageSec: ARCHIVE_CRITICAL_THRESHOLD_SEC } }),
      'history:2026-07-20': JSON.stringify({ claude: { ok: 10, total: 10, weightedOutageSec: 0 } }),
    }
    const kv = { get: async (k: string) => store[k] ?? null } as unknown as KVNamespace
    // Live dailyImpact is EMPTY — exactly the post-migration blank-calendar bug (#1004).
    const result = await restoreArchivedCalendar(kv, { serviceId: 'claude', liveDailyImpact: {}, calendarDays: 30, uptimeWindowDays: 6, todayISO: '2026-07-25' })
    expect(result).toEqual({ '2026-07-19': 'critical' }) // 2026-07-20's clean day contributes nothing
  })

  it('leaves a genuinely non-migrated day\'s live data alone even when the archive disagrees', async () => {
    const store: Record<string, string> = {
      'history:2026-07-19': JSON.stringify({ claude: { ok: 10, total: 10, weightedOutageSec: ARCHIVE_CRITICAL_THRESHOLD_SEC } }),
    }
    const kv = { get: async (k: string) => store[k] ?? null } as unknown as KVNamespace
    const result = await restoreArchivedCalendar(kv, { serviceId: 'claude', liveDailyImpact: { '2026-07-19': 'minor' }, calendarDays: 30, uptimeWindowDays: 6, todayISO: '2026-07-25' })
    expect(result).toEqual({ '2026-07-19': 'minor' }) // live wins
  })

  it('returns the SAME reference (no-op) when the archive has nothing for the gap — callers can skip a write', async () => {
    const kv = { get: async () => null } as unknown as KVNamespace
    const live = { '2026-07-24': 'minor' as const }
    const result = await restoreArchivedCalendar(kv, { serviceId: 'claude', liveDailyImpact: live, calendarDays: 30, uptimeWindowDays: 6, todayISO: '2026-07-25' })
    expect(result).toBe(live) // reference equality, not just deep equality
  })

  // #1017 checklist — "a restored window matches the pre-migration computation": the archive was
  // populated by cacheWrite folding in `s.todayWeightedOutageSec` (the SAME weightedDowntimeSeconds
  // call the live source's own dailyImpact would have used pre-migration). This pins that a day's
  // archived seconds reclassify to the SAME level a live source's own minor/major/critical
  // vocabulary would produce for a day of that severity — i.e. the restore is not just "some value",
  // it's the SAME classification the day would have carried before the migration erased it.
  it('reclassifies an archived day to the same severity a live source would have shown it as', async () => {
    // A 45-minute (2700s) weighted outage is comfortably in the 'major' band (30min-4h) every live
    // source already uses for a partial/degraded-dominant day — not 'minor' (a token blip) or
    // 'critical' (a near-total-loss day).
    const store = { 'history:2026-07-19': JSON.stringify({ claude: { ok: 10, total: 10, weightedOutageSec: 2700 } }) }
    const kv = { get: async (k: string) => (store as Record<string, string>)[k] ?? null } as unknown as KVNamespace
    const result = await restoreArchivedCalendar(kv, { serviceId: 'claude', liveDailyImpact: {}, calendarDays: 30, uptimeWindowDays: 6, todayISO: '2026-07-25' })
    expect(result).toEqual({ '2026-07-19': 'major' })
  })
})

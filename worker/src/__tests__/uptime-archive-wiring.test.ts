import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { restoreArchivedCalendars } from '../index'
import type { ServiceStatus } from '../services'

// #1017 — mocks the ONE collaborator restoreArchivedCalendars calls (uptime-archive.ts's
// restoreArchivedCalendar), so one service's failure can be forced deterministically. A real KV
// failure can't reach this far in practice — every internal layer (readArchivedWeightedOutageSec's
// per-date try/catch) already swallows KV/parse errors — so this is the only realistic way to exercise
// the isolation boundary AT RUNTIME rather than only proving via source-scan that the try/catch exists.
vi.mock('../uptime-archive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../uptime-archive')>()
  return {
    ...actual,
    restoreArchivedCalendar: vi.fn(async (_kv: unknown, args: { serviceId: string; liveDailyImpact: unknown }) => {
      if (args.serviceId === 'broken') throw new Error('simulated restore failure')
      const live = { ...(args.liveDailyImpact as Record<string, string>) }
      // #1017 follow-up — the ONLY branch that can return a NON-superset. Without it no test can
      // distinguish the set difference from the `after - before` count it replaced, and the comment
      // defending that choice is unenforceable.
      if (args.serviceId === 'pruning') { delete live['2026-07-24']; return { ...live, '2026-07-19': 'critical' } }
      return { ...live, '2026-07-19': 'critical' }
    }),
  }
})

// #1017 — source-scan wiring guard, in the repo's sync-test idiom (badge-wiring.test.ts /
// badge-repo-discovery-wiring.test.ts / ai-usage-wiring.test.ts).
//
// Two sibling PRs in the same session (#1157, #1158) each shipped a real bug where a computed value
// was silently never threaded into its actual production call site — invisible to every test because
// each test called the pure function directly with a hand-built literal rather than exercising the
// real call site in index.ts. A review agent proved BOTH gaps here too via mutation testing: DELETING
// `counters[s.id].weightedOutageSec = s.todayWeightedOutageSec ?? null` (index.ts:228) and
// `if (restored !== s.dailyImpact) s.dailyImpact = restored` (index.ts:242) each independently left the
// full 3724-test suite green. These two tests close that gap. Verified by hand via DELETION, not
// commenting-out — these are source-scan regex tests, so a commented-out line still matches the regex
// and would NOT go red; only removing the line proves the guard works.
const SRC = join(__dirname, '..')
const index = readFileSync(join(SRC, 'index.ts'), 'utf8')
const services = readFileSync(join(SRC, 'services.ts'), 'utf8')

// #1017 — a review agent independently mutated all 8 threading points across services.ts (the
// ServiceStatus-assembly sites for Flashduty / the shared Statuspage+incident.io branch / OnlineOrNot
// / Instatus×2) and confirmed the full 3724-test suite stayed green with `todayWeightedOutageSec`
// silently dropped from every one of them. This guards the 5 FINAL write sites (where the field
// actually lands on the returned ServiceStatus, as opposed to the intermediate local-variable
// assignments feeding them).
describe('#1017 — services.ts threading of todayWeightedOutageSec onto ServiceStatus', () => {
  it('Flashduty', () => {
    expect(services).toMatch(/todayWeightedOutageSec: parsed\.flashdutyUptime\.todayWeightedOutageSec/)
  })

  it('the shared Statuspage-API + incident.io branch', () => {
    expect(services).toMatch(/\.\.\.\(todayWeightedOutageSec != null \? \{ todayWeightedOutageSec \} : \{\}\)/)
  })

  it('OnlineOrNot', () => {
    expect(services).toMatch(/base\.todayWeightedOutageSec = page\.todayWeightedOutageSec/)
  })

  it('Instatus — both return sites (the parse-failure carryover AND the success path)', () => {
    const matches = services.match(/\.\.\.\(instatusTodayWeightedOutageSec != null \? \{ todayWeightedOutageSec: instatusTodayWeightedOutageSec \} : \{\}\)/g)
    expect(matches?.length).toBe(2)
  })
})

describe('#1017 — cacheWrite wiring for the durable per-day archive', () => {
  it('folds todayWeightedOutageSec into the daily:{date} counter (rides the existing write, +0 new KV writes)', () => {
    expect(index).toMatch(/counters\[s\.id\]\.weightedOutageSec\s*=\s*s\.todayWeightedOutageSec\s*\?\?\s*null/)
  })

  it('assigns the restored dailyImpact back onto the service before CACHE_KEY is serialized', () => {
    expect(index).toMatch(/if \(restored !== s\.dailyImpact\) s\.dailyImpact = restored/)
  })
})

describe('#1017 — restoreArchivedCalendars isolation, exercised at runtime (not just source-scan)', () => {
  it('one service throwing does not block another service\'s dailyImpact from being restored', async () => {
    const services = [
      { id: 'broken', dailyImpact: { '2026-07-24': 'minor' } },
      { id: 'ok-service', dailyImpact: {} },
    ] as unknown as ServiceStatus[]
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await restoreArchivedCalendars({} as KVNamespace, services, '2026-07-25T12:00:00.000Z')

    // The failing service's dailyImpact is untouched (not corrupted, not left half-written) —
    // the whole batch did not abort because of it.
    expect(services[0].dailyImpact).toEqual({ '2026-07-24': 'minor' })
    // The healthy service still got restored despite its sibling throwing.
    expect(services[1].dailyImpact).toEqual({ '2026-07-19': 'critical' })
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[uptime-archive] restore failed for broken'),
      expect.anything(),
    )
    errorSpy.mockRestore()
  })
})

// #1017 follow-up — the durable restore trace (`uptime-archive:restored`). Exercised through the REAL
// call path (restoreArchivedCalendars -> recordRestoreObservations -> kv.put), not by calling the pure
// fold with a hand-built literal: the failure this whole file exists to prevent is a computed value
// that is never threaded into production, and a trace that is never written is precisely that bug
// wearing the costume of the fix.
describe('#1017 follow-up — the durable restore trace is written from the real call path', () => {
  const NOW = '2026-07-25T12:00:00.000Z'
  const traceKV = () => {
    const put = vi.fn(async (_k: string, _v: string) => {})
    const get = vi.fn(async (_k: string) => null as string | null)
    return { kv: { get, put } as unknown as KVNamespace, get, put }
  }
  const written = (put: ReturnType<typeof traceKV>['put']) => JSON.parse(put.mock.calls[0][1])

  it('records ONLY eligible services, with the days actually merged, at the kv.put boundary', async () => {
    // The eligible service starts with a NON-EMPTY calendar — a real short-window service has one, and
    // an empty fixture makes a set-difference indistinguishable from an absolute key count.
    const services = [
      { id: 'shortwin', dailyImpact: { '2026-07-24': 'minor' }, calendarDays: 30, uptimeWindowDays: 14 },
      { id: 'fullwin', dailyImpact: {}, calendarDays: 30 },
    ] as unknown as ServiceStatus[]
    const { kv, put } = traceKV()

    await restoreArchivedCalendars(kv, services, NOW)

    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0][0]).toBe('uptime-archive:restored') // the literal, not the constant
    const trace = written(put)
    // The full-window service leaves NO key at all — that is what keeps "absent" meaning
    // "never eligible" rather than "eligible but restored nothing".
    expect(Object.keys(trace)).toEqual(['shortwin'])
    expect(trace.shortwin.firstRestoredAt).toBe(NOW)
    expect(trace.shortwin.uptimeWindowDays).toBe(14)
    // ONE day added by the mocked restore, on top of the one live day already present.
    expect(trace.shortwin.maxDaysRestored).toBe(1)
  })

  it('reads and writes the SAME key', async () => {
    const services = [{ id: 'shortwin', dailyImpact: {}, calendarDays: 30, uptimeWindowDays: 14 }] as unknown as ServiceStatus[]
    const { kv, get, put } = traceKV()
    await restoreArchivedCalendars(kv, services, NOW)
    // A read key that drifts from the write key makes every read return null, so each cycle would
    // silently replace the whole permanent trace with only the current cycle's services.
    expect(get).toHaveBeenCalledWith('uptime-archive:restored')
    expect(put.mock.calls[0][0]).toBe(get.mock.calls[0][0])
  })

  it('records an eligible service whose restore THROWS, as restored-nothing rather than absent', async () => {
    // 'broken' makes the mocked restoreArchivedCalendar throw. Without the eligibility push sitting
    // outside the try, this service would leave no key and read as "never eligible" forever while the
    // restore path was in fact broken for it — the exact conflation this instrument removes.
    const services = [{ id: 'broken', dailyImpact: {}, calendarDays: 30, uptimeWindowDays: 14 }] as unknown as ServiceStatus[]
    const { kv, put } = traceKV()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await restoreArchivedCalendars(kv, services, NOW)

    const trace = written(put)
    expect(trace.broken.firstEligibleAt).toBe(NOW)
    expect(trace.broken.firstRestoredAt).toBeNull()
    expect(trace.broken.maxDaysRestored).toBe(0)
    errorSpy.mockRestore()
  })

  it('records daysRestored 0 for an eligible service the archive adds nothing to', async () => {
    // langsmith's real state for weeks: eligible, but every archived gap day was weightedOutageSec 0.
    // The mocked restore adds '2026-07-19', which this service already has, so nothing is new.
    const services = [{ id: 'nothing-to-add', dailyImpact: { '2026-07-19': 'critical' }, calendarDays: 30, uptimeWindowDays: 14 }] as unknown as ServiceStatus[]
    const { kv, put } = traceKV()

    await restoreArchivedCalendars(kv, services, NOW)

    const trace = written(put)
    expect(trace['nothing-to-add'].firstRestoredAt).toBeNull()
    expect(trace['nothing-to-add'].lastRestoredDate).toBeNull()
    expect(trace['nothing-to-add'].maxDaysRestored).toBe(0)
  })

  it('issues ONE merged write for several eligible services, not one per service', async () => {
    const services = [
      { id: 'a', dailyImpact: {}, calendarDays: 30, uptimeWindowDays: 14 },
      { id: 'b', dailyImpact: {}, calendarDays: 30, uptimeWindowDays: 7 },
    ] as unknown as ServiceStatus[]
    const { kv, put } = traceKV()

    await restoreArchivedCalendars(kv, services, NOW)

    expect(put).toHaveBeenCalledTimes(1)
    expect(Object.keys(written(put)).sort()).toEqual(['a', 'b'])
  })

  it('falls back to a 30-day calendar when the service declares none', async () => {
    // uptimeWindowDays 14 is eligible only because calendarDays defaults to 30.
    const services = [{ id: 'nocal', dailyImpact: {}, uptimeWindowDays: 14 }] as unknown as ServiceStatus[]
    const { kv, put } = traceKV()
    await restoreArchivedCalendars(kv, services, NOW)
    expect(Object.keys(written(put))).toEqual(['nocal'])
  })


  it('counts only ADDED days when the merge also removes one (set difference, not a count delta)', async () => {
    // `after - before` yields 0 here; the set difference yields 1. Nothing else in the suite can
    // separate them, because every other mock branch returns a guaranteed superset.
    const services = [{ id: 'pruning', dailyImpact: { '2026-07-24': 'minor' }, calendarDays: 30, uptimeWindowDays: 14 }] as unknown as ServiceStatus[]
    const { kv, put } = traceKV()
    await restoreArchivedCalendars(kv, services, NOW)
    expect(written(put).pruning.maxDaysRestored).toBe(1)
  })

  it('passes a DATE, not the full timestamp, to the restore (archiveGapDates interpolates it)', async () => {
    // `archiveGapDates` builds `${todayISO}T00:00:00Z`. A full ISO string makes an Invalid Date whose
    // toISOString() throws, killing the restore for every eligible service — silently, since the
    // per-service catch swallows it, and the trace then records everyone as restored-nothing.
    const services = [{ id: 'shortwin', dailyImpact: {}, calendarDays: 30, uptimeWindowDays: 14 }] as unknown as ServiceStatus[]
    await restoreArchivedCalendars(traceKV().kv, services, NOW)
    const { restoreArchivedCalendar } = await import('../uptime-archive')
    expect(restoreArchivedCalendar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ todayISO: '2026-07-25' }),
    )
  })

  it('defaults calendarDays to exactly 30 — pinned from BOTH sides', async () => {
    // Asserting only that a 14-day window is eligible constrains the default to >= 15, not to 30.
    // The 29/30 pair is what fixes it: 29 must be eligible and 30 must not.
    const services = [
      { id: 'just-under', dailyImpact: {}, uptimeWindowDays: 29 },
      { id: 'exactly-at', dailyImpact: {}, uptimeWindowDays: 30 },
    ] as unknown as ServiceStatus[]
    const { kv, put } = traceKV()
    await restoreArchivedCalendars(kv, services, NOW)
    expect(Object.keys(written(put))).toEqual(['just-under'])
  })

  it('records a FAILED restore distinctly from a clean archive', async () => {
    const services = [{ id: 'broken', dailyImpact: {}, calendarDays: 30, uptimeWindowDays: 14 }] as unknown as ServiceStatus[]
    const { kv, put } = traceKV()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await restoreArchivedCalendars(kv, services, NOW)
    expect(written(put).broken.lastRestoreErrorDate).toBe('2026-07-25')
    errorSpy.mockRestore()
  })

  it('touches KV not at all when no service is eligible (the production state on 2026-08-25)', async () => {
    const services = [{ id: 'fullwin', dailyImpact: {}, calendarDays: 30 }] as unknown as ServiceStatus[]
    const { kv, get, put } = traceKV()

    await restoreArchivedCalendars(kv, services, NOW)

    expect(get).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })
})

describe('#1017 follow-up — the production call site itself', () => {
  it('cacheWrite still calls restoreArchivedCalendars, with the timestamp (not the day string)', () => {
    // The other source-scan guards in this file match the function DEFINITION, so deleting this call
    // outright left the full 4662-test suite green — the exact "computed but never threaded" defect
    // this file was created for, at the one seam that matters most. Passing `today` instead of
    // `nowISO` also type-checks and silently degrades both `first*` stamps to a bare date.
    expect(index).toMatch(/await restoreArchivedCalendars\(kv, services, nowISO\)/)
  })

  it('awaits the trace write rather than leaving it floating', () => {
    // An un-awaited KV write can be dropped once the handler settles, and this key may get its single
    // write opportunity in a year. A fake KV resolves on the next microtask, so no runtime assertion
    // in this file can tell `await` from `void`.
    expect(index).toMatch(/await recordRestoreObservations\(/)
  })
})

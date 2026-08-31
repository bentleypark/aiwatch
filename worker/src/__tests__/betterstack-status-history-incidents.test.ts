// #1292 — incidents synthesized from BetterStack `index.json` status_history.
//
// Fixtures are REAL production shapes captured from the live status pages on 2026-08-28, and the two
// helicone cases are pinned against what AIWatch actually recorded from the RSS feed back when the
// feed still published monitor events — so these assert the reconstruction against ground truth, not
// against the implementation's own output.
import { describe, it, expect, vi } from 'vitest'
import {
  parseBetterStackDowntimeIncidents,
  resolveBetterStackTimeZone,
  zonedDayStartMs,
  zonedDayOf,
  parseBetterStackUptime,
  parseBetterStackDailyImpact,
  BS_HISTORY_MIN_DOWNTIME_SEC,
  type BetterStackIndex,
} from '../parsers/betterstack'

function page(timezone: string, resources: Array<{
  id: string; name: string; status?: string; days: Array<[string, number]>; section?: string
}>, sections: Array<{ id: string; name: string }> = []): BetterStackIndex {
  return {
    data: { attributes: { aggregate_state: 'operational', timezone } },
    included: [
      ...sections.map((s) => ({ type: 'status_page_section', id: s.id, attributes: { name: s.name } })),
      ...resources.map((r) => ({
        type: 'status_page_resource',
        id: r.id,
        attributes: {
          public_name: r.name,
          status: r.status ?? 'operational',
          ...(r.section ? { status_page_section_id: r.section } : {}),
          status_history: r.days.map(([day, sec]) => ({
            day, status: sec > 0 ? 'downtime' : 'operational',
            downtime_duration: sec, maintenance_duration: 0,
          })),
        },
      })),
    ],
  }
}

const NOW = Date.parse('2026-08-28T13:00:00Z')

describe('resolveBetterStackTimeZone', () => {
  // workerd THROWS `Invalid time zone specified` on the Rails names — verified in wrangler dev.
  // Three of the five BetterStack services we consume publish one, so this map is load-bearing.
  it.each([
    ['Pacific Time (US & Canada)', 'America/Los_Angeles'],
    ['Eastern Time (US & Canada)', 'America/New_York'],
    ['Central Time (US & Canada)', 'America/Chicago'],
    ['Mountain Time (US & Canada)', 'America/Denver'],
  ])('maps the Rails name %s → %s', (rails, iana) => {
    expect(resolveBetterStackTimeZone(rails)).toEqual({ tz: iana })
  })

  it('passes an IANA id through', () => {
    expect(resolveBetterStackTimeZone('America/Adak')).toEqual({ tz: 'America/Adak' })
  })

  it.each([undefined, '', '   ', 'UTC', 'gmt'])('resolves %p to UTC', (tz) => {
    expect(resolveBetterStackTimeZone(tz)).toEqual({ tz: 'UTC' })
  })

  it('falls back to UTC on an unknown zone instead of throwing', () => {
    expect(resolveBetterStackTimeZone('Middle-earth/Shire')).toEqual({ tz: 'UTC' })
  })

  it('maps the BARE-CITY Rails names too — ICU rejects those, so they are the common case worldwide', () => {
    // Rails names most of the world as a city; every one of these throws under ICU, so without the
    // table a European or Asian status page silently computes its day boundaries in UTC.
    for (const city of ['Berlin', 'London', 'Paris', 'Tokyo', 'Seoul', 'Sydney', 'Mexico City']) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: city }),
        `${city} is expected to be rejected by ICU`).toThrow()
      const { tz } = resolveBetterStackTimeZone(city)
      expect(tz, `${city} must resolve via the alias table, not fall back to UTC`).not.toBe('UTC')
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow()
    }
  })

  it('the Rails spelling ICU rejects is exactly what the alias table exists for', () => {
    // The claim the map is justified by, asserted rather than only stated in a comment.
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: 'Pacific Time (US & Canada)' })).toThrow()
  })

  it('every alias it returns is accepted by the runtime', () => {
    for (const rails of ['Pacific Time (US & Canada)', 'Eastern Time (US & Canada)',
      'Central Time (US & Canada)', 'Mountain Time (US & Canada)', 'Atlantic Time (Canada)',
      'Alaska', 'Hawaii', 'Arizona', 'Newfoundland']) {
      const { tz } = resolveBetterStackTimeZone(rails)
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow()
    }
  })
})

describe('zonedDayStartMs', () => {
  it('resolves local midnight, DST included', () => {
    // Adak is UTC-9 in July (HDT) and UTC-10 in January (HST) — the offset must follow the date.
    expect(new Date(zonedDayStartMs('2026-07-03', 'America/Adak')).toISOString()).toBe('2026-07-03T09:00:00.000Z')
    expect(new Date(zonedDayStartMs('2026-01-03', 'America/Adak')).toISOString()).toBe('2026-01-03T10:00:00.000Z')
    expect(new Date(zonedDayStartMs('2026-07-03', 'UTC')).toISOString()).toBe('2026-07-03T00:00:00.000Z')
  })

  it('lands on the right local day across an ordinary DST transition', () => {
    // Los Angeles springs forward at 02:00 and falls back at 02:00, so midnight exists on both days.
    for (const day of ['2026-03-08', '2026-11-01']) {
      expect(zonedDayOf(zonedDayStartMs(day, 'America/Los_Angeles'), 'America/Los_Angeles')).toBe(day)
    }
  })

  it('returns the first REAL instant when local midnight does not exist', () => {
    // Santiago and Havana spring forward AT midnight — 00:00 is skipped entirely that day. Correcting
    // by the post-transition offset lands on 23:00 of the PREVIOUS day, which buckets an incident
    // under the wrong affectedDays. Both are reachable through RAILS_ZONE_ALIASES.
    for (const [day, tz] of [['2026-09-06', 'America/Santiago'], ['2026-03-08', 'America/Havana']] as const) {
      const start = zonedDayStartMs(day, tz)
      expect(zonedDayOf(start, tz), `${tz} ${day} must stay on its own local day`).toBe(day)
    }
  })
})

describe('parseBetterStackDowntimeIncidents — one incident per downtime day', () => {
  it('emits helicone eu.api July as three day-sized incidents, summing to the real outage', () => {
    // AIWatch recorded this from the feed at the time as ONE incident, 2026-07-02T18:11Z →
    // 2026-07-05T06:04Z, 59h 53m. Joining days would reproduce that to the minute — and did, until
    // the id that had to key on the run's extent renamed itself in production three rounds running.
    // Per-day trades that boundary precision for an id derived from one immutable row.
    const inc = parseBetterStackDowntimeIncidents(page('America/Adak', [{
      id: '8603734', name: 'eu.api.helicone.ai',
      days: [['2026-07-02', 53295.756718], ['2026-07-03', 86400.0], ['2026-07-04', 75875.28217]],
    }]), { now: Date.parse('2026-07-06T12:00:00Z') })

    expect(inc.map((i) => i.id)).toEqual([
      'bs-hist:8603734:2026-07-04', 'bs-hist:8603734:2026-07-03', 'bs-hist:8603734:2026-07-02',
    ])
    // Total downtime is preserved exactly; only the window boundaries are given up.
    const totalSec = inc.reduce((a, i) => a + (Date.parse(i.resolvedAt!) - Date.parse(i.startedAt)) / 1000, 0)
    expect(Math.round(totalSec)).toBe(Math.round(53295.756718 + 86400.0 + 75875.28217))
    // Anchored at LOCAL noon (21:00Z for Adak, which is UTC-10) — the placement we do not have.
    expect(inc.every((i) => i.startedAt.slice(11, 16) === '21:00')).toBe(true)
    expect(inc.every((i) => i.derived === 'status_history' && i.status === 'resolved')).toBe(true)
  })

  it('gives each day its OWN duration, never a multi-day span', () => {
    // The span bug this structurally cannot have: [FULL, 2h, FULL] used to join and bill 72h for 50h
    // of recorded downtime, straight into computeMttrHours and the archive's totalMinutes.
    const inc = parseBetterStackDowntimeIncidents(page('UTC', [{
      id: '1', name: 'api', days: [['2026-08-10', 86400], ['2026-08-11', 7200], ['2026-08-12', 86400]],
    }]), { now: Date.parse('2026-08-14T12:00:00Z') })

    expect(inc.map((i) => i.duration)).toEqual(['24h 0m', '2h 0m', '24h 0m'])
  })
})

describe('parseBetterStackDowntimeIncidents — id invariance', () => {
  // Three inputs moved a run's extent in review, and every id derived from one renamed itself:
  // the trailing window, the day that had not closed yet, and the RSS claim set. A per-day id is a
  // function of one closed row, so all three are inert. `incidents:monthly` accumulates BY id — a
  // rename banks the same outage twice, and a vanished id is announced as a provider withdrawal.
  const DAYS: Array<[string, number]> = [['2026-08-08', 86400], ['2026-08-09', 86400], ['2026-08-10', 3600]]
  const idsWith = (o: Parameters<typeof parseBetterStackDowntimeIncidents>[1]) =>
    parseBetterStackDowntimeIncidents(page('UTC', [{ id: '7', name: 'api', days: DAYS }]), o)
      .map((i) => i.id).sort()

  it('is unmoved by the trailing window shrinking', () => {
    const wide = idsWith({ now: Date.parse('2026-08-11T12:00:00Z'), windowDays: 30 })
    expect(wide).toEqual(['bs-hist:7:2026-08-08', 'bs-hist:7:2026-08-09', 'bs-hist:7:2026-08-10'])
    // A narrower window drops OLD days; it never renames the ones that remain.
    expect(idsWith({ now: Date.parse('2026-08-11T12:00:00Z'), windowDays: 2 }))
      .toEqual(['bs-hist:7:2026-08-09', 'bs-hist:7:2026-08-10'])
  })

  it('is unmoved by a day closing on the next cron day', () => {
    // 08-10 is still accruing on the 10th and closed on the 11th. The days already published keep
    // their ids; only a new one appears.
    expect(idsWith({ now: Date.parse('2026-08-10T18:00:00Z') }))
      .toEqual(['bs-hist:7:2026-08-08', 'bs-hist:7:2026-08-09'])
    expect(idsWith({ now: Date.parse('2026-08-11T18:00:00Z') }))
      .toEqual(['bs-hist:7:2026-08-08', 'bs-hist:7:2026-08-09', 'bs-hist:7:2026-08-10'])
  })

  it('is unmoved when the RSS claim set changes under it', () => {
    // A provider posting a report for an already-synthesized day used to re-cut the run and rename
    // its neighbours. Here the claimed day simply drops out; the rest keep their ids.
    const now = Date.parse('2026-08-11T12:00:00Z')
    expect(idsWith({ now, isClaimed: (_r, d) => d === '2026-08-08' }))
      .toEqual(['bs-hist:7:2026-08-09', 'bs-hist:7:2026-08-10'])
    expect(idsWith({ now })).toContain('bs-hist:7:2026-08-09')
  })
})

describe('parseBetterStackDowntimeIncidents — behaviour', () => {
  it('drops sub-threshold flaps, aligned with the calendar floor', () => {
    const days: Array<[string, number]> = [
      ['2026-08-17', 42.7],                            // 43s — a monitor flap
      ['2026-08-19', BS_HISTORY_MIN_DOWNTIME_SEC - 1],
      ['2026-08-21', BS_HISTORY_MIN_DOWNTIME_SEC],     // exactly at the floor → kept
    ]
    const incidents = parseBetterStackDowntimeIncidents(page('UTC', [{ id: '1', name: 'api', days }]), { now: NOW })
    expect(incidents.map((i) => i.startedAt.slice(0, 10))).toEqual(['2026-08-21'])
  })

  it('excludes a maintenance day even when its maintenance_duration is not set', () => {
    // Two independent guards cover maintenance — the STATUS, and downtime being dominated by
    // maintenance seconds. A fixture that trips both leaves either one deletable; this trips only the
    // status branch, so removing it cannot pass.
    const data = page('UTC', [{ id: '1', name: 'api', days: [['2026-08-10', 7200]] }])
    data.included![0].attributes!.status_history![0].status = 'maintenance'
    expect(parseBetterStackDowntimeIncidents(data, { now: NOW })).toEqual([])
  })

  it('excludes announced maintenance, matching the INCIDENT path (not the uptime path)', () => {
    // `parseRssIncidents` drops maintenance titles and services.ts drops `report_type: 'maintenance'`,
    // so incidents have never carried maintenance. `parseBetterStackUptime` and the calendar DO count
    // such a day — asserted below so the divergence is recorded rather than assumed away.
    const data = page('UTC', [{ id: '1', name: 'api', days: [['2026-08-10', 7200]] }])
    data.included![0].attributes!.status_history![0].status = 'maintenance'
    data.included![0].attributes!.status_history![0].maintenance_duration = 7200
    expect(parseBetterStackDowntimeIncidents(data, { now: NOW })).toEqual([])
    // The divergence, asserted rather than described: the same payload still costs uptime and still
    // reddens the calendar. An earlier comment here claimed the uptime path excluded it too; it does
    // not, and nothing would have caught that because nothing called it.
    expect(parseBetterStackUptime(data)).toBeLessThan(100)
    expect(parseBetterStackDailyImpact(data)).not.toBeNull()
  })

  it('honours componentDenylist by resource name and by section label', () => {
    const data = page('UTC', [
      { id: '1', name: 'Website', days: [['2026-08-10', 7200]] },
      { id: '2', name: 'api', days: [['2026-08-10', 7200]], section: 's1' },
      { id: '3', name: 'docs', days: [['2026-08-10', 7200]], section: 's2' },
    ], [{ id: 's1', name: 'APIs' }, { id: 's2', name: 'Marketing' }])
    const incidents = parseBetterStackDowntimeIncidents(data, { denylist: ['Website', 'Marketing'], now: NOW })
    expect(incidents.map((i) => i.componentNames?.[0])).toEqual(['api'])
  })

  it('skips not_monitored days', () => {
    const data = page('UTC', [{ id: '1', name: 'api', days: [['2026-08-10', 7200]] }])
    data.included![0].attributes!.status_history![0].status = 'not_monitored'
    expect(parseBetterStackDowntimeIncidents(data, { now: NOW })).toHaveLength(0)
  })

  it('skips a malformed day row instead of failing the whole page', () => {
    // `new Date(NaN).toISOString()` throws, which would surface as a fetch failure for the service.
    const data = page('UTC', [{ id: '1', name: 'api', days: [['not-a-date', 7200], ['2026-08-10', 7200]] }])
    const incidents = parseBetterStackDowntimeIncidents(data, { now: NOW })
    expect(incidents.map((i) => i.startedAt.slice(0, 10))).toEqual(['2026-08-10'])
  })

  it('bounds the emitted set by the WINDOW, keeping the newest days', () => {
    // The bound is the trailing window, not a row count. An earlier revision capped at 20 ROWS "like
    // the feed path it stands in for" — see MAX_SYNTHESIZED_INCIDENTS for why that unit was wrong.
    const days: Array<[string, number]> = Array.from({ length: 25 }, (_, i) => [
      `2026-08-${String(i + 1).padStart(2, '0')}`, 3600 + i,
    ])
    const incidents = parseBetterStackDowntimeIncidents(
      page('UTC', [{ id: '1', name: 'api', days }]), { now: Date.parse('2026-08-27T12:00:00Z') })

    // 08-01 .. 08-25, minus the still-accruing 08-26/08-27 (absent here) — every day in the window.
    expect(incidents).toHaveLength(25)
    expect(incidents[0].derivedDay, 'newest first').toBe('2026-08-25')
    expect(incidents.at(-1)!.derivedDay, 'oldest kept — nothing inside the window is dropped').toBe('2026-08-01')
  })

  it('drops days that fall OUTSIDE the window, oldest-first', () => {
    const days: Array<[string, number]> = Array.from({ length: 60 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10)
      return [d, 3600]
    })
    const incidents = parseBetterStackDowntimeIncidents(
      page('UTC', [{ id: '1', name: 'api', days }]), { now: Date.parse('2026-07-25T12:00:00Z'), windowDays: 30 })

    expect(incidents.every((i) => i.derivedDay! >= '2026-06-25'), 'nothing older than the window').toBe(true)
    expect(incidents.every((i) => i.derivedDay! < '2026-07-25'), 'nothing from the accruing day on').toBe(true)
  })

  it.each([
    'Berlin', 'Tokyo', 'Seoul', 'Eastern Time (US & Canada)', 'Pacific Time (US & Canada)',
    'America/Adak', 'UTC', 'Auckland', 'Fiji',
  ])('states the page-local day in derivedDay, whichever zone the page is in (%s)', (tz) => {
    // The day is the one fact this synthesis states exactly, and the consumers that need it slice in
    // four different zones: score.ts takes the UTC date for affectedDays, the accumulator matches a UTC
    // month prefix, the SPA formats in the VIEWER's zone, the Edge template in UTC. No single instant
    // satisfies all four, so the day travels as its own field and they read THAT.
    const day = '2026-08-15'
    const incidents = parseBetterStackDowntimeIncidents(
      page(tz, [{ id: '1', name: 'api', days: [[day, 7200]] }]),
      { now: Date.parse('2026-08-20T12:00:00Z') })

    expect(incidents).toHaveLength(1)
    expect(incidents[0].derivedDay, `${tz}: derivedDay must be the page's own day`).toBe(day)
    expect(incidents[0].id).toBe(`bs-hist:1:${day}`)
  })

  it('the ANCHOR alone cannot carry the day — which is why the field exists', () => {
    // Auckland in JANUARY is the counter-example: NZDT is UTC+13, so local noon is 23:00Z the PREVIOUS
    // day and any consumer reading the date off `startedAt` gets 01-14 for an 01-15 downtime bucket.
    // An earlier revision asserted "the UTC date equals the page's own day" over a zone list that
    // happened to stop at UTC+11 — true of every row it listed, false of an alias it already resolved.
    // The month matters: the same page in August is NZST (+12) and the anchor lands at 00:00Z, exactly
    // on the boundary this relies on being crossable.
    const [inc] = parseBetterStackDowntimeIncidents(
      page('Auckland', [{ id: '1', name: 'api', days: [['2026-01-15', 7200]] }]),
      { now: Date.parse('2026-01-20T12:00:00Z') })

    expect(inc.startedAt.slice(0, 10), 'the anchor disagrees with the day here').toBe('2026-01-14')
    expect(inc.derivedDay, 'the field does not').toBe('2026-01-15')
  })

  it('anchors inside the page-local day in every zone', () => {
    // What the anchor IS still required to do: sit within its own day, so ordering and the trailing
    // window behave. Noon local, checked against the page zone rather than UTC.
    for (const [tz, day, now] of [
      ['Berlin', '2026-08-15', '2026-08-20'], ['Auckland', '2026-08-15', '2026-08-20'],
      ['Auckland', '2026-01-15', '2026-01-20'], // NZDT (+13) — the row that breaks the UTC reading
      ['Fiji', '2026-08-15', '2026-08-20'], ['Pacific Time (US & Canada)', '2026-08-15', '2026-08-20'],
      ['UTC', '2026-08-15', '2026-08-20'],
    ] as const) {
      const [inc] = parseBetterStackDowntimeIncidents(
        page(tz, [{ id: '1', name: 'api', days: [[day, 7200]] }]),
        { now: Date.parse(`${now}T12:00:00Z`) })
      const local = new Intl.DateTimeFormat('en-CA', {
        timeZone: resolveBetterStackTimeZone(tz).tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(inc.startedAt))
      expect(local, `${tz} ${day}: the anchor left its own day`).toBe(day)
    }
  })

  it('does not emit a run that ended before the trailing window', () => {
    // The window bounds which runs are EMITTED. Without it a quiet page would publish its whole
    // 90-day history the first time it was read.
    const incidents = parseBetterStackDowntimeIncidents(page('UTC', [{
      id: '1', name: 'api', days: [['2026-06-10', 7200], ['2026-08-20', 7200]],
    }]), { now: Date.parse('2026-08-28T12:00:00Z'), windowDays: 30 })

    expect(incidents.map((i) => i.startedAt.slice(0, 10))).toEqual(['2026-08-20'])
  })

  it('a many-resource page keeps its DAYS — the cap is not spent on resource multiplicity', () => {
    // Reproduced against `status.together.ai` on 2026-08-30: 22 monitored resources produced 41 rows
    // over 22 downtime days, and a 20-ROW cap kept 20 rows over 10 days — dropping 12 days and 73% of
    // the downtime, oldest-first, i.e. toward a BETTER score. `affectedDays` counts DAYS, so a bound
    // in rows truncates the window for exactly the pages this fix exists for. helicone (3 resources)
    // stayed under any row cap, which is why a helicone-only check missed it.
    const resources = Array.from({ length: 22 }, (_, r) => ({
      id: `r${r}`, name: `model-${r}`,
      days: Array.from({ length: 25 }, (_, d) => [`2026-08-${String(d + 1).padStart(2, '0')}`, 3600] as [string, number]),
    }))
    const incidents = parseBetterStackDowntimeIncidents(
      page('UTC', resources), { now: Date.parse('2026-08-30T12:00:00Z') })

    const days = new Set(incidents.map((i) => i.derivedDay))
    expect(days.size, 'every downtime day in the window must survive, however many resources share it')
      .toBe(25)
    expect(incidents.length, 'and every resource-row for those days').toBe(22 * 25)
    expect(incidents.length, 'the row backstop is deliberately above the real worst case')
      .toBeLessThan(1000)
  })

  it('does NOT absorb a self-contradictory row into the sub-threshold floor', () => {
    // The #1292 failure mode by another door. All three readers of this payload key on
    // `downtime_duration`; rename that ONE subfield and `parseBetterStackUptime` publishes 100.00%
    // (its self-check is `pct < 0 || pct > 100`, which 100 passes), the calendar empties, and every
    // row here silently falls through the 600s floor — the exact production signature, now with a
    // plausible uptime instead of a null one. A row that DECLARES downtime and reports none is a
    // schema signal, so it must be logged rather than treated as a quiet day.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const payload = page('UTC', [{ id: '1', name: 'api', days: [['2026-08-10', 7200]] }])
      for (const r of payload.included ?? []) {
        for (const d of (r as { attributes?: { status_history?: Array<Record<string, unknown>> } }).attributes?.status_history ?? []) {
          delete d.downtime_duration
        }
      }
      const incidents = parseBetterStackDowntimeIncidents(payload, { now: NOW })

      expect(incidents, 'nothing can be synthesized without the seconds').toEqual([])
      expect(warn.mock.calls.flat().join(' '), 'but the drift must be reported, not absorbed')
        .toContain('status_history shape may have changed')
    } finally {
      warn.mockRestore()
    }
  })

  it('a genuine sub-threshold blip stays silent — the drift warn is not a blanket', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const incidents = parseBetterStackDowntimeIncidents(
        page('UTC', [{ id: '1', name: 'api', days: [['2026-08-10', 120]] }]), { now: NOW })
      expect(incidents).toEqual([])
      expect(warn.mock.calls.flat().join(' ')).not.toContain('shape may have changed')
    } finally {
      warn.mockRestore()
    }
  })

  it('excludes the still-accruing PAGE-LOCAL day, not the UTC one', () => {
    // Replace `zonedDayOf(now, tz)` with a UTC slice and every existing test still passes: the
    // day-closing case uses a UTC page, and the zone cases put `now` five days clear of the boundary.
    // A WEST-of-UTC page is where they differ — and that is every service this issue is about
    // (together = Pacific, modal/huggingface = Eastern). Publishing the accruing day as a closed
    // incident breaks the invariant the per-day id rests on: its `duration` would change next cron.
    const now = Date.parse('2026-08-20T04:00:00Z') // = 2026-08-19 21:00 Pacific
    const incidents = parseBetterStackDowntimeIncidents(
      page('Pacific Time (US & Canada)', [{ id: '1', name: 'api', days: [
        ['2026-08-18', 7200],
        ['2026-08-19', 7200], // still accruing in the PAGE's zone, already past in UTC
      ] }]), { now })

    expect(incidents.map((i) => i.derivedDay), 'the page-local today must not be emitted')
      .toEqual(['2026-08-18'])
  })

  it('drops a day whose downtime is fully accounted for by announced maintenance', () => {
    // The third maintenance guard had no fixture: both existing maintenance tests set
    // `status: 'maintenance'`, which the PRECEDING branch already catches, so this one could be
    // deleted with the suite green.
    const incidents = parseBetterStackDowntimeIncidents(
      page('UTC', [{ id: '1', name: 'api', days: [['2026-08-10', 3600]] }]), { now: NOW },
    )
    expect(incidents, 'control: without maintenance the day is emitted').toHaveLength(1)

    const payload = page('UTC', [{ id: '1', name: 'api', days: [['2026-08-10', 3600]] }])
    for (const r of payload.included ?? []) {
      for (const d of (r as { attributes?: { status_history?: Array<Record<string, unknown>> } }).attributes?.status_history ?? []) {
        d.status = 'downtime'
        d.maintenance_duration = 7200 // announced window ≥ the downtime it explains
      }
    }
    expect(parseBetterStackDowntimeIncidents(payload, { now: NOW })).toEqual([])
  })

  it('emits an EMPTY timeline — there are no provider updates to show', () => {
    // Load-bearing beyond the modal's empty state: `IncidentTimeline.jsx` formats each step's `at` at
    // minute precision with its own local formatter, and the #1292 precision scan carves that call out
    // on the grounds that no step of a synthesized incident can exist. This is that premise.
    const incidents = parseBetterStackDowntimeIncidents(
      page('UTC', [{ id: '1', name: 'api', days: [['2026-08-10', 7200]] }]), { now: NOW })
    expect(incidents[0].timeline).toEqual([])
  })

  it('emits a non-null impact and no autoMonitor tag, so the Score actually counts it', () => {
    // `impact: null` is dropped from affectedDays by the #261 filter and `autoMonitor` by #989 —
    // either would leave score.ts exactly as broken as it is without this change.
    const incidents = parseBetterStackDowntimeIncidents(
      page('UTC', [{ id: '1', name: 'api', days: [['2026-08-10', 7200]] }]), { now: NOW })
    expect(incidents[0].impact).not.toBeNull()
    expect(incidents[0].autoMonitor).toBeUndefined()
  })
})

// #1292 — the is-down card renders `svc.incidents` in ARRAY ORDER (the SPA re-sorts with
// `compareIncidents`), so the order this parser emits is published as-is. Within a day every row shares
// one anchor, so a bare `startedAt` sort leaves it to `included` order — an ordering nothing states.
// Mirrors the SPA rule; the SPA half is `src/utils/__tests__/derived-same-day-order.test.js`, which
// also fails if the comparator below is deleted.
describe('parseBetterStackDowntimeIncidents — same-day order (duration desc, then name)', () => {
  const H = 3600
  // Two resources down the same day for different lengths, listed shortest-first in the payload so a
  // pass cannot come from input order.
  const twoOnOneDay = page('UTC', [
    { id: 'r-api', name: 'api.hconeai.com', days: [['2026-08-15', 6 * H + 56 * 60]] },
    { id: 'r-eu', name: 'eu.api.helicone.ai', days: [['2026-08-15', 24 * H]] },
  ])

  it('puts the LONGER outage first within a day', () => {
    const out = parseBetterStackDowntimeIncidents(twoOnOneDay, { now: NOW })
    expect(out.map((i) => i.title)).toEqual([
      'eu.api.helicone.ai — recovered', 'api.hconeai.com — recovered',
    ])
  })

  it('falls to the resource NAME when the displayed durations tie', () => {
    // Same minute on screen, 62ms apart in the payload — the real helicone Aug 16 pair, with the
    // sub-second float inverted against the name order so an unstated tiebreak cannot pass this.
    const tie = page('UTC', [
      { id: 'r-eu', name: 'eu.api.helicone.ai', days: [['2026-08-15', 11 * H + 36 * 60 + 0.092]] },
      { id: 'r-api', name: 'api.hconeai.com', days: [['2026-08-15', 11 * H + 36 * 60 + 0.030]] },
    ])
    const out = parseBetterStackDowntimeIncidents(tie, { now: NOW })
    expect(out.map((i) => i.duration)).toEqual([out[1].duration, out[1].duration]) // identical on screen
    expect(out.map((i) => i.title)).toEqual([
      'api.hconeai.com — recovered', 'eu.api.helicone.ai — recovered',
    ])
  })

  it('still emits DAYS newest-first', () => {
    const twoDays = page('UTC', [
      { id: 'r-api', name: 'api.hconeai.com', days: [['2026-08-14', 24 * H], ['2026-08-16', 2 * H]] },
    ])
    const out = parseBetterStackDowntimeIncidents(twoDays, { now: NOW })
    expect(out.map((i) => i.derivedDay)).toEqual(['2026-08-16', '2026-08-14'])
  })
})

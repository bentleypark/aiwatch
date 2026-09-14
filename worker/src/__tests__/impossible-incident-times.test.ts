import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { correctIncidentIoImpossibleTimes, parseIncidentIoComponentImpacts, computeIncidentIoUptime, __resetAnchoredWarnings } from '../parsers/incident-io'
import { isTimeOrderImpossible, formatDuration } from '../utils'
import { buildHistoryRecord } from '../incident-history'
import { calculateAIWatchScore } from '../score'
import { markIncidentResolved } from '../recovery-mark'
import { SERVICES, fetchService } from '../services'
import type { Incident } from '../types'

// #1390 — incident.io's Atlassian-compat `incidents.json` sets `created_at` to when the incident was
// DECLARED. For one filed retroactively — or for a whole history imported by a status-page migration —
// that is long after the outage it describes, so the published record recovers BEFORE it starts.
// `formatDuration` floors the negative interval to `1m` (via `displayedMinutes`), and `score.ts`
// computes MTTR from that figure, so a multi-hour outage scores as a one-minute recovery.
//
// Measured on the published `/api/status`, 2026-09-14 — these are the real records, not invented ones:
//
//   turbopuffer  declared 2025-12-16T05:24:23Z  recovered 2025-12-14T21:28:00Z  (TLS certificate expiration)
//   groq         declared 2025-12-17T07:11:39Z  recovered 2025-12-14T13:30:00Z  (Data Center Failure)
//   junie        declared 2026-07-16T13:46:45Z  recovered 2026-07-02T23:07:05Z  (Anthropic Org Quota exceeded)
//   elevenlabs   declared 2026-07-08T17:42:12Z  recovered 2026-07-08T17:04:00Z  (Increased Error Rate in US Region)
//   perplexity   24 of 25, every one a migration import
//
// and ZERO on every other platform we read (Rootly / Atlassian / Cloudflare / Instatus / Better Stack /
// Flashduty / OnlineOrNot / AWS / gcloud / RSS). Mistral's 44 `1m` durations are genuine 60-second
// auto-monitor flaps — start and resolve exactly one minute apart, which is why the predicate is the
// ORDERING and never the duration string.

const esc = (o: unknown) => JSON.stringify(o).replace(/"/g, '\\"')

/** An incident.io page RSC chunk carrying `component_impacts` — the repair material. Shaped like the
 *  live payload (`component_impacts` before `component_uptimes`, escaped-JSON inside `__next_f`). */
function pageWithImpacts(impacts: Array<Record<string, unknown>>): string {
  const payload = `\\"component_impacts\\":${esc(impacts)},\\"component_uptimes\\":${esc([])}`
  return `<script>self.__next_f.push([1,"${payload}"])</script>`
}

function inc(o: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    title: 'TLS certificate expiration in aws-us-east-1',
    status: 'resolved',
    impact: 'major',
    startedAt: '2025-12-16T05:24:23Z',   // declaration
    resolvedAt: '2025-12-14T21:28:00Z',  // true recovery, 31.9h EARLIER
    duration: '1m',                       // what formatDuration floors the negative interval to
    timeline: [],
    ...o,
  }
}

describe('#1390 isTimeOrderImpossible — the predicate', () => {
  it('is true only when the recovery genuinely predates the start', () => {
    expect(isTimeOrderImpossible('2025-12-16T05:24:23Z', '2025-12-14T21:28:00Z')).toBe(true)
    expect(isTimeOrderImpossible('2025-12-14T21:28:00Z', '2025-12-16T05:24:23Z')).toBe(false)
    expect(isTimeOrderImpossible('2026-09-04T16:35:00Z', '2026-09-04T16:35:00Z'), 'equal is not impossible').toBe(false)
  })

  it('compares PARSED instants, not ISO strings', () => {
    // The bug this guards: these payloads mix fractional-second precision, and lexically
    // '…03.500Z' < '…03Z' because '.' sorts below 'Z'. A string compare calls this pair impossible.
    expect(isTimeOrderImpossible('2026-09-05T07:09:00Z', '2026-09-05T07:09:00.500Z')).toBe(false)
    // …and misses the reverse, where the later instant carries the fraction.
    expect(isTimeOrderImpossible('2026-09-05T07:09:00.500Z', '2026-09-05T07:09:00Z')).toBe(true)
  })

  it('treats missing or unparseable timestamps as UNKNOWN, not impossible', () => {
    // An ongoing incident has no resolvedAt; nulling its duration would erase a legitimate value.
    expect(isTimeOrderImpossible('2025-12-16T05:24:23Z', null)).toBe(false)
    expect(isTimeOrderImpossible(undefined, '2025-12-14T21:28:00Z')).toBe(false)
    expect(isTimeOrderImpossible('not a date', '2025-12-14T21:28:00Z')).toBe(false)
  })

  it('mistral`s genuine one-minute flap is NOT impossible', () => {
    // 44 of mistral's 80 published incidents read `1m` and every one is real (start → resolve exactly
    // 60s). Keying the repair on the duration string instead of the ordering would rewrite all of them.
    expect(isTimeOrderImpossible('2026-09-04T16:35:00.000Z', '2026-09-04T16:36:00.000Z')).toBe(false)
  })
})

describe('#1390 correctIncidentIoImpossibleTimes — the repair', () => {
  it('takes the start from the component_impacts window and recomputes the duration', () => {
    const html = pageWithImpacts([
      { component_id: 'c1', start_at: '2025-12-14T19:00:00Z', end_at: '2025-12-14T21:28:00Z', status: 'full_outage', status_page_incident_id: 'inc-1' },
    ])
    const [out] = correctIncidentIoImpossibleTimes([inc()], html)
    expect(out.startedAt).toBe('2025-12-14T19:00:00Z')
    expect(out.resolvedAt, 'the window supplies BOTH endpoints').toBe('2025-12-14T21:28:00Z')
    expect(out.duration).toBe('2h 28m') // and NOT the '1m' it published
  })

  it.each([
    ['widest row first', [['2025-12-14T19:00:00Z', '2025-12-14T21:28:00Z'], ['2025-12-14T20:30:00Z', '2025-12-14T20:45:00Z']]],
    ['widest row last', [['2025-12-14T20:30:00Z', '2025-12-14T20:45:00Z'], ['2025-12-14T19:00:00Z', '2025-12-14T21:28:00Z']]],
    ['split across rows', [['2025-12-14T19:00:00Z', '2025-12-14T20:00:00Z'], ['2025-12-14T20:30:00Z', '2025-12-14T21:28:00Z']]],
  ])('unions BOTH endpoints across several impacted components (%s)', (_order, rows) => {
    // BOTH orderings on BOTH ends, because one ordering cannot distinguish "earliest/latest wins" from
    // "first wins" or "last wins" — with a single fixture order, dropping either comparison still
    // passes. The third case is the one neither of the first two reaches: no single row spans the whole
    // outage, so the start comes from one row and the end from another.
    const html = pageWithImpacts(rows.map(([start_at, end_at], n) => ({
      component_id: `c${n}`, start_at, end_at,
      status: 'full_outage', status_page_incident_id: 'inc-1',
    })))
    const [out] = correctIncidentIoImpossibleTimes([inc()], html)
    expect(out.startedAt).toBe('2025-12-14T19:00:00Z')
    expect(out.resolvedAt).toBe('2025-12-14T21:28:00Z')
    expect(out.duration).toBe('2h 28m')
  })

  it.each([
    ['no impact row joins', () => pageWithImpacts([]), 'the page carries no usable component_impacts window'],
    ['the page HTML is missing entirely', () => undefined, 'no page HTML this cycle'],
    ['the impacts blob is present but unparseable', () => '<script>self.__next_f.push([1,"\\"component_impacts\\":[{oops,\\"component_uptimes\\":[]"])</script>', 'present but unparseable'],
  ])('anchors on resolvedAt with duration null when %s', (_case, html, expectedWhy) => {
    // 17 of perplexity's 25 imported incidents are this case. Both harms have to go, and the second is
    // the one a "just null the duration" fix leaves behind: every import is stamped 2026-08-24, so
    // outages from 2025-03 through 2026-06 would sit inside the 30-day window `score.ts` filters on
    // `startedAt` and be counted as this month's. `resolvedAt` is the one trustworthy instant left.
    __resetAnchoredWarnings()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const [out] = correctIncidentIoImpossibleTimes([inc()], html())
      expect(out.duration).toBeNull()
      expect(out.startedAt).toBe('2025-12-14T21:28:00Z')
      expect(out.startUnknown, 'the fabricated zero length must be declared, not implied').toBe(true)
      const logged = warn.mock.calls.flat().join(' ')
      expect(logged, 'an unrepairable record must not be silent').toContain('recovery predates start')
      // The three states are NOT interchangeable to an operator: "we could not read it" sends them to
      // our parser, the other two send them to the provider's page. Conflating them was round 1's
      // finding, and asserting the same string for all three would pin the conflation.
      expect(logged, 'the reason must name WHICH of the three states this was').toContain(expectedWhy)
    } finally { warn.mockRestore() }
  })

  it('the anchored record is no longer counted as a RECENT incident', () => {
    // The scoring half, stated as the outcome rather than as a field value: `score.ts` windows on
    // `startedAt`, so an ancient outage stamped with a recent declaration date is a phantom penalty.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cutoff = new Date(Date.parse('2026-09-14T00:00:00Z') - 30 * 86_400_000).toISOString()
      const filed = inc({ startedAt: '2026-08-24T23:39:23Z', resolvedAt: '2026-06-05T01:40:38Z' })
      expect(filed.startedAt >= cutoff, 'premise: as published it falls inside the 30-day window').toBe(true)
      const [out] = correctIncidentIoImpossibleTimes([filed], undefined)
      expect(out.startedAt >= cutoff).toBe(false)
    } finally { warn.mockRestore() }
  })

  it('refuses a maintenance window as the repair source', () => {
    // `parseIncidentIoImpacts` does not filter by status, so without an explicit skip the "real start"
    // could come from an announced maintenance window — which `parseIncidentIoComponentImpacts` one
    // function over, and `INCIDENT_IO_STATUS_WEIGHTS`, both refuse to treat as outage evidence. The two
    // halves of one change would disagree about the same rows.
    __resetAnchoredWarnings()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const html = pageWithImpacts([
        { component_id: 'c1', start_at: '2025-12-14T19:00:00Z', end_at: '2025-12-14T20:00:00Z', status: 'under_maintenance', status_page_incident_id: 'inc-1' },
      ])
      const [out] = correctIncidentIoImpossibleTimes([inc()], html)
      expect(out.startedAt, 'a maintenance window is not a start').toBe('2025-12-14T21:28:00Z')
      expect(out.startUnknown).toBe(true)
      expect(out.duration).toBeNull()
    } finally { warn.mockRestore() }
  })

  it('repairs the record whose `resolved_at` is really its START — both endpoints come from the window', () => {
    // ElevenLabs' `Increased Error Rate in US Region`, verbatim: `created_at 17:42:12` (the filing),
    // `resolved_at 17:04:00`, and an impact window + update text that both say the outage ran
    // 17:04 → 17:13. So `resolved_at` here is the START, not the end. An earlier cut of this function
    // kept the record's `resolved_at` and compared the window's start against it; being equal, the
    // repair was rejected and a real 9-minute window sitting on the page was discarded. Taking BOTH
    // endpoints from the window is what makes the pair trustworthy end to end.
    const real = inc({ id: '01KX1D5CGRYDFYM7DT50X9XT3R', title: 'Increased Error Rate in US Region', startedAt: '2026-07-08T17:42:12Z', resolvedAt: '2026-07-08T17:04:00Z' })
    const html = pageWithImpacts([
      { component_id: 'c1', start_at: '2026-07-08T17:04:00Z', end_at: '2026-07-08T17:13:00Z', status: 'degraded_performance', status_page_incident_id: real.id },
    ])
    const [out] = correctIncidentIoImpossibleTimes([real], html)
    expect(out.startedAt).toBe('2026-07-08T17:04:00Z')
    expect(out.resolvedAt, 'the discredited resolved_at is replaced too, not kept').toBe('2026-07-08T17:13:00Z')
    expect(out.duration).toBe('9m')
    expect(out.startUnknown, 'a repaired record is not anchored').toBeUndefined()
  })

  it('refuses a zero-length window — it carries no duration to recover', () => {
    // The window is checked against its OWN endpoints now. A start === end window states nothing, and
    // `formatDuration` would floor it back to the `1m` this function exists to remove.
    __resetAnchoredWarnings()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const html = pageWithImpacts([
        { component_id: 'c1', start_at: '2025-12-14T21:28:00Z', end_at: '2025-12-14T21:28:00Z', status: 'full_outage', status_page_incident_id: 'inc-1' },
      ])
      const [out] = correctIncidentIoImpossibleTimes([inc()], html)
      expect(out.duration).toBeNull()
      expect(out.startUnknown).toBe(true)
      expect(buildHistoryRecord({ id: 'turbopuffer', provider: 'turbopuffer', category: 'api' }, { ...out, status: 'resolved' }, null, '2025-12-17T00:00:00Z')).toBeNull()
    } finally { warn.mockRestore() }
  })

  it('leaves a well-ordered incident untouched, and returns the SAME array', () => {
    // Identity, not just equality: this runs for every service on every cycle, so the no-op path must
    // allocate nothing — and a reference change would mean the repair ran where it had no business to.
    const healthy = [inc({ startedAt: '2025-12-14T19:00:00Z', resolvedAt: '2025-12-14T21:28:00Z', duration: '2h 28m' })]
    const html = pageWithImpacts([
      { component_id: 'c1', start_at: '2025-12-14T10:00:00Z', end_at: '2025-12-14T21:28:00Z', status: 'full_outage', status_page_incident_id: 'inc-1' },
    ])
    // The impact window starts 9h earlier than the incident — a provider backdating its window, which
    // langfuse / elevenlabs / openai do by up to 7.8h. Re-timing those is a DIFFERENT decision (it would
    // move nine services' Scores) and must not ride along on this one.
    expect(correctIncidentIoImpossibleTimes(healthy, html)).toBe(healthy)
  })

  it('repairs only the impossible member of a mixed list', () => {
    const ok = inc({ id: 'ok', startedAt: '2026-09-04T16:35:00.000Z', resolvedAt: '2026-09-04T16:36:00.000Z', duration: '1m' })
    const html = pageWithImpacts([
      { component_id: 'c1', start_at: '2025-12-14T19:00:00Z', end_at: '2025-12-14T21:28:00Z', status: 'full_outage', status_page_incident_id: 'inc-1' },
      { component_id: 'c1', start_at: '2026-09-01T00:00:00Z', end_at: '2026-09-01T01:00:00Z', status: 'full_outage', status_page_incident_id: 'ok' },
    ])
    const out = correctIncidentIoImpossibleTimes([inc(), ok], html)
    expect(out[0].duration).toBe('2h 28m')
    expect(out[1], 'the genuine 1m flap keeps its published start AND duration').toEqual(ok)
  })
})

describe('#1390 buildHistoryRecord — the no-TTL corpus refuses an impossible record', () => {
  const svc = { id: 'turbopuffer', provider: 'turbopuffer', category: 'api' as const }
  const now = '2025-12-17T00:00:00Z'

  it('refuses a repaired-but-unrecoverable record, which is well-ordered and zero-length', () => {
    // The case an ordering re-test cannot catch: after the repair `startedAt === resolvedAt`, so the
    // record is perfectly consistent AND perfectly zero. `startUnknown` is what says it is not real.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const anchored = { ...inc(), startedAt: '2025-12-14T21:28:00Z', startUnknown: true, duration: null, status: 'resolved' }
      expect(isTimeOrderImpossible(anchored.startedAt, anchored.resolvedAt), 'premise: it is NOT impossible any more').toBe(false)
      expect(buildHistoryRecord(svc, anchored, null, now)).toBeNull()
    } finally { warn.mockRestore() }
  })

  it('returns null instead of a 0-minute record', () => {
    // `durationMinOf` clamps a backwards pair to 0. That 0 is graded by `accuracyOf` as a 0-hour actual
    // (always `over-predicted`, published daily + monthly) and grounds the next AI estimate via
    // `findSimilarHistory` — in a store with no TTL.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(buildHistoryRecord(svc, { ...inc(), status: 'resolved' }, null, now)).toBeNull()
      expect(warn.mock.calls.flat().join(' ')).toContain('refusing to write a 0-minute record')
    } finally { warn.mockRestore() }
  })

  it('still records the same incident once its times are repaired', () => {
    // The guard must not be a blanket drop: a repaired record is exactly what the corpus wants.
    const repaired = { ...inc(), startedAt: '2025-12-14T19:00:00Z', status: 'resolved' }
    const rec = buildHistoryRecord(svc, repaired, null, now)
    expect(rec?.durationMin).toBe(148)
  })

  it('still records an incident that recovers within the same minute', () => {
    // `durationMin` rounds, so a genuinely sub-minute incident is legitimately 0 and must stay. Gating
    // on `durationMin > 0` instead of on the ORDER would have dropped it.
    const quick = { ...inc(), startedAt: '2026-09-04T16:35:00Z', resolvedAt: '2026-09-04T16:35:20Z', status: 'resolved' }
    expect(buildHistoryRecord(svc, quick, null, now)?.durationMin).toBe(0)
  })
})

// ── Wiring: through the real fetchService, on the real turbopuffer config ──
// turbopuffer is the service the first cut of this fix SKIPPED: its page is incident.io but it carries
// no `incidentIoBaseUrl`, so a platform-flag gate excluded one of the four services measurably
// carrying the defect. Driving it here is what makes that regression fail rather than pass quietly.

const turbopuffer = SERVICES.find((s) => s.id === 'turbopuffer')!

afterEach(() => vi.unstubAllGlobals())

describe('#1390 wiring — the repair reaches a service with no incidentIoBaseUrl', () => {
  it('premise — turbopuffer really is an incident.io page configured without that field', () => {
    expect(turbopuffer.incidentIoComponentId, 'incident.io component ids').toBeTruthy()
    expect(turbopuffer.incidentIoBaseUrl, 'and no base URL — the gate that skipped it').toBeUndefined()
  })

  it('publishes the repaired window, not the fabricated 1m', async () => {
    const impossible = {
      id: 'tp-1',
      name: 'TLS certificate expiration in aws-us-east-1',
      status: 'resolved',
      impact: 'major',
      created_at: '2025-12-16T05:24:23Z',
      updated_at: '2025-12-16T05:24:23Z',
      resolved_at: '2025-12-14T21:28:00Z',
      incident_updates: [],
      components: [],
    }
    const summary = {
      page: { id: 'p', name: 'turbopuffer', updated_at: new Date().toISOString() },
      status: { indicator: 'none', description: 'All Systems Operational' },
      components: [{ id: turbopuffer.statusComponentId ?? 'c1', name: 'API', status: 'operational' }],
      incidents: [impossible],
    }
    const html = pageWithImpacts([
      { component_id: 'c1', start_at: '2025-12-14T19:00:00Z', end_at: '2025-12-14T21:28:00Z', status: 'full_outage', status_page_incident_id: 'tp-1' },
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200 })))
    const svc = await fetchService(
      turbopuffer,
      { summary: summary as never, incidents: null, latency: 120, uptimeHtml: html } as never,
      undefined,
      {},
    )
    const published = svc.incidents.find((i) => i.id === 'tp-1')
    expect(published, 'the incident must still be published').toBeDefined()
    expect(published!.startedAt).toBe('2025-12-14T19:00:00Z')
    expect(published!.duration).toBe('2h 28m')
    // The value MTTR is computed from — the reason this is not a display-only fix.
    expect(published!.duration).not.toBe(formatDuration(new Date('2025-12-16T05:24:23Z'), new Date('2025-12-14T21:28:00Z')))
  })
})


// ── The impact calendar and announced maintenance ──

describe('#1390 the impact calendar excludes announced maintenance', () => {
  const COMP = '01KZSFD424KQ6VQYV4R0KCA30P'
  /** Perplexity's real status-page migration window: 2026-09-10 21:00→21:36Z, `under_maintenance`, on
   *  all three components. 36 minutes, so it clears the parser's own 10-minute floor. In KST it lands
   *  on 09-11, which is where it was reported from. */
  const MAINT = { component_id: COMP, start_at: '2026-09-10T21:00:00Z', end_at: '2026-09-10T21:36:01.13Z', status: 'under_maintenance', status_page_incident_id: 'm1' }
  const OUTAGE = { component_id: COMP, start_at: '2026-09-05T04:50:00Z', end_at: '2026-09-05T07:09:00.672Z', status: 'partial_outage', status_page_incident_id: 'o1' }

  it('paints no cell for a maintenance window', () => {
    // The cell had nothing to explain it: maintenance is not published as an incident, so the list
    // beside the calendar is empty for that day.
    expect(parseIncidentIoComponentImpacts(pageWithImpacts([MAINT]), COMP)).toEqual({})
  })

  it('still paints real outages on the same page', () => {
    // The control — a blanket skip would empty the calendar instead of filtering it.
    const out = parseIncidentIoComponentImpacts(pageWithImpacts([MAINT, OUTAGE]), COMP)
    expect(Object.values(out)).toEqual(['major'])
    expect(Object.keys(out)[0].startsWith('2026-09-05')).toBe(true)
  })

  it('agrees with the uptime formula, which already weighted maintenance at zero', () => {
    // The defect was a DISAGREEMENT between two readers of the same rows, so pin the agreement rather
    // than just the new behaviour: uptime says the day was clean, and now the calendar says so too.
    const html = pageWithImpacts([MAINT])
    const withSince = html.replace('\\"component_uptimes\\":[]',
      '\\"component_uptimes\\":[{\\"component_id\\":\\"' + COMP + '\\",\\"data_available_since\\":\\"2024-07-30T16:55:00Z\\",\\"uptime\\":\\"100.00\\"}]')
    expect(computeIncidentIoUptime(withSince, COMP, Date.parse('2026-09-14T00:00:00Z'))?.pct).toBe(100)
    expect(parseIncidentIoComponentImpacts(withSince, COMP)).toEqual({})
  })

  it('degraded_performance is still a minor cell — the catch-all kept its intended case', () => {
    const degraded = { ...OUTAGE, status: 'degraded_performance' }
    expect(Object.values(parseIncidentIoComponentImpacts(pageWithImpacts([degraded]), COMP))).toEqual(['minor'])
  })
})

// ── The Score consequence — the gap that let round 1's Critical pass 5481 green tests ──

describe('#1390 Score — an anchored incident makes Recovery ABSTAIN, never score 0', () => {
  // In-window and anchored: `startedAt === resolvedAt`, no duration. Relative to now, because an
  // out-of-window incident leaves `impactfulWindowIncidents` empty and Recovery abstains for a reason
  // that has nothing to do with this fix.
  const anchored = (o: Partial<Incident> = {}): Incident => {
    const at = new Date(Date.now() - 5 * 86_400_000).toISOString()
    return { ...inc({ startedAt: at, resolvedAt: at, duration: null }), startUnknown: true, ...o }
  }
  const svcWith = (incidents: Incident[]): Parameters<typeof calculateAIWatchScore>[0] => ({
    id: 'elevenlabs', name: 'ElevenLabs', provider: 'ElevenLabs', category: 'api',
    status: 'operational', latency: null, uptime30d: null, lastChecked: new Date().toISOString(), incidents,
  } as never)
  const probe = { kind: 'unsupported' } as const
  const recoveryOf = (incidents: Incident[]) => calculateAIWatchScore(svcWith(incidents), 30, probe).breakdown.recovery

  it('abstains at full marks when the window holds only anchored incidents', () => {
    // The regression, in the direction #1292 already ruled on: dropping such a record from `durations`
    // but leaving it in `recoveryCandidates` scores Recovery 0 — a fabricated worst-possible recovery
    // replacing the fabricated `1m` the repair removed.
    expect(recoveryOf([anchored()])).toBe(15)
  })

  it('still scores normally when a measurable incident is present alongside it', () => {
    // The control: the abstain must not swallow a real recovery time sitting in the same window.
    const measurable = inc({ id: 'm1', startedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), resolvedAt: new Date(Date.now() - 3 * 86_400_000 + 3_600_000).toISOString(), duration: '1h 0m' })
    const both = recoveryOf([anchored(), measurable])
    expect(both).toBeLessThan(15)
    expect(both, 'the anchored member must not drag the figure either').toBe(recoveryOf([measurable]))
  })

  it('an unflagged zero-duration incident is NOT swept along', () => {
    // `startUnknown` is the discriminator, not the null duration: a resolved incident with no duration
    // from some other parser keeps its existing treatment (it stays a candidate, so Recovery scores 0).
    // Dated INSIDE the 30-day window on purpose — with an out-of-window incident the window is empty and
    // Recovery abstains for an unrelated reason, which would make this assertion vacuous.
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const nullDur = inc({ id: 'n1', startedAt: recent, resolvedAt: recent, duration: null, startUnknown: undefined })
    expect(recoveryOf([nullDur])).toBe(0)
  })
})

// ── dailyImpactComplete: the TRUE side, and every emitter ──

describe('#1390 dailyImpactComplete — the complete side is pinned too', () => {
  it('an Atlassian per-day record is declared COMPLETE', async () => {
    // Only the `false` side was pinned at first, so hardcoding the flag to `false` left every test in
    // the repo green while all the Atlassian services started painting keyword-filtered incidents from
    // unrelated components onto a calendar the code says is already complete — the exact noise the
    // Phase-2 gate exists to prevent, in the direction the mutation battery had not covered.
    const claude = SERVICES.find((s) => s.id === 'claude')!
    const id = claude.statusComponentId!
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
    const summary = {
      page: { id: 'p', name: 'Anthropic', updated_at: new Date().toISOString() },
      status: { indicator: 'none', description: 'All Systems Operational' },
      components: [{ id, name: 'Claude API', status: 'operational' }],
      incidents: [],
    }
    // The real Atlassian embed shape (see parse-uptime-data.test.ts): `window.uptimeData` with per-day
    // outage SECONDS. Relative days so the fixture stays inside the trailing window.
    const days = `"days":[{"date":"${day(4)}","outages":{"p":0,"m":0}},{"date":"${day(3)}","outages":{"p":864,"m":0}}]`
    const html = `<script>window.uptimeData = {"${id}":{"component":{"code":"${id}","name":"Claude API"},${days}}};</script>`
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200 })))
    const svc = await fetchService(claude, { summary: summary as never, incidents: null, latency: 100, uptimeHtml: html } as never, undefined, {})
    if (svc.dailyImpact && Object.keys(svc.dailyImpact).length > 0) {
      expect(svc.dailyImpactComplete, 'an Atlassian bucket record owns every day').toBe(true)
    } else {
      // The fixture failed to produce buckets — say so rather than passing vacuously.
      expect.unreachable('the Atlassian uptime fixture produced no dailyImpact, so this asserts nothing')
    }
  })

  it('every service that publishes a dailyImpact also declares whether it is complete', async () => {
    // The durable form of round 1's finding that two of the four emit sites (Rootly, Flashduty) were
    // never updated: a later `calendarDays` change on either would have flipped its calendar silently,
    // which is the defect class #1390 is about. Read off the SOURCE rather than a live fetch, because
    // reaching all four branches needs four different upstream fixtures.
    const src = readFileSync(new URL('../services.ts', import.meta.url), 'utf-8')
    const emits = [...src.matchAll(/\{\s*dailyImpact[,:][^}]*\}/g)].map((m) => m[0])
    expect(emits.length, 'the emit-site scan found nothing — the shape changed').toBeGreaterThanOrEqual(4)
    for (const e of emits) {
      expect(e, `a dailyImpact emit site does not state completeness: ${e.slice(0, 90)}`).toContain('dailyImpactComplete')
    }
  })
})

// ── The ONE upstream predicate (round 3): withhold the resolution event, not three more field patches ──

describe('#1390 markIncidentResolved refuses an anchored incident outright', () => {
  const anchoredInc = { id: 'i1', title: 'Computer Tasks Degraded', startedAt: '2026-09-01T00:06:56Z', resolvedAt: '2026-09-01T00:06:56Z', startUnknown: true }
  const store = () => {
    const kv: Record<string, string> = {}
    return { kv, api: { get: async (k: string) => kv[k] ?? null, put: async (k: string, v: string) => { kv[k] = v }, delete: async (k: string) => { delete kv[k] } } }
  }

  it('writes no recovery marker and stamps no analysis resolvedAt', async () => {
    // Round 2 cleared the marker's `duration` FIELD and thought that closed it. Round 3 reproduced three
    // surfaces that never read that field — they subtract the incident's own timestamp pair, which is
    // subtractable and looks valid. Both writes this function makes are what those surfaces hang on:
    // `recoveredGrouping.js` builds a row only from the marker, and `predictionAccuracy.js` / the is-down
    // AI card / the Analyze modal all return early without a stamped `resolvedAt`.
    const s = store()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await s.api.put('ai:analysis:elevenlabs:i1', JSON.stringify({ summary: 'x', firstEstimatedRecoveryHours: 2 }))
      const out = await markIncidentResolved(s.api as never, 'elevenlabs', anchoredInc, '2026-09-02T00:00:00Z')
      expect(out, 'no analysis is returned, so no caller can hand one to buildHistoryRecord').toBeNull()
      expect(Object.keys(s.kv).some((k) => k.startsWith('recovered:')), 'no recovered: marker → no "Recently Resolved" row').toBe(false)
      expect(JSON.parse(s.kv['ai:analysis:elevenlabs:i1']).resolvedAt, 'no stamp → predicted-vs-actual returns early on all three surfaces').toBeUndefined()
      expect(warn.mock.calls.flat().join(' '), 'a withheld resolution event must not be silent').toContain('no trustworthy start')
    } finally { warn.mockRestore() }
  })

  it('still marks an ordinary resolved incident — the predicate must not swallow real recoveries', async () => {
    const s = store()
    await markIncidentResolved(s.api as never, 'elevenlabs', { ...anchoredInc, id: 'i2', startedAt: '2026-09-01T00:00:00Z', startUnknown: undefined }, '2026-09-02T00:00:00Z')
    const marker = Object.entries(s.kv).find(([k]) => k.startsWith('recovered:'))
    expect(marker, 'an ordinary incident still gets its marker').toBeDefined()
    expect(JSON.parse(marker![1]).duration).toBe('7m')
  })
})

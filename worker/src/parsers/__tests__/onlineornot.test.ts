import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Incident } from '../../types'
import { mergeOnlineOrNotIncidents, parseOnlineOrNotIncidentHistory, parseOnlineOrNotPage } from '../onlineornot'

type Inc = { id: string; title: string; started: string; ended: string | null; impact: string }

type Opts = {
  /** #894 — planned maintenance, grouped under `scheduledMaintenance` as the real loader data does. */
  maintenance?: Array<{ id?: string; title: string; started: string; ended: string | null }>
  /** emit the `statusPage` loader marker (default true). */
  marker?: boolean
  /** emit the `incidents`/`activeIncidents`/`incidentIds` container keys (default true). */
  containers?: boolean
  /** the ids the daily buckets name (default: the ids of every emitted incident). */
  bucketIds?: string[]
  /** ids that go in `activeIncidents`, each referencing the emitted incident object with that id. */
  activeIds?: string[]
  /** count of `activeIncidents` entries referencing an id-LESS object (→ activeUnreadable). */
  activeNoId?: number
  /** emit each incident TWICE, once per container spelling, in the given emission order. */
  duplicate?: 'root-first' | 'bucket-first'
  /** replace the `started` VALUE with something unreadable, keeping the row incident-shaped. */
  brokenStarted?: unknown
  /** if set, `brokenStarted` applies ONLY to these ids; otherwise it applies to every row. */
  brokenIds?: string[]
  /** make the two copies DISAGREE on resolution: the bucket copy stays open, the root copy resolves. */
  rootResolvedAt?: string
}

// Minimal OnlineOrNot HTML with embedded React Router SSR data.
//
// #1123 — this helper is faithful on the axis that produced the bug: key names are interned into the
// flat array the FIRST TIME an object uses them, so an incident-free page carries no `title`/`started`
// at all. The previous version pushed them unconditionally — including for its own "a clean 30-day
// window is 100%" case — so it asserted a payload that cannot occur, stayed green, and the same case
// returned `null` against the live page. (Both the guard and that test shipped together in #1014, a
// week before this fix.) The `statusPage` marker and the incident containers, by contrast, are
// emitted ALWAYS, because the real payload carries them whether or not there are incidents.
function makeHtml(incidents: Inc[], opts: Opts = {}) {
  const arr: unknown[] = [{}, 'loaderData']
  const key: Record<string, number> = {}
  const push = (v: unknown) => { arr.push(v); return arr.length - 1 }
  const addKey = (name: string) => { key[name] = push(name) }

  if (opts.marker !== false) addKey('statusPage')
  // The real payload always interns `id` — the status page and every component object carry one —
  // so the dedup fix's "read either spelling" half is exercised by the synthetic tests too, not only
  // by the captured fixtures.
  addKey('id')

  const hasRows = incidents.length > 0 || !!opts.maintenance?.length
  if (hasRows) for (const k of ['incidentId', 'title', 'started', 'ended', 'impact']) addKey(k)
  if (opts.maintenance) addKey('scheduledMaintenance')

  // Index of an emitted incident object per id — `activeIncidents` references these, as the real
  // payload does (an active entry is a ref to an incident object, not a fresh copy).
  const objIndexById = new Map<string, number>()
  const emitBucketCopy = (inc: Inc) => {
    const o: Record<string, number> = {}
    o[`_${key.incidentId}`] = push(inc.id)
    o[`_${key.title}`] = push(inc.title)
    o[`_${key.started}`] = push('brokenStarted' in opts && (!opts.brokenIds || opts.brokenIds.includes(inc.id)) ? opts.brokenStarted : inc.started)
    o[`_${key.ended}`] = push(inc.ended)
    o[`_${key.impact}`] = push(inc.impact)
    objIndexById.set(inc.id, push(o))
  }
  // The root `incidents` map's copy: keyed `id`, and carrying NO `impact`.
  const emitRootCopy = (inc: Inc) => {
    const o: Record<string, number> = {}
    o[`_${key.id}`] = push(inc.id)
    o[`_${key.title}`] = push(inc.title)
    o[`_${key.started}`] = push('brokenStarted' in opts && (!opts.brokenIds || opts.brokenIds.includes(inc.id)) ? opts.brokenStarted : inc.started)
    o[`_${key.ended}`] = push(opts.rootResolvedAt ?? inc.ended)
    objIndexById.set(inc.id, push(o))
  }

  for (const inc of incidents) {
    if (opts.duplicate === 'root-first') { emitRootCopy(inc); emitBucketCopy(inc) }
    else if (opts.duplicate === 'bucket-first') { emitBucketCopy(inc); emitRootCopy(inc) }
    else emitBucketCopy(inc)
  }

  if (opts.maintenance) {
    const idxs = opts.maintenance.map((m) => {
      const o: Record<string, number> = {}
      if (m.id != null) o[`_${key.id}`] = push(m.id)
      o[`_${key.title}`] = push(m.title)       // reuses the incident title key index
      o[`_${key.started}`] = push(m.started)   // reuses the incident started key index
      o[`_${key.ended}`] = push(m.ended)
      return push(o)
    })
    const ref = push(idxs)
    push({ [`_${key.scheduledMaintenance}`]: ref })
  }

  if (opts.containers !== false) {
    addKey('incidents')
    addKey('activeIncidents')
    addKey('incidentIds')
    // activeIncidents: refs to the emitted incident objects named in `activeIds`, plus `activeNoId`
    // refs to the id-less placeholder at index 0 (the "we can't identify this active incident" case).
    const active: number[] = [
      ...(opts.activeIds ?? []).map((id) => objIndexById.get(id) ?? 0),
      ...new Array(opts.activeNoId ?? 0).fill(0),
    ]
    // incidentIds: the buckets name every emitted incident by default, else the explicit override.
    const named = opts.bucketIds ?? incidents.map((i) => i.id)
    const container: Record<string, number> = {}
    container[`_${key.incidents}`] = push({})
    container[`_${key.activeIncidents}`] = push(active)
    container[`_${key.incidentIds}`] = push(named.map((id) => push(id)))
    push(container)
  }

  const escaped = JSON.stringify(arr).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `<html><script>window.__reactRouterContext.streamController.enqueue("${escaped}")</script></html>`
}

/** Incidents of a payload that is expected to be readable — fails loudly if it is not. */
function incidentsOf(html: string, nowMs = Date.parse('2026-07-14T00:00:00Z')) {
  const page = parseOnlineOrNotPage(html, nowMs)
  if (!page.ok) throw new Error(`expected a readable payload, got ${page.reason}`)
  return page.incidents
}

describe('parseOnlineOrNotPage — incidents', () => {
  it('parses resolved incidents with correct fields', () => {
    const incidents = incidentsOf(makeHtml([
      { id: 'inc1', title: '401 Errors across API', started: '2026-02-17T05:50:22.123Z', ended: '2026-02-17T07:12:02.870Z', impact: 'MAJOR_OUTAGE' },
    ]))
    expect(incidents).toHaveLength(1)
    expect(incidents[0].id).toBe('inc1')
    expect(incidents[0].title).toBe('401 Errors across API')
    expect(incidents[0].status).toBe('resolved')
    expect(incidents[0].impact).toBe('major')
    expect(incidents[0].duration).toBeTruthy()
    expect(incidents[0].timeline).toHaveLength(2)
    expect(incidents[0].timeline[0]).toEqual({ stage: 'investigating', text: '401 Errors across API', at: '2026-02-17T05:50:22.123Z' })
    expect(incidents[0].timeline[1]).toEqual({ stage: 'resolved', text: '', at: '2026-02-17T07:12:02.870Z' })
  })

  it('parses unresolved incidents', () => {
    const incidents = incidentsOf(makeHtml([
      { id: 'inc2', title: 'Ongoing issue', started: '2026-03-20T10:00:00.000Z', ended: null, impact: 'PARTIAL_OUTAGE' },
    ]))
    expect(incidents).toHaveLength(1)
    expect(incidents[0].status).toBe('investigating')
    expect(incidents[0].impact).toBe('minor')
    expect(incidents[0].duration).toBeNull()
    expect(incidents[0].timeline).toHaveLength(1)
    expect(incidents[0].timeline[0].stage).toBe('investigating')
  })

  it('maps DEGRADED_PERFORMANCE to minor impact', () => {
    const incidents = incidentsOf(makeHtml([
      { id: 'inc3', title: 'Slow responses', started: '2026-03-15T08:00:00.000Z', ended: '2026-03-15T09:00:00.000Z', impact: 'DEGRADED_PERFORMANCE' },
    ]))
    expect(incidents[0].impact).toBe('minor')
  })

  it('sorts by startedAt descending', () => {
    const incidents = incidentsOf(makeHtml([
      { id: 'old', title: 'Old', started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T01:00:00.000Z', impact: 'MAJOR_OUTAGE' },
      { id: 'new', title: 'New', started: '2026-03-01T00:00:00.000Z', ended: '2026-03-01T01:00:00.000Z', impact: 'MAJOR_OUTAGE' },
    ]))
    expect(incidents.map(i => i.id)).toEqual(['new', 'old'])
  })

  it('caps the DISPLAYED list at 25, dropping the oldest', () => {
    const many = Array.from({ length: 30 }, (_, n) => ({
      id: `i${n}`, title: `E${n}`,
      started: `2026-06-${String(n + 1).padStart(2, '0')}T00:00:00.000Z`,
      ended: `2026-06-${String(n + 1).padStart(2, '0')}T01:00:00.000Z`,
      impact: 'MAJOR_OUTAGE',
    }))
    const incidents = incidentsOf(makeHtml(many))
    expect(incidents).toHaveLength(25)
    expect(incidents[0].id).toBe('i29')                       // newest kept
    expect(incidents.some(i => i.id === 'i0')).toBe(false)    // oldest dropped
  })
})

describe('parseOnlineOrNotIncidentHistory (#1134)', () => {
  it('parses the same SSR envelope without requiring home-page containers', () => {
    const result = parseOnlineOrNotIncidentHistory(makeHtml([
      { id: 'history-1', title: 'Older outage', started: '2026-06-01T00:00:00.000Z', ended: '2026-06-01T01:00:00.000Z', impact: 'MAJOR_OUTAGE' },
    ], { containers: false }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.incidents[0].id).toBe('history-1')
  })

  it('rejects an unreadable supplemental page instead of treating it as an empty history', () => {
    expect(parseOnlineOrNotIncidentHistory('<html>redesigned</html>')).toEqual({ ok: false, reason: 'no-payload' })
  })

  it('keeps a measurable home copy when the history copy has null impact', () => {
    const incident = (id: string, impact: Incident['impact']): Incident => ({
      id, title: id, status: 'resolved', impact,
      startedAt: '2026-06-01T00:00:00.000Z', resolvedAt: '2026-06-01T01:00:00.000Z',
      duration: '1h', timeline: [],
    })
    const merged = mergeOnlineOrNotIncidents(
      [incident('shared', 'major')],
      [incident('shared', null), incident('history-only', null)],
    )
    expect(merged.find((i) => i.id === 'shared')?.impact).toBe('major')
    expect(merged.some((i) => i.id === 'history-only')).toBe(true)
  })

  it('applies the 90-day cutoff to supplemental rows only (home payload is never filtered)', () => {
    const makeIncident = (id: string, startedAt: string, impact: Incident['impact'] = null): Incident => ({
      id, title: id, status: 'resolved', impact,
      startedAt, resolvedAt: startedAt, duration: '1m', timeline: [],
    })
    const merged = mergeOnlineOrNotIncidents(
      // A home-payload incident far older than the cutoff — must survive (source already bounds it).
      [makeIncident('home-old', '2026-01-01T00:00:00.000Z', 'major')],
      [makeIncident('inside', '2026-04-24T00:00:00.000Z'), makeIncident('old', '2026-04-23T23:59:59.000Z')],
      Date.parse('2026-07-23T00:00:00.000Z'),
    )
    expect(merged.map((i) => i.id).sort()).toEqual(['home-old', 'inside'])
  })

  it('caps the MERGED home+supplemental set at DISPLAY_LIMIT, keeping the newest', () => {
    const now = Date.parse('2026-07-23T00:00:00.000Z')
    const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString()
    const row = (id: string, daysAgo: number, impact: Incident['impact']): Incident => ({
      id, title: id, status: 'resolved', impact, startedAt: at(daysAgo), resolvedAt: at(daysAgo), duration: '1m', timeline: [],
    })
    // 20 home rows (1–20 days old, newest) + 20 in-window supplemental rows (31–50 days old). `sK` ages
    // 30+K days, so s1 (31d) is the newest supplemental. After the desc sort + slice(25) the 20 home rows
    // plus the 5 NEWEST supplemental (s1..s5, 31–35d) survive; the 15 oldest drop.
    const home = Array.from({ length: 20 }, (_, n) => row(`h${n + 1}`, n + 1, 'major'))
    // Insert supplemental OLDEST-first (s20@50d … s1@31d) so Map-insertion order deliberately DIFFERS
    // from the date-sorted order — this is what makes the test bite if `.sort()` were removed or the
    // cap ran before the sort (either would keep s20..s16, the oldest, not s1..s5).
    const supplemental = Array.from({ length: 20 }, (_, n) => row(`s${20 - n}`, 50 - n, null))
    const merged = mergeOnlineOrNotIncidents(home, supplemental, now)
    expect(merged).toHaveLength(25)
    expect(home.every((h) => merged.some((m) => m.id === h.id))).toBe(true) // no home row dropped
    expect(merged.some((m) => m.id === 's5')).toBe(true)   // 35d — inside the surviving 5 newest supplemental
    expect(merged.some((m) => m.id === 's6')).toBe(false)  // 36d — first supplemental dropped by the cap
    expect(merged.some((m) => m.id === 's20')).toBe(false) // 50d — oldest; a removed/late sort would wrongly keep it
  })

  // Real captures of status.openrouter.ai/incidents?page=1..2, taken 2026-07-23. This is the route
  // the fix newly reads; the fixtures pin that its parse recovers exactly the non-component incidents
  // #1134 identified as missing from the home payload (Clerk login, Bedrock upstream).
  const historyFixture = (name: string) =>
    readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')

  const realHistory = (): Incident[] => {
    const rows: Incident[] = []
    for (const page of ['openrouter-onlineornot-history-p1-2026-07-23.html', 'openrouter-onlineornot-history-p2-2026-07-23.html']) {
      const r = parseOnlineOrNotIncidentHistory(historyFixture(page))
      expect(r.ok).toBe(true)
      if (r.ok) rows.push(...r.incidents)
    }
    return rows
  }

  it('parses the real /incidents route and recovers the non-component history #1134 named', () => {
    const rows = realHistory()
    // The /incidents route carries no impact field — every row is severity-less (the #1134 policy
    // reason these stay excluded from uptime/Score/MTTR).
    expect(rows.every((i) => i.impact === null)).toBe(true)
    const byId = new Map(rows.map((i) => [i.id, i]))
    expect(byId.get('lrkj1G0wmMoe')?.title).toBe('Degraded website login') // Clerk auth (non-component)
    expect(byId.get('opJAdRNJ-dlR')?.title).toBe('Amazon Bedrock Outage')  // upstream (non-component)
  })

  it('merges the real history that falls inside the 90-day window into a clean home payload', () => {
    const history = realHistory()
    // Anchor "now" to just after the newest real row (2026-04-14) so the window is exercised on real
    // data rather than voided by wall-clock drift: the two named non-component incidents (2026-02-19)
    // sit ~55 days back, inside the 90-day window, and must be recovered into the empty home payload.
    const nowMs = Date.parse('2026-04-15T00:00:00.000Z')
    const merged = mergeOnlineOrNotIncidents([], history, nowMs)
    expect(merged.some((i) => i.id === 'lrkj1G0wmMoe')).toBe(true)
    expect(merged.some((i) => i.id === 'opJAdRNJ-dlR')).toBe(true)
    // Prove the cutoff bites: anchored at 2026-06-01 the window opens at 2026-03-03, so the
    // 2026-02-19 non-component rows fall out while the 2026-04-14 row stays.
    const tight = mergeOnlineOrNotIncidents([], history, Date.parse('2026-06-01T00:00:00.000Z'))
    expect(tight.some((i) => i.id === 'lrkj1G0wmMoe')).toBe(false)
    expect(tight.some((i) => i.id === 'QV1jJxwp-Le8')).toBe(true)
  })
})

describe('parseOnlineOrNotPage — the two container copies (#1123)', () => {
  const pair: Inc = { id: 'dup1', title: 'Same incident', started: '2026-07-10T01:00:00.000Z', ended: '2026-07-10T02:00:00.000Z', impact: 'MAJOR_OUTAGE' }

  // The real payload carries each incident in BOTH containers under DIFFERENT key names: the root
  // `incidents` map spells the id `id` and omits `impact`; the per-component daily bucket spells it
  // `incidentId` and carries `impact`. Reading only `incidentId` gave the two copies different dedup
  // keys, so one outage published as two.
  it('collapses the root-map copy and the bucket copy into one incident', () => {
    const incidents = incidentsOf(makeHtml([pair], { duplicate: 'root-first' }))
    expect(incidents).toHaveLength(1)
    expect(incidents[0].id).toBe('dup1')
  })

  // Both directions: the merge must not depend on which copy the payload happens to emit first.
  it('keeps the severity whichever copy is emitted first', () => {
    for (const duplicate of ['root-first', 'bucket-first'] as const) {
      const incidents = incidentsOf(makeHtml([pair], { duplicate }))
      expect(incidents, duplicate).toHaveLength(1)
      expect(incidents[0].impact, duplicate).toBe('major')
    }
  })

  it('takes the resolution from the copy that has one, in either emission order', () => {
    // The bucket copy is a denormalized snapshot; a stale one still calling an incident open must not
    // overwrite the root copy's resolution, or the service never publishes a recovery. Here the two
    // copies genuinely DISAGREE: bucket open, root resolved.
    for (const duplicate of ['root-first', 'bucket-first'] as const) {
      const incidents = incidentsOf(makeHtml(
        [{ ...pair, ended: null }],
        { duplicate, rootResolvedAt: '2026-07-10T02:00:00.000Z' },
      ))
      expect(incidents, duplicate).toHaveLength(1)
      expect(incidents[0].status, duplicate).toBe('resolved')
      expect(incidents[0].resolvedAt, duplicate).toBe('2026-07-10T02:00:00.000Z')
      expect(incidents[0].impact, duplicate).toBe('major')   // severity still from the bucket copy
    }
  })
})

describe('parseOnlineOrNotPage — maintenance filtering', () => {
  // #894 — planned maintenance must NOT be parsed as an incident. This asserts the STRUCTURAL filter
  // (the source's own `scheduledMaintenance` grouping) on a title the #896 regex cannot match. The
  // earlier tests all used "Scheduled Database Maintenance", which the title backstop already caught
  // — so deleting the structural filter entirely left them green, and the docstring's claim that
  // "custom-titled maintenance is caught" was never actually exercised.
  it('excludes custom-titled maintenance via the source grouping, not the title (#894)', () => {
    const html = makeHtml([], { maintenance: [{ title: 'Database upgrade window', started: '2026-07-05T06:00:39.333Z', ended: null }] })
    expect(incidentsOf(html)).toEqual([])
  })

  it('excludes maintenance whose title the regex also matches (#894)', () => {
    const html = makeHtml([], { maintenance: [{ title: 'Scheduled Database Maintenance', started: '2026-07-05T06:00:39.333Z', ended: null }] })
    expect(incidentsOf(html)).toEqual([])
  })

  it('keeps real incidents while excluding maintenance (#894)', () => {
    const incidents = incidentsOf(makeHtml(
      [{ id: 'real1', title: '[Automated] Generation was inaccessible', started: '2026-07-08T17:02:56.209Z', ended: '2026-07-08T18:07:52.805Z', impact: 'MAJOR_OUTAGE' }],
      { maintenance: [{ title: 'Database upgrade window', started: '2026-07-05T06:00:39.333Z', ended: null }] },
    ))
    expect(incidents).toHaveLength(1)
    expect(incidents[0].id).toBe('real1')
    expect(incidents[0].impact).toBe('major')
  })

  // #896 — a COMPLETED maintenance is relocated out of `scheduledMaintenance`, so it arrives
  // as a normal resolved entry; the title backstop must still exclude it.
  it('excludes a completed maintenance that leaked out of the scheduledMaintenance group (#896)', () => {
    const html = makeHtml([
      { id: 'm-done', title: 'Scheduled Database Maintenance', started: '2026-07-05T06:00:39.333Z', ended: '2026-07-05T06:30:32.830Z', impact: '' },
    ])
    expect(incidentsOf(html)).toEqual([])
  })

  it('keeps a real resolved incident whose title merely mentions maintenance mode (#896)', () => {
    // MAINTENANCE_TITLE deliberately does NOT match "Stuck in maintenance mode".
    const incidents = incidentsOf(makeHtml([
      { id: 'real-inc', title: 'Stuck in maintenance mode', started: '2026-07-05T06:00:00.000Z', ended: '2026-07-05T07:00:00.000Z', impact: 'MAJOR_OUTAGE' },
    ]))
    expect(incidents).toHaveLength(1)
    expect(incidents[0].id).toBe('real-inc')
  })
})

describe('parseOnlineOrNotPage — structural failures (#1123)', () => {
  it('an unreadable page is a FAILURE, not "no incidents"', () => {
    expect(parseOnlineOrNotPage('<html>no data</html>')).toEqual({ ok: false, reason: 'no-payload' })
    expect(parseOnlineOrNotPage('')).toEqual({ ok: false, reason: 'no-payload' })
  })

  it('reports payload-truncated when the envelope has no closing bracket', () => {
    const html = '<html><script>streamController.enqueue("[1,2")</script></html>'
    expect(parseOnlineOrNotPage(html)).toEqual({ ok: false, reason: 'payload-truncated' })
  })

  it('reports onot-bad-json when the envelope is present but its contents are not JSON', () => {
    const html = '<html><script>streamController.enqueue("[not json,,]")</script></html>'
    expect(parseOnlineOrNotPage(html)).toEqual({ ok: false, reason: 'onot-bad-json' })
  })

  it('a payload without the statusPage marker is not-status-page (never a fabricated 100%)', () => {
    const html = makeHtml([], { marker: false })
    expect(parseOnlineOrNotPage(html)).toEqual({ ok: false, reason: 'not-status-page' })
  })

  it('a status page whose incident containers are gone is a failure, not a clean page', () => {
    const html = makeHtml([], { containers: false })
    expect(parseOnlineOrNotPage(html)).toEqual({ ok: false, reason: 'no-incident-container' })
  })

  it('requires incidentIds specifically — a coordinated rename that drops it must not read as clean', () => {
    // The container reader must fail closed on a MISSING `incidentIds`, not fall back to trusting the
    // (now empty) incident list — that open-failure is what let a key rename read as a fabricated 100%.
    // Built directly: a status page carrying `incidents` + `activeIncidents` but NOT `incidentIds`.
    const arr: unknown[] = [{}, 'loaderData', 'statusPage', 'incidents', 'activeIncidents',
      { _3: 6, _4: 7 }, {}, []]
    const escaped = JSON.stringify(arr).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    expect(parseOnlineOrNotPage(`<html><script>streamController.enqueue("${escaped}")</script></html>`))
      .toEqual({ ok: false, reason: 'no-incident-container' })
  })

  // The cross-check that closes the dangerous direction: markers + containers intact, but the
  // incident OBJECTS moved. Without it these return `{ok:true, incidents:[], uptime30d:100}` —
  // a confident, fabricated 100% "official" uptime on a page full of outages, which is strictly
  // worse than the withheld-uptime bug this issue was filed for.
  it('fails when the buckets name incidents we did not parse (key rename)', () => {
    // No incident objects at all, but a bucket still names one → we did not read the list.
    const html = makeHtml([], { bucketIds: ['LB6mQvzYAkoz'] })
    expect(parseOnlineOrNotPage(html)).toEqual({ ok: false, reason: 'incidents-unreadable' })
  })

  it('fails when the page names an active incident whose id we cannot even read', () => {
    // An `activeIncidents` entry pointing at an object we can't identify → activeUnreadable.
    const html = makeHtml([], { activeNoId: 1 })
    expect(parseOnlineOrNotPage(html)).toEqual({ ok: false, reason: 'incidents-unreadable' })
  })

  // C2/I2 isolated: an active incident whose ROW is unreadable, beside a GOOD parsed incident. The
  // good one keeps `incidents` non-empty so the "every row unreadable" belt cannot fire — only the
  // id-level `missing` check, fed by `activeIds`, catches the vanished ongoing outage. Reading only
  // `expectedIds` (dropping activeIds) or accounting a seen-but-unparsed id would let it slip through.
  it('fails when an ACTIVE incident row is unreadable even beside a good incident (C2/I2)', () => {
    const good = { id: 'good1', title: 'Resolved blip', started: '2026-07-12T00:00:00.000Z', ended: '2026-07-12T01:00:00.000Z', impact: 'MAJOR_OUTAGE' }
    const live = { id: 'live1', title: 'Total outage', started: '2026-07-13T00:00:00.000Z', ended: null, impact: 'MAJOR_OUTAGE' }
    const html = makeHtml([good, live], {
      brokenStarted: 1752000000000, brokenIds: ['live1'],  // only the active one is unreadable
      activeIds: ['live1'], bucketIds: ['good1'],           // buckets name only the good one
    })
    expect(parseOnlineOrNotPage(html)).toEqual({ ok: false, reason: 'incidents-unreadable' })
  })

  it('fails when every incident row has an unreadable started (type/format change)', () => {
    const inc = { id: 'x1', title: 'Outage', started: '2026-07-10T01:00:00.000Z', ended: null, impact: 'MAJOR_OUTAGE' }
    for (const brokenStarted of [1752000000000, '2026-07-10 01:00:00Z', null]) {
      const html = makeHtml([inc], { brokenStarted })
      expect(parseOnlineOrNotPage(html), String(brokenStarted)).toEqual({ ok: false, reason: 'incidents-unreadable' })
    }
  })

  // The belt: unreadable rows that NO container names (no bucket, not active) — so `missing` cannot
  // catch them. `bucketIds: []` strips the naming, leaving the whole-payload-unreadable belt as the
  // only guard between this and a fabricated clean page.
  it('fails via the belt when unreadable rows are named by nothing', () => {
    const inc = { id: 'x1', title: 'Outage', started: '2026-07-10T01:00:00.000Z', ended: null, impact: 'MAJOR_OUTAGE' }
    const html = makeHtml([inc], { brokenStarted: 1752000000000, bucketIds: [] })
    expect(parseOnlineOrNotPage(html)).toEqual({ ok: false, reason: 'incidents-unreadable' })
  })

  // #1123 round-2 review C1: a COMPLETED maintenance stays in the payload ~91 days, so it must NOT
  // blanket-excuse an unreadable ACTIVE incident. Here a 60-day-old completed maintenance coexists
  // with an active incident we failed to parse — the page must still fail, not read as clean.
  it('an old completed maintenance does not excuse a separate unreadable active incident', () => {
    const html = makeHtml([], {
      maintenance: [{ id: 'm-old', title: 'Scheduled Database Maintenance', started: '2026-05-14T06:00:00.000Z', ended: '2026-05-14T06:30:00.000Z' }],
      activeNoId: 1,
    })
    expect(parseOnlineOrNotPage(html)).toEqual({ ok: false, reason: 'incidents-unreadable' })
  })

  it('does NOT fail when the named incident really was maintenance we filtered by id', () => {
    // The cross-check must not mistake a correct filter for a failed read: the id the bucket names
    // IS the maintenance entry's id, which we account as maintenance, not as unreadable.
    const html = makeHtml([], {
      maintenance: [{ id: 'm1', title: 'Database upgrade window', started: '2026-07-05T06:00:00.000Z', ended: null }],
      bucketIds: ['m1'],
    })
    const page = parseOnlineOrNotPage(html)
    expect(page.ok).toBe(true)
    if (page.ok) expect(page.incidents).toEqual([])
  })
})

describe('computed uptime (#1006 — computed from incidents, not the aggregate)', () => {
  const NOW = Date.parse('2026-07-14T00:00:00Z')
  const DAY = 86_400_000
  const ago = (d: number) => new Date(NOW - d * DAY).toISOString()
  const inc = (id: string, startDaysAgo: number, hours: number, impact: string) => ({
    id, title: `${impact} event`, started: ago(startDaysAgo),
    ended: new Date(NOW - startDaysAgo * DAY + hours * 3_600_000).toISOString(), impact,
  })
  const uptimeOf = (html: string) => {
    const page = parseOnlineOrNotPage(html, NOW)
    return page.ok ? page.uptime30d : null
  }

  // #1123 — the regression this issue was filed for. A page with NO incidents carries none of the
  // incident key names, which the old guard read as "not an OnlineOrNot page" → uptime null → the
  // Score dropped its whole 40-point Uptime component on a service that was in fact perfect.
  it('a clean 30-day window is 100% — even though the payload has no incident keys at all', () => {
    expect(uptimeOf(makeHtml([]))).toBe(100)
  })

  it('a 24h MAJOR_OUTAGE is weighted 1.0 — 1 day of 30', () => {
    expect(uptimeOf(makeHtml([inc('i1', 5, 24, 'MAJOR_OUTAGE')]))).toBe(96.66)
  })

  it('DEGRADED/PARTIAL is weighted 0.3, per /methodology', () => {
    // 24h × 0.3 = 7.2h of 30 days → 99.00%
    expect(uptimeOf(makeHtml([inc('i1', 5, 24, 'DEGRADED_PERFORMANCE')]))).toBe(99)
    expect(uptimeOf(makeHtml([inc('i1', 5, 24, 'PARTIAL_OUTAGE')]))).toBe(99)
  })

  it('an incident OUTSIDE the 30-day window does not count', () => {
    expect(uptimeOf(makeHtml([inc('i1', 60, 24, 'MAJOR_OUTAGE')]))).toBe(100)
  })

  // An ONGOING incident is clamped to now. Without this the page can show an active outage beside a
  // spotless 100% — the incoherence `uptime-interval.ts` rule 1 exists to prevent, and the state a
  // user is most likely to be looking at the page during.
  it('an ONGOING incident counts up to now', () => {
    const open = { id: 'open1', title: 'Still down', started: ago(2), ended: null, impact: 'MAJOR_OUTAGE' }
    expect(uptimeOf(makeHtml([open]))).toBe(93.33)
  })

  // The 25-item display cap is sorted newest-first, so computing uptime over the CAPPED list drops
  // older incidents that are still inside the window and publishes an inflated figure.
  it('uses the FULL list, not the 25-item display cap', () => {
    const forty = Array.from({ length: 40 }, (_, n) => inc(`i${n}`, n * 0.5 + 1, 1, 'MAJOR_OUTAGE'))
    // 40 × 1h = 40h of 720h → 94.44%. Computing over only the newest 25 would read ~96.5%.
    expect(uptimeOf(makeHtml(forty))).toBe(94.44)
  })
})

// #1017 — this file's shared NOW (above) is exactly midnight UTC, so todayWeightedOutageSec would
// always read 0 there (a genuinely zero-length "today so far" window, not a computation gap — same
// reason incident-io.test.ts needed its own separate mid-day NOW, see there). A second NOW mid-day is
// needed to exercise a non-zero value end-to-end through the real parser (had zero coverage before).
describe('todayWeightedOutageSec (#1017)', () => {
  const MID_DAY = Date.parse('2026-07-14T15:00:00Z') // 15h into the UTC day
  const midAgo = (msAgo: number) => new Date(MID_DAY - msAgo).toISOString()

  it('reflects only the portion of an outage inside today', () => {
    // 2h outage entirely inside today: started 3h ago, ended 1h ago.
    const impact = { id: 'i1', title: 'Outage', started: midAgo(3 * 3_600_000), ended: midAgo(1 * 3_600_000), impact: 'MAJOR_OUTAGE' }
    const page = parseOnlineOrNotPage(makeHtml([impact]), MID_DAY)
    expect(page.ok && page.todayWeightedOutageSec).toBe(2 * 3600) // 2h at full weight (1.0)
  })

  it('an outage entirely before today contributes 0, but still counts toward the 30-day pct', () => {
    const yesterday9pm = MID_DAY - 18 * 3_600_000
    const impact = { id: 'i1', title: 'Outage', started: new Date(yesterday9pm - 3_600_000).toISOString(), ended: new Date(yesterday9pm).toISOString(), impact: 'MAJOR_OUTAGE' }
    const page = parseOnlineOrNotPage(makeHtml([impact]), MID_DAY)
    expect(page.ok && page.todayWeightedOutageSec).toBe(0)
    expect(page.ok && page.uptime30d).toBeLessThan(100)
  })
})

// #1123 — captured live/archived status.openrouter.ai pages. The hand-built fixture above describes
// what we BELIEVE the payload looks like; these are what it actually is, at three points across
// eight months. A shape change now fails the test instead of the site.
//
// KNOWN COVERAGE GAP (#1123 round-3 review): all three captures have `activeIncidents: []`, so the
// `activeIds` / `activeUnreadable` cross-check is exercised only by the synthetic tests above, which
// ENCODE an assumption — an `activeIncidents` entry is a ref to a full incident object with a
// readable id. If the live active shape turns out leaner (an id-only object, a placeholder), the
// strict `activeUnreadable > 0` failure could flap openrouter to sourceUnknown during a real ongoing
// outage. Capture a live page the next time openrouter has an OPEN incident and pin it here.
describe('real captured payloads (#1123)', () => {
  const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')

  it('2026-07-22 live — a genuinely incident-free page reads 100%, not "no official uptime"', () => {
    const page = parseOnlineOrNotPage(
      fixture('openrouter-onlineornot-clean-2026-07-22.html'),
      Date.parse('2026-07-22T12:00:00Z'),
    )
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.incidents).toEqual([])
    expect(page.uptime30d).toBe(100)
  })

  // The root `incidents` map (15 date-keyed entries — today plus the 14 prior days, the window the
  // page labels "the last 14 days" — keyed `id`, no `impact`) and the per-component daily buckets
  // (91 days, keyed `incidentId`, with `impact`) both carry these two incidents. Before the fix they
  // parsed as FOUR — each incident once with its severity and once without — inflating the incident
  // count into the Score and firing two Discord alerts per outage.
  it('2025-12-06 archived — the same incident in both containers collapses to one, keeping its impact', () => {
    const page = parseOnlineOrNotPage(
      fixture('openrouter-onlineornot-incidents-2025-12-06.html'),
      Date.parse('2025-12-06T02:27:53Z'),
    )
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.incidents.map(i => i.id)).toEqual(['LB6mQvzYAkoz', 'wn6mpXyB9WoP'])
    // Severity survives the merge — the impact-less root copy must not win.
    expect(page.incidents.every(i => i.impact === 'major')).toBe(true)
    expect(page.incidents.every(i => i.status === 'resolved')).toBe(true)
    expect(page.uptime30d).toBe(99.89)
  })

  it('2026-03-08 archived — reads the daily buckets when the root incidents map is empty', () => {
    const page = parseOnlineOrNotPage(
      fixture('openrouter-onlineornot-incidents-2026-03-08.html'),
      Date.parse('2026-03-08T04:01:57Z'),
    )
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.incidents).toHaveLength(8)
    // Every incident is deduplicated across the components it hit (one event, several components).
    expect(new Set(page.incidents.map(i => i.id)).size).toBe(8)
    expect(page.incidents[0].id).toBe('LKwmDP5kAVB2')
    expect(page.incidents.find(i => i.title === '401 Errors across API surfaces')?.impact).toBe('major')
    expect(page.incidents.find(i => i.title.startsWith('API Request Logs'))?.impact).toBe('minor')
    expect(page.uptime30d).toBe(99.5)
  })
})

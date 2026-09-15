import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDatadogStatusPage } from '../datadog'

// Captured from https://status.openrouter.ai/config.json on 2026-09-15 (#1403) — the whole document,
// unedited, so a shape assumption that only holds on a hand-written literal fails here instead.
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/openrouter-datadog-2026-09-15.json'), 'utf8'),
)

/** Frozen clock. Both expectations below were derived from the fixture's own timestamps
 *  INDEPENDENTLY of this parser (a separate reimplementation of the weighting), so they pin the
 *  arithmetic rather than whatever the code currently happens to produce. */
const NOW = Date.parse('2026-09-15T00:00:00.000Z')

const CHAT = '9fb5ccff-e128-455a-be20-59572f8d363a'
const VIDEO = 'bb2402ad-3e98-4c75-9eb5-ca68ca683c5a'

/** A minimal document in the platform's real shape — one group with one leaf, plus one incident. */
function doc(overrides: Record<string, unknown> = {}) {
  return {
    name: 'OpenRouter',
    components: [
      {
        id: 'group', name: 'API - Gateway', position: 0, type: 'ComponentGroup',
        components: [{ id: CHAT, name: 'Chat', position: 0, status: 'operational', type: 'Component' }],
      },
    ],
    incidents: [],
    maintenances: null,
    ...overrides,
  }
}

/** One incident: `degraded` from `start` until `end`, then resolved. */
function incident(start: string, end: string | null, status = 'degraded', id = 'inc-1') {
  return {
    id,
    title: 'Something degraded',
    currentStatus: end ? 'resolved' : 'investigating',
    publishedDate: start,
    resolvedDate: end,
    resolved: end !== null,
    componentsAffected: [{ id: CHAT, name: 'Chat', status: end ? 'operational' : status, type: 'Component' }],
    timeline: [
      // Deliberately newest-first: the platform emits these unordered, and a parser that trusts
      // array order would compute segments backwards.
      ...(end ? [{ id: 't2', status: 'resolved', description: 'Resolved', startedAt: end, createdAt: end, componentsAffected: [{ id: CHAT, name: 'Chat', status: 'operational', type: 'Component' }] }] : []),
      { id: 't1', status: 'investigating', description: 'Looking into it', startedAt: start, createdAt: start, componentsAffected: [{ id: CHAT, name: 'Chat', status, type: 'Component' }] },
    ],
  }
}

describe('#1403 Datadog Status Page parser — the real captured document', () => {
  it('reads the component tree, the incidents, and computes uptime from their timelines', () => {
    const parsed = parseDatadogStatusPage(FIXTURE, NOW)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.page.status).toBe('operational')
    expect(parsed.page.incidents).toHaveLength(4)
    // Namespaced so a migrated id can never collide with the id space of the source it replaced.
    expect(parsed.page.incidents.every((i) => i.id.startsWith('datadog:'))).toBe(true)
    // Newest first.
    expect(parsed.page.incidents[0].title).toBe('Degraded video generation API')

    // The WORST component, not a pool: `Web & Application Services` carries 15h28m of `degraded`
    // (16,704 weighted seconds over 2,592,000). Chat's 4m and Video's 2h45m sit on other components
    // and do not add to it — the page renders a percentage per component and no page-level figure.
    expect(parsed.page.uptime30d).toBe(99.35)
  })

  it('#1006 — reproduces the % the provider shows its own visitors, for the reader to check us against', () => {
    const parsed = parseDatadogStatusPage(FIXTURE, NOW)
    if (!parsed.ok) throw new Error('fixture must parse')

    // Verified against the LIVE page on 2026-09-15: every component rendered "100.00% uptime" over
    // "Jun 18, 2026 – Sep 15, 2026". If this figure ever stops being 100.00 on this fixture, either
    // the provider's severity rule or its window bound changed, and the reproduction is stale.
    expect(parsed.page.reported).toEqual({ pct: 100, days: 90 })

    // And the gap to OUR figure is the WEIGHTING, not the window: the provider ignores `degraded`
    // entirely and every in-window incident is degraded, so recomputing the provider's rule onto 30
    // days is still 100.00. Publishing 99.35 with no provider number beside it would leave a reader
    // unable to tell a real 0.65% of downtime from a difference of definition.
    expect(parsed.page.uptime30d).toBe(99.35)
  })

  it('separates the two reasons the figures differ — the window and the severity rule', () => {
    // A FULL outage weighs 1.0 under both rules, so the only thing left to separate them is the
    // window: 1h over our 30 days vs the provider's 90.
    const byWindow = parseDatadogStatusPage(doc({
      created: '2026-01-01T00:00:00Z',
      incidents: [incident('2026-09-10T01:00:00Z', '2026-09-10T02:00:00Z', 'major_outage')],
    }), NOW)
    if (!byWindow.ok) throw new Error('must parse')
    expect(byWindow.page.uptime30d).toBe(99.86)
    expect(byWindow.page.reported).toEqual({ pct: 99.95, days: 90 })
  })

  it('bounds BOTH windows by the reach of the page records, and discloses the short one', () => {
    // The page was created four days ago — a genuinely new page. Claiming 90
    // days for the provider would attribute a figure its page never shows; claiming 30 for ours would
    // publish a confident percentage over a window the records do not cover. The reach bounds both,
    // and `uptimeWindowDays` is what tells the rest of the system (#1004, #802) that it is short.
    const parsed = parseDatadogStatusPage(doc({
      created: '2026-09-11T00:00:00Z',
      incidents: [incident('2026-09-12T01:00:00Z', '2026-09-12T02:00:00Z', 'degraded')],
    }), NOW)
    if (!parsed.ok) throw new Error('must parse')
    expect(parsed.page.uptimeWindowDays).toBe(4)
    // 1h of `degraded` over 4 days: 1,080 weighted seconds of 345,600 for us, and zero for the
    // provider, whose rule ignores `degraded` — so the two disagree and the disclosure is emitted.
    expect(parsed.page.uptime30d).toBe(99.68)
    expect(parsed.page.reported).toEqual({ pct: 100, days: 4 })
  })

  it('emits no window disclosure when the records cover the full 30 days', () => {
    const parsed = parseDatadogStatusPage(FIXTURE, NOW)
    if (!parsed.ok) throw new Error('fixture must parse')
    expect(parsed.page.uptimeWindowDays).toBeNull()
  })

  it('omits the reproduction when it agrees with our own figure', () => {
    // The field is a DISCLOSURE of a difference; repeating our own number as the provider's is noise.
    const clean = parseDatadogStatusPage(doc({
      created: '2026-01-01T00:00:00Z',
      incidents: [incident('2026-02-01T01:00:00Z', '2026-02-01T02:00:00Z', 'major_outage')],
    }), NOW)
    if (!clean.ok) throw new Error('must parse')
    expect(clean.page.uptime30d).toBe(100)
    expect(clean.page.reported).toBeNull()
  })

  it('takes severity from the TIMELINE, not from the incident-level componentsAffected', () => {
    const parsed = parseDatadogStatusPage(FIXTURE, NOW)
    if (!parsed.ok) throw new Error('fixture must parse')
    const video = parsed.page.incidents.find((i) => i.id.endsWith('2a3d415a-1eed-417f-b269-6e308a7f7990'))!

    // Every incident on this page is RESOLVED, so its incident-level `componentsAffected` reports
    // each component's CURRENT status — `operational`. Reading severity there would score every
    // resolved outage at weight 0 and publish a spotless 100% with `uptimeSource: 'official'`
    // attached. The timeline's `degraded` entry is what this must read.
    expect(FIXTURE.incidents.every((i: { componentsAffected: Array<{ status: string }> }) =>
      i.componentsAffected.every((c) => c.status === 'operational'))).toBe(true)
    expect(video.impact).toBe('minor')
    expect(parsed.page.uptime30d).toBeLessThan(100)
  })

  it('maps the resolved record onto the display shape', () => {
    const parsed = parseDatadogStatusPage(FIXTURE, NOW)
    if (!parsed.ok) throw new Error('fixture must parse')
    const video = parsed.page.incidents[0]
    expect(video).toMatchObject({
      status: 'resolved',
      startedAt: '2026-09-04T18:27:00Z',
      resolvedAt: '2026-09-04T21:12:00Z',
      duration: '2h 45m',
      componentNames: ['Video (/api/v1/videos)'],
      componentIds: [VIDEO],
    })
    // Timeline is re-sorted oldest-first regardless of the source's emission order.
    expect(video.timeline.map((t) => t.stage)).toEqual(['investigating', 'resolved'])
  })

  it('#1017 — todayWeightedOutageSec covers the UTC day only, over the same intervals', () => {
    const parsed = parseDatadogStatusPage(FIXTURE, Date.parse('2026-09-04T22:00:00.000Z'))
    if (!parsed.ok) throw new Error('fixture must parse')
    // The 2h45m video incident, that same UTC day, at weight 0.3.
    expect(parsed.page.todayWeightedOutageSec).toBe(2970)
  })

  it('never reads `maintenances` as incidents — including when the page publishes it as null', () => {
    expect(FIXTURE.maintenances).toBeNull()
    const withWindows = parseDatadogStatusPage({
      ...FIXTURE,
      maintenances: [{
        id: 'mw-1', title: 'Scheduled Database Maintenance', currentStatus: 'completed',
        publishedDate: '2026-09-10T01:00:00Z', resolvedDate: '2026-09-10T03:00:00Z', resolved: true,
        componentsAffected: [{ id: CHAT, name: 'Chat', status: 'maintenance', type: 'Component' }],
        timeline: [{ id: 'mt', status: 'completed', description: 'Done', startedAt: '2026-09-10T01:00:00Z', createdAt: '2026-09-10T01:00:00Z', componentsAffected: [{ id: CHAT, name: 'Chat', status: 'maintenance', type: 'Component' }] }],
      }],
    }, NOW)
    if (!withWindows.ok) throw new Error('must parse')
    // `maintenances` is a SEPARATE top-level array here, so the #894/#896 "maintenance reuses the
    // incident keys" class the previous OpenRouter parser was bitten by twice has no path in.
    expect(withWindows.page.incidents).toHaveLength(4)
    expect(withWindows.page.incidents.some((i) => /Maintenance/i.test(i.title))).toBe(false)
    expect(withWindows.page.uptime30d).toBe(99.35)
  })
})

describe('#1403 Datadog parser — an unreadable document must never read as a clean one', () => {
  it('refuses an incident whose timeline names no component status at all', () => {
    // The fail-open this guard exists to close: strip `componentsAffected` from every timeline entry
    // and each segment scores 0, which would publish 100% uptime with `uptimeSource: 'official'`
    // attached off a document we no longer understand (the #1123 shape).
    const stripped = {
      ...FIXTURE,
      incidents: FIXTURE.incidents.map((i: Record<string, unknown>) => ({
        ...i,
        timeline: (i.timeline as Array<Record<string, unknown>>).map(({ componentsAffected, ...rest }) => rest),
      })),
    }
    expect(parseDatadogStatusPage(stripped, NOW)).toEqual({ ok: false, reason: 'dd-incident-unreadable' })
  })

  it('keeps an incident whose timeline says every component stayed operational', () => {
    // The converse of the check above, and the reason it tests for ABSENCE rather than for a zero
    // weight: a notice that degraded nothing is a real, legitimate zero and must still be listed.
    const parsed = parseDatadogStatusPage(doc({
      incidents: [incident('2026-09-10T01:00:00Z', '2026-09-10T02:00:00Z', 'operational')],
    }), NOW)
    if (!parsed.ok) throw new Error('must parse')
    expect(parsed.page.incidents).toHaveLength(1)
    expect(parsed.page.incidents[0].impact).toBeNull()
    expect(parsed.page.uptime30d).toBe(100)
  })

  it('refuses an update with no `startedAt` instead of collapsing every segment onto the filing time', () => {
    // The fail-open this replaced a fallback to close. `createdAt` is the FILING time and a backfilled
    // incident shares one across all its updates, so falling back to it made every segment
    // zero-length: the fixture published `uptime30d: 100`, `uptimeSource: 'official'` and four
    // correctly-rendered incidents off a document whose event times we could no longer read.
    const stripped = {
      ...FIXTURE,
      incidents: FIXTURE.incidents.map((i: Record<string, unknown>) => ({
        ...i,
        timeline: (i.timeline as Array<Record<string, unknown>>).map(({ startedAt, ...rest }) => rest),
      })),
    }
    expect(parseDatadogStatusPage(stripped, NOW)).toEqual({ ok: false, reason: 'dd-incident-unreadable' })
  })

  it('refuses a record whose `resolved` is not a boolean', () => {
    // `=== true` read a RENAMED field as "still open", publishing `status: 'resolved'` beside
    // `resolvedAt: null` on every closed incident and leaving the final segment unbounded.
    const renamed = {
      ...FIXTURE,
      incidents: FIXTURE.incidents.map(({ resolved, ...rest }: Record<string, unknown>) => rest),
    }
    expect(parseDatadogStatusPage(renamed, NOW)).toEqual({ ok: false, reason: 'dd-incident-unreadable' })
  })

  it('refuses a component status word it does not know', () => {
    const parsed = parseDatadogStatusPage(doc({
      components: [{ id: CHAT, name: 'Chat', position: 0, status: 'brown_out', type: 'Component' }],
    }), NOW)
    expect(parsed).toEqual({ ok: false, reason: 'dd-component-status-unreadable' })
  })

  it('refuses an unknown status word inside an incident timeline', () => {
    const parsed = parseDatadogStatusPage(doc({
      incidents: [incident('2026-09-10T01:00:00Z', '2026-09-10T02:00:00Z', 'brown_out')],
    }), NOW)
    expect(parsed).toEqual({ ok: false, reason: 'dd-incident-unreadable' })
  })

  it('refuses a component tree that yields no leaf component', () => {
    // What a wholesale redesign looks like. Reading it as "nothing is wrong" would publish
    // `operational` plus a spotless uptime off a document we did not parse.
    expect(parseDatadogStatusPage(doc({ components: [] }), NOW))
      .toEqual({ ok: false, reason: 'dd-components-unreadable' })
    expect(parseDatadogStatusPage(doc({
      components: [{ id: 'g', name: 'G', type: 'ComponentGroup', components: [] }],
    }), NOW)).toEqual({ ok: false, reason: 'dd-components-unreadable' })
  })

  it('refuses a document whose `incidents` is not an array', () => {
    for (const incidents of [undefined, null, {}, 'none']) {
      expect(parseDatadogStatusPage(doc({ incidents }), NOW))
        .toEqual({ ok: false, reason: 'dd-envelope-unreadable' })
    }
    expect(parseDatadogStatusPage('<!DOCTYPE html>', NOW))
      .toEqual({ ok: false, reason: 'dd-envelope-unreadable' })
  })

  it('refuses a record that claims to be resolved but carries no readable resolution stamp', () => {
    // Neither reading is safe: "open" accrues downtime to now, "instant" accrues none.
    const broken = incident('2026-09-10T01:00:00Z', '2026-09-10T02:00:00Z')
    broken.resolvedDate = 'pending'
    expect(parseDatadogStatusPage(doc({ incidents: [broken] }), NOW))
      .toEqual({ ok: false, reason: 'dd-incident-unreadable' })
  })
})

describe('#1403 Datadog parser — status and uptime arithmetic', () => {
  it('derives the card status from the worst LEAF, through the group tree', () => {
    const tree = (status: string) => [{
      id: 'g', name: 'API - Gateway', type: 'ComponentGroup',
      components: [
        { id: CHAT, name: 'Chat', status: 'operational', type: 'Component' },
        { id: VIDEO, name: 'Video', status, type: 'Component' },
      ],
    }]
    const statusOf = (s: string) => {
      const parsed = parseDatadogStatusPage(doc({ components: tree(s) }), NOW)
      if (!parsed.ok) throw new Error(`must parse: ${s}`)
      return parsed.page.status
    }
    expect(statusOf('operational')).toBe('operational')
    expect(statusOf('degraded')).toBe('degraded')
    expect(statusOf('partial_outage')).toBe('degraded')
    expect(statusOf('major_outage')).toBe('down')
    // Announced maintenance is not a live outage — the rule every other source here follows. A
    // scheduled window must not answer "yes" on /is-openrouter-down or pull fallback recommendations.
    expect(statusOf('maintenance')).toBe('operational')
  })

  it('accrues downtime to NOW for an incident that is still open', () => {
    const now = Date.parse('2026-09-15T02:00:00.000Z')
    const parsed = parseDatadogStatusPage(doc({
      incidents: [incident('2026-09-15T00:00:00Z', null, 'major_outage')],
    }), now)
    if (!parsed.ok) throw new Error('must parse')
    expect(parsed.page.incidents[0].status).toBe('investigating')
    expect(parsed.page.incidents[0].resolvedAt).toBeNull()
    // Two hours at weight 1.0 — uptime is consulted DURING an outage, so dropping an open incident
    // would show a spotless figure next to a live one.
    expect(parsed.page.todayWeightedOutageSec).toBe(7200)
  })

  it('charges each timeline segment at its OWN severity, not the incident\'s worst throughout', () => {
    const parsed = parseDatadogStatusPage(doc({
      incidents: [{
        id: 'esc', title: 'Escalating', currentStatus: 'resolved',
        publishedDate: '2026-09-15T00:00:00Z', resolvedDate: '2026-09-15T03:00:00Z', resolved: true,
        componentsAffected: [{ id: CHAT, name: 'Chat', status: 'operational', type: 'Component' }],
        timeline: [
          { id: 'a', status: 'investigating', description: null, startedAt: '2026-09-15T00:00:00Z', createdAt: '2026-09-15T00:00:00Z', componentsAffected: [{ id: CHAT, name: 'Chat', status: 'degraded', type: 'Component' }] },
          { id: 'b', status: 'identified', description: null, startedAt: '2026-09-15T02:00:00Z', createdAt: '2026-09-15T02:00:00Z', componentsAffected: [{ id: CHAT, name: 'Chat', status: 'major_outage', type: 'Component' }] },
        ],
      }],
    }), Date.parse('2026-09-15T03:00:00.000Z'))
    if (!parsed.ok) throw new Error('must parse')
    // 2h degraded (0.3) + 1h full outage (1.0) = 2160 + 3600. Charging the whole 3h at the worst
    // weight would read 10800; summing the two overlapping readings would read more still.
    expect(parsed.page.todayWeightedOutageSec).toBe(5760)
    expect(parsed.page.incidents[0].impact).toBe('major')
  })

  it('charges a DE-escalating incident per segment too — the direction worst-of cannot hide', () => {
    // The escalating case above passes even if each segment is (wrongly) run to the resolution stamp,
    // because the sweep line takes the worst weight active at each instant and the worst comes LAST.
    // De-escalation is the direction that separates them: run the opening `major_outage` segment to
    // the resolution and the final hour is charged at 1.0 instead of 0.3.
    const parsed = parseDatadogStatusPage(doc({
      incidents: [{
        id: 'de-esc', title: 'Recovering', currentStatus: 'resolved',
        publishedDate: '2026-09-15T00:00:00Z', resolvedDate: '2026-09-15T03:00:00Z', resolved: true,
        componentsAffected: [{ id: CHAT, name: 'Chat', status: 'operational', type: 'Component' }],
        timeline: [
          { id: 'a', status: 'investigating', description: null, startedAt: '2026-09-15T00:00:00Z', createdAt: '2026-09-15T00:00:00Z', componentsAffected: [{ id: CHAT, name: 'Chat', status: 'major_outage', type: 'Component' }] },
          { id: 'b', status: 'monitoring', description: null, startedAt: '2026-09-15T02:00:00Z', createdAt: '2026-09-15T02:00:00Z', componentsAffected: [{ id: CHAT, name: 'Chat', status: 'degraded', type: 'Component' }] },
        ],
      }],
    }), Date.parse('2026-09-15T03:00:00.000Z'))
    if (!parsed.ok) throw new Error('must parse')
    // 2h at 1.0 + 1h at 0.3 = 8280. Flattening the segments would read 10800.
    expect(parsed.page.todayWeightedOutageSec).toBe(8280)
  })

  it('scores a component under `maintenance` at zero, while still listing the window', () => {
    // Announced maintenance is not downtime (`impact-weights.ts`), so counting it would penalise a
    // provider for announcing its windows. The entry is still a published record and stays listed.
    const parsed = parseDatadogStatusPage(doc({
      incidents: [incident('2026-09-15T00:00:00Z', '2026-09-15T02:00:00Z', 'maintenance')],
    }), Date.parse('2026-09-15T03:00:00.000Z'))
    if (!parsed.ok) throw new Error('must parse')
    expect(parsed.page.incidents).toHaveLength(1)
    expect(parsed.page.incidents[0].impact).toBeNull()
    expect(parsed.page.todayWeightedOutageSec).toBe(0)
    expect(parsed.page.uptime30d).toBe(100)
  })

  it('does not let a component-less update end a live outage', () => {
    // `'absent'` says nothing about a component; it must not read as "recovered". Ending each segment
    // at the next update of ANY kind meant one "still working on it" note with no component
    // restatement froze accrual on a LIVE outage and handed back 3.2 points of uptime.
    const now = Date.parse('2026-09-15T02:00:00.000Z')
    const live = (extra: unknown[]) => doc({
      incidents: [{
        id: 'L', title: 'Live', currentStatus: 'identified',
        publishedDate: '2026-09-15T00:00:00Z', resolvedDate: null, resolved: false,
        componentsAffected: [{ id: CHAT, name: 'Chat', status: 'major_outage', type: 'Component' }],
        timeline: [
          { id: 'a', status: 'investigating', description: null, startedAt: '2026-09-15T00:00:00Z', createdAt: '2026-09-15T00:00:00Z', componentsAffected: [{ id: CHAT, name: 'Chat', status: 'major_outage', type: 'Component' }] },
          ...extra,
        ],
      }],
    })
    const bare = parseDatadogStatusPage(live([]), now)
    const noted = parseDatadogStatusPage(live([
      { id: 'b', status: 'identified', description: 'still working on it', startedAt: '2026-09-15T01:00:00Z', createdAt: '2026-09-15T01:00:00Z', componentsAffected: [] },
    ]), now)
    if (!bare.ok || !noted.ok) throw new Error('must parse')
    expect(bare.page.todayWeightedOutageSec).toBe(7200)
    expect(noted.page.todayWeightedOutageSec).toBe(7200)
  })

  it('clamps every segment to the published resolution', () => {
    // A postmortem entry filed hours after recovery is ordinary provider behaviour. Unclamped, it
    // charged downtime the incident's own `duration` does not claim — the card said "1h 0m" while
    // uptime had been debited nine hours.
    const parsed = parseDatadogStatusPage(doc({
      incidents: [{
        id: 'R', title: 'RCA', currentStatus: 'resolved',
        publishedDate: '2026-09-15T00:00:00Z', resolvedDate: '2026-09-15T01:00:00Z', resolved: true,
        componentsAffected: [{ id: CHAT, name: 'Chat', status: 'operational', type: 'Component' }],
        timeline: [
          { id: 'a', status: 'investigating', description: null, startedAt: '2026-09-15T00:00:00Z', createdAt: '2026-09-15T00:00:00Z', componentsAffected: [{ id: CHAT, name: 'Chat', status: 'major_outage', type: 'Component' }] },
          { id: 'b', status: 'resolved', description: 'postmortem', startedAt: '2026-09-15T09:00:00Z', createdAt: '2026-09-15T09:00:00Z', componentsAffected: [{ id: CHAT, name: 'Chat', status: 'operational', type: 'Component' }] },
        ],
      }],
    }), Date.parse('2026-09-15T12:00:00.000Z'))
    if (!parsed.ok) throw new Error('must parse')
    expect(parsed.page.incidents[0].duration).toBe('1h 0m')
    expect(parsed.page.todayWeightedOutageSec).toBe(3600)
  })

  it('applies the PROVIDER rule to the reproduction — partial_outage counts, degraded does not', () => {
    // The two tables differ on exactly these two words, and that difference IS the reproduction.
    // Asserting only that the figures are order-independent (the test below) passes even if the
    // provider table is flattened to zeros, so the values are pinned here, derived from the window
    // arithmetic rather than read off the implementation.
    const twelveHoursOf = (status: string) => {
      const parsed = parseDatadogStatusPage(doc({
        created: '2026-01-01T00:00:00Z',
        incidents: [incident('2026-09-10T00:00:00Z', '2026-09-10T12:00:00Z', status)],
      }), NOW)
      if (!parsed.ok) throw new Error(`must parse: ${status}`)
      return { ours: parsed.page.uptime30d, theirs: parsed.page.reported?.pct ?? parsed.page.uptime30d }
    }
    // 12h at 0.3 over 30d = 99.5 for us either way; the provider scores degraded 0 and partial 1.0.
    expect(twelveHoursOf('degraded')).toEqual({ ours: 99.5, theirs: 100 })
    expect(twelveHoursOf('partial_outage')).toEqual({ ours: 99.5, theirs: 99.44 })
    // 12h at 1.0 over 30d = 98.33 for us; the provider agrees it is an outage, over its own 90d.
    expect(twelveHoursOf('major_outage')).toEqual({ ours: 98.33, theirs: 99.44 })
  })

  it('does not let the order of `componentsAffected` change any published figure', () => {
    // Two components named by ONE update, one word each. Collapsing them to a single "worst" under
    // AIWatch's table — which ties `degraded` and `partial_outage` at 0.3, while the provider's table
    // splits them 0 vs 1.0 — let the array's order decide, and `uptimeReported` moved between 100
    // and 99.44 with nothing else changed. Per-component segments remove the collapse entirely.
    const withOrder = (order: string[]) => doc({
      created: '2026-01-01T00:00:00Z',
      components: order.map((_, i) => ({ id: `c${i}`, name: `C${i}`, status: 'operational', type: 'Component' })),
      incidents: [{
        id: 'mixed', title: 'Mixed', currentStatus: 'resolved',
        publishedDate: '2026-09-10T00:00:00Z', resolvedDate: '2026-09-10T10:00:00Z', resolved: true,
        componentsAffected: [],
        timeline: [{
          id: 'a', status: 'investigating', description: null,
          startedAt: '2026-09-10T00:00:00Z', createdAt: '2026-09-10T00:00:00Z',
          componentsAffected: order.map((status, i) => ({ id: `c${i}`, name: `C${i}`, status, type: 'Component' })),
        }],
      }],
    })
    const a = parseDatadogStatusPage(withOrder(['degraded', 'partial_outage']), NOW)
    const b = parseDatadogStatusPage(withOrder(['partial_outage', 'degraded']), NOW)
    if (!a.ok || !b.ok) throw new Error('must parse')
    expect(a.page.uptime30d).toBe(b.page.uptime30d)
    expect(a.page.reported).toEqual(b.page.reported)
  })

  it('keeps downtime for a component the tree no longer lists', () => {
    // A retired component keeps its incident history. Bucketing segments by leaf id and dropping the
    // rest would delete real published downtime — the one direction this parser must never fail in.
    const parsed = parseDatadogStatusPage(doc({
      created: '2026-01-01T00:00:00Z',
      incidents: [{
        id: 'gone', title: 'Retired component', currentStatus: 'resolved',
        publishedDate: '2026-09-10T00:00:00Z', resolvedDate: '2026-09-10T10:00:00Z', resolved: true,
        componentsAffected: [],
        timeline: [{
          id: 'a', status: 'investigating', description: null,
          startedAt: '2026-09-10T00:00:00Z', createdAt: '2026-09-10T00:00:00Z',
          componentsAffected: [{ id: 'retired-id', name: 'Gone', status: 'major_outage', type: 'Component' }],
        }],
      }],
    }), NOW)
    if (!parsed.ok) throw new Error('must parse')
    expect(parsed.page.uptime30d).toBeLessThan(100)
  })

  it('computes uptime over the FULL incident list, then caps the DISPLAY list at 25', () => {
    // Newest-first display cap: computing over the capped list would silently drop older incidents
    // still inside the window and publish an inflated figure with `uptimeSource: 'official'` on it.
    const many = Array.from({ length: 30 }, (_, i) => {
      const day = String(i + 1).padStart(2, '0')
      return incident(`2026-08-${day}T00:00:00Z`, `2026-08-${day}T01:00:00Z`, 'major_outage', `inc-${day}`)
    })
    const parsed = parseDatadogStatusPage(doc({ incidents: many }), NOW)
    if (!parsed.ok) throw new Error('must parse')
    expect(parsed.page.incidents).toHaveLength(25)
    expect(parsed.page.incidents[0].id).toBe('datadog:inc-30')
    // 15 of the 30 one-hour outages fall inside [2026-08-16, 2026-09-15) — 54,000s of 2,592,000.
    expect(parsed.page.uptime30d).toBe(97.91)
  })
})

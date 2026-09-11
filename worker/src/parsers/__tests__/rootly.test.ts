import { describe, it, expect } from 'vitest'
import type { Incident } from '../../types'
import {
  parseRootlyTimestamp, mapRootlyStatus, normalizeRootlyIncidents, isStorableRootlyFeed,
  rootlyWindowTruncated, rootlyWindowCutoffDay, rootlyDayImpactMap,
  mapRootlyComponentStatus, rootlyOverallStatus,
  rootlySegmentImpact, parseRootlyDay, rootlyDayReading, computeRootlyUptime, attachRootlyImpact,
  rootlyTodayWeightedOutageSec,
  type RootlyFeed, type RootlyUptimeComponent,
} from '../rootly'

// Every string here was READ off status.mistral.ai on 2026-09-10, not invented. The incident is real
// (`/incidents/5e5018d9-…`): "Degraded OCR 4.1 Availability", identified Sep 4 22:00 UTC, resolved
// Sep 5 05:48 UTC. A fixture that differs from the page in shape would pin the wrong contract.
const REAL_FEED: RootlyFeed = {
  fetchedAt: '2026-09-10T01:00:00.000Z',
  components: [{ id: '304d5895-4dde-47be-b2e1-b7ebeb28dd4d', name: 'Agents API', status: 'Operational' }],
  incidents: [{
    id: '5e5018d9-a0fb-4fdd-a1c5-ff255fd7e7e7',
    title: 'Degraded OCR 4.1 Availability',
    // Newest first, as the page renders them.
    updates: [
      { status: 'Resolved', at: 'September 5, 2026 at 05:48 AM UTC', body: 'The issue has been resolved.' },
      { status: 'Identified', at: 'September 4, 2026 at 10:00 PM UTC', body: 'The issue has been identified and we are working on a fix.' },
    ],
  }],
  coverage: { listed: 1, fetched: 1 },
  uptime: [{
    componentId: '304d5895-4dde-47be-b2e1-b7ebeb28dd4d',
    barCount: 91,
    unreadBars: 0,
    coverage: { impacted: 1, fetched: 1 },
    days: [{
      date: 'Sep 5, 2026',
      label: 'Degraded OCR 4.1 Availability',
      segments: [{ cls: 'bg-gray-700', width: 30 }, { cls: 'bg-green-400', width: 70 }],
    }],
  }],
}

/** The gate reads the uptime through `computeRootlyUptime`, so it needs a clock. Sep 5 sits inside a
 *  30-day window from here, which is what makes REAL_FEED a STORABLE feed rather than merely a
 *  well-formed one. */
const GATE_NOW = Date.parse('2026-09-10T12:00:00Z')

/** A feed whose components and uptime charts agree on one set of ids — the shape a healthy scrape
 *  produces. Built rather than hand-listed so a scope test cannot accidentally assert the uptime arm
 *  when it means to assert the component arm. */
function feedForScope(ids: string[], over: Partial<RootlyFeed> = {}): RootlyFeed {
  return {
    ...REAL_FEED,
    components: ids.map((id) => ({ id, name: `Component ${id}`, status: 'Operational' })),
    uptime: ids.map((id) => ({ componentId: id, barCount: 91, unreadBars: 0, coverage: { impacted: 0, fetched: 0 }, days: [] })),
    ...over,
  }
}

describe('parseRootlyTimestamp', () => {
  it('parses the form the incident page actually renders', () => {
    expect(parseRootlyTimestamp('September 4, 2026 at 10:00 PM UTC')).toBe(Date.UTC(2026, 8, 4, 22, 0))
    expect(parseRootlyTimestamp('September 5, 2026 at 05:48 AM UTC')).toBe(Date.UTC(2026, 8, 5, 5, 48))
  })

  it('handles the 12-hour edge cases both ways', () => {
    expect(parseRootlyTimestamp('July 2, 2026 at 12:00 AM UTC')).toBe(Date.UTC(2026, 6, 2, 0, 0))
    expect(parseRootlyTimestamp('July 2, 2026 at 12:30 PM UTC')).toBe(Date.UTC(2026, 6, 2, 12, 30))
  })

  it('REJECTS the history-list form, which omits the year', () => {
    // The list renders "September 4 at 10:00 PM UTC". Accepting it would mean guessing a year, and
    // the guess is wrong across a New Year boundary — which is why normalization reads incident
    // pages instead of list rows.
    expect(parseRootlyTimestamp('September 4 at 10:00 PM UTC')).toBeNull()
  })

  it('REJECTS a non-UTC zone rather than silently treating it as UTC', () => {
    expect(parseRootlyTimestamp('September 4, 2026 at 10:00 PM PST')).toBeNull()
    expect(parseRootlyTimestamp('September 4, 2026 at 10:00 PM')).toBeNull()
  })

  it('REJECTS a 24-hour rendering instead of misreading it', () => {
    // If the page ever switches to 24h, "22:00" has no AM/PM and must fail loudly, not parse as 10am.
    expect(parseRootlyTimestamp('September 4, 2026 at 22:00 UTC')).toBeNull()
  })

  it('REJECTS an overflowing day instead of rolling it over', () => {
    expect(parseRootlyTimestamp('February 30, 2026 at 01:00 AM UTC')).toBeNull()
  })

  it('REJECTS a non-English month, rather than picking a neighbour', () => {
    expect(parseRootlyTimestamp('septembre 4, 2026 at 10:00 PM UTC')).toBeNull()
  })

  it('returns null for junk instead of throwing', () => {
    expect(parseRootlyTimestamp('')).toBeNull()
    expect(parseRootlyTimestamp(undefined as unknown as string)).toBeNull()
  })
})

describe('mapRootlyStatus', () => {
  it('maps the four rendered words', () => {
    expect(mapRootlyStatus('Resolved')).toBe('resolved')
    expect(mapRootlyStatus('Investigating')).toBe('investigating')
    expect(mapRootlyStatus('Identified')).toBe('identified')
    expect(mapRootlyStatus('Monitoring')).toBe('monitoring')
  })

  it('returns null on an unknown word so the caller can COUNT the drift', () => {
    expect(mapRootlyStatus('Postmortem')).toBeNull()
    expect(mapRootlyStatus('')).toBeNull()
  })
})

describe('normalizeRootlyIncidents', () => {
  it('derives start, resolve and duration from the update timeline', () => {
    const r = normalizeRootlyIncidents(REAL_FEED)
    expect(r.incidents).toHaveLength(1)
    const inc = r.incidents[0]
    expect(inc.id).toBe('5e5018d9-a0fb-4fdd-a1c5-ff255fd7e7e7')
    expect(inc.title).toBe('Degraded OCR 4.1 Availability')
    expect(inc.status).toBe('resolved')
    // Earliest update is the start, even though the page lists it LAST.
    expect(inc.startedAt).toBe(new Date(Date.UTC(2026, 8, 4, 22, 0)).toISOString())
    expect(inc.resolvedAt).toBe(new Date(Date.UTC(2026, 8, 5, 5, 48)).toISOString())
    expect(inc.duration).toBe('7h 48m')
    expect(r.unparsedTimestamps).toBe(0)
    expect(r.unknownStatuses).toBe(0)
    expect(r.droppedIncidents).toBe(0)
  })

  it('orders the timeline oldest-first regardless of page order', () => {
    const [inc] = normalizeRootlyIncidents(REAL_FEED).incidents
    expect(inc.timeline.map((t) => t.stage)).toEqual(['identified', 'resolved'])
  })

  it('leaves impact null — the source publishes no severity in the title', () => {
    // Verified across all 93 impacted days on the 14 components (2026-09-10): every title is a
    // degradation phrasing, including the one day whose uptime tooltip drew a red segment. Deriving
    // impact from the title would invent a distinction the source does not make.
    expect(normalizeRootlyIncidents(REAL_FEED).incidents[0].impact).toBeNull()
  })

  it('an unresolved incident keeps its latest stage and has no duration', () => {
    const open: RootlyFeed = {
      ...REAL_FEED,
      incidents: [{
        id: 'open-1', title: 'Conversations API Degraded',
        updates: [{ status: 'Investigating', at: 'September 9, 2026 at 03:00 PM UTC', body: 'Looking into it' }],
      }],
    }
    const [inc] = normalizeRootlyIncidents(open).incidents
    expect(inc.status).toBe('investigating')
    expect(inc.resolvedAt).toBeNull()
    expect(inc.duration).toBeNull()
  })

  it('COUNTS an unparseable timestamp instead of publishing an incident without a start', () => {
    const drifted: RootlyFeed = {
      ...REAL_FEED,
      incidents: [{
        id: 'drift-1', title: 'Batch API Degraded',
        updates: [{ status: 'Resolved', at: '2026-09-05T05:48:00Z', body: 'done' }],
      }],
    }
    const r = normalizeRootlyIncidents(drifted)
    expect(r.incidents).toHaveLength(0)
    expect(r.droppedIncidents).toBe(1)
    expect(r.unparsedTimestamps).toBe(1)
  })

  it('DROPS an incident whose Resolved update was lost, rather than publishing it as ongoing', () => {
    const partial: RootlyFeed = {
      ...REAL_FEED,
      incidents: [{
        id: 'partial-1', title: 'Files API Degraded',
        updates: [
          { status: 'Resolved', at: 'September 5, 2026 at 05:48 AM UTC', body: 'done' },
          { status: 'Identified', at: 'sometime yesterday', body: 'oops' },
        ],
      }],
    }
    // Round 3: keeping it published a permanently-ongoing phantom — the scrape re-reads the same
    // page every cycle, so the same update fails identically forever, and `resolvedAt: null` reaches
    // hasActiveIncident, the is-down live rule and the Discord alert path. Nothing here can tell
    // WHICH update was lost, so a partly-read incident is not published.
    const r = normalizeRootlyIncidents(partial)
    expect(r.incidents).toHaveLength(0)
    expect(r.unparsedTimestamps).toBe(1)
    expect(r.droppedIncidents).toBe(1)
  })

  it('accepts an ABBREVIATED month, so the two parsers cannot disagree about the vocabulary', () => {
    // The scraper forwards any `[A-Z][a-z]+ D, YYYY at …`; if the Worker took only full names, the
    // day Rootly unified its two surfaces on the short form would drop 100% of incidents while
    // `coverage` still read complete.
    expect(parseRootlyTimestamp('Sep 5, 2026 at 05:48 AM UTC')).toBe(Date.UTC(2026, 8, 5, 5, 48))
  })

  it('DROPS an incident carrying an unknown status word, rather than calling it investigating', () => {
    // Round 4: an unrecognized word was coerced to `investigating`, so a vocabulary drift on
    // "Resolved" would republish the whole scraped history as permanently live — the same phantom
    // the unparseable-timestamp branch beside it already dropped for.
    const odd: RootlyFeed = {
      ...REAL_FEED,
      incidents: [{
        id: 'odd-1', title: 'Console Degraded',
        updates: [{ status: 'Postmortem', at: 'September 5, 2026 at 05:48 AM UTC', body: 'writeup' }],
      }],
    }
    const r = normalizeRootlyIncidents(odd)
    expect(r.incidents).toHaveLength(0)
    expect(r.unknownStatuses).toBe(1)
    expect(r.droppedIncidents).toBe(1)
  })

  it('tolerates a feed with no incidents at all', () => {
    const r = normalizeRootlyIncidents({ ...REAL_FEED, incidents: [] })
    expect(r.incidents).toEqual([])
    expect(r.droppedIncidents).toBe(0)
  })
})

describe('isStorableRootlyFeed', () => {
  // Asserted in BOTH directions on purpose: a validator's default answer is "yes", so a test that
  // only feeds it good input passes on a function that returns true unconditionally.
  it('accepts the real feed', () => {
    expect(isStorableRootlyFeed(REAL_FEED, undefined, GATE_NOW)).toBe(true)
  })

  it('accepts a genuinely quiet window — listed 0, fetched 0', () => {
    expect(isStorableRootlyFeed({ ...REAL_FEED, incidents: [], coverage: { listed: 0, fetched: 0 } }, undefined, GATE_NOW)).toBe(true)
  })

  it('REFUSES a run that listed incidents but read none — a broken scrape, not a quiet page', () => {
    // This is the one that matters: it parses fine and looks like an all-clear, and storing it would
    // replace a good feed with an authoritative-looking blank.
    expect(isStorableRootlyFeed({ ...REAL_FEED, incidents: [], coverage: { listed: 12, fetched: 0 } }, undefined, GATE_NOW)).toBe(false)
  })

  it('REFUSES a page that did not render for us — no components', () => {
    expect(isStorableRootlyFeed({ ...REAL_FEED, components: [] }, undefined, GATE_NOW)).toBe(false)
  })

  it('REFUSES impossible coverage', () => {
    expect(isStorableRootlyFeed({ ...REAL_FEED, coverage: { listed: 1, fetched: 5 } }, undefined, GATE_NOW)).toBe(false)
    expect(isStorableRootlyFeed({ ...REAL_FEED, coverage: { listed: -1, fetched: 0 } }, undefined, GATE_NOW)).toBe(false)
  })

  it('REFUSES a placeholder component list — the scraper ran and read nothing', () => {
    // The shape the scraper emits when its status regex misses. It PARSES, and stored it becomes
    // `unknown` for the KV TTL over a good feed — the #1256 failure mode, which is why this clause
    // is here rather than a `components.length` check alone.
    expect(isStorableRootlyFeed({
      ...REAL_FEED,
      components: [{ id: 'a', name: null, status: null }, { id: 'b', name: null, status: null }],
    }, undefined, GATE_NOW)).toBe(false)
    // A name with no readable status is the same non-reading.
    expect(isStorableRootlyFeed({
      ...REAL_FEED, components: [{ id: 'a', name: 'Agents API', status: 'Wobbly' }],
    }, undefined, GATE_NOW)).toBe(false)
    // One readable component among placeholders is a partial read, not a failed one.
    expect(isStorableRootlyFeed({
      ...REAL_FEED,
      components: [{ id: 'a', name: null, status: null }, ...REAL_FEED.components],
    }, undefined, GATE_NOW)).toBe(true)
  })

  it('REFUSES a scrape that read only SOME of the scoped components', () => {
    // The reproduction: 1 of 13 readable passes an any-one test, overwrites the only cached copy,
    // and then publishes `unknown` with no incidents for the whole 3h TTL — because
    // `rootlyOverallStatus` needs EVERY scoped id readable to derive a badge. Storing it is strictly
    // worse than keeping what we had.
    //
    // Built through `feedForScope` so the uptime charts match the components: otherwise the feed
    // fails the uptime arm as well and the test would pass without exercising the component arm.
    const scope = ['a', 'b', 'c']
    const withReadable = (n: number) => feedForScope(scope, {
      components: scope.map((id, i) => (i < n
        ? { id, name: `Component ${id}`, status: 'Operational' }
        : { id, name: null as unknown as string, status: null as unknown as string })),
    })
    expect(isStorableRootlyFeed(withReadable(1), scope, GATE_NOW)).toBe(false)
    expect(isStorableRootlyFeed(withReadable(2), scope, GATE_NOW)).toBe(false)
    expect(isStorableRootlyFeed(withReadable(3), scope, GATE_NOW)).toBe(true)
  })

  it('REFUSES a feed missing a scoped id entirely, and ignores components outside the scope', () => {
    // Absent and unreadable are the same failure for the badge, so the gate must not distinguish
    // them. And an out-of-scope component (Console) must neither rescue a feed nor sink one.
    const scope = ['a', 'b']
    const base = feedForScope(scope)
    const ok = base.components
    expect(isStorableRootlyFeed({ ...base, components: [ok[0]] }, scope, GATE_NOW)).toBe(false)
    expect(isStorableRootlyFeed({
      ...base, components: [...ok, { id: 'console', name: null as unknown as string, status: null as unknown as string }],
    }, scope, GATE_NOW)).toBe(true)
    expect(isStorableRootlyFeed({
      ...base, components: [ok[0], { id: 'console', name: 'Console', status: 'Operational' }],
    }, scope, GATE_NOW)).toBe(false)
  })

  it('REFUSES a feed whose uptime cannot be computed, even when every component read fine', () => {
    // The round-11 finding. A tooltip-short scrape parses, carries a full component list, and looks
    // authoritative — and storing it publishes a HIGHER score than the feed it replaced, because
    // `score.ts` drops the 40-point Uptime component and rescales the other three. Measured on this
    // service: 96.36% scores 55, withholding scores 74.
    const scope = ['a', 'b']
    const short = feedForScope(scope, {
      uptime: scope.map((id, i) => ({
        componentId: id, barCount: 91, unreadBars: 0,
        // One component came back short: 2 impacted days seen, 1 retrieved.
        coverage: i === 0 ? { impacted: 2, fetched: 1 } : { impacted: 0, fetched: 0 },
        days: i === 0
          ? [{ date: 'Sep 5, 2026', label: 'x', segments: [{ cls: 'bg-gray-700', width: 30 }] }]
          : [],
      })),
    })
    expect(isStorableRootlyFeed(short, scope, GATE_NOW)).toBe(false)
    // Control: the identical feed with the tooltip retrieved IS storable, so the refusal above is
    // the coverage gap and not some other property of the fixture.
    expect(isStorableRootlyFeed(feedForScope(scope), scope, GATE_NOW)).toBe(true)
  })

  it('REFUSES a chart whose bars we could not read, instead of calling it a clean window', () => {
    // Round 12's finding. `coverage.impacted` and `coverage.fetched` come from the SAME DOM
    // derivation in the scraper, so a derivation that silently reads nothing reports {0, 0} — which
    // satisfies `fetched >= impacted`, computes `pct: 100`, and published a fabricated "official"
    // 100% uptime at HIGH confidence. Measured before the fix: `uptime=100 src=official impact=null`
    // on a feed carrying a real in-window incident. `unreadBars` is the independent signal.
    const scope = ['a', 'b']
    const blind = feedForScope(scope, {
      uptime: scope.map((id) => ({
        componentId: id, barCount: 91, unreadBars: 91,
        coverage: { impacted: 0, fetched: 0 }, days: [],
      })),
    })
    expect(isStorableRootlyFeed(blind, scope, GATE_NOW)).toBe(false)
    // One unreadable bar is enough: every gap on this source fails toward "no downtime".
    const oneBlind = feedForScope(scope, {
      uptime: scope.map((id, i) => ({
        componentId: id, barCount: 91, unreadBars: i === 0 ? 1 : 0,
        coverage: { impacted: 0, fetched: 0 }, days: [],
      })),
    })
    expect(isStorableRootlyFeed(oneBlind, scope, GATE_NOW)).toBe(false)
    // Control: the same shape with every bar read IS storable, so the refusals above are the
    // unread bars and not some other property of the fixture.
    expect(isStorableRootlyFeed(feedForScope(scope), scope, GATE_NOW)).toBe(true)
  })

  it('REFUSES a day the READER cannot weigh — segments or label, by one rule', () => {
    // Round 15. The gate checked `Array.isArray(days)` and stopped there, while the reader defaults
    // `day?.segments ?? []` and `day.label ?? ''` — so an IMPACTED day missing its segments weighed
    // as clean and published a spotless 100% at high confidence. Reproduced before the fix:
    // `computeRootlyUptime` returned `pct: 100, unreadableDays: 0` for exactly this input.
    const scope = ['a']
    const withDay = (day: unknown) => feedForScope(scope, {
      uptime: [{
        componentId: 'a', barCount: 91, unreadBars: 0,
        coverage: { impacted: 1, fetched: 1 },
        days: [day],
      } as RootlyUptimeComponent],
    })
    const good = { date: 'Sep 5, 2026', label: 'Batch API Degraded', segments: [{ cls: 'bg-gray-700', width: 30 }] }
    expect(isStorableRootlyFeed(withDay(good), scope, GATE_NOW), 'control: the good day is storable').toBe(true)
    // segments dropped entirely — the nested-rename shape
    expect(isStorableRootlyFeed(withDay({ date: good.date, label: good.label }), scope, GATE_NOW)).toBe(false)
    // segments renamed
    expect(isStorableRootlyFeed(withDay({ ...good, segments: undefined, bars: good.segments }), scope, GATE_NOW)).toBe(false)
    // a segment missing its class or width
    expect(isStorableRootlyFeed(withDay({ ...good, segments: [{ width: 30 }] }), scope, GATE_NOW)).toBe(false)
    expect(isStorableRootlyFeed(withDay({ ...good, segments: [{ cls: 'bg-gray-700' }] }), scope, GATE_NOW)).toBe(false)
    // and the shapes a malformed push arrives as
    expect(isStorableRootlyFeed(withDay(null), scope, GATE_NOW)).toBe(false)
    expect(isStorableRootlyFeed(withDay({ ...good, date: '' }), scope, GATE_NOW)).toBe(false)
    // LABEL, which the gate's per-field loop did not cover — review found it one field over from
    // `segments` and called the pattern structural, so the judgement moved into `rootlyDayReading`
    // and covers both by one rule. A missing label costs every incident on the day its severity
    // (`attachRootlyImpact` matches on `label.includes(title)`), while the uptime figure would still
    // have published as `official`.
    expect(isStorableRootlyFeed(withDay({ date: good.date, segments: good.segments }), scope, GATE_NOW)).toBe(false)
    expect(isStorableRootlyFeed(withDay({ ...good, label: undefined, name: good.label }), scope, GATE_NOW)).toBe(false)
    // An EMPTY label is still a readable day: the tooltip can legitimately carry only a date, and
    // that costs attribution (counted as `unattributed`), not the downtime reading.
    expect(isStorableRootlyFeed(withDay({ ...good, label: '' }), scope, GATE_NOW)).toBe(true)
  })

  it('REFUSES a feed carrying no uptime section at all', () => {
    // `uptime` is optional on the type for feeds written before it existed. A feed without it cannot
    // produce a figure, so storing it has exactly the same effect as a tooltip-short one.
    const scope = ['a', 'b']
    expect(isStorableRootlyFeed({ ...feedForScope(scope), uptime: undefined }, scope, GATE_NOW)).toBe(false)
  })

  it('keeps the any-one test when NO scope is given — there is no badge to reason about', () => {
    // Both call sites pass a scope today. Asserted so removing the argument degrades to the old
    // behaviour visibly rather than throwing or silently accepting everything.
    expect(isStorableRootlyFeed(REAL_FEED, undefined, GATE_NOW)).toBe(true)
    expect(isStorableRootlyFeed({
      ...REAL_FEED, components: [{ id: 'a', name: null, status: null }],
    }, undefined, GATE_NOW)).toBe(false)
  })

  it('REFUSES an `available` below `listed` — the pre-cap count cannot be the smaller one', () => {
    expect(isStorableRootlyFeed({ ...REAL_FEED, coverage: { listed: 5, fetched: 5, available: 3 } }, undefined, GATE_NOW)).toBe(false)
    expect(isStorableRootlyFeed({ ...REAL_FEED, coverage: { listed: 5, fetched: 5, available: 'x' } }, undefined, GATE_NOW)).toBe(false)
    // Absent is fine — a feed written before the field existed simply cannot answer the question.
    expect(isStorableRootlyFeed({ ...REAL_FEED, coverage: { listed: 5, fetched: 5 } }, undefined, GATE_NOW)).toBe(true)
  })

  it('REFUSES the shapes an empty or malformed push arrives as', () => {
    expect(isStorableRootlyFeed(null, undefined, GATE_NOW)).toBe(false)
    expect(isStorableRootlyFeed({}, undefined, GATE_NOW)).toBe(false)
    expect(isStorableRootlyFeed('', undefined, GATE_NOW)).toBe(false)
    expect(isStorableRootlyFeed({ ...REAL_FEED, incidents: undefined }, undefined, GATE_NOW)).toBe(false)
    expect(isStorableRootlyFeed({ ...REAL_FEED, coverage: undefined }, undefined, GATE_NOW)).toBe(false)
    expect(isStorableRootlyFeed({ ...REAL_FEED, coverage: { listed: 'x', fetched: 0 } }, undefined, GATE_NOW)).toBe(false)
  })
})

describe('mapRootlyComponentStatus', () => {
  it('maps the word every component actually rendered on 2026-09-10', () => {
    expect(mapRootlyComponentStatus('Operational')).toBe('operational')
  })

  it('maps the impaired labels Rootly offers', () => {
    expect(mapRootlyComponentStatus('Degraded')).toBe('degraded')
    expect(mapRootlyComponentStatus('Partial Outage')).toBe('degraded')
    expect(mapRootlyComponentStatus('Major Outage')).toBe('down')
  })

  it('does NOT read announced maintenance as an outage', () => {
    // `instatus.ts` states the rule directly ("a scheduled-maintenance row shouldn't read as an
    // outage") and `incident-io.ts` weights maintenance 0. Rootly diverging would put a public
    // `degraded` pill on a planned window.
    expect(mapRootlyComponentStatus('Under Maintenance')).toBe('operational')
  })

  it('returns null on an unrecognized word — NOT operational', () => {
    // The whole point: only "Operational" was observed live, so the rest of the vocabulary is
    // inferred. Coercing an unknown word to green would publish an all-clear we did not read.
    expect(mapRootlyComponentStatus('Elevated Errors')).toBeNull()
    expect(mapRootlyComponentStatus('')).toBeNull()
  })
})

describe('rootlyOverallStatus', () => {
  const c = (id: string, status: string) => ({ id, status })

  it('is operational only when every component in scope is', () => {
    expect(rootlyOverallStatus([c('a', 'Operational'), c('b', 'Operational')])).toBe('operational')
  })

  it('takes the worst of the scope', () => {
    expect(rootlyOverallStatus([c('a', 'Operational'), c('b', 'Degraded')])).toBe('degraded')
    expect(rootlyOverallStatus([c('a', 'Degraded'), c('b', 'Major Outage')])).toBe('down')
    expect(rootlyOverallStatus([c('a', 'Major Outage'), c('b', 'Degraded')])).toBe('down')
  })

  it('honours the configured scope and ignores components outside it', () => {
    // Console is on the page but out of the API-surface scope; its state must not move the badge.
    const comps = [c('api', 'Operational'), c('console', 'Major Outage')]
    expect(rootlyOverallStatus(comps, ['api'])).toBe('operational')
    expect(rootlyOverallStatus(comps)).toBe('down')
  })

  it('is unknown when a component in scope is unreadable — not a green badge from the rest', () => {
    expect(rootlyOverallStatus([c('a', 'Operational'), c('b', 'Elevated Errors')])).toBe('unknown')
  })

  it('is unknown when the scope resolves to nothing — the id-rotation case', () => {
    // Exactly what the migration did: configured ids stopped matching anything on the page. Returning
    // operational here would publish a badge derived from zero components.
    expect(rootlyOverallStatus([c('new-1', 'Operational')], ['old-1', 'old-2'])).toBe('unknown')
    expect(rootlyOverallStatus([])).toBe('unknown')
  })
})

// ── Uptime chart ────────────────────────────────────────────────────────────────────────────────
// Segment classes and widths below are REAL: the Aug 28 Console day is the only `bg-red-500` in the
// 90-day window across all 14 components, and the Aug 12 Embedding day is a representative gray one.

describe('rootlySegmentImpact', () => {
  it('maps the two classes the page actually draws', () => {
    expect(rootlySegmentImpact('bg-red-500')).toBe('major')
    expect(rootlySegmentImpact('bg-gray-700')).toBe('minor')
  })

  it('returns null for anything else, including the healthy colour', () => {
    // The caller must decide what an unreadable day means; guessing here would either understate
    // downtime (treat as healthy) or overstate it (treat as major).
    expect(rootlySegmentImpact('bg-green-400')).toBeNull()
    expect(rootlySegmentImpact('bg-amber-400')).toBeNull()
    expect(rootlySegmentImpact('')).toBeNull()
  })
})

describe('parseRootlyDay', () => {
  it('parses the ABBREVIATED month the tooltip renders', () => {
    expect(parseRootlyDay('Aug 12, 2026')).toBe('2026-08-12')
    expect(parseRootlyDay('Sep 5, 2026')).toBe('2026-09-05')
  })

  it('also accepts a spelled-out month', () => {
    expect(parseRootlyDay('September 5, 2026')).toBe('2026-09-05')
  })

  it('REJECTS the incident-page format, which carries a clock', () => {
    // Two formats, two parsers: one lenient function covering both is how a string from one surface
    // gets read with the other surface's assumptions.
    expect(parseRootlyDay('September 4, 2026 at 10:00 PM UTC')).toBeNull()
  })

  it('REJECTS an overflowing day and junk', () => {
    expect(parseRootlyDay('Feb 30, 2026')).toBeNull()
    expect(parseRootlyDay('Xxx 1, 2026')).toBeNull()
    expect(parseRootlyDay('')).toBeNull()
  })
})

describe('rootlyDayReading', () => {
  it('weights a gray (degraded) span at 0.3 of its share of the day', () => {
    const r = rootlyDayReading({ date: 'Jul 2, 2026', label: 'Agents API Degraded', segments: [
      { cls: 'bg-green-400', width: 2.5 }, { cls: 'bg-gray-700', width: 10 }, { cls: 'bg-green-400', width: 87.5 },
    ] })
    expect(r.fraction).toBeCloseTo(0.03, 6)   // 10% of the day × 0.3
    expect(r.impact).toBe('minor')
  })

  it('weights a red span at 1.0, and reports the worst impact when both appear', () => {
    // The real Aug 28 Console day: red 10.72% + gray 1.12%.
    const r = rootlyDayReading({ date: 'Aug 28, 2026', label: 'Elevated error rate', segments: [
      { cls: 'bg-red-500', width: 10.72 }, { cls: 'bg-gray-700', width: 1.12 }, { cls: 'bg-green-400', width: 88.16 },
    ] })
    expect(r.fraction).toBeCloseTo(0.1072 + 0.0112 * 0.3, 6)
    expect(r.impact).toBe('major')
  })

  it('a fully healthy day is zero downtime and no impact', () => {
    const r = rootlyDayReading({ date: 'Sep 5, 2026', label: 'No downtime reported', segments: [
      { cls: 'bg-green-400', width: 100 },
    ] })
    expect(r.fraction).toBe(0)
    expect(r.impact).toBeNull()
  })

  it('is UNREADABLE when any segment class is unknown — not a partial number', () => {
    const r = rootlyDayReading({ date: 'Sep 5, 2026', label: 'x', segments: [
      { cls: 'bg-gray-700', width: 10 }, { cls: 'bg-fuchsia-600', width: 5 },
    ] })
    expect(r.fraction).toBeNull()
    expect(r.impact).toBeNull()
  })

  it('is UNREADABLE on a nonsense width rather than coercing it', () => {
    expect(rootlyDayReading({ date: 'Sep 5, 2026', label: 'x', segments: [{ cls: 'bg-gray-700', width: NaN }] }).fraction).toBeNull()
    expect(rootlyDayReading({ date: 'Sep 5, 2026', label: 'x', segments: [{ cls: 'bg-gray-700', width: -3 }] }).fraction).toBeNull()
  })
})

describe('computeRootlyUptime', () => {
  const NOW = Date.UTC(2026, 8, 10, 12, 0)
  const comp = (over: Partial<RootlyUptimeComponent> = {}): RootlyUptimeComponent => ({
    componentId: 'c1', barCount: 91, unreadBars: 0, coverage: { impacted: 1, fetched: 1 },
    days: [{ date: 'Sep 5, 2026', label: 'C1 Degraded', segments: [
      { cls: 'bg-gray-700', width: 30 }, { cls: 'bg-green-400', width: 70 },
    ] }],
    ...over,
  })

  it('computes a worst-of percentage over the window', () => {
    // One day at 30% gray = 0.09 weighted days out of 30 → 99.70%.
    const r = computeRootlyUptime([comp()], undefined, NOW)
    expect(r.pct).toBeCloseTo(99.7, 1)
    expect(r.windowDays).toBe(30)
    expect(r.unreadableDays).toBe(0)
  })

  it('takes the WORST component, not the average', () => {
    const bad = comp({ componentId: 'c2', days: [{ date: 'Sep 6, 2026', label: 'C2', segments: [
      { cls: 'bg-red-500', width: 50 }, { cls: 'bg-green-400', width: 50 },
    ] }] })
    const r = computeRootlyUptime([comp(), bad], undefined, NOW)
    expect(r.pct).toBeLessThan(99)
  })

  it('WITHHOLDS the figure when a tooltip was lost — a gap here inflates', () => {
    // The live case: 429s cost 3 of 93 tooltips. Every gap fails toward "no downtime", so a partial
    // read must not be published as a measurement.
    const r = computeRootlyUptime([comp({ coverage: { impacted: 4, fetched: 3 } })], undefined, NOW)
    expect(r.pct).toBeNull()
    expect(r.incompleteComponents).toBe(1)
  })

  it('WITHHOLDS the figure when a day is unreadable', () => {
    const r = computeRootlyUptime([comp({ days: [{ date: 'Sep 5, 2026', label: 'x', segments: [
      { cls: 'bg-unknown-1', width: 5 },
    ] }] })], undefined, NOW)
    expect(r.pct).toBeNull()
    expect(r.unreadableDays).toBe(1)
  })

  it('ignores days outside the trailing window', () => {
    const old = comp({ days: [{ date: 'Jun 15, 2026', label: 'old', segments: [
      { cls: 'bg-red-500', width: 100 },
    ] }] })
    const r = computeRootlyUptime([old], undefined, NOW)
    expect(r.pct).toBe(100)
  })

  it('honours the configured scope', () => {
    const outOfScope = comp({ componentId: 'console', days: [{ date: 'Sep 6, 2026', label: 'x', segments: [
      { cls: 'bg-red-500', width: 100 },
    ] }] })
    expect(computeRootlyUptime([comp(), outOfScope], ['c1'], NOW).pct).toBeCloseTo(99.7, 1)
  })

  it('reports a SHORT window rather than pretending to 30 days', () => {
    const young = comp({ barCount: 8, days: [] })
    const r = computeRootlyUptime([young], undefined, NOW)
    expect(r.windowDays).toBe(8)
  })

  it('an empty scope yields no figure, not 100%', () => {
    expect(computeRootlyUptime([], undefined, NOW).pct).toBeNull()
  })
})

describe('attachRootlyImpact', () => {
  const inc = (over: Partial<Incident> = {}): Incident => ({
    id: 'i1', title: 'Batch API Degraded', status: 'resolved', impact: null,
    startedAt: '2026-09-05T10:00:00.000Z', resolvedAt: '2026-09-05T10:30:00.000Z',
    duration: '30m', timeline: [], ...over,
  })
  const day = (label: string, impact: 'major' | 'minor', componentId = 'c1', fraction = 0.1) =>
    ({ componentId, label, impact, fraction })
  // Every case below uses Sep 2026 days, so a cutoff well before them leaves each one asserting what
  // it always did. The window edge itself is pinned by the two cases at the end of this block.
  const CUTOFF = '2026-08-01'

  it('gives an incident the severity of its component-day', () => {
    const r = attachRootlyImpact([inc()], { days: { '2026-09-05': [day('Batch API Degraded', 'minor')] } }, CUTOFF)
    expect(r.incidents[0].impact).toBe('minor')
    expect(r.unattributed).toBe(0)
  })

  it('carries a major day through', () => {
    const r = attachRootlyImpact([inc({ title: 'Elevated error rate' })], {
      days: { '2026-09-05': [day('Elevated error rate on batch permission check endpoint', 'major')] },
    }, CUTOFF)
    expect(r.incidents[0].impact).toBe('major')
  })

  it('does NOT lend one component\'s severity to another component\'s incident', () => {
    // Round 1: the join read a worst-of-the-DAY map, so a red segment drawn for Console stamped
    // `major` on a gray Batch API incident — a severity the source never published for it, which
    // score.ts then books at weight 1.0 instead of 0.3.
    const r = attachRootlyImpact([inc()], {
      days: { '2026-09-05': [
        day('Batch API Degraded', 'minor', 'batch'),
        day('Console Degraded', 'major', 'console'),
      ] },
    }, CUTOFF)
    expect(r.incidents[0].impact).toBe('minor')
  })

  it('takes the worst of the MATCHING entries when several match', () => {
    const r = attachRootlyImpact([inc()], {
      days: { '2026-09-05': [
        day('Batch API Degraded', 'minor', 'a'),
        day('Batch API Degraded', 'major', 'b'),
      ] },
    }, CUTOFF)
    expect(r.incidents[0].impact).toBe('major')
  })

  it('leaves impact null and COUNTS it when the day has no matching label', () => {
    // Understating is the safe direction: a null-impact incident stays out of affected-days and the
    // MTTR sample rather than being scored at a severity nobody published.
    const r = attachRootlyImpact([inc()], { days: { '2026-09-05': [day('Some Other API Degraded', 'minor')] } }, CUTOFF)
    expect(r.incidents[0].impact).toBeNull()
    expect(r.unattributed).toBe(1)
  })

  it('leaves impact null when the day itself is absent', () => {
    const r = attachRootlyImpact([inc()], { days: {} }, CUTOFF)
    expect(r.incidents[0].impact).toBeNull()
    expect(r.unattributed).toBe(1)
  })

  it('does NOT count an incident that started BEFORE the window', () => {
    // The defect this argument exists for: the incident feed reaches ~64 days back while the uptime
    // chart is read over 30, so out-of-window incidents are a permanent, healthy condition. Counting
    // them made `unattributed > 0` true on every run, which pinned the Worker's scrape diagnostic
    // permanently on — the same "fires always, means nothing" failure a previous round removed from
    // the coverage counter.
    const r = attachRootlyImpact([inc({ startedAt: '2026-07-02T10:00:00.000Z' })], { days: {} }, CUTOFF)
    expect(r.incidents[0].impact).toBeNull()
    expect(r.unattributed).toBe(0)
  })

  it('still counts an incident ON the cutoff day — the edge is inclusive', () => {
    // Asserted because an off-by-one here silently drops a real lost read on the oldest day the
    // uptime figure covers, and `computeRootlyUptime` keeps that day (`iso < cutoffDay` excludes).
    const r = attachRootlyImpact([inc({ startedAt: `${CUTOFF}T10:00:00.000Z` })], { days: {} }, CUTOFF)
    expect(r.unattributed).toBe(1)
  })

  it('matches on the incident START day, not the resolve day', () => {
    // A cross-midnight incident belongs to the day it began; the chart marks that day.
    const r = attachRootlyImpact([inc({ startedAt: '2026-09-04T22:00:00.000Z', resolvedAt: '2026-09-05T05:48:00.000Z' })], {
      days: { '2026-09-04': [day('Batch API Degraded', 'minor')] },
    }, CUTOFF)
    expect(r.incidents[0].impact).toBe('minor')
  })
})

describe('rootlyOverallStatus / computeRootlyUptime — a MISSING scoped component (round 1)', () => {
  const NOW = Date.UTC(2026, 8, 10, 12, 0)

  it('a configured id absent from the payload makes the badge unknown, not green', () => {
    // Exactly how the migration went unnoticed: the ids rotated, scope resolved to fewer and fewer
    // components, and worst-of over the remainder kept reading operational.
    expect(rootlyOverallStatus([{ id: 'a', status: 'Operational' }], ['a', 'b'])).toBe('unknown')
    expect(rootlyOverallStatus([{ id: 'a', status: 'Operational' }], ['a'])).toBe('operational')
  })

  it('a configured id with no chart WITHHOLDS the uptime figure', () => {
    const chart: RootlyUptimeComponent = {
      componentId: 'a', barCount: 91, unreadBars: 0, coverage: { impacted: 0, fetched: 0 }, days: [],
    }
    const both = computeRootlyUptime([chart], ['a', 'b'], NOW)
    expect(both.pct, 'a denominator over the components that happened to arrive is not the scope').toBeNull()
    expect(both.missingComponents).toBe(1)
    expect(computeRootlyUptime([chart], ['a'], NOW).pct).toBe(100)
  })
})

describe('#1381 round-2 regressions', () => {
  const NOW = Date.UTC(2026, 8, 10, 12, 0)
  const chart = (over: Partial<RootlyUptimeComponent> = {}): RootlyUptimeComponent => ({
    componentId: 'a', barCount: 91, unreadBars: 0, coverage: { impacted: 1, fetched: 1 },
    days: [{ date: 'Sep 5, 2026', label: 'A Degraded', segments: [
      { cls: 'bg-gray-700', width: 50 }, { cls: 'bg-green-400', width: 50 },
    ] }],
    ...over,
  })

  it('windowDays describes the component that PRODUCED the figure, not a min across the scope', () => {
    // Round 2: a clean 5-day sibling pinned the disclosure to 5 while the % came from a 91-day chart.
    const young = chart({ componentId: 'b', barCount: 5, unreadBars: 0, coverage: { impacted: 0, fetched: 0 }, days: [] })
    const r = computeRootlyUptime([chart(), young], ['a', 'b'], NOW)
    expect(r.pct, 'the worst component is the 91-day one').toBeLessThan(100)
    expect(r.windowDays, 'so the window is its 30, not the 5-day sibling').toBe(30)
  })

  it('a scoped component with NO day bars voids the read rather than setting windowDays 0', () => {
    // `windowDays: 0` satisfied `isArchiveRestoreEligible`, so the whole live calendar read as a gap.
    const barless = chart({ componentId: 'b', barCount: 0, unreadBars: 0, coverage: { impacted: 0, fetched: 0 }, days: [] })
    const r = computeRootlyUptime([chart(), barless], ['a', 'b'], NOW)
    expect(r.pct).toBeNull()
    expect(r.windowDays).toBeNull()
    expect(r.unreadableComponents).toBe(1)
  })

  it('todayWeightedOutageSec is a SHARE of the day, not the whole day', () => {
    const today = Date.UTC(2026, 8, 5, 12, 0)
    const r = computeRootlyUptime([chart()], ['a'], today)
    // 50% of the day at minor (0.3) = 0.15 of a day.
    expect(rootlyTodayWeightedOutageSec(r, today)).toBe(Math.round(86400 * 0.15))
  })

  it('todayWeightedOutageSec is 0 on a clean day and null on an incomplete read', () => {
    const clean = computeRootlyUptime([chart({ days: [] , coverage: { impacted: 0, fetched: 0 } })], ['a'], NOW)
    expect(rootlyTodayWeightedOutageSec(clean, NOW)).toBe(0)
    const lost = computeRootlyUptime([chart({ coverage: { impacted: 4, fetched: 1 } })], ['a'], NOW)
    expect(lost.pct).toBeNull()
    expect(rootlyTodayWeightedOutageSec(lost, NOW), 'no figure, no archive input').toBeNull()
  })
})

describe('rootlyWindowTruncated', () => {
  const NOW = Date.parse('2026-09-10T12:00:00Z')
  const inc = (startedAt: string) => ({ id: 'x', title: 't', startedAt, status: 'resolved' } as Incident)

  it('is false when the cap bit but the read still reaches past the window edge', () => {
    // The steady state: the page offers ~154, the cap takes 80, and the oldest of those 80 is older
    // than 30 days — so everything inside the window is in hand and the untouched tail is irrelevant.
    // If this returned true the diagnostic would fire on every healthy run and mean nothing.
    expect(rootlyWindowTruncated(
      { listed: 80, fetched: 80, available: 154 }, [inc('2026-07-20T00:00:00Z')], NOW,
    )).toBe(false)
  })

  it('is TRUE when the cap bit and the oldest incident read is inside the window', () => {
    // The cap ate real days: incidents between 25 and 30 days back exist on the page and are not in
    // the feed, so the count reads downstream as a quieter month than it was.
    expect(rootlyWindowTruncated(
      { listed: 80, fetched: 80, available: 154 }, [inc('2026-08-25T00:00:00Z')], NOW,
    )).toBe(true)
  })

  it('is false when the cap did not bite at all', () => {
    expect(rootlyWindowTruncated(
      { listed: 12, fetched: 12, available: 12 }, [inc('2026-09-09T00:00:00Z')], NOW,
    )).toBe(false)
  })

  it('is false when the feed cannot answer — no `available`, or nothing readable', () => {
    // An unanswerable question is not evidence of truncation. Asserted because the alternative is a
    // permanent warn on every feed written before the field existed.
    expect(rootlyWindowTruncated({ listed: 80, fetched: 80 }, [inc('2026-09-09T00:00:00Z')], NOW)).toBe(false)
    expect(rootlyWindowTruncated({ listed: 80, fetched: 80, available: 154 }, [], NOW)).toBe(false)
    expect(rootlyWindowTruncated(
      { listed: 80, fetched: 80, available: 154 }, [inc('not a date')], NOW,
    )).toBe(false)
  })

  it('reads the OLDEST incident, not the first in the array', () => {
    // The feed is newest-first, so a fold that took `incidents[0]` would answer "truncated" on every
    // run with a recent incident — which is every run.
    expect(rootlyWindowTruncated(
      { listed: 80, fetched: 80, available: 154 },
      [inc('2026-09-09T00:00:00Z'), inc('2026-07-20T00:00:00Z')], NOW,
    )).toBe(false)
  })
})

describe('rootlyWindowCutoffDay', () => {
  it('is the oldest day INSIDE the window, inclusive', () => {
    // 30 days counting today, so the edge is now-29d. Pinned because `computeRootlyUptime` and
    // `attachRootlyImpact` both derive from this one function precisely so they cannot disagree,
    // which makes an error here wrong in two places at once rather than visible in one.
    expect(rootlyWindowCutoffDay(Date.parse('2026-09-10T12:00:00Z'))).toBe('2026-08-12')
    expect(rootlyWindowCutoffDay(Date.parse('2026-09-10T12:00:00Z'), 1)).toBe('2026-09-10')
  })

  it('is the SAME edge computeRootlyUptime applies', () => {
    // The agreement itself, not two copies of the arithmetic: a day one before the cutoff must be
    // excluded from the figure, and the cutoff day itself kept.
    const NOW = Date.parse('2026-09-10T12:00:00Z')
    const cut = rootlyWindowCutoffDay(NOW)
    const chart = (isoDay: string) => [{
      componentId: 'c1', barCount: 91, unreadBars: 0, coverage: { impacted: 1, fetched: 1 },
      days: [{ date: fmt(isoDay), label: 'Batch API Degraded', segments: [{ cls: 'bg-red-500', width: 100 }] }],
    }]
    const dayBefore = new Date(Date.parse(`${cut}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
    expect(computeRootlyUptime(chart(cut), ['c1'], NOW).pct).toBeLessThan(100)
    expect(computeRootlyUptime(chart(dayBefore), ['c1'], NOW).pct).toBe(100)
  })
})

/** ISO day → the abbreviated form the chart tooltips publish, which `parseRootlyDay` reads. */
function fmt(isoDay: string): string {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [y, m, d] = isoDay.split('-').map(Number)
  return `${M[m - 1]} ${d}, ${y}`
}

describe('rootlyDayImpactMap', () => {
  const e = (impact: 'major' | 'minor', componentId = 'c1') =>
    ({ componentId, label: 'x', impact, fraction: 0.1 })

  it('takes the WORST severity on a day, whatever order the entries arrive in', () => {
    // The calendar renders one cell per day, so two components degraded on the same day must not let
    // the later entry overwrite the worse one. Both orders asserted: a `out[iso] = e.impact` that
    // simply assigns passes the major-first case by luck, which is how this survived unpinned.
    expect(rootlyDayImpactMap({ '2026-09-05': [e('major'), e('minor', 'c2')] })).toEqual({ '2026-09-05': 'major' })
    expect(rootlyDayImpactMap({ '2026-09-05': [e('minor'), e('major', 'c2')] })).toEqual({ '2026-09-05': 'major' })
  })

  it('keeps days separate and omits none of them', () => {
    expect(rootlyDayImpactMap({ '2026-09-04': [e('minor')], '2026-09-05': [e('major')] }))
      .toEqual({ '2026-09-04': 'minor', '2026-09-05': 'major' })
  })
})

// ── producer ↔ consumer round trip ───────────────────────────────────────────────────────────────
// The defect this replaces: `unreadBars` was added to the Worker's reader AND unit-tested there,
// while the scraper never put it in the payload — both halves green, the guard inert in production
// for a full review round. A CI-side guard that parsed this file's interface text was tried first
// and deleted: it missed a nested rename, a member modifier and every type change.
//
// So the contract is asserted by running the real producer through the real gate. Importing the
// scraper's `.mjs` from here is the point — it is the only place both ends are loadable at once.
describe('computeRootlyUptime counter attribution', () => {
  // The split is invisible through `pct`: unread bars and unparseable tooltip dates both force it to
  // null, so every test that goes through the gate passes either way. Reverting the split therefore
  // left the whole suite green when review checked. These assert the COUNTERS, which is the only
  // place the distinction exists — and it has to exist, because the two have different units
  // (whole-91-bar chart vs in-window days) and share one operator-facing warn line.
  const NOW = Date.parse('2026-09-10T12:00:00Z')
  const chart = (over: Partial<RootlyUptimeComponent>): RootlyUptimeComponent => ({
    componentId: 'c1', barCount: 91, unreadBars: 0,
    coverage: { impacted: 0, fetched: 0 }, days: [], ...over,
  })

  it('counts unread BARS separately from unreadable DAYS', () => {
    const r = computeRootlyUptime([chart({ unreadBars: 7 })], ['c1'], NOW)
    expect(r.unreadBars, 'unread bars belong to their own counter').toBe(7)
    expect(r.unreadableDays, 'and must not inflate the in-window day counter').toBe(0)
    expect(r.pct, 'either one still withholds the figure').toBeNull()
  })

  it('counts an unparseable tooltip DATE as a day, not as a bar', () => {
    const r = computeRootlyUptime(
      [chart({ coverage: { impacted: 1, fetched: 1 }, days: [{ date: 'not a date', label: '', segments: [] }] })],
      ['c1'], NOW,
    )
    expect(r.unreadableDays).toBe(1)
    expect(r.unreadBars, 'a bad date is not a bar we could not read').toBe(0)
  })

  it('reports both when both happen, rather than one merged total', () => {
    const r = computeRootlyUptime(
      [chart({ unreadBars: 5, coverage: { impacted: 1, fetched: 1 }, days: [{ date: 'nope', label: '', segments: [] }] })],
      ['c1'], NOW,
    )
    expect({ bars: r.unreadBars, days: r.unreadableDays }).toEqual({ bars: 5, days: 1 })
  })
})

describe('#1381 the gate accepts what the scraper actually emits', () => {
  it('a chart the scraper built passes isStorableRootlyFeed', async () => {
    const { buildUptimeEntry } = await import('../../../../scripts/scrape-mistral-status.mjs')
    const entry = buildUptimeEntry({ componentId: 'c1', barCount: 91, unreadBars: 0, impacted: [] }, [], 0)
    const feed = {
      ...REAL_FEED,
      components: [{ id: 'c1', name: 'Agents API', status: 'Operational' }],
      uptime: [entry as RootlyUptimeComponent],
    }
    expect(
      isStorableRootlyFeed(feed, ['c1'], GATE_NOW),
      'the gate rejected what the scraper emits — producer and consumer have drifted',
    ).toBe(true)
  })

  it('and the gate REFUSES a chart the DERIVATION came back short on', async () => {
    // The control, and it drops the field from the `chart` the scraper is given rather than from the
    // entry it produced. That distinction is the whole finding: the earlier version mutated the
    // finished entry, so a producer that silently defaulted a missing input passed it. `chart` is
    // what `page.evaluate` returns — the one part of this pipeline no test executes, which is
    // exactly why the assertion has to start there.
    const { buildUptimeEntry } = await import('../../../../scripts/scrape-mistral-status.mjs')
    const full = { componentId: 'c1', barCount: 91, unreadBars: 0, impacted: [] as number[] }
    for (const drop of ['unreadBars', 'barCount', 'componentId'] as const) {
      const chart = { ...full } as Record<string, unknown>
      delete chart[drop]
      const feed = {
        ...REAL_FEED,
        components: [{ id: 'c1', name: 'Agents API', status: 'Operational' }],
        uptime: [buildUptimeEntry(chart, [], 0) as RootlyUptimeComponent],
      }
      expect(
        isStorableRootlyFeed(feed, ['c1'], GATE_NOW),
        `a derivation missing ${drop} must be refused, not defaulted`,
      ).toBe(false)
    }
  })
})

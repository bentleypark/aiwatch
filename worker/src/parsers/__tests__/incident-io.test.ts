import { describe, it, expect } from 'vitest'
import { computeIncidentIoUptime, parseIncidentIoComponentImpacts, parseIncidentIoUpdates, applyTextCache, buildTextCache } from '../incident-io'
import type { IncidentTextCache } from '../incident-io'
import type { Incident } from '../../types'

// #1006 — AIWatch no longer copies incident.io's published `component_uptimes[].uptime`. That aggregate
// is not a 30-day figure (LangSmith's tracks ~90 days and had it ranked `fair` on 60-day-old outages)
// and is not even defined the same way page to page (OpenAI's excludes degraded/partial entirely). We
// compute from the page's RAW `component_impacts` with the weights published on /methodology, so every
// incident.io service is on the same window and formula as the other Official sources (#1110 — not
// `platform_avg`, which ignores severity and uses only each resource's monitored days).
describe('computeIncidentIoUptime (#1006)', () => {
  const NOW = Date.parse('2026-07-14T00:00:00Z')
  const day = 86_400_000

  /** The page's real backslash-escaped shape: component_impacts, then component_uptimes. */
  const html = (
    impacts: Array<{ id: string; start: string; end: string; status: string }>,
    uptimes: Array<{ id: string; since: string | null }>,
  ) => {
    const imp = impacts.map((i) =>
      `{\\"component_id\\":\\"${i.id}\\",\\"end_at\\":\\"${i.end}\\",\\"id\\":\\"IMP\\",` +
      `\\"start_at\\":\\"${i.start}\\",\\"status\\":\\"${i.status}\\",\\"status_page_incident_id\\":\\"INC\\"}`).join(',')
    const up = uptimes.map((u) =>
      `{\\"component_id\\":\\"${u.id}\\",\\"data_available_since\\":\\"${u.since ?? '$undefined'}\\",` +
      `\\"status_page_component_group_id\\":\\"$undefined\\",\\"uptime\\":\\"100.00\\"}`).join(',')
    return `<script>self.__next_f.push([1,"a:{\\"component_impacts\\":[${imp}],\\"component_uptimes\\":[${up}],\\"incident_links\\":[]}"])</script>`
  }

  const ESTABLISHED = [{ id: 'c1', since: '2024-01-01T00:00:00Z' }]
  const at = (daysAgo: number, hours = 0) => new Date(NOW - daysAgo * day + hours * 3_600_000).toISOString()

  it('a clean 30-day window is 100%', () => {
    expect(computeIncidentIoUptime(html([], ESTABLISHED), 'c1', NOW)).toEqual({ pct: 100, days: 30, todayWeightedOutageSec: 0 })
  })

  it('a full outage is weighted 1.0 — 24h out of 30 days', () => {
    const out = computeIncidentIoUptime(
      html([{ id: 'c1', start: at(5), end: at(4), status: 'full_outage' }], ESTABLISHED), 'c1', NOW,
    )
    // 1 day of 30 → 96.66% (floored, never rounded up)
    expect(out).toEqual({ pct: 96.66, days: 30, todayWeightedOutageSec: 0 })
  })

  it('partial_outage and degraded_performance are weighted 0.3 — the same as Atlassian\'s `p` bucket', () => {
    const partial = computeIncidentIoUptime(
      html([{ id: 'c1', start: at(5), end: at(4), status: 'partial_outage' }], ESTABLISHED), 'c1', NOW,
    )
    const degraded = computeIncidentIoUptime(
      html([{ id: 'c1', start: at(5), end: at(4), status: 'degraded_performance' }], ESTABLISHED), 'c1', NOW,
    )
    // 24h × 0.3 = 7.2h of 30 days → 99.00%
    expect(partial?.pct).toBe(99)
    expect(degraded?.pct).toBe(99)
  })

  it('under_maintenance is NOT downtime — announced windows must not penalise a provider', () => {
    const out = computeIncidentIoUptime(
      html([{ id: 'c1', start: at(5), end: at(4), status: 'under_maintenance' }], ESTABLISHED), 'c1', NOW,
    )
    expect(out?.pct).toBe(100)
  })

  it('an impact OUTSIDE the window does not count — the LangSmith bug in one assertion', () => {
    // LangSmith's published 98.48% was driven by ~10h partial outages in MAY. Its real 30-day record is
    // spotless, and the old copy-the-aggregate path ranked it `fair` on that stale number.
    const out = computeIncidentIoUptime(
      html([{ id: 'c1', start: at(60), end: at(60, 10), status: 'partial_outage' }], ESTABLISHED), 'c1', NOW,
    )
    expect(out).toEqual({ pct: 100, days: 30, todayWeightedOutageSec: 0 })
  })

  it('an impact STRADDLING the window edge is clipped to the part inside it', () => {
    const out = computeIncidentIoUptime(
      html([{ id: 'c1', start: at(31), end: at(29), status: 'full_outage' }], ESTABLISHED), 'c1', NOW,
    )
    // 2-day outage, only 1 day of it inside the window → same as a 1-day outage
    expect(out?.pct).toBe(96.66)
  })

  it('a component the page does NOT track yields null — absence of impacts is not absence of downtime', () => {
    // The #713 rule, enforced structurally: no `data_available_since` → we withhold, never invent 100%.
    expect(computeIncidentIoUptime(html([], [{ id: 'other', since: '2024-01-01T00:00:00Z' }]), 'c1', NOW)).toBeNull()
    expect(computeIncidentIoUptime(html([], [{ id: 'c1', since: null }]), 'c1', NOW)).toBeNull()
    expect(computeIncidentIoUptime('<html>not a status page</html>', 'c1', NOW)).toBeNull()
  })

  it('a young component reports the window it actually covers (#1004 — a page migration resets it)', () => {
    const out = computeIncidentIoUptime(html([], [{ id: 'c1', since: at(6) }]), 'c1', NOW)
    expect(out).toEqual({ pct: 100, days: 6, todayWeightedOutageSec: 0 })
  })

  it('a short window is not a free pass: the same outage weighs more against fewer days', () => {
    const out = computeIncidentIoUptime(
      html([{ id: 'c1', start: at(5), end: at(4), status: 'full_outage' }], [{ id: 'c1', since: at(6) }]), 'c1', NOW,
    )
    // 24h out of 6 days = 83.33% — which is exactly why the UI must state the window (#1006).
    expect(out).toEqual({ pct: 83.33, days: 6, todayWeightedOutageSec: 0 })
  })

  it('a LIST of ids is a worst-of, over the shortest covered window (turbopuffer regions, #857)', () => {
    const out = computeIncidentIoUptime(
      html(
        [{ id: 'r2', start: at(5), end: at(4), status: 'full_outage' }],
        [{ id: 'r1', since: '2024-01-01T00:00:00Z' }, { id: 'r2', since: at(20) }],
      ),
      ['r1', 'r2'], NOW,
    )
    expect(out).toEqual({ pct: 95, days: 20, todayWeightedOutageSec: 0 }) // r2: 24h of 20 days = 95.00 (worse than r1's 100)
  })

  it('ids that resolve to nothing are skipped, and the result reflects only what resolved', () => {
    const out = computeIncidentIoUptime(html([], [{ id: 'r1', since: '2024-01-01T00:00:00Z' }]), ['r1', 'gone'], NOW)
    expect(out).toEqual({ pct: 100, days: 30, todayWeightedOutageSec: 0 })
  })

  // #1006 review — an ONGOING impact has end_at `$undefined` (→ null). It must count to NOW, not be
  // dropped: dropping it read a spotless ~100% next to a live outage, the incoherence this set out to kill.
  it('an ONGOING impact (no end) counts to now, it is not dropped', () => {
    const out = computeIncidentIoUptime(
      html([{ id: 'c1', start: at(0, -24), end: '$undefined', status: 'full_outage' }], ESTABLISHED), 'c1', NOW,
    )
    // started 24h ago, still open → 24h of 30 days counts to now → 96.66%, NOT 100%.
    expect(out).toEqual({ pct: 96.66, days: 30, todayWeightedOutageSec: 0 })
  })

  // #1006 review — a degraded window escalating into a full outage must not double-count the overlap.
  it('OVERLAPPING impacts on one component merge (worst-weight-wins), never sum', () => {
    const out = computeIncidentIoUptime(
      html(
        [
          { id: 'c1', start: at(5, 0), end: at(5, 10), status: 'degraded_performance' }, // 10h @0.3
          { id: 'c1', start: at(5, 2), end: at(5, 3), status: 'full_outage' }, // 1h @1.0 nested inside
        ],
        ESTABLISHED,
      ),
      'c1', NOW,
    )
    // Summed: 10h*0.3 + 1h*1.0 = 4.0h. Merged: 9h@0.3 + 1h@1.0 = 3.7h of 30d → 99.48%.
    expect(out).toEqual({ pct: 99.48, days: 30, todayWeightedOutageSec: 0 })
  })

  // #1006 review / #713 — when component_impacts is PRESENT but unparseable, withhold (null), never read
  // the empty list as "no downtime" and fabricate a 100% (data_available_since is a separate regex).
  it('withholds (null) when component_impacts is present but unparseable — never a fabricated 100%', () => {
    const broken =
      `<script>self.__next_f.push([1,"a:{\\"component_impacts\\":[{\\"component_id\\":\\"c1\\" BROKEN}],` +
      `\\"component_uptimes\\":[{\\"component_id\\":\\"c1\\",\\"data_available_since\\":\\"2024-01-01T00:00:00Z\\",` +
      `\\"status_page_component_group_id\\":\\"$undefined\\",\\"uptime\\":\\"100.00\\"}],\\"incident_links\\":[]}"])</script>`
    expect(computeIncidentIoUptime(broken, 'c1', NOW)).toBeNull()
  })

  // #1017 — the file's shared NOW is exactly midnight UTC, so "today so far" is always a zero-length
  // window there (correctly 0 in every test above). A separate NOW mid-day is needed to exercise a
  // genuinely non-zero todayWeightedOutageSec end-to-end through the real parser.
  it('#1017 — todayWeightedOutageSec reflects only the portion of an outage inside today, not the full 30d', () => {
    const midDay = Date.parse('2026-07-14T15:00:00Z') // 15h into the UTC day
    // Outage ran from 3h before midDay to 1h before midDay — 2h, entirely inside today.
    const impact = { id: 'c1', start: at2(midDay, 3), end: at2(midDay, 1), status: 'full_outage' }
    const out = computeIncidentIoUptime(html([impact], ESTABLISHED), 'c1', midDay)
    expect(out?.todayWeightedOutageSec).toBe(2 * 3600) // 2h at full weight (1.0)
  })

  it('#1017 — an outage entirely BEFORE today contributes 0 to todayWeightedOutageSec but still counts toward the 30d pct', () => {
    const midDay = Date.parse('2026-07-14T15:00:00Z')
    const yesterday9pm = midDay - 18 * 3_600_000 // well before today's UTC midnight
    const impact = { id: 'c1', start: new Date(yesterday9pm - 3_600_000).toISOString(), end: new Date(yesterday9pm).toISOString(), status: 'full_outage' }
    const out = computeIncidentIoUptime(html([impact], ESTABLISHED), 'c1', midDay)
    expect(out?.todayWeightedOutageSec).toBe(0)
    expect(out?.pct).toBeLessThan(100) // the outage is still inside the 30-day window
  })
})

/** ISO timestamp `hoursAgo` hours before `nowMs`. Distinct from the file's `at(daysAgo, hours)`
 *  helper (which offsets from the shared midnight NOW) — this one is for the #1017 mid-day tests. */
function at2(nowMs: number, hoursAgo: number): string {
  return new Date(nowMs - hoursAgo * 3_600_000).toISOString()
}

describe('parseIncidentIoComponentImpacts', () => {
  const makeHtml = (impacts: Array<{ component_id: string; start_at: string; end_at: string; status: string }>) => {
    const escaped = JSON.stringify(impacts).replace(/"/g, '\\"')
    return `<script>self.__next_f.push([1,"component_impacts\\":${escaped},\\"component_uptimes\\":[]"])</script>`
  }

  it('maps status to daily impact levels', () => {
    const result = parseIncidentIoComponentImpacts(
      makeHtml([
        { component_id: 'c1', start_at: '2026-03-01T10:00:00Z', end_at: '2026-03-01T12:00:00Z', status: 'full_outage' },
        { component_id: 'c1', start_at: '2026-03-02T10:00:00Z', end_at: '2026-03-02T11:00:00Z', status: 'partial_outage' },
        { component_id: 'c1', start_at: '2026-03-03T10:00:00Z', end_at: '2026-03-03T10:30:00Z', status: 'degraded_performance' },
      ]),
      'c1'
    )
    // #693 follow-up — keys are the impact's real ISO start (so the client buckets to the local day)
    expect(result['2026-03-01T10:00:00.000Z']).toBe('critical')
    expect(result['2026-03-02T10:00:00.000Z']).toBe('major')
    expect(result['2026-03-03T10:00:00.000Z']).toBe('minor')
  })

  it('skips impacts shorter than 10 minutes', () => {
    const result = parseIncidentIoComponentImpacts(
      makeHtml([
        { component_id: 'c1', start_at: '2026-03-01T10:00:00Z', end_at: '2026-03-01T10:05:00Z', status: 'degraded_performance' },
      ]),
      'c1'
    )
    expect(result).toEqual({})
  })

  it('filters by component ID', () => {
    const result = parseIncidentIoComponentImpacts(
      makeHtml([
        { component_id: 'c1', start_at: '2026-03-01T10:00:00Z', end_at: '2026-03-01T12:00:00Z', status: 'partial_outage' },
        { component_id: 'c2', start_at: '2026-03-02T10:00:00Z', end_at: '2026-03-02T12:00:00Z', status: 'full_outage' },
      ]),
      'c1'
    )
    expect(Object.keys(result)).toEqual(['2026-03-01T10:00:00.000Z'])
  })

  it('spans multi-day impacts', () => {
    const result = parseIncidentIoComponentImpacts(
      makeHtml([
        { component_id: 'c1', start_at: '2026-03-01T22:00:00Z', end_at: '2026-03-03T02:00:00Z', status: 'degraded_performance' },
      ]),
      'c1'
    )
    // span → real start (day 1) + noon (full middle day) + real end (day 3)
    expect(result['2026-03-01T22:00:00.000Z']).toBe('minor')
    expect(result['2026-03-02T12:00:00.000Z']).toBe('minor')
    expect(result['2026-03-03T02:00:00.000Z']).toBe('minor')
  })
})

describe('parseIncidentIoUpdates', () => {
  it('extracts updates from __next_f SSR payload', () => {
    const html = `<script>self.__next_f.push([1,"\\"message_string\\":\\"We are investigating elevated errors\\",\\"published_at\\":\\"2026-03-20T10:00:00Z\\",\\"to_status\\":\\"investigating\\""])</script>`
    const updates = parseIncidentIoUpdates(html)
    expect(updates).toHaveLength(1)
    expect(updates[0].stage).toBe('investigating')
    expect(updates[0].text).toBe('We are investigating elevated errors')
    expect(updates[0].at).toBe('2026-03-20T10:00:00Z')
  })

  it('maps to_status to correct stage', () => {
    const make = (status: string) =>
      `<script>self.__next_f.push([1,"\\"message_string\\":\\"msg\\",\\"published_at\\":\\"2026-03-20T10:00:00Z\\",\\"to_status\\":\\"${status}\\""])</script>`
    expect(parseIncidentIoUpdates(make('resolved'))[0].stage).toBe('resolved')
    expect(parseIncidentIoUpdates(make('monitoring'))[0].stage).toBe('monitoring')
    expect(parseIncidentIoUpdates(make('identified'))[0].stage).toBe('identified')
    expect(parseIncidentIoUpdates(make('investigating'))[0].stage).toBe('investigating')
    expect(parseIncidentIoUpdates(make('unknown_status'))[0].stage).toBe('investigating')
  })

  it('extracts multiple updates from a single chunk', () => {
    const html = `<script>self.__next_f.push([1,"\\"message_string\\":\\"First update\\",\\"published_at\\":\\"2026-03-20T10:00:00Z\\",\\"to_status\\":\\"investigating\\",\\"message_string\\":\\"Second update\\",\\"published_at\\":\\"2026-03-20T11:00:00Z\\",\\"to_status\\":\\"resolved\\""])</script>`
    const updates = parseIncidentIoUpdates(html)
    expect(updates).toHaveLength(2)
    expect(updates[0].stage).toBe('investigating')
    expect(updates[1].stage).toBe('resolved')
  })

  it('returns empty for HTML without __next_f', () => {
    expect(parseIncidentIoUpdates('<html>no data</html>')).toEqual([])
  })
})

describe('buildTextCache', () => {
  it('creates cache from incident timeline', () => {
    const inc: Incident = {
      id: 'inc1', title: 'Test', status: 'resolved', impact: 'major',
      startedAt: '2026-03-20T10:00:00Z', duration: '1h 0m',
      timeline: [
        { stage: 'investigating', text: 'Looking into it', at: '2026-03-20T10:00:00Z' },
        { stage: 'resolved', text: 'Fixed', at: '2026-03-20T11:00:00Z' },
      ],
    }
    const cache = buildTextCache(inc)
    expect(cache.textByKey['investigating:2026-03-20T10:00:00Z']).toBe('Looking into it')
    expect(cache.textByKey['resolved:2026-03-20T11:00:00Z']).toBe('Fixed')
    expect(cache.cachedAt).toBeDefined()
  })

  it('stores null for timeline entries without text', () => {
    const inc: Incident = {
      id: 'inc1', title: 'Test', status: 'investigating', impact: null,
      startedAt: '2026-03-20T10:00:00Z', duration: null,
      timeline: [{ stage: 'investigating', text: null, at: '2026-03-20T10:00:00Z' }],
    }
    const cache = buildTextCache(inc)
    expect(cache.textByKey['investigating:2026-03-20T10:00:00Z']).toBeNull()
  })
})

describe('applyTextCache', () => {
  it('fills null text from cache', () => {
    const inc: Incident = {
      id: 'inc1', title: 'Test', status: 'resolved', impact: 'major',
      startedAt: '2026-03-20T10:00:00Z', duration: '1h 0m',
      timeline: [
        { stage: 'investigating', text: null, at: '2026-03-20T10:00:00Z' },
        { stage: 'resolved', text: null, at: '2026-03-20T11:00:00Z' },
      ],
    }
    const cache: IncidentTextCache = {
      textByKey: {
        'investigating:2026-03-20T10:00:00Z': 'Cached investigating text',
        'resolved:2026-03-20T11:00:00Z': 'Cached resolved text',
      },
      cachedAt: '2026-03-20T12:00:00Z',
    }
    const result = applyTextCache(inc, cache)
    expect(result.timeline[0].text).toBe('Cached investigating text')
    expect(result.timeline[1].text).toBe('Cached resolved text')
  })

  it('preserves existing text (does not overwrite)', () => {
    const inc: Incident = {
      id: 'inc1', title: 'Test', status: 'resolved', impact: null,
      startedAt: '2026-03-20T10:00:00Z', duration: null,
      timeline: [{ stage: 'investigating', text: 'Original', at: '2026-03-20T10:00:00Z' }],
    }
    const cache: IncidentTextCache = {
      textByKey: { 'investigating:2026-03-20T10:00:00Z': 'Cached' },
      cachedAt: '2026-03-20T12:00:00Z',
    }
    const result = applyTextCache(inc, cache)
    expect(result.timeline[0].text).toBe('Original')
  })

  it('leaves text as null when cache key is absent', () => {
    const inc: Incident = {
      id: 'inc1', title: 'Test', status: 'investigating', impact: null,
      startedAt: '2026-03-20T10:00:00Z', duration: null,
      timeline: [{ stage: 'investigating', text: null, at: '2026-03-20T10:00:00Z' }],
    }
    const cache: IncidentTextCache = { textByKey: {}, cachedAt: '2026-03-20T12:00:00Z' }
    const result = applyTextCache(inc, cache)
    expect(result.timeline[0].text).toBeNull()
  })

  it('applies cached null (scraped but no text found)', () => {
    const inc: Incident = {
      id: 'inc1', title: 'Test', status: 'investigating', impact: null,
      startedAt: '2026-03-20T10:00:00Z', duration: null,
      timeline: [{ stage: 'investigating', text: null, at: '2026-03-20T10:00:00Z' }],
    }
    const cache: IncidentTextCache = {
      textByKey: { 'investigating:2026-03-20T10:00:00Z': null },
      cachedAt: '2026-03-20T12:00:00Z',
    }
    const result = applyTextCache(inc, cache)
    expect(result.timeline[0].text).toBeNull()
  })
})

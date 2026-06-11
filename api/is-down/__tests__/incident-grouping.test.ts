import { describe, it, expect } from 'vitest'
import {
  groupIncidents,
  normalizeTitle,
  isGenericTitle,
  isFlapTitle,
  GENERIC_TITLE_PATTERNS_SOURCES,
  GROUP_THRESHOLD,
  type GroupingIncident,
  type GroupRow,
  type SingleRow,
} from '../incident-grouping'

function mkInc(overrides: Partial<GroupingIncident> = {}): GroupingIncident {
  return {
    id: overrides.id ?? 'x',
    title: overrides.title ?? 'Untitled',
    startedAt: overrides.startedAt ?? '2026-04-20T10:00:00Z',
    status: overrides.status ?? 'resolved',
    impact: overrides.impact ?? null,
    duration: overrides.duration ?? null,
    resolvedAt: overrides.resolvedAt ?? null,
  }
}

describe('normalizeTitle', () => {
  it('strips trailing " — recovered"', () => {
    expect(normalizeTitle('Nomic Embed v1.5 — recovered')).toBe('Nomic Embed v1.5')
  })
  it('handles null and undefined safely', () => {
    expect(normalizeTitle(null)).toBe('')
    expect(normalizeTitle(undefined)).toBe('')
  })
  it('leaves non-suffix text intact', () => {
    expect(normalizeTitle('Opus 4.6 elevated errors')).toBe('Opus 4.6 elevated errors')
  })
})

describe('groupIncidents — empty + below threshold', () => {
  it('returns empty for empty input', () => {
    expect(groupIncidents([])).toEqual([])
  })
  it('emits every entry as a single row when no bucket reaches the threshold', () => {
    const incs = [
      mkInc({ id: 'a', title: 'Alpha', startedAt: '2026-04-20T10:00:00Z' }),
      mkInc({ id: 'b', title: 'Beta', startedAt: '2026-04-20T11:00:00Z' }),
    ]
    const rows = groupIncidents(incs)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.kind === 'single')).toBe(true)
  })
})

describe('groupIncidents — threshold = 2', () => {
  it('three same-day normalized-title entries collapse to one group row', () => {
    const day = '2026-04-20T'
    const incs = [
      mkInc({ id: '1', title: 'Nomic Embed', startedAt: day + '10:00:00Z' }),
      mkInc({ id: '2', title: 'Nomic Embed', startedAt: day + '11:00:00Z' }),
      mkInc({ id: '3', title: 'Nomic Embed — recovered', startedAt: day + '12:00:00Z' }),
    ]
    const rows = groupIncidents(incs)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('group')
    const g = rows[0] as GroupRow
    expect(g.count).toBe(3)
    expect(g.normalizedTitle).toBe('Nomic Embed')
    expect(g.rangeStart).toBe(day + '10:00:00Z')
    expect(g.rangeEnd).toBe(day + '12:00:00Z')
  })

  it('exactly 2 dupes group together (≥2 threshold, lowered from ≥3 in #373)', () => {
    expect(GROUP_THRESHOLD).toBe(2)
    const incs = [
      mkInc({ id: '1', title: 'Alpha', startedAt: '2026-04-20T10:00:00Z' }),
      mkInc({ id: '2', title: 'Alpha', startedAt: '2026-04-20T11:00:00Z' }),
    ]
    const rows = groupIncidents(incs)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('group')
    expect((rows[0] as GroupRow).count).toBe(2)
  })

  it('1 entry stays a single (below ≥2 threshold)', () => {
    const rows = groupIncidents([mkInc({ id: '1', title: 'Alpha', startedAt: '2026-04-20T10:00:00Z' })])
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('single')
  })

  it('entries with impact != null never group (human-tagged real incidents)', () => {
    const incs = [
      mkInc({ id: '1', title: 'Major outage', impact: 'major', startedAt: '2026-04-20T10:00:00Z' }),
      mkInc({ id: '2', title: 'Major outage', impact: 'major', startedAt: '2026-04-20T11:00:00Z' }),
      mkInc({ id: '3', title: 'Major outage', impact: 'major', startedAt: '2026-04-20T12:00:00Z' }),
    ]
    const rows = groupIncidents(incs)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.kind === 'single')).toBe(true)
  })
})

describe('groupIncidents — day boundary', () => {
  it('UTC default: respects day boundary — 23:30Z and 01:00Z next day land in different buckets', () => {
    // After #373 (≥2 threshold), the two same-day entries cluster but the next-day entry stays single.
    const incs = [
      mkInc({ id: '1', title: 'X', startedAt: '2026-04-20T23:00:00Z' }),
      mkInc({ id: '2', title: 'X', startedAt: '2026-04-20T23:30:00Z' }),
      mkInc({ id: '3', title: 'X', startedAt: '2026-04-21T01:00:00Z' }),
    ]
    const rows = groupIncidents(incs) // default UTC
    expect(rows).toHaveLength(2)
    const group = rows.find((r) => r.kind === 'group') as GroupRow | undefined
    const single = rows.find((r) => r.kind === 'single') as SingleRow | undefined
    expect(group?.count).toBe(2)
    expect(single?.incident.id).toBe('3')
  })

  it('SSR determinism: same timezone override produces same groups across calls', () => {
    const incs = [
      mkInc({ id: '1', title: 'X', startedAt: '2026-04-20T15:00:00Z' }),
      mkInc({ id: '2', title: 'X', startedAt: '2026-04-20T16:00:00Z' }),
      mkInc({ id: '3', title: 'X', startedAt: '2026-04-20T17:00:00Z' }),
    ]
    const r1 = groupIncidents(incs, { timeZone: 'UTC' })
    const r2 = groupIncidents(incs, { timeZone: 'UTC' })
    expect(r1).toEqual(r2)
    expect(r1).toHaveLength(1)
  })

  it('honors explicit timeZone override (KST ≡ UTC+9)', () => {
    // 14:00 UTC → 23:00 KST same day; 15:30 UTC → 00:30 KST next day
    const incs = [
      mkInc({ id: '1', title: 'X', startedAt: '2026-04-20T14:00:00Z' }),
      mkInc({ id: '2', title: 'X', startedAt: '2026-04-20T14:30:00Z' }),
      mkInc({ id: '3', title: 'X', startedAt: '2026-04-20T15:30:00Z' }), // 00:30 KST Apr 21
    ]
    const rows = groupIncidents(incs, { timeZone: 'Asia/Seoul' })
    // After #373 (≥2 threshold): first 2 cluster on Apr 20 KST, third stays single on Apr 21 KST.
    // The point of this test is timezone-correct day-boundary detection — verified by the split.
    const group = rows.find((r) => r.kind === 'group') as GroupRow | undefined
    expect(group?.count).toBe(2)
    expect(rows.find((r) => r.kind === 'single')).toBeDefined()
  })
})

describe('groupIncidents — sort order', () => {
  it('emits newest-first by latest activity (#411 — falls back to startedAt when resolvedAt unset)', () => {
    const rows = groupIncidents([
      mkInc({ id: 'old-single', title: 'Alpha', startedAt: '2026-04-10T10:00:00Z' }),
      mkInc({ id: 'g1', title: 'Group', startedAt: '2026-04-20T10:00:00Z' }),
      mkInc({ id: 'g2', title: 'Group', startedAt: '2026-04-20T11:00:00Z' }),
      mkInc({ id: 'g3', title: 'Group', startedAt: '2026-04-20T12:00:00Z' }),
      mkInc({ id: 'recent-single', title: 'Zeta', startedAt: '2026-04-22T10:00:00Z' }),
    ])
    // newest → oldest: recent-single, group (rangeEnd=Apr20 12:00), old-single
    expect(rows).toHaveLength(3)
    expect(rows[0].kind).toBe('single')
    expect((rows[0] as SingleRow).incident.id).toBe('recent-single')
    expect(rows[1].kind).toBe('group')
    expect((rows[1] as GroupRow).count).toBe(3)
    expect(rows[2].kind).toBe('single')
    expect((rows[2] as SingleRow).incident.id).toBe('old-single')
  })
})

describe('groupIncidents — statusCounts + uniformStatus', () => {
  it('records per-status counts and flags mixed status groups', () => {
    const rows = groupIncidents([
      mkInc({ id: '1', title: 'X', status: 'resolved', startedAt: '2026-04-20T10:00:00Z' }),
      mkInc({ id: '2', title: 'X', status: 'resolved', startedAt: '2026-04-20T11:00:00Z' }),
      mkInc({ id: '3', title: 'X', status: 'investigating', startedAt: '2026-04-20T12:00:00Z' }),
    ])
    const g = rows[0] as GroupRow
    expect(g.statusCounts).toEqual({ resolved: 2, investigating: 1 })
    expect(g.uniformStatus).toBe(false)
  })

  it('uniformStatus=true when all entries share status', () => {
    const rows = groupIncidents([
      mkInc({ id: '1', title: 'X', status: 'resolved', startedAt: '2026-04-20T10:00:00Z' }),
      mkInc({ id: '2', title: 'X', status: 'resolved', startedAt: '2026-04-20T11:00:00Z' }),
      mkInc({ id: '3', title: 'X', status: 'resolved', startedAt: '2026-04-20T12:00:00Z' }),
    ])
    const g = rows[0] as GroupRow
    expect(g.uniformStatus).toBe(true)
  })
})

describe('isGenericTitle (#387)', () => {
  it('matches Statuspage auto-monitoring placeholder', () => {
    expect(isGenericTitle('Investigating an issue')).toBe(true)
    expect(isGenericTitle('Service disruption')).toBe(true)
    expect(isGenericTitle('Scheduled maintenance')).toBe(true)
  })

  it('does NOT match real human-curated titles', () => {
    expect(isGenericTitle('Elevated error rates affecting ChatGPT for some users in Europe')).toBe(false)
    expect(isGenericTitle('Outage in us-east-1')).toBe(false)
    expect(isGenericTitle('Issue affecting some pages on the ChatGPT website')).toBe(false)
  })

  it('does NOT match human-written copy that starts with "We are aware/investigating" (anchor regression)', () => {
    expect(isGenericTitle('We are aware of an issue with API requests timing out')).toBe(false)
    expect(isGenericTitle('We are investigating elevated 5xx on /v1/messages')).toBe(false)
  })

  it('handles null/undefined defensively', () => {
    expect(isGenericTitle(null)).toBe(false)
    expect(isGenericTitle(undefined)).toBe(false)
    expect(isGenericTitle('')).toBe(false)
  })
})

describe('GENERIC_TITLE_PATTERNS_SOURCES — cross-file parity (#387)', () => {
  // Mirror of the SPA test in `src/utils/__tests__/incidentGrouping.test.js`.
  // Drift between SPA / SSR / worker source-of-truth fails this test.
  const EXPECTED_SOURCES = [
    '^investigating (an |the |this )?issue\\.?$::i',
    '^(service |system )?(disruption|outage|issue|incident)\\.?$::i',
    '^we are (currently )?(investigating|aware)( (of )?(an?|this|the) (issue|incident|problem))?\\.?$::i',
    '^(scheduled |planned )?maintenance\\.?$::i',
    '^(partial |minor |major )?(service )?(degradation|interruption)\\.?$::i',
  ]

  it('SSR pattern sources match the canonical snapshot', () => {
    expect(GENERIC_TITLE_PATTERNS_SOURCES).toEqual(EXPECTED_SOURCES)
  })
})

describe('groupIncidents — generic-title flap clustering despite impact != null (#387)', () => {
  it("groups 8 same-day Character.AI 'Investigating an issue' minor-impact entries", () => {
    const incs: GroupingIncident[] = Array.from({ length: 8 }, (_, i) =>
      mkInc({
        id: `char-${i}`,
        title: 'Investigating an issue',
        impact: 'minor',
        startedAt: `2026-05-06T0${i % 10}:00:00Z`,
      }),
    )
    const result = groupIncidents(incs)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect((result[0] as GroupRow).count).toBe(8)
  })

  it('does NOT group when title is real human copy, even at the same impact', () => {
    const incs: GroupingIncident[] = [
      mkInc({ id: 'r-1', title: 'Outage in us-east-1', impact: 'major', startedAt: '2026-05-06T01:00:00Z' }),
      mkInc({ id: 'r-2', title: 'Outage in us-east-1', impact: 'major', startedAt: '2026-05-06T02:00:00Z' }),
    ]
    const result = groupIncidents(incs)
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.kind === 'single')).toBe(true)
  })

  it('mixed input — real incidents stay single, generic-title flaps cluster', () => {
    const incs: GroupingIncident[] = [
      mkInc({ id: 'real-1', title: 'Elevated error rates in eu-west', impact: 'major', startedAt: '2026-05-06T08:00:00Z' }),
      ...Array.from({ length: 3 }, (_, i) =>
        mkInc({
          id: `gen-${i}`,
          title: 'Investigating an issue',
          impact: 'minor',
          startedAt: `2026-05-06T${String(9 + i).padStart(2, '0')}:00:00Z`,
        }),
      ),
      mkInc({ id: 'real-2', title: 'Latency spike on Asia ingest', impact: 'minor', startedAt: '2026-05-06T13:00:00Z' }),
    ]
    const result = groupIncidents(incs)
    const groups = result.filter((r): r is GroupRow => r.kind === 'group')
    const singles = result.filter((r): r is SingleRow => r.kind === 'single')
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(3)
    expect(singles).toHaveLength(2)
  })

  it('still groups generic-title incidents with impact == null (no regression)', () => {
    const incs: GroupingIncident[] = Array.from({ length: 2 }, (_, i) =>
      mkInc({
        id: `null-${i}`,
        title: 'Investigating an issue',
        impact: null,
        startedAt: `2026-05-06T1${i}:00:00Z`,
      }),
    )
    const result = groupIncidents(incs)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
  })
})

describe('groupIncidents — sort axis alignment with latest activity (#411)', () => {
  // SSR mirror of the SPA regression: resolved incidents sort by resolvedAt,
  // not startedAt, so /is-X-down's grouped list matches Overview's order.
  it('two resolved singles: sorts by resolvedAt desc, not startedAt desc', () => {
    const modal = mkInc({ id: 'modal-1', title: 'Storage refactor following AWS us-east-1c issues', startedAt: '2026-05-11T08:59:00Z', resolvedAt: '2026-05-11T09:00:00Z', status: 'resolved', impact: 'minor', duration: '1m' })
    const together = mkInc({ id: 'together-1', title: 'Kimi K2.6 — recovered', startedAt: '2026-05-11T08:57:00Z', resolvedAt: '2026-05-11T09:10:00Z', status: 'resolved', impact: null, duration: '13m' })
    const result = groupIncidents([modal, together])
    expect(result).toHaveLength(2)
    const ids = result.map((r) => (r.kind === 'single' ? (r as SingleRow).incident.id : null))
    expect(ids[0]).toBe('together-1') // resolvedAt 09:10
    expect(ids[1]).toBe('modal-1')    // resolvedAt 09:00
  })

  it('tiebreak on identical resolvedAt preserves original input index', () => {
    const a = mkInc({ id: 'a', title: 'Service A — recovered', startedAt: '2026-05-11T08:00:00Z', resolvedAt: '2026-05-11T09:00:00Z', status: 'resolved', impact: null })
    const b = mkInc({ id: 'b', title: 'Service B — recovered', startedAt: '2026-05-11T08:30:00Z', resolvedAt: '2026-05-11T09:00:00Z', status: 'resolved', impact: null })
    const result = groupIncidents([a, b])
    const ids = result.map((r) => (r.kind === 'single' ? (r as SingleRow).incident.id : null))
    expect(ids).toEqual(['a', 'b'])
  })
})

describe('groupIncidents — BetterStack minor flap markers (#597)', () => {
  it('groups same-day minor "<model> — recovered" flap series (Together/Gemma case)', () => {
    // BetterStack tags auto-recovery model blips impact:'minor' (not null), so before
    // #597 they escaped the impact != null guard and swamped the SSR history list.
    const incs: GroupingIncident[] = Array.from({ length: 7 }, (_, i) =>
      mkInc({ id: `gemma-${i}`, title: 'Google Gemma 4 31B IT — recovered', impact: 'minor', startedAt: `2026-06-08T${String(5 + i * 2).padStart(2, '0')}:00:00Z` }),
    )
    const result = groupIncidents(incs)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect((result[0] as GroupRow).count).toBe(7)
    expect((result[0] as GroupRow).normalizedTitle).toBe('Google Gemma 4 31B IT')
  })

  it('does NOT group major "— recovered" — only minor flaps cluster', () => {
    const incs: GroupingIncident[] = Array.from({ length: 3 }, (_, i) =>
      mkInc({ id: `maj-${i}`, title: 'Model serving — recovered', impact: 'major', startedAt: `2026-06-08T1${i}:00:00Z` }),
    )
    const result = groupIncidents(incs)
    expect(result).toHaveLength(3)
    expect(result.every((r) => r.kind === 'single')).toBe(true)
  })

  it('buckets a "— down" + "— recovered" minor flap cycle into one group', () => {
    const incs: GroupingIncident[] = [
      mkInc({ id: 'd1', title: 'Pearl-ai Gemma 4 31B IT — down', impact: 'minor', startedAt: '2026-06-08T05:00:00Z' }),
      mkInc({ id: 'r1', title: 'Pearl-ai Gemma 4 31B IT — recovered', impact: 'minor', startedAt: '2026-06-08T05:25:00Z' }),
    ]
    const result = groupIncidents(incs)
    expect(result).toHaveLength(1)
    expect((result[0] as GroupRow).count).toBe(2)
    expect((result[0] as GroupRow).normalizedTitle).toBe('Pearl-ai Gemma 4 31B IT')
  })

  it('a lone minor flap stays a single row (below threshold — no false-positive)', () => {
    const result = groupIncidents([
      mkInc({ id: 'solo', title: 'Some Model — recovered', impact: 'minor', startedAt: '2026-06-08T05:00:00Z' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('single')
  })
})

describe('isFlapTitle (#597)', () => {
  it('matches "— recovered" / "— down" suffixes; not plain or mid-string', () => {
    expect(isFlapTitle('Google Gemma 4 31B IT — recovered')).toBe(true)
    expect(isFlapTitle('Foo — down')).toBe(true)
    expect(isFlapTitle('Elevated API errors')).toBe(false)
    expect(isFlapTitle('Service recovered after a brief outage')).toBe(false)
    expect(isFlapTitle(null)).toBe(false)
    expect(isFlapTitle('')).toBe(false)
  })
})

describe('normalizeTitle — "— down" suffix (#597)', () => {
  it('strips trailing " — down"', () => {
    expect(normalizeTitle('Google Gemma 4 31B IT — down')).toBe('Google Gemma 4 31B IT')
  })
})

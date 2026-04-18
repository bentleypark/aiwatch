import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseIncidentIoUptime, parseIncidentIoComponentImpacts, computeUptimeFromIncidents, parseIncidentIoUpdates, applyTextCache, buildTextCache } from '../incident-io'
import type { IncidentTextCache } from '../incident-io'
import type { Incident } from '../../types'

describe('parseIncidentIoUptime', () => {
  const makeHtml = (uptimes: Array<{ component_id: string; uptime: string }>) => {
    const escaped = JSON.stringify(uptimes).replace(/"/g, '\\"')
    return `<script>self.__next_f.push([1,"component_uptimes\\":${escaped}"])</script>`
  }

  it('extracts uptime for matching component', () => {
    const html = makeHtml([
      { component_id: 'comp1', uptime: '99.95' },
      { component_id: 'comp2', uptime: '100.00' },
    ])
    expect(parseIncidentIoUptime(html, 'comp1')).toBe(99.95)
    expect(parseIncidentIoUptime(html, 'comp2')).toBe(100)
  })

  it('returns null for $undefined uptime', () => {
    const html = `<script>self.__next_f.push([1,"\\"component_id\\":\\"comp1\\",\\"uptime\\":\\"$undefined\\""])</script>`
    // The actual HTML has component_uptimes context
    const realHtml = `<script>self.__next_f.push([1,"component_uptimes\\":[{\\"component_id\\":\\"comp1\\",\\"uptime\\":\\"$undefined\\"}]"])</script>`
    expect(parseIncidentIoUptime(realHtml, 'comp1')).toBeNull()
  })

  it('returns null when component not found', () => {
    const html = '<html>no data</html>'
    expect(parseIncidentIoUptime(html, 'missing')).toBeNull()
  })

  it('does not cross-match componentId from component_impacts section', () => {
    // Simulates real OpenAI status page: same componentId appears in both
    // component_impacts (incident data) and component_uptimes (uptime data).
    // The regex must only match within component_uptimes to get the correct value.
    const html = `<script>self.__next_f.push([1,"component_impacts\\":[{\\"component_id\\":\\"target\\",\\"status\\":\\"degraded\\"}],\\"component_uptimes\\":[{\\"component_id\\":\\"other\\",\\"uptime\\":\\"100.00\\"},{\\"component_id\\":\\"target\\",\\"uptime\\":\\"99.98\\"}]"])</script>`
    expect(parseIncidentIoUptime(html, 'target')).toBe(99.98)
  })

  it('prefers group uptime over individual component uptime when groupId provided', () => {
    // OpenAI "APIs" group has aggregate uptime 99.99% with $undefined component_id
    const html = `<script>self.__next_f.push([1,"component_uptimes\\":[{\\"component_id\\":\\"comp1\\",\\"data_available_since\\":\\"2021-01-01\\",\\"status_page_component_group_id\\":\\"$undefined\\",\\"uptime\\":\\"100.00\\"},{\\"component_id\\":\\"$undefined\\",\\"data_available_since\\":\\"2021-01-01\\",\\"status_page_component_group_id\\":\\"group1\\",\\"uptime\\":\\"99.99\\"}]"])</script>`
    // With groupId → returns group aggregate (99.99%)
    expect(parseIncidentIoUptime(html, 'comp1', 'group1')).toBe(99.99)
    // Without groupId → returns individual component (100%)
    expect(parseIncidentIoUptime(html, 'comp1')).toBe(100)
  })
})

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
    expect(result['2026-03-01']).toBe('critical')
    expect(result['2026-03-02']).toBe('major')
    expect(result['2026-03-03']).toBe('minor')
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
    expect(Object.keys(result)).toEqual(['2026-03-01'])
  })

  it('spans multi-day impacts', () => {
    const result = parseIncidentIoComponentImpacts(
      makeHtml([
        { component_id: 'c1', start_at: '2026-03-01T22:00:00Z', end_at: '2026-03-03T02:00:00Z', status: 'degraded_performance' },
      ]),
      'c1'
    )
    expect(result['2026-03-01']).toBe('minor')
    expect(result['2026-03-02']).toBe('minor')
    expect(result['2026-03-03']).toBe('minor')
  })
})

describe('computeUptimeFromIncidents', () => {
  // Belt-and-suspenders: if any future contributor adds .concurrent or top-level
  // afterEach config drift, this restores any leaked spies between tests.
  afterEach(() => vi.restoreAllMocks())

  it('returns null for empty incidents', () => {
    expect(computeUptimeFromIncidents([])).toBeNull()
  })

  it('returns 100 when all incidents are outside 90-day window', () => {
    const result = computeUptimeFromIncidents([{
      id: '1', title: 'Old', status: 'resolved', impact: 'major',
      startedAt: '2020-01-01T00:00:00Z', duration: '1h 0m',
      timeline: [],
    }])
    expect(result).toBe(100)
  })

  it('computes uptime from recent major incidents (weight 1.0)', () => {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString()
    const result = computeUptimeFromIncidents([{
      id: '1', title: 'Recent', status: 'resolved', impact: 'major',
      startedAt: yesterday, duration: '1h 0m',
      timeline: [],
    }])
    expect(result).not.toBeNull()
    expect(result!).toBeGreaterThan(99)
    expect(result!).toBeLessThan(100)
  })

  it('merges overlapping intervals (no double-count)', () => {
    const now = new Date()
    const base = new Date(now.getTime() - 86_400_000).toISOString()
    const result = computeUptimeFromIncidents([
      { id: '1', title: 'A', status: 'resolved', impact: 'major', startedAt: base, duration: '2h 0m', timeline: [] },
      { id: '2', title: 'B', status: 'resolved', impact: 'major', startedAt: base, duration: '1h 0m', timeline: [] },
    ])
    // Union = 2h out of 90 days = 1 - 2/(90×24); floored to 2 decimals
    const downMs = 2 * 3_600_000
    const expected = Math.floor((1 - downMs / (90 * 86_400_000)) * 10000) / 100
    expect(result).not.toBeNull()
    expect(result!).toBe(expected)
  })

  it('weights minor incidents at 0.3 (Atlassian formula)', () => {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString()
    const minorOnly = computeUptimeFromIncidents([{
      id: '1', title: 'Minor', status: 'resolved', impact: 'minor',
      startedAt: yesterday, duration: '10h 0m',
      timeline: [],
    }])
    const majorOnly = computeUptimeFromIncidents([{
      id: '2', title: 'Major', status: 'resolved', impact: 'major',
      startedAt: yesterday, duration: '10h 0m',
      timeline: [],
    }])
    // Minor's weighted downtime is 30% of major's
    // → minor uptime is closer to 100 than major uptime
    expect(minorOnly).not.toBeNull()
    expect(majorOnly).not.toBeNull()
    expect(minorOnly!).toBeGreaterThan(majorOnly!)
    // Approximate check: minor downtime ≈ 0.3 × major downtime
    const minorDown = 100 - minorOnly!
    const majorDown = 100 - majorOnly!
    expect(minorDown).toBeCloseTo(majorDown * 0.3, 2)
  })

  it('skips null-impact incidents (informational only)', () => {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString()
    const result = computeUptimeFromIncidents([{
      id: '1', title: 'Info', status: 'resolved', impact: null,
      startedAt: yesterday, duration: '10h 0m',
      timeline: [],
    }])
    // null impact filtered → no outage intervals → 100%
    expect(result).toBe(100)
  })

  it('uses max weight when major and minor overlap', () => {
    const now = new Date()
    const base = new Date(now.getTime() - 86_400_000).toISOString()
    // Major (weight 1.0) covers the full 2h; minor (0.3) overlaps for 1h
    // Max-weight-wins → effective weighted downtime = 2h × 1.0 = 2h
    const overlap = computeUptimeFromIncidents([
      { id: '1', title: 'Maj', status: 'resolved', impact: 'major', startedAt: base, duration: '2h 0m', timeline: [] },
      { id: '2', title: 'Min', status: 'resolved', impact: 'minor', startedAt: base, duration: '1h 0m', timeline: [] },
    ])
    const majorOnly = computeUptimeFromIncidents([
      { id: '1', title: 'Maj', status: 'resolved', impact: 'major', startedAt: base, duration: '2h 0m', timeline: [] },
    ])
    expect(overlap).not.toBeNull()
    expect(majorOnly).not.toBeNull()
    // Overlap should match major-only — minor doesn't add downtime in the overlap window
    expect(overlap!).toBeCloseTo(majorOnly!, 2)
  })

  it('treats critical with the same weight as major (1.0)', () => {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString()
    const critical = computeUptimeFromIncidents([{
      id: '1', title: 'Crit', status: 'resolved', impact: 'critical',
      startedAt: yesterday, duration: '5h 0m',
      timeline: [],
    }])
    const major = computeUptimeFromIncidents([{
      id: '2', title: 'Maj', status: 'resolved', impact: 'major',
      startedAt: yesterday, duration: '5h 0m',
      timeline: [],
    }])
    expect(critical).not.toBeNull()
    expect(major).not.toBeNull()
    expect(critical!).toBeCloseTo(major!, 2)
  })

  it('counts ongoing (unresolved) incidents up to now', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString()
    const result = computeUptimeFromIncidents([{
      id: '1', title: 'Active', status: 'investigating', impact: 'major',
      startedAt: twoHoursAgo, duration: null,
      timeline: [{ stage: 'investigating', text: null, at: twoHoursAgo }],
    }])
    // ~2h × 1.0 / (90 × 24h) → ~99.907%
    expect(result).not.toBeNull()
    const expected = 100 - (2 / (90 * 24)) * 100
    expect(result!).toBeCloseTo(expected, 1)
  })

  it('clamps incidents that started before the 90-day window', () => {
    const startedAt = new Date(Date.now() - 100 * 86_400_000).toISOString() // 100d ago
    // Duration 91d → resolves 9d ago, ~81d falls inside the 90-day window
    const result = computeUptimeFromIncidents([{
      id: '1', title: 'Old long', status: 'resolved', impact: 'major',
      startedAt, duration: `${91 * 24}h 0m`,
      timeline: [],
    }])
    // ~81d × 1.0 / 90d → ~10% uptime (without clamp this would go negative → 0)
    expect(result).not.toBeNull()
    expect(result!).toBeGreaterThan(9)
    expect(result!).toBeLessThan(11)
  })

  it('treats unknown impact strings as no-outage (defensive + warn)', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const result = computeUptimeFromIncidents([{
      id: '1', title: 'Future impact', status: 'resolved',
      impact: 'maintenance' as never, // hypothetical Atlassian addition
      startedAt: yesterday, duration: '10h 0m',
      timeline: [],
    }])
    // Unknown impact → parseErrorSkips=1; whole feed is unparseable → null (not 100)
    expect(result).toBeNull()
  })

  it('regresses ElevenLabs-shaped scenario: many minor incidents → ~99.7% (not ~91%)', () => {
    // 20 non-overlapping 10h minor incidents over 90 days → 200h × 0.3 weight
    // Old (un-weighted): 1 - 200/(90×24) ≈ 90.74%
    // New (weighted):    1 - 60/(90×24)  ≈ 97.22%
    const incidents = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      title: `Minor ${i}`,
      status: 'resolved' as const,
      impact: 'minor' as const,
      // Spread across 90d window with safe spacing (4d apart, latest 10d ago, earliest 86d ago)
      startedAt: new Date(Date.now() - (10 + i * 4) * 86_400_000).toISOString(),
      duration: '10h 0m',
      timeline: [],
    }))
    const result = computeUptimeFromIncidents(incidents)
    // Exact match — weighted downtime = 200h × 0.3 = 60h, floored to 2 decimals
    const downMs = 200 * 0.3 * 3_600_000
    const expected = Math.floor((1 - downMs / (90 * 86_400_000)) * 10000) / 100
    expect(result).toBe(expected)
  })

  it('handles abutting intervals (A.end === B.start) without losing or double-counting', () => {
    const now = Date.now()
    const t0 = new Date(now - 5 * 3_600_000).toISOString()
    const tMid = new Date(now - 3 * 3_600_000).toISOString()
    const result = computeUptimeFromIncidents([
      { id: '1', title: 'A', status: 'resolved', impact: 'major', startedAt: t0, duration: '2h 0m', timeline: [] },
      { id: '2', title: 'B', status: 'resolved', impact: 'minor', startedAt: tMid, duration: '2h 0m', timeline: [] },
    ])
    // Boundary instant assigned to A only — no overlap, no gap
    // Weighted downtime = 2h × 1.0 + 2h × 0.3 = 2.6h, floored to 2 decimals
    const downMs = 2.6 * 3_600_000
    const expected = Math.floor((1 - downMs / (90 * 86_400_000)) * 10000) / 100
    expect(result).not.toBeNull()
    expect(result!).toBe(expected)
  })

  it('preserves 2-decimal precision (no truncation at typical uptime scale)', () => {
    // Construct downtime targeting ~98.79% (ElevenLabs-shaped)
    const downMs = Math.round(0.0121 * 90 * 86_400_000)
    const startedAt = new Date(Date.now() - downMs - 1000).toISOString()
    const hours = Math.floor(downMs / 3_600_000)
    const mins = Math.floor((downMs % 3_600_000) / 60_000)
    const result = computeUptimeFromIncidents([{
      id: '1', title: 'Big', status: 'resolved', impact: 'major',
      startedAt, duration: `${hours}h ${mins}m`,
      timeline: [],
    }])
    expect(result).not.toBeNull()
    expect(result!).toBeCloseTo(98.79, 1)
    // Output must keep ≤2 decimals (not rounded to integer or 1 decimal)
    expect(result!.toString()).toMatch(/^\d+(\.\d{1,2})?$/)
  })

  it('returns null when entire feed is unparseable (vs misleading 100)', () => {
    const result = computeUptimeFromIncidents([
      { id: '1', title: 'Bad date', status: 'resolved', impact: 'major', startedAt: 'not-a-date', duration: '1h 0m', timeline: [] },
      { id: '2', title: 'Future', status: 'resolved', impact: 'minor', startedAt: new Date(Date.now() + 86_400_000).toISOString(), duration: '1h 0m', timeline: [] },
    ])
    expect(result).toBeNull()
  })

  it('returns 100 for informational-only feed (no false negative)', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const result = computeUptimeFromIncidents([
      { id: '1', title: 'Note', status: 'resolved', impact: null, startedAt: yesterday, duration: '5h 0m', timeline: [] },
      { id: '2', title: 'Note', status: 'resolved', impact: null, startedAt: yesterday, duration: '2h 0m', timeline: [] },
    ])
    expect(result).toBe(100)
  })

  it('returns null when all impactful entries fail (informational entries do not rescue)', () => {
    // Guards the `i.impact !== null` filter on the null-vs-100 decision — without it,
    // mixed feeds (3 informational + 2 bad-date) would silently flip to 100%.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const result = computeUptimeFromIncidents([
      { id: '1', title: 'Note', status: 'resolved', impact: null, startedAt: yesterday, duration: '5h 0m', timeline: [] },
      { id: '2', title: 'Note', status: 'resolved', impact: null, startedAt: yesterday, duration: '5h 0m', timeline: [] },
      { id: '3', title: 'Note', status: 'resolved', impact: null, startedAt: yesterday, duration: '5h 0m', timeline: [] },
      { id: '4', title: 'Bad', status: 'resolved', impact: 'major', startedAt: 'not-a-date', duration: '1h 0m', timeline: [] },
      { id: '5', title: 'Bad', status: 'resolved', impact: 'major', startedAt: 'not-a-date', duration: '1h 0m', timeline: [] },
    ])
    expect(result).toBeNull()
  })

  it('silently drops unknown-impact entries when valid entries exist (partial parse OK)', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const result = computeUptimeFromIncidents([
      { id: '1', title: 'Future impact', status: 'resolved', impact: 'maintenance' as never,
        startedAt: yesterday, duration: '5h 0m', timeline: [] },
      { id: '2', title: 'Valid', status: 'resolved', impact: 'major',
        startedAt: yesterday, duration: '5h 0m', timeline: [] },
    ])
    // Only the valid 5h major counts; unknown is dropped + warned (not return-null)
    const downMs = 5 * 3_600_000
    const expected = Math.floor((1 - downMs / (90 * 86_400_000)) * 10000) / 100
    expect(result).toBe(expected)
  })

  it('does not poison computed uptime when some entries are resolved-with-no-end (mixed feed)', () => {
    // incident.io occasionally marks status=resolved without a timeline resolved entry.
    // Such entries should be skipped (warn-only, not parse error) so a mixed feed still
    // computes weighted uptime from the usable entries.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const result = computeUptimeFromIncidents([
      { id: '1', title: 'No end', status: 'resolved', impact: 'major', startedAt: yesterday, duration: null, timeline: [] },
      { id: '2', title: 'Valid', status: 'resolved', impact: 'major', startedAt: yesterday, duration: '1h 0m', timeline: [] },
    ])
    // Only the valid 1h major counts (no-end is dropped without poisoning)
    const downMs = 1 * 3_600_000
    const expected = Math.floor((1 - downMs / (90 * 86_400_000)) * 10000) / 100
    expect(result).toBe(expected)
  })

  it('returns null when entire impactful feed is resolved-with-no-end (no honest 100 claim)', () => {
    // If every impactful entry is unusable (no recoverable end), the honest answer is
    // "we cannot measure uptime" → null. Claiming 100% would hide the data-quality issue.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const result = computeUptimeFromIncidents([
      { id: '1', title: 'No end', status: 'resolved', impact: 'major', startedAt: yesterday, duration: null, timeline: [] },
      { id: '2', title: 'No end', status: 'resolved', impact: 'minor', startedAt: yesterday, duration: null, timeline: [] },
    ])
    expect(result).toBeNull()
  })

  it('returns null for mixed parse-error + no-end + informational (all impactful unusable)', () => {
    // 2 informational + 1 bad-date + 1 no-end → impactful=2, totalSkips=2 → null
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const result = computeUptimeFromIncidents([
      { id: '1', title: 'Note', status: 'resolved', impact: null, startedAt: yesterday, duration: '5h 0m', timeline: [] },
      { id: '2', title: 'Note', status: 'resolved', impact: null, startedAt: yesterday, duration: '5h 0m', timeline: [] },
      { id: '3', title: 'Bad', status: 'resolved', impact: 'major', startedAt: 'not-a-date', duration: '1h 0m', timeline: [] },
      { id: '4', title: 'No end', status: 'resolved', impact: 'major', startedAt: yesterday, duration: null, timeline: [] },
    ])
    expect(result).toBeNull()
  })

  it('emits one warn listing all distinct unknown impact values (joined-message dedup)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString()
      const make = (id: string, impact: string) => ({
        id, title: '', status: 'resolved' as const,
        impact: impact as never, startedAt: yesterday, duration: '1h 0m', timeline: [],
      })
      computeUptimeFromIncidents([
        make('a1', 'maintenance'), make('a2', 'maintenance'),
        make('b1', 'planned'), make('b2', 'planned'),
        make('c1', 'severe'), make('c2', 'severe'),
      ])
      const unknownWarns = warnSpy.mock.calls.map(c => String(c[0])).filter(m => m.includes('unknown impact'))
      expect(unknownWarns).toHaveLength(1)
      expect(unknownWarns[0]).toMatch(/maintenance/)
      expect(unknownWarns[0]).toMatch(/planned/)
      expect(unknownWarns[0]).toMatch(/severe/)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('treats "0h 0m" duration with no timeline as no-end (incident.io same-minute resolve)', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const result = computeUptimeFromIncidents([
      { id: '1', title: 'Same-minute', status: 'resolved', impact: 'major',
        startedAt: yesterday, duration: '0h 0m', timeline: [] },
    ])
    // Single no-end impactful entry, no usable intervals → null
    expect(result).toBeNull()
  })

  it('does not throw when timeline is missing (defensive optional chaining)', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    // Force timeline=undefined despite type — simulates parser contract drift
    const incident = { id: '1', title: 'No timeline', status: 'resolved', impact: 'major',
      startedAt: yesterday, duration: '0h 0m' } as unknown as Incident
    let result: number | null = -1
    expect(() => { result = computeUptimeFromIncidents([incident]) }).not.toThrow()
    // Single impactful entry with no recoverable end → totalSkips=1, impactful=1 → null.
    // Don't add a second valid incident here — that would flip the result to a number;
    // split into a separate test instead.
    expect(result).toBeNull()
  })

  it('warns on each parse-error path so silent regressions stay visible', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString()
      computeUptimeFromIncidents([
        { id: '1', title: '', status: 'resolved', impact: 'maintenance' as never,
          startedAt: yesterday, duration: '1h 0m', timeline: [] },
        { id: '2', title: '', status: 'resolved', impact: 'major',
          startedAt: 'not-a-date', duration: '1h 0m', timeline: [] },
        { id: '3', title: '', status: 'resolved', impact: 'major',
          startedAt: new Date(Date.now() + 86_400_000).toISOString(), duration: '1h 0m', timeline: [] },
        { id: '4', title: '', status: 'resolved', impact: 'major',
          startedAt: yesterday, duration: null, timeline: [] },
      ])
      const messages = warnSpy.mock.calls.map(c => String(c[0]))
      expect(messages.some(m => m.includes('unknown impact'))).toBe(true)
      expect(messages.some(m => m.includes('invalid startedAt'))).toBe(true)
      expect(messages.some(m => m.includes('future-dated'))).toBe(true)
      expect(messages.some(m => m.includes('no recoverable end timestamp'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('includes the first encountered ID as a sample in the no-end summary warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    computeUptimeFromIncidents([
      { id: 'first', title: '', status: 'resolved', impact: 'major', startedAt: yesterday, duration: null, timeline: [] },
      { id: 'second', title: '', status: 'resolved', impact: 'major', startedAt: yesterday, duration: null, timeline: [] },
      { id: 'third', title: '', status: 'resolved', impact: 'major', startedAt: yesterday, duration: null, timeline: [] },
    ])
    const noEndWarn = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('no recoverable end timestamp'))
    expect(noEndWarn).toBeDefined()
    expect(noEndWarn!).toMatch(/first of 3: first/)
  })

  it('dedups unknown-impact warnings (1 log per call, not per incident)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString()
      const incidents = Array.from({ length: 50 }, (_, i) => ({
        id: `m${i}`, title: '', status: 'resolved' as const,
        impact: 'maintenance' as never,
        startedAt: yesterday, duration: '1h 0m', timeline: [],
      }))
      computeUptimeFromIncidents(incidents)
      const unknownWarns = warnSpy.mock.calls.filter(c => String(c[0]).includes('unknown impact'))
      // 50 incidents, 1 unique impact value → exactly 1 warn (Logpush spam guard)
      expect(unknownWarns).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
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

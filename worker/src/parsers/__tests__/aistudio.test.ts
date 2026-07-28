import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseAistudioIncidents,
  computeDailyImpactFromIncidents,
  synthesizeAistudioComponents,
  AISTUDIO_COMPONENT,
  AISTUDIO_ENDPOINT,
  AISTUDIO_HEADERS,
} from '../aistudio'
import type { Incident } from '../../types'

// Helper: build a minimal incident entry [id, title, severity, updates, category, components]
const entry = (
  id: string,
  title: string,
  severity: number,
  updates: Array<[number, string, string]>, // [updateType, displayTime, bodyText] → unix derived from index
  components: number[],
  baseTs = 1776000000,
) => [
  id,
  title,
  severity,
  updates.map(([t, display, body], i) => [t, display, [String(baseTs + i * 3600)], body]),
  components[0] ?? 1,
  components,
]

const wrap = (entries: unknown[]) => [[entries]]

describe('parseAistudioIncidents', () => {
  it('parses an active unresolved API incident (no resolved update)', () => {
    const data = wrap([entry('act1', 'API keys issue', 1, [[1, 'Apr 17', 'Detected issue']], [1])])
    const [inc] = parseAistudioIncidents(data)
    expect(inc.id).toBe('aistudio:act1')
    expect(inc.title).toBe('API keys issue')
    expect(inc.status).toBe('investigating')
    expect(inc.resolvedAt).toBeNull()
    expect(inc.duration).toBeNull()
    expect(inc.impact).toBe('minor') // severity 1
    expect(inc.timeline).toHaveLength(1)
    expect(inc.timeline[0].stage).toBe('investigating')
  })

  it('resolves when last update type is 4', () => {
    const data = wrap([
      entry('res1', 'Batch outage', 2, [
        [1, 'Apr 1 09:00', 'Detected'],
        [4, 'Apr 1 11:00', 'Resolved'],
      ], [1]),
    ])
    const [inc] = parseAistudioIncidents(data)
    expect(inc.status).toBe('resolved')
    expect(inc.impact).toBe('major') // severity 2
    expect(inc.resolvedAt).not.toBeNull()
    expect(inc.duration).toBe('1h 0m') // updates are 3600s apart in the test helper
    expect(inc.timeline).toHaveLength(2)
  })

  it('maps updateType 5 (mitigation in progress) → monitoring', () => {
    const data = wrap([
      entry('mit1', 'Spend cap issue', 1, [
        [1, 't1', 'Detected'],
        [5, 't2', 'Mitigations underway'],
      ], [3]),
    ])
    const [inc] = parseAistudioIncidents(data)
    expect(inc.status).toBe('monitoring')
    expect(inc.timeline[1].stage).toBe('monitoring')
  })

  it('preserves previous stage for unknown updateType (never auto-resolves)', () => {
    const data = wrap([
      entry('unk1', 'Weird', 1, [
        [1, 't1', 'Detected'],
        [99, 't2', 'Unknown update type'],
      ], [1]),
    ])
    const [inc] = parseAistudioIncidents(data)
    // 99 is unknown → inherits 'investigating' from prior update
    expect(inc.status).toBe('investigating')
    expect(inc.timeline[1].stage).toBe('investigating')
  })

  it('filters by componentFilter — drops incidents without component overlap', () => {
    const data = wrap([
      entry('api1', 'API issue', 1, [[1, 't', 'x']], [AISTUDIO_COMPONENT.API]),
      entry('ui1', 'UI only issue', 1, [[1, 't', 'x']], [AISTUDIO_COMPONENT.AI_STUDIO]),
      entry('mixed', 'API + UI', 1, [[1, 't', 'x']], [AISTUDIO_COMPONENT.API, AISTUDIO_COMPONENT.AI_STUDIO]),
    ])
    const result = parseAistudioIncidents(data, { componentFilter: [AISTUDIO_COMPONENT.API] })
    expect(result.map((i) => i.id.replace('aistudio:', ''))).toEqual(['api1', 'mixed'])
  })

  it('#1012 — attaches stringified componentIds to a parsed incident', () => {
    const data = wrap([entry('api1', 'API issue', 1, [[1, 't', 'x']], [AISTUDIO_COMPONENT.API, AISTUDIO_COMPONENT.MULTIMODAL_LIVE])])
    const [inc] = parseAistudioIncidents(data)
    expect(inc.componentIds).toEqual(['1', '2'])
  })

  it('#1012 — omits componentIds (never an empty array) when the entry has no components and no filter is set', () => {
    const data = wrap([entry('nocomp', 'T', 1, [[1, 't', 'x']], [] as number[])])
    const [inc] = parseAistudioIncidents(data)
    expect(inc.componentIds).toBeUndefined()
  })

  it('returns empty array for empty wrapping', () => {
    expect(parseAistudioIncidents([[[]]])).toEqual([])
    expect(parseAistudioIncidents([[]])).toEqual([])
    expect(parseAistudioIncidents([])).toEqual([])
    expect(parseAistudioIncidents(null)).toEqual([])
  })

  it('applies custom idPrefix', () => {
    const data = wrap([entry('x', 'T', 1, [[1, 't', 'x']], [1])])
    const [inc] = parseAistudioIncidents(data, { idPrefix: 'custom:' })
    expect(inc.id).toBe('custom:x')
  })

  it('handles real fixture and surfaces currently active API incident', () => {
    const fixturePath = resolve(__dirname, 'fixtures/aistudio-sample.json')
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))

    // Without filter: all incidents parsed
    const all = parseAistudioIncidents(fixture)
    expect(all.length).toBeGreaterThan(20)

    // API-only filter: must include the active "new keys" incident
    const apiOnly = parseAistudioIncidents(fixture, { componentFilter: [AISTUDIO_COMPONENT.API] })
    const active = apiOnly.filter((i) => i.status !== 'resolved')
    const newKeys = active.find((i) => i.id === 'aistudio:GeminiAPI-new-keys-20260417')
    expect(newKeys).toBeDefined()
    expect(newKeys?.title).toContain('keys')
    expect(newKeys?.impact).toBe('minor')

    // AI Studio UI-only incidents must NOT appear in API filter
    const studioModelErrors = apiOnly.find(
      (i) => i.id === 'aistudio:AIStudio-model-errors-20260417',
    )
    expect(studioModelErrors).toBeUndefined()
  })

  it('exports endpoint constants used by services.ts', () => {
    expect(AISTUDIO_ENDPOINT).toContain('ListIncidentsHistory')
    // Referer is the 403-causing header — critical to gate.
    expect(AISTUDIO_HEADERS.Referer).toBe('https://aistudio.google.com/')
  })

  it('warns and excludes incidents with empty components when a filter is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const data = wrap([entry('empty-comp', 'T', 1, [[1, 't', 'x']], [] as number[])])
    const result = parseAistudioIncidents(data, {
      componentFilter: [AISTUDIO_COMPONENT.API],
    })
    expect(result).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('empty components'),
    )
    warn.mockRestore()
  })

  it('skips timestamps outside the plausible unix-seconds range', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A millisecond-unit timestamp (common drift pattern) falls outside the range.
    const badMs = String(1_776_000_000_000)
    const data = [[[
      ['drift', 'Title', 1, [[1, 't', [badMs], 'body']], 1, [1]],
    ]]]
    const [inc] = parseAistudioIncidents(data)
    expect(inc).toBeUndefined() // no valid timeline → entry dropped
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('out of plausible range'))
    warn.mockRestore()
  })

  it('warns when unwrap exhausts MAX_UNWRAP_DEPTH on a non-empty response', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = parseAistudioIncidents([[[[[['too-deep']]]]]])
    expect(result).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unwrap exhausted'))
    warn.mockRestore()
  })

  it('drops bad entries without killing the batch (entry-level catch logs)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const good = entry('good', 'Good', 1, [[1, 't', 'ok']], [1])
    // Malformed entry: updates[0] is not an array → sort/flatMap throws
    const bad = ['bad', 'Bad', 1, 'not-an-array', 1, [1]] as unknown as (typeof good)
    const data = wrap([bad, good])
    const result = parseAistudioIncidents(data)
    expect(result.map((i) => i.id)).toEqual(['aistudio:good'])
  })

  describe('computeDailyImpactFromIncidents', () => {
    const mkInc = (over: Partial<Incident>): Incident => ({
      id: 'x',
      title: 't',
      status: 'resolved',
      impact: 'minor',
      startedAt: '2026-04-20T10:00:00.000Z',
      resolvedAt: '2026-04-20T14:00:00.000Z',
      duration: '4h',
      timeline: [],
      ...over,
    })
    const now = new Date('2026-04-22T12:00:00.000Z')

    it('marks every UTC day the incident spans', () => {
      const out = computeDailyImpactFromIncidents(
        [mkInc({ startedAt: '2026-04-19T22:00:00Z', resolvedAt: '2026-04-21T02:00:00Z', impact: 'major' })],
        30,
        now,
      )
      expect(Object.keys(out).sort()).toEqual(['2026-04-19', '2026-04-20', '2026-04-21'])
      expect(out['2026-04-20']).toBe('major')
    })

    it('escalates to the worst impact when multiple incidents overlap one day', () => {
      const incs = [
        mkInc({ id: 'a', startedAt: '2026-04-20T10:00Z', resolvedAt: '2026-04-20T11:00Z', impact: 'minor' }),
        mkInc({ id: 'b', startedAt: '2026-04-20T14:00Z', resolvedAt: '2026-04-20T15:00Z', impact: 'major' }),
      ]
      const out = computeDailyImpactFromIncidents(incs, 30, now)
      expect(out['2026-04-20']).toBe('major') // worst of minor+major
    })

    it('drops flaps shorter than 10 minutes', () => {
      const out = computeDailyImpactFromIncidents(
        [mkInc({ startedAt: '2026-04-20T10:00:00Z', resolvedAt: '2026-04-20T10:05:00Z' })],
        30,
        now,
      )
      expect(out).toEqual({})
    })

    it('skips incidents with null impact (informational)', () => {
      const out = computeDailyImpactFromIncidents(
        [mkInc({ impact: null })],
        30,
        now,
      )
      expect(out).toEqual({})
    })

    it('treats unresolved incidents as spanning up to now', () => {
      const out = computeDailyImpactFromIncidents(
        [mkInc({ startedAt: '2026-04-21T10:00Z', resolvedAt: null, status: 'investigating' })],
        30,
        now,
      )
      expect(out['2026-04-21']).toBe('minor')
      expect(out['2026-04-22']).toBe('minor')
    })

    it('clamps incidents older than calendarDays to the window', () => {
      // calendarDays=5 → window starts 2026-04-18
      const out = computeDailyImpactFromIncidents(
        [mkInc({ startedAt: '2026-03-01T10:00Z', resolvedAt: '2026-04-19T10:00Z', impact: 'major' })],
        5,
        now,
      )
      expect(Object.keys(out).sort()).toEqual(['2026-04-18', '2026-04-19'])
    })

    it('returns empty record for empty input', () => {
      expect(computeDailyImpactFromIncidents([], 30, now)).toEqual({})
    })
  })

  describe('#1012 synthesizeAistudioComponents', () => {
    const mkInc = (over: Partial<Incident>): Incident => ({
      id: 'aistudio:x',
      title: 't',
      status: 'investigating',
      impact: 'minor',
      startedAt: '2026-04-20T10:00:00.000Z',
      resolvedAt: null,
      duration: null,
      timeline: [],
      ...over,
    })

    it('both components operational when there are no incidents', () => {
      const out = synthesizeAistudioComponents([])
      expect(out).toEqual([
        { id: 'aistudio-api', name: 'API', status: 'operational' },
        { id: 'aistudio-multimodal-live', name: 'Multimodal Live API', status: 'operational' },
      ])
    })

    it('an active API-only incident degrades API but leaves Multimodal Live operational', () => {
      const out = synthesizeAistudioComponents([mkInc({ componentIds: ['1'], impact: 'minor' })])
      expect(out.find((c) => c.id === 'aistudio-api')?.status).toBe('degraded')
      expect(out.find((c) => c.id === 'aistudio-multimodal-live')?.status).toBe('operational')
    })

    it('a major active Multimodal Live incident marks it down (worst-of, not just degraded)', () => {
      // aistudio's mapImpact caps at 'major' (severity 2) — there is no 'critical' tier here,
      // unlike most other sources. 'major' is the top severity that escalates to 'down'.
      const out = synthesizeAistudioComponents([mkInc({ componentIds: ['2'], impact: 'major' })])
      expect(out.find((c) => c.id === 'aistudio-multimodal-live')?.status).toBe('down')
    })

    it('a RESOLVED incident does not affect component status', () => {
      const out = synthesizeAistudioComponents([
        mkInc({ componentIds: ['1', '2'], status: 'resolved', impact: 'major' }),
      ])
      expect(out.every((c) => c.status === 'operational')).toBe(true)
    })

    it('an AI-Studio-only incident (component 3) affects neither breakdown row', () => {
      const out = synthesizeAistudioComponents([mkInc({ componentIds: ['3'], impact: 'major' })])
      expect(out.every((c) => c.status === 'operational')).toBe(true)
    })

    it('a non-aistudio incident (no componentIds, e.g. merged vertex) affects neither row', () => {
      const out = synthesizeAistudioComponents([mkInc({ componentIds: undefined, impact: 'major' })])
      expect(out.every((c) => c.status === 'operational')).toBe(true)
    })

    it('worst-of across multiple active incidents on the same component', () => {
      const out = synthesizeAistudioComponents([
        mkInc({ id: 'a', componentIds: ['1'], impact: 'minor' }),
        mkInc({ id: 'b', componentIds: ['1'], impact: 'major' }),
      ])
      expect(out.find((c) => c.id === 'aistudio-api')?.status).toBe('down')
    })

    it('an active incident with impact:null (unclassifiable severity) still degrades the component', () => {
      // Mirrors deriveAwsStatus (parsers/aws.ts) exactly: "active" is decided by status alone, not
      // impact — an unrecognized severity enum (mapImpact's null case) is still a real active incident,
      // not silently invisible. Only the escalation to 'down' needs a known top-severity impact.
      const out = synthesizeAistudioComponents([mkInc({ componentIds: ['1'], impact: null })])
      expect(out.find((c) => c.id === 'aistudio-api')?.status).toBe('degraded')
    })

    it('Multimodal Live still counts when AI Studio is ALSO tagged on the same incident ([2,3])', () => {
      const out = synthesizeAistudioComponents([mkInc({ componentIds: ['2', '3'], impact: 'minor' })])
      expect(out.find((c) => c.id === 'aistudio-multimodal-live')?.status).toBe('degraded')
      expect(out.find((c) => c.id === 'aistudio-api')?.status).toBe('operational')
    })
  })

  it('fixture matches the expected proto shape (drift guard)', () => {
    const fixturePath = resolve(__dirname, 'fixtures/aistudio-sample.json')
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
    // Outer wrapping: [[[ entries ]]]
    expect(Array.isArray(fixture)).toBe(true)
    expect(Array.isArray(fixture[0])).toBe(true)
    expect(Array.isArray(fixture[0][0])).toBe(true)
    const first = fixture[0][0][0]
    // Entry shape: [id, title, severity, updates, category, components]
    expect(typeof first[0]).toBe('string')
    expect(typeof first[1]).toBe('string')
    expect(typeof first[2]).toBe('number')
    expect(Array.isArray(first[3])).toBe(true)
    expect(first[3][0].length).toBeGreaterThanOrEqual(4)
    expect(Array.isArray(first[3][0][2])).toBe(true)
    expect(Array.isArray(first[5])).toBe(true)
  })
})

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { fetchService, mergeRetainedIncidentHistory, SERVICES } from '../services'
import { calculateAIWatchScore } from '../score'
import { accumulateMonthlyIncidents, type MonthlyIncidentEntry } from '../monthly-archive'
import { incidentDay, incidentDays, normalizeIncidentTimes, toUtcIso } from '../utils'

// #1602 — kimi publishes `+08:00` and twelvelabs `-07:00`/`-08:00` timestamps. Downstream code reads
// `startedAt` as text (`slice(0, 10)` for the day, `>=` against a `Z` cutoff for the window), so an
// offset string was bucketed by the provider-local date and windowed by its wall-clock digits.

describe('toUtcIso (#1602)', () => {
  it('rewrites an offset timestamp as the same instant in Z form', () => {
    expect(toUtcIso('2026-10-03T06:26:12.555+08:00')).toBe('2026-10-02T22:26:12.555Z')
    expect(toUtcIso('2026-09-24T17:30:00.000-07:00')).toBe('2026-09-25T00:30:00.000Z')
    expect(toUtcIso('2026-09-24T17:30:00-0700')).toBe('2026-09-25T00:30:00.000Z')
    expect(toUtcIso('2026-10-01T00:00:00+00:00')).toBe('2026-10-01T00:00:00.000Z')
  })

  it('leaves Z timestamps, date-only values and garbage byte-identical', () => {
    for (const v of ['2026-10-03T06:26:12Z', '2026-10-03T06:26:12.555Z', '2026-10-03', 'pending', '', '2026-13-45T00:00:00+08:00']) {
      expect(toUtcIso(v)).toBe(v)
    }
  })
})

describe('normalizeIncidentTimes (#1602)', () => {
  it('returns the same array when every timestamp is already Z', () => {
    const input = [{ startedAt: '2026-10-01T00:00:00.000Z', resolvedAt: null }]
    expect(normalizeIncidentTimes(input)).toBe(input)
  })

  it('an offset start with a Z end covers one UTC day, not two', () => {
    const [inc] = normalizeIncidentTimes([
      { startedAt: '2026-09-24T17:30:00.000-07:00', resolvedAt: '2026-09-25T01:00:00.000Z' },
    ])
    expect(incidentDays(inc, '2026-10-05')).toEqual(['2026-09-25'])
  })
})

describe('fetchService normalizes Statuspage offset timestamps (#1602)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const fetchWith = (id: string, componentId: string, incidents: Array<{ id: string; started: string; resolved: string }>) => {
    const config = SERVICES.find((s) => s.id === id)!
    const component = { id: componentId, name: 'API', status: 'operational' }
    const summary = {
      status: { indicator: 'none', description: 'All Systems Operational' },
      components: [component],
      incidents: incidents.map(({ id: incId, started, resolved }) => ({
        id: incId,
        name: 'Elevated error rate',
        status: 'resolved',
        impact: 'major',
        created_at: started,
        started_at: started,
        resolved_at: resolved,
        updated_at: resolved,
        incident_updates: [{ status: 'resolved', body: 'Resolved.', created_at: resolved }],
        components: [component],
      })),
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    return fetchService(config, { summary: summary as never, incidents: null, latency: 120 }, undefined, {})
  }

  it('files a +08:00 incident under its UTC day', async () => {
    const svc = await fetchWith('kimi', '8psr5dfdld0s', [
      { id: 'k-midnight', started: '2026-10-03T06:26:12.555+08:00', resolved: '2026-10-03T07:01:00.000+08:00' },
    ])
    const inc = svc.incidents.find((i) => i.id === 'k-midnight')!
    expect(inc.startedAt).toBe('2026-10-02T22:26:12.555Z')
    expect(inc.resolvedAt).toBe('2026-10-02T23:01:00.000Z')
    expect(incidentDay(inc)).toBe('2026-10-02')
  })

  // Cutoff for "now" above: 2026-09-05T12:00:00.000Z.
  it('windows a +08:00 incident by its instant: 18:00+08:00 on the cutoff day is 10:00Z, outside', async () => {
    const svc = await fetchWith('kimi', '8psr5dfdld0s', [
      { id: 'k-edge', started: '2026-09-05T18:00:00.000+08:00', resolved: '2026-09-05T19:00:00.000+08:00' },
      { id: 'k-inside', started: '2026-09-20T18:00:00.000+08:00', resolved: '2026-09-20T19:00:00.000+08:00' },
    ])
    const score = calculateAIWatchScore(svc, 30, { kind: 'unsupported' })
    expect(score.metrics.incidents30d).toBe(1)
  })

  it('windows a -07:00 incident by its instant: 08:00-07:00 on the cutoff day is 15:00Z, inside', async () => {
    const svc = await fetchWith('twelvelabs', 'mvv53x91b74m', [
      { id: 't-edge', started: '2026-09-05T08:00:00.000-07:00', resolved: '2026-09-05T09:00:00.000-07:00' },
    ])
    const score = calculateAIWatchScore(svc, 30, { kind: 'unsupported' })
    expect(score.metrics.incidents30d).toBe(1)
  })
})

describe('stored rows with offset timestamps (#1602)', () => {
  const entry = (startedAt: string, resolvedAt: string): MonthlyIncidentEntry => ({
    id: 'stored-1',
    title: 'Elevated error rate',
    startedAt,
    resolvedAt,
    durationMin: 60,
    finalStatus: 'resolved',
    impact: 'major',
  })

  it('mergeRetainedIncidentHistory forwards a stored offset row in Z form and windows it by its instant', () => {
    const cutoff = '2026-09-05T12:00:00.000Z'
    const inside = mergeRetainedIncidentHistory([], [entry('2026-09-20T18:00:00.000+08:00', '2026-09-20T19:00:00.000+08:00')], cutoff)
    expect(inside.map((i) => [i.startedAt, i.resolvedAt])).toEqual([['2026-09-20T10:00:00.000Z', '2026-09-20T11:00:00.000Z']])
    const edge = mergeRetainedIncidentHistory([], [entry('2026-09-05T18:00:00.000+08:00', '2026-09-05T19:00:00.000+08:00')], cutoff)
    expect(edge).toEqual([])
  })

  it('accumulateMonthlyIncidents rewrites the in-progress month\'s stored offset rows in Z form', () => {
    const existing = {
      lastUpdated: '2026-10-04T00:00:00.000Z',
      services: {
        kimi: {
          count: 1, totalMinutes: 60, longestMinutes: 60, dates: ['2026-10-03'], incidentIds: ['stored-1'],
          durations: { 'stored-1': 60 },
          incidents: [entry('2026-10-03T18:00:00.000+08:00', '2026-10-03T19:00:00.000+08:00')],
        },
      },
    }
    const out = accumulateMonthlyIncidents(existing, [], '2026-10', [])
    expect(out.services.kimi.incidents![0].startedAt).toBe('2026-10-03T10:00:00.000Z')
    expect(out.services.kimi.incidents![0].resolvedAt).toBe('2026-10-03T11:00:00.000Z')
  })
})

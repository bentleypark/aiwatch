// #1614 — a capped upstream feed (incidents.json = the last N rows page-wide) stops short of 30 days;
// AIWatch's own record fills the gap for the Score, without touching the live `incidents` array.
import { describe, it, expect, vi } from 'vitest'
import { incidentsBeyondFeedDepth, attachRecordedIncidentHistory, downclassifyAdvisoryIncidents, cappedFeedDepthStart } from '../services'
import { applySuppressions } from '../suppression'
import { scoreFor } from '../index'
import { fetchService, fetchAllServices, SERVICES } from '../services'
import { invalidateSuppressionCache, SUPPRESSIONS_KEY } from '../suppression'
import { mockKV, TEST_TIMEOUT_MS } from './helpers/unreadable-source'
import type { MonthlyIncidentEntry } from '../monthly-archive'
import type { Incident, ServiceStatus } from '../types'

const NOW = new Date('2026-10-05T12:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const CUTOFF = daysAgo(30)

const live = (id: string, ago: number): Incident => ({
  id, title: `live ${id}`, status: 'resolved', impact: 'minor', startedAt: daysAgo(ago),
  resolvedAt: daysAgo(ago - 0.05), duration: '1h 12m', timeline: [],
})
const rec = (id: string, ago: number, over: Partial<MonthlyIncidentEntry> = {}): MonthlyIncidentEntry => ({
  id, title: `recorded ${id}`, startedAt: daysAgo(ago), resolvedAt: daysAgo(ago - 0.05),
  durationMin: 72, finalStatus: 'resolved', impact: 'major', ...over,
})
const svc = (incidents: Incident[], over: Partial<ServiceStatus> = {}): ServiceStatus => ({
  id: 'chatgpt', name: 'ChatGPT', provider: 'OpenAI', category: 'app', status: 'operational',
  latency: null, uptime30d: 99.9, lastChecked: NOW.toISOString(), incidents, ...over,
})

describe('cappedFeedDepthStart', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, k) => ({ created_at: daysAgo(k) }))
  it('is the oldest page-wide row when the feed is at its cap', () => {
    expect(cappedFeedDepthStart(rows(25))).toBe(daysAgo(24))
  })
  it('ignores a row with no usable created_at instead of failing the fetch', () => {
    expect(cappedFeedDepthStart([...rows(25), {}, { created_at: 'garbage' }])).toBe(daysAgo(24))
  })

  it('is undefined below the smallest known cap: the feed returned everything it has', () => {
    expect(cappedFeedDepthStart(rows(24))).toBeUndefined()
  })
})

describe('incidentsBeyondFeedDepth', () => {
  it('returns only resolved records older than the page-wide feed depth and inside the window', () => {
    const recorded = [
      rec('inside-feed-span', 10),                       // the feed covers day 10 even if this service has no row there
      rec('gap-1', 22), rec('gap-2', 28),                // past the feed's depth: kept
      rec('open', 25, { resolvedAt: null, finalStatus: 'investigating' }), // unresolved: dropped
      rec('too-old', 31),                                // outside 30 days
    ]
    expect(incidentsBeyondFeedDepth(daysAgo(21), [], recorded, CUTOFF).map((i) => i.id)).toEqual(['gap-1', 'gap-2'])
  })

  it('a quiet service on a shared page gets nothing the page-wide feed still covers', () => {
    // codex on status.openai.com, 2026-10-05: its own oldest row was 9 days old, the page's 21.
    expect(incidentsBeyondFeedDepth(daysAgo(21), [], [rec('covered', 12)], CUTOFF)).toEqual([])
  })

  it('deduplicates an incident carried by both the archive and the accumulator', () => {
    expect(incidentsBeyondFeedDepth(daysAgo(21), [], [rec('x', 25), rec('x', 25)], CUTOFF)).toHaveLength(1)
  })

  it('never repeats a row that is still live, even when its start sits before the feed depth', () => {
    // incident.io time repair can move a live row's startedAt earlier than its own created_at,
    // which is what the depth is read from.
    const repaired = live('oldest', 22)
    expect(incidentsBeyondFeedDepth(daysAgo(21), [repaired], [rec('oldest', 22)], CUTOFF)).toEqual([])
  })

  it('adds nothing without evidence that the feed is capped', () => {
    expect(incidentsBeyondFeedDepth(undefined, [], [rec('x', 25)], CUTOFF)).toEqual([])
  })
})

describe('attachRecordedIncidentHistory', () => {
  const kvWith = (prev: Record<string, MonthlyIncidentEntry[]>, cur: Record<string, MonthlyIncidentEntry[]>) => ({
    get: vi.fn(async (key: string) => {
      if (key === 'archive:monthly:2026-09') return JSON.stringify({ period: '2026-09', services: Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { incidentList: v }])) })
      if (key === 'incidents:monthly:2026-10') return JSON.stringify({ lastUpdated: NOW.toISOString(), services: Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, { incidents: v }])) })
      return null
    }),
  }) as unknown as KVNamespace

  it('attaches the gap as incidentsBeyondFeed and leaves the live incidents array untouched', async () => {
    const liveRows = [live('a', 1), live('b', 20)]
    const services = [svc(liveRows, { feedDepthStart: daysAgo(21) })]
    await attachRecordedIncidentHistory(services, kvWith({ chatgpt: [rec('sep-25', 10 + 15), rec('sep-23', 27)] }, { chatgpt: [rec('b', 20)] }), NOW)
    expect(services[0].incidents).toBe(liveRows)
    expect(services[0].incidentsBeyondFeed?.map((i) => i.id)).toEqual(['sep-25', 'sep-23'])
    expect(services[0].incidentsBeyondFeed?.every((i) => !i.retainedBridge)).toBe(true)
  })

  it("keeps the previous month across a rollover, before that month's archive is built", async () => {
    const rollover = new Date('2026-10-01T00:05:00.000Z')
    const kv = { get: vi.fn(async (key: string) => key === 'incidents:monthly:2026-09'
      ? JSON.stringify({ lastUpdated: rollover.toISOString(), services: { chatgpt: { incidents: [rec('sep-25', 10)] } } })
      : null) } as unknown as KVNamespace
    const services = [svc([live('a', 1)], { feedDepthStart: daysAgo(5) })]
    await attachRecordedIncidentHistory(services, kv, rollover)
    expect(services[0].incidentsBeyondFeed?.map((i) => i.id)).toEqual(['sep-25'])
  })

  it('leaves a service whose feed is not capped without the field', async () => {
    const services = [svc([live('a', 1)])]
    await attachRecordedIncidentHistory(services, kvWith({ chatgpt: [rec('sep-23', 27)] }, {}), NOW)
    expect(services[0].incidentsBeyondFeed).toBeUndefined()
  })
})

describe('the operator layers reach incidentsBeyondFeed too', () => {
  it('a suppressed record leaves the scoring input', () => {
    const s = svc([live('a', 1)], { incidentsBeyondFeed: [live('keep', 25), live('drop', 26)] })
    const [out] = applySuppressions([s], [{ scope: 'incident', incId: 'drop' }])
    expect(out.incidentsBeyondFeed?.map((i) => i.id)).toEqual(['keep'])
  })

  it('an advisory record is downclassified to null impact', () => {
    const advisory = { ...live('adv', 25), title: 'Scheduled maintenance window' }
    const [out] = downclassifyAdvisoryIncidents([svc([live('a', 1)], { incidentsBeyondFeed: [advisory, live('real', 26)] })])
    expect(out.incidentsBeyondFeed?.map((i) => i.impact)).toEqual([null, 'minor'])
  })
})

describe('scoreFor consumes the full 30-day window', () => {
  it('counts the rows past the feed depth, and the Score drops for them', () => {
    vi.useFakeTimers({ now: NOW })
    try {
      const base = svc([live('a', 1), live('b', 20)])
      const withGap = { ...base, incidentsBeyondFeed: [live('gap-1', 22), live('gap-2', 26)] }
      const before = scoreFor(base, undefined)
      const after = scoreFor(withGap, undefined)
      expect(before.metrics.incidents30d).toBe(2)
      expect(after.metrics.incidents30d).toBe(4)
      expect(after.breakdown.incidents).toBeLessThan(before.breakdown.incidents)
      expect(withGap.incidents.map((i) => i.id)).toEqual(['a', 'b'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('fetchService publishes the capped feed depth', () => {
  const windsurf = SERVICES.find((c) => c.id === 'windsurf')!
  // A shared page: only the newest row is windsurf's (Desktop Agent); the rest belong to another product.
  const component = (id: string, name: string) => ({ id, name, status: 'operational', position: 1, group_id: null, group: false, only_show_if_degraded: false, showcase: true, description: null, page_id: 'p', created_at: daysAgo(400), updated_at: daysAgo(1), start_date: null })
  const rows = (n: number) => Array.from({ length: n }, (_, k) => ({
    id: `inc-${k}`, name: `Elevated errors ${k}`, status: 'resolved', impact: 'minor',
    created_at: daysAgo(k + 1), updated_at: daysAgo(k + 1), started_at: daysAgo(k + 1),
    resolved_at: daysAgo(k + 0.9), monitoring_at: null, shortlink: '', page_id: 'p', incident_updates: [],
    components: k === 0 ? [component('h6z52njyz22z', 'Desktop Agent')] : [component('other0product', 'Other product')],
  }))
  const fetchWith = (n: number) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    return fetchService(windsurf, {
      summary: { status: { indicator: 'none', description: 'All Systems Operational' }, components: [], incidents: [] } as never,
      incidents: { incidents: rows(n) } as never,
    } as never, undefined, {})
  }

  it('sets feedDepthStart to the oldest page-wide row of a capped incidents.json, not the service\'s own', async () => {
    try {
      const svc = await fetchWith(25)
      expect(svc.incidents.map((i) => i.id)).toEqual(['inc-0'])
      expect(svc.feedDepthStart).toBe(daysAgo(25))
    } finally { vi.unstubAllGlobals(); vi.restoreAllMocks() }
  })

  it('omits it when the feed returned fewer rows than any known cap', async () => {
    try {
      expect((await fetchWith(10)).feedDepthStart).toBeUndefined()
    } finally { vi.unstubAllGlobals(); vi.restoreAllMocks() }
  })
})

describe('fetchAllServices runs the record fill, before the operator layers', () => {
  it('a capped Statuspage feed gets its older records as incidentsBeyondFeed, minus a suppressed one', async () => {
    const now = new Date()
    const ago = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString()
    const rows = Array.from({ length: 25 }, (_, k) => ({
      id: `cur-${k}`, name: `Elevated errors ${k}`, status: 'resolved', impact: 'minor',
      created_at: ago(k + 1), updated_at: ago(k + 1), started_at: ago(k + 1), resolved_at: ago(k + 0.9),
      monitoring_at: null, shortlink: '', page_id: 'p', incident_updates: [], components: [],
    }))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u === 'https://status.cursor.com/api/v2/summary.json') return new Response(JSON.stringify({
        page: { id: 'p', name: 'Cursor', updated_at: now.toISOString() },
        status: { indicator: 'none', description: 'All Systems Operational' }, components: [], incidents: [],
      }), { status: 200 })
      if (u === 'https://status.cursor.com/api/v2/incidents.json') return new Response(JSON.stringify({ incidents: rows }), { status: 200 })
      return new Response('unavailable', { status: 503 })
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    invalidateSuppressionCache()
    const month = now.toISOString().slice(0, 7)
    const entry = (id: string, n: number) => ({ id, title: `recorded ${id}`, startedAt: ago(n), resolvedAt: ago(n - 0.05), durationMin: 72, finalStatus: 'resolved', impact: 'major' })
    const kv = mockKV({
      [`incidents:monthly:${month}`]: JSON.stringify({ lastUpdated: now.toISOString(), services: { cursor: { incidents: [entry('older', 27), entry('suppressed', 28)] } } }),
      [SUPPRESSIONS_KEY]: JSON.stringify([{ scope: 'incident', incId: 'suppressed' }]),
    })
    try {
      const { raw } = await fetchAllServices(kv as never, [])
      const cursor = raw.find((s) => s.id === 'cursor')!
      expect(cursor.feedDepthStart).toBe(ago(25))
      expect(cursor.incidentsBeyondFeed?.map((i) => i.id)).toEqual(['older'])
      expect(cursor.incidents.some((i) => i.id === 'older')).toBe(false)
    } finally {
      vi.unstubAllGlobals(); vi.restoreAllMocks(); invalidateSuppressionCache()
    }
  }, TEST_TIMEOUT_MS)
})

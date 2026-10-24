import { describe, it, expect, vi } from 'vitest'
import { isResolvedWithoutEnd } from '../utils'
import { calculateAIWatchScore } from '../score'
import { accumulateMonthlyIncidents, aggregateIncidentDurations, computeMonthlyScore, type MonthlyIncidentEntry, type MonthlyArchive } from '../monthly-archive'
import { selectIncidentCandidates } from '../monthly-narrative'
import { markIncidentResolved } from '../recovery-mark'
import { buildHistoryRecord } from '../incident-history'
import { buildFeedWithMeta, buildRssFeed, resolvedSeenKey, type RssAiAnalysisMap } from '../rss'
import workerModule from '../index'
import { CACHE_KEY } from '../services'
import type { Incident, ServiceStatus } from '../types'

// #1510 Part E — a resolved incident whose end was never recorded. Its duration is unknown, and no
// consumer may read it as a 0-minute recovery or stamp an end of its own.

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
const inc = (o: Partial<Incident> = {}): Incident => ({
  id: 'i1', title: 'Elevated error rates', status: 'resolved', impact: 'minor',
  startedAt: daysAgo(3), resolvedAt: null, duration: null, timeline: [], ...o,
})
const measured = () => inc({ id: 'm1', startedAt: daysAgo(4), resolvedAt: new Date(Date.parse(daysAgo(4)) + 3_600_000).toISOString(), duration: '1h 0m' })

describe('isResolvedWithoutEnd', () => {
  it.each([
    [{ status: 'resolved', resolvedAt: null }, true],
    [{ status: 'resolved', resolvedAt: undefined }, true],
    [{ status: 'resolved', resolvedAt: 'not a date' }, true],
    [{ status: 'resolved', resolvedAt: '2026-10-23T12:00:00Z' }, false],
    [{ status: 'monitoring', resolvedAt: null }, false],
    [{ status: 'resolved', resolvedAt: null, duration: '42m' }, false],
    [{ status: 'resolved', resolvedAt: null, timeline: [{ stage: 'resolved' }] }, false],
  ])('%j → %s', (i, expected) => {
    expect(isResolvedWithoutEnd(i)).toBe(expected)
  })
})

describe('the live Score: Recovery abstains instead of scoring 0', () => {
  const recoveryOf = (incidents: Incident[]) => calculateAIWatchScore({
    id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', category: 'api',
    status: 'operational', latency: null, uptime30d: null, lastChecked: new Date().toISOString(), incidents,
  } as never, 30, { kind: 'unsupported' } as const).breakdown.recovery

  it('abstains at full marks when the window holds only such an incident', () => {
    expect(recoveryOf([inc()])).toBe(15)
  })

  it('does not drag a measured recovery in the same window', () => {
    expect(recoveryOf([inc(), measured()])).toBe(recoveryOf([measured()]))
    expect(recoveryOf([measured()])).toBeLessThan(15)
  })
})

const entry = (o: Partial<MonthlyIncidentEntry> = {}): MonthlyIncidentEntry => ({
  id: 'e1', title: 'Elevated error rates', startedAt: '2026-10-23T09:21:52.000Z', resolvedAt: null,
  durationMin: 0, finalStatus: 'resolved', impact: 'minor', ...o,
})
const measuredEntry = () => entry({ id: 'e2', startedAt: '2026-10-20T10:00:00.000Z', resolvedAt: '2026-10-20T11:00:00.000Z', durationMin: 60 })

describe('the monthly archive', () => {
  it('leaves it out of the counted recoveries, so the average is the measured one', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = aggregateIncidentDurations([entry(), measuredEntry()], 2, 60, 60)
    expect(r.countedCount).toBe(1)
    expect(r.countedTotalMin).toBe(60)
  })

  it('a later "no end" value does not replace an end the row already holds', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const card = (i: Incident) => [{ id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', category: 'api', status: 'unknown', latency: null, uptime30d: null, lastChecked: '2026-10-23T14:00:00.000Z', incidents: [i] }] as never
    const fromFeed = inc({ startedAt: '2026-10-23T09:00:00.000Z', resolvedAt: '2026-10-23T11:00:00.000Z', duration: '2h 0m' })
    let acc = accumulateMonthlyIncidents(null, card(fromFeed), '2026-10', null)
    acc = accumulateMonthlyIncidents(acc, card(inc({ startedAt: '2026-10-23T09:00:00.000Z' })), '2026-10', null)
    expect(acc.services.mistral.incidents![0]).toMatchObject({ finalStatus: 'resolved', resolvedAt: '2026-10-23T11:00:00.000Z', durationMin: 120 })
    expect(acc.services.mistral.totalMinutes).toBe(120)
  })

  it('control: an open row still becomes resolved with no end', () => {
    const card = (i: Incident) => [{ id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', category: 'api', status: 'unknown', latency: null, uptime30d: null, lastChecked: '2026-10-23T14:00:00.000Z', incidents: [i] }] as never
    let acc = accumulateMonthlyIncidents(null, card(inc({ status: 'monitoring', startedAt: '2026-10-23T09:00:00.000Z' })), '2026-10', null)
    acc = accumulateMonthlyIncidents(acc, card(inc({ startedAt: '2026-10-23T09:00:00.000Z' })), '2026-10', null)
    expect(acc.services.mistral.incidents![0]).toMatchObject({ finalStatus: 'resolved', resolvedAt: null, durationMin: 0 })
  })

  it('gives the monthly Score the same abstain as the live one', () => {
    const window = { startISO: '2026-10-01T00:00:00.000Z', endISO: '2026-11-01T00:00:00.000Z' }
    const score = (e: MonthlyIncidentEntry) => computeMonthlyScore('mistral', [e], 99.9, new Map(), window, undefined).score
    expect(score(entry()), 'scored like an anchored row, whose Recovery abstains').toBe(score(entry({ startUnknown: true })))
    expect(score(entry({ resolvedAt: '2026-10-23T09:21:52.000Z' })), 'control: a stated 0-minute row scores Recovery 0').toBeLessThan(score(entry())!)
  })

  it('keeps it out of the narrative candidates, which would label a 0-minute resolved row', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const archive = {
      period: '2026-10', generatedAt: '2026-11-01T00:00:00Z', daysCollected: 31,
      services: { mistral: { incidentList: [entry(), measuredEntry()] } },
    } as unknown as MonthlyArchive
    expect(selectIncidentCandidates(archive, { mistral: 'Mistral API' }).map((c) => c.id)).toEqual(['e2'])
  })
})

describe('the resolution event: no end is stamped from the cron clock', () => {
  const store = () => {
    const kv: Record<string, string> = { 'ai:analysis:mistral:i1': JSON.stringify({ summary: 'x', firstEstimatedRecoveryHours: 2 }) }
    return { kv, api: { get: async (k: string) => kv[k] ?? null, put: async (k: string, v: string) => { kv[k] = v }, delete: async (k: string) => { delete kv[k] } } }
  }

  it('markIncidentResolved writes no recovery marker and stamps no analysis resolvedAt', async () => {
    const s = store()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await markIncidentResolved(s.api as never, 'mistral', inc(), '2026-10-24T01:08:47.000Z')
    expect(out).toBeNull()
    expect(Object.keys(s.kv).some((k) => k.startsWith('recovered:'))).toBe(false)
    expect(JSON.parse(s.kv['ai:analysis:mistral:i1']).resolvedAt).toBeUndefined()
  })

  it('control: a resolved incident with its end still gets its marker', async () => {
    const s = store()
    await markIncidentResolved(s.api as never, 'mistral', measured(), '2026-10-24T01:08:47.000Z')
    expect(Object.keys(s.kv).some((k) => k.startsWith('recovered:'))).toBe(true)
  })

  it('buildHistoryRecord writes nothing into the no-TTL corpus', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = { id: 'mistral', provider: 'Mistral AI', category: 'api' as const }
    expect(buildHistoryRecord(svc, inc(), null, '2026-10-24T01:08:47.000Z', [])).toBeNull()
    expect(buildHistoryRecord(svc, { ...inc(), status: 'monitoring' }, null, '2026-10-24T01:08:47.000Z', []), 'monitoring keeps its existing treatment').not.toBeNull()
  })
})

describe('the /feed resolved item', () => {
  const svc = (incidents: Incident[]): ServiceStatus => ({
    id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', category: 'api', status: 'operational',
    latency: null, uptime30d: null, lastChecked: new Date().toISOString(), incidents,
  } as never)
  const ai = (id: string): RssAiAnalysisMap => ({ mistral: [{ incidentId: id, summary: 's', estimatedRecovery: '1–2h', estimatedRecoveryHours: 2, affectedScope: [] }] })

  it('grades no prediction against a duration it does not have', () => {
    expect(buildRssFeed([svc([inc()])], { scope: 'all' }, new Date(), ai('i1'))).not.toContain('AI prediction:')
  })

  it('control: a measured resolution still carries the line', () => {
    expect(buildRssFeed([svc([measured()])], { scope: 'all' }, new Date(), ai('m1'))).toContain('AI prediction:')
  })
})

describe('the /feed resolved item\'s pubDate', () => {
  const svc = (incidents: Incident[]): ServiceStatus => ({
    id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', category: 'api', status: 'operational',
    latency: null, uptime30d: null, lastChecked: new Date().toISOString(), incidents,
  } as never)
  const ended = () => inc({ timeline: [{ stage: 'investigating', text: 'Looking into it.', at: '2026-10-23T09:25:00.000Z' }] })
  const pubDateOf = (xml: string) => /<guid[^>]*>aiwatch:mistral:i1:resolved<\/guid>\s*<pubDate>([^<]+)<\/pubDate>/.exec(xml)?.[1]

  it('is when /feed first served it, not the last update before the end', () => {
    const { xml } = buildFeedWithMeta([svc([ended()])], { scope: 'all' }, new Date('2026-10-24T02:00:00.000Z'), undefined, { [resolvedSeenKey('i1')]: '2026-10-24T01:40:00.000Z' })
    expect(pubDateOf(xml)).toBe(new Date('2026-10-24T01:40:00.000Z').toUTCString())
  })

  it('falls back to now when no stamp could be read, never to the last update', () => {
    const { xml } = buildFeedWithMeta([svc([ended()])], { scope: 'all' }, new Date('2026-10-24T02:00:00.000Z'))
    expect(pubDateOf(xml)).toBe(new Date('2026-10-24T02:00:00.000Z').toUTCString())
  })

  it('the /feed handler stamps it once on a clean miss, under its own key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store: Record<string, string> = {
      [CACHE_KEY]: JSON.stringify({ services: [svc([ended()])], cachedAt: new Date().toISOString() }),
      'feed:active-emitted:i1': '1',
    }
    const kv = {
      get: async (k: string) => store[k] ?? null,
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async (k: string, v: string) => { store[k] = v },
      delete: async (k: string) => { delete store[k] },
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    }
    const run = () => workerModule.fetch(new Request('https://example.com/feed.xml'), { ALLOWED_ORIGIN: '*', STATUS_CACHE: kv } as never,
      { waitUntil: (p: Promise<unknown>) => { void p.catch(() => {}) }, passThroughOnException: () => {} } as never)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-24T01:40:00.000Z'))
      await run()
      expect(store['feed:resolved-seen:i1']).toBe('2026-10-24T01:40:00.000Z')
      expect(store['feed:firstseen:i1'], 'the active item\'s first-seen key is not touched').toBeUndefined()
      vi.setSystemTime(new Date('2026-10-24T02:10:00.000Z'))
      expect(pubDateOf(await (await run()).text()), 'a later poll renders the stamp, not its own clock').toBe(new Date('2026-10-24T01:40:00.000Z').toUTCString())
    } finally { vi.useRealTimers() }
  })
})

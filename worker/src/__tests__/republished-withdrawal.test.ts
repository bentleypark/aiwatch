import { describe, it, expect } from 'vitest'
import { accumulateIncidentsOnlyIfChanged, PHANTOM_PRUNE_AFTER_MISSED_RUNS, stripInternalFields, type MonthlyIncidents } from '../monthly-archive'
import { buildWithdrawalAlerts, REPUBLISHED_NOTE, WITHDRAWN_NOTE } from '../alerts'
import { buildRssFeed } from '../rss'
import { diffPrunedIncidents, type WithdrawnIncident } from '../withdrawn'
import type { Incident, ServiceStatus } from '../types'

const makeKV = () => {
  const store: Record<string, string> = {}
  return {
    kv: { get: async (k: string) => store[k] ?? null, put: async (k: string, v: string) => { store[k] = v } } as unknown as KVNamespace,
    store,
  }
}

const svc = (incidents: Incident[], id = 'deepgram', name = 'Deepgram'): ServiceStatus =>
  ({ id, name, provider: 'Deepgram', category: 'api', status: 'operational', uptime30d: null, latency: null, incidents } as ServiceStatus)

const open = (id: string, title: string, startedAt: string): Incident =>
  ({ id, title, status: 'investigating', impact: 'major', startedAt, duration: null, timeline: [] })

const done = (id: string, title: string, startedAt: string, resolvedAt: string): Incident =>
  ({ id, title, status: 'resolved', impact: 'major', startedAt, resolvedAt, duration: '10m', timeline: [] })

const FLUX = 'Flux TTS high latency and websocket disconnects'
const EARLIER = done('7gc59hcv5ffc', 'Elevated errors for Flux streaming STT', '2026-11-05T18:42:08.991Z', '2026-11-06T01:14:54.554Z')

async function run(cycles: Incident[][]) {
  const { kv, store } = makeKV()
  for (const [i, incidents] of cycles.entries()) {
    await accumulateIncidentsOnlyIfChanged(kv, [svc(incidents)], '2026-11', new Date(Date.UTC(2026, 10, 10, 13, 55 + i * 5, 7)))
  }
  return {
    tombstones: JSON.parse(store['incidents:withdrawn'] ?? '[]') as WithdrawnIncident[],
    log: JSON.parse(store['incidents:withdrawn:log:2026-11'] ?? '[]') as Array<Record<string, unknown>>,
    rows: (JSON.parse(store['incidents:monthly:2026-11']) as MonthlyIncidents).services.deepgram.incidents ?? [],
  }
}

const replay = (firstCycle: Incident[], laterCycles: Incident[]) =>
  run([firstCycle, ...Array.from({ length: PHANTOM_PRUNE_AFTER_MISSED_RUNS }, () => laterCycles)])

describe('#1951 — a deleted incident re-posted under a new id', () => {
  it('marks the Deepgram 2026-11-10 sequence, whose replacement is backdated and already resolved', async () => {
    const replacement = done('725lzvwbndns', FLUX, '2026-11-10T03:10:48.000Z', '2026-11-10T03:20:19.000Z')
    const { tombstones, log } = await replay(
      [EARLIER, open('wd9z1yzytmp0', FLUX, '2026-11-10T13:53:06.398Z')],
      [EARLIER, replacement],
    )
    expect(tombstones.map((w) => [w.incId, w.republishedAs])).toEqual([['wd9z1yzytmp0', '725lzvwbndns']])
    expect(log.map((r) => r.republishedAs)).toEqual(['725lzvwbndns'])
  })

  it('marks a replacement first seen on the very cycle the old row is pruned', async () => {
    const replacement = done('late', FLUX, '2026-11-10T03:10:00Z', '2026-11-10T03:20:00Z')
    const { tombstones } = await run([[EARLIER, open('deleted', FLUX, '2026-11-10T13:53:06Z')], [EARLIER], [EARLIER], [EARLIER, replacement]])
    expect(tombstones.map((w) => [w.incId, w.republishedAs])).toEqual([['deleted', 'late']])
  })

  it('leaves a row with no first-miss mark unmarked, such as one already counting at deploy', () => {
    const row = (id: string, finalStatus: 'investigating' | 'resolved') => ({ id, title: FLUX, startedAt: '2026-11-10T13:53:06Z', resolvedAt: null, durationMin: 0, finalStatus })
    const month = (rows: ReturnType<typeof row>[]): MonthlyIncidents => ({
      lastUpdated: '2026-11-10T14:00:00Z',
      services: { deepgram: { count: rows.length, totalMinutes: 0, longestMinutes: 0, dates: [], durations: {}, incidentIds: rows.map((r) => r.id), incidents: rows } },
    })
    const [tomb] = diffPrunedIncidents(month([row('deleted', 'investigating')]), month([row('new', 'resolved')]), '2026-11-10T14:10:00Z')
    expect(tomb.incId).toBe('deleted')
    expect(tomb).not.toHaveProperty('republishedAs')
  })

  it('matches a title differing only in case and whitespace', async () => {
    const { tombstones } = await replay(
      [EARLIER, open('old', 'Service Degradation for GLM', '2026-11-10T13:53:06Z')],
      [EARLIER, done('new', '  service degradation for GLM ', '2026-11-10T03:10:00Z', '2026-11-10T03:20:00Z')],
    )
    expect(tombstones[0].republishedAs).toBe('new')
  })

  it('leaves a recurring title that was banked before the deleted id unmarked', async () => {
    const recurring = done('banked-first', FLUX, '2026-11-10T12:00:00Z', '2026-11-10T12:30:00Z')
    const { tombstones, log } = await replay(
      [EARLIER, recurring, open('deleted', FLUX, '2026-11-10T13:53:06Z')],
      [EARLIER, recurring],
    )
    expect(tombstones.map((w) => w.incId)).toEqual(['deleted'])
    expect(tombstones[0]).not.toHaveProperty('republishedAs')
    expect(log[0]).not.toHaveProperty('republishedAs')
  })

  it('leaves a same-title row seen in the same pass as the deleted one unmarked, whatever the feed order', async () => {
    const older = done('older', FLUX, '2026-11-10T12:00:00Z', '2026-11-10T12:30:00Z')
    const { tombstones } = await replay([open('deleted', FLUX, '2026-11-10T13:53:06Z'), older, EARLIER], [older, EARLIER])
    expect(tombstones.map((w) => w.incId)).toEqual(['deleted'])
    expect(tombstones[0]).not.toHaveProperty('republishedAs')
  })

  it('leaves a recurrence banked between the deleted row appearing and vanishing unmarked', async () => {
    const later = done('later', FLUX, '2026-11-10T14:00:00Z', '2026-11-10T14:10:00Z')
    const deleted = open('deleted', FLUX, '2026-11-10T13:53:06Z')
    const { tombstones } = await run([[EARLIER, deleted], [EARLIER, deleted, later], [EARLIER, later], [EARLIER, later], [EARLIER, later]])
    expect(tombstones.map((w) => w.incId)).toEqual(['deleted'])
    expect(tombstones[0]).not.toHaveProperty('republishedAs')
  })

  it('does not name a status_history row AIWatch synthesized', async () => {
    const derived: Incident = { ...done('bs-hist:r:2026-11-09', FLUX, '2026-11-09T12:00:00Z', '2026-11-09T12:10:00Z'), derived: 'status_history', derivedDay: '2026-11-09' }
    const { tombstones, rows } = await replay([EARLIER, open('deleted', FLUX, '2026-11-10T13:53:06Z')], [EARLIER, derived])
    expect(rows.map((r) => r.id)).toContain('bs-hist:r:2026-11-09')
    expect(tombstones[0]).not.toHaveProperty('republishedAs')
  })

  it('does not name a candidate that is itself going missing', async () => {
    const candidate = open('candidate', FLUX, '2026-11-10T14:00:00Z')
    const { tombstones, rows } = await run([[EARLIER, open('deleted', FLUX, '2026-11-10T13:53:06Z')], [EARLIER, candidate], [EARLIER], [EARLIER]])
    expect(rows.find((r) => r.id === 'candidate')?.missedRuns).toBe(2)
    expect(tombstones.map((w) => w.incId)).toEqual(['deleted'])
    expect(tombstones[0]).not.toHaveProperty('republishedAs')
  })

  it('drops the first-miss mark with the miss count when the row reappears', async () => {
    const row = open('flapping', FLUX, '2026-11-10T13:53:06Z')
    const missed = await run([[EARLIER, row], [EARLIER]])
    expect(missed.rows.find((r) => r.id === 'flapping')).toMatchObject({ missedRuns: 1, idsBankedAtFirstMiss: 2 })
    const back = await run([[EARLIER, row], [EARLIER], [EARLIER, row]])
    expect(back.rows.find((r) => r.id === 'flapping')).not.toHaveProperty('idsBankedAtFirstMiss')
  })

  it('keeps the first-miss mark out of public archives', () => {
    const row = { id: 'a', title: FLUX, startedAt: '2026-11-10T13:53:06Z', resolvedAt: null, durationMin: 0, finalStatus: 'investigating' as const, missedRuns: 2, idsBankedAtFirstMiss: 2 }
    expect(stripInternalFields(row)).toEqual({ id: 'a', title: FLUX, startedAt: '2026-11-10T13:53:06Z', resolvedAt: null, durationMin: 0, finalStatus: 'investigating' })
  })

  it('drops the first-miss mark with the miss count on a guard-3 hold', async () => {
    const row = open('held', FLUX, '2026-11-10T13:53:06Z')
    const newer = done('newer', 'Unrelated', '2026-11-10T14:00:00Z', '2026-11-10T14:10:00Z')
    const { rows } = await run([[EARLIER, row], [EARLIER], [newer]])
    expect(rows.find((r) => r.id === 'held')).not.toHaveProperty('idsBankedAtFirstMiss')
  })

  it('does not name a row deleted in the same cycle as the replacement', async () => {
    const { tombstones } = await replay(
      [EARLIER, open('first', FLUX, '2026-11-10T13:53:06Z'), open('second', FLUX, '2026-11-10T13:54:06Z')],
      [EARLIER],
    )
    expect(tombstones.map((w) => [w.incId, w.republishedAs])).toEqual([['first', undefined], ['second', undefined]])
  })

  it('leaves a same-title row on another service out of it', async () => {
    const { kv, store } = makeKV()
    const other = (incidents: Incident[]) => svc(incidents, 'assemblyai', 'AssemblyAI')
    await accumulateIncidentsOnlyIfChanged(kv, [svc([EARLIER, open('deleted', FLUX, '2026-11-10T13:53:06Z')]), other([])], '2026-11', new Date('2026-11-10T13:55:10Z'))
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS; i++) {
      await accumulateIncidentsOnlyIfChanged(kv, [svc([EARLIER]), other([open('elsewhere', FLUX, '2026-11-10T13:58:00Z')])], '2026-11', new Date(Date.UTC(2026, 10, 10, 14, i * 5, 7)))
    }
    const [tomb] = JSON.parse(store['incidents:withdrawn']) as WithdrawnIncident[]
    expect(tomb.incId).toBe('deleted')
    expect(tomb).not.toHaveProperty('republishedAs')
  })
})

describe('#1951 — what each channel says', () => {
  const tomb = (over: Partial<WithdrawnIncident> = {}): WithdrawnIncident => ({
    svcId: 'deepgram', incId: 'wd9z1yzytmp0', title: FLUX,
    startedAt: '2026-11-10T13:53:06.398Z', prunedAt: '2026-11-10T14:10:07.601Z', ...over,
  })
  const live = [svc([done('725lzvwbndns', FLUX, '2026-11-10T03:10:48.000Z', '2026-11-10T03:20:19.000Z')])]
  const announced = new Set(['wd9z1yzytmp0'])

  it('Discord: a re-publication keeps the withdrawal key and drops the no-recovery claim', () => {
    const [a] = buildWithdrawalAlerts([tomb({ republishedAs: '725lzvwbndns' })], announced, live, () => {})
    expect(a.key).toBe('alerted:wd:wd9z1yzytmp0')
    expect(a.title).toBe('⚪ Deepgram — Incident Entry Changed')
    expect(a.description).toBe(`${FLUX}\n${REPUBLISHED_NOTE}`)
    expect(a.description).not.toContain('no recovery record')
  })

  it('Discord: a plain withdrawal is unchanged', () => {
    const [a] = buildWithdrawalAlerts([tomb()], announced, live, () => {})
    expect(a.title).toBe('⚪ Deepgram — Incident Withdrawn')
    expect(a.description).toBe(`${FLUX}\n${WITHDRAWN_NOTE}`)
  })

  it('Discord: one surface without a replacement keeps the whole notice a withdrawal', () => {
    for (const order of [['deepgram', 'other'], ['other', 'deepgram']]) {
      const tombs = order.map((svcId) => tomb({ svcId, ...(svcId === 'deepgram' ? { republishedAs: '725lzvwbndns' } : {}) }))
      const [a] = buildWithdrawalAlerts(tombs, announced, [...live, svc([], 'other', 'Other')], () => {})
      expect(a.title).toContain('Incident Withdrawn')
      expect(a.description).toContain(WITHDRAWN_NOTE)
    }
  })

  it('Discord: a replacement gone from the page by notice time is a withdrawal', () => {
    const [a] = buildWithdrawalAlerts([tomb({ republishedAs: 'gone' })], announced, live, () => {})
    expect(a.title).toBe('⚪ Deepgram — Incident Withdrawn')
    expect(a.description).toContain(WITHDRAWN_NOTE)
  })

  const feed = (t: WithdrawnIncident) =>
    buildRssFeed(live, { scope: 'service', service: live[0] }, new Date('2026-11-10T14:15:00Z'), undefined, undefined, announced, [t])

  it('RSS: a re-publication keeps its guid and drops the no-recovery claim', () => {
    const xml = feed(tomb({ republishedAs: '725lzvwbndns' }))
    expect(xml).toContain('Deepgram — Incident Entry Changed')
    expect(xml).toContain('aiwatch:deepgram:wd9z1yzytmp0:withdrawn')
    expect(xml).toContain('Entry changed by the provider')
    expect(xml).not.toContain('Incident Withdrawn')
    expect(xml).not.toContain('no recovery record')
  })

  it('RSS: a replacement gone from the page by notice time is a withdrawal', () => {
    expect(feed(tomb({ republishedAs: 'gone' }))).toContain('Deepgram — Incident Withdrawn')
  })

  it('RSS: one surface without a replacement reads as a withdrawal on every feed', () => {
    const services = [...live, svc([], 'other', 'Other')]
    const tombs = [tomb({ republishedAs: '725lzvwbndns' }), tomb({ svcId: 'other' })]
    const now = new Date('2026-11-10T14:15:00Z')
    for (const opts of [{ scope: 'all' as const }, { scope: 'service' as const, service: services[0] }, { scope: 'service' as const, service: services[1] }]) {
      const xml = buildRssFeed(services, opts, now, undefined, undefined, announced, tombs)
      expect(xml).toContain('Incident Withdrawn')
      expect(xml).not.toContain('Entry Changed')
    }
  })

  it('RSS: a plain withdrawal is unchanged', () => {
    const xml = feed(tomb())
    expect(xml).toContain('Deepgram — Incident Withdrawn')
    expect(xml).toContain('Withdrawn by the provider')
    expect(xml).toContain('no recovery record')
  })
})

// #1091 — the daily summary lists `monitoring` incidents with no `alerted:new:` roster entry for the
// service. The pure functions are pinned with hand-built fixtures
// that differ on the axis each rule keys on; the wiring block at the bottom drives the real scheduled()
// handler, because the pure functions can be green while the cron never reads the roster or never
// passes the field (same shape as short-archive-daily-signal-1355.test.ts).

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  monitoringCandidates, withheldMonitoring, readWithheldMonitoring, formatWithheldMonitoringLine, buildDailySummary,
  type MonitoringCandidate, type MonitoringRoster, type WithheldMonitoringItem,
} from '../daily-summary'
import type { Incident, ServiceStatus } from '../types'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'

const NOW = Date.parse('2026-11-10T09:02:00.000Z')
const H = 3_600_000
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

function inc(over: Partial<Incident> & { id: string }): Incident {
  return {
    title: 'Europe reduced model set', status: 'monitoring', impact: 'minor',
    startedAt: iso(2 * H), resolvedAt: null, duration: null,
    timeline: [{ stage: 'monitoring', text: 'x', at: iso(2 * H) }],
    ...over,
  } as unknown as Incident
}
const svc = (id: string, incidents: Incident[], name = id.toUpperCase()): ServiceStatus =>
  ({ id, name, status: 'degraded', incidents }) as unknown as ServiceStatus
const idsOf = (cs: MonitoringCandidate[]) => cs.map((c) => c.incId)

describe('monitoringCandidates (#1091)', () => {
  it('takes an incident first posted at monitoring, and one that is monitoring now after earlier stages', () => {
    const first = inc({ id: 'first' })
    const later = inc({ id: 'later', timeline: [{ stage: 'investigating', text: 'x', at: iso(3 * H) }, { stage: 'monitoring', text: 'x', at: iso(1 * H) }] })
    expect(idsOf(monitoringCandidates([svc('a', [first, later])], NOW)).sort()).toEqual(['first', 'later'])
  })

  it('leaves out an active incident that never reached monitoring', () => {
    const active = inc({ id: 'act', status: 'investigating', timeline: [{ stage: 'investigating', text: 'x', at: iso(2 * H) }] })
    expect(monitoringCandidates([svc('a', [active])], NOW)).toEqual([])
  })

  it('a reopened monitoring-first incident stays a candidate by its first stage', () => {
    const reopened = inc({ id: 're', status: 'investigating', timeline: [{ stage: 'monitoring', text: 'x', at: iso(3 * H) }, { stage: 'investigating', text: 'x', at: iso(1 * H) }] })
    expect(idsOf(monitoringCandidates([svc('a', [reopened])], NOW))).toEqual(['re'])
  })

  it('resolved: monitoring-first inside 24h is a candidate, outside it is not', () => {
    const resolvedAgo = (id: string, ago: number) => inc({ id, status: 'resolved', startedAt: iso(ago + 2 * H), resolvedAt: iso(ago), timeline: [{ stage: 'monitoring', text: 'x', at: iso(ago + 2 * H) }, { stage: 'resolved', text: 'x', at: iso(ago) }] })
    expect(idsOf(monitoringCandidates([svc('a', [resolvedAgo('in', 3 * H), resolvedAgo('out', 25 * H)])], NOW))).toEqual(['in'])
  })

  it('a resolved incident whose FIRST stage was resolved is not monitoring-first', () => {
    const afterTheFact = inc({ id: 'rf', status: 'resolved', startedAt: iso(3 * H), resolvedAt: iso(1 * H), timeline: [{ stage: 'resolved', text: 'x', at: iso(1 * H) }] })
    expect(monitoringCandidates([svc('a', [afterTheFact])], NOW)).toEqual([])
  })

  it('reads the first stage by timestamp, not by array position', () => {
    const resolved = (id: string, timeline: Incident['timeline']) => inc({ id, status: 'resolved', startedAt: iso(4 * H), resolvedAt: iso(1 * H), timeline })
    const monitoringEarliest = resolved('m', [{ stage: 'resolved', text: 'x', at: iso(1 * H) }, { stage: 'investigating', text: 'x', at: iso(2 * H) }, { stage: 'monitoring', text: 'x', at: iso(3 * H) }])
    const investigatingEarliest = resolved('i', [{ stage: 'monitoring', text: 'x', at: iso(2 * H) }, { stage: 'investigating', text: 'x', at: iso(3 * H) }, { stage: 'resolved', text: 'x', at: iso(1 * H) }])
    expect(idsOf(monitoringCandidates([svc('a', [monitoringEarliest, investigatingEarliest])], NOW))).toEqual(['m'])
  })

  it('is bounded by the roster TTL: 7 days or more cannot be told apart from an expired key', () => {
    const d = (n: number) => iso(n * 24 * H)
    const at = (id: string, startedAt: string) => inc({ id, startedAt, timeline: [{ stage: 'monitoring', text: 'x', at: startedAt }] })
    expect(idsOf(monitoringCandidates([svc('a', [at('six', d(6)), at('eight', d(8))])], NOW))).toEqual(['six'])
  })

  it('makes no claim about a start it cannot date, or a resolve it cannot date', () => {
    const noStart = inc({ id: 'ns', startedAt: 'not-a-date' })
    const noEnd = inc({ id: 'ne', status: 'resolved', resolvedAt: 'not-a-date', timeline: [{ stage: 'monitoring', text: 'x', at: iso(2 * H) }] })
    expect(monitoringCandidates([svc('a', [noStart, noEnd])], NOW)).toEqual([])
  })

  it('skips a synthesized day row and a retained bridge entry', () => {
    const derived = inc({ id: 'd', derived: 'status_history' } as never)
    const bridge = inc({ id: 'b', retainedBridge: true } as never)
    expect(monitoringCandidates([svc('a', [derived, bridge])], NOW)).toEqual([])
  })

  it('folds one incident shared by two services into one candidate', () => {
    const shared = inc({ id: 'shared' })
    const [c, ...rest] = monitoringCandidates([svc('claudeai', [shared], 'claude.ai'), svc('claudecode', [shared], 'Claude Code')], NOW)
    expect(rest).toEqual([])
    expect(c.svcIds).toEqual(['claudeai', 'claudecode'])
    expect(c.names).toEqual(['claude.ai', 'Claude Code'])
  })
})

describe('withheldMonitoring (#1091)', () => {
  const cand = (incId: string, svcIds: string[], over: Partial<Incident> = {}): MonitoringCandidate =>
    ({ incId, svcIds, names: svcIds.map((s) => s.toUpperCase()), inc: inc({ id: incId, ...over }) })
  const rosters = (entries: Array<[string, MonitoringRoster]>) => new Map(entries)

  it('lists a candidate whose roster key is absent', () => {
    expect(withheldMonitoring([cand('x', ['bfl'])], rosters([['x', null]])).map((i) => i.names)).toEqual([['BFL']])
  })

  it('drops a candidate the roster covers — the ordinary investigating-then-monitoring path', () => {
    expect(withheldMonitoring([cand('x', ['bfl'])], rosters([['x', new Set(['bfl'])]]))).toEqual([])
  })

  it('keeps only the services the roster does not cover (the #545 joiner)', () => {
    const out = withheldMonitoring([cand('x', ['chatgpt', 'openai'])], rosters([['x', new Set(['chatgpt'])]]))
    expect(out.map((i) => i.names)).toEqual([['OPENAI']])
  })

  it('makes no claim when the roster was never read', () => {
    expect(withheldMonitoring([cand('x', ['bfl'])], rosters([]))).toEqual([])
  })

  it('lists unresolved before resolved, each newest first, and carries the resolve fields only when resolved', () => {
    const resolved = (id: string, ago: number) => cand(id, ['a'], { status: 'resolved', startedAt: iso(ago + H), resolvedAt: iso(ago), duration: '1h 0m' })
    const open = (id: string, ago: number) => cand(id, ['a'], { startedAt: iso(ago) })
    const all = rosters([['r1', null], ['r2', null], ['o1', null], ['o2', null]])
    const out = withheldMonitoring([resolved('r1', 5 * H), open('o1', 9 * H), resolved('r2', 2 * H), open('o2', 3 * H)], all)
    expect(out.map((i) => i.incId)).toEqual(['o2', 'o1', 'r2', 'r1'])
    expect(out[0]).toMatchObject({ resolvedAt: null, duration: null, status: 'monitoring' })
    expect(out[2]).toMatchObject({ status: 'resolved' })
    expect(out[2]).toMatchObject({ duration: '1h 0m' })
    expect(out[2].resolvedAt).not.toBeNull()
  })
})

describe('readWithheldMonitoring (#1091)', () => {
  const kvOf = (store: Record<string, string | Error>) => {
    const get = vi.fn(async (key: string) => {
      const v = store[key]
      if (v instanceof Error) throw v
      return v ?? null
    })
    return { kv: { get } as unknown as Pick<KVNamespace, 'get'>, get }
  }
  afterEach(() => { vi.restoreAllMocks() })

  it('reads the roster of the candidates only, not of every incident on the page', async () => {
    const old = inc({ id: 'old', status: 'resolved', startedAt: iso(40 * H), resolvedAt: iso(30 * H), timeline: [{ stage: 'investigating', text: 'x', at: iso(40 * H) }] })
    const act = inc({ id: 'act', status: 'investigating', timeline: [{ stage: 'investigating', text: 'x', at: iso(2 * H) }] })
    const { kv, get } = kvOf({})
    const out = await readWithheldMonitoring(kv, [svc('bfl', [inc({ id: 'cand' }), old, act])], NOW)
    expect(get.mock.calls.map((c) => c[0])).toEqual(['alerted:new:cand'])
    expect(out.map((i) => i.incId)).toEqual(['cand'])
  })

  it('separates absent, rostered, corrupt and faulting reads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { kv } = kvOf({
      'alerted:new:rostered': JSON.stringify(['bfl']),
      'alerted:new:corrupt': '{not json',
      'alerted:new:fault': new Error('KV down'),
    })
    const out = await readWithheldMonitoring(kv, [svc('bfl', ['absent', 'rostered', 'corrupt', 'fault'].map((id) => inc({ id })))], NOW)
    expect(out.map((i) => i.incId)).toEqual(['absent'])
    expect(warn.mock.calls.some((c) => String(c[0]).includes('2 of 4'))).toBe(true)
  })

  it('judges each service on its own: a roster naming one service does not clear a joiner', async () => {
    const { kv } = kvOf({ 'alerted:new:x': JSON.stringify(['chatgpt']) })
    const shared = inc({ id: 'x' })
    const out = await readWithheldMonitoring(kv, [svc('chatgpt', [shared], 'ChatGPT'), svc('openai', [shared], 'OpenAI API')], NOW)
    expect(out.map((i) => i.names)).toEqual([['OpenAI API']])
  })

  it('never throws into the daily report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = { id: 'x', name: 'X', status: 'degraded', incidents: 7 } as unknown as ServiceStatus
    await expect(readWithheldMonitoring(kvOf({}).kv, [broken], NOW)).resolves.toEqual([])
    expect(warn).toHaveBeenCalled()
  })
})

describe('formatWithheldMonitoringLine (#1091)', () => {
  const item = (over: Partial<WithheldMonitoringItem> = {}): WithheldMonitoringItem =>
    ({ incId: 'i', names: ['Black Forest Labs (FLUX)'], title: 'Europe reduced model set', status: 'monitoring', startedAt: iso(5 * H), resolvedAt: null, duration: null, ...over })
  afterEach(() => { vi.useRealTimers() })

  it('renders nothing for no items', () => {
    expect(formatWithheldMonitoringLine([])).toBe('')
    expect(formatWithheldMonitoringLine(null)).toBe('')
    expect(formatWithheldMonitoringLine(undefined)).toBe('')
  })

  it('shows an unresolved incident with its current status and the time since it started', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW)
    const out = formatWithheldMonitoringLine([item()])
    expect(out).toContain('Services with no New Incident alert for a monitoring incident')
    expect(out).toContain('Black Forest Labs (FLUX) — Europe reduced model set · monitoring · open 5h')
  })

  it('ends the row at the status when no elapsed time can be read (a start in the future)', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW)
    const row = formatWithheldMonitoringLine([item({ startedAt: new Date(NOW + 10 * 60_000).toISOString() })]).split('\n').find((l) => l.startsWith('   Black'))!
    expect(row.endsWith('· monitoring')).toBe(true)
    expect(row).not.toContain('open')
  })

  it('does not call a reopened incident monitoring', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW)
    const out = formatWithheldMonitoringLine([item({ status: 'investigating' })])
    expect(out).toContain('· investigating · open 5h')
    expect(out).not.toContain('· monitoring ·')
  })

  it('shows a resolved incident with its duration, or without one when none was published', () => {
    const resolved = { resolvedAt: iso(1 * H) }
    expect(formatWithheldMonitoringLine([item({ ...resolved, duration: '27m' })])).toContain('· resolved in 27m')
    const bare = formatWithheldMonitoringLine([item(resolved)])
    expect(bare).toContain('· resolved')
    expect(bare).not.toContain('resolved in')
  })

  it('neutralizes mentions and code fences and cuts a long provider title', () => {
    const out = formatWithheldMonitoringLine([item({ title: '@everyone ```x``` ' + 'y'.repeat(200) })])
    expect(out).not.toContain('@everyone')
    expect(out).not.toContain('```')
    expect(out.split('\n').find((l) => l.includes('yyy'))!.length).toBeLessThan(200)
  })

  it('caps the list and says how many it left out', () => {
    const out = formatWithheldMonitoringLine(Array.from({ length: 5 }, (_, i) => item({ incId: `i${i}`, names: [`S${i}`] })))
    expect(out.split('\n').filter((l) => l.startsWith('   S'))).toHaveLength(3)
    expect(out).toContain('+2 more')
    expect(formatWithheldMonitoringLine(Array.from({ length: 3 }, (_, i) => item({ names: [`S${i}`] })))).not.toContain('more')
  })

  it('bounds the service-name list, so one incident shared by many surfaces cannot stretch a row', () => {
    const names = Array.from({ length: 12 }, (_, i) => `Surface number ${i}`)
    const row = formatWithheldMonitoringLine([item({ names })]).split('\n').find((l) => l.startsWith('   Surface'))!
    expect(row.split(' — ')[0].trim().length).toBeLessThanOrEqual(48)
    expect(row.split(' — ')[0]).toContain('…')
    const short = formatWithheldMonitoringLine([item({ names: ['claude.ai', 'Claude Code'] })])
    expect(short).toContain('claude.ai, Claude Code —')
    expect(short).not.toContain('…')
  })
})

describe('buildDailySummary withheld-monitoring line (#1091)', () => {
  const base = { services: [] as ServiceStatus[], aiUsage: null, incidentCountToday: { newCount: 0, resolvedCount: 0 }, redditCount: 0 }
  const withheld: WithheldMonitoringItem[] = [{ incId: 'i', names: ['Black Forest Labs (FLUX)'], title: 'Europe reduced model set', status: 'monitoring', startedAt: iso(2 * H), resolvedAt: null, duration: null }]

  it('includes the line, below Active Issues and above the traffic sections', () => {
    const out = buildDailySummary({
      ...base,
      services: [{ id: 'bfl', name: 'Black Forest Labs (FLUX)', status: 'degraded', incidents: [] } as unknown as ServiceStatus],
      withheldMonitoring: withheld,
      pluginTraffic: { monitor: 5, brief: 1 },
    })
    const activeAt = out.indexOf('Active Issues')
    const withheldAt = out.indexOf('Services with no New Incident alert for a monitoring incident')
    const pluginAt = out.indexOf('Plugin (Claude Code)')
    expect(activeAt).toBeGreaterThan(-1)
    expect(withheldAt).toBeGreaterThan(activeAt)
    expect(pluginAt).toBeGreaterThan(withheldAt)
  })

  it('omits the line when there is nothing withheld', () => {
    expect(buildDailySummary({ ...base, withheldMonitoring: [] })).not.toContain('Services with no New Incident alert for a monitoring incident')
    expect(buildDailySummary({ ...base, withheldMonitoring: null })).not.toContain('Services with no New Incident alert for a monitoring incident')
    expect(buildDailySummary(base)).not.toContain('Services with no New Incident alert for a monitoring incident')
  })
})

// ── Wiring: the real scheduled() handler ─────────────────────────────

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const RUN_AT = '2026-11-10T09:02:00.000Z'
const INC_ID = '237sqzlpytzg'

const OPERATIONAL: ServiceStatus[] = SERVICES.map(s => (
  { id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus
))
const WITH_BFL: ServiceStatus[] = OPERATIONAL.map(s => s.id === 'bfl'
  ? ({ ...s, status: 'degraded', incidents: [inc({ id: INC_ID })] } as unknown as ServiceStatus)
  : s)

type RosterState = 'absent' | 'rostered' | 'fault'

function makeKv(roster: RosterState) {
  const store = new Map<string, string>()
  const reads: string[] = []
  const kv = {
    get: async (key: string) => {
      reads.push(key)
      if (key === `alerted:new:${INC_ID}`) {
        if (roster === 'fault') throw new Error('simulated KV read fault')
        return roster === 'rostered' ? JSON.stringify(['bfl']) : null
      }
      if (key === 'services:latest') return JSON.stringify(WITH_BFL)
      return store.get(key) ?? null
    },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
  return { kv, reads }
}

async function runCron(kv: KVNamespace) {
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }))
  await workerModule.scheduled({ scheduledTime: Date.parse(RUN_AT), cron: '*/5 * * * *' } as ScheduledEvent, {
    STATUS_CACHE: kv,
    DISCORD_WEBHOOK_URL: 'https://example.invalid/hook',
  } as never, ctx)
  for (const call of fetchMock.mock.calls) {
    if (call[0] !== 'https://example.invalid/hook') continue
    const body = (call[1] as RequestInit | undefined)?.body
    if (typeof body === 'string' && body.includes('AIWatch Daily Report')) return body
  }
  return undefined
}

describe('daily summary names a withheld monitoring incident (#1091 wiring)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('carries the line into the real daily Discord report when no roster entry exists', async () => {
    const { kv, reads } = makeKv('absent')
    const body = await runCron(kv)

    expect(body).toBeDefined()
    expect(body).toContain('Services with no New Incident alert for a monitoring incident')
    expect(body).toContain('Europe reduced model set')
    expect(reads).toContain(`alerted:new:${INC_ID}`)
  })

  it('says nothing about an incident the roster covers — the other direction', async () => {
    const body = await runCron(makeKv('rostered').kv)

    expect(body).toBeDefined()
    expect(body).not.toContain('Services with no New Incident alert for a monitoring incident')
  })

  it('makes no claim when the roster cannot be read, and the report still goes out', async () => {
    const body = await runCron(makeKv('fault').kv)

    expect(body).toBeDefined()
    expect(body).not.toContain('Services with no New Incident alert for a monitoring incident')
  })
})

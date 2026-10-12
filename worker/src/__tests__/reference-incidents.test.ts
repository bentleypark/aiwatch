import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fetchService, referenceIncidentsOf, SERVICES } from '../services'
import type { Incident, ServiceConfig } from '../types'

// #1669 — real ids/names from status.claude.com (`feedback_faithful_fixtures`).
const CLAUDEAI = 'rwppv331jlwc'
const CONSOLE = '0qbwn08sd68x'
const CLAUDE_API = 'k8w3r06qmzrp'
const CLAUDE_CODE = 'yyzkbfz2thpt'
const NAME: Record<string, string> = {
  [CLAUDEAI]: 'claude.ai',
  [CONSOLE]: 'Claude Console (platform.claude.com)',
  [CLAUDE_API]: 'Claude API (api.anthropic.com)',
  [CLAUDE_CODE]: 'Claude Code',
}
const COMPONENTS = Object.entries(NAME).map(([id, name]) => ({ id, name, status: 'operational' }))

const cfg = (id: string): ServiceConfig => {
  const c = SERVICES.find((s) => s.id === id)
  if (!c) throw new Error(`missing SERVICES config: ${id}`)
  return c
}

const tagged = (ids: string[]) => ids.map((id) => ({ id, name: NAME[id], status: 'degraded_performance' }))

/** `978mjkgw6mh7` as status.claude.com served it on 2026-10-12 (updates trimmed to the latest). */
const consoleOnly = () => ({
  id: '978mjkgw6mh7',
  name: 'Elevated errors on platform.claude.com',
  status: 'monitoring',
  impact: 'major',
  created_at: '2026-10-07T13:25:04.163Z',
  resolved_at: null,
  components: tagged([CONSOLE]),
  incident_updates: [{
    status: 'monitoring', created_at: '2026-10-07T21:44:41.466Z',
    body: "We've mitigated the errors loading usage data on platform.claude.com and in the Admin API usage report.",
    affected_components: [{ code: CONSOLE, name: NAME[CONSOLE], old_status: 'partial_outage', new_status: 'degraded_performance' }],
  }],
})

/** 2026-10-01 "Delayed credits on the Claude Platform" — tagged Console AND Claude API. */
const consoleAndApi = () => ({
  ...consoleOnly(),
  id: 'consoleapi0001',
  name: 'Delayed credits on the Claude Platform',
  impact: 'minor',
  components: tagged([CONSOLE, CLAUDE_API]),
})

afterEach(() => { vi.restoreAllMocks() })

const fetchWith = (id: string, incidents: unknown[], componentStatus: Record<string, string> = {}) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
  const summary = {
    status: { indicator: 'minor', description: 'Partially Degraded Service' },
    components: COMPONENTS.map((c) => ({ ...c, status: componentStatus[c.id] ?? c.status })),
    incidents: [],
  }
  return fetchService(cfg(id), { summary: summary as never, incidents: { incidents } as never } as never, undefined, {})
}

describe('#1669 fetchService — a Console-only incident on the claude card', () => {
  it('lands in referenceIncidents and not in incidents', async () => {
    const svc = await fetchWith('claude', [consoleOnly()], { [CONSOLE]: 'degraded_performance' })
    expect(svc.incidents.map((i) => i.id)).not.toContain('978mjkgw6mh7')
    expect(svc.referenceIncidents?.map((i) => i.id)).toEqual(['978mjkgw6mh7'])
  })

  it('leaves the badge on the Claude API component', async () => {
    const svc = await fetchWith('claude', [consoleOnly()], { [CONSOLE]: 'degraded_performance' })
    expect(svc.status).toBe('operational')
  })

  it('an incident also tagged to Claude API stays a counted incident', async () => {
    const svc = await fetchWith('claude', [consoleAndApi()], { [CONSOLE]: 'degraded_performance', [CLAUDE_API]: 'degraded_performance' })
    expect(svc.incidents.map((i) => i.id)).toContain('consoleapi0001')
    expect(svc.referenceIncidents).toBeUndefined()
  })

  it('keeps the #1090 warn when Claude API is degraded and the only open incident is Console-only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await fetchWith('claude', [consoleOnly()], { [CONSOLE]: 'degraded_performance', [CLAUDE_API]: 'degraded_performance' })
    expect(warn.mock.calls.some((c) => String(c[0]).includes('#1090'))).toBe(true)
  })

  it('is never counted, even on a card whose component scoping would keep it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const summary = {
      status: { indicator: 'minor', description: 'Partially Degraded Service' },
      components: COMPONENTS.map((c) => ({ ...c, status: c.id === CLAUDE_API || c.id === CONSOLE ? 'degraded_performance' : c.status })),
      incidents: [],
    }
    const unscoped = { ...cfg('claude'), scopeIncidentsToComponent: false }
    const svc = await fetchService(unscoped, { summary: summary as never, incidents: { incidents: [consoleOnly()] } as never } as never, undefined, {})
    expect(svc.incidents.map((i) => i.id)).not.toContain('978mjkgw6mh7')
    expect(svc.referenceIncidents?.map((i) => i.id)).toEqual(['978mjkgw6mh7'])
  })

  it('a card without referenceComponentIds gets no referenceIncidents', async () => {
    const svc = await fetchWith('claudeai', [consoleOnly()], { [CONSOLE]: 'degraded_performance' })
    expect(svc.referenceIncidents).toBeUndefined()
  })
})

describe('#1669 referenceIncidentsOf', () => {
  const inc = (componentNames: string[] | undefined, componentIds?: string[]): Incident => ({
    id: 'x', title: 't', status: 'investigating', impact: 'major', startedAt: '2026-10-07T13:25:04.163Z',
    duration: null, timeline: [],
    ...(componentNames ? { componentNames } : {}),
    ...(componentIds ? { componentIds } : {}),
  } as Incident)
  const claude = cfg('claude')

  it('an untagged incident is never a reference incident', () => {
    expect(referenceIncidentsOf([inc(undefined), inc([])], claude, COMPONENTS)).toEqual([])
  })

  it('matches the page name case-insensitively', () => {
    expect(referenceIncidentsOf([inc([NAME[CONSOLE].toUpperCase()])], claude, COMPONENTS)).toHaveLength(1)
  })

  it('a componentIds tag outside the reference set disqualifies it', () => {
    expect(referenceIncidentsOf([inc([NAME[CONSOLE]], [CONSOLE, CLAUDE_API])], claude, COMPONENTS)).toEqual([])
  })

  it('a reference id the page no longer lists matches nothing', () => {
    expect(referenceIncidentsOf([inc([NAME[CONSOLE]])], claude, COMPONENTS.filter((c) => c.id !== CONSOLE))).toEqual([])
  })
})

// The decision #1669 rests on: alerts, fallback, Score, the monthly archive and AI analysis never see a
// reference incident. They read `incidents`; this pins that no worker module but the producer
// (services.ts), its type (types.ts) and operator suppression reads the new field.
describe('#1669 referenceIncidents has no counting reader in the worker', () => {
  it('is referenced only by services.ts, types.ts and suppression.ts', () => {
    const dir = join(__dirname, '..')
    const readers = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes('referenceIncidents'))
      .sort()
    expect(readers).toEqual(['services.ts', 'suppression.ts', 'types.ts'])
  })
})

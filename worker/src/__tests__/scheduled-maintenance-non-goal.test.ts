import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, maintenanceScopeFor, SERVICES } from '../services'
import { calculateAIWatchScore } from '../score'
import type { ServiceConfig, ServiceStatus } from '../types'

// #1405 — a window is shown, and changes nothing else. status.bfl.ml as read 2026-11-03: its API
// components and one `scheduled` window (2026-11-04 04:00–10:00Z) naming both of them.

const cfg = (id: string) => SERVICES.find((s) => s.id === id) as ServiceConfig
const NOW = Date.parse('2026-11-03T12:00:00Z')
const API = 'ws9rrzk6n2j7'
const API_EU = 'cw5sckn8002d'

const component = (id: string, name: string, status: string) => ({
  id, name, status, created_at: '2025-01-01T00:00:00.000Z', updated_at: '2026-11-03T00:00:00.000Z',
  position: 1, description: null, showcase: true, start_date: '2025-01-01', group_id: null,
  page_id: 'bfl', group: false, only_show_if_degraded: false,
})

const BFL_NOTE = 'DC team carries out work targeting storage reliability improvements, no downtime is expected, there can be occasional latency spikes.'

const WINDOW = {
  id: 'd6t9c8tqbz25', name: 'EU cluster storage maintenance', status: 'scheduled',
  scheduled_for: '2026-11-04T04:00:00.000Z', scheduled_until: '2026-11-04T10:00:00.000Z',
  components: [{ id: API, name: 'API (api.bfl.ai)' }, { id: API_EU, name: 'API EU (api.eu.bfl.ai)' }],
  incident_updates: [{ body: BFL_NOTE, created_at: '2026-10-30T12:38:59.940Z' }],
}

// 31 days of uptime record with a 2h major outage on the API three days ago, so `uptime30d` and the
// impact calendar carry a value that a leak into either would move.
const uptimeHtml = () => {
  const days = (id: string) => Array.from({ length: 31 }, (_, i) => {
    const date = new Date(NOW - (30 - i) * 86_400_000).toISOString().slice(0, 10)
    return { date, outages: { m: id === API && i === 27 ? 7200 : 0, p: 0 } }
  })
  const timelines = { [API]: { days: days(API) }, [API_EU]: { days: days(API_EU) } }
  return `<html><script>window.uptimeData = ${JSON.stringify(timelines)};\nvar uptimeData = window.uptimeData;</script></html>`
}

const read = (config: ServiceConfig, components: unknown[], maintenances: unknown[]): Promise<ServiceStatus> => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  return fetchService(config, {
    summary: { status: { indicator: 'none', description: 'All Systems Operational' }, components, incidents: [], scheduled_maintenances: maintenances },
    incidents: { incidents: [] },
    uptimeHtml: uptimeHtml(),
  } as never, undefined, {})
}

const verdict = (s: ServiceStatus) => {
  const { lastChecked: _l, scheduledMaintenances: _m, ...rest } = s
  return { ...rest, aiwatchScore: calculateAIWatchScore(s, 30, { kind: 'unsupported' }) }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('#1405 scheduled maintenance changes no verdict', () => {
  for (const componentStatus of ['operational', 'under_maintenance']) {
    it(`status, uptime, calendar and Score are equal with and without the window (components ${componentStatus})`, async () => {
      const components = [component(API, 'API (api.bfl.ai)', componentStatus), component(API_EU, 'API EU (api.eu.bfl.ai)', componentStatus)]
      const withWindow = await read(cfg('bfl'), components, [WINDOW])
      const without = await read(cfg('bfl'), components, [])
      expect(withWindow.scheduledMaintenances).toEqual([{
        id: 'd6t9c8tqbz25', title: 'EU cluster storage maintenance',
        scheduledFor: '2026-11-04T04:00:00.000Z', scheduledUntil: '2026-11-04T10:00:00.000Z',
        componentNames: ['API (api.bfl.ai)', 'API EU (api.eu.bfl.ai)'], description: BFL_NOTE,
      }])
      expect(without.scheduledMaintenances).toBeUndefined()
      expect(without.uptime30d).toBeLessThan(100)
      expect(Object.keys(without.dailyImpact ?? {})).not.toHaveLength(0)
      expect(verdict(withWindow)).toEqual(verdict(without))
    })
  }
})

describe('#1405 a window on a shared page shows only on the service it names', () => {
  // status.claude.com, shared by claude / claudeai / claudecode; the window names claude.ai only.
  const CLAUDE_AI = 'rwppv331jlwc'
  const components = [
    component('k8w3r06qmzrp', 'Claude API', 'operational'),
    component(CLAUDE_AI, 'claude.ai', 'operational'),
    component('yyzkbfz2thpt', 'Claude Code', 'operational'),
  ]
  const window = { ...WINDOW, id: 'claude-ai-mw', components: [{ id: CLAUDE_AI, name: 'claude.ai' }] }

  it('claude.ai carries it; Claude API and Claude Code do not', async () => {
    expect((await read(cfg('claudeai'), components, [window])).scheduledMaintenances).toHaveLength(1)
    expect((await read(cfg('claude'), components, [window])).scheduledMaintenances).toBeUndefined()
    expect((await read(cfg('claudecode'), components, [window])).scheduledMaintenances).toBeUndefined()
  })
})

describe('#1405 maintenanceScopeFor', () => {
  it('is empty for a service alone on its page, so a window on another of its components still shows', () => {
    expect(maintenanceScopeFor(cfg('groq'))).toEqual([])
    expect(maintenanceScopeFor(cfg('bfl'))).toEqual([])
  })

  it('is the badge scope for a service sharing its page', () => {
    expect(maintenanceScopeFor(cfg('claude'))).toEqual(['k8w3r06qmzrp'])
    expect(maintenanceScopeFor(cfg('codex'))).toContain('01KMP3KP5MGE23B80K1EK4S8PV')
    expect(maintenanceScopeFor(cfg('codex'))).not.toContain('01JMXBNJXGV1T5GT2M9XA83XNG')
  })
})

const fixture = (name: string) => readFileSync(join(__dirname, '../parsers/__tests__/fixtures', name), 'utf8')
const routeFetch = (routes: Array<[string, () => string]>) => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    const hit = routes.find(([suffix]) => url.endsWith(suffix))
    return new Response(hit ? hit[1]() : '', { status: 200 })
  }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
}

describe('#1405 every source path publishes its window and changes no verdict', () => {
  it('a page-wide window on a shared page shows on every service reading it', async () => {
    const components = [component('k8w3r06qmzrp', 'Claude API', 'operational'), component('rwppv331jlwc', 'claude.ai', 'operational')]
    const pageWide = { ...WINDOW, id: 'page-wide', components: [] }
    for (const id of ['claude', 'claudeai', 'claudecode']) {
      expect((await read(cfg(id), components, [pageWide])).scheduledMaintenances).toHaveLength(1)
    }
  })

  it('Datadog (openrouter): the live record, in progress, tagged to Chat', async () => {
    const page = JSON.parse(fixture('openrouter-datadog-2026-09-15.json'))
    const live = JSON.parse(fixture('openrouter-datadog-maintenance-2026-11-03.json')).maintenances
    const doc = (maintenances: unknown) => () => JSON.stringify({ ...page, maintenances })
    vi.useFakeTimers({ now: Date.parse('2026-11-01T21:30:00Z'), toFake: ['Date'] })
    const inProgress = (componentsAffected?: unknown) => live.map((m: object) => ({ ...m, currentStatus: 'in_progress', ...(componentsAffected ? { componentsAffected } : {}) }))
    routeFetch([['/config.json', doc(inProgress([{ id: '9fb5ccff-e128-455a-be20-59572f8d363a', name: 'Chat (/api/v1/chat/completions)' }]))]])
    const withWindow = await fetchService(cfg('openrouter'), undefined, undefined, {})
    routeFetch([['/config.json', doc(null)]])
    const without = await fetchService(cfg('openrouter'), undefined, undefined, {})
    expect(withWindow.scheduledMaintenances?.map((m) => m.scheduledUntil)).toEqual(['2026-11-01T22:00:00.000Z'])
    expect(without.scheduledMaintenances).toBeUndefined()
    expect(verdict(withWindow)).toEqual(verdict(without))
  })

  it('Better Stack (helicone): an announced maintenance report', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-03T12:00:00Z'), toFake: ['Date'] })
    const index = (reports: unknown[]) => () => JSON.stringify({
      data: { attributes: { aggregate_state: 'operational', timezone: 'UTC' } },
      included: [
        { type: 'status_page_section', id: '1', attributes: { name: 'API' } },
        { type: 'status_page_resource', id: '10', attributes: { public_name: 'API', status: 'operational', availability: 1, status_page_section_id: '1', status_history: [] } },
        ...reports,
      ],
    })
    const report = { type: 'status_report', id: '77', attributes: { report_type: 'maintenance', title: 'Gateway upgrade', starts_at: '2026-11-04T01:00:00.000Z', ends_at: '2026-11-04T02:00:00.000Z', aggregate_state: 'maintenance', affected_resources: [] } }
    const feed = () => '<?xml version="1.0"?><rss version="2.0"><channel><title>Incidents</title></channel></rss>'
    routeFetch([['/index.json', index([report])], ['/feed', feed]])
    const withWindow = await fetchService(cfg('helicone'), undefined, undefined, {})
    routeFetch([['/index.json', index([])], ['/feed', feed]])
    const without = await fetchService(cfg('helicone'), undefined, undefined, {})
    expect(withWindow.scheduledMaintenances?.map((m) => m.title)).toEqual(['Gateway upgrade'])
    expect(without.scheduledMaintenances).toBeUndefined()
    expect(verdict(withWindow)).toEqual(verdict(without))
  })

  it('incident.io (groq): publishes the window read from the captured page', async () => {
    vi.useFakeTimers({ now: Date.parse('2025-11-02T00:00:00Z'), toFake: ['Date'] })
    routeFetch([])
    const html = fixture('groq-page-2026-09-29.html')
    const prefetch = (uptimeHtml: string) => ({
      summary: { status: { indicator: 'none', description: 'All Systems Operational' }, components: [component('01K053E2FAKWKEYHXEV7WAHJBM', 'API', 'operational')], incidents: [] },
      incidents: { incidents: [] },
      uptimeHtml,
    }) as never
    const withWindow = await fetchService(cfg('groq'), prefetch(html), undefined, {})
    expect(withWindow.scheduledMaintenances?.map((m) => m.id)).toEqual(['incidentio:01K8BQGTR04CGHB0Y254CSPX90'])
  })

  it('incident.io shared page (status.openai.com): a Codex-only window shows on Codex, not ChatGPT or OpenAI API', async () => {
    vi.useFakeTimers({ now: Date.parse('2025-11-02T00:00:00Z'), toFake: ['Date'] })
    routeFetch([])
    const CODEX = '01KMP3KP5MGE23B80K1EK4S8PV'
    const html = fixture('groq-page-2026-09-29.html').replaceAll('01K6Y7AE9BSWJ2SGHJT92HG53X', CODEX)
    const prefetch = () => ({
      summary: { status: { indicator: 'none', description: 'All Systems Operational' }, components: [component(CODEX, 'Codex', 'operational')], incidents: [] },
      incidents: { incidents: [] },
      uptimeHtml: html,
    }) as never
    expect((await fetchService(cfg('codex'), prefetch(), undefined, {})).scheduledMaintenances).toHaveLength(1)
    expect((await fetchService(cfg('chatgpt'), prefetch(), undefined, {})).scheduledMaintenances).toBeUndefined()
    expect((await fetchService(cfg('openai'), prefetch(), undefined, {})).scheduledMaintenances).toBeUndefined()
  })
})

describe('#1405 a window naming only a reference component is not a service window', () => {
  it('Datadog (openrouter): the live record names only Web & Application Services, so it is not shown', async () => {
    const page = JSON.parse(fixture('openrouter-datadog-2026-09-15.json'))
    const live = JSON.parse(fixture('openrouter-datadog-maintenance-2026-11-03.json')).maintenances
    expect(live.flatMap((m: { componentsAffected: Array<{ name: string }> }) => m.componentsAffected.map((c) => c.name))).toEqual(['Web & Application Services'])
    vi.useFakeTimers({ now: Date.parse('2026-11-01T21:30:00Z'), toFake: ['Date'] })
    routeFetch([['/config.json', () => JSON.stringify({ ...page, maintenances: live.map((m: object) => ({ ...m, currentStatus: 'in_progress' })) })]])
    expect((await fetchService(cfg('openrouter'), undefined, undefined, {})).scheduledMaintenances).toBeUndefined()
  })

  it('Statuspage (cerebras): a Console-only window is dropped, one that also names the service is kept', async () => {
    const REF = cfg('cerebras').referenceComponentIds![0]
    const components = [component('svc', 'Inference API', 'operational'), component(REF, 'Cloud Console', 'operational')]
    const consoleOnly = { ...WINDOW, id: 'console-only', components: [{ id: REF, name: 'Cloud Console' }] }
    const both = { ...WINDOW, id: 'both', components: [{ id: REF, name: 'Cloud Console' }, { id: 'svc', name: 'Inference API' }] }
    expect((await read(cfg('cerebras'), components, [consoleOnly])).scheduledMaintenances).toBeUndefined()
    expect((await read(cfg('cerebras'), components, [consoleOnly, both])).scheduledMaintenances?.map((m) => m.id)).toEqual(['both'])
  })
})

describe('#1405 an incident.io page is read from its page whatever the config names it', () => {
  it('turbopuffer (no incidentIoBaseUrl): the window comes from the page, since its summary carries none', async () => {
    vi.useFakeTimers({ now: Date.parse('2025-11-02T00:00:00Z'), toFake: ['Date'] })
    routeFetch([])
    expect(cfg('turbopuffer').incidentIoBaseUrl).toBeUndefined()
    const html = fixture('groq-page-2026-09-29.html')
    const prefetch = { summary: { status: { indicator: 'none', description: 'All Systems Operational' }, components: [component([cfg('turbopuffer').incidentIoComponentId!].flat()[0], 'API', 'operational')], incidents: [] }, incidents: { incidents: [] }, uptimeHtml: html } as never
    expect((await fetchService(cfg('turbopuffer'), prefetch, undefined, {})).scheduledMaintenances?.map((m) => m.id)).toEqual(['incidentio:01K8BQGTR04CGHB0Y254CSPX90'])
  })
})

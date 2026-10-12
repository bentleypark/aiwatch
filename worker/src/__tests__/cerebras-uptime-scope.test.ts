import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, fetchAllServices, resolveSvcStatus, badgeGroupNames, uptimeScopeOf, SERVICES } from '../services'
import { TEST_TIMEOUT_MS, mockKV } from './helpers/unreadable-source'
import { lazyPage, ninetyDays } from './helpers/lazy-status-page'

// #1679 — Cerebras's uptime and badge were measured on its Developer Console. Real ids/names from
// status.cerebras.ai summary.json (2026-10-12).
const GPT_OSS = 'hgfykfsb36gn'
const CONSOLE = '83h1cchw4vs4'
const QWEN = 's9j1yrfjvn64'
const COMPONENTS = [
  { id: GPT_OSS, name: 'GPT-OSS-120B', status: 'operational' },
  { id: CONSOLE, name: 'Developer Console', status: 'operational' },
  { id: QWEN, name: 'Qwen-3.8-27b', status: 'operational' },
]

const NOW = Date.parse('2026-10-12T12:00:00Z')
const FULL_DAY = 86400
const days = (outageSec: number) => {
  const out: Array<{ date: string; outages: { m: number; p: number } }> = []
  for (let i = 30; i >= 0; i--) {
    out.push({ date: new Date(NOW - i * 86400_000).toISOString().slice(0, 10), outages: { m: i === 0 ? outageSec : 0, p: 0 } })
  }
  return out
}
const timelines = (outageOn: string) =>
  Object.fromEntries(COMPONENTS.map((c) => [c.id, { days: days(c.id === outageOn ? FULL_DAY : 0) }]))
const inlineBlob = (t: Record<string, unknown>) =>
  `<html><script>window.uptimeData = ${JSON.stringify(t)};\nvar uptimeData = window.uptimeData;</script></html>`

const cerebras = SERVICES.find((s) => s.id === 'cerebras')!

const run = async (prefetchExtra: Record<string, unknown>) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.setSystemTime(NOW)
  return fetchService(cerebras, {
    summary: { status: { indicator: 'none', description: 'All Systems Operational' }, components: COMPONENTS, incidents: [] },
    incidents: { incidents: [] },
    ...prefetchExtra,
  } as never, undefined, {} as never)
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('#1679 — Cerebras uptime is the worst-of its live models, not its Developer Console', () => {
  for (const [transport, extra] of [
    ['showcase timelines', (o: string) => ({ uptimeTimelines: timelines(o) })],
    ['inline uptimeData', (o: string) => ({ uptimeHtml: inlineBlob(timelines(o)) })],
  ] as const) {
    it(`an outage on a model moves uptime — ${transport}`, async () => {
      const svc = await run(extra(QWEN))
      expect(svc.uptime30d).toBeLessThan(100)
    })
    it(`an outage on the Developer Console alone does not — ${transport}`, async () => {
      const svc = await run(extra(CONSOLE))
      expect(svc.uptime30d).toBe(100)
    })
  }

  it('the scope follows the live page: a model the config never named is in it', () => {
    expect(uptimeScopeOf(cerebras, COMPONENTS)).toEqual([GPT_OSS, QWEN])
  })

  it('a Developer Console-only incident is a reference incident, active or resolved — never counted', async () => {
    for (const [status, resolvedAt] of [['investigating', null], ['resolved', '2026-10-12T11:00:00Z']] as const) {
      const consoleOnly = {
        id: `con-${status}`, name: 'Elevated errors on the Developer Console', status, impact: 'major',
        created_at: '2026-10-12T10:00:00Z', resolved_at: resolvedAt, incident_updates: [],
        components: [{ id: CONSOLE, name: 'Developer Console', status: status === 'resolved' ? 'operational' : 'major_outage' }],
      }
      const svc = await run({ incidents: { incidents: [consoleOnly] } })
      expect(svc.incidents.map((i) => i.id)).not.toContain(`con-${status}`)
      expect(svc.referenceIncidents?.map((i) => i.id)).toEqual([`con-${status}`])
      expect(svc.components?.map((c) => c.name)).toEqual(['GPT-OSS-120B', 'Qwen-3.8-27b'])
    }
  })

  it('the badge keep-group is the same live components the badge reads — no console, no group header', () => {
    const withHeader = [...COMPONENTS, { id: 'grp', name: 'Models', group: true }]
    expect([...badgeGroupNames(cerebras, withHeader)]).toEqual(['gpt-oss-120b', 'qwen-3.8-27b'])
  })

  it('a Developer Console outage does not move the badge', () => {
    const summary = { status: { indicator: 'minor' }, components: COMPONENTS.map((c) => c.id === CONSOLE ? { ...c, status: 'major_outage' } : c) }
    expect(resolveSvcStatus(cerebras, summary, [])).toBe('operational')
  })

  const NEW_MODEL = { id: 'newmodel1234', name: 'New-Model', status: 'operational' }
  for (const viaComponentsJson of [false, true]) {
    it(`fetchAllServices asks the lazy page's showcase for the live models and publishes their uptime${viaComponentsJson ? ' — components.json lists a model summary.json omits' : ''}`, async () => {
      const PAGE = 'https://status.cerebras.ai'
      const seen: string[] = []
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const days = ninetyDays(new Date().toISOString().slice(0, 10))
      const live = viaComponentsJson ? [GPT_OSS, QWEN, NEW_MODEL.id] : [GPT_OSS, QWEN]
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
        const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
        if (url.startsWith(PAGE) && url.includes('/uptime_showcase')) {
          seen.push(decodeURIComponent(url))
          return json({ timelines: Object.fromEntries(live.map((c) => [c, { component: { code: c }, days }])) })
        }
        if (url.startsWith(`${PAGE}/api/v2/summary.json`)) {
          return json({ status: { indicator: 'none', description: 'All Systems Operational' }, components: COMPONENTS, incidents: [], scheduled_maintenances: [] })
        }
        if (url.startsWith(`${PAGE}/api/v2/components.json`)) return json({ components: [...COMPONENTS, NEW_MODEL] })
        if (url.startsWith(`${PAGE}/api/v2/incidents.json`)) return json({ incidents: [] })
        if (url === PAGE || url === `${PAGE}/`) {
          return new Response(lazyPage([...COMPONENTS, NEW_MODEL].map((c) => c.id)), { status: 200, headers: { 'Content-Type': 'text/html' } })
        }
        return json({ status: { indicator: 'none' }, components: [], incidents: [] })
      }))
      if (viaComponentsJson) cerebras.componentsUrl = `${PAGE}/api/v2/components.json`
      try {
        const { raw } = await fetchAllServices(mockKV() as unknown as KVNamespace, [])

        expect(seen).toHaveLength(1)
        for (const id of live) expect(seen[0]).toContain(id)
        expect(seen[0]).not.toContain(CONSOLE)
        expect(raw.find((s) => s.id === 'cerebras')?.uptime30d).not.toBeNull()
      } finally {
        delete cerebras.componentsUrl
      }
    }, TEST_TIMEOUT_MS)
  }
})

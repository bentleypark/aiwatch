import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, fetchAllServices, SERVICES, uptimeScopeOf, uptimeScopeForPage } from '../services'
import type { ServiceConfig } from '../types'
import { mockKV, HEALTHY_SUMMARY } from './helpers/unreadable-source'
import { lazyPage } from './helpers/lazy-status-page'

const NOW = Date.parse('2026-09-16T12:00:00Z')
const FULL_DAY = 86400

/** 31 days ending at NOW; the last one carries `outageSec` of major outage. */
const days = (outageSec: number) => {
  const out: Array<{ date: string; outages: { m: number; p: number } }> = []
  for (let i = 30; i >= 0; i--) {
    out.push({
      date: new Date(NOW - i * 86400_000).toISOString().slice(0, 10),
      outages: { m: i === 0 ? outageSec : 0, p: 0 },
    })
  }
  return out
}

const timelines = (keys: readonly string[], outageOn: readonly string[]) =>
  Object.fromEntries(keys.map((id) => [id, { days: days(outageOn.includes(id) ? FULL_DAY : 0) }]))

const inlineBlob = (t: Record<string, unknown>) =>
  `<html><script>window.uptimeData = ${JSON.stringify(t)};\nvar uptimeData = window.uptimeData;</script></html>`

const run = async (config: ServiceConfig, prefetchExtra: Record<string, unknown>) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.setSystemTime(NOW)
  return fetchService(config, {
    summary: { status: { indicator: 'none', description: 'All Systems Operational' }, components: [], incidents: [] },
    incidents: { incidents: [] },
    latency: 100,
    ...prefetchExtra,
  } as never, undefined, {} as never)
}

/** Both legs of the ternary at the Atlassian call site, so neither can drift alone. */
const onBothTransports = (
  name: string,
  config: ServiceConfig,
  keys: readonly string[],
  outageOn: readonly string[],
  expected: (uptime: number) => void,
) => {
  it(`${name} — showcase timelines`, async () => {
    const svc = await run(config, { uptimeTimelines: timelines(keys, outageOn) })
    expect(svc.uptime30d).not.toBeNull()
    expected(svc.uptime30d!)
  })
  it(`${name} — inline uptimeData`, async () => {
    const svc = await run(config, { uptimeHtml: inlineBlob(timelines(keys, outageOn)) })
    expect(svc.uptime30d).not.toBeNull()
    expected(svc.uptime30d!)
  })
}

const atlassian = (SERVICES as ServiceConfig[]).filter((s) => s.apiUrl && !s.incidentIoBaseUrl)

/** Every service whose uptime scope spans more than one component, derived — not a list to maintain. */
const MULTI = atlassian.filter((s) => uptimeScopeOf(s).length > 1)

/** Every service carrying page components the badge scope excludes. */
const WITH_OFF_SCOPE = atlassian
  .map((s) => ({ s, off: (s.displayComponentIds ?? []).filter((id) => !uptimeScopeOf(s).includes(id)) }))
  .filter(({ off }) => off.length > 0)

/** Every service sharing a status page with siblings, whose timelines therefore arrive as a page union. */
const SHARED_PAGE = (() => {
  const byPage = new Map<string, ServiceConfig[]>()
  for (const s of atlassian) {
    if (uptimeScopeOf(s).length === 0) continue
    byPage.set(s.apiUrl!, [...(byPage.get(s.apiUrl!) ?? []), s])
  }
  return [...byPage.values()].filter((v) => v.length > 1)
})()

describe('#1435 — the Atlassian uptime figure is computed over the SERVICE badge scope', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('the derived fixture sets are not vacuous', () => {
    expect(MULTI.length).toBeGreaterThan(1)
    expect(WITH_OFF_SCOPE.length).toBeGreaterThan(0)
    expect(SHARED_PAGE.length).toBeGreaterThan(0)
    for (const s of MULTI) expect(uptimeScopeOf(s)).toContain(s.statusComponentId)
  })

  for (const s of MULTI) {
    describe(`${s.id} — every member of its ${uptimeScopeOf(s).length}-component badge scope`, () => {
      const scope = uptimeScopeOf(s)
      for (const id of scope) {
        onBothTransports(`an outage on ${id} alone moves uptime`, s, scope, [id], (u) => expect(u).toBeLessThan(100))
      }
      onBothTransports('an all-clear scope reads exactly 100', s, scope, [], (u) => expect(u).toBe(100))
    })
  }

  describe('components the page carries but the badge scope excludes', () => {
    for (const { s, off } of WITH_OFF_SCOPE) {
      onBothTransports(`${s.id}: an outage on its display-only components does not move uptime`, s,
        [...uptimeScopeOf(s), ...off], off, (u) => expect(u).toBe(100))
    }
  })

  describe('the other reader of the scope definition — the /uptime_showcase request', () => {
    const pages = [...new Set(atlassian.filter((s) => uptimeScopeOf(s).length > 0).map((s) => s.apiUrl!))]

    it('every page is requested, not just the ones a test happens to name', () => {
      expect(pages.length).toBeGreaterThan(1)
    })

    for (const apiUrl of pages) {
      it(`${apiUrl} requests exactly the union of its services' badge scopes`, () => {
        const union = new Set(atlassian.filter((s) => s.apiUrl === apiUrl).flatMap(uptimeScopeOf))
        expect(new Set(uptimeScopeForPage(apiUrl))).toEqual(union)
      })
    }
  })

  describe('the request the prefetch actually sends — one full cycle, page served lazily', () => {
    /** Serves ONLY the codes the request asked for, so a narrowed request yields narrowed data. */
    const stubPage = (svc: ServiceConfig, outageOn: readonly string[], seen: string[]) => {
      // The page URL the prefetch derives, which is not always `config.statusUrl` (copilot's differs).
      const page = svc.apiUrl!.replace(/\/summary\.json$/, '').replace('/api/v2', '')
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
        if (url.includes('/uptime_showcase')) {
          seen.push(url)
          const asked = decodeURIComponent(new URL(url).searchParams.get('components') ?? '').split(',').filter(Boolean)
          return new Response(JSON.stringify({
            timelines: Object.fromEntries(asked.map((c) => [c, { component: { code: c }, days: days(outageOn.includes(c) ? FULL_DAY : 0) }])),
          }), { status: 200 })
        }
        if (url.startsWith(svc.apiUrl!)) {
          return new Response(JSON.stringify({
            status: { indicator: 'none', description: 'All Systems Operational' },
            components: uptimeScopeOf(svc).map((id) => ({ id, name: id, status: 'operational' })),
            incidents: [], scheduled_maintenances: [],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (url === page || url === `${page}/`) {
          return new Response(lazyPage([...uptimeScopeOf(svc)]), { status: 200, headers: { 'Content-Type': 'text/html' } })
        }
        return new Response(JSON.stringify(HEALTHY_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }))
    }

    for (const svc of MULTI) {
      const scope = uptimeScopeOf(svc)
      const last = scope[scope.length - 1]
      it(`${svc.id}: the cycle requests its whole badge scope, so an outage on ${last} is not lost`, async () => {
        const seen: string[] = []
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.setSystemTime(NOW)
        stubPage(svc, [last], seen)
        const { raw } = await fetchAllServices(mockKV() as unknown as never, [])
        expect(seen, 'the cycle sent no /uptime_showcase request at all').not.toHaveLength(0)
        const asked = decodeURIComponent(new URL(seen[0]!).searchParams.get('components') ?? '').split(',')
        expect(new Set(asked)).toEqual(new Set(scope))
        expect(raw.find((s) => s.id === svc.id)?.uptime30d).toBeLessThan(100)
      })
    }
  })

  describe('a sibling service on the same status page', () => {
    for (const group of SHARED_PAGE) {
      for (const s of group) {
        const siblingOnly = group.filter((o) => o.id !== s.id).flatMap(uptimeScopeOf)
        onBothTransports(`${s.id}: an outage on a sibling's components does not move uptime`, s,
          group.flatMap(uptimeScopeOf), siblingOnly, (u) => expect(u).toBe(100))
      }
    }
  })
})

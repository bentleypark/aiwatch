import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildIncidentIoProxyHtml, fetchIncidentIoProxyHtml, incidentIoProxyUrls } from '../parsers/incident-io-proxy'
import { parseIncidentIoGlobalPage, parseIncidentIoImpacts, parseIncidentIoAllComponentUptimes } from '../parsers/incident-io'
import { fetchService, fetchPrefetchHtml, fetchRosterAuditHtml, SERVICES } from '../services'
import { createFetchTracker } from '../utils'
import type { ServiceConfig } from '../types'

// Real responses captured from status.elevenlabs.io/proxy on 2026-10-22 (#1752); the incident feed is
// 7 of the 26 (the first 6, plus the one carrying a quoted message). Nothing here is hand-shaped except
// where a test says so.
const fx = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/elevenlabs-proxy-2026-10-22/${name}.json`, import.meta.url)), 'utf8'))
const summary = () => fx('summary')
const impacts = () => fx('component_impacts')
const feed = () => fx('incidents')

const el = SERVICES.find((s) => s.id === 'elevenlabs') as ServiceConfig
const NOW = new Date('2026-10-22T02:00:00Z')

const structureIds = (): Map<string, { name: string; group: string | null }> => {
  const out = new Map<string, { name: string; group: string | null }>()
  for (const item of summary().summary.structure.items) {
    if (item.group) for (const c of item.group.components) out.set(c.component_id, { name: c.name, group: item.group.name })
    else out.set(item.component.component_id, { name: item.component.name, group: null })
  }
  return out
}

describe('#1752 — rendering the /proxy payloads back into page RSC', () => {
  it('the captured fixture is not vacuous: 11 components, impacts and uptimes present', () => {
    expect(structureIds().size).toBe(11)
    expect(impacts().component_impacts.length).toBeGreaterThan(0)
    expect(impacts().component_uptimes.length).toBeGreaterThan(0)
  })

  it('the existing page parsers read what the page root used to embed', () => {
    const html = buildIncidentIoProxyHtml(summary(), impacts(), feed())!
    expect(html).not.toBeNull()
    expect(parseIncidentIoImpacts(html)).toHaveLength(impacts().component_impacts.length)
    const uptimeIds = parseIncidentIoAllComponentUptimes(html).map((e) => e.id)
    expect(new Set(uptimeIds)).toEqual(new Set(structureIds().keys()))
  })

  it('a page that does not carry component_uptimes is not rebuilt, whatever else it carries', () => {
    const html = buildIncidentIoProxyHtml(summary(), impacts(), feed())!
    expect(parseIncidentIoGlobalPage(html)).not.toBeNull()
    expect(parseIncidentIoGlobalPage(html.replace('component_uptimes', 'component_uptime_x'))).toBeNull()
  })

  it('incidents that only incident_links carries are kept', () => {
    const f = feed()
    const inFeed = new Set(f.incidents.map((i: { id: string }) => i.id))
    const linkOnly = impacts().incident_links.filter((l: { id: string }) => !inFeed.has(l.id))
    expect(linkOnly.length).toBeGreaterThan(0)
    const ids = new Set(parseIncidentIoGlobalPage(buildIncidentIoProxyHtml(summary(), impacts(), f)!)!.incidents!.map((i) => i.id))
    for (const l of linkOnly) expect(ids.has(l.id), l.id).toBe(true)
  })

  it('the global-page rebuild lists group members, and both "Other APIs" stay distinct', () => {
    const rebuilt = parseIncidentIoGlobalPage(buildIncidentIoProxyHtml(summary(), impacts(), feed())!)!
    expect(rebuilt.components).toHaveLength(11)
    const others = rebuilt.components!.filter((c) => c.name === 'Other APIs')
    expect(others.map((c) => c.id).sort()).toEqual(['01M52E4R81RBEYD94QJACM67BQ', '01M52EBPDWQ9E2DJR8DJ7YT767'])
    expect(rebuilt.components!.every((c) => c.status === 'operational')).toBe(true)
    expect(rebuilt.status.indicator).toBe('none')
  })

  it('rebuilt incidents come out ongoing first, then newest first', () => {
    const f = feed()
    const active = f.incidents[3]
    active.status = 'investigating'
    active.affected_components = [{ component_id: '01M52E6REJ3EKRW049FBMB41JC', status: 'partial_outage', current_status: 'partial_outage' }]
    const list = parseIncidentIoGlobalPage(buildIncidentIoProxyHtml(summary(), impacts(), f)!)!.incidents!
    expect(list[0].id).toBe(active.id)
    const rest = list.slice(1).map((i) => i.created_at)
    expect(rest).toEqual([...rest].sort((a, b) => Date.parse(b) - Date.parse(a)))
    expect(new Set(rest).size).toBeGreaterThan(1)
  })

  it('an incident whose record is inverted on the page takes its window from the impact records', () => {
    const rebuilt = parseIncidentIoGlobalPage(buildIncidentIoProxyHtml(summary(), impacts(), feed())!)!
    const ivc = rebuilt.incidents!.find((i) => i.name === 'Instant Voice Clone creation failures')!
    expect(ivc).toBeDefined()
    expect(Date.parse(ivc.resolved_at!)).toBeGreaterThan(Date.parse(ivc.created_at))
  })

  it('an incident message containing quotes and backslashes survives, as the live feed had one', () => {
    const f = feed()
    f.incidents[0].updates[0].message_string = 'error: "START node" failed\\path \u00e9 done'
    const rebuilt = parseIncidentIoGlobalPage(buildIncidentIoProxyHtml(summary(), impacts(), f)!)!
    expect(rebuilt).not.toBeNull()
    const bodies = rebuilt.incidents!.flatMap((i) => (i.incident_updates ?? []).map((u) => u.body))
    expect(bodies).toContain('error: "START node" failed\\path \u00e9 done')
  })

  it('the real quote-bearing incident from the live feed rebuilds', () => {
    const rebuilt = parseIncidentIoGlobalPage(buildIncidentIoProxyHtml(summary(), impacts(), feed())!)!
    const bodies = rebuilt.incidents!.flatMap((i) => (i.incident_updates ?? []).map((u) => u.body))
    expect(bodies.some((b) => b.includes('"START node generated a response after progressing"'))).toBe(true)
  })

  // Each mutation is applied to a copy of the real payload; the unmutated control above builds.
  const mutations: Array<[string, () => [unknown, unknown, unknown]]> = [
    ['summary without a structure', () => { const s = summary(); delete s.summary.structure; return [s, impacts(), feed()] }],
    ['summary that is an error envelope', () => [{ message: 'Not Found' }, impacts(), feed()]],
    ['impacts without component_uptimes', () => { const i = impacts(); delete i.component_uptimes; return [summary(), i, feed()] }],
    ['impacts without component_impacts', () => { const i = impacts(); delete i.component_impacts; return [summary(), i, feed()] }],
    ['incident_links that is not an array', () => { const i = impacts(); i.incident_links = {}; return [summary(), i, feed()] }],
    ['feed without incidents', () => [summary(), impacts(), {}]],
  ]
  for (const [name, make] of mutations) {
    it(`is withheld for ${name}`, () => {
      expect(buildIncidentIoProxyHtml(...make())).toBeNull()
    })
  }

  it('a missing incident_links is read as none, not as a failure', () => {
    const i = impacts(); delete i.incident_links
    expect(buildIncidentIoProxyHtml(summary(), i, feed())).not.toBeNull()
  })
})

describe('#1752 — fetching the /proxy payloads', () => {
  const urls = incidentIoProxyUrls('https://status.elevenlabs.io', NOW.getTime())
  const serve = (over: Partial<Record<'summary' | 'impacts' | 'feed', () => Response>> = {}) => vi.fn(async (u: string) => {
    if (u === urls.summary) return (over.summary ?? (() => Response.json(summary())))()
    if (u === urls.impacts) return (over.impacts ?? (() => Response.json(impacts())))()
    if (u === urls.feed) return (over.feed ?? (() => Response.json(feed())))()
    throw new Error(`unexpected url ${u}`)
  })
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  it('asks the page host for the 90 days the page draws', () => {
    expect(urls.summary).toBe('https://status.elevenlabs.io/proxy/status.elevenlabs.io')
    expect(urls.feed).toBe('https://status.elevenlabs.io/proxy/status.elevenlabs.io/incidents')
    expect(urls.impacts).toBe('https://status.elevenlabs.io/proxy/status.elevenlabs.io/component_impacts?start_at=2026-07-24T02:00:00Z&end_at=2026-10-22T02:00:00Z')
  })

  it('builds the page from all three endpoints', async () => {
    const f = serve()
    expect(await fetchIncidentIoProxyHtml('https://status.elevenlabs.io', f, NOW.getTime())).not.toBeNull()
    expect(f).toHaveBeenCalledTimes(3)
  })

  for (const which of ['summary', 'impacts', 'feed'] as const) {
    it(`is withheld when the ${which} endpoint answers HTTP 503`, async () => {
      const f = serve({ [which]: () => new Response('down', { status: 503 }) })
      expect(await fetchIncidentIoProxyHtml('https://status.elevenlabs.io', f, NOW.getTime())).toBeNull()
    })
    it(`is withheld when the ${which} endpoint answers 200 with a non-JSON body`, async () => {
      const f = serve({ [which]: () => new Response('<html>challenge</html>', { status: 200 }) })
      expect(await fetchIncidentIoProxyHtml('https://status.elevenlabs.io', f, NOW.getTime())).toBeNull()
    })
  }

  it('is withheld when a fetch throws', async () => {
    const f = vi.fn(async () => { throw new Error('timeout') })
    expect(await fetchIncidentIoProxyHtml('https://status.elevenlabs.io', f, NOW.getTime())).toBeNull()
  })
})

describe('#1752 — which HTML the prefetch hands the page', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('reads the /proxy endpoints for a proxy page and never its root HTML', async () => {
    const f = vi.fn(async (u: string) => {
      if (u.endsWith('/component_impacts') || u.includes('/component_impacts?')) return Response.json(impacts())
      if (u.endsWith('/incidents')) return Response.json(feed())
      if (u === 'https://status.elevenlabs.io/proxy/status.elevenlabs.io') return Response.json(summary())
      return new Response('<html>root</html>', { status: 200 })
    })
    vi.stubGlobal('fetch', f)
    const html = await fetchPrefetchHtml(el.statusUrl, createFetchTracker())
    const urls = f.mock.calls.map((c) => String(c[0]))
    expect(urls).toHaveLength(3)
    expect(urls.every((u) => u.includes('/proxy/status.elevenlabs.io'))).toBe(true)
    expect(parseIncidentIoImpacts(html!)).toHaveLength(impacts().component_impacts.length)
  })

  it('reads the root HTML for any other page', async () => {
    const groq = SERVICES.find((s) => s.id === 'groq') as ServiceConfig
    expect(groq.incidentIoProxy).toBeUndefined()
    const f = vi.fn(async (_url: string) => new Response('<html>root</html>', { status: 200 }))
    vi.stubGlobal('fetch', f)
    expect(await fetchPrefetchHtml(groq.statusUrl, createFetchTracker())).toBe('<html>root</html>')
    expect(f).toHaveBeenCalledTimes(1)
    expect(String(f.mock.calls[0][0])).toBe(groq.statusUrl)
  })
})

describe('#1752 — which HTML the roster audit reads', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('reads the /proxy endpoints for a proxy page, and the audit finds its eleven components there', async () => {
    const f = vi.fn(async (u: string) => {
      if (u.includes('/component_impacts?')) return Response.json(impacts())
      if (u.endsWith('/incidents')) return Response.json(feed())
      if (u === 'https://status.elevenlabs.io/proxy/status.elevenlabs.io') return Response.json(summary())
      return new Response('<html>root</html>', { status: 200 })
    })
    const html = await fetchRosterAuditHtml(el.statusUrl, f)
    expect(f.mock.calls.every((c) => String(c[0]).includes('/proxy/status.elevenlabs.io'))).toBe(true)
    expect(parseIncidentIoAllComponentUptimes(html!).filter((e) => e.dataAvailableSince !== null)).toHaveLength(11)
  })

  it('reads the root HTML for any other page, and returns null when it answers HTTP 503', async () => {
    const groq = SERVICES.find((s) => s.id === 'groq') as ServiceConfig
    const ok = vi.fn(async (_u: string) => new Response('<html>root</html>', { status: 200 }))
    expect(await fetchRosterAuditHtml(groq.statusUrl, ok)).toBe('<html>root</html>')
    expect(ok).toHaveBeenCalledTimes(1)
    const down = vi.fn(async (_u: string) => new Response('', { status: 503 }))
    expect(await fetchRosterAuditHtml(groq.statusUrl, down)).toBeNull()
  })
})

describe('#1752 — ElevenLabs config against the captured page', () => {
  it('opts into the proxy source and the global-page rebuild together', () => {
    expect(el.incidentIoProxy).toBe(true)
    expect(el.incidentIoGlobalPage).toBe(true)
    for (const s of SERVICES.filter((x) => x.incidentIoProxy)) expect(s.incidentIoGlobalPage, s.id).toBe(true)
  })

  it('every in-scope component carries the label of the group the page puts it in', () => {
    const page = structureIds()
    const scope = el.statusComponentIds as string[]
    expect(Object.keys(el.componentGroups ?? {}).sort()).toEqual([...scope].sort())
    for (const id of scope) expect(el.componentGroups![id], id).toBe(page.get(id)!.group)
  })

  it('every configured id exists on the page, and the scope plus the audit exclusions are the whole page', () => {
    const page = structureIds()
    const scope = el.statusComponentIds as string[]
    for (const id of [...scope, ...(el.rosterAuditExclude ?? []), el.incidentIoComponentId as string]) expect(page.has(id), id).toBe(true)
    expect(new Set([...scope, ...(el.rosterAuditExclude ?? [])])).toEqual(new Set(page.keys()))
  })

  it('the scope is the product surfaces of all three groups, "Other APIs" of both ElevenAPI and ElevenAgents included', () => {
    const page = structureIds()
    const named = (el.statusComponentIds as string[]).map((id) => `${page.get(id)!.group}/${page.get(id)!.name}`).sort()
    expect(named).toEqual([
      'ElevenAPI/Other APIs', 'ElevenAPI/Speech to Text', 'ElevenAPI/Text to Speech', 'ElevenAgents/Conversations', 'ElevenAgents/Other APIs',
      'ElevenAgents/RAG', 'ElevenAgents/Telephony', 'ElevenCreative/All features',
    ])
    expect(page.get(el.incidentIoComponentId as string)!.name).toBe('Text to Speech')
  })
})

describe('#1752 — fetchService on the rendered page', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  // What the compat API serves for this page today: a healthy-looking summary with no components.
  const compatSummary = { status: { indicator: 'none', description: 'All Systems Operational' }, components: [], incidents: [] }
  const run = (html: string | undefined) => fetchService(el, { summary: compatSummary, incidents: { incidents: [] }, uptimeHtml: html } as never, undefined, {} as never)
  const pageHtml = (f = feed()) => buildIncidentIoProxyHtml(summary(), impacts(), f)!

  it('publishes the grouped breakdown and a computed uptime where it published nothing', async () => {
    const svc = await run(pageHtml())
    expect(svc.status).toBe('operational')
    expect((svc.components ?? []).map((c) => `${c.group}/${c.name}`).sort()).toEqual([
      'ElevenAPI/Other APIs', 'ElevenAPI/Speech to Text', 'ElevenAPI/Text to Speech', 'ElevenAgents/Conversations', 'ElevenAgents/Other APIs',
      'ElevenAgents/RAG', 'ElevenAgents/Telephony', 'ElevenCreative/All features',
    ])
    expect(svc.uptime30d).not.toBeNull()
    expect(svc.uptimeSource).toBe('official')
  })

  it('discloses the short history the recreated page actually has', async () => {
    const svc = await run(pageHtml())
    expect(svc.uptimeWindowDays).toBe(5) // data_available_since 2026-10-16T13:44Z → 2026-10-22T02:00Z = 5.5 days, floored
  })

  it('an active incident on one surface moves the badge while the page summary still reads none', async () => {
    const f = feed()
    const active = f.incidents[0]
    const target = '01M52E6REJ3EKRW049FBMB41JC' // Telephony
    active.status = 'investigating'
    active.affected_components = [{ component_id: target, status: 'partial_outage', current_status: 'partial_outage' }]
    const svc = await run(pageHtml(f))
    expect(svc.status).not.toBe('operational')
    expect(svc.components?.find((c) => c.name === 'Telephony')?.status).not.toBe('operational')
  })

  it('reads the /proxy endpoints itself when the prefetch did not bring the page', async () => {
    const urls = incidentIoProxyUrls(el.statusUrl, NOW.getTime())
    const body: Record<string, unknown> = { [urls.summary]: summary(), [urls.impacts]: impacts(), [urls.feed]: feed() }
    const f = vi.fn(async (u: string) => (u in body ? Response.json(body[u]) : new Response('', { status: 503 })))
    vi.stubGlobal('fetch', f)
    const svc = await run(undefined)
    expect(f.mock.calls.map((c) => c[0]).sort()).toEqual([urls.feed, urls.impacts, urls.summary].sort())
    expect(svc.sourceUnknown).toBeUndefined()
    expect(svc.components).toHaveLength(8)
  })

  it('a page that carries its structure but not its data withholds instead of publishing all-operational', async () => {
    const svc = await run(pageHtml().replace('component_uptimes', 'component_uptime_x'))
    expect(svc.sourceUnknown).toBe(true)
    expect(svc.components ?? []).toHaveLength(0)
  })

  it('an unreadable page withholds instead of publishing an operational badge', async () => {
    const svc = await run(undefined)
    expect(svc.sourceUnknown).toBe(true)
    expect(svc.uptime30d ?? null).toBeNull()
  })

  it('publishes the newest incident first, which is what the is-down header reads', async () => {
    const svc = await run(pageHtml())
    const starts = svc.incidents.map((i) => i.startedAt)
    expect(starts).toEqual([...starts].sort((a, b) => b.localeCompare(a)))
    expect(svc.incidents[0].title).toBe('Test')
  })

  it('resolved incidents carry a real duration, not the None the inverted page records produced', async () => {
    const svc = await run(pageHtml())
    const ivc = svc.incidents.find((i) => i.title === 'Instant Voice Clone creation failures')
    expect(ivc?.duration).not.toBeNull()
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fetchService, SERVICES } from '../services'
import type { KVLike } from '../utils'

// #1634 — status.x.ai/feed.xml as published on 2026-10-07, after xAI changed its tag shapes:
// `[Global (api.x.ai)]` / `[US (us.api.x.ai)]` region tags, `[grok.com]` for Grok on the web, and one
// shared guid for every tag of an event.

const FEED = readFileSync(new URL('./fixtures/xai-feed-2026-10-07.xml', import.meta.url), 'utf8')
const grok = SERVICES.find((s) => s.id === 'grok')!
const xai = SERVICES.find((s) => s.id === 'xai')!

function mockKV(): KVNamespace {
  const store: Record<string, string> = {}
  return {
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string) => { store[k] = v },
    delete: async (k: string) => { delete store[k] },
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
  } as unknown as KVLike as unknown as KVNamespace
}

function stubFeed() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    return new Response(url.endsWith('/feed.xml') ? FEED : '<html>ok</html>', { status: 200 })
  }))
}

afterEach(() => { vi.unstubAllGlobals() })

describe('#1634 — the 2026-10-07 status.x.ai feed shape', () => {
  it('xAI API card: one incident per event, regions merged, no Grok-tagged items, unique ids', async () => {
    stubFeed()
    const svc = await fetchService(xai, undefined, mockKV(), {})
    const titles = svc.incidents.map((i) => i.title)

    expect(titles).toEqual([
      '[API] Outages across API, Grok.com, and Grok Build (regions: Global, US)',
      '[API] Enterprise Voice Degraded (regions: Global, US)',
      '[API] Models outage (regions: Global, US)',
      '[API] grok-4.6 and grok-4.5 high error rate (regions: Global, US)',
    ])
    expect(new Set(svc.incidents.map((i) => i.id)).size).toBe(svc.incidents.length)
  })

  it('Grok card: grok.com joins the same-event surface group, unique ids', async () => {
    stubFeed()
    const svc = await fetchService(grok, undefined, mockKV(), {})
    const titles = svc.incidents.map((i) => i.title)

    expect(titles).toEqual([
      '[grok.com] grok.com',
      '[Grok (Build, grok.com)] Outages across API, Grok.com, and Grok Build',
      '[Grok (Android, Build, grok.com, X, iOS, Office/Workspace Plugins)] Models outage',
    ])
    expect(new Set(svc.incidents.map((i) => i.id)).size).toBe(svc.incidents.length)
  })

  it('#1338 — one event on both cards carries one crossEventKey; ids are unchanged', async () => {
    stubFeed()
    const api = await fetchService(xai, undefined, mockKV(), {})
    const app = await fetchService(grok, undefined, mockKV(), {})

    expect(api.incidents.map((i) => i.id)).toEqual(['xai-evt:w28qgm', 'xai-evt:60k8qx', 'xai-evt:mger3p', 'xai-evt:5fnog2'])
    expect(app.incidents.map((i) => i.id)).toEqual(['xai-grok:1am6s3t', 'xai-grok:1ffbseu', 'xai-grok:53g239'])

    const keys = (incs: typeof api.incidents) => incs.map((i) => i.crossEventKey)
    const [outages, voice, models, highError] = keys(api.incidents)
    const [grokCom, appOutages, appModels] = keys(app.incidents)
    expect(appOutages).toBe(outages)
    expect(appModels).toBe(models)
    expect(new Set([outages, voice, models, highError, grokCom]).size).toBe(5)
  })
})

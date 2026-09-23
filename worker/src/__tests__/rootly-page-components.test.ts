// #1481 — the Rootly page must reach the #992 new-component detector.
//
// The detector is keyed by `apiUrl` and built from the summary/components.json prefetch, and a
// `rootlyFeed` service sets `apiUrl: null`, so this page has never had a `component-seen:` snapshot.
// `collectDetectablePages` is the whole "which pages get diffed this cycle" decision, exported so
// these tests assert it directly rather than matching the cron's spelling.

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { collectDetectablePages, SERVICES, fetchAllServices, type ServiceStatus } from '../services'
import { MISTRAL_FEED_KV_KEY } from '../parsers/rootly'
import { TEST_TIMEOUT_MS } from './helpers/unreadable-source'

const MISTRAL = SERVICES.find((s) => s.rootlyFeed)!
const VIBE = { id: '5cbd24d3-ebb0-446f-8e4f-a198b30cc66c', name: 'Vibe', status: 'Operational' }
const CONSOLE = { id: '219bff35-e3ad-4684-a5d2-d26dc3826792', name: 'Console', status: 'Operational' }
const AGENTS = { id: '304d5895-4dde-47be-b2e1-b7ebeb28dd4d', name: 'Agents API', status: 'Operational' }

const PREFETCHED = { 'https://status.cohere.com/api/v2/summary.json': [{ id: 'c1', name: 'Cohere API' }] }

function kvWith(value: string | null): KVNamespace {
  return { get: vi.fn(async () => value) } as unknown as KVNamespace
}

function feed(components: Array<{ id: string; name: string; status: string }>): string {
  return JSON.stringify({ fetchedAt: '2026-09-22T00:00:00.000Z', feed: { fetchedAt: '2026-09-22T00:00:00.000Z', components, incidents: [] } })
}

describe('#1481 collectDetectablePages', () => {
  it('diffs the rootly page ALONGSIDE the prefetched ones, keyed by its statusUrl', async () => {
    const pages = await collectDetectablePages(kvWith(feed([AGENTS, CONSOLE, VIBE])), PREFETCHED, true)
    expect(Object.keys(pages).sort()).toEqual([...Object.keys(PREFETCHED), MISTRAL.statusUrl].sort())
    expect(pages[MISTRAL.statusUrl]).toEqual([
      { id: AGENTS.id, name: AGENTS.name },
      { id: CONSOLE.id, name: CONSOLE.name },
      { id: VIBE.id, name: VIBE.name },
    ])
  })

  it('keeps every prefetched page intact — the rootly leg is additive', async () => {
    const pages = await collectDetectablePages(kvWith(feed([AGENTS])), PREFETCHED, true)
    for (const [page, comps] of Object.entries(PREFETCHED)) expect(pages[page]).toEqual(comps)
  })

  it('reads nothing and diffs nothing on a fresh-cache cycle', async () => {
    const kv = kvWith(feed([AGENTS, VIBE]))
    expect(await collectDetectablePages(kv, PREFETCHED, false)).toEqual({})
    expect(kv.get).not.toHaveBeenCalled()
  })

  it('reads the feed key the scraper writes', async () => {
    const kv = kvWith(feed([AGENTS]))
    await collectDetectablePages(kv, {}, true)
    expect(kv.get).toHaveBeenCalledWith(MISTRAL_FEED_KV_KEY)
  })

  it('keys cannot collide with the apiUrl keys sharing the component-seen namespace', () => {
    // The whole key space is `component-seen:{page}`. A collision would make two different pages
    // overwrite each other's durable snapshot, so assert the disjointness directly rather than
    // inferring it from a url-shape rule (5 configured statusUrls do carry a path).
    const apiUrls = SERVICES.map((s) => s.apiUrl).filter((u): u is string => !!u)
    expect(apiUrls).not.toContain(MISTRAL.statusUrl)
  })

  const unreadable: Array<[string, KVNamespace | undefined]> = [
    ['no kv binding', undefined],
    ['absent feed', kvWith(null)],
    ['unparseable feed', kvWith('{not json')],
    ['feed with no components array', kvWith(JSON.stringify({ feed: {} }))],
    ['components present but none recordable', kvWith(feed([{ id: '', name: '', status: 'Operational' }]))],
  ]
  it.each(unreadable)('drops only the rootly page on %s, never a prefetched one', async (_label, kv) => {
    expect(await collectDetectablePages(kv, PREFETCHED, true)).toEqual(PREFETCHED)
  })

  it('survives a kv.get that throws', async () => {
    const kv = { get: vi.fn(async () => { throw new Error('boom') }) } as unknown as KVNamespace
    expect(await collectDetectablePages(kv, PREFETCHED, true)).toEqual(PREFETCHED)
  })
})

describe('#1481 the real scheduled() handler diffs the rootly page', () => {
  // A green `collectDetectablePages` proves nothing about whether production calls it, and a regex
  // over index.ts is satisfied by a comment while the loop reads the old record — a source-text
  // assertion is a hand-written parser (`cache-reseed-wiring.test.ts` header, #1224). So the bug
  // #1481 names — the rootly page never reaches the detector — is asserted through the real cron.
  afterEach(() => { vi.restoreAllMocks() })

  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  const event = { scheduledTime: Date.parse('2026-08-12T12:07:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent
  const OPERATIONAL = SERVICES.map((s) => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))

  async function runCron(seed: Record<string, string>) {
    const store = new Map<string, string>(Object.entries(seed))
    const puts: Array<{ key: string; value: string }> = []
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async (key: string, value: string) => { puts.push({ key, value }); store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace
    const discord: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('example.invalid')) discord.push(String(init?.body ?? ''))
      return new Response('{}', { status: 200 })
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [] })
    await workerModule.scheduled(event, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' } as never, ctx)
    return { puts, discord }
  }

  const SEEN_KEY = `component-seen:${MISTRAL.statusUrl}`

  it('bootstraps the page it could not previously see', async () => {
    const { puts } = await runCron({ [MISTRAL_FEED_KV_KEY]: feed([AGENTS, CONSOLE, VIBE]) })
    const seen = puts.filter((p) => p.key === SEEN_KEY)
    expect(seen.length, `expected a ${SEEN_KEY} write`).toBe(1)
    expect(JSON.parse(seen[0].value)).toEqual([AGENTS.id, CONSOLE.id, VIBE.id])
  }, TEST_TIMEOUT_MS)

  it('names the AIWatch service, not the bare page url, when a new component appears', async () => {
    // Also the counter-case to the bootstrap above: a page with a snapshot alerts instead of writing
    // silently, which is the behaviour the detector exists for.
    const { discord } = await runCron({
      [MISTRAL_FEED_KV_KEY]: feed([AGENTS, CONSOLE, VIBE]),
      [SEEN_KEY]: JSON.stringify([AGENTS.id, CONSOLE.id]),
    })
    const alert = discord.find((b) => b.includes('New status-page component'))
    expect(alert, 'expected a new-component alert naming Vibe').toBeTruthy()
    expect(alert).toContain('Vibe')
    expect(alert).toContain(MISTRAL.name)
  }, TEST_TIMEOUT_MS)
})

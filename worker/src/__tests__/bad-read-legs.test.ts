import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'
import type { KVLike, TrackingStateBlob } from '../utils'

// #1212 — the WIRING half of the bad-read guard. `parsers/__tests__/aws.test.ts` pins that the parser
// can tell a quiet feed from a body that is not a feed; that says nothing about whether `fetchService`
// acts on the distinction, and the bug lived entirely in the acting: a 200 carrying an interstitial
// produced `[]`, which cleared the failure streak and published `operational` with no incidents.
//
// Two services reach these legs, and neither has anything to contradict a bad read — one source, no
// probe target, and no cross-validation phase they qualify for. Both are covered here.
//
// #1224 — the failure streak these tests pin lives in the consolidated `tracking:state` blob now, not
// individual `fetch-fail:{id}` KV keys, so each test threads its own `trackingStore` explicitly
// (mirroring what `fetchAllServices` does in production) instead of reading it back out of the mock
// KV's raw store. `instatus-parse-fail:*` is unaffected by that consolidation — still a real KV key —
// so `keysStartingWith(store, ...)` stays valid for those assertions.

const azure = SERVICES.find((s) => s.id === 'azureopenai')!
const bedrock = SERVICES.find((s) => s.id === 'bedrock')!

function mockKV(store: Record<string, string> = {}): KVNamespace {
  return {
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string) => { store[k] = v },
    delete: async (k: string) => { delete store[k] },
  } as unknown as KVLike as unknown as KVNamespace
}

const keysStartingWith = (store: Record<string, string>, prefix: string) =>
  Object.keys(store).filter((k) => k.startsWith(prefix))

/** What a middlebox substitutes while still answering 200. */
const INTERSTITIAL = '<!DOCTYPE html><html><head><title>Access denied</title></head><body>Checking your browser…</body></html>'

/** The live feed's ordinary state: reachable, zero incidents. */
const QUIET_FEED = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Azure Status</title><lastBuildDate>Thu, 06 Aug 2026 01:09:00 Z</lastBuildDate></channel></rss>`

/**
 * The real feed is the WHOLE-Azure firehose and azureopenai's only scoping is
 * `incidentKeywords: ['Azure OpenAI']`, so the sibling item is load-bearing: this PR MOVED the
 * `filterIncidents` call, and a single-item fixture would let a dropped one pass unnoticed.
 */
function feedWithIncident() {
  const pubDate = new Date(Date.now() - 3_600_000).toUTCString()
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Azure Status</title>
  <item>
    <title>Azure OpenAI - Degraded experience for some customers</title>
    <description>Engineers are investigating elevated error rates.</description>
    <pubDate>${pubDate}</pubDate>
    <guid>az-1212-test</guid>
  </item>
  <item>
    <title>Azure Cosmos DB - Degraded experience in West Europe</title>
    <description>A sibling Azure service, not ours.</description>
    <pubDate>${pubDate}</pubDate>
    <guid>az-cosmos-test</guid>
  </item>
</channel></rss>`
}

/** Entries we CAN read, none of which are ours — the most common real state of a firehose feed. */
function feedWithOnlySiblings() {
  const pubDate = new Date(Date.now() - 3_600_000).toUTCString()
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Azure Status</title>
  <item>
    <title>Azure Cosmos DB - Degraded experience in West Europe</title>
    <description>Not ours.</description>
    <pubDate>${pubDate}</pubDate>
    <guid>az-cosmos-only</guid>
  </item>
</channel></rss>`
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('#1212 — a 200 that is not a feed must not read as a recovery (azureopenai)', () => {
  it('does NOT clear the failure streak when the body is not a feed', async () => {
    // The regression test proper, and the load-bearing half: clearing the streak is what turns a
    // sequence of bad reads into a permanent green badge, because the counter never reaches 3.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { azureopenai: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(INTERSTITIAL, { status: 200 })))

    const svc = await fetchService(azure, undefined, mockKV(store), trackingStore)

    expect(trackingStore.azureopenai?.failCount, 'an unreadable body is a failed read, not a success').toBe(3)
    expect(svc.status, 'the third consecutive bad read crosses the threshold').toBe('unknown')
    // #1233 invariant — an unreadable source carries NO incident. Several modules omit an `unknown`
    // branch because of this (the X drafts, the feed's fallback line, the region/calendar fallbacks).
    expect(svc.incidents).toEqual([])
    expect(svc.sourceUnknown, 'and it is flagged as OUR read failing, not a verdict about Azure').toBe(true)
    expect(svc.incidents).toEqual([])
  })

  it('books the failure reason durably, so the rate survives the 48h fetch-fail window', async () => {
    // `fetch-fail:daily` only counts 3-strike crossings and expires in 48h; the reason bucket is the
    // 30d instrument that says WHICH source went unreadable and how (#1089/#1123 precedent).
    const store: Record<string, string> = {}
    vi.stubGlobal('fetch', vi.fn(async () => new Response(INTERSTITIAL, { status: 200 })))

    await fetchService(azure, undefined, mockKV(store), {})

    const booked = keysStartingWith(store, 'instatus-parse-fail:')
    expect(booked, 'the reason must be recorded on the first bad read, not only at the threshold').toHaveLength(1)
    expect(JSON.parse(store[booked[0]]).counts.azureopenai).toEqual({ 'aws-rss-not-a-feed': 1 })
  })

  it('a QUIET feed is not flagged — the false-positive direction', async () => {
    // If this flips, azureopenai carries a "we cannot read this source" caveat every ordinary day and
    // never clears its streak, which is a worse failure than the one being fixed.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { azureopenai: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(QUIET_FEED, { status: 200 })))

    const svc = await fetchService(azure, undefined, mockKV(store), trackingStore)

    expect(svc.status).toBe('operational')
    expect(svc.sourceUnknown).toBeUndefined()
    expect(trackingStore.azureopenai, 'a readable feed clears the streak').toBeUndefined()
    expect(keysStartingWith(store, 'instatus-parse-fail:'), 'nothing unreadable happened').toEqual([])
  })

  it('a readable feed with an incident is unaffected', async () => {
    const store: Record<string, string> = {}
    vi.stubGlobal('fetch', vi.fn(async () => new Response(feedWithIncident(), { status: 200 })))

    const svc = await fetchService(azure, undefined, mockKV(store), {})

    expect(svc.incidents).toHaveLength(1)
    expect(svc.status).toBe('degraded')
    expect(svc.sourceUnknown, 'a real incident is a verdict about Azure, not about our read').toBeUndefined()
  })

  it('flags sourceUnknown when the fetch itself fails', async () => {
    // The #714 rule the two legs in this block were the last to be missing: a thrown fetch is an
    // INDETERMINATE verdict, not a recovery.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { azureopenai: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))

    const svc = await fetchService(azure, undefined, mockKV(store), trackingStore)

    expect(svc.sourceUnknown).toBe(true)
    expect(svc.status).toBe('unknown')
  })
})

describe('#1212 — the AWS Health leg carries the same flag (bedrock)', () => {
  it('flags sourceUnknown on a failed fetch', async () => {
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { bedrock: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))

    const svc = await fetchService(bedrock, undefined, mockKV(store), trackingStore)

    expect(svc.sourceUnknown).toBe(true)
    expect(svc.status).toBe('unknown')
  })

  it('flags sourceUnknown on a 200 with an unparseable body', async () => {
    // The guard for this already existed (#677) — it refused to call the body a recovery — but it
    // said so only in the counter, so the badge still read as an ordinary amber `degraded`.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { bedrock: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json at all', { status: 200 })))

    const svc = await fetchService(bedrock, undefined, mockKV(store), trackingStore)

    expect(svc.sourceUnknown).toBe(true)
    expect(svc.status).toBe('unknown')
    expect(trackingStore.bedrock?.failCount).toBe(3)
  })

  it('separates a body that would not PARSE from one that parsed into the wrong thing', async () => {
    // The 30d counter exists to outlive the logs, so it must not conflate the two: a decode failure
    // points at encoding/transport, a wrong shape points at the parser. A body of literal `null`
    // decodes fine and must NOT be filed as a decode failure.
    const cases: Array<[unknown, string]> = [
      ['not json at all', 'aws-health-unparseable'],
      [null, 'aws-health-not-an-array'],
    ]
    for (const [body, reason] of cases) {
      const store: Record<string, string> = {}
      const payload = typeof body === 'string' ? body : JSON.stringify(body)
      vi.stubGlobal('fetch', vi.fn(async () => new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } })))

      await fetchService(bedrock, undefined, mockKV(store), {})

      const booked = keysStartingWith(store, 'instatus-parse-fail:')
      expect(booked, String(payload)).toHaveLength(1)
      expect(JSON.parse(store[booked[0]]).counts.bedrock, String(payload)).toEqual({ [reason]: 1 })
      vi.unstubAllGlobals()
    }
  })

  it('a readable events payload is not flagged', async () => {
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { bedrock: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })))

    const svc = await fetchService(bedrock, undefined, mockKV(store), trackingStore)

    expect(svc.sourceUnknown).toBeUndefined()
    expect(svc.status).toBe('operational')
    expect(trackingStore.bedrock).toBeUndefined()
  })
})

describe('#1212 — a readable source with nothing of ours is NOT an unreadable one', () => {
  // The most common real state of a whole-Azure firehose: entries we parsed fine, none of them ours.
  // If this ever reads as unreadable, the service carries a permanent caveat on an ordinary day.

  it('azure: entries that all filter out still clear the streak', async () => {
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { azureopenai: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(feedWithOnlySiblings(), { status: 200 })))

    const svc = await fetchService(azure, undefined, mockKV(store), trackingStore)

    expect(svc.status).toBe('operational')
    expect(svc.incidents, 'the sibling is not ours').toEqual([])
    expect(svc.sourceUnknown).toBeFalsy()
    expect(trackingStore.azureopenai).toBeUndefined()
    expect(keysStartingWith(store, 'instatus-parse-fail:')).toEqual([])
  })

  it('bedrock: an events array carrying only other AWS services still clears the streak', async () => {
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { bedrock: { failCount: 2, failCountAt: new Date().toISOString() } }
    const events = [{ service: 'EC2', region: 'us-east-1', typeCode: 'AWS_EC2_OPERATIONAL_ISSUE', startTime: Date.now() - 3_600_000, metadata: {} }]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(events), { status: 200, headers: { 'content-type': 'application/json' } })))

    const svc = await fetchService(bedrock, undefined, mockKV(store), trackingStore)

    expect(svc.status).toBe('operational')
    expect(svc.sourceUnknown).toBeFalsy()
    expect(trackingStore.bedrock).toBeUndefined()
  })
})

describe('#1212 — a 200 that PARSES but is the wrong shape (bedrock)', () => {
  // The half #677's guard never covered: it only caught a body that failed to parse. A wrapper-object
  // drift or an error object parses fine, and `parseAwsHealthEvents` returns [] for a non-array.

  it.each([
    ['a wrapper object', { events: [] }],
    ['an error object', { message: 'Forbidden' }],
    ['a bare string', 'blocked'],
  ])('flags sourceUnknown for %s', async (_label, payload) => {
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { bedrock: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })))

    const svc = await fetchService(bedrock, undefined, mockKV(store), trackingStore)

    expect(svc.sourceUnknown, 'a parseable body of the wrong shape is still an unread source').toBe(true)
    expect(svc.status).toBe('unknown')
    expect(trackingStore.bedrock?.failCount, 'the streak must not be cleared').toBe(3)
  })

  it('books the shape drift under its own reason, distinct from the parse failure', async () => {
    const store: Record<string, string> = {}
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events: [] }), { status: 200, headers: { 'content-type': 'application/json' } })))

    await fetchService(bedrock, undefined, mockKV(store), {})

    const booked = keysStartingWith(store, 'instatus-parse-fail:')
    expect(booked).toHaveLength(1)
    expect(JSON.parse(store[booked[0]]).counts.bedrock).toEqual({ 'aws-health-not-an-array': 1 })
  })
})

describe('#1212 — a feed WITH entries that yields no incidents is unreadable (azure)', () => {
  // The envelope can be intact while every entry is unreadable — an attribute on <item>, or a renamed
  // date element. Same false "no incidents", different route.

  it('flags sourceUnknown when a renamed date element makes every entry unreadable', async () => {
    const pubDate = new Date(Date.now() - 3_600_000).toUTCString()
    const body = `<rss version="2.0"><channel><title>t</title><item><title>Azure OpenAI - Degraded</title><published>${pubDate}</published><guid>g1</guid></item></channel></rss>`
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { azureopenai: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))

    const svc = await fetchService(azure, undefined, mockKV(store), trackingStore)

    expect(svc.sourceUnknown, 'an entry was present and none survived — that is drift, not quiet').toBe(true)
    expect(svc.status).toBe('unknown')
    expect(trackingStore.azureopenai?.failCount).toBe(3)
    const booked = keysStartingWith(store, 'instatus-parse-fail:')
    expect(JSON.parse(store[booked[0]]).counts.azureopenai).toEqual({ 'aws-rss-items-unreadable': 1 })
  })

  it('an entry carrying attributes goes through as a normal incident', async () => {
    // `<item foo="bar">` is legal RSS, so the leg must READ it rather than report our own regex's
    // narrowness as upstream drift and pin the service unreadable.
    const pubDate = new Date(Date.now() - 3_600_000).toUTCString()
    const body = `<rss version="2.0"><channel><title>t</title><item xmlns:x="urn:x"><title>Azure OpenAI - Degraded experience</title><pubDate>${pubDate}</pubDate><guid>g1</guid></item></channel></rss>`
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { azureopenai: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))

    const svc = await fetchService(azure, undefined, mockKV(store), trackingStore)

    expect(svc.incidents).toHaveLength(1)
    expect(svc.sourceUnknown).toBeFalsy()
    expect(trackingStore.azureopenai, 'a readable feed clears the streak').toBeUndefined()
  })
})

describe('#1212 — a busy shared feed must not truncate OUR incident away', () => {
  it('finds an ongoing Azure OpenAI incident sitting past the old 20-entry cap', async () => {
    // The firehose carries every Azure service newest-first, so during a broad Azure event our
    // ONGOING incident is pushed down by newer siblings. With the cap inside the parser it fell off
    // before `filterIncidents` ever saw it — the incident silently un-published itself mid-outage.
    const d = (h: number) => new Date(Date.now() - h * 3_600_000).toUTCString()
    const siblings = Array.from({ length: 24 }, (_, i) =>
      `<item><title>Azure Cosmos DB - Issue ${i}</title><pubDate>${d(i)}</pubDate><guid>sib-${i}</guid></item>`).join('')
    const ours = `<item><title>Azure OpenAI - Degraded experience for some customers</title><pubDate>${d(30)}</pubDate><guid>ours</guid></item>`
    const body = `<rss version="2.0"><channel><title>Azure Status</title>${siblings}${ours}</channel></rss>`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))

    const svc = await fetchService(azure, undefined, mockKV({}), {})

    expect(svc.incidents.map((i) => i.id), 'ours is entry 25 of the feed').toEqual(['ours'])
    expect(svc.status).toBe('degraded')
  })

  it('still caps what it publishes, counting only our own incidents', async () => {
    const d = (h: number) => new Date(Date.now() - h * 3_600_000).toUTCString()
    const mine = Array.from({ length: 25 }, (_, i) =>
      `<item><title>Azure OpenAI - Degraded ${i}</title><pubDate>${d(i)}</pubDate><guid>mine-${i}</guid></item>`).join('')
    const body = `<rss version="2.0"><channel><title>Azure Status</title>${mine}</channel></rss>`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))

    const svc = await fetchService(azure, undefined, mockKV({}), {})

    expect(svc.incidents).toHaveLength(20)
  })
})

describe('#1212 — the publish cap is a DISPLAY bound, not a status input', () => {
  it('still reports degraded when our 21st incident is the only ongoing one', async () => {
    // The cap trims what is shown. Deriving status from the trimmed list would reintroduce the same
    // silent un-publish the cap move fixed, just needing 20 newer incidents of our own instead of 20
    // of anyone's — the feed is newest-first and nothing sorts unresolved entries up.
    const d = (h: number) => new Date(Date.now() - h * 3_600_000).toUTCString()
    const resolved = Array.from({ length: 20 }, (_, i) =>
      `<item><title>[RESOLVED] Azure OpenAI - Issue ${i}</title><pubDate>${d(i)}</pubDate><guid>r-${i}</guid></item>`).join('')
    const ongoing = `<item><title>Azure OpenAI - Degraded experience</title><pubDate>${d(40)}</pubDate><guid>ongoing</guid></item>`
    const body = `<rss version="2.0"><channel><title>Azure Status</title>${resolved}${ongoing}</channel></rss>`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))

    const svc = await fetchService(azure, undefined, mockKV({}), {})

    expect(svc.incidents, 'the display list is still capped').toHaveLength(20)
    expect(svc.incidents.some((i) => i.id === 'ongoing'), 'and the ongoing one is past the cap').toBe(false)
    expect(svc.status, 'yet the status still reflects it').toBe('degraded')
  })
})

describe('#1212 — the same split on the AWS Health leg', () => {
  it('still reports degraded when our 21st event is the only ongoing one', async () => {
    // bedrock ids are per-region, so one multi-region event yields one entry per region — 20 matched
    // entries ahead of an ongoing one is reachable. Capping produced incidents dropped it before
    // `deriveAwsStatus` ever saw it: a green badge mid-outage on a service with no probe, no second
    // source, and no cross-validation phase.
    const hour = 3_600_000
    const resolved = Array.from({ length: 20 }, (_, i) => ({
      service: 'BEDROCK', region: `r-${i}`, typeCode: 'AWS_BEDROCK_OPERATIONAL_ISSUE',
      startTime: Date.now() - (i + 2) * hour, endTime: Date.now() - (i + 1) * hour, metadata: {},
    }))
    const ongoing = { service: 'BEDROCK', region: 'r-live', typeCode: 'AWS_BEDROCK_OPERATIONAL_ISSUE', startTime: Date.now() - 40 * hour, metadata: {} }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([...resolved, ongoing]), { status: 200, headers: { 'content-type': 'application/json' } })))

    const svc = await fetchService(bedrock, undefined, mockKV({}), {})

    expect(svc.incidents, 'the display list is still capped').toHaveLength(20)
    expect(svc.incidents.some((i) => i.componentNames?.includes('r-live')), 'ours is past the cap').toBe(false)
    expect(svc.status, 'yet the status still reflects it').toBe('degraded')
  })
})

describe('#1212 — a 4xx is the source being GONE, not an indeterminate read', () => {
  // `sourceUnknown`'s contract (types.ts) excludes a confirmed 4xx, and the consequence is not
  // cosmetic: `sourceLivenessOf` maps `unknown` to a HOLD, so a retired endpoint would publish a
  // permanent `degraded` that nobody is ever alerted about.

  it.each([
    ['azureopenai', () => azure, 404],
    ['azureopenai', () => azure, 410],
    ['bedrock', () => bedrock, 404],
  ])('%s: a %i marks the source dead, not degraded', async (_id, get, code) => {
    const trackingStore: TrackingStateBlob = { azureopenai: { failCount: 2, failCountAt: new Date().toISOString() }, bedrock: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: code })))

    const svc = await fetchService(get(), undefined, mockKV({}), trackingStore)

    expect(svc.sourceDead, 'a 4xx is a confirmed dead source').toBe(true)
    expect(svc.sourceUnknown, 'and therefore NOT the indeterminate flag').toBeFalsy()
    expect(svc.status, 'a dead status page is not an outage of the service').toBe('operational')
    expect(svc.incidentSourceStale, 'and it drops out of the rankings').toBe(true)
  })

  it.each([
    ['azureopenai', () => azure, 403],
    ['azureopenai', () => azure, 429],
    ['bedrock', () => bedrock, 403],
    ['bedrock', () => bedrock, 429],
  ])('%s: a %i is a block aimed at US, not a gone page', async (_id, get, code) => {
    // Both endpoints are fetched from Worker egress — one behind Azure Front Door, one undocumented
    // with a spoofed UA — so a 403/429 is far likelier to be a WAF challenge or a rate limit than a
    // retirement. Reading it as dead would publish a green badge at poll rate with no streak, and
    // would skip `trackFetchFailure`, disarming the #500 persistent-block alert that describes a
    // block correctly. Neither service is probed, so nothing could correct a wrong `sourceDead`.
    const trackingStore: TrackingStateBlob = { azureopenai: { failCount: 2, failCountAt: new Date().toISOString() }, bedrock: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('blocked', { status: code })))

    const svc = await fetchService(get(), undefined, mockKV({}), trackingStore)

    expect(svc.sourceDead, 'a block is not a confirmed dead source').toBeFalsy()
    expect(svc.sourceUnknown).toBe(true)
    expect(svc.status).toBe('unknown')
    expect(trackingStore[svc.id]?.failCount, 'the streak must advance so #500 can still fire').toBe(3)
  })

  it.each([
    ['azureopenai', () => azure],
    ['bedrock', () => bedrock],
  ])('%s: a 5xx stays indeterminate', async (_id, get) => {
    const trackingStore: TrackingStateBlob = { azureopenai: { failCount: 2, failCountAt: new Date().toISOString() }, bedrock: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 503 })))

    const svc = await fetchService(get(), undefined, mockKV({}), trackingStore)

    expect(svc.sourceUnknown).toBe(true)
    expect(svc.sourceDead).toBeFalsy()
    expect(svc.status).toBe('unknown')
  })
})

describe('#1212 — fetchWithRetry log lines carry the service id', () => {
  it('names the service on both attempts, not just the URL', async () => {
    // Without this the attempt reasons — the stall-vs-block discriminator #1211 added — were
    // unreachable from a Workers Logs filter on the service id.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))

    await fetchService(azure, undefined, mockKV({}), {})

    const lines = [...warn.mock.calls, ...error.mock.calls].map((c) => String(c[0]))
    // Asserts the CONTRACT (filterable by service id, and still says which URL) rather than the exact
    // layout, so a reformat that still meets the goal does not fail.
    const names = (m: string) => lines.some((l) => l.includes(m) && l.includes('azureopenai') && l.includes(azure.azureRssUrl!))
    expect(names('first attempt failed'), lines.join('\n')).toBe(true)
    expect(names('retry also failed'), lines.join('\n')).toBe(true)
  })
})

import { describe, it, expect, vi } from 'vitest'
import {
  v1Variant,
  recordV1Traffic,
  recordCacheReadOutcome,
  CACHE_READ_INDEX,
  type CacheReadOutcome,
  buildV1TrafficSql,
  parseV1TrafficResponse,
  queryV1Traffic,
  feedVariant,
  feedTarget,
  classifyFeedClient,
  FEED_ALL_TARGET,
  FEED_UNKNOWN_TARGET,
  rollupByClient,
  subscriberFeeds,
  readFeedPolls,
  isMeasuredFeedPolls,
  FEED_SQL_COLUMNS,
  SUBSCRIBER_CLIENTS,
  MIN_SUBSCRIBER_REQUESTS,
  recordFeedTraffic,
  buildFeedTrafficSql,
  parseFeedTrafficResponse,
  queryFeedTraffic,
  recordBadgeTraffic,
  BADGE_UNKNOWN_SERVICE,
  buildBadgeTrafficSql,
  parseBadgeTrafficResponse,
  queryBadgeTraffic,
  buildExtTrafficSql,
  parseExtTrafficResponse,
  queryExtTraffic,
  buildStatuslineTrafficSql,
  parseStatuslineTrafficResponse,
  queryStatuslineTraffic,
  serializeStatuslineSnapshot,
  computeStatuslineDelta,
  buildPluginTrafficSql,
  parsePluginTrafficResponse,
  queryPluginTraffic,
  countFirstSeenWithin24h,
  countNewFeedItems,
} from '../api-traffic'

describe('v1Variant (#518)', () => {
  it('classifies the bare endpoint as all-services', () => {
    expect(v1Variant('/api/v1/status')).toBe('v1-status-all')
    expect(v1Variant('/api/v1/status/')).toBe('v1-status-all')
  })

  it('classifies a per-service path as service', () => {
    expect(v1Variant('/api/v1/status/claude')).toBe('v1-status-service')
    expect(v1Variant('/api/v1/status/openai')).toBe('v1-status-service')
  })
})

describe('recordV1Traffic (#518)', () => {
  it('writes one data point with the pinned blob/double/index shape', () => {
    const wae = { writeDataPoint: vi.fn() }
    recordV1Traffic(wae as unknown as AnalyticsEngineDataset, '/api/v1/status')
    expect(wae.writeDataPoint).toHaveBeenCalledOnce()
    expect(wae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ['v1-status-all'],
      doubles: [1],
      indexes: ['v1-status'],
    })
  })

  it('tags the per-service variant in blob1 but keeps the shared index', () => {
    const wae = { writeDataPoint: vi.fn() }
    recordV1Traffic(wae as unknown as AnalyticsEngineDataset, '/api/v1/status/claude')
    const call = wae.writeDataPoint.mock.calls[0][0]
    expect(call.blobs[0]).toBe('v1-status-service')
    expect(call.indexes[0]).toBe('v1-status') // shared dimension → total-v1 queryable with one filter
  })

  it('keeps the index within the 32-byte WAE cap', () => {
    const wae = { writeDataPoint: vi.fn() }
    recordV1Traffic(wae as unknown as AnalyticsEngineDataset, '/api/v1/status')
    const call = wae.writeDataPoint.mock.calls[0][0]
    expect(call.indexes[0].length).toBeLessThanOrEqual(32)
    expect(call.blobs[0].length).toBeLessThanOrEqual(32)
  })

  it('does not write when the binding is absent (local dev / tests)', () => {
    const wae = { writeDataPoint: vi.fn() }
    recordV1Traffic(undefined, '/api/v1/status')
    expect(wae.writeDataPoint).not.toHaveBeenCalled()
  })

  it('swallows a writeDataPoint failure (best-effort, never aborts the response)', () => {
    const wae = { writeDataPoint: vi.fn(() => { throw new Error('WAE down') }) }
    expect(() => recordV1Traffic(wae as unknown as AnalyticsEngineDataset, '/api/v1/status')).not.toThrow()
  })
})

describe('buildV1TrafficSql (#518)', () => {
  it('sums sample-corrected counts per variant over the last 24h, filtered by the index', () => {
    const sql = buildV1TrafficSql()
    expect(sql).toContain('SUM(_sample_interval)') // sampling-corrected, not COUNT(*)
    expect(sql).toContain("index1 = 'v1-status'")
    expect(sql).toContain("INTERVAL '1' DAY")
    expect(sql).toContain('GROUP BY blob1')
    expect(sql).toContain('FROM aiwatch_statusline') // matches the wrangler.toml dataset
  })
})

describe('parseV1TrafficResponse (#518)', () => {
  it('sums per-variant rows into all/service/total (numeric requests)', () => {
    const r = parseV1TrafficResponse({ data: [
      { variant: 'v1-status-all', requests: 120 },
      { variant: 'v1-status-service', requests: 30 },
    ] })
    expect(r).toEqual({ all: 120, service: 30, total: 150 })
  })

  it('tolerates string-typed requests (AE JSON sometimes stringifies numbers)', () => {
    const r = parseV1TrafficResponse({ data: [{ variant: 'v1-status-all', requests: '42' }] })
    expect(r).toEqual({ all: 42, service: 0, total: 42 })
  })

  it('preserves fractional sample-corrected sums on the string path (not floored)', () => {
    // SUM(_sample_interval) is fractional under sampling; Number() must not truncate like parseInt would.
    const r = parseV1TrafficResponse({ data: [{ variant: 'v1-status-all', requests: '123.7' }] })
    expect(r?.all).toBeCloseTo(123.7)
  })

  it('maps a NaN/garbage requests value to 0', () => {
    const r = parseV1TrafficResponse({ data: [{ variant: 'v1-status-all', requests: 'abc' }] })
    expect(r).toEqual({ all: 0, service: 0, total: 0 })
  })

  it('ignores unknown variants and treats missing data as null', () => {
    expect(parseV1TrafficResponse({ data: [{ variant: 'other', requests: 9 }] }))
      .toEqual({ all: 0, service: 0, total: 0 })
    expect(parseV1TrafficResponse({})).toBeNull()
    expect(parseV1TrafficResponse({ data: 'nope' })).toBeNull()
  })
})

describe('queryV1Traffic (#518)', () => {
  const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response

  it('returns null without an account id or token (not configured)', async () => {
    const fetchSpy = vi.fn()
    expect(await queryV1Traffic(undefined, 'tok', fetchSpy as unknown as typeof fetch)).toBeNull()
    expect(await queryV1Traffic('acct', undefined, fetchSpy as unknown as typeof fetch)).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled() // no HTTP call attempted
  })

  it('POSTs SQL to the AE endpoint with a Bearer token and parses the result', async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init: { method: string; headers: { Authorization: string }; body: string }) =>
        okResponse({ data: [
          { variant: 'v1-status-all', requests: 7 },
          { variant: 'v1-status-service', requests: 3 },
        ] }),
    )
    const r = await queryV1Traffic('acct123', 'secret-tok', fetchSpy as unknown as typeof fetch)
    expect(r).toEqual({ all: 7, service: 3, total: 10 })
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/analytics_engine/sql')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer secret-tok')
    expect(init.body).toContain('SUM(_sample_interval)')
  })

  it('returns null on a non-2xx response (best-effort)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response)
    expect(await queryV1Traffic('acct', 'tok', fetchSpy as unknown as typeof fetch)).toBeNull()
  })

  it('returns null (never throws) when fetch rejects', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('network down') })
    await expect(queryV1Traffic('acct', 'tok', fetchSpy as unknown as typeof fetch)).resolves.toBeNull()
  })
})

// ── Feed-poll traffic (#548) ──────────────────────────────────────────────
describe('feedVariant (#548)', () => {
  it('classifies /feed.xml as feed-all, /feed/:slug as feed-service', () => {
    expect(feedVariant('/feed.xml')).toBe('feed-all')
    expect(feedVariant('/feed/claude-code')).toBe('feed-service')
    expect(feedVariant('/feed/openai')).toBe('feed-service')
  })
})

// The two user-agents actually observed on production feeds on 2026-08-21 (`wrangler tail`). Pinned
// verbatim rather than paraphrased: the classifier's ordering bug it guards against is invisible to a
// simplified string — `Amazonbot` only misclassifies as `browser` BECAUSE its real UA is a full
// Mozilla/Chrome/Safari envelope with the bot token buried mid-string.
const UA_SLACK = 'Slackbot 1.0 (+https://api.slack.com/robots)'
const UA_AMAZONBOT =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36'

// Mirrors rss.ts's FEED_TARGET_IDS shape: slug → canonical id, both forms registered.
const SLUGS: ReadonlyMap<string, string> = new Map([
  ['claude', 'claude'],
  ['claude-code', 'claudecode'],
  ['claudecode', 'claudecode'],
])

describe('feedTarget (#1273)', () => {
  it('maps /feed.xml to the all sentinel and a known slug to its canonical service id', () => {
    expect(feedTarget('/feed.xml', SLUGS)).toBe(FEED_ALL_TARGET)
    expect(feedTarget('/feed/claude', SLUGS)).toBe('claude')
    // The URL slug differs from the id here — blob2 must carry the ID so it joins with other datasets.
    expect(feedTarget('/feed/claude-code', SLUGS)).toBe('claudecode')
    expect(feedTarget('/feed/claudecode', SLUGS)).toBe('claudecode')
  })

  it('collapses an unknown segment into ONE sentinel (blob2 cardinality is caller-controlled)', () => {
    // /feed/:segment is public: without this, anyone looping /feed/<random> writes unbounded blob2
    // values. Two different junk segments must land on the same bucket, not two buckets.
    expect(feedTarget('/feed/not-a-service', SLUGS)).toBe(FEED_UNKNOWN_TARGET)
    expect(feedTarget('/feed/' + 'x'.repeat(200), SLUGS)).toBe(FEED_UNKNOWN_TARGET)
    expect(feedTarget('/feed/', SLUGS)).toBe(FEED_UNKNOWN_TARGET)
  })
})

describe('classifyFeedClient (#1273)', () => {
  it('classifies the two user-agents observed in production', () => {
    expect(classifyFeedClient(UA_SLACK)).toBe('slack')
    expect(classifyFeedClient(UA_AMAZONBOT)).toBe('bot')
  })


  it('classifies feed readers and plain browsers', () => {
    expect(classifyFeedClient('Feedly/1.0 (+http://www.feedly.com/fetcher.html)')).toBe('reader')
    expect(classifyFeedClient('Inoreader/1.0')).toBe('reader')
    expect(classifyFeedClient('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126 Safari/537.36')).toBe('browser')
  })

  it('returns `other` for an unrecognised user-agent — the fallthrough VALUE, not just its type', () => {
    // Mutating the final `return 'other'` to `return 'reader'` previously survived every test: that
    // admits EVERY unknown UA into SUBSCRIBER_CLIENTS, which is the conflation this dimension exists
    // to end. Asserting membership in the 5-value union only re-states what the return type gives.
    expect(classifyFeedClient('anything at all')).toBe('other')
    expect(classifyFeedClient('Dalvik/2.1.0 (Linux; U; Android 12)')).toBe('other')
  })

  it('counts only Slack\'s feed POLLER — not the agents a person triggers', () => {
    // ImgProxy fetches unfurl images; LinkExpanding/LinkChecking fire when someone pastes a link.
    // None is a subscription, and admitting them manufactured per-service "subscriptions".
    expect(classifyFeedClient('Slackbot 1.0 (+https://api.slack.com/robots)')).toBe('slack')
    // The slash form matches BOTH `slack` and `bot` (`bot/`), so this is what makes the slack-before-
    // bot ordering load-bearing. Without it the ordering is an equivalent mutant and nothing notices
    // if a future Slack version string starts landing in `bot`.
    expect(classifyFeedClient('Slackbot/1.0 (+https://api.slack.com/robots)')).toBe('slack')
    expect(classifyFeedClient('Slack-ImgProxy (+https://api.slack.com/robots)')).toBe('other')
    // Anchored: the token inside a URL another agent carries must not make it a subscriber. The
    // `bot` matcher already demands a trailing delimiter for the same reason; without the anchor the
    // asymmetry ran in the direction that over-counts, in the class feeding the headline.
    expect(classifyFeedClient('Mozilla/5.0 (compatible; SomeBot/1.0; +http://example.com/slackbot)')).toBe('bot')
    for (const ua of ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
                      'Slackbot-LinkChecking 1.0 (+https://api.slack.com/robots)']) {
      expect(SUBSCRIBER_CLIENTS).not.toContain(classifyFeedClient(ua))
    }
  })

  it('files the Slack IN-APP BROWSER as a person, not a subscriber', () => {
    // A bare /slack/i matched this and admitted a human opening a link to SUBSCRIBER_CLIENTS.
    expect(classifyFeedClient('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.29.149 Chrome/102.0.5005.167 Electron/19.0.11 Safari/537.36')).toBe('browser')
  })

  it('files hyphen-suffixed crawlers as bot', () => {
    expect(classifyFeedClient('Googlebot-Image/1.0')).toBe('bot')
    expect(classifyFeedClient('Mozilla/5.0 (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)')).toBe('bot')
  })

  it('files a crawler that advertises RSS as bot, not reader', () => {
    // `reader` carries no bare `rss` token, so a crawler advertising RSS cannot land in the subscriber
    // set — the one number whose purpose is surviving a crawler wave.
    expect(classifyFeedClient('Mozilla/5.0 (compatible; RSSMicro.com RSS/Atom Feed Robot)')).toBe('bot')
    expect(classifyFeedClient('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe('bot')
  })

  it('does not file a handset model whose "bot" is followed by _ or a space as a crawler', () => {
    // Deliberately narrow: the hyphen form (`CUBOT-P30`) IS matched as a crawler, because
    // `Googlebot-Image` requires the same delimiter. No delimiter set separates them.
    expect(classifyFeedClient('Mozilla/5.0 (Linux; Android 11; CUBOT_NOTE_20) AppleWebKit/537.36 Chrome/96 Mobile Safari/537.36')).toBe('browser')
    expect(classifyFeedClient('Mozilla/5.0 (Linux; Android 11; CUBOT NOTE 20 Build/RP1A) AppleWebKit/537.36 Chrome/96 Mobile Safari/537.36')).toBe('browser')
    // The admitted false positive, pinned so it is a known limit rather than a surprise.
    expect(classifyFeedClient('Mozilla/5.0 (Linux; Android 10; CUBOT-P30 Build/QP1A) AppleWebKit/537.36 Chrome/96 Mobile Safari/537.36')).toBe('bot')
  })

  it('keeps named readers classified after the bot-first reorder', () => {
    expect(classifyFeedClient('Tiny Tiny RSS/21.11')).toBe('reader')
    // With the envelope, not stripped: this is what makes reader-before-browser load-bearing, and
    // it is how these clients actually identify. A stripped fixture pins nothing about the ordering.
    expect(classifyFeedClient('Mozilla/5.0 (compatible; Miniflux/2.0.51; +https://miniflux.app)')).toBe('reader')
    expect(classifyFeedClient('Mozilla/5.0 (compatible; FreshRSS/1.20.1; +https://freshrss.org)')).toBe('reader')
  })

  it('treats a missing or blank user-agent as other, never bot (absence is not evidence)', () => {
    expect(classifyFeedClient(null)).toBe('other')
    expect(classifyFeedClient(undefined)).toBe('other')
    expect(classifyFeedClient('   ')).toBe('other')
  })

  it('never lets the raw user-agent reach WAE (asserted where it would actually leak)', () => {
    // The return type already constrains the classifier's OUTPUT, so asserting membership in the
    // union there is tautological. What is worth pinning is the write: no part of the UA string
    // appears in any blob, whatever the UA was.
    const writeDataPoint = vi.fn()
    const ua = 'SecretInternalTool/9.9 (+https://internal.example/private-path)'
    recordFeedTraffic({ writeDataPoint } as unknown as AnalyticsEngineDataset, new URL('https://aiwatch-worker.p2c2kbf.workers.dev/feed/claude'), SLUGS, ua)
    const blobs: string[] = writeDataPoint.mock.calls[0][0].blobs
    for (const b of blobs) expect(ua).not.toContain(b)
    expect(blobs).toEqual(['feed-service', 'claude', 'other'])
  })
})

describe('recordFeedTraffic (#548, #1273)', () => {
  it('writes one data point with index feed-poll and the variant/target/client blobs', () => {
    const writeDataPoint = vi.fn()
    recordFeedTraffic({ writeDataPoint } as unknown as AnalyticsEngineDataset, new URL('https://aiwatch-worker.p2c2kbf.workers.dev/feed.xml'), SLUGS, UA_SLACK)
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['feed-all', FEED_ALL_TARGET, 'slack'], doubles: [1], indexes: ['feed-poll'],
    })
    recordFeedTraffic({ writeDataPoint } as unknown as AnalyticsEngineDataset, new URL('https://aiwatch-worker.p2c2kbf.workers.dev/feed/claude-code'), SLUGS, UA_AMAZONBOT)
    expect(writeDataPoint).toHaveBeenLastCalledWith({
      blobs: ['feed-service', 'claudecode', 'bot'], doubles: [1], indexes: ['feed-poll'],
    })
  })

  it('keeps blob1 semantics unchanged so pre-#1273 variant totals stay comparable', () => {
    const writeDataPoint = vi.fn()
    recordFeedTraffic({ writeDataPoint } as unknown as AnalyticsEngineDataset, new URL('https://aiwatch-worker.p2c2kbf.workers.dev/feed/claude'), SLUGS, UA_SLACK)
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe(feedVariant('/feed/claude'))
  })

  it('is a no-op when the binding is absent (local dev / tests)', () => {
    expect(() => recordFeedTraffic(undefined, new URL('https://aiwatch-worker.p2c2kbf.workers.dev/feed.xml'), SLUGS, UA_SLACK)).not.toThrow()
  })

  it('swallows a writeDataPoint throw (never aborts the response)', () => {
    const writeDataPoint = vi.fn(() => { throw new Error('WAE down') })
    expect(() => recordFeedTraffic({ writeDataPoint } as unknown as AnalyticsEngineDataset, new URL('https://aiwatch-worker.p2c2kbf.workers.dev/feed.xml'), SLUGS, UA_SLACK)).not.toThrow()
  })
})

describe('buildFeedTrafficSql (#548, #1273)', () => {
  it('filters on index1 = feed-poll over the last day', () => {
    const sql = buildFeedTrafficSql()
    expect(sql).toContain("index1 = 'feed-poll'")
    expect(sql).toContain("SUM(_sample_interval)")
    expect(sql).toContain("INTERVAL '1' DAY")
  })

  it('selects and groups by the two #1273 blobs', () => {
    // Without this, reverting the query to `SELECT blob1 … GROUP BY blob1` leaves every downstream
    // test green (they all feed hand-written JSON) while `byFeed` is empty in production forever.
    const sql = buildFeedTrafficSql()
    expect(sql).toContain('blob2 AS target')
    expect(sql).toContain('blob3 AS client')
    expect(sql).toContain('GROUP BY blob1, blob2, blob3')
  })

})

describe('parseFeedTrafficResponse (#548, #1273)', () => {
  it('sums the variants into total and nests target → client → count', () => {
    const json = { data: [
      { variant: 'feed-all', target: '__all__', client: 'slack', requests: '120' },
      { variant: 'feed-service', target: 'claude', client: 'slack', requests: 45 },
      { variant: 'feed-service', target: 'claude', client: 'bot', requests: 5 },
    ] }
    expect(parseFeedTrafficResponse(json)).toEqual({
      all: 120, service: 50, total: 170,
      byFeed: { __all__: { slack: 120 }, claude: { slack: 45, bot: 5 } },
    })
  })

  it('returns null for a malformed payload', () => {
    expect(parseFeedTrafficResponse({})).toBeNull()
    expect(parseFeedTrafficResponse(null)).toBeNull()
  })

  it('ignores unknown variants and coerces NaN to 0', () => {
    const json = { data: [{ variant: 'feed-all', requests: 'oops' }, { variant: 'other', requests: 9 }] }
    expect(parseFeedTrafficResponse(json)).toEqual({ all: 0, service: 0, total: 0, byFeed: {} })
  })

  it('still totals a pre-#1273 row that carries no target/client, without inventing a bucket', () => {
    // Rows written before this deploy have no blob2/blob3. They must keep contributing to the variant
    // totals (so a window spanning the deploy is not a false cliff) while adding nothing to the
    // breakdown — the alternative, bucketing them as 'unknown', would read as real classified traffic.
    const json = { data: [
      { variant: 'feed-service', requests: 30 },
      { variant: 'feed-service', target: 'claude', client: 'slack', requests: 10 },
    ] }
    expect(parseFeedTrafficResponse(json)).toEqual({
      all: 0, service: 40, total: 40, byFeed: { claude: { slack: 10 } },
    })
  })

  it('never buckets a row the variant totals did not count', () => {
    // Otherwise `classified` can exceed `total`, the residual goes negative, and the `> 0` guard hides
    // it — a rendered breakdown larger than its own headline, with a feed promoted on requests the
    // headline never reported.
    const out = parseFeedTrafficResponse({ data: [
      { variant: 'weird', target: 'claude', client: 'slack', requests: 40 },
      { variant: 'feed-service', target: 'claude', client: 'slack', requests: 10 },
    ] })!
    expect(out.total).toBe(10)
    expect(out.byFeed).toEqual({ claude: { slack: 10 } })
  })

  it('drops a half-written row (target without client, or vice versa) rather than half-bucketing it', () => {
    const json = { data: [
      { variant: 'feed-service', target: 'claude', requests: 9 },
      { variant: 'feed-service', client: 'slack', requests: 9 },
    ] }
    const out = parseFeedTrafficResponse(json)!
    expect(out.service).toBe(18)
    expect(out.byFeed).toEqual({})
  })
})

describe('parseFeedTrafficResponse — hostile input (#1273)', () => {
  it('does not pollute Object.prototype on a __proto__ target', () => {
    // The nested `byFeed[target] ??= {}` form reads Object.prototype back for the literal key
    // `__proto__` (truthy, so ??= never assigns) and then writes onto it — process-wide for the
    // isolate, while byFeed comes out empty, i.e. invisibly. blob2 is bounded upstream so no such row
    // can be produced today; this function still takes its input from the network.
    const before = Object.keys(Object.prototype).length
    const out = parseFeedTrafficResponse({ data: [
      { variant: 'feed-service', target: '__proto__', client: 'pwned', requests: 7 },
    ] })!
    expect((Object.prototype as Record<string, unknown>).pwned).toBeUndefined()
    expect(Object.keys(Object.prototype).length).toBe(before)
    // The row is DATA, not a prototype write: it round-trips as an own key.
    expect(Object.prototype.hasOwnProperty.call(out.byFeed, '__proto__')).toBe(true)
    expect(out.service).toBe(7)
  })

  it('creates NO bucket for a blank target or client blob', () => {
    const out = parseFeedTrafficResponse({ data: [
      { variant: 'feed-service', target: '', client: 'slack', requests: 9 },
      { variant: 'feed-service', target: 'claude', client: '', requests: 9 },
    ] })!
    expect(out.byFeed).toEqual({})
    expect(out.service).toBe(18)
  })

  it('creates NO bucket for an unreadable requests value', () => {
    // Creating one stores a hard 0, and this field's contract reads a key present-with-0 as a MEASURED
    // zero — so an unreadable count would become a measured zero, permanently, in a no-TTL series.
    //
    // `'oops'` alone green-lit a claim it never tested: the gate was `Number.isFinite(Number(x))`,
    // and `Number()` turns `null`, `''`, `[]`, `false` and whitespace into a finite 0 — every one of
    // which built the bucket the sentence above forbids. A negative is the same defect signed.
    for (const requests of ['oops', null, '', ' ', [], false, -5, '-5', NaN, Infinity, {}]) {
      const out = parseFeedTrafficResponse({ data: [
        { variant: 'feed-service', target: 'claude', client: 'slack', requests },
      ] })!
      expect(out.byFeed, `requests: ${JSON.stringify(requests)} created a bucket`).toEqual({})
      expect(out.byFeed.claude).toBeUndefined()
    }
  })

  it('still counts a readable numeric-string count', () => {
    // The rejection above must not swallow the shape the AE SQL API actually returns — it emits
    // `requests` as a string, so a gate that rejected strings would silently zero every window.
    const out = parseFeedTrafficResponse({ data: [
      { variant: 'feed-service', target: 'claude', client: 'slack', requests: '10' },
      { variant: 'feed-all', target: '__all__', client: 'reader', requests: 0 },
    ] })!
    expect(out.service).toBe(10)
    expect(out.byFeed).toEqual({ claude: { slack: 10 }, __all__: { reader: 0 } })
  })
})

describe('isMeasuredFeedPolls (#1273)', () => {
  it('accepts only a non-empty plain object', () => {
    expect(isMeasuredFeedPolls({ claude: { slack: 1 } })).toBe(true)
    for (const v of [
      {}, null, undefined, [], '{}', 0, 42, true,
      [{ a: 1 }],                             // the array clause's only real case
      { claude: 5 }, { claude: null }, { claude: 'x' }, { claude: [1] }, // deep corruption
      { claude: { slack: 'x' } }, { claude: {} },
      // Multi-key: without these, `.every` → `.some` survives at BOTH levels and the depth promise
      // the `v is` makes is unproven for breadth.
      { claude: { slack: 1 }, bad: 5 }, { claude: { slack: 1 }, bad: null },
      { claude: { slack: 1 }, bad: [1] }, { claude: { slack: 1, bot: 'x' } },
      // A leaf must be a COUNT, not merely a `number`. `typeof NaN === 'number'`, and a negative
      // stored here is resurrected forever by `preserveMeasured` over an honest later failure.
      { claude: { slack: NaN } }, { claude: { slack: -5 } }, { claude: { slack: Infinity } },
      { claude: { slack: 1 }, bad: { reader: -1 } },
    ]) expect(isMeasuredFeedPolls(v), JSON.stringify(v)).toBe(false)
  })
})

describe('readFeedPolls (#1273)', () => {
  // The cron's source scan can assert a log line exists; only this can assert WHEN it fires, and
  // that the verdict it logs is the same one stored beside the value. `polls` non-null on exactly
  // one verdict is the whole point of the shape — assert it on every case, not just the healthy one.
  it('pairs each verdict with what gets stored', () => {
    expect(readFeedPolls(null)).toEqual({ verdict: 'failed', polls: null })
    expect(readFeedPolls(undefined)).toEqual({ verdict: 'failed', polls: null })
    expect(readFeedPolls({ total: 0, byFeed: {} })).toEqual({ verdict: 'zero', polls: null })
    expect(readFeedPolls({ total: 1, byFeed: { claude: { slack: 1 } } }))
      .toEqual({ verdict: 'ok', polls: { claude: { slack: 1 } } })
    // Real polls, nothing classified — what a pre-#1273 24h window looks like on deploy day. Its own
    // verdict: "the window was empty" and "we classified none of it" are different faults, and
    // `total` decides which, so the empty-map check cannot be the one that answers it.
    expect(readFeedPolls({ total: 5095, byFeed: {} })).toEqual({ verdict: 'unclassifiable', polls: null })
    // Only unserved traffic: every derived view drops `__unknown__`, so a map of it is not a
    // measurement of anything and is not stored as one.
    expect(readFeedPolls({ total: 50, byFeed: { __unknown__: { bot: 50 } } }))
      .toEqual({ verdict: 'unclassifiable', polls: null })
  })

  it('stores null — never an empty map — so the stored contract has no empty-map state', () => {
    // `{}` is what a dropped ANALYTICS binding produces: every write is a silent no-op while the
    // query still succeeds. Storing it would assert "read succeeded, every feed had zero polls" in a
    // permanent, reader-less key. `preserveMeasured` defers to the same predicate rather than
    // restating it.
    expect(readFeedPolls({ total: 3, byFeed: {} }).polls).toBeNull()
  })
})

describe('SUBSCRIBER_CLIENTS (#1273)', () => {
  it('is derived from the exhaustive record, so a new class cannot silently opt out', () => {
    expect([...SUBSCRIBER_CLIENTS].sort()).toEqual(['reader', 'slack'])
  })
  it('excludes every non-subscription class', () => {
    for (const c of ['bot', 'browser', 'other']) expect(SUBSCRIBER_CLIENTS).not.toContain(c)
  })
})

describe('rollupByClient (#1273)', () => {
  it('sums the nested map down to per-client totals', () => {
    expect(rollupByClient({ __all__: { slack: 77 }, claude: { slack: 72, bot: 3 } }))
      .toEqual({ slack: 149, bot: 3 })
  })
  it('is empty for an empty map', () => {
    expect(rollupByClient({})).toEqual({})
  })

  it('EXCLUDES __unknown__ — those polls were answered 404, not served', () => {
    expect(rollupByClient({ [FEED_UNKNOWN_TARGET]: { slack: 90 }, claude: { slack: 72 } }))
      .toEqual({ slack: 72 })
  })

  it('survives hostile client keys instead of dropping or rendering them', () => {
    // `out[k] = (out[k] ?? 0) + n` on a plain object silently DROPS a `__proto__` count and renders a
    // `constructor` key as a function body straight into Discord. Same hazard the parser was hardened
    // against; this is the sibling function that consumes its output.
    const byFeed = { claude: Object.fromEntries([['__proto__', 7], ['slack', 2], ['constructor', 5]]) }
    const out = rollupByClient(byFeed as never)
    expect(out.slack).toBe(2)
    expect(out['__proto__']).toBe(7)
    expect(out['constructor']).toBe(5)
    expect(JSON.stringify(out)).not.toContain('native code')
  })
})

describe('subscriberFeeds (#1273)', () => {
  it('lists only feeds a subscriber-class client polled, most-polled first', () => {
    expect(subscriberFeeds({
      claude: { slack: 72 },
      __all__: { slack: 77 },
      mistral: { reader: 30 },
    })).toEqual({ perService: ['claude', 'mistral'], allFeed: true, belowFloor: 0 })
  })

  it('EXCLUDES a crawler-only feed — the whole reason the map is nested', () => {
    // A crawler sweeping every feed would add ~46 keys to a FLAT byFeed and read as 46 new
    // subscribers. This is the assertion that fails if the nesting is ever flattened back.
    expect(subscriberFeeds({ claude: { slack: 72 }, huggingface: { bot: 400 }, mistral: { bot: 4 } }))
      .toEqual({ perService: ['claude'], allFeed: false, belowFloor: 0 })
  })

  it('EXCLUDES browser and other — a one-off human hit and an unrecognised UA are not subscriptions', () => {
    // Documented bias: an unrecognised reader lands in `browser` (Mozilla envelope) or `other`, and
    // either way is undercounted. Accepted — admitting them would let any scraper count as a subscriber.
    expect(subscriberFeeds({ a: { browser: 90 }, b: { other: 90 } })).toEqual({ perService: [], allFeed: false, belowFloor: 0 })
  })

  it('counts a feed polled by BOTH a subscriber and a crawler', () => {
    expect(subscriberFeeds({ claude: { slack: 72, bot: 900 } }).perService).toEqual(['claude'])
  })

  it('breaks ties on the feed name so the order is stable across runs', () => {
    expect(subscriberFeeds({ zeta: { slack: 5 }, alpha: { slack: 5 } }).perService).toEqual(['alpha', 'zeta'])
  })

  it('applies a floor on volume — a single recorded fetch is below it', () => {
    // With an `n > 0` admission a single recorded fetch created a permanent "subscription" in the
    // headline number. The floor is on VOLUME: the dimension carries no client identity, and the
    // value it gates is a sampling-corrected estimate, so this pins the boundary and nothing more.
    // The literal boundary, not `MIN_SUBSCRIBER_REQUESTS ± 1` — expressing it through the constant
    // re-derives whatever value is there, so 3→2 and 3→4 both stayed green.
    expect(MIN_SUBSCRIBER_REQUESTS).toBe(3)
    expect(subscriberFeeds({ mistral: { slack: 1 } }).perService).toEqual([])
    expect(subscriberFeeds({ mistral: { slack: 2 } }).perService).toEqual([])
    expect(subscriberFeeds({ mistral: { slack: 3 } }).perService).toEqual(['mistral'])
    // Suppressed feeds are COUNTED, so `0 per-service` cannot read the same as a quiet window.
    expect(subscriberFeeds({ a: { slack: 2 }, b: { slack: 1 } }).belowFloor).toBe(2)
    expect(subscriberFeeds({ a: { slack: 3 } }).belowFloor).toBe(0)
    // Neither sentinel may enter it: `__all__` is the operator's own, `__unknown__` is unserved.
    expect(subscriberFeeds({ [FEED_ALL_TARGET]: { slack: 2 } }).belowFloor).toBe(0)
    expect(subscriberFeeds({ [FEED_UNKNOWN_TARGET]: { slack: 1 } }).belowFloor).toBe(0)
  })

  it('EXCLUDES the __unknown__ sentinel — a 404 URL is not a subscribable feed', () => {
    expect(subscriberFeeds({ [FEED_UNKNOWN_TARGET]: { slack: 90 }, claude: { slack: 72 } }))
      .toEqual({ perService: ['claude'], allFeed: false, belowFloor: 0 })
  })

  it('orders by COUNT desc, not alphabetically — the cap names the top six, not the first six', () => {
    // Every other fixture happens to tie count-order with alpha-order, so dropping the count key
    // entirely stayed green. `formatSubscribedFeedsLine` slices the first 6.
    expect(subscriberFeeds({ alpha: { slack: 5 }, zeta: { slack: 500 } }).perService).toEqual(['zeta', 'alpha'])
  })

  it('is empty for an empty map', () => {
    expect(subscriberFeeds({})).toEqual({ perService: [], allFeed: false, belowFloor: 0 })
  })
})

describe('queryFeedTraffic (#548)', () => {
  it('returns null without account id / token (no SQL call)', async () => {
    const fetchImpl = vi.fn()
    expect(await queryFeedTraffic(undefined, 'tok', fetchImpl)).toBeNull()
    expect(await queryFeedTraffic('acc', undefined, fetchImpl)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns null on a non-OK HTTP response', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 }))
    expect(await queryFeedTraffic('acc', 'tok', fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it('parses a successful response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ variant: 'feed-all', target: '__all__', client: 'slack', requests: 7 }] }), { status: 200 }))
    expect(await queryFeedTraffic('acc', 'tok', fetchImpl as unknown as typeof fetch)).toEqual({
      all: 7, service: 0, total: 7, byFeed: { __all__: { slack: 7 } },
    })
  })
})

describe('recordBadgeTraffic (#1157)', () => {
  it('writes the serviceId as blob1 for a known-service outcome', () => {
    const writeDataPoint = vi.fn()
    recordBadgeTraffic({ writeDataPoint } as unknown as AnalyticsEngineDataset, { known: true, serviceId: 'claude' })
    expect(writeDataPoint).toHaveBeenCalledWith({ blobs: ['claude'], doubles: [1], indexes: ['badge-request'] })
    recordBadgeTraffic({ writeDataPoint } as unknown as AnalyticsEngineDataset, { known: true, serviceId: 'openai' })
    expect(writeDataPoint).toHaveBeenLastCalledWith({ blobs: ['openai'], doubles: [1], indexes: ['badge-request'] })
  })

  it('substitutes the BADGE_UNKNOWN_SERVICE sentinel for a known:false outcome — never a raw string', () => {
    const writeDataPoint = vi.fn()
    recordBadgeTraffic({ writeDataPoint } as unknown as AnalyticsEngineDataset, { known: false })
    expect(writeDataPoint).toHaveBeenCalledWith({ blobs: [BADGE_UNKNOWN_SERVICE], doubles: [1], indexes: ['badge-request'] })
  })

  it('is a no-op when the binding is absent (local dev / tests)', () => {
    expect(() => recordBadgeTraffic(undefined, { known: true, serviceId: 'claude' })).not.toThrow()
    expect(() => recordBadgeTraffic(undefined, { known: false })).not.toThrow()
  })

  it('swallows a writeDataPoint throw (never aborts the badge response)', () => {
    const writeDataPoint = vi.fn(() => { throw new Error('WAE down') })
    expect(() => recordBadgeTraffic({ writeDataPoint } as unknown as AnalyticsEngineDataset, { known: true, serviceId: 'claude' })).not.toThrow()
  })
})

describe('buildBadgeTrafficSql (#1157)', () => {
  it('filters on index1 = badge-request over the last day, grouped by blob1', () => {
    const sql = buildBadgeTrafficSql()
    expect(sql).toContain("index1 = 'badge-request'")
    expect(sql).toContain('GROUP BY blob1')
    expect(sql).toContain('SUM(_sample_interval)')
    expect(sql).toContain("INTERVAL '1' DAY")
  })
})

describe('parseBadgeTrafficResponse (#1157)', () => {
  it('sums requests per service and totals across all services', () => {
    const json = { data: [{ service: 'claude', requests: '12' }, { service: 'openai', requests: 5 }, { service: 'claude', requests: 3 }] }
    expect(parseBadgeTrafficResponse(json)).toEqual({ byService: { claude: 15, openai: 5 }, total: 20 })
  })

  it('returns null for a malformed payload', () => {
    expect(parseBadgeTrafficResponse({})).toBeNull()
    expect(parseBadgeTrafficResponse(null)).toBeNull()
  })

  it('skips rows with a missing/non-string service label and coerces NaN requests to 0', () => {
    const json = { data: [{ service: 'claude', requests: 'oops' }, { requests: 9 }, { service: '', requests: 9 }] }
    expect(parseBadgeTrafficResponse(json)).toEqual({ byService: { claude: 0 }, total: 0 })
  })
})

describe('queryBadgeTraffic (#1157)', () => {
  it('returns null without account id / token (no SQL call)', async () => {
    const fetchImpl = vi.fn()
    expect(await queryBadgeTraffic(undefined, 'tok', fetchImpl)).toBeNull()
    expect(await queryBadgeTraffic('acc', undefined, fetchImpl)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns null on a non-OK HTTP response', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 }))
    expect(await queryBadgeTraffic('acc', 'tok', fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it('parses a successful response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ service: 'claude', requests: 7 }] }), { status: 200 }))
    expect(await queryBadgeTraffic('acc', 'tok', fetchImpl as unknown as typeof fetch)).toEqual({ byService: { claude: 7 }, total: 7 })
  })
})

describe('countFirstSeenWithin24h (#748)', () => {
  const NOW = new Date('2026-06-23T00:00:00.000Z')
  it('counts only timestamps within the 24h window ending at now', () => {
    const values = [
      '2026-06-22T23:00:00.000Z', // 1h ago — in
      '2026-06-22T00:30:00.000Z', // 23.5h ago — in
      '2026-06-21T23:00:00.000Z', // 25h ago — out
      '2026-06-23T00:00:00.000Z', // exactly now — in (inclusive)
    ]
    expect(countFirstSeenWithin24h(values, NOW)).toBe(3)
  })
  it('skips null / empty / unparseable values', () => {
    expect(countFirstSeenWithin24h([null, undefined, '', 'not-a-date', '2026-06-22T23:00:00.000Z'], NOW)).toBe(1)
  })
  it('returns 0 for an empty list', () => {
    expect(countFirstSeenWithin24h([], NOW)).toBe(0)
  })
})

describe('countNewFeedItems (#748)', () => {
  const NOW = new Date('2026-06-23T00:00:00.000Z')
  const kvOf = (entries: Record<string, string>, opts: { listThrows?: boolean; getThrows?: boolean } = {}) => ({
    list: vi.fn(async () => {
      if (opts.listThrows) throw new Error('kv list down')
      return { keys: Object.keys(entries).map((name) => ({ name })), list_complete: true }
    }),
    get: vi.fn(async (k: string) => {
      if (opts.getThrows) throw new Error('kv get down')
      return entries[k] ?? null
    }),
  }) as unknown as KVNamespace

  it('lists feed:firstseen markers and counts those in the last 24h', async () => {
    const kv = kvOf({
      'feed:firstseen:a': '2026-06-22T23:00:00.000Z', // in
      'feed:firstseen:b': '2026-06-20T00:00:00.000Z', // out (3d ago)
      'feed:firstseen:c': '2026-06-22T12:00:00.000Z', // in
    })
    expect(await countNewFeedItems(kv, NOW)).toBe(2)
  })
  it('returns 0 when there are no markers', async () => {
    expect(await countNewFeedItems(kvOf({}), NOW)).toBe(0)
  })
  it('returns null (best-effort) when KV list throws', async () => {
    expect(await countNewFeedItems(kvOf({}, { listThrows: true }), NOW)).toBeNull()
  })
  it('treats a failed per-key get as absent (not a throw)', async () => {
    const kv = kvOf({ 'feed:firstseen:a': '2026-06-22T23:00:00.000Z' }, { getThrows: true })
    expect(await countNewFeedItems(kv, NOW)).toBe(0)
  })
})

describe('ext-claude traffic (#837)', () => {
  it('buildExtTrafficSql filters index1=ext-claude, 24h window, single total', () => {
    const sql = buildExtTrafficSql()
    expect(sql).toContain("index1 = 'ext-claude'")
    expect(sql).toContain('SUM(_sample_interval) AS requests')
    expect(sql).toContain('FROM aiwatch_statusline')
    expect(sql).toContain("INTERVAL '1' DAY")
    expect(sql).not.toContain('GROUP BY') // single total, no variant split
  })

  it('parseExtTrafficResponse reads the single total (tolerant of string/number)', () => {
    expect(parseExtTrafficResponse({ data: [{ requests: '4212' }] })).toBe(4212)
    expect(parseExtTrafficResponse({ data: [{ requests: 7 }] })).toBe(7)
    expect(parseExtTrafficResponse({ data: [{ requests: 'nope' }] })).toBe(0) // unparseable → 0
    expect(parseExtTrafficResponse({ data: [] })).toBeNull() // no rows → null
    expect(parseExtTrafficResponse({})).toBeNull()
    expect(parseExtTrafficResponse(null)).toBeNull()
  })

  it('queryExtTraffic returns null without creds and never throws on failure', async () => {
    expect(await queryExtTraffic(undefined, undefined)).toBeNull()
    const boom = vi.fn().mockRejectedValue(new Error('network'))
    expect(await queryExtTraffic('acc', 'tok', boom as unknown as typeof fetch)).toBeNull()
    const notOk = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    expect(await queryExtTraffic('acc', 'tok', notOk as unknown as typeof fetch)).toBeNull()
  })

  it('queryExtTraffic parses a successful response', async () => {
    const ok = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ requests: 123 }] }) })
    expect(await queryExtTraffic('acc', 'tok', ok as unknown as typeof fetch)).toBe(123)
  })
})

describe('statusline traffic (#918)', () => {
  it('buildStatuslineTrafficSql filters index1 LIKE statusline-%, 24h window, per-preset group', () => {
    const sql = buildStatuslineTrafficSql()
    expect(sql).toContain("index1 LIKE 'statusline-%'")
    expect(sql).toContain('index1 AS preset')
    expect(sql).toContain('SUM(_sample_interval) AS requests')
    expect(sql).toContain('FROM aiwatch_statusline')
    expect(sql).toContain("INTERVAL '1' DAY")
    expect(sql).toContain('GROUP BY index1') // per-preset (index1 is multi-valued, unlike ext-claude)
  })

  it('parseStatuslineTrafficResponse strips the prefix, sums per-preset + total (string/number tolerant)', () => {
    const json = { data: [
      { preset: 'statusline-branded', requests: '120' },
      { preset: 'statusline-degraded_only', requests: 45 },
      { preset: 'statusline-clickable', requests: 'nope' }, // unparseable → 0
    ] }
    expect(parseStatuslineTrafficResponse(json)).toEqual({
      byPreset: { branded: 120, degraded_only: 45, clickable: 0 },
      serverRenderTotal: 165,
      legacyProxy: 0,
      total: 165,
    })
  })

  it('parseStatuslineTrafficResponse routes the legacy `proxy` catch-all into legacyProxy, not byPreset (#944)', () => {
    const json = { data: [
      { preset: 'statusline-proxy', requests: 9888 },        // legacy jq cohort → legacyProxy, NOT a preset
      { preset: 'statusline-branded', requests: 2693 },
      { preset: 'statusline-degraded_only', requests: 91 },
    ] }
    expect(parseStatuslineTrafficResponse(json)).toEqual({
      byPreset: { branded: 2693, degraded_only: 91 },
      serverRenderTotal: 2784,   // proxy excluded from the adoption signal
      legacyProxy: 9888,
      total: 12672,              // grand total still spans both cohorts
    })
  })

  it('parseStatuslineTrafficResponse ignores rows whose index1 is not a statusline- tag', () => {
    const json = { data: [
      { preset: 'statusline-branded', requests: 10 },
      { preset: 'ext-claude', requests: 999 },   // wrong tag (LIKE guard belt-and-suspenders) → skipped
      { preset: null, requests: 5 },             // invalid → skipped
    ] }
    expect(parseStatuslineTrafficResponse(json)).toEqual({
      byPreset: { branded: 10 }, serverRenderTotal: 10, legacyProxy: 0, total: 10,
    })
  })

  it('parseStatuslineTrafficResponse returns null on malformed shape, empty on no rows', () => {
    expect(parseStatuslineTrafficResponse({})).toBeNull()
    expect(parseStatuslineTrafficResponse(null)).toBeNull()
    expect(parseStatuslineTrafficResponse({ data: [] })).toEqual({
      byPreset: {}, serverRenderTotal: 0, legacyProxy: 0, total: 0,
    })
  })

  it('serializeStatuslineSnapshot emits compact {sr,lp} for the day-over-day snapshot (#944)', () => {
    expect(serializeStatuslineSnapshot({ byPreset: { branded: 2693 }, serverRenderTotal: 2784, legacyProxy: 9888, total: 12672 }))
      .toBe('{"sr":2784,"lp":9888}')
  })

  it('computeStatuslineDelta diffs each cohort vs yesterday; null per cohort on no/corrupt baseline (#944)', () => {
    const today = { byPreset: { branded: 2693 }, serverRenderTotal: 2784, legacyProxy: 9888, total: 12672 }
    // fresh baseline → per-cohort signed delta
    expect(computeStatuslineDelta(today, '{"sr":2472,"lp":10428}')).toEqual({ serverRender: 312, legacyProxy: -540 })
    // no baseline (first day / empty) → null per cohort, NOT a bogus full-count jump
    expect(computeStatuslineDelta(today, null)).toEqual({ serverRender: null, legacyProxy: null })
    expect(computeStatuslineDelta(today, '   ')).toEqual({ serverRender: null, legacyProxy: null })
    // corrupt (non-JSON) baseline → null per cohort
    expect(computeStatuslineDelta(today, 'not-json')).toEqual({ serverRender: null, legacyProxy: null })
    // partially-present baseline → only the parseable cohort deltas
    expect(computeStatuslineDelta(today, '{"sr":2000}')).toEqual({ serverRender: 784, legacyProxy: null })
  })

  it('queryStatuslineTraffic returns null without creds and never throws on failure', async () => {
    expect(await queryStatuslineTraffic(undefined, undefined)).toBeNull()
    const boom = vi.fn().mockRejectedValue(new Error('network'))
    expect(await queryStatuslineTraffic('acc', 'tok', boom as unknown as typeof fetch)).toBeNull()
    const notOk = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    expect(await queryStatuslineTraffic('acc', 'tok', notOk as unknown as typeof fetch)).toBeNull()
  })

  it('queryStatuslineTraffic parses a successful response', async () => {
    const ok = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
      { preset: 'statusline-branded', requests: 88 },
      { preset: 'statusline-scoped', requests: 12 },
    ] }) })
    expect(await queryStatuslineTraffic('acc', 'tok', ok as unknown as typeof fetch)).toEqual({
      byPreset: { branded: 88, scoped: 12 }, serverRenderTotal: 100, legacyProxy: 0, total: 100,
    })
  })
})

describe('plugin traffic (#920)', () => {
  it('buildPluginTrafficSql filters index1 IN (aiwatch-monitor, aiwatch-brief), 24h, per-tag', () => {
    const sql = buildPluginTrafficSql()
    expect(sql).toContain("index1 IN ('aiwatch-monitor', 'aiwatch-brief')")
    expect(sql).toContain('SUM(_sample_interval) AS requests')
    expect(sql).toContain('FROM aiwatch_statusline')
    expect(sql).toContain("INTERVAL '1' DAY")
    expect(sql).toContain('GROUP BY index1')
    expect(sql).not.toContain("LIKE 'statusline-%'") // must NOT pull the statusline preset metric
  })

  it('parsePluginTrafficResponse splits monitor vs brief (string/number tolerant)', () => {
    const json = { data: [
      { tag: 'aiwatch-monitor', requests: '1440' },
      { tag: 'aiwatch-brief', requests: 12 },
      { tag: 'statusline-branded', requests: 999 }, // wrong tag → ignored
    ] }
    expect(parsePluginTrafficResponse(json)).toEqual({ monitor: 1440, brief: 12 })
  })

  it('parsePluginTrafficResponse null on malformed, zeros on no rows', () => {
    expect(parsePluginTrafficResponse({})).toBeNull()
    expect(parsePluginTrafficResponse(null)).toBeNull()
    expect(parsePluginTrafficResponse({ data: [] })).toEqual({ monitor: 0, brief: 0 })
  })

  it('queryPluginTraffic returns null without creds and never throws on failure', async () => {
    expect(await queryPluginTraffic(undefined, undefined)).toBeNull()
    const boom = vi.fn().mockRejectedValue(new Error('network'))
    expect(await queryPluginTraffic('acc', 'tok', boom as unknown as typeof fetch)).toBeNull()
    const notOk = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    expect(await queryPluginTraffic('acc', 'tok', notOk as unknown as typeof fetch)).toBeNull()
  })

  it('queryPluginTraffic parses a successful response', async () => {
    const ok = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
      { tag: 'aiwatch-monitor', requests: 720 },
      { tag: 'aiwatch-brief', requests: 5 },
    ] }) })
    expect(await queryPluginTraffic('acc', 'tok', ok as unknown as typeof fetch)).toEqual({ monitor: 720, brief: 5 })
  })
})

// #1227 — the instrument that exists so the NEXT unusable-snapshot incident can name its own
// cause. `cacheRead` returns `null` for every one of them, which is right for callers and useless for
// diagnosis; this is where the difference is kept. Which outcome each branch records is a wiring
// question, covered in statusline-wiring.test.ts.
describe('recordCacheReadOutcome (#1227)', () => {
  const OUTCOMES = Object.keys({
    'no-binding': 0, threw: 0, miss: 0, unparsed: 0, empty: 0,
  } satisfies Record<CacheReadOutcome, 0>) as CacheReadOutcome[]

  it('writes one data point per outcome with the pinned blob/double/index shape', () => {
    for (const outcome of OUTCOMES) {
      const wae = { writeDataPoint: vi.fn() }
      recordCacheReadOutcome(wae as unknown as AnalyticsEngineDataset, outcome)
      expect(wae.writeDataPoint).toHaveBeenCalledOnce()
      expect(wae.writeDataPoint).toHaveBeenCalledWith({
        blobs: [outcome],
        doubles: [1],
        indexes: [CACHE_READ_INDEX],
      })
    }
  })

  it('shares ONE index so every snapshot-read failure is queryable in a single filter', () => {
    expect(CACHE_READ_INDEX).toBe('cache-read')
  })

  it('is a no-op without a binding (local dev / tests) rather than throwing', () => {
    expect(() => recordCacheReadOutcome(undefined, 'miss')).not.toThrow()
  })

  it('never lets a WAE failure escape into the read path it instruments', () => {
    const wae = { writeDataPoint: vi.fn(() => { throw new Error('WAE down') }) }
    expect(() => recordCacheReadOutcome(wae as unknown as AnalyticsEngineDataset, 'threw')).not.toThrow()
  })
})

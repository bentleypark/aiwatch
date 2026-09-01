// Public API traffic instrumentation (#518)
//
// /api/v1/status is otherwise unmeasurable: the in-memory rate limiter isn't a persisted
// counter, Workers analytics don't break down by URL path, and the worker runs on a
// workers.dev subdomain (no zone-level HTTP analytics). This records one Analytics Engine
// data point per served (non-429) v1 request, mirroring the #494 statusline pattern, so the
// call volume becomes queryable via the Cloudflare GraphQL Analytics API.
//
// Schema (dataset: aiwatch_statusline, binding env.ANALYTICS):
//   index1  = constant 'v1-status'           → total v1 traffic via one index filter (≤32 bytes)
//   blob1   = 'v1-status-all'|'v1-status-service' → optional all-vs-per-service split
//   double1 = 1                              → request counter (SUM in GraphQL queries)

// AnalyticsEngineDataset is a global ambient type from @cloudflare/workers-types.

export type V1Variant = 'v1-status-all' | 'v1-status-service'

// Shared index dimension. WAE index entries are capped at 32 bytes; 'v1-status' is well under.
const V1_INDEX = 'v1-status'

/**
 * Classify a /api/v1/status request path: bare endpoint = all-services, else per-service.
 * Note: recordV1Traffic runs before the handler's path validation, so blob1='v1-status-service'
 * also includes malformed/404 per-service paths (e.g. /api/v1/status/Bad$ID). The clean,
 * noise-free signal is the index1='v1-status' total; treat the per-service blob split as approximate.
 */
export function v1Variant(pathname: string): V1Variant {
  return pathname === '/api/v1/status' || pathname === '/api/v1/status/'
    ? 'v1-status-all'
    : 'v1-status-service'
}

/**
 * Record one v1-traffic data point. Best-effort: guarded on the optional binding (absent in
 * local dev / tests) and wrapped in try/catch so a WAE failure never aborts the API response.
 */
export function recordV1Traffic(
  analytics: AnalyticsEngineDataset | undefined,
  pathname: string,
): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint({
      blobs: [v1Variant(pathname)],
      doubles: [1],
      indexes: [V1_INDEX],
    })
  } catch (err) {
    console.warn('[wae] v1 writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

export interface V1TrafficCounts {
  all: number      // /api/v1/status (all-services) requests
  service: number  // /api/v1/status/:id requests (incl. malformed/404 per-service paths)
  total: number    // all + service
}

// ── Feed-poll traffic (#548, extended #1273) ──────────────────────────────
// The RSS feeds (/feed.xml + /feed/:slug) are the consent-free retention proxy GA4 can't give:
// a step-up in poll volume after an outage = retained RSS/Slack subscribers. Mirrors the v1
// pattern above on the SAME dataset, distinguished by a separate index ('feed-poll').
//   index1  = 'feed-poll'                     → total feed traffic via one index filter
//   blob1   = 'feed-all' | 'feed-service'     → /feed.xml vs /feed/:slug split
//   blob2   = feed target (#1273)             → service id | FEED_ALL_TARGET | FEED_UNKNOWN_TARGET
//   blob3   = client class (#1273)            → a `FeedClientClass` (the union owns the list)
//   double1 = 1                               → request counter (SUM in AE SQL)
//
// #1273 — WHY blob2/blob3 exist. blob1 alone answers "how many polls", which nobody reading it later
// can turn into "how many subscriptions": every poller shares one anonymous URL. blob2 says WHICH
// feed, blob3 says WHAT KIND of client — two facts the path and the headers already carry at the call
// site, and that this module used to discard.
//
// Read the RESULT as a trend, never as a subscriber count. Converting polls to subscriptions needs a
// per-client cadence we neither own nor measure, so this module does not attempt it and no comment
// here should quote one. `subscriberFeeds` below exists precisely so the headline signal needs no
// such divisor.
/** feed target → client class → poll count. Named so `FeedTrafficCounts.byFeed` and
 *  `GrowthDailyRow.feedPolls` are visibly the same fact rather than two identical spellings. */
export type FeedPollsByTarget = Record<string, Record<string, number>>

export type FeedVariant = 'feed-all' | 'feed-service'

/**
 * Does this stored value represent a MEASUREMENT?
 *
 * The single definition of that question. It used to be answered at each site that asked, and the
 * sites disagreed: the writer stored `{}` as a measured all-zero window while `preserveMeasured`
 * treated the same value as no measurement at all. One predicate, referenced everywhere.
 *
 * An empty map is not a measurement. Zero rows matched `index1='feed-poll'` over 24h, and the worker
 * writes a point on every feed request — so an empty window is either no traffic at all or a recorder
 * that wrote nothing (a dropped/renamed ANALYTICS binding makes every write a silent no-op while the
 * query still succeeds). Those are indistinguishable here, and neither is a count of subscribers.
 */
export function isMeasuredFeedPolls(v: unknown): v is FeedPollsByTarget {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const feeds = Object.values(v as Record<string, unknown>)
  if (feeds.length === 0) return false
  // Validated to the depth the `v is` promises. A shallow check admitted `{claude: 5}` and
  // `{claude: null}`, and `preserveMeasured` — whose only input validation is `isRow` (a string
  // `date`) — then resurrected them over an honest failure, leaving the first reader to throw.
  return feeds.every((perClient) => {
    if (typeof perClient !== 'object' || perClient === null || Array.isArray(perClient)) return false
    const counts = Object.values(perClient as Record<string, unknown>)
    // Non-empty at this level too: `{claude: {}}` is the same "the recorder wrote nothing" shape as
    // `{}`, one level down, and would otherwise store and render as a measurement.
    return counts.length > 0 && counts.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
  })
}

/** What one day's feed read produced. `polls` is non-null on exactly one verdict, so a caller cannot
 *  log one story and store another — the two used to be separate functions over the same input and
 *  the wiring test existed solely to prove they were handed the same argument. */
export type FeedPollsVerdict = 'ok' | 'failed' | 'zero' | 'unclassifiable'
export type FeedPollsRead =
  | { verdict: 'ok'; polls: FeedPollsByTarget }
  | { verdict: Exclude<FeedPollsVerdict, 'ok'>; polls: null }

/**
 * Judge one day's feed read: what to STORE and what to SAY about it, as one value.
 *
 * `polls` is `null` on every verdict but `ok`, and `verdict` is stored beside it — so `null` is no
 * longer four different facts wearing one spelling. It used to mean "the AE query failed" by
 * documentation and "failed, or a quiet window, or thousands of polls none of which carried the
 * blobs" in practice, in a permanent no-TTL series whose first reader does not exist yet. The run
 * already knew which; it wrote the answer to a log Workers discards within days and the durable row
 * got the ambiguous half.
 *
 * `zero` vs `unclassifiable` is decided by `total`, not by which check ran first: a window can report
 * polls while classifying none of them (every row missing blob2/blob3 — what a pre-#1273 24h window
 * looks like on the day of deploy), and calling that "the recorder wrote no rows" names the wrong
 * fault. `unclassifiable` also covers a window holding only `__unknown__`: every derived view drops
 * that key, so there is nothing to show and nothing worth storing as a measurement.
 */
export function readFeedPolls(
  feed: Pick<FeedTrafficCounts, 'total' | 'byFeed'> | null | undefined,
): FeedPollsRead {
  if (!feed) return { verdict: 'failed', polls: null }
  if (!isMeasuredFeedPolls(feed.byFeed)) {
    return { verdict: feed.total === 0 ? 'zero' : 'unclassifiable', polls: null }
  }
  if (!Object.keys(feed.byFeed).some((f) => f !== FEED_UNKNOWN_TARGET)) {
    return { verdict: 'unclassifiable', polls: null }
  }
  return { verdict: 'ok', polls: feed.byFeed }
}

/** Client classes for blob3. `reader` is a NAMED-reader allowlist (see FEED_CLIENT_MATCHERS), not
 *  "any feed reader": an unrecognised reader shipping a `Mozilla/…` envelope lands in
 *  `browser`; one sending no recognisable token lands in `other`. */
export type FeedClientClass = 'slack' | 'reader' | 'bot' | 'browser' | 'other'

const FEED_INDEX = 'feed-poll'

/** blob2 sentinel for /feed.xml (the all-services feed). Pinned against collision with a real service
 *  id/slug by `feed-poll-instrumentation-wiring.test.ts` — the same claim `BADGE_UNKNOWN_SERVICE`
 *  makes and (deliberately) does not enforce. */
export const FEED_ALL_TARGET = '__all__'
/** blob2 sentinel for a /feed/:slug segment matching no known feed — see the cardinality note on
 *  `feedTarget`. Collision-pinned like FEED_ALL_TARGET above. NOT a subscribable feed: traffic to it
 *  is by definition traffic to a URL we do not serve, so `subscriberFeeds` excludes it. */
export const FEED_UNKNOWN_TARGET = '__unknown__'

/** Classify a feed request path: /feed.xml = all-services, /feed/:slug = per-service. */
export function feedVariant(pathname: string): FeedVariant {
  return pathname === '/feed.xml' ? 'feed-all' : 'feed-service'
}

/**
 * Resolve a feed request path to the blob2 target: the canonical SERVICE ID (not the URL slug, so
 * this dimension lines up with `growth:daily` and the rest of the codebase), `FEED_ALL_TARGET` for
 * /feed.xml, or `FEED_UNKNOWN_TARGET` for anything else. Pure.
 *
 * The lookup is mandatory, not cosmetic: `/feed/<anything>` is caller-controlled and public, so
 * recording the raw segment would make blob2 cardinality unbounded and inflatable by anyone hitting
 * /feed/<random> in a loop. Collapsing every miss into one sentinel keeps it bounded by
 * (known feeds + 2) regardless of input — the same guard `BADGE_UNKNOWN_SERVICE` provides for
 * /badge/:serviceId (#1157) and `parsePageviewBody`'s `validIds` provides for the audience beacon.
 */
export function feedTarget(pathname: string, slugToId: ReadonlyMap<string, string>): string {
  if (pathname === '/feed.xml') return FEED_ALL_TARGET
  const segment = pathname.split('/')[2] ?? ''
  return slugToId.get(segment) ?? FEED_UNKNOWN_TARGET
}

// Ordered classifiers for `classifyFeedClient`: a real user-agent can match several, and the first
// match wins. WHICH orderings are load-bearing is decided by the UA literals in api-traffic.test.ts;
// four successive attempts to enumerate them here each shipped a claim the tests did not hold, so the
// enumeration is gone rather than corrected a fifth time.
//
// All four are best-effort string matching over third-party UA strings and are wrong in BOTH
// directions at the margins — no delimiter set separates `Googlebot-Image` from a handset model like
// `CUBOT-P30`. That error is not contained: the class is a KEY of `byFeed`, which lands in the
// permanent `growth:daily` series, and a named reader misread as `bot` drops OUT of `subscriberFeeds`.
const FEED_CLIENT_MATCHERS: ReadonlyArray<readonly [FeedClientClass, RegExp]> = [
  ['slack', /^slackbot(?![-\w])/i],
  ['bot', /bot[/;),\]-]|bot$|crawl|spider|scrap|slurp|headless|curl\/|wget|python-requests|go-http|okhttp|libwww|httpclient/i],
  ['reader', /feedly|inoreader|newsblur|feedbin|netvibes|theoldreader|bazqux|miniflux|freshrss|tt-rss|tiny tiny rss|akregator|reeder|feedspot|liferea|nextcloud-news/i],
  ['browser', /mozilla|webkit|gecko|chrome|safari|firefox|edge\//i],
]

/**
 * Bucket a request's user-agent into a `FeedClientClass`. Pure, and the RAW user-agent is never
 * returned or stored — only the fixed enum reaches WAE, the same discipline `classifyReferrer`
 * applies to referrer hosts (#1055): free text from the network does not become a dimension value.
 * A missing or unrecognised UA falls through to `other` — absence is not evidence.
 */
export function classifyFeedClient(userAgent: string | null | undefined): FeedClientClass {
  const ua = userAgent ?? ''
  for (const [cls, re] of FEED_CLIENT_MATCHERS) if (re.test(ua)) return cls
  return 'other'
}

/**
 * Record one feed-poll data point. Best-effort (guarded binding + try/catch), like recordV1Traffic.
 *
 * `slugToId` and `userAgent` are REQUIRED rather than optional on purpose. An optional dimension is
 * how a derived set silently re-empties: a call site that forgets one keeps compiling and keeps
 * writing rows that look like real traffic while the new breakdown reads as "nobody polled" (#970).
 * Required params make `tsc` name every call site instead.
 */
export function recordFeedTraffic(
  analytics: AnalyticsEngineDataset | undefined,
  // The parsed `URL`, NOT a path string. Both `url.pathname` and `request.url` are `string`, so a
  // `string` parameter let the whole-URL form type-check, keep every source-scan assertion matching,
  // and pass 4615 tests — while `feedVariant` could never see `/feed.xml` (blob1 permanently
  // `feed-service`) and `split('/')[2]` yielded the HOST (blob2 permanently `__unknown__`). Taking
  // the object moves that guard from a scan to tsc.
  url: URL,
  slugToId: ReadonlyMap<string, string>,
  userAgent: string | null | undefined,
): void {
  if (!analytics) return
  const pathname = url.pathname
  try {
    analytics.writeDataPoint({
      blobs: [feedVariant(pathname), feedTarget(pathname, slugToId), classifyFeedClient(userAgent)],
      doubles: [1],
      indexes: [FEED_INDEX],
    })
  } catch (err) {
    console.warn('[wae] feed writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

export interface FeedTrafficCounts {
  all: number      // /feed.xml polls
  service: number  // /feed/:slug polls
  total: number    // all + service
  // #1273 — polls per feed target (blob2) BROKEN DOWN BY client class (blob3), i.e. exactly the rows
  // the AE SQL `GROUP BY blob1, blob2, blob3` already returns. Bounded by (known feeds + 2) ×
  // FeedClientClass.
  //
  // NESTED, not two flat maps, and this is the whole point of the shape. Flat `byFeed` + flat
  // `byClient` cannot answer "which feeds did a SUBSCRIBER poll" — and the headline signal this
  // dataset exists to produce is exactly that: a feed appearing in the set for the first time means
  // somebody subscribed to it (a count with no divisor, unlike polls ÷ cadence). A crawler sweeping
  // every feed would add ~46 keys to a flat byFeed at once and be indistinguishable from 46 new
  // subscribers, destroying that signal — which is the conflation this dimension was added to end.
  //
  // A key is ABSENT when that target/class had no polls in the window. What an absent MAP means is
  // `GrowthDailyRow.feedPolls`'s contract, stated there.
  //
  // The per-class rollup is DERIVED (`rollupByClient`), never stored beside this: two representations
  // of one fact in one row is a drift waiting to happen.
  byFeed: FeedPollsByTarget
}

/** The column aliases this query emits, which `parseFeedTrafficResponse` reads back by name. Shared
 *  so an alias rename lands on both sides at once. This pins the NAMES only; the blob POSITION →
 *  meaning mapping is pinned by the record-site test, not by this constant. */
export const FEED_SQL_COLUMNS = { variant: 'variant', target: 'target', client: 'client', requests: 'requests' } as const

/** AE SQL summing the last-24h feed poll count per variant, target and client class
 *  (sampling-corrected via SUM(_sample_interval)). */
export function buildFeedTrafficSql(dataset = V1_DATASET): string {
  const c = FEED_SQL_COLUMNS
  return (
    `SELECT blob1 AS ${c.variant}, blob2 AS ${c.target}, blob3 AS ${c.client}, SUM(_sample_interval) AS ${c.requests} ` +
    `FROM ${dataset} ` +
    `WHERE index1 = '${FEED_INDEX}' AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `GROUP BY blob1, blob2, blob3 ` +
    `FORMAT JSON`
  )
}

/**
 * One cell of the AE `requests` column → a usable count, or `null` when it is not one. Rejects
 * everything `Number()` silently turns into a finite 0 (`null`, `''`, `[]`, `false`, whitespace) and
 * anything negative — both reach the caller as "a measured zero" and are then stored forever. Pure.
 */
function parseRequestCount(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw
    : typeof raw === 'string' && raw.trim() !== '' ? Number(raw)
    : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Parse the AE SQL feed-traffic JSON into per-variant, per-target and per-client counts. Tolerant of
 * string/number `requests` and of rows predating #1273 (no blob2/blob3): such a row still contributes
 * its variant total, and simply adds nothing to the two breakdowns rather than inventing a bucket for
 * it. The variant totals therefore remain comparable across the deploy boundary — the property #1055
 * broke when it repointed a field's meaning under its old name.
 */
export function parseFeedTrafficResponse(json: unknown): FeedTrafficCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) {
    // The parse case; `queryFeedTraffic` logs the HTTP, throw and creds cases separately.
    console.warn('[wae] feed SQL response has no `data` array — feed poll breakdown unavailable')
    return null
  }
  let all = 0
  let service = 0
  // A Map, not an object literal: `r.target` is a string from the network, and `byFeed[r.target] ??= {}`
  // on the literal `__proto__` reads back Object.prototype (truthy, so `??=` never assigns) and then
  // writes onto it — polluting the prototype for the isolate while `byFeed` comes out empty, i.e.
  // invisibly. `feedTarget` bounds blob2 today so no such row can be produced, but this function takes
  // its input from the network and must not depend on a guarantee established two layers away.
  const byFeed = new Map<string, Map<string, number>>()
  for (const row of data) {
    const r = row as Record<string, unknown>
    const variant = r[FEED_SQL_COLUMNS.variant]
    const target = r[FEED_SQL_COLUMNS.target]
    const client = r[FEED_SQL_COLUMNS.client]
    const parsed = parseRequestCount(r[FEED_SQL_COLUMNS.requests])
    const n = parsed ?? 0
    const counted = variant === 'feed-all' || variant === 'feed-service'
    if (variant === 'feed-all') all += n
    else if (variant === 'feed-service') service += n
    // A pre-#1273 row carries neither blob, and a partially-written one could carry only one. Both
    // still count toward the variant totals above; neither invents a bucket here.
    //
    // An UNREADABLE `requests` also creates no bucket. Creating one would store a hard `0`, and this
    // field's own contract reads a key present-with-0 as a measured zero — so an unreadable count
    // would become a measured zero, permanently, in a no-TTL series. Absent is the honest state.
    // `parseRequestCount`, not `Number()`: the coercion this line used to make read `null`, `''`,
    // `[]`, `false` and `' '` as a finite 0 and built the very bucket this sentence forbids.
    // `counted` gates the bucket on the SAME predicate as the totals above. Without it a row with an
    // unrecognised variant contributes to `byFeed` but to neither total, so the rendered breakdown can
    // exceed its own headline and the residual goes negative behind a `> 0` guard.
    if (counted && parsed !== null && typeof target === 'string' && target && typeof client === 'string' && client) {
      let perClient = byFeed.get(target)
      if (!perClient) byFeed.set(target, (perClient = new Map()))
      perClient.set(client, (perClient.get(client) ?? 0) + n)
    }
  }
  return {
    all,
    service,
    total: all + service,
    // `Object.fromEntries` defines OWN properties, so a `__proto__` key round-trips as data.
    byFeed: Object.fromEntries([...byFeed].map(([f, m]) => [f, Object.fromEntries(m)])),
  }
}

/**
 * Which client classes represent an actual SUBSCRIPTION — a client polling on a schedule because
 * somebody asked it to.
 *
 * A `Record` keyed by the union, NOT an array, and that is the whole point: a `readonly
 * FeedClientClass[]` carries no exhaustiveness obligation, so adding a sixth class compiles clean,
 * lands outside the list, and silently undercounts the headline signal forever. `outage-audience.ts`
 * writes that exact lesson down for `AUDIENCE_SOURCES` ("tsc does NOT catch this") and pins it with a
 * test; a Record literal keyed by the union IS the tsc-checked site, so a new class cannot be added
 * without deciding — here, where the reason for each decision is written.
 */
const FEED_CLIENT_IS_SUBSCRIBER: Record<FeedClientClass, boolean> = {
  slack: true,
  reader: true,
  bot: false, // a crawler
  browser: false, // a person looking once — and, per FeedClientClass, an unrecognised reader
  other: false, // no recognisable token at all; see subscriberFeeds for the undercount this accepts
}

/** The subscriber-class members, derived from the exhaustive record above. */
export const SUBSCRIBER_CLIENTS: readonly FeedClientClass[] =
  (Object.keys(FEED_CLIENT_IS_SUBSCRIBER) as FeedClientClass[]).filter((c) => FEED_CLIENT_IS_SUBSCRIBER[c])

/**
 * Minimum subscriber-class REQUESTS in the window before a feed counts as subscribed.
 *
 * Requests, not polls: the value it gates is `SUM(_sample_interval)` from the AE query, a
 * sampling-corrected request estimate. It is a floor on volume, nothing more — the stored dimension
 * carries no client identity, so N one-off fetches are indistinguishable from one client returning N
 * times. The VALUE is chosen, not derived — nothing in this dataset yields a principled floor.
 */
export const MIN_SUBSCRIBER_REQUESTS = 3

/**
 * Sum a nested `byFeed` down to per-client totals. Pure. The DERIVED view — never stored beside
 * `byFeed`, so the two cannot disagree.
 *
 * `__unknown__` is excluded: `recordFeedTraffic` runs before the handler resolves the segment, so that
 * bucket is traffic the handler does not serve. The data stays in `byFeed` for anyone who wants it.
 *
 * Accumulates through a `Map` for the same reason `parseFeedTrafficResponse` does: the class keys come
 * from the network, and `out[k] = (out[k] ?? 0) + n` on a plain object silently drops a `__proto__`
 * key and renders a `constructor` key as a function body.
 */
export function rollupByClient(byFeed: FeedPollsByTarget): Record<string, number> {
  const out = new Map<string, number>()
  for (const [feed, perClient] of Object.entries(byFeed)) {
    if (feed === FEED_UNKNOWN_TARGET) continue
    for (const [cls, n] of Object.entries(perClient)) out.set(cls, (out.get(cls) ?? 0) + n)
  }
  return Object.fromEntries(out)
}

/** Whether the all-services feed had subscriber-class traffic, and whether it cleared the floor.
 *  Three states, matching what a per-service feed gets — `boolean` could not express "polled, but
 *  under the floor", so that case rendered identically to no traffic at all. */
export type AllFeedState = 'subscribed' | 'below-floor' | 'none'

export interface SubscriberFeeds {
  readonly perService: readonly string[]
  readonly allFeed: AllFeedState
  /** PER-SERVICE feeds only. The all-feed's own suppression is `allFeed`, deliberately not folded in
   *  here: beside "N per-service subscribed" an incremented integer reads as another per-service
   *  feed. */
  readonly belowFloor: number
}

/**
 * Where one feed's subscriber-class count sits relative to the floor. ONE spelling of the rule,
 * which the two populations previously spelled separately, so changing the floor meant finding every
 * site. They differ only in how they AGGREGATE this, which is the honest asymmetry: per-service feeds
 * are attributable and get a list plus a count, the all-feed is not and gets a state. Pure.
 */
function floorState(n: number): AllFeedState {
  return n >= MIN_SUBSCRIBER_REQUESTS ? 'subscribed' : n > 0 ? 'below-floor' : 'none'
}

/**
 * The feeds a SUBSCRIBER-class client polled, split into per-service feeds and the all-services feed.
 *
 * `perService` is the growth signal, and the one number here needing no cadence divisor.
 * `belowFloor` counts per-service feeds that had subscriber-class traffic but stayed under
 * `MIN_SUBSCRIBER_REQUESTS` — neither sentinel enters it. The split
 * lives HERE rather than in the renderer so every consumer gets it: as of 2026-08-21 the operator
 * holds one subscription and it is the all-feed, so folding it into a per-service count publishes an
 * adoption figure that is +1 by construction. `allFeed` is a STATE, not a count — `__all__` aggregates
 * every /feed.xml poller and cannot be attributed to anyone.
 *
 * Limits, all pointing the same way:
 *   - a SECOND subscriber on an already-listed feed adds no entry, so this UNDERCOUNTS;
 *   - a client below `MIN_SUBSCRIBER_REQUESTS` is not listed, so a real subscriber polling rarely can
 *     sit below the floor and stay invisible;
 *   - `other`/`browser` are excluded, and an unrecognised reader shipping a Mozilla envelope lands in
 *     `browser`, so it is excluded too;
 *   - the all-feed is unattributable, so `below-floor` says only THAT it was suppressed, never by how
 *     many clients.
 * Treat `perService.length` as a lower bound: it can show growth happened, never that it didn't.
 *
 * `__unknown__` is excluded — a URL we answered 404 to is not a subscribable feed.
 */
export function subscriberFeeds(byFeed: FeedPollsByTarget): SubscriberFeeds {
  const totals: Array<[string, number]> = []
  let allFeed: AllFeedState = 'none'
  let belowFloor = 0
  for (const [feed, perClient] of Object.entries(byFeed)) {
    if (feed === FEED_UNKNOWN_TARGET) continue
    const n = SUBSCRIBER_CLIENTS.reduce((acc, cls) => acc + (perClient[cls] ?? 0), 0)
    const state = floorState(n)
    if (feed === FEED_ALL_TARGET) {
      // Never inside the per-service count and never inside `belowFloor` — folding it back into
      // either is the +1-by-construction this split exists to prevent. But it gets the SAME three
      // states they do: excluding it from `belowFloor` on the attribution argument left it unable to
      // say "suppressed", so the one subscription the operator actually holds rendered as absence.
      allFeed = state
      continue
    }
    // Counted, not just skipped: a FIRST appearance is by construction low-volume, so the floor is
    // quietest exactly where the signal lives.
    if (state === 'below-floor') belowFloor++
    if (state !== 'subscribed') continue
    totals.push([feed, n])
  }
  // Count desc, then name asc — a stable order, so the rendered line changes only when the data does.
  totals.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return { perService: totals.map(([feed]) => feed), allFeed, belowFloor }
}

/** Query the last-24h feed poll count via the AE SQL API. Best-effort: null on missing creds /
 *  HTTP failure / unparseable response. Never throws. */
export async function queryFeedTraffic(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedTrafficCounts | null> {
  if (!accountId || !token) {
    // Names which null-producing path was taken; the stored `null` alone does not say.
    console.warn('[wae] feed SQL skipped — CF_ACCOUNT_ID/CF_ANALYTICS_TOKEN absent')
    return null
  }
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildFeedTrafficSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] feed SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseFeedTrafficResponse(await res.json())
  } catch (err) {
    console.warn('[wae] feed SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── Badge request traffic (#1157) ──────────────────────────────────────────
// /badge/:serviceId (SVG status badges embedded in READMEs / status pages) has the same
// instrumentation gap #518 closed for /api/v1 and #548 closed for /feed — embeds are a
// retention/distribution signal AIWatch otherwise can't see. Mirrors the feed-poll pattern on the
// SAME dataset, but blob1 carries the requested serviceId (rather than a binary all/service split)
// so per-service embed counts are directly queryable via GROUP BY blob1.
//   index1  = 'badge-request'                                  → total badge traffic, one index filter
//   blob1   = serviceId, or BADGE_UNKNOWN_SERVICE on a miss     → per-service breakdown
//   double1 = 1                                                 → request counter (SUM in AE SQL)
// blob1 is NOT restricted to known service ids by the handler's `^[a-z0-9_-]+$` validation — that
// regex only constrains the character set, and the badge handler deliberately still records a
// not-found id (a stale/retired-service embed is itself a signal worth surfacing). Recording the
// RAW miss string would make blob1 cardinality caller-controlled (unbounded, and inflatable by
// anyone hitting /badge/<random> in a loop — the exact shape #518/#548 avoided by collapsing blob1
// to a fixed enum). Collapsing every miss into the BADGE_UNKNOWN_SERVICE sentinel instead keeps
// blob1 bounded by (known services + 1) regardless of what the caller sends. Unlike v1Variant/
// feedVariant (which classify from the raw pathname), the caller here already knows which case it's
// in (it just did the service lookup), so recordBadgeTraffic takes a discriminated `BadgeRequestOutcome`
// rather than a bare string — the sentinel substitution happens INSIDE this function, so a future call
// site can't pass an arbitrary raw string through to blob1 (the exact failure mode this section exists
// to prevent, and the one the pre-fix code originally shipped).
const BADGE_INDEX = 'badge-request'

/** Sentinel blob1 value recorded for a serviceId with no match — see the cardinality note above.
 *  Never a real service id (services are validated slugs; this literal can't collide, though nothing
 *  currently enforces that against future SERVICES entries). */
export const BADGE_UNKNOWN_SERVICE = '__unknown__'

/** What a `/badge/:serviceId` request resolved to — the input `recordBadgeTraffic` classifies from.
 *  The `known: false` variant carries no serviceId field at all, so there's nothing left to
 *  accidentally thread through to blob1 on a miss. */
export type BadgeRequestOutcome =
  | { known: true; serviceId: string }
  | { known: false }

/** Record one badge-request data point. Best-effort (guarded binding + try/catch), like recordV1Traffic/recordFeedTraffic. */
export function recordBadgeTraffic(
  analytics: AnalyticsEngineDataset | undefined,
  outcome: BadgeRequestOutcome,
): void {
  if (!analytics) return
  const blob = outcome.known ? outcome.serviceId : BADGE_UNKNOWN_SERVICE
  try {
    analytics.writeDataPoint({
      blobs: [blob],
      doubles: [1],
      indexes: [BADGE_INDEX],
    })
  } catch (err) {
    console.warn('[wae] badge writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

export interface BadgeTrafficCounts {
  // last-24h badge requests per blob1 value: a real serviceId, OR the BADGE_UNKNOWN_SERVICE sentinel
  // (aggregating every not-found/retired/typo'd id into one bucket — see the cardinality note above).
  byService: Record<string, number>
  total: number  // sum across all buckets, known services + unknown
}

/** AE SQL summing the last-24h badge request count per blob1 bucket (a service id or the
 *  BADGE_UNKNOWN_SERVICE sentinel), sampling-corrected. */
export function buildBadgeTrafficSql(dataset = V1_DATASET): string {
  return (
    `SELECT blob1 AS service, SUM(_sample_interval) AS requests ` +
    `FROM ${dataset} ` +
    `WHERE index1 = '${BADGE_INDEX}' AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `GROUP BY blob1 ` +
    `FORMAT JSON`
  )
}

/** Parse the AE SQL badge-traffic JSON into per-service counts. Tolerant of string/number requests
 *  and a missing/invalid service label. */
export function parseBadgeTrafficResponse(json: unknown): BadgeTrafficCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  const byService: Record<string, number> = {}
  let total = 0
  for (const row of data) {
    const r = row as { service?: unknown; requests?: unknown }
    if (typeof r.service !== 'string' || !r.service) continue
    const parsed = Number(r.requests)
    const n = Number.isFinite(parsed) ? parsed : 0
    byService[r.service] = (byService[r.service] ?? 0) + n
    total += n
  }
  return { byService, total }
}

/** Query the last-24h badge request count via the AE SQL API. Best-effort: null on missing creds /
 *  HTTP failure / unparseable response. Never throws. Mirrors queryFeedTraffic. */
export async function queryBadgeTraffic(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<BadgeTrafficCounts | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildBadgeTrafficSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] badge SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseBadgeTrafficResponse(await res.json())
  } catch (err) {
    console.warn('[wae] badge SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── Chrome-extension poll volume (#837) ───────────────────────────────────
// The extension polls /api/status/cached?src=ext-claude, tagged `ext-claude` in the SAME
// aiwatch_statusline dataset (index1). Counting it gives a CONSENT-FREE active-usage proxy
// (no in-extension analytics needed — see the extension's "zero data collection" privacy bar).
// Single total (no blob split): every ext poll is one variant.
/** The WAE index the extension's polls are tagged with. EXPORTED and imported by the write site in
 *  `index.ts` (#1293) — it used to be a bare literal there and a separate const here, two spellings of
 *  one decision with nothing holding them together. A rename on either side killed the counter
 *  silently and forever: the SQL still succeeds and matches nothing. Whether that lands as a confident
 *  `0` or as a permanent `failed` is the unsettled question on `readExtPolls`. Either way the row
 *  records it and the daily warn reports it — but only as `zero`/`failed`, never as "the tag was
 *  renamed". Extraction makes the rename a compile error instead. */
export const EXT_INDEX = 'ext-claude'

export function buildExtTrafficSql(dataset = V1_DATASET): string {
  return (
    `SELECT SUM(_sample_interval) AS requests ` +
    `FROM ${dataset} ` +
    `WHERE index1 = '${EXT_INDEX}' AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `FORMAT JSON`
  )
}

/**
 * Parse the AE SQL ext-claude JSON into a single last-24h poll total. Tolerant of string/number.
 *
 * #1293 — an unreadable `requests` returns `null`, NOT `0`. It used to return `0`, which was survivable
 * while the only consumer was a Discord line that lived for a day: a malformed row rendered a wrong
 * number once and was gone. That value is now written to `growth:daily`, a permanent key with no TTL
 * and no backfill, and `readExtPolls` cannot tell a coerced `0` from a measured one — so the old
 * fallback would have filed a broken read as a measured quiet day, forever, under verdict `ok`. That
 * is the precise failure this series exists to prevent ("a broken day must never read as a quiet one").
 *
 * `null` here means only "this response did not carry a number we can use"; it deliberately says
 * nothing about WHY, which is why the verdict at the read boundary is `failed` rather than a guess.
 */
export function parseExtTrafficResponse(json: unknown): number | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data) || data.length === 0) return null
  const raw = (data[0] as { requests?: unknown })?.requests
  // A TYPE test, not a list of bad values. `Number()` maps `null`, `''`, `' '`, `[]` and `false` all to
  // `0`, so blacklisting the ones we thought of still lets the rest through as a measured zero — the
  // enumeration is the bug. Only a number, or a string with non-space content, is even a candidate.
  if (typeof raw !== 'number' && (typeof raw !== 'string' || raw.trim() === '')) return null
  const parsed = Number(raw)
  // `>= 0`: a poll total cannot be negative, and rejecting it here rather than downstream keeps the
  // stored row and the rendered Discord line on ONE predicate (they read the same local).
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** Query the last-24h extension poll count via the AE SQL API. Best-effort: null on missing creds /
 *  HTTP failure / unparseable response. Never throws. */
export async function queryExtTraffic(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildExtTrafficSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] ext SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseExtTrafficResponse(await res.json())
  } catch (err) {
    console.warn('[wae] ext SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── #1293: keeping the ext/plugin poll counts, and reading them as clients ─
// Both counters were queried once a day for the Discord line and then dropped. #1273 closed exactly
// this gap for the feed counter; the audit that motivated this one had to quote a 9-day-old figure
// because today's did not exist anywhere. The judgement below is the same shape as `readFeedPolls`:
// value and verdict as ONE value, so a caller cannot log one story and store another.

/**
 * A poll counter's read.
 *
 * THREE verdicts, and `zero` is the one #1293 originally left out. The argument for omitting it was
 * that these counters can hold their own zero, so a reported `0` needs no verdict to explain a `null`.
 * That conflated two questions: whether the FIELD can represent zero (it can) and whether a stored
 * zero is INTERPRETABLE (it is not). A window with no polls and a recorder that wrote nothing are the
 * same `0` — exactly the pair `isMeasuredFeedPolls` names indistinguishable, and exactly why
 * `readFeedPolls` grew a `zero` verdict.
 *
 * What forced it: the operator disabled their own plugin monitor and statusline to open a clean
 * external-usage measurement window. Inside that window the EXPECTED reading is `0`, and the question
 * being asked IS "is it really 0?". While the operator's own traffic was in the count, a non-zero
 * value doubled as proof the recorder was alive; removing it removed that canary. A `0` stored as `ok`
 * would let a dead binding answer the window's question with a confident "no adoption", permanently,
 * in a key with no TTL and no backfill.
 *
 * `zero` keeps the value (the read DID succeed) while refusing to call it unambiguous. `failed` covers
 * everything the source cannot tell apart (see `readExtPolls`).
 */
export type PollsVerdict = 'ok' | 'zero' | 'failed'

export type ExtPollsRead =
  | { verdict: 'ok'; polls: number }
  | { verdict: 'zero'; polls: 0 }
  | { verdict: 'failed'; polls: null }

/**
 * Is this STORED value a measurement? The `feedPolls` counterpart of this question is
 * `isMeasuredFeedPolls`, and it exists because the same question used to be answered inline at each
 * site that asked and the sites disagreed.
 *
 * These two predicates are why a value read back from KV gets the same judgement a freshly-queried
 * one does. `preserveMeasured` restores a prior row's value over a failed re-run, and the only thing
 * `appendGrowthDaily` validates about a stored row is that its `date` is a string — so without this,
 * a corrupt prior (`"2010"`, `-5`, `{monitor: null}`, or a value carrying no verdict at all) is
 * resurrected over an honest failure and filed as measured, permanently. That is not hypothetical —
 * see the inline note inside `isMeasuredFeedPolls` (not its opening paragraph, which describes a
 * different, stricter disagreement): a shallow check admitted `{claude: 5}` / `{claude: null}` and
 * `preserveMeasured` resurrected them over an honest failure.
 */
export function isMeasuredExtPolls(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

export function isMeasuredPluginPolls(v: unknown): v is PluginTrafficCounts {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const c = v as { monitor?: unknown; brief?: unknown }
  return isMeasuredExtPolls(c.monitor) && isMeasuredExtPolls(c.brief)
}

/**
 * Judge one day's extension poll read.
 *
 * `failed` is deliberately broad, and the breadth is the honest part: every way the read can go wrong
 * arrives here as the same `null` — missing creds, an HTTP failure, a body that is not the expected
 * shape, and a `requests` value that is absent or does not parse. Those are not distinguishable by
 * the time the value reaches this function, so it does not invent a distinction between them.
 * #1273's rule is that one value must not tell two stories; where the SOURCE cannot discriminate, the
 * verdict says so rather than guessing which story to tell.
 *
 * A `0` that AE actually reported keeps its VALUE but arrives as `zero`, not `ok` — the read succeeded,
 * and a window nobody polled is indistinguishable from a recorder that wrote nothing.
 *
 * What is NOT settled is whether AE ever represents a zero-match window as `data: []` instead — this SQL
 * has no `GROUP BY`, so it probably returns one row carrying `0`, but that has not been observed and is
 * not asserted here. If it does return `[]`, a genuinely quiet day records as `failed` rather than
 * `zero`. That is the fail-safe direction (a `failed` row is visibly unread; a fabricated `0` is not),
 * which is why it ships this way unresolved.
 */
export function readExtPolls(total: number | null | undefined): ExtPollsRead {
  if (!isMeasuredExtPolls(total)) return { verdict: 'failed', polls: null }
  if (total === 0) return { verdict: 'zero', polls: 0 }
  return { verdict: 'ok', polls: total }
}

/** The extension's alarm period — `POLL_PERIOD_MINUTES` in `extension/config.js`. Duplicated here
 *  because a Worker cannot import the extension bundle; `client-polls.test.ts` fails if the
 *  two drift, the same lockstep treatment `feed-slug-sync` gives its own duplicated list.
 *  NOT user-settable — the value is compiled into the shipped extension. */
export const EXT_POLL_PERIOD_MINUTES = 2

/** The monitor's DEFAULT poll period — `AIWATCH_POLL_SECONDS` in
 *  `plugin/aiwatch/bin/aiwatch-monitor.sh`. Unlike the extension's, this one IS user-settable: the
 *  script rejects only a non-numeric or zero value, with no minimum, so a derived client count can err
 *  in EITHER direction and callers must carry that caveat rather than printing a bare number. */
export const PLUGIN_POLL_PERIOD_SECONDS = 60

/**
 * Polls observed in a 24h window → **observed client running time, in minutes**.
 *
 * Each poll marks one interval during which a client was alive, so the running time is simply
 * `polls × interval` — no divisor, and nothing to look up before the number means something.
 * `2010 ext polls × 2 min = 4020 min = 67h`.
 *
 * This replaced a "client-days" figure (`polls ÷ 720`) that rendered as `2.8 browsers`. Three reasons,
 * and the second is the one that mattered:
 *   1. `2.8 browsers` names a quantity that cannot exist, so it reads as wrong before it reads as
 *      anything;
 *   2. it invites exactly one misreading — a USER COUNT — and that misreading feeds growth decisions.
 *      The count of distinct clients is NOT recoverable from a poll total (the same total is produced
 *      by 3 clients running all day or 9 running a third of it), so a figure shaped like a count
 *      claims a precision this counter does not have. A duration makes no such claim;
 *   3. small values survive. Rounding client-days needed a `<0.1` floor that collapsed 1 poll and 40
 *      polls into the same string — and with the operator's own client excluded, small values are the
 *      EXPECTED reading, not an edge case.
 *
 * It also makes the operator's own share subtractable in the SAME unit: a browser left running all day
 * contributes 24h, so `67h − 24h` is a legible lower bound on external usage. `2.8 − 1.0 = 1.8 browsers`
 * was not.
 *
 * Returns `null` rather than a bogus number for a non-positive period or an invalid total; the caller
 * decides what to do with that (both formatters fall back to the raw poll count). EXACT — rounding is
 * `formatClientTime`'s job. Pure.
 */
export function clientMinutesFromPolls(polls: number, periodMinutes: number): number | null {
  if (!Number.isFinite(polls) || polls < 0) return null
  if (!Number.isFinite(periodMinutes) || periodMinutes <= 0) return null
  // The PRODUCT, not just the inputs: two finite numbers multiply to `Infinity`, and the docstring
  // above promises `null` rather than a bogus number.
  const minutes = polls * periodMinutes
  return Number.isFinite(minutes) ? minutes : null
}

/** Whose running time the figure describes. A union, not a `string`, so a typo cannot ship. */
export type ClientTimeUnit = 'browser' | 'session'

/**
 * Render observed running time: `67h of browser time` / `20 min of session time`.
 *
 * INTEGERS only, and the unit switches at an hour. Sub-hour values keep minute resolution because that
 * is the range the operator-exclusion window put the plugin and statusline counters into — `2 min` and
 * `40 min` are different findings, and the client-day form printed both as `<0.1`.
 *
 * A total above 24h is not an error: it is the SUM across clients over a 24h window, which is what
 * more than one concurrent client produces.
 */
export function formatClientTime(minutes: number, unit: ClientTimeUnit): string {
  // Round FIRST, then choose the unit: comparing the raw value let 59.6 round to 60 and print
  // "60 min", the exact string the unit switch exists to make unreachable.
  const mins = Math.round(minutes)
  // A non-zero reading must never print `0`. Unreachable while both periods are whole minutes, but
  // `PLUGIN_POLL_PERIOD_SECONDS` is the user-settable one, and a sub-minute interval would make a
  // single poll render as "0 min" — the same defect the deleted `<0.1` floor existed to prevent.
  if (minutes > 0 && mins === 0) return `<1 min of ${unit} time`
  if (mins < 60) return `${mins} min of ${unit} time`
  return `${Math.round(mins / 60)}h of ${unit} time`
}

// ── Statusline poll volume (#918, feeds #400 Phase 1 measurement) ─────────
// The Claude Code statusline snippets (#400) poll /api/status/cached?src=statusline-<preset>,
// each tagged with its FULL preset slug in the SAME aiwatch_statusline dataset (index.ts writes
// index1 = the `statusline-*` src, #494). Counting them is the consent-free adoption proxy that
// #400 Phase 1's distribution/measurement gate needs — collected since #494 but never read back
// (unlike ext-claude / feed). Unlike ext-claude's single 'ext-claude' index, statusline's index1
// is MULTI-VALUED (one per preset: statusline-branded / -clickable / -degraded_only / -compact_badge
// / -full_list / -scoped), so filter with LIKE + GROUP BY index1 (feed's per-variant shape).
// NOTE: poll volume ≈ active-usage proxy, NOT user count — Claude Code re-renders the statusline
// per prompt, so a single active user generates many polls; the day-over-day step-up is the signal.
const STATUSLINE_INDEX_PREFIX = 'statusline-'
// The legacy Vercel-rewrite catch-all tag (#452/#453): every hit on ai-watch.dev/api/status/cached
// is rewritten to the worker with ?src=statusline-proxy. NOT a display preset — it's the pre-#918
// jq-snippet cohort (preset-unknown) plus any other apex-cached traffic. Tracked SEPARATELY from the
// path-tagged server-render presets (#918) because the two cohorts move in opposite target
// directions: legacy should SHRINK as users re-copy, server-render should GROW. Blending them into
// one total cancels the adoption signal (#944).
const STATUSLINE_PROXY_KEY = 'proxy'

export interface StatuslineTrafficCounts {
  byPreset: Record<string, number>  // path-tagged server-render presets ONLY (proxy excluded) → last-24h polls
  serverRenderTotal: number         // sum across path-tagged presets — the #918 adoption signal (want ↑)
  legacyProxy: number               // the legacy jq-snippet cohort (statusline-proxy tag; want ↓)
  total: number                     // serverRenderTotal + legacyProxy (grand total across all statusline-* polls)
}

/** Per-cohort day-over-day delta (today − yesterday); null per cohort when no usable baseline. */
export interface StatuslineTrafficDelta {
  serverRender: number | null
  legacyProxy: number | null
}

/** AE SQL summing the last-24h statusline poll count per preset (sampling-corrected via SUM(_sample_interval)). */
export function buildStatuslineTrafficSql(dataset = V1_DATASET): string {
  return (
    `SELECT index1 AS preset, SUM(_sample_interval) AS requests ` +
    `FROM ${dataset} ` +
    `WHERE index1 LIKE '${STATUSLINE_INDEX_PREFIX}%' AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `GROUP BY index1 ` +
    `FORMAT JSON`
  )
}

/** Parse the AE SQL statusline JSON into per-cohort counts. Strips the 'statusline-' prefix from the
 *  key for readability, and routes the legacy `proxy` catch-all (#452/#453) into its OWN `legacyProxy`
 *  field so it's never blended into the server-render preset adoption signal (#944).
 *
 *  #1293 — tolerant of a string OR number `requests`, and of NOTHING else: a row whose `requests` is
 *  unreadable, or whose `preset` is not a `statusline-` tag, FAILS the whole read. See the body. */
export function parseStatuslineTrafficResponse(json: unknown): StatuslineTrafficCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  const byPreset: Record<string, number> = {}
  let serverRenderTotal = 0
  let legacyProxy = 0
  for (const row of data) {
    const r = row as { preset?: unknown; requests?: unknown }
    // #1293 — an unreadable or unrecognised `preset` FAILS the read rather than being skipped, the
    // same treatment `parsePluginTrafficResponse` gives an unrecognised `tag` and for the same reason:
    // `WHERE index1 LIKE 'statusline-%'` makes a foreign preset impossible while query and response
    // agree, so one appearing means the `AS preset` alias or the schema drifted. Skipping it turns
    // "we are reading the wrong column" into a confident smaller total — or, if EVERY row drifts, into
    // a confident `{total: 0}` that this PR's own contract would then report as `zero`, i.e. as a read
    // that succeeded. That is the permanent, un-backfillable version of the defect.
    if (typeof r.preset !== 'string' || !r.preset.startsWith(STATUSLINE_INDEX_PREFIX)) return null
    // #1293 — an unreadable `requests` fails the whole read rather than contributing `0`. Same reason
    // as the ext/plugin parsers: this value is now written to a permanent no-TTL row, where a
    // silently-zeroed component is indistinguishable from a measured quiet window.
    if (typeof r.requests !== 'number' && (typeof r.requests !== 'string' || r.requests.trim() === '')) return null
    const parsed = Number(r.requests)
    if (!Number.isFinite(parsed) || parsed < 0) return null
    const n = parsed
    const key = r.preset.slice(STATUSLINE_INDEX_PREFIX.length) || r.preset
    if (key === STATUSLINE_PROXY_KEY) {
      legacyProxy += n
    } else {
      byPreset[key] = (byPreset[key] ?? 0) + n
      serverRenderTotal += n
    }
  }
  return { byPreset, serverRenderTotal, legacyProxy, total: serverRenderTotal + legacyProxy }
}

/** Serialize today's cohort totals for the day-over-day snapshot KV (read tomorrow by
 *  computeStatuslineDelta). Compact JSON `{sr,lp}` — mirrors the #548 subscriber-count snapshot. */
export function serializeStatuslineSnapshot(counts: StatuslineTrafficCounts): string {
  return JSON.stringify({ sr: counts.serverRenderTotal, lp: counts.legacyProxy })
}

/** Diff today's cohort totals against yesterday's persisted snapshot. Returns null PER COHORT when
 *  there's no usable baseline (absent / empty / non-JSON / non-numeric field) — same empty-string
 *  footgun guard as computeSubscriberDelta (#548), so a corrupt snapshot reads as "no delta" rather
 *  than a bogus full-count jump. Pure. */
export function computeStatuslineDelta(
  counts: StatuslineTrafficCounts,
  prevSnapshotRaw: string | null,
): StatuslineTrafficDelta {
  const none: StatuslineTrafficDelta = { serverRender: null, legacyProxy: null }
  if (prevSnapshotRaw == null || prevSnapshotRaw.trim() === '') return none
  let prev: unknown
  try {
    prev = JSON.parse(prevSnapshotRaw)
  } catch {
    return none
  }
  const p = prev as { sr?: unknown; lp?: unknown }
  const prevSr = Number(p?.sr)
  const prevLp = Number(p?.lp)
  return {
    serverRender: Number.isFinite(prevSr) ? counts.serverRenderTotal - prevSr : null,
    legacyProxy: Number.isFinite(prevLp) ? counts.legacyProxy - prevLp : null,
  }
}

/** Query the last-24h statusline poll count via the AE SQL API. Best-effort: null on missing creds /
 *  HTTP failure / unparseable response. Never throws. Mirrors queryFeedTraffic / queryExtTraffic. */
export async function queryStatuslineTraffic(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<StatuslineTrafficCounts | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildStatuslineTrafficSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] statusline SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseStatuslineTrafficResponse(await res.json())
  } catch (err) {
    console.warn('[wae] statusline SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── Claude Code plugin usage (#920) ───────────────────────────────────────
// The plugin (#920) tags two DISTINCT indexes in the same dataset — deliberately NOT
// `statusline-*`, so continuous monitor polling doesn't pollute the #918 preset metric:
//   'aiwatch-monitor' — every 60s background-monitor poll of /api/statusline/down
//   'aiwatch-brief'   — every on-demand /aiwatch briefing (/api/statusline/brief)
// Collected since #920 but, like the pre-#918 statusline tags, needs a read-back to be
// usable. This is the consent-free plugin-adoption proxy (monitor volume ≈ installs × up-time;
// brief volume ≈ active engagement). Same NOT-a-user-count caveat as statusline.
/** The plugin's two WAE indexes. Exported for the same #1293 reason as `EXT_INDEX` above: the write
 *  sites in `index.ts` import these rather than repeating the strings. */
export const PLUGIN_MONITOR_INDEX = 'aiwatch-monitor'
export const PLUGIN_BRIEF_INDEX = 'aiwatch-brief'

export interface PluginTrafficCounts {
  monitor: number  // last-24h background-monitor polls
  brief: number    // last-24h /aiwatch briefings
}

/** AE SQL summing the last-24h plugin poll counts per index (sampling-corrected). */
export function buildPluginTrafficSql(dataset = V1_DATASET): string {
  return (
    `SELECT index1 AS tag, SUM(_sample_interval) AS requests ` +
    `FROM ${dataset} ` +
    `WHERE index1 IN ('${PLUGIN_MONITOR_INDEX}', '${PLUGIN_BRIEF_INDEX}') AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `GROUP BY index1 ` +
    `FORMAT JSON`
  )
}

/**
 * Parse the AE SQL plugin JSON into monitor/brief counts. Tolerant of string/number + missing rows.
 *
 * An EMPTY `data` really is `{monitor: 0, brief: 0}`, and that is not the same judgement the ext
 * parser makes about its own empty array: `buildPluginTrafficSql` carries `GROUP BY index1`, so a tag
 * with no polls simply produces no row. A quiet window is genuinely measurable here.
 *
 * #1293 — a row that IS present fails the WHOLE read, rather than contributing `0` or being skipped,
 * when its `requests` is unreadable OR its `tag` is not one of the two indexes. Same reason as `parseExtTrafficResponse`: the result is now written to a
 * permanent no-TTL key, and a silently-zeroed component is indistinguishable from a measured quiet
 * window once stored. Failing the pair (rather than just that component) is deliberate — a partial
 * count filed as a measurement is the worse of the two, since nothing downstream can tell it apart.
 */
export function parsePluginTrafficResponse(json: unknown): PluginTrafficCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  let monitor = 0
  let brief = 0
  for (const row of data) {
    const r = row as { tag?: unknown; requests?: unknown }
    // An unrecognised tag fails the read rather than being skipped. `WHERE index1 IN (...)` means a
    // foreign tag cannot occur while the query and the response agree — so if one appears, the SELECT's
    // `AS tag` alias or the schema has drifted, and silently skipping it turns "we are reading the
    // wrong column" into a confident `{0, 0}`, which is indistinguishable from a quiet window forever.
    if (r.tag !== PLUGIN_MONITOR_INDEX && r.tag !== PLUGIN_BRIEF_INDEX) return null
    if (typeof r.requests !== 'number' && (typeof r.requests !== 'string' || r.requests.trim() === '')) return null
    const parsed = Number(r.requests)
    if (!Number.isFinite(parsed) || parsed < 0) return null
    if (r.tag === PLUGIN_MONITOR_INDEX) monitor += parsed
    else brief += parsed
  }
  return { monitor, brief }
}

/** Query the last-24h Claude Code plugin usage via the AE SQL API. Best-effort: null on missing
 *  creds / HTTP failure / unparseable response. Never throws. Mirrors queryStatuslineTraffic. */
export async function queryPluginTraffic(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<PluginTrafficCounts | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildPluginTrafficSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] plugin SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parsePluginTrafficResponse(await res.json())
  } catch (err) {
    console.warn('[wae] plugin SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}

export type PluginPollsRead =
  | { verdict: 'ok'; counts: PluginTrafficCounts }
  | { verdict: 'zero'; counts: PluginTrafficCounts }
  | { verdict: 'failed'; counts: null }

/** Judge one day's plugin read — same three-verdict shape as `readExtPolls`. `{monitor: 0, brief: 0}`
 *  is a SUCCESSFUL read of a quiet window and must store as such; `null` is the query having failed.
 *  `isMeasuredPluginPolls` is not reachable from THIS caller with a malformed shape — it is shared
 *  with `preserveMeasured`, where the input is a KV-loaded prior that nothing else validates.
 *
 *  `parsePluginTrafficResponse` maps an empty `data` array to `{0, 0}`; `GROUP BY index1` explains why
 *  a quiet tag yields no row, but it does NOT separate "nobody polled" from "the recorder wrote
 *  nothing" — `isMeasuredFeedPolls` above names that pair indistinguishable for the identical shape.
 *  That is what the `zero` verdict carries, so the value is stored and the ambiguity travels with it.
 *  Do not read a plugin `zero` as evidence of no adoption; resolve it against `extPolls`, which always
 *  carries the operator's own browser and so cannot legitimately read zero.
 *
 *  Causes of a `failed` verdict are deliberately NOT enumerated here or at the call site: every way the
 *  read can go wrong — missing creds, a non-OK HTTP response, a throw, a `data` that is not an array, an
 *  unreadable `requests`, or a tag the SELECT alias no longer matches — arrives as the same `null`. */
export function readPluginPolls(counts: PluginTrafficCounts | null | undefined): PluginPollsRead {
  if (!isMeasuredPluginPolls(counts)) return { verdict: 'failed', counts: null }
  const copy = { monitor: counts.monitor, brief: counts.brief }
  // Keyed on `monitor` ALONE, not on the pair. `monitor` is the background-poll volume this counter
  // exists to measure and the one the operator disabled; `brief` counts on-demand `/aiwatch` runs.
  // An earlier cut required both to be zero, so `{monitor: 0, brief: 3}` filed a monitor zero as `ok`
  // — three briefings from anywhere would certify the measured quantity as unambiguous. It is also
  // the aggregation this file forbids ten lines up: the two indexes stay separate "because they
  // measure different things — summing them would make a burst of briefings look like installs".
  if (copy.monitor === 0) return { verdict: 'zero', counts: copy }
  return { verdict: 'ok', counts: copy }
}

/**
 * What the PERMANENT row stores for the statusline counter: three totals, and deliberately NOT the
 * per-preset breakdown.
 *
 * `byPreset` is keyed by the WAE `index1` value, and the legacy `?src=` path
 * (`/api/status/cached?src=…`) writes that index from a CALLER-SUPPLIED query parameter with no
 * allowlist — only a 32-byte truncation. (The server-rendered `/api/statusline/:preset` route IS
 * allowlist-guarded; this is the other one.) So the key space is unbounded and externally controlled.
 *
 * That was survivable while the map was rendered into a Discord line and dropped. It is not survivable
 * in `growth:daily`, which has no TTL, no pruning for these keys, and is written as a WHOLE-VALUE
 * rewrite — so a wide enough map does not merely bloat the row, it pushes the month's value past the
 * per-value cap and the put fails, stopping the entire series. One outside caller could silence the
 * growth measurement quietly.
 *
 * Nothing needs the breakdown here: the series has no reader yet, and the Discord section renders from
 * the live query rather than from the row. So it is not stored, rather than stored behind a new
 * allowlist or a size cap.
 */
export interface StatuslinePollTotals {
  serverRenderTotal: number
  legacyProxy: number
  total: number
}

export type StatuslinePollsRead =
  | { verdict: 'ok'; counts: StatuslinePollTotals }
  | { verdict: 'zero'; counts: StatuslinePollTotals }
  | { verdict: 'failed'; counts: null }

/**
 * Is this STORED statusline value a measurement? Same role as `isMeasuredExtPolls` — the KV prior
 * `preserveMeasured` restores from is validated only for a string `date`, so this is what stops a
 * corrupt one being resurrected over an honest failure.
 */
export function isMeasuredStatuslinePolls(v: unknown): v is StatuslinePollTotals {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const c = v as { serverRenderTotal?: unknown; legacyProxy?: unknown; total?: unknown }
  if (!isMeasuredExtPolls(c.serverRenderTotal) || !isMeasuredExtPolls(c.legacyProxy) || !isMeasuredExtPolls(c.total)) return false
  // The SUM invariant, not just the field types. `readStatuslinePolls` discriminates its verdict on
  // `serverRenderTotal`, so a prior whose components disagree with its total would be restored AND
  // relabelled — a payload carrying visible traffic could come back as `zero`. The live parser always
  // computes these together; a KV-loaded prior is what this predicate exists to distrust.
  return c.total === (c.serverRenderTotal as number) + (c.legacyProxy as number)
}

/**
 * Judge one day's statusline read (#1293 Part F).
 *
 * Persisted for the same reason the other two are: the cron queries it for the Discord line and then
 * discards it, so no window is comparable to another. It matters NOW because the operator disabled
 * their own statusline at the same time as the plugin monitor, opening a clean external-usage window
 * whose data was still evaporating daily.
 *
 * NOTE — no client-day conversion exists for this counter, and none should be invented. The extension
 * and plugin monitor poll on a fixed interval, so their totals divide by a known rate; a statusline
 * renders on Claude Code events, not on a timer, so there is no divisor. Store the raw counts.
 */
export function readStatuslinePolls(counts: StatuslineTrafficCounts | StatuslinePollTotals | null | undefined): StatuslinePollsRead {
  if (!isMeasuredStatuslinePolls(counts)) return { verdict: 'failed', counts: null }
  // Copied field-by-field, which is also what DROPS `byPreset` and the render path's `delta`: only the
  // three totals reach the permanent record. See `StatuslinePollTotals` for why the breakdown must not.
  const copy: StatuslinePollTotals = {
    serverRenderTotal: counts.serverRenderTotal,
    legacyProxy: counts.legacyProxy,
    total: counts.total,
  }
  // Keyed on `serverRenderTotal`, not `total`. `total` folds in `legacyProxy` — the pre-#918 jq-snippet
  // cohort, tracked in its own field precisely because #944 established that blending the two cancels
  // the adoption signal. A still-ticking legacy cohort would otherwise certify a `serverRenderTotal` of
  // zero as unambiguous, which is the one number the operator-exclusion window exists to read.
  if (copy.serverRenderTotal === 0) return { verdict: 'zero', counts: copy }
  return { verdict: 'ok', counts: copy }
}

// ── New-feed-items count (#748) ───────────────────────────────────────────
// The poll volume above is mostly EMPTY no-op fetches (Slack RSS polls ~every 15min regardless of
// content). The figure that actually matters — how many alert-worthy items were published — is the
// count of incidents AIWatch FIRST detected in the window. Reuses the #750 `feed:firstseen:{incId}`
// markers (ISO first-detected time, 7d TTL) — NO new write surface. It's the upper bound on the
// notifications any subscriber could have received (a poll only notifies on a genuinely new item).
const FIRST_SEEN_PREFIX = 'feed:firstseen:'

/** Pure: count first-seen ISO timestamps within the 24h window ending at `now` (invalid/empty skipped). */
export function countFirstSeenWithin24h(values: (string | null | undefined)[], now: Date): number {
  const end = now.getTime()
  const start = end - 24 * 60 * 60 * 1000
  let n = 0
  for (const v of values) {
    if (!v) continue
    const t = new Date(v).getTime()
    if (Number.isFinite(t) && t >= start && t <= end) n++
  }
  return n
}

/** List the `feed:firstseen:` markers and count those first-detected in the last 24h. Best-effort:
 *  null on KV failure (caller omits the "new items" suffix). 7d-TTL markers keep the set tiny
 *  (~one per incident), so a single un-paginated list + per-key get is well within budget. */
export async function countNewFeedItems(kv: KVNamespace, now: Date = new Date()): Promise<number | null> {
  try {
    const list = await kv.list({ prefix: FIRST_SEEN_PREFIX })
    // Single page is safe (7d TTL × ~5/day ≈ tiny); warn if that ever stops holding so a future
    // fan-out in feed sources surfaces instead of silently undercounting past the 1000-key page.
    if (!list.list_complete) console.warn('[wae] countNewFeedItems: feed:firstseen list truncated — undercounting')
    if (list.keys.length === 0) return 0
    const values = await Promise.all(list.keys.map((k) => kv.get(k.name).catch(() => null)))
    return countFirstSeenWithin24h(values, now)
  } catch (err) {
    console.warn('[wae] countNewFeedItems failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── Status-snapshot read outcomes (#1227) ─────────────────────────────────
//
// `cacheRead` returns `null` for every unusable snapshot, which is the right answer for CALLERS
// but erases the one thing an investigation needs: which failure it was. #1227 could prove the
// down-list served an empty body while the live path was healthy, and still could not name the
// cause, because the reader kept no record. This is that record.
//
// WAE rather than a KV counter: a cache-backed request performs a cacheRead, so this is
// traffic-proportional, and the standing decision is WAE for those / KV only for bounded writes
// (#518/#548 — a KV counter here would also consume the very write budget whose exhaustion is one
// of the candidate causes, #1227). Recorded on FAILURE paths only, so a healthy worker writes
// nothing; correspondingly, volume rises with the breadth of the failure, whatever its layer.
//
// Schema (dataset: aiwatch_statusline, binding env.ANALYTICS):
//   index1  = constant 'cache-read'   → all snapshot-read failures behind one index filter
//   blob1   = the outcome            → which failure it was
//   double1 = 1                       → counter (SUM)
export const CACHE_READ_INDEX = 'cache-read' as const

/** The mutually-exclusive ways a status-snapshot read fails to yield a usable snapshot. Every one
 *  of them makes `cacheRead` return `null`; they differ only in what the operator should go fix. */
export type CacheReadOutcome =
  | 'no-binding' // env.STATUS_CACHE is absent — a config fault, not a data one
  | 'threw'      // kv.get() rejected
  | 'miss'       // kv.get() resolved null or empty — the key is absent or expired
  | 'unparsed'   // not valid JSON, or parsed to something with no services array
  | 'empty'      // parsed, but holds zero services — a written-but-empty snapshot

export function recordCacheReadOutcome(
  analytics: AnalyticsEngineDataset | undefined,
  outcome: CacheReadOutcome,
): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint({
      blobs: [outcome],
      doubles: [1],
      indexes: [CACHE_READ_INDEX],
    })
  } catch (err) {
    console.warn('[wae] cache-read writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

/** The WAE dataset name (matches wrangler.toml [[analytics_engine_datasets]].dataset). */
export const V1_DATASET = 'aiwatch_statusline'

/** Build the AE SQL that sums the last-24h v1 request count per variant.
 *  WAE samples at high volume, so SUM(_sample_interval) is the unbiased event-count estimate
 *  (exact when _sample_interval=1 at low volume) — NOT COUNT(*), which would undercount. */
export function buildV1TrafficSql(dataset = V1_DATASET): string {
  return (
    `SELECT blob1 AS variant, SUM(_sample_interval) AS requests ` +
    `FROM ${dataset} ` +
    `WHERE index1 = '${V1_INDEX}' AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `GROUP BY blob1 ` +
    `FORMAT JSON`
  )
}

/** Parse the AE SQL API JSON response into per-variant counts. Tolerant of string/number
 *  `requests` and unknown variants. Returns null when the payload has no usable data array. */
export function parseV1TrafficResponse(json: unknown): V1TrafficCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  let all = 0
  let service = 0
  for (const row of data) {
    const r = row as { variant?: unknown; requests?: unknown }
    // Number() (not parseInt) so sampling-corrected SUM(_sample_interval) fractional totals on the
    // string-typed path aren't floored; NaN → 0.
    const parsed = Number(r.requests)
    const n = Number.isFinite(parsed) ? parsed : 0
    if (r.variant === 'v1-status-all') all += n
    else if (r.variant === 'v1-status-service') service += n
  }
  return { all, service, total: all + service }
}

/**
 * Query the last-24h /api/v1 request count via the Analytics Engine SQL API.
 * Best-effort: returns null (caller skips the daily section) when the account id / token is
 * absent, the HTTP call fails, or the response can't be parsed. Never throws.
 */
export async function queryV1Traffic(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<V1TrafficCounts | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildV1TrafficSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] v1 SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseV1TrafficResponse(await res.json())
  } catch (err) {
    console.warn('[wae] v1 SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}

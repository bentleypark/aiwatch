// Consent-free outage-moment audience snapshot — #842-B Deliverable B (근거 ①).
//
// The "outage-spike audience by source" a sponsor asks for (#637/#803) is unmeasurable today: GA4 is
// consent-gated (systematic undercount) AND the is-down page's inbound traffic collapses to (direct)
// when it arrives via the X app — which strips the HTTP referrer (≈91% of the #547 outage analysis).
// This records ONE Analytics Engine data point per is-down page view (fired by a consent-free
// page-load beacon → POST /api/pageview), classified by inbound source and tagged with whether the
// service was in an active outage at view time → a per-outage "N views, by source" the report surfaces.
//
// Storage = Analytics Engine, NOT KV: a viral outage spikes page views, and a per-view KV
// read-modify-write would burn the write budget + race. WAE is built for high-cardinality event
// counts and is read back once/day via AE SQL for the operator report. Mirrors the #518/#548
// api-traffic.ts pattern on the SAME dataset, distinguished by a separate index ('isdown-view').
//   index1  = 'isdown-view'                         → total is-down views via one index filter
//   blob1   = source bucket ('x'|'search'|'feed'|'owned'|'direct'|'plugin'|'reddit'|'hn'|'refhost')
//             NOTE #1055 widened this vocabulary FORWARD-ONLY — rows written before the #1055 deploy
//             fold reddit/hn/refhost/self-referral views into 'direct', so any window spanning that
//             deploy mixes two vocabularies and its 'direct' is NOT comparable to a later one. No
//             backfill exists. (Deploy date: see the `growth:daily` row in docs/reference/kv-schema.md
//             — recorded there at deploy time rather than guessed here.)
//   blob2   = 'active' | 'clear'                    → viewed during an outage window vs not
//   blob3   = service id                            → stored for a future per-service split; NOT
//                                                     queried yet (buildOutageAudienceSql groups on
//                                                     blob1+blob2 only)
//   double1 = 1                                     → view counter (SUM in AE SQL)

import { V1_DATASET } from './api-traffic'

// AnalyticsEngineDataset is a global ambient type from @cloudflare/workers-types.

// #936 — `owned` = our own always-on client surfaces (Chrome extension, statusline): existing users
// returning during an outage, distinct from new inbound (x/search/feed). The Discord alert folds into
// `feed` (it's a subscription notification, like the RSS feed). #920 — `plugin` = the Claude Code
// plugin's is-down links (utm_source=claude-code).
// #1055 — `reddit`/`hn` = named community referrers, `refhost` = arrived WITH a referrer we don't
// bucket by name. Together they shrink `direct` to its literal meaning: NO referrer at all (plus the
// referrer-stripping apps). Before #1055 all of these collapsed into `direct`, which is why the large
// majority of inbound was unreadable and #887-vs-#270 could not be decided from data. (The "83%"
// figure quoted in #1055 is a 5-day sample, 2026-07-13→17 — see the issue for the window and
// denominator; it is a measurement of one window, not a standing property.)
//
// NOT named `referral`: this codebase already uses that word for the OPPOSITE direction — `referral:out`
// / `growth:daily.referralTotal` are OUTBOUND clicks (#842). Two adjacent fields in the same growth
// series meaning inbound-vs-outbound would misread; `refhost` says what it is (we know the host, we
// just don't name it).
// WIDENING CHECKLIST — adding a bucket needs THREE edits, and only two of them fail the build:
//   1. this union                                    → tsc catches downstream misuse
//   2. `zeroBySource()` below                        → tsc: Record<AudienceSource, number> literal
//   3. `AUDIENCE_SOURCES` below                      → **tsc does NOT catch this** (arrays carry no
//      exhaustiveness obligation), and omitting it is silent-and-total: `parseOutageAudienceResponse`
//      SKIPS any row whose source isn't in the array, and `formatAudienceLine` iterates it — so the
//      new bucket reads as a permanent zero in both the series and the operator line while every
//      test stays green. `AUDIENCE_SOURCES covers every AudienceSource` in the tests pins 3 against 2.
export type AudienceSource = 'x' | 'search' | 'feed' | 'owned' | 'direct' | 'plugin' | 'reddit' | 'hn' | 'refhost'
export const AUDIENCE_SOURCES: AudienceSource[] = ['x', 'search', 'feed', 'owned', 'direct', 'plugin', 'reddit', 'hn', 'refhost']

const ISDOWN_INDEX = 'isdown-view'

// Host patterns for referrer-based classification (utm is the primary signal; host is the fallback
// for organic arrivals that DON'T strip the referrer — mainly search).
const X_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.co)$/
// The engine label must be followed by a plausible TLD *at the end of the host* — otherwise
// `google.evil.example` counted as organic `search` (the label appeared anywhere, since the old
// pattern ended at `\.` with no `$`). Structure: engine.tld or engine.cc.tld (`google.co.uk`,
// `yahoo.co.jp`). Found by review on this PR; it inflates the one bucket #1055 exists to make
// trustworthy, so it is fixed here rather than left as pre-existing.
const SEARCH_HOSTS = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|brave|baidu|naver|yandex|qwant|startpage)\.(com?|org|net|[a-z]{2})(\.[a-z]{2})?$/
// #1055 — our OWN surfaces. is-down pages cross-link to each other (related services, fallback
// names) and the landing page links in, so without this an internal click-through arrives with
// `ai-watch.dev` as its referrer and lands in `refhost` — i.e. our own navigation would read as a
// large unidentified EXTERNAL channel, corrupting the exact #887-vs-#270 signal this split exists to
// produce. `owned` already means "our own surface", so self-referrals belong there.
//
// The vercel.app arm is deliberately scoped to OUR preview prefix, not the bare apex: `*.vercel.app`
// is a shared host, so an unanchored arm would book a third party's Vercel-hosted site as internal
// navigation — the same misclassification in the opposite direction. Same reasoning for anchoring
// localhost (`evil.localhost` is not us).
const SELF_HOSTS = /^(.*\.)?ai-watch\.dev$|^localhost$|^aiwatch[a-z0-9-]*\.vercel\.app$/
// #1055 — host matching is viable for Reddit (unlike X, whose app strips the referrer). What was
// actually verified, 2026-07-20: **old.reddit.com** serves `<meta name="referrer" content="always">`
// and its user-posted outbound links carry `rel="nofollow ugc"` with NO `noreferrer`. NOT verified:
// `www.reddit.com` (the majority surface — it served only a JS shell to inspection) and the Reddit
// mobile app. Both are *expected* to send at least the origin under the modern browser default
// (`strict-origin-when-cross-origin`), which is all a hostname match needs — but that is an inference,
// not an observation. Consequence: a low `reddit` count is NOT evidence of no Reddit traffic. The
// reliable signal is a utm-tagged link; `reddit.ts` already appends `utm_source=reddit` (#548) to the
// promote links we emit.
const REDDIT_HOSTS = /(^|\.)(reddit\.com|redd\.it)$/
const HN_HOSTS = /(^|\.)(news\.ycombinator\.com|hn\.algolia\.com)$/

/**
 * Classify an is-down visit's inbound source from the (already-tagged) utm_source and the referrer
 * hostname. Pure. The X app strips the referrer, so utm_source — added to our outage shares by
 * #842-B slice 1 + the operator X_UTM (alerts.ts) — is the primary X signal; our RSS feed links
 * carry utm_source=rss → 'feed'; the Claude Code plugin's is-down links carry utm_source=claude-code
 * (#920) → 'plugin'; organic search is caught by host.
 *
 * #1055 — community referrers are now named: utm_source=reddit OR a reddit host → 'reddit'; HN →
 * 'hn'. Our OWN hosts → 'owned' (is-down pages cross-link each other; that is navigation, not
 * inbound). Anything that still arrived WITH a referrer host lands in 'refhost' (we saw the host, we
 * just don't bucket it by name), so 'direct' finally means what it says: **no referrer at all** — a
 * direct type-in/bookmark, or one of the apps that strip the referrer (X, possibly Reddit's). That
 * last ambiguity is why 'direct' is still not a clean "typed the URL" signal; it is only *cleaner*.
 *
 * PRECONDITION: `refHost` is a bare HOSTNAME, not a URL — every host pattern is `$`-anchored, so a
 * full `https://www.reddit.com/r/x` matches nothing and silently degrades to 'refhost'. The beacon
 * guarantees this via `new URL(document.referrer).hostname` (api/_is-down/html-template.ts). Pinned
 * on both sides: `api/__tests__/is-down-render.test.ts` asserts the template still emits that
 * expression, and this module's test "takes a bare hostname, NOT a full URL" asserts a full URL does
 * NOT classify as 'reddit'.
 */
export function classifyReferrer(utmSource: string | undefined, refHost: string | undefined): AudienceSource {
  const utm = (utmSource || '').toLowerCase()
  const host = (refHost || '').toLowerCase()
  if (utm === 'x' || utm === 'twitter' || X_HOSTS.test(host)) return 'x'
  if (utm === 'rss' || utm === 'feed' || utm === 'discord') return 'feed' // #936 — Discord alert = our notification feed
  if (utm === 'extension' || utm === 'statusline') return 'owned' // #936 — our own client surfaces
  if (utm === 'claude-code') return 'plugin' // #920 — Claude Code plugin is-down links
  if (SELF_HOSTS.test(host)) return 'owned' // #1055 — our own cross-links are not inbound traffic
  if (utm === 'reddit' || REDDIT_HOSTS.test(host)) return 'reddit' // #1055
  if (utm === 'hn' || utm === 'hackernews' || HN_HOSTS.test(host)) return 'hn' // #1055
  if (SEARCH_HOSTS.test(host)) return 'search'
  return host ? 'refhost' : 'direct' // #1055 — 'direct' now means literally no referrer
}

/**
 * Validate a beacon body → `{ svc, source, active }` or null. `svc` MUST be a known service id (the
 * abuse guard: the endpoint is public, so an arbitrary body can't inflate an unknown bucket). `ref`
 * (referrer hostname) + `utm` (utm_source) are length-capped free-text — never stored raw, only fed
 * to the pure `classifyReferrer` → a fixed bucket. `active` (in an outage window) comes from the
 * rendered page status. Pure. Cheap id-safe validation; no free-form strings reach WAE.
 */
export function parsePageviewBody(
  body: unknown,
  validIds: Set<string>,
): { svc: string; source: AudienceSource; active: boolean } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const svc = typeof b.svc === 'string' ? b.svc : ''
  if (!validIds.has(svc)) return null
  const utm = typeof b.utm === 'string' ? b.utm.slice(0, 64) : ''
  const ref = typeof b.ref === 'string' ? b.ref.slice(0, 128) : ''
  return { svc, source: classifyReferrer(utm, ref), active: b.active === true }
}

/**
 * Record one is-down-view data point. Best-effort: guarded on the optional binding (absent in local
 * dev / tests) and wrapped in try/catch so a WAE failure never aborts the beacon response. Sync
 * (writeDataPoint is fire-and-forget) — no waitUntil needed.
 */
export function recordOutageView(
  analytics: AnalyticsEngineDataset | undefined,
  source: AudienceSource,
  active: boolean,
  svcId: string,
): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint({
      blobs: [source, active ? 'active' : 'clear', svcId],
      doubles: [1],
      indexes: [ISDOWN_INDEX],
    })
  } catch (err) {
    console.warn('[wae] isdown-view writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

export interface AudienceCounts {
  total: number // all is-down views in the window
  activeTotal: number // subset viewed while the service was in an active outage (the sponsor evidence)
  bySource: Record<AudienceSource, number> // all views by source
  activeBySource: Record<AudienceSource, number> // active-outage views by source
}

const zeroBySource = (): Record<AudienceSource, number> => ({ x: 0, search: 0, feed: 0, owned: 0, direct: 0, plugin: 0, reddit: 0, hn: 0, refhost: 0 })

/** AE SQL summing the last-24h is-down view count per (source, active/clear) — sampling-corrected
 *  via SUM(_sample_interval), NOT COUNT(*) which undercounts at high volume (WAE samples). */
export function buildOutageAudienceSql(dataset = V1_DATASET): string {
  // `phase` (NOT `window`, a SQL reserved keyword the AE parser may reject → 400 → the section
  // silently omits forever); mirrors api-traffic.ts aliasing to non-reserved tokens.
  return (
    `SELECT blob1 AS source, blob2 AS phase, SUM(_sample_interval) AS views ` +
    `FROM ${dataset} ` +
    `WHERE index1 = '${ISDOWN_INDEX}' AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `GROUP BY blob1, blob2 ` +
    `FORMAT JSON`
  )
}

/** Parse the AE SQL JSON into per-source + active/clear counts. Tolerant of string/number `views`
 *  and unknown source buckets (skipped). Returns null when the payload has no usable data array. */
export function parseOutageAudienceResponse(json: unknown): AudienceCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  const bySource = zeroBySource()
  const activeBySource = zeroBySource()
  let total = 0
  let activeTotal = 0
  for (const row of data) {
    const r = row as { source?: unknown; phase?: unknown; views?: unknown }
    const source = r.source as AudienceSource
    if (!AUDIENCE_SOURCES.includes(source)) continue
    const parsed = Number(r.views)
    const n = Number.isFinite(parsed) ? parsed : 0
    bySource[source] += n
    total += n
    if (r.phase === 'active') {
      activeBySource[source] += n
      activeTotal += n
    }
  }
  return { total, activeTotal, bySource, activeBySource }
}

/** Query the last-24h is-down audience via the AE SQL API. Best-effort: null on missing creds /
 *  HTTP failure / unparseable response. Never throws. Mirrors queryFeedTraffic (api-traffic.ts). */
export async function queryOutageAudience(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<AudienceCounts | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildOutageAudienceSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] isdown-view SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseOutageAudienceResponse(await res.json())
  } catch (err) {
    console.warn('[wae] isdown-view SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}

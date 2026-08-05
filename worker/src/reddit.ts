// Reddit community monitoring — detect "is X down?" posts in target subreddits.
// Uses Reddit's public JSON search endpoint, which currently 403s from Cloudflare egress (#820).

import { defuseAutolinkDomain } from './alerts'
import { appendStatusHint, appendUtm } from './utils'

// #820 observability. The fetch path itself is unchanged and currently BROKEN — Reddit 403s
// `search.json` from datacenter IPs — but the failure has been invisible: `fetchSubreddit` warned
// to a log nobody reads and returned `[]`, and the daily summary counts `reddit:seen:*` keys, so
// "403 → 0 posts" renders identically to a quiet day — the source has been dark since at least
// 2026-06-29 (#820's first live 403) and the daily summary never said so. These markers make the
// difference legible; repairing the fetch is #820's remaining half.
export const REDDIT_SOURCE_DEAD_KEY = 'reddit:source-dead'
export const REDDIT_TRANSIENT_STREAK_KEY = 'reddit:transient-streak'
// 26h: long enough to survive to the next daily-summary read, short enough that the marker
// self-expires if the cron stops entirely — a warning must never outlive the thing it describes.
const SOURCE_DEAD_TTL_SEC = 93600
// Consecutive all-transient (network throw / timeout) runs before escalating to source-dead. One
// such run proves nothing; a sustained streak where every target is unreachable is a real block
// that must not hide as a quiet day. Hourly cron → ~3h before the warning fires.
const TRANSIENT_STREAK_LIMIT = 3

export interface RedditPost {
  id: string
  title: string
  author: string
  subreddit: string
  score: number
  url: string
  createdUtc: number
}

export type RedditAlertType = 'outage' | 'competitive' | 'security'

export interface RedditAlert {
  key: string       // KV dedup key: reddit:seen:{postId}
  subreddit: string
  post: RedditPost
  type: RedditAlertType
}

// Subreddit → search keywords mapping.
// service value semantics: '_competitive' / '_security' → those modes; anything else → outage mode.
// Exported for tests — presence/mode assertions pin the named subs in outage mode (#280). They do
// NOT read the playbook: #1182 removed the playbook's per-sub cron column (a prose mirror of this
// list), so nothing is being kept "in sync" with a doc. Note this is the CRON's scan list; the
// operator alert's link list is a separate map, REDDIT_ENGAGE_SUBS in alerts.ts.
export const REDDIT_TARGETS: ReadonlyArray<{ subreddit: string; service: string }> = [
  // Service-specific subreddits (outage detection + promotion)
  { subreddit: 'ClaudeAI',        service: 'Claude' },
  { subreddit: 'ClaudeCode',      service: 'Claude Code' },
  { subreddit: 'ChatGPT',         service: 'ChatGPT' },
  { subreddit: 'OpenAI',          service: 'OpenAI' },
  { subreddit: 'cursor',          service: 'Cursor' },
  { subreddit: 'windsurf',        service: 'Windsurf' },
  { subreddit: 'Codeium',         service: 'Windsurf' },
  // Broader AI communities in outage mode — playbook engagement targets (#280).
  // r/LocalLLaMA was previously competitive mode; switched to outage so API-reliability
  // threads (the playbook's actual engagement hook) are caught. r/AINews added for
  // press-adjacent outage threads. Promotion filter (isPromotable) still gates Discord
  // alerts, so news-flavored posts that aren't question-seeking won't spam.
  { subreddit: 'LocalLLaMA',      service: 'AI Community' },
  { subreddit: 'AINews',          service: 'AI Community' },
  // Competitive monitoring — broader AI/DevOps communities
  { subreddit: 'devops',          service: '_competitive' },
  { subreddit: 'artificial',      service: '_competitive' },
  // Security monitoring — security communities for AI service breach/vulnerability chatter
  { subreddit: 'netsec',          service: '_security' },
  { subreddit: 'cybersecurity',   service: '_security' },
]

// Strong signals: always match. Weak signals (issues/errors/slow): require context words
const STRONG = /\b(down|not working|outage|broken|offline|unavailable|degraded)\b/i
const WEAK_WITH_CONTEXT = /\b(issues?|errors?|slow)\b/i
const CONTEXT = /\b(anyone|right now|today|currently|status|server|api|service)\b/i

// Subset of STRONG used by the megathread promotion path. Excludes `not working` —
// statement phrasing like "Claude Code not working properly after update" too often
// reads as a single-user complaint rather than a live outage megathread (#296).
const PROMOTABLE_STRONG = /\b(down|outage|broken|offline|unavailable|degraded)\b/i

// Age ceiling for megathread promotion. Older threads are post-incident retrospectives
// or off-topic, and re-promoting them would surface stale content.
const MEGATHREAD_MAX_AGE_SEC = 7200

/**
 * Parse Reddit JSON search response into RedditPost[]
 */
export function parseRedditResponse(json: unknown): RedditPost[] {
  if (!json || typeof json !== 'object') return []
  const data = (json as Record<string, unknown>).data
  if (!data || typeof data !== 'object') return []
  const children = (data as Record<string, unknown>).children
  if (!Array.isArray(children)) return []

  return children
    .map((child: unknown) => {
      if (!child || typeof child !== 'object') return null
      const d = (child as Record<string, unknown>).data
      if (!d || typeof d !== 'object') return null
      const post = d as Record<string, unknown>
      return {
        id: String(post.id ?? ''),
        title: String(post.title ?? ''),
        author: String(post.author ?? '[deleted]'),
        subreddit: String(post.subreddit ?? ''),
        score: Number(post.score ?? 0),
        url: `https://www.reddit.com${String(post.permalink ?? '')}`,
        createdUtc: Number(post.created_utc ?? 0),
      }
    })
    .filter((p): p is RedditPost => p !== null && p.id !== '' && p.title !== '')
}

/**
 * Check if a post title matches outage-related keywords.
 * WEAK keywords (issues/errors/slow) accept either a CONTEXT word or a `?` as the
 * outage-context signal — `"Error while signing in?"` is a legitimate status query
 * whose context lives in the question mark, not a keyword list (#296).
 *
 * The `?` relaxation also admits coding-question FPs like `"Why is sampling so slow?"`;
 * downstream `isPromotable` gates Discord, so the cost is an extra `reddit:seen:*` KV
 * write. Tighten with a service-name-token requirement only if data shows noise.
 */
export function matchesKeywords(title: string): boolean {
  if (STRONG.test(title)) return true
  if (WEAK_WITH_CONTEXT.test(title) && (CONTEXT.test(title) || /\?/.test(title))) return true
  return false
}

// Question indicators — posts seeking help are good promotion opportunities
// Require question mark, or question-style phrasing with outage context
const QUESTION_WITH_CONTEXT = /\?|^is\s.+\b(down|working|broken|available)/i
const ANYONE_WITH_OUTAGE = /\b(anyone|anybody|someone|does anyone)\b.+\b(down|issue|problem|working|error|status|outage)/i
const SEEKING_HELP = /\b(help|what('s| is) (going on|happening)|how (to|do) (check|tell|know))\b/i

/**
 * Check if a post is suitable for AIWatch promotion.
 *
 * Promotion paths:
 *   1. Question / help-seeking posts (original contract) — 1-on-1 answer value
 *   2. Live outage megathread — declarative posts with a strong outage keyword
 *      (`down`/`outage`/`broken`/`offline`/`unavailable`/`degraded`) AND age < 2h.
 *      Captures high-engagement threads like "Every single AI app is down" during
 *      live outages, where every reader sees the AIWatch comment's status link.
 *
 * `ageSec` defaults to `Infinity` so title-only callers (tests, ad-hoc use)
 * keep the original three-path behavior (question / anyone-outage / help) —
 * the megathread path only activates when the caller passes real post age.
 */
export function isPromotable(title: string, ageSec: number = Infinity): boolean {
  if (QUESTION_WITH_CONTEXT.test(title)) return true
  if (ANYONE_WITH_OUTAGE.test(title)) return true
  if (SEEKING_HELP.test(title)) return true
  if (PROMOTABLE_STRONG.test(title) && ageSec < MEGATHREAD_MAX_AGE_SEC) return true
  return false
}

// Competitive monitoring keywords — match posts about status monitoring tools
const COMPETITIVE_STRONG = /\b(status monitor|status page|uptime dashboard|api status|ai status|llm status)\b/i
const COMPETITIVE_CONTEXT = /\b(monitor|track|alert|notification|dashboard|real.?time)\b/i
const COMPETITIVE_WEAK = /\b(down.?detector|statuspage|statusgator|isdown)\b/i

export function matchesCompetitiveKeywords(title: string): boolean {
  if (COMPETITIVE_STRONG.test(title)) return true
  if (COMPETITIVE_WEAK.test(title)) return true
  return COMPETITIVE_CONTEXT.test(title) && /\b(ai|llm|api|openai|claude|gpt)\b/i.test(title)
}

// Security monitoring keywords — match posts about AI service security incidents
const AI_SERVICE = /\b(openai|claude|anthropic|gemini|google ai|mistral|cohere|deepseek|hugging\s?face|replicate|elevenlabs|cursor|copilot|windsurf|xai|grok)\b/i
const SECURITY_STRONG = /\b(breach|data leak|hacked|compromised|unauthorized access|CVE-\d{4}|credentials? (leak|expos)|API key (leak|expos)|RCE|remote code execution)\b/i
const SECURITY_CONTEXT = /\b(security|vulnerab|exploit|injection|exfiltrat|malicious|patch|disclosure)\b/i

const AI_ADJACENT = /\b(ai|llm|model|api|gpt|chatbot|machine learning)\b/i

export function matchesSecurityKeywords(title: string): boolean {
  // Strong security signal + AI service mention = always match
  if (SECURITY_STRONG.test(title) && AI_SERVICE.test(title)) return true
  // Security context + AI service mention = match
  if (SECURITY_CONTEXT.test(title) && AI_SERVICE.test(title)) return true
  // Strong security signal + broader AI-adjacent keyword = match (reduces noise from non-AI posts)
  return SECURITY_STRONG.test(title) && AI_ADJACENT.test(title)
}

// Statuses that mean the SOURCE is blocked rather than one subreddit being odd: 401 (auth),
// 403 (IP/UA block — what Reddit returns today), 429 (rate limited).
export function isDeadStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429
}

/**
 * A subreddit fetch resolves to one of THREE states, not two. Folding "no response at all" into
 * "no posts" is the #820 root cause — it makes a total block indistinguishable from a quiet day.
 *   ok        — a 2xx came back (proof the source is alive), whatever the post count
 *   dead      — an auth/block/rate status: the SOURCE is blocked
 *   transient — no response (network throw/timeout) or a non-auth error (5xx): proves nothing
 */
export type FetchOutcome = 'ok' | 'dead' | 'transient'

export interface FetchResult {
  posts: RedditPost[]
  outcome: FetchOutcome
}

/**
 * Fetch recent posts from a subreddit matching outage keywords.
 */
async function fetchSubreddit(subreddit: string, mode: 'outage' | 'competitive' | 'security' = 'outage'): Promise<FetchResult> {
  const query = mode === 'competitive'
    ? encodeURIComponent('"status monitor" OR "uptime dashboard" OR "api status" OR "is down" OR "status page"')
    : mode === 'security'
    ? encodeURIComponent('breach OR leak OR hacked OR vulnerability OR CVE OR "unauthorized access" OR exploit OR "security incident"')
    : encodeURIComponent('down OR "not working" OR outage OR issues OR error')
  const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${query}&sort=new&restrict_sr=on&t=day&limit=5`

  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'AIWatch/1.0 (ai-watch.dev; status monitoring)' },
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    // A throw is NOT a quiet day. Previously this propagated to the Promise.allSettled `rejected`
    // branch and was logged and dropped, contributing nothing to the health picture.
    console.error(`[reddit] r/${subreddit} fetch threw:`, err instanceof Error ? err.message : err)
    return { posts: [], outcome: 'transient' }
  }

  if (!res.ok) {
    console.warn(`[reddit] r/${subreddit} returned HTTP ${res.status}`)
    void res.body?.cancel().catch(() => {})
    return { posts: [], outcome: isDeadStatus(res.status) ? 'dead' : 'transient' }
  }

  // Only a STRUCTURALLY VALID listing counts as proof of life. A bot wall is commonly served as
  // 200 with an HTML interstitial, not 403 — `old.reddit.com` was observed doing exactly that on
  // 2026-07-28. Treating an unparseable 200 as `ok` would let the sneakier form of this very block
  // CLEAR a correct marker and print a quiet day: worse than not having the marker at all.
  const text = await res.text().catch(() => null)
  if (text === null) {
    console.error(`[reddit] r/${subreddit} 200 but the body could not be read`)
    return { posts: [], outcome: 'transient' }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    console.error(`[reddit] r/${subreddit} 200 with a non-JSON body (bot wall?): ${text.slice(0, 120)}`)
    return { posts: [], outcome: 'transient' }
  }
  if (!isRedditListing(json)) {
    console.error(`[reddit] r/${subreddit} 200 with an unexpected JSON shape: ${text.slice(0, 120)}`)
    return { posts: [], outcome: 'transient' }
  }
  return { posts: parseRedditResponse(json), outcome: 'ok' }
}

/** A body is proof of life only if it has the listing shape Reddit actually returns. */
export function isRedditListing(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false
  const data = (json as Record<string, unknown>).data
  if (!data || typeof data !== 'object') return false
  return Array.isArray((data as Record<string, unknown>).children)
}

/**
 * Marker so a persistent block is visible in the daily summary instead of silently zeroing out.
 */
export async function markRedditSourceDead(kv: KVNamespace, reason: SourceDeadReason): Promise<void> {
  // `at` is when darkness BEGAN, not when we last looked. The fold re-marks on every hourly run
  // while unhealthy, and the daily summary reads this key seconds after the scan writes it (both
  // are minute<5 of the same cron invocation) — so re-stamping would pin the reported age at
  // "for 0m" forever, which reads as a fresh blip for a source that has been dark since June.
  // The put still happens every run so the 26h TTL keeps refreshing; only the timestamp is carried.
  const existing = await readRedditSourceDead(kv)
  const at = existing && existing !== 'unknown' && existing.reason === reason ? existing.at : Date.now()
  // A persistent WRITE failure degrades to the pre-#820 behaviour: no marker, so the summary shows
  // a quiet day. There is no second channel here to report that on — it is a known limit, bounded
  // by 24 hourly retries all having to fail.
  await kv.put(REDDIT_SOURCE_DEAD_KEY, JSON.stringify({ reason, at }), { expirationTtl: SOURCE_DEAD_TTL_SEC })
    .catch((err) => console.error('[reddit] source-dead marker write failed:', err instanceof Error ? err.message : err))
}

// KV bills a delete as a write, and the healthy path runs hourly — deleting unconditionally would
// spend ~48 writes/day removing keys that are usually absent (`constraint_free_tier_budget`).
// A read first is effectively free by comparison.
async function deleteIfPresent(kv: KVNamespace, key: string, label: string): Promise<void> {
  try {
    if (await kv.get(key) === null) return
    await kv.delete(key)
  } catch (err) {
    console.error(`[reddit] ${label} clear failed:`, err instanceof Error ? err.message : err)
  }
}

async function clearRedditSourceDead(kv: KVNamespace): Promise<void> {
  await deleteIfPresent(kv, REDDIT_SOURCE_DEAD_KEY, 'source-dead marker')
}

/** Increment the consecutive-all-transient-runs counter and return the new streak. */
async function bumpTransientStreak(kv: KVNamespace): Promise<number> {
  // The read failure is LOGGED, not swallowed: a silently-failing read is indistinguishable from
  // "no prior streak", which would cap the streak at 1 forever and disable the escalation this
  // counter exists for — the same silent-zeroing this whole issue is about.
  let raw: string | null
  try {
    raw = await kv.get(REDDIT_TRANSIENT_STREAK_KEY)
  } catch (err) {
    // Logging alone does not fix this: a failing read is indistinguishable from "no prior streak",
    // so `next` would be 1 forever and the escalation this counter exists for could NEVER fire.
    // A counter that cannot accumulate is itself evidence that health is untrackable — escalate.
    console.error('[reddit] transient-streak read failed — treating as escalated:', err instanceof Error ? err.message : err)
    return TRANSIENT_STREAK_LIMIT
  }
  const next = (Number.parseInt(raw ?? '0', 10) || 0) + 1
  await kv.put(REDDIT_TRANSIENT_STREAK_KEY, String(next), { expirationTtl: SOURCE_DEAD_TTL_SEC })
    .catch((err) => console.error('[reddit] transient-streak write failed:', err instanceof Error ? err.message : err))
  return next
}

async function resetTransientStreak(kv: KVNamespace): Promise<void> {
  await deleteIfPresent(kv, REDDIT_TRANSIENT_STREAK_KEY, 'transient-streak')
}

/** Why the source was marked: a block observed THIS run, a streak of unreachable runs, or a
 *  partial block (some targets answered, some were blocked). The distinction survives to the
 *  operator because the remediations differ. */
export type SourceDeadReason = 'block' | 'streak' | 'partial'

export interface RedditSourceDead { reason: SourceDeadReason; at: number }

const SOURCE_DEAD_REASONS: readonly string[] = ['block', 'partial', 'streak']

/** What the daily summary knows about source health: a marker, `null` (healthy), or `'unknown'`
 *  when KV could not be read. */
export type SourceHealthRead = RedditSourceDead | 'unknown' | null

/**
 * Read the source-dead marker for the daily summary.
 *
 * A KV failure returns `'unknown'`, NOT null. This is the one reader of the marker and the last hop
 * before the operator's only channel, so answering "healthy" when we cannot answer would reproduce
 * #820 one layer up: infrastructure failure rendering as a quiet day. The asymmetry decides it — a
 * false alarm costs one dismissible line, a false all-clear cost weeks of undetected darkness.
 */
export async function readRedditSourceDead(kv: KVNamespace): Promise<SourceHealthRead> {
  let raw: string | null
  try {
    raw = await kv.get(REDDIT_SOURCE_DEAD_KEY)
  } catch (err) {
    console.error('[reddit] source-dead marker read failed:', err instanceof Error ? err.message : err)
    return 'unknown'
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as RedditSourceDead
    // Validated against the union, not merely `typeof string`: an unrecognised reason would fall
    // through the summary's ternary to the assertive "search returned a block status" sentence —
    // a confident, wrong diagnosis. Anything unknown must take the honest 'unknown' path instead.
    if (SOURCE_DEAD_REASONS.includes(parsed?.reason) && typeof parsed?.at === 'number') return parsed
  } catch { /* fall through to the shape warning */ }
  // A marker written every hour and silently ignored forever is the same blind spot; say so.
  console.error(`[reddit] source-dead marker is malformed, treating health as unknown: ${raw.slice(0, 120)}`)
  return 'unknown'
}

/**
 * Fold per-subreddit outcomes into the source-health marker. Pure decision, exported for tests:
 *   • any OK  → the source is provably alive → self-heal. A lone 403 from ONE private or banned
 *     subreddit alongside real successes is per-subreddit noise, not a source-wide block, so a
 *     genuine success outweighs it.
 *   • else any DEAD (and zero OK) → the whole source is blocked → mark dead; the streak resets
 *     because this is a definite signal, not an accumulating suspicion.
 *   • else (all transient) → this run learned nothing, so do not fabricate a marker off one blip
 *     and do NOT wipe an existing one. Escalate only once the streak crosses the limit.
 */
export function decideSourceHealth(outcomes: FetchOutcome[]): 'clear' | 'partial' | 'mark' | 'bump' {
  const ok = outcomes.filter((o) => o === 'ok').length
  const dead = outcomes.filter((o) => o === 'dead').length
  // Some alive, some blocked. Booleans hid this: `ok > 0 → clear` meant 12 of 13 subreddits
  // blocked read as perfectly healthy, and a partial block is a very plausible shape for how an
  // IP/endpoint-scoped block spreads or partially heals — exactly what this feature must see.
  if (ok > 0 && dead > 0) return 'partial'
  if (ok > 0) return 'clear'
  // No success anywhere. A lone `dead` among transients still marks: with zero evidence of life,
  // "one odd subreddit" is not an available reading.
  if (dead > 0) return 'mark'
  return 'bump'
}

/** True once a run of all-transient outcomes has repeated often enough to be a real block. */
export function transientStreakEscalates(streak: number, limit = TRANSIENT_STREAK_LIMIT): boolean {
  return streak >= limit
}

/**
 * Scan all target subreddits and return new posts not yet seen in KV
 */
export async function detectRedditPosts(
  kv: KVNamespace | null,
): Promise<RedditAlert[]> {
  if (!kv) return []

  const alerts: RedditAlert[] = []

  // Fetch all subreddits in parallel
  const results = await Promise.allSettled(
    REDDIT_TARGETS.map(async (target) => {
      const mode: RedditAlertType = target.service === '_competitive' ? 'competitive'
        : target.service === '_security' ? 'security' : 'outage'
      const { posts, outcome } = await fetchSubreddit(target.subreddit, mode)
      return { target, posts, mode, outcome }
    }),
  )

  const outcomes: FetchOutcome[] = []
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[reddit] Subreddit fetch failed:', result.reason instanceof Error ? result.reason.message : result.reason)
      // fetchSubreddit catches its own fetch throws, so a rejection here is OUR bug, not the
      // network's — folded in as transient because it is still zero evidence about Reddit.
      outcomes.push('transient')
      continue
    }
    const { target, posts, mode, outcome } = result.value
    outcomes.push(outcome)

    for (const post of posts) {
      // Double-check keywords (Reddit search can be fuzzy)
      const matched = mode === 'competitive' ? matchesCompetitiveKeywords(post.title)
        : mode === 'security' ? matchesSecurityKeywords(post.title)
        : matchesKeywords(post.title)
      if (!matched) continue

      // Skip old posts (>6h)
      const age = Date.now() / 1000 - post.createdUtc
      if (age > 21600) continue

      // KV dedup
      const key = `reddit:seen:${post.id}`
      const seen = await kv.get(key).catch((err) => {
        console.error('[reddit] KV dedup read failed:', key, err instanceof Error ? err.message : err)
        return null  // favor sending potential duplicate over silently dropping alert
      })
      if (seen) continue

      alerts.push({ key, subreddit: target.subreddit, post, type: mode })
    }
  }

  // #820 — record source health from the run's outcomes so a total block is legible in the daily
  // summary instead of rendering as a quiet day. Best-effort throughout: a KV failure here must
  // never cost the caller its alerts.
  switch (decideSourceHealth(outcomes)) {
    case 'clear':
      await clearRedditSourceDead(kv)
      await resetTransientStreak(kv)
      break
    case 'partial':
      await markRedditSourceDead(kv, 'partial')
      await resetTransientStreak(kv)  // we DID hear from the source, so the streak is not running
      break
    case 'mark':
      await markRedditSourceDead(kv, 'block')
      await resetTransientStreak(kv)
      break
    case 'bump': {
      const streak = await bumpTransientStreak(kv)
      if (transientStreakEscalates(streak)) await markRedditSourceDead(kv, 'streak')
      break
    }
  }

  return alerts
}

// Subreddit → Is X Down slug mapping for share links
// #1164 — ClaudeAI/OpenAI point at the '-api' slugs (Claude API / OpenAI API), matching every other
// slug map this migration touched (TWEET_DRAFT_SERVICES, RSS/SPA feed overrides, RELATED_SLUGS, the
// extension). A Reddit promote share is about the specific product a subreddit discusses, not the
// provider broadly — same reasoning "Alternatives" links point at a product, not a family group page.
const SUBREDDIT_SLUG: Record<string, string> = {
  ClaudeAI: 'claude-api', ClaudeCode: 'claude-code',
  ChatGPT: 'chatgpt', OpenAI: 'openai-api',
  cursor: 'cursor', windsurf: 'windsurf', Codeium: 'windsurf',
}

/**
 * Format a Reddit alert for Discord.
 * Only called for promotable posts — non-promotable are filtered out upstream.
 */
export function formatRedditAlert(alert: RedditAlert): { title: string; description: string; color: number; url: string } {
  const ago = Math.floor(Date.now() / 1000 - alert.post.createdUtc)
  const agoText = ago < 60 ? 'just now'
    : ago < 3600 ? `${Math.floor(ago / 60)}m ago`
    : `${Math.floor(ago / 3600)}h ago`

  // #539: `?e=reddit` namespaces the promote share so it doesn't collide with status-alert unfurls
  // (this is a community-mention alert, not a status event). Post title is defused so a bare
  // "claude.ai" in it doesn't auto-link in the operator channel.
  const slug = SUBREDDIT_SLUG[alert.subreddit]
  // #548 — utm_source=reddit so GA4 attributes clicks from the promote share to the Reddit channel.
  // Rendered as INLINE CODE, not a clickable link, for the same reason appendRedditSection's is: a
  // Discord click carries no reddit referrer host, so this tag alone decides its bucket, and an
  // operator click is indistinguishable afterwards from a real visitor's. Fixing the engage block
  // and leaving this one would have left the bucket just as unreadable while looking fixed — this
  // alert's whole purpose is "go engage with this post", so it is the likelier click.
  const shareLink = slug ? `\n🔗 \`${appendUtm(appendStatusHint(`https://ai-watch.dev/is-${slug}-down`, 'reddit'), 'reddit')}\`` : ''

  return {
    title: `📢 Reddit: r/${alert.subreddit} [🎯 PROMOTE]`,
    description: `"${defuseAutolinkDomain(alert.post.title)}"\nby u/${alert.post.author} · ${alert.post.score} upvotes · ${agoText}${shareLink}`,
    color: 0x3fb950, // green
    url: alert.post.url,
  }
}

export function formatCompetitiveAlert(alert: RedditAlert): { title: string; description: string; color: number; url: string } {
  const ago = Math.floor(Date.now() / 1000 - alert.post.createdUtc)
  const agoText = ago < 60 ? 'just now'
    : ago < 3600 ? `${Math.floor(ago / 60)}m ago`
    : `${Math.floor(ago / 3600)}h ago`

  return {
    title: `🔍 Competitive: r/${alert.subreddit}`,
    description: `"${alert.post.title}"\nby u/${alert.post.author} · ${alert.post.score} upvotes · ${agoText}`,
    color: 0x8b949e, // gray
    url: alert.post.url,
  }
}

export function formatSecurityAlert(alert: RedditAlert): { title: string; description: string; color: number; url: string } {
  const ago = Math.floor(Date.now() / 1000 - alert.post.createdUtc)
  const agoText = ago < 60 ? 'just now'
    : ago < 3600 ? `${Math.floor(ago / 60)}m ago`
    : `${Math.floor(ago / 3600)}h ago`

  return {
    title: `🔒 Security: r/${alert.subreddit}`,
    description: `"${alert.post.title}"\nby u/${alert.post.author} · ${alert.post.score} upvotes · ${agoText}`,
    color: 0xf85149, // red — security alerts are high-priority
    url: alert.post.url,
  }
}

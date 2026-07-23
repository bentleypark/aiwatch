// Reddit community monitoring — detect "is X down?" posts in target subreddits
// #820: authenticated OAuth2 app-only path. Reddit now 403s the public JSON search
// endpoints from datacenter IPs (Cloudflare Worker egress), so authentication is the only
// robust path — a token is minted from REDDIT_CLIENT_ID/SECRET and search hits oauth.reddit.com.

import { defuseAutolinkDomain } from './alerts'
import { appendStatusHint, appendUtm } from './utils'

// #820 — Reddit OAuth2 app-only (client_credentials) constants. Spec verified 2026-06-29.
export const REDDIT_TOKEN_KEY = 'reddit:token'        // KV-cached bearer token
export const REDDIT_SOURCE_DEAD_KEY = 'reddit:source-dead' // observability marker for a persistent auth/block failure
export const REDDIT_TRANSIENT_STREAK_KEY = 'reddit:transient-streak' // consecutive all-transient (network) runs
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token'
const REDDIT_OAUTH_HOST = 'https://oauth.reddit.com'
// TTL for the source-dead marker: 26h so it survives to the next daily-summary read but
// self-expires if the hourly cron stops running entirely (never a permanently stuck warning).
const SOURCE_DEAD_TTL_SEC = 93600
// Consecutive all-transient (network black-hole / timeout) runs before escalating to source-dead.
// A single run tells us nothing (one blip), but a sustained streak where the token host is up yet
// every search is unreachable is a real outage that must NOT hide as a quiet day (#820). Hourly
// cron → ~3h of total network block before the warning fires. Same 26h self-expiring TTL.
const TRANSIENT_STREAK_LIMIT = 3

export interface RedditCreds {
  clientId: string
  clientSecret: string
  username?: string  // operator reddit handle, for the required descriptive User-Agent
}

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
// Exported for tests — presence/mode assertions enforce that the playbook's engagement list
// stays in sync with the cron (#280).
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

/**
 * Spec-conforming User-Agent: `<platform>:<app-id>:<version> (by /u/<username>)`.
 * The old `AIWatch/1.0 (...)` is non-conforming and Reddit throttles it (#820). The handle
 * comes from REDDIT_USERNAME; a placeholder keeps the format valid if it's unset.
 */
export function redditUserAgent(creds: Pick<RedditCreds, 'username'>): string {
  const handle = creds.username?.trim() || 'aiwatch_ops'
  return `web-app:dev.ai-watch.reddit-monitor:v1.0 (by /u/${handle})`
}

/**
 * Build the client_credentials token POST (HTTP Basic = client_id:client_secret).
 * Pure + exported so the auth shape is unit-testable without a live fetch.
 */
export function buildTokenRequest(creds: RedditCreds): { url: string; init: RequestInit } {
  const basic = btoa(`${creds.clientId}:${creds.clientSecret}`)
  return {
    url: REDDIT_TOKEN_URL,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': redditUserAgent(creds),
      },
      body: 'grant_type=client_credentials',
    },
  }
}

const SEARCH_QUERY: Record<RedditAlertType, string> = {
  competitive: '"status monitor" OR "uptime dashboard" OR "api status" OR "is down" OR "status page"',
  security: 'breach OR leak OR hacked OR vulnerability OR CVE OR "unauthorized access" OR exploit OR "security incident"',
  outage: 'down OR "not working" OR outage OR issues OR error',
}

/**
 * Build the authenticated search GET against oauth.reddit.com (NOT www.reddit.com).
 * Pure + exported so the host/Bearer/UA are unit-testable.
 */
export function buildSearchRequest(subreddit: string, mode: RedditAlertType, token: string, ua: string): { url: string; init: RequestInit } {
  const q = encodeURIComponent(SEARCH_QUERY[mode])
  return {
    url: `${REDDIT_OAUTH_HOST}/r/${subreddit}/search?q=${q}&sort=new&restrict_sr=on&t=day&limit=5`,
    init: { headers: { Authorization: `Bearer ${token}`, 'User-Agent': ua } },
  }
}

/**
 * Fetch (and KV-cache) a Reddit app-only bearer token. `force` bypasses + evicts the cache
 * to re-mint after a 401 (token rotated/expired). Returns null on any failure — the caller
 * treats a null token as a dead source.
 */
export async function getRedditAppToken(kv: KVNamespace, creds: RedditCreds, opts: { force?: boolean } = {}): Promise<string | null> {
  if (opts.force) {
    await kv.delete(REDDIT_TOKEN_KEY).catch(() => {})
  } else {
    const cached = await kv.get(REDDIT_TOKEN_KEY).catch(() => null)
    if (cached) return cached
  }

  const { url, init } = buildTokenRequest(creds)
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) })
  } catch (err) {
    console.error('[reddit] token fetch threw:', err instanceof Error ? err.message : err)
    return null
  }
  if (!res.ok) {
    console.warn(`[reddit] token endpoint returned HTTP ${res.status}`)
    res.body?.cancel()
    return null
  }
  const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null
  if (!data?.access_token) return null

  // Cache under TTL = expires_in − 60s margin (floor 60s) so a near-expiry token isn't served.
  const ttl = Math.max(60, (data.expires_in ?? 3600) - 60)
  await kv.put(REDDIT_TOKEN_KEY, data.access_token, { expirationTtl: ttl }).catch((err) => {
    console.error('[reddit] token cache write failed:', err instanceof Error ? err.message : err)
  })
  return data.access_token
}

// Auth/blocking statuses that mean the SOURCE is dead (surface it), not a per-subreddit blip:
// 401 = token rotated/expired (already retried once), 403 = IP/UA block, 429 = rate limited.
function isDeadStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429
}

// A single subreddit fetch resolves to one of THREE states — not two. Folding "no response at
// all" into "success" is what let a network-level block silently zero out (#820 root cause):
//   ok        — a 2xx response came back (proof the source is alive), regardless of post count
//   dead      — an auth/block/rate response (401-after-refresh / 403 / 429): the SOURCE is blocked
//   transient — no response (network throw/timeout) or a non-auth error (5xx): tells us nothing
type FetchOutcome = 'ok' | 'dead' | 'transient'

interface FetchResult {
  posts: RedditPost[]
  outcome: FetchOutcome
}

/**
 * Fetch recent posts from a subreddit matching outage keywords, authenticated.
 * On 401 (token rotated/expired) it refreshes the token once and retries.
 */
async function fetchSubreddit(
  subreddit: string,
  mode: RedditAlertType,
  auth: { token: string; ua: string; refresh: () => Promise<string | null> },
): Promise<FetchResult> {
  const doFetch = async (token: string): Promise<Response | null> => {
    const { url, init } = buildSearchRequest(subreddit, mode, token, auth.ua)
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(5000) })
    } catch (err) {
      console.error(`[reddit] r/${subreddit} fetch threw:`, err instanceof Error ? err.message : err)
      return null
    }
  }

  let res = await doFetch(auth.token)
  // 401 → token rotated/expired: refresh once and retry with the fresh token.
  if (res && res.status === 401) {
    res.body?.cancel()
    const fresh = await auth.refresh()
    if (!fresh) return { posts: [], outcome: 'dead' } // token rotated AND re-mint blocked → source dead
    res = await doFetch(fresh)
  }

  if (!res) return { posts: [], outcome: 'transient' } // network throw — no response; proves nothing
  if (!res.ok) {
    console.warn(`[reddit] r/${subreddit} returned HTTP ${res.status}`)
    res.body?.cancel()
    // Only an auth/block/rate status is source-death; a 5xx etc. is transient (won't set OR clear).
    return { posts: [], outcome: isDeadStatus(res.status) ? 'dead' : 'transient' }
  }
  const json = await res.json().catch(() => null)
  return { posts: parseRedditResponse(json), outcome: 'ok' }
}

/**
 * Marker so a persistent auth/block failure is visible in the daily summary instead of
 * silently zeroing out ("403 → 0 posts" is otherwise indistinguishable from a quiet day, #820).
 */
async function markRedditSourceDead(kv: KVNamespace, reason: 'token' | 'fetch'): Promise<void> {
  await kv.put(REDDIT_SOURCE_DEAD_KEY, JSON.stringify({ reason, at: Date.now() }), { expirationTtl: SOURCE_DEAD_TTL_SEC })
    .catch((err) => console.error('[reddit] source-dead marker write failed:', err instanceof Error ? err.message : err))
}
async function clearRedditSourceDead(kv: KVNamespace): Promise<void> {
  await kv.delete(REDDIT_SOURCE_DEAD_KEY)
    .catch((err) => console.error('[reddit] source-dead marker clear failed:', err instanceof Error ? err.message : err))
}

/** Increment the consecutive-all-transient-runs counter and return the new streak (0 on any error). */
async function bumpTransientStreak(kv: KVNamespace): Promise<number> {
  // Log a read failure for parity with the put below: a swallowed read is indistinguishable from
  // "no prior streak", so a repeatedly-failing read would silently cap the streak at 1 and DISABLE
  // the escalation this counter exists for — the exact silent-zeroing #820 fights. Make it visible.
  const raw = await kv.get(REDDIT_TRANSIENT_STREAK_KEY).catch((err) => {
    console.error('[reddit] transient-streak read failed:', err instanceof Error ? err.message : err)
    return null
  })
  const next = (Number.parseInt(raw ?? '0', 10) || 0) + 1
  await kv.put(REDDIT_TRANSIENT_STREAK_KEY, String(next), { expirationTtl: SOURCE_DEAD_TTL_SEC })
    .catch((err) => console.error('[reddit] transient-streak write failed:', err instanceof Error ? err.message : err))
  return next
}
async function resetTransientStreak(kv: KVNamespace): Promise<void> {
  await kv.delete(REDDIT_TRANSIENT_STREAK_KEY)
    .catch((err) => console.error('[reddit] transient-streak reset failed:', err instanceof Error ? err.message : err))
}

export interface RedditSourceDead { reason: string; at: number }

/** Read the source-dead marker for the daily summary. Returns null when the source is healthy. */
export async function readRedditSourceDead(kv: KVNamespace): Promise<RedditSourceDead | null> {
  const raw = await kv.get(REDDIT_SOURCE_DEAD_KEY).catch(() => null)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as RedditSourceDead
    return typeof parsed?.reason === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Scan all target subreddits and return new posts not yet seen in KV
 */
export async function detectRedditPosts(
  kv: KVNamespace | null,
  creds?: Partial<RedditCreds>,
): Promise<RedditAlert[]> {
  if (!kv) return []

  // #820: OAuth app-only is the only robust path. Without credentials, skip quietly — the
  // operator hasn't registered the Reddit app / set the secrets yet (not a source death).
  if (!creds?.clientId || !creds?.clientSecret) {
    console.warn('[reddit] REDDIT_CLIENT_ID/SECRET not set — Reddit monitoring disabled')
    return []
  }
  const fullCreds: RedditCreds = { clientId: creds.clientId, clientSecret: creds.clientSecret, username: creds.username }

  const token = await getRedditAppToken(kv, fullCreds)
  if (!token) {
    await markRedditSourceDead(kv, 'token')
    return []
  }

  // Dedup concurrent 401 refreshes across the parallel fetches into a single token request.
  let refreshPromise: Promise<string | null> | null = null
  const refresh = () => (refreshPromise ??= getRedditAppToken(kv, fullCreds, { force: true }))
  const ua = redditUserAgent(fullCreds)

  const alerts: RedditAlert[] = []

  // Fetch all subreddits in parallel
  const results = await Promise.allSettled(
    REDDIT_TARGETS.map(async (target) => {
      const mode: RedditAlertType = target.service === '_competitive' ? 'competitive'
        : target.service === '_security' ? 'security' : 'outage'
      const { posts, outcome } = await fetchSubreddit(target.subreddit, mode, { token, ua, refresh })
      return { target, posts, mode, outcome }
    }),
  )

  let anyDead = false
  let anyOk = false
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[reddit] Subreddit fetch failed:', result.reason instanceof Error ? result.reason.message : result.reason)
      continue
    }
    const { target, posts, mode, outcome } = result.value
    if (outcome === 'dead') anyDead = true
    else if (outcome === 'ok') anyOk = true

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

  // #820 observability, decided by the three-state fold:
  //   • any OK response → the source is provably alive → self-heal (clear the marker + reset the
  //     transient streak). A lone 403 from ONE private/banned subreddit alongside real successes is
  //     per-subreddit noise, NOT a source-wide block, so a genuine success outweighs it.
  //   • else if any dead-status AND zero OK → the whole source is blocked → mark it dead (a definite
  //     signal, so the transient streak resets too).
  //   • else (all transient — every target threw / 5xx, no OK, no dead) → this single run learned
  //     nothing, so don't fabricate a marker off one blip; but a SUSTAINED streak of all-transient
  //     runs (token host up, every search unreachable) is a real network block that must not hide as
  //     a quiet day — escalate to dead once the streak crosses the limit. Below it, leave any
  //     existing marker untouched (never wipe a real one on a run that proves nothing).
  if (anyOk) {
    await clearRedditSourceDead(kv)
    await resetTransientStreak(kv)
  } else if (anyDead) {
    await markRedditSourceDead(kv, 'fetch')
    await resetTransientStreak(kv)
  } else {
    const streak = await bumpTransientStreak(kv)
    if (streak >= TRANSIENT_STREAK_LIMIT) await markRedditSourceDead(kv, 'fetch')
  }

  return alerts
}

// Subreddit → Is X Down slug mapping for share links
const SUBREDDIT_SLUG: Record<string, string> = {
  ClaudeAI: 'claude', ClaudeCode: 'claude-code',
  ChatGPT: 'chatgpt', OpenAI: 'openai',
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
  const shareLink = slug ? `\n🔗 ${appendUtm(appendStatusHint(`https://ai-watch.dev/is-${slug}-down`, 'reddit'), 'reddit')}` : ''

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

// Reddit community monitoring — detect "is X down?" posts in target subreddits
// Uses Reddit's public JSON search endpoint (no OAuth required)

import { defuseAutolinkDomain } from './alerts'
import { appendStatusHint, appendUtm } from './utils'

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

/**
 * Fetch recent posts from a subreddit matching outage keywords
 */
async function fetchSubreddit(subreddit: string, mode: 'outage' | 'competitive' | 'security' = 'outage'): Promise<RedditPost[]> {
  const query = mode === 'competitive'
    ? encodeURIComponent('"status monitor" OR "uptime dashboard" OR "api status" OR "is down" OR "status page"')
    : mode === 'security'
    ? encodeURIComponent('breach OR leak OR hacked OR vulnerability OR CVE OR "unauthorized access" OR exploit OR "security incident"')
    : encodeURIComponent('down OR "not working" OR outage OR issues OR error')
  const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${query}&sort=new&restrict_sr=on&t=day&limit=5`

  const res = await fetch(url, {
    headers: { 'User-Agent': 'AIWatch/1.0 (ai-watch.dev; status monitoring)' },
    signal: AbortSignal.timeout(5000),
  })

  if (!res.ok) {
    console.warn(`[reddit] r/${subreddit} returned HTTP ${res.status}`)
    res.body?.cancel()
    return []
  }

  const json = await res.json()
  return parseRedditResponse(json)
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
      const posts = await fetchSubreddit(target.subreddit, mode)
      return { target, posts, mode }
    }),
  )

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[reddit] Subreddit fetch failed:', result.reason instanceof Error ? result.reason.message : result.reason)
      continue
    }
    const { target, posts, mode } = result.value

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

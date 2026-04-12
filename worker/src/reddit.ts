// Reddit community monitoring — detect "is X down?" posts in target subreddits
// Uses Reddit's public JSON search endpoint (no OAuth required)

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

// Subreddit → search keywords mapping
const REDDIT_TARGETS: Array<{ subreddit: string; service: string }> = [
  // Service-specific subreddits (outage detection + promotion)
  { subreddit: 'ClaudeAI',        service: 'Claude' },
  { subreddit: 'ClaudeCode',      service: 'Claude Code' },
  { subreddit: 'ChatGPT',         service: 'ChatGPT' },
  { subreddit: 'OpenAI',          service: 'OpenAI' },
  { subreddit: 'cursor',          service: 'Cursor' },
  { subreddit: 'windsurf',        service: 'Windsurf' },
  { subreddit: 'Codeium',         service: 'Windsurf' },
  // Competitive monitoring — broader AI/DevOps communities
  { subreddit: 'devops',          service: '_competitive' },
  { subreddit: 'artificial',      service: '_competitive' },
  { subreddit: 'LocalLLaMA',      service: '_competitive' },
  // Security monitoring — security communities for AI service breach/vulnerability chatter
  { subreddit: 'netsec',          service: '_security' },
  { subreddit: 'cybersecurity',   service: '_security' },
]

// Strong signals: always match. Weak signals (issues/errors/slow): require context words
const STRONG = /\b(down|not working|outage|broken|offline|unavailable|degraded)\b/i
const WEAK_WITH_CONTEXT = /\b(issues?|errors?|slow)\b/i
const CONTEXT = /\b(anyone|right now|today|currently|status|server|api|service)\b/i

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
 * Check if a post title matches outage-related keywords
 */
export function matchesKeywords(title: string): boolean {
  if (STRONG.test(title)) return true
  return WEAK_WITH_CONTEXT.test(title) && CONTEXT.test(title)
}

// Question indicators — posts seeking help are good promotion opportunities
// Require question mark, or question-style phrasing with outage context
const QUESTION_WITH_CONTEXT = /\?|^is\s.+\b(down|working|broken|available)/i
const ANYONE_WITH_OUTAGE = /\b(anyone|anybody|someone|does anyone)\b.+\b(down|issue|problem|working|error|status|outage)/i
const SEEKING_HELP = /\b(help|what('s| is) (going on|happening)|how (to|do) (check|tell|know))\b/i

/**
 * Check if a post is suitable for AIWatch promotion.
 * Promotable = question-style posts where users are seeking help/status info.
 * Not promotable = statements, rants, reports where the user already has an answer.
 */
export function isPromotable(title: string): boolean {
  return QUESTION_WITH_CONTEXT.test(title) || ANYONE_WITH_OUTAGE.test(title) || SEEKING_HELP.test(title)
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

  const slug = SUBREDDIT_SLUG[alert.subreddit]
  const shareLink = slug ? `\n🔗 https://ai-watch.dev/is-${slug}-down` : ''

  return {
    title: `📢 Reddit: r/${alert.subreddit} [🎯 PROMOTE]`,
    description: `"${alert.post.title}"\nby u/${alert.post.author} · ${alert.post.score} upvotes · ${agoText}${shareLink}`,
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

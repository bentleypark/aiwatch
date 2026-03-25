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

export interface RedditAlert {
  key: string       // KV dedup key: reddit:seen:{postId}
  subreddit: string
  post: RedditPost
}

// Subreddit → search keywords mapping
const REDDIT_TARGETS: Array<{ subreddit: string; service: string }> = [
  { subreddit: 'ClaudeAI',        service: 'Claude' },
  { subreddit: 'ClaudeCode',      service: 'Claude Code' },
  { subreddit: 'ChatGPT',         service: 'ChatGPT' },
  { subreddit: 'OpenAI',          service: 'OpenAI' },
  { subreddit: 'cursor',          service: 'Cursor' },
  { subreddit: 'windsurf',        service: 'Windsurf' },
  { subreddit: 'Codeium',         service: 'Windsurf' },
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

/**
 * Fetch recent posts from a subreddit matching outage keywords
 */
async function fetchSubreddit(subreddit: string): Promise<RedditPost[]> {
  const query = encodeURIComponent('down OR "not working" OR outage OR issues OR error')
  const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${query}&sort=new&restrict_sr=on&t=day&limit=5`

  const res = await fetch(url, {
    headers: { 'User-Agent': 'AIWatch/1.0 (ai-watch.dev; status monitoring)' },
    signal: AbortSignal.timeout(5000),
  })

  if (!res.ok) {
    console.warn(`[reddit] r/${subreddit} returned HTTP ${res.status}`)
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
      const posts = await fetchSubreddit(target.subreddit)
      return { target, posts }
    }),
  )

  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const { target, posts } = result.value

    for (const post of posts) {
      // Double-check keywords (Reddit search can be fuzzy)
      if (!matchesKeywords(post.title)) continue

      // Skip old posts (>6h)
      const age = Date.now() / 1000 - post.createdUtc
      if (age > 21600) continue

      // KV dedup
      const key = `reddit:seen:${post.id}`
      const seen = await kv.get(key).catch(() => null)
      if (seen) continue

      alerts.push({ key, subreddit: target.subreddit, post })
    }
  }

  return alerts
}

/**
 * Format a Reddit alert for Discord
 */
export function formatRedditAlert(alert: RedditAlert): { title: string; description: string; color: number; url: string } {
  const ago = Math.floor(Date.now() / 1000 - alert.post.createdUtc)
  const agoText = ago < 60 ? 'just now'
    : ago < 3600 ? `${Math.floor(ago / 60)}m ago`
    : `${Math.floor(ago / 3600)}h ago`

  return {
    title: `📢 Reddit: r/${alert.subreddit}`,
    description: `"${alert.post.title}"\nby u/${alert.post.author} · ${alert.post.score} upvotes · ${agoText}`,
    color: 0xFF4500, // Reddit orange
    url: alert.post.url,
  }
}

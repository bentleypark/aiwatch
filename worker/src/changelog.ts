// Changelog / News collection — detect new AI service updates
// Pilot: OpenAI (blog RSS), Google (AI blog RSS), Anthropic (news page HTML)

import { kvPut } from './utils'

export interface ChangelogEntry {
  source: string    // 'openai' | 'google' | 'anthropic'
  title: string
  url: string
  date: string      // ISO date
}

export interface ChangelogSource {
  id: string
  name: string
  feedUrl: string
  type: 'rss' | 'html'
}

export const CHANGELOG_SOURCES: ChangelogSource[] = [
  { id: 'openai', name: 'OpenAI', feedUrl: 'https://openai.com/blog/rss.xml', type: 'rss' },
  { id: 'google', name: 'Google AI', feedUrl: 'https://blog.google/technology/ai/rss/', type: 'rss' },
  { id: 'anthropic', name: 'Anthropic', feedUrl: 'https://www.anthropic.com/news', type: 'html' },
]

// OpenAI/Google blog RSS contains non-API content — filter to relevant items
const RELEVANCE_KEYWORDS = /\b(model|api|gpt|gemini|claude|sdk|release|deprecat|pricing|rate.?limit|token|endpoint|embed|function.?call|tool.?us|vision|voice|image|video|reason|agent|fine.?tun|batch|assistant|codex|sora|dall|whisper|introduc)/i
const NOISE_KEYWORDS = /\b(hiring|career|team spotlight|company update|policy statement|annual report|getting started|fundamentals|how to use|using .+|chatgpt for \w+|prompting|writing with|research with|analyzing data|creating .+ with chatgpt|healthcare|financial services|safety blueprint|bug bounty|model spec|misalignment|monitor.*agent|our (approach|response)|doesn't include|safe use of ai|responsible)\b/i

// Anthropic news: filter to product/tech announcements
const ANTHROPIC_RELEVANCE = /\b(introduc|launch|announc|releas|claude|model|api|code|agent|feature|acquir|partner.*claude|computer use|mcp|protocol|project\s+\w+|frontier|preview|mythos|glasswing|capybara|sonnet|opus|haiku)/i
const ANTHROPIC_NOISE = /\b(statement|policy|safety|responsible|economic|education|office|partnership.*(?:government|university|institute)|signs?\b|MOU|hiring|appoint|advisory|pledge|trust|compliance|election)/i

export function isRelevantEntry(title: string, source: string): boolean {
  if (source === 'anthropic') {
    if (ANTHROPIC_NOISE.test(title)) return false
    return ANTHROPIC_RELEVANCE.test(title)
  }
  // Blog posts: require relevance keyword, reject noise
  if (NOISE_KEYWORDS.test(title)) return false
  return RELEVANCE_KEYWORDS.test(title)
}

/**
 * Parse RSS 2.0 XML into entries (OpenAI, Google)
 */
export function parseRssEntries(xml: string, source: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi)
  if (!items) return []

  for (const item of items.slice(0, 50)) {
    const title = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim() ?? ''
    const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim() ?? ''
    const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ?? ''

    if (!title || !link) continue
    const parsed = pubDate ? new Date(pubDate) : null
    const date = parsed && !isNaN(parsed.getTime()) ? parsed.toISOString() : ''

    entries.push({ source, title, url: link, date })
  }
  return entries
}

/**
 * Parse Anthropic /news HTML page (Next.js SSR payload).
 * Extracts from two data structures:
 * 1. Featured grid items: {"_type":"featuredGridLink","date":"...","title":"...","url":"..."}
 * 2. News list items: publishedOn + slug + title pattern
 */
export function parseAnthropicNews(html: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  const seen = new Set<string>()
  // Unescape the JSON (Next.js RSC payload uses escaped quotes)
  const u = html.replace(/\\"/g, '"')

  // 1. Featured grid items (e.g. Project Glasswing — published at /glasswing, not /news/)
  const featRe = /"_type":"featuredGridLink","date":"([^"]+)","(?:subject":"[^"]*",")?(summary":"[^"]*",")?title":"([^"]+)","url":"([^"]+)"/g
  let m
  while ((m = featRe.exec(u)) !== null) {
    const date = m[1]
    const title = m[3]
    const urlPath = m[4]
    const parsed = new Date(date)
    if (isNaN(parsed.getTime())) continue
    const fullUrl = urlPath.startsWith('http') ? urlPath : `https://www.anthropic.com${urlPath}`
    if (seen.has(fullUrl)) continue
    seen.add(fullUrl)
    entries.push({ source: 'anthropic', title, url: fullUrl, date: parsed.toISOString() })
  }

  // 2. News list items: publishedOn + slug pairs
  const slugRe = /"publishedOn":"([^"]+)","slug":\{"_type":"slug","current":"([^"]+)"\}/g
  while ((m = slugRe.exec(u)) !== null) {
    const slug = m[2]
    const fullUrl = `https://www.anthropic.com/news/${slug}`
    if (seen.has(fullUrl)) continue
    seen.add(fullUrl)

    // Find title AFTER slug (the JSON structure has: ...slug...subjects...title)
    const searchStr = `"current":"${slug}"`
    const pos = u.indexOf(searchStr)
    if (pos < 0) continue
    const after = u.substring(pos, pos + 1500)
    const titleMatch = after.match(/"title":"([^"]{5,300})"/)
    if (!titleMatch) continue

    const parsed = new Date(m[1])
    if (isNaN(parsed.getTime())) continue

    entries.push({ source: 'anthropic', title: titleMatch[1], url: fullUrl, date: parsed.toISOString() })
  }
  return entries
}

/**
 * Fetch and parse a single changelog source.
 * Returns relevant entries from the last 7 days.
 */
async function fetchSource(src: ChangelogSource): Promise<ChangelogEntry[]> {
  const res = await fetch(src.feedUrl, {
    headers: { 'User-Agent': 'AIWatch/1.0 (ai-watch.dev; changelog monitoring)' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    res.body?.cancel()
    throw new Error(`${src.id} returned HTTP ${res.status}`)
  }
  const text = await res.text()
  const entries = src.type === 'html'
    ? parseAnthropicNews(text)
    : parseRssEntries(text, src.id)
  if (entries.length === 0 && text.length > 1000) {
    console.warn(`[changelog] ${src.id}: fetched ${text.length} bytes but parsed 0 entries — possible format change`)
  }

  // Filter to last 7 days + relevance
  const weekAgo = Date.now() - 7 * 86_400_000
  return entries.filter((e) => {
    if (!e.date) return false
    const ts = new Date(e.date).getTime()
    if (isNaN(ts) || ts < weekAgo) return false
    return isRelevantEntry(e.title, e.source)
  })
}

/**
 * Collect changelog entries from all sources.
 * Dedup against KV (only return new entries not seen before).
 */
export async function collectChangelogs(
  kv: KVNamespace | null,
): Promise<ChangelogEntry[]> {
  if (!kv) return []

  const results = await Promise.allSettled(
    CHANGELOG_SOURCES.map((src) => fetchSource(src)),
  )

  // Read previously seen entries
  const seenRaw = await kv.get('changelog:entries').catch(() => null)
  const seen: ChangelogEntry[] = seenRaw ? JSON.parse(seenRaw) : []
  const seenKeys = new Set(seen.map((e) => `${e.source}:${e.title}`))

  const newEntries: ChangelogEntry[] = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'rejected') {
      console.warn(`[changelog] ${CHANGELOG_SOURCES[i].id} fetch failed:`, result.reason instanceof Error ? result.reason.message : result.reason)
      continue
    }
    for (const entry of result.value) {
      const key = `${entry.source}:${entry.title}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      newEntries.push(entry)
    }
  }

  // Persist accumulated entries (append new to existing)
  if (newEntries.length > 0) {
    const updated = [...seen, ...newEntries].slice(-50) // keep last 50
    await kvPut(kv, 'changelog:entries', JSON.stringify(updated), { expirationTtl: 1_209_600 }) // 14d
  }

  return newEntries
}

/**
 * Format changelog entries for Discord embed section
 */
export function formatChangelogSection(entries: ChangelogEntry[]): string {
  if (entries.length === 0) return 'No service changes detected this week.'

  const sourceNames: Record<string, string> = {
    openai: 'OpenAI',
    google: 'Google AI',
    anthropic: 'Anthropic',
  }

  return entries
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 8) // max 8 items in Discord embed
    .map((e) => {
      const date = new Date(e.date)
      const dateStr = `${date.getMonth() + 1}/${date.getDate()}`
      const name = sourceNames[e.source] ?? e.source
      return `• ${name}: ${e.title} (${dateStr})`
    })
    .join('\n')
}

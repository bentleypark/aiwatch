// Changelog / News collection — detect new AI service updates
// Pilot: OpenAI (blog RSS), Google (AI blog RSS), Anthropic (news page HTML)

import { kvPut } from './utils'

export interface ChangelogEntry {
  source: string    // 'openai' | 'google' | 'anthropic' | 'copilot'
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
  { id: 'copilot', name: 'GitHub Copilot', feedUrl: 'https://github.blog/changelog/label/copilot/feed/', type: 'rss' },
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
  // Pre-filtered changelog sources — all entries are relevant
  if (source === 'copilot') return true
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

/** Per-source fetch timeout. Anthropic /news is ~350KB Next.js SSR — 8s was too aggressive (#274). */
const FETCH_TIMEOUT_MS = 15_000

/**
 * Inverse policy: maintain a small allowlist of *permanent* errors and treat
 * everything else as transient. Cost of an extra retry on a non-retriable error
 * is one wasted fetch (~15s); cost of NOT retrying a transient runtime error
 * (DNS blip, "Internal error 1042", connect refused, etc.) is a silently dropped
 * source for the cycle, which silently propagates into stale-source warnings.
 */
function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  // Programming bugs — never retry, would just double the wall-clock waste
  if (err instanceof TypeError || err instanceof SyntaxError || err instanceof RangeError) return false
  // Worker runtime hard limits — retry would either repeat or be killed by the runtime
  if (/subrequest depth|CPU time limit|script will never generate/i.test(err.message)) return false
  // Everything else (Abort/Timeout/NetworkError, DNS, connect-refused, transient 1042, etc.)
  return true
}

/**
 * Fetch with one retry on transient failure (timeout / 5xx / network error).
 * 4xx fails fast — those are permanent (auth/path bugs that retry won't fix).
 * Permanent thrown errors (TypeError, RangeError, etc.) also fail fast — retrying
 * a programming bug just doubles the wall-clock waste.
 */
export async function fetchWithRetry(url: string, headers: Record<string, string>): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (res.status >= 500 && attempt === 0) {
        // Log so we have forensic trail when retries quietly mask flapping upstreams.
        console.warn(`[changelog] ${url} returned HTTP ${res.status} on attempt 0, retrying`)
        res.body?.cancel()
        continue
      }
      return res
    } catch (err) {
      if (attempt === 0 && isTransientError(err)) {
        console.warn(`[changelog] transient fetch error on attempt 0, retrying:`, err instanceof Error ? err.message : err)
        continue
      }
      throw err
    }
  }
  throw new Error('unreachable') // satisfies TS — loop above always returns or throws
}

/**
 * Fetch and parse a single changelog source.
 * Returns relevant entries from the last 7 days.
 */
async function fetchSource(src: ChangelogSource): Promise<ChangelogEntry[]> {
  const res = await fetchWithRetry(src.feedUrl, {
    'User-Agent': 'AIWatch/1.0 (ai-watch.dev; changelog monitoring)',
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

/** KV key for per-source last-successful-fetch ISO timestamp (#274). */
export function lastFetchKey(sourceId: string): string {
  return `changelog:last-fetch:${sourceId}`
}

/** TTL for last-fetch markers — 7d covers a missed weekly briefing cycle with margin. */
const LAST_FETCH_TTL = 7 * 86_400

/**
 * Collect changelog entries from all sources.
 * Dedup against KV (only return new entries not seen before).
 * Records per-source last-successful-fetch timestamp so the weekly briefing
 * can flag stale sources whose entries may be silently missing.
 */
export async function collectChangelogs(
  kv: KVNamespace | null,
): Promise<ChangelogEntry[]> {
  if (!kv) return []

  // Cap per-source wall-clock at 25s (15s timeout × 2 attempts max = 30s, but the
  // outer cron has a 30s budget shared with other tasks). 25s leaves margin for
  // dedup + KV writes after Promise.allSettled returns.
  const PER_SOURCE_BUDGET_MS = 25_000
  const results = await Promise.allSettled(
    CHANGELOG_SOURCES.map(async (src) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      // Suppress unhandled rejection if the budget timer wins — fetchSource may still
      // reject later (e.g., body read failure), but the race result has already
      // propagated to Promise.allSettled so the late rejection has nowhere to go.
      const fetchPromise = fetchSource(src)
      fetchPromise.catch(() => {})
      try {
        return await Promise.race([
          fetchPromise,
          new Promise<ChangelogEntry[]>((_, reject) => {
            // clearTimeout in finally prevents the timer from firing after the race
            // settles — otherwise it'd produce an unhandled rejection log and hold
            // the isolate alive for the full budget on a fast successful fetch.
            timer = setTimeout(
              () => reject(new Error(`${src.id} fetch budget (${PER_SOURCE_BUDGET_MS}ms) exceeded`)),
              PER_SOURCE_BUDGET_MS,
            )
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }),
  )

  // Read previously seen entries
  const seenRaw = await kv.get('changelog:entries').catch(() => null)
  const seen: ChangelogEntry[] = seenRaw ? JSON.parse(seenRaw) : []
  const seenKeys = new Set(seen.map((e) => `${e.source}:${e.title}`))

  const newEntries: ChangelogEntry[] = []
  const nowIso = new Date().toISOString()
  const lastFetchWrites: Promise<boolean>[] = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const src = CHANGELOG_SOURCES[i]
    if (result.status === 'rejected') {
      console.warn(`[changelog] ${src.id} fetch failed:`, result.reason instanceof Error ? result.reason.message : result.reason)
      continue
    }
    // Record successful fetch (independent of how many entries it produced —
    // fetching the page successfully is the signal that the source is reachable).
    lastFetchWrites.push(kvPut(kv, lastFetchKey(src.id), nowIso, { expirationTtl: LAST_FETCH_TTL }))
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

  // Wait for last-fetch writes to settle and aggregate-log failures —
  // a partial-failure batch silently mis-reports stale sources next week, so it's
  // worth one summary line per cron tick (kvPut already logs each failure individually).
  // Count BOTH rejected (defensive: kvPut shouldn't throw but might in future)
  // AND fulfilled-with-false (kvPut returned false on caught failure).
  if (lastFetchWrites.length > 0) {
    const settled = await Promise.allSettled(lastFetchWrites)
    const rejected = settled.filter((r) => r.status === 'rejected').length
    const failed = settled.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value === false)).length
    if (failed > 0) {
      console.warn(
        `[changelog] ${failed}/${lastFetchWrites.length} last-fetch markers failed to persist ` +
        `(${rejected} threw, ${failed - rejected} returned false) — next stale check may false-positive`,
      )
    }
  }

  return newEntries
}

/**
 * For each source that has not produced a successful fetch in the past
 * `staleAfterMs` window, return how many hours stale it is. Sources missing
 * from KV (never fetched, or TTL expired) are reported as a special "no fetch
 * record" state. Used by the weekly briefing to surface silent collection gaps.
 */
export interface StaleSourceInfo {
  source: string
  name: string
  hoursStale: number | null // null = no record at all
}
export async function getStaleSources(
  kv: KVNamespace | null,
  staleAfterMs = 2 * 86_400_000,
): Promise<StaleSourceInfo[]> {
  if (!kv) return []
  const now = Date.now()
  const stale: StaleSourceInfo[] = []
  for (const src of CHANGELOG_SOURCES) {
    let ts: string | null = null
    try {
      ts = await kv.get(lastFetchKey(src.id))
    } catch (err) {
      // Distinguish KV read failure from "no record" — log + skip so we don't
      // raise false alarms when KV is rate-limited or replicating.
      console.warn(`[changelog] stale check kv read failed for ${src.id}:`, err instanceof Error ? err.message : err)
      continue
    }
    if (!ts) {
      stale.push({ source: src.id, name: src.name, hoursStale: null })
      continue
    }
    const parsed = new Date(ts).getTime()
    if (isNaN(parsed)) {
      // Corrupted / non-ISO value in KV — distinct class of bug from "TTL expired".
      console.warn(`[changelog] stale check: corrupted last-fetch ts for ${src.id}: ${JSON.stringify(ts)}`)
      stale.push({ source: src.id, name: src.name, hoursStale: null })
      continue
    }
    const ms = now - parsed
    if (ms > staleAfterMs) {
      stale.push({ source: src.id, name: src.name, hoursStale: Math.floor(ms / 3_600_000) })
    }
  }
  return stale
}

/** Format stale-source warning for Discord briefing. Returns empty string when nothing is stale. */
export function formatStaleSourcesWarning(stale: StaleSourceInfo[]): string {
  if (stale.length === 0) return ''
  const items = stale.map((s) => {
    if (s.hoursStale === null) return `${s.name} (no fetch record)`
    const days = Math.floor(s.hoursStale / 24)
    const hrs = s.hoursStale % 24
    return `${s.name} (last fetched ${days > 0 ? `${days}d ` : ''}${hrs}h ago)`
  })
  return `⚠️ Changelog sources behind: ${items.join(', ')} — entries may be missing this week.`
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
    copilot: 'GitHub Copilot',
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

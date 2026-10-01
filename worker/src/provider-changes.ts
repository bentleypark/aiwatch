// Provider first-party pricing / billing / deprecation changes
// Phase 1 data + classification layer for #1570.
//
// Deliberately a separate module from changelog.ts: the existing changelog
// pipeline feeds the weekly briefing and filters on the *title*. This pipeline
// detects pricing/billing/deprecation/limits/launch events from first-party
// sources and classifies on the *body*. Wiring these entries to the operator
// Discord alert is a follow-up step; this module exposes the data + a pure
// classifier so that step (and the X draft) can be built and tested.
//
// No third-party dependencies — runs in the Workers runtime.

/** Change categories, ordered by signal specificity. */
export type ProviderChangeCategory =
  | 'pricing'
  | 'billing'
  | 'deprecation'
  | 'limits'
  | 'launch'

/** Provider ids covered by the first-party Phase 1 sources. */
export type ProviderId = 'openai' | 'anthropic'

/** A single, classified provider change event. */
export interface ProviderChange {
  provider: ProviderId
  /** One line / one <li> of a change note. */
  title: string
  url: string
  /** ISO date. Anthropic entries inherit their per-day item date. */
  date: string
  category: ProviderChangeCategory
}

/** First-party Phase 1 sources (verified 2026-10-01 in #1570). */
export const PROVIDER_CHANGE_SOURCES: ReadonlyArray<{
  id: ProviderId
  name: string
  feedUrl: string
}> = [
  {
    id: 'openai',
    name: 'OpenAI',
    feedUrl: 'https://community.openai.com/c/announcements/6.rss',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    feedUrl: 'https://platform.claude.com/docs/en/release-notes/feed.xml',
  },
]

// ─────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────

interface CategoryRule {
  category: ProviderChangeCategory
  /** Positive signals for this category. */
  pattern: RegExp
}

// Pricing and deprecation are the highest-specificity money/removal signals,
// so they are tested first. Callers classify each extracted line independently,
// which keeps scope tight and avoids letting one keyword on a multi-line day
// colour an unrelated line.
const CATEGORY_RULES: ReadonlyArray<CategoryRule> = [
  {
    category: 'deprecation',
    pattern:
      /\b(deprecat\w*|sunset\w*|shut(?:ting)?\s?down|retir\w*|end\s?of\s?life|\beol\b|no\s?longer\s?(?:be\s?)?(?:supported|available)|discontinu\w*|will\s?be\s?removed|last\s?day|end\s?of\s?service)\b/i,
  },
  // Strong, explicit price-change event — wins over launch so a real
  // "20% price reduction" is not read as a launch merely because the post also
  // says "introducing". Broad token/price mentions are handled by the weak
  // pricing fallback at the end.
  {
    category: 'pricing',
    pattern:
      /\b(?:price|pricing)\s+(?:cut|drop|reduction|increase|hike|update|change|changes|adjustment|reduced)|reduced\s+pricing|prices?\s+(?:are\s+)?(?:drop|dropped|cut|reduced|increased|lowered)|lower(?:ed)?\s+(?:the\s+)?prices?|major\s+price\b|\d+(?:\.\d+)?%\s+(?:price|cheaper)|free\s+price\b/i,
  },
  {
    category: 'launch',
    pattern:
      /\b(launch(?:ed|es|ing)?|introduc\w*|announc\w*|releas\w*|now\s?available|generally\s?available|\bga\b|public\s?preview|new\s+(?:model|feature|endpoint|api)|is\s?live|out\s?of\s?beta)\b/i,
  },
  {
    category: 'limits',
    pattern:
      /\b(rate\s?limits?|usage\s?limit|limiting|throttl\w*|quota|allowance|caps?\s?(?:at|of)?|concurrent\s?requests|requests?\s?per\s?(?:minute|second|day)|tokens?\s?per\s?minute|\btpm\b|\brpm\b)\b/i,
  },
  {
    category: 'billing',
    pattern:
      /\b(billing|invoice[ds]?|charge[ds]?|charges|payment|pay\s?as\s?you\s?go|pre[\s-]?paid|refund|subscription|renewal)\b/i,
  },
  // Pricing is the money fallback — evaluated last so a concrete launch/limit
  // event that merely mentions tokens/cost is not over-classified as a price
  // change. "credits" alone is not billing (e.g. student credit programs).
  {
    category: 'pricing',
    pattern:
      /\b(pric(e|ing|ed)|cost[s]?|per\s?token|per\s?1?k?\s?tokens?|per\s?million|per\s?month|per\s?year|usd|us\$|\$\s?\d|\d+(?:\.\d+)?\s?(?:usd|cents?|dollars?))\b/i,
  },
]

/**
 * Classify a single change line on its **body** text.
 *
 * Returns the first matching category in specificity order (pricing →
 * deprecation → billing → limits → launch), or null when none match. Lines that
 * carry no actionable change signal are dropped by the caller rather than
 * force-classified, which keeps precision high.
 */
export function classifyProviderChange(
  text: string,
): ProviderChangeCategory | null {
  if (!text) return null
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) return rule.category
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────
// XML helpers (shared, dependency-free)
// ─────────────────────────────────────────────────────────────────────────

/** Strip CDATA wrappers and decode the small set of XML entities we emit. */
export function unescapeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&')
}

/** Strip HTML tags so an <li> becomes plain classifiable text. */
export function htmlToText(html: string): string {
  return unescapeXml(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(?:p|li|div|h\d)>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeTag(inner: string): string {
  return htmlToText(inner)
}

function extractTag(item: string, tag: string): string {
  const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? decodeTag(m[1]) : ''
}

function parseFeedDate(raw: string): string {
  const d = new Date(raw)
  return isNaN(d.getTime()) ? '' : d.toISOString()
}

/** Return raw <item> blocks from an RSS feed. */
function extractItems(xml: string): string[] {
  return xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []
}

// ─────────────────────────────────────────────────────────────────────────
// OpenAI — Discourse announcements RSS (one item per announcement)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse the OpenAI developer-community announcements feed. Each Discourse
 * topic becomes one change; classification uses the item description (body),
 * not the title.
 */
export function parseOpenAiChanges(xml: string): ProviderChange[] {
  const changes: ProviderChange[] = []
  for (const item of extractItems(xml).slice(0, 50)) {
    const title = extractTag(item, 'title')
    const link = extractTag(item, 'link')
    const pubDate = extractTag(item, 'pubDate')
    // Prefer the body for the signal; fall back to the title so an item whose
    // description was trimmed still gets a classification chance.
    const body = extractTag(item, 'description') || title
    const category = classifyProviderChange(body)
    if (!category) continue
    changes.push({
      provider: 'openai',
      title,
      url: link,
      date: parseFeedDate(pubDate),
      category,
    })
  }
  return changes
}

// ─────────────────────────────────────────────────────────────────────────
// Anthropic — per-day item whose body lists several <li> entries
// ─────────────────────────────────────────────────────────────────────────

/**
 * Split an Anthropic per-day release-note item into its individual <li>
 * entries. A single day normally contains several bullet lines, only some of
 * which are pricing/deprecation changes — each must be classified on its own
 * text instead of classifying the whole day.
 */
export function splitAnthropicEntries(
  item: string,
): Array<{ text: string; date: string; url: string }> {
  const link = extractTag(item, 'link')
  const pubDate = extractTag(item, 'pubDate')
  const iso = parseFeedDate(pubDate)
  const body =
    item.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] ??
    item.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i)?.[1] ??
    ''
  const decoded = unescapeXml(body)
  const listItems = decoded.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) ?? []
  return listItems.map((li, i) => ({
    text: decodeTag(li),
    date: iso,
    url: link ? `${link}#L${i + 1}` : '',
  }))
}

/**
 * Parse the Anthropic release-notes feed. Each per-day item is split into its
 * <li> entries; a price line on a day that also contains non-price lines is
 * classified independently (the non-price lines are dropped when they carry no
 * actionable category).
 */
export function parseAnthropicChanges(xml: string): ProviderChange[] {
  const changes: ProviderChange[] = []
  for (const item of extractItems(xml).slice(0, 60)) {
    const dayTitle = extractTag(item, 'title')
    for (const entry of splitAnthropicEntries(item)) {
      const category = classifyProviderChange(entry.text)
      if (!category) continue
      changes.push({
        provider: 'anthropic',
        title: entry.text || dayTitle,
        url: entry.url,
        date: entry.date,
        category,
      })
    }
  }
  return changes
}

// ─────────────────────────────────────────────────────────────────────────
// Fetch + collect
// ─────────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000

/** Fetch with a single retry on transient failure / 5xx. */
export async function fetchProviderFeed(url: string): Promise<string> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'AIWatch/1.0 (ai-watch.dev; provider change monitoring)',
          Accept: 'application/rss+xml, application/xml, text/xml',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.status >= 500 && attempt === 0) {
        res.body?.cancel()
        continue
      }
      if (!res.ok) {
        res.body?.cancel()
        throw new Error(`HTTP ${res.status}`)
      }
      return await res.text()
    } catch (err) {
      lastErr = err
      if (attempt === 0) continue
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetch failed')
}

/** Default look-back window for collected changes. */
export const PROVIDER_CHANGE_LOOKBACK_MS = 7 * 86_400_000

/**
 * Collect Phase 1 provider changes (OpenAI + Anthropic) from first-party
 * sources. Failures of a single source do not abort the other. Entries older
 * than `lookbackMs` or without a parseable date are dropped.
 *
 * Returns changes newest-first. Operator Discord alerting and the X draft are
 * separate follow-up steps (#1570 Phase 1 alert wiring, Phase 2/3).
 */
export async function collectProviderChanges(options?: {
  lookbackMs?: number
  fetchImpl?: (url: string) => Promise<string>
}): Promise<ProviderChange[]> {
  const lookbackMs = options?.lookbackMs ?? PROVIDER_CHANGE_LOOKBACK_MS
  const fetchImpl = options?.fetchImpl ?? fetchProviderFeed
  const results = await Promise.allSettled(
    PROVIDER_CHANGE_SOURCES.map((src) => fetchImpl(src.feedUrl)),
  )

  const all: ProviderChange[] = []
  const cutoff = Date.now() - lookbackMs
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const src = PROVIDER_CHANGE_SOURCES[i]
    if (result.status === 'rejected') {
      console.warn(
        `[provider-changes] ${src.id} feed failed:`,
        result.reason instanceof Error ? result.reason.message : result.reason,
      )
      continue
    }
    const parsed =
      src.id === 'openai'
        ? parseOpenAiChanges(result.value)
        : parseAnthropicChanges(result.value)
    for (const change of parsed) {
      if (!change.date) continue
      const ts = new Date(change.date).getTime()
      if (isNaN(ts) || ts < cutoff) continue
      all.push(change)
    }
  }
  return all.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  )
}

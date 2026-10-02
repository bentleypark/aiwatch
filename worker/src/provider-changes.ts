// #1570 Phase 1 — provider pricing / billing / deprecation changes from first-party changelogs,
// sent to the operator Discord with an X draft. Classification reads the entry BODY: Anthropic's
// feed titles are just "release notes — <date>", and OpenAI's prices sit in the body text.

import { fetchWithRetry } from './changelog'
import { TWEET_MAX, X_INTENT_BASE, cleanForTweet } from './alerts'
import { kvPut } from './utils'

export type ChangeTag = 'pricing' | 'billing' | 'deprecation' | 'breaking' | 'limits'

export interface ProviderChange {
  provider: string
  key: string
  date: string // YYYY-MM-DD
  text: string
  url: string
}

export interface ProviderChangeSource {
  id: string
  name: string
  url: string
  parse: (body: string) => ProviderChange[]
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function changeKey(provider: string, date: string, text: string): string {
  return `${provider}:${date}:${text.slice(0, 100)}`
}

function isoDate(y: number, monthIdx: number, d: number): string {
  return `${y}-${String(monthIdx + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const OPENAI_CHANGELOG_PAGE = 'https://developers.openai.com/api/docs/changelog'

/** OpenAI API changelog markdown: `## September, 2026` → `### Sep 29` → label line → body. */
export function parseOpenAIChangelog(md: string): ProviderChange[] {
  const out: ProviderChange[] = []
  let year: number | null = null
  let date: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (date) {
      const label = buf.findIndex((l) => l.trim() !== '')
      if (label >= 0 && /^[A-Z][a-z]+(?: · .*)?$/.test(buf[label].trim())) buf.splice(label, 1)
      const text = collapse(
        buf.join('\n')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/[`*]/g, ''),
      )
      if (text) out.push({ provider: 'openai', key: changeKey('openai', date, text), date, text, url: OPENAI_CHANGELOG_PAGE })
    }
    date = null
    buf = []
  }
  for (const line of md.split('\n')) {
    const month = line.match(/^## [A-Za-z]+,? (\d{4})\s*$/)
    if (month) {
      flush()
      year = Number(month[1])
      continue
    }
    const day = line.match(/^### ([A-Za-z]{3})[a-z]* (\d{1,2})\s*$/)
    if (day) {
      flush()
      const m = MONTHS.indexOf(day[1].toLowerCase())
      if (year !== null && m >= 0) date = isoDate(year, m, Number(day[2]))
      continue
    }
    if (date) buf.push(line)
  }
  flush()
  return out
}

/** Split HTML into its top-level `<li>` bodies (a nested list stays inside its parent's text). */
export function topLevelListItems(html: string): string[] {
  const items: string[] = []
  const re = /<(\/?)li\b[^>]*>/gi
  let depth = 0
  let start = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (m[1] === '') {
      if (depth === 0) start = re.lastIndex
      depth++
    } else if (depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        items.push(html.slice(start, m.index))
        start = -1
      }
    }
  }
  return items
}

/** Claude Platform release-notes RSS: one item per day, one change per top-level `<li>`. */
export function parseAnthropicReleaseFeed(xml: string): ProviderChange[] {
  const out: ProviderChange[] = []
  for (const item of xml.match(/<item>[\s\S]*?<\/item>/gi) ?? []) {
    const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim() ?? ''
    const pub = new Date(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ?? '')
    const raw = item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? ''
    if (!link || isNaN(pub.getTime())) continue
    const date = pub.toISOString().slice(0, 10)
    const html = decodeEntities(raw.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, ''))
    for (const li of topLevelListItems(html)) {
      const text = collapse(decodeEntities(li.replace(/<\/?(?:code|a|strong|em|b|i)\b[^>]*>/gi, '').replace(/<[^>]+>/g, ' ')))
      if (text) out.push({ provider: 'anthropic', key: changeKey('anthropic', date, text), date, text, url: link })
    }
  }
  return out
}

export const PROVIDER_CHANGE_SOURCES: ProviderChangeSource[] = [
  { id: 'openai', name: 'OpenAI', url: 'https://developers.openai.com/api/docs/changelog.md', parse: parseOpenAIChangelog },
  { id: 'anthropic', name: 'Anthropic', url: 'https://platform.claude.com/docs/en/release-notes/feed.xml', parse: parseAnthropicReleaseFeed },
]

const PRICE_AMOUNT = /\$\s?\d[\d,]*(?:\.\d+)?\s*(?:USD\s*)?(?:\/\s*|per\s+)(?:1\s?M\b|M\b|MTok|million|1,000|1K|thousand|image|min(?:ute)?|sec(?:ond)?|hour|call|request|search|session)/i
const PRICE_WORD = /\b(?:priced at|pricing (?:per|is)\b)|\b(?:pric(?:e|es|ed|ing)|cost(?:s)?)\b[^.]{0,60}\b(?:cut|drop|reduc|increas|lower|higher|chang|now|standard|introductory|discount|less)/i
const BILLING = /\b(?:billing|billed)\b/i
const DEPRECATION = /\b(?:deprecat\w*|retire[ds]?|retirement|retiring|sunset\w*)\b/i
const BREAKING = /\b(?:returns? (?:an? )?(?:4\d\d )?error|can break|breaking change|no longer returns?|(?:isn't|aren't|is not|are not) supported|we've removed|now defaults? to|changes how)\b/i
const LIMITS = /\b(?:rais|increas|lower|reduc|updat|remov)\w*\b[^.]{0,60}\brate limits?\b/i

export function classifyChange(text: string): ChangeTag[] {
  const tags: ChangeTag[] = []
  if (PRICE_AMOUNT.test(text) || PRICE_WORD.test(text)) tags.push('pricing')
  if (BILLING.test(text)) tags.push('billing')
  if (DEPRECATION.test(text)) tags.push('deprecation')
  if (BREAKING.test(text)) tags.push('breaking')
  if (LIMITS.test(text)) tags.push('limits')
  return tags
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z$(`"])/).map((s) => s.trim()).filter(Boolean)
}

const EVIDENCE: Record<ChangeTag, RegExp[]> = {
  pricing: [PRICE_AMOUNT, PRICE_WORD],
  billing: [BILLING],
  deprecation: [DEPRECATION],
  breaking: [BREAKING],
  limits: [LIMITS],
}

/** The sentence a draft quotes: the first one that carries the tag's evidence, verbatim. */
export function pickSentence(text: string, tag: ChangeTag): string {
  const all = sentences(text)
  return all.find((s) => EVIDENCE[tag].some((re) => re.test(s))) ?? all[0] ?? text
}

/** Whole source sentences only, never cut: the naming first sentence + the evidence sentence, else the evidence sentence, else nothing. */
export function buildQuote(text: string, tag: ChangeTag, room: number): string {
  const clean = cleanForTweet(text)
  const picked = pickSentence(clean, tag)
  const lead = sentences(clean)[0]
  if (lead && lead !== picked && lead.length + 1 + picked.length <= room) return `${lead} ${picked}`
  return picked.length <= room ? picked : ''
}

/** X counts every URL as 23 characters (t.co), whatever its literal length. */
export function xLength(text: string): number {
  return text.replace(/https?:\/\/\S+/g, 'x'.repeat(23)).length
}

const TAG_PHRASE: Record<ChangeTag, string> = {
  pricing: 'pricing update',
  billing: 'billing change',
  deprecation: 'deprecation notice',
  breaking: 'breaking change',
  limits: 'rate limit change',
}

const LAUNCH = /^(?:We've launched|We're launching|Released|Launched|Introducing)\b|\bis now generally available\b/i
const PRICE_CHANGE = /\b(?:pric(?:e|es|ing)|costs?)\b[^.]{0,60}\b(?:cut|reduc\w*|lower|less|increas\w*|drop\w*|rais\w*)\b/i

/** A launch announcement that carries the new model's first price, with no price change to an existing model in a later sentence. */
export function isLaunchPricing(text: string): boolean {
  const [first = '', ...rest] = sentences(text)
  return LAUNCH.test(first) && !rest.some((s) => PRICE_CHANGE.test(s))
}

function tagLabel(tag: ChangeTag, text: string, form: 'phrase' | 'tag'): string {
  if (tag === 'pricing' && isLaunchPricing(text)) return 'new model pricing'
  return form === 'phrase' ? TAG_PHRASE[tag] : tag
}

const SEARCH_TERM: Record<ChangeTag, string> = {
  pricing: 'pricing',
  billing: 'pricing',
  deprecation: 'deprecation',
  breaking: 'breaking change',
  limits: 'rate limits',
}

export function buildChangeTweet(providerName: string, change: ProviderChange, tag: ChangeTag): { text: string; intentUrl: string } {
  const phrase = tagLabel(tag, change.text, 'phrase')
  const head = `${providerName} ${phrase}: `
  const tail = ` Source: ${change.url}`
  const quote = buildQuote(change.text, tag, TWEET_MAX - xLength(head + tail))
  const text = quote ? `${head}${quote}${tail}` : `${providerName} ${phrase}.${tail}`
  return { text, intentUrl: markdownSafeUrl(X_INTENT_BASE + encodeURIComponent(text)) }
}

export function buildChangeSearchUrl(providerName: string, tag: ChangeTag): string {
  const term = `${providerName} ${SEARCH_TERM[tag]}`
  return `https://x.com/search?q=${encodeURIComponent(term)}&f=top`
}

function markdownSafeUrl(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29')
}

const EXCERPT_MAX = 600

export function buildChangeEmbed(providerName: string, change: ProviderChange, tags: ChangeTag[]): { title: string; description: string; color: number } {
  const excerpt = change.text.length > EXCERPT_MAX ? `${change.text.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : change.text
  const draft = buildChangeTweet(providerName, change, tags[0])
  return {
    title: `💲 ${providerName} — ${tags.map((t) => tagLabel(t, change.text, 'tag')).join(' · ')} (${change.date})`,
    description: [
      `> ${excerpt}`,
      '',
      `[Source](${change.url}) · [✍️ Post on X](${draft.intentUrl}) · [🔍 Search X](${buildChangeSearchUrl(providerName, tags[0])})`,
      '',
      `🐦 **TWEET DRAFT**`,
      `> ${draft.text}`,
    ].join('\n'),
    color: 0xF59E0B,
  }
}

export function seenKey(providerId: string): string {
  return `provider-changes:seen:${providerId}`
}

/** An entry older than this is not alerted even when its key is new (an upstream edit re-keys it). */
export const ALERT_MAX_AGE_DAYS = 14
/** More new keys than this in one fetch means the source was re-keyed, not that this many changes shipped. */
export const BULK_REKEY_THRESHOLD = 15

export interface DetectResult {
  alerts: { providerName: string; change: ProviderChange; tags: ChangeTag[] }[]
  bulk: { providerName: string; count: number }[]
}

/** Pure diff: which entries are new since `prev`, and which of those to alert. `prev === null` = first run. */
export function detectNewChanges(
  providerName: string,
  current: ProviderChange[],
  prev: string[] | null,
  now: Date,
): DetectResult {
  if (prev === null) return { alerts: [], bulk: [] }
  const prevSet = new Set(prev)
  const fresh = current.filter((c) => !prevSet.has(c.key))
  if (fresh.length > BULK_REKEY_THRESHOLD) return { alerts: [], bulk: [{ providerName, count: fresh.length }] }
  const cutoff = now.getTime() - ALERT_MAX_AGE_DAYS * 86_400_000
  const alerts = fresh
    .filter((c) => new Date(`${c.date}T00:00:00Z`).getTime() >= cutoff)
    .map((change) => ({ providerName, change, tags: classifyChange(change.text) }))
    .filter((a) => a.tags.length > 0)
  return { alerts, bulk: [] }
}

type Embed = { title: string; description: string; color: number }

/**
 * Hourly: fetch each source, alert tagged new entries, then store the current key set minus any entry
 * whose send failed, so only that entry retries next run. A failed fetch, an empty parse or a failed
 * bulk notice stores nothing, so a broken read never reads as "every entry is new".
 */
export async function runProviderChanges(
  kv: KVNamespace,
  send: (embed: Embed) => Promise<boolean>,
  now = new Date(),
  sources = PROVIDER_CHANGE_SOURCES,
): Promise<void> {
  for (const src of sources) {
    let current: ProviderChange[]
    try {
      const res = await fetchWithRetry(src.url, { 'User-Agent': 'AIWatch/1.0 (ai-watch.dev; changelog monitoring)' })
      if (!res.ok) {
        res.body?.cancel()
        console.warn(`[provider-changes] ${src.id} returned HTTP ${res.status}`)
        continue
      }
      current = src.parse(await res.text())
    } catch (err) {
      console.warn(`[provider-changes] ${src.id} fetch failed:`, err instanceof Error ? err.message : err)
      continue
    }
    if (current.length === 0) {
      console.warn(`[provider-changes] ${src.id}: parsed 0 entries — possible format change, keeping the stored key set`)
      continue
    }

    let prev: string[] | null
    try {
      const raw = await kv.get(seenKey(src.id))
      prev = raw === null ? null : JSON.parse(raw)
      if (prev !== null && !Array.isArray(prev)) throw new Error('stored key set is not an array')
    } catch (err) {
      console.warn(`[provider-changes] ${src.id} key-set read failed, skipping this run:`, err instanceof Error ? err.message : err)
      continue
    }

    const { alerts, bulk } = detectNewChanges(src.name, current, prev, now)
    let bulkSent = true
    for (const b of bulk) {
      bulkSent = (await send({
        title: `⚠️ ${b.providerName} changelog re-keyed`,
        description: `${b.count} entries look new at once — treated as a format change, not alerted individually. Check the source by hand.`,
        color: 0x6B7280,
      })) && bulkSent
    }
    if (!bulkSent) {
      console.warn(`[provider-changes] ${src.id}: re-key notice not delivered — key set not stored, retrying next run`)
      continue
    }
    const failed = new Set<string>()
    for (const a of alerts) {
      if (!(await send(buildChangeEmbed(a.providerName, a.change, a.tags)))) failed.add(a.change.key)
    }
    if (failed.size > 0) console.warn(`[provider-changes] ${src.id}: ${failed.size} alert(s) not delivered — retrying next run`)
    const keys = current.map((c) => c.key).filter((k) => !failed.has(k))
    if (JSON.stringify(keys) !== JSON.stringify(prev)) {
      await kvPut(kv, seenKey(src.id), JSON.stringify(keys))
    }
    if (prev === null) console.log(`[provider-changes] ${src.id}: first run, stored ${keys.length} keys without alerting`)
  }
}

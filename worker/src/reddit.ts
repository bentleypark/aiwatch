// Reddit community monitoring — detect "is X down?" posts in target subreddits.
// Fetches the public `/new/.rss` Atom listing feed (#820) — the JSON `search.json` endpoint this
// used until 2026-08 is bot-walled with a HARD 403; verified 2026-08-12 from both Cloudflare egress
// and a non-Cloudflare machine, so this isn't datacenter-IP-specific. The listing feed returns real
// data instead. It is NOT immune to rate limiting, though: live
// testing against Cloudflare's own egress (2026-08-12) found only ~2 of 13 subreddits succeed per
// run, the rest 429, REGARDLESS of request spacing (tested 0ms and 3000ms between requests — same
// ~15% pass rate either way). This points at Reddit throttling the shared Cloudflare egress-IP
// pool's aggregate traffic, not our own request pattern — no amount of pacing in this file fixes
// that. So `dead` (401/403 — the endpoint itself is refusing us) and `throttled` (429 — the
// endpoint works, Reddit is just rate-limiting right now) are tracked as separate reasons; see
// `SourceDeadReason`. Coverage is real but partial and will fluctuate run to run.

import { defuseAutolinkDomain } from './alerts'
import { appendStatusHint, appendUtm } from './utils'
import { isAffectedStatus, isUnreadableStatus, type ServiceStatusValue } from './status-verdict'
import { SERVICES } from './services'
import { UPSTREAM_DEPS } from './upstream-link'

// #820 observability, still load-bearing after the endpoint swap: `fetchSubreddit` only warns to a
// log nobody reads on a failed response, and the daily summary counts `reddit:seen:*` keys, so a
// renewed block would again render identically to a quiet day. These markers keep that difference
// legible regardless of which endpoint is behind them.
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
  // #820 — the `/new/.rss` Atom feed does not carry vote counts. `undefined`, never a fabricated 0:
  // the three Discord embed builders drop the "N upvotes" clause entirely when this is absent
  // instead of printing a wrong number.
  score?: number
  url: string
  createdUtc: number
}

export type RedditAlertType = 'outage' | 'competitive' | 'security'

export interface RedditAlert {
  key: string       // KV dedup key: reddit:seen:{postId}
  subreddit: string
  post: RedditPost
  type: RedditAlertType
  /** #1315 — the gate's join keys, expanded by `promoteJoinIds` from the target's `statusId` at
   *  detection time so the call site does not re-derive them. `undefined` = gate-exempt. */
  statusIds?: readonly string[]
}

// Subreddit → scan-mode mapping (#820 round 7: no server-side search exists anymore — `service`
// only selects which client-side keyword matcher `detectRedditPosts` applies to that subreddit's
// fetched posts).
// service value semantics: '_competitive' / '_security' → those modes; anything else → outage mode.
// Exported for tests — presence/mode assertions pin the named subs in outage mode (#280). They do
// NOT read the playbook: #1182 removed the playbook's per-sub cron column (a prose mirror of this
// list), so nothing is being kept "in sync" with a doc. Note this is the CRON's scan list; the
// operator alert's link list is a separate map, REDDIT_ENGAGE_SUBS in alerts.ts.
export const REDDIT_TARGETS: ReadonlyArray<{ subreddit: string; service: string; statusId?: string }> = [
  // Service-specific subreddits (outage detection + promotion).
  //
  // `statusId` names the ONE service a subreddit is about. The #1315 promote gate does not join on
  // it directly — `promoteJoinIds` EXPANDS it (see there). An earlier cut hand-wrote the expanded
  // set on each entry; three separate narrowings of those sets shipped green under review, because
  // a hand-written membership has no rule to check it against.
  //
  // Separate from `service`, whose '_competitive' / '_security' values select the scan mode.
  // No `statusId` = exempt from the gate.
  { subreddit: 'ClaudeAI',        service: 'Claude',      statusId: 'claudeai' },
  { subreddit: 'ClaudeCode',      service: 'Claude Code', statusId: 'claudecode' },
  { subreddit: 'ChatGPT',         service: 'ChatGPT',     statusId: 'chatgpt' },
  { subreddit: 'OpenAI',          service: 'OpenAI',      statusId: 'openai' },
  { subreddit: 'cursor',          service: 'Cursor',      statusId: 'cursor' },
  { subreddit: 'windsurf',        service: 'Windsurf',    statusId: 'windsurf' },
  { subreddit: 'Codeium',         service: 'Windsurf',    statusId: 'windsurf' },
  // Broader AI communities in outage mode — playbook engagement targets (#280).
  // r/LocalLLaMA was previously competitive mode; switched to outage so API-reliability
  // threads (the playbook's actual engagement hook) are caught. r/AINews added for
  // press-adjacent outage threads. Promotion filter (isPromotable) still gates Discord
  // alerts, so news-flavored posts that aren't question-seeking won't spam.
  // No `statusIds`: these discuss the whole field, not a set of monitored services, so there is
  // nothing to join to. Exempt from the #1315 gate rather than gated on a guessed mapping.
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

/** Decode the five predefined XML entities. Atom text nodes are XML-escaped, not HTML-escaped, so
 *  this is deliberately not a general HTML-entity decoder — Reddit's `/new/.rss` titles need nothing
 *  more than this. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Parse Reddit's `/new/.rss` Atom feed into RedditPost[] (#820). `subreddit` is passed in rather
 * than read per-entry — the caller already knows it, since the feed is fetched per-subreddit.
 * `score` is left undefined (the feed does not carry it); id keeps Reddit's own `t3_…` prefix,
 * which only needs to stay unique for the `reddit:seen:*` dedup key, not match the old bare-hash
 * shape the JSON endpoint produced.
 */
export function parseRedditAtomResponse(xml: string, subreddit: string): RedditPost[] {
  // `<entry\b[^>]*>` tolerates attributes on the tag itself (e.g. `<entry xml:lang="en">`) —
  // the same attribute-order/shape hazard the <link> regex below already accounts for, applied one
  // level up. A total match failure here is worse than any single-entry drop below: `fetchSubreddit`
  // still reports `outcome: 'ok'` on a structurally-valid empty result, `decideSourceHealth` returns
  // `'clear'`, and the source-dead marker is DELETED — a quiet day with zero log trace anywhere,
  // strictly worse than the per-entry case (round 8) where at least a warning is logged. #820 round 9.
  const entries = xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/g)
  if (!entries) {
    // Only log when the raw body actually contains an `<entry` substring the regex failed to
    // consume — that's the real shape-drift signal. A genuinely empty feed (no `<entry` at all,
    // e.g. a quiet subreddit) contains no such substring and logging on it would be noise, not signal.
    if (xml.includes('<entry')) {
      console.error(`[reddit] r/${subreddit} has <entry markup but ZERO elements parsed — feed shape changed?`)
    }
    return []
  }
  const out: RedditPost[] = []
  for (const entry of entries) {
    const id = entry.match(/<id>([^<]+)<\/id>/)?.[1]
    const title = entry.match(/<title>([^<]*)<\/title>/)?.[1]
    // `[^>]*` tolerates attribute order WITHIN the <link> tag itself (e.g. `rel="alternate"` or
    // `type="text/html"` before `href`) rather than assuming href is first/only — pinned by
    // reddit.test.ts's dedicated attribute-order test. It does NOT need to (and cannot) account for
    // a preceding sibling tag like <media:thumbnail>, which real entries also carry but which is a
    // different tag entirely and can never match `<link\b`.
    const url = entry.match(/<link\b[^>]*\shref="([^"]*)"/)?.[1]
    const author = entry.match(/<name>([^<]*)<\/name>/)?.[1]
    const published = entry.match(/<published>([^<]*)<\/published>/)?.[1]
    if (!id || !title || !url) {
      // #820 round 8 — logged for the same reason the non-reddit.com link check and the unparseable
      // <published> check two blocks below both log: a silent drop here would let a feed-shape
      // change (a tag rename, a promoted-post entry with a different structure) zero out affected
      // entries with `fetchSubreddit` still reporting `outcome: 'ok'` — a parsing regression hiding
      // as a quiet day, exactly what this file's observability exists to prevent.
      console.warn(`[reddit] r/${subreddit} entry dropped (missing id/title/link):`, entry.slice(0, 150))
      continue
    }
    // A permalink must actually point at reddit.com — the old JSON parser could only ever produce
    // that (it built the URL itself from a bare permalink path); this one takes the href verbatim,
    // so a feed shape change / cache-confused proxy response could otherwise mint a `RedditPost`
    // whose url is attacker- or proxy-controlled and gets posted straight into operator Discord as
    // a clickable "View Post" link.
    if (!url.startsWith('https://www.reddit.com/r/')) {
      console.warn(`[reddit] r/${subreddit} entry ${id} had a non-reddit.com link, dropping:`, url.slice(0, 120))
      continue
    }
    const createdMs = published ? new Date(published).getTime() : NaN
    if (!Number.isFinite(createdMs)) {
      // Silently falling back to 0 would make the post vanish into the >6h age filter in
      // `detectRedditPosts` with `outcome: 'ok'` still reported — a parsing regression hiding as a
      // quiet day, the exact blind spot this whole file exists to make legible. Logs whether
      // <published> was malformed OR entirely absent — a real Atom entry always carries one, so a
      // missing tag is itself evidence of a feed-shape change (a more likely drift than a malformed
      // date), not something to pass through quietly.
      console.error(`[reddit] r/${subreddit} entry ${id} had a missing or unparseable <published>:`, published ?? '(absent)')
    }
    out.push({
      id,
      title: decodeXmlEntities(title),
      author: author ? decodeXmlEntities(author).replace(/^\/u\//, '') : '[deleted]',
      subreddit,
      url,
      createdUtc: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : 0,
    })
  }
  return out
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
  return promoteReason(title, ageSec) !== null
}

/**
 * Which promotion path a title matched, or `null` for none — the same decision `isPromotable`
 * makes, with the branch retained instead of collapsed to a boolean (#1315).
 *
 * `isPromotable` delegates here so the two can never disagree: one matcher, two views of it. The
 * branch is what the promote record stores, so a false-positive rate can be read per branch.
 */
export type PromoteReason = 'question' | 'anyone-outage' | 'seeking-help' | 'megathread'

export function promoteReason(title: string, ageSec: number = Infinity): PromoteReason | null {
  if (QUESTION_WITH_CONTEXT.test(title)) return 'question'
  if (ANYONE_WITH_OUTAGE.test(title)) return 'anyone-outage'
  if (SEEKING_HELP.test(title)) return 'seeking-help'
  if (PROMOTABLE_STRONG.test(title) && ageSec < MEGATHREAD_MAX_AGE_SEC) return 'megathread'
  return null
}

/**
 * #1315 — expand a subreddit's anchor service into the set the promote gate joins on.
 *
 * Two things widen it, and both are facts already in the codebase rather than a judgement made here:
 *
 *   1. **The other surfaces on the SAME status source.** Readers say "is Claude down?" about
 *      whichever Anthropic surface they were using, and AIWatch resolves `claude` / `claudeai` /
 *      `claudecode` independently off one `status.claude.com` — so joining r/ClaudeAI to one of them
 *      downgraded every post during a single-surface outage we were carrying under another id.
 *      Grouped by `statusUrl`, NOT by `provider`: `provider` is the corporate vendor, and Microsoft
 *      spans `azureopenai` (azure.status.microsoft) and `copilot` (githubstatus.com) — one vendor,
 *      two unrelated status sources. That pair is the only place the two groupings differ today, and
 *      neither is a `REDDIT_TARGETS` anchor, so this is the rule being right rather than a fix.
 *   2. **A declared upstream** (`UPSTREAM_DEPS`). On 2026-07-17 Anthropic opened its incident at
 *      06:47:54Z and Cursor opened its own at 07:17:15Z — the two times `upstream-link.ts` records.
 *      A dependent that files 29 minutes late reads healthy for those 29 minutes.
 *
 * Derived rather than hand-listed because the hand-listed version was wrong three times and nothing
 * could tell: a set written by hand has no rule to check it against, so a narrowing ships green and
 * fails toward silence. An upstream that is not a monitored service (`github-platform`, a feed under
 * #1072) is dropped — there is no status to read for it.
 *
 * The one call site (`detectRedditPosts`) is the remaining hand-written expression, so it is covered
 * behaviourally there — deriving correctly and never being called is the same bug as not deriving.
 */
export function promoteJoinIds(statusId: string | undefined): readonly string[] | undefined {
  if (!statusId) return undefined
  const anchor = SERVICES.find(s => s.id === statusId)
  if (!anchor) return [statusId]
  const ids = new Set(SERVICES.filter(s => s.statusUrl === anchor.statusUrl).map(s => s.id))
  for (const id of [...ids]) {
    for (const up of UPSTREAM_DEPS.find(d => d.id === id)?.upstreamIds ?? []) {
      if (SERVICES.some(s => s.id === up)) ids.add(up)
    }
  }
  return [...ids]
}

/**
 * #1315 — what the gate is allowed to know about one service this cycle.
 *
 * The bare `ServiceStatus.status` is NOT enough, and assuming it was made the first cut of this gate
 * fail CLOSED. `services.ts` publishes `status: 'operational'` for a source it could not read, on two
 * different paths: a failed read sets `sourceUnknown` and keeps `operational` until
 * `trackFetchFailure` ramps to `unknown`, and a 4xx source sets `sourceDead` with no ramp at all. So
 * "operational" means either "we read it and it is up" or "we did not read it", and only the flags
 * separate them.
 *
 * That distinction is load-bearing here in a way it is not for a badge: a status page tends to fall
 * over exactly when the service behind it is in trouble, which is also when Reddit fills with "is X
 * down?" — so reading our own failed fetch as green would silence the gate precisely when it matters.
 */
export interface PromoteJoinReading {
  status: ServiceStatusValue
  /** False when this cycle did not actually read the source (`sourceUnknown` or `sourceDead`). */
  sourceRead: boolean
}

/** Build the gate's view of one service. Kept next to the gate so the two cannot drift. */
export function promoteJoinReading(
  svc: { status: ServiceStatusValue; sourceUnknown?: boolean; sourceDead?: boolean },
): PromoteJoinReading {
  return { status: svc.status, sourceRead: !svc.sourceUnknown && !svc.sourceDead }
}

/**
 * #1315 — may we promote a post from this subreddit right now?
 *
 * Joins on AIWatch's own status instead of tightening the title regex: `PROMOTABLE_STRONG` matches a
 * bare `\bdown\b`, which is also the English verb particle ("slowing down", "scroll down"), and
 * narrowing it only moves the leak to the next particle verb.
 *
 * **The gate never suppresses an alert — it downgrades the label.** An earlier cut withheld the
 * Discord message entirely on `downgrade-healthy` and re-decided the post on later runs. That cost
 * more than it saved: `promoteReason`'s `megathread` branch stops matching at 2h while the cron runs
 * hourly, so a declarative "X is down for everyone" held once was gone — and our polling is
 * structurally later than a provider's own page, so the posts most likely to be held early are real
 * outage megathreads, the exact thing this channel exists to catch. Measured throughput was ~1 alert
 * per run across all 9 subreddits, so suppression was buying almost nothing for that risk.
 *
 * This is not a new tier: #296 scoped a *"Tier-2 MONITOR alert type below PROMOTE"* and deferred it
 * *"until we see whether the relaxed filters over-fire"*. They did — 2026-09-01 promoted a Sam Altman
 * interview off a bare `down`. The deferral condition is what has changed, not the design.
 *
 * Two properties carry the rest:
 *   - ANY affected member promotes. A subreddit spans several services (see `REDDIT_TARGETS`), so
 *     requiring all of them to be affected would downgrade during a real single-surface outage.
 *   - `downgrade-healthy` requires a POSITIVE reading of healthy on EVERY member. An unknown id, a
 *     service missing from the map, an `unknown` verdict (#1233), an unread source, or an empty map
 *     all promote — a gate that reacts to a broken status read by quietly relabelling is still wrong.
 */
export type PromoteGateVerdict = 'allow' | 'allow-exempt' | 'allow-unreadable' | 'downgrade-healthy'

export function promoteStatusGate(
  statusIds: readonly string[] | undefined,
  statusById: ReadonlyMap<string, PromoteJoinReading>,
): PromoteGateVerdict {
  if (!statusIds || statusIds.length === 0) return 'allow-exempt'

  let sawUnreadable = false
  for (const id of statusIds) {
    const reading = statusById.get(id)
    if (reading === undefined || !reading.sourceRead || isUnreadableStatus(reading.status)) {
      sawUnreadable = true
      continue
    }
    if (isAffectedStatus(reading.status)) return 'allow'
  }
  return sawUnreadable ? 'allow-unreadable' : 'downgrade-healthy'
}

/** True when the verdict earns the 🎯 PROMOTE label — the one place `downgrade-healthy` is special.
 *  A false answer costs a label, never a message.
 *  An exhaustive switch, not `!== 'downgrade-healthy'`: #1233 measured that widening a status union
 *  produces zero type errors, so a future `downgrade-*` member added to a negative test would silently
 *  promote. The `never` binding fails `typecheck:worker` instead; the runtime default stays
 *  fail-open to match this module's safety property. */
export function gatePromotes(verdict: PromoteGateVerdict): boolean {
  switch (verdict) {
    case 'allow':
    case 'allow-exempt':
    case 'allow-unreadable':
      return true
    case 'downgrade-healthy':
      return false
    default: {
      const exhaustive: never = verdict
      void exhaustive
      return true
    }
  }
}

/**
 * #1315 — a durable record of each promote decision, so the gate's precision can be measured rather
 * than argued from anecdotes. Downgrades are recorded alongside promotes; that pair IS the precision
 * measurement, read per `reason` branch.
 *
 * One key per post. A post is deduped by `reddit:seen` for 24h and age-filtered out at 6h, so on the
 * normal path each post is decided once and a prefix list reads as one row per post.
 *
 * Independent keys rather than one array under a month key: an array needs read-modify-write, and a
 * failed read that still writes destroys the window (#1256).
 */
export const PROMOTE_RECORD_PREFIX = 'reddit:promote:rec:'
/** 90 days — long enough for a monthly review, bounded so the prefix stays listable. */
export const PROMOTE_RECORD_TTL_SEC = 7776000

export interface PromoteRecord {
  postId: string
  subreddit: string
  title: string
  /** Which `promoteReason` branch matched — lets a per-branch false-positive rate be read. */
  reason: PromoteReason
  /** The join keys, or null for a gate-exempt subreddit. */
  statusIds: string[] | null
  /** Each joined service's reading AT DECISION TIME, which cannot be reconstructed later. The whole
   *  field is `null` for a gate-exempt subreddit; within it, an id we held no reading for maps to
   *  `null` — kept as a key rather than dropped, so the join is legible after the fact. */
  statusAtDecision: Record<string, PromoteJoinReading | null> | null
  verdict: PromoteGateVerdict
  /** Whether the Discord send SUCCEEDED. Not "was selected": #1202 round 7 caught the same field
   *  meaning intent on `reddit:promote:last`, and this record exists to measure precision, so a
   *  numerator that counts undelivered sends corrupts the one number it produces. */
  sent: boolean
  ageSec: number
  at: string
}

export function buildPromoteRecord(input: {
  postId: string
  subreddit: string
  title: string
  reason: PromoteReason
  statusIds?: readonly string[]
  statusById: ReadonlyMap<string, PromoteJoinReading>
  verdict: PromoteGateVerdict
  sent: boolean
  ageSec: number
  now?: Date
}): { key: string; value: PromoteRecord } {
  const readings = input.statusIds
    ? Object.fromEntries(input.statusIds.map(id => [id, input.statusById.get(id) ?? null]))
    : null
  return {
    key: `${PROMOTE_RECORD_PREFIX}${input.postId}`,
    value: {
      postId: input.postId,
      subreddit: input.subreddit,
      title: input.title,
      reason: input.reason,
      statusIds: input.statusIds ? [...input.statusIds] : null,
      statusAtDecision: readings,
      verdict: input.verdict,
      sent: input.sent,
      ageSec: Math.round(input.ageSec),
      at: (input.now ?? new Date()).toISOString(),
    },
  }
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

// A status that means the ENDPOINT itself is refusing us (an actual block, not a rate limit) —
// 401 (auth) or 403 (IP/UA block, what `search.json` returns). Distinct from `isThrottledStatus`
// (429): the remediation differs (a real block needs a code/endpoint change; a rate limit doesn't).
export function isDeadStatus(status: number): boolean {
  return status === 401 || status === 403
}

// 429 specifically — the endpoint is alive and responding, Reddit is just rate-limiting this
// request right now. See the file header for why pacing our own requests doesn't reliably avoid
// this (empirically tied to shared Cloudflare egress-IP traffic, not our request pattern).
export function isThrottledStatus(status: number): boolean {
  return status === 429
}

/**
 * A subreddit fetch resolves to one of FOUR states. Folding "no response at all" into "no posts"
 * is the #820 root cause — it makes a total block indistinguishable from a quiet day.
 *   ok        — a 2xx came back (proof the source is alive), whatever the post count
 *   dead      — 401/403: the ENDPOINT is refusing us, a real block
 *   throttled — 429: Reddit rate-limiting, not a block — usually self-heals next run
 *   transient — no response (network throw/timeout) or a non-auth error (5xx): proves nothing
 */
export type FetchOutcome = 'ok' | 'dead' | 'throttled' | 'transient'

export interface FetchResult {
  posts: RedditPost[]
  outcome: FetchOutcome
}

/**
 * Fetch the 25 newest posts from a subreddit (#820). No server-side search/query — the listing
 * feed doesn't support one, so keyword matching moves entirely to the caller (`detectRedditPosts`,
 * unchanged: `matchesKeywords` et al. read the title only). At the current HOURLY cron cadence
 * (`worker/src/index.ts` gates this to minute<5 of each hour) 25 posts is real headroom against a
 * subreddit's normal per-hour volume (~6/hour, measured live on r/ChatGPT 2026-08-12) — but not an unconditional
 * "more coverage than before" claim: a subreddit posting >25 items within the hour, which is
 * plausible during exactly the kind of high-volume outage this feature exists to catch, could still
 * drop one. Fetches run in parallel (`Promise.allSettled` below) — serializing them was tested and
 * did not change the pass rate (see file header), so parallel is kept for lower total latency.
 */
async function fetchSubreddit(subreddit: string): Promise<FetchResult> {
  const url = `https://www.reddit.com/r/${subreddit}/new/.rss?limit=25`

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
    const outcome = isThrottledStatus(res.status) ? 'throttled' : isDeadStatus(res.status) ? 'dead' : 'transient'
    return { posts: [], outcome }
  }

  // Only a STRUCTURALLY VALID feed counts as proof of life. A bot wall is commonly served as 200
  // with an HTML interstitial, not 403 — `old.reddit.com` was observed doing exactly that on
  // 2026-07-28. Treating an unparseable 200 as `ok` would let the sneakier form of this very block
  // CLEAR a correct marker and print a quiet day: worse than not having the marker at all.
  const text = await res.text().catch(() => null)
  if (text === null) {
    console.error(`[reddit] r/${subreddit} 200 but the body could not be read`)
    return { posts: [], outcome: 'transient' }
  }
  if (!isRedditAtomFeed(text)) {
    console.error(`[reddit] r/${subreddit} 200 with an unexpected body (bot wall?): ${text.slice(0, 120)}`)
    return { posts: [], outcome: 'transient' }
  }
  return { posts: parseRedditAtomResponse(text, subreddit), outcome: 'ok' }
}

/** A body is proof of life only if it is a structurally valid Atom feed — the same "only a
 *  structurally valid response counts as ok" discipline the old JSON-endpoint parser applied. */
export function isRedditAtomFeed(text: string): boolean {
  return /<feed[\s>]/.test(text) && /<\/feed>/.test(text) && !/<html[\s>]/i.test(text)
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

/** Why the source was marked: a block observed THIS run, a streak of unreachable runs, a partial
 *  block (some targets answered, some were blocked), or a rate-limit (some/all targets 429'd, but
 *  the endpoint itself isn't refusing us). The distinction survives to the operator because the
 *  remediations differ — `throttled` in particular usually needs no action at all. */
export type SourceDeadReason = 'block' | 'streak' | 'partial' | 'throttled'

export interface RedditSourceDead { reason: SourceDeadReason; at: number }

const SOURCE_DEAD_REASONS: readonly string[] = ['block', 'partial', 'streak', 'throttled']

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
    // through the summary's ternary to the assertive "the listing feed returned a block status"
    // sentence — a confident, wrong diagnosis. Anything unknown must take the honest 'unknown' path
    // instead.
    if (SOURCE_DEAD_REASONS.includes(parsed?.reason) && typeof parsed?.at === 'number') return parsed
  } catch { /* fall through to the shape warning */ }
  // A marker written every hour and silently ignored forever is the same blind spot; say so.
  console.error(`[reddit] source-dead marker is malformed, treating health as unknown: ${raw.slice(0, 120)}`)
  return 'unknown'
}

/**
 * Fold per-subreddit outcomes into the source-health marker. Pure decision, exported for tests:
 *   • any OK + any DEAD → 'partial': a genuine block coexists with real successes — actionable,
 *     since a private/banned subreddit alongside real successes would be per-subreddit noise, but
 *     `dead` here means 401/403, not 429, so this is never just rate-limiting.
 *   • any OK + any THROTTLED (no DEAD) → 'throttled': the source is alive AND we have real evidence
 *     of it (at least one ok this run) — safe to mark immediately with the quiet tone.
 *   • any OK, nothing else → 'clear'.
 *   • zero OK, any DEAD → 'mark': with zero evidence of life, "one odd subreddit" is not an
 *     available reading — the streak resets because this is a definite signal, not a suspicion.
 *   • zero OK, zero DEAD, any THROTTLED → 'bump', NOT an immediate 'throttled' marker (#820 round
 *     2 fix). A total 429 blackout has EXACTLY the same zero-evidence-of-life shape as all-transient
 *     — the two are indistinguishable from this run alone, and Reddit's shared-egress throttling
 *     was measured at ~85% (file header), so this is not a rare edge case, it is close to the
 *     modal outcome. Marking it 'throttled' immediately every run would apply the quiet 🐢 tone to
 *     what could be a genuine sustained detection outage, resetting the transient streak on every
 *     occurrence so the escalation path could never fire — reintroducing the exact "a real problem
 *     renders identically to a quiet day" blind spot this whole file exists to prevent, one layer
 *     down. Folding it into 'bump' means it goes through the SAME streak-based escalation transient
 *     outcomes do: silent for a blip, an alarm only once sustained, as plain 'streak' (round 3: an
 *     earlier version tried to distinguish the escalated reason as throttle- vs transient-flavored
 *     based on which run tipped the streak, but that broke `markRedditSourceDead`'s `at`-preservation
 *     -- a streak whose flavor flips between runs would re-stamp `at` to "now" on every flip,
 *     understating a genuinely long-running outage's duration. One terminal reason keeps that
 *     timestamp correct; `streak`'s message stays honest about the throttling possibility without a
 *     second reason value to flip between).
 *   • all transient (no throttled either) → 'bump': this run learned nothing, so do not fabricate a
 *     marker off one blip and do NOT wipe an existing one. Escalate only once the streak crosses
 *     the limit.
 */
export function decideSourceHealth(outcomes: FetchOutcome[]): 'clear' | 'partial' | 'mark' | 'bump' | 'throttled' {
  const ok = outcomes.filter((o) => o === 'ok').length
  const dead = outcomes.filter((o) => o === 'dead').length
  const throttled = outcomes.filter((o) => o === 'throttled').length
  if (ok > 0 && dead > 0) return 'partial'
  if (ok > 0 && throttled > 0) return 'throttled'
  if (ok > 0) return 'clear'
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
      const { posts, outcome } = await fetchSubreddit(target.subreddit)
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
      // #820 round 7 — this is NOT a double-check against an upstream search anymore: `/new/.rss`
      // does no filtering at all, so this keyword match is the ONLY filter over every post in the
      // fetched subreddit. Removing it would let every post in every scanned subreddit through.
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

      alerts.push({ key, subreddit: target.subreddit, post, type: mode, statusIds: promoteJoinIds(target.statusId) })
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
    case 'throttled':
      await markRedditSourceDead(kv, 'throttled')
      await resetTransientStreak(kv)  // we DID hear from the source (429 is a real response)
      break
    case 'bump': {
      // #820 round 2/3 — zero-ok all-transient and zero-ok all-throttled fold into the same 'bump'
      // path (see decideSourceHealth) and escalate to the SAME 'streak' reason. An earlier version
      // tried to pick a throttle-vs-transient-flavored reason here based on which run tipped the
      // streak, but a streak whose flavor flips between runs kept re-stamping `at` to "now" via
      // markRedditSourceDead's reason-changed-is-a-new-event rule — understating a genuinely
      // long-running outage's duration. One terminal reason avoids that; see 'streak''s message in
      // daily-summary.ts for how it stays honest about the throttling possibility without a second
      // reason value to flip between.
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
 *
 * #1315 — `verdict` decides the LABEL, not whether this is sent. `downgrade-healthy` means the
 * title matched but every service the subreddit covers reads healthy right now, so the operator gets
 * the post with our reading attached instead of a call to go reply. Omitted verdict = promote, which
 * keeps the pre-#1315 contract for any caller that has no status to join on.
 */
export function formatRedditAlert(alert: RedditAlert, verdict?: PromoteGateVerdict): { title: string; description: string; color: number; url: string } {
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
  // #820 — the `/new/.rss` feed carries no vote count. Drop the clause rather than print "0
  // upvotes", which would read as a real (and wrong) measurement.
  const scoreClause = alert.post.score != null ? ` · ${alert.post.score} upvotes` : ''

  // The downgraded variant states WHY, naming the services checked — an operator who can see that we
  // read all three Anthropic surfaces as operational can overrule it; a bare missing label cannot be
  // argued with. The share link is dropped: it is the "go reply with our status" affordance, and
  // there is no outage to point at.
  const downgraded = verdict === 'downgrade-healthy'
  const checked = alert.statusIds?.length ? ` (${alert.statusIds.join(', ')})` : ''

  return {
    title: `📢 Reddit: r/${alert.subreddit} ${downgraded ? '[monitor]' : '[🎯 PROMOTE]'}`,
    description: `"${defuseAutolinkDomain(alert.post.title)}"\nby u/${alert.post.author}${scoreClause} · ${agoText}`
      + (downgraded ? `\n🟢 our status reads operational${checked} — no outage to point at` : shareLink),
    color: downgraded ? 0x8b949e : 0x3fb950, // grey when downgraded, green when promotable
    url: alert.post.url,
  }
}

export function formatCompetitiveAlert(alert: RedditAlert): { title: string; description: string; color: number; url: string } {
  const ago = Math.floor(Date.now() / 1000 - alert.post.createdUtc)
  const agoText = ago < 60 ? 'just now'
    : ago < 3600 ? `${Math.floor(ago / 60)}m ago`
    : `${Math.floor(ago / 3600)}h ago`

  const scoreClause = alert.post.score != null ? ` · ${alert.post.score} upvotes` : ''
  return {
    title: `🔍 Competitive: r/${alert.subreddit}`,
    description: `"${alert.post.title}"\nby u/${alert.post.author}${scoreClause} · ${agoText}`,
    color: 0x8b949e, // gray
    url: alert.post.url,
  }
}

export function formatSecurityAlert(alert: RedditAlert): { title: string; description: string; color: number; url: string } {
  const ago = Math.floor(Date.now() / 1000 - alert.post.createdUtc)
  const agoText = ago < 60 ? 'just now'
    : ago < 3600 ? `${Math.floor(ago / 60)}m ago`
    : `${Math.floor(ago / 3600)}h ago`

  const scoreClause = alert.post.score != null ? ` · ${alert.post.score} upvotes` : ''
  return {
    title: `🔒 Security: r/${alert.subreddit}`,
    description: `"${alert.post.title}"\nby u/${alert.post.author}${scoreClause} · ${agoText}`,
    color: 0xf85149, // red — security alerts are high-priority
    url: alert.post.url,
  }
}

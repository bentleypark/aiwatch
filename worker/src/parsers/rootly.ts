// #1381 — Rootly status pages (status.mistral.ai since the Instatus migration).
//
// The Worker cannot read this source at all: the page sits behind a Cloudflare MANAGED CHALLENGE,
// which a plain `fetch()` never clears and — unlike DeepSeek's TLS-fingerprint wall (#618) — a
// HEADLESS browser does not clear either. Only a headed browser does (measured: bundled Chromium,
// full-Chromium new-headless and real-Chrome-channel headless are all 403; headed is 200. Confirmed
// from a GitHub runner under xvfb, run 34421800205). So a scheduled Action browses the page and POSTs
// what it read; this module owns every INTERPRETATION of that payload, so the fragile parts are pure
// functions a test can pin rather than DOM code running in a browser nobody can assert on.
//
// The scraper sends timestamps VERBATIM. It has to: the page carries no machine-readable time
// anywhere — no `<time>` element, no ISO string, no data attribute, on either the history list or an
// incident page (verified 2026-09-10). The only form published is English prose, "September 4, 2026
// at 10:00 PM UTC". Parsing that is a hand-written parser over source text, which is exactly the
// shape #1224 warns decays; the mitigation is that a failure here is COUNTED and surfaced
// (`unparsedTimestamps`) instead of silently yielding an incident with no start.
//
// The history LIST omits the year ("September 4 at 10:00 PM UTC") — only the incident PAGE carries
// it. That is why normalization consumes incident pages rather than list rows: a year inferred from
// a month header is a second hand-written parser, and it would be wrong for exactly one week a year.
import type { Incident, TimelineEntry } from '../types'
import { formatDuration } from '../utils'
import { MAJOR_WEIGHT, MINOR_WEIGHT } from './impact-weights'

/** One incident as the scraper read it — every field verbatim, no interpretation. */
export interface RootlyFeedIncident {
  /** UUID from the incident page URL (`/incidents/<uuid>`); stable, and our dedup key. */
  id: string
  title: string
  /** Update entries, newest first as the page renders them. */
  updates: Array<{
    /** "Resolved" | "Identified" | "Investigating" | "Monitoring", as rendered. */
    status: string
    /** "September 5, 2026 at 05:48 AM UTC", as rendered. */
    at: string
    body: string
  }>
}

export interface RootlyFeed {
  /** ISO instant the scrape ran. */
  fetchedAt: string
  components: Array<{ id: string; name: string; status: string }>
  incidents: RootlyFeedIncident[]
  /**
   * `listed` is how many incidents the scraper set out to read (AFTER its cap), `fetched` how many
   * it managed to. They are separate numbers because they diverge in practice — a run that read 40
   * of 50 is NOT a quieter month, and nothing downstream can tell that from the incident array
   * alone.
   *
   * `available` is what the history page OFFERED, before the cap. It is a third number rather than a
   * redefinition of `listed` because the two answer different questions, and collapsing them into
   * one field is what made this wrong in both directions across two review rounds: post-cap, a
   * truncated run reports `fetched === listed` and looks complete; pre-cap, `fetched < listed`
   * holds on every healthy run (the page carries ~154 incidents and the cap is 80 BY DESIGN — a
   * 30-day window needs ~72), so the diagnostic that reads it fires always and means nothing.
   * Optional: a feed written before this was added simply cannot answer the truncation question.
   */
  coverage: { listed: number; fetched: number; available?: number }
  /**
   * The uptime chart, per component. Present from the same scrape as the incidents, because the
   * severity an incident needs is only here — the titles carry none. Optional only for feeds written
   * before it was added; `isStorableRootlyFeed` refuses a feed without it, because a feed that cannot
   * produce a figure scores HIGHER than one that produces a bad figure (see the gate).
   */
  uptime?: RootlyUptimeComponent[]
}

export interface StoredRootlyFeed {
  fetchedAt: string
  feed: RootlyFeed
}

export const MISTRAL_FEED_KV_KEY = 'mistral:feed'
/** The only freshness rule on this feed: nothing on the read path inspects `fetchedAt`. */
export const MISTRAL_FEED_TTL_S = 3 * 60 * 60

/**
 * The oldest day inside the trailing window, as `YYYY-MM-DD`.
 *
 * Exported so `computeRootlyUptime` and `attachRootlyImpact` cannot disagree about where the window
 * ends. They must agree: the attribution counter's whole meaning is "an incident on a day the uptime
 * read COVERS that we still could not match", and a counter using a different edge than the reader
 * it describes counts days that were never in scope.
 */
export function rootlyWindowCutoffDay(nowMs: number, windowDays = 30): string {
  return new Date(nowMs - (windowDays - 1) * 86400000).toISOString().slice(0, 10)
}

/**
 * Did the scraper's incident cap cost us any of the 30-day window?
 *
 * NOT the same question as "did the cap bite". The cap bites on every run by design: the history
 * page carries a long tail (~154 incidents over ~64 days, measured 2026-09-10) and `MAX_INCIDENTS`
 * is 80, of which a 30-day window needs ~72. What matters is whether the OLDEST incident we
 * actually read still reaches back past the window edge. If it does, everything inside the window
 * is in hand and the untouched tail is irrelevant; if it does not, the cap ate real days and the
 * incident count is silently low — the shape that reads downstream as a quiet month.
 *
 * Decided here rather than in the scraper because the scraper holds timestamps only as the page's
 * English prose, and `parseRootlyTimestamp` is the one thing allowed to interpret those. A second
 * copy over there is the drift this module exists to prevent.
 *
 * Returns false when the feed cannot answer (no `available`, or no readable incident) — an
 * unanswerable question is not evidence of truncation.
 */
export function rootlyWindowTruncated(
  coverage: RootlyFeed['coverage'],
  incidents: Incident[],
  nowMs: number,
  windowDays = 30,
): boolean {
  const { available, listed } = coverage
  if (available === undefined || available <= listed) return false
  const oldest = incidents.reduce<number | null>((min, inc) => {
    const t = Date.parse(inc.startedAt)
    return Number.isNaN(t) ? min : (min == null || t < min ? t : min)
  }, null)
  if (oldest == null) return false
  return oldest > nowMs - (windowDays - 1) * 86400000
}

/**
 * Is this body safe to STORE over whatever is already cached?
 *
 * Deliberately a rejection test rather than a shape coercion. The value being overwritten is the
 * only copy — a push that parses but means nothing ("scraper ran, read nothing") would replace a
 * good feed with an authoritative-looking blank, which is the failure #1256 recorded: what destroyed
 * the record there were the values that PARSED successfully. So a scrape that listed incidents and
 * retrieved none is refused; a genuinely quiet window (listed 0) is accepted, because that is a real
 * reading rather than a failed one.
 */
export function isStorableRootlyFeed(
  body: unknown,
  scopeIds: string[] | undefined,
  nowMs: number,
): body is RootlyFeed {
  if (!body || typeof body !== 'object') return false
  const f = body as Partial<RootlyFeed>
  if (!Array.isArray(f.incidents)) return false
  if (!Array.isArray(f.components)) return false
  if (!f.coverage || typeof f.coverage !== 'object') return false
  const { listed, fetched } = f.coverage as RootlyFeed['coverage']
  if (!Number.isFinite(listed) || !Number.isFinite(fetched)) return false
  if (listed < 0 || fetched < 0 || fetched > listed) return false
  // The scraper saw incidents and could not read a single one — a broken run, not a quiet page.
  if (listed > 0 && fetched === 0) return false
  const { available } = f.coverage as RootlyFeed['coverage']
  // Optional, but not free-form: `available` is the page's pre-cap count, so a value below `listed`
  // is incoherent and the truncation reading built on it would be backwards.
  if (available !== undefined && (!Number.isFinite(available) || available < listed)) return false
  // Not ONE incident carried a provider title. The provider does publish untitled incidents (#1471),
  // so one is not evidence of a broken read. This is the fail-closed path the scraper's old
  // `!detail.title` guard provided before it had to allow a genuinely empty title through.
  if (f.incidents.length > 0 && f.incidents.every((i) => !(i?.title ?? '').trim())) return false

  // Components are read from the main page, which is the one request that must have succeeded for
  // anything else to have been attempted. An empty list means the page did not render for us.
  if (f.components.length === 0) return false
  // ...and neither did a list of placeholders. The scraper emits `{name: null, status: null}` when
  // its status regex misses, which is the "ran, read nothing" shape this gate exists to refuse — it
  // parses, and downstream it becomes `unknown` for the KV TTL, over a good feed.
  //
  // Judged against the SCOPE when the caller supplies one, because "any one component read" and
  // "the badge can be derived" are different tests and only the second matches what happens next:
  // `rootlyOverallStatus` returns `unknown` if ANY scoped id is missing or unreadable. A scrape that
  // read 1 of 13 passes an any-one test, overwrites the only cached copy, and then publishes
  // `unknown` with no incidents for the full 3h TTL — which is verbatim the failure the paragraph
  // above says this gate exists to refuse. Scope-less callers keep the any-one test; there is no
  // badge to reason about without one.
  const readable = (id?: string) => f.components!.some(
    (c) => c && (id === undefined || c.id === id)
           && typeof c.name === 'string' && c.name.trim() !== ''
           && mapRootlyComponentStatus(c.status) != null)
  if (scopeIds?.length ? !scopeIds.every(readable) : !readable()) return false

  // And the uptime must be COMPUTABLE. This is the same #1256 argument one level further in: a feed
  // whose tooltips came back short parses fine and looks authoritative, and storing it over a good
  // one does not merely lose a figure — it publishes a HIGHER score than the figure it replaced.
  // `computeRootlyUptime` withholds `uptime30d` on any gap (every gap on this source fails toward
  // "no downtime"), and `score.ts` then drops the 40-point Uptime component and rescales the other
  // three to 100 — which #1186 records as algebraically identical to imputing uptime at
  // 0.667×(I+R+P). Measured on this service: a real 96.36% earns 10.88/40 and scores 55, while
  // withholding scores 74. So a lost tooltip would RAISE Mistral's published score by ~19 points
  // and carry it into the ranking.
  //
  // Refusing the push instead leaves the previous good feed in KV, so the last computable figure
  // keeps serving — and the scraper exits non-zero on the rejection, so the Action fails and GitHub
  // says so. If nothing clean lands before the 3h TTL, the key expires and the caller publishes
  // `unknown`, the honest reading of "no complete scrape in three hours".
  //
  // Two costs, both accepted. An uptime-only failure also holds back the components and incidents in
  // the same push — the one observed cause is rate limiting, which is uncorrelated with whether
  // Mistral is actually down. And "until a clean scrape lands" is optimistic for the causes that are
  // NOT transient: an unrecognized segment class, a chart dropped for a missing `since`, or a
  // `barCount: 0` component all reproduce on every cycle, so those refuse permanently and the
  // service sits at `unknown` until someone ships a change. That is the same property
  // `normalizeRootlyIncidents` records about itself, and it is the correct direction here too — but
  // it means a refusal that persists past a few hours is a code signal, not a retry signal.
  //
  // Asked through `computeRootlyUptime` itself rather than by re-deriving "complete" here, so the
  // gate and the reader can never disagree about what a complete read is.
  // Shape-check the uptime entries before interpreting them. Every field here is one the reader
  // dereferences, so a producer that drops or renames one must be refused rather than defaulted —
  // `comp.unreadBars ?? 0` and `comp.coverage.fetched < comp.coverage.impacted` both read a missing
  // value as "nothing wrong", which is how a blind chart published a fabricated 100%.
  //
  // Deliberately NOT a test that parses this file's interface text to compare field names against
  // the scraper's output. That guard existed for one round and missed a nested rename, a member
  // modifier, an added sibling interface and every type change — the shape a hand-written parser of
  // an unbounded input always takes. The contract belongs at the boundary that consumes it.
  if (!Array.isArray(f.uptime)) return false
  for (const c of f.uptime) {
    if (!c || typeof c !== 'object') return false
    if (typeof c.componentId !== 'string' || c.componentId === '') return false
    if (!Number.isFinite(c.barCount) || !Number.isFinite(c.unreadBars) || c.unreadBars < 0) return false
    if (!c.coverage || typeof c.coverage !== 'object') return false
    if (!Number.isFinite(c.coverage.impacted) || !Number.isFinite(c.coverage.fetched)) return false
    if (c.coverage.impacted < 0 || c.coverage.fetched < 0) return false
    if (!Array.isArray(c.days)) return false
    // Deliberately NOT a per-field check of each day. One lived here for a round and was deleted:
    // it re-derived, field by field, what the reader would do with each one, so closing `segments`
    // left `label` open — and closing `label` the same way would have left the next reader-side
    // default open. Four review rounds landed on that loop.
    //
    // A day is judged by the function that READS it instead: `rootlyDayReading` returns
    // `fraction: null` for anything it cannot weigh, `computeRootlyUptime` counts that as an
    // unreadable day, and `pct` goes null — which the return below already refuses on. One place
    // decides what a readable day is, and it is the place that uses the answer.
  }
  return computeRootlyUptime(f.uptime, scopeIds, nowMs).pct != null
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
}

/**
 * Full names AND their three-letter forms — ONE month vocabulary for both parsers.
 *
 * The incident pages render "September" and the chart tooltips render "Sep", and an earlier cut gave
 * each parser its own table. That is two hand-written parsers over one page which are free to
 * disagree, and they did: the scraper forwards any `[A-Z][a-z]+ D, YYYY at …`, so the day Rootly
 * unifies its two surfaces on the short form, every incident would forward and then be DROPPED here
 * while `coverage` still read complete.
 */
const MONTH_LOOKUP: Record<string, number> = (() => {
  const out: Record<string, number> = {}
  for (const [name, idx] of Object.entries(MONTHS)) {
    out[name] = idx
    out[name.slice(0, 3)] = idx
  }
  return out
})()

/**
 * "September 4, 2026 at 10:00 PM UTC" → epoch ms. Returns null on ANY deviation.
 *
 * Deliberately strict — a lenient parser here is worse than none. A half-understood string yields a
 * plausible-looking wrong instant, and this value feeds `startedAt`/`duration`, the Score's MTTR and
 * the monthly archive. Returning null lets the caller count the failure and keep the incident out of
 * the numbers, which is the honest reading of "we could not tell when this happened".
 *
 * Only UTC is accepted for the same reason: the page renders UTC today, and silently treating an
 * unrecognized zone as UTC would shift every timestamp by hours with no signal.
 */
export function parseRootlyTimestamp(text: string): number | null {
  if (typeof text !== 'string') return null
  const m = /^\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s+UTC\s*$/.exec(text)
  if (!m) return null
  const month = MONTH_LOOKUP[m[1].toLowerCase()]
  if (month === undefined) return null
  const day = Number(m[2])
  const year = Number(m[3])
  let hour = Number(m[4])
  const minute = Number(m[5])
  if (day < 1 || day > 31 || hour < 1 || hour > 12 || minute > 59) return null
  if (m[6] === 'PM' && hour !== 12) hour += 12
  if (m[6] === 'AM' && hour === 12) hour = 0
  const ms = Date.UTC(year, month, day, hour, minute)
  // Rejects an overflowing day (Feb 30 → Mar 2) rather than accepting the rolled-over instant.
  const d = new Date(ms)
  if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return null
  return ms
}

/**
 * A component's RENDERED status word → our three-state.
 *
 * Returns null on anything unrecognized, and the caller must not coerce that to `operational`. An
 * unknown word means "we do not know", which is a different thing from "fine".
 */
export function mapRootlyComponentStatus(raw: string): 'operational' | 'degraded' | 'down' | null {
  switch (String(raw || '').trim().toLowerCase()) {
    case 'operational': return 'operational'
    case 'affected':
    case 'degraded':
    case 'degraded performance':
    case 'partial outage': return 'degraded'
    case 'major outage': return 'down'
    // Announced maintenance is not a live outage for the badge — `instatus.ts` states it directly
    // ("a scheduled-maintenance row shouldn't read as an outage") and `incident-io.ts` weights it 0.
    case 'under maintenance': return 'operational'
    default: return null
  }
}

/**
 * Worst-of across the components in scope → the service badge.
 *
 * `unknown` when a component in scope has an unreadable status, or when scope resolves to nothing:
 * both mean we cannot state the service's condition, and #1233's rule is that `unknown` is neither an
 * outage nor an all-clear. Silently skipping the unreadable ones would publish a green badge derived
 * from the components we happened to understand.
 */
export function rootlyOverallStatus(
  components: Array<{ id: string; status: string }>,
  scopeIds?: string[],
): 'operational' | 'degraded' | 'down' | 'unknown' {
  if (scopeIds?.length) {
    // A configured id ABSENT from the payload is not a component we may skip: worst-of over the ones
    // that happen to be present answers a narrower question than the badge claims. That is exactly
    // how the migration went unnoticed — the ids rotated, the scope resolved to fewer and fewer
    // components, and the badge kept reading green off the remainder.
    const present = new Set(components.map((c) => c.id))
    if (scopeIds.some((id) => !present.has(id))) return 'unknown'
  }
  const scope = scopeIds?.length ? components.filter((c) => scopeIds.includes(c.id)) : components
  if (scope.length === 0) return 'unknown'
  let worst: 'operational' | 'degraded' | 'down' = 'operational'
  for (const c of scope) {
    const s = mapRootlyComponentStatus(c.status)
    if (s == null) return 'unknown'
    if (s === 'down') worst = 'down'
    else if (s === 'degraded' && worst !== 'down') worst = 'degraded'
  }
  return worst
}

const STATUS_MAP: Record<string, Incident['status']> = {
  resolved: 'resolved',
  monitoring: 'monitoring',
  identified: 'identified',
  investigating: 'investigating',
}

/** Rendered update status → our union. Unknown words return null so the caller can count them. */
export function mapRootlyStatus(raw: string): Incident['status'] | null {
  return STATUS_MAP[String(raw || '').trim().toLowerCase()] ?? null
}

/**
 * The clause an update opens with before it says what broke. A local list rather than
 * ai-analysis.ts's `BOILERPLATE_PATTERNS`, which covers neither `Our team is` nor `We have noticed`
 * and whose other consumer would move with any edit made for this one.
 */
const REPORTING_PREAMBLE =
  /^(?:we|our team)\s+(?:are|is|have)\s+(?:currently\s+|still\s+)?(?:investigating|looking into|aware of|noticed|seeing)\s+(?:reports of\s+)?/i

/** A remainder that names nothing: "We are investigating the issue." strips to "The issue". */
const NAMES_NOTHING = /^(?:the |this |an? )?(?:issue|incident|problem)$/i

/** A closing line. It reports the end, so it cannot name what happened. */
const CLOSING_LINE = /^(?:this |the )?(?:incident |issue )?(?:has been |is being |is )?(?:resolved|fixed)\b/i

/** A first word safe to capitalize — plain letters, so a model id like `mistral-ocr-2512` is left alone. */
const PLAIN_FIRST_WORD = /^[a-z]+(?=\s|$)/

/**
 * The incident's name: the provider's title, or — when it published none — a name derived from the
 * earliest update. **Null when neither exists**, which the caller drops and counts.
 *
 * Null rather than `''` because `attachRootlyImpact` joins on `label.includes(inc.title)`
 * — and an empty title matches every
 * chart entry on the day, so an unnameable incident would inherit the severity of whichever other
 * component was down, and `score.ts` gates `isReliabilityIncident` on that severity being non-null.
 *
 * The title is also the retrieval key for AI-analysis grounding (`findSimilarIncidents`,
 * `findSimilarHistory` both score title-token overlap) and it is written to the no-TTL history
 * corpus, so an untitled incident does not merely display badly: it matches nothing, and the model
 * is told the outage has no precedent (#1471).
 *
 * Derived from the EARLIEST update only.
 *
 * `timeline` is expected in ascending order, as `normalizeRootlyIncidents` sorts it.
 */
export function rootlyIncidentTitle(title: string, timeline: TimelineEntry[]): string | null {
  const given = (title ?? '').trim()
  if (given) return given
  const text = (timeline[0]?.text ?? '').replace(/\s+/g, ' ').trim()
  if (!text || CLOSING_LINE.test(text)) return null
  const stripped = text.replace(REPORTING_PREAMBLE, '').trim()
  const named = stripped && !NAMES_NOTHING.test(stripped.replace(/[.!?]+$/, '')) ? stripped : text
  const bare = named.replace(/[.!?]+$/, '').trim()
  if (!bare) return null
  return PLAIN_FIRST_WORD.test(bare) ? bare.charAt(0).toUpperCase() + bare.slice(1) : bare
}

export interface NormalizeResult {
  incidents: Incident[]
  /** Updates whose timestamp did not parse. Non-zero means the page's time format moved. */
  unparsedTimestamps: number
  /** Update statuses we do not recognize. Non-zero means the vocabulary moved. */
  unknownStatuses: number
  /** Incidents the feed described but this could not publish. */
  droppedIncidents: number
}

/**
 * Feed incidents → our `Incident[]`.
 *
 * `impact` is always null, and that is a finding rather than a gap. Across all 93 impacted days on
 * the 14 Mistral components (2026-09-10) every incident title was a degradation phrasing — "… API
 * Degraded", "US Endpoint Service Degradation", "Console Degraded" — with no "Outage"/"Major"/
 * "Critical" anywhere, INCLUDING the one day whose uptime tooltip drew a `bg-red-500` segment
 * (titled "Elevated error rate…"). So the title does not carry severity, and inventing a mapping
 * from it would encode a distinction the source does not make. Severity lives in the uptime chart's
 * segment classes instead, which is a different payload and a different part of #1381.
 */
export function normalizeRootlyIncidents(feed: RootlyFeed): NormalizeResult {
  const incidents: Incident[] = []
  let unparsedTimestamps = 0
  let unknownStatuses = 0
  let droppedIncidents = 0

  for (const raw of feed.incidents ?? []) {
    const timeline: TimelineEntry[] = []
    let earliest: number | null = null
    let resolvedAt: number | null = null

    let lostUpdate = false
    for (const u of raw.updates ?? []) {
      const at = parseRootlyTimestamp(u.at)
      if (at == null) { unparsedTimestamps++; lostUpdate = true; continue }
      const status = mapRootlyStatus(u.status)
      if (status == null) { unknownStatuses++; lostUpdate = true; continue }
      if (earliest == null || at < earliest) earliest = at
      if (status === 'resolved' && (resolvedAt == null || at > resolvedAt)) resolvedAt = at
      timeline.push({ stage: status, text: u.body ?? null, at: new Date(at).toISOString() })
    }

    // No usable instant anywhere in the incident: it cannot be placed in a window, counted toward a
    // day, or given a duration, so publishing it would corrupt every consumer that does arithmetic
    // on it. Dropped and counted.
    //
    // A PARTIAL loss is dropped for a sharper reason: if the update we could not read was the Resolved
    // one, the incident publishes as live with `resolvedAt: null` — and because the scrape re-reads
    // the same page each cycle, it fails identically forever. A permanently-ongoing phantom reaches
    // `hasActiveIncident`, the is-down live-incident rule and the Discord alert path. Nothing here can
    // tell WHICH update was lost, so a partly-read incident is not published.
    //
    // "Could not read" covers an unparseable timestamp AND an unrecognized status word. Both lose the
    // same fact — whether this incident ended — and an unknown word used to be coerced to
    // `investigating`, which is the phantom above reached by the other branch.
    if (earliest == null || lostUpdate) { droppedIncidents++; continue }

    // Minute precision: an incident that opens and resolves inside one minute has two updates at the
    // same instant, and a stable sort would leave them in feed order — which is newest-first, so the
    // resolution would come first and name the incident.
    const feedIndex = new Map(timeline.map((e, i) => [e, i]))
    timeline.sort((a, b) =>
      Date.parse(a.at) - Date.parse(b.at) || feedIndex.get(b)! - feedIndex.get(a)!)
    const status: Incident['status'] = resolvedAt != null ? 'resolved' : (timeline[timeline.length - 1]?.stage ?? 'investigating')

    const title = rootlyIncidentTitle(raw.title, timeline)
    if (title == null) { droppedIncidents++; continue }

    incidents.push({
      id: raw.id,
      title,
      status,
      impact: null,
      startedAt: new Date(earliest).toISOString(),
      resolvedAt: resolvedAt != null ? new Date(resolvedAt).toISOString() : null,
      // The SHARED formatter, not a local copy: it carries `displayedMinutes`' rounding, so a Rootly
      // duration reads identically to every other source's. A second copy of this arithmetic is how
      // the two drift apart (#1006).
      duration: resolvedAt != null ? formatDuration(new Date(earliest), new Date(resolvedAt)) : null,
      timeline,
    })
  }

  return { incidents, unparsedTimestamps, unknownStatuses, droppedIncidents }
}

// ── Uptime chart ────────────────────────────────────────────────────────────────────────────────
// The severity the incident titles do NOT carry lives here. Across all 93 impacted days on the 14
// components (2026-09-10) every title read as a degradation — including the single day whose tooltip
// drew a `bg-red-500` segment, titled "Elevated error rate…". So the chart is the only place the
// source distinguishes a full outage from a partial one, and an incident's `impact` is derived by
// joining it to its component-day here rather than guessed from words.

/** One impacted day, verbatim from the `/uptime-chart-tooltip` fragment. */
export interface RootlyUptimeDay {
  /** "Aug 12, 2026" — the tooltip renders ABBREVIATED months, unlike the incident pages. */
  date: string
  /** Segment class + width as a share of the day. Green segments are the healthy remainder. */
  segments: Array<{ cls: string; width: number }>
  /** The tooltip's text, e.g. "Batch API Degraded". Joins a day to the incidents that caused it. */
  label: string
}

export interface RootlyUptimeComponent {
  componentId: string
  /** Day bars the chart rendered (91 observed) — the page's coverage, not ours. */
  barCount: number
  /** Bars the page drew as impacted, vs tooltips we actually retrieved. */
  coverage: { impacted: number; fetched: number }
  /**
   * Bars whose fill the scrape could not read at all.
   *
   * Separate from `coverage` because it answers a different question: `coverage` compares two numbers
   * the SAME DOM derivation produced, so a derivation that silently yields nothing reports
   * `{impacted: 0, fetched: 0}` — complete, clean, 100%. This counter is what makes that state
   * visible.
   *
   * REQUIRED, and `isStorableRootlyFeed` enforces it. It was optional for one round, defaulted with
   * `?? 0`, and in that round the scraper never sent it: a dropped field and a genuine zero were the
   * same value, so the guard this powers was inert in production while its unit test stayed green.
   */
  unreadBars: number
  days: RootlyUptimeDay[]
}

/**
 * Segment class → our impact level, reusing the SHARED weight vocabulary rather than a private one,
 * so a Rootly day weighs the same as an Atlassian or incident.io day (#259/#1006).
 *
 * Returns null on an unrecognized class. Only these two were observed; calling a third one healthy
 * would understate downtime and calling it major would overstate it, so the caller treats the day as
 * unreadable and withholds the figure instead of picking.
 */
export function rootlySegmentImpact(cls: string): 'major' | 'minor' | null {
  if (cls === 'bg-red-500') return 'major'
  if (cls === 'bg-gray-700') return 'minor'
  return null
}

export interface DayReading {
  /** Weighted downtime as a share of the day (major×1.0 + minor×0.3), or null if unreadable. */
  fraction: number | null
  /** Worst impact on the day; null when unreadable, or when nothing was impacted. */
  impact: 'major' | 'minor' | null
}

/**
 * One day's weighted downtime and worst impact.
 *
 * Unreadable the moment ANY segment is neither the healthy colour nor a known impact: a day we only
 * partly understand cannot be scored, and dropping the unknown part would publish a number that
 * reads as measured.
 */
export function rootlyDayReading(day: RootlyUptimeDay): DayReading {
  // Fail closed on a day we cannot read, rather than defaulting it into a clean one. `segments`
  // absent or not an array used to become `[]` here, which weighs as zero downtime — the direction
  // every gap on this source must never fail in. `label` is required for the same reason one level
  // on: `attachRootlyImpact` matches an incident by `label.includes(title)`, so an absent label
  // silently costs every incident on the day its severity, and `score.ts` drops a null-impact
  // incident from both `affectedDays` and the MTTR sample.
  if (!day || !Array.isArray(day.segments) || typeof day.label !== 'string') {
    return { fraction: null, impact: null }
  }
  let fraction = 0
  let hasMajor = false
  let hasMinor = false
  for (const seg of day.segments) {
    if (!seg || typeof seg !== 'object') return { fraction: null, impact: null }
    if (seg.cls === 'bg-green-400') continue
    const impact = rootlySegmentImpact(seg.cls)
    if (impact == null) return { fraction: null, impact: null }
    if (!Number.isFinite(seg.width) || seg.width < 0) return { fraction: null, impact: null }
    fraction += (seg.width / 100) * (impact === 'major' ? MAJOR_WEIGHT : MINOR_WEIGHT)
    if (impact === 'major') hasMajor = true
    else hasMinor = true
  }
  return { fraction: Math.min(1, fraction), impact: hasMajor ? 'major' : hasMinor ? 'minor' : null }
}

/**
 * "Aug 12, 2026" → the UTC calendar day, as `YYYY-MM-DD`.
 *
 * A second SHAPE, parsed by a second function — the tooltip carries no clock, the incident pages do,
 * and one lenient parser covering both is how a string from one surface gets read with the other's
 * assumptions. They share `MONTH_LOOKUP`, though: the month vocabulary is a property of the page, not
 * of the surface, and two copies of it are free to disagree.
 */
export function parseRootlyDay(text: string): string | null {
  if (typeof text !== 'string') return null
  const m = /^\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*$/.exec(text)
  if (!m) return null
  const month = MONTH_LOOKUP[m[1].toLowerCase()]
  if (month === undefined) return null
  const day = Number(m[2])
  const year = Number(m[3])
  const d = new Date(Date.UTC(year, month, day))
  if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return null
  return d.toISOString().slice(0, 10)
}

export interface RootlyUptimeResult {
  /** 30-day weighted uptime %, or null when the window could not be read completely. */
  pct: number | null
  /** Days the window actually covers — below `windowDays` for a young component. */
  windowDays: number | null
  /** Days we could not read — an unparseable tooltip DATE, or segments we could not weigh. Non-zero
   *  forces `pct` to null. An unparseable date is counted without testing it against the window,
   *  because a date we could not read cannot be placed inside or outside it; the alternative assumes
   *  the day was old, which is the "every gap fails toward no downtime" guess this module refuses. */
  unreadableDays: number
  /** Bars across the scoped charts whose fill we could not read — the state that otherwise reads as
   *  a spotless window, because a bar with no readable fill is indistinguishable from a clean one by
   *  colour alone. Whole-chart, not window-scoped, unlike `unreadableDays`. Non-zero forces `pct`
   *  to null. */
  unreadBars: number
  /** Components in scope whose tooltips were not all retrieved. Non-zero forces `pct` to null. */
  incompleteComponents: number
  /** Configured components with no chart in the payload at all. Non-zero forces `pct` to null —
   *  a denominator over the components that happened to arrive is not the scope's uptime. */
  missingComponents: number
  /** Scoped components whose chart carried no day bars. Non-zero forces `pct` to null: no bars is a
   *  component we did not read, not one with nothing to report. */
  unreadableComponents: number
  /**
   * `YYYY-MM-DD` → one entry per impacted COMPONENT-day, each carrying its OWN component's impact.
   *
   * Deliberately not collapsed to a worst-of per day. Two components can be impacted on the same
   * date at different severities, and an incident belongs to one of them: taking the day's worst
   * would stamp a `major` drawn for Console onto a `minor` Batch API incident, which is a severity
   * the source never published for it and which `score.ts` then books at weight 1.0 instead of 0.3.
   */
  days: Record<string, Array<{
    componentId: string
    label: string
    impact: 'major' | 'minor'
    /** Weighted downtime as a share of that day, for the #1017 per-day archive input. */
    fraction: number
  }>>
}

/**
 * Weighted outage SECONDS for the UTC day `nowMs` falls in — the #1017 durable archive input.
 *
 * Every other uptime path emits this and `index.ts` writes it per cycle. Without it the counter for
 * this service is `null` from here on and `readArchivedWeightedOutageSec` finds nothing, disabling
 * the mechanism whose stated purpose is letting a calendar survive a status-page migration — for the
 * one service that just migrated.
 *
 * Worst-of the scope, as a SHARE of the day rather than the whole day: an impacted day is usually a
 * few minutes, and rounding it up to 86400s would overstate every one of them.
 *
 * Null when the read was incomplete, for the same reason `pct` is — today's absent day is
 * indistinguishable from a clean one.
 */
export function rootlyTodayWeightedOutageSec(
  result: Pick<RootlyUptimeResult, 'pct' | 'days'>,
  nowMs: number,
): number | null {
  if (result.pct == null) return null
  const entries = result.days[new Date(nowMs).toISOString().slice(0, 10)]
  if (!entries || entries.length === 0) return 0
  return Math.round(86400 * Math.max(...entries.map((e) => e.fraction)))
}

/** Worst impact per day across the scope — the calendar's question, not the incident join's. */
export function rootlyDayImpactMap(
  days: RootlyUptimeResult['days'],
): Record<string, 'major' | 'minor'> {
  const out: Record<string, 'major' | 'minor'> = {}
  for (const [iso, entries] of Object.entries(days)) {
    for (const e of entries) if (e.impact === 'major' || out[iso] !== 'major') out[iso] = e.impact
  }
  return out
}

/**
 * Worst-of 30-day uptime across the components in scope, computed the way every other source is.
 *
 * Returns `pct: null` rather than an optimistic figure whenever the reading is incomplete — a lost
 * tooltip or an unknown segment class. That asymmetry is deliberate: every gap here fails toward
 * "no downtime", so a partial read inflates.
 *
 * A null does NOT reach a reader as a withheld uptime. `isStorableRootlyFeed` calls this function to
 * decide storability, so an incomplete read is refused at the KV gate and the previous complete feed
 * keeps serving. That indirection exists because publishing the null is the worse of the two: it
 * routes the service into `score.ts`'s rescale, which #1186 records as imputing uptime at
 * 0.667×(I+R+P) — on this service, 96.36% scores 55 and a withheld figure scores 74.
 */
export function computeRootlyUptime(
  components: RootlyUptimeComponent[],
  scopeIds: string[] | undefined,
  nowMs: number,
  windowDays = 30,
): RootlyUptimeResult {
  const scope = scopeIds?.length
    ? components.filter((c) => scopeIds.includes(c.componentId))
    : components
  // Configured-but-absent is a LOST READ, not a smaller scope. Counted here rather than ignored,
  // because the alternative publishes a percentage computed over whichever components arrived.
  const present = new Set(components.map((c) => c.componentId))
  const missingComponents = scopeIds?.length ? scopeIds.filter((id) => !present.has(id)).length : 0
  const cutoffDay = rootlyWindowCutoffDay(nowMs, windowDays)

  let unreadableDays = 0
  let unreadBars = 0
  let incompleteComponents = 0
  let unreadableComponents = 0
  const days: RootlyUptimeResult['days'] = {}
  let worstPct: number | null = null
  let coveredDays: number | null = null

  for (const comp of scope) {
    if (comp.coverage.fetched < comp.coverage.impacted) incompleteComponents++
    // Its own counter, NOT folded into `unreadableDays`: that one is in-window days whose tooltip
    // would not parse, while this is bars across the whole 91-bar chart. Summing them produces a
    // number neither unit explains — 13 blind charts would read as `unreadableDays=1183`.
    //
    // Not for the operator's benefit, though: `readRootlyStatus` runs the storability gate first, and
    // the gate refuses anything with `unreadBars > 0`, so the `rootly read:` warn is unreachable for
    // this counter and prints `unreadBars=0` whenever it prints at all. The operator's real signal is
    // the ingest 400 and the Action's non-zero exit. The split is for whoever reads this function's
    // RESULT — a test, or a future caller that does not gate first.
    unreadBars += comp.unreadBars
    const covered = Math.min(windowDays, Math.max(0, comp.barCount))

    let downtime = 0
    for (const day of comp.days ?? []) {
      // `day` itself can be null on a hand-edited or drifted payload; a throw here would escape the
      // gate as an exception rather than a `false`, which the rejection-test contract forbids.
      const iso = day ? parseRootlyDay(day.date) : null
      if (iso == null) { unreadableDays++; continue }
      if (iso < cutoffDay) continue                  // outside the window
      const reading = rootlyDayReading(day)
      if (reading.fraction == null) { unreadableDays++; continue }
      downtime += reading.fraction
      if (reading.impact != null) {
        (days[iso] ??= []).push({
          componentId: comp.componentId, label: day.label,
          impact: reading.impact, fraction: reading.fraction ?? 0,
        })
      }
    }
    if (covered > 0) {
      const pct = Math.max(0, Math.min(100, (1 - downtime / covered) * 100))
      // `windowDays` DESCRIBES the figure, so it comes from the component that produced it — not a
      // min across the scope. Round 2: a `Math.min` over every component let one that contributed
      // nothing to the percentage set the disclosed window (a clean 5-day sibling pinned it to 5
      // while the % came from a 91-day chart; a `barCount: 0` component pinned it to 0, which
      // `isArchiveRestoreEligible` then reads as "the whole calendar is a gap").
      if (worstPct == null || pct < worstPct) {
        worstPct = pct
        coveredDays = covered
      }
    } else {
      // A scoped component with no bars at all is a component we did not read, not a component with
      // nothing to say. Same treatment as one missing from the payload entirely.
      unreadableComponents++
    }
  }

  const complete = unreadableDays === 0 && incompleteComponents === 0 && missingComponents === 0
    && unreadableComponents === 0 && unreadBars === 0 && scope.length > 0
  return {
    pct: complete && worstPct != null ? Math.round(worstPct * 100) / 100 : null,
    windowDays: complete ? coveredDays : null,
    unreadableDays,
    unreadBars,
    incompleteComponents,
    missingComponents,
    unreadableComponents,
    days,
  }
}

/**
 * Give each incident the severity its component-day carries.
 *
 * Joined on (UTC start day, title appearing in that day's tooltip label) because the incident pages
 * name no component — checked on a real one, the affected-component list simply is not rendered. An
 * incident that finds no matching day keeps `impact: null` and is COUNTED: it then stays out of the
 * Score's affected-days and MTTR (both gate on `impact != null`), which understates rather than
 * invents.
 */
export function attachRootlyImpact(
  incidents: Incident[],
  uptime: Pick<RootlyUptimeResult, 'days'>,
  cutoffDay: string,
): { incidents: Incident[]; unattributed: number } {
  let unattributed = 0
  const out = incidents.map((inc) => {
    const day = inc.startedAt.slice(0, 10)
    const entries = (uptime.days[day] ?? []).filter((e) => e.label.includes(inc.title))
    if (entries.length === 0) {
      // An incident that STARTED before the window has no chart day to match, because the chart only
      // keeps in-window days — that is the window working, not a lost read. Counting it made the
      // diagnostic this feeds fire on every healthy run: the incident feed spans ~64 days while the
      // uptime read spans 30, so out-of-window incidents are permanent. `unattributed` means "a day
      // the uptime read COVERS, whose incident we still could not match" and nothing else.
      if (day >= cutoffDay) unattributed++
      return inc
    }
    // Worst-of the MATCHING entries only. A same-day entry for a different component is a different
    // outage and must not lend this incident its severity.
    const impact: Incident['impact'] = entries.some((e) => e.impact === 'major') ? 'major' : 'minor'
    return { ...inc, impact }
  })
  return { incidents: out, unattributed }
}

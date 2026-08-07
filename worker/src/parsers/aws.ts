// AWS Health Dashboard RSS Parser — for Amazon Bedrock

import type { Incident, TimelineEntry } from '../types'
import { formatDuration, isNonReliabilityAdvisory } from '../utils'

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, '') // strip HTML tags
}

function stripCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

function isValidDate(s: string): boolean {
  return !isNaN(new Date(s).getTime())
}

/** Map AWS RSS title keywords to AIWatch incident status */
function classifyAwsStatus(title: string): 'investigating' | 'identified' | 'monitoring' | 'resolved' {
  const lower = title.toLowerCase()
  if (lower.includes('[resolved]') || lower.includes('service is operating normally')) return 'resolved'
  if (lower.includes('[monitoring]')) return 'monitoring'
  if (lower.includes('[identified]')) return 'identified'
  return 'investigating'
}

/** Map AWS RSS title keywords to AIWatch impact */
function classifyAwsImpact(title: string): 'minor' | 'major' | 'critical' | null {
  const lower = title.toLowerCase()
  if (lower.includes('disruption') || lower.includes('outage')) return 'critical'
  if (lower.includes('degraded') || lower.includes('elevated') || lower.includes('increased')) return 'major'
  if (lower.includes('informational')) return 'minor'
  return null
}

// ── #677: AWS Health Dashboard public events JSON API ────────────────────────────────────────
// health.aws.amazon.com/public/events returns ONE event per incident with real `startTime` +
// `endTime` (epoch ms) and an EVENT_LOG timeline — unlike the legacy RSS (one <item> per update
// with a per-update-epoch guid + a single timestamp, which split active↔resolved into two records
// and floored resolved durations to `1m`). Plain fetch works (no headless scrape, unlike DeepSeek);
// the response is utf-16 JSON, decoded by the caller in services.ts.

interface AwsHealthEventLogEntry { summary?: string; message?: string; status?: number; timestamp?: number }
interface AwsHealthEvent {
  service?: string
  region?: string
  typeCode?: string
  startTime?: number        // epoch ms
  endTime?: number | null   // epoch ms; null/absent while the incident is active
  metadata?: { EVENT_LOG?: string }
}

/**
 * #677 — Decode the AWS Health events response body. The endpoint serves utf-16 JSON with a BOM,
 * and the Worker's response charset is unreliable, so detect the encoding from the BOM bytes
 * (FF FE = little-endian, FE FF = big-endian) rather than the content-type, strip any residual BOM,
 * then JSON.parse. THROWS on a decode/parse failure — the caller (services.ts) treats that as a
 * fetch failure (degrade) rather than silently reporting "operational, no incidents". Extracted +
 * exported so the cross-encoding logic (the source of a live BOM-decode bug) is unit-testable.
 */
export function decodeAwsHealthJson(buf: ArrayBuffer, contentType: string | null): unknown {
  const bytes = new Uint8Array(buf)
  const enc = bytes[0] === 0xFF && bytes[1] === 0xFE ? 'utf-16le'
    : bytes[0] === 0xFE && bytes[1] === 0xFF ? 'utf-16be'
    : /utf-16/i.test(contentType || '') ? 'utf-16le'
    : 'utf-8'
  const text = new TextDecoder(enc).decode(buf).replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

// #707 — phrases that mark a NON-reliability advisory: a deliberate provider/policy action
// (compliance, export control, access revocation, deprecation, scheduled change), NOT a service
// fault. AWS tags these with the SAME generic `*_OPERATIONAL_ISSUE` typeCode as a real outage, so the
// typeCode alone can't tell them apart — only the EVENT_LOG text can. The motivating case: the 2026-06
// "Fable 5 and Mythos 5 Access" event ("…export control directive, Anthropic has asked us to revoke
// access to Claude Fable 5 and Claude Mythos 5… all other models are not affected, use in full
// confidence") was a compliance model-removal, yet scored as a `major` 64.8h outage and tanked
// Bedrock's AIWatch Score to 43. We down-classify such advisories to `null` (informational) so they're
// excluded from the reliability score while still showing in the incident list.
// #811 — the non-reliability/outage-signal classification moved to utils.ts (`isNonReliabilityAdvisory`)
// so the fallback selector (#811) shares ONE source of truth with this AWS down-classification (#707).
// The shared NON_RELIABILITY_RE gained `suspend` for the Claude model-access-suspension incident.io wording.

/** Map an AWS Health event to AIWatch impact. The events API carries no explicit severity, but a
 *  `*_OPERATIONAL_ISSUE` is a service-impacting event (AWS labels these "Impacted"). We map it to
 *  `major` — the conservative non-"down" level; a full outage is ALSO an OPERATIONAL_ISSUE and is
 *  indistinguishable from the typeCode alone, so we don't over-claim `critical`.
 *  #707: when the EVENT_LOG `text` shows a clear NON-reliability advisory AND carries no outage signal,
 *  classify `null` (informational) so a compliance/deprecation/scheduled event doesn't score as a fault. */
export function awsHealthImpact(typeCode: string, text = ''): 'minor' | 'major' | 'critical' | null {
  const t = typeCode.toLowerCase()
  if (t.includes('informational') || t.includes('notification')) return 'minor'
  // #707 — a clear non-reliability advisory with NO outage signal is informational, not a reliability
  // incident: classify null so it's excluded from the AIWatch Score (uptime/incidents/recovery).
  if (text && isNonReliabilityAdvisory(text)) return null
  if (t.includes('operational_issue') || t.includes('disruption') || t.includes('outage')) return 'major'
  return null
}

function parseEventLog(raw: string | undefined): AwsHealthEventLogEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export type AwsHealthParseResult =
  | { ok: true; incidents: Incident[] }
  | { ok: false; reason: AwsHealthParseFailure }

/**
 * #1212 — the entry point the caller must use, for the same reason as the RSS sibling: `[]` alone
 * cannot separate "the array was empty" from "we could not read this". Two ways that happens on an
 * UNDOCUMENTED endpoint, and #677's guard covered neither because both parse fine:
 *
 *   - the payload is not the events array at all — a `{"events":[…]}` wrapper, an error object;
 *   - it IS an array, but no element carries the fields we key on, which is what a field rename
 *     (`startTime`→`startTimeMillis`, `service`→`serviceName`) looks like from here.
 *
 * The second test is "no element is recognizable", NOT "no element matched OUR service": an array of
 * EC2-only events is a perfectly readable payload that simply has nothing of ours, and an empty array
 * is a quiet day. Both stay readable.
 */
export function parseAwsHealthEventsResult(json: unknown, service: string): AwsHealthParseResult {
  if (!Array.isArray(json)) return { ok: false, reason: 'aws-health-not-an-array' }
  const recognizable = json.some((ev) => ev && typeof ev.service === 'string' && typeof ev.startTime === 'number')
  if (json.length > 0 && !recognizable) return { ok: false, reason: 'aws-health-no-recognizable-events' }
  return { ok: true, incidents: parseAwsHealthEvents(json, service) }
}

/**
 * #677 — Parse the AWS Health public events JSON (already decoded to a JS value) for ONE service
 * (e.g. 'BEDROCK') into normalized Incidents. Filters by `service`; uses the event's real
 * startTime/endTime so a resolved incident carries the TRUE duration (no 1m floor) as a single
 * record (no per-epoch-guid double-count). Active events (no endTime) → status 'investigating',
 * resolvedAt null. Stable id from service+region+startTime (startTime is fixed across updates).
 *
 * Not exported (#1212): `[]` from here is ambiguous, so callers go through
 * `parseAwsHealthEventsResult`, which decides whether the payload was readable in the first place.
 */
function parseAwsHealthEvents(json: unknown, service: string): Incident[] {
  if (!Array.isArray(json)) return []
  const incidents: Incident[] = []
  // #1212 — NO bound here. This is the all-AWS-services firehose, so any cap applied before the
  // per-service filter spends itself on other services' events and drops ours with no signal — the
  // exact failure this issue closes. The only defensible bound is the caller's, applied after
  // `filterIncidents`, where the population being counted is ours. A bound here would not even save
  // work: `parseAwsRegionHealth` walks the same unsliced array in the same tick.
  for (const ev of json as AwsHealthEvent[]) {
    if (!ev || ev.service !== service || typeof ev.startTime !== 'number') continue

    const log = parseEventLog(ev.metadata?.EVENT_LOG)
    const firstSummary = log[0]?.summary?.trim()
    const title = decodeXmlEntities(stripCdata(firstSummary || ev.typeCode || `${service} event`))
    // #707 — classify impact from the human EVENT_LOG text (summary + message across all entries),
    // not the generic typeCode alone, so a compliance/access-policy advisory isn't scored as an outage.
    const classificationText = log.map((e) => `${e.summary ?? ''} ${e.message ?? ''}`).join(' ').trim() || title
    const region = ev.region || 'unknown'
    const resolved = typeof ev.endTime === 'number' && ev.endTime > 0
    const startedAt = new Date(ev.startTime).toISOString()
    const resolvedAt = resolved ? new Date(ev.endTime as number).toISOString() : null
    const status: Incident['status'] = resolved ? 'resolved' : 'investigating'
    const duration = resolved ? formatDuration(new Date(ev.startTime), new Date(ev.endTime as number)) : null

    const timeline: TimelineEntry[] = log.length
      ? log.map((e): TimelineEntry => ({
          // Stage reflects EACH entry's own point in time, NOT the overall incident status — else a
          // resolved incident's onset entry (no [RESOLVED] marker) would inherit 'resolved'. EVENT_LOG
          // timestamps are in SECONDS (the top-level startTime is ms).
          stage: e.summary && /\[resolved\]|operating normally/i.test(e.summary) ? 'resolved' : 'investigating',
          text: decodeXmlEntities(stripCdata(e.message || e.summary || '')),
          at: typeof e.timestamp === 'number' ? new Date(e.timestamp * 1000).toISOString() : startedAt,
        }))
      : [{ stage: status, text: title, at: startedAt }]

    incidents.push({
      id: `aws:${service.toLowerCase()}:${region}:${ev.startTime}`,
      title,
      status,
      impact: awsHealthImpact(ev.typeCode || '', classificationText),
      componentNames: [region],
      startedAt,
      resolvedAt,
      duration,
      timeline,
    })
  }
  return incidents
}

/** A currently-degraded AWS region: worst-of level across its active events + a short summary. */
export interface AwsRegionHealthEntry { level: 'degraded' | 'down'; summary?: string }

/**
 * #574 — Derive CURRENTLY-DEGRADED AWS regions from the SAME public-events JSON the Bedrock fetch
 * already pulls (`health.aws.amazon.com/public/events`), across ALL AWS services (not just BEDROCK) —
 * so the supply-chain banner can correlate a cloud-region issue with dependent AI services. Reuses
 * `awsHealthImpact` (so a #707 non-reliability advisory → null → excluded). Only ACTIVE events
 * (no resolved endTime) count; worst-of per region (down > degraded). Returns {} when all clear.
 */
// AWS Health `service` codes that are AIWatch-MONITORED AI services (not shared infrastructure).
// Excluded from the region-health signal so "AWS region degraded" reflects the INFRASTRUCTURE
// substrate (EC2 / Route53 / MULTIPLE_SERVICES / …), not an AI service we already track separately —
// otherwise a Bedrock-only outage would circularly read as "AWS down → may affect Bedrock" (#574).
const AWS_REGION_HEALTH_EXCLUDE = new Set(['BEDROCK'])

export function parseAwsRegionHealth(json: unknown): Record<string, AwsRegionHealthEntry> {
  const out: Record<string, AwsRegionHealthEntry> = {}
  if (!Array.isArray(json)) return out
  for (const ev of json as AwsHealthEvent[]) {
    if (!ev || typeof ev.startTime !== 'number') continue
    if (ev.service && AWS_REGION_HEALTH_EXCLUDE.has(ev.service)) continue // AI service, not infra
    if (typeof ev.endTime === 'number' && ev.endTime > 0) continue // resolved → not current
    const region = ev.region
    if (!region || region === 'unknown') continue
    const log = parseEventLog(ev.metadata?.EVENT_LOG)
    const summary = decodeXmlEntities(stripCdata(log[0]?.summary?.trim() || ev.typeCode || ''))
    const classificationText = log.map((e) => `${e.summary ?? ''} ${e.message ?? ''}`).join(' ').trim() || summary
    const impact = awsHealthImpact(ev.typeCode || '', classificationText)
    if (impact === null) continue // informational/advisory → not a region-health signal
    const level: 'degraded' | 'down' = impact === 'critical' ? 'down' : 'degraded'
    const existing = out[region]
    // worst-of per region: down beats degraded. On overwrite, keep a summary (prefer the new event's,
    // else retain the existing one) so a summary-less worse event doesn't blank the region's text.
    if (!existing || (level === 'down' && existing.level !== 'down')) {
      const keptSummary = summary || existing?.summary
      out[region] = { level, ...(keptSummary ? { summary: keptSummary } : {}) }
    }
  }
  return out
}

/** Derive overall service status from active (unresolved) incidents */
export function deriveAwsStatus(incidents: Incident[]): 'operational' | 'degraded' | 'down' {
  const active = incidents.filter((i) => i.status !== 'resolved')
  if (active.length === 0) return 'operational'
  const hasCritical = active.some((i) => i.impact === 'critical')
  return hasCritical ? 'down' : 'degraded'
}

/**
 * #1212 — the reason vocabularies for a body we could not read. Member names are unique ACROSS every
 * sibling union (Instatus, OnlineOrNot, and these two), so an operator aggregating one reason across
 * services never sums two different parsers' failures — they take different fixes.
 */
export type AwsHealthParseFailure =
  | 'aws-health-unparseable'             // the body did not decode/parse at all (#677's original case)
  | 'aws-health-not-an-array'            // it parsed, but it is not the events array the endpoint documents
  | 'aws-health-no-recognizable-events'  // an array whose elements carry none of the fields we key on

export type AwsRssParseFailure =
  | 'aws-rss-not-a-feed'         // 200, but the body carries no RSS envelope at all (interstitial / error page)
  | 'aws-rss-items-unreadable'   // a feed WITH entries, none of which we could turn into an incident

export type AwsRssParseResult =
  | { ok: true; incidents: Incident[] }
  | { ok: false; reason: AwsRssParseFailure }

/** ONE pattern for both extraction and counting. `[\s>]` after the tag name accepts a legal
 *  `<item foo="bar">` while still refusing `<items>`/`<itemx>`. Deliberately not two patterns: an
 *  entry our own extraction could not match would otherwise be reported as upstream drift, and
 *  pinning a service `unreadable` over a weakness in this regex is worse than parsing the entry.
 *  The tempered body `(?:(?!<item[\s>])[\s\S])*?` is load-bearing, not defensive style: a plain lazy
 *  `[\s\S]*?` lets an UNCLOSED entry swallow the next one and borrow its `</item>`, so a real
 *  incident is published under the preceding entry's title — or dropped by the keyword filter with
 *  the count guard none the wiser, since one match is still one match.
 *  Used only with `.match()`, which resets `lastIndex` — do not switch it to `.test()`. */
const RSS_ENTRY_RE = /<item[\s>](?:(?!<item[\s>])[\s\S])*?<\/item>/g

/**
 * #1212 — the entry point the caller must use, because `[]` alone cannot answer the only question
 * that matters here: a quiet feed and a body that is not a feed at all both yield no `<item>`, and
 * the second one silently reads as "no incidents" → `operational` + a cleared failure streak, which
 * is the false-recovery class already fixed for Instatus (#1089) and OnlineOrNot (#1123).
 *
 * The envelope is the discriminator. Azure's feed always ships `<rss>` wrapping a `<channel>`, on a
 * quiet day as much as a busy one (verified against the live feed 2026-08-06, which carried a
 * `<channel>` with a title and `lastBuildDate` and zero items). An HTML interstitial or an error page
 * has neither. Deliberately NOT a content-type check: the failure this guards against is a middlebox
 * substituting a body, and such a response can carry any header it likes.
 *
 * The envelope alone is not enough, because a feed can arrive intact and still be unreadable ENTRY by
 * entry — a renamed date element, say, makes every entry fail its field checks and produces zero
 * incidents from a body that plainly carries some. That is the same false "no incidents" by a
 * different route, so a body with entries that yields none is a failure too. It cannot misfire on the
 * case that matters most here: zero entries in, zero incidents out is not the condition, and a feed
 * whose entries only PARTLY parse stays readable.
 *
 * Kept narrow on purpose — it does not try to detect a TRUNCATED feed. There is no reliable marker
 * for that in a format whose closing tags are optional-looking to a regex parser, and guessing would
 * risk the far worse direction: flagging a healthy quiet feed as unreadable, which pins a permanent
 * "we cannot read this source" caveat on a service that is fine. A truncation that cuts before
 * `<channel>` is caught by the envelope test; one that cuts after it is not.
 */
export function parseAwsRssIncidentsResult(xml: string): AwsRssParseResult {
  if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) return { ok: false, reason: 'aws-rss-not-a-feed' }
  // Match once and hand the entries down: the guard below needs the same list, and re-scanning a
  // pathological body a second time is the case this whole bound exists for.
  const entries = xml.match(RSS_ENTRY_RE) ?? []
  const incidents = parseAwsRssIncidents(entries)
  if (incidents.length === 0 && entries.length > 0) return { ok: false, reason: 'aws-rss-items-unreadable' }
  return { ok: true, incidents }
}

/**
 * Parse AWS Health Dashboard RSS feed into normalized Incidents.
 * Empty RSS (no <item> elements) = operational (returns []).
 * Each <item> is treated as a separate incident (AWS does not use guid grouping).
 *
 * Not exported (#1212): `[]` from here is ambiguous, so callers go through
 * `parseAwsRssIncidentsResult`, which decides whether the body was a feed in the first place.
 */
function parseAwsRssIncidents(items: readonly string[]): Incident[] {
  const incidents: Incident[] = []
  // #1212 — no bound here either, same reason as the health parser: this is the whole-Azure feed, so a
  // parser-side cap counts other services' entries first. `xml.match` has already materialised every
  // entry by this point, so a cap would only skip field extraction — it would not bound the scan.
  for (const item of items) {

    const title = decodeXmlEntities(stripCdata(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''))
    const desc = decodeXmlEntities(stripCdata(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? ''))
    const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? ''
    const guid = item.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] ?? ''

    if (!title || !isValidDate(pubDate)) continue

    const status = classifyAwsStatus(title)
    const impact = classifyAwsImpact(title)
    const startedAt = new Date(pubDate).toISOString()

    const timeline: TimelineEntry[] = [{
      stage: status,
      text: desc || title,
      at: startedAt,
    }]

    // For resolved incidents, estimate duration as 0 (single update point)
    const duration = status === 'resolved' ? formatDuration(new Date(pubDate), new Date(pubDate)) : null

    incidents.push({
      id: guid || `aws-${new Date(pubDate).getTime()}`,
      title,
      status,
      impact,
      startedAt,
      // AWS RSS has one pubDate per item — for resolved items this is the resolution time,
      // not the true start. Both startedAt and resolvedAt reflect the last-update timestamp.
      resolvedAt: status === 'resolved' ? startedAt : null,
      duration,
      timeline,
    })
  }

  return incidents
}

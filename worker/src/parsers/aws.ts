// AWS Health Dashboard RSS Parser — for Amazon Bedrock

import type { Incident, TimelineEntry } from '../types'
import { formatDuration } from '../utils'

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

/** Map an AWS Health `typeCode` to AIWatch impact. The events API carries no explicit severity, but
 *  a `*_OPERATIONAL_ISSUE` is a service-impacting event (AWS labels these "Impacted"). We map it to
 *  `major` — the conservative non-"down" level; a full outage is ALSO an OPERATIONAL_ISSUE and is
 *  indistinguishable from the typeCode alone, so we don't over-claim `critical`. */
export function awsHealthImpact(typeCode: string): 'minor' | 'major' | 'critical' | null {
  const t = typeCode.toLowerCase()
  if (t.includes('informational') || t.includes('notification')) return 'minor'
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

/**
 * #677 — Parse the AWS Health public events JSON (already decoded to a JS value) for ONE service
 * (e.g. 'BEDROCK') into normalized Incidents. Filters by `service`; uses the event's real
 * startTime/endTime so a resolved incident carries the TRUE duration (no 1m floor) as a single
 * record (no per-epoch-guid double-count). Active events (no endTime) → status 'investigating',
 * resolvedAt null. Stable id from service+region+startTime (startTime is fixed across updates).
 */
export function parseAwsHealthEvents(json: unknown, service: string): Incident[] {
  if (!Array.isArray(json)) return []
  const incidents: Incident[] = []
  for (const ev of json as AwsHealthEvent[]) {
    if (incidents.length >= 20) break
    if (!ev || ev.service !== service || typeof ev.startTime !== 'number') continue

    const log = parseEventLog(ev.metadata?.EVENT_LOG)
    const firstSummary = log[0]?.summary?.trim()
    const title = decodeXmlEntities(stripCdata(firstSummary || ev.typeCode || `${service} event`))
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
      impact: awsHealthImpact(ev.typeCode || ''),
      componentNames: [region],
      startedAt,
      resolvedAt,
      duration,
      timeline,
    })
  }
  return incidents
}

/** Derive overall service status from active (unresolved) incidents */
export function deriveAwsStatus(incidents: Incident[]): 'operational' | 'degraded' | 'down' {
  const active = incidents.filter((i) => i.status !== 'resolved')
  if (active.length === 0) return 'operational'
  const hasCritical = active.some((i) => i.impact === 'critical')
  return hasCritical ? 'down' : 'degraded'
}

/**
 * Parse AWS Health Dashboard RSS feed into normalized Incidents.
 * Empty RSS (no <item> elements) = operational (returns []).
 * Each <item> is treated as a separate incident (AWS does not use guid grouping).
 */
export function parseAwsRssIncidents(xml: string): Incident[] {
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g)
  if (!items) return []

  const incidents: Incident[] = []
  for (const item of items) {
    if (incidents.length >= 20) break

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

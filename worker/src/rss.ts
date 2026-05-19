// RSS 2.0 incident feed generation (#54).
// Pure functions — no Worker bindings. The route handlers in index.ts read
// `services:latest` from KV and pass the service list straight in.

import type { ServiceStatus, Incident } from './types'
import { escapeXml } from './badge'

const SITE = 'https://ai-watch.dev'

// Cap the feed (both scopes) so a burst of incidents can't bloat the response.
// The cached incident list is already small (recent + unresolved only).
const MAX_ITEMS = 50

// Service IDs whose ID differs from their /is-{slug}-down SEO page slug.
// Most services use their ID verbatim; only these dropped a dash in the ID.
// Canonical source: SERVICE_ID_TO_SLUG in api/is-down/slug-map.ts — this copy
// is pinned to it by worker/src/__tests__/feed-slug-sync.test.ts.
export const IS_DOWN_SLUG_OVERRIDE: Record<string, string> = {
  claudeai: 'claude-ai',
  claudecode: 'claude-code',
  characterai: 'character-ai',
  copilot: 'github-copilot',
}

// Services with no /is-{slug}-down page — estimate-only, excluded per #263.
// Their feed items fall back to the dashboard hash route. Pinned to the
// slug-map.ts omissions by feed-slug-sync.test.ts.
export const NO_IS_DOWN_PAGE = new Set(['bedrock', 'azureopenai'])

// Canonical slug for a service — matches the /is-{slug}-down page so the
// per-service feed URL is /feed/{slug} (e.g. /feed/claude-code), predictable
// for anyone who already knows /is-claude-code-down.
export function feedSlug(serviceId: string): string {
  return IS_DOWN_SLUG_OVERRIDE[serviceId] ?? serviceId
}

// Validates a /feed/{segment} path component before lookup — slugs and service
// IDs are lowercase alphanumerics plus dash/underscore. Rejects dots, slashes
// and the empty string so the route can 400 early.
export function isValidFeedSegment(segment: string): boolean {
  return /^[a-z0-9_-]+$/i.test(segment)
}

/**
 * Resolve a /feed/{segment} path to a service. The canonical form is the
 * is-down slug (/feed/claude-code); the raw service ID (/feed/claudecode) is
 * also accepted leniently so a guessed URL still works.
 */
export function resolveFeedService(
  services: ServiceStatus[],
  segment: string,
): ServiceStatus | null {
  return (
    services.find((s) => feedSlug(s.id) === segment) ??
    services.find((s) => s.id === segment) ??
    null
  )
}

// Item <link> target. /is-{slug}-down is a real crawlable URL (feed readers and
// Googlebot ignore the dashboard's `#hash` route); estimate-only services with
// no SEO page fall back to the hash route.
function serviceLink(serviceId: string): string {
  if (NO_IS_DOWN_PAGE.has(serviceId)) return `${SITE}/#${serviceId}`
  return `${SITE}/is-${feedSlug(serviceId)}-down`
}

// XML 1.0 forbids most C0 control characters. escapeXml handles & < > " but
// not these, so strip them before escaping to keep the feed well-formed.
// Tab (\x09), newline (\x0A) and carriage return (\x0D) are kept.
function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

function xml(s: string): string {
  return escapeXml(stripControlChars(s))
}

// RFC-822 / RFC-1123 date for <pubDate> / <lastBuildDate>. toUTCString()
// already emits the right shape ("Mon, 18 May 2026 14:52:31 GMT").
function rfc822(iso: string): string {
  const d = new Date(iso)
  return (isNaN(d.getTime()) ? new Date(0) : d).toUTCString()
}

// Map of incident ID → every service name carrying it. A provider that reports
// per-surface (Anthropic: Claude API / claude.ai / Claude Code) links one root
// incident to multiple services, so the same ID surfaces as several items —
// the "Also affecting" note tells a subscriber it's one event, not three.
function buildIncidentServiceMap(services: ServiceStatus[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const svc of services) {
    for (const inc of svc.incidents ?? []) {
      const names = map.get(inc.id) ?? []
      if (!names.includes(svc.name)) names.push(svc.name)
      map.set(inc.id, names)
    }
  }
  return map
}

function itemXml(service: ServiceStatus, inc: Incident, incidentServices: Map<string, string[]>): string {
  const latest = inc.timeline.length > 0 ? inc.timeline[inc.timeline.length - 1] : null
  const coAffected = (incidentServices.get(inc.id) ?? []).filter((n) => n !== service.name)
  const desc = [
    `Status: ${inc.status}`,
    inc.impact ? `Impact: ${inc.impact}` : null,
    inc.duration ? `Duration: ${inc.duration}` : null,
    coAffected.length > 0 ? `Also affecting: ${coAffected.join(', ')}` : null,
    latest?.text ? `Latest update: ${latest.text}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return `    <item>
      <title>${xml(service.name)}: ${xml(inc.title)}</title>
      <link>${xml(serviceLink(service.id))}</link>
      <guid isPermaLink="false">aiwatch:${xml(service.id)}:${xml(inc.id)}</guid>
      <pubDate>${rfc822(inc.startedAt)}</pubDate>${inc.impact ? `\n      <category>${xml(inc.impact)}</category>` : ''}
      <description>${xml(desc)}</description>
    </item>`
}

export type FeedScope =
  | { scope: 'all' }
  | { scope: 'service'; service: ServiceStatus }

/**
 * Build an RSS 2.0 feed of AI service incidents.
 * `all` flattens incidents across every service; `service` scopes to one.
 * Items are sorted newest-incident-first and capped at MAX_ITEMS.
 * `services` is always the full list (used for the cross-service incident map)
 * even when the feed is scoped to a single service.
 */
export function buildRssFeed(
  services: ServiceStatus[],
  opts: FeedScope,
  now: Date = new Date(),
): string {
  const incidentServices = buildIncidentServiceMap(services)
  const sources = opts.scope === 'service' ? [opts.service] : services
  const items = sources
    .flatMap((svc) => (svc.incidents ?? []).map((incident) => ({ svc, incident })))
    .sort(
      (a, b) =>
        new Date(b.incident.startedAt).getTime() - new Date(a.incident.startedAt).getTime(),
    )
    .slice(0, MAX_ITEMS)

  const title =
    opts.scope === 'service'
      ? `AIWatch — ${opts.service.name} Incidents`
      : 'AIWatch — AI Service Incidents'
  const description =
    opts.scope === 'service'
      ? `Incident updates for ${opts.service.name}, monitored by AIWatch.`
      : 'Real-time incident updates for AI services monitored by AIWatch.'
  const feedPath =
    opts.scope === 'service' ? `/feed/${feedSlug(opts.service.id)}` : '/feed.xml'

  const itemsXml = items.map(({ svc, incident }) => itemXml(svc, incident, incidentServices)).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(title)}</title>
    <link>${SITE}</link>
    <description>${xml(description)}</description>
    <language>en</language>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
    <atom:link href="${SITE}${xml(feedPath)}" rel="self" type="application/rss+xml"/>
${itemsXml}${itemsXml ? '\n' : ''}  </channel>
</rss>`
}

// What a /feed route was asked for — the all-services feed, or one service
// identified by its raw URL path segment (slug or ID, not yet validated).
export type FeedRequest =
  | { scope: 'all' }
  | { scope: 'service'; segment: string }

// Outcome of a feed request. `ok: true` is always HTTP 200 + an RSS body, so
// the success variant carries no status. The failure variant enumerates
// exactly the codes buildFeedResponse emits (400/404/503).
export type FeedResult =
  | { ok: true; xml: string }
  | { ok: false; status: 400 | 404 | 503; message: string }

/**
 * Decide the full response for a /feed request. Pure — the route handler only
 * does the KV read and Response wrapping, so the 400/404/503/200 branching is
 * unit-testable. `cached` is null when the status cache is unavailable (KV
 * down / binding missing / corrupt value): that is a 503, distinct from a
 * present-but-empty cache which is a legitimate 200 empty feed.
 */
export function buildFeedResponse(
  cached: { services: ServiceStatus[] } | null,
  req: FeedRequest,
  now?: Date,
): FeedResult {
  if (req.scope === 'service' && !isValidFeedSegment(req.segment)) {
    return { ok: false, status: 400, message: 'Invalid service slug' }
  }
  if (!cached) {
    return { ok: false, status: 503, message: 'Status data is temporarily unavailable' }
  }
  if (req.scope === 'all') {
    return { ok: true, xml: buildRssFeed(cached.services, { scope: 'all' }, now) }
  }
  const service = resolveFeedService(cached.services, req.segment)
  if (!service) {
    return { ok: false, status: 404, message: 'Service not found' }
  }
  return { ok: true, xml: buildRssFeed(cached.services, { scope: 'service', service }, now) }
}

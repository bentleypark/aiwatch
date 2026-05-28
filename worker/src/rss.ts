// RSS 2.0 incident feed generation (#54).
// Pure functions — no Worker bindings. The route handlers in index.ts read
// `services:latest` from KV and pass the service list straight in.

import type { ServiceStatus, Incident } from './types'
import { escapeXml } from './badge'
import { getFallbacks } from './fallback'

const SITE = 'https://ai-watch.dev'

// Cache-bust token for the stylesheet URL. The <?xml-stylesheet?> PI points at
// /feed.xsl?v=${FEED_XSL_VERSION}; /feed.xsl is cacheable, so without a version a returning
// visitor keeps a stale XSL after a format change (#467 — e.g. an old XSL rendering literal
// <p> tags). BUMP THIS whenever FEED_XSL changes so the URL changes and the cache misses.
export const FEED_XSL_VERSION = '2'

// Client-side XSLT so a browser opening the feed URL directly renders a friendly page
// instead of downloading raw XML (#467 — surfaced when Slack `/feed` links the feed title to
// the .xml). Feed readers + Slack ignore the stylesheet PI. Served at /feed.xsl (same origin,
// required for the browser to apply it). Self-contained: no external CSS/JS.
export const FEED_XSL = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="html" encoding="UTF-8" indent="yes"/>
  <xsl:template match="/rss/channel">
    <html lang="en">
      <head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title><xsl:value-of select="title"/></title>
        <style>
          :root { color-scheme: dark; }
          body { margin:0; background:#0d1117; color:#e6edf3; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; line-height:1.6; }
          .wrap { max-width:760px; margin:0 auto; padding:40px 20px 80px; }
          .rss-tag { display:inline-block; font-size:11px; font-family:ui-monospace,monospace; color:#f26522; border:1px solid rgba(242,101,34,.4); border-radius:4px; padding:2px 8px; margin-bottom:14px; }
          h1 { font-size:24px; margin:0 0 6px; }
          .desc { color:#9aa4b2; margin:0 0 10px; }
          .hint { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:12px 14px; font-size:13px; color:#9aa4b2; margin:18px 0 28px; }
          .hint code { color:#e6edf3; background:#0d1117; padding:1px 6px; border-radius:4px; font-size:12px; }
          .hint a { color:#58a6ff; }
          article { border-top:1px solid #21262d; padding:18px 0; }
          article a.t { color:#e6edf3; font-weight:600; font-size:16px; text-decoration:none; }
          article a.t:hover { color:#58a6ff; }
          time { display:block; color:#6e7681; font-size:12px; font-family:ui-monospace,monospace; margin:4px 0; }
        </style>
      </head>
      <body>
        <div class="wrap">
          <span class="rss-tag">RSS FEED</span>
          <h1><xsl:value-of select="title"/></h1>
          <p class="desc"><xsl:value-of select="description"/></p>
          <div class="hint">
            This is a machine-readable RSS feed. Subscribe in any feed reader, or in Slack paste
            <code>/feed subscribe <xsl:value-of select="atom:link/@href" xmlns:atom="http://www.w3.org/2005/Atom"/></code>.
            See the <a href="{link}">AIWatch dashboard</a> for live status.
          </div>
          <xsl:for-each select="item">
            <article>
              <a class="t" href="{link}"><xsl:value-of select="title"/></a>
              <time><xsl:value-of select="pubDate"/></time>
            </article>
          </xsl:for-each>
        </div>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>`

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

// A feed item is either the incident's own entry ('active' — fires the new-incident
// notification) or a separate resolution entry ('resolved'). A resolved incident keeps
// its 'active' item (description shows Status: resolved) AND gets a 'resolved' item with a
// DISTINCT guid + later pubDate (#467). RSS readers / Slack /feed dedup by guid, so without
// the distinct guid a status flip to resolved never re-notifies a subscriber.
type ItemKind = 'active' | 'resolved'

// Resolution timestamp: explicit resolvedAt, else the last 'resolved' timeline entry, else the
// last timeline entry, else the start (so the resolved item never sorts before its own start).
function resolvedAtOf(inc: Incident): string {
  if (inc.resolvedAt) return inc.resolvedAt
  for (let i = inc.timeline.length - 1; i >= 0; i--) {
    if (inc.timeline[i].stage === 'resolved') return inc.timeline[i].at
  }
  return inc.timeline.length > 0 ? inc.timeline[inc.timeline.length - 1].at : inc.startedAt
}

// "Try instead" line for an active item when the service is impaired (#467). Reuses the same
// tier-aware ranking as Discord/dashboard fallbacks. services:latest carries no aiwatchScore,
// so the ordering is tier-distance-first (intra-tier order arbitrary) and names are shown
// without scores — enough to point a subscriber somewhere useful.
function fallbackLine(svc: ServiceStatus, services: ServiceStatus[]): string | undefined {
  if (svc.status === 'operational') return undefined
  const fbs = getFallbacks(svc.id, svc.category, services)
  if (fbs.length === 0) return undefined
  return `Try instead: ${fbs.map((f) => f.name).join(' · ')}`
}

// Severity dot for the title + meta line (#467). Resolved → green; critical/major impact or a
// down service → red; everything else (minor / degraded) → amber. Roughly mirrors the dashboard
// status colors — note the feed additionally treats `major` impact as red even when the service
// is only `degraded` (the dashboard pill stays amber there), favoring alert legibility.
function severityEmoji(svc: ServiceStatus, inc: Incident, isResolved: boolean): string {
  if (isResolved) return '🟢'
  if (inc.impact === 'critical' || inc.impact === 'major' || svc.status === 'down') return '🔴'
  return '🟡'
}

// HTML-escape for text embedded inside the CDATA description. escapeXml turns `>` into `&gt;`,
// which also neutralizes any `]]>` sequence so user-sourced text can't terminate the CDATA early.
function escHtml(s: string): string {
  return escapeXml(stripControlChars(s))
}

function cap(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

// Render the description as small HTML paragraphs instead of one `·`-joined line (#467). Slack
// /feed, RSS readers, and the /feed.xsl browser page all render the HTML, so each fact lands on
// its own line — far more scannable than the old single run-on string. Structural tags are raw;
// every dynamic value is escHtml-escaped so nothing injects markup.
function descHtml(
  service: ServiceStatus,
  inc: Incident,
  coAffected: string[],
  opts: { kind: ItemKind; fallbackText?: string },
): string {
  const isResolved = opts.kind === 'resolved'
  const latest = inc.timeline.length > 0 ? inc.timeline[inc.timeline.length - 1] : null
  const lines: string[] = []

  if (isResolved) {
    lines.push(`<p>🟢 <strong>Resolved</strong>${inc.duration ? ` · lasted ${escHtml(inc.duration)}` : ''}</p>`)
  } else {
    const label = inc.impact ? cap(inc.impact) : service.status === 'down' ? 'Down' : 'Degraded'
    const meta = [`${severityEmoji(service, inc, false)} <strong>${escHtml(label)}</strong>`, escHtml(inc.status)]
    if (inc.duration) meta.push(escHtml(inc.duration))
    lines.push(`<p>${meta.join(' · ')}</p>`)
  }
  if (coAffected.length > 0) lines.push(`<p>Also affecting: ${escHtml(coAffected.join(', '))}</p>`)
  if (latest?.text) lines.push(`<p>${escHtml(latest.text)}</p>`)
  if (opts.fallbackText) lines.push(`<p>↪ ${escHtml(opts.fallbackText)}</p>`)
  return lines.join('')
}

function itemXml(
  service: ServiceStatus,
  inc: Incident,
  incidentServices: Map<string, string[]>,
  opts: { kind: ItemKind; pubDate: string; fallbackText?: string },
): string {
  const isResolved = opts.kind === 'resolved'
  const coAffected = (incidentServices.get(inc.id) ?? []).filter((n) => n !== service.name)
  const emoji = severityEmoji(service, inc, isResolved)
  const title = `${emoji} ${service.name}: ${isResolved ? 'Resolved — ' : ''}${inc.title}`
  const guid = isResolved ? `aiwatch:${service.id}:${inc.id}:resolved` : `aiwatch:${service.id}:${inc.id}`

  return `    <item>
      <title>${xml(title)}</title>
      <link>${xml(serviceLink(service.id))}</link>
      <guid isPermaLink="false">${xml(guid)}</guid>
      <pubDate>${rfc822(opts.pubDate)}</pubDate>${inc.impact ? `\n      <category>${xml(inc.impact)}</category>` : ''}
      <description><![CDATA[${descHtml(service, inc, coAffected, opts)}]]></description>
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
  // One item per incident, keyed by its current state (#467): an active incident emits its
  // 'active' item (guid `aiwatch:svc:inc`, red/amber); once resolved it emits ONLY the 'resolved'
  // item (guid `aiwatch:svc:inc:resolved`, green). The guid flips on resolution, so RSS readers /
  // Slack /feed re-notify the recovery — without ever showing a contradictory "🔴 … resolved"
  // base row. Sort by each item's own pubDate (resolution time for resolved items).
  type Entry = { svc: ServiceStatus; incident: Incident; kind: ItemKind; pubDate: string; fallbackText?: string }
  const items: Entry[] = []
  for (const svc of sources) {
    for (const incident of svc.incidents ?? []) {
      if (incident.status === 'resolved') {
        items.push({ svc, incident, kind: 'resolved', pubDate: resolvedAtOf(incident) })
      } else {
        items.push({ svc, incident, kind: 'active', pubDate: incident.startedAt, fallbackText: fallbackLine(svc, services) })
      }
    }
  }
  items.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
  const capped = items.slice(0, MAX_ITEMS)

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

  const itemsXml = capped
    .map((e) => itemXml(e.svc, e.incident, incidentServices, { kind: e.kind, pubDate: e.pubDate, fallbackText: e.fallbackText }))
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/feed.xsl?v=${FEED_XSL_VERSION}"?>
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

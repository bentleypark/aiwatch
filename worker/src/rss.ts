// RSS 2.0 incident feed generation (#54).
// Pure functions — no Worker bindings. The route handlers in index.ts read
// `services:latest` from KV and pass the service list straight in.

import type { ServiceStatus, Incident } from './types'
import { escapeXml } from './badge'
import { getFallbacks } from './fallback'
import { defuseAutolinkDomain } from './alerts'
import { formatRecoveryDisplay } from './ai-analysis'
import { appendStatusHint, appendUtm } from './utils'

const SITE = 'https://ai-watch.dev'

// #724 — public-safe subset of an AIAnalysisResult the RSS/Slack item surfaces, keyed per service.
// Mirrors the Discord embed's 🤖 AI ANALYSIS block (summary + recovery + scope) — the operator-only
// 🐦 TWEET DRAFT is deliberately NOT part of this shape (the feed is public). `incidentId` matches it
// to the right incident; the handler passes Record<svcId, RssAiAnalysis[]> read from ai:analysis:*.
export interface RssAiAnalysis {
  incidentId: string
  summary: string
  estimatedRecovery: string
  affectedScope: string[]
}
export type RssAiAnalysisMap = Record<string, RssAiAnalysis[]>

/** Find the analysis entry for a given service+incident (matched by incidentId). */
function analysisFor(map: RssAiAnalysisMap | undefined, svcId: string, incId: string): RssAiAnalysis | undefined {
  return map?.[svcId]?.find((a) => a.incidentId === incId)
}

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
  langsmith: 'langchain',
  deepseekapp: 'deepseek-app',
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

// Canonical is-down page URL for a service (no status hint). /is-{slug}-down is a real
// crawlable SSR page; no-official-uptime services excluded from the is-down SEO set (#263,
// NO_IS_DOWN_PAGE — bedrock/azureopenai) fall back to the dashboard hash. Precondition: pass a
// KNOWN service id — no validation is performed, so an unknown id yields a URL to a 404 is-down page.
// Single source of truth — reused by serviceLink (RSS item link, #467) and the per-user Discord
// relay (#726) so the "general subscriber → is-down" target can't drift from the feed slug map.
export function isDownUrl(serviceId: string): string {
  return NO_IS_DOWN_PAGE.has(serviceId) ? `${SITE}/#${serviceId}` : `${SITE}/is-${feedSlug(serviceId)}-down`
}

// Item <link> target. /is-{slug}-down is a real crawlable URL (feed readers and
// Googlebot ignore the dashboard's `#hash` route); estimate-only services with
// no SEO page fall back to the hash route.
// #539: the status hint (`?e=resolved|active`) gives a resolved item a DISTINCT link from its
// active item, so Slack /feed and other unfurlers fetch a fresh OG card on recovery instead of
// reusing the cached outage card. The hash fallback (estimate-only services) gets no hint — it has
// no is-down OG page to unfurl.
function serviceLink(serviceId: string, kind: ItemKind): string {
  // NO_IS_DOWN_PAGE services fall back to the dashboard hash (no OG page) → no hint and no utm.
  if (NO_IS_DOWN_PAGE.has(serviceId)) return isDownUrl(serviceId)
  // #548 — utm_source=rss so GA4 attributes feed-reader/Slack clicks to the RSS channel (consent-free).
  return appendUtm(appendStatusHint(isDownUrl(serviceId), kind), 'rss')
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
  opts: { kind: ItemKind; fallbackText?: string; analysis?: RssAiAnalysis },
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
  // #539: defuse bare "claude.ai" in co-affected service names + timeline text (Slack /feed unfurl).
  if (coAffected.length > 0) lines.push(`<p>Also affecting: ${escHtml(defuseAutolinkDomain(coAffected.join(', ')))}</p>`)
  if (latest?.text) lines.push(`<p>${escHtml(defuseAutolinkDomain(latest.text))}</p>`)
  // #724 — mirror the Discord embed's 🤖 AI ANALYSIS block (active items only; resolved items already
  // read "Resolved"). Public-safe fields only — never the operator-only tweet draft. defuse the
  // summary/scope so a bare brand domain doesn't auto-link in the Slack /feed unfurl.
  if (!isResolved && opts.analysis) {
    const a = opts.analysis
    lines.push(`<p>🤖 AI analysis: ${escHtml(defuseAutolinkDomain(a.summary))}</p>`)
    const detail = [`Est. recovery: ${escHtml(formatRecoveryDisplay(a.estimatedRecovery))}`]
    if (a.affectedScope.length > 0) detail.push(`Scope: ${escHtml(defuseAutolinkDomain(a.affectedScope.join(', ')))}`)
    lines.push(`<p>${detail.join(' · ')}</p>`)
  }
  if (opts.fallbackText) lines.push(`<p>↪ ${escHtml(opts.fallbackText)}</p>`)
  // Join with a newline, not '' (#479): block-level <p> render with a break in real RSS readers,
  // but Slack's /feed app FLATTENS the tags and would otherwise concatenate adjacent paragraphs
  // ("lasted 14m" + "Qwen3…" → "14mQwen3…"). The newline is insignificant whitespace between block
  // elements for HTML readers, and a line break for flatteners.
  return lines.join('\n')
}

function itemXml(
  service: ServiceStatus,
  inc: Incident,
  incidentServices: Map<string, string[]>,
  opts: { kind: ItemKind; pubDate: string; fallbackText?: string; analysis?: RssAiAnalysis },
): string {
  const isResolved = opts.kind === 'resolved'
  const coAffected = (incidentServices.get(inc.id) ?? []).filter((n) => n !== service.name)
  const emoji = severityEmoji(service, inc, isResolved)
  // #724 — provider-grouped header for a multi-surface (shared) incident, mirroring the Discord
  // embed ("Anthropic (Claude API, claude.ai, Claude Code) — …") instead of an API-centric
  // "Claude API: …". Single-surface incidents keep the plain "<service>: …" lead.
  // #539: defuse the bare "claude.ai" brand so Slack /feed doesn't auto-link/unfurl it.
  const lead = coAffected.length > 0
    ? `${service.provider || service.name} (${[service.name, ...coAffected].join(', ')})`
    : service.name
  const title = defuseAutolinkDomain(`${emoji} ${lead}: ${isResolved ? 'Resolved — ' : ''}${inc.title}`)
  const guid = isResolved ? `aiwatch:${service.id}:${inc.id}:resolved` : `aiwatch:${service.id}:${inc.id}`

  return `    <item>
      <title>${xml(title)}</title>
      <link>${xml(serviceLink(service.id, opts.kind))}</link>
      <guid isPermaLink="false">${xml(guid)}</guid>
      <pubDate>${rfc822(opts.pubDate)}</pubDate>${inc.impact ? `\n      <category>${xml(inc.impact)}</category>` : ''}
      <description><![CDATA[${descHtml(service, inc, coAffected, opts)}]]></description>
    </item>`
}

/**
 * Collapse feed entries sharing an incidentId+kind into a single entry (#520), keeping the FIRST
 * occurrence. A per-surface provider (Anthropic: Claude API / claude.ai / Claude Code) links one
 * root incident to several services, which would otherwise emit N near-identical items in the
 * all-services feed — and N Slack /feed messages. Callers pass entries in SERVICES order, so the
 * survivor is the deterministic "primary" surface (e.g. Claude API ahead of claude.ai / Claude Code);
 * itemXml's "Also affecting" line still names the rest. Exported for unit testing.
 *
 * Accepted edge: the survivor's guid is the primary's (`aiwatch:{primaryId}:{incId}`). If the primary
 * surface recovers BEFORE its siblings (partial recovery), the still-active item's primary shifts to the
 * next SERVICES-order surface, so its guid changes and Slack/RSS re-notifies the ongoing incident once.
 * Rare and arguably informative ("still active on claude.ai"); the alternative — an incident-scoped guid
 * — would re-post the entire feed on deploy (every guid changes), which is worse churn. Left as-is.
 */
export function dedupeSharedIncidents<T extends { incident: { id: string }; kind: ItemKind }>(entries: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const e of entries) {
    const key = `${e.incident.id}:${e.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
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
  aiAnalysis?: RssAiAnalysisMap,
): string {
  const incidentServices = buildIncidentServiceMap(services)
  const sources = opts.scope === 'service' ? [opts.service] : services
  // One item per incident, keyed by its current state (#467): an active incident emits its
  // 'active' item (guid `aiwatch:svc:inc`, red/amber); once resolved it emits ONLY the 'resolved'
  // item (guid `aiwatch:svc:inc:resolved`, green). The guid flips on resolution, so RSS readers /
  // Slack /feed re-notify the recovery — without ever showing a contradictory "🔴 … resolved"
  // base row. Sort by each item's own pubDate (resolution time for resolved items).
  type Entry = { svc: ServiceStatus; incident: Incident; kind: ItemKind; pubDate: string; fallbackText?: string; analysis?: RssAiAnalysis }
  const items: Entry[] = []
  for (const svc of sources) {
    for (const incident of svc.incidents ?? []) {
      if (incident.status === 'resolved') {
        items.push({ svc, incident, kind: 'resolved', pubDate: resolvedAtOf(incident) })
      } else {
        items.push({
          svc, incident, kind: 'active', pubDate: incident.startedAt,
          fallbackText: fallbackLine(svc, services),
          // #724 — no AI block for a `monitoring` incident (recovery already confirmed). Gating HERE
          // (not only in the /feed handler) keeps rss.ts self-consistent regardless of the map passed.
          analysis: incident.status === 'monitoring' ? undefined : analysisFor(aiAnalysis, svc.id, incident.id),
        })
      }
    }
  }
  // All-services feed (#520): collapse a multi-surface incident (one incidentId across Claude API /
  // claude.ai / Claude Code) into ONE item per (incidentId, kind) so a Slack /feed subscriber to
  // /feed.xml gets a single consolidated message instead of N near-identical ones. `sources` iterates
  // in SERVICES order so the surviving "primary" is deterministic; itemXml's "Also affecting" lists
  // the rest. Per-service feeds (scope:'service') have a single source, so this is a no-op there.
  const deduped = opts.scope === 'all' ? dedupeSharedIncidents(items) : items
  deduped.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
  const capped = deduped.slice(0, MAX_ITEMS)

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
    .map((e) => itemXml(e.svc, e.incident, incidentServices, { kind: e.kind, pubDate: e.pubDate, fallbackText: e.fallbackText, analysis: e.analysis }))
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
  aiAnalysis?: RssAiAnalysisMap,
): FeedResult {
  if (req.scope === 'service' && !isValidFeedSegment(req.segment)) {
    return { ok: false, status: 400, message: 'Invalid service slug' }
  }
  if (!cached) {
    return { ok: false, status: 503, message: 'Status data is temporarily unavailable' }
  }
  if (req.scope === 'all') {
    return { ok: true, xml: buildRssFeed(cached.services, { scope: 'all' }, now, aiAnalysis) }
  }
  const service = resolveFeedService(cached.services, req.segment)
  if (!service) {
    return { ok: false, status: 404, message: 'Service not found' }
  }
  return { ok: true, xml: buildRssFeed(cached.services, { scope: 'service', service }, now, aiAnalysis) }
}

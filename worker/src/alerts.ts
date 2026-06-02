// Alert detection logic — pure functions for testability
// Used by cronAlertCheck in index.ts

import { getFallbacks, buildFallbackText } from './fallback'
import { sanitize, formatDuration, appendStatusHint } from './utils'
import { computeLeadMs } from './detection-lead-log'
import { kindFromKey, svcIdsForAlert, type AlertKind } from './alert-feed'
// #422 Phase 2 — region-switch hint in Discord alerts. We reuse the existing
// Edge TS port rather than adding a third copy of SERVICE_REGIONS: the Worker
// bundler (esbuild via wrangler) can import across dirs (unlike Vercel Edge,
// which is why that port exists), and the file is pure data + functions with no
// runtime deps. This keeps the region map at two text-sync-pinned copies (SPA +
// this shared Edge/Worker port) instead of three. The SPA↔Edge parity is pinned
// by worker/src/__tests__/region-status-sync.test.ts.
//
// Trade-off (accepted, #422): this import reaches outside worker/tsconfig.json's
// rootDir ("src"), so a standalone `tsc -p worker/tsconfig.json` would emit
// TS6059. The worker is never built with tsc — wrangler/esbuild bundles it and CI
// runs vitest + `wrangler deploy --dry-run`, none of which trip on rootDir — so
// this is latent only. Preferred over a third SERVICE_REGIONS copy (drift > tsc
// purity here). If a tsc typecheck is ever added for the worker, add this path to
// the tsconfig `include` or relocate the shared port.
import { regionStatusOf } from '../../api/is-down/region-status'
import type { ServiceStatus } from './services'
import type { Incident } from './types'

// #283: Discord alert flap suppression for BetterStack auto-recovery noise.
// BetterStack-backed feeds emit paired "<model> — down" / "<model> — recovered" incidents
// per transient blip; a single model can produce ~2 Discord alerts × 10-14 flaps/day.
// Opt-in per ServiceConfig (flapSuppression: true). Tier-1 services (claude/openai/gemini)
// are excluded as defense-in-depth — their alert volume is low and suppressing a real
// outage would be costly.
//
// Flow: first flap's down + res alerts both fire normally; flap KV key is written when
// the first flap's res alert fires. Subsequent flaps (same normalized title, within 60min)
// are suppressed on both down and res via suppressedIncIds passed to buildIncidentAlerts.
const TIER1_IDS = new Set(['claude', 'openai', 'gemini'])

// BetterStack emits the literal em-dash (U+2014); guard against both "— recovered" and
// "— down" since a flap cycle can be caught mid-state, and the suppression window should
// cover both halves.
const FLAP_TITLE_RE = /\s*—\s*(down|recovered)\s*$/

/** Matches either half of a BetterStack flap cycle. Null-impact only — real incidents tagged with severity are never treated as flaps. */
export function isFlapNotice(inc: Incident): boolean {
  if (inc.impact != null) return false
  return FLAP_TITLE_RE.test(inc.title)
}

export function normalizeFlapTitle(title: string): string {
  return title.replace(FLAP_TITLE_RE, '').trim()
}

/** KV key for a 60-min suppression window, scoped to svcId + normalized title. */
export function flapSuppressionKey(svcId: string, inc: Incident): string {
  return `alerted:flap:${svcId}:${normalizeFlapTitle(inc.title)}`
}

/**
 * Whether this incident should be considered for flap suppression.
 * Returning true means: caller should check the KV key; if the key exists, skip the
 * Discord alert; if not, send the alert AND write the key to start the window.
 */
export function isFlapSuppressible(
  svcId: string,
  config: { flapSuppression?: boolean },
  inc: Incident,
): boolean {
  if (TIER1_IDS.has(svcId)) return false
  if (!config.flapSuppression) return false
  return isFlapNotice(inc)
}

export interface AlertCandidate {
  key: string
  title: string
  description: string
  fallbackText?: string
  /** #422 — region-switch hint (e.g. "📍 Try region: AWS US West") for new incidents
   *  on region-aware services with a region-specific partial outage. Rendered below the
   *  cross-service fallback. Absent on resolved alerts and non-region-aware services. */
  regionText?: string
  color: number
  url: string
  /** When alerts are merged (e.g., Together AI), contains all original dedup keys */
  _mergedKeys?: string[]
}

/**
 * Build the Discord region-switch hint for a new incident, or undefined when no
 * region recommendation applies. A region line is only useful when the outage is
 * region-specific AND at least one region is still healthy:
 *  - non-region-aware service (no SERVICE_REGIONS entry) → regionStatusOf returns null
 *  - global (non-region-specific) incident → hasRegionSpecific=false: cross-service
 *    fallback is the right guidance, not a region switch
 *  - every region hit (allDown) → no healthy region to recommend
 *  - a global incident coexisting with a region-specific one (hasGlobalIncident) →
 *    the whole service is affected, so a "healthy" region is not actually safe to
 *    recommend even though some regions look ok (#422 — would otherwise point
 *    operators at a region the global outage is also taking down)
 */
export function buildRegionHint(svc: ScoredService): string | undefined {
  const state = regionStatusOf(svc)
  if (!state || !state.hasRegionSpecific || state.allDown || state.hasGlobalIncident || !state.recommendedRegion) {
    return undefined
  }
  return `📍 Try region: ${state.recommendedRegion.label}`
}

export interface ScoredService extends ServiceStatus {
  aiwatchScore?: number | null
  scoreGrade?: string | null
}

/**
 * Build incident alerts (new + resolved) from service data.
 * Does NOT check KV dedup — caller is responsible for filtering already-sent alerts.
 * @param alertedNewIds Set of incident IDs that were previously alerted as new
 * @param suppressedIncIds Set of incident IDs to silently drop (both new and resolved paths).
 *                        Used by #283 flap suppression to skip a repeat flap within the window.
 */
export function buildIncidentAlerts(
  services: ScoredService[],
  alertedNewIds: Set<string>,
  now: number = Date.now(),
  suppressedIncIds: Set<string> = new Set(),
): AlertCandidate[] {
  // Group services by incidentId to show all affected services in one alert
  const newIncidents = new Map<string, { names: string[]; ids: string[]; inc: Incident; category: string; firstSvc: ScoredService }>()
  const resolvedIncidents = new Map<string, { names: string[]; ids: string[]; inc: Incident; firstSvc: ScoredService }>()

  for (const svc of services) {
    for (const inc of svc.incidents ?? []) {
      if (suppressedIncIds.has(inc.id)) continue // #283 flap suppression — skip both new + resolved
      const incAge = now - new Date(inc.startedAt).getTime()
      if (incAge > 86_400_000) continue

      if (inc.status !== 'resolved' && !alertedNewIds.has(inc.id)) {
        const existing = newIncidents.get(inc.id)
        if (existing) {
          if (!existing.names.includes(svc.name)) existing.names.push(svc.name)
          if (!existing.ids.includes(svc.id)) existing.ids.push(svc.id)
        } else {
          newIncidents.set(inc.id, { names: [svc.name], ids: [svc.id], inc, category: svc.category, firstSvc: svc })
        }
      } else if (inc.status === 'resolved' && alertedNewIds.has(inc.id)) {
        const existing = resolvedIncidents.get(inc.id)
        if (existing) {
          if (!existing.names.includes(svc.name)) existing.names.push(svc.name)
          if (!existing.ids.includes(svc.id)) existing.ids.push(svc.id)
        } else {
          resolvedIncidents.set(inc.id, { names: [svc.name], ids: [svc.id], inc, firstSvc: svc })
        }
      }
    }
  }

  const alerts: AlertCandidate[] = []

  for (const [incId, { names, ids, inc, category, firstSvc }] of newIncidents) {
    const displayName = names.length > 1 ? `${firstSvc.provider} (${names.join(', ')})` : names[0]
    const fallbackText = firstSvc.status !== 'operational'
      ? buildFallbackText(getFallbacks(firstSvc.id, category, services))
      : ''
    alerts.push({
      key: `alerted:new:${incId}`,
      title: `🔴 ${displayName} — New Incident`,
      description: sanitize(inc.title),
      fallbackText,
      regionText: buildRegionHint(firstSvc),
      color: 0xED4245,
      url: `https://ai-watch.dev/#${ids[0]}`,
    })
  }

  for (const [incId, { names, ids, inc, firstSvc }] of resolvedIncidents) {
    const displayName = names.length > 1 ? `${firstSvc.provider} (${names.join(', ')})` : names[0]
    const durationText = inc.duration ? ` (${inc.duration})` : ''
    alerts.push({
      key: `alerted:res:${incId}`,
      title: `🟢 ${displayName} — Incident Resolved${durationText}`,
      description: sanitize(inc.title),
      color: 0x57F287,
      url: `https://ai-watch.dev/#${ids[0]}`,
    })
  }

  return alerts
}

/**
 * Merge concurrent Together AI model-level alerts into single grouped alerts.
 * Together AI reports individual model incidents (e.g., "FLUX.1 Krea [dev] — down").
 * When multiple models go down/recover in the same cron cycle, merge into one alert.
 * Non-Together alerts pass through unchanged.
 */
export function mergeTogetherAlerts(alerts: AlertCandidate[]): AlertCandidate[] {
  const together: AlertCandidate[] = []
  const rest: AlertCandidate[] = []

  for (const a of alerts) {
    if (a.title.startsWith('🔴 Together AI — New Incident') || a.title.startsWith('🟢 Together AI — Incident Resolved')) {
      together.push(a)
    } else {
      rest.push(a)
    }
  }

  if (together.length <= 1) return alerts

  // Group by alert type (new vs resolved)
  const newAlerts = together.filter(a => a.key.startsWith('alerted:new:'))
  const resAlerts = together.filter(a => a.key.startsWith('alerted:res:'))

  const merged: AlertCandidate[] = []

  if (newAlerts.length > 1) {
    const descriptions = newAlerts.map(a => a.description)
    merged.push({
      key: newAlerts[0].key,
      title: `🔴 Together AI — ${newAlerts.length} New Incidents`,
      description: descriptions.join('\n'),
      fallbackText: newAlerts[0].fallbackText,
      regionText: newAlerts[0].regionText, // Together has no region map → undefined; preserved for parity
      color: 0xED4245,
      url: 'https://ai-watch.dev/#together',
      _mergedKeys: newAlerts.map(a => a.key),
    })
  } else {
    merged.push(...newAlerts)
  }

  if (resAlerts.length > 1) {
    const descriptions = resAlerts.map(a => a.description)
    merged.push({
      key: resAlerts[0].key,
      title: `🟢 Together AI — ${resAlerts.length} Incidents Resolved`,
      description: descriptions.join('\n'),
      color: 0x57F287,
      url: 'https://ai-watch.dev/#together',
      _mergedKeys: resAlerts.map(a => a.key),
    })
  } else {
    merged.push(...resAlerts)
  }

  return [...rest, ...merged]
}

// #394: Atlassian Statuspage clears `incident.status` to `resolved` a few minutes before the
// component-level `status_indicator` clears back to `operational`. Without suppression, a single
// outage produces 🔴 New → 🟢 Resolved → 🟠 Degraded → 🟢 Recovered. 15min covers up to ~3 cron
// cycles of component lag — narrower would re-allow the race; much wider would mask a fresh
// degradation that follows a resolution within the window. Down alerts are not suppressed since
// they are high-urgency and the lag is rare with major_outage indicators.
const RESOLVED_RACE_WINDOW_MS = 15 * 60 * 1000

/**
 * Build service status change alerts (degraded/down/recovered).
 * Suppresses status alerts when ongoing incidents already cover the service.
 * @param alertedDownMap Map of service ID → ISO timestamp when alerted as down
 * @param alertedDegradedMap Map of service ID → ISO timestamp when alerted as degraded
 * @param now Epoch ms used to evaluate the resolved-race-window (#394). Defaults to Date.now().
 */
export function buildServiceAlerts(
  services: ScoredService[],
  alertedDownMap: Map<string, string>,
  alertedDegradedMap: Map<string, string> = new Map(),
  now: number = Date.now(),
): AlertCandidate[] {
  const alerts: AlertCandidate[] = []

  for (const svc of services) {
    // Suppress status alerts if ongoing incidents exist (incident alert already covers it)
    const hasOngoingIncident = (svc.incidents ?? []).some((i) => i.status !== 'resolved')

    // #394: a 🟢 Resolved fired (or about to fire) in the last 15min on this service means
    // the user already received the canonical "back to normal" signal — silence the
    // 🟠 degraded that would otherwise fire from the still-stale component indicator.
    const hasRecentlyResolvedIncident = (svc.incidents ?? []).some((inc) => {
      if (inc.status !== 'resolved' || !inc.resolvedAt) return false
      const resolvedMs = new Date(inc.resolvedAt).getTime()
      if (Number.isNaN(resolvedMs)) return false
      return now - resolvedMs < RESOLVED_RACE_WINDOW_MS
    })

    if (svc.status === 'down' && !hasOngoingIncident) {
      alerts.push({
        key: `alerted:down:${svc.id}`,
        title: `🔴 ${svc.name} — Service Down`,
        description: `**${svc.name}** (${svc.provider})`,
        color: 0xED4245,
        url: `https://ai-watch.dev/#${svc.id}`,
      })
    }
    if (svc.status === 'degraded' && !hasOngoingIncident && !hasRecentlyResolvedIncident) {
      alerts.push({
        key: `alerted:degraded:${svc.id}`,
        title: `🟠 ${svc.name} — Partially Degraded`,
        description: `**${svc.name}** (${svc.provider})`,
        color: 0xE86235,
        url: `https://ai-watch.dev/#${svc.id}`,
      })
    }
    if (svc.status === 'operational' && (alertedDownMap.has(svc.id) || alertedDegradedMap.has(svc.id))) {
      // Calculate downtime from stored timestamp
      const alertedAt = alertedDownMap.get(svc.id) ?? alertedDegradedMap.get(svc.id)
      let downtimeText = ''
      if (alertedAt && alertedAt.length > 10) {
        const start = new Date(alertedAt)
        if (!isNaN(start.getTime()) && start.getTime() > 1_700_000_000_000) {
          downtimeText = ` (${formatDuration(start, new Date())})`
        }
      }
      // Include recent incident title in recovery alert if available
      const recentInc = (svc.incidents ?? []).filter(i => i.status === 'resolved').sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? '')).at(0)
      const incTitle = recentInc ? `\n> ${sanitize(recentInc.title).slice(0, 120)}` : ''
      alerts.push({
        key: `alerted:recovered:${svc.id}`,
        title: `🟢 ${svc.name} — Service Recovered${downtimeText}`,
        description: `**${svc.name}** is back to operational${incTitle}`,
        color: 0x57F287,
        url: `https://ai-watch.dev/#${svc.id}`,
      })
    }
  }

  return alerts
}

/**
 * Compute early-RTT-detection text for Discord alerts (#464 reframe).
 * Only renders for genuine cases where AIWatch's RTT probe flagged degradation BEFORE the official
 * status update (computeLeadMs returns null outside [1m, 60m), so negative/stale leads emit nothing).
 * This is an honest per-event signal — the aggregate "average lead" claim is gated separately by
 * MIN_LEAD_SAMPLE_SIZE since diagnostic data showed such genuine leads are rare.
 */
export function formatDetectionLead(detectedAt: string | null, incidentStartedAt: string): string {
  if (!detectedAt) return ''
  // Use computeLeadMs as single source of truth — guarantees Discord display + audit log share the same window.
  // Math.floor (not round) ensures display never claims 60m when leadMs is in [59m30s, 60m) — the cap is exclusive.
  const leadMs = computeLeadMs(detectedAt, incidentStartedAt)
  if (leadMs === null) return ''
  const mins = Math.floor(leadMs / 60_000)
  return `⚡ **Early signal: ${mins}m** — AIWatch flagged RTT degradation before the official status update`
}

// #348 — outage-tweet draft (Phase 1.5: manual-assist, no X API). For Claude/OpenAI-family
// incidents the operator Discord alert carries a ready-to-post tweet + a one-click X compose
// (Web Intent) link, so the operator turns the #348 manual playbook into a single click at the
// detection moment. This is OPERATOR-ONLY: the caller appends it after the per-user feed entry is
// built, so it never reaches a visitor's relayed webhook (#475).
//
// id → is-down slug. Slugs MUST match api/is-down/slug-map.ts — pinned by tweet-draft-slug-sync.test.ts.
export const TWEET_DRAFT_SERVICES: Record<string, string> = {
  claude: 'claude',
  openai: 'openai',
  claudeai: 'claude-ai',
  chatgpt: 'chatgpt',
  claudecode: 'claude-code',
  codex: 'codex',
}

// Headroom under X's 280-char limit. Literal .length is conservative: X counts any URL as 23 chars
// (t.co) regardless of its literal length, so a cap on the literal string can never under-count.
const TWEET_MAX = 270
const X_INTENT_BASE = 'https://twitter.com/intent/tweet?text='

/** Single-line, tweet-safe text: drop backticks (would break the Discord blockquote preview AND
 *  read oddly on X) and collapse all whitespace/newlines to single spaces. */
function cleanForTweet(s: string): string {
  return s.replace(/[`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function impactPhrase(impact: Incident['impact']): string {
  switch (impact) {
    case 'critical':
    case 'major':
      return 'a major outage'
    case 'minor':
      return 'degraded performance'
    default:
      return ''
  }
}

/** Pull the duration out of a recovery embed title's trailing parens, e.g.
 *  "🟢 Claude API — Incident Resolved (1h 20m)" → "1h 20m". Null when absent. */
function durationFromTitle(title: string): string | null {
  const m = title.match(/\(([^)]+)\)\s*$/)
  return m ? m[1].trim() : null
}

function findIncident(services: ServiceStatus[], incId: string): Incident | null {
  for (const s of services) {
    const inc = (s.incidents ?? []).find((i) => i.id === incId)
    if (inc) return inc
  }
  return null
}

/** Build the tweet text + X compose link for ONE specific in-scope service. The caller has already
 *  confirmed `svc.id` is in TWEET_DRAFT_SERVICES. The incident title/impact (for `new` alerts) comes
 *  from the shared incident, but the phrasing/status/url are the service's own. */
function buildTweetForService(
  svc: ScoredService,
  kind: AlertKind,
  alert: AlertCandidate,
  services: ScoredService[],
): { text: string; intentUrl: string } {
  // #539: defuse the bare "claude.ai" brand in the tweet text (the operator pastes this into
  // Slack/Reddit/X where a bare domain auto-links) + give the is-X-down link a status hint so a
  // recovery share is a DISTINCT URL from the outage share → platforms re-unfurl a fresh OG card.
  const isRecovery = kind === 'resolved' || kind === 'recovered'
  const name = defuseAutolinkDomain(svc.name)
  // Hint vocab mirrors the RSS feed (active/resolved): a 'new' incident alert can fire before the
  // service status has flipped off 'operational', so clamp that edge to 'active' (never emit
  // ?e=operational on an outage share). The only requirement is outage URL ≠ recovery URL.
  const hint = isRecovery ? 'resolved' : svc.status === 'operational' ? 'active' : svc.status
  const url = appendStatusHint(`https://ai-watch.dev/is-${TWEET_DRAFT_SERVICES[svc.id]}-down`, hint)

  let text: string
  if (isRecovery) {
    const duration = durationFromTitle(alert.title)
    text = duration
      ? `🟢 ${name} recovered after ${duration}. Live status → ${url}`
      : `🟢 ${name} has recovered. Live status → ${url}`
  } else {
    // down/degraded alerts carry no incId tail (svcId only), so incident-title enrichment applies
    // to `new` incidents only; status alerts fall back to status-based phrasing below.
    const incId = kind === 'new' ? alert.key.slice('alerted:new:'.length) : null
    const inc = incId ? findIncident(services, incId) : null
    const phrase = (inc && impactPhrase(inc.impact)) || (svc.status === 'degraded' ? 'degraded performance' : 'an outage')
    const head = `🔴 ${name} is reporting ${phrase}`
    const tail = `. Live status → ${url}`
    if (inc) {
      const cleaned = defuseAutolinkDomain(cleanForTweet(inc.title))
      const room = TWEET_MAX - head.length - 2 /* ": " */ - tail.length
      const title = cleaned.length > room ? `${cleaned.slice(0, Math.max(0, room - 1)).trimEnd()}…` : cleaned
      text = title ? `${head}: ${title}${tail}` : `${head}${tail}`
    } else {
      text = `${head}${tail}`
    }
  }
  return { text, intentUrl: X_INTENT_BASE + encodeURIComponent(text) }
}

export interface TweetDraft {
  serviceId: string
  serviceName: string
  text: string
  intentUrl: string
}

/**
 * Build a tweet draft per in-scope (Claude/OpenAI-family) service the alert covers (#521). A grouped
 * multi-surface incident (one incidentId across Claude API / claude.ai / Claude Code) yields one draft
 * per affected surface, in svcIds order, so the operator PICKS which surface to tweet about instead of
 * being locked to a single auto-chosen "primary". Empty when the alert covers no in-scope service.
 * Operator-only (the caller appends these after the per-user feed entry — never relayed, #475).
 */
export function buildTweetDrafts(
  alert: AlertCandidate,
  services: ScoredService[],
): TweetDraft[] {
  const kind = kindFromKey(alert.key)
  if (!kind) return []
  const keys = alert._mergedKeys ?? [alert.key]
  const svcIds = svcIdsForAlert(keys, kind, services)
  const drafts: TweetDraft[] = []
  for (const id of svcIds) {
    if (!TWEET_DRAFT_SERVICES[id]) continue // not a Claude/OpenAI-family service in scope
    const svc = services.find((s) => s.id === id)
    if (!svc) continue
    const { text, intentUrl } = buildTweetForService(svc, kind, alert, services)
    drafts.push({ serviceId: id, serviceName: svc.name, text, intentUrl })
  }
  return drafts
}

/**
 * Single-draft convenience: the first in-scope service's draft (legacy shape). Retained for the
 * existing contract/tests; new callers should prefer buildTweetDrafts for the operator's pick-a-service UX.
 */
export function buildTweetDraft(
  alert: AlertCandidate,
  services: ScoredService[],
): { text: string; intentUrl: string } | null {
  const [first] = buildTweetDrafts(alert, services)
  return first ? { text: first.text, intentUrl: first.intentUrl } : null
}

// Social platforms (Discord, Slack, Reddit, X) auto-link a bare brand domain that appears as plain
// text (e.g. "claude.ai", the claudeai service's display name) and unfurl a preview/thumbnail —
// visual noise. Render it as "claude ai" wherever it appears as plain text so no domain is detected.
// Used across the operator Discord embed (#535: title + description + tweet blockquote/label) AND the
// tweet/RSS/Reddit message text (#539 — the operator pastes the tweet draft into Slack, where the
// bare domain auto-links). The is-down URL is unaffected — its slug is `is-claude-ai-down` (hyphen,
// no dot). Only `claudeai`'s display name is a dotted domain among the monitored services
// (Character.AI is not in scope), so the literal regex is sufficient.
export function defuseAutolinkDomain(s: string): string {
  return s.replace(/claude\.ai/gi, 'claude ai')
}

// Discord rejects an embed description over this with HTTP 400 — which would drop the WHOLE operator
// alert, not just the draft section (sendDiscordAlert does no truncation). The tweet draft is an
// optional nicety, so it must never push the description over the limit.
export const DISCORD_EMBED_DESC_MAX = 4096

/**
 * Append the operator-only tweet-draft section to a Discord embed description, guaranteeing the result
 * stays within Discord's 4096-char limit (#521). One draft → the original preview+link shape; many →
 * labeled per-service compose links the operator picks from. Links that wouldn't fit are dropped with a
 * "+N more" suffix; if not even one fits (or there are no drafts), the description is returned unchanged
 * so the critical operator alert always sends.
 */
export function appendTweetDraftSection(description: string, drafts: TweetDraft[], div: string): string {
  if (drafts.length === 0) return description
  const SAFETY = 16 // headroom for the "+N more" suffix / multibyte rounding

  if (drafts.length === 1) {
    const d = drafts[0]
    const section = `\n${div}\n🐦 **TWEET DRAFT** — [✍️ Post on X](${d.intentUrl})\n> ${defuseAutolinkDomain(d.text)}`
    return description.length + section.length <= DISCORD_EMBED_DESC_MAX - SAFETY
      ? description + section
      : description
  }

  const intro = `\n${div}\n🐦 **TWEET DRAFT** — pick a service to post:\n`
  const budget = DISCORD_EMBED_DESC_MAX - SAFETY - description.length - intro.length
  const links = drafts.map((d) => `[✍️ ${defuseAutolinkDomain(d.serviceName)}](${d.intentUrl})`)
  const fit: string[] = []
  let used = 0
  for (const link of links) {
    const add = (fit.length ? 3 : 0) /* " · " */ + link.length
    if (used + add > budget) break
    fit.push(link)
    used += add
  }
  if (fit.length === 0) return description
  const more = drafts.length - fit.length
  return `${description}${intro}${fit.join(' · ')}${more > 0 ? ` · +${more} more` : ''}`
}

/** Detect service count drop — returns missing service IDs if below threshold */
export function detectServiceCountDrop(
  returnedIds: string[],
  expectedConfigs: Array<{ id: string }>,
  thresholdRatio = 0.8,
): { dropped: boolean; missing: string[] } {
  const threshold = Math.floor(expectedConfigs.length * thresholdRatio)
  if (returnedIds.length >= threshold) return { dropped: false, missing: [] }
  const returnedSet = new Set(returnedIds)
  const missing = expectedConfigs.filter(c => !returnedSet.has(c.id)).map(c => c.id)
  return { dropped: true, missing }
}

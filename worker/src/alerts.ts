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

// Matches either half of a BetterStack flap cycle. Excludes only `major` — NOT all non-null impact.
// #564/#565 made `mapBetterStackImpact` always return a non-null impact ('minor'|'major'), mapping an
// auto-monitor "<component> went down" flap → 'minor' and reserving 'major' for explicit broad-outage
// wording ('outage'/'unavailable'/'offline'). The original `impact != null` guard (added in #283 when
// BetterStack flaps were null-impact) therefore silently stopped matching ANY BetterStack incident
// post-#565 — disabling both the #283 flap-dedup AND the #633 first-seen hold for exactly the
// flapSuppression services they target (the Modal "Web endpoints — down" phantom recurred for this
// reason). A flap is now: '— down'/'— recovered' shape AND impact is not 'major' (null or 'minor').
export function isFlapNotice(inc: Incident): boolean {
  if (inc.impact === 'major') return false  // explicit broad outage → never a flap (alert immediately)
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

// #633 — first-seen confirmation gate (phantom-alert suppression).
//
// BetterStack auto-monitor services (flapSuppression: true) can emit a brand-new flap-shaped
// incident that self-recovers inside a single */5 cron cycle, with NO declared incident on the
// official page. flapSuppression only dedups the 2nd+ occurrence of a same-titled flap, so the
// FIRST one still fires a full new-incident Discord alert + AI analysis that then vanishes from
// every surface (the Modal "Web endpoints is down" 05:49 phantom).
//
// This gate holds a flap-shaped NEW incident for one extra cycle (~5–10min): the caller alerts
// only once the incident has survived a previous cron cycle (pendingExists). A blip that recovers
// inside the window never alerts — and buildIncidentAlerts emits no "recovered" for it either,
// since it was never added to alertedNewMap (see the `alertedNewMap.has` guard in the resolved
// branch). Severity-tagged incidents and Tier-1 services are never held (isFlapSuppressible is
// false for them) → immediate alert, no regression.
//
// Returns true = HOLD this cycle (suppress the new alert + write pending:new). Mirrors the
// existing `pending:degraded` debounce, but on the new-incident path.
const PENDING_NEW_PREFIX = 'pending:new:'

/** TTL for the first-seen pending marker — two 5-min cron cycles of tolerance (survives one skipped run). */
export const PENDING_NEW_TTL_S = 600

/** KV key for the #633 first-seen pending marker, scoped to the incident id. */
export function pendingNewKey(incId: string): string {
  return `${PENDING_NEW_PREFIX}${incId}`
}

export function shouldHoldNewIncident(
  svcId: string,
  config: { flapSuppression?: boolean },
  inc: Incident,
  state: { alreadyAlerted: boolean; pendingExists: boolean },
): boolean {
  if (state.alreadyAlerted) return false        // already fired in a prior cycle — never re-hold
  if (state.pendingExists) return false         // survived a prior cycle — confirm + fire now
  if (inc.status === 'resolved') return false   // resolved path is gated separately (alertedNewMap)
  return isFlapSuppressible(svcId, config, inc) // flap-shaped on a flap service → hold first sight
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
  /** #545 — the service ids this alert actually represents (the not-yet-alerted joiners for a
   *  new-incident alert; the affected set for resolved). Lets the dispatcher (a) merge only these
   *  ids into the per-incident `alerted:new:` roster and (b) scope tweet drafts + the per-user feed
   *  to them — so a service joining an already-alerted incident doesn't re-draft/re-notify the
   *  services that already fired. Absent on status alerts (down/degraded/recovered). */
  svcIds?: string[]
}

/** #689 — Decide whether a service's dead-source state warrants an operator notification this cron
 *  cycle. 'alert' on the rising edge (status page just returned 4xx, not yet alerted); 'recovered'
 *  on the falling edge (was alerted, the source responds again); 'none' otherwise. The caller
 *  persists/clears the `alerted:source-dead:{svcId}` dedup marker. Pure — unit-tested. */
export function shouldAlertSourceDead(isDead: boolean, alreadyAlerted: boolean): 'alert' | 'recovered' | 'none' {
  if (isDead && !alreadyAlerted) return 'alert'
  if (!isDead && alreadyAlerted) return 'recovered'
  return 'none'
}

/** #689 — Operator embed for a status source going inactive (4xx) or recovering. DISTINCT from a
 *  "degraded" alert so the source death is judged accurately: the service is shown operational+stale
 *  and excluded from rankings — it is NOT a service degradation. Yellow (operator action), not red. */
export function buildSourceDeadEmbed(name: string, statusUrl: string, recovered: boolean): { title: string; description: string; color: number } {
  if (recovered) {
    return {
      title: `🟢 ${name} — Status Source Recovered`,
      description: `The status page is responding again (${statusUrl}). AIWatch resumed reading live status and re-included it in rankings.`,
      color: 0x57F287,
    }
  }
  return {
    title: `⚠️ ${name} — Status Source Inactive`,
    description: `The status page returned a 4xx — likely deactivated/inactive (${statusUrl}). This is NOT a service degradation: AIWatch shows ${name} as operational + stale and excludes it from rankings until the source returns. Verify the status page / config.`,
    color: 0xFEE75C, // yellow — operator action needed, not an outage
  }
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
 * #545 — parse a stored `alerted:new:{incId}` KV value into the set of service ids already alerted
 * for that incident. The value is `JSON.stringify(svcIds)`; the legacy pre-#545 value was the boolean
 * `'1'`. Both `'1'` and any corrupt / non-array value fall back to `[currentSvcId]` — reproducing the
 * old "this incident is already alerted" suppression for the service currently visiting the key, so a
 * malformed value can never cause a re-alert storm (it errs toward suppression, self-heals on the next
 * clean write). `corrupt` is true only for unparseable / non-array values (NOT for the legacy `'1'`),
 * so the caller can log a breadcrumb without spamming on every legacy key during migration.
 */
export function parseAlertedRoster(raw: string, currentSvcId: string): { ids: string[]; corrupt: boolean } {
  if (raw === '1') return { ids: [currentSvcId], corrupt: false } // legacy boolean → seed current svc
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return { ids: parsed.map(String), corrupt: false }
  } catch {
    // fall through to the corrupt fallback below
  }
  return { ids: [currentSvcId], corrupt: true }
}

/**
 * Build incident alerts (new + resolved) from service data.
 * Does NOT check KV dedup — caller is responsible for filtering already-sent alerts.
 * @param alertedNewMap incidentId → set of service ids already alerted for that incident (#545).
 *                      A service is included in a new-incident alert only if it is NOT already in
 *                      its incident's set — so a service joining an already-alerted incident later
 *                      (e.g. ChatGPT joining a Codex incident after the title was renamed) still
 *                      gets its own alert. The resolved path fires once per incident that had ANY
 *                      service alerted (incidentId-level), as before.
 * @param suppressedIncIds Set of incident IDs to silently drop (both new and resolved paths).
 *                        Used by #283 flap suppression to skip a repeat flap within the window.
 */
export function buildIncidentAlerts(
  services: ScoredService[],
  alertedNewMap: Map<string, Set<string>>,
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

      // #545: per-service (not per-incident) — only services NOT yet alerted for this incident.
      // A service joining an already-alerted incident later still produces its own alert.
      if (inc.status !== 'resolved' && !alertedNewMap.get(inc.id)?.has(svc.id)) {
        const existing = newIncidents.get(inc.id)
        if (existing) {
          if (!existing.names.includes(svc.name)) existing.names.push(svc.name)
          if (!existing.ids.includes(svc.id)) existing.ids.push(svc.id)
        } else {
          newIncidents.set(inc.id, { names: [svc.name], ids: [svc.id], inc, category: svc.category, firstSvc: svc })
        }
      } else if (inc.status === 'resolved' && alertedNewMap.has(inc.id)) {
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
    const regionText = buildRegionHint(firstSvc)
    // #641 — suppress the cross-service fallback when a region switch is offered: a region-specific
    // outage is solved by the cheaper same-provider region switch, so a full provider switch
    // alongside it is redundant noise. (buildRegionHint returns undefined when no switch applies.)
    const fallbackText = (firstSvc.status !== 'operational' && !regionText)
      ? buildFallbackText(getFallbacks(firstSvc.id, category, services))
      : ''
    alerts.push({
      key: `alerted:new:${incId}`,
      title: `🔴 ${displayName} — New Incident`,
      description: sanitize(inc.title),
      fallbackText,
      regionText,
      color: 0xED4245,
      url: `https://ai-watch.dev/#${ids[0]}`,
      svcIds: ids, // #545 — the not-yet-alerted subset (all affected on first fire, only the joiner after)
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
      svcIds: ids, // #545 — the affected set, so the tweet/relay scope matches this alert
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
      svcIds: [...new Set(newAlerts.flatMap(a => a.svcIds ?? []))], // #545 — preserve roster (all 'together')
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
      svcIds: [...new Set(resAlerts.flatMap(a => a.svcIds ?? []))], // #545 — preserve roster (all 'together')
    })
  } else {
    merged.push(...resAlerts)
  }

  return [...rest, ...merged]
}

// #686 — xAI publishes the SAME event in multiple regions as separate incidents with distinct guids
// but near-identical titles differing only by a `[API (<region>.api.x.ai)] ` prefix (live: us-east-1 +
// eu-west-1). buildIncidentAlerts groups by incidentId, so each region fires its own alert. Strip the
// region prefix off the alert description (= the incident title) to derive a grouping key, so the SAME
// event across regions merges while DISTINCT events stay separate. More precise than mergeTogetherAlerts'
// blunt all-merge. xAI-only by design (other SERVICE_REGIONS feeds aren't verified to split per region).
const XAI_REGION_RE = /^\[API \(([a-z0-9-]+)\.api\.x\.ai\)\]\s*/i

/**
 * Merge concurrent xAI (Grok) per-region incident alerts (same event, different region) into one
 * grouped alert. New + resolved handled independently (a staggered resolve fires individually — same
 * limitation as mergeTogetherAlerts). Non-region-tagged xAI alerts and all non-xAI alerts pass through.
 * Sets `_mergedKeys` so every collapsed incidentId lands in the `alerted:new:` roster (no re-fire) and
 * the daily count still tallies each region (index.ts). svcIds stays `['xai']` so tweets/feed are unaffected.
 */
export function mergeXaiRegionalAlerts(alerts: AlertCandidate[]): AlertCandidate[] {
  const isXai = (a: AlertCandidate) =>
    a.title.startsWith('🔴 xAI (Grok) — New Incident') || a.title.startsWith('🟢 xAI (Grok) — Incident Resolved')
  const xai = alerts.filter(isXai)
  if (xai.length <= 1) return alerts
  const rest = alerts.filter((a) => !isXai(a))

  const collapse = (group: AlertCandidate[], kind: 'new' | 'res'): AlertCandidate[] => {
    const buckets = new Map<string, AlertCandidate[]>()
    const out: AlertCandidate[] = []
    for (const a of group) {
      if (!XAI_REGION_RE.test(a.description)) { out.push(a); continue } // not region-tagged → never merge
      const event = a.description.replace(XAI_REGION_RE, '').trim()
      const arr = buckets.get(event) ?? []
      arr.push(a)
      buckets.set(event, arr)
    }
    for (const arr of buckets.values()) {
      if (arr.length <= 1) { out.push(...arr); continue }
      const regions = arr.map((a) => XAI_REGION_RE.exec(a.description)?.[1]).filter(Boolean)
      const merged: AlertCandidate = {
        key: arr[0].key,
        title: `${kind === 'new' ? '🔴' : '🟢'} xAI (Grok) — ${kind === 'new' ? 'New Incident' : 'Incident Resolved'} (${regions.join(', ')})`,
        description: arr.map((a) => a.description).join('\n'), // preserve each region's original title
        color: kind === 'new' ? 0xED4245 : 0x57F287,
        url: 'https://ai-watch.dev/#xai',
        _mergedKeys: arr.map((a) => a.key),
        svcIds: [...new Set(arr.flatMap((a) => a.svcIds ?? []))], // all 'xai'
      }
      if (kind === 'new') {
        merged.fallbackText = arr[0].fallbackText
        merged.regionText = arr[0].regionText
      }
      out.push(merged)
    }
    return out
  }

  return [
    ...rest,
    ...collapse(xai.filter((a) => a.key.startsWith('alerted:new:')), 'new'),
    ...collapse(xai.filter((a) => a.key.startsWith('alerted:res:')), 'res'),
  ]
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

// #696 — UTM campaign on the is-down link the operator tweets. X mobile-app clicks strip the HTTP
// referrer, so without this they bucket as GA4 (direct)/(none) and X-driven outage inflow is
// invisible (the #547 funnel couldn't separate organic from X). The is-down Edge ignores unknown
// query params and keeps a clean rel=canonical, so the canonical URL is NOT polluted. Appended AFTER
// appendStatusHint (which always adds ?e=…), so the separator is always '&'.
const X_UTM = 'utm_source=x&utm_medium=social&utm_campaign=outage'

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
  const url = `${appendStatusHint(`https://ai-watch.dev/is-${TWEET_DRAFT_SERVICES[svc.id]}-down`, hint)}&${X_UTM}`

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
  // #545: incident alerts carry `svcIds` — the exact services this alert represents (new-incident: the
  // not-yet-alerted joiners; resolved: the full affected set) — so a service joining an already-alerted
  // incident later doesn't re-draft the services that already fired. Status alerts have no svcIds →
  // resolve the key tail (svcId/incId) the legacy way.
  const keys = alert._mergedKeys ?? [alert.key]
  const svcIds = alert.svcIds ?? svcIdsForAlert(keys, kind, services)
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

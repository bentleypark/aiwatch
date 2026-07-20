// Alert detection logic — pure functions for testability
// Used by cronAlertCheck in index.ts

import { buildGroupedFallbackText, API_TIER } from './fallback'
import { sanitize, formatDuration, appendStatusHint, isNonReliabilityAdvisory } from './utils'
import { kindFromKey, svcIdsForAlert, type AlertKind } from './alert-feed'
import { XAI_REGION_RE } from './xai-regions'
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
import { regionStatusOf } from '../../api/_is-down/region-status'
// #777 — is-down slug for the copyable reply draft's live-status link. SERVICE_ID_TO_SLUG is pure data
// (no @vercel/edge deps, same module the tweet-draft-slug-sync test imports) and covers gemini, which
// TWEET_DRAFT_SERVICES does not. Same cross-dir-import trade-off as regionStatusOf above (#422).
import { SERVICE_ID_TO_SLUG } from '../../api/_is-down/slug-map'
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
/** Tier-1: alerted immediately and NEVER held for AI (#767/#778/#882). Exported so #1080's hold-ledger
 *  diagnostic keys off the same set the hold gate uses, rather than a second copy that can drift. */
export const TIER1_IDS = new Set(['claude', 'openai', 'gemini'])

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
// #983 — an `autoMonitor`-tagged incident (services.ts stamps it from the provider's machine-emitted
// title allowlist) is a flap by construction, with NO "— down/recovered" suffix and often
// `impact: 'major'` — Statuspage derives impact from component status, so a 6-minute single-component
// blip reads `major`. Tagging is opt-in per service and the patterns are anchored, so this cannot
// reach a human-written incident. `critical` is still never treated as a flap on ANY path: it is the
// one level a status page never assigns by auto-monitor alone, so it stays the escape hatch that
// guarantees a genuine broad outage alerts immediately.
export function isFlapNotice(inc: Incident): boolean {
  if (inc.impact === 'critical') return false  // real broad outage → never a flap (alert immediately)
  if (inc.autoMonitor) return true             // #983 — machine-emitted; impact is component-derived
  if (inc.impact === 'major') return false     // explicit broad outage → never a flap (alert immediately)
  return FLAP_TITLE_RE.test(inc.title)
}

export function normalizeFlapTitle(title: string): string {
  return title.replace(FLAP_TITLE_RE, '').trim()
}

/** KV key for a 60-min suppression window, scoped to svcId + normalized title. */
export function flapSuppressionKey(svcId: string, inc: Incident): string {
  return `alerted:flap:${svcId}:${normalizeFlapTitle(inc.title)}`
}

// #983 — a flap is SHORT by definition. Flap suppression silences BOTH halves (new + res) of any
// same-titled incident inside a 60-min window, which is right for a blip and wrong for a real
// sustained outage that happens to reuse the title. Before #983 the `impact !== 'major'` screen in
// isFlapNotice was the de-facto guard; an `autoMonitor` incident bypasses that screen (its `major` is
// component-derived), so a genuine Twelve Labs outage opened minutes after a blip could have been
// suppressed for up to an hour. This is the replacement guard, and it generalizes: once an incident
// has RUN longer than every auto-monitor blip we've observed (5–16m across BetterStack + Statuspage),
// it is not a flap on any service — so it escapes suppression and alerts, tagged or not.
export const FLAP_SUPPRESSION_ESCAPE_MS = 30 * 60 * 1000

/** How long the incident has RUN: to `resolvedAt` when resolved, else to `nowMs`.
 *
 *  This feeds a SUPPRESSION guard, so an undecidable input must **fail open** — return a run length
 *  that escapes the window, so the alert SHIPS. Dropping a real alert is worse than one phantom
 *  (the #835 rule; #970's "판단 불가는 fail-open + warn"). An unparseable `startedAt` therefore yields
 *  `Infinity` + a warn, NOT 0: returning 0 would pin the incident below the escape threshold on every
 *  cron cycle, silently muting a real outage for the whole 60-min flap window. An unparseable
 *  `resolvedAt` degrades to measuring against `nowMs` (the best available clock) rather than
 *  discarding the incident's age. A `startedAt` in the future (upstream clock skew) clamps to 0 and
 *  stays suppressible — it self-corrects within cycles as `nowMs` advances past it. Pure — unit-tested. */
export function incidentRunMs(inc: Incident, nowMs: number): number {
  const started = Date.parse(inc.startedAt)
  if (Number.isNaN(started)) {
    console.warn('[alerts] #983 unparseable startedAt — failing open (no flap suppression):', inc.id, inc.startedAt)
    return Number.POSITIVE_INFINITY
  }
  let ended = nowMs
  if (inc.resolvedAt) {
    const resolved = Date.parse(inc.resolvedAt)
    if (Number.isNaN(resolved)) console.warn('[alerts] #983 unparseable resolvedAt — measuring run length to now:', inc.id, inc.resolvedAt)
    else ended = resolved
  }
  return Math.max(0, ended - started)
}

/**
 * Whether this incident should be considered for flap suppression.
 * Returning true means: caller should check the KV key; if the key exists, skip the
 * Discord alert; if not, send the alert AND write the key to start the window.
 *
 * `nowMs` is REQUIRED, not optional: an optional clock would let a call site silently keep the old
 * always-suppressible behavior and quietly reproduce the very silent-drop this guard exists to
 * prevent (the #970 lesson). Making it required means the type-checker names every call site.
 */
export function isFlapSuppressible(
  svcId: string,
  config: { flapSuppression?: boolean },
  inc: Incident,
  nowMs: number,
): boolean {
  if (TIER1_IDS.has(svcId)) return false
  if (!config.flapSuppression) return false
  if (!isFlapNotice(inc)) return false
  // Escapes the window symmetrically for the ongoing and the resolved half, so an escaped incident
  // that alerted New can never lose its Resolved (which would strand an "ongoing" card forever).
  if (incidentRunMs(inc, nowMs) >= FLAP_SUPPRESSION_ESCAPE_MS) return false
  return true
}

// #633 — first-seen confirmation gate (phantom-alert suppression).
//
// BetterStack auto-monitor services (flapSuppression: true) can emit a brand-new flap-shaped
// incident that self-recovers inside a single */5 cron cycle, with NO declared incident on the
// official page. flapSuppression only dedups the 2nd+ occurrence of a same-titled flap, so the
// FIRST one still fires a full new-incident Discord alert + AI analysis that then vanishes from
// every surface (the Modal "Web endpoints is down" 05:49 phantom).
//
// This gate holds a flap-shaped NEW incident until it has been first-seen for ≥ FLAP_HOLD_MS
// (~2 */5 cycles, #835 — was one): the caller stamps the first-seen ts in the marker and alerts
// only once the incident outlives the window. A blip that recovers inside the window never alerts —
// and buildIncidentAlerts emits no "recovered" for it either, since it was never added to
// alertedNewMap (see the `alertedNewMap.has` guard in the resolved branch). Severity-tagged
// incidents and Tier-1 services are never held (isFlapSuppressible is false) → immediate alert.
//
// Returns true = HOLD this cycle (suppress the new alert + write pending:new). Mirrors the
// existing `pending:degraded` debounce, but on the new-incident path.
const PENDING_NEW_PREFIX = 'pending:new:'

/** TTL for the first-seen pending marker. #835 — the marker stores the first-seen epoch ms and is
 *  written ONCE (get-or-set), so its TTL must comfortably outlast the FLAP_HOLD_MS window (~9min)
 *  plus a few skipped cron runs; 30min is generous (after confirm, alreadyAlerted guards re-hold so a
 *  lingering marker is harmless). */
export const PENDING_NEW_TTL_S = 1800

/** KV key for the #633 first-seen pending marker, scoped to the incident id. */
export function pendingNewKey(incId: string): string {
  return `${PENDING_NEW_PREFIX}${incId}`
}

// #792 — generalized short-incident hold. Where isFlapSuppressible targets the BetterStack
// "<model> — down/recovered" flap title shape, this holds ANY new non-major incident on a
// `holdShortIncidents` service. Such services (e.g. Langfuse) fire frequent short `minor`
// ingestion/latency incidents AND backdate the resolution, so our */5 cron often first catches the
// incident only as it's already resolving → a New+Resolved Discord double-alert for a blip the live
// dashboard never reflected. A sub-window blip that self-resolves never alerts (no New, and no
// Resolved via the alertedNewMap.has guard in buildIncidentAlerts' resolved branch); a genuinely
// ongoing incident alerts once it survives ~2 cycles (FLAP_HOLD_MS, #835). `major`/`critical` (real
// broad outage) and Tier-1 (claude/openai/gemini) always alert immediately. Pure — unit-tested.
// NOTE: unlike isFlapNotice (which excludes only `major` because the "— down/recovered" title regex
// already screens out a real critical incident), this path has no title guard, so it must exclude
// BOTH severe levels — a Langfuse statuspage incident maps `critical` through (parsers/statuspage.ts).
// #983 — `autoMonitor` is a SECOND opt-in into this hold, independent of `holdShortIncidents`: the tag
// itself declares the incident machine-emitted, so the `major` guard below (which reads impact as a
// human severity judgement) does not apply to it. `critical` is checked FIRST so it out-ranks the tag
// on every path — a tagged `critical` incident still alerts immediately.
export function isShortIncidentHoldable(
  svcId: string,
  config: { holdShortIncidents?: boolean },
  inc: Incident,
): boolean {
  if (TIER1_IDS.has(svcId)) return false
  if (inc.impact === 'critical') return false
  if (inc.autoMonitor) return true
  if (!config.holdShortIncidents) return false
  if (inc.impact === 'major') return false
  return true
}

// #835 — the hold window. Was ONE */5 cycle (~5min), which still let a flap that lingered just past
// one cron boundary fire a New+Resolved double-alert (Modal "Storage degraded" 1m; fireworks 3-6min
// model flaps). Extended to ~2 cycles: a hold-eligible incident must be first-seen for ≥ this long
// before it confirms + alerts, so a sub-~10min flap fires NEITHER New nor Resolved (the resolved is
// gated by the same alertedNewMap.has guard). 9min < 2×5min so it confirms on the cycle AFTER two
// full cycles even with mild cron jitter; a skipped run just confirms a touch sooner (still ≥1 cycle).
export const FLAP_HOLD_MS = 9 * 60 * 1000

export function shouldHoldNewIncident(
  svcId: string,
  config: { flapSuppression?: boolean; holdShortIncidents?: boolean },
  inc: Incident,
  // firstSeenMs: epoch ms the incident was first held (from the pending:new marker), or null on first
  // sight. nowMs: current time. A KV read error should pass firstSeenMs=0 (age huge → not held → fire),
  // preserving the prior fail-not-hold behavior (dropping a real alert is worse than one phantom).
  state: { alreadyAlerted: boolean; firstSeenMs: number | null; nowMs: number },
): boolean {
  if (state.alreadyAlerted) return false        // already fired in a prior cycle — never re-hold
  if (inc.status === 'resolved') return false   // resolved path is gated separately (alertedNewMap)
  // flap-shaped on a flap service, OR any non-major new incident on a short-incident-hold service.
  // #983 — the same clock the hold window uses, so an incident that has run past
  // FLAP_SUPPRESSION_ESCAPE_MS stops being hold-eligible via the flap branch too. It can still be held
  // by isShortIncidentHoldable (the tag / holdShortIncidents), which is bounded by FLAP_HOLD_MS (9min)
  // and therefore cannot delay a long real outage: by the time the escape matters the hold has lapsed.
  if (!(isFlapSuppressible(svcId, config, inc, state.nowMs) || isShortIncidentHoldable(svcId, config, inc))) return false
  if (state.firstSeenMs == null) return true    // first sight → hold (caller stamps firstSeen = now)
  return state.nowMs - state.firstSeenMs < FLAP_HOLD_MS  // still inside the window → hold; else confirm + fire
}

// #882 — the Discord new-incident AI-hold window. Orthogonal to the #633/#835 flap hold above (that
// holds a SHORT/FLAP incident to suppress a phantom alert; this holds a REAL incident briefly so its
// alert ships WITH the AI section instead of AI-less). A non-Tier-1 new incident whose 8s inline
// analysis overran is held until ai:analysis lands (the next cron's refreshOrReanalyze backfills it,
// with no 8s cap) OR this window elapses — then fail-open, send AI-less so an alert is never lost.
// ~2 */5 cron cycles: the held incident gets one retry cycle for the analysis before the alert ships
// without it, matching the accepted ~5min-typical / ~10min-worst delay (#882). Slack /feed already
// does the analogous hold via rss.ts AI_HOLD_MS (#759); this is its Discord-push counterpart.
export const AI_HOLD_MS = 10 * 60 * 1000

/** KV marker: first-seen epoch ms for the #882 AI-hold window, scoped to the incident id (write-once,
 *  get-or-set). Distinct from pendingNewKey so the two holds never clobber each other's window. */
export function pendingAiKey(incId: string): string {
  return `pending:ai:${incId}`
}

/**
 * #882 — should the cron HOLD a fresh new-incident Discord alert because its AI analysis isn't ready
 * yet? Holds ONLY a non-Tier-1 incident whose analysis is genuinely pending, and only within the
 * bounded window (fail-open past it). Holds NEITHER surface when:
 *   - aiReady: an AI section is already available (from KV or a successful inline call) → send now
 *   - analysisSkipped: AI will never come for this incident (merged / no-model / generic) → send now
 *   - Tier-1 (claude/openai/gemini): never held so the operator alert + phone push stay immediate (#767/#778)
 * A KV-read error should reach here as firstSeenMs=0 (age huge → past window → NOT held → fire),
 * mirroring shouldHoldNewIncident's fail-not-hold convention (dropping a real alert is worse than a
 * few-minute-early AI-less one). Pure — unit-tested.
 */
export function shouldHoldForAiAnalysis(state: {
  svcId: string
  aiReady: boolean
  analysisSkipped: boolean
  firstSeenMs: number | null
  nowMs: number
}): boolean {
  if (state.aiReady) return false            // AI present → nothing to wait for
  if (state.analysisSkipped) return false     // AI intentionally not produced → don't wait for it
  if (TIER1_IDS.has(state.svcId)) return false  // Tier-1 never held (speed: #767/#778)
  const firstSeen = state.firstSeenMs ?? state.nowMs  // first sight → window starts now
  return state.nowMs - firstSeen < AI_HOLD_MS          // within window → hold; past it → fail-open send
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
  /** #1021 — set on a non-reliability ADVISORY alert (usage-limits/quota/…, reframed ℹ️/blue). Lets
   *  downstream consumers keep the informational framing WITHOUT re-deriving from the title: buildTweetDrafts
   *  skips it (an advisory must not draft an "X is having an outage" tweet). The dedup `key` is unchanged. */
  advisory?: boolean
}

/** #714 — the status SOURCE's observed liveness this cron cycle, distinct from the service's status.
 *  `dead` = the status-page fetch completed + 4xx (deactivated/gone); `alive` = a clean fetch+parse
 *  (the ONLY genuine recovery signal); `unknown` = the fetch threw or returned 5xx (indeterminate
 *  — NOT a recovery; a 4xx incl. 429 is `dead`). Pre-#714 the boolean `sourceDead` conflated `alive`
 *  and `unknown` as `false`, so a
 *  single transient throw mid-dead-source fabricated a 'recovered' → next-cycle 'alert' flap. */
export type SourceLiveness = 'dead' | 'alive' | 'unknown'

/** #714 — derive the 3-state source liveness from a service's runtime flags. `sourceDead` (confirmed
 *  4xx, incl. 429) and `sourceUnknown` (throw / 5xx, and since #1089 an unreadable Instatus incident list) are set on disjoint return paths in services.ts;
 *  neither set = a clean fetch = `alive`. `dead` takes precedence defensively. Pure — unit-tested. */
export function sourceLivenessOf(svc: { sourceDead?: boolean; sourceUnknown?: boolean }): SourceLiveness {
  if (svc.sourceDead) return 'dead'
  if (svc.sourceUnknown) return 'unknown'
  return 'alive'
}

/** #689/#714 — Decide whether a service's status-source state warrants an operator notification this
 *  cron cycle, from the 3-state liveness. 'alert' on the rising edge (4xx, not yet alerted); 'recovered'
 *  ONLY on a genuine `alive` observation while alerted; 'hold' on an `unknown` observation while alerted
 *  (keep the dead marker, send nothing — a transient hiccup is NOT a recovery, the #714 fix); 'none'
 *  otherwise. 'alert' is further gated by a 1-cycle confirmation (pendingSourceDeadKey) in the caller.
 *  The caller persists/clears `alerted:source-dead:{svcId}`. Pure — unit-tested. */
export function shouldAlertSourceDead(liveness: SourceLiveness, alreadyAlerted: boolean): 'alert' | 'recovered' | 'hold' | 'none' {
  if (liveness === 'dead') return alreadyAlerted ? 'none' : 'alert'
  if (liveness === 'alive') return alreadyAlerted ? 'recovered' : 'none'
  return alreadyAlerted ? 'hold' : 'none' // unknown — indeterminate, never a recovery
}

/** TTL for the #714 first-seen dead-source confirmation marker — two 5-min cron cycles (survives one
 *  skipped run), mirroring PENDING_NEW_TTL_S (#633). */
export const PENDING_SOURCE_DEAD_TTL_S = 600

/** #714 — KV key for the dead-source 1-cycle confirmation marker, scoped to the service id. Mirrors
 *  pendingNewKey (#633): a dead source is HELD one cycle before the 'Inactive' alert fires, so a
 *  single-cycle 4xx blip that self-recovers never alerts. */
export function pendingSourceDeadKey(svcId: string): string {
  return `pending:source-dead:${svcId}`
}

/** #714 — the action the caller takes this cron cycle, combining the 3-state liveness edge with the
 *  1-cycle confirmation gate. The caller maps each to KV ops + an optional Discord send:
 *   - `alert`        → send 'Inactive'; on success set deadKey + clear pendingKey
 *   - `hold-confirm` → first dead sighting: set pendingKey, send nothing (debounce a single-cycle blip)
 *   - `recovered`    → send 'Recovered'; on success clear deadKey; clear pendingKey
 *   - `hold-unknown` → indeterminate while alerted: keep both markers, send nothing (the #714 fix)
 *   - `none`         → nothing to send; clear a stale pendingKey if the source is alive again */
export type SourceDeadAction = 'alert' | 'hold-confirm' | 'recovered' | 'hold-unknown' | 'none'

/** #714 — full per-cycle dead-source decision (pure). Combines `shouldAlertSourceDead` (the liveness
 *  edge) with the #633-style 1-cycle confirmation gate: the rising 'alert' edge is HELD on its first
 *  sighting (no `pending` marker yet) and only fires once a second consecutive cycle confirms it.
 *  Unit-tested — proves the flap (dead→unknown→dead) and single-cycle blips never produce a stray
 *  Inactive/Recovered pair. */
export function decideSourceDeadAction(
  liveness: SourceLiveness,
  state: { alreadyAlerted: boolean; pendingExists: boolean },
): SourceDeadAction {
  const edge = shouldAlertSourceDead(liveness, state.alreadyAlerted)
  if (edge === 'alert') return state.pendingExists ? 'alert' : 'hold-confirm'
  if (edge === 'recovered') return 'recovered'
  if (edge === 'hold') return 'hold-unknown'
  return 'none'
}

/** #800 — whether to SUPPRESS the source-dead Discord SEND for a KNOWN-deactivated status page. Only the
 *  recurring rising-edge 'alert' ("Inactive") is suppressed — the operator has already acknowledged the
 *  deactivation (e.g. Character.AI, #689), so re-alerting weekly is noise. 'recovered' is NEVER suppressed
 *  (a reactivation is news worth one alert). The caller still writes `alerted:source-dead` when suppressing,
 *  so the dead state is tracked and a later recovery is detected. Pure — unit-tested. */
export function shouldSuppressSourceDeadAlert(
  action: SourceDeadAction,
  config: { statusSourceDeactivated?: boolean },
): boolean {
  return !!config.statusSourceDeactivated && action === 'alert'
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
 * A new-incident alert requires an ACTIVE incident: `investigating`/`identified`. `monitoring` is
 * excluded (#1039) — the provider has applied a fix, so it is not new; see the branch comment for why
 * silence (rather than a down-classed alert) is what matches every other consumer.
 * @param alertedNewMap incidentId → set of service ids already alerted for that incident (#545).
 *                      A service is included in a new-incident alert only if it is NOT already in
 *                      its incident's set — so a service joining an already-alerted incident later
 *                      (e.g. ChatGPT joining a Codex incident after the title was renamed) still
 *                      gets its own alert. The resolved path fires once per incident that had ANY
 *                      service alerted (incidentId-level), as before — so a service that joined while
 *                      the incident was already `monitoring` still appears in the resolved alert,
 *                      which is accurate: the incident did affect it.
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
  const newIncidents = new Map<string, { names: string[]; ids: string[]; inc: Incident; firstSvc: ScoredService }>()
  const resolvedIncidents = new Map<string, { names: string[]; ids: string[]; inc: Incident; firstSvc: ScoredService }>()

  for (const svc of services) {
    for (const inc of svc.incidents ?? []) {
      if (suppressedIncIds.has(inc.id)) continue // #283 flap suppression — skip both new + resolved
      const incAge = now - new Date(inc.startedAt).getTime()
      if (incAge > 86_400_000) continue

      // #545: per-service (not per-incident) — only services NOT yet alerted for this incident.
      // A service joining an already-alerted incident later still produces its own alert.
      //
      // #1039 — `monitoring` is excluded: Statuspage `monitoring` means the provider APPLIED a fix and
      // is watching it, so the incident is not NEW. Gating on `!== 'resolved'` alone shipped a real
      // `🔴 OpenAI API — New Incident` for an already-recovering incident (2026-07-16). Silence, not a
      // down-classed alert: the normal path is ALREADY silent here (an incident alerted at
      // `investigating` is in the roster by the time it reaches `monitoring`), so emitting only on a
      // first-sight-at-`monitoring` would invent an alert type reachable solely from the edge case.
      // Rationale, the reachable paths, and the accepted residual risk (incl. what the #929/#882 holds
      // do here, and why /feed still covers it): docs/reference/discord-alert-paths.md #1039.
      // Observable, per this repo's twice-settled rule that a JUDGEMENT-call drop must never be quiet
      // (#970: "Every drop here is a silent one … that silence IS bug #970"; #983: without a line, triage
      // cannot tell "AIWatch suppressed it" from "AIWatch never saw it"). A confident drop needs no log;
      // this one is a judgement.
      //
      // Describes a STATE, not an event: this fn is stateless and a withheld alert is never rostered, so
      // the condition holds every cycle the incident sits in `monitoring` (bounded by the 24h `incAge`
      // cap). Same cadence as the #283/#983 flap line at index.ts — which is why it must not say "first
      // sight", which would be false from cycle 2 on. For the same reason line COUNT is not a frequency:
      // it is withheld-incidents × cycles-in-monitoring. Count distinct incident ids to measure how often
      // this actually fires.
      if (inc.status === 'monitoring' && !alertedNewMap.get(inc.id)?.has(svc.id)) {
        console.log(`[alerts] #1039 ${svc.id}: ${inc.id} is 'monitoring' and was never alerted — withholding the new alert (provider applied a fix; /feed still carries it)`)
      }
      if (inc.status !== 'resolved' && inc.status !== 'monitoring' && !alertedNewMap.get(inc.id)?.has(svc.id)) {
        const existing = newIncidents.get(inc.id)
        if (existing) {
          if (!existing.names.includes(svc.name)) existing.names.push(svc.name)
          if (!existing.ids.includes(svc.id)) existing.ids.push(svc.id)
        } else {
          newIncidents.set(inc.id, { names: [svc.name], ids: [svc.id], inc, firstSvc: svc })
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

  for (const [incId, { names, ids, inc, firstSvc }] of newIncidents) {
    const displayName = names.length > 1 ? `${firstSvc.provider} (${names.join(', ')})` : names[0]
    // #1021 — a non-reliability ADVISORY (usage-limits/quota/billing/deprecation — down-classified to
    // impact:null upstream) is NOT an availability outage, so it must not go out with the red
    // "🔴 New Incident" outage framing or a "try X instead" fallback (recommending users abandon a service
    // over a quota notice). Reframe it informational: ℹ️ / blue / no fallback / no region switch. Keyed on
    // the TITLE (same isNonReliabilityAdvisory the live down-classification + archive downtime use), NOT
    // impact==null — a mis-parsed null-impact REAL incident (status-determination.md footgun) keeps the
    // outage alert, the fail-safe direction. The dedup `key` is UNCHANGED, so the paired resolved alert
    // still matches. The #778 phone push already skips impact==null (pushTargetFor), so it stays silent.
    const isAdvisory = isNonReliabilityAdvisory(inc.title)
    const regionText = isAdvisory ? undefined : buildRegionHint(firstSvc)
    // #641 — suppress the cross-service fallback when a region switch is offered: a region-specific
    // outage is solved by the cheaper same-provider region switch, so a full provider switch
    // alongside it is redundant noise. (buildRegionHint returns undefined when no switch applies.)
    // #781 — grouped per-category fallbacks across ALL affected surfaces of the incident (not just the
    // primary's category), matching the dashboard: a multi-surface Anthropic incident now recommends
    // an LLM + an App + a Coding-Agent alternative, not just two LLMs.
    const fallbackText = (!isAdvisory && firstSvc.status !== 'operational' && !regionText)
      ? buildGroupedFallbackText(ids, services)
      : ''
    alerts.push({
      key: `alerted:new:${incId}`,
      title: isAdvisory ? `ℹ️ ${displayName} — Advisory` : `🔴 ${displayName} — New Incident`,
      description: sanitize(inc.title),
      fallbackText,
      regionText,
      color: isAdvisory ? 0x5865F2 : 0xED4245, // blurple (informational) vs red (outage)
      url: `https://ai-watch.dev/#${ids[0]}`,
      svcIds: ids, // #545 — the not-yet-alerted subset (all affected on first fire, only the joiner after)
      ...(isAdvisory ? { advisory: true } : {}),
    })
  }

  for (const [incId, { names, ids, inc, firstSvc }] of resolvedIncidents) {
    const displayName = names.length > 1 ? `${firstSvc.provider} (${names.join(', ')})` : names[0]
    // #1021 — match the new-alert framing: an advisory "clears" (ℹ️ / blue), it doesn't "resolve" like an
    // outage, and its duration is not downtime so it is omitted (showing it would re-imply an outage).
    const isAdvisory = isNonReliabilityAdvisory(inc.title)
    const durationText = inc.duration ? ` (${inc.duration})` : ''
    alerts.push({
      key: `alerted:res:${incId}`,
      title: isAdvisory ? `ℹ️ ${displayName} — Advisory cleared` : `🟢 ${displayName} — Incident Resolved${durationText}`,
      description: sanitize(inc.title),
      color: isAdvisory ? 0x5865F2 : 0x57F287,
      url: `https://ai-watch.dev/#${ids[0]}`,
      svcIds: ids, // #545 — the affected set, so the tweet/relay scope matches this alert
      ...(isAdvisory ? { advisory: true } : {}),
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
// event across regions merges while DISTINCT events stay separate. The regex lives in xai-regions.ts
// (#703) so the alert merge + the AI-analysis dedup can't drift. xAI-only by design.

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
    // #767 — service-status edge alerts (Down / Partially Degraded / Recovered) are now a
    // **Tier-1-only safety net**. The canonical alert is incident-based (buildIncidentAlerts); a
    // status-edge alert only ever fired in the incident-less gap (the `!hasOngoingIncident` guard
    // below), which is usually a transient indicator-before-incident race the incident alert covers
    // ~1 cron cycle later (the #759 AssemblyAI double: 6:18 "Service Down" → 6:23 "New Incident").
    // So for non-Tier-1 services we drop these entirely and rely on incident alerts; Tier-1
    // (claude/openai/gemini) keeps them so a Tier-1 hard-down with NO parseable incident still pages.
    if (API_TIER[svc.id] !== 1) continue

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

// #348 — outage-tweet draft (Phase 1.5: manual-assist, no X API). For Claude/OpenAI-family
// incidents the operator Discord alert carries a ready-to-post tweet + a one-click X compose
// (Web Intent) link, so the operator turns the #348 manual playbook into a single click at the
// detection moment. This is OPERATOR-ONLY: the caller appends it after the per-user feed entry is
// built, so it never reaches a visitor's relayed webhook (#475).
//
// id → is-down slug. Slugs MUST match api/_is-down/slug-map.ts — pinned by tweet-draft-slug-sync.test.ts.
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
// #777 — the copyable REPLY link adds utm_content=reply so GA4 can split reply-driven inflow from the
// 🐦 standalone-compose draft (both stay in campaign=outage → total X inflow still rolls up). This tests
// the core #777 hypothesis: replying to a viral tweet converts better than a fresh post (2026-06-23).
const X_REPLY_UTM = `${X_UTM}&utm_content=reply`

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

/**
 * #804 — a per-incident token for an operator share link's og:url. Social platforms cache + dedupe a
 * card by **og:url** (not the fetched URL) for ~7 days (#740), and the "{service} down" link is byte-
 * identical every outage (`is-{slug}-down?e=down` + constant UTM) — so a NEW outage within that window
 * reused the PREVIOUS outage's stale card. The token is the incident id (the `alerted:new:` /
 * `alerted:res:` key tail): stable within one incident (every share of it dedups to one card) yet
 * unique across incidents → a new outage becomes a distinct card identity → the platform re-scrapes a
 * fresh card. Returns null for status-EDGE alerts (down/degraded/recovered), whose key tail is a svcId
 * not an incident — those are Tier-1-only safety nets (#767) firing in the incident-less gap, not the
 * viral-reply path this targets. Merged alerts use `alert.key` (the representative incident).
 */
export function incidentTokenForAlert(alert: AlertCandidate): string | null {
  const kind = kindFromKey(alert.key)
  if (kind !== 'new' && kind !== 'resolved') return null
  const tail = alert.key.slice(alert.key.indexOf(':', 'alerted:'.length) + 1)
  return tail || null
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
  // #804 — append the per-incident token (when this is an incident alert) so the og:url is distinct
  // per outage and the platform re-scrapes a fresh card instead of reusing the prior `?e=down` cache.
  const token = incidentTokenForAlert(alert)
  const url = `${appendStatusHint(`https://ai-watch.dev/is-${TWEET_DRAFT_SERVICES[svc.id]}-down`, hint)}&${X_UTM}${token ? `&i=${encodeURIComponent(token)}` : ''}`

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
  if (alert.advisory) return [] // #1021 — an advisory is not an outage; never draft an "X is having an outage" tweet
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

// #777 — operator-only X-search links to find the viral "is X down??" tweet to REPLY to during an
// incident. Replying to a tweet that's already trending rides its engagement, which converts far better
// than a fresh compose (the #348 draft above): on 2026-06-23 one manual reply to a viral Anthropic tweet
// drove ~38 GA4 new users (all Twitter) off a single incident. The draft answers "what to post"; this
// answers "where to post it". The query is the plain natural phrase people actually tweet/search during
// an outage ("is claude down") — NOT an advanced-operator query: an earlier `min_faves:N -filter:replies`
// version returned ZERO results (operator-tested) because it over-filtered. Engagement ranking is handled
// by the `f=top` sort (the "Top" tab), so no min_faves floor is needed. Curated per-service phrasing so
// surfaces stay distinct (`claudeai` → "is claude.ai down" vs `claude` → "is claude down"). Scope mirrors
// TWEET_DRAFT_SERVICES + `gemini`
// (the surfaces that spawn viral outage tweets). OPERATOR-ONLY: appended after the per-user feed entry
// like the tweet draft, so it never reaches a relayed webhook (#475). Pinned by tweet-search-scope.test.ts.
export const TWEET_SEARCH_TERMS: Record<string, string> = {
  claude: 'is claude down',
  openai: 'is openai down',
  claudeai: 'is claude.ai down',
  chatgpt: 'is chatgpt down',
  claudecode: 'is claude code down',
  codex: 'is codex down',
  gemini: 'is gemini down',
}

const X_SEARCH_BASE = 'https://x.com/search?q='

/** Build the engagement-sorted ("Top" tab) X-search URL for ONE in-scope service. Top is the reply
 *  target — it surfaces the already-trending outage tweet to ride; the operator can flip to the Latest
 *  tab on the result page in one click if they need the freshest tweets, so only Top is linked (#777).
 *  Returns null for an out-of-scope service (the caller skips it). */
export function buildTweetSearchUrl(svcId: string): string | null {
  const term = TWEET_SEARCH_TERMS[svcId]
  if (!term) return null
  return `${X_SEARCH_BASE}${encodeURIComponent(term)}&f=top`
}

export interface TweetSearch {
  serviceId: string
  serviceName: string
  url: string
}

/**
 * Build a search-link entry per in-scope service the alert covers, mirroring buildTweetDrafts' svcIds
 * resolution (#545 svcIds → merged keys → legacy key-tail). Identical search queries collapse (dedupe by
 * URL) so a grouped same-provider incident doesn't list three near-identical "Claude" searches. Empty
 * when the alert covers no in-scope service. Operator-only.
 */
export function buildTweetSearches(alert: AlertCandidate, services: ScoredService[]): TweetSearch[] {
  const kind = kindFromKey(alert.key)
  if (!kind) return []
  if (alert.advisory) return [] // #1021 — an advisory is not an outage; no "is X down" viral-reply search links
  const keys = alert._mergedKeys ?? [alert.key]
  const svcIds = alert.svcIds ?? svcIdsForAlert(keys, kind, services)
  const out: TweetSearch[] = []
  const seen = new Set<string>()
  for (const id of svcIds) {
    const url = buildTweetSearchUrl(id)
    if (!url) continue // not an in-scope service
    if (seen.has(url)) continue // identical search already added
    seen.add(url)
    const svc = services.find((s) => s.id === id)
    out.push({ serviceId: id, serviceName: svc ? svc.name : id, url })
  }
  return out
}

export interface ReplyDraft {
  serviceId: string
  serviceName: string
  text: string
}

/**
 * Build ONE casual, copy-paste-ready REPLY for the alert's primary in-scope service (#777 follow-up). The
 * 🐦 TWEET DRAFT compose link can't pre-fill a *reply* to someone else's viral "is X down" tweet — the
 * operator has to paste text — so this provides that text, rendered in a Discord code block (one-click
 * copy on desktop) right above the 🔎 search links. Conversational tone so it blends into the reply thread
 * (not a press release). Primary = the first service in svcIds order that's in search scope (one reply per
 * alert: a grouped Anthropic incident → reply to "claude down" tweets with the Claude API surface). The
 * live-status link reuses the same `?e=` hint + X UTM as the tweet draft, and the service name is defused
 * (`claude.ai` → `claude ai`) since the operator pastes this into X where a bare domain auto-links (#539).
 */
export function buildReplyDraft(alert: AlertCandidate, services: ScoredService[]): ReplyDraft | null {
  const kind = kindFromKey(alert.key)
  if (!kind) return null
  // #1021 — an advisory leaves the service `operational`, so this would otherwise emit a factually-FALSE
  // "🔴 yes — {name} is down right now" reply (svc.status drives the down/degraded wording). Never for an
  // advisory — same reason buildTweetDrafts is gated: a quota notice is not an outage to reply-tweet.
  if (alert.advisory) return null
  const keys = alert._mergedKeys ?? [alert.key]
  const svcIds = alert.svcIds ?? svcIdsForAlert(keys, kind, services)
  const id = svcIds.find((s) => TWEET_SEARCH_TERMS[s]) // primary in-scope service
  if (!id) return null
  const svc = services.find((s) => s.id === id)
  const slug = SERVICE_ID_TO_SLUG[id]
  if (!svc || !slug) return null

  const isRecovery = kind === 'resolved' || kind === 'recovered'
  const hint = isRecovery ? 'resolved' : svc.status === 'operational' ? 'active' : svc.status
  // #804 — per-incident token (incident alerts only) → distinct og:url per outage, fresh card on re-share.
  const token = incidentTokenForAlert(alert)
  const url = `${appendStatusHint(`https://ai-watch.dev/is-${slug}-down`, hint)}&${X_REPLY_UTM}${token ? `&i=${encodeURIComponent(token)}` : ''}`
  const name = defuseAutolinkDomain(svc.name)
  // #936 — lead with a status circle (🔴 down / 🟠 degraded / 🟢 recovered) so the pasted tweet reply
  // shows severity at a glance in the thread. Mirrors the dashboard/feed dot convention.
  const circle = isRecovery ? '🟢' : svc.status === 'degraded' ? '🟠' : '🔴'
  const text = isRecovery
    ? `${circle} update — ${name} is back up. live status → ${url}`
    : svc.status === 'degraded'
      ? `${circle} yes — ${name} is having issues (degraded) right now. live status & details → ${url}`
      : `${circle} yes — ${name} is down right now. live status, affected components & recovery ETA → ${url}`
  return { serviceId: id, serviceName: svc.name, text }
}

/**
 * Append the operator-only "find tweets to reply to" section to a Discord embed description: a copyable
 * reply (code block, one-click copy) above the 🔎 Top-search link(s). Same 4096-char guard as
 * appendTweetDraftSection (these are an optional nicety and must never push the critical operator alert
 * over Discord's limit) — when space is tight it trims in priority order: extra service links first
 * (`+N more`), then the reply block, then the whole section, so the alert always sends.
 */
export function appendTweetSearchSection(
  description: string,
  searches: TweetSearch[],
  reply: ReplyDraft | null,
  div: string,
): string {
  if (searches.length === 0) return description
  const SAFETY = 16 // headroom for the "+N more" suffix / multibyte rounding
  const cap = DISCORD_EMBED_DESC_MAX - SAFETY
  const header = `\n${div}\n🔎 **FIND TWEETS TO REPLY TO**`
  // #936 — the copy-paste reply is now sent as a separate PLAIN message right below this embed, so it's
  // one-tap copyable on Discord MOBILE (long-press → Copy Text). The old in-embed ``` code block only
  // copied cleanly on desktop. Keep a one-line pointer here so the operator knows to grab it below.
  const replyBlock = reply ? `\n💬 **REPLY DRAFT** in the message below ↓ (long-press → Copy Text on mobile)` : ''

  if (searches.length === 1) {
    const links = `\n→ [🔥 Top tweets](${searches[0].url})`
    const full = header + replyBlock + links
    if (description.length + full.length <= cap) return description + full
    const lean = header + links // drop the reply block before dropping the link
    if (description.length + lean.length <= cap) return description + lean
    return description
  }

  // Multi-service picker: try with the reply block, then without, fitting links into the remaining budget.
  const build = (withReply: boolean): string | null => {
    const prefix = `${header}${withReply ? replyBlock : ''}\n→ pick a service:\n`
    const budget = cap - description.length - prefix.length
    const links = searches.map((s) => `[🔥 ${defuseAutolinkDomain(s.serviceName)}](${s.url})`)
    const fit: string[] = []
    let used = 0
    for (const link of links) {
      const add = (fit.length ? 3 : 0) /* " · " */ + link.length
      if (used + add > budget) break
      fit.push(link)
      used += add
    }
    if (fit.length === 0) return null
    const more = searches.length - fit.length
    return `${description}${prefix}${fit.join(' · ')}${more > 0 ? ` · +${more} more` : ''}`
  }
  return build(true) ?? build(false) ?? description
}

// #778 — phone-push scope: the surfaces whose outages spawn viral "is X down" tweets (Tier-1 LLMs +
// the consumer ChatGPT / claude.ai apps). NARROWER than the search scope (TWEET_SEARCH_TERMS, 7) on
// purpose — a phone push is urgent + DND-bypassing, so it's reserved for the highest-volume moments;
// claudecode/codex outages rarely trend on X. Every id here is also in TWEET_SEARCH_TERMS, so
// buildTweetSearchUrl always resolves the push Click target.
export const PUSH_SCOPE = new Set(['claude', 'openai', 'gemini', 'chatgpt', 'claudeai'])

export interface PushTarget {
  svcId: string
  serviceName: string
}

/**
 * Decide whether a NEW Tier-1-family down/degraded incident warrants an operator phone push (#778), and
 * for WHICH service — returns that primary service (for the push title + the Click X-search URL), or null
 * to skip. Gating: (1) NEW-incident edge only (`alerted:new` — never a status edge, recovery, or TTL
 * refresh); (2) a service in PUSH_SCOPE; (3) incident impact non-null (down/degraded — never an
 * informational / maintenance null-impact notice). Per-incident dedup is handled UPSTREAM by the cron's
 * `alerted:new` roster: the push fires in the same already-deduped send path as the Discord alert, so a
 * confirmed incident pushes exactly once. v1 excludes recovery pushes by the kind!=='new' guard.
 */
export function pushTargetFor(alert: AlertCandidate, services: ServiceStatus[]): PushTarget | null {
  if (kindFromKey(alert.key) !== 'new') return null
  const keys = alert._mergedKeys ?? [alert.key]
  const svcIds = alert.svcIds ?? svcIdsForAlert(keys, 'new', services)
  const id = svcIds.find((s) => PUSH_SCOPE.has(s)) // primary in-push-scope service
  if (!id) return null
  const incId = alert.key.slice('alerted:new:'.length)
  const inc = findIncident(services, incId)
  if (!inc || inc.impact == null) return null // informational / no-impact → no push
  const svc = services.find((s) => s.id === id)
  return { svcId: id, serviceName: svc ? svc.name : id }
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

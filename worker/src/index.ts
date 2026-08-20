// AIWatch Status Polling Proxy — Cloudflare Worker
// Fetches AI service status pages and returns normalized ServiceStatus[]
// Uses KV cache to serve last-known-good data on fetch failures

import { fetchAllServices, CACHE_KEY, COMPONENT_ID_SERVICES, PARTIAL_COMPONENT_SERVICES, SERVICES, TRACKED_COMPONENT_IDS, type ServiceStatus } from './services'
import { statusVerdict, isAffectedStatus, isHealthyStatus, isUnreadableStatus, normalizeCachedServices } from './status-verdict'
import { SUPPRESSIONS_KEY, normalizeSuppressions, mutateSuppressions, invalidateSuppressionCache, readSuppressionsFresh, readSuppressionsFreshOrNull, type SuppressionEntry } from './suppression'
import { OVERRIDES_KEY, normalizeOverrides, mutateOverrides, readOverridesFresh, applyDurationOverrides, type DurationOverride } from './overrides'
import { calculateAIWatchScore, classifyProbe } from './score'
import { serviceGroupOf } from './service-groups'
import { readWithdrawn, refreshWithdrawnKey, WITHDRAWN_TTL_S, type WithdrawnIncident } from './withdrawn'
import { markWithdrawalsAnnounced, readWithdrawalLog, isPermanentlyUnclosed, withdrawalIdsFromAlertKeys, monthsBackFrom, type WithdrawalLogEntry } from './withdrawal-log'
import type { AlertCandidate } from './alerts'
import { buildIncidentAlerts, buildWithdrawalAlerts, buildServiceAlerts, mergeTogetherAlerts, ALERTED_NEW_TTL_S, mergeXaiRegionalAlerts, detectServiceCountDrop, isFlapSuppressible, flapSuppressionKey, shouldHoldNewIncident, shouldHoldForAiAnalysis, NEVER_AI_HELD, pendingAiKey, pendingNewKey, markerReadPlan, PENDING_NEW_TTL_S, buildTweetDrafts, appendTweetDraftSection, buildTweetSearches, buildTweetSearchUrl, buildReplyDraft, pushTargetFor, appendTweetSearchSection, buildRedditEngageTargets, appendRedditSection, defuseAutolinkDomain, parseAlertedRoster, sourceLivenessOf, decideSourceDeadAction, shouldSuppressSourceDeadAlert, pendingSourceDeadKey, PENDING_SOURCE_DEAD_TTL_S, buildSourceDeadEmbed } from './alerts'
import { analyzeIncidentDetailed, analyzeIncidentWithBudget, analyzeWithSonnetDetailed, refreshOrReanalyze, analysisKey, buildAnalysisPrompt, findSimilarIncidents, formatAnalysisEmbedSection, parseAnalysis, putAnalysis, shouldSkipInitialAnalysis, recordUsage, recordHoldEvent, parseUsage, summarizeAiUsageTrend, type AIAnalysisResult, type AnalysisAttempt, type AnalysisFailureKind } from './ai-analysis'
import type { AnthropicOutcome } from './anthropic'
import { kvPut, kvDel, detectComponentMismatches, detectPartialResolves, formatPartialResolveAlert, diffPageComponents, partitionFirstSeen, formatNewComponentAlert, isCacheStale, isAllowedAlertWebhook, countsAsUptimeOk, appendUtm, parseSnapshotWindow } from './utils'
import { restoreArchivedCalendar } from './uptime-archive'
import { buildHistoryRecord, appendIncidentHistoryBatch, readIncidentHistory, predictedVsActualText, resolvedPredictionLine, summarizeAccuracy, type IncidentHistoryRecord, type AccuracyStats } from './incident-history'
import { markIncidentResolved } from './recovery-mark'
import { checkPersistentFetchFailures } from './persistent-failure'
import { parseDetectionEntry, resolveDetectionUpdate, serializeDetectionEntry, getDetectionTimestamp, isProbeEarlier } from './detection'
import { appendAlertFeed, readAlertFeed, buildFeedEntry, kindFromKey, svcIdsForAlert, type AlertFeedEntry } from './alert-feed'
import { buildSupplyChainBanner } from './supply-chain'
import { buildUpstreamLinks } from './upstream-link'
import type { UpstreamCandidate } from './upstream-feed'
import { refreshStatusCacheOnChange, refreshStatusCacheOnLiveEdge } from './cache-refresh'
import { pingIndexNow } from './indexnow'
import { subscribe as subscribeWebhook, confirm as confirmWebhook, updateFilters as updateWebhookFilters, unsubscribe as unsubscribeWebhook, sha256Hex as webhookSha256Hex, deliverToSubscribers, listConfirmedHashes, isValidEncKey, computeSubscriberDelta } from './webhook-subscriptions'
import { corsHeaders, matchOrigin } from './cors'
import { buildStatuslinePayload, isStatuslineRequest, isStatuslinePreset, renderStatuslineBrief, buildStatuslineDownResponse, buildStatuslinePresetResponse, STATUSLINE_BRIEF_UNKNOWN } from './statusline'
import { buildExtClaudePayload, isExtClaudeRequest, EXT_CLAUDE_IDS } from './ext-claude'
import { recordCacheReadOutcome, recordV1Traffic, queryV1Traffic, recordFeedTraffic, queryFeedTraffic, recordBadgeTraffic, queryBadgeTraffic, queryExtTraffic, queryStatuslineTraffic, queryPluginTraffic, countNewFeedItems, computeStatuslineDelta, serializeStatuslineSnapshot } from './api-traffic'
import { EDGE_FALLBACK_ALERT_TTL_S, EDGE_FALLBACK_ALERT_KEY_PREFIX } from './edge-fallback-alert-keys'
import { DEEPSEEK_FEED_KV_KEY, DEEPSEEK_FEED_TTL_S, type FlashdutyFeed, type StoredFlashdutyFeed } from './parsers/flashduty'
import { maybeDispatchDeepseekFeed } from './deepseek-dispatch'
import { isReportableService, hashIp, reportDateKey, reportCountKey, reportSeenKey, extReportCountKey, isExtReportSource, nextCount, REPORT_COUNT_TTL_SECONDS, REPORT_SEEN_TTL_SECONDS, REPORT_MAX_PER_HOUR, formatReportCountsSection, isValidCategory, sanitizeReportDescription, reportFeedKey, appendReportFeed, recentReportFeed, reportWindowFloor, REPORT_FEED_TTL_SECONDS, shouldSurfaceReports, type ReportFeedEntry } from './report'

interface Env {
  ALLOWED_ORIGIN: string
  DISCORD_WEBHOOK_URL?: string
  ANTHROPIC_API_KEY?: string
  // #486: AES-256 key (64 hex chars) encrypting stored per-user webhook URLs. Set via
  // `wrangler secret put WEBHOOK_ENC_KEY`. Absent/invalid → /api/webhook/subscribe fails closed
  // (503), so server-side per-user delivery is simply disabled rather than storing plaintext URLs.
  WEBHOOK_ENC_KEY?: string
  // #486: base origin for the channel-control confirm link (`{base}/confirm?h=…&c=…`). Defaults to
  // the production site when unset; override in worker/.dev.vars (e.g. http://localhost:3333) to run
  // the subscribe→confirm click-through end-to-end against `wrangler dev` + `vercel dev`.
  CONFIRM_BASE_URL?: string
  // #299: operator-only shared secret for POST /api/admin/analyze. Set via
  // `wrangler secret put ADMIN_API_KEY`. Separate from ANTHROPIC_API_KEY so it
  // can be rotated independently; absent secret → endpoint always 401.
  ADMIN_API_KEY?: string
  // #378: shared Bearer token between Vercel Edge Functions and the Worker so
  // POST /api/internal/edge-fallback can be authenticated without exposing the
  // operator Discord webhook URL on the public Edge surface. Set via
  // `wrangler secret put EDGE_ALERT_TOKEN` and the same value as a Vercel env
  // var so both ends agree. Absent secret → endpoint always 401.
  EDGE_ALERT_TOKEN?: string
  // #618: Bearer token for POST /api/internal/deepseek-feed — the GitHub Action scraper that
  // browser-renders status.deepseek.com (bot-walled to a plain Worker fetch) authenticates with
  // this. Set via `wrangler secret put DEEPSEEK_FEED_TOKEN` and the same value as a GH Action
  // secret. Absent secret → endpoint always 401.
  DEEPSEEK_FEED_TOKEN?: string
  // #629: fine-grained GitHub PAT (actions: write on this repo) so the */5 cron can reliably
  // workflow_dispatch the deepseek-feed Action (GitHub's own schedule is throttled to ~2h). Set via
  // `wrangler secret put GH_DISPATCH_TOKEN`. Absent → the worker skips dispatch (GH schedule backup only).
  GH_DISPATCH_TOKEN?: string
  // #1158: classic GitHub PAT (public_repo scope) for the weekly badge-repo-discovery sweep
  // (GitHub Code Search API — which public repos embed an AIWatch badge). Distinct from
  // GH_DISPATCH_TOKEN above (actions:write only, cannot search). Set via
  // `wrangler secret put GH_CODE_SEARCH_TOKEN`. Absent → the section is silently omitted.
  GH_CODE_SEARCH_TOKEN?: string
  // #778: operator phone-push topic for Tier-1-family NEW down/degraded incidents (ntfy.sh). A bare
  // topic name or a full https://ntfy.sh/<topic> URL. Set via `wrangler secret put NTFY_TOPIC`. Absent
  // → push is fail-soft skipped (the Discord operator alert is unaffected). Operator-only side-channel.
  NTFY_TOPIC?: string
  AI?: Ai
  STATUS_CACHE: KVNamespace
  // #494: Workers Analytics Engine dataset for statusline traffic measurement.
  // Optional so local dev (wrangler dev --local) and test environments without the
  // binding continue to work — writeDataPoint is skipped when absent.
  ANALYTICS?: AnalyticsEngineDataset
  // #518: read-back of WAE /api/v1 traffic for the daily report. The Worker can WRITE to WAE
  // but cannot read it from the runtime — the daily cron queries the Analytics Engine SQL API
  // (POST /accounts/{id}/analytics_engine/sql) with these. Both are set as secrets so the
  // account id isn't committed to this public repo: `wrangler secret put CF_ACCOUNT_ID` and
  // `wrangler secret put CF_ANALYTICS_TOKEN` (token scope: Account Analytics Read). Both optional
  // → absent → the daily v1-traffic section is skipped gracefully (queryV1Traffic returns null).
  CF_ACCOUNT_ID?: string
  CF_ANALYTICS_TOKEN?: string
}

// ── KV Cache + Daily Counters ──

const CACHE_TTL_SECONDS = 900 // 15 min — must exceed KV_WRITE_INTERVAL_MS (10 min) to avoid cache gaps
let lastKvWrite = 0
const KV_WRITE_INTERVAL_MS = 600_000 // 10 minutes — 2 writes per interval = ~288/day (cost hygiene on Workers Paid 1M/month inclusion)
let lastArchivedDate = '' // prevent duplicate archival writes within same isolate
let lastKvLimitAlert = 0 // in-memory throttle for KV limit alerts (can't use KV when KV is full)
let lastLatencySlot = '' // prevent duplicate 30-min latency writes within same isolate
const alertProxyRate = new Map<string, { start: number; count: number }>() // rate limit for /api/alert
const deliveryCounter = { discord: 0, failed: 0 } // in-memory counter, flushed to KV by daily summary cron (Discord-only since #467)
const publicApiRate = new Map<string, { start: number; count: number }>() // rate limit for /api/v1/*
// #486: per-IP rate limits for the server-side subscription endpoints. subscribe/update trigger an
// outbound message to (or mutate) an arbitrary channel → 10/hour/IP; confirm is a code check →
// 20/hour/IP (brute-force hardening atop the 10^6 code space + the KV-side global confirm budget).
const webhookSubRate = new Map<string, { start: number; count: number }>()   // /subscribe + /update: 10/hour/IP
const webhookConfirmRate = new Map<string, { start: number; count: number }>() // /confirm: 20/hour/IP
const reportRate = new Map<string, { start: number; count: number }>()         // /api/report-issue: per-IP/hour (#575)
const REPORTABLE_IDS = new Set(SERVICES.map((s) => s.id))                       // #575 — valid report targets

/** #575 Phase B — build the gated `reportFeed` map for /api/status responses: per-service recent
 *  crowd reports, but ONLY for services where an independent signal corroborates (shouldSurfaceReports).
 *  Reads KV feeds only for candidate services (status not operational, or a partial/probe-spike) — a
 *  small bounded set, usually empty — so a public list can never contradict an operational page and
 *  the read cost stays low. Centralizes the gating used by the dashboard (Overview + ServiceDetails). */
async function buildReportFeedMap(kv: KVNamespace, services: ServiceStatus[]): Promise<Record<string, ReportFeedEntry[]>> {
  // #1233 — `!isHealthyStatus`, i.e. "not confirmed healthy", is the intent here and it deliberately
  // KEEPS `unknown` in the candidate set: this only decides whose crowd-report feed is worth READING,
  // and an unreadable source is exactly where independent crowd signal is most useful. Whether those
  // reports are then SHOWN is `shouldSurfaceReports`' call, and that gate now makes an `unknown`
  // service earn it with a probe spike instead of waving it through as an "official problem".
  const candidates = services.filter((s) => !isHealthyStatus(s.status) || (s.partialCount ?? 0) > 0 || s.probeSpike)
  const out: Record<string, ReportFeedEntry[]> = {}
  await Promise.all(candidates.map(async (s) => {
    let feed: ReportFeedEntry[] = []
    try { const raw = await kv.get(reportFeedKey(s.id)); feed = raw ? JSON.parse(raw) : [] } catch (err) { console.warn('[report] feed read failed:', s.id, err instanceof Error ? err.message : err); feed = [] }
    const now = Date.now()
    // #772 — anchor surfaced reports to the CURRENT incident so a prior-incident report retained in
    // the 24h feed doesn't resurface during a new, unrelated incident. Gating reads the FILTERED count.
    const floor = reportWindowFloor(s, now)
    const recent = recentReportFeed(feed, now).filter((e) => e.ts >= floor)
    if (shouldSurfaceReports({ status: s.status, partialCount: s.partialCount, probeSpike: s.probeSpike, reportCount: recent.length })) {
      out[s.id] = recent
    }
  }))
  return out
}
const HOUR_MS = 3_600_000
/** Fixed-window per-IP limiter (in-memory, per-isolate — same mechanism as the existing
 *  alertProxyRate/webhookPingRate counters, just an hour window). Returns true if over the limit.
 *  Fixed-window means up to 2× the limit can pass across a window boundary; acceptable for these
 *  low-frequency endpoints where the KV global confirm budget is the real abuse ceiling. */
function overRateLimit(map: Map<string, { start: number; count: number }>, ip: string, max: number, now: number): boolean {
  const entry = map.get(ip)
  if (entry && entry.count >= max && now - entry.start < HOUR_MS) return true
  if (!entry || now - entry.start >= HOUR_MS) map.set(ip, { start: now, count: 1 })
  else entry.count++
  return false
}

interface DailyCounters {
  [serviceId: string]: {
    ok: number
    total: number
    officialUptime?: number | null
    // #605 — per-component daily uptime accumulation. Same {ok,total} cadence as the service,
    // keyed by component id (+ name for display). Populated from ServiceStatus.components (#604/#606).
    // Rides the existing `daily:{date}` value (+0 KV writes); the monthly archive aggregates it.
    components?: Record<string, { ok: number; total: number; name: string }>
    // #1017 — durable per-day archive input, same +0-writes pattern as `components` above: last-write-
    // wins per cycle (like `officialUptime`), from ServiceStatus.todayWeightedOutageSec. Archived into
    // `history:{date}` (90d) automatically — no new write site. Lets the calendar survive a provider
    // status-page migration by reconstructing a day's classification from this when the live source has
    // forgotten it — see kv-schema.md `daily:{date}` row for the read-side mechanism.
    weightedOutageSec?: number | null
  }
}

/** #605 — accumulate per-component daily uptime into a service's counter entry (mutates `entry`).
 *  Mirrors the per-service ok/total cadence; keyed by component id, with the latest display name.
 *  No-op when the service has no breakdown. The monthly archive aggregates these into per-component
 *  uptime% for the report (component-level reliability rankings). */
export function accumulateComponentCounters(
  entry: DailyCounters[string],
  components: ReadonlyArray<{ id: string; name: string; status: string }> | undefined,
): void {
  if (!components || components.length === 0) return
  const comps = (entry.components ??= {})
  for (const c of components) {
    const cc = (comps[c.id] ??= { ok: 0, total: 0, name: c.name })
    cc.total++
    // Per-component uptime stays a strict operational-only count — deliberately NOT impact-gated
    // like the service-level counter (#733): `Incident.impact` is service-scoped, not per-component,
    // so there's no per-component impact to gate on. Component granularity is its own signal.
    if (c.status === 'operational') cc.ok++
    cc.name = c.name // keep the latest display name (status pages rename components)
  }
}

function todayUTC(): string {
  return new Date().toISOString().split('T')[0]
}

/** #1017 — restore archived calendar days for any service whose live window looks incomplete (a
 *  status-page migration reset it, #1004's disclosed `uptimeWindowDays` signal). Mutates each
 *  service's `dailyImpact` in place. `restoreArchivedCalendar` itself gates on `uptimeWindowDays`
 *  being present, so this pays the extra `history:` reads ONLY for a service actually flagged short —
 *  never on the common full-window path. Per-service try/catch (mirrors `component-seen:`/
 *  `badge:repos:seen`'s same discipline): one service's anomaly must degrade only that service's
 *  calendar for this cycle, never abort the whole batch — an unguarded Promise.all would let one
 *  throw cancel every other service's restore too. Extracted from `cacheWrite` (not inlined) so this
 *  isolation guarantee is directly testable with a mock KV that fails one service, rather than only
 *  provable by a source-scan regex. */
export async function restoreArchivedCalendars(kv: KVNamespace, services: ServiceStatus[], todayISO: string): Promise<void> {
  await Promise.all(services.map(async (s) => {
    try {
      const restored = await restoreArchivedCalendar(kv, {
        serviceId: s.id, liveDailyImpact: s.dailyImpact, calendarDays: s.calendarDays ?? 30, uptimeWindowDays: s.uptimeWindowDays, todayISO,
      })
      if (restored !== s.dailyImpact) s.dailyImpact = restored
    } catch (err) {
      console.error(`[uptime-archive] restore failed for ${s.id} — serving live-only dailyImpact this cycle:`, err instanceof Error ? err.message : err)
    }
  }))
}

// Returns true when this call issued the writes (counters + CACHE_KEY). `false` means this call
// wrote nothing — CACHE_KEY still holds the previous snapshot — which is the half #1057 reads: the
// /api/status handler force-refreshes on a status edge when it sees `false`. (The write itself is
// best-effort — the Promise.all `.catch` below swallows a KV failure — so `true` means "attempted",
// not "guaranteed persisted".)
// #1227 — a fixed roster can never legitimately produce zero services, and persisting one would make
// every read surface fail closed (cacheRead collapses a zero-services snapshot to `null`) until the
// next throttled write. Defence in depth rather than a live hole: `fetchAllServices` pads its results
// to `SERVICES.length` even when a batch throws, so no writer produces an empty array today.
// `cacheWrite` consults this BEFORE the throttle, so refusing costs no write slot.
export function shouldPersistSnapshot(services: ServiceStatus[]): boolean {
  return services.length > 0
}

async function cacheWrite(kv: KVNamespace, services: ServiceStatus[], upstreamFeeds: UpstreamCandidate[], discordUrl?: string): Promise<boolean> {
  if (!shouldPersistSnapshot(services)) {
    console.error('[kv] refusing to write an EMPTY services snapshot to CACHE_KEY')
    return false
  }
  const now = Date.now()
  if (now - lastKvWrite < KV_WRITE_INTERVAL_MS) return false
  lastKvWrite = now

  const today = todayUTC()
  const dailyKey = `daily:${today}`

  // Read today's counters from separate daily key (survives cache TTL expiry)
  let counters: DailyCounters = {}
  try {
    const existing = await kv.get(dailyKey)
    if (existing) counters = JSON.parse(existing)
  } catch (err) { console.warn('[kv] daily counter parse failed:', dailyKey, err instanceof Error ? err.message : err) }

  // Update counters for all services (official sources take priority in response,
  // but counters serve as fallback if official sources fail)
  services.forEach((s) => {
    if (!counters[s.id]) counters[s.id] = { ok: 0, total: 0 }
    counters[s.id].total++
    // #733 — impact-gated: a `degraded` snapshot only counts as down when a major/critical
    // unresolved incident backs it; a minor/partial-scope or no-incident degraded counts as up
    // (mirrors official rolling-uptime weighting — prevents a sticky minor incident from cratering
    // uptime/Stability/Score while the status page reads ~100%).
    //
    // #1233 — an unreadable poll still books an `ok` sample here, and that is DELIBERATELY UNCHANGED.
    // The honest treatment is a third outcome (record no sample at all — the poll observed nothing),
    // and it was implemented and then reverted during this change's review: making `total === 0`
    // reachable turned out to be unsafe: the three consumers of this counter DISAGREE about what a
    // zero-sample service means. `computeMonthlyUptime` publishes **0%** into the permanent monthly
    // archive, `computeUptime` (the live `/api/uptime` path) answers **100%**, and
    // `computeMonthlyComponentUptime` correctly DROPS the row — with a comment naming the first one as
    // the asymmetry it is avoiding. Of those, 0% is the one that ships: it prints a provider whose page
    // we never read as that month's worst performer, moving the fabrication from silence to a public
    // accusation. Correcting this properly means making those three agree on a "no data" path first,
    // which is its own change. Tracked as a follow-up.
    if (countsAsUptimeOk(s.status, s.incidents)) counters[s.id].ok++
    // #586 — snapshot the live status-page rolling-30d uptime each cycle (last-write-wins = the
    // day's most-recent value). The monthly archive reads the month-end day's value as the
    // "Official Uptime" display number, so it stays month-accurate and survives a later rebuild
    // (unlike a one-shot snapshot taken only at build time).
    counters[s.id].officialUptime = s.uptime30d ?? null
    // #1017 — same last-write-wins cadence as officialUptime above: today's weighted outage seconds,
    // the durable per-day archive input (rides the SAME daily:{date} write — +0 new KV writes).
    counters[s.id].weightedOutageSec = s.todayWeightedOutageSec ?? null
    // #605 — accumulate per-component uptime (same cadence) for services with a breakdown.
    accumulateComponentCounters(counters[s.id], s.components)
  })

  // #1017 — restored BEFORE CACHE_KEY is serialized below, so every reader of the live snapshot
  // (frontend calendar, is-down SSR) sees the restored days with no changes on their end. See
  // restoreArchivedCalendars's own doc for the per-service isolation guarantee.
  await restoreArchivedCalendars(kv, services, today)

  // Write cache + daily counters (2 writes per interval). The CACHE_KEY snapshot shape
  // ({ services, upstreamFeeds, cachedAt }) MUST match cache-refresh.ts `writeStatusCache` (the #488/#1057 primitive);
  // it stays inline here (not routed through writeStatusCache) only so the KV-limit-exceeded alert can
  // hang off this shared Promise.all `.catch` — kvPut swallows internally and would hide the limit.
  await Promise.all([
    kv.put(CACHE_KEY, JSON.stringify({
      services,
      upstreamFeeds,
      cachedAt: new Date().toISOString(),
    }), { expirationTtl: CACHE_TTL_SECONDS }),
    kv.put(dailyKey, JSON.stringify(counters), {
      expirationTtl: 2 * 86400, // 2 days — enough to survive overnight low traffic
    }),
  ]).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[kv] cache write failed:', msg)
    // Alert on KV limit exceeded — use in-memory throttle (1h) since KV dedup won't work
    const alertNow = Date.now()
    if (msg.includes('limit exceeded') && alertNow - lastKvLimitAlert > 3_600_000) {
      lastKvLimitAlert = alertNow
      if (discordUrl) {
        await sendDiscordAlert(discordUrl, {
          title: '⚠️ KV Write Limit Exceeded',
          description: 'Cloudflare KV 무료 플랜 일일 쓰기 한도(1,000회) 초과.\n배지, API v1, 캐시가 작동하지 않습니다.\nUTC 자정(KST 09:00)에 자동 리셋됩니다.',
          color: 0xFF9800,
        }).catch((err) => console.warn('[kv] KV limit alert discord failed:', err instanceof Error ? err.message : err))
      }
    }
  })

  // Archive yesterday's counters to permanent history (once per day per isolate)
  const yesterday = new Date(now - 86_400_000).toISOString().split('T')[0]
  if (lastArchivedDate !== yesterday) {
    const yesterdayKey = `daily:${yesterday}`
    const yesterdayData = await kv.get(yesterdayKey).catch(() => null)
    if (yesterdayData) {
      await kvPut(kv, `history:${yesterday}`, yesterdayData, { expirationTtl: 90 * 86400 })
      lastArchivedDate = yesterday
    }
  }

  return true
}

// In-memory throttle for the #1256 latency skip, mirroring `lastKvLimitAlert`: this writer runs
// once per inbound request, so an unthrottled skip log scales with traffic, not with the fault.
let lastLatencyWindowWarn = 0
const LATENCY_WINDOW_WARN_INTERVAL_MS = 600_000 // 10 min
function warnLatencyWindow(what: string, detail: string): void {
  const now = Date.now()
  if (now - lastLatencyWindowWarn < LATENCY_WINDOW_WARN_INTERVAL_MS) return
  lastLatencyWindowWarn = now
  console.warn(`[kv] latency ${what}:`, detail)
}

// 30-min latency snapshot — independent of cacheWrite throttle (+48 writes/day)
// Exported for the same reason as writeProbeSnapshot — only the wiring shows that an unreadable
// window never reaches the kv.put below.
export async function writeLatencySnapshot(kv: KVNamespace, services: ServiceStatus[]): Promise<void> {
  const now = new Date()
  const currentSlot = `${now.toISOString().slice(0, 14)}${now.getUTCMinutes() < 30 ? '00' : '30'}` // "2026-03-22T03:00" or "2026-03-22T03:30"
  if (lastLatencySlot === currentSlot) return

  const latencyData: Record<string, number> = {}
  services.forEach((s) => { if (s.latency != null) latencyData[s.id] = s.latency })
  // Writing an empty payload would claim the slot, and the dedup below then rejects the healthy
  // poll seconds later, leaving the 30 minutes blank. Recorded rather than skipped silently: no
  // service measured is a statement about our own polling, not about the providers.
  if (Object.keys(latencyData).length === 0) {
    warnLatencyWindow('measured nothing', `${services.length} services, zero latencies — skipping the slot`)
    return
  }

  try {
    const LATENCY_KEY = 'latency:24h'
    const MAX_SNAPSHOTS = 48 // 24h × 2 per hour
    // Fail CLOSED on an unreadable window (#1256) — same defect, same shape as writeProbeSnapshot
    // below: the kv.put replaces the WHOLE value, so a window we could not read must not be
    // treated as "no history". The read failure here was silent as well.
    //
    // The skip deliberately does not set `lastLatencySlot` — a retry inside the slot must stay
    // possible.
    let readFailed = false
    const existing = await kv.get(LATENCY_KEY).catch((err) => {
      readFailed = true
      warnLatencyWindow('read failed', err instanceof Error ? err.message : String(err))
      return null
    })
    if (readFailed) return
    const snapshots = parseSnapshotWindow<{ t: string; data: Record<string, number> }>(existing)
    if (snapshots === null) {
      warnLatencyWindow('stored window is unreadable', 'skipping the write so it is not overwritten')
      return
    }
    // Deduplicate: skip if this slot already exists (another isolate wrote it)
    const slotTs = `${currentSlot}:00Z`
    if (snapshots.some((s: { t: string }) => s.t === slotTs)) { lastLatencySlot = currentSlot; return }
    snapshots.push({ t: slotTs, data: latencyData })
    const trimmed = snapshots.slice(-MAX_SNAPSHOTS)
    await kv.put(LATENCY_KEY, JSON.stringify({ snapshots: trimmed }), {
      expirationTtl: 90000, // 25 hours
    })
    lastLatencySlot = currentSlot // set after successful write
  } catch (err) {
    console.warn('[kv] latency snapshot write rejected:', err instanceof Error ? err.message : err)
  }
}

// ── Health Check Probing (Phase 2 PoC) ──
import { type ProbeResult, type ProbeSnapshot, type ProbeSpike, PROBE_TARGETS, PROBE_INHERIT, resolveProbeId, computeProbeSlot, slotToTimestamp, trimSnapshots, hasSlot, failedProbe, detectConsecutiveSpikes } from './probe'

const PROBED_SERVICE_IDS = new Set(PROBE_TARGETS.map((t) => t.id))

// summaries is required (not optional) — every caller must explicitly pass either the cached map
// or `undefined` (signalling KV-degraded → 'unavailable'). Forgotten args would silently classify
// every probed service as 'unavailable' (no responsiveness scoring) — same footgun the union was
// meant to prevent. Callers: 4 fetch handlers + 1 cron, each constructs its own summaries via readProbeSummaries.
// Exported for direct testing of the #883 inheritance wiring (the resolveProbeId → classifyProbe line
// below is the feature's single point of failure; a mirror test in score.test.ts wouldn't catch a
// regression HERE). Same rationale as the exported readProbeSummaries.
export function scoreFor(svc: ServiceStatus, summaries: Map<string, ProbeSummary> | undefined) {
  // #883 — an inheriting service (Claude Code/Codex) is classified against its parent's probe id, so
  // its Responsiveness comes from the parent's already-measured endpoint instead of the probe-less
  // rescale. resolveProbeId is identity for everyone else (incl. the directly-probed cursor).
  const probeId = resolveProbeId(svc.id)
  return calculateAIWatchScore(svc, 30, classifyProbe(probeId, PROBED_SERVICE_IDS.has(probeId), summaries))
}

// Read probe summaries from KV with logging — distinguishes infra failure from genuine missing data.
// Exported for direct testing of the catch behavior — the .catch is the load-bearing translation
// from KV-degraded throws to undefined, which classifyProbe maps to 'unavailable' (no penalty).
export async function readProbeSummaries(kv: KVNamespace, callsite: string): Promise<Map<string, ProbeSummary> | undefined> {
  return getCachedProbeSummaries(kv).catch((err) => {
    console.warn(`[${callsite}] probe summary read failed:`, err instanceof Error ? err.message : err)
    return undefined
  })
}

let lastProbeSlot = ''
let lastProbeSummaryCacheSlot = ''

// Exported for direct testing of the #1256 fail-closed guard — only the wiring shows that an
// unreadable window never reaches the kv.put below.
export async function writeProbeSnapshot(kv: KVNamespace): Promise<void> {
  const currentSlot = computeProbeSlot(new Date())
  if (lastProbeSlot === currentSlot) return

  // Fail CLOSED on an unreadable window (#1256): the kv.put below replaces the WHOLE value, so a
  // window we could not read must not be treated as "no history". Read before probing so a skipped
  // cycle spends no outbound requests on results it will discard. `console.error`, not warn: a
  // stalled window silently degrades the Responsiveness component of every probed Score — see
  // `classifyProbe`. Clearing a value that stays unreadable is manual.
  const PROBE_KEY = 'probe:24h' // key name kept for backwards compat; actual retention is 7d
  const MAX_SNAPSHOTS = 2016 // 7d × 12 per hour (every 5 min)
  let readFailed = false
  const existing = await kv.get(PROBE_KEY).catch((err) => {
    readFailed = true
    console.error('[probe] KV read failed — skipping this slot:', err instanceof Error ? err.message : err)
    return null
  })
  if (readFailed) return
  const snapshots = parseSnapshotWindow<ProbeSnapshot>(existing)
  if (snapshots === null) {
    console.error('[probe] stored window is unreadable — skipping the write so it is not overwritten')
    return
  }

  const data: Record<string, ProbeResult> = {}
  await Promise.all(PROBE_TARGETS.map(async ({ id, url }) => {
    try {
      const start = Date.now()
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'ai-watch.dev-monitoring (contact@ai-watch.dev)' },
        signal: AbortSignal.timeout(5000),
      })
      data[id] = { status: res.status, rtt: Date.now() - start }
      res.body?.cancel()
    } catch (err) {
      console.warn(`[probe] fetch failed for ${id}:`, err instanceof Error ? err.message : err)
      data[id] = failedProbe()
    }
  }))

  try {
    const slotTs = slotToTimestamp(currentSlot)
    if (hasSlot(snapshots, slotTs)) { lastProbeSlot = currentSlot; return }
    snapshots.push({ t: slotTs, data })
    const trimmed = trimSnapshots(snapshots, MAX_SNAPSHOTS)
    await kv.put(PROBE_KEY, JSON.stringify({ snapshots: trimmed }), {
      expirationTtl: 604800, // 7 days
    })
    lastProbeSlot = currentSlot
  } catch (err) {
    // Reached only by the append/put itself now that the read and parse are guarded above, so this
    // no longer conflates "the stored window is corrupt" with "KV rejected the write".
    console.warn('[probe] snapshot write rejected:', err instanceof Error ? err.message : err)
  }
}

// `upstreamFeeds` is OPTIONAL on read while REQUIRED on write (#1072) — deliberately asymmetric, and
// the asymmetry is not laziness. A snapshot written by the currently-deployed worker predates this
// key, and the worker deploy is manual + batched (CLAUDE.md), so for hours after merge every read hits
// a feed-less snapshot. Modelling it as required would be a type that lies about the bytes in KV.
// Absence means "no feeds known" → the link stays quiet, which is the correct fail-closed answer.
// #1227 — the reader is where "we have no usable snapshot" is decided, ONCE, for all ~11 callers.
//
// It returns `null` for every such state, including a snapshot that parses but carries zero
// services. That last case is the important one: AIWatch monitors a fixed roster, so zero services
// is never a legitimate answer, only a missing one — and every downstream surface renders it
// identically to a miss (an empty down-list, a green statusline, an empty `/api/v1/status`).
// Returning it as a truthy snapshot would have required each caller to remember a second guard,
// which is precisely the caller-discipline this bug is an instance of. One `!cached` at the call
// site covers every such state; they remain distinguishable in WAE, where the diagnosis needs them,
// rather than in a return type nobody checks twice.
//
// `kv` is accepted as possibly-absent so the BINDING check lives here too — an absent binding is a
// config fault with the widest blast radius (a renamed or unprovisioned namespace), and it needs to
// reach the same log and the same WAE index as every other unusable-snapshot state.
//
// `analytics` is REQUIRED rather than optional so a new call site cannot omit it by accident. That
// buys the enumeration once, at this signature change; it does not stop a future caller passing
// `undefined`, which is why a source scan pins the call sites instead.
async function cacheRead(
  kv: KVNamespace | undefined,
  analytics: AnalyticsEngineDataset | undefined,
): Promise<{ services: ServiceStatus[]; upstreamFeeds?: UpstreamCandidate[]; cachedAt: string } | null> {
  if (!kv) {
    console.error('[kv] STATUS_CACHE binding is ABSENT — no snapshot can be read')
    recordCacheReadOutcome(analytics, 'no-binding')
    return null
  }
  let raw: string | null
  try {
    raw = await kv.get(CACHE_KEY)
  } catch (err) {
    console.error('[kv] CACHE_KEY read FAILED:', err instanceof Error ? err.message : err)
    recordCacheReadOutcome(analytics, 'threw')
    return null
  }
  if (!raw) {
    // Severity is deliberately below the others: the key can expire legitimately (TTL 900s, and the
    // only unconditional writer is the traffic-throttled /api/status handler), so a quiet period can
    // produce this. How OFTEN is unmeasured — the `cache-read` index exists to answer that, and the
    // answer decides whether this stays a warn or the cron starts re-seeding the key.
    console.warn('[kv] CACHE_KEY read returned NO VALUE — the key is absent or expired')
    recordCacheReadOutcome(analytics, 'miss')
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error('[kv] CACHE_KEY parse failed:', err instanceof Error ? err.message : err)
    recordCacheReadOutcome(analytics, 'unparsed')
    return null
  }
  // `JSON.parse` succeeds on `null`, `42`, `"str"` and `[]` — none of which is a snapshot. Without
  // this check a scalar would escape as a truthy "snapshot" and the first `cached.services.find(…)`
  // downstream would throw a TypeError (a 500), not degrade.
  const snapshot = parsed as { services?: unknown; upstreamFeeds?: UpstreamCandidate[]; cachedAt: string } | null
  if (typeof snapshot !== 'object' || snapshot === null || !Array.isArray(snapshot.services)) {
    console.error('[kv] CACHE_KEY parsed to a non-snapshot shape (no services array)')
    recordCacheReadOutcome(analytics, 'unparsed')
    return null
  }
  if (snapshot.services.length === 0) {
    console.error('[kv] CACHE_KEY holds ZERO services — a written-but-empty snapshot')
    recordCacheReadOutcome(analytics, 'empty')
    return null
  }
  // #1233 — the one point a stored payload re-enters the worker, so it is where the transitional decode
  // belongs: a snapshot written by the PREVIOUS deploy encodes an unreadable source as `degraded` +
  // `sourceUnknown`, and every consumer downstream of here (badge, statusline, down-list, ext-claude,
  // daily summary) now reads `degraded` as a real outage. Without this, the rollout window republishes
  // the exact defect this change removes. A no-op on any payload the current worker wrote.
  const normalized = snapshot as { services: ServiceStatus[]; upstreamFeeds?: UpstreamCandidate[]; cachedAt: string }
  return { ...normalized, services: normalizeCachedServices(normalized.services) }
}

// Read uptime history for last N days (includes today's live counter + archived days)
export async function readUptimeHistory(kv: KVNamespace, days: number): Promise<Record<string, DailyCounters>> {
  const history: Record<string, DailyCounters> = {}
  const today = new Date()
  const todayStr = todayUTC()

  // Build key list: today uses daily: prefix, past days use history: prefix
  const keyPairs = Array.from({ length: days }, (_, i) => {
    const dateStr = new Date(today.getTime() - i * 86_400_000).toISOString().split('T')[0]
    const key = dateStr === todayStr ? `daily:${dateStr}` : `history:${dateStr}`
    return { dateStr, key }
  })

  const results = await Promise.all(keyPairs.map(({ key }) => kv.get(key).catch(() => null)))
  results.forEach((raw, i) => {
    if (raw) {
      try { history[keyPairs[i].dateStr] = JSON.parse(raw) } catch (err) { console.warn('[kv] uptime history parse failed:', keyPairs[i].dateStr, err instanceof Error ? err.message : err) }
    }
  })
  return history
}

// Read probe RTT daily history for last N days
export async function readProbeHistory(kv: KVNamespace, days: number): Promise<Record<string, ProbeDailyData>> {
  const history: Record<string, ProbeDailyData> = {}
  const today = new Date()
  const keyPairs = Array.from({ length: days }, (_, i) => {
    const dateStr = new Date(today.getTime() - i * 86_400_000).toISOString().split('T')[0]
    return { dateStr, key: `probe:daily:${dateStr}` }
  })

  const results = await Promise.all(keyPairs.map(({ key }) => kv.get(key).catch(() => null)))
  results.forEach((raw, i) => {
    if (raw) {
      try { history[keyPairs[i].dateStr] = JSON.parse(raw) } catch (err) { console.warn('[kv] probe history parse failed:', keyPairs[i].dateStr, err instanceof Error ? err.message : err) }
    }
  })
  return history
}

// Calculate per-service uptime% from accumulated daily counters
function computeUptime(history: Record<string, DailyCounters>): Record<string, number> {
  const totals: Record<string, { ok: number; total: number }> = {}
  for (const counters of Object.values(history)) {
    for (const [id, { ok, total }] of Object.entries(counters)) {
      if (!totals[id]) totals[id] = { ok: 0, total: 0 }
      totals[id].ok += ok
      totals[id].total += total
    }
  }
  const result: Record<string, number> = {}
  for (const [id, { ok, total }] of Object.entries(totals)) {
    result[id] = total > 0 ? Math.round((ok / total) * 10000) / 100 : 100
  }
  return result
}

import { sanitize } from './utils'

// ── Discord Webhook Alerts (Cron-based, no isolate concurrency) ──

async function sendDiscordAlert(webhookUrl: string, embed: { title: string; description: string; color: number }): Promise<boolean> {
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          ...embed,
          timestamp: new Date().toISOString(),
          footer: { text: 'AIWatch Worker' },
        }],
      }),
    })
    if (!resp.ok) {
      console.error(`[discord] webhook returned ${resp.status}: ${await resp.text().catch(() => '')}`)
      return false
    }
    resp.body?.cancel()
    return true
  } catch (err) {
    console.error('[discord] webhook failed:', err instanceof Error ? err.message : err)
    return false
  }
}

// #936 — send a PLAIN-TEXT operator message (no embed). Used for the mobile-copyable tweet-reply
// draft: a ``` code block inside an embed only gets Discord's one-click Copy button on DESKTOP, and
// mobile long-press copies the whole embed (useless). A standalone plain message lets mobile "Copy
// Text" grab exactly the reply, clean for pasting into a tweet. `flags: 4` = SUPPRESS_EMBEDS so the
// is-down link in the reply doesn't unfurl a card under the copyable text. Operator channel only.
async function sendDiscordMessage(webhookUrl: string, content: string): Promise<boolean> {
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, flags: 4 }),
    })
    if (!resp.ok) {
      console.error(`[discord] reply message returned ${resp.status}: ${await resp.text().catch(() => '')}`)
      return false
    }
    resp.body?.cancel()
    return true
  } catch (err) {
    console.error('[discord] reply message failed:', err instanceof Error ? err.message : err)
    return false
  }
}

// #778 — operator phone push for a Tier-1-family NEW down/degraded incident (ntfy.sh). The `Click`
// header makes tapping the notification open the X "is {service} down" Top search directly → the
// operator replies to the viral tweet within the short window. Fail-soft: no NTFY_TOPIC secret → skip
// (returns false, Discord alert already sent). ntfy headers must be ASCII (latin-1), so the title/body
// carry no emoji — the Click URL is the payload. Mirrors sendDiscordAlert's boolean retry semantics.
async function sendPushAlert(env: Env, title: string, body: string, clickUrl: string): Promise<boolean> {
  const topic = env.NTFY_TOPIC
  if (!topic) return false // push disabled
  const url = topic.startsWith('http') ? topic : `https://ntfy.sh/${topic}`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Title: title, Priority: 'urgent', Tags: 'rotating_light', Click: clickUrl },
      body,
    })
    if (!resp.ok) {
      console.error(`[push] ntfy returned ${resp.status}: ${await resp.text().catch(() => '')}`)
      return false
    }
    resp.body?.cancel()
    return true
  } catch (err) {
    console.error('[push] ntfy failed (Discord alert unaffected):', err instanceof Error ? err.message : err)
    return false
  }
}

async function alertWorkerError(env: Env, error: string) {
  if (!env.DISCORD_WEBHOOK_URL || !env.STATUS_CACHE) return
  const key = 'alerted:worker-error'
  const existing = await env.STATUS_CACHE.get(key).catch(() => null)
  if (existing) return
  await kvPut(env.STATUS_CACHE, key, '1', { expirationTtl: 300 }) // 5min cooldown
  await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
    title: '🔴 Worker Error — API 장애',
    description: `\`fetchAllServices()\` 전체 실패\n\`\`\`${sanitize(error)}\`\`\``,
    color: 0xED4245,
  })
}

// Dedup marker is written only after the Discord send returns true. A 5xx / network
// failure on the 00:00 cycle leaves the marker unset so the 01:00 catch-up cycle retries.
// Corrupt archive JSON bails without sending so operators don't get a misleading
// "Services: 0" ping that also locks out retries for 60 days.
async function maybeNotifyArchiveReady(env: Env, archiveKey: string, period: string): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL || !env.STATUS_CACHE) return
  const notifiedKey = archiveNotifiedKey(period)
  const already = await env.STATUS_CACHE.get(notifiedKey).catch(() => null)
  if (already) return

  const archiveRaw = await env.STATUS_CACHE.get(archiveKey).catch(() => null)
  if (!archiveRaw) return // archive not yet written this cycle; catch-up or next month handles it

  let serviceCount: number
  let daysCollected: number
  try {
    const parsed = JSON.parse(archiveRaw)
    serviceCount = Object.keys(parsed.services ?? {}).length
    daysCollected = typeof parsed.daysCollected === 'number' ? parsed.daysCollected : 0
  } catch (err) {
    console.error(`[monthly-archive] corrupt archive JSON for ${period} — skipping notification:`, err instanceof Error ? err.message : err)
    return
  }

  const sent = await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, buildArchiveReadyEmbed(period, serviceCount, daysCollected))
  if (!sent) {
    console.warn(`[monthly-archive] notification send failed for ${period} — will retry next cron cycle`)
    return
  }
  // 60d TTL — purely for dedup (the archive itself is permanent). Any TTL ≥ 2h would
  // cover the catch-up window; 60d matches the surrounding monthly-ops retention feel.
  await kvPut(env.STATUS_CACHE, notifiedKey, '1', { expirationTtl: 60 * 24 * 60 * 60 })
}

// ── Cron-based Alert Detection ──
// Runs every 5 minutes via Cron Trigger (single execution, no concurrency).
// Uses KV dedup by incident/service ID (7-day TTL) instead of state comparison.

interface CronResult {
  total: number
  operational: number
  issues: number
  /** #1233 — services whose status source could not be read this cycle. Its own field because it is
   *  neither `operational` nor an `issue`; before the split it was folded into `issues` by subtraction. */
  unreadable: number
  sent: number
  newCount: number
  resolvedCount: number
  downCount: number
  recoveredCount: number
}

// `scheduledTimeMs` is `event.scheduledTime`, not wall clock: time-of-day slot checks (e.g. the
// #1153 hourly roster-key refresh, `getUTCMinutes() < 5`) must stay accurate even when this function
// takes 60+ seconds, otherwise a slow tick skips its slot for the whole hour. Defaults to `Date.now()`
// for the rare direct caller / test. (Same convention `scheduled()` states for its own `scheduledNow`.)
async function cronAlertCheck(env: Env, scheduledTimeMs: number = Date.now()): Promise<CronResult> {
  const empty: CronResult = { total: 0, operational: 0, issues: 0, unreadable: 0, sent: 0, newCount: 0, resolvedCount: 0, downCount: 0, recoveredCount: 0 }
  if (!env.DISCORD_WEBHOOK_URL || !env.STATUS_CACHE) return empty

  // Read cached service data — fetch live if cache is stale or missing
  const raw = await env.STATUS_CACHE.get(CACHE_KEY).catch(() => null)
  const STALE_THRESHOLD_MS = 10 * 60 * 1000
  const { stale, services: cachedServices, upstreamFeeds: cachedFeeds } = isCacheStale(raw, STALE_THRESHOLD_MS)
  // #1233 — this path reads CACHE_KEY directly rather than through `cacheRead`, so it needs its own
  // transitional decode. It is the one that matters most: on a fresh cache (<10 min) the entire alert
  // pipeline runs on this array, so a snapshot written by the PREVIOUS deploy — where an unreadable
  // source is `degraded` + `sourceUnknown` — would fire a real 🟠 Discord alert for a Tier-1 service and
  // arm `alerted:degraded:`. Once the payload rolls over to `unknown` the degraded arm stops re-firing
  // and the recovery arm needs a genuine `operational` read, so that alert never gets its 🟢 and the
  // operator is left believing an outage that never existed. `refreshStatusCacheOnChange` below also
  // writes this array back with a fresh `cachedAt`, which would extend the legacy encoding past its TTL.
  let services = normalizeCachedServices(cachedServices as ServiceStatus[])
  // #1072 — mirrors `services` exactly: the cached snapshot's feeds, replaced by fresh ones only when
  // this cycle actually live-fetched. The #488 refresh below rewrites the snapshot, so carrying the
  // cached value forward is what stops a fresh-cache cron from erasing the feeds.
  let upstreamFeeds = cachedFeeds as UpstreamCandidate[]

  // If cache is stale (>10min) or empty, fetch live data to avoid alert decisions on outdated status.
  // Does NOT write to KV — cache writes are handled exclusively by /api/status handler's cacheWrite()
  // so the 10-min KV write throttle keeps us well inside the Workers Paid 1M writes/month inclusion.
  let cronProbes: ProbeSnapshot[] = []
  // #992 — per-page raw components from the live fetch, for the new-component detector below. Only
  // populated on a stale-triggered live fetch (a fresh-cache cycle skips detection — it runs next cycle).
  let cronPageComponents: Record<string, Array<{ id: string; name: string }>> = {}
  if (stale) {
    try {
      // Read probe data for cross-validation of status page failures
      const probeRaw = await env.STATUS_CACHE.get('probe:24h').catch(() => null)
      if (probeRaw) {
        try { cronProbes = JSON.parse(probeRaw).snapshots ?? [] } catch (err) { console.warn('[cron] probe24h parse failed:', err instanceof Error ? err.message : err) }
      }
      const { raw: freshServices, pageComponents, upstreamFeeds: freshFeeds } = await fetchAllServices(env.STATUS_CACHE, cronProbes)
      if (freshServices.length > 0) {
        services = freshServices
        // Adopted only alongside a usable service list, so `services` and `upstreamFeeds` always come
        // from the SAME cycle. A mixed snapshot (fresh feeds beside stale services) would let the
        // upstream gate reason about two different moments in time.
        upstreamFeeds = freshFeeds
      }
      cronPageComponents = pageComponents
    } catch (err) {
      console.error('[cron] live fetch failed, using stale cache:', err instanceof Error ? err.message : err)
      // Fall through with whatever we have (stale data better than nothing for alerts)
    }
  }
  if (services.length === 0) return empty

  // Service count drop detection (#221) — alert when significantly fewer services than expected
  const { dropped, missing } = detectServiceCountDrop(services.map(s => s.id), SERVICES)
  if (dropped) {
    const dropKey = 'alerted:service-drop'
    const alreadyAlerted = await env.STATUS_CACHE.get(dropKey).catch(() => null)
    if (!alreadyAlerted) {
      try {
        await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
          title: `⚠️ Service Count Drop: ${services.length}/${SERVICES.length}`,
          description: `Only ${services.length} of ${SERVICES.length} services returned.\n\n**Missing (${missing.length}):** ${missing.join(', ')}`,
          color: 0xFF6600,
        })
      } catch (err) {
        console.error('[cron] service count drop alert failed:', err instanceof Error ? err.message : err)
      }
      await kvPut(env.STATUS_CACHE, dropKey, '1', { expirationTtl: 7200 }) // 2h dedup
    }
  } else {
    // Recovery: clear dedup key only if it exists (avoid unnecessary KV writes)
    const existing = await env.STATUS_CACHE.get('alerted:service-drop').catch(() => null)
    if (existing) await kvDel(env.STATUS_CACHE, 'alerted:service-drop')
  }

  // Calculate scores for fallback recommendations
  const cronProbeSummaries = await readProbeSummaries(env.STATUS_CACHE, 'cron')
  const scored = services.map((svc) => {
    const s = scoreFor(svc, cronProbeSummaries)
    return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade, scoreConfidence: s.confidence }
  })

  // #587 — accumulate this cycle's incidents into incidents:monthly every */5 (not just the daily
  // summary), so a short-lived / RSS-sourced incident (Azure/Bedrock) that fires an alert is
  // captured before it ages out of the upstream feed — previously the once-a-day pass missed those,
  // leaving the dashboard 90-day filter + monthly archive blind to an incident AIWatch alerted on.
  // Writes only when the incident data changed (idempotent dedup-by-id), so it's budget-safe.
  try {
    await accumulateIncidentsOnlyIfChanged(env.STATUS_CACHE, services, todayUTC().slice(0, 7))
  } catch (err) {
    console.error('[cron] incident accumulation failed:', err instanceof Error ? err.message : err)
  }

  // Mistral-only probe cross-validation removed in #373 — same-title incident grouping
  // (src/utils/incidentGrouping.js) now handles auto-monitoring noise uniformly across services.

  // Collect previously alerted IDs from KV for dedup context.
  // #545: `alerted:new:{incId}` now stores the JSON array of service ids already alerted for that
  // incident (was the boolean '1'). Read it into incId → Set<svcId> so buildIncidentAlerts can
  // alert a service that JOINS an already-alerted incident later (e.g. ChatGPT joining a Codex
  // incident after OpenAI renamed the title). Legacy '1' values auto-migrate: seed the set with
  // whatever services currently carry the incident (the read loop visits each), which reproduces
  // the old "whole incident already alerted" behavior → no re-alert storm on deploy.
  const alertedNewMap = new Map<string, Set<string>>()
  const alertedDownMap = new Map<string, string>()
  const alertedDegradedMap = new Map<string, string>()
  // #283: flap suppression state.
  // - suppressedIncIds: incidents whose same-titled prior flap already fired its res alert
  //   within the past 60min → buildIncidentAlerts drops both new and res paths.
  // - flapKeysToWrite: incidents eligible for flap suppression but no active window yet;
  //   post-send writes the flap key on the res alert to start the window for the NEXT flap.
  const suppressedIncIds = new Set<string>()
  const flapKeysToWrite = new Map<string, string>()
  // #633/#835 — first-seen confirmation gate. A flap-shaped/short NEW incident on a monitor-flap or
  // short-incident-hold service is HELD until it has survived ~2 cron cycles (FLAP_HOLD_MS, #835 — was
  // one cycle), so a sub-~10min blip fires NEITHER a phantom New nor a Resolved (the Modal "Storage
  // degraded" 1m double-alert). heldNewIncIds is passed to refreshOrReanalyze (analysis deferred too);
  // suppressedIncIds is what buildIncidentAlerts skips on. pendingNewToWrite stamps the
  // pending:new marker with the first-seen ts so a LATER cycle confirms + fires once the window passes.
  const heldNewIncIds = new Set<string>()
  const pendingNewToWrite = new Map<string, number>()  // incId → first-seen epoch ms (#835, write-once)
  // #1224 — ONE line per cron run, never per incident. Without it the gate is unfalsifiable in
  // production: a skipped read and a missing key are the same `null`, so the saving could only be
  // inferred from the KV dashboard. Counted in (service, incident) PAIRS, which is what the loop
  // iterates. The two error counters are separate because their consequences are: a failed roster read
  // makes the #545 dedup bypass re-emit a 🔴 New alert every 5 min (and for a resolved incident drops
  // its Resolved notice), while a failed pending read only fails open to "no hold".
  let rosterReads = 0
  let rosterSkips = 0
  let pendingReads = 0
  let flapReads = 0
  let rosterReadErrors = 0
  let pendingReadErrors = 0
  // #1224 — ONE clock for the age gate and for `buildIncidentAlerts`. The gate is safe only while it
  // skips no more than the build does; sharing the clock makes that hold BY CONSTRUCTION instead of by
  // program order, so no later refactor can put the build on an earlier clock and leave the gate
  // skipping incidents the build still emits for. The per-incident `nowMs` below stays as it is — the
  // flap escape and the hold window are a different invariant (#983).
  const runNowMs = Date.now()
  for (const svc of scored) {
    const config = SERVICES.find(c => c.id === svc.id)
    for (const inc of svc.incidents ?? []) {
      // One clock per incident: the flap-escape (#983) and the first-seen hold window (#835) must
      // agree on "now", and re-reading Date.now() between them would let them disagree by ms.
      const nowMs = Date.now()
      // #1224 — this loop ran a KV read per marker for every incident-service pair /api/status carries,
      // on every */5 run, while `buildIncidentAlerts` drops everything older than
      // INCIDENT_ALERT_MAX_AGE_MS from BOTH its branches. Past that bound nothing computed below can
      // reach an alert, so all three reads and the hold are skipped together — gated on the same
      // constant the build uses, so the two cannot drift apart. `markerReadPlan` is the one place that
      // decision is made, and it is DESTRUCTURED so neither flag can be reassigned further down.
      const { alertable, readPending } = markerReadPlan(inc, runNowMs)
      if (alertable) rosterReads++
      else rosterSkips++
      // A read ERROR is not a skip: it means `alertedNewMap` misses an incident that WAS alerted, and
      // the #545 dedup bypass below re-emits its 🔴 New alert every 5 min until a read succeeds. The
      // sibling pending:new read has always logged this; staying silent here made the one consequential
      // failure on the New-alert dedup path indistinguishable from an ordinary miss (#970 forensics).
      const wasAlerted = alertable
        ? await env.STATUS_CACHE.get(`alerted:new:${inc.id}`).catch((err) => {
          // Capped: the fail-open on an undateable startedAt means a parser regression can push every
          // incident back onto this path. Past the cap the run's accounting line carries the rest.
          if (++rosterReadErrors <= 5) console.warn('[cron] #545 alerted:new read failed — incident may re-alert this cycle:', inc.id, err instanceof Error ? err.message : err)
          return null
        })
        : null
      if (wasAlerted) {
        let set = alertedNewMap.get(inc.id)
        if (!set) { set = new Set<string>(); alertedNewMap.set(inc.id, set) }
        const { ids, corrupt } = parseAlertedRoster(wasAlerted, svc.id)
        if (corrupt) console.warn('[cron] #545 corrupt alerted:new roster, treating as legacy:', inc.id, wasAlerted.slice(0, 80))
        for (const id of ids) set.add(id)
      }
      // #1224 — measured 2026-08-17, this read ran 29×/run and EVERY one was for an incident past the
      // bound: `isFlapSuppressible` bounds on the incident's RUN time, so an old short resolved flap
      // still qualifies. Gated with the rest — its suppression only subtracts from the same capped
      // build, and its key is written only for a resolved alert that actually SENT.
      if (config && alertable && isFlapSuppressible(svc.id, config, inc, nowMs)) {
        flapReads++
        const flapKey = flapSuppressionKey(svc.id, inc)
        const flapActive = await env.STATUS_CACHE.get(flapKey).catch(() => null)
        if (flapActive) {
          // #983 — leave a forensic trail. Suppression drops BOTH the New and the Resolved alert, so
          // without this line a post-incident triage cannot tell "AIWatch suppressed it" from
          // "AIWatch never saw it" (the #970 silent-drop forensics gap). Tagged auto-monitor incidents
          // are the ones whose `major` impact no longer protects them, so name the tag explicitly.
          console.log('[cron] #283/#983 flap-suppressed (same-title window active):', svc.id, inc.id, `autoMonitor=${inc.autoMonitor === true}`, JSON.stringify(inc.title.slice(0, 60)))
          suppressedIncIds.add(inc.id)
        }
        else flapKeysToWrite.set(inc.id, flapKey)
      }
      // #633 — hold a flap-shaped new incident on its first sight (no pending marker from a prior
      // cycle); confirm + fire once it survives a cycle. alreadyAlerted is read from alertedNewMap
      // above, so a re-fire of an already-sent incident is never held.
      // #1224 — gated with the read above: a hold only ever subtracts from `buildIncidentAlerts`, so
      // past the bound it has nothing left to gate. Leaving it ungated while the read above was gated
      // would be WORSE than either: `alreadyAlerted` would read false for an already-announced old
      // incident, so the hold would newly apply to it.
      if (config && alertable) {
        const alreadyAlerted = alertedNewMap.get(inc.id)?.has(svc.id) ?? false
        // #835 — the pending:new marker stores the FIRST-SEEN epoch ms (not a bare '1'); shouldHold
        // confirms only once the incident has been first-seen ≥ FLAP_HOLD_MS (~2 cron cycles).
        // On a KV read ERROR pass firstSeenMs=0 (age huge → NOT held → fire): dropping a real alert
        // is worse than one phantom on a transient KV blip (preserves the prior fail-not-hold).
        // A legacy '1' marker (pre-#835) parses to 1 → age huge → fires immediately — a safe one-time
        // transition (no in-flight incident gets stuck held across the deploy).
        // #1224 — `readPending` is false for a RESOLVED incident, where the value is provably
        // unused: shouldHoldNewIncident returns false on `status === 'resolved'` before it reads
        // firstSeenMs, and the only other consumer (the stamp below) is inside that same branch. The
        // key's own 30-min TTL is NOT part of that decision — it runs from the first SIGHT, not
        // `startedAt`, so an ongoing long incident has a LIVE marker.
        // The skip value is `null`, NOT the '0' read-error sentinel: `null` means "no marker" (first
        // sight), while '0' parses to firstSeenMs=0 and would claim a marker had existed.
        if (readPending) pendingReads++
        const pendingRaw = readPending
          ? await env.STATUS_CACHE.get(pendingNewKey(inc.id)).catch((err) => {
            pendingReadErrors++
            console.warn('[cron] #835 pending:new read failed — failing open (will not hold):', inc.id, err instanceof Error ? err.message : err)
            return '0'
          })
          : null
        const firstSeenMs = pendingRaw === null ? null : (Number.parseInt(pendingRaw, 10) || 0)
        if (shouldHoldNewIncident(svc.id, config, inc, { alreadyAlerted, firstSeenMs, nowMs })) {
          console.log('[cron] #633/#792/#835 holding new incident until it survives ~2 cycles (flap / short-blip gate):', svc.id, inc.id)
          suppressedIncIds.add(inc.id)
          heldNewIncIds.add(inc.id)
          // Stamp the first-seen time ONCE (get-or-set) so the window measures from the true first sight.
          if (firstSeenMs === null) pendingNewToWrite.set(inc.id, nowMs)
        }
      }
    }
    const wasDown = await env.STATUS_CACHE.get(`alerted:down:${svc.id}`).catch(() => null)
    if (wasDown) alertedDownMap.set(svc.id, wasDown)
    const wasDegraded = await env.STATUS_CACHE.get(`alerted:degraded:${svc.id}`).catch(() => null)
    if (wasDegraded) alertedDegradedMap.set(svc.id, wasDegraded)
  }

  console.log('[cron] #1224 per-incident marker reads —', `pairs=${rosterReads + rosterSkips}`, `alerted:new read=${rosterReads}`, `skipped=${rosterSkips}`, `pending:new read=${pendingReads}`, `alerted:flap read=${flapReads}`, `rosterReadErrors=${rosterReadErrors}`, `pendingReadErrors=${pendingReadErrors}`, `heldNewIds=${heldNewIncIds.size}`)

  // Anti-flapping: read pending state BEFORE building alerts.
  // Degraded alerts require consecutive detection (2 cron cycles ≈ 10min).
  // Down alerts are sent immediately (high urgency).
  const pendingDegraded = new Set<string>()
  for (const svc of scored) {
    if (svc.status === 'degraded') {
      const pending = await env.STATUS_CACHE.get(`pending:degraded:${svc.id}`).catch(() => null)
      if (pending) pendingDegraded.add(svc.id)
    }
  }

  // #1106 — closing notice for an incident the provider DELETED from its status page instead of
  // resolving. The accumulator's #975 prune tombstoned it above (same cron run, `accumulateIncidents
  // OnlyIfChanged`); it can never reach buildIncidentAlerts' resolved branch, which requires the
  // incident to still be in the live list. Gated on the `alerted:new:{incId}` marker so only an
  // incident we ACTUALLY announced produces one — `alertedNewMap` is built from live incidents only,
  // and a withdrawn incident is by definition absent from those, so the markers are re-read here.
  const withdrawalAlerts: AlertCandidate[] = []
  try {
    // `logExpired` on the CRON only: a tombstone that ages out never notified anyone, which is #1106
    // recurring, and the 5-min cadence bounds the line. The /feed handler leaves it off (request path).
    const withdrawnTombstones = await readWithdrawn(env.STATUS_CACHE, Date.now(), true)
    // #1153 — keep the roster KEY alive for as long as its entries are readable. The key's TTL is
    // fixed by whichever `WITHDRAWN_TTL_S` was in force at the prune, so without this an entry widened
    // by a later deploy is capped by the old, shorter key life. Hourly + only while a tombstone is
    // pending (`shouldRefreshWithdrawnKey`), on the SCHEDULED clock so a slow tick doesn't skip the
    // slot for the whole hour. Placed BEFORE the alert build so an exception there can't skip this
    // durability chore; it re-reads the roster itself and cannot throw.
    await refreshWithdrawnKey(env.STATUS_CACHE, withdrawnTombstones, scheduledTimeMs)
    const announcedWithdrawnIds = new Set<string>()
    await Promise.all(withdrawnTombstones.map(async (w) => {
      // Read failure → treat as NOT announced → stay silent. A withdrawal notice is only correct when
      // we know an announcement preceded it; a KV blip must not be able to invent that premise.
      // Every drop is logged, and the three causes are distinguished, because they are NOT the same
      // event (#970/#983 — a judgement drop must never be quiet): a clean miss is usually "we never
      // announced it", but it is ALSO what a >7d-old announcement looks like once `alerted:new:`
      // expires — i.e. a thread we opened and will now never close, which is #1106 recurring.
      let marker: string | null = null
      let readFailed = false
      try {
        marker = await env.STATUS_CACHE.get(`alerted:new:${w.incId}`)
      } catch (err) {
        readFailed = true
        console.warn('[cron] #1106 alerted:new read failed — holding the withdrawal notice this cycle:', w.incId, err instanceof Error ? err.message : err)
      }
      if (marker) { announcedWithdrawnIds.add(w.incId); return }
      if (readFailed) return
      // Split by cause. A tombstone whose incident STARTED more than the marker's 7d TTL ago is not
      // "we never announced it" — it is a thread we DID open and can now never close, i.e. exactly
      // #1106 recurring, so it warns. Anything younger is the benign case and stays at log level.
      const announcedTooLongAgo = Date.now() - Date.parse(w.startedAt) > ALERTED_NEW_TTL_S * 1000
      if (announcedTooLongAgo) {
        console.warn('[cron] #1106 alerted:new marker has EXPIRED (incident older than its 7d TTL) — this thread can never be closed:', w.svcId, w.incId, `started ${w.startedAt}`)
      } else {
        console.log('[cron] #1106 tombstone has no alerted:new marker — never announced, so no withdrawal notice:', w.svcId, w.incId, `pruned ${w.prunedAt}`)
      }
    }))
    // A hold is re-evaluated every cycle, so this describes a STATE, not an event: it reprints for as
    // long as the condition holds (same cadence + reasoning as the #283/#983 flap-suppressed line).
    // Line COUNT is therefore not a frequency — count distinct incident ids.
    withdrawalAlerts.push(...buildWithdrawalAlerts(withdrawnTombstones, announcedWithdrawnIds, scored, (w, reason) => {
      console.log('[cron] #1106 withdrawal notice held —', reason, `${w.svcId}/${w.incId}`, `pruned ${w.prunedAt} (roster expires ${WITHDRAWN_TTL_S / 3600}h after that)`)
    }))
  } catch (err) {
    // The withdrawal notice is a closing courtesy; the New/Resolved/Down alerts below are the
    // critical path. A throw here must never abort the whole cron tick's alerting.
    console.error('[cron] #1106 withdrawal alert build failed (other alerts still sent):', err instanceof Error ? err.message : err)
  }

  // Build alerts using pure functions
  const incidentAlerts = buildIncidentAlerts(scored, alertedNewMap, runNowMs, suppressedIncIds)
  const serviceAlerts = buildServiceAlerts(scored, alertedDownMap, alertedDegradedMap)
  // #1106 — withdrawals go LAST. `sent` is capped at 5 per cycle, so ordering is a priority: a
  // retraction of a days-old incident must never evict a live `down`/`degraded` alert. A withdrawal
  // pushed past the cap is simply retried next cycle (its dedup key is only written on send, and the
  // tombstone lives 6d), whereas a delayed outage alert is the thing users actually wait on.
  const allAlerts = [...incidentAlerts, ...serviceAlerts, ...withdrawalAlerts]

  // Dedup: skip alerts already sent + same-batch dedup + anti-flapping for degraded
  const toSend = []
  const seenKeys = new Set<string>()
  for (const alert of allAlerts) {
    if (seenKeys.has(alert.key)) continue // same incident across shared-status-page services
    const existing = await env.STATUS_CACHE.get(alert.key).catch(() => null)
    // #545: for new-incident alerts the per-service dedup already happened in buildIncidentAlerts
    // (against alertedNewMap, read from this same key) — so if it produced one, there's a genuine
    // not-yet-alerted joiner. Skipping on key existence here would silently drop that joiner, which
    // is the exact bug. The roster write below merges the joiner into the stored set. Other alert
    // kinds keep the simple "key exists → already sent → skip" dedup.
    if (existing && !alert.key.startsWith('alerted:new:')) continue
    // Anti-flapping: degraded alerts need pending from PREVIOUS cron cycle
    if (alert.key.startsWith('alerted:degraded:')) {
      const svcId = alert.key.replace('alerted:degraded:', '')
      if (!pendingDegraded.has(svcId)) continue // first detection → skip
    }
    seenKeys.add(alert.key)
    toSend.push(alert)
  }

  // Write pending keys AFTER filtering (so they exist for the next cron cycle)
  for (const svc of scored) {
    if (svc.status === 'degraded') {
      await kvPut(env.STATUS_CACHE, `pending:degraded:${svc.id}`, '1', { expirationTtl: 600 })
    }
  }
  // #633/#835 — stamp the first-seen ts (write-once) for held new incidents so a LATER cron cycle
  // confirms + fires once the incident outlives FLAP_HOLD_MS (~2 cycles); a blip that recovers inside
  // the window never gets here on a later cycle, so it never alerts (no phantom).
  // Log on failure (mirrors the alerted:new roster write below): a dropped marker means the incident
  // re-stamps from scratch next cycle (self-heals on a transient blip), but a sustained KV-write
  // outage (which also breaks the roster writes) would delay the alert, so make it observable.
  for (const [incId, firstSeenMs] of pendingNewToWrite) {
    const ok = await kvPut(env.STATUS_CACHE, pendingNewKey(incId), String(firstSeenMs), { expirationTtl: PENDING_NEW_TTL_S })
    if (!ok) console.error('[cron] #835 pending:new write FAILED — held incident may re-hold from scratch next cycle:', incId)
  }

  // Record detection timestamps for non-operational services (Detection Lead feature)
  // Uses detection.ts helpers — resets when incident ID changes to prevent inflated leads (#189)
  // #1233 — this is a THREE-way decision now, and the third arm is the whole point. The old two-way
  // form (`!== 'operational'` → stamp, else DELETE) put an unreadable source in the `else`, destroying
  // the detection anchor of an outage that is very likely still running: losing sight of a service is
  // not evidence it recovered. That would forward-date the incident when the source becomes readable
  // again, understating its duration in `detectedAt`, in #677's AWS anchor, and downstream in MTTR /
  // Recovery / the monthly report. `unknown` therefore does NOTHING here — it neither stamps (which
  // would backdate the detection of whatever the source reveals later) nor clears.
  for (const svc of scored) {
    const verdict = statusVerdict(svc.status)
    if (verdict.unreadable) continue
    if (verdict.affected) {
      const detectKey = `detected:${svc.id}`
      const existingRaw = await env.STATUS_CACHE.get(detectKey).catch(() => null)
      const activeInc = (svc.incidents ?? []).find(i => i.status !== 'resolved')
      const activeIncId = activeInc?.id ?? null
      const existing = parseDetectionEntry(existingRaw)
      const update = resolveDetectionUpdate(existing, activeIncId, new Date().toISOString())
      if (update) {
        await kvPut(env.STATUS_CACHE, detectKey, serializeDetectionEntry(update.entry), { expirationTtl: 604800 })
      }
    } else {
      await kvDel(env.STATUS_CACHE, `detected:${svc.id}`)
    }
  }

  // #689/#714 — distinct operator alert when a service's status SOURCE goes inactive (4xx → sourceDead),
  // so it reads accurately ("status source inactive": service is operational+stale, excluded from
  // rankings) instead of a misleading "degraded" alert. Deduped per service; on a GENUINE recovery
  // (source returns 200 again → liveness 'alive') the marker is cleared and a recovery note is sent.
  // #714 — the decision is driven by 3-state liveness (dead/alive/unknown), NOT a boolean: an
  // indeterminate cycle (throw / 5xx / 429 → 'unknown') HOLDS the prior dead state instead of firing a
  // false 'recovered' (the repeating Inactive/Recovered flap). The 'alert' edge is further debounced by
  // a 1-cycle confirmation marker (pending:source-dead:) so a single-cycle 4xx blip never alerts.
  if (env.DISCORD_WEBHOOK_URL) {
    for (const svc of scored) {
      const deadKey = `alerted:source-dead:${svc.id}`
      const pendingKey = pendingSourceDeadKey(svc.id)
      const liveness = sourceLivenessOf(svc)
      // deadKey read failure → treat as not-alerted (favor FIRING a real dead-source alert over
      // suppressing it). pendingKey read failure → fail OPEN (treat as present) so a KV hiccup can't
      // hold a real dead source forever — it confirms + alerts rather than silently re-debouncing.
      // The asymmetry is deliberate: both directions bias toward surfacing a real dead source. The
      // worst case from a simultaneous double-read blip is ONE duplicate 'Inactive' (self-corrected
      // next cycle once the reads succeed) — never the repeating Inactive/Recovered pair #714 fixes.
      const alreadyAlerted = (await env.STATUS_CACHE.get(deadKey).catch(() => null)) !== null
      const pendingExists = (await env.STATUS_CACHE.get(pendingKey).catch(() => '1')) !== null
      const action = decideSourceDeadAction(liveness, { alreadyAlerted, pendingExists })
      if (action === 'hold-unknown') continue // indeterminate while alerted — keep markers, send nothing
      if (action === 'hold-confirm') {
        // #714 — first dead sighting: debounce one cycle so a single-cycle 4xx blip never alerts. Check
        // the write (mirrors #633): a silently-failed pending write would re-debounce forever, delaying
        // the real dead-source alert indefinitely — so surface it.
        const ok = await kvPut(env.STATUS_CACHE, pendingKey, '1', { expirationTtl: PENDING_SOURCE_DEAD_TTL_S })
        if (!ok) console.error('[cron] #714 pending:source-dead write FAILED — dead-source alert may be delayed a cycle:', svc.id)
        continue
      }
      if (action === 'none') {
        // A held-dead source that turned 'alive' before its confirmation cycle: drop the stale pending
        // so it doesn't later fire on its own (no 'Inactive' was ever sent → no 'recovered' either).
        // Gate on pendingExists so a healthy source isn't issued a no-op delete every cron cycle.
        if (liveness === 'alive' && pendingExists) await kvDel(env.STATUS_CACHE, pendingKey)
        continue
      }
      const cfg = SERVICES.find(c => c.id === svc.id)
      // #800 — a KNOWN-deactivated source (operator-acknowledged, e.g. Character.AI): suppress the
      // recurring rising-edge "Inactive" send, but still mark it alerted so a future RECOVERY is
      // detected + notified (recovery is never suppressed). Mirrors the `action === 'alert'` success path.
      if (cfg && shouldSuppressSourceDeadAlert(action, cfg)) {
        // This marker is the SOLE enabler of a future recovery alert (a still-dead source reads as
        // 'none' once alerted; a reactivation reads as 'recovered' only while the marker exists), so
        // check the write like the sibling #714/#545 marker writes — a silent failure would disarm
        // recovery detection until a later cycle re-writes it (self-healing, but otherwise invisible).
        const ok = await kvPut(env.STATUS_CACHE, deadKey, '1', { expirationTtl: 604800 })
        if (!ok) console.error('[cron] #800 source-dead marker write FAILED — recovery detection disarmed until re-written:', svc.id)
        await kvDel(env.STATUS_CACHE, pendingKey)
        continue
      }
      const sent = await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, buildSourceDeadEmbed(svc.name, cfg?.statusUrl ?? '', action === 'recovered'))
      // Gate the KV mutation on a successful send, so a failed POST retries next cycle (the dead alert
      // re-fires; the recovery note re-sends) rather than being silently lost. NOTE the 'alert' retry is
      // valid only within the pending TTL window — if Discord is down >2 cycles the pending expires and
      // a still-dead source re-debounces one extra cycle once Discord recovers (self-healing, minor).
      if (action === 'alert' && sent) {
        await kvPut(env.STATUS_CACHE, deadKey, '1', { expirationTtl: 604800 })
        await kvDel(env.STATUS_CACHE, pendingKey) // confirmed + alerted — clear the pending marker
      } else if (action === 'recovered' && sent) {
        await kvDel(env.STATUS_CACHE, deadKey)
        await kvDel(env.STATUS_CACHE, pendingKey)
      }
    }
  }

  // Merge concurrent Together AI model-level (#283) + xAI per-region (#686) alerts into single grouped
  // alerts. Disjoint services, so order is irrelevant; both set `_mergedKeys` for the roster write below.
  // #1106 — re-sink withdrawals to the tail AFTER merging, because merging is what reorders them:
  // both merge fns return `[...rest, ...merged]`, so a collapsed live Together/xAI alert is appended
  // BEHIND the `⚪` retractions that rode through in `rest`. Ordering `allAlerts` alone therefore does
  // not survive to the cap below — and `mergedToSend`, not `allAlerts`, is the array that gets sliced.
  // A withdrawal pushed past the cap is retried next cycle (no dedup key is written for an unsent
  // alert, and the tombstone lives 6d); a live outage alert delayed a cycle is the real cost.
  const merged = mergeXaiRegionalAlerts(mergeTogetherAlerts(toSend))
  const isWithdrawal = (a: AlertCandidate) => a.key.startsWith('alerted:wd:')
  const mergedToSend = [...merged.filter((a) => !isWithdrawal(a)), ...merged.filter(isWithdrawal)]

  // Send + mark as alerted (down/degraded: 2h TTL, incidents/recovery: 7d TTL)
  // For new incidents, run AI analysis with timeout so it can be merged into the embed
  const sent = mergedToSend.slice(0, 5)
  const DIV = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈'
  // #475 — capture every embed we send to the operator into the canonical alert feed, so the
  // dashboard can relay byte-identical alerts to a visitor's own Discord webhook (single source of
  // truth; kills the browser/operator divergence that #473/#474 chased).
  const feedEntries: AlertFeedEntry[] = []
  let pushesSent = 0 // #815 — count delivered push-scope ntfy pushes for the daily-summary observability line
  // #882 — new-incident alert keys HELD this cycle (out of NEVER_AI_HELD, AI not yet ready). They're in `sent`
  // but were `continue`d before the roster write / send, so exclude them from the daily alert count.
  const heldNewAlertKeys = new Set<string>()
  for (const alert of sent) {
    const isStatusAlert = alert.key.startsWith('alerted:down:') || alert.key.startsWith('alerted:degraded:')
    const isRecoveryAlert = alert.key.startsWith('alerted:recovered:')
    // #1106 — `alerted:wd:` MUST land in the 7d branch, and does so only because it is neither a
    // status nor a recovery key. That is correct by omission, and the omission is load-bearing: its
    // subject is a tombstone that survives 6d and reproduces the alert deterministically, so a 2h
    // TTL would re-post the same public retraction to the operator AND every subscriber ~23 times.
    // Pinned by a test — see `ALERTED_NEW_TTL_S` below, which is the same 7d window.
    const ttl = (isStatusAlert || isRecoveryAlert) ? 7200 : ALERTED_NEW_TTL_S
    const kvValue = isStatusAlert ? new Date().toISOString() : '1'
    // Write dedup keys for all merged alerts (Together AI grouping)
    const keysToWrite = alert._mergedKeys ?? [alert.key]
    // #882 — resolve the new-incident AI analysis BEFORE the alerted:new roster write / send, so an
    // alert whose inline analysis overran can be HELD (not shipped AI-less) until a
    // later cron cycle backfills ai:analysis, then released WITH the section. Prefer an EXISTING KV
    // analysis (backfilled by a prior cycle's refreshOrReanalyze — no budget cap) over re-running the
    // inline call, so the release is deterministic and no duplicate AI call fires. A NEVER_AI_HELD
    // service (#1148) is never held (shouldHoldForAiAnalysis) so its alert — and, in push scope, its
    // phone push — stays immediate. The operator embed AND the per-user relay share this single analysisSection.
    let analysisSection = ''
    let aiReady = false          // an AI section is available (KV or a successful inline call)
    let analysisSkipped = false  // AI will never come for this incident (merged / no-model / generic)
    if (alert.key.startsWith('alerted:new:')) {
      const incId = alert.key.replace('alerted:new:', '')
      // #545: scope AI analysis to the service this alert actually represents (alert.svcIds[0]) — for a
      // late joiner that's the newly-affected service (e.g. ChatGPT), not the incident's first service.
      const primaryId = alert.svcIds?.[0]
      const svc = (primaryId && scored.find(s => s.id === primaryId))
        || scored.find(s => (s.incidents ?? []).some(i => i.id === incId))
      const inc = svc ? (svc.incidents ?? []).find(i => i.id === incId) : null
      const nowMs = Date.now()
      // #882 — read the AI-hold marker FIRST: a genuine KV miss (null, no throw) = first sighting; a
      // read error (.catch → '0') = fail-open (age huge → past window → not held). Knowing first-sight
      // BEFORE the analysis lets the expensive inline call fire only on the FIRST cycle — a held
      // incident on a later cycle relies on the KV-first read below (backfilled by refreshOrReanalyze),
      // so it doesn't burn a second Gemma/Sonnet call every cycle (silent-failure-hunter #882).
      const pendingAiRaw = await env.STATUS_CACHE.get(pendingAiKey(incId)).catch(() => '0')
      const firstSeenMs = pendingAiRaw === null ? null : (Number.parseInt(pendingAiRaw, 10) || 0)
      const firstSight = firstSeenMs === null
      if (svc && inc) {
        // Prefer an existing (non-empty) KV analysis over a fresh inline call (#882). This is the
        // release path: a held incident's analysis, backfilled by the previous cycle's
        // refreshOrReanalyze, is read here so the alert deterministically ships WITH the AI section.
        let existing: AIAnalysisResult | null = null
        const existingRaw = await env.STATUS_CACHE.get(analysisKey(svc.id, inc.id)).catch(() => null)
        if (existingRaw) {
          try {
            const p = JSON.parse(existingRaw) as AIAnalysisResult
            if (p && typeof p.summary === 'string' && p.summary.length > 0) existing = p
          } catch { existing = null }
        }
        if (existing) {
          analysisSection = formatAnalysisEmbedSection(existing, DIV)
        } else if (firstSight) {
          // Only run the inline call on the incident's FIRST sighting; on later held cycles the
          // KV-first read above + refreshOrReanalyze's backfill supply the section (no duplicate spend).
          // AI analysis (INLINE_ANALYSIS_BUDGET_MS) — Gemma primary + Sonnet fallback. shouldSkipInitialAnalysis
          // centralizes the three skip reasons (merged / no-model / generic) so they can't drift
          // between here and the re-analysis path; log the reason so an empty section is explainable.
          const skipReason = shouldSkipInitialAnalysis(alert, inc, !!(env.AI || env.ANTHROPIC_API_KEY))
          if (skipReason) {
            analysisSkipped = true
            console.log(`[cron] skipping initial AI analysis for ${svc.id}:${inc.id}: ${skipReason}`)
          } else {
            try {
              // #827 Feature 2 — RAG grounding from this service's durable incident history.
              const svcHistory = await readIncidentHistory(env.STATUS_CACHE, svc.id)
              // #955 Part 2 — a REAL, cancellable budget (see `analyzeIncidentWithBudget`).
              const attempt = await analyzeIncidentWithBudget(
                env.STATUS_CACHE, env.ANTHROPIC_API_KEY, env.AI, { id: svc.id, name: svc.name },
                { id: inc.id, title: inc.title, status: inc.status, startedAt: inc.startedAt, impact: inc.impact, timeline: inc.timeline },
                svc.incidents ?? [], svcHistory,
              )
              if (attempt.result) {
                // #299: preserve sticky operator overrides written between cycles.
                const stickyRaw = await env.STATUS_CACHE.get(analysisKey(svc.id, inc.id)).catch(() => null)
                const skipWrite = isStickyExistingAnalysis(stickyRaw)
                if (skipWrite) console.log(`[cron] Preserving sticky analysis for ${svc.id}:${inc.id}; not overwriting`)
                // #1003 — the incident's first sighting, so this estimate is normally THE baseline;
                // `putAnalysis` pins it durably (and lets a non-sticky prior, e.g. an expired-then-
                // rewritten analysis, keep its original bound).
                const written = skipWrite
                  ? null
                  : await putAnalysis(env.STATUS_CACHE, svc.id, inc.id, attempt.result, parseAnalysis(stickyRaw), 3600)
                // Section only when the sticky prior stands, or the write actually landed (as before:
                // an embed advertising an analysis no reader can fetch is worse than none).
                const analysis = skipWrite ? attempt.result : (written?.ok ? written.pinned : null)
                if (analysis) analysisSection = formatAnalysisEmbedSection(analysis, DIV)
              } else {
                console.warn(`[cron] inline AI analysis produced nothing (${attempt.failure}) for ${svc.id}:${inc.id}`)
              }
            } catch (err) {
              // Only `readIncidentHistory` / the sticky KV read can reach here — the analysis
              // itself never throws and books its own usage.
              console.error('[cron] AI analysis failed:', err instanceof Error ? err.message : err)
              await recordUsage(env.STATUS_CACHE, Date.now(), { result: null, failure: 'unknown', attempts: { gemma: 0, sonnet: 0 } }, svc.id)
            }
          }
        }
        aiReady = analysisSection !== ''
      }
      // #882 — AI-hold gate: out of NEVER_AI_HELD + AI not ready + not skipped + within window → HOLD this cycle
      // (`continue` skips the roster write / feed append / send / push below). The next cron cycle's
      // refreshOrReanalyze backfills ai:analysis; a later cycle finds it via the KV-first read above
      // and releases WITH the section. Bounded + fail-open: past AI_HOLD_MS the gate returns false so
      // the alert ships AI-less and is never lost. A NEVER_AI_HELD service is never held (immediate, #1148).
      const holdSvcId = svc?.id ?? primaryId ?? ''
      // If the service/incident couldn't be resolved there's nothing to analyze → never hold (treat as
      // skipped so a fail-open path can't wedge an un-analyzable alert). buildIncidentAlerts sources
      // from `scored`, so this is a defensive belt, not an expected case.
      const analysisUnavailable = analysisSkipped || !svc || !inc
      if (shouldHoldForAiAnalysis({ svcId: holdSvcId, aiReady, analysisSkipped: analysisUnavailable, firstSeenMs, nowMs })) {
        // The fail-open window can only elapse if the first-seen marker PERSISTS across cycles. On first
        // sight, stamp it; if that write FAILS we can't bound the hold (next cycle re-sees first-sight →
        // re-stamps → window never advances), so an unbounded hold could wedge the alert if AI also
        // never lands. Fail-open NOW (fall through to send AI-less) rather than hold unboundedly — one
        // early AI-less alert beats a lost one. On a later cycle the marker already exists (write-once),
        // so we just hold within the window as normal (silent-failure-hunter #882).
        if (firstSight) {
          const ok = await kvPut(env.STATUS_CACHE, pendingAiKey(incId), String(nowMs), { expirationTtl: PENDING_NEW_TTL_S })
          if (!ok) {
            console.error('[cron] #882 pending:ai write failed — sending AI-less now (cannot bound the hold):', incId)
          } else {
            heldNewAlertKeys.add(alert.key)
            // #1080 — book the hold ONLY here, on the first-sight stamp. The `else` branch below is a
            // re-hold of an incident already counted, so bumping there too would inflate `held`
            // against the release counters and make the two incomparable. Booked after the stamp
            // succeeded, so a hold that never actually happened is never counted.
            await recordHoldEvent(env.STATUS_CACHE, nowMs, 'held')
            console.log('[cron] #882 holding hold-eligible new-incident alert until AI lands (or fail-open window):', holdSvcId, incId)
            continue
          }
        } else {
          heldNewAlertKeys.add(alert.key)
          console.log('[cron] #882 holding hold-eligible new-incident alert until AI lands (or fail-open window):', holdSvcId, incId)
          continue
        }
      }
      // Released (AI ready / in NEVER_AI_HELD / skipped / past window / unbounded-hold fail-open) — clear the
      // marker best-effort so a stale window value can't linger (harmless on failure; TTL bounds it).
      // #1080 — `firstSeenMs` truthy means this incident HAD a marker and is being released now.
      // A NEVER_AI_HELD service never STAMPS a marker, so it is not counted here for its own incidents. (Not an
      // absolute: the marker is keyed per incident while `holdSvcId` comes from `alert.svcIds[0]`,
      // so a #545 never-held late joiner on an incident a hold-eligible service already stamped will book
      // the release. That is the correct behavior — the hold really is being released — it just
      // means "a NEVER_AI_HELD service is never in the ledger" is too strong a reading.) Which
      // release it was is the whole point of #882 — `aiReady` separates the hold working as designed
      // from the alert shipping AI-less anyway. Booked before the delete so a failed delete (which is
      // best-effort by design) cannot lose the release from the ledger. That ordering trades "lose a
      // release" for "occasionally double-book one": `kvDel` swallows its failure and a late joiner
      // re-emits the same `alerted:new:{incId}`, so a surviving marker books the release twice. The
      // right trade, but it does NOT leave the ratio untouched: the re-booked release usually lands on
      // `releasedWithAi` (the next cycle has normally backfilled the analysis), so the skew favours
      // "the hold worked". Read the ledger as a trend, never as an exact tally — see `holdLedger`.
      //
      // NOT a complete set, and deliberately not pretending otherwise: the marker read above
      // fail-opens to '0' on a KV error, which is indistinguishable from "no marker" at this point.
      // A genuinely-held incident whose read errored is therefore released without being booked. We
      // cannot recover the fact (we never learned it was held), so the honest handling is to make it
      // NOISY rather than silent — a silent under-count is what #1080 exists to stop shipping.
      if (firstSeenMs) {
        await recordHoldEvent(env.STATUS_CACHE, nowMs, aiReady ? 'releasedWithAi' : 'releasedWithoutAi')
        await kvDel(env.STATUS_CACHE, pendingAiKey(incId)).catch(() => {})
      } else if (firstSeenMs === 0 && !NEVER_AI_HELD.has(holdSvcId)) {
        // A NEVER_AI_HELD service does not stamp markers for its own incidents, so a missing release
        // is not something this warning can meaningfully claim for it — and unfiltered it would fire
        // once per alert per cycle during a KV read outage. Known limitation, widened by #1148 from 3
        // ids to 9: a #545 never-held joiner releasing a marker a hold-eligible service stamped, on a
        // cycle whose KV read errored, is silently un-booked here. The ledger is a trend, not a tally.
        console.warn('[cron] #1080 pending:ai read fail-open — if this alert was held, its release is missing from the ledger:', holdSvcId, incId)
      }
    }
    if (alert.key.startsWith('alerted:new:')) {
      // #545: store the per-incident roster (svcIds), merging this alert's services into whatever
      // was already alerted for the incident (in-memory alertedNewMap, read this cycle — no re-read).
      // So a later joiner is recorded and the NEXT cycle's buildIncidentAlerts skips it. 7d TTL.
      const newSvcIds = alert.svcIds ?? []
      // #545: surface a failed roster write. The dedup-bypass below relies on this write to persist
      // the joiner — if it silently fails, buildIncidentAlerts re-emits the SAME new-incident alert
      // every cron cycle (operator + all subscribers) until a write lands. (Pre-#545 the `if (existing)
      // continue` key check was the backstop; the bypass removed it for alerted:new, so this is now
      // the only thing preventing a 5-min duplicate-alert loop — log loudly so it's diagnosable.)
      await Promise.all(keysToWrite.map(async k => {
        const incId = k.slice('alerted:new:'.length)
        const roster = alertedNewMap.get(incId) ?? new Set<string>()
        for (const id of newSvcIds) roster.add(id)
        const ok = await kvPut(env.STATUS_CACHE, k, JSON.stringify([...roster]), { expirationTtl: 604800 })
        if (!ok) console.error('[cron] #545 alerted:new roster write FAILED — incident will re-alert next cycle:', k)
        // #750 — stamp the incident's first-detected time ONCE (get-or-set; first write wins so the
        // value stays STABLE across cycles + service joiners). The /feed active item reads this as its
        // pubDate so a backdated provider `startedAt` can't make Slack /feed treat the outage post as
        // "already past" and skip it (Discord push is unaffected). 7d TTL, matches the alerted:new roster.
        const fsKey = `feed:firstseen:${incId}`
        let fsExisting: string | null = null
        try {
          fsExisting = await env.STATUS_CACHE.get(fsKey)
        } catch (err) {
          // get THREW (KV hiccup) — do NOT treat as absent: re-stamping would overwrite an existing
          // value and break first-write-wins. Skip this cycle (a later cycle retries); log a breadcrumb.
          fsExisting = '\x00' // sentinel: "not absent" → skip the put below
          console.warn('[cron] #750 feed:firstseen get failed, skipping stamp:', incId, err instanceof Error ? err.message : err)
        }
        // Only stamp on a genuine clean miss (null), so the first cycle to detect the incident wins.
        if (fsExisting === null) {
          await kvPut(env.STATUS_CACHE, fsKey, new Date().toISOString(), { expirationTtl: 604800 })
        }
      }))
    } else {
      const writes = await Promise.all(keysToWrite.map(async k => ({ k, ok: await kvPut(env.STATUS_CACHE, k, kvValue, { expirationTtl: ttl }) })))
      // #1106 — surface a failed `alerted:wd:` dedup write specifically. Every other kind here is
      // bounded by its subject leaving the live feed, but a withdrawal's subject is a tombstone that
      // sits in KV for 6d and reproduces the alert deterministically — so a lost dedup key means the
      // same retraction re-posts to the operator AND every subscriber every 5 minutes for that window.
      for (const { k, ok } of writes) {
        if (!ok && k.startsWith('alerted:wd:')) console.error('[cron] #1106 alerted:wd dedup write FAILED — this withdrawal will re-fire every cycle until a write lands:', k)
      }
    }
    // #283: write flap-suppression key when a flap-candidate *resolved* alert fires
    // (BetterStack emits "— recovered" only on resolved). This marks the end of the
    // first flap cycle and starts a 60-min window that silently drops subsequent
    // identical flaps (both down and resolved halves).
    for (const k of keysToWrite) {
      if (!k.startsWith('alerted:res:')) continue
      const incId = k.slice('alerted:res:'.length)
      const flapKey = flapKeysToWrite.get(incId)
      if (flapKey) await kvPut(env.STATUS_CACHE, flapKey, '1', { expirationTtl: 3600 })
    }
    if (isStatusAlert) {
      const svcId = alert.key.split(':').pop()!
      await kvDel(env.STATUS_CACHE, `alerted:recovered:${svcId}`)
    }
    // #827 F4 — "predicted vs actual" line for the recovery alert (operator + per-user feed inherit it
    // from the shared description). Declared out here so it's in scope at the parts-assembly below.
    let recoverySection = ''
    // Mark recovery: write independent recovered:{svcId}:{incId} KV + update AI analysis if exists
    if (isRecoveryAlert) {
      const svcId = alert.key.replace('alerted:recovered:', '')
      const svc = scored.find(s => s.id === svcId)
      const now = new Date().toISOString()
      const incidents = svc?.incidents ?? []
      // #827 Phase 1 — collect durable history records during the per-incident map, then write
      // them in ONE batched read-modify-write below. Racing one RMW per incident against the
      // shared incident:history:{svcId} key inside Promise.all would lose-update when a service
      // resolves ≥2 incidents in a cycle (the per-incId recovered: markers below use distinct
      // keys, so they're safe to race).
      const historyRecords: IncidentHistoryRecord[] = []
      // #1003 — only TERMINAL incidents may be marked resolved. This map used to run over EVERY
      // incident on the service, so an operational service still carrying an ACTIVE one (an
      // `incidentExclude`d entry, a maintenance notice, a component mapping to nothing monitored)
      // had `resolvedAt` stamped on a live analysis. That was invisible before — nothing read the
      // stamp on the normal path — but now it is exactly what flips a surface into "resolved":
      // the modal/is-down would render a predicted-vs-actual verdict for an incident still running,
      // and suppress the "past estimate" wording that belongs there. `buildHistoryRecord` already
      // gates on these two statuses, and the `alerted:res:` path is resolved-only by construction —
      // so this also makes the two paths structurally symmetric.
      const terminal = incidents.filter(i => i.status === 'resolved' || i.status === 'monitoring')
      await Promise.all(terminal.map(async (inc) => {
        // The recovery marker + the analysis `resolvedAt` stamp are the two writes every
        // resolved-incident READ surface is gated on; `markIncidentResolved` is the shared step both
        // cron resolution paths call, so they can't drift again (see recovery-mark.ts).
        const analysis = await markIncidentResolved(env.STATUS_CACHE, svcId, inc, now)
        // #827 Phase 1 keystone — durable record joining the AI prediction (when an analysis
        // existed) with the actual outcome. buildHistoryRecord gates terminal states + measures
        // duration to inc.resolvedAt; null = skip. Collected here, written once below.
        if (svc) {
          const rec = buildHistoryRecord(svc, inc, analysis, now)
          if (rec) historyRecords.push(rec)
        }
      }))
      // Single batched, idempotent write — outlives the 2h ai:analysis/recovered TTLs →
      // prediction-accuracy ledger (Feature 1) + RAG corpus (Feature 2). Best-effort.
      if (historyRecords.length > 0) {
        await appendIncidentHistoryBatch(env.STATUS_CACHE, svcId, historyRecords)
      }
      // #827 F4 — surface "how our estimate held up" on the recovery alert (and the per-user feed,
      // which reuses this description). Built from the records we just joined; only those with a
      // prediction render a line. Operator-safe (no tweet draft / internal data).
      const predictedLines = historyRecords
        .map(r => { const t = predictedVsActualText(r); return t ? `• ${r.title.slice(0, 80)} — ${t}` : null })
        .filter((l): l is string => l != null)
      if (predictedLines.length > 0) {
        recoverySection = `\n${DIV}\n🎯 **AI RECOVERY PREDICTION**\n${predictedLines.slice(0, 3).join('\n')}`
      }
    }

    // The "Incident Resolved" alert (buildIncidentAlerts → alerted:res:) is the resolution path for
    // ALL services — the rarely-firing Tier-1 status-edge alerted:recovered: block above only fires in
    // the incident-less gap. So this block does the two things that path did but for normal incidents:
    //   #847 — write the durable #827 history record for EACH affected service. Previously the corpus
    //     accrued ONLY in the alerted:recovered: block, so a normal incident resolution recorded
    //     NOTHING → the prediction-accuracy ledger + RAG corpus stayed near-empty. Idempotent
    //     (appendIncidentHistoryBatch dedups by incId), so a Tier-1 incident that somehow fired both
    //     paths still records once. Grouped incidents (shared incId across surfaces) record once per
    //     affected service so each surface's own RAG corpus grows; summarizeAccuracy dedups by incId
    //     so that does NOT multi-count the shared prediction in the accuracy metric.
    //   #846 — build the 🎯 prediction line for the embed from the PRIMARY service (one line/incident),
    //     same single-line wording as Slack /feed. Null (omitted) when no numeric estimate — matching /feed.
    // Best-effort per service (guarded) — a KV/lookup failure must never abort the operator send. The
    // outer `for (const alert of sent)` loop is sequential, so per-svcId appendIncidentHistoryBatch RMWs
    // across sibling alerts don't race (mirrors why the alerted:recovered: block batches).
    if (alert.key.startsWith('alerted:res:')) {
      const now = new Date().toISOString()
      const affectedIds = alert.svcIds ?? []
      const primaryId = affectedIds[0]
      // #1003 — a COLLAPSED resolved alert (merged xAI regions / Together models) carries EVERY merged
      // incident's key in `_mergedKeys` (a replacement list — `_mergedKeys[0] === alert.key`; see
      // alerts.ts `mergeTogetherAlerts`/`mergeXaiRegionalAlerts`), while `alert.key` alone is just the
      // first. Processing only `alert.key` left every other merged incident with no marker, no
      // `resolvedAt` stamp and no corpus record — a 3-region xAI resolution lit the banner for one
      // incident and left the other two invisible. `?? [alert.key]` is the repo-wide idiom for this.
      const incIds = (alert._mergedKeys ?? [alert.key])
        .filter(k => k.startsWith('alerted:res:'))
        .map(k => k.slice('alerted:res:'.length))
      const primaryIncId = incIds[0]
      for (const svcId of affectedIds) {
        // Collect this service's records across every merged incident, then write them in ONE batched
        // RMW — the same lost-update guard the status-edge block uses on `incident:history:{svcId}`.
        const records: IncidentHistoryRecord[] = []
        const svc = scored.find(s => s.id === svcId)
        for (const incId of incIds) {
          try {
            const inc = svc ? (svc.incidents ?? []).find(i => i.id === incId) : undefined
            if (!svc || !inc) continue
            // #1003 — THIS is the path a normal incident resolution takes, and it never wrote the two
            // things the read surfaces need: the `recovered:` marker (the "Recently Resolved" banner)
            // and `resolvedAt` on the analysis (the modal + is-down "Predicted vs actual" verdict).
            // Both were written only by the rarely-firing status-edge block above, which is why those
            // three surfaces effectively never appeared while Discord and /feed worked fine.
            const analysis = await markIncidentResolved(env.STATUS_CACHE, svc.id, inc, now)
            // #847 — durable corpus record joining prediction + actual outcome (best-effort, idempotent).
            const rec = buildHistoryRecord(svc, inc, analysis, now)
            if (rec) records.push(rec)
            // #846 — ONE prediction line for the embed: primary service, primary incident.
            if (svcId === primaryId && incId === primaryIncId && !recoverySection) {
              const line = resolvedPredictionLine(analysis, inc)
              if (line) recoverySection = `\n${DIV}\n${line}`
            }
          } catch (err) {
            console.warn('[cron] #846/#847 resolved corpus/prediction failed (alert still sent):', svcId, incId, err instanceof Error ? err.message : err)
          }
        }
        if (records.length > 0) await appendIncidentHistoryBatch(env.STATUS_CACHE, svcId, records)
      }
    }

    // #882 — the new-incident AI analysis + AI-hold gate ran ABOVE (before the roster write), so
    // `analysisSection` is already resolved here (from KV or the inline call) and a held alert has
    // already `continue`d. The #679 detection-lead per-incident signal was removed (status-page
    // polling is structurally later than the official publish, so the lead was always negative);
    // `detected:{svcId}` is still written earlier for #677's AWS duration anchor.

    // Build sectioned description: incident → AI analysis → (recovery prediction) → fallback → link
    const parts = [alert.description]
    if (analysisSection) parts.push(analysisSection)
    if (recoverySection) parts.push(recoverySection) // #827 F4 status-edge recovery + #846 alerted:res: prediction
    if (alert.fallbackText && alert.fallbackText.startsWith('👉')) {
      const list = alert.fallbackText.replace('👉 Suggested fallback: ', '')
      parts.push(`${DIV}\n👉 **SUGGESTED FALLBACK**\n• ${list}`)
    } else if (alert.fallbackText) {
      parts.push(`${DIV}\n${alert.fallbackText}`)
    }
    // #422 — region-switch hint below the cross-service fallback. Cheaper first-line
    // action (same SDK/IAM) when the outage is region-specific with healthy regions left.
    if (alert.regionText) parts.push(`${DIV}\n${alert.regionText}`)
    // #936 — tag the primary CTA so alert clicks attribute to `discord/notification` instead of
    // collapsing to (direct). The per-user relay rewrites this to a tagged is-down link (toPerUserEntry).
    parts.push(`${DIV}\n[View on AIWatch](${appendUtm(alert.url, 'discord')})`)
    const description = parts.join('\n')
    // #475 invariant: the per-user relay feed must use the CLEAN description — build it before the
    // operator-only tweet draft is appended, so the draft (an operator action) never reaches a
    // visitor's webhook.
    const feedEntry = buildFeedEntry(alert, description, scored)
    if (feedEntry) feedEntries.push(feedEntry)
    // #348/#521 — operator-only tweet draft(s) + X compose link(s) for Claude/OpenAI-family alerts.
    // A grouped multi-surface incident yields one draft per affected surface so the operator PICKS
    // which to post (instead of a single auto-chosen primary). Guarded: the draft is an optional
    // nicety, so a bug here must never abort the send loop or the post-loop feed append (the operator
    // alert is the critical path). Log so it's diagnosable.
    let drafts: ReturnType<typeof buildTweetDrafts> = []
    try {
      drafts = buildTweetDrafts(alert, scored)
    } catch (err) {
      console.error('[cron] tweet draft build failed (alert still sent):', alert.key, err instanceof Error ? err.message : err)
    }
    // appendTweetDraftSection is length-guarded (Discord 4096 cap) so a multi-link draft can never
    // push the description over the limit and drop the whole operator alert.
    // #535 — defuse the bare "claude.ai" domain so Discord doesn't unfurl a thumbnail into the
    // operator embed. Defuse the title + the main description BEFORE appending the tweet draft, so
    // the draft's X intent URL keeps the real branded "claude.ai" tweet text (the blockquote/label
    // inside appendTweetDraftSection are defused there). The per-user feed (built above from the
    // clean `description`) is intentionally untouched — this is the operator surface only.
    const withDrafts = appendTweetDraftSection(defuseAutolinkDomain(description), drafts, DIV)
    // #777 — operator-only "find tweets to reply to" X-search links, appended after the draft. Same
    // length-guard + same operator-only boundary (never on the per-user feed built above). Guarded like
    // the draft build so a bug here can't abort the critical operator send.
    let searches: ReturnType<typeof buildTweetSearches> = []
    let reply: ReturnType<typeof buildReplyDraft> = null
    try {
      searches = buildTweetSearches(alert, scored)
      reply = buildReplyDraft(alert, scored)
    } catch (err) {
      console.error('[cron] tweet search build failed (alert still sent):', alert.key, err instanceof Error ? err.message : err)
    }
    const withSearches = appendTweetSearchSection(withDrafts, searches, reply, DIV)
    // #1182 — operator-only Reddit engagement links, appended after the X block. Same operator-only
    // boundary (never on the per-user feed built above) and the same guard: a bug here must not abort
    // the critical send. Pure string-building — no Reddit fetch, so unlike #1138 it does not depend on
    // #820's Data API approval and cannot be throttled by Reddit's per-IP 429.
    // The guard covers the RENDER too, not just the build: the dedup keys are written ~230 lines
    // above, so a throw here would lose this alert permanently AND skip every remaining alert in
    // `sent` (the loop has no per-alert try) along with the per-user relay and the #488 cache refresh.
    let operatorDescription = withSearches
    try {
      const redditTargets = buildRedditEngageTargets(alert, scored)
      operatorDescription = appendRedditSection(withSearches, redditTargets, DIV)
      // The cap-drop is otherwise indistinguishable from "no targets" — same byte-identical output,
      // no error. Without this, "why did the Reddit links stop appearing on big outages?" is
      // unanswerable from the logs, and a merged Tier-1 alert is exactly where the budget runs out.
      if (redditTargets.length > 0 && operatorDescription === withSearches) {
        console.warn('[cron] #1182 reddit section dropped (embed cap):', alert.key, 'desc=', withSearches.length, 'targets=', redditTargets.length)
      }
    } catch (err) {
      console.error('[cron] reddit engage build/render failed (alert still sent):', alert.key, err instanceof Error ? (err.stack ?? err.message) : err)
    }
    const operatorSent = await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
      title: defuseAutolinkDomain(alert.title),
      description: operatorDescription,
      color: alert.color,
    })
    // #1106 Part 5 — stamp the durable log's `announcedAt` HERE, after the send and gated on its
    // result. `sendDiscordAlert` never throws (it returns false on a non-2xx or a network error), and
    // the `alerted:wd:` dedup key was already written above — so a failed send is permanent: the
    // alert will never re-fire. Stamping before the send would therefore let the log record
    // "the thread was closed" for a notice nobody received, which is exactly the reassuring-direction
    // lie the whole module exists to prevent. A failure leaves the row un-announced (it will read
    // `neverClosed` once its deadline passes, which is the truth) and says so loudly, because nothing will retry it.
    // Fail-soft — bookkeeping must never affect the alerting that follows.
    const wdIds = withdrawalIdsFromAlertKeys(keysToWrite)
    if (wdIds.size > 0) {
      if (!operatorSent) {
        // OPERATOR webhook only: the #486 per-user relay and the `alert:feed` projection are built
        // from this same alert and fan out after the loop, unaffected by this failure. So the row
        // reading `neverClosed` at its deadline means "no operator notice went out", not "nobody was told".
        console.error('[cron] #1106 ⚪ withdrawal notice FAILED to send to the OPERATOR webhook and will never retry (the alerted:wd dedup key is already written; the per-user relay is unaffected) — leaving the row un-announced:', [...wdIds].join(', '))
      } else {
        try {
          await markWithdrawalsAnnounced(env.STATUS_CACHE, wdIds, new Date())
        } catch (err) {
          console.error('[cron] #1106 withdrawal-log announce stamp failed (notice still sent):', err instanceof Error ? err.message : err)
        }
      }
    }
    // #936 — send the tweet-reply draft as its OWN plain-text operator message right below the embed so
    // it's one-tap copyable on Discord MOBILE (the embed code block only copies cleanly on desktop; the
    // embed now just points here). Operator channel ONLY (never the per-user relay). Fully isolated: a
    // failure here must never affect the alert already sent above. `reply` is already defused (#539).
    if (reply) {
      try {
        await sendDiscordMessage(env.DISCORD_WEBHOOK_URL, reply.text)
      } catch (err) {
        console.error('[cron] reply copy message failed (operator alert sent):', alert.key, err instanceof Error ? err.message : err)
      }
    }
    // #778 — operator phone push for a Tier-1-family NEW down/degraded incident, so the short (~1–2h)
    // reply window isn't missed when the Discord channel is buried. Gated + scoped by pushTargetFor;
    // the Click target is the same #777 Top-search URL (push → tap → viral tweets). Fires AFTER the
    // Discord send and is fully isolated (its own try + sendPushAlert fail-soft) so it can never block
    // or abort the critical operator alert. Skipped entirely when NTFY_TOPIC is unset.
    try {
      const pushTarget = pushTargetFor(alert, scored)
      if (pushTarget) {
        const clickUrl = buildTweetSearchUrl(pushTarget.svcId) ?? alert.url
        const delivered = await sendPushAlert(
          env,
          `${pushTarget.serviceName} incident detected`,
          'Tap to find tweets to reply to — the reply window is short.',
          clickUrl,
        )
        if (delivered) pushesSent++ // #815 — only count an actually-delivered push (observability)
      }
    } catch (err) {
      console.error('[cron] push alert failed (Discord alert sent):', alert.key, err instanceof Error ? err.message : err)
    }
  }
  // #475 — single read-modify-write after the send loop (alerts are infrequent; negligible KV budget).
  // Best-effort (must not affect the operator sends above), but a failure means EVERY per-user webhook
  // misses this cycle's alerts — log loudly so a whole-cohort relay miss is diagnosable, not buried.
  if (env.STATUS_CACHE && feedEntries.length > 0) {
    const feedOk = await appendAlertFeed(env.STATUS_CACHE, feedEntries)
    if (!feedOk) console.error('[cron] alert feed append failed:', feedEntries.map(e => e.key))

    // #486 PR3 — server-side per-user delivery. Fan the just-built entries out to every confirmed
    // subscriber (this replaced the old browser relay). Reuses the in-memory feedEntries (already
    // appended above — no KV re-read). Fully isolated from the operator path: deliverToSubscribers
    // catches per-sub errors via allSettled + prunes dead webhooks, and the whole call is wrapped so
    // a fan-out failure can never affect the operator sends above or the rest of the cron. postEmbed
    // re-validates the decrypted URL (defense in depth) and mirrors sendDiscordAlert's embed shape so
    // user alerts are byte-identical to the operator's.
    // Observability: deliverToSubscribers is a silent no-op when the enc key is missing/invalid (it
    // can't decrypt any stored URL). Surface that explicitly so a key removed/rotated AFTER subs exist
    // doesn't kill per-user delivery invisibly (subscribe-time already fails closed with 503).
    if (!isValidEncKey(env.WEBHOOK_ENC_KEY)) {
      console.warn(`[cron] WEBHOOK_ENC_KEY missing/invalid — per-user fan-out skipped for ${feedEntries.length} entr${feedEntries.length === 1 ? 'y' : 'ies'}`)
    }
    try {
      const stats = await deliverToSubscribers(
        env.STATUS_CACHE,
        env.WEBHOOK_ENC_KEY,
        feedEntries,
        async (webhookUrl, entry) => {
          if (!isAllowedAlertWebhook(webhookUrl)) {
            // A stored URL that no longer passes the SSRF allowlist (e.g. allowlist tightened, or a
            // pre-validation sub). classifyDelivery(403) → retry → prune after MAX_FAIL_COUNT; log the
            // reason so that prune is attributable, not indistinguishable from a transient failure.
            console.warn('[cron] subscriber webhook rejected by allowlist re-validation — will prune after repeated cycles')
            return 403
          }
          try {
            const resp = await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                embeds: [{ ...entry.embed, timestamp: new Date().toISOString(), footer: { text: 'AIWatch Worker' } }],
              }),
            })
            resp.body?.cancel()
            return resp.status
          } catch (err) {
            console.warn('[cron] subscriber webhook POST failed:', err instanceof Error ? err.message : err)
            return null
          }
        },
        Date.now(),
      )
      if (stats.attempted > 0 || stats.pruned > 0) {
        console.log(`[cron] webhook fan-out: ${stats.delivered}/${stats.attempted} delivered, ${stats.pruned} pruned, ${stats.failed} failed, ${stats.rejected} rejected`)
      }
    } catch (err) {
      console.error('[cron] webhook fan-out failed:', err instanceof Error ? err.message : err)
    }
  }

  // Track daily alert count in KV for Daily Summary
  if (sent.length > 0) {
    try {
      const today = new Date().toISOString().split('T')[0]
      const countKey = `alert:count:${today}`
      const countRaw = await env.STATUS_CACHE.get(countKey).catch(() => null)
      const counts = countRaw ? JSON.parse(countRaw) : { incidents: 0, resolved: 0, down: 0, degraded: 0, recovered: 0 }
      for (const a of sent) {
        if (heldNewAlertKeys.has(a.key)) continue // #882 — held this cycle, not actually sent
        const n = a._mergedKeys?.length ?? 1
        if (a.key.startsWith('alerted:new:')) counts.incidents += n
        else if (a.key.startsWith('alerted:res:')) counts.resolved += n
        else if (a.key.startsWith('alerted:down:')) counts.down++
        else if (a.key.startsWith('alerted:degraded:')) counts.degraded++
        else if (a.key.startsWith('alerted:recovered:')) counts.recovered++
      }
      await kvPut(env.STATUS_CACHE, countKey, JSON.stringify(counts), { expirationTtl: 172800 })
    } catch (err) {
      console.error('[cron] alert count update failed:', err instanceof Error ? err.message : err)
    }
  }

  // #815 — track delivered Tier-1 ntfy pushes (#778) so the daily summary can surface a count;
  // makes the push observable without needing the phone (closes the #778 verify gap). Accumulating
  // 2-day-TTL counter, mirrors alert:count. Best-effort — never affects the alert path.
  if (pushesSent > 0) {
    try {
      const today = new Date().toISOString().split('T')[0]
      const pushKey = `push:count:${today}`
      const prev = parseInt((await env.STATUS_CACHE.get(pushKey).catch(() => null)) ?? '0', 10) || 0
      await kvPut(env.STATUS_CACHE, pushKey, String(prev + pushesSent), { expirationTtl: 172800 })
    } catch (err) {
      console.error('[cron] push count update failed:', err instanceof Error ? err.message : err)
    }
  }

  // #488 — refresh the status cache on a status-change edge so OG/SEO surfaces (which read CACHE_KEY
  // via /api/status/cached) reflect an incident within one cron cycle, instead of lagging up to the
  // 10-min cacheWrite throttle. Reuses the live `services` the cron already alerted on (RAW
  // ServiceStatus[], matching cacheWrite's contract — NOT `scored`; /api/status/cached recomputes
  // scores on read). Writes only when an alert fired (sent.length > 0). Bypasses the throttle
  // (event-driven, rare) — see cache-refresh.ts. Align lastKvWrite so a same-isolate /api/status
  // doesn't immediately double-write.
  //
  // Known limitation (#488): this refreshes on status *edges* (alert fired), so the OG card's status
  // is correct from the down-edge onward, but the AIWatch Score keeps drifting through a long incident
  // and is only re-snapshotted at the next edge (recovery) or by the throttled /api/status path. The
  // headline (status flip) is fixed; continuous score freshness during an active incident is a
  // deliberate non-goal here (it would mean a KV write every cron while any incident is active).
  const refreshed = await refreshStatusCacheOnChange(env.STATUS_CACHE, services, upstreamFeeds, sent.length, CACHE_KEY, CACHE_TTL_SECONDS)
  // Escalated to error (not warn): a failed refresh silently reintroduces the exact staleness bug
  // #488 fixes, and it's most likely to fail precisely during an incident (KV under write pressure).
  // kvPut already logs the underlying cause; this records the user-facing impact at the same severity
  // the sibling cacheWrite uses for KV failures.
  if (refreshed) lastKvWrite = Date.now()
  else if (sent.length > 0) console.error('[cron] status-change cache refresh failed — OG/SEO previews may show pre-incident state until the next /api/status write')

  // #887 — IndexNow: on a status-change edge, push the affected is-down URLs to Bing/Yandex/Naver so
  // status queries recrawl fast (QDF). Google ignores IndexNow — this covers the rest (Naver = KR).
  // Best-effort + isolated: pingIndexNow never throws, and the extra guard means a ping can never
  // affect the alert path even if the fetch layer changes.
  if (sent.length > 0) {
    // Resolve each alert's services the canonical way (mirrors buildFeedEntry): incident alerts carry
    // `svcIds`; status-edge alerts (down/degraded/recovered) don't — their svcId is the key tail, so
    // `svcIdsForAlert` recovers it. Using `a.svcIds ?? []` alone would silently drop a Tier-1 status
    // flip in the incident-less gap — exactly the highest-value is-down page to recrawl.
    const changedSvcIds = [...new Set(sent.flatMap((a) => {
      const kind = kindFromKey(a.key)
      return kind ? (a.svcIds ?? svcIdsForAlert(a._mergedKeys ?? [a.key], kind, scored)) : []
    }))]
    try { await pingIndexNow(changedSvcIds) } catch { /* isolated — never affects the cron */ }
  }

  // #500 — persistent (1h+) status-page block alert. Independent of the status-alert path above:
  // sweeps the tracking:state blob's failSince fields (#1224) and warns the operator once per blocked service per 24h.
  // #800 — skip the daily persistent-failure warning for KNOWN-deactivated sources (operator-acknowledged).
  const deactivatedSourceIds = new Set(SERVICES.filter(c => c.statusSourceDeactivated).map(c => c.id))
  await checkPersistentFetchFailures(env.STATUS_CACHE, env.DISCORD_WEBHOOK_URL, services, Date.now(), sendDiscordAlert, deactivatedSourceIds)

  // Refresh TTL on existing AI analyses / re-analyze missing ones (max 2 per cron)
  // monitoring = "recovery confirmed, verifying" — treat as inactive (no TTL refresh)
  const activeServices = scored.filter(s =>
    (s.incidents ?? []).some(i => i.status !== 'resolved' && i.status !== 'monitoring')
  )
  await refreshOrReanalyze(activeServices, env.STATUS_CACHE, env.ANTHROPIC_API_KEY, analyzeIncidentDetailed, 2, Date.now(), env.AI, heldNewIncIds)

  // Component ID mismatch detection (#135) — alert when statusComponentId is not found
  const mismatches = await detectComponentMismatches(COMPONENT_ID_SERVICES, env.STATUS_CACHE)
  for (const svc of mismatches) {
    try {
      await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
        title: `⚠️ Component ID Mismatch: ${svc.name}`,
        description: `Configured \`statusComponentId\`: \`${svc.statusComponentId}\`\nComponent not found in status page API for ${svc.missCount}+ consecutive checks.\n\n**Action**: Verify the component ID at the provider's status page and update \`worker/src/services.ts\` if migrated.`,
        color: 0xFFA500,
      })
      await kvPut(env.STATUS_CACHE, svc.alertKey, '1', { expirationTtl: 86400 })
    } catch (err) {
      console.error(`[cron] component mismatch alert failed for ${svc.id}:`, err instanceof Error ? err.message : err)
    }
  }

  // Partial component resolve detection (#1179) — the miss alert above watches the PRIMARY
  // statusComponentId only, so a service resolving its badge from some but not all of its configured
  // ids reaches nobody. Time-based (6h), so a summary.json that rotates which components it serves
  // (#1125) cannot page on a single cycle.
  const partialNow = Date.now()
  const partials = await detectPartialResolves(PARTIAL_COMPONENT_SERVICES, env.STATUS_CACHE, partialNow)
  for (const svc of partials) {
    try {
      // Dedup marker written only on a SUCCESSFUL send — `sendDiscordAlert` returns false rather than
      // throwing on a webhook failure, so writing unconditionally would swallow this page for 24h on
      // a 429. Same gating as the #500 persistent-failure and #992 new-component sends; the older
      // #135 block above predates it.
      const sent = await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
        title: `⚠️ Partial Component Resolve: ${svc.name}`,
        description: formatPartialResolveAlert(svc.name, svc.missing, svc.since, partialNow, svc.viaSummary),
        color: 0xFFA500,
      })
      if (sent) {
        await kvPut(env.STATUS_CACHE, svc.alertKey, '1', { expirationTtl: 86400 })
      } else {
        console.error(`[cron] partial resolve alert for ${svc.id} was NOT delivered — not deduped, retries next cron`)
      }
    } catch (err) {
      console.error(`[cron] partial resolve alert failed for ${svc.id}:`, err instanceof Error ? err.message : err)
    }
  }

  // New status-page component detection (#992) — the inverse of the #135 miss alert: fires once, ever,
  // when a provider ADDS a component AIWatch has never seen for that page. Bootstraps silently on first
  // sight (per page), so it never dumps a rich shared page's existing components. Data comes free from
  // the cron's live prefetch (cronPageComponents); a fresh-cache cycle leaves it empty and just skips.
  for (const [apiUrl, components] of Object.entries(cronPageComponents)) {
    try {
      // Fail-CLOSED on a KV read error: a transient get() fault must NOT be read as "first sight"
      // (which bootstraps silently + overwrites the durable snapshot, permanently dropping the
      // one-shot alert). Distinguish a genuinely-absent key (→ bootstrap) from a read that threw
      // (→ skip this page this cycle, retry next cron with the real snapshot).
      let readFailed = false
      const seenRaw = await env.STATUS_CACHE.get(`component-seen:${apiUrl}`).catch(() => { readFailed = true; return null })
      if (readFailed) continue
      let seen: string[] | null = null
      if (seenRaw !== null) {
        // corrupt snapshot → treat as empty (re-alerts current components, never bootstraps a page we
        // already watched); warn so the rare event is observable rather than silent.
        try { seen = JSON.parse(seenRaw) } catch { console.warn(`[cron] corrupt component-seen snapshot for ${apiUrl} — re-alerting current components`); seen = [] }
      }
      const { newComponents, nextSeen, bootstrap } = diffPageComponents(components, seen)
      if (bootstrap) {
        await kvPut(env.STATUS_CACHE, `component-seen:${apiUrl}`, JSON.stringify(nextSeen)) // no TTL — a page's component identity is durable
        continue
      }
      if (newComponents.length === 0) continue // nextSeen == seen → no write (KV budget)
      // #1125 — a component AIWatch already reads needs no "decide whether to track it" from anyone.
      // Filters the ALERT only: nextSeen still unions every current id below, so a component recorded
      // silently here can never come back as a new-component alert later.
      const { alertable, absorbed } = partitionFirstSeen(newComponents, TRACKED_COMPONENT_IDS)
      if (alertable.length === 0) {
        // Nothing to send, so there is no send to gate the write on — but it must still happen, or the
        // same set is re-diffed and re-written every cron tick. Logged only once the write succeeded:
        // until then nothing is recorded, and the suppression this line describes has not happened.
        if (await kvPut(env.STATUS_CACHE, `component-seen:${apiUrl}`, JSON.stringify(nextSeen))) {
          console.warn(`[cron] ${apiUrl}: recorded ${absorbed.length} first-seen component(s) AIWatch already tracks, without alerting (#1125): ${absorbed.map(c => `${c.name} (${c.id})`).join(', ')}`)
        }
        continue
      }
      if (absorbed.length > 0) {
        console.warn(`[cron] ${apiUrl}: ${absorbed.length} of ${newComponents.length} first-seen component(s) suppressed as already tracked (#1125): ${absorbed.map(c => `${c.name} (${c.id})`).join(', ')}`)
      }
      const pageSvcs = SERVICES.filter(s => s.apiUrl === apiUrl)
      const dynamic = pageSvcs.some(s => s.displayAllComponents)
      const sent = await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
        title: `🆕 New status-page component${alertable.length === 1 ? '' : 's'}: ${pageSvcs.map(s => s.name).join(', ') || apiUrl}`,
        description: formatNewComponentAlert(pageSvcs.map(s => s.name), alertable, dynamic),
        color: 0x3B82F6,
      })
      // Persist ONLY after a CONFIRMED send — sendDiscordAlert returns false (does NOT throw) on a
      // webhook failure, so gating the write on `sent` makes a Discord hiccup retry next cron instead
      // of silently marking the component seen and dropping the one-shot alert.
      if (sent) await kvPut(env.STATUS_CACHE, `component-seen:${apiUrl}`, JSON.stringify(nextSeen))
    } catch (err) {
      console.error(`[cron] new-component detection failed for ${apiUrl}:`, err instanceof Error ? err.message : err)
    }
  }

  const operational = scored.filter(s => s.status === 'operational').length
  // #1233 — `issues` used to be `total − operational`, which silently counted an unreadable source as
  // an issue. Count the affected directly and report the unreadable separately, so the three numbers
  // stay independently meaningful rather than one being the arithmetic residue of the other.
  const unreadable = scored.filter(s => isUnreadableStatus(s.status)).length
  return {
    total: scored.length,
    operational,
    issues: scored.filter(s => isAffectedStatus(s.status)).length,
    unreadable,
    sent: sent.length,
    // #882 — exclude alerts HELD this cycle (they weren't sent); matches the alert:count KV tally so
    // the daily-summary `incidentCountToday` doesn't over-count a held incident that lands next cycle.
    newCount: sent.filter(a => a.key.startsWith('alerted:new:') && !heldNewAlertKeys.has(a.key)).reduce((sum, a) => sum + (a._mergedKeys?.length ?? 1), 0),
    resolvedCount: sent.filter(a => a.key.startsWith('alerted:res:')).reduce((sum, a) => sum + (a._mergedKeys?.length ?? 1), 0),
    downCount: sent.filter(a => a.key.startsWith('alerted:down:')).length,
    recoveredCount: sent.filter(a => a.key.startsWith('alerted:recovered:')).length,
  }
}

// corsHeaders moved to ./cors — also handles team-scoped suffix patterns for Vercel preview origins.

import { generateBadgeSvg, badgeStatusColor } from './badge'
import { buildFeedResponse, resolveFeedFirstSeen, isActiveItemHeld, resolveFeedService, feedHttpResponse, reportArchiveResponse, FEED_XSL, type FeedRequest, type RssAiAnalysisMap } from './rss'
import { generateOgSvg } from './og'
import { detectRedditPosts, formatRedditAlert, formatCompetitiveAlert, formatSecurityAlert as formatRedditSecurityAlert, isPromotable, readRedditSourceDead } from './reddit'
import { detectSecurityAlerts, fetchOSVAlerts, formatSecurityDigest, securityDetectedKey, incrementSecurityCount, readRecentSecurityAlerts, planOsvTimelineCycle } from './security-monitor'
import { detectNewRepos, formatGitHubAlert } from './competitive'
import { buildDailySummary, isInSummaryWindow, classifyDegradation } from './daily-summary'
import { collectChangelogs, getStaleSources } from './changelog'
import { getWeekRange, buildIncidentSummary, buildStabilityChanges, buildWeeklyBriefing, buildSecuritySummary, parseMonthlyIncidents, filterChangelogToWeek, weekDateStrings, parseStrategyBrief } from './weekly-briefing'
import { searchBadgeEmbeds, diffBadgeRepoDiscovery, parseBadgeReposSeen, type BadgeRepoDiscoveryDiff } from './badge-repo-discovery'
import { parseVitals, writeVitalsToKV, readVitalsSummary, archiveVitals } from './vitals'
import { parseReferralBody, recordReferral, type ReferralCounts } from './referral'
import { buildGrowthDailyRow, recordGrowthDaily, countIncidentsInWindow, fillOutageWindows, nominalWindowEnd, previousPeriod, periodsCoveringWindow, type GrowthDailyRow } from './growth-series'
import { parsePageviewBody, recordOutageView, queryOutageAudience, type AudienceCounts } from './outage-audience'
import { archiveProbeDaily, cacheProbeSummaries, getCachedProbeSummaries, type ProbeDailyData } from './probe-archival'
import type { ProbeSummary, Incident } from './types'
import { buildMonthlyArchive, isInMonthlyArchiveWindow, accumulateIncidentsOnlyIfChanged, buildPartialIncidentArchive, filterSuppressedFromMonthly, buildArchiveReadyEmbed, archiveNotifiedKey, degradationMonthlyKey, addDegradationToMonthly, normalizeDegradationMonthly, DEGRADATION_MONTHLY_TTL_SECONDS, toArchiveScoreInput, type ArchiveScoreInput, type ScoreGrade, type MonthlyIncidents } from './monthly-archive'
import { checkPlatformStatus, formatPlatformOutageAlert, formatPlatformRecoveryAlert, platformStatusKey, platformAlertKey, countPlatformServices, type PlatformStatus } from './platform-monitor'

// ── #299: sticky-aware analysis write ─────────────────────────

/**
 * Inspect an existing raw JSON payload at `ai:analysis:{svcId}:{incId}` and
 * return true if it's a sticky operator override that must NOT be overwritten.
 * Corrupt JSON is treated as non-sticky (proceed with overwrite) — that's the
 * safer default since a stuck-sticky corrupt payload would lock the key for the
 * full incident lifetime.
 */
export function isStickyExistingAnalysis(rawJson: string | null): boolean {
  if (!rawJson) return false
  try {
    const existing = JSON.parse(rawJson) as { sticky?: unknown }
    return existing.sticky === true
  } catch {
    return false
  }
}

// ── #299: POST /api/admin/analyze ─────────────────────────────

/**
 * Constant-time string comparison. Prevents timing-side-channel leaks of the
 * admin secret. Short-circuits on length mismatch (that's already observable
 * from the 401 anyway); diverges only on same-length different strings.
 * Workers runtime doesn't expose `crypto.timingSafeEqual`, so we roll our own.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/** SHA-256 hex of svcId:incidentId — used as rate-limit KV key suffix. */
export async function adminRateLimitKey(svcId: string, incidentId: string): Promise<string> {
  const data = new TextEncoder().encode(`${svcId}:${incidentId}`)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
  return `admin:ratelimit:${hex.slice(0, 32)}` // 128-bit prefix is plenty
}

interface AdminAnalyzeRequest {
  svcId?: unknown
  incidentId?: unknown
  model?: unknown
  sticky?: unknown
}

/**
 * Look up the active incident matching svcId + incidentId in `services:latest`.
 * Reading from the cache (5min TTL) avoids a 5-10s live fetch on every admin
 * request; the operator's "I need this now" is still same-cron-cycle fresh.
 * Returns null if service or incident not found — caller translates to 404.
 */
async function findActiveIncident(kv: KVNamespace, svcId: string, incidentId: string): Promise<{ service: ServiceStatus; incident: Incident } | null> {
  const raw = await kv.get(CACHE_KEY).catch(err => {
    console.warn('[admin/analyze] services:latest KV read failed:', err instanceof Error ? err.message : err)
    return null
  })
  if (!raw) return null
  let payload: { services?: ServiceStatus[] }
  try {
    payload = JSON.parse(raw)
  } catch (err) {
    // Parity with other JSON.parse sites in this file — corrupt `services:latest`
    // is never expected and should be visible in logs, not silently collapsed to 404.
    console.error('[admin/analyze] services:latest corrupt JSON:', err instanceof Error ? err.message : err)
    return null
  }
  const service = payload.services?.find(s => s.id === svcId)
  if (!service) return null
  const incident = (service.incidents ?? []).find(i => i.id === incidentId && i.status !== 'resolved')
  if (!incident) return null
  return { service, incident }
}

async function handleAdminAnalyze(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (!env.ADMIN_API_KEY) {
    // Missing secret — same error surface as wrong key (no info leak about config state).
    return json(401, { ok: false, error: 'unauthorized' })
  }
  const provided = request.headers.get('X-Admin-Key') ?? ''
  if (!constantTimeEqual(provided, env.ADMIN_API_KEY)) {
    return json(401, { ok: false, error: 'unauthorized' })
  }

  if (!env.ANTHROPIC_API_KEY) {
    return json(503, { ok: false, error: 'ANTHROPIC_API_KEY not configured' })
  }

  let body: AdminAnalyzeRequest
  try { body = await request.json() } catch { return json(400, { ok: false, error: 'invalid JSON body' }) }

  const svcId = typeof body.svcId === 'string' ? body.svcId : ''
  const incidentId = typeof body.incidentId === 'string' ? body.incidentId : ''
  const model = body.model === 'gemma' ? 'gemma' : 'sonnet'  // default sonnet — manual trigger implies escalation
  const sticky = body.sticky === false ? false : true        // default true — operator override should survive cron updates
  if (!svcId || !incidentId) {
    return json(400, { ok: false, error: 'svcId and incidentId are required' })
  }

  // Rate limit: 1 request per svcId+incidentId per 60s. KV-based so it survives
  // isolate restarts (in-memory Map would not, which matters for a route an
  // operator might hammer during an outage from multiple tabs).
  const rlKey = await adminRateLimitKey(svcId, incidentId)
  // Fail-open with a log: a silent KV outage here would let an operator bypass
  // rate limiting entirely (burning Anthropic tokens during a retry storm). We
  // prefer to know about it rather than silently degrade — but still serve the
  // request rather than block legitimate operator work on a transient KV blip.
  const rlHit = await env.STATUS_CACHE.get(rlKey).catch(err => {
    console.warn('[admin/analyze] rate-limit KV read failed; bypassing:', err instanceof Error ? err.message : err)
    return null
  })
  if (rlHit) return json(429, { ok: false, error: 'rate limited — try again in a moment' })

  // Scope guard: only allow IDs that exist as active incidents. Prevents spraying
  // arbitrary KV keys via the endpoint if the admin secret ever leaks.
  const active = await findActiveIncident(env.STATUS_CACHE, svcId, incidentId)
  if (!active) return json(404, { ok: false, error: `no active incident ${svcId}:${incidentId}` })

  // Write rate-limit marker BEFORE the expensive call so two concurrent requests
  // don't both get through. TTL is a hard 60s — if the analysis takes longer than
  // that, a retry is allowed (which is fine — the worst case is a double-write).
  await env.STATUS_CACHE.put(rlKey, '1', { expirationTtl: 60 }).catch(err =>
    console.warn('[admin/analyze] rate-limit write failed:', err instanceof Error ? err.message : err),
  )

  const { service, incident } = active
  const similar = findSimilarIncidents(incident.title, service.incidents ?? [])
  const prompt = buildAnalysisPrompt(service.name, {
    // #533 Phase 2 — buildAnalysisPrompt's param has no `id` (unused by the prompt); drop the excess key.
    title: incident.title, status: incident.status,
    startedAt: incident.startedAt, impact: incident.impact, timeline: incident.timeline,
  }, similar)
  const timelineAt = incident.timeline?.at(-1)?.at ?? ''

  // #955 — the operator reaches for this endpoint precisely WHEN the automated path is broken,
  // so it must not repeat the bug it exists to work around: report the upstream status + detail
  // rather than a bare "returned null", and book the failure into ai:usage like every other path.
  let attempt: AnalysisAttempt
  // Extra diagnostics for the sonnet path — `outcome` carries the upstream status + body.
  let sonnetOutcome: AnthropicOutcome | null = null
  try {
    if (model === 'sonnet') {
      const { result, outcome } = await analyzeWithSonnetDetailed(env.ANTHROPIC_API_KEY ?? '', prompt, incident.id, timelineAt)
      sonnetOutcome = outcome
      const failure: AnalysisFailureKind | null = result
        ? null
        : outcome.kind === 'transient' ? 'transient' : outcome.kind === 'aborted' ? 'aborted' : 'permanent'
      attempt = { result, failure, attempts: { gemma: 0, sonnet: 1 } }
    } else {
      // Gemma path: go via analyzeIncidentDetailed (tries Gemma first, falls back to Sonnet).
      // The operator picked 'gemma' explicitly, but if Workers AI returns null we'd
      // rather ship a Sonnet result than error out.
      attempt = await analyzeIncidentDetailed(env.ANTHROPIC_API_KEY, service.name, {
        id: incident.id, title: incident.title, status: incident.status,
        startedAt: incident.startedAt, impact: incident.impact, timeline: incident.timeline,
      }, service.incidents ?? [], undefined, env.AI, await readIncidentHistory(env.STATUS_CACHE, service.id))
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'analysis failed'
    await recordUsage(env.STATUS_CACHE, Date.now(), { result: null, failure: 'unknown', attempts: { gemma: 0, sonnet: 0 } }, svcId)
    return json(502, { ok: false, error: 'analysis failed', detail: message })
  }

  const analysis = attempt.result
  if (!analysis) {
    // Book the failure like every other path, then tell the operator WHY — a bare
    // "returned null" is what made the retired model id so hard to find in the first place.
    await recordUsage(env.STATUS_CACHE, Date.now(), attempt, svcId)
    const upstream = sonnetOutcome && (sonnetOutcome.kind === 'permanent' || sonnetOutcome.kind === 'transient')
      ? { status: sonnetOutcome.status, detail: sonnetOutcome.detail }
      : {}
    return json(502, {
      ok: false,
      error: 'analysis returned null — upstream model error or unparseable response',
      kind: attempt.failure,
      ...upstream,
    })
  }

  if (sticky) analysis.sticky = true

  // Bump ai:usage:{date} so the Daily Summary attributes the manual call. Routed through the
  // shared `recordUsage`/`applyAttempt` (#955) so the manual path books attempt counts too and
  // cannot drift from the cron's ledger. Bookkeeping — never fails the request.
  //
  // Booked BEFORE the KV persist: the model call already happened and already cost money, so a
  // failed persist must not erase it from the ledger. "A call happened but the ledger doesn't
  // show it" is the exact class of blindness #955 exists to remove.
  await recordUsage(env.STATUS_CACHE, Date.now(), attempt, svcId)

  const key = analysisKey(svcId, incidentId)
  const ttl = 3600
  // #1003 — an operator re-analysis re-estimates a live incident too, so it must not rewrite the
  // scoring baseline: `putAnalysis` pins the first estimate exactly as the cron's paths do.
  const prior = parseAnalysis(await env.STATUS_CACHE.get(key).catch(() => null))
  const written = await putAnalysis(env.STATUS_CACHE, svcId, incidentId, analysis, prior, ttl)
  if (!written.ok) return json(502, { ok: false, error: 'KV write failed', detail: written.error })

  return json(200, { ok: true, wrote: key, ttl, analysis: written.pinned })
}

// ── POST /api/internal/edge-fallback ───────────────────────────
// #378: Vercel Edge Functions (api/is-down.ts, api/reports.ts) call this when they
// fall back to a degraded render because the upstream Worker fetch failed. Worker
// dedups via KV (5-minute cooldown per surface+slug) and fires a single Discord
// alert to the operator webhook so silent CDN-cached failures get noticed.
//
// Auth: Bearer token in Authorization header, validated against EDGE_ALERT_TOKEN
// secret. Same token must be set in Vercel env so both ends agree. Missing secret
// returns 401 (no info leak about config state).
// EDGE_FALLBACK_ALERT_TTL_S / _KEY_PREFIX live in ./edge-fallback-alert-keys —
// `wrangler dev` rejects const exports from the entry module (see that file).

interface EdgeFallbackRequest {
  surface?: string  // 'is-down' | 'reports'
  slug?: string     // service slug for is-down, path for reports (free-form, capped)
  reason?: string   // short reason string ('worker_unreachable', 'parse_error', etc.)
}

export async function handleEdgeFallbackAlert(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (!env.EDGE_ALERT_TOKEN) return json(401, { ok: false, error: 'unauthorized' })
  const auth = request.headers.get('Authorization') ?? ''
  const expected = `Bearer ${env.EDGE_ALERT_TOKEN}`
  if (!constantTimeEqual(auth, expected)) return json(401, { ok: false, error: 'unauthorized' })

  let body: EdgeFallbackRequest
  try { body = await request.json() } catch { return json(400, { ok: false, error: 'invalid JSON body' }) }

  // Normalize to lowercase before stripping so casing variants share the dedup
  // window (e.g. 'Claude' and 'claude' must collapse to the same key).
  const surface = typeof body.surface === 'string' ? body.surface.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) : ''
  const slug = typeof body.slug === 'string' ? body.slug.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64) : ''
  const reason = typeof body.reason === 'string' ? body.reason.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64) : 'unknown'
  if (!surface || !slug) return json(400, { ok: false, error: 'surface and slug required' })

  const dedupKey = `${EDGE_FALLBACK_ALERT_KEY_PREFIX}${surface}:${slug}`
  const existing = await env.STATUS_CACHE.get(dedupKey).catch(() => null)
  if (existing) return json(200, { ok: true, deduped: true })

  if (!env.DISCORD_WEBHOOK_URL) {
    // Skip dispatch but still write the dedup marker so the next call doesn't
    // recheck immediately — keeps behavior consistent regardless of whether
    // the operator has configured a webhook URL.
    await env.STATUS_CACHE.put(dedupKey, '1', { expirationTtl: EDGE_FALLBACK_ALERT_TTL_S }).catch(() => undefined)
    return json(200, { ok: true, dispatched: false, reason: 'webhook_not_configured' })
  }

  const dispatched = await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
    title: `:warning: Edge SSR fallback: ${surface}/${slug}`,
    description: `Vercel Edge served the degraded "Status data is temporarily unavailable" render because the upstream Worker fetch failed.\n\n**Reason**: \`${reason}\`\n**Surface**: \`${surface}\`\n**Slug**: \`${slug}\`\n\nThe Edge response is now \`Cache-Control: no-store\` (#378) so subsequent requests retry instead of serving stale failure. If this fires repeatedly, check Worker logs and KV health.`,
    color: 0xf0883e,
  })
  // Write the dedup marker even if Discord delivery failed — otherwise a
  // misconfigured webhook produces a thundering herd of retry attempts.
  await env.STATUS_CACHE.put(dedupKey, '1', { expirationTtl: EDGE_FALLBACK_ALERT_TTL_S }).catch(() => undefined)

  return json(200, { ok: true, dispatched })
}

// ── POST /api/internal/deepseek-feed ───────────────────────────
// #618: status.deepseek.com (Flashduty) blocks non-browser TLS fingerprints, so a Worker fetch()
// can't read DeepSeek's live incidents. A scheduled GitHub Action browser-renders the page, fetches
// the Flashduty JSON API, and POSTs the raw { active, changeList, structure } payload here. We cache
// it in KV (DEEPSEEK_FEED_KV_KEY, 3h TTL); fetchService('deepseek') reads + normalizes it (via
// parseFlashdutyFeed) instead of the frozen Atlassian mirror, lifting incidentSourceStale while the
// feed is fresh. Auth: Bearer DEEPSEEK_FEED_TOKEN. Body shape validated minimally; parsing happens
// at read time so a malformed push can't corrupt the served status mid-write.
interface DeepseekFeedRequest {
  active?: unknown
  changeList?: unknown
  structure?: unknown
}

export async function handleDeepseekFeed(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (!env.DEEPSEEK_FEED_TOKEN) return json(401, { ok: false, error: 'unauthorized' })
  const auth = request.headers.get('Authorization') ?? ''
  if (!constantTimeEqual(auth, `Bearer ${env.DEEPSEEK_FEED_TOKEN}`)) return json(401, { ok: false, error: 'unauthorized' })

  let body: DeepseekFeedRequest
  try { body = await request.json() } catch { return json(400, { ok: false, error: 'invalid JSON body' }) }

  // Require at least one of the three sections to be a non-null object — a totally empty push is a
  // scraper bug, not a valid "all clear", and must NOT overwrite a good cached feed.
  const sections = [body.active, body.changeList, body.structure]
  if (!sections.some((s) => s !== null && typeof s === 'object')) {
    return json(400, { ok: false, error: 'at least one of active/changeList/structure (object) required' })
  }

  const feed: FlashdutyFeed = {
    active: (body.active ?? undefined) as FlashdutyFeed['active'],
    changeList: (body.changeList ?? undefined) as FlashdutyFeed['changeList'],
    structure: (body.structure ?? undefined) as FlashdutyFeed['structure'],
  }
  const stored: StoredFlashdutyFeed = { fetchedAt: new Date().toISOString(), feed }
  await kvPut(env.STATUS_CACHE, DEEPSEEK_FEED_KV_KEY, JSON.stringify(stored), { expirationTtl: DEEPSEEK_FEED_TTL_S })

  const incidentCount = feed.changeList?.items?.length ?? 0
  const activeCount = feed.active?.active_changes?.length ?? 0
  return json(200, { ok: true, stored: true, fetchedAt: stored.fetchedAt, incidents: incidentCount, active: activeCount })
}

// ── POST /api/admin/rebuild-archive ─────────────────────────────
// Operator tool to regenerate a specific month's archive:monthly:{YYYY-MM} key.
// Motivated by the discovery that earlier archive cron runs persisted score: null /
// grade: null for every service because cacheWrite never stores those fields and
// the cron read them straight from services:latest. The cron path is now fixed
// (computes score inline via scoreFor + readProbeSummaries) but already-corrupt
// archives (e.g. 2026-04) need a one-shot rebuild — the regular cron skips
// when `existing` and there is no other write path.
//
// Score caveat: rebuilding uses the CURRENT live score (today's 7-day rolling
// window) as a proxy for what should have been captured at archive-cron time.
// Better than null, not as good as a real-time snapshot. Operator should rebuild
// soon after detecting the issue, before the rolling window drifts further from
// the archived month's reality.
interface AdminRebuildArchiveRequest {
  month?: unknown
}

async function handleAdminRebuildArchive(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (!env.ADMIN_API_KEY) {
    return json(401, { ok: false, error: 'unauthorized' })
  }
  const provided = request.headers.get('X-Admin-Key') ?? ''
  if (!constantTimeEqual(provided, env.ADMIN_API_KEY)) {
    return json(401, { ok: false, error: 'unauthorized' })
  }

  let body: AdminRebuildArchiveRequest
  try { body = await request.json() } catch { return json(400, { ok: false, error: 'invalid JSON body' }) }

  const month = typeof body.month === 'string' ? body.month : ''
  // Strict YYYY-MM. Anything else is operator typo — fail loud rather than build the wrong key.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return json(400, { ok: false, error: 'month must be YYYY-MM' })
  }
  const [yearStr, monthStr] = month.split('-')
  const year = Number(yearStr)
  const monthNum = Number(monthStr)

  // Compute scoreData via the same path the (fixed) cron now uses.
  let scoreData: ArchiveScoreInput[] = []
  // service id → display name, for the AI narrative prompt (#426). Populated
  // from the same services:latest read as scoreData.
  const serviceNames: Record<string, string> = {}
  const cachedRaw = await env.STATUS_CACHE.get(CACHE_KEY).catch(() => null)
  if (cachedRaw) {
    try {
      const p = JSON.parse(cachedRaw)
      const services: ServiceStatus[] = Array.isArray(p) ? p : (p.services ?? [])
      const probeSummaries = await readProbeSummaries(env.STATUS_CACHE, 'admin/rebuild-archive')
      scoreData = services.map((s) => toArchiveScoreInput(s, scoreFor(s, probeSummaries)))
      for (const s of services) serviceNames[s.id] = s.name
    } catch (parseErr) {
      console.error('[admin/rebuild-archive] services:latest parse failed:',
        parseErr instanceof Error ? parseErr.message : parseErr)
      // Continue with empty scoreData rather than fail — caller may want to rebuild
      // even when the cache is unreadable, and uptime/incident data is still useful.
    }
  }

  let archive
  try {
    // Regenerate the AI narrative on rebuild too — an operator rebuilding after a
    // bug-fix deploy gets a fresh draft. Best-effort; null on AI failure.
    archive = await buildMonthlyArchive(env.STATUS_CACHE, year, monthNum, scoreData, {
      ai: env.AI,
      apiKey: env.ANTHROPIC_API_KEY,
      serviceNames,
    })
  } catch (err) {
    return json(502, { ok: false, error: 'archive build failed', detail: err instanceof Error ? err.message : String(err) })
  }

  const archiveKey = `archive:monthly:${month}`
  try {
    await env.STATUS_CACHE.put(archiveKey, JSON.stringify(archive))
  } catch (err) {
    return json(502, { ok: false, error: 'KV write failed', detail: err instanceof Error ? err.message : String(err) })
  }

  return json(200, {
    ok: true,
    wrote: archiveKey,
    period: archive.period,
    services: Object.keys(archive.services).length,
    daysCollected: archive.daysCollected,
    servicesWithScore: scoreData.filter(s => s.aiwatchScore !== null).length,
  })
}

// ── #904: GET/POST /api/admin/suppress ───────────────────────────
// Operator-managed incident-suppression list (see suppression.ts). GET returns the current list;
// POST { action:'add'|'remove', scope:'incident'|'service-pattern', incId? | (svcId?+match?), reason? }
// mutates it. Auth via X-Admin-Key (same ADMIN_API_KEY as /api/admin/analyze). The pure add/remove
// logic lives in mutateSuppressions; this wraps it with auth + KV read/write + cache invalidation.
interface AdminSuppressRequest {
  action?: unknown
  scope?: unknown
  incId?: unknown
  svcId?: unknown
  match?: unknown
  reason?: unknown
}

async function handleAdminSuppress(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (!env.ADMIN_API_KEY) return json(401, { ok: false, error: 'unauthorized' })
  const provided = request.headers.get('X-Admin-Key') ?? ''
  if (!constantTimeEqual(provided, env.ADMIN_API_KEY)) return json(401, { ok: false, error: 'unauthorized' })
  if (!env.STATUS_CACHE) return json(503, { ok: false, error: 'Service unavailable' })

  let current: SuppressionEntry[]
  try {
    const raw = await env.STATUS_CACHE.get(SUPPRESSIONS_KEY)
    current = raw ? normalizeSuppressions(JSON.parse(raw)) : []
  } catch (err) {
    console.error('[admin/suppress] KV read failed:', err instanceof Error ? err.message : err)
    return json(502, { ok: false, error: 'failed to read suppression list' })
  }

  if (request.method === 'GET') return json(200, { ok: true, suppressions: current })

  let body: AdminSuppressRequest
  try { body = await request.json() } catch { return json(400, { ok: false, error: 'invalid JSON body' }) }

  const result = mutateSuppressions(current, {
    action: body.action === 'remove' ? 'remove' : body.action === 'add' ? 'add' : ('' as 'add'),
    scope: body.scope === 'incident' ? 'incident' : body.scope === 'service-pattern' ? 'service-pattern' : ('' as 'incident'),
    incId: typeof body.incId === 'string' ? body.incId : undefined,
    svcId: typeof body.svcId === 'string' ? body.svcId : undefined,
    match: typeof body.match === 'string' ? body.match : undefined,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
    by: 'admin',
    createdAt: new Date().toISOString(),
  })
  if (!result.ok) return json(400, { ok: false, error: result.error })

  if (result.changed) {
    try {
      await env.STATUS_CACHE.put(SUPPRESSIONS_KEY, JSON.stringify(result.list))
    } catch (err) {
      console.error('[admin/suppress] KV write failed:', err instanceof Error ? err.message : err)
      return json(502, { ok: false, error: 'failed to write suppression list' })
    }
    invalidateSuppressionCache() // this isolate reflects the change immediately; others within ≤60s
  }
  return json(200, { ok: true, changed: result.changed, suppressions: result.list })
}

// ── #1019: GET/POST /api/admin/duration-override ──────────────────
// Operator-managed incident duration-override list (see overrides.ts). GET returns the current list;
// POST { action:'add'|'remove', id, durationMin?, reason? } mutates it. Auth via X-Admin-Key (same
// ADMIN_API_KEY). Pure add/remove logic lives in mutateOverrides; no cache to invalidate (the apply
// sites read fresh). Corrects a paperwork-inflated duration WITHOUT hiding the incident.
interface AdminOverrideRequest {
  action?: unknown
  id?: unknown
  durationMin?: unknown
  reason?: unknown
}

async function handleAdminOverride(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (!env.ADMIN_API_KEY) return json(401, { ok: false, error: 'unauthorized' })
  const provided = request.headers.get('X-Admin-Key') ?? ''
  if (!constantTimeEqual(provided, env.ADMIN_API_KEY)) return json(401, { ok: false, error: 'unauthorized' })
  if (!env.STATUS_CACHE) return json(503, { ok: false, error: 'Service unavailable' })

  let current: DurationOverride[]
  try {
    const raw = await env.STATUS_CACHE.get(OVERRIDES_KEY)
    current = raw ? normalizeOverrides(JSON.parse(raw)) : []
  } catch (err) {
    console.error('[admin/duration-override] KV read failed:', err instanceof Error ? err.message : err)
    return json(502, { ok: false, error: 'failed to read override list' })
  }

  if (request.method === 'GET') return json(200, { ok: true, overrides: current })

  let body: AdminOverrideRequest
  try { body = await request.json() } catch { return json(400, { ok: false, error: 'invalid JSON body' }) }

  const result = mutateOverrides(current, {
    action: body.action === 'remove' ? 'remove' : body.action === 'add' ? 'add' : ('' as 'add'),
    id: typeof body.id === 'string' ? body.id : undefined,
    durationMin: typeof body.durationMin === 'number' ? body.durationMin : undefined,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
    by: 'admin',
    createdAt: new Date().toISOString(),
  })
  if (!result.ok) return json(400, { ok: false, error: result.error })

  if (result.changed) {
    try {
      await env.STATUS_CACHE.put(OVERRIDES_KEY, JSON.stringify(result.list))
    } catch (err) {
      console.error('[admin/duration-override] KV write failed:', err instanceof Error ? err.message : err)
      return json(502, { ok: false, error: 'failed to write override list' })
    }
  }
  return json(200, { ok: true, changed: result.changed, overrides: result.list })
}

// ── #1106 Part 5: GET /api/admin/withdrawals ──────────────────────
// The read side of the durable withdrawal log (see withdrawal-log.ts). Read-ONLY — this is a record
// of what happened, not an operator control surface like suppress/duration-override, so there is no
// POST: nothing an operator could edit here would be anything but a falsified history.
//
// Behind the admin key rather than public because the rows name incidents a provider chose to delete
// from its own status page. AIWatch republishing that as a permanent public index is a different
// product decision from closing an alert thread with the subscribers who already saw it.
//
// `neverClosed` is DERIVED per row (see `isPermanentlyUnclosed`), so the answer to #1106's actual
// question — "did the ⚪ path fire, and did any thread stay open?" — is the response itself and not
// something the reader has to recompute from timestamps.
async function handleAdminWithdrawals(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (!env.ADMIN_API_KEY) return json(401, { ok: false, error: 'unauthorized' })
  const provided = request.headers.get('X-Admin-Key') ?? ''
  if (!constantTimeEqual(provided, env.ADMIN_API_KEY)) return json(401, { ok: false, error: 'unauthorized' })
  if (!env.STATUS_CACHE) return json(503, { ok: false, error: 'Service unavailable' })

  const now = new Date()
  const params = new URL(request.url).searchParams
  const requested = params.get('month')
  // `01`-`12`, not just two digits: `2026-13` would read a key that cannot exist and answer
  // `200 {count: 0}` — a misleading zero on the one endpoint whose whole contract is never to give one.
  if (requested !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(requested)) {
    return json(400, { ok: false, error: 'month must be YYYY-MM' })
  }
  const rawMonths = params.get('months')
  // Digits only, so `1.5` / `2x` are REJECTED rather than silently truncated by parseInt to a value
  // the caller did not ask for. Bounded at 24: each month is a KV read, and 24 covers any realistic
  // "did this ever fire?" lookback.
  if (rawMonths !== null && !/^\d+$/.test(rawMonths)) {
    return json(400, { ok: false, error: 'months must be an integer 1-24' })
  }
  const monthsBack = rawMonths === null ? 1 : Number.parseInt(rawMonths, 10)
  if (monthsBack < 1 || monthsBack > 24) {
    return json(400, { ok: false, error: 'months must be an integer 1-24' })
  }
  const anchor = requested ? `${requested}-01T00:00:00Z` : now.toISOString()
  const months = monthsBackFrom(anchor, monthsBack)
  if (months.length === 0) return json(400, { ok: false, error: 'month must be YYYY-MM' })

  const nowMs = now.getTime()
  const withVerdict: Array<WithdrawalLogEntry & { neverClosed: boolean }> = []
  const unreadable: string[] = []
  const malformedByMonth: Record<string, number> = {}
  for (const m of months) {
    const res = await readWithdrawalLog(env.STATUS_CACHE, m)
    // An unreadable month is NOT an empty one, and the difference is the whole point of the endpoint:
    // a silent `[]` would read as "no provider ever withdrew an incident" — the exact false negative
    // this instrumentation exists to remove. Reported per month rather than failing the whole range,
    // so one frozen month cannot hide the others; a single-month query still 502s (below).
    if (!res.readable) { unreadable.push(m); continue }
    // Per MONTH, not a range total: the remedy for a partially-eaten month is a by-hand KV repair,
    // and a bare sum tells the operator that rows were lost without saying which key to repair.
    if (res.droppedMalformed > 0) malformedByMonth[m] = res.droppedMalformed
    for (const r of res.rows) withVerdict.push({ ...r, neverClosed: isPermanentlyUnclosed(r, nowMs) })
  }
  if (unreadable.length === months.length) {
    return json(502, {
      ok: false,
      // Not a transient failure: every writer refuses to start from `[]`, so an unreadable month
      // stops recording permanently. Say what the remedy is, or it reads as "retry later".
      error: 'withdrawal log could not be read — these months are frozen until the KV value is repaired or deleted by hand',
      months: unreadable,
    })
  }

  const droppedMalformed = Object.values(malformedByMonth).reduce((a, b) => a + b, 0)
  const partial = unreadable.length > 0 || droppedMalformed > 0
  return json(200, {
    // `ok: false` on a PARTIAL answer, deliberately: every other admin endpoint here trains a caller
    // to branch on `ok`, and a body field it has to know to read would not stop a script (or a future
    // Tier-A `assert:`) from treating a zero computed over a month it could not open as a clean zero.
    // The rows are still returned — this says "do not trust the counts", not "nothing to see".
    ok: !partial,
    partial,
    months,
    // Which months could not be opened at all. Non-empty means the counts below are computed over a
    // subset of the requested range.
    unreadableMonths: unreadable,
    // Same distinction one level down, per month so the operator knows which KV key to repair: rows
    // that failed the shape check were excluded from every count below.
    malformedByMonth,
    droppedMalformed,
    count: withVerdict.length,
    announced: withVerdict.filter((r) => r.announcedAt).length,
    // Split rather than one "not announced" bucket: `pending` is still before its send deadline and
    // may yet notify (normally a `withdrawalHold`), `neverClosed` no longer can. Only the second is
    // the #1106 bug recurring — collapsing them would make a routine hold look like a regression.
    // A row whose `prunedAt` cannot be parsed is neither: it is unageable, so it is counted apart
    // rather than sitting in `pending` forever and quietly inflating the benign bucket. Scoped to
    // un-announced rows so the four buckets really do PARTITION `count` — an announced row with a
    // malformed timestamp would otherwise be counted twice and the totals would not add up.
    pending: withVerdict.filter((r) => !r.announcedAt && !r.neverClosed && !Number.isNaN(Date.parse(r.prunedAt))).length,
    neverClosed: withVerdict.filter((r) => r.neverClosed).length,
    malformedTimestamp: withVerdict.filter((r) => !r.announcedAt && Number.isNaN(Date.parse(r.prunedAt))).length,
    withdrawals: withVerdict,
  })
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Use the scheduled trigger time (not wall-clock) so time-of-day checks like
    // `minutes === 0` remain accurate even when cronAlertCheck takes 60+ seconds.
    const scheduledNow = new Date(event.scheduledTime)

    // #629 — reliably trigger the deepseek-feed Action each */5 cycle (GitHub's own schedule is
    // throttled to ~2h, expiring the Flashduty feed). waitUntil so the GitHub POST runs concurrently
    // with the rest of the cron instead of serially delaying it; .catch so it can never break the cron.
    ctx.waitUntil(
      maybeDispatchDeepseekFeed(env).catch((err) =>
        console.warn('[cron] deepseek dispatch failed:', err instanceof Error ? err.message : err)
      )
    )

    // Health check probing (Phase 2) — runs every cron cycle
    if (env.STATUS_CACHE) {
      await writeProbeSnapshot(env.STATUS_CACHE).catch((err) =>
        console.warn('[cron] probe failed:', err instanceof Error ? err.message : err)
      )
    }

    // Probe spike detection — record earliest detection for Detection Lead (no Discord alert, aggregated in daily report)
    if (env.STATUS_CACHE) {
      try {
        const probeRaw = await env.STATUS_CACHE.get('probe:24h').catch(() => null)
        if (probeRaw) {
          const snapshots: ProbeSnapshot[] = JSON.parse(probeRaw).snapshots ?? []
          const serviceIds = PROBE_TARGETS.map((t) => t.id)
          const spikes = detectConsecutiveSpikes(snapshots, serviceIds, 3)
          // #464 — read cached service status once so we can tag each RTT degradation as
          // "on the official status page" vs "not reported there" (the headline differentiator).
          // `scored` isn't in scope in scheduled(); the services:latest cache is the same snapshot
          // /api/status/cached serves. Best-effort: a miss → treat status unknown (operational=false).
          const statusByService = new Map<string, string>()
          try {
            const cachedRaw = await env.STATUS_CACHE.get(CACHE_KEY).catch(() => null)
            if (cachedRaw) {
              const parsed = JSON.parse(cachedRaw)
              const svcs: ServiceStatus[] = Array.isArray(parsed) ? parsed : parsed.services ?? []
              for (const s of svcs) statusByService.set(s.id, s.status)
            }
          } catch (err) {
            console.warn('[cron] degradation status read failed:', err instanceof Error ? err.message : err)
          }
          const degradationDate = new Date().toISOString().split('T')[0]
          for (const spike of spikes) {
            const alertKey = `alerted:probe-spike:${spike.serviceId}`
            const existing = await env.STATUS_CACHE.get(alertKey).catch(() => null)
            if (existing) continue
            await kvPut(env.STATUS_CACHE, alertKey, '1', { expirationTtl: 3600 })
            // #464 — rising edge of a spike streak: count this RTT degradation. If the service's
            // official status is still operational, the degradation isn't on the status page → the
            // `nostatus` figure. Best-effort, mirrors the fetch-fail:daily counter (48h TTL).
            // #1233 KNOWN LIMITATION — `classifyDegradation` is a two-way boolean, so an `unknown` service
            // answers `false` and its RTT degradation is booked as "already on the status page" when in fact
            // we could not read that page. Reachable: `detectConsecutiveSpikes` has a lower bar than
            // `isProbeFailing`, so a spiking service can stay `unknown` through cross-validation and land
            // here. Left as-is deliberately — the honest fix is a third outcome, and changing a second durable
            // counter in this PR is what the uptime-sampling revert (see `cacheWrite`'s #1233 note) exists to
            // avoid. Tracked as a follow-up.
            const svcOperational = statusByService.get(spike.serviceId) === 'operational'
            const outcome = classifyDegradation(svcOperational)
            const isNoStatus = outcome === 'degradation_nostatus'
            const degBase = `probe-degradation:daily:${spike.serviceId}:${degradationDate}`
            const prevDeg = parseInt(await env.STATUS_CACHE.get(degBase).catch(() => null) ?? '0', 10) || 0
            await kvPut(env.STATUS_CACHE, degBase, String(prevDeg + 1), { expirationTtl: 172800 })
            if (isNoStatus) {
              const nsKey = `probe-degradation:nostatus:daily:${spike.serviceId}:${degradationDate}`
              const prevNs = parseInt(await env.STATUS_CACHE.get(nsKey).catch(() => null) ?? '0', 10) || 0
              await kvPut(env.STATUS_CACHE, nsKey, String(prevNs + 1), { expirationTtl: 172800 })
            }
            // #511 — dual-write the monthly accumulator (60d TTL) so the archive cron can read
            // month-complete figures past the daily 48h TTL. Mirrors detection lead's monthly write.
            const degMonthKey = degradationMonthlyKey()
            const degMonthRaw = await env.STATUS_CACHE.get(degMonthKey).catch(() => null)
            let degMonth = null
            try { degMonth = degMonthRaw ? normalizeDegradationMonthly(JSON.parse(degMonthRaw)) : null } catch { degMonth = null }
            const nextDegMonth = addDegradationToMonthly(degMonth, spike.serviceId, isNoStatus)
            await kvPut(env.STATUS_CACHE, degMonthKey, JSON.stringify(nextDegMonth), { expirationTtl: DEGRADATION_MONTHLY_TTL_SECONDS })
            // Record probe spike as earliest detection (Detection Lead feature)
            const detectKey = `detected:${spike.serviceId}`
            const existingDetect = await env.STATUS_CACHE.get(detectKey).catch(() => null)
            if (isProbeEarlier(existingDetect, spike.since)) {
              await kvPut(env.STATUS_CACHE, detectKey, serializeDetectionEntry({ t: spike.since, incId: null }), { expirationTtl: 604800 })
            }
          }
        }
      } catch (err) {
        console.warn('[cron] probe spike detection failed:', err instanceof Error ? err.message : err)
      }
    }

    // Platform health monitoring — check metastatuspage.com for Atlassian Statuspage platform status
    // Runs every cron cycle (~5min). Stores status in KV for cross-validation + sends Discord alerts.
    if (env.STATUS_CACHE && env.DISCORD_WEBHOOK_URL) {
      try {
        const platformStatus = await checkPlatformStatus('atlassian')
        if (platformStatus) {
          const kvKey = platformStatusKey('atlassian')
          const alertKey = platformAlertKey('atlassian')

          if (platformStatus.status !== 'operational') {
            // Store non-operational status (10min TTL) — used by cross-validation in fetchAllServices
            const stored = await kvPut(env.STATUS_CACHE, kvKey, JSON.stringify(platformStatus), { expirationTtl: 600 })
            if (!stored) console.warn('[platform-monitor] Failed to store platform status in KV')

            // Send outage alert if not already alerted
            const alreadyAlerted = await env.STATUS_CACHE.get(alertKey).catch(() => null)
            if (!alreadyAlerted) {
              const affectedCount = countPlatformServices(SERVICES, 'atlassian')
              const alert = formatPlatformOutageAlert(platformStatus, affectedCount, SERVICES.length)
              await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, alert)
              await kvPut(env.STATUS_CACHE, alertKey, '1', { expirationTtl: 7200 })
              console.log(`[platform-monitor] Atlassian outage alert sent: ${platformStatus.status}`)
            }
          } else {
            // Platform operational — send recovery alert if we previously alerted
            // Uses alertKey (not prevStatus) as recovery signal — immune to KV TTL expiry
            const alertExists = await env.STATUS_CACHE.get(alertKey).catch(() => null)
            if (alertExists) {
              const affectedCount = countPlatformServices(SERVICES, 'atlassian')
              const alert = formatPlatformRecoveryAlert('Atlassian Statuspage', affectedCount)
              try {
                await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, alert)
                await kvDel(env.STATUS_CACHE, alertKey)
                console.log('[platform-monitor] Atlassian recovery alert sent')
              } catch (alertErr) {
                console.warn('[platform-monitor] Recovery alert send failed — will retry next cycle:', alertErr instanceof Error ? alertErr.message : alertErr)
                // Keep alertKey so retry works next cycle
              }
            }
            // Clear platform status KV (platform is healthy now)
            await kvDel(env.STATUS_CACHE, kvKey)
          }
        }
      } catch (err) {
        console.warn('[cron] platform monitor failed:', err instanceof Error ? err.message : err)
      }
    }

    const result = await cronAlertCheck(env, event.scheduledTime)
    if (!env.DISCORD_WEBHOOK_URL) return

    // Reddit community monitoring — runs once per hour (minute 0-4) to respect rate limits
    // KV budget (#820 round 2 — the old "max 5 writes/hour" cap is gone, see the outageAlerts loop
    // below): worst case is REDDIT_TARGETS' 9 outage-mode subs × limit=25 posts = 225 dedup writes/
    // hour, 5400/day — still trivial against the Workers Paid 1M/month inclusion. Real volume is far
    // lower in practice (most posts don't match `matchesKeywords`, and #820's measured ~85% 429 rate
    // on the fetch itself further caps how many subreddits even return posts to write keys for).
    const now = scheduledNow
    if (env.STATUS_CACHE && env.DISCORD_WEBHOOK_URL && now.getUTCMinutes() < 5) {
      try {
        const redditAlerts = await detectRedditPosts(env.STATUS_CACHE)
        // Split: service outage alerts vs competitive vs security monitoring
        const outageAlerts = redditAlerts.filter(a => a.type === 'outage')
        const competitiveAlerts = redditAlerts.filter(a => a.type === 'competitive')
        const redditSecurityAlerts = redditAlerts.filter(a => a.type === 'security')
        // Mark EVERY detected post as seen (prevents re-checking next run), but only notify
        // promotable ones. #820's endpoint swap raised the per-subreddit fetch limit 5 → 25, so a
        // cap here would now routinely leave outage-matching posts beyond the cap un-marked —
        // `promotable` below is filtered from the FULL `outageAlerts` list, so an unmarked post
        // that got promoted this run would be re-detected (and re-promoted to Discord) every run
        // until it aged out 6h later. Each write is cheap (dedup only, 24h TTL) and volume is
        // naturally bounded by how many distinct outage-keyword posts actually appear across all
        // outage-mode subreddits in an hour — capping it traded a real duplicate-alert bug for a
        // KV-budget saving that was never the bottleneck.
        //
        // Tradeoff this creates, stated rather than hidden: `promotable` below is still capped at
        // `.slice(0, 3)` (the Discord-send limit), but now that every outageAlert gets marked seen
        // regardless of whether it was sent, a 4th+ promotable post this run is marked seen WITHOUT
        // ever being sent — it will not become eligible on a later run either, since dedup already
        // covers it. Before this change such a post would have stayed unmarked (if beyond the old
        // 5-cap) and could resurface; now it's a clean, permanent skip instead. Silence over
        // duplication is the right tradeoff here — REDDIT_TARGETS' outage-mode subs order determines
        // which posts win the 3 slots each run, not recency or severity, but that ordering question
        // is unrelated to this PR's scope (Reddit is bot-walled far more often than it produces 4+
        // simultaneous promotable posts in one run in the first place).
        for (const alert of outageAlerts) {
          await kvPut(env.STATUS_CACHE, alert.key, '1', { expirationTtl: 86400 })
        }
        const nowSec = Date.now() / 1000
        const promotable = outageAlerts
          .filter(a => isPromotable(a.post.title, nowSec - a.post.createdUtc))
          .slice(0, 3)
        for (const alert of promotable) {
          const formatted = formatRedditAlert(alert)
          const sent = await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
            title: formatted.title,
            description: `${formatted.description}\n[View Post](${formatted.url})`,
            color: formatted.color,
          })
          // #1202 — the only durable trace that a PROMOTE alert (as opposed to the #1182 engagement
          // block, which leaves no KV trace either) has ever actually fired. Gated on `sent` — round
          // 7 caught that an earlier version discarded sendDiscordAlert's return value and wrote the
          // marker unconditionally, so a failed webhook POST would still read as "delivered" to
          // anyone checking `reddit:promote:last` (including #1202's own verify-after, whose whole
          // point is confirming this alert actually reached Discord). Mirrors the #800/#714
          // source-dead-alert path a few hundred lines up, which gates its KV write on `sent` the
          // same way. `kvPut` itself never throws (see worker/src/utils.ts) — it returns false on
          // failure — so the write-failure branch checks the return value rather than catching.
          if (sent && !(await kvPut(env.STATUS_CACHE, 'reddit:promote:last', JSON.stringify({
            postId: alert.post.id, subreddit: alert.subreddit, sentAt: now.toISOString(),
          })))) console.error('[reddit] promote-marker write failed')
        }
        // Competitive alerts — mark seen + notify (max 2 per hour)
        for (const alert of competitiveAlerts.slice(0, 2)) {
          await kvPut(env.STATUS_CACHE, alert.key, '1', { expirationTtl: 86400 })
          const formatted = formatCompetitiveAlert(alert)
          await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
            title: formatted.title,
            description: `${formatted.description}\n[View Post](${formatted.url})`,
            color: formatted.color,
          })
        }
        // Security alerts from Reddit — notify first, then mark seen (max 5 per hour)
        const secReddit = redditSecurityAlerts.slice(0, 5)
        if (secReddit.length > 0) {
          const secLines = secReddit.map(a => {
            const formatted = formatRedditSecurityAlert(a)
            return `${formatted.description}\n[View Post](${formatted.url})`
          })
          await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
            title: `🔒 Reddit Security — ${secReddit.length} post${secReddit.length > 1 ? 's' : ''}`,
            description: secLines.join('\n\n'),
            color: 0xf85149,
          })
          for (const alert of secReddit) {
            await kvPut(env.STATUS_CACHE, alert.key, '1', { expirationTtl: 604800 }).catch(err => { // 7d dedup
              console.error('[cron] Failed to mark Reddit security alert as seen:', alert.key, err instanceof Error ? err.message : err)
            })
          }
        }
      } catch (err) {
        console.error('[cron] Reddit monitoring failed:', err instanceof Error ? err.message : err)
      }

      // HN + OSV security monitoring (independent of Reddit — separate try/catch)
      try {
        const securityAlerts = await detectSecurityAlerts(env.STATUS_CACHE)
        if (securityAlerts.length > 0) {
          // Send notification first — duplicate is better than lost alert
          const digest = formatSecurityDigest(securityAlerts)
          await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
            title: digest.title,
            description: digest.description,
            color: digest.color,
          })
          // Then mark as seen — store alert metadata for dashboard display
          const nowISO = new Date().toISOString()
          for (const alert of securityAlerts) {
            // #326: persist EPSS fields so dashboard/readRecentSecurityAlerts
            // can render the exploit-probability tag without a re-fetch.
            const meta = JSON.stringify({
              title: alert.title, url: alert.url, source: alert.source,
              severity: alert.severity, service: alert.service, detectedAt: nowISO,
              epssPercentile: alert.epssPercentile, epssPercentage: alert.epssPercentage,
            })
            await kvPut(env.STATUS_CACHE, alert.kvKey, meta, { expirationTtl: 604800 }).catch(err => { // 7d dedup
              console.error('[cron] Failed to mark security alert as seen:', alert.kvKey, err instanceof Error ? err.message : err)
            })
          }

          // #288: purpose-built daily counter for the daily summary. security:seen:* has a
          // 7d TTL for dedup semantics and shouldn't double as a "today's count" source.
          const detectedKey = securityDetectedKey(nowISO.slice(0, 10))
          try {
            const prevRaw = await env.STATUS_CACHE.get(detectedKey).catch(() => null)
            const next = incrementSecurityCount(prevRaw, securityAlerts.length)
            await kvPut(env.STATUS_CACHE, detectedKey, String(next), { expirationTtl: 259200 }) // 3d TTL
          } catch (err) {
            console.warn('[cron] security daily counter increment failed:', err instanceof Error ? err.message : err)
          }

          // Accumulate for monthly reports (security:monthly:{YYYY-MM}, 60d TTL)
          const monthKey = `security:monthly:${nowISO.slice(0, 7)}`
          try {
            const monthRaw = await env.STATUS_CACHE.get(monthKey).catch(() => null)
            const monthly: Array<{ title: string; url: string; source: string; severity?: string; service?: string; detectedAt: string; epssPercentile?: number; epssPercentage?: number }> = monthRaw ? JSON.parse(monthRaw) : []
            const existingIds = new Set(monthly.map(m => m.url))
            for (const alert of securityAlerts) {
              if (!existingIds.has(alert.url)) {
                monthly.push({
                  title: alert.title, url: alert.url, source: alert.source,
                  severity: alert.severity, service: alert.service, detectedAt: nowISO,
                  epssPercentile: alert.epssPercentile, epssPercentage: alert.epssPercentage,
                })
              }
            }
            await kvPut(env.STATUS_CACHE, monthKey, JSON.stringify(monthly.slice(-100)), { expirationTtl: 5_184_000 }) // 60d
          } catch (err) {
            console.warn('[cron] security monthly accumulation failed:', err instanceof Error ? err.message : err)
          }
        }
      } catch (err) {
        console.error('[cron] Security monitoring (HN/OSV) failed:', err instanceof Error ? err.message : err)
      }

      // OSV timeline tracking (#291) — runs hourly alongside the dedup path.
      // Separate from detectSecurityAlerts because timeline needs the CURRENT state
      // of every tracked OSV alert (to detect severity_changed / fix_released),
      // not just the new-this-hour ones. Writes only on stage transitions, so
      // steady-state KV cost is near zero.
      try {
        const osvAlerts = await fetchOSVAlerts()
        const plans = await planOsvTimelineCycle(
          osvAlerts,
          (key) => env.STATUS_CACHE.get(key).catch(() => null),
          new Date().toISOString(),
          (key, err) => console.warn('[cron] OSV timeline parse failed, preserving blob:', key, err instanceof Error ? err.message : err),
        )
        for (const p of plans) {
          await kvPut(env.STATUS_CACHE, p.key, JSON.stringify(p.next))
        }
      } catch (err) {
        console.error('[cron] OSV timeline tracking failed:', err instanceof Error ? err.message : err)
      }
    }

    // GitHub competitive monitoring — weekly on Monday UTC 00:00-00:05
    if (env.STATUS_CACHE && env.DISCORD_WEBHOOK_URL && now.getUTCDay() === 1 && now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
      try {
        const ghAlerts = await detectNewRepos(env.STATUS_CACHE)
        for (const alert of ghAlerts.slice(0, 3)) {
          await kvPut(env.STATUS_CACHE, alert.key, '1', { expirationTtl: 2_592_000 }) // 30d TTL
          const formatted = formatGitHubAlert(alert)
          await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
            title: formatted.title,
            description: `${formatted.description}\n[View Repo](${formatted.url})`,
            color: formatted.color,
          })
        }
      } catch (err) {
        console.warn('[cron] GitHub competitive monitoring failed:', err instanceof Error ? err.message : err)
      }
    }

    // Changelog RSS collection — every hour at :00 (3 sources, write only on new entries)
    if (env.STATUS_CACHE && now.getUTCMinutes() === 0) {
      try {
        const newEntries = await collectChangelogs(env.STATUS_CACHE)
        if (newEntries.length > 0) {
          console.log(`[cron] changelog: ${newEntries.length} new entries detected`)
        }
      } catch (err) {
        console.warn('[cron] changelog collection failed:', err instanceof Error ? err.message : err)
      }
    }

    // Weekly briefing — Sunday UTC 00:00-00:04 (KST 09:00)
    if (env.STATUS_CACHE && env.DISCORD_WEBHOOK_URL && now.getUTCDay() === 0 && now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
      try {
        const weeklyKey = `weekly-briefing:${todayUTC()}`
        const alreadySent = await env.STATUS_CACHE.get(weeklyKey).catch(() => null)
        if (!alreadySent) {
          const { start: weekStart, end: weekEnd } = getWeekRange(now)

          // Read changelog entries accumulated this week, filtered to the briefing window
          const changelogRaw = await env.STATUS_CACHE.get('changelog:entries').catch(() => null)
          let changelog: import('./changelog').ChangelogEntry[] = []
          if (changelogRaw) {
            try {
              const all = JSON.parse(changelogRaw)
              if (!Array.isArray(all)) {
                console.warn('[cron] changelog entries: expected array, got', typeof all)
              } else {
                changelog = filterChangelogToWeek(all, weekStart, weekEnd)
              }
            } catch (err) { console.warn('[cron] changelog entries parse failed:', err instanceof Error ? err.message : String(err)) }
          }

          // Read monthly incidents for incident summary (current + previous month for week spanning boundary).
          const allMonthlyIncidents: Parameters<typeof buildIncidentSummary>[0] = []
          const serviceNameMap: Record<string, string> = {}
          for (const svc of SERVICES) serviceNameMap[svc.id] = svc.name
          // #1117 — `previousPeriod` (string arithmetic), NOT `setUTCMonth(-1)`: the latter keeps the
          // day-of-month and overflows forward on the 29th-31st, so a briefing run on the 31st read the
          // CURRENT month twice and lost a week spanning the boundary.
          const currPeriod = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
          const currMonthKey = `incidents:monthly:${currPeriod}`
          const prevMonthKey = `incidents:monthly:${previousPeriod(currPeriod)}`
          // #904 — filter operator-suppressed incidents out of the raw accumulator before summarizing,
          // else a suppressed incident (e.g. FedRAMP) resurfaces in the weekly Discord incident summary.
          const weeklySuppressions = await readSuppressionsFresh(env.STATUS_CACHE)
          const weeklyOverrides = await readOverridesFresh(env.STATUS_CACHE) // #1019
          for (const mk of [currMonthKey, prevMonthKey]) {
            const mRaw = await env.STATUS_CACHE.get(mk).catch(() => null)
            if (!mRaw) continue
            try {
              const parsed = JSON.parse(mRaw) as MonthlyIncidents
              const suppressed = weeklySuppressions.length ? filterSuppressedFromMonthly(parsed, weeklySuppressions) : parsed
              const filtered = weeklyOverrides.length ? applyDurationOverrides(suppressed, weeklyOverrides) : suppressed
              allMonthlyIncidents.push(...parseMonthlyIncidents(filtered, serviceNameMap))
            } catch (err) { console.warn(`[cron] ${mk} parse failed:`, err instanceof Error ? err.message : String(err)) }
          }
          const incidents = buildIncidentSummary(allMonthlyIncidents, weekStart, weekEnd)

          // #733 — Stability Trend compares OFFICIAL status-page uptime, gated on the LIVE current
          // value. `currentUptime` = live `uptime30d` from services:latest, with no-official-uptime /
          // stale-source services set to null (= dashboard `isUnreliableUptime`, #713) so they're
          // excluded. The previous-week official snapshot comes from the history counters' stored
          // `officialUptime` (i=7→13 below; i ascending = most-recent-first, so the first non-null is
          // the most recent). The current week is NOT read from history — a service like Bedrock had
          // intermittently non-null `officialUptime` snapshots (pre-#713 estimate residue) that would
          // otherwise leak it back in despite publishing no uptime now.
          type WeekCounter = { ok: number; total: number; officialUptime?: number | null }
          const prevWeekCounters: Record<string, WeekCounter> = {}
          for (let i = 7; i < 14; i++) {
            const pd = new Date(now)
            pd.setUTCDate(pd.getUTCDate() - i)
            const pkey = `history:${pd.toISOString().split('T')[0]}`
            const praw = await env.STATUS_CACHE.get(pkey).catch(() => null)
            if (!praw) continue
            try {
              const pdata = JSON.parse(praw) as Record<string, { ok: number; total: number; officialUptime?: number | null }>
              for (const [svcId, counts] of Object.entries(pdata)) {
                const c = prevWeekCounters[svcId] ?? { ok: 0, total: 0, officialUptime: null }
                c.ok += counts.ok; c.total += counts.total
                if (c.officialUptime == null && counts.officialUptime != null) c.officialUptime = counts.officialUptime
                prevWeekCounters[svcId] = c
              }
            } catch { console.warn(`[cron] ${pkey} parse failed`) }
          }
          const serviceNames: Record<string, string> = {}
          for (const svc of SERVICES) serviceNames[svc.id] = svc.name
          // Live current official uptime (isUnreliableUptime → null → excluded)
          const currentUptime: Record<string, number | null> = {}
          const latestRaw = await env.STATUS_CACHE.get('services:latest').catch(() => null)
          if (latestRaw) {
            try {
              const p = JSON.parse(latestRaw)
              const live: ServiceStatus[] = Array.isArray(p) ? p : (p.services ?? [])
              for (const s of live) {
                const unreliable = s.uptime30d == null || !!s.incidentSourceStale
                currentUptime[s.id] = unreliable ? null : s.uptime30d!
              }
            } catch { console.warn('[cron] services:latest parse failed for stability') }
          }
          const stabilityChanges = buildStabilityChanges(currentUptime, prevWeekCounters, serviceNames)
          // #733 — a genuine comparison requires at least one service with BOTH a live official
          // uptime AND a prev-week official snapshot; otherwise the section says "data unavailable"
          // rather than the reassuring "No significant changes." (which would hide a possible decline).
          const stabilityDataAvailable = Object.entries(currentUptime).some(
            ([id, v]) => v != null && prevWeekCounters[id]?.officialUptime != null,
          )

          // Security summary: count security:seen:* keys (7d TTL — approximate week coverage, ±1d)
          // KV list returns max 1000 keys — sufficient for weekly security alerts (~50-100 typical)
          let security
          try {
            const secKeys = await env.STATUS_CACHE.list({ prefix: 'security:seen:' })
            if (secKeys.keys.length > 0) {
              // TODO: highlights require storing alert titles in KV values or a dedicated accumulation key
              // KV list() only returns key names — pass empty for now
              security = buildSecuritySummary(secKeys.keys, [])
            }
          } catch { console.warn('[cron] security summary list failed') }

          // Per-source last-fetch staleness check — surfaces silent collection gaps (#274)
          const staleSources = await getStaleSources(env.STATUS_CACHE).catch(() => [])

          // #995 — AI-analysis usage trend from the retained ai:usage:{date} keys across the week.
          // parseUsage(null) → zeros, so missing days contribute nothing but keep the window at 7d.
          let aiUsageTrend = null
          try {
            const entries = await Promise.all(
              weekDateStrings(weekStart, weekEnd).map((dt) => env.STATUS_CACHE.get(`ai:usage:${dt}`).catch(() => null).then(parseUsage)),
            )
            aiUsageTrend = summarizeAiUsageTrend(entries)
          } catch (err) {
            console.warn('[cron] weekly ai:usage trend read failed:', err instanceof Error ? err.message : err)
          }

          // #1158 — GitHub repo discovery for badge embeds (weekly Code Search sweep). Best-effort,
          // like the sections above. searchBadgeEmbeds returns null on missing token/HTTP failure/
          // unparseable response — GitHub API trouble never affects /badge/:serviceId serving (this
          // cron branch is fully separate from that handler).
          //
          // `badge:repos:seen` (no TTL — a permanent accumulator) is FAIL-CLOSED on both a KV read
          // throw AND a corrupt/wrong-shape stored value: unlike `component-seen:` (#992, a few
          // hundred lines up) whose corrupt→empty fallback is safe because its worst case is a
          // bounded re-alert, this key has no recovery path — persisting a diff computed against a
          // false "empty" baseline would overwrite real adopter history with just this week's hits.
          // So any read anomaly here skips the diff+write entirely (this week's briefing section is
          // simply omitted) rather than substituting an empty baseline. See parseBadgeReposSeen.
          let badgeRepoDiscovery: BadgeRepoDiscoveryDiff | null = null
          try {
            const results = await searchBadgeEmbeds(env.GH_CODE_SEARCH_TOKEN)
            if (results) {
              let readFailed = false
              const seenRaw = await env.STATUS_CACHE.get('badge:repos:seen').catch((err) => {
                readFailed = true
                console.warn('[cron] badge:repos:seen read failed — skipping this run to avoid clobbering history:', err instanceof Error ? err.message : err)
                return null
              })
              if (!readFailed) {
                const previouslySeen = parseBadgeReposSeen(seenRaw)
                if (previouslySeen === null) {
                  console.warn('[cron] badge:repos:seen corrupt/unparseable — skipping this run to avoid clobbering history')
                } else {
                  const diff = diffBadgeRepoDiscovery(results, previouslySeen)
                  badgeRepoDiscovery = diff
                  // Skip the write when nothing changed (mirrors component-seen:'s `newComponents.length
                  // === 0` no-write branch) — a no-op re-put every week for zero real churn is pure KV budget.
                  if (diff.newRepos.length > 0) {
                    await env.STATUS_CACHE.put('badge:repos:seen', JSON.stringify(diff.seen)).catch((err) =>
                      console.warn('[cron] badge:repos:seen write failed:', err instanceof Error ? err.message : err),
                    )
                  }
                }
              }
            }
          } catch (err) {
            console.warn('[cron] badge repo discovery failed:', err instanceof Error ? err.message : err)
          }

          // #917 — operator-authored strategy status (initiative page Status + Next action). Absent
          // key → section omitted; present-but-malformed → surface a fix nudge (not a silent drop),
          // since a broken write is operator error worth showing.
          let strategyBrief = null
          let strategyBriefMalformed = false
          try {
            const raw = await env.STATUS_CACHE.get('strategy:brief')
            if (raw) {
              strategyBrief = parseStrategyBrief(raw)
              if (!strategyBrief) {
                strategyBriefMalformed = true
                console.warn('[cron] weekly strategy:brief present but malformed — briefing shows a fix nudge')
              }
            }
          } catch (err) {
            console.warn('[cron] weekly strategy:brief read failed:', err instanceof Error ? err.message : err)
          }

          const briefing = buildWeeklyBriefing({ weekStart, weekEnd, changelog, incidents, stabilityChanges, stabilityDataAvailable, security, staleSources, aiUsageTrend, strategyBrief, strategyBriefMalformed, badgeRepoDiscovery })
          await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
            title: `📋 Weekly Briefing (${weekStart} ~ ${weekEnd})`,
            description: briefing,
            color: 0x58a6ff, // blue
          })
          await kvPut(env.STATUS_CACHE, weeklyKey, '1', { expirationTtl: 604_800 }) // 7d dedup

          // Clear accumulated changelog entries after sending
          await env.STATUS_CACHE.delete('changelog:entries').catch((err) =>
            console.warn('[cron] changelog entries cleanup failed:', err instanceof Error ? err.message : err),
          )
        }
      } catch (err) {
        console.error('[cron] weekly briefing failed:', err instanceof Error ? err.message : err)
      }
    }

    // Archive yesterday's data every cron cycle (idempotent — skips if already done)
    // Runs independently of daily summary to prevent data loss from missed summary windows
    if (env.STATUS_CACHE) {
      await archiveVitals(env.STATUS_CACHE).catch((err) =>
        console.warn('[cron] vitals archive failed:', err instanceof Error ? err.message : err)
      )
      await archiveProbeDaily(env.STATUS_CACHE, now).catch((err) =>
        console.warn('[cron] probe archive failed:', err instanceof Error ? err.message : err)
      )
      // Refresh probe summaries cache. Probe daily archives change once per day at UTC 00:00, so a
      // 30-min refresh slot is plenty fresh and keeps writes to ~48/day (vs ~288/day every cron tick).
      // In-memory dedup mirrors the lastKvWrite/lastProbeSlot pattern used elsewhere in this file.
      // Only update the slot when an actual write occurred — empty no-op (transient archive miss)
      // shouldn't block the next 30 min of recovery attempts.
      const probeSummarySlot = `${now.toISOString().slice(0, 13)}-${Math.floor(now.getUTCMinutes() / 30)}`
      if (probeSummarySlot !== lastProbeSummaryCacheSlot) {
        const wrote = await cacheProbeSummaries(env.STATUS_CACHE).catch((err) => {
          console.warn('[cron] probe summary cache failed:', err instanceof Error ? err.message : err)
          return false
        })
        if (wrote) lastProbeSummaryCacheSlot = probeSummarySlot
      }
    }

    // Monthly archive on 1st of each month (UTC 00:00-00:14, catch-up 01:00-01:14)
    // Aggregates previous month's daily data into permanent archive:monthly:{YYYY-MM} KV key
    const { inWindow: inArchiveWindow, isCatchUp: isArchiveCatchUp } = isInMonthlyArchiveWindow(now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes())
    if (inArchiveWindow && env.STATUS_CACHE) {
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const prevYear = prevMonth.getFullYear()
      const prevMon = prevMonth.getMonth() + 1
      const archiveKey = `archive:monthly:${prevYear}-${String(prevMon).padStart(2, '0')}`
      const existing = await env.STATUS_CACHE.get(archiveKey).catch(() => null)
      if (!existing) {
        try {
          // Compute Score data inline from services:latest + probe:summaries.
          // services:latest stores raw ServiceStatus only — aiwatchScore/scoreGrade
          // are computed on-demand at /api/status response time via scoreFor(),
          // never persisted to that cache. Reading the cache directly produced
          // archive entries with score: null for every service — see #monthly-archive-score.
          let scoreData: ArchiveScoreInput[] = []
          // service id → display name, for the AI narrative prompt (#426).
          const serviceNames: Record<string, string> = {}
          const cachedRaw = await env.STATUS_CACHE.get('services:latest').catch(() => null)
          if (cachedRaw) {
            try {
              const p = JSON.parse(cachedRaw)
              const services: ServiceStatus[] = Array.isArray(p) ? p : (p.services ?? [])
              const probeSummaries = await readProbeSummaries(env.STATUS_CACHE, 'monthly-archive')
              scoreData = services.map((s) => toArchiveScoreInput(s, scoreFor(s, probeSummaries)))
              for (const s of services) serviceNames[s.id] = s.name
            } catch (parseErr) {
              console.error('[monthly-archive] Failed to parse services:latest — archive will lack Score data:',
                parseErr instanceof Error ? parseErr.message : parseErr)
            }
          }

          // Bake the AI retrospective narrative into the archive (#426). Best-effort:
          // generateMonthlyNarrative degrades to null on any AI failure, the
          // deterministic archive ships regardless.
          const archive = await buildMonthlyArchive(env.STATUS_CACHE, prevYear, prevMon, scoreData, {
            ai: env.AI,
            apiKey: env.ANTHROPIC_API_KEY,
            serviceNames,
          })
          const writeOk = await kvPut(env.STATUS_CACHE, archiveKey, JSON.stringify(archive))
          if (!writeOk) {
            console.error(`[monthly-archive] KV write failed for ${archive.period} — archive NOT persisted`)
          } else {
            if (isArchiveCatchUp) console.log(`[monthly-archive] catch-up run for ${archive.period}`)
            console.log(`[monthly-archive] Archived ${archive.period}: ${Object.keys(archive.services).length} services, ${archive.daysCollected} days`)
          }
        } catch (err) {
          console.error('[monthly-archive] Failed:', err)
        }
      }

      // Sits outside the `if (!existing)` archive-build branch so the 01:00 catch-up
      // cycle can still ping if the 00:00 cycle built the archive but the Discord send
      // failed. Dedup via archive:notified:{period}.
      if (env.DISCORD_WEBHOOK_URL) {
        await maybeNotifyArchiveReady(env, archiveKey, `${prevYear}-${String(prevMon).padStart(2, '0')}`).catch((err) => {
          console.error('[monthly-archive] notification failed:', err instanceof Error ? err.message : err)
        })
      }
    }

    // Daily summary at UTC 09:00 (KST 18:00) — purple embed
    // Also catches up if yesterday's summary was missed (e.g., deploy during the window)
    const { inWindow: inSummaryWindow, isCatchUp } = isInSummaryWindow(now.getUTCHours(), now.getUTCMinutes())
    if (inSummaryWindow) {
      const today = now.toISOString().split('T')[0]
      const summaryMarker = env.STATUS_CACHE
        ? await env.STATUS_CACHE.get(`daily-summary:${today}`).catch((err) => {
            console.warn('[daily-summary] marker read failed, will retry:', err instanceof Error ? err.message : err)
            return null
          })
        : null
      if (!summaryMarker) {
        try {
          // Gather data for expanded daily report
          const [cachedRaw, aiUsageRaw, latRaw, probeRaw] = await Promise.all([
            env.STATUS_CACHE.get(CACHE_KEY).catch(() => null),
            env.STATUS_CACHE.get(`ai:usage:${today}`).catch(() => null),
            env.STATUS_CACHE.get('latency:24h').catch(() => null),
            env.STATUS_CACHE.get('probe:24h').catch(() => null),
          ])

          let dailyServices: ServiceStatus[] = []
          if (cachedRaw) {
            try {
              const p = JSON.parse(cachedRaw)
              // #1233 — this path reads CACHE_KEY directly rather than through `cacheRead`, so it needs
              // its own transitional decode. `buildDailySummary` now asks `isAffectedStatus` /
              // `isUnreadableStatus`, so a snapshot written by the PREVIOUS deploy would list an
              // unreadable source under **Active Issues** while the new "source unreadable" tally read 0.
              dailyServices = normalizeCachedServices(Array.isArray(p) ? p : p.services ?? [])
            } catch (err) {
              console.error('[daily-summary] Failed to parse cached services:', err instanceof Error ? err.message : err)
            }
          }

          let aiUsage = null
          if (aiUsageRaw) {
            try { aiUsage = JSON.parse(aiUsageRaw) } catch (err) {
              console.error('[daily-summary] Failed to parse AI usage:', err instanceof Error ? err.message : err)
            }
          }
          let latSnapshots: Array<{ t: string; data: Record<string, number> }> = []
          if (latRaw) {
            try { latSnapshots = JSON.parse(latRaw).snapshots ?? [] } catch (err) {
              console.error('[daily-summary] Failed to parse latency data:', err instanceof Error ? err.message : err)
            }
          }
          let probeSnapshots: ProbeSnapshot[] = []
          if (probeRaw) {
            try { probeSnapshots = JSON.parse(probeRaw).snapshots ?? [] } catch (err) {
              console.error('[daily-summary] Failed to parse probe data:', err instanceof Error ? err.message : err)
            }
          }

          // Count reddit posts seen today (KV list with prefix)
          let redditCount = 0
          try {
            const listed = await env.STATUS_CACHE.list({ prefix: 'reddit:seen:' })
            redditCount = listed.keys.length
          } catch (err) {
            console.warn('[daily-summary] Failed to list reddit keys:', err instanceof Error ? err.message : err)
          }
          // #820: surface a persistent Reddit block so a silent zeroing-out is visible.
          const redditSourceDead = await readRedditSourceDead(env.STATUS_CACHE)

          // #288: read the purpose-built daily counter instead of counting security:seen:*
          // keys (that prefix has 7d TTL and accumulates across the week, inflating the number).
          // Fallback to 0 if missing (e.g., first run of the day before any detections fire).
          let securityCount = 0
          try {
            const raw = await env.STATUS_CACHE.get(securityDetectedKey(today)).catch(() => null)
            securityCount = incrementSecurityCount(raw, 0)
          } catch (err) {
            console.warn('[daily-summary] Failed to read security daily counter:', err instanceof Error ? err.message : err)
          }

          // Read daily alert counter
          let alertCounts = null
          try {
            const alertCountRaw = await env.STATUS_CACHE.get(`alert:count:${today}`).catch(() => null)
            if (alertCountRaw) alertCounts = JSON.parse(alertCountRaw)
          } catch (err) {
            console.error('[daily-summary] Failed to parse alert counts:', err instanceof Error ? err.message : err)
          }

          // #815 — Tier-1 ntfy push count (#778 observability)
          const pushCount = parseInt((await env.STATUS_CACHE.get(`push:count:${today}`).catch(() => null)) ?? '0', 10) || 0

          // #842 — consent-free outbound-referral counts (is-down "Open ↗" beacon). null on absence/parse fail.
          let referralCounts: ReferralCounts | null = null
          // #986 — the growth series must tell "nobody clicked" (absent key → 0) apart from "we could
          // not read it" (throw / malformed → null). A broken day recorded as a quiet day would corrupt
          // the very lift comparison the series exists for.
          let referralReadFailed = false
          try {
            const rRaw = await env.STATUS_CACHE.get(`referral:out:${today}`)
            // Guard BOTH fields: a corrupt value with a non-object byService would throw in formatReferralLine's Object.entries.
            if (rRaw) {
              const p = JSON.parse(rRaw)
              if (p && typeof p.total === 'number' && p.byService && typeof p.byService === 'object') referralCounts = p
              else referralReadFailed = true // present but malformed
            }
          } catch (err) { referralReadFailed = true; console.warn('[daily-summary] referral read failed:', err instanceof Error ? err.message : err) }

          // Count active webhook subscriptions. Since #486 PR3 this is the number of confirmed
          // server-side subscriptions (webhook:sub:*) — the source of truth now that delivery is
          // server-side (replaced the legacy webhook:reg:* count removed with the browser relay).
          let webhookCounts: { discord: number; newToday: number | null } = { discord: 0, newToday: null }
          // #986 — `webhookCounts.discord` stays 0 when the listing throws, which the Discord report can
          // live with but the growth series cannot: 0 subscribers and "we could not count" are different
          // days. Capture the snapshot separately so a failed read stays null in the series.
          let subscribersSnapshot: number | null = null
          try {
            const hashes = await listConfirmedHashes(env.STATUS_CACHE)
            webhookCounts.discord = hashes.length
            subscribersSnapshot = hashes.length
            // #548 — new-today delta: diff against yesterday's snapshot, then persist today's for
            // tomorrow's diff (7d TTL so a missed day still leaves a baseline). Consent-free signal.
            const yesterday = new Date(now.getTime() - 86_400_000).toISOString().split('T')[0]
            const prevRaw = await env.STATUS_CACHE.get(`webhook:sub:count:${yesterday}`).catch(() => null)
            webhookCounts.newToday = computeSubscriberDelta(hashes.length, prevRaw)
            // #548 — a CORRUPT baseline (present but non-numeric) collapses to null like a clean
            // first-day, which would silently kill the retention signal forever. Log that case (only)
            // so a stuck "no delta" is debuggable — mirrors the v1 block's self-healing visibility.
            if (prevRaw != null && prevRaw.trim() !== '' && webhookCounts.newToday === null) {
              console.warn(`[daily-summary] subscriber snapshot corrupt for ${yesterday}: ${JSON.stringify(prevRaw)}`)
            }
            // Best-effort write, but log a failure: a silent KV write fault here makes tomorrow's
            // "why did the delta stop?" un-debuggable (the count read three lines up is already logged).
            await env.STATUS_CACHE.put(`webhook:sub:count:${today}`, String(hashes.length), { expirationTtl: 7 * 86400 })
              .catch((err) => console.warn('[daily-summary] subscriber snapshot write failed:', err instanceof Error ? err.message : err))
          } catch (err) {
            console.warn('[daily-summary] Failed to count webhooks:', err instanceof Error ? err.message : err)
          }

          // Flush in-memory delivery counter to KV (merge with any existing counts from prior isolates)
          let deliveryCounts: { discord: number; failed: number } | null = null
          try {
            const proxyDateKey = `alert:proxy:${today}`
            const proxyRaw = await env.STATUS_CACHE.get(proxyDateKey)
            const prior = proxyRaw ? JSON.parse(proxyRaw) : {}
            const merged = {
              discord: (typeof prior.discord === 'number' ? prior.discord : 0) + deliveryCounter.discord,
              failed: (typeof prior.failed === 'number' ? prior.failed : 0) + deliveryCounter.failed,
            }
            if (merged.discord > 0 || merged.failed > 0) {
              await env.STATUS_CACHE.put(proxyDateKey, JSON.stringify(merged), { expirationTtl: 172800 })
            }
            deliveryCounts = merged
            // Reset in-memory counter after flush
            deliveryCounter.discord = 0
            deliveryCounter.failed = 0
          } catch (err) {
            console.warn('[daily-summary] Failed to flush delivery counts:', err instanceof Error ? err.message : err)
          }

          // Read web vitals summary for today
          const vitalsSummary = await readVitalsSummary(env.STATUS_CACHE).catch((err) => {
            console.error('[daily-summary] vitals read failed:', err instanceof Error ? err.message : err)
            return null
          })

          // #679 — the Detection Lead audit log + diagnostics reads were removed (the lead metric was
          // structurally null). RTT-degradation counters below are the kept observability signal.

          // #500 — status page fetch failure observability: read per-service daily counters.
          // fetch-fail:daily:{svcId}:{date}: threshold crossings today (rising-edge incremented).
          // cross-valid:suppressed:{svcId}:{date}: times probe overrode degraded → operational.
          // Individual .catch(() => null) absorb KV I/O errors; missing keys are treated as 0.
          const fetchFailureCounts: Record<string, number> = {}
          const crossValidSuppressed: Record<string, number> = {}
          await Promise.all(SERVICES.filter(s => s.apiUrl).map(async (svc) => {
            const [failRaw, supRaw] = await Promise.all([
              env.STATUS_CACHE.get(`fetch-fail:daily:${svc.id}:${today}`).catch(() => null),
              env.STATUS_CACHE.get(`cross-valid:suppressed:${svc.id}:${today}`).catch(() => null),
            ])
            const failCount = parseInt(failRaw ?? '0', 10) || 0
            const supCount = parseInt(supRaw ?? '0', 10) || 0
            if (failCount > 0) fetchFailureCounts[svc.id] = failCount
            if (supCount > 0) crossValidSuppressed[svc.id] = supCount
          })).catch((err) => {
            console.warn('[daily-summary] fetch failure counts read failed:', err instanceof Error ? err.message : err)
          })

          // #464 — RTT degradation observability: read per-service daily counters.
          // probe-degradation:daily — every probe-spike rising edge; :nostatus — subset not on the
          // official status page (the differentiator). Probe targets only; best-effort.
          const degradationCounts: Record<string, number> = {}
          const degradationNoStatusCounts: Record<string, number> = {}
          await Promise.all(PROBE_TARGETS.map(async (t) => {
            const [degRaw, nsRaw] = await Promise.all([
              env.STATUS_CACHE.get(`probe-degradation:daily:${t.id}:${today}`).catch(() => null),
              env.STATUS_CACHE.get(`probe-degradation:nostatus:daily:${t.id}:${today}`).catch(() => null),
            ])
            const degCount = parseInt(degRaw ?? '0', 10) || 0
            const nsCount = parseInt(nsRaw ?? '0', 10) || 0
            if (degCount > 0) degradationCounts[t.id] = degCount
            if (nsCount > 0) degradationNoStatusCounts[t.id] = nsCount
          })).catch((err) => {
            console.warn('[daily-summary] degradation counts read failed:', err instanceof Error ? err.message : err)
          })

          // #518 — public API (/api/v1) traffic for the daily report. Query the last-24h count from
          // WAE via the AE SQL API (sampling-corrected), then fold it into a permanent cumulative KV
          // counter. The increment is made idempotent by storing `lastDate` IN the counter value: it
          // only folds in once per UTC day, regardless of marker-write ordering or a retried cron
          // cycle (the daily-summary marker is written later and kvPut swallows failures, so it can't
          // be relied on to gate a permanent monotonic total). The cumulative is still an APPROXIMATE
          // lifetime estimate — a 24h rolling window snapshotted once/day can drift slightly or miss a
          // fully-skipped day. Absent token/account → queryV1Traffic returns null → section skipped.
          let v1Traffic = null
          try {
            const today24h = await queryV1Traffic(env.CF_ACCOUNT_ID, env.CF_ANALYTICS_TOKEN)
            if (today24h) {
              const cumKey = 'apiv1:cumulative'
              const cumRaw = await env.STATUS_CACHE.get(cumKey).catch(() => null)
              // Self-heal a corrupt value (restart the counter) rather than throwing → being swallowed
              // by the outer catch → silently suppressing the section forever on every future run.
              let cum: { total: number; since: string; lastDate: string }
              try {
                cum = cumRaw ? JSON.parse(cumRaw) : { total: 0, since: today, lastDate: '' }
              } catch {
                cum = { total: 0, since: today, lastDate: '' }
              }
              if (typeof cum.total !== 'number') cum.total = 0
              if (typeof cum.since !== 'string') cum.since = today
              if (cum.lastDate !== today) { // fold in once per day — idempotent on retry
                cum.total += today24h.total
                cum.lastDate = today
                await env.STATUS_CACHE.put(cumKey, JSON.stringify(cum))
              }
              v1Traffic = { today: today24h, cumulative: cum.total, since: cum.since }
            }
          } catch (err) {
            console.warn('[daily-summary] v1 traffic read failed:', err instanceof Error ? err.message : err)
          }

          // #548 — feed-poll volume (last 24h) as the consent-free retention proxy. Best-effort, like
          // v1; null (skipped) when the AE token/account is absent. No cumulative — the daily value is
          // the signal (a post-outage step-up = retained RSS/Slack subscribers).
          let feedTraffic = null
          try {
            feedTraffic = await queryFeedTraffic(env.CF_ACCOUNT_ID, env.CF_ANALYTICS_TOKEN)
          } catch (err) {
            console.warn('[daily-summary] feed traffic read failed:', err instanceof Error ? err.message : err)
          }
          // #748 — attach the "new feed items / 24h" count (incidents AIWatch first-detected in the
          // window, via #750 feed:firstseen markers) so the poll volume isn't misread as alerts-sent.
          // Only when the poll section is shown (feedTraffic present); count null (KV fail) → no suffix.
          if (feedTraffic) {
            const newItems = await countNewFeedItems(env.STATUS_CACHE)
            if (newItems != null) feedTraffic = { ...feedTraffic, newItems }
          }

          // #1157 — badge-request volume (last 24h), the SVG status-badge embed signal. Best-effort,
          // like feedTraffic; null (section skipped) when the AE token/account is absent. No
          // cumulative — same rationale as feedTraffic (the daily value is the signal).
          let badgeTraffic = null
          try {
            badgeTraffic = await queryBadgeTraffic(env.CF_ACCOUNT_ID, env.CF_ANALYTICS_TOKEN)
          } catch (err) {
            console.warn('[daily-summary] badge traffic read failed:', err instanceof Error ? err.message : err)
          }

          // #842-B — consent-free outage-moment audience (is-down page-load beacon → WAE). Last-24h
          // views by source (x/search/feed/direct), split by active-outage window. null (section
          // omitted) when the AE token/account is absent. The sponsor-evidence "outage-spike audience".
          let audience: AudienceCounts | null = null
          try {
            audience = await queryOutageAudience(env.CF_ACCOUNT_ID, env.CF_ANALYTICS_TOKEN)
          } catch (err) {
            console.warn('[daily-summary] outage audience read failed:', err instanceof Error ? err.message : err)
          }

          // #837 — Chrome-extension activity (consent-free): last-24h poll volume (WAE `ext-claude`
          // tag) + today's extension-sourced report count (KV). Both best-effort/null-tolerant.
          let extPolls: number | null = null
          try {
            extPolls = await queryExtTraffic(env.CF_ACCOUNT_ID, env.CF_ANALYTICS_TOKEN)
          } catch (err) {
            console.warn('[daily-summary] ext traffic read failed:', err instanceof Error ? err.message : err)
          }
          let extReports = 0
          try {
            const v = await env.STATUS_CACHE.get(extReportCountKey(today)).catch(() => null)
            const n = v ? parseInt(v, 10) : 0
            if (Number.isFinite(n) && n > 0) extReports = n
          } catch (err) {
            console.warn('[daily-summary] ext report count read failed:', err instanceof Error ? err.message : err)
          }
          const extActivity = (extPolls != null || extReports > 0) ? { polls: extPolls, reports: extReports } : null

          // #918 — Claude Code statusline poll volume (consent-free adoption proxy, #400 Phase 1).
          // Last-24h counts from WAE (`statusline-*` tags). #944: split into cohorts (server-render
          // vs legacy proxy) + a day-over-day delta vs yesterday's snapshot, then persist today's for
          // tomorrow's diff (7d TTL, mirrors the #548 subscriber-count snapshot). Best-effort/
          // null-tolerant like the ext/feed reads; null (section omitted) when the AE token is absent.
          let statuslineTraffic = null
          try {
            const counts = await queryStatuslineTraffic(env.CF_ACCOUNT_ID, env.CF_ANALYTICS_TOKEN)
            if (counts) {
              const yesterday = new Date(now.getTime() - 86_400_000).toISOString().split('T')[0]
              const prevRaw = await env.STATUS_CACHE.get(`statusline:cohort:${yesterday}`).catch(() => null)
              const delta = computeStatuslineDelta(counts, prevRaw)
              // A CORRUPT baseline (present but unparseable) collapses both cohorts to null like a
              // clean first-day — log that case only (mirrors the #548 subscriber-snapshot visibility).
              if (prevRaw != null && prevRaw.trim() !== '' && delta.serverRender === null && delta.legacyProxy === null) {
                console.warn(`[daily-summary] statusline snapshot corrupt for ${yesterday}: ${JSON.stringify(prevRaw)}`)
              }
              await env.STATUS_CACHE.put(`statusline:cohort:${today}`, serializeStatuslineSnapshot(counts), { expirationTtl: 7 * 86400 })
                .catch((err) => console.warn('[daily-summary] statusline snapshot write failed:', err instanceof Error ? err.message : err))
              statuslineTraffic = { ...counts, delta }
            }
          } catch (err) {
            console.warn('[daily-summary] statusline traffic read failed:', err instanceof Error ? err.message : err)
          }

          // #920 — Claude Code plugin usage (monitor polls + /aiwatch briefings). Best-effort like above.
          let pluginTraffic = null
          try {
            pluginTraffic = await queryPluginTraffic(env.CF_ACCOUNT_ID, env.CF_ANALYTICS_TOKEN)
          } catch (err) {
            console.warn('[daily-summary] plugin traffic read failed:', err instanceof Error ? err.message : err)
          }

          // #575 — internal demand signal: today's per-service crowd "Report an issue" counts.
          // Bounded read (one GET per known service, no KV list); surfaced only inside the operator
          // summary, never as a public "N reporting" verdict (that gating is Phase B).
          const reportCounts: Record<string, number> = {}
          try {
            await Promise.all(SERVICES.map(async (s) => {
              const v = await env.STATUS_CACHE.get(reportCountKey(s.id, today)).catch(() => null)
              const n = v ? parseInt(v, 10) : 0
              if (Number.isFinite(n) && n > 0) reportCounts[s.id] = n
            }))
          } catch (err) {
            console.warn('[daily-summary] report counts read failed:', err instanceof Error ? err.message : err)
          }

          // #827 Feature 1 — AI recovery-prediction accuracy across the durable incident:history
          // corpus (predicted vs actual). Bounded read (one GET per service, once/day), like
          // reportCounts above; null on failure → section omitted.
          let accuracy: AccuracyStats | null = null
          try {
            const allHistory = (await Promise.all(SERVICES.map(s => readIncidentHistory(env.STATUS_CACHE, s.id)))).flat()
            accuracy = summarizeAccuracy(allHistory)
          } catch (err) {
            console.warn('[daily-summary] accuracy aggregate failed:', err instanceof Error ? err.message : err)
          }

          const description = buildDailySummary({
            services: dailyServices,
            aiUsage,
            latencySnapshots: latSnapshots,
            incidentCountToday: { newCount: result.newCount, resolvedCount: result.resolvedCount },
            alertCounts,
            pushCount,
            referralCounts,
            accuracy,
            webhookCounts,
            deliveryCounts,
            redditCount,
            redditSourceDead,
            securityCount,
            vitals: vitalsSummary,
            probeSnapshots,
            fetchFailureCounts,
            crossValidSuppressed,
            degradationCounts,
            degradationNoStatusCounts,
            v1Traffic,
            feedTraffic,
            badgeTraffic,
            audience,
            extActivity,
            statuslineTraffic,
            pluginTraffic,
            reportCounts,
          })

          // #986 — mirror today's consent-free growth counters into the permanent monthly series.
          // The values above are about to expire (referral:out 2d, webhook:sub:count 7d) and nothing
          // else accrues them, so the #547·16 lift measurement had no dataset to read. One KV write/day,
          // plus the three reads #1117 added below. Isolated: a failure here must never abort the report,
          // and re-running the same date overwrites its row rather than duplicating it.
          //
          // `alertCounts` (the `alert:count:{date}` DAILY accumulator) is kept for continuity, but it is
          // NOT a whole-day axis: this run reads that key at 09:00 UTC, so it only ever sees 00:00–09:00
          // of `today`, and the rest of the day expires unread (2-day TTL, and tomorrow's run reads
          // tomorrow's key). #1117 adds the real axis below, counted over the SAME 24h window the
          // `audience` fields were queried over, from the durable incident record.
          //
          // Both month keys are read unconditionally: a window on the 1st reaches into the previous
          // month, and the backfill pass below covers older rows whose windows do the same. Deciding
          // per-row would mean knowing the stored series before reading it, for one extra read/day.
          //
          // COVERAGE IS TRACKED, NOT ASSUMED, and it is tracked per MONTH, not per run. `kv.get` returns
          // null for an absent key WITHOUT throwing, and an unread month counts as zero incidents —
          // which would write a fabricated quiet day into a permanent, never-recomputed row. So a
          // period joins `covered` only after its value parsed into the expected SHAPE (a bare
          // `JSON.parse` succeeds on `null`/`[]`/`{}`, and every layer below tolerates those, so the
          // cast alone would let a truncated write masquerade as a quiet month). A window is counted
          // only when every month it touches is covered.
          //
          // Each period gets its OWN try: a corrupt previous-month key is never repaired (the
          // accumulator only rewrites the current month), so a shared try would disable the axis for
          // every remaining day of the month and then freeze those rows at the month rollover.
          let outageWindow: { started: number; windowEnd: string } | null = null
          let outageSources: Array<MonthlyIncidents | null> | null = null
          const covered = new Set<string>()
          try {
            const periods = [today.slice(0, 7), previousPeriod(today.slice(0, 7))]
            // #904 parity with the reports. `…OrNull` (not `readSuppressionsFresh`, which fails OPEN
            // and returns []) because this value is PERSISTED and never recomputed: counting
            // unfiltered on a KV blip would bake a permanent disagreement with the published reports.
            //
            // The #1019 duration-override layer is deliberately NOT applied, unlike the other readers
            // of this accumulator (weekly briefing, /api/report, monthly archive). It rewrites only
            // `durationMin` and the derived `resolvedAt` — never `startedAt` — so it cannot move a
            // start into or out of this window. Adding it here would be a no-op plus a fail-open read.
            const suppressions = await readSuppressionsFreshOrNull(env.STATUS_CACHE)
            if (suppressions === null) throw new Error('suppression list unreadable — refusing to count unfiltered')
            const parsedMonths: Array<MonthlyIncidents | null> = []
            for (const period of periods) {
              try {
                const raw = await env.STATUS_CACHE.get(`incidents:monthly:${period}`)
                if (!raw) { parsedMonths.push(null); continue }
                const parsed: unknown = JSON.parse(raw)
                if (!parsed || typeof parsed !== 'object' || typeof (parsed as MonthlyIncidents).services !== 'object' || !(parsed as MonthlyIncidents).services) {
                  console.warn(`[growth-series] incidents:monthly:${period} is not a MonthlyIncidents — month left UNCOVERED`)
                  parsedMonths.push(null)
                  continue
                }
                parsedMonths.push(filterSuppressedFromMonthly(parsed as MonthlyIncidents, suppressions))
                covered.add(period)
              } catch (err) {
                console.warn(`[growth-series] incidents:monthly:${period} unusable — month left UNCOVERED:`, err instanceof Error ? err.message : err)
                parsedMonths.push(null)
              }
            }
            outageSources = parsedMonths
            const windowEnd = new Date().toISOString()
            const livePeriods = periodsCoveringWindow(windowEnd)
            // Same predicate as the backfill closure below, spelled the same way: `[].every()` is true,
            // so the length check is what stops an unparseable window from counting as covered.
            if (livePeriods.length && livePeriods.every((p) => covered.has(p))) {
              outageWindow = { started: countIncidentsInWindow(parsedMonths, Date.parse(windowEnd)).started, windowEnd }
            }
          } catch (err) {
            // Leave the axis ABSENT rather than null — the incident record is retained ~60 days, so a
            // later run's backfill can still fill today's row. Never abort the report for it.
            console.warn('[growth-series] outage window read failed:', err instanceof Error ? err.message : err)
          }
          // The axis has no reader yet (no endpoint, no Discord line), so a persistent failure would
          // otherwise surface only when someone dumps KV months later — by which time the month has
          // rolled over and the rows are unfillable. Say it every day it happens.
          if (!outageWindow) {
            console.warn(`[growth-series] outage axis ABSENT for ${today} — months covered: ${[...covered].join(',') || 'none'}`)
          }
          // Hoisted (rather than asserted inside the closure) so the backfill closes over a definite
          // value. Null when nothing parsed — there is then no month to backfill any row against.
          const backfillSources = covered.size ? outageSources : null

          try {
            const wrote = await recordGrowthDaily(env.STATUS_CACHE, buildGrowthDailyRow({
              date: today,
              alertCounts,
              referralTotal: referralReadFailed ? null : (referralCounts?.total ?? 0),
              subscribers: subscribersSnapshot,
              subscriberNewToday: webhookCounts.newToday,
              audience,
              outage: outageWindow,
            }), backfillSources
              ? (rows: GrowthDailyRow[]) => fillOutageWindows(rows, (date) => {
                  // Older rows anchor on the NOMINAL 09:00 UTC run instant — their real run time is
                  // not recorded. `outageWindowEnd` on each row says which anchor it got.
                  const end = nominalWindowEnd(date)
                  const periods = periodsCoveringWindow(end)
                  // This is the `compute → null` branch `fillOutageWindows` documents: a row whose
                  // window reaches into a month we could not read stays ABSENT and retries tomorrow,
                  // rather than being frozen at a fabricated 0.
                  if (!periods.length || !periods.every((p) => covered.has(p))) return null
                  return { started: countIncidentsInWindow(backfillSources, Date.parse(end)).started, windowEnd: end }
                })
              : undefined)
            // `recordGrowthDaily` returns false (it does not throw) when its own read or the write
            // fails. Today's referral/subscriber/audience values cannot be re-derived tomorrow, so this
            // is the one genuinely unrecoverable loss in the block — do not let it pass as a `[kv]` line.
            if (!wrote) console.error(`[growth-series] row for ${today} NOT written — this day's consent-free counters are unrecoverable`)
          } catch (err) {
            console.warn('[growth-series] append failed:', err instanceof Error ? err.message : err)
          }

          if (isCatchUp) console.log(`[daily-summary] catch-up run for ${today}`)
          await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
            title: `📊 AIWatch Daily Report — ${today}`,
            description,
            color: 0x9B59B6, // purple
          })
          // Mark today's summary as done (prevents re-send on subsequent cron cycles)
          await kvPut(env.STATUS_CACHE, `daily-summary:${today}`, '1', { expirationTtl: 604800 })

          // Accumulate monthly incident data. As of #587 this also runs on the */5 alert cron
          // (so short-lived / RSS incidents are captured before they age out of the feed); this
          // daily pass stays as a backstop. accumulateIncidentsOnlyIfChanged writes only when the
          // incident data changed, so the two cadences don't double-write or double-count.
          if (dailyServices.length > 0) {
            try {
              const currentMonth = today.slice(0, 7) // YYYY-MM
              const res = await accumulateIncidentsOnlyIfChanged(env.STATUS_CACHE, dailyServices, currentMonth)
              // #975 — 'failed' now covers a KV READ error too (which aborts before writing), not only
              // a failed write. Either way the cycle is a no-op and the next one retries.
              if (res === 'failed') console.error(`[daily-summary] incident accumulation KV read/write failed for ${currentMonth}`)
            } catch (err) {
              console.error('[daily-summary] incident accumulation failed:', err instanceof Error ? err.message : err)
            }
          }
        } catch (err) {
          // NOTE: marker intentionally NOT written — allows retry on catch-up window (UTC 10:00)
          console.error('[daily-summary] Expanded report failed:', err instanceof Error ? err.message : err)
          try {
            await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
              title: '📊 Daily Summary',
              // #1233 — the unreadable count is printed here for the same reason `buildDailySummary`
              // prints it: without it these numbers stop summing to `total` and the reader cannot tell
              // whether the missing services were fine or unread. Omitted when zero, like the others.
              description: `${result.total} services checked\n${result.operational} operational · ${result.issues} issues${result.unreadable > 0 ? ` · ${result.unreadable} source unreadable` : ''}`,
              color: 0x9B59B6,
            })
          } catch (discordErr) {
            console.error('[daily-summary] Fallback Discord send also failed:', discordErr instanceof Error ? discordErr.message : discordErr)
          }
        }
      }
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin') ?? ''
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN)

    // Vitals endpoint — uses main CORS (origin-restricted, not open to all)
    // #842 — consent-free outbound-referral beacon (the is-down "Open ↗" wedge fetch-keepalive POSTs
    // here on click). GA's outbound_fallback_click is the consent-gated floor; this is the honest
    // count for the sponsor-evidence metric. Mirrors /api/vitals (CORS, best-effort waitUntil write).
    if (url.pathname === '/api/referral') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
      if (request.method === 'POST') {
        // #842 abuse guard (review #1): the endpoint is public + does a KV read-modify-write per
        // request, so a flood could inflate the sponsor-evidence count AND burn the KV write budget.
        // CORS headers alone don't stop a non-browser client, so REJECT before the write when the
        // Origin isn't allowlisted (a real browser beacon always sends its Origin; curl/cross-origin
        // embeds are dropped). Not bulletproof — a script can forge the header — but blocks casual abuse.
        if (!matchOrigin(origin, env.ALLOWED_ORIGIN)) return new Response(null, { status: 403, headers: cors })
        try {
          const parsed = parseReferralBody(await request.json(), new Set(SERVICES.map(s => s.id)))
          if (!parsed) return new Response(null, { status: 400, headers: cors })
          if (!env.STATUS_CACHE) return new Response(null, { status: 503, headers: cors })
          const today = new Date().toISOString().split('T')[0]
          ctx.waitUntil(recordReferral(env.STATUS_CACHE, today, parsed.to).then((ok) => {
            if (!ok) console.warn('[referral] KV write failed for', parsed.to)
          }))
          return new Response(null, { status: 204, headers: cors })
        } catch (err) {
          if (err instanceof SyntaxError) return new Response(null, { status: 400, headers: cors })
          console.error('[referral] ingest error:', err instanceof Error ? err.message : err)
          return new Response(null, { status: 500, headers: cors })
        }
      }
    }

    // #842-B — consent-free outage-moment audience beacon. The is-down page fires a page-load beacon
    // here (outside any GA/consent guard) → one WAE data point per view, classified by inbound source
    // and tagged with the active-outage flag → the daily "Outage Audience" line. No KV (WAE absorbs
    // the viral-outage view spike; a per-view KV write would burn the budget). Origin-guarded like
    // /api/referral so non-browser noise doesn't inflate the metric.
    if (url.pathname === '/api/pageview') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
      if (request.method === 'POST') {
        if (!matchOrigin(origin, env.ALLOWED_ORIGIN)) return new Response(null, { status: 403, headers: cors })
        try {
          const parsed = parsePageviewBody(await request.json(), new Set(SERVICES.map(s => s.id)))
          if (!parsed) return new Response(null, { status: 400, headers: cors })
          recordOutageView(env.ANALYTICS, parsed.source, parsed.active, parsed.svc)
          return new Response(null, { status: 204, headers: cors })
        } catch (err) {
          if (err instanceof SyntaxError) return new Response(null, { status: 400, headers: cors })
          console.error('[pageview] ingest error:', err instanceof Error ? err.message : err)
          return new Response(null, { status: 500, headers: cors })
        }
      }
    }

    if (url.pathname === '/api/vitals') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors })
      }
      if (request.method === 'POST') {
        try {
          const body = await request.json()
          const metrics = parseVitals(body)
          if (!metrics) {
            return new Response(null, { status: 400, headers: cors })
          }
          if (!env.STATUS_CACHE) {
            console.error('[vitals] STATUS_CACHE binding missing — data dropped')
            return new Response(null, { status: 503, headers: cors })
          }
          ctx.waitUntil(writeVitalsToKV(env.STATUS_CACHE, metrics).catch((err) =>
            console.error('[vitals] KV write failed:', err instanceof Error ? err.message : err)
          ))
          return new Response(null, { status: 204, headers: cors })
        } catch (err) {
          if (err instanceof SyntaxError) {
            return new Response(null, { status: 400, headers: cors })
          }
          console.error('[vitals] ingest error:', err instanceof Error ? err.message : err)
          return new Response(null, { status: 500, headers: cors })
        }
      }
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    // POST /api/alert — Discord webhook proxy (CORS workaround). Discord-only since #467:
    // browser-side per-user alerts (webhookAlerts.js) + Settings "Send test" both target Discord;
    // Slack moved to the native /feed RSS subscription, which never hits this proxy.
    if (request.method === 'POST' && url.pathname === '/api/alert') {
      try {
        const body = await request.json() as { webhookUrl?: string; channel?: string; payload?: unknown }
        const { webhookUrl, channel, payload } = body
        if (!webhookUrl || !payload) {
          return new Response(JSON.stringify({ error: 'Missing webhookUrl or payload' }), {
            status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
          })
        }
        // Strict SSRF validation — HTTPS Discord webhook URLs only (pure, unit-tested predicate).
        if (!isAllowedAlertWebhook(webhookUrl)) {
          return new Response(JSON.stringify({ error: 'Webhook URL not allowed' }), {
            status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
          })
        }
        const parsed = new URL(webhookUrl) // safe — isAllowedAlertWebhook confirmed it parses
        // Rate limit: max 10 per minute per webhook URL
        const now = Date.now()
        const rateKey = parsed.pathname
        const rateEntry = alertProxyRate.get(rateKey)
        if (rateEntry && rateEntry.count >= 10 && now - rateEntry.start < 60_000) {
          return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
            status: 429, headers: { ...cors, 'Content-Type': 'application/json' },
          })
        }
        if (!rateEntry || now - rateEntry.start >= 60_000) {
          alertProxyRate.set(rateKey, { start: now, count: 1 })
        } else {
          rateEntry.count++
        }
        const resp = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        // Track delivery count in-memory (flushed to KV by daily summary cron)
        if (resp.ok) deliveryCounter.discord++
        else deliveryCounter.failed++
        resp.body?.cancel()
        return new Response(JSON.stringify({ ok: resp.ok, status: resp.status }), {
          status: resp.ok ? 200 : 502,
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return new Response(JSON.stringify({ error: message }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
    }

    // POST /api/report-issue — #575 Phase A crowd "Report an issue" (COLLECT ONLY, no public
    // display). Per-service per-UTC-day KV counter + IP-hash dedup; the count is used only as an
    // internal demand signal (daily summary). NEVER a "N reporting" verdict — gated corroboration
    // is Phase B. The honest 200 ack is identical whether or not this report was counted (a repeat
    // from the same IP/day is silently not double-counted), so the response can't be probed for
    // dedup state.
    if (request.method === 'POST' && url.pathname === '/api/report-issue') {
      const now = Date.now()
      const clientIp = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'local'
      if (overRateLimit(reportRate, clientIp, REPORT_MAX_PER_HOUR, now)) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
          status: 429, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      let body: { svcId?: unknown; category?: unknown; description?: unknown; source?: unknown }
      try { body = await request.json() as typeof body } catch { body = {} }
      const svcId = body.svcId
      if (!isReportableService(svcId, REPORTABLE_IDS)) {
        return new Response(JSON.stringify({ error: 'Unknown service' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      // Category is required + allowlisted; description is optional free text (sanitized for storage,
      // escaped again at render — it surfaces on the gated public display).
      const category = body.category
      if (!isValidCategory(category)) {
        return new Response(JSON.stringify({ error: 'Invalid category' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      const description = sanitizeReportDescription(body.description)
      const date = reportDateKey(now)
      const ipHash = await hashIp(clientIp, env.ADMIN_API_KEY ?? '')
      const seenKey = reportSeenKey(svcId, ipHash, date)
      const already = await env.STATUS_CACHE.get(seenKey).catch(() => null)
      if (!already) {
        const countKey = reportCountKey(svcId, date)
        const cur = await env.STATUS_CACHE.get(countKey).catch(() => null)
        // Read-modify-write — KV has no atomic increment. At AIWatch's volume (~22 visitors/incident)
        // a concurrent collision that loses one increment/append is acceptable for this soft demand
        // signal; not worth a Durable Object.
        const counted = await kvPut(env.STATUS_CACHE, countKey, String(nextCount(cur)), { expirationTtl: REPORT_COUNT_TTL_SECONDS })
        // Mark the IP "seen" (+ append to the feed) ONLY after the count actually persisted —
        // otherwise a failed count-write would lock the IP out for 24h with nothing recorded, silently
        // dropping the report with no retry. The feed powers the GATED display (#575).
        if (counted) {
          await kvPut(env.STATUS_CACHE, seenKey, '1', { expirationTtl: REPORT_SEEN_TTL_SECONDS })
          // #837 — tally reports that came FROM the Chrome extension (source:'ext') into a separate
          // per-day counter, so the daily summary can show extension engagement. Best-effort; a failed
          // write just under-counts this soft signal. Only after the main count persisted (same gate).
          if (isExtReportSource(body.source)) {
            const extKey = extReportCountKey(date)
            const extCur = await env.STATUS_CACHE.get(extKey).catch(() => null)
            await kvPut(env.STATUS_CACHE, extKey, String(nextCount(extCur)), { expirationTtl: REPORT_COUNT_TTL_SECONDS })
          }
          const feedKey = reportFeedKey(svcId)
          let feed: ReportFeedEntry[] = []
          // Log on parse failure — here the empty fallback then OVERWRITES the stored feed (read-
          // modify-write), so a corrupt value silently drops prior reports; make it observable.
          try { const raw = await env.STATUS_CACHE.get(feedKey); feed = raw ? JSON.parse(raw) : [] } catch (err) { console.warn('[report] feed read (write path) failed:', svcId, err instanceof Error ? err.message : err); feed = [] }
          const updated = appendReportFeed(recentReportFeed(feed, now), { cat: category, desc: description, ts: now })
          await kvPut(env.STATUS_CACHE, feedKey, JSON.stringify(updated), { expirationTtl: REPORT_FEED_TTL_SECONDS })
        }
      }
      return new Response(JSON.stringify({ ok: true, message: 'Thanks — we factor this into our monitoring.' }), {
        status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    // GET /api/report-feed?svc=:id — recent (24h) crowd reports for one service (#575). The
    // is-down Edge fetches this ONLY when an independent signal already shows a problem (the gate),
    // so a public "N reporting" feed never contradicts an official `operational`. The endpoint
    // itself is a cheap KV read; the gating lives at the call site.
    if (request.method === 'GET' && url.pathname === '/api/report-feed') {
      const svc = url.searchParams.get('svc') ?? ''
      if (!REPORTABLE_IDS.has(svc)) {
        return new Response(JSON.stringify({ error: 'Unknown service' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      let feed: ReportFeedEntry[] = []
      try { const raw = await env.STATUS_CACHE.get(reportFeedKey(svc)); feed = raw ? JSON.parse(raw) : [] } catch (err) { console.warn('[report] feed read (api) failed:', svc, err instanceof Error ? err.message : err); feed = [] }
      return new Response(JSON.stringify({ reports: recentReportFeed(feed, Date.now()) }), {
        status: 200, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=30' },
      })
    }

    // POST /api/admin/analyze — operator override to run Sonnet analysis on a specific
    // incident (#299). Motivated by 2026-04-20 ChatGPT outage where Gemma produced a
    // generic "service availability issue" analysis and Sonnet (same prompt/data) correctly
    // identified a systemic infra failure. Before this endpoint the override required
    // hand-editing a Node script + `wrangler kv key put --remote`, racing the cron.
    if (request.method === 'POST' && url.pathname === '/api/admin/analyze') {
      return handleAdminAnalyze(request, env, cors)
    }

    // POST /api/internal/edge-fallback — Vercel Edge Functions notify Worker on
    // degraded fallback render so the operator gets a Discord alert (#378). KV
    // dedup ensures one notice per 5min per surface+slug.
    if (request.method === 'POST' && url.pathname === '/api/internal/edge-fallback') {
      return handleEdgeFallbackAlert(request, env, cors)
    }

    // POST /api/internal/deepseek-feed — GitHub Action scraper pushes the browser-rendered
    // Flashduty feed for DeepSeek (#618), cached in KV for fetchService to normalize.
    if (request.method === 'POST' && url.pathname === '/api/internal/deepseek-feed') {
      return handleDeepseekFeed(request, env, cors)
    }

    // POST /api/admin/rebuild-archive — operator tool to regenerate a specific month's
    // archive:monthly:{YYYY-MM} after a bug-fix deploy. Cron only writes when the key
    // doesn't exist; this endpoint unconditionally overwrites.
    if (request.method === 'POST' && url.pathname === '/api/admin/rebuild-archive') {
      return handleAdminRebuildArchive(request, env, cors)
    }

    // #904 — GET/POST /api/admin/suppress — operator incident-suppression list. POST adds/removes a
    // suppression (per-incident id, or per-service title pattern); GET lists. Applied across the live
    // list, Score, monthly accumulator, and rebuilt archives so un-exposing an incident needs no deploy.
    if ((request.method === 'POST' || request.method === 'GET') && url.pathname === '/api/admin/suppress') {
      return handleAdminSuppress(request, env, cors)
    }

    // #1019 — GET/POST /api/admin/duration-override — operator incident duration-override list. POST
    // adds/removes { id, durationMin }; GET lists. Pins a paperwork-inflated incident's duration to the
    // real value across the monthly archive, the report partial, and the weekly briefing (keeps the
    // incident; only corrects its duration — unlike suppression, which hides it).
    if ((request.method === 'POST' || request.method === 'GET') && url.pathname === '/api/admin/duration-override') {
      return handleAdminOverride(request, env, cors)
    }

    // #1106 Part 5 — GET /api/admin/withdrawals?month=YYYY-MM — the durable record of provider-DELETED
    // incidents and whether each one's ⚪ closing notice actually went out. Read-only; every other
    // trace of a withdrawal expires within a week, so this is the only surface that can answer the
    // question months later.
    if (request.method === 'GET' && url.pathname === '/api/admin/withdrawals') {
      return handleAdminWithdrawals(request, env, cors)
    }

    // #486 — server-side per-user Discord subscription endpoints. The browser POSTs the raw URL +
    // filters here; the worker stores the AES-GCM-encrypted URL and (PR3) the cron fan-out delivers
    // directly, so alerts fire tab-independently. Ownership is proven by a confirm code sent THROUGH
    // the webhook channel (double opt-in / challenge-response) — channel control = identity, no
    // account/PII. CORS-guarded like /api/alert; per-IP rate limited via overRateLimit.
    if (request.method === 'POST' && url.pathname === '/api/webhook/subscribe') {
      const origin = request.headers.get('Origin')
      const cors = corsHeaders(origin, env.ALLOWED_ORIGIN)
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
      const now = Date.now()
      if (overRateLimit(webhookSubRate, ip, 10, now)) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
      try {
        const body = await request.json() as { url?: string; filters?: unknown }
        const hourBucket = new Date(now).toISOString().slice(0, 13) // YYYY-MM-DDTHH — hourly budget bucket
        const result = await subscribeWebhook(
          env.STATUS_CACHE, env.WEBHOOK_ENC_KEY, body.url ?? '', body.filters, hourBucket,
          new Date(now).toISOString(),
          // The confirm message is the channel-control challenge: posted to the webhook itself. The
          // link is crawler-safe — /confirm GET only renders a page; activation is the button POST.
          async (target, code) => {
            try {
              const h = await webhookSha256Hex(target)
              const confirmBase = (env.CONFIRM_BASE_URL || 'https://ai-watch.dev').replace(/\/$/, '')
              const r = await fetch(target, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: `🔔 **AIWatch** — confirm alerts for this channel:\n${confirmBase}/confirm?h=${h}&c=${code}\n\n*(Ignore this message if you didn't request AIWatch alerts.)*` }),
              })
              r.body?.cancel()
              if (!r.ok) console.warn(`[webhook/subscribe] confirm post rejected by Discord (${r.status})`)
              return r.ok
            } catch (err) {
              console.warn('[webhook/subscribe] confirm post network error:', err instanceof Error ? err.message : err)
              return false
            }
          },
        )
        if (!result.ok) {
          return new Response(JSON.stringify({ error: result.error }), { status: result.status, headers: { ...cors, 'Content-Type': 'application/json' } })
        }
        // status: 'sent' (code dispatched) | 'pending' (code already in-flight) | 'confirmed'
        // (already subscribed) — lets the SPA (PR2) show the right message without re-charging budget.
        return new Response(JSON.stringify({ ok: true, hash: result.hash, status: result.status }), { headers: { ...cors, 'Content-Type': 'application/json' } })
      } catch (err) {
        console.error('[webhook/subscribe] error:', err instanceof Error ? err.message : err)
        return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/webhook/confirm') {
      const origin = request.headers.get('Origin')
      const cors = corsHeaders(origin, env.ALLOWED_ORIGIN)
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
      const now = Date.now()
      if (overRateLimit(webhookConfirmRate, ip, 20, now)) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
      try {
        const body = await request.json() as { hash?: string; code?: string }
        const result = await confirmWebhook(env.STATUS_CACHE, body.hash ?? '', body.code ?? '', new Date(now).toISOString())
        if (!result.ok) {
          return new Response(JSON.stringify({ error: result.error }), { status: result.status, headers: { ...cors, 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } })
      } catch (err) {
        console.error('[webhook/confirm] error:', err instanceof Error ? err.message : err)
        return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
    }

    // Filters-only update on a confirmed sub — no new OTP (channel control already proven). A URL
    // change is a new channel ⇒ the client must re-subscribe instead.
    if (request.method === 'POST' && url.pathname === '/api/webhook/update') {
      const origin = request.headers.get('Origin')
      const cors = corsHeaders(origin, env.ALLOWED_ORIGIN)
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
      const now = Date.now()
      if (overRateLimit(webhookSubRate, ip, 10, now)) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
      try {
        const body = await request.json() as { hash?: string; filters?: unknown }
        const result = await updateWebhookFilters(env.STATUS_CACHE, body.hash ?? '', body.filters)
        if (!result.ok) {
          return new Response(JSON.stringify({ error: result.error }), { status: result.status, headers: { ...cors, 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } })
      } catch (err) {
        console.error('[webhook/update] error:', err instanceof Error ? err.message : err)
        return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
    }

    // Unsubscribe = immediate complete deletion (privacy deletion path). hash-only, idempotent KV
    // deletes; no rate limit (deleting a sub requires knowing the SHA-256 of the exact webhook URL,
    // infeasible without the URL itself, so there's no useful abuse surface to throttle).
    if (request.method === 'POST' && url.pathname === '/api/webhook/unsubscribe') {
      const origin = request.headers.get('Origin')
      const cors = corsHeaders(origin, env.ALLOWED_ORIGIN)
      try {
        const body = await request.json() as { hash?: string }
        const result = await unsubscribeWebhook(env.STATUS_CACHE, body.hash ?? '')
        if (!result.ok) {
          return new Response(JSON.stringify({ error: result.error }), { status: result.status, headers: { ...cors, 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } })
      } catch (err) {
        console.error('[webhook/unsubscribe] error:', err instanceof Error ? err.message : err)
        return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
    }

    // (#486 PR3) The legacy POST/DELETE /api/webhook/ping endpoint (browser-side webhook:reg: count)
    // was removed with the browser relay — active-webhook counts now come from confirmed
    // subscriptions (webhook:sub:*, counted via listConfirmedHashes in the daily summary).

    // GET/HEAD /api/og — dynamic OG image (PNG) for social share previews.
    // #1196 — HEAD support: this route used to match GET only, so a HEAD request fell through to
    // the generic router-level 404 — a real gap found while diagnosing a "card didn't unfurl" report
    // tied to #1063/#1194's og:url pin (the actual cause there turned out to be a transient X-side
    // retry, not this, but a link-unfurling endpoint with no HEAD handling is a latent risk
    // regardless — some crawlers/validators probe with HEAD before committing to a GET). Same body-
    // generation path as GET; HEAD strips the body before responding (the standard HEAD contract:
    // identical headers, no body) rather than skipping the render — simpler and avoids a
    // Content-Length that could disagree with a real GET.
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/og') {
      const isHead = request.method === 'HEAD'
      const service = (url.searchParams.get('service') || 'Unknown').slice(0, 50)
      const status = url.searchParams.get('status') || 'operational'
      const score = (url.searchParams.get('score') || '').slice(0, 5)
      const uptime = (url.searchParams.get('uptime') || '').slice(0, 6)
      const svg = generateOgSvg(service, status, score, uptime)
      try {
        const { renderPng } = await import('./og-render')
        const png = await renderPng(svg)
        return new Response(isHead ? null : png, {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=600, s-maxage=600',
            'Access-Control-Allow-Origin': '*',
          },
        })
      } catch (err) {
        console.error('[og] PNG render failed, falling back to SVG:', err instanceof Error ? err.message : err)
        return new Response(isHead ? null : svg, {
          headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'public, max-age=60, s-maxage=60',
            'Access-Control-Allow-Origin': '*',
          },
        })
      }
    }

    // GET /feed.xsl — client-side XSLT so browsers render the feed as a page instead of
    // downloading raw XML (#467). Static, no KV read. Same-origin requirement met via the
    // /feed.xsl Vercel rewrite (mirrors /feed.xml).
    if (request.method === 'GET' && url.pathname === '/feed.xsl') {
      return new Response(FEED_XSL, {
        status: 200,
        headers: {
          'Content-Type': 'text/xsl; charset=utf-8',
          // 1h, not a day: the stylesheet evolves with the feed item shape, and a long TTL
          // strands returning visitors on a stale XSL (e.g. showing literal <p> tags) after a
          // format change. Short enough to propagate, long enough to stay cheap (#467).
          'Cache-Control': 'public, max-age=3600, s-maxage=3600',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    // GET /feed.xml + /feed/:slug — incident RSS 2.0 feeds (#54).
    // The 400/404/503/200 decision lives in buildFeedResponse (rss.ts) so it is
    // unit-tested; this handler only does the KV read + Response wrapping.
    // A null cache (KV down / missing / corrupt) → 503, distinct from a
    // present-but-empty cache which is a legitimate 200 empty feed.
    if (
      request.method === 'GET' &&
      (url.pathname === '/feed.xml' || url.pathname.startsWith('/feed/'))
    ) {
      // #548 — record the poll in WAE (consent-free retention proxy: a post-outage step-up in feed
      // volume = retained RSS/Slack subscribers). Best-effort, before the KV read so a 503 still counts.
      recordFeedTraffic(env.ANALYTICS, url.pathname)
      const feedReq: FeedRequest =
        url.pathname === '/feed.xml'
          ? { scope: 'all' }
          : { scope: 'service', segment: url.pathname.split('/')[2] ?? '' }
      const cached = await cacheRead(env.STATUS_CACHE, env.ANALYTICS)
      // #724 — align the Slack /feed item with the Discord embed: (a) attach aiwatchScore to the
      // cached services so the "Try instead" fallback ranks identically to Discord (services:latest
      // has no score; getFallbacks needs it), and (b) read the per-incident AI analysis so the item
      // carries the same 🤖 summary. Public-safe — the operator-only tweet draft is never included.
      let feedCached = cached
      let feedAiAnalysis: RssAiAnalysisMap | undefined
      let feedFirstSeen: Record<string, string> | undefined // #750 — incId → first-detected ISO
      let feedServedActive: Set<string> | undefined // #793 — resolved incIds whose active item was served
      let feedWithdrawn: WithdrawnIncident[] | undefined // #1106 — provider-deleted incidents to close out
      // #793 — ONE clock for both the emitted-marker stamp decision (handler) AND the hold/emit decision
      // (buildRssFeed), threaded as buildFeedResponse's `now`. If buildRssFeed defaulted its own (later)
      // `new Date()`, an item right at the AI_HOLD_MS boundary could be "held" at stamp time yet "released"
      // at serve time → emitted WITHOUT a marker → its resolution later wrongly suppressed.
      const feedNow = new Date()
      if (cached && env.STATUS_CACHE) {
        const feedProbe = await readProbeSummaries(env.STATUS_CACHE, 'feed')
        feedCached = {
          ...cached,
          services: cached.services.map((svc) => {
            const s = scoreFor(svc, feedProbe)
            return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade, scoreConfidence: s.confidence }
          }),
        }
        // #750 — first-detected stamp for each ACTIVE incident → a FRESH active-item pubDate (a
        // backdated provider startedAt makes Slack /feed skip the outage post). Written once by the
        // cron's alerted:new path; absent → rss.ts falls back to startedAt (legacy behavior).
        const firstSeen: Record<string, string> = {}
        const nowIso = new Date().toISOString()
        await Promise.all(cached.services.flatMap((svc) =>
          (svc.incidents ?? [])
            .filter((i) => i.status !== 'resolved')
            .map(async (inc) => {
              const fsKey = `feed:firstseen:${inc.id}`
              // get THREW (KV hiccup) → skip entirely: do NOT stamp (would risk clobbering an existing
              // value and breaking #750 first-write-wins) and do NOT add to the map (rss.ts falls back).
              let existing: string | null
              try { existing = await env.STATUS_CACHE!.get(fsKey) } catch { return }
              // #776 — stamp at FEED-VISIBILITY on a clean miss so the #759 hold engages in the pre-cron
              // window (else an AI-less item leaks to Slack + re-posts when AI lands). get-or-set; the
              // cron's alerted:new path stamps the same key with the same 7d TTL — whichever fires first
              // wins. One write per incident (only on the clean miss). NOTE this makes /feed a SECOND
              // feed:firstseen write surface (previously cron-only), so it now also stamps incidents the
              // cron held/suppressed/never-alerted (flap, monitoring) — which widens the population that
              // #748 countNewFeedItems counts. Harmless: that metric is an explicit upper bound.
              const { use, stamp } = resolveFeedFirstSeen(existing, nowIso)
              if (stamp) {
                const ok = await kvPut(env.STATUS_CACHE!, fsKey, use, { expirationTtl: 604800 })
                if (!ok) return // write failed → leave unanchored this cycle (retried next poll)
              }
              firstSeen[inc.id] = use
            }),
        ))
        if (Object.keys(firstSeen).length > 0) feedFirstSeen = firstSeen
        const analysis: RssAiAnalysisMap = {}
        await Promise.all(cached.services.flatMap((svc) =>
          (svc.incidents ?? [])
            // #827 F4 — also load RESOLVED analyses (still present for 2h post-resolution) so the
            // resolved feed item can render "predicted vs actual". `monitoring` stays excluded (#724).
            .filter((i) => i.status !== 'monitoring')
            .map(async (inc) => {
              const raw = await env.STATUS_CACHE!.get(analysisKey(svc.id, inc.id)).catch(() => null)
              if (!raw) return
              try {
                const a = JSON.parse(raw) as AIAnalysisResult
                ;(analysis[svc.id] ??= []).push({
                  incidentId: inc.id, summary: a.summary,
                  estimatedRecovery: a.estimatedRecovery, affectedScope: a.affectedScope ?? [],
                  ...(a.estimatedRecoveryHours != null && { estimatedRecoveryHours: a.estimatedRecoveryHours }),
                  // #1003 — the resolved item scores against the FIRST estimate, so carry it too.
                  ...(a.firstEstimatedRecoveryHours != null && { firstEstimatedRecoveryHours: a.firstEstimatedRecoveryHours }),
                })
              } catch (err) { console.warn('[rss] ai:analysis parse failed:', svc.id, inc.id, err instanceof Error ? err.message : err) }
            }),
        ))
        if (Object.keys(analysis).length > 0) feedAiAnalysis = analysis
        // #793 — orphan-resolution guard. Stamp `feed:active-emitted:{incId}` for each active item that
        // is actually SERVED this render (not held by the #759 AI-hold, via the shared isActiveItemHeld
        // predicate); then read those markers for RESOLVED incidents → servedActive. buildRssFeed
        // suppresses a resolved item whose active item was never served, so a short blip whose entire
        // active window fell between reader polls doesn't post a lone "Resolved · 19m" with no prior
        // outage post (the Slack orphan-resolution). 7d TTL, get-or-set (one write per incident).
        // Scope the marker to the services THIS feed actually serves: a /feed/openai poll does NOT carry
        // langfuse's active item, so it must not stamp langfuse's marker (else langfuse-feed subscribers
        // still get an orphan). All-scope serves every service; service-scope serves the resolved one only.
        const servedSvcIds: Set<string> | null = feedReq.scope === 'all'
          ? null // null = all services served
          : (() => { const s = resolveFeedService(cached.services, feedReq.segment); return s ? new Set([s.id]) : new Set<string>() })()
        const inServedScope = (svcId: string) => servedSvcIds === null || servedSvcIds.has(svcId)
        await Promise.all(cached.services.filter((svc) => inServedScope(svc.id)).flatMap((svc) =>
          (svc.incidents ?? [])
            .filter((i) => i.status !== 'resolved')
            .map(async (inc) => {
              const a = (analysis[svc.id] ?? []).find((x) => x.incidentId === inc.id)
              if (isActiveItemHeld(inc, a, firstSeen[inc.id], feedNow)) return // held → not served yet
              const key = `feed:active-emitted:${inc.id}`
              // get-or-set. CRITICAL: a missing marker fails UNSAFE here (suppresses the later resolved —
              // unlike feed:firstseen which falls back to startedAt and still emits), so a GET throw must
              // NOT skip the write: bias toward recording "served" (attempt the idempotent put anyway).
              // The whole point of #793 is a single-poll-wide blip, where there's no retry to self-heal.
              let existing: string | null = null
              try { existing = await env.STATUS_CACHE!.get(key) }
              catch (err) { console.warn('[rss] #793 active-emitted get failed — stamping anyway:', inc.id, err instanceof Error ? err.message : err) }
              if (existing) return // already stamped (first-write-wins)
              const ok = await kvPut(env.STATUS_CACHE!, key, feedNow.toISOString(), { expirationTtl: 604800 })
              if (!ok) console.warn('[rss] #793 active-emitted put failed — resolution may suppress until re-stamped:', inc.id)
            }),
        ))
        const servedActive = new Set<string>()
        await Promise.all(cached.services.filter((svc) => inServedScope(svc.id)).flatMap((svc) =>
          (svc.incidents ?? [])
            .filter((i) => i.status === 'resolved')
            .map(async (inc) => {
              // Clean miss (null) → leave OUT → buildRssFeed suppresses the orphan resolved item.
              // A KV throw is indistinguishable from "never served", so fail OPEN (add → emit the
              // resolved) — dropping a legit recovery notice is worse than letting one orphan through.
              try {
                if (await env.STATUS_CACHE!.get(`feed:active-emitted:${inc.id}`)) servedActive.add(inc.id)
              } catch (err) {
                console.warn('[rss] #793 active-emitted read failed — failing open (emit resolved):', inc.id, err instanceof Error ? err.message : err)
                servedActive.add(inc.id)
              }
            }),
        ))
        // #1106 — the same orphan guard for withdrawal items. A tombstoned incident is normally
        // absent from `cached.services`, so the resolved-incident loop above can never reach its
        // marker; probe them explicitly here and fold the results into the SAME servedActive set the
        // renderer gates on. Identical fail-open rule: a KV throw is indistinguishable from "never
        // served", and leaving a subscriber's 🔴 message unclosed forever is worse than one
        // withdrawal notice for an outage they might not have seen.
        // `feedNow`, not a fresh clock: this block goes out of its way to thread ONE clock through
        // the stamp decision and the render (#793), and the age filter is part of what the render sees.
        const withdrawnAll = await readWithdrawn(env.STATUS_CACHE, feedNow.getTime())
        if (withdrawnAll.length > 0) {
          await Promise.all(withdrawnAll.filter((w) => inServedScope(w.svcId)).map(async (w) => {
            try {
              if (await env.STATUS_CACHE!.get(`feed:active-emitted:${w.incId}`)) servedActive.add(w.incId)
            } catch (err) {
              console.warn('[rss] #1106 active-emitted read failed — failing open (emit withdrawal):', w.incId, err instanceof Error ? err.message : err)
              servedActive.add(w.incId)
            }
          }))
          feedWithdrawn = withdrawnAll
        }
        feedServedActive = servedActive
      }
      const result = buildFeedResponse(feedCached, feedReq, feedNow, feedAiAnalysis, feedFirstSeen, feedServedActive, feedWithdrawn)
      if (!result.ok && result.status === 503) {
        // Same severity as /api/report's KV-read failure — log at error so it
        // lands in the same operator alerting tier.
        console.error(`[rss] ${url.pathname} — status cache unavailable, returning 503`)
      }
      if (result.ok) {
        // #860 — conditional GET (ETag over the byte-deterministic body → 304 on
        // If-None-Match) lets RSS pollers (incl. Slack /feed) + the Vercel edge
        // revalidate cheaply instead of re-pulling the full body, and signals a
        // healthy revalidatable feed so pollers back off less (the 8:16→9:45 KST
        // Slack-silence root cause). Header contract lives in feedHttpResponse.
        return feedHttpResponse(result, request.headers.get('If-None-Match'))
      }
      return new Response(result.message, {
        status: result.status,
        headers: {
          'Content-Type': 'text/plain',
          // 503 is transient (data layer down) → no-store so readers retry;
          // 400/404 are stable client errors → briefly cacheable.
          'Cache-Control': result.status === 503 ? 'no-store' : 'public, max-age=60',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    // GET /badge/:serviceId — dynamic SVG status badge
    if (request.method === 'GET' && url.pathname.startsWith('/badge/')) {
      const serviceId = url.pathname.split('/')[2] ?? ''
      if (!/^[a-z0-9_-]+$/i.test(serviceId)) {
        return new Response(generateBadgeSvg('error', 'invalid id', '#9e9e9e', 'flat'), {
          status: 400,
          headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' },
        })
      }
      const showUptime = url.searchParams.get('uptime') === 'true'
      const style = url.searchParams.get('style') === 'flat-square' ? 'flat-square' : 'flat'
      const customLabel = url.searchParams.get('label')

      // Read cached services from KV
      const badgeCache = await cacheRead(env.STATUS_CACHE, env.ANALYTICS)
      // #1233 — `status` is the real union, not a bare `string`. The widened annotation was what let the
      // badge's color chain fall through to red for `unknown` with nothing to flag it: `badgeStatusColor`
      // is exhaustive, but only if what reaches it is typed.
      const service: { name: string; status: ServiceStatus['status']; uptime30d?: number | null } | null =
        badgeCache ? badgeCache.services.find((s) => s.id === serviceId) ?? null : null

      // #1227 — "we cannot read the snapshot" is not "this service does not exist". The old code
      // collapsed both into a 404 `not found` badge, which is a confident wrong answer about a
      // service we do monitor, and it booked the read failure as a BADGE_UNKNOWN_SERVICE embed —
      // polluting the #1157 unknown-id signal with our own KV faults. Same grey badge, honest word,
      // 503 so a cache is not built on it, and no traffic record (there is no embed to attribute).
      if (!badgeCache) {
        return new Response(generateBadgeSvg(customLabel ?? serviceId, 'unknown', '#9e9e9e', style), {
          status: 503,
          headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
        })
      }

      if (!service) {
        // #1157 — still record: a stale/retired-service embed (or a typo'd/scanner-probed id) is a
        // real signal worth counting. `{ known: false }` — recordBadgeTraffic itself substitutes the
        // BADGE_UNKNOWN_SERVICE sentinel, so this call site has no raw string to accidentally leak
        // into blob1 (see the cardinality note in api-traffic.ts).
        recordBadgeTraffic(env.ANALYTICS, { known: false })
        return new Response(generateBadgeSvg(customLabel ?? serviceId, 'not found', '#9e9e9e', style), {
          status: 404,
          headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' },
        })
      }

      // #1157 — badge-request WAE instrumentation, mirrors #518 (/api/v1) and #548 (/feed). Excludes
      // the 400 invalid-id branch above (mirrors #518 excluding 429s: that branch never resolves to a
      // real service, so it isn't a meaningful embed signal). `serviceId` is a known service id here
      // (the `find(s => s.id === serviceId)` lookup above just matched).
      recordBadgeTraffic(env.ANALYTICS, { known: true, serviceId })

      const label = customLabel ?? service.name
      const statusColor = badgeStatusColor(service.status)
      // Widened deliberately: the badge's TEXT may be replaced by an uptime percentage below.
      let statusText: string = service.status
      // #1233 — but NOT for an unreadable source. Some fetch-failure legs deliberately carry the last
      // measured `uptime30d` forward, so `?uptime=true` would render a grey badge whose text reads
      // "99.98%" — the word "unknown" gone, and the only remaining signal a colour most readers will not
      // decode. The colour and the text have to say the same thing.
      if (showUptime && service.uptime30d != null && !isUnreadableStatus(service.status)) {
        statusText = `${service.uptime30d.toFixed(2)}%`
      }

      return new Response(generateBadgeSvg(label, statusText, statusColor, style), {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=60',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    // GET /api/v1/status — public API (lightweight, CORS *, rate limited)
    if (request.method === 'GET' && (url.pathname === '/api/v1/status' || url.pathname.startsWith('/api/v1/status/'))) {
      // Rate limit: 60 req/min per IP
      const clientIp = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'local'
      const rateEntry = publicApiRate.get(clientIp)
      const now = Date.now()
      if (rateEntry && rateEntry.count >= 60 && now - rateEntry.start < 60_000) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded. Max 60 requests/minute.' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Retry-After': '60' },
        })
      }
      if (!rateEntry || now - rateEntry.start >= 60_000) {
        publicApiRate.set(clientIp, { start: now, count: 1 })
      } else {
        rateEntry.count++
      }
      // Evict stale entries to prevent memory leak
      if (publicApiRate.size > 10_000) {
        for (const [ip, entry] of publicApiRate) {
          if (now - entry.start >= 60_000) publicApiRate.delete(ip)
        }
      }

      // Record this served (non-429) v1 request in WAE so call volume is queryable (#518).
      // Placed after the rate-limit gate so 429s are excluded; before the cache read so a
      // 503 (cache miss) still counts as received traffic. Best-effort — never blocks the response.
      recordV1Traffic(env.ANALYTICS, url.pathname)

      // Read cached services
      const cached = await cacheRead(env.STATUS_CACHE, env.ANALYTICS)
      if (!cached) {
        return new Response(JSON.stringify({ error: 'Service data not available' }), {
          status: 503, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        })
      }

      const publicHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=30',
      }

      const v1ProbeSummaries = await readProbeSummaries(env.STATUS_CACHE, 'v1')

      // Individual service: /api/v1/status/:serviceId
      const segments = url.pathname.split('/')
      const serviceId = segments[4] ?? ''
      if (segments.length > 5) {
        return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: publicHeaders })
      }
      if (serviceId && !/^[a-z0-9_-]+$/i.test(serviceId)) {
        return new Response(JSON.stringify({ error: 'Invalid service ID' }), { status: 400, headers: publicHeaders })
      }
      if (serviceId) {
        const svc = cached.services.find((s) => s.id === serviceId)
        if (!svc) {
          return new Response(JSON.stringify({ error: `Service '${serviceId}' not found` }), {
            status: 404, headers: publicHeaders,
          })
        }
        const scoreData = scoreFor(svc, v1ProbeSummaries)
        return new Response(JSON.stringify({
          service: {
            id: svc.id, name: svc.name, provider: svc.provider, category: svc.category,
            group: serviceGroupOf(svc.id), // #1068 — fine category (llm/voice/…); coarse `category` unchanged
            status: svc.status, latency: svc.latency, uptime30d: svc.uptime30d,
            uptimeSource: svc.uptimeSource, lastChecked: svc.lastChecked,
            incidents: (svc.incidents ?? []).slice(0, 5).map((i) => ({
              id: i.id, title: i.title, status: i.status, impact: i.impact,
              startedAt: i.startedAt, duration: i.duration,
            })),
            aiwatchScore: scoreData.score,
            scoreGrade: scoreData.grade,
            scoreConfidence: scoreData.confidence,
            scoreBreakdown: scoreData.breakdown,
            scoreMetrics: scoreData.metrics,
            ...(PROBE_INHERIT[svc.id] ? { probeInheritedFrom: PROBE_INHERIT[svc.id] } : {}),
          },
          cachedAt: cached.cachedAt,
        }), { status: 200, headers: publicHeaders })
      }

      // All services: /api/v1/status
      return new Response(JSON.stringify({
        services: cached.services.map((svc) => {
          const scoreData = scoreFor(svc, v1ProbeSummaries)
          return {
            id: svc.id, name: svc.name, provider: svc.provider, category: svc.category,
            group: serviceGroupOf(svc.id), // #1068 — fine category (llm/voice/…); coarse `category` unchanged
            status: svc.status, latency: svc.latency, uptime30d: svc.uptime30d,
            uptimeSource: svc.uptimeSource, lastChecked: svc.lastChecked,
            incidentCount: (svc.incidents ?? []).length,
            // #713 — scoreConfidence disambiguates a null aiwatchScore (low-confidence: no official
            // uptime + no probe → score withheld) from a missing/errored value, matching the
            // single-service response below.
            aiwatchScore: scoreData.score, scoreGrade: scoreData.grade, scoreConfidence: scoreData.confidence,
          }
        }),
        cachedAt: cached.cachedAt,
      }), { status: 200, headers: publicHeaders })
    }

    // GET /api/statusline/down — parseable UNCAPPED down-list (#920) for the plugin monitor's
    // transition tracking (`status<TAB>name` per non-operational service, empty when all clear).
    // Distinct from the capped emoji presets; consumed only by bin/aiwatch-monitor.sh. Must precede
    // the generic /api/statusline/:preset route ('down' is not a preset). WAE-tagged 'aiwatch-monitor'
    // (NOT statusline-*, so continuous monitor polling doesn't pollute the #918 preset-adoption metric).
    // #1227 — an unreadable snapshot returns 503, NOT the empty 200 that means "all clear"; the
    // status/body/cache-control decision is `buildStatuslineDownResponse` (see its comment).
    if (request.method === 'GET' && url.pathname === '/api/statusline/down') {
      if (env.ANALYTICS) {
        try {
          env.ANALYTICS.writeDataPoint({ blobs: ['aiwatch-monitor'], doubles: [1], indexes: ['aiwatch-monitor'] })
        } catch (err) {
          console.warn('[wae] aiwatch-monitor writeDataPoint failed:', err instanceof Error ? err.message : err)
        }
      }
      const liteCache = await cacheRead(env.STATUS_CACHE, env.ANALYTICS)
      const down = buildStatuslineDownResponse(liteCache)
      return new Response(down.body, {
        status: down.status,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': down.cacheControl,
        },
      })
    }

    // GET /api/statusline/brief — server-rendered compact INCIDENT briefing (#920) for the
    // Claude Code plugin's /aiwatch command. text/plain, multi-line: each non-operational service
    // with its active incident (title + impact), the AI summary of that incident when present, and
    // a per-category fallback — the "what's actually happening" the names-only presets can't give.
    // A generalization of the ext-claude projection (#837) to text; keeps the plugin a thin curl
    // (no jq). Must precede the generic /api/statusline/:preset route ('brief' isn't a preset).
    if (request.method === 'GET' && url.pathname === '/api/statusline/brief') {
      if (env.ANALYTICS) {
        // Tag as 'aiwatch-brief', NOT 'statusline-<preset>': the #918 read-back
        // (queryStatuslineTraffic) selects `index1 LIKE 'statusline-%'`, so a statusline-
        // prefix here would misattribute on-demand /aiwatch briefing traffic as statusline
        // PRESET adoption (a distinct feature). Distinct index → measurable separately later.
        try {
          env.ANALYTICS.writeDataPoint({ blobs: ['aiwatch-brief'], doubles: [1], indexes: ['aiwatch-brief'] })
        } catch (err) {
          console.warn('[wae] aiwatch-brief writeDataPoint failed:', err instanceof Error ? err.message : err)
        }
      }
      const cacheData = await cacheRead(env.STATUS_CACHE, env.ANALYTICS)
      // #1227 — no snapshot ⇒ say "unknown", never the "all operational ✅" that an empty list
      // renders. Served 200 (not 503) so the plugin prints THIS line rather than its own
      // "(network error)" fallback, which would misattribute our own fault to the user's network.
      if (!cacheData) {
        console.warn('[statusline/brief] no status snapshot (KV miss or read failure) — serving the unknown briefing')
        return new Response(STATUSLINE_BRIEF_UNKNOWN, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          },
        })
      }
      const summaries = await readProbeSummaries(env.STATUS_CACHE, 'statusline-brief')
      // Score the FULL set — getFallbacks needs the candidate pool — then narrow in the renderer.
      const scoredAll = cacheData.services.map((svc) => {
        const s = scoreFor(svc, summaries)
        return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade, scoreConfidence: s.confidence }
      })
      // AI summary of each ACTIVE incident on a non-operational service (bounded: only down/degraded
      // services, usually few). Best-effort per key: a missing/unparseable ai:analysis → no summary,
      // never a 500 (mirrors the ext-claude reads).
      const briefAiSummary: Record<string, string> = {}
      await Promise.all(scoredAll
        // #1233 — `isAffectedStatus`. An `unknown` service carries no incidents (the fetch is what
        // failed), so this is behaviour-neutral today; it is spelled correctly so it stays that way.
        .filter((svc) => isAffectedStatus(svc.status))
        .flatMap((svc) => (svc.incidents ?? [])
          .filter((i) => i.status !== 'resolved' && i.status !== 'monitoring')
          .map(async (inc) => {
            const raw = await env.STATUS_CACHE.get(analysisKey(svc.id, inc.id)).catch(() => null)
            if (!raw) return
            try {
              const a = JSON.parse(raw) as AIAnalysisResult
              if (a.summary) briefAiSummary[`${svc.id}:${inc.id}`] = a.summary
            } catch (err) {
              console.warn('[statusline-brief] ai:analysis parse failed:', svc.id, inc.id, err instanceof Error ? err.message : err)
            }
          })))
      return new Response(renderStatuslineBrief(scoredAll, briefAiSummary), {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=30',
        },
      })
    }

    // GET /api/statusline/:preset — server-rendered Claude Code statusline string (#918).
    // Returns text/plain (the exact OSC-8 string the statusline shows), so the settings.json
    // snippet is a thin `curl … || true` with NO jq. The old model shipped the display logic
    // as a client-side jq program frozen in the user's config — a display change (e.g. the +N
    // overflow) could never reach an installed statusline. Rendering server-side means every
    // future display change ships to all users via a worker deploy, and drops the jq dependency.
    if (request.method === 'GET' && url.pathname.startsWith('/api/statusline/')) {
      const preset = url.pathname.slice('/api/statusline/'.length)
      // Unknown preset → 404 (curl -sf drops it → clean empty statusline). Allowlist-guarded.
      if (!isStatuslinePreset(preset)) {
        return new Response('', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } })
      }
      // WAE: tag with the SAME `statusline-<preset>` index as the legacy ?src poll (#494) so the
      // #918 daily read-back (queryStatuslineTraffic) counts old + new polls uniformly. Best-effort:
      // writeDataPoint can throw on payload/binding errors — never let that abort the response.
      if (env.ANALYTICS) {
        try {
          const tag = `statusline-${preset}`.slice(0, 32)
          env.ANALYTICS.writeDataPoint({ blobs: [tag], doubles: [1], indexes: [tag] })
        } catch (err) {
          console.warn('[wae] statusline writeDataPoint failed:', err instanceof Error ? err.message : err)
        }
      }
      const liteCache = await cacheRead(env.STATUS_CACHE, env.ANALYTICS)
      // #1227 — this replaces the old fail-silent contract ("empty body on cache miss; branded
      // shows AIWatch 🟢"). Rendering the healthy string from a missing snapshot asserted health
      // we could not see; the preset now shows a neutral ⚪ unknown marker instead, matching the
      // dashboard's #689/#1004 Unknown pill. See renderStatuslinePresetUnknown.
      const rendered = buildStatuslinePresetResponse(preset, liteCache)
      return new Response(rendered.body, {
        status: rendered.status,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': rendered.cacheControl,
        },
      })
    }

    // GET /api/status/cached — KV cache only (no live fetch), for Is X Down SSR pages
    if (request.method === 'GET' && url.pathname === '/api/status/cached') {
      // Claude-only Chrome extension polls (#837, tagged ?src=ext-claude) need just
      // the three Anthropic surfaces' status + Score + per-category fallback. Checked
      // BEFORE the statusline branch (a distinct, narrower projection). Served from an
      // in-worker edge cache (caches.default) so per-minute polls at scale collapse to
      // ~1 KV/score recompute per PoP per s-maxage window — true zone-level request
      // elimination is gated on a custom Worker subdomain (#439).
      if (isExtClaudeRequest(url.searchParams)) {
        // WAE tag (#494 pattern) — count EVERY ext-claude poll, BEFORE the cache-hit
        // early-return below, so the #837 adoption metric reflects total poll volume
        // (on workers.dev the Worker runs on every request regardless; caches.default
        // only saves the KV read + score recompute, not the invocation). Otherwise it
        // would record just the ~1/PoP/60s miss rate. Synchronous void; wrap so a WAE
        // failure never aborts the response. Index entries cap at 32 bytes.
        try {
          env.ANALYTICS?.writeDataPoint({ blobs: ['ext-claude'], doubles: [1], indexes: ['ext-claude'] })
        } catch (err) {
          console.warn('[wae] ext-claude writeDataPoint failed:', err instanceof Error ? err.message : err)
        }

        // Canonical cache key — all ext-claude polls share ONE caches.default entry
        // regardless of incidental query params (a versioned/cache-buster param would
        // otherwise fork the cache and defeat the per-PoP collapse this branch exists for).
        const cacheKey = new Request(`${url.origin}${url.pathname}?src=ext-claude`)
        const cache = caches.default
        const hit = await cache.match(cacheKey)
        if (hit) return hit

        const cacheData = await cacheRead(env.STATUS_CACHE, env.ANALYTICS)
        // #1227 — no snapshot ⇒ 503 + `no-store`, and NOT written into caches.default. The payload
        // itself was already safe (the extension maps an empty projection to a grey `unknown`, not
        // green — extension/lib/render.js), but the 60s edge cache is not: one unlucky poll pinned
        // that no-evidence answer per-PoP for a minute after the snapshot came back, and the
        // `cache.match` short-circuit above returns it without re-reading.
        if (!cacheData) {
          return new Response(JSON.stringify({ error: 'no status snapshot available' }), {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-store',
            },
          })
        }
        const summaries = await readProbeSummaries(env.STATUS_CACHE, 'ext-claude')
        // Score the FULL set — getFallbacks needs the candidate pool — but emit only
        // the three Claude surfaces (buildExtClaudePayload narrows).
        const scoredAll = cacheData.services.map((svc) => {
          const s = scoreFor(svc, summaries)
          return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade, scoreConfidence: s.confidence }
        })
        // #837 PR2 — enrich so the popup shows what's actually happening, not just a color:
        // (1) the GATED crowd-report map (same #575 gate as the dashboard — only corroborated
        //     services appear, so crowd alone can never contradict an operational badge), and
        // (2) the AI summary of any ACTIVE Claude incident (bounded: 3 services, usually 0 active).
        // .catch parity with the ai:analysis reads below — a report-feed KV failure degrades
        // to "no crowd reports", never 500s the whole projection response.
        const extReportFeed = await buildReportFeedMap(env.STATUS_CACHE, cacheData.services).catch((err) => {
          console.warn('[ext-claude] reportFeed map failed:', err instanceof Error ? err.message : err)
          return {}
        })
        const extAiSummary: Record<string, string> = {}
        await Promise.all(scoredAll
          .filter((svc) => (EXT_CLAUDE_IDS as readonly string[]).includes(svc.id))
          .flatMap((svc) => (svc.incidents ?? [])
            .filter((i) => i.status !== 'resolved' && i.status !== 'monitoring')
            .map(async (inc) => {
              const raw = await env.STATUS_CACHE.get(analysisKey(svc.id, inc.id)).catch(() => null)
              if (!raw) return
              try {
                const a = JSON.parse(raw) as AIAnalysisResult
                if (a.summary) extAiSummary[`${svc.id}:${inc.id}`] = a.summary
              } catch (err) {
                console.warn('[ext-claude] ai:analysis parse failed:', svc.id, inc.id, err instanceof Error ? err.message : err)
              }
            })))
        const res = new Response(JSON.stringify(buildExtClaudePayload(scoredAll, cacheData.cachedAt, { reportFeedMap: extReportFeed, aiSummaryMap: extAiSummary })), {
          headers: {
            'Content-Type': 'application/json',
            // Public, unauthenticated GET — extension fetches bypass CORS via MV3
            // host_permissions; `*` also lets curl/tests hit it (mirrors statusline).
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=30, s-maxage=60',
          },
        })
        ctx.waitUntil(cache.put(cacheKey, res.clone()))
        return res
      }
      // Statusline polls (#438, tagged ?src=statusline-*) only need id/name/status.
      // Return the ~KB lite projection and skip the ~2 MB probe/latency/AI reads —
      // this path was the single largest Vercel Fast Data Transfer route. Freshly
      // copied snippets hit the Worker domain directly (off Vercel); legacy installs
      // still using ai-watch.dev get the small payload here via the rewrite.
      if (isStatuslineRequest(url.searchParams)) {
        const liteCache = await cacheRead(env.STATUS_CACHE, env.ANALYTICS)
        // Record per-preset statusline request count in WAE (#494) so we can
        // isolate ?src=statusline-* traffic from regular cached-endpoint traffic
        // when evaluating #400 Phase 1 distribution gates. writeDataPoint is
        // synchronous (void return) but can throw on payload validation errors
        // or binding misconfiguration — wrap in try/catch so a WAE failure never
        // aborts the statusline response. WAE index entries are capped at 32 bytes.
        const src = url.searchParams.get('src') // e.g. "statusline-compact_badge"
        if (src && env.ANALYTICS) {
          try {
            const safeSrc = src.slice(0, 32)
            env.ANALYTICS.writeDataPoint({
              blobs: [safeSrc],   // blob1: full src tag (preset slug)
              doubles: [1],       // double1: request counter (sum in GraphQL queries)
              indexes: [safeSrc], // fast dimension filter (max 32 bytes)
            })
          } catch (err) {
            console.warn('[wae] writeDataPoint failed:', err instanceof Error ? err.message : err)
          }
        }
        // #1227 — 503, NOT the old "intentional 200 with empty services". That fail-silent contract
        // was written on the belief that an empty array renders as "a clean statusline". It does not
        // for a jq program of the shape `if ($d | length) == 0 then "🟢"` — an empty projection
        // renders the green.
        //
        // This branch serves every apex `/api/status/cached` caller (vercel.json rewrites them here
        // with `?src=statusline-proxy`), including jq snippets living in a user's settings.json that
        // no deploy of ours can reach — so the status code is the only server-side lever. `curl -sf`
        // drops a 503, jq then receives empty stdin and emits nothing. A blank statusline is honest;
        // a green one is not. (The server-rendered presets get a ⚪ marker instead — they can,
        // because #918 owns their rendering. See renderStatuslinePresetUnknown.)
        if (!liteCache) {
          return new Response('', {
            status: 503,
            headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
          })
        }
        // CORS `*` since this is public, unauthenticated, GET-only status data hit by curl from any host.
        return new Response(JSON.stringify(buildStatuslinePayload(liteCache)), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=30',
          },
        })
      }
      const cached = await cacheRead(env.STATUS_CACHE, env.ANALYTICS)
      if (cached) {
        // Read latency + probe data first (needed for Mistral noise filtering before AI analysis)
        let latency24h: Array<{ t: string; data: Record<string, number> }> = []
        let probe24h: ProbeSnapshot[] = []
        const [latRaw, probeRaw] = await Promise.all([
          env.STATUS_CACHE!.get('latency:24h').catch(() => null),
          env.STATUS_CACHE!.get('probe:24h').catch(() => null),
        ])
        if (latRaw) {
          try { latency24h = JSON.parse(latRaw).snapshots ?? [] } catch (err) { console.warn('[kv] cached latency24h parse failed:', err instanceof Error ? err.message : err) }
        }
        if (probeRaw) {
          try { probe24h = JSON.parse(probeRaw).snapshots ?? [] } catch (err) { console.warn('[kv] cached probe24h parse failed:', err instanceof Error ? err.message : err) }
        }

        // Mistral-only probe cross-validation removed in #373 — same-title incident grouping
        // (src/utils/incidentGrouping.js) now handles auto-monitoring noise uniformly.

        // Read AI analysis (per-incident keys) — uses live incident list
        const aiAnalysis: Record<string, AIAnalysisResult[]> = {}
        const recentlyRecovered: Record<string, string[]> = {}
        // Active incidents: read ai:analysis:{svcId}:{incId} for each
        // monitoring = "recovery confirmed" — exclude from active analysis display
        const withActiveInc = cached.services.filter(s =>
          (s.incidents ?? []).some(i => i.status !== 'resolved' && i.status !== 'monitoring')
        )
        await Promise.all(withActiveInc.flatMap(svc =>
          (svc.incidents ?? []).filter(i => i.status !== 'resolved' && i.status !== 'monitoring').map(async (inc) => {
            const raw = await env.STATUS_CACHE!.get(analysisKey(svc.id, inc.id)).catch(() => null)
            if (!raw) return
            try {
              const parsed = JSON.parse(raw) as AIAnalysisResult
              if (!aiAnalysis[svc.id]) aiAnalysis[svc.id] = []
              aiAnalysis[svc.id].push(parsed)
            } catch (err) { console.warn('[kv] ai:analysis parse failed:', svc.id, inc.id, err instanceof Error ? err.message : err) }
          })
        ))
        // Recently recovered: operational services with recovered:{svcId}:{incId} KV (independent of AI analysis)
        // Also check ai:analysis keys for enrichment (resolved analysis data for modal display)
        const recoveryCutoff = Date.now() - 3 * 3600_000
        const operationalCached = cached.services.filter(s => s.status === 'operational' && !aiAnalysis[s.id])
        await Promise.all(operationalCached.flatMap(svc =>
          (svc.incidents ?? []).filter(i => i.resolvedAt && new Date(i.resolvedAt).getTime() >= recoveryCutoff).map(async (inc) => {
            // Check independent recovery marker first
            const recoveredRaw = await env.STATUS_CACHE!.get(`recovered:${svc.id}:${inc.id}`).catch(() => null)
            if (recoveredRaw) {
              if (!recentlyRecovered[svc.id]) recentlyRecovered[svc.id] = []
              if (!recentlyRecovered[svc.id].includes(inc.id)) recentlyRecovered[svc.id].push(inc.id)
            }
            // Also check AI analysis for enrichment (optional — banner shows regardless)
            const raw = await env.STATUS_CACHE!.get(analysisKey(svc.id, inc.id)).catch(() => null)
            if (!raw) return
            try {
              const parsed = JSON.parse(raw) as AIAnalysisResult
              if (parsed.resolvedAt) {
                if (!aiAnalysis[svc.id]) aiAnalysis[svc.id] = []
                aiAnalysis[svc.id].push(parsed)
                if (!recentlyRecovered[svc.id]) recentlyRecovered[svc.id] = []
                if (!recentlyRecovered[svc.id].includes(inc.id)) recentlyRecovered[svc.id].push(inc.id)
              }
            } catch (err) { console.warn('[kv] ai:analysis parse failed:', svc.id, inc.id, err instanceof Error ? err.message : err) }
          })
        ))

        // See readRecentSecurityAlerts — both endpoints must emit this field.
        const securityAlerts = await readRecentSecurityAlerts(env.STATUS_CACHE!)

        // #475 — canonical per-user alert feed (see /api/status). Both endpoints emit it.
        const alertFeed = await readAlertFeed(env.STATUS_CACHE!)
        // #575 Phase B — gated crowd-report map (only corroborated services; see buildReportFeedMap).
        const reportFeed = await buildReportFeedMap(env.STATUS_CACHE!, cached.services)

        // Calculate scores for cached services (same as /api/status)
        const cachedProbeSummaries = await readProbeSummaries(env.STATUS_CACHE, 'status-cached')
        const scoredCached = cached.services.map((svc) => {
          const s = scoreFor(svc, cachedProbeSummaries)
          return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade, scoreConfidence: s.confidence, scoreBreakdown: s.breakdown, scoreMetrics: s.metrics, ...(PROBE_INHERIT[svc.id] ? { probeInheritedFrom: PROBE_INHERIT[svc.id] } : {}) }
        })

        // #574 — supply-chain banner (AWS region degraded + dependent AI service also degraded).
        const supplyChainBanner = buildSupplyChainBanner(scoredCached)
        // #1053 — cross-provider upstream links. THIS is the path is-down reads; omitting it here
        // would leave the SSR page permanently linkless while the dashboard worked.
        //
        // Emitted UNCONDITIONALLY (an empty array when the gate stays quiet), unlike the
        // alertFeed/reportFeed/supplyChainBanner neighbours below which omit their key. Deliberate:
        // this gate fires only during a live cross-provider outage — a handful of times a year — and
        // the worker deploy is manual + batched, so with a conditional key `upstreamLinks ===
        // undefined` would mean EITHER "no #1053 worker deployed" OR "deployed and correctly quiet",
        // with no observable separating them, ever. The feature could be dead on arrival for weeks
        // with zero signal (#1032's stale-branch deploy is a live way for that to happen). Presence of
        // the key now means "the #1053 code is live", which is both the cheapest deploy check and what
        // makes a #873 `assert:` clause possible on this issue — the gate RESULT is not assertable
        // because it is outage-timed. #574's banner has the conditional shape and has sat
        // verify-blocked ever since; that is the outcome this avoids.
        // #1072 — feeds ride in the same snapshot (see cacheRead: absent on a pre-#1072 snapshot).
        const upstreamLinks = buildUpstreamLinks(scoredCached, cached.upstreamFeeds ?? [], Date.now())

        return new Response(JSON.stringify({
          services: scoredCached,
          lastUpdated: cached.cachedAt,
          cached: true,
          latency24h,
          ...(probe24h.length > 0 ? { probe24h } : {}),
          ...(Object.keys(aiAnalysis).length > 0 ? { aiAnalysis } : {}),
          ...(Object.keys(recentlyRecovered).length > 0 ? { recentlyRecovered } : {}),
          ...(securityAlerts.length > 0 ? { securityAlerts } : {}),
          ...(alertFeed.length > 0 ? { alertFeed } : {}),
          ...(Object.keys(reportFeed).length > 0 ? { reportFeed } : {}),
          ...(supplyChainBanner ? { supplyChainBanner } : {}),
          upstreamLinks,
        }), {
          status: 200,
          headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' },
        })
      }
      return new Response(JSON.stringify({ error: 'no cached data' }), {
        status: 503,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    // GET /api/probe/history — return daily probe RTT history
    if (url.pathname === '/api/probe/history') {
      const rawDays = Number(url.searchParams.get('days') ?? 30)
      const days = Math.max(1, Math.min(Number.isNaN(rawDays) ? 30 : rawDays, 90))
      const history = env.STATUS_CACHE ? await readProbeHistory(env.STATUS_CACHE, days) : {}
      return new Response(JSON.stringify({ history, days }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
      })
    }

    // GET /api/report — return monthly archive data
    if (url.pathname === '/api/report') {
      const month = url.searchParams.get('month')
      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return new Response(JSON.stringify({ error: 'Missing or invalid month parameter (YYYY-MM)' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      if (!env.STATUS_CACHE) {
        return new Response(JSON.stringify({ error: 'Service unavailable' }), {
          status: 503,
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      let raw: string | null
      try {
        raw = await env.STATUS_CACHE.get(`archive:monthly:${month}`)
      } catch (err) {
        console.error('[api/report] KV read failed:', err instanceof Error ? err.message : err)
        return new Response(JSON.stringify({ error: 'Failed to read archive data' }), {
          status: 502,
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      if (!raw) {
        // #587 mid-month: the CURRENT month has no built archive yet (cron builds it on the 1st),
        // so serve a partial archive (incidentList only) synthesized from the live
        // `incidents:monthly:{month}` accumulator. This lets the dashboard 90-day filter show a
        // current-month incident that already rolled out of the upstream live feed (short-window
        // RSS sources like Azure/Bedrock) before the archive exists. Past months with no archive
        // stay 404. Short edge cache — the accumulator updates every */5 cron.
        const currentMonth = todayUTC().slice(0, 7)
        if (month === currentMonth) {
          // Read/parse failures must NOT masquerade as "no incidents" (a 200 empty would hide an
          // accumulated incident, and the frontend caches it session-wide). Surface them as 502
          // like the sibling archive read above, so the client degrades to live-only + retries
          // instead of caching an empty current month. A genuinely absent key (null) is the only
          // path that legitimately yields an empty partial (no incidents accumulated yet).
          let incRaw: string | null
          try {
            incRaw = await env.STATUS_CACHE.get(`incidents:monthly:${month}`)
          } catch (err) {
            console.error(`[api/report] incidents:monthly:${month} read failed:`, err instanceof Error ? err.message : err)
            return new Response(JSON.stringify({ error: 'Failed to read incident data' }), {
              status: 502, headers: { ...cors, 'Content-Type': 'application/json' },
            })
          }
          let incidentData: MonthlyIncidents | null = null
          if (incRaw) {
            try { incidentData = JSON.parse(incRaw) } catch (err) {
              console.error(`[api/report] corrupt incidents:monthly:${month}:`, err instanceof Error ? err.message : err)
              return new Response(JSON.stringify({ error: 'Corrupt incident data' }), {
                status: 502, headers: { ...cors, 'Content-Type': 'application/json' },
              })
            }
          }
          // #904 — the current-month partial reads the raw accumulator, which still holds any incident
          // accumulated BEFORE it was suppressed (go-forward suppression in fetchAllServices only stops
          // future accumulation). Filter it here too, else a suppressed incident reappears in the
          // dashboard's 90-day incident view (mergeArchiveIntoMap) until next month's real archive.
          if (incidentData) {
            const suppressions = await readSuppressionsFresh(env.STATUS_CACHE)
            if (suppressions.length) incidentData = filterSuppressedFromMonthly(incidentData, suppressions)
            // #1019 — pin any operator-overridden incident duration so the dashboard 30/90-day list
            // shows the corrected value, not the provider's paperwork-inflated open→close span.
            const overrides = await readOverridesFresh(env.STATUS_CACHE)
            if (overrides.length) incidentData = applyDurationOverrides(incidentData, overrides)
          }
          const partial = buildPartialIncidentArchive(month, incidentData)
          return new Response(JSON.stringify(partial), {
            status: 200,
            headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
          })
        }
        return new Response(JSON.stringify({ error: `No archive found for ${month}` }), {
          status: 404,
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      // #908 — a rebuilt past-month archive (post #904 suppression / #1019 override) must
      // un-expose promptly. The old 24h max-age let a browser that had cached the pre-rebuild
      // archive serve it stale for up to 24h. A weak ETag alone would NOT fix that (a still-fresh
      // cache entry never revalidates); the short max-age + ETag together bound the window to 5min
      // and keep the unchanged common case a cheap 304. See reportArchiveResponse.
      return reportArchiveResponse(raw, request.headers.get('If-None-Match'), cors)
    }

    // GET /api/uptime — return daily uptime history
    if (url.pathname === '/api/uptime') {
      const rawDays = Number(url.searchParams.get('days') ?? 30)
      const days = Math.min(Number.isNaN(rawDays) ? 30 : rawDays, 90)
      const history = env.STATUS_CACHE ? await readUptimeHistory(env.STATUS_CACHE, days) : {}
      return new Response(JSON.stringify({ history, days }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
      })
    }

    if (request.method !== 'GET' || (url.pathname !== '/api/status' && url.pathname !== '/api/uptime' && url.pathname !== '/api/probe/history' && url.pathname !== '/api/report')) {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    try {
      // Read probe data BEFORE fetchAllServices — needed for cross-validation of status page failures
      let latency24h: Array<{ t: string; data: Record<string, number> }> = []
      let probe24h: ProbeSnapshot[] = []
      if (env.STATUS_CACHE) {
        const [latRaw, probeRaw] = await Promise.all([
          env.STATUS_CACHE.get('latency:24h').catch(() => null),
          env.STATUS_CACHE.get('probe:24h').catch(() => null),
        ])
        if (latRaw) {
          try { latency24h = JSON.parse(latRaw).snapshots ?? [] } catch (err) { console.warn('[kv] latency24h parse failed:', err instanceof Error ? err.message : err) }
        }
        if (probeRaw) {
          try { probe24h = JSON.parse(probeRaw).snapshots ?? [] } catch (err) { console.warn('[kv] probe24h parse failed:', err instanceof Error ? err.message : err) }
        }
      }

      const { raw, enriched, upstreamFeeds } = await fetchAllServices(env.STATUS_CACHE, probe24h)

      // Cache results after cross-validation (probe-verified, no fallback substitution — prevents cache poisoning)
      // Await cacheWrite so badge/v1 endpoints see data immediately
      if (env.STATUS_CACHE) {
        const wrote = await cacheWrite(env.STATUS_CACHE, raw, upstreamFeeds, env.DISCORD_WEBHOOK_URL)
        ctx.waitUntil(writeLatencySnapshot(env.STATUS_CACHE, raw))
        // #1057 — when the 10-min throttle skipped cacheWrite, CACHE_KEY still holds the previous
        // snapshot, which the is-down/OG surfaces (via /api/status/cached) read. If THIS poll's fresh
        // status differs from that snapshot, force an immediate CACHE_KEY-only refresh (throttle
        // bypassed) so the social card flips on this poll instead of waiting for the next throttled
        // write or the cron's #488 alert-edge refresh — decoupling OG freshness from the Discord alert
        // timing. Off the response path (ctx.waitUntil). The cache READ inside runs on the throttled
        // path — i.e. MOST polls (60s poll vs 10-min throttle) — but KV reads are cheap and not the
        // budgeted resource; the WRITE is, and it fires only on a rare status edge (self-silencing: the
        // next poll reads the fresh snapshot → no edge). Counters stay with cacheWrite (the #488 rule).
        ctx.waitUntil(
          refreshStatusCacheOnLiveEdge(env.STATUS_CACHE, wrote, raw, upstreamFeeds, CACHE_KEY, CACHE_TTL_SECONDS, (kv) => cacheRead(kv, env.ANALYTICS)).then((outcome) => {
            if (outcome === 'refreshed') console.log('[api/status] #1057 status edge while throttled — forced CACHE_KEY refresh so OG/SSR reflect it now')
            else if (outcome === 'refresh-failed') console.error('[api/status] #1057 status edge while throttled but forced CACHE_KEY refresh FAILED — OG/SSR may show pre-edge state until the next throttled write or the cron #488 refresh')
          // Defensive: the helper's reader/writer both swallow (never reject) today, so this can't fire
          // — but a future reader swap that throws must surface as a logged error, not an unhandled
          // rejection inside waitUntil.
          }).catch((err) => console.error('[api/status] #1057 live-edge refresh threw unexpectedly:', err instanceof Error ? err.message : err)),
        )
      }

      // Mistral-only probe cross-validation removed in #373 — same-title incident grouping
      // (src/utils/incidentGrouping.js) now handles auto-monitoring noise uniformly.

      // Add AIWatch Score + Detection Lead timestamps to each service
      const detectionMap = new Map<string, string>()
      if (env.STATUS_CACHE) {
        await Promise.all(enriched.map(async (svc) => {
          // #1233 — pairs with the write side above: read a detection timestamp only for a service we
          // are actually calling affected.
          if (isAffectedStatus(svc.status)) {
            const raw = await env.STATUS_CACHE!.get(`detected:${svc.id}`).catch(() => null)
            const ts = getDetectionTimestamp(raw)
            if (ts) detectionMap.set(svc.id, ts)
          }
        }))
      }
      const liveProbeSummaries = await readProbeSummaries(env.STATUS_CACHE, 'status-live')
      const servicesWithScore = enriched.map((svc) => {
        const s = scoreFor(svc, liveProbeSummaries)
        const detectedAt = detectionMap.get(svc.id) ?? null
        // #883 — expose the parent whose probe feeds this service's inherited Responsiveness, so the
        // detail UI shows a labeled "via <parent>" latency instead of a contradictory "Not provided".
        return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade, scoreConfidence: s.confidence, scoreBreakdown: s.breakdown, scoreMetrics: s.metrics, ...(PROBE_INHERIT[svc.id] ? { probeInheritedFrom: PROBE_INHERIT[svc.id] } : {}), ...(detectedAt ? { detectedAt } : {}) }
      })

      // Read AI analysis from KV — per-incident keys, active incidents + recently resolved
      const aiAnalysis: Record<string, AIAnalysisResult[]> = {}
      const recentlyRecovered: Record<string, string[]> = {}
      if (env.STATUS_CACHE) {
        // Active incidents: read ai:analysis:{svcId}:{incId} for each
        // monitoring = "recovery confirmed" — exclude from active analysis display
        const withActiveInc = servicesWithScore.filter(s =>
          (s.incidents ?? []).some(i => i.status !== 'resolved' && i.status !== 'monitoring')
        )
        await Promise.all(withActiveInc.flatMap(svc =>
          (svc.incidents ?? []).filter(i => i.status !== 'resolved' && i.status !== 'monitoring').map(async (inc) => {
            const raw = await env.STATUS_CACHE!.get(analysisKey(svc.id, inc.id)).catch(() => null)
            if (!raw) return
            try {
              const parsed = JSON.parse(raw) as AIAnalysisResult
              if (!aiAnalysis[svc.id]) aiAnalysis[svc.id] = []
              aiAnalysis[svc.id].push(parsed)
            } catch (err) { console.warn('[kv] ai:analysis parse failed:', svc.id, inc.id, err instanceof Error ? err.message : err) }
          })
        ))
        // Recently recovered: operational services with recovered:{svcId}:{incId} KV (independent of AI analysis)
        // Only check recently resolved incidents — recovered: keys have 2h TTL, 3h cutoff for safety margin
        const recoveryCutoff = Date.now() - 3 * 3600_000
        const operationalSvcs = servicesWithScore.filter(s => s.status === 'operational' && !aiAnalysis[s.id])
        await Promise.all(operationalSvcs.flatMap(svc =>
          (svc.incidents ?? []).filter(i => i.resolvedAt && new Date(i.resolvedAt).getTime() >= recoveryCutoff).map(async (inc) => {
            // Check independent recovery marker first
            const recoveredRaw = await env.STATUS_CACHE!.get(`recovered:${svc.id}:${inc.id}`).catch(() => null)
            if (recoveredRaw) {
              if (!recentlyRecovered[svc.id]) recentlyRecovered[svc.id] = []
              if (!recentlyRecovered[svc.id].includes(inc.id)) recentlyRecovered[svc.id].push(inc.id)
            }
            // Also check AI analysis for enrichment (optional — banner shows regardless)
            const raw = await env.STATUS_CACHE!.get(analysisKey(svc.id, inc.id)).catch(() => null)
            if (!raw) return
            try {
              const parsed = JSON.parse(raw) as AIAnalysisResult
              if (parsed.resolvedAt) {
                if (!aiAnalysis[svc.id]) aiAnalysis[svc.id] = []
                aiAnalysis[svc.id].push(parsed)
                if (!recentlyRecovered[svc.id]) recentlyRecovered[svc.id] = []
                if (!recentlyRecovered[svc.id].includes(inc.id)) recentlyRecovered[svc.id].push(inc.id)
              }
            } catch (err) { console.warn('[kv] ai:analysis parse failed:', svc.id, inc.id, err instanceof Error ? err.message : err) }
          })
        ))
      }

      // See readRecentSecurityAlerts — both endpoints must emit this field.
      const securityAlerts = env.STATUS_CACHE ? await readRecentSecurityAlerts(env.STATUS_CACHE) : []

      // #475 — canonical per-user alert feed (cron-produced embeds the dashboard relays). Both
      // /api/status and /api/status/cached must emit it so a browser on either path can relay.
      const alertFeed = env.STATUS_CACHE ? await readAlertFeed(env.STATUS_CACHE) : []
      // #575 Phase B — gated crowd-report map (only corroborated services; see buildReportFeedMap).
      const reportFeed = env.STATUS_CACHE ? await buildReportFeedMap(env.STATUS_CACHE, servicesWithScore) : {}
      // #574 — supply-chain banner (AWS region degraded + dependent AI service also degraded).
      const supplyChainBanner = buildSupplyChainBanner(servicesWithScore)
      // #1053 — cross-provider upstream links (a dependent's own incident blames a provider that is
      // itself down). Must be emitted on BOTH status paths — is-down reads /api/status/cached.
      // Unconditional key (empty array when quiet) — see the /api/status/cached path for why.
      const upstreamLinks = buildUpstreamLinks(servicesWithScore, upstreamFeeds, Date.now())

      return new Response(JSON.stringify({
        services: servicesWithScore,
        lastUpdated: new Date().toISOString(),
        latency24h,
        ...(probe24h.length > 0 ? { probe24h } : {}),
        ...(Object.keys(aiAnalysis).length > 0 ? { aiAnalysis } : {}),
        ...(Object.keys(recentlyRecovered).length > 0 ? { recentlyRecovered } : {}),
        ...(securityAlerts.length > 0 ? { securityAlerts } : {}),
        ...(alertFeed.length > 0 ? { alertFeed } : {}),
        ...(Object.keys(reportFeed).length > 0 ? { reportFeed } : {}),
        ...(supplyChainBanner ? { supplyChainBanner } : {}),
        upstreamLinks,
      }), {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=30',
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('[worker] request failed:', message)
      ctx.waitUntil(alertWorkerError(env, message))

      // Total failure — try returning cached data
      const cached = await cacheRead(env.STATUS_CACHE, env.ANALYTICS)
      if (cached) {
        return new Response(JSON.stringify({
          services: cached.services,
          lastUpdated: cached.cachedAt,
          cached: true,
        }), {
          status: 200,
          headers: {
            ...cors,
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=10',
          },
        })
      }
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  },
}

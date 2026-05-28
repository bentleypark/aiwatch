// AIWatch Status Polling Proxy — Cloudflare Worker
// Fetches AI service status pages and returns normalized ServiceStatus[]
// Uses KV cache to serve last-known-good data on fetch failures

import { fetchAllServices, CACHE_KEY, COMPONENT_ID_SERVICES, SERVICES, type ServiceStatus } from './services'
import { calculateAIWatchScore, classifyProbe } from './score'
import { buildIncidentAlerts, buildServiceAlerts, mergeTogetherAlerts, formatDetectionLead, detectServiceCountDrop, isFlapSuppressible, flapSuppressionKey } from './alerts'
import { analyzeIncident, analyzeWithSonnet, refreshOrReanalyze, analysisKey, buildAnalysisPrompt, findSimilarIncidents, formatRecoveryDisplay, shouldSkipInitialAnalysis, type AIAnalysisResult } from './ai-analysis'
import { kvPut, kvDel, detectComponentMismatches, isCacheStale, formatDuration, isAllowedAlertWebhook } from './utils'
import { parseDetectionEntry, resolveDetectionUpdate, serializeDetectionEntry, getDetectionTimestamp, isProbeEarlier } from './detection'
import { appendDetectionLead, readDetectionLeadEntries, formatDetectionLeadSection, computeLeadMs, classifyLead, appendLeadDiag, readLeadDiag, DAYS_FOR_DAILY_SUMMARY } from './detection-lead-log'
import { appendAlertFeed, readAlertFeed, buildFeedEntry, type AlertFeedEntry } from './alert-feed'
import { corsHeaders } from './cors'
import { buildStatuslinePayload, isStatuslineRequest } from './statusline'
import { EDGE_FALLBACK_ALERT_TTL_S, EDGE_FALLBACK_ALERT_KEY_PREFIX } from './edge-fallback-alert-keys'

interface Env {
  ALLOWED_ORIGIN: string
  DISCORD_WEBHOOK_URL?: string
  ANTHROPIC_API_KEY?: string
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
  AI?: Ai
  STATUS_CACHE: KVNamespace
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
const webhookPingRate = new Map<string, { start: number; count: number }>() // rate limit for /api/webhook/ping
const publicApiRate = new Map<string, { start: number; count: number }>() // rate limit for /api/v1/*

interface DailyCounters {
  [serviceId: string]: { ok: number; total: number }
}

function todayUTC(): string {
  return new Date().toISOString().split('T')[0]
}

async function cacheWrite(kv: KVNamespace, services: ServiceStatus[], discordUrl?: string): Promise<void> {
  const now = Date.now()
  if (now - lastKvWrite < KV_WRITE_INTERVAL_MS) return
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
    if (s.status === 'operational') counters[s.id].ok++
  })

  // Write cache + daily counters (2 writes per interval)
  await Promise.all([
    kv.put(CACHE_KEY, JSON.stringify({
      services,
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

}

// 30-min latency snapshot — independent of cacheWrite throttle (+48 writes/day)
async function writeLatencySnapshot(kv: KVNamespace, services: ServiceStatus[]): Promise<void> {
  const now = new Date()
  const currentSlot = `${now.toISOString().slice(0, 14)}${now.getUTCMinutes() < 30 ? '00' : '30'}` // "2026-03-22T03:00" or "2026-03-22T03:30"
  if (lastLatencySlot === currentSlot) return

  const latencyData: Record<string, number> = {}
  services.forEach((s) => { if (s.latency != null) latencyData[s.id] = s.latency })

  try {
    const LATENCY_KEY = 'latency:24h'
    const MAX_SNAPSHOTS = 48 // 24h × 2 per hour
    const existing = await kv.get(LATENCY_KEY).catch(() => null)
    const snapshots = existing ? (JSON.parse(existing).snapshots ?? []) : []
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
    console.warn('[kv] latency snapshot write failed:', err instanceof Error ? err.message : err)
  }
}

// ── Health Check Probing (Phase 2 PoC) ──
import { type ProbeResult, type ProbeSnapshot, type ProbeSpike, PROBE_TARGETS, computeProbeSlot, slotToTimestamp, trimSnapshots, hasSlot, failedProbe, detectConsecutiveSpikes } from './probe'

const PROBED_SERVICE_IDS = new Set(PROBE_TARGETS.map((t) => t.id))

// summaries is required (not optional) — every caller must explicitly pass either the cached map
// or `undefined` (signalling KV-degraded → 'unavailable'). Forgotten args would silently classify
// every probed service as 'unavailable' (no responsiveness scoring) — same footgun the union was
// meant to prevent. Callers: 4 fetch handlers + 1 cron, each constructs its own summaries via readProbeSummaries.
function scoreFor(svc: ServiceStatus, summaries: Map<string, ProbeSummary> | undefined) {
  return calculateAIWatchScore(svc, 30, classifyProbe(svc.id, PROBED_SERVICE_IDS.has(svc.id), summaries))
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

async function writeProbeSnapshot(kv: KVNamespace): Promise<void> {
  const currentSlot = computeProbeSlot(new Date())
  if (lastProbeSlot === currentSlot) return

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
    const PROBE_KEY = 'probe:24h' // key name kept for backwards compat; actual retention is 7d
    const MAX_SNAPSHOTS = 2016 // 7d × 12 per hour (every 5 min)
    const existing = await kv.get(PROBE_KEY).catch((err) => { console.warn('[probe] KV read failed:', err instanceof Error ? err.message : err); return null })
    const snapshots: ProbeSnapshot[] = existing ? (JSON.parse(existing).snapshots ?? []) : []
    const slotTs = slotToTimestamp(currentSlot)
    if (hasSlot(snapshots, slotTs)) { lastProbeSlot = currentSlot; return }
    snapshots.push({ t: slotTs, data })
    const trimmed = trimSnapshots(snapshots, MAX_SNAPSHOTS)
    await kv.put(PROBE_KEY, JSON.stringify({ snapshots: trimmed }), {
      expirationTtl: 604800, // 7 days
    })
    lastProbeSlot = currentSlot
  } catch (err) {
    console.warn('[probe] snapshot write failed:', err instanceof Error ? err.message : err)
  }
}

async function cacheRead(kv: KVNamespace): Promise<{ services: ServiceStatus[]; cachedAt: string } | null> {
  const raw = await kv.get(CACHE_KEY).catch(() => null)
  if (!raw) return null
  try { return JSON.parse(raw) } catch (err) { console.warn('[kv] cache parse failed:', err instanceof Error ? err.message : err); return null }
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
  sent: number
  newCount: number
  resolvedCount: number
  downCount: number
  recoveredCount: number
}

async function cronAlertCheck(env: Env): Promise<CronResult> {
  const empty: CronResult = { total: 0, operational: 0, issues: 0, sent: 0, newCount: 0, resolvedCount: 0, downCount: 0, recoveredCount: 0 }
  if (!env.DISCORD_WEBHOOK_URL || !env.STATUS_CACHE) return empty

  // Read cached service data — fetch live if cache is stale or missing
  const raw = await env.STATUS_CACHE.get(CACHE_KEY).catch(() => null)
  const STALE_THRESHOLD_MS = 10 * 60 * 1000
  const { stale, services: cachedServices } = isCacheStale(raw, STALE_THRESHOLD_MS)
  let services = cachedServices as ServiceStatus[]

  // If cache is stale (>10min) or empty, fetch live data to avoid alert decisions on outdated status.
  // Does NOT write to KV — cache writes are handled exclusively by /api/status handler's cacheWrite()
  // so the 10-min KV write throttle keeps us well inside the Workers Paid 1M writes/month inclusion.
  let cronProbes: ProbeSnapshot[] = []
  if (stale) {
    try {
      // Read probe data for cross-validation of status page failures
      const probeRaw = await env.STATUS_CACHE.get('probe:24h').catch(() => null)
      if (probeRaw) {
        try { cronProbes = JSON.parse(probeRaw).snapshots ?? [] } catch (err) { console.warn('[cron] probe24h parse failed:', err instanceof Error ? err.message : err) }
      }
      const { raw: freshServices } = await fetchAllServices(env.STATUS_CACHE, cronProbes)
      if (freshServices.length > 0) {
        services = freshServices
      }
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
    return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade }
  })

  // Mistral-only probe cross-validation removed in #373 — same-title incident grouping
  // (src/utils/incidentGrouping.js) now handles auto-monitoring noise uniformly across services.

  // Collect previously alerted IDs from KV for dedup context
  const alertedNewIds = new Set<string>()
  const alertedDownMap = new Map<string, string>()
  const alertedDegradedMap = new Map<string, string>()
  // #283: flap suppression state.
  // - suppressedIncIds: incidents whose same-titled prior flap already fired its res alert
  //   within the past 60min → buildIncidentAlerts drops both new and res paths.
  // - flapKeysToWrite: incidents eligible for flap suppression but no active window yet;
  //   post-send writes the flap key on the res alert to start the window for the NEXT flap.
  const suppressedIncIds = new Set<string>()
  const flapKeysToWrite = new Map<string, string>()
  for (const svc of scored) {
    const config = SERVICES.find(c => c.id === svc.id)
    for (const inc of svc.incidents ?? []) {
      const wasAlerted = await env.STATUS_CACHE.get(`alerted:new:${inc.id}`).catch(() => null)
      if (wasAlerted) alertedNewIds.add(inc.id)
      if (config && isFlapSuppressible(svc.id, config, inc)) {
        const flapKey = flapSuppressionKey(svc.id, inc)
        const flapActive = await env.STATUS_CACHE.get(flapKey).catch(() => null)
        if (flapActive) suppressedIncIds.add(inc.id)
        else flapKeysToWrite.set(inc.id, flapKey)
      }
    }
    const wasDown = await env.STATUS_CACHE.get(`alerted:down:${svc.id}`).catch(() => null)
    if (wasDown) alertedDownMap.set(svc.id, wasDown)
    const wasDegraded = await env.STATUS_CACHE.get(`alerted:degraded:${svc.id}`).catch(() => null)
    if (wasDegraded) alertedDegradedMap.set(svc.id, wasDegraded)
  }

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

  // Build alerts using pure functions
  const incidentAlerts = buildIncidentAlerts(scored, alertedNewIds, Date.now(), suppressedIncIds)
  const serviceAlerts = buildServiceAlerts(scored, alertedDownMap, alertedDegradedMap)
  const allAlerts = [...incidentAlerts, ...serviceAlerts]

  // Dedup: skip alerts already sent + same-batch dedup + anti-flapping for degraded
  const toSend = []
  const seenKeys = new Set<string>()
  for (const alert of allAlerts) {
    if (seenKeys.has(alert.key)) continue // same incident across shared-status-page services
    const existing = await env.STATUS_CACHE.get(alert.key).catch(() => null)
    if (existing) continue
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

  // Record detection timestamps for non-operational services (Detection Lead feature)
  // Uses detection.ts helpers — resets when incident ID changes to prevent inflated leads (#189)
  for (const svc of scored) {
    if (svc.status !== 'operational') {
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

  // Merge concurrent Together AI model-level alerts into single grouped alerts
  const mergedToSend = mergeTogetherAlerts(toSend)

  // Send + mark as alerted (down/degraded: 2h TTL, incidents/recovery: 7d TTL)
  // For new incidents, run AI analysis with timeout so it can be merged into the embed
  const sent = mergedToSend.slice(0, 5)
  const DIV = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈'
  // #475 — capture every embed we send to the operator into the canonical alert feed, so the
  // dashboard can relay byte-identical alerts to a visitor's own Discord webhook (single source of
  // truth; kills the browser/operator divergence that #473/#474 chased).
  const feedEntries: AlertFeedEntry[] = []
  for (const alert of sent) {
    const isStatusAlert = alert.key.startsWith('alerted:down:') || alert.key.startsWith('alerted:degraded:')
    const isRecoveryAlert = alert.key.startsWith('alerted:recovered:')
    const ttl = (isStatusAlert || isRecoveryAlert) ? 7200 : 604800
    const kvValue = isStatusAlert ? new Date().toISOString() : '1'
    // Write dedup keys for all merged alerts (Together AI grouping)
    const keysToWrite = alert._mergedKeys ?? [alert.key]
    await Promise.all(keysToWrite.map(k => kvPut(env.STATUS_CACHE, k, kvValue, { expirationTtl: ttl })))
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
    // Mark recovery: write independent recovered:{svcId}:{incId} KV + update AI analysis if exists
    if (isRecoveryAlert) {
      const svcId = alert.key.replace('alerted:recovered:', '')
      const svc = scored.find(s => s.id === svcId)
      const now = new Date().toISOString()
      const incidents = svc?.incidents ?? []
      await Promise.all(incidents.map(async (inc) => {
        // Independent recovery marker (works even without AI analysis)
        const duration = inc.startedAt ? formatDuration(new Date(inc.startedAt), new Date(now)) : undefined
        const recoveredOk = await kvPut(env.STATUS_CACHE, `recovered:${svcId}:${inc.id}`, JSON.stringify({
          resolvedAt: now,
          incidentTitle: inc.title ?? '',
          duration: duration ?? '',
        }), { expirationTtl: 7200 })
        if (!recoveredOk) console.error('[cron] failed to write recovery marker:', svcId, inc.id)
        // Also mark AI analysis as resolved if it exists
        const key = analysisKey(svcId, inc.id)
        const analysisRaw = await env.STATUS_CACHE.get(key).catch(() => null)
        if (!analysisRaw) return
        try {
          const analysis = JSON.parse(analysisRaw) as AIAnalysisResult
          if (!analysis.resolvedAt) {
            analysis.resolvedAt = now
            await kvPut(env.STATUS_CACHE, key, JSON.stringify(analysis), { expirationTtl: 7200 })
          }
        } catch (err) {
          console.warn('[kv] ai:analysis parse failed during recovery mark:', svcId, inc.id, err instanceof Error ? err.message : err)
          await kvDel(env.STATUS_CACHE, key)
        }
      }))
    }

    // For new incidents: lookup service/incident once, then run AI analysis + Detection Lead
    // Skip AI analysis for merged alerts (Together AI model-level grouping — individual model incidents don't need deep analysis)
    let analysisSection = ''
    let detectionLeadSection = ''
    if (alert.key.startsWith('alerted:new:')) {
      const incId = alert.key.replace('alerted:new:', '')
      const svc = scored.find(s => (s.incidents ?? []).some(i => i.id === incId))
      const inc = svc ? (svc.incidents ?? []).find(i => i.id === incId) : null
      if (svc && inc) {
        // AI analysis (8s timeout) — Gemma primary + Sonnet fallback.
        // shouldSkipInitialAnalysis centralizes the three skip reasons so they
        // can't drift between this call site and the re-analysis path. Log the
        // specific reason so empty AI-analysis sections in Discord embeds are
        // post-hoc explainable (merged / no-model / generic / upstream-fail).
        const skipReason = shouldSkipInitialAnalysis(alert, inc, !!(env.AI || env.ANTHROPIC_API_KEY))
        if (skipReason) {
          console.log(`[cron] skipping initial AI analysis for ${svc.id}:${inc.id}: ${skipReason}`)
        } else {
          try {
            const today = new Date().toISOString().split('T')[0]
            const usageKey = `ai:usage:${today}`
            const usageRaw = await env.STATUS_CACHE.get(usageKey).catch(() => null)
            const usage = usageRaw ? JSON.parse(usageRaw) : { calls: 0, success: 0, failed: 0, gemma: 0, sonnet: 0 }
            usage.calls++
            const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))
            const analysis = await Promise.race([
              analyzeIncident(env.ANTHROPIC_API_KEY ?? '', svc.name, { id: inc.id, title: inc.title, status: inc.status, startedAt: inc.startedAt, impact: inc.impact, timeline: inc.timeline }, svc.incidents ?? [], undefined, env.AI),
              timeout,
            ])
            if (analysis) {
              usage.success++
              if (analysis.model === 'gemma') usage.gemma = (usage.gemma ?? 0) + 1
              else if (analysis.model === 'sonnet') usage.sonnet = (usage.sonnet ?? 0) + 1
              // #299: preserve sticky operator overrides — if an admin already wrote
              // this key via /api/admin/analyze between two cron cycles, don't
              // clobber it here. Symmetric with refreshOrReanalyze's guard.
              const existingRaw = await env.STATUS_CACHE.get(analysisKey(svc.id, inc.id)).catch(() => null)
              const skipWrite = isStickyExistingAnalysis(existingRaw)
              if (skipWrite) console.log(`[cron] Preserving sticky analysis for ${svc.id}:${inc.id}; not overwriting`)
              const kvOk = skipWrite
                ? true
                : await kvPut(env.STATUS_CACHE, analysisKey(svc.id, inc.id), JSON.stringify(analysis), { expirationTtl: 3600 })
              if (kvOk) {
                analysisSection = `\n${DIV}\n🤖 **AI ANALYSIS** [Beta]\n${analysis.summary}\n⏱ Est. recovery: ${formatRecoveryDisplay(analysis.estimatedRecovery)}${analysis.affectedScope.length > 0 ? `\n📡 Scope: ${analysis.affectedScope.join(', ')}` : ''}`
              }
            } else {
              usage.failed++
            }
            await kvPut(env.STATUS_CACHE, usageKey, JSON.stringify(usage), { expirationTtl: 172800 })
          } catch (err) {
            console.error('[cron] AI analysis failed:', err instanceof Error ? err.message : err)
          }
        }
        // Detection Lead: show early detection advantage in Discord alert + persist to audit log
        try {
          const detectRaw = await env.STATUS_CACHE.get(`detected:${svc.id}`).catch(() => null)
          const detectedAt = getDetectionTimestamp(detectRaw)
          detectionLeadSection = formatDetectionLead(detectedAt, inc.startedAt)
          // #464 diagnostics: record WHY this new incident did/didn't produce a lead, split by probe
          // coverage. Best-effort, never blocks the alert. No change to the audit-log behavior below.
          await appendLeadDiag(env.STATUS_CACHE, classifyLead(detectedAt, inc.startedAt), PROBED_SERVICE_IDS.has(svc.id))
            .catch((err) => console.warn('[cron] detection lead diag failed:', err instanceof Error ? err.message : err))
          // Persist to audit log: computeLeadMs returns null outside [1m, 60m) — single source of truth
          // shared with formatDetectionLead, so audit log can never drift from Discord display rules.
          if (detectedAt) {
            const leadMs = computeLeadMs(detectedAt, inc.startedAt)
            if (leadMs !== null) {
              const result = await appendDetectionLead(env.STATUS_CACHE, {
                svcId: svc.id, incId: inc.id, leadMs, detectedAt, officialAt: inc.startedAt,
              })
              // Tagged return ('persisted' | 'duplicate' | 'failed') — only 'failed' is a real drift signal;
              // 'duplicate' fires on legitimate idempotent re-runs of the same incident across cron ticks.
              if (result === 'failed') {
                console.warn('[cron] detection lead displayed in Discord but NOT persisted to audit log:', { svcId: svc.id, incId: inc.id, leadMs })
              }
            }
          }
        } catch (err) {
          console.error('[cron] detection lead failed:', err instanceof Error ? err.message : err)
        }
      }
    }

    // Build sectioned description: incident → detection lead → AI analysis → fallback → link
    const parts = [alert.description]
    if (detectionLeadSection) parts.push(detectionLeadSection)
    if (analysisSection) parts.push(analysisSection)
    if (alert.fallbackText && alert.fallbackText.startsWith('👉')) {
      const list = alert.fallbackText.replace('👉 Suggested fallback: ', '')
      parts.push(`${DIV}\n👉 **SUGGESTED FALLBACK**\n• ${list}`)
    } else if (alert.fallbackText) {
      parts.push(`${DIV}\n${alert.fallbackText}`)
    }
    // #422 — region-switch hint below the cross-service fallback. Cheaper first-line
    // action (same SDK/IAM) when the outage is region-specific with healthy regions left.
    if (alert.regionText) parts.push(`${DIV}\n${alert.regionText}`)
    parts.push(`${DIV}\n[View on AIWatch](${alert.url})`)
    const description = parts.join('\n')
    await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
      title: alert.title,
      description,
      color: alert.color,
    })
    const feedEntry = buildFeedEntry(alert, description, scored)
    if (feedEntry) feedEntries.push(feedEntry)
  }
  // #475 — single read-modify-write after the send loop (alerts are infrequent; negligible KV budget).
  // Best-effort (must not affect the operator sends above), but a failure means EVERY per-user webhook
  // misses this cycle's alerts — log loudly so a whole-cohort relay miss is diagnosable, not buried.
  if (env.STATUS_CACHE && feedEntries.length > 0) {
    const feedOk = await appendAlertFeed(env.STATUS_CACHE, feedEntries)
    if (!feedOk) console.error('[cron] alert feed append failed — per-user webhook relays skipped this cycle:', feedEntries.map(e => e.key))
  }

  // Track daily alert count in KV for Daily Summary
  if (sent.length > 0) {
    try {
      const today = new Date().toISOString().split('T')[0]
      const countKey = `alert:count:${today}`
      const countRaw = await env.STATUS_CACHE.get(countKey).catch(() => null)
      const counts = countRaw ? JSON.parse(countRaw) : { incidents: 0, resolved: 0, down: 0, degraded: 0, recovered: 0 }
      for (const a of sent) {
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

  // Refresh TTL on existing AI analyses / re-analyze missing ones (max 2 per cron)
  // monitoring = "recovery confirmed, verifying" — treat as inactive (no TTL refresh)
  const activeServices = scored.filter(s =>
    (s.incidents ?? []).some(i => i.status !== 'resolved' && i.status !== 'monitoring')
  )
  await refreshOrReanalyze(activeServices, env.STATUS_CACHE, env.ANTHROPIC_API_KEY, analyzeIncident, 2, Date.now(), env.AI)

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

  const operational = scored.filter(s => s.status === 'operational').length
  return {
    total: scored.length,
    operational,
    issues: scored.length - operational,
    sent: sent.length,
    newCount: sent.filter(a => a.key.startsWith('alerted:new:')).reduce((sum, a) => sum + (a._mergedKeys?.length ?? 1), 0),
    resolvedCount: sent.filter(a => a.key.startsWith('alerted:res:')).reduce((sum, a) => sum + (a._mergedKeys?.length ?? 1), 0),
    downCount: sent.filter(a => a.key.startsWith('alerted:down:')).length,
    recoveredCount: sent.filter(a => a.key.startsWith('alerted:recovered:')).length,
  }
}

// corsHeaders moved to ./cors — also handles team-scoped suffix patterns for Vercel preview origins.

import { generateBadgeSvg } from './badge'
import { buildFeedResponse, FEED_XSL, type FeedRequest } from './rss'
import { generateOgSvg } from './og'
import { detectRedditPosts, formatRedditAlert, formatCompetitiveAlert, formatSecurityAlert as formatRedditSecurityAlert, isPromotable } from './reddit'
import { detectSecurityAlerts, fetchOSVAlerts, formatSecurityDigest, securityDetectedKey, incrementSecurityCount, readRecentSecurityAlerts, planOsvTimelineCycle } from './security-monitor'
import { detectNewRepos, formatGitHubAlert } from './competitive'
import { buildDailySummary, isInSummaryWindow } from './daily-summary'
import { collectChangelogs, getStaleSources } from './changelog'
import { getWeekRange, buildIncidentSummary, buildStabilityChanges, buildWeeklyBriefing, buildSecuritySummary } from './weekly-briefing'
import { parseVitals, writeVitalsToKV, readVitalsSummary, archiveVitals } from './vitals'
import { archiveProbeDaily, cacheProbeSummaries, getCachedProbeSummaries, type ProbeDailyData } from './probe-archival'
import type { ProbeSummary, Incident } from './types'
import { buildMonthlyArchive, isInMonthlyArchiveWindow, accumulateMonthlyIncidents, buildArchiveReadyEmbed, archiveNotifiedKey, type MonthlyIncidents, type ArchiveScoreInput, type ScoreGrade } from './monthly-archive'
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
    id: incident.id, title: incident.title, status: incident.status,
    startedAt: incident.startedAt, impact: incident.impact, timeline: incident.timeline,
  }, similar)
  const timelineAt = incident.timeline?.at(-1)?.at ?? ''

  let analysis: AIAnalysisResult | null
  try {
    if (model === 'sonnet') {
      analysis = await analyzeWithSonnet(env.ANTHROPIC_API_KEY, prompt, incident.id, timelineAt)
    } else {
      // Gemma path: go via analyzeIncident (tries Gemma first, falls back to Sonnet).
      // The operator picked 'gemma' explicitly, but if Workers AI returns null we'd
      // rather ship a Sonnet result than error out.
      analysis = await analyzeIncident(env.ANTHROPIC_API_KEY, service.name, {
        id: incident.id, title: incident.title, status: incident.status,
        startedAt: incident.startedAt, impact: incident.impact, timeline: incident.timeline,
      }, service.incidents ?? [], undefined, env.AI)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'analysis failed'
    return json(502, { ok: false, error: 'analysis failed', detail: message })
  }

  if (!analysis) {
    return json(502, { ok: false, error: 'analysis returned null — upstream model error or unparseable response' })
  }

  if (sticky) analysis.sticky = true

  const key = analysisKey(svcId, incidentId)
  const ttl = 3600
  try {
    await env.STATUS_CACHE.put(key, JSON.stringify(analysis), { expirationTtl: ttl })
  } catch (err) {
    return json(502, { ok: false, error: 'KV write failed', detail: err instanceof Error ? err.message : String(err) })
  }

  // Bump ai:usage:{date} counter so the Daily Summary attributes the manual call.
  // Match the shape used elsewhere: { calls, success, failed, gemma?, sonnet? }.
  try {
    const today = new Date().toISOString().slice(0, 10)
    const usageKey = `ai:usage:${today}`
    const raw = await env.STATUS_CACHE.get(usageKey).catch(() => null)
    const usage: { calls: number; success: number; failed: number; gemma?: number; sonnet?: number } =
      raw ? JSON.parse(raw) : { calls: 0, success: 0, failed: 0 }
    usage.calls++
    usage.success++
    if (analysis.model === 'gemma') usage.gemma = (usage.gemma ?? 0) + 1
    else if (analysis.model === 'sonnet') usage.sonnet = (usage.sonnet ?? 0) + 1
    await env.STATUS_CACHE.put(usageKey, JSON.stringify(usage), { expirationTtl: 172800 })
  } catch (err) {
    // Counter is bookkeeping — don't fail the request over it.
    console.warn('[admin/analyze] ai:usage counter bump failed:', err instanceof Error ? err.message : err)
  }

  return json(200, { ok: true, wrote: key, ttl, analysis })
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
      scoreData = services.map((s) => {
        const r = scoreFor(s, probeSummaries)
        return { id: s.id, aiwatchScore: r.score, scoreGrade: r.grade }
      })
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

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
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
          for (const spike of spikes) {
            const alertKey = `alerted:probe-spike:${spike.serviceId}`
            const existing = await env.STATUS_CACHE.get(alertKey).catch(() => null)
            if (existing) continue
            await kvPut(env.STATUS_CACHE, alertKey, '1', { expirationTtl: 3600 })
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

    const result = await cronAlertCheck(env)
    if (!env.DISCORD_WEBHOOK_URL) return

    // Reddit community monitoring — runs once per hour (minute 0-4) to respect rate limits
    // KV budget: max 5 writes/hour = 120/day (trivial against the Workers Paid 1M/month inclusion)
    const now = new Date()
    if (env.STATUS_CACHE && env.DISCORD_WEBHOOK_URL && now.getUTCMinutes() < 5) {
      try {
        const redditAlerts = await detectRedditPosts(env.STATUS_CACHE)
        // Split: service outage alerts vs competitive vs security monitoring
        const outageAlerts = redditAlerts.filter(a => a.type === 'outage')
        const competitiveAlerts = redditAlerts.filter(a => a.type === 'competitive')
        const redditSecurityAlerts = redditAlerts.filter(a => a.type === 'security')
        // Mark all detected posts as seen (prevents re-checking), but only notify promotable ones
        for (const alert of outageAlerts.slice(0, 5)) {
          await kvPut(env.STATUS_CACHE, alert.key, '1', { expirationTtl: 86400 })
        }
        const nowSec = Date.now() / 1000
        const promotable = outageAlerts
          .filter(a => isPromotable(a.post.title, nowSec - a.post.createdUtc))
          .slice(0, 3)
        for (const alert of promotable) {
          const formatted = formatRedditAlert(alert)
          await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
            title: formatted.title,
            description: `${formatted.description}\n[View Post](${formatted.url})`,
            color: formatted.color,
          })
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

          // Read changelog entries accumulated this week
          const changelogRaw = await env.STATUS_CACHE.get('changelog:entries').catch(() => null)
          let changelog: unknown[] = []
          if (changelogRaw) { try { changelog = JSON.parse(changelogRaw) } catch { console.warn('[cron] changelog entries parse failed') } }

          // Read monthly incidents for incident summary (check both current and previous month for week spanning month boundary)
          const allMonthlyIncidents: unknown[] = []
          const currMonthKey = `incidents:monthly:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
          const prevMonth = new Date(now); prevMonth.setUTCMonth(prevMonth.getUTCMonth() - 1)
          const prevMonthKey = `incidents:monthly:${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`
          for (const mk of [currMonthKey, prevMonthKey]) {
            const mRaw = await env.STATUS_CACHE.get(mk).catch(() => null)
            if (mRaw) { try { allMonthlyIncidents.push(...(JSON.parse(mRaw).incidents ?? [])) } catch { console.warn(`[cron] ${mk} parse failed`) } }
          }
          const incidents = buildIncidentSummary(allMonthlyIncidents as Parameters<typeof buildIncidentSummary>[0], weekStart, weekEnd)

          // Read daily uptime counters for stability comparison
          const thisWeekCounters: Record<string, { ok: number; total: number }> = {}
          const prevWeekCounters: Record<string, { ok: number; total: number }> = {}
          for (let i = 0; i < 7; i++) {
            const d = new Date(now)
            d.setUTCDate(d.getUTCDate() - i)
            const key = `history:${d.toISOString().split('T')[0]}`
            const raw = await env.STATUS_CACHE.get(key).catch(() => null)
            if (raw) {
              try {
                const data = JSON.parse(raw)
                for (const [svcId, counts] of Object.entries(data) as [string, { ok: number; total: number }][]) {
                  const c = thisWeekCounters[svcId] ?? { ok: 0, total: 0 }
                  c.ok += counts.ok; c.total += counts.total
                  thisWeekCounters[svcId] = c
                }
              } catch { console.warn(`[cron] ${key} parse failed`) }
            }
            // Previous week
            const pd = new Date(now)
            pd.setUTCDate(pd.getUTCDate() - i - 7)
            const pkey = `history:${pd.toISOString().split('T')[0]}`
            const praw = await env.STATUS_CACHE.get(pkey).catch(() => null)
            if (praw) {
              try {
                const pdata = JSON.parse(praw)
                for (const [svcId, counts] of Object.entries(pdata) as [string, { ok: number; total: number }][]) {
                  const c = prevWeekCounters[svcId] ?? { ok: 0, total: 0 }
                  c.ok += counts.ok; c.total += counts.total
                  prevWeekCounters[svcId] = c
                }
              } catch { console.warn(`[cron] ${pkey} parse failed`) }
            }
          }
          const serviceNames: Record<string, string> = {}
          for (const svc of SERVICES) serviceNames[svc.id] = svc.name
          const stabilityChanges = buildStabilityChanges(thisWeekCounters, prevWeekCounters, serviceNames)

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
          const briefing = buildWeeklyBriefing({ weekStart, weekEnd, changelog, incidents, stabilityChanges, security, staleSources })
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
              scoreData = services.map((s) => {
                const r = scoreFor(s, probeSummaries)
                return { id: s.id, aiwatchScore: r.score, scoreGrade: r.grade }
              })
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
              dailyServices = Array.isArray(p) ? p : p.services ?? []
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

          // Count active webhook registrations (uses KV metadata — no individual gets needed).
          // Discord-only since #467 — Slack moved to native /feed RSS; any legacy webhook:reg:*
          // entries with `type: 'slack'` metadata decay out within their 30d TTL and are skipped here.
          let webhookCounts = { discord: 0 }
          try {
            const listed = await env.STATUS_CACHE.list({ prefix: 'webhook:reg:' })
            for (const key of listed.keys) {
              const meta = key.metadata as { type?: string } | null
              if (meta?.type === 'discord') webhookCounts.discord++
            }
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

          // Detection Lead audit log — read today + yesterday keys (DAYS_FOR_DAILY_SUMMARY=2) so entries
          // from yesterday's 09:00–24:00 window are surfaced. windowMs=24h filters the union to a sliding
          // 24h window ending now, preventing entries already shown in yesterday's 09:00 summary from being
          // re-reported today. Internal dedup by (svcId, incId) handles same-incident overlap.
          // .catch boundary: defensive — readDetectionLeadEntries returns [] internally on every error
          // path today, but a future refactor introducing a synchronous throw would otherwise crash the
          // entire daily summary cron. Cheap to keep.
          const detectionLeadEntries = await readDetectionLeadEntries(env.STATUS_CACHE, new Date(), { days: DAYS_FOR_DAILY_SUMMARY, windowMs: 24 * 3_600_000 })
            .catch((err) => {
              console.error('[daily-summary] detection lead read failed:', err instanceof Error ? err.message : err)
              return []
            })
          // #464 — diagnostic counter breakdown (why leads are/aren't landing). Best-effort.
          const leadDiag = await readLeadDiag(env.STATUS_CACHE, new Date(), DAYS_FOR_DAILY_SUMMARY)
            .catch((err) => {
              console.error('[daily-summary] detection lead diag read failed:', err instanceof Error ? err.message : err)
              return null
            })

          const description = buildDailySummary({
            services: dailyServices,
            aiUsage,
            latencySnapshots: latSnapshots,
            incidentCountToday: { newCount: result.newCount, resolvedCount: result.resolvedCount },
            alertCounts,
            webhookCounts,
            deliveryCounts,
            redditCount,
            securityCount,
            vitals: vitalsSummary,
            probeSnapshots,
            detectionLeadEntries,
            leadDiag,
          })

          if (isCatchUp) console.log(`[daily-summary] catch-up run for ${today}`)
          await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
            title: `📊 AIWatch Daily Report — ${today}`,
            description,
            color: 0x9B59B6, // purple
          })
          // Mark today's summary as done (prevents re-send on subsequent cron cycles)
          await kvPut(env.STATUS_CACHE, `daily-summary:${today}`, '1', { expirationTtl: 604800 })

          // Accumulate monthly incident data (runs daily alongside summary)
          if (dailyServices.length > 0) {
            try {
              const currentMonth = today.slice(0, 7) // YYYY-MM
              const incKey = `incidents:monthly:${currentMonth}`
              const existingRaw = await env.STATUS_CACHE.get(incKey).catch(() => null)
              let existingInc: MonthlyIncidents | null = null
              if (existingRaw) {
                try { existingInc = JSON.parse(existingRaw) } catch (parseErr) {
                  console.warn('[daily-summary] corrupt incident accumulation data, resetting:',
                    parseErr instanceof Error ? parseErr.message : parseErr)
                }
              }
              const updated = accumulateMonthlyIncidents(existingInc, dailyServices, currentMonth)
              const incWriteOk = await kvPut(env.STATUS_CACHE, incKey, JSON.stringify(updated), { expirationTtl: 60 * 86400 })
              if (!incWriteOk) {
                console.error(`[daily-summary] incident accumulation KV write failed for ${currentMonth}`)
              }
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
              description: `${result.total} services checked\n${result.operational} operational · ${result.issues} issues`,
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

    // POST /api/admin/rebuild-archive — operator tool to regenerate a specific month's
    // archive:monthly:{YYYY-MM} after a bug-fix deploy. Cron only writes when the key
    // doesn't exist; this endpoint unconditionally overwrites.
    if (request.method === 'POST' && url.pathname === '/api/admin/rebuild-archive') {
      return handleAdminRebuildArchive(request, env, cors)
    }

    // POST/DELETE /api/webhook/ping — track active webhook registrations (hashed, no raw URLs stored)
    if ((request.method === 'POST' || request.method === 'DELETE') && url.pathname === '/api/webhook/ping') {
      // Rate limit: 5 per minute per IP
      const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown'
      const now = Date.now()
      const pingEntry = webhookPingRate.get(clientIp)
      if (pingEntry && pingEntry.count >= 5 && now - pingEntry.start < 60_000) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
          status: 429, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      if (!pingEntry || now - pingEntry.start >= 60_000) {
        webhookPingRate.set(clientIp, { start: now, count: 1 })
      } else {
        pingEntry.count++
      }

      try {
        const body = await request.json() as { hash?: string; type?: string }
        const { hash, type } = body
        if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
          return new Response(JSON.stringify({ error: 'Invalid hash format' }), {
            status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
          })
        }

        if (request.method === 'POST') {
          // Discord-only since #467 — Slack subscribes via native /feed RSS, no webhook registered.
          if (type !== 'discord') {
            return new Response(JSON.stringify({ error: 'Invalid type' }), {
              status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
            })
          }
          if (env.STATUS_CACHE) {
            // Raw kv.put — kvPut opts don't support metadata, needed for fast list reads
            await env.STATUS_CACHE.put(
              `webhook:reg:${hash}`,
              JSON.stringify({ type, registeredAt: new Date().toISOString() }),
              { expirationTtl: 2592000, metadata: { type } },
            )
          }
        } else {
          // DELETE
          if (env.STATUS_CACHE) {
            await kvDel(env.STATUS_CACHE, `webhook:reg:${hash}`)
          }
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      } catch (err) {
        console.error('[webhook/ping] Error:', err instanceof Error ? err.message : err)
        return new Response(JSON.stringify({ error: 'Internal error' }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
    }

    // GET /api/og — dynamic OG image (PNG) for social share previews
    if (request.method === 'GET' && url.pathname === '/api/og') {
      const service = (url.searchParams.get('service') || 'Unknown').slice(0, 50)
      const status = url.searchParams.get('status') || 'operational'
      const score = (url.searchParams.get('score') || '').slice(0, 5)
      const uptime = (url.searchParams.get('uptime') || '').slice(0, 6)
      const svg = generateOgSvg(service, status, score, uptime)
      try {
        const { renderPng } = await import('./og-render')
        const png = await renderPng(svg)
        return new Response(png, {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=600, s-maxage=600',
            'Access-Control-Allow-Origin': '*',
          },
        })
      } catch (err) {
        console.error('[og] PNG render failed, falling back to SVG:', err instanceof Error ? err.message : err)
        return new Response(svg, {
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
      const feedReq: FeedRequest =
        url.pathname === '/feed.xml'
          ? { scope: 'all' }
          : { scope: 'service', segment: url.pathname.split('/')[2] ?? '' }
      const cached = env.STATUS_CACHE ? await cacheRead(env.STATUS_CACHE) : null
      const result = buildFeedResponse(cached, feedReq)
      if (!result.ok && result.status === 503) {
        // Same severity as /api/report's KV-read failure — log at error so it
        // lands in the same operator alerting tier.
        console.error(`[rss] ${url.pathname} — status cache unavailable, returning 503`)
      }
      if (result.ok) {
        return new Response(result.xml, {
          status: 200,
          headers: {
            // text/xml (not application/rss+xml) so browsers apply the /feed.xsl client-side XSLT
            // and render a page instead of downloading raw XML (#467). RSS readers + Slack /feed
            // accept text/xml; the <atom:link> self type stays application/rss+xml for discovery.
            'Content-Type': 'text/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=300, s-maxage=300',
            'Access-Control-Allow-Origin': '*',
          },
        })
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
      let service: { name: string; status: string; uptime30d?: number | null } | null = null
      if (env.STATUS_CACHE) {
        const cached = await cacheRead(env.STATUS_CACHE)
        if (cached) {
          service = cached.services.find((s) => s.id === serviceId) ?? null
        }
      }

      if (!service) {
        return new Response(generateBadgeSvg(customLabel ?? serviceId, 'not found', '#9e9e9e', style), {
          status: 404,
          headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' },
        })
      }

      const label = customLabel ?? service.name
      const statusColor = service.status === 'operational' ? '#3fb950'
        : service.status === 'degraded' ? '#d29922'
        : '#f85149'
      let statusText = service.status
      if (showUptime && service.uptime30d != null) {
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

      // Read cached services
      const cached = env.STATUS_CACHE ? await cacheRead(env.STATUS_CACHE) : null
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
            status: svc.status, latency: svc.latency, uptime30d: svc.uptime30d,
            uptimeSource: svc.uptimeSource, lastChecked: svc.lastChecked,
            incidentCount: (svc.incidents ?? []).length,
            aiwatchScore: scoreData.score, scoreGrade: scoreData.grade,
          }
        }),
        cachedAt: cached.cachedAt,
      }), { status: 200, headers: publicHeaders })
    }

    // GET /api/status/cached — KV cache only (no live fetch), for Is X Down SSR pages
    if (request.method === 'GET' && url.pathname === '/api/status/cached') {
      // Statusline polls (#438, tagged ?src=statusline-*) only need id/name/status.
      // Return the ~KB lite projection and skip the ~2 MB probe/latency/AI reads —
      // this path was the single largest Vercel Fast Data Transfer route. Freshly
      // copied snippets hit the Worker domain directly (off Vercel); legacy installs
      // still using ai-watch.dev get the small payload here via the rewrite.
      if (isStatuslineRequest(url.searchParams)) {
        const liteCache = env.STATUS_CACHE ? await cacheRead(env.STATUS_CACHE) : null
        // Intentional: 200 with empty services when the cache is missing (fail-silent
        // — the jq over an empty array shows a clean statusline) rather than the
        // non-lite branch's 503; CORS `*` since this is public, unauthenticated,
        // GET-only status data hit by curl from any host.
        return new Response(JSON.stringify(buildStatuslinePayload(liteCache)), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=30',
          },
        })
      }
      const cached = env.STATUS_CACHE ? await cacheRead(env.STATUS_CACHE) : null
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

        // Calculate scores for cached services (same as /api/status)
        const cachedProbeSummaries = await readProbeSummaries(env.STATUS_CACHE, 'status-cached')
        const scoredCached = cached.services.map((svc) => {
          const s = scoreFor(svc, cachedProbeSummaries)
          return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade, scoreConfidence: s.confidence, scoreBreakdown: s.breakdown, scoreMetrics: s.metrics }
        })

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
        return new Response(JSON.stringify({ error: `No archive found for ${month}` }), {
          status: 404,
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      return new Response(raw, {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
      })
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

      const { raw, enriched } = await fetchAllServices(env.STATUS_CACHE, probe24h)

      // Cache results after cross-validation (probe-verified, no fallback substitution — prevents cache poisoning)
      // Await cacheWrite so badge/v1 endpoints see data immediately
      if (env.STATUS_CACHE) {
        await cacheWrite(env.STATUS_CACHE, raw, env.DISCORD_WEBHOOK_URL)
        ctx.waitUntil(writeLatencySnapshot(env.STATUS_CACHE, raw))
      }

      // Mistral-only probe cross-validation removed in #373 — same-title incident grouping
      // (src/utils/incidentGrouping.js) now handles auto-monitoring noise uniformly.

      // Add AIWatch Score + Detection Lead timestamps to each service
      const detectionMap = new Map<string, string>()
      if (env.STATUS_CACHE) {
        await Promise.all(enriched.map(async (svc) => {
          if (svc.status !== 'operational') {
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
        return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade, scoreConfidence: s.confidence, scoreBreakdown: s.breakdown, scoreMetrics: s.metrics, ...(detectedAt ? { detectedAt } : {}) }
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

      return new Response(JSON.stringify({
        services: servicesWithScore,
        lastUpdated: new Date().toISOString(),
        latency24h,
        ...(probe24h.length > 0 ? { probe24h } : {}),
        ...(Object.keys(aiAnalysis).length > 0 ? { aiAnalysis } : {}),
        ...(Object.keys(recentlyRecovered).length > 0 ? { recentlyRecovered } : {}),
        ...(securityAlerts.length > 0 ? { securityAlerts } : {}),
        ...(alertFeed.length > 0 ? { alertFeed } : {}),
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
      const cached = env.STATUS_CACHE ? await cacheRead(env.STATUS_CACHE) : null
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

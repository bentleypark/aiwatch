// AIWatch Status Polling Proxy — Cloudflare Worker
// Fetches AI service status pages and returns normalized ServiceStatus[]
// Uses KV cache to serve last-known-good data on fetch failures

import { fetchAllServices, CACHE_KEY, COMPONENT_ID_SERVICES, SERVICES, type ServiceStatus } from './services'
import { calculateAIWatchScore } from './score'
import { buildIncidentAlerts, buildServiceAlerts, mergeTogetherAlerts, formatDetectionLead } from './alerts'
import { analyzeIncident, refreshOrReanalyze, analysisKey, type AIAnalysisResult } from './ai-analysis'
import { kvPut, kvDel, detectComponentMismatches, isCacheStale } from './utils'
import { parseDetectionEntry, resolveDetectionUpdate, serializeDetectionEntry, getDetectionTimestamp, isProbeEarlier } from './detection'

interface Env {
  ALLOWED_ORIGIN: string
  DISCORD_WEBHOOK_URL?: string
  ANTHROPIC_API_KEY?: string
  STATUS_CACHE: KVNamespace
}

// ── KV Cache + Daily Counters ──

const CACHE_TTL_SECONDS = 900 // 15 min — must exceed KV_WRITE_INTERVAL_MS (10 min) to avoid cache gaps
let lastKvWrite = 0
const KV_WRITE_INTERVAL_MS = 600_000 // 10 minutes — 2 writes per interval = ~288/day within free tier
let lastArchivedDate = '' // prevent duplicate archival writes within same isolate
let lastKvLimitAlert = 0 // in-memory throttle for KV limit alerts (can't use KV when KV is full)
let lastLatencySlot = '' // prevent duplicate 30-min latency writes within same isolate
const alertProxyRate = new Map<string, { start: number; count: number }>() // rate limit for /api/alert
const deliveryCounter = { discord: 0, slack: 0, failed: 0 } // in-memory counter, flushed to KV by daily summary cron
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
import { type ProbeResult, type ProbeSnapshot, type ProbeSpike, PROBE_TARGETS, computeProbeSlot, slotToTimestamp, trimSnapshots, hasSlot, failedProbe, detectConsecutiveSpikes, computeMedianRtt, isCorroboratedByProbe, isMistralProbedEndpoint } from './probe'

let lastProbeSlot = ''

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

async function sendDiscordAlert(webhookUrl: string, embed: { title: string; description: string; color: number }) {
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
    }
  } catch (err) {
    console.error('[discord] webhook failed:', err instanceof Error ? err.message : err)
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
  // to respect the 10-min KV write throttle and stay within the 1,000 writes/day free tier.
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

  // Calculate scores for fallback recommendations
  const scored = services.map((svc) => {
    const s = calculateAIWatchScore(svc)
    return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade }
  })

  // Mistral probe cross-validation — filter micro-incident noise BEFORE alert detection
  // Ensures Discord alerts and dashboard display are consistent (#209)
  // Reuse cronProbes if already fetched (stale path), otherwise read from KV
  if (cronProbes.length === 0) {
    const probeRaw = await env.STATUS_CACHE.get('probe:24h').catch(() => null)
    if (probeRaw) {
      try { cronProbes = JSON.parse(probeRaw).snapshots ?? [] } catch { /* ignore */ }
    }
  }
  if (cronProbes.length > 0) {
    const mistralMedian = computeMedianRtt(cronProbes, 'mistral')
    if (mistralMedian !== null) {
      for (const svc of scored) {
        if (svc.id !== 'mistral' || !svc.incidents?.length) continue
        svc.incidents = svc.incidents.filter((inc) =>
          !isMistralProbedEndpoint(inc.title) || isCorroboratedByProbe(cronProbes, 'mistral', inc.startedAt, inc.resolvedAt ?? null, mistralMedian),
        )
      }
    }
  }

  // Collect previously alerted IDs from KV for dedup context
  const alertedNewIds = new Set<string>()
  const alertedDownMap = new Map<string, string>()
  const alertedDegradedMap = new Map<string, string>()
  for (const svc of scored) {
    for (const inc of svc.incidents ?? []) {
      const wasAlerted = await env.STATUS_CACHE.get(`alerted:new:${inc.id}`).catch(() => null)
      if (wasAlerted) alertedNewIds.add(inc.id)
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
  const incidentAlerts = buildIncidentAlerts(scored, alertedNewIds)
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
  for (const alert of sent) {
    const isStatusAlert = alert.key.startsWith('alerted:down:') || alert.key.startsWith('alerted:degraded:')
    const isRecoveryAlert = alert.key.startsWith('alerted:recovered:')
    const ttl = (isStatusAlert || isRecoveryAlert) ? 7200 : 604800
    const kvValue = isStatusAlert ? new Date().toISOString() : '1'
    // Write dedup keys for all merged alerts (Together AI grouping)
    const keysToWrite = alert._mergedKeys ?? [alert.key]
    await Promise.all(keysToWrite.map(k => kvPut(env.STATUS_CACHE, k, kvValue, { expirationTtl: ttl })))
    if (isStatusAlert) {
      const svcId = alert.key.split(':').pop()!
      await kvDel(env.STATUS_CACHE, `alerted:recovered:${svcId}`)
    }
    // Mark AI analyses as resolved (keep for 2h instead of deleting) — per-incident keys
    if (isRecoveryAlert) {
      const svcId = alert.key.replace('alerted:recovered:', '')
      const svc = scored.find(s => s.id === svcId)
      const incidentIds = (svc?.incidents ?? []).map(i => i.id)
      await Promise.all(incidentIds.map(async (incId) => {
        const key = analysisKey(svcId, incId)
        const analysisRaw = await env.STATUS_CACHE.get(key).catch(() => null)
        if (!analysisRaw) return
        try {
          const analysis = JSON.parse(analysisRaw) as AIAnalysisResult
          if (!analysis.resolvedAt) {
            analysis.resolvedAt = new Date().toISOString()
            await kvPut(env.STATUS_CACHE, key, JSON.stringify(analysis), { expirationTtl: 7200 })
          }
        } catch { await kvDel(env.STATUS_CACHE, key) }
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
        // AI analysis (8s timeout)
        if (!alert._mergedKeys && env.ANTHROPIC_API_KEY) {
          try {
            const today = new Date().toISOString().split('T')[0]
            const usageKey = `ai:usage:${today}`
            const usageRaw = await env.STATUS_CACHE.get(usageKey).catch(() => null)
            const usage = usageRaw ? JSON.parse(usageRaw) : { calls: 0, success: 0, failed: 0 }
            usage.calls++
            const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))
            const analysis = await Promise.race([
              analyzeIncident(env.ANTHROPIC_API_KEY!, svc.name, { id: inc.id, title: inc.title, status: inc.status, startedAt: inc.startedAt, impact: inc.impact, timeline: inc.timeline }, svc.incidents ?? []),
              timeout,
            ])
            if (analysis) {
              usage.success++
              const kvOk = await kvPut(env.STATUS_CACHE, analysisKey(svc.id, inc.id), JSON.stringify(analysis), { expirationTtl: 3600 })
              if (kvOk) {
                analysisSection = `\n${DIV}\n🤖 **AI ANALYSIS** [Beta]\n${analysis.summary}\n⏱ Est. recovery: ${analysis.estimatedRecovery}${analysis.affectedScope.length > 0 ? `\n📡 Scope: ${analysis.affectedScope.join(', ')}` : ''}`
              }
            } else {
              usage.failed++
            }
            await kvPut(env.STATUS_CACHE, usageKey, JSON.stringify(usage), { expirationTtl: 172800 })
          } catch (err) {
            console.error('[cron] AI analysis failed:', err instanceof Error ? err.message : err)
          }
        }
        // Detection Lead: show early detection advantage in Discord alert
        try {
          const detectRaw = await env.STATUS_CACHE.get(`detected:${svc.id}`).catch(() => null)
          const detectedAt = getDetectionTimestamp(detectRaw)
          detectionLeadSection = formatDetectionLead(detectedAt, inc.startedAt)
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
    parts.push(`${DIV}\n[View on AIWatch](${alert.url})`)
    await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
      title: alert.title,
      description: parts.join('\n'),
      color: alert.color,
    })
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
  await refreshOrReanalyze(activeServices, env.STATUS_CACHE, env.ANTHROPIC_API_KEY, analyzeIncident)

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

function corsHeaders(origin: string, allowedOrigin: string | undefined): HeadersInit {
  let allowOrigin = ''
  if (!allowedOrigin) {
    allowOrigin = ''
  } else if (allowedOrigin === '*') {
    allowOrigin = '*'
  } else {
    const allowed = allowedOrigin.split(',').map((s) => s.trim())
    if (allowed.includes(origin)) {
      allowOrigin = origin
    }
  }
  if (!allowOrigin) return {}

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

import { generateBadgeSvg } from './badge'
import { generateOgSvg } from './og'
import { detectRedditPosts, formatRedditAlert, formatCompetitiveAlert, isPromotable } from './reddit'
import { detectNewRepos, formatGitHubAlert } from './competitive'
import { buildDailySummary, isInSummaryWindow } from './daily-summary'
import { collectChangelogs } from './changelog'
import { getWeekRange, buildIncidentSummary, buildStabilityChanges, buildWeeklyBriefing } from './weekly-briefing'
import { parseVitals, writeVitalsToKV, readVitalsSummary, archiveVitals } from './vitals'
import { archiveProbeDaily, type ProbeDailyData } from './probe-archival'
import { buildMonthlyArchive, isInMonthlyArchiveWindow, accumulateMonthlyIncidents, type MonthlyIncidents, type ArchiveScoreInput, type ScoreGrade } from './monthly-archive'
import { checkPlatformStatus, formatPlatformOutageAlert, formatPlatformRecoveryAlert, platformStatusKey, platformAlertKey, countPlatformServices, type PlatformStatus } from './platform-monitor'

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
    // KV budget: max 5 writes/hour = 120/day (well within 1,000/day free tier)
    const now = new Date()
    if (env.STATUS_CACHE && env.DISCORD_WEBHOOK_URL && now.getUTCMinutes() < 5) {
      try {
        const redditAlerts = await detectRedditPosts(env.STATUS_CACHE)
        // Split: service outage alerts vs competitive monitoring
        const outageAlerts = redditAlerts.filter(a => !a.competitive)
        const competitiveAlerts = redditAlerts.filter(a => a.competitive)
        // Mark all detected posts as seen (prevents re-checking), but only notify promotable ones
        for (const alert of outageAlerts.slice(0, 5)) {
          await kvPut(env.STATUS_CACHE, alert.key, '1', { expirationTtl: 86400 })
        }
        const promotable = outageAlerts.filter(a => isPromotable(a.post.title)).slice(0, 3)
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
      } catch (err) {
        console.warn('[cron] Reddit monitoring failed:', err instanceof Error ? err.message : err)
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

          const briefing = buildWeeklyBriefing({ weekStart, weekEnd, changelog, incidents, stabilityChanges })
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
          // Read latest cached services for Score data only (incidents come from accumulated KV data)
          let scoreData: ArchiveScoreInput[] = []
          const cachedRaw = await env.STATUS_CACHE.get('services:latest').catch(() => null)
          if (cachedRaw) {
            try {
              const p = JSON.parse(cachedRaw)
              scoreData = (Array.isArray(p) ? p : p.services ?? []).map((s: any) => ({
                id: s.id, aiwatchScore: s.aiwatchScore ?? null, scoreGrade: s.scoreGrade ?? null,
              }))
            } catch (parseErr) {
              console.error('[monthly-archive] Failed to parse services:latest — archive will lack Score data:',
                parseErr instanceof Error ? parseErr.message : parseErr)
            }
          }

          const archive = await buildMonthlyArchive(env.STATUS_CACHE, prevYear, prevMon, scoreData)
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

          // Read daily alert counter
          let alertCounts = null
          try {
            const alertCountRaw = await env.STATUS_CACHE.get(`alert:count:${today}`).catch(() => null)
            if (alertCountRaw) alertCounts = JSON.parse(alertCountRaw)
          } catch (err) {
            console.error('[daily-summary] Failed to parse alert counts:', err instanceof Error ? err.message : err)
          }

          // Count active webhook registrations (uses KV metadata — no individual gets needed)
          let webhookCounts = { discord: 0, slack: 0 }
          try {
            const listed = await env.STATUS_CACHE.list({ prefix: 'webhook:reg:' })
            for (const key of listed.keys) {
              const meta = key.metadata as { type?: string } | null
              if (meta?.type === 'discord') webhookCounts.discord++
              else if (meta?.type === 'slack') webhookCounts.slack++
            }
          } catch (err) {
            console.warn('[daily-summary] Failed to count webhooks:', err instanceof Error ? err.message : err)
          }

          // Flush in-memory delivery counter to KV (merge with any existing counts from prior isolates)
          let deliveryCounts: { discord: number; slack: number; failed: number } | null = null
          try {
            const proxyDateKey = `alert:proxy:${today}`
            const proxyRaw = await env.STATUS_CACHE.get(proxyDateKey)
            const prior = proxyRaw ? JSON.parse(proxyRaw) : {}
            const merged = {
              discord: (typeof prior.discord === 'number' ? prior.discord : 0) + deliveryCounter.discord,
              slack: (typeof prior.slack === 'number' ? prior.slack : 0) + deliveryCounter.slack,
              failed: (typeof prior.failed === 'number' ? prior.failed : 0) + deliveryCounter.failed,
            }
            if (merged.discord > 0 || merged.slack > 0 || merged.failed > 0) {
              await env.STATUS_CACHE.put(proxyDateKey, JSON.stringify(merged), { expirationTtl: 172800 })
            }
            deliveryCounts = merged
            // Reset in-memory counter after flush
            deliveryCounter.discord = 0
            deliveryCounter.slack = 0
            deliveryCounter.failed = 0
          } catch (err) {
            console.warn('[daily-summary] Failed to flush delivery counts:', err instanceof Error ? err.message : err)
          }

          // Read web vitals summary for today
          const vitalsSummary = await readVitalsSummary(env.STATUS_CACHE).catch((err) => {
            console.error('[daily-summary] vitals read failed:', err instanceof Error ? err.message : err)
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
            vitals: vitalsSummary,
            probeSnapshots,
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

    // POST /api/alert — webhook proxy (CORS workaround for Slack/Discord)
    if (request.method === 'POST' && url.pathname === '/api/alert') {
      try {
        const body = await request.json() as { webhookUrl?: string; channel?: string; payload?: unknown }
        const { webhookUrl, channel, payload } = body
        if (!webhookUrl || !payload) {
          return new Response(JSON.stringify({ error: 'Missing webhookUrl or payload' }), {
            status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
          })
        }
        // Strict validation — protocol, domain, and path prefix
        const parsed = new URL(webhookUrl)
        if (parsed.protocol !== 'https:') {
          return new Response(JSON.stringify({ error: 'Only HTTPS webhook URLs allowed' }), {
            status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
          })
        }
        const isSlack = parsed.hostname === 'hooks.slack.com' && parsed.pathname.startsWith('/services/')
        const isDiscord = parsed.hostname === 'discord.com' && parsed.pathname.startsWith('/api/webhooks/')
        if (!isSlack && !isDiscord) {
          return new Response(JSON.stringify({ error: 'Webhook URL not allowed' }), {
            status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
          })
        }
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
        if (resp.ok) deliveryCounter[isDiscord ? 'discord' : 'slack']++
        else deliveryCounter.failed++
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
          if (!type || (type !== 'discord' && type !== 'slack')) {
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
        const scoreData = calculateAIWatchScore(svc)
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
          const scoreData = calculateAIWatchScore(svc)
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

        // Filter Mistral micro-incident noise via probe cross-validation (#91)
        // Must run BEFORE AI analysis reads — otherwise filtered incidents still have analysis data
        if (probe24h.length > 0) {
          const mistralMedian = computeMedianRtt(probe24h, 'mistral')
          if (mistralMedian !== null) {
            for (const svc of cached.services) {
              if (svc.id !== 'mistral' || !svc.incidents?.length) continue
              svc.incidents = svc.incidents.filter((inc) =>
                !isMistralProbedEndpoint(inc.title) || isCorroboratedByProbe(probe24h, 'mistral', inc.startedAt, inc.resolvedAt ?? null, mistralMedian),
              )
            }
          }
        }

        // Read AI analysis (per-incident keys) — uses filtered incident list
        const aiAnalysis: Record<string, AIAnalysisResult[]> = {}
        const recentlyRecovered: string[] = []
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
        // Recently recovered: operational services with resolved analysis in per-incident keys
        const operationalCached = cached.services.filter(s => s.status === 'operational' && !aiAnalysis[s.id])
        await Promise.all(operationalCached.flatMap(svc =>
          (svc.incidents ?? []).map(async (inc) => {
            const raw = await env.STATUS_CACHE!.get(analysisKey(svc.id, inc.id)).catch(() => null)
            if (!raw) return
            try {
              const parsed = JSON.parse(raw) as AIAnalysisResult
              if (parsed.resolvedAt) {
                if (!aiAnalysis[svc.id]) aiAnalysis[svc.id] = []
                aiAnalysis[svc.id].push(parsed)
                if (!recentlyRecovered.includes(svc.id)) recentlyRecovered.push(svc.id)
              }
            } catch { /* ignore */ }
          })
        ))

        // Calculate scores for cached services (same as /api/status)
        const scoredCached = cached.services.map((svc) => {
          const s = calculateAIWatchScore(svc)
          return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade, scoreConfidence: s.confidence, scoreBreakdown: s.breakdown, scoreMetrics: s.metrics }
        })

        return new Response(JSON.stringify({
          services: scoredCached,
          lastUpdated: cached.cachedAt,
          cached: true,
          latency24h,
          ...(probe24h.length > 0 ? { probe24h } : {}),
          ...(Object.keys(aiAnalysis).length > 0 ? { aiAnalysis } : {}),
          ...(recentlyRecovered.length > 0 ? { recentlyRecovered } : {}),
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

      // Filter Mistral micro-incident noise via probe cross-validation (#91)
      if (probe24h.length > 0) {
        const mistralMedian = computeMedianRtt(probe24h, 'mistral')
        if (mistralMedian !== null) {
          for (const svc of enriched) {
            if (svc.id !== 'mistral' || !svc.incidents?.length) continue
            svc.incidents = svc.incidents.filter((inc) =>
              !isMistralProbedEndpoint(inc.title) || isCorroboratedByProbe(probe24h, 'mistral', inc.startedAt, inc.resolvedAt ?? null, mistralMedian),
            )
          }
        }
      }

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
      const servicesWithScore = enriched.map((svc) => {
        const s = calculateAIWatchScore(svc)
        const detectedAt = detectionMap.get(svc.id) ?? null
        return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade, scoreConfidence: s.confidence, scoreBreakdown: s.breakdown, scoreMetrics: s.metrics, ...(detectedAt ? { detectedAt } : {}) }
      })

      // Read AI analysis from KV — per-incident keys, active incidents + recently resolved
      const aiAnalysis: Record<string, AIAnalysisResult[]> = {}
      const recentlyRecovered: string[] = []
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
        // Recently recovered: operational services with resolved analysis in per-incident keys
        const operationalSvcs = servicesWithScore.filter(s => s.status === 'operational' && !aiAnalysis[s.id])
        await Promise.all(operationalSvcs.flatMap(svc =>
          (svc.incidents ?? []).map(async (inc) => {
            const raw = await env.STATUS_CACHE!.get(analysisKey(svc.id, inc.id)).catch(() => null)
            if (!raw) return
            try {
              const parsed = JSON.parse(raw) as AIAnalysisResult
              if (parsed.resolvedAt) {
                if (!aiAnalysis[svc.id]) aiAnalysis[svc.id] = []
                aiAnalysis[svc.id].push(parsed)
                if (!recentlyRecovered.includes(svc.id)) recentlyRecovered.push(svc.id)
              }
            } catch { /* ignore parse errors */ }
          })
        ))
      }

      return new Response(JSON.stringify({
        services: servicesWithScore,
        lastUpdated: new Date().toISOString(),
        latency24h,
        ...(probe24h.length > 0 ? { probe24h } : {}),
        ...(Object.keys(aiAnalysis).length > 0 ? { aiAnalysis } : {}),
        ...(recentlyRecovered.length > 0 ? { recentlyRecovered } : {}),
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

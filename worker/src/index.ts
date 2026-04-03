// AIWatch Status Polling Proxy — Cloudflare Worker
// Fetches AI service status pages and returns normalized ServiceStatus[]
// Uses KV cache to serve last-known-good data on fetch failures

import { fetchAllServices, CACHE_KEY, COMPONENT_ID_SERVICES, type ServiceStatus } from './services'
import { calculateAIWatchScore } from './score'
import { buildIncidentAlerts, buildServiceAlerts } from './alerts'
import { analyzeIncident, refreshOrReanalyze, analysisKey, type AIAnalysisResult } from './ai-analysis'
import { kvPut, kvDel, detectComponentMismatches } from './utils'

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
import { type ProbeResult, type ProbeSnapshot, type ProbeSpike, PROBE_TARGETS, computeProbeSlot, slotToTimestamp, trimSnapshots, hasSlot, failedProbe, detectConsecutiveSpikes } from './probe'

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

  // Read cached service data (written by /api/status handler)
  const raw = await env.STATUS_CACHE.get(CACHE_KEY).catch(() => null)
  if (!raw) return empty
  let services: ServiceStatus[]
  try {
    const parsed = JSON.parse(raw)
    services = Array.isArray(parsed) ? parsed : parsed.services
    if (!Array.isArray(services)) return empty
  } catch (err) { console.error('[cron] Failed to parse cached services:', err instanceof Error ? err.message : err); return empty }

  // Calculate scores for fallback recommendations
  const scored = services.map((svc) => {
    const s = calculateAIWatchScore(svc)
    return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade }
  })

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
  // Only store if no existing detection — preserves earliest detection time
  for (const svc of scored) {
    if (svc.status !== 'operational') {
      const detectKey = `detected:${svc.id}`
      const existing = await env.STATUS_CACHE.get(detectKey).catch(() => null)
      if (!existing) {
        await kvPut(env.STATUS_CACHE, detectKey, new Date().toISOString(), { expirationTtl: 604800 })
      }
    } else {
      // Service recovered — clean up detection timestamp
      await kvDel(env.STATUS_CACHE, `detected:${svc.id}`)
    }
  }

  // Send + mark as alerted (down/degraded: 2h TTL, incidents/recovery: 7d TTL)
  // For new incidents, run AI analysis with timeout so it can be merged into the embed
  const sent = toSend.slice(0, 5)
  const DIV = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈'
  for (const alert of sent) {
    const isStatusAlert = alert.key.startsWith('alerted:down:') || alert.key.startsWith('alerted:degraded:')
    const isRecoveryAlert = alert.key.startsWith('alerted:recovered:')
    const ttl = (isStatusAlert || isRecoveryAlert) ? 7200 : 604800
    const kvValue = isStatusAlert ? new Date().toISOString() : '1'
    await kvPut(env.STATUS_CACHE, alert.key, kvValue, { expirationTtl: ttl })
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

    // For new incidents: run AI analysis with 8s timeout to avoid blocking alert delivery
    let analysisSection = ''
    if (alert.key.startsWith('alerted:new:') && env.ANTHROPIC_API_KEY) {
      const incId = alert.key.replace('alerted:new:', '')
      const svc = scored.find(s => (s.incidents ?? []).some(i => i.id === incId))
      const inc = svc ? (svc.incidents ?? []).find(i => i.id === incId) : null
      if (svc && inc) {
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
    }

    // Build sectioned description: incident → AI analysis → fallback → link
    const parts = [alert.description]
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
        if (a.key.startsWith('alerted:new:')) counts.incidents++
        else if (a.key.startsWith('alerted:res:')) counts.resolved++
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
  const activeServices = scored.filter(s =>
    (s.incidents ?? []).some(i => i.status !== 'resolved')
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
    newCount: sent.filter(a => a.key.startsWith('alerted:new:')).length,
    resolvedCount: sent.filter(a => a.key.startsWith('alerted:res:')).length,
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
import { detectRedditPosts, formatRedditAlert, isPromotable } from './reddit'
import { buildDailySummary } from './daily-summary'
import { parseVitals, writeVitalsToKV, readVitalsSummary, archiveVitals } from './vitals'
import { archiveProbeDaily } from './probe-archival'

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
            if (!existingDetect || new Date(spike.since).getTime() < new Date(existingDetect).getTime()) {
              await kvPut(env.STATUS_CACHE, detectKey, spike.since, { expirationTtl: 604800 })
            }
          }
        }
      } catch (err) {
        console.warn('[cron] probe spike detection failed:', err instanceof Error ? err.message : err)
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
        // Mark all detected posts as seen (prevents re-checking), but only notify promotable ones
        for (const alert of redditAlerts.slice(0, 5)) {
          await kvPut(env.STATUS_CACHE, alert.key, '1', { expirationTtl: 86400 })
        }
        const promotable = redditAlerts.filter(a => isPromotable(a.post.title)).slice(0, 3)
        for (const alert of promotable) {
          const formatted = formatRedditAlert(alert)
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

    // Daily summary at UTC 09:00 (KST 18:00) — purple embed
    if (now.getUTCHours() === 9 && now.getUTCMinutes() < 5) {
      try {
        // Gather data for expanded daily report
        const today = now.toISOString().split('T')[0]
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

        // Archive yesterday's vitals as p75 summary (90d retention)
        await archiveVitals(env.STATUS_CACHE).catch((err) =>
          console.warn('[daily-summary] vitals archive failed:', err instanceof Error ? err.message : err)
        )

        // Archive yesterday's probe RTT as daily summary (90d retention for monthly reports)
        await archiveProbeDaily(env.STATUS_CACHE, now).catch((err) =>
          console.warn('[daily-summary] probe archive failed:', err instanceof Error ? err.message : err)
        )

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

        const dateStr = now.toISOString().split('T')[0]
        await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
          title: `📊 AIWatch Daily Report — ${dateStr}`,
          description,
          color: 0x9B59B6, // purple
        })
      } catch (err) {
        console.error('[daily-summary] Expanded report failed:', err instanceof Error ? err.message : err)
        await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
          title: '📊 Daily Summary',
          description: `${result.total} services checked\n${result.operational} operational · ${result.issues} issues`,
          color: 0x9B59B6,
        })
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
        // Read AI analysis + latency 24h in parallel (per-incident keys)
        const aiAnalysis: Record<string, AIAnalysisResult[]> = {}
        const recentlyRecovered: string[] = []
        const latencyPromise = env.STATUS_CACHE!.get('latency:24h').catch(() => null)
        const probePromise = env.STATUS_CACHE!.get('probe:24h').catch(() => null)
        // Active incidents: read ai:analysis:{svcId}:{incId} for each
        const withActiveInc = cached.services.filter(s =>
          (s.incidents ?? []).some(i => i.status !== 'resolved')
        )
        await Promise.all(withActiveInc.flatMap(svc =>
          (svc.incidents ?? []).filter(i => i.status !== 'resolved').map(async (inc) => {
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
        let latency24h: Array<{ t: string; data: Record<string, number> }> = []
        let probe24h: ProbeSnapshot[] = []
        const latRaw = await latencyPromise
        const probeRaw = await probePromise
        if (latRaw) {
          try { latency24h = JSON.parse(latRaw).snapshots ?? [] } catch (err) { console.warn('[kv] cached latency24h parse failed:', err instanceof Error ? err.message : err) }
        }
        if (probeRaw) {
          try { probe24h = JSON.parse(probeRaw).snapshots ?? [] } catch (err) { console.warn('[kv] cached probe24h parse failed:', err instanceof Error ? err.message : err) }
        }

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

    if (request.method !== 'GET' || (url.pathname !== '/api/status' && url.pathname !== '/api/uptime')) {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    try {
      const { raw, enriched } = await fetchAllServices(env.STATUS_CACHE)

      // Cache raw results only (no fallback substitution — prevents cache poisoning)
      // Await cacheWrite so badge/v1 endpoints see data immediately
      if (env.STATUS_CACHE) {
        await cacheWrite(env.STATUS_CACHE, raw, env.DISCORD_WEBHOOK_URL)
        ctx.waitUntil(writeLatencySnapshot(env.STATUS_CACHE, raw))
      }

      // Read hourly latency snapshots + probe data (2 KV reads)
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

      // Add AIWatch Score + Detection Lead timestamps to each service
      const detectionMap = new Map<string, string>()
      if (env.STATUS_CACHE) {
        await Promise.all(enriched.map(async (svc) => {
          if (svc.status !== 'operational') {
            const ts = await env.STATUS_CACHE!.get(`detected:${svc.id}`).catch(() => null)
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
        const withActiveInc = servicesWithScore.filter(s =>
          (s.incidents ?? []).some(i => i.status !== 'resolved')
        )
        await Promise.all(withActiveInc.flatMap(svc =>
          (svc.incidents ?? []).filter(i => i.status !== 'resolved').map(async (inc) => {
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

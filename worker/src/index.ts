// AIWatch Status Polling Proxy — Cloudflare Worker
// Fetches AI service status pages and returns normalized ServiceStatus[]
// Uses KV cache to serve last-known-good data on fetch failures

import { fetchAllServices, CACHE_KEY, type ServiceStatus } from './services'
import { calculateAIWatchScore } from './score'
import { getFallbacks, buildFallbackText } from './fallback'

interface Env {
  ALLOWED_ORIGIN: string
  DISCORD_WEBHOOK_URL?: string
  STATUS_CACHE: KVNamespace
}

// ── KV Cache + Daily Counters ──

const CACHE_TTL_SECONDS = 300 // 5 min — short TTL so stale cache clears quickly on outage recovery
let lastKvWrite = 0
const KV_WRITE_INTERVAL_MS = 600_000 // 10 minutes — 2 writes per interval = ~288/day within free tier
let lastArchivedDate = '' // prevent duplicate archival writes within same isolate
let lastLatencySlot = '' // prevent duplicate 30-min latency writes within same isolate
const alertProxyRate = new Map<string, { start: number; count: number }>() // rate limit for /api/alert
const publicApiRate = new Map<string, { start: number; count: number }>() // rate limit for /api/v1/*

interface DailyCounters {
  [serviceId: string]: { ok: number; total: number }
}

function todayUTC(): string {
  return new Date().toISOString().split('T')[0]
}

async function cacheWrite(kv: KVNamespace, services: ServiceStatus[]): Promise<void> {
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
  } catch { /* ignore */ }

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
  ]).catch((err) => console.error('[kv] cache write failed:', err))

  // Archive yesterday's counters to permanent history (once per day per isolate)
  const yesterday = new Date(now - 86_400_000).toISOString().split('T')[0]
  if (lastArchivedDate !== yesterday) {
    const yesterdayKey = `daily:${yesterday}`
    const yesterdayData = await kv.get(yesterdayKey).catch(() => null)
    if (yesterdayData) {
      await kv.put(`history:${yesterday}`, yesterdayData, {
        expirationTtl: 90 * 86400,
      }).catch(() => {})
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

async function cacheRead(kv: KVNamespace): Promise<{ services: ServiceStatus[]; cachedAt: string } | null> {
  const raw = await kv.get(CACHE_KEY).catch(() => null)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
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
      try { history[keyPairs[i].dateStr] = JSON.parse(raw) } catch { /* ignore */ }
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

// ── Discord Webhook Alerts ──

// Module-level cooldown (persists across requests within same isolate)
const lastAlertTime = new Map<string, number>()
const ALERT_COOLDOWN_MS = 5 * 60_000 // 5 minutes

function sanitize(s: string, maxLen = 1000): string {
  return s
    .replace(/@(everyone|here)/g, '@\u200b$1')
    .replace(/<@[!&]?\d+>/g, '[mention]')
    .replace(/```/g, '\\`\\`\\`')
    .slice(0, maxLen)
}

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

function alertWorkerError(env: Env, error: string) {
  if (!env.DISCORD_WEBHOOK_URL) return Promise.resolve()
  const now = Date.now()
  const last = lastAlertTime.get('__worker_error__')
  if (last && now - last < ALERT_COOLDOWN_MS) return Promise.resolve()
  lastAlertTime.set('__worker_error__', now)

  return sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
    title: '🔴 Worker Error — API 장애',
    description: `\`fetchAllServices()\` 전체 실패\n\`\`\`${sanitize(error)}\`\`\``,
    color: 0xED4245, // red
  })
}

function alertServicesDown(env: Env, downServices: ServiceStatus[]) {
  if (!env.DISCORD_WEBHOOK_URL || downServices.length === 0) return Promise.resolve()
  const now = Date.now()
  const newDown = downServices.filter((s) => {
    const last = lastAlertTime.get(s.id)
    return !last || now - last > ALERT_COOLDOWN_MS
  })
  if (newDown.length === 0) return Promise.resolve()
  newDown.forEach((s) => lastAlertTime.set(s.id, now))

  const list = newDown.map((s) => `• **${s.name}** (${s.provider})`).join('\n')
  return sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
    title: `🟡 ${newDown.length} service(s) down`,
    description: list,
    color: 0xFEE75C, // yellow
  })
}

// ── Server-side Incident Detection ──
// Compares current incidents against KV-stored previous state.
// Sends Discord alerts for new incidents and resolutions.

const INCIDENT_STATE_KEY = 'incident-alert-state'
const INCIDENT_CHECK_KEY = 'incident-last-check'
const INCIDENT_CHECK_INTERVAL_MS = 600_000 // 10 minutes

async function detectAndAlertIncidents(
  env: Env,
  services: ServiceStatus[],
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL || !env.STATUS_CACHE) return

  // KV-based throttle: shared across all isolates.
  // Per-alert dedup keys (inc-sent:*) provide the true uniqueness guarantee.
  const now = Date.now()
  let lastCheckStr: string | null = null
  try {
    lastCheckStr = await env.STATUS_CACHE.get(INCIDENT_CHECK_KEY)
  } catch (err) {
    console.error('[incident-detect] KV throttle read failed, proceeding:', err instanceof Error ? err.message : err)
  }
  if (lastCheckStr && now - Number(lastCheckStr) < INCIDENT_CHECK_INTERVAL_MS) return
  await env.STATUS_CACHE.put(INCIDENT_CHECK_KEY, String(now), { expirationTtl: 3600 })
    .catch((err) => console.error('[incident-detect] KV throttle write failed:', err instanceof Error ? err.message : err))

  // Read previous incident state from KV
  let prevState: Record<string, Record<string, string>> = {} // { serviceId: { incId: status } }
  try {
    const raw = await env.STATUS_CACHE.get(INCIDENT_STATE_KEY)
    if (raw) prevState = JSON.parse(raw)
  } catch (err) {
    console.error('[incident-detect] failed to read previous state:', err instanceof Error ? err.message : err)
    return
  }

  // Build current state
  const currentState: Record<string, Record<string, string>> = {}
  for (const svc of services) {
    currentState[svc.id] = {}
    for (const inc of svc.incidents ?? []) {
      currentState[svc.id][inc.id] = inc.status
    }
  }

  // Skip on first run (no previous data)
  if (Object.keys(prevState).length === 0) {
    await env.STATUS_CACHE.put(INCIDENT_STATE_KEY, JSON.stringify(currentState), {
      expirationTtl: 7 * 86400,
    }).catch((err) => console.error('[incident-detect] first-run state save failed:', err instanceof Error ? err.message : err))
    return
  }

  const alerts: Array<{ key: string; title: string; description: string; color: number; url: string }> = []

  for (const svc of services) {
    const prev = prevState[svc.id] ?? {}
    const curr = currentState[svc.id] ?? {}

    for (const inc of svc.incidents ?? []) {
      // New incident — only alert if started within last 24 hours
      const incAge = Date.now() - new Date(inc.startedAt).getTime()
      if (!prev[inc.id] && incAge < 86_400_000) {
        const fallbacks = getFallbacks(svc.id, svc.category, services)
        const fallbackText = buildFallbackText(fallbacks)
        alerts.push({
          key: `inc-sent:new:${inc.id}`,
          title: `🔴 ${svc.name} — New Incident`,
          description: `${sanitize(inc.title)}\n${fallbackText}`,
          color: 0xED4245,
          url: `https://ai-watch.dev/#${svc.id}`,
        })
      }

      // Incident resolved
      if (prev[inc.id] && prev[inc.id] !== 'resolved' && inc.status === 'resolved') {
        const durationText = inc.duration ? ` (${inc.duration})` : ''
        alerts.push({
          key: `inc-sent:res:${inc.id}`,
          title: `🟢 ${svc.name} — Incident Resolved${durationText}`,
          description: sanitize(inc.title),
          color: 0x57F287,
          url: `https://ai-watch.dev/#${svc.id}`,
        })
      }
    }

    // Check for incidents that vanished (resolved and removed from status page)
    for (const [incId, prevStatus] of Object.entries(prev)) {
      if (prevStatus !== 'resolved' && !curr[incId]) {
        alerts.push({
          key: `inc-sent:res:${incId}`,
          title: `🟢 ${svc.name} — Incident Resolved`,
          description: '(incident removed from status page)',
          color: 0x57F287,
          url: `https://ai-watch.dev/#${svc.id}`,
        })
      }
    }
  }

  // KV-based dedup: skip alerts already sent by another isolate
  const deduped: typeof alerts = []
  for (const alert of alerts.slice(0, 3)) {
    try {
      const existing = await env.STATUS_CACHE.get(alert.key)
      if (existing) continue
    } catch (err) {
      console.error('[incident-detect] KV dedup read failed, allowing alert:', alert.key, err instanceof Error ? err.message : err)
    }
    deduped.push(alert)
  }

  // Mark as sent BEFORE sending to prevent duplicate sends from concurrent isolates.
  // If Discord send fails, the key expires in 1h and the alert retries next cycle.
  for (const alert of deduped) {
    try {
      await env.STATUS_CACHE.put(alert.key, '1', { expirationTtl: 3600 })
    } catch (err) {
      console.error('[incident-detect] dedup marker write failed:', alert.key, err instanceof Error ? err.message : err)
    }
  }
  await Promise.all(
    deduped.map((alert) =>
      sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
        title: alert.title,
        description: `${alert.description}\n[View on AIWatch](${alert.url})`,
        color: alert.color,
      })
    )
  )

  // Save current state
  await env.STATUS_CACHE.put(INCIDENT_STATE_KEY, JSON.stringify(currentState), {
    expirationTtl: 7 * 86400,
  }).catch((err) => console.error('[incident-detect] state save failed:', err instanceof Error ? err.message : err))
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

import { generateBadgeSvg } from './badge'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin') ?? ''
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN)

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

    if (request.method !== 'GET' || (url.pathname !== '/api/status' && url.pathname !== '/api/uptime')) {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
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

    try {
      const { raw, enriched } = await fetchAllServices(env.STATUS_CACHE)

      // Cache raw results only (no fallback substitution — prevents cache poisoning)
      if (env.STATUS_CACHE) {
        ctx.waitUntil(cacheWrite(env.STATUS_CACHE, raw))
        ctx.waitUntil(writeLatencySnapshot(env.STATUS_CACHE, raw))
      }

      // Read hourly latency snapshots (1 KV read)
      let latency24h: Array<{ t: string; data: Record<string, number> }> = []
      if (env.STATUS_CACHE) {
        const raw = await env.STATUS_CACHE.get('latency:24h').catch(() => null)
        if (raw) {
          try { latency24h = JSON.parse(raw).snapshots ?? [] } catch { /* ignore */ }
        }
      }

      // Alert if any services are down
      const downServices = enriched.filter((s) => s.status === 'down')
      if (downServices.length > 0) {
        ctx.waitUntil(alertServicesDown(env, downServices))
      }

      // Add AIWatch Score to each service
      const servicesWithScore = enriched.map((svc) => {
        const s = calculateAIWatchScore(svc)
        return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade, scoreConfidence: s.confidence, scoreBreakdown: s.breakdown }
      })

      // Detect new/resolved incidents and send Discord alerts (after score calc for fallback)
      ctx.waitUntil(detectAndAlertIncidents(env, servicesWithScore))

      return new Response(JSON.stringify({
        services: servicesWithScore,
        lastUpdated: new Date().toISOString(),
        latency24h,
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

// AIWatch Status Polling Proxy — Cloudflare Worker
// Fetches AI service status pages and returns normalized ServiceStatus[]
// Uses KV cache to serve last-known-good data on fetch failures

import { fetchAllServices, CACHE_KEY, type ServiceStatus } from './services'

interface Env {
  ALLOWED_ORIGIN: string
  DISCORD_WEBHOOK_URL?: string
  STATUS_CACHE: KVNamespace
}

// ── KV Cache ──

const CACHE_TTL_SECONDS = 3600 // 1 hour — long enough for extended outages
let lastKvWrite = 0
const KV_WRITE_INTERVAL_MS = 90_000 // throttle per-isolate; actual rate depends on isolate lifecycle

async function cacheWrite(kv: KVNamespace, services: ServiceStatus[]): Promise<void> {
  const now = Date.now()
  if (now - lastKvWrite < KV_WRITE_INTERVAL_MS) return
  lastKvWrite = now
  await kv.put(CACHE_KEY, JSON.stringify({
    services,
    cachedAt: new Date().toISOString(),
  }), { expirationTtl: CACHE_TTL_SECONDS }).catch((err) =>
    console.error('[kv] cache write failed:', err)
  )
}

async function cacheRead(kv: KVNamespace): Promise<{ services: ServiceStatus[]; cachedAt: string } | null> {
  const raw = await kv.get(CACHE_KEY).catch(() => null)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin') ?? ''
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    if (url.pathname !== '/api/status' || request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    try {
      const { raw, enriched } = await fetchAllServices(env.STATUS_CACHE)

      // Cache raw results only (no fallback substitution — prevents cache poisoning)
      if (env.STATUS_CACHE) {
        ctx.waitUntil(cacheWrite(env.STATUS_CACHE, raw))
      }

      // Alert if any services are down
      const downServices = enriched.filter((s) => s.status === 'down')
      if (downServices.length > 0) {
        ctx.waitUntil(alertServicesDown(env, downServices))
      }

      return new Response(JSON.stringify({
        services: enriched,
        lastUpdated: new Date().toISOString(),
      }), {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=30',
        },
      })
    } catch (err) {
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

      const message = err instanceof Error ? err.message : 'Unknown error'
      ctx.waitUntil(alertWorkerError(env, message))
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  },
}

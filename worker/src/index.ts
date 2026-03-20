// AIWatch Status Polling Proxy — Cloudflare Worker
// Fetches AI service status pages and returns normalized ServiceStatus[]

import { fetchAllServices, type ServiceStatus } from './services'

interface Env {
  ALLOWED_ORIGIN: string
  DISCORD_WEBHOOK_URL?: string
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
    // Support comma-separated origins: "https://ai-watch.dev,https://aiwatch-dev.vercel.app"
    const allowed = allowedOrigin.split(',').map((s) => s.trim())
    if (allowed.includes(origin)) {
      allowOrigin = origin
    }
  }
  // Omit CORS headers entirely for disallowed origins
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

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    // Only GET /api/status is supported
    if (url.pathname !== '/api/status' || request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    try {
      const services: ServiceStatus[] = await fetchAllServices()

      // Alert if any services are down (non-blocking, with 5min cooldown per service)
      const downServices = services.filter((s) => s.status === 'down')
      if (downServices.length > 0) {
        ctx.waitUntil(alertServicesDown(env, downServices))
      }

      return new Response(JSON.stringify({
        services,
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
      const message = err instanceof Error ? err.message : 'Unknown error'
      ctx.waitUntil(alertWorkerError(env, message))
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  },
}

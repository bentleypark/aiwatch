// AIWatch Status Polling Proxy — Cloudflare Worker
// Fetches AI service status pages and returns normalized ServiceStatus[]

import { fetchAllServices, type ServiceStatus } from './services'

interface Env {
  ALLOWED_ORIGIN: string
}

function corsHeaders(origin: string, allowedOrigin: string | undefined): HeadersInit {
  let allowOrigin = ''
  if (!allowedOrigin) {
    allowOrigin = ''
  } else if (allowedOrigin === '*') {
    allowOrigin = '*'
  } else {
    // Support comma-separated origins: "https://aiwatch.dev,https://aiwatch-dev.vercel.app"
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
  async fetch(request: Request, env: Env): Promise<Response> {
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
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  },
}

/**
 * Vercel Edge Function — DeepSeek Flashduty accessibility probe (#504 follow-up)
 *
 * DeepSeek migrated from Atlassian Statuspage to Flashduty (Flashcat.cloud).
 * Cloudflare Workers IPs are blocked by status.deepseek.com. This endpoint tests
 * whether Vercel Edge Functions can reach the Flashduty API (different IP ranges).
 *
 * GET /api/deepseek-status-probe
 *   → { reachable: boolean, status: string, sample?: object, error?: string, ms: number }
 *
 * Used for one-time validation only — remove or gate behind admin auth before shipping.
 */
export const config = { runtime: 'edge' }

const FLASHDUTY_PAGE_ID = '6410630422455'
const ACTIVE_URL = `https://status.deepseek.com/api/status-page/${FLASHDUTY_PAGE_ID}/summary/active`

export default async function handler(): Promise<Response> {
  const start = Date.now()
  try {
    const res = await fetch(ACTIVE_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'AIWatch-Status-Monitor/1.0',
      },
      signal: AbortSignal.timeout(8000),
    })

    const ms = Date.now() - start

    if (!res.ok) {
      return Response.json({
        reachable: false,
        status: `HTTP ${res.status}`,
        ms,
      })
    }

    const data = await res.json() as Record<string, unknown>

    // Extract a minimal sample to confirm the shape
    const sample = {
      keys: Object.keys(data),
      // Show top-level structure without leaking sensitive data
      hasData: 'data' in data,
      hasComponents: 'components' in data || 'services' in data,
    }

    return Response.json({
      reachable: true,
      status: 'ok',
      sample,
      ms,
    })
  } catch (err) {
    const ms = Date.now() - start
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({
      reachable: false,
      status: 'error',
      error: message,
      ms,
    })
  }
}

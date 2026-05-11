// OpenRouter per-model uptime parser (#371).
//
// status.x.ai publishes per-endpoint live success rates (~97-99%) but the page
// is Cloudflare-protected and JS-rendered — only feed.xml is whitelisted, and
// it carries incident records only, no success-rate data. A Worker `fetch`
// against the status page or its XHR endpoints hits a 403 challenge.
//
// OpenRouter, however, exposes `uptime_last_30m` per routing endpoint on a
// plain unauthenticated JSON API. Every xAI model OpenRouter routes is served
// by the single `xAI` provider endpoint, so any currently-routed xAI model's
// `xAI`-endpoint uptime answers "is xAI's API up right now?". We sample a small
// curated set of flagship slugs and average the resolved values to smooth
// per-model traffic-volume noise.
//
// IMPORTANT: this is OpenRouter's measurement of the OpenRouter→xAI path over a
// 30-minute rolling window — NOT xAI's official metric, and NOT comparable to
// the rolling-30-day uptime AIWatch shows for other services. Surface it as an
// informational line on the xAI service detail page only; do NOT feed it into
// the AIWatch Score. Gate display on the `openrouter` service being operational
// (a degraded OpenRouter would report low upstream uptime that reflects
// OpenRouter's routing, not xAI).

import { fetchWithTimeout } from '../utils'

// OpenRouter model slugs for xAI flagship models, newest-first. Update when xAI
// deprecates these — verify against https://openrouter.ai/api/v1/models (filter
// ids starting with `x-ai/`). If every slug 404s after a rename,
// fetchOpenRouterXaiUptime returns null and the detail-page line is hidden until
// the list is refreshed — a graceful, low-frequency maintenance cost (same shape
// as the curated probe target / OSV package lists elsewhere in the worker).
export const XAI_OPENROUTER_MODEL_SLUGS = [
  'x-ai/grok-4-fast',
  'x-ai/grok-4.3',
  'x-ai/grok-4.1-fast',
] as const

export interface OpenRouterXaiUptime {
  /** Average of resolved samples' `uptime_last_30m`, rounded to 2dp (0-100). */
  uptimePct: number
  /** How many of XAI_OPENROUTER_MODEL_SLUGS resolved with an `xAI` endpoint. */
  sampleCount: number
  /** ISO timestamp of our fetch. OpenRouter's underlying data is a 30-min rolling window. */
  measuredAt: string
}

const ENDPOINTS_TIMEOUT_MS = 8000

interface OpenRouterEndpointsResponse {
  data?: { endpoints?: Array<{ provider_name?: string; uptime_last_30m?: number }> }
}

/**
 * Fetch OpenRouter's `uptime_last_30m` for the `xAI` provider endpoint across
 * the curated flagship slugs and return the average. Returns null on any
 * failure (all slugs 404, every fetch errored, no `xAI` endpoint, no numeric
 * uptime) — callers treat null as "signal unavailable" and hide the line.
 */
export async function fetchOpenRouterXaiUptime(): Promise<OpenRouterXaiUptime | null> {
  const results = await Promise.allSettled(
    XAI_OPENROUTER_MODEL_SLUGS.map((slug) =>
      fetchWithTimeout(`https://openrouter.ai/api/v1/models/${slug}/endpoints`, ENDPOINTS_TIMEOUT_MS)
        .then((r) => (r.ok ? (r.json() as Promise<OpenRouterEndpointsResponse>) : null))
        .catch(() => null),
    ),
  )

  const samples: number[] = []
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue
    const endpoints = r.value.data?.endpoints
    if (!Array.isArray(endpoints)) continue
    const xaiEndpoint = endpoints.find((e) => e?.provider_name === 'xAI')
    const u = xaiEndpoint?.uptime_last_30m
    if (typeof u === 'number' && Number.isFinite(u) && u >= 0 && u <= 100) samples.push(u)
  }

  if (samples.length === 0) return null
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length
  return {
    uptimePct: Math.round(avg * 100) / 100,
    sampleCount: samples.length,
    measuredAt: new Date().toISOString(),
  }
}

/**
 * Decide whether the OpenRouter-measured xAI uptime figure should be flagged as
 * routing-affected — true when the `openrouter` service is itself non-operational
 * in the cached `services:latest` snapshot (its upstream-uptime numbers then
 * reflect OpenRouter's own routing, not xAI). Returns false when the cache is
 * absent, stale, unparseable, or lacks an `openrouter` entry — i.e. "don't flag
 * unless we have positive evidence OpenRouter is degraded".
 *
 * @param latestRaw raw JSON string from `STATUS_CACHE.get('services:latest')`, or null
 */
export function isOpenRouterDegraded(latestRaw: string | null | undefined): boolean {
  if (!latestRaw) return false
  try {
    const services = JSON.parse(latestRaw)?.services
    if (!Array.isArray(services)) return false
    const or = services.find((s: { id?: string; status?: string }) => s?.id === 'openrouter')
    return !!or && or.status !== 'operational'
  } catch {
    return false
  }
}

// #1686 — real-user `/api/status` timing from the dashboard, for the operator channel only.
// The dashboard batches one sample per poll and POSTs them to /api/rum. Each sample is written to
// WAE with the colo and country Cloudflare attached to the beacon (no IP, no identifier). A batch of
// RUM_WINDOW samples is judged by the 4-of-5 rule derived in #1686; the alert says whether the time
// went to the network path (the worker answered quickly) or to the worker itself.

import { kvPut } from './utils'
import { ALERT_TTL_S, readInfraContext } from './infra-status'

export const RUM_INDEX = 'rum-api'
export const RUM_WINDOW = 5
export const RUM_MIN_SLOW = 4
/** Provisional threshold T. #1686 sets it from a week of real samples. */
export const RUM_SLOW_MS = 10_000
/** A slow poll whose worker time is under this spent its time outside the worker. */
export const RUM_WORKER_SLOW_MS = 1_000

export type RumOutcome = 'ok' | 'timeout' | 'error' | 'pending'

export interface RumSample {
  totalMs: number
  serverMs: number | null
  outcome: RumOutcome
}

const OUTCOMES: readonly RumOutcome[] = ['ok', 'timeout', 'error', 'pending']
const MAX_MS = 600_000

const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const capMs = (v: number): number => Math.round(Math.min(v, MAX_MS))

export function parseRumBatch(body: unknown): RumSample[] | null {
  const samples = (body as { samples?: unknown })?.samples
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > RUM_WINDOW * 2) return null
  const out: RumSample[] = []
  for (const raw of samples) {
    const s = raw as Record<string, unknown>
    if (!isMs(s?.totalMs)) return null
    if (s.serverMs !== null && s.serverMs !== undefined && !isMs(s.serverMs)) return null
    if (!OUTCOMES.includes(s.outcome as RumOutcome)) return null
    out.push({
      totalMs: capMs(s.totalMs),
      serverMs: isMs(s.serverMs) ? capMs(s.serverMs) : null,
      outcome: s.outcome as RumOutcome,
    })
  }
  return out
}

export function isSlowSample(s: RumSample): boolean {
  return s.outcome === 'timeout' || s.totalMs >= RUM_SLOW_MS
}

export type RumCause = 'network-path' | 'worker' | 'unknown'

export type RumVerdict =
  | { kind: 'too-few' }
  | { kind: 'slow'; slow: number; cause: RumCause; medianTotalMs: number; medianServerMs: number | null }
  | { kind: 'healthy'; slow: number }
  | { kind: 'between'; slow: number }

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** Judge the last RUM_WINDOW samples of one batch. `healthy` (at most one slow) is what ends an
 *  alert; the band between healthy and slow changes nothing. */
export function evaluateRum(samples: RumSample[]): RumVerdict {
  const measured = samples.filter((s) => s.outcome !== 'pending' || isSlowSample(s))
  if (measured.length < RUM_WINDOW) return { kind: 'too-few' }
  const window = measured.slice(-RUM_WINDOW)
  const slowSamples = window.filter(isSlowSample)
  const slow = slowSamples.length
  if (slow <= 1) return { kind: 'healthy', slow }
  if (slow < RUM_MIN_SLOW) return { kind: 'between', slow }
  const server = slowSamples.map((s) => s.serverMs).filter((v): v is number => v !== null)
  const medianServerMs = server.length > 0 ? median(server) : null
  const cause: RumCause = medianServerMs === null ? 'unknown' : medianServerMs < RUM_WORKER_SLOW_MS ? 'network-path' : 'worker'
  return { kind: 'slow', slow, cause, medianTotalMs: median(slowSamples.map((s) => s.totalMs)), medianServerMs }
}

export function recordRumSamples(
  analytics: AnalyticsEngineDataset | undefined,
  samples: RumSample[],
  colo: string,
  country: string,
): void {
  if (!analytics) return
  for (const s of samples) {
    try {
      analytics.writeDataPoint({
        blobs: [colo, country, s.outcome],
        doubles: [s.totalMs, s.serverMs ?? -1],
        indexes: [RUM_INDEX],
      })
    } catch (err) {
      console.warn('[wae] rum writeDataPoint failed:', err instanceof Error ? err.message : err)
    }
  }
}

export const rumAlertKey = (country: string, colo: string): string => `alerted:rum:${country}:${colo}`

const CAUSE_LINE: Partial<Record<RumCause, string>> = {
  'network-path': 'The worker answered quickly, so the time was spent on the network path to the user (Cloudflare edge/routing or the user\'s network), not in our code.',
  worker: 'The worker itself was slow to answer — look at our code, KV and the runtime first.',
}

export function formatRumAlert(
  verdict: Extract<RumVerdict, { kind: 'slow' }>,
  colo: string,
  country: string,
  infraLines: string[],
): { title: string; description: string; color: number } {
  const lines = [
    `Country **${country}**, served by colo **${colo}** — ${verdict.slow}/${RUM_WINDOW} recent dashboard polls took ≥ ${RUM_SLOW_MS / 1000}s.`,
    `Median poll ${(verdict.medianTotalMs / 1000).toFixed(1)}s · worker time ${verdict.medianServerMs === null ? 'n/a' : `${verdict.medianServerMs}ms`}`,
  ]
  const cause = CAUSE_LINE[verdict.cause]
  if (cause) lines.push(cause)
  if (infraLines.length > 0) lines.push('', '**Platform status**', ...infraLines)
  return {
    title: `🐢 Dashboard API slow for real users — ${country} via ${colo}`,
    description: lines.join('\n'),
    color: 0xF0B232,
  }
}

export function formatRumRecovery(country: string, colo: string): { title: string; description: string; color: number } {
  return {
    title: `🟢 Dashboard API back to normal — ${country} via ${colo}`,
    description: `Recent dashboard polls from ${country} served by colo ${colo} are under ${RUM_SLOW_MS / 1000}s again.`,
    color: 0x57F287,
  }
}

/** Per country + colo: at most one alert and one recovery per ALERT_TTL_S hold. The hold is shared by
 *  every tab on that path while the 4-of-5 rule is per tab, so a recovery keeps the hold rather than
 *  clearing it. Only `slow` and `healthy` verdicts can change anything. */
export async function applyRumVerdict(
  kv: KVNamespace,
  send: (embed: { title: string; description: string; color: number }) => Promise<boolean>,
  verdict: RumVerdict,
  colo: string,
  country: string,
): Promise<'alerted' | 'recovered' | 'none'> {
  if (verdict.kind !== 'slow' && verdict.kind !== 'healthy') return 'none'
  const key = rumAlertKey(country, colo)
  const state = await kv.get(key).catch(() => null)
  if (verdict.kind === 'slow' && !state) {
    const embed = formatRumAlert(verdict, colo, country, await readInfraContext(kv))
    if (await send(embed)) {
      await kvPut(kv, key, 'slow', { expirationTtl: ALERT_TTL_S })
      return 'alerted'
    }
  } else if (verdict.kind === 'healthy' && state === 'slow') {
    if (await send(formatRumRecovery(country, colo))) {
      await kvPut(kv, key, 'recovered', { expirationTtl: ALERT_TTL_S })
      return 'recovered'
    }
  }
  return 'none'
}

/** Adds the worker's own handling time to the two endpoints the dashboard polls, and exposes it to
 *  the cross-origin dashboard, so a slow poll can be split into worker time and everything else. */
export function withServerTiming(request: Request, startedAt: number, res: Response, now: number = Date.now()): Response {
  const path = new URL(request.url).pathname
  if (request.method !== 'GET' || (path !== '/api/status' && path !== '/api/status/cached')) return res
  const out = new Response(res.body, res)
  out.headers.set('Server-Timing', `worker;dur=${Math.max(0, now - startedAt)}`)
  const expose = out.headers.get('Access-Control-Expose-Headers')
  out.headers.set('Access-Control-Expose-Headers', expose ? `${expose}, Server-Timing` : 'Server-Timing')
  return out
}

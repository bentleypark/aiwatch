/**
 * #1510 Slice 1 — instrumentation only. Reads Mistral's public Rootly JSON API each cron cycle and
 * changes no status, incident or badge.
 *
 * It answers two questions the scrape feed cannot: whether the Worker's own egress is challenged on
 * these paths (a WAE row per cycle), and what a real active-incident payload looks like (the raw
 * responses, kept in KV only while one is listed).
 */
import { fetchWithTimeout } from './utils'

export const MISTRAL_PUBLIC_API_BASE = 'https://status.mistral.ai/api/v1'
export const MISTRAL_PUBLIC_API_INDEX = 'mistral-public-api'
export const MISTRAL_PUBLIC_API_SOURCE = 'mistral-rootly-public'
export const MISTRAL_PUBLIC_SAMPLE_KV_KEY = 'mistral:public-sample'
export const MISTRAL_PUBLIC_SAMPLE_TTL_S = 30 * 24 * 3600

const TIMEOUT_MS = 8000
const RAW_MAX_CHARS = 64 * 1024
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; AIWatch/1.0; +https://ai-watch.dev)' }

export type PublicApiOutcome = 'ok' | 'challenged' | 'non-200' | 'not-json' | 'error'
export type PublicApiFetch = (url: string, timeoutMs: number, init: RequestInit) => Promise<Response>

export interface PublicApiResult {
  outcome: PublicApiOutcome
  httpStatus: number
  /** Length of the response's `incidents` array; null when the body is not JSON or has none. */
  incidentCount: number | null
  /** status.json's `status.indicator`, only when it is one of Rootly's four documented words. */
  indicator: string | null
  raw: string | null
}

const INDICATORS = new Set(['none', 'minor', 'major', 'maintenance'])

export async function readPublicApi(path: string, doFetch: PublicApiFetch = fetchWithTimeout): Promise<PublicApiResult> {
  let res: Response
  try {
    res = await doFetch(`${MISTRAL_PUBLIC_API_BASE}/${path}`, TIMEOUT_MS, { headers: HEADERS })
  } catch {
    return { outcome: 'error', httpStatus: 0, incidentCount: null, indicator: null, raw: null }
  }
  const httpStatus = res.status
  if (res.headers.get('cf-mitigated')) return { outcome: 'challenged', httpStatus, incidentCount: null, indicator: null, raw: null }
  if (!res.ok) return { outcome: 'non-200', httpStatus, incidentCount: null, indicator: null, raw: null }
  let text: string
  try {
    text = await res.text()
  } catch {
    return { outcome: 'error', httpStatus, incidentCount: null, indicator: null, raw: null }
  }
  let json: { incidents?: unknown; status?: { indicator?: unknown } }
  try {
    json = JSON.parse(text)
  } catch {
    return { outcome: 'not-json', httpStatus, incidentCount: null, indicator: null, raw: null }
  }
  const indicator = typeof json?.status?.indicator === 'string' && INDICATORS.has(json.status.indicator)
    ? json.status.indicator : null
  return {
    outcome: 'ok',
    httpStatus,
    incidentCount: Array.isArray(json?.incidents) ? json.incidents.length : null,
    indicator,
    raw: text.slice(0, RAW_MAX_CHARS),
  }
}

export function listsAnIncident(status: PublicApiResult, incidents: PublicApiResult): boolean {
  return (status.incidentCount ?? 0) > 0 || (incidents.incidentCount ?? 0) > 0
}

/** Keeps the latest payload that listed an incident, and rewrites the key only when its content changed. */
export async function recordPublicApiSample(
  kv: KVNamespace | undefined,
  status: PublicApiResult,
  incidents: PublicApiResult,
  nowIso: string,
): Promise<'skipped' | 'unchanged' | 'written'> {
  if (!kv || !listsAnIncident(status, incidents)) return 'skipped'
  const next = { statusJson: status.raw, incidentsJson: incidents.raw }
  const prior = await kv.get(MISTRAL_PUBLIC_SAMPLE_KV_KEY)
  if (prior) {
    try {
      const p = JSON.parse(prior) as { statusJson?: unknown; incidentsJson?: unknown }
      if (p.statusJson === next.statusJson && p.incidentsJson === next.incidentsJson) return 'unchanged'
    } catch { /* a corrupt prior value is simply replaced */ }
  }
  await kv.put(MISTRAL_PUBLIC_SAMPLE_KV_KEY, JSON.stringify({ capturedAt: nowIso, ...next }), { expirationTtl: MISTRAL_PUBLIC_SAMPLE_TTL_S })
  return 'written'
}

export function recordPublicApiObservation(
  analytics: AnalyticsEngineDataset | undefined,
  status: PublicApiResult,
  incidents: PublicApiResult,
): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint({
      // blob1 source, blob2/3 outcome per endpoint, blob4 status.json indicator; all fixed vocabularies.
      blobs: [MISTRAL_PUBLIC_API_SOURCE, status.outcome, incidents.outcome, status.indicator ?? 'unknown'],
      // count, http status per endpoint, listed incidents per endpoint (-1 = not readable).
      doubles: [1, status.httpStatus, incidents.httpStatus, status.incidentCount ?? -1, incidents.incidentCount ?? -1],
      indexes: [MISTRAL_PUBLIC_API_INDEX],
    })
  } catch (err) {
    console.warn('[wae] mistral-public-api write failed:', err instanceof Error ? err.message : err)
  }
}

/** One cron cycle. Best-effort: nothing here may affect the cycle or any served value. */
export async function runMistralPublicApiProbe(
  env: { STATUS_CACHE?: KVNamespace; ANALYTICS?: AnalyticsEngineDataset },
  nowIso: string,
  doFetch: PublicApiFetch = fetchWithTimeout,
): Promise<void> {
  try {
    const [status, incidents] = await Promise.all([readPublicApi('status.json', doFetch), readPublicApi('incidents.json', doFetch)])
    recordPublicApiObservation(env.ANALYTICS, status, incidents)
    await recordPublicApiSample(env.STATUS_CACHE, status, incidents, nowIso)
  } catch (err) {
    console.warn('[cron] mistral public api probe failed:', err instanceof Error ? err.message : err)
  }
}

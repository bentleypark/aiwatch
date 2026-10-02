/**
 * #1510 Slice 1 (instrumentation) + Slice 2 (active-incident overlay). Reads Mistral's public Rootly
 * JSON API each cron cycle: whether the Worker's own egress is challenged on these paths (a WAE row
 * per cycle), what a real active-incident payload looks like (the raw responses, kept in KV only
 * while one is listed), and — Slice 2 — the parsed active incidents for `services.ts`'s
 * `readMistralActiveOverlay` to read (`grep -n readMistralActiveOverlay worker/src/services.ts`),
 * ONLY when that scrape feed is unreadable — a READABLE `mistral:feed` always takes priority.
 */
import type { Incident, TimelineEntry } from './types'
import { mapRootlyStatus, rootlyIncidentTitle } from './parsers/rootly'
import { fetchWithTimeout, formatDuration, kvPut } from './utils'

export const MISTRAL_PUBLIC_API_BASE = 'https://status.mistral.ai/api/v1'
export const MISTRAL_PUBLIC_API_INDEX = 'mistral-public-api'
export const MISTRAL_PUBLIC_API_SOURCE = 'mistral-rootly-public'
export const MISTRAL_PUBLIC_SAMPLE_KV_KEY = 'mistral:public-sample'
export const MISTRAL_PUBLIC_SAMPLE_TTL_S = 30 * 24 * 3600
/** 3 cron cycles — a stalled write (or a stopped cron, #1501) lets the overlay self-clear back to
 *  `unknown` rather than freezing a stale down/degraded badge. */
export const MISTRAL_ACTIVE_OVERLAY_KV_KEY = 'mistral:active-overlay'
export const MISTRAL_ACTIVE_OVERLAY_TTL_S = 15 * 60

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

/** Rootly's four-level vocabulary (`critical` observed live via `npx wrangler kv key get --remote
 *  --namespace-id e49508d80bb144e9a7ff872f2be771a4 mistral:public-sample`, 2026-09-29) — `none` and
 *  an unrecognised word both read as "no impact", the split `grep -n INCIDENT_IO_IMPACT_WEIGHTS
 *  worker/src/parsers/impact-weights.ts` already draws between `critical`/`major` and `minor`. */
const PUBLIC_IMPACT_MAP: Record<string, Incident['impact']> = {
  none: null,
  minor: 'minor',
  major: 'major',
  critical: 'critical',
}

export function mapPublicIncidentImpact(raw: unknown): Incident['impact'] {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  if (key in PUBLIC_IMPACT_MAP) return PUBLIC_IMPACT_MAP[key]
  console.warn('[mistral-public-api] unrecognised incident impact level:', raw)
  return null
}

const INCIDENT_STATUSES = new Set(['investigating', 'identified', 'monitoring', 'resolved'])
const INCIDENT_IMPACTS = new Set(['minor', 'major', 'critical'])

/** Re-validates an `Incident` read back out of `MISTRAL_ACTIVE_OVERLAY_KV_KEY`, the same way
 *  `isStorableRootlyFeed` re-validates the scrape feed (`grep -n "must not be trusted just because
 *  it is stored" worker/src/services.ts`): a value that got into KV some other way — a hand edit, an
 *  older or future writer — must not reach `filterIncidents` untrusted, since a malformed `title`
 *  throws there and the throw is caught upstream as a transient fetch failure, which can publish a
 *  green `operational` pill instead of `unknown`. */
export function isStorableOverlayIncident(x: unknown): x is Incident {
  if (!x || typeof x !== 'object') return false
  const i = x as Record<string, unknown>
  return typeof i.id === 'string' && i.id.length > 0
    && typeof i.title === 'string' && i.title.length > 0
    && typeof i.status === 'string' && INCIDENT_STATUSES.has(i.status)
    && (i.impact === null || (typeof i.impact === 'string' && INCIDENT_IMPACTS.has(i.impact)))
    && typeof i.startedAt === 'string' && Number.isFinite(Date.parse(i.startedAt))
    && (i.resolvedAt === null || i.resolvedAt === undefined || typeof i.resolvedAt === 'string')
    && (i.duration === null || i.duration === undefined || typeof i.duration === 'string')
    && Array.isArray(i.timeline)
}

interface RawPublicIncidentUpdate {
  status?: unknown
  body?: unknown
  display_at?: unknown
  created_at?: unknown
}

interface RawPublicIncident {
  id?: unknown
  name?: unknown
  status?: unknown
  impact?: unknown
  started_at?: unknown
  resolved_at?: unknown
  incident_updates?: unknown
}

/** `incidents.json`'s `incidents` array → our `Incident[]`. Every field here is a real ISO timestamp,
 *  unlike the scrape's English prose (`grep -n "sends timestamps VERBATIM" worker/src/parsers/rootly.ts`)
 *  — so only defensive shape checks are needed, no prose-timestamp parser. An entry missing an id,
 *  parseable start, or any usable title (see `rootlyIncidentTitle` below) is dropped and counted
 *  rather than published half-formed. */
export function parsePublicActiveIncidents(rawText: string | null): { incidents: Incident[]; dropped: number; parseFailed: boolean } {
  if (!rawText) return { incidents: [], dropped: 0, parseFailed: true }
  let json: { incidents?: unknown }
  try {
    json = JSON.parse(rawText)
  } catch {
    // `readPublicApi` (`grep -n "raw: text.slice" worker/src/mistral-public-api.ts`) truncates `raw`
    // to RAW_MAX_CHARS AFTER deciding `outcome: 'ok'` off the full body, so an over-sized real payload
    // reaches here truncated despite an `ok` outcome. `parseFailed` lets the caller tell that apart
    // from a page that genuinely lists none.
    return { incidents: [], dropped: 0, parseFailed: true }
  }
  const list = Array.isArray(json?.incidents) ? (json.incidents as RawPublicIncident[]) : []
  const incidents: Incident[] = []
  let dropped = 0
  for (const raw of list) {
    const id = typeof raw.id === 'string' && raw.id ? raw.id : null
    const startedMs = typeof raw.started_at === 'string' ? Date.parse(raw.started_at) : NaN
    if (!id || !Number.isFinite(startedMs)) { dropped++; continue }
    const resolvedMs = typeof raw.resolved_at === 'string' ? Date.parse(raw.resolved_at) : NaN
    const resolvedAt = Number.isFinite(resolvedMs) ? resolvedMs : null

    const timeline: TimelineEntry[] = []
    for (const u of Array.isArray(raw.incident_updates) ? (raw.incident_updates as RawPublicIncidentUpdate[]) : []) {
      const stage = mapRootlyStatus(String(u.status ?? ''))
      const atRaw = typeof u.display_at === 'string' ? u.display_at : (typeof u.created_at === 'string' ? u.created_at : null)
      const at = atRaw != null ? Date.parse(atRaw) : NaN
      if (stage == null || !Number.isFinite(at)) continue
      timeline.push({ stage, text: typeof u.body === 'string' ? u.body : null, at: new Date(at).toISOString() })
    }
    timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

    // #1510 round 8 review finding: Mistral has published untitled active incidents (`b0a485d8`,
    // `9923dbd8` — #1471). `title.trim()` alone dropped a real, impactful, in-scope incident with no
    // trace. `rootlyIncidentTitle` (the SAME fallback the scrape path already relies on for this exact
    // shape — `grep -n "export function rootlyIncidentTitle" worker/src/parsers/rootly.ts`) derives a
    // title from the first update's body when the raw title is empty, and only returns null when
    // there is truly nothing usable.
    const title = rootlyIncidentTitle(typeof raw.name === 'string' ? raw.name : '', timeline)
    if (title == null) { dropped++; continue }

    const status = mapRootlyStatus(String(raw.status ?? '')) ?? (resolvedAt != null ? 'resolved' : 'investigating')
    incidents.push({
      id,
      title,
      status,
      impact: mapPublicIncidentImpact(raw.impact),
      startedAt: new Date(startedMs).toISOString(),
      resolvedAt: resolvedAt != null ? new Date(resolvedAt).toISOString() : null,
      duration: resolvedAt != null ? formatDuration(new Date(startedMs), new Date(resolvedAt)) : null,
      timeline,
    })
  }
  return { incidents, dropped, parseFailed: false }
}

/** Stores the parsed active-incident list for `services.ts` to read when the scrape feed is absent.
 *  Only a successful, parseable read overwrites the key — a transient fetch/parse failure leaves the
 *  prior value in place (it ages out via the short TTL) rather than erasing a real reading.
 *
 *  Takes `Pick<PublicApiResult, 'outcome' | 'raw'>`, not the full result, ON PURPOSE: `PublicApiResult`
 *  also carries `indicator` (status.json's page-wide word — `grep -n "indicator: string" worker/src/mistral-public-api.ts`),
 *  and excluding it from this signature makes `incidents.indicator` a compile error inside this function,
 *  whatever gets passed in at the call site. */
export async function recordActiveIncidentsOverlay(
  kv: KVNamespace | undefined,
  incidents: Pick<PublicApiResult, 'outcome' | 'raw'>,
): Promise<void> {
  if (!kv || incidents.outcome !== 'ok') return
  const parsed = parsePublicActiveIncidents(incidents.raw)
  if (parsed.parseFailed) return
  if (parsed.dropped > 0) {
    console.warn(`[mistral-public-api] active-overlay write: dropped ${parsed.dropped} unpublishable incident(s) this cycle`)
  }
  await kvPut(kv, MISTRAL_ACTIVE_OVERLAY_KV_KEY, JSON.stringify(parsed.incidents), { expirationTtl: MISTRAL_ACTIVE_OVERLAY_TTL_S })
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

/** One cron cycle. Best-effort for the WAE/sample instrumentation; `recordActiveIncidentsOverlay`
 *  is the one write `services.ts` reads from when the scrape feed is absent (Slice 2). */
export async function runMistralPublicApiProbe(
  env: { STATUS_CACHE?: KVNamespace; ANALYTICS?: AnalyticsEngineDataset },
  nowIso: string,
  doFetch: PublicApiFetch = fetchWithTimeout,
): Promise<void> {
  try {
    const [status, incidents] = await Promise.all([readPublicApi('status.json', doFetch), readPublicApi('incidents.json', doFetch)])
    recordPublicApiObservation(env.ANALYTICS, status, incidents)
    await recordPublicApiSample(env.STATUS_CACHE, status, incidents, nowIso)
    await recordActiveIncidentsOverlay(env.STATUS_CACHE, incidents)
  } catch (err) {
    console.warn('[cron] mistral public api probe failed:', err instanceof Error ? err.message : err)
  }
}

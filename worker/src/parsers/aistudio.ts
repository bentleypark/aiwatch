// Google AI Studio / Gemini API Status Parser (#310)
// Source: aistudio.google.com/status (MakerSuite gRPC-web endpoint).
// Fixture / shape verification: worker/src/parsers/__tests__/fixtures/aistudio-sample.json
// Tests under worker/src/parsers/__tests__/aistudio.test.ts lock the enum mapping.

import type { TimelineEntry, Incident, DailyImpactLevel, ServiceComponent } from '../types'
import { formatDuration } from '../utils'

// Public API key extracted from the aistudio.google.com/status JS bundle. The
// endpoint rejects callers without Referer: https://aistudio.google.com/ (HTTP
// 403 "Method doesn't allow unregistered callers"). If Google rotates this key
// or starts returning 401/403 consistently, re-harvest by loading
// aistudio.google.com/status in a browser devtools Network tab and copying the
// X-Goog-Api-Key header off the ListIncidentsHistory POST.
export const AISTUDIO_API_KEY = 'AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs'
export const AISTUDIO_ENDPOINT =
  'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListIncidentsHistory'

export const AISTUDIO_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json+protobuf',
  'X-Goog-Api-Key': AISTUDIO_API_KEY,
  Referer: 'https://aistudio.google.com/',
  'X-User-Agent': 'grpc-web-javascript/0.1',
}
export const AISTUDIO_BODY = '[]'

// Component enum. API/MULTIMODAL_LIVE/AI_STUDIO values are locked by
// `aistudio.test.ts` fixture assertions — change them and the tests fail.
export const AISTUDIO_COMPONENT = { API: 1, MULTIMODAL_LIVE: 2, AI_STUDIO: 3 } as const
export type AistudioComponent =
  (typeof AISTUDIO_COMPONENT)[keyof typeof AISTUDIO_COMPONENT]

// Proto-as-array entry shapes
type UpdateEntry = [number, string, readonly [string], string]
type IncidentEntry = [string, string, number, UpdateEntry[], number, number[]]

// Plausible unix-seconds range: 2001-09-09 → 2096-10-02. Values outside this
// window are almost always a unit mistake (ms vs s) or a corrupted field.
const UNIX_SECONDS_MIN = 1_000_000_000
const UNIX_SECONDS_MAX = 4_000_000_000

// Max descent depth for the proto wrapper. Observed shape is [[[entries]]] so
// 3 suffices; keep 4 as slack. Increase only after re-verifying the fixture.
const MAX_UNWRAP_DEPTH = 4

function mapStage(updateType: number): TimelineEntry['stage'] | null {
  // 1=Detected, 2=Identified, 3=Monitoring/Update, 4=Resolved, 5=Mitigation update
  if (updateType === 1) return 'investigating'
  if (updateType === 2) return 'identified'
  if (updateType === 3 || updateType === 5) return 'monitoring'
  if (updateType === 4) return 'resolved'
  return null
}

function mapImpact(severity: number): Incident['impact'] {
  if (severity === 1) return 'minor'
  if (severity === 2) return 'major'
  if (severity !== 0 && severity != null) {
    console.warn(`[aistudio] unknown severity=${severity} — mapping to null impact`)
  }
  return null
}

function extractUnixTimestamp(u: UpdateEntry, incidentId?: string): string | null {
  const ts = u[2]?.[0]
  if (!ts) return null
  const num = Number(ts)
  if (!Number.isFinite(num)) {
    console.warn(`[aistudio] non-finite timestamp=${ts} in incident=${incidentId ?? '?'}`)
    return null
  }
  if (num < UNIX_SECONDS_MIN || num > UNIX_SECONDS_MAX) {
    console.warn(
      `[aistudio] timestamp=${num} out of plausible range [${UNIX_SECONDS_MIN},${UNIX_SECONDS_MAX}] ` +
        `in incident=${incidentId ?? '?'} — likely ms/s unit drift`,
    )
    return null
  }
  return new Date(num * 1000).toISOString()
}

function unwrap(data: unknown): IncidentEntry[] {
  let node: unknown = data
  for (let i = 0; i < MAX_UNWRAP_DEPTH; i++) {
    if (!Array.isArray(node)) return []
    if (node.length > 0 && Array.isArray(node[0]) && typeof (node[0] as unknown[])[0] === 'string') {
      return node as IncidentEntry[]
    }
    node = node[0]
  }
  // Non-empty response but descent failed → schema drift, surface it.
  if (Array.isArray(data) && data.length > 0) {
    console.warn(
      `[aistudio] unwrap exhausted MAX_UNWRAP_DEPTH=${MAX_UNWRAP_DEPTH} on non-empty response — shape drift?`,
    )
  }
  return []
}

export interface ParseAistudioOptions {
  // Restrict incidents to those affecting at least one of these components.
  // Use AISTUDIO_COMPONENT values (e.g. [AISTUDIO_COMPONENT.API]).
  componentFilter?: AistudioComponent[]
  // Prefix applied to incident IDs for cross-source dedup (default: 'aistudio:').
  idPrefix?: string
}

// aistudio has no uptime/impact RPC — UI renders its 90-day bar client-side from
// the incident list. Mirror that here so gemini's 30-day calendar shows real
// impact bars instead of the fallback binary ok/incident markers.
// Drops incidents shorter than 10 min (matches the incident.io calendar
// convention in parseIncidentIoComponentImpacts for visual consistency).
export function computeDailyImpactFromIncidents(
  incidents: Incident[],
  calendarDays = 30,
  now: Date = new Date(),
): Record<string, DailyImpactLevel> {
  const result: Record<string, DailyImpactLevel> = {}
  const rank: Record<DailyImpactLevel, number> = { minor: 1, major: 2, critical: 3 }
  const FLAP_THRESHOLD_MS = 10 * 60_000
  const DAY_MS = 86_400_000

  const windowStart = new Date(now)
  windowStart.setUTCDate(now.getUTCDate() - calendarDays + 1)
  windowStart.setUTCHours(0, 0, 0, 0)

  for (const inc of incidents) {
    const impact = inc.impact
    if (!impact) continue
    const start = new Date(inc.startedAt)
    const end = inc.resolvedAt ? new Date(inc.resolvedAt) : now
    if (isNaN(start.getTime()) || isNaN(end.getTime())) continue
    if (end.getTime() - start.getTime() < FLAP_THRESHOLD_MS) continue

    const iterStart = start < windowStart ? windowStart : start
    const iterEnd = end > now ? now : end
    if (iterStart > iterEnd) continue

    const startDay = new Date(iterStart.toISOString().substring(0, 10)).getTime()
    const endDay = new Date(iterEnd.toISOString().substring(0, 10)).getTime()
    for (let d = startDay; d <= endDay; d += DAY_MS) {
      const key = new Date(d).toISOString().substring(0, 10)
      const existing = result[key]
      if (!existing || rank[impact] > rank[existing]) {
        result[key] = impact
      }
    }
  }
  return result
}

export function parseAistudioIncidents(
  data: unknown,
  opts: ParseAistudioOptions = {},
): Incident[] {
  const entries = unwrap(data)
  const { componentFilter, idPrefix = 'aistudio:' } = opts

  return entries.flatMap<Incident>((entry) => {
    const rawId = entry?.[0]
    try {
      const [, title, severity, updates, , components] = entry
      if (!Array.isArray(updates) || updates.length === 0) return []

      if (componentFilter) {
        if (!components?.length) {
          // No components = cannot verify API scope. Drop rather than fall
          // through, otherwise Multimodal Live / AI Studio UI shape drift
          // would contaminate gemini status.
          console.warn(`[aistudio] incident=${rawId} has empty components — excluded by filter`)
          return []
        }
        const overlap = components.some((c) => (componentFilter as number[]).includes(c))
        if (!overlap) return []
      }

      // Normalize update order (fixture ships oldest→newest; defend against drift).
      const sorted = [...updates].sort((a, b) => {
        const ta = Number(a?.[2]?.[0] ?? 0)
        const tb = Number(b?.[2]?.[0] ?? 0)
        return ta - tb
      })

      // Unknown updateType inherits the previous stage so a new Google enum
      // value can never silently mark an incident resolved.
      let lastKnownStage: TimelineEntry['stage'] = 'investigating'
      const timeline: TimelineEntry[] = sorted.flatMap((u) => {
        const at = extractUnixTimestamp(u, rawId)
        if (!at) return []
        const stage = mapStage(u[0]) ?? lastKnownStage
        lastKnownStage = stage
        return [{ stage, text: (u[3] || '').trim().substring(0, 500) || null, at }]
      })
      if (timeline.length === 0) return []

      const startedAt = timeline[0].at
      const last = timeline[timeline.length - 1]
      const isResolved = last.stage === 'resolved'
      const resolvedAt = isResolved ? last.at : null
      const duration =
        resolvedAt && startedAt ? formatDuration(new Date(startedAt), new Date(resolvedAt)) : null

      return [
        {
          id: `${idPrefix}${rawId}`,
          title,
          status: last.stage,
          impact: mapImpact(severity),
          startedAt,
          resolvedAt,
          duration,
          timeline,
          // #1012 — carry the raw AISTUDIO_COMPONENT tags (stringified) so a downstream transform
          // (synthesizeAistudioComponents) can attribute active incidents to API vs Multimodal Live
          // without re-parsing the raw entries. Mirrors the incident.io componentIds precedent
          // (attachIncidentIoComponentIds) — never write an empty array.
          ...(components?.length ? { componentIds: components.map(String) } : {}),
        },
      ]
    } catch (err) {
      console.warn(
        `[aistudio] entry parse failed id=${rawId}:`,
        err instanceof Error ? err.message : err,
      )
      return []
    }
  })
}

// #1012 — the two AISTUDIO_COMPONENT surfaces gemini's breakdown discloses. AI Studio (enum 3) is
// deliberately excluded here — it's the web build IDE, not an API surface (see issue #1012 scope).
const AISTUDIO_BREAKDOWN_COMPONENTS: ReadonlyArray<{ id: 'API' | 'MULTIMODAL_LIVE'; slug: string; name: string }> = [
  { id: 'API', slug: 'api', name: 'API' },
  { id: 'MULTIMODAL_LIVE', slug: 'multimodal-live', name: 'Multimodal Live API' },
]

/**
 * #1012 — synthesize a `ServiceComponent[]` breakdown from the incident list, since aistudio has no
 * dedicated component-status endpoint (only ListIncidentsHistory, incident-derived). Mirrors
 * `deriveAwsStatus`'s (`parsers/aws.ts`) worst-of-active-incidents structure exactly, including its
 * null-impact handling: `status !== 'resolved'` alone decides "active" (an unclassifiable severity —
 * `mapImpact`'s null, e.g. an unrecognized enum — still counts, same as AWS's unmatched-title case),
 * and only the top severity escalates to `down`. `mapImpact` above caps at `'major'` (severity 2) —
 * aistudio has no `'critical'` tier — so `'major'` is that top severity here, not `'critical'`.
 *
 * Reads `Incident.componentIds` (stamped by `parseAistudioIncidents` above) — incidents from other
 * sources (e.g. vertex/gcloud, merged in by `mergeAistudioIncidents`) carry no `componentIds` and so
 * never match here, no filtering needed on the caller's side.
 */
export function synthesizeAistudioComponents(incidents: Incident[]): ServiceComponent[] {
  return AISTUDIO_BREAKDOWN_COMPONENTS.map(({ id, slug, name }) => {
    const tag = String(AISTUDIO_COMPONENT[id])
    const active = incidents.filter(
      (inc) => inc.status !== 'resolved' && (inc.componentIds ?? []).includes(tag),
    )
    const hasMajor = active.some((inc) => inc.impact === 'major')
    const status: ServiceComponent['status'] =
      active.length === 0 ? 'operational' : hasMajor ? 'down' : 'degraded'
    return { id: `aistudio-${slug}`, name, status }
  })
}

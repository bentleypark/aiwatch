// Cloudflare Status public v3 API parser.
//
// This is intentionally not adapted into the Atlassian Statuspage parser. Cloudflare's public
// endpoint has a different envelope and its global page contains incidents for unrelated
// products, so a title match would attribute another Cloudflare outage to Replicate.

import type { Incident, TimelineEntry } from '../types'
import { formatDuration } from '../utils'

export type CloudflareStatusParseFailure =
  | 'cloudflare-envelope-unreadable'
  | 'cloudflare-components-unreadable'
  | 'cloudflare-component-missing'
  | 'cloudflare-component-status-unreadable'
  | 'cloudflare-incident-unreadable'

type ComponentStatus = 'operational' | 'degraded' | 'down'

interface CloudflareComponent {
  id: string
  name: string
  status: string
}

interface CloudflareStatusSummary {
  components: CloudflareComponent[]
  status: ComponentStatus
  incidents: Incident[]
}

export type CloudflareStatusParseResult =
  | { ok: true; summary: CloudflareStatusSummary }
  | { ok: false; reason: CloudflareStatusParseFailure }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeComponentStatus(value: string): ComponentStatus | null {
  switch (value) {
    case 'operational': return 'operational'
    case 'degraded_performance':
    case 'partial_outage': return 'degraded'
    // Announced maintenance is not a live outage, which is the rule every other source here already
    // follows: `statuspage.ts` has no case for it (→ `operational`), `incident-io.ts` weights it 0
    // and defaults it to `operational`, `flashduty.ts` maps it to `operational`, `impact-weights.ts`
    // scores it 0 ("planned maintenance is not downtime"), and CLAUDE.md states the same for uptime.
    // Diverging would make a scheduled Cloudflare window answer "yes" on /is-replicate-down, fire a
    // status-edge Discord alert, and pull fallback recommendations — the live summary carries
    // `active_maintenances` entries, so this is a reachable state, not a corner.
    case 'under_maintenance': return 'operational'
    case 'major_outage':
    case 'critical': return 'down'
    default: return null
  }
}

function worstStatus(statuses: ComponentStatus[]): ComponentStatus {
  if (statuses.includes('down')) return 'down'
  if (statuses.includes('degraded')) return 'degraded'
  return 'operational'
}

function incidentStage(value: string): TimelineEntry['stage'] {
  if (value === 'resolved') return 'resolved'
  if (value === 'monitoring') return 'monitoring'
  if (value === 'identified') return 'identified'
  return 'investigating'
}

function incidentImpact(value: string): Incident['impact'] {
  if (value === 'critical') return 'critical'
  if (value === 'major') return 'major'
  if (value === 'minor') return 'minor'
  return null
}

/**
 * `'unreadable'` and `'not-ours'` are deliberately different answers.
 *
 * Both used to be `null`, and the caller dropped both — so an entry whose `impact` was renamed or
 * absent vanished silently and the service published `operational` with an empty incident list while
 * an outage was posted. That is the one path in this parser that failed toward "no downtime"; the
 * component path already fails toward `unreadable` for exactly the same class of drift, and this now
 * matches it.
 *
 * ATTRIBUTION IS DECIDED FIRST, and the order is the whole point. This page carries 472 components
 * and exactly one of them is ours. A first version checked shape first, so a renamed field on any
 * unrelated Cloudflare product refused the whole Replicate read — and the wiring's failure ramp
 * publishes `operational` with no incidents for two cycles before it reaches `unknown`, which is the
 * same fail-open this function exists to close, reached by a different road. An entry we cannot
 * attribute is not ours to judge: `'unreadable'` is reserved for entries that ARE ours.
 */
type IncidentRead = Incident | 'not-ours' | 'unreadable'

function parseIncidentEntry(value: unknown, componentIds: Set<string>): IncidentRead {
  // Attribution first, on the minimum needed to answer "is this ours" — and a shape too broken to
  // answer that with is not ours either. `components` is the provider's own attribution; a title can
  // mention Replicate while describing Cloudflare customers that use it, so it is never a fallback.
  //
  // Attribution needs ONLY `id` — it is the key `componentIds` is keyed on, and `name` is display-only.
  // A first version required both, filtering the components array down to entries carrying a string
  // `name` before checking any id against `componentIds`. That made a renamed/missing `name` on the
  // ONE matching component invisible to the id check too — an incident correctly attributed by id
  // (`{ id: 'fvgfcmy66tdr', display_name: 'Replicate' }`) filtered out before its id was ever tested,
  // read back as 'not-ours', and published as a silent drop: `ok: true, incidents: []`. Same fail-open
  // this function exists to close, reached by requiring a field attribution never needed.
  if (!isRecord(value) || !Array.isArray(value.components)) return 'not-ours'
  const rawComponents = value.components.filter(isRecord)
  const attributedIds = rawComponents
    .map((component) => (typeof component.id === 'string' ? component.id : null))
    .filter((id): id is string => id !== null)
  if (!attributedIds.some((id) => componentIds.has(id))) return 'not-ours'

  // Ours. NOW a missing or retyped field is a read we lost, and the caller refuses rather than
  // publish a shorter list — which downstream is indistinguishable from a quiet period.
  if (typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.status !== 'string'
    || typeof value.impact !== 'string'
    || typeof value.created_at !== 'string') return 'unreadable'

  // Display shape (componentNames/componentIds below) still wants both fields per entry — that's
  // cosmetic, not attribution, so a component missing `name` here is dropped from the display list
  // without affecting whether this incident was ours to read at all.
  const components = rawComponents.filter((component): component is { id: string; name: string } =>
    typeof component.id === 'string' && typeof component.name === 'string',
  )

  const update = isRecord(value.last_update) ? value.last_update : null
  const updateAt = update && typeof update.display_at === 'string' ? update.display_at
    : update && typeof update.created_at === 'string' ? update.created_at
      : value.created_at
  const updateStatus = update && typeof update.status === 'string' ? update.status : value.status
  const updateMessage = update && typeof update.message === 'string' ? update.message : null
  const startedAt = typeof value.starts_at === 'string' ? value.starts_at : value.created_at
  const resolvedAt = typeof value.resolved_at === 'string' ? value.resolved_at : null

  return {
    id: `cloudflare:${value.id}`,
    title: value.name,
    status: incidentStage(value.status),
    impact: incidentImpact(value.impact),
    componentNames: components.map((component) => component.name),
    componentIds: components.map((component) => component.id),
    startedAt,
    resolvedAt,
    duration: resolvedAt ? formatDuration(new Date(startedAt), new Date(resolvedAt)) : null,
    timeline: [{ stage: incidentStage(updateStatus), text: updateMessage, at: updateAt }],
  }
}

/**
 * Parse the public Cloudflare Status v3 `/api/v3/summary` envelope for a declared component set.
 *
 * Reads BOTH `active_incidents` and `recent_incidents`, attributed by component id in either case.
 * Reading only the active list looked right — AIWatch's pre-migration records are the historical
 * source and v3's history starts at migration, so there is nothing to backfill — but it conflated
 * "do not import old incidents" with "do not observe a resolution". Cloudflare moves an incident out
 * of `active_incidents` the moment it resolves, and active entries carry no `resolved_at` at all, so
 * the five-minute cron could never see a terminal state: every Replicate incident would stay open forever,
 * contribute 0 downtime minutes to every monthly archive, never fire a recovery notice, and — once
 * `retainIncidentHistoryUntil` lapsed — be pruned as a phantom and announced as a provider
 * WITHDRAWAL, which is a false claim about a thread that simply ended.
 *
 * The backfill worry does not survive the component filter: `recent_incidents` is Cloudflare-wide
 * and shallow (~10 entries across every component on the page), and only those naming a configured
 * component id are kept.
 */
export function parseCloudflareStatusSummary(raw: unknown, componentIds: string[]): CloudflareStatusParseResult {
  if (!isRecord(raw) || raw.success !== true || !isRecord(raw.result)) {
    return { ok: false, reason: 'cloudflare-envelope-unreadable' }
  }
  const result = raw.result
  if (!Array.isArray(result.components) || !Array.isArray(result.active_incidents)) {
    return { ok: false, reason: 'cloudflare-components-unreadable' }
  }
  // Optional on purpose: a payload without it is still usable for the active side, and refusing the
  // whole read over a missing history list would trade a smaller loss for a larger one.
  const recent = Array.isArray(result.recent_incidents) ? result.recent_incidents : []
  const configured = new Set(componentIds)
  const components = result.components.filter((component): component is CloudflareComponent =>
    isRecord(component)
      && typeof component.id === 'string'
      && typeof component.name === 'string'
      && typeof component.status === 'string'
      && configured.has(component.id),
  )
  if (components.length !== configured.size) return { ok: false, reason: 'cloudflare-component-missing' }

  const statuses = components.map((component) => normalizeComponentStatus(component.status))
  if (statuses.some((status) => status == null)) {
    return { ok: false, reason: 'cloudflare-component-status-unreadable' }
  }
  // Active first, then the resolved history. Same id space (`cloudflare:<id>`), so an entry that
  // appears in both — the window where Cloudflare has moved it but not yet dropped it — is kept ONCE
  // and the RESOLVED copy wins: it is the one carrying `resolved_at`, and a thread that reopened
  // would come back as a new incident id rather than by mutating this one.
  const byId = new Map<string, Incident>()
  for (const entry of [...result.active_incidents, ...recent]) {
    const inc = parseIncidentEntry(entry, configured)
    // Refuse the whole read rather than publish a shorter list: a dropped incident is
    // indistinguishable downstream from a quiet period, which is the direction this source must
    // never fail in. Same treatment the component path already gives a renamed status word.
    if (inc === 'unreadable') return { ok: false, reason: 'cloudflare-incident-unreadable' }
    if (inc !== 'not-ours') byId.set(inc.id, inc)
  }
  const incidents = [...byId.values()]

  return { ok: true, summary: { components, status: worstStatus(statuses as ComponentStatus[]), incidents } }
}

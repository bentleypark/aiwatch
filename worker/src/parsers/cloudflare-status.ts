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
    case 'partial_outage':
    case 'under_maintenance': return 'degraded'
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

function parseActiveIncident(value: unknown, componentIds: Set<string>): Incident | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.status !== 'string'
    || typeof value.impact !== 'string'
    || typeof value.created_at !== 'string'
    || !Array.isArray(value.components)) return null

  const components = value.components.filter((component): component is { id: string; name: string } =>
    isRecord(component) && typeof component.id === 'string' && typeof component.name === 'string',
  )
  // Component id is the provider's attribution. A title can mention Replicate while describing
  // Cloudflare customers that use it, so it is deliberately never a fallback match.
  if (!components.some((component) => componentIds.has(component.id))) return null

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
 * `recent_incidents` is intentionally excluded: Replicate's v3 history starts at migration, while
 * AIWatch's pre-migration records remain the historical source. This supplies current component
 * health and currently active, exactly-attributed incidents only.
 */
export function parseCloudflareStatusSummary(raw: unknown, componentIds: string[]): CloudflareStatusParseResult {
  if (!isRecord(raw) || raw.success !== true || !isRecord(raw.result)) {
    return { ok: false, reason: 'cloudflare-envelope-unreadable' }
  }
  const result = raw.result
  if (!Array.isArray(result.components) || !Array.isArray(result.active_incidents)) {
    return { ok: false, reason: 'cloudflare-components-unreadable' }
  }
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
  const incidents = result.active_incidents
    .map((incident) => parseActiveIncident(incident, configured))
    .filter((incident): incident is Incident => incident != null)

  return { ok: true, summary: { components, status: worstStatus(statuses as ComponentStatus[]), incidents } }
}

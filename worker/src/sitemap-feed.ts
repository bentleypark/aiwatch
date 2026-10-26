// #887 Phase 3 — per-service "last changed" instants for the Edge sitemap (`api/sitemap.ts`).
// `?src=sitemap` on `/api/status/cached` returns only these, instead of the full snapshot (#1531).
import type { Incident, ServiceStatus } from './types'

export function isSitemapRequest(searchParams: URLSearchParams): boolean {
  return (searchParams.get('src') ?? '') === 'sitemap'
}

type IncidentTimes = Pick<Incident, 'startedAt' | 'resolvedAt' | 'timeline' | 'derived'>

/** The latest instant at which the service's incident list changed: an incident started, posted an
 *  update, or resolved. Null when there is none.
 *  A `derived` row's start and end are an anchor inside its day, not times (types.ts), and an instant
 *  after `nowMs` has not happened yet; neither is counted. */
export function lastChangedAt(incidents: ReadonlyArray<IncidentTimes> | undefined, nowMs: number): string | null {
  let latest = -Infinity
  for (const inc of incidents ?? []) {
    const ends = inc.derived === 'status_history' ? [] : [inc.startedAt, inc.resolvedAt]
    for (const at of [...ends, ...(inc.timeline ?? []).map((t) => t.at)]) {
      const ms = at ? Date.parse(at) : NaN
      if (Number.isFinite(ms) && ms <= nowMs && ms > latest) latest = ms
    }
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null
}

export interface SitemapFeed {
  services: Array<{ id: string; lastChangedAt: string | null }>
}

export function buildSitemapFeed(services: ReadonlyArray<Pick<ServiceStatus, 'id' | 'incidents'>>, nowMs: number): SitemapFeed {
  return { services: services.map((svc) => ({ id: svc.id, lastChangedAt: lastChangedAt(svc.incidents, nowMs) })) }
}

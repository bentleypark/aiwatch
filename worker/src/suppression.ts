// #904 — Operator incident-suppression layer.
//
// A recurring class of problem: an incident is correctly attributed to a service (so it is NOT an
// `incidentExclude` source-attribution case) yet must be un-exposed for an operational/policy reason
// (e.g. OpenAI's FedRAMP "degraded performance" — gov-compliance-scoped, not general-API availability).
// Handling each such case with bespoke code + deploy + archive rebuild is wasteful, so this is a
// general, runtime-editable mechanism: an operator adds a suppression via `POST /api/admin/suppress`
// (no deploy) and it is honored across the live list, the Score, the monthly accumulator, and a
// rebuilt archive.
//
// DESIGN — this is a SEPARATE LAYER applied AFTER `filterIncidents` (source attribution), never a
// change to it. So attribution logic (and e.g. the #693 "openai KEEPS FedRAMP" test) is untouched;
// operator policy (hide) and source attribution stay orthogonal, and removing a suppression restores
// the incident with zero code change.
//
// Two apply points cover everything (see #904):
//   1. `fetchAllServices` return — feeds the live `/api/status` list, `scoreFor`, the go-forward
//      `accumulateMonthlyIncidents`, and the `services:latest` cache in one shot.
//   2. `buildMonthlyArchive` build-time — filters the ALREADY-STORED `incidents:monthly` accumulator
//      so a `rebuild-archive` of a past month drops suppressed incidents (rebuild-safe, no KV surgery).

import type { Incident, ServiceStatus } from './types'

/** KV key holding the operator suppression list (single JSON array, no TTL — permanent policy). */
export const SUPPRESSIONS_KEY = 'incident:suppressions'

/** Hide ONE specific incident by id (ad-hoc one-off). */
export interface IncidentSuppression {
  scope: 'incident'
  incId: string
  reason?: string
  createdAt?: string
  by?: string
}

/** Hide any incident on a service whose title contains `match` (recurring surface; a runtime-editable
 *  `incidentExclude`). e.g. `{ svcId: 'openai', match: 'fedramp' }`. */
export interface ServicePatternSuppression {
  scope: 'service-pattern'
  svcId: string
  match: string
  reason?: string
  createdAt?: string
  by?: string
}

export type SuppressionEntry = IncidentSuppression | ServicePatternSuppression

/** Pure core: is an incident (by id + title) suppressed for the given service? Works off the two
 *  fields both a live `Incident` and a stored monthly-archive entry carry, so the live path and the
 *  build-time archive filter share one predicate. */
export function isSuppressedByIdTitle(
  incId: string,
  title: string,
  svcId: string,
  list: SuppressionEntry[],
): boolean {
  const lower = title.toLowerCase()
  for (const e of list) {
    if (e.scope === 'incident') {
      if (e.incId && incId === e.incId) return true
    } else if (e.scope === 'service-pattern') {
      if (e.svcId === svcId && e.match && lower.includes(e.match.toLowerCase())) return true
    }
  }
  return false
}

/** Pure: is this incident suppressed for the given service under the current list? */
export function isSuppressed(inc: Incident, svcId: string, list: SuppressionEntry[]): boolean {
  return isSuppressedByIdTitle(inc.id, inc.title, svcId, list)
}

/** Pure: return services with suppressed incidents removed from each `.incidents`. Identity-preserving
 *  when nothing is suppressed (avoids needless object churn on the hot path). */
export function applySuppressions(services: ServiceStatus[], list: SuppressionEntry[]): ServiceStatus[] {
  if (!list.length) return services
  return services.map((svc) => {
    const incidents = svc.incidents ?? []
    const kept = incidents.filter((inc) => !isSuppressed(inc, svc.id, list))
    return kept.length === incidents.length ? svc : { ...svc, incidents: kept }
  })
}

/** Pure: validate/normalize a parsed KV value into well-formed entries (drops malformed rows). */
export function normalizeSuppressions(parsed: unknown): SuppressionEntry[] {
  if (!Array.isArray(parsed)) return []
  const out: SuppressionEntry[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    if (e.scope === 'incident' && typeof e.incId === 'string' && e.incId) {
      out.push({
        scope: 'incident',
        incId: e.incId,
        ...pickMeta(e),
      })
    } else if (
      e.scope === 'service-pattern' &&
      typeof e.svcId === 'string' && e.svcId &&
      typeof e.match === 'string' && e.match
    ) {
      out.push({
        scope: 'service-pattern',
        svcId: e.svcId,
        match: e.match,
        ...pickMeta(e),
      })
    }
  }
  return out
}

function pickMeta(e: Record<string, unknown>): { reason?: string; createdAt?: string; by?: string } {
  const meta: { reason?: string; createdAt?: string; by?: string } = {}
  if (typeof e.reason === 'string') meta.reason = e.reason
  if (typeof e.createdAt === 'string') meta.createdAt = e.createdAt
  if (typeof e.by === 'string') meta.by = e.by
  return meta
}

/** Pure: does `a` refer to the same suppression target as `b`? (identity for add-dedup / remove.) */
export function sameSuppressionTarget(a: SuppressionEntry, b: SuppressionEntry): boolean {
  if (a.scope !== b.scope) return false
  if (a.scope === 'incident' && b.scope === 'incident') return a.incId === b.incId
  if (a.scope === 'service-pattern' && b.scope === 'service-pattern') {
    return a.svcId === b.svcId && a.match.toLowerCase() === b.match.toLowerCase()
  }
  return false
}

/** A requested add/remove against the list (the admin endpoint's parsed body). `createdAt`/`by` are
 *  stamped by the caller so the pure mutation stays deterministic/testable. */
export interface SuppressionMutation {
  action: 'add' | 'remove'
  scope: 'incident' | 'service-pattern'
  incId?: string
  svcId?: string
  match?: string
  reason?: string
  by?: string
  createdAt?: string
}

export type MutationResult =
  | { ok: true; list: SuppressionEntry[]; changed: boolean }
  | { ok: false; error: string }

/** Pure: apply an add/remove mutation to a list. Add is idempotent (dedup by target identity, not
 *  metadata); remove drops all entries with the same target. Validates required fields per scope. */
export function mutateSuppressions(list: SuppressionEntry[], m: SuppressionMutation): MutationResult {
  let target: SuppressionEntry
  if (m.scope === 'incident') {
    if (!m.incId) return { ok: false, error: 'incId is required for scope=incident' }
    target = { scope: 'incident', incId: m.incId }
  } else if (m.scope === 'service-pattern') {
    if (!m.svcId || !m.match) return { ok: false, error: 'svcId and match are required for scope=service-pattern' }
    target = { scope: 'service-pattern', svcId: m.svcId, match: m.match }
  } else {
    return { ok: false, error: 'scope must be "incident" or "service-pattern"' }
  }

  if (m.action === 'remove') {
    const next = list.filter((e) => !sameSuppressionTarget(e, target))
    return { ok: true, list: next, changed: next.length !== list.length }
  }
  if (m.action === 'add') {
    if (list.some((e) => sameSuppressionTarget(e, target))) return { ok: true, list, changed: false }
    const meta = { ...(m.reason ? { reason: m.reason } : {}), ...(m.by ? { by: m.by } : {}), ...(m.createdAt ? { createdAt: m.createdAt } : {}) }
    return { ok: true, list: [...list, { ...target, ...meta }], changed: true }
  }
  return { ok: false, error: 'action must be "add" or "remove"' }
}

// Isolate-scoped cache so the hot path (fetchAllServices) reads the small list at most once per
// CACHE_MS instead of on every call. Eventually consistent across isolates (≤ CACHE_MS staleness);
// the admin write path invalidates its own isolate immediately via invalidateSuppressionCache().
let cache: { at: number; list: SuppressionEntry[] } | null = null
const CACHE_MS = 60_000

export function invalidateSuppressionCache(): void {
  cache = null
}

/** Fresh (cache-BYPASSING) read for the rare, correctness-critical read paths that must reflect a
 *  just-added suppression immediately: the archive rebuild, the `/api/report` current-month partial,
 *  and the weekly briefing — all of which read the raw `incidents:monthly` accumulator directly.
 *  Best-effort → [] on absent kv / read / parse error (never breaks the caller). */
export async function readSuppressionsFresh(kv?: KVNamespace): Promise<SuppressionEntry[]> {
  if (!kv) return []
  try {
    const raw = await kv.get(SUPPRESSIONS_KEY)
    return raw ? normalizeSuppressions(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

/** #975 — like `readSuppressionsFresh`, but distinguishes "nothing is suppressed" (`[]`) from "the
 *  list could not be read" (`null`). The sibling collapses both to `[]`, which is right for a caller
 *  that merely HIDES incidents (fail-open shows one too many) and dangerous for one that DELETES them:
 *  the phantom prune must never mistake a KV blip for "no incident is hidden" and erase a suppressed
 *  entry. Callers that destroy data fail CLOSED on `null`. */
/** #1260 — like `readSuppressionsFreshOrNull`, but tells a KV fault apart from a value that is
 *  simply broken. A destructive caller has to fail closed on both, and then say opposite things: a
 *  fault clears on its own, a malformed value never does, so answering "retryable" to the second
 *  leaves the caller retrying forever against something only hand-repair fixes. */
export async function readSuppressionsFreshResult(kv?: KVNamespace): Promise<
  { state: 'ok'; list: SuppressionEntry[] } | { state: 'unreadable' } | { state: 'malformed' }
> {
  if (!kv) return { state: 'unreadable' }
  let raw: string | null
  try {
    raw = await kv.get(SUPPRESSIONS_KEY)
  } catch {
    return { state: 'unreadable' }
  }
  if (raw === null) return { state: 'ok', list: [] }
  try {
    return { state: 'ok', list: normalizeSuppressions(JSON.parse(raw)) }
  } catch {
    return { state: 'malformed' }
  }
}

export async function readSuppressionsFreshOrNull(kv?: KVNamespace): Promise<SuppressionEntry[] | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(SUPPRESSIONS_KEY)
    return raw ? normalizeSuppressions(JSON.parse(raw)) : []
  } catch {
    return null
  }
}

/** Read + parse the suppression list from KV (best-effort, isolate-cached). Returns [] when kv is
 *  absent (tests / callers without KV) or on any read/parse error, so suppression can never break the
 *  status path — a failed read simply falls back to "nothing suppressed" (or the last good cache). */
export async function readSuppressions(kv?: KVNamespace, nowMs: number = Date.now()): Promise<SuppressionEntry[]> {
  if (!kv) return []
  if (cache && nowMs - cache.at < CACHE_MS) return cache.list
  try {
    const raw = await kv.get(SUPPRESSIONS_KEY)
    const list = raw ? normalizeSuppressions(JSON.parse(raw)) : []
    cache = { at: nowMs, list }
    return list
  } catch {
    return cache?.list ?? []
  }
}

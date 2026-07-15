// #1019 — Operator incident duration-OVERRIDE layer.
//
// Sibling of the #904 suppression layer, for a different problem. An incident's `duration` is derived
// from the provider's PAPERWORK timestamps (`resolved_at − created_at`; parsers/statuspage.ts). When a
// provider leaves an incident open long AFTER the affected component actually recovered, that duration
// massively overstates real impact — e.g. Cursor `h71m65my586h` (2026-07-14): IDE went
// `degraded_performance` at 19:52 UTC and was already `operational` well before the formal 09:11 UTC
// resolve, yet our stored duration is 13h 20m (the sibling "- Sol" incident on the same component
// resolved in 18 min — the best proxy for when the shared degradation actually cleared).
//
// Suppression HIDES an incident; an override KEEPS it but PINS its duration to an operator-stated value.
// It corrects the monthly-report duration stats a paperwork-inflated duration distorts
// (`longestIncidentMin`, `totalDowntimeMin`, `avgResolutionMin`, AND the calendar-month `monthlyScore`
// whose MTTR reads the same per-incident durations — #993) and the per-incident duration on the read
// surfaces, WITHOUT deleting the incident (which suppression would). It corrects BOTH `durationMin` AND
// the derived `resolvedAt` (= `startedAt + durationMin`), so timestamp-derived consumers — the grouped-
// incident row duration (`sumGroupDuration`) and the Uptime calendar span — agree with `durationMin`
// rather than still painting the paperwork span.
//
// WHY A DEDICATED MECHANISM, NOT A ONE-OFF KV EDIT: `accumulateMonthlyIncidents` has a MONOTONIC guard
// (`if (dur > oldDur)`) that re-inflates a manually-lowered duration back to the provider value on the
// next cron while the incident is still in the live feed. An override is applied on READ/BUILD instead
// (the same rebuild-safe shape as `filterSuppressedFromMonthly`), so it never fights the accumulator.
//
// APPLY POINTS — the monthly-accumulator read/build paths, right after suppression:
//   1. `buildMonthlyArchive` build-time — corrects a rebuilt/first-built month's archive.
//   2. `/api/report` current-month partial — the dashboard 30/90-day incident list.
//   3. the weekly briefing — reads the raw accumulator directly.
// The live `/api/status` Score is intentionally NOT overridden here: MTTR is median-based for services
// with ≥3 resolved incidents (robust to one outlier), and the going-forward scoring robustness is
// tracked separately (#1019 Part B).

import type { MonthlyIncidents, MonthlyIncidentServiceData } from './monthly-archive'

/** KV key holding the operator duration-override list (single JSON array, no TTL — permanent). */
export const OVERRIDES_KEY = 'incident:duration-overrides'

/** Pin ONE incident's duration (by id) to an operator-stated minute value. */
export interface DurationOverride {
  id: string
  durationMin: number
  reason?: string
  createdAt?: string
  by?: string
}

/** Pure: validate/normalize a parsed KV value into well-formed entries (drops malformed rows). A row
 *  needs a non-empty `id` and a finite `durationMin >= 0` (0 zeroes the incident's downtime, allowed). */
export function normalizeOverrides(parsed: unknown): DurationOverride[] {
  if (!Array.isArray(parsed)) return []
  const out: DurationOverride[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    if (typeof e.id !== 'string' || !e.id) continue
    if (typeof e.durationMin !== 'number' || !Number.isFinite(e.durationMin) || e.durationMin < 0) continue
    const o: DurationOverride = { id: e.id, durationMin: e.durationMin }
    if (typeof e.reason === 'string') o.reason = e.reason
    if (typeof e.createdAt === 'string') o.createdAt = e.createdAt
    if (typeof e.by === 'string') o.by = e.by
    out.push(o)
  }
  return out
}

/** Pure: id → durationMin map for the current list. Last entry wins on a duplicate id. */
export function overrideMap(list: DurationOverride[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const o of list) m.set(o.id, o.durationMin)
  return m
}

/** Pure: return the monthly-accumulator data with overridden incidents' durations PINNED to the
 *  operator value, recomputing each affected service's `totalMinutes`/`longestMinutes` from the
 *  `durations` map (the exact pattern `filterSuppressedFromMonthly` uses) and updating the per-incident
 *  detail: `incidents[].durationMin` (the #915 `aggregateIncidentDurations` source of truth) AND, for an
 *  already-resolved entry with a parseable `startedAt`, `incidents[].resolvedAt = startedAt + durationMin`
 *  so timestamp-derived surfaces (grouped-row duration, uptime calendar span) agree. `count` and
 *  `incidentIds` are unchanged — the incident stays; only its duration is corrected.
 *
 *  Identity-preserving when nothing applies (no needless object churn). Structurally-corrupt input is
 *  returned as-is, mirroring `filterSuppressedFromMonthly`, so a caller outside a try/catch can't throw. */
export function applyDurationOverrides(data: MonthlyIncidents, list: DurationOverride[]): MonthlyIncidents {
  if (!list.length || !data?.services || typeof data.services !== 'object') return data
  const byId = overrideMap(list)
  const services: Record<string, MonthlyIncidentServiceData> = {}
  let anyChange = false
  for (const [svcId, svc] of Object.entries(data.services)) {
    const ids = svc.incidentIds ?? []
    if (!ids.some((id) => byId.has(id))) { services[svcId] = svc; continue }
    anyChange = true
    const durations: Record<string, number> = { ...(svc.durations ?? {}) }
    for (const id of Object.keys(durations)) {
      if (byId.has(id)) durations[id] = byId.get(id)!
    }
    const incidents = (svc.incidents ?? []).map((e) => {
      if (!byId.has(e.id)) return e
      const durationMin = byId.get(e.id)!
      const next = { ...e, durationMin }
      // Keep resolvedAt consistent with the pinned duration so consumers that derive length from
      // `resolvedAt − startedAt` (not `durationMin`) agree. Only for an already-resolved entry with a
      // parseable start — never fabricate a resolution for a still-open incident.
      const startMs = e.startedAt ? Date.parse(e.startedAt) : NaN
      if (e.resolvedAt && !Number.isNaN(startMs)) {
        next.resolvedAt = new Date(startMs + durationMin * 60_000).toISOString()
      }
      return next
    })
    const durationVals = Object.values(durations)
    services[svcId] = {
      ...svc,
      totalMinutes: durationVals.reduce((a, b) => a + b, 0),
      longestMinutes: durationVals.reduce((m, d) => Math.max(m, d), 0),
      durations,
      incidents,
    }
  }
  return anyChange ? { ...data, services } : data
}

// ── Admin mutation (mirrors mutateSuppressions) ──────────────────────────────

export interface OverrideMutation {
  action: 'add' | 'remove'
  id?: string
  durationMin?: number
  reason?: string
  by?: string
  createdAt?: string
}

export type OverrideMutationResult =
  | { ok: true; list: DurationOverride[]; changed: boolean }
  | { ok: false; error: string }

/** Pure: apply an add/remove mutation to the override list. Add is keyed by `id` (re-adding the same id
 *  UPDATES its durationMin/metadata — an override is a correction, so the latest value should win, unlike
 *  a suppression which is idempotent). Remove drops the id. */
export function mutateOverrides(list: DurationOverride[], m: OverrideMutation): OverrideMutationResult {
  if (!m.id) return { ok: false, error: 'id is required' }
  if (m.action === 'remove') {
    const next = list.filter((e) => e.id !== m.id)
    return { ok: true, list: next, changed: next.length !== list.length }
  }
  if (m.action === 'add') {
    if (typeof m.durationMin !== 'number' || !Number.isFinite(m.durationMin) || m.durationMin < 0) {
      return { ok: false, error: 'durationMin must be a finite number >= 0' }
    }
    const entry: DurationOverride = {
      id: m.id,
      durationMin: m.durationMin,
      ...(m.reason ? { reason: m.reason } : {}),
      ...(m.by ? { by: m.by } : {}),
      ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    }
    const existing = list.find((e) => e.id === m.id)
    const next = existing ? list.map((e) => (e.id === m.id ? entry : e)) : [...list, entry]
    const changed = !existing || existing.durationMin !== entry.durationMin || existing.reason !== entry.reason
    return { ok: true, list: next, changed }
  }
  return { ok: false, error: 'action must be "add" or "remove"' }
}

/** Fresh (uncached) read of the override list from KV — the apply sites are the rare, correctness-
 *  critical archive-build / report-partial / weekly-briefing reads (same callers as
 *  `readSuppressionsFresh`). Best-effort → [] on absent kv / read / parse error (never breaks caller). */
export async function readOverridesFresh(kv?: KVNamespace): Promise<DurationOverride[]> {
  if (!kv) return []
  try {
    const raw = await kv.get(OVERRIDES_KEY)
    return raw ? normalizeOverrides(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

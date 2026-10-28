// #1831 — per-page projections of the lean /api/status/cached payload. The Edge is-down pages read one
// of these instead of the whole payload; the rank and the fallbacks are computed here, once.

import { CAPABILITY_LABEL, routedCapability, selectFallbacks, type FallbackCandidate } from './fallback'

export type StatusView =
  | { kind: 'is-down'; id: string }
  | { kind: 'is-down-group'; ids: string[]; statusIds: string[] }

/** `?view=is-down&id=<svc>` or `?view=is-down-group&ids=<a,b>&status=<c,d>`; anything else is no view. */
export function parseStatusView(params: URLSearchParams): StatusView | null {
  const list = (key: string) => (params.get(key) ?? '').split(',').filter(Boolean)
  switch (params.get('view')) {
    case 'is-down': {
      const id = params.get('id')
      return id ? { kind: 'is-down', id } : null
    }
    case 'is-down-group': {
      const ids = list('ids')
      return ids.length > 0 ? { kind: 'is-down-group', ids, statusIds: list('status') } : null
    }
    default:
      return null
  }
}

export interface ViewService extends FallbackCandidate {
  coverageDays?: number
}

export interface LeanStatusPayload<S extends ViewService = ViewService> {
  services: S[]
  lastUpdated: string
  cached: boolean
  aiAnalysis?: Record<string, unknown[]>
  supplyChainBanner?: unknown
  upstreamLinks?: unknown[]
  recoveryBaseline?: Record<string, unknown>
}

// #787 — competition ranking by ROUNDED score: tied services share the first position.
export function computeRankPosition(
  scoredDesc: Array<{ aiwatchScore: number }>,
  targetScore: number,
): { rank: number; tied: boolean; total: number } {
  const rounded = scoredDesc.map((s) => Math.round(s.aiwatchScore))
  const rank = rounded.findIndex((s) => s === targetScore) + 1 // 0 = not found (caller guards rank > 0)
  const tied = rounded.filter((s) => s === targetScore).length > 1
  return { rank, tied, total: scoredDesc.length }
}

// Per-isolate dedup, so a persistent data problem logs once per isolate instead of once per request.
const warnedUnranked = new Set<string>()
const warnedNonFinite = new Set<string>()

/** The target's place among the services it is comparable with, or null when it is not ranked.
 *  Mirrors the Ranking page (src/utils/serviceReliability.js): a live feed, a `high`/`medium` score and
 *  30+ days of coverage (#713/#802), ranked within its own confidence tier only (#1186). */
export function rankInTier(
  services: ViewService[],
  target: ViewService,
): { rank: number; rankTied: boolean; totalRanked: number } | null {
  if (!Number.isFinite(target.aiwatchScore)) {
    if (target.aiwatchScore != null) console.error(`[status-view] ${target.id} aiwatchScore is not finite:`, target.aiwatchScore)
    return null
  }
  const hasReliableData = (s: ViewService) =>
    !s.incidentSourceStale && s.scoreConfidence !== 'low' && (s.coverageDays == null || s.coverageDays >= 30)
  if (!hasReliableData(target) || (target.scoreConfidence !== 'high' && target.scoreConfidence !== 'medium')) {
    if (!warnedUnranked.has(target.id)) {
      warnedUnranked.add(target.id)
      console.warn(`[status-view] ${target.id} is not ranked (low or unrecognized scoreConfidence, stale incident source, or under 30 days of coverage)`)
    }
    return null
  }
  const dropped = services.filter((s) => s.aiwatchScore != null && !Number.isFinite(s.aiwatchScore))
  if (dropped.length > 0) {
    const key = dropped.map((d) => d.id).sort().join(',')
    if (!warnedNonFinite.has(key)) {
      warnedNonFinite.add(key)
      console.error(`[status-view] non-finite aiwatchScore for: ${key}`)
    }
  }
  const targetScore = Math.round(target.aiwatchScore as number)
  const scored = services
    .filter((s) => Number.isFinite(s.aiwatchScore) && hasReliableData(s) && s.scoreConfidence === target.scoreConfidence)
    .sort((a, b) => (b.aiwatchScore as number) - (a.aiwatchScore as number))
  const { rank, tied, total } = computeRankPosition(scored as Array<{ aiwatchScore: number }>, targetScore)
  if (rank > 0) return { rank, rankTied: tied, totalRanked: total }
  console.error(`[status-view] rank lookup failed for ${target.id}: targetScore=${targetScore}, scoredLen=${scored.length}`)
  return null
}

const fallbackItem = (s: ViewService) => ({ id: s.id, name: s.name, score: s.aiwatchScore ?? null, status: s.status })
type FallbackItem = ReturnType<typeof fallbackItem>

export interface IsDownView<S extends ViewService = ViewService> {
  lastUpdated: string
  cached: boolean
  services: Array<S & { rank?: number; rankTied?: boolean; totalRanked?: number }>
  fallbacks?: FallbackItem[]
  fallbackGroups?: Array<{ use: string; items: FallbackItem[] }>
  fallbackCapabilityLabel?: string
  aiAnalysis?: Record<string, unknown[]>
  supplyChainBanner?: unknown
  upstreamLinks?: unknown[]
  recoveryBaseline?: Record<string, unknown>
}

/** One is-down page: the target (with its rank), its fallbacks, and only its own share of the
 *  payload-wide maps. An unknown id yields no service, which the page reports as `service_missing`. */
export function buildIsDownView<S extends ViewService>(payload: LeanStatusPayload<S>, id: string): IsDownView<S> {
  const base = { lastUpdated: payload.lastUpdated, cached: payload.cached }
  const target = payload.services.find((s) => s.id === id)
  if (!target) return { ...base, services: [] }
  const rank = rankInTier(payload.services, target)
  const selection = selectFallbacks(id, target.category, payload.services)
  const routedCap = routedCapability(target)
  const analyses = payload.aiAnalysis?.[id]
  const baseline = payload.recoveryBaseline?.[id]
  return {
    ...base,
    services: [{ ...target, ...rank }],
    fallbacks: selection.groups ? selection.groups.flatMap((g) => g.items.map(fallbackItem)) : selection.items.map(fallbackItem),
    ...(selection.groups ? { fallbackGroups: selection.groups.map(({ group, items }) => ({ use: group.use, items: items.map(fallbackItem) })) } : {}),
    ...(routedCap ? { fallbackCapabilityLabel: CAPABILITY_LABEL[routedCap] } : {}),
    ...(analyses ? { aiAnalysis: { [id]: analyses } } : {}),
    ...(payload.supplyChainBanner ? { supplyChainBanner: payload.supplyChainBanner } : {}),
    upstreamLinks: payload.upstreamLinks ?? [],
    ...(baseline ? { recoveryBaseline: { [id]: baseline } } : {}),
  }
}

/** One family page: its members in full, and only `{ id, status }` for the services whose status alone
 *  it shows (the other families' members). */
export function buildIsDownGroupView<S extends ViewService>(payload: LeanStatusPayload<S>, ids: string[], statusIds: string[]) {
  const full = payload.services.filter((s) => ids.includes(s.id))
  const statusOnly = payload.services
    .filter((s) => statusIds.includes(s.id) && !ids.includes(s.id))
    .map((s) => ({ id: s.id, status: s.status }))
  const aiAnalysis = Object.fromEntries(ids.flatMap((id) => payload.aiAnalysis?.[id] ? [[id, payload.aiAnalysis[id]]] : []))
  return {
    lastUpdated: payload.lastUpdated,
    cached: payload.cached,
    services: [...full, ...statusOnly],
    ...(Object.keys(aiAnalysis).length > 0 ? { aiAnalysis } : {}),
  }
}

export function buildStatusView<S extends ViewService>(view: StatusView, payload: LeanStatusPayload<S>) {
  return view.kind === 'is-down'
    ? buildIsDownView(payload, view.id)
    : buildIsDownGroupView(payload, view.ids, view.statusIds)
}

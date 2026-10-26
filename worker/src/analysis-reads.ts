// #1772 — which incidents' `ai:analysis` keys a surface reads: `/api/status/cached` and the ext-claude
// projection share it, so the popup shows the analyses the dashboard modal shows.
import type { Incident } from './types'
import { analysisKey, type AIAnalysisResult } from './ai-analysis'

// recovered: keys have 2h TTL, 3h cutoff for safety margin
export const RECENT_RECOVERY_MS = 3 * 3600_000

// monitoring = "recovery confirmed" — exclude from active analysis display
export function liveAnalysisIncidents(incidents: Incident[] | undefined): Incident[] {
  return (incidents ?? []).filter((i) => i.status !== 'resolved' && i.status !== 'monitoring')
}

// Recently resolved incidents whose (resolved) analysis is still shown: only on an operational
// service that has no live analysis of its own.
export function recentlyResolvedIncidents(
  svc: { status: string; incidents?: Incident[] },
  hasLiveAnalysis: boolean,
  nowMs: number,
): Incident[] {
  if (svc.status !== 'operational' || hasLiveAnalysis) return []
  const cutoff = nowMs - RECENT_RECOVERY_MS
  // #1292 — a synthesized incident can never have a `recovered:` marker (isMarkableOnStatusEdge
  // refuses it, and it never alerts), so probing for one is a guaranteed miss. It would fire for
  // ~3h/day per day-bucket, since a full-day bucket "resolves" at the next day's local noon.
  // Same skip the /feed handler applies for the same reason.
  return (svc.incidents ?? []).filter((i) =>
    i.derived !== 'status_history' && i.resolvedAt && new Date(i.resolvedAt).getTime() >= cutoff)
}

export interface StatusAnalyses {
  aiAnalysis: Record<string, AIAnalysisResult[]>
  recentlyRecovered: Record<string, string[]>
}

// Live incidents first; then, for a service left with no live analysis, its recently resolved ones —
// the `recovered:` marker (independent of AI analysis) plus the resolved analysis for enrichment.
export async function readStatusAnalyses(
  kv: Pick<KVNamespace, 'get'>,
  services: Array<{ id: string; status: string; incidents?: Incident[] }>,
  nowMs: number,
  { markers = true }: { markers?: boolean } = {},
): Promise<StatusAnalyses> {
  const aiAnalysis: Record<string, AIAnalysisResult[]> = {}
  const recentlyRecovered: Record<string, string[]> = {}
  const push = <T>(map: Record<string, T[]>, svcId: string, v: T) => {
    if (!map[svcId]) map[svcId] = []
    if (!map[svcId].includes(v)) map[svcId].push(v)
  }
  const read = async (svcId: string, incId: string): Promise<AIAnalysisResult | null> => {
    const raw = await kv.get(analysisKey(svcId, incId)).catch(() => null)
    if (!raw) return null
    try { return JSON.parse(raw) as AIAnalysisResult }
    catch (err) { console.warn('[kv] ai:analysis parse failed:', svcId, incId, err instanceof Error ? err.message : err); return null }
  }
  await Promise.all(services.flatMap((svc) => liveAnalysisIncidents(svc.incidents).map(async (inc) => {
    const a = await read(svc.id, inc.id)
    if (a) push(aiAnalysis, svc.id, a)
  })))
  await Promise.all(services.flatMap((svc) => recentlyResolvedIncidents(svc, !!aiAnalysis[svc.id], nowMs).map(async (inc) => {
    const [recoveredRaw, a] = await Promise.all([
      markers ? kv.get(`recovered:${svc.id}:${inc.id}`).catch(() => null) : null,
      read(svc.id, inc.id),
    ])
    if (recoveredRaw) push(recentlyRecovered, svc.id, inc.id)
    if (a?.resolvedAt) {
      push(aiAnalysis, svc.id, a)
      push(recentlyRecovered, svc.id, inc.id)
    }
  })))
  return { aiAnalysis, recentlyRecovered }
}

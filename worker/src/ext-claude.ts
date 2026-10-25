import type { ServiceStatus, Incident } from './types'
import { isUnreadableStatus } from './status-verdict'
import { getFallbacks } from './fallback'
import type { LatestReportSummary } from './latest-report'
import type { RecoveryBaseline } from './recovery-baseline-text'
import type { AIAnalysisResult } from './ai-analysis'
import { recoveryLine, scopeLine } from './prediction-accuracy'
import { liveAnalysisIncidents, recentlyResolvedIncidents } from './analysis-reads'

// Lite projection for the Claude-only Chrome extension (#837).
//
// The extension (MV3) polls /api/status/cached?src=ext-claude every few minutes
// while a Claude tab is open and renders a toolbar badge + popup. It reads NO page
// content — this worker projection is its only data source. The full
// /api/status/cached is ~780 KB (all services + probe/latency/AI); this projection
// emits only the three Anthropic surfaces and, for each, just what the popup shows:
// status + AIWatch Score + per-category fallback + unresolved official incidents (with
// the AI summary when present) + the GATED crowd-report signal (#575). ~1–2 KB.
// Mirrors the statusline.ts (#438/#494) lite-projection pattern.

// The three Anthropic surfaces the extension tracks (verified ids in services.ts):
// claude = Claude API (category 'api'), claudeai = claude.ai ('app'),
// claudecode = Claude Code ('agent'). Order here is the emit order.
export const EXT_CLAUDE_IDS = ['claude', 'claudeai', 'claudecode'] as const

// A service already enriched with its computed Score (via scoreFor in index.ts).
// Fallback candidacy needs the FULL scored set, so buildExtClaudePayload takes
// every scored service (the candidate pool) and narrows the EMIT to EXT_CLAUDE_IDS.
export type ScoredService = ServiceStatus & {
  aiwatchScore: number | null
  scoreGrade: string | null
  // #1186 — carried through so getFallbacks/orderForFallback can bucket candidates by confidence tier
  // before the proportional interleave (see fallback.ts's FallbackCandidate.scoreConfidence and
  // orderForFallback's doc comment for the full rationale).
  scoreConfidence?: 'high' | 'medium' | 'low' | null
}

export interface ExtClaudeIncident {
  id: string
  title: string
  status: Incident['status']
  impact: Incident['impact']
  // The live analysis as one string — what popups before #1772 render.
  aiSummary?: string
  ai?: ExtClaudeAnalysis
  resolvedAt?: string
}

/** #1772 — an AI analysis as the dashboard modal shows it; `lines` are its recovery + scope lines. */
export interface ExtClaudeAnalysis {
  summary: string
  lines: string[]
  analyzedAt: string
  model: 'Gemma' | 'Sonnet' | null
}

// The gated crowd signal — count + recent {category, when, text}. `desc` is the user's
// free-text note: already SANITIZED server-side (sanitizeReportDescription) and only ever
// present here when corroborated (#575) — i.e. the same text the public dashboard shows —
// so including it is no new exposure. Length-capped to keep the projection small.
export interface ExtClaudeReports {
  count: number
  recent: Array<{ cat: string; ts: number; desc: string }>
}

export interface ExtClaudeService {
  id: string
  name: string
  status: ServiceStatus['status']
  uptime30d: number | null
  score: number | null
  grade: string | null
  fallback: Array<{ name: string; score: number | null }>
  incidents: ExtClaudeIncident[]
  /** #1772 — incidents resolved in the last 3h whose analysis the dashboard modal still shows. */
  recentlyResolved: ExtClaudeIncident[]
  reports: ExtClaudeReports
  /** #1711 — the components this surface's status is the worst of (claude.ai: claude.ai + Claude Cowork);
   *  empty when the surface has a single one. */
  components: Array<{ name: string; status: string }>
  /** #1772 — this surface's past recovery times (`incident:recovery-baseline`); null when it has none. */
  recoveryBaseline: RecoveryBaseline | null
}

/** #1711 — Anthropic components that are not services (#1669): shown with a not-counted label only. */
export interface ExtClaudeReference {
  components: Array<{ name: string; status: string }>
  incidents: ExtClaudeIncident[]
}

export interface ExtClaudePayload {
  services: ExtClaudeService[]
  cachedAt: string | null
  reference: ExtClaudeReference
  latestReport: LatestReportSummary | null
}

// KV-derived inputs the handler resolves and injects, kept OUT of the pure builder so
// buildExtClaudePayload stays unit-testable without KV.
export interface ExtClaudeContext {
  // Gated crowd-report entries per svcId — from buildReportFeedMap (#575); only
  // corroborated services appear, so a service absent here has count 0 by construction.
  reportFeedMap?: Record<string, Array<{ cat: string; ts: number; desc?: string }>>
  // ai:analysis keyed `${svcId}:${incId}` — live incidents plus recently resolved ones (analysis-reads.ts).
  analysisMap?: Record<string, AIAnalysisResult>
  nowMs?: number
  latestReport?: LatestReportSummary | null
  recoveryBaselines?: Record<string, RecoveryBaseline>
}

const RECENT_REPORTS_CAP = 5

/** #1772 — a live incident of this surface has an analysis: the gate on its recently resolved ones. */
function hasLiveAnalysis(svc: { id: string; incidents?: Incident[] }, analysisMap: Record<string, AIAnalysisResult> | undefined): boolean {
  return liveAnalysisIncidents(svc.incidents).some((i) => !!analysisMap?.[`${svc.id}:${i.id}`]?.summary)
}

function extAnalysis(a: AIAnalysisResult, inc: Incident, nowMs: number): ExtClaudeAnalysis {
  const lines = [recoveryLine(a, inc, 'en', nowMs), scopeLine(a, 'en')]
    .flatMap((l) => (l ? [`${l.icon} ${l.label}: ${l.value}`] : []))
  return {
    // #1328 — the progress half only while the incident is live; the 500 cap is on the pair.
    summary: [a.summary, !a.resolvedAt && a.progress].filter(Boolean).join(' ').slice(0, 500),
    lines,
    analyzedAt: a.analyzedAt,
    model: a.model === 'gemma' ? 'Gemma' : a.model === 'sonnet' ? 'Sonnet' : null,
  }
}

// True when /api/status/cached carries ?src=ext-claude (the extension's poll tag).
// EXACT match (not a prefix) — must be checked BEFORE isStatuslineRequest in the
// handler. 'ext-claude' doesn't start with 'statusline-' so there's no actual
// collision, but the ordering documents that this is a distinct, narrower branch.
export function isExtClaudeRequest(searchParams: URLSearchParams): boolean {
  return (searchParams.get('src') ?? '') === 'ext-claude'
}

// Incidents the popup lists: everything not yet resolved, ongoing first, then `monitoring` (#1772).
function popupIncidents(list: Incident[] | undefined): Incident[] {
  // #1384 — a `retainedBridge` entry (services.ts `mergeRetainedIncidentHistory`) unresolved at
  // migration time never resolves for the life of the finite migration bridge, so without this
  // exclusion the extension popup would show a stale ghost from a retiring source as the "current
  // issue" indefinitely. Currently inert (Replicate is not in `EXT_CLAUDE_IDS`) — not a durable
  // reason, so excluded here directly rather than relying on that list never changing (round-9
  // structural pass, #1384).
  const shown = (list ?? []).filter((i) => i.status !== 'resolved' && !i.retainedBridge)
  return [...shown.filter((i) => i.status !== 'monitoring'), ...shown.filter((i) => i.status === 'monitoring')]
}

// Build the projection: filter to the three Anthropic surfaces (preserving
// EXT_CLAUDE_IDS order), attach Score/grade, a per-category fallback (getFallbacks
// recommends within the SAME category, operational + incident-free + non-excluded; WITHHELD entirely
// for an unreadable source since #1233 — see the gate below),
// unresolved official incidents (+ AI summary when present), and the gated crowd-report
// signal. Pure: no KV/network. `scoredAll` is the full scored set (fallback pool).
export function buildExtClaudePayload(
  scoredAll: ScoredService[],
  cachedAt: string | null,
  ctx: ExtClaudeContext = {},
): ExtClaudePayload {
  const byId = new Map(scoredAll.map((s) => [s.id, s]))
  const services: ExtClaudeService[] = []
  const reference: ExtClaudeReference = { components: [], incidents: [] }
  const seenRef = new Set<string>()
  for (const id of EXT_CLAUDE_IDS) {
    const svc = byId.get(id)
    if (!svc) continue
    const nowMs = ctx.nowMs ?? Date.now()
    const analysisOf = (i: Incident) => (a => (a?.summary ? a : undefined))(ctx.analysisMap?.[`${svc.id}:${i.id}`])
    const incidents: ExtClaudeIncident[] = popupIncidents(svc.incidents).map((i) => {
      const a = i.status === 'monitoring' ? undefined : analysisOf(i)
      if (!a) return { id: i.id, title: i.title, status: i.status, impact: i.impact }
      const ai = extAnalysis(a, i, nowMs)
      return { id: i.id, title: i.title, status: i.status, impact: i.impact, aiSummary: ai.summary, ai }
    })
    const recentlyResolved: ExtClaudeIncident[] = recentlyResolvedIncidents(svc, hasLiveAnalysis(svc, ctx.analysisMap), nowMs)
      .flatMap((i) => {
        const a = analysisOf(i)
        if (!a?.resolvedAt) return []
        return [{ id: i.id, title: i.title, status: i.status, impact: i.impact, resolvedAt: a.resolvedAt, ai: extAnalysis(a, i, nowMs) }]
      })
    for (const c of svc.referenceComponents ?? []) {
      if (seenRef.has(`c:${c.id}`)) continue
      seenRef.add(`c:${c.id}`)
      reference.components.push({ name: c.name, status: c.status })
    }
    for (const i of popupIncidents(svc.referenceIncidents)) {
      if (seenRef.has(`i:${i.id}`)) continue
      seenRef.add(`i:${i.id}`)
      reference.incidents.push({ id: i.id, title: i.title, status: i.status, impact: i.impact })
    }
    const gated = ctx.reportFeedMap?.[svc.id] ?? []
    const reports: ExtClaudeReports = {
      count: gated.length,
      recent: gated.slice(0, RECENT_REPORTS_CAP).map((e) => ({ cat: e.cat, ts: e.ts, desc: (e.desc ?? '').slice(0, 140) })),
    }
    services.push({
      id: svc.id,
      name: svc.name,
      status: svc.status,
      uptime30d: svc.uptime30d ?? null,
      score: svc.aiwatchScore ?? null,
      grade: svc.scoreGrade ?? null,
      // #1233 — an unreadable source ships NO recommendation, and the gate has to be here rather than
      // only in the extension's `shouldShowFallback`. An already-installed extension keeps its old code
      // until Chrome updates it, so a client-side fix reaches nobody who is running the version that
      // produced the reported behaviour (2026-08-14: "switch to ChatGPT / Grok / Junie / Codex" while
      // status.claude.com was unreadable). Withholding the list server-side reaches every installed copy
      // on the next worker deploy, because an empty array renders nothing in every version.
      fallback: isUnreadableStatus(svc.status) ? [] : getFallbacks(svc.id, svc.category, scoredAll),
      incidents,
      recentlyResolved,
      reports,
      components: (svc.components ?? []).length > 1 ? svc.components!.map((c) => ({ name: c.name, status: c.status })) : [],
      recoveryBaseline: ctx.recoveryBaselines?.[svc.id] ?? null,
    })
  }
  return { services, cachedAt, reference, latestReport: ctx.latestReport ?? null }
}

import type { ServiceStatus, Incident } from './types'
import { getFallbacks } from './fallback'

// Lite projection for the Claude-only Chrome extension (#837).
//
// The extension (MV3) polls /api/status/cached?src=ext-claude every few minutes
// while a Claude tab is open and renders a toolbar badge + popup. It reads NO page
// content — this worker projection is its only data source. The full
// /api/status/cached is ~780 KB (all services + probe/latency/AI); this projection
// emits only the three Anthropic surfaces and, for each, just what the popup shows:
// status + AIWatch Score + per-category fallback + ACTIVE official incidents (with
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
}

export interface ExtClaudeIncident {
  id: string
  title: string
  status: Incident['status']
  impact: Incident['impact']
  aiSummary?: string
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
  reports: ExtClaudeReports
}

export interface ExtClaudePayload {
  services: ExtClaudeService[]
  cachedAt: string | null
}

// KV-derived inputs the handler resolves and injects, kept OUT of the pure builder so
// buildExtClaudePayload stays unit-testable without KV.
export interface ExtClaudeContext {
  // Gated crowd-report entries per svcId — from buildReportFeedMap (#575); only
  // corroborated services appear, so a service absent here has count 0 by construction.
  reportFeedMap?: Record<string, Array<{ cat: string; ts: number; desc?: string }>>
  // AI summary keyed `${svcId}:${incId}` for active incidents (present when ai:analysis exists).
  aiSummaryMap?: Record<string, string>
}

const RECENT_REPORTS_CAP = 5

// True when /api/status/cached carries ?src=ext-claude (the extension's poll tag).
// EXACT match (not a prefix) — must be checked BEFORE isStatuslineRequest in the
// handler. 'ext-claude' doesn't start with 'statusline-' so there's no actual
// collision, but the ordering documents that this is a distinct, narrower branch.
export function isExtClaudeRequest(searchParams: URLSearchParams): boolean {
  return (searchParams.get('src') ?? '') === 'ext-claude'
}

// Surfaced incident phases for the popup's "current issue" list. Matches the cached
// endpoint's AI-analysis filter: resolved = done, monitoring = recovery confirmed —
// both excluded so the popup shows only incidents that are actually ongoing.
function activeIncidents(svc: ScoredService): Incident[] {
  return (svc.incidents ?? []).filter((i) => i.status !== 'resolved' && i.status !== 'monitoring')
}

// Build the projection: filter to the three Anthropic surfaces (preserving
// EXT_CLAUDE_IDS order), attach Score/grade, a per-category fallback (getFallbacks
// recommends within the SAME category, operational + incident-free + non-excluded),
// active official incidents (+ AI summary when present), and the gated crowd-report
// signal. Pure: no KV/network. `scoredAll` is the full scored set (fallback pool).
export function buildExtClaudePayload(
  scoredAll: ScoredService[],
  cachedAt: string | null,
  ctx: ExtClaudeContext = {},
): ExtClaudePayload {
  const byId = new Map(scoredAll.map((s) => [s.id, s]))
  const services: ExtClaudeService[] = []
  for (const id of EXT_CLAUDE_IDS) {
    const svc = byId.get(id)
    if (!svc) continue
    const incidents: ExtClaudeIncident[] = activeIncidents(svc).map((i) => {
      const aiSummary = ctx.aiSummaryMap?.[`${svc.id}:${i.id}`]
      return { id: i.id, title: i.title, status: i.status, impact: i.impact, ...(aiSummary ? { aiSummary } : {}) }
    })
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
      fallback: getFallbacks(svc.id, svc.category, scoredAll),
      incidents,
      reports,
    })
  }
  return { services, cachedAt }
}

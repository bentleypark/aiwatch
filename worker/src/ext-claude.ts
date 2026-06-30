import type { ServiceStatus } from './types'
import { getFallbacks } from './fallback'

// Lite projection for the Claude-only Chrome extension (#837).
//
// The extension (MV3) polls /api/status/cached?src=ext-claude every few minutes
// while a Claude tab is open and renders a toolbar badge + popup (status +
// AIWatch Score + a fallback "try X"). It reads NO page content — this worker
// projection is its only data source. The full /api/status/cached is ~2.8 MB
// (all services + probe/latency/AI analysis); this projection drops everything
// but the three Anthropic surfaces' status + score + per-category fallback so
// each poll is ~KB. Mirrors the statusline.ts (#438/#494) lite-projection pattern.

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

export interface ExtClaudeService {
  id: string
  name: string
  status: ServiceStatus['status']
  score: number | null
  grade: string | null
  fallback: Array<{ name: string; score: number | null }>
}

export interface ExtClaudePayload {
  services: ExtClaudeService[]
  cachedAt: string | null
}

// True when /api/status/cached carries ?src=ext-claude (the extension's poll tag).
// EXACT match (not a prefix) — must be checked BEFORE isStatuslineRequest in the
// handler. 'ext-claude' doesn't start with 'statusline-' so there's no actual
// collision, but the ordering documents that this is a distinct, narrower branch.
export function isExtClaudeRequest(searchParams: URLSearchParams): boolean {
  return (searchParams.get('src') ?? '') === 'ext-claude'
}

// Build the tiny projection: filter to the three Anthropic surfaces (preserving
// EXT_CLAUDE_IDS order), attach each one's Score/grade and a per-category fallback
// (getFallbacks recommends within the SAME category — api→api, app→app, agent→agent,
// already operational + incident-free + non-excluded). Pure: no KV/network.
// `scoredAll` is the full scored set (the fallback candidate pool).
export function buildExtClaudePayload(
  scoredAll: ScoredService[],
  cachedAt: string | null,
): ExtClaudePayload {
  const byId = new Map(scoredAll.map((s) => [s.id, s]))
  const services: ExtClaudeService[] = []
  for (const id of EXT_CLAUDE_IDS) {
    const svc = byId.get(id)
    if (!svc) continue
    services.push({
      id: svc.id,
      name: svc.name,
      status: svc.status,
      score: svc.aiwatchScore ?? null,
      grade: svc.scoreGrade ?? null,
      fallback: getFallbacks(svc.id, svc.category, scoredAll),
    })
  }
  return { services, cachedAt }
}

import type { ServiceStatus, Incident } from './types'
import { getFallbacks } from './fallback'
import { appendUtm } from './utils'
import { SERVICE_ID_TO_SLUG } from '../../api/_is-down/slug-map'

// Minimal status-only projection for terminal statusline integrations (#438).
//
// The Claude Code statusline snippets (#400, src/pages/Statusline.jsx) poll the
// status endpoint on (roughly) every prompt and `jq` out only id/name/status.
// The full /api/status/cached response is ~2 MB (services + probe:24h +
// latency:24h + AI analysis) — downloaded and discarded on every poll — which
// made /api/status/cached the single largest Vercel Fast Data Transfer route
// (17.8 GB/cycle). This projection drops everything but id/name/status so each
// poll is ~KB. Served when the request carries the `?src=statusline-*` tag.

// The field set is a contract: the Statusline.jsx snippet `jq` filters read
// exactly `.services[].id`, `.name`, `.status`. Renaming/dropping any of these
// silently breaks every installed statusline (jq emits nothing; the snippet's
// `2>/dev/null || true` swallows the error). statusline.test.ts pins the keys.
export interface StatuslineService {
  id: string
  name: string
  status: ServiceStatus['status']
}

export interface StatuslinePayload {
  services: StatuslineService[]
  cachedAt: string | null
}

export function buildStatuslinePayload(
  cached: { services: ServiceStatus[]; cachedAt?: string } | null,
): StatuslinePayload {
  return {
    services: (cached?.services ?? []).map((s) => ({ id: s.id, name: s.name, status: s.status })),
    cachedAt: cached?.cachedAt ?? null,
  }
}

// True when a request to /api/status/cached is a statusline poll (carries the
// `?src=statusline-<preset>` tag set by Statusline.jsx). Used to short-circuit
// the heavy KV reads and return buildStatuslinePayload instead.
export function isStatuslineRequest(searchParams: URLSearchParams): boolean {
  return (searchParams.get('src') ?? '').startsWith('statusline-')
}

// ── Server-side statusline rendering (#918) ───────────────────────────────
//
// The old model shipped the display logic as a `jq` program the user pasted into
// ~/.claude/settings.json. That froze the formatting on the user's machine: AIWatch
// has no write access to their config, so a display change (e.g. the `+N` overflow
// marker) could NEVER reach an already-installed statusline — only the DATA moved
// server-side, the formatting didn't. Rendering the final string in the worker moves
// ALL display logic server-side, so `GET /api/statusline/:preset` returns exactly what
// the statusline should show; the snippet becomes a thin `curl … || true` (no jq
// dependency), and every future display change ships to all users via a worker deploy.
//
// One-time migration cost: an existing (jq-based) user must re-copy the thin snippet
// ONCE; after that they never re-copy again. New users start on the thin snippet.

// OSC 8 hyperlink: ESC ]8;; <url> ESC \ <text> ESC ]8;; ESC \  (renders <text> as a
// clickable link in OSC-8-capable terminals; others show it as plain text — no harm).
const ESC = ''
const AIWATCH_HOME = 'https://ai-watch.dev'
function osc8(url: string, text: string): string {
  return `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`
}
// #936 — tag OSC-8 targets with utm_source=statusline so terminal-click inflow attributes to the
// statusline instead of collapsing to (direct). Only the (invisible) link TARGET grows — the visible
// statusline text is unchanged, so the one-line space budget is unaffected.
function detailUrl(id: string): string {
  return appendUtm(`${AIWATCH_HOME}/#${id}`, 'statusline')
}
const HOME_URL = appendUtm(AIWATCH_HOME, 'statusline')

// The name-list presets cap at this many names, then append a `+N` overflow marker
// (statusline space is a one-line budget; #400 Display policy). SCOPED is ≤3 by
// construction; COMPACT/FULL_LIST don't list names so they don't cap.
const STATUSLINE_NAME_CAP = 3
// Only these three core LLMs surface in the SCOPED preset.
const SCOPED_IDS = new Set(['claude', 'openai', 'gemini'])

export const STATUSLINE_PRESETS = [
  'branded',
  'clickable',
  'degraded_only',
  'compact_badge',
  'full_list',
  'scoped',
] as const
export type StatuslinePreset = (typeof STATUSLINE_PRESETS)[number]

export function isStatuslinePreset(v: string): v is StatuslinePreset {
  return (STATUSLINE_PRESETS as readonly string[]).includes(v)
}

// Shared: first `STATUSLINE_NAME_CAP` rendered names joined by a space, plus a ` +N`
// overflow marker when more than the cap are down. `render` maps a service to its
// display token (plain "🔴 name" or an OSC-8-linked variant).
function capWithOverflow(down: StatuslineService[], render: (s: StatuslineService) => string): string {
  const shown = down.slice(0, STATUSLINE_NAME_CAP).map(render).join(' ')
  const overflow = down.length > STATUSLINE_NAME_CAP ? ` +${down.length - STATUSLINE_NAME_CAP}` : ''
  return shown + overflow
}

// Pure: render the final statusline string for a preset from the lite service list.
// Preserves the incoming service order (the cache order), matching the old jq behaviour.
// Returns '' (empty statusline) when nothing is degraded, EXCEPT `branded` which keeps
// an always-on "AIWatch 🟢" label. Unknown preset → '' (caller should 404 first).
export function renderStatuslinePreset(preset: string, services: StatuslineService[]): string {
  const down = services.filter((s) => s.status !== 'operational')
  switch (preset) {
    case 'branded': {
      const label = osc8(HOME_URL, 'AIWatch')
      if (down.length === 0) return `${label} 🟢`
      return `${label} ${capWithOverflow(down, (s) => osc8(detailUrl(s.id), `🔴 ${s.name}`))}`
    }
    case 'clickable': {
      if (down.length === 0) return ''
      return capWithOverflow(down, (s) => osc8(detailUrl(s.id), `🔴 ${s.name}`))
    }
    case 'degraded_only': {
      if (down.length === 0) return ''
      return capWithOverflow(down, (s) => `🔴 ${s.name}`)
    }
    case 'compact_badge': {
      return down.length === 0 ? '' : `🔴 ${down.length} AI services`
    }
    case 'full_list': {
      return down.map((s) => `${s.status === 'down' ? 'X' : '!'}·${s.name}`).join(' | ')
    }
    case 'scoped': {
      return down
        .filter((s) => SCOPED_IDS.has(s.id))
        .map((s) => `🔴 ${s.name}`)
        .join(' ')
    }
    default:
      return ''
  }
}

// ── Monitor down-list (#920) ──────────────────────────────────────────────
//
// The plugin's background monitor needs a PARSEABLE, UNCAPPED list of the currently
// non-operational services so it can diff poll-over-poll and emit explicit "X is down"
// / "Y has recovered" lines (the display presets are capped at 3 + are emoji strings,
// unsuitable for a diff). One `\t`-separated `status<TAB>name` line per non-operational
// service, in cache order; empty body when all operational. Consumed only by the monitor.
export function renderStatuslineDownList(services: StatuslineService[]): string {
  return services
    .filter((s) => s.status !== 'operational')
    .map((s) => `${s.status}\t${s.name}`)
    .join('\n')
}

// ── Incident briefing (#920) ──────────────────────────────────────────────
//
// The plugin `/aiwatch` command wants more than names — it wants WHAT is happening.
// This renders a compact multi-line text briefing (not a one-line statusline): for
// each non-operational service, its active official incident (title + impact), the AI
// summary of that incident when present, and a per-category fallback suggestion. Server
// side keeps the plugin a thin curl with no jq — same rationale as the presets (#918).
//
// `scoredAll` is the FULL scored set (getFallbacks needs the candidate pool); the render
// narrows to non-operational services. `aiSummaryMap` is keyed `${svcId}:${incId}` — the
// handler reads it from `ai:analysis:*` for active incidents (kept out of the pure fn).

export type BriefService = ServiceStatus & {
  aiwatchScore?: number | null
  scoreGrade?: string | null
  // #1186 — carried through so getFallbacks/orderForFallback can bucket candidates by confidence tier
  // before the proportional interleave (see fallback.ts's FallbackCandidate.scoreConfidence and
  // orderForFallback's doc comment for the full rationale).
  scoreConfidence?: 'high' | 'medium' | 'low' | null
}

// The first ongoing incident (resolved/monitoring are done/recovering — excluded),
// matching the ext-claude / cached-endpoint active-incident filter.
function firstActiveIncident(svc: ServiceStatus): Incident | undefined {
  return (svc.incidents ?? []).find((i) => i.status !== 'resolved' && i.status !== 'monitoring')
}

const BRIEF_SUMMARY_CAP = 240

// The briefing links each affected service to a SHORT path `ai-watch.dev/p/<slug>` (no query
// string), NOT the is-down URL directly. Two reasons: (1) the briefing is relayed by the model +
// rendered in a terminal, both of which can drop a long `?utm_...` query — a bare short path
// survives; (2) `/p/:slug` is a `vercel.json` REDIRECT (config, zero Serverless Functions — dodges
// the 12-fn cap) that adds `utm_source=claude-code&…&utm_campaign=outage` and 307s to the real
// is-down page, so GA4 + the #842-B beacon (classifyReferrer → 'plugin') attribute plugin inflow.

// Human-readable incident impact (a bare `[major]` reads as low-effort). Mirrors the
// severity vocabulary of the is-down page (major/minor/critical).
const IMPACT_PHRASE: Record<NonNullable<Incident['impact']>, string> = {
  critical: 'critical impact',
  major: 'major impact',
  minor: 'minor impact',
}

export function renderStatuslineBrief(
  scoredAll: BriefService[],
  aiSummaryMap: Record<string, string> = {},
): string {
  const down = scoredAll.filter((s) => s.status !== 'operational')
  if (down.length === 0) return 'AIWatch: all monitored AI services operational ✅'

  const lines: string[] = ['AIWatch — active AI service issues:']
  for (const svc of down) {
    const emoji = svc.status === 'down' ? '🔴' : '🟠'
    const inc = firstActiveIncident(svc)
    lines.push(
      inc
        ? `${emoji} ${svc.name} (${svc.status}) — "${inc.title}"${inc.impact ? ` · ${IMPACT_PHRASE[inc.impact]}` : ''}`
        : `${emoji} ${svc.name} (${svc.status}) — no published incident`,
    )
    const summary = inc ? aiSummaryMap[`${svc.id}:${inc.id}`] : undefined
    if (summary) lines.push(`   AI: ${summary.length > BRIEF_SUMMARY_CAP ? summary.slice(0, BRIEF_SUMMARY_CAP) + '…' : summary}`)
    const fb = getFallbacks(svc.id, svc.category, scoredAll).map((f) => f.name)
    if (fb.length) lines.push(`   Try instead: ${fb.join(', ')}`)
    // Per-service landing page: the crawlable "Is <service> Down?" page. Absent for the
    // few services with no is-down page (bedrock/azureopenai → not in SERVICE_ID_TO_SLUG).
    const slug = SERVICE_ID_TO_SLUG[svc.id]
    if (slug) lines.push(`   ↳ https://ai-watch.dev/p/${slug}`)
  }
  lines.push('More: https://ai-watch.dev')
  return lines.join('\n')
}

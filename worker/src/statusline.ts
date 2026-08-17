import type { ServiceStatus, Incident } from './types'
import { getFallbacks } from './fallback'
import { appendUtm } from './utils'
import { isAffectedStatus, isUnreadableStatus } from './status-verdict'
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
// Returns '' (empty statusline) when there is nothing to list, EXCEPT `branded` which keeps an
// always-on "AIWatch 🟢" label. Unknown preset → '' (caller should 404 first).
//
// Ordering is affected-first, then unreadable, each keeping its incoming (cache) order — it no longer
// preserves cache order across the whole list the way the old jq behaviour did, because the 3-item cap
// belongs to confirmed outages before unread sources.
//
// #1233 — a service is listed here for one of TWO reasons now, and they render differently.
//
// `isAffectedStatus` is an outage AIWatch can vouch for → 🔴, the claim this line has always made.
// `unknown` is a source AIWatch could not read → ⚪, borrowing the exact idiom #1227 chose below for
// the no-snapshot case, and for the same reason it gives: dropping these services instead would make
// the line say 🟢/nothing, and "silence reads as 'nothing wrong', which is the very claim we cannot
// make". Without the split an unreadable source would render 🔴 here, asserting an outage off a page we
// failed to fetch.
const statusMarker = (s: StatuslineService): string => (isAffectedStatus(s.status) ? '🔴' : '⚪')

export function renderStatuslinePreset(preset: string, services: StatuslineService[]): string {
  const affected = services.filter((s) => isAffectedStatus(s.status))
  const unreadable = services.filter((s) => isUnreadableStatus(s.status))
  // Affected first: a confirmed outage outranks an unread source for the 3-item cap.
  const listed = [...affected, ...unreadable]
  switch (preset) {
    case 'branded': {
      const label = osc8(HOME_URL, 'AIWatch')
      if (listed.length === 0) return `${label} 🟢`
      return `${label} ${capWithOverflow(listed, (s) => osc8(detailUrl(s.id), `${statusMarker(s)} ${s.name}`))}`
    }
    case 'clickable': {
      if (listed.length === 0) return ''
      return capWithOverflow(listed, (s) => osc8(detailUrl(s.id), `${statusMarker(s)} ${s.name}`))
    }
    case 'degraded_only': {
      if (listed.length === 0) return ''
      return capWithOverflow(listed, (s) => `${statusMarker(s)} ${s.name}`)
    }
    case 'compact_badge': {
      // Two counts, never summed into one: they are different claims.
      const parts: string[] = []
      if (affected.length > 0) parts.push(`🔴 ${affected.length} AI services`)
      if (unreadable.length > 0) parts.push(`⚪ ${unreadable.length} unknown`)
      return parts.join(' · ')
    }
    case 'full_list': {
      return listed.map((s) => `${s.status === 'down' ? 'X' : s.status === 'unknown' ? '?' : '!'}·${s.name}`).join(' | ')
    }
    case 'scoped': {
      return listed
        .filter((s) => SCOPED_IDS.has(s.id))
        .map((s) => `${statusMarker(s)} ${s.name}`)
        .join(' ')
    }
    default:
      return ''
  }
}

// #1227 — what a preset renders when there is NO snapshot to render from.
//
// The old behaviour ran the renderer over `[]`, which is the service list of a healthy world:
// `branded` printed "AIWatch 🟢" and the rest printed nothing. Both are claims we cannot support
// with no snapshot — the dashboard settled this same question in #689/#1004, where an unreadable
// source shows a neutral "Unknown" pill *"rather than a misleading green 'Operational'"*
// (StatusPill.jsx); the statusline surfaces were the last ones still answering green.
//
// A 503 is wrong HERE (unlike the machine-read down-list): the snippet is `curl -sf … || true`,
// so a non-2xx blanks the line, and a blank line is indistinguishable from a broken snippet. This
// is a DISPLAY surface — it should say "unknown", not disappear. Costs no client change because
// #918 moved all rendering server-side: whatever string we return is what the terminal shows.
//
// Every preset gets a marker, including the ones that are silent when healthy: silence there
// reads as "nothing wrong", which is the very claim we cannot make. Each stays in its own idiom.
export function renderStatuslinePresetUnknown(preset: StatuslinePreset): string {
  switch (preset) {
    case 'branded':
      return `${osc8(HOME_URL, 'AIWatch')} ⚪`
    case 'clickable':
      return osc8(HOME_URL, '⚪ AIWatch status unknown')
    case 'degraded_only':
    case 'scoped':
      return '⚪ AIWatch status unknown'
    case 'compact_badge':
      return '⚪ AI status unknown'
    case 'full_list':
      return '⚪ status unknown'
  }
}

// ── Monitor down-list (#920) ──────────────────────────────────────────────
//
// The plugin's background monitor needs a PARSEABLE, UNCAPPED list so it can diff poll-over-poll and
// emit explicit transition lines (the display presets are capped at 3 + are emoji strings, unsuitable
// for a diff). This endpoint — not the presets — is what the monitor polls. One `\t`-separated `status<TAB>name` line per LISTED service, in
// cache order; empty body when there is nothing to say. Consumed only by the monitor.
//
// #1233 — CARVE-OUT, and the one surface in this change that keeps the OLD encoding. An unreadable
// source is listed here as `degraded`, byte-identical to what this endpoint emitted before #1233.
//
// Not an oversight, and not the right answer either — it is a scope decision. The honest value on this
// wire is `unknown`, but the consumer is `plugin/aiwatch/bin/aiwatch-monitor.sh`, which infers RECOVERY
// FROM ABSENCE (`comm -23 prev cur` → `✅ … has recovered`). Absence therefore means two different
// things — "recovered" and "we stopped being able to see it" — and no encoding on this endpoint alone
// fixes that: dropping an unreadable service announces a false recovery for a service that is still
// down, while emitting a new status word silently changes a contract that installed plugin copies
// parse. Both were tried during this change's review and both produced defects worse than the one they
// replaced, in a script that has no automated test of any kind.
//
//
// One consequence to state plainly, because "unchanged from today" understates it: the OTHER surface of
// the same plugin bundle DID change. `/aiwatch` reads `/statusline/brief`, which now says "Status source
// unreadable … not an outage", while the background monitor reading this endpoint still says
// "🔴 … is degraded" — about the same service, in the same terminal, at the same moment. Before this
// change both said `degraded`. The briefing is the surface to trust until the monitor follow-up lands.
// So this endpoint stays exactly as it is until the monitor's absence-inference is fixed with a test
// harness in place FIRST — tracked as a follow-up. The cost is stated plainly: the plugin monitor keeps
// calling an unreadable source `degraded`, unchanged from today. Every other surface (`:preset`
// displays, the extension, is-down, the dashboard, Discord) publishes the neutral state.
export function renderStatuslineDownList(services: StatuslineService[]): string {
  return services
    .filter((s) => isAffectedStatus(s.status) || isUnreadableStatus(s.status))
    // The legacy word for an unreadable source, so the emitted bytes match the pre-#1233 endpoint.
    .map((s) => `${isUnreadableStatus(s.status) ? 'degraded' : s.status}\t${s.name}`)
    .join('\n')
}

// #1227 — "there is no roster to report on". Zero services counts because AIWatch monitors a fixed
// roster, so an empty list is never an answer, only a missing one. Redundant in production since
// `cacheRead` already collapses that case to `null`; kept because both builders are exported and
// `cacheWrite`'s own guard is the only other thing standing between here and a persisted empty.
export function hasNoSnapshot(cached: { services?: readonly unknown[] } | null): boolean {
  return !cached || !cached.services || cached.services.length === 0
}

// Only two status codes and two cache policies are ever correct here, and the pairing is not free:
// `no-store` belongs to the no-snapshot answers (a 30s-cached failure would outlive the condition
// that caused it). Literal types rather than `number`/`string` because the bug being fixed WAS a
// wire value that failed to distinguish unknown from healthy — the type carrying those values
// should not be the loosest thing in the file.
export type StatuslineCacheControl = 'no-store' | 'public, max-age=30'

/** A rendered text response for a statusline surface. Named for the surfaces, not for `down`:
 *  both the down-list and the preset builders return it, and their status invariants differ
 *  (the down-list may 503; the preset never does — see renderStatuslinePresetUnknown). */
export interface StatuslineTextResponse {
  status: 200 | 503
  body: string
  cacheControl: StatuslineCacheControl
}

// The down-list FAILS CLOSED: an empty body is the wire encoding of "everything is operational",
// so with no snapshot the old code served that same empty body at 200 and the plugin monitor read
// it as every affected service recovering. A 503 fails the monitor's `curl -sf`, which takes its
// existing fail-silent path and keeps the previous set. Fixing it server-side is what reaches
// already-installed plugins — the script lives in the user's plugin cache (the #918 rationale).
//
// An empty 200 stays meaningful: a snapshot that HAS services, none affected, is a real all-clear
// and keeps returning zero bytes. The two are distinguishable by status code.
export function buildStatuslineDownResponse(
  cached: { services: ServiceStatus[]; cachedAt?: string } | null,
): StatuslineTextResponse {
  // `no-store` on the failure: a 30s-cached 503 would outlive the condition that caused it.
  if (hasNoSnapshot(cached)) return { status: 503, body: 'no status snapshot available\n', cacheControl: 'no-store' }
  const { services } = buildStatuslinePayload(cached)
  return { status: 200, body: renderStatuslineDownList(services), cacheControl: 'public, max-age=30' }
}

// The preset surface's equivalent — a 200 either way (see renderStatuslinePresetUnknown for why a
// display surface must not 503), differing only in WHAT it says. Kept as a builder rather than an
// `if` in the handler so the no-snapshot decision itself is unit-testable: a pure renderer can be
// green while nothing proves the handler ever reaches it.
export function buildStatuslinePresetResponse(
  preset: StatuslinePreset,
  cached: { services: ServiceStatus[]; cachedAt?: string } | null,
): StatuslineTextResponse {
  if (hasNoSnapshot(cached)) return { status: 200, body: renderStatuslinePresetUnknown(preset), cacheControl: 'no-store' }
  const { services } = buildStatuslinePayload(cached)
  return { status: 200, body: renderStatuslinePreset(preset, services), cacheControl: 'public, max-age=30' }
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

// #1227 — the briefing's answer when there is no snapshot to brief from.
//
// This surface was the worst of the three: over an empty list `renderStatuslineBrief` returned
// "all monitored AI services operational ✅" — not an omission but an ASSERTION, checkmark and
// all, made from zero evidence. A 503 would technically avoid it (aiwatch-status.sh prints its
// own failure line) but that line blames "(network error)", misattributing our own unreadable
// cache to the user's connection. So the honest answer is served as a 200 and says what is
// actually true: we cannot see, and that is not the same as all-clear.
export const STATUSLINE_BRIEF_UNKNOWN =
  'AIWatch: status unknown — the current snapshot could not be read, so this is NOT an all-clear. Try again shortly · https://ai-watch.dev'

export function renderStatuslineBrief(
  scoredAll: BriefService[],
  aiSummaryMap: Record<string, string> = {},
): string {
  const down = scoredAll.filter((s) => isAffectedStatus(s.status))
  // #1233 — services whose status source AIWatch could not read. They are NOT listed as issues below
  // (there is no incident to brief and no outage to claim), but they do disqualify the all-clear: the
  // ✅ sentence asserts something about EVERY monitored service, and we have nothing to say about these.
  // Same judgement #1227 applied one line up for the no-snapshot case — with a snapshot we can be
  // precise about which services are unread instead of blanking the whole briefing.
  const unreadable = scoredAll.filter((s) => isUnreadableStatus(s.status))
  const unreadNote = unreadable.length > 0
    ? `⚪ Status source unreadable for ${unreadable.map((s) => s.name).join(', ')} — not an outage, but not confirmed operational either.`
    : ''
  if (down.length === 0) {
    return unreadable.length === 0
      ? 'AIWatch: all monitored AI services operational ✅'
      : `AIWatch: no confirmed AI service issues. ${unreadNote}\nMore: https://ai-watch.dev`
  }

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
  if (unreadNote) lines.push(unreadNote)
  lines.push('More: https://ai-watch.dev')
  return lines.join('\n')
}

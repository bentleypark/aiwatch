// AI Analysis — Hybrid: Gemma 4 (Workers AI) primary + Claude Sonnet fallback
// Triggered only when incidents are detected (not on every cron cycle)

import type { Incident, ServiceStatus } from './types'
import { sanitize, kvPut, kvDel, type KVLike } from './utils'
import { collapseXaiRegionalIncidents } from './xai-regions'
import { findSimilarHistory, formatDurationMin, accuracyOf, readIncidentHistory, type IncidentHistoryRecord } from './incident-history'
import { callAnthropicMessages, type AnthropicOutcome } from './anthropic'

// Workers AI model ID for the Gemma primary path. Exported so monthly-narrative.ts
// (which runs its own hybrid call with a different prompt + response shape) reuses
// the same model rather than drifting to a stale ID.
export const GEMMA_MODEL = '@cf/google/gemma-4-26b-a4b-it'

// The Anthropic model id + gateway URL now live in `anthropic.ts` (#955) — re-exported
// here only so existing importers keep working. Do NOT re-inline a model string.
export { AI_GATEWAY_ANTHROPIC_URL, ANTHROPIC_MODEL } from './anthropic'

/**
 * Output budget for the Sonnet fallback. Raised from 300 (#955): Sonnet 5 ships a new
 * tokenizer that produces ~30% more tokens for the same text, so the old ceiling risked
 * truncating the JSON payload mid-object.
 */
export const SONNET_MAX_TOKENS = 600

/**
 * Wall-clock budget for the ONE inline analysis the cron runs on an incident's first sighting.
 *
 * #955 Part 2: this was an 8s `Promise.race` that (a) left the Sonnet leg no room to finish
 * after a Gemma failure — Sonnet's own cap is 10s — and (b) cancelled nothing when it won, so a
 * Sonnet response arriving at 9s was paid for, thrown away, and booked as `failed`. It is now an
 * AbortController budget that reaches the Sonnet fetch, and it leaves room for a Gemma failure to
 * fall through to a Sonnet success inline. That matters most for a service #882 never holds
 * (`NEVER_AI_HELD`, alerts.ts): for those the inline call is the only chance to attach an AI
 * section before the alert ships.
 *
 * 15s is a judgement call, not a measurement. Gemma's own latency is wildly variable (0.3s to
 * >115s against the real binding on 2026-07-09), so some inline calls WILL overrun no matter what
 * this is set to. That is by design and now costs nothing: an overrun is booked as `timedOut`
 * (not `failed`), writes no re-analysis lock, and the next cron cycle retries — for a hold-eligible
 * service, inside the #882 hold window. The `timedOut` counter in the daily summary is what should drive
 * any future change to this number; do not tune it on intuition.
 */
export const INLINE_ANALYSIS_BUDGET_MS = 15_000

/**
 * Detect boilerplate timeline entries that contain no actionable technical detail.
 * Returns true if the text is generic/templated (e.g., "We are investigating this issue").
 */
const BOILERPLATE_PATTERNS = [
  /^we are (currently )?(investigating|looking into|aware of)/i,
  /^(this |the )?(incident |issue )?(has been |is being |is )?(resolved|fixed)/i,
  /^a fix has been (implemented|deployed|applied)(.* (monitor|result|status).*)?/i,
  /^we (are|have been) (continuing to )?(monitor|investigate)/i,
  /^(monitoring|investigating|identified|resolved)\.?$/i,
  /^the (issue|incident|problem) (has been )?(identified|resolved)/i,
  /^we('re| are) (still )?(working on|looking into)/i,
  /^(this|the) (incident|issue) is (being )?(monitored|investigated)/i,
]

/**
 * Generic incident title patterns — no actionable detail to analyze.
 *
 * Each pattern is anchored (`^...$`) and requires the title be the bare
 * placeholder Statuspage / similar status pages auto-emit. Real human-curated
 * copy ("Outage in us-east-1", "We are aware of an issue with API requests")
 * MUST NOT match — the cost of a false positive is real: a curated incident
 * gets clustered into a flap group AND its initial AI analysis is skipped.
 *
 * SOURCE OF TRUTH for the worker side. Mirrored verbatim in:
 *   - src/utils/incidentGrouping.js (SPA grouping override)
 *   - api/_is-down/incident-grouping.ts (SSR grouping override)
 *
 * `__assertGenericTitlePatternsAlignment` below + the same assertion in the
 * other two files lock the parity. Any drift fails the unit test in all three
 * suites at once.
 */
const GENERIC_TITLE_PATTERNS = [
  /^investigating (an |the |this )?issue\.?$/i,
  /^(service |system )?(disruption|outage|issue|incident)\.?$/i,
  /^we are (currently )?(investigating|aware)( (of )?(an?|this|the) (issue|incident|problem))?\.?$/i,
  /^(scheduled |planned )?maintenance\.?$/i,
  /^(partial |minor |major )?(service )?(degradation|interruption)\.?$/i,
]

/**
 * Stable serialized form of GENERIC_TITLE_PATTERNS — exported so the SPA and
 * SSR mirrors can pin against this at test time. Drift surfaces as a unit-test
 * failure rather than asymmetric production behavior.
 */
export const GENERIC_TITLE_PATTERNS_SOURCES: readonly string[] = GENERIC_TITLE_PATTERNS.map((p) => `${p.source}::${p.flags}`)

/**
 * Check if an incident has no actionable detail — generic title + all boilerplate timeline.
 * AI analysis would produce unhelpful output for such incidents.
 */
export function isGenericIncident(
  title: string,
  timeline?: Array<{ text: string | null }>,
): boolean {
  const genericTitle = GENERIC_TITLE_PATTERNS.some(p => p.test(title.trim()))
  if (!genericTitle) return false
  if (!timeline || timeline.length === 0) return true
  return timeline.every(t => isBoilerplate(t.text))
}

/**
 * Reason the cron scheduled handler skipped the initial AI-analysis call —
 * `null` means proceed.
 *
 * Discriminated so the call site can `console.log` the specific reason. An
 * empty AI-analysis section in a Discord embed otherwise has 4 indistinct
 * causes (merged group, no model, generic incident, upstream timeout) and
 * operators have no way to triage post-hoc without this log.
 */
export type InitialAnalysisSkipReason = 'merged' | 'no-model' | 'generic'

/**
 * Predicate for whether the cron scheduled handler should skip the initial
 * AI-analysis call on a fresh `alerted:new:` event. Centralizes three reasons
 * to skip so they can't drift between the call site and the re-analysis path:
 *
 *   - merged Together-AI model-level alert (deep analysis not useful)
 *   - no AI model available (neither Workers AI binding nor Sonnet API key)
 *   - generic-title auto-monitoring noise (#387) — same skip as
 *     refreshOrReanalyze applies to re-analysis
 *
 * Returns the reason string when skipping, `null` when the call should fire.
 */
export function shouldSkipInitialAnalysis(
  alert: { _mergedKeys?: unknown },
  inc: { title: string; timeline?: Array<{ text: string | null }> },
  hasModel: boolean,
): InitialAnalysisSkipReason | null {
  if (alert._mergedKeys) return 'merged'
  if (!hasModel) return 'no-model'
  if (isGenericIncident(inc.title, inc.timeline)) return 'generic'
  return null
}

export function isBoilerplate(text: string | null | undefined): boolean {
  if (!text) return true
  const trimmed = text.trim()
  if (trimmed.length < 15) return true  // too short to be meaningful
  // Only boilerplate if the pattern covers most of the text (no appended technical detail)
  return BOILERPLATE_PATTERNS.some(p => {
    const m = trimmed.match(p)
    if (!m) return false
    const remaining = trimmed.slice(m[0].length).replace(/[.\s,;:!]+/g, '')
    return remaining.length < 20
  })
}

export interface AIAnalysisResult {
  summary: string
  estimatedRecovery: string
  estimatedRecoveryHours?: number  // upper bound parsed from estimatedRecovery (e.g., "4–6h" → 6)
  // #1003 — the FIRST estimate ever made for this incident, stamped on every write by `putAnalysis`
  // (which pins it in the durable `ai:first-est:` key). Re-analysis only fires once an incident has
  // outrun its own estimate, and its prompt forces the new upper bound to be >= elapsed hours —
  // so `estimatedRecoveryHours` can only ratchet UP with hindsight. Grading recovery against that
  // value turned every miss into a win ("4h 55m — faster than ~15h est." on an incident first
  // estimated at 1–4h). Live surfaces show `estimatedRecoveryHours` (a user needs the CURRENT
  // ETA); anything that SCORES the prediction reads this instead (`scoringBaselineHours`).
  firstEstimatedRecoveryHours?: number
  affectedScope: string[]
  needsFallback: boolean  // AI-assessed: true if incident warrants switching to alternative service
  analyzedAt: string
  incidentId: string
  model?: 'gemma' | 'sonnet'  // which model produced this analysis
  resolvedAt?: string
  timelineHash?: string  // latest timeline entry timestamp — used to skip re-analysis when unchanged
  // #299: when true, refreshOrReanalyze skips re-analysis for this incident and only
  // refreshes the 1h TTL. Set by the /api/admin/analyze endpoint so an operator's
  // manual Sonnet override doesn't get auto-clobbered by the cron's Gemma-first path
  // on the next timeline update. Cleared naturally when incident resolves (the
  // resolution flow overwrites this key with a 2h TTL + resolvedAt marker).
  sticky?: boolean
}

/**
 * Parse estimated recovery string to hours (upper bound).
 * "4–6h" → 6, "30m–1h" → 1, "2h" → 2, "15–45m" → 0.75, "N/A" → null
 */
export function parseRecoveryHours(recovery: string): number | null {
  if (!recovery || recovery === 'N/A') return null
  // Split on range separator (–, -, ~) and take the last (upper bound) part
  const parts = recovery.split(/[–\-~]/).map(s => s.trim()).filter(Boolean)
  const upper = parts[parts.length - 1]
  if (!upper) return null
  const hMatch = upper.match(/(\d+(?:\.\d+)?)\s*h/i)
  const mMatch = upper.match(/(\d+(?:\.\d+)?)\s*m/i)
  let hours = 0
  if (hMatch) hours += parseFloat(hMatch[1])
  if (mMatch) hours += parseFloat(mMatch[1]) / 60
  if (hours <= 0) {
    console.warn(`[ai-analysis] Could not parse recovery hours from: "${recovery}"`)
  }
  return hours > 0 ? Math.round(hours * 100) / 100 : null
}

/**
 * Format recovery display text — replaces raw AI output with user-friendly text.
 * "N/A" → "Exceeded typical pattern", "No historical data..." → "Monitoring recovery signals..."
 */
export function formatRecoveryDisplay(recovery: string): string {
  if (recovery === 'No historical data for estimation') return 'Monitoring recovery signals...'
  if (recovery === 'N/A') return 'Exceeded typical pattern'
  return recovery
}

/** Centralized KV key for per-incident analysis */
export function analysisKey(svcId: string, incId: string): string {
  return `ai:analysis:${svcId}:${incId}`
}

/** A prior analysis as seen by `firstEstimateOf` — structural, so any KV write path can pass
 *  whatever it already parsed. */
interface PriorEstimate {
  estimatedRecoveryHours?: number
  firstEstimatedRecoveryHours?: number
}

function positiveHours(v: number | undefined | null): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/**
 * #1003 — the scoring baseline gets its OWN durable key, not a field that lives or dies with the
 * 1h-TTL analysis value.
 *
 * `ai:analysis:*` is deliberately allowed to LAPSE mid-incident: once an analysis is 2h+ old and the
 * per-cron re-analysis cap is exhausted, `refreshOrReanalyze` stops refreshing its TTL so a later
 * cycle re-analyzes from scratch. A broad outage can starve one long incident for the ~12 cycles that
 * takes — and the fresh analysis replacing it would install ITS estimate (made hours in, with the full
 * timeline in the prompt) as "the first" one. That re-runs this very bug on exactly the long incidents
 * where scoring matters most. Write-once here, outliving any realistic incident, so the baseline
 * survives an analysis-key lapse.
 */
export function firstEstimateKey(svcId: string, incId: string): string {
  return `ai:first-est:${svcId}:${incId}`
}

/** 30d — outlives both the analysis key (1h active / 2h resolved) and the longest incidents we see
 *  (Mistral's ~120h flaps), while staying bounded. Written at most once per incident. */
export const FIRST_ESTIMATE_TTL_S = 30 * 86400

/**
 * Pure baseline resolution, in precedence order:
 *   1. `stored` — the durable key. Already pinned; nothing may move it (so N re-analyses are idempotent)
 *   2. the prior analysis's own first estimate (same cycle, or the durable write failed)
 *   3. the prior analysis's CURRENT estimate — a pre-#1003 value IS the earlier prediction, so an
 *      incident already in flight at deploy time still scores against its original bound
 *   4. this fresh estimate — there is no prior, so it IS the first
 * Null when nothing usable exists ("N/A"): `scoringBaselineHours` then has nothing to grade and the
 * comparison line is omitted rather than fabricated.
 */
export function firstEstimateOf(
  next: AIAnalysisResult,
  prior: PriorEstimate | null,
  stored: number | null,
): number | null {
  return positiveHours(stored)
    ?? positiveHours(prior?.firstEstimatedRecoveryHours)
    ?? positiveHours(prior?.estimatedRecoveryHours)
    ?? positiveHours(next.estimatedRecoveryHours)
}

/**
 * #1003 — stamp the scoring baseline onto a fresh analysis, pinning it durably on first sight.
 *
 * EVERY write of a fresh `AIAnalysisResult` to `ai:analysis:{svcId}:{incId}` MUST route through this
 * (CI-enforced by `first-estimate-write-paths.test.ts`, which scans the worker source): re-analysis
 * fires only once an incident has outrun its own estimate, and its prompt forbids a bound below the
 * elapsed hours — so `estimatedRecoveryHours` ratchets UP with hindsight and must never be the value
 * a resolution is graded against.
 *
 * Best-effort on the KV side: a read or write failure degrades to the in-value carry (the prior
 * analysis), never to dropping the estimate or aborting the caller's write.
 */
export async function pinFirstEstimate(
  kv: KVLike,
  svcId: string,
  incId: string,
  next: AIAnalysisResult,
  prior: PriorEstimate | null,
): Promise<AIAnalysisResult> {
  const key = firstEstimateKey(svcId, incId)
  const raw = await kv.get(key).catch(() => null)
  const stored = positiveHours(raw != null ? Number(raw) : null)
  const first = firstEstimateOf(next, prior, stored)
  if (first == null) return next
  // Get-or-set — only the first sighting writes, so no later re-analysis can move the baseline.
  if (stored == null) await kvPut(kv, key, String(first), { expirationTtl: FIRST_ESTIMATE_TTL_S })
  return { ...next, firstEstimatedRecoveryHours: first }
}

export interface PutAnalysisResult {
  /** The analysis with its scoring baseline stamped. Valid even when `ok` is false: `pinFirstEstimate`
   *  has already resolved (and durably pinned) the baseline by then, so a caller that SCORES off this
   *  value still scores correctly when only the persist failed. */
  pinned: AIAnalysisResult
  /** False when the KV write failed — the caller decides whether that is fatal. */
  ok: boolean
  /** Failure detail, surfaced by `/api/admin/analyze` (an operator endpoint whose whole point is
   *  telling you WHY the automated path is broken — a bare "failed" there is the blindness #955 removed). */
  error?: string
}

/**
 * #1003 — the SINGLE chokepoint for writing `ai:analysis:{svcId}:{incId}`.
 *
 * Every write goes through here so the scoring baseline cannot be lost by construction: an analysis-key
 * write anywhere else fails CI (`first-estimate-write-paths.test.ts`). That matters because the bug was
 * never in a helper — it was in ONE of the (then) nine write paths, and a tenth added later would
 * silently reintroduce it. Routing the TTL-refresh writes through here too costs one KV read each, but
 * means the durable pin also self-heals for analyses that predate #1003.
 *
 * `prior` is whatever that key already held (`null` when it held nothing) — pass the same object being
 * re-serialized on a refresh. Writes via a raw `kv.put` rather than the `kvPut` helper only so the
 * failure message survives for `/api/admin/analyze`'s 502 detail; it never throws.
 */
export async function putAnalysis(
  kv: KVLike,
  svcId: string,
  incId: string,
  analysis: AIAnalysisResult,
  prior: PriorEstimate | null,
  ttlSec: number,
): Promise<PutAnalysisResult> {
  const pinned = await pinFirstEstimate(kv, svcId, incId, analysis, prior)
  try {
    await kv.put(analysisKey(svcId, incId), JSON.stringify(pinned), { expirationTtl: ttlSec })
    return { pinned, ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.warn('[kv] ai:analysis write failed:', svcId, incId, error)
    return { pinned, ok: false, error }
  }
}

/** Parse a raw `ai:analysis:*` KV value, returning null on absent/corrupt/non-object rather than
 *  throwing — the write paths need the prior analysis only to carry its first estimate forward, and
 *  a corrupt prior must not abort the write. (An array parses as an `object` in JS — reject it too.) */
export function parseAnalysis(raw: string | null): AIAnalysisResult | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as AIAnalysisResult
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * #882 — render the Discord embed's 🤖 AI ANALYSIS section for one incident analysis. Pure so the two
 * cron paths that build it — the inline-success path and the KV-preferred path (an analysis backfilled
 * by a prior cycle's refreshOrReanalyze, used when releasing a held alert) — emit a byte-identical
 * section. `div` is the embed section divider. Both the operator embed and the per-user relay carry it.
 */
export function formatAnalysisEmbedSection(analysis: AIAnalysisResult, div: string): string {
  const scope = analysis.affectedScope.length > 0 ? `\n📡 Scope: ${analysis.affectedScope.join(', ')}` : ''
  return `\n${div}\n🤖 **AI ANALYSIS** [Beta]\n${analysis.summary}\n⏱ Est. recovery: ${formatRecoveryDisplay(analysis.estimatedRecovery)}${scope}`
}

/**
 * Find similar past incidents by keyword overlap with current incident title.
 * Returns up to 5 most relevant recent incidents.
 */
export function findSimilarIncidents(
  currentTitle: string,
  allIncidents: Incident[],
  limit = 5,
): Incident[] {
  // #1292 — a `status_history`-derived incident's `duration` is one DAY'S downtime, not a recovery
  // time, and this feeds the model's `estimatedRecovery` calibration under the label "Historical Data".
  // It is the FALLBACK path, taken only when the durable corpus is empty (`useCorpus`) — and
  // `buildHistoryRecord` keeps these out of that corpus, so guarding one without the other simply
  // routes the same day-buckets to the same model through the other door. They also match strongly:
  // the live title and the synthesized one are named after the same resource, and a dotted hostname
  // is a single token.
  const usable = allIncidents.filter(i => i.status === 'resolved' && i.derived !== 'status_history')
  const keywords = currentTitle.toLowerCase().split(/[\s\-—·:,]+/).filter(w => w.length > 3)
  if (keywords.length === 0) return usable.slice(0, limit)

  return usable
    .map(i => {
      const titleLower = i.title.toLowerCase()
      const score = keywords.filter(k => titleLower.includes(k)).length
      return { incident: i, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ incident }) => incident)
}

/**
 * Build prompt for Claude Sonnet analysis.
 */
// System prompt (trusted instructions) — separated from untrusted data
const SYSTEM_PROMPT = `You are an AI service reliability analyst for AIWatch.
Analyze the incident data provided by the user and respond in JSON format ONLY:
{
  "summary": "Concise analysis (max 2 sentences). Identify if this is a recurring pattern or a new type of failure (e.g., network vs model).",
  "estimatedRecovery": "Short range using abbreviations ONLY. Format: '30m–1h' or '1–3h'. Use m for minutes, h for hours. Never write 'minutes' or 'hours' in full. If no data, return 'N/A'.",
  "affectedScope": ["1-3 specific features or related sub-services likely impacted"],
  "needsFallback": true/false
}

Rules:
- If the incident title contains specific environment keywords (e.g., 'Chrome', 'Cowork', 'API'), prioritize them in the summary.
- Recovery estimate MUST use short format: '30m–1h', '1–3h', '15–45m'. Never write 'minutes' or 'hours' in full words.
- If Timeline Updates are provided, incorporate the LATEST status and progress into your analysis. Reflect whether the situation is improving, worsening, or unchanged.
- needsFallback: true if the incident significantly impacts primary service availability (e.g., major outage, API errors, authentication failure). false for cosmetic issues, partial feature degradation, or scheduled maintenance.
- Keep the tone professional, objective, and data-driven.
- Do not include any text outside the JSON block.`

/**
 * Build user message with incident data (untrusted — separated from system instructions).
 */
/**
 * Build the RAG grounding block from durable incident-history records (#827
 * Feature 2): each line carries the ACTUAL recovery time, our prior estimate +
 * how it landed (accuracyOf), and the prior AI read. This is strictly richer than
 * the title-only `historyText` (it adds real outcomes + the model's own track
 * record so it can self-calibrate), so buildAnalysisPrompt prefers it when
 * present and falls back to historyText when the corpus has no match yet.
 */
export function buildHistorySection(records: IncidentHistoryRecord[]): string {
  return records.map(r => {
    let line = `- "${sanitize(r.title).slice(0, 100)}" — actual recovery ${formatDurationMin(r.durationMin)}`
    if (r.predictedRecoveryHours != null) {
      const verdict = accuracyOf(r)
      const phrase = verdict === 'accurate' ? 'accurate'
        : verdict === 'under-predicted' ? 'we under-estimated'
        : verdict === 'over-predicted' ? 'we over-estimated'
        : ''
      line += `; we estimated ~${r.predictedRecoveryHours}h${phrase ? ` (${phrase})` : ''}`
    }
    if (r.predictedSummary) line += `. Prior read: "${sanitize(r.predictedSummary).slice(0, 120)}"`
    return line
  }).join('\n').slice(0, 1200)
}

export function buildAnalysisPrompt(
  serviceName: string,
  currentIncident: { title: string; status: string; startedAt: string; impact: string | null; timeline?: Array<{ stage: string; text: string | null; at: string }> },
  similarIncidents: Incident[],
  prevPrediction?: { estimatedRecoveryHours: number; elapsedHours: number },
  similarHistory: IncidentHistoryRecord[] = [],
): string {
  // Prefer the durable-corpus grounding (actual outcomes + our prior estimate's accuracy) when
  // available; fall back to the in-memory title-only list before the corpus has a matching record.
  const useCorpus = similarHistory.length > 0
  const historyLabel = useCorpus
    ? 'Past resolved incidents on this service — our prior estimate vs what ACTUALLY happened (calibrate against these)'
    : 'Historical Data (last 30 days)'
  const historyText = useCorpus
    ? buildHistorySection(similarHistory)
    : similarIncidents.length > 0
      ? similarIncidents.map(i =>
          `- "${sanitize(i.title).slice(0, 100)}" (${sanitize(i.duration ?? 'unknown duration').slice(0, 30)}, impact: ${sanitize(i.impact ?? 'unknown').slice(0, 20)})`
        ).join('\n').slice(0, 1000)
      : 'No similar past incidents found.'

  const safeName = sanitize(serviceName).slice(0, 100)
  const safeTitle = sanitize(currentIncident.title).slice(0, 200)
  const safeStatus = sanitize(currentIncident.status).slice(0, 20)
  const safeImpact = sanitize(currentIncident.impact ?? 'unknown').slice(0, 20)

  // Include timeline updates for richer re-analysis context (most recent entries, line-safe truncation)
  const timelineLines = (currentIncident.timeline ?? [])
    .slice(-10)
    .map(t => `- [${sanitize(t.stage).slice(0, 20)}] ${sanitize(t.at).slice(0, 30)}: ${sanitize(t.text ?? '').slice(0, 200)}`)
  let timelineText = ''
  for (const line of timelineLines) {
    if (timelineText.length + line.length + 1 > 1500) break
    timelineText += (timelineText ? '\n' : '') + line
  }

  const prevPredictionText = prevPrediction
    ? `\nPrevious Prediction: Estimated recovery in ${prevPrediction.estimatedRecoveryHours}h, but ${Math.round(prevPrediction.elapsedHours)}h have elapsed and the incident remains unresolved. The previous prediction was incorrect — re-evaluate with updated context. IMPORTANT: this incident has ALREADY been ongoing ${Math.round(prevPrediction.elapsedHours)}h, so a short estimate is impossible — do NOT output an "estimatedRecovery" whose upper bound is less than ${Math.round(prevPrediction.elapsedHours)}h. Give a realistic range anchored to the elapsed duration, or if it has clearly exceeded any predictable pattern, return "N/A".\n`
    : ''

  return `<incident_data>
Service: ${safeName}
Current Incident: "${safeTitle}"
Status: ${safeStatus}
Started: ${sanitize(currentIncident.startedAt).slice(0, 30)}
Impact: ${safeImpact}
${prevPredictionText}${timelineText ? `\nTimeline Updates:\n${timelineText}\n` : ''}
${historyLabel}:
${historyText}
</incident_data>`
}

/**
 * Parse raw AI response text into AIAnalysisResult.
 * Shared between Gemma and Sonnet — both return JSON (possibly wrapped in markdown).
 */
export function parseAnalysisResponse(
  text: string,
  incidentId: string,
  model: 'gemma' | 'sonnet',
  timelineAt: string,
): AIAnalysisResult | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null

  let parsed: { summary?: string; estimatedRecovery?: string; affectedScope?: string[]; needsFallback?: boolean }
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch (err) {
    console.warn(`[ai-analysis] ${model} JSON parse failed:`, err instanceof Error ? err.message : err)
    return null
  }

  if (!parsed.summary || typeof parsed.summary !== 'string') return null

  // Normalize recovery time format: "17 minutes to 9 hours" → "17m–9h"
  let recovery = sanitize(parsed.estimatedRecovery ?? 'N/A')
  recovery = recovery
    .replace(/(\d+)\s*minutes?/gi, '$1m')
    .replace(/(\d+)\s*hours?/gi, '$1h')
    .replace(/\s*to\s*/g, '–')
  const recoveryHours = parseRecoveryHours(recovery)
  return {
    summary: sanitize(parsed.summary),
    estimatedRecovery: recovery,
    ...(recoveryHours != null && { estimatedRecoveryHours: recoveryHours }),
    affectedScope: (parsed.affectedScope ?? []).map(s => sanitize(s)),
    needsFallback: parsed.needsFallback === true || (parsed.needsFallback as unknown) === 'true',
    analyzedAt: new Date().toISOString(),
    incidentId,
    model,
    timelineHash: timelineAt,
  }
}

/**
 * Analyze incident using Gemma 4 via Workers AI binding.
 */
async function analyzeWithGemma(
  ai: Ai,
  prompt: string,
  incidentId: string,
  timelineAt: string,
): Promise<AIAnalysisResult | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- model ID may not be in type union yet
  const res: any = await (ai as any).run(GEMMA_MODEL, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    max_tokens: 500,
    chat_template_kwargs: { enable_thinking: false },
  })

  // Workers AI returns OpenAI-compatible format or legacy format
  const text = typeof res === 'string'
    ? res
    : res?.response                                        // legacy Workers AI format
      ?? res?.choices?.[0]?.message?.content                // OpenAI-compatible: content
      ?? res?.choices?.[0]?.message?.reasoning              // thinking mode fallback
  if (!text) {
    console.warn(`[ai-analysis] Gemma: unexpected response shape`, JSON.stringify(res).slice(0, 300))
    return null
  }

  return parseAnalysisResponse(text, incidentId, 'gemma', timelineAt)
}

/**
 * Analyze incident using Claude Sonnet via AI Gateway (fallback), reporting WHY it failed.
 *
 * #955: the failure kind is the whole reason this exists. A retired-model 404 and a 529
 * overload both used to collapse into `null`, so the caller could neither retry the one that
 * deserved a retry nor stop punishing the incident for the one that didn't.
 */
export async function analyzeWithSonnetDetailed(
  apiKey: string,
  prompt: string,
  incidentId: string,
  timelineAt: string,
  signal?: AbortSignal,
): Promise<{ result: AIAnalysisResult | null; outcome: AnthropicOutcome }> {
  const outcome = await callAnthropicMessages(apiKey, {
    system: SYSTEM_PROMPT,
    user: prompt,
    maxTokens: SONNET_MAX_TOKENS,
    signal,
    logPrefix: '[ai-analysis]',
  })
  if (outcome.kind !== 'ok') return { result: null, outcome }
  return { result: parseAnalysisResponse(outcome.text, incidentId, 'sonnet', timelineAt), outcome }
}

/**
 * Why a hybrid analysis produced no result.
 *
 * - `permanent` — a request-level problem (bad model id, revoked key, unparseable model output)
 *   or no API key at all. Retrying soon cannot help; the caller should back off hard.
 * - `transient` — 429 / 5xx / network. The very next cron cycle should try again.
 * - `aborted`   — the caller's budget or a per-attempt timeout ran out. Nothing is known about
 *   the upstream; retry next cycle.
 * - `unknown`   — an unexpected throw. Treated as transient-ish but backed off one cycle.
 */
export type AnalysisFailureKind = 'permanent' | 'transient' | 'aborted' | 'unknown'

/** Calls actually issued to each model — successes AND failures. */
export interface AttemptCounter { gemma: number; sonnet: number }

export interface AnalysisAttempt {
  result: AIAnalysisResult | null
  /** null iff `result` is non-null. */
  failure: AnalysisFailureKind | null
  attempts: AttemptCounter
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.message === 'aborted')
}

/**
 * Hybrid analysis: try Gemma first (Workers AI), fall back to Sonnet on failure.
 *
 * `signal` is the caller's wall-clock budget. It is propagated into the **Sonnet fetch**, where it
 * genuinely cancels the request instead of leaving a paid-for response to be discarded (#955 Part 2).
 * It also short-circuits the leg boundaries below, so a budget that expires during Gemma never
 * starts a Sonnet call nobody is waiting for.
 *
 * The **Gemma leg is awaited plainly, never wrapped**. Workers AI's `ai.run()` exposes no abort hook,
 * so a wrapper could only bound how long we WAIT — and `analyzeIncidentWithBudget` already does that
 * one level up by racing this function's ordinary promise. Wrapping the I/O promise as well bought
 * nothing and added an orphaned-promise hazard (an un-awaited `ai.run()` whose eventual rejection has
 * no handler). Keep it plain.
 *
 * `counter` is a caller-owned tally so a budget overrun can still report which models were actually
 * called: this function keeps running after the caller stops awaiting it.
 */
export async function analyzeIncidentDetailed(
  // #533 Phase 2 — honest type: callers gate on `(apiKey || ai)`, so apiKey may be undefined here when
  // only the Gemma binding is present. The `if (!apiKey)` guard below already handles it
  // (Sonnet is skipped), so this is a type-accuracy fix, not a behavior change.
  apiKey: string | undefined,
  serviceName: string,
  currentIncident: { id: string; title: string; status: string; startedAt: string; impact: string | null; timeline?: Array<{ stage: string; text: string | null; at: string }> },
  allIncidents: Incident[],
  prevPrediction?: { estimatedRecoveryHours: number; elapsedHours: number },
  ai?: Ai,
  // #827 Feature 2 — durable history corpus for RAG grounding (caller-supplied: Phase 1 = this
  // service's own history). findSimilarHistory picks the relevant subset; empty → prompt falls
  // back to the in-memory title-only history (no behavior change before the corpus accumulates).
  historyRecords: IncidentHistoryRecord[] = [],
  signal?: AbortSignal,
  counter: AttemptCounter = { gemma: 0, sonnet: 0 },
): Promise<AnalysisAttempt> {
  const similar = findSimilarIncidents(currentIncident.title, allIncidents)
  const similarHistory = findSimilarHistory({ title: currentIncident.title }, historyRecords, 3, currentIncident.id)
  const prompt = buildAnalysisPrompt(serviceName, currentIncident, similar, prevPrediction, similarHistory)
  const timelineAt = currentIncident.timeline?.at(-1)?.at ?? ''
  const attempts = counter
  const snapshot = () => ({ ...attempts })

  if (signal?.aborted) return { result: null, failure: 'aborted', attempts: snapshot() }

  // Primary: Gemma via Workers AI. Awaited plainly — never wrapped (see the doc comment).
  // Measured 2026-07-09 against the real binding: ai.run() latency ranged 0.3s to >115s, so the
  // caller's budget — not this leg — is what bounds the wait.
  if (ai) {
    attempts.gemma++
    try {
      const result = await analyzeWithGemma(ai, prompt, currentIncident.id, timelineAt)
      if (result) {
        console.log(`[ai-analysis] Gemma success for ${serviceName}`)
        return { result, failure: null, attempts: snapshot() }
      }
      console.warn(`[ai-analysis] Gemma returned unparseable response for ${serviceName}, falling back to Sonnet`)
    } catch (err) {
      if (isAbortError(err)) return { result: null, failure: 'aborted', attempts: snapshot() }
      console.warn(`[ai-analysis] Gemma failed for ${serviceName}: ${err instanceof Error ? err.message : err}, falling back to Sonnet`)
    }
  }

  // Gemma may have overrun the caller's budget. Don't start a Sonnet call nobody is waiting for.
  if (signal?.aborted) return { result: null, failure: 'aborted', attempts: snapshot() }

  // Fallback: Claude Sonnet via AI Gateway (requires API key)
  if (!apiKey) {
    console.error('[ai-analysis] no ANTHROPIC_API_KEY — Sonnet fallback unavailable')
    // A Gemma-only deployment (self-hosters, and `refreshOrReanalyze`'s `(apiKey || ai)` guard
    // means `ai` is always present here) gets no fallback — but the thing that actually failed
    // was Gemma, and a Gemma glitch is usually transient. Calling it `permanent` would earn the
    // 30-min lock and reproduce the exact #955 pathology on a no-key config. Only a deployment
    // with NEITHER model is a genuine configuration failure.
    return { result: null, failure: attempts.gemma > 0 ? 'transient' : 'permanent', attempts: snapshot() }
  }

  attempts.sonnet++
  try {
    const { result, outcome } = await analyzeWithSonnetDetailed(apiKey, prompt, currentIncident.id, timelineAt, signal)
    if (result) return { result, failure: null, attempts: snapshot() }
    // outcome.kind === 'ok' here means a 200 whose body held no parseable JSON — the same
    // prompt would reproduce it, so it is permanent, not worth a retry.
    const failure: AnalysisFailureKind =
      outcome.kind === 'transient' ? 'transient'
        : outcome.kind === 'aborted' ? 'aborted'
          : 'permanent'
    return { result: null, failure, attempts: snapshot() }
  } catch (err) {
    console.error('[ai-analysis] Sonnet fallback threw unexpectedly:', err instanceof Error ? err.message : err)
    return { result: null, failure: isAbortError(err) ? 'aborted' : 'unknown', attempts: snapshot() }
  }
}


// ── ai:usage daily counters ──

/** #995 — retention for `ai:usage:{date}`. 30d (was 2d) so a rolling trend outlives the day. */
export const AI_USAGE_TTL_S = 30 * 86400

/**
 * Daily AI-analysis counters (`ai:usage:{date}` KV, 30d TTL — #995).
 *
 * `gemma` / `sonnet` count SUCCESSES; `gemmaAttempts` / `sonnetAttempts` count calls actually
 * issued (#955). Before the attempt counters existed a dead fallback was invisible: Sonnet
 * showed `0` whether it was never reached or reached and 404ing every single time.
 */
export interface AiUsageCounters {
  calls: number
  success: number
  failed: number
  /** Budget/timeout aborts — a distinct outcome from "the model returned nothing". */
  timedOut?: number
  gemma?: number
  sonnet?: number
  gemmaAttempts?: number
  sonnetAttempts?: number
  /**
   * #1080 — which service each `timedOut` belongs to (`{svcId: count}`).
   *
   * `timedOut` alone cannot answer #882's question: an overrun on a never-held service
   * (`NEVER_AI_HELD`) is *correctly* never held, so "1 overrun happened" is only actionable once you
   * know which service it was, i.e. whether that service is ever held at all. With
   * the id, an overrun becomes findable after the fact — Discord messages are durable, so date +
   * service is enough to open that alert and read whether it shipped with the AI section.
   *
   * ABSENT ≠ zero: records written before #1080 have overruns but no attribution. Read this through
   * `timedOutAttribution()`, which distinguishes the two.
   */
  timedOutBy?: Record<string, number>
  /**
   * #1080 / #882 — the AI-hold ledger, bumped from the alert path (`index.ts`), not from an analysis.
   *
   * `held` is bumped once per held ALERT KEY, on the first-sight stamp only — never on the per-cycle
   * re-holds, which would inflate it against the release counters. Note "alert key", not "incident":
   * a merged alert (`_mergedKeys`, e.g. the Together AI grouping) spans several incidents and books
   * one hold, because the hold gate itself is per-alert.
   *
   * `held` and the release counters are NOT a balanced pair — see `holdLedger()` for the two reasons
   * (UTC-day boundary, and a held incident that resolves inside the window). Compare the two RELEASE
   * counters against each other, not against `held`.
   *
   * ABSENT ≠ zero on pre-#1080 records — read via `holdLedger()`.
   */
  held?: number
  /** Held, then released WITH the AI section — the #882 fix working as designed. */
  heldReleasedWithAi?: number
  /**
   * Held, then released with NO AI section. Two causes it cannot tell apart at the release site: the
   * `AI_HOLD_MS` window elapsed (fail-open), and the incident vanished from `scored` so there was
   * nothing left to analyze (`!svc || !inc`). NOT the merged/no-model/generic skip — that is decided
   * inside the first-sight branch, so a skipped incident is never held to begin with. A rising count
   * is the signal that holding is not buying anything.
   */
  heldReleasedWithoutAi?: number
}

export function emptyUsage(): AiUsageCounters {
  return { calls: 0, success: 0, failed: 0 }
}

/**
 * #1080 — keep only `{svcId: positiveInt}` pairs from a parsed `timedOutBy`.
 *
 * Returns `undefined` (not `{}`) when there is nothing usable, so the absent-vs-empty distinction
 * `timedOutAttribution` relies on survives a corrupt value: a garbage map must read as "we don't
 * know", never as "we know it was nobody".
 */
function sanitizeTimedOutBy(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, number> = {}
  for (const [id, n] of Object.entries(value as Record<string, unknown>)) {
    // `id &&` mirrors applyAttempt's refusal to book an empty key: without it a `{"":3}` on the wire
    // would survive the reader even though the writer can never produce one.
    if (id && typeof n === 'number' && Number.isFinite(n) && n > 0) out[id] = Math.floor(n)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * A counter field off the wire, or `undefined` when it is absent OR unusable.
 *
 * The scalars ride in through the `...parsed` spread, so without this a wire value of `"3"` would
 * make `applyHoldEvent` compute `"3" + 1 === "31"` and write the string straight back. `null` must
 * also collapse to `undefined`, or `holdLedger`'s presence test reads it as present and returns a
 * confident `0` — the exact absence-is-not-zero failure this change exists to prevent.
 */
function sanitizeCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

/** Tolerant of the pre-#955 shape (`{calls, success, failed, gemma?, sonnet?}`) and the pre-#1080 one. */
export function parseUsage(raw: string | null): AiUsageCounters {
  if (!raw) return emptyUsage()
  try {
    const parsed = JSON.parse(raw) as Partial<AiUsageCounters>
    const usage: AiUsageCounters = {
      ...emptyUsage(),
      ...parsed,
      // Through `sanitizeCount` like every other counter, not a bare `?? 0`: a wire `"3"` would
      // otherwise survive here and `summarizeAiUsageTrend`'s `a.calls + (u.calls ?? 0)` would build
      // `"03"`, after which `formatAiUsageTrendLine`'s `=== 0` guard silently stops matching.
      calls: sanitizeCount(parsed.calls) ?? 0,
      success: sanitizeCount(parsed.success) ?? 0,
      failed: sanitizeCount(parsed.failed) ?? 0,
    }
    // Spreading `parsed` copied whatever was on the wire — re-derive every optional counter through a
    // sanitizer, and DELETE rather than set-undefined so a round-trip through JSON.stringify does not
    // resurrect the key as `"timedOutBy": undefined`-shaped noise. Deleting also keeps `null` from
    // masquerading as "present" to `holdLedger`'s absence test.
    const by = sanitizeTimedOutBy(parsed.timedOutBy)
    if (by) usage.timedOutBy = by
    else delete usage.timedOutBy

    for (const field of ['timedOut', 'gemma', 'sonnet', 'gemmaAttempts', 'sonnetAttempts', 'held', 'heldReleasedWithAi', 'heldReleasedWithoutAi'] as const) {
      const n = sanitizeCount(parsed[field])
      if (n === undefined) delete usage[field]
      else usage[field] = n
    }
    return usage
  } catch {
    return emptyUsage()
  }
}

/**
 * #1080 — read the `timedOut` attribution, distinguishing "no overruns" from "overruns we cannot
 * attribute". Pure.
 *
 * - no overruns at all → `{ by: {}, unattributed: 0 }` (a KNOWN empty)
 * - overruns but no map (a pre-#1080 record) → `null` (UNKNOWN — do not render this as zero)
 * - otherwise the map, plus however many overruns it does not account for. `unattributed > 0` with a
 *   non-empty map means some overruns are unattributed — either the day straddled the #1080 deploy,
 *   or they hit the empty-`svcId` path (counted, deliberately not keyed).
 */
export function timedOutAttribution(
  usage: AiUsageCounters,
): { by: Record<string, number>; unattributed: number } | null {
  const total = usage.timedOut ?? 0
  if (total <= 0) return { by: {}, unattributed: 0 }
  if (!usage.timedOutBy) return null
  const attributed = Object.values(usage.timedOutBy).reduce((a, b) => a + b, 0)
  return { by: { ...usage.timedOutBy }, unattributed: Math.max(0, total - attributed) }
}

/**
 * #1080 — read the #882 AI-hold ledger. Pure. Returns `null` when NONE of the three counters is
 * present (a pre-#1080 record), so a reader cannot mistake "not instrumented yet" for "zero holds".
 *
 * **Deliberately does NOT return a held-minus-released "in flight" figure.** That subtraction reads
 * like a leak detector and is not one — it is unbalanced by construction for two reasons, so a
 * nonzero value would be evidence of nothing:
 *
 *  1. **The counters are per-UTC-day, the hold window is not.** `AI_HOLD_MS` (~10min) against a
 *     five-minute cron means a hold stamped at 23:58 releases against the NEXT day's key. That day then
 *     carries a release with no matching `held`, and the previous day a `held` with no release.
 *  2. **A held incident that resolves inside the window never reaches the release site.** With the
 *     incident gone, `buildIncidentAlerts` emits no `alerted:new:` alert at all, so the loop never
 *     visits it and the marker just TTLs out. That is correct behavior, not a lost release.
 *
 * The useful comparison is the RATIO of `releasedWithAi` to `releasedWithoutAi` over a window — that
 * is the one #882 actually asks about: did holding buy an AI section, or did the alert ship AI-less
 * anyway.
 *
 * Read it as a TREND, not as an exact tally. These counters are near-exact, not exact, and the error
 * is not symmetric: `recordHoldEvent` is read-modify-write (concurrent crons can lose a bump), and a
 * marker that outlives its release — `kvDel` swallows failures, and KV reads are eventually consistent
 * — lets a #545 late joiner book a SECOND release for the same hold episode. That re-book skews toward
 * `releasedWithAi`, because by the next cycle `refreshOrReanalyze` has usually backfilled the analysis.
 * So the bias runs toward "the hold worked", which is exactly the direction that could make #882 look
 * answered when it is not. A single day's numbers prove nothing; a sustained `releasedWithoutAi` share
 * does.
 */
export function holdLedger(
  usage: AiUsageCounters,
): { held: number; releasedWithAi: number; releasedWithoutAi: number } | null {
  if (usage.held === undefined && usage.heldReleasedWithAi === undefined && usage.heldReleasedWithoutAi === undefined) {
    return null
  }
  return {
    held: usage.held ?? 0,
    releasedWithAi: usage.heldReleasedWithAi ?? 0,
    releasedWithoutAi: usage.heldReleasedWithoutAi ?? 0,
  }
}

/**
 * Fold one attempt into the daily counters. Pure.
 *
 * `calls` is incremented here rather than at the call site because the old code did
 * `usage.calls++` AFTER awaiting the model, inside the `try` — so a thrown error incremented
 * neither `calls` nor `failed` and vanished from the ledger entirely (#955).
 */
export function applyAttempt(usage: AiUsageCounters, attempt: AnalysisAttempt, svcId: string): AiUsageCounters {
  const next: AiUsageCounters = { ...usage }
  next.calls++
  if (attempt.attempts.gemma) next.gemmaAttempts = (next.gemmaAttempts ?? 0) + attempt.attempts.gemma
  if (attempt.attempts.sonnet) next.sonnetAttempts = (next.sonnetAttempts ?? 0) + attempt.attempts.sonnet

  if (attempt.result) {
    next.success++
    if (attempt.result.model === 'gemma') next.gemma = (next.gemma ?? 0) + 1
    else if (attempt.result.model === 'sonnet') next.sonnet = (next.sonnet ?? 0) + 1
  } else if (attempt.failure === 'aborted') {
    next.timedOut = (next.timedOut ?? 0) + 1
    // #1080 — attribute the overrun. `svcId` is required (not optional) so the type checker flags
    // any call site that cannot supply one: an optional param here would silently re-create the
    // unattributed blind spot this whole change exists to remove (the #970 lesson). An empty id is
    // still possible at runtime from a defensive `?? ''`, so skip it rather than booking a `""` key.
    if (svcId) next.timedOutBy = { ...next.timedOutBy, [svcId]: (next.timedOutBy?.[svcId] ?? 0) + 1 }
  } else {
    next.failed++
  }
  return next
}

/**
 * #1080 / #882 — one AI-hold lifecycle event.
 *
 * `held` is emitted ONLY on an incident's first hold; the per-cycle re-holds are deliberately silent
 * (see `AiUsageCounters.held`).
 */
export type AiHoldEvent = 'held' | 'releasedWithAi' | 'releasedWithoutAi'

/** Fold one hold event into the daily counters. Pure. */
export function applyHoldEvent(usage: AiUsageCounters, event: AiHoldEvent): AiUsageCounters {
  const next: AiUsageCounters = { ...usage }
  if (event === 'held') next.held = (next.held ?? 0) + 1
  else if (event === 'releasedWithAi') next.heldReleasedWithAi = (next.heldReleasedWithAi ?? 0) + 1
  else next.heldReleasedWithoutAi = (next.heldReleasedWithoutAi ?? 0) + 1
  return next
}

/** #995 — a multi-day roll-up of AiUsageCounters for the trend surfaces. */
export interface AiUsageTrend {
  days: number
  calls: number
  gemma: number
  gemmaAttempts: number
  sonnet: number
  sonnetAttempts: number
  timedOut: number
  failed: number
  /** gemma / gemmaAttempts — null when Gemma was never attempted (no denominator). */
  gemmaSuccessRate: number | null
  /** timedOut / calls — null when there were no calls. */
  timedOutRate: number | null
}

/**
 * #995 — sum a window of daily `AiUsageCounters` into one trend. Pure; the caller supplies whichever
 * days it read from `ai:usage:{date}`. Rates are null (not 0) when their denominator is 0, so the
 * formatter can omit a meaningless "0%" and a division never yields NaN.
 */
export function summarizeAiUsageTrend(entries: AiUsageCounters[]): AiUsageTrend {
  const s = entries.reduce(
    (a, u) => ({
      calls: a.calls + (u.calls ?? 0),
      gemma: a.gemma + (u.gemma ?? 0),
      gemmaAttempts: a.gemmaAttempts + (u.gemmaAttempts ?? 0),
      sonnet: a.sonnet + (u.sonnet ?? 0),
      sonnetAttempts: a.sonnetAttempts + (u.sonnetAttempts ?? 0),
      timedOut: a.timedOut + (u.timedOut ?? 0),
      failed: a.failed + (u.failed ?? 0),
    }),
    { calls: 0, gemma: 0, gemmaAttempts: 0, sonnet: 0, sonnetAttempts: 0, timedOut: 0, failed: 0 },
  )
  return {
    days: entries.length,
    ...s,
    gemmaSuccessRate: s.gemmaAttempts > 0 ? s.gemma / s.gemmaAttempts : null,
    timedOutRate: s.calls > 0 ? s.timedOut / s.calls : null,
  }
}

/**
 * #995 — one-line Discord render of the trend (weekly briefing). Empty string when there were no
 * calls in the window (nothing to report — caller omits the line). `failed` is ALWAYS shown (the
 * real health signal), `timedOut` only when non-zero (a benign, by-design budget-overrun path — see
 * INLINE_ANALYSIS_BUDGET_MS), so a rising `failed` is never hidden behind a noisy timeout count.
 */
export function formatAiUsageTrendLine(trend: AiUsageTrend): string {
  if (trend.calls === 0) return ''
  const pct = trend.gemmaSuccessRate != null ? ` (${Math.round(trend.gemmaSuccessRate * 100)}%)` : ''
  const parts = [`${trend.calls} calls`, `Gemma ${trend.gemma}/${trend.gemmaAttempts}${pct}`]
  if (trend.sonnet > 0) parts.push(`Sonnet ${trend.sonnet} fallback`)
  if (trend.timedOut > 0) parts.push(`${trend.timedOut} timed out`)
  parts.push(`${trend.failed} failed`)
  return `🤖 **AI Analysis** (${trend.days}d): ${parts.join(' · ')}`
}

/**
 * Run ONE analysis under a cancellable wall-clock budget and book it into `ai:usage`.
 *
 * This is the cron's first-sighting inline call, extracted so the budget wiring is testable at
 * the site the #955 Part-2 bug actually lived. Until #955 the cron raced the hybrid analysis
 * against a bare 8s timer, which never cancelled the in-flight fetch — a
 * Sonnet response arriving at 9s was paid for, discarded, and booked as `failed`. Here the
 * `AbortSignal` reaches the fetch, the timer is always cleared, and a budget overrun is recorded
 * as `timedOut` rather than `failed`.
 *
 * Never throws: a throw from the analysis is booked as `unknown` and returned, so the caller's
 * alert path is never taken down by the analysis.
 */
export async function analyzeIncidentWithBudget(
  kv: KVLike,
  apiKey: string | undefined,
  ai: Ai | undefined,
  // #1080 — takes the id AND the name as one object rather than two adjacent strings. The id is what
  // `ai:usage.timedOutBy` books and what the alert-scope sets are keyed by (`alerts.ts`), while the name is what
  // the prompt reads; as two positional strings they would be silently transposable, and a swap would
  // produce attribution that looks right and answers nothing.
  service: { id: string; name: string },
  currentIncident: { id: string; title: string; status: string; startedAt: string; impact: string | null; timeline?: Array<{ stage: string; text: string | null; at: string }> },
  allIncidents: Incident[],
  historyRecords: IncidentHistoryRecord[] = [],
  budgetMs: number = INLINE_ANALYSIS_BUDGET_MS,
  now: number = Date.now(),
  analyzeFn: typeof analyzeIncidentDetailed = analyzeIncidentDetailed,
): Promise<AnalysisAttempt> {
  const ctrl = new AbortController()
  // The tally the analysis mutates as it goes. When the budget wins we stop AWAITING the analysis
  // but it keeps running, so this is the only honest way to report which models were called.
  const counter: AttemptCounter = { gemma: 0, sonnet: 0 }

  let timer: ReturnType<typeof setTimeout> | undefined
  const BUDGET = Symbol('budget')
  const budget = new Promise<typeof BUDGET>((resolve) => {
    timer = setTimeout(() => {
      // Abort first: this genuinely cancels an in-flight Sonnet fetch (it takes an AbortSignal),
      // so a response nobody will read is not paid for. Gemma has no abort hook.
      ctrl.abort()
      resolve(BUDGET)
    }, budgetMs)
  })

  let attempt: AnalysisAttempt
  try {
    // Race the analysis's ORDINARY promise. This is the level the pre-#955 code raced at, and it
    // is the right one: the analysis is a plain async function, so racing it is safe, whereas the
    // Gemma leg inside is an un-cancellable Workers-AI subrequest that must simply be awaited.
    const raced = await Promise.race([
      analyzeFn(apiKey, service.name, currentIncident, allIncidents, undefined, ai, historyRecords, ctrl.signal, counter),
      budget,
    ])
    attempt = raced === BUDGET
      ? { result: null, failure: 'aborted', attempts: { ...counter } }
      : raced
  } catch (err) {
    console.error('[ai] inline analysis threw:', err instanceof Error ? err.message : err)
    attempt = { result: null, failure: 'unknown', attempts: { ...counter } }
  } finally {
    // The Promise executor runs synchronously, so `timer` is always assigned by now — the guard
    // is for the type checker, which cannot see that.
    if (timer !== undefined) clearTimeout(timer)
  }
  await recordUsage(kv, now, attempt, service.id)
  return attempt
}

/** Read-modify-write the daily counters. Best-effort — bookkeeping never fails an analysis. */
export async function recordUsage(kv: KVLike, now: number, attempt: AnalysisAttempt, svcId: string): Promise<void> {
  try {
    const usageKey = `ai:usage:${new Date(now).toISOString().split('T')[0]}`
    const usage = applyAttempt(parseUsage(await kv.get(usageKey).catch(() => null)), attempt, svcId)
    // #995 — 30d TTL (was 2d) so the Gemma-success / timedOut / failed trend survives long enough to
    // answer "is the timeout/fallback rate rising?" (the weekly briefing reads these; #995). One
    // write/day per date key already; only the retention window changes.
    await kvPut(kv, usageKey, JSON.stringify(usage), { expirationTtl: AI_USAGE_TTL_S })
  } catch (err) {
    console.warn('[ai] ai:usage counter bump failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * #1080 / #882 — book one AI-hold lifecycle event into the same daily key.
 *
 * Shares `ai:usage:{date}` rather than opening a second key: it is the same daily question ("did the
 * AI path do its job today?"), and the KV write budget is per-key-per-day, so folding these in costs
 * no new keys. Best-effort and never throws, exactly like `recordUsage` — an alert must never be lost
 * to bookkeeping. Inherits the same read-modify-write raciness, so treat the counts as near-exact.
 */
export async function recordHoldEvent(kv: KVLike, now: number, event: AiHoldEvent): Promise<void> {
  try {
    const usageKey = `ai:usage:${new Date(now).toISOString().split('T')[0]}`
    const usage = applyHoldEvent(parseUsage(await kv.get(usageKey).catch(() => null)), event)
    await kvPut(kv, usageKey, JSON.stringify(usage), { expirationTtl: AI_USAGE_TTL_S })
  } catch (err) {
    console.warn('[ai] ai:usage hold-event bump failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * How long an incident is locked out of re-analysis after a failure.
 *
 * #955 Part 4: this used to be a flat 30 minutes for EVERY failure, written by
 * `refreshOrReanalyze` on both the null and the throw path. With a five-minute cron that skips
 * the next six cycles — and because the lock is keyed per incident, not per model, a single
 * transient Gemma parse failure that fell through to a broken Sonnet froze the incident for
 * half an hour even though Gemma would have succeeded on the very next cycle. It also
 * out-lived the #882 `AI_HOLD_MS` (~10min) window, guaranteeing an AI-less alert.
 *
 * Only a `permanent` failure earns the long lock now.
 */
export function reanalysisLockTtlSec(failure: AnalysisFailureKind): number {
  switch (failure) {
    case 'permanent': return 1800  // 30min — a bad model id / missing key won't fix itself
    case 'unknown': return 300     // one cron cycle — an unexpected throw, don't hammer
    case 'transient': return 0     // 429/5xx — retry on the next cycle
    case 'aborted': return 0       // our budget, not theirs — retry on the next cycle
  }
}

// ── TTL Refresh + Re-analysis for active incidents ──

export type { KVLike } from './utils'

export interface RefreshResult {
  refreshed: string[]   // svcIds where TTL was refreshed
  reanalyzed: string[]  // svcIds where re-analysis was triggered
  skipped: string[]     // svcIds skipped due to cooldown or cap
}

/**
 * For each active service and each of its active incidents:
 * - If analysis exists in KV: refresh TTL (every ~30min)
 * - If analysis missing: re-analyze (max `cap` per call, 30min cooldown on failure)
 *
 * KV key: ai:analysis:{svcId}:{incidentId} (per-incident)
 */
export async function refreshOrReanalyze(
  activeServices: ServiceStatus[],
  kv: KVLike,
  apiKey: string | undefined,
  // #955 — the detailed variant: `refreshOrReanalyze` needs the FAILURE KIND to decide how long
  // (if at all) to lock the incident out of re-analysis. See `reanalysisLockTtlSec`.
  analyzeFn: typeof analyzeIncidentDetailed,
  cap = 2,
  now = Date.now(),
  ai?: Ai,
  // #633 — incidents currently held by the first-seen confirmation gate. They have no analysis key
  // yet and must NOT be analyzed this cycle (a sub-10min flap blip would otherwise burn one
  // Gemma/Sonnet call on a phantom). They get analyzed normally on the confirm cycle when the
  // held alert fires. Empty by default → no behavior change for callers that don't pass it.
  heldIncIds: Set<string> = new Set(),
): Promise<RefreshResult> {
  const result: RefreshResult = { refreshed: [], reanalyzed: [], skipped: [] }
  let reAnalysisCount = 0
  // Track incidentId → KV key for dedup (same incident across multiple services)
  const analyzedIncidents = new Map<string, string>()

  for (const svc of activeServices) {
    // #703 — collapse xAI per-region incidents (same event, different region) to ONE, so a 2-region
    // xAI event is analyzed once (not twice) and the Analyze modal shows a single entry. No-op for
    // every non-xAI service (only xAI titles carry the `[API (<region>.api.x.ai)]` prefix).
    const activeIncs = collapseXaiRegionalIncidents(
      (svc.incidents ?? []).filter(i => i.status !== 'resolved' && !heldIncIds.has(i.id)),
    )
    if (activeIncs.length === 0) continue

    for (const inc of activeIncs) {
      const key = analysisKey(svc.id, inc.id)
      const raw = await kv.get(key).catch(() => null)

      if (raw) {
        try {
          const parsed = JSON.parse(raw)
          // #299: sticky analyses (manual operator overrides) are never re-analyzed
          // while the incident is active — only TTL-refreshed. Clears naturally on
          // incident resolution (resolvedAt write overwrites this key with 2h TTL).
          if (parsed.sticky === true) {
            parsed._lastRefresh = new Date(now).toISOString()
            await putAnalysis(kv, svc.id, inc.id, parsed, parsed, 3600)
            analyzedIncidents.set(inc.id, key)
            result.refreshed.push(svc.id)
            continue
          }
          // Time-based re-analysis: if 2h+ old, attempt update without deleting old analysis first
          const analysisAge = now - new Date(parsed.analyzedAt).getTime()
          if (analysisAge >= 7_200_000 && (apiKey || ai) && reAnalysisCount < cap) {
            // Check if estimated recovery time has been exceeded (relative to incident start, not analysis time)
            // Fallback: if estimatedRecoveryHours not stored (pre-deployment data), parse from estimatedRecovery string
            const estHours = typeof parsed.estimatedRecoveryHours === 'number' && parsed.estimatedRecoveryHours > 0
              ? parsed.estimatedRecoveryHours
              : (parsed.estimatedRecovery ? parseRecoveryHours(parsed.estimatedRecovery) : null)
            const incidentAge = now - new Date(inc.startedAt).getTime()
            const recoveryExceeded = estHours != null && incidentAge > estHours * 3_600_000

            // Skip re-analysis if timeline hasn't changed since last analysis
            // UNLESS recovery time has been exceeded (stale prediction must be updated)
            const latestTimelineAt = inc.timeline?.at(-1)?.at ?? ''
            const hashTime = parsed.timelineHash ? new Date(parsed.timelineHash).getTime() : 0
            const latestTime = latestTimelineAt ? new Date(latestTimelineAt).getTime() : 0
            if (parsed.timelineHash && hashTime === latestTime && !recoveryExceeded) {
              // No new timeline updates — just refresh TTL, skip API call
              parsed._lastRefresh = new Date(now).toISOString()
              await putAnalysis(kv, svc.id, inc.id, parsed, parsed, 3600)
              analyzedIncidents.set(inc.id, key)
              result.refreshed.push(svc.id)
              continue
            }
            // Skip if new timeline entries are all boilerplate (no technical detail)
            // UNLESS recovery time has been exceeded
            if (parsed.timelineHash && !recoveryExceeded) {
              const newEntries = (inc.timeline ?? []).filter(t => new Date(t.at).getTime() > hashTime)
              if (newEntries.length > 0 && newEntries.every(t => isBoilerplate(t.text))) {
                // Update timelineHash to avoid rechecking, but skip API call
                parsed.timelineHash = latestTimelineAt
                parsed._lastRefresh = new Date(now).toISOString()
                await putAnalysis(kv, svc.id, inc.id, parsed, parsed, 3600)
                analyzedIncidents.set(inc.id, key)
                result.refreshed.push(svc.id)
                continue
              }
            }
            // Build previous prediction context for re-analysis prompt
            const prevPrediction = recoveryExceeded && estHours
              ? { estimatedRecoveryHours: estHours, elapsedHours: incidentAge / 3_600_000 }
              : undefined
            reAnalysisCount++
            try {
              // #827 — RAG grounding from this service's durable history (read lazily here, only
              // when actually re-analyzing — capped at `cap`/cron — not for every TTL refresh).
              const svcHistory = await readIncidentHistory(kv, svc.id)
              const attempt = await analyzeFn(
                apiKey, svc.name,
                { id: inc.id, title: inc.title, status: inc.status, startedAt: inc.startedAt, impact: inc.impact, timeline: inc.timeline },
                svc.incidents ?? [],
                prevPrediction,
                ai,
                svcHistory,
              )
              await recordUsage(kv, now, attempt, svc.id)
              if (attempt.result) {
                // #1003 — this overwrite is exactly where the original prediction used to die. The
                // re-analysis above was handed `prevPrediction`, whose prompt forbids an upper bound
                // below the elapsed hours, so `attempt.result` is hindsight-inflated by construction;
                // carry the pre-inflation estimate forward so resolution still grades against it.
                await putAnalysis(kv, svc.id, inc.id, attempt.result, parsed, 3600)
                analyzedIncidents.set(inc.id, key)
                result.reanalyzed.push(svc.id)
              } else {
                // Keep old analysis, just refresh TTL. No lock here — this branch already has a
                // usable analysis, so retrying every cycle costs nothing extra.
                console.warn(`[ai] time-based re-analysis produced nothing (${attempt.failure}) for ${svc.id}:${inc.id}, keeping old`)
                parsed._lastRefresh = new Date(now).toISOString()
                await putAnalysis(kv, svc.id, inc.id, parsed, parsed, 3600)
                result.refreshed.push(svc.id)
              }
            } catch (err) {
              console.warn(`[ai] time-based re-analysis failed for ${svc.id}:${inc.id}:`, err instanceof Error ? err.message : err)
              // A throw never reached the counters before #955 — not even `calls`.
              await recordUsage(kv, now, { result: null, failure: 'unknown', attempts: { gemma: 0, sonnet: 0 } }, svc.id)
              // Keep old analysis on failure
              parsed._lastRefresh = new Date(now).toISOString()
              await putAnalysis(kv, svc.id, inc.id, parsed, parsed, 3600)
              result.refreshed.push(svc.id)
            }
            continue
          } else if (analysisAge >= 7_200_000) {
            // Cap exhausted or no API key — don't refresh TTL, let it expire for next cycle
            analyzedIncidents.set(inc.id, key)
            continue
          }
          // Valid analysis — register for sibling dedup
          analyzedIncidents.set(inc.id, key)
          // Refresh TTL if last refresh was 30+ min ago
          const lastRefresh = parsed._lastRefresh ?? parsed.analyzedAt
          const elapsed = now - new Date(lastRefresh).getTime()
          if (elapsed >= 1_800_000) {
            parsed._lastRefresh = new Date(now).toISOString()
            await putAnalysis(kv, svc.id, inc.id, parsed, parsed, 3600)
            result.refreshed.push(svc.id)
          }
          continue
        } catch (err) {
          console.warn(`[ai] Failed to parse analysis for ${svc.id}:${inc.id}:`, err instanceof Error ? err.message : err)
        }
      }

      // No analysis — attempt re-analysis or copy from sibling with same incidentId
      // Dedup: check if another service already has analysis for the same incidentId
      const siblingKey = analyzedIncidents.get(inc.id)
      if (siblingKey) {
        const sibling = parseAnalysis(await kv.get(siblingKey).catch(() => null))
        if (sibling) {
          // #1003 — copy through `putAnalysis` rather than byte-for-byte, so THIS service also gets its
          // own durable `ai:first-est:` pin. Copying the raw value carried the baseline inside the
          // value but pinned nothing: if this service's analysis key later lapsed (cap exhaustion) while
          // the pinned sibling's didn't, its next fresh analysis would adopt a hindsight-inflated
          // estimate as "the first" — the same bug, one service over. `prior = sibling` so the sibling's
          // FIRST estimate wins over its (possibly re-analyzed, inflated) current one.
          await putAnalysis(kv, svc.id, inc.id, sibling, sibling, 3600)
          analyzedIncidents.set(inc.id, key)
          result.reanalyzed.push(svc.id)
          continue
        }
      }

      if (!(apiKey || ai) || reAnalysisCount >= cap) {
        result.skipped.push(svc.id)
        continue
      }

      // Skip generic incidents with no actionable detail (e.g., "Investigating an issue")
      if (isGenericIncident(inc.title, inc.timeline)) {
        result.skipped.push(svc.id)
        continue
      }

      // Outcome-scaled cooldown after failure (per-incident) — see `reanalysisLockTtlSec`.
      const skipKey = `ai:reanalysis-skip:${svc.id}:${inc.id}`
      const skipped = await kv.get(skipKey).catch(() => null)
      if (skipped) {
        result.skipped.push(svc.id)
        continue
      }

      reAnalysisCount++
      try {
        // #827 — RAG grounding from this service's durable history (read lazily — only on an
        // actual re-analysis, capped per cron).
        const svcHistory = await readIncidentHistory(kv, svc.id)
        const attempt = await analyzeFn(
          apiKey,
          svc.name,
          { id: inc.id, title: inc.title, status: inc.status, startedAt: inc.startedAt, impact: inc.impact, timeline: inc.timeline },
          svc.incidents ?? [],
          undefined,
          ai,
          svcHistory,
        )
        await recordUsage(kv, now, attempt, svc.id)

        if (attempt.result) {
          // No prior analysis on this KEY (the `if (raw)` branch above `continue`d otherwise) — but the
          // key may have LAPSED mid-incident (cap exhaustion; see `firstEstimateKey`), in which case
          // this estimate was made hours in and is NOT a hindsight-free baseline. `pinFirstEstimate`
          // reads the durable key, so the original bound still wins when one was ever pinned.
          await putAnalysis(kv, svc.id, inc.id, attempt.result, null, 3600)
          analyzedIncidents.set(inc.id, key)
          result.reanalyzed.push(svc.id)
        } else {
          const failure = attempt.failure ?? 'unknown'
          console.warn(`[ai] re-analysis produced nothing (${failure}) for ${svc.id}:${inc.id}`)
          // A transient/aborted failure retries on the NEXT cron cycle, which lands inside the
          // #882 AI-hold window — so the alert can still ship WITH its analysis (#955 Part 4).
          const ttl = reanalysisLockTtlSec(failure)
          if (ttl > 0) await kvPut(kv, skipKey, '1', { expirationTtl: ttl })
          result.skipped.push(svc.id)
        }
      } catch (err) {
        console.warn(`[ai] re-analysis failed for ${svc.id}:${inc.id}:`, err instanceof Error ? err.message : err)
        await recordUsage(kv, now, { result: null, failure: 'unknown', attempts: { gemma: 0, sonnet: 0 } }, svc.id)
        await kvPut(kv, skipKey, '1', { expirationTtl: reanalysisLockTtlSec('unknown') })
        result.skipped.push(svc.id)
      }
    }
  }

  return result
}

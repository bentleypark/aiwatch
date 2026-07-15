// Durable incident history — #827 Phase 1 keystone.
//
// At resolution, the AI prediction (ai:analysis:*, 1h/2h TTL) and the actual
// recovery time (recovered:*, 2h TTL) BOTH exist for ~2 hours, then expire —
// and the permanent monthly archive keeps only incident metadata, no AI fields.
// So today nothing joins "what the AI predicted" with "what actually happened",
// and the AI summaries needed for retrieval-augmented analysis are gone within
// hours.
//
// This module persists ONE durable record per resolved incident, joining the
// prediction with the actual outcome. That single record is simultaneously:
//   - the prediction-accuracy ledger (#827 Feature 1), and
//   - the RAG corpus future analyses retrieve from (#827 Feature 2).
//
// Storage: a rolling per-service list at `incident:history:{svcId}` with NO TTL
// (durable), capped to the most-recent HISTORY_CAP records to keep the KV value
// bounded. Writes are best-effort — a KV failure is logged and swallowed so it
// can never abort the cron's recovery flow.

import type { KVLike } from './utils'
import { kvPut } from './utils'
import type { Incident } from './types'

/** One durable resolved-incident record. `predicted*`/`affectedScope`/`model`
 *  are present only when an AI analysis existed at resolution time — a record is
 *  still written without them (the actual outcome alone is corpus-worthy). */
export interface IncidentHistoryRecord {
  svcId: string
  incId: string
  title: string
  provider: string
  category: 'api' | 'app' | 'agent'
  impact: 'minor' | 'major' | 'critical' | null
  startedAt: string
  resolvedAt: string
  /** Actual duration in minutes (startedAt → resolvedAt). */
  durationMin: number
  /** AI-predicted recovery, upper bound of the range in hours — the FIRST estimate made for the
   *  incident (`scoringBaselineHours` → `AIAnalysisResult.firstEstimatedRecoveryHours`, falling back
   *  to `estimatedRecoveryHours` for pre-#1003 analyses). Explicitly NOT the current estimate: a
   *  re-analysis only fires on an incident that outran its prediction and can only raise the bound,
   *  so grading against it scored every miss as a win (#1003). Absent when no analysis. */
  predictedRecoveryHours?: number
  /** AI summary text at resolution. Absent when no analysis. */
  predictedSummary?: string
  affectedScope?: string[]
  model?: 'gemma' | 'sonnet'
}

/** Rolling per-service durable history key (no TTL). */
export function historyKey(svcId: string): string {
  return `incident:history:${svcId}`
}

/** Max records retained per service. 50 × ~0.4KB ≈ 20KB — well under the KV
 *  25MB value limit, while covering many months of a service's incidents. */
export const HISTORY_CAP = 50

/** Actual incident duration in whole minutes. Returns 0 for malformed or
 *  out-of-order timestamps (never negative). */
export function durationMinOf(startedAt: string, resolvedAt: string): number {
  const start = new Date(startedAt).getTime()
  const end = new Date(resolvedAt).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0
  return Math.round((end - start) / 60000)
}

/** How the AI's predicted recovery compared to reality. The prediction is the
 *  UPPER BOUND of a range ("1–3h" → 3h via parseRecoveryHours), so:
 *    - actual > predicted upper bound        → the model was too optimistic
 *    - actual far below the predicted bound   → the model was too pessimistic
 *    - actual within a sensible band of it    → accurate
 *  Pure — reused by the prompt grounding (PR-B) and the monthly accuracy
 *  aggregate (Feature 1). */
export type AccuracyVerdict = 'accurate' | 'over-predicted' | 'under-predicted' | 'unknown'

/**
 * #1003 — the estimate a resolved incident is SCORED against: the first, hindsight-free prediction.
 *
 * `estimatedRecoveryHours` is the CURRENT estimate, which re-analysis ratchets upward once an
 * incident outruns its own prediction (the re-analysis prompt forbids an upper bound below the
 * elapsed hours). Scoring against it inverted the verdict on exactly the incidents the model got
 * wrong: Pinecone was first estimated 1–4h, re-estimated ~15h at the 4h mark, recovered at 4h 55m,
 * and shipped as "faster than ~15h est." — a win, when it was really a near-miss over the 4h bound.
 *
 * Every surface that compares predicted-vs-actual (Discord recovery embed, Slack /feed, the durable
 * history corpus and the accuracy aggregate + RAG grounding built from it) reads this. Live surfaces
 * — the ongoing-incident ETA, `recoveryExceeded` — must keep using `estimatedRecoveryHours`.
 *
 * Falls back to the current estimate when no first estimate was recorded (analyses written before
 * this shipped), so an in-flight incident at deploy time still gets a comparison line.
 *
 * NOTE the SPA mirror (`baselineHoursFrom`) has one extra fallback rung: it also parses the display
 * STRING ("2–4h" → 4) when no numeric field exists at all. That asymmetry predates #1003 (the worker
 * has never string-parsed here) and only shows on analyses old enough to lack `estimatedRecoveryHours`
 * entirely, which the 1h/2h TTL makes vanishingly rare — a very old analysis can therefore render a
 * comparison in the modal that Discord/`/feed`/the corpus omit.
 */
export function scoringBaselineHours(
  analysis: { estimatedRecoveryHours?: number; firstEstimatedRecoveryHours?: number } | null | undefined,
): number | null {
  const first = analysis?.firstEstimatedRecoveryHours
  if (typeof first === 'number' && first > 0) return first
  const current = analysis?.estimatedRecoveryHours
  return typeof current === 'number' && current > 0 ? current : null
}

export function accuracyOf(rec: { predictedRecoveryHours?: number; durationMin: number }): AccuracyVerdict {
  const predicted = rec.predictedRecoveryHours
  if (predicted == null || predicted <= 0) return 'unknown'
  const actualHours = rec.durationMin / 60
  if (actualHours > predicted) return 'under-predicted'   // took longer than the predicted upper bound
  if (actualHours < predicted * 0.5) return 'over-predicted' // recovered far faster than predicted
  return 'accurate'                                        // landed within [0.5×, 1×] of the bound
}

/** Keep only a model value inside the AIAnalysisResult union. The cron only ever
 *  stores 'gemma'/'sonnet', but normalizing on write means a future drift (e.g. a
 *  raw model id leaking in) can never put an off-union string into the durable
 *  corpus. */
function normalizeModel(model: string | undefined): { model?: 'gemma' | 'sonnet' } {
  return model === 'gemma' || model === 'sonnet' ? { model } : {}
}

const MAX_TITLE = 200
const MAX_SUMMARY = 500

/**
 * Build a durable history record from a just-recovered service's incident, joining
 * the AI prediction (when an analysis existed at resolution) with the actual outcome.
 * Pure — so the gating + field mapping are unit-testable apart from the cron/KV.
 *
 * Returns null (skip) unless the incident is in a terminal/near-terminal state:
 *   - `resolved`  — done.
 *   - `monitoring` — fix deployed, service already back to operational (#550 lets a
 *     service edge to operational while an incident is still `monitoring`; the
 *     recovery alert fires on the SERVICE-status edge, so there may be no later
 *     edge when it finally flips to `resolved` → recording here closes that gap).
 * `investigating`/`identified` at a recovery edge are intentionally NOT recorded —
 * stamping a still-diagnosing incident as resolved would mis-measure its duration.
 *
 * Duration is measured to the incident's own `resolvedAt` when present (the source's
 * authoritative resolution time), else to `now` (the recovery-detection cycle) — the
 * latter for `monitoring`, which has no `resolvedAt` yet. Title/summary are length-
 * capped so the per-service value stays honestly bounded.
 */
export function buildHistoryRecord(
  svc: { id: string; provider: string; category: 'api' | 'app' | 'agent' },
  inc: { id: string; title?: string; impact?: 'minor' | 'major' | 'critical' | null; status: string; startedAt?: string; resolvedAt?: string | null },
  analysis: { estimatedRecoveryHours?: number; firstEstimatedRecoveryHours?: number; summary?: string; affectedScope?: string[]; model?: string } | null,
  now: string,
): IncidentHistoryRecord | null {
  if (!inc.startedAt) return null
  if (inc.status !== 'resolved' && inc.status !== 'monitoring') return null
  const resolvedAt = inc.resolvedAt ?? now
  // #1003 — the durable record is the ledger the accuracy aggregate AND the RAG grounding are built
  // from, so it must store the hindsight-free baseline, not the re-analysis-inflated current estimate.
  const predicted = scoringBaselineHours(analysis)
  return {
    svcId: svc.id,
    incId: inc.id,
    title: (inc.title ?? '').slice(0, MAX_TITLE),
    provider: svc.provider,
    category: svc.category,
    impact: inc.impact ?? null,
    startedAt: inc.startedAt,
    resolvedAt,
    durationMin: durationMinOf(inc.startedAt, resolvedAt),
    ...(predicted != null && { predictedRecoveryHours: predicted }),
    ...(analysis?.summary && { predictedSummary: analysis.summary.slice(0, MAX_SUMMARY) }),
    ...(analysis?.affectedScope?.length ? { affectedScope: analysis.affectedScope } : {}),
    ...normalizeModel(analysis?.model),
  }
}

/**
 * Append one or more resolved-incident records for a SINGLE service in ONE
 * read-modify-write. Batching is the fix for the lost-update race when a service
 * resolves ≥2 incidents in the same cron cycle: the cron's recovery handler runs
 * its per-incident work inside `Promise.all`, so racing one RMW per incident
 * against the shared `incident:history:{svcId}` key would drop all but the last
 * write. The caller collects records during the map, then calls this once.
 *
 * Idempotent (dedups by incId against existing + within the batch); caps to the
 * most-recent HISTORY_CAP (newest last); records whose svcId doesn't match are
 * ignored (guards against a mixed-service batch). Best-effort — returns false
 * (and logs) on any KV error or corrupt value rather than throwing, so the
 * caller's recovery flow is never aborted.
 */
export async function appendIncidentHistoryBatch(
  kv: KVLike,
  svcId: string,
  records: IncidentHistoryRecord[],
): Promise<boolean> {
  if (records.length === 0) return true
  const key = historyKey(svcId)
  try {
    // NOTE: a get THROW must NOT be swallowed to null here — unlike a genuine miss, treating a
    // transient read failure as "empty" would make the kvPut below overwrite the entire durable,
    // no-TTL corpus with only this batch (losing up to HISTORY_CAP-1 prior records). Let it throw
    // → the outer catch returns false (best-effort) and the existing corpus is left intact.
    const raw = await kv.get(key)
    let list: IncidentHistoryRecord[] = []
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) list = parsed
      } catch {
        // corrupt value — start fresh rather than lose this write
      }
    }
    const seen = new Set(list.map(r => r.incId))
    let added = false
    for (const rec of records) {
      if (rec.svcId !== svcId || seen.has(rec.incId)) continue // wrong-service / already recorded
      seen.add(rec.incId)
      list.push(rec)
      added = true
    }
    if (!added) return true // nothing new — idempotent no-op
    if (list.length > HISTORY_CAP) list = list.slice(list.length - HISTORY_CAP)
    return await kvPut(kv, key, JSON.stringify(list)) // no TTL → durable
  } catch (err) {
    console.warn('[incident-history] batch append failed:', svcId, err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Append a single resolved-incident record. Thin wrapper over
 * appendIncidentHistoryBatch (same idempotency / cap / best-effort semantics).
 */
export function appendIncidentHistory(kv: KVLike, record: IncidentHistoryRecord): Promise<boolean> {
  return appendIncidentHistoryBatch(kv, record.svcId, [record])
}

/** Read the durable history for one service (newest last). Returns [] on miss,
 *  corrupt value, or KV error — a read failure must never break a caller. */
export async function readIncidentHistory(kv: KVLike, svcId: string): Promise<IncidentHistoryRecord[]> {
  try {
    const raw = await kv.get(historyKey(svcId)).catch(() => null)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Title tokenizer — lowercased words >3 chars, same split as ai-analysis.ts
 *  `findSimilarIncidents`. */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s\-—·:,]+/).filter(w => w.length > 3)
}

/**
 * Retrieve the past resolved incidents most similar to a current one, for RAG
 * grounding (#827 Feature 2). Scores by title-token overlap (dominant) using the
 * SAME substring containment as `findSimilarIncidents` (so "error" matches a past
 * "errors" — exact token-set membership would miss such morphological variants),
 * plus a small same-category bonus that ONLY applies once a record already has
 * title overlap (so category never surfaces a zero-title-overlap record as noise
 * — relevant once the Phase 3 graph starts passing a cross-category cohort).
 *
 * Pure and **cross-service-capable** — the caller decides the candidate set:
 * Phase 1 passes the same service's own history (a single KV read); Phase 3's
 * graph will pass a provider/category cohort. Records whose `incId` equals
 * `excludeIncId` (the current incident) are skipped so it never grounds on itself.
 */
export function findSimilarHistory(
  current: { title: string; category?: string },
  records: IncidentHistoryRecord[],
  limit = 3,
  excludeIncId?: string,
): IncidentHistoryRecord[] {
  const titleTokens = tokenize(current.title)
  if (titleTokens.length === 0) return []
  return records
    .filter(r => r.incId !== excludeIncId)
    .map(r => {
      const titleLower = r.title.toLowerCase()
      let score = titleTokens.filter(t => titleLower.includes(t)).length * 2
      if (score > 0 && current.category && r.category === current.category) score += 1 // tiebreak only
      return { r, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.r.resolvedAt.localeCompare(a.r.resolvedAt))
    .slice(0, limit)
    .map(x => x.r)
}

/** Format a whole-minute duration as compact human text: "45m", "1h", "3h 10m". */
export function formatDurationMin(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return '0m'
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

/**
 * One-line "predicted vs actual" recovery phrase for alert/feed surfaces (#827 F4) — the worker/EN
 * mirror of the SPA `predictionAccuracy.js` wording. Leads with the ACTUAL recovery and folds the
 * estimate + direction into one fragment (accuracyOf bands), e.g.:
 *   accurate → "42m (within ~1h est.)"   under → "3h 10m (over ~1h est.)"   over → "20m (faster than ~3h est.)"
 * Returns null when the record carries no prediction (nothing to compare against).
 */
export function predictedVsActualText(rec: { predictedRecoveryHours?: number; durationMin: number }): string | null {
  if (rec.predictedRecoveryHours == null || rec.predictedRecoveryHours <= 0) return null
  const predText = formatDurationMin(Math.round(rec.predictedRecoveryHours * 60))
  const actualText = formatDurationMin(rec.durationMin)
  const verdict = accuracyOf(rec)
  const within = verdict === 'under-predicted' ? `over ~${predText} est.`
    : verdict === 'over-predicted' ? `faster than ~${predText} est.`
    : `within ~${predText} est.`
  return `${actualText} (${within})`
}

/** Resolution timestamp for an incident: explicit `resolvedAt`, else the last `resolved`
 *  timeline entry, else the last timeline entry, else `startedAt` (so a duration derived from
 *  it is never negative). Shared by the Slack `/feed` resolved item (rss.ts) and the Discord
 *  Incident-Resolved embed (#846) so both surfaces measure the SAME actual recovery time. */
export function resolvedAtOf(inc: Incident): string {
  if (inc.resolvedAt) return inc.resolvedAt
  for (let i = inc.timeline.length - 1; i >= 0; i--) {
    if (inc.timeline[i].stage === 'resolved') return inc.timeline[i].at
  }
  return inc.timeline.length > 0 ? inc.timeline[inc.timeline.length - 1].at : inc.startedAt
}

/** #846 — plain-text "🎯 AI prediction: …" line for the Discord Incident-Resolved embed, matching
 *  the Slack `/feed` line (rss.ts `descHtml`). Returns null when the analysis carried no numeric
 *  estimate (model returned `N/A`/unparseable, or no analysis existed) — the line is omitted rather
 *  than fabricating a comparison. `actual` = startedAt→resolvedAtOf, identical to the /feed side.
 *
 *  #1003 — takes the ANALYSIS, not a bare number, so a caller cannot hand it the re-analysis-inflated
 *  `estimatedRecoveryHours`: the baseline choice lives in `scoringBaselineHours` and the type checker
 *  enforces it at every call site. */
export function resolvedPredictionLine(
  analysis: { estimatedRecoveryHours?: number; firstEstimatedRecoveryHours?: number } | null | undefined,
  inc: Incident,
): string | null {
  const predicted = scoringBaselineHours(analysis)
  if (predicted == null) return null
  const pva = predictedVsActualText({
    predictedRecoveryHours: predicted,
    durationMin: durationMinOf(inc.startedAt, resolvedAtOf(inc)),
  })
  return pva ? `🎯 AI prediction: ${pva}` : null
}

/** Aggregate prediction-accuracy stats over a set of history records (#827
 *  Feature 1). Only records carrying a prediction count toward the rates. */
export interface AccuracyStats {
  total: number             // records that had a prediction (the denominator)
  accurate: number          // actual landed within [0.5×, 1×] of the predicted upper bound
  underPredicted: number    // actual exceeded the prediction (we were too optimistic)
  overPredicted: number     // actual far below the prediction (we were too cautious)
  hitRate: number           // accurate / total, 0..1 (0 when total === 0)
  medianAbsErrorHours: number // median |actualHours − predictedHours| (0 when total === 0)
}

/** Median of a numeric list (0 for empty). Pure helper. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

/**
 * Aggregate prediction accuracy across history records (#827 Feature 1). Records
 * without a prediction are ignored (they carry an actual outcome but nothing to
 * score against). Pure — the caller supplies the record set (e.g. the flattened
 * cross-service corpus) and decides any time window. Sample is inherently small
 * (a handful of resolved incidents/day), so this is meaningful only in aggregate.
 */
export function summarizeAccuracy(records: IncidentHistoryRecord[]): AccuracyStats {
  // #847 — a grouped incident (one incId shared across sibling surfaces, e.g. Anthropic's Claude API /
  // claude.ai / Claude Code) writes one record PER affected service so each surface's RAG corpus is
  // complete. That would multi-count the SAME prediction here, inflating the denominator + skewing the
  // hit-rate. Collapse to one record per incId first (siblings share the deduped analysis, so any is
  // representative) so accuracy is measured per INCIDENT, not per affected surface.
  const byIncId = new Map<string, IncidentHistoryRecord>()
  for (const r of records) {
    const existing = byIncId.get(r.incId)
    // Prefer a record that actually carries a prediction (defensive — siblings normally all do).
    if (!existing || (existing.predictedRecoveryHours == null && r.predictedRecoveryHours != null)) {
      byIncId.set(r.incId, r)
    }
  }
  const withPred = [...byIncId.values()].filter(r => r.predictedRecoveryHours != null && r.predictedRecoveryHours > 0)
  let accurate = 0, underPredicted = 0, overPredicted = 0
  const absErrors: number[] = []
  for (const r of withPred) {
    const verdict = accuracyOf(r)
    if (verdict === 'accurate') accurate++
    else if (verdict === 'under-predicted') underPredicted++
    else if (verdict === 'over-predicted') overPredicted++
    absErrors.push(Math.abs(r.durationMin / 60 - (r.predictedRecoveryHours as number)))
  }
  const total = withPred.length
  return {
    total,
    accurate,
    underPredicted,
    overPredicted,
    hitRate: total > 0 ? accurate / total : 0,
    medianAbsErrorHours: median(absErrors),
  }
}

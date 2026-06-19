// AIWatch Score — service reliability composite score (0-100)

import type { ProbeSummary, ServiceStatus } from './types'
import { INCIDENT_IO_IMPACT_WEIGHTS } from './parsers/impact-weights'

export interface AIWatchScore {
  // #713 — null for a 'low'-confidence service (no official uptime AND no probe): scored on only
  // incidents+recovery, which over-scores under the rescale, so we withhold the figure entirely.
  score: number | null
  grade: 'excellent' | 'good' | 'fair' | 'degrading' | 'unstable' | null
  confidence: 'high' | 'medium' | 'low'
  breakdown: {
    uptime: number | null
    incidents: number
    recovery: number
    responsiveness: number | null
    // Mirrors probe.kind so consumers can distinguish unsupported / unavailable / insufficient
    // without re-deriving from null fields. responsiveness=null overloads 3 distinct conditions.
    responsivenessStatus: ProbeContext['kind']
  }
  metrics: {
    uptimePct: number | null
    incidents30d: number
    affectedDays30d: number
    mttrHours: number | null
    // Single nullable mirrors input ProbeContext shape — atomic vs 4 parallel-null fields.
    probe: ProbeSummary | null
  }
}

// Probe situation for a service. Caller classifies via classifyProbe(); score function only matches.
// 'unavailable' (KV read failure) is intentionally distinct from 'insufficient' (probed but <7d data) —
// only the latter applies the 0.95 confidence penalty. Conflating them would silently shave 5% off
// every probed service score on transient KV failure.
export type ProbeContext =
  | { kind: 'unsupported' }                       // service has no probe endpoint (apps, agents, infra)
  | { kind: 'available'; summary: ProbeSummary }  // probed + ≥7d valid data → full Responsiveness
  | { kind: 'insufficient' }                      // probed but <7d valid data → 0.95 penalty
  | { kind: 'unavailable' }                       // KV cache read failed → no penalty (treat like unsupported for scoring)

// Responsiveness tuning constants (validated against 7-day probe data, see #132)
export const REFERENCE_MS = 400
export const REFERENCE_CV = 0.5
export const MIN_VALID_DAYS = 7
export const P50_FLOOR_MS = 50 // prevents bimodal distributions (e.g., Claude CDN routing) from dominating

// Component maxes (sum = 100 when all four are present). #713 — the score is computed on the
// components we can actually MEASURE and rescaled to 100 by their AVAILABLE max, so a missing
// component (no official uptime, or no probe) is simply omitted — never filled with an assumed/
// estimated value. This generalizes the old "no-probe rescale 80→100" to "no-uptime" too.
const UPTIME_SCORE_MAX = 40
const INCIDENTS_SCORE_MAX = 25
const RECOVERY_SCORE_MAX = 15
const RESPONSIVENESS_SCORE_MAX = 20
const TOTAL_SCORE_MAX = 100
const INSUFFICIENT_PROBE_PENALTY = 0.95 // 5% confidence penalty for probed services lacking ≥7d data

function parseDurationMin(d: string): number {
  if (!d) return 0
  const h = d.includes('h') ? parseInt(d.split('h')[0]) : 0
  const afterH = d.includes('h') ? d.split('h')[1]?.trim() : d
  const m = afterH && afterH.includes('m') ? parseInt(afterH.replace('m', '').trim()) : 0
  return h * 60 + m
}

function scoreToGrade(score: number): 'excellent' | 'good' | 'fair' | 'degrading' | 'unstable' {
  // Tightened in #260/#261: excellent 85→90, good 70→75. Counters score inflation
  // from the weighted+filtered affectedDays — uniform shift up of ~5-15 points needs
  // the grade ladder to move in lockstep, otherwise everyone drifts to "excellent".
  if (score >= 90) return 'excellent'
  if (score >= 75) return 'good'
  if (score >= 55) return 'fair'
  if (score >= 40) return 'degrading'
  return 'unstable'
}

function computeResponsiveness(summary: ProbeSummary): { speed: number; stability: number } {
  const p50Floor = Math.max(summary.p50, P50_FLOOR_MS)
  const speed = 10 * Math.exp(-p50Floor / REFERENCE_MS)
  const stability = 10 * Math.exp(-summary.cvCombined / REFERENCE_CV)
  return { speed, stability }
}

function assertNever(x: never): never {
  throw new Error(`unhandled ProbeContext kind: ${JSON.stringify(x)}`)
}

/** Classify a service's probe situation into a ProbeContext.
 *  - isProbed: caller's source-of-truth check (e.g., PROBE_TARGETS membership)
 *  - summaries: undefined ⇒ KV cache read failed ⇒ 'unavailable' (no penalty)
 *               defined but missing svcId, or summary invalid ⇒ 'insufficient' (0.95 penalty)
 *               defined and valid ⇒ 'available' (full Responsiveness scoring) */
export function classifyProbe(
  serviceId: string,
  isProbed: boolean,
  summaries: Map<string, ProbeSummary> | undefined,
): ProbeContext {
  if (!isProbed) return { kind: 'unsupported' }
  if (summaries === undefined) return { kind: 'unavailable' }
  const summary = summaries.get(serviceId)
  if (!summary || summary.validDays < MIN_VALID_DAYS || summary.p50 <= 0) {
    return { kind: 'insufficient' }
  }
  return { kind: 'available', summary }
}

// `probe` is required — defaulting silently to 'unsupported' would re-introduce the silent-misclassify
// footgun the discriminated union was designed to prevent. Use scoreFor() helper at call sites.
export function calculateAIWatchScore(
  service: ServiceStatus,
  cutoffDays: number,
  probe: ProbeContext,
): AIWatchScore {
  const cutoff = new Date(Date.now() - cutoffDays * 86_400_000).toISOString()
  const incidents30d = (service.incidents ?? []).filter((i) => i.startedAt >= cutoff)
  const incidentCount = incidents30d.length

  // Affected days — only count incidents with measurable impact (#261).
  // null-impact entries are informational (component renames, post-mortems) — including
  // them in affected_days inflates services like cohere/groq whose feeds mix info posts
  // with real incidents, producing scores ~10pts lower than reality.
  const impactfulDays = new Set(
    incidents30d.filter((i) => i.impact != null).map((i) => i.startedAt.slice(0, 10)),
  )
  const affectedDays = impactfulDays.size

  // Weighted-day calculation for incidentScore (#260) — keeps consistency with the
  // Atlassian uptime formula (#259). Per day: take the MAX impact weight (a critical
  // outage on a day with minor advisories should count as critical, not 1.3 days).
  // Sum across days yields fractional "effective days" (e.g., 5 minor-only days = 1.5).
  // Unknown-impact telemetry: parsers other than incident-io don't warn on schema drift,
  // so this is the catch-all log for new Atlassian impact levels reaching score calc.
  const dailyMaxWeight = new Map<string, number>()
  const unknownImpacts = new Set<string>()
  for (const inc of incidents30d) {
    if (inc.impact == null) continue
    const weight = INCIDENT_IO_IMPACT_WEIGHTS[inc.impact]
    if (weight === undefined) {
      unknownImpacts.add(String(inc.impact))
      continue
    }
    const day = inc.startedAt.slice(0, 10)
    const existing = dailyMaxWeight.get(day) ?? 0
    if (weight > existing) dailyMaxWeight.set(day, weight)
  }
  if (unknownImpacts.size > 0) {
    console.warn(`[calculateAIWatchScore] ${service.id}: unknown impact level(s): ${[...unknownImpacts].join(', ')} — update INCIDENT_IO_IMPACT_WEIGHTS`)
  }
  const weightedAffectedDays = Array.from(dailyMaxWeight.values()).reduce((a, b) => a + b, 0)

  // MTTR calculation (resolved incidents with positive duration only). #707 — EXCLUDE null-impact
  // incidents: an informational/advisory event (component rename, post-mortem, compliance access-
  // revocation, deprecation) has a duration but is NOT a reliability recovery, so counting it would
  // zero the Recovery score on a service that never actually went down (symmetric with the #261
  // null-impact exclusion from affectedDays / the uptime estimate).
  const impactfulIncidents30d = incidents30d.filter((i) => i.impact != null)
  const durations = impactfulIncidents30d
    .filter((i) => i.status === 'resolved' && i.duration)
    .map((i) => parseDurationMin(i.duration!))
    .filter((m) => m > 0)

  let mttrHours: number | null = null
  if (durations.length >= 3) {
    durations.sort((a, b) => a - b)
    mttrHours = durations[Math.floor(durations.length / 2)] / 60
  } else if (durations.length > 0) {
    mttrHours = (durations.reduce((s, v) => s + v, 0) / durations.length) / 60
  }

  // Component scores on 40/25/15 scale (base = max 80, leaves 20 for Responsiveness)
  const hasUptime = service.uptime30d != null
  let uptimeScore: number | null = null
  if (hasUptime) {
    uptimeScore = Math.max(0, Math.min(40, (service.uptime30d! / 100 - 0.95) / 0.05 * 40))
  }

  // Use weighted days so a service with N minor-only days gets less penalty than
  // a service with N critical days — symmetric with the uptime weight in #259.
  const incidentScore = 25 * Math.exp(-weightedAffectedDays / 10)

  // Recovery default keys off IMPACTFUL incidents (#707): a window whose only incidents are
  // null-impact advisories has no reliability recovery to penalize → full 15, not 0.
  const recoveryScore = mttrHours != null
    ? 15 * Math.exp(-mttrHours / 4)
    : impactfulIncidents30d.length > 0 ? 0 : 15

  // Responsiveness (probe) — compute first so the rescale below knows whether it's an available
  // component. Exhaustive switch — adding a new ProbeContext kind is a compile error until handled.
  let responsivenessScore: number | null = null
  let summary: ProbeSummary | null = null
  let probeAvailable = false
  let probePenalty = 1
  switch (probe.kind) {
    case 'available': {
      summary = probe.summary
      const { speed, stability } = computeResponsiveness(summary)
      responsivenessScore = speed + stability
      probeAvailable = true
      break
    }
    case 'insufficient':
      // Probe exists but <7d valid data → no responsiveness component + a 5% confidence penalty.
      probePenalty = INSUFFICIENT_PROBE_PENALTY
      break
    case 'unsupported':
    case 'unavailable':
      break
    default:
      assertNever(probe)
  }

  // #713 — sum the AVAILABLE component scores and rescale to 100 by their available max. A service
  // with no official uptime omits the uptime component entirely (no assumed/estimated value); a
  // service with no probe omits responsiveness (the pre-#713 80→100 rescale, now a special case).
  // Backward-compatible: uptime+probe → /100 (unchanged); uptime, no probe → /80 = ×1.25 (unchanged).
  let sumScores = incidentScore + recoveryScore
  let availableMax = INCIDENTS_SCORE_MAX + RECOVERY_SCORE_MAX
  if (hasUptime) {
    sumScores += uptimeScore!
    availableMax += UPTIME_SCORE_MAX
  }
  if (probeAvailable) {
    sumScores += responsivenessScore!
    availableMax += RESPONSIVENESS_SCORE_MAX
  }
  let scoreNum = (sumScores / availableMax) * TOTAL_SCORE_MAX * probePenalty

  // Confidence by data completeness — official uptime is the strongest signal; a service scored on
  // only incidents + recovery (no official uptime, no probe — e.g. Bedrock/Azure) is 'low'.
  const confidence: 'high' | 'medium' | 'low' = hasUptime ? 'high' : probeAvailable ? 'medium' : 'low'

  scoreNum = Math.round(Math.max(0, Math.min(100, scoreNum)))
  if (scoreNum < 1) scoreNum = 0

  // #713 — a 'low'-confidence service (NEITHER official uptime NOR a probe — e.g. Bedrock/Azure) is
  // scored on only incidents + recovery (2 of 4 components), which over-scores under the rescale. We do
  // NOT surface that figure: emit a null score/grade (the breakdown + confidence stay so consumers see
  // WHY). This keeps it out of the ranking AND the detail-page score card — no hidden/misleading number.
  const score = confidence === 'low' ? null : scoreNum
  const grade = score === null ? null : scoreToGrade(score)

  return {
    score,
    grade,
    confidence,
    breakdown: {
      uptime: uptimeScore != null ? Math.round(uptimeScore * 10) / 10 : null,
      incidents: Math.round(incidentScore * 10) / 10,
      recovery: Math.round(recoveryScore * 10) / 10,
      responsiveness: responsivenessScore != null ? Math.round(responsivenessScore * 10) / 10 : null,
      responsivenessStatus: probe.kind,
    },
    metrics: {
      uptimePct: service.uptime30d ?? null,
      incidents30d: incidentCount,
      affectedDays30d: affectedDays,
      mttrHours: mttrHours != null ? Math.round(mttrHours * 10) / 10 : null,
      probe: summary,
    },
  }
}

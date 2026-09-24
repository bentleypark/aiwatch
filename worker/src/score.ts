// AIWatch Score — service reliability composite score (0-100)

import type { Incident, ProbeSummary, ServiceStatus } from './types'
import { INCIDENT_IO_IMPACT_WEIGHTS } from './parsers/impact-weights'
import { incidentDay, statedDay } from './utils'

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
    // #1002 — `Math.round((speed + stability) * 10) / 10` (not an independent rounding of the raw
    // total), so the two DISPLAYED children always round-trip to this exact parent figure. A
    // consumer summing the two published numbers with plain `+` lands within float noise (~1e-15)
    // of this value, not necessarily `===` it (IEEE-754, e.g. 6.4 + 3.7 = 10.100000000000001) —
    // round the sum before comparing, same as this file does.
    responsiveness: number | null
    // The two axes `responsiveness` is built from: how fast (speed) vs how consistent (stability),
    // each /10. Same null condition as `responsiveness` (probe.kind === 'available').
    speed: number | null
    stability: number | null
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
// #1019 Part B — small-sample MTTR robustness. A resolved-impactful sample of <3 incidents makes MTTR a
// mean/single value, so ONE incident left open long after its component recovered (paperwork inflation;
// see the #1019 duration-override layer) — or one genuinely long one-off — tanks a low-incident service's
// Recovery (15·exp(−mttr/4) collapses). `MTTR_PRIOR_MIN` is a neutral prior ≈ the cross-service median
// MTTR (~1h in observed data): "a typical AI-service incident recovers in about an hour". `MTTR_PRIOR_WEIGHT`
// counts the prior as N pseudo-incidents. See `computeMttrHours` for the ASYMMETRIC application.
export const MTTR_PRIOR_MIN = 60
export const MTTR_PRIOR_WEIGHT = 2

/** #1292 — does this incident's `duration` mean a TIME TO RECOVER?
 *
 *  For a `status_history`-derived one it does not: the source is a per-day downtime-seconds bucket
 *  with no start, no end and no recovery event, so its `duration` is "how long the service was down
 *  that day", capped at 24h. Feeding it to any mean/median MTTR is a category error, and it has a
 *  perverse sign — a handful of short synthesized days drags a median under the real incidents.
 *
 *  Three runtimes answer this same question and CANNOT share an import — the worker bundle, the SPA
 *  bundle and the Edge functions have no common module graph. So the other two MIRROR this rule
 *  (`src/utils/recovery.js`, `api/_is-down/html-template.ts`'s `isDailyRecordIncident`) and the three
 *  are pinned together by `src/utils/__tests__/derived-tag-sync.test.js`, the same treatment
 *  `service-groups.ts` gets against `SERVICE_CATEGORIES`. Both mirrors were missed on the first pass
 *  and published a day-bucket AS a recovery time while this file reported none. */
export function carriesRecoveryTime<T extends { derived?: string; startUnknown?: boolean }>(i: T): boolean {
  // #1390 — `startUnknown` is the SECOND way an incident can be impactful, resolved and in-window while
  // carrying no measurable recovery time: the provider published a record whose recovery predates its
  // start, and its page had no impact window to recover the real one, so `startedAt` is anchored on
  // `resolvedAt` and `duration` is null. Dropping it from `durations` alone is the trap the paragraph
  // above names — `recoveryCandidates` would still be non-empty, `mttrHours` null, and the default
  // below scores Recovery **0**: a fabricated worst-possible recovery replacing the fabricated `1m` the
  // repair removed, measured at -19 Score on a service whose only in-window incident is anchored. So it
  // leaves the SAMPLE, not just the durations, and Recovery abstains at full marks exactly as it does
  // when the window holds no impactful incident at all.
  //
  // The two mirrors named above need no change on this axis: `src/utils/recovery.js` and the is-down
  // MTTR line both already require a truthy `duration`, which an anchored incident does not have.
  return i.derived !== 'status_history' && !i.startUnknown
}

/** MTTR (hours) from resolved-impactful incident durations (minutes). ≥3 → the robust MEDIAN (one
 *  outlier can't move it). 1–2 → an ASYMMETRIC shrinkage toward `MTTR_PRIOR_MIN`: shrink toward the prior
 *  ONLY when the thin-sample mean is WORSE (longer) than the prior, so a single paperwork-inflated / one-off
 *  long incident can't tank a low-incident service, while a genuinely fast recovery keeps its score
 *  untouched (no churn on well-performing low-incident services). Continuous into the median as the sample
 *  grows to 3. Returns null for an empty sample (the caller picks the Recovery default). Pure — unit-tested. */
export function computeMttrHours(durationsMin: number[]): number | null {
  const d = durationsMin.filter((m) => m > 0)
  if (d.length === 0) return null
  if (d.length >= 3) {
    const sorted = [...d].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] / 60
  }
  const sum = d.reduce((s, v) => s + v, 0)
  const mean = sum / d.length
  // Asymmetric: a thin sample that is faster-than-prior is left alone (its good score is earned and
  // shrinking it would penalise well-performing low-incident services); only a worse-than-prior thin
  // sample is pulled toward the prior, bounding a single long outlier's effect. Still penalises (the
  // shrunk value stays > prior when mean > prior) — unlike a cap it never fully spares a long outage.
  if (mean <= MTTR_PRIOR_MIN) return mean / 60
  return (sum + MTTR_PRIOR_WEIGHT * MTTR_PRIOR_MIN) / (d.length + MTTR_PRIOR_WEIGHT) / 60
}

export const REFERENCE_MS = 400
export const REFERENCE_CV = 0.5
export const MIN_VALID_DAYS = 7
export const P50_FLOOR_MS = 50 // prevents bimodal distributions (e.g., Claude CDN routing) from dominating

// Component maxes (sum = 100 when all four are present). #713 — the score is computed on the
// components we can actually MEASURE and rescaled to 100 by their AVAILABLE max, so a missing
// component's RAW figure (an uptime %, a p50 ms) is never invented. This generalizes the old
// "no-probe rescale 80→100" to "no-uptime" too.
//
// #1186 correction — the RESCALE ITSELF is still an imputation, despite the paragraph above (and the
// removed old wording) claiming otherwise. Omitting uptime and rescaling (I+R+P)/60×100 is algebraically
// identical to keeping uptime IN the sum at U = 0.667×(I+R+P) — the FIXED ratio UPTIME_SCORE_MAX / (other
// three maxes), not an empirical average. That is a concrete, unmeasured uptime figure, produced by the
// rescale math, not "no value assumed". Ranking.jsx's high/medium split (#1186) exists because a
// medium-confidence score is on a different scale than a high one for exactly this reason — never
// compare or co-rank them directly.
const UPTIME_SCORE_MAX = 40
const INCIDENTS_SCORE_MAX = 25
const RECOVERY_SCORE_MAX = 15
const RESPONSIVENESS_SCORE_MAX = 20
const TOTAL_SCORE_MAX = 100
const INSUFFICIENT_PROBE_PENALTY = 0.95 // 5% confidence penalty for probed services lacking ≥7d data

/** #989 — an incident counts toward the reliability penalty (affectedDays, weighted days, MTTR,
 *  Recovery default) only when the provider assigned it a real impact AND it is not a machine-emitted
 *  `autoMonitor` incident. A provider auto-monitor (Moonshot's `Agentic 模型错误报警`) opens frequent
 *  `critical` incidents whose recorded durations are paperwork-inflated (open long after the brief
 *  actual error — the #1019 pattern) and whose severity is blanket-`critical`, so both the duration and
 *  the severity are unusable as a Score signal; counting them craters the Score while the API gateway is
 *  healthy. Symmetric with the #707/#261 null-impact exclusion. NOTE the alert-side parallel is only
 *  partial: #983 holds/flap-suppresses NON-`critical` auto-monitor incidents, but a `critical` one
 *  bypasses every hold/flap path (alerts.ts short-circuits on `critical` first) and alerts immediately —
 *  its Discord flood is instead prevented by `filterByComponentStatus` (#970). This Score exclusion is
 *  what handles the `critical` auto-monitor case on the SCORE side.
 *
 *  ACCEPTED LIMITATION (not a safety guarantee): a genuine sustained model-tier outage reported ONLY
 *  through this auto-monitor channel is NOT reflected in the Score — the tag excludes it here, and (for
 *  a single-`statusComponentId` service like Kimi, whose auto-monitor incidents attach to no badge
 *  component) it never lowers `uptime30d` either. This is accepted because the channel's duration and
 *  severity are not trustworthy enough to score; the badge/uptime still reflect the monitored gateway
 *  component's own health.
 *
 *  Type predicate so the `impact != null` narrowing flows to callers (no `impact!` at the use sites).
 *  Exported for unit testing. */
export function isReliabilityIncident<T extends Pick<Incident, 'impact' | 'autoMonitor'>>(
  i: T,
): i is T & { impact: NonNullable<T['impact']> } {
  return i.impact != null && !i.autoMonitor
}

/** #1502 — drop the duplicate records a provider leaves when several of them describe one outage.
 *  They close within the same minute, because the provider closes the set when the event ends (the
 *  seconds differ), and the earliest record spans the rest — so keep it and drop its siblings.
 *
 *  Keyed on `(title, close minute)`. The title alone is not enough — per-model (Anthropic) and
 *  per-resource (Together) rows repeat one constantly — and it is not the provider's to keep stable:
 *  `autoMonitorTitles` keys on registered titles and misses any alarm title nobody registered (#1502).
 *  `republished-duplicates.test.ts` holds both directions against real archived rows.
 *
 *  Reads only what both the live `Incident` and the archived `MonthlyIncidentEntry` carry, so ONE
 *  primitive serves the Score's recovery sample and the archive's downtime aggregation. It is NOT
 *  applied to every per-incident sum: `weekly-briefing.ts` sums the same rows and applies none of the
 *  archive's exclusions (#1021/#1210/#1292 either), so it is out of scope here rather than missed.
 *  It must NOT run on the live incident list: those ids key
 *  alert dedup and the durable accumulator, and an id that disappears is read as a provider
 *  WITHDRAWAL and published as one (#1106, and the #1349/#1384 precedents).
 *
 *  Skips records whose timestamps are not the provider's own — `startUnknown` has no real start to
 *  take the earliest of, `derived` is synthesized per day by AIWatch (#1292). Returns the same array
 *  reference when nothing is dropped. */
export function dropRepublishedDuplicates<
  T extends { title: string; startedAt: string; resolvedAt?: string | null; startUnknown?: boolean; derived?: string },
>(incidents: T[]): T[] {
  if (incidents.length < 2) return incidents
  const groups = new Map<string, T[]>()
  for (const inc of incidents) {
    if (!inc.resolvedAt || inc.startUnknown || inc.derived) continue
    const key = `${inc.title}\u0000${inc.resolvedAt.slice(0, 16)}`
    const g = groups.get(key)
    if (g) g.push(inc)
    else groups.set(key, [inc])
  }
  const dropped = new Set<T>()
  for (const g of groups.values()) {
    if (g.length < 2) continue
    const earliest = g.reduce((a, b) => (Date.parse(a.startedAt) <= Date.parse(b.startedAt) ? a : b))
    for (const inc of g) if (inc !== earliest) dropped.add(inc)
  }
  return dropped.size === 0 ? incidents : incidents.filter((inc) => !dropped.has(inc))
}

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
  window?: { startISO: string; endISO: string },
): AIWatchScore {
  // #993 — incident selection is the only place this function derives a time window internally.
  // Default: the trailing `cutoffDays` from now (the live 30-day Score). An explicit
  // {startISO, endISO} scores a FIXED past window (a calendar month) so the monthly archive can
  // persist a month-aligned Score instead of a build-day snapshot of the rolling one. `uptime30d`
  // and the probe summary are already scoped by the caller, so only this filter changes.
  // #1292 — a synthesized incident is windowed by its DAY, not by its anchor. The anchor is an
  // arbitrary instant inside the page's local day, so on a page past UTC+12 it falls on the previous
  // UTC day: an incident stated for Jan 1 would be banked into January by the accumulator (which keys
  // on `incidentDay`) and scored in neither month here. The two must select the same rows.
  // `statedDay` (utils.ts) owns the tag/day pair rule — one copy, shared with `incidentDay`.
  // `null` means "this incident states no day", i.e. window it by the instant as always.
  const inWindow: (i: Incident) => boolean = window
    ? (i) => {
        const d = statedDay(i)
        return d
          ? d >= window.startISO.slice(0, 10) && d < window.endISO.slice(0, 10)
          : i.startedAt >= window.startISO && i.startedAt < window.endISO
      }
    : (() => {
        const cutoff = new Date(Date.now() - cutoffDays * 86_400_000).toISOString()
        // A whole day is in or out; the cutoff day itself counts, since its downtime is inside it.
        return (i: Incident) => {
          const d = statedDay(i)
          return d ? d >= cutoff.slice(0, 10) : i.startedAt >= cutoff
        }
      })()
  const windowIncidents = (service.incidents ?? []).filter(inWindow)
  const incidentCount = windowIncidents.length

  // Affected days — only count incidents with measurable impact (#261) that are not machine-emitted
  // autoMonitor noise (#989, isReliabilityIncident). null-impact entries are informational (component
  // renames, post-mortems) — including them in affected_days inflates services like cohere/groq whose
  // feeds mix info posts with real incidents, producing scores ~10pts lower than reality.
  const impactfulDays = new Set(
    // #1292 — `derivedDay` when present: a synthesized incident's own anchor is an arbitrary instant
    // inside the page's local day, so slicing its UTC date buckets it under the wrong date for any
    // page far enough from UTC. Parsed incidents keep the UTC slice they have always used.
    windowIncidents.filter(isReliabilityIncident).map(incidentDay),
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
  for (const inc of windowIncidents) {
    if (!isReliabilityIncident(inc)) continue  // #989 — skip null-impact + autoMonitor machine noise
    const weight = INCIDENT_IO_IMPACT_WEIGHTS[inc.impact]  // non-null: narrowed by the predicate above
    if (weight === undefined) {
      unknownImpacts.add(String(inc.impact))
      continue
    }
    const day = incidentDay(inc) // #1292 — the derived day when it carries one
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
  const impactfulWindowIncidents = dropRepublishedDuplicates(  // #1502 — one event, not N records
    windowIncidents.filter(isReliabilityIncident),  // #989 — excl. autoMonitor
  )
  // #1292 — a `status_history`-derived incident's `duration` is ONE DAY'S total downtime, not a time
  // to recover: the source is a per-day seconds bucket with no start, no end and no recovery event.
  // Feeding it to MTTR is a category error with a perverse sign — a handful of short synthesized days
  // pushes the sample past `computeMttrHours`' 3-sample switch to the robust median, dragging the
  // median below the service's real incidents, so ADDING downtime can RAISE the Recovery component.
  // They still count toward `affectedDays` above, which is the component that should move.
  // ...so they are removed from the recovery SAMPLE entirely — both the durations and the default
  // below, which keys off the same set. Removing them from only the durations would leave the default
  // seeing incidents with no measurable recovery and score Recovery 0, which is worse than the
  // category error it was meant to fix. With no recovery signal at all, Recovery abstains at full
  // marks — the same treatment #707 already gives a window whose only incidents are advisories. The
  // downtime itself is still carried by Uptime and by `affectedDays`.
  const recoveryCandidates = impactfulWindowIncidents.filter(carriesRecoveryTime)
  const durations = recoveryCandidates
    .filter((i) => i.status === 'resolved' && i.duration)
    .map((i) => parseDurationMin(i.duration!))
    .filter((m) => m > 0)

  // #1019 Part B — ≥3: robust median; 1–2: asymmetric shrinkage toward the prior (see computeMttrHours).
  const mttrHours = computeMttrHours(durations)

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
    : recoveryCandidates.length > 0 ? 0 : 15

  // Responsiveness (probe) — compute first so the rescale below knows whether it's an available
  // component. Exhaustive switch — adding a new ProbeContext kind is a compile error until handled.
  let responsivenessScore: number | null = null
  let speedScore: number | null = null
  let stabilityScore: number | null = null
  let summary: ProbeSummary | null = null
  let probeAvailable = false
  let probePenalty = 1
  switch (probe.kind) {
    case 'available': {
      summary = probe.summary
      const { speed, stability } = computeResponsiveness(summary)
      responsivenessScore = speed + stability
      speedScore = speed
      stabilityScore = stability
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

  // #1002 review — round the two displayed parts FIRST, then define the displayed `responsiveness`
  // as their sum. Rounding the raw sum independently (the original approach) disagrees with
  // round(speed) + round(stability) by up to 0.1 on ~24% of realistic probe values (confirmed
  // against live production data), which reads as an arithmetic error on the page that puts the two
  // child bars directly under the parent. `scoreNum` above is unaffected — it already used the raw,
  // unrounded `responsivenessScore`, before this display-only object is built.
  const speedDisplay = speedScore != null ? Math.round(speedScore * 10) / 10 : null
  const stabilityDisplay = stabilityScore != null ? Math.round(stabilityScore * 10) / 10 : null
  const responsivenessDisplay = speedDisplay != null && stabilityDisplay != null
    ? Math.round((speedDisplay + stabilityDisplay) * 10) / 10
    : null

  return {
    score,
    grade,
    confidence,
    breakdown: {
      uptime: uptimeScore != null ? Math.round(uptimeScore * 10) / 10 : null,
      incidents: Math.round(incidentScore * 10) / 10,
      recovery: Math.round(recoveryScore * 10) / 10,
      responsiveness: responsivenessDisplay,
      speed: speedDisplay,
      stability: stabilityDisplay,
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

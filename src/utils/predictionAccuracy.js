// #827 Feature 4 — client-side predicted-vs-actual outcome for the Analyze modal.
//
// Mirrors worker/src/incident-history.ts `accuracyOf` bands so the dashboard's per-incident verdict
// matches the corpus classification + the daily-summary aggregate. The data is already in the
// /api/status `aiAnalysis` payload (estimatedRecoveryHours / estimatedRecovery / resolvedAt) plus the
// incident's startedAt — no new API field needed, and it lights up the moment an incident resolves.

/** Compact minute formatter that DROPS a trailing "0m" — "45m", "1h", "3h 10m". The single source
 *  for both the actual and predicted text here, so the dashboard matches the worker `formatDurationMin`
 *  / Edge `fmtMinEn` (which also drop "0m"); the app-wide `recovery.js` formatRecoveryMin keeps "1h 0m"
 *  and is intentionally NOT used here, so a whole-hour duration reads "2h" everywhere, not "2h 0m". */
export function fmtMin(min) {
  if (!Number.isFinite(min) || min <= 0) return '0m'
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

/** Predicted upper-bound hours → compact text ("1h", "45m", "3h", "1h 30m"), via fmtMin so a
 *  fractional estimate (0.75h) reads "45m" instead of "~0.75h". */
export function predictedHoursText(hours) {
  return fmtMin(Math.round(hours * 60))
}

/**
 * Predicted recovery as an upper-bound in hours: prefer the numeric `estimatedRecoveryHours`, else
 * parse the display string ("1–3h" → 3, "30m–1h" → 1, "45m" → 0.75). Returns null when there is no
 * usable prediction ("N/A", "No historical data…", missing).
 */
export function predictedHoursFrom(analysis) {
  if (!analysis) return null
  if (typeof analysis.estimatedRecoveryHours === 'number' && analysis.estimatedRecoveryHours > 0) {
    return analysis.estimatedRecoveryHours
  }
  const s = analysis.estimatedRecovery
  if (!s || s === 'N/A' || s === 'No historical data for estimation') return null
  // Upper bound = the last numeric segment of the range.
  const parts = String(s).split(/[–\-~]/).map((x) => x.trim()).filter(Boolean)
  const upper = parts[parts.length - 1]
  if (!upper) return null
  const h = upper.match(/(\d+(?:\.\d+)?)\s*h/i)
  const m = upper.match(/(\d+(?:\.\d+)?)\s*m/i)
  let hours = 0
  if (h) hours += parseFloat(h[1])
  if (m) hours += parseFloat(m[1]) / 60
  return hours > 0 ? hours : null
}

/**
 * #1003 — the estimate a RESOLVED incident is SCORED against: the first, hindsight-free prediction.
 * Mirrors the worker's `scoringBaselineHours` (incident-history.ts).
 *
 * `estimatedRecoveryHours` is the CURRENT estimate, which the worker's re-analysis ratchets upward
 * once an incident outruns its own prediction — so scoring against it flatters exactly the incidents
 * the model got wrong. Falls back to the current estimate when no first estimate was recorded
 * (analyses written before #1003 shipped).
 *
 * Live surfaces (`estimateExceeded`, `exceededRecoveryText`) intentionally do NOT use this — a user
 * looking at an ongoing incident needs the current ETA, not the superseded original.
 */
export function baselineHoursFrom(analysis) {
  if (!analysis) return null
  if (typeof analysis.firstEstimatedRecoveryHours === 'number' && analysis.firstEstimatedRecoveryHours > 0) {
    return analysis.firstEstimatedRecoveryHours
  }
  return predictedHoursFrom(analysis)
}

/**
 * Accuracy verdict, mirroring worker `accuracyOf`: actual within [0.5×, 1×] of the predicted upper
 * bound is 'accurate'; longer than the bound is 'under' (the model was too optimistic); far below it
 * (<0.5×) is 'over' (too cautious). 'unknown' for missing inputs.
 */
export function accuracyVerdict(predictedHours, actualMin) {
  if (!(predictedHours > 0) || !(actualMin >= 0)) return 'unknown'
  const actualHours = actualMin / 60
  if (actualHours > predictedHours) return 'under'
  if (actualHours < predictedHours * 0.5) return 'over'
  return 'accurate'
}

/**
 * Plain-language verdict label for a verdict + language. 'accurate' = recovered within the predicted
 * window (so "within estimate", not the over-claiming "spot on"); 'under'/'over' state the direction.
 * Shared by the modal + Overview banner so the wording can't drift. Returns null for 'unknown'.
 */
export function verdictLabel(verdict, lang) {
  if (verdict === 'accurate') return lang === 'ko' ? '예측 범위 내' : 'within estimate'
  if (verdict === 'under') return lang === 'ko' ? '예측보다 오래' : 'slower than est.'
  if (verdict === 'over') return lang === 'ko' ? '예측보다 빨리' : 'faster than est.'
  return null
}

/**
 * Compact "how the actual related to the estimate" phrase for the Overview banner, folding the
 * predicted value AND direction into one natural fragment (so there's no redundant separate verdict
 * label). Reads as "(예측 ~1h 이내)" / "over ~1h est." etc. Returns null when outcome is null.
 *   - accurate (within the band) → 예측 ~{p} 이내 / within ~{p} est.
 *   - under (ran longer)         → 예측 ~{p} 초과 / over ~{p} est.
 *   - over (recovered faster)    → 예측 ~{p}보다 빨리 / faster than ~{p} est.
 */
export function withinEstimateText(outcome, lang) {
  if (!outcome) return null
  const p = outcome.predictedText
  if (outcome.verdict === 'under') return lang === 'ko' ? `예측 ~${p} 초과` : `over ~${p} est.`
  if (outcome.verdict === 'over') return lang === 'ko' ? `예측 ~${p}보다 빨리` : `faster than ~${p} est.`
  return lang === 'ko' ? `예측 ~${p} 이내` : `within ~${p} est.`
}

/**
 * True when an ACTIVE incident has already run past its estimated recovery upper bound, so the stale
 * short "Est. Recovery" range is no longer credible (a 2–4h estimate on an incident ongoing for days).
 * Mirrors the worker's `recoveryExceeded` gate (incidentAge > estHours). Callers should then render the
 * "Exceeded typical pattern" wording instead of the outdated range. Returns false once resolved (the
 * predicted-vs-actual outcome takes over), when there's no usable prediction, or without a startedAt.
 */
export function estimateExceeded(analysis, incident, nowMs = Date.now()) {
  if (!analysis || analysis.resolvedAt) return false
  const predictedHours = predictedHoursFrom(analysis)
  if (predictedHours == null) return false
  const startedAt = incident?.startedAt
  if (!startedAt) return false
  const elapsedMs = nowMs - new Date(startedAt).getTime()
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return false
  return elapsedMs > predictedHours * 3_600_000
}

/** Approximate elapsed-duration label for the "still ongoing" recovery text — rounded to whole
 *  units so a live, ever-ticking value reads cleanly ("12시간" / "12h", "40분" / "40m"). */
export function approxElapsedText(min, lang) {
  if (!(min > 0)) return lang === 'ko' ? '방금' : 'just now'
  if (min < 60) return lang === 'ko' ? `${Math.round(min)}분` : `${Math.round(min)}m`
  const h = Math.round(min / 60)
  return lang === 'ko' ? `${h}시간` : `${h}h`
}

/** Overshoot multiple past which the specific estimate range is dropped as noise (see #900). Elapsed
 *  beyond `upperBoundHours × FAR_EXCEEDED_FACTOR` → "far exceeded" wording instead of "exceeded ~Xh est.".
 *  Mirrored in `api/_is-down/html-template.ts` — keep the two in sync. */
export const FAR_EXCEEDED_FACTOR = 3

/**
 * Display text for an ACTIVE incident that has run past its recovery estimate (callers gate on
 * `estimateExceeded`). Instead of a bare "Exceeded typical pattern", it shows WHY — how long it has
 * been running vs the original estimate: "약 12시간째 진행 · 예측(2–4h) 초과" / "Ongoing ~12h · exceeded
 * ~2–4h est." Once FAR past the estimate (> FAR_EXCEEDED_FACTOR×) the stale range is dropped for a
 * "far exceeded" signal (#900). Falls back to the terse wording when elapsed or the range is unavailable.
 */
export function exceededRecoveryText(analysis, incident, lang, nowMs = Date.now()) {
  const startedAt = incident?.startedAt
  const elapsedMin = startedAt ? (nowMs - new Date(startedAt).getTime()) / 60000 : NaN
  const raw = analysis?.estimatedRecovery
  const bound = predictedHoursFrom(analysis)
  const range = (raw && raw !== 'N/A' && raw !== 'No historical data for estimation')
    ? raw
    : (bound != null ? predictedHoursText(bound) : null)
  if (!Number.isFinite(elapsedMin) || elapsedMin <= 0 || !range) {
    return lang === 'ko' ? '일반 패턴 초과 — 예측 불가' : 'Exceeded typical pattern'
  }
  const approx = approxElapsedText(elapsedMin, lang)
  // Once the incident has run FAR past the estimate (> FAR_EXCEEDED_FACTOR× the upper bound), the
  // specific short range is noise (a 4–8h estimate on a 69h incident) that just repeats every refresh
  // — drop it and signal the large overshoot instead. Mild overshoot keeps the range (still credible).
  if (bound != null && elapsedMin > bound * 60 * FAR_EXCEEDED_FACTOR) {
    return lang === 'ko' ? `약 ${approx}째 진행 · 예측 대폭 초과` : `Ongoing ~${approx} · far exceeded est.`
  }
  return lang === 'ko'
    ? `약 ${approx}째 진행 · 예측(${range}) 초과`
    : `Ongoing ~${approx} · exceeded ~${range} est.`
}

/**
 * Predicted-vs-actual outcome for a RESOLVED incident, for modal display.
 * @returns {{ predictedHours:number, actualMin:number, actualText:string, verdict:string } | null}
 *          null when the incident isn't resolved, has no usable prediction, or the actual duration
 *          can't be derived (missing/!startedAt, missing resolvedAt, out-of-order timestamps).
 */
export function computePredictionOutcome(analysis, incident) {
  if (!analysis?.resolvedAt) return null
  // #1003 — scored against the first estimate, not the re-analysis-inflated current one.
  const predictedHours = baselineHoursFrom(analysis)
  if (predictedHours == null) return null
  const startedAt = incident?.startedAt
  if (!startedAt) return null
  const actualMin = Math.round((new Date(analysis.resolvedAt).getTime() - new Date(startedAt).getTime()) / 60000)
  if (!Number.isFinite(actualMin) || actualMin < 0) return null
  return {
    predictedHours,
    predictedText: predictedHoursText(predictedHours),
    actualMin,
    actualText: fmtMin(actualMin),
    verdict: accuracyVerdict(predictedHours, actualMin),
  }
}

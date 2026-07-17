// #1045 — rows for the Overview "Recently Resolved" banner.
//
// Two shapes made the banner read as broken, both from keying it by SERVICE:
//   1. One provider incident lands on N sibling services (Anthropic → Claude API / Claude Code /
//      claude.ai), and each printed its own row with identical text. #827 F4 chose one-row-per-service
//      deliberately ("stay visually distinct"), but siblings share an incidentId and say the same
//      thing, so the rows duplicated rather than distinguished.
//   2. A row's EXISTENCE comes from the `recovered:{svc}:{inc}` KV marker (2h TTL) while its detail
//      text came from an AI analysis (separate key, may never exist / expires first) — so an
//      unanalyzed service rendered as a bare name beside a fully-detailed sibling.
//
// So: group by incidentId (the key ai-analysis.ts and incident-history.ts already treat as the
// sibling identity), and derive the duration from the INCIDENT's own timestamps so every row has the
// same minimum shape. The prediction fragment stays optional — it genuinely requires an analysis.

import { computePredictionOutcome, fmtMin, withinEstimateText } from './predictionAccuracy'

/** Actual recovery minutes from the incident's own timestamps — no AI analysis needed. Prefers the
 *  analysis `resolvedAt` when present (the worker stamps it at the same moment it writes the
 *  `recovered:` marker, so it's the resolution instant the prediction is graded against), else the
 *  incident's. Null when either end is missing or the timestamps are out of order. */
export function recoveredDurationMin(incident, analysis) {
  const startedAt = incident?.startedAt
  const resolvedAt = analysis?.resolvedAt ?? incident?.resolvedAt
  if (!startedAt || !resolvedAt) return null
  const min = Math.round((new Date(resolvedAt).getTime() - new Date(startedAt).getTime()) / 60000)
  if (!Number.isFinite(min) || min < 0) return null
  return min
}

/**
 * Collapse the per-service `recentlyRecovered` map into one row per underlying incident.
 *
 * @param {Record<string, string[]>} recentlyRecovered  serviceId → incidentId[] (from the KV markers)
 * @param {Array<{id:string,name:string,incidents?:Array}>} services  live services
 * @param {Record<string, Array<{incidentId:string}>>} aiAnalysis  serviceId → analyses
 * @returns {Array<{ incidentId:string, services:Array<{id:string,name:string}>, durationMin:number|null,
 *                   outcome:object|null, hasAnalysis:boolean }>}
 *          Rows in first-seen incident order; each row's services in `services` order (stable, since
 *          that array is the categorized display order). Services the live payload doesn't carry
 *          (disabled in Settings, dropped from the feed) produce no entry and so no row.
 */
export function buildRecoveredRows(recentlyRecovered, services, aiAnalysis = {}) {
  /** @type {Map<string, Array<{svc:object, incident:object|undefined, analysis:object|undefined}>>} */
  const byIncident = new Map()
  // Iterate `services` rather than the map's keys so row-internal service order is the display order
  // regardless of KV read order.
  for (const svc of services ?? []) {
    for (const incId of recentlyRecovered?.[svc.id] ?? []) {
      const entry = {
        svc,
        incident: svc.incidents?.find(i => i.id === incId),
        // Pair the analysis by incidentId ONLY. The old `?? analyses[0]` fallback could grade incident
        // A's prediction against incident B's marker — subtle per service, but a grouped row would
        // then carry one sibling's mismatched text on behalf of all of them.
        analysis: (aiAnalysis?.[svc.id] ?? []).find(a => a.incidentId === incId),
      }
      const entries = byIncident.get(incId)
      if (entries) entries.push(entry)
      else byIncident.set(incId, [entry])
    }
  }
  return [...byIncident.entries()].map(([incidentId, entries]) => {
    // Both numbers come from ONE sibling, so the duration and the verdict always describe the same
    // resolution instant. Prefer a sibling whose prediction actually GRADES — testing merely for the
    // presence of an analysis would let a sibling with an ungradeable estimate ("No historical data")
    // win and silently drop a gradeable sibling's fragment, making the text depend on display order.
    // A gradeable outcome implies a computable duration from the same instant, so this subsumes the
    // second clause, which then covers the unanalyzed rows.
    const source = entries.find(e => computePredictionOutcome(e.analysis, e.incident) != null)
      ?? entries.find(e => recoveredDurationMin(e.incident, e.analysis) != null)
      ?? entries[0]
    return {
      incidentId,
      services: entries.map(e => ({ id: e.svc.id, name: e.svc.name })),
      durationMin: recoveredDurationMin(source.incident, source.analysis),
      outcome: computePredictionOutcome(source.analysis, source.incident),
      hasAnalysis: entries.some(e => !!e.analysis),
    }
  })
}

/**
 * The row's detail text — always non-null, so no row degrades to a bare service name.
 *   duration + analysis → "recovered in 1h 7m (faster than ~4h est.)"
 *   duration only       → "recovered in 1h 7m"
 *   neither             → "recovered" (the incident aged out of the live feed — the marker is all we have)
 * The prediction fragment stays optional because it's the one part that genuinely needs an analysis.
 */
export function recoveredDetailText(row, lang) {
  const ko = lang === 'ko'
  if (row?.durationMin == null) return ko ? '복구됨' : 'recovered'
  const duration = fmtMin(row.durationMin)
  const lead = ko ? `${duration} 만에 복구` : `recovered in ${duration}`
  const estimate = row.outcome && withinEstimateText(row.outcome, lang)
  return estimate ? `${lead} (${estimate})` : lead
}

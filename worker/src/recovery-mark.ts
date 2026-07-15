// Marking an incident RESOLVED for the read surfaces — #1003.
//
// Two cron paths end an incident, and they had drifted:
//
//   - `alerted:recovered:{svcId}` — a SERVICE-status edge (down/degraded → operational). Its own
//     comment calls it "rarely-firing … only fires in the incident-less gap".
//   - `alerted:res:{incId}`       — the "Incident Resolved" alert. This is the resolution path for
//     ALL services, i.e. what actually fires for a normal incident.
//
// The durable corpus half of that work was moved to the `alerted:res:` path by #847. The READ-SURFACE
// half never was: the `recovered:{svcId}:{incId}` marker and the `resolvedAt` stamp on `ai:analysis:*`
// were still written ONLY by the rare status-edge path. Everything the dashboard and the public
// is-down page show about a resolved incident is gated on exactly those two writes —
// `recentlyRecovered` needs the marker (index.ts `/api/status` + `/api/status/cached`), and the
// predicted-vs-actual verdict needs `analysis.resolvedAt` (`computePredictionOutcome` returns null
// without it; the Edge card's `isResolved` likewise). So for a normal incident resolution all three
// surfaces — the "Recently Resolved" banner, the Analyze modal's verdict, and the is-down AI card's
// "Predicted vs actual" — rendered NOTHING, while Discord and /feed shipped the same information
// fine. #827 F4's UI was reachable only through the rare path it happened to be wired to.
//
// This module is that shared step, so the two paths cannot drift again.
//
// SCOPE CAVEAT: "every resolution path" means every path that ALERTS. `alerted:res:` only fires for an
// incident that previously fired a `new` alert (`alertedNewMap`, alerts.ts) — so an incident held by the
// #633 first-seen gate, suppressed as a #283 flap, or held by #929's `holdShortIncidents` resolves
// without either path running, and its surfaces stay dark. That is intended (those incidents are
// deliberately never surfaced at all), but it means "no banner" is not by itself evidence of this bug.

import { analysisKey, parseAnalysis, putAnalysis, type AIAnalysisResult } from './ai-analysis'
import { formatDuration, kvDel, kvPut, type KVLike } from './utils'

/** How long a resolved incident stays visible on the read surfaces. Deliberately ONE constant for BOTH
 *  the `recovered:` marker and the resolved `ai:analysis:` value: the banner and the modal's verdict are
 *  two halves of the same surface, so tuning one without the other would show a banner whose "see the
 *  analysis" link leads nowhere (or vice versa). */
export const RESOLVED_TTL_S = 7200

export function recoveryMarkerKey(svcId: string, incId: string): string {
  return `recovered:${svcId}:${incId}`
}

interface ResolvedIncident {
  id: string
  title?: string
  startedAt?: string
  resolvedAt?: string | null
}

/**
 * Mark ONE incident resolved: write the independent `recovered:` marker (which is what lights up the
 * "Recently Resolved" banner, with or without an AI analysis) and stamp `resolvedAt` on the incident's
 * analysis (which is what lets the SPA modal + is-down card render predicted-vs-actual).
 *
 * Returns the analysis — with `resolvedAt` stamped and its #1003 scoring baseline pinned by
 * `putAnalysis` — so the caller can hand it straight to `buildHistoryRecord`. Null when no analysis
 * exists (the marker is still written: the actual outcome is worth surfacing without a prediction) or
 * when the stored value was corrupt (it is deleted rather than left to poison every reader).
 *
 * Idempotent: an already-stamped analysis is not rewritten, so a Tier-1 incident that trips BOTH cron
 * paths in one cycle marks once. Best-effort — every KV failure is logged and swallowed, because an
 * alert that is about to ship must never be aborted by a bookkeeping write.
 */
export async function markIncidentResolved(
  kv: KVLike,
  svcId: string,
  inc: ResolvedIncident,
  now: string,
): Promise<AIAnalysisResult | null> {
  const duration = inc.startedAt
    ? formatDuration(new Date(inc.startedAt), new Date(inc.resolvedAt ?? now))
    : undefined
  const markerOk = await kvPut(kv, recoveryMarkerKey(svcId, inc.id), JSON.stringify({
    resolvedAt: inc.resolvedAt ?? now,
    incidentTitle: inc.title ?? '',
    duration: duration ?? '',
  }), { expirationTtl: RESOLVED_TTL_S })
  if (!markerOk) console.error('[cron] failed to write recovery marker:', svcId, inc.id)

  const key = analysisKey(svcId, inc.id)
  const raw = await kv.get(key).catch(() => null)
  if (!raw) return null

  const analysis = parseAnalysis(raw)
  if (!analysis) {
    // A corrupt ai:analysis value is a data-integrity signal worth a trace, not a silent null —
    // log + drop the poisoned key rather than serving it to every downstream reader.
    console.warn('[kv] ai:analysis parse failed during recovery mark:', svcId, inc.id)
    await kvDel(kv, key)
    return null
  }
  if (analysis.resolvedAt) return analysis

  // Take `pinned` even if the persist failed: the #1003 baseline is already resolved by then, and the
  // caller writes it into the PERMANENT history corpus — recording an inflated estimate there because
  // a KV write blipped would be unfixable.
  const { pinned } = await putAnalysis(
    kv, svcId, inc.id,
    { ...analysis, resolvedAt: inc.resolvedAt ?? now },
    analysis,
    RESOLVED_TTL_S,
  )
  return pinned
}

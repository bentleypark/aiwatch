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

/**
 * Which incidents the STATUS-EDGE path may mark resolved (#1003 terminal-only, #1292 no synthesis).
 *
 * The two cron resolution paths select their incidents very differently, and only this one needs a
 * predicate. The `alerted:res:` path is keyed on the incidents that actually ALERTED, which is already
 * a safe set. This one runs over the service's WHOLE incident list on a status edge, so anything on
 * that list that is not a real, finished, provider-observed incident has to be excluded here:
 *
 *  - non-terminal (#1003) — an `incidentExclude`d entry or a maintenance notice still RUNNING would
 *    get `resolvedAt` stamped on a live analysis, flipping the modal to a predicted-vs-actual verdict.
 *  - `status_history`-derived (#1292) — synthesized from a per-day downtime bucket and born `resolved`,
 *    so up to 30 of them sit on the list at once. Marking them would light the "Recently Resolved"
 *    banner for every one, each naming a recovery MOMENT the source never stated.
 *  - `retainedBridge` (#1384) — forwarded from AIWatch's own prior collection under a retiring source
 *    (services.ts `mergeRetainedIncidentHistory`), already resolved BEFORE it was ever forwarded. This
 *    path has no `alertedNewMap` gate (unlike `alerted:res:`, which only ever processes ids legitimately
 *    tracked start-to-finish), so without this exclusion an old, genuinely-resolved bridged row would
 *    get its "Recently Resolved" banner re-lit and its history record rewritten every time ANY OTHER
 *    incident on the same service resolves — the exact "stale data reads as fresh news" shape found on
 *    five other consumers already (prunePhantomIncidents ×2, ai-analysis.ts, rss.ts, alerts.ts,
 *    report.ts, withdrawn.ts).
 */
export function isMarkableOnStatusEdge(inc: { status?: string; derived?: string; retainedBridge?: boolean }): boolean {
  if (inc.status !== 'resolved' && inc.status !== 'monitoring') return false
  if (inc.retainedBridge) return false
  return inc.derived !== 'status_history'
}

export function recoveryMarkerKey(svcId: string, incId: string): string {
  return `recovered:${svcId}:${incId}`
}

interface ResolvedIncident {
  id: string
  title?: string
  startedAt?: string
  resolvedAt?: string | null
  /** #1390 — `startedAt` is anchored on `resolvedAt`; no elapsed time is derivable. */
  startUnknown?: boolean
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
  // #1390 — refuse the whole resolution event for an incident whose start is anchored on its own
  // `resolvedAt` (`startUnknown`). This is ONE predicate standing where the other two axes already put
  // one, and it is deliberately not a per-field patch.
  //
  // Round 2 of this issue cleared the marker's `duration` field and thought that closed it. It did not,
  // because the three surfaces this function lights up do not read that field — they subtract the
  // incident's OWN timestamp pair, and an anchored pair is subtractable and looks valid. Round 3
  // reproduced all three: the is-down AI card publishing `Predicted vs actual: 0m` on a public SEO page,
  // the Overview "Recently Resolved" banner reading `recovered in 0m`, and the Analyze modal's verdict.
  // No field a patch can clear reaches them.
  //
  // Both writes below are what they hang on — `recoveredGrouping.js` builds a row only from the
  // `recovered:` marker, and `predictionAccuracy.js` / the is-down card / the modal all return early
  // without the `resolvedAt` stamped onto the analysis (`predictionAccuracy.js:181`,
  // `html-template.ts`'s `outcome`). Withholding both is therefore the same property the `#1292` and
  // `#1384` axes rest on (`isMarkableOnStatusEdge` refusing the shape outright), rather than three more
  // guards that the fourth consumer would walk around.
  //
  // Gated HERE and not at the two call sites for the reason `buildHistoryRecord`'s own gate states:
  // both cron resolution paths funnel through this function. What is lost is the "Recently Resolved"
  // row for such an incident — the same trade already accepted for a `status_history` incident, and the
  // alternative is a row that states a recovery time we have said we do not have.
  if (inc.startUnknown) {
    console.warn(`[cron] ${svcId}/${inc.id}: no trustworthy start (startUnknown) — writing no recovery marker and stamping no analysis resolvedAt, so nothing downstream derives an elapsed time from the anchored pair`)
    return null
  }
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

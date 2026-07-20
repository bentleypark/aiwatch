// #1053 — the shared "which of this service's incidents can be a CAUSE, and what text may name it"
// primitive, extracted from `supply-chain.ts`'s `awsRegionsNamedByService` (#574/#1000) when a second
// attribution layer needed the identical three rules. Both layers ask the same question of a service —
// "does its own status text blame something?" — and differ only in WHAT they look for on top: AWS
// region tokens (supply-chain) vs an upstream provider's aliases (upstream-link). Keeping the rules
// here means the reasoning below is learned once, not re-derived (and re-broken) per layer.
//
// It has a second, text-free use: #1053's gate 5 calls this purely to enumerate an upstream's
// CAUSE-ELIGIBLE incidents and discards `text` entirely. So the filters — not just the harvest — are
// the shared part.

import type { Incident, ServiceStatus } from './types'

export interface CausalIncident {
  inc: Incident
  /** title + componentNames + timeline text, joined — everything the provider wrote about it. */
  text: string
}

/**
 * This service's active incidents that could be CAUSED by something else, each with its searchable
 * text. The three filters are load-bearing; filters 2 and 3 were earned from real data (filter 1 is
 * a priori — it carried no recorded provenance before this extraction, and none is claimed):
 *
 * 1. `resolved` is skipped — a closed incident cannot explain a live degradation.
 *
 * 2. `impact === null` is skipped. A Statuspage `none` means the provider itself claims no
 *    availability impact, so such an incident must not lend its tokens to an attribution. Mirrors the
 *    AWS side, where `awsHealthImpact` drops non-reliability advisories (#707) from region health.
 *
 * 3. The text harvests the TIMELINE, not just the title — verified against real data (2026-07-13):
 *    Hugging Face titled an incident `Elevated error rate – AWS CDN (Singapore)` (a human place name,
 *    no region token) and named the region only in an update body. Title-only extraction would leave
 *    it permanently unattributable despite explicitly blaming its upstream. Pinecone is the opposite —
 *    it front-loads `[AWS][us-east-1]` into the title. Both shapes occur, so read both.
 */
export function causalIncidents(svc: Pick<ServiceStatus, 'incidents'>): CausalIncident[] {
  const out: CausalIncident[] = []
  for (const inc of svc.incidents ?? []) {
    if (inc.status === 'resolved') continue
    if (inc.impact === null) continue // provider claims no availability impact → not a cause
    out.push({ inc, text: incidentText(inc) })
  }
  return out
}

/** Everything the provider wrote about one incident, joined for substring/token scanning. */
export function incidentText(inc: Incident): string {
  return [
    inc.title ?? '',
    ...(inc.componentNames ?? []),
    ...(inc.timeline ?? []).map((e) => e.text ?? ''),
  ].join(' ')
}

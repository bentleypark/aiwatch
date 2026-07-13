// #574/#1000 — the per-service supply-chain note on an is-down page.
//
// Extracted from is-down.ts so the region choice is unit-testable: it is the one place where the
// banner's SERVICE-WIDE data becomes a claim about ONE service, and getting it wrong reproduces #1000
// on a second surface.

/** The shape is-down reads off `/api/status`'s `supplyChainBanner` (a structural subset of the
 *  worker's `SupplyChainBanner` — only the fields this note needs). */
export interface SupplyChainBannerLike {
  regions: Array<{ region: string; level: string; summary?: string }>
  /** `regions` is REQUIRED on the worker's own type, but optional here because this crosses a network
   *  boundary between two independently-deployed artifacts: Vercel ships this Edge function on merge
   *  to main, while the worker deploy is manual and batched (CLAUDE.md). So for hours-to-days after a
   *  merge, a worker that predates #1000 can serve `affectedNow` entries with no `regions`. TypeScript
   *  cannot validate that payload — the runtime branch in `buildSupplyChainNote` has to. */
  affectedNow: Array<{ id: string; name: string; regions?: string[] }>
  mayBeAffected: Array<{ id: string; name: string; confidence: string }>
}

export interface SupplyChainNote {
  regions: string
  confirmed: boolean
}

/**
 * Which regions does THIS service's note name, and is the claim causal?
 *
 * `confirmed` (the service is in `affectedNow`) renders as "<svc> is degraded and attributes it to an
 * AWS/upstream issue (<regions>)" — a causal claim about this service, so it must list ONLY the regions
 * this service itself named. The banner-wide `regions` is the UNION across every affected service: with
 * Pinecone correlating on us-east-1 and Hugging Face on eu-west-1, joining the union would tell
 * Pinecone's readers that its outage is attributed to eu-west-1, which Pinecone never mentioned. That is
 * #1000's false attribution again, one surface over.
 *
 * `mayBeAffected` renders as "<svc> runs on AWS and may be affected" — hedged, asserting no cause — so
 * the full degraded-region set is the right context there.
 *
 * DEPLOY SKEW: a worker predating #1000 sends `affectedNow` entries with no `regions`, and Vercel ships
 * this function on merge while the worker deploy is manual and batched — so that window is hours-to-days
 * wide, not seconds. We must NOT fall back to the banner-wide union for the causal wording there: the
 * union differs from a service's own regions precisely when two dependents correlate on disjoint
 * regions, i.e. exactly the #1000 scenario, so the fallback would re-render the bug on every is-down
 * page for the length of the skew. Instead we DOWNGRADE to the hedged wording, which is true whatever
 * the regions are. We lose the "confirmed" claim for that window; we do not print a false cause.
 *
 * Returns null when the service is in neither list (no note).
 */
export function buildSupplyChainNote(banner: SupplyChainBannerLike | undefined, serviceId: string): SupplyChainNote | null {
  if (!banner) return null
  const hit = banner.affectedNow.find((s) => s.id === serviceId)
  if (!hit && !banner.mayBeAffected.some((s) => s.id === serviceId)) return null
  const own = hit?.regions ?? []
  if (own.length > 0) return { regions: own.join(', '), confirmed: true }
  // No per-service regions → cannot substantiate a cause for THIS service → hedge, never assert.
  return { regions: banner.regions.map((r) => r.region).join(', '), confirmed: false }
}

// Shared xAI per-region incident helpers (#686 alert merge + #703 AI-analysis dedup).
//
// xAI publishes the SAME event in multiple regions as SEPARATE incidents with distinct guids but
// near-identical titles differing only by a `[API (<region>.api.x.ai)] ` prefix (live: us-east-1 +
// eu-west-1). Two surfaces must collapse these to one:
//   • #686 — the Discord/Slack alert merge (mergeXaiRegionalAlerts in alerts.ts).
//   • #703 — the AI analysis: refreshOrReanalyze otherwise analyzes each region separately, so the
//     Analyze modal shows one xAI card with two region-duplicate analysis entries + burns a 2nd
//     Gemma/Sonnet call.
// Both key on the region-tag-STRIPPED title, so the SAME event across regions collapses while DISTINCT
// events (e.g. image-gen vs grok-code-fast-1) stay separate. This module is the single source of that
// regex + the helpers, so the two surfaces can't drift. xAI-only by design (other SERVICE_REGIONS feeds
// aren't verified to split incidentIds per region).

export const XAI_REGION_RE = /^\[API \(([a-z0-9-]+)\.api\.x\.ai\)\]\s*/i

/** The region label (e.g. 'us-east-1') from an xAI incident title, or null when not region-tagged. */
export function xaiRegionOf(title: string): string | null {
  return XAI_REGION_RE.exec(title)?.[1] ?? null
}

/** The region-tag-stripped event key used to group same-event-different-region incidents. A
 *  non-region-tagged title returns itself (so it never collapses with anything). */
export function xaiEventKey(title: string): string {
  return title.replace(XAI_REGION_RE, '').trim()
}

/**
 * Collapse xAI per-region incidents (same region-stripped title) to ONE — keeping the FIRST
 * occurrence per event. Non-region-tagged incidents (and every incident of a non-xAI service, since
 * only xAI titles carry the `[API (<region>.api.x.ai)]` prefix) pass through untouched, so this is a
 * safe no-op on any other service's incident list. Used by the AI-analysis path (#703) so a 2-region
 * xAI event is analyzed once. Generic over the incident shape — only `title` is read.
 *
 * "First kept" is intentionally aligned with `mergeXaiRegionalAlerts`'s `arr[0]` anchor (both walk
 * `svc.incidents` order), so the region whose analysis the initial path wrote is the one the refresh
 * path keeps refreshing — keep them in sync if either's ordering changes.
 *
 * NOTE the dedup is EVENTUAL, not instant: it only stops NEW/refresh writes for the dropped region.
 * A stale `ai:analysis:xai:{droppedIncId}` from a pre-#703 cron cycle (or within its 1h TTL) still
 * surfaces in `/api/status` until it expires — so the Analyze modal can briefly show 2 entries right
 * after deploy if a 2-region xAI incident is already active. It self-heals within ~1h (the dropped
 * region's key is never re-bumped).
 */
export function collapseXaiRegionalIncidents<T extends { title: string }>(incidents: T[]): T[] {
  // Pass 1 — collect the affected regions per event (in first-seen order, deduped).
  const regionsByEvent = new Map<string, string[]>()
  for (const inc of incidents) {
    if (!XAI_REGION_RE.test(inc.title)) continue
    const key = xaiEventKey(inc.title)
    const region = xaiRegionOf(inc.title)
    if (!region) continue
    const arr = regionsByEvent.get(key)
    if (arr) { if (!arr.includes(region)) arr.push(region) }
    else regionsByEvent.set(key, [region])
  }
  // Pass 2 — keep the FIRST incident per event; for a MULTI-region event, return a copy whose title
  // names all affected regions, so the downstream AI analysis reflects EVERY region (not just the
  // first one analyzed — #703, the "only us-east-1 shown" gap). Single-region + non-tagged: unchanged.
  const kept = new Set<string>()
  const out: T[] = []
  for (const inc of incidents) {
    if (!XAI_REGION_RE.test(inc.title)) { out.push(inc); continue }
    const key = xaiEventKey(inc.title)
    if (kept.has(key)) continue // a duplicate region of an already-kept event → drop
    kept.add(key)
    const regions = regionsByEvent.get(key) ?? []
    out.push(regions.length > 1 ? { ...inc, title: `${key} (regions: ${regions.join(', ')})` } : inc)
  }
  return out
}

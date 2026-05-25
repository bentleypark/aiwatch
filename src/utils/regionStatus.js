// Region status computation — extracted from src/pages/ServiceDetails.jsx
// (RegionalAvailability component) so the Overview ActionBanner can surface
// the same region recommendation that today only appears on detail pages.
// Pure data + pure function — no React, no DOM, no fetch — so it's safely
// callable from JSX, vitest, and (after a TS mirror in Phase 2) the Worker
// and Edge SSR functions.
//
// Refs issue #422 Phase 1.

// ── Region maps ──────────────────────────────────────────────
//
// `key` is the substring matched against incident.title.lower() AND against
// each item of incident.componentNames.lower(). Order matters — the FIRST
// healthy region in this list is what `recommendedRegion` resolves to.
// Convention: cluster regions by cloud provider (AWS first, then Azure, then
// GCP) so a same-cloud fallback is the natural default for partial regional
// outages. Geographic affinity / RTT-aware ranking is out of scope for Phase 1.

export const SERVICE_REGIONS = {
  xai: [
    { key: 'us-east-1', label: 'US (us-east-1)' },
    { key: 'eu-west-1', label: 'EU (eu-west-1)' },
  ],
  gemini: [
    { key: 'us-central1', label: 'US Central (us-central1)' },
    { key: 'europe-west1', label: 'Europe West (europe-west1)' },
    { key: 'asia-northeast1', label: 'Asia Northeast (asia-northeast1)' },
  ],
  openai: [
    { key: 'us-east-1', label: 'US East (us-east-1)' },
    { key: 'us-west-2', label: 'US West (us-west-2)' },
    { key: 'eu-central-1', label: 'Europe Central (eu-central-1)' },
  ],
  azureopenai: [
    { key: 'East US 2', label: 'East US 2' },
    { key: 'Central US', label: 'Central US' },
    { key: 'Sweden Central', label: 'Sweden Central' },
    { key: 'UK South', label: 'UK South' },
    { key: 'Australia East', label: 'Australia East' },
    { key: 'Korea Central', label: 'Korea Central' },
    { key: 'Norway East', label: 'Norway East' },
  ],
  bedrock: [
    { key: 'us-east-1', label: 'US East (N. Virginia)' },
    { key: 'us-west-2', label: 'US West (Oregon)' },
    { key: 'eu-west-1', label: 'Europe (Ireland)' },
    { key: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
  ],
  pinecone: [
    { key: 'AWS us-east-1', label: 'AWS US East' },
    { key: 'AWS us-west-2', label: 'AWS US West' },
    { key: 'AWS eu-west-1', label: 'AWS EU West' },
    { key: 'Azure eastus2', label: 'Azure East US' },
    { key: 'GCP us-central1', label: 'GCP US Central' },
    { key: 'GCP europe-west4', label: 'GCP EU West' },
  ],
}

export const REGION_DOCS_URL = {
  xai: 'https://docs.x.ai/docs/regions',
  gemini: 'https://cloud.google.com/vertex-ai/docs/general/locations',
  openai: 'https://platform.openai.com/docs/guides/production-best-practices',
  chatgpt: 'https://status.openai.com',
  azureopenai: 'https://learn.microsoft.com/azure/ai-services/openai/concepts/models',
  bedrock: 'https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-regions.html',
  pinecone: 'https://docs.pinecone.io/troubleshooting/available-cloud-regions',
}

// Services whose region card is shown unconditionally — even when no ongoing
// incident — because their component-tagged incidents already encode the
// region (AWS RSS componentNames, Azure RSS componentNames). Without the
// card the user has no way to confirm "AWS US East operational" at-a-glance.
const ALWAYS_SHOW_REGIONS = new Set(['bedrock', 'azureopenai'])

// ── Pure helpers ─────────────────────────────────────────────

// Classify incident type from title keywords. Returns one of:
//   'down' | 'degraded_perf' | 'inference' | 'incident'
// Generic 'incident' is the fallback when no keyword matches — callers can
// treat it as a less-severe-than-'down' indicator.
export function classifyIncident(title) {
  if (!title || typeof title !== 'string') return 'incident'
  const lower = title.toLowerCase()
  if (/\b(down|outage|unavailable)\b/.test(lower)) return 'down'
  if (/\b(latency|slow|timeout|delay)\b/.test(lower)) return 'degraded_perf'
  if (/\b(inference|grok|model|gemini|vertex|bedrock)\b/.test(lower)) return 'inference'
  return 'incident'
}

// ── Main computation ─────────────────────────────────────────
//
// Returns `null` when there's nothing to render — either the service has no
// region map, or it has no ongoing incidents AND isn't an always-show service.
// Callers can treat null as "skip the region UI" without further checks.
//
// Returns a result object otherwise with:
//   regions[]            — one entry per defined region, `{ key, label, status, type }`
//   okRegions[]          — subset of regions with status 'ok'
//   incidentRegions[]    — subset with status 'incident'
//   hasRegionSpecific    — true if any region matched an incident title /
//                          componentNames substring; false when we fell back
//                          to the "global incident → mark all regions" path
//   hasGlobalIncident    — true if at least one ongoing incident matched NO
//                          region (a whole-service outage). Distinct from
//                          !hasRegionSpecific: both a region-specific AND a
//                          global incident can be ongoing at once (#422)
//   allDown              — every defined region is in incident state
//   recommendedRegion    — first OK region by SERVICE_REGIONS array order,
//                          or null when allDown
//   docsUrl              — REGION_DOCS_URL[service.id] or undefined
//   ongoingCount         — number of ongoing incidents considered

export function regionStatusOf(service, opts = {}) {
  if (!service || typeof service !== 'object') return null
  const { regions: regionDefs = SERVICE_REGIONS[service.id] } = opts
  if (!Array.isArray(regionDefs) || regionDefs.length === 0) return null

  const allIncidents = Array.isArray(service.incidents) ? service.incidents : []
  // aistudio:-prefixed incidents come from the global direct Gemini API surface,
  // which has no per-region breakdown — including them would trigger the
  // "no region match → mark all regions affected" fallback and overstate the
  // impact. Region breakdown only makes sense for Vertex (gcloud) feed entries
  // whose titles include region keywords. See worker/src/services.ts (#310).
  const ongoing = allIncidents.filter(
    (i) =>
      i &&
      typeof i.title === 'string' &&
      i.status !== 'resolved' &&
      typeof i.id === 'string' &&
      !i.id.startsWith('aistudio:'),
  )

  const alwaysShow = ALWAYS_SHOW_REGIONS.has(service.id)
  if (ongoing.length === 0 && !alwaysShow) return null

  // Default every region to OK; downgrade as incidents claim regions.
  const status = {}
  for (const r of regionDefs) {
    status[r.key] = { status: 'ok', type: 'incident' }
  }

  let hasRegionSpecific = false
  // True when at least one ongoing incident matched NO region key — i.e. a
  // "global" incident affecting the whole service, not a single region. Tracked
  // per-incident (not just the aggregate `!hasRegionSpecific`) so the mixed case
  // — one region-specific incident PLUS one global incident — is detectable.
  // Region marking is intentionally left unchanged (SPA/Edge render identically);
  // only consumers that must NOT recommend a region during a global outage
  // (Worker Discord hint, #422 Phase 2) read this flag. See buildRegionHint.
  let hasGlobalIncident = false
  for (const inc of ongoing) {
    const titleLower = (inc.title || '').toLowerCase()
    const compNames = (inc.componentNames ?? []).map((n) => String(n).toLowerCase())
    let incMatched = false
    for (const r of regionDefs) {
      const keyLower = r.key.toLowerCase()
      if (titleLower.includes(keyLower) || compNames.some((n) => n.includes(keyLower))) {
        // First-match-wins for incident type. NOTE: this is a DELIBERATE
        // semantic change from the pre-extraction code in ServiceDetails.jsx,
        // which unconditionally overwrote with the last matching incident's
        // classification. Under the old behavior, the badge color flipped each
        // time `service.incidents` was re-sorted in upstream parsers — visually
        // unstable when the same region had multiple ongoing incidents (e.g. a
        // "Service outage" plus a follow-up "Latency spike"). First-match-wins
        // is deterministic across re-renders. If two ongoing incidents claim
        // the same region with different `classifyIncident` outputs, the one
        // that appears earliest in `service.incidents` decides the badge.
        if (status[r.key].status === 'ok') {
          status[r.key] = { status: 'incident', type: classifyIncident(inc.title) }
        }
        hasRegionSpecific = true
        incMatched = true
      }
    }
    if (!incMatched) hasGlobalIncident = true
  }

  // Global-incident fallback — no region substring matched but we know
  // something IS ongoing. Mark every region with the first incident's type.
  // This is intentionally pessimistic: better to over-warn than under-warn
  // when the upstream feed gives us no region signal.
  if (!hasRegionSpecific && ongoing.length > 0) {
    const globalType = classifyIncident(ongoing[0].title)
    for (const r of regionDefs) {
      status[r.key] = { status: 'incident', type: globalType }
    }
  }

  const regions = regionDefs.map((r) => ({ ...r, ...status[r.key] }))
  const okRegions = regions.filter((r) => r.status === 'ok')
  const incidentRegions = regions.filter((r) => r.status === 'incident')
  const allDown = okRegions.length === 0

  return {
    regions,
    okRegions,
    incidentRegions,
    hasRegionSpecific,
    hasGlobalIncident,
    allDown,
    recommendedRegion: okRegions[0] ?? null,
    docsUrl: REGION_DOCS_URL[service.id],
    ongoingCount: ongoing.length,
  }
}

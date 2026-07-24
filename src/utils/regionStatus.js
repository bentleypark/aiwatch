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
  // openai is region-AWARE but not region-SWITCHABLE — see REGION_SWITCHABLE below (#973).
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

// Services whose regions the CALLER can actually choose. Being in SERVICE_REGIONS only means we can
// tell which region an incident hit (region-aware); it does not mean the reader can move off it.
//
// openai is the counterexample that motivated this split (#973): its region keys were copied from
// services.ts `incidentKeywords` — tokens that match region names OpenAI names in incident TEXT —
// but the OpenAI API exposes no region endpoint (project-level data residency only). We rendered
// "Switch region: OpenAI API → US West (us-west-2)" on three surfaces — advice nobody could act on —
// and on a fourth path it silently suppressed the cross-service fallback the reader COULD act on.
// xai is the mirror image: no doc page survives (#560) yet the switch is real (us-east-1.api.x.ai).
// So switchability tracks neither SERVICE_REGIONS membership nor REGION_DOCS_URL membership.
//
// Enforced in ONE place — `recommendedRegion` below is null for a non-switchable service. Every
// recommendation surface already guards on `!recommendedRegion` (Overview.jsx ActionBanner,
// api/_is-down/html-template.ts, worker/src/alerts.ts buildRegionHint, constants.js hasRegionSwitch),
// so they all fall silent and `getGroupedFallbacksExcludingRegionSwitchable` serves the
// cross-service fallback instead — an action the reader CAN take. The per-region status list keeps
// rendering: "us-east-1 is the one that's down" is useful even when you can't leave it.
export const REGION_SWITCHABLE = new Set(['xai', 'gemini', 'azureopenai', 'bedrock', 'pinecone'])

// Every entry must land the reader ON the region list for that service — not merely resolve.
// A retired doc path that 301s to an unrelated guide still returns 200, so reachability proves
// nothing (#973: pinecone's `troubleshooting/available-cloud-regions` redirected to the top of
// "Create an index"). Verify the landing page in a real browser before adding or changing a URL;
// no verified region doc → no entry, and the card/banner simply omits the link.
//
// xai has NO entry (#560): xAI removed its regional-endpoints doc page (docs.x.ai/docs/regions
// → 404, no live replacement in the current docs nav).
// openai has NO entry (#973): "Production best practices" was never a region doc, and no
// executable region switch exists — see the SERVICE_REGIONS comment above.
// chatgpt had an entry but never a SERVICE_REGIONS map, so regionStatusOf returned null before
// reading it — the URL never rendered anywhere. Removed (#973).
// (api/_is-down/region-status.ts mirrors all of this; region-status-sync.test.ts pins the pair.)
export const REGION_DOCS_URL = {
  gemini: 'https://cloud.google.com/vertex-ai/docs/general/locations',
  azureopenai: 'https://learn.microsoft.com/en-us/azure/ai-foundry/reference/region-support',
  bedrock: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-regions.html',
  pinecone: 'https://docs.pinecone.io/guides/index-data/create-an-index#cloud-regions',
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
//   recommendedRegion    — first OK region by SERVICE_REGIONS array order; null
//                          when allDown OR when the service is region-aware but
//                          not region-switchable (see REGION_SWITCHABLE, #973)
//   docsUrl              — REGION_DOCS_URL[service.id] or undefined
//   ongoingCount         — number of ongoing incidents considered

export function regionStatusOf(service, opts = {}) {
  if (!service || typeof service !== 'object') return null
  const { regions: regionDefs = SERVICE_REGIONS[service.id] } = opts
  if (!Array.isArray(regionDefs) || regionDefs.length === 0) return null

  const allIncidents = Array.isArray(service.incidents) ? service.incidents : []
  // True when an incident names one of THIS service's tracked regions (title or
  // componentNames substring) — same match the main loop uses below.
  const mentionsRegion = (inc) => {
    const t = (inc.title || '').toLowerCase()
    const comp = (inc.componentNames ?? []).map((n) => String(n).toLowerCase())
    return regionDefs.some((r) => {
      const k = r.key.toLowerCase()
      return t.includes(k) || comp.some((n) => n.includes(k))
    })
  }

  // aistudio:-prefixed incidents come from the global direct Gemini API surface,
  // which has no per-region breakdown — including them would trigger the
  // "no region match → mark all regions affected" fallback and overstate the
  // impact. Region breakdown only makes sense for Vertex (gcloud) feed entries
  // whose titles include region keywords. See worker/src/services.ts (#310).
  // Likewise FedRAMP (#693): an OpenAI FedRAMP incident (now surfaced under openai)
  // is a compliance-isolated plane, NOT one of the tracked commercial regions
  // (us-east-1/us-west-2/eu-central-1) — its region-less title would otherwise trip
  // the global fallback and falsely paint all 3 commercial regions down. Excluded
  // ONLY when it names no tracked region, so a (rare) "us-east-1 and FedRAMP …"
  // incident still surfaces that real region instead of being silently dropped.
  const ongoing = allIncidents.filter(
    (i) =>
      i &&
      typeof i.title === 'string' &&
      i.status !== 'resolved' &&
      typeof i.id === 'string' &&
      !i.id.startsWith('aistudio:') &&
      !(/fedramp/i.test(i.title) && !mentionsRegion(i)),
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
  //
  // Gated by service status (#1149): if the component-aware service status is
  // 'operational', component-level resolution has already determined this service's
  // own capability is unaffected (e.g. OpenAI dropped the 'api' component from an
  // open incident). Do not trip the pessimistic global fallback when the badge says
  // operational.
  if (!hasRegionSpecific && ongoing.length > 0 && service.status !== 'operational') {
    const globalType = classifyIncident(ongoing[0].title)
    for (const r of regionDefs) {
      status[r.key] = { status: 'incident', type: globalType }
    }
  }

  const regions = regionDefs.map((r) => ({ ...r, ...status[r.key] }))
  const okRegions = regions.filter((r) => r.status === 'ok')
  const incidentRegions = regions.filter((r) => r.status === 'incident')
  const allDown = okRegions.length === 0

  if (incidentRegions.length === 0 && !alwaysShow) return null

  return {
    regions,
    okRegions,
    incidentRegions,
    hasRegionSpecific,
    hasGlobalIncident,
    allDown,
    recommendedRegion: REGION_SWITCHABLE.has(service.id) ? (okRegions[0] ?? null) : null,
    docsUrl: REGION_DOCS_URL[service.id],
    ongoingCount: ongoing.length,
  }
}

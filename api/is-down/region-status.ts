// Server-side region status helper for /is-X-down SSR pages.
//
// Mirrors `regionStatusOf` from `src/utils/regionStatus.js` — duplicated rather
// than shared because Vercel Edge bundling cannot import from `src/`. The cross-
// mirror sync is pinned by `worker/src/__tests__/region-status-sync.test.ts`
// (added in the same PR — refs #422 Phase 2): SERVICE_REGIONS deep-equal + the
// inline keys must match. If you change the matching algorithm here, change the
// SPA copy in the same commit.
//
// Why a TS port instead of JS import: keeps the Edge Function's compilation
// surface fully typed and stops `node_modules`-vs-`src/` resolution from
// surprising the Vercel bundler. The data shapes (SERVICE_REGIONS entries,
// SERVICE_REGIONS keys, REGION_DOCS_URL slugs) are pure data — no runtime
// side effects, no environment-variable reads, no module-load fetches.

export type RegionDef = { key: string; label: string }

export type IncidentLike = {
  id?: unknown
  title?: unknown
  status?: unknown
  componentNames?: unknown
}

export type ServiceLike = {
  id?: string
  incidents?: unknown[]
}

export type RegionRow = RegionDef & { status: 'ok' | 'incident'; type: IncidentType }

export type IncidentType = 'down' | 'degraded_perf' | 'inference' | 'incident'

export type RegionStatusResult = {
  regions: RegionRow[]
  okRegions: RegionRow[]
  incidentRegions: RegionRow[]
  hasRegionSpecific: boolean
  allDown: boolean
  recommendedRegion: RegionRow | null
  docsUrl: string | undefined
  ongoingCount: number
}

// Keep in lockstep with src/utils/regionStatus.js SERVICE_REGIONS. Order
// matters: the FIRST healthy region in this array is what `recommendedRegion`
// resolves to. Convention: cluster regions by cloud provider (AWS first, then
// Azure, then GCP) so a same-cloud fallback is the natural default.
export const SERVICE_REGIONS: Record<string, RegionDef[]> = {
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

export const REGION_DOCS_URL: Record<string, string> = {
  xai: 'https://docs.x.ai/docs/regions',
  gemini: 'https://cloud.google.com/vertex-ai/docs/general/locations',
  openai: 'https://platform.openai.com/docs/guides/production-best-practices',
  chatgpt: 'https://status.openai.com',
  azureopenai: 'https://learn.microsoft.com/azure/ai-services/openai/concepts/models',
  bedrock: 'https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-regions.html',
  pinecone: 'https://docs.pinecone.io/troubleshooting/available-cloud-regions',
}

const ALWAYS_SHOW_REGIONS = new Set(['bedrock', 'azureopenai'])

export function classifyIncident(title: unknown): IncidentType {
  if (!title || typeof title !== 'string') return 'incident'
  const lower = title.toLowerCase()
  if (/\b(down|outage|unavailable)\b/.test(lower)) return 'down'
  if (/\b(latency|slow|timeout|delay)\b/.test(lower)) return 'degraded_perf'
  if (/\b(inference|grok|model|gemini|vertex|bedrock)\b/.test(lower)) return 'inference'
  return 'incident'
}

export function regionStatusOf(service: ServiceLike | null | undefined): RegionStatusResult | null {
  if (!service || typeof service !== 'object') return null
  const regionDefs = service.id ? SERVICE_REGIONS[service.id] : undefined
  if (!Array.isArray(regionDefs) || regionDefs.length === 0) return null

  const allIncidents = Array.isArray(service.incidents) ? service.incidents : []
  // aistudio:-prefixed incidents come from the global direct Gemini API surface,
  // which has no per-region breakdown — including them would trigger the
  // "no region match → mark all regions affected" fallback and overstate the
  // impact. See worker/src/services.ts #310.
  const ongoing = allIncidents.filter((i): i is IncidentLike => {
    if (!i || typeof i !== 'object') return false
    const inc = i as IncidentLike
    return (
      typeof inc.title === 'string' &&
      inc.status !== 'resolved' &&
      typeof inc.id === 'string' &&
      !(inc.id as string).startsWith('aistudio:')
    )
  })

  const alwaysShow = service.id ? ALWAYS_SHOW_REGIONS.has(service.id) : false
  if (ongoing.length === 0 && !alwaysShow) return null

  const status: Record<string, { status: 'ok' | 'incident'; type: IncidentType }> = {}
  for (const r of regionDefs) {
    status[r.key] = { status: 'ok', type: 'incident' }
  }

  let hasRegionSpecific = false
  for (const inc of ongoing) {
    const titleLower = (inc.title as string).toLowerCase()
    const compNames = Array.isArray(inc.componentNames)
      ? (inc.componentNames as unknown[]).map((n) => String(n).toLowerCase())
      : []
    for (const r of regionDefs) {
      const keyLower = r.key.toLowerCase()
      if (titleLower.includes(keyLower) || compNames.some((n) => n.includes(keyLower))) {
        // First-match-wins for incident type — see SPA copy
        // src/utils/regionStatus.js for rationale. Deterministic across
        // re-renders / re-orders, vs the pre-extraction last-wins behavior.
        if (status[r.key].status === 'ok') {
          status[r.key] = { status: 'incident', type: classifyIncident(inc.title) }
        }
        hasRegionSpecific = true
      }
    }
  }

  if (!hasRegionSpecific && ongoing.length > 0) {
    const globalType = classifyIncident((ongoing[0] as IncidentLike).title)
    for (const r of regionDefs) {
      status[r.key] = { status: 'incident', type: globalType }
    }
  }

  const regions: RegionRow[] = regionDefs.map((r) => ({ ...r, ...status[r.key] }))
  const okRegions = regions.filter((r) => r.status === 'ok')
  const incidentRegions = regions.filter((r) => r.status === 'incident')
  const allDown = okRegions.length === 0

  return {
    regions,
    okRegions,
    incidentRegions,
    hasRegionSpecific,
    allDown,
    recommendedRegion: okRegions[0] ?? null,
    docsUrl: service.id ? REGION_DOCS_URL[service.id] : undefined,
    ongoingCount: ongoing.length,
  }
}

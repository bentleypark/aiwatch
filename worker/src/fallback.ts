// Fallback recommendation logic for incident alerts

// Keep in sync with src/utils/constants.js EXCLUDE_FALLBACK
export const EXCLUDE_FALLBACK = ['replicate', 'huggingface', 'pinecone', 'stability', 'voyageai', 'modal', 'characterai', 'bedrock', 'azureopenai']

// Tier-based priority — same-tier services sorted by Score, then adjacent tiers by distance.
// API tiers (1-4) and agent tiers (11-13) use distinct number ranges so TIER_LABEL stays unambiguous
// and the cross-category category filter in getFallbacks already prevents API ↔ agent leakage.
// Without agent tiers (#402), all 6 agents fell through to `?? 99` and got Score-only ordering, which
// pushed Junie (new service, shallow incident history → inflated Score) to #1 for unrelated outages.
//
// Exported for the cross-mirror sync test (worker/src/__tests__/api-tier-sync.test.ts) — that test
// is the only safeguard against drift between the three independent copies of this map (#403).
export const API_TIER: Record<string, number> = {
  claude: 1, openai: 1, gemini: 1,
  mistral: 2, cohere: 2, groq: 2, together: 2, fireworks: 2, cerebras: 2, deepseek: 2, xai: 2, perplexity: 2,
  bedrock: 3, azureopenai: 3, openrouter: 3,
  elevenlabs: 4, assemblyai: 4, deepgram: 4,
  // Tier 5 = generative Video (#602 / #601 step B). A distinct tier so a degraded video service
  // recommends its video sibling (distance 0) over a tier-3 LLM router / infra service.
  runway: 5, luma: 5,
  // Tier 6 = LLM Observability (#601 step B). LangSmith + Helicone + Langfuse recommend each other;
  // LangSmith un-excluded from EXCLUDE_FALLBACK now that the category has ≥2 members.
  langsmith: 6, helicone: 6, langfuse: 6,
  claudecode: 11, codex: 11,
  cursor: 12, windsurf: 12,
  copilot: 13, junie: 13,
  // App-category services. All three share tier 21, so same-tier distance collapses to 0
  // across every pairing and ordering reduces to Score — identical to the pre-#403 `?? 99`
  // fall-through, just without the warn-once noise. Entries exist only to suppress the
  // `tierFor` warn-once that would otherwise fire whenever chatgpt/claudeai surface as the
  // affected service in a fallback flow (Character.AI is in EXCLUDE_FALLBACK so it never does).
  chatgpt: 21, claudeai: 21, characterai: 21, deepseekapp: 21,
}

// #403 — surfaces the silent-fallback failure mode that produced #402 (Junie-as-#1) without
// changing the runtime behavior. When a service id isn't in API_TIER (typo, forgotten entry on a
// new service, partial cross-mirror sync), the lookup still resolves to 99 — but the Cloudflare
// Worker logs now carry a one-time breadcrumb so the next "why is fallback ordering weird?" debug
// session has a starting point. Module-scoped Set so the warning is throttled per worker isolate;
// repeated calls for the same id stay quiet.
const warnedTierIds = new Set<string>()
export function tierFor(id: string): number {
  const t = API_TIER[id]
  if (t !== undefined) return t
  if (!warnedTierIds.has(id)) {
    warnedTierIds.add(id)
    console.warn(`[fallback] no API_TIER for service "${id}" — falling back to 99 (Score-only ordering)`)
  }
  return 99
}

interface FallbackCandidate {
  id: string
  category: string
  name: string
  status: string
  /** #550 — used to exclude candidates with an unresolved incident (operational-but-incident). */
  incidents?: Array<{ status: string }>
  /** #616 — stale incident source (#591). Excluded from Score ranking, so it must also be excluded
   *  as a fallback candidate: recommending a service we don't trust enough to rank contradicts the
   *  same product surface. */
  incidentSourceStale?: boolean
  aiwatchScore?: number | null
  /** #554 — provider is intentionally NOT read by selection here: the worker has no same-provider
   *  exclusion (the dashboard dropped its dashboard-only one for parity). Carried only so the #554
   *  parity-guard test can prove a same-provider clean candidate is kept — re-adding a provider
   *  filter that reads this field would break that test, catching the drift. */
  provider?: string
}

/** #550 — a service with any unresolved incident (investigating/identified/monitoring) is not a
 *  healthy fallback even when its computed status is still 'operational'. */
function hasActiveIncident(s: FallbackCandidate): boolean {
  return (s.incidents ?? []).some(i => i.status !== 'resolved')
}

export function getFallbacks(
  serviceId: string,
  category: string,
  services: FallbackCandidate[],
): Array<{ name: string; score: number | null }> {
  if (EXCLUDE_FALLBACK.includes(serviceId)) return []
  const sourceTier = tierFor(serviceId)
  return services
    .filter(s => s.category === category && s.id !== serviceId && s.status === 'operational' && !hasActiveIncident(s) && !s.incidentSourceStale && !EXCLUDE_FALLBACK.includes(s.id))
    .sort((a, b) => {
      // Prefer same or adjacent tier to the affected service
      const tierA = tierFor(a.id)
      const tierB = tierFor(b.id)
      const distA = Math.abs(tierA - sourceTier)
      const distB = Math.abs(tierB - sourceTier)
      if (distA !== distB) return distA - distB
      // Within same tier distance, sort by Score descending
      return (b.aiwatchScore ?? 0) - (a.aiwatchScore ?? 0)
    })
    .slice(0, 2)
    .map(s => ({ name: s.name, score: s.aiwatchScore ?? null }))
}

export function buildFallbackText(fallbacks: Array<{ name: string; score: number | null }>): string {
  // #641 — no recommendation → emit nothing (the Discord embed omits an empty fallbackText). We
  // don't assert "no fallback available": that's a subjective claim from our own (incomplete)
  // coverage and may be inaccurate — "we have no recommendation" ≠ "no alternative exists".
  if (fallbacks.length === 0) return ''
  const list = fallbacks.map((f, i) => {
    const label = f.score != null ? `${f.name} (Score ${f.score})` : f.name
    return label
  }).join(' · ')
  return `👉 Suggested fallback: ${list}`
}

const CATEGORY_LABEL: Record<string, string> = {
  api: 'API', app: 'AI Apps', agent: 'Coding Agent',
}
// Agent tier labels carry an "Agent" suffix to keep the noun visible — without it the bare
// `CLI` / `IDE` / `Plugin` reads as untyped jargon next to category-named peers in the same
// fallback line ("AI Apps → claude.ai" + "CLI → Claude Code" was the asymmetry that triggered
// the rename). LLM / Voice / Infra stay bare because those abbreviations are already
// self-identifying as service categories in the API space.
// Exported for the cross-mirror sync test (#403). Mirrored as TIER_LABEL in src/utils/constants.js;
// Overview.jsx imports from there so there is no third inline copy to drift against.
export const TIER_LABEL: Record<number, string> = {
  1: 'LLM', 2: 'LLM', 3: 'Infra', 4: 'Voice', 5: 'Video', 6: 'Observability',
  11: 'CLI Agent', 12: 'IDE Agent', 13: 'Plugin Agent',
  21: 'AI Apps', // matches CATEGORY_LABEL[app] so the existing buildGroupedFallbackText copy stays consistent
}

// #403 — same shape as tierFor, for tier numbers that lack a label. Returns undefined (not a
// sentinel string) because the call sites use `tierLabel ? … : fallback` semantics — a sentinel
// would break that branch. The warning is the operator-visibility part; the return is identical
// to the bare lookup it replaces.
const warnedLabelTiers = new Set<number>()
export function tierLabelFor(tier: number): string | undefined {
  const l = TIER_LABEL[tier]
  if (l !== undefined) return l
  if (!warnedLabelTiers.has(tier)) {
    warnedLabelTiers.add(tier)
    console.warn(`[fallback] no TIER_LABEL for tier ${tier} — grouped fallback display will degrade to bare category label`)
  }
  return undefined
}

/**
 * Build fallback text for a group of affected services (possibly spanning multiple categories).
 * Returns multi-line text when multiple categories are affected.
 */
export function buildGroupedFallbackText(
  affectedServiceIds: string[],
  services: FallbackCandidate[],
): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const svcId of affectedServiceIds) {
    if (EXCLUDE_FALLBACK.includes(svcId)) continue
    const svc = services.find(s => s.id === svcId)
    if (!svc) {
      console.warn(`[fallback] buildGroupedFallbackText: service ID "${svcId}" not found`)
      continue
    }
    if (svc.status === 'operational') continue
    const tier = tierFor(svcId)
    const tierLabel = tierLabelFor(tier)
    const groupKey = tierLabel ? `${svc.category}:${tierLabel}` : svc.category
    if (seen.has(groupKey)) continue
    seen.add(groupKey)
    const fallbacks = getFallbacks(svcId, svc.category, services)
    if (fallbacks.length === 0) continue
    const label = tierLabel || CATEGORY_LABEL[svc.category] || svc.category
    const list = fallbacks.map((f, i) => {
      const name = f.score != null ? `${f.name} (Score ${f.score})` : f.name
      return name
    }).join(' · ')
    lines.push(`${label}: ${list}`)
  }
  if (lines.length === 0) return '' // #641 — no recommendation → emit nothing (see buildFallbackText)
  return `👉 Suggested fallback:\n${lines.join('\n')}`
}

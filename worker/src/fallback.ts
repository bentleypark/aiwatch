// Fallback recommendation logic for incident alerts

import { isNonReliabilityAdvisory } from './utils'

// Keep in sync with src/utils/constants.js EXCLUDE_FALLBACK
// #756 — stability un-excluded now that the image category has ≥2 members (Stability + FLUX recommend
// each other in Tier 7); bfl is fallback-eligible from the start (never added here).
// #857 — pinecone un-excluded now that the vector category has ≥2 members (Pinecone + turbopuffer recommend
// each other in Tier 8); turbopuffer is fallback-eligible from the start (never added here).
export const EXCLUDE_FALLBACK = ['replicate', 'huggingface', 'fal', 'voyageai', 'modal', 'characterai', 'bedrock', 'azureopenai']

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
  // Tier 7 = Image generation (#756 / #601 step B). Stability + FLUX recommend each other; both
  // un-excluded from EXCLUDE_FALLBACK now that the category has ≥2 members. A distinct tier so a
  // degraded image service recommends its image sibling (distance 0) over an LLM/voice/infra service.
  stability: 7, bfl: 7,
  // Tier 8 = Vector database (#857 / #601 step B). Pinecone + turbopuffer recommend each other; pinecone
  // un-excluded from EXCLUDE_FALLBACK now that the category has ≥2 members. A distinct tier so a degraded
  // vector DB recommends its vector sibling (distance 0) over an LLM/voice/image/infra service.
  pinecone: 8, turbopuffer: 8,
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
  /** #550 — used to exclude candidates with an unresolved incident (operational-but-incident).
   *  #811 — `title` lets `hasActiveIncident` ignore a non-reliability ADVISORY (access suspension /
   *  compliance / deprecation), which must NOT disqualify an otherwise-operational candidate. */
  incidents?: Array<{ status: string; title?: string }>
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

/** #550 — a service with an unresolved RELIABILITY incident (investigating/identified/monitoring) is not
 *  a healthy fallback even when its computed status is still 'operational' (the partial-degradation case).
 *  #811 — but a non-reliability ADVISORY (e.g. a Claude model-access suspension: operational badge, no
 *  outage signal) must NOT disqualify the candidate — recommending Claude Code when ChatGPT is down is
 *  correct even while Anthropic carries a Mythos/Fable access-suspension notice. An outage-signal title
 *  still counts (isNonReliabilityAdvisory returns false for it), preserving #550 for genuine degradations. */
function hasActiveIncident(s: FallbackCandidate): boolean {
  return (s.incidents ?? []).some(i => i.status !== 'resolved' && !isNonReliabilityAdvisory(i.title ?? ''))
}

// #859 — a specialized non-LLM API sub-tier only recommends its OWN tier. Cross-tier fill (fill top-2
// by tier distance) is correct for the LLM tiers (1 Major LLM / 2 LLM / 3 Infra-router: any LLM API
// substitutes another) but wrong for the specialized sub-tiers — Voice (4) / Video (5) / Observability
// (6) / Image (7) / Vector (8) are NOT mutually substitutable, so a degraded vector DB must not be
// offered an image model as its 2nd recommendation (the exact reason these were split into their own
// tiers in #601/#602/#756/#857). Range 4–10 covers the current + near-future API sub-tiers; agents
// (11–13) and apps (21) are separate CATEGORIES (filtered by `category` in getFallbacks) and keep
// cross-tier fill within their category, so they're intentionally excluded.
export function isSpecializedSubTier(tier: number): boolean {
  return tier >= 4 && tier <= 10
}

export function getFallbacks(
  serviceId: string,
  category: string,
  services: FallbackCandidate[],
): Array<{ name: string; score: number | null }> {
  if (EXCLUDE_FALLBACK.includes(serviceId)) return []
  const sourceTier = tierFor(serviceId)
  // #859 — for a specialized sub-tier source, restrict candidates to the SAME tier (no cross-tier bleed).
  const sameTierOnly = isSpecializedSubTier(sourceTier)
  return services
    .filter(s => s.category === category && s.id !== serviceId && s.status === 'operational' && !hasActiveIncident(s) && !s.incidentSourceStale && !EXCLUDE_FALLBACK.includes(s.id)
      && (!sameTierOnly || tierFor(s.id) === sourceTier))
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
  1: 'LLM', 2: 'LLM', 3: 'Infra', 4: 'Voice', 5: 'Video', 6: 'Observability', 7: 'Image', 8: 'Vector',
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
 * #781 — structured per-category grouped fallbacks for a (possibly multi-surface) incident. ONE group
 * per distinct `category:tierLabel` among the affected, non-operational services; within a group the
 * candidates come from getFallbacks (operational + incident-free + same category, Score-ordered).
 *
 * perGroup mirrors the frontend `getGroupedFallbacks` (src/utils/constants.js) for dashboard parity:
 * **2 when there is a single group** (a same-category incident → top-2 alternatives, the old flat
 * behavior), **1 when there are multiple groups** (a multi-category incident → one alternative per
 * category, so the line stays scannable). Pure; the worker surfaces (Discord alert via
 * buildGroupedFallbackText, RSS feed via fallbackLine) render this structure their own way.
 */
export function getGroupedFallbacks(
  affectedServiceIds: string[],
  services: FallbackCandidate[],
): Array<{ label: string; fallbacks: Array<{ name: string; score: number | null }> }> {
  const groupKeyOf = (svc: FallbackCandidate) => {
    const tierLabel = tierLabelFor(tierFor(svc.id))
    return tierLabel ? `${svc.category}:${tierLabel}` : svc.category
  }
  // An affected surface anchors a group when it's genuinely having a problem — non-operational OR
  // operational-but-carrying-an-active-incident (#550, the partial-degradation case where status stays
  // 'operational'). Matches the frontend getGroupedFallbacks intent (which trusts its `affected` list);
  // here the list comes from the incident's own surfaces, so an operational member is the #550 edge, not
  // a clean service. EXCLUDE_FALLBACK members never anchor (we have no recommendation discipline for them).
  const eligible = affectedServiceIds
    .map(id => services.find(s => s.id === id))
    .filter((s): s is FallbackCandidate =>
      !!s && !EXCLUDE_FALLBACK.includes(s.id) && (s.status !== 'operational' || hasActiveIncident(s)))
  const numGroups = new Set(eligible.map(groupKeyOf)).size
  const perGroup = numGroups <= 1 ? 2 : 1
  const seen = new Set<string>()
  const groups: Array<{ label: string; fallbacks: Array<{ name: string; score: number | null }> }> = []
  for (const svc of eligible) {
    const key = groupKeyOf(svc)
    if (seen.has(key)) continue
    seen.add(key)
    const fbs = getFallbacks(svc.id, svc.category, services).slice(0, perGroup)
    if (fbs.length === 0) continue
    const tierLabel = tierLabelFor(tierFor(svc.id))
    groups.push({ label: tierLabel || CATEGORY_LABEL[svc.category] || svc.category, fallbacks: fbs })
  }
  return groups
}

export function buildGroupedFallbackText(
  affectedServiceIds: string[],
  services: FallbackCandidate[],
): string {
  const groups = getGroupedFallbacks(affectedServiceIds, services)
  if (groups.length === 0) return '' // #641 — no recommendation → emit nothing (see buildFallbackText)
  const lines = groups.map(g => {
    const list = g.fallbacks.map(f => (f.score != null ? `${f.name} (Score ${f.score})` : f.name)).join(' · ')
    return `${g.label}: ${list}`
  })
  return `👉 Suggested fallback:\n${lines.join('\n')}`
}

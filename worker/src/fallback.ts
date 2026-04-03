// Fallback recommendation logic for incident alerts

// Keep in sync with src/utils/constants.js EXCLUDE_FALLBACK
export const EXCLUDE_FALLBACK = ['replicate', 'huggingface', 'pinecone', 'stability', 'characterai']

// Tier-based priority for API services — major LLMs first, then secondary, then infrastructure, then voice
// Same-tier services are sorted by Score. Higher tier = lower number = higher priority.
const API_TIER: Record<string, number> = {
  claude: 1, openai: 1, gemini: 1,
  mistral: 2, cohere: 2, groq: 2, together: 2, fireworks: 2, deepseek: 2, xai: 2, perplexity: 2,
  bedrock: 3, azureopenai: 3, openrouter: 3,
  elevenlabs: 4, assemblyai: 4, deepgram: 4,
}

interface FallbackCandidate {
  id: string
  category: string
  name: string
  status: string
  aiwatchScore?: number | null
}

export function getFallbacks(
  serviceId: string,
  category: string,
  services: FallbackCandidate[],
): Array<{ name: string; score: number | null }> {
  if (EXCLUDE_FALLBACK.includes(serviceId)) return []
  const sourceTier = API_TIER[serviceId] ?? 99
  return services
    .filter(s => s.category === category && s.id !== serviceId && s.status === 'operational' && !EXCLUDE_FALLBACK.includes(s.id))
    .sort((a, b) => {
      // Prefer same or adjacent tier to the affected service
      const tierA = API_TIER[a.id] ?? 99
      const tierB = API_TIER[b.id] ?? 99
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
  if (fallbacks.length === 0) return '⚠️ No operational fallback available. Consider retry logic or caching.'
  const list = fallbacks.map((f, i) => {
    const label = f.score != null ? `${f.name} (Score ${f.score})` : f.name
    return label
  }).join(' · ')
  return `👉 Suggested fallback: ${list}`
}

const CATEGORY_LABEL: Record<string, string> = {
  api: 'API', app: 'AI Apps', agent: 'Coding Agent',
}
const TIER_LABEL: Record<number, string> = { 1: 'LLM', 2: 'LLM', 3: 'Infra', 4: 'Voice' }

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
    const tier = API_TIER[svcId] ?? 99
    const tierLabel = TIER_LABEL[tier]
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
  if (lines.length === 0) return '⚠️ No operational fallback available. Consider retry logic or caching.'
  return `👉 Suggested fallback:\n${lines.join('\n')}`
}

// Fallback recommendation logic for incident alerts

// Keep in sync with src/utils/constants.js EXCLUDE_FALLBACK
export const EXCLUDE_FALLBACK = ['elevenlabs', 'replicate', 'huggingface', 'pinecone', 'stability', 'characterai']

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
  return services
    .filter(s => s.category === category && s.id !== serviceId && s.status === 'operational')
    .sort((a, b) => (b.aiwatchScore ?? 0) - (a.aiwatchScore ?? 0))
    .slice(0, 2)
    .map(s => ({ name: s.name, score: s.aiwatchScore ?? null }))
}

export function buildFallbackText(fallbacks: Array<{ name: string; score: number | null }>): string {
  if (fallbacks.length === 0) return '⚠️ No operational fallback available. Consider retry logic or caching.'
  const list = fallbacks.map((f, i) => {
    const label = f.score != null ? `${f.name} (Score ${f.score})` : f.name
    return i === 0 ? `★ ${label}` : label
  }).join(' · ')
  return `👉 Suggested fallback: ${list}`
}

const CATEGORY_LABEL: Record<string, string> = {
  api: 'API', webapp: 'Web App', agent: 'Coding Agent',
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
    if (seen.has(svc.category)) continue
    seen.add(svc.category)
    const fallbacks = getFallbacks(svcId, svc.category, services)
    if (fallbacks.length === 0) continue
    const label = CATEGORY_LABEL[svc.category] ?? svc.category
    const list = fallbacks.map((f, i) => {
      const name = f.score != null ? `${f.name} (Score ${f.score})` : f.name
      return i === 0 ? `★ ${name}` : name
    }).join(' · ')
    lines.push(`${label}: ${list}`)
  }
  if (lines.length === 0) return '⚠️ No operational fallback available. Consider retry logic or caching.'
  return `👉 Suggested fallback:\n${lines.join('\n')}`
}

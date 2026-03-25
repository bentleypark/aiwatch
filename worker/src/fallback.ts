// Fallback recommendation logic for incident alerts

// Keep in sync with src/utils/constants.js EXCLUDE_FALLBACK
export const EXCLUDE_FALLBACK = ['elevenlabs', 'replicate', 'huggingface', 'pinecone']

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

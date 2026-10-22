// #1753 — per-service substitute lists, for services whose fallback tier is not the set of real
// substitutes. Read by the worker fallback, the SPA and the Edge is-down page (card + FAQ answer).
// No imports, so the Edge and the SPA can import it without
// pulling the worker's module graph into their bundles. A service without an entry keeps tier routing.

export interface SubstituteGroup {
  /** What the substitute is for — the is-down card subheading ("For …") and the FAQ clause. */
  use: string
  /** Grouped-fallback label (Overview banner, analysis modal, RSS, Discord). */
  label: string
  ids: readonly string[]
  /** First-party pages backing the group's membership, and the day each was read. */
  evidence?: ReadonlyArray<{ url: string; checked: string }>
}

const GENERAL_LLM = ['claude', 'openai', 'gemini', 'xai', 'mistral'] as const
const OPEN_MODEL_HOSTS = ['groq', 'together', 'fireworks', 'cerebras'] as const

export const SUBSTITUTES: Record<string, readonly SubstituteGroup[]> = {
  cohere: [
    { use: 'chat and generation', label: 'LLM', ids: GENERAL_LLM },
    { use: 'embeddings and reranking', label: 'Embeddings', ids: ['voyageai', 'jina'],
      evidence: [{ url: 'https://docs.voyageai.com/docs/reranker', checked: '2026-10-22' }, { url: 'https://jina.ai/reranker/', checked: '2026-10-22' }] },
  ],
  deepseek: [
    { use: 'the same DeepSeek models on another host', label: 'DeepSeek models', ids: ['together', 'fireworks'],
      evidence: [{ url: 'https://docs.together.ai/docs/serverless-models', checked: '2026-10-22' }, { url: 'https://fireworks.ai/models/deepseek-ai/deepseek-v4p1-flash', checked: '2026-10-22' }] },
    { use: 'another LLM API', label: 'LLM', ids: GENERAL_LLM },
  ],
  kimi: [
    { use: 'the same Kimi models on another host', label: 'Kimi models', ids: ['together', 'fireworks'],
      evidence: [{ url: 'https://docs.together.ai/docs/serverless-models', checked: '2026-10-22' }, { url: 'https://fireworks.ai/models/fireworks/kimi-k3', checked: '2026-10-22' }] },
    { use: 'another LLM API', label: 'LLM', ids: GENERAL_LLM },
  ],
  openrouter: [
    { use: 'closed models at their provider', label: 'LLM', ids: GENERAL_LLM },
    { use: 'open models at a host', label: 'LLM Hosting', ids: OPEN_MODEL_HOSTS,
      evidence: [{ url: 'https://openrouter.ai/api/v1/providers', checked: '2026-09-15' }] },
  ],
}

/** The groups that answer this outage, or null when tier routing applies: the service has no list, or
 *  its outage is routed to one capability. */
export function substituteGroupsFor(sourceId: string, routedCapability: string | null): readonly SubstituteGroup[] | null {
  return routedCapability ? null : SUBSTITUTES[sourceId] ?? null
}

/** Each group's candidates, in the caller's order, capped at `perGroup`; groups with none are dropped. */
export function pickSubstitutes<T extends { id: string }>(
  groups: readonly SubstituteGroup[],
  candidates: readonly T[],
  order: (inGroup: T[]) => T[],
  perGroup = 2,
): Array<{ group: SubstituteGroup; items: T[] }> {
  return groups
    .map((group) => ({ group, items: order(candidates.filter((c) => group.ids.includes(c.id))).slice(0, perGroup) }))
    .filter((g) => g.items.length > 0)
}

/** One list for a surface without group labels: a single group's items, else each group's top one. */
export function flattenSubstitutes<T>(picked: ReadonlyArray<{ items: T[] }>): T[] {
  return picked.length === 1 ? picked[0].items : picked.map((p) => p.items[0])
}

function orList(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}

/** "the Claude, OpenAI or Gemini API" when every name ends in " API", else the names as they are. */
function nameList(names: string[]): string {
  return names.length > 1 && names.every((n) => n.endsWith(' API')) ? `the ${orList(names.map((n) => n.slice(0, -4)))} API` : orList(names)
}

/** The is-down FAQ alternatives answer, built from the same list the card reads. */
export function substituteFaqAnswer(displayName: string, groups: readonly SubstituteGroup[], nameOf: (id: string) => string): string {
  const sentences = groups.map((g) => `For ${g.use}: ${nameList(g.ids.map(nameOf))}.`)
  return `When ${displayName} is down, these AIWatch-monitored services can stand in. ${sentences.join(' ')} AIWatch shows current availability for each.`
}

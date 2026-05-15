export const VALID_THEMES = ['dark', 'light', 'system']

export const THEME_STORAGE_KEY = 'aiwatch-theme'

export const LANG_STORAGE_KEY = 'aiwatch-lang'

export const VALID_LANGS = ['ko', 'en']

export const SETTINGS_STORAGE_KEY = 'aiwatch-settings'

export const VALID_PERIODS = ['7d', '30d', '90d']

// API services (latency tracked)
export const API_SERVICE_IDS = [
  'claude', 'openai', 'gemini', 'mistral', 'cohere', 'groq',
  'together', 'fireworks', 'cerebras', 'perplexity', 'huggingface', 'replicate',
  'elevenlabs', 'xai', 'deepseek', 'openrouter', 'bedrock', 'azureopenai',
  'pinecone', 'stability', 'voyageai', 'modal', 'assemblyai', 'deepgram',
]

// AI web apps (no latency — web services, ordered before related API)
export const APP_SERVICE_IDS = ['claudeai', 'chatgpt', 'characterai']

// Coding agents
export const AGENT_SERVICE_IDS = ['claudecode', 'codex', 'cursor', 'copilot', 'windsurf', 'junie']

// Display order: app → LLM → voice → inference → agent
export const SERVICE_AND_APP_IDS = [
  // app
  'claudeai', 'chatgpt', 'characterai',
  // LLM API
  'claude', 'openai', 'gemini', 'bedrock', 'azureopenai', 'mistral', 'cohere', 'groq',
  'together', 'fireworks', 'cerebras', 'perplexity', 'xai', 'deepseek', 'openrouter',
  // voice & speech AI
  'elevenlabs', 'assemblyai', 'deepgram',
  // inference / infrastructure
  'huggingface', 'replicate', 'pinecone', 'stability', 'voyageai', 'modal',
]

// All service IDs
export const ALL_SERVICE_IDS = [...SERVICE_AND_APP_IDS, ...AGENT_SERVICE_IDS]

// Sidebar category filters — splits Worker's 'api' into LLM vs Voice/Inference
export const SERVICE_CATEGORIES = {
  all:       { labelKey: 'filter.all',       ids: null }, // null = show all
  apps:      { labelKey: 'filter.apps',      ids: ['claudeai', 'chatgpt', 'characterai'] },
  llm:       { labelKey: 'filter.llm',       ids: ['claude', 'openai', 'gemini', 'bedrock', 'azureopenai', 'mistral', 'cohere', 'groq', 'together', 'fireworks', 'cerebras', 'perplexity', 'xai', 'deepseek', 'openrouter'] },
  inference: { labelKey: 'filter.inference', ids: ['elevenlabs', 'assemblyai', 'deepgram', 'huggingface', 'replicate', 'pinecone', 'stability', 'voyageai', 'modal'] },
  agents:    { labelKey: 'filter.agents',    ids: ['claudecode', 'codex', 'cursor', 'copilot', 'windsurf', 'junie'] },
}

// Services excluded from fallback recommendations (not interchangeable with LLM APIs)
// Keep in sync with worker/src/fallback.ts EXCLUDE_FALLBACK
export const EXCLUDE_FALLBACK = ['replicate', 'huggingface', 'pinecone', 'stability', 'voyageai', 'modal', 'characterai', 'bedrock', 'azureopenai']

// Fallback tier priority — API services (1-4) and coding agents (11-13) use distinct number ranges
// so TIER_LABEL maps each tier number to one unambiguous label. Within a category, getFallbacks
// orders by tier-distance then by Score.
//
// Cross-mirror sync test (worker/src/__tests__/api-tier-sync.test.ts) asserts byte-for-byte equality
// against worker/src/fallback.ts API_TIER. api/is-down.ts inline copy is checked via string-match.
// All three must move together.
export const API_TIER = {
  claude: 1, openai: 1, gemini: 1,
  mistral: 2, cohere: 2, groq: 2, together: 2, fireworks: 2, cerebras: 2, deepseek: 2, xai: 2, perplexity: 2,
  bedrock: 3, azureopenai: 3, openrouter: 3,
  elevenlabs: 4, assemblyai: 4, deepgram: 4,
  claudecode: 11, codex: 11,
  cursor: 12, windsurf: 12,
  copilot: 13, junie: 13,
  chatgpt: 21, claudeai: 21, characterai: 21,
}

// Sync target for worker/src/fallback.ts TIER_LABEL. Pre-#403 this lived inline in Overview.jsx;
// promoted here so the sync test can compare both copies via a single import without parsing JSX.
export const TIER_LABEL = {
  1: 'LLM', 2: 'LLM', 3: 'Infra', 4: 'Voice',
  11: 'CLI Agent', 12: 'IDE Agent', 13: 'Plugin Agent',
  21: 'AI Apps',
}

// #403 — warn-once helper that surfaces silent missing-id lookups in the dev console without
// changing runtime behavior. Mirrors worker/src/fallback.ts tierFor; the parallel implementation
// is intentional (the worker can't import frontend code at runtime).
const warnedTierIds = new Set()
export function tierFor(id) {
  const t = API_TIER[id]
  if (t !== undefined) return t
  if (!warnedTierIds.has(id)) {
    warnedTierIds.add(id)
    console.warn(`[fallback] no API_TIER for service "${id}" — falling back to 99 (Score-only ordering)`)
  }
  return 99
}

const warnedLabelTiers = new Set()
export function tierLabelFor(tier) {
  const l = TIER_LABEL[tier]
  if (l !== undefined) return l
  if (!warnedLabelTiers.has(tier)) {
    warnedLabelTiers.add(tier)
    console.warn(`[fallback] no TIER_LABEL for tier ${tier} — grouped fallback display will degrade to bare category label`)
  }
  return undefined
}

/**
 * Get top 2 fallback recommendations for a service, sorted by tier proximity + AIWatch Score.
 * @param {object} service - Source service (needs .id, .category)
 * @param {object[]} allServices - All services (needs .id, .category, .status, .aiwatchScore)
 * @returns {{ id: string, name: string, aiwatchScore: number | null }[]}
 */
export function getFallbacks(service, allServices) {
  if (!service || !Array.isArray(allServices) || EXCLUDE_FALLBACK.includes(service.id)) return []
  const sourceTier = tierFor(service.id)
  return allServices
    .filter(s => s.category === service.category && s.id !== service.id && s.status === 'operational' && !EXCLUDE_FALLBACK.includes(s.id))
    .sort((a, b) => {
      const distA = Math.abs(tierFor(a.id) - sourceTier)
      const distB = Math.abs(tierFor(b.id) - sourceTier)
      if (distA !== distB) return distA - distB
      return (b.aiwatchScore ?? 0) - (a.aiwatchScore ?? 0)
    })
    .slice(0, 2)
    .map(s => ({ id: s.id, name: s.name, aiwatchScore: s.aiwatchScore ?? null }))
}

export const VALID_ALERT_CONDITIONS = ['down', 'degraded', 'all']

export const DEFAULT_SETTINGS = {
  period: '7d',
  sla: 99.9,
  enabledServices: ALL_SERVICE_IDS,
  slackUrl: '',
  discordUrl: '',
  alertCondition: 'down',  // 'down' | 'degraded' | 'all'
  alertTarget: 'all',      // 'all' | 'custom'
  alertServices: ALL_SERVICE_IDS,
  alertIncidents: false,
}

export const SCORE_BG_CLASS = {
  excellent: 'bg-[var(--green)]',
  good: 'bg-[var(--green)]',
  fair: 'bg-[var(--yellow)]',
  degrading: 'bg-[var(--amber)]',
  unstable: 'bg-[var(--red)]',
}

export const SCORE_TEXT_CLASS = {
  excellent: 'text-[var(--green)]',
  good: 'text-[var(--green)]',
  fair: 'text-[var(--yellow)]',
  degrading: 'text-[var(--amber)]',
  unstable: 'text-[var(--red)]',
}

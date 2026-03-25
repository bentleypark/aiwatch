export const VALID_THEMES = ['dark', 'light', 'system']

export const THEME_STORAGE_KEY = 'aiwatch-theme'

export const LANG_STORAGE_KEY = 'aiwatch-lang'

export const VALID_LANGS = ['ko', 'en']

export const SETTINGS_STORAGE_KEY = 'aiwatch-settings'

export const VALID_PERIODS = ['7d', '30d', '90d']

// API services (latency tracked)
export const API_SERVICE_IDS = [
  'claude', 'openai', 'gemini', 'mistral', 'cohere', 'groq',
  'together', 'perplexity', 'huggingface', 'replicate',
  'elevenlabs', 'xai', 'deepseek', 'openrouter', 'bedrock', 'azureopenai',
  'pinecone', 'stability',
]

// AI web apps (no latency — web services, ordered before related API)
export const WEBAPP_SERVICE_IDS = ['claudeai', 'chatgpt', 'characterai']

// Coding agents
export const AGENT_SERVICE_IDS = ['claudecode', 'copilot', 'cursor', 'windsurf']

// Display order: webapp → LLM → inference → agent
export const SERVICE_AND_WEBAPP_IDS = [
  // webapp
  'claudeai', 'chatgpt', 'characterai',
  // LLM API
  'claude', 'openai', 'gemini', 'bedrock', 'azureopenai', 'mistral', 'cohere', 'groq',
  'together', 'perplexity', 'xai', 'deepseek', 'openrouter',
  // inference / infrastructure
  'huggingface', 'replicate', 'elevenlabs', 'pinecone', 'stability',
]

// All service IDs
export const ALL_SERVICE_IDS = [...SERVICE_AND_WEBAPP_IDS, ...AGENT_SERVICE_IDS]

// Sidebar category filters — splits Worker's 'api' into LLM vs Voice/Inference
export const SERVICE_CATEGORIES = {
  all:       { labelKey: 'filter.all',       ids: null }, // null = show all
  webapps:   { labelKey: 'filter.webapps',   ids: ['claudeai', 'chatgpt', 'characterai'] },
  llm:       { labelKey: 'filter.llm',       ids: ['claude', 'openai', 'gemini', 'bedrock', 'azureopenai', 'mistral', 'cohere', 'groq', 'together', 'perplexity', 'xai', 'deepseek', 'openrouter'] },
  inference: { labelKey: 'filter.inference', ids: ['huggingface', 'replicate', 'elevenlabs', 'pinecone', 'stability'] },
  agents:    { labelKey: 'filter.agents',    ids: ['claudecode', 'copilot', 'cursor', 'windsurf'] },
}

// Services excluded from fallback recommendations (not interchangeable with LLM APIs)
// Keep in sync with worker/src/fallback.ts EXCLUDE_FALLBACK
export const EXCLUDE_FALLBACK = ['elevenlabs', 'replicate', 'huggingface', 'pinecone', 'stability', 'characterai']

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

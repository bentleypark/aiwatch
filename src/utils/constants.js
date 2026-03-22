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
  'elevenlabs', 'xai', 'deepseek',
]

// AI web apps (no latency — web services, ordered before related API)
export const WEBAPP_SERVICE_IDS = ['claudeai', 'chatgpt']

// Coding agents
export const AGENT_SERVICE_IDS = ['claudecode', 'copilot', 'cursor', 'windsurf']

// Services + WebApps interleaved by design v2 order (webapp before related API)
export const SERVICE_AND_WEBAPP_IDS = [
  'claudeai', 'claude', 'openai', 'chatgpt', 'gemini', 'mistral', 'cohere', 'groq',
  'together', 'perplexity', 'huggingface', 'replicate', 'elevenlabs', 'xai', 'deepseek',
]

// All service IDs
export const ALL_SERVICE_IDS = [...SERVICE_AND_WEBAPP_IDS, ...AGENT_SERVICE_IDS]

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

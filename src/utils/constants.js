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

// AI web apps (no latency — web services)
export const WEBAPP_SERVICE_IDS = ['claudeai', 'chatgpt']

// Coding agents
export const AGENT_SERVICE_IDS = ['claudecode', 'copilot', 'cursor', 'windsurf']

// All service IDs (used by Settings toggles, etc.)
export const ALL_SERVICE_IDS = [...API_SERVICE_IDS, ...WEBAPP_SERVICE_IDS, ...AGENT_SERVICE_IDS]

export const DEFAULT_SETTINGS = {
  period: '7d',
  sla: 99.9,
  enabledServices: ALL_SERVICE_IDS,
}

export const VALID_THEMES = ['dark', 'light', 'system']

export const THEME_STORAGE_KEY = 'aiwatch-theme'

export const LANG_STORAGE_KEY = 'aiwatch-lang'

export const VALID_LANGS = ['ko', 'en']

export const SETTINGS_STORAGE_KEY = 'aiwatch-settings'

export const VALID_PERIODS = ['7d', '30d', '90d']

export const ALL_SERVICE_IDS = [
  'claude', 'openai', 'gemini', 'mistral', 'cohere', 'groq',
  'together', 'perplexity', 'huggingface', 'replicate',
  'elevenlabs', 'xai', 'deepseek',
]

export const DEFAULT_SETTINGS = {
  period: '7d',
  sla: 99.9,
  enabledServices: ALL_SERVICE_IDS,
}

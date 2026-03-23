// URL slug ↔ Worker service ID mapping
// Phase A: top 5 services. Phase B: add remaining entries.

export const SLUG_TO_SERVICE: Record<string, { id: string; name: string; provider: string; category: string }> = {
  // Phase A
  'claude':          { id: 'claude',    name: 'Claude API',       provider: 'Anthropic',   category: 'api' },
  'chatgpt':         { id: 'chatgpt',   name: 'ChatGPT',          provider: 'OpenAI',      category: 'webapp' },
  'gemini':          { id: 'gemini',    name: 'Gemini API',       provider: 'Google',      category: 'api' },
  'github-copilot':  { id: 'copilot',   name: 'GitHub Copilot',   provider: 'Microsoft',   category: 'agent' },
  'cursor':          { id: 'cursor',    name: 'Cursor',           provider: 'Anysphere',   category: 'agent' },
}

// Reverse lookup: service ID → URL slug (for internal linking)
export const SERVICE_ID_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(SLUG_TO_SERVICE).map(([slug, entry]) => [entry.id, slug])
)

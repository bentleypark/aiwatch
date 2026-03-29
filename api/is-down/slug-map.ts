// URL slug ↔ Worker service ID mapping
// Phase A: top 5 services. Phase B: add remaining entries.

export const SLUG_TO_SERVICE: Record<string, { id: string; name: string; provider: string; category: string }> = {
  // Phase A
  'claude':          { id: 'claude',    name: 'Claude API',       provider: 'Anthropic',   category: 'api' },
  'chatgpt':         { id: 'chatgpt',   name: 'ChatGPT',          provider: 'OpenAI',      category: 'app' },
  'gemini':          { id: 'gemini',    name: 'Gemini API',       provider: 'Google',      category: 'api' },
  'github-copilot':  { id: 'copilot',   name: 'GitHub Copilot',   provider: 'Microsoft',   category: 'agent' },
  'cursor':          { id: 'cursor',    name: 'Cursor',           provider: 'Anysphere',   category: 'agent' },
  'claude-code':     { id: 'claudecode', name: 'Claude Code',     provider: 'Anthropic',   category: 'agent' },
  'openai':          { id: 'openai',    name: 'OpenAI API',      provider: 'OpenAI',      category: 'api' },
  'windsurf':        { id: 'windsurf',  name: 'Windsurf',        provider: 'Codeium',     category: 'agent' },
  'claude-ai':       { id: 'claudeai',  name: 'claude.ai',       provider: 'Anthropic',   category: 'app' },
}

// Related services for cross-linking (SEO internal links)
export const RELATED_SLUGS: Record<string, string[]> = {
  'claude':         ['claude-ai', 'claude-code', 'openai', 'chatgpt'],
  'claude-ai':      ['claude', 'chatgpt', 'claude-code'],
  'claude-code':    ['claude', 'claude-ai', 'cursor', 'github-copilot', 'windsurf'],
  'chatgpt':        ['claude-ai', 'openai', 'claude', 'gemini'],
  'openai':         ['chatgpt', 'claude', 'gemini'],
  'gemini':         ['openai', 'claude', 'chatgpt'],
  'github-copilot': ['cursor', 'windsurf', 'claude-code'],
  'cursor':         ['windsurf', 'github-copilot', 'claude-code'],
  'windsurf':       ['cursor', 'github-copilot', 'claude-code'],
}

// Reverse lookup: service ID → URL slug (for internal linking)
export const SERVICE_ID_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(SLUG_TO_SERVICE).map(([slug, entry]) => [entry.id, slug])
)

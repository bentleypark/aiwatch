// URL slug ↔ Worker service ID mapping
// Bedrock + Azure OpenAI excluded — estimate-only sources with no differentiated data (#263).

export const SLUG_TO_SERVICE: Record<string, { id: string; name: string; provider: string; category: string }> = {
  // Phase A — top services
  'claude':          { id: 'claude',     name: 'Claude API',       provider: 'Anthropic',   category: 'api' },
  'chatgpt':         { id: 'chatgpt',    name: 'ChatGPT',          provider: 'OpenAI',      category: 'app' },
  'gemini':          { id: 'gemini',     name: 'Gemini API',       provider: 'Google',      category: 'api' },
  'github-copilot':  { id: 'copilot',    name: 'GitHub Copilot',   provider: 'Microsoft',   category: 'agent' },
  'cursor':          { id: 'cursor',     name: 'Cursor',           provider: 'Anysphere',   category: 'agent' },
  'claude-code':     { id: 'claudecode', name: 'Claude Code',      provider: 'Anthropic',   category: 'agent' },
  'openai':          { id: 'openai',     name: 'OpenAI API',       provider: 'OpenAI',      category: 'api' },
  'windsurf':        { id: 'windsurf',   name: 'Windsurf',         provider: 'Codeium',     category: 'agent' },
  'claude-ai':       { id: 'claudeai',   name: 'claude.ai',        provider: 'Anthropic',   category: 'app' },
  // Phase B — LLM APIs (#263)
  'mistral':         { id: 'mistral',    name: 'Mistral API',      provider: 'Mistral AI',  category: 'api' },
  'cohere':          { id: 'cohere',     name: 'Cohere API',       provider: 'Cohere',      category: 'api' },
  'groq':            { id: 'groq',       name: 'Groq Cloud',       provider: 'Groq',        category: 'api' },
  'together':        { id: 'together',   name: 'Together AI',      provider: 'Together',    category: 'api' },
  'fireworks':       { id: 'fireworks',  name: 'Fireworks AI',     provider: 'Fireworks',   category: 'api' },
  'perplexity':      { id: 'perplexity', name: 'Perplexity',       provider: 'Perplexity AI', category: 'api' },
  'xai':             { id: 'xai',        name: 'xAI (Grok)',       provider: 'xAI',         category: 'api' },
  'deepseek':        { id: 'deepseek',   name: 'DeepSeek API',     provider: 'DeepSeek',    category: 'api' },
  'openrouter':      { id: 'openrouter', name: 'OpenRouter',       provider: 'OpenRouter',  category: 'api' },
  // Voice & speech AI (#263)
  'elevenlabs':      { id: 'elevenlabs', name: 'ElevenLabs',       provider: 'ElevenLabs',  category: 'api' },
  'assemblyai':      { id: 'assemblyai', name: 'AssemblyAI',       provider: 'AssemblyAI',  category: 'api' },
  'deepgram':        { id: 'deepgram',   name: 'Deepgram',         provider: 'Deepgram',    category: 'api' },
  // Inference / infrastructure (#263)
  'huggingface':     { id: 'huggingface', name: 'Hugging Face',    provider: 'Hugging Face', category: 'api' },
  'replicate':       { id: 'replicate',  name: 'Replicate',        provider: 'Replicate',   category: 'api' },
  'pinecone':        { id: 'pinecone',   name: 'Pinecone',         provider: 'Pinecone',    category: 'api' },
  'stability':       { id: 'stability',  name: 'Stability AI',     provider: 'Stability AI', category: 'api' },
  'voyageai':        { id: 'voyageai',   name: 'Voyage AI',        provider: 'Voyage AI',   category: 'api' },
  'modal':           { id: 'modal',      name: 'Modal',            provider: 'Modal',       category: 'api' },
  // AI apps (#263)
  'character-ai':    { id: 'characterai', name: 'Character.AI',    provider: 'Character.AI', category: 'app' },
}

// Related services for cross-linking (SEO internal links)
export const RELATED_SLUGS: Record<string, string[]> = {
  // Phase A
  'claude':         ['claude-ai', 'claude-code', 'openai', 'chatgpt'],
  'claude-ai':      ['claude', 'chatgpt', 'claude-code'],
  'claude-code':    ['claude', 'claude-ai', 'cursor', 'github-copilot', 'windsurf'],
  'chatgpt':        ['claude-ai', 'openai', 'claude', 'gemini'],
  'openai':         ['chatgpt', 'claude', 'gemini', 'mistral', 'cohere'],
  'gemini':         ['openai', 'claude', 'chatgpt'],
  'github-copilot': ['cursor', 'windsurf', 'claude-code'],
  'cursor':         ['windsurf', 'github-copilot', 'claude-code'],
  'windsurf':       ['cursor', 'github-copilot', 'claude-code'],
  // LLM APIs — same-tier alternatives
  'mistral':        ['cohere', 'groq', 'together', 'openai', 'claude'],
  'cohere':         ['mistral', 'groq', 'together', 'openai'],
  'groq':           ['together', 'fireworks', 'mistral', 'cohere'],
  'together':       ['fireworks', 'groq', 'mistral'],
  'fireworks':      ['together', 'groq', 'mistral'],
  'perplexity':     ['openai', 'claude', 'gemini'],
  'xai':            ['openai', 'claude', 'gemini'],
  'deepseek':       ['mistral', 'groq', 'openai', 'claude'],
  'openrouter':     ['openai', 'claude', 'mistral'],
  // Voice — same category
  'elevenlabs':     ['assemblyai', 'deepgram'],
  'assemblyai':     ['deepgram', 'elevenlabs'],
  'deepgram':       ['assemblyai', 'elevenlabs'],
  // Inference / vector / image
  'huggingface':    ['replicate', 'modal', 'together'],
  'replicate':      ['huggingface', 'stability', 'modal'],
  'pinecone':       ['voyageai'],
  'stability':      ['replicate', 'huggingface'],
  'voyageai':       ['pinecone', 'cohere'],
  'modal':          ['replicate', 'huggingface'],
  // Apps
  'character-ai':   ['chatgpt', 'claude-ai', 'gemini'],
}

// Reverse lookup: service ID → URL slug (for internal linking)
export const SERVICE_ID_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(SLUG_TO_SERVICE).map(([slug, entry]) => [entry.id, slug])
)

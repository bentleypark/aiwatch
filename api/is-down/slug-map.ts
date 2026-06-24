// URL slug ↔ Worker service ID mapping
// Bedrock + Azure OpenAI excluded — estimate-only sources with no differentiated data (#263).
//
// `category` is the COARSE 3-way (api/app/agent) mirroring worker ServiceStatus.category — the
// is-down fallback filter (api/is-down.ts) matches it against the worker's value, so it must stay
// in that vocabulary. `group` is the FINE 6-way display taxonomy (#658) mirroring the dashboard
// SERVICE_CATEGORIES (apps/llm/voice/inference/video/agents); it drives only the footer "Also
// check" grouping (renderFooter / FOOTER_CATEGORY_ORDER).
export const SLUG_TO_SERVICE: Record<string, { id: string; name: string; provider: string; category: string; group: string }> = {
  // Phase A — top services
  'claude':          { id: 'claude',     name: 'Claude API',       provider: 'Anthropic',   category: 'api', group: 'llm' },
  'chatgpt':         { id: 'chatgpt',    name: 'ChatGPT',          provider: 'OpenAI',      category: 'app', group: 'apps' },
  'gemini':          { id: 'gemini',     name: 'Gemini API',       provider: 'Google',      category: 'api', group: 'llm' },
  'github-copilot':  { id: 'copilot',    name: 'GitHub Copilot',   provider: 'Microsoft',   category: 'agent', group: 'agents' },
  'cursor':          { id: 'cursor',     name: 'Cursor',           provider: 'Anysphere',   category: 'agent', group: 'agents' },
  'claude-code':     { id: 'claudecode', name: 'Claude Code',      provider: 'Anthropic',   category: 'agent', group: 'agents' },
  'openai':          { id: 'openai',     name: 'OpenAI API',       provider: 'OpenAI',      category: 'api', group: 'llm' },
  'windsurf':        { id: 'windsurf',   name: 'Windsurf',         provider: 'Codeium',     category: 'agent', group: 'agents' },
  'claude-ai':       { id: 'claudeai',   name: 'claude.ai',        provider: 'Anthropic',   category: 'app', group: 'apps' },
  // Phase B — LLM APIs (#263)
  'mistral':         { id: 'mistral',    name: 'Mistral API',      provider: 'Mistral AI',  category: 'api', group: 'llm' },
  'cohere':          { id: 'cohere',     name: 'Cohere API',       provider: 'Cohere',      category: 'api', group: 'llm' },
  'groq':            { id: 'groq',       name: 'Groq Cloud',       provider: 'Groq',        category: 'api', group: 'llm' },
  'together':        { id: 'together',   name: 'Together AI',      provider: 'Together',    category: 'api', group: 'llm' },
  'fireworks':       { id: 'fireworks',  name: 'Fireworks AI',     provider: 'Fireworks',   category: 'api', group: 'llm' },
  'cerebras':        { id: 'cerebras',   name: 'Cerebras Inference', provider: 'Cerebras',  category: 'api', group: 'llm' },
  'perplexity':      { id: 'perplexity', name: 'Perplexity',       provider: 'Perplexity AI', category: 'api', group: 'llm' },
  'xai':             { id: 'xai',        name: 'xAI (Grok)',       provider: 'xAI',         category: 'api', group: 'llm' },
  'deepseek':        { id: 'deepseek',   name: 'DeepSeek API',     provider: 'DeepSeek',    category: 'api', group: 'llm' },
  'openrouter':      { id: 'openrouter', name: 'OpenRouter',       provider: 'OpenRouter',  category: 'api', group: 'llm' },
  // Voice & speech AI (#263)
  'elevenlabs':      { id: 'elevenlabs', name: 'ElevenLabs',       provider: 'ElevenLabs',  category: 'api', group: 'voice' },
  'assemblyai':      { id: 'assemblyai', name: 'AssemblyAI',       provider: 'AssemblyAI',  category: 'api', group: 'voice' },
  'deepgram':        { id: 'deepgram',   name: 'Deepgram',         provider: 'Deepgram',    category: 'api', group: 'voice' },
  // Inference / infrastructure (#263)
  'huggingface':     { id: 'huggingface', name: 'Hugging Face',    provider: 'Hugging Face', category: 'api', group: 'inference' },
  'replicate':       { id: 'replicate',  name: 'Replicate',        provider: 'Replicate',   category: 'api', group: 'inference' },
  'pinecone':        { id: 'pinecone',   name: 'Pinecone',         provider: 'Pinecone',    category: 'api', group: 'inference' },
  'stability':       { id: 'stability',  name: 'Stability AI',     provider: 'Stability AI', category: 'api', group: 'image' }, // #756 — image category (split from inference)
  // Black Forest Labs / FLUX (#756) — slug is 'flux' (search volume) while the worker id is 'bfl';
  // the id≠slug mapping is mirrored in worker/src/rss.ts IS_DOWN_SLUG_OVERRIDE and
  // src/utils/constants.js FEED_SLUG_OVERRIDE, pinned by feed-slug-sync.test.ts / feed-slug.test.js.
  'flux':            { id: 'bfl',        name: 'Black Forest Labs (FLUX)', provider: 'Black Forest Labs', category: 'api', group: 'image' },
  'voyageai':        { id: 'voyageai',   name: 'Voyage AI',        provider: 'Voyage AI',   category: 'api', group: 'inference' },
  'modal':           { id: 'modal',      name: 'Modal',            provider: 'Modal',       category: 'api', group: 'inference' },
  // LangChain (LangSmith) (#561) — slug is 'langchain' (search volume) while the worker id is
  // 'langsmith'; the id≠slug mapping is mirrored in worker/src/rss.ts IS_DOWN_SLUG_OVERRIDE and
  // src/utils/constants.js FEED_SLUG_OVERRIDE, pinned by feed-slug-sync.test.ts / feed-slug.test.js.
  'langchain':       { id: 'langsmith',  name: 'LangChain (LangSmith)', provider: 'LangChain', category: 'api', group: 'observability' },
  // #601 — LLM observability siblings
  'helicone':        { id: 'helicone',   name: 'Helicone',         provider: 'Helicone',    category: 'api', group: 'observability' },
  'langfuse':        { id: 'langfuse',   name: 'Langfuse',         provider: 'Langfuse',    category: 'api', group: 'observability' },
  // Runway (#393) — generative-video AI; slug == worker id ('runway'), no override needed.
  'runway':          { id: 'runway',     name: 'Runway',           provider: 'Runway',      category: 'api', group: 'video' },
  // Luma / Dream Machine (#602) — generative-video AI; slug == worker id ('luma'), no override needed.
  'luma':            { id: 'luma',       name: 'Luma (Dream Machine)', provider: 'Luma',     category: 'api', group: 'video' },
  // AI apps (#263)
  'character-ai':    { id: 'characterai', name: 'Character.AI',    provider: 'Character.AI', category: 'app', group: 'apps' },
  // DeepSeek App (#619) — DeepSeek's consumer chat app (chat.deepseek.com), distinct from the
  // 'deepseek' (DeepSeek API) page. Slug 'deepseek-app' ≠ worker id 'deepseekapp'; the id≠slug
  // mapping is mirrored in worker/src/rss.ts IS_DOWN_SLUG_OVERRIDE + src/utils/constants.js
  // FEED_SLUG_OVERRIDE, pinned by feed-slug-sync.test.ts / feed-slug.test.js.
  'deepseek-app':    { id: 'deepseekapp', name: 'DeepSeek App',    provider: 'DeepSeek',     category: 'app', group: 'apps' },
  // Coding agents (#294) — OpenAI Codex is the current coding-agent product,
  // distinct from the deprecated 2023 Codex code-generation API.
  'codex':           { id: 'codex',       name: 'Codex',           provider: 'OpenAI',      category: 'agent', group: 'agents' },
  // Junie (#336) — JetBrains coding agent. Status page is shared with sibling
  // JetBrains AI products (Grazie, AI Platform, AI Platform China); the worker
  // scopes the badge to the Junie component only via statusComponentId.
  'junie':           { id: 'junie',       name: 'Junie',           provider: 'JetBrains',   category: 'agent', group: 'agents' },
}

// Related services for cross-linking (SEO internal links)
export const RELATED_SLUGS: Record<string, string[]> = {
  // Phase A
  'claude':         ['claude-ai', 'claude-code', 'openai', 'chatgpt'],
  'claude-ai':      ['claude', 'chatgpt', 'claude-code'],
  'claude-code':    ['claude', 'cursor', 'github-copilot', 'windsurf', 'codex', 'junie'],
  'chatgpt':        ['claude-ai', 'openai', 'claude', 'gemini'],
  'openai':         ['chatgpt', 'claude', 'gemini', 'mistral', 'cohere'],
  'gemini':         ['openai', 'claude', 'chatgpt'],
  'github-copilot': ['cursor', 'windsurf', 'claude-code', 'codex', 'junie'],
  'cursor':         ['windsurf', 'github-copilot', 'claude-code', 'codex', 'junie'],
  'windsurf':       ['cursor', 'github-copilot', 'claude-code', 'codex', 'junie'],
  'codex':          ['github-copilot', 'cursor', 'windsurf', 'claude-code', 'junie'],
  'junie':          ['cursor', 'github-copilot', 'claude-code', 'codex', 'windsurf'],
  // LLM APIs — same-tier alternatives
  'mistral':        ['cohere', 'groq', 'together', 'openai', 'claude'],
  'cohere':         ['mistral', 'groq', 'together', 'openai'],
  'groq':           ['together', 'fireworks', 'cerebras', 'mistral'],
  'together':       ['fireworks', 'groq', 'cerebras'],
  'fireworks':      ['together', 'groq', 'cerebras'],
  'cerebras':       ['groq', 'together', 'fireworks', 'mistral'],
  'perplexity':     ['openai', 'claude', 'gemini'],
  'xai':            ['openai', 'claude', 'gemini'],
  'deepseek':       ['deepseek-app', 'mistral', 'groq', 'openai'],
  'openrouter':     ['openai', 'claude', 'mistral'],
  // Voice — same category
  'elevenlabs':     ['assemblyai', 'deepgram'],
  'assemblyai':     ['deepgram', 'elevenlabs'],
  'deepgram':       ['assemblyai', 'elevenlabs'],
  // Inference / vector / image
  'huggingface':    ['replicate', 'modal', 'together'],
  'replicate':      ['huggingface', 'stability', 'modal'],
  'pinecone':       ['voyageai'],
  'stability':      ['flux', 'replicate', 'huggingface'], // #756 — image sibling first
  'flux':           ['stability', 'replicate', 'huggingface'], // #756
  'voyageai':       ['pinecone', 'cohere'],
  'modal':          ['replicate', 'huggingface'],
  'langchain':      ['helicone', 'langfuse'],
  'helicone':       ['langchain', 'langfuse'],
  'langfuse':       ['langchain', 'helicone'],
  'runway':         ['replicate', 'stability', 'huggingface'],
  'luma':           ['runway', 'replicate', 'stability'],
  // Apps
  'character-ai':   ['chatgpt', 'claude-ai', 'gemini'],
  'deepseek-app':   ['deepseek', 'chatgpt', 'claude-ai', 'character-ai'],
}

// Reverse lookup: service ID → URL slug (for internal linking)
export const SERVICE_ID_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(SLUG_TO_SERVICE).map(([slug, entry]) => [entry.id, slug])
)

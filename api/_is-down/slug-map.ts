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
  // #1164 — 'claude'/'openai' used to be these single-service slugs; both URLs were repurposed as
  // provider-family group pages (api/is-down-group.ts), so the single-service content moved to
  // '-api' slugs. `id`/`name` are UNCHANGED — only the URL slug (this map's key) moved.
  'claude-api':      { id: 'claude',     name: 'Claude API',       provider: 'Anthropic',   category: 'api', group: 'llm' },
  'chatgpt':         { id: 'chatgpt',    name: 'ChatGPT',          provider: 'OpenAI',      category: 'app', group: 'apps' },
  'gemini':          { id: 'gemini',     name: 'Gemini API',       provider: 'Google',      category: 'api', group: 'llm' },
  'github-copilot':  { id: 'copilot',    name: 'GitHub Copilot',   provider: 'Microsoft',   category: 'agent', group: 'agents' },
  'cursor':          { id: 'cursor',     name: 'Cursor',           provider: 'Anysphere',   category: 'agent', group: 'agents' },
  'claude-code':     { id: 'claudecode', name: 'Claude Code',      provider: 'Anthropic',   category: 'agent', group: 'agents' },
  'openai-api':      { id: 'openai',     name: 'OpenAI API',       provider: 'OpenAI',      category: 'api', group: 'llm' },
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
  // #1165 — 'xai' moved to 'xai-api': /is-xai-down is now the xAI/Grok family group page (same
  // repurposing #1164 did for claude/openai), now that Grok's consumer app (iOS/Android/Web) is its
  // own monitored service. `id`/`name` UPDATED (was 'xAI (Grok)') — "(Grok)" is now misleading on the
  // API-only page since Grok also names the separate app; the combined label moved to FAMILY_GROUPS.xai.
  'xai-api':         { id: 'xai',        name: 'xAI API',          provider: 'xAI',         category: 'api', group: 'llm' },
  'deepseek':        { id: 'deepseek',   name: 'DeepSeek API',     provider: 'DeepSeek',    category: 'api', group: 'llm' },
  'kimi':            { id: 'kimi',       name: 'Kimi (Moonshot AI)', provider: 'Moonshot AI', category: 'api', group: 'llm' },
  'openrouter':      { id: 'openrouter', name: 'OpenRouter',       provider: 'OpenRouter',  category: 'api', group: 'llm' },
  // Voice & speech AI (#263)
  'elevenlabs':      { id: 'elevenlabs', name: 'ElevenLabs',       provider: 'ElevenLabs',  category: 'api', group: 'voice' },
  'assemblyai':      { id: 'assemblyai', name: 'AssemblyAI',       provider: 'AssemblyAI',  category: 'api', group: 'voice' },
  'deepgram':        { id: 'deepgram',   name: 'Deepgram',         provider: 'Deepgram',    category: 'api', group: 'voice' },
  // Inference / infrastructure (#263)
  'huggingface':     { id: 'huggingface', name: 'Hugging Face',    provider: 'Hugging Face', category: 'api', group: 'inference' },
  'replicate':       { id: 'replicate',  name: 'Replicate',        provider: 'Replicate',   category: 'api', group: 'inference' },
  // fal.ai (#758) — generative-media inference platform (image/video/audio/3D). Slug == worker id ('fal').
  'fal':             { id: 'fal',        name: 'fal.ai',           provider: 'fal',         category: 'api', group: 'inference' },
  'pinecone':        { id: 'pinecone',   name: 'Pinecone',         provider: 'Pinecone',    category: 'api', group: 'inference' },
  // turbopuffer (#857) — serverless vector-search DB; the Vector fallback sibling for Pinecone. Slug == worker id.
  'turbopuffer':     { id: 'turbopuffer', name: 'turbopuffer',      provider: 'turbopuffer', category: 'api', group: 'inference' },
  'stability':       { id: 'stability',  name: 'Stability AI',     provider: 'Stability AI', category: 'api', group: 'image' }, // #756 — image category (split from inference)
  // Black Forest Labs / FLUX (#756) — slug is 'flux' (search volume) while the worker id is 'bfl';
  // the id≠slug mapping is mirrored in worker/src/rss.ts IS_DOWN_SLUG_OVERRIDE and
  // src/utils/constants.js FEED_SLUG_OVERRIDE, pinned by feed-slug-sync.test.ts / feed-slug.test.js.
  'flux':            { id: 'bfl',        name: 'Black Forest Labs (FLUX)', provider: 'Black Forest Labs', category: 'api', group: 'image' },
  'voyageai':        { id: 'voyageai',   name: 'Voyage AI',        provider: 'Voyage AI',   category: 'api', group: 'inference' },
  'modal':           { id: 'modal',      name: 'Modal',            provider: 'Modal',       category: 'api', group: 'inference' },
  // Twelve Labs (#839) — video-understanding API (search/embed/analyze), not video generation. Slug == worker id.
  'twelvelabs':      { id: 'twelvelabs', name: 'Twelve Labs',      provider: 'Twelve Labs', category: 'api', group: 'inference' },
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
  // Grok (#1165) — xAI's consumer app (iOS/Android/Web), the api-vs-app split mirror of DeepSeek
  // API↔DeepSeek App above. Slug == worker id ('grok'), no override needed.
  'grok':            { id: 'grok',        name: 'Grok',            provider: 'xAI',          category: 'app', group: 'apps' },
  // Coding agents (#294) — OpenAI Codex is the current coding-agent product,
  // distinct from the deprecated 2023 Codex code-generation API.
  'codex':           { id: 'codex',       name: 'Codex',           provider: 'OpenAI',      category: 'agent', group: 'agents' },
  // Junie (#336) — JetBrains coding agent. Status page is shared with sibling
  // JetBrains AI products (Grazie, AI Platform, AI Platform China); the worker
  // scopes the badge to the Junie component only via statusComponentId.
  'junie':           { id: 'junie',       name: 'Junie',           provider: 'JetBrains',   category: 'agent', group: 'agents' },
}

// Related services for cross-linking (SEO internal links)
// #1164 — every 'claude'/'openai' reference below points at the specific API product
// ('claude-api'/'openai-api'), not the provider-family group page — an "Alternatives" link should
// land on the product being recommended, not a status aggregation page.
export const RELATED_SLUGS: Record<string, string[]> = {
  // Phase A
  'claude-api':     ['claude-ai', 'claude-code', 'openai-api', 'chatgpt'],
  'claude-ai':      ['claude-api', 'chatgpt', 'claude-code'],
  'claude-code':    ['claude-api', 'cursor', 'github-copilot', 'windsurf', 'codex', 'junie'],
  'chatgpt':        ['claude-ai', 'openai-api', 'claude-api', 'gemini'],
  'openai-api':     ['chatgpt', 'claude-api', 'gemini', 'mistral', 'cohere'],
  'gemini':         ['openai-api', 'claude-api', 'chatgpt'],
  'github-copilot': ['cursor', 'windsurf', 'claude-code', 'codex', 'junie'],
  'cursor':         ['windsurf', 'github-copilot', 'claude-code', 'codex', 'junie'],
  'windsurf':       ['cursor', 'github-copilot', 'claude-code', 'codex', 'junie'],
  'codex':          ['github-copilot', 'cursor', 'windsurf', 'claude-code', 'junie'],
  'junie':          ['cursor', 'github-copilot', 'claude-code', 'codex', 'windsurf'],
  // LLM APIs — same-tier alternatives
  'mistral':        ['cohere', 'groq', 'together', 'openai-api', 'claude-api'],
  'cohere':         ['mistral', 'groq', 'together', 'openai-api'],
  'groq':           ['together', 'fireworks', 'cerebras', 'mistral'],
  'together':       ['fireworks', 'groq', 'cerebras'],
  'fireworks':      ['together', 'groq', 'cerebras'],
  'cerebras':       ['groq', 'together', 'fireworks', 'mistral'],
  'perplexity':     ['openai-api', 'claude-api', 'gemini'],
  'xai-api':        ['openai-api', 'claude-api', 'gemini'],
  'deepseek':       ['deepseek-app', 'mistral', 'groq', 'openai-api'],
  'kimi':           ['deepseek', 'mistral', 'openai-api', 'claude-api'],
  'openrouter':     ['openai-api', 'claude-api', 'mistral'],
  // Voice — same category
  'elevenlabs':     ['assemblyai', 'deepgram'],
  'assemblyai':     ['deepgram', 'elevenlabs'],
  'deepgram':       ['assemblyai', 'elevenlabs'],
  // Inference / vector / image
  'huggingface':    ['replicate', 'fal', 'modal', 'together'],
  'replicate':      ['huggingface', 'fal', 'stability', 'modal'],
  'fal':            ['replicate', 'huggingface', 'modal'], // #758 — generative-media inference siblings
  'pinecone':       ['turbopuffer', 'voyageai'], // #857 — vector sibling first
  'turbopuffer':    ['pinecone', 'voyageai'], // #857
  'stability':      ['flux', 'replicate', 'huggingface'], // #756 — image sibling first
  'flux':           ['stability', 'replicate', 'huggingface'], // #756
  'voyageai':       ['pinecone', 'cohere'],
  'modal':          ['replicate', 'huggingface'],
  'twelvelabs':     ['replicate', 'huggingface', 'runway', 'luma'],
  'langchain':      ['helicone', 'langfuse'],
  'helicone':       ['langchain', 'langfuse'],
  'langfuse':       ['langchain', 'helicone'],
  'runway':         ['replicate', 'stability', 'huggingface'],
  'luma':           ['runway', 'replicate', 'stability'],
  // Apps
  'character-ai':   ['chatgpt', 'claude-ai', 'gemini'],
  'deepseek-app':   ['deepseek', 'chatgpt', 'claude-ai', 'character-ai'],
  'grok':           ['chatgpt', 'claude-ai', 'deepseek-app', 'character-ai'],
}

// Reverse lookup: service ID → URL slug (for internal linking)
export const SERVICE_ID_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(SLUG_TO_SERVICE).map(([slug, entry]) => [entry.id, slug])
)

// #1164 — provider-family group pages (api/is-down-group.ts), living at the URL slots the
// single-service pages used to occupy (`/is-claude-down`, `/is-openai-down`) — someone searching the
// bare product name is more likely asking about the product broadly than one specific surface.
// `members` are worker service ids (NOT slugs); the group page worst-of's their live status and
// links out to each member's own (now `-api`-suffixed, for the API member) is-down page.
export interface ServiceFamily {
  slug: string
  name: string
  members: string[]
}

export const FAMILY_GROUPS: Record<string, ServiceFamily> = {
  claude: { slug: 'claude', name: 'Anthropic (Claude)', members: ['claude', 'claudeai', 'claudecode'] },
  openai: { slug: 'openai', name: 'OpenAI', members: ['openai', 'chatgpt', 'codex'] },
  // #1165 — xAI API + Grok consumer app (iOS/Android/Web), same reasoning as the original two
  // families ("is xai down" / "is grok down" both plausibly mean either surface).
  // Cursor added per explicit product decision after SpaceX's June 2026 agreement to acquire
  // Anysphere (Cursor's parent) — mirrors claude/openai already grouping their coding-agent surface
  // (claudecode/codex) under the parent provider's family. NOTE: the SpaceX↔Anysphere deal had not
  // closed as of this writing (agreed 2026-06-16, expected close Q3 2026, subject to regulatory
  // approval) — Cursor's own infra (status.cursor.com) stays fully independent of status.x.ai
  // regardless; `provider` below is intentionally left as 'Anysphere' (slug-map line ~18) since that
  // remains factually accurate even after this grouping change.
  xai: { slug: 'xai', name: 'xAI (Grok, Cursor)', members: ['xai', 'grok', 'cursor'] },
}

// #842 — outbound referral wedge. Product/homepage URL per service that can be RECOMMENDED as a
// fallback on the is-down page, so an outage-moment visitor can ACT on the (Score-ranked, UNPAID)
// recommendation — and AIWatch can measure "we sent N users to alternatives at the failover moment"
// (the Rung-1 sponsor evidence, #637/#842). Curated high-confidence set; a missing id → no outbound
// affordance (graceful). NOT an endorsement or paid placement — the link is disclosed + `rel="nofollow"`
// (unpaid editorial; `sponsored` would falsely mark it paid) and rankings stay Score-only. Kept
// byte-identical to the SPA mirror in src/utils/constants.js (pinned by service-site-url-sync test).
// EXCLUDE_FALLBACK services (replicate/huggingface/fal/pinecone/voyageai/modal/characterai/bedrock/
// azureopenai) are intentionally absent — they never appear as a fallback candidate.
export const SERVICE_SITE_URL: Record<string, string> = {
  // LLM APIs
  claude: 'https://claude.com', openai: 'https://platform.openai.com', gemini: 'https://ai.google.dev',
  mistral: 'https://mistral.ai', cohere: 'https://cohere.com', groq: 'https://groq.com',
  together: 'https://together.ai', fireworks: 'https://fireworks.ai', cerebras: 'https://cerebras.ai',
  deepseek: 'https://www.deepseek.com', kimi: 'https://www.moonshot.ai', xai: 'https://x.ai', perplexity: 'https://www.perplexity.ai',
  openrouter: 'https://openrouter.ai',
  // Voice & speech (#842 category extension)
  elevenlabs: 'https://elevenlabs.io', assemblyai: 'https://www.assemblyai.com', deepgram: 'https://deepgram.com',
  // Vector DB (#857) — pinecone + turbopuffer are now fallback candidates (Tier 8), so the "Open ↗"
  // referral wedge needs their product URLs (without these the actual relevant vector sibling had no button).
  pinecone: 'https://www.pinecone.io', turbopuffer: 'https://turbopuffer.com',
  // Image
  // #1119 — the image tier is now reachable from an APP-category outage (a ChatGPT image-generation
  // outage recommends these), so the "Open ↗" target has to be a surface a non-developer can actually
  // use. `stability.ai/brandstudio` is the page for Brand Studio, Stability's consumer image product —
  // chosen over the corporate root for actionability, and over the product's own host
  // (`brandstudio.com`, where `dreamstudio.ai` 301s as of 2026-07-22) so the link stays on the brand
  // the card names. Remote-page observations, dated: no test here can re-verify the destination.
  // This matches how the rest of this map already behaves (`luma` → dream-machine, `langsmith` → the
  // product page), not a new convention.
  // `bfl` deliberately stays on the root: `playground.bfl.ai` redirects to `auth.bfl.ai` (a sign-in
  // wall — Google/GitHub/SSO/email, "Sign up") before any generation, confirmed in a real browser
  // 2026-07-23. So unlike Stability's Brand Studio (free-credit self-serve entry), BFL has no no-signup
  // surface to point a panicking outage-moment user at — the root is the least-bad target. This
  // asymmetry is deliberate, not a TODO.
  stability: 'https://stability.ai/brandstudio', bfl: 'https://bfl.ai',
  // Video
  runway: 'https://runwayml.com', luma: 'https://lumalabs.ai/dream-machine',
  // Observability
  langsmith: 'https://www.langchain.com/langsmith', helicone: 'https://helicone.ai', langfuse: 'https://langfuse.com',
  // Coding agents
  cursor: 'https://cursor.com', copilot: 'https://github.com/features/copilot', windsurf: 'https://windsurf.com',
  junie: 'https://junie.jetbrains.com', claudecode: 'https://claude.com/product/claude-code', codex: 'https://developers.openai.com/codex',
  // Apps
  chatgpt: 'https://chatgpt.com', claudeai: 'https://claude.ai', deepseekapp: 'https://chat.deepseek.com', grok: 'https://grok.com',
}

/** Disclosed outbound referral URL for a recommended alternative (appends a `ref` param so the
 *  destination can attribute AIWatch). Returns null when no curated URL → caller omits the affordance. */
export function outboundReferralUrl(id: string): string | null {
  const base = SERVICE_SITE_URL[id]
  if (!base) return null
  return `${base}${base.includes('?') ? '&' : '?'}ref=ai-watch.dev`
}

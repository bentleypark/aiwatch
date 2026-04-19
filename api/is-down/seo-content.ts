// Per-service SEO content for "Is X Down?" pages

export interface ServiceSEO {
  displayName: string
  description: string
  insight: string
  whenDown: string
  faqs: Array<{ q: string; a: string }>
}

const SEO_CONTENT: Record<string, ServiceSEO> = {
  claude: {
    displayName: 'Claude',
    description: 'Claude is a large language model API developed by Anthropic. It powers applications ranging from chatbots to code generation tools, offering multiple model tiers for different performance and cost trade-offs.',
    insight: 'Unlike other providers, Anthropic reports incidents per model tier, resulting in higher incident counts compared to competitors. This does not necessarily indicate lower reliability — it reflects more granular reporting. When evaluating Claude API stability, focus on uptime percentage and recovery time rather than raw incident count.',
    whenDown: 'When Claude API is down, developers may experience API request failures, increased latency, or model unavailability. Applications built on the Claude API will be unable to generate responses.',
    faqs: [
      { q: 'Is Claude API down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Claude API every 5 minutes and shows real-time operational status, uptime percentage, and recent incidents.' },
      { q: 'How do I check Claude API status?', a: 'You can check Claude API status on this page (updated every 5 minutes), on the official Anthropic status page at status.anthropic.com, or on the AIWatch dashboard at ai-watch.dev.' },
      { q: 'What should I do when Claude API is down?', a: 'Consider switching to an alternative LLM API such as OpenAI or Gemini. AIWatch provides real-time fallback recommendations based on which services are currently operational and reliable.' },
      { q: 'How often does Claude API go down?', a: 'Claude API uptime and incident history are tracked on this page. Check the recent incidents section and 30-day uptime percentage for current reliability data.' },
    ],
  },
  chatgpt: {
    displayName: 'ChatGPT',
    description: 'ChatGPT is a conversational AI assistant by OpenAI, available on web, iOS, Android, and desktop. Used by millions for writing, research, coding, and creative tasks, it is powered by OpenAI\'s latest language models.',
    insight: 'ChatGPT and OpenAI API share infrastructure but are tracked separately by AIWatch. A ChatGPT outage does not always mean the API is down — and vice versa. OpenAI has historically maintained one of the highest uptime records among AI providers, with most incidents resolved within 30 minutes.',
    whenDown: 'When ChatGPT is down, users cannot access the web interface for conversations, file uploads, or image generation. Mobile apps and API integrations through the OpenAI platform may also be affected.',
    faqs: [
      { q: 'Is ChatGPT down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors ChatGPT every 5 minutes and shows real-time operational status, uptime percentage, and recent incidents.' },
      { q: 'Why is ChatGPT not working?', a: 'ChatGPT may be experiencing server issues, high traffic, or a planned maintenance. Check the recent incidents section on this page for details on any ongoing issues.' },
      { q: 'What are alternatives to ChatGPT?', a: 'When ChatGPT is down, you can use claude.ai by Anthropic or Google Gemini as alternatives. AIWatch shows which AI services are currently operational.' },
      { q: 'How long do ChatGPT outages usually last?', a: 'ChatGPT outage durations vary. Check the recent incidents section on this page for average resolution times and incident history.' },
    ],
  },
  gemini: {
    displayName: 'Gemini',
    description: 'Gemini is Google\'s multimodal AI model API, capable of processing text, images, audio, and video. It powers Google AI Studio and is available through the Vertex AI platform for enterprise applications.',
    insight: 'Google does not publish official uptime percentages for Gemini on their public status page, making independent monitoring especially valuable. AIWatch tracks Gemini through Google Cloud Status incidents. Gemini outages tend to be infrequent but can be longer in duration compared to other LLM providers.',
    whenDown: 'When Gemini API is down, applications using Google\'s AI models will fail to process requests. This affects both direct API users and services built on Google AI Studio or Vertex AI.',
    faqs: [
      { q: 'Is Gemini API down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Gemini API every 5 minutes using Google Cloud Status data.' },
      { q: 'How do I check Google Gemini status?', a: 'You can check Gemini status on this page, on Google Cloud Status at status.cloud.google.com, or on the AIWatch dashboard at ai-watch.dev.' },
      { q: 'What alternatives are there to Gemini?', a: 'When Gemini is down, consider Claude API by Anthropic or OpenAI API as alternatives. AIWatch provides real-time fallback recommendations.' },
      { q: 'Does Gemini downtime affect Google AI Studio?', a: 'Yes, Gemini API outages typically affect Google AI Studio and Vertex AI integrations as they rely on the same underlying infrastructure.' },
    ],
  },
  'github-copilot': {
    displayName: 'GitHub Copilot',
    description: 'GitHub Copilot is an AI-powered coding assistant by Microsoft that integrates with VS Code, JetBrains, and other IDEs. It provides real-time code suggestions, chat assistance, and automated pull request reviews.',
    insight: 'GitHub Copilot incidents often overlap with broader GitHub infrastructure issues (Git operations, Actions, Codespaces). AIWatch tracks Copilot-specific incidents separately, but when GitHub itself is degraded, Copilot is almost always affected. Copilot Coding Agent is a newer feature with its own distinct failure patterns.',
    whenDown: 'When GitHub Copilot is down, developers lose AI code completions and chat assistance in their IDE. Copilot Coding Agent sessions and automated reviews will also be unavailable.',
    faqs: [
      { q: 'Is GitHub Copilot down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors GitHub Copilot every 5 minutes using GitHub Status data.' },
      { q: 'Why is Copilot not suggesting code?', a: 'Copilot may be experiencing service issues. Check this page for current status. Also verify your subscription is active and your IDE extension is up to date.' },
      { q: 'What can I use instead of GitHub Copilot?', a: 'When Copilot is down, Cursor and Windsurf are alternative AI coding assistants. Claude Code by Anthropic is another option for terminal-based AI coding.' },
      { q: 'Does GitHub Copilot downtime affect GitHub?', a: 'Copilot outages may coincide with broader GitHub infrastructure issues. Check the incidents section for details on whether the outage is Copilot-specific or platform-wide.' },
    ],
  },
  cursor: {
    displayName: 'Cursor',
    description: 'Cursor is an AI-native code editor built on VS Code that integrates multiple LLM providers for intelligent code editing, chat, and codebase understanding.',
    insight: 'Cursor depends on upstream model providers (Claude, OpenAI), so outages can originate from either Cursor infrastructure or its AI backends. AIWatch monitors Cursor independently — when Cursor reports an issue, check the AIWatch dashboard to see if Claude or OpenAI is also down. Cursor has maintained strong uptime with most incidents attributed to upstream provider issues.',
    whenDown: 'When Cursor is down, developers cannot use AI features including code completions, chat, and intelligent editing. The editor itself may still function for basic editing, but AI-powered features will be unavailable.',
    faqs: [
      { q: 'Is Cursor down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Cursor every 5 minutes and shows real-time operational status.' },
      { q: 'Why is Cursor AI not working?', a: 'Cursor AI features may be down due to server issues or upstream model provider outages (e.g., Claude or OpenAI). Check this page for current status details.' },
      { q: 'What are alternatives to Cursor?', a: 'When Cursor is down, GitHub Copilot, Windsurf, or Claude Code are alternative AI coding tools. AIWatch shows which are currently operational.' },
      { q: 'Is Cursor down because of Claude or OpenAI?', a: 'Cursor relies on external model providers. Check the AIWatch dashboard at ai-watch.dev to see if Claude API or OpenAI is also experiencing issues.' },
    ],
  },
  'claude-code': {
    displayName: 'Claude Code',
    description: 'Claude Code is Anthropic\'s official CLI tool for AI-powered coding. It runs in the terminal, understands entire codebases, and can edit files, run commands, and manage git workflows autonomously using Claude models.',
    insight: 'Claude Code shares Anthropic\'s status page with Claude API and claude.ai. An incident on Claude API will also affect Claude Code since it relies on the same backend models. When evaluating Claude Code reliability, check both the Claude Code status and the Claude API status on AIWatch.',
    whenDown: 'When Claude Code is down, developers cannot use AI-assisted coding in their terminal. Code generation, file editing, command execution, and codebase Q&A features will be unavailable. Consider using an alternative coding agent until the service recovers.',
    faqs: [
      { q: 'Is Claude Code down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Claude Code every 5 minutes and shows real-time operational status, uptime percentage, and recent incidents.' },
      { q: 'Why is Claude Code not working?', a: 'Claude Code relies on Anthropic\'s Claude API backend. If Claude API is experiencing issues (model errors, rate limiting), Claude Code will also be affected. Check this page for current status.' },
      { q: 'What can I use instead of Claude Code?', a: 'When Claude Code is down, GitHub Copilot, Cursor, or Windsurf are alternative AI coding tools. AIWatch shows which are currently operational.' },
      { q: 'Is Claude Code down because of Claude API?', a: 'Yes, Claude Code depends on Claude API models. Check the AIWatch dashboard at ai-watch.dev to see if Claude API is also experiencing issues — they often share the same incidents.' },
    ],
  },
  'claude-ai': {
    displayName: 'claude.ai',
    description: 'claude.ai is Anthropic\'s AI assistant, available on web, iOS, and Android. It provides direct access to Claude models for conversations, document analysis, coding assistance, and creative tasks — no API key required.',
    insight: 'claude.ai shares Anthropic\'s status page with Claude API and Claude Code, but is tracked as a separate component. An API-level outage will typically affect claude.ai as well. However, claude.ai can experience app-specific issues (login, file upload, rendering) independently of the API. AIWatch monitors the claude.ai component separately for accurate status reporting.',
    whenDown: 'When claude.ai is down, users cannot access conversations, file uploads, or artifact generation. Claude API and Claude Code may still function independently if the issue is client-specific.',
    faqs: [
      { q: 'Is claude.ai down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors claude.ai every 5 minutes and shows real-time operational status, uptime percentage, and recent incidents.' },
      { q: 'Why is claude.ai not working?', a: 'claude.ai may be experiencing web server issues, authentication problems, or upstream Claude API outages. Check this page for current status and the AIWatch dashboard to see if Claude API is also affected.' },
      { q: 'What can I use instead of claude.ai?', a: 'When claude.ai is down, ChatGPT (chat.openai.com) or Google Gemini (gemini.google.com) are alternative AI chatbots. AIWatch shows which web apps are currently operational.' },
      { q: 'Is claude.ai down because of Claude API?', a: 'claude.ai depends on Claude API models but can also have web-specific issues. Check the AIWatch dashboard at ai-watch.dev to see if Claude API is also experiencing issues — they often share the same incidents.' },
    ],
  },
  openai: {
    displayName: 'OpenAI',
    description: 'OpenAI API provides access to OpenAI\'s language, image, and audio models used by millions of developers. It serves both the ChatGPT consumer product and enterprise API integrations.',
    insight: 'OpenAI API and ChatGPT share infrastructure but are monitored separately by AIWatch. An API outage may not affect ChatGPT and vice versa. OpenAI maintains one of the highest uptime records among AI providers, with most incidents resolved within 30 minutes.',
    whenDown: 'When OpenAI API is down, applications using language, embedding, or image generation models will fail. This affects thousands of third-party apps, chatbots, and developer tools that rely on OpenAI as their backend.',
    faqs: [
      { q: 'Is OpenAI API down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors OpenAI API every 5 minutes and shows real-time operational status, uptime percentage, and recent incidents.' },
      { q: 'Is this affecting ChatGPT too?', a: 'OpenAI API and ChatGPT are tracked separately. Check the AIWatch dashboard at ai-watch.dev to see if both are affected or just one.' },
      { q: 'What should I do when OpenAI API is down?', a: 'Consider switching to Claude API by Anthropic or Gemini API by Google as alternatives. AIWatch provides real-time fallback recommendations based on current availability.' },
      { q: 'How do I check OpenAI API status?', a: 'You can check OpenAI status on this page (updated every 5 minutes), on the official OpenAI status page at status.openai.com, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  windsurf: {
    displayName: 'Windsurf',
    description: 'Windsurf is an AI-powered code editor by Codeium, offering intelligent code completions, multi-file editing, and an agentic coding experience. It supports multiple LLM backends and is designed as a Cursor alternative.',
    insight: 'Windsurf relies on Codeium\'s own infrastructure plus upstream model providers. AIWatch tracks Windsurf independently — when Windsurf reports an issue, it may be Codeium-specific or caused by an upstream model outage. Windsurf has maintained strong uptime since launch.',
    whenDown: 'When Windsurf is down, developers lose AI code completions, multi-file editing, and agentic coding features. The editor may still function for basic editing, but all AI-powered features will be unavailable.',
    faqs: [
      { q: 'Is Windsurf down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Windsurf every 5 minutes and shows real-time operational status.' },
      { q: 'Why is Windsurf AI not working?', a: 'Windsurf AI features may be down due to Codeium server issues or upstream model provider outages. Check this page for current status details.' },
      { q: 'What are alternatives to Windsurf?', a: 'When Windsurf is down, Cursor, GitHub Copilot, or Claude Code are alternative AI coding tools. AIWatch shows which are currently operational.' },
      { q: 'Is Windsurf better than Cursor?', a: 'Both are AI-native code editors with different strengths. Check AIWatch reliability rankings at ai-watch.dev/#ranking to compare uptime and incident history.' },
    ],
  },
  // Phase B — LLM APIs (#263)
  mistral: {
    displayName: 'Mistral',
    description: 'Mistral API provides access to open-weight and proprietary language models from Mistral AI, a Paris-based research lab. Models include Mistral Large, Codestral, and various smaller open-source releases.',
    insight: 'Mistral status page is hosted on Instatus rather than Atlassian Statuspage, so AIWatch parses incidents from a different source than most US-based providers. Mistral typically reports a smaller incident volume, but its status page granularity is also lower — short outages may be aggregated into longer incident windows.',
    whenDown: 'When Mistral API is down, developers using Mistral Large, Codestral, or open-source model endpoints will see request failures. Le Chat and other Mistral-powered apps may also be affected.',
    faqs: [
      { q: 'Is Mistral API down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Mistral every 5 minutes and shows real-time operational status, uptime percentage, and recent incidents.' },
      { q: 'How do I check Mistral status?', a: 'You can check Mistral status on this page, on the official Mistral status page at status.mistral.ai, or on the AIWatch dashboard at ai-watch.dev.' },
      { q: 'What are alternatives to Mistral?', a: 'When Mistral is down, Cohere, Groq, Together AI, or OpenAI are alternative LLM APIs. AIWatch provides real-time fallback recommendations.' },
      { q: 'Does Mistral downtime affect Le Chat?', a: 'Le Chat depends on the Mistral API backend, so API outages typically affect Le Chat as well. Check this page to see whether the API is currently operational.' },
    ],
  },
  cohere: {
    displayName: 'Cohere',
    description: 'Cohere API provides enterprise-grade language models specializing in retrieval-augmented generation (RAG), reranking, and multilingual embeddings. Cohere is widely used in enterprise search and knowledge applications.',
    insight: 'Cohere reports incidents per component (Generate, Embed, Rerank, Classify), so AIWatch shows aggregated overall status. Cohere has strong uptime historically — most incidents are short, model-specific issues rather than full API outages.',
    whenDown: 'When Cohere API is down, applications relying on Generate, Embed, or Rerank endpoints will fail. Enterprise search and RAG applications built on Cohere will not return results.',
    faqs: [
      { q: 'Is Cohere API down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Cohere every 5 minutes and shows real-time operational status.' },
      { q: 'How do I check Cohere status?', a: 'You can check Cohere status on this page, on the official Cohere status page at status.cohere.com, or on the AIWatch dashboard at ai-watch.dev.' },
      { q: 'What can I use instead of Cohere?', a: 'When Cohere is down, Voyage AI is a strong alternative for embeddings and reranking. For Generate, OpenAI, Mistral, or Groq are options. AIWatch shows current availability.' },
      { q: 'Are Cohere embeddings affected during incidents?', a: 'Cohere reports embed and generate incidents separately. Check this page for the current overall status, and the official status page for component-level breakdowns.' },
    ],
  },
  groq: {
    displayName: 'Groq Cloud',
    description: 'Groq Cloud provides ultra-low-latency inference for popular open-source LLMs (Llama, Mixtral, Gemma) using custom LPU hardware. Groq is known for sub-100ms response times that traditional GPU-based providers cannot match.',
    insight: 'Groq\'s edge is response speed, not just availability. AIWatch tracks both uptime and probe-based response times — Groq\'s latency advantage usually holds even during partial degradations. Most incidents are short capacity-related slowdowns rather than full outages.',
    whenDown: 'When Groq Cloud is down, applications relying on its low-latency inference (real-time voice, streaming chat, agentic loops) lose their speed advantage and must fall back to slower providers, often breaking UX assumptions.',
    faqs: [
      { q: 'Is Groq Cloud down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Groq every 5 minutes and shows real-time operational status, uptime, and response time data.' },
      { q: 'Why is Groq slow today?', a: 'Groq performance degradations often appear before full outages. Check this page for any active incidents, and the AIWatch dashboard for probe-based response time trends.' },
      { q: 'What are alternatives to Groq?', a: 'For low-latency inference, Together AI and Fireworks AI are the closest alternatives. For general LLM API, OpenAI or Claude work as fallbacks. AIWatch ranks current availability.' },
      { q: 'How do I check Groq status?', a: 'You can check Groq status on this page, on the official Groq status page at groqstatus.com, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  together: {
    displayName: 'Together AI',
    description: 'Together AI provides hosted inference for hundreds of open-source models (Llama, Mistral, Qwen, FLUX) with both shared and dedicated endpoints. It is widely used for fine-tuning and serving custom models.',
    insight: 'Together AI publishes per-model incidents, so the same outage can show up as multiple separate entries (e.g., FLUX.1 dev, Llama 3.1 70B). AIWatch merges concurrent Together incidents into single grouped alerts to avoid alert noise.',
    whenDown: 'When Together AI is down, developers lose access to a wide range of open-source models simultaneously. Fine-tuning jobs, serverless endpoints, and dedicated deployments may all be affected depending on the incident scope.',
    faqs: [
      { q: 'Is Together AI down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Together AI every 5 minutes and shows real-time operational status.' },
      { q: 'Why does Together AI list so many incidents?', a: 'Together reports per-model incidents, so a single underlying issue can produce multiple entries. AIWatch groups concurrent incidents in alerts; check the official status page for per-model detail.' },
      { q: 'What are alternatives to Together AI?', a: 'Fireworks AI, Groq Cloud, and Hugging Face Inference are alternative open-source model platforms. AIWatch shows current availability across all of them.' },
      { q: 'How do I check Together AI status?', a: 'You can check Together status on this page, on the official Together status page at status.together.ai, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  fireworks: {
    displayName: 'Fireworks AI',
    description: 'Fireworks AI offers fast, scalable inference for popular open-source LLMs and image models, plus fine-tuning and dedicated deployments. It is positioned as a high-performance alternative to Together AI.',
    insight: 'Fireworks runs its status page on Better Stack rather than Atlassian, giving AIWatch slightly different signal granularity. Fireworks tends to publish official uptime numbers rather than rely on incident history alone, making its reliability data among the most transparent in the inference category.',
    whenDown: 'When Fireworks AI is down, developers lose hosted inference for open-source models. Production apps relying on Fireworks for serverless or dedicated endpoints will see request failures.',
    faqs: [
      { q: 'Is Fireworks AI down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Fireworks every 5 minutes and shows real-time operational status.' },
      { q: 'How do I check Fireworks AI status?', a: 'You can check Fireworks status on this page, on the official Fireworks status page at status.fireworks.ai, or on the AIWatch dashboard at ai-watch.dev.' },
      { q: 'What are alternatives to Fireworks AI?', a: 'Together AI, Groq Cloud, and Hugging Face Inference offer similar hosted open-source model inference. AIWatch shows current availability and reliability rankings.' },
      { q: 'Is Fireworks faster than Together AI?', a: 'Both target low-latency inference but optimize differently. Check AIWatch ranking at ai-watch.dev/#ranking to compare uptime and probe response times.' },
    ],
  },
  perplexity: {
    displayName: 'Perplexity',
    description: 'Perplexity is an AI-powered answer engine combining LLMs with real-time web search. It offers consumer search at perplexity.ai and an API for developers to access its search-augmented generation capabilities.',
    insight: 'Perplexity\'s status page does not publish official uptime numbers, so AIWatch estimates uptime from incident durations using Atlassian-style impact weighting. Outages often correlate with upstream LLM provider issues since Perplexity uses multiple model backends.',
    whenDown: 'When Perplexity is down, both the consumer search interface (perplexity.ai) and the developer API will fail to return answers. Apps built on Perplexity API for search-augmented generation will lose their search capability.',
    faqs: [
      { q: 'Is Perplexity down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Perplexity every 5 minutes and shows real-time operational status.' },
      { q: 'Why is Perplexity not working?', a: 'Perplexity may be experiencing search index issues, LLM backend outages, or rate limiting. Check this page for any active incidents.' },
      { q: 'What are alternatives to Perplexity?', a: 'For AI-powered search, ChatGPT (with browsing), Claude, or Gemini are alternatives. AIWatch shows current availability for each.' },
      { q: 'How do I check Perplexity status?', a: 'You can check Perplexity status on this page, on the official Perplexity status page at status.perplexity.com, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  xai: {
    displayName: 'xAI (Grok)',
    description: 'xAI is the AI company founded by Elon Musk, providing the Grok family of language models via API. Grok models are known for real-time data access through X (Twitter) integration.',
    insight: 'xAI publishes incidents via RSS feed rather than a typical Statuspage interface, so AIWatch parses a different format. xAI is a relatively new entrant — its incident history is shorter than established providers, and probe-based response times are tracked across multiple regions.',
    whenDown: 'When xAI API is down, applications using Grok models for real-time data analysis or chat will fail. Apps relying on Grok\'s X integration for current events queries will lose that capability.',
    faqs: [
      { q: 'Is xAI Grok API down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors xAI every 5 minutes and shows real-time operational status.' },
      { q: 'How do I check xAI status?', a: 'You can check xAI status on this page, on the official xAI status page at status.x.ai, or on the AIWatch dashboard at ai-watch.dev.' },
      { q: 'What are alternatives to Grok?', a: 'For general LLM API, OpenAI, Claude, or Gemini are mature alternatives. None match Grok\'s real-time X integration, but AIWatch shows current availability for each.' },
      { q: 'Is Grok down because of X (Twitter)?', a: 'Grok depends on xAI infrastructure separate from X. However, real-time data features may be affected by X platform issues. Check this page for the current xAI API status.' },
    ],
  },
  deepseek: {
    displayName: 'DeepSeek',
    description: 'DeepSeek API provides access to DeepSeek\'s frontier reasoning models (V3, R1) at significantly lower price points than Western providers. It is a Chinese AI lab whose models have gained rapid adoption since early 2026.',
    insight: 'DeepSeek API can experience capacity-driven outages during demand spikes (model release events, viral moments). Geographic latency varies more than US-based providers given DeepSeek\'s primarily Asian infrastructure. Check AIWatch probe data for response time trends.',
    whenDown: 'When DeepSeek API is down, applications relying on its low-cost reasoning models will fail. Cost-sensitive deployments that switched from OpenAI/Claude to DeepSeek for affordability lose their primary backend.',
    faqs: [
      { q: 'Is DeepSeek API down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors DeepSeek every 5 minutes and shows real-time operational status.' },
      { q: 'Why is DeepSeek slow today?', a: 'DeepSeek slowdowns often follow major announcements or viral usage. Check this page for active incidents, and the AIWatch dashboard for probe response times.' },
      { q: 'What are alternatives to DeepSeek?', a: 'Mistral, Groq, OpenAI, and Claude are alternatives depending on your needs. For reasoning specifically, Claude or OpenAI offer comparable quality at higher cost.' },
      { q: 'How do I check DeepSeek status?', a: 'You can check DeepSeek status on this page, on the official DeepSeek status page at status.deepseek.com, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  openrouter: {
    displayName: 'OpenRouter',
    description: 'OpenRouter is a unified API gateway providing access to 100+ models from multiple providers (OpenAI, Anthropic, Google, Mistral, Meta, etc.) through a single endpoint. It handles routing, fallbacks, and per-model pricing.',
    insight: 'OpenRouter outages often originate from upstream provider issues rather than OpenRouter itself, since it brokers requests to many backends. AIWatch tracks OpenRouter\'s gateway availability — when OpenRouter is down, individual upstream models may still be reachable directly.',
    whenDown: 'When OpenRouter is down, applications using its unified gateway lose access to all routed models simultaneously. Apps with direct fallback logic to original provider APIs may continue working; apps relying on OpenRouter\'s routing will break.',
    faqs: [
      { q: 'Is OpenRouter down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors OpenRouter every 5 minutes and shows real-time operational status.' },
      { q: 'Why is OpenRouter not working?', a: 'OpenRouter may be experiencing gateway issues or its upstream model providers may be having outages. Check this page and the AIWatch dashboard to see which underlying providers are affected.' },
      { q: 'What can I use instead of OpenRouter?', a: 'When OpenRouter is down, you can call upstream providers directly (OpenAI, Claude, Mistral, etc.). AIWatch shows current availability for each provider.' },
      { q: 'How do I check OpenRouter status?', a: 'You can check OpenRouter status on this page, on the official OpenRouter status page at status.openrouter.ai, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  // Voice & Speech AI (#263)
  elevenlabs: {
    displayName: 'ElevenLabs',
    description: 'ElevenLabs provides leading text-to-speech and voice cloning APIs used in audiobooks, podcasts, conversational AI, and accessibility apps. Its multilingual voice synthesis is known for natural prosody and emotion.',
    insight: 'ElevenLabs reports incidents per feature (TTS, Voice Cloning, Conversational AI Agents). AIWatch tracks the overall service availability. Recent updates to AIWatch use Atlassian-style impact weighting so minor incidents (e.g., dashboard glitches) don\'t over-penalize ElevenLabs\' uptime score.',
    whenDown: 'When ElevenLabs is down, applications relying on text-to-speech generation, voice cloning, or conversational voice agents will fail. Audiobook pipelines, podcast generators, and voice-first apps lose their primary capability.',
    faqs: [
      { q: 'Is ElevenLabs down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors ElevenLabs every 5 minutes and shows real-time operational status.' },
      { q: 'Why is ElevenLabs voice generation failing?', a: 'ElevenLabs may be experiencing TTS API issues, capacity limits, or specific model unavailability. Check this page for active incidents.' },
      { q: 'What are alternatives to ElevenLabs?', a: 'For text-to-speech, AssemblyAI and Deepgram offer alternative voice APIs. AIWatch shows current availability for each voice service.' },
      { q: 'How do I check ElevenLabs status?', a: 'You can check ElevenLabs status on this page, on the official ElevenLabs status page at status.elevenlabs.io, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  assemblyai: {
    displayName: 'AssemblyAI',
    description: 'AssemblyAI provides production-grade speech-to-text APIs with features like speaker diarization, sentiment analysis, and topic detection. It is widely used for meeting transcription, podcast indexing, and call center analytics.',
    insight: 'AssemblyAI publishes per-component status (Async Transcription, Real-time Transcription, LeMUR). AIWatch tracks the API endpoint as a whole. Async transcription incidents are more common than real-time outages but generally resolve quickly.',
    whenDown: 'When AssemblyAI is down, applications submitting transcription jobs (async or real-time) will fail. Meeting recorders, captioning services, and call analytics pipelines will queue or drop work.',
    faqs: [
      { q: 'Is AssemblyAI down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors AssemblyAI every 5 minutes and shows real-time operational status.' },
      { q: 'Why is AssemblyAI transcription failing?', a: 'AssemblyAI may be experiencing async or real-time API issues. Check this page for active incidents and the official status page for component-level detail.' },
      { q: 'What are alternatives to AssemblyAI?', a: 'For speech-to-text, Deepgram and ElevenLabs (via STT features) are alternatives. AIWatch shows current availability for each speech service.' },
      { q: 'How do I check AssemblyAI status?', a: 'You can check AssemblyAI status on this page, on the official AssemblyAI status page at status.assemblyai.com, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  deepgram: {
    displayName: 'Deepgram',
    description: 'Deepgram provides fast, accurate speech-to-text APIs optimized for streaming use cases like real-time captions, voice agents, and live transcription. Its Nova model family is widely used in conversational AI.',
    insight: 'Deepgram typically maintains very high uptime, but live streaming endpoints can be more sensitive to regional issues than batch endpoints. AIWatch tracks Deepgram\'s overall API availability via probe-based health checks alongside official status.',
    whenDown: 'When Deepgram is down, applications using real-time transcription for voice agents, live captions, or contact center streaming will lose their core functionality. Batch transcription jobs may queue but live UX breaks immediately.',
    faqs: [
      { q: 'Is Deepgram down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Deepgram every 5 minutes and shows real-time operational status.' },
      { q: 'Why is Deepgram streaming not working?', a: 'Deepgram streaming may be affected by regional network issues or capacity constraints. Check this page for active incidents.' },
      { q: 'What are alternatives to Deepgram?', a: 'For speech-to-text, AssemblyAI and ElevenLabs are alternatives. AIWatch shows current availability for each.' },
      { q: 'How do I check Deepgram status?', a: 'You can check Deepgram status on this page, on the official Deepgram status page at status.deepgram.com, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  // Inference & infrastructure (#263)
  huggingface: {
    displayName: 'Hugging Face',
    description: 'Hugging Face hosts the largest open-source AI model hub plus Inference API endpoints, datasets, and Spaces (deployed apps). It is the de facto registry for open ML and a major inference provider.',
    insight: 'Hugging Face has multiple distinct services (Hub, Inference API, Spaces, Datasets) that can fail independently. AIWatch monitors the Inference API path most relevant to API consumers — Hub-only or Spaces-only outages may not trigger an inference incident.',
    whenDown: 'When Hugging Face Inference API is down, apps loading models programmatically or using hosted inference endpoints will fail. Even when Inference is healthy, Hub or Spaces outages can affect model downloads and deployed apps.',
    faqs: [
      { q: 'Is Hugging Face down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Hugging Face Inference every 5 minutes and shows real-time operational status.' },
      { q: 'Why can\'t I download models from Hugging Face?', a: 'Model downloads use the Hub API which can fail independently of Inference. Check this page and the official status page for component-level detail.' },
      { q: 'What are alternatives to Hugging Face?', a: 'For inference, Replicate, Together AI, and Modal are alternatives. For model storage, models can be cached locally. AIWatch shows current availability across providers.' },
      { q: 'How do I check Hugging Face status?', a: 'You can check Hugging Face status on this page, on the official Hugging Face status page at status.huggingface.co, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  replicate: {
    displayName: 'Replicate',
    description: 'Replicate runs open-source models (FLUX, Stable Diffusion, Llama, Whisper, etc.) via a simple HTTP API with per-second billing. It is widely used for image generation, video models, and serverless ML inference.',
    insight: 'Replicate hosts thousands of community-contributed models, so individual model issues are common but rarely affect the whole platform. AIWatch tracks platform-level availability — model-specific failures may not show as incidents but can still affect specific apps.',
    whenDown: 'When Replicate is down, apps using its API for image generation, video synthesis, audio transcription, or custom model inference will fail. Production apps built on Replicate\'s simple API often have no fallback configured.',
    faqs: [
      { q: 'Is Replicate down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Replicate every 5 minutes and shows real-time operational status.' },
      { q: 'Why is my Replicate prediction stuck?', a: 'Replicate predictions can queue during capacity spikes. Check this page for active platform incidents; if the platform is healthy, the issue may be specific to your chosen model.' },
      { q: 'What are alternatives to Replicate?', a: 'For image generation, Stability AI offers direct API access. For general inference, Hugging Face Inference or Modal are alternatives. AIWatch shows current availability.' },
      { q: 'How do I check Replicate status?', a: 'You can check Replicate status on this page, on the official Replicate status page at replicatestatus.com, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  pinecone: {
    displayName: 'Pinecone',
    description: 'Pinecone is a fully-managed vector database for production-grade similarity search and retrieval-augmented generation (RAG). It powers semantic search, recommendations, and AI memory in many large applications.',
    insight: 'Pinecone is region-specific — outages can affect specific environments (us-east-1, eu-west-1, etc.) without breaking the global platform. AIWatch tracks Pinecone\'s primary status; for region-specific issues check the official status page for component breakdowns.',
    whenDown: 'When Pinecone is down, applications relying on vector search for RAG, semantic search, or recommendations will fail. AI agents that depend on long-term memory or knowledge retrieval will lose context.',
    faqs: [
      { q: 'Is Pinecone down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Pinecone every 5 minutes and shows real-time operational status.' },
      { q: 'Why is Pinecone slow today?', a: 'Pinecone latency can be affected by region-specific issues, index size, or query patterns. Check this page for active incidents.' },
      { q: 'What are alternatives to Pinecone?', a: 'For vector search, Voyage AI offers embeddings + reranking, and self-hosted options like Qdrant, Weaviate, and pgvector are mature. AIWatch shows current availability.' },
      { q: 'How do I check Pinecone status?', a: 'You can check Pinecone status on this page, on the official Pinecone status page at status.pinecone.io, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  stability: {
    displayName: 'Stability AI',
    description: 'Stability AI develops the Stable Diffusion family of image models and provides API access for image generation, editing, and upscaling. It is widely used in creative tools, design apps, and content generation pipelines.',
    insight: 'Stability publishes model-tier incidents separately (SD3, SDXL, Stable Image Ultra). AIWatch shows platform-level status. With AIWatch\'s Atlassian-aligned uptime weighting, short minor incidents have proportionally smaller impact on the displayed reliability score.',
    whenDown: 'When Stability AI is down, apps generating images, doing image-to-image transformation, or upscaling will fail. Creative pipelines and design tools that integrate Stable Image API lose their generation capability.',
    faqs: [
      { q: 'Is Stability AI down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Stability AI every 5 minutes and shows real-time operational status.' },
      { q: 'Why is Stable Diffusion API failing?', a: 'Stability may be experiencing API capacity issues, specific model degradation, or upstream infrastructure issues. Check this page for active incidents.' },
      { q: 'What are alternatives to Stability AI?', a: 'For image generation, Replicate hosts FLUX and other image models, and OpenAI provides DALL-E via the API. AIWatch shows current availability.' },
      { q: 'How do I check Stability AI status?', a: 'You can check Stability status on this page, on the official Stability status page at status.stability.ai, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  voyageai: {
    displayName: 'Voyage AI',
    description: 'Voyage AI provides best-in-class embedding and reranking APIs optimized for retrieval-augmented generation (RAG). It is widely used to improve search quality in enterprise RAG pipelines.',
    insight: 'Voyage AI is a smaller, focused API with high reliability historically. Its limited surface area (embeddings + reranking only) means fewer failure modes than general-purpose LLM APIs. AIWatch tracks endpoint availability via probe checks.',
    whenDown: 'When Voyage AI is down, RAG pipelines using its embeddings for search or reranking for relevance will degrade — searches may continue using stale embeddings but reranking quality will drop without the API.',
    faqs: [
      { q: 'Is Voyage AI down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Voyage AI every 5 minutes and shows real-time operational status.' },
      { q: 'How do I check Voyage AI status?', a: 'You can check Voyage status on this page, on the official Voyage status page (statuspage.io), or on the AIWatch dashboard at ai-watch.dev.' },
      { q: 'What are alternatives to Voyage AI?', a: 'For embeddings and reranking, Cohere offers similar capabilities. OpenAI provides general-purpose embeddings as well. AIWatch shows current availability.' },
      { q: 'Does Voyage AI downtime affect RAG search?', a: 'Yes — both initial embedding and rerank steps depend on Voyage. Pipelines without cached embeddings or fallback rerankers will degrade. Check this page for current status.' },
    ],
  },
  modal: {
    displayName: 'Modal',
    description: 'Modal is a serverless cloud platform for running Python AI workloads, training jobs, and custom inference endpoints. It is popular among ML engineers for its developer experience and pay-per-execution model.',
    insight: 'Modal\'s serverless model means individual function failures are common but don\'t indicate platform-wide outages. AIWatch tracks Modal\'s control plane availability — your specific function may fail even when the platform is healthy.',
    whenDown: 'When Modal is down, scheduled jobs won\'t fire, deployed inference endpoints will return errors, and new code deployments will fail. Apps relying on Modal for batch ML inference or training pipelines lose execution capability.',
    faqs: [
      { q: 'Is Modal down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Modal every 5 minutes and shows real-time operational status.' },
      { q: 'Why is my Modal function failing?', a: 'Function-level failures may not show as platform incidents. Check this page for platform status, and the official Modal logs for function-specific issues.' },
      { q: 'What are alternatives to Modal?', a: 'For serverless ML, Replicate, Hugging Face Spaces, and Beam Cloud are alternatives. AIWatch shows current availability across inference providers.' },
      { q: 'How do I check Modal status?', a: 'You can check Modal status on this page, on the official Modal status page at status.modal.com, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  // AI apps (#263)
  'character-ai': {
    displayName: 'Character.AI',
    description: 'Character.AI is a consumer AI chatbot platform where users create and interact with custom AI characters. It is one of the most-used AI consumer apps with millions of daily active users.',
    insight: 'Character.AI experiences capacity-driven slowdowns more frequently than enterprise APIs due to its consumer scale. Outages often correlate with viral moments or schedule patterns (school hours). AIWatch tracks platform availability without distinguishing per-character issues.',
    whenDown: 'When Character.AI is down, users cannot start conversations, continue existing chats, or create new characters. The mobile and web interfaces both depend on the same backend, so an outage affects all access methods.',
    faqs: [
      { q: 'Is Character.AI down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Character.AI every 5 minutes and shows real-time operational status.' },
      { q: 'Why is Character.AI not loading?', a: 'Character.AI may be experiencing high traffic, server issues, or maintenance. Check this page for current status and recent incident history.' },
      { q: 'What are alternatives to Character.AI?', a: 'For roleplay-style chat, ChatGPT, claude.ai, or Gemini are alternatives. AIWatch shows which AI chat services are currently operational.' },
      { q: 'How long do Character.AI outages usually last?', a: 'Character.AI outage durations vary by cause. Check the recent incidents section on this page for typical resolution times.' },
    ],
  },
}

export function getSEOContent(slug: string): ServiceSEO | null {
  return SEO_CONTENT[slug] ?? null
}

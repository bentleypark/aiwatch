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
      { q: 'Is Claude API down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Claude API every 60 seconds and shows real-time operational status, uptime percentage, and recent incidents.' },
      { q: 'How do I check Claude API status?', a: 'You can check Claude API status on this page (updated every 60 seconds), on the official Anthropic status page at status.anthropic.com, or on the AIWatch dashboard at ai-watch.dev.' },
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
      { q: 'Is ChatGPT down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors ChatGPT every 60 seconds and shows real-time operational status, uptime percentage, and recent incidents.' },
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
      { q: 'Is Gemini API down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Gemini API every 60 seconds using Google Cloud Status data.' },
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
      { q: 'Is GitHub Copilot down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors GitHub Copilot every 60 seconds using GitHub Status data.' },
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
      { q: 'Is Cursor down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Cursor every 60 seconds and shows real-time operational status.' },
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
      { q: 'Is Claude Code down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Claude Code every 60 seconds and shows real-time operational status, uptime percentage, and recent incidents.' },
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
      { q: 'Is claude.ai down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors claude.ai every 60 seconds and shows real-time operational status, uptime percentage, and recent incidents.' },
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
      { q: 'Is OpenAI API down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors OpenAI API every 60 seconds and shows real-time operational status, uptime percentage, and recent incidents.' },
      { q: 'Is this affecting ChatGPT too?', a: 'OpenAI API and ChatGPT are tracked separately. Check the AIWatch dashboard at ai-watch.dev to see if both are affected or just one.' },
      { q: 'What should I do when OpenAI API is down?', a: 'Consider switching to Claude API by Anthropic or Gemini API by Google as alternatives. AIWatch provides real-time fallback recommendations based on current availability.' },
      { q: 'How do I check OpenAI API status?', a: 'You can check OpenAI status on this page (updated every 60 seconds), on the official OpenAI status page at status.openai.com, or on the AIWatch dashboard at ai-watch.dev.' },
    ],
  },
  windsurf: {
    displayName: 'Windsurf',
    description: 'Windsurf is an AI-powered code editor by Codeium, offering intelligent code completions, multi-file editing, and an agentic coding experience. It supports multiple LLM backends and is designed as a Cursor alternative.',
    insight: 'Windsurf relies on Codeium\'s own infrastructure plus upstream model providers. AIWatch tracks Windsurf independently — when Windsurf reports an issue, it may be Codeium-specific or caused by an upstream model outage. Windsurf has maintained strong uptime since launch.',
    whenDown: 'When Windsurf is down, developers lose AI code completions, multi-file editing, and agentic coding features. The editor may still function for basic editing, but all AI-powered features will be unavailable.',
    faqs: [
      { q: 'Is Windsurf down right now?', a: 'Check the live status indicator at the top of this page. AIWatch monitors Windsurf every 60 seconds and shows real-time operational status.' },
      { q: 'Why is Windsurf AI not working?', a: 'Windsurf AI features may be down due to Codeium server issues or upstream model provider outages. Check this page for current status details.' },
      { q: 'What are alternatives to Windsurf?', a: 'When Windsurf is down, Cursor, GitHub Copilot, or Claude Code are alternative AI coding tools. AIWatch shows which are currently operational.' },
      { q: 'Is Windsurf better than Cursor?', a: 'Both are AI-native code editors with different strengths. Check AIWatch reliability rankings at ai-watch.dev/#ranking to compare uptime and incident history.' },
    ],
  },
}

export function getSEOContent(slug: string): ServiceSEO | null {
  return SEO_CONTENT[slug] ?? null
}

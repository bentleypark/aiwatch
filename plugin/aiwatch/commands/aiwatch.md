---
description: Brief the current live status of monitored AI services (Claude, OpenAI, Gemini, and more) from AIWatch — which are degraded/down, the active incident, and what to use instead.
---

Run `sh "${CLAUDE_PLUGIN_ROOT}/bin/aiwatch-status.sh"` using the Bash tool (this path resolves to the script bundled with this plugin). It returns a server-rendered briefing: which AI services are degraded/down right now, each with its active incident (title + impact), an AI summary when available, a fallback suggestion, and a link to that service's status page — or a single line when all are operational.

Relay that briefing to the user faithfully. Reproduce every URL **exactly** as the tool returns it — do NOT shorten, rewrite, or strip anything from links (they redirect through an attribution path AIWatch needs). Do not add analysis, speculation, or invented incident details beyond what the tool returns.

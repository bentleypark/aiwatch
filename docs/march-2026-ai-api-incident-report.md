# March 2026 AI API Incident Report

> **Source**: [ai-watch.dev](https://ai-watch.dev) — Real-time AI API status monitoring  
> **Period**: March 1–31, 2026  
> **Published**: March 31, 2026  
> **Services monitored**: 19 AI APIs and tools

---

## TL;DR

- **Anthropic had the most active month**: Claude API (25 incidents), claude.ai (33), Claude Code (27) — driven by multi-model component reporting
- **GitHub Copilot** saw 14 incidents totaling 22h 29m, including multiple Webhooks and Codespaces outages
- **ElevenLabs** recorded the lowest uptime at 97.67%, with 4 incidents totaling 9h 12m
- **OpenAI API** remained stable: 6 incidents, only 2h 28m total downtime (after excluding 1 negative-duration data anomaly)
- **Cleanest month**: Gemini, Cohere, DeepSeek, Perplexity, HuggingFace, and xAI reported zero incidents — Groq and Cursor had incidents but maintained 100% official uptime

---

## Incident Summary

> **Note on methodology**: Incident counts and downtime reflect all affected components per service (e.g., Claude API counts Opus, Sonnet, and Haiku separately). Official uptime % is based on a single primary component. These two metrics are not directly comparable.  
> One OpenAI incident ("High Error Rate in Realtime API") was excluded due to a negative duration value — a known data anomaly from the upstream status feed.  
> Groq and Cursor show 100% official uptime despite minor incidents; their primary API components were unaffected.

| Service | Incidents | Total Downtime | Longest Single Incident |
|---|---|---|---|
| claude.ai | 33 | 65h 24m | 7h 29m |
| Claude Code | 27 | 56h 47m | 7h 29m |
| Claude API | 25 | 49h 19m | 7h 29m |
| GitHub Copilot | 14 | 22h 29m | 7h 40m |
| ChatGPT | 7 | 15h 6m | 4h 59m |
| Cursor | 7 | 10h 30m | 4h 3m |
| ElevenLabs | 4 | 9h 12m | 4h 26m |
| Windsurf | 4 | 8h 10m | 3h 32m |
| Replicate | 1 | 5h 21m | 5h 21m |
| OpenAI API | 5 | 1h 30m | 43m |
| Together AI | 5 | 1h 40m | 31m |
| Groq Cloud | 1 | 59m | 59m |
| Mistral API | 5 | 2m | 1m |
| Gemini API | 0 | — | — |
| Cohere API | 0 | — | — |
| DeepSeek API | 0 | — | — |
| Perplexity | 0 | — | — |
| Hugging Face | 0 | — | — |
| xAI (Grok) | 0 | — | — |

---

## Official Uptime (Primary Component)

*Gemini, Mistral, Perplexity, and xAI do not publish accessible uptime metrics on their status pages.*

| Service | Uptime |
|---|---|
| Cursor | 100.00% |
| Groq Cloud | 100.00% |
| Cohere API | 100.00% |
| DeepSeek API | 100.00% |
| Hugging Face | 99.99% |
| ChatGPT | 99.99% |
| Windsurf | 99.99% |
| OpenAI API | 99.99% |
| GitHub Copilot | 99.62% |
| Together AI | 99.61% |
| Claude Code | 99.58% |
| Claude API | 99.34% |
| claude.ai | 99.31% |
| Replicate | 99.06% |
| ElevenLabs | 97.67% |

---

## Notable Incidents

### 1. Anthropic — Prolonged Multi-Model Degradation (Mar 1–31)
**Affected**: Claude API, claude.ai, Claude Code  
**Pattern**: Recurring 7h+ incidents across Opus, Sonnet, and Haiku model components  
**Longest**: 7h 29m  

Anthropic's high incident count reflects its granular per-model reporting rather than a single outage. Each model tier (Opus/Sonnet/Haiku) is tracked as a separate component, so a platform-wide degradation registers as multiple simultaneous incidents. The practical impact on any single model was lower than the aggregate numbers suggest.

---

### 2. GitHub Copilot — Infrastructure Instability (14 incidents, 22h 29m)
**Affected**: Copilot Chat, Webhooks, Codespaces, Actions  
**Longest**: 7h 40m  

Copilot had its most incident-heavy month, with disruptions spanning Webhooks (8h + 6h 30m + 1h 13m), Codespaces (5h 46m + 47m), and Actions (1h 15m + 1h 1m). These were excluded from the primary downtime count as they affect peripheral infrastructure rather than core AI completions, but developers relying on full GitHub integration felt the impact.

---

### 3. ElevenLabs — Lowest Uptime at 97.67% (4 incidents, 9h 12m)
**Affected**: API / Voice generation  
**Longest**: 4h 26m  

ElevenLabs recorded the lowest official uptime this month. With 4 incidents averaging over 2 hours each, teams building voice-dependent features faced meaningful disruption.

---

### 4. Replicate — Single Long Outage (1 incident, 5h 21m)
**Affected**: Model inference API  

A single 5h 21m outage with no other incidents. Worth noting for teams running batch inference workloads.

---

### 5. ChatGPT — File Handling Issues Excluded
**Reported**: 10 incidents, 98h 10m (raw)  
**Adjusted**: 7 incidents, 15h 6m (API-relevant only)  

Three large incidents (file downloads 47h 5m, file uploads 26h 52m, pinned chats 9h 7m) were excluded as they affect web UI features rather than the Chat Completions API. The adjusted figure better reflects developer-facing reliability.

---

### 6. OpenAI API — Negative Duration Anomaly Excluded
**Reported**: 6 incidents including "High Error Rate in Realtime API"  
**Adjusted**: 5 incidents, 1h 30m  

One incident returned a negative duration value from the upstream status feed — a data anomaly rather than a real event. Excluding it brings the total to 1h 30m, making OpenAI API one of the most stable services this month.

---

## Observations

**If you build on Anthropic**: The high incident count is largely a reporting artifact. Monitor individual model components (e.g., `claude-sonnet`) rather than the aggregate. The 7h 29m longest incident is the number to watch.

**If you build on GitHub Copilot**: Webhooks and Codespaces instability suggests avoiding tight CI/CD dependencies on these features without fallback handling.

**If you build on ElevenLabs**: With 97.67% uptime, implement retry logic and consider caching generated audio for critical user-facing flows.

**Generally stable this month**: OpenAI API (1h 30m total), Together AI (1h 40m), Groq (59m). Good candidates for primary or fallback providers.

---

## About This Report

Data sourced from [ai-watch.dev](https://ai-watch.dev), which aggregates real-time status from official provider status pages including Atlassian Statuspage, incident.io, Google Cloud Status, Better Stack, and RSS feeds.

- Incident counts reflect all affected components per service
- Downtime figures exclude non-API incidents (UI bugs, file handling, webhooks)
- Uptime % reflects official single-component figures from provider status pages
- Services showing "—" for uptime have no publicly accessible uptime metric

**View live status**: [ai-watch.dev](https://ai-watch.dev)  
**Next report**: April 2026

---

*Have feedback or spotted an error? Open an issue at [github.com/bentleypark/aiwatch](https://github.com/bentleypark/aiwatch)*

# AIWatch

[![Tests](https://github.com/bentleypark/aiwatch/actions/workflows/test.yml/badge.svg)](https://github.com/bentleypark/aiwatch/actions/workflows/test.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Deploy](https://img.shields.io/badge/Deploy-ai--watch.dev-blue)](https://ai-watch.dev)
[![GitHub stars](https://img.shields.io/github/stars/bentleypark/aiwatch)](https://github.com/bentleypark/aiwatch/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/bentleypark/aiwatch)](https://github.com/bentleypark/aiwatch/commits/main)

[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/is-claude-down)
[![OpenAI API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/openai)](https://ai-watch.dev/is-openai-down)
[![Gemini API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/gemini)](https://ai-watch.dev/is-gemini-down)
[![GitHub Copilot](https://aiwatch-worker.p2c2kbf.workers.dev/badge/copilot)](https://ai-watch.dev/is-github-copilot-down)

**English** | [한국어](README.ko.md)

Real-time monitoring dashboard for **43 AI services** — track status, latency, uptime, and incidents across major AI providers.

**[Dashboard](https://ai-watch.dev)** · **[Landing Page](https://ai-watch.dev/intro)**

| Desktop | Mobile |
|---------|--------|
| ![AIWatch Dashboard](docs/screenshot.png?v=3) | ![AIWatch Mobile](docs/screenshot-mobile.png?v=1) |

**Share**
[![Share on X](https://img.shields.io/badge/Share-X-000000?logo=x&logoColor=white)](https://twitter.com/intent/tweet?text=AIWatch%20%E2%80%94%20Real-time%20monitoring%20for%2039%20AI%20services%20%28Claude%2C%20ChatGPT%2C%20Gemini%2C%20and%20more%29&url=https%3A%2F%2Fgithub.com%2Fbentleypark%2Faiwatch)
[![Share on Reddit](https://img.shields.io/badge/Share-Reddit-FF4500?logo=reddit&logoColor=white)](https://reddit.com/submit?url=https%3A%2F%2Fgithub.com%2Fbentleypark%2Faiwatch&title=AIWatch%20%E2%80%94%20Real-time%20monitoring%20for%2039%20AI%20services)
[![Share on Hacker News](https://img.shields.io/badge/Share-Hacker%20News-FF6600?logo=ycombinator&logoColor=white)](https://news.ycombinator.com/submitlink?u=https%3A%2F%2Fgithub.com%2Fbentleypark%2Faiwatch&t=AIWatch%20%E2%80%94%20Real-time%20monitoring%20for%2039%20AI%20services)
[![Share on LinkedIn](https://img.shields.io/badge/Share-LinkedIn-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fgithub.com%2Fbentleypark%2Faiwatch)

## 🛰️ Live Demo

Visit **[ai-watch.dev](https://ai-watch.dev)** — no signup required. Updated every 5 minutes via Cloudflare Workers.

## Features

- **Real-time status** — Operational / Degraded / Down for 43 AI services
- **PWA support** — Add to home screen, offline cache with Service Worker
- **Latency monitoring** — Direct API endpoint response time (RTT) for 29 probe-capable services, status page timing as fallback
- **24h latency trend** — Chart.js line chart with 5-min probe snapshots
- **Incident history** — Timeline with details from multiple status page formats
- **Official uptime** — Per-component uptime from Statuspage, incident.io, Better Stack
- **Component status breakdown** — Real-time per-component status (models, API surfaces, …) on ServiceDetails + Is X Down for 24 multi-component services, with collapsible section/model groups for long lists
- **Status calendar** — 30-day (Statuspage) or 14-day (incident.io) daily status visualization
- **Discord & Slack alerts** — Discord webhook on status changes/incidents + Slack via its native `/feed` RSS app (zero-config) + RSS feeds
- **Cookie consent** — GA4 Consent Mode v2 with accept/essential-only
- **Deep links** — Hash-based routing (`#claude`, `#latency`) for direct page access
- **Dark/Light theme** — System-aware with manual toggle
- **Bilingual** — Korean / English
- **Mobile responsive** — Sidebar overlay, mobile action bar
- **AIWatch Score** — Composite reliability score combining uptime, incidents, recovery time, and probe-based responsiveness ([how it works](https://ai-watch.dev/methodology#score))
- **RTT degradation detection** — AIWatch's direct API probes flag latency degradation that official status pages often never report (dashboard badge + Discord daily summary). Independent detection within the ~5-min polling cycle of the official report (MTTD)
- **Regional availability** — Per-region incident status for xAI, Gemini, OpenAI with switch recommendation
- **Smart alerts** — Discord alerts for degraded/down status with anti-flapping, incident suppression, and recovery duration
- **Offline UI** — Graceful error state when API is unreachable (production only)
- **Is X Down SEO pages** — 40 services (all monitored services except Bedrock / Azure OpenAI) with dynamic OG images (PNG), share buttons, AIWatch rank (matches dashboard with tied-rank display), and fallback recommendations
- **Health check probing** — Direct RTT measurement to API endpoints (29 API services) with early outage detection via consecutive spike alerts and RTT degradation tracking
- **Page-specific skeletons** — Loading placeholders matched to each page layout
- **AI Analysis (Beta)** — Hybrid AI auto-analysis on incidents (Gemma 4 primary + Sonnet fallback): cause estimation, recovery time, affected scope, contextual fallback recommendations. Merged into incident Discord alert (single embed), Topbar Analyze modal, Is X Down AI Insight card
- **Landing page** — Landing page (`/intro`) with dashboard preview mock, KO/EN i18n, flow animation, optional `?banner=` campaign slot, and GA4 tracking
- **Web Vitals monitoring** — Real user LCP, FCP, TTFB, CLS, INP collection with p75 aggregation and threshold-based alerts in Discord Daily Report
- **Weekly briefing** — Sunday Discord digest with AI service changelog detection (OpenAI, Google, Anthropic), incident summary, and stability trends
- **Security monitoring** — AI service security incident detection via Hacker News, Reddit (r/netsec, r/cybersecurity), and OSV.dev SDK vulnerability scanning across 24 AI SDK packages (PyPI + npm, including Langchain ecosystem adapters) with dashboard alerts + Discord digest
- **Status page cross-validation** — Probe RTT + platform quorum + metastatuspage monitoring to prevent false positives during status page infrastructure outages

## Monitored Services

Grouped by the dashboard's category taxonomy (43 total — sidebar filters / Overview sections mirror these).

### LLM APIs (15)

| Service | Provider | Status Source |
|---------|----------|---------------|
| Claude API | Anthropic | Atlassian Statuspage |
| OpenAI API | OpenAI | incident.io (Atlassian compat) |
| Gemini API | Google | Google Cloud incidents.json |
| Mistral API | Mistral AI | Instatus (Nuxt SSR) |
| Cohere API | Cohere | incident.io (Atlassian compat) |
| Groq Cloud | Groq | incident.io (Atlassian compat) |
| Together AI | Together | Better Stack RSS + uptime API |
| Fireworks AI | Fireworks | Better Stack RSS + uptime API |
| Cerebras Inference | Cerebras | Atlassian Statuspage (multi-component worst-of) |
| Perplexity | Perplexity AI | Instatus (Next.js SSR) |
| xAI (Grok) | xAI | RSS feed |
| DeepSeek API | DeepSeek | Flashduty (browser-rendered feed) |
| OpenRouter | OpenRouter | OnlineOrNot (React Router SSR) |
| Amazon Bedrock | AWS | AWS Health Dashboard |
| Azure OpenAI | Microsoft | Azure Status RSS |

### Coding Agents (6)

| Service | Provider |
|---------|----------|
| Claude Code | Anthropic |
| Codex | OpenAI |
| Cursor | Anysphere |
| GitHub Copilot | Microsoft |
| Windsurf | Codeium |
| Junie | JetBrains |

### Voice (3)

| Service | Provider | Status Source |
|---------|----------|---------------|
| ElevenLabs | ElevenLabs | incident.io (Atlassian compat) |
| AssemblyAI | AssemblyAI | Atlassian Statuspage |
| Deepgram | Deepgram | Atlassian Statuspage |

### Inference & Infra (8)

| Service | Provider | Status Source |
|---------|----------|---------------|
| Hugging Face | HuggingFace | Better Stack RSS + uptime API |
| Replicate | Replicate | incident.io (Atlassian compat) |
| fal.ai | fal | Instatus (Next.js) |
| Pinecone | Pinecone | Atlassian Statuspage |
| turbopuffer | turbopuffer | Atlassian Statuspage (no uptime, probe-based) |
| Voyage AI | Voyage AI | Atlassian Statuspage |
| Modal | Modal | Better Stack RSS + uptime API |
| Twelve Labs | Twelve Labs | Atlassian Statuspage |

### Observability (3)

| Service | Provider | Status Source |
|---------|----------|---------------|
| LangChain (LangSmith) | LangChain | Atlassian Statuspage (incident.io) |
| Helicone | Helicone | Better Stack RSS + uptime API |
| Langfuse | Langfuse | incident.io (Atlassian compat) |

### Video (2)

| Service | Provider | Status Source |
|---------|----------|---------------|
| Runway | Runway | Atlassian Statuspage |
| Luma (Dream Machine) | Luma | Better Stack RSS + uptime API |

### Image (2)

| Service | Provider | Status Source |
|---------|----------|---------------|
| Stability AI | Stability AI | Atlassian Statuspage |
| Black Forest Labs (FLUX) | Black Forest Labs | Atlassian Statuspage |

### AI Apps (4)

| Service | Provider |
|---------|----------|
| claude.ai | Anthropic |
| ChatGPT | OpenAI |
| Character.AI | Character AI |
| DeepSeek App | DeepSeek |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, Vite 6, TailwindCSS v4, Chart.js |
| Backend | Cloudflare Workers (TypeScript) |
| Cache | Cloudflare KV (status cache, latency snapshots) |
| Hosting | Vercel |
| Alerts | Discord Webhook (Worker proxy) · Slack via native `/feed` RSS · RSS feeds |
| Analytics | Google Analytics 4 (Consent Mode v2) |
| Tests | Playwright (E2E), Vitest (unit) |

## Architecture

```
Browser (React SPA, 60s polling)
  ↓
Cloudflare Worker
  ├── GET /api/status    → parallel fetch (43 services) → normalize
  ├── GET /api/uptime    → daily uptime history
  └── POST /api/alert   → Discord webhook proxy (SSRF protected)
  ↓
Parsers (worker/src/parsers/)
  ├── impact-weights.ts  → shared MAJOR_WEIGHT/MINOR_WEIGHT (Atlassian formula, used by both)
  ├── statuspage.ts      → Atlassian Statuspage API + uptimeData HTML (weighted official uptime)
  ├── incident-io.ts     → incident.io compat API + component_uptimes/impacts (estimate from durations uses the same weighted formula)
  ├── gcloud.ts          → Google Cloud incidents.json (Vertex Gemini)
  ├── aistudio.ts        → Google AI Studio + direct Gemini API (secondary source, merged with gcloud — #310)
  ├── instatus.ts        → Instatus Nuxt/Next.js SSR
  ├── betterstack.ts     → Better Stack RSS + /index.json uptime API + dailyImpact (status_history)
  └── aws.ts             → AWS Health events JSON API (Bedrock) + RSS (Azure OpenAI)
  ↓
Cloudflare KV
  ├── services:latest      (status cache, TTL 5min)
  ├── daily:YYYY-MM-DD     (uptime counters, TTL 2d)
  ├── history:YYYY-MM-DD   (archived counters, TTL 90d)
  ├── latency:24h          (30-min snapshots, max 48, TTL 25h)
  ├── probe:24h            (health check probes, max 2016, TTL 7d, 29 API services)
  ├── ai:analysis:{svcId}:{incId}  (AI per-incident analysis, TTL 1h, refreshed while active)
  ├── ai:reanalysis-skip:* (re-analysis failure cooldown, TTL 30min)
  ├── ai:usage:{date}      (daily AI usage counter, TTL 2d)
  ├── alerted:*            (alert dedup keys, TTL 2h-7d)
  ├── detected:{svcId}     (earliest detection timestamp, TTL 7d)
  ├── probe-degradation:daily:{svcId}:{date} (RTT degradation counter, TTL 48h, #464)
  ├── reddit:seen:{postId} (Reddit post dedup, TTL 24h)
  └── vitals:{YYYY-MM-DD}  (Web Vitals daily aggregation, TTL 2d)
```

## Getting Started

### Prerequisites

- Node.js 20+
- npm
- Cloudflare account (for Worker deployment)

### Frontend

```bash
git clone https://github.com/bentleypark/aiwatch.git
cd aiwatch
npm install
npm run dev        # localhost:5173
```

### Worker (Backend)

```bash
cd worker
npm install
# Create .dev.vars for local dev:
echo "ALLOWED_ORIGIN=*" > .dev.vars
npm run dev        # localhost:8787
```

### Environment Variables

**Frontend (.env)**
```
VITE_API_URL=http://localhost:8788/api/status
VITE_GA4_ID=                # Optional: Google Analytics measurement ID
```

**Worker (wrangler.toml + secrets)**
```
ALLOWED_ORIGIN=https://your-domain.com
DISCORD_WEBHOOK_URL=        # Worker Secret: Discord webhook for alerts
ANTHROPIC_API_KEY=          # Worker Secret: Claude Sonnet API key (AI Analysis fallback)
```

## Scripts

```bash
# Frontend
npm run dev          # Dev server (localhost:5173)
npm run dev:worker   # Worker dev server (localhost:8788)
npm run dev:all      # Both simultaneously
npm run build        # Production build → dist/
npm run lint         # ESLint
npm test             # Playwright E2E tests
npm run test:worker  # Worker unit tests (vitest)

# Worker deployment
npm run deploy:worker  # Deploy to Cloudflare (use npm script only)
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | All service statuses + incidents + uptime + latency24h + aiAnalysis |
| `/api/status/cached` | GET | KV-only cached status (for Edge SSR, fast ~1.2s) |
| `/api/uptime?days=30` | GET | Daily uptime history (1-90 days) |
| `/api/report?month=YYYY-MM` | GET | Monthly reliability archive (uptime, score, incidents, latency) |
| `/api/alert` | POST | Discord webhook proxy (SSRF protected) |
| `/badge/:serviceId` | GET | SVG status badge (shields.io style) |
| `/api/og` | GET | Dynamic OG image PNG (1200×630, resvg-wasm) |
| `/api/v1/status` | GET | Public API — all services (lightweight, CORS `*`) |
| `/api/v1/status/:id` | GET | Public API — single service + top 5 incidents |

## Public API (v1)

Open API for external developers. No authentication required. Rate limited to 60 req/min.

**All services:**
```bash
curl https://aiwatch-worker.p2c2kbf.workers.dev/api/v1/status
```

**Single service:**
```bash
curl https://aiwatch-worker.p2c2kbf.workers.dev/api/v1/status/claude
```

Response includes: `id`, `name`, `provider`, `category`, `status`, `latency`, `uptime30d`, `uptimeSource`, `lastChecked`, and up to 5 recent incidents (single service only).

## Status Badges

Embed real-time status badges in your README, docs, or blog.

```markdown
[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/is-claude-down)
```

[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/is-claude-down)

### Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `uptime` | Show uptime % | `/badge/claude?uptime=true` |
| `style` | `flat` or `flat-square` | `/badge/claude?style=flat-square` |
| `label` | Custom label | `/badge/claude?label=My+API` |

### Examples

[![OpenAI API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/openai)](https://ai-watch.dev/is-openai-down)
[![Gemini API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/gemini)](https://ai-watch.dev/is-gemini-down)
[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude?uptime=true)](https://ai-watch.dev/is-claude-down)
[![Cursor](https://aiwatch-worker.p2c2kbf.workers.dev/badge/cursor?style=flat-square)](https://ai-watch.dev/is-cursor-down)

### Available Service IDs

| ID | Service | ID | Service |
|----|---------|----|---------|
| `claude` | Claude API | `claudeai` | claude.ai |
| `openai` | OpenAI API | `chatgpt` | ChatGPT |
| `gemini` | Gemini API | `claudecode` | Claude Code |
| `mistral` | Mistral API | `copilot` | GitHub Copilot |
| `cohere` | Cohere API | `cursor` | Cursor |
| `groq` | Groq Cloud | `windsurf` | Windsurf |
| `together` | Together AI | `junie` | Junie |
| `fireworks` | Fireworks AI | `deepseek` | DeepSeek API |
| `perplexity` | Perplexity | `xai` | xAI (Grok) |
| `huggingface` | Hugging Face | `replicate` | Replicate |
| `elevenlabs` | ElevenLabs | `openrouter` | OpenRouter |
| `bedrock` | Amazon Bedrock | `pinecone` | Pinecone |
| `azureopenai` | Azure OpenAI | `stability` | Stability AI |
| `assemblyai` | AssemblyAI | `deepgram` | Deepgram |
| `characterai` | Character.AI | `modal` | Modal |
| `voyageai` | Voyage AI | `codex` | Codex |
| `cerebras` | Cerebras Inference | `fal` | fal.ai |

## Claude Code Statusline Integration

Surface AI service outages — Claude API, OpenAI, Gemini, GitHub Copilot, and 36 more — directly in your [Claude Code statusline](https://docs.claude.com/en/docs/claude-code/statusline). The recommended preset keeps an always-on, clickable **AIWatch** label (`AIWatch 🟢` while all healthy, `AIWatch 🔴 Claude API` when something breaks — cmd/ctrl+click opens the dashboard). Prefer zero footprint when healthy? A minimalist preset that stays empty until something degrades is on the [presets page](https://ai-watch.dev/#statusline).

Quickest install — add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "( curl -sf --max-time 2 https://aiwatch-worker.p2c2kbf.workers.dev/api/status/cached?src=statusline-branded | jq -r '([.services[] | select(.status != \"operational\")]) as $d | \"\\u001b]8;;https://ai-watch.dev\\u001b\\\\AIWatch\\u001b]8;;\\u001b\\\\ \" + (if ($d | length) == 0 then \"🟢\" else ([$d[] | \"\\u001b]8;;https://ai-watch.dev/#\\(.id)\\u001b\\\\🔴 \\(.name)\\u001b]8;;\\u001b\\\\\"] | .[0:3] | join(\" \")) end)' ) 2>/dev/null || true"
  }
}
```

> Requires an OSC 8-compatible terminal (iTerm2, Warp, kitty, WezTerm, VS Code terminal, Terminal.app on macOS 12+) for the clickable label; others show it as plain text. Targets the Worker domain directly so per-prompt polls don't count as Vercel bandwidth.

Other presets — **minimalist** (empty when healthy), compact badge, full list, scoped to specific providers, and clickable per-service links: **[ai-watch.dev/#statusline](https://ai-watch.dev/#statusline)**

Properties: single GET per render, 5-min KV-cached on Cloudflare's edge, 2-second timeout, fail-silent on network error, no Anthropic API requests, no client identifier. The `?src=statusline-<preset>` query tag just lets us split statusline traffic from regular cached-endpoint hits in request logs — Worker matches on path only, so it doesn't affect caching or freshness, and carries no user identifier. Compatible with any statusline tool that supports shell-command output (including `ccstatusline`'s Custom Command widget).

## Project Structure

```
src/
  components/    # Shared UI: StatusPill, SkeletonUI, EmptyState, Modal, Sidebar, Topbar, CookieBanner, InstallBanner
  pages/         # Overview, Latency, Incidents, Uptime, ServiceDetails, Settings, Ranking, Statusline
  hooks/         # usePolling, useTheme, useLang, useSettings
  utils/         # analytics, calendar, time, pageContext, constants
  locales/       # ko.js, en.js (flat key→string maps)
api/
  intro.ts             # Vercel Edge Function — landing page (/intro)
  intro/
    html-template.ts   # Landing page SSR template (i18n, dashboard mock, GA4)
  is-down.ts           # Vercel Edge Function — "Is X Down?" SSR pages (40 services)
  is-down/
    slug-map.ts        # URL slug ↔ service ID mapping
    seo-content.ts     # Per-service SEO text + FAQ
    html-template.ts   # SSR HTML rendering + share buttons + dynamic OG meta
public/
  manifest.json        # PWA manifest
  sw.js                # Service Worker (stale-while-revalidate)
  icon-192.png         # PWA icon 192x192
  icon-512.png         # PWA icon 512x512
scripts/
  generate-og-intro.mjs  # OG intro image generator (node scripts/generate-og-intro.mjs)
worker/
  src/
    index.ts     # Worker entry: CORS, KV cache, alerts, routing, /api/alert, /badge, /api/v1
    services.ts  # Service configs + fetch orchestrator
    types.ts     # Shared types (ServiceStatus, Incident, etc.)
    utils.ts     # Shared utilities (formatDuration, fetchWithTimeout)
    score.ts     # AIWatch Score calculation
    badge.ts     # SVG badge generator
    rss.ts       # Incident RSS 2.0 feed (/feed.xml + /feed/:slug)
    og.ts        # OG image SVG generator (1200×630)
    og-render.ts # SVG → PNG conversion (resvg-wasm)
    alerts.ts    # Alert detection logic (incident + service alerts)
    fallback.ts  # Fallback recommendation
    ai-analysis.ts # Hybrid AI incident analysis (Gemma 4 primary + Sonnet fallback)
    changelog.ts # Changelog/news collection (OpenAI RSS, Google RSS, Anthropic HTML)
    weekly-briefing.ts # Weekly Discord briefing (changelog + incidents + stability)
    security-monitor.ts # AI service security monitoring (HN Algolia, OSV.dev SDK vulnerabilities — 24 tracked packages)
    daily-summary.ts # Daily Discord report (uptime, latency, AI usage)
    monthly-archive.ts # Monthly reliability archive (permanent KV)
    vitals.ts    # Web Vitals aggregation (p75, Discord formatting)
    probe.ts     # Health check probing — direct RTT measurement
    probe-archival.ts # Daily probe RTT archival + 7-day summary
    platform-monitor.ts # Status page platform health monitoring (metastatuspage.com)
    detection.ts # First-detection (`detected:{svcId}`) entry parsing + reset logic — feeds MTTD + the #677 AWS incident-start anchor
    reddit.ts    # Reddit outage chatter monitoring
    parsers/     # Platform-specific parsers
      statuspage.ts   # Atlassian Statuspage (7 services)
      incident-io.ts  # incident.io (6 services)
      gcloud.ts       # Google Cloud Vertex (gemini primary source)
      aistudio.ts     # Google AI Studio + direct Gemini API (gemini secondary, #310)
      instatus.ts     # Instatus (2 services)
      betterstack.ts  # Better Stack (4 services)
      onlineornot.ts  # OnlineOrNot (1 service — OpenRouter)
      aws.ts          # AWS Health events JSON API — Bedrock (+ RSS parser reused for Azure OpenAI)
    parsers/__tests__/ # Vitest unit tests
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

If you are using a non-Claude coding agent, start with [AGENTS.md](AGENTS.md). Claude Code
contributors should also read [CLAUDE.md](CLAUDE.md) for the repo-specific workflow and automation
rules.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Follow the shared workflow in [AGENTS.md](AGENTS.md); Claude Code contributors should also
   follow [CLAUDE.md](CLAUDE.md)
4. Build + test: `npm run build && npm test && npm run test:worker`
5. Submit a pull request using the [PR template](.github/pull_request_template.md)

### Issues

- **Bug reports**: Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) template
- **Feature requests**: Use the [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) template

### Pull Requests

- One feature or fix per PR
- All tests must pass (`npm test` + `npm run test:worker`)
- Include `closes #N` in commit messages
- Fill out the PR checklist

## Security

Found a vulnerability? Please report it responsibly — see [SECURITY.md](SECURITY.md) for details.

## License

[AGPL-3.0](LICENSE)

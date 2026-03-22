# AIWatch

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Deploy](https://img.shields.io/badge/Deploy-ai--watch.dev-blue)](https://ai-watch.dev)
[![GitHub stars](https://img.shields.io/github/stars/bentleypark/aiwatch)](https://github.com/bentleypark/aiwatch/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/bentleypark/aiwatch)](https://github.com/bentleypark/aiwatch/commits/main)

[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/#claude)
[![OpenAI API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/openai)](https://ai-watch.dev/#openai)
[![Gemini API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/gemini)](https://ai-watch.dev/#gemini)
[![GitHub Copilot](https://aiwatch-worker.p2c2kbf.workers.dev/badge/copilot)](https://ai-watch.dev/#copilot)

**English** | [한국어](README.ko.md)

Real-time monitoring dashboard for **19 AI services** — track status, latency, uptime, and incidents across major AI providers.

**[https://ai-watch.dev](https://ai-watch.dev)**

![AIWatch Dashboard](docs/screenshot.png)

## Features

- **Real-time status** — Operational / Degraded / Down for 19 AI services
- **Latency monitoring** — Status page response time per API service
- **24h latency trend** — Chart.js line chart with 30-min snapshots
- **Incident history** — Timeline with details from multiple status page formats
- **Official uptime** — Per-component uptime from Statuspage, incident.io, Better Stack
- **Status calendar** — 30-day (Statuspage) or 14-day (incident.io) daily status visualization
- **Slack/Discord alerts** — Webhook notifications on status changes and incidents
- **Cookie consent** — GA4 Consent Mode v2 with accept/essential-only
- **Deep links** — Hash-based routing (`#claude`, `#latency`) for direct page access
- **Dark/Light theme** — System-aware with manual toggle
- **Bilingual** — Korean / English
- **Mobile responsive** — Sidebar overlay, mobile action bar
- **AIWatch Score** — Composite reliability score ([how it works](https://ai-watch.dev/#about-score))
- **Page-specific skeletons** — Loading placeholders matched to each page layout

## Monitored Services

### AI API Services (13)

| Service | Provider | Status Source |
|---------|----------|---------------|
| Claude API | Anthropic | Atlassian Statuspage |
| OpenAI API | OpenAI | incident.io (Atlassian compat) |
| Gemini API | Google | Google Cloud incidents.json |
| Mistral API | Mistral AI | Instatus (Nuxt SSR) |
| Cohere API | Cohere | incident.io (Atlassian compat) |
| Groq Cloud | Groq | incident.io (Atlassian compat) |
| Together AI | Together | Better Stack RSS + uptime API |
| Perplexity | Perplexity AI | Instatus (Next.js SSR) |
| Hugging Face | HuggingFace | Better Stack RSS + uptime API |
| Replicate | Replicate | incident.io (Atlassian compat) |
| ElevenLabs | ElevenLabs | incident.io (Atlassian compat) |
| xAI (Grok) | xAI | RSS feed |
| DeepSeek API | DeepSeek | Atlassian Statuspage |

### AI Web Apps (2)

| Service | Provider |
|---------|----------|
| claude.ai | Anthropic |
| ChatGPT | OpenAI |

### Coding Agents (4)

| Service | Provider |
|---------|----------|
| Claude Code | Anthropic |
| GitHub Copilot | Microsoft |
| Cursor | Anysphere |
| Windsurf | Codeium |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, Vite 6, TailwindCSS v4, Chart.js |
| Backend | Cloudflare Workers (TypeScript) |
| Cache | Cloudflare KV (status cache, latency snapshots) |
| Hosting | Vercel |
| Alerts | Discord/Slack Webhook (Worker proxy) |
| Analytics | Google Analytics 4 (Consent Mode v2) |
| Tests | Playwright (E2E), Vitest (unit) |

## Architecture

```
Browser (React SPA, 60s polling)
  ↓
Cloudflare Worker
  ├── GET /api/status    → parallel fetch (19 services) → normalize
  ├── GET /api/uptime    → daily uptime history
  └── POST /api/alert   → webhook proxy (Slack/Discord, SSRF protected)
  ↓
Parsers (worker/src/parsers/)
  ├── statuspage.ts      → Atlassian Statuspage API + uptimeData HTML
  ├── incident-io.ts     → incident.io compat API + component_uptimes/impacts
  ├── gcloud.ts          → Google Cloud incidents.json
  ├── instatus.ts        → Instatus Nuxt/Next.js SSR
  └── betterstack.ts     → Better Stack RSS + /index.json uptime API
  ↓
Cloudflare KV
  ├── services:latest    (status cache, TTL 5min)
  ├── daily:YYYY-MM-DD   (uptime counters, TTL 2d)
  ├── history:YYYY-MM-DD (archived counters, TTL 90d)
  └── latency:24h        (30-min snapshots, max 48, TTL 25h)
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
```

## Scripts

```bash
# Frontend
npm run dev          # Dev server (localhost:5173)
npm run dev:worker   # Worker dev server (localhost:8788)
npm run dev:all      # Both simultaneously
npm run build        # Production build → dist/
npm run lint         # ESLint
npm test             # Playwright E2E tests (27 specs)
npm run test:worker  # Worker parser unit tests (65 specs, vitest)

# Worker deployment
npm run deploy:worker  # Deploy to Cloudflare (use npm script only)
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | All service statuses + incidents + uptime + latency24h |
| `/api/uptime?days=30` | GET | Daily uptime history (1-90 days) |
| `/api/alert` | POST | Webhook proxy (Slack/Discord only, SSRF protected) |
| `/badge/:serviceId` | GET | SVG status badge (shields.io style) |
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
[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/#claude)
```

[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/#claude)

### Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `uptime` | Show uptime % | `/badge/claude?uptime=true` |
| `style` | `flat` or `flat-square` | `/badge/claude?style=flat-square` |
| `label` | Custom label | `/badge/claude?label=My+API` |

### Examples

[![OpenAI API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/openai)](https://ai-watch.dev/#openai)
[![Gemini API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/gemini)](https://ai-watch.dev/#gemini)
[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude?uptime=true)](https://ai-watch.dev/#claude)
[![Cursor](https://aiwatch-worker.p2c2kbf.workers.dev/badge/cursor?style=flat-square)](https://ai-watch.dev/#cursor)

### Available Service IDs

| ID | Service | ID | Service |
|----|---------|----|---------|
| `claude` | Claude API | `claudeai` | claude.ai |
| `openai` | OpenAI API | `chatgpt` | ChatGPT |
| `gemini` | Gemini API | `claudecode` | Claude Code |
| `mistral` | Mistral API | `copilot` | GitHub Copilot |
| `cohere` | Cohere API | `cursor` | Cursor |
| `groq` | Groq Cloud | `windsurf` | Windsurf |
| `together` | Together AI | `deepseek` | DeepSeek API |
| `perplexity` | Perplexity | `xai` | xAI (Grok) |
| `huggingface` | Hugging Face | `replicate` | Replicate |
| `elevenlabs` | ElevenLabs | | |

## Project Structure

```
src/
  components/    # Shared UI: StatusPill, SkeletonUI, EmptyState, Modal, Sidebar, Topbar, CookieBanner
  pages/         # Overview, Latency, Incidents, Uptime, ServiceDetails, Settings, AboutScore, Ranking
  hooks/         # usePolling, useTheme, useLang, useSettings
  utils/         # analytics, calendar, time, pageContext, constants
  locales/       # ko.js, en.js (flat key→string maps)
worker/
  src/
    index.ts     # Worker entry: CORS, KV cache, alerts, routing, /api/alert, /badge, /api/v1
    services.ts  # Service configs + fetch orchestrator
    types.ts     # Shared types (ServiceStatus, Incident, etc.)
    utils.ts     # Shared utilities (formatDuration, fetchWithTimeout)
    score.ts     # AIWatch Score calculation
    badge.ts     # SVG badge generator
    parsers/     # Platform-specific parsers
      statuspage.ts   # Atlassian Statuspage (7 services)
      incident-io.ts  # incident.io (6 services)
      gcloud.ts       # Google Cloud (1 service)
      instatus.ts     # Instatus (2 services)
      betterstack.ts  # Better Stack (3 services)
    parsers/__tests__/ # Vitest unit tests (65 specs)
```

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for detailed guidelines.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Follow the development workflow in [CLAUDE.md](CLAUDE.md)
4. Build + test: `npm run build && npm test && npm run test:worker`
5. Submit a pull request using the [PR template](.github/pull_request_template.md)

### Issues

- **Bug reports**: Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) template
- **Feature requests**: Use the [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) template

### Pull Requests

- One feature or fix per PR
- All tests must pass (27 E2E + 65 unit = 92 specs)
- Include `closes #N` in commit messages
- Fill out the PR checklist

## License

[AGPL-3.0](LICENSE)

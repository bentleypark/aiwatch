# AIWatch

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Deploy](https://img.shields.io/badge/Deploy-ai--watch.dev-blue)](https://ai-watch.dev)

Real-time monitoring dashboard for **19 AI services** — track status, latency, uptime, and incidents across major AI providers.

**[https://ai-watch.dev](https://ai-watch.dev)**

## Features

- **Real-time status** — Operational / Degraded / Down for 19 AI services
- **Latency monitoring** — Status page response time per API service
- **Incident history** — Timeline with details from multiple status page formats
- **Uptime tracking** — Daily counters accumulated via Cloudflare KV
- **Discord alerts** — Automatic notifications on service outages
- **Dark/Light theme** — System-aware with manual toggle
- **Bilingual** — Korean / English
- **Mobile responsive** — Sidebar overlay, mobile action bar

## Monitored Services

### AI API Services (13)

| Service | Provider | Status Source |
|---------|----------|---------------|
| Claude API | Anthropic | Atlassian Statuspage |
| OpenAI API | OpenAI | Atlassian Statuspage |
| Gemini API | Google | Google Cloud incidents.json |
| Mistral API | Mistral AI | Instatus (Nuxt SSR) |
| Cohere API | Cohere | Atlassian Statuspage |
| Groq Cloud | Groq | Atlassian Statuspage |
| Together AI | Together | Better Stack RSS |
| Perplexity | Perplexity AI | HTTP check |
| Hugging Face | HuggingFace | Better Stack RSS |
| Replicate | Replicate | Atlassian Statuspage |
| ElevenLabs | ElevenLabs | Atlassian Statuspage |
| xAI (Grok) | xAI | HTTP check |
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
| Frontend | React 19, Vite 6, TailwindCSS v4 |
| Backend | Cloudflare Workers (TypeScript) |
| Cache | Cloudflare KV (uptime counters, status cache) |
| Hosting | Vercel |
| Alerts | Discord Webhook |
| Analytics | Google Analytics 4 |

## Architecture

```
Browser (React SPA)
  ↓ polling (60s)
Cloudflare Worker (/api/status)
  ↓ parallel fetch (19 services)
  ├── Atlassian Statuspage API (summary.json + incidents.json)
  ├── Google Cloud incidents.json
  ├── Instatus Nuxt SSR scraping
  ├── Better Stack RSS feed parsing
  └── HTTP reachability check
  ↓
Cloudflare KV
  ├── services:latest (status cache, TTL 1h)
  ├── daily:YYYY-MM-DD (uptime counters, TTL 2d)
  └── history:YYYY-MM-DD (archived counters, TTL 90d)
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
VITE_API_URL=http://localhost:8787/api/status
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
npm run dev        # Dev server (localhost:5173)
npm run build      # Production build → dist/
npm run preview    # Preview production build
npm run lint       # ESLint
npm test           # Playwright E2E tests (13 specs)

# Worker
cd worker
npm run dev        # Local Worker (localhost:8787)
npm run deploy     # Deploy to Cloudflare
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | All service statuses + incidents + uptime |
| `GET /api/uptime?days=30` | Daily uptime history (1-90 days) |

## Project Structure

```
src/
  components/    # Shared UI: StatusPill, SkeletonUI, EmptyState, Modal, Sidebar, Topbar
  pages/         # Overview, Latency, Incidents, Uptime, ServiceDetails, Settings
  hooks/         # usePolling, useTheme, useLang, useSettings
  utils/         # analytics, calendar, time, pageContext, constants
  locales/       # ko.js, en.js (flat key→string maps)
worker/
  src/
    index.ts     # Worker entry: CORS, KV cache, Discord alerts, routing
    services.ts  # Service configs, status fetching, parsers (Statuspage/Instatus/GCloud/RSS)
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Follow the development workflow in [CLAUDE.md](CLAUDE.md)
4. Run tests (`npm test`)
5. Submit a pull request

## License

[MIT](LICENSE)

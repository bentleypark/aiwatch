# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start frontend dev server (localhost:5173)
npm run dev:worker # Start Worker dev server (localhost:8788)
npm run dev:all    # Start both simultaneously
npm run build      # Production build → dist/
npm run preview    # Preview production build
npm run lint       # Run ESLint
```

```bash
npm test           # Run Playwright E2E tests
npm run test:worker # Run Worker unit tests (vitest)
```

## Development Workflow

> **IMPORTANT**: Always re-read this section before starting any task. Never skip code review (step 4) or tests (step 3).

### Per-issue process (follow this order every time)

0. **Review rules** — Re-read this Development Workflow section and follow each step in order
1. **Design check** (UI issues only) — before coding, compare `docs/AIWatch_화면디자인_초안.html` with the current implementation:
   - Open design mockup in browser and take screenshots of the relevant area
   - Identify **every** difference (spacing, colors, fonts, layout, icons, text)
   - List differences explicitly before writing any code
2. **Code** — implement the feature or fix
2.5. **Local verify** — start dev server (`npm run dev`) and let the user confirm in browser before proceeding. For Worker changes, also start `npx wrangler dev`. Never skip this step.
3. **Build + Test** — based on change scope:
   - **Frontend changes** (`src/`): `npm run build` + `npm test` (Playwright)
   - **Backend changes** (`worker/`): `npx wrangler deploy --config worker/wrangler.toml --dry-run` + `npm run test:worker` (Vitest)
   - **Both**: run all of the above
   - **Worker logic additions**: new functions must have unit tests — extract to separate files with exports, test in `worker/src/__tests__/` or `worker/src/parsers/__tests__/`
   - **Bug fixes**: every bug fix must include a test that would have caught the bug — E2E (Playwright) for frontend, Vitest for worker
4. **Review** — run PR review **before** committing:
   ```
   /pr-review-toolkit:review-pr
   ```
5. **Fix review issues** — address all **Critical** and **Important** findings. Re-run Build + Test after fixes
6. **Docs update** — update documentation affected by the change:
   - `CLAUDE.md`: architecture, service count, directory layout, constraints
   - `README.md` / `README.ko.md`: features, service tables, Project Structure, Available Service IDs
   - `.github/CONTRIBUTING.md`: Project Structure
   - `index.html`: SEO meta tags (service count, description)
   - `aiwatch-reports/`: service count, category breakdown (if applicable)
7. **Commit** — only after review issues are fixed and tests pass. Include `closes #N` in the message so GitHub links the commit
8. **Verify checklist** — read the issue (`gh issue view N`) and confirm every checklist item (`- [ ]`) is actually implemented in code before closing
9. **Close** — only close the issue after checklist verification: `gh issue close N`

> Never close an issue immediately after committing. Always re-read the issue checklist and verify each item against the code first.

### Debugging rules
- Before writing any fix, read all relevant code and identify the root cause
- Propose ONE fix approach with reasoning — do not shotgun multiple approaches
- Wait for user confirmation before implementing the fix

## Architecture

**AIWatch** is a React SPA that monitors 25 AI services in real time:
- **18 API services**: Claude, OpenAI, Gemini, Mistral, Cohere, Groq, Together, Perplexity, HuggingFace, Replicate, ElevenLabs, xAI, DeepSeek, OpenRouter, Bedrock, Azure OpenAI, Pinecone, Stability AI
- **3 AI web apps**: claude.ai, ChatGPT, Character.AI
- **4 coding agents**: Claude Code, GitHub Copilot, Cursor, Windsurf

### Tech Stack
- **React 19 + Vite 6** — SPA, no router library
- **TailwindCSS v4** — utility classes + CSS custom properties for design tokens (see below)
- **Cloudflare Workers** — status polling proxy with KV cache
- **Cloudflare KV** — daily uptime counters, status cache, history archival

### KV Key Schema (STATUS_CACHE namespace)

| Key Pattern | Value | TTL | Writes/Day | Purpose |
|---|---|---|---|---|
| `services:latest` | `{ services, cachedAt }` JSON | 5min | ~288 | Real-time status cache (all 25 services) |
| `daily:{YYYY-MM-DD}` | `{ [svcId]: { ok, total } }` JSON | 2d | ~288 | Daily uptime counters |
| `history:{YYYY-MM-DD}` | Same as daily | 90d | 1 | Archived yesterday's counters |
| `latency:24h` | `{ snapshots: [{ t, data }] }` JSON | 25h | ~48 | 30-min latency snapshots (max 48) |
| `probe:24h` | `{ snapshots: [{ t, data }] }` JSON | 72h | ~288 | 5-min health check probe results (max 864, Gemini + Mistral) |
| `alerted:new:{incId}` | `"1"` | 7d | ~5 | Incident alert dedup |
| `alerted:res:{incId}` | `"1"` | 7d | ~2 | Resolved incident alert dedup |
| `alerted:down:{svcId}` | ISO timestamp | 2h | ~2 | Service down alert dedup + recovery duration |
| `alerted:degraded:{svcId}` | ISO timestamp | 2h | ~2 | Service degraded alert dedup |
| `alerted:recovered:{svcId}` | `"1"` | 2h | ~2 | Recovery alert dedup |
| `pending:degraded:{svcId}` | `"1"` | 10min | ~5 | Anti-flapping: 2-cycle consecutive detection |
| `detected:{svcId}` | ISO timestamp | 7d | ~5 | Detection Lead: earliest detection time |
| `reddit:seen:{postId}` | `"1"` | 24h | ~72 | Reddit post dedup (hourly scan) |
| `ai:analysis:{svcId}` | `AIAnalysisResult` JSON | 1h | ~5 | Claude Sonnet incident analysis result (TTL refreshed while active) |
| `ai:reanalysis-skip:{svcId}` | `"1"` | 30min | ~2 | Re-analysis failure cooldown |
| `ai:usage:{YYYY-MM-DD}` | `{ calls, success, failed }` JSON | 2d | ~5 | Daily AI analysis usage counter (includes re-analysis) |
| `kv_limit_alert` | `"1"` | 5min | ~1 | KV write limit exceeded cooldown |

**Free tier budget**: 1,000 writes/day. Estimated total: ~810-920 writes/day (within budget).

### Directory Layout
```
src/
  components/   # Shared UI: StatusPill, SkeletonUI, EmptyState, Modal, Sidebar, Topbar, CookieBanner, AnalysisModal
  pages/        # Overview, Latency, Incidents, Uptime, ServiceDetails, Settings, AboutScore, Ranking
  hooks/        # usePolling, useTheme, useLang, useSettings, useGitHubStars
  utils/        # analytics, calendar, time, pageContext, constants
  locales/      # ko.js, en.js — flat key→string maps (default exports)
worker/
  src/
    index.ts    # Worker entry: CORS, KV, routing, /api/alert, /badge, /api/v1, Cron scheduled handler
    services.ts # Service configs + fetch orchestrator
    types.ts    # Shared types (ServiceStatus, Incident, etc.)
    utils.ts    # Shared utilities (formatDuration, fetchWithTimeout, sanitize)
    score.ts    # AIWatch Score calculation
    badge.ts    # SVG badge generator
    og.ts       # OG image SVG generator (1200×630 for social share)
    og-render.ts # SVG → PNG conversion (resvg-wasm, Inter font from CDN)
    alerts.ts   # Alert detection logic (buildIncidentAlerts, buildServiceAlerts)
    fallback.ts # Fallback recommendation (getFallbacks, buildFallbackText)
    ai-analysis.ts # Claude Sonnet incident analysis (system/user prompt separation, similar incident matching)
    daily-summary.ts # Expanded daily Discord report (uptime, latency, AI usage, Reddit)
    probe.ts    # Health check probing — direct RTT measurement (Phase 2 PoC)
    parsers/    # Platform-specific parsers (statuspage, incident-io, gcloud, instatus, betterstack, aws)
                # dailyImpact support: statuspage (uptimeData), incident-io (component impacts), betterstack (status_history from index.json)
```

### Design System
All colors are CSS custom properties defined in `src/index.css`. **Never use hardcoded hex values** — always reference tokens:

| Token | Purpose |
|---|---|
| `--bg0…--bg4` | Background layers (darkest → lighter) |
| `--green / --amber / --red` | Operational / Degraded / Down |
| `--yellow` | Warning / Score fair |
| `--purple` | AI Analysis accent |
| `--blue / --teal` | Informational |
| `--text0…--text2` | Primary → muted text |
| `--border / --border-hi` | Subtle / prominent borders |

Theme switching: add `data-theme="light"` to `<html>` — CSS variables remap automatically. Default is dark.

### i18n
`src/locales/ko.js` and `en.js` export flat `{ 'dot.key': 'string' }` maps (default exports).

### GA4 Analytics Events
All events use `trackEvent()` from `src/utils/analytics.js`. GA4 is only active when user consents via cookie banner.

| Event | Parameters | Location | Purpose |
|---|---|---|---|
| `page_view` | `page_title`, `service_id?` | App.jsx | SPA page transition |
| `select_service` | `service_id` | Overview (card click) | Service card click |
| `view_service` | `service_id` | Sidebar (service list) | Sidebar service click |
| `view_incident` | `incident_id` | Incidents page | Incident detail open |
| `fallback_click` | `from_service`, `to_service`, `location` | ActionBanner, Is X Down | Fallback recommendation click |
| `change_filter` | `filter` | Overview (filter tabs) | Status filter change |
| `category_filter` | `category` | Sidebar (category) | Category filter change |
| `navigate_page` | `page` | Sidebar (nav) | Page navigation |
| `click_refresh` | — | Topbar | Manual refresh |
| `click_github_header` | — | Topbar | GitHub link click |
| `click_analyze` | `has_analysis?`, `count?` | Topbar | Analyze button click (active: has_analysis=true + count, inactive: no params) |
| `open_legal` | `type` (privacy/terms) | Footer | Legal modal open |
| `save_settings` | — | Settings | Settings saved |
| `webhook_register` | `type` (discord/slack) | Settings | Webhook URL added |
| `webhook_remove` | `type` (discord/slack) | Settings | Webhook URL removed |
| `region_switch_intent` | `service_id`, `recommended_region` | ServiceDetails (Regional) | Region guide link click |
| `click_reports` | — | Sidebar | Monthly reports link click |
| `share` | `method` (x/threads/kakao/copy), `item_id` | Is X Down (share buttons) | Social share button click |
| `click_dashboard` | `location`, `source` | Is X Down (header/footer) | Dashboard link click |
| `click_cta_alerts` | `location`, `source?` | Is X Down (CTA/footer) | Set Up Alerts click |
| `click_ranking` | `location`, `source` | Is X Down (header/alternatives) | Ranking link click |
| `click_service_detail` | `location`, `service_id` | Is X Down (footer) | Service detail page click |
| `click_reports` | `location`, `source` | Is X Down (alternatives/footer) | Monthly reports link click (Is X Down) |

Is X Down pages (Edge SSR) use inline `gtag()` calls directly since they don't use React.

**Reports site** (`reports.ai-watch.dev`) uses the same GA4 ID (`G-D4ZWVHQ7JK`) with event delegation in `_includes/footer.html`:

| Event | Parameters | Trigger | Purpose |
|---|---|---|---|
| `click_dashboard` | `location: reports_site`, `source: footer/body` | ai-watch.dev link click | Dashboard navigation from reports |
| `click_report` | `location: reports_site`, `report_month: YYYY-MM` | Monthly report link click | Report page view intent |

### Status Data Flow
```
Browser (React SPA, 60s polling)
  → Cloudflare Worker (/api/status)
    → parallel fetch (25 services)
    → normalize to ServiceStatus[]
    → write to KV (cache + daily counters)
  → React state (usePolling hook via PollingContext)
  → all pages read from context

Cron Trigger (*/5 min)
  → health check probing (direct RTT to API endpoints, stored in probe:24h)
  → read KV cache → detect incidents/status changes
  → record detection timestamps (detected:{serviceId}) for Detection Lead
  → KV ID-based dedup → Discord alerts
  → incident detected → Claude Sonnet analysis → KV (ai:analysis:{svcId}) + Discord 🤖 embed
  → recovery detected → delete ai:analysis:{svcId}
  → daily summary at UTC 09:00 (KST 18:00)
```

### SPA Navigation
No React Router. Hash-based routing in `App.jsx` — `#claude` for service details, `#latency` for pages. `PageContext` shares current page state. Browser back/forward supported via `popstate` listener.

### Key Product Constraints
- Mobile breakpoint: 768px — sidebar hidden (overlay on hamburger), cards go 1-column
- Phase 3 AI Analysis (Beta): Claude Sonnet auto-analysis on incidents — triggered by cron, stored in KV, shown in Topbar Analyze modal + Is X Down AI Insight card. Requires `ANTHROPIC_API_KEY` Worker secret
- Status polling proxy: `worker/` directory (monorepo), Cloudflare Workers
  - `cd worker && npm run dev` — local dev (port 8787)
  - **Worker deployment rules** (KV free tier: 1,000 writes/day):
    1. During development → `npx wrangler dev --config worker/wrangler.toml --port 8788` (local test only, never deploy)
    2. Before deploy → `npx wrangler deploy --config worker/wrangler.toml --dry-run` (build check)
    3. Deploy → after commit + user approval, **once only** `npm run deploy:worker`
    4. No repeated deploys — each Worker deployment resets the isolate, resetting KV write throttle
  - **IMPORTANT**: Always use the npm script to deploy the worker — never run `wrangler deploy` or `cd worker && wrangler deploy` directly (both pick up the wrong config and deploy the SPA):
    ```
    npm run deploy:worker
    ```
  - Verify the output says `Uploaded aiwatch-worker` (not `aiwatch`)
  - Endpoints: `GET /api/status`, `GET /api/status/cached` (KV-only, for SSR), `GET /api/uptime?days=30`, `POST /api/alert`, `GET /badge/:serviceId`, `GET /api/og` (dynamic OG image PNG), `GET /api/v1/status`
  - **Cron Trigger**: `*/5 * * * *` — alert detection runs every 5 minutes via scheduled handler (not per-request). Uses KV ID-based dedup (`alerted:new/res:` keys 7d TTL, `alerted:down/degraded/recovered:` keys 2h TTL). Fallback recommendations only included when service status is degraded/down (not operational). AI analysis runs after alerts (non-blocking), results stored in `ai:analysis:{svcId}` (1h TTL)
- **Frontend deployment**: Vercel, domain ai-watch.dev — `git push origin main` triggers auto-deploy. `npm run build` is local only; changes are not live until pushed
- **PWA**: `public/manifest.json` + `public/sw.js` (stale-while-revalidate). CACHE_NAME in `sw.js` must be bumped manually when static assets change. SW excludes `/is-*` (Edge SSR) and `/api/*` (real-time data) from caching
- **Edge SSR**: `api/is-down.ts` serves "Is X Down?" SEO pages (8 services: claude, chatgpt, gemini, github-copilot, cursor, claude-code, openai, windsurf) via Vercel Edge Functions. Uses `/api/status/cached` (KV-only) for fast SSR (~1.2s). Dynamic OG image via Worker `/api/og` (PNG, resvg-wasm). Share buttons: X, Threads, KakaoTalk (SDK async), Copy Link. `vercel.json` rewrites route `/is-{service}-down` to the handler

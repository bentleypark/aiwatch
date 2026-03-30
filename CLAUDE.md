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
7. **Commit** — only after review issues are fixed and tests pass. Include issue reference in the message:
   - **Title must include `(#N)`** at the end — links commit to issue timeline (e.g., `fix: description (#123)`)
   - Body: `closes #N` — **only** when ALL checklist items in the issue are complete
   - Body: `refs #N` — when some items remain (e.g., future phases, deferred work)
8. **Verify checklist** — read the issue (`gh issue view N`) and confirm every checklist item (`- [ ]`) is actually implemented in code before closing
9. **Close** — only close the issue after checklist verification: `gh issue close N`
   - If unchecked items remain for future work, **do not close** — add a label (e.g., `deferred`, `phase-N`) to track instead

> Never close an issue immediately after committing. Always re-read the issue checklist and verify each item against the code first. If any phase or checklist item is deferred, keep the issue open and manage with labels.

### Debugging rules
- Before writing any fix, read all relevant code and identify the root cause
- Propose ONE fix approach with reasoning — do not shotgun multiple approaches
- Wait for user confirmation before implementing the fix

### Adding a new service (checklist)

When adding a new monitored service, update ALL of the following:

#### Worker (backend)
1. `worker/src/services.ts` — add `ServiceConfig` entry at correct position in `SERVICES` array (determines API response order: LLM → voice → infra → apps → agents)
2. `worker/src/probe.ts` — add `ProbeTarget` if API endpoint exists for RTT measurement
3. `worker/src/fallback.ts` — update ALL of:
   - `EXCLUDE_FALLBACK` — remove if fallback-eligible
   - `API_TIER` — add tier number (1=Major LLM, 2=LLM, 3=Infra, 4=Voice)
   - `TIER_LABEL` — add label if new tier introduced
   - `buildGroupedFallbackText` uses tier-based grouping — verify Discord alerts show correct labels
4. `worker/src/__tests__/` — update probe target count test, fallback tests, add service-specific tests

#### Frontend
5. `src/utils/constants.js` — update ALL of:
   - `API_SERVICE_IDS` — add new service ID
   - `SERVICE_AND_APP_IDS` — add at correct display position (app → LLM → voice → inference → agent)
   - `SERVICE_CATEGORIES` — add to correct category filter (e.g., `llm`, `inference`)
   - `EXCLUDE_FALLBACK` — keep in sync with `worker/src/fallback.ts`
6. `src/hooks/usePolling.js` — add mock entry to `MOCK_SERVICES` at correct position (determines display order via `mergeWithMock`)
7. `src/hooks/useSettings.js` — new services auto-inserted at canonical position in `enabledServices` (no change needed, but verify logic works)
8. `src/pages/ServiceDetails.jsx` — add `STATUS_URL` entry for official status page link
9. `src/pages/Overview.jsx` — add to `API_TIER` + verify `TIER_LABEL` (keep in sync with `worker/src/fallback.ts`)
10. `api/is-down.ts` — add to `API_TIER` + `EXCLUDE_FALLBACK` (keep in sync with `worker/src/fallback.ts`)

#### Documentation — service count ("N AI services")
11. `CLAUDE.md` — architecture section: service count, service list, category breakdown, KV schema comment, probe count, fallback tier list
12. `README.md` — service count, service table (add row), API Services header count, feature description, API endpoint comment
13. `README.ko.md` — same as README.md (Korean)
14. `.github/CONTRIBUTING.md` — if Project Structure section exists

#### SEO & Meta tags
15. `index.html` — `<meta name="description">`, `og:title`, `og:description`, `twitter:title`, `twitter:description`, JSON-LD (~6 occurrences)

#### Landing page
16. `api/intro/html-template.ts` — update ALL of:
    - meta description
    - hero pill number ("N AI Services")
    - dashboard preview mock: services running count, "All N", "Operational N", "+ N more" (KO/EN)
    - i18n strings KO/EN with service count (~12+ occurrences)
17. `docs/aiwatch-landing.html` — same as intro template (design draft)

#### Is X Down (if adding a dedicated page)
18. `api/is-down.ts` — add service to `SERVICES` map
19. `api/is-down/html-template.ts` — if needed
20. `vercel.json` — add rewrite rule `/is-{service}-down`
21. `public/sitemap.xml` — add URL entry

#### Reports site (aiwatch-reports)
22. `README.md` — service count, category breakdown (e.g., "N LLM APIs, N voice & inference")
23. `_config.yml` — description
24. `_templates/monthly-report.md` — service count, category breakdown
25. Current month report (e.g., `2026-03/index.md`) — service count, category breakdown
26. `index.md` — top-level index page

#### Assets (after deploy)
27. `public/og-intro.png` — regenerate (service count baked in image)
28. `docs/social-preview.png` — regenerate from og-intro.png
29. `docs/screenshot.png` — recapture desktop dashboard
30. `docs/screenshot-mobile.png` — recapture mobile dashboard
31. GitHub Settings → Social preview — re-upload

#### Deployment
32. `npx wrangler deploy --config worker/wrangler.toml --dry-run` — build check
33. `npm run deploy:worker` — deploy after user approval
34. `git push origin main` — Vercel auto-deploy for frontend

## Architecture

**AIWatch** is a React SPA that monitors 27 AI services in real time:
- **20 API services**: Claude, OpenAI, Gemini, Mistral, Cohere, Groq, Together, Perplexity, HuggingFace, Replicate, ElevenLabs, AssemblyAI, Deepgram, xAI, DeepSeek, OpenRouter, Bedrock, Azure OpenAI, Pinecone, Stability AI
- **3 AI apps**: claude.ai, ChatGPT, Character.AI
- **4 coding agents**: Claude Code, GitHub Copilot, Cursor, Windsurf

### Tech Stack
- **React 19 + Vite 6** — SPA, no router library
- **TailwindCSS v4** — utility classes + CSS custom properties for design tokens (see below)
- **Cloudflare Workers** — status polling proxy with KV cache
- **Cloudflare KV** — daily uptime counters, status cache, history archival

### KV Key Schema (STATUS_CACHE namespace)

| Key Pattern | Value | TTL | Writes/Day | Purpose |
|---|---|---|---|---|
| `services:latest` | `{ services, cachedAt }` JSON | 5min | ~288 | Real-time status cache (all 27 services) |
| `daily:{YYYY-MM-DD}` | `{ [svcId]: { ok, total } }` JSON | 2d | ~288 | Daily uptime counters |
| `history:{YYYY-MM-DD}` | Same as daily | 90d | 1 | Archived yesterday's counters |
| `latency:24h` | `{ snapshots: [{ t, data }] }` JSON | 25h | ~48 | 30-min latency snapshots (max 48) |
| `probe:24h` | `{ snapshots: [{ t, data }] }` JSON | 72h | ~288 | 5-min health check probe results (max 864, 17 API services) |
| `alerted:new:{incId}` | `"1"` | 7d | ~5 | Incident alert dedup |
| `alerted:res:{incId}` | `"1"` | 7d | ~2 | Resolved incident alert dedup |
| `alerted:down:{svcId}` | ISO timestamp | 2h | ~2 | Service down alert dedup + recovery duration |
| `alerted:degraded:{svcId}` | ISO timestamp | 2h | ~2 | Service degraded alert dedup |
| `alerted:recovered:{svcId}` | `"1"` | 2h | ~2 | Recovery alert dedup |
| `alerted:probe-spike:{svcId}` | `"1"` | 1h | ~2 | Probe RTT spike alert dedup (early detection) |
| `pending:degraded:{svcId}` | `"1"` | 10min | ~5 | Anti-flapping: 2-cycle consecutive detection |
| `detected:{svcId}` | ISO timestamp | 7d | ~5 | Detection Lead: earliest detection time |
| `reddit:seen:{postId}` | `"1"` | 24h | ~120 | Reddit post dedup (hourly scan, max 5/hour) |
| `ai:analysis:{svcId}` | `AIAnalysisResult` JSON | 1h | ~5 | Claude Sonnet incident analysis result (TTL refreshed while active) |
| `ai:reanalysis-skip:{svcId}` | `"1"` | 30min | ~2 | Re-analysis failure cooldown |
| `ai:usage:{YYYY-MM-DD}` | `{ calls, success, failed }` JSON | 2d | ~5 | Daily AI analysis usage counter (includes re-analysis) |
| `fetch-fail:{svcId}` | counter string | 30min | ~0 (spikes on outage) | RSS fetch consecutive failure counter (3+ → degraded, capped writes) |
| `alert:count:{YYYY-MM-DD}` | `{ incidents, resolved, down, degraded, recovered }` JSON | 2d | ~1-5 | Daily alert count aggregated in Daily Summary |
| `webhook:reg:{sha256hash}` | `{ type, registeredAt }` JSON | 30d | ~1/user/day | Active webhook registration (hashed, refreshed on ping) |
| `alert:proxy:{YYYY-MM-DD}` | `{ discord, slack, failed }` JSON | 2d | ~1 | User webhook delivery counts (approximate, flushed from in-memory by daily summary cron) |
| `kv_limit_alert` | `"1"` | 5min | ~1 | KV write limit exceeded cooldown |
| `vitals:{YYYY-MM-DD}` | `{ count, allValues }` JSON | 2d | ~30 (10% sampling) | Web Vitals daily aggregation (LCP, FCP, TTFB, CLS, INP) |
| `vitals:history:{YYYY-MM-DD}` | `{ count, p75 }` JSON | 90d | 1 | Archived yesterday's vitals p75 summary |

**Free tier budget**: 1,000 writes/day. Estimated total: ~841-951 writes/day (within budget).

### Directory Layout
```
api/
  intro.ts          # Landing page Edge Function (/intro) — Product Hunt landing
  intro/
    html-template.ts # SSR HTML template (i18n, dashboard mock, GA4)
  is-down.ts        # "Is X Down?" Edge Function (9 services)
src/
  components/   # Shared UI: StatusPill, SkeletonUI, EmptyState, Modal, Sidebar, Topbar, CookieBanner, AnalysisModal
  pages/        # Overview, Latency, Incidents, Uptime, ServiceDetails, Settings, AboutScore, Ranking
  hooks/        # usePolling, useTheme, useLang, useSettings, useGitHubStars
  utils/        # analytics, calendar, time, pageContext, constants
  locales/      # ko.js, en.js — flat key→string maps (default exports)
docs/
  aiwatch-landing.html # Landing page design draft (not deployed)
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
    fallback.ts # Fallback recommendation (getFallbacks, buildFallbackText, buildGroupedFallbackText for multi-category incidents)
    ai-analysis.ts # Claude Sonnet incident analysis (system/user prompt, TTL refresh, re-analysis, incidentId dedup)
    daily-summary.ts # Expanded daily Discord report (uptime, latency, AI usage, Reddit, Web Vitals)
    vitals.ts   # Web Vitals aggregation (ingest, KV flush, p75 computation, Discord formatting)
    probe.ts    # Health check probing — direct RTT measurement (17 API services)
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
| `click_ph_upvote` | `location` | Landing page (PH banner) | Product Hunt upvote link click |

Is X Down pages (Edge SSR) and Landing page use inline `gtag()` calls directly since they don't use React.

**Reports site** (`reports.ai-watch.dev`) uses the same GA4 ID (`G-D4ZWVHQ7JK`) with event delegation in `_includes/footer.html`:

| Event | Parameters | Trigger | Purpose |
|---|---|---|---|
| `click_dashboard` | `location: reports_site`, `source: footer/body` | ai-watch.dev link click | Dashboard navigation from reports |
| `click_report` | `location: reports_site`, `report_month: YYYY-MM` | Monthly report link click | Report page view intent |

### Status Data Flow
```
Browser (React SPA, 60s polling)
  → Cloudflare Worker (/api/status)
    → parallel fetch (27 services)
    → normalize to ServiceStatus[]
    → write to KV (cache + daily counters)
  → React state (usePolling hook via PollingContext)
  → all pages read from context

Cron Trigger (*/5 min)
  → health check probing (direct RTT to API endpoints, stored in probe:24h)
  → read KV cache → detect incidents/status changes
  → record detection timestamps (detected:{serviceId}) for Detection Lead
  → KV ID-based dedup → Discord alerts (single embed per incident)
  → incident detected → AI analysis (8s timeout) → merged into incident embed
  → recovery detected → delete ai:analysis:{svcId}
  → active incidents: refresh analysis TTL / re-analyze if expired / dedup sibling services
  → alert count tracked in KV (alert:count:{date}) for Daily Summary
  → daily summary at UTC 09:00 (KST 18:00) with alert count aggregation + Web Vitals p75

Web Vitals Pipeline (per-request, 10% sampled):
  Browser (web-vitals) → POST /api/vitals → Worker → KV merge (vitals:{date})
  Daily Summary cron reads vitals KV → Discord embed (p75 + grade)
```

### SPA Navigation
No React Router. Hash-based routing in `App.jsx` — `#claude` for service details, `#latency` for pages. `PageContext` shares current page state. Browser back/forward supported via `popstate` listener.

### Key Product Constraints
- Mobile breakpoint: 768px — sidebar hidden (overlay on hamburger), cards go 1-column
- Phase 3 AI Analysis (Beta): Claude Sonnet auto-analysis on incidents — triggered by cron, stored in KV, shown in Topbar Analyze modal + Is X Down AI Insight card. Requires `ANTHROPIC_API_KEY` Worker secret
  - TTL refresh: cron refreshes `ai:analysis:{svcId}` every ~30min while incident is active
  - Re-analysis: if analysis expired/missing, re-triggers (max 2/cron, 30min cooldown on failure). Also re-analyzes after 2h for long-running active incidents (safe overwrite: keeps old analysis on failure)
  - Stale detection: re-analyzes when stored incidentId no longer matches active incidents
  - Dedup: sibling services sharing same incidentId copy analysis from KV (no extra API call)
  - Modal groups services with same incidentId into single card
  - Grouped fallback: when incident affects multiple categories, Discord alerts + dashboard show per-category alternatives via `buildGroupedFallbackText`
  - **Fallback tier priority** (API services only): same-tier services are recommended first, then adjacent tiers. Within each tier, sorted by AIWatch Score descending. Defined in `worker/src/fallback.ts`, mirrored in `src/pages/Overview.jsx` and `api/is-down.ts`:
    - **Tier 1** (Major LLM): `claude`, `openai`, `gemini`
    - **Tier 2** (LLM): `mistral`, `cohere`, `groq`, `together`, `deepseek`, `xai`, `perplexity`
    - **Tier 3** (Infrastructure): `bedrock`, `azureopenai`, `openrouter`
    - **Tier 4** (Voice): `elevenlabs`, `assemblyai`, `deepgram`
  - `EXCLUDE_FALLBACK` services are excluded from both source and candidate lists (keep in sync across `worker/src/fallback.ts`, `src/utils/constants.js`, `api/is-down.ts`)
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
  - **Cron Trigger**: `*/5 * * * *` — alert detection runs every 5 minutes via scheduled handler (not per-request). Uses KV ID-based dedup (`alerted:new/res:` keys 7d TTL, `alerted:down/degraded/recovered:` keys 2h TTL). Fallback recommendations only included when service status is degraded/down (not operational). AI analysis runs inline with 8s timeout (merged into incident embed), results stored in `ai:analysis:{svcId}` (1h TTL). Daily alert counts tracked in `alert:count:{date}` for Daily Summary
- **Frontend deployment**: Vercel, domain ai-watch.dev — `git push origin main` triggers auto-deploy. `npm run build` is local only; changes are not live until pushed
- **PWA**: `public/manifest.json` + `public/sw.js` (stale-while-revalidate). CACHE_NAME in `sw.js` must be bumped manually when static assets change. SW excludes `/is-*` (Edge SSR) and `/api/*` (real-time data) from caching
- **Edge SSR**: `api/is-down.ts` serves "Is X Down?" SEO pages (9 services: claude, chatgpt, gemini, github-copilot, cursor, claude-code, openai, windsurf, claude-ai) via Vercel Edge Functions. Uses `/api/status/cached` (KV-only) for fast SSR (~1.2s). Dynamic OG image via Worker `/api/og` (PNG, resvg-wasm). Share buttons: X, Threads, KakaoTalk (SDK async), Copy Link. `vercel.json` rewrites route `/is-{service}-down` to the handler
- **Landing page**: `api/intro.ts` + `api/intro/html-template.ts` — Product Hunt landing page via Vercel Edge Function. `/intro` route (or `?ref=producthunt` for PH banner). Self-contained SSR with inline CSS/JS, KO/EN i18n (client-side toggle), GA4 events, dashboard preview mock. No external data fetch (pure template render)

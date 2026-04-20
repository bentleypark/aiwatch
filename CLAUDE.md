# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Persistent Memory (MemPalace MCP)

This project uses MemPalace MCP server for persistent memory that survives context compaction and session boundaries.

### Session Start
- `SessionStart` hook auto-injects a reminder to call `mempalace_status` — call it on first turn
- Call `mempalace_search` before answering questions about past decisions, architecture history, or debugging context

### When to Store
Each drawer save specifies **wing + room + hall**. Hall is the memory type (fixed 5). Room is the topic (project-defined).

| Store Type | Room | Hall | Tool |
|---|---|---|---|
| Architecture choice, trade-off reasoning | `decisions` | `events` | `mempalace_add_drawer` |
| Root cause findings, non-obvious fixes | `debugging` | `discoveries` | `mempalace_add_drawer` |
| User corrections, confirmed approaches | `feedback` | `preferences` or `advice` | `mempalace_add_drawer` |
| Stable facts (API schema, service count) | `architecture` | `facts` | `mempalace_add_drawer` |
| PR merges, deploys, major completions | `deployments` | `events` | `mempalace_diary_write` |

### When to Search
- Before proposing changes to areas with prior decisions
- When user references past work ("지난번에", "이전에", "아까")
- When context was compacted and details were lost

### PreCompact Hook
`PreCompact` hook auto-injects a reminder to save important decisions/debugging/feedback to MemPalace before context is lost. Scan the conversation and save what matches the table above — skip ephemeral task state.

### Palace Structure
- **Wing**: `aiwatch` (this project)
- **Rooms** (topics): `architecture`, `debugging`, `feedback`, `decisions`, `deployments`
- **Halls** (memory types, fixed): `facts`, `events`, `discoveries`, `preferences`, `advice`

## Commands

```bash
npm run dev        # Start frontend dev server (localhost:5173) — dashboard
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

### Local verification by page type

| Page | Command | URL |
|------|---------|-----|
| **Dashboard** (SPA) | `npm run dev` | `http://localhost:5173` |
| **Landing page** (`/intro`) | `npx vercel dev --listen 3333 --yes` | `http://localhost:3333/intro` |
| **Is X Down** (`/is-*-down`) | `npx vercel dev --listen 3333 --yes` | `http://localhost:3333/is-claude-down` |
| **Worker API** | `npx wrangler dev --config worker/wrangler.toml --port 8788` | `http://localhost:8788/api/status` |
| **Monthly Reports** (Jekyll) | `cd ~/Desktop/bentely/aiwatch/aiwatch-reports && PATH="/opt/homebrew/opt/ruby/bin:$PATH" GEM_HOME="$HOME/.gem/ruby/4.0.0" bundle exec jekyll serve --port 4000` | `http://localhost:4000/2026-03/` |

> **Note**: Dashboard reads Worker API from `VITE_API_URL` in `.env` (default: `localhost:8788`). Run Worker alongside dashboard for live data. Landing page and Is X Down pages are Vercel Edge Functions — use `vercel dev`, not Vite. Monthly Reports require Homebrew Ruby + `bundle install` in the aiwatch-reports repo (one-time setup).

## Branch Strategy (GitHub Flow)

```
main (always deployable — protected branch, no direct push)
  └── fix/123-mobile-padding      ← per-issue feature branch
  └── feat/456-new-service
  └── refactor/789-polling
```

### Rules
- **main**: PR merge only (no force push, no deletion)
- **Branch naming**: `{type}/{issue#}-{description}` (e.g., `fix/123-mobile-padding`, `feat/456-ranking-page`)
  - type: `fix`, `feat`, `refactor`, `docs`, `chore`, `test`
- **Merge method**: squash merge (clean per-PR history)
- **Deploy**: Vercel auto-deploys on main merge, Worker is manual (`npm run deploy:worker`)
- **Vercel Preview**: auto-generated preview URL on PR creation — use for mobile/desktop verification

### Branch workflow
```bash
# 1. Start work
git checkout main && git pull
git checkout -b fix/123-description

# 2. Code + commit (multiple commits OK — will be squash merged)
git add ... && git commit

# 3. Create PR
git push -u origin fix/123-description
gh pr create --title "fix: description (#123)" --body "..."

# 4. Verify Vercel Preview → merge
gh pr merge --squash --delete-branch
```

## Development Workflow

> **IMPORTANT**: Always re-read this section before starting any task. Never skip code review (step 4) or tests (step 3).

### Per-issue process (follow this order every time)

0. **Review rules** — Re-read this Development Workflow section and follow each step in order
1. **Branch** — create a feature branch from main: `git checkout -b {type}/{issue#}-{description}`
2. **Design check** (UI issues only) — before coding, compare `docs/AIWatch_화면디자인_초안.html` with the current implementation:
   - Open design mockup in browser and take screenshots of the relevant area
   - Identify **every** difference (spacing, colors, fonts, layout, icons, text)
   - List differences explicitly before writing any code
3. **Code** — implement the feature or fix
3.5. **Local verify** — start the appropriate dev server and let the user confirm in browser before proceeding. See "Local verification by page type" table above for which command to use. Never skip this step.
4. **Build + Test** — based on change scope:
   - **Frontend changes** (`src/`): `npm run build` + `npm test` (Playwright)
   - **Backend changes** (`worker/`): `npx wrangler deploy --config worker/wrangler.toml --dry-run` + `npm run test:worker` (Vitest)
   - **Both**: run all of the above
   - **Worker logic additions**: new functions must have unit tests — extract to separate files with exports, test in `worker/src/__tests__/` or `worker/src/parsers/__tests__/`
   - **Bug fixes**: every bug fix must include a test that would have caught the bug — E2E (Playwright) for frontend, Vitest for worker
5. **Review** — run PR review **before** creating PR:
   ```
   /pr-review-toolkit:review-pr
   ```
6. **Fix review issues — auto-loop until convergence**:
   - Address all **Critical** and **Important** findings
   - Re-run Build + Test after fixes
   - **Auto-run another review round** without waiting for user prompt
   - Repeat (fix → test → re-review) until a round produces zero new Critical/Important findings (Suggestions only = converged)
   - Each round must focus on issues *introduced by the previous round's fixes* — agents should not repeat already-resolved items
   - Only proceed to commit (step 8) after convergence
7. **Docs update** — update documentation affected by the change:
   - `CLAUDE.md`: architecture, service count, directory layout, constraints
   - `README.md` / `README.ko.md`: features, service tables, Project Structure, Available Service IDs
   - `.github/CONTRIBUTING.md`: Project Structure
   - `index.html`: SEO meta tags (service count, description)
   - `aiwatch-reports/`: service count, category breakdown (if applicable)
8. **Commit + PR** — only after review issues are fixed and tests pass:
   - Commit on feature branch (multiple commits OK — will be squash merged)
   - Push branch: `git push -u origin {branch}`
   - Create PR: `gh pr create --title "{type}: description (#N)" --body "closes #N"`
   - Body: `closes #N` — **only** when ALL checklist items in the issue are complete
   - Body: `refs #N` — when some items remain (e.g., future phases, deferred work)
9. **Verify Vercel Preview** — check the Vercel preview deployment URL from the PR
10. **Merge** — squash merge: `gh pr merge --squash --delete-branch`
11. **Verify checklist** — read the issue (`gh issue view N`) and confirm every checklist item (`- [ ]`) is actually implemented in code before closing
12. **Close** — only close the issue after checklist verification: `gh issue close N`
    - If unchecked items remain for future work, **do not close** — add a label (e.g., `deferred`, `phase-N`) to track instead

> Never close an issue immediately after merging. Always re-read the issue checklist and verify each item against the code first. If any phase or checklist item is deferred, keep the issue open and manage with labels.

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
   - `API_TIER` — add tier number (keep in sync with `worker/src/fallback.ts`)
6. `src/hooks/usePolling.js` — add mock entry to `MOCK_SERVICES` at correct position (determines display order via `mergeWithMock`)
7. `src/hooks/useSettings.js` — new services auto-inserted at canonical position in `enabledServices` (no change needed, but verify logic works)
8. `src/pages/ServiceDetails.jsx` — add `STATUS_URL` entry for official status page link
9. `src/pages/Overview.jsx` — verify `TIER_LABEL` (keep in sync with `worker/src/fallback.ts`; `API_TIER` + `getFallbacks` imported from `src/utils/constants.js`)
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

#### Reports site (aiwatch-reports) — commit + push to deploy (GitHub Pages auto-build)
22. `README.md` — service count, category breakdown (e.g., "N LLM APIs, N voice & inference")
23. `_config.yml` — description
24. `_templates/monthly-report.md` — service count, category breakdown
25. Current month report (e.g., `2026-03/index.md`) — service count, category breakdown
26. `index.md` — top-level index page
27. `scripts/generate-charts.js` — service count in comments

#### Assets (after deploy)
28. `scripts/generate-og-intro.mjs` — update `SERVICE_COUNT`, run `node scripts/generate-og-intro.mjs` (generates both `public/og-intro.png` + `docs/social-preview.png`), then commit + push
29. `docs/screenshot.png` — recapture desktop dashboard
30. `docs/screenshot-mobile.png` — recapture mobile dashboard
31. GitHub Settings → Social preview — re-upload

#### Deployment
32. `npx wrangler deploy --config worker/wrangler.toml --dry-run` — build check
33. `npm run deploy:worker` — deploy after user approval
34. `git push origin main` — Vercel auto-deploy for frontend

## Architecture

**AIWatch** is a React SPA that monitors 30 AI services in real time:
- **23 API services**: Claude, OpenAI, Gemini, Mistral, Cohere, Groq, Together, Fireworks, Perplexity, HuggingFace, Replicate, ElevenLabs, AssemblyAI, Deepgram, xAI, DeepSeek, OpenRouter, Bedrock, Azure OpenAI, Pinecone, Stability AI, Voyage AI, Modal
- **3 AI apps**: claude.ai, ChatGPT, Character.AI
- **4 coding agents**: Claude Code, GitHub Copilot, Cursor, Windsurf

### Tech Stack
- **React 19 + Vite 6** — SPA, no router library
- **TailwindCSS v4** — utility classes + CSS custom properties for design tokens (see below)
- **Cloudflare Workers** — status polling proxy with KV cache
- **Cloudflare Workers AI** — Gemma 4 26B incident analysis (primary, via `[ai]` binding)
- **Cloudflare KV** — daily uptime counters, status cache, history archival

### KV Key Schema (STATUS_CACHE namespace)

| Key Pattern | Value | TTL | Writes/Day | Purpose |
|---|---|---|---|---|
| `services:latest` | `{ services, cachedAt }` JSON | 5min | ~288 | Real-time status cache (all 30 services) |
| `daily:{YYYY-MM-DD}` | `{ [svcId]: { ok, total } }` JSON | 2d | ~288 | Daily uptime counters |
| `history:{YYYY-MM-DD}` | Same as daily | 90d | 1 | Archived yesterday's counters |
| `latency:24h` | `{ snapshots: [{ t, data }] }` JSON | 25h | ~48 | 30-min latency snapshots (max 48) |
| `probe:24h` | `{ snapshots: [{ t, data }] }` JSON | 7d | ~288 | 5-min health check probe results (max 2016, 19 API services) |
| `probe:daily:{YYYY-MM-DD}` | `{ [svcId]: { p50, p75, p95, min, max, count, spikes } }` JSON | 90d | 1 | Daily probe RTT summary for monthly reports |
| `probe:summaries` | `[svcId, ProbeSummary][]` JSON | 80min | ~48 | Cron-cached 7-day probe summaries (p50, p95, cvCombined, validDays); refreshed every 30min via in-memory slot guard, TTL covers up to 2 missed 30-min refresh cycles |
| `alerted:new:{incId}` | `"1"` | 7d | ~5 | Incident alert dedup |
| `alerted:res:{incId}` | `"1"` | 7d | ~2 | Resolved incident alert dedup |
| `alerted:down:{svcId}` | ISO timestamp | 2h | ~2 | Service down alert dedup + recovery duration |
| `alerted:degraded:{svcId}` | ISO timestamp | 2h | ~2 | Service degraded alert dedup |
| `alerted:recovered:{svcId}` | `"1"` | 2h | ~2 | Recovery alert dedup |
| `recovered:{svcId}:{incId}` | `{ resolvedAt, incidentTitle, duration }` JSON | 2h | ~2 | Independent recovery marker (powers Recently Resolved banner without AI analysis) |
| `alerted:probe-spike:{svcId}` | `"1"` | 1h | ~2 | Probe RTT spike alert dedup (early detection) |
| `pending:degraded:{svcId}` | `"1"` | 10min | ~5 | Anti-flapping: 2-cycle consecutive detection |
| `detected:{svcId}` | ISO timestamp | 7d | ~5 | Detection Lead: earliest detection time (probe spike or status page, whichever is earlier) |
| `detection:lead:{YYYY-MM-DD}` | `DetectionLeadEntry[]` JSON | 7d | ~0-5 | Detection Lead audit log — appended on each new incident with positive lead, dedup by incId, surfaced in Daily Summary Discord embed (#256) |
| `reddit:seen:{postId}` | `"1"` | 24h | ~120 | Reddit post dedup (hourly scan, max 5/hour) |
| `security:seen:hn:{objectId}` | `SecurityAlertMeta` JSON | 7d | ~0 | HN security post dedup + dashboard display |
| `security:seen:osv:{vulnId}` | `SecurityAlertMeta` JSON | 7d | ~0 | OSV.dev vulnerability dedup + dashboard display |
| `security:monthly:{YYYY-MM}` | `SecurityAlertMeta[]` JSON | 60d | ~1/day | Monthly security alert accumulation for reports |
| `security:detected:{YYYY-MM-DD}` | integer string | 3d | ~0-3/day | Daily counter of newly-detected security alerts (#288). Incremented by `securityAlerts.length` when HN/OSV detection fires. Daily summary reads this instead of counting `security:seen:*` (which accumulates over 7d and inflates the figure) |
| `ai:analysis:{svcId}:{incId}` | `AIAnalysisResult` JSON | 1h (active) / 2h (resolved) | ~5 per incident | Hybrid AI analysis result — Gemma 4 primary + Sonnet fallback (TTL refreshed while active; on recovery, `resolvedAt` added instead of deleting — kept 2h for "Recently Resolved" UI). `model` field tracks which model produced the analysis |
| `ai:reanalysis-skip:{svcId}:{incId}` | `"1"` | 30min | ~2 per incident | Per-incident re-analysis failure cooldown |
| `ai:usage:{YYYY-MM-DD}` | `{ calls, success, failed, gemma?, sonnet? }` JSON | 2d | ~5 | Daily AI analysis usage counter (includes re-analysis, model breakdown) |
| `fetch-fail:{svcId}` | counter string | 30min | ~0 (spikes on outage) | RSS fetch consecutive failure counter (3+ → degraded, capped writes) |
| `component-missing:{svcId}` | counter string | 30min | ~0 (spikes on migration) | Component ID consecutive miss counter (3+ → Discord alert) |
| `alerted:component-missing:{svcId}` | `"1"` | 24h | ~0 | Component ID mismatch alert dedup |
| `alerted:service-drop` | `"1"` | 2h | ~0 | Service count drop alert dedup (< 80% of expected) |
| `alert:count:{YYYY-MM-DD}` | `{ incidents, resolved, down, degraded, recovered }` JSON | 2d | ~1-5 | Daily alert count aggregated in Daily Summary |
| `webhook:reg:{sha256hash}` | `{ type, registeredAt }` JSON | 30d | ~1/user/day | Active webhook registration (hashed, refreshed on ping) |
| `alert:proxy:{YYYY-MM-DD}` | `{ discord, slack, failed }` JSON | 2d | ~1 | User webhook delivery counts (approximate, flushed from in-memory by daily summary cron) |
| `kv_limit_alert` | `"1"` | 5min | ~1 | KV write limit exceeded cooldown |
| `daily-summary:{YYYY-MM-DD}` | `"1"` | 7d | 1 | Daily summary execution marker (prevents duplicate send + enables catch-up) |
| `changelog:entries` | `ChangelogEntry[]` JSON | 14d | ~3 | Accumulated changelog entries from RSS + HTML sources (cleared after weekly briefing) |
| `changelog:last-fetch:{source}` | ISO timestamp string | 7d | ~96 | Per-source last-successful-fetch marker (#274) — weekly briefing surfaces sources stale >2d so silent collection gaps don't go unnoticed |
| `weekly-briefing:{YYYY-MM-DD}` | `"1"` | 7d | 1/week | Weekly briefing execution dedup marker |
| `vitals:{YYYY-MM-DD}` | `{ count, allValues }` JSON | 3d | per visit (100%) | Web Vitals daily aggregation (LCP, FCP, TTFB, CLS, INP) |
| `vitals:history:{YYYY-MM-DD}` | `{ count, p75 }` JSON | 90d | 1 | Archived yesterday's vitals p75 summary |
| `incidents:monthly:{YYYY-MM}` | `MonthlyIncidents` JSON | 60d | 1/day | Monthly incident accumulation (deduped by ID, updated in daily summary cron) |
| `archive:monthly:{YYYY-MM}` | `MonthlyArchive` JSON | none (permanent) | 1/month | Monthly reliability snapshot (uptime, score, incidents, latency per service) |
| `platform:status:{platformId}` | `PlatformStatus` JSON | 10min | ~288 | Status page platform health (metastatuspage.com for Atlassian) |
| `alerted:platform:{platformId}` | `"1"` | 2h | ~1 | Platform outage alert dedup |

**Free tier budget**: 1,000 writes/day. Estimated total: ~845-958 writes/day + changelog (~3/day) + changelog last-fetch markers (~96/day, 4 sources × 24 hourly cron, #274) + weekly briefing (~1/week) + vitals (1 per visit) + platform status (~1/cycle when changed) + recovery markers (~2-5/day). Monitor if daily visits exceed ~50.

### Directory Layout
```
api/
  intro.ts          # Landing page Edge Function (/intro) — Product Hunt landing
  intro/
    html-template.ts # SSR HTML template (i18n, dashboard mock, GA4)
  is-down.ts        # "Is X Down?" Edge Function (28 services — excludes bedrock/azureopenai per #263)
src/
  components/   # Shared UI: StatusPill, SkeletonUI, EmptyState, Modal, Sidebar, Topbar, CookieBanner, AnalysisModal
  pages/        # Overview, Latency, Incidents, Uptime, ServiceDetails, Settings, AboutScore, Ranking
  hooks/        # usePolling, useTheme, useLang, useSettings, useGitHubStars
  utils/        # analytics, calendar, time, pageContext, constants
  locales/      # ko.js, en.js — flat key→string maps (default exports)
docs/
  aiwatch-landing.html # Landing page design draft (not deployed)
scripts/
  generate-og-intro.mjs # OG intro image generator (uses icon-192.png + sharp)
worker/
  src/
    index.ts    # Worker entry: CORS, KV, routing, /api/alert, /badge, /api/v1, Cron scheduled handler
    services.ts # Service configs + fetch orchestrator + status determination
    types.ts    # Shared types (ServiceStatus, Incident, etc.)
    utils.ts    # Shared utilities (formatDuration, fetchWithTimeout, sanitize)
    score.ts    # AIWatch Score — composite reliability (Uptime 40 + Incidents 25 + Recovery 15 + Responsiveness 20 from probe p50/CV; 80→100 rescale + 5% penalty for probe-less services, insufficient-data penalty for <7d probe samples). Incidents component uses Atlassian-weighted affected days (#260/#261): null impact excluded, per-day max impact weight (critical/major=1.0, minor=0.3) — symmetric with uptime weighting. Grade thresholds tightened to absorb the upward score shift: excellent ≥90, good ≥75, fair ≥55, degrading ≥40, unstable <40
    badge.ts    # SVG badge generator
    og.ts       # OG image SVG generator (1200×630 for social share)
    og-render.ts # SVG → PNG conversion (resvg-wasm, Inter font from CDN)
    alerts.ts   # Alert detection logic (buildIncidentAlerts, buildServiceAlerts, formatDetectionLead)
    fallback.ts # Fallback recommendation (getFallbacks, buildFallbackText, buildGroupedFallbackText for multi-category incidents)
    ai-analysis.ts # Hybrid AI incident analysis — Gemma 4 26B (Workers AI) primary + Claude Sonnet (AI Gateway) fallback (system/user prompt, needsFallback assessment, TTL refresh, re-analysis, incidentId dedup, timeline context, boilerplate filtering, formatRecoveryDisplay)
    changelog.ts # Changelog/news collection (OpenAI blog RSS, Google AI blog RSS, Anthropic /news HTML parsing) — 15s timeout + 1 retry on transient errors, per-source last-fetch KV markers for stale-source detection (#274)
    weekly-briefing.ts # Weekly Discord briefing (changelog + incidents + stability trends)
    daily-summary.ts # Expanded daily Discord report (uptime, latency, AI usage, Reddit, Web Vitals)
    monthly-archive.ts # Monthly reliability archive (uptime, score, incidents, latency per service, permanent KV)
    vitals.ts   # Web Vitals aggregation (ingest, KV flush, p75 computation, Discord formatting)
    probe.ts    # Health check probing — direct RTT measurement (19 API services)
    probe-archival.ts # Daily probe RTT archival + 7-day summary (p50, p95, cvCombined)
    platform-monitor.ts # Status page platform health monitoring (metastatuspage.com for Atlassian)
    detection.ts # Detection Lead entry parsing + incident-aware reset logic
    detection-lead-log.ts # Detection Lead audit log — per-day KV array (#256), tagged AppendResult, 24h sliding window for daily summary
    reddit.ts   # Reddit r/ChatGPT + r/netsec + r/cybersecurity monitoring
    security-monitor.ts # AI service security monitoring (HN Algolia, OSV.dev SDK vulnerabilities)
    parsers/    # Platform-specific parsers (statuspage, incident-io, gcloud, instatus, betterstack, aws)
                # dailyImpact support: statuspage (uptimeData), incident-io (component impacts), betterstack (status_history from index.json)
                # impact-weights.ts: shared MAJOR_WEIGHT=1.0, MINOR_WEIGHT=0.3 — used by both statuspage.ts (official) and incident-io.ts (estimate from durations) for Atlassian-aligned uptime%
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
| `click_request_service` | — | Sidebar (request link) | Service request link click |
| `share` | `method` (x/threads/kakao/copy), `item_id` | Is X Down (share buttons) | Social share button click |
| `click_dashboard` | `location`, `source` | Is X Down (header/footer) | Dashboard link click |
| `click_cta_alerts` | `location`, `source?` | Is X Down (CTA/footer) | Set Up Alerts click |
| `click_ranking` | `location`, `source` | Is X Down (header/alternatives) | Ranking link click |
| `click_service_detail` | `location`, `service_id` | Is X Down (footer) | Service detail page click |
| `click_reports` | `location`, `source` | Is X Down (alternatives/footer) | Monthly reports link click (Is X Down) |
| `click_ph_upvote` | `location` | Landing page (PH banner) | Product Hunt upvote link click |
| `font_load_failed` | `transport_type: 'beacon'` | index.html `<link>` onerror | Google Fonts CSS preload failed (CDN outage, ad blocker, network) — surfaces silent fallback to system fonts (refs #191) |

Is X Down pages (Edge SSR) and Landing page use inline `gtag()` calls directly since they don't use React.

**Reports site** (`reports.ai-watch.dev`) uses the same GA4 ID (`G-D4ZWVHQ7JK`) with event delegation in `_includes/footer.html`:

| Event | Parameters | Trigger | Purpose |
|---|---|---|---|
| `click_dashboard` | `location: reports_site`, `source: footer/body` | ai-watch.dev link click | Dashboard navigation from reports |
| `click_report` | `location: reports_site`, `report_month: YYYY-MM` | Monthly report link click | Report page view intent |
| `click_request_service` | `location: reports_site`, `page` | Service request link click | Request a Service link click |

### Service Status Determination
Per-service status is resolved in `services.ts` with this priority:
1. **Component match** (`statusComponentId` or `statusComponent`): use that component's status
2. **Component not found**: fall back to overall page indicator
3. **No component configured**: use overall indicator, BUT if no relevant unresolved incidents matched after `incidentExclude`/`incidentKeywords` filtering, treat as `operational` (prevents cross-contamination from unrelated incidents on shared status pages, e.g., ChatGPT incident should not affect OpenAI API status)
4. **Component-status incident filter** (`filterByComponentStatus`): if component is `operational` but provider bulk-linked incidents to all components, remove unresolved incidents (keep resolved + monitoring). Prevents e.g., Anthropic admin API incident from showing on claude.ai/Claude Code when their components are healthy
5. **Status page fetch failure cross-validation** (post-processing in `fetchAllServices`):
   - If service is `degraded` from fetch failure (no incidents) AND probe RTT is normal → override to `operational`
   - If 70%+ of services on the same platform (Atlassian/incident.io/etc.) fail simultaneously → platform outage → override all to `operational`
   - Conservative: only overrides when evidence is strong (≥2 recent probes healthy, or quorum failure detected)

### Status Data Flow
```
Browser (React SPA, 60s polling)
  → Cloudflare Worker (/api/status)
    → parallel fetch (30 services)
    → normalize to ServiceStatus[]
    → write to KV (cache + daily counters)
    → probe cross-validation: filter Mistral micro-incident noise (no RTT spike → excluded)
    → metastatuspage preemptive signal: platform:status:atlassian KV non-operational → hold all Atlassian services operational
    → platform quorum detection: 70%+ same-platform fetch failures → platform outage → hold operational for all affected services
    → probe cross-validation: individual probe RTT normal → hold operational (prevents false positives during status page failures)
  → React state (usePolling hook via PollingContext)
    → overlay probe RTT onto service.latency (19 probe services)
    → non-probe services (bedrock, azureopenai, pinecone) keep status page latency
  → all pages read from context

Cron Trigger (*/5 min)
  → health check probing (direct RTT to API endpoints, stored in probe:24h)
  → probe spike detection (3+ consecutive RTT spikes) → record to detected:{svcId} as earliest detection
  → platform monitor: check metastatuspage.com → store platform:status:atlassian → Discord alert on outage/recovery
  → read KV cache → detect incidents/status changes
  → record detection timestamps (detected:{serviceId}) for Detection Lead (probe spike time preferred if earlier)
  → KV ID-based dedup → Discord alerts (single embed per incident, with Detection Lead if probe detected first)
  → incident detected → AI analysis via Gemma 4 (Workers AI, primary) or Sonnet (AI Gateway, fallback) (8s timeout) + Detection Lead (1-60min advance detection → "⚡ Detection Lead: Xm") → merged into incident embed + persisted to detection:lead:{date} audit log (#256, dedup by incId, surfaced in daily summary)
  → recovery detected → mark ai:analysis:{svcId}:{incId} with resolvedAt (2h TTL, powers "Recently Resolved" UI)
  → active incidents: refresh analysis TTL / re-analyze if expired / dedup sibling services
  → alert count tracked in KV (alert:count:{date}) for Daily Summary
  → daily summary at UTC 09:00 (KST 18:00) with alert count aggregation + Web Vitals p75 + Detection Lead audit log (24h sliding window from today + yesterday keys)
  → daily summary also accumulates incidents:monthly:{YYYY-MM} (dedup by incident ID, 60d TTL)
  → monthly archive on 1st of month (UTC 00:00) → aggregate history:* + probe:daily:* + incidents:monthly:* → archive:monthly:{YYYY-MM} (permanent)
  → changelog RSS/HTML collection (hourly at :00) → KV accumulate new entries from OpenAI/Google/Anthropic
  → security monitoring (hourly at :00) → HN Algolia + OSV.dev SDK vulnerability scan → Discord digest on findings
  → weekly briefing on Sunday UTC 00:00 (KST 09:00) → aggregate changelog + incidents + stability → Discord embed

Web Vitals Pipeline (per-request, 100% collection):
  Browser (web-vitals) → POST /api/vitals → Worker → KV merge (vitals:{date})
  Daily Summary cron reads vitals KV → Discord embed (p75 + grade)
```

### SPA Navigation
No React Router. Hash-based routing in `App.jsx` — `#claude` for service details, `#latency` for pages. `PageContext` shares current page state. Browser back/forward supported via `popstate` listener.

### Key Product Constraints
- Mobile breakpoint: 768px — sidebar hidden (overlay on hamburger), cards go 1-column
- Phase 3 AI Analysis (Beta): Hybrid AI auto-analysis on incidents — Gemma 4 26B via Workers AI binding (primary, zero API key, free tier) + Claude Sonnet via Cloudflare AI Gateway (fallback). Triggered by cron, stored in KV (`model` field tracks source), shown in Topbar Analyze modal + Is X Down AI Insight card. `ANTHROPIC_API_KEY` Worker secret required for Sonnet fallback. Recovery time "N/A" displayed as "Exceeded typical pattern" via `formatRecoveryDisplay()`
  - Per-incident KV keys: `ai:analysis:{svcId}:{incId}` — each incident analyzed independently, supports multiple simultaneous incidents per service
  - TTL refresh: cron refreshes per-incident analysis keys every ~30min while incident is active
  - Re-analysis: if analysis expired/missing, re-triggers (max 2/cron, 30min cooldown on failure). Also re-analyzes after 2h for long-running active incidents (safe overwrite: keeps old analysis on failure). Includes incident timeline updates in prompt for richer context
  - Timeline-aware skip: stores `timelineHash` (latest entry timestamp) — skips re-analysis when timeline unchanged or new entries are all boilerplate (generic "investigating"/"monitoring" messages detected by `isBoilerplate()`)
  - Dedup: sibling services sharing same incidentId copy analysis from KV (no extra API call)
  - Modal groups services with same incidentId into single card
  - API response: `aiAnalysis: Record<svcId, AIAnalysisResult[]>` — array per service
  - **Recently Resolved**: on recovery, cron writes independent `recovered:{svcId}:{incId}` KV (2h TTL) regardless of AI analysis. Also marks per-incident analysis keys with `resolvedAt` field if they exist. `/api/status` returns `recentlyRecovered: Record<svcId, incId[]>` for operational services with recovery markers. Dashboard shows info banner (service names link to detail page) + "Recently Resolved" badge on specific incidents in ServiceDetails + Analyze modal link only when AI analysis exists. "See details in Analyze" hidden when no AI analysis data
  - **Contextual fallback** (`needsFallback`): AI analysis includes boolean flag assessing if incident warrants switching to alternative. When true, AnalysisModal + Is X Down AI Insight card show Score-based fallback list. Shared `getFallbacks()` utility in `src/utils/constants.js` (used by AnalysisModal + Overview)
  - Grouped fallback: when incident affects multiple categories, Discord alerts + dashboard show per-category alternatives via `buildGroupedFallbackText`
  - **Fallback tier priority** (API services only): same-tier services are recommended first, then adjacent tiers. Within each tier, sorted by AIWatch Score descending. Defined in `worker/src/fallback.ts`, mirrored in `src/utils/constants.js` and `api/is-down.ts`:
    - **Tier 1** (Major LLM): `claude`, `openai`, `gemini`
    - **Tier 2** (LLM): `mistral`, `cohere`, `groq`, `together`, `fireworks`, `deepseek`, `xai`, `perplexity`
    - **Tier 3** (Infrastructure): `bedrock`, `azureopenai`, `openrouter`
    - **Tier 4** (Voice): `elevenlabs`, `assemblyai`, `deepgram`
  - `EXCLUDE_FALLBACK` services are excluded from both source and candidate lists (keep in sync across `worker/src/fallback.ts`, `src/utils/constants.js`, `api/is-down.ts`): `replicate`, `huggingface`, `pinecone`, `stability`, `voyageai`, `modal`, `characterai`, `bedrock`, `azureopenai`
  - **Estimate-only services** (`uptimeSource === 'estimate'` + 0 incidents): `bedrock`, `azureopenai` — hidden from Ranking, Uptime rankings, fallback recommendations, category averages. Dashboard shows "— Not provided" instead of misleading 100% uptime
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
  - Endpoints: `GET /api/status`, `GET /api/status/cached` (KV-only, includes probe24h, for SSR + initial load), `GET /api/uptime?days=30`, `GET /api/probe/history?days=30` (daily probe RTT summaries, 90d max), `GET /api/report?month=YYYY-MM` (monthly archive JSON, permanent), `POST /api/alert`, `GET /badge/:serviceId`, `GET /api/og` (dynamic OG image PNG), `GET /api/v1/status`
  - **Cron Trigger**: `*/5 * * * *` — alert detection runs every 5 minutes via scheduled handler (not per-request). Uses KV ID-based dedup (`alerted:new/res:` keys 7d TTL, `alerted:down/degraded/recovered:` keys 2h TTL). Fallback recommendations only included when service status is degraded/down (not operational). AI analysis runs inline with 8s timeout — Gemma 4 26B (Workers AI) primary, Sonnet (AI Gateway) fallback — results stored in `ai:analysis:{svcId}:{incId}` (1h TTL, per-incident). Daily alert counts tracked in `alert:count:{date}` for Daily Summary
- **Frontend deployment**: Vercel, domain ai-watch.dev — `git push origin main` triggers auto-deploy. `npm run build` is local only; changes are not live until pushed
- **PWA**: `public/manifest.json` + `public/sw.js` (stale-while-revalidate). CACHE_NAME in `sw.js` must be bumped manually when static assets change. SW excludes `/is-*` (Edge SSR) and `/api/*` (real-time data) from caching
- **Edge SSR**: `api/is-down.ts` serves "Is X Down?" SEO pages (28 services — all monitored except bedrock + azureopenai which are estimate-only with no differentiated data) via Vercel Edge Functions. Uses `/api/status/cached` (KV-only) for fast SSR (~1.2s). Rank uses competition ranking (`Math.round(score)`-based `findIndex`, not id-based) and applies the same `uptimeSource === 'estimate' && incidents.length === 0` filter as the dashboard Ranking page so SEO rank numbers match what users see. Header meta omits the Uptime segment entirely when `uptime30d` is null (no "Uptime: N/A" surface). Dynamic OG image via Worker `/api/og` (PNG, resvg-wasm). Share buttons: X, Threads, KakaoTalk (SDK async), Copy Link. `vercel.json` rewrites route `/is-{service}-down` to the handler
- **Landing page**: `api/intro.ts` + `api/intro/html-template.ts` — Product Hunt landing page via Vercel Edge Function. `/intro` route (or `?ref=producthunt` for PH banner). Self-contained SSR with inline CSS/JS, KO/EN i18n (client-side toggle), GA4 events, dashboard preview mock. No external data fetch (pure template render)

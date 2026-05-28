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

## API Docs via Context Hub (chub)

This project uses [Context Hub](https://github.com/andrewyng/context-hub) (`chub` CLI) to fetch
current, version-accurate API docs **before writing code against an external API/SDK/library** —
instead of relying on training-cutoff knowledge (anti-hallucination). The global `get-api-docs`
skill auto-triggers this flow.

### Flow
```bash
chub update                          # refresh registry (occasionally)
chub search "<keywords>" --json      # find the right doc id
chub get <id> --lang js              # fetch (always pass --lang)
chub annotate <id> "<gotcha>"        # save discovered gaps — persists across sessions
```

### AIWatch stack coverage (verified present, mostly maintainer-curated)
`react/react` (React 19) · `vite/vite` · `tailwindcss/tailwindcss` (**v4**, CSS-first) ·
`vitest/vitest` · `playwright/playwright` · `typescript/typescript` · `vercel/*` (Edge Functions) ·
`esbuild/esbuild` (transitive via Vite — no direct config to tune)

**Anthropic** is a special case: AIWatch calls the **Messages REST API via the Cloudflare AI Gateway
with raw `fetch()`** (no `@anthropic-ai/sdk` dependency — see `worker/src/ai-analysis.ts`), so reach
for the Anthropic Messages **REST API** doc shape, not an SDK-client doc.

### Cloudflare doc selection (footgun)
For `worker/src/*` runtime code (`env.AI` Gemma binding, KV `STATUS_CACHE` binding, `scheduled`
cron handler, `wrangler.toml`) use **`cloudflare/workers-runtime`** (community). Do **NOT** use
`cloudflare/workers` — that's the REST *management* API (Zones/DNS/script upload), the wrong layer.
(An annotation already flags this on `cloudflare/workers`.)

### Treat docs as orientation, not ground truth for our edge cases
chub gives correct API *shape* but not project-specific battle scars. Example verified in the trial:
the Workers AI doc shows only `res.response`, but `ai-analysis.ts` must also handle the
OpenAI-compatible `res.choices[0].message.content` / `.reasoning` shape (model-dependent) plus
`chat_template_kwargs:{enable_thinking:false}` for Gemma. Save such findings with `chub annotate`.

**chub vs MemPalace**: chub = external API ground-truth (public, shared); MemPalace = this project's
decisions/debugging/feedback (private, project-scoped). Complementary, different layers.

### modern-web-guidance + when-to-use-which
The **`modern-web-guidance`** Claude Code plugin (Google Chrome marketplace) adds Baseline-current
web-platform skills (a11y / Core Web Vitals / modern HTML/CSS/JS); run its skill **first** on any
HTML/CSS/client-JS work. Install: `/plugin marketplace add GoogleChrome/modern-web-guidance` +
`/plugin install modern-web-guidance@googlechrome`. The full trigger map (which of chub vs
modern-web-guidance to run by file path) and the `tooling-trigger.sh` PreToolUse backstop are in
**[docs/reference/reference-tooling.md](docs/reference/reference-tooling.md)**.

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
npm run test:src   # Run frontend unit tests (vitest, src/**/*.test.js)
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
   - **Reachability gate (do this BEFORE handing off to the user)**: confirm the changed surface is actually *exercisable* in the running dev environment. If the change only manifests under a specific data condition — an active/multi-service incident, AI-analysis present, a `down`/`degraded` status, an error/empty state, a feature flag — that condition is usually **absent in live data**, so the user would click and see nothing. In that case, set up the trigger FIRST (force `usePolling` mock data, seed local Worker KV, or craft a fixture), verify *yourself* (Playwright DOM/text extraction is sufficient when screenshots time out) that the change renders, and only then hand off — telling the user exactly which state to look at and how it was triggered. Revert any temporary mock/fixture before commit (`git checkout` the file) and confirm `git status` shows only the intended files. Never tell the user "verify in the browser" for a path you have not confirmed can be reached.
4. **Build + Test** — based on change scope:
   - **Frontend changes** (`src/`): `npm run build` + `npm run test:src` (Vitest, if utility/logic tests exist) + `npm test` (Playwright E2E)
   - **Backend changes** (`worker/`): `npx wrangler deploy --config worker/wrangler.toml --dry-run` + `npm run test:worker` (Vitest)
   - **Both**: run all of the above
   - **Worker logic additions**: new functions must have unit tests — extract to separate files with exports, test in `worker/src/__tests__/` or `worker/src/parsers/__tests__/`
   - **Frontend utility additions** (`src/utils/`): pure-function utilities should have unit tests in `src/utils/__tests__/*.test.js` (Vitest)
   - **Bug fixes**: every bug fix must include a test that would have caught the bug — E2E (Playwright) or Vitest for frontend, Vitest for worker
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
   - `docs/reference/`: KV keys (`kv-schema.md`), GA4 events (`ga4-events.md`), fallback tiers (`fallback-tiers.md`), add-a-service checklist (`adding-a-service.md`) — the detailed reference moved out of CLAUDE.md, so update the relevant file there if affected
   - `README.md` / `README.ko.md`: features, service tables, Project Structure, Available Service IDs
   - `CONTRIBUTING.md`: Project Structure
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

### Workflow-gate hooks (#415)

`.claude/settings.json` wires four enforcement hooks (scripts in `.claude/hooks/`) — because written rules alone (this file + auto-memory) only get probabilistic compliance:
- **`workflow-gates-reminder.sh`** (UserPromptSubmit) — re-injects the 4 non-negotiable gates (text in `.claude/hooks/workflow-gates.txt`) as `additionalContext` on **every turn**. Targets the root cause (rules are passive context loaded once at session start; compaction drops methodology), and is the only hook surface that fires each turn + survives compaction. Soft (cannot block); logged as `inject`. Mirrors memory note `feedback_workflow_gates`.
- **`git-mutation-gate.sh`** (PreToolUse/Bash) — fires before `git commit` / `git push` / `gh pr create` / `gh pr merge`. **Soft** (warns via `systemMessage`, never blocks). The step-3.5 reminder fires on **every** matched mutation (always `warn`) — a running dev server is now only an *informational hint*, **not** a silence condition, because a port probe can't distinguish "the assistant started + curl-checked a server itself" from "the user confirmed in-browser" (the #430 false-pass; #415 2026-05-19 gap). Also flags `--no-verify` / `--no-gpg-sign`.
- **`stop-nag-gate.sh`** (Stop) — reads the just-finished assistant message from the transcript; if its closing line is an auto-proceed nag ("shall I proceed/merge/continue?", "진행할까요?", "다음 작업 진행할까요?", …) it **re-prompts** (`decision: block`) to re-send the closing without the nag. `stop_hook_active` guards the loop.
- **`tooling-trigger.sh`** (PreToolUse/Edit|Write|MultiEdit) — soft path-based reminder (`systemMessage`, never blocks) to run **chub** first on external-integration files or **modern-web-guidance** first on frontend HTML/CSS/JS; the #415 backstop for those skills' probabilistic triggers. Logged as `inject`. Trigger map: **[docs/reference/reference-tooling.md](docs/reference/reference-tooling.md)**.

> **Coverage limit (#415 2026-05-19)**: no `PreToolUse(Bash)` hook can *enforce* step 3.5 — the user's in-browser confirmation is a user message the hook never sees, and the violating action (launching PR review via the `Agent` tool) isn't even a Bash command. The reminder + always-on git-gate raise salience; the actual step-3.5 wait remains **behavioral** (STOP after requesting verification until the user answers).

Every fire is logged to `.claude/hook-audit.jsonl` (gitignored). `npm run hook-audit` (= `node scripts/hook-audit-summary.mjs [--last N] [--days D]`) summarizes (by hook × decision incl. `inject`, last-7-days, per-day trend, recent entries) — review periodically; if `warn`/`block` counts don't trend down, escalate the git gate to a hard block (`permissionDecision: "deny"`) or tune the heuristics/regexes. New `.claude/settings.json` only takes effect after `/hooks` is opened once or a restart (the settings watcher only watches dirs that had a settings file at session start).

### Adding a new service (checklist)

When adding a new monitored service, files across worker, frontend, docs, SEO meta, landing page, Is-X-Down, the reports site, and assets must all update together (service count + sync invariants). Follow the full 34-step checklist in **[docs/reference/adding-a-service.md](docs/reference/adding-a-service.md)** — do not skip steps.

## Architecture

**AIWatch** is a React SPA that monitors 33 AI services in real time:
- **24 API services**: Claude, OpenAI, Gemini, Mistral, Cohere, Groq, Together, Fireworks, Cerebras, Perplexity, HuggingFace, Replicate, ElevenLabs, AssemblyAI, Deepgram, xAI, DeepSeek, OpenRouter, Bedrock, Azure OpenAI, Pinecone, Stability AI, Voyage AI, Modal
- **3 AI apps**: claude.ai, ChatGPT, Character.AI
- **6 coding agents**: Claude Code, Codex, Cursor, GitHub Copilot, Windsurf, Junie

### Tech Stack
- **React 19 + Vite 6** — SPA, no router library
- **TailwindCSS v4** — utility classes + CSS custom properties for design tokens (see below)
- **Cloudflare Workers** — status polling proxy with KV cache
- **Cloudflare Workers AI** — Gemma 4 26B incident analysis (primary, via `[ai]` binding)
- **Cloudflare KV** — daily uptime counters, status cache, history archival

### KV Key Schema (STATUS_CACHE namespace)

The full KV reference (40+ keys: pattern, value, TTL, writes/day, purpose) and the monthly write budget live in **[docs/reference/kv-schema.md](docs/reference/kv-schema.md)**. Read it before adding or changing any KV key.

### Directory Layout
```
api/
  intro.ts          # Landing page Edge Function (/intro) — dashboard mock; ?banner=<key> announcement slot
  intro/
    html-template.ts # SSR HTML template (i18n, dashboard mock, GA4)
    announcements.ts # Reusable campaign-banner config + resolver (?banner=<key>, #265) — empty by default
  is-down.ts        # "Is X Down?" Edge Function (31 services — excludes bedrock/azureopenai per #263)
  reports.ts        # Monthly Reports proxy (/reports/* → bentleypark.github.io/aiwatch-reports/*, fetched directly to bypass the Cloudflare 301 on the public reports.ai-watch.dev hostname) with HTML path rewriting (#264)
src/
  components/   # Shared UI: StatusPill, SkeletonUI, EmptyState, Modal, Sidebar, Topbar, CookieBanner, AnalysisModal
  pages/        # Overview, Latency, Incidents, Uptime, ServiceDetails, Settings, AboutScore, Ranking
  hooks/        # usePolling, useTheme, useLang, useSettings, useGitHubStars
  utils/        # analytics, calendar, time, pageContext, constants, webhookAlerts (browser-side per-user Discord delivery, #467), webhookRegistration
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
    rss.ts      # Incident RSS 2.0 feed generation (#54) — buildFeedResponse (400/404/503/200 decision), buildRssFeed, feedSlug↔is-down-slug map (pinned by feed-slug-sync.test.ts)
    og.ts       # OG image SVG generator (1200×630 for social share)
    og-render.ts # SVG → PNG conversion (resvg-wasm, Inter font from CDN)
    alerts.ts   # Alert detection logic (buildIncidentAlerts, buildServiceAlerts, formatDetectionLead, buildRegionHint). buildRegionHint (#422 Phase 2) reuses the Edge region-status port (api/is-down/region-status.ts) — imported, not re-copied — to append a "📍 Try region: <label>" line to new-incident Discord embeds for region-aware services with a region-specific partial outage
    fallback.ts # Fallback recommendation (getFallbacks, buildFallbackText, buildGroupedFallbackText for multi-category incidents)
    ai-analysis.ts # Hybrid AI incident analysis — Gemma 4 26B (Workers AI) primary + Claude Sonnet (AI Gateway) fallback (system/user prompt, needsFallback assessment, TTL refresh, re-analysis, incidentId dedup, timeline context, boilerplate filtering, formatRecoveryDisplay)
    changelog.ts # Changelog/news collection (OpenAI blog RSS, Google AI blog RSS, Anthropic /news HTML parsing) — 15s timeout + 1 retry on transient errors, per-source last-fetch KV markers for stale-source detection (#274)
    weekly-briefing.ts # Weekly Discord briefing (changelog + incidents + stability trends)
    daily-summary.ts # Expanded daily Discord report (uptime, latency, AI usage, Reddit, Web Vitals)
    monthly-archive.ts # Monthly reliability archive (uptime, score, incidents, latency per service, permanent KV)
    monthly-narrative.ts # AI retrospective narrative (Notable Incidents + Observations draft) baked into the archive — hybrid Gemma→Sonnet, #426
    vitals.ts   # Web Vitals aggregation (ingest, KV flush, p75 computation, Discord formatting)
    probe.ts    # Health check probing — direct RTT measurement (20 API services)
    probe-archival.ts # Daily probe RTT archival + 7-day summary (p50, p95, cvCombined)
    platform-monitor.ts # Status page platform health monitoring (metastatuspage.com for Atlassian)
    detection.ts # Detection Lead entry parsing + incident-aware reset logic
    detection-lead-log.ts # Detection Lead audit log — per-day KV array (#256), tagged AppendResult, 24h sliding window for daily summary. Also `classifyLead` + `detection:lead:diag:{date}` counter (#464): measures why leads are/aren't recorded (no_detected/negative/below_min/in_window/above_max × probe/non-probe), surfaced in daily summary
    reddit.ts   # Reddit r/ChatGPT + r/netsec + r/cybersecurity monitoring
    security-monitor.ts # AI service security monitoring (HN Algolia, OSV.dev SDK vulnerabilities — 24 tracked packages across PyPI + npm including Langchain ecosystem adapters, see OSV_PACKAGES; two-phase flow: querybatch bulk scan + per-vuln GET enrichment, capped at OSV_MAX_DETAIL_FETCH=15/cycle to protect the Workers subrequest budget; overflow re-offered next cron since seen-markers are only written for surfaced alerts)
    parsers/    # Platform-specific parsers (statuspage, incident-io, gcloud, aistudio, instatus, betterstack, aws)
                # dailyImpact support: statuspage (uptimeData), incident-io (component impacts), betterstack (status_history from index.json)
                # impact-weights.ts: shared MAJOR_WEIGHT=1.0, MINOR_WEIGHT=0.3 — used by both statuspage.ts (official) and incident-io.ts (estimate from durations) for Atlassian-aligned uptime%
                # aistudio.ts (#310): parses aistudio.google.com/status MakerSuite gRPC-web JSON. API key + Referer gated; component filter at source (API=1). Merged via mergeAistudioIncidents() in services.ts with vertex:/aistudio: ID prefixes; filterIncidents() bypasses incidentKeywords for aistudio: IDs since they're already component-scoped. Fetch/parse failures silently fall back to vertex-only output.
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

All events use `trackEvent()` from `src/utils/analytics.js`; GA4 activates only on cookie consent (`aiwatch-cookie-consent` localStorage key, shared across SPA / Edge SSR / Jekyll). The cross-surface consent flow (#352), the full event catalog (parameters · location · purpose), and the reports-site events are in **[docs/reference/ga4-events.md](docs/reference/ga4-events.md)**. Read it before adding/changing analytics events or touching consent logic.

### Service Status Determination
Per-service status is resolved in `worker/src/services.ts` with a layered priority chain (multi-component worst-of → component match → overall-indicator fallback → `incidentExclude` bypass → component-status filter → fetch-failure cross-validation). The full ordered rules and their #-issue rationale are in **[docs/reference/status-determination.md](docs/reference/status-determination.md)** — read it before changing status resolution.

### Status Data Flow
Browser (60s polling) → Worker `/api/status` (parallel 33-service fetch, normalize, KV write, platform/probe cross-validation) → React state → pages. Cron (`*/5`) handles probing, incident detection + Discord alerts, AI analysis, daily/monthly aggregation, changelog/security/weekly briefing. The full annotated request + cron + Web Vitals flow diagram is in **[docs/reference/data-flow.md](docs/reference/data-flow.md)**.

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
  - **Contextual fallback** (`needsFallback`): AI analysis includes a boolean flag assessing if an incident warrants switching to an alternative. Gating differs per surface (#454): the **AnalysisModal + Overview ActionBanner gate the Score-based fallback list on service status** (`down`/`degraded`) via `shouldShowFallback()` — NOT on `needsFallback` — because the AI classifies partial degradation as `needsFallback:false`, which previously hid the modal's recommendations for degraded incidents while Overview still showed them. The **Is X Down AI Insight card** (`api/is-down/html-template.ts`) and **Discord alerts** still gate on `needsFallback`. Shared `getFallbacks()` / `shouldShowFallback()` utilities in `src/utils/constants.js` (used by AnalysisModal + Overview)
  - Grouped fallback: when incident affects multiple categories, Discord alerts + dashboard show per-category alternatives via `buildGroupedFallbackText`
  - **Fallback tier priority**: same-tier first, then adjacent tiers by distance, Score-descending within a tier. Defined in `worker/src/fallback.ts`, mirrored in `src/utils/constants.js` + `api/is-down.ts`; drift pinned by `worker/src/__tests__/api-tier-sync.test.ts`. Tier ranges: API **1** Major LLM / **2** LLM / **3** Infra / **4** Voice; agents **11** CLI / **12** IDE / **13** Plugin; apps **21**. Full tier membership, the `tierFor`/`tierLabelFor` warn-once rationale, and the #402/#403 (Junie-as-#1) history are in **[docs/reference/fallback-tiers.md](docs/reference/fallback-tiers.md)**.
  - `EXCLUDE_FALLBACK` services are excluded from both source and candidate lists (keep in sync across `worker/src/fallback.ts`, `src/utils/constants.js`, `api/is-down.ts`): `replicate`, `huggingface`, `pinecone`, `stability`, `voyageai`, `modal`, `characterai`, `bedrock`, `azureopenai`
  - **Estimate-only services** (`uptimeSource === 'estimate'` + 0 incidents): `bedrock`, `azureopenai` — hidden from Ranking, Uptime rankings, fallback recommendations, category averages. Dashboard shows "— Not provided" instead of misleading 100% uptime
- Status polling proxy: `worker/` directory (monorepo), Cloudflare Workers
  - `cd worker && npm run dev` — local dev (port 8787)
  - **Worker deployment rules** (Workers Paid / Standard — 1M KV writes/month included; repeated deploys still reset per-isolate throttling, so minimize unnecessary redeploys to stay well inside the monthly allowance):
    1. During development → `npx wrangler dev --config worker/wrangler.toml --port 8788` (local test only, never deploy)
    2. Before deploy → `npx wrangler deploy --config worker/wrangler.toml --dry-run` (build check)
    3. Deploy → after commit + user approval, **once only** `npm run deploy:worker`
    4. No repeated deploys — each Worker deployment resets the isolate, resetting KV write throttle
  - **IMPORTANT**: Always use the npm script to deploy the worker — never run `wrangler deploy` or `cd worker && wrangler deploy` directly (both pick up the wrong config and deploy the SPA):
    ```
    npm run deploy:worker
    ```
  - Verify the output says `Uploaded aiwatch-worker` (not `aiwatch`)
  - Endpoints: `GET /api/status`, `GET /api/status/cached` (KV-only, includes probe24h, for SSR + initial load; **`?src=statusline-*` returns a ~KB id/name/status-only projection** via `buildStatuslinePayload` in `worker/src/statusline.ts` — skips the ~2 MB probe/latency/AI reads. Statusline snippets (#400) poll this with the tag and target the Worker domain directly, not the Vercel-proxied `ai-watch.dev` path, so per-prompt polls don't burn Vercel Fast Data Transfer — #438), `GET /api/uptime?days=30`, `GET /api/probe/history?days=30` (daily probe RTT summaries, 90d max), `GET /api/report?month=YYYY-MM` (monthly archive JSON, permanent), `POST /api/alert`, `POST /api/admin/analyze` (operator Sonnet override, `X-Admin-Key` required, sets `sticky: true` so cron doesn't auto-replace), `POST /api/admin/rebuild-archive` (operator regenerate of `archive:monthly:{YYYY-MM}` after a bug-fix deploy, `X-Admin-Key` required), `POST /api/internal/edge-fallback` (Bearer-authenticated `EDGE_ALERT_TOKEN`; called by Vercel Edge Functions on degraded fallback render, dedups via `alerted:edge-fallback:*` and fires Discord — #378), `GET /badge/:serviceId`, `GET /api/og` (dynamic OG image PNG), `GET /api/v1/status`, `GET /feed.xml` (all-services incident RSS 2.0; served as `text/xml` with an `<?xml-stylesheet href="/feed.xsl"?>` PI so browsers render a friendly page — #467), `GET /feed/:slug` (per-service incident RSS — slug matches `/is-{slug}-down`; KV-unavailable → 503, unknown slug → 404 — #54), `GET /feed.xsl` (static client-side XSLT for feed rendering, #467)
  - **Operator tools — `POST /api/admin/analyze` (#299)**: Force a Sonnet analysis on a specific active incident when the cron's default (Gemma-first) produced low-signal output. Auth via `X-Admin-Key` (`ADMIN_API_KEY` secret); accepts only IDs matching an active incident in `services:latest` (scope guard), per-incident rate-limited, `sticky:true` by default so cron won't auto-replace. Use the `scripts/admin-analyze.mjs` helper, not raw curl. Full runbook (secret setup, flags, request/response, failure codes, security posture) in **[docs/reference/operator-tools.md](docs/reference/operator-tools.md)**.
  - **Cron Trigger**: `*/5 * * * *` — alert detection runs every 5 minutes via scheduled handler (not per-request). Uses KV ID-based dedup (`alerted:new/res:` keys 7d TTL, `alerted:down/degraded/recovered:` keys 2h TTL). Fallback recommendations only included when service status is degraded/down (not operational). AI analysis runs inline with 8s timeout — Gemma 4 26B (Workers AI) primary, Sonnet (AI Gateway) fallback — results stored in `ai:analysis:{svcId}:{incId}` (1h TTL, per-incident). Daily alert counts tracked in `alert:count:{date}` for Daily Summary
  - **Two Discord alert paths** (#467): (1) **operator** — the cron above posts to the single `env.DISCORD_WEBHOOK_URL` secret (always on for the operator). (2) **per-user** — a visitor's own Discord webhook (entered in Settings → Alerts) is delivered **browser-side** by `src/utils/webhookAlerts.js` (`runWebhookAlerts`, called from `usePolling` on each live poll — 60s while the tab is visible, 5min when hidden — so only while a tab is open). The two target *different* webhooks so there's no cross-source duplicate. The server stores only a SHA-256 hash of the user URL (`webhook:reg:{hash}`, count-only — no raw URL persisted), so delivery must be browser-side; `/api/alert` is just a CORS/SSRF-guarded Discord proxy (Discord hosts only, #468). The browser path mirrors operator formatting: status↔incident dedup (#473), multi-service grouping `{provider} ({names})`, per-category `getGroupedFallbacks`, AI-analysis section, and `sanitizeForDiscord` (#474). Slack subscriptions use Slack's native `/feed` RSS app (no per-user webhook). A worker-formatted-payload refactor to delete the browser/operator formatting duplication is tracked in #475. Status-change vs incident gating honors `alertCondition` (`down`/`all`, #470) + `alertTarget` (`all`/`custom` service picker) + `alertIncidents` (default on)
- **Frontend deployment**: Vercel, domain ai-watch.dev — `git push origin main` triggers auto-deploy. `npm run build` is local only; changes are not live until pushed
- **PWA**: `public/manifest.json` + `public/sw.js` (stale-while-revalidate). CACHE_NAME in `sw.js` must be bumped manually when static assets change. SW excludes `/is-*` (Edge SSR) and `/api/*` (real-time data) from caching. **Registered in production only** (`src/main.jsx` gates on `import.meta.env.PROD`); in dev the SW is proactively unregistered because its stale-while-revalidate cache serves previously-cached `/src/*` modules and masks source edits (#432). Verify SW behavior via `npm run build && npm run preview`, not `npm run dev`
- **Edge SSR**: `api/is-down.ts` serves "Is X Down?" SEO pages (31 services — all monitored except bedrock + azureopenai which are estimate-only with no differentiated data) via Vercel Edge Functions. Uses `/api/status/cached` (KV-only) for fast SSR (~1.2s). Rank uses competition ranking (`Math.round(score)`-based `findIndex`, not id-based) and applies the same `uptimeSource === 'estimate' && incidents.length === 0` filter as the dashboard Ranking page so SEO rank numbers match what users see. Header meta omits the Uptime segment entirely when `uptime30d` is null (no "Uptime: N/A" surface). Dynamic OG image via Worker `/api/og` (PNG, resvg-wasm). Share buttons: X, Threads, KakaoTalk (SDK async), Copy Link. `vercel.json` rewrites route `/is-{service}-down` to the handler
- **Landing page**: `api/intro.ts` + `api/intro/html-template.ts` — landing page via Vercel Edge Function. `/intro` route. Self-contained SSR with inline CSS/JS, KO/EN i18n (client-side toggle), GA4 events, dashboard preview mock. No external data fetch (pure template render). Optional campaign banner via `?banner=<key>` resolved against `api/intro/announcements.ts` (empty by default — replaced the time-bound Product Hunt banner, #265)
- **Monthly Reports proxy**: `api/reports.ts` — Vercel Edge Function that proxies `/reports/*` on `ai-watch.dev` to the aiwatch-reports Jekyll site (#264). Fetches directly from `bentleypark.github.io/aiwatch-reports/` rather than the public `reports.ai-watch.dev` subdomain so a Cloudflare Page Rule can 301 the public subdomain to `ai-watch.dev/reports/` without trapping the proxy in a redirect loop (proxy fetch and the 301'd public hostname must not share a hostname). The aiwatch-reports repo therefore must NOT carry a `CNAME` file pointing at `reports.ai-watch.dev`. Consolidates SEO + GA4 under a single apex domain. `vercel.json` needs four explicit rewrites (`/reports`, `/reports/`, `/reports/:rest*`, `/reports/:rest*/`) because path-to-regexp's `:rest*` does not match trailing-slash paths in Vercel's router. Denylist header filtering (strips `content-encoding`, upstream server IDs, hop-by-hop headers), 10s timeout, `s-maxage=600` edge cache when upstream omits a directive, 502 error page on upstream failure (does not fall back to the SPA so operators can distinguish "report missing" from "proxy broken")

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
npm run typecheck:worker # tsc gate — fails on undefined-name/missing-import (TS2304) in worker source (#533)
npm run test:scripts # node:test unit tests for scripts/*.mjs (e.g. verify-reminders, #541)
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

> **IMPORTANT**: The full step-by-step runbook (each step's detail, the 4 non-negotiable gates, and
> the cross-issue / refs-not-closes / deferred-reverify / label-exit hygiene) lives in the
> **`ship-issue` skill** (`.claude/skills/ship-issue/`) — **invoke it at the START of issue work and
> BEFORE closing**. This outline is the map; the skill is the runbook. The #415 hooks re-inject the
> gates every turn regardless. Never skip review or tests.

### Per-issue process — outline (full runbook: invoke the `ship-issue` skill)

0. **Review** — invoke `ship-issue`; re-read the issue checklist (`gh issue view N`)
1. **Branch** from main: `git checkout -b {type}/{issue#}-{desc}` — never commit to main; `git status` must show only intended files
2. **Design check** (UI only) — diff against `docs/AIWatch_화면디자인_초안_v2.html`; list every difference first
3. **Code**
3.5. **Local verify** — start the right dev server (see "Local verification by page type"); get the USER's **in-browser confirmation** (curl/Playwright/tests do NOT count). Reachability gate: if the change needs a specific state (incident / `down` / error / flag), set up the trigger + verify yourself first, revert it before commit. **STOP and wait.**
4. **Build + test** by scope — frontend: `npm run build` + `npm run test:src` + `npm test`; worker: `npx wrangler deploy --config worker/wrangler.toml --dry-run` + `npm run test:worker` + `npm run typecheck:worker` (the dry-run uses esbuild — it does **not** type-check, so the TS2304 gate is what catches a missing import like #532). New worker/util logic → exported fn + unit test; **every bug fix → a test that catches it**
5. **PR review** before commit — `/pr-review-toolkit:review-pr`
6. **Fix → re-test → re-review, auto-loop** until 0 Critical/Important (Suggestions-only = converged)
7. **Docs update** — CLAUDE.md (lean, **~40k-char guideline**; detail → `docs/reference/`), the relevant `docs/reference/*`, README(.ko), `CONTRIBUTING.md`, `index.html` SEO, `aiwatch-reports/`
8. **Commit + PR** (only after the user confirms) — footer required; `closes #N` only when every item is done **and verified** (time/prod-gated verification = remaining → `refs`); also reconcile OTHER open issues this change closes / supersedes / invalidates
9. **Verify Vercel Preview** (frontend)
10. **Merge** `gh pr merge --squash --delete-branch` — worker deploy is manual (`npm run deploy:worker`, once, after approval; batch multi-PR deploys)
11. **Verify checklist** against code before closing; periodically re-verify `deferred`/`tracking` issues (later work may have completed one)
12. **Close** only after verification; deferred items → keep open with a label carrying a **written exit condition**. Production-data check needed after a delay → add a `- [ ] **verify-after YYYY-MM-DD** — …` line; the daily `verify-reminders` Action (`.github/workflows/verify-reminders.yml` + `scripts/verify-reminders.mjs`, #541) pings the operator Discord when due so the check isn't missed

> Never close an issue immediately after merging. Verify each checklist item against the code first; deferred → keep open with a labeled exit condition.

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

Every fire is logged to `.claude/hook-audit.jsonl` (gitignored). `npm run hook-audit` (= `node scripts/hook-audit-summary.mjs [--last N] [--days D]`) summarizes (by hook × decision, last-7-days, per-day trend, recent entries). **The effectiveness signal is the `Violations intercepted` tally, NOT raw `warn`/`inject` counts**: `warn` (git-mutation step-3.5 reminder) and `inject` (every-turn gate re-injection) are *preventive telemetry* that scale with workload — their trend is meaningless. A real intercepted violation is only `block` (a nag was about to ship) or a `no_verify=1` note (`--no-verify`/`--no-gpg-sign` on a commit). Review the **violation trend** periodically — a declining/zero count is the goal; if violations *don't* trend down, escalate the git gate to a hard block (`permissionDecision: "deny"`) or tune the heuristics/regexes. Caveat (#415's own coverage gap): step-3.5 violations — advancing without the user's in-browser confirmation — are invisible to hooks (the confirmation is a user message the hook never sees), so the violation tally is a **floor, not a total**. New `.claude/settings.json` only takes effect after `/hooks` is opened once or a restart (the settings watcher only watches dirs that had a settings file at session start).

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
  utils/        # analytics, calendar, time, pageContext, constants, webhookSubscription (client for the server-side per-user Discord subscription endpoints, #486)
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
    rss.ts      # Incident RSS 2.0 feed generation (#54) — buildFeedResponse (400/404/503/200 decision), buildRssFeed, feedSlug↔is-down-slug map (pinned by feed-slug-sync.test.ts). /feed.xml collapses a multi-surface incident to one item via dedupeSharedIncidents (#520)
    api-traffic.ts # /api/v1 traffic WAE instrumentation (#518) — recordV1Traffic (write per request) + queryV1Traffic (AE SQL read-back for the daily report; needs CF_ACCOUNT_ID + CF_ANALYTICS_TOKEN secrets)
    og.ts       # OG image SVG generator (1200×630 for social share)
    og-render.ts # SVG → PNG conversion (resvg-wasm, Inter font from CDN)
    alerts.ts   # Alert detection logic (buildIncidentAlerts, buildServiceAlerts, formatDetectionLead, buildRegionHint, buildTweetDrafts). buildIncidentAlerts dedups per-SERVICE against `alertedNewMap` (incId→Set<svcId>, the `alerted:new:` roster parsed by `parseAlertedRoster`), so a service JOINING a multi-service incident after the first alert fired (e.g. ChatGPT joining a renamed Codex incident, #545) still gets its own alert; `AlertCandidate.svcIds` carries that scoped set so buildTweetDrafts + the per-user feed (alert-feed.ts) target only the joiner, not every service sharing the incidentId. buildRegionHint (#422 Phase 2) reuses the Edge region-status port (api/is-down/region-status.ts) — imported, not re-copied — to append a "📍 Try region: <label>" line to new-incident Discord embeds for region-aware services with a region-specific partial outage. buildTweetDrafts (#348 Phase 1.5 / #521) returns one X compose (Web Intent) link per affected Claude/OpenAI-family service (claude/openai/claudeai/chatgpt/claudecode/codex; slugs pinned by tweet-draft-slug-sync.test.ts) so the operator picks which surface to post; appendTweetDraftSection length-guards it under Discord's 4096 limit — operator embed only, never the per-user relay. `defuseAutolinkDomain` (#535→#539, exported from alerts.ts, used by rss.ts + reddit.ts too) renders the bare `claude.ai` brand as `claude ai` everywhere it reaches a social surface as plain text — the operator embed (title+desc+tweet blockquote/label, #535) AND the tweet/RSS/Reddit message **text + intent URL** (#539, since the operator pastes the tweet into Slack where a bare domain auto-links). `appendStatusHint(url, hint)` (#539, utils.ts) appends `?e=resolved|active|down|degraded` (Reddit: `?e=reddit`) to the shared is-X-down link so a recovery share is a DISTINCT URL from the outage share → social platforms (which cache the OG unfurl by page URL) re-fetch a fresh card instead of showing the stale one; the is-down Edge ignores the param and the canonical stays clean
    fallback.ts # Fallback recommendation (getFallbacks, buildFallbackText, buildGroupedFallbackText for multi-category incidents)
    ai-analysis.ts # Hybrid AI incident analysis — Gemma 4 26B (Workers AI) primary + Claude Sonnet (AI Gateway) fallback (system/user prompt, needsFallback assessment, TTL refresh, re-analysis, incidentId dedup, timeline context, boilerplate filtering, formatRecoveryDisplay)
    changelog.ts # Changelog/news collection (OpenAI blog RSS, Google AI blog RSS, Anthropic /news HTML parsing) — 15s timeout + 1 retry on transient errors, per-source last-fetch KV markers for stale-source detection (#274)
    weekly-briefing.ts # Weekly Discord briefing (changelog + incidents + stability trends)
    daily-summary.ts # Expanded daily Discord report (uptime, latency, AI usage, Reddit, Web Vitals)
    monthly-archive.ts # Monthly reliability archive (uptime, score, incidents, latency per service, permanent KV). Also aggregates detection:lead:monthly (#369) + probe-degradation:monthly (#511, RTT degradation total/noStatus via summarizeDegradation) into MonthlyArchive, exposed by /api/report
    monthly-narrative.ts # AI retrospective narrative (Notable Incidents + Observations draft) baked into the archive — hybrid Gemma→Sonnet, #426
    vitals.ts   # Web Vitals aggregation (ingest, KV flush, p75 computation, Discord formatting)
    probe.ts    # Health check probing — direct RTT measurement (20 API services)
    probe-archival.ts # Daily probe RTT archival + 7-day summary (p50, p95, cvCombined)
    platform-monitor.ts # Status page platform health monitoring (metastatuspage.com for Atlassian)
    detection.ts # Detection Lead entry parsing + incident-aware reset logic
    detection-lead-log.ts # Detection Lead audit log — per-day KV array (#256), tagged AppendResult, 24h sliding window. `classifyLead` + `detection:lead:diag:{date}` counter (#464) measures why leads are/aren't recorded; `formatLeadDiagSection`/`formatDegradationSection` render the daily-summary lines. The #464 redefinition (status-page polling structurally later than official publish → retire "faster than official"; honest framing = MTTD + RTT degradation detection; aggregate avg gated by `MIN_LEAD_SAMPLE_SIZE`/`canPresentLeadAverage`) is detailed on the `detection:lead:diag` row in [docs/reference/kv-schema.md](docs/reference/kv-schema.md)
    alert-feed.ts # Canonical per-user alert feed (#475) — cron appends each operator embed it sends to `alert:feed:recent` KV; `/api/status` surfaces it as `alertFeed` so the dashboard relays byte-identical alerts to a visitor's own Discord webhook (kindFromKey, svcIdsForAlert, buildFeedEntry, appendAlertFeed, readAlertFeed)
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
  - Re-analysis: re-triggers if expired/missing (max 2/cron, 30min cooldown on failure) + after 2h for long-running incidents (safe overwrite; timeline updates feed the prompt). Timeline-aware skip via stored `timelineHash` — skips when timeline unchanged or new entries are all boilerplate (`isBoilerplate()`)
  - Dedup: sibling services sharing same incidentId copy analysis from KV (no extra API call)
  - Modal groups services with same incidentId into single card
  - API response: `aiAnalysis: Record<svcId, AIAnalysisResult[]>` — array per service
  - **Recently Resolved**: on recovery, cron writes independent `recovered:{svcId}:{incId}` KV (2h TTL) regardless of AI analysis. Also marks per-incident analysis keys with `resolvedAt` field if they exist. `/api/status` returns `recentlyRecovered: Record<svcId, incId[]>` for operational services with recovery markers. Dashboard shows info banner (service names link to detail page) + "Recently Resolved" badge on specific incidents in ServiceDetails + Analyze modal link only when AI analysis exists. "See details in Analyze" hidden when no AI analysis data
  - **Contextual fallback** (`needsFallback`): AI analysis includes a boolean flag assessing if an incident warrants switching to an alternative. Gating differs per surface (#454): the **AnalysisModal + Overview ActionBanner gate the Score-based fallback list on service status** (`down`/`degraded`) via `shouldShowFallback()` — NOT on `needsFallback` — because the AI classifies partial degradation as `needsFallback:false`, which previously hid the modal's recommendations for degraded incidents while Overview still showed them. The **Is X Down AI Insight card** (`api/is-down/html-template.ts`) and **Discord alerts** still gate on `needsFallback`. Shared `getFallbacks()` / `shouldShowFallback()` utilities in `src/utils/constants.js` (used by AnalysisModal + Overview)
  - Grouped fallback: when incident affects multiple categories, Discord alerts + dashboard show per-category alternatives via `buildGroupedFallbackText`
  - **Fallback tier priority**: same-tier first, then adjacent tiers by distance, Score-descending within a tier. Defined in `worker/src/fallback.ts`, mirrored in `src/utils/constants.js` + `api/is-down.ts`; drift pinned by `worker/src/__tests__/api-tier-sync.test.ts`. Tier ranges: API **1** Major LLM / **2** LLM / **3** Infra / **4** Voice; agents **11** CLI / **12** IDE / **13** Plugin; apps **21**. A candidate must be operational **AND** carry no unresolved incident (#550 — a service can stay `operational` with an active investigating/identified/monitoring incident; recommending it would contradict the same screen's incident banner). Full tier membership, candidate eligibility, the `tierFor`/`tierLabelFor` warn-once rationale, and the #402/#403 (Junie-as-#1) history are in **[docs/reference/fallback-tiers.md](docs/reference/fallback-tiers.md)**.
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
  - Endpoints: status (`/api/status`, `/api/status/cached` incl. `?src=statusline-*` lite projection, `/api/uptime`, `/api/probe/history`, `/api/report`, `/api/v1/status`), badges/images (`/badge/:id`, `/api/og`), incident RSS (`/feed.xml`, `/feed/:slug`, `/feed.xsl`), alerts/operator/internal (`/api/alert`, `/api/admin/analyze`, `/api/admin/rebuild-archive`, `/api/internal/edge-fallback`). Full per-endpoint reference (auth, projections, dedup, #-rationale) in **[docs/reference/api-endpoints.md](docs/reference/api-endpoints.md)**
  - **Operator tools — `POST /api/admin/analyze` (#299)**: Force a Sonnet analysis on a specific active incident when the cron's default (Gemma-first) produced low-signal output. Auth via `X-Admin-Key` (`ADMIN_API_KEY` secret); accepts only IDs matching an active incident in `services:latest` (scope guard), per-incident rate-limited, `sticky:true` by default so cron won't auto-replace. Use the `scripts/admin-analyze.mjs` helper, not raw curl. Full runbook (secret setup, flags, request/response, failure codes, security posture) in **[docs/reference/operator-tools.md](docs/reference/operator-tools.md)**.
  - **Cron Trigger**: `*/5 * * * *` — alert detection runs every 5 minutes via scheduled handler (not per-request). Uses KV ID-based dedup (`alerted:new/res:` keys 7d TTL, `alerted:down/degraded/recovered:` keys 2h TTL). Fallback recommendations only included when service status is degraded/down (not operational). AI analysis runs inline with 8s timeout — Gemma 4 26B (Workers AI) primary, Sonnet (AI Gateway) fallback — results stored in `ai:analysis:{svcId}:{incId}` (1h TTL, per-incident). Daily alert counts tracked in `alert:count:{date}` for Daily Summary. On a status-change edge (an alert fired) the cron also refreshes the `services:latest` cache from the live data it just fetched (#488, `cache-refresh.ts`), bypassing the 10-min `cacheWrite` throttle, so OG/SEO previews (`/api/status/cached` readers) reflect the incident within one cron cycle instead of lagging the throttle
  - **Discord alert delivery** (operator + per-user paths): both the operator webhook and confirmed per-user webhooks are delivered **server-side** by the `*/5` cron. Full annotated description — single-source-of-truth `alert:feed:recent`, per-user filters (`alertCondition`/`alertTarget`/`alertIncidents`), the #486 channel-control double opt-in (AES-GCM-encrypted URL storage), the PR3 cutover that retired the browser relay, and the #348 Phase 1.5 operator-only `🐦 TWEET DRAFT` exception (6 Claude/OpenAI-family services) — lives in **[docs/reference/discord-alert-paths.md](docs/reference/discord-alert-paths.md)**.
- **Frontend deployment**: Vercel, domain ai-watch.dev — `git push origin main` triggers auto-deploy. `npm run build` is local only; changes are not live until pushed
- **PWA**: `public/manifest.json` + `public/sw.js` (stale-while-revalidate). CACHE_NAME in `sw.js` must be bumped manually when static assets change. SW excludes `/is-*` (Edge SSR) and `/api/*` (real-time data) from caching. **Registered in production only** (`src/main.jsx` gates on `import.meta.env.PROD`); in dev the SW is proactively unregistered because its stale-while-revalidate cache serves previously-cached `/src/*` modules and masks source edits (#432). Verify SW behavior via `npm run build && npm run preview`, not `npm run dev`
- **Edge SSR**: `api/is-down.ts` serves "Is X Down?" SEO pages (31 services — all monitored except bedrock + azureopenai which are estimate-only with no differentiated data) via Vercel Edge Functions. Uses `/api/status/cached` (KV-only) for fast SSR (~1.2s). Rank uses competition ranking (`Math.round(score)`-based `findIndex`, not id-based) and applies the same `uptimeSource === 'estimate' && incidents.length === 0` filter as the dashboard Ranking page so SEO rank numbers match what users see. Header meta omits the Uptime segment entirely when `uptime30d` is null (no "Uptime: N/A" surface). Dynamic OG image via Worker `/api/og` (PNG, resvg-wasm). Share buttons: X, Threads, KakaoTalk (SDK async), Copy Link. `vercel.json` rewrites route `/is-{service}-down` to the handler
- **Landing page**: `api/intro.ts` + `api/intro/html-template.ts` — landing page via Vercel Edge Function. `/intro` route. Self-contained SSR with inline CSS/JS, KO/EN i18n (client-side toggle), GA4 events, dashboard preview mock. No external data fetch (pure template render). Optional campaign banner via `?banner=<key>` resolved against `api/intro/announcements.ts` (empty by default — replaced the time-bound Product Hunt banner, #265)
- **Monthly Reports proxy**: `api/reports.ts` — Vercel Edge Function that proxies `/reports/*` on `ai-watch.dev` to the aiwatch-reports Jekyll site (#264). Fetches directly from `bentleypark.github.io/aiwatch-reports/` rather than the public `reports.ai-watch.dev` subdomain so a Cloudflare Page Rule can 301 the public subdomain to `ai-watch.dev/reports/` without trapping the proxy in a redirect loop (proxy fetch and the 301'd public hostname must not share a hostname). The aiwatch-reports repo therefore must NOT carry a `CNAME` file pointing at `reports.ai-watch.dev`. Consolidates SEO + GA4 under a single apex domain. `vercel.json` needs four explicit rewrites (`/reports`, `/reports/`, `/reports/:rest*`, `/reports/:rest*/`) because path-to-regexp's `:rest*` does not match trailing-slash paths in Vercel's router. Denylist header filtering (strips `content-encoding`, upstream server IDs, hop-by-hop headers), 10s timeout, `s-maxage=600` edge cache when upstream omits a directive, 502 error page on upstream failure (does not fall back to the SPA so operators can distinguish "report missing" from "proxy broken")

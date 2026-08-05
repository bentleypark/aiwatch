# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Persistent Memory (LLM Wiki / OKF)

Persistent memory is a **file-based LLM Wiki** (Karpathy's pattern, formalized by Google's Open Knowledge Format) in the harness memory dir `~/.claude/projects/-Users-bentley-Desktop-bentely-aiwatch-aiwatch/memory/` — markdown concept files + a `MEMORY.md` index + a `log.md` history + `[[wikilinks]]`. No vector DB: read the index, load the relevant pages. **MemPalace MCP is retired (#891)** — it was ~98.7% raw code-dump noise, dual-wrote the file memory, and its semantic search returned noise. Retirement is completed by a paired **local cutover** (remove the `mempalace` MCP server from `.claude/mcp.json` and global `~/.claude.json`, rewire the `SessionStart`/`PreCompact` hooks in `.claude/settings.local.json` off the mempalace tools, delete `.mempalace/`) — those are gitignored local/data files, not part of this PR. Single system.

### Three operations
- **query** — before answering about past decisions / architecture history / debugging context (or when the user references past work: "지난번에", "이전에", "아까"), read `MEMORY.md` and load the relevant pages. Session-start memory auto-load is native; a `SessionStart` hook in `settings.local.json` may also nudge it.
- **ingest** — run the `memory-ingest` skill (manually, or on the `PreCompact` hook if wired in `settings.local.json`) to distill decisions / debugging findings / user feedback into pages before context is lost; dedup against existing pages; append a `log.md` line. Skip ephemeral task state.
- **lint** — run the `memory-lint` skill periodically to check for contradictions, stale claims, orphan pages, broken `[[wikilinks]]`, index drift; record findings in `log.md`.

### When to store (page `type`)
| Store Type | `type` |
|---|---|
| User corrections / confirmed approaches (+ **Why** + **How to apply**) | `feedback` |
| Root-cause findings, non-obvious fixes | `debugging` |
| Ongoing work / goals / constraints not derivable from code | `project` |
| Pointers to external resources (URLs, dashboards) | `reference` |
| Strategy / major-architecture decisions (Decision/Context/Options/Why/Constrains/Status) | `decision` (#917) |
| Standing limits that cap what's decidable (solo capacity, KR network separation, neutrality moat, free-tier budget) | `constraint` (#917) |
| Never-closing strategy threads — thesis / current state / next action / kill criterion (growth #803, monetization #637). **The state of record**; the `tracking` GitHub issue is a thin pointer | `initiative` (#917) |

Don't store what the repo already records (code structure, past fixes, git history, CLAUDE.md).

**Decision graph (#917)** — `type:decision` + `type:constraint` + `type:initiative` pages joined by typed `[[wikilink]]` relations (`advances`/`constrains`/`supersedes`/`evidences`/`bounds`/`blocks`) form a lightweight ontology (schema-level only — NO OWL/RDF/graph-DB; the LLM traverses the markdown). Four writing rules keep an edge single-homed: a typed `rel::` link lives **on the page-backed end** (the subject's page when both ends have one; the object's page when the subject is page-less — rule 1b), the other end takes a **plain untyped backlink** (there are no inverse names — `constrained-by`/`expressed-as` are not vocabulary), an object may be a `[[wikilink]]` **or a stable external id** (`#920`) since an Issue/PR has an id but no memory page (a **Decision and an Initiative always have pages** — never point an edge at a PR standing in for an unrecorded decision, nor at the `#803` tracking issue instead of `[[initiative_growth]]`), and **an Initiative is NOT a GitHub issue** — its state of record is an `initiative_*` page (thesis / current state / next action / kill criterion, no `N/M`), the `tracking` issue is a thin pointer, and since `advances` (Issue→Initiative) has a page-less subject its edge is written on the initiative page (rule 1b). Forcing a never-closing strategy thread into an issue's done-condition is what made #803/#637 read `0/N` — the complaint that motivated this graph. The vocabulary + page format is **[docs/reference/decision-graph.md](docs/reference/decision-graph.md)**; the **`strategy-review` skill** traverses it to report where the never-closing biz/marketing threads stand and what each needs next. It deliberately does **not** prioritise the board — ~90% of open issues are dev/ops, so ranking them beside two strategy actions buries the strategy, and a hard external deadline always beats a kill-criterion clock that merely evaporates. Board work is `issue-triage`'s job; run both. `delivered::` (closed) vs `advances::` (open) edges give each thread its progress and its backlog, and `Next action` must carry `Inputs (have)/(missing)` — a missing input means the line is a precondition, not an action, and a cost you did not derive is never written (#969).

### OKF frontmatter convention
Each page carries YAML frontmatter: `name`, `description`, `type` (+ optional `title`/`tags`). **Caveat: the harness normalizes memory frontmatter on write** (relocates `type`/`title`/`tags` under `metadata:`) — don't fight it; the fields survive under `metadata`. **Gotcha: quote any `description`/`title` containing a bare `#`** (e.g. `#N`) — unquoted YAML treats `#` as a comment and truncates the value (hit in #891 Phase 1). True OKF top-level conformance (for the Google graph visualizer) lives in the in-repo bundle **`docs/reference/*`** — an OKF bundle with `type`/`title`/`description`/`tags` frontmatter + `index.md` catalog + `log.md` (#891 Phase 4) — not the harness memory dir.

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
with raw `fetch()`** (no `@anthropic-ai/sdk` dependency — see `worker/src/anthropic.ts`), so reach
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

**chub vs LLM Wiki memory**: chub = external API ground-truth (public, shared); the file-based LLM Wiki (`memory/`) = this project's
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
npm run test:src   # Run frontend unit tests (vitest, src/**/*.test.js + api/__tests__/*.test.ts incl. the CSP drift pin) — CI-gated via the always-on `Frontend Unit Tests` job (#877; the gap that let PR #871's vercel.json CSP-hash drift ship green)
npm run test:worker # Run Worker unit tests (vitest)
npm run typecheck:worker # tsc gate — full `tsc --noEmit`, fails on ANY type error across worker source incl tests (#533 Phase 4; two-pass: prod strict workers-types-only + tests with @types/node)
npm run test:scripts # node:test unit tests for scripts/*.mjs (e.g. verify-reminders #541; lint-okf-bundle #891 — incl. its real-bundle assertion; check-e2e-ga-guard #998 — incl. its real-tests/ assertion, so a spec that could reach the production GA4 property fails CI; check-edge-e2e-coverage #1051 — incl. its real-api/ assertion, so a new Edge SSR page with no e2e fails CI; check-doc-symbols #1100 — incl. its real-docs assertion, so a made-up symbol name cited in CLAUDE.md/docs/reference fails CI, ALSO wired into docs-lint.yml so a docs-only PR is gated; lint-korean-copy #1094 — incl. its real-copy assertion + a poisoned-source wiring assertion, so a dev-token leak in Korean copy AND an unwired rule both fail CI). Runs in the `Test` workflow, which `paths-ignore`s docs — so it gates CODE PRs
npm run lint:okf   # docs/reference OKF-bundle structural lint (frontmatter/#-truncation/dangling-link/index-drift) — gated on DOCS PRs by the separate `Docs Lint` workflow (#961; `test.yml`'s paths-ignore means a docs-only PR starts none of its jobs)
npm run lint:docs        # #1100 — fail on a made-up symbol cited in CLAUDE.md/docs/reference (allowlist: docs/reference/doc-symbols-allow.txt)
npm run lint:graph -- --github  # decision-graph structural lint (#967) over the LLM-Wiki memory bundle: edge grammar, dead `advances::` edges, duplicate claims, dangling wikilinks + an unclaimed-issue REPORT (judgement, exits 0). The `--` is required — `npm run lint:graph --github` swallows the flag and silently runs the offline subset. Not CI-gatable (memory is harness-global); its pure fns are, via test:scripts. Run by the `memory-lint` skill
npm run lint:korean # Korean copy lint (#1094): dev-token leak (hard-fail) + term drift (warn). Pure fns + real-copy scan CI-gated via test:scripts; detail in workflow-hooks.md

```

### Local verification by page type

| Page | Command | URL |
|------|---------|-----|
| **Dashboard** (SPA) | `npm run dev` | `http://localhost:5173` |
| **Landing page** (`/intro`) | `npx vercel dev --listen 3333 --yes` | `http://localhost:3333/intro` |
| **Is X Down** (`/is-*-down`) | `npx vercel dev --listen 3333 --yes` | `http://localhost:3333/is-claude-down` |
| **Worker API** | `npx wrangler dev --config worker/wrangler.toml --port 8788` | `http://localhost:8788/api/status` |
| **Monthly Reports** (Jekyll) | `cd ~/Desktop/bentely/aiwatch/aiwatch-reports && PATH="/opt/homebrew/opt/ruby/bin:$PATH" GEM_HOME="$HOME/.gem/ruby/4.0.0" bundle exec jekyll serve --port 4000 --unpublished` (`--unpublished` renders a `published:false` draft) | `http://localhost:4000/reports/2026-03/` (baseurl `/reports`) |

> **Note**: Dashboard reads Worker API from `VITE_API_URL` in `.env` (default: `localhost:8788`). Landing page and Is X Down pages are Vercel Edge Functions — use `vercel dev`, not Vite. Monthly Reports require Homebrew Ruby + `bundle install` in the aiwatch-reports repo (one-time setup). **Authoring a monthly report? Invoke the `write-monthly-report` skill** (`.claude/skills/write-monthly-report/`) — the full narrative-authoring + publish runbook (hand-filled sections, ground-in-tables, heed the generate-time RECURRENCE CHECK `aiwatch-reports#54` + delete draft fences before the pre-publish lint `aiwatch-reports#55` hard-fails, service-count lockstep, keep `published:false` until confirmed).
>
> **Data source for dashboard local-verify — local worker (real data) is the DEFAULT, mock is the exception.** Run the **local worker** alongside the dashboard: `npm run dev:worker` (needs `ALLOWED_ORIGIN=*` in `worker/.dev.vars` so the `localhost:5173` dashboard passes CORS) — it live-fetches the REAL production status sources, so incidents / flap groups / edge states render faithfully. Do **NOT** rely on the SPA's `MOCK_SERVICES` fallback (`usePolling.js`): it's a static fixture with a fixed `REF` date and fabricated ongoing incidents, so it misrepresents real behavior (e.g. it has no real ×N flap group, and its stale-dated resolved incidents get filtered out). The **prod `workers.dev` worker cannot be reached from `localhost`** — it uses an `ALLOWED_ORIGIN` allowlist (`ai-watch.dev` + Vercel preview only, see `worker/src/cors.ts`), so a localhost browser fetch is CORS-blocked and silently falls back to mock. Use the mock fixture ONLY to force a **deterministic rare state** the live data won't reliably show (a specific `down`/error/edge combo) — craft it as a fixture and **revert it before commit** (step-3.5 reachability gate). **Crafting one? The fixture runs on TWO clocks** (#1108): `ago()` is anchored to the frozen `REF`, `agoNow()` to the run, and any incident an AI analysis names must use `agoNow` — mixing them across a pair renders a duration in the thousands of hours instead of erroring. The three fixtures also reference each other by id, and `src/hooks/__tests__/mock-fixture-consistency.test.js` (in `test:src`, so CI-gated) pins both — an impossible fixture fails the build instead of surfacing as a wrong screen you debug as a product bug.
>
> **Cookie banner in the way? Click "Essential Only", NOT "Accept All" (#998).** Both dismiss it, but Accept loads gtag.js against the single production GA4 property (`.env` carries the real `VITE_GA4_ID`), so a dashboard screen check lands in the growth numbers as a real session. Essential-Only leaves the **SPA** fully silent. It does **not** silence the **Edge SSR pages** (`/intro`, `/is-*-down`, `/methodology`, `/badges`): they load gtag.js unconditionally, so a manual `vercel dev` check still emits a *cookieless consent-denied* ping (no `_ga`, no session — a much smaller footprint, but not zero; gating it at the source is the open follow-up on #998). The e2e suite is fully blocked either way — see [docs/reference/ga4-events.md](docs/reference/ga4-events.md#keeping-local-runs-out-of-the-production-property-998).

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

### Parallel sessions (git worktrees)

To run multiple AI-agent sessions on this repo at once without file/git/port collisions, use
git worktrees — `claude --worktree <name>` (or `git worktree add`). **Before starting issue work,
run `git worktree list`**: a worktree or main-repo branch you didn't create means a concurrent
session is active → branch in a NEW worktree, never in-place on the shared main repo (a concurrent
session can `git checkout` it out from under you, dragging its uncommitted WIP into your diff). **Launched from the VS Code
extension button** (no `--worktree` flag)? Say **"work in a worktree"** right after the session
starts — Claude relocates via the `EnterWorktree` tool (the Desktop app auto-creates one per
session; the extension does not). `.worktreeinclude` copies `.env`/`.env.local`/`.dev.vars`/`.vercel/project.json`
into every Claude-Code-created worktree (`--worktree`/`EnterWorktree` **and** subagent
`isolation: worktree`), matching at any depth (`.dev.vars` → `worker/.dev.vars`) and creating missing
dirs; it is read from the MAIN checkout, so an edit to it only takes effect once merged. Without the
Vercel link `vercel dev --yes` silently creates a throwaway project per worktree. Run
`npm install` per worktree; offset dev-server ports by `+100·N` per slot; **deployment stays
sequential** (single prod Worker/KV). Full workflow + launch-method table + port table:
**[docs/reference/parallel-agents.md](docs/reference/parallel-agents.md)**.

## Development Workflow

> **IMPORTANT**: The full step-by-step runbook (each step's detail, the start-of-work + 4 non-negotiable gates, and
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
4. **Build + test** by scope — frontend: `npm run build` + `npm run test:src` + `npm test`; worker: `npx wrangler deploy --config worker/wrangler.toml --dry-run` + `npm run test:worker` + `npm run typecheck:worker` (the dry-run uses esbuild — it does **not** type-check, so this full-`tsc` gate (#533 Phase 4) is what catches a missing import like #532 OR any other type error; prod source is checked workers-types-ONLY so a `process`/`node:fs` use that would crash the no-`nodejs_compat` runtime also fails). New worker/util logic → exported fn + unit test; **every bug fix → a test that catches it**
5. **PR review** before commit — `/pr-review-toolkit:review-pr`
6. **Fix → re-test → re-review, auto-loop** until 0 Critical/Important (Suggestions-only = converged). Never cap the rounds; the stop rule and what to carry into each review prompt are in `ship-issue` steps 5-6 (#1097/#1124)
7. **Docs update** — CLAUDE.md (lean, **~40k-char guideline**; detail → `docs/reference/`), the relevant `docs/reference/*`, README(.ko), `CONTRIBUTING.md`, `index.html` SEO, `aiwatch-reports/`
8. **Commit + PR** (only after the user confirms) — footer required; `closes #N` only when every item is done **and verified** (time/prod-gated verification = remaining → `refs`); also reconcile OTHER open issues this change closes / supersedes / invalidates
9. **Verify Vercel Preview** (frontend)
10. **Merge** `gh pr merge --squash --delete-branch` — worker deploy is manual (`npm run deploy:worker`, once, after approval; batch multi-PR deploys)
11. **Verify checklist** against code before closing; periodically re-verify `deferred`/`tracking` issues (later work may have completed one)
12. **Close** only after verification; deferred items → keep open with a label carrying a **written exit condition**. A production-data check needed after a delay → add a `- [ ] **verify-after YYYY-MM-DD** — what to check + where` line under a `## Production-gated verification` heading at the body bottom; the daily `verify-reminders` Action (#541) pings the operator Discord when due, and scans **both this repo and `aiwatch-reports`**. Machine-checkable? Add an indented Tier-A `assert:` clause (#873) and the job auto-verifies instead of pinging (ticking + commenting + dropping `verify-blocked`; it closes only once EVERY box is ticked) — validate it the moment you add it: `node scripts/verify-assertions.mjs --issue N` (dry-run is the DEFAULT; `--apply` is what mutates — there is no `--dry-run` flag). GA4/CTR/behavioral checks are NOT assertable; leave those as a human ping — but a human ping still has to name what it will READ: add an indented `durable:` sub-line naming an artifact that outlives the date, or the job labels **`verify-undecidable`** (#1206). The same job labels **`body-drift`** on a `verify-blocked` issue whose shipped boxes were never synced (sync at MERGE, step 10 — this is only the backstop), and reminder lines inside a **blockquote are skipped** (#966), so a retrospective `> **Status:**` note may quote a `verify-after` token safely — but **never quote an unchecked `- [ ]` box**: it will never fire, and the only signal is a runtime warn nobody reads.

> Grammar (`assert:` + `durable:`), the allowlist, fail-open semantics, the label lifecycle, the `verify-overdue` self-healing rules and the 30-day escalation: **[docs/reference/verify-assertions.md](docs/reference/verify-assertions.md)**.

> Never close an issue immediately after merging. Verify each checklist item against the code first; deferred → keep open with a labeled exit condition.

### Debugging rules
- Before writing any fix, read all relevant code and identify the root cause
- Propose ONE fix approach with reasoning — do not shotgun multiple approaches
- Wait for user confirmation before implementing the fix

### Workflow-gate hooks (#415/#657)

Written rules are passive context — loaded once per session, dropped by compaction — so they get only
probabilistic compliance. `.claude/settings.json` wires **seven** hooks (`.claude/hooks/`) that fire at
the decision moment instead:

| Hook | Event | Enforces |
|---|---|---|
| `workflow-gates-reminder.sh` | UserPromptSubmit | Re-injects the non-negotiable gates **every turn** (incl. gate 0 = invoke `ship-issue` first). Soft. |
| `git-mutation-gate.sh` | PreToolUse/Bash | Warns before `git commit`/`push`/`gh pr create`/`merge` — step-3.5, `--no-verify`, docs-drift, methodology-drift (#937), truncated ids (#1053). Soft. |
| `stop-nag-gate.sh` | Stop | Blocks a closing "shall I proceed / 진행할까요?" and re-prompts. |
| `tooling-trigger.sh` | PreToolUse/Edit\|Write\|MultiEdit | Reminds to run chub / modern-web-guidance by file path. Soft. |
| `korean-copy-trigger.sh` | PreToolUse/Edit\|Write\|MultiEdit | On a Korean-copy file (ko.js / methodology·intro templates / LegalContent·AnalysisModal), reminds to run `lint:korean` + re-read the whole card (#1094/#1097). Soft. |
| **`step35-verify-gate.mjs`** | PreToolUse/Bash + Edit\|Write\|MultiEdit | **HARD** — DENIES a UI/Edge `git commit` with no transcript-confirmed user verification, denies `--no-verify`, denies unauthorized self-edits to `.claude/hooks/**` + `.claude/settings*.json`. Fail-closed. The COMMIT deny's override is a user turn saying `검증 생략하고 커밋`; a self-edit deny needs stated intent toward the gate instead (`훅 작업`), which that path checks separately. |
| `review-loop-gate.mjs` | PreToolUse/Task\|Agent | **Telemetry, not a gate** (#1150) — records the round each `pr-review-toolkit:*` spawn declares (or that it declared none). Never blocks; read via `hook-audit`'s `🔁` section. Enforcing convergence stays `ship-issue` steps 5-6 — why, in workflow-hooks.md. |

Every fire is logged to `.claude/hook-audit.jsonl` (gitignored); `npm run hook-audit` summarizes.
The effectiveness signal is the **`Violations intercepted`** tally (`block` / `deny` except `fail-closed` / `no_verify=1`),
NOT raw `warn`/`inject` counts — those are preventive telemetry that scale with workload. For the hard
gate the key signal is the **false-positive rate** (a `commit:override` pass, and `fail-closed` health),
and the response to a rising rate is to TUNE `CONFIRM_RE` or soften to a warn, never to harden further.

> Per-hook behaviour, the #415/#657 rationale, the audit-note vocabulary, the monitoring guidance and
> the known blind spots are in **[docs/reference/workflow-hooks.md](docs/reference/workflow-hooks.md)**.
> New `.claude/settings.json` only takes effect after `/hooks` is opened once or a restart.

### Adding a new service (checklist)

When adding a new monitored service, files across worker, frontend, docs, SEO meta, landing page, Is-X-Down, **the `/methodology` page** (service count + category breakdown + probe count, lockstep-tested), the reports site, and assets must all update together (service count + sync invariants). Follow the full checklist in **[docs/reference/adding-a-service.md](docs/reference/adding-a-service.md)** — do not skip steps. **Start with the Step-0 data-richness audit** (#601/#680): fetch the candidate's status source and confirm it carries official uptime + incident history (+ ideally a probeable endpoint) BEFORE coding — gcloud-`incidents.json`-only sources (e.g. Veo/Imagen) are thin (no uptime, ~0 incidents → bedrock-like empty card) and usually not worth adding.

## Architecture

**AIWatch** is a React SPA that monitors 45 AI services in real time:
- **34 API services**: Claude, OpenAI, Gemini, Mistral, Cohere, Groq, Together, Fireworks, Cerebras, Perplexity, HuggingFace, Replicate, fal.ai, ElevenLabs, AssemblyAI, Deepgram, xAI, DeepSeek, Kimi (Moonshot AI), OpenRouter, Bedrock, Azure OpenAI, Pinecone, turbopuffer, Stability AI, Black Forest Labs (FLUX), Voyage AI, Modal, Twelve Labs, LangChain (LangSmith), Helicone, Langfuse, Runway, Luma (Dream Machine)
- **5 AI apps**: claude.ai, ChatGPT, Character.AI, DeepSeek App, Grok
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

> Path → one-line purpose. **The annotations (why each module exists, its behaviours, the #-issues
> that shaped it) live in [docs/reference/directory-map.md](docs/reference/directory-map.md)** — read
> that before changing a module. Adding a module → add a line here AND its annotation there.

```
api/                 # Vercel Edge Functions (SSR pages + proxies). `_`-prefixed dirs = helpers, not Functions (#867)
  intro.ts           # Landing page (/intro); ?banner=<key> announcement slot
  is-down.ts         # "Is X Down?" SEO pages (43 services; excl. bedrock/azureopenai)
  reports.ts         # /reports/* proxy → aiwatch-reports Jekyll site (#264)
  methodology.ts     # Public "How AIWatch Works" page (/methodology, #673)
  plugin.ts          # Claude Code plugin landing (/plugin, #920)
  plugin-privacy.ts  # Plugin privacy policy — the marketplace policy URL (#920)
  extension-privacy.ts # Chrome-extension privacy policy — the Web Store policy URL (#837)
  badges.ts          # "AI Status Badges" gallery (/badges, #805)
  confirm.ts         # Per-user Discord webhook double-opt-in confirmation page (#486)
  csp-report.ts      # CSP violation sink (#482)
  _is-down/ _intro/ _methodology/ _plugin/ _badges/ _shared/   # SSR templates + shared helpers (incl. _is-down/upstream-note.ts — the #1053 card's per-service claim)
src/                 # React 19 SPA (Vite, no router — hash routing in App.jsx)
  components/        # StatusPill, SkeletonUI, EmptyState, Modal, Sidebar, Topbar, CookieBanner, AnalysisModal
  pages/             # Overview, Latency, Incidents, Uptime, ServiceDetails, Settings, Ranking, Statusline
  hooks/             # usePolling, useTheme, useLang, useSettings, useGitHubStars
  utils/             # analytics, calendar, time, pageContext, constants, hashRoute, webhookSubscription, liveIncident (#1104 — the one "is this service still carrying a live incident?" rule the SPA's resolved-claims share)
  locales/           # ko.js, en.js — flat key→string maps
worker/src/          # Cloudflare Worker: status polling, KV cache, cron, alerts, AI analysis
  index.ts           # Entry: CORS, routing, /api/*, /badge, /feed, Cron scheduled handler
  services.ts        # Service configs + fetch orchestrator + status determination
  types.ts utils.ts  # Shared types (ServiceStatus, Incident) + shared utils (formatDuration, fetchWithTimeout, sanitize)
  score.ts           # AIWatch Score (Uptime 40 / Incidents 25 / Recovery 15 / Responsiveness 20)
  alerts.ts          # Incident + status-edge alert detection, holds, merges, tweet/reply drafts
  ai-analysis.ts     # Hybrid incident analysis — Gemma 4 26B primary, Claude Sonnet fallback
  anthropic.ts       # Anthropic Messages REST call — model id, request body, retry + status classification (#955)
  incident-history.ts # Durable resolved-incident corpus → prediction accuracy + RAG (#827)
  recovery-mark.ts   # The shared "incident resolved" step both cron paths call — recovered: marker + analysis resolvedAt stamp (#1003)
  rss.ts             # Incident RSS feeds (/feed.xml, /feed/:slug) + Slack-poller behaviours
  fallback.ts        # Fallback recommendation (tiered, Score-ranked)
  service-groups.ts  # Fine service taxonomy (llm/voice/inference/…) → /api/v1/status `group` (mirror of frontend SERVICE_CATEGORIES, sync-tested) (#1068)
  upstream-link.ts   # Cross-provider upstream link (#1053) — a dependent's own incident names a provider that is itself down
  upstream-feed.ts   # Non-carded upstream feeds (#1072) — GitHub platform status read ONLY by upstream-link; no card/Score/uptime
  incident-text.ts   # Shared "which incidents can be a CAUSE + their searchable text" primitive (#1053; supply-chain + upstream-link)
  withdrawn.ts       # Provider-DELETED incident tombstones (#1106) — the only material the Discord/RSS withdrawal notices render from
  withdrawal-log.ts  # Durable record that a withdrawal happened + whether its notice went out (#1106 Part 5) — every other trace expires within a week
  suppression.ts     # Operator incident-suppression layer (#904)
  overrides.ts       # Operator incident duration-override layer (#1019) — pins a paperwork-inflated duration, keeps the incident
  probe.ts probe-archival.ts   # Direct RTT probing (33 targets) + daily archival
  daily-summary.ts weekly-briefing.ts monthly-archive.ts monthly-narrative.ts  # Discord reports + archives
  api-traffic.ts outage-audience.ts referral.ts vitals.ts   # WAE/KV instrumentation
  growth-series.ts   # Durable daily series of the consent-free growth counters (#986) — the dataset #547's lift measurement reads
  reddit.ts security-monitor.ts changelog.ts platform-monitor.ts  # External monitoring
  alert-feed.ts ext-claude.ts indexnow.ts badge.ts og.ts og-render.ts  # Feeds, projections, SEO, images
  parsers/           # statuspage, incident-io, gcloud, aistudio, instatus, betterstack, aws, flashduty
extension/           # Claude-only Chrome extension (MV3, #837) — consumes ?src=ext-claude only
plugin/aiwatch/      # Claude Code plugin (#920) — outage monitor + /aiwatch command
.claude-plugin/      # marketplace.json — AIWatch's OWN plugin catalog (`aiwatch-dev`); makes plugin/aiwatch/ installable with no third-party review (#920)
scripts/             # Build/CI/ops scripts (verify-reminders, lint-okf-bundle, check-vercel-function-count, …)
docs/reference/      # OKF knowledge bundle — read index.md first
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

**Footgun — Tailwind margin/padding utilities silently compute to `0`.** `src/index.css` declares an *unlayered* `* { margin: 0; padding: 0 }` reset, and unlayered rules outrank **any** `@layer`ed rule — which is where Tailwind v4 emits its utilities. So `pt-[48px]`, `py-[7px]`, `mt-auto`, … apply to nothing, on every element (not just buttons). Only margin/padding are affected; `height`/`top`/`flex`/`gap`/`overflow` utilities work normally. Use an inline `style` for spacing, or express the layout with a non-reset property. This has bitten twice: the sidebar's inline `navItemStyle`, and #978 (the mobile drawer's dead `pt-[48px]` + an inert `mt-auto` footer).

### i18n
`src/locales/ko.js` and `en.js` export flat `{ 'dot.key': 'string' }` maps (default exports).

### GA4 Analytics Events

All events use `trackEvent()` from `src/utils/analytics.js`; GA4 activates only on cookie consent (`aiwatch-cookie-consent` localStorage key, shared across SPA / Edge SSR / Jekyll). The cross-surface consent flow (#352), the full event catalog (parameters · location · purpose), and the reports-site events are in **[docs/reference/ga4-events.md](docs/reference/ga4-events.md)**. Read it before adding/changing analytics events or touching consent logic. **#888** — the "Get the Chrome extension" install CTA (a QUIET standalone strip below the is-down answer — NOT a 5th button in the crowded alert block, per CRO evidence — + a landing cta-box button) is **URL-gated** via `api/_shared/extension-cta.ts` `EXTENSION_STORE_URL` (empty = CTA hidden everywhere; set to the CWS listing URL once the #837 extension is approved → both surfaces go live at once). On is-down it's ALSO Claude-surface-gated (`isClaudeSurface` — claude/claudeai/claudecode only, since the extension is Claude-only). Fires `install_extension` (`location` ∈ `is_down_page`/`landing_cta`) via the delegated `[data-ga]` listener; pure `renderExtInstallCta` + `isClaudeSurface` unit-tested.

**#998 — there is ONE GA4 property (`G-D4ZWVHQ7JK`) and no dev/staging one**, so local runs report into the numbers we measure growth with. **During a local/MCP screen check, click "Essential Only" — never "Accept All"** (any non-null `aiwatch-cookie-consent` dismisses the banner; only `'granted'` loads gtag.js). E2E is handled structurally: every spec imports `test` from **`tests/fixtures.js`**, whose `context` fixture aborts all `google-analytics.com`/`analytics.google.com` requests — `googletagmanager.com` stays reachable on purpose (static script, no measurement, and consent.spec needs the `_ga` cookie gtag.js writes). Proven at runtime by `tests/ga-block.spec.js` in the always-run `desktop` project (a bare `fetch` at a collect endpoint must not complete) — CI is the wrong place to trust here, since `.env` is gitignored so `VITE_GA4_ID` is EMPTY in CI: the pollution was always a **local**-run and Edge-surface problem, and a broken block would otherwise stay green. Escapes are CI-gated by `scripts/check-e2e-ga-guard.mjs`. Note the asymmetry: the SPA loads gtag.js only on `'granted'`, but the **Edge SSR pages load it unconditionally** and emit cookieless pings with no consent at all — which is why the block has to be at the network layer, not the consent layer, and why a *manual* Edge check still pings (open follow-up). Rationale: [docs/reference/ga4-events.md](docs/reference/ga4-events.md).

### Service Status Determination
Per-service status is resolved in `worker/src/services.ts` with a layered priority chain (multi-component worst-of → component match → overall-indicator fallback → `incidentExclude` bypass → component-status filter → fetch-failure cross-validation). The full ordered rules and their #-issue rationale are in **[docs/reference/status-determination.md](docs/reference/status-determination.md)** — read it before changing status resolution.

### Status Data Flow
Browser (60s polling) → Worker `/api/status` (parallel 45-service fetch, normalize, KV write, platform/probe cross-validation) → React state → pages. Cron (`*/5`) handles probing, incident detection + Discord alerts, AI analysis, daily/monthly aggregation, changelog/security/weekly briefing. The full annotated request + cron + Web Vitals flow diagram is in **[docs/reference/data-flow.md](docs/reference/data-flow.md)**.

### SPA Navigation
No React Router. Hash-based routing in `App.jsx` — `#claude` for service details, `#latency` for pages. `PageContext` shares current page state. Browser back/forward supported via `popstate` listener.

### Key Product Constraints

> Headlines only. **The detail each of these accumulated lives in
> [docs/reference/product-constraints.md](docs/reference/product-constraints.md)** — read the relevant
> block before changing AI analysis, fallback gating, deploy/cron behaviour, CSP, the PWA service
> worker, or any Edge SSR surface.

- **Mobile breakpoint 768px** — sidebar hidden (overlay on hamburger), cards go 1-column.
- **Phase 3 AI Analysis (Beta)** — hybrid Gemma 4 26B (Workers AI, primary) + Claude Sonnet (AI Gateway, fallback); per-incident `ai:analysis:{svcId}:{incId}` KV, TTL refresh, re-analysis, dedup, ongoing-past-estimate wording. `ANTHROPIC_API_KEY` secret required for the Sonnet fallback.
- **Contextual + grouped fallback** — the modal/Overview gate on service status, the is-down card + Discord gate on `needsFallback` (#454). A capability-ROUTED outage (#1062) is the ONE path allowed to cross the category filter (#1119). Tier priority + `EXCLUDE_FALLBACK` membership: [docs/reference/fallback-tiers.md](docs/reference/fallback-tiers.md).
- **Uptime is COMPUTED by AIWatch, not copied** (#1006) — from the provider's own published records, over a trailing 30-day window on the **Official** path: Atlassian → `parseUptimeData` (per-day outage seconds); incident.io → `computeIncidentIoUptime` (`component_impacts` intervals). Weights per `/methodology`: full outage 1.0, partial/degraded 0.3, announced maintenance excluded. **Neither the weighting nor the window is uniform across sources (#1110) — never write that they are.** `platform_avg` (Better Stack) ignores severity and measures each resource only over its own monitored days; `parseInstatusNextUptime` lets a provider-published `customImpactPercentage` win; and `uptimeWindowDays` — the short-history disclosure — is emitted only on the Atlassian + incident.io paths, so Instatus / OnlineOrNot / Flashduty publish a short history silently. Per-source detail: [status-determination.md](docs/reference/status-determination.md). incident.io's published `component_uptimes[].uptime` aggregate is NOT a 30-day figure and differs in definition page to page (LangSmith's tracked ~90d and ranked it `fair` on 60-day-old outages; OpenAI's excludes degraded/partial), so copying it made the ranking compare incomparable numbers. Our figure can therefore differ from the % on a provider's own page — by design, and disclosed.
- **No-official-uptime services** (`bedrock`, `azureopenai`) — AIWatch invents **no** uptime value (#713); Score rescales onto available components, `low` confidence withholds the score entirely. Coverage gate (#802) holds a <30-day service out of rankings. **#1186** — the rescale itself IS a mathematical imputation: dropping uptime and computing `(I+R+P)/60×100` is algebraically identical to keeping uptime in a full `/100` sum at the fixed ratio `40/60` of the other three components, so a `medium`-confidence score (probed, no official uptime) is not on the same scale as a `high` one. `Ranking.jsx` and `is-down.ts` therefore rank `medium` in a table/tier separate from `high` — never merged into one shared rank sequence (`splitByConfidence` in `serviceReliability.js`).
- **Worker deploy rules** — dev via `npx wrangler dev --config worker/wrangler.toml --port 8788`; dry-run before deploy; **deploy once**, only via `npm run deploy:worker` (never bare `wrangler deploy` — it deploys the SPA). Verify the output says `Uploaded aiwatch-worker`.
- **Cron `*/5`** — incident detection + Discord alerts (KV ID dedup), AI analysis inline (cancellable 15s budget), holds, cache refresh on a status edge (#488 cron edge + #1057 live-poll edge — so the is-down/OG card flips ahead of the alert, not in lockstep; see product-constraints.md). Alert paths: [docs/reference/discord-alert-paths.md](docs/reference/discord-alert-paths.md).
- **Frontend deployment** — Vercel, `ai-watch.dev`; `git push origin main` auto-deploys. `npm run build` is local only. `api/` files count against the Hobby **12-Serverless-Function cap** unless edge-runtime or `_`-prefixed (#862/#867; CI guard `check-vercel-function-count`).
- **CSP (#482)** — enforced on the SPA (`vercel.json`, hash-locked) and per-response on every Edge SSR page (nonce for no-store surfaces, content-hash for cached is-down). Policy + rationale: [docs/reference/reference-csp.md](docs/reference/reference-csp.md).
- **PWA** — `public/manifest.json` + `public/sw.js` (stale-while-revalidate); the cache name auto-derives from `asset-manifest.json` (an md5 of the content-hashed asset filenames), so there is **nothing to bump by hand** — a version bump invalidates it too, via the inlined `__APP_VERSION__`; registered in production only (#432).
- **Edge SSR surfaces** — is-down (SEO, `?e=`/`?i=` social-card pinning), intro, methodology, plugin, plugin-privacy, badges, reports proxy.

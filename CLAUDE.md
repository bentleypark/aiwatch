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

Don't store what the repo already records (code structure, past fixes, git history, CLAUDE.md).

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
npm run test:scripts # node:test unit tests for scripts/*.mjs (e.g. verify-reminders #541; lint-okf-bundle #891 — incl. its real-bundle assertion). Runs in the `Test` workflow, which `paths-ignore`s docs — so it gates CODE PRs
npm run lint:okf   # docs/reference OKF-bundle structural lint (frontmatter/#-truncation/dangling-link/index-drift) — gated on DOCS PRs by the separate `Docs Lint` workflow (#961; `test.yml`'s paths-ignore means a docs-only PR starts none of its jobs)

```

### Local verification by page type

| Page | Command | URL |
|------|---------|-----|
| **Dashboard** (SPA) | `npm run dev` | `http://localhost:5173` |
| **Landing page** (`/intro`) | `npx vercel dev --listen 3333 --yes` | `http://localhost:3333/intro` |
| **Is X Down** (`/is-*-down`) | `npx vercel dev --listen 3333 --yes` | `http://localhost:3333/is-claude-down` |
| **Worker API** | `npx wrangler dev --config worker/wrangler.toml --port 8788` | `http://localhost:8788/api/status` |
| **Monthly Reports** (Jekyll) | `cd ~/Desktop/bentely/aiwatch/aiwatch-reports && PATH="/opt/homebrew/opt/ruby/bin:$PATH" GEM_HOME="$HOME/.gem/ruby/4.0.0" bundle exec jekyll serve --port 4000` | `http://localhost:4000/2026-03/` |

> **Note**: Dashboard reads Worker API from `VITE_API_URL` in `.env` (default: `localhost:8788`). Landing page and Is X Down pages are Vercel Edge Functions — use `vercel dev`, not Vite. Monthly Reports require Homebrew Ruby + `bundle install` in the aiwatch-reports repo (one-time setup).
>
> **Data source for dashboard local-verify — local worker (real data) is the DEFAULT, mock is the exception.** Run the **local worker** alongside the dashboard: `npm run dev:worker` (needs `ALLOWED_ORIGIN=*` in `worker/.dev.vars` so the `localhost:5173` dashboard passes CORS) — it live-fetches the REAL production status sources, so incidents / flap groups / edge states render faithfully. Do **NOT** rely on the SPA's `MOCK_SERVICES` fallback (`usePolling.js`): it's a static fixture with a fixed `REF` date and fabricated ongoing incidents, so it misrepresents real behavior (e.g. it has no real ×N flap group, and its stale-dated resolved incidents get filtered out). The **prod `workers.dev` worker cannot be reached from `localhost`** — it uses an `ALLOWED_ORIGIN` allowlist (`ai-watch.dev` + Vercel preview only, see `worker/src/cors.ts`), so a localhost browser fetch is CORS-blocked and silently falls back to mock. Use the mock fixture ONLY to force a **deterministic rare state** the live data won't reliably show (a specific `down`/error/edge combo) — craft it as a fixture and **revert it before commit** (step-3.5 reachability gate).

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
6. **Fix → re-test → re-review, auto-loop** until 0 Critical/Important (Suggestions-only = converged)
7. **Docs update** — CLAUDE.md (lean, **~40k-char guideline**; detail → `docs/reference/`), the relevant `docs/reference/*`, README(.ko), `CONTRIBUTING.md`, `index.html` SEO, `aiwatch-reports/`
8. **Commit + PR** (only after the user confirms) — footer required; `closes #N` only when every item is done **and verified** (time/prod-gated verification = remaining → `refs`); also reconcile OTHER open issues this change closes / supersedes / invalidates
9. **Verify Vercel Preview** (frontend)
10. **Merge** `gh pr merge --squash --delete-branch` — worker deploy is manual (`npm run deploy:worker`, once, after approval; batch multi-PR deploys)
11. **Verify checklist** against code before closing; periodically re-verify `deferred`/`tracking` issues (later work may have completed one)
12. **Close** only after verification; deferred items → keep open with a label carrying a **written exit condition**. Production-data check needed after a delay → add a `- [ ] **verify-after YYYY-MM-DD** — …` line; the daily `verify-reminders` Action (`.github/workflows/verify-reminders.yml` + `scripts/verify-reminders.mjs`, #541) pings the operator Discord when due so the check isn't missed. It scans **both this repo AND `aiwatch-reports`** (`parseScanRepos` + `VERIFY_EXTRA_REPOS`), so a `verify-after` line in either repo fires — the sibling scan needs the `VERIFY_CROSS_REPO_TOKEN` PAT secret (issues:read+write on both repos; absent → the sibling scan warn-skips best-effort, the aiwatch reminder still runs). Sibling refs show qualified (`aiwatch-reports#N`) in the Discord ping. **#873** — a `verify-after` line may carry a machine-checkable **Tier-A `assert:` clause** (indented beneath it, e.g. `assert: GET /api/status/cached | services[id=turbopuffer].scoreConfidence == "medium"`); the daily job then **auto-verifies** it (tick + comment + drop `verify-blocked` + close) instead of only pinging — fail-open, trusted-author-gated, JSON endpoints only (`scripts/verify-assertions.mjs`, grammar in [docs/reference/verify-assertions.md](docs/reference/verify-assertions.md)). Un-assertable (GA4/GSC-CTR/behavioral) → plain human ping. **Body-drift guard** — the same daily job also labels **`body-drift`** on any OPEN `verify-blocked` (non-`tracking`) issue whose body still has unchecked NON-`verify-after` checkboxes (i.e. code shipped but the boxes were never synced at merge, or the label is wrong); self-healing (label removed once the body is synced), label-only (no Discord spam), so issue-triage sees the drift by label alone. Root cause it targets: body-sync is a late, no-gate step in GitHub — a different system than the git diff the #415 hooks watch — so it concentrates in the weeks-open verify-blocked bucket. The fix is to sync the body **at merge** (ship-issue step 10), not close; this guard is the backstop. Pure `findBodyDrift`/`isDriftCandidate` unit-tested. **#966** — the reminder scan SKIPS **blockquote (`>`) lines** (shared `isSuppressedReminderLine`, used by BOTH `parseVerifyAfter` and the live `pairVerifyAssertions`), because a retrospective `> **Status (…):**` note that *quotes* a `verify-after <date>` token has no checkbox and so re-fired daily forever. **Write status notes freely; quoting the token is safe.** Non-quoted prose still fires; a quoted `- [ ]` box never does (warned about at runtime). Same PR made **`verify-overdue` self-healing** (it was add-only — not even close removed it), clearing it from the *dates* rather than the weekly-throttled `due` set. Pure `isSuppressedReminderLine`/`findStaleOverdueLabels`/`findQuotedVerifyAfterBoxes` unit-tested; rationale + label lifecycle in [docs/reference/verify-assertions.md](docs/reference/verify-assertions.md)

> Never close an issue immediately after merging. Verify each checklist item against the code first; deferred → keep open with a labeled exit condition.

### Debugging rules
- Before writing any fix, read all relevant code and identify the root cause
- Propose ONE fix approach with reasoning — do not shotgun multiple approaches
- Wait for user confirmation before implementing the fix

### Workflow-gate hooks (#415)

`.claude/settings.json` wires four enforcement hooks (scripts in `.claude/hooks/`) — because written rules alone (this file + auto-memory) only get probabilistic compliance:
- **`workflow-gates-reminder.sh`** (UserPromptSubmit) — re-injects the non-negotiable gates (a start-of-work gate 0 = "invoke `ship-issue` first on any new issue/code task", then the 4 decision-moment gates; text in `.claude/hooks/workflow-gates.txt`) as `additionalContext` on **every turn**. Gate 0 closes the coverage gap where "invoke ship-issue at the START" lived only in CLAUDE.md (a passive session-start surface) and was the one workflow step with no every-turn backstop. Targets the root cause (rules are passive context loaded once at session start; compaction drops methodology), and is the only hook surface that fires each turn + survives compaction. Soft (cannot block); logged as `inject`. Mirrors memory note `feedback_workflow_gates`.
- **`git-mutation-gate.sh`** (PreToolUse/Bash) — fires before `git commit` / `git push` / `gh pr create` / `gh pr merge`. **Soft** (warns via `systemMessage`, never blocks). The step-3.5 reminder fires on **every** matched mutation (always `warn`) — a running dev server is now only an *informational hint*, **not** a silence condition, because a port probe can't distinguish "the assistant started + curl-checked a server itself" from "the user confirmed in-browser" (the #430 false-pass; #415 2026-05-19 gap). Also flags `--no-verify` / `--no-gpg-sign`. **On `git commit`** it adds a **docs-drift reminder**: if the staged diff changes doc-load-bearing code (`services.ts`/`index.ts`/`parsers/`/`wrangler.toml`/`vercel.json`/`constants.js`, or adds a new worker module) but touches no `docs/reference/*` or `CLAUDE.md`, it surfaces the change→doc map (docs is the recurring miss — the late, no-feedback, no-gate step; audit note `docs_reminder=1`). **#937** adds a paired **methodology-drift reminder**: the docs-drift check goes silent once ANY `docs/`/`CLAUDE.md` file is staged, so editing `docs/reference/status-determination.md` alone leaves the **public `/methodology` §2 cards** (`api/_methodology/html-template.ts`, which mirror those rules) unflagged — the #934 drift. This high-precision check fires when the rules doc is staged but the mirror page is not (audit note `methodology_reminder=1`); spawn-tested against a crafted staged diff in `scripts/git-mutation-gate.test.mjs` (via `npm run test:scripts`).
- **`stop-nag-gate.sh`** (Stop) — reads the just-finished assistant message from the transcript; if its closing line is an auto-proceed nag ("shall I proceed/merge/continue?", "진행할까요?", "다음 작업 진행할까요?", …) it **re-prompts** (`decision: block`) to re-send the closing without the nag. `stop_hook_active` guards the loop.
- **`tooling-trigger.sh`** (PreToolUse/Edit|Write|MultiEdit) — soft path-based reminder (`systemMessage`, never blocks) to run **chub** first on external-integration files or **modern-web-guidance** first on frontend HTML/CSS/JS; the #415 backstop for those skills' probabilistic triggers. Logged as `inject`. Trigger map: **[docs/reference/reference-tooling.md](docs/reference/reference-tooling.md)**.
- **`step35-verify-gate.mjs`** (PreToolUse/Bash + Edit|Write|MultiEdit, **#657**) — the **HARD** gate (soft reminders alone only get probabilistic compliance; this changes *control flow*). On **`git commit`** of a **UI/Edge** staged diff (`src/` non-test, `api/is-down`, `api/intro`), it reads `transcript_path` and **DENIES** (`permissionDecision:"deny"`) unless a genuine **`role:user` turn** (`isMeta:false`, content is a STRING or array-text — tool_results don't count) appears **AFTER the last UI/Edge edit** and matches a confirmation (`CONFIRM_RE`, KO+EN) — an unfabricable signal (the agent can't author a user turn). Also **denies `--no-verify`/`--no-gpg-sign`**, and (Edit/Write matcher) **denies self-edits to `.claude/hooks/**` + `.claude/settings*.json`** unless a recent user turn authorizes hook work (`HOOK_WORK_RE`, e.g. "#657"/"hook"/"훅") — so the agent can't quietly weaken its own gate. **Fail-closed** (deny on parse error), every deny states the one-line override ("검증 생략하고 커밋" / a user confirmation). It **logs every decision** to `.claude/hook-audit.jsonl` so the hard gate is observable (`deny` notes: `commit:<reason>` / `no-verify` / `self-edit:…` / `fail-closed`; `pass` notes: `commit:confirmed` / `commit:override` / `self-edit-authorized:…`) — the high-volume trivial early-exits are deliberately NOT logged. Pure decision fns (incl. `auditLine`) unit-tested via `npm run test:scripts` (`scripts/step35-verify-gate.test.mjs`); the summary's step35 handling in `scripts/hook-audit-summary.test.mjs`. Both honor a `HOOK_AUDIT_LOG` override for test isolation. NOTE non-UI/worker/docs commits are NOT gated here (the soft `git-mutation-gate.sh` still nudges them).

Every fire is logged to `.claude/hook-audit.jsonl` (gitignored). `npm run hook-audit` (= `node scripts/hook-audit-summary.mjs [--last N] [--days D]`) summarizes (by hook × decision, last-7-days, per-day trend, recent entries). **The effectiveness signal is the `Violations intercepted` tally, NOT raw `warn`/`inject` counts**: `warn` (git-mutation step-3.5 reminder) and `inject` (every-turn gate re-injection) are *preventive telemetry* that scale with workload — their trend is meaningless. A real intercepted violation is only `block` (a nag was about to ship) or a `no_verify=1` note (`--no-verify`/`--no-gpg-sign` on a commit). Review the **violation trend** periodically — a declining/zero count is the goal. **#657 performed the escalation** the old text anticipated: step-3.5 is now HARD-enforced by `step35-verify-gate.mjs` (a `deny` on UI/Edge commits lacking a transcript-confirmed user turn), so a step-3.5 violation is now an intercepted `deny`, not an invisible behavioral miss — correcting the earlier "the confirmation is a user message the hook never sees" claim (hooks DO receive `transcript_path`). The soft gates remain for non-UI commits + salience. **Monitoring the hard gate** (its own `🚦 step-3.5 hard gate` section in `npm run hook-audit`): because a `deny` is *ambiguous* (an intercepted skip OR a false-positive where the parser missed a real confirmation), the key signal for a HARD gate is **the false-positive rate**, not the deny count — specifically a **`commit:override` pass** (the user had to say "검증 생략" on already-verified work; the strongest proxy) and **`fail-closed`** (gate-health, should trend ~0; nonzero = the transcript read is breaking). Escalate by **tuning `CONFIRM_RE` / softening to a warn** if overrides rise, NOT by hardening further. The structural blind spot remains: a user "확인" turn proves a turn happened, not that they actually looked — so a step-3.5 *false negative* (gate passes an unverified commit) is still invisible to the log; spot-check merged UI PRs periodically. New `.claude/settings.json` only takes effect after `/hooks` is opened once or a restart (the settings watcher only watches dirs that had a settings file at session start).

### Adding a new service (checklist)

When adding a new monitored service, files across worker, frontend, docs, SEO meta, landing page, Is-X-Down, **the `/methodology` page** (service count + category breakdown + probe count, lockstep-tested), the reports site, and assets must all update together (service count + sync invariants). Follow the full checklist in **[docs/reference/adding-a-service.md](docs/reference/adding-a-service.md)** — do not skip steps. **Start with the Step-0 data-richness audit** (#601/#680): fetch the candidate's status source and confirm it carries official uptime + incident history (+ ideally a probeable endpoint) BEFORE coding — gcloud-`incidents.json`-only sources (e.g. Veo/Imagen) are thin (no uptime, ~0 incidents → bedrock-like empty card) and usually not worth adding.

## Architecture

**AIWatch** is a React SPA that monitors 43 AI services in real time:
- **33 API services**: Claude, OpenAI, Gemini, Mistral, Cohere, Groq, Together, Fireworks, Cerebras, Perplexity, HuggingFace, Replicate, fal.ai, ElevenLabs, AssemblyAI, Deepgram, xAI, DeepSeek, OpenRouter, Bedrock, Azure OpenAI, Pinecone, turbopuffer, Stability AI, Black Forest Labs (FLUX), Voyage AI, Modal, Twelve Labs, LangChain (LangSmith), Helicone, Langfuse, Runway, Luma (Dream Machine)
- **4 AI apps**: claude.ai, ChatGPT, Character.AI, DeepSeek App
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
  is-down.ts         # "Is X Down?" SEO pages (40 services; excl. bedrock/azureopenai)
  reports.ts         # /reports/* proxy → aiwatch-reports Jekyll site (#264)
  methodology.ts     # Public "How AIWatch Works" page (/methodology, #673)
  plugin.ts          # Claude Code plugin landing (/plugin, #920)
  plugin-privacy.ts  # Plugin privacy policy — the marketplace policy URL (#920)
  extension-privacy.ts # Chrome-extension privacy policy — the Web Store policy URL (#837)
  badges.ts          # "AI Status Badges" gallery (/badges, #805)
  confirm.ts         # Per-user Discord webhook double-opt-in confirmation page (#486)
  csp-report.ts      # CSP violation sink (#482)
  _is-down/ _intro/ _methodology/ _plugin/ _badges/ _shared/   # SSR templates + shared helpers
src/                 # React 19 SPA (Vite, no router — hash routing in App.jsx)
  components/        # StatusPill, SkeletonUI, EmptyState, Modal, Sidebar, Topbar, CookieBanner, AnalysisModal
  pages/             # Overview, Latency, Incidents, Uptime, ServiceDetails, Settings, Ranking, Statusline
  hooks/             # usePolling, useTheme, useLang, useSettings, useGitHubStars
  utils/             # analytics, calendar, time, pageContext, constants, hashRoute, webhookSubscription
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
  rss.ts             # Incident RSS feeds (/feed.xml, /feed/:slug) + Slack-poller behaviours
  fallback.ts        # Fallback recommendation (tiered, Score-ranked)
  suppression.ts     # Operator incident-suppression layer (#904)
  probe.ts probe-archival.ts   # Direct RTT probing (32 targets) + daily archival
  daily-summary.ts weekly-briefing.ts monthly-archive.ts monthly-narrative.ts  # Discord reports + archives
  api-traffic.ts outage-audience.ts referral.ts vitals.ts   # WAE/KV instrumentation
  growth-series.ts   # Durable daily series of the consent-free growth counters (#986) — the dataset #547's lift measurement reads
  reddit.ts security-monitor.ts changelog.ts platform-monitor.ts  # External monitoring
  alert-feed.ts ext-claude.ts indexnow.ts badge.ts og.ts og-render.ts  # Feeds, projections, SEO, images
  parsers/           # statuspage, incident-io, gcloud, aistudio, instatus, betterstack, aws, flashduty
extension/           # Claude-only Chrome extension (MV3, #837) — consumes ?src=ext-claude only
plugin/aiwatch/      # Claude Code plugin (#920) — outage monitor + /aiwatch command
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

### Service Status Determination
Per-service status is resolved in `worker/src/services.ts` with a layered priority chain (multi-component worst-of → component match → overall-indicator fallback → `incidentExclude` bypass → component-status filter → fetch-failure cross-validation). The full ordered rules and their #-issue rationale are in **[docs/reference/status-determination.md](docs/reference/status-determination.md)** — read it before changing status resolution.

### Status Data Flow
Browser (60s polling) → Worker `/api/status` (parallel 39-service fetch, normalize, KV write, platform/probe cross-validation) → React state → pages. Cron (`*/5`) handles probing, incident detection + Discord alerts, AI analysis, daily/monthly aggregation, changelog/security/weekly briefing. The full annotated request + cron + Web Vitals flow diagram is in **[docs/reference/data-flow.md](docs/reference/data-flow.md)**.

### SPA Navigation
No React Router. Hash-based routing in `App.jsx` — `#claude` for service details, `#latency` for pages. `PageContext` shares current page state. Browser back/forward supported via `popstate` listener.

### Key Product Constraints

> Headlines only. **The detail each of these accumulated lives in
> [docs/reference/product-constraints.md](docs/reference/product-constraints.md)** — read the relevant
> block before changing AI analysis, fallback gating, deploy/cron behaviour, CSP, the PWA service
> worker, or any Edge SSR surface.

- **Mobile breakpoint 768px** — sidebar hidden (overlay on hamburger), cards go 1-column.
- **Phase 3 AI Analysis (Beta)** — hybrid Gemma 4 26B (Workers AI, primary) + Claude Sonnet (AI Gateway, fallback); per-incident `ai:analysis:{svcId}:{incId}` KV, TTL refresh, re-analysis, dedup, ongoing-past-estimate wording. `ANTHROPIC_API_KEY` secret required for the Sonnet fallback.
- **Contextual + grouped fallback** — the modal/Overview gate on service status, the is-down card + Discord gate on `needsFallback` (#454). Tier priority + `EXCLUDE_FALLBACK` membership: [docs/reference/fallback-tiers.md](docs/reference/fallback-tiers.md).
- **No-official-uptime services** (`bedrock`, `azureopenai`) — AIWatch invents **no** uptime value (#713); Score rescales onto available components, `low` confidence withholds the score entirely. Coverage gate (#802) holds a <30-day service out of rankings.
- **Worker deploy rules** — dev via `npx wrangler dev --config worker/wrangler.toml --port 8788`; dry-run before deploy; **deploy once**, only via `npm run deploy:worker` (never bare `wrangler deploy` — it deploys the SPA). Verify the output says `Uploaded aiwatch-worker`.
- **Cron `*/5`** — incident detection + Discord alerts (KV ID dedup), AI analysis inline (cancellable 15s budget), holds, cache refresh on a status edge (#488). Alert paths: [docs/reference/discord-alert-paths.md](docs/reference/discord-alert-paths.md).
- **Frontend deployment** — Vercel, `ai-watch.dev`; `git push origin main` auto-deploys. `npm run build` is local only. `api/` files count against the Hobby **12-Serverless-Function cap** unless edge-runtime or `_`-prefixed (#862/#867; CI guard `check-vercel-function-count`).
- **CSP (#482)** — enforced on the SPA (`vercel.json`, hash-locked) and per-response on every Edge SSR page (nonce for no-store surfaces, content-hash for cached is-down). Policy + rationale: [docs/reference/reference-csp.md](docs/reference/reference-csp.md).
- **PWA** — `public/manifest.json` + `public/sw.js` (stale-while-revalidate); the cache name auto-derives from `asset-manifest.json` (an md5 of the content-hashed asset filenames), so there is **nothing to bump by hand** — a version bump invalidates it too, via the inlined `__APP_VERSION__`; registered in production only (#432).
- **Edge SSR surfaces** — is-down (SEO, `?e=`/`?i=` social-card pinning), intro, methodology, plugin, plugin-privacy, badges, reports proxy.

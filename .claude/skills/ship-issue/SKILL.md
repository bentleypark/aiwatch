---
name: ship-issue
description: >-
  The full per-issue engineering workflow for the aiwatch repo — invoke at the START of work on a
  GitHub issue (or any free-form code change) AND again BEFORE closing an issue. Loads the complete
  procedure fresh (branch → design check → code → local verify → build+test → PR review loop →
  commit/PR → merge → checklist verification + cross-issue reconciliation → close) so the steps
  aren't lost the way a one-time CLAUDE.md read is on long sessions / after compaction. Use it
  whenever you start, advance, or close issue work, or when reconciling open-issue status.
---

# Ship an issue — per-issue workflow

This is the canonical procedure. CLAUDE.md holds the *architecture/reference* (what the code is);
the #415 hooks are the *mechanical backstop* (mostly soft reminders at the tool-call moment — the
stop-nag gate can block — but they can't run a multi-step procedure or see issue state). This skill
is the *procedure* — follow it top to bottom.

## ⚙️ Non-negotiable gates (the most-missed — re-check at the decision moment, not just here)

1. **Local verify (step 3.5)** — before committing, start the right dev server AND get the USER's
   explicit **in-browser confirmation**. Your own curl/Playwright/test runs do **not** satisfy this.
   "Tests pass" ≠ "feature verified". After requesting verification, **STOP and wait** for the user.
   - Reachability gate: if the change only manifests under a specific state (active incident,
     `down`/`degraded`, AI analysis, error/empty, a flag), that state is usually absent in live data
     — set up the trigger yourself (mock `usePolling`, seed local KV, craft a fixture), confirm it
     renders, then hand off telling the user exactly which state to look at. Revert the temp
     mock/fixture before commit (`git checkout` it) and confirm `git status` shows only intended files.
   - UI-less backend change (cron/WAE/RSS XML): there's no browser surface — verify by producing the
     real artifact (e.g. run the actual builder fn, fetch the real endpoint) and show it; say so plainly.
2. **PR review before every commit** — run `/pr-review-toolkit:review-pr`; fix all Critical/Important;
   **auto-loop** (fix → re-test → re-review) until a round is 0 Critical/Important. Don't wait for a
   prompt to start the next round.
3. **Commit / push / PR / merge only after the user asks or confirms.** A green/MERGEABLE PR is NOT a
   cue to auto-merge.
4. **No nag** — never end a turn with "shall I proceed / merge / 진행할까요? / 다음 작업 진행할까요?".
   Report results and stop.

## Per-issue steps (follow in order)

0. **Re-read this skill + the issue.** `gh issue view N` — note every checklist item.
1. **Branch** from main: `git checkout main && git pull && git checkout -b {type}/{N}-{desc}`
   (`type` ∈ fix/feat/refactor/docs/chore/test). Even issue-less free-form changes get a branch —
   never commit to main. Before committing, `git status` must show **only** the intended files
   (branch switches can drag a prior PR's staged/untracked files along).
   - First check `gh pr list` for an existing open PR on the same issue (avoid dupes).
2. **Design check** (UI only) — compare against `docs/AIWatch_화면디자인_초안_v2.html`; list every
   spacing/color/font/layout/text difference before coding.
3. **Code** the change.
3.5. **Local verify** — gate #1 above. Hand off and **wait** for the user's in-browser confirmation.
4. **Build + test** by scope:
   - Frontend (`src/`): `npm run build` + `npm run test:src` + `npm test` (Playwright).
   - Worker (`worker/`): `npx wrangler deploy --config worker/wrangler.toml --dry-run` + `npm run test:worker`.
   - New worker logic → extract to an exported fn + unit-test it. New `src/utils/` → Vitest test.
   - **Every bug fix ships a test that would have caught the bug.**
5. **PR review** — gate #2: `/pr-review-toolkit:review-pr`.
6. **Fix review findings — auto-loop** to 0 Critical/Important (Suggestions-only = converged).
7. **Docs update** — update whatever the change affects: CLAUDE.md (architecture/service count/layout —
   keep it **lean, ~40k-char guideline**; move detail to `docs/reference/`), the relevant
   **`docs/reference/`** file (see the directory — kv-schema, ga4-events, fallback-tiers,
   status-determination, discord-alert-paths, etc.), README(.ko), `index.html` SEO meta,
   `aiwatch-reports/`. Adding a service → the full `adding-a-service.md` checklist.
8. **Commit + PR** (gate #3 — only after the user confirms):
   - Commit message + PR body end with the required Co-Authored-By / 🤖 footer.
   - `closes #N` **only when ALL checklist items are done AND verified** — this includes
     time/production-gated verification (e.g. "queryable after deploy", "shows after next cron"):
     if such an item can't be verified yet, it's a **remaining** item → use **`refs #N`** and close
     manually after verifying (do NOT let `closes` auto-close it prematurely).
   - **Cross-issue reconciliation** — also scan OTHER open issues this change touches:
     fully implements another → add `closes #M`; partially advances → `refs #M` + comment;
     **supersedes/invalidates** another (a newer finding/feature makes it moot) → comment the why + close it.
   - Avoid stray `close|fix|resolve #N` keywords for issues you don't mean to close (auto-close trigger).
9. **Verify Vercel Preview** (frontend) from the PR.
10. **Merge** (gate #3): `gh pr merge --squash --delete-branch`.
    - Deploy: Vercel auto-deploys on main merge; **Worker is manual** — `npm run deploy:worker` (confirm
      output says `Uploaded aiwatch-worker`), once, after user approval. If several worker PRs are open,
      merge + resolve all THEN deploy once (no half-deploys).
11. **Verify checklist** — `gh issue view N`; confirm **every** `- [ ]` item is actually implemented in
    code before closing. Re-run step-11-style verification on `deferred`/`tracking` issues periodically —
    later/incremental work may have completed one without any PR claiming `closes`.
12. **Close** — only after verification: `gh issue close N`. Unverified/deferred items remain → keep the
    issue open with a label whose **exit condition is written in the body** (e.g. "close when secrets set
    & data confirmed"). Never close immediately after merge.

## Why this is a skill, not just CLAUDE.md
CLAUDE.md loads once at session start and fades on long sessions / compaction, so its Development
Workflow section gets skipped. Invoking this skill re-injects the full procedure at the moment you
need it. It complements (does not replace) the #415 enforcement hooks and the CLAUDE.md reference.

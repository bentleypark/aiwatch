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
   - Dashboard data source: DEFAULT to the **local worker with real data** (`npm run dev:worker` +
     `ALLOWED_ORIGIN=*` in `worker/.dev.vars`) — the SPA's `MOCK_SERVICES` fixture is stale/fabricated
     and misrepresents real states, and the prod `workers.dev` worker is CORS-blocked from localhost
     (Origin allowlist). See CLAUDE.md "Local verification by page type" Note.
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
   - **Worktree (parallel sessions):** run `git worktree list` FIRST, before branching. A worktree or a
     main-repo branch you didn't create means a concurrent session is active (already being in your OWN
     worktree satisfies this); in that case do this work in a git worktree
     (`claude --worktree <name>` / `git worktree add`), NOT an in-place branch on the shared main repo
     (a concurrent session can `git checkout` it out from under you, dragging its uncommitted WIP into
     your diff — the failure this rule exists to prevent). Launched via the
     VS Code extension? It does **not** auto-create a worktree (the Desktop app does) — say "work in a
     worktree" right after the session starts to relocate via the `EnterWorktree` tool. See CLAUDE.md
     "Parallel sessions (git worktrees)". Once in a worktree, edit / `cd` / test **only** via the
     worktree path: an absolute or main-root path silently leaks edits into the main repo (memory
     `feedback_worktree_edit_path`). `ls` early to confirm you're in the worktree.
2. **Design check** (UI only) — compare against `docs/AIWatch_화면디자인_초안_v2.html`; list every
   spacing/color/font/layout/text difference before coding.
3. **Code** the change.
3.5. **Local verify** — gate #1 above. Hand off and **wait** for the user's in-browser confirmation.
4. **Build + test** by scope:
   - Frontend (`src/`): `npm run build` + `npm run test:src` + `npm test` (Playwright).
   - Worker (`worker/`): `npx wrangler deploy --config worker/wrangler.toml --dry-run` + `npm run test:worker`.
   - New worker logic → extract to an exported fn + unit-test it. New `src/utils/` → Vitest test.
   - **Every bug fix ships a test that would have caught the bug.**
5. **PR review** — gate #2: `/pr-review-toolkit:review-pr`. **How to invoke it and how to read what it
   returns** — which agent by domain, why only `code-reviewer` carries a severity floor, and why the
   suggested rewrites in a report are not to be adopted — is
   [docs/reference/code-review-policy.md](../../../docs/reference/code-review-policy.md) (#1245).
   - **Carry the round number, the RUNNING Critical total, and the prior round's findings into the next
     review prompt (#1097/#1124).** The review agents are spawned fresh each round and cannot see how many
     rounds have run or what the last one found — *you* are the only place that history lives, so state it:
     "this is round N; round N-1 flagged {findings}, which I fixed by {changes}; {C} Criticals so far across
     all rounds; for each finding, say whether the text it lands on was added by my last round's fix." The
     `{changes}` slot and that last clause are what step 6's trigger runs on — every round of the loop sits
     in one cumulative uncommitted diff, so unless you say what the last fix changed the reviewer cannot
     attribute anything, and on #1110 the causality was volunteered only from round 5 on. The cumulative
     total is what makes *not converging* visible while each individual round still looks healthy.
6. **Fix review findings — auto-loop** to 0 Critical/Important (Suggestions-only = converged).
   - **Ask one question of fact about each finding before acting on it: did it arrive with a reproduction,
     a failing check, or a mutation that goes red? (#1245)** Per finding, not per round: a round mixes
     both kinds, and one adjudicable finding must not carry its siblings into the next round on its
     reproduction.
     - **Yes → work it, and never cap the rounds.** Several rounds is normal and legitimate: on #1052
       four rounds each found a guard that reported green while guarding nothing, all via real mutations;
       on #1110 round 3 found an unescaped apostrophe that broke `/methodology`'s inline i18n script.
     - **No → do not carry it into another round.** Build the thing that would adjudicate it first, or —
       when nothing could — drop the claim instead of rewording it. #1237 hit this and named the remedy
       itself: two fixes attempted during review "produced worse defects" in a script with "no automated
       test", so it deferred that piece — "Follow-up, harness first". #1241 built the harness first, and
       its rounds then reproduced seven defects before fixing each.
   - **STOP when the previous round's fix INTRODUCED this round's finding, twice in a row (#1124).** This
     trigger is causal, not a label — it needs no self-classification. It replaces the old "same finding *category* 3 rounds
     running" trigger, which was self-assigned and therefore evadable: on #1110 rounds were labelled by
     surface topic ("apostrophe", "hollow guard", "roster omission"), so "new category → keep going"
     read as healthy for 8 rounds and 17 Criticals.
   - **When it fires, change the CLASS of fix — do not take another pass at the sentence.** Ask:
     **(a)** is this claim load-bearing for the point being made? If not, **delete it** — an unneeded
     enumeration / classification / causal claim is verification debt, not content. **(b)** Am I holding a
     conclusion fixed and swapping in weaker support each round? Then weaken the *conclusion* to what the
     evidence carries, not the wording — *milder-each-round is the tell*.
   - **Delete the CONSTRUCT, not the sentence.** Copy that restates code branch logic — service
     enumerations, render conditions, per-source parser matrices — is unbounded verification debt: no test
     pins it and it drifts with every parser change (memory `feedback_no_prose_mirror_of_code_branches`).
     When a finding lands on such a construct twice, remove the construct. "Delete it" was satisfied
     cosmetically three times on #1110 by dropping individual clauses while the enumeration that kept
     generating them stayed; deleting a never-needed parser list ended the last-4-of-12 sub-loop on #1091
     instantly.
   - **Prose: from round 4 of the loop onward, a fix to the FLAGGED TEXT may only REMOVE text (#1124)** — a purely mechanical
     correction (escaping, a typo, a renamed identifier) is not an addition. A qualifier added to be "more
     precise" is itself a new unverified claim. Applies to docs, comments and issue bodies as much as to UI copy.
7. **Docs update** — update whatever the change affects: CLAUDE.md (architecture/service count/layout —
   keep it **lean, ~40k-char guideline** — check `python3 -c "print(len(open('CLAUDE.md').read()))"`,
   move detail to `docs/reference/` if near), the relevant **`docs/reference/`** file (see the
   directory — kv-schema, ga4-events, fallback-tiers, status-determination, discord-alert-paths, etc.),
   README(.ko), `CONTRIBUTING.md`, `index.html` SEO meta, `aiwatch-reports/`. Adding a service → the
   full `adding-a-service.md` checklist.
8. **Commit + PR** (gate #3 — only after the user confirms):
   - Commit message + PR body end with the required Co-Authored-By / 🤖 footer.
   - `closes #N` **only when ALL checklist items are done AND verified** — this includes
     time/production-gated verification (e.g. "queryable after deploy", "shows after next cron"):
     if such an item can't be verified yet, it's a **remaining** item → use **`refs #N`** and close
     manually after verifying (do NOT let `closes` auto-close it prematurely).
   - **Production-gated → add a `verify-after` line (#541)** so the check isn't forgotten: when an
     item needs a production-data check after a delay, add a line to the issue body
     `- [ ] **verify-after YYYY-MM-DD** — what to check + where` (pick a realistic date). The daily
     `verify-reminders` GitHub Action pings the operator Discord when due (and weekly while open);
     closing the issue / removing the line cancels it. This replaces "remember to check the board".
   - **If the check is machine-checkable, add a Tier-A `assert:` line (#873)** so the daily job
     **auto-verifies** it (ticks the box + drops `verify-blocked` + closes) instead of pinging you.
     Indent it directly under the verify-after line:
     `      assert: GET /api/status/cached | services[id=turbopuffer].scoreConfidence == "medium"`.
     Assertable = a predicate over an AIWatch JSON endpoint (a `/api/status` field, a count/threshold,
     `exists`); NOT GA4/GSC-CTR/consent-gated or behavioral checks — leave those as a plain human ping.
     Validate it before it ships: `node scripts/verify-assertions.mjs --issue N` (dry-run is the default; `--apply` mutates). Grammar +
     allowlist + fail-open semantics: **[docs/reference/verify-assertions.md](../../../docs/reference/verify-assertions.md)**.
   - **⚠️ Before writing the date, name what will still EXIST on it (#1206).** A dated line is worth
     nothing if the thing it points at is gone when the ping arrives. On 2026-08-05 three came due and
     all three were undecidable: #1179's KV records had aged out (7h/24h TTLs), #1104's code path
     leaves no trace at all, #1103 needed an operator tweet nobody had sent. Two were closed unverified.
     So one of these three must hold, or the line does not get a date:
     1. an **`assert:`** sub-line (above) — a machine decides it; or
     2. a **`durable:`** sub-line naming an artifact that outlives `date − today`, e.g.
        `      durable: incidents:monthly:2026-08 (60d retention)` / `durable: Discord #ops-alerts`; or
     3. neither is possible → **add the instrumentation in this PR** so a trace exists, or write **no
        date** — just a reopen trigger in the body ("reopen when X happens, then check Y").
     A KV key's TTL is the usual trap: check it against the date. The daily job labels
     **`verify-undecidable`** on any not-yet-due line carrying neither marker, so this is caught within
     a day either way — but fixing it while the context is warm is the point.
   - **An overdue item is not extended forever.** Past **30 days** overdue the daily report escalates it
     as *needs a disposition* rather than pinging again (#1206). The disposition is a human one: make
     the check observable, or close the issue with a written reopen trigger. Never "push the date".
   - **Placement (canonical, #921 format):** collect EVERY `verify-after` line — each with its indented
     `assert:` sub-line, if any — under ONE dedicated heading at the **bottom of the body**:
     ```
     ## Production-gated verification
     - [ ] **verify-after YYYY-MM-DD** — what to check + where. PR #N.
           assert: GET /api/status/cached | services[id=X].field == "value"
     - [ ] **verify-after YYYY-MM-DD** — a human check, with the artifact it will read named.
           durable: archive:monthly:2026-08 (no TTL)
     ```
     `assert:` and `durable:` may appear in either order under the line, and a line may carry both.
     One consistent home — NOT inline in a part's checklist, NOT a top `> Status:` callout — so the
     reminder lines are always in the same place and the body-drift guard reads cleanly. A multi-part
     issue lists one `verify-after` line per part under the same heading (keep each line's note so it's
     clear which part it verifies). The `verify-reminders` scanner is whole-body, so placement is
     cosmetic for the automation — this convention is purely for human consistency across issues.
   - **Cross-issue reconciliation** — also scan OTHER open issues this change touches:
     fully implements another → add `closes #M`; partially advances → `refs #M` + comment;
     **supersedes/invalidates** another (a newer finding/feature makes it moot) → comment the why + close it.
   - Avoid stray `close|fix|resolve #N` keywords for issues you don't mean to close (auto-close trigger).
9. **Verify Vercel Preview** (frontend) from the PR.
10. **Merge** (gate #3): `gh pr merge --squash --delete-branch`.
    - Deploy: Vercel auto-deploys on main merge; **Worker is manual** — `npm run deploy:worker` (confirm
      output says `Uploaded aiwatch-worker`), once, after user approval. If several worker PRs are open,
      merge + resolve all THEN deploy once (no half-deploys).
    - **Sync the issue body NOW — do NOT defer to close.** When the PR used `refs #N` (the issue stays
      open for a `verify-after`), immediately reconcile the body: **tick every shipped `- [ ]` box**, add
      a dated `> **Status (YYYY-MM-DD):**` line summarizing what shipped + what remains, and apply the
      **`verify-blocked`** label. Why here and not step 11: step 11's checklist-sync fires at CLOSE, but a
      verify-blocked issue never reaches close for weeks — so its body silently drifts (shipped code still
      showing `- [ ]`) until a triage sweep finds it. This is the single most-missed sync (it's a late,
      no-gate step in GitHub, a different system than the git diff the hooks watch). The daily
      `verify-reminders` **body-drift guard** backstops it — it labels any `verify-blocked` (non-`tracking`)
      issue whose body still has unchecked NON-`verify-after` boxes — but the guard is the safety net;
      syncing at merge is the fix. (`tracking` umbrellas are exempt: they legitimately keep open sub-items.)
11. **Verify checklist** — `gh issue view N`; confirm **every** `- [ ]` item is actually implemented in
    code before closing. Re-run step-11-style verification on `U3-someday`/`tracking` issues periodically —
    later/incremental work may have completed one without any PR claiming `closes`.
12. **Close** — only after verification: `gh issue close N`. Unverified/not-yet-done items remain → keep the
    issue open with a label (`U3-someday`) whose **exit condition is written in the body** (e.g. "close when secrets set
    & data confirmed"). Never close immediately after merge.
    - **Flip the initiative edge (#969).** If this issue advanced an Initiative, move its `advances:: #N`
      to `delivered:: #N` on the `initiative_*` memory page — the one moment that fact becomes true.
      `advances` means *pending*; a closed issue left on it is a lint finding. Add `(pin — why)` when the
      delivered work still binds a future decision (e.g. it invalidates data a pending review will read).
      Without this step the graph holds only backlog, and `strategy-review` must re-derive progress from
      prose. Rules: [docs/reference/decision-graph.md](../../../docs/reference/decision-graph.md).
      - **Flipping the edge is not enough — the prose goes stale too.** The lint checks edges, not
        currency, so a `delivered::` can be correct while the `Next action` / `Inputs` / blocker prose
        that framed the same issue as *pending* keeps lying. When you flip an edge, grep the page for that
        issue number and retire any sentence that called it a blocker, a next action, or a precondition
        — the resolution you just recorded made it moot. Same for a governing **Decision** that a closed
        issue resolves: set its `Status:` and any child decision whose trigger was that review. (This gap
        was hit on 2026-07-15: `delivered:: #547` landed, but the "#547·16 blocks the review" analysis
        sat stale until the next review swept it.)

## Why this is a skill, not just CLAUDE.md
CLAUDE.md loads once at session start and fades on long sessions / compaction, so its Development
Workflow section gets skipped. Invoking this skill re-injects the full procedure at the moment you
need it. It complements (does not replace) the #415 enforcement hooks and the CLAUDE.md reference.

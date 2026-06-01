---
name: issue-triage
description: >-
  Board-level open-issue staleness sweep + prioritization for the aiwatch repo. Invoke when reviewing
  open issues ("오픈된 이슈 우선순위 확인" / "이슈 위생 점검"), when the board feels stale, or after a
  batch of merges/deploys — to catch issues that shipped without a closing PR, were superseded by newer
  work, or had their premise invalidated, and to re-tier what to work next. Complements the ship-issue
  skill: ship-issue reconciles ONE issue at PR time; this is the periodic board-wide backstop for the
  issues that slip through (no PR ever claimed `closes` them).
---

# Issue triage — periodic staleness sweep + prioritization

CLAUDE.md's per-issue close hygiene (and the `ship-issue` skill) only fire on the issue you're
actively working. Issues still go stale when: work shipped incrementally across PRs and none said
`closes #N`; a *different* PR superseded them; or a later finding invalidated their premise. This
skill is the periodic backstop — run it over the whole open board.

## Run the sweep

1. **List the board**: `gh issue list --state open --limit 100 --json number,title,labels,createdAt`,
   `gh pr list --state open`, AND `gh pr list --state merged --limit 30` — question ① (shipped-not-closed)
   is about work in **merged** PRs, so the merged list is the one that catches it.

2. **Per issue, ask the 3 staleness questions** — any "yes" means it's likely not a live work item:
   - **① Already shipped?** Did the work land (this/other/incremental PRs) with no PR claiming `closes`?
     → run the **verify-before-close** check below; if it passes, close.
   - **② Superseded?** Did a newer feature/issue make it obsolete?
     → comment *why* + name the superseding issue/PR, then close.
   - **③ Premise invalidated?** Did a later finding retire the assumption it rests on?
     → re-scope (new issue with the corrected hook) or close.
   - Pay special attention to `deferred` / `tracking` / `phase-N` labels — their blocker may have
     cleared, or incremental work may have quietly completed them.

3. **Verify before closing** (parity with ship-issue step 11): `gh issue view N`, read every
   `- [ ]` item, and confirm each against the **actual code** (grep for the symbol/file, run/read the
   test). Grep + read the code for the read-side too (or dispatch an `Explore` subagent via the
   Agent tool) — "the write half shipped" ≠ "done".
   - A **time/production-gated** item ("queryable after deploy", "shows after N months of archives")
     that can't be checked yet is a **remaining** item → keep the issue open with a labeled exit
     condition; do NOT close on the strength of code alone.

4. **Label hygiene**: every `deferred`/`tracking` issue must carry a **written exit condition** in its
   body ("close when X"). If the condition has cleared → close or drop the label. If a label has no
   exit condition, add one.

5. **Cross-issue reconciliation backstop**: for each recently-merged PR this sweep surfaces, check
   whether it *also* closes/supersedes OTHER open issues that weren't reconciled at PR time.

## Prioritize what's left

Tier the genuinely-live issues (don't just list — recommend the next pick):
- **P1 — high value, scoped**: clear acceptance, reasonable effort, ties to a current pain point or
  the stated strategy (e.g. the monthly service-expansion cadence). Security/observability fixes.
- **P2 — strategic, needs scoping**: larger features / infra / monetization-adjacent — flag that they
  need a design pass first.
- **P3 — docs / community / marketing**: low effort, low urgency.
- **Tracking / deferred**: leave as-is *if* the exit condition still holds; otherwise step 2 applies.

## Output + norms

- Produce a **triage table**: per issue → `close` / `re-scope` / `keep + label` / `priority tier`,
  with the one-line reason. Then state the **recommended next action**.
- **Act on confirmation**: closing/commenting/relabeling issues follows the same norm as the rest of
  the workflow — propose the triage, then apply the closes/labels the user confirms (issue ops are
  reversible, but the project norm is to confirm closes; see the gates in `ship-issue`).
- Write issue comments in **English** (repo convention); keep them factual (what shipped / what
  superseded / why the premise changed), with the issue/PR references.

## Why a skill
Same reason as `ship-issue`: a periodic ritual described only in CLAUDE.md gets skipped on long
sessions / after compaction. Invoking this re-injects the sweep procedure when you actually review
the board. Hooks can't see issue state, so this is behavioral — but loaded on demand, not relied on
from a faded one-time read.

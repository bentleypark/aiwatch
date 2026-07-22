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
   - **Also sweep the `aiwatch-reports` repo** (the monthly-report site + generator — a sibling repo
     at `~/Desktop/bentely/aiwatch/aiwatch-reports`, with its own issues like the #27–#29 generator
     work). Run the same three lists there: `gh issue list --state open --repo bentleypark/aiwatch-reports`
     (+ open/merged PRs). The two repos cross-reference (e.g. `aiwatch#586`/`#591` → reports-generator
     PRs), so reconcile across **both** boards: a worker/dashboard fix can leave a reports-generator
     follow-up open, and vice-versa.

2. **Per issue, ask the 3 staleness questions** — any "yes" means it's likely not a live work item:
   - **① Already shipped?** Did the work land (this/other/incremental PRs) with no PR claiming `closes`?
     → run the **verify-before-close** check below; if it passes, close.
   - **② Superseded?** Did a newer feature/issue make it obsolete?
     → comment *why* + name the superseding issue/PR, then close.
   - **③ Premise invalidated?** Did a later finding retire the assumption it rests on?
     → re-scope (new issue with the corrected hook) or close.
   - Pay special attention to `U3-someday` / `tracking` / `phase-N` labels — their blocker may have
     cleared, or incremental work may have quietly completed them.

3. **Verify before closing** (parity with ship-issue step 11): `gh issue view N`, read every
   `- [ ]` item, and confirm each against the **actual code** (grep for the symbol/file, run/read the
   test). Grep + read the code for the read-side too (or dispatch an `Explore` subagent via the
   Agent tool) — "the write half shipped" ≠ "done".
   - A **time/production-gated** item ("queryable after deploy", "shows after N months of archives")
     that can't be checked yet is a **remaining** item → keep the issue open with a labeled exit
     condition; do NOT close on the strength of code alone.

4. **Label hygiene**: every `U3-someday`/`tracking` issue must carry a **written exit condition** in its
   body ("close when X"). If the condition has cleared → close or drop the label. If a label has no
   exit condition, add one. (The legacy `deferred` label is retired — relabel any survivor to `U3-someday`.)

5. **Cross-issue reconciliation backstop**: for each recently-merged PR this sweep surfaces, check
   whether it *also* closes/supersedes OTHER open issues that weren't reconciled at PR time.

## Classify + prioritize (two persistent axes → derived priority)

Label every live issue on TWO axes (persistent labels), then DERIVE priority each sweep.

**Axis 1 — area (domain / which hat):**
`area:dev` (features/bugs/tests) · `area:design` (UX/UI) · `area:ops` (infra/deploy/self-reliability/
internal tooling) · `area:biz` (monetization/pricing/partnerships/licensing) · `area:marketing`
(SEO/social/community/outreach/press). Pick ONE primary; add a second only when genuinely split
(e.g. self-host template = biz+ops). `ui`→area:design; `backend` is a sub-tag of dev/ops.

**Axis 2 — urgency:**
`U0-now` (prod break / security / data loss) · `U1-soon` (high value, this cycle) · `U2-later`
(valuable, no time pressure) · `U3-someday` (nice-to-have / signal-gated — the urgency-axis successor
to the now-retired `deferred` label); `tracking` stays for meta umbrellas.

**Derived priority** = Impact × Urgency × (1 / Effort) — Impact and Effort are per-sweep judgments
(NOT labels); only `area`/`urgency` persist. Do NOT store priority as a label; recompute each sweep:
- **P0** — any `U0-now`. Drop everything.
- **P1** — high impact + `U1-soon` + small/medium effort. The "do next" set.
- **P1\*** — **work already shipped; only a dated production-verify remains.** NOT a do-next coding
  item — see the verify-before-recommend gate below. Keep it off the recommended-pick list. Every
  `P1*` issue carries the persistent `verify-blocked` label so the next sweep skips it by label alone.
- **P2** — high impact + large effort (needs a scoping/design pass first), OR high impact + `U2-later`,
  OR medium impact + `U2-later`.
- **P3** — low impact / `U3-someday`.

### What `Impact` means (#1122)

`Impact` stays a per-sweep judgment — but an undefined factor in a formula is not a judgment, it is a
blank. Rank by **how wrong the product is while the issue sits open**, not by how annoying it is:

1. **Wrong value shown to users** — a number, badge, or claim that is confidently incorrect. The worst
   class: nobody can tell it is wrong by looking, so it is believed. Uptime, Score, incident
   attribution, duration.
2. **Silent failure** — the thing simply does not happen and emits no signal (a dead alert channel, a
   dropped incident, a guard that passes while blind). Ranks just under (1) because there is at least
   no false claim, but it shares the property that waiting produces no evidence.
3. **Correct but degraded** — right answer, bad experience: missing recommendation, slow, ugly, an
   empty state where content belongs.
4. **Internal-only** — costs us time, no user-visible surface. Tooling, docs, CI ergonomics.

**1–2 = high impact, 3 = medium, 4 = low** — the vocabulary the P-tiers above already use. The scale is
an ordinal rank, not a multiplier: `Impact × Urgency × (1 / Effort)` names the factors you weigh, it
does not compute (lower number = worse here, same direction as `U0…U3`). `Effort` is likewise a written
judgment, not a defined scale.

Note that `U0-now` (prod break / security / data loss) is an **urgency** gloss, not this scale — an
issue can be Impact-1 and still be `U2-later` if it fires rarely. Impact ranks a *class* — "if it
fires, users see a wrong value" — never evidence that it fired. When that distinction decides a
ranking, go measure before you rank, and re-rank on what you find.

### Verify-before-RECOMMEND (the most-missed; same gate as verify-before-close)

> Recurring failure (`feedback_triage_verify_before_recommend`): the "recommended next pick" was tiered
> from the **body + label alone**, so issues whose code already shipped and are now `verify-after`
> signal-gated (e.g. #547/#586/#587) kept getting recommended as **P1 do-next**. The `U1-soon` label is
> an *urgency* axis — it does NOT flip to "done" when the code ships, so a label-only read mis-reads a
> verify-gated issue as actionable.

Before recommending ANY issue as do-next, verify it the **same way** you'd verify a close candidate:
1. **Cheap shipped-check on each candidate** (1–2 issues): `git log --all --grep="#N"` + grep the
   symbol/file. If a linked PR is already **merged**, the coding is likely done.
2. **Auto-demote to `P1*` (exclude from do-next)** if EITHER: a linked PR is merged, OR the body has a
   `verify-after` line / a `## Remaining (post-deploy)` (or equiv.) section. Such issues are
   **signal-gated**, not actionable — their remaining item is a dated GA4/prod-data check, not code.
3. **Label the gate so the next sweep sees it without re-deriving**: add `verify-blocked` to a
   verify-gated issue (create the label once if missing). A `verify-blocked`/`verify-overdue` issue is
   skipped from do-next by **label alone** next time — closing the gap that lets it leak back in.
   **If the remaining check is machine-checkable** (a predicate over an AIWatch JSON endpoint), also add
   a Tier-A `assert:` line under its `verify-after` (#873, [docs/reference/verify-assertions.md](../../../docs/reference/verify-assertions.md))
   so the daily job **auto-drains** it — the fastest way to shrink the verify-blocked pile. GA4/GSC-CTR
   /behavioral checks aren't assertable; leave those as a human ping.

Only issues that survive this gate (real remaining code work) are eligible for the recommended pick.

Recommend the next pick **balanced across areas** — don't starve biz/marketing/design by always
picking dev. Surface the per-area counts (count a dual-area issue under its primary) so a lopsided
board is visible.

## Output + norms

- Produce a **triage table**: per issue → action (`close` / `re-scope` / `keep + label`) and, for the
  live ones, `area` · `urgency` · effort → derived `P`, with a one-line reason. End with per-area
  counts + the **recommended next pick** (balanced across areas).
- **State every deadline you are trading off, with its date.** If the pick beat another issue on
  urgency, name the loser's clock too — a deadline you did not write down is one you did not weigh
  (#1122). An announced third-party date is the usual kind; the date is fixed, so only your slack shrinks.
- **Cleanup cost of already-archived data is a real ranking input, but do not assert what it is from
  memory** — the rebuild/suppression/override mechanics differ per archive field and the repo's own
  docs are in tension about them. Read [operator-tools.md](../../../docs/reference/operator-tools.md)
  before putting a number or a claim on it (#1122).
- **Any derived count needs a positive and a negative control before it moves a ranking** — a script, a
  `jq` over `/api/report`, or a hand tally alike. Pick one case you already know must be counted and one
  you know must not, established *outside* the thing you are checking (a hand-read of the raw payload,
  an existing issue's verified timeline), and assert both before reporting. A scoping bug fails toward
  alarm as readily as toward "all fine", and neither looks wrong in the output — see
  `feedback_derived_signal_needs_scoped_diagnostic` (#1122).
- **Never print a bare issue number.** Every `#N` in the triage table, the re-ranking, or the
  recommended pick carries a short title or a few-word gloss — `#671 (bump actions/*@v4)`, not `#671`.
  The operator is being asked to sanction a *ranking*, and a ranking of opaque ids cannot be checked:
  disagreeing requires knowing what the rows are, so bare numbers quietly convert review into assent.
  The same applies to a `refs`/`supersedes` reference in an issue comment. The rule is about rows the
  operator is ranking — a provenance citation like the `(#1122)` on this line is exempt.
- **Act on confirmation**: closing/commenting/relabeling issues follows the same norm as the rest of
  the workflow — propose the triage, then apply the closes/labels the user confirms (issue ops are
  reversible, but the project norm is to confirm closes; see the gates in `ship-issue`).
- Write issue comments in **English** (repo convention); keep them factual (what shipped / what
  superseded / why the premise changed), with the issue/PR references.
- **Body is the source of truth — sync the checkboxes, don't just comment.** When a verify/triage step
  confirms an item shipped, **tick the body `- [ ]` → `- [x]`** (and add a 1-line `> **Status (date):**`
  block at the top of the body) — do NOT record the outcome only in a comment. Recurring failure: an
  issue's state ends up scattered across the body Acceptance list + a Post-deploy list + several
  comments, so `gh issue view` shows `0/N` while the real state (4/N) lives only in the last comment —
  forcing a comment re-read every sweep. Comments hold **evidence/history**; the **body checkboxes hold
  current state**. Keep them in sync so the status is readable from the body in one place.
- **Don't fork the checklist into a comment.** (Additive to the rule above.) Never restate a checklist
  — an `### Acceptance status` block, a re-listed `- [ ]` set, a phase table — inside a **comment**; it
  forks the single source of truth and immediately drifts. A progress/verify comment is **prose
  evidence only**. To change state, edit the **issue body** with `gh issue edit {N} --body-file <f>`
  (NOT a comment). Collapse multiple body checklist sections (Acceptance + Post-deploy + stray `- [ ]`
  lists) into one where practical — but **keep the dated `verify-after` line**, since the
  verify-before-recommend gate above keys its demotion off exactly that line. To clean up a comment that
  already duplicated a checklist, edit that comment via
  `gh api -X PATCH /repos/{owner}/{repo}/issues/comments/{id} -f body='…'` — convert its `- [ ]`/`- [x]`
  markers to plain text (e.g. `⬜`/`✅`) so the boxes live only in the body.

## Why a skill
Same reason as `ship-issue`: a periodic ritual described only in CLAUDE.md gets skipped on long
sessions / after compaction. Invoking this re-injects the sweep procedure when you actually review
the board. Hooks can't see issue state, so this is behavioral — but loaded on demand, not relied on
from a faded one-time read.

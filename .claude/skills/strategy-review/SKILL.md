---
name: strategy-review
description: >-
  Fuse board progress × priority × decision-context into one solopreneur brief. Invoke when deciding
  "what should I work on next" across the whole product ("전략 리뷰", "상황 정리해줘", "다음 뭐 하지",
  when returning after a break and needing to reconstruct "why we're here"), especially for the
  never-closing biz/marketing initiatives (#803/#637) whose board state reads 0/N while the real state
  + rationale live in a Status block or a memory page. Complements issue-triage: issue-triage does the
  board progress + priority sweep; this ADDS the decision-context layer — it loads the LLM Wiki
  decision graph and traces each priority through the "why" (which decision constrains it, which metric
  evidences it), then emits a summary do-next + per-initiative detail. Read docs/reference/decision-graph.md.
---

# Strategy review — fuse progress × priority × decision-context (#917)

The recurring solopreneur pain: I can see *what's in progress* (board) and *what's urgent* (labels),
but the **decision context** — current situation + why we chose this + what we rejected + what it
constrains — is scattered, so every return-to-decide re-pays a reconstruction cost. This skill fuses
the three so priority comes **with its reasoning**, not just a rank.

It reuses `issue-triage` for the raw board pass and adds the decision-graph traversal on top. The
vocabulary (entities + relations + the `type:decision` page format) is
**[docs/reference/decision-graph.md](../../../docs/reference/decision-graph.md)** — read it first.

## When to invoke vs issue-triage
- **issue-triage** — "is the board stale / which issues to close / re-tier": a hygiene sweep over
  GitHub issues. No memory/decision layer.
- **strategy-review** (this) — "what should I actually work on next, and why": fuses the board pass
  WITH the decision graph + metrics + current situation. Run it when the *why* matters (planning,
  returning after a break, a lopsided biz/marketing board). It calls the board pass internally, so you
  don't need to run issue-triage separately first.

## Procedure (follow in order)

### 1. Load the standing context (the "why" + constraints)
- Read `MEMORY.md` (the index), then load every **`type:decision`** page (the `## Decisions` section)
  and the relevant **`project`** pages. These are the standing decisions that bound priority — e.g.
  `decision_depth_not_breadth`, `decision_ontology_saas_deferral`.
- Note each decision's `Status`: **active** (a live constraint), **revisit** (past/near its trigger —
  goes in the "decisions to revisit" section), **superseded** (check its dependents were updated).
- Load the **`type:constraint`** pages too (the `## Constraints` section — `constraint_solo_capacity`,
  `constraint_kr_network_separation`, `constraint_neutrality_moat`, `constraint_free_tier_budget`).
  They cap what's even decidable, and each one's `bounds::` edges name the decisions it shapes — so
  "what limits this call?" is a lookup on the constraint page, not a re-derivation from prose.

### 2. Initiative state — from the `initiative_*` pages, NOT the board
- Read every **`type:initiative`** page (the `## Initiatives` section of `MEMORY.md`). Each one's
  `Current state` / `Evidence` / `Next move` / `Exit criterion` **is** the state of record. A
  `tracking` GitHub issue is a thin pointer; its checkboxes and its `0/N` are not the truth and must
  never be read as progress.
- This ordering is the whole point of the skill. Biz/marketing threads (#803 growth, #637
  monetization) don't fit the issue shape — they have a thesis under test, not a done condition — so
  deriving their state from the board is how the reconstruction cost got paid over and over. Read the
  pages first; the board only tells you which execution slices are in flight.
- Each page's `advances::` edges enumerate its live slices (rule 1b). Flag two things: an initiative
  whose `Next move` is empty, and one whose `Exit / kill criterion` has a clock that never started.

### 3. Board pass — executable slices + do-next (reuse issue-triage)
- Run the `issue-triage` board sweep over the issues that genuinely ARE execution units (dev/ops
  bugs + features): list open issues + labels, open/merged PRs (both repos), apply the 3 staleness
  questions, derive `P0–P3` from the area/urgency labels (skip `verify-blocked` / `verify-overdue`
  from do-next by label alone; apply the verify-before-recommend gate).
- Cross-check the last ~15 merged PRs against each initiative's `Current state` line: a merge that
  advanced an initiative but left its page's state stale is a finding — **update the page**.
- Do NOT try to reconstruct an initiative's progress from its issues. If an initiative page is
  missing for a live strategy thread, say so; that is the finding.

### 4. Fuse via the decision graph → emit the brief
Traverse the relations (`advances` / `constrains` / `evidences` / `bounds` / `supersedes` / `blocks`)
to connect each candidate to its rationale, then output BOTH:

- **Top — do-next recommendation** (area-balanced, per issue-triage's balance rule), each line tracing
  the reasoning through the graph:
  > **#N — do next.** [current situation] · consistent with [[decision_X]] · evidenced by [metric] ·
  > blocked-by / constrained-by [node] (if any).
- **Per-initiative detail** — for each initiative: where it stands, what's next, and the governing
  decision(s) inline (so the *why* is on-screen, not reconstructed). Flag any initiative whose live
  work contradicts an `active` decision.
- **Decisions to revisit** — every `Status: revisit` past its trigger date/condition, plus any
  `superseded` decision whose dependent issues/pages weren't updated (a silent contradiction).

## Output norms
- One brief, two altitudes (summary do-next on top, initiative detail below) — the shape this skill's
  originating session (#917) prototyped.
- Cite nodes by their memory slug / issue number so the brief is traceable back into the graph.
- If a priority call rests on a decision that's gone stale (its context changed), say so and route it
  to "decisions to revisit" rather than silently recommending against it.
- Do NOT mutate issues/labels here (that's issue-triage's job on confirmation) — this is a read +
  synthesize pass. If the review surfaces a NEW durable decision, capture it as a `type:decision` page
  (via memory-ingest), don't leave it only in the brief.

## Why this is a skill
Same rationale as issue-triage / ship-issue: a periodic fusion ritual described only in CLAUDE.md gets
skipped on long sessions / after compaction. Invoking this re-injects the procedure + the decision-graph
traversal at the moment you're deciding what to do next. The decision graph it reads is the durable
layer; this skill is the traversal engine over it.

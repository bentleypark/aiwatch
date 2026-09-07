---
type: reference
title: "Decision Graph — ontology-lite for progress × priority × decision-context"
description: "The lightweight entity + relation vocabulary the strategy-review skill traverses to fuse board progress, priority, and the decision context behind it. Schema-level only — no OWL/RDF/graph DB (#917)."
tags: [memory, decisions, strategy, tooling]
---

# Decision Graph — ontology-lite (#917)

> Extracted to keep CLAUDE.md lean. This is the **vocabulary** (shared, in-repo); the **decision
> instances** live as `type:decision` pages in the private LLM Wiki memory (`~/.claude/.../memory/`).
> The [strategy-review skill](../../.claude/skills/strategy-review/SKILL.md) traverses this graph to
> answer "what's next → **why** → what it constrains" as a lookup instead of a manual scavenger hunt.

## Why this exists (the problem it solves)

A solopreneur needs, in one place: **progress** (where each initiative stands), **priority** (what to
do next), and the **decision context** (current situation + why we chose this path + what we rejected).
`issue-triage` gives the first two; the *why* is scattered across issue bodies, comments, PR
descriptions, commits, `discovery/`, and memory pages, so every return-to-decide re-pays a high
reconstruction cost — worst for never-closing biz/marketing initiatives (#803/#637) whose board state
reads `0/N` while the real state + rationale live only in a Status block or a memory page.

Root cause: the context exists but the **relations between entities are not explicit**. Making the
relation *types* explicit turns the traversal into a lookup. Our LLM Wiki is already ~80% of this
(`[[wikilinks]]` = edges, pages = nodes, `type:` = class); this doc just names the entity + relation
types so they're used consistently.

## Scope — light, NOT formal (a deliberate #917 decision)

- **Light ontology (this doc): YES.** A named set of entity types + relation types, expressed as
  frontmatter conventions + typed `[[wikilinks]]`. That is the whole ontology.
- **Formal ontology (OWL/RDF/reasoner/SPARQL): NO.** Its value is automated inference + cross-org
  interop; a solo decision log needs neither — the **LLM is the reasoner** at review time, and
  schema-drift maintenance is the opposite of what a solo wants.
- **Graph DB: NO.** Wikilinks + frontmatter ARE the graph; the LLM traverses the markdown.
- **SaaS / multi-agent: NO.** The "agent" is a single periodic LLM fusion step (the skill / a cron),
  already provided by Claude Code. See the `decision_ontology_saas_deferral` memory page.

## Entities (node types)

| Entity | What it is | Lives in |
|---|---|---|
| **Initiative** | A strategy thread that spans many issues and **never "closes"** — it has a thesis under test, not a definition of done (#803 growth, #637 monetization). | `initiative_*` memory page (**the state of record**). A `tracking` GitHub issue may exist as a thin pointer for board visibility — it is not where the state lives. |
| **Decision** | A choice made, with its context/options/rationale/constraint. | `type:decision` memory page (format below). |
| **Issue / PR** | A unit of execution. | GitHub. |
| **Metric** | A quantitative signal used as evidence (GA4 new-users, `referral:out`, uptime, outage-audience). | `/api/*`, daily-summary, GA4 — **no memory page**. |
| **Constraint** | A standing limit that bounds decisions. | `constraint_*` memory page — `constraint_solo_capacity`, `constraint_kr_network_separation`, `constraint_neutrality_moat`, `constraint_free_tier_budget`. |
| **Project** | A scoped body of work, a recorded practice, or a research artifact — bounded, unlike an Initiative, and not itself a Decision (`project_service_data_richness_check` = a gate we apply; `project_637_diligence` = the research that grounds a decision). | `project_*` memory page. |

## Relations (edge types)

Direction is **subject → object**, e.g. `constrains:: [[project_637_diligence]]`.

| Relation | Direction | Meaning | Example |
|---|---|---|---|
| `advances` | **Open** Issue → Initiative | a *pending* execution unit that will move the thread — written on the **initiative page** (rule 1b) | `initiative_growth` carries `advances:: #842` |
| `delivered` | **Closed** Issue → Initiative | an execution unit that *already* moved it. Same edge, other side of the closing event | `delivered:: #936 (pin)` |
| `constrains` | Decision → Initiative/Issue/Decision/Project | a decision bounds the option space | depth-not-breadth constrains the SaaS-deferral decision, and the data-richness gate we apply to new services |
| `supersedes` | Decision → Decision | a newer decision replaces an older one | `[[decision_no_invented_uptime]] supersedes:: [[decision_uptime_estimate]]` — both ends are pages (rule 3), never bare issue numbers |
| `evidences` | Metric / Project → Decision/Initiative | a signal or a research artifact is the basis for a decision | the #637 diligence (`project_637_diligence`) evidences depth-not-breadth |
| `bounds` | Constraint → Decision | a standing limit shapes what's decidable | KR network separation bounds the B2B API decision |
| `blocks` | Issue → Issue | one unit gates another | a probe-source decision blocks turbopuffer scoring |

As of 2026-07-09 the live graph exercises `advances` (×9), `constrains` (×9), `bounds` (×7) and
`evidences` (×1) — a snapshot; `npm run lint:graph` prints the live claimed-slice count, so trust it
over this line. **`supersedes` and `blocks` have zero instances** — they are declared for the cases
that will arise (a decision replaced; an issue gating another), not yet worked. If either is still
empty at the next `memory-lint`, drop it rather than keep dead vocabulary.

## Writing edges — four rules

The relation table above names each edge in ONE canonical direction. These rules say where it may be
written, so an edge never has two homes that can silently disagree.

1. **A typed `rel::` link is written on the page-backed end — the SUBJECT's page when both ends have
   one.** One edge, one home. `decision_depth_not_breadth` carries
   `constrains:: [[decision_ontology_saas_deferral]]`; the deferral page does NOT carry the mirror image.
   - **1b — if only the OBJECT has a page, the edge is written there.** `advances` (Issue → Initiative)
     has a page-less subject, so `initiative_growth` carries `advances:: #842`. Direction stays
     unambiguous because each relation's endpoint *types* are fixed by the table above.
2. **The object end may carry a plain, untyped `[[wikilink]]` as a backlink.** There are no inverse
   relation names — `constrained-by`, `evidenced-by`, `expressed-as` are **not** vocabulary. If you
   want to say "what governs this page", link it plainly and let the reader follow the typed edge home.
3. **The object may be a `[[wikilink]]` OR a stable external id.** An `Issue`/`PR` has no memory page
   by design but does have a stable id, so `constrains:: #920` (a decision bounding an execution unit)
   is a well-formed edge. An anonymous `Metric` has neither. Never point a typed link at free prose.
   - **An `Initiative` is NOT in this list** — it has a page (rule 4). Point initiative edges at
     `[[initiative_growth]]`, never at the `#803` tracking issue: that issue is a thin pointer, and an
     edge aimed at it re-parents the graph onto the board this design moved it off.
   - **A `Decision` always has a page.** An edge may leave the wiki only because the entity type has
     no page *by design* — never because a decision went unrecorded. If you catch yourself writing
     `bounds:: #862` (a PR that stands in for an architecture decision), write the decision page
     instead. Without this the decision log slowly hollows out: strategy decisions keep their pages
     while every architecture decision drains into issue numbers, and `strategy-review` can no longer
     answer "why" without leaving the graph.
4. **An Initiative is NOT a GitHub issue.** An issue is a unit of execution with a done condition; a
   strategy thread has a thesis under test and never closes. Forcing one into the other is what makes
   `#803`/`#637` read as `0/N` on the board while their real state lives in a Status block — the
   original complaint behind this whole graph. So the state of record is the `initiative_*` page, and
   `advances::` edges on it enumerate the issues that move it.
   - A `tracking` GitHub issue may remain as a **thin pointer** (board visibility, a place for others
     to comment). It carries a line naming the initiative page as the state of record; it does not
     carry the state.
   - **Is this thing an Initiative? Four questions, and the default answer is NO.**
     1. **Does it close?** If the issue can state its own "close when" / sunset / done condition, it is
        an execution unit. An Initiative's exit is a *kill or a graduation*, never a completion.
     2. **Does `N/M` lie?** #803's boxes can all tick while the thesis stands still (infrastructure
        shipped, conversion still 0). If the checkboxes track the truth, it is an execution tree.
     3. **Does a Decision govern it?** An initiative page exists to hold the scattered *why*. If no
        `constrains::` edge points at it, there is no why to fuse and the page is a stub — the same
        trap as a Constraint node with no `bounds::` edges. A node's value is its edges.
     4. **Does its state live where the issue cannot hold it?** #637 carries **zero** Status blocks:
        a hypothesis under test has no done condition, so the issue format cannot express it. That
        absence is what forced its page.

     **A `tracking` label is not evidence.** As of 2026-07-09, of the ~12 `tracking` issues filed to
     date, **2 became Initiatives** (#803, #637) and nearly half had already closed — a snapshot, but
     the ratio is the point, not the count. Counter-examples worth memorising: **#400** declares
     `sunsets 2026-08-11` + a close-when → a phased rollout, not a thread. **#735** declares
     *"close as superseded by #637 Phase 3"* → it is a monetization **slice** that says so itself.
     Both were briefly mis-read as Initiative candidates by a `strategy-review` run that judged from
     the label instead of the body. **Read the body.**
   - **Do not use GitHub sub-issue links for this.** They model an execution tree (one parent per
     issue), not initiative membership — an issue routinely advances two threads, and a sub-issue
     progress bar re-asserts the `N/M` completion framing an initiative doesn't have. They stay
     available for genuine dev execution trees; they are not the `advances` edge.

Corollary of rules 1b + 3 — **the dividing line is an id, not a page.** A page-less subject that still
has a stable id (a GitHub Issue) makes a perfectly good typed edge, written on the object's page:
`advances:: #842` on `initiative_growth`. A subject with *neither* a page nor an id — an anonymous
Metric — cannot be a typed edge at all, so record it as a prose field on the page-backed end instead:
a decision page's `**Evidence:** outage-day GA4 (webhook_register 0)`.

Consequently a typed `evidences::` edge only ever originates from a **Project** page (page-backed,
rule 1). Metric-sourced evidence is always the prose `**Evidence:**` field, never a typed edge.

## `type:decision` page format (the decision instance)

A memory page, fixed shape (the harness normalizes `type`/`title`/`tags` under `metadata:` on write —
don't fight it; quote any `description` containing a bare `#`):

```markdown
---
name: decision_<kebab-slug>
description: "<one line — the choice, quoted if it contains #N>"
metadata:
  type: decision
---

**Decision:** <what was chosen, one sentence>
**Context:** <the situation at the time — what forced the choice>
**Options considered:** <the alternatives + why each was not taken>
**Why this:** <the reasoning>
**Evidence:** <the metric(s) this rests on — prose, since a Metric has no page (rule 3 corollary)>
**Constrains:** <typed links only, this page as subject: constrains:: [[initiative_x]] · constrains:: [[decision_y]] · constrains:: #920 (an Issue — never a tracking issue that has an initiative page)>
**Status:** active | revisit (<date/trigger>) | superseded by [[decision_y]]

<plain [[wikilinks]] to related nodes, incl. the constraints that bound this decision — their
`bounds::` edge lives on the constraint page, not here (rule 1)>
```

A `Constraint` page is the same shape minus Options/Status: what the limit is, why it's standing, and
its `bounds::` edges to every decision it shapes.

## `type:initiative` page format (the state of record)

Deliberately NOT a checklist. An initiative has no `N/M`; it has a thesis, a current reading, and a
next move. This is the shape that a `tracking` issue's checkboxes cannot express:

```markdown
**Status:** active | parked (<why, and what would revive it>)
**Thesis:** <what we're betting, in one sentence — falsifiable if possible>
**Current state (YYYY-MM-DD):** <where it actually stands, in prose. Supersede this line, don't append.>
**Evidence:** <the metrics that moved the reading, with numbers>
**Next action:** <a VERB, its cost, its deadline-or-trigger, and what it unblocks. Not a state.>
**Exit / kill criterion:** <what ends this thread — a kill-criterion, a graduation, or "ongoing operational">
**Pending:** advances:: #N · advances:: #M   <open execution units (rule 1b)>
**Delivered:** delivered:: #X (pin — why it still binds) · delivered:: #Y · delivered:: 2026-04 ×6
**Governed by:** <plain [[wikilinks]] to the decisions that constrain it — their `constrains::` edge lives on the decision page>
```

**`Status` is evidence, not mood, and it shows its work.** Write it as

```markdown
**Status:** active — last delivered 2026-07-08 (2 days ago) · 5 in the 30-day window
**Status:** parked — no delivered work since <date, or ever> · revival: <the one thing that would restart it>
```

Two numbers, because one is not enough: **recency** (when did this thread last ship?) and **cadence**
(how much, over a named window). A thread can be `active` with a low count if work is in flight — an
open PR, a `Next action` taken this week — because `delivered::` lags the work by the length of a
review cycle. Say which it is.

The 30-day window is a convention, not a truth: it is the shortest span over which a solo operator's
cadence is legible. Disclose it so a reader can disagree with it.

**Never define a window by a count of merges or PRs.** "The last 12 merges" is a window of *variable
length* — a busy day can hold a dozen — so comparing it against a 30-day window sets two different
spans side by side and invents a contradiction. Windows are measured in days. And keep two different
metrics apart:
**thread cadence** (this initiative's `delivered::` over a window) is not **repo attention** (the count
of merges in a window that advanced any initiative at all). The first tells you whether a thread is
alive; the second tells you where the hours went.

A `parked` thread emits **no `Next action`** — it emits its revival condition.

**`Next action` is a verb with a price — and it must carry its inputs.** "Waiting on the 2026-07-15
trigger" and "choose" are *states*, and a page that asks for a state gets one. But a verb alone is not
enough either: a reader cannot act on *"send outreach batch 1 (~2h)"* without knowing which five, from
what list, using what draft. Required shape:

```markdown
**Next action:** <verb + object>
  Inputs (have): <artefacts that exist right now — file, issue, dataset, with where>
  Inputs (missing): <what must be produced first>
  Cost: <only when nothing is missing. Otherwise "unknown — estimate after <the first missing input>">
  Unblocks / Deadline: <what it opens; external deadline vs self-imposed>
```

Four rules, each earned by getting it wrong:

1. **If `Inputs (missing)` is non-empty, this is not an action — it is the action's precondition.**
   Re-write the line as that precondition. Otherwise the brief hands you an instruction you cannot
   execute and calls it a plan.
2. **Never invent the cost.** `~30 min` and `~2h` were both fabricated in a real brief. Cost is a
   function of the inputs; if an input is missing, the honest value is *unknown*. A made-up estimate
   is worse than none, because it survives into a ranking.
3. **Verify `Inputs (have)` before writing it.** A brief once asserted an outreach draft did not exist;
   `discovery/outreach-templates.md` had held Templates A and B for weeks, and `leads.md` held twelve
   leads with ten verified contacts. The whole "decide whether to start" framing was an artefact of not
   looking. Checking cost two minutes.
4. **Mark each input `ratified` or `exploratory` — and an exploratory input never makes an action
   executable.** *Ratified* = a `decision_*` page, merged code, a closed issue. *Exploratory* = a
   `discovery/` artefact, a `project_*` page's recommendation, anything a diligence session produced.
   An exploratory input enables **a decision**, not an execution.
   - The rule exists because a brief read `project_637_diligence`'s prose — `How to apply (결정 = A,
     실패시 C)` — as ratification, and promoted the diligence session's lead list into an executable
     plan. But **no `decision_*` page records track A**, and by rule 3 a Decision always has one.
     Therefore A was never a decision; it was a recommendation. The honest next action was *"ratify A
     as a decision page, or confirm C"*, not *"send batch 1"*.
   - Corollary: if a `Next action` rests on a choice that has no `decision_*` page, **the next action is
     to make and record that decision.** The lead list is an input to executing A, never evidence that A
     was chosen. This is the same hollowing-out rule 3 guards against, arriving from the other side.
   - **Where to look, and when you cannot.** `discovery/` is **gitignored** and exists only at the
     main-repo root (`.../aiwatch/discovery/`) — a `git worktree` checkout does not contain it. If you
     are running from a worktree, read it from the repo root; if you cannot reach it at all, mark the
     input **`unverified (unreachable)`** rather than asserting either its presence or its absence.
     Both errors have been made: a brief once declared the outreach draft missing without looking, and
     a fresh executor was later sent to verify inputs in a directory its checkout could not see.

`Current state` is a **replaced** line, not an append-only log — the history is in `log.md`. An
initiative with no `Next action` and a `Exit criterion` whose clock never started is a finding, not a
steady state (see `initiative_monetization`).

`log.md` in the memory dir is the chronological index (append a line per new/changed decision).

## `delivered` and the fold rule (#969)

**Why the relation exists.** `advances::` edges must point at OPEN issues — the lint hard-fails a
closed one as a dead edge. So the moment an issue ships, it *leaves the graph*, and the initiative
retains only its backlog. Progress then lives in prose, which is why a `strategy-review` brief could
say what remains but had to re-derive what shipped — and once mis-measured "0 of 80 merges advanced an
initiative", a number that was true by construction and meaningless. `delivered::` is the same edge
after the closing event.

An Initiative never closes, so `delivered::` accrues forever. At this repo's rate (~7–9 initiative
issues closed per month) an unfolded page carries ~90 ids within a year: unreadable, and the lint's
liveness pass makes one `gh api` call per edge. Hence the fold, defined **before** the first entry
rather than retrofitted onto fifty cold ones.

**Three forms, each keeping only what its horizon needs:**

```markdown
delivered:: #936 (pin — 2026-07-08 이전 전환 데이터를 무효화)   ← pinned: never folds
delivered:: #777 · delivered:: #805                              ← inside the horizon: full ids
delivered:: 2026-04 ×6                                           ← folded: a counted period
```

**Every `advances::` / `delivered::` issue edge carries a gloss.** `delivered:: #936` says nothing;
`delivered:: #936 (pin — UTM 귀속 누수 봉합)` says what shipped. Write the gloss in the *initiative's*
language, not the PR title's: what it changed for the thesis, not which module it touched. **An issue
number is a citation, never the noun** — a rule this document already states for blockers, and which
applies equally to the work you did. The lint reports a missing gloss; a folded `YYYY-MM ×N` needs none.

- **Horizon = 90 days from the issue's close date.** Inside it, keep the id — this is what "what
  shipped since the last review" reads.
- **Beyond it, fold** into one `delivered:: YYYY-MM ×N` line per month. The count preserves the
  cadence signal ("this thread got 9 issues in June and 0 in July") which is the resource question a
  solo operator actually asks. The ids are not lost — GitHub still has them
  (`gh issue list --state closed --label area:marketing --search "closed:2026-04"`).
- **Pin what still changes a judgement.** `#936` closed, but it invalidates every conversion number
  recorded before it, so the 2026-07-15 channel review depends on it. A pinned edge never folds,
  regardless of age. If you cannot say in one clause *why* a delivered issue still binds a future
  decision, it is not a pin.

**The lint proposes; it never folds.** Folding is lossy, and `memory-lint`'s standing rule is that
lossy edits are proposed, not applied. `lint:graph --github` reports foldable edges (closed > 90d,
unpinned) at exit 0, exactly like unclaimed candidates.

**Where the edge flips.** `ship-issue` step 12 (close): if the issue advanced an initiative, move its
`advances::` to `delivered::` on the initiative page. One write, at the one moment the fact becomes
true.

## Where the bundle lives (#1353)

The bundle is a clone of the **private `aiwatch-wiki` repo**, checked out into this machine's harness
memory directory. It is not in this repo and never will be: it holds operator-only adoption
figures (the subject of #1354), and it cannot be split — the 17 decision/constraint/initiative
pages carry 72 wikilink crossings with the other 132, and strategy-bearing pages are typed `project`
while graph pages link out to purely engineering ones.

**`lint-decision-graph.mjs` is told the path; it never infers it.** `MEMORY_DIR`, else a gitignored
`.memory-dir` file at the repo root holding the path (`.worktreeinclude` copies it into new worktrees).
Neither present, or the path missing, or the directory holding no pages — all exit 2.

The bundle is a git clone, so `memory-ingest` / `memory-lint` writes stay uncommitted until someone
commits them, and a second machine needs a `pull` first. Neither skill prescribes those commands —
they are ordinary git operations on a second repo, and three attempts to write a policy for them into
the skills each contradicted either the workflow gates or the other skill.

Three schemes for inferring the path were tried during review and each grew a new hole one round
later: each added a predicate to a guard inspecting a filesystem this repo does not control.
**Do not add a fourth** — the operator knows the path, and one gitignored line records it.

Scaffolding in the bundle (its index, history log and README) is not a knowledge page. `NON_PAGE_FILES`
is the one in-repo definition of that set; `memory-lint`'s index-drift pass is told to consult it.

## What is lint-able, and what is not (#967)

The bundle splits the same way `index.md` splits the OKF bundle — **structural health** is mechanical,
**judgement health** is a human/LLM pass. `npm run lint:graph -- --github`
(`scripts/lint-decision-graph.mjs`) draws the line:

| | Failure | Checked? |
|---|---|---|
| **dead edge** | `advances:: #N` points at a closed issue, a PR, or nothing | ✅ hard finding |
| **wrong subject** | `bounds::` written on a decision page, `advances::` outside an initiative page | ✅ hard finding |
| **double claim** | one issue is a slice of two initiatives | ✅ hard finding |
| **dangling link** | `[[x]]` with no `x.md` | ✅ hard finding |
| **wrong claim** | a live, open issue listed as a slice that does not actually advance the initiative | ❌ judgement |
| **missing claim** | an issue that does advance it, unlisted | ⚠️ candidates only |

The last two cannot be mechanised without inventing an answer, so the lint reports *unclaimed
candidates* (open `area:biz`/`area:marketing` issues no initiative claims) and **exits 0**. Deciding
each one is step 2 of `strategy-review`, not the lint's job. A brief must therefore never merge the two
claims into one sentence: *"these 7 slices are OPEN"* is verified, *"these are the right 7"* is a dated
reading.

The lint **cannot run in CI** — the memory bundle is a private repo Actions has no credential for. Its pure functions are CI-gated through `npm run test:scripts`; the bundle
assertion is local, invoked by the `memory-lint` skill.

## How strategy-review uses it

The [strategy-review skill](../../.claude/skills/strategy-review/SKILL.md) loads `MEMORY.md` +
`decision`/`constraint`/`project` pages (standing context + constraints), then reads the `initiative_*`
pages as the **state of record** — `Status`, `delivered::` (what shipped), `advances::` (what remains),
`Next action`. It does **not** run `issue-triage` and emits **no board do-next**: ~90% of open issues
are dev/ops, so ranking them beside two strategy actions buries the strategy (that is `issue-triage`'s
job — run it separately). The board enters only as **evidence** — a blocker of an initiative, or where
the hours went. From that it emits: an **initiative-only** do-next (active threads first, then by what
evaporates; a `parked` thread contributes a revival condition, not an action), a per-initiative detail
block, and a "decisions to revisit" section (any `Status: revisit` past its *current* trigger — read the
live one, not a retired date — or a `superseded` decision whose dependents weren't updated). A hard
external deadline is a capacity note, never a ranked competitor.

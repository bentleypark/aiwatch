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
| `advances` | Issue → Initiative | an execution unit moves a strategy thread forward — written on the **initiative page** (rule 1b) | `initiative_growth` carries `advances:: #842` |
| `constrains` | Decision → Initiative/Issue/Decision/Project | a decision bounds the option space | depth-not-breadth constrains the SaaS-deferral decision, and the data-richness gate we apply to new services |
| `supersedes` | Decision → Decision | a newer decision replaces an older one | `[[decision_no_invented_uptime]] supersedes:: [[decision_uptime_estimate]]` — both ends are pages (rule 3), never bare issue numbers |
| `evidences` | Metric / Project → Decision/Initiative | a signal or a research artifact is the basis for a decision | the #637 diligence (`project_637_diligence`) evidences depth-not-breadth |
| `bounds` | Constraint → Decision | a standing limit shapes what's decidable | KR network separation bounds the B2B API decision |
| `blocks` | Issue → Issue | one unit gates another | a probe-source decision blocks turbopuffer scoring |

As of 2026-07-09 the live graph exercises `advances` (×9), `constrains` (×9), `bounds` (×7) and
`evidences` (×1). **`supersedes` and `blocks` have zero instances** — they are declared for the cases
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
**Thesis:** <what we're betting, in one sentence — falsifiable if possible>
**Current state (YYYY-MM-DD):** <where it actually stands, in prose. Supersede this line, don't append.>
**Evidence:** <the metrics that moved the reading, with numbers>
**Next move:** <the single next action, or "waiting on <trigger>">
**Exit / kill criterion:** <what ends this thread — a kill-criterion, a graduation, or "ongoing operational">
**Slices:** advances:: #N · advances:: #M   <the execution units that move it (rule 1b)>
**Governed by:** <plain [[wikilinks]] to the decisions that constrain it — their `constrains::` edge lives on the decision page>
```

`Current state` is a **replaced** line, not an append-only log — the history is in `log.md`. An
initiative with no `Next move` and a `Exit criterion` whose clock never started is a finding, not a
steady state (see `initiative_monetization`).

`log.md` in the memory dir is the chronological index (append a line per new/changed decision).

## How strategy-review uses it

The [strategy-review skill](../../.claude/skills/strategy-review/SKILL.md) loads `MEMORY.md` +
`project`/`decision` pages (standing context + constraints), runs the `issue-triage` progress+priority
pass over the board, joins issue Status blocks + recent merges (current situation), then **traverses
the relations** to emit: a top area-balanced do-next with its rationale traced through the graph ("do X
because [situation] + consistent with [decision Y] + evidenced by [metric Z]"), a per-initiative
detail block, and a "decisions to revisit" section (any `Status: revisit` past its trigger, or a
`superseded` decision whose dependents weren't updated).

---
type: reference
title: "Code-review policy (#1245) — how to invoke pr-review-toolkit and read what it returns"
description: "Which review agent to spawn, how to re-judge its severity labels, and what to take from a report and what to discard."
tags: [workflow, review, tooling]
---

# Code-review policy (#1245)

`ship-issue` steps 5-6 say *when* to review and when to stop looping. This page is the other half —
**how to invoke `/pr-review-toolkit:review-pr` and how to read what comes back**. It existed nowhere
until #1245; the three interventions on the review loop before it (#1097 → #1124 → #1150) all targeted
the stop condition, and none targeted the call.

The plugin is not ours to edit — it is installed from the official marketplace under
`~/.claude/plugins/` — so this page is the local discipline around it.

## What the plugin actually is

`review-pr` is a **command** that selects among **six agents** by what the diff touches. The agents,
and the two facts about them that matter most here:

| Agent | Domain | Notes |
|---|---|---|
| `code-reviewer` | CLAUDE.md compliance + real bugs | **the only agent with a reporting floor** |
| `comment-analyzer` | **code comments**, cross-referenced against the code they describe | advisory-only by its own spec |
| `pr-test-analyzer` | behavioural coverage | |
| `silent-failure-hunter` | catch blocks, fallbacks, swallowed errors | operates on "non-negotiable rules"; no floor |
| `type-design-analyzer` | type invariants | |
| `code-simplifier` | post-review cleanup | the one agent that **acts on** code rather than reporting |

## Pick by domain, not by how important the change feels

A standalone markdown page is **not** `comment-analyzer`'s domain. Its first task is *"Cross-reference
every claim in the comment against the actual code implementation"* — with no implementation to
cross-reference it has no anchor, which is what it was given on #1244.

For a docs-only diff, `code-reviewer` is the better match, with one thing said plainly: its file scopes
it to *"review code against project guidelines in CLAUDE.md"*, so CLAUDE.md compliance is in scope
and the factual accuracy of prose is a judgement you are asking it to make outside its spec. Name the
diff and what you want checked in the prompt rather than relying on the agent's defaults.

**Say which aspect you want.** A bare `/pr-review-toolkit:review-pr` lets the command route by file
type, and its own step 4 sends `comment-analyzer` when docs changed — the shape above. The command
takes aspect arguments (`code`, `tests`, `errors`, `types`, `comments`, `simplify`), so
`/pr-review-toolkit:review-pr code` is what selects `code-reviewer` alone.

## Re-judge severity; do not take the labels at face value

Only `code-reviewer` states a bar:

> Rate each issue from 0-100 … **91-100**: Critical bug or explicit CLAUDE.md violation …
> **Only report issues with confidence ≥ 80**

The other five have no floor. Their `CRITICAL` is not that scale, and on a diff outside an agent's
domain it is not anchored to anything. Before treating a finding as blocking, ask the `code-reviewer`
question of it: *is this a bug, or an explicit CLAUDE.md violation?* If neither, it is a Suggestion
however it was labelled.

## Take the finding, not the remedy

`comment-analyzer`'s fifth task is *"**Suggest Improvements**: … Rewrite suggestions for unclear or
inaccurate portions"* — handing back replacement prose is its spec, not a malfunction. That prose is
unverified by anyone. Adopting it inserts a new claim into the artifact, which the next round then
flags; on #1244 that path produced one of round 2's Criticals.

Take the **finding** ("this claim outruns its evidence") and discard the **remedy** ("write this
instead"). Where the finding names a deletion, apply the deletion.

## The remedy is withheld at the source (#1298)

"Take the finding, not the remedy" is a rule about what the CALLER does with a report, and on #1293 it
failed nine rounds running: every finding in rounds 8 and 9 landed on prose the previous round's fix had
just written, and one log message was wrong in BOTH directions across two rounds — first over-claiming an
ambiguity, then over-claiming its resolution.

Two things about that failure are worth separating. The policy was never opened (the path was cited in
subagent prompts without being read), but reading it would not have been sufficient: `ship-issue` step
6's causal stop trigger WAS in context every turn via the #415 hook and was violated anyway. So the
remaining lever is not a better reminder.

**`.claude/agents/review-findings-only.md`** is that lever. It is a project-defined reviewer whose system
prompt forbids replacement prose outright — findings, a locator, reproduction-or-judgement-call, and
round attribution, with no "change it to this". Where the answer is a deletion it says so as a finding
and lets the caller delete. It keeps the ≥80 floor, since that is the plugin reviewer's one real quality
signal. Use it for the step 5-6 loop from round 2 onward, when the previous round's fix is itself part of
the diff.

This is **not** the class of gate #1150 rejected. Those tried to judge the operator's reasoning ("did
this fix cause this finding?") — a content judgement measured through phrasing. This changes the INPUT:
with no remedy in the report there is nothing to adopt. It also does not depend on overriding the
marketplace agents, whose names are namespaced (`pr-review-toolkit:code-reviewer`); it is a separate
agent, invoked instead of them.

**What it does not do:** guarantee compliance. It removes one specific, repeatedly-used input. Nothing
here stops a caller from rewriting prose on its own initiative.

**Deployment caveat:** agent definitions load at SESSION START, like `.claude/settings.json` hooks. A
newly added or edited agent is not visible to the session that wrote it — `subagent_type` resolution
fails with "agent type not found" until a restart. Verify it resolves before relying on it.

## Verify a finding before acting on it

Every Critical is a claim about the record, and the record is one command away — `gh pr view`,
`gh issue view`, `git log`, `grep`. It matters most where a finding would make you *delete* something:
#1245 Part 1's round 1 claimed the whole feature was inert in production, and confirming that against
the real audit log is what made the fix the right one rather than a rewrite of working code.

## Do not edit a file while an agent is reading it

Both directions are recorded in the memory page `debugging_review_agent_clobbers_concurrent_edits`: an
agent's write clobbered concurrent edits (#1032), and a live mutation battery run during a review came
close to being reported as a Critical in the diff (#1224 — the agent was reading its own rsync
snapshot, so its conclusion held, and it flagged the anomaly with a timestamp). Run mutation batteries
on a copy, and when several agents are in flight, collect all reports before applying anything.

## Agent count is not the lever on loop depth

A second agent in the same domain adds report volume — on #1244 two agents on a docs diff returned
**opposing** recommendations rather than coverage. But it does not follow that fewer agents means
fewer rounds: #1245 Parts 1 and 2 each ran exactly one agent per round and still took five and four
rounds. Pick one agent per domain because a second adds nothing there, not because it will shorten the
loop.

## No lint checks whether a claim is true

`scripts/check-doc-symbols.mjs` (#1100) reads `CLAUDE.md` and `docs/reference/*.md` for citations, and
it checks one thing: that a backticked identifier exists somewhere in source. **A false claim in prose
is not an identifier**, so no lint sees it — in a doc or in a comment. #1245 Part 1 wrote a code comment
citing "CLAUDE.md's no-silent-caps rule", which does not exist; `npm run lint:docs` was green
throughout, and the review loop is what caught it, before merge. Claims of this kind carry no
automated check at all — they are review's job, and this page's job to say so.

## Related

- CLAUDE.md "Development Workflow" — the step outline; `ship-issue` is the runbook.
- [Workflow-gate hooks](workflow-hooks.md) — `review-loop-gate.mjs` records what each loop did, per
  branch since #1245 Part 1, and why the loop is not hook-enforced.

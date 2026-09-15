---
type: reference
title: "Code-review policy (#1245, #1412) — which reviewer the loop uses, and what to do with its report"
description: "The review loop invokes findings-only review every round, and how to act on a report."
tags: [workflow, review, tooling]
---

# Code-review policy (#1245, #1412)

`ship-issue` steps 5-6 are the procedure and are self-contained — the caller does not need this page to
run the loop. This page records why the procedure has the shape it has.

## The loop does not use `/pr-review-toolkit:review-pr` (#1412)

Every round, round 1 included, uses the project's findings-only reviewer: Claude Code spawns
`.claude/agents/review-findings-only.md`; Codex invokes `$review-findings-only` from
`.codex/skills/review-findings-only/`. The plugin left the loop because most of what this page used to
say existed only to correct it:

- its command fans out across several agents by file type, so round 1 returned a large batch that was
  fixed all at once, and round 2 then reviewed mostly new text;
- only its `code-reviewer` carries a confidence floor — the other agents' `CRITICAL` needed re-judging;
- its `comment-analyzer` hands back replacement prose by spec, and adopting that prose inserted claims the
  next round flagged (#1244).

The plugin is not ours to edit — it is installed from the official marketplace under `~/.claude/plugins/`.
Running it outside the loop is fine; its severity labels other than `code-reviewer`'s are unanchored, and
its suggested rewrites are not to be adopted.

## Why `review-findings-only` withholds the remedy (#1298)

A report's replacement prose is unverified by anyone. Taking the finding and discarding the remedy is a
rule about what the caller does, and it failed nine rounds running on #1293. The agent removes the input
instead: its system prompt forbids replacement prose, and where the answer is a deletion it says so as a
finding. It keeps the ≥80 floor. It does not stop a caller from rewriting prose on its own initiative —
that is what `ship-issue` step 6's no-prose rule is for.

**Availability caveat:** Claude agent definitions load at session start, like `.claude/settings.json`
hooks. A newly added or edited Claude agent is not visible to the session that wrote it —
`subagent_type` resolution fails with "agent type not found" until a restart. Codex reads its
project skill from `.codex/skills/`; sync it with `npm run skills:install` before opening a new Codex
turn that must invoke it.

## Verify a finding before acting on it

Every Critical is a claim about the record, and the record is one command away — `gh pr view`,
`gh issue view`, `git log`, `grep`. It matters most where a finding would make you *delete* something:
#1245 Part 1's round 1 claimed the whole feature was inert in production, and confirming that against
the real audit log is what made the fix the right one rather than a rewrite of working code.

## Do not edit a file while an agent is reading it

Both directions are recorded in the memory page `debugging_review_agent_clobbers_concurrent_edits`: an
agent's write clobbered concurrent edits (#1032), and a live mutation battery run during a review came
close to being reported as a Critical in the diff (#1224). Run mutation batteries on a copy, and when
several agents are in flight, collect all reports before applying anything.

## No lint checks whether a claim is true

`scripts/check-doc-symbols.mjs` (#1100) reads `CLAUDE.md` and `docs/reference/*.md` for citations, and
it checks one thing: that a backticked identifier exists somewhere in source. **A false claim in prose
is not an identifier**, so no lint sees it — in a doc or in a comment. Claims of this kind carry no
automated check at all; they are review's job.

## Related

- CLAUDE.md "Development Workflow" — the step outline; `ship-issue` is the runbook.
- [Workflow-gate hooks](workflow-hooks.md) — `review-loop-gate.mjs` records what each loop did, per
  branch since #1245 Part 1, and why the loop is not hook-enforced.

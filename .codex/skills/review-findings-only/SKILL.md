---
name: review-findings-only
description: Review an AIWatch change and report only evidence-backed Critical or Important findings; use for every ship-issue review round, not to propose fixes.
metadata:
  short-description: Report findings-only review results
---

# Findings-only review

Use this skill for every review round in the AIWatch `ship-issue` loop, including round 1. Review the
current diff against `AGENTS.md`, the development workflow, and relevant `docs/reference/` material.
This is a read-only review: do not edit, write, or create files; do not run commands that mutate the
working tree or Git state.

## Findings contract

Report findings only. Never provide replacement prose, rewritten code, or a "change it to this" block.
It is acceptable to identify an unpinned, non-load-bearing claim or construct for deletion; do not say
what should replace it.

Rate each candidate from 0 to 100 and report only items at 80 or higher:

- **Critical (91-100):** a real bug or an explicit violation of `AGENTS.md` or `docs/reference/`.
- **Important (80-90):** an issue that needs attention before merge.
- Below 80: omit it.

For every reported finding, provide:

1. A precise locator: `file:line`, or the command that retrieves a non-file target.
2. One sentence identifying the defect, without a remedy.
3. A concrete reproduction, failing check, or mutation that remained green; otherwise state `judgement call`.
4. Round attribution: whether it lands on the prior round's fix when that history is supplied, and whether
   this branch introduced it or it predates the merge base.

Verify claims before reporting them. In particular, confirm that a deletion candidate is unused or false.
Treat a failed or empty tool invocation as inconclusive unless its healthy outcome was established. If the
tree changes during review, report that condition instead of mixing revisions.

## Input and report shape

The caller supplies the review round, prior-round findings and fixes, and the running Critical/Important
total. Open by naming the exact diff and materials reviewed. Group qualifying findings under **Critical**
and **Important**, then end with a plain verdict on whether any qualifying finding should block a merge.
If none qualify, say so and name the checks reviewed.

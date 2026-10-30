---
name: issue-triage
description: Review the AIWatch open-issue board for stale, shipped, superseded, or invalid issues and derive the next work priority.
metadata:
  short-description: Triage and prioritize the AIWatch issue board
---

# Codex issue triage

Use this skill for a board-wide staleness sweep and prioritization. Run `git fetch origin`, record
`git rev-list --count HEAD..origin/main`, and inspect both AIWatch and the sibling reports repository
when it exists. List open issues, open PRs, and recently merged PRs with `gh`. For each open issue,
check whether it shipped, was superseded, or has an invalid premise; verify checklist items against
the code before recommending closure or work. Inspect every worktree with `git worktree list --porcelain`
and treat locks, non-empty status, or commits ahead of `origin/main` as in-flight work.

Classify live issues with one `area:` label (`dev`, `design`, `ops`, `biz`, or `marketing`) and one
urgency label (`U0-now` through `U3-someday`), then derive P0–P3 from impact, urgency, and effort.
Impact ranks wrong user-visible values highest, then silent failures, degraded experiences, and
internal-only cost. Exclude merged or `verify-after` work from the do-next list as P1*. Balance the
recommended pick across areas, state every deadline, and never print a bare issue number.

Use `exec_command` for git, `gh`, `rg`, and focused file reads. Do not mutate issues, labels, or bodies
until the user confirms. When applying a confirmed update, synchronize body checkboxes and retain
English factual comments as the repository convention requires.

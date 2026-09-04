---
name: ship-issue
description: Apply the AIWatch issue-to-release workflow when starting, implementing, verifying, reviewing, or closing an issue.
metadata:
  short-description: Ship an AIWatch issue safely
---

# Codex issue delivery

Use this skill at the start of, during, and before closing per-issue work. Read the issue checklist,
check for an existing PR, inspect all worktrees, and branch from `origin/main` in an isolated worktree.
For UI work compare the design draft before coding. Use `apply_patch` for edits and add a regression
test for every bug fix.

Verify locally before committing: use the local Worker with real data for dashboard work, the correct
Edge/Vercel surface for landing pages, and a real generated artifact for UI-less backend work. Tests
and automated browser checks do not replace the user's explicit in-browser confirmation. Run the
scope-appropriate lint, build, unit, E2E, worker typecheck, and dry-run deployment checks.

Review the complete diff against `AGENTS.md`, the development workflow, and relevant references.
Report only Critical or Important findings with a file/line locator plus reproduction or judgement
call; re-test after fixes until no such findings remain. Do not adopt unverified replacement prose.
Before commit, status must contain only intended files. Commit, push, PR, merge, deploy, and issue
close operations require explicit user approval. Keep production-gated checklist items open with a
dated `verify-after` plus `assert:` or `durable:` evidence when applicable.

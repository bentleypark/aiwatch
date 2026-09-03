---
type: runbook
title: "Agent-neutral development workflow"
description: "The shared issue-to-release workflow for Codex, Claude Code, and other coding agents."
tags: [workflow, agents, development]
---

# Agent-neutral development workflow

This is the shared procedure for implementing an issue in AIWatch. It applies to Codex, Claude
Code, and other coding agents. Agent-specific commands and automation are documented separately;
the engineering gates below remain the same.

## Before coding

1. Read `AGENTS.md`, this runbook, and the relevant `docs/reference/*` files.
2. Read the issue completely with `gh issue view <N>` and record every checklist item.
3. Run `git worktree list` before creating a branch. If another session is active, use a dedicated
   worktree and work only inside that directory.

   For a manually created worktree, complete the [worktree setup requirements](parallel-agents.md#two-things-every-new-worktree-needs)
   before running local commands: copy the required gitignored local config, run `npm install` in
   the worktree, and run `cd worker && npm install` for Worker work.
4. Create a branch from `main` using `{type}/{issue#}-{description}`. Never commit directly to
   `main`.
5. For UI work, compare the proposed change with `docs/AIWatch_화면디자인_초안_v2.html` before coding
   and record the intended differences.

## Implementation and verification

6. Read the relevant source and identify the root cause before changing code. Keep the change
   focused and add a regression test for every bug fix.
7. Run the appropriate local surface. Use the local Worker with real data for dashboard work and
   `vercel dev` for Edge pages. The standard local surfaces are:

   | Surface | Command | URL |
   | --- | --- | --- |
   | Dashboard | `npm run dev` | `http://localhost:5173` |
   | Landing / Is X Down | `npx vercel dev --listen 3333 --yes` | `http://localhost:3333/intro` or `http://localhost:3333/is-claude-down` |
   | Worker API | `npx wrangler dev --config worker/wrangler.toml --port 8788` | `http://localhost:8788/api/status` |
   | Monthly Reports | `cd ~/Desktop/bentely/aiwatch/aiwatch-reports && PATH="/opt/homebrew/opt/ruby/bin:$PATH" GEM_HOME="$HOME/.gem/ruby/4.0.0" bundle exec jekyll serve --port 4000 --unpublished` | `http://localhost:4000/reports/2026-03/` |

   For dashboard verification, set `ALLOWED_ORIGIN=*` in `worker/.dev.vars` and run the local
   Worker alongside Vite. When running multiple worktrees, offset each port by `+100` per slot and
   point `VITE_API_URL` at that worktree's Worker port.
8. For UI or Edge changes, obtain explicit user confirmation from the browser before committing.
   Curl, Playwright, and automated tests do not replace this confirmation. If the change requires
   a rare state, reproduce that state locally, verify it, and remove the temporary fixture before
   committing.
9. Run the scope-appropriate checks:

   - Frontend: `npm run lint`, `npm run build`, `npm run test:src`, and `npm test`
   - Worker: `npm run test:worker`, `npm run typecheck:worker`, and
     `npx wrangler deploy --config worker/wrangler.toml --dry-run`
   - Documentation: `npm run lint:okf`, `npm run lint:docs`, and `npm run lint:budget`; also run
     `npm run lint:korean` for Korean-copy changes and `npm run test:scripts` when scripts or
     workflow invariants are affected

## Review and handoff

10. Review the complete diff against `AGENTS.md`, this runbook, `CLAUDE.md` where applicable, and
    the relevant reference documents.
11. Follow the [code-review policy](code-review-policy.md): report only Critical or Important
    findings with a file/line locator, reproduction or explicit judgement call, and whether the
    previous fix caused the finding. A finding with a reproduction or failing check must be fixed
    without capping rounds; a finding without evidence must be adjudicated with a check or dropped.
    If the previous fix causes the finding in two consecutive rounds, change the fix class: delete
    a non-load-bearing construct or weaken the conclusion instead of rewriting it again. Re-test
    and re-review until no Critical or Important findings remain. A Codex review can use this prompt:

    ```text
    Review the current diff against AGENTS.md, CLAUDE.md, and the relevant docs/reference files.
    Report only Critical or Important findings. For each finding include file:line, a reproduction
    or “judgement call”, and whether the previous round's fix caused it. Do not write replacement
    code or prose.
    ```

12. Update all affected documentation in the same change: `AGENTS.md`, `CLAUDE.md` when its
    guidance is affected, `README.md`, `README.ko.md`, the relevant `docs/reference/*`,
    `CONTRIBUTING.md`, `index.html` SEO metadata, and `aiwatch-reports/` as applicable. Keep
    `AGENTS.md` concise; put detailed workflow or subsystem guidance in `docs/reference/`.
13. Before commit, confirm `git status` contains only intended files. Do not use `--no-verify`.

## GitHub and release boundaries

14. Commit, push, create a PR, merge, deploy, or close an issue only after the user explicitly asks
    or confirms that operation. A green test run or mergeable PR is not approval to publish.
15. Use the PR checklist and include both required footer lines:

    The `Co-Authored-By` line is a commit trailer in the commit message. The `🤖 Generated with`
    line is a PR-body footer. For any agent, use this form:

    ```text
    # Commit message trailer
    Co-Authored-By: <agent name> <agent email>

    # PR body footer
    🤖 Generated with [<agent name>](<agent product URL>)
    ```

    For Codex, use exactly:

    ```text
    # Commit message trailer
    Co-Authored-By: Codex <noreply@openai.com>

    # PR body footer
    🤖 Generated with [Codex](https://openai.com/codex/)
    ```

    Use `closes #N` only when every issue item is implemented and verified; otherwise use `refs #N`.
16. Verify the Vercel Preview for frontend changes. Worker deployment is a separate, approved,
    sequential operation using `npm run deploy:worker`; confirm the output says `Uploaded aiwatch-worker`.
17. After merge, re-read the issue, verify every checklist item against the shipped code, and close
    only when no unverified or deferred item remains. Keep production-gated work open with this
    canonical issue-body structure at the bottom:

    ```md
    ## Production-gated verification
    - [ ] **verify-after YYYY-MM-DD** — what to check and where
          assert: GET /api/status/cached | services[id=example].field == "value"
          durable: artifact that will still exist on the verification date
    ```

    `assert:` and `durable:` are optional and may appear in either order; the same line may carry
    both. Prefer the fast KV-backed `/api/status/cached` endpoint for assertions. After adding an
    `assert:` line, validate it immediately with `node scripts/verify-assertions.mjs --issue N`.
    Dry-run is the default; use `--apply` only when intentionally mutating the issue, and do not
    use a `--dry-run` flag. Use `assert:` for machine-checkable API predicates and `durable:` for a
    human check whose evidence will outlive the date. If neither is possible, do not add a date;
    write a concrete reopen condition instead.

    At merge, add the `verify-blocked` label while the production check is pending. The daily job
    adds `body-drift` when shipped checklist boxes remain unchecked, and removes it after the issue
    body is synchronized. See the [assertion and label lifecycle](verify-assertions.md#label-lifecycle)
    for the complete lifecycle; without `verify-blocked`, the body-drift guard does not scan the issue.

## Git hook compatibility

The repository's `core.hooksPath` is `.githooks`, configured by the `prepare` script. The tracked
`.githooks/pre-push` hook only checks additions or modifications under `.claude/agents/`, so normal
Codex changes are unaffected. If a Codex change modifies a Claude agent definition, the hook requires
the conscious override `AGENT_VERIFIED=1 git push`, because the repository currently has no spawn
recorder. This is the only Claude-specific pre-push behavior; it does not apply to ordinary source,
documentation, or configuration changes.

## Agent-specific mapping

- Claude Code: use `.claude/skills/ship-issue/SKILL.md` for the detailed procedure and the
  `.claude/` hooks/plugins for Claude-specific reminders and review tooling.
- Codex: use this runbook directly. Replace Claude-only slash commands with the equivalent review
  prompt above and run repository commands from the active worktree.
- Other agents: follow this runbook and use their native review/task mechanism only where it does
  not weaken the shared gates.

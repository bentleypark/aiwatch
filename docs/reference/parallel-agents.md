# Parallel AI-agent sessions (git worktrees)

Running multiple AI coding-agent sessions (Claude Code / Cursor / …) at once on this single
repo collides on four axes when they share one working directory: **file/git state** (one
`.git` HEAD + index), **dev-server ports** (fixed 5173/8788/3333/4000), **build/test
artifacts** (`dist/`, vitest/Playwright output), and **logical overlap** (two sessions editing
the same hot file like `services.ts`).

The fix is **git worktrees** — one isolated working directory per branch, sharing a single
`.git` object store. Edits in one worktree never touch another; conflicts are deferred to an
intentional merge, not the live edit. This is the 2026 industry-standard approach and Claude
Code supports it natively. (Container / microVM isolation is a heavier tier we intentionally
skip — see [Non-goals](#non-goals).)

## Quick start (Claude Code native)

```bash
# One isolated session per branch. Creates .claude/worktrees/<name>/ on a new branch,
# branched from origin/HEAD (clean tree matching the remote).
claude --worktree feat-852-something     # terminal 1
claude --worktree fix-820-reddit-oauth   # terminal 2
```

- Omit the name → Claude generates one (`bright-running-fox`).
- `claude --worktree "#1234"` branches from a PR.
- Inside a session, ask Claude to "work in a worktree" (uses the `EnterWorktree` tool).
- Subagents: add `isolation: worktree` to a custom subagent's frontmatter for permanent
  per-agent isolation.

`.claude/worktrees/` is gitignored, so worktree contents never show as untracked in the main
checkout.

### How you launch Claude decides startup isolation

The `--worktree` flag only exists on the CLI. If you launch another way, isolation comes from a
different path:

| Launch method | Isolation at startup | How to isolate |
|---|---|---|
| **CLI** (`claude`) | `--worktree <name>` flag | pass the flag (above) |
| **Desktop app** | **automatic** — every new session gets its own worktree | nothing to do |
| **VS Code extension button** | **none** — the session opens in the main checkout | say **"work in a worktree for this task"** right after it starts → Claude calls `EnterWorktree` and relocates the session into `.claude/worktrees/<name>/` |

The VS Code extension has **no auto-worktree at startup** (that is Desktop-only) and no
`--worktree` flag. So for a button-launched session there are two working paths: (1) tell Claude
to "work in a worktree" in-session (the `EnterWorktree` tool fully relocates the current
session's working directory — same effect as `--worktree`, just on demand), or (2) run
`claude --worktree <name>` in the VS Code **integrated terminal** instead of the button.

> A `SessionStart` hook **cannot** create/enter a worktree itself (hooks inject context, they
> don't call tools) — it can only *remind* the agent to do so. Auto-nudging via a hook is a
> deferred follow-up (see issue #852), not part of this baseline.

### Manual worktrees (any agent / tool)

```bash
git worktree add ../aiwatch-wt-852 -b chore/852-parallel-worktrees   # new branch
git worktree add ../aiwatch-wt-820 fix/820-reddit-oauth              # existing branch
git worktree list
git worktree remove ../aiwatch-wt-852                                # when done
```

## Two things every new worktree needs

A worktree is a **fresh checkout**, so it starts without dependencies or gitignored local
config.

1. **Local env** — handled automatically. [`.worktreeinclude`](../../.worktreeinclude) copies
   `.env`, `.env.local`, and `.dev.vars` into every Claude-Code-created worktree (gitignore
   syntax; only gitignored matches are copied). Manual `git worktree add` does **not** run
   this — copy them yourself.
2. **Dependencies** — **not** shared. Run `npm install` in each new worktree (`node_modules`
   and Python venvs are per-directory).

## Port-offset convention (concurrent dev servers)

Worktrees isolate files, not ports — two `npm run dev` on 5173 still collide. Assign each
parallel **slot N** (main checkout = slot 0) a `+100·N` offset:

| Service | Command | Slot 0 | Slot 1 | Slot 2 |
|---|---|---|---|---|
| Dashboard (Vite) | `npm run dev -- --port <P>` | 5173 | 5273 | 5373 |
| Worker | `npx wrangler dev --config worker/wrangler.toml --port <P>` | 8788 | 8888 | 8988 |
| Vercel Edge (`vercel dev`) | `npx vercel dev --listen <P>` | 3333 | 3433 | 3533 |
| Jekyll reports | `bundle exec jekyll serve --port <P>` | 4000 | 4100 | 4200 |

> **`VITE_API_URL` must match the slot's Worker port.** `.worktreeinclude` copies the main
> `.env` (pointing at `8788`), so in a slot-1 worktree edit `.env` to
> `VITE_API_URL=http://localhost:8888` before running the dashboard against its own Worker.

If you only run dev servers **one worktree at a time** (each is verified sequentially), the
offset is unnecessary — the collision only matters when two servers run at once.

## File-ownership discipline (avoid merge pain)

Worktrees remove *physical* collisions but not *logical* ones: two sessions each editing
`services.ts` still meet at merge. This is solved by task design, not tooling — assign each
session **non-overlapping files / issues** (e.g. session A = `worker/` alerts, session B =
`api/is-down` UI). Don't hand a large edit to a shared module (`services.ts`, `index.ts`,
`constants.js`) to two sessions at once. Most teams find **3–5 parallel agents** the practical
ceiling before review/coordination overhead offsets the speed.

## Shared-resource caveat — deployment stays sequential

Worktrees isolate *source*, not *production*. `worker/wrangler.toml` points at a **single
production Worker + KV namespace**, so the "deploy once, after approval, ≤1×/day" rule
([CLAUDE.md](../../CLAUDE.md), "Worker deployment rules") is a global constraint regardless of
how many worktrees exist. **Never** run `npm run deploy:worker` from two worktrees. Local
`wrangler dev` is fine in parallel (different ports).

## Non-goals

- **Container isolation (Tier 2)** — Dagger Container-Use etc., worktree + per-agent container
  for full port/DB isolation. Deferred; revisit only if concurrent full-stack dev-server runs
  become routine.
- **MicroVM cloud sandboxes (Tier 3)** — Firecracker/E2B/Conductor. Their purpose is safely
  running *untrusted* agent-executed code; overkill for a single-owner codebase.
</content>

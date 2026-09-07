---
name: memory-lint
description: >-
  Periodic health check of the file-based LLM Wiki memory (the `~/.claude/.../memory/` bundle) — the "lint"
  operation of the Karpathy LLM-Wiki pattern. Invoke every week or two, or after a batch of memory-ingest
  writes, or when the memory "feels stale". Finds contradictions, stale/superseded claims, orphan pages,
  broken `[[wikilinks]]`, index drift (file↔MEMORY.md mismatch), unquoted-`#` frontmatter truncation, and
  redundant clusters worth merging — then records findings in log.md. Read-only proposals for anything
  destructive; the user confirms merges/deletions.
---

# memory-lint — keep the LLM Wiki healthy

The file memory (a clone of the private `aiwatch-wiki` repo; `docs/reference/decision-graph.md` says where) compounds over
time; without periodic linting it drifts. This is the **lint** operation of the LLM-Wiki pattern (#891).

## When to run
- Every 1–2 weeks, after a batch of `memory-ingest` writes, or when recall feels noisy/stale.

## Checks
1. **Index drift** — every `memory/*.md` (except the scaffolding in `NON_PAGE_FILES`, `scripts/lint-decision-graph.mjs`) has exactly one MEMORY.md line, and every MEMORY.md
   link resolves to a file. Report `NOT INDEXED` / `MISSING FILE`.
2. **Broken wikilinks** — every `[[stem]]` resolves to an existing `memory/stem.md` (wikilinks target the
   `type_`-prefixed **filename stem**, not the frontmatter `name`; or a deliberate forward-marker). Report danglers.
3. **Frontmatter integrity** — every page has `name` + `type`; no `description`/`title` truncated by an
   unquoted bare `#` (grep for descriptions containing ` #` without surrounding quotes).
4. **Contradictions / stale claims** — two pages that assert opposite things, or a page whose claim a later
   session invalidated (e.g. a file/flag it names no longer exists — verify against current code before flagging).
5. **Redundant clusters** — near-duplicate pages on one topic (e.g. the #891 Phase 1 review/close/verify
   clusters) that should be merged into one, preserving each original's **Why**.
6. **Decision-graph structure** (#967) — run `npm run lint:graph -- --github`. **The `--` is required**:
   `npm run lint:graph --github` silently swallows the flag and runs the offline subset, which then
   *passes* while skipping every liveness check. (`node scripts/lint-decision-graph.mjs --github` works
   too.) It checks what is mechanical and refuses to guess at what is not:
   - **edge grammar** — `bounds::` only on a `constraint_*` page and only ever targeting a decision page;
     `constrains::` only on `decision_*`; `advances::` only on `initiative_*` (rule 1b); `blocks::` never
     a wiki edge.
   - **dead edges** (`--github`) — every `advances:: #N` resolves to an OPEN issue that is not a PR.
   - **duplicate claims** — no issue is a slice of two initiatives.
   - **dangling `[[wikilinks]]`** — over the WHOLE bundle, not just the graph pages: this is the only
     mechanical version of check 2 (which is otherwise a prose instruction), so a broken link anywhere
     is a hard finding here.
   - **unclaimed candidates** (`--github`) — open `area:biz`/`area:marketing` issues that no initiative
     claims. **A report, never a finding, and exit code 0.** Whether an issue advances an initiative is a
     judgement; a lint that decides it manufactures false confidence. Read the list, decide, edit the page.

   Structural findings exit non-zero. The lint cannot run in CI — the bundle is a private repo
   Actions has no credential for — but its pure functions are CI-gated via `npm run test:scripts`.

## Output
- Write a `YYYY-MM-DD lint: <n> findings (<summary>)` line to `memory/log.md`.
- **Auto-fix only the safe, mechanical issues** (repoint a broken wikilink to its renamed target, add a missing
  index line, quote a `#`-truncated description).
- **Propose — do NOT auto-apply — anything lossy** (merging pages, deleting stale claims). Present the plan and
  wait for user confirmation (user feedback is never deleted unilaterally; merge preserves the Why).

## Relationship
Pairs with `memory-ingest` (the write side). Neither touches the aiwatch repo.

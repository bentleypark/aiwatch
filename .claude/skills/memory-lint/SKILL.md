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

The file memory (`~/.claude/projects/-Users-bentley-Desktop-bentely-aiwatch-aiwatch/memory/`) compounds over
time; without periodic linting it drifts. This is the **lint** operation of the LLM-Wiki pattern (#891).

## When to run
- Every 1–2 weeks, after a batch of `memory-ingest` writes, or when recall feels noisy/stale.

## Checks
1. **Index drift** — every `memory/*.md` (except MEMORY.md) has exactly one MEMORY.md line, and every MEMORY.md
   link resolves to a file. Report `NOT INDEXED` / `MISSING FILE`.
2. **Broken wikilinks** — every `[[stem]]` resolves to an existing `memory/stem.md` (wikilinks target the
   `type_`-prefixed **filename stem**, not the frontmatter `name`; or a deliberate forward-marker). Report danglers.
3. **Frontmatter integrity** — every page has `name` + `type`; no `description`/`title` truncated by an
   unquoted bare `#` (grep for descriptions containing ` #` without surrounding quotes).
4. **Contradictions / stale claims** — two pages that assert opposite things, or a page whose claim a later
   session invalidated (e.g. a file/flag it names no longer exists — verify against current code before flagging).
5. **Redundant clusters** — near-duplicate pages on one topic (e.g. the #891 Phase 1 review/close/verify
   clusters) that should be merged into one, preserving each original's **Why**.

## Output
- Write a `YYYY-MM-DD lint: <n> findings (<summary>)` line to `memory/log.md`.
- **Auto-fix only the safe, mechanical issues** (repoint a broken wikilink to its renamed target, add a missing
  index line, quote a `#`-truncated description).
- **Propose — do NOT auto-apply — anything lossy** (merging pages, deleting stale claims). Present the plan and
  wait for user confirmation (user feedback is never deleted unilaterally; merge preserves the Why).

## Relationship
Pairs with `memory-ingest` (the write side). Neither touches the repo — the memory dir is harness-global.

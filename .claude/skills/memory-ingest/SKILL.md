---
name: memory-ingest
description: >-
  Distill this session's durable knowledge into the file-based LLM Wiki memory (the `~/.claude/.../memory/`
  bundle). Invoke at end-of-session, when the PreCompact hook fires (if wired), or whenever the user says "remember this"
  / "기억해둬" / "메모리에 남겨". Captures user corrections + confirmed approaches (feedback), root-cause
  findings / non-obvious fixes (debugging), ongoing goals/constraints not derivable from code (project), and
  external-resource pointers (reference) — one concept per file, deduped against existing pages, with the
  MEMORY.md index + log.md updated. Replaces the retired MemPalace ingest (#891).
---

# memory-ingest — write durable knowledge into the LLM Wiki

The file memory (`~/.claude/projects/-Users-bentley-Desktop-bentely-aiwatch-aiwatch/memory/`) is the single
persistent memory (MemPalace retired, #891). This skill is the **ingest** operation of the LLM-Wiki pattern.

## When to run
- End of a substantive session, or when the `PreCompact` hook fires (if wired in `.claude/settings.local.json`).
- User says "기억해둬" / "remember this" / "메모리에 남겨".
- A durable fact emerged: a user correction, a non-obvious root cause, a project constraint, a useful external pointer.

## What NOT to ingest
- Ephemeral task state, TODOs, "what I'm about to do next".
- Anything the repo already records: code structure, past fixes, git history, CLAUDE.md content. If asked to
  remember one of those, ask what was **non-obvious** about it and store that instead.

## Procedure
1. **Scan** the conversation for durable items matching one `type`:
   - `feedback` — user correction / confirmed approach. Body MUST carry **Why:** and **How to apply:** lines.
   - `debugging` — root-cause finding / non-obvious fix.
   - `project` — ongoing work / goal / constraint not derivable from code (convert relative dates to absolute).
   - `reference` — pointer to an external resource (URL, dashboard, ticket).
2. **Dedup first**: `grep` MEMORY.md + the memory dir for an existing page on the same topic. If one exists,
   **update it** (merge the new nuance, preserve the original **Why**) rather than creating a near-duplicate.
   Redundant feedback clusters should be merged, not multiplied (see #891 Phase 1).
3. **Write** the page: `memory/<type>_<kebab-slug>.md` with frontmatter `name` / `description` / `type`
   (+ optional `title`/`tags`). Link related pages with `[[type_slug]]` — the **filename stem** (e.g.
   `[[feedback_local_verify]]` → `feedback_local_verify.md`), NOT the bare frontmatter `name`. A not-yet-existing `[[link]]` is fine.
   - **Quote any `description`/`title` containing a bare `#`** (e.g. `#N`) — unquoted YAML treats `#` as a
     comment and truncates the value.
   - The harness normalizes frontmatter on write (relocates `type`/`title`/`tags` under `metadata:`) — expected, don't fight it.
4. **Index**: add one line to `MEMORY.md` under the right section (`- [Title](file.md) — hook`). Never put memory
   content in MEMORY.md — one line per page.
5. **Log**: append one line to `memory/log.md` — `YYYY-MM-DD ingest: <slug> (<why in a few words>)`.
6. If a stored fact turned out wrong, delete the page (and its index line) instead of leaving it.

## Relationship
Complements `memory-lint` (periodic health check). The **query** side (load index → relevant pages) is native session-start auto-load, optionally nudged by a `SessionStart` hook if wired in `settings.local.json`.

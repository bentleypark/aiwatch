---
name: memory-ingest
description: Capture durable session knowledge in the Codex project memory bundle when the user asks to remember it or a durable finding emerges.
metadata:
  short-description: Save durable project memory
---

# Codex memory ingest

Use this skill for an explicit “remember this” request or a durable correction, root-cause finding,
project constraint, or external reference. Resolve the Codex memory root from the current Codex
configuration; never assume a Claude-specific path. Do not ingest ephemeral task state, TODOs,
repository facts already recorded in code/docs, secrets, or unconfirmed guesses.

Deduplicate against the index and existing pages first. Store one concept per
`memory/<type>_<kebab-slug>.md`, where type is `feedback`, `debugging`, `project`, or `reference`.
Use frontmatter with `name`, `description`, and `type`; quote descriptions or titles containing a
bare `#`. Feedback pages must include `Why:` and `How to apply:`. Link related pages with filename
stems such as `[[feedback_local_verify]]`, add exactly one index line to `MEMORY.md`, and append
`YYYY-MM-DD ingest: <slug> (<reason>)` to `memory/log.md`. Use `apply_patch`, then verify the index,
wikilinks, frontmatter, and changed files. If a fact is disproved, remove its page and index entry
only after user confirmation.

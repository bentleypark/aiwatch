---
name: memory-lint
description: Audit the Codex project memory bundle for index drift, broken links, stale claims, contradictions, and redundant pages.
metadata:
  short-description: Lint project memory health
---

# Codex memory lint

Use this skill every one to two weeks, after a batch of memory writes, or when recall feels stale.
Resolve the Codex memory root from the current Codex configuration. Check index↔file drift, broken
wikilinks, required frontmatter, unquoted `#` truncation, contradictions, stale claims, and redundant
clusters. Run the repository decision-graph lint with `npm run lint:graph -- --github` when the memory
bundle supports it; treat structural findings as defects and unclaimed candidates as judgement input.

Write one dated findings line to `memory/log.md`. Auto-fix only mechanical issues such as missing
index lines, safe link repairs, or quoting truncated YAML. Report proposed merges, deletions, or
stale-claim changes without applying them until the user confirms. Use `exec_command` for inspection,
`apply_patch` for safe edits, and verify the final index and links.

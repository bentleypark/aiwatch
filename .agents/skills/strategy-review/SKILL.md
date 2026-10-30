---
name: strategy-review
description: Reconstruct AIWatch business and marketing strategy state from durable initiative and decision memory, then identify the next strategic actions.
metadata:
  short-description: Review AIWatch strategy state
---

# Codex strategy review

Use this skill for AIWatch business, growth, marketing, and monetization reviews. Read all
`type:initiative` memory pages first: their status, evidence, delivered edges, advances edges, next
action, and exit criterion are the state of record. Traverse decision-graph relations and inspect
the current decision pages before using discovery artifacts or GitHub issues as evidence. Distinguish
30-day thread cadence from repo attention measured over a named day window; do not reconstruct
initiative state from issue checkboxes.

Produce a plain-language brief with active initiatives first, one executable next action per live
thread, per-initiative shipped/remaining detail, and decisions past their current trigger. Read issue
gates and open PRs before calling an action startable. Keep board-wide P0–P3 ranking in `issue-triage`.
Use `exec_command` and direct file reads instead of Claude agent calls. Do not mutate issues, labels,
memory pages, or production KV while producing the brief unless the user explicitly confirms.

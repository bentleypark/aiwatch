---
type: index
title: "docs/reference — OKF bundle index"
description: "Catalog of the AIWatch engineering reference bundle. Each entry is one OKF concept file (markdown + YAML frontmatter). CLAUDE.md is the schema layer; this is the index (#891 Phase 4)."
---

# docs/reference — reference bundle index

An [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
bundle: one concept per markdown file with `type` / `title` / `description` / `tags` frontmatter,
cross-linked with normal markdown links. `CLAUDE.md` is the schema layer; `log.md` is the change log.
Read this index first, then load only the pages you need.

## architecture — how the system works
- [Status Data Flow](data-flow.md) — browser polling → `/api/status` fetch/normalize/KV → React, plus the `*/5` cron + Web Vitals pipeline.
- [Service Status Determination](status-determination.md) — the ordered per-service status resolution chain in `services.ts`, with #-rationale.
- [Discord Alert Delivery Paths](discord-alert-paths.md) — operator + per-user alerts delivered server-side by the cron.

## runbook — step-by-step procedures
- [Adding a New Service — Full Checklist](adding-a-service.md) — the lockstep files + the Step-0 data-richness audit.
- [Operator Tools — `POST /api/admin/analyze`](operator-tools.md) — force a Sonnet re-analysis on an active incident.
- [Parallel AI-agent sessions (git worktrees)](parallel-agents.md) — multiple sessions without file/git/port collisions.

## reference — lookup tables, schemas, policies
- [Worker HTTP Endpoints](api-endpoints.md) — per-endpoint auth/projections/dedup/#-rationale.
- [KV Key Schema](kv-schema.md) — STATUS_CACHE keys: pattern/value/TTL/writes-per-day + monthly budget.
- [Fallback Tier Priority](fallback-tiers.md) — tier membership + candidate eligibility rules.
- [GA4 Analytics & Consent Flow](ga4-events.md) — cross-surface consent + event catalog.
- [Content-Security-Policy (CSP) — #482](reference-csp.md) — per-surface enforcement (nonce vs content-hash) + SPA policy.
- [Reference Tooling](reference-tooling.md) — chub vs modern-web-guidance trigger map + the PreToolUse backstop.
- [Tier-A `verify-after` assertions (#873)](verify-assertions.md) — machine-checkable assert-clause grammar.

> Health of this bundle (frontmatter integrity, broken cross-links, stale claims) can be checked with
> the `memory-lint` skill; findings are recorded in [log.md](log.md). (A scheduled routine to run it
> automatically is a possible follow-up — not yet wired.)

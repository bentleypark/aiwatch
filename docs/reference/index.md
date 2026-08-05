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
- [Workflow-gate hooks (#415/#657)](workflow-hooks.md) — the seven workflow hooks, hard vs soft, the audit log + how to tune the step-3.5 hard gate.
- [Reference Tooling](reference-tooling.md) — chub vs modern-web-guidance trigger map + the PreToolUse backstop.
- [Tier-A `verify-after` assertions (#873)](verify-assertions.md) — machine-checkable assert-clause grammar.
- [Directory map](directory-map.md) — every module's purpose + the #-issue history behind it (CLAUDE.md keeps only the map).
- [Product constraints](product-constraints.md) — AI analysis, fallback gating, deploy/cron rules, CSP, PWA, Edge SSR surfaces.
- [Decision Graph — ontology-lite (#917)](decision-graph.md) — the entity + relation vocabulary the strategy-review skill traverses to fuse progress × priority × decision-context.
- [Service-addition candidates](service-candidates.md) — the per-category "what to add next" registry + the declined sources. A registry, not a plan: an add is authorized by the Step-0 audit, not by a row here.

> **Structural health** (frontmatter integrity, unquoted-`#` truncation, dangling cross-links, index
> drift) is enforced in CI on every PR by `scripts/lint-okf-bundle.mjs` — on a **docs** PR by the
> `Docs Lint` workflow (`.github/workflows/docs-lint.yml`, #961), and on a **code** PR by the
> `REAL docs/reference bundle` assertion in its test, which runs under `npm run test:scripts` in
> `test.yml`. The split exists because `test.yml` `paths-ignore`s `docs/**`, so a docs-only PR starts
> none of its jobs (#961 — the lint was skipped exactly when docs changed). **Judgement
> health** (contradictions, stale claims, whether cross-linking is *sufficient*) is a manual pass via
> the `memory-lint` skill; findings are recorded in [log.md](log.md).

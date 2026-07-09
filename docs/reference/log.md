---
type: log
title: "docs/reference — OKF bundle change log"
description: "Append-only log of ingest / lint / migration passes on the docs/reference OKF bundle. See index.md for the content catalog."
---

# docs/reference — bundle log

Append-only. Format: `YYYY-MM-DD <op>: <summary>`.

2026-07-05 migrate(#891 Phase 4): promoted docs/reference/* to an OKF bundle — added `type`/`title`/`description`/`tags` frontmatter to 13 concept files, created this `log.md` and the `index.md` catalog. `CLAUDE.md` is the schema layer. Bundle is now viewable in the OKF static HTML graph visualizer and lint-able via the `memory-lint` skill (a scheduled cloud routine to run it automatically is a possible follow-up).

2026-07-05 ingest(#891 Phase 4): wired the structural half of memory-lint into CI — added scripts/lint-okf-bundle.mjs (frontmatter integrity, unquoted-# truncation, dangling cross-links, index drift) + node:test with a real-bundle assertion (npm run test:scripts) + npm run lint:okf. The "scheduled routine follow-up" from the migrate line is now a per-PR CI gate (catches drift when docs change, not weekly).

2026-07-09 extract: CLAUDE.md was 101,370 chars — 2.5× the ~40k guideline. Two blocks held 72% of it: `Directory Layout` (43k; 13 lines carried 33k of accumulated change-history prose, `alerts.ts` alone was a single 10k-char line) and `Key Product Constraints` (22k). Both moved VERBATIM into new OKF pages — `directory-map.md` (path → why it exists + the #-issues that shaped it) and `product-constraints.md` (AI analysis, fallback gating, deploy/cron, CSP, PWA, Edge SSR) — leaving CLAUDE.md with a lean path→purpose map and constraint headlines, each pointing at its page. **No content deleted.** CLAUDE.md: 101,370 → ~35k chars.

Three factual corrections were made on top of the verbatim move (review found them; they were pre-existing errors in the old block, not regressions): the `api/` helper subdirectories are `_intro/` `_methodology/` `_plugin/` `_badges/`, not the un-prefixed names the old text used — the `_` prefix is load-bearing, it is what keeps them off the 12-Serverless-Function count; `api/confirm.ts` (#486), `api/extension-privacy.ts` (#837) and `api/csp-report.ts` (#482) were missing from the tree entirely though all three are real Edge Functions; and the 12-fn-cap rule itself now lives in `product-constraints.md`'s frontend-deployment block, which the CLAUDE.md headline points at (previously the headline stated the cap and the page it referenced did not). `directory-map.md` is the authoritative tree; CLAUDE.md's is a lean mirror that must be updated alongside it.

---
type: log
title: "docs/reference — OKF bundle change log"
description: "Append-only log of ingest / lint / migration passes on the docs/reference OKF bundle. See index.md for the content catalog."
---

# docs/reference — bundle log

Append-only. Format: `YYYY-MM-DD <op>: <summary>`.

2026-07-05 migrate(#891 Phase 4): promoted docs/reference/* to an OKF bundle — added `type`/`title`/`description`/`tags` frontmatter to 13 concept files, created this `log.md` and the `index.md` catalog. `CLAUDE.md` is the schema layer. Bundle is now viewable in the OKF static HTML graph visualizer and lint-able via the `memory-lint` skill (a scheduled cloud routine to run it automatically is a possible follow-up).

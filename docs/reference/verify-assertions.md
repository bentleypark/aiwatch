---
type: reference
title: "Tier-A `verify-after` assertions (#873)"
description: "The Tier-A verify-after assert: clause grammar — machine-checkable JSON-endpoint assertions the daily verify job auto-verifies."
tags: [workflow, ci, verify-after]
---

# Tier-A `verify-after` assertions (#873)

Machine-checkable assertions that let the daily `verify-reminders` job (#541) **close the
verify-blocked loop** — evaluate a production signal and auto-verify the issue — instead of only
pinging a human. Read this before authoring an `assert:` line or changing the evaluator.

## Why

`verify-reminders` (#541, `scripts/verify-reminders.mjs`) scans open issues for a
`- [ ] **verify-after YYYY-MM-DD** — …` line and pings the operator Discord when due. The *check*
stayed manual, so `verify-blocked` issues piled up. Most AIWatch verify targets, though, are
machine-checkable signals AIWatch already emits (a field on `/api/status`, `/api/report`, a counter
surfaced in an endpoint). A `verify-after` line can therefore carry an optional `assert:` clause the
job evaluates against production and, on pass, **ticks the box + comments the evidence + drops
`verify-blocked`** (and closes the issue when no open box remains). Un-assertable checks (GA4 /
GSC-CTR / "does it *look* right") carry no `assert:` and keep the human-ping behavior unchanged.

The evaluator lives in `scripts/verify-assertions.mjs` (pure helpers + a standalone CLI); the daily
integration is in `scripts/verify-reminders.mjs`. Both are unit-tested by
`scripts/verify-assertions.test.mjs` + `scripts/verify-reminders.test.mjs` (`npm run test:scripts`).

## Grammar

An indented `assert:` line **directly under** a `verify-after` checkbox (the next non-blank line):

```
- [ ] verify-after 2026-07-09 — turbopuffer probe warmed
      assert: GET /api/status/cached | services[id=turbopuffer].scoreConfidence == "medium"
```

`assert:` `[GET]` `<source>` `|` `<selector>` `<op>` `[<expected>]`

| part | rule |
|---|---|
| **source** | `GET` optional. A leading-`/` path resolves against the prod worker (`VERIFY_ASSERT_BASE`, default `aiwatch-worker.p2c2kbf.workers.dev`), or an absolute `https://` URL. **Must be an allowlisted AIWatch host** (SSRF guard) — the ai-watch.dev set + the pinned prod worker host; extras via `VERIFY_ASSERT_ALLOW`. Response must be JSON. Prefer the fast KV-backed `/api/status/cached` over the live `/api/status` fan-out. |
| **selector** | dot-path with an optional `[key=value]` array filter, e.g. `services[id=turbopuffer].scoreConfidence`, `supplyChainBanner.active`, `predictionAccuracy.total`. The `[key=value]` picks the first array element whose `key` string-equals `value`. |
| **operator** | `==` · `!=` · `>=` · `<=` · `contains` (substring, or array membership) · `exists` (no operand) |
| **expected** | a literal: quoted string `"medium"` / `'x'`, number `30`, boolean `true`/`false`. Omitted for `exists`. |

### Result semantics — fail-open

- **pass** → auto-verify (tick + comment + drop `verify-blocked`; close if the last open box).
- **fail** (selector found, comparison false) → keep the reminder live (never a false close).
- **skip** (fetch error / non-allowlisted source / bad JSON / selector-miss) → treated as "can't
  verify yet": keep the reminder, don't tick.

A flaky read or a not-yet-satisfied signal therefore never spuriously closes an issue.

## Behavior in the daily job

Runs on **every** daily invocation (not gated on the due date), so an issue drains the moment its
signal is met — the ping cadence (due date + weekly) is independent. Per issue with a passing
assertion: tick the passing box(es); drop `verify-blocked` once no unchecked `verify-after` line
remains; **close** only when no unchecked box of *any* kind remains (conservative). Body edit and
`--remove-label` are separate best-effort `gh` calls (a missing label can't drop the tick). The
existing **trusted-author** filter (public-repo abuse gate, #541) gates the mutation path; the CLI's
`--apply` is trusted-author-gated too. A prose (non-`- [ ]`) `verify-after` line is a no-op tick and
is never auto-verified (idempotent).

### Which lines are scanned (#966)

`isSuppressedReminderLine` (exported from `verify-assertions.mjs`) is the single source of truth for
both scanners — the live `pairVerifyAssertions` and its exported twin `parseVerifyAfter` in
`verify-reminders.mjs`. A line is **skipped** when it is:

| Line shape | Skipped? | Why |
|---|---|---|
| `- [x] verify-after 2026-01-01` | ✅ | done item; ticking the box is the SSOT "verified" action (#586) |
| `> … verify-after 2026-01-01 …` | ✅ | **blockquote = retrospective narrative, never a live action item** (#966) |
| `- [ ] verify-after 2026-01-01` | ❌ fires | the canonical open reminder |
| `Open: verify-after 2026-01-01` | ❌ fires | non-quoted prose is a legitimate reminder (#541) |
| `-[x] verify-after 2026-01-01` | ❌ fires | GFM renders this as literal text, not a task |

The blockquote rule exists because `ship-issue` step 10 has the operator write a dated
`> **Status (YYYY-MM-DD):**` note, and such notes naturally **quote the token** while explaining what
the assert checks. A quoted mention has no checkbox, so it can never be ticked, and the auto-verify
`tickedKeys` suppression is keyed by the *checkbox* `lineIndex` — it cannot reach a prose line. Before
#966 those mentions re-fired **every day** until the issue closed: 3 of the 4 items in the 2026-07-09
ping were quoted prose, and #857 pinged from prose in the same run that auto-verified and closed it.

**Consequence for authors:** write status notes freely — quoting `verify-after <date>` inside a `>`
block is safe. Only a real unchecked checkbox (or bare, non-quoted prose) creates a reminder.

Two deliberate edges, both pinned by tests:

- **A `- [ ] verify-after …` box nested INSIDE a blockquote never fires.** The blockquote rule wins
  over the checkbox. This is the one false-negative the guard introduces; it is safe only because the
  convention (ship-issue step 12) writes verify-after boxes at top level, never quoted. If you ever
  need a live reminder, do not quote it.
- **The guard is blockquote-*line*-only.** A `verify-after <date>` token inside a fenced code block or
  a markdown table row still fires, since neither line starts with `>`. Left as-is: real issue bodies
  don't do this, and over-broadening the guard risks swallowing genuine reminders.

### Label lifecycle

| Label | Added by | Removed by |
|---|---|---|
| `verify-blocked` | operator at merge (ship-issue step 10) | auto-verify, once no unchecked `verify-after` line remains |
| `body-drift` | daily guard, when stray unchecked boxes exist | daily guard, once the body is synced (self-healing) |
| `verify-overdue` | daily job, on every ping | daily job, once the issue is no longer due (self-healing since #966) |

`verify-overdue` was **add-only** before #966 — nothing removed it, not the auto-verify (which drops
only `verify-blocked`) and not `gh issue close`. A verified-and-closed issue kept the label
indefinitely, so any triage query filtering on it read a permanent scar rather than current state.

Two properties of the self-heal worth knowing:

- **The clear is derived from the verify-after dates, not from "did we ping today".** The ping is
  weekly (`shouldFire`: due date, then every 7th day), so an issue is genuinely overdue on days it is
  not pinged. Clearing on "not pinged today" would flap the label on and off six days a week.
- **It only reaches OPEN issues** (plus an issue closed by the auto-verify pass earlier in the same
  run — it was still open when fetched). `fetchRepoIssues` lists `--state open`, so a `verify-overdue`
  scar left on an issue closed by an *earlier* run is never revisited. This PR fixes forward; #857's
  pre-existing scar was removed by hand.

## When to add an `assert:` (and when not)

Add one when the acceptance can be expressed as a predicate over an AIWatch JSON endpoint:

| verify target | assertable? | example |
|---|---|---|
| a `/api/status` field | ✅ | `services[id=turbopuffer].scoreConfidence == "medium"` |
| a `/api/status` count/threshold | ✅ | `services[id=turbopuffer].coverageDays >= 30` |
| presence of a structure | ✅ | `supplyChainBanner exists` |
| a `/api/report` aggregate | ✅ (verify the field is exposed) | `predictionAccuracy.total >= 1` |
| GA4 / GSC-CTR / consent-gated | ❌ | leave as a human ping (no `assert:`) |
| behavioral ("no alert fired", a flap) | ❌ | no static signal — human ping |
| is-down `<title>` HTML text | ❌ (v1) | JSON-only today; HTML/text-body mode is a follow-up |

Roughly 40–50% of the current `verify-blocked` board is auto-drainable; the rest stays human-ping
(or a future Tier-B weekly digest).

## CLI (manual / debugging)

```
node scripts/verify-assertions.mjs --issue N [--repo owner/repo] [--apply]
```

Default is dry-run: fetch the issue, pair `verify-after`↔`assert`, evaluate live, print PASS/FAIL/SKIP.
`--apply` (trusted-author-gated) ticks the passing box(es) + comments + drops `verify-blocked` when
all resolved. Use it to validate a freshly-authored `assert:` line before the daily job runs.

## Security notes (do not regress)

- **SSRF**: `isAllowedUrl` is an **exact-host** allowlist (no `*.workers.dev` wildcard — any account
  can name a worker `aiwatch-worker`). https-only; userinfo/suffix tricks rejected via `new URL`.
- **No code execution**: the evaluator is a whitelisted operator set — no `eval`/`Function`/dynamic
  require anywhere.
- **Abuse gate**: mutation is trusted-author-gated (ported from `verify-reminders.mjs`), because the
  `assert:` line is read straight from a public issue body.

Follow-ups tracked in #873: `ship-issue`/`issue-triage`/`adding-a-service` convention notes (done),
an optional HTML/text-body assertion mode, and a Tier-B weekly "suggest-don't-auto-close" digest for
the un-assertable remainder.

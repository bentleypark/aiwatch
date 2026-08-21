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

Indented sub-lines under a `verify-after` checkbox — `assert:` (machine-decidable) and `durable:`
(#1206, human-decidable). Either order, and a line may carry both.

The sub-block is the checkbox's **own list item**: every line indented past the `- [ ]` marker, up to the
next CHECKBOX or the next line at or below that indent (a plain nested bullet does not end it). So the note may wrap across several lines and the
sub-lines still attach. It used to end at the first non-blank line that was neither marker, which meant a
two-line note pushed a correctly-written `durable:` out of reach — the line was right and the machine
reported "no durable trace", so the issue was labelled `verify-undecidable` for naming an artifact eight
lines down. Two open issues were in that state when it was found (#1245, #1224). Fenced code inside the
item is skipped, so an `assert:` shown as an EXAMPLE is not read as a live one.

```
- [ ] verify-after 2026-07-09 — turbopuffer probe warmed
      assert: GET /api/status/cached | services[id=turbopuffer].scoreConfidence == "medium"

- [ ] verify-after 2026-09-01 — confirm the August archive carries the new field
      durable: archive:monthly:2026-08 (no TTL)
```

### `durable:` — what will still exist on the date (#1206)

`durable: <artifact>`, free-form. It answers the one question that makes a dated human check
answerable: *when the ping arrives, what will I look at?* A line with neither marker gets the
**`verify-undecidable`** label from the daily job while it is still pending.

The content is deliberately **not** validated — a 7h-TTL KV key is a bad answer and no regex can tell
it from a good one. The value is that writing it forces the author to name the artifact and notice
whether it survives. Check the retention against `date − today`; a KV TTL is the usual trap.

On 2026-08-05 three dated checks came due and none could be answered: `component-partial:` records had
aged out at 7h (dedup key 24h), leaving 1 of 7 days observable; #1104's keep path writes no trace at
all; #1103 needed an operator tweet nobody had sent. Two were closed unverified with a reopen trigger.
Where a durable artifact genuinely does not exist, the fix is to **add the instrumentation** or to
write no date at all — not to name something that will be gone.

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
| `` …the #1153 `verify-after 2026-01-01` box… `` | ✅ (that occurrence) | **backtick-wrapped = a citation of another issue's box** (#1215) |
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

#### Backtick-quoted citations (#1215)

A second markdown convention QUOTES the token the same way a blockquote does, without `>`: wrapping it
in inline code. #1189's own evidence section cites #1153's already-closed box in ordinary prose —

```
Found while reading the #1153 `verify-after 2026-07-30` box against production
```

— which is not a checkbox and not inside a `>`, so the blockquote rule alone let it through. #1189
wore `verify-overdue` continuously from 2026-08-03 (its citation's own due date) until this fix, off a
box that belongs to a different, already-closed issue. Scanned against the live board: every
backtick-wrapped occurrence not inside a blockquote was this shape (3 found — #1189 ×2, #1089 ×1), and
every genuine checkbox uses the canonical bold `**verify-after DATE**` form (ship-issue SKILL.md §8),
never backticks — a clean discriminator, zero counterexamples either direction.

**Unlike the blockquote rule, this is checked per *occurrence*, not per line** — `isBacktickQuotedOccurrence(line, index)`,
not `isSuppressedReminderLine`. A checkbox line can legitimately carry its own real, bold box AND cite a
*different* issue's date in backticks in the same sentence; the live board has exactly this shape
(aiwatch-reports#76: `` - [ ] **verify-after 2026-08-03** — regenerate… Depends on aiwatch#1002's `verify-after 2026-08-02` archive check ``).
Gating the whole line on "contains a backtick-quoted verify-after anywhere" — the first draft of this
fix — would have silently dropped that box; caught only by running `--dry-run` against the live board
before shipping, not by the unit tests written against synthetic bodies.

**A second, subtler bug on top of that** (caught in PR review, by two independent agents, before
merge): `VERIFY_RE`'s own trailing note capture (`([^\n]*)`) is greedy, so a naive `line.matchAll` on a
clone of that pattern returns **exactly one match per line, always** — the first match's note swallows
everything after it, including a second `verify-after` token's own text, so that second occurrence is
never surfaced as a match of its own. On a line where the backtick-quoted citation comes **first**
(the reverse of the aiwatch-reports#76 order), that silently dropped the real, later box entirely —
not merely misclassified it, exactly the failure this whole system exists to prevent. The fix is
`liveVerifyOccurrences(line)`, built on a **token-only** global regex (date only, no note capture) so
occurrences are found regardless of order; each match's own note is then derived by slicing `line` from
the match's end. `pairVerifyAssertions`, `parseVerifyAfter`, `countOpenVerifyAfter`,
`findBacktickQuotedVerifyBoxes`, and the body-drift guard's verify-after exclusion are all built on this
one function, so they cannot disagree on what counts as a live occurrence.

The dangerous-shape twin (`findBacktickQuotedVerifyBoxes`, mirroring `findQuotedVerifyAfterBoxes`) warns
a checkbox line only when it has verify-after occurrences but **none** of them are live — i.e. exactly
the condition under which `pairVerifyAssertions` would parse nothing off that line. A checkbox that
merely cites a different date in backticks alongside its own real (live) one still has a live occurrence
and is correctly not flagged.

**`countOpenVerifyAfter` and the body-drift guard had to move onto the same function**, not just the two
parsers. Before this, a checkbox whose only "verify-after" text was a backtick citation still counted as
an open verify-after line (`OPEN_BOX_RE.test(l) && VERIFY_RE.test(l)`, presence-only) — so
`planIssueAutoVerify`'s `dropLabel` could never fire (the counter never reached zero) even after the
real, separate box was ticked, pinning `verify-blocked` open forever with nothing left to ping or
auto-verify. `findBodyDrift`'s verify-after exclusion had the same blind spot from the other side: it
treated the citation-only box as "open-until-verified, not drift," so it was invisible to *both* guards
at once — stuck and unflagged. Both now exclude/count on `liveVerifyOccurrences(line).length`.

`pairVerifyAssertions` and `parseVerifyAfter` take only the FIRST live occurrence per line, both — a
round-2 review finding: `parseVerifyAfter` originally looped over every live occurrence (the `matchAll`
loop it already had, now correctly reachable past the greedy-capture fix above), which is a real
divergence from its twin on a line with two genuine dates. Pinned to `[0]` on both, since
`parseVerifyAfter` has no production caller (`pairVerifyAssertions` is what `main()` drives) and this
was the historical behavior anyway — before #1215, the greedy capture already collapsed any such line to
one hit in practice, so nothing that depended on multiple hits per line was ever exercised.

**The backtick-closing check is deliberately loose**, not exact-adjacent: `isBacktickQuotedOccurrence`
requires a backtick immediately BEFORE the match (that's what protects a real bold box — it is never
preceded by a backtick, so an unrelated stray backtick earlier in the line can never falsely suppress
it) but only requires SOME backtick later on the line, not one immediately after the date. A tighter,
exact-adjacent close check (the first draft) misses a citation whose code span also wraps its own note
(`` `verify-after 2026-08-02 archive check` `` — the same failure this fix exists to close, under an
alternate spelling); the live board's three real occurrences all use the tight form, but the loose form
covers both without reopening the false-suppression risk the open-side anchor exists to close.

### Label lifecycle

| Label | Added by | Removed by |
|---|---|---|
| `verify-blocked` | operator at merge (ship-issue step 10) | auto-verify, once no unchecked `verify-after` line remains; **or the closed-issue sweep (#1037)** |
| `body-drift` | daily guard, when stray unchecked boxes exist | daily guard, once the body is synced (self-healing); **or the closed-issue sweep (#1037)** |
| `verify-overdue` | daily job, on every ping | daily job, once the issue is no longer due (self-healing since #966); **or the closed-issue sweep (#1037)** |
| `verify-undecidable` | daily guard, on a not-yet-due line carrying neither `assert:` nor `durable:` (#1206) | daily guard, once a marker is added or the date arrives (self-healing); **or the closed-issue sweep (#1037)** |

### Escalation — an overdue item is not extended forever (#1206)

Past **30 days** overdue, a human-ping line is re-bucketed out of the routine Discord list into a
second embed: *needs a disposition*. Another ping will not decide it. The disposition is to make the
check observable (instrument it, or name a `durable:` artifact) or to close the issue with a written
reopen trigger — never to push the date.

30 days is four unanswered weekly pings. The bound answers a **policy**, not an observed pile-up:
#1104's body instructed "push it out rather than closing on absence of evidence", which is unbounded
extension in writing. On the day this shipped the board was healthy (12 overdue, oldest 6 days) and
the escalation matched nothing; it exists to keep it that way.

**Report-only — it never mutates or closes.** Closure here is signalled by label removal, not
`gh issue close`, and "nobody could observe this" is a judgement about intent, not a fact about an
endpoint. Lines carrying an `assert:` are excluded (they wait on a signal, not a person); the accepted
limit is that an assertion gone permanently `skip`/`fail` pings weekly forever inside the one branch
the bound cannot reach.

**Closing an issue clears them all (#1037).** Each label describes an *open* verification obligation,
so closing is that obligation's terminal state — the daily job sweeps closed issues and strips every one
of them, unconditionally (no date logic: closed is closed). Grouped into one edit per issue, from one
bounded query per label. This is what makes the labels safe to filter on in triage: a hit means current
state.

> **Reopening a swept issue does not restore `verify-blocked` — re-add it by hand.** Closing is terminal
> for the *obligation*, not for the *issue*. Only `verify-overdue` comes back on its own (the next ping;
> that path is gated on the scanned set, not on any label). **Nothing in this job ever adds
> `verify-blocked`** — it is applied by hand at merge. And because `isDriftCandidate` gates on
> `verify-blocked`, `body-drift` does **not** come back either: without it the issue never enters the
> drift scan at all, so a reopened swept issue silently loses body-drift detection until you restore
> `verify-blocked`.

`verify-overdue` was **add-only** before #966 — nothing removed it, not the auto-verify (which drops
only `verify-blocked`) and not `gh issue close`. A verified-and-closed issue kept the label
indefinitely, so any triage query filtering on it read a permanent scar rather than current state.

Two properties of the self-heal worth knowing:

- **The clear is derived from the verify-after dates, not from "did we ping today".** The ping is
  weekly (`shouldFire`: due date, then every 7th day), so an issue is genuinely overdue on days it is
  not pinged. Clearing on "not pinged today" would flap the label on and off six days a week.
- **It only reaches OPEN issues** (plus an issue closed by the auto-verify pass earlier in the same
  run — it was still open when fetched, and `toClearOverdue` runs after that pass, which is #857's exact
  path). `fetchRepoIssues` lists `--state open`, so a `verify-overdue` scar left on an issue closed by
  an *earlier* run is never revisited. #966 fixed forward only; #857's pre-existing scar was removed by
  hand at the time. **#1037 closed that half** with the separate closed-issue sweep above, which needs
  no body and no dates. The two are complementary: the date-derived self-heal governs the label while
  the issue is open; the sweep collects whatever was still on it at close. A `--dry-run` on 2026-07-16
  planned **19** historical scars (26 labels) — all of them **human** closes (0 of the 8 `verify-overdue`
  scars carry an `Auto-verified` comment), which is the gap's real shape: the automated close path
  already self-heals, so what strands a label is closing by hand between runs.

To reproduce the sweep locally, pass the repo explicitly — `parseScanRepos` falls back to the sibling
repo alone when `GITHUB_REPOSITORY` is unset (as it is outside CI), so a bare run silently scans neither
the main board nor its scars:

```bash
GITHUB_REPOSITORY=bentleypark/aiwatch node scripts/verify-reminders.mjs --dry-run
```

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

## Implementation + operational requirements

Moved here from CLAUDE.md (#1076) so the always-loaded schema layer stays lean. Nothing behavioural
changed.

- **Where it lives** — the daily job is `.github/workflows/verify-reminders.yml`, driving
  `scripts/verify-reminders.mjs` (#541, the reminder scan + labels) and `scripts/verify-assertions.mjs`
  (#873, the Tier-A auto-verification). Their pure functions are unit-tested via `npm run test:scripts`.
- **Cross-repo scan needs a PAT** — the scan covers this repo AND `aiwatch-reports`
  (`parseScanRepos` + the `VERIFY_EXTRA_REPOS` input), so a `verify-after` line in either repo fires.
  The sibling scan requires the **`VERIFY_CROSS_REPO_TOKEN`** secret (a PAT with issues:read+write on
  BOTH repos). **If it is absent the sibling scan warn-skips, best-effort** — the aiwatch reminder
  still runs, so the failure is silent from this repo's point of view and only shows up as
  aiwatch-reports reminders never arriving. Sibling refs render qualified (`aiwatch-reports#N`) in the
  Discord ping.
- **Body-drift guard** — `findBodyDrift` / `isDriftCandidate` (pure, unit-tested; `tracking` umbrellas
  excluded). Mechanics are in the label table above. What is NOT there: the root cause it targets —
  body-sync is a late, no-gate step in GitHub, a different system from the git diff the #415 hooks
  watch, so drift concentrates in the weeks-open `verify-blocked` bucket. The FIX is to sync the body
  at MERGE (ship-issue step 10); this guard is the backstop, not the mechanism.

- **Blockquote suppression + `verify-overdue` self-healing (#966)** — the rules and the label lifecycle are
  in [Which lines are scanned](#which-lines-are-scanned-966) and the label table above; the pure fns are
  `isSuppressedReminderLine` (shared by BOTH scanners), `findQuotedVerifyAfterBoxes`, `findStaleOverdueLabels`.
- **Backtick-quoted citation suppression (#1215)** — the second quoting convention #966 didn't cover; see
  [Backtick-quoted citations](#backtick-quoted-citations-1215) above. Pure fns: `isBacktickQuotedOccurrence`
  (per-occurrence), `liveVerifyOccurrences` (the shared per-line scanner every consumer is built on — both
  parsers, `countOpenVerifyAfter`, the body-drift guard's exclusion, and the dangerous-shape twin
  `findBacktickQuotedVerifyBoxes`).

- **Unparseable-`assert:` warning (#1206 follow-up)** — the only way a line can go dark that leaves no trace
  at all. A clause that does not parse is simply not attached, so the auto-verify the author believed
  they wrote never runs; and once a `durable:` sits beside it the item reads as decidable, so not even
  `verify-undecidable` fires. `findMalformedAssertLines` reports it in the warn-only silent-drop loop
  beside its siblings. It shares `itemSubLines` with `pairVerifyAssertions` — the boundary is one function, so
  the two cannot drift and the boundary tests cover both. Warn-only: it never changes what is attached.

Follow-ups tracked in #873: `ship-issue`/`issue-triage`/`adding-a-service` convention notes (done),
an optional HTML/text-body assertion mode, and a Tier-B weekly "suggest-don't-auto-close" digest for
the un-assertable remainder.

---
type: reference
title: "Workflow-gate hooks (#415/#657) — the enforcement layer"
description: "The seven .claude/hooks workflow hooks plus the .githooks/pre-push agent gate: what each fires on, hard vs soft, the audit log, and how to monitor + tune the step-3.5 hard gate."
tags: [workflow, hooks, enforcement, ci]
---

# Workflow-gate hooks (#415/#657) — the enforcement layer

Hook internals and operations, split out of CLAUDE.md so the always-loaded schema layer stays lean
(#1076). The hooks live in `.claude/hooks/` and are wired in `.claude/settings.json`.

`.claude/settings.json` wires SEVEN workflow hooks, because written rules alone (CLAUDE.md + auto-memory) are passive context loaded once per session, which compaction drops: probabilistic compliance. A hook fires at the decision moment.
- **`workflow-gates-reminder.sh`** (UserPromptSubmit) — re-injects the non-negotiable gates (a start-of-work gate 0 = "invoke `ship-issue` first on any new issue/code task", then the 4 decision-moment gates; text in `.claude/hooks/workflow-gates.txt`) as `additionalContext` on **every turn**. Gate 0 closes the coverage gap where "invoke ship-issue at the START" lived only in CLAUDE.md (a passive session-start surface) and was the one workflow step with no every-turn backstop. Targets the root cause (rules are passive context loaded once at session start; compaction drops methodology), and is the only hook surface that fires each turn + survives compaction. Soft (cannot block); logged as `inject`. Mirrors memory note `feedback_workflow_gates`. **#1245 follow-on — gate 2 now carries the review-label re-judgement**, not just "auto-loop until 0 Critical/Important". The qualifier was already in `code-review-policy.md` and named in `ship-issue` step 5, but nothing re-surfaced it: the skill is read once at t=0 when no review is running, and this hook repeated only the imperative. So the half that needed qualifying got reinforced every turn while "only `code-reviewer` has a floor" and "take the finding, not the remedy" decayed. Observed on #1268 (2026-08-21): 9 rounds (the declared round is in `hook-audit.jsonl`), whose last three produced no runtime change at all — only the deletion of prose written while fixing the previous round's finding, which is the loop that page's "Take the finding, not the remedy" section describes.
- **`git-mutation-gate.sh`** (PreToolUse/Bash) — fires before `git commit` / `git push` / `gh pr create` / `gh pr merge`. **Soft** (warns via `hookSpecificOutput.additionalContext`, never blocks). The step-3.5 reminder fires on **every** matched mutation (always `warn`) — a running dev server is now only an *informational hint*, **not** a silence condition, because a port probe can't distinguish "the assistant started + curl-checked a server itself" from "the user confirmed in-browser" (the #430 false-pass; #415 2026-05-19 gap). Also flags `--no-verify` / `--no-gpg-sign`. **On `git commit`** it adds a **docs-drift reminder**: if the staged diff changes doc-load-bearing code (`services.ts`/`index.ts`/`parsers/`/`wrangler.toml`/`vercel.json`/`constants.js`, or adds a new worker module) but touches no `docs/reference/*` or `CLAUDE.md`, it surfaces the change→doc map (docs is the recurring miss — the late, no-feedback, no-gate step; audit note `docs_reminder=1`). **#937** adds a paired **methodology-drift reminder**: the docs-drift check goes silent once ANY `docs/`/`CLAUDE.md` file is staged, so editing `docs/reference/status-determination.md` alone leaves the **public `/methodology` §2 cards** (`api/_methodology/html-template.ts`, which mirror those rules) unflagged — the #934 drift. This high-precision check fires when the rules doc is staged but the mirror page is not (audit note `methodology_reminder=1`); spawn-tested against a crafted staged diff in `scripts/git-mutation-gate.test.mjs` (via `npm run test:scripts`). **#1053 retro** adds a **truncated-id reminder**: an added backtick containing a `…`(U+2026)-elided identifier — a ≥6-char alnum run WITH a digit, e.g. `` `#f2c4fda9…c3310` `` — names the exact token, because a truncated id can't be checked against its source and invites a splice (#1053's review burned two rounds on a chimera id that pasted one incident's head onto another's tail). Deliberately narrow to kill false positives: only `…` (ASCII `...` is spread/chains/prose), only a digit-bearing run (prose words like `something…`/`reference…` don't fire), only inside backticks, only added lines (audit note `truncated_id=1`). Soft — a truncated id is a review-caught fidelity issue, not a correctness bug, so it's named not blocked. This is the ONE mechanically-detectable slice of the recurring comment-drift class (memory `feedback_verify_claims_before_documenting`); the semantic majority (a prose claim contradicting the code) has no lexical signature and is left to adversarial review.
- **`stop-nag-gate.sh`** (Stop) — reads the just-finished assistant message from the transcript; if its closing line is an auto-proceed nag ("shall I proceed/merge/continue?", "진행할까요?", "다음 작업 진행할까요?", …) it **re-prompts** (`decision: block`) to re-send the closing without the nag. `stop_hook_active` guards the loop.
- **`tooling-trigger.sh`** (PreToolUse/Edit|Write|MultiEdit) — soft path-based reminder (`hookSpecificOutput.additionalContext`, never blocks) to run **chub** first on external-integration files or **modern-web-guidance** first on frontend HTML/CSS/JS; the #415 backstop for those skills' probabilistic triggers. Logged as `inject`. Trigger map: **[reference-tooling.md](reference-tooling.md)**.
- **`korean-copy-trigger.sh`** (PreToolUse/Edit|Write|MultiEdit, **#1094**) — soft reminder (`hookSpecificOutput.additionalContext`, never blocks) fired only on a Korean user-facing copy file (`ko.js`, the `_methodology`/`_intro` Edge templates, `LegalContent.jsx`/`AnalysisModal.jsx` — kept in sync with `SURFACES` in `scripts/lint-korean-copy.mjs`): run `npm run lint:korean` before commit, check terms against the Atlassian-grounded glossary (incident=인시던트, outage=중단, degraded=성능 저하), and re-read the whole card rather than the one edited sentence (#1097). The lint itself is a hard gate only at CI (the real-copy scan in `lint-korean-copy.test.mjs` runs under `test:scripts`); this hook is the edit-moment layer, because both the #1094 leak class and the #1097 loop happen DURING the multi-round edit, before CI sees it. Two deterministic rules: **R2 leak** (issue refs / code identifiers / field literals / source filenames in reader copy → the CLI exits 1) and **R1 term drift** (a concept's non-canonical variant → the CLI exits 0 and prints a warning). R1 is a warn, not a fail, because Korean term↔concept is not always 1:1 — `장애` covers both `incident` (event) and `outage` (a component-status severity), so it can't be mechanically canonicalized and is left to the review checklist half; only genuinely 1:1 pairs (사용자/이용자) are ruled. **The warn/fail split describes the CLI, not CI**: the CI gate is the real-copy test, which asserts *both* lists empty, so a new drift on a scanned surface does fail CI — deliberately (the shipped copy is pinned clean; the escape hatch is to scope the rule via `warnOnlyContexts`, a REQUIRE-list of ctx prefixes where the rule fires). R2 is also a floor, not a complete filter — SCREAMING_SNAKE constants, PascalCase types, non-code extensions and single-digit issue refs are deliberate blind spots, enumerated in the glossary. Scope covers each Edge template's **i18n map AND its inline `data-i18n` HTML defaults**, which are not duplicates of each other (`_intro` diverges in 7 keys) — the inline text is the SSR default paint a crawler sees. A Korean node with no `data-i18n` is out of scope. **Coverage is counted per (file, extractor), not per file, and an extractor yielding 0 strings is an INSTRUMENT failure** — the CLI exits 1 and refuses to print ✅, and `--warn-only` does not silence it. That distinction is the whole point of a guard whose default outcome is "pass": a quote-style refactor of an Edge template zeroes its i18n-map extractor while the ~118 inline strings keep any per-file total comfortably non-zero, so a leak planted in the map would otherwise go unreported with CI green. The surface list, the hook's mirror of it, the inline-extractor wiring, the CLI exit codes and the hook's actual message emission are each pinned by a test in `scripts/lint-korean-copy.test.mjs`, and each pin was mutation-checked to go red. Glossary + the warn-vs-fail rationale: `scripts/korean-copy-glossary.mjs`. Logged as `warn`.
- **`step35-verify-gate.mjs`** (PreToolUse/Bash + Edit|Write|MultiEdit, **#657**) — the **HARD** gate (soft reminders alone only get probabilistic compliance; this changes *control flow*). On **`git commit`** of a **UI/Edge** staged diff (`src/` non-test, or any user-facing Edge SSR page — `api/_?{is-down,intro,methodology,badges,plugin,plugin-privacy,extension-privacy,confirm}`, dir OR `.ts` form; **#1023** widened this from just is-down/intro after a `/methodology` copy commit slipped through ungated — one shared `EDGE_PAGE_NAMES` list drives both `isUiEdgePath` and `BASH_WRITE_RE`; `api/reports.ts`/`csp-report.ts`/`_shared/` excluded), it reads `transcript_path` and **DENIES** (`permissionDecision:"deny"`) unless a genuine **`role:user` turn** (`isMeta:false`, content is a STRING or array-text — tool_results don't count) appears **AFTER the last UI/Edge edit** and matches a confirmation (`CONFIRM_RE`, KO+EN) — an unfabricable signal (the agent can't author a user turn). Also **denies `--no-verify`/`--no-gpg-sign`**, and (Edit/Write matcher) **denies self-edits to `.claude/hooks/**` + `.claude/settings*.json`** unless a user turn anywhere in the transcript states intent toward the gate (`HOOK_WORK_RE`, e.g. "훅 작업" / "work on the gate"; naming the hook or its issue number is deliberately not enough, since the audit report contains both; which shapes are refused is pinned per-fixture in `scripts/step35-verify-gate.test.mjs`) — so the agent can't quietly weaken its own gate. **Fail-closed** (deny on parse error). The COMMIT deny states its one-line override; the self-edit deny states the authorization it needs instead, and `--no-verify` states none by design. It **logs every decision** to `.claude/hook-audit.jsonl` so the hard gate is observable (`deny` notes: `commit:<reason>` / `no-verify` / `self-edit:…` / `fail-closed`; `pass` notes: `commit:confirmed` / `commit:override` / `self-edit-authorized:…`) — the high-volume trivial early-exits are deliberately NOT logged. Pure decision fns (incl. `auditLine`) unit-tested via `npm run test:scripts` (`scripts/step35-verify-gate.test.mjs`); the summary's step35 handling in `scripts/hook-audit-summary.test.mjs`. Both honor a `HOOK_AUDIT_LOG` override for test isolation. NOTE non-UI/worker/docs commits are NOT gated here (the soft `git-mutation-gate.sh` still nudges them).
- **`review-loop-gate.mjs`** (PreToolUse/`Task|Agent`, **#1150**) — **telemetry, not a gate.** On every review-agent subagent spawn — the `pr-review-toolkit:*` plugin agents, and the project's own `review-findings-only` (**#1308**) — it records one audit line: the round the prompt declares, or that it declared none, plus the session and the branch (**#1245**). It never blocks and emits no decision. A spawn matching neither writes nothing and exits 0, except where the payload itself is unreadable — a silently blind instrument is the failure this exists to prevent, so those record a `fail-open:` line instead. **#1308 is why the plugin namespace is no longer the whole test:** `review-findings-only` (#1298) is a `.claude/agents/` definition with a bare name, so it matched nothing here and a spawn of it exited before writing anything — and the effect ran backwards, because the more closely the loop followed `code-review-policy.md` and switched to that agent from round 2 onward, the more the histogram under-reported the rounds that actually ran. Project agents are compared by EXACT name, since a bare name has no namespace to anchor a prefix on. `npm run hook-audit`'s **`🔁 review-loop telemetry` section** turns those lines into a per-spawn round histogram, an untracked-round count, a `fail-open=N` instrument-health figure, and a **per-branch view** (#1245), so a loop that ran deep — or that stopped tracking rounds at all — is visible afterwards instead of being reconstructed from memory (which is what #1091/#1110 required). The branch is what makes a loop attributable: **session-keyed depth alone could not answer "how many rounds did this PR take"**, because a loop spans sessions — #1237's shows as maxRound 7 in one session and 3 in another, #1241's as 8 and 3. It is derived from the session's **cwd**, not from where the hook file sits: settings invokes the hook through `$CLAUDE_PROJECT_DIR`, which resolves to the MAIN checkout even for a worktree-isolated session, so a script-relative anchor would report `main` for every worktree loop — silently, and indistinguishably from real main-checkout work. From cwd it walks up to the nearest `.git` and reads git's own files rather than spawning git, covering BOTH layouts (`.git` as a directory, and as the `gitdir:` FILE a worktree gets); the worktree layout is the one that runs during issue work. Lines written before #1245 carry no branch and are counted separately rather than bucketed under a guess, so a stalled rollout does not read as "no loops ran". It contributes nothing to `⚖️ Violations intercepted`; there is nothing to intercept. Pure fns + the `main()` CLI path are unit-tested via `npm run test:scripts`, including the wiring, the note shape, and the fail-open notes — and the summary's own suite drives the real hook so the note format and its reader cannot drift.

Every fire is logged to `.claude/hook-audit.jsonl` (gitignored). `npm run hook-audit` (= `node scripts/hook-audit-summary.mjs [--last N] [--days D] [--branches N]`, so a flag needs `npm run hook-audit -- --branches 30`) summarizes (by hook × decision, last-7-days, per-day trend, recent entries). **The effectiveness signal is the `Violations intercepted` tally, NOT raw `warn`/`inject` counts**: `warn` (git-mutation step-3.5 reminder) and `inject` (every-turn gate re-injection) are *preventive telemetry* that scale with workload — their trend is meaningless. A real intercepted violation is a `block` (a nag was about to ship), a step-3.5 `deny` (except `fail-closed`, which is gate-health, not an interception), or a `no_verify=1` note (`--no-verify`/`--no-gpg-sign` on a commit) — matching `isViolation` in `scripts/hook-audit-summary.mjs`. Review the **violation trend** periodically — a declining/zero count is the goal. **#657 performed the escalation** the old text anticipated: step-3.5 is now HARD-enforced by `step35-verify-gate.mjs` (a `deny` on UI/Edge commits lacking a transcript-confirmed user turn), so a step-3.5 violation is now an intercepted `deny`, not an invisible behavioral miss — correcting the earlier "the confirmation is a user message the hook never sees" claim (hooks DO receive `transcript_path`). The soft gates remain for non-UI commits + salience. **Monitoring the hard gate** (its own `🚦 step-3.5 hard gate` section in `npm run hook-audit`): because a `deny` is *ambiguous* (an intercepted skip OR a false-positive where the parser missed a real confirmation), the key signal for a HARD gate is **the false-positive rate**, not the deny count — specifically a **`commit:override` pass** (the user had to say "검증 생략하고 커밋" on work they had already checked; the strongest proxy) and **`fail-closed`** (gate-health, should trend ~0; nonzero = the transcript read is breaking). Escalate by **tuning `CONFIRM_RE` / softening to a warn** if overrides rise, NOT by hardening further. The structural blind spot remains: a user "확인" turn proves a turn happened, not that they actually looked — so a step-3.5 *false negative* (gate passes an unverified commit) is still invisible to the log; spot-check merged UI PRs periodically.

## The review auto-loop's own non-convergence — why it is NOT hook-enforced (#1150)

The PR-review auto-loop (`ship-issue` step 6, "loop until 0 Critical/Important") can fail to converge
when each round's fix reseeds the next round's finding — the rewrites tracked in #1091 and #1110 both ran
well past round 4, which a stop rule is meant to cut short. The stop rule
(`ship-issue` steps 5-6, #1097/#1124/#1245) is still the **source of record** for *how* to converge
(gate each finding on whether it arrived with a reproduction or failing check, change the class of
fix, delete the construct, weaken the conclusion). But as skill-text alone it fails the way
#1110 documented: the trigger is something the agent has to notice and apply, and it gets evaded by
re-labelling per file or topic.

**#1150 tried to make this a hook, and could not — the outcome is telemetry.** The convergence
judgement can't be computed from a single tool input, so the hook has nothing to decide on. #1150
confirmed it empirically. Each deny design below was built and replayed over this project's own
transcripts before shipping; each either denied work that already complied, or could not discriminate:

- **Count rounds from the transcript** (a new round per review spawn after an intervening edit). There is
  no signal for where one loop ends and the next begins — this repo starts a new issue with no commit in
  between — so it read a new issue's FIRST review as round 4+. Round 1 has no previous findings to cite,
  so that deny has no honest exit.
- **Require a fix VERB next to a prior-round reference**, and — weaker — **require only the prior-round
  reference**. Both denied prompts that carried the causality in wording outside the vocabulary list,
  while the weaker one also passed prompts that carried no causality at all.
- **Require at R6+ that a repo-wide sweep has run**, on the reasoning that "did a sweep run" is objective
  where "is this a new category" is self-assigned. Ordinary fix work greps recursively too, so it could
  not discriminate; replayed over this repo's history it never fired.

The common cause is not a missing vocabulary entry. "Did this prompt say what it fixed, and did that fix
cause this finding?" is a judgement about CONTENT, and every attempt measured PHRASING as a proxy for it.
A deny the operator cannot satisfy honestly leaves only the override — the gate manufactures the work it
exists to save. So enforcement stays in `ship-issue` steps 5-6, where the judgement lives, and the hook
ships the part that measurably works: the record of what the loop did.

The transferable part, and the cheap one: **replay a proposed rule over the transcripts the behaviour
already lives in, and count how often it fires and how many of those firings are wrong.** Prose review
will not tell you that a rule which sounds objective is unreachable, non-discriminating, or inverted.
Include the worktree session directories (`~/.claude/projects/*--claude-worktrees-*`): issue work happens
there, and a main-directory-only scan silently drops those sessions.

## A git hook, not a Claude hook — the agent-activation gate (#1298)

`.githooks/pre-push` is the one enforcement point here that is **not** a `.claude/settings.json` hook.
It refuses a push that adds or modifies a file under `.claude/agents/` unless a successful spawn of
that agent is on record, or `AGENT_VERIFIED=1` is set. The count above stays SEVEN: this is a
different mechanism, run by git rather than by the harness.

**Why it is not a Claude hook, having been built as one twice.** An agent definition loads at session
start, so the session that writes one cannot spawn it — #1299 shipped a definition nobody had run.
Two `PreToolUse` attempts failed for reasons worth keeping:

1. The first was wired BARE (`"$CLAUDE_PROJECT_DIR"/.claude/hooks/…`) while the file is committed
   `100644`. A bare command with no exec bit exits **126**, which `PreToolUse` treats as a
   non-blocking error rather than the deny code **2** — so it blocked nothing and recorded nothing,
   silently. Every `.mjs` hook in the table above is `100644` and is invoked `node "…"`; that is the
   convention, and this one broke it. Its own suite could not see the failure: it asserted that the
   command STRING contained the filename, never that the command could run.
2. The second, deeper, failure was the interception point. Deciding from the command string whether a
   push is happening cannot work — `echo git push` denied, `git -C /elsewhere push` bypassed, and
   `cd ~/aiwatch-reports && git push` **denied**, because the hook read the diff of the SESSION's repo
   rather than the repo being pushed. That command is how a monthly report is published, so an
   unrelated agent edit on an aiwatch branch blocked a different repository, naming an agent that repo
   has never heard of. Per CLAUDE.md the response to a false-positive rate is to tune or soften; there
   was nothing to tune, because a shell string cannot answer "which repo is being pushed".

`pre-push` deletes that question instead of narrowing it. Git runs the hook **in the repository being
pushed** and hands it the refs on stdin, so cross-repo false positives are unrepresentable rather than
filtered.

**It is also the first of the three that could be verified the day it was written.** `core.hooksPath`
is local git config, so the gate is live immediately — no session restart, which is what neither
Claude-hook attempt could get past. Both of those shipped inert.

**What it is today: a conscious-confirmation gate, not an evidence-based one.** The recorder that
would write spawn evidence belonged to the withdrawn `PreToolUse` design (#1304), so **nothing
currently writes a `spawned` record and `AGENT_VERIFIED=1` is the only way through** — spawning the
agent alone will not clear the deny. The hook still reads the audit log, because the recorder may
return and an empty result is the right answer either way.

That makes the override the mechanism rather than a bypass of it: the gate stops you at the moment you
would otherwise publish an unrun definition and makes you assert, out loud, that you ran it. #1150
rejected earlier gates because "a deny the operator cannot satisfy honestly leaves only the override";
here the override IS the honest satisfaction. The deny message says so plainly, so nobody reads step 1
as sufficient. `--no-verify` bypasses the whole hook as it does every git hook; `step35-verify-gate`
denies that flag separately, so the two layers cover each other.

**Whether to add the recorder is open.** It would be a Claude `PostToolUse` hook, which reintroduces
the binding problem that sank both earlier attempts — and its load-bearing premise, that `PostToolUse`
fires only on SUCCESS, has never been observed. Until someone measures that, the honest design is the
one shipped.

**Two things make it live, and both are pinned by `scripts/prepush-agent-gate.test.mjs`:** the exec
bit (git invokes the hook directly, unlike a `node`-wired Claude hook) and a `prepare` script pointing
git at `.githooks`, since `.git/hooks` is not version-controlled and a committed hook is inert on
every clone without it. **An existing clone needs one `npm install` before the gate is active.**

The suite's shape is deliberate: every test that matters EXECUTES the hook in a throwaway repo and
asserts its EXIT CODE, because "denied" and "never ran" are indistinguishable from outside otherwise.
That is the lesson of failure 1 — a structural scan cannot tell a live gate from a dead one.

**Scope: agents only.** Hooks and `settings.json` have the same restart-activation problem and no
equivalent "it ran" event, so they are not covered, and the deny message says so rather than implying
coverage that does not exist.

## The instruction budget — a CI ratchet on always-loaded context (#1285)

`scripts/check-instruction-budget.mjs` caps the size of what every session loads before it does
anything. CLAUDE.md's step 7 asks it to stay "lean, ~40k-char guideline"; nothing enforced that, and
the excess never showed up in a diff. Moving `BUDGET_CHARS` is what puts it there.

It measures `CLAUDE.md` plus `.claude/hooks/workflow-gates.txt`, which `workflow-gates-reminder.sh`
injects every turn. Skill *bodies* and `docs/reference/*` (this file included) are out of scope —
they cost context only when something loads them, which is why detail is moved here rather than
deleted, and why CLAUDE.md references these pages with ordinary markdown links.

A **ratchet, not a target**: `BUDGET_CHARS` is set at the current size, not at 40k, because a cap
that is red on day one gets disabled. Growth past the cap fails, and so does a reduction that opens
more than `MAX_SLACK` — a cap with headroom permits exactly the drift it exists to stop. Both
remedies are the same edit: move the constant in the PR that moved the file. Measured in Unicode code
points, not bytes, because the guideline is written in chars.

**Where it is gated.** `test.yml` paths-ignores `CLAUDE.md`, so a CLAUDE.md-only PR — the shape that
moves this budget — starts none of its jobs. The guard therefore runs as its own `Docs Lint` job, the
same reason `doc-symbols` lives there (#1100) and the count lockstep was moved there (#1081). That is
also why the slack check lives in the script and not only in the tests: a test-only check would pass
the reducing PR and red an unrelated later one. `npm run test:scripts` covers the gate text, which is
not a docs path. Those links are tested in `scripts/workflow-paths-sync.test.mjs` and
`scripts/check-instruction-budget.test.mjs`.

**What it does not do.** It does not verify that the measured set is COMPLETE — only that those two
files stay within the cap. `ALWAYS_LOADED` is pinned as a literal so a change to the set lands in the
diff, but nothing proves no third surface is always-loaded. Two specific gaps were built during
review and then deliberately removed (#1285): a detector for CLAUDE.md `@path` imports, which load a
whole file for one line of link, and a check that the gate hook injects the file the budget measures.
Both required modelling behaviour that cannot be verified from this repo — Claude Code's import
grammar, markdown fence semantics, hook payload identity — and each attempt shipped a hole that read
as protection. The convention they were guarding is already the practice: CLAUDE.md references
`docs/reference/*` with markdown links (18 of them) and contains no `@` imports.

## Related

- [Reference Tooling](reference-tooling.md) — the `tooling-trigger.sh` trigger map (chub vs modern-web-guidance).
- CLAUDE.md "Development Workflow" — the per-issue procedure these hooks back up (the `ship-issue` skill is the runbook).

The three PreToolUse soft reminders (`git-mutation-gate.sh`, `tooling-trigger.sh`, and
`korean-copy-trigger.sh`) deliver their text through
`hookSpecificOutput.additionalContext` with `hookEventName: "PreToolUse"`. A top-level
`systemMessage` is not delivered for these events and must not be used.

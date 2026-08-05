#!/usr/bin/env node
// #541 — production-data "verify-after" reminders.
//
// Some features/fixes need a production-data check after a delay (e.g. "confirm the Slack unfurl is
// fresh after the next incident", "check p95 after 3 months of archives"). Tracked only as issue
// comments, these are missed unless the board is reviewed. This script — run daily by
// .github/workflows/verify-reminders.yml — scans OPEN issues for a `verify-after <YYYY-MM-DD>` line
// and pings the operator Discord when due (and weekly while the issue stays open).
//
// Issue = single source of truth: closing the issue (or removing the line) cancels the reminder.
// Pure helpers (parseVerifyAfter / daysSinceDue / shouldFire) are exported + unit-tested in
// scripts/verify-reminders.test.mjs. `--dry-run` (or DRY_RUN=1) prints actions without side effects.

import { execFileSync } from 'node:child_process'
// #873 — Tier-A auto-verify: evaluate a machine-checkable `assert:` clause on a verify-after line and
// close the loop (tick + comment + drop verify-blocked) instead of only pinging. See verify-assertions.mjs.
import { pairVerifyAssertions, runAssertion, planIssueAutoVerify, truncate, isSuppressedReminderLine, findQuotedVerifyAfterBoxes } from './verify-assertions.mjs'

// Matches a `verify-after 2026-09-01` token anywhere on a line; captures the date + the rest of the
// line as a free-form note. Case-insensitive; `after` may be followed by space, `:` or `-`.
const VERIFY_RE = /verify-after[\s:-]+(\d{4}-\d{2}-\d{2})([^\n]*)/gi

// Which lines a verify-after scan must SKIP (checked box `- [x]` / blockquote `>`) now lives in
// verify-assertions.mjs as `isSuppressedReminderLine` — one definition shared by both scanners (#966).
// Unchecked boxes (`- [ ]`) and non-quoted prose still fire.

// An UNCHECKED markdown task-list marker at the start of a line (`- [ ]` / `* [ ]` / `+ [ ]`, leading
// indent ok). Used by the body-drift guard below. The marker→`[` space is REQUIRED (`\s+`), mirroring
// the checked-box marker inside `isSuppressedReminderLine` (verify-assertions.mjs), so `-[ ]` (GFM
// literal text, not a task) is not treated as a checkbox.
const UNCHECKED_BOX_RE = /^\s*[-*+]\s+\[ \]/
// A verify-after line is legitimately unchecked until its production signal lands, so it is NOT drift.
const VERIFY_AFTER_LINE_RE = /verify-after[\s:-]+\d{4}-\d{2}-\d{2}/i

/**
 * Body-drift guard (issue-body-sync backstop). A `verify-blocked` issue means "code shipped; only a
 * dated production verify-after remains", so EVERY implementation checkbox should already be ticked —
 * the only lines still `- [ ]` should be the verify-after line(s). Any OTHER unchecked box means the
 * body was never synced at merge (the late/no-gate/other-system step) or the label is wrong. This
 * returns the count + a few samples of those stray unchecked boxes so the caller can flag the issue.
 * Pure + unit-tested. verify-after lines and checked boxes are excluded; an empty body → no drift.
 * Known limitation (accepted): the scan is line-based and NOT fence-aware, so a `- [ ]` inside a
 * ```fenced``` checklist template/example counts too — tolerable here (label-only, self-heals, and the
 * verify-blocked bucket rarely embeds template checklists).
 */
export function findBodyDrift(body) {
  if (!body) return { count: 0, samples: [] }
  const items = []
  for (const line of body.split('\n')) {
    if (!UNCHECKED_BOX_RE.test(line)) continue
    if (VERIFY_AFTER_LINE_RE.test(line)) continue // open-until-verified, not drift
    items.push(line.replace(UNCHECKED_BOX_RE, '').replace(/\*+/g, '').trim())
  }
  return { count: items.length, samples: items.slice(0, 5) }
}

/**
 * True when an issue is a body-drift candidate: labeled `verify-blocked` (code shipped, verify-gated)
 * AND NOT `tracking`. A `tracking` umbrella legitimately keeps many open sub-item checkboxes (future
 * work, not drift), so it is exempt — this scopes the guard to exactly the single-deliverable
 * verify-blocked bucket where checkbox drift actually concentrates. `labels` = the gh `--json labels`
 * array (`{name}` objects) or a plain string array.
 */
export function isDriftCandidate(labels) {
  const set = new Set((labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean))
  return set.has('verify-blocked') && !set.has('tracking')
}

/** True when `labels` (gh `--json labels` objects or plain strings) carries `name`. */
export function hasLabel(labels, name) {
  return (labels || []).some((l) => (typeof l === 'string' ? l : l?.name) === name)
}

/** True when the issue currently carries the `body-drift` label (so the guard can self-heal / clear it). */
export function hasBodyDriftLabel(labels) {
  return hasLabel(labels, 'body-drift')
}

/**
 * The labels this job applies to track an OPEN verification obligation (#1037). Each is only ever
 * meaningful while the issue is open: `verify-blocked` = a dated check is outstanding, `verify-overdue`
 * = that check is past due, `body-drift` = the body's boxes weren't synced at merge,
 * `verify-undecidable` = a dated check names no artifact that will exist on its date (#1206).
 *
 * Adding a label to this job MUST add it here too — the closed-scar sweep is what stops it becoming a
 * permanent mislabel on a closed issue, which is the whole of #1037.
 */
export const LIFECYCLE_LABELS = ['verify-overdue', 'verify-blocked', 'body-drift', 'verify-undecidable']

/** Page size for the per-label closed-issue query (#1037). A truncated page still drains over later
 *  runs (swept issues leave the result set), but the fetch warns so it never truncates silently. */
export const CLOSED_SCAR_LIMIT = 100

/**
 * Plan the label removals for CLOSED issues still wearing a lifecycle label (#1037) — the closed half
 * of #966's own complaint. Every self-heal in this job is derived from an OPEN issue's body, and the
 * scan is `--state open`, so closing an issue puts its labels permanently out of reach: the label stops
 * describing current state and becomes a scar any triage query then misreads. #966 was filed on exactly
 * this evidence (#857, closed and still overdue-labeled) but only fixed the open case.
 *
 * No date logic, deliberately: CLOSED IS the terminal state of a verification obligation, so every
 * lifecycle label is unconditionally meaningless once the issue is closed. Nothing to re-derive.
 *
 * Groups every stale label of one issue into a SINGLE edit — an issue can wear several (#547 did), and
 * one `gh issue edit --remove-label a --remove-label b` is one API call instead of three.
 *
 * Pure — no I/O. `closedIssues` = gh `--json number,labels` objects, each tagged with its `repo`.
 */
export function planClosedScarRemovals(closedIssues) {
  const out = []
  for (const iss of closedIssues || []) {
    const stale = LIFECYCLE_LABELS.filter((l) => hasLabel(iss.labels, l))
    if (stale.length > 0) out.push({ repo: iss.repo ?? null, number: iss.number, labels: stale })
  }
  return out
}

/**
 * Merge per-label closed-issue query results into one entry per issue (#1037). The fetch runs one
 * bounded query PER LABEL (an issue wearing two labels comes back twice), so dedup by repo+number and
 * union the label sets before planning — otherwise one issue would get one edit per label it wears.
 *
 * Flattens to ANY depth on purpose: the caller nests per-repo over per-label (`repos.map(fetchClosedScars)`
 * → repo[] of label[] of issue[]), and a fixed one-level flat silently yielded arrays instead of issues,
 * dropping every scar while the unit tests — which passed a shallower shape than the real caller — stayed
 * green. Caught only by a live --dry-run.
 * Pure — no I/O.
 */
export function mergeClosedIssues(issueLists, warn = console.warn) {
  const byKey = new Map()
  for (const iss of (issueLists || []).flat(Infinity)) {
    // WARN rather than skip quietly. A silently-dropped entry is exactly how the one-level-flat bug
    // above stayed invisible (0 scars reads identical to a clean board), and this file's own #966
    // silent-drop guards exist on the principle that a dropped reminder must never look like a quiet
    // day. `gh --json number,labels` always carries `number`, so this only fires on real shape drift.
    if (!iss || iss.number == null) {
      warn(`[verify-reminders] closed-scar entry without a number (gh output shape drift?) — skipped: ${truncate(JSON.stringify(iss), 80)}`)
      continue
    }
    const key = issueKey(iss)
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, { ...iss, labels: [...(iss.labels || [])] })
      continue
    }
    const seen = new Set(prev.labels.map((l) => (typeof l === 'string' ? l : l?.name)))
    for (const l of iss.labels || []) {
      const name = typeof l === 'string' ? l : l?.name
      if (!seen.has(name)) { prev.labels.push(l); seen.add(name) }
    }
  }
  return [...byKey.values()]
}

/** Stable identity for an issue across repos (the sibling scan means numbers alone collide). */
const issueKey = (i) => `${i.repo || ''}#${i.number}`

/**
 * `verify-overdue` self-heal (#966). The label answers "is this issue past its verify date *right
 * now*", so it must clear when that stops being true — otherwise it is a permanent scar: it was added
 * on every fire (see main) and removed by NOTHING. Not by the #873 auto-verify (which drops only
 * `verify-blocked`), not by `gh issue close`. #857 was auto-verified and closed at 02:05 UTC and still
 * wore `verify-overdue` hours later, so any triage query filtering on it read stale state. Mirrors the
 * self-healing `body-drift` clear.
 *
 * The clear predicate is "this issue has NO still-overdue, unticked `verify-after` line" — derived
 * from the dates, NOT from this run's `due` set. Those differ: `due` is throttled by `shouldFire`'s
 * weekly cadence (`d % 7 === 0`), so a genuinely-overdue issue is absent from `due` on 6 of every 7
 * days. Clearing on "not in `due`" would strip the label the day after every ping and re-add it a week
 * later — a flapping label that a `label:verify-overdue` triage query would see 1 day in 7, plus daily
 * add/remove API churn. (Caught in review; the first draft of this function had exactly that bug.)
 *
 * `tickedKeys` are the `repo#number#lineIndex` keys the auto-verify pass ticked THIS run — the fetched
 * `body` still shows them unchecked, so they must not count as overdue. Suppressed lines (checked
 * boxes, blockquotes) never reach here: `pairVerifyAssertions` already drops them.
 *
 * An INVALID date (a typo'd `2026-13-45`) holds the label OPEN — fail-safe, not fail-open. The ping
 * loop already skips such a line, so clearing the label too would take the issue completely dark: no
 * ping, no label, no warning. Keeping the label preserves the last attention signal; `main` warns.
 *
 * Pure — no I/O.
 */
export function findStaleOverdueLabels(considered, today, tickedKeys = new Set()) {
  return (considered || []).filter((iss) => {
    if (!hasLabel(iss.labels, 'verify-overdue')) return false
    const holdsLabelOpen = pairVerifyAssertions(iss.body).some(({ date, lineIndex }) => {
      if (!isValidIsoDate(date)) return true // fail-safe: unparseable date keeps the signal alive
      if (tickedKeys.has(`${issueKey(iss)}#${lineIndex}`)) return false // ticked moments ago this run
      return daysSinceDue(date, today) >= 0
    })
    return !holdsLabelOpen
  })
}

/**
 * `verify-after` lines whose date isn't a real calendar date (`2026-02-30`, `2026-13-01`). Such a line
 * silently never pings (the due loop skips it), so the daily job surfaces it. Pure — no I/O.
 */
export function findInvalidVerifyAfterDates(body) {
  return pairVerifyAssertions(body).filter((it) => !isValidIsoDate(it.date))
}

/**
 * UNDECIDABLE `verify-after` lines (#1206) — open, dated, and carrying NEITHER an `assert:` (a machine
 * decides it) NOR a `durable:` (a named artifact that will still exist on the date, so a human can).
 *
 * The failure this catches is not a missed ping; it is a check that CANNOT be answered when its ping
 * arrives, because the thing it was going to look at is gone. Measured on 2026-08-05: of 29 open
 * unchecked verify-after lines, only 2 carried an `assert:`. Three came due that day and all three
 * failed the same way — #1179's KV records had aged out (7h/24h TTLs), leaving 1 of 7 days
 * observable; #1104's keep path writes no trace at all; #1103 needed an operator tweet nobody had
 * sent. Two of the three were closed unverified, with a reopen trigger written in place of the date.
 *
 * `feedback_verify_after_design` already states the authoring rule. It lost to the moment of writing —
 * the #415 lesson (a written rule gets probabilistic compliance; a check at the decision moment gets
 * deterministic compliance). This is that check, one day late instead of never.
 *
 * Deliberately NOT validating what `durable:` names. A KV key with a 7h TTL is a bad answer, and no
 * regex can tell that from a good one; what the marker buys is the author being made to name the
 * artifact and notice it will be gone.
 *
 * Scoped to lines that are NOT YET DUE, which is the whole actionable window: before the date there
 * is still time to add instrumentation or name an artifact, and a newly-written verify-after is
 * always future-dated, so nothing the guard exists for is lost. Past the date the item is already in
 * the ping → escalation flow and a second label would only double-count it. Measured on the live
 * board: unscoped this would have labelled 22 issues on day 1, scoped it labels 13 — still a legacy
 * backlog to sweep, not a clean start, and the open sweep item on #1206 is what takes it to zero.
 * The label self-heals into `verify-overdue` as the date passes; between the due date and the
 * escalation window there is deliberately NO undecidability signal, so an operator can get an
 * ordinary ping for a check that has nothing to look at.
 * Pure — no I/O.
 */
export function findUndecidableVerifyAfter(body, today = new Date().toISOString().slice(0, 10)) {
  return pairVerifyAssertions(body).filter(
    (it) => isValidIsoDate(it.date) && !it.assertion && !it.durable && daysSinceDue(it.date, today) < 0,
  )
}

/** True when the issue carries the `verify-undecidable` label (so the flag can self-heal / clear). */
export function hasUndecidableLabel(labels) {
  return hasLabel(labels, 'verify-undecidable')
}

/**
 * Days past due after which an overdue verify-after stops being a routine ping and becomes a decision
 * to make (#1206). 30 days is four unanswered weekly pings: enough that "it will resolve itself next
 * week" has been falsified four times, and far enough above the 6-day worst case on the board when
 * this shipped that it fires on a stuck item rather than on ordinary lag.
 *
 * The bound exists because of a POLICY, not because of an observed pile-up: #1104's body instructed
 * "push it out rather than closing on absence of evidence", which is unbounded extension in writing.
 * This is the ceiling that instruction never had.
 */
export const OVERDUE_ESCALATION_DAYS = 30

/**
 * Overdue verify-after items old enough to need a disposition rather than another ping (#1206).
 * Why the bound exists: see OVERDUE_ESCALATION_DAYS above.
 *
 * Escalation is a REPORT, never a mutation. This job's whole design is that closure is signalled by
 * label removal, not `gh issue close` (see the closed-scar sweep above); an issue is not the job's to
 * destroy, and "nobody could observe this" is a judgement about intent, not a fact about an endpoint.
 * The human disposition is to close with a written reopen trigger — what #1103/#1104 got by hand.
 *
 * Items carrying an `assert:` are excluded: those are not waiting on a human, they are waiting on a
 * production signal, and the auto-verify pass drains them the moment it lands. Accepted limit: an
 * assertion that has gone permanently `skip`/`fail` (a selector the API no longer serves) pings weekly
 * forever inside the one branch this bound cannot reach.
 *
 * Emits one row PER LINE, not per issue. That is what lets `splitEscalatedDue` join it against `due`,
 * which is also per line — a per-issue rollup keyed to the issue's worst line silently mismatched any
 * multi-line issue: the escalation was dropped when the worst line was not the one firing that day,
 * and the same issue appeared in BOTH embeds when two lines fired together. SKILL.md's canonical
 * format prescribes one verify-after line per part, so multi-line issues are the normal case.
 *
 * Mirrors findStaleOverdueLabels: derived from the DATES (not this run's weekly-throttled `due` set),
 * and `tickedKeys` are the lines auto-verified moments ago this run. Pure — no I/O.
 */
export function findOverdueEscalations(considered, today, tickedKeys = new Set(), thresholdDays = OVERDUE_ESCALATION_DAYS) {
  const out = []
  for (const iss of considered || []) {
    for (const { date, note, lineIndex, assertion } of pairVerifyAssertions(iss.body)) {
      if (assertion) continue
      if (!isValidIsoDate(date)) continue
      if (tickedKeys.has(`${issueKey(iss)}#${lineIndex}`)) continue
      const days = daysSinceDue(date, today)
      if (!Number.isInteger(days) || days < thresholdDays) continue
      out.push({ repo: iss.repo ?? null, number: iss.number, title: iss.title, date, note, days, lineIndex })
    }
  }
  return out.sort((a, b) => b.days - a.days)
}

/** Identity of one reminder LINE, shared by the `due` list and the escalation list so the two can be
 *  joined. `lineIndex`, NOT the date: two verify-after lines on one issue may share a date (4 open
 *  issues do today, and #827's own block had two), and keying on the date collapses them — if one
 *  escalates, the other is stripped from the routine bucket too and disappears from Discord entirely,
 *  with `verify-overdue` still applied so nothing looks wrong. Both producers parse the same body in
 *  the same run, so the index is stable across them. Includes the repo: the sibling scan means bare
 *  numbers collide (`aiwatch#41` vs `aiwatch-reports#41`). */
export const reminderLineKey = (d) => `${d.repo || ''}#${d.number}#${d.lineIndex}`

/**
 * Split this run's `due` lines into the routine bucket and the escalated one (#1206).
 *
 * Escalations are restricted to what is FIRING this run, and re-bucketed rather than added: an
 * escalated line already fires on the weekly `% 7` cadence, so riding that same post keeps the
 * operator's message volume unchanged. Posting every standing escalation daily would be exactly the
 * spam the weekly cadence exists to prevent.
 *
 * Extracted and exported because this join is where the feature can ship inert — with it inlined in
 * main(), every wiring mutation survived the suite: dropping the escalation argument to postDiscord,
 * removing the firing filter, or leaving the escalated line in BOTH buckets. Pure — no I/O.
 */
export function splitEscalatedDue(due, escalations) {
  const firingNow = new Set((due || []).map(reminderLineKey))
  const escalatedNow = (escalations || [])
    .filter((e) => firingNow.has(reminderLineKey(e)))
    .map((e) => ({ ...e, ref: displayRef(e.repo, e.number), overdueDays: e.days }))
  const escalatedKeys = new Set(escalatedNow.map(reminderLineKey))
  return { routineDue: (due || []).filter((d) => !escalatedKeys.has(reminderLineKey(d))), escalatedNow }
}

/** True only for a real calendar date (rejects 2026-02-30, which Date would silently roll over). */
export function isValidIsoDate(s) {
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Extract every {date, note} pair from an issue body. Calendar-invalid dates are skipped, as are
 *  CHECKED checkbox (`- [x]`) and BLOCKQUOTE (`>`) lines — see isSuppressedReminderLine. */
export function parseVerifyAfter(body) {
  const out = []
  if (!body) return out
  // Scan line-by-line so a per-line checkbox/blockquote can suppress that line's verify-after.
  for (const line of body.split('\n')) {
    if (isSuppressedReminderLine(line)) continue
    for (const m of line.matchAll(VERIFY_RE)) {
      if (!isValidIsoDate(m[1])) continue
      const note = m[2].replace(/^[\s—–:*_)·-]+/, '').replace(/\*+$/, '').trim()
      out.push({ date: m[1], note })
    }
  }
  return out
}

/**
 * Trusted issue authors whose `verify-after` lines are honored. #541 abuse-gate: this runs on a
 * PUBLIC repo, so without a gate anyone could open an issue to fire an operator Discord ping + apply
 * a label. The trusted set is the union of: the repo OWNER (from GITHUB_REPOSITORY, always set in
 * Actions), an explicit VERIFY_TRUSTED_AUTHORS allow-list (comma-separated), AND the owner of every
 * concrete `repos` entry being scanned (so scanning a public sibling can't open the gate even when
 * GITHUB_REPOSITORY is unset). Empty set (only `repos: [null]` / pure local with no env) → the
 * caller does NOT filter, so the maintainer can test against their own board.
 */
export function parseTrustedAuthors(env = process.env, repos = []) {
  const explicit = (env.VERIFY_TRUSTED_AUTHORS || '').split(',').map((s) => s.trim()).filter(Boolean)
  const owner = (env.GITHUB_REPOSITORY || '').split('/')[0].trim()
  // Also trust the OWNER of every concrete repo being scanned. This keeps the abuse-gate closed when
  // GITHUB_REPOSITORY is empty but a concrete sibling is scanned (VERIFY_EXTRA_REPOS defaults to the
  // public reports repo) — otherwise the trusted set would be empty and main() would skip filtering,
  // opening the gate on a public repo. It also gates a different-owner sibling against ITS own owner
  // (each scanned repo trusts its owner's issues). Only `repos: [null]` (pure local) yields an empty
  // set → no filter, preserving the maintainer's against-own-board test path.
  const repoOwners = repos.filter(Boolean).map((r) => r.split('/')[0].trim()).filter(Boolean)
  return new Set([...explicit, ...(owner ? [owner] : []), ...repoOwners])
}

/**
 * The `owner/repo` slugs to scan. The board lives in more than one repo now — `verify-after` lines
 * also land in the sibling **aiwatch-reports** repo (the report generator), and the daily Action only
 * ran the repo it lives in, so those lines never fired. Returns the main repo (GITHUB_REPOSITORY)
 * plus the extras in VERIFY_EXTRA_REPOS (comma-separated; defaults to the reports repo), de-duped and
 * order-preserving. Local dev with no GITHUB_REPOSITORY → `[null]` = "current repo, no --repo flag",
 * preserving the maintainer's against-own-board test path.
 *
 * NOTE the GitHub Action's default GITHUB_TOKEN is scoped to its OWN repo, so reaching a sibling repo
 * needs a cross-repo PAT (VERIFY_CROSS_REPO_TOKEN in the workflow). When that's absent the sibling
 * fetch 403/404s — main() treats a per-repo fetch failure as best-effort (warn + skip), so the
 * primary reminder never breaks just because the cross-repo token isn't set yet.
 */
export function parseScanRepos(env = process.env) {
  const main = (env.GITHUB_REPOSITORY || '').trim()
  const extras = (env.VERIFY_EXTRA_REPOS ?? 'bentleypark/aiwatch-reports')
    .split(',').map((s) => s.trim()).filter(Boolean)
  const all = [...(main ? [main] : []), ...extras]
  const deduped = [...new Set(all)]
  return deduped.length > 0 ? deduped : [null]
}

/**
 * Discord/label reference for an issue, disambiguated across repos. The main repo (or a null/local
 * repo) stays the bare `#N`; a sibling repo is qualified by its short name, e.g. `aiwatch-reports#41`,
 * so the operator can tell `aiwatch#41` from `aiwatch-reports#41` at a glance.
 */
export function displayRef(repo, number, env = process.env) {
  const main = (env.GITHUB_REPOSITORY || '').trim()
  if (!repo || repo === main) return `#${number}`
  return `${repo.split('/')[1]}#${number}`
}

/** Whole-day difference today − due (UTC midnight). Negative = due is in the future. NaN on bad input. */
export function daysSinceDue(dueISO, todayISO) {
  const due = Date.parse(`${dueISO}T00:00:00Z`)
  const today = Date.parse(`${todayISO}T00:00:00Z`)
  if (Number.isNaN(due) || Number.isNaN(today)) return NaN
  return Math.round((today - due) / 86_400_000)
}

// Fire on the due date AND every 7th day after, while the issue stays open. Stateless by design: the
// daily cron runs once/day so this never double-fires the same day, and the weekly cadence (vs daily)
// avoids spamming the operator channel — no marker file / "last fired" state to maintain.
export function shouldFire(dueISO, todayISO) {
  const d = daysSinceDue(dueISO, todayISO)
  return Number.isInteger(d) && d >= 0 && d % 7 === 0
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

/**
 * Render the two Discord sections (#1206). Routine items need a LOOK; escalated ones are past
 * OVERDUE_ESCALATION_DAYS and need a DECISION — close with a written reopen trigger, or make the
 * thing observable. Kept apart so a decision is not filed behind a list of routine checks and
 * skipped with them. Pure — exported for unit tests.
 */
export function buildReminderEmbeds(items, escalated = []) {
  const line = (it) => {
    const when = it.overdueDays > 0 ? `due ${it.date}, ${it.overdueDays}d overdue` : 'due today'
    return `• **${it.ref || `#${it.number}`}** ${it.title}\n  → ${it.note || 'verify production data'} _(${when})_`
  }
  const embeds = []
  if (items.length) {
    embeds.push({
      title: '🔔 Production-data verification due',
      description: `${items.length} item(s) need a production-data check now:\n\n${items.map(line).join('\n')}`,
      color: 0xfee75c,
      footer: { text: 'AIWatch · verify-after reminders (#541)' },
    })
  }
  if (escalated.length) {
    embeds.push({
      title: '⏳ Overdue past the escalation window — needs a disposition',
      description: `${escalated.length} item(s) have been overdue ${OVERDUE_ESCALATION_DAYS}+ days. `
        + 'Another ping will not decide these. Either make the check observable (instrument it, or name a `durable:` artifact), '
        + 'or close the issue with a written reopen trigger.\n\n'
        + escalated.map(line).join('\n'),
      color: 0xed4245,
      footer: { text: 'AIWatch · verify-after escalation (#1206)' },
    })
  }
  return embeds
}

async function postDiscord(webhook, items, escalated = []) {
  const body = { embeds: buildReminderEmbeds(items, escalated) }
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Discord webhook ${res.status}: ${await res.text().catch(() => '')}`)
}

// Fetch open issues for one repo (null = current repo, no --repo flag). Best-effort: a per-repo
// failure (e.g. the cross-repo PAT is missing so a sibling repo 403/404s) warns + returns [] so the
// primary reminder still runs. Each issue is tagged with its `repo` for later ref/label targeting.
function fetchRepoIssues(repo) {
  const args = ['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,body,author,labels']
  if (repo) args.push('--repo', repo)
  try {
    const issues = JSON.parse(gh(args))
    return issues.map((i) => ({ ...i, repo }))
  } catch (e) {
    console.warn(`[verify-reminders] could not list issues for ${repo || 'current repo'} (skipping): ${e.message.split('\n')[0]}`)
    return []
  }
}

// Fetch CLOSED issues still wearing a lifecycle label, for one repo (#1037). Bounded by construction:
// one query PER LABEL, each returning only issues that already carry it — never a full closed-issue
// scan. Best-effort per label, mirroring fetchRepoIssues: a failure warns + contributes [] so the
// primary reminder still runs.
//
// Deliberately NOT gated by the trusted-author filter: this only REMOVES a label the job itself applies,
// so there is no abuse surface to close, and the historical scars predate any authorship bookkeeping.
function fetchClosedScars(repo) {
  return LIFECYCLE_LABELS.map((label) => {
    const args = ['issue', 'list', '--state', 'closed', '--label', label, '--limit', String(CLOSED_SCAR_LIMIT), '--json', 'number,labels']
    if (repo) args.push('--repo', repo)
    try {
      const parsed = JSON.parse(gh(args))
      // A truncated page is self-correcting (swept issues leave the result set, so the backlog drains
      // over successive days) but must not be silent — same principle as the #966 silent-drop guards.
      if (parsed.length === CLOSED_SCAR_LIMIT) {
        console.warn(`[verify-reminders] closed '${label}' scars hit the ${CLOSED_SCAR_LIMIT} page limit for ${repo || 'current repo'} — sweeping the first page; the rest drain on later runs.`)
      }
      return parsed.map((i) => ({ ...i, repo }))
    } catch (e) {
      console.warn(`[verify-reminders] could not list closed '${label}' issues for ${repo || 'current repo'} (skipping): ${e.message.split('\n')[0]}`)
      return []
    }
  })
}

async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'
  const today = todayUTC()

  const repos = parseScanRepos()
  console.log(`[verify-reminders] ${today}: scanning ${repos.length} repo(s): ${repos.map((r) => r || 'current').join(', ')}`)
  const issues = repos.flatMap(fetchRepoIssues)

  // #541 abuse-gate (public repo): only honor verify-after lines from trusted authors. Trusted owners
  // include every concrete scanned repo's owner, so scanning a public sibling never opens the gate.
  // Empty set only for pure-local (`repos: [null]`) → no filter, so the maintainer can test own board.
  const trusted = parseTrustedAuthors(process.env, repos)
  const considered = trusted.size > 0 ? issues.filter((i) => trusted.has(i.author?.login)) : issues

  // ── Body-drift guard (issue-body-sync backstop) ───────────────────────────────
  // Catch the drift where a verify-blocked (non-tracking) issue shipped its code but its body still
  // lists unchecked NON-verify-after checkboxes — the boxes weren't synced at merge (the late, no-gate
  // step in a different system than git) or the label is wrong. Mechanically backstops the ship-issue
  // merge-time sync. LABEL-ONLY, no Discord: the `body-drift` label is the signal issue-triage consumes,
  // and label ops don't spam the operator channel daily. Self-healing — the label is removed once the
  // body is synced (0 stray boxes). Best-effort: a label failure must never abort the reminder run.
  const driftScanned = considered
    .filter((i) => isDriftCandidate(i.labels))
    .map((i) => ({ iss: i, drift: findBodyDrift(i.body) })) // compute once per candidate (reused below)
  const toFlagDrift = driftScanned.filter((x) => x.drift.count > 0)
  const toClearDrift = driftScanned
    .filter((x) => x.drift.count === 0 && hasBodyDriftLabel(x.iss.labels))
    .map((x) => x.iss)
  if (toFlagDrift.length) console.log(`[verify-reminders] ${today}: ${toFlagDrift.length} body-drift → ${toFlagDrift.map((x) => `${displayRef(x.iss.repo, x.iss.number)}(${x.drift.count})`).join(', ')}`)
  if (dryRun) {
    if (toFlagDrift.length) console.log('[verify-reminders] --dry-run: would LABEL body-drift:\n' + JSON.stringify(
      toFlagDrift.map((x) => ({ ref: displayRef(x.iss.repo, x.iss.number), strayBoxes: x.drift.count, samples: x.drift.samples })), null, 2))
    if (toClearDrift.length) console.log('[verify-reminders] --dry-run: would CLEAR body-drift on: ' + toClearDrift.map((i) => displayRef(i.repo, i.number)).join(', '))
  } else {
    for (const { iss } of toFlagDrift) {
      const a = ['issue', 'edit', String(iss.number), '--add-label', 'body-drift']
      if (iss.repo) a.push('--repo', iss.repo)
      try { gh(a) } catch (e) { console.warn(`[verify-reminders] could not add body-drift on ${displayRef(iss.repo, iss.number)}: ${e.message.split('\n')[0]}`) }
    }
    for (const iss of toClearDrift) {
      const a = ['issue', 'edit', String(iss.number), '--remove-label', 'body-drift']
      if (iss.repo) a.push('--repo', iss.repo)
      try { gh(a) } catch (e) { console.warn(`[verify-reminders] could not clear body-drift on ${displayRef(iss.repo, iss.number)}: ${e.message.split('\n')[0]}`) }
    }
  }

  // ── Undecidable verify-after guard (#1206) ────────────────────────────────────
  // Flag a dated check that names neither a machine assertion nor the durable artifact a human will
  // read on the date. Runs against every considered issue (not just verify-blocked ones): the line is
  // undecidable from the moment it is written, and catching it within a day of the merge is the whole
  // point — the author still has the context to add instrumentation or drop the date. LABEL-ONLY, no
  // Discord: this is a board signal, and the daily channel is for things due NOW. Self-healing, same
  // as body-drift. Best-effort: a label failure must never abort the reminder run.
  const undecidableScanned = considered.map((i) => ({ iss: i, items: findUndecidableVerifyAfter(i.body, today) }))
  const toFlagUndecidable = undecidableScanned.filter((x) => x.items.length > 0)
  const toClearUndecidable = undecidableScanned
    .filter((x) => x.items.length === 0 && hasUndecidableLabel(x.iss.labels))
    .map((x) => x.iss)
  if (toFlagUndecidable.length) console.log(`[verify-reminders] ${today}: ${toFlagUndecidable.length} undecidable verify-after → ${toFlagUndecidable.map((x) => `${displayRef(x.iss.repo, x.iss.number)}(${x.items.length})`).join(', ')}`)
  if (dryRun) {
    if (toFlagUndecidable.length) console.log('[verify-reminders] --dry-run: would LABEL verify-undecidable:\n' + JSON.stringify(
      toFlagUndecidable.map((x) => ({ ref: displayRef(x.iss.repo, x.iss.number), dates: x.items.map((i) => i.date) })), null, 2))
    if (toClearUndecidable.length) console.log('[verify-reminders] --dry-run: would CLEAR verify-undecidable on: ' + toClearUndecidable.map((i) => displayRef(i.repo, i.number)).join(', '))
  } else {
    for (const { iss } of toFlagUndecidable) {
      const a = ['issue', 'edit', String(iss.number), '--add-label', 'verify-undecidable']
      if (iss.repo) a.push('--repo', iss.repo)
      try { gh(a) } catch (e) { console.warn(`[verify-reminders] could not add verify-undecidable on ${displayRef(iss.repo, iss.number)}: ${e.message.split('\n')[0]}`) }
    }
    for (const iss of toClearUndecidable) {
      const a = ['issue', 'edit', String(iss.number), '--remove-label', 'verify-undecidable']
      if (iss.repo) a.push('--repo', iss.repo)
      try { gh(a) } catch (e) { console.warn(`[verify-reminders] could not clear verify-undecidable on ${displayRef(iss.repo, iss.number)}: ${e.message.split('\n')[0]}`) }
    }
  }

  // ── Closed-issue label scars (#1037) ──────────────────────────────────────────
  // Clear every lifecycle label left on a CLOSED issue. The rest of this job self-heals from an OPEN
  // issue's body, and the scan is `--state open` — so a label still on at close time is stranded forever
  // (the #857 case #966 was filed over, which its open-only fix never reached). This job even makes its
  // own: the #873 auto-verify path closes an issue while dropping only `verify-blocked`.
  //
  // Placed HERE, before the due/overdue stage: that stage early-returns when there is nothing to ping,
  // and a quiet day is exactly when a scar sweep should still run. Best-effort per issue — a label
  // failure must never abort the reminder run.
  const closedScars = planClosedScarRemovals(mergeClosedIssues(repos.map(fetchClosedScars)))
  if (closedScars.length) {
    console.log(`[verify-reminders] ${today}: ${closedScars.length} closed-issue label scar(s) → ${closedScars.map((s) => `${displayRef(s.repo, s.number)}(${s.labels.join('+')})`).join(', ')}`)
  }
  if (dryRun) {
    if (closedScars.length) console.log('[verify-reminders] --dry-run: would CLEAR closed-issue labels:\n' + JSON.stringify(closedScars, null, 2))
  } else {
    for (const scar of closedScars) {
      const a = ['issue', 'edit', String(scar.number)]
      for (const l of scar.labels) a.push('--remove-label', l)
      if (scar.repo) a.push('--repo', scar.repo)
      try { gh(a) } catch (e) { console.warn(`[verify-reminders] could not clear ${scar.labels.join('+')} on ${displayRef(scar.repo, scar.number)}: ${e.message.split('\n')[0]}`) }
    }
  }

  // ── Silent-drop guards (#966) ─────────────────────────────────────────────────
  // This system exists so a verification is never forgotten, so both ways a line can go dark must be
  // observable. Warn-only (never mutating, never fatal) — a run that drops a real reminder must not
  // look identical to a run with nothing to do.
  for (const iss of considered) {
    for (const q of findQuotedVerifyAfterBoxes(iss.body)) {
      console.warn(`[verify-reminders] ${displayRef(iss.repo, iss.number)}: an UNCHECKED verify-after box is nested in a blockquote (line ${q.lineIndex + 1}) — it will NEVER fire. Unquote it: ${truncate(q.text, 100)}`)
    }
    for (const bad of findInvalidVerifyAfterDates(iss.body)) {
      console.warn(`[verify-reminders] ${displayRef(iss.repo, iss.number)}: verify-after date '${bad.date}' (line ${bad.lineIndex + 1}) is not a valid calendar date — it will never ping. Fix the date.`)
    }
  }

  // ── #873 Tier-A auto-verify pass ──────────────────────────────────────────────
  // Independent of the due/weekly ping cadence: evaluate every OPEN verify-after line that carries a
  // machine-checkable `assert:` clause, and on PASS close the loop (tick + comment + drop verify-blocked
  // / close). Runs on every daily invocation so an issue drains the moment its production signal is met,
  // not only after its date. The trusted-author filter above already gates which issues reach here.
  const autoVerified = []
  for (const iss of considered) {
    const withAssert = pairVerifyAssertions(iss.body).filter((it) => it.assertion)
    if (withAssert.length === 0) continue
    const evaluated = []
    for (const it of withAssert) {
      const r = await runAssertion(it.assertion, { timeoutMs: 20_000 }) // daily job — latency-tolerant
      evaluated.push({ lineIndex: it.lineIndex, status: r.status, selector: it.assertion.selector, actual: r.actual })
    }
    const plan = planIssueAutoVerify(iss.body, evaluated)
    if (plan.passCount > 0) {
      autoVerified.push({ number: iss.number, repo: iss.repo, ref: displayRef(iss.repo, iss.number), title: iss.title, plan, evaluated })
    }
  }
  // Lines auto-verified this run must NOT also ping (they're being ticked below).
  const tickedKeys = new Set(autoVerified.flatMap((a) => a.plan.ticked.map((li) => `${a.repo || ''}#${a.number}#${li}`)))

  const due = []
  for (const iss of considered) {
    for (const { date, note, lineIndex } of pairVerifyAssertions(iss.body)) {
      if (!isValidIsoDate(date)) continue // #873 review #2: pairVerifyAssertions doesn't reject 2026-02-30 (Date rolls it over); keep the #541 guard
      if (tickedKeys.has(`${iss.repo || ''}#${iss.number}#${lineIndex}`)) continue
      if (shouldFire(date, today)) {
        due.push({
          number: iss.number,
          repo: iss.repo,
          ref: displayRef(iss.repo, iss.number),
          title: iss.title,
          date,
          note,
          lineIndex,
          overdueDays: daysSinceDue(date, today),
        })
      }
    }
  }

  // Escalation split (#1206) — the join lives in splitEscalatedDue so it is pure and testable.
  const { routineDue, escalatedNow } = splitEscalatedDue(due, findOverdueEscalations(considered, today, tickedKeys))

  // Stale `verify-overdue` labels (#966). Derived from the verify-after DATES, not from `due` — see
  // findStaleOverdueLabels: `due` is weekly-throttled, so "not due today" ≠ "not overdue". Placed after
  // the auto-verify scan (so `tickedKeys` is known) and before the early returns below: a run with
  // nothing to ping is exactly when a previous ping's label needs clearing.
  const toClearOverdue = findStaleOverdueLabels(considered, today, tickedKeys)

  if (autoVerified.length === 0 && due.length === 0 && toClearOverdue.length === 0) {
    console.log(`[verify-reminders] ${today}: nothing to auto-verify, ping, or unlabel.`)
    return
  }
  if (autoVerified.length) console.log(`[verify-reminders] ${today}: ${autoVerified.length} auto-verifiable → ${autoVerified.map((a) => a.ref).join(', ')}`)
  if (due.length) console.log(`[verify-reminders] ${today}: ${due.length} due to ping → ${due.map((d) => d.ref).join(', ')}`)
  if (toClearOverdue.length) console.log(`[verify-reminders] ${today}: ${toClearOverdue.length} stale verify-overdue → ${toClearOverdue.map((i) => displayRef(i.repo, i.number)).join(', ')}`)

  if (dryRun) {
    if (autoVerified.length) {
      console.log('[verify-reminders] --dry-run: would AUTO-VERIFY:\n' + JSON.stringify(
        autoVerified.map((a) => ({ ref: a.ref, pass: a.plan.passCount, dropLabel: a.plan.dropLabel, close: a.plan.close, ticked: a.plan.ticked })), null, 2))
    }
    if (routineDue.length) console.log('[verify-reminders] --dry-run: would PING:\n' + JSON.stringify(routineDue, null, 2))
    if (escalatedNow.length) console.log('[verify-reminders] --dry-run: would ESCALATE (needs a disposition):\n' + JSON.stringify(escalatedNow, null, 2))
    if (toClearOverdue.length) console.log('[verify-reminders] --dry-run: would CLEAR verify-overdue on: ' + toClearOverdue.map((i) => displayRef(i.repo, i.number)).join(', '))
    return
  }

  // Apply auto-verify FIRST (each issue best-effort; a failure must not abort the run).
  for (const a of autoVerified) {
    try {
      const editArgs = ['issue', 'edit', String(a.number), '--body', a.plan.newBody]
      if (a.repo) editArgs.push('--repo', a.repo)
      gh(editArgs)
      // Label removal is a SEPARATE best-effort call (#873 review #3): bundling `--remove-label` into
      // the body edit means a missing label (e.g. a sibling-repo issue that never carried it) fails the
      // whole edit and drops the tick. Keep them independent so the tick + comment always land.
      if (a.plan.dropLabel) {
        const labelArgs = ['issue', 'edit', String(a.number), '--remove-label', 'verify-blocked']
        if (a.repo) labelArgs.push('--repo', a.repo)
        try { gh(labelArgs) } catch (e) { console.warn(`[verify-reminders] could not drop verify-blocked on ${a.ref}: ${e.message.split('\n')[0]}`) }
      }
      const evidence = a.evaluated.filter((e) => e.status === 'pass')
        .map((e) => `\`${e.selector}\` = ${truncate(JSON.stringify(e.actual), 60)}`).join('; ')
      const note = a.plan.dropLabel ? ' + dropped `verify-blocked`' : ''
      const commentArgs = ['issue', 'comment', String(a.number), '--body',
        `✅ Auto-verified ${today} — production signal satisfied: ${evidence}. Ticked ${a.plan.passCount} verify-after box(es)${note}. (#873 Tier-A)`]
      if (a.repo) commentArgs.push('--repo', a.repo)
      gh(commentArgs)
      if (a.plan.close) {
        const closeArgs = ['issue', 'close', String(a.number)]
        if (a.repo) closeArgs.push('--repo', a.repo)
        gh(closeArgs)
      }
      console.log(`[verify-reminders] auto-verified ${a.ref} (${a.plan.passCount} pass${a.plan.close ? ', closed' : a.plan.dropLabel ? ', label dropped' : ''})`)
    } catch (e) {
      console.warn(`[verify-reminders] auto-verify failed for ${a.ref}: ${e.message.split('\n')[0]}`)
    }
  }

  // Clear stale `verify-overdue` (#966). AFTER the auto-verify pass, so an issue that was ticked (and
  // possibly closed) moments ago loses the label in the same run — that's #857's exact path. Removing a
  // label from a closed issue is fine. Best-effort: a label failure must never abort the run.
  for (const iss of toClearOverdue) {
    const a = ['issue', 'edit', String(iss.number), '--remove-label', 'verify-overdue']
    if (iss.repo) a.push('--repo', iss.repo)
    try { gh(a) } catch (e) { console.warn(`[verify-reminders] could not clear verify-overdue on ${displayRef(iss.repo, iss.number)}: ${e.message.split('\n')[0]}`) }
  }

  if (due.length === 0) {
    console.log(`[verify-reminders] no reminders to ping (auto-verify / unlabel only).`)
    return
  }

  const webhook = process.env.DISCORD_WEBHOOK_URL
  if (!webhook) {
    console.error('[verify-reminders] DISCORD_WEBHOOK_URL not set — cannot send. (Add it as a repo Actions secret.)')
    process.exit(1)
  }
  await postDiscord(webhook, routineDue, escalatedNow)
  // Board visibility: label each fired issue so issue-triage sees what's past its verify date.
  // Best-effort — a label failure must not fail the run after a successful Discord send. Keyed by
  // repo+number so a sibling-repo issue is labeled in its own repo (and the label must exist there).
  const seen = new Set()
  for (const { number, repo } of due) {
    const key = `${repo || ''}#${number}`
    if (seen.has(key)) continue
    seen.add(key)
    const args = ['issue', 'edit', String(number), '--add-label', 'verify-overdue']
    if (repo) args.push('--repo', repo)
    try {
      gh(args)
    } catch (e) {
      console.warn(`[verify-reminders] could not label ${displayRef(repo, number)}: ${e.message.split('\n')[0]}`)
    }
  }
  console.log('[verify-reminders] posted to Discord + labeled verify-overdue.')
}

// Only run main when executed directly (so importing the helpers in the test has no side effects).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[verify-reminders] failed:', e)
    process.exit(1)
  })
}

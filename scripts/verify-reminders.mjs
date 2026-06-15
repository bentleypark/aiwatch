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

// Matches a `verify-after 2026-09-01` token anywhere on a line; captures the date + the rest of the
// line as a free-form note. Case-insensitive; `after` may be followed by space, `:` or `-`.
const VERIFY_RE = /verify-after[\s:-]+(\d{4}-\d{2}-\d{2})([^\n]*)/gi

/** True only for a real calendar date (rejects 2026-02-30, which Date would silently roll over). */
export function isValidIsoDate(s) {
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Extract every {date, note} pair from an issue body. Calendar-invalid dates are skipped. */
export function parseVerifyAfter(body) {
  const out = []
  if (!body) return out
  for (const m of body.matchAll(VERIFY_RE)) {
    if (!isValidIsoDate(m[1])) continue
    const note = m[2].replace(/^[\s—–:*_)·-]+/, '').replace(/\*+$/, '').trim()
    out.push({ date: m[1], note })
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

async function postDiscord(webhook, items) {
  const lines = items.map((it) => {
    const when = it.overdueDays > 0 ? `due ${it.date}, ${it.overdueDays}d overdue` : 'due today'
    return `• **${it.ref || `#${it.number}`}** ${it.title}\n  → ${it.note || 'verify production data'} _(${when})_`
  })
  const body = {
    embeds: [{
      title: '🔔 Production-data verification due',
      description: `${items.length} item(s) need a production-data check now:\n\n${lines.join('\n')}`,
      color: 0xfee75c,
      footer: { text: 'AIWatch · verify-after reminders (#541)' },
    }],
  }
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
  const args = ['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,body,author']
  if (repo) args.push('--repo', repo)
  try {
    const issues = JSON.parse(gh(args))
    return issues.map((i) => ({ ...i, repo }))
  } catch (e) {
    console.warn(`[verify-reminders] could not list issues for ${repo || 'current repo'} (skipping): ${e.message.split('\n')[0]}`)
    return []
  }
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

  const due = []
  for (const iss of considered) {
    for (const { date, note } of parseVerifyAfter(iss.body)) {
      if (shouldFire(date, today)) {
        due.push({
          number: iss.number,
          repo: iss.repo,
          ref: displayRef(iss.repo, iss.number),
          title: iss.title,
          date,
          note,
          overdueDays: daysSinceDue(date, today),
        })
      }
    }
  }

  if (due.length === 0) {
    console.log(`[verify-reminders] ${today}: nothing due.`)
    return
  }
  console.log(`[verify-reminders] ${today}: ${due.length} due → ${due.map((d) => d.ref).join(', ')}`)

  if (dryRun) {
    console.log('[verify-reminders] --dry-run: would post:\n' + JSON.stringify(due, null, 2))
    return
  }

  const webhook = process.env.DISCORD_WEBHOOK_URL
  if (!webhook) {
    console.error('[verify-reminders] DISCORD_WEBHOOK_URL not set — cannot send. (Add it as a repo Actions secret.)')
    process.exit(1)
  }
  await postDiscord(webhook, due)
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

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
 * a label. Default to the repo OWNER (from GITHUB_REPOSITORY, always set in Actions) plus an explicit
 * VERIFY_TRUSTED_AUTHORS allow-list (comma-separated). Empty set (e.g. local dev with neither env) →
 * the caller does NOT filter, so the maintainer can test against their own board.
 */
export function parseTrustedAuthors(env = process.env) {
  const explicit = (env.VERIFY_TRUSTED_AUTHORS || '').split(',').map((s) => s.trim()).filter(Boolean)
  const owner = (env.GITHUB_REPOSITORY || '').split('/')[0].trim()
  return new Set([...explicit, ...(owner ? [owner] : [])])
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
    return `• **#${it.number}** ${it.title}\n  → ${it.note || 'verify production data'} _(${when})_`
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

async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'
  const today = todayUTC()
  const issues = JSON.parse(gh(['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,body,author']))

  // #541 abuse-gate (public repo): only honor verify-after lines from trusted authors. Empty trusted
  // set (local dev with no GITHUB_REPOSITORY/override) → no filter, so the maintainer can test.
  const trusted = parseTrustedAuthors()
  const considered = trusted.size > 0 ? issues.filter((i) => trusted.has(i.author?.login)) : issues

  const due = []
  for (const iss of considered) {
    for (const { date, note } of parseVerifyAfter(iss.body)) {
      if (shouldFire(date, today)) {
        due.push({ number: iss.number, title: iss.title, date, note, overdueDays: daysSinceDue(date, today) })
      }
    }
  }

  if (due.length === 0) {
    console.log(`[verify-reminders] ${today}: nothing due.`)
    return
  }
  console.log(`[verify-reminders] ${today}: ${due.length} due → ${due.map((d) => `#${d.number}`).join(', ')}`)

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
  // Best-effort — a label failure must not fail the run after a successful Discord send.
  for (const number of [...new Set(due.map((d) => d.number))]) {
    try {
      gh(['issue', 'edit', String(number), '--add-label', 'verify-overdue'])
    } catch (e) {
      console.warn(`[verify-reminders] could not label #${number}: ${e.message}`)
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

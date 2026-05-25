#!/usr/bin/env node
// Summarize .claude/hook-audit.jsonl — the audit log written by the workflow-gate
// hooks (#415 Phase 2). The point: see whether the gates change behavior.
//   - how often each hook fires, by decision
//   - last-7-days totals + a per-day trend over the last 14 days
//   - the most recent N entries
//
// Run:  node scripts/hook-audit-summary.mjs [--last N] [--days D]
// Defaults: --last 15, --days 14. The log is gitignored; absent log = "nothing
// logged yet" (not an error).

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG = resolve(HERE, '..', '.claude', 'hook-audit.jsonl')

const argv = process.argv.slice(2)
const intArg = (flag, def) => {
  const i = argv.indexOf(flag)
  if (i === -1 || i === argv.length - 1) return def
  const n = Number(argv[i + 1])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def
}
const LAST_N = intArg('--last', 15)
const DAYS = intArg('--days', 14)

if (!existsSync(LOG)) {
  console.log(`No hook audit log yet (${LOG}).`)
  console.log('Hooks write to it on each fire — run something that triggers a git mutation or end a turn, then re-run this.')
  process.exit(0)
}

const lines = readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim())
const entries = []
for (const l of lines) {
  try {
    const e = JSON.parse(l)
    if (e && typeof e === 'object') entries.push(e)
  } catch { /* skip malformed line */ }
}

if (entries.length === 0) {
  console.log(`Hook audit log is present but has no parseable entries (${LOG}).`)
  process.exit(0)
}

const dayKey = (ts) => (typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : 'unknown')
const todayUTC = new Date().toISOString().slice(0, 10)
const cutoff7 = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)

// By hook -> by decision count
const byHook = {}
for (const e of entries) {
  const h = e.hook ?? 'unknown'
  const d = e.decision ?? 'unknown'
  byHook[h] ??= {}
  byHook[h][d] = (byHook[h][d] ?? 0) + 1
}

// Last-7-days totals (by decision, across hooks)
const last7 = entries.filter((e) => dayKey(e.ts) >= cutoff7)
const last7ByDecision = {}
for (const e of last7) {
  const d = e.decision ?? 'unknown'
  last7ByDecision[d] = (last7ByDecision[d] ?? 0) + 1
}

// Per-day trend (last DAYS days). Columns track the decisions actually emitted:
// git-mutation-gate → warn (now always on a git mutation; `pass` is legacy, kept
// for historical rows pre-#415-gap-fix); stop-nag-gate → block | skip | clean;
// workflow-gates-reminder → inject (UserPromptSubmit, fires every turn).
const dayCounts = {}
for (const e of entries) {
  const k = dayKey(e.ts)
  if (k === 'unknown') continue
  dayCounts[k] = dayCounts[k] ?? { total: 0, warn: 0, block: 0, skip: 0, pass: 0, clean: 0, inject: 0, other: 0 }
  dayCounts[k].total++
  const d = e.decision
  if (d === 'warn') dayCounts[k].warn++
  else if (d === 'block') dayCounts[k].block++
  else if (d === 'skip') dayCounts[k].skip++
  else if (d === 'pass') dayCounts[k].pass++
  else if (d === 'clean') dayCounts[k].clean++
  else if (d === 'inject') dayCounts[k].inject++
  else dayCounts[k].other++
}
const days = []
for (let i = DAYS - 1; i >= 0; i--) {
  days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
}

const out = []
out.push(`Hook audit summary — ${LOG}`)
out.push(`Entries: ${entries.length} total · ${last7.length} in the last 7 days · as of ${todayUTC} (UTC)`)
out.push('')
out.push('By hook × decision:')
for (const [h, dec] of Object.entries(byHook)) {
  const parts = Object.entries(dec).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`)
  out.push(`  ${h}: ${parts.join('  ')}`)
}
out.push('')
out.push('Last 7 days by decision:')
const dprint = Object.entries(last7ByDecision).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`)
out.push(`  ${dprint.length ? dprint.join('  ') : '(none)'}`)
out.push('')
out.push(`Per-day (last ${DAYS} days)  [total | warn | block | skip | pass | clean | inject]:`)
for (const d of days) {
  const c = dayCounts[d]
  if (!c) { out.push(`  ${d}   0`); continue }
  out.push(`  ${d}   ${c.total} | ${c.warn} | ${c.block} | ${c.skip} | ${c.pass} | ${c.clean} | ${c.inject}`)
}
out.push('')
out.push(`Most recent ${LAST_N}:`)
for (const e of entries.slice(-LAST_N)) {
  out.push(`  ${e.ts ?? '?'}  ${e.hook ?? '?'}  ${e.decision ?? '?'}  ${e.note ? '— ' + e.note : ''}`)
}
console.log(out.join('\n'))

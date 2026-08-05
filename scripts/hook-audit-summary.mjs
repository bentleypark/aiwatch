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
// Default to the real gitignored log; HOOK_AUDIT_LOG overrides it (used by the unit test to point at
// a temp fixture without touching the real log).
const LOG = process.env.HOOK_AUDIT_LOG ? resolve(process.env.HOOK_AUDIT_LOG) : resolve(HERE, '..', '.claude', 'hook-audit.jsonl')

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

// #415 effectiveness: distinguish actual VIOLATIONS from preventive telemetry.
// Most decisions are telemetry, not evidence the gate caught a violation:
//   - warn (git-mutation): a step-3.5 REMINDER fires on every git mutation — not a violation,
//     count scales with workload, so its trend is meaningless as an effectiveness signal.
//   - inject/clean/pass/skip: pure telemetry (gate is on / turn ended cleanly).
// Only two signals mean a real workflow violation was intercepted:
//   - block (stop-nag): the assistant tried to end on an auto-proceed nag → blocked.
//   - any entry whose note carries `no_verify=1` (git-mutation): --no-verify/--no-gpg-sign
//     was on a commit/push, which CLAUDE.md forbids unless the user asked.
// This count is a floor, not a total: see the step-3.5 section below for what it still cannot see.
const isViolation = (e) => {
  if (e.decision === 'block') return true
  if (typeof e.note === 'string' && /\bno_verify=1\b/.test(e.note)) return true
  // #657 step-3.5 hard gate (step35-verify-gate): a `deny` blocked a real attempt — an intercepted
  // violation — EXCEPT `fail-closed`, which is a gate-HEALTH signal (transcript unreadable), not a
  // caught violation. NOTE a step35 commit-deny is ALSO where false-positives live (a real user
  // confirmation the parser missed); see the dedicated step35 section below for the caveat.
  if (e.hook === 'step35-verify-gate' && e.decision === 'deny' && e.note !== 'fail-closed') return true
  // NOTE `review-loop-gate` (#1150) never emits a `deny` — it is telemetry, not a gate, for the reasons
  // recorded in its own header. It contributes nothing to this tally; its output is read by the 🔁 section.
  return false
}

const dayKey = (ts) => (typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : 'unknown')
const todayUTC = new Date().toISOString().slice(0, 10)
const cutoff7 = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)

// Computed once and shared by the per-day trend and the tally.
const violations = entries.filter(isViolation)
const violationSet = new Set(violations)

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
  dayCounts[k] = dayCounts[k] ?? { total: 0, warn: 0, block: 0, deny: 0, skip: 0, pass: 0, clean: 0, inject: 0, other: 0, violations: 0 }
  dayCounts[k].total++
  const d = e.decision
  // `deny` is step35-verify-gate-only by current convention (no other hook emits it). If a future
  // hook logs `deny`, this column conflates them — the hook-scoped 🚦 block below stays correct.
  if (d === 'warn') dayCounts[k].warn++
  else if (d === 'block') dayCounts[k].block++
  else if (d === 'deny') dayCounts[k].deny++
  else if (d === 'skip') dayCounts[k].skip++
  else if (d === 'pass') dayCounts[k].pass++
  else if (d === 'clean') dayCounts[k].clean++
  else if (d === 'inject') dayCounts[k].inject++
  else dayCounts[k].other++
  if (violationSet.has(e)) dayCounts[k].violations++
}

const violationsLast7 = violations.filter((e) => dayKey(e.ts) >= cutoff7)
const violByKind = {}
for (const e of violations) {
  let kind
  if (e.hook === 'step35-verify-gate') {
    const n = String(e.note ?? '')
    // commit:<reason> kept whole (no-confirmation vs no-edit-event matter); others by their prefix.
    kind = 'step35:' + (n.startsWith('commit:') ? n.slice('commit:'.length) : n.split(':')[0])
  } else {
    kind = e.decision === 'block' ? 'nag-blocked' : 'no-verify-attempt'
  }
  violByKind[kind] = (violByKind[kind] ?? 0) + 1
}

// #657 step-3.5 gate — dedicated breakdown. A hard gate's denies need their own view because (a) a
// deny can be EITHER an intercepted step-3.5 skip OR a false-positive (a real user confirmation the
// CONFIRM_RE/parser missed — check whether the NEXT turn was an override/confirmation), and (b)
// `fail-closed` is a gate-health metric (should trend to ~0; nonzero = transcript read breaking).
const step35 = entries.filter((e) => e.hook === 'step35-verify-gate')
const step35Deny = step35.filter((e) => e.decision === 'deny')
const step35ByReason = {}
for (const e of step35Deny) {
  const r = String(e.note ?? 'unknown')
  step35ByReason[r] = (step35ByReason[r] ?? 0) + 1
}
const step35FailClosed = step35Deny.filter((e) => e.note === 'fail-closed').length
const step35Pass = step35.filter((e) => e.decision === 'pass').length
// A `pass` with note `commit:override` = the user had to say "검증 생략" to lift the gate on a real
// UI/Edge commit → the strongest false-positive proxy (the gate fired on already-verified work).
const step35Override = step35.filter((e) => e.decision === 'pass' && e.note === 'commit:override').length

// #1150 review-loop telemetry — its own section, because it is the deliverable rather than a side effect.
// The hook never denies (the deny designs that were measured and dropped are in
// docs/reference/workflow-hooks.md), so there is nothing here to count as an intercepted violation. What it records is what the review loop
// actually did: the round each reviewer spawn declared, or that it declared none.
const revloop = entries.filter((e) => e.hook === 'review-loop-gate')
const revloopFailOpen = {}
const revloopRounds = {}
const revloopBySession = {}
let revloopUndeclared = 0
for (const e of revloop) {
  const n = String(e.note ?? '')
  if (n.startsWith('fail-open:')) {
    // Bucket on the whole reason, not its first colon-segment, so a future reason carrying a detail
    // (an errno, a count) stays distinguishable from its siblings rather than merging with them.
    const why = n.slice('fail-open:'.length)
    revloopFailOpen[why] = (revloopFailOpen[why] ?? 0) + 1
    continue
  }
  const s = /:s=(\S+)/.exec(n)?.[1]
  if (s) revloopBySession[s] = (revloopBySession[s] ?? 0) + 1
  const m = /^round-(\d+)/.exec(n)
  if (m) revloopRounds[m[1]] = (revloopRounds[m[1]] ?? 0) + 1
  else revloopUndeclared++ // `round-none` — the prompt tracked no round
}
// Spawns per session is the depth proxy that needs NO cooperation from the prompt. It matters because the
// declared round is entirely self-reported, and `/pr-review-toolkit:review-pr` — the entry point CLAUDE.md
// step 5 names — never tells the caller to state one: a loop driven straight through it records
// `round-none` throughout, so the histogram is blind in exactly the runaway case, where "stopped tracking
// rounds" and "ran long" co-occur. A session's spawn count still rises with every round.
const revloopMaxPerSession = Math.max(0, ...Object.values(revloopBySession))
const revloopFailOpenTotal = Object.values(revloopFailOpen).reduce((a, b) => a + b, 0)
const revloopRecorded = revloop.length - revloopFailOpenTotal
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
// The effectiveness signal (#415): real violations intercepted, separated from preventive
// telemetry. A LOW/declining violation count is the goal — telemetry (warn/inject) is not.
out.push('⚖️  Violations intercepted (real signal — nag block + --no-verify + step-3.5 deny; still UNDERCOUNTS — a step-3.5 skip the gate misses is invisible):')
const vkind = Object.entries(violByKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`)
out.push(`  ${violations.length} total · ${violationsLast7.length} in last 7d${vkind.length ? '  (' + vkind.join(', ') + ')' : ''}`)
out.push('')
out.push(`Per-day (last ${DAYS} days)  [total | violations | warn | block | deny | skip | pass | clean | inject]:`)
for (const d of days) {
  const c = dayCounts[d]
  if (!c) { out.push(`  ${d}   0`); continue }
  out.push(`  ${d}   ${c.total} | ${c.violations} | ${c.warn} | ${c.block} | ${c.deny} | ${c.skip} | ${c.pass} | ${c.clean} | ${c.inject}`)
}
out.push('')
// #657 step-3.5 hard gate — its own block (denies are ambiguous: intercept vs false-positive).
if (step35.length) {
  out.push('🚦 step-3.5 hard gate (#657):')
  const reasons = Object.entries(step35ByReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`)
  out.push(`  ${step35Deny.length} deny · ${step35Pass} pass (UI/Edge commit allowed)${reasons.length ? '  — deny: ' + reasons.join(', ') : ''}`)
  out.push(`  ⚠️ a commit:* deny is EITHER an intercepted step-3.5 skip OR a false-positive — check if the NEXT turn was an override/confirmation (a genuine-but-unmatched reply = tune CONFIRM_RE).`)
  if (step35Override) out.push(`  ⚑ override=${step35Override} pass(es) needed a manual step-3.5 override — the strongest false-positive proxy. A rising override rate means the gate fires on work the user had already checked → tune CONFIRM_RE or soften.`)
  if (step35FailClosed) out.push(`  ❗ fail-closed=${step35FailClosed} — gate-health, NOT a violation: the transcript read is breaking. Should be ~0; investigate if it trends up.`)
  out.push('')
}
// #1150 review-loop telemetry. This hook does not gate, so read this section as a record of the loop,
// not as an enforcement tally: how deep the rounds went, and how often a round went untracked.
if (revloop.length) {
  out.push('🔁 review-loop telemetry (#1150):')
  out.push(`  ${revloopRecorded} reviewer spawn(s) recorded across ${Object.keys(revloopBySession).length} session(s) · busiest session ${revloopMaxPerSession} spawn(s)`)
  const hist = Object.entries(revloopRounds).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `R${k}=${v}`)
  // Per SPAWN — one round spawns several reviewers — and from the round each prompt DECLARED. There is no
  // independent counter, so a deep tail here means prompts SAID they were deep, which is the signal a
  // runaway loop leaves behind.
  if (hist.length) out.push(`  first round number per spawn: ${hist.join('  ')}`)
  // A prompt that declares no round leaves no round to report. That count is the instrument's blind rate:
  // if it dwarfs the histogram, the loop ran without tracking rounds at all — the condition under which
  // every runaway loop before this hook had to be reconstructed from memory afterwards.
  if (revloopUndeclared) out.push(`  ⚑ no round declared=${revloopUndeclared} spawn(s) — the loop was not tracking rounds in those spawns, so nothing here describes their depth.`)
  if (revloopFailOpenTotal) {
    const fo = Object.entries(revloopFailOpen).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`)
    out.push(`  ❗ fail-open=${revloopFailOpenTotal} — instrument health, not a finding: the hook recorded nothing for that spawn (${fo.join(', ')}). Should be ~0; a rising count means the telemetry is blind, not that the loop is healthy.`)
  }
  out.push('')
}
out.push(`Most recent ${LAST_N}:`)
for (const e of entries.slice(-LAST_N)) {
  out.push(`  ${e.ts ?? '?'}  ${e.hook ?? '?'}  ${e.decision ?? '?'}  ${e.note ? '— ' + e.note : ''}`)
}
console.log(out.join('\n'))

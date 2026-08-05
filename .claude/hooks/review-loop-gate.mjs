#!/usr/bin/env node
// #1150 — review-loop telemetry (PreToolUse, matcher `Task|Agent`).
//
// WHAT IT DOES. On every `pr-review-toolkit:*` subagent spawn it records one audit line: the round the
// prompt declares (or that it declared none) plus the session. Nothing else. It never blocks.
// `npm run hook-audit`'s 🔁 section turns those lines into a round histogram and an
// undeclared-round count, so a review loop that ran long — or that stopped tracking rounds at all — is
// visible after the fact instead of being reconstructed from memory.
//
// WHY IT DOES NOT ENFORCE. #1150 set out to DENY a non-convergent review round, so the twice-in-a-row
// causal stop trigger (#1124) could actually fire. Every deny design was built and replayed over this
// project's own transcripts; each either denied work that already complied or could not discriminate at
// all, because "did this prompt say what it fixed, and did that fix cause this finding?" is a judgement
// about CONTENT and every design measured PHRASING as a proxy for it. The designs and what each
// measurement showed are recorded once, in `docs/reference/workflow-hooks.md`; enforcement stays where
// the judgement lives, in `ship-issue` steps 5-6.
//
// Consequences worth knowing: there is no deny path, so no override phrase, and nothing here can block a
// review. An agent that never writes `ROUND N` produces `round-none` lines rather than escaping a gate —
// and that count is itself the signal, so it is reported rather than hidden.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Audit logging (read by `npm run hook-audit`'s 🔁 review-loop section) ─────
// Same JSONL schema as _audit.sh / step35 ({ts,hook,decision,note}).
// Resolved relative to this file, exactly like every other hook and like `hook-audit-summary.mjs`'s
// reader — so a session rooted at a worktree writes to that worktree's log and `npm run hook-audit` run
// there shows it. Redirecting only this hook to the main checkout would make the record outlive
// `git worktree remove`, but it would also leave the operator IN the worktree — where CLAUDE.md says issue
// work happens — reading a telemetry section that is silently empty while the data sits elsewhere, which
// is the exact all-clear-by-omission failure this telemetry exists to prevent. One inconsistent writer is
// worse than a shared limitation, and the limitation is not new: every hook's lines have always lived and
// died with their checkout.
const AUDIT_FILE = process.env.HOOK_AUDIT_LOG
  ? path.resolve(process.env.HOOK_AUDIT_LOG)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hook-audit.jsonl')

export function auditLine(decision, note = '', ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
  const esc = String(note).replace(/\p{Cc}+/gu, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `{"ts":"${ts}","hook":"review-loop-gate","decision":"${decision}","note":"${esc}"}`
}
function audit(decision, note = '') {
  try {
    fs.appendFileSync(AUDIT_FILE, auditLine(decision, note) + '\n')
  } catch (e) {
    // This write IS the deliverable — a swallowed failure would leave the loop unobserved while the hook
    // still appears to run.
    try { process.stderr.write(`review-loop-gate: audit write failed (${e?.code ?? e})\n`) } catch { /* nothing left */ }
  }
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** The subagent-type prefix that marks a review round. Exported so a test can pin it against the review
 *  command this repo documents, so the two cannot drift WITHIN this repo. An upstream re-namespace (cf.
 *  #920) is NOT caught: a non-matching spawn exits before any audit line is written, so it would surface
 *  only as a `round-*` count that quietly drops to zero. */
export const REVIEW_AGENT_PREFIX = 'pr-review-toolkit'

export function isPrReviewSpawn(toolInput) {
  const st = toolInput?.subagent_type
  return typeof st === 'string' && st.startsWith(REVIEW_AGENT_PREFIX)
}

// The round a prompt declares: `ROUND 4`, `round #4`, `round-4`, `라운드 4`, `4라운드`. The `(?!\d)` on the
// two prefix branches stops `round 1150` reading as 11; the `(?<![\d#])` on the suffix branch stops
// `이슈 1150 라운드 3` reading as 50. Nothing here can cause a false deny — there is no deny — so the
// separator class is deliberately generous: a missed declaration silently becomes a `round-none` line,
// which under-reports the loop.
const DECLARED_ROUND_RE = /\bround[\s#-]*(\d{1,2})(?!\d)|라운드[\s#-]*(\d{1,2})(?!\d)|(?<![\d#])(\d{1,2})\s*라운드/i

/** The round the prompt claims, or 0 if it claims none.
 *  Uses the FIRST match: a prompt that recites an earlier round before declaring its own reads the
 *  earlier number. That mislabels the line but costs nothing else, which is why it is not worth a
 *  cleverer parse — every alternative considered mis-declared some other real phrasing. */
export function declaredRound(prompt) {
  const m = DECLARED_ROUND_RE.exec(String(prompt ?? ''))
  if (!m) return 0
  const n = Number(m[1] ?? m[2] ?? m[3])
  return Number.isFinite(n) ? n : 0
}

/** The session id for the audit note — the first 8 characters of the transcript filename. The 🔁 section
 *  groups by it, so one loop's several reviewers are attributable to that loop. */
export function sessionId(transcriptPath) {
  return path.basename(String(transcriptPath ?? ''), '.jsonl').slice(0, 8) || 'unknown'
}

/** The audit note for a spawn. `round-none` is a first-class outcome, not an error: it means the prompt
 *  tracked no round, which is exactly what the 🔁 section reports. */
export function noteFor(prompt, transcriptPath) {
  const round = declaredRound(prompt)
  return `round-${round || 'none'}:s=${sessionId(transcriptPath)}`
}

// ── CLI (hook entry) ─────────────────────────────────────────────────────────

// Recording nothing is the only failure mode left, so it names itself. These are instrument health, and
// `hook-audit-summary.mjs` counts them separately from the rounds — a rising count means the telemetry is
// blind, not that the loop is healthy.
function failOpen(why) { audit('pass', `fail-open:${why}`); process.exit(0) }

function main() {
  let input
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { failOpen('no-stdin') }
  // A payload without `tool_input` is a schema drift, and it must NOT fall through to the silent
  // not-a-review-spawn exit: that would make a renamed harness key indistinguishable from ordinary
  // non-review traffic, and the instrument would go permanently blind with nothing in the log to say so.
  // (`JSON.parse` also succeeds on the scalar `null`, which this same guard catches before any deref.)
  if (input === null || typeof input !== 'object' || !('tool_input' in input)) failOpen('no-tool-input')
  const ti = input.tool_input ?? {}
  if (!isPrReviewSpawn(ti)) process.exit(0) // not a pr-review spawn → not our call

  try {
    // A missing `prompt` is a harness schema drift. Keyed on `prompt` ALONE, with no fallback to
    // `description`: that is a required Agent-tool param present on every real spawn, so a fallback would
    // silently record the round of a 3-5 word summary and report a drift as data.
    if (typeof ti.prompt !== 'string') failOpen('no-prompt-field')
    audit('pass', noteFor(ti.prompt, input.transcript_path))
    process.exit(0)
  } catch { failOpen('record-error') }
}

/** True when this file is the process entry point. `import.meta.url === \`file://${process.argv[1]}\``
 *  is WRONG: a path containing a space or `#` percent-encodes in the URL and never compares equal, so the
 *  hook exits 0 having done nothing — no audit line, no stderr. For an instrument whose only failure mode
 *  is silence that is the worst case. Compare real paths instead. */
function isEntryPoint() {
  try { return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1] ?? '') } catch { return false }
}

if (isEntryPoint()) main()

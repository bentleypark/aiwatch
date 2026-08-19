#!/usr/bin/env node
// #1150 — review-loop telemetry (PreToolUse, matcher `Task|Agent`).
//
// WHAT IT DOES. On every `pr-review-toolkit:*` subagent spawn it records one audit line: the round the
// prompt declares (or that it declared none), the session, and the branch (#1245). Nothing else. It
// never blocks.
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
// reader. In practice that means ONE log, in the main checkout: settings invokes the hook through
// `$CLAUDE_PROJECT_DIR`, which resolves to the main checkout even for a worktree-isolated session, so a
// worktree session's lines land there too. (#1245 measured this — no worktree has ever held a
// `hook-audit.jsonl`. An earlier version of this comment claimed the opposite.) A single log is the
// right outcome for a record that has to span sessions and outlive `git worktree remove`; what it costs
// is that the log's location says nothing about WHICH branch a line came from, which is why the branch
// is derived from the session's cwd instead.
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

/** The repo root for `cwd` — the nearest ancestor holding a `.git`. The session's cwd is the only thing
 *  in the payload that tracks WHICH checkout the work is in (`step35-verify-gate.mjs` reads it for the
 *  same reason), and cwd can be a subdirectory, so this walks up rather than testing one level.
 *  Returns null when nothing on the path has a `.git`, so the caller can fall back rather than guess. */
export function repoRootFrom(cwd) {
  // An absent cwd must NOT fall through to `path.resolve('')` → `process.cwd()`: the hook's own working
  // directory is whatever launched it, so that would report a branch nobody chose while looking correct.
  // Returning null hands the decision back to the caller's explicit fallback.
  if (typeof cwd !== 'string' || cwd === '') return null
  try {
    let dir = path.resolve(cwd)
    for (let i = 0; i < 64; i++) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir
      const up = path.dirname(dir)
      if (up === dir) return null
      dir = up
    }
  } catch { /* fall through */ }
  return null
}

/** The branch of the checkout at `root`, read from git's own files rather than by spawning git — this
 *  hook runs on every matching tool call, and a subprocess per spawn is a cost the record does not need.
 *
 *  Two layouts, because issue work happens in worktrees (CLAUDE.md "Parallel sessions"): a normal
 *  checkout has `.git/` as a DIRECTORY, a worktree has `.git` as a FILE holding `gitdir: <path>`.
 *  Reading only the first would report `unknown` for exactly the sessions this telemetry is about.
 *
 *  Never throws, and never returns empty: an unreadable HEAD becomes `unknown`, a detached one
 *  `detached`. An omitted value would be indistinguishable from a pre-#1245 line, so it names itself. */
export function branchName(root) {
  try {
    const dotGit = path.join(root, '.git')
    let gitDir = dotGit
    if (fs.statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))
      if (!m) return 'unknown'
      gitDir = path.resolve(root, m[1].trim())
    }
    const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8'))
    return ref ? ref[1].trim() : 'detached'
  } catch {
    return 'unknown'
  }
}

/** The audit note for a spawn. `round-none` is a first-class outcome, not an error: it means the prompt
 *  tracked no round, which is exactly what the 🔁 section reports.
 *
 *  The branch (#1245) goes LAST, after the session, so every pre-#1245 line keeps parsing unchanged.
 *  Git forbids `:` and whitespace in a ref name, so a reader may bound the session field at `:` without
 *  a branch ever splitting it; the substitution below covers only a HEAD corrupted into a shape git
 *  itself would reject. Session-keyed grouping alone could not answer "how many rounds did this PR
 *  take" — loops span sessions, which is what #1245 measured.
 *
 *  `branch` is REQUIRED. A default of `branchName()` would hand every caller the branch of the checkout
 *  the hook was LOADED from, which is never the one being worked in — the round-1 defect. */
export function noteFor(prompt, transcriptPath, branch) {
  const round = declaredRound(prompt)
  const b = String(branch || 'unknown').replace(/[\s:]+/g, '_')
  return `round-${round || 'none'}:s=${sessionId(transcriptPath)}:b=${b}`
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
    // Two ways to have no branch, named apart because they fail differently: the payload carried no cwd
    // at all, or it carried one with no git repo above it. Neither may borrow a real branch name —
    // falling back to this checkout's would record whatever MAIN happens to be on, indistinguishable
    // from a genuine main-checkout loop, which is the round-1 defect through a side door.
    const cwd = input.cwd
    const root = repoRootFrom(cwd)
    const branch = root ? branchName(root) : (typeof cwd === 'string' && cwd !== '' ? 'no-repo' : 'no-cwd')
    audit('pass', noteFor(ti.prompt, input.transcript_path, branch))
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

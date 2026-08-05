#!/usr/bin/env node
// #657 — HARD-DENY step-3.5 local-verify gate (PreToolUse).
//
// Why a hard gate (not another reminder): soft reminders / memory operate on *salience* — the same
// reasoning loop that should wait also grades the rule and rationalizes past it ("tests pass" ≈
// verified). Enforcement needs *control flow* keyed on a signal the agent cannot fabricate. The signal
// here is a genuine `role:user` TEXT turn in the transcript (userType "external", isMeta:false) that
// appears AFTER the last edit to a UI/Edge file and contains a confirmation. The agent can't author a
// user turn, so it cannot self-approve. (RFC anthropics/claude-code#45427; correcting the stale
// git-mutation-gate header claim that "the user's in-browser confirmation is a message the hook never
// sees" — PreToolUse hooks DO receive transcript_path.)
//
// Wired (settings.json) to TWO matchers via tool_name:
//   • Bash  → deny `git commit` of a UI/Edge staged diff without a post-edit user confirmation;
//             deny `--no-verify` / `--no-gpg-sign` (the real gate is here, before the shell, so git's
//             own --no-verify can't bypass it).
//   • Edit|Write|MultiEdit → deny self-edits to .claude/hooks/** and .claude/settings*.json
//             (a gate the agent can rewrite is no gate).
//
// Fail-CLOSED: on any parse error we deny. Each deny states the authorization that lifts IT — which is
// not the same phrase on every path: the commit and fail-closed denies advise the step-3.5 override,
// the self-edit deny advises stated intent toward the gate (the override does NOT lift it), and
// `--no-verify` advises none by design. See each branch. Non-UI/Edge commits are NOT gated here (the soft
// git-mutation-gate.sh still nudges those). Reload note: settings changes need /hooks opened once.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

// ── Audit logging (so `npm run hook-audit` can observe this hard gate) ───────
// Append one line to .claude/hook-audit.jsonl in the SAME schema as _audit.sh
// ({ts,hook,decision,note}). Without this the gate's deny/pass decisions are
// invisible to monitoring — a hard gate you can't measure is the worst case
// (false-positives that block legit commits go unnoticed). #657 follow-up.
// Only DECISION-relevant events are logged: every `deny` path + a UI/Edge commit
// that PASSED the gate + an authorized self-edit. The high-volume trivial
// early-exits (non-commit Bash, non-protected edits, non-UI/Edge commits) are
// NOT logged — they'd flood the log and drown the signal. decision vocab:
//   deny  — gate blocked. note: commit:<reason> | no-verify | self-edit:<fp> | fail-closed
//   pass  — gate evaluated a real gated action and ALLOWED it. note: commit:confirmed | commit:override | self-edit-authorized:<fp>
// Non-fatal by construction: a logging failure must never break the turn.
// Default to the real gitignored log; HOOK_AUDIT_LOG overrides it (tests point it at a temp file so
// the CLI integration tests don't pollute the production telemetry the monitoring plan depends on).
const AUDIT_FILE = process.env.HOOK_AUDIT_LOG
  ? path.resolve(process.env.HOOK_AUDIT_LOG)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hook-audit.jsonl')
// Pure (exported for tests): build the JSONL line. note is single-lined + JSON-escaped so a stray
// path char can't corrupt the log. Schema matches _audit.sh exactly so the summary parses both.
export function auditLine(decision, note = '', ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
  // Strip ALL control chars (not just \r\n\t) → single space, so a stray byte in a note can never emit
  // invalid JSON the summary would silently drop. Then JSON-escape \\ and ".
  const esc = String(note).replace(/[\u0000-\u001f]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `{"ts":"${ts}","hook":"step35-verify-gate","decision":"${decision}","note":"${esc}"}`
}
function audit(decision, note = '') {
  try { fs.appendFileSync(AUDIT_FILE, auditLine(decision, note) + '\n') } catch { /* best-effort — never break the hook on a logging error */ }
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

// User-facing Edge SSR page surfaces — each renders to a human-visible page, so a change needs the
// step-3.5 in-browser confirmation. ONE list, consumed by BOTH isUiEdgePath and BASH_WRITE_RE so they
// cannot drift (#1023). Longer names FIRST so `plugin-privacy` isn't shadowed by `plugin` in the
// alternation. Deliberately EXCLUDED (not human-rendered pages): api/reports.ts (proxy → aiwatch-reports),
// api/csp-report.ts (violation sink), api/_shared/ (helpers). #1023 added methodology/badges/plugin/
// plugin-privacy/extension-privacy/confirm — the blind spot that let the #1019 /methodology copy commit
// pass ungated (isUiEdgePath then matched only is-down/intro).
const EDGE_PAGE_NAMES = 'extension-privacy|plugin-privacy|is-down|intro|methodology|badges|plugin|confirm'
// Matches BOTH the `_`-prefixed template dir (`api/_methodology/…`) AND the inline-content Function file
// (`api/plugin-privacy.ts`). The optional `_?` keeps helper dirs matched post-rename (#862 count exclusion).
const UI_EDGE_RE = new RegExp(`(?:^|/)src/|(?:^|/)api/_?(?:${EDGE_PAGE_NAMES})(?:/|\\.tsx?)`)

// A path that renders to a human-visible surface (dashboard SPA / the Edge SSR pages above). Worker,
// docs, config, and TEST files are excluded — they have no in-browser surface to confirm.
export function isUiEdgePath(p) {
  if (!p) return false
  if (/(?:^|\/)__tests__\/|\.test\.|\.spec\./.test(p)) return false
  // Match at any path boundary so this works for BOTH the git-relative staged-diff path (`src/x`) AND
  // the Edit/Write tool's absolute `file_path` (`/repo/src/x`) — anchoring `^src/` broke the edit-event
  // correlation in lastUiEditIndex (#664, every UI commit fail-closed). Exclude the worker's own
  // `worker/src/` (not frontend UI) FIRST — its mid-path `/src/` would otherwise match.
  if (/(?:^|\/)worker\/src\//.test(p)) return false
  return UI_EDGE_RE.test(p)
}

// Genuine in-browser verification confirmation (KO + EN). DELIBERATELY NARROW — bare "확인"
// (=acknowledge), "ok"/"okay" matched ~20% of ordinary instruction turns ("647 실패 확인", "(a) ok",
// "ok now add a button"), opening the gate without real verification. Require affirmative-verified
// phrasing: "확인했/확인 완료/확인됨", "잘 나옴/잘 된다", "괜찮", "문제없/이상없", "정상 작동",
// "브라우저…(확인/좋/괜찮/정상)", or EN "lgtm / looks good / verified / works (fine|now) / confirmed".
// `(?<!:)confirmed` — NOT a stylistic detail. `npm run hook-audit` echoes this gate's own audit notes,
// one of which is `commit:confirmed`; an operator pasting that report into the chat types a genuine
// `role:user` turn, which the harness-wrapper skip-list structurally cannot filter. A confirmation is
// written by a human in prose, never as a colon-prefixed token, so the non-colon boundary costs nothing.
// But this side ALONE does not make the report inert — that is a two-sided invariant, and the other side
// is the report's own prose in `scripts/hook-audit-summary.mjs`, which must not phrase its advice in the
// words these regexes look for. Both sides are pinned together by a test that runs the real summary over
// a maximal fixture and asserts CONFIRM_RE / OVERRIDE_RE / HOOK_WORK_RE all refuse the output.
export const CONFIRM_RE = /확인\s?했|확인\s?(?:완료|됨|됐|함)|잘\s?나(?:옴|와|온다|옵니다)|잘\s?(?:된다|됩니다|돼요?|작동)|괜찮(?:아|네|습니다|음)|문제\s?없|이상\s?없|정상\s?(?:작동|동작)|브라우저[^.\n]{0,20}(?:확인|좋|괜찮|정상)|lgtm|looks?\s?good|verified|works\s?(?:fine|now|well)|(?<!:)confirmed(?:\s?(?:working|in.?browser))?/i
export const OVERRIDE_RE = /검증\s?생략|확인\s?생략|스킵하고\s?커밋|커밋만\s?(?:해|진행)|skip\s?(?:the\s?)?(?:local\s?)?verif|no\s?verif(?:y|ication)\s?needed|force\s?commit/i
/** The phrases each deny message tells the user to type, as CONSTANTS the message interpolates — so the
 *  advice and the regex that has to accept it cannot drift apart. A test renders every deny path and
 *  requires each phrase it advises to satisfy that branch's OWN regex (not any of the three), and a
 *  second test requires the same of the phrases CLAUDE.md and workflow-hooks.md quote. */
export const HOOK_WORK_EXAMPLES = ['work on the gate', '훅 작업']
export const COMMIT_OVERRIDE_EXAMPLES = ['검증 생략하고 커밋', 'skip verify']
/** Which regex has to accept each advice list — the branch that RENDERS it is the branch that checks it.
 *  The self-edit deny consults `HOOK_WORK_RE` and nothing else; the commit and fail-closed denies consult
 *  `CONFIRM_RE` or `OVERRIDE_RE`. A test iterates these, so an advice phrase no branch would accept fails. */
export const ADVICE = [
  { phrases: HOOK_WORK_EXAMPLES, accepts: () => HOOK_WORK_RE },
  { phrases: COMMIT_OVERRIDE_EXAMPLES, accepts: () => OVERRIDE_RE },
]

// User-authorized hook/gate work — only then may the agent edit a .claude/hooks/** or settings file.
// NARROW (the threat is the agent rationalizing a self-edit): require a verb+target pairing
// ("edit/fix/work on the gate|hook", "훅/게이트 작업|수정"). Bare "gate"/"hook"/".claude" is NOT enough.
// The bare-NAME alternatives (`#?657`, `step-?35`, `step-?3\.?5 gate`) were REMOVED after #1150's review:
// naming a thing is not authorizing work on it, and `npm run hook-audit`'s own output contains this hook's
// name — so pasting that report into the chat authorized the agent to edit its own gate.
//
// The lookarounds exist because the strings most likely to be pasted back into the chat are this repo's
// OWN — audit notes, branch names, this gate's deny messages, these docs. They are scoped to ASCII word
// chars so Korean still inflects (`훅 수정해줘` must authorize), and they are deliberately NOT total:
// `fix the gateway` still authorizes, as it did before #1150. Which shapes are refused and which are
// accepted is stated where it is executable — one fixture per guard in
// `scripts/step35-verify-gate.test.mjs`. Two attempts to also enumerate it here drifted within one
// review round each, so this comment no longer does.
export const HOOK_WORK_RE = /(?<![-\w])(?:hooks?|gate|훅|게이트)\s*(?:작업|수정|개선|편집|고쳐|고침|edit|fix|work)(?![-\w])|(?<![-\w])(?:work(?:ing)?\s?on|edit|fix|수정|작업|개선|고쳐)(?![-_])[^.\n]{0,15}(?<![-\w])(?:gate|hook|훅|게이트)/i
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Bash write-redirect to a UI/Edge path (cat > / >> / tee). Heuristic — covers the heredoc edit path.
// Shares EDGE_PAGE_NAMES with UI_EDGE_RE (#1023) so the two matchers can't drift. Matches the template
// dir (`api/_methodology/…`) and the inline Function file (`> api/plugin-privacy.ts`).
const BASH_WRITE_RE = new RegExp(
  `>>?\\s*("?)(src/[^\\s"]+|api/_?(?:${EDGE_PAGE_NAMES})(?:/[^\\s"]+|\\.tsx?))` +
  `|tee\\s+("?)(src/|api/_?(?:${EDGE_PAGE_NAMES})(?:/|\\.tsx?))`,
)

/** Index of the last transcript entry that EDITED a UI/Edge file (Edit/Write tool_use or a Bash
 *  write-redirect). -1 if none seen in this transcript. */
export function lastUiEditIndex(entries) {
  let idx = -1
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e?.type !== 'assistant') continue
    for (const b of e.message?.content ?? []) {
      if (b?.type !== 'tool_use') continue
      if (EDIT_TOOLS.has(b.name) && isUiEdgePath(b.input?.file_path)) idx = i
      else if (b.name === 'Bash' && BASH_WRITE_RE.test(b.input?.command ?? '')) idx = i
    }
  }
  return idx
}

/** Harness-injected `role:user` turns that are NOT a human speaking, recognised by their leading tag.
 *  Their text routinely contains the very words this gate looks for: a slash-command body, an
 *  agent-authored task-notification summary, or the stdout of a `!` command that printed "확인했" or
 *  "hook" out of a file. **#1150** added the `bash-*` entries after finding that a `!cat`/`!npm` echo
 *  could otherwise authorise a UI commit or a hook edit here.
 *  NOT every impostor carries a tag — see `isCompactSummary` below, which is why the shape check alone
 *  was not enough. */
const HARNESS_WRAPPER_RE = /^\s*<(?:command-|local-command|task-notification|system-reminder|bash-input|bash-stdout|bash-stderr)/

/** True if a genuine human text turn (external, not meta/sidechain) matching `re` appears at an index
 *  > afterIdx. The agent cannot author such a turn → unfabricable. */
export function hasUserTurnAfter(entries, afterIdx, re) {
  for (let i = entries.length - 1; i > afterIdx; i--) {
    const e = entries[i]
    // `isCompactSummary` is the one impostor with no tag to recognise it by: a compaction summary is
    // `type:user`, `isMeta:false`, plain string content — and it is written by the AGENT, quoting earlier
    // user turns verbatim. So a "확인 완료" from hours ago is replayed as a fresh post-edit confirmation
    // and lifts this gate. Every compaction turn in this project's transcripts satisfies CONFIRM_RE, and
    // the flag has not appeared on a human turn — so skipping it costs no real confirmation (#1150).
    if (e?.type !== 'user' || e.isMeta === true || e.isSidechain === true || e.isCompactSummary === true) continue
    // Real human prompts store message.content as a STRING; tool-result turns store an ARRAY whose
    // first block is a tool_result (NOT a human message — skip those). Some clients use an array with
    // a leading text block. Extract the human text from string OR array-with-text only.
    const c = e.message?.content
    const text = typeof c === 'string' ? c
      : (Array.isArray(c) && c[0]?.type === 'text' ? (c[0].text ?? '') : '')
    if (!text || HARNESS_WRAPPER_RE.test(text)) continue
    if (re.test(text)) return true
  }
  return false
}

/** The gate decision for a `git commit`. stagedUiEdge = UI/Edge files in the staged diff. */
export function decideCommit(stagedUiEdge, entries) {
  if (stagedUiEdge.length === 0) return { deny: false, reason: 'not-ui' } // not a UI/Edge commit → soft path elsewhere
  const editIdx = lastUiEditIndex(entries)
  // No UI/Edge edit event in this transcript → the edits predate it; we can't verify → fail-closed.
  // An explicit override anywhere in the transcript still lifts it. `reason` distinguishes a genuine in-browser
  // confirmation from an operator override in the audit log (the override count is the false-positive
  // proxy for #659 monitoring — a high override rate means the gate is firing on already-verified work).
  if (editIdx === -1) return hasUserTurnAfter(entries, -1, OVERRIDE_RE) ? { deny: false, reason: 'override' } : { deny: true, reason: 'no-edit-event' }
  if (hasUserTurnAfter(entries, editIdx, CONFIRM_RE)) return { deny: false, reason: 'confirmed' }
  if (hasUserTurnAfter(entries, editIdx, OVERRIDE_RE)) return { deny: false, reason: 'override' }
  return { deny: true, reason: 'no-confirmation' }
}

// ── CLI (hook entry) ────────────────────────────────────────────────────────

function denyJson(reason) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  })
}

/** Parse a JSONL transcript. Exported ONLY so the torn-line tolerance below is testable: the harness
 *  appends to this file while the hook reads it, and if a partial trailing line threw, `main()`'s outer
 *  catch would turn every UI commit made mid-append into a `fail-closed` deny on this HARD gate. */
export function readEntries(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, 'utf8')
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    // A torn trailing line is expected — the harness appends to this file while we read it.
    try { out.push(JSON.parse(line)) } catch { /* skip malformed line */ }
  }
  return out
}

function main() {
  let input
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { process.exit(0) } // no input → don't block
  const tool = input.tool_name
  const ti = input.tool_input ?? {}

  // Self-protection: never let the agent weaken its own gate.
  if (EDIT_TOOLS.has(tool)) {
    const fp = ti.file_path ?? ti.notebook_path ?? ''
    if (/\.claude\/(?:hooks\/|settings(?:\.local)?\.json)/.test(fp)) {
      // Allow ONLY when a user turn ANYWHERE in this transcript states the intent (`HOOK_WORK_RE`, whose
      // accepted shapes are `HOOK_WORK_EXAMPLES`); otherwise the agent must not edit its own gate. This
      // branch consults HOOK_WORK_RE and nothing else — a generic verification-skip must not authorize the
      // agent to rewrite the gate that checks it.
      let authorized = false
      try {
        const tp = input.transcript_path
        if (tp && fs.existsSync(tp)) authorized = hasUserTurnAfter(readEntries(tp), -1, HOOK_WORK_RE)
      } catch { authorized = false }
      if (authorized) { audit('pass', `self-edit-authorized:${fp}`); process.exit(0) }
      audit('deny', `self-edit:${fp}`)
      console.log(denyJson(`#657: editing ${fp} needs explicit user authorization (none found in the transcript). The user can give it by stating intent toward this gate — ${HOOK_WORK_EXAMPLES.map((p) => `"${p}"`).join(' / ')}. Naming the file or its issue number is deliberately not enough.`))
      return
    }
    process.exit(0)
  }

  if (tool !== 'Bash') process.exit(0)
  const cmd = ti.command ?? ''
  if (!/\bgit\s+commit\b/.test(cmd)) process.exit(0)

  // --no-verify / --no-gpg-sign: hard-deny (CLAUDE.md forbids unless the user asked). Check only the
  // command HEAD — the part before the message body (`-m`, `-F`, a `<<heredoc`) — so a commit MESSAGE
  // that merely *discusses* "--no-verify" (like this very commit) isn't mistaken for the flag.
  const cmdHead = cmd.split(/<<-?\s*['"]?\w|(?:^|\s)-m(?:sg)?[\s=]|(?:^|\s)-F[\s=]|(?:^|\s)--message[\s=]|(?:^|\s)--file[\s=]/)[0]
  if (/(?:^|\s)(?:--no-verify|--no-gpg-sign|-n\b)|-c\s+commit\.gpgsign=false/.test(cmdHead)) {
    audit('deny', 'no-verify')
    console.log(denyJson('#657: `--no-verify` / `--no-gpg-sign` on git commit is blocked unless the user explicitly asked. Drop the flag and let the hooks run.'))
    return
  }

  // Determine the staged UI/Edge set. A git failure here (cwd not a repo — e.g. /tmp or a sibling
  // working dir, transient lock) must NOT deny: we can't know the scope, so ALLOW (the soft
  // git-mutation-gate.sh still nudges). Fail-closed applies only when UI/Edge files ARE staged.
  let stagedUiEdge
  try {
    const cwd = input.cwd || process.cwd()
    stagedUiEdge = execSync('git diff --cached --name-only', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(s => s.trim()).filter(Boolean).filter(isUiEdgePath)
  } catch { process.exit(0) } // can't read the staged set → not our call to block
  if (stagedUiEdge.length === 0) process.exit(0) // non-UI/Edge commit → soft gate only

  // Fail-closed ONLY once we know UI/Edge files are staged: a transcript we can't read can't prove
  // verification, so deny (with the always-available override).
  try {
    const tp = input.transcript_path
    const entries = tp && fs.existsSync(tp) ? readEntries(tp) : []
    const d = decideCommit(stagedUiEdge, entries)
    if (d.deny) {
      audit('deny', `commit:${d.reason}`)
      const why = d.reason === 'no-edit-event'
        ? `the staged UI/Edge files (${stagedUiEdge.slice(0, 3).join(', ')}${stagedUiEdge.length > 3 ? '…' : ''}) have no edit event in this session to tie a verification to`
        : `no in-browser confirmation from the USER appears after the last UI/Edge edit (${stagedUiEdge.slice(0, 3).join(', ')}${stagedUiEdge.length > 3 ? '…' : ''})`
      console.log(denyJson(
        `#657 step-3.5 gate: ${why}. Start the right dev server, hand off, and WAIT for the user to confirm in-browser (a passing test suite is not a verification). The user's reply lifts this gate; to skip, the user says ${COMMIT_OVERRIDE_EXAMPLES.map((p) => `"${p}"`).join(' / ')}.`,
      ))
      return
    }
    audit('pass', `commit:${d.reason}`) // confirmed | override — override = false-positive proxy (#659)
    process.exit(0)
  } catch (err) {
    // Fail-closed: deny, but make it trivially recoverable. Logged as `fail-closed` (a GATE-HEALTH
    // signal, NOT an intercepted violation) so the summary can track it separately — it should trend
    // to ~0; a nonzero trend means the transcript read is breaking, not that violations are happening.
    audit('deny', 'fail-closed')
    console.log(denyJson(`#657 step-3.5 gate: could not read the transcript (${err instanceof Error ? err.message : 'error'}) — failing closed. If the user has already checked the page in-browser, have them reply saying so; or ${COMMIT_OVERRIDE_EXAMPLES.map((p) => `"${p}"`).join(' / ')} to override.`))
  }
}

/** True when this file is the process entry point. `import.meta.url === \`file://${process.argv[1]}\``
 *  is WRONG: a path containing a space or `#` percent-encodes in the URL and never compares equal, so
 *  `main()` never runs and the process exits 0. On a HARD, fail-CLOSED gate that means it fails OPEN —
 *  a `--no-verify` commit sails through with no audit line to say the gate was absent, and a space in
 *  `$CLAUDE_PROJECT_DIR` is all it takes. Compare real paths instead. */
function isEntryPoint() {
  try { return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1] ?? '') } catch { return false }
}

if (isEntryPoint()) main()

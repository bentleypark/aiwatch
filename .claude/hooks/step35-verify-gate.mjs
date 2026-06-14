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
// Fail-CLOSED: on any parse error we deny — but every deny message states the one-line override so a
// false-deny is recoverable in a single user turn (the user replies with a confirmation, or
// "검증 생략하고 커밋" / "skip verify"). Non-UI/Edge commits are NOT gated here (the soft
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
//   pass  — gate evaluated a real gated action and ALLOWED it. note: commit:confirmed | self-edit-authorized:<fp>
// Non-fatal by construction: a logging failure must never break the turn.
// Default to the real gitignored log; HOOK_AUDIT_LOG overrides it (tests point it at a temp file so
// the CLI integration tests don't pollute the production telemetry the monitoring plan depends on).
const AUDIT_FILE = process.env.HOOK_AUDIT_LOG
  ? path.resolve(process.env.HOOK_AUDIT_LOG)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hook-audit.jsonl')
// Pure (exported for tests): build the JSONL line. note is single-lined + JSON-escaped so a stray
// path char can't corrupt the log. Schema matches _audit.sh exactly so the summary parses both.
export function auditLine(decision, note = '', ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
  // Strip ALL control chars (not just \r\n\t) → single space, matching _audit.sh's tr -d set, so a
  // stray byte can never emit invalid JSON the summary would silently drop. Then JSON-escape \\ and ".
  const esc = String(note).replace(/[\u0000-\u001f]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `{"ts":"${ts}","hook":"step35-verify-gate","decision":"${decision}","note":"${esc}"}`
}
function audit(decision, note = '') {
  try { fs.appendFileSync(AUDIT_FILE, auditLine(decision, note) + '\n') } catch { /* best-effort — never break the hook on a logging error */ }
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

// A path that renders to a human-visible surface (dashboard SPA / is-down + intro Edge SSR). Worker,
// docs, config, and TEST files are excluded — they have no in-browser surface to confirm.
export function isUiEdgePath(p) {
  if (!p) return false
  if (/(?:^|\/)__tests__\/|\.test\.|\.spec\./.test(p)) return false
  return /^src\//.test(p) || /^api\/(?:is-down|intro)\//.test(p)
}

// Genuine in-browser verification confirmation (KO + EN). DELIBERATELY NARROW — bare "확인"
// (=acknowledge), "ok"/"okay" matched ~20% of ordinary instruction turns ("647 실패 확인", "(a) ok",
// "ok now add a button"), opening the gate without real verification. Require affirmative-verified
// phrasing: "확인했/확인 완료/확인됨", "잘 나옴/잘 된다", "괜찮", "문제없/이상없", "정상 작동",
// "브라우저…(확인/좋/괜찮/정상)", or EN "lgtm / looks good / verified / works (fine|now) / confirmed".
export const CONFIRM_RE = /확인\s?했|확인\s?(?:완료|됨|됐|함)|잘\s?나(?:옴|와|온다|옵니다)|잘\s?(?:된다|됩니다|돼요?|작동)|괜찮(?:아|네|습니다|음)|문제\s?없|이상\s?없|정상\s?(?:작동|동작)|브라우저[^.\n]{0,20}(?:확인|좋|괜찮|정상)|lgtm|looks?\s?good|verified|works\s?(?:fine|now|well)|confirmed(?:\s?(?:working|in.?browser))?/i
export const OVERRIDE_RE = /검증\s?생략|확인\s?생략|스킵하고\s?커밋|커밋만\s?(?:해|진행)|skip\s?(?:the\s?)?(?:local\s?)?verif|no\s?verif(?:y|ication)\s?needed|force\s?commit/i
// User-authorized hook/gate work — only then may the agent edit a .claude/hooks/** or settings file.
// NARROW (the threat is the agent rationalizing a self-edit): require an explicit gate reference
// (#657 / step35 / step-3.5 gate) OR a verb+target pairing ("edit/fix/work on the gate|hook",
// "훅/게이트 작업|수정"). Bare "gate"/"hook"/".claude"/an issue-number range are NOT enough.
export const HOOK_WORK_RE = /#?657\b|step-?35|step-?3\.?5\s?gate|(?:hooks?|gate|훅|게이트)\s*(?:작업|수정|개선|편집|edit|fix|work)|(?:work\s?on|edit|fix|수정|작업|개선)[^.\n]{0,15}(?:gate|hook|훅|게이트)/i
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Bash write-redirect to a UI/Edge path (cat > / >> / tee). Heuristic — covers the heredoc edit path.
const BASH_WRITE_RE = />>?\s*("?)(src\/[^\s"]+|api\/(?:is-down|intro)\/[^\s"]+)|tee\s+("?)(src\/|api\/(?:is-down|intro)\/)/

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

/** True if a genuine human text turn (external, not meta/sidechain) matching `re` appears at an index
 *  > afterIdx. The agent cannot author such a turn → unfabricable. */
export function hasUserTurnAfter(entries, afterIdx, re) {
  for (let i = entries.length - 1; i > afterIdx; i--) {
    const e = entries[i]
    if (e?.type !== 'user' || e.isMeta === true || e.isSidechain === true) continue
    // Real human prompts store message.content as a STRING; tool-result turns store an ARRAY whose
    // first block is a tool_result (NOT a human message — skip those). Some clients use an array with
    // a leading text block. Extract the human text from string OR array-with-text only.
    const c = e.message?.content
    const text = typeof c === 'string' ? c
      : (Array.isArray(c) && c[0]?.type === 'text' ? (c[0].text ?? '') : '')
    if (!text) continue
    // Skip HARNESS-injected user turns (slash-command wrappers, command stdout, task notifications,
    // interrupt markers) — they're string-content + isMeta:false but not a human confirmation, and
    // their text can incidentally contain confirm/authorize words.
    if (/^\s*<(?:command-|local-command|task-notification|system-reminder)/.test(text)) continue
    if (re.test(text)) return true
  }
  return false
}

/** The gate decision for a `git commit`. stagedUiEdge = UI/Edge files in the staged diff. */
export function decideCommit(stagedUiEdge, entries) {
  if (stagedUiEdge.length === 0) return { deny: false, reason: 'not-ui' } // not a UI/Edge commit → soft path elsewhere
  const editIdx = lastUiEditIndex(entries)
  // No UI/Edge edit event in this transcript → the edits predate it; we can't verify → fail-closed.
  // An explicit override anywhere recent still lifts it. `reason` distinguishes a genuine in-browser
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

function readEntries(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, 'utf8')
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
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
      // Allow ONLY when the user has authorized hook/gate work in a recent turn (e.g. "#657",
      // "hook", "gate", "훅 작업", "검증 생략"); otherwise the agent must not edit its own gate.
      let authorized = false
      try {
        const tp = input.transcript_path
        if (tp && fs.existsSync(tp)) authorized = hasUserTurnAfter(readEntries(tp), -1, HOOK_WORK_RE)
      } catch { authorized = false }
      if (authorized) { audit('pass', `self-edit-authorized:${fp}`); process.exit(0) }
      audit('deny', `self-edit:${fp}`)
      console.log(denyJson(`#657: editing ${fp} needs explicit user authorization for hook/gate work (none found in the transcript). The user can authorize it ("work on the gate" / "#657" / "훅 작업") or say "검증 생략".`))
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
        `#657 step-3.5 gate: ${why}. Start the right dev server, hand off, and WAIT for the user to confirm in-browser ("tests pass" ≠ verified). The user's reply lifts this gate; to skip, the user says "검증 생략하고 커밋" / "skip verify".`,
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
    console.log(denyJson(`#657 step-3.5 gate: could not verify local confirmation (${err instanceof Error ? err.message : 'error'}) — failing closed. If the user has confirmed in-browser, have them reply with a confirmation; or "검증 생략" to override.`))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()

#!/usr/bin/env node
// #873 — Tier-A machine-checkable assertions on `verify-after` lines ("close the verify-blocked loop").
//
// The #541 `verify-reminders` Action only PINGS when a `verify-after <date>` line comes due — the
// actual check stays manual, so verify-blocked issues pile up. Most AIWatch verify targets, though,
// are machine-checkable production signals AIWatch already emits (a field on /api/status, /api/report,
// a counter surfaced in an endpoint). This module lets a `verify-after` line carry an optional
// `assert:` line that a scheduled job can EVALUATE against production and, on pass, auto-tick the box
// + comment the evidence + drop `verify-blocked` — closing the loop instead of nagging a human.
//
// PROTOTYPE (this file): the pure evaluator (parse/select/compare/allowlist — no network, no eval) +
// a standalone dry-run CLI that proves the loop end-to-end on a real open issue. Folding the
// evaluation into the daily verify-reminders.mjs loop is the productionize follow-up (#873 acceptance).
//
// Grammar — an indented `assert:` line directly under a `verify-after` item:
//
//   - [ ] verify-after 2026-07-09 — turbopuffer probe warmed
//         assert: GET /api/status | services[id=turbopuffer].scoreConfidence == "medium"
//
//   source   : GET is optional; a leading `/` path resolves against VERIFY_ASSERT_BASE (the prod
//              worker), or an absolute https URL — either way the host must be ALLOWLISTED (SSRF-safe).
//   selector : dot path + optional `[key=value]` array filter (services[id=turbopuffer].scoreConfidence)
//   operator : == | != | >= | <= | contains | exists
//   expected : a literal (string "…"/'…', number, true/false); omitted for `exists`
//
// Result semantics (why fail-open): pass → auto-verify; FAIL → keep firing the reminder (never
// false-close); fetch error / non-allowlisted / selector-miss → treat as "can't verify yet" (keep the
// reminder, don't tick) so a flaky read never spuriously closes an issue.
//
// Pure helpers are exported + unit-tested in scripts/verify-assertions.test.mjs (no network, no eval).

import { execFileSync } from 'node:child_process'
import { parseTrustedAuthors } from './verify-reminders.mjs'

// Default base for a relative `/api/...` source — the prod worker (overridable for tests/local).
export const DEFAULT_ASSERT_BASE = 'https://aiwatch-worker.p2c2kbf.workers.dev'

// SSRF allowlist: an assertion may only fetch AIWatch's own surfaces. EXACT hosts only — the prod
// worker host is pinned (derived from DEFAULT_ASSERT_BASE), NOT a `aiwatch-worker.*.workers.dev`
// wildcard: any Cloudflare account can name a worker `aiwatch-worker`, so a wildcard would let an
// attacker-controlled worker return crafted JSON to force a false `pass` (#873 review #2). Extra hosts
// (local/preview, or a future custom subdomain #439) go through VERIFY_ASSERT_ALLOW (comma-separated).
const ALLOW_EXACT = new Set(['ai-watch.dev', 'www.ai-watch.dev', 'api.ai-watch.dev', new URL(DEFAULT_ASSERT_BASE).hostname])

/** True if urlStr is an https URL whose host is an AIWatch surface (exact-allowlisted). Never throws. */
export function isAllowedUrl(urlStr, env = process.env) {
  let u
  try { u = new URL(urlStr) } catch { return false }
  if (u.protocol !== 'https:') return false
  const extra = (env.VERIFY_ASSERT_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean)
  // Also honor the host of an overridden VERIFY_ASSERT_BASE so a custom base stays coherent.
  let baseHost = ''
  try { baseHost = new URL(env.VERIFY_ASSERT_BASE || DEFAULT_ASSERT_BASE).hostname } catch { /* keep '' */ }
  return ALLOW_EXACT.has(u.hostname) || (baseHost && u.hostname === baseHost) || extra.includes(u.hostname)
}

/**
 * Resolve an assertion `source` (e.g. `/api/status` or an absolute URL) to an absolute, allowlisted
 * URL string — or null when the resolved host is not allowlisted (so the caller skips, fail-open).
 */
export function resolveSource(source, env = process.env) {
  const base = (env.VERIFY_ASSERT_BASE || DEFAULT_ASSERT_BASE).replace(/\/$/, '')
  const abs = /^https?:\/\//i.test(source) ? source : `${base}${source.startsWith('/') ? '' : '/'}${source}`
  return isAllowedUrl(abs, env) ? abs : null
}

// `assert: [GET] <source> | <selector> <op> [<expected>]`. Case-insensitive `assert`/`GET`.
const ASSERT_RE = /^\s*assert:\s*(?:GET\s+)?(\S+)\s*\|\s*(.+?)\s*$/i
// `<selector> <op> [<expected>]` — operator surrounded by spaces; `exists` takes no expected.
const CLAUSE_RE = /^(\S+)\s+(==|!=|>=|<=|contains|exists)(?:\s+(.+))?$/

/** Parse an `assert:` line → {source, selector, op, expected} | null (malformed → null, never throws). */
export function parseAssertionLine(line) {
  const m = ASSERT_RE.exec(line)
  if (!m) return null
  const [, source, clause] = m
  const c = CLAUSE_RE.exec(clause.trim())
  if (!c) return null
  const [, selector, op, expected] = c
  // `exists` must carry no operand; the value operators must carry one.
  if (op === 'exists' && expected != null) return null
  if (op !== 'exists' && (expected == null || expected === '')) return null
  if (!parseSelector(selector)) return null
  return { source, selector, op, expected: expected == null ? null : expected.trim() }
}

/** Coerce an assert-line literal: quoted → string, true/false → bool, numeric → number, else raw. */
export function parseLiteral(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  if (s === 'true') return true
  if (s === 'false') return false
  if (s !== '' && !Number.isNaN(Number(s))) return Number(s)
  return s
}

// A selector segment: `key` or `key[filterKey=filterVal]` (filterVal may be quoted).
const SEG_RE = /^([A-Za-z0-9_]+)(?:\[([A-Za-z0-9_]+)=([^\]]+)\])?$/

/** Parse a dot-path selector → [{key, filter?}] | null when any segment is malformed. */
export function parseSelector(selector) {
  if (!selector) return null
  const steps = []
  for (const part of selector.split('.')) {
    const m = SEG_RE.exec(part)
    if (!m) return null
    steps.push({ key: m[1], filter: m[2] ? { key: m[2], value: parseLiteral(m[3]) } : null })
  }
  return steps
}

/** Walk a selector over a parsed JSON value → {found, value}. Array `[k=v]` picks the first match. */
export function evalSelector(json, selector) {
  const steps = parseSelector(selector)
  if (!steps) return { found: false, value: undefined }
  let cur = json
  for (const step of steps) {
    if (cur == null || typeof cur !== 'object') return { found: false, value: undefined }
    cur = cur[step.key]
    if (step.filter) {
      if (!Array.isArray(cur)) return { found: false, value: undefined }
      cur = cur.find((el) => el != null && String(el[step.filter.key]) === String(step.filter.value))
      if (cur === undefined) return { found: false, value: undefined }
    }
  }
  return { found: cur !== undefined, value: cur }
}

/** Apply an operator to a selected value vs the (raw) expected literal → boolean. */
export function compare(value, op, expectedRaw) {
  if (op === 'exists') return value !== undefined && value !== null
  const expected = parseLiteral(expectedRaw)
  switch (op) {
    case '==': return String(value) === String(expected)
    case '!=': return String(value) !== String(expected)
    case '>=': return Number(value) >= Number(expected)
    case '<=': return Number(value) <= Number(expected)
    case 'contains':
      if (Array.isArray(value)) return value.map(String).includes(String(expected))
      return String(value).includes(String(expected))
    default: return false
  }
}

/** Evaluate a parsed assertion against fetched JSON → {pass, found, actual}. Selector-miss ⇒ pass:false. */
export function evaluateAssertion(assertion, json) {
  const { found, value } = evalSelector(json, assertion.selector)
  if (!found && assertion.op !== 'exists') return { pass: false, found: false, actual: undefined }
  const pass = compare(value, assertion.op, assertion.expected)
  return { pass, found, actual: value }
}

// A CHECKED task marker — a done item is skipped.
const CHECKED_BOX_RE = /^\s*[-*+]\s+\[[xX]\]/

// A markdown BLOCKQUOTE line (`> …`, leading indent ok).
const BLOCKQUOTE_RE = /^\s*>/

const VERIFY_RE = /verify-after[\s:-]+(\d{4}-\d{2}-\d{2})([^\n]*)/i

/**
 * True when a line must NOT be scanned for a `verify-after` reminder — a done item (`- [x]`) or a
 * blockquote. Single source of truth for BOTH scanners (`pairVerifyAssertions` here, the exported
 * `parseVerifyAfter` in verify-reminders.mjs): they previously kept private copies of the checked-box
 * regex, which is precisely how one grew the blockquote guard and the other would not have (#966).
 *
 * Blockquotes are suppressed because they are retrospective narrative: ship-issue step 10 has the
 * operator write a dated `> **Status (…):**` note, and such notes routinely QUOTE the literal
 * `verify-after <date>` token. A quoted mention carries no checkbox, so it can never be ticked, and the
 * #873 auto-verify's `tickedKeys` suppression is keyed by the *checkbox* lineIndex — it cannot reach a
 * prose line. So it re-fired daily until the issue closed. Full history: docs/reference/verify-assertions.md.
 *
 * Non-quoted prose still fires — a `verify-after` written outside a checkbox is a legitimate reminder.
 */
export function isSuppressedReminderLine(line) {
  return CHECKED_BOX_RE.test(line) || BLOCKQUOTE_RE.test(line)
}

// Strips one or more leading `>` quote markers so the quoted line's own markdown can be inspected.
const QUOTE_STRIP_RE = /^(\s*>)+\s?/
const OPEN_BOX_ANCHORED_RE = /^\s*[-*+]\s+\[ \]/

/**
 * The ONE dangerous shape the blockquote rule suppresses: an UNCHECKED `verify-after` checkbox nested
 * inside a blockquote (`> - [ ] verify-after 2026-09-01 …`). That reads as a live reminder but will
 * never fire. Quoted *prose* is deliberate and expected (ship-issue status notes quote the token all
 * the time), so it is NOT reported — logging it would drown the signal in the very noise #966 removed.
 *
 * Returns [{lineIndex, text}] so the daily job can warn instead of dropping the line in silence: the
 * whole point of this system is that a verification is never forgotten, so its one false-negative must
 * be observable. Pure — no I/O.
 */
export function findQuotedVerifyAfterBoxes(body) {
  if (!body) return []
  const out = []
  body.split('\n').forEach((line, lineIndex) => {
    if (!BLOCKQUOTE_RE.test(line) || !VERIFY_RE.test(line)) return
    if (OPEN_BOX_ANCHORED_RE.test(line.replace(QUOTE_STRIP_RE, ''))) out.push({ lineIndex, text: line.trim() })
  })
  return out
}

/**
 * Pair each OPEN `verify-after` line in a body with a following indented `assert:` line (the next
 * non-blank line, if it parses as an assertion). Returns [{date, note, lineIndex, assertion|null}].
 * Checked (`- [x]`) and blockquoted (`>`) verify-after lines are skipped — see
 * isSuppressedReminderLine. This is the scanner `main()` actually drives (#541 reminders + #873
 * auto-verify); `parseVerifyAfter` is the exported/unit-tested twin.
 */
export function pairVerifyAssertions(body) {
  const out = []
  if (!body) return out
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isSuppressedReminderLine(line)) continue
    const v = VERIFY_RE.exec(line)
    if (!v) continue
    const note = v[2].replace(/^[\s—–:*_)·-]+/, '').replace(/\*+$/, '').trim()
    // Look at the immediately following non-blank line for an `assert:`.
    let assertion = null
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue
      assertion = parseAssertionLine(lines[j])
      break
    }
    out.push({ date: v[1], note, lineIndex: i, assertion })
  }
  return out
}

/**
 * Flip the checkbox on the verify-after line at lineIndex from `[ ]` → `[x]`. Returns the new body.
 * The match is ANCHORED to a real task marker at line start (mirrors OPEN_BOX_RE), so a prose line
 * with a stray literal `[ ]` substring is NOT mutated — keeping tickBox's no-op set exactly equal to
 * the countOpenBoxes set that the auto-verify guard relies on (#873 review, hardening the prose edge).
 */
export function tickBox(body, lineIndex) {
  const lines = body.split('\n')
  if (lineIndex < 0 || lineIndex >= lines.length) return body
  lines[lineIndex] = lines[lineIndex].replace(/^(\s*[-*+]\s+\[)\s(\])/, '$1x$2')
  return lines.join('\n')
}

const OPEN_BOX_RE = /^\s*[-*+]\s+\[ \]/

/** Count UNCHECKED markdown task boxes (`- [ ]`) in a body — 0 means the issue is fully checked. */
export function countOpenBoxes(body) {
  if (!body) return 0
  return body.split('\n').filter((l) => OPEN_BOX_RE.test(l)).length
}

/** Count UNCHECKED `verify-after` lines specifically (an open box whose line carries a verify-after). */
export function countOpenVerifyAfter(body) {
  if (!body) return 0
  return body.split('\n').filter((l) => OPEN_BOX_RE.test(l) && VERIFY_RE.test(l)).length
}

/**
 * Decide the auto-verify mutation for ONE issue from its evaluated verify-after items.
 * evaluated: [{lineIndex, status}] (status: 'pass'|'fail'|'skip'). Pure — no I/O.
 * Returns {newBody, ticked:[lineIndex], passCount, dropLabel, close}:
 *   - ticks every PASSing line's box,
 *   - dropLabel: drop `verify-blocked` once NO unchecked verify-after line remains (dated verifies done),
 *   - close: only when NO unchecked box of ANY kind remains (the whole issue is complete) — conservative.
 */
export function planIssueAutoVerify(body, evaluated) {
  let newBody = body
  const ticked = []
  for (const e of evaluated) {
    if (e.status !== 'pass') continue
    // Only record a REAL tick: tickBox is a no-op on a prose (non-`[ ]`) verify-after line, and a
    // no-op tick must not drive a comment/label/close — else the daily job re-posts every run since
    // the body never changes (#873 review #1). Compare before/after so prose lines are skipped.
    const after = tickBox(newBody, e.lineIndex)
    if (after !== newBody) { newBody = after; ticked.push(e.lineIndex) }
  }
  const dropLabel = ticked.length > 0 && countOpenVerifyAfter(newBody) === 0
  const close = ticked.length > 0 && countOpenBoxes(newBody) === 0
  return { newBody, ticked, passCount: ticked.length, dropLabel, close }
}

/**
 * Fetch the allowlisted source + evaluate → {status, pass, actual, url, error}.
 * status: 'pass' | 'fail' | 'skip' (non-allowlisted / fetch error / bad JSON — fail-open, keep reminder).
 * fetchImpl is injectable for tests (defaults to global fetch).
 */
export async function runAssertion(assertion, { env = process.env, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const url = resolveSource(assertion.source, env)
  if (!url) return { status: 'skip', error: `source not allowlisted: ${assertion.source}`, url: null }
  let json
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal })
      if (!res.ok) return { status: 'skip', error: `HTTP ${res.status}`, url }
      json = await res.json()
    } finally { clearTimeout(t) }
  } catch (e) {
    return { status: 'skip', error: e?.message || String(e), url }
  }
  const { pass, actual } = evaluateAssertion(assertion, json)
  return { status: pass ? 'pass' : 'fail', pass, actual, url }
}

// ── CLI (prototype demo / productionize seam) ────────────────────────────────
// node scripts/verify-assertions.mjs --issue N [--repo owner/repo] [--apply]
//   default = dry-run: fetch the issue body, pair verify-after↔assert, evaluate live, print a table.
//   --apply (pass only): tick the box + comment the evidence + drop the `verify-blocked` label.

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

async function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const issueIdx = argv.indexOf('--issue')
  const repoIdx = argv.indexOf('--repo')
  if (issueIdx === -1) {
    console.error('usage: verify-assertions.mjs --issue N [--repo owner/repo] [--apply]')
    process.exit(1)
  }
  const number = argv[issueIdx + 1]
  const repo = repoIdx === -1 ? null : argv[repoIdx + 1]

  const viewArgs = ['issue', 'view', number, '--json', 'number,title,body,author']
  if (repo) viewArgs.push('--repo', repo)
  const issue = JSON.parse(gh(viewArgs))
  const items = pairVerifyAssertions(issue.body).filter((it) => it.assertion)
  if (items.length === 0) {
    console.log(`#${number}: no verify-after line carries an assert: clause — nothing to auto-verify.`)
    return
  }

  // #873 review #1 — trusted-author gate (ported from verify-reminders.mjs). The assert: line is read
  // straight from the issue body, so on a public repo an untrusted author could plant a trivially-true
  // assertion (`services exists`) to auto-drop verify-blocked. Only mutate when the issue author is
  // trusted. Empty trusted set (pure local, no env) → no gate, preserving the maintainer's own-board
  // test path — same contract as the sibling reminder. Dry-run never mutates, so it stays ungated.
  if (apply) {
    const trusted = parseTrustedAuthors(process.env, repo ? [repo] : [])
    if (trusted.size > 0 && !trusted.has(issue.author?.login)) {
      console.error(`refusing --apply: issue author @${issue.author?.login || '?'} is not in the trusted set — an untrusted assertion must not auto-verify. (set VERIFY_TRUSTED_AUTHORS to override)`)
      process.exit(1)
    }
  }

  console.log(`#${number} ${issue.title}\n${apply ? '(apply)' : '(dry-run)'} — ${items.length} assertion(s):`)
  let newBody = issue.body
  const statuses = []
  for (const it of items) {
    const r = await runAssertion(it.assertion)
    statuses.push(r.status)
    const mark = r.status === 'pass' ? '✅ PASS' : r.status === 'fail' ? '❌ FAIL' : '⚠️  SKIP'
    console.log(`  ${mark}  ${it.assertion.selector} ${it.assertion.op} ${it.assertion.expected ?? ''}`)
    console.log(`         → actual=${truncate(JSON.stringify(r.actual))} ${r.error ? `(${r.error})` : `[${r.url}]`}`)
    if (r.status === 'pass') newBody = tickBox(newBody, it.lineIndex)
  }
  const anyPass = statuses.includes('pass')
  const allResolved = statuses.every((s) => s === 'pass') // #873 review #3: keep the label while any item is unresolved

  if (!apply) { console.log('\n--dry-run: no mutations. Re-run with --apply to tick + comment + drop label.'); return }
  if (!anyPass) { console.log('\nNo passing assertions — nothing applied (reminder stays live).'); return }

  // Tick the passing box(es) always; only DROP verify-blocked when EVERY item is resolved (a mixed
  // pass/fail/skip issue is still blocked on the unresolved item — dropping the label would hide it).
  const editArgs = ['issue', 'edit', number, '--body', newBody]
  if (repo) editArgs.push('--repo', repo)
  gh(editArgs)
  // Label removal is a SEPARATE best-effort call (#873 review #3): a `--remove-label` on a label that
  // isn't present fails the whole `edit`, which would drop the body tick too. Keep them independent.
  if (allResolved) {
    const labelArgs = ['issue', 'edit', number, '--remove-label', 'verify-blocked']
    if (repo) labelArgs.push('--repo', repo)
    try { gh(labelArgs) } catch { /* label absent / already removed — the tick already landed */ }
  }
  const note = allResolved
    ? 'Ticked the box(es) + dropped `verify-blocked`.'
    : 'Ticked the passing box(es); kept `verify-blocked` — other item(s) not yet verified.'
  const commentArgs = ['issue', 'comment', number, '--body',
    `✅ Auto-verified ${todayUTC()} — production signal now satisfies ${statuses.filter((s) => s === 'pass').length}/${statuses.length} verify-after assertion(s). ${note} (#873 Tier-A)`]
  if (repo) commentArgs.push('--repo', repo)
  gh(commentArgs)
  console.log(`\napplied: ticked ${statuses.filter((s) => s === 'pass').length} box(es) + commented${allResolved ? ' + removed verify-blocked' : ' (label kept — unresolved items remain)'}.`)
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

/** Cap a display string so an assertion on a large value (e.g. `services exists`) doesn't dump the blob. */
export function truncate(s, max = 120) {
  if (s == null) return String(s)
  return s.length <= max ? s : `${s.slice(0, max)}… (${s.length} chars)`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[verify-assertions] failed:', e); process.exit(1) })
}

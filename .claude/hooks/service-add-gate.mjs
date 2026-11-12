#!/usr/bin/env node
// #1974 Phase 2 — HARD-DENY on adding a service before its Step-0 audit exists (PreToolUse,
// Edit|Write|MultiEdit). The audit is `scripts/service-step0.mjs`; this hook only asks whether the issue
// the branch is named for carries a block that passes `check` with `verdict: add`.
//
// It fires on an edit of `worker/src/services.ts` that introduces an `id:` the file did not have. The
// issue number comes from the branch name (`{type}/{N}-{desc}`), the block from the LAST `## Step-0 audit`
// in the issue body or its comments (a later block supersedes an earlier one).
//
// Fails OPEN when the check cannot be made, and writes a `skip` audit line so a gate that has gone blind
// is visible. It denies only on a
// fact: no issue number on the branch, no block, a block that fails `check`, or a block that says `hold`.
// No override phrase: the way to lift it is a passing block in the issue.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AUDIT_FILE = process.env.HOOK_AUDIT_LOG ? path.resolve(process.env.HOOK_AUDIT_LOG) : path.join(HERE, '..', 'hook-audit.jsonl')

export const SERVICES_FILE_RE = /(?:^|\/)worker\/src\/services\.ts$/
const ID_RE = /^\s*\{\s*id:\s*(['"])([^'"]+)\1/gm
const BRANCH_ISSUE_RE = /^[A-Za-z0-9._-]+\/(\d+)-/
const HEADING_RE = /^##\s+Step-0 audit\s*$/gm
const FENCE_RE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm

export function auditLine(decision, note = '', ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
  const esc = String(note).replace(/\p{Cc}+/gu, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `{"ts":"${ts}","hook":"service-add-gate","decision":"${decision}","note":"${esc}"}`
}
function audit(decision, note = '') {
  try { fs.appendFileSync(AUDIT_FILE, `${auditLine(decision, note)}\n`) } catch { /* a logging failure must never break the turn */ }
}

const idsIn = (text) => new Set([...String(text ?? '').matchAll(ID_RE)].map((m) => m[2]))

/** The ids an edit introduces: in the new text, absent from the file as it stands. */
export function addedIds(tool, input, currentText = '') {
  const had = idsIn(currentText)
  const texts = tool === 'Write' ? [input.content] : (tool === 'MultiEdit' ? input.edits ?? [] : [input]).map((e) => e.new_string)
  return [...new Set(texts.flatMap((t) => [...idsIn(t)]))].filter((id) => !had.has(id))
}

export const branchIssue = (branch) => BRANCH_ISSUE_RE.exec(branch ?? '')?.[1] ?? null

/** Every Step-0 block, in order (body, then comments). A block inside a code fence is a quotation, not a record. */
export function step0Blocks(texts) {
  const blocks = []
  for (const raw of texts) {
    const text = String(raw ?? '').replace(FENCE_RE, '')
    const starts = [...text.matchAll(HEADING_RE)].map((m) => m.index)
    starts.forEach((at, i) => blocks.push(text.slice(at, starts[i + 1])))
  }
  return blocks
}

/** `step0` is `{ parseStep0, checkStep0 }`. Returns `{ allow, reason }`; a deny reason is a fact about the block. */
export function decide({ ids, issue, texts, step0 }) {
  if (ids.length === 0) return { allow: true, reason: 'no-new-id' }
  if (!issue) return { allow: false, reason: 'no-issue' }
  const blocks = step0Blocks(texts)
  if (blocks.length === 0) return { allow: false, reason: 'no-block' }
  const block = blocks[blocks.length - 1]
  const checked = step0.checkStep0(block)
  if (!checked.ok) return { allow: false, reason: `check-failed:${checked.errors.map((e) => (e.row ? `${e.code}:${e.row}` : e.code)).join(',')}` }
  if (step0.parseStep0(block).verdict !== 'add') return { allow: false, reason: 'verdict-not-add' }
  return { allow: true, reason: 'pass' }
}

const denyJson = (reason) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })

const GUIDANCE = 'Put a Step-0 block that passes `node scripts/service-step0.mjs check` and says `verdict: add` in the issue the branch is named for (#1974), then retry.'

export function denyMessage(reason, ids, issue) {
  const what = `adds service id ${ids.map((i) => `"${i}"`).join(', ')} to worker/src/services.ts`
  const why = {
    'no-issue': 'the branch name has no issue number ({type}/{N}-{desc}), so there is no issue to hold the Step-0 block',
    'no-block': `issue #${issue} has no "## Step-0 audit" block outside a code fence or quote`,
    'verdict-not-add': `the latest Step-0 block in issue #${issue} does not say \`verdict: add\``,
  }[reason] ?? `the latest Step-0 block in issue #${issue} fails check (${reason.replace('check-failed:', '')})`
  return `#1974: this edit ${what}, and ${why}. ${GUIDANCE}`
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim()
}

function readIssue(dir, number) {
  const raw = execFileSync('gh', ['issue', 'view', number, '--json', 'body,comments'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 })
  const j = JSON.parse(raw)
  return [j.body ?? '', ...(j.comments ?? []).map((c) => c.body ?? '')]
}

async function main() {
  let input
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { return }
  const tool = input.tool_name
  if (!['Edit', 'Write', 'MultiEdit'].includes(tool)) return
  const ti = input.tool_input ?? {}
  const file = path.resolve(input.cwd || process.cwd(), ti.file_path ?? '')
  if (!SERVICES_FILE_RE.test(file.split(path.sep).join('/'))) return

  let ids
  try {
    let current = ''
    try { current = fs.readFileSync(file, 'utf8') } catch (e) { if (e?.code !== 'ENOENT') throw e }
    ids = addedIds(tool, ti, current)
  } catch { audit('skip', 'cannot-read-edit'); return }
  if (ids.length === 0) return

  let step0
  try {
    const mod = await import(pathToFileURL(path.join(HERE, '..', '..', 'scripts', 'service-step0.mjs')).href)
    step0 = { parseStep0: mod.parseStep0, checkStep0: mod.checkStep0 }
  } catch { audit('skip', 'step0-module-missing'); return }

  const dir = path.dirname(file)
  let issue
  try {
    const branch = git(dir, 'branch', '--show-current')
    if (!branch) { audit('skip', 'detached-head'); return }
    issue = branchIssue(branch)
  } catch { audit('skip', 'git-failed'); return }
  let texts = []
  if (issue) {
    try { texts = readIssue(dir, issue) } catch { audit('skip', `gh-failed:#${issue}`); return }
  }

  const d = decide({ ids, issue, texts, step0 })
  if (d.allow) { audit('pass', `${d.reason}:${ids.join(',')}`); return }
  audit('deny', `${d.reason}:${ids.join(',')}`)
  process.stdout.write(denyJson(denyMessage(d.reason, ids, issue)))
}

function isEntryPoint() {
  try { return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1] ?? '') } catch { return false }
}
if (isEntryPoint()) main().catch(() => {})

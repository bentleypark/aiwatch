#!/usr/bin/env node
// #1298 — agent-activation gate. Two events, one rule.
//
// THE RULE. An agent definition under `.claude/agents/` only takes effect at SESSION START, so the
// session that writes one cannot spawn it: `subagent_type` resolves to "agent type not found". That is
// how #1299 came to be opened with a definition nobody had ever run — the failing check was reclassified
// as a follow-up item instead of being treated as a stop. This gate makes the sequence mechanical:
// commit → restart → spawn once → push. Until that spawn happens, the push is denied.
//
// WHY THIS ONE IS ENFORCEABLE WHERE #1150's WAS NOT. #1150 tried to deny a non-convergent review round
// and could not, because "did this fix cause this finding?" is a judgement about CONTENT and every
// design measured PHRASING as a proxy. This measures an EVENT: PostToolUse fires only after a tool
// SUCCEEDS, so a logged spawn of name N is proof that N resolved. Nothing is inferred from wording.
//
// It also passes #1150's own disqualifier — "a deny the operator cannot satisfy honestly leaves only the
// override". This one is satisfiable, and satisfying it IS the desired behaviour: restart and spawn.
//
// SCOPE, deliberately narrow. Agents ONLY. Hooks and `settings.json` have the same restart-activation
// problem but no equivalent success event — you cannot "spawn" a hook — so they are not covered and this
// gate does not pretend to. Widening it to those would be claiming coverage that does not exist.
//
// WHAT IT DOES NOT PROVE. A successful spawn of name N proves the file LOADS. It does not prove a later
// edit to that file's body took effect, since the name is unchanged. That limit is real and is why this
// is a floor, not a guarantee.
//
// DELETIONS ARE EXEMPT: a removed agent cannot be spawned.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const AUDIT_FILE = process.env.HOOK_AUDIT_LOG
  ? path.resolve(process.env.HOOK_AUDIT_LOG)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hook-audit.jsonl')

/** `.claude/agents/<name>.md` → `<name>`; anything else → null. Path-shaped, so it cannot be fooled by
 *  a file that merely mentions an agent. */
export function agentNameFromPath(p) {
  if (typeof p !== 'string') return null
  const m = p.replace(/\\/g, '/').match(/(?:^|\/)\.claude\/agents\/([^/]+)\.md$/)
  return m ? m[1] : null
}

/** Agent names ADDED or MODIFIED in a name-status diff. Deletions are exempt — a removed agent cannot
 *  be spawned, so requiring proof of a spawn would be a deny with no honest exit. */
export function changedAgentNames(nameStatus) {
  const out = new Set()
  for (const line of String(nameStatus || '').split('\n')) {
    if (!line.trim()) continue
    const [status, ...paths] = line.split('\t')
    const code = status[0]
    if (code === 'D') continue
    // For a rename (`R100 old new`) the destination is what has to resolve.
    const target = paths[paths.length - 1]
    const name = agentNameFromPath(target)
    if (name) out.add(name)
  }
  return [...out]
}

/** Is this command one that publishes work? Push and PR-create only — a local commit is where the
 *  definition is written, so gating it would deny the very step that produces the thing to verify. */
export function isPublishCommand(cmd) {
  const c = String(cmd || '')
  return /\bgit\s+push\b/.test(c) || /\bgh\s+pr\s+create\b/.test(c)
}

/** Agent names with a recorded SUCCESSFUL spawn on this branch. `branch` null → branch is ignored, which
 *  is the fail-open direction: a log line written before branches were recorded must not deny a push. */
export function spawnedAgents(auditText, branch) {
  const out = new Set()
  for (const line of String(auditText || '').split('\n')) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec?.hook !== 'agent-activation' || rec?.decision !== 'spawned') continue
    const note = String(rec.note || '')
    const m = note.match(/^agent=([^\s]+)(?:\s+branch=(.*))?$/)
    if (!m) continue
    if (branch && m[2] && m[2] !== branch) continue
    out.add(m[1])
  }
  return out
}

/** The decision. Pure, so it is testable without a repo: which changed agents lack a spawn record. */
export function unverifiedAgents(nameStatus, auditText, branch) {
  const changed = changedAgentNames(nameStatus)
  if (changed.length === 0) return []
  const spawned = spawnedAgents(auditText, branch)
  return changed.filter((n) => !spawned.has(n))
}

function appendAudit(decision, note) {
  try {
    const rec = { ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), hook: 'agent-activation', decision, note }
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + '\n')
  } catch { /* the audit log is never worth failing a hook over */ }
}

function branchOf(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  } catch { return null }
}

function main() {
  let input
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch {
    // Fail-OPEN, unlike step35. This gate protects a sequencing habit, not data integrity, and a
    // hook that cannot read its own payload has no basis to block a push.
    appendAudit('fail-open', 'unreadable payload')
    process.exit(0)
  }

  // ── PostToolUse/Task: record that a spawn SUCCEEDED. PostToolUse fires only on success, which is the
  // whole discriminator — a failed `subagent_type` resolution never reaches here.
  if (input.hook_event_name === 'PostToolUse') {
    const st = input.tool_input?.subagent_type
    if (typeof st === 'string' && st && !st.includes(':')) {
      const branch = branchOf(input.cwd || process.cwd())
      appendAudit('spawned', `agent=${st}${branch ? ` branch=${branch}` : ''}`)
    }
    process.exit(0)
  }

  // ── PreToolUse/Bash: deny a publish whose diff adds or modifies an agent nobody has spawned.
  const cmd = input.tool_input?.command
  if (!isPublishCommand(cmd)) process.exit(0)

  const cwd = input.cwd || process.cwd()
  let nameStatus = ''
  try {
    // Everything this branch would publish, vs the upstream default branch.
    nameStatus = execFileSync('git', ['diff', '--name-status', 'origin/main...HEAD'], { cwd, encoding: 'utf8' })
  } catch {
    appendAudit('fail-open', 'diff unavailable')
    process.exit(0)
  }

  let auditText = ''
  try { auditText = fs.readFileSync(AUDIT_FILE, 'utf8') } catch { /* no log yet */ }

  const pending = unverifiedAgents(nameStatus, auditText, branchOf(cwd))
  if (pending.length === 0) process.exit(0)

  appendAudit('deny', `unverified=${pending.join(',')}`)
  console.error(
    `BLOCKED — agent definition(s) never spawned: ${pending.join(', ')}\n` +
    `\n` +
    `An agent under .claude/agents/ loads at SESSION START, so this session cannot have run it. ` +
    `Pushing now publishes a definition nobody has executed — that is how #1299 shipped a "not verified" caveat.\n` +
    `\n` +
    `To satisfy this honestly: restart a session rooted in THIS worktree (agent discovery follows cwd, ` +
    `verified on #1298), spawn the agent once so it resolves, then push. A failed spawn is a stop, not a ` +
    `follow-up item.\n` +
    `\n` +
    `Scope note: this covers agents only. Hooks and settings.json have the same restart problem and no ` +
    `equivalent success event, so they are NOT gated here.`,
  )
  process.exit(2)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()

// #657 follow-up — unit tests for hook-audit-summary.mjs's step-3.5 gate handling. Run with
// `npm run test:scripts`. Drives the script against a temp fixture via the HOOK_AUDIT_LOG override so
// the real (gitignored) log is untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A recent ts (within the last-7-days window) so violations land in the "last 7d" tally.
const TS = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const line = (hook, decision, note = '') => JSON.stringify({ ts: TS, hook, decision, note })

function runSummary(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'hookaudit-'))
  const log = join(dir, 'hook-audit.jsonl')
  writeFileSync(log, entries.join('\n') + '\n')
  return execFileSync('node', ['scripts/hook-audit-summary.mjs', '--days', '30'], {
    encoding: 'utf8',
    env: { ...process.env, HOOK_AUDIT_LOG: log },
  })
}

test('summary surfaces a dedicated step-3.5 gate section with deny/pass + reasons', () => {
  const out = runSummary([
    line('step35-verify-gate', 'deny', 'commit:no-confirmation'),
    line('step35-verify-gate', 'pass', 'commit:confirmed'),
  ])
  assert.match(out, /step-3\.5 hard gate \(#657\)/)
  assert.match(out, /1 deny · 1 pass/)
  assert.match(out, /commit:no-confirmation=1/)
})

test('a step35 commit-deny counts as an intercepted violation; pass + fail-closed do NOT', () => {
  const out = runSummary([
    line('step35-verify-gate', 'deny', 'commit:no-confirmation'), // violation
    line('step35-verify-gate', 'deny', 'fail-closed'),            // gate-health, NOT a violation
    line('step35-verify-gate', 'pass', 'commit:confirmed'),       // allowed, NOT a violation
  ])
  // Exactly one intercepted violation (the commit-deny), shown as a step35-tagged kind.
  assert.match(out, /Violations intercepted[\s\S]*?\n\s+1 total/)
  assert.match(out, /step35:no-confirmation=1/)
  // fail-closed is reported as a gate-health line, not folded into the violation tally.
  assert.match(out, /fail-closed=1/)
  assert.match(out, /gate-health/)
})

test('per-day trend includes a deny column', () => {
  const out = runSummary([line('step35-verify-gate', 'deny', 'commit:no-confirmation')])
  assert.match(out, /\| deny \|/)
})

test('a pass via override is surfaced as the false-positive proxy; a confirmed pass is not', () => {
  const withOverride = runSummary([
    line('step35-verify-gate', 'pass', 'commit:override'),
    line('step35-verify-gate', 'pass', 'commit:confirmed'),
  ])
  assert.match(withOverride, /override=1 pass/)
  assert.match(withOverride, /false-positive proxy/)
  // A clean run (only genuine confirmations) must NOT print the override caveat line.
  const cleanOnly = runSummary([line('step35-verify-gate', 'pass', 'commit:confirmed')])
  assert.doesNotMatch(cleanOnly, /override=/)
})

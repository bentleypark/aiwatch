// #937 — integration tests for the git-mutation-gate.sh methodology-coupling reminder.
// Spawns the REAL hook against a crafted temp git repo (not a parallel reimplementation),
// so the shell decision logic is what's actually under test. Run via `npm run test:scripts`.
//
// The reminder fires only when the staged diff includes docs/reference/status-determination.md
// (the canonical rules) but NOT api/_methodology/html-template.ts (the public /methodology §2
// mirror). Everything else — both staged, only the page, neither, a non-commit op, a non-repo
// cwd (fail-open) — must NOT fire it. The other reminders (step 3.5, docs-drift) are unaffected.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const HOOK_SRC = join(REPO_ROOT, '.claude', 'hooks')

// Marker unique to the #937 reminder (the 🔗 line), stable across wording tweaks.
const METH_MARKER = '/methodology §2'

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gmg-937-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir })
  // Copy the real hook + its audit helper into the temp repo so HOOK_DIR-relative
  // audit writes land in (and die with) the temp dir — no real hook-audit.jsonl pollution.
  mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true })
  for (const f of ['git-mutation-gate.sh', '_audit.sh']) {
    cpSync(join(HOOK_SRC, f), join(dir, '.claude', 'hooks', f))
  }
  return dir
}

function stage(dir, rel, body = 'x\n') {
  const abs = join(dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
  execFileSync('git', ['add', '--', rel], { cwd: dir })
}

// Run the copied hook with a crafted PreToolUse INPUT; return the systemMessage string.
function runHook(dir, command = 'git commit -m "x"', cwdOverride) {
  const cwd = cwdOverride ?? dir
  const res = spawnSync('bash', [join(dir, '.claude', 'hooks', 'git-mutation-gate.sh')], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, `hook must exit 0 (soft); stderr: ${res.stderr}`)
  if (!res.stdout.trim()) return '' // non-matching command → no output
  const parsed = JSON.parse(res.stdout)
  return parsed.systemMessage ?? ''
}

const STATUSDET = 'docs/reference/status-determination.md'
const METHPAGE = 'api/_methodology/html-template.ts'

test('fires when status-determination.md is staged but the methodology page is not', () => {
  const dir = makeRepo()
  try {
    stage(dir, STATUSDET)
    const msg = runHook(dir)
    assert.ok(msg.includes(METH_MARKER), `expected methodology reminder; got:\n${msg}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('does NOT fire when both the rules doc and the methodology page are staged', () => {
  const dir = makeRepo()
  try {
    stage(dir, STATUSDET)
    stage(dir, METHPAGE)
    const msg = runHook(dir)
    assert.ok(!msg.includes(METH_MARKER), `expected NO reminder; got:\n${msg}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('does NOT fire when only the methodology page is staged', () => {
  const dir = makeRepo()
  try {
    stage(dir, METHPAGE)
    const msg = runHook(dir)
    assert.ok(!msg.includes(METH_MARKER))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('does NOT fire for an unrelated staged file', () => {
  const dir = makeRepo()
  try {
    stage(dir, 'worker/src/score.ts')
    const msg = runHook(dir)
    assert.ok(!msg.includes(METH_MARKER))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('does NOT fire for a substring-similar path (locks in ^…$ anchoring)', () => {
  // Guards the precision the "high-precision reminder" claim rests on: a future regex loosening
  // (dropping ^/$) would start matching these near-misses. Both must stay silent.
  const dir = makeRepo()
  try {
    stage(dir, 'docs/reference/status-determination.md.bak')      // trailing suffix
    stage(dir, 'archive/docs/reference/status-determination.md')  // nested prefix
    const msg = runHook(dir)
    assert.ok(!msg.includes(METH_MARKER), `near-miss paths must not fire; got:\n${msg}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('does NOT fire on a non-commit mutation (git push) even with the rules doc staged', () => {
  const dir = makeRepo()
  try {
    stage(dir, STATUSDET)
    const msg = runHook(dir, 'git push origin HEAD')
    assert.ok(!msg.includes(METH_MARKER))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fail-open: a non-git cwd never fires the reminder and still exits 0 with the base message', () => {
  const dir = makeRepo()
  const nonRepo = mkdtempSync(join(tmpdir(), 'gmg-937-nogit-'))
  try {
    stage(dir, STATUSDET) // staged in the real repo, but the hook is told to cd to a non-repo
    const msg = runHook(dir, 'git commit -m "x"', nonRepo)
    assert.ok(!msg.includes(METH_MARKER))
    assert.ok(msg.includes('step 3.5'), 'base step-3.5 reminder must still be present')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(nonRepo, { recursive: true, force: true })
  }
})

test('the reminder coexists with the step-3.5 reminder (both present)', () => {
  const dir = makeRepo()
  try {
    stage(dir, STATUSDET)
    const msg = runHook(dir)
    assert.ok(msg.includes(METH_MARKER))
    assert.ok(msg.includes('step 3.5'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── Truncated-id guard (#1053 retro) ───────────────────────────────────────────────────────────
// A backtick `…`(U+2026)-elided identifier recorded as evidence invites a splice (the #1053 chimera
// `#f2c4fda9…c3310`). Marker is a stable substring of the ✂️ warning.
const TRUNC_MARKER = 'truncated identifier'

test('truncated-id: FIRES on a `…`-elided id in an added comment, and names the token', () => {
  const dir = makeRepo()
  try {
    stage(dir, 'worker/src/foo.ts', '// evidence: huggingface `#f2c4fda9…c3310` off the wire\n')
    const msg = runHook(dir)
    assert.ok(msg.includes(TRUNC_MARKER), `expected truncated-id warning; got:\n${msg}`)
    assert.ok(msg.includes('f2c4fda9…'), `warning must name the offending token; got:\n${msg}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('truncated-id: FIRES on a head-only elision too (`01KXN0VF…`)', () => {
  const dir = makeRepo()
  try {
    stage(dir, 'worker/src/foo.ts', '// replicate id `01KXN0VF…`\n')
    const msg = runHook(dir)
    assert.ok(msg.includes(TRUNC_MARKER), `got:\n${msg}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('truncated-id: SILENT on a FULL id in backticks (no `…`)', () => {
  const dir = makeRepo()
  try {
    stage(dir, 'worker/src/foo.ts', '// id `#f2c4fda9badba95128e25e85914727efd6d44476a8434b4e8f57fdc0ccf5912c`\n')
    const msg = runHook(dir)
    assert.ok(!msg.includes(TRUNC_MARKER), `a full id must not fire; got:\n${msg}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('truncated-id: SILENT on prose `…` after a digitless word (`something…`)', () => {
  const dir = makeRepo()
  try {
    stage(dir, 'worker/src/foo.ts', '// keep the fact in one place `something…` and move on\n')
    const msg = runHook(dir)
    assert.ok(!msg.includes(TRUNC_MARKER), `digitless word must not fire; got:\n${msg}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('truncated-id: SILENT on ASCII `...` (spread / chains / prose are not U+2026)', () => {
  const dir = makeRepo()
  try {
    // `config99...rest` has a digit-bearing >=6 token before `...`, so ONLY the U+2026 scoping keeps it quiet.
    stage(dir, 'worker/src/foo.ts', '// spread `config99...rest` and a range `1...10`\n')
    const msg = runHook(dir)
    assert.ok(!msg.includes(TRUNC_MARKER), `ASCII ... must not fire; got:\n${msg}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('truncated-id: SILENT when the `…` id is NOT inside backticks', () => {
  const dir = makeRepo()
  try {
    stage(dir, 'worker/src/foo.ts', '// bare prose f2c4fda9…c3310 with no backticks\n')
    const msg = runHook(dir)
    assert.ok(!msg.includes(TRUNC_MARKER), `outside backticks must not fire; got:\n${msg}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('truncated-id: SILENT on a digitless path-like token in backticks (`reference…`)', () => {
  const dir = makeRepo()
  try {
    stage(dir, 'worker/src/foo.ts', '// see `docs/reference…` for more\n')
    const msg = runHook(dir)
    assert.ok(!msg.includes(TRUNC_MARKER), `digitless token must not fire; got:\n${msg}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('truncated-id: does NOT fire on a non-commit mutation (git push) even with a truncated id', () => {
  const dir = makeRepo()
  try {
    stage(dir, 'worker/src/foo.ts', '// id `7gpjd8n5…`\n')
    const msg = runHook(dir, 'git push origin HEAD')
    assert.ok(!msg.includes(TRUNC_MARKER), `push must not fire; got:\n${msg}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Tests for the instruction-budget ratchet (#1285). The guard's default outcome is pass, so the tests
// that matter are the ones that make it fail — and the CLI tests below run the SHIPPED script rather
// than re-implementing its main block, because that script is the whole of what the CI job executes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  charCount, measure, verdict, report, parseArgs,
  ALWAYS_LOADED, BUDGET_CHARS, MAX_SLACK,
} from './check-instruction-budget.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(REPO, 'scripts', 'check-instruction-budget.mjs')
const read = (rel) => readFileSync(join(REPO, rel), 'utf8')

/** A temp tree holding the REAL always-loaded layout, so the CLI tests can never drift into
 *  exercising a different file set than production. */
function fixtureRoot(chars) {
  const dir = mkdtempSync(join(tmpdir(), 'ib-'))
  for (const f of ALWAYS_LOADED) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), 'x'.repeat(chars))
  }
  return { dir, total: chars * ALWAYS_LOADED.length }
}

test('charCount — code points, not bytes, and not UTF-16 units', () => {
  // A byte cap would tighten whenever Korean prose replaced English, which is unrelated to density.
  assert.equal(charCount('abc'), 3)
  assert.equal(charCount('한글'), 2)
  assert.equal(Buffer.byteLength('한글'), 6)
  // The astral case is the one that separates code points from `.length`. Without it, `[...text]`
  // could degrade to `text.length` and every BMP example above would still pass.
  assert.equal(charCount('🚀'), 1)
  assert.equal('🚀'.length, 2)
  assert.equal(charCount(''), 0)
  assert.equal(charCount(undefined), 0)
})

test('verdict — the boundary, in both directions', () => {
  const at = [{ file: 'a', chars: 100 }]
  assert.equal(verdict(at, 100).status, 'ok', 'exactly at budget passes')
  assert.equal(verdict(at, 99).status, 'over', 'one over fails')
  assert.equal(verdict(at, 99).over, 1)
  assert.equal(verdict(at, 101).over, -1)
})

test('verdict — a cap that stopped binding is ALSO a failure', () => {
  // Otherwise trimming 2,000 chars silently re-opens 2,000 chars of ratchet. Reached either by
  // shrinking the files or by raising the cap too far; the remedy is the same edit.
  const parts = [{ file: 'a', chars: 100 }]
  assert.equal(verdict(parts, 100 + MAX_SLACK).status, 'ok', 'slack exactly at the limit still passes')
  assert.equal(verdict(parts, 100 + MAX_SLACK + 1).status, 'loose')
  assert.equal(verdict(parts, 100 + MAX_SLACK + 1).slack, MAX_SLACK + 1)
})

test('verdict — an unusable budget throws instead of passing through NaN', () => {
  // `NaN` loses every comparison, so coercion would have produced status:'ok' over a set of any size.
  const parts = [{ file: 'a', chars: 100 }]
  for (const bad of [NaN, Infinity, 0, -1, null]) {
    assert.throws(() => verdict(parts, bad), /not a positive number/, `budget ${bad} must be refused`)
  }
})

test('verdict — sums every always-loaded file, not just the biggest', () => {
  // The per-turn hook injection is small; dropping it from the sum would hide a doubling of it.
  const v = verdict([{ file: 'a', chars: 60 }, { file: 'b', chars: 50 }], 100)
  assert.equal(v.total, 110)
  assert.equal(v.status, 'over')
})

test('parseArgs — refuses anything it does not understand', () => {
  assert.deepEqual(parseArgs([]), {})
  assert.deepEqual(parseArgs(['--root=/tmp/x', '--budget=42']), { root: '/tmp/x', budget: 42 })
  for (const bad of ['--budget=abc', '--budget=', '--budget=0', '--budget=-1', '--budget=1e400']) {
    assert.throws(() => parseArgs([bad]), /not a positive number/, `${bad} must be refused`)
  }
  assert.throws(() => parseArgs(['--quiet']), /unrecognised argument/)
  // `--root=$UNSET_VAR` would otherwise measure the real repo while the caller believes otherwise.
  assert.throws(() => parseArgs(['--root=']), /--root= is empty/)
})

test('measure — a MISSING always-loaded file throws rather than scoring zero', () => {
  // Silently scoring 0 would let a rename shrink the measured total while the real context is
  // unchanged — the guard would go green by going blind.
  const dir = mkdtempSync(join(tmpdir(), 'ib-'))
  writeFileSync(join(dir, 'CLAUDE.md'), 'x')
  assert.throws(() => measure(['CLAUDE.md', 'gone.txt'], dir), /gone\.txt not found/)
  // Truncation reaches the same zero a rename does, and the guard must not read it as a reduction.
  writeFileSync(join(dir, 'empty.md'), '')
  assert.throws(() => measure(['empty.md'], dir), /empty\.md is empty/)
})

test('measure — reads the real files it names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ib-'))
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'CLAUDE.md'), '한글한글')
  writeFileSync(join(dir, 'sub', 'gates.txt'), 'abc')
  assert.deepEqual(measure(['CLAUDE.md', 'sub/gates.txt'], dir), [
    { file: 'CLAUDE.md', chars: 4 }, { file: 'sub/gates.txt', chars: 3 },
  ])
})

test('report — each failing status names its own remedy', () => {
  const parts = [{ file: 'CLAUDE.md', chars: 120 }]
  const over = report(verdict(parts, 100), parts)
  assert.match(over, /OVER by 20/)
  assert.match(over, /docs\/reference/, 'says where detail should go instead')
  assert.match(over, /BUDGET_CHARS/, 'says the cap can be raised deliberately')

  const loose = report(verdict(parts, 120 + MAX_SLACK + 1), parts)
  assert.match(loose, /SLACK/)
  assert.match(loose, /BUDGET_CHARS = 120/, 'names the exact number to ratchet down to')
  assert.doesNotMatch(report(verdict(parts, 200), parts), /❌/)
})

test('ALWAYS_LOADED is the set this cap was agreed on', () => {
  // A literal pin, deliberately: adding or dropping a measured file changes what the cap means, so it
  // has to move this line too — the same mechanism as BUDGET_CHARS. This does NOT verify that the set
  // is COMPLETE; nothing here can (see the limitation recorded in docs/reference/workflow-hooks.md).
  assert.deepEqual(ALWAYS_LOADED, ['CLAUDE.md', '.claude/hooks/workflow-gates.txt'])
})

test('MAX_SLACK stays a small fraction of the budget it is a tolerance on', () => {
  // Every other slack assertion is written in terms of MAX_SLACK, so widening the constant moves all
  // of them with it: every OTHER slack assertion is written in terms of
  // MAX_SLACK, so widening the constant moves them all with it.
  assert.ok(MAX_SLACK > 0)
  assert.ok(MAX_SLACK <= BUDGET_CHARS * 0.02, `MAX_SLACK ${MAX_SLACK} is more than 2% of the budget`)
})

test('the REAL always-loaded set is exactly at its budget — neither over nor slack', () => {
  // The assertion that gates this repo rather than a fixture. Failing means either the context grew,
  // or it shrank far enough that BUDGET_CHARS must ratchet down in the same PR.
  const parts = measure()
  const v = verdict(parts)
  assert.equal(v.status, 'ok', report(v, parts))
})

test('npm run test:scripts still runs every scripts/*.test.mjs, unconditionally', () => {
  // The coverage story for .claude/hooks/workflow-gates.txt is "test:scripts runs on code PRs".
  // Exact equality, not a substring match: `node --test scripts/*.test.mjs || true` contains the glob
  // and disarms the entire suite.
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.scripts['test:scripts'], 'node --test scripts/*.test.mjs')
})

// --- the SHIPPED binary, executed --------------------------------------------------------------
// Everything above tests exported functions. `isMain()` and `process.exit` are what turn them into a
// CI verdict, and the Docs Lint job runs nothing else.
const runCli = (args = []) => {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { stdout, stderr: '', code: 0 }
  } catch (e) { return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status } }
}

test('CLI — the shipped script exits 0 on the real repo and lists every measured file', () => {
  const r = runCli()
  assert.equal(r.code, 0)
  assert.match(r.stdout, new RegExp(`✅ instruction budget: \\d+ / ${BUDGET_CHARS} chars`))
  for (const f of ALWAYS_LOADED) assert.ok(r.stdout.includes(f), `${f} missing from the report table`)
})

test('CLI — the shipped script exits 1 over budget, and 1 on runaway slack', () => {
  const { dir, total } = fixtureRoot(600)
  const over = runCli([`--root=${dir}`, `--budget=${total - 200}`])
  assert.equal(over.code, 1, 'an over-budget set must fail the job, not just print')
  assert.match(over.stdout, /OVER by 200/)

  const loose = runCli([`--root=${dir}`, `--budget=${total + MAX_SLACK + 1}`])
  assert.equal(loose.code, 1, 'a cap that stopped binding must fail the job too')
  assert.match(loose.stdout, /SLACK/)

  const ok = runCli([`--root=${dir}`, `--budget=${total}`])
  assert.equal(ok.code, 0)
  assert.match(ok.stdout, /✅/)
})

test('CLI — a malformed budget fails loudly; it must never coerce to a passing verdict', () => {
  const { dir } = fixtureRoot(500_000)
  const r = runCli([`--root=${dir}`, '--budget=abc'])
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.stdout, /✅/, 'a green marker over an unmeasurable budget is the worst outcome')
  assert.match(r.stderr, /--budget=abc is not a positive number/)
})

test('CLI — a missing always-loaded file fails the job loudly, never silently green', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ib-'))
  writeFileSync(join(dir, 'CLAUDE.md'), 'x')
  const r = runCli([`--root=${dir}`])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /not found — update ALWAYS_LOADED/, 'exit 1 alone cannot be told from a crash')
})


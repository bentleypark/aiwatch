import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDiff, proseUnits, sentences, audit, summarize, report, parseArgs, MARKERS } from './audit-new-prose.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'audit-new-prose.mjs')
const all = (n) => new Set(Array.from({ length: n }, (_, i) => i + 1))
const markersOf = (text) => audit('x.md', text, all(1))[0]?.markers ?? null

test('parseDiff reads added line numbers per file and ignores deletions and removed files', () => {
  const diff = [
    'diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -3,2 +3,3 @@', '-old', '+new one', '+new two', '+new three',
    '@@ -20 +22 @@', '-x', '+y',
    'diff --git a/gone.md b/gone.md', '--- a/gone.md', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
  ].join('\n')
  const added = parseDiff(diff)
  assert.deepEqual([...added.get('a.md')], [3, 4, 5, 22])
  assert.equal(added.has('gone.md'), false)
  // A deletion must not surface under ANY key — this catches a regression that maps it to the raw
  // header text ('/dev/null', truthy, so a `file &&` guard alone would not exclude it) instead of
  // to the `null` the code actually assigns.
  assert.deepEqual([...added.keys()], ['a.md'])
  assert.deepEqual([...parseDiff('+++ b/my notes.md\t\n@@ -0,0 +1 @@\n+x').keys()], ['my notes.md'])
})

test('parseDiff treats a `+++ `-prefixed CONTENT line as an addition, never as a fake file header', () => {
  // The line's OWN text starts with a space after the marker — `+++ this looks like a header` —
  // which is the one shape that could be confused for the real `+++ b/path` header if recognition
  // were not gated on hunk position; a case missing the space (e.g. content `++i` -> line `+++i`)
  // can never match the `'+++ '` check regardless, so it would not exercise this guard at all.
  const diff = [
    'diff --git a/a.mjs b/a.mjs', '--- a/a.mjs', '+++ b/a.mjs', '@@ -0,0 +1,2 @@', '+++ this looks like a header, but is not', '+// real comment line',
  ].join('\n')
  const added = parseDiff(diff)
  assert.deepEqual([...added.keys()], ['a.mjs'])
  assert.deepEqual([...added.get('a.mjs')], [1, 2])
})

test('parseDiff unescapes a git-C-quoted path (quote, tab, BEL or an astral character in the name) on the `+++ ` header line', () => {
  // core.quotepath=false (which this tool always passes to git) makes git emit a non-ASCII
  // character LITERALLY inside the quotes rather than as an octal byte escape — verified against
  // real `git diff` output, not assumed: `git -c core.quotepath=false diff` on a file named
  // `q"😀.md` prints `"a/q\"😀.md"`, the emoji unescaped. Only the quote itself is backslash-escaped.
  const diff = [
    'diff --git "a/q\\"uote.md" "b/q\\"uote.md"', '--- "a/q\\"uote.md"', '+++ "b/q\\"uote.md"', '@@ -0,0 +1 @@', '+x',
    'diff --git "a/tab\\there.md" "b/tab\\there.md"', '--- "a/tab\\there.md"', '+++ "b/tab\\there.md"', '@@ -0,0 +1 @@', '+y',
    'diff --git "a/bel\\ax.md" "b/bel\\ax.md"', '--- "a/bel\\ax.md"', '+++ "b/bel\\ax.md"', '@@ -0,0 +1 @@', '+z',
    'diff --git "a/q\\"😀.md" "b/q\\"😀.md"', '--- "a/q\\"😀.md"', '+++ "b/q\\"😀.md"', '@@ -0,0 +1 @@', '+w',
  ].join('\n')
  const added = parseDiff(diff)
  assert.deepEqual([...added.keys()], ['q"uote.md', 'tab\there.md', 'bel\x07x.md', 'q"😀.md'])
})

test('markdown: only prose survives — fences, front matter, headings, table separators and blanks are dropped', () => {
  const md = ['---', 'title: x', '---', '# Heading here', '', 'A paragraph that spans', 'two lines of prose.', '```', 'code fence body words here now', '```', '|---|---|', '| `key` | Value describes the thing plainly |', '- A list item with enough words'].join('\n')
  const units = proseUnits('a.md', md)
  assert.deepEqual(units.map((u) => u.parts.map((p) => p.text).join(' ')), [
    'A paragraph that spans two lines of prose.',
    '`key` | Value describes the thing plainly',
    'A list item with enough words',
  ])
})

test('code: line, block, JSDoc and hash comments are read; trailing comments and shebangs are not', () => {
  const js = ['#!/usr/bin/env node', '// first line of a comment', '// second line of it', 'const a = 1 // trailing remark here now', '/**', ' * Block words on a star line.', ' */'].join('\n')
  const comments = proseUnits('a.mjs', js).filter((u) => u.kind === 'comment')
  assert.deepEqual(comments.map((u) => u.parts.map((p) => p.text.trim()).join(' ').trim()), ['first line of a comment second line of it', 'Block words on a star line.'])
  const sh = proseUnits('a.sh', '#!/bin/sh\n# A shell comment with words.\necho hi')
  assert.deepEqual(sh.map((u) => u.parts[0].text), ['A shell comment with words.'])
})

test('strings count only when sentence-length, and never in test files', () => {
  const src = "const a = 'short one'\nconst b = 'This message is long enough to count as a claim here'"
  assert.deepEqual(proseUnits('a.ts', src).filter((u) => u.kind === 'string').map((u) => u.parts[0].text), ['This message is long enough to count as a claim here'])
  assert.deepEqual(proseUnits('a.test.ts', src), [])
  assert.deepEqual(proseUnits('__tests__/a.ts', src), [])
})

test('sentences: splits on terminators, keeps e.g. together, drops fragments, maps a sentence to its lines', () => {
  const unit = { kind: 'comment', parts: [{ line: 10, text: 'The first sentence runs' }, { line: 11, text: 'over two lines. Second one, e.g. Foo and bar, stays whole. Too short.' }] }
  const out = sentences(unit)
  assert.deepEqual(out.map((s) => s.text), ['The first sentence runs over two lines.', 'Second one, e.g. Foo and bar, stays whole.'])
  assert.deepEqual([out[0].startLine, out[0].endLine], [10, 11])
  assert.deepEqual([out[1].startLine, out[1].endLine], [11, 11])
})

test('audit reports a sentence when any of its lines was added, and none otherwise', () => {
  const text = ['// A sentence that wraps across', '// three separate comment lines here.', '// Another untouched sentence stays out.'].join('\n')
  assert.equal(audit('a.mjs', text, new Set([2])).length, 1)
  assert.equal(audit('a.mjs', text, new Set([3])).length, 1)
  assert.equal(audit('a.mjs', text, new Set([9])).length, 0)
})

// Positive controls assert dates, causes, quantities or negated behaviour; negative controls are
// labels, links, definitions, and a structural claim the marker regexes miss (a known gap, listed
// separately below rather than folded into "negative").
test('markers flag sentences that assert dates, causes, quantities and negated behaviour', () => {
  assert.deepEqual(markersOf('A redeploy alone did not restore it on 2026-09-23.'), ['date', 'negated'])
  assert.deepEqual(markersOf('The 2026-09-23 stall began within a minute of a deploy, so read the heartbeat once.'), ['date', 'history'])
  assert.ok(markersOf('Not gated on `probe:24h` because the failure is "no invocation", and that write sits behind a `.catch`.').includes('causal'))
  assert.ok(markersOf('Alerts, analysis and the daily summary raised during the gap were not sent and are not replayed.').includes('negated'))
  assert.ok(markersOf('Roughly 20+ min of silence is reported and the write budget is ~4% of the monthly inclusion.').includes('quantity'))
  // A bare `N%` at the end of a clause (nothing word-shaped right after the `%`) is the common case
  // in prose ("...reached 30% of...", "...rose to 30%.") — regression check for a `%` alternative
  // that was itself inside a trailing `\b`, so it silently matched nothing here.
  assert.ok(markersOf('The error rate reached 30% of all requests today.').includes('quantity'))
})

test('markers leave labels and links alone', () => {
  assert.deepEqual(markersOf('Detail: [discord-alert-paths.md](discord-alert-paths.md) holds the procedure.'), [])
  assert.deepEqual(markersOf('Status words this reader accepts here.'), [])
})

test('a structural claim with no lexical cue is a known miss, not a negative result', () => {
  assert.deepEqual(markersOf('The cron writes one key and the fetch path reads that key back.'), [])
})

test('a claim carrying an issue, a URL or a command counts as sourced', () => {
  const sourced = (t) => audit('x.md', t, all(1))[0].sourced
  assert.equal(sourced('It fires after 20 min of silence (#1501) on every run.'), true)
  assert.equal(sourced('See https://example.com/page for the 20 min figure here.'), true)
  assert.equal(sourced('Run `npx wrangler triggers deploy` after 20 min of silence.'), true)
  assert.equal(sourced('Check it with `grep -n uptimeSource worker/src/services.ts` after 20 min.'), true)
  assert.equal(sourced('It fires after 20 min of silence on every run.'), false)
})

test('a bare filename or module mention in backticks is NOT a source, even when it starts with a command word', () => {
  const sourced = (t) => audit('x.md', t, all(1))[0].sourced
  assert.equal(sourced('This module never imports `node:fs` at runtime.'), false)
  assert.equal(sourced('The `git-mutation-gate.sh` hook never blocks a commit.'), false)
  assert.equal(sourced('The `npm-run-all` wrapper is never used here anymore.'), false)
  assert.equal(sourced('Every service sets it, see `wrangler.toml` for the config.'), false)
})

test('marker ids are unique', () => {
  assert.equal(new Set(MARKERS.map(([id]) => id)).size, MARKERS.length)
})

test('the absolute marker fires on its own, with no other marker coincidentally along', () => {
  assert.deepEqual(markersOf('This check cannot succeed without a working database connection.'), ['absolute'])
})

test('summarize and report count sentences, kinds and unsourced flags, and --all lists the rest', () => {
  const findings = audit('a.md', 'Fires after 20 min of silence. A plain sentence with no cue words.', all(1))
  const s = summarize(findings)
  assert.deepEqual([s.total, s.flagged, s.unsourced, s.kinds.docs], [2, 1, 1, 2])
  assert.match(report(findings), /1 other new sentences/)
  assert.doesNotMatch(report(findings), /A plain sentence/)
  assert.match(report(findings, { all: true }), /A plain sentence/)
})

test('report prints a file\'s sentences in line order, not in the order proseUnits happened to return them', () => {
  // A comment (unit kind 'comment') on a LATER line than a string (unit kind 'string') on an
  // EARLIER line: proseUnits always returns comments before strings, so only a sort by line — not
  // array order — puts the string first here.
  const src = "const a = 'This string sentence sits on the earlier source line here'\n// This comment sentence sits on a later line than the string.\n"
  const findings = audit('a.ts', src, all(2))
  const out = report(findings, { all: true })
  const stringAt = out.indexOf('This string sentence')
  const commentAt = out.indexOf('This comment sentence')
  assert.ok(stringAt !== -1 && commentAt !== -1 && stringAt < commentAt, out)
})

test('parseArgs accepts the documented flags and throws on anything else', () => {
  assert.deepEqual(parseArgs(['--base=a', '--head=b', '--all', '--json', '--strict']), { all: true, json: true, strict: true, base: 'a', head: 'b' })
  assert.throws(() => parseArgs(['--nope']), /unrecognised/)
  assert.throws(() => parseArgs(['--base=']), /unrecognised/)
})

// The CLI tests run the shipped script over a real temp repo.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'anp-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const git = (...a) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs', 'a.md'), 'An existing sentence that nobody touched today.\n')
  git('add', '-A'); git('commit', '-qm', 'base')
  return { dir, git, base: git('rev-parse', 'HEAD') }
}
const run = (dir, ...args) => spawnSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' })

test('CLI: reports tracked edits and untracked files against a base, and leaves untouched prose out', () => {
  const { dir, base } = repo()
  writeFileSync(join(dir, 'docs', 'a.md'), 'An existing sentence that nobody touched today.\nThe outage began on 2026-09-23 and lasted 3h.\n')
  writeFileSync(join(dir, 'docs', 'new.md'), 'A brand new file that never happened before.\n')
  const r = run(dir, `--base=${base}`, '--all')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /The outage began on 2026-09-23/)
  assert.match(r.stdout, /A brand new file/)
  assert.doesNotMatch(r.stdout, /nobody touched/)
  assert.match(r.stdout, /2 new prose sentences in 2 files/)
})

test('CLI: untracked files of an unscanned type are skipped without being opened, and the skip is counted', () => {
  const { dir, base } = repo()
  symlinkSync(join(dir, 'missing-target'), join(dir, 'link.png'))
  const r = run(dir, `--base=${base}`, '--all')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /0 new prose sentences in 0 files/)
  assert.match(r.stdout, /1 file not scanned/)
})

test('CLI: a tracked edit to an unscanned type (e.g. .json) is also counted as skipped, not silently absent', () => {
  const { dir, git, base } = repo()
  writeFileSync(join(dir, 'pkg.json'), '{"claim": "This field is never read by anything at all."}\n')
  git('add', '-A'); git('commit', '-qm', 'json edit')
  const r = run(dir, `--base=${base}`)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /0 new prose sentences in 0 files/)
  assert.match(r.stdout, /1 file not scanned/)
})

test('CLI: a tracked edit under a SKIP_PATH directory is skipped and counted, even with a scanned extension', () => {
  const { dir, git, base } = repo()
  mkdirSync(join(dir, 'dist'))
  writeFileSync(join(dir, 'dist', 'notes.md'), 'The outage began on 2026-09-23 and lasted 3h.\n')
  git('add', '-A'); git('commit', '-qm', 'add dist notes')
  const r = run(dir, `--base=${base}`, '--all')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /0 new prose sentences in 0 files/)
  assert.match(r.stdout, /1 file not scanned/)
})

test('CLI: a `+++`-prefixed added line is read as content, not mistaken for a file header', () => {
  const { dir, base } = repo()
  writeFileSync(join(dir, 'docs', 'a.md'), 'An existing sentence that nobody touched today.\n++ this line starts like a diff header\nThe outage began on 2026-09-23 and lasted 3h.\n')
  const r = run(dir, `--base=${base}`, '--all')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /The outage began on 2026-09-23/)
})

test('CLI: a git-C-quoted TRACKED path (a quote or a tab in the filename) is still read via the diff header, not just via untracked ls-files', () => {
  const { dir, git } = repo()
  writeFileSync(join(dir, 'docs', 'q"uote.md'), 'placeholder\n')
  git('add', '-A'); git('commit', '-qm', 'add quoted-name file')
  const base2 = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'docs', 'q"uote.md'), 'The outage began on 2026-09-23 and lasted 3h.\n')
  const r = run(dir, `--base=${base2}`, '--all')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /q"uote\.md/)
  assert.match(r.stdout, /The outage began on 2026-09-23/)
})

test('CLI: with no --base, it defaults to the merge-base against main (no origin remote here)', () => {
  const { dir, base } = repo()
  writeFileSync(join(dir, 'docs', 'a.md'), 'An existing sentence that nobody touched today.\nThe outage began on 2026-09-23 and lasted 3h.\n')
  const r = run(dir, '--all')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /The outage began on 2026-09-23/)
  void base // the default path is what is under test, not an explicit --base
})

test('CLI: --head=REF with no --base compares against THAT ref\'s own merge-base, not the checkout\'s', () => {
  const { dir, git, base } = repo()
  git('checkout', '-qb', 'feature')
  git('checkout', '-q', 'main')
  writeFileSync(join(dir, 'docs', 'a.md'), 'Text unrelated to the feature branch entirely.\n')
  git('commit', '-qam', 'unrelated main-only edit')
  // `feature` never changed docs/a.md, so --head=feature must find nothing — even though
  // the CURRENT checkout (main) has since diverged from `base`.
  const r = run(dir, '--head=feature', '--all')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /0 new prose sentences in 0 files/)
  void base
})

test('CLI: a tracked binary or mode-only change yields no finding and no not-scanned count', () => {
  const { dir, git } = repo()
  writeFileSync(join(dir, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho hi\n')
  git('add', '-A'); git('commit', '-qm', 'add binary + script')
  const base2 = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]))
  execFileSync('chmod', ['+x', join(dir, 'run.sh')])
  const r = run(dir, `--base=${base2}`, '--strict')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /0 new prose sentences in 0 files/)
  assert.doesNotMatch(r.stdout, /not scanned/)
})

test('CLI: an unresolvable --head= fails with a message naming the ref, not the unrelated base fallback', () => {
  const { dir } = repo()
  const r = run(dir, '--head=no-such-ref')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /--head=no-such-ref does not resolve/)
  assert.doesNotMatch(r.stderr, /origin\/main or main/)
})

test('CLI: --head reads a commit instead of the working tree, and --json is parseable', () => {
  const { dir, git, base } = repo()
  writeFileSync(join(dir, 'docs', 'a.md'), 'An existing sentence that nobody touched today.\nThe outage began on 2026-09-23 and lasted 3h.\n')
  git('commit', '-qam', 'edit')
  writeFileSync(join(dir, 'docs', 'a.md'), 'Working tree text differs from the commit entirely.\n')
  const r = run(dir, `--base=${base}`, `--head=${git('rev-parse', 'HEAD')}`, '--json')
  const out = JSON.parse(r.stdout)
  assert.equal(out.findings.length, 1)
  assert.match(out.findings[0].text, /outage began/)
  assert.deepEqual(out.findings[0].markers, ['date', 'quantity', 'history'])
})

test('CLI: --strict fails on an unsourced flagged sentence and passes once it cites a source', () => {
  const { dir, base } = repo()
  writeFileSync(join(dir, 'docs', 'a.md'), 'The outage began on 2026-09-23 and lasted 3h.\n')
  assert.equal(run(dir, `--base=${base}`, '--strict').status, 1)
  assert.equal(run(dir, `--base=${base}`).status, 0)
  writeFileSync(join(dir, 'docs', 'a.md'), 'The outage began on 2026-09-23 and lasted 3h (#1501).\n')
  assert.equal(run(dir, `--base=${base}`, '--strict').status, 0)
})

test('CLI: an unrecognised flag, an unresolvable base ref, and a non-repo directory each exit non-zero', () => {
  const { dir } = repo()
  assert.equal(run(dir, '--bogus').status, 1)
  assert.equal(run(dir, '--base=does-not-exist').status, 1)
  assert.equal(run(mkdtempSync(join(tmpdir(), 'nogit-'))).status, 1)
})

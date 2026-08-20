// #1254 — the frontend change detector gates the `e2e` and `build` jobs, and it could answer
// "nothing changed" because its own command had failed.
//
//     DIFF=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || echo "")
//
// Under `actions/checkout`'s default `fetch-depth: 1`, `HEAD~1` does not exist: git failed, the
// message was discarded, and the fallback resolved to the permissive branch. E2E and Build skipped
// on every push to main while the job reported success — 12 of 12 sampled pushes, including commit
// 00e03c0, which changed 11 files under `src/`.
//
// CI cannot catch this class itself: the defect's symptom IS a green run. So `scripts/ci-detect-frontend.sh`
// is EXECUTED here against git fixtures built for each scenario, asserting the verdict it writes to
// `$GITHUB_OUTPUT`. A structural scan is not enough — an earlier draft of this file scanned the
// workflow text and stayed green when `src/` was deleted from the match set, when the verdict was
// inverted, and when the `if:` consuming it was changed to a value it never writes.
//
// The structural tests cover only what running the script cannot observe: that both jobs call it,
// with which pattern, and what consumes its output.
//
// Known limits, stated so a green run is not over-trusted:
//   - The grep-error path uses a `grep` stub on PATH, so it pins how the script REACTS to a failing
//     grep, not what real grep would answer. Only the stub's call COUNT is asserted; its flags are
//     covered behaviourally instead (dropping `-E` turns the ERE into a BRE and `src/App.jsx` stops
//     matching, which the verdict tests catch).
//   - The structural tests are spelling pins: the concurrency block must match one exact form, so a
//     semantically identical rewrite fails red. Nothing here checks that an Actions expression is
//     valid syntax, or that the runner honours it — only a run can.
//   - `fetch-depth` is asserted to be anything but 1, and every fixture is a full-depth repo, so a
//     shallow checkout's own truncation is not exercised (the script's RESPONSE to an unreachable
//     base is, via the all-zero-base test).
//   - A job-level `if:` can disable a gated step without touching the detector. Step-level `if:`
//     values are pinned exactly; a job-level one is not looked at.
//   - Nothing here runs on a GitHub runner, so runner-only behaviour (annotation rendering, an
//     absent `$GITHUB_OUTPUT`, what `actions/checkout` leaves at HEAD) is out of scope.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = '.github/workflows/test.yml'
const text = readFileSync(join(repoRoot, FILE), 'utf8')

const SCRIPT = 'scripts/ci-detect-frontend.sh'
// Invoked through `bash` in the workflow, so the exec bit — which nothing here asserts — cannot
// become a silent divergence between what CI runs and what this file runs.
const RUN = `bash ${SCRIPT}`
const scriptPath = join(repoRoot, SCRIPT)
const scriptSrc = readFileSync(scriptPath, 'utf8')

/** Drop whole-line `#` comments, so prose quoting a defect is never read as the defect. */
const stripComments = (block) => block.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

/** A named job's block, as raw text. */
export function jobBody(src, jobName) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^ {2}${jobName}:\\s*(#.*)?$`).test(l))
  if (start === -1) throw new Error(`${FILE}: job "${jobName}" not found`)
  let end = lines.length
  for (let k = start + 1; k < lines.length; k++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*(#.*)?$/.test(lines[k])) { end = k; break }
  }
  return lines.slice(start, end).join('\n')
}

/** Every job that runs the detector, with the `id:` it publishes under and the pattern it passes. */
export function detectorCalls(src) {
  const out = []
  let job = null
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const j = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(lines[i])
    if (j) job = j[1]
    const call = new RegExp(`^\\s*run: ${RUN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} '(.*)'\\s*$`).exec(lines[i])
    if (!call) continue
    let id = null
    for (let k = i - 1; k >= 0 && !/^\s*- name:/.test(lines[k]); k--) {
      id = /^\s*id: (\S+)\s*$/.exec(lines[k])
      if (id) break
    }
    if (!id) throw new Error(`${FILE}: the ${job} job runs the detector but publishes no id:`)
    const env = {}
    for (let k = i + 1; k < lines.length && !/^\s*- /.test(lines[k]); k++) {
      const kv = /^\s{10}([A-Z_]+): (.+?)\s*$/.exec(lines[k])
      if (kv) env[kv[1]] = kv[2]
    }
    out.push({ job, id: id[1], pattern: call[1], env })
  }
  if (out.length === 0) throw new Error(`${FILE}: no job runs ${SCRIPT} — the parser cannot read this file`)
  return out
}

/** The `- uses: actions/checkout@…` block of a named job, comments stripped. */
export function checkoutFor(src, jobName) {
  const lines = jobBody(src, jobName).split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*- uses: actions\/checkout@/.test(lines[i])) continue
    let end = lines.length
    for (let k = i + 1; k < lines.length; k++) {
      if (/^\s*- /.test(lines[k])) { end = k; break }
    }
    return stripComments(lines.slice(i, end).join('\n'))
  }
  throw new Error(`${FILE}: job "${jobName}" has no actions/checkout step`)
}

const calls = detectorCalls(text)
const byJob = Object.fromEntries(calls.map((c) => [c.job, c]))

// ── the harness: run the SHIPPED body ─────────────────────────────────────────────────────────────

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
const commit = (dir, msg) => {
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg)
}

// Building a fresh repo per scenario cost ~200 git processes at startup, and that is not free on a
// 2-core runner: it starved `plugin-monitor.test.mjs`'s first test into its 20s harness timeout when
// the two files ran in parallel (`0/1 polls`, empty stdout). Removing this file took that suite from
// 1 failure back to 0, which is what identified the cause.
//
// So each distinct fixture is built ONCE and then SHARED, not copied: the detector body only reads
// the repository (`git cat-file -e`, `git diff --name-only`) and writes solely to `$GITHUB_OUTPUT`,
// which lives outside it. Copying was the first attempt and was itself flaky — `cpSync` raised
// ENOENT inside `.git/objects` on 1 run in 6.
const templates = new Map()
process.on('exit', () => { for (const t of templates.values()) rmSync(t.dir, { recursive: true, force: true }) })

/**
 * Everything about a fixture a read-only body must leave untouched. Recorded once per fixture and
 * re-checked once at the end of the file, NOT per run: three `git` calls on either side of ~40 runs
 * put ~240 extra processes back into startup and re-starved `plugin-monitor.test.mjs` into its 20s
 * harness timeout — the same starvation the shared fixtures exist to avoid.
 */
const fixtureState = (dir) => [
  git(dir, 'rev-parse', 'HEAD').trim(),
  git(dir, 'status', '--porcelain'),
  git(dir, 'reflog', '--format=%H').trim(),
].join('|')

function template(spec) {
  const key = JSON.stringify(spec)
  if (!templates.has(key)) {
    const dir = mkdtempSync(join(tmpdir(), 'ci-detector-tpl-'))
    repoWith(dir, spec)
    templates.set(key, { dir, revs: new Map(), state: fixtureState(dir) })
  }
  return templates.get(key)
}

/** A git repo holding `worker/src/index.ts`, plus one commit per entry in `commits`. */
function repoWith(dir, { commits = [], merge }) {
  git(dir, 'init', '-q')
  mkdirSync(join(dir, 'worker/src'), { recursive: true })
  writeFileSync(join(dir, 'worker/src/index.ts'), 'a\n')
  git(dir, 'add', '-A')
  commit(dir, 'base')
  const applyAll = (list) => {
    for (const files of list) {
      for (const [p, content] of Object.entries(files)) {
        if (content === null) { rmSync(join(dir, p)); continue }   // null = delete: a rename is expressible
        mkdirSync(dirname(join(dir, p)), { recursive: true })
        writeFileSync(join(dir, p), content)
      }
      commit(dir, 'c')
    }
  }
  applyAll(commits)
  if (!merge) return
  const baseBranch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  git(dir, 'checkout', '-q', '-b', 'pr')
  applyAll(merge)
  git(dir, 'checkout', '-q', baseBranch)
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', '--no-ff', '--no-edit', 'pr')
}

/**
 * Execute one job's detector body and return the verdict it wrote to `$GITHUB_OUTPUT`.
 * `grepStub` is the shell body of a fake `grep` placed first on PATH. It logs its argv so a test can
 * count the calls — a second `grep` added to the script would otherwise be swallowed by the stub.
 */
function runDetector(job, { commits = [], merge, event = 'push', before = 'HEAD~1', grepStub } = {}) {
  const spec = { commits, merge }
  const dir = mkdtempSync(join(tmpdir(), 'ci-detector-'))
  try {
    const tpl = template(spec)
    const repo = tpl.dir

    let PATH = process.env.PATH
    if (grepStub) {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'grep'), `#!/bin/bash\necho "grep $*" >> "$ARGV_LOG"\n${grepStub}\n`)
      chmodSync(join(bin, 'grep'), 0o755)
      PATH = `${bin}:${PATH}`
    }

    const outFile = join(dir, 'out.txt')
    const argvFile = join(dir, 'argv.txt')
    writeFileSync(outFile, '')
    writeFileSync(argvFile, '')
    let BEFORE = before
    if (event === 'push' && /^HEAD~\d+$/.test(before)) {
      if (!tpl.revs.has(before)) tpl.revs.set(before, git(tpl.dir, 'rev-parse', before).trim())
      BEFORE = tpl.revs.get(before)
    }
    const r = spawnSync('bash', [scriptPath, byJob[job].pattern], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env, PATH, GITHUB_EVENT_NAME: event, PUSH_BASE: BEFORE,
        GITHUB_OUTPUT: outFile, ARGV_LOG: argvFile,
      },
    })
    // The step's own exit status is part of the contract: `unknown()` exits 0 on purpose, because a
    // failed step skips the gated steps too — "run everything" and "fail the job" are opposite
    // answers. Not asserting it let `exit 0` become `exit 1` with all 17 tests still green.
    assert.equal(r.status, 0, `${job}: the detector step exited ${r.status}\n${r.stdout}${r.stderr}`)
    const written = readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(written.length, 1, `${job}: expected exactly one output write, got ${written.length}`)
    const argv = readFileSync(argvFile, 'utf8').trim().split('\n').filter(Boolean)
    return { verdict: written[0], argv, log: r.stdout + r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SRC_CHANGE = [{ 'src/App.jsx': 'x\n' }]
const MERGE_MOVES_OUT_OF_SRC = [{ 'src/Foo.jsx': null, 'worker/src/Foo.ts': 'x\n' }]
const WORKER_CHANGE = [{ 'worker/src/index.ts': 'a\nb\n' }]
const GATING_JOBS = ['e2e', 'build']

// ── the verdict — what the gate actually decides ─────────────────────────────────────────────────

test('a src/ change runs both gates — the case #1254 was skipping', () => {
  for (const job of GATING_JOBS) {
    assert.equal(runDetector(job, { commits: SRC_CHANGE }).verdict, 'frontend=true',
      `${job}: a src/ push must run the gate`)
  }
})

test('a worker-only change is the ONLY thing that may skip the gate (#1254)', () => {
  for (const job of GATING_JOBS) {
    assert.equal(runDetector(job, { commits: WORKER_CHANGE }).verdict, 'frontend=false',
      `${job}: a worker-only push should still skip`)
  }
})

test('the shared match set holds in both jobs (#1254)', () => {
  for (const file of ['public/x.png', 'index.html', 'vite.config.js', 'package.json']) {
    for (const job of GATING_JOBS) {
      assert.equal(runDetector(job, { commits: [{ [file]: 'x\n' }] }).verdict, 'frontend=true',
        `${job}: ${file} dropped out of the match set`)
    }
  }
})

test('e2e alone gates on specs and on workflows; build deliberately does not (#998/#1253)', () => {
  // #998 — a tests-only PR must run E2E, or the very code it changes never runs in CI.
  // #1253 — a workflow change must too: this job's own browser-install step lives there, and a
  // change to it otherwise ships with no e2e run at all.
  // Neither needs a production build, so `build` skipping them is the design, not an omission.
  // `playwright.config.js` is listed separately from `tests/`: the pattern carries BOTH tokens, and
  // a fixture under tests/ matches whichever survives. This file is where the webServer, the project
  // matrix and the path to the #998 GA-block fixture live, so losing it skips E2E on a real change.
  for (const file of ['tests/foo.spec.js', 'playwright.config.js', '.github/workflows/test.yml']) {
    assert.equal(runDetector('e2e', { commits: [{ [file]: 'x\n' }] }).verdict, 'frontend=true',
      `e2e must run for ${file}`)
    assert.equal(runDetector('build', { commits: [{ [file]: 'x\n' }] }).verdict, 'frontend=false',
      `build should not rebuild for ${file}`)
  }
})

test('git\u2019s own path reporting cannot hide a frontend change (#1254)', () => {
  // Two shapes where `git diff --name-only` answers about a real src/ change in a form the anchored
  // pattern misses. Both were reproduced against the shipped body before being fixed:
  //   - a non-ASCII path is C-quoted by default (`"src/\\355\\225\\234…"`), and the leading quote
  //     defeats `^src/`. Zero such paths are tracked today, but this is a Korean-language repo.
  //   - rename detection reports only the destination, so moving a file OUT of src/ hides that a
  //     source file was deleted. `api/intro/* -> api/_intro/*` is that shape, on main.
  for (const job of GATING_JOBS) {
    assert.equal(runDetector(job, { commits: [{ 'src/\ud55c\uae00.js': 'x\n' }] }).verdict, 'frontend=true',
      `${job}: a non-ASCII src/ path was not seen`)
    assert.equal(
      runDetector(job, { commits: [{ 'src/Foo.jsx': 'x\n' }, { 'src/Foo.jsx': null, 'worker/src/Foo.ts': 'x\n' }] })
        .verdict,
      'frontend=true', `${job}: a file renamed OUT of src/ was not seen`)
  }
})

// ── every way of not knowing must run the gate, never skip it ────────────────────────────────────

test('a push whose base is unreachable runs the gate and says so (#1254)', () => {
  // #1254's own condition. The commits are worker-only, so a detector that could read the diff
  // would answer false — the `true` below can only come from the not-knowing path.
  for (const job of GATING_JOBS) {
    const { verdict, log } = runDetector(job, { commits: WORKER_CHANGE, before: '0'.repeat(40) })
    assert.equal(verdict, 'frontend=true', `${job}: an unreachable base must not skip the gate`)
    assert.match(log, /::error::base .* is not in this checkout/,
      `${job}: the annotation must name THIS reason — any ::error:: would also pass a wrong one`)
  }
})

test('a multi-commit push is judged on the whole push, not its last commit (#1254)', () => {
  // Here `git diff` SUCCEEDS, so no error path fires: the old HEAD~1 range simply read less than
  // the push contained and reported the difference as "no frontend changes".
  for (const job of GATING_JOBS) {
    assert.equal(
      runDetector(job, { commits: [{ 'src/App.jsx': 'x\n' }, { 'worker/src/index.ts': 'a\nb\n' }], before: 'HEAD~2' })
        .verdict,
      'frontend=true', `${job}: src/ in an earlier commit of the push was missed`)
  }
})

test('an empty but successful diff is treated as unknown, not as idle (#1254)', () => {
  for (const job of GATING_JOBS) {
    const { verdict, log } = runDetector(job, { commits: [{}] })
    assert.equal(verdict, 'frontend=true', `${job}: an empty diff must not skip the gate`)
    assert.match(log, /::error::the diff came back empty/, `${job}: annotation does not name the empty diff`)
  }
})

test('a grep that ERRORS runs the gate instead of reading as "no match" (#1254)', () => {
  // grep exits 0 on a match, 1 on no match, and >1 when grep itself failed. An `if grep …; then …
  // else …` collapses 1 and 2 into the skip branch. Today's pattern is a literal so it cannot error
  // on its own — hence a stub, the only way to reach that third state. The commits are worker-only,
  // so a detector reading a real diff would answer false either way; only the `*)` branch gives true.
  for (const job of GATING_JOBS) {
    const { verdict, log, argv } = runDetector(job, {
      commits: WORKER_CHANGE,
      grepStub: 'echo "grep: brackets ([ ]) not balanced" >&2; exit 2',
    })
    assert.equal(verdict, 'frontend=true', `${job}: a failing grep must not be read as "no frontend"`)
    assert.match(log, /::error::grep exited 2/, `${job}: annotation does not name the grep failure`)
    assert.equal(argv.filter((l) => l.startsWith('grep ')).length, 1,
      `${job}: expected exactly one grep call — a second would be silently swallowed by this stub`)
  }
})

test('a pull_request diffs the merge commit against the base, renames and all (#1254)', () => {
  // `actions/checkout` leaves HEAD at `refs/pull/N/merge`, whose first parent is the base branch
  // tip. This replaced a `gh pr diff --name-only` branch, which reported a rename's DESTINATION
  // only — verified on PR #867 (api/intro/* -> api/_intro/*: every source path absent) — so a PR
  // moving a file out of src/ skipped both gates, green, on the path that runs most often.
  for (const job of GATING_JOBS) {
    const { verdict } = runDetector(job, {
      event: 'pull_request', commits: [{ 'src/Foo.jsx': 'x\n' }], merge: MERGE_MOVES_OUT_OF_SRC,
    })
    assert.equal(verdict, 'frontend=true', `${job}: a PR renaming a file out of src/ was not seen`)
    const worker = runDetector(job, { event: 'pull_request', merge: WORKER_CHANGE })
    assert.equal(worker.verdict, 'frontend=false', `${job}: a worker-only PR should still skip`)
  }
})

test('a pull_request whose checkout has no first parent runs the gate (#1254)', () => {
  for (const job of GATING_JOBS) {
    const { verdict, log } = runDetector(job, { event: 'pull_request' })   // only the root commit
    assert.equal(verdict, 'frontend=true', `${job}: a parentless PR checkout must not skip the gate`)
    assert.match(log, /::error::the PR checkout has no first parent/, `${job}: annotation names the wrong reason`)
  }
})

test('an event that is neither push nor pull_request runs the gate (#1254)', () => {
  for (const job of GATING_JOBS) {
    const { verdict, log } = runDetector(job, { event: 'schedule', commits: WORKER_CHANGE })
    assert.equal(verdict, 'frontend=true', `${job}: an unrecognised event must not skip the gate`)
    assert.match(log, /::error::unexpected event 'schedule'/, `${job}: annotation does not name the event`)
  }
})

// ── structure — what running the body cannot observe ─────────────────────────────────────────────

test('the detector exists in exactly the two gating jobs, fed the right inputs (#1254)', () => {
  // Ground truth, not a floor: a job losing its detector, or a third growing one, fails here rather
  // than quietly shrinking the set every test above iterates over.
  assert.deepEqual(calls.map((c) => c.job).sort(), [...GATING_JOBS].sort())
  // The script reads the event from the runner's own GITHUB_EVENT_NAME, so only the push base has
  // to be wired — and it MUST be `github.event.before`. `HEAD~1` would read the last commit of a
  // multi-commit push and succeed, which is the silent under-read this whole change exists to stop.
  for (const { job, env } of calls) {
    assert.deepEqual(env, { PUSH_BASE: '${{ github.event.before }}' },
      `${job}: the detector step's env is not exactly the push base`)
  }
})

test('both gating jobs check out more than the tip commit (#1254)', () => {
  // The body diffs against the push's base; at depth 1 that object is absent and every push falls
  // into annotate-and-run-everything — correct, but it would run the full suite forever with only
  // an annotation nobody reads to say why. Comments are stripped, so prose mentioning `fetch-depth`
  // cannot satisfy this. Any depth but 1 passes; 0 means full history.
  for (const job of GATING_JOBS) {
    const block = checkoutFor(text, job)
    const m = /fetch-depth:\s*(\d+)/.exec(block)
    assert.ok(m, `${job}: checkout does not set fetch-depth`)
    assert.notEqual(m[1], '1', `${job}: fetch-depth 1 leaves the push base unreachable`)
    // No `ref:` override. On a pull_request the default leaves HEAD at `refs/pull/N/merge`, whose
    // first parent is the base tip. Point it at the PR head instead and `HEAD^1` still SUCCEEDS —
    // it just returns the previous commit on the branch, so a PR whose src/ change sits in an
    // earlier commit gates as false, green. The script cannot detect that; only this can.
    assert.doesNotMatch(block, /^\s*ref:/m, `${job}: a ref: override breaks the PR path's base`)
  }
})

test('every gated step reads the detector\u2019s output, and nothing else (#1254)', () => {
  // The detector can be perfect and the gate still never fire. Three ways, all seen: renaming the
  // step's `id:` leaves every `steps.<old>.…` resolving to ''; comparing against a value it never
  // writes does the same; and an extra `&& github.event_name == 'pull_request'` clause keeps the
  // reference intact while making the step unreachable on a push. So the whole expression is pinned,
  // not a substring of it.
  for (const job of GATING_JOBS) {
    const { id } = byJob[job]
    const allowed = new Set([
      `steps.${id}.outputs.frontend == 'true'`,
      `steps.${id}.outputs.frontend != 'true'`,
    ])
    // Paired with the step each condition belongs to, because polarity is only judgeable there:
    // flipping EVERY `==` to `!=` keeps all values inside `allowed` while skipping the real work and
    // the notice alike, both jobs green. Only the "Skip …" notice may be the negated one.
    const gated = []
    let name = null
    for (const line of jobBody(text, job).split('\n')) {
      const n = /^\s*- name: (.+?)\s*$/.exec(line)
      if (n) name = n[1]
      const cond = /^\s*if: (.+?)\s*$/.exec(line)
      if (cond && cond[1].includes('steps.')) gated.push({ name, cond: cond[1] })
    }
    assert.ok(gated.length >= 3, `${job}: expected the real steps and the skip notice gated, saw ${gated.length}`)
    for (const { name: step, cond } of gated) {
      assert.ok(allowed.has(cond), `${job}: "${step}" is not gated on exactly the detector's output — ${cond}`)
      const negated = cond.includes("!= 'true'")
      assert.equal(negated, step.startsWith('Skip'),
        `${job}: "${step}" has the wrong polarity — only the Skip notice runs when frontend != 'true'`)
    }
  }
})

test('a push to main is never cancelled by the next one (#1254)', () => {
  // `github.head_ref` is empty on a push, so the fallback decides whether main pushes share a
  // group. `github.ref` (its old value) is identical for every one of them, so they all collided and
  // the running one was cancelled — dropping a commit's only post-merge verdict, since no later
  // push's diff range reaches back to cover it. `run_id` is unique, so each push is a group of one.
  // Conditioning `cancel-in-progress` instead would leave a PENDING run cancellable.
  const cc = /\nconcurrency:\n((?:[ \t]+\S.*\n)+)/.exec(text)
  assert.ok(cc, 'no concurrency block')
  assert.match(cc[1], /group: .*github\.head_ref \|\| github\.run_id.*\n\s*cancel-in-progress: true\s*\n/,
    'a main push no longer gets its own group, or the PR-side cancel (#365) is gone')
})

test('the detector cannot swallow an error or lose a match to SIGPIPE (#1254)', () => {
  // Two defects the behavioural tests cannot demonstrate: a discarded stderr looks identical to a
  // clean run, and the SIGPIPE flip needs a diff far larger than any fixture here — `grep -q` exits
  // on the first match, the upstream dies of SIGPIPE, and `pipefail` promotes that to the pipeline's
  // status, so a MATCH reads as a failure. The shape is pinned instead.
  const code = stripComments(scriptSrc)
  assert.doesNotMatch(code, /2>\/dev\/null/, 'the detector discards stderr')
  assert.doesNotMatch(code, /\|\|\s*echo\s*""/, 'an error falls back to an empty diff')
  assert.doesNotMatch(code, /\|[^|\n]*grep/, 'the diff is piped into grep, which can lose a match to SIGPIPE')
  assert.match(code, /set -euo pipefail/, "the herestring's rationale depends on pipefail")
})

// ── the parser must fail, not shrink ─────────────────────────────────────────────────────────────

test('detectorCalls attributes a call to its own job, and reads the pattern it passes', () => {
  const src = [
    'jobs:', '  first:', '    steps:', '      - run: x',
    '  second:', '    steps:', '      - name: Check for frontend changes', '        id: changes',
    '        # a note between the id and the run', `        run: ${RUN} '^(src/|zzz/)'`,
  ].join('\n')
  assert.deepEqual(detectorCalls(src), [{ job: 'second', id: 'changes', pattern: '^(src/|zzz/)', env: {} }])
})

// ── the shared-fixture premise, checked rather than asserted in prose ────────────────────────

test('the detector left every fixture untouched (#1254)', () => {
  // Fixtures are shared across runs, which is sound only while the script reads and never writes.
  // The plausible next edit is a writing one — `git fetch --deepen` — and its symptom would be
  // order-dependent failures in unrelated scenarios, expensive to trace back here.
  assert.ok(templates.size > 0, 'no fixture was built — the behavioural tests did not run')
  for (const [key, t] of templates) {
    assert.equal(fixtureState(t.dir), t.state,
      `the detector modified the fixture for ${key} — fixtures are shared and can no longer be`)
  }
})

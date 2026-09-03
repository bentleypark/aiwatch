// #1253 — structural guard for the CI invariants a green run cannot establish.
//
// The apt stall this issue is about is INTERMITTENT: on 2026-08-19 the same install step both stalled
// past 20 minutes and completed in seconds, within the same hour, on the same runner pool. So "CI went
// green" carries no information about whether the bound is still in place — only a structural
// assertion does.
//
// The PARSER is unit-tested against synthetic fixtures below, not only against the live files. An
// earlier version of this guard passed while guarding nothing in four separate shapes (a job key with
// a trailing comment; `jobs:` with a trailing space; an unbounded step that was last in its job and so
// absorbed the NEXT job's timeout; a `timeout 120` appearing only inside a comment). Each is a fixture
// now. `scripts/workflow-paths-sync.test.mjs` states the rule this follows: a parser that cannot read
// its input must FAIL, never silently shrink what it checks.
//
// Known limits, stated so a green run is not over-trusted: a line scanner cannot follow apt invoked
// from inside a shell script this repo calls, and it does not know `aptitude`/`apt-fast`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(repoRoot, '.github/workflows')

/** Anything that ends up shelling out to apt. `install-deps` is Playwright's other apt entry point. */
export const APT = /\bapt(-get)?\s|--with-deps\b|\binstall-deps\b/

/** Strip a trailing `#` comment. Crude but sufficient: these lines never contain a `#` inside quotes. */
export function stripComment(line) {
  return line.replace(/#.*$/, '')
}

/**
 * A `timeout N` / `timeout 2m` wrapper in COMMAND position: at the start of a block-scalar line, right
 * after `run:`, or after a shell operator. Position matters — an earlier version matched the substring
 * anywhere, so a nearby `--connect-timeout 5` (which this repo's own curl step has) counted as a bound.
 */
export function hasTimeoutWrapper(line) {
  return /(^|\||&|;|run:)\s*(sudo\s+)?timeout\s+\d+[smhd]?\s/.test(stripComment(line))
}

/**
 * Jobs are the 2-space keys under a top-level `jobs:` key; a job's body is everything indented deeper.
 * Throws rather than returning a short list — a parser that loses a job would make every assertion
 * below weaker without saying so.
 */
export function parseJobs(text, label = '<text>') {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l))
  if (start === -1) throw new Error(`${label}: no top-level \`jobs:\` key — the parser cannot read this file`)
  const isJobKey = (l) => /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(l)
  const jobs = []
  for (let i = start + 1; i < lines.length; i++) {
    const m = isJobKey(lines[i])
    if (!m) {
      // A 2-space key we can't destructure means the shape changed under us — fail loud.
      if (/^ {2}\S/.test(lines[i]) && !/^ {2}#/.test(lines[i]) && !/^ {2}- /.test(lines[i]) && /^ {2}[^\s].*:/.test(lines[i])) {
        throw new Error(`${label}:${i + 1}: 2-space key the job parser could not read: ${lines[i]}`)
      }
      continue
    }
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\S/.test(lines[j]) || isJobKey(lines[j])) { end = j; break }
    }
    jobs.push({ name: m[1], body: lines.slice(i + 1, end) })
  }
  return jobs
}

/** Split a job body into step blocks, each starting at a `- ` line. Never crosses the job boundary. */
export function stepBlocks(body) {
  const blocks = []
  let cur = null
  for (const line of body) {
    if (/^ {6}- /.test(line)) { if (cur) blocks.push(cur); cur = [line]; continue }
    if (cur) cur.push(line)
  }
  if (cur) blocks.push(cur)
  return blocks
}

/** A step is bounded by its own `timeout-minutes`, or by a `timeout N` wrapper on a command line. */
export function isBounded(block) {
  return block.some((l) => /^ {8}timeout-minutes:/.test(stripComment(l))) || block.some(hasTimeoutWrapper)
}

/** Steps in this job body that reach apt, ignoring comment lines. */
export function aptSteps(body) {
  return stepBlocks(body).filter((b) => b.some((l) => {
    const code = stripComment(l)
    return code.trim() !== '' && APT.test(code)
  }))
}

/** Steps whose CODE (comments stripped) are an `actions/cache` of Playwright's browser dir. */
export function browserCacheSteps(body) {
  return stepBlocks(body).filter((b) => {
    const code = b.map(stripComment).join('\n')
    return /uses:\s*actions\/cache@/.test(code) && /path:\s*~\/\.cache\/ms-playwright/.test(code)
  })
}

/** Steps whose CODE (comments stripped) invokes `playwright install`. */
export function playwrightInstallSteps(body) {
  return stepBlocks(body).filter((b) => b.some((l) => /playwright\s+install\b/.test(stripComment(l))))
}

/**
 * Does this workflow's `on:` block name `deployment_status`?
 *
 * `actions/cache` refuses to run when the triggering event is not tied to a branch or tag ref, so a
 * cache step in such a workflow is INERT — it restores nothing and saves nothing. Verified on run
 * 33703810844: both the restore and the post-job save logged "Event Validation Error: The event type
 * deployment_status is not supported because it's not tied to a branch or tag ref", no `Cache hit`
 * line appeared, and the browser downloaded despite a live cache entry under the same key.
 *
 * Scoped to the ONE event we have a run to point at. This is deliberately not a list of which GitHub
 * events are ref-bound: such a list is unbounded, untestable from here, and would drift silently.
 */
export function deploymentStatusTriggered(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^on:/.test(l))
  if (start === -1) throw new Error('no top-level `on:` key — the parser cannot read this file')
  const inline = stripComment(lines[start]).slice(3)
  if (/deployment_status/.test(inline)) return true
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break
    if (/deployment_status/.test(stripComment(lines[i]))) return true
  }
  return false
}

const LOCK = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
export const PLAYWRIGHT_VERSION = LOCK.packages?.['node_modules/playwright-core']?.version

const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
const parsed = files.map((f) => ({ file: f, text: readFileSync(join(DIR, f), 'utf8') }))

test('every workflow job declares timeout-minutes (#1253)', () => {
  const missing = []
  for (const { file, text } of parsed) {
    for (const job of parseJobs(text, file)) {
      if (!job.body.some((l) => /^ {4}timeout-minutes:/.test(l))) missing.push(`${file}:${job.name}`)
    }
  }
  assert.deepEqual(missing, [], `jobs without timeout-minutes (they inherit GitHub's 6h default): ${missing.join(', ')}`)
})

test('every apt-reaching step is bounded (#1253)', () => {
  const unbounded = []
  for (const { file, text } of parsed) {
    for (const job of parseJobs(text, file)) {
      for (const block of aptSteps(job.body)) {
        if (!isBounded(block)) unbounded.push(`${file}:${job.name}: ${block[0].trim().slice(0, 60)}`)
      }
    }
  }
  assert.deepEqual(unbounded, [], `apt-reaching steps with no bound:\n${unbounded.join('\n')}`)
})

test('Playwright installs stay apt-free, and cache only where the cache can run (#1253)', () => {
  // The cache half is asserted in BOTH directions on purpose. Requiring the step everywhere was the
  // first shape of this test, and it passed on edge-e2e.yml while the step there restored nothing —
  // a text assertion cannot see that `actions/cache` declined to run.
  // Selected by a REAL install step, not by the literal appearing anywhere in the file: a workflow
  // must not qualify on a comment, and deleting the run line must drop the count rather than leave an
  // empty loop behind.
  const playwrightWorkflows = parsed.filter(({ file, text }) =>
    parseJobs(text, file).some((job) => playwrightInstallSteps(job.body).length > 0))
  assert.equal(playwrightWorkflows.length, 3, `expected the three Playwright workflows, found ${playwrightWorkflows.length}`)
  let inert = 0
  for (const { file, text } of playwrightWorkflows) {
    // APT over the step's own stripped code, not a fixed command string. `playwright install chromium
    // --with-deps` is accepted by the CLI and reintroduces apt, but reads nothing like the documented
    // spelling — an order-sensitive match was green on it.
    let installSteps = 0
    for (const job of parseJobs(text, file)) {
      for (const block of playwrightInstallSteps(job.body)) {
        installSteps++
        assert.doesNotMatch(block.map(stripComment).join('\n'), APT, `${file}: the Playwright install step reaches apt`)
        // Dropping apt did not make this step fast: it still downloads ~280 MiB from cdn.playwright.dev,
        // and `aptSteps` no longer covers it, so the bound it used to carry needs its own assertion.
        assert.ok(isBounded(block), `${file}: the Playwright install step carries no bound`)
      }
    }
    assert.equal(installSteps, 1, `${file}: expected exactly one \`playwright install\` step, found ${installSteps}`)
    // Located the same structural way as the install step. A whole-file text match counted a
    // commented-out step, and a prose mention of the path, as a cache.
    let cacheSteps = 0
    for (const job of parseJobs(text, file)) cacheSteps += browserCacheSteps(job.body).length
    const hasCache = cacheSteps > 0
    if (deploymentStatusTriggered(text)) {
      inert++
      assert.equal(hasCache, false, `${file}: triggered by deployment_status, where actions/cache cannot run — a cache step here is inert`)
    } else {
      assert.equal(cacheSteps, 1, `${file}: expected exactly one browser-cache step, found ${cacheSteps}`)
    }
  }
  // Without this the whole deployment_status branch could stop being reached — by a trigger rename or
  // a parser regression — and every workflow would silently fall through to the "cache required" arm.
  assert.equal(inert, 1, `expected exactly one deployment_status-triggered Playwright workflow, found ${inert}`)
})

test('the parser sees every job that exists (#1253)', () => {
  // Ground truth rather than a magic floor: each `runs-on:` is exactly one job, so a parser that stops
  // seeing a job fails here instead of quietly shrinking its own denominator.
  for (const { file, text } of parsed) {
    const runsOn = (text.match(/^ {4}runs-on:/gm) || []).length
    assert.equal(parseJobs(text, file).length, runsOn, `${file}: parsed jobs != runs-on count`)
  }
  assert.ok(files.length >= 4, `expected several workflow files, found ${files.length}`)
})

// ── Parser fixtures — each is a shape that previously passed while guarding nothing ────────────────

const JOB = (extra = '') => `jobs:${extra}\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`

test('parseJobs: a job key with a trailing comment is still a job', () => {
  const text = 'jobs:\n  build:   # the production bundle\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n'
  assert.deepEqual(parseJobs(text).map((j) => j.name), ['build'])
})

test('parseJobs: `jobs:` with a trailing space or comment is still found', () => {
  assert.equal(parseJobs(JOB(' ').replace('jobs: ', 'jobs:  ')).length, 1)
  assert.equal(parseJobs('jobs:  # three of them\n  a:\n    runs-on: x\n').length, 1)
})

test('parseJobs: throws on a 2-space key it cannot read, rather than dropping it', () => {
  assert.throws(() => parseJobs('jobs:\n  "quoted-job":\n    runs-on: x\n', 'f.yml'), /could not read/)
})

test('stepBlocks: a step block never absorbs the next job\'s timeout-minutes', () => {
  const text = [
    'jobs:', '  a:', '    timeout-minutes: 10', '    steps:',
    '      - run: sudo apt-get install -y cowsay',   // last step of job a, unbounded
    '  b:', '    timeout-minutes: 10', '    steps:', '      - run: echo hi', '',
  ].join('\n')
  const [jobA] = parseJobs(text)
  const [aptBlock] = aptSteps(jobA.body)
  assert.ok(aptBlock, 'the apt step was not found')
  assert.equal(isBounded(aptBlock), false, 'the block absorbed a timeout from outside its own job')
})

test('isBounded: a `timeout` mentioned only in a comment does not count', () => {
  const block = ['      - name: Install', '        # was wrapped in timeout 120 once', '        run: npx playwright install --with-deps chromium']
  assert.equal(isBounded(block), false)
})

test('isBounded: an unrelated --connect-timeout flag does not count', () => {
  const block = ['      - run: |', '          curl --connect-timeout 5 https://x >/dev/null', '          npx playwright install --with-deps chromium']
  assert.equal(isBounded(block), false)
})

test('isBounded: a real wrapper counts, including a GNU duration suffix and after a shell operator', () => {
  assert.equal(isBounded(['      - run: timeout 120 npx playwright install --with-deps chromium']), true)
  assert.equal(isBounded(['      - run: timeout 2m npx playwright install --with-deps chromium']), true)
  assert.equal(isBounded(['      - run: foo || timeout 30 apt-get update']), true)
  assert.equal(isBounded(['      - run: sudo timeout 120 npx playwright install-deps']), true)
  assert.equal(isBounded(['      - run: apt-get update', '        timeout-minutes: 5']), true)
})

test('APT: matches playwright\'s other apt entry point, and not words containing "apt"', () => {
  assert.match('npx playwright install-deps chromium', APT)
  assert.match('npx playwright install --with-deps chromium', APT)
  assert.match('sudo apt-get update -qq', APT)
  assert.doesNotMatch('- name: Adapt the fixtures', APT)
  assert.doesNotMatch('node scripts/build.mjs --adapt', APT)
})


test('deploymentStatusTriggered: reads the mapping, inline and list forms', () => {
  assert.equal(deploymentStatusTriggered('on:\n  deployment_status: {}\njobs:\n'), true)
  assert.equal(deploymentStatusTriggered('on: [deployment_status]\njobs:\n'), true)
  assert.equal(deploymentStatusTriggered('on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n'), false)
})

test('deploymentStatusTriggered: stops at the `on:` block, and ignores comments', () => {
  // A `jobs:`-level mention must not be read as a trigger — that would exempt a workflow that can cache.
  assert.equal(deploymentStatusTriggered('on:\n  push:\njobs:\n  a:\n    steps:\n      - run: echo deployment_status\n'), false)
  assert.equal(deploymentStatusTriggered('on:\n  push:   # not deployment_status, that was removed\njobs:\n'), false)
})

test('deploymentStatusTriggered: throws on a file with no `on:` key rather than answering false', () => {
  assert.throws(() => deploymentStatusTriggered('jobs:\n  a:\n    runs-on: x\n'), /cannot read/)
})

test('playwrightInstallSteps: finds the step by its code, not by a comment or a lookalike', () => {
  const body = [
    '    steps:',
    '      - name: Install Playwright npm package',
    '        run: npm install --no-save playwright@1.58.2',   // not `playwright install`
    '      - name: Install Chromium',
    '        # once ran playwright install --with-deps chromium',
    '        run: npx playwright install chromium',
  ]
  const found = playwrightInstallSteps(body)
  assert.equal(found.length, 1, 'expected exactly the real install step')
  assert.match(found[0].join('\n'), /Install Chromium/)
})

test('APT catches --with-deps in trailing position, which a command-string match does not', () => {
  // The shape this guard was blind to: the CLI accepts the flag after the browser name.
  assert.match('npx playwright install chromium --with-deps', APT)
  assert.doesNotMatch('npx playwright install chromium --with-deps', /playwright install --with-deps/)
})

test('every pinned Playwright version matches the lockfile (#1253)', () => {
  // A cache key naming a stale version does not fail — it restores the wrong browser dir, the install
  // re-downloads, and the post-job step logs `Cache hit … not saving cache`, so the entry never
  // refreshes. Green forever, cache dead forever. Nothing else in this repo couples the two.
  assert.ok(PLAYWRIGHT_VERSION, 'package-lock.json has no playwright-core version — the parser cannot read it')
  const pins = []
  for (const { file, text } of parsed) {
    for (const line of text.split('\n')) {
      const code = stripComment(line)
      if (!/playwright/i.test(code)) continue
      for (const m of code.matchAll(/(\d+\.\d+\.\d+)/g)) pins.push({ file, version: m[1], code: code.trim() })
    }
  }
  assert.ok(pins.length >= 3, `expected the cache keys plus the standalone install pin, found ${pins.length}`)
  for (const { file, version, code } of pins) {
    assert.equal(version, PLAYWRIGHT_VERSION, `${file}: pins ${version}, lockfile resolves ${PLAYWRIGHT_VERSION} — ${code}`)
  }
})

test('browserCacheSteps: a commented-out step or a prose mention is not a cache', () => {
  const commented = ['      # - uses: actions/cache@v6', '      #   with:', '      #     path: ~/.cache/ms-playwright']
  assert.equal(browserCacheSteps(commented).length, 0)
  const prose = ['      - name: Install', '        # we deliberately do not cache path: ~/.cache/ms-playwright here', '        run: npx playwright install chromium']
  assert.equal(browserCacheSteps(prose).length, 0)
  const real = ['      - uses: actions/cache@v6', '        with:', '          path: ~/.cache/ms-playwright', '          key: k']
  assert.equal(browserCacheSteps(real).length, 1)
})

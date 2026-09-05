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

/**
 * Split a job body into step blocks, each starting at a `- ` line. Never crosses the job boundary.
 *
 * Throws when the step list is at an indent this scanner cannot read. A 4- and an 8-space list are
 * both valid YAML under a 4-space `steps:` key and neither yields a readable block, so every check
 * routed through this function passes over the job in silence: the apt bound (#1253) and, since
 * #1348, the `npm ci` bound and the cache requirement. `assert.equal(seen, 7)` cannot catch it either — that notices a
 * step going MISSING, not an unseen one arriving. The header's rule: a parser that cannot read its
 * input must FAIL, never silently shrink what it checks.
 *
 * The check reads the indent of the FIRST item under `steps:`, rather than counting blocks found
 * anywhere in the body. Counting was the first shape and it was disarmed by any other 6-space
 * block-sequence item in the same job — a `needs:` written in block form manufactures a phantom
 * block, and a whole mis-indented step list then gets absorbed into it with no throw. Scoping the
 * question to the list itself removes that coupling: nothing outside `steps:` can answer it.
 */
export function stepBlocks(body) {
  const stepsAt = body.findIndex((l) => /^ {4}steps:\s*(#.*)?$/.test(l))
  if (stepsAt >= 0) {
    const first = body.slice(stepsAt + 1).find((l) => /^\s*- /.test(l))
    if (first && !/^ {6}- /.test(first)) {
      throw new Error(`stepBlocks: this job's step list is not indented at 6 spaces, so this scanner cannot read it and would report the job as having no steps to check: ${JSON.stringify(first)}`)
    }
  }
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

/** Steps whose CODE (comments stripped) uses `actions/setup-node`. */
export function setupNodeSteps(body) {
  return stepBlocks(body).filter((b) => b.some((l) => /uses:\s*actions\/setup-node@/.test(stripComment(l))))
}

/**
 * npm's own alias list for `ci`, from `npm ci -h`: the last one is a typo alias npm actually ships.
 * Matching only the literal `npm ci` left every spelling but the first invisible to the assertions
 * below — not failing, SEEN AS NOTHING, which is the shape this file exists to prevent.
 */
export const NPM_CI_ALIASES = ['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean']

/**
 * Does this line invoke `npm ci` (under any alias)?
 *
 * Token-based rather than a fixed `npm ci` string, because npm's flags are positionally free:
 * `npm --prefix worker ci` is the same command as `npm ci --prefix worker` and matched nothing under
 * the old regex.
 *
 * Split on shell separators FIRST, and judge each command on its own: disqualifying a whole line on
 * a `run`/`exec`/`x` token anywhere in it made `npm ci && npm run build` answer false.
 *
 * There is no disqualifier at all now. Scoping one correctly needs npm's flag-arity table, and
 * without it the check read flag VALUES as subcommands — `npm ci --prefix x`, `npm ci -w x` and
 * `npm ci --cache x` all answered false, hiding a real install. So the only spellings this can now
 * get wrong are false POSITIVES: a script literally named after an alias (`npm run ci`) is treated
 * as the builtin. That is the safe direction — it costs that step a bound and a cache check, where a
 * false negative costs it both, silently.
 */
export function isNpmCiCommand(code) {
  for (const segment of code.split(/&&|\|\||;|\||&/)) {
    const m = /(?:^|[\s"'(/])npm(?:\s+(.*))?$/.exec(segment)
    if (!m) continue
    // Shell punctuation is stripped on BOTH sides of the command word, and the asymmetry was a real
    // hole: tokens after `npm` were stripped from the start, so `(cd worker && npm ci)` was seen, but
    // the anchor before `npm` accepted only whitespace, so `"npm ci"`, `(npm ci)`, `sh -c 'npm ci'`
    // and `/usr/bin/npm ci` were not — and an unseen step is required to carry neither a bound nor a
    // cache. This screen is deliberately over-broad: being seen costs a step only those two checks,
    // while not being seen costs it both.
    const tokens = (m[1] || '').trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/[()'"`]/g, ''))
    if (tokens.some((t) => NPM_CI_ALIASES.includes(t))) return true
  }
  return false
}

/**
 * Steps whose CODE (comments stripped) runs `npm ci`. Prose about `npm ci` sits in comments all over
 * these files, and a guard in this very file once counted a commented-out step as the real thing.
 */
export function npmCiSteps(body) {
  return stepBlocks(body).filter((b) => b.some((l) => isNpmCiCommand(stripComment(l))))
}

/**
 * `cache:` and `cache-dependency-path:` off a `setup-node` step, reading the block-scalar list form as
 * well as the inline one. `cache` is `null` when the input is absent — the caller has to be able to
 * tell "not configured" from "configured to something".
 */
export function npmCacheConfig(block) {
  let cache = null
  const paths = []
  for (let i = 0; i < block.length; i++) {
    const code = stripComment(block[i])
    const c = /^\s*cache:\s*'?"?([A-Za-z]+)'?"?\s*$/.exec(code)
    if (c) { cache = c[1]; continue }
    const p = /^(\s*)cache-dependency-path:\s*(.*)$/.exec(code)
    if (!p) continue
    const rest = p[2].trim()
    // ONLY `|` opens a multi-path list. A folded `>` joins its lines into one space-separated scalar,
    // which setup-node then treats as a single unresolvable path — so reading it as a list would let
    // this parser report paths the config does not actually declare.
    if (/^>[-+]?$/.test(rest)) throw new Error('npmCacheConfig: cache-dependency-path uses a folded `>` scalar, which YAML joins into ONE path — only `|` is a list')
    if (rest.startsWith('[')) throw new Error('npmCacheConfig: cache-dependency-path uses a flow sequence, which this scanner does not read — use a `|` block list')
    if (rest === '') throw new Error('npmCacheConfig: cache-dependency-path has no value')
    if (!/^\|[-+]?$/.test(rest)) { paths.push(rest.replace(/^['"]|['"]$/g, '')); continue }
    const indent = p[1].length
    for (let j = i + 1; j < block.length; j++) {
      const item = stripComment(block[j])
      if (item.trim() === '') continue
      if (item.search(/\S/) <= indent) break
      paths.push(item.trim().replace(/^['"]|['"]$/g, ''))
    }
  }
  return { cache, paths: paths.sort() }
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

test('stepBlocks: throws when a job\'s steps are at an indent it cannot read (#1348)', () => {
  // 4 and 8 spaces are both valid YAML under a 4-space `steps:` key, and both yielded zero blocks —
  // so the job's `npm ci` was required to carry neither a bound nor a cache and its apt step went
  // unchecked, silently. (2 is NOT valid there: a sequence item cannot out-dent its own key. It was
  // pinned here once and removed — an unshippable shape proves nothing in either direction.)
  const at = (n, extra = []) => [
    ...extra, '    runs-on: ubuntu-latest', '    timeout-minutes: 10', '    steps:',
    `${' '.repeat(n)}- run: npm ci`,
  ]
  for (const n of [4, 8]) {
    assert.throws(() => stepBlocks(at(n)), /cannot read it/, `indent ${n} did not throw`)
  }
  assert.equal(stepBlocks(at(6)).length, 1)
  // A block-form `needs:` puts a 6-space `- ` item in the body that is NOT a step. Counting blocks
  // anywhere in the body let that one phantom disarm the check while a whole mis-indented step list
  // was absorbed into it; the indent of the list itself cannot be answered from outside `steps:`.
  const needs = ['    needs:', '      - unit']
  for (const n of [4, 8]) {
    assert.throws(() => stepBlocks(at(n, needs)), /cannot read it/, `indent ${n} with a block needs: did not throw`)
  }
  assert.equal(stepBlocks(at(6, needs)).length, 2, 'a 6-space needs: item is still counted as a block')
  // A job with no `steps:` key at all is not a parse failure — several fixtures pass bare blocks.
  assert.deepEqual(stepBlocks(['    runs-on: ubuntu-latest']), [])
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

// ── #1348 — `npm ci` is a network-bound step, and it was the whole 4-10 minute band ────────────────
//
// JOB level, as measured on 2026-09-04 over the test.yml runs back to 2026-08-19: `Worker Unit
// Tests` held between 1.35m and 1.93m, then began landing anywhere from 4.10m to the 10m cap, which
// it started hitting. Per-bucket run COUNTS are deliberately not recorded: the window ran up to the
// day of measurement and keeps growing, so any count here is stale the next day — and the counts
// were never what carried the point. The transition is BOUNDED, not observed: the last fast run
// finished 2026-09-03 10:54 UTC and the first slow one started 2026-09-04 01:30 UTC, nothing between.
//
// STEP level, over EVERY step observation in those runs rather than a chosen few — the earlier
// version of this block named three runs and mischaracterised them, which is what produced a cap
// that had to be retracted. `npm run test:worker` never exceeded 59s, so the suite is not where the
// time went; `npm ci` reached 422s against a 12s median. One further `npm ci` was still running at
// 185s when a job cap ended it, so the tail is not fully observed. Observation counts are omitted
// here for the same reason the run counts above are.
//
// Two controls sit in this repo's own history over the same hours. docs-lint.yml's `npm ci` — the one
// that already carried `cache: 'npm'` — held a ~5s median on both sides of the transition. And the
// awk-matrix job, the only one in test.yml with no `npm ci`, held its median across the same split.
// Every job that installs moved; the cached one and the one that does not install did not.
//
// The edge-e2e arm below is a POLICY, not a mechanism claim: nothing here establishes whether
// `cache: 'npm'` functions under `deployment_status`. Run 33703810844 recorded the `actions/cache`
// step refusing to run under that event, but that guard belongs to that action, not to `setup-node`.
// So the cache is not added there, and the assertion keeps an untested one from being added on the
// same bad inference — it is not evidence that one would be inert.
//
// A green run carries no information about any of this — a pass and a kill differ only in which side
// of the cap the registry happened to land on — so the bound and the cache are asserted structurally.
//
// NOT CHECKED, and deliberately so: that a job's `cache-dependency-path` names every lockfile the
// job installs from. A guard for it shipped here and was removed. Deciding it means answering "which
// lockfile does this command install from", which needs a parser for shell, for YAML scalars and for
// npm's own CLI — and six consecutive review rounds each produced a REPRODUCED silent wrong answer
// from it, every one on a shape the round before had declared closed: `--prefix` spellings, a `cd`,
// `working-directory:`, a `\` continuation, chained commands, a subshell, npm's `-C` shorthand for
// `--prefix`, a workflow-level `defaults:` above `jobs:`, and a folded `>` scalar. A guard that is
// wrong in a new way every round is worse than no guard, because green reads as verified.
//
// What that costs: adding a THIRD package with its own `npm ci` and not extending the key would
// leave that job's cache permanently incomplete, silently (a cache HIT never re-saves). The
// mitigation is the `unit` job's own comment, which states the rule for a human adding one. The two
// assertions that remain — the bound and the cache being declared — need only to know THAT a job
// installs, never from where, so their parser can be over-broad in the safe direction.
//
// Scope, stated as a limit rather than left implicit: these assertions cover `npm ci` only.
// `npm install --no-save playwright@1.58.2` in deepseek-feed.yml is the same registry-bound class —
// it reifies the whole root tree, and its step ran 421s in the same window — but it is uncached,
// unbounded, and sits under an 8m JOB cap that a 421s install nearly reaches on its own. Bounding it
// without also caching it or raising that cap makes it MORE fragile, and it is a scheduled job that
// feeds production, so it is left alone here and belongs in its own change.

test('every `npm ci` step is bounded (#1348)', () => {
  const unbounded = []
  let seen = 0
  for (const { file, text } of parsed) {
    for (const job of parseJobs(text, file)) {
      for (const block of npmCiSteps(job.body)) {
        seen++
        if (!isBounded(block)) unbounded.push(`${file}:${job.name}: ${block[0].trim().slice(0, 60)}`)
      }
    }
  }
  // A denominator, not a floor for its own sake: a matcher that stops seeing `npm ci` steps would
  // make this pass over an empty loop, which is exactly how the apt guard once passed.
  // The repo's actual count, not a slack floor. At `>= 6` the matcher could lose exactly one step
  // and still pass — which is how a false negative stayed invisible. Adding a step raises this; a
  // deliberate removal lowers it, in the same diff, where a reviewer sees it.
  assert.equal(seen, 7, `expected the repo's 7 \`npm ci\` steps, found ${seen}`)
  assert.deepEqual(unbounded, [], `\`npm ci\` steps with no bound (a registry stall then spends the JOB budget and the cap kills whichever step is running):\n${unbounded.join('\n')}`)
})

test('a job that runs `npm ci` caches ~/.npm — except where caching is unverified (#1348)', () => {
  // Asserted in BOTH directions, following the Playwright cache test's shape. The second direction is
  // a POLICY and says so: whether `cache: 'npm'` works under `deployment_status` is NOT established
  // here (see the block above), so it is not added there, and this arm keeps one from being added on
  // the inference that was already wrong once. Evidence that it works is what should reverse it.
  let cached = 0
  let unverified = 0
  for (const { file, text } of parsed) {
    const deploymentStatus = deploymentStatusTriggered(text)
    for (const job of parseJobs(text, file)) {
      if (npmCiSteps(job.body).length === 0) continue
      const setups = setupNodeSteps(job.body)
      assert.equal(setups.length, 1, `${file}:${job.name}: expected one setup-node step alongside its \`npm ci\`, found ${setups.length}`)
      const { cache } = npmCacheConfig(setups[0])
      if (deploymentStatus) {
        unverified++
        assert.equal(cache, null, `${file}:${job.name}: triggered by deployment_status, where this repo has NOT established that setup-node's cache works — do not add \`cache: '${cache}'\` here without evidence`)
      } else {
        cached++
        assert.equal(cache, 'npm', `${file}:${job.name}: runs \`npm ci\` with no npm cache — every install then refetches the whole tree from the registry (#1348)`)
      }
    }
  }
  assert.ok(cached >= 5, `expected the cacheable npm-installing jobs, found ${cached}`)
  // Without this the deployment_status arm could stop being reached — a trigger rename, a parser
  // regression — and the file would silently hold only the easy half of the rule.
  assert.equal(unverified, 1, `expected exactly one deployment_status-triggered job that runs \`npm ci\`, found ${unverified}`)
})

test('npmCiSteps: prose about `npm ci` is not an `npm ci` step', () => {
  assert.equal(npmCiSteps(['      - run: echo hi', '        # deliberately no npm ci here']).length, 0)
  assert.equal(npmCiSteps(['      # - run: npm ci']).length, 0)
  assert.equal(npmCiSteps(['      - run: npm ci']).length, 1)
  assert.equal(npmCiSteps(['      - run: npm ci --no-audit --fund=false']).length, 1)
})

test('npmCiSteps: a quoted or parenthesised command is still SEEN (#1348)', () => {
  // Each of these returned 0 steps, so the step was required to carry neither a bound nor a cache.
  assert.equal(npmCiSteps(['      - run: "npm ci"']).length, 1)
  assert.equal(npmCiSteps(["      - run: 'npm ci'"]).length, 1)
  assert.equal(npmCiSteps(['      - run: (npm ci)']).length, 1)
  assert.equal(npmCiSteps(['      - run: bash -c "npm ci --prefix worker"']).length, 1)
  assert.equal(npmCiSteps(['      - run: /usr/bin/npm ci']).length, 1)
})

test('npmCiSteps: an install inside a subshell is still SEEN (#1348)', () => {
  // `(cd worker && npm ci)` left the last token as `ci)`, which matched no alias — so the step was
  // invisible to the bound check and the cache check. Being seen is what makes both apply, and the
  // screen is over-broad on purpose: being seen costs a step only those two checks.
  assert.equal(npmCiSteps(['      - run: (cd worker && npm ci)']).length, 1)
})

test('npmCiSteps: a lookalike command is not `npm ci`', () => {
  assert.equal(npmCiSteps(['      - run: npm cit']).length, 0)
  assert.equal(npmCiSteps(['      - run: npm install --no-save playwright@1.58.2']).length, 0)
  assert.equal(npmCiSteps(['      - run: npm run ci-something']).length, 0)
  // A project script named exactly after an alias IS matched, deliberately: see isNpmCiCommand. The
  // cost is a bound and a cache check on that step; the alternative cost a real install both.
  assert.equal(npmCiSteps(['      - run: npm run ci']).length, 1)
})

test('isNpmCiCommand: a flag VALUE never hides a real install (#1348)', () => {
  // Each of these answered FALSE while `run`/`exec`/`x` disqualified a line wherever they appeared —
  // so the install was seen by nothing, which is the only fatal direction for the two assertions.
  for (const cmd of ['npm ci --prefix x', 'npm ci -w x', 'npm ci --cache x', 'npm --prefix run ci', 'npm ci --prefix exec']) {
    assert.equal(isNpmCiCommand(`        ${cmd}`), true, `${cmd} went unseen`)
  }
})

test('npmCiSteps: a real `npm ci` chained with another npm command still counts (#1348)', () => {
  // These answered FALSE while the disqualifier looked at the whole line, so the step disappeared
  // from the bound check and the cache check at once.
  assert.equal(npmCiSteps(['      - run: npm ci && npm run build']).length, 1)
  assert.equal(npmCiSteps(['      - run: npm ci; npm run lint']).length, 1)
  assert.equal(npmCiSteps(['      - run: npm ci --prefix worker && npm run test:worker']).length, 1)
  // `npm run ci` is matched too — a deliberate false positive, see isNpmCiCommand.
  assert.equal(npmCiSteps(['      - run: npm run ci && npm run build']).length, 1)
})

test('npmCiSteps: every npm alias for `ci`, and flags before the subcommand (#1348)', () => {
  // These were SEEN AS NOTHING by the literal `npm ci` match — neither bound-checked nor
  // cache-checked, so both assertions passed over them.
  for (const alias of NPM_CI_ALIASES) {
    assert.equal(npmCiSteps([`      - run: npm ${alias}`]).length, 1, `alias ${alias} not matched`)
  }
  // npm's flags are positionally free: this is the same command as `npm ci --prefix worker`.
  assert.equal(npmCiSteps(['      - run: npm --prefix worker ci']).length, 1)
})

test('npmCacheConfig: throws on a value shape it cannot read, rather than answering (#1348)', () => {
  const withPath = (v) => ['        with:', "          cache: 'npm'", `          cache-dependency-path: ${v}`, '            package-lock.json']
  // A folded `>` reads identically to `|` to a line scanner, but YAML joins it into ONE path.
  assert.throws(() => npmCacheConfig(withPath('>')), /folded/)
  assert.throws(() => npmCacheConfig(withPath('>-')), /folded/)
  assert.throws(() => npmCacheConfig(['        with:', '          cache-dependency-path: [a, b]']), /flow sequence/)
  assert.throws(() => npmCacheConfig(['        with:', '          cache-dependency-path:']), /no value/)
  // `|+` is still a literal block, so it must NOT throw.
  assert.deepEqual(npmCacheConfig(withPath('|+')).paths, ['package-lock.json'])
})

test('npmCacheConfig: reads the block-scalar list, the inline form, and absence', () => {
  const blockForm = [
    '      - uses: actions/setup-node@v7',
    '        with:',
    '          node-version: 20',
    "          cache: 'npm'",
    '          cache-dependency-path: |',
    '            package-lock.json',
    '            worker/package-lock.json',
  ]
  assert.deepEqual(npmCacheConfig(blockForm), { cache: 'npm', paths: ['package-lock.json', 'worker/package-lock.json'] })
  const inline = ['        with:', "          cache: 'npm'", '          cache-dependency-path: package-lock.json']
  assert.deepEqual(npmCacheConfig(inline), { cache: 'npm', paths: ['package-lock.json'] })
  assert.deepEqual(npmCacheConfig(['        with:', '          node-version: 20']), { cache: null, paths: [] })
})

test('npmCacheConfig: the list stops at the next key, and a commented-out cache is not a cache', () => {
  // Absorbing the following key would let a job's declared paths pick up whatever text happened to
  // sit underneath them.
  const block = [
    '        with:',
    "          cache: 'npm'",
    '          cache-dependency-path: |',
    '            package-lock.json',
    '          node-version: 20',
  ]
  assert.deepEqual(npmCacheConfig(block).paths, ['package-lock.json'])
  assert.equal(npmCacheConfig(['        with:', "          # cache: 'npm' was removed", '          node-version: 20']).cache, null)
})

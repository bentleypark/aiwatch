// #961 — regression guard for the CI gap where a docs-only PR started NO jobs.
//
// `test.yml` sets `paths-ignore` at the WORKFLOW level, so a PR touching only those paths runs
// none of its jobs — including the `unit` job that carries the OKF structural lint. The lint that
// guards `docs/reference/` was therefore skipped exactly when `docs/reference/` changed.
//
// `docs-lint.yml` closes that hole by firing on precisely the paths `test.yml` ignores. The two
// files must stay complementary: **every path `test.yml` ignores must be a path `docs-lint.yml`
// watches**, or a doc path silently becomes ungated again. That invariant is what this file pins.
//
// A regex parser rather than a YAML dependency: the two blocks have a fixed, trivial shape, and the
// parser itself is unit-tested against a synthetic fixture below.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const wf = (name) => readFileSync(join(repoRoot, '.github/workflows', name), 'utf8')

/**
 * Parse one YAML scalar — `'a'`, `"a"`, or bare `a` — stripping any trailing `# comment`.
 * A quoted scalar must consume the whole item (bar a comment): otherwise an escaped-quote form
 * like `- 'a''b.md'` would silently yield `a`. Throw instead — a wrong value here is invisible,
 * and this parser exists so the guard cannot silently stop guarding.
 */
function scalar(raw, context) {
  const quoted = raw.match(/^'([^']*)'/) ?? raw.match(/^"([^"]*)"/)
  if (quoted) {
    const rest = raw.slice(quoted[0].length).trim()
    if (rest !== '' && !rest.startsWith('#')) {
      throw new Error(`trailing text after quoted scalar in ${context}: ${JSON.stringify(raw)}`)
    }
    return quoted[1]
  }
  const bare = raw.match(/^([^\s#]+)/)
  if (bare) return bare[1]
  throw new Error(`unparseable YAML scalar in ${context}: ${JSON.stringify(raw)}`)
}

/**
 * Collect the entries of a `paths:` / `paths-ignore:` list nested under an `on:` trigger.
 * Returns [] when the trigger or the key is absent. Pure.
 *
 *   on:
 *     pull_request:        <- trigger
 *       paths-ignore:      <- key
 *         - 'docs/**'      <- collected (quote style irrelevant; trailing `# comment` stripped)
 *
 * THROWS on a list item it cannot destructure. That is deliberate: an earlier version matched only
 * single-quoted entries and `break`ed on anything else, so a single double-quoted path added to
 * `test.yml` would truncate the parsed list and the sync assertion below would go GREEN while the
 * new path was left ungated — the guard would silently stop guarding. Fail loud instead.
 */
export function pathsUnder(yaml, trigger, key) {
  const lines = yaml.split('\n')
  const triggerAt = lines.findIndex((l) => l.match(new RegExp(`^  ${trigger}:\\s*$`)))
  if (triggerAt === -1) return []

  const where = `${trigger}.${key}`
  const out = []
  let inKey = false

  for (const line of lines.slice(triggerAt + 1)) {
    if (/^\S/.test(line) || /^  \S/.test(line)) break // left the trigger block

    const keyLine = line.match(new RegExp(`^    ${key}:(.*)$`))
    if (keyLine) {
      const inline = keyLine[1].trim()
      if (inline === '') {
        inKey = true // block style — entries follow
        continue
      }
      const flow = inline.match(/^\[(.*)\]$/) // flow style — `paths: ['a', "b", c]`
      if (!flow) throw new Error(`unrecognised ${where} value: ${JSON.stringify(inline)}`)
      return flow[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => scalar(s, where))
    }

    if (!inKey) continue
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const item = line.match(/^\s+- (.*)$/)
    if (item) {
      out.push(scalar(item[1].trim(), where))
      continue
    }
    if (/^    \S/.test(line)) break // sibling key at the trigger's indent — list ended
    throw new Error(`unexpected line inside ${where}: ${JSON.stringify(line)}`)
  }
  return out
}

test('pathsUnder parses a nested paths list and strips trailing comments', () => {
  const fixture = [
    'on:',
    '  push:',
    '    branches: [main]',
    '    paths-ignore:',
    "      - 'a.md'",
    "      - 'docs/**'   # inline comment",
    '  pull_request:',
    '    paths:',
    "      - 'b.md'",
    'jobs:',
  ].join('\n')

  assert.deepEqual(pathsUnder(fixture, 'push', 'paths-ignore'), ['a.md', 'docs/**'])
  assert.deepEqual(pathsUnder(fixture, 'pull_request', 'paths'), ['b.md'])
  assert.deepEqual(pathsUnder(fixture, 'push', 'paths'), [], 'absent key → []')
  assert.deepEqual(pathsUnder(fixture, 'schedule', 'paths'), [], 'absent trigger → []')
})

test('pathsUnder does not leak entries across sibling triggers', () => {
  const fixture = ['on:', '  push:', '    paths:', "      - 'x.md'", '  pull_request:', '    paths:', "      - 'y.md'"].join('\n')
  assert.deepEqual(pathsUnder(fixture, 'push', 'paths'), ['x.md'])
})

test('pathsUnder accepts every quote style, blank lines and comment lines', () => {
  const fixture = [
    'on:',
    '  push:',
    '    paths-ignore:',
    "      - 'single.md'",
    '      - "double.md"',
    '      - bare.md',
    '',
    '      # a standalone comment',
    "      - 'docs/**'",
    'jobs:',
  ].join('\n')
  assert.deepEqual(pathsUnder(fixture, 'push', 'paths-ignore'), ['single.md', 'double.md', 'bare.md', 'docs/**'])
})

test('pathsUnder reads flow-style lists', () => {
  const fixture = ['on:', '  push:', "    paths-ignore: ['a.md', \"b.md\", c.md]", 'jobs:'].join('\n')
  assert.deepEqual(pathsUnder(fixture, 'push', 'paths-ignore'), ['a.md', 'b.md', 'c.md'])
})

// The regression this parser exists to prevent: a MIXED-quote edit must never truncate the list.
// The old single-quote-only matcher `break`ed on `- "assets/**"`, so `ignored` lost every entry
// after it and the sync assertion passed while `assets/**` ran no CI at all.
test('a double-quoted entry does not truncate the list (guard cannot silently stop guarding)', () => {
  const fixture = [
    'on:',
    '  pull_request:',
    '    paths-ignore:',
    "      - '*.md'",
    '      - "assets/**"',
    "      - 'docs/**'",
    'jobs:',
  ].join('\n')
  assert.deepEqual(pathsUnder(fixture, 'pull_request', 'paths-ignore'), ['*.md', 'assets/**', 'docs/**'])
})

test('pathsUnder throws on a list item it cannot destructure, rather than dropping it', () => {
  const fixture = ['on:', '  push:', '    paths-ignore:', "      - 'ok.md'", '      - # nothing here', 'jobs:'].join('\n')
  assert.throws(() => pathsUnder(fixture, 'push', 'paths-ignore'), /unparseable YAML scalar/)
})

// The only case where the parser could return a WRONG value instead of throwing: YAML's escaped
// single-quote (`''`). Real YAML reads `'a''b.md'` as `a'b.md`; a naive match stops at the second
// quote and yields `a`. Silently wrong is the failure mode this whole file exists to prevent.
test('pathsUnder throws on an escaped-quote scalar rather than silently truncating it', () => {
  const fixture = ['on:', '  push:', '    paths-ignore:', "      - 'a''b.md'", 'jobs:'].join('\n')
  assert.throws(() => pathsUnder(fixture, 'push', 'paths-ignore'), /trailing text after quoted scalar/)
})

test('pathsUnder still accepts a legitimate trailing comment after a quoted scalar', () => {
  const fixture = ['on:', '  push:', '    paths:', "      - 'docs/**'    # the bundle", 'jobs:'].join('\n')
  assert.deepEqual(pathsUnder(fixture, 'push', 'paths'), ['docs/**'])
})

for (const trigger of ['push', 'pull_request']) {
  test(`every path test.yml ignores on ${trigger} is watched by docs-lint.yml (#961)`, () => {
    const ignored = pathsUnder(wf('test.yml'), trigger, 'paths-ignore')
    const watched = pathsUnder(wf('docs-lint.yml'), trigger, 'paths')

    assert.ok(ignored.length > 0, `test.yml must still declare paths-ignore on ${trigger}`)

    const ungated = ignored.filter((p) => !watched.includes(p))
    assert.deepEqual(
      ungated,
      [],
      `these paths run NO CI: test.yml ignores them and docs-lint.yml does not watch them → ${ungated.join(', ')}`,
    )
  })
}

// Both triggers, not just pull_request: dropping the entry from `push` alone left the suite green,
// so a push to main touching only the lockstep re-ran nothing that guards it. Asymmetric drift between
// the two trigger blocks is exactly the class this file exists to pin.
for (const trigger of ['push', 'pull_request']) {
  test(`docs-lint.yml guards its own inputs on ${trigger} — every script it runs, the count lockstep, and itself`, () => {
    const watched = pathsUnder(wf('docs-lint.yml'), trigger, 'paths')
    assert.ok(watched.includes('scripts/lint-okf-bundle.mjs'), 'a change to the lint must re-run the lint')
    assert.ok(watched.includes('scripts/check-doc-symbols.mjs'), 'a change to the doc-symbol lint must re-run it')
    assert.ok(watched.includes('scripts/check-instruction-budget.mjs'), 'a change to the budget ratchet must re-run it')
    assert.ok(watched.includes('api/__tests__/service-count-lockstep.test.ts'), 'a change to the count lockstep must re-run it')
    assert.ok(watched.includes('vitest.config.js'), 'the lockstep gate depends on vitest defaults — a config change must re-run it')
    assert.ok(watched.includes('.github/workflows/docs-lint.yml'), 'a change to the guard must re-run the guard')
  })
}

// #1081 — the paths mirror above proves a docs-only PR starts SOME workflow; it says nothing about
// WHICH checks run. docs-lint.yml ran only the OKF bundle lint, which reads docs/reference/ and never
// a README — so #1074's count lockstep, whose whole point is pinning README.md / README.ko.md /
// CLAUDE.md, was unreachable from the one PR shape that edits them. Assert the job is actually wired,
// or deleting it is silent (a guard whose default state is "pass" needs its own guard).
/**
 * Slice ONE job's own block out of a workflow, so an assertion about job X cannot be satisfied by
 * job Y (an earlier version read the whole file and an `if: false` job could satisfy it). Terminates
 * at the next top-level job key; the charset covers `_`/uppercase so `count_lockstep_v2:` still ends
 * the slice. The LAST job in the file simply runs to EOF. Returns '' when the job is absent.
 */
export function jobBlock(yaml, id) {
  return yaml.split(new RegExp(`^  ${id}:$`, 'm'))[1]?.split(/^  [A-Za-z_][A-Za-z0-9_-]*:$/m)[0] ?? ''
}

/**
 * Drop comments before running any ban-list regex over YAML. This file's house style is heavy prose,
 * so a comment merely containing `if:` would fail CI for no reason — which is precisely how an
 * annoying guard gets deleted. A trailing `#` is stripped only from lines with no quote character,
 * since a `#` inside a quoted scalar is data.
 */
export function stripComments(block) {
  return block
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => (/['"]/.test(l) ? l : l.replace(/\s+#.*$/, '')))
    .join('\n')
}

/** A job must be able to FAIL THE WORKFLOW — every escape found in review lived in that gap. */
function assertCannotBeSkipped(code, id) {
  for (const [pattern, why] of [
    [/\bif:/, 'a job- or step-level `if:` can skip it, and a skipped check reports green'],
    [/\bcontinue-on-error\b/, '`continue-on-error` makes a failing step non-fatal'],
  ]) {
    assert.doesNotMatch(code, pattern, `${id} job: ${why}`)
  }
}

// The three helpers are pinned against fixtures rather than the real workflow, for the reason
// `pathsUnder` is: a mutation to any of them can leave the live-file assertions green, because what
// they guard against is not present in the file today.
test('jobBlock scopes to ONE job — a sibling job cannot satisfy an assertion about this one', () => {
  const yaml = ['jobs:', '  alpha:', '    name: A', '    steps:', '      - run: a', '  beta:', '    if: false', '    steps:', '      - run: b'].join('\n')
  const alpha = jobBlock(yaml, 'alpha')
  assert.match(alpha, /- run: a/)
  assert.doesNotMatch(alpha, /if: false/, "beta's skip guard must not bleed into alpha's block")
  assert.doesNotMatch(alpha, /- run: b/)
})

test('jobBlock runs to EOF for the LAST job, and returns empty for an absent one', () => {
  const yaml = ['jobs:', '  alpha:', '    steps:', '      - run: a', '  omega:', '    steps:', '      - run: z'].join('\n')
  assert.match(jobBlock(yaml, 'omega'), /- run: z/, 'the last job has no terminator and must still be sliced')
  assert.equal(jobBlock(yaml, 'nope'), '', 'an absent job yields empty, which every caller asserts against')
})

test('stripComments removes prose that would false-positive the ban list, but keeps quoted `#`', () => {
  const block = ['    # a comment mentioning if: and continue-on-error', '    - run: node x.mjs   # trailing note', "    - run: echo 'a # b'"].join('\n')
  const out = stripComments(block)
  assert.doesNotMatch(out, /\bif:/, 'a full-line comment must not trip the skip-guard ban list')
  assert.doesNotMatch(out, /continue-on-error/)
  assert.match(out, /- run: node x\.mjs\s*$/m, 'a trailing comment is stripped from the step line')
  assert.match(out, /echo 'a # b'/, "a `#` inside a quoted scalar is data, not a comment")
})

test('assertCannotBeSkipped rejects both ways a job reports green without running', () => {
  assert.throws(() => assertCannotBeSkipped('    if: false\n    steps:', 'x'), /can skip it/)
  assert.throws(() => assertCannotBeSkipped('      continue-on-error: true', 'x'), /non-fatal/)
  assert.doesNotThrow(() => assertCannotBeSkipped('    steps:\n      - run: node x.mjs', 'x'))
})

test('docs-lint.yml actually RUNS the count lockstep, not just the OKF lint (#1081)', () => {
  const yaml = wf('docs-lint.yml')
  // ANCHORED to a step line, so a `#` in front of it breaks the match. An unanchored search matched a
  // commented-out step and stayed green while the job ran `npm ci` and nothing else — and commenting
  // out a step is how a red CI usually gets unblocked, in a file that is already half comment prose.
  assert.match(yaml, /^  count-lockstep:/m, 'the count-lockstep job must exist')
  // Scope to the job's OWN block (up to the next top-level job key or EOF). The earlier
  // `[\s\S]*?` form was non-greedy across the WHOLE file, so it never matched an `if:` sitting
  // immediately under this job — `if: false` passed silently.
  // Charset covers `_` and uppercase so a later job id like `count_lockstep_v2:` still terminates the
  // slice — otherwise that job's keys bleed in and produce a confusing red.
  const block = jobBlock(yaml, 'count-lockstep')
  assert.ok(block.length > 0, 'the count-lockstep job block must be parseable')
  const code = stripComments(block)

  // The step's TEXT existing is not the same as the step being able to FAIL THE WORKFLOW, and every
  // escape found in review lived in that gap. Scope to the JOB BLOCK, not the file: the assertion used
  // to read the whole yaml, so the step could satisfy it from a different (even `if: false`) job.
  assert.match(
    code,
    /^\s+- run: [^\n]*vitest run[^\n]*api\/__tests__\/service-count-lockstep\.test\.ts/m,
    'the count-lockstep job must RUN the lockstep in an uncommented step — otherwise a README-only PR can change a service count with no CI watching',
  )
  assertCannotBeSkipped(code, 'count-lockstep')
  // Targeted rather than a block-wide `||` ban: a legitimate retry on the INSTALL step cannot affect
  // gating, so banning `||` everywhere was pure false-positive risk for no added coverage.
  assert.doesNotMatch(
    code,
    /vitest run[^\n]*(--passWithNoTests|\|\|)/,
    'the vitest step must not be made non-failing (`--passWithNoTests` or a `||` fallback)',
  )
  // Pin the CONFIG the step uses, because the passWithNoTests assertion below hardcodes
  // `vitest.config.js`. Without this the step could point at a sibling root config (worker/ already
  // has one) that DOES set passWithNoTests, and the guard would keep reading the innocent file — the
  // round-3 escape relocated one file further out.
  assert.match(code, /vitest run[^\n]*--config vitest\.config\.js/, 'the step must use the config the passWithNoTests guard checks')
})

// The "a renamed lockstep file fails loudly" property does not live in the workflow at all — it lives
// in vitest's default, which `vitest.config.js` can silently override. Round 3 verified it: with
// `passWithNoTests: true` in the config and the lockstep file missing, vitest exits 0 and prints
// "No test files found". That is the round-2 escape class relocated one file over, and it is the kind
// of ergonomics tweak someone adds for an unrelated reason. Pin it where it actually lives.
test('vitest.config.js does not set passWithNoTests — a missing lockstep must fail (#1081)', () => {
  const cfg = readFileSync(new URL('../vitest.config.js', import.meta.url), 'utf-8')
  assert.doesNotMatch(
    cfg.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n'),
    /passWithNoTests/,
    'passWithNoTests would make a renamed or deleted service-count-lockstep.test.ts exit 0, disarming the docs-lint gate',
  )
})

// A cheap tripwire, not a proof: it only asserts each filename still APPEARS in the lockstep source.
// That survives the loop-style refactor already present in that file (`read(file)` over a list), and
// catches the case that matters — a surface dropped from coverage entirely. It cannot tell whether the
// assertions around the name are still meaningful; only the lockstep's own mutation coverage does that.
test('the count lockstep still names the .md surfaces test.yml ignores (#1081)', () => {
  const lockstep = readFileSync(new URL('../api/__tests__/service-count-lockstep.test.ts', import.meta.url), 'utf-8')
  for (const f of ['README.md', 'README.ko.md', 'CLAUDE.md']) {
    assert.ok(
      lockstep.includes(`'${f}'`),
      `${f} is paths-ignored by test.yml, so docs-lint.yml is its only gate — the lockstep must still cover it`,
    )
  }
})

// #1285 — same shape as the lockstep above: the instruction-budget ratchet's only input on a docs PR
// is CLAUDE.md, which test.yml paths-ignores. If this job is absent or non-fatal, the PR shape that
// grows the always-loaded context is the exact shape with no gate on it.
test('docs-lint.yml actually RUNS the instruction-budget ratchet (#1285)', () => {
  const yaml = wf('docs-lint.yml')
  assert.match(yaml, /^  instruction-budget:/m, 'the instruction-budget job must exist')

  const code = stripComments(jobBlock(yaml, 'instruction-budget'))
  assert.ok(code.length > 0, 'the instruction-budget job block must be parseable')
  assert.match(
    code,
    /^\s+- run: node scripts\/check-instruction-budget\.mjs\s*$/m,
    'the job must RUN the ratchet in an uncommented step with no `||` fallback swallowing its exit code',
  )
  assertCannotBeSkipped(code, 'instruction-budget')
})

// #1285 — the OTHER half of the instruction budget's coverage story. `.claude/hooks/workflow-gates.txt`
// is not a docs path, so Docs Lint never sees it; test.yml is its only gate, via `test:scripts`.
// Asserted here rather than in the budget's own suite because the helpers that make it spelling-proof
// (`pathsUnder`, `jobBlock`) live in this file and are fixture-tested.
const TEST_YML_IGNORED = ['*.md', 'CLAUDE.md', 'docs/**', '.github/**/*.md']

for (const trigger of ['push', 'pull_request']) {
  test(`test.yml ignores exactly the documented docs paths on ${trigger} (#1285)`, () => {
    // The WHOLE list, not a `.claude`-prefix ban: `'**/*.txt'` and `'**/*.sh'` ignore the gate text and
    // the hook that injects it without the string `.claude` appearing anywhere. Adding a pattern here
    // is allowed — it just has to move this line too, in the same diff a human reads.
    assert.deepEqual(
      pathsUnder(wf('test.yml'), trigger, 'paths-ignore'),
      TEST_YML_IGNORED,
      'a new paths-ignore entry may silently stop gating .claude/hooks/workflow-gates.txt',
    )
  })
}

test('test.yml actually RUNS npm run test:scripts (#1285)', () => {
  // The budget suite pins the glob and package.json; neither matters if no workflow invokes it.
  // Deleting this one step leaves every other test in the change green.
  const code = stripComments(jobBlock(wf('test.yml'), 'unit'))
  assert.ok(code.length > 0, 'the unit job block must be parseable')
  assert.match(
    code,
    /^\s+- run: npm run test:scripts\s*$/m,
    'an uncommented step with no `||` fallback — nothing else runs check-instruction-budget.test.mjs',
  )
  assertCannotBeSkipped(code, 'unit')
})

// #671 — a two-sided RATCHET on the major version of every `actions/*` pin in this repo's workflows.
//
// Why a guard and not another note. The Node-20 runner removal (2026-09-16) was filed on 2026-06-15
// and the issue recounted its own pins on 2026-07-29 — and between that recount and the fix landing,
// FOUR more `@v4` pins arrived (`test.yml` 8 → 10, `docs-lint.yml` 6 → 8). Nobody broke a rule; they
// were added by copying the step above. (Which PRs is deliberately not enumerated: the first draft
// named four, and review found two of them had added no pin at all — the list was read off `git log
// -- .github/workflows`, which is a TOUCHED list, not an ADDED one. The counts are the claim; the
// attribution was decoration that outran its evidence.)
// A deadline written in an issue does not reach the moment someone copies a `uses:` line. This does.
//
// What it deliberately does NOT encode: which major of which action runs on which Node. That is an
// external, rotating fact with no home in this repo — it changes when GitHub cuts a release, nothing
// here could test it, and a stale copy of it would become the premise of the next bump
// (memory `feedback_no_prose_mirror_of_code_branches`). FLOOR is instead simply WHAT WE PIN TODAY.
//
// TWO-SIDED, and that is the whole point (the first draft was not, and review reproduced the hole:
// editing `'setup-node': 7` to `4` left the suite green, after which all 12 real `setup-node` pins
// could regress to `@v4` still green). `check-instruction-budget.mjs` (#1285) is the model and it is
// two-sided — `BUDGET_CHARS` *and* `MAX_SLACK` — so citing it while shipping only the lower half was
// citing a precedent without reading it. Rule 2 stops a pin sinking below FLOOR; rule 3 stops FLOOR
// sinking below the pins. Together they force FLOOR == the lowest major actually pinned, so a
// downgrade is a two-place edit that shows up in review. It is a review aid, not a lock: lowering the
// floor AND the pins together is internally consistent and no rule fires — just as lowering
// BUDGET_CHARS alongside the prose does not fire #1285. Rule 3's fixture asserts that limit.
//
// Rules are EXPORTED FUNCTIONS, and the mutation tests at the bottom call the same ones the repo-level
// tests do. The first draft restated each filter chain a second time next to the fixtures, so every
// mutant exercised the restatement: a one-character typo in the real rule (`'actions'` → `'action'`)
// left the suite green while real `@v4` pins shipped (`debugging_fix_the_called_path_not_the_tested_twin`).
//
// KNOWN LIMITS — stated so a green run is not over-trusted:
//   - This reads THIS repo only. `aiwatch-reports` carries its own pins and its own copy of this guard
//     (`scripts/ci-action-majors.test.js`); the two repos share no package, so there is nowhere to put
//     one implementation. Changing the rule means changing both.
//   - `.github/actions/**/action.yml` (composite actions) is not scanned. Neither repo has one today.
//     A `uses:` inside one is unguarded — the tripwire below cannot see a file it never opens.
//   - The parser reads BLOCK-style steps. A YAML flow mapping (`- {uses: x@v4}`) is not parsed; it is
//     REFUSED by `assertNoUnsupportedShape` rather than silently skipped, because a shape both this
//     parser and any same-family ground truth would miss is exactly how a guard goes quietly blind.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(repoRoot, '.github/workflows')

/**
 * Minimum acceptable major per first-party action. Rule 3 pins this to the lowest major actually in
 * the workflows, so raising a pin without raising this entry fails, and lowering this entry without
 * lowering a pin fails too. Both numbers move in the same PR (#671, the Node-20 runner removal).
 */
export const FLOOR = {
  checkout: 7,
  'setup-node': 7,
  cache: 6,
  'upload-artifact': 7,
}

/** Strip a trailing `#` comment. A SHA pin's `# v4.2.2` version note is the case this must survive. */
export function stripComment(line) {
  return line.replace(/#.*$/, '')
}

/** Strip one surrounding quote pair. `aiwatch-reports` quotes scalars by house style, so a quoted
 *  `uses:` value is a correctly-written pin, not an unreadable one — the first draft threw on it. */
export function unquote(s) {
  const m = /^(['"])(.*)\1$/.exec(s)
  return m ? m[2] : s
}

/**
 * A `uses:` KEY line: block style, optional list dash, optional quotes around the key, optional space
 * before the colon. ANCHORED — the first draft matched `uses:` anywhere on the line, so
 * `- run: echo "this step uses: actions/checkout@v4"` was parsed as a real pin.
 */
export const USES_KEY = /^\s*(-\s*)?["']?uses["']?\s*:/

/**
 * A shape this parser cannot read but that still carries a pin. Refused loudly rather than skipped:
 * a flow mapping is invisible to the block-style parser AND to any ground truth written in the same
 * regex family, so silence here is the guard going blind while reporting green.
 */
export function assertNoUnsupportedShape(text, label = '<text>') {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const code = stripComment(lines[i])
    if (/\{[^}]*\buses\b\s*:/.test(code)) {
      throw new Error(`${label}:${i + 1}: YAML flow-mapping step — this guard reads block style only: ${code.trim()}`)
    }
  }
}

/**
 * Every `uses:` reference, as `{ owner, name, ref, line }`. A `uses:` line this cannot destructure
 * THROWS rather than being skipped: a parser that silently shrinks its own input reports green while
 * checking less than it claims. `owner/repo/sub/path@ref` (a subpath action such as
 * `actions/cache/restore@v4`, or a remote reusable workflow) is floored on its OWNER and FIRST
 * segment, which is where the major lives.
 */
export function parseUses(text, label = '<text>') {
  assertNoUnsupportedShape(text, label)
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const code = stripComment(lines[i])
    if (!USES_KEY.test(code)) continue
    const raw = unquote(code.replace(USES_KEY, '').trim())
    if (raw === '') throw new Error(`${label}:${i + 1}: empty \`uses:\``)
    if (raw.startsWith('./') || raw.startsWith('docker://')) {
      out.push({ owner: null, name: null, ref: null, raw, line: i + 1 })
      continue
    }
    const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_.\/-]+)?@(\S+)$/.exec(raw)
    if (!m) throw new Error(`${label}:${i + 1}: \`uses:\` the parser could not read: ${raw}`)
    out.push({ owner: m[1], name: m[2], ref: m[3], raw, line: i + 1 })
  }
  return out
}

/** The major in a bare `@vN` pin, or `null` for anything else (floating ref, full version, SHA). */
export function majorOf(ref) {
  const m = /^v(\d+)$/.exec(ref ?? '')
  return m ? Number(m[1]) : null
}

/** GitHub matches action owners case-insensitively; `Actions/checkout@v4` is the same action. Matching
 *  case-sensitively let it bypass rules 2 AND 3 at once, silently rather than noisily. */
export const isFirstParty = (u) => (u.owner ?? '').toLowerCase() === 'actions'

// ── The rules. Exported, and called by BOTH the repo-level tests and the mutation tests. ───────────

/** Rule 1 — refs that are not a bare `@vN` major pin (floating ref, full version, SHA). */
export function notBareMajor(uses) {
  return uses.filter((u) => u.owner !== null && majorOf(u.ref) === null)
}

/** Rule 2 — `actions/*` pins below their floor. `majorOf(...) !== null` first, and not for tidiness:
 *  `null < 7` is `true` in JS, so without it a floating ref would ALSO be reported here, as
 *  `actions/checkout@main < v7`, sending the reader to the wrong fix. One accurate message per defect. */
export function belowFloor(uses, floor = FLOOR) {
  return uses
    .filter((u) => isFirstParty(u) && floor[u.name] !== undefined)
    .filter((u) => majorOf(u.ref) !== null && majorOf(u.ref) < floor[u.name])
}

/** Rule 3 — the OTHER side of the ratchet: a floor entry below the lowest major actually pinned. */
export function floorBelowPins(uses, floor = FLOOR) {
  const lowest = new Map()
  for (const u of uses) {
    if (!isFirstParty(u) || majorOf(u.ref) === null) continue
    const cur = lowest.get(u.name)
    if (cur === undefined || majorOf(u.ref) < cur) lowest.set(u.name, majorOf(u.ref))
  }
  return [...lowest].filter(([n, low]) => floor[n] !== undefined && floor[n] < low).map(([n, low]) => `${n}: FLOOR ${floor[n]} < lowest pin v${low}`)
}

/** Rule 4 — `actions/*` used with no floor entry, and floor entries no workflow uses. */
export function floorDisagreement(uses, floor = FLOOR) {
  const used = new Set(uses.filter(isFirstParty).map((u) => u.name))
  return {
    unfloored: [...used].filter((n) => floor[n] === undefined).sort(),
    unused: Object.keys(floor).filter((n) => !used.has(n)).sort(),
  }
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
const parsed = files.map((f) => ({ file: f, text: readFileSync(join(DIR, f), 'utf8') }))
const allUses = parsed.flatMap(({ file, text }) => parseUses(text, file).map((u) => ({ ...u, file })))

test('the parser reads every BLOCK-style `uses:` key line, and nothing else claims more (#671)', () => {
  // Not "every `uses:` that exists" — the first draft said that, and it was not true: the ground truth
  // was a second regex of the same family, so a shape both missed held the equality at 0 === 0.
  // `assertNoUnsupportedShape` (inside `parseUses`) is what covers the gap, by refusing rather than
  // by counting. This assertion is the narrower, true one.
  let raw = 0
  for (const { text } of parsed) {
    for (const line of text.split('\n')) if (USES_KEY.test(stripComment(line))) raw++
  }
  assert.equal(allUses.length, raw, `parseUses and the key matcher disagree (parsed ${allUses.length}, matched ${raw})`)
  assert.ok(files.length >= 4, `expected several workflow files, found ${files.length}`)
  assert.ok(allUses.length >= 20, `expected the repo's pins, found ${allUses.length}`)
})

test('every action ref is a bare major pin — no floating refs, full versions or SHAs (#671)', () => {
  const bad = notBareMajor(allUses).map((u) => `${u.file}:${u.line}: ${u.raw}`)
  assert.deepEqual(bad, [], `refs that are not a bare @vN major pin:\n${bad.join('\n')}`)
})

test('RATCHET side A — every actions/* pin is at or above its FLOOR (#671)', () => {
  const below = belowFloor(allUses).map((u) => `${u.file}:${u.line}: ${u.raw} < v${FLOOR[u.name]}`)
  assert.deepEqual(below, [], `pins below the floor — raise the pin, or the floor in this file:\n${below.join('\n')}`)
})

test('RATCHET side B — no FLOOR entry sits below the lowest major actually pinned (#671)', () => {
  // Without this, lowering a FLOOR entry is a one-character edit that lets every pin for that action
  // follow it down, green the whole way. Reproduced in review before this rule existed.
  const sunk = floorBelowPins(allUses)
  assert.deepEqual(sunk, [], `FLOOR entries below what the repo pins — raise them in this PR:\n${sunk.join('\n')}`)
})

test('FLOOR and the workflows agree in BOTH directions (#671)', () => {
  const { unfloored, unused } = floorDisagreement(allUses)
  assert.deepEqual(unfloored, [], `actions/* used with no FLOOR entry — add one so it cannot regress: ${unfloored.join(', ')}`)
  assert.deepEqual(unused, [], `FLOOR entries no workflow uses — a floor that guards nothing: ${unused.join(', ')}`)
})

// ── Parser fixtures — each is a shape that would otherwise pass while guarding nothing ─────────────

const WF = (ref, name = 'checkout') => `jobs:\n  build:\n    steps:\n      - uses: actions/${name}@${ref}\n`

test('majorOf accepts ONLY a bare major', () => {
  assert.equal(majorOf('v7'), 7)
  assert.equal(majorOf('v10'), 10)
  assert.equal(majorOf('v7.0.1'), null)
  assert.equal(majorOf('main'), null)
  assert.equal(majorOf('11bd71901bbe5b1630ceea73d27597364c9af683'), null)
  assert.equal(majorOf(''), null)
  assert.equal(majorOf(undefined), null)
})

test('parseUses reads the shapes real workflows actually contain', () => {
  const ok = (line) => parseUses(line).map((u) => `${u.owner}/${u.name}@${u.ref}`)
  assert.deepEqual(ok('      - uses: actions/checkout@v7   # the source\n'), ['actions/checkout@v7'])
  assert.deepEqual(ok('        uses: actions/checkout@v7\n'), ['actions/checkout@v7'])
  assert.deepEqual(ok('      - uses: "actions/checkout@v7"\n'), ['actions/checkout@v7'])
  assert.deepEqual(ok("      - uses: 'actions/checkout@v7'\n"), ['actions/checkout@v7'])
  assert.deepEqual(ok('      - "uses": actions/checkout@v7\n'), ['actions/checkout@v7'])
  assert.deepEqual(ok('      - uses : actions/checkout@v7\n'), ['actions/checkout@v7'])
  // A subpath action and a remote reusable workflow are floored on owner + first segment.
  assert.deepEqual(ok('      - uses: actions/cache/restore@v4\n'), ['actions/cache@v4'])
  assert.deepEqual(ok('      - uses: org/repo/.github/workflows/x.yml@v1\n'), ['org/repo@v1'])
})

test('parseUses THROWS on a `uses:` it cannot destructure, rather than dropping it', () => {
  assert.throws(() => parseUses('      - uses: actions/checkout\n', 'f.yml'), /could not read/)
  assert.throws(() => parseUses('      - uses:\n', 'f.yml'), /empty/)
})

test('a flow-mapping step is REFUSED, not silently skipped', () => {
  // The shape that held the old ground-truth equality at 0 === 0.
  assert.throws(() => parseUses('      - {uses: actions/checkout@v4}\n', 'f.yml'), /flow-mapping/)
  assert.throws(() => parseUses('      - { uses: actions/checkout@v4, with: {ref: main} }\n', 'f.yml'), /flow-mapping/)
})

test('an anchored detector ignores a `uses:` that is only quoted inside a run: line', () => {
  assert.deepEqual(parseUses('      - run: echo "this step uses: actions/checkout@v4"\n'), [])
  assert.deepEqual(parseUses('      - name: what this uses is documented above\n'), [])
})

test('parseUses keeps a local or docker action but leaves it unfloored', () => {
  assert.equal(parseUses('      - uses: ./.github/actions/setup\n')[0].owner, null)
  assert.equal(parseUses('      - uses: docker://alpine:3.20\n')[0].owner, null)
})

// ── Mutation: every rule must go RED on the shape it exists to catch. These call the SAME exported
// functions the repo-level tests above call — no restated filter chain to mutate instead. ──────────

test('MUTATION rule 2: a copy-pasted @v4 is caught, and the current pin is not', () => {
  assert.equal(belowFloor(parseUses(WF('v4'))).length, 1, 'a @v4 pin did not trip the floor')
  assert.equal(belowFloor(parseUses(WF('v7'))).length, 0, 'the current pin tripped the floor')
  assert.equal(belowFloor(parseUses(WF('v8'))).length, 0, 'a future major tripped the floor')
  // Case-insensitive: `Actions/checkout@v4` used to bypass rules 2 and 3 at once, silently.
  assert.equal(belowFloor(parseUses('      - uses: Actions/checkout@v4\n')).length, 1, 'a capitalised owner bypassed the floor')
})

test('MUTATION rule 1: floating refs, full versions and SHAs are each caught, by ONE rule only', () => {
  for (const ref of ['main', 'master', 'v7.0.1', '11bd71901bbe5b1630ceea73d27597364c9af683']) {
    assert.equal(notBareMajor(parseUses(WF(ref))).length, 1, `${ref} was accepted as a major pin`)
    assert.equal(belowFloor(parseUses(WF(ref))).length, 0, `${ref} was ALSO reported as below the floor`)
  }
  assert.equal(notBareMajor(parseUses(WF('v7'))).length, 0)
})

test('MUTATION rule 3: a FLOOR entry lowered below the pins is caught — the ratchet is two-sided', () => {
  // Literal floors, never the live FLOOR: a fixture that reads the real config tests the config, not
  // the function, and passes or fails for reasons its own name does not describe. (An earlier draft
  // compared against live FLOOR here and so appeared to catch a coordinated downgrade it does not.)
  const pins = parseUses(WF('v7', 'setup-node'))
  assert.deepEqual(floorBelowPins(pins, { 'setup-node': 4 }), ['setup-node: FLOOR 4 < lowest pin v7'])
  assert.deepEqual(floorBelowPins(pins, { 'setup-node': 7 }), [], 'a floor equal to the pin was reported as sunk')
  // An intentional BUMP trips this side until the floor follows — that is the two-place edit working.
  assert.deepEqual(floorBelowPins(parseUses(WF('v9', 'setup-node')), { 'setup-node': 7 }), ['setup-node: FLOOR 7 < lowest pin v9'])
  // WHAT THIS RATCHET DOES NOT DO, stated rather than implied: lowering the floor AND the pins
  // together is consistent, so no rule here fires. The guarantee is that a downgrade costs a
  // two-place edit visible in the diff — the same guarantee `check-instruction-budget.mjs` gives,
  // where BUDGET_CHARS and the prose can also be lowered together. It is a review aid, not a lock.
  assert.deepEqual(floorBelowPins(parseUses(WF('v4', 'setup-node')), { 'setup-node': 4 }), [])
})

test('MUTATION rule 4: an unfloored actions/* is caught, and so is a dead FLOOR entry', () => {
  const uses = parseUses('      - uses: actions/stale@v1\n')
  assert.deepEqual(floorDisagreement(uses, { checkout: 7 }).unfloored, ['stale'])
  // Subject non-empty in both directions: a dead entry is reported, and an EMPTY floor is not silently fine.
  assert.deepEqual(floorDisagreement(parseUses(WF('v7')), { checkout: 7, retired: 3 }).unused, ['retired'])
  assert.deepEqual(floorDisagreement(parseUses(WF('v7')), {}).unfloored, ['checkout'])
})

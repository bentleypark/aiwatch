// Unit tests for the decision-graph structural lint (#967).
//
// The pure functions are the whole testable surface: the IO half reads a harness-global memory
// bundle that CI cannot check out, so `npm run test:scripts` gates the logic and `npm run lint:graph`
// gates the actual bundle locally.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseEdges,
  parseWikilinks,
  stripCode,
  issueNumber,
  checkEdgeGrammar,
  findDuplicateClaims,
  findDanglingLinks,
  claimedIssues,
  deliveredIssues,
  pinnedIssues,
  parsePinned,
  liveness,
  deliveredLiveness,
  foldCandidates,
  classifyGhError,
  findUnclaimed,
  SUBJECT_PREFIX,
  NOT_A_SLICE,
} from './lint-decision-graph.mjs'

test('parseEdges reads both wikilink and issue targets', () => {
  const t = 'bounds:: [[decision_x]] · advances:: #842 · constrains:: #920'
  assert.deepEqual(parseEdges(t), [
    { rel: 'bounds', target: 'decision_x', kind: 'page', gloss: null },
    { rel: 'advances', target: '842', kind: 'issue', gloss: null },
    { rel: 'constrains', target: '920', kind: 'issue', gloss: null },
  ])
})

// The real bundle carries `constrains:: #842-B`. A `#(\d+)` capture silently truncated it to 842 —
// an unrelated, real issue. A structural lint that misreads a target id is worse than not checking.
test('parseEdges keeps a suffixed issue id whole, never truncating #842-B to 842', () => {
  assert.deepEqual(parseEdges('constrains:: #842-B'), [{ rel: 'constrains', target: '842-B', kind: 'issue', gloss: null }])
  assert.equal(issueNumber('842-B'), null)
  assert.equal(issueNumber('842'), 842)
})

test('an advances:: edge with a non-dereferenceable id is a loud finding, not a silent 842', () => {
  const f = checkEdgeGrammar({ initiative_a: 'advances:: #842-B (모델 프로빙)' })
  assert.equal(f.length, 1)
  assert.equal(f[0].kind, 'edge-undereferenceable')
  assert.deepEqual([...claimedIssues({ initiative_a: 'advances:: #842-B' })], [], 'never dereferenced')
})

// Vocabulary docs and memory pages both write example edges inside backticks — `bounds:: #862` is
// literally a don't-do-this illustration in decision-graph.md. Those must not become real edges.
test('stripCode blanks code spans and fenced blocks, so an example edge is not an edge', () => {
  assert.deepEqual(parseEdges('never write `bounds:: #862` on a constraint page'), [])
  assert.deepEqual(parseEdges('```\nadvances:: #5\n```'), [])
  assert.deepEqual(parseEdges('`advances:: #5` but really advances:: #7'), [
    { rel: 'advances', target: '7', kind: 'issue', gloss: null },
  ])
  assert.equal(stripCode('a `b` c').length, 'a `b` c'.length, 'offsets preserved')
})

test('parseEdges ignores a backticked prose mention with no target', () => {
  // MEMORY.md's section note says "…/ `advances::` 슬라이스" — a mention, not an edge.
  assert.deepEqual(parseEdges('the `advances::` slices are listed on the page'), [])
})

test('parseWikilinks collects every link target', () => {
  assert.deepEqual(parseWikilinks('see [[a_b]] and [[c]] again [[a_b]]'), ['a_b', 'c', 'a_b'])
})

test('checkEdgeGrammar flags an edge written on a page that cannot be its subject', () => {
  const f = checkEdgeGrammar({ decision_x: 'bounds:: [[decision_y]]' })
  assert.equal(f.length, 1)
  assert.equal(f[0].kind, 'edge-wrong-subject')
  assert.match(f[0].detail, /constraint_/)
})

test('checkEdgeGrammar accepts each relation on its allowed subject page', () => {
  const pages = {
    constraint_a: 'bounds:: [[decision_a]]',
    decision_a: 'constrains:: [[initiative_a]] · supersedes:: [[decision_b]]',
    initiative_a: 'advances:: #1 (슬라이스)',
    project_a: 'evidences:: [[decision_a]]',
  }
  assert.deepEqual(checkEdgeGrammar(pages), [])
})

test('checkEdgeGrammar rejects a bounds:: edge aimed at an issue number', () => {
  // The #917 invariant: a Decision always has a page, so `bounds:: #862` (a PR standing in for an
  // unrecorded architecture decision) must never be written.
  const f = checkEdgeGrammar({ constraint_a: 'bounds:: #862' })
  assert.equal(f.length, 1)
  assert.equal(f[0].kind, 'edge-wrong-object')
})

// Object-side rules the doc states. Review found the lint enforced only half of one of them.
test('checkEdgeGrammar enforces the object PAGE TYPE, not just page-vs-issue', () => {
  const bad = checkEdgeGrammar({ constraint_a: 'bounds:: [[initiative_x]]' })
  assert.equal(bad[0].kind, 'edge-wrong-object')
  assert.match(bad[0].detail, /decision_/)
  assert.deepEqual(checkEdgeGrammar({ constraint_a: 'bounds:: [[decision_x]]' }), [])
})

test('checkEdgeGrammar rejects supersedes:: aimed at an issue (rule 3: a Decision always has a page)', () => {
  const f = checkEdgeGrammar({ decision_a: 'supersedes:: #862' })
  assert.equal(f[0].kind, 'edge-wrong-object')
})

test('checkEdgeGrammar rejects advances:: aimed at a page (its object is always an Issue)', () => {
  const f = checkEdgeGrammar({ initiative_a: 'advances:: [[decision_x]]' })
  assert.equal(f[0].kind, 'edge-wrong-object')
  assert.match(f[0].detail, /must target an issue/)
})

test('checkEdgeGrammar allows constrains:: to target a page OR an issue', () => {
  assert.deepEqual(checkEdgeGrammar({ decision_a: 'constrains:: [[project_x]] · constrains:: #920' }), [])
})

test('checkEdgeGrammar rejects `blocks::` as a wiki edge', () => {
  const f = checkEdgeGrammar({ initiative_a: 'blocks:: #5' })
  assert.equal(f[0].kind, 'edge-not-a-wiki-edge')
  assert.equal(SUBJECT_PREFIX.blocks, null)
})

test('findDuplicateClaims catches one issue claimed by two initiatives', () => {
  const pages = { initiative_a: 'advances:: #7', initiative_b: 'advances:: #7 · advances:: #8' }
  assert.deepEqual(findDuplicateClaims(pages), [
    { kind: 'duplicate-claim', issue: '7', owners: ['initiative_a', 'initiative_b'] },
  ])
})

test('findDuplicateClaims keys on the raw id, so #842 and #842-B are distinct designations', () => {
  const pages = { initiative_a: 'advances:: #842', initiative_b: 'advances:: #842-B' }
  assert.deepEqual(findDuplicateClaims(pages), [], 'different slices, not a double claim')
})

test('findDuplicateClaims ignores advances:: written outside an initiative page', () => {
  assert.deepEqual(findDuplicateClaims({ decision_a: 'advances:: #7', initiative_a: 'advances:: #7' }), [])
})

test('findDanglingLinks reports a link with no page', () => {
  const pages = { a: 'see [[b]] and [[missing]]', b: 'hi' }
  assert.deepEqual(findDanglingLinks(pages), [{ kind: 'dangling-wikilink', page: 'a', target: 'missing' }])
})

// Symmetry with parseEdges: the vocabulary's page-format snippet shows `[[decision_y]]` inside a
// fence. An example link must not become a hard exit-1 finding.
test('findDanglingLinks ignores a wikilink inside a code fence or span', () => {
  assert.deepEqual(findDanglingLinks({ a: '```\n[[decision_ghost]]\n```' }), [])
  assert.deepEqual(findDanglingLinks({ a: 'write `[[decision_ghost]]` like so' }), [])
  assert.equal(findDanglingLinks({ a: '`[[x_ghost]]` but real [[y_ghost]]' }).length, 1)
})

test('checkEdgeGrammar enforces a MULTI-prefix object range, per the doc', () => {
  // constrains → Initiative / Decision / Project / Issue
  assert.deepEqual(checkEdgeGrammar({ decision_a: 'constrains:: [[initiative_x]]' }), [])
  assert.deepEqual(checkEdgeGrammar({ decision_a: 'constrains:: [[project_x]]' }), [])
  const bad = checkEdgeGrammar({ decision_a: 'constrains:: [[feedback_x]]' })
  assert.equal(bad[0].kind, 'edge-wrong-object')
  // evidences → Decision / Initiative, never a project object
  assert.deepEqual(checkEdgeGrammar({ project_a: 'evidences:: [[decision_x]]' }), [])
  assert.equal(checkEdgeGrammar({ project_a: 'evidences:: [[project_x]]' })[0].kind, 'edge-wrong-object')
})

test('claimedIssues collects slices from initiative pages only', () => {
  const pages = { initiative_a: 'advances:: #1 · advances:: #2', decision_a: 'constrains:: #3' }
  assert.deepEqual([...claimedIssues(pages)].sort(), [1, 2])
})

// The bug that made the first hand-run of this check report nine false failures: `gh api` returns
// a LOWERCASE `state`, and the check compared it against `'OPEN'`. Every live edge looked dead.
test('liveness accepts GitHub lowercase "open" — the comparison that broke the first hand-run', () => {
  assert.equal(liveness(842, { state: 'open' }), null)
})

test('liveness also accepts an uppercase state, so a gh CLI change cannot silently fail everything', () => {
  assert.equal(liveness(842, { state: 'OPEN' }), null)
})

// #969 flipped this: a CLOSED issue on an `advances::` edge is not a dead edge — it is delivered.
// The old semantics meant an issue left the graph the moment it shipped, so the graph held only
// backlog and "what advanced this initiative" had to be re-derived from prose.
test('liveness calls a closed advances:: target DELIVERED, not dead', () => {
  const f = liveness(1, { state: 'closed' })
  assert.equal(f.kind, 'edge-should-be-delivered')
  assert.match(f.detail, /move advances:: → delivered::/)
})

test('liveness still flags missing and PR targets as dead', () => {
  assert.equal(liveness(2, null).kind, 'dead-edge')
  assert.match(liveness(2, null).detail, /no such issue/)
  assert.equal(liveness(3, { state: 'open', pull_request: {} }).kind, 'dead-edge')
  assert.match(liveness(3, { state: 'open', pull_request: {} }).detail, /is a PR/)
})

test('deliveredLiveness is the mirror: an OPEN target belongs on advances::', () => {
  assert.equal(deliveredLiveness(1, { state: 'closed' }), null)
  const f = deliveredLiveness(2, { state: 'open' })
  assert.equal(f.kind, 'edge-should-be-advances')
  assert.equal(deliveredLiveness(3, null).kind, 'dead-edge')
  assert.equal(deliveredLiveness(4, { state: 'closed', pull_request: {} }).kind, 'dead-edge')
})

test('parseEdges reads a folded period aggregate, only as a delivered:: object', () => {
  assert.deepEqual(parseEdges('delivered:: 2026-04 ×6'), [
    { rel: 'delivered', target: '2026-04', kind: 'period', count: 6, gloss: null },
  ])
  assert.deepEqual(parseEdges('delivered:: 2026-04 x6'), [
    { rel: 'delivered', target: '2026-04', kind: 'period', count: 6, gloss: null },
  ])
  assert.deepEqual(checkEdgeGrammar({ initiative_a: 'delivered:: 2026-04 ×6' }), [], 'legal on delivered')
  assert.equal(checkEdgeGrammar({ initiative_a: 'advances:: 2026-04 ×6' })[0].kind, 'edge-wrong-object')
})

// A work list of bare numbers is unreadable: "delivered:: #778 · #777 · #805" tells a reader nothing.
test('advances/delivered issue edges require a gloss; other relations do not', () => {
  assert.equal(checkEdgeGrammar({ initiative_a: 'advances:: #547' })[0].kind, 'edge-missing-gloss')
  assert.equal(checkEdgeGrammar({ initiative_a: 'delivered:: #936' })[0].kind, 'edge-missing-gloss')
  assert.deepEqual(checkEdgeGrammar({ initiative_a: 'advances:: #547 (아웃티지 CTA 전환 누수)' }), [])
  assert.deepEqual(checkEdgeGrammar({ initiative_a: 'delivered:: #936 (pin — UTM 귀속 봉합)' }), [])
  assert.deepEqual(checkEdgeGrammar({ initiative_a: 'delivered:: 2026-04 ×6' }), [], '접힌 기간은 gloss 불요')
  assert.deepEqual(checkEdgeGrammar({ decision_a: 'constrains:: #920' }), [], 'constrains 는 gloss 불요')
})

test('parseEdges captures the gloss and multiple glossed edges on one line', () => {
  const edges = parseEdges('advances:: #547 (전환 누수) · advances:: #842 (오디언스 측정)')
  assert.deepEqual(edges.map((e) => [e.target, e.gloss]), [
    ['547', '전환 누수'],
    ['842', '오디언스 측정'],
  ])
})

// A gloss-less edge followed by a `(…)` note on the NEXT line must NOT swallow that note as its gloss
// — that would silently defeat the gloss-required check for exactly the hand-writer who forgot one.
test('a parenthetical on the next line is not swallowed as the edge gloss', () => {
  assert.deepEqual(parseEdges('advances:: #547\n(stray note)'), [
    { rel: 'advances', target: '547', kind: 'issue', gloss: null },
  ])
  assert.equal(checkEdgeGrammar({ initiative_a: 'advances:: #547\n(stray note)' })[0].kind, 'edge-missing-gloss')
  // but a same-line gloss still attaches
  assert.equal(parseEdges('advances:: #547 (전환 누수)')[0].gloss, '전환 누수')
})

// The dangling check and the edge grammar must share a wikilink charset, or a dangling `[[Upper]]` /
// `[[a-b]]` is a real edge object yet invisible to findDanglingLinks (escapes exit 1).
test('findDanglingLinks sees the same wikilink targets parseEdges does', () => {
  assert.equal(findDanglingLinks({ a: 'bounds:: [[Decision_Ghost]]' }).length, 1)
  assert.equal(findDanglingLinks({ a: 'bounds:: [[decision-ghost]]' }).length, 1)
})

test('parsePinned finds only the pinned delivered ids', () => {
  const t = 'delivered:: #936 (pin — invalidates pre-07-08 data) · delivered:: #777 · advances:: #842'
  assert.deepEqual([...parsePinned(t)], [936])
})

test('foldCandidates skips pinned edges and anything inside the horizon', () => {
  const now = '2026-07-09T00:00:00Z'
  const rows = [
    { issue: 936, closedAt: '2026-01-01T00:00:00Z' }, // old but pinned
    { issue: 777, closedAt: '2026-06-26T00:00:00Z' }, // inside 90d
    { issue: 100, closedAt: '2026-01-01T00:00:00Z' }, // old, unpinned → foldable
    { issue: 101, closedAt: null }, // no close date → never folded
  ]
  assert.deepEqual(foldCandidates(rows, new Set([936]), now), [100])
  assert.deepEqual(foldCandidates(rows, new Set(), now, 400), [], 'a wide horizon folds nothing')
})

// The bug that would have bitten an operator: a bare `catch {}` treated EVERY gh failure as a 404,
// so one network blip during `memory-lint` would report all nine edges dead and exit 1.
test('classifyGhError calls only a real 404 "missing"; everything else is "unreachable"', () => {
  assert.equal(classifyGhError('gh: Not Found (HTTP 404)'), 'missing')
  assert.equal(classifyGhError('HTTP 404: Not Found'), 'missing')
  assert.equal(classifyGhError('dial tcp: lookup api.github.com: no such host'), 'unreachable')
  assert.equal(classifyGhError('gh: API rate limit exceeded (HTTP 403)'), 'unreachable')
  assert.equal(classifyGhError('gh auth login required'), 'unreachable')
  assert.equal(classifyGhError('HTTP 502: Bad Gateway'), 'unreachable')
  assert.equal(classifyGhError(undefined), 'unreachable', 'no stderr → never claim the edge is dead')
})

test('findUnclaimed returns candidates, excluding the initiatives own pointer issues', () => {
  const board = [
    { number: 547, labels: ['area:marketing'] }, // claimed
    { number: 920, labels: ['area:marketing'] }, // genuinely unclaimed
    { number: 803, labels: ['area:marketing'] }, // the growth initiative's own pointer issue
    { number: 428, labels: ['area:biz'] }, // a Decision node, not an execution unit
    { number: 999, labels: ['area:dev'] }, // not initiative-ish
  ]
  assert.deepEqual(findUnclaimed(new Set([547]), board), [920])
  assert.ok(NOT_A_SLICE.has(803) && NOT_A_SLICE.has(637) && NOT_A_SLICE.has(428))
})

test('findUnclaimed never reports a claimed issue', () => {
  const board = [{ number: 861, labels: ['area:marketing'] }]
  assert.deepEqual(findUnclaimed(new Set([861]), board), [])
})

// NOT_A_SLICE is a STRUCTURAL exclusion list, not a place to bury judgements. An issue adjudicated
// "not a slice" (e.g. #880, a breadth add that depth-not-breadth constrains rather than advances)
// must keep surfacing, or a dated judgement becomes permanent and un-revisitable.
test('NOT_A_SLICE holds only pointer issues and Decision nodes — never adjudicated exclusions', () => {
  assert.deepEqual([...NOT_A_SLICE].sort((a, b) => a - b), [428, 637, 803])
  for (const adjudicated of [880, 345]) {
    assert.ok(!NOT_A_SLICE.has(adjudicated), `#${adjudicated} is a judgement, not a structural exclusion`)
    assert.deepEqual(
      findUnclaimed(new Set(), [{ number: adjudicated, labels: ['area:biz'] }]),
      [adjudicated],
      'an adjudicated exclusion must keep surfacing as a candidate',
    )
  }
})

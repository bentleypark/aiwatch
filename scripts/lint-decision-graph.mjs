// Decision-graph structural lint (#967, vocabulary from #917).
//
// WHY: `strategy-review` reports an initiative's live slices from the `advances::` edges on its
// `initiative_*` page. Those edges are a hand reading. Calling that wholesale "not machine-verifiable"
// conflates four different failures — two of which are ordinary structural checks:
//
//   (a) dead edge      — points at a closed issue, a PR number, or nothing   → checkable
//   (b) double claim   — one issue claimed by two initiatives                → checkable
//   (c) wrong claim    — a real open issue that does not advance it          → JUDGEMENT
//   (d) missing claim  — an issue that does advance it, unlisted             → candidates only
//
// So this lint does (a) and (b) as hard findings, reports (d) as *candidates*, and never touches (c).
// A lint that adjudicates (c)/(d) manufactures false confidence. Same split `docs/reference/index.md`
// already draws for the OKF bundle: structural health is mechanical, judgement health is a human pass.
//
// NOT CI-GATED, by construction: the memory bundle is harness-global (`~/.claude/.../memory/`), not
// repo content, so Actions has nothing to check out. Unlike `lint-okf-bundle.mjs`, which lints the
// in-repo `docs/reference/` bundle. The PURE functions below are CI-gated via `npm run test:scripts`;
// the bundle assertion is a local `npm run lint:graph` invoked by the `memory-lint` skill.
//
// The GitHub half (`--github`) shells out to `gh`. It is opt-in so the pure path stays offline.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_MEMORY_DIR = join(
  homedir(),
  '.claude/projects/-Users-bentley-Desktop-bentely-aiwatch-aiwatch/memory',
)

/** Which page-name prefix may be the SUBJECT of each relation (decision-graph.md rules 1 + 1b). */
export const SUBJECT_PREFIX = {
  bounds: 'constraint_',
  constrains: 'decision_',
  supersedes: 'decision_',
  advances: 'initiative_', // rule 1b: page-less Issue subject → written on the object's page
  delivered: 'initiative_', // #969: the same edge after the issue closed
  evidences: 'project_', // a Metric subject is prose (`**Evidence:**`), never a typed edge
  blocks: null, // Issue → Issue: lives in GitHub, never a typed edge in the wiki
}

/** #969 — a `delivered::` edge older than this (by close date) is a fold candidate, unless pinned. */
export const FOLD_HORIZON_DAYS = 90

/**
 * Object-side rules the vocabulary states. `pagePrefix` = the page type the object must be;
 * `allowIssue` = whether a `#N` object is legal at all.
 *   - `bounds` / `supersedes` target a Decision, which ALWAYS has a page (rule 3) — so no issue objects.
 *   - `constrains` may target an Initiative/Decision/Project page OR an Issue.
 *   - `advances` targets an Issue, never a page.
 */
export const OBJECT_RULE = {
  bounds: { pagePrefix: ['decision_'], allowIssue: false },
  supersedes: { pagePrefix: ['decision_'], allowIssue: false },
  constrains: { pagePrefix: ['initiative_', 'decision_', 'project_'], allowIssue: true },
  evidences: { pagePrefix: ['decision_', 'initiative_'], allowIssue: false },
  advances: { pagePrefix: [], allowIssue: true }, // [] = no page object is legal
  delivered: { pagePrefix: [], allowIssue: true, allowPeriod: true }, // #969: also `2026-04 ×6`
  blocks: null,
}

/**
 * STRUCTURAL exclusions only: an initiative's own thin-pointer issue (#803, #637) and a Decision node
 * that happens to be filed as an issue (#428). These can never be slices *by construction* — a thread
 * cannot advance itself, and a Decision is not an execution unit.
 *
 * DO NOT add an issue here because you judged it "not a slice". #880 (a breadth service-add that
 * `decision_depth_not_breadth` *constrains* rather than advances) and #345 (self-host) are exactly
 * that, and they must keep surfacing as candidates: a judgement is dated, the situation changes, and
 * an issue silently suppressed here can never be re-adjudicated. Record the judgement on the
 * initiative page instead — visible, dated, revisitable. The lint reports; it does not adjudicate.
 *
 * MAINTENANCE POINT: hardcoded. A NEW initiative's pointer issue must be added. Blast radius is the
 * exit-0 report only, never a hard finding.
 */
export const NOT_A_SLICE = new Set([803, 637, 428])

// `#([0-9][\w-]*)` — capture the WHOLE id including a suffix. `#842-B` must not silently become 842
// (an unrelated real issue); it is live vocabulary in this repo. Numeric-only ids are validated
// downstream, where a suffixed id becomes a loud finding for the relations that dereference it.
// `2026-04 ×6` (or `x6`) — a folded period aggregate, legal only as a `delivered::` object (#969).
// A trailing `(…)` is the edge's GLOSS — what it means for the thread, in the initiative's language.
// The pre-gloss whitespace is same-line only (`[^\S\n]`, not `\s`): a `\s*` would let a NEWLINE-then-`(`
// note-line on the NEXT line be swallowed as this edge's gloss, silently defeating the gloss-required
// check for exactly the hand-writer who forgot to gloss and wrote a bare note below.
const EDGE_RE =
  /\b(advances|delivered|constrains|supersedes|evidences|bounds|blocks)::\s*(\[\[([^\]]+)\]\]|#([0-9][\w-]*)|(\d{4}-\d{2})\s*[×x]\s*(\d+))[^\S\n]*(\(([^)]*)\))?/g
const PINNED_RE = /\bdelivered::\s*#(\d+)\s*\(\s*pin\b/g
// Same charset as EDGE_RE's wikilink inner (`[^\]]+`), so a dangling `[[Upper_Case]]` / `[[a-b]]` link
// is not invisible to the dangling check while being a real edge object to the grammar check.
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g
const FENCE_RE = /```[\s\S]*?```/g
const CODESPAN_RE = /`[^`\n]*`/g

/**
 * Blank out fenced blocks and inline code spans, preserving offsets. Vocabulary docs and memory
 * pages both write *example* edges inside backticks (`` `bounds:: #862` `` as a don't-do-this
 * illustration); without this they parse as real edges and produce a false hard finding. Pure.
 */
export function stripCode(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ')
  return text.replace(FENCE_RE, blank).replace(CODESPAN_RE, blank)
}

/**
 * Extract every typed edge from one page. Returns `{rel, target, kind}` where `kind` is
 * `'page'` (a `[[wikilink]]`, target = the link text verbatim) or `'issue'` (a `#N`, target = the
 * id STRING — `'842'`, `'842-B'`). Pure. Code spans are stripped first, so a backticked example
 * edge is not an edge; a bare `advances::` mention has no target and never matches.
 */
export function parseEdges(text) {
  const out = []
  for (const m of stripCode(text).matchAll(EDGE_RE)) {
    const gloss = m[8]?.trim() || null
    if (m[5]) out.push({ rel: m[1], target: m[5], kind: 'period', count: Number(m[6]), gloss })
    else out.push({ rel: m[1], target: m[3] ?? m[4], kind: m[3] ? 'page' : 'issue', gloss })
  }
  return out
}

/** Which relations must gloss an issue target: the two a reader meets as a work list. */
export const GLOSS_REQUIRED = new Set(['advances', 'delivered'])

/** Issue ids marked `delivered:: #N (pin …)` — never fold candidates, whatever their age. Pure. */
export function parsePinned(text) {
  return new Set([...stripCode(text).matchAll(PINNED_RE)].map((m) => Number(m[1])))
}

/** An issue id we can dereference against GitHub. `'842'` → 842; `'842-B'` → null. Pure. */
export function issueNumber(target) {
  return /^\d+$/.test(target) ? Number(target) : null
}

/** Every `[[wikilink]]` target in a page. Pure. */
export function parseWikilinks(text) {
  return [...text.matchAll(WIKILINK_RE)].map((m) => m[1])
}

/**
 * (a)-structural + grammar: does each edge sit on a page allowed to be its subject?
 * `pages` is `{ [pageName]: text }`. Returns findings, most specific first. Pure.
 */
export function checkEdgeGrammar(pages) {
  const findings = []
  for (const [page, text] of Object.entries(pages)) {
    for (const { rel, target, kind, gloss } of parseEdges(text)) {
      // A bare `#N` in a work list is unreadable — the number is a citation, never the noun.
      if (GLOSS_REQUIRED.has(rel) && kind === 'issue' && !gloss) {
        findings.push({ kind: 'edge-missing-gloss', page, rel, detail: `${rel}:: #${target} needs a (gloss)` })
      }
      const subject = SUBJECT_PREFIX[rel]
      if (subject === null) {
        findings.push({ kind: 'edge-not-a-wiki-edge', page, rel, detail: `${rel} lives in GitHub, not the wiki` })
        continue
      }
      if (!page.startsWith(subject)) {
        findings.push({ kind: 'edge-wrong-subject', page, rel, detail: `${rel}:: must be written on a ${subject}* page` })
      }

      const obj = OBJECT_RULE[rel]
      if (kind === 'period') {
        if (!obj.allowPeriod) {
          findings.push({ kind: 'edge-wrong-object', page, rel, detail: `${rel}:: cannot take a folded period, got ${target}` })
        }
        continue
      }
      if (kind === 'issue') {
        if (!obj.allowIssue) {
          findings.push({ kind: 'edge-wrong-object', page, rel, detail: `${rel}:: must target a page, got #${target}` })
        } else if ((rel === 'advances' || rel === 'delivered') && issueNumber(target) === null) {
          // Only these two are dereferenced against GitHub, so only they need a numeric id.
          findings.push({ kind: 'edge-undereferenceable', page, rel, detail: `${rel}:: #${target} is not a plain issue id` })
        }
      } else if (!obj.pagePrefix.some((p) => target.startsWith(p))) {
        const want = obj.pagePrefix.length ? `a ${obj.pagePrefix.map((p) => `${p}*`).join(' / ')} page` : 'an issue'
        findings.push({ kind: 'edge-wrong-object', page, rel, detail: `${rel}:: must target ${want}, got [[${target}]]` })
      }
    }
  }
  return findings
}

/** (b) one issue claimed as a slice by two initiatives. Pure. */
export function findDuplicateClaims(pages) {
  const byIssue = new Map()
  for (const [page, text] of Object.entries(pages)) {
    if (!page.startsWith('initiative_')) continue
    for (const { rel, target, kind } of parseEdges(text)) {
      if (rel !== 'advances' || kind !== 'issue') continue
      if (!byIssue.has(target)) byIssue.set(target, [])
      byIssue.get(target).push(page)
    }
  }
  return [...byIssue.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([issue, owners]) => ({ kind: 'duplicate-claim', issue, owners }))
}

/**
 * Dangling `[[wikilink]]`: target has no page. Pure.
 * Strips code first, symmetrically with `parseEdges` — the `type:decision` page-format snippet in the
 * vocabulary doc shows `[[decision_y]]` inside a fence, and an example link must not be a hard finding.
 */
export function findDanglingLinks(pages) {
  const names = new Set(Object.keys(pages))
  const findings = []
  for (const [page, text] of Object.entries(pages)) {
    for (const target of parseWikilinks(stripCode(text))) {
      if (!names.has(target)) findings.push({ kind: 'dangling-wikilink', page, target })
    }
  }
  return findings
}

/** Every dereferenceable `advances:: #N` across all initiative pages. Pure. */
export function claimedIssues(pages) {
  const out = new Set()
  for (const [page, text] of Object.entries(pages)) {
    if (!page.startsWith('initiative_')) continue
    for (const { rel, target, kind } of parseEdges(text)) {
      if (rel !== 'advances' || kind !== 'issue') continue
      const n = issueNumber(target)
      if (n !== null) out.add(n) // a suffixed id is already an `edge-undereferenceable` finding
    }
  }
  return out
}

/** Every dereferenceable `delivered:: #N` across initiative pages (period folds excluded). Pure. */
export function deliveredIssues(pages) {
  const out = new Set()
  for (const [page, text] of Object.entries(pages)) {
    if (!page.startsWith('initiative_')) continue
    for (const { rel, target, kind } of parseEdges(text)) {
      if (rel !== 'delivered' || kind !== 'issue') continue
      const n = issueNumber(target)
      if (n !== null) out.add(n)
    }
  }
  return out
}

/** Union of every page's pinned delivered ids. Pure. */
export function pinnedIssues(pages) {
  const out = new Set()
  for (const text of Object.values(pages)) for (const n of parsePinned(text)) out.add(n)
  return out
}

/**
 * Classify a failed `gh api issues/N` call. Only a 404 means the edge is dead; a network loss, an
 * expired token, a 403 rate-limit or a 5xx must NOT be reported as a dead edge — that would tell the
 * operator the whole graph is broken during a blip, the exact false confidence this lint exists to
 * avoid. Pure: takes the thrown error's stderr. Returns `'missing'` or `'unreachable'`.
 */
export function classifyGhError(stderr) {
  return /HTTP 404|Not Found/i.test(String(stderr ?? '')) ? 'missing' : 'unreachable'
}

/**
 * (a)-liveness verdict for one issue, given GitHub's own payload. Pure — split out precisely
 * because the first hand-run of this check compared `gh`'s lowercase `open` against `'OPEN'` and
 * reported nine false failures. `state` arrives lowercase; a PR has a `pull_request` key.
 */
export function liveness(issue, payload) {
  if (payload == null) return { kind: 'dead-edge', issue, detail: 'no such issue' }
  if (payload.pull_request) return { kind: 'dead-edge', issue, detail: 'is a PR, not an issue' }
  const state = String(payload.state ?? '').toLowerCase()
  if (state !== 'open') {
    // #969: a closed issue is not a dead edge — it is DELIVERED. Say so, so the fix is obvious.
    return { kind: 'edge-should-be-delivered', issue, detail: `issue is ${state}; move advances:: → delivered::` }
  }
  return null
}

/** The `delivered::` mirror: the object must be a CLOSED issue. Pure (#969). */
export function deliveredLiveness(issue, payload) {
  if (payload == null) return { kind: 'dead-edge', issue, detail: 'no such issue' }
  if (payload.pull_request) return { kind: 'dead-edge', issue, detail: 'is a PR, not an issue' }
  const state = String(payload.state ?? '').toLowerCase()
  if (state === 'open') {
    return { kind: 'edge-should-be-advances', issue, detail: 'issue is open; move delivered:: → advances::' }
  }
  return null
}

/**
 * Fold candidates: `delivered::` issues closed longer ago than the horizon and not pinned.
 * A REPORT, never a finding — folding is lossy, so `memory-lint`'s rule applies: propose, don't apply.
 * `closedAt` is the GitHub `closed_at` string; `now` is injected so this stays pure and testable.
 */
export function foldCandidates(deliveredWithClosedAt, pinned, now, horizonDays = FOLD_HORIZON_DAYS) {
  const cutoff = new Date(now).getTime() - horizonDays * 86400_000
  return deliveredWithClosedAt
    .filter(({ issue, closedAt }) => !pinned.has(issue) && closedAt && new Date(closedAt).getTime() < cutoff)
    .map(({ issue }) => issue)
    .sort((a, b) => a - b)
}

/**
 * (d) candidates, never a failure: open initiative-ish issues that no initiative claims.
 * `boardIssues` is `[{number, labels: string[]}]`. Pure.
 */
export function findUnclaimed(claimed, boardIssues, initiativeLabels = ['area:biz', 'area:marketing']) {
  return boardIssues
    .filter((i) => i.labels.some((l) => initiativeLabels.includes(l)))
    .filter((i) => !claimed.has(i.number))
    .filter((i) => !NOT_A_SLICE.has(i.number))
    .map((i) => i.number)
}

// ─── IO ────────────────────────────────────────────────────────────────────────

function readBundle(dir) {
  const pages = {}
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md' || f === 'log.md') continue
    pages[f.replace(/\.md$/, '')] = readFileSync(join(dir, f), 'utf8')
  }
  return pages
}

const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }))

const printFindings = (findings) => {
  for (const f of findings) console.log(`  ❌ ${f.kind}: ${JSON.stringify(f)}`)
}

function main(argv) {
  const dir = process.env.MEMORY_DIR ?? DEFAULT_MEMORY_DIR
  if (!existsSync(dir)) {
    console.error(`memory bundle not found: ${dir}\nSet MEMORY_DIR to override.`)
    process.exit(2)
  }
  let pages
  try {
    pages = readBundle(dir)
  } catch (err) {
    // A read/permission error is a TOOL failure (exit 2), not a graph defect (exit 1) — do not let an
    // unreadable page masquerade as a structural finding.
    console.error(`could not read the memory bundle at ${dir}: ${err instanceof Error ? err.message : err}`)
    process.exit(2)
  }
  const findings = [
    ...checkEdgeGrammar(pages),
    ...findDuplicateClaims(pages),
    ...findDanglingLinks(pages),
  ]

  const claimed = claimedIssues(pages)
  const delivered = deliveredIssues(pages)
  const pinned = pinnedIssues(pages)
  console.log(
    `decision-graph lint — ${Object.keys(pages).length} pages, ${claimed.size} pending / ${delivered.size} delivered slices (${pinned.size} pinned)`,
  )

  let unclaimed = []
  let foldable = []
  if (argv.includes('--github')) {
    const unreachable = (what, err) => {
      // Print what we already know BEFORE bailing — otherwise the operator loses every structural
      // finding (and any dead edge already confirmed) to a network blip on a later call.
      printFindings(findings)
      console.error(`\n⚠️  could not reach GitHub (${what}): ${String(err?.stderr ?? err).trim().split('\n')[0]}`)
      console.error('   Liveness + unclaimed passes SKIPPED — a tool failure, not a graph failure.')
      console.error(`   ${findings.length} finding(s) printed above were collected before the failure.`)
      process.exit(2)
    }
    const fetchIssue = (n) => {
      try {
        return gh(['api', `repos/:owner/:repo/issues/${n}`])
      } catch (err) {
        if (classifyGhError(err?.stderr) === 'unreachable') unreachable(`issue #${n}`, err)
        return null // a genuine 404
      }
    }

    for (const n of [...claimed].sort((a, b) => a - b)) {
      const bad = liveness(n, fetchIssue(n))
      if (bad) findings.push(bad)
    }

    const deliveredMeta = []
    for (const n of [...delivered].sort((a, b) => a - b)) {
      const payload = fetchIssue(n)
      const bad = deliveredLiveness(n, payload)
      if (bad) findings.push(bad)
      else deliveredMeta.push({ issue: n, closedAt: payload?.closed_at })
    }
    foldable = foldCandidates(deliveredMeta, pinned, new Date().toISOString())
    let board
    try {
      board = gh(['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,labels'])
    } catch (err) {
      unreachable('board listing', err)
    }
    unclaimed = findUnclaimed(
      claimed,
      board.map((i) => ({ number: i.number, labels: i.labels.map((l) => l.name) })),
    )
  } else {
    console.log('  (offline — pass --github for edge liveness + the unclaimed report)')
  }

  printFindings(findings)
  if (unclaimed.length) {
    console.log(`\n  ❓ unclaimed candidates (judgement, NOT a failure): ${unclaimed.map((n) => `#${n}`).join(' ')}`)
    console.log('     Each is either a real missing slice, or correctly excluded. Decide; do not auto-add.')
  }
  if (foldable.length) {
    console.log(`\n  📦 foldable delivered edges (closed >${FOLD_HORIZON_DAYS}d, unpinned): ${foldable.map((n) => `#${n}`).join(' ')}`)
    console.log('     Collapse into `delivered:: YYYY-MM ×N`, or pin one that still binds a decision.')
    console.log('     Folding is lossy — the lint proposes, you apply.')
  }

  if (findings.length === 0) console.log('✅ 0 structural findings — edge grammar, claims, and wikilinks all clean.')
  process.exit(findings.length === 0 ? 0 : 1)
}

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
}

if (isMain()) main(process.argv.slice(2))

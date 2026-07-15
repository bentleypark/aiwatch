// docs/reference OKF-bundle lint (#891 Phase 4).
//
// WHY: `docs/reference/*` is an Open Knowledge Format bundle — one concept per markdown file with
// `type`/`title`/`description`(+optional `tags`) frontmatter, an `index.md` catalog, and a `log.md`
// history (see docs/reference/index.md). Nothing enforces that shape, so it silently drifts: a new
// doc lands without frontmatter or without an index line, a rename leaves a dangling cross-link, or a
// `description` carrying a bare `#N` gets truncated by YAML's inline-comment rule (the exact gotcha
// hit in #891 Phase 1). This is the STRUCTURAL half of the `memory-lint` skill — catching drift the
// moment docs change instead of on a periodic sweep.
//
// CI wiring (#961): a DOCS PR is gated by `.github/workflows/docs-lint.yml`, which runs this file
// directly (`node scripts/lint-okf-bundle.mjs`). A CODE PR is gated by the `REAL docs/reference
// bundle` assertion in `lint-okf-bundle.test.mjs`, under `npm run test:scripts` in `test.yml`. Two
// workflows because `test.yml` `paths-ignore`s `docs/**`, so a docs-only PR starts none of its jobs
// — which is how this lint came to be skipped exactly when docs changed. `workflow-paths-sync.test.mjs`
// pins the two path lists complementary.
//
// CHECKS (all structural / mechanical — no judgement calls):
//   1. frontmatter integrity — every page has `type` + `title` + `description`; `type` is a known
//      OKF type; no `description`/`title` truncated by an unquoted bare ` #` (YAML comment start).
//   2. cross-link resolution — every same-dir `](foo.md)` markdown link resolves to a bundle file.
//   3. index drift — every non-index page is listed in `index.md`; every `index.md` link resolves.
//
// NOT checked (belongs to the human/AI `memory-lint` pass, not a mechanical gate): contradictions,
// stale claims, prose quality, whether cross-linking is *sufficient*.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_DIR = join(REPO_ROOT, 'docs/reference')

export const OKF_TYPES = ['architecture', 'runbook', 'reference', 'index', 'log']
export const REQUIRED_FIELDS = ['type', 'title', 'description']
export const INDEX_FILE = 'index.md'
export const LOG_FILE = 'log.md'

// ── pure helpers (unit-tested with fixtures) ─────────────────────────────────

/**
 * Parse the leading `---\n…\n---` YAML frontmatter block into a flat key→string map, replicating the
 * ONE YAML rule this lint cares about: a `#` preceded by whitespace in an UNQUOTED plain scalar starts
 * an inline comment (so the value is truncated there). Quoted (`"…"`/`'…'`) values are taken verbatim.
 * Returns `{ hasFrontmatter, fields, rawFields }` — `fields` = post-comment-strip (what a loader sees),
 * `rawFields` = the exact source value (so a lint can tell a truncation happened).
 */
export function parseFrontmatter(source) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (!m) return { hasFrontmatter: false, fields: {}, rawFields: {} }
  const fields = {}
  const rawFields = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]
    const raw = kv[2]
    rawFields[key] = raw
    fields[key] = stripInlineComment(raw)
  }
  return { hasFrontmatter: true, fields, rawFields }
}

/** Apply YAML's plain-scalar inline-comment rule + unwrap a simple quoted scalar. */
export function stripInlineComment(raw) {
  const v = raw.trim()
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    return v.slice(1, -1) // quoted → verbatim, no comment processing
  }
  if (v.startsWith('#')) return '' // whole plain value is a comment (e.g. `description: #891 …` → null)
  const hash = v.search(/\s#/) // whitespace-then-# starts a comment in a plain scalar
  return (hash === -1 ? v : v.slice(0, hash)).trim()
}

/** True when an unquoted value would be truncated by a bare `#` YAML inline comment (leading OR after whitespace). */
export function hasUnquotedHashTruncation(raw) {
  const v = raw.trim()
  if (v.startsWith('"') || v.startsWith("'")) return false // quoted → safe
  return /(^|\s)#/.test(v) // `#foo` (whole value) or `foo #bar` (trailing) both truncate
}

/** Findings about one page's frontmatter. `name` is the bundle-relative filename. */
export function frontmatterFindings(name, source) {
  const findings = []
  const { hasFrontmatter, fields, rawFields } = parseFrontmatter(source)
  if (!hasFrontmatter) {
    findings.push({ file: name, kind: 'no-frontmatter', message: 'missing `---` YAML frontmatter block' })
    return findings
  }
  for (const field of REQUIRED_FIELDS) {
    if (!fields[field]) findings.push({ file: name, kind: 'missing-field', message: `frontmatter missing \`${field}\`` })
  }
  if (fields.type && !OKF_TYPES.includes(fields.type)) {
    findings.push({ file: name, kind: 'bad-type', message: `\`type: ${fields.type}\` is not an OKF type (${OKF_TYPES.join('/')})` })
  }
  for (const field of ['title', 'description']) {
    if (rawFields[field] !== undefined && hasUnquotedHashTruncation(rawFields[field])) {
      findings.push({
        file: name,
        kind: 'unquoted-hash',
        message: `\`${field}\` has an unquoted \` #\` — YAML truncates it to "${fields[field]}"; wrap the value in quotes`,
      })
    }
  }
  return findings
}

/** Same-dir `](foo.md)` / `](foo.md#anchor)` link targets (anchors stripped). Ignores URLs + pathed links. */
export function extractLocalMdLinks(source) {
  const out = []
  const re = /\]\(([^)\s]+?\.md)(#[^)]*)?\)/g
  let m
  while ((m = re.exec(source))) {
    const target = m[1].replace(/^\.\//, '') // treat `./foo.md` as the same-dir `foo.md`
    if (target.includes('/') || target.includes(':')) continue // pathed or protocol → not a same-dir bundle link
    out.push(target)
  }
  return out
}

/** Findings for cross-links in one page that don't resolve to a bundle file. */
export function linkResolutionFindings(name, source, bundleNames) {
  const findings = []
  for (const target of new Set(extractLocalMdLinks(source))) {
    if (!bundleNames.has(target)) {
      findings.push({ file: name, kind: 'broken-link', message: `link \`${target}\` does not resolve to a bundle file` })
    }
  }
  return findings
}

/**
 * Index-drift findings across the whole bundle. `entries` = `[{ name, source }]`.
 *   - every `index.md` link must resolve to a file        → `index-broken-link`
 *   - every non-index/non-log page must be in `index.md`  → `not-indexed`
 * (log.md is exempt from the "must be indexed" rule only if the index chooses not to list it; the real
 * bundle DOES list it, so a missing log link still surfaces — we require log.md indexed too.)
 */
export function indexDriftFindings(entries) {
  const findings = []
  const names = new Set(entries.map((e) => e.name))
  const index = entries.find((e) => e.name === INDEX_FILE)
  if (!index) {
    findings.push({ file: INDEX_FILE, kind: 'missing-index', message: `bundle has no ${INDEX_FILE} catalog` })
    return findings
  }
  const indexed = new Set(extractLocalMdLinks(index.source))
  for (const target of indexed) {
    if (!names.has(target)) findings.push({ file: INDEX_FILE, kind: 'index-broken-link', message: `catalog link \`${target}\` has no file` })
  }
  for (const { name } of entries) {
    if (name === INDEX_FILE) continue
    if (!indexed.has(name)) findings.push({ file: name, kind: 'not-indexed', message: `page is not linked from ${INDEX_FILE}` })
  }
  return findings
}

/** Run every check over `entries` (`[{ name, source }]`). Returns a flat findings array. */
export function lintBundle(entries) {
  const names = new Set(entries.map((e) => e.name))
  const findings = []
  for (const { name, source } of entries) {
    findings.push(...frontmatterFindings(name, source))
    findings.push(...linkResolutionFindings(name, source, names))
  }
  findings.push(...indexDriftFindings(entries))
  return findings
}

// ── filesystem (used by CLI + the real-bundle test) ──────────────────────────

/** Collect `{ name, source }` for every `.md` directly under `docs/reference/`. */
export function collectBundleEntries(bundleDir = BUNDLE_DIR) {
  return readdirSync(bundleDir)
    .filter((n) => n.endsWith('.md') && statSync(join(bundleDir, n)).isFile())
    .sort()
    .map((name) => ({ name, source: readFileSync(join(bundleDir, name), 'utf8') }))
}

/** Lint the real bundle. Returns `{ findings, count }`. */
export function lintRealBundle() {
  const findings = lintBundle(collectBundleEntries())
  return { findings, count: findings.length }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
}

if (isMain()) {
  const entries = collectBundleEntries()
  const findings = lintBundle(entries)
  console.log(`OKF bundle lint — docs/reference: ${entries.length} pages`)
  if (findings.length === 0) {
    console.log('✅ 0 findings — frontmatter, cross-links, and index catalog all clean.')
  } else {
    console.error(`\n❌ ${findings.length} finding(s):`)
    for (const f of findings) console.error(`  • [${f.kind}] ${f.file}: ${f.message}`)
    console.error('\nFix: add/repair frontmatter (quote a `#`-bearing description), repoint the dangling link, or add the index line.')
    process.exit(1)
  }
}

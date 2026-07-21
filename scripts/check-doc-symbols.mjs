#!/usr/bin/env node
// #1100 — CI guard: an inline-backtick identifier cited in CLAUDE.md / docs/reference must exist in
// the source tree (or be allowlisted). Promotes feedback_verify_claims rule 7 ("grep a cited symbol
// right after writing it") from a prose reminder — which only fires if remembered — to an executed
// check that fires at doc-edit time.
//
// The gap it closes (#1076): a doc line justified itself with `violationsOf` (the real symbol is
// `isViolation`), so a reader who grepped it got nothing. An invented identifier reads as verifiable
// and isn't — worse than a vague sentence.
//
// SCOPE is deliberately narrow, because the value is precision not coverage:
//   - Docs scanned: CLAUDE.md + docs/reference/*.md. In-repo docs about in-repo code — the CI-gatable,
//     high-signal surface. NOT the harness-global memory bundle (cross-repo symbols, not CI-checkable).
//   - Fenced code blocks (```…```) are stripped: those are examples, not claims about existing code.
//   - Only CODE-SHAPED tokens are checked: camelCase or containing `_`. A bare lowercase word in
//     backticks (`services`, `path`) is too ambiguous to flag; the point is to catch invented symbols,
//     not to police prose. This is what keeps the false-positive rate survivable.
//
// The scan is ~20 lines; the real work (see the issue) is false-positive control — the allowlist for
// deliberate mentions of absent symbols ("there is no `CACHE_NAME`") and external library symbols.
//
// Catches ONE class: invented/renamed symbols in in-repo docs. Does NOT catch wrong line numbers
// (rule already forbids them), stale-but-existing symbols, or any judgment-class defect.
//
// Run via `npm run test:scripts` (check-doc-symbols.test.mjs calls the pure fns) and directly as a CLI.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Code + config roots scanned for existence. The rule is "grep the symbol", and grep finds
 *  `ignoreCommand` in vercel.json or a GA4 event name in a config as readily as in src — so appearing
 *  ANYWHERE here = grep-findable = exists for the reader. Kept a curated list (not a blind whole-repo
 *  walk) so the scan stays fast and predictable; add a root when a doc legitimately cites a symbol that
 *  lives only there. */
export const SOURCE_DIRS = ['worker/src', 'src', 'api', 'scripts', '.claude/hooks', '.claude/skills', '.github', 'public', 'tests', 'e2e', 'extension', 'plugin']
/** Plus top-level config files (not a dir walk). */
export const SOURCE_FILES = ['vercel.json', 'package.json', 'index.html', 'worker/wrangler.toml', 'playwright.config.js', 'vite.config.js']
/** Extensions counted as source/config. */
export const SOURCE_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|json|html|ya?ml|toml)$/

/** Docs scanned. CLAUDE.md + every docs/reference/*.md. */
export function docFiles(root = ROOT) {
  const files = ['CLAUDE.md']
  const refDir = join(root, 'docs/reference')
  if (existsSync(refDir)) {
    for (const f of readdirSync(refDir)) if (f.endsWith('.md')) files.push(`docs/reference/${f}`)
  }
  return files
}

/**
 * Common built-ins / globals that are code-shaped, appear in prose, and are never "our symbols".
 * Kept small and explicit — a big stoplist hides real danglers. Extend the ALLOWLIST file instead
 * for doc-specific cases.
 */
export const STOPLIST = new Set([
  'JSON', 'Promise', 'Array', 'Object', 'Math', 'Date', 'Set', 'Map', 'RegExp', 'Boolean', 'Number',
  'String', 'Symbol', 'Error', 'Infinity', 'undefined', 'null', 'true', 'false', 'NaN', 'console',
  'window', 'document', 'globalThis', 'process', 'Buffer', 'URL', 'URLSearchParams', 'Response',
  'Request', 'Headers', 'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder',
])

/** Strip fenced code blocks (```…``` and ~~~…~~~) so their contents are not read as prose claims. */
export function stripFencedBlocks(md) {
  return md.replace(/^([ \t]*)(```|~~~)[\s\S]*?\n\1\2[ \t]*$/gm, '')
}

/**
 * Is this backtick token a CODE-SHAPED identifier worth checking?
 * - identifier shape, ≥4 chars
 * - camelCase (a lowercase letter later followed by an uppercase) OR contains `_`
 * A bare all-lowercase word or an ALLCAPS-only word without `_` is NOT flagged: too ambiguous / too
 * often an English word or a one-word service id that legitimately appears in prose.
 */
export function isCodeShaped(tok) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{3,}$/.test(tok)) return false
  if (tok.includes('_')) return true
  if (/[a-z][A-Z]/.test(tok)) return true // camelCase / PascalCase-with-lower
  return false
}

/**
 * A line/sentence that documents a symbol's REMOVAL, RENAME, or absence. The hardest false positive is
 * a doc CORRECTLY saying "#713 removed `estimateUptimeFromIncidents`" — shape-identical to #1076's
 * invented `violationsOf`, distinguishable only by the surrounding prose. If a removal/rename/absence
 * verb sits on the same line, the cited symbol is deliberately absent, not a dangler.
 *
 * Deliberately line-scoped, not whole-doc: these docs use paragraph-length lines, so "same line" ≈
 * "same thought". Residual risk — a NEW invented symbol added to a paragraph that also says "removed"
 * would be masked — is accepted as rare; the allowlist covers anything this misses.
 */
export function isRemovalContext(line) {
  return /\b(removed?|delet|dropp|retired?|deprecat|no longer|renamed?|replaced by|was `|used to|former|gone\b|absent)\b/i.test(line)
    || /삭제|제거|없앴|없어졌|폐기|이전 이름|옛/.test(line)
}

/** Extract inline-backtick identifier tokens from prose (fenced blocks already stripped). */
export function extractInlineTokens(prose) {
  const out = new Set()
  for (const line of prose.split('\n')) {
    if (isRemovalContext(line)) continue // a line documenting removal/rename cites absent symbols on purpose
    // single-backtick spans; skip double+ (rare). Token = the identifier at the head of the span
    // (`foo`, `foo.bar`→foo, `foo()`→foo).
    for (const m of line.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
      const head = m[1].trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)
      if (head && isCodeShaped(head[1]) && !STOPLIST.has(head[1]) && !isMemoryPageName(head[1])) out.add(head[1])
    }
  }
  return out
}

/**
 * Concatenate all source into one blob for SUBSTRING existence checks. Substring, not exact-token,
 * because the rule this enforces is "grep the cited symbol" — and `grep` is substring. That is not a
 * detail: it is what makes the check mirror what a human would actually do, so a doc that writes
 * `incidentKeyword` where the source has `incidentKeywords` (or `analyzeWithSonnet` for
 * `analyzeWithSonnetDetailed`) PASSES — a reader greps it and finds it. Only a name that appears
 * NOWHERE as a substring (the #1076 `violationsOf`/`isViolation` shape — a different word, not a
 * truncation) is a finding. This eliminates the singular/plural + truncation false positives that an
 * exact-token match produced on the first run, without letting an invented name through.
 */
export function collectSourceBlob(root = ROOT, dirs = SOURCE_DIRS, files = SOURCE_FILES) {
  const parts = []
  const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'worktrees'])
  const SELF = new Set(['check-doc-symbols.mjs', 'check-doc-symbols.test.mjs'])
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(rel); continue }
      if (!SOURCE_EXTS.test(e.name)) continue
      // Exclude THIS lint's own files: they embed invented-symbol examples (`violationsOf`, …) as
      // string literals, so counting them would register those very names as "exists" and blind the
      // check to the #1076 case it was built to catch (found in review).
      if (SELF.has(e.name)) continue
      parts.push(readFileSync(join(root, rel), 'utf8'))
    }
  }
  for (const d of dirs) walk(d)
  for (const f of files) { try { parts.push(readFileSync(join(root, f), 'utf8')) } catch { /* absent */ } }
  return parts.join('\n')
}

/**
 * A memory-bundle page name (`feedback_…`, `decision_…`, `initiative_…`, etc.). The `docs/reference`
 * OKF mirror legitimately cites these — they are wiki-page identifiers, not claims about a source
 * symbol — so they are not this lint's target.
 */
export function isMemoryPageName(tok) {
  return /^(feedback|debugging|project|reference|decision|constraint|initiative)_[a-z0-9_]+$/.test(tok)
}

/** Parse the allowlist file: `token  # reason`. A token with no reason is itself a finding. */
export function parseAllowlist(text) {
  const allow = new Map()
  const noReason = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+)\s*(?:#\s*(.*))?$/)
    if (!m) continue
    const reason = (m[2] || '').trim()
    if (!reason) noReason.push(m[1])
    allow.set(m[1], reason)
  }
  return { allow, noReason }
}

/**
 * Pure audit: given doc {file, content} entries, the source-symbol set, and the allowlist map, return
 * findings. A finding = a code-shaped inline token absent from source and not allowlisted.
 */
export function auditDocSymbols({ docs, sourceBlob, allow = new Map() }) {
  const findings = []
  for (const { file, content } of docs) {
    const tokens = extractInlineTokens(stripFencedBlocks(content))
    for (const tok of tokens) {
      if (allow.has(tok)) continue
      if (sourceBlob.includes(tok)) continue // grep-equivalent substring existence
      findings.push({ file, token: tok })
    }
  }
  return findings
}

// ── CLI ──
function main() {
  const allowPath = join(ROOT, 'docs/reference/doc-symbols-allow.txt')
  const allowText = existsSync(allowPath) ? readFileSync(allowPath, 'utf8') : ''
  const { allow, noReason } = parseAllowlist(allowText)
  if (noReason.length) {
    console.error(`❌ allowlist entries without a reason (add \`# why\`): ${noReason.join(', ')}`)
    process.exit(1)
  }
  const docs = docFiles().map((f) => ({ file: f, content: readFileSync(join(ROOT, f), 'utf8') }))
  const sourceBlob = collectSourceBlob()
  const findings = auditDocSymbols({ docs, sourceBlob, allow })
  if (findings.length === 0) {
    console.log(`✅ doc-symbol lint: ${docs.length} docs clean (${allow.size} allowlisted)`)
    return
  }
  console.error(`❌ doc-symbol lint: ${findings.length} cited symbol(s) not found in source and not allowlisted:`)
  for (const f of findings) console.error(`   ${f.file}: \`${f.token}\``)
  console.error(`\nFix the name, or if it is a deliberate mention of an absent/external symbol, add it to`)
  console.error(`docs/reference/doc-symbols-allow.txt with a one-line reason.`)
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()

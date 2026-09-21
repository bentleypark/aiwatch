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
//     high-signal surface. NOT the private-repo memory bundle (cross-repo symbols, not CI-checkable).
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
 * invented `violationsOf`, distinguishable only by the surrounding prose.
 *
 * `delet` carries `\w*` because it never matched anything (#1312). The group's trailing `\b` demands a
 * non-word character after the alternative, and "deleted" continues with "e" — so the stem was dead
 * from #1100. Nothing noticed: the exemption used to be judged on the WHOLE line, and a 16.6k-character
 * line needs only ONE trigger anywhere in it, which the full-word alternatives always supplied. The two
 * defects hid each other — narrowing the scope without this fix surfaces three legitimate removal
 * citations in product-constraints.md as false positives.
 *
 * `dropp` and `deprecat` were dead the same way and stay dead, deliberately. The corpus does not
 * implicate them — in these docs "dropped" is the ordinary word for a runtime discard and "deprecation"
 * appears as a data value, not as a note that a symbol is gone. Reviving a stem the corpus does not
 * force is a new exemption rule, not a bug fix. Both directions are pinned by tests.
 */
export function isRemovalContext(line) {
  return /\b(removed?|delet\w*|retired?|no longer|renamed?|replaced by|was `|used to|former|gone\b|absent)\b/i.test(line)
    || /삭제|제거|없앴|없어졌|폐기|이전 이름|옛/.test(line)
}

/** How far from a citation a removal verb still governs it. DERIVED, not picked: the furthest citation
 *  in CLAUDE.md and docs/reference that needs the exemption sits 151 characters from its verb
 *  (`estimateUptimeFromIncidents` in product-constraints.md), and 200 clears it with margin. The lower
 *  bound is pinned by the real-corpus test, which reddens once the window stops covering that citation.
 *  A removal note further than this from its symbol fails loudly and takes an allowlist entry — the
 *  designed exit. */
export const REMOVAL_WINDOW_CHARS = 200

/** The text a citation's exemption is judged on: itself plus `REMOVAL_WINDOW_CHARS` either side.
 *
 *  Judging the whole line is what #1312 was: kv-schema.md's `growth:daily` cell is ONE line of 16.6k
 *  characters carrying "used to", "ABSENT" and "removed", so every symbol in it was exempt and a
 *  fabricated name planted there survived.
 *
 *  A window, not a splitter. Splitting the line at table pipes and sentence ends was tried and is wrong
 *  in both directions: it cuts INSIDE inline code spans — `string | null` in backticks becomes two
 *  fragments with unbalanced backticks, and every identifier after the cut stops being extracted at all
 *  — and it cuts too finely the other way, so on the canonical
 *  removal row `| oldFn | removed in #713 |` the verb and the symbol land in different cells and a
 *  correct doc becomes a false positive. A window needs no notion of a boundary and has neither. */
export function removalWindow(line, start, end) {
  return line.slice(Math.max(0, start - REMOVAL_WINDOW_CHARS), end + REMOVAL_WINDOW_CHARS)
}

/** Extract inline-backtick identifier tokens from prose (fenced blocks already stripped). */
export function extractInlineTokens(prose) {
  const out = new Set()
  for (const line of prose.split('\n')) {
    // single-backtick spans; skip double+ (rare). Token = the identifier at the head of the span
    // (`foo`, `foo.bar`→foo, `foo()`→foo).
    for (const m of line.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
      const head = m[1].trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)
      if (!head || !isCodeShaped(head[1]) || STOPLIST.has(head[1]) || isMemoryPageName(head[1])) continue
      // a removal/rename verb NEAR this citation means the symbol is absent on purpose
      if (isRemovalContext(removalWindow(line, m.index, m.index + m[0].length))) continue
      out.add(head[1])
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

// ── #1444: membership claims ───────────────────────────────────────────────
//
// The symbol check above asks whether a cited name EXISTS. It cannot ask whether a cited MEMBERSHIP is
// true, because a service id (`cohere`, `groq`) is a bare lowercase word, deliberately out of
// `isCodeShaped`'s scope. So "`displayComponentIds`: elevenlabs, replicate, assemblyai" passed CI while
// #1384 had already taken replicate off that path.
//
// ONE direction only. No enumeration in this tree states its field's set exactly — they are
// illustrations, not completeness claims — so "omits a member" cannot be told from `e.g.` and is not
// checked. "Names a NON-member" has no such ambiguity and is what shipped wrong.

/** Files whose COMMENTS are scanned alongside the docs — a wrong membership in a config comment is the
 *  same defect as one in a doc, and #1100's scope stops at docs. */
export const MEMBERSHIP_COMMENT_FILES = ['worker/src/services.ts', 'worker/src/types.ts']

/**
 * The truth: every `{ id: '…', … }` literal in services.ts, with the top-level config keys it sets.
 * Brace-matched rather than line-scoped so a reformatted entry still parses, and quote-aware so a `{`
 * inside a string value does not shift the depth.
 */
export function parseServiceConfigs(text) {
  const out = []
  const head = /\{\s*id:\s*'([a-z0-9_-]+)'/g
  let m
  while ((m = head.exec(text))) {
    let depth = 0, i = m.index, quote = null
    for (; i < text.length; i++) {
      const c = text[i]
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue }
      if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') { depth--; if (depth === 0) break }
    }
    const body = text.slice(m.index, i + 1)
    const keys = new Set()
    let d = 0, q = null
    for (let j = 0; j < body.length; j++) {
      const c = body[j]
      if (q) { if (c === '\\') j++; else if (c === q) q = null; continue }
      if (c === "'" || c === '"' || c === '`') { q = c; continue }
      if (c === '{' || c === '[') { d++; continue }
      if (c === '}' || c === ']') { d--; continue }
      if (d !== 1 || /[A-Za-z0-9_]/.test(body[j - 1] || '')) continue
      const k = body.slice(j).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/)
      if (k) { keys.add(k[1]); j += k[1].length }
    }
    out.push({ id: m[1], keys })
    head.lastIndex = i
  }
  return out
}

/** The optional fields `ServiceConfig` declares. Read separately from the configs because a field NO
 *  service sets still has a member set — the empty one — and deriving the vocabulary from observed keys
 *  alone inverts the check: deleting a field's last setter makes every claim about it more wrong and
 *  the gate greener. 17 fields have exactly one setter today. */
export function declaredConfigFields(typesSrc) {
  const iface = typesSrc.slice(typesSrc.indexOf('export interface ServiceConfig'))
  const body = iface.slice(0, iface.indexOf('\n}'))
  return [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map((m) => m[1])
}

/** field name → the service ids that set it. camelCase keys only, mirroring `isCodeShaped`: a bare
 *  `id`/`name`/`provider` reads as prose, and every service sets those anyway. */
export function fieldMembership(services, declared = []) {
  const members = new Map()
  const add = (k) => { if (/[a-z][A-Z]/.test(k) && !members.has(k)) members.set(k, new Set()) }
  for (const k of declared) add(k)
  for (const s of services) {
    for (const k of s.keys) { add(k); members.get(k)?.add(s.id) }
  }
  return members
}

/** The abbreviations these docs write. Their `.` is not a sentence end, and a sentence is what bounds
 *  the absence slice below. */
const ABBREV = /\b(e\.g|i\.e|etc|vs|cf)\.$/i

export function isSentenceEnd(text, i) {
  if (!'.!?'.includes(text[i])) return false
  const next = text[i + 1]
  if (next !== undefined && !/\s/.test(next)) return false
  return !ABBREV.test(text.slice(Math.max(0, i - 8), i + 1))
}

/**
 * Text that denies membership rather than asserting it — "`displayAllComponents` is not set on …".
 * Judged on the introducer alone, never on the surrounding sentences: reading those silences six
 * of the eight enumerations this check can see, every one of them over a `not` about something else.
 * `no` excludes `no-`, for `no-store`/`no-op`/`no-cache`.
 */
export function isAbsenceContext(introducer) {
  return /\b(?:no|not|never)\b(?!-)/i.test(introducer)
}

/**
 * Split a `.ts` source into the code and the comment prose, in ONE quote-aware pass. Two consumers read
 * the halves — `parseServiceConfigs` the code, the membership scan the comments — and they must not
 * disagree about where the boundary is: a `{ id: 'kimi', componentDenylist: […] }` written as an EXAMPLE
 * in a comment otherwise parses as real config and silences a false claim about kimi, because this one
 * file is both the claim corpus and the truth those claims are checked against. Quote-aware, or the `//`
 * in every `https://` opens a comment that swallows the rest of a config line.
 */
export function splitTsSource(text) {
  let code = '', comments = '', q = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      code += c
      comments += c === '\n' ? '\n' : '' // a multi-line template literal must not desynchronise the halves
      if (c === '\\') { code += text[++i] ?? ''; continue }
      if (c === q) q = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { q = c; code += c; continue }
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const block = text[i + 1] === '*'
      const e = block ? text.indexOf('*/', i + 2) : text.indexOf('\n', i)
      const end = e === -1 ? text.length : e + (block ? 2 : 0)
      const span = text.slice(i, end)
      comments += span
      code += span.replace(/[^\n]/g, ' ') // keep offsets and line breaks
      i = end - 1
      continue
    }
    code += c
    comments += c === '\n' ? '\n' : ' '
  }
  return { code, comments }
}

/** Comment prose, for a `.ts` file. A contiguous run of WHOLE-line comments is ONE line here: it is
 *  wrapped prose, so its line breaks are not sentence ends and a claim written across two of them is
 *  still one claim.
 *
 *  A line that carries code ends the run even when it also carries a trailing comment — 29 lines in
 *  services.ts do. Joining across one fuses a service's docblock, its config entry and the NEXT
 *  service's docblock into a single logical line, where a field name in one service's comment governs
 *  an id run in another's. The two halves keep their line numbering, which is what makes the code line
 *  visible from here. */
export function tsCommentText(text) {
  const { code, comments } = splitTsSource(text)
  const codeLines = code.split('\n')
  const out = []
  let block = null
  const flush = () => { if (block) out.push(block.join(' ')); block = null }
  comments.split('\n').forEach((raw, i) => {
    const line = raw.trim().replace(/^\/[/*]+|^\*+\/?|\*\/$/g, '').trim()
    if (!line) return flush()
    if (codeLines[i].trim()) { flush(); out.push(line); return }
    ;(block ??= []).push(line)
  })
  flush()
  return out.join('\n')
}

/** How far after a field citation an id RUN is still read as that field's enumeration. */
export const RUN_MAX_GAP = 40

/**
 * Is this run the governing field's enumeration, rather than a list that merely passes near its name?
 * Proximity alone is not enough: most runs near a field name in these docs belong to some other
 * sentence, and each is a TRUE sentence the lint would otherwise have to be silenced by rewriting —
 * the failure that ended the clause-parser design. An introducer is short and stays inside one
 * sentence; those runs are not, and the real enumerations are.
 */
export function introduces(between) {
  return between.length <= RUN_MAX_GAP && ![...between].some((_, i) => isSentenceEnd(between, i))
}

/** Citations chained by a separator alone — "`a`/`b`/`c`" — are one citation for the purpose of what
 *  governs them. */
const CHAINED = /^[`*\s]*\/[`*\s]*$/

/** A negation that governs a citation is ADJACENT to it — "sets no `statusComponentIds` (a, b)". */
const NEGATED_CITATION = /\b(?:no|not|never)\b[\s`*]*$/i

/**
 * The claim shape this checks: an id RUN — two or more service ids joined only by `/` or `,` — which is
 * how every wrong membership #1434 found was written (`elevenlabs/replicate/cursor`,
 * `cerebras/runway/langsmith/copilot/windsurf`, `cohere/groq`). A run is a list literal, found
 * lexically; a SINGLE id in a sentence is prose, is not an enumeration, and is deliberately out of
 * scope — reading one requires parsing the sentence around it, and every attempt to do that produced a
 * false positive on a true sentence.
 *
 * A run is governed by the last field citation BEFORE it. Binding to the NEAREST citation instead
 * charges `statusComponentIds` (#604: cerebras/…) to the `displayComponentIds` that follows it. A list
 * written BEFORE the name it enumerates is therefore not read at all.
 *
 * `allow` keys are `file:field:id`. A list can sit beside a field name without enumerating it, so when
 * one lands inside the reach the remedy has to be something other than rewriting a true sentence —
 * the outcome this design exists to avoid. Scoped to the FILE because #1444's own evidence is the same
 * wrong pair repeated across files in different wording: a pair-wide entry written for one true
 * sentence would silence all of them.
 */
export function membershipBindings({ docs, services, declared = [] }) {
  const members = fieldMembership(services, declared)
  const ids = new Set(services.map((s) => s.id))
  // `` `a`/`b`/`c` `` and `**a**, **b**` are how these lists are usually written, so the separator
  // tolerates the decoration around it; the ids themselves are recovered by stripping it below.
  const anyId = [...ids].join('|')
  const runRe = new RegExp(`\\b(?:${anyId})\\b(?:[\`*]{0,2}\\s*[/,]\\s*[\`*]{0,2}(?:${anyId})\\b)+`, 'gi')
  const fieldRe = new RegExp(`\\b(${[...members.keys()].join('|')})\\b`, 'g')
  const bound = []
  for (const { file, content } of docs) {
    for (const line of content.split('\n')) {
      const fields = [...line.matchAll(fieldRe)].map((m) => ({ name: m[1], start: m.index, end: m.index + m[1].length }))
      if (!fields.length) continue
      for (const run of line.matchAll(runRe)) {
        const before = fields.filter((f) => f.end <= run.index)
        let h = before.length - 1
        const gov = before[h]
        if (!gov) continue
        while (h > 0 && CHAINED.test(line.slice(before[h - 1].end, before[h].start))) h--
        const introducer = line.slice(gov.end, run.index)
        if (!introduces(introducer) || isAbsenceContext(introducer)) continue
        if (NEGATED_CITATION.test(line.slice(0, before[h].start))) continue
        bound.push({
          file,
          field: gov.name,
          run: run[0].replace(/\s+/g, ' '),
          listed: run[0].split(/[/,]/).map((t) => t.replace(/[`*\s]/g, '').toLowerCase()),
          members: members.get(gov.name),
        })
      }
    }
  }
  return bound
}

export function auditMembership({ docs, services, declared = [], allow = new Map() }) {
  const findings = []
  for (const b of membershipBindings({ docs, services, declared })) {
    for (const id of b.listed) {
      if (b.members.has(id) || allow.has(`${b.file}:${b.field}:${id}`)) continue
      findings.push({ file: b.file, field: b.field, id, run: b.run })
    }
  }
  return findings
}

/** The prose this lint reads: the docs, plus the comments of the membership-bearing source files.
 *
 *  Fenced blocks are NOT stripped here, unlike the symbol lint above. In these docs a fence is as often
 *  annotation as example — directory-map.md's entire body is one, and CLAUDE.md's Directory Layout
 *  another — and that is where the module-by-module claims live. */
export function membershipDocs(root = ROOT) {
  const docs = docFiles(root).map((f) => ({ file: f, content: readFileSync(join(root, f), 'utf8') }))
  for (const f of MEMBERSHIP_COMMENT_FILES) {
    docs.push({ file: f, content: tsCommentText(readFileSync(join(root, f), 'utf8')) })
  }
  return docs
}

export function readServiceConfigs(root = ROOT) {
  return parseServiceConfigs(splitTsSource(readFileSync(join(root, 'worker/src/services.ts'), 'utf8')).code)
}

export function readDeclaredFields(root = ROOT) {
  return declaredConfigFields(readFileSync(join(root, 'worker/src/types.ts'), 'utf8'))
}

export const MEMBERSHIP_ALLOW_FILE = 'docs/reference/doc-membership-allow.txt'

/**
 * Everything the CLI decides, against one tree. Separate from `main` so a test can drive it at a
 * temp root: the CLI assembles four inputs, and two of them (`declared`, `allow`) do not move the
 * counts it prints, so cutting either wiring left the whole suite green — the escape hatch stopped
 * working, and a zero-setter field went unchecked, in silence.
 */
export function auditTree(root = ROOT) {
  const readAllow = (rel) => {
    const p = join(root, rel)
    return parseAllowlist(existsSync(p) ? readFileSync(p, 'utf8') : '')
  }
  const symbols = readAllow('docs/reference/doc-symbols-allow.txt')
  const member = readAllow(MEMBERSHIP_ALLOW_FILE)
  const docs = docFiles(root).map((f) => ({ file: f, content: readFileSync(join(root, f), 'utf8') }))
  const corpus = { docs: membershipDocs(root), services: readServiceConfigs(root), declared: readDeclaredFields(root) }
  return {
    noReason: [...symbols.noReason, ...member.noReason],
    docs,
    symbolAllowed: symbols.allow.size,
    memberAllowed: member.allow.size,
    findings: auditDocSymbols({ docs, sourceBlob: collectSourceBlob(root), allow: symbols.allow }),
    membership: auditMembership({ ...corpus, allow: member.allow }),
    bound: membershipBindings(corpus).length,
  }
}

// ── CLI ──
export function main(root) {
  const { noReason, docs, symbolAllowed, memberAllowed, findings, membership, bound } = auditTree(root)
  if (noReason.length) {
    console.error(`❌ allowlist entries without a reason (add \`# why\`): ${noReason.join(', ')}`)
    process.exit(1)
  }

  if (findings.length) {
    console.error(`❌ doc-symbol lint: ${findings.length} cited symbol(s) not found in source and not allowlisted:`)
    for (const f of findings) console.error(`   ${f.file}: \`${f.token}\``)
    console.error(`\nFix the name, or if it is a deliberate mention of an absent/external symbol, add it to`)
    console.error(`docs/reference/doc-symbols-allow.txt with a one-line reason.`)
  }
  if (membership.length) {
    console.error(`\n❌ doc-membership lint: ${membership.length} claim(s) name a service on a config path it is not on:`)
    for (const f of membership) console.error(`   ${f.file}: \`${f.field}\` ← ${f.id}   in the list «${f.run}»`)
    console.error(`\nFix the membership, or delete the enumeration — a list that mirrors a config set is`)
    console.error(`unbounded verification debt (#1110). If the sentence is TRUE and its list is not that`)
    console.error(`field's enumeration, add \`file:field:id  # why\` to ${MEMBERSHIP_ALLOW_FILE}.`)
  }
  if (findings.length || membership.length) process.exit(1)
  console.log(`✅ doc-symbol lint: ${docs.length} docs clean (${symbolAllowed} allowlisted)`)
  console.log(`✅ doc-membership lint: ${bound} enumeration(s) checked (${memberAllowed} allowlisted)`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()

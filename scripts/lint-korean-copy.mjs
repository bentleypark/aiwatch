#!/usr/bin/env node
// Korean user-facing copy lint (#1094). Two deterministic rules over the RENDERED copy strings only
// (never raw source lines — that mixed keys/styles/comments into the scan and produced ~90% false
// positives; see the #1094 scoping). Extract the copy VALUE from each surface, then rule-check it.
//
//   R2 leak  — HARD FAIL: a developer-only token (issue ref, code identifier, field literal, source
//              filename) in reader-facing copy.
//   R1 drift — WARN: a concept's non-canonical variant outside its legitimate register.
//
// Usage:  node scripts/lint-korean-copy.mjs             # exit 1 on a leak, or on an instrument failure
//         node scripts/lint-korean-copy.mjs --warn-only # leaks become warnings; an INSTRUMENT failure
//                                                       # (unreadable surface, extractor yielding 0)
//                                                       # still exits 1 — that is not a lint opinion.
// Pure functions (extractors + rule checks) are unit-tested in lint-korean-copy.test.mjs.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LEAK_PATTERNS, LEAK_ALLOW, TERM_RULES } from './korean-copy-glossary.mjs'

const HANGUL = /[가-힣]/

/** `'dotted.key': '값'` — one shared pattern for both single-quoted i18n maps (ko.js and the Edge
 *  templates), because two copies of it drift and only one gets fixed.
 *
 *  The `\\\\'` alternative comes FIRST and is load-bearing. The Edge templates are TS template
 *  literals, so a quote inside a value is written `\\'` in the file; without this alternative the
 *  `\\.` branch consumes the backslash pair and the very next `'` ends the match, truncating the value
 *  at that point. Measured on `api/_methodology/html-template.ts` `s2.partial`: 167 of 261 characters
 *  were extracted, so the tail — including anything leaked into it — was never rule-checked.
 *
 *  Residual ambiguity, accepted: a value legitimately ENDING in an escaped backslash reads identically
 *  to an escaped quote, so the match would run past the real closing quote into the next entry. Absent
 *  from all five surfaces today (match counts are identical old-vs-new on every file), and
 *  distinguishing the two needs a real tokenizer, not a regex. */
const KEYED_STRING = /'([\w.]+)'\s*:\s*'((?:\\\\'|[^'\\]|\\.)*)'/g

// ── Extractors: source text → [{ text, ctx }] copy strings (ctx = origin tag for R1 context) ──

/** ko.js flat i18n map: `'dotted.key': '값'`. ctx = the key (so R1 can see `incidents.*` etc). */
export function extractKoJs(src) {
  const out = []
  for (const m of src.matchAll(KEYED_STRING)) {
    if (HANGUL.test(m[2])) out.push({ text: unescape(m[2]), ctx: `ko.${m[1]}` })
  }
  return out
}

/** _methodology / _intro Edge templates, part 1 of 2: the `i18n = { ko: { … } }` map. ctx is prefixed
 *  so R1 can tell methodology/intro apart.
 *
 *  This is NOT the whole reader-facing surface. The templates ALSO carry inline Korean defaults in the
 *  HTML (`<a data-i18n="nav.cta">대시보드 열기 →</a>`), and they are not duplicates of the map: on
 *  `_intro`, 7 keys diverge (`nav.cta` inline `대시보드 열기 →` vs map `장애 확인하기 →`, plus
 *  `how.4.desc`, `compare.title`/`.sub`/`.r6b`, `cta.sub`/`.btn1`). The inline text is the SSR default
 *  paint — what a crawler and a no-JS reader see — so it must be scanned too; `extractEdgeInlineKo`
 *  below does that and SURFACES unions the two. (An earlier draft asserted the two were exact
 *  duplicates and scanned only the map; that left the more externally-visible half unguarded.) */
export function extractI18nKo(src, ctxPrefix) {
  const koBlock = sliceKoBlock(src)
  if (!koBlock) return []
  const out = []
  for (const m of koBlock.matchAll(KEYED_STRING)) {
    if (HANGUL.test(m[2])) out.push({ text: unescape(m[2]), ctx: `${ctxPrefix}.${m[1]}` })
  }
  return out
}

/** Isolate the `ko: { … }` object literal inside `const i18n = { ko: {…}, en: {…} }` by brace-matching
 *  from `ko:` so the `en:` block (which may hold English words that look like leaks) is never scanned. */
export function sliceKoBlock(src) {
  const start = src.search(/\bko\s*:\s*\{/)
  if (start === -1) return null
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1) }
  }
  return null
}

/** _methodology / _intro Edge templates, part 2 of 2: the INLINE HTML defaults, anchored on
 *  `data-i18n="key"` so only translated copy elements are read — never the `<script>` blocks, whose JS
 *  would otherwise contribute identifiers that read as leaks. The element's full inner HTML is taken
 *  (depth-matched, so `<div data-i18n><strong>…</strong>…</div>` is captured whole, not truncated at
 *  the first nested tag), then `unescape` strips the markup.
 *
 *  KNOWN LIMIT: a Korean HTML node with NO `data-i18n` is not scanned (e.g. the methodology
 *  `<div class="formula">` card). Those are untranslated-copy bugs in their own right, and anchoring on
 *  `data-i18n` is what keeps the script blocks out; widening to every `>…<` run pulls JS in. Recorded
 *  on #1094 rather than papered over. */
export function extractEdgeInlineKo(src, ctxPrefix) {
  const out = []
  for (const m of src.matchAll(/<(\w+)\b[^>]*\bdata-i18n="([\w.]+)"[^>]*>/g)) {
    const inner = sliceElementInner(src, m[1], m.index + m[0].length)
    if (inner === null) continue
    const text = unescape(inner)
    if (HANGUL.test(text)) out.push({ text, ctx: `${ctxPrefix}.inline.${m[2]}` })
  }
  return out
}

/** Inner HTML of the element whose open tag ends at `from`, by depth-matching `<tag`/`</tag`.
 *  Returns null if the element is never closed (a malformed template — the surface then contributes
 *  nothing for that key rather than swallowing the rest of the file). */
export function sliceElementInner(src, tag, from) {
  const re = new RegExp(`<(/?)${tag}\\b`, 'g')
  re.lastIndex = from
  let depth = 1
  let m
  while ((m = re.exec(src)) !== null) {
    depth += m[1] ? -1 : 1
    if (depth === 0) return src.slice(from, m.index)
  }
  return null
}

/** JSX copy comes in two shapes here, both extracted:
 *   1. TEXT NODES — the run between `>` and the next `<` (LegalContent's `<p>…</p>` prose). Attributes
 *      sit before the `>`, so `style={paraStyle}` is never scanned.
 *   2. `lang === 'ko' ? '…'` TERNARY strings — AnalysisModal holds ALL its Korean copy this way (inline
 *      ternaries, not `t()` keys), so a text-node-only extractor saw 0 strings there and the surface was
 *      scanned vacuously (#1094 review R1). The true branch of a `'ko' ?` ternary IS the Korean copy.
 *  `${…}`/`{…}` interpolation is dropped from both so a `${mins}분 전` template doesn't drag code in.
 *  ctx is the filename stem; JSX copy carries no i18n key. */
export function extractJsxText(src, ctxTag) {
  const out = []
  const clean = (raw) => unescape(raw.replace(/\$\{[^}]*\}/g, '').replace(/\{[^}]*\}/g, '').trim())
  // 1. text nodes
  for (const m of src.matchAll(/>([^<>]*[가-힣][^<>]*)</g)) {
    const t = clean(m[1])
    if (t && HANGUL.test(t)) out.push({ text: t, ctx: ctxTag })
  }
  // 2. `lang === 'ko' ? <str>` — the true branch (quote or backtick), interpolation-tolerant.
  for (const m of src.matchAll(/lang\s*===\s*'ko'\s*\?\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const t = clean(m[2])
    if (t && HANGUL.test(t)) out.push({ text: t, ctx: ctxTag })
  }
  return out
}

// A copy value carries JS escapes (\'), HTML tags (<strong>), and HTML entities (&#39;, &amp;). All
// three are markup, not reader text — strip them so a rule scans what a reader actually sees. Critical
// for R2: an un-decoded `&#39;` matches the issue-ref pattern as `#39` (a false leak); a `<strong>`
// tag's letters could match a code-identifier. Decode entities to their character so legitimate
// punctuation survives (`&#39;` → `'`), and drop tags entirely.
const ENTITIES = { '&#39;': "'", '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' }
function unescape(s) {
  return s
    .replace(/\\(['"\\])/g, '$1')          // JS string escapes
    .replace(/<[^>]+>/g, '')               // HTML tags
    .replace(/&#\d+;|&\w+;/g, (e) => ENTITIES[e] ?? ' ') // HTML entities → char (unknown → space)
}

// ── Rule checks (pure): a copy string → findings ──

/** R2 — leaked developer tokens. Returns [{ id, label, token }]. */
export function findLeaks(text) {
  const found = []
  for (const p of LEAK_PATTERNS) {
    p.re.lastIndex = 0
    for (const m of text.matchAll(p.re)) {
      if (LEAK_ALLOW.has(m[0])) continue
      found.push({ id: p.id, label: p.label, token: m[0] })
    }
  }
  return found
}

/** R1 — term drift. Flags a non-canonical variant ONLY when `ctx` starts with one of the rule's
 *  `warnOnlyContexts` prefixes (a REQUIRE-list; `''` matches every context). Returns
 *  [{ concept, variant, canonical, note }]. `rules` is injectable so the prefix branch can be tested —
 *  every shipped rule uses `''`, which would leave that branch permanently unexercised. */
export function findTermDrift(text, ctx, rules = TERM_RULES) {
  const found = []
  for (const rule of rules) {
    const inStrictContext = rule.warnOnlyContexts.some((c) => ctx.startsWith(c))
    if (!inStrictContext) continue
    for (const variant of rule.variants) {
      if (text.includes(variant)) {
        found.push({ concept: rule.concept, variant, canonical: rule.canonical, note: rule.note })
      }
    }
  }
  return found
}

// ── The surfaces to scan ──
// Exported so the tests can PIN the literal membership: every coverage/wiring assertion loops over
// this list, so a surface deleted from it shrinks the loop and every test stays green (verified by
// mutation). A literal pin is what makes adding/removing a surface a deliberate two-file edit.
// The hook `.claude/hooks/korean-copy-trigger.sh` mirrors these paths; that sync is pinned by a test.
// Each surface lists its extractors SEPARATELY rather than pre-unioning them. An Edge template is read
// by two independent extractors (the i18n map and the inline HTML), and a single per-surface count
// hides the death of either half: converting the map to double quotes zeroes `extractI18nKo` while the
// 118 inline strings keep the surface's total comfortably non-zero, so a leak planted in the map goes
// unreported with CI green. Coverage is therefore per (file, extractor).
export const SURFACES = [
  { file: 'src/locales/ko.js', extractors: [['ko.js map', (s) => extractKoJs(s)]] },
  { file: 'api/_methodology/html-template.ts', extractors: [
    ['i18n map', (s) => extractI18nKo(s, 'methodology')],
    ['inline html', (s) => extractEdgeInlineKo(s, 'methodology')],
  ] },
  { file: 'api/_intro/html-template.ts', extractors: [
    ['i18n map', (s) => extractI18nKo(s, 'intro')],
    ['inline html', (s) => extractEdgeInlineKo(s, 'intro')],
  ] },
  { file: 'src/components/LegalContent.jsx', extractors: [['jsx', (s) => extractJsxText(s, 'legal')]] },
  { file: 'src/components/AnalysisModal.jsx', extractors: [['jsx', (s) => extractJsxText(s, 'analysis')]] },
]

export function scanAll(readFile = (f) => readFileSync(f, 'utf8')) {
  const leaks = []
  const drifts = []
  const coverage = []
  for (const { file, extractors } of SURFACES) {
    let src = null
    try { src = readFile(file) } catch (e) { leaks.push({ file, fatal: String(e) }) }
    for (const [extractor, extract] of extractors) {
      let strings = []
      if (src !== null) {
        try { strings = extract(src) } catch (e) { leaks.push({ file, extractor, fatal: String(e) }) }
      }
      // An extractor that silently yields 0 strings scanned VACUOUSLY — a leak in its half would pass
      // the gate unseen. A format drift (quote-style refactor, a renamed `ko:` block, a JSX→`t()`
      // migration) is exactly that: it throws nothing, it just stops matching. Recording the count per
      // extractor is what lets both the CI test AND the CLI treat "scanned nothing" as a failure
      // rather than as a clean run.
      coverage.push({ file, extractor, count: strings.length })
      for (const { text, ctx } of strings) {
        for (const lk of findLeaks(text)) leaks.push({ file, ctx, ...lk, text })
        for (const dr of findTermDrift(text, ctx)) drifts.push({ file, ctx, ...dr, text })
      }
    }
  }
  return { leaks, drifts, coverage }
}

// ── CLI ──
function main() {
  const warnOnly = process.argv.includes('--warn-only')
  const { leaks, drifts, coverage } = scanAll()
  const realLeaks = leaks.filter((l) => !l.fatal)
  // The vacuity check has to live HERE, not only in the CI test: the hook and CLAUDE.md both tell the
  // developer to run this before committing, so the CLI is the pre-CI path — and a CLI that prints ✅
  // after every extractor returned nothing is the guard failing in its own characteristic direction.
  const vacuous = coverage.filter((c) => c.count === 0)
  const scanned = coverage.reduce((n, c) => n + c.count, 0)

  if (drifts.length) {
    console.log(`\n⚠️  용어 드리프트 ${drifts.length}건 (경고 — 레지스터 예외 확인):`)
    for (const d of drifts) {
      console.log(`  [${d.file}] ${d.ctx}: 「${d.variant}」 → 「${d.canonical}」  · ${d.note}`)
      console.log(`     … ${d.text.slice(0, 70)}`)
    }
  }
  if (realLeaks.length) {
    console.log(`\n❌ 내부 어휘 유출 ${realLeaks.length}건 (사용자 노출 카피에 개발 토큰):`)
    for (const l of realLeaks) {
      console.log(`  [${l.file}] ${l.ctx} [${l.label}] «${l.token}»`)
      console.log(`     … ${l.text.slice(0, 70)}`)
    }
  }
  const fatals = leaks.filter((l) => l.fatal)
  for (const f of fatals) console.error(`\n💥 ${f.file}${f.extractor ? ` (${f.extractor})` : ''}: 추출 실패 — ${f.fatal}`)
  // A file that failed to READ also yields a zero count for each of its extractors. Reporting those as
  // "suspect a format change" would misdiagnose a missing file, so the fatal line is the only one.
  const fatalFiles = new Set(fatals.map((f) => f.file))
  for (const c of vacuous.filter((c) => !fatalFiles.has(c.file))) {
    console.error(`\n💥 ${c.file} (${c.extractor}): 추출 0건 — 이 절반은 검사되지 않았습니다 (형식 변경 의심).`)
  }
  if (!coverage.length) console.error('\n💥 검사 대상 surface가 하나도 없습니다 — SURFACES가 비었습니다.')

  if (!drifts.length && !realLeaks.length && !fatals.length && !vacuous.length && coverage.length) {
    // Print the count: "0 leaks" is only meaningful next to how much was actually read.
    console.log(`✅ Korean copy lint — ${scanned}개 문자열 검사, 0 leaks, 0 drift.`)
  }
  // A fatal or a vacuous extractor is an INSTRUMENT failure, not a lint warning, so `--warn-only`
  // (which exists to see drift without blocking) must not silence it.
  if (fatals.length || vacuous.length || !coverage.length) process.exitCode = 1
  else if (!warnOnly && realLeaks.length) process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()

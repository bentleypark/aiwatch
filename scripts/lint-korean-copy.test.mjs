import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractKoJs, extractI18nKo, sliceKoBlock, extractJsxText, extractEdgeInlineKo, sliceElementInner,
  findLeaks, findTermDrift, scanAll, SURFACES,
} from './lint-korean-copy.mjs'
import { LEAK_ALLOW, LEAK_PATTERNS } from './korean-copy-glossary.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

// ── Extractors ──

test('extractKoJs pulls the Korean VALUE, not the key or a comment', () => {
  const src = [
    "// #663 — 이 주석의 이슈번호는 카피가 아니다",       // a comment: NOT a value → must be skipped
    "  'nav.requestService': '서비스 추가 요청',",         // key has camelCase; value is clean copy
    "  'x.y': 'English only',",                             // no Hangul → skipped
  ].join('\n')
  const got = extractKoJs(src)
  assert.deepEqual(got.map((s) => s.text), ['서비스 추가 요청'])
  assert.equal(got[0].ctx, 'ko.nav.requestService')
  // The crux: the comment's #663 and the key's `requestService` never enter the scan.
  assert.ok(!got.some((s) => /#663|requestService/.test(s.text)))
})

test('sliceKoBlock returns the ko object only, excluding the en block', () => {
  const src = `const i18n = { ko: { 'a': '가', 'b': '나' }, en: { 'a': 'leakyIdentifier' } }`
  const ko = sliceKoBlock(src)
  assert.ok(ko.includes("'가'") && ko.includes("'나'"))
  assert.ok(!ko.includes('leakyIdentifier'), 'en block must not be in the ko slice')
})

test('extractI18nKo scans ko values only — an en-side identifier is never seen', () => {
  const src = `x = { ko: { 's.t': '상태 결정' }, en: { 's.t': 'statusResolver' } }`
  const got = extractI18nKo(src, 'methodology')
  assert.deepEqual(got.map((s) => s.text), ['상태 결정'])
  assert.equal(got[0].ctx, 'methodology.s.t')
})

test('extractJsxText takes text nodes, not attribute expressions', () => {
  const src = `<p style={paraStyle}>사용자는 열람을 요청할 수 있습니다.</p>`
  const got = extractJsxText(src, 'legal')
  assert.deepEqual(got.map((s) => s.text), ['사용자는 열람을 요청할 수 있습니다.'])
  // paraStyle sits in the attribute (before `>`) so it is never scanned:
  assert.ok(!got.some((s) => /paraStyle/.test(s.text)))
})

test('extractJsxText also pulls the true branch of a `lang === \'ko\' ? …` ternary', () => {
  // AnalysisModal holds ALL its Korean copy this way, not as text nodes — the text-node-only version
  // scanned it vacuously (#1094 review). Both quote and backtick, and `${…}` interpolation dropped.
  const src = `<span>{lang === 'ko' ? '대안 서비스' : 'Alternatives'}</span>` +
              "\nconst t = lang === 'ko' ? `${mins}분 전` : `${mins}m ago`"
  const got = extractJsxText(src, 'analysis').map((s) => s.text)
  assert.ok(got.includes('대안 서비스'))
  assert.ok(got.includes('분 전'), 'template ternary, interpolation stripped')
  assert.ok(!got.includes('Alternatives'), 'the en (false) branch is not copy')
})

test('unescape strips tags + decodes entities so markup never reaches a rule', () => {
  // A methodology value: HTML entity for a quote + a <strong> tag. The entity `&#39;` must NOT survive
  // as `#39` (that was a false issue-ref leak), and the tag letters must not survive either.
  const src = `x = { ko: { 's': '제공사가 <strong>&#39;없음&#39;</strong>으로 표시' } }`
  const [v] = extractI18nKo(src, 'methodology')
  assert.equal(v.text, "제공사가 '없음'으로 표시")
  assert.ok(!/#39|strong/.test(v.text))
})

// ── R2 leak rule ──

test('findLeaks catches an internal symbol, an issue ref, a field literal, a filename', () => {
  assert.equal(findLeaks('incidentExclude 컴포넌트 우회')[0].id, 'code-identifier')
  assert.equal(findLeaks('이 동작은 #1090 에서 고침')[0].id, 'issue-ref')
  assert.equal(findLeaks('impact:none 이면 유지')[0].id, 'field-literal')
  assert.equal(findLeaks('services.ts 에서 결정')[0].id, 'source-filename')
  // PascalCase basenames are the likeliest leak of all — 28 tracked source files are PascalCase,
  // including two of the five surfaces this lint scans. A narrowing that spares `Next.js` by requiring
  // a lowercase initial would let these through, so the exemption lives in LEAK_ALLOW and this asserts
  // the pattern itself still covers them.
  assert.equal(findLeaks('AnalysisModal.jsx 에서 렌더링')[0].id, 'source-filename')
  assert.equal(findLeaks('LegalContent.jsx 참고')[0].id, 'source-filename')
})

test('findLeaks does NOT fire on legitimate copy — product names, versions, plain words', () => {
  for (const clean of [
    'Claude Code가 느려졌습니다',        // product name (space-separated, no hump)
    'Opus 4.8 응답 지연',                // version number
    'API 상태를 확인합니다',             // an all-caps word, not camelCase
    'claude.ai 접속 오류',               // `.ai` is not a code extension — no pattern matches it
    '브라우저의 localStorage에 저장',    // allowlisted web-standard term
    '/badge/:serviceId 로 배지 제공',    // allowlisted public API param
    // Each of the next eight is spared by a DELIBERATE narrowing, not by luck — loosening the matching
    // pattern must turn this test red, because R2 is a HARD FAIL and these are ordinary copy:
    'Next.js 기반 대시보드',             // source-filename: capitalised basename
    'Node.js 런타임 오류',               // source-filename: capitalised basename
    'Chart.js 로 렌더링합니다',          // source-filename: capitalised basename
    '문의는 mailto:hello 로 주세요',     // field-literal: URI scheme
    'https://ai-watch.dev 를 참고하세요', // field-literal: URI scheme
    'iPhone 에서도 동작합니다',          // code-identifier: allowlisted product name
    '응답 비율: 40% 수준',               // field-literal: a space after the colon
    '점검 시간: 09:00 부터',             // field-literal: digits, not a lowercase value
  ]) {
    assert.deepEqual(findLeaks(clean), [], `false positive on: ${clean}`)
  }
})

test('findLeaks issue-ref needs 2+ digits so "#1 순위" prose does not fire', () => {
  assert.deepEqual(findLeaks('#1 순위 서비스'), [])
  assert.equal(findLeaks('#12 순위').length, 1)
})

// ── R1 term-drift rule ──

test('findTermDrift flags 이용자 in every context (user has no register split)', () => {
  const got = findTermDrift('이용자의 권리', 'legal')
  assert.equal(got.length, 1)
  assert.equal(got[0].canonical, '사용자')
})

test('findTermDrift flags 유저 too — both variants of the rule, not just the one in the copy', () => {
  // 유저 is absent from today's copy, so the real-copy scan can never exercise it; without this the
  // variant could be dropped from TERM_RULES with every test still green.
  assert.equal(findTermDrift('유저 설정을 저장합니다', 'legal')[0].canonical, '사용자')
})

test('warnOnlyContexts is a REQUIRE-list: a prefix that does not match the ctx does not fire', () => {
  // The shipped rule uses '' (matches everything), so this branch is otherwise never exercised —
  // deleting the `continue` in findTermDrift changed nothing. Pin the semantics with a local rule so
  // the next rule added with a real prefix behaves the way the glossary docstring says.
  const scoped = [{ concept: 'user', canonical: '사용자', variants: ['이용자'], warnOnlyContexts: ['ko.incidents'], note: 'x' }]
  assert.equal(findTermDrift('이용자의 권리', 'legal', scoped).length, 0, 'must NOT fire outside the prefix')
  assert.equal(findTermDrift('이용자의 권리', 'ko.incidents.title', scoped).length, 1, 'must fire inside it')
})

test('findTermDrift does NOT flag 사용자 (the canonical) or 장애 (removed, 1-to-2 word)', () => {
  assert.deepEqual(findTermDrift('사용자의 권리', 'legal'), [])
  // 장애 was deliberately removed from TERM_RULES (spans incident AND outage) — must not fire anywhere.
  assert.deepEqual(findTermDrift('장애 기록을 30일치로 계산', 'methodology.s3.weighted'), [])
})

// ── Real-surface integration: the shipped copy must be clean, both directions ──

test('the real copy surface scans clean (0 leaks, 0 drift) — pins the shipped fixes', () => {
  const { leaks, drifts } = scanAll()
  const realLeaks = leaks.filter((l) => !l.fatal)
  assert.deepEqual(realLeaks, [], `unexpected leak: ${JSON.stringify(realLeaks[0])}`)
  assert.deepEqual(drifts, [], `unexpected drift: ${JSON.stringify(drifts[0])}`)
  // ...and no extractor threw (a fatal would mean a surface silently stopped being scanned):
  assert.deepEqual(leaks.filter((l) => l.fatal), [])
})

test('every EXTRACTOR yields >0 strings — no half of a surface is scanned vacuously', () => {
  // The #1094 review's core finding: AnalysisModal was listed as covered but its extractor returned
  // [], so a leak there passed the gate silently. Coverage is per (file, extractor) precisely because
  // a per-SURFACE count hides half a surface dying: zeroing the methodology i18n map still leaves 118
  // inline strings, a comfortably non-zero total, while a leak planted in the map goes unreported.
  const { coverage } = scanAll()
  assert.ok(coverage.length > SURFACES.length, 'the Edge templates must report their two extractors separately')
  for (const { file, extractor, count } of coverage) {
    assert.ok(count > 0, `${file} (${extractor}) extracted 0 strings — scanned vacuously (a leak here would pass)`)
  }
})

// ── Edge-template inline HTML (the SSR default paint) ──

test('extractEdgeInlineKo reads the inline default, not just the i18n map', () => {
  const src = `<a class="nav-cta" data-i18n="nav.cta" data-ga="x">대시보드 열기 →</a>`
  const got = extractEdgeInlineKo(src, 'intro')
  assert.deepEqual(got.map((s) => s.text), ['대시보드 열기 →'])
  assert.equal(got[0].ctx, 'intro.inline.nav.cta')
})

test('extractEdgeInlineKo captures a nested element WHOLE, not truncated at the first inner tag', () => {
  // The naive `>([^<]*)<` form stops at `<strong>`, so a leak in the tail would never be scanned.
  const src = `<div data-i18n="s.b">앞부분 <strong>강조</strong> #4242 뒷부분</div>`
  const [v] = extractEdgeInlineKo(src, 'methodology')
  assert.ok(v.text.includes('뒷부분'), 'tail after the nested tag must survive')
  assert.equal(findLeaks(v.text)[0]?.token, '#4242')
})

test('extractEdgeInlineKo ignores script blocks — only data-i18n elements are read', () => {
  // Anchoring on data-i18n is what keeps the template's client-side JS (identifiers that read as
  // leaks) out of the scan. Widening to every `>…<` run would pull it in.
  const src = `<script>const svcStatus = { koLabel: '상태 값' }</script><p data-i18n="a">진짜 카피</p>`
  assert.deepEqual(extractEdgeInlineKo(src, 'intro').map((s) => s.text), ['진짜 카피'])
})

test('sliceElementInner returns null on an unclosed element instead of swallowing the file', () => {
  assert.equal(sliceElementInner('<div data-i18n="a">열린 채로 끝', 'div', 19), null)
})

test('the real Edge templates contribute inline strings, not only map strings', () => {
  // The concrete reason this extractor exists: on _intro the inline defaults DIVERGE from the map
  // (nav.cta inline `대시보드 열기 →` vs map `장애 확인하기 →`), so scanning the map alone left the
  // SSR default paint — what a crawler and a no-JS reader see — unguarded.
  const intro = readFileSync(join(REPO, 'api/_intro/html-template.ts'), 'utf8')
  const inline = extractEdgeInlineKo(intro, 'intro')
  const map = extractI18nKo(intro, 'intro')
  assert.ok(inline.length > 0, 'no inline copy extracted from _intro')
  const mapTexts = new Set(map.map((s) => s.text))
  assert.ok(
    inline.some((s) => !mapTexts.has(s.text)),
    'every inline string equalled a map string — if that is now true, the union is redundant and this test should be re-derived, not deleted',
  )
})

// ── Wiring: scanAll must actually route each surface's copy THROUGH the rules ──
// The two tests above are both GREEN-state assertions (real copy is clean; every extractor returns
// >0), and the rule tests only exercise the pure fns. All of them stay green if scanAll never calls a
// rule at all — mutation-checked: before these two tests existed, deleting the `findLeaks` call from
// scanAll left the whole suite passing; with them it goes red.
// So the extractor→rule wiring needs a RED-state assertion: plant poisoned copy, demand a finding.
//
// One blob satisfies every extractor shape at once — a ko.js `'key': '값'` pair, an
// `i18n = { ko: {…} }` block, and a JSX text node — so the fake reader poisons all SURFACES without
// restating their filenames here (a list that would silently drift out of sync with the module).
// Every extractor must find something in it, including the Edge templates' SECOND extractor (the
// inline `data-i18n` HTML) — an extractor yielding 0 is now an instrument failure, so a fixture that
// only fed three of the four shapes would trip the vacuity guard instead of testing the rules.
const poison = (copy) => `
  'nav.poison': '${copy}',
  const i18n = { ko: { 'p.a': '${copy}' }, en: { 'p.a': 'clean' } }
  <p data-i18n="p.b">${copy}</p>
`

test('scanAll routes every surface through the LEAK rule (wiring, not just the pure fn)', () => {
  const { leaks, coverage } = scanAll(() => poison('내부 토큰 #4242 유출'))
  assert.ok(coverage.length > 0, 'no surfaces declared')
  for (const { file } of coverage) {
    const hit = leaks.find((l) => l.file === file && l.token === '#4242')
    assert.ok(hit, `${file}: planted leak was not reported — extractor→findLeaks wiring is dead`)
    assert.equal(hit.id, 'issue-ref')
  }
})

test('scanAll routes every surface through the DRIFT rule (wiring, not just the pure fn)', () => {
  const { drifts, coverage } = scanAll(() => poison('이용자의 권리'))
  for (const { file } of coverage) {
    const hit = drifts.find((d) => d.file === file && d.variant === '이용자')
    assert.ok(hit, `${file}: planted drift was not reported — extractor→findTermDrift wiring is dead`)
    assert.equal(hit.canonical, '사용자')
  }
})

test('scanAll wires the INLINE extractor into the Edge surfaces, not just the i18n map', () => {
  // Mutation-checked: dropping `extractEdgeInlineKo` from the SURFACES entry left every other test
  // green, because the inline tests above call the extractor directly. Poison ONLY the inline HTML —
  // the map stays clean — so the finding can only come from the inline path being wired in.
  const inlineOnlyPoison = `
    <p data-i18n="s.a">인라인 기본값 #4242</p>
    const i18n = { ko: { 's.a': '깨끗한 맵 값' }, en: { 's.a': 'clean' } }
  `
  const { leaks } = scanAll(() => inlineOnlyPoison)
  for (const file of ['api/_methodology/html-template.ts', 'api/_intro/html-template.ts']) {
    assert.ok(
      leaks.some((l) => l.file === file && l.token === '#4242' && l.ctx.includes('.inline.')),
      `${file}: inline-only leak not reported — extractEdgeInlineKo is not wired into SURFACES`,
    )
  }
})

test('scanAll reports an unreadable surface as fatal instead of scanning it silently', () => {
  // A surface that throws must not look like "clean" — the CLI exits 1 on a fatal for this reason.
  const { leaks, coverage } = scanAll((f) => { throw new Error(`ENOENT ${f}`) })
  assert.equal(leaks.filter((l) => l.fatal).length, SURFACES.length, 'one fatal per unreadable file')
  assert.ok(coverage.every((c) => c.count === 0))
})

// ── The surface LIST itself ──

test('SURFACES membership is pinned literally — deleting a surface must fail, not shrink a loop', () => {
  // Every coverage/wiring assertion above iterates `coverage`, which is DERIVED from SURFACES: drop a
  // surface and the loops simply run over fewer items, all green (mutation-verified — removing
  // AnalysisModal.jsx left the suite passing). Only a literal pin makes that a deliberate edit.
  assert.deepEqual(SURFACES.map((s) => s.file).sort(), [
    'api/_intro/html-template.ts',
    'api/_methodology/html-template.ts',
    'src/components/AnalysisModal.jsx',
    'src/components/LegalContent.jsx',
    'src/locales/ko.js',
  ])
})

test('the hook targets exactly the SURFACES files — the "kept in sync" comment is enforced', () => {
  // .claude/hooks/korean-copy-trigger.sh mirrors the surface list in a bash `case`. Both files say
  // they are kept in sync; without this, adding a 6th surface leaves the hook silent on it forever,
  // and a hook that stops firing is invisible by construction.
  const hook = readFileSync(join(REPO, '.claude/hooks/korean-copy-trigger.sh'), 'utf8')
  const m = hook.match(/case "\$FP" in\n\s*([^\n]+)\)\s*;;/)
  assert.ok(m, 'could not parse the case list out of the hook — parser drifted, fix the parser')
  const hooked = m[1].split('|').map((p) => p.replace(/^\*\//, '')).sort()
  assert.deepEqual(hooked, SURFACES.map((s) => s.file).sort())
})

// ── The CLI: the "HARD FAIL" claim needs a mechanism ──

/** A temp repo holding all SURFACES files, each filled with `content`. */
function tmpRepoWith(content) {
  const dir = mkdtempSync(join(tmpdir(), 'kolint-'))
  for (const { file } of SURFACES) {
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  return dir
}
const runCli = (cwd, ...args) =>
  spawnSync(process.execPath, [join(REPO, 'scripts/lint-korean-copy.mjs'), ...args], { cwd, encoding: 'utf8' })

test('CLI exits 1 on a leak and names it — this is the whole "hard fail" claim', () => {
  // Deleting the process.exit(1) left every other test green; the hook message and CLAUDE.md both
  // promise a hard fail, so the exit code needs its own assertion.
  const r = runCli(tmpRepoWith(poison('내부 토큰 #4242 유출')))
  assert.equal(r.status, 1)
  assert.match(r.stdout, /#4242/)
})

test('CLI exits 0 on --warn-only but still reports the leak', () => {
  const r = runCli(tmpRepoWith(poison('내부 토큰 #4242 유출')), '--warn-only')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /#4242/)
})

test('CLI exits 0 on drift alone — drift is a WARN, per the documented warn/fail split', () => {
  const r = runCli(tmpRepoWith(poison('이용자의 권리')))
  assert.equal(r.status, 0)
  assert.match(r.stdout, /이용자/)
})

test('CLI exits 1 when a surface cannot be read — an unreadable surface is not "clean"', () => {
  const r = runCli(mkdtempSync(join(tmpdir(), 'kolint-empty-')))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /추출 실패/)
  // …and does NOT also blame a format change: a missing file yields a zero count for each of its
  // extractors, and reporting those as "형식 변경 의심" would misdiagnose a file that simply isn't there.
  assert.doesNotMatch(r.stderr, /추출 0건/)
})

test('CLI exits 0 on the real repo copy', () => {
  const r = runCli(REPO)
  assert.equal(r.status, 0, r.stdout)
})

test('CLI refuses to print ✅ when an extractor scanned NOTHING', () => {
  // The guard's own characteristic failure: all five files present and readable, nothing throws, every
  // extractor returns [] — and the tool affirmatively reports the copy is clean. The CLI is the
  // pre-commit path the hook points at, so the vacuity check has to be here, not only in CI.
  const r = runCli(tmpRepoWith('한국어가 있지만 어떤 추출기 형식에도 맞지 않는 평문'))
  assert.equal(r.status, 1)
  assert.doesNotMatch(r.stdout, /✅/)
  assert.match(r.stderr, /추출 0건/)
})

test('CLI --warn-only still fails on an instrument failure, unlike on a leak', () => {
  // --warn-only exists to see drift/leaks without blocking; an unreadable or vacuous surface is not an
  // opinion about copy, it is the instrument being broken, so the flag must not silence it.
  const r = runCli(tmpRepoWith('추출기 어느 형식에도 맞지 않는 평문'), '--warn-only')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /추출 0건/, 'must fail for the vacuity reason, not incidentally')
})

test('LEAK_ALLOW holds no phantom entry — every entry is really matched by a pattern', () => {
  // The glossary states this as an invariant ("Every entry must be MATCHED BY A PATTERN"), because an
  // entry no pattern can produce reads as a guard that is not there — round 1 found three such. Pin it
  // so the next phantom fails instead of being re-discovered by review.
  for (const entry of LEAK_ALLOW) {
    const matched = LEAK_PATTERNS.some((p) => {
      p.re.lastIndex = 0
      return [...entry.matchAll(p.re)].some((m) => m[0] === entry)
    })
    assert.ok(matched, `LEAK_ALLOW entry «${entry}» is matched by no LEAK_PATTERN — it exempts nothing`)
  }
})

test('the CLI reports HOW MUCH it scanned, so "0 leaks" is readable', () => {
  const r = runCli(REPO)
  assert.match(r.stdout, /\d+개 문자열 검사/)
})

test('the shared KEYED_STRING pattern survives a template-literal-escaped quote', () => {
  // The Edge templates are TS template literals, so a quote inside a value is written `\\'`. The
  // earlier pattern let `\\.` eat the backslash pair and ended the match at the next quote, silently
  // truncating the value — measured at 167 of 261 chars on methodology `s2.partial`, so the tail was
  // never rule-checked. A leak planted in that tail is the failure this pins.
  const src = String.raw`x = { ko: { 's': '앞부분 \\'인용\\' 뒤에 services.ts 가 온다' } }`
  const [v] = extractI18nKo(src, 'methodology')
  assert.match(v.text, /뒤에/, 'value truncated at the escaped quote')
  assert.equal(findLeaks(v.text)[0]?.id, 'source-filename', 'a leak in the tail must still be seen')
})

test('the hook actually EMITS a reminder — not just logs that it fired', () => {
  // korean-copy-trigger.sh writes its audit line BEFORE printing, so a broken message leaves an audit
  // trail of a reminder the model never saw. The case-list sync test above would stay green through
  // that. Spawn it the way the harness does and assert a non-empty PreToolUse additionalContext comes back.
  // Run a COPY of the hook from a temp dir. `_audit.sh` resolves its log as `$HOOK_DIR/../
  // hook-audit.jsonl` and honors no env override, so spawning the real file would append a `warn` line
  // to the real `.claude/hook-audit.jsonl` on every test run — and CLAUDE.md makes that log the
  // channel the gate system's effectiveness is measured on. A test must not seed its own instrument.
  const sandbox = mkdtempSync(join(tmpdir(), 'kohook-'))
  const hooksDir = join(sandbox, 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  for (const f of ['korean-copy-trigger.sh', '_audit.sh']) {
    writeFileSync(join(hooksDir, f), readFileSync(join(REPO, '.claude/hooks', f)))
  }
  const hook = join(hooksDir, 'korean-copy-trigger.sh')
  const fire = (file, env) => spawnSync('bash', [hook], {
    input: JSON.stringify({ tool_input: { file_path: file } }),
    encoding: 'utf8',
    ...(env ? { env } : {}),
  })
  // The hook must still emit when the JSON escaper fails. A stub `jq` passes the hook's `-r` read to
  // the real binary but fails the `-Rs` escape, forcing the fallback branch. Without the fallback the
  // hook prints a blank line and EXITS 0 (an empty command substitution makes printf succeed, so
  // `|| true` never fires), leaving an audit `warn` for a reminder that was never delivered.
  const binDir = join(sandbox, 'bin')
  mkdirSync(binDir, { recursive: true })
  // Resolve the real jq instead of guessing directories — it is /usr/bin/jq on CI and macOS 15 but
  // /opt/homebrew/bin/jq on an Apple Silicon box without the system copy, where a hardcoded list makes
  // the passthrough exit 127 and this test fail for an unrelated reason. `env -i` keeps the stub from
  // finding itself again on PATH.
  const realJq = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim()
  assert.ok(realJq, 'jq not installed — the hook needs it and so does this test')
  // The stub records that it actually intercepted. Asserting only on the emitted message cannot tell
  // the two branches apart (both say "lint:korean"), so a hook refactor spelling the flags `-R -s`
  // would leave the stub inert, the primary branch running, and this test green while guarding
  // nothing — the guard-whose-default-is-pass trap. The marker makes the interception observable.
  const marker = join(sandbox, 'intercepted')
  writeFileSync(join(binDir, 'jq'),
    `#!/bin/sh\ncase "$*" in *-Rs*) : > '${marker}'; exit 1 ;; esac\nexec /usr/bin/env -i PATH='${dirname(realJq)}' jq "$@"\n`)
  chmodSync(join(binDir, 'jq'), 0o755)
  const degraded = fire(join(REPO, 'src/locales/ko.js'), { ...process.env, PATH: `${binDir}:${process.env.PATH}` })
  // The stub couples to the literal `-Rs` spelling, so this also fires when the escape is renamed or
  // removed entirely — say the whole emitter reverts to the old silent form. Name that, not just the
  // fallback, or the next reader hunts a branch that is no longer there.
  assert.ok(existsSync(marker), "stub jq never intercepted — the escape is no longer spelled 'jq -Rs'")
  assert.equal(degraded.status, 0)
  const degradedMsg = JSON.parse(degraded.stdout).hookSpecificOutput?.additionalContext
  assert.ok(degradedMsg && degradedMsg.includes('lint:korean'), 'jq escape failed → hook went silent')

  const onTarget = fire(join(REPO, 'src/locales/ko.js'))
  assert.equal(onTarget.status, 0)
  const msg = JSON.parse(onTarget.stdout).hookSpecificOutput?.additionalContext
  assert.ok(msg && msg.length > 0, 'hook fired but emitted no message')
  assert.match(msg, /lint:korean/, 'the reminder must name the command it is reminding about')
  // …and stays silent off-target (en.js is not a Korean copy surface):
  const offTarget = fire(join(REPO, 'src/locales/en.js'))
  assert.equal(offTarget.status, 0)
  assert.equal(offTarget.stdout.trim(), '')
})

test('the lint would CATCH a regression: re-introducing incidentExclude fails the scan', () => {
  // Mutation both directions: feed the pre-fix copy through the rule and confirm it fires. This is the
  // guard against the fix silently reverting — the exact #1094 leak that shipped before this lint.
  assert.equal(findLeaks('incidentExclude 컴포넌트 우회').length, 1)
  assert.equal(findLeaks('제목 기반 제외 패턴 우회').length, 0) // the shipped replacement is clean
})

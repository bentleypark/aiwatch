// Glossary + rules for the Korean user-facing copy lint (#1094).
//
// Scope this session: the two DETERMINISTIC rules the #1094 scoping settled on —
//   R2 (dev-token leak)  — HARD FAIL. A developer-only token in reader-facing copy is always wrong.
//   R1 (term drift)      — WARN. A concept's non-canonical variant, EXCEPT where a different register
//                          is legitimate (marketing vs data), so it is a warn, not a failure.
// The warn/fail split is deliberate: term choice has legitimate register exceptions (Atlassian itself
// separates `incident` the event from `outage` the component-severity), so drift is surfaced, not
// blocked; a leaked `#1090` or `componentNames` has no legitimate reader-facing use, so it fails.
//
// "WARN" is precise about the CLI only. `npm run lint:korean` exits 0 on drift — but the CI gate is
// the real-copy test, which asserts BOTH lists are empty, so drift on a scanned surface does fail CI.
// That is intended (the shipped copy is pinned clean; a new drift is a deliberate decision, and the
// escape hatch is to add the variant's register to `warnOnlyContexts` rather than to ignore a warning
// nobody sees). Stated here because "warn, never blocked" alone would promise a dev a green CI on a
// commit that goes red.
//
// Canonical terms are grounded in the upstream source vocabulary (Atlassian Statuspage), NOT invented:
//   incident (event, lifecycle investigating→…→resolved)  → 인시던트
//   major/partial outage (a COMPONENT STATUS severity)    → 중단 / 서비스 중단
//   degraded performance (a COMPONENT STATUS)             → 성능 저하
// so `인시던트` (the event) and `중단` (the down state) are different layers, exactly as upstream.

/**
 * R1 — term drift. Each entry: a concept, its canonical Korean term, and the non-canonical variants
 * to flag.
 *
 * `warnOnlyContexts` is a REQUIRE-list, not an exemption list: `findTermDrift` flags a variant only
 * when the string's origin tag starts with one of these prefixes, so `['']` (the empty prefix) means
 * "every context". The origin tags the extractors actually produce are `ko.<i18n key>`,
 * `methodology.<key>`, `methodology.inline.<key>`, `intro.<key>`, `intro.inline.<key>`, `legal` and
 * `analysis` — a prefix must match one of those to fire at all.
 */
// NOTE on what is NOT here: incident/장애 was tried and REMOVED. Atlassian separates `incident` (event)
// from `outage` (a component-status severity), but the Korean word 「장애」 covers BOTH — "Claude Code에
// 영향을 준 장애" (event) AND "장애 기록/장애 시간" (outage/downtime). A term rule can't tell which from
// the word alone, so flagging 장애 in data contexts mis-fired on ~all of the real occurrences (they were
// the outage sense, legitimately 장애). Word-vs-concept must be 1:1 for a mechanical term rule; 장애 is
// 1-to-2, so it is left to human/LLM review (the #1094 checklist half). Only genuinely 1:1 pairs below.
export const TERM_RULES = [
  {
    concept: 'user',
    canonical: '사용자',
    // 이용자/유저 are the same referent as 사용자 — 1:1 (all three mean "user"), so a mechanical flag is
    // safe. Both are absent from the copy as of this branch (this PR fixed LegalContent's 이용자); the
    // rule exists to keep them out. WARN, not fail — a legal doc may have a house style.
    variants: ['이용자', '유저'],
    warnOnlyContexts: [''], // every context (empty prefix matches all) — user has no legitimate register split
    note: '사용자/이용자/유저는 같은 대상 — 「사용자」로 통일 (法문서 하우스스타일이면 예외).',
  },
]

/**
 * R2 — developer-token leak. A reader-facing Korean string must contain none of these. Each is a
 * pattern with a human label; a match is a HARD FAIL. Patterns are intentionally narrow to avoid
 * flagging legitimate copy (product names like "Claude Code", "claude.ai", version "4.8" are NOT
 * dev tokens). The real-copy scan asserts 0 false positives on TODAY's copy (lint-korean-copy.test.mjs)
 * — that is a measurement of the current surface, not a property of the patterns, so each narrowing
 * below names the legitimate copy it exists to spare.
 *
 * DELIBERATE BLIND SPOTS (a hard gate that over-fires gets loosened under pressure, so these stay out
 * rather than being caught imprecisely): SCREAMING_SNAKE constants (`STATUS_CACHE`), PascalCase types
 * (`ServiceStatus`), non-code extensions (`wrangler.toml`, `kv-schema.md`), short keys before a colon
 * (`ai:analysis`), and single-digit issue refs (`#7`).
 *
 * Two more blind spots come from the EXTRACTORS, not the patterns, and are just as real: a token
 * composed at runtime is stripped before any rule sees it (`` `이슈 #${n} 참고` `` extracts as
 * `이슈 # 참고`, and a bare `#` fails the 2-digit rule), and a value with no Hangul is skipped entirely
 * — so an English-only string on a Korean surface (20 of the methodology template's inline nodes) is
 * never rule-checked.
 *
 * R2 is a floor, not a complete filter; the whole-document re-read (the #1094 checklist half) covers
 * the rest.
 */
export const LEAK_PATTERNS = [
  {
    id: 'issue-ref',
    // #1090, #882 — an issue/PR number. Two+ digits, which is the whole rule: it spares "#1 순위"
    // prose and a 3-char hex "#fff", and nothing about what precedes the # is examined.
    re: /#\d{2,}/g,
    label: '이슈/PR 번호',
  },
  {
    id: 'code-identifier',
    // camelCase or snake_case identifiers with an internal boundary: componentNames, svc_status,
    // filterByComponentStatus. Requires a lowercase→Uppercase hump OR an underscore between word chars,
    // so single words ("API", "status") and product names ("Claude") don't match.
    re: /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z0-9]+_[a-z0-9_]+\b/g,
    label: '코드 식별자',
  },
  {
    id: 'field-literal',
    // A field:value literal used in code discussion: impact:none, status:degraded. A lowercase key,
    // a colon (no space), a lowercase value — prose "비율: 40" (space, or Korean) never matches.
    // URI schemes are excluded: `mailto:hello`, `https://…` are reader-facing copy, and a contact line
    // on the privacy page would otherwise HARD-FAIL the commit.
    re: /\b(?!(?:mailto|https?|tel|data|ftp|file|wss?):)[a-z]{3,}:[a-z]{2,}\b/g,
    label: '필드 리터럴',
  },
  {
    id: 'source-filename',
    // A source file reference: services.ts, lint-korean-copy.mjs, AnalysisModal.jsx. Any basename + a
    // code extension. The capitalised tech names that are ordinary reader copy ("Next.js", "Node.js",
    // "Chart.js") are spared by LEAK_ALLOW, NOT by narrowing this pattern: 28 tracked source files are
    // PascalCase — including two of the five scanned surfaces (`LegalContent.jsx`, `AnalysisModal.jsx`)
    // and all of `src/components/` + `src/pages/` — so a lowercase-initial requirement would let the
    // most likely leak of all through. An allowlist entry is auditable; a narrowed pattern is not.
    re: /\b[\w-]+\.(?:ts|tsx|mjs|cjs|jsx|js)\b/g,
    label: '소스 파일명',
  },
]

/** Terms that look like a code-identifier / field-literal but ARE legitimate reader-facing copy — an
 *  allowlist so the narrow R2 patterns don't need to be loosened. Product/brand names + known copy. */
// Every entry must be MATCHED BY A PATTERN — an entry no pattern can ever produce (e.g. `claude.ai`:
// `.ai` is not a code extension) reads as a guard that isn't there, and is what later gets copied into
// a genuine exemption. Beyond that the entries split in two, and each is labelled, because "is this
// exemption still needed?" is answerable only for the first group:
//
//   IN USE      — present in the copy today; removing the entry turns the real-copy scan red.
//   PRE-EMPTIVE — matched by a pattern but absent from the copy; kept so ordinary reader copy does not
//                 HARD-FAIL a commit the first time someone writes it. Unverifiable by the scan, so
//                 each one states the copy it anticipates rather than a location.
export const LEAK_ALLOW = new Set([
  // IN USE — web-standard / public-API terms the `code-identifier` pattern can't tell from an INTERNAL
  // symbol (all camelCase). Reader-legitimate in a privacy policy; `incidentExclude` is not.
  'localStorage',   // LegalContent.jsx privacy section — the consent-key reset instructions
  'serviceId',      // LegalContent.jsx — the public badge route param (/badge/:serviceId)

  // PRE-EMPTIVE — capitalised tech/product names that fit `source-filename` or `code-identifier`.
  'Next.js', 'Node.js', 'Chart.js',  // e.g. "Chart.js 로 렌더링합니다" in a methodology card
  'iPhone', 'iPad',                  // e.g. "iPhone 에서도 동작합니다" in the landing copy
])

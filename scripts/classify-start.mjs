#!/usr/bin/env node
// #1974 — the mechanical half of ship-issue step 0.5: reads an issue's title and body and prints the
// `정의 변경: 예|아니오|애매` line for the clear cases. A signal is a word cue, not a verdict. An unclear
// case is left to a judgement, and an `아니오` is confirmed by a person. A new service or card is flagged too.
// Usage: node scripts/classify-start.mjs <issue-number>
//        node scripts/classify-start.mjs --title "<title>" --body-file <path>

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// [kind, strength, where, pattern, needsVerb, dropWithoutVerb]. `title` matches the title only, `any` the title
// and the body. service-add reads the title only. A config field or status-rule word is strong only when its
// sentence also has a changing verb (CHANGE_VERB), weak otherwise; a taxonomy word with no changing verb gives
// no signal. The tests pin these with the shapes of #1248, #1723, #1966, #1970 and #1974.
export const SIGNALS = [
  ['service-add', 'strong', 'title', /^(?:feat|feature)(?:\([^)]*\))?:\s*add\s+[A-Z]/],
  ['service-add', 'strong', 'title', /\badd(?:s|ing)?\b[^.\n]{0,80}(?<![-\w])(?:service|card)(?![-\w])/i],
  ['component-rule', 'strong', 'any', /\b(?:referenceComponentIds|componentDenylist|incidentExclude|rosterAuditExclude|statusComponentIds|displayComponentIds|incidentKeywords|incidentComponents|EXCLUDE_FALLBACK)\b/, true],
  ['component-rule', 'strong', 'any', /\b(?:Counted|Excluded|Reference)\b[^.\n]{0,60}\b(?:components?|incidents?|rule|criterion|ids?)\b/],
  ['status-rule', 'strong', 'any', /\b(?:status determination|worst-of|how a status is decided|Score (?:weights?|components?))\b/i, true],
  ['taxonomy', 'weak', 'any', /\b(?:category|bucket|tier)\b/i, true, true],
]

const CHANGE_VERB = /\b(?:move[sd]?|add(?:s|ed|ing)?|remov(?:e|es|ed|ing)|set(?:s|ting)?|chang(?:e|es|ed|ing)|includ(?:e|es|ed|ing)|exclud(?:e|es|ed|ing)|reclassif\w*|renam\w*|put|drop(?:s|ped)?|narrow\w*|widen\w*|stops? counting|counts? as)\b/i

const QUOTE_MAX = 140

/** The sentence around a match, trimmed to QUOTE_MAX. */
function quoteAround(text, index, length) {
  const last = (needle) => (index > 0 ? text.lastIndexOf(needle, index - 1) : -1)
  const dot = last('. ')
  const start = Math.max(last('\n') + 1, dot >= 0 ? dot + 2 : 0)
  const after = [text.indexOf('\n', index + length), text.indexOf('. ', index + length)].filter((i) => i >= 0)
  const end = after.length ? Math.min(...after) + 1 : text.length
  const sentence = text.slice(start, end).trim()
  return sentence.length > QUOTE_MAX ? `${sentence.slice(0, QUOTE_MAX - 1)}…` : sentence
}

const firstSentence = (body) => {
  const line = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? ''
  const end = line.indexOf('. ')
  const sentence = end >= 0 ? line.slice(0, end + 1) : line
  return sentence.length > 120 ? `${sentence.slice(0, 119)}…` : sentence
}

export function classifyStart({ title = '', body = '' }) {
  const signals = []
  const seen = new Set()
  for (const [kind, baseStrength, where, re, needsVerb, dropWithoutVerb] of SIGNALS) {
    const haystacks = where === 'title' ? [title] : [title, body]
    for (const text of haystacks) {
      const m = re.exec(text)
      if (!m) continue
      const quote = quoteAround(text, m.index, m[0].length)
      const changes = CHANGE_VERB.test(quote)
      if (dropWithoutVerb && !changes) continue
      const strength = needsVerb && !changes ? 'weak' : baseStrength
      const key = `${kind}|${quote}`
      if (seen.has(key)) continue
      seen.add(key)
      signals.push({ kind, strength, quote })
      break
    }
  }
  const strong = signals.some((s) => s.strength === 'strong')
  const weak = signals.some((s) => s.strength === 'weak')
  return {
    definitionChange: strong ? 'yes' : weak ? 'unclear' : 'no',
    serviceAdd: signals.some((s) => s.kind === 'service-add'),
    signals,
    firstSentence: firstSentence(body),
  }
}

export function renderLine(result, { number } = {}) {
  const ref = number ? ` (#${number})` : ''
  if (result.definitionChange === 'yes') {
    const quote = result.signals.find((s) => s.strength === 'strong').quote
    const lines = [
      `정의 변경: 예 — "${quote}"`,
      'EGM 설계 리뷰(약 10분, 사용량 소모)를 하려면 "설계 리뷰"라고 답해 주세요.',
    ]
    if (result.serviceAdd) {
      lines.push(`새 서비스${ref}: 코드 전에 Step-0 블록이 필요합니다 — node scripts/service-step0.mjs measure … 후 check (#1974).`)
    }
    return lines.join('\n')
  }
  if (result.definitionChange === 'unclear') {
    const quote = result.signals[0].quote
    return `정의 변경: 애매 — "${quote}" (판단 필요: 예 또는 아니오를 이유와 함께 적는다)`
  }
  return `정의 변경: 아니오 — "${result.firstSentence}" (자동 판정 — 사람이 확인)`
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  let issue
  let number
  if (arg('--title') !== undefined) {
    issue = { title: arg('--title'), body: arg('--body-file') ? readFileSync(arg('--body-file'), 'utf8') : '' }
  } else if (/^\d+$/.test(argv[0] ?? '')) {
    number = argv[0]
    issue = JSON.parse(execFileSync('gh', ['issue', 'view', number, '--json', 'title,body'], { encoding: 'utf8' }))
  } else {
    process.stderr.write('usage: classify-start.mjs <issue-number> | --title <t> --body-file <path>\n')
    return 2
  }
  process.stdout.write(`${renderLine(classifyStart(issue), { number })}\n`)
  return 0
}

const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === realpathSync(process.argv[1] ?? '') } catch { return false }
})()
if (isMain) process.exit(main(process.argv.slice(2)))

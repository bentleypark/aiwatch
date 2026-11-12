import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classifyStart, renderLine } from './classify-start.mjs'

// The #1385 body as it stood at work start: a new card, plus a decision about which Cloudflare
// components are counted, which are Reference and which are left out.
const BODY_1385 = `## Summary

Cloudflare Status v3 already has a parser in the repo. This issue adds a second card on the same source.

## Scope (decided 2026-11-12)

**Card:** name "Cloudflare Workers AI", worker category \`api\`, frontend bucket \`inference\`.

**Reference incidents (#1669): no card row, no Score, no alert, no service count.**
`

describe('classifyStart', () => {
  test('#1385 at work start is a yes, and says why (a new card plus a Reference decision)', () => {
    const r = classifyStart({ title: 'feat(worker): add Cloudflare Workers AI as a monitored service', body: BODY_1385 })
    assert.equal(r.definitionChange, 'yes')
    assert.equal(r.serviceAdd, true)
    assert.ok(r.signals.some((s) => s.kind === 'service-add'))
    assert.ok(r.signals.some((s) => s.kind === 'component-rule'))
  })

  test('#1973, whose title names a provider without the word "service" or "card", is still a service addition', () => {
    const r = classifyStart({ title: 'feat: add Speechmatics — a second dedicated speech-to-text fallback candidate', body: 'Speechmatics ships a status page.' })
    assert.equal(r.serviceAdd, true)
    assert.equal(r.definitionChange, 'yes')
  })

  test('a config field that decides what a card counts is a yes even in a fix', () => {
    const r = classifyStart({ title: 'fix(services): Windsurf scope', body: 'Move Devin Cloud into `incidentExclude` so the card stops counting it.' })
    assert.equal(r.definitionChange, 'yes')
    assert.equal(r.serviceAdd, false)
    assert.ok(r.signals.some((s) => s.kind === 'component-rule'))
  })

  test('a Counted / Excluded / Reference verdict on a component is a yes', () => {
    const r = classifyStart({ title: 'fix(status): component verdict', body: 'The Console component is Reference, not Counted, by the #1821 criterion.' })
    assert.equal(r.definitionChange, 'yes')
  })

  test('a notation-only docs issue is a no, with nothing to quote but its first sentence', () => {
    const r = classifyStart({
      title: 'docs(skill): fix one notation form per quantity in the monthly report skill',
      body: 'The October 2026 report draft mixes notation in its hand-written sections.\n\nLatency: `251 ms p50` next to `the lowest p50 (193 ms)`.',
    })
    assert.equal(r.definitionChange, 'no')
    assert.equal(r.serviceAdd, false)
    assert.deepEqual(r.signals, [])
  })

  test('a bucket or category mention alone is unclear, not a yes', () => {
    const r = classifyStart({ title: 'chore: reorder the sidebar', body: 'Move the Inference & Infra category above Voice in the sidebar.' })
    assert.equal(r.definitionChange, 'unclear')
    assert.ok(r.signals.every((s) => s.strength === 'weak'))
  })

  test('a refactor that only names a service is not a service addition', () => {
    const r = classifyStart({ title: 'refactor: extract the service-groups module', body: 'Pure move; no behaviour change.' })
    assert.equal(r.serviceAdd, false)
    assert.equal(r.definitionChange, 'no')
  })
})

describe('classifyStart on the shapes of real issues (a word cue is not a change)', () => {
  test('#1970-shaped: a bug body that only mentions a config field and the worst-of badge is unclear, not a yes', () => {
    const r = classifyStart({
      title: 'ChatGPT badge reads operational while a tracked component is full_outage on components.json',
      body: "The Agent id is in chatgpt's `statusComponentIds`, so the worst-of badge read it as operational.\n\n- [ ] `normalizeStatus` maps `full_outage` to `down`",
    })
    assert.equal(r.definitionChange, 'unclear')
    assert.ok(r.signals.length > 0 && r.signals.every((s) => s.strength === 'weak'))
  })

  test('#1966-shaped: "Add one form each … service names …" in a docs checklist is not a service addition', () => {
    const r = classifyStart({
      title: 'docs(skill): fix one notation form per quantity in the monthly report skill',
      body: '- [x] Add one form each for latency, nonzero counts + thousands comma, service names, uptime-source labels and cross-references to the Notation conventions bullet.',
    })
    assert.equal(r.serviceAdd, false)
    assert.equal(r.definitionChange, 'no')
  })

  test('#1974-shaped: a body that talks about the add-a-service Step-0 audit is not a service addition', () => {
    const r = classifyStart({
      title: 'chore(workflow): gate a new service on a measured Step-0 audit',
      body: '#1385 went to six review rounds because the add-a-service Step-0 audit was never completed before the design.',
    })
    assert.equal(r.serviceAdd, false)
  })

  test('a quote taken from the title keeps its first character', () => {
    const r = classifyStart({ title: 'feat: add Speechmatics — a second dedicated speech-to-text fallback candidate', body: '' })
    assert.match(r.signals.find((s) => s.kind === 'service-add').quote, /^feat: add Speechmatics/)
  })

  test('a quote taken from a body sentence starts at that sentence, not mid-word', () => {
    const r = classifyStart({ title: 'fix: windsurf', body: 'Context first. Move Devin Cloud into `incidentExclude` so the card stops counting it. Done.' })
    assert.equal(r.signals.find((s) => s.kind === 'component-rule').quote, 'Move Devin Cloud into `incidentExclude` so the card stops counting it.')
  })

  test('a config field named with a verb that changes it is still a yes', () => {
    for (const body of ['Add the Console component to `referenceComponentIds`.', 'Remove `Website` from `componentDenylist`.', 'Set `statusComponentIds` to the two API groups.', 'Move Devin Cloud into `incidentExclude`.']) {
      assert.equal(classifyStart({ title: 'fix: scope', body }).definitionChange, 'yes', body)
    }
  })
})

describe('classifyStart on titles and bodies that only look like additions or taxonomy', () => {
  test('a feature that adds something other than a service is not a service addition (#1248, #1723)', () => {
    assert.equal(classifyStart({ title: 'feat(is-down-group): add the crowd Report-an-issue affordance to the family page', body: '' }).serviceAdd, false)
    assert.equal(classifyStart({ title: 'chore(is-down): keep seo-content.ts current — add-a-service copy step', body: '' }).serviceAdd, false)
  })

  test('titles that add a named provider are service additions (#901, #392)', () => {
    assert.equal(classifyStart({ title: 'feat: add Baseten (AI model inference platform) — breadth candidate, data-rich Atlassian source', body: '' }).serviceAdd, true)
    assert.equal(classifyStart({ title: 'feat: add Tavily (AI search API) to monitored services', body: '' }).serviceAdd, true)
  })

  test('an incidental "tier", "bucket" or "category" with nothing being changed gives no signal at all', () => {
    for (const body of ['Make the Tier-A assert machine-checkable.', 'Count the hits in the 5-minute bucket.', 'The lint output is grouped by category.']) {
      const r = classifyStart({ title: 'chore: tooling', body })
      assert.deepEqual(r.signals, [], body)
      assert.equal(r.definitionChange, 'no')
    }
  })
})

describe('renderLine', () => {
  test('a yes carries the matched quote and the EGM offer; a service addition also names the Step-0 script', () => {
    const r = classifyStart({ title: 'feat: add Speechmatics — a second dedicated speech-to-text fallback candidate', body: '' })
    const out = renderLine(r, { number: 1973 })
    assert.match(out, /^정의 변경: 예 — "/m)
    assert.match(out, /EGM 설계 리뷰/)
    assert.match(out, /scripts\/service-step0\.mjs/)
  })

  test('a no is a line a human still has to confirm', () => {
    const r = classifyStart({ title: 'docs: typo', body: 'Fix a typo in the README.' })
    const out = renderLine(r, { number: 5 })
    assert.match(out, /^정의 변경: 아니오 — "Fix a typo in the README\."/m)
    assert.match(out, /사람이 확인/)
    assert.doesNotMatch(out, /EGM/)
  })

  test('unclear is labelled and left to a judgement that states its reason; it is not an automatic yes', () => {
    const r = classifyStart({ title: 'chore: reorder the sidebar', body: 'Move the Inference & Infra category above Voice.' })
    const out = renderLine(r, { number: 6 })
    assert.match(out, /정의 변경: 애매 — .*판단 필요/s)
    assert.doesNotMatch(out, /EGM/)
    assert.doesNotMatch(out, /애매하면 예/)
  })
})

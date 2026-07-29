// #1182 — pin the WIRING, not just the logic.
//
// `buildRedditEngageTargets` and `appendRedditSection` being green proves nothing about whether
// index.ts ever calls them, and neither does `typecheck:worker`: deleting the
// `operatorDescription = appendRedditSection(...)` assignment leaves `let operatorDescription =
// withSearches` and the `=== withSearches` comparison both well-typed, so the feature can be dead in
// production with the whole suite and tsc green. That is #1032's "pure fn green ≠ wiring green".
//
// What this file holds in place, none of it visible to a unit test: the assignment exists; the
// rendered string reaches sendDiscordAlert; build AND render sit inside ONE try (the render is where
// the string work is, and the dedup keys are already written, so a throw there loses the alert
// permanently); the cap-drop warn exists; and buildFeedEntry takes the CLEAN description BEFORE the
// appends — the #475 boundary, whose failure would relay operator-only content to every subscriber.
//
// index.ts can't be imported here (it pulls the Workers runtime + every binding), so read it via fs —
// the upstream-link-wiring.test.ts (#1053) / api-tier-sync.test.ts (#403) precedent.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INDEX_SRC = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

/** The operator-alert assembly block, from the Reddit append to the send. */
function assemblyBlock(): string {
  const start = INDEX_SRC.indexOf('let operatorDescription = withSearches')
  const end = INDEX_SRC.indexOf('const operatorSent = await sendDiscordAlert', start)
  expect(start, 'operator assembly block not found — did the wiring move?').toBeGreaterThan(-1)
  expect(end, 'sendDiscordAlert not found after the assembly block').toBeGreaterThan(start)
  return INDEX_SRC.slice(start, end)
}

describe('reddit engage wiring (#1182)', () => {
  it('imports both builders from ./alerts', () => {
    expect(INDEX_SRC).toMatch(/import\s*\{[^}]*buildRedditEngageTargets[^}]*\}\s*from\s*'\.\/alerts'/s)
    expect(INDEX_SRC).toMatch(/import\s*\{[^}]*appendRedditSection[^}]*\}\s*from\s*'\.\/alerts'/s)
  })

  it('assigns the rendered section to operatorDescription — the feature existing at all', () => {
    expect(assemblyBlock()).toContain('operatorDescription = appendRedditSection(withSearches, redditTargets, DIV)')
  })

  it('sends operatorDescription as the embed description', () => {
    // Without this the block is built, logged about, and thrown away.
    expect(INDEX_SRC).toContain('description: operatorDescription,')
  })

  it('keeps BUILD and RENDER inside one try — the render is where the string work is', () => {
    const block = assemblyBlock()
    const tryIdx = block.indexOf('try {')
    const catchIdx = block.indexOf('} catch')
    const buildIdx = block.indexOf('buildRedditEngageTargets(alert, scored)')
    const renderIdx = block.indexOf('appendRedditSection(withSearches, redditTargets, DIV)')
    expect(tryIdx).toBeGreaterThan(-1)
    expect(buildIdx).toBeGreaterThan(tryIdx)
    expect(renderIdx).toBeGreaterThan(tryIdx)
    expect(catchIdx).toBeGreaterThan(renderIdx) // the render must be BEFORE the catch, i.e. inside
  })

  it('logs when the section is dropped for embed space', () => {
    // Otherwise a cap-drop is byte-identical to "no targets" and unanswerable from the logs.
    const block = assemblyBlock()
    expect(block).toContain('#1182 reddit section dropped (embed cap)')
    expect(block).toContain('redditTargets.length > 0 && operatorDescription === withSearches')
  })

  it('builds the per-user feed entry from the CLEAN description, BEFORE the operator appends', () => {
    // #475 operator-only boundary. This is the seam the unit tests cannot see: buildFeedEntry copies
    // its `description` argument verbatim, so passing `operatorDescription` — or moving this call
    // below the appends — would relay the operator-only Reddit block (and its utm_source=reddit reply
    // links) to every subscribed user's webhook, with every other test still green.
    const feedIdx = INDEX_SRC.indexOf('buildFeedEntry(alert, description, scored)')
    const appendIdx = INDEX_SRC.indexOf('let operatorDescription = withSearches')
    expect(feedIdx, 'buildFeedEntry must take the clean `description`').toBeGreaterThan(-1)
    expect(appendIdx, 'operator assembly block not found — did the wiring move?').toBeGreaterThan(-1)
    expect(feedIdx).toBeLessThan(appendIdx)
    expect(INDEX_SRC).not.toContain('buildFeedEntry(alert, operatorDescription')
  })
})

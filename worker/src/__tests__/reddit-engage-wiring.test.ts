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

describe('#1330 - feedAgeText fails closed on the first-seen TTL, so the two must not drift', () => {
  // `feedAgeText` suppresses the disclosure at or above ALERTED_NEW_TTL_S because that is exactly
  // when `feed:firstseen:{id}` expires and gets re-stamped with `now`. That reasoning is only sound
  // while the KV puts actually use that TTL. Mutating either put to a literal (`expirationTtl: 60`)
  // left the ENTIRE 5122-test suite and `tsc` green - the guard would have gone silently wrong in
  // production with nothing red. So pin the pairing here rather than assert a number twice.
  const putSites = INDEX_SRC.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter((x) => /feed:firstseen|fsKey/.test(x.line) && /expirationTtl/.test(x.line))

  it('both feed:firstseen write surfaces still exist', () => {
    // Two by design: the cron alerted:new path and the #776 /feed feed-visibility path. A third
    // appearing (or one vanishing) changes which incidents carry an anchor at all.
    expect(putSites.length, `expected 2 feed:firstseen puts, found ${putSites.length}`).toBe(2)
  })

  it('neither writes a numeric TTL literal - both read the constant the guard bounds on', () => {
    for (const { line, n } of putSites) {
      expect(line, `index.ts:${n} writes feed:firstseen with a literal TTL; feedAgeText bounds on ALERTED_NEW_TTL_S`)
        .toContain('expirationTtl: ALERTED_NEW_TTL_S')
      expect(line, `index.ts:${n} still carries a numeric TTL literal`).not.toMatch(/expirationTtl:\s*\d/)
    }
  })
})

// #1330 - the age disclosure is computed in `alerts.ts` and RENDERED in index.ts. `buildIncidentAlerts`
// being green proves nothing about whether the embed ever prints the field: deleting the render line
// leaves `ageText` set on the candidate, every alerts.ts test passing, and tsc silent - the feature
// dead in production with CI green. Same shape, same file, same reason as the Reddit wiring above.
//
// LIMIT, stated rather than papered over: this is a SOURCE scan, so it sees the line being deleted or
// the field being renamed, but not a break that preserves the text (a dead `false &&`, or the push
// moved somewhere unreachable). Closing that needs a test that drives the cron's alert assembly,
// which does not exist yet.
describe('#1330 - the age disclosure reaches the embed', () => {
  it('index.ts renders alert.ageText into the description', () => {
    expect(INDEX_SRC).toMatch(/if \(alert\.ageText\) parts\.push\(/)
  })

  it('it is rendered as its own divider-separated section, like every sibling hint', () => {
    // Appended to `parts` with the same `${DIV}\n` prefix the fallback and region hints use, so it
    // reads as a section rather than running into the line above it.
    const line = /if \(alert\.ageText\) parts\.push\(`\$\{DIV\}\\n\$\{alert\.ageText\}`\)/
    expect(INDEX_SRC).toMatch(line)
  })
})

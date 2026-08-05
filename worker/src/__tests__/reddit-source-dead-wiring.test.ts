import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #820 — source-scan wiring guard, in the repo's sync-test idiom (ai-usage-wiring / api-tier-sync).
//
// WHAT THIS IS NOT: proof that a real Reddit block produces a real Discord warning. Nothing in this
// repo invokes the cron `scheduled` handler, so that path has no behavioral harness. The decision
// fold (`decideSourceHealth` / `transientStreakEscalates` / `isDeadStatus`) and the rendered line
// are behaviorally tested in `reddit.test.ts` and `daily-summary.test.ts`.
//
// WHAT THIS IS: a guard on the WIRING between them — the half a pure-function test cannot see
// ("순수fn 초록 ≠ 배선 초록", learned again in PR #1207's review, where every wiring mutation survived a green
// suite). This feature exists ONLY to make a silent failure visible, so if the marker is written but
// never read, or read but never passed to the summary, the code ships looking complete and the
// operator still sees a quiet day. That is the original bug, restored.
//
// Guards default to passing, so each assertion is mutation-verified in both directions (see the PR):
// cut the wiring and the corresponding test must go red.

const SRC = join(__dirname, '..')
const read = (f: string) => readFileSync(join(SRC, f), 'utf8')

describe('#820 — Reddit source-dead marker wiring', () => {
  const index = read('index.ts')
  const reddit = read('reddit.ts')

  it('the daily-summary path READS the marker', () => {
    expect(index).toMatch(/readRedditSourceDead\s*\(\s*env\.STATUS_CACHE\s*\)/)
  })

  it('and PASSES it into buildDailySummary — a read whose value is dropped changes nothing', () => {
    // The failure mode this catches: `readRedditSourceDead` is called (so a grep for it succeeds)
    // but the result never reaches the payload, leaving the summary exactly as blind as before.
    const payload = index.slice(index.indexOf('redditCount,'), index.indexOf('redditCount,') + 200)
    expect(payload).toMatch(/redditSourceDead,/)
  })

  it('detectRedditPosts records health on every branch of the fold', () => {
    // All three arms must reach KV. Dropping the `clear` arm would leave a stale warning forever;
    // dropping `mark` is the whole feature; dropping `bump` re-hides a total network block.
    expect(reddit).toMatch(/case 'clear':[\s\S]{0,200}clearRedditSourceDead/)
    expect(reddit).toMatch(/case 'mark':[\s\S]{0,200}markRedditSourceDead\(kv, 'block'\)/)
    expect(reddit).toMatch(/case 'partial':[\s\S]{0,200}markRedditSourceDead\(kv, 'partial'\)/)
    expect(reddit).toMatch(/case 'bump':[\s\S]{0,260}bumpTransientStreak/)
    expect(reddit).toMatch(/transientStreakEscalates\(streak\)\) await markRedditSourceDead\(kv, 'streak'\)/)
  })

  it('every subreddit outcome is collected — a dropped outcome silently biases the fold', () => {
    // `outcomes.push(outcome)` sits inside the results loop. If it were hoisted out or omitted for
    // one branch, `decideSourceHealth` would judge a partial run: the common case is that a
    // never-pushed `dead` reads as an all-transient run and only warns 3 hours later.
    expect(reddit).toMatch(/const \{ target, posts, mode, outcome \} = result\.value\s*\n\s*outcomes\.push\(outcome\)/)
  })

})

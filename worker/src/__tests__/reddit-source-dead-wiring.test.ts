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
    // All arms must reach KV. Dropping the `clear` arm would leave a stale warning forever;
    // dropping `mark` is the whole feature; dropping `bump` re-hides a total network block;
    // dropping `throttled` (#820 round 1) collapses the 429-vs-block distinction back into one
    // undifferentiated "DOWN" alarm on every run, which is the noisy-summary bug that reason exists
    // to prevent.
    expect(reddit).toMatch(/case 'clear':[\s\S]{0,200}clearRedditSourceDead/)
    expect(reddit).toMatch(/case 'mark':[\s\S]{0,200}markRedditSourceDead\(kv, 'block'\)/)
    expect(reddit).toMatch(/case 'partial':[\s\S]{0,200}markRedditSourceDead\(kv, 'partial'\)/)
    expect(reddit).toMatch(/case 'throttled':[\s\S]{0,200}markRedditSourceDead\(kv, 'throttled'\)/)
    expect(reddit).toMatch(/case 'bump':[\s\S]{0,900}transientStreakEscalates\(streak\)\) await markRedditSourceDead\(kv, 'streak'\)/)
  })

  it('every subreddit outcome is collected — a dropped outcome silently biases the fold', () => {
    // `outcomes.push(outcome)` sits inside the results loop. If it were hoisted out or omitted for
    // one branch, `decideSourceHealth` would judge a partial run: the common case is that a
    // never-pushed `dead` reads as an all-transient run and only warns 3 hours later.
    expect(reddit).toMatch(/const \{ target, posts, mode, outcome \} = result\.value\s*\n\s*outcomes\.push\(outcome\)/)
  })

  it('daily-summary gives `throttled` its own quieter line, not the generic DOWN alarm', () => {
    // A regression here (throttled falling through to the same '⚠️ Reddit source DOWN' branch as a
    // real block) would fire the loud alarm on ~every run given #820's measured ~85% 429 rate on the
    // shared egress IP — training the operator to ignore this line entirely.
    const summary = read('daily-summary.ts')
    expect(summary).toMatch(/health\?\.reason === 'throttled'/)
    expect(summary).toMatch(/🐢 \*\*Reddit rate-limited\*\*/)
  })

  it('a sustained zero-ok run (escalated `streak`) still names throttling as a possible cause', () => {
    // #820 round 2 found the opposite regression: a sustained all-429 outage must still alarm (round
    // 1 let it fall through to `throttled`'s quiet path forever). Round 3 then found that giving the
    // escalated case its OWN reason value (`throttled-streak`) broke `at`-preservation whenever a
    // streak's flavor flipped between runs. The reason stays a single `streak` — this guards that
    // its MESSAGE still tells the operator it might be throttling, not just "check Worker egress".
    const summary = read('daily-summary.ts')
    expect(summary).toMatch(/health\.reason === 'streak'[\s\S]{0,200}rate-limiting/)
  })

})

describe('#1202 — reddit:promote:last marker wiring', () => {
  const index = read('index.ts')

  it('the write sits inside the promotable loop, after the Discord send', () => {
    // The failure mode this catches: the write gets moved/deleted during a future refactor of this
    // loop with no other signal catching it — kv-schema.md calls this "the only durable trace" a
    // PROMOTE alert fired, so a silently-dropped write makes "never fired" and "fired but untracked"
    // indistinguishable again, the same blind spot #820 is about one KV key over.
    const loopStart = index.indexOf('for (const alert of promotable)')
    expect(loopStart).toBeGreaterThan(-1)
    const loopBody = index.slice(loopStart, loopStart + 1800)
    const sendIdx = loopBody.indexOf('sendDiscordAlert')
    const writeIdx = loopBody.indexOf("kvPut(env.STATUS_CACHE, 'reddit:promote:last'")
    expect(sendIdx).toBeGreaterThan(-1)
    expect(writeIdx).toBeGreaterThan(sendIdx)
  })

  it('the payload carries postId, subreddit, and sentAt — a swapped/dropped field defeats the marker silently', () => {
    // round 5 — ordering alone doesn't prove the VALUE written is useful; kv-schema.md documents
    // this exact shape as what an operator reads back via `wrangler kv key get`.
    const loopStart = index.indexOf('for (const alert of promotable)')
    const loopBody = index.slice(loopStart, loopStart + 1800)
    const writeIdx = loopBody.indexOf("kvPut(env.STATUS_CACHE, 'reddit:promote:last'")
    const payload = loopBody.slice(writeIdx, writeIdx + 200)
    expect(payload).toContain('postId: alert.post.id')
    expect(payload).toContain('subreddit: alert.subreddit')
    expect(payload).toContain('sentAt: now.toISOString()')
  })

  it('a write failure is logged under its own label, not silently swallowed', () => {
    // round 5 — the ordering test doesn't prove the failure branch exists at all. `kvPut` returns
    // false (never throws, see utils.ts), so this must be a return-value check, not a .catch().
    const loopStart = index.indexOf('for (const alert of promotable)')
    const loopBody = index.slice(loopStart, loopStart + 1800)
    expect(loopBody).toContain("console.error('[reddit] promote-marker write failed')")
  })

  it('the write is gated on the Discord send actually succeeding, not just being attempted', () => {
    // round 7 — an earlier version discarded sendDiscordAlert's boolean return value and wrote the
    // marker unconditionally, so a failed webhook POST (sendDiscordAlert returns false, it never
    // throws — see index.ts's own definition) still read as "delivered" via this marker. #1202's
    // whole reason this key exists is to let an operator confirm the alert actually reached
    // Discord, so this gate is load-bearing, not defensive-programming filler.
    const loopStart = index.indexOf('for (const alert of promotable)')
    const loopBody = index.slice(loopStart, loopStart + 1800)
    expect(loopBody).toContain('const sent = await sendDiscordAlert(')
    expect(loopBody).toMatch(/if \(sent && !\(await kvPut\(env\.STATUS_CACHE, 'reddit:promote:last'/)
  })
})

describe('#820 round 2 — outageAlerts mark-seen loop is uncapped', () => {
  const index = read('index.ts')

  it('does not cap how many outage alerts get marked seen', () => {
    // The bug this guards: `.slice(0, 5)` here (removed by this PR) let a promotable post beyond
    // index 5 get sent to Discord without ever being marked seen, so it would re-fire on every
    // subsequent run until it aged out 6h later. A regression re-adding any `.slice(0, N)` cap to
    // this specific loop would silently resurrect that duplicate-alert bug with no other test
    // catching it, since `promotable` (the send-gating filter) is computed independently from the
    // FULL `outageAlerts` list, not from whatever subset got marked seen.
    const loopStart = index.indexOf('for (const alert of outageAlerts)')
    expect(loopStart).toBeGreaterThan(-1)
    // Confirm this is really the mark-seen loop (writes alert.key with the 24h dedup TTL), not some
    // other coincidental match.
    const loopBody = index.slice(loopStart, loopStart + 200)
    expect(loopBody).toContain("kvPut(env.STATUS_CACHE, alert.key, '1', { expirationTtl: 86400 })")
    // And that it is NOT the old capped form.
    expect(index).not.toContain('outageAlerts.slice(0, 5)')
  })
})

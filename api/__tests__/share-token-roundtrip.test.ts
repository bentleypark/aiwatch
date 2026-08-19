// #1251 — the `&i=` card token crosses a boundary that nothing tested.
//
// `buildShareUrl` builds the shared URL; the two destination handlers each keep their OWN copy of a
// sanitizer (`[A-Za-z0-9_-]`, capped at 64) and rebuild `og:url` from it. Both sides were verified
// against their own expectation — `share-url.test.ts` asserts the emitted form, the handler tests
// round-trip alphanumeric tokens — and never against each other. Today they agree, so this is a guard,
// not a bug report: it makes a future one-sided change fail in CI instead of as a stale social card.
//
// Measured before writing this, over every incident id in production (n = 1,130) across the 46 card
// namespaces — the 43 individual is-down pages plus the 3 family pages, which merge their members'
// incidents into one namespace, giving 1,328 (page, token) placements once a family member is counted
// on both its own page and its family's: 101 ids are altered by the strip, 0 collide, 0 strip to empty.
// So the property the handler comments claim — deterministic, stable per incident, unique-enough
// across incidents — holds on the real corpus, and the cases below pin it rather than restate it.
//
// What this file does NOT pin, so nobody assumes otherwise:
//   - the emitter's `encodeURIComponent`. It is a no-op for every real id shape (none contain
//     `& # % + =`), so no realistic fixture can catch its removal. `share-url.test.ts` covers that with
//     a synthetic `'a&b=c'` id.
//   - the `|| null` fallback on an empty token. Both consumers are truthiness checks, so `''` and
//     `null` behave identically — an equivalent mutant, deliberately untested.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildShareUrl } from '../_is-down/share-url'
import isDown from '../is-down'
import isDownGroup from '../is-down-group'

/**
 * Raw id → the token the page must pin. Written as LITERALS, not computed with a copy of the
 * sanitizer: a rule duplicated here would be edited in reflex alongside a handler change, re-greening
 * the assertion. A literal makes a wrong expectation visible instead — dropping `_` from the class
 * turns `sn_owe1x_abc-123` into `snowe1xabc-123`, which no one edits past without noticing.
 *
 * The first three shapes are emitter-reachable: `vertex:`/`aistudio:` are gemini's (gcloud + aistudio
 * parsers), `flashduty:<digits>` is deepseek/deepseekapp's — all three have is-down pages. The fourth
 * is the AWS Health parser's real shape (`aws:<service>:<region>:<epoch-ms>`, and `bedrock` is its only
 * configured consumer); bedrock has NO is-down page, so it is reachable only as a crafted inbound
 * `&i=`, which is exactly what the sanitizer exists to absorb.
 */
const TOKENS: Array<[raw: string, pinned: string]> = [
  ['vertex:41E5S3mkTGDfkZuJZH5k', 'vertex41E5S3mkTGDfkZuJZH5k'],
  ['aistudio:GeminiAPI-batch-outage-20260603', 'aistudioGeminiAPI-batch-outage-20260603'],
  ['flashduty:8891', 'flashduty8891'],
  ['aws:bedrock:us-east-1:1755600000000', 'awsbedrockus-east-11755600000000'],
  // `_` is in the allowed class but appears in no production id, so without this case dropping it from
  // the class is invisible.
  ['sn_owe1x_abc-123', 'sn_owe1x_abc-123'],
]

function statusResponse(services: unknown[]): Response {
  return new Response(JSON.stringify({ services }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}

const incident = (id: string) => ({
  id, title: 'Elevated errors', status: 'investigating',
  startedAt: new Date(Date.now() - 3_600_000).toISOString(), resolvedAt: null, duration: null,
})

/**
 * Drive a handler with the emitter's query string where one exists (the cap case below deliberately
 * hand-builds its URL, since no emitter produces an over-long id).
 *
 * The catch-all after the `Once` is load-bearing: `api/is-down.ts` fetches a SECOND time for the
 * crowd-report feed on a `down` page, and a once-mock lets that one reach the real network — the suite
 * then depends on an external host being up. It is an implementation, not a value, because one
 * `Response` cannot serve two calls: its body is single-use.
 */
async function ogUrlFor(handler: typeof isDown, path: string, shared: string, services: unknown[]) {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(statusResponse(services))
    .mockImplementation(() => Promise.resolve(statusResponse([])))
  const html = await (await handler(new Request(`https://ai-watch.dev${path}&${new URL(shared).search.slice(1)}`))).text()
  fetchMock.mockRestore()
  return /og:url" content="([^"]+)"/.exec(html)?.[1] ?? ''
}

describe('share token round-trip: emitter and sanitizer agree (#1251)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it.each(TOKENS)('individual page pins the emitted id — %s', async (raw, pinned) => {
    const shared = buildShareUrl('https://ai-watch.dev/is-claude-api-down', 'down', 'x', raw)
    const og = await ogUrlFor(isDown, '/api/is-down?slug=claude-api', shared, [
      { id: 'claude', name: 'Claude API', status: 'down', incidents: [incident(raw)] },
    ])
    expect(og).toBe(`https://ai-watch.dev/is-claude-api-down?e=down&amp;i=${pinned}`)
  })

  // The group page keeps a SEPARATE copy of the sanitizer, and its canonical is the family page. It runs
  // the SAME table: pinning only one shape there left the group copy's character class and its length
  // cap unguarded, so a one-sided change to it passed CI while this file's header claimed otherwise.
  //
  // What this pins is the defensive handling of an arbitrary inbound `&i=`, which is the reason the
  // second copy exists.
  it.each(TOKENS)('group page pins an arbitrary inbound token — %s', async (raw, pinned) => {
    const shared = buildShareUrl('https://ai-watch.dev/is-claude-down', 'down', 'copy', raw)
    const og = await ogUrlFor(isDownGroup, '/api/is-down-group?family=claude', shared, [
      { id: 'claude', name: 'Claude API', status: 'down', incidents: [incident(raw)] },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ])
    expect(og).toBe(`https://ai-watch.dev/is-claude-down?e=down&amp;i=${pinned}`)
  })

  // Pooling (#804): the per-channel UTM differs in the SHARED link, and must not reach the pinned
  // identity. This only tests anything because the handler receives the emitter's full query string —
  // rebuilding it from `e` and `i` alone made both iterations byte-identical and the case vacuous.
  it('two channels sharing one incident pin the SAME og:url', async () => {
    const [raw] = TOKENS[1]
    const seen = new Set<string>()
    for (const channel of ['x', 'copy'] as const) {
      const shared = buildShareUrl('https://ai-watch.dev/is-claude-api-down', 'down', channel, raw)
      expect(shared).toContain('utm_source=')   // the thing that must NOT survive into og:url
      seen.add(await ogUrlFor(isDown, '/api/is-down?slug=claude-api', shared, [
        { id: 'claude', name: 'Claude API', status: 'down', incidents: [incident(raw)] },
      ]))
    }
    expect([...seen]).toHaveLength(1)
  })

  // The cap is defensive — no emitter produces a long id — so only a crafted inbound token reaches it.
  // Both handlers cap independently, so both are exercised.
  it('individual page caps a crafted over-long inbound token at 64 chars', async () => {
    const raw = 'x'.repeat(200)
    const og = await ogUrlFor(isDown, '/api/is-down?slug=claude-api', `https://x/?e=down&i=${raw}`, [
      { id: 'claude', name: 'Claude API', status: 'down', incidents: [incident('abc123')] },
    ])
    expect(og).toBe(`https://ai-watch.dev/is-claude-api-down?e=down&amp;i=${'x'.repeat(64)}`)
  })

  it('group page caps a crafted over-long inbound token at 64 chars', async () => {
    const raw = 'y'.repeat(200)
    const og = await ogUrlFor(isDownGroup, '/api/is-down-group?family=claude', `https://x/?e=down&i=${raw}`, [
      { id: 'claude', name: 'Claude API', status: 'down', incidents: [incident('abc123')] },
      { id: 'claudeai', name: 'claude.ai', status: 'operational' },
      { id: 'claudecode', name: 'Claude Code', status: 'operational' },
    ])
    expect(og).toBe(`https://ai-watch.dev/is-claude-down?e=down&amp;i=${'y'.repeat(64)}`)
  })
})

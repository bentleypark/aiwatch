import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'
import type { KVLike } from '../utils'

// #1337 — the WIRING half of the Grok surface merge.
//
// `xai-regions.test.ts` proves `mergeXaiGrokSurfaceIncidents` collapses the right groups. That is not
// the same claim as "the Grok card shows one row": the merge only reaches a card if `services.ts`
// composes it into the `status.x.ai` RSS branch. Deleting that composition leaves every pure-function
// test green — the `debugging_fix_the_called_path_not_the_tested_twin` shape, and the same reason
// `nonok-scrape-legs.test.ts` drives the real `fetchService` rather than a helper.
//
// So this file asserts the OUTPUT of `fetchService(grok, …)` for the real 2026-09-03 feed: one
// incident, carrying the merged identity that only the wired merge can produce.

const grok = SERVICES.find((s) => s.id === 'grok')!
const xai = SERVICES.find((s) => s.id === 'xai')!

function mockKV(store: Record<string, string> = {}): KVNamespace {
  return {
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string) => { store[k] = v },
    delete: async (k: string) => { delete store[k] },
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
  } as unknown as KVLike as unknown as KVNamespace
}

const isXaiFeed = (u: string) => u.endsWith('/feed.xml')

function routedFetch(feedXml: string) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (isXaiFeed(url)) return new Response(feedXml, { status: 200 })
    return new Response('<html>ok</html>', { status: 200 })
  })
}

/** One RSS item in the shape status.x.ai actually publishes — checked against the live feed rather
 *  than copied from the older hand-written fixtures in `betterstack.test.ts`, which use a
 *  `MMM DD, YYYY - HH:MM UTC` form the feed never emits. The real feed wraps the `<strong>` in a `<p>`
 *  and writes RFC-1123 dates, and it is the same string in the update block and in the `Resolved:`
 *  header — which is what makes the #1337 stage stamp reachable. Updates are listed newest-first, as
 *  the feed lists them. */
const item = (guid: string, title: string, updates: Array<{ at: string; h3: string; text: string }>, resolved?: string) =>
  `<item><title>${title}</title><guid>${guid}</guid>` +
  `<description><![CDATA[` +
  (resolved ? `<h3>Status: RESOLVED</h3><p>Resolved: ${resolved}</p>` : '') +
  updates.map((u) => `<div><p><strong>${u.at}</strong></p><h3>${u.h3}</h3><p>${u.text}</p></div>`).join('') +
  `]]></description></item>`

const OPENED = 'Thu, 03 Sep 2026 13:30:00 GMT'
const OPEN_TEXT = 'Grok is experiencing issues. We are working on restoring service as quickly as possible.'
const RESOLVED_TEXT = 'We have resolved the situation, and traffic is healthy again.'

/** The 2026-09-03 outage's four Grok surfaces, plus two API-region items so the two merges compose on
 *  one feed. The Grok guids, the differing Android opening, the `Traffic healthy again` spelling
 *  variant and the four resolution instants are the live feed's; the API items are illustrative and
 *  nothing asserts on them. Deliberately RESOLVED — an all-active fixture never crosses the
 *  `Resolved:` path, which is where this PR's two halves meet. */
const ANDROID_OPEN_H3 = 'Models outage'
const ANDROID_OPEN_TEXT = 'We are experiencing issues with our models.'

const grokItem = (
  guid: string, surface: string, resolvedAt: string,
  opts: { closeH3?: string; openH3?: string; openText?: string } = {},
) =>
  item(guid, `[Grok (${surface})] Models outage`, [
    { at: resolvedAt, h3: opts.closeH3 ?? 'Traffic is healthy again', text: RESOLVED_TEXT },
    { at: OPENED, h3: opts.openH3 ?? 'Investigating outage', text: opts.openText ?? OPEN_TEXT },
  ], resolvedAt)

const FEED_2026_09_03 =
  `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>xAI Status</title>` +
  grokItem('INCc33a8af', 'iOS', 'Thu, 03 Sep 2026 17:08:11 GMT') +
  // Android's opening update is worded differently from its siblings' on the live feed. Homogenising
  // it would make this fixture agree with itself and disagree with the provider: the echo collapse
  // keys on the TEXT, so the real merge emits two opening rows, not one.
  grokItem('INC3b127ff3', 'Android', 'Thu, 03 Sep 2026 17:04:59 GMT', { openH3: ANDROID_OPEN_H3, openText: ANDROID_OPEN_TEXT }) +
  grokItem('INC25664c15', 'Web', 'Thu, 03 Sep 2026 17:07:07 GMT') +
  grokItem('INC4d558447', 'Office/Workspace Plugins', 'Thu, 03 Sep 2026 17:06:10 GMT', { closeH3: 'Traffic healthy again' }) +
  item('xai-us-east-1', '[API (us-east-1.api.x.ai)] Models outage', [
    { at: 'Thu, 03 Sep 2026 17:09:14 GMT', h3: 'Traffic is healthy again', text: RESOLVED_TEXT },
    { at: OPENED, h3: 'Investigating outage', text: OPEN_TEXT },
  ], 'Thu, 03 Sep 2026 17:09:14 GMT') +
  item('xai-us-west-2', '[API (us-west-2.api.x.ai)] Models outage', [
    { at: 'Thu, 03 Sep 2026 17:07:20 GMT', h3: 'Traffic is healthy again', text: RESOLVED_TEXT },
    { at: OPENED, h3: 'Investigating outage', text: OPEN_TEXT },
  ], 'Thu, 03 Sep 2026 17:07:20 GMT') +
  `</channel></rss>`

afterEach(() => { vi.unstubAllGlobals() })

describe('#1337 wiring — fetchService composes the Grok surface merge', () => {
  it('publishes ONE Grok incident for the four surfaces xAI filed', async () => {
    vi.stubGlobal('fetch', routedFetch(FEED_2026_09_03))

    const svc = await fetchService(grok, undefined, mockKV(), {})

    expect(svc.incidents).toHaveLength(1)
    // The merged identity — neither half is producible without the composition in services.ts.
    expect(svc.incidents[0].title).toBe('[Grok (iOS, Android, Web, Office/Workspace Plugins)] Models outage')
    expect(svc.incidents[0].id).toMatch(/^xai-grok:/)
  })

  it('carries the resolution end-to-end — the stage stamp and the merge agree on one feed', async () => {
    // The two halves of this PR meet only on a RESOLVED feed: the parser stamps each surface's closing
    // update `resolved` off its own `Resolved:` marker, and the merge then unions four surfaces into
    // one incident. Neither half's unit tests exercise the other.
    vi.stubGlobal('fetch', routedFetch(FEED_2026_09_03))

    const svc = await fetchService(grok, undefined, mockKV(), {})
    const inc = svc.incidents[0]

    expect(inc.status).toBe('resolved')
    expect(inc.startedAt).toBe('2026-09-03T13:30:00.000Z')
    expect(inc.resolvedAt).toBe('2026-09-03T17:08:11.000Z') // the LAST surface back
    // Two opening rows — three surfaces share one wording and Android uses another, and the collapse
    // keys on the text — then ONE resolution row, the four surfaces' identical closing sentence
    // collapsed to its earliest copy and labelled from the provider's `Resolved:` marker rather than
    // its free-form heading.
    expect(inc.timeline.map(t => t.stage)).toEqual(['investigating', 'investigating', 'resolved'])
    expect(inc.timeline[2].at).toBe('2026-09-03T17:04:59.000Z')
  })

  it('leaves the xAI API card alone — it sees its own region-merged incident, not a Grok one', async () => {
    vi.stubGlobal('fetch', routedFetch(FEED_2026_09_03))

    const svc = await fetchService(xai, undefined, mockKV(), {})

    expect(svc.incidents).toHaveLength(1)
    expect(svc.incidents[0].id).toMatch(/^xai-evt:/)
    expect(svc.incidents[0].title).toContain('[API]')
  })

  it('is a no-op on a feed with one Grok surface — the incident keeps its own title', async () => {
    const single = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>` +
      item('INC00b', '[Grok (Android)] embedding small collections failing to embed', [
        { at: 'Fri, 20 Feb 2026 00:58:44 GMT', h3: 'Investigating', text: 'Investigating.' },
      ]) +
      `</channel></rss>`
    vi.stubGlobal('fetch', routedFetch(single))

    const svc = await fetchService(grok, undefined, mockKV(), {})

    expect(svc.incidents).toHaveLength(1)
    expect(svc.incidents[0].title).toBe('[Grok (Android)] embedding small collections failing to embed')
  })
})

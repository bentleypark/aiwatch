import { describe, it, expect, vi } from 'vitest'
import {
  classifyReferrer,
  parsePageviewBody,
  parseOutageAudienceResponse,
  buildOutageAudienceSql,
  queryOutageAudience,
  recordOutageView,
  AUDIENCE_SOURCES,
  AUDIENCE_SURFACES,
  AUDIENCE_SURFACE_UNKNOWN,
  AUDIENCE_SURFACE_KEYS,
  AUDIENCE_UNKNOWN_SCREEN,
} from '../outage-audience'

describe('classifyReferrer (#842-B)', () => {
  it('classifies X via utm_source (referrer stripped by the X app)', () => {
    expect(classifyReferrer('x', '')).toBe('x')
    expect(classifyReferrer('twitter', '')).toBe('x')
  })
  it('classifies X via referrer host', () => {
    expect(classifyReferrer('', 'x.com')).toBe('x')
    expect(classifyReferrer('', 't.co')).toBe('x')
    expect(classifyReferrer('', 'mobile.twitter.com')).toBe('x')
  })
  it('classifies our feed links via utm_source=rss/feed, and the Discord alert as feed (#936)', () => {
    expect(classifyReferrer('rss', '')).toBe('feed')
    expect(classifyReferrer('feed', '')).toBe('feed')
    expect(classifyReferrer('discord', '')).toBe('feed') // #936 — Discord alert = our notification feed
  })
  it('classifies our own client surfaces (extension/statusline) as owned (#936)', () => {
    expect(classifyReferrer('extension', '')).toBe('owned')
    expect(classifyReferrer('statusline', '')).toBe('owned')
  })
  it('classifies organic search by host', () => {
    expect(classifyReferrer('', 'www.google.com')).toBe('search')
    expect(classifyReferrer('', 'duckduckgo.com')).toBe('search')
    expect(classifyReferrer('', 'search.brave.com')).toBe('search')
  })
  it('falls back to direct ONLY when there is no referrer host at all (#1055 narrowed this)', () => {
    expect(classifyReferrer('', '')).toBe('direct')
    expect(classifyReferrer('threads', '')).toBe('direct')
    expect(classifyReferrer('copy-link', '')).toBe('direct')
  })
  // #1055 — the buckets that split the old catch-all `direct` (measured 83% over one 5-day window;
  // see the module docstring for the caveat). The whole point is that these no longer
  // land in `direct`, so each case asserts BOTH the new bucket and (via the block above) that
  // `direct` now requires an empty host.
  it('names Reddit by utm or host (#1055)', () => {
    expect(classifyReferrer('reddit', '')).toBe('reddit') // utm-tagged (our own #270 outreach links)
    expect(classifyReferrer('', 'www.reddit.com')).toBe('reddit')
    expect(classifyReferrer('', 'old.reddit.com')).toBe('reddit')
    expect(classifyReferrer('', 'reddit.com')).toBe('reddit')
    expect(classifyReferrer('', 'redd.it')).toBe('reddit') // short-link domain
    expect(classifyReferrer('Reddit', '')).toBe('reddit') // case-insensitive, like the others
  })
  it('names Hacker News by utm or host (#1055)', () => {
    expect(classifyReferrer('hn', '')).toBe('hn')
    expect(classifyReferrer('hackernews', '')).toBe('hn')
    expect(classifyReferrer('', 'news.ycombinator.com')).toBe('hn')
    expect(classifyReferrer('', 'hn.algolia.com')).toBe('hn')
  })
  it('sends any OTHER referring host to refhost, not direct (#1055 — this is the split)', () => {
    expect(classifyReferrer('', 'some-blog.example')).toBe('refhost')
    expect(classifyReferrer('', 'news.example.org')).toBe('refhost')
    expect(classifyReferrer('threads', 'l.threads.net')).toBe('refhost') // unknown utm + a real host
  })
  it('does not let a lookalike host hijack a community bucket (#1055)', () => {
    // The reddit/HN/X/search host regexes are all anchored on a dot-or-start boundary AND
    // end-of-string, so these are NOT reddit/HN — they are someone else's domain that merely
    // contains the string. `notreddit`/`fakenews` pin the LEADING boundary (no dot before the
    // label); the `.evil.example` cases pin the trailing `$`.
    expect(classifyReferrer('', 'reddit.com.evil.example')).toBe('refhost')
    expect(classifyReferrer('', 'notreddit.com')).toBe('refhost')
    expect(classifyReferrer('', 'fakenews.ycombinator.com')).toBe('refhost') // leading anchor
    expect(classifyReferrer('', 'news.ycombinator.com.example')).toBe('refhost') // trailing anchor
  })
  it('does not let a lookalike host hijack the SEARCH bucket either (#1055 review fix)', () => {
    // Regression pin: SEARCH_HOSTS used to end at `\.` with no `$`, so any domain carrying an engine
    // label anywhere counted as organic search — inflating a bucket #1055 exists to make trustworthy.
    expect(classifyReferrer('', 'google.evil.example')).toBe('refhost')
    expect(classifyReferrer('', 'bing.attacker.com')).toBe('refhost')
    expect(classifyReferrer('', 'naver.phishing.example')).toBe('refhost')
    // ...while real search hosts, including multi-label ccTLDs, still classify.
    expect(classifyReferrer('', 'www.google.com')).toBe('search')
    expect(classifyReferrer('', 'google.co.uk')).toBe('search')
    expect(classifyReferrer('', 'yahoo.co.jp')).toBe('search')
    expect(classifyReferrer('', 'yandex.ru')).toBe('search')
    expect(classifyReferrer('', 'ecosia.org')).toBe('search')
  })
  it('books our OWN hosts as owned, not refhost (#1055 review fix)', () => {
    // is-down pages cross-link each other, so without this an internal click-through would read as a
    // large unidentified EXTERNAL referrer — corrupting the #887-vs-#270 signal this split produces.
    expect(classifyReferrer('', 'ai-watch.dev')).toBe('owned')
    expect(classifyReferrer('', 'www.ai-watch.dev')).toBe('owned')
    expect(classifyReferrer('', 'aiwatch-git-feat-x.vercel.app')).toBe('owned') // our preview deploys
    expect(classifyReferrer('', 'localhost')).toBe('owned')
    // Not ours — these must stay EXTERNAL. vercel.app is a shared apex, so a third party's site
    // there would otherwise be booked as our own navigation: the same misclassification #1055
    // fixes, pointed the other way.
    expect(classifyReferrer('', 'ai-watch.dev.evil.example')).toBe('refhost')
    expect(classifyReferrer('', 'notai-watch.dev')).toBe('refhost')
    expect(classifyReferrer('', 'someone-elses-tool.vercel.app')).toBe('refhost')
    expect(classifyReferrer('', 'evil.localhost')).toBe('refhost')
  })
  it('lowercases the HOST, not just the utm (#1055 — /api/pageview is public)', () => {
    // Browsers already lowercase `location.hostname`, but the beacon endpoint accepts a hand-crafted
    // body, so the classifier must not depend on the client behaving.
    expect(classifyReferrer('', 'WWW.Reddit.COM')).toBe('reddit')
    expect(classifyReferrer('', 'News.YCombinator.com')).toBe('hn')
    expect(classifyReferrer('', 'AI-Watch.dev')).toBe('owned')
  })
  it('takes a bare hostname, NOT a full URL — the beacon precondition (#1055)', () => {
    // Documents the silent-degradation failure mode: every host pattern is `$`-anchored, so if the
    // beacon ever sent `document.referrer` raw instead of `.hostname`, reddit/hn would sit at
    // permanent zero while refhost absorbed everything and the line still looked plausible.
    // The beacon side is pinned in api/__tests__/is-down-render.test.ts.
    expect(classifyReferrer('', 'https://www.reddit.com/r/ClaudeAI')).toBe('refhost')
  })
  it('lets an explicit utm tag beat a conflicting host (#1055 ordering)', () => {
    expect(classifyReferrer('reddit', 'www.google.com')).toBe('reddit')
    expect(classifyReferrer('rss', 'www.reddit.com')).toBe('feed')
  })
  it('keeps X winning over a reddit host, since the X app strips referrers anyway (#1055)', () => {
    // Ordering pin: a link tagged utm_source=x that somehow carries a reddit referrer is still an X
    // share (our own tag is the stronger claim). Guards against a future reorder silently reclassing.
    expect(classifyReferrer('x', 'www.reddit.com')).toBe('x')
  })
  it('buckets the Claude Code plugin is-down links (utm_source=claude-code) as plugin (#920)', () => {
    expect(classifyReferrer('claude-code', '')).toBe('plugin')
    expect(classifyReferrer('Claude-Code', '')).toBe('plugin') // case-insensitive
  })
  it('utm takes priority and is case-insensitive', () => {
    expect(classifyReferrer('X', 'google.com')).toBe('x')
  })
  it('applies branch precedence: X-host wins over a feed utm (documents the ordering)', () => {
    // utm=rss (would be 'feed') but the referrer host is x.com → X-host check runs first → 'x'.
    expect(classifyReferrer('rss', 'x.com')).toBe('x')
  })
})

describe('parsePageviewBody (#842-B)', () => {
  const ids = new Set(['claude', 'openai'])
  it('accepts a valid body and classifies the source', () => {
    expect(parsePageviewBody({ svc: 'claude', utm: 'x', ref: '', active: true, surface: 'service' }, ids)).toEqual({
      svc: 'claude', source: 'x', active: true, surface: 'service',
    })
  })
  it('rejects an unknown / missing service id (abuse guard)', () => {
    expect(parsePageviewBody({ svc: 'evil', utm: 'x' }, ids)).toBeNull()
    expect(parsePageviewBody({ utm: 'x' }, ids)).toBeNull()
    expect(parsePageviewBody(null, ids)).toBeNull()
    expect(parsePageviewBody('nope', ids)).toBeNull()
  })
  it('coerces active to a strict boolean and defaults false', () => {
    expect(parsePageviewBody({ svc: 'openai', active: 'yes' }, ids)?.active).toBe(false)
    expect(parsePageviewBody({ svc: 'openai' }, ids)?.active).toBe(false)
  })
  it('tolerates non-string utm/ref and does not throw on long input', () => {
    // #1055 — a 500-char junk `ref` is still A HOST as far as we can tell (truncated to 128, never
    // stored raw), so it belongs in `refhost`, not `direct`. `direct` now asserts the absence of a
    // referrer, and a garbage referrer is not an absent one.
    const r = parsePageviewBody({ svc: 'claude', utm: 123, ref: 'x'.repeat(500) }, ids)
    expect(r).toEqual({ svc: 'claude', source: 'refhost', active: false, surface: 'unknown' })
  })

  it('maps a non-string (absent) ref to direct — no host at all (#1055)', () => {
    expect(parsePageviewBody({ svc: 'claude', utm: 123, ref: 456 }, ids))
      .toEqual({ svc: 'claude', source: 'direct', active: false, surface: 'unknown' })
  })
})

describe('bucket-vocabulary sync (#1055)', () => {
  it('AUDIENCE_SOURCES covers every AudienceSource — the widening edit tsc CANNOT catch', () => {
    // Three edits are needed to add a bucket (the union, zeroBySource, AUDIENCE_SOURCES) but only the
    // first two fail the build; AUDIENCE_SOURCES is a plain array. Omitting it is silent AND total:
    // parseOutageAudienceResponse skips rows whose source isn't listed, and formatAudienceLine
    // iterates it — so the bucket sits at a permanent zero everywhere while tsc and every other test
    // stay green. zeroBySource() is the tsc-enforced Record, so its keys are the authoritative set;
    // reading them back through the parser avoids exporting an internal just for a test.
    const zeroed = parseOutageAudienceResponse({ data: [] })
    expect(zeroed).not.toBeNull()
    expect([...AUDIENCE_SOURCES].sort()).toEqual(Object.keys(zeroed!.bySource).sort())
  })

  // #1280 — the same hazard on the surface union, pinned the same way. Widen `AudienceSurface` without
  // widening `AUDIENCE_SURFACES` and tsc catches ONE of four sites (`emptyByScreen`'s keyed Record);
  // the three it misses — both `includes()` normalisations and the render loop — silently route the
  // new surface into `unknown` forever. `byScreen`'s keys are the authoritative set for the same
  // reason `bySource`'s are above: they come from the tsc-enforced Record.
  it('AUDIENCE_SURFACES + the sentinel cover every read-side surface key — the edit tsc CANNOT catch', () => {
    const zeroed = parseOutageAudienceResponse({ data: [] })
    expect(zeroed).not.toBeNull()
    expect([...AUDIENCE_SURFACE_KEYS].sort()).toEqual(Object.keys(zeroed!.byScreen).sort())
    // The sentinel is READ-side only: no page may declare it.
    expect(AUDIENCE_SURFACES).not.toContain(AUDIENCE_SURFACE_UNKNOWN)
  })
})

describe('parseOutageAudienceResponse (#842-B)', () => {
  it('splits counts by source and active/clear phase', () => {
    const json = { data: [
      { source: 'x', phase: 'active', views: '180' },
      { source: 'x', phase: 'clear', views: '20' },
      { source: 'search', phase: 'clear', views: 40 },
      { source: 'feed', phase: 'active', views: 15 },
      { source: 'owned', phase: 'active', views: 10 }, // #936 — extension/statusline bucket
    ] }
    const r = parseOutageAudienceResponse(json)!
    expect(r.total).toBe(265)
    expect(r.activeTotal).toBe(205)
    // Exhaustive shape (not objectContaining) on purpose: a new bucket must show up here, so adding
    // one to AudienceSource without zero-initializing it in zeroBySource() fails loudly. #1055 added
    // reddit/hn/refhost.
    expect(r.bySource).toEqual({ x: 200, search: 40, feed: 15, owned: 10, direct: 0, plugin: 0, reddit: 0, hn: 0, refhost: 0 })
    expect(r.activeBySource).toEqual({ x: 180, search: 0, feed: 15, owned: 10, direct: 0, plugin: 0, reddit: 0, hn: 0, refhost: 0 })
  })
  it('skips unknown source buckets and tolerates bad views', () => {
    const r = parseOutageAudienceResponse({ data: [
      { source: 'bogus', phase: 'active', views: 999 },
      { source: 'direct', phase: 'active', views: 'NaN' },
      { source: 'direct', phase: 'active', views: 5 },
    ] })!
    expect(r.total).toBe(5)
    expect(r.bySource.direct).toBe(5)
  })
  it('returns a zeroed (NON-null) result for an empty data array → section omitted downstream', () => {
    // Load-bearing: formatAudienceLine omits on total<=0, so {data:[]} must yield total 0, not null.
    const r = parseOutageAudienceResponse({ data: [] })!
    expect(r).not.toBeNull()
    expect(r.total).toBe(0)
    expect(r.activeTotal).toBe(0)
  })
  it('returns null when there is no data array', () => {
    expect(parseOutageAudienceResponse({})).toBeNull()
    expect(parseOutageAudienceResponse(null)).toBeNull()
  })

  // #1280 — the widened GROUP BY means one (source, phase) pair now spans MANY rows, up to
  // services × surfaces of them. Every counter must accumulate; an assignment silently keeps only
  // the last row and discards the rest, which at 9 sources × 2 phases loses most of a screen's day
  // while every hand-written-JSON test elsewhere stays green.
  it('accumulates a (source, phase) pair spread across several screen rows', () => {
    const r = parseOutageAudienceResponse({ data: [
      { source: 'x', phase: 'active', svc: 'claude', surface: 'service', views: 5 },
      { source: 'x', phase: 'active', svc: 'claude', surface: 'group', views: 7 },
      { source: 'x', phase: 'clear', svc: 'chatgpt', surface: 'service', views: 3 },
      { source: 'search', phase: 'clear', svc: 'claude', surface: 'service', views: 2 },
    ] })!
    expect(r.total).toBe(17)
    expect(r.activeTotal).toBe(12)
    expect(r.bySource.x).toBe(15)
    expect(r.bySource.search).toBe(2)
    // The two `claude` rows are the SAME id on DIFFERENT surfaces — they must not merge.
    expect(r.byScreen.service).toEqual({ claude: 7, chatgpt: 3 })
    expect(r.byScreen.group).toEqual({ claude: 7 })
    expect(r.byScreen.unknown).toEqual({})
  })

  // The invariant every consumer rests on, and the one the docstring names as load-bearing.
  it('keeps total === Σ bySource === Σ byScreen across the widened grouping', () => {
    const rows = [
      { source: 'x', phase: 'active', svc: 'claude', surface: 'group', views: 40 },
      { source: 'direct', phase: 'clear', svc: 'claude', surface: 'service', views: 18 },
      { source: 'direct', phase: 'clear', svc: 'chatgpt', surface: 'service', views: 9 },
      { source: 'reddit', phase: 'clear', svc: 'cursor', surface: '', views: 4 },
    ]
    const r = parseOutageAudienceResponse({ data: rows })!
    const sumSource = Object.values(r.bySource).reduce((a, b) => a + b, 0)
    const sumScreen = Object.values(r.byScreen).flatMap((m) => Object.values(m)).reduce((a, b) => a + b, 0)
    expect(r.total).toBe(71)
    expect(sumSource).toBe(r.total)
    expect(sumScreen).toBe(r.total) // no view may be counted in `total` and lost from the screen map
  })

  // #1280 round 2 — the hole the invariant docstring used to promise a guard against. A row with no
  // usable id was SKIPPED from byScreen while still counting in `total`, so the operator row
  // under-summed with no residual naming the gap. It is now booked under a bounded sentinel in the
  // `unknown` surface, which the row's `unattributed` tail already reports.
  it('books a row with no usable service id as unattributed rather than skipping it', () => {
    const r = parseOutageAudienceResponse({ data: [
      { source: 'direct', phase: 'clear', svc: 'claude', surface: 'service', views: 10 },
      { source: 'direct', phase: 'clear', svc: '', surface: 'service', views: 90 },
      { source: 'direct', phase: 'clear', surface: 'group', views: 5 },
      { source: 'direct', phase: 'clear', svc: 42, surface: 'service', views: 1 },
    ] })!
    expect(r.total).toBe(106)
    expect(r.byScreen.service).toEqual({ claude: 10 })
    // A view whose SCREEN cannot be named is unattributed whatever surface it claimed — otherwise
    // `service` would absorb 96 views of a page nobody can identify.
    expect(r.byScreen.unknown).toEqual({ [AUDIENCE_UNKNOWN_SCREEN]: 96 })
    expect(r.byScreen.group).toEqual({})
    const sumScreen = Object.values(r.byScreen).flatMap((m) => Object.values(m)).reduce((a, b) => a + b, 0)
    expect(sumScreen).toBe(r.total)
  })

  it('routes an absent or unrecognised surface to unknown, never to service', () => {
    const r = parseOutageAudienceResponse({ data: [
      { source: 'x', phase: 'clear', svc: 'claude', views: 6 },                      // pre-blob4 row
      { source: 'x', phase: 'clear', svc: 'openai', surface: 'Group', views: 4 },    // wrong case
      { source: 'x', phase: 'clear', svc: 'gemini', surface: 'haxx', views: 2 },     // junk
    ] })!
    expect(r.byScreen.unknown).toEqual({ claude: 6, openai: 4, gemini: 2 })
    expect(r.byScreen.service).toEqual({})
    expect(r.byScreen.group).toEqual({})
  })
})

describe('queryOutageAudience (#842-B)', () => {
  const okJson = { data: [{ source: 'x', phase: 'active', views: 7 }] }
  it('returns null without a fetch when creds are absent', async () => {
    const fetchImpl = vi.fn()
    expect(await queryOutageAudience(undefined, 'tok', fetchImpl as unknown as typeof fetch)).toBeNull()
    expect(await queryOutageAudience('acct', undefined, fetchImpl as unknown as typeof fetch)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('posts the SQL and parses a successful response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => okJson })
    const r = await queryOutageAudience('acct', 'tok', fetchImpl as unknown as typeof fetch)
    expect(r?.total).toBe(7)
    expect(r?.activeBySource.x).toBe(7)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('/accounts/acct/analytics_engine/sql')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' })
  })
  it('returns null on a non-OK HTTP status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) })
    expect(await queryOutageAudience('acct', 'tok', fetchImpl as unknown as typeof fetch)).toBeNull()
  })
  it('returns null (never throws) when fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'))
    expect(await queryOutageAudience('acct', 'tok', fetchImpl as unknown as typeof fetch)).toBeNull()
  })
})

describe('recordOutageView (#842-B)', () => {
  it('writes one data point with the source/phase/svc/surface blob order the SQL reads', () => {
    const writeDataPoint = vi.fn()
    recordOutageView({ writeDataPoint } as unknown as AnalyticsEngineDataset, 'x', true, 'claude', 'service')
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['x', 'active', 'claude', 'service'],
      doubles: [1],
      indexes: ['isdown-view'],
    })
  })
  it('maps active=false → clear and no-ops when the binding is absent', () => {
    const writeDataPoint = vi.fn()
    recordOutageView({ writeDataPoint } as unknown as AnalyticsEngineDataset, 'search', false, 'openai', 'service')
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({ blobs: ['search', 'clear', 'openai', 'service'] }))
    expect(() => recordOutageView(undefined, 'x', true, 'claude', 'service')).not.toThrow()
  })
  // #1280 — the group surface is the whole point of blob4: without it this row is indistinguishable
  // from a view of claude's OWN page, because the group page reports a member id by design.
  it('writes the group surface without altering the service id it reports', () => {
    const writeDataPoint = vi.fn()
    recordOutageView({ writeDataPoint } as unknown as AnalyticsEngineDataset, 'x', true, 'claudecode', 'group')
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({ blobs: ['x', 'active', 'claudecode', 'group'] }))
  })
  it('writes the unknown sentinel through unchanged, so a pre-blob4 body is not booked as service', () => {
    const writeDataPoint = vi.fn()
    recordOutageView({ writeDataPoint } as unknown as AnalyticsEngineDataset, 'direct', false, 'claude', 'unknown')
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({ blobs: ['direct', 'clear', 'claude', 'unknown'] }))
  })
})

describe('buildOutageAudienceSql (#842-B)', () => {
  it('filters the isdown-view index, groups by source+window, sums sample_interval', () => {
    const sql = buildOutageAudienceSql('ds')
    expect(sql).toContain("index1 = 'isdown-view'")
    expect(sql).toContain('SUM(_sample_interval)')
    expect(sql).toContain('FROM ds')
  })

  // #1280 — the GROUP BY is asserted WHOLE, not as a prefix. `toContain('GROUP BY blob1, blob2')`
  // passes against both the old two-column query and this one, so reverting the widening left every
  // downstream test green (they all feed hand-written JSON) while `byScreen` sat empty in production
  // forever. Same pin #1273 added for the feed-poll query one commit earlier, for the same reason.
  it('selects AND groups by the screen dimensions (#1280)', () => {
    const sql = buildOutageAudienceSql('ds')
    expect(sql).toContain('blob3 AS svc')
    expect(sql).toContain('blob4 AS surface')
    expect(sql).toContain('GROUP BY blob1, blob2, blob3, blob4')
    // A selected-but-ungrouped column is the failure mode that matters: AE either rejects the query
    // (→ the whole 👥 section silently disappears, the trap the `phase` alias comment guards) or
    // returns an arbitrary representative row.
    expect(sql).not.toContain('GROUP BY blob1, blob2 ')
    expect(sql.endsWith('FORMAT JSON')).toBe(true)
  })
})

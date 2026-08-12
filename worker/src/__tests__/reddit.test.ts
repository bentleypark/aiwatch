import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseRedditAtomResponse, matchesKeywords, matchesSecurityKeywords, matchesCompetitiveKeywords, isPromotable, formatRedditAlert, formatCompetitiveAlert, formatSecurityAlert, REDDIT_TARGETS, isDeadStatus, isThrottledStatus, decideSourceHealth, transientStreakEscalates, readRedditSourceDead, isRedditAtomFeed, markRedditSourceDead, detectRedditPosts } from '../reddit'
import type { RedditAlert } from '../reddit'

// A minimal single-entry Atom feed matching the real shape of `www.reddit.com/r/{sub}/new/.rss`
// (verified live 2026-08-12) — used as the base fixture, cloned/edited per test.
function atomFeed(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-08-12T05:07:07+00:00</updated><title>newest submissions : ClaudeAI</title>${entries}</feed>`
}
// `noise: true` inserts the real per-entry cruft an actual response carries between `<author>` and
// `<id>`/`<link>` — `<category>`, a large escaped-HTML `<content>` blob, and (on some posts)
// `<media:thumbnail url="..." />` sitting immediately before `<link href="...">`. Captured live
// 2026-08-12 from r/ChatGPT. Exercising the parser against this, not just a clean fixture, is what
// actually pins the `<link\b[^>]*\shref="...">` regex against the attribute-order hazard the
// thumbnail tag creates — a fixture without it would pass even if that regex regressed to assuming
// `href` is the first/only attribute.
function atomEntry(opts: { id?: string; title?: string; author?: string; url?: string; published?: string; noise?: boolean }): string {
  const published = opts.published ?? new Date(Date.now() - 60_000).toISOString() // default: 1 minute ago, not a hardcoded date
  const { id = 't3_abc123', title = 'Is Claude down for anyone else?', author = '/u/testuser', url = 'https://www.reddit.com/r/ClaudeAI/comments/abc123/is_claude_down/', noise = false } = opts
  const category = noise ? '<category term="ChatGPT" label="r/ChatGPT"/>' : ''
  const content = noise ? '<content type="html">&lt;table&gt; &lt;tr&gt;&lt;td&gt; &lt;a href=&quot;https://example.com&quot;&gt;&lt;img src=&quot;https://preview.redd.it/x.jpeg?width=640&amp;amp;crop=smart&quot; /&gt;&lt;/a&gt; &lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</content>' : ''
  const thumbnail = noise ? `<media:thumbnail url="https://preview.redd.it/x.jpeg?width=640&amp;crop=smart" />` : ''
  return `<entry><author><name>${author}</name></author>${category}${content}<id>${id}</id>${thumbnail}<link href="${url}" /><updated>${published}</updated><published>${published}</published><title>${title}</title></entry>`
}

describe('parseRedditAtomResponse', () => {
  it('parses a real-shape Atom entry', () => {
    const published = '2026-08-12T05:03:34+00:00'
    const xml = atomFeed(atomEntry({ published }))
    const posts = parseRedditAtomResponse(xml, 'ClaudeAI')
    expect(posts).toHaveLength(1)
    expect(posts[0].id).toBe('t3_abc123')
    expect(posts[0].title).toBe('Is Claude down for anyone else?')
    expect(posts[0].author).toBe('testuser') // /u/ prefix stripped
    expect(posts[0].subreddit).toBe('ClaudeAI') // from the param, not the feed body
    expect(posts[0].url).toBe('https://www.reddit.com/r/ClaudeAI/comments/abc123/is_claude_down/')
    expect(posts[0].createdUtc).toBe(Math.floor(new Date(published).getTime() / 1000))
    expect(posts[0].score).toBeUndefined() // #820 — the feed carries no vote count
  })

  it('parses correctly around the realistic per-entry noise a live response actually carries', () => {
    // Captured live 2026-08-12 (r/ChatGPT): <category>, an escaped-HTML <content> blob, and
    // <media:thumbnail> sitting between <author> and <id>/<link> on real posts. NOTE: this does NOT
    // by itself exercise the <link> regex's attribute-order tolerance — <media:thumbnail> can never
    // match `<link\b`, so it's a different tag entirely. See the dedicated test below for that.
    const xml = atomFeed(atomEntry({ id: 't3_real1', title: 'Noisy post', noise: true }))
    const posts = parseRedditAtomResponse(xml, 'ChatGPT')
    expect(posts).toHaveLength(1)
    expect(posts[0].id).toBe('t3_real1')
    expect(posts[0].title).toBe('Noisy post')
    expect(posts[0].url).toBe('https://www.reddit.com/r/ClaudeAI/comments/abc123/is_claude_down/')
  })

  it('extracts href when <link> carries other attributes before it — the actual attribute-order pin', () => {
    // Verified by mutation (round 2): reverting the regex to `/<link href="([^"]*)"/ ` (href-first-
    // only) still passed every other test in this file, because nothing else in it has a <link> with
    // a leading attribute. This is the one test that would actually fail on that regression.
    const entry = '<entry><author><name>/u/a</name></author><id>t3_attrorder</id><link rel="alternate" type="text/html" href="https://www.reddit.com/r/ClaudeAI/comments/attrorder/" /><published>2026-08-12T00:00:00+00:00</published><title>attr order test</title></entry>'
    const posts = parseRedditAtomResponse(atomFeed(entry), 'ClaudeAI')
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe('https://www.reddit.com/r/ClaudeAI/comments/attrorder/')
  })

  it('decodes XML entities in title and author', () => {
    const xml = atomFeed(atomEntry({ title: 'Claude &amp; ChatGPT both down?', author: '/u/a&amp;b' }))
    const posts = parseRedditAtomResponse(xml, 'ClaudeAI')
    expect(posts[0].title).toBe('Claude & ChatGPT both down?')
    expect(posts[0].author).toBe('a&b')
  })

  it('drops an entry whose link does not point at reddit.com — never posts an untrusted url to Discord', () => {
    const entry = '<entry><author><name>/u/a</name></author><id>t3_evil</id><link href="https://evil.example.com/phish" /><published>2026-08-12T00:00:00+00:00</published><title>valid title</title></entry>'
    expect(parseRedditAtomResponse(atomFeed(entry), 'ClaudeAI')).toEqual([])
  })

  it('handles a genuinely empty feed silently — no <entry markup at all is not a drift signal', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(parseRedditAtomResponse(atomFeed(''), 'ClaudeAI')).toEqual([])
    expect(parseRedditAtomResponse('not xml at all', 'ClaudeAI')).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('#820 round 9 — logs when <entry markup exists but the outer regex matches zero of them (total parse failure, was silent)', () => {
    // The blind spot round 8 fixed one level down (a single malformed entry) had a worse sibling one
    // level up: if the <entry> element itself drifted shape, EVERY entry vanishes with
    // fetchSubreddit still reporting outcome:'ok' and decideSourceHealth deleting the source-dead
    // marker — a quiet day with zero log trace anywhere.
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const driftedXml = atomFeed('<entry-renamed><id>t3_x</id></entry-renamed>')
    expect(parseRedditAtomResponse(driftedXml, 'ClaudeAI')).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ZERO elements parsed'))
    warnSpy.mockRestore()
  })

  it('tolerates attributes on the <entry> tag itself (e.g. xml:lang) without dropping the entry', () => {
    const entry = '<entry xml:lang="en"><author><name>/u/a</name></author><id>t3_attr</id><link href="https://www.reddit.com/r/ClaudeAI/comments/attr/" /><published>2026-08-12T00:00:00+00:00</published><title>entry-level attribute test</title></entry>'
    const posts = parseRedditAtomResponse(atomFeed(entry), 'ClaudeAI')
    expect(posts).toHaveLength(1)
    expect(posts[0].id).toBe('t3_attr')
  })

  it('skips an entry missing id, title, or link, and LOGS each drop (round 8 — was silent)', () => {
    // A silent drop here would let a feed-shape change zero out entries with fetchSubreddit still
    // reporting outcome:'ok' — a parsing regression hiding as a quiet day.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missingId = '<entry><author><name>/u/a</name></author><link href="https://x" /><published>2026-08-12T00:00:00+00:00</published><title>valid</title></entry>'
    const missingTitle = '<entry><author><name>/u/a</name></author><id>t3_ok2</id><link href="https://x" /><published>2026-08-12T00:00:00+00:00</published><title></title></entry>'
    const missingLink = '<entry><author><name>/u/a</name></author><id>t3_ok3</id><published>2026-08-12T00:00:00+00:00</published><title>valid</title></entry>'
    const valid = atomEntry({ id: 't3_ok', title: 'valid post' })
    const posts = parseRedditAtomResponse(atomFeed(missingId + missingTitle + missingLink + valid), 'ClaudeAI')
    expect(posts).toHaveLength(1)
    expect(posts[0].id).toBe('t3_ok')
    expect(warnSpy).toHaveBeenCalledTimes(3)
    expect(warnSpy.mock.calls[0][0]).toContain('missing id/title/link')
    warnSpy.mockRestore()
  })

  it('falls back to author "[deleted]" and createdUtc 0 when those fields are absent, and LOGS the missing date', () => {
    // #820 round 3 — a missing <published> is at least as likely a feed-shape change as a malformed
    // date, and is silently indistinguishable from "no matching posts" otherwise, so it must log too.
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const entry = '<entry><id>t3_nodata</id><link href="https://www.reddit.com/r/ClaudeAI/comments/nodata/" /><title>a post</title></entry>'
    const posts = parseRedditAtomResponse(atomFeed(entry), 'ClaudeAI')
    expect(posts).toHaveLength(1)
    expect(posts[0].author).toBe('[deleted]')
    expect(posts[0].createdUtc).toBe(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing or unparseable'), '(absent)')
    warnSpy.mockRestore()
  })

  it('logs (but still uses createdUtc 0, not a crash) when <published> is present but unparseable', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const entry = '<entry><author><name>/u/a</name></author><id>t3_baddate</id><link href="https://www.reddit.com/r/ClaudeAI/comments/baddate/" /><published>not-a-date</published><title>a post</title></entry>'
    const posts = parseRedditAtomResponse(atomFeed(entry), 'ClaudeAI')
    expect(posts).toHaveLength(1)
    expect(posts[0].createdUtc).toBe(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unparseable'), 'not-a-date')
    warnSpy.mockRestore()
  })
})

describe('isRedditAtomFeed', () => {
  it('accepts a structurally valid Atom feed', () => {
    expect(isRedditAtomFeed(atomFeed(atomEntry({})))).toBe(true)
    expect(isRedditAtomFeed(atomFeed(''))).toBe(true) // zero entries is still a valid (quiet) feed
  })

  it('rejects an HTML bot-wall page served as 200 — the exact #820 failure mode', () => {
    expect(isRedditAtomFeed('<html><body>blocked</body></html>')).toBe(false)
    expect(isRedditAtomFeed('<!DOCTYPE html><html>...</html>')).toBe(false)
  })

  it('rejects garbage / unrelated XML', () => {
    expect(isRedditAtomFeed('')).toBe(false)
    expect(isRedditAtomFeed('<rss><channel></channel></rss>')).toBe(false)
  })
})

// ── #820 endpoint swap — fetchSubreddit is unexported, so its behavior (URL, outcome
// classification, source-health wiring) is exercised end-to-end through detectRedditPosts with a
// mocked global fetch, the same pattern other worker tests use for outbound calls.
describe('detectRedditPosts — /new/.rss endpoint (#820)', () => {
  afterEach(() => vi.unstubAllGlobals())

  function fakeKv(): KVNamespace {
    const store: Record<string, string> = {}
    return {
      get: async (k: string) => store[k] ?? null,
      put: async (k: string, v: string) => { store[k] = v },
      delete: async (k: string) => { delete store[k] },
    } as unknown as KVNamespace
  }

  it('fetches the Atom listing endpoint, not the old JSON search endpoint', async () => {
    const calledUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrls.push(url)
      return new Response(atomFeed(''), { status: 200 })
    }))
    await detectRedditPosts(fakeKv())
    expect(calledUrls.length).toBeGreaterThan(0)
    for (const url of calledUrls) {
      expect(url).toContain('/new/.rss')
      expect(url).not.toContain('search.json')
    }
  })

  it('a real post survives the full pipeline: fetch → parse → keyword match → dedup', async () => {
    const kv = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/r/ClaudeAI/')) {
        return new Response(atomFeed(atomEntry({ id: 't3_live1', title: 'Is Claude down right now?' })), { status: 200 })
      }
      return new Response(atomFeed(''), { status: 200 })
    }))
    const alerts = await detectRedditPosts(kv)
    const found = alerts.find(a => a.post.id === 't3_live1')
    expect(found).toBeDefined()
    expect(found!.type).toBe('outage')
    expect(found!.key).toBe('reddit:seen:t3_live1')
  })

  it('a 403 bot-wall on the new endpoint still marks the source dead (#820 observability holds)', async () => {
    const kv = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>blocked</html>', { status: 403 })))
    await detectRedditPosts(kv)
    const marker = await readRedditSourceDead(kv)
    expect(marker).not.toBeNull()
    expect(marker).not.toBe('unknown')
    expect((marker as { reason: string }).reason).toBe('block')
  })

  it('a 200 HTML bot-wall (not a real 403) is treated as transient, not silently as zero posts ok', async () => {
    // The sneaky failure mode #820 already names for the JSON endpoint — same defense must hold here.
    const kv = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>rate limited</body></html>', { status: 200 })))
    await detectRedditPosts(kv)
    // all-transient across every target → streak bump, not a false "clear"
    const streak = await kv.get('reddit:transient-streak')
    expect(streak).not.toBeNull()
  })

  it('some ok + some 429 marks THROTTLED immediately — real evidence of life makes the quiet tone safe', async () => {
    const kv = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/r/ClaudeAI/')
      ? new Response(atomFeed(''), { status: 200 })
      : new Response('', { status: 429 })))
    await detectRedditPosts(kv)
    const marker = await readRedditSourceDead(kv)
    expect(marker).not.toBeNull()
    expect(marker).not.toBe('unknown')
    expect((marker as { reason: string }).reason).toBe('throttled')
  })

  it('some ok + some genuine 401/403 marks PARTIAL, distinct from throttled — round 5 end-to-end coverage', async () => {
    // decideSourceHealth's 'partial' branch was unit-tested and the switch-case wiring regex-pinned,
    // but (round 5) had no end-to-end proof through the real fetch → outcome → marker pipeline,
    // unlike 'block'/'throttled'/'streak' which all do — and this exact switch is where rounds 2 and
    // 3 found real bugs, so an untested arm here is a live gap.
    const kv = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/r/ClaudeAI/')
      ? new Response(atomFeed(''), { status: 200 })
      : new Response('', { status: 403 })))
    await detectRedditPosts(kv)
    const marker = await readRedditSourceDead(kv)
    expect(marker).not.toBeNull()
    expect(marker).not.toBe('unknown')
    expect((marker as { reason: string }).reason).toBe('partial')
  })

  it('#820 round 2 — a SINGLE all-429 run (zero ok) does NOT mark the source dead at all yet', async () => {
    // The round-1 bug this replaces: this exact scenario used to write an immediate 'throttled'
    // marker on the very first run. It must now behave exactly like a single transient blip —
    // silent until sustained.
    const kv = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    await detectRedditPosts(kv)
    expect(await readRedditSourceDead(kv)).toBeNull()
    expect(await kv.get('reddit:transient-streak')).toBe('1')
  })

  it('#820 round 2/3 — a SUSTAINED all-429 run (3+ consecutive) escalates to "streak", still an alarm', async () => {
    // Round 2 first shipped this as a distinct 'throttled-streak' reason, but round 3 found that
    // broke `markRedditSourceDead`'s timestamp preservation whenever a streak's flavor flipped
    // between runs (see reddit.ts's decideSourceHealth docstring). It's plain 'streak' again — the
    // daily-summary test suite pins that 'streak''s MESSAGE still names throttling as a possible
    // cause, so the diagnosis stays accurate without a second reason value to maintain.
    const kv = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    await detectRedditPosts(kv)
    await detectRedditPosts(kv)
    await detectRedditPosts(kv)
    const marker = await readRedditSourceDead(kv)
    expect(marker).not.toBeNull()
    expect(marker).not.toBe('unknown')
    expect((marker as { reason: string }).reason).toBe('streak')
  })

  it('a sustained all-TRANSIENT (not throttled) run also escalates to "streak"', async () => {
    const kv = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await detectRedditPosts(kv)
    await detectRedditPosts(kv)
    await detectRedditPosts(kv)
    const marker = await readRedditSourceDead(kv)
    expect((marker as { reason: string }).reason).toBe('streak')
  })

  it('a MIXED streak (transient then throttled runs) still escalates cleanly to "streak" with the original start time preserved', async () => {
    // #820 round 3 — the specific scenario that broke the old two-reason design: a streak whose
    // flavor flips between runs must not reset `at`, since the outage has been continuous the whole
    // time. With a single terminal reason, `markRedditSourceDead`'s existing "same reason → preserve
    // at" rule handles this correctly with no special-casing needed.
    const kv = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await detectRedditPosts(kv) // run 1: all transient
    await detectRedditPosts(kv) // run 2: all transient
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    await detectRedditPosts(kv) // run 3: all throttled — flavor flips, streak still escalates here
    const marker = (await readRedditSourceDead(kv)) as { reason: string; at: number }
    expect(marker.reason).toBe('streak')
    const firstAt = marker.at
    await detectRedditPosts(kv) // run 4: still throttled — same reason, `at` must NOT move
    const marker2 = (await readRedditSourceDead(kv)) as { reason: string; at: number }
    expect(marker2.at).toBe(firstAt)
  })

  // pr-review round 1 — the mode-to-classification wiring changed shape when the per-mode search
  // query was replaced by one unified fetch + client-side matching; this proves it still routes a
  // real fetched post from a competitive/security-mode subreddit to the right alert `type`.
  it('a post from a _competitive-mode subreddit (r/devops) classifies as competitive, not outage', async () => {
    const kv = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/r/devops/')) {
        return new Response(atomFeed(atomEntry({ id: 't3_comp1', title: 'Best status monitor for tracking AI API uptime' })), { status: 200 })
      }
      return new Response(atomFeed(''), { status: 200 })
    }))
    const alerts = await detectRedditPosts(kv)
    const found = alerts.find(a => a.post.id === 't3_comp1')
    expect(found).toBeDefined()
    expect(found!.type).toBe('competitive')
    expect(matchesCompetitiveKeywords(found!.post.title)).toBe(true)
  })

  it('a post from a _security-mode subreddit (r/netsec) classifies as security, not outage', async () => {
    const kv = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/r/netsec/')) {
        return new Response(atomFeed(atomEntry({ id: 't3_sec1', title: 'OpenAI API key leak discovered on GitHub' })), { status: 200 })
      }
      return new Response(atomFeed(''), { status: 200 })
    }))
    const alerts = await detectRedditPosts(kv)
    const found = alerts.find(a => a.post.id === 't3_sec1')
    expect(found).toBeDefined()
    expect(found!.type).toBe('security')
  })
})

describe('matchesKeywords', () => {
  it('matches outage-related keywords', () => {
    expect(matchesKeywords('Is Claude down right now?')).toBe(true)
    expect(matchesKeywords('ChatGPT not working for anyone?')).toBe(true)
    expect(matchesKeywords('OpenAI API error 500')).toBe(true)
    expect(matchesKeywords('Major outage reported')).toBe(true)
    expect(matchesKeywords('Service is broken')).toBe(true)
    expect(matchesKeywords('Server seems offline')).toBe(true)
    expect(matchesKeywords('API is slow today')).toBe(true)
    expect(matchesKeywords('currently unavailable')).toBe(true)
  })

  it('matches weak keywords only with context', () => {
    // Weak + context = match
    expect(matchesKeywords('API errors for anyone today?')).toBe(true)
    expect(matchesKeywords('Server slow right now')).toBe(true)
    expect(matchesKeywords('Issues with the service currently')).toBe(true)
    // Weak without context = no match
    expect(matchesKeywords('Issues with my prompt engineering')).toBe(false)
    expect(matchesKeywords('Slow rollout of new features')).toBe(false)
    expect(matchesKeywords('Common errors in fine-tuning')).toBe(false)
  })

  it('does not match unrelated posts', () => {
    expect(matchesKeywords('How to use Claude for coding')).toBe(false)
    expect(matchesKeywords('Best prompts for GPT-4')).toBe(false)
    expect(matchesKeywords('New feature announcement')).toBe(false)
    expect(matchesKeywords('Pricing comparison')).toBe(false)
  })

  it('is case insensitive', () => {
    expect(matchesKeywords('IS CLAUDE DOWN?')).toBe(true)
    expect(matchesKeywords('Not Working at all')).toBe(true)
  })

  describe('WEAK + ? bypass (#296)', () => {
    // Live sample from 2026-04-20 ChatGPT outage: "Error while signing in?" fell through
    // because "signing in" has no CONTEXT word, even though the ? marks it as a status query.
    it('matches WEAK keyword + ? without a CONTEXT word', () => {
      expect(matchesKeywords('Error while signing in?')).toBe(true)
      expect(matchesKeywords('Errors loading the page?')).toBe(true)
      expect(matchesKeywords('Issues sending messages?')).toBe(true)
    })

    it('still requires WEAK keyword — ? alone is not enough', () => {
      expect(matchesKeywords('How do I fine-tune a model?')).toBe(false)
      expect(matchesKeywords('Best prompts for GPT-4?')).toBe(false)
    })
  })
})

describe('matchesSecurityKeywords', () => {
  it('matches AI service security incidents', () => {
    expect(matchesSecurityKeywords('OpenAI data breach exposes user emails')).toBe(true)
    expect(matchesSecurityKeywords('Claude Code RCE vulnerability CVE-2025-59536')).toBe(true)
    expect(matchesSecurityKeywords('Anthropic API key leak found on GitHub')).toBe(true)
    expect(matchesSecurityKeywords('HuggingFace credentials leaked in breach')).toBe(true)
    expect(matchesSecurityKeywords('DeepSeek database compromised with unauthorized access')).toBe(true)
    expect(matchesSecurityKeywords('Gemini prompt injection exploit discovered')).toBe(true)
    expect(matchesSecurityKeywords('xAI Grok hacked — data exfiltration confirmed')).toBe(true)
  })

  it('matches strong security signals with AI-adjacent keywords', () => {
    expect(matchesSecurityKeywords('Major breach at AI cloud provider')).toBe(true)
    expect(matchesSecurityKeywords('CVE-2025-12345 remote code execution in LLM API')).toBe(true)
    expect(matchesSecurityKeywords('Data leak exposes GPT model weights')).toBe(true)
  })

  it('does not match strong security signals without AI context', () => {
    expect(matchesSecurityKeywords('Major breach at cloud provider')).toBe(false)
    expect(matchesSecurityKeywords('CVE-2025-12345 remote code execution in Linux kernel')).toBe(false)
    expect(matchesSecurityKeywords('Data leak exposes millions of records')).toBe(false)
  })

  it('matches security context + AI service', () => {
    expect(matchesSecurityKeywords('OpenAI security vulnerability patched')).toBe(true)
    expect(matchesSecurityKeywords('Anthropic disclosure of exploit')).toBe(true)
    expect(matchesSecurityKeywords('Copilot malicious injection attack')).toBe(true)
  })

  it('does not match unrelated posts', () => {
    expect(matchesSecurityKeywords('How to use Claude for coding')).toBe(false)
    expect(matchesSecurityKeywords('Best security practices for web apps')).toBe(false)
    expect(matchesSecurityKeywords('New feature announcement from Google')).toBe(false)
    expect(matchesSecurityKeywords('Pricing comparison of AI services')).toBe(false)
  })

  it('is case insensitive', () => {
    expect(matchesSecurityKeywords('OPENAI BREACH CONFIRMED')).toBe(true)
    expect(matchesSecurityKeywords('Claude vulnerability DISCLOSURE')).toBe(true)
  })
})

describe('formatSecurityAlert', () => {
  it('formats Reddit security alert with red color and lock icon', () => {
    const alert: RedditAlert = {
      key: 'reddit:seen:sec123',
      subreddit: 'netsec',
      post: {
        id: 'sec123',
        title: 'OpenAI API key leak discovered',
        author: 'secresearcher',
        subreddit: 'netsec',
        score: 42,
        url: 'https://www.reddit.com/r/netsec/comments/sec123/',
        createdUtc: Math.floor(Date.now() / 1000) - 300,
      },
      type: 'security',
    }
    const formatted = formatSecurityAlert(alert)
    expect(formatted.title).toBe('🔒 Security: r/netsec')
    expect(formatted.description).toContain('OpenAI API key leak')
    expect(formatted.color).toBe(0xf85149) // red
  })
})

describe('isPromotable', () => {
  it('detects question-style posts as promotable', () => {
    expect(isPromotable('Is Claude down right now?')).toBe(true)
    expect(isPromotable('Anyone else having issues with ChatGPT?')).toBe(true)
    expect(isPromotable('Claude not working for anyone?')).toBe(true)
    expect(isPromotable('Does anyone know the status?')).toBe(true)
    expect(isPromotable('What is going on with OpenAI?')).toBe(true)
    expect(isPromotable('Is it just me or is Cursor down')).toBe(true)
  })

  it('detects help-seeking posts as promotable', () => {
    expect(isPromotable('Help - Claude API returning 500s')).toBe(true)
    expect(isPromotable('How to check if OpenAI is down')).toBe(true)
    expect(isPromotable("What's happening with Claude today")).toBe(true)
  })

  it('rejects statement/rant posts', () => {
    expect(isPromotable('Claude is terrible today, switching to Gemini')).toBe(false)
    expect(isPromotable('OpenAI outage lasted 3 hours yesterday')).toBe(false)
    expect(isPromotable('Moved all my code to Cursor')).toBe(false)
  })

  it('rejects non-outage posts with ambiguous keywords', () => {
    expect(isPromotable('Anyone want to share their Claude prompts')).toBe(false)
    expect(isPromotable('Someone at OpenAI posted an update')).toBe(false)
    expect(isPromotable('Check out this cool project')).toBe(false)
    expect(isPromotable('When Claude launched last year it was great')).toBe(false)
    expect(isPromotable('Why I switched from OpenAI to Anthropic')).toBe(false)
  })

  describe('megathread path (#296)', () => {
    const HOUR = 3600

    it('promotes declarative outage posts under 2h (live sample: ChatGPT 2026-04-20)', () => {
      // Threads that were missed during the 2026-04-20 outage — the exact conversion window.
      expect(isPromotable('Every single AI app is down', 1.2 * HOUR)).toBe(true)
      expect(isPromotable('ChatGPT outage update', 0.6 * HOUR)).toBe(true)
      expect(isPromotable('Services currently unavailable', 1.5 * HOUR)).toBe(true)
    })

    it('rejects the same declarative posts once they age past 2h', () => {
      // Stale threads are post-incident retrospectives; promoting them surfaces old content.
      expect(isPromotable('Every single AI app is down', 3 * HOUR)).toBe(false)
      expect(isPromotable('ChatGPT outage update', 5 * HOUR)).toBe(false)
    })

    it('pins the 2h boundary with strict < (guards against refactor drift)', () => {
      // Locks `ageSec < MEGATHREAD_MAX_AGE_SEC` so a future `<=` or constant change
      // can't silently shift the cutoff.
      expect(isPromotable('Every single AI app is down', 7199)).toBe(true)
      expect(isPromotable('Every single AI app is down', 7200)).toBe(false)
      expect(isPromotable('Every single AI app is down', 7201)).toBe(false)
    })

    it('regression — keeps existing statement-only titles non-promotable when age gate fails', () => {
      // Title-only call (default ageSec = Infinity) must preserve the original contract.
      expect(isPromotable('OpenAI outage lasted 3 hours yesterday')).toBe(false)
      // Same with an explicit old age — the age branch must not fire.
      expect(isPromotable('OpenAI outage lasted 3 hours yesterday', 10 * HOUR)).toBe(false)
    })

    it('excludes "not working" from the megathread path', () => {
      // "not working" is in STRONG for matchesKeywords but deliberately omitted from
      // PROMOTABLE_STRONG — statement phrasing too often reads as a single-user complaint.
      expect(isPromotable('Claude Code not working properly after update', 0.5 * HOUR)).toBe(false)
    })

    it('rejects rant/statement titles lacking any PROMOTABLE_STRONG keyword', () => {
      expect(isPromotable('Rant about AI quality lately', 0.3 * HOUR)).toBe(false)
      expect(isPromotable('Switching providers because reasons', 0.3 * HOUR)).toBe(false)
    })

    it('callsite integration — filter with age passed mirrors the cron callsite in index.ts', () => {
      const nowSec = Date.now() / 1000
      const alerts: RedditAlert[] = [
        // Live sample 1 — declarative, fresh → promotable via megathread path
        { key: 'k1', subreddit: 'ChatGPT', type: 'outage' as const, post: { id: '1', title: 'Every single AI app is down', author: 'a', subreddit: 'ChatGPT', score: 42, url: '', createdUtc: nowSec - 1.2 * HOUR } },
        // Live sample 2 — question with WEAK + ? → promotable via QUESTION path
        { key: 'k2', subreddit: 'ChatGPT', type: 'outage' as const, post: { id: '2', title: 'Error while signing in?', author: 'b', subreddit: 'ChatGPT', score: 42, url: '', createdUtc: nowSec - 1.4 * HOUR } },
        // Live sample 3 — declarative, fresh → promotable via megathread path
        { key: 'k3', subreddit: 'ChatGPT', type: 'outage' as const, post: { id: '3', title: 'ChatGPT outage update', author: 'c', subreddit: 'ChatGPT', score: 10, url: '', createdUtc: nowSec - 0.6 * HOUR } },
        // Retrospective — declarative but old → excluded by age gate
        { key: 'k4', subreddit: 'OpenAI', type: 'outage' as const, post: { id: '4', title: 'OpenAI outage lasted 3 hours', author: 'd', subreddit: 'OpenAI', score: 20, url: '', createdUtc: nowSec - 10 * HOUR } },
      ]
      const promotable = alerts.filter(a => isPromotable(a.post.title, nowSec - a.post.createdUtc))
      expect(promotable.map(a => a.post.id)).toEqual(['1', '2', '3'])
    })
  })
})

describe('formatRedditAlert', () => {
  it('formats alert with PROMOTE tag and Is X Down link', () => {
    const alert: RedditAlert = {
      key: 'reddit:seen:abc123',
      subreddit: 'ClaudeAI',
      type: 'outage',
      post: {
        id: 'abc123',
        title: 'Is Claude down?',
        author: 'testuser',
        subreddit: 'ClaudeAI',
        score: 5,
        url: 'https://www.reddit.com/r/ClaudeAI/comments/abc123/',
        createdUtc: Math.floor(Date.now() / 1000) - 180,
      },
    }
    const formatted = formatRedditAlert(alert)
    expect(formatted.title).toBe('📢 Reddit: r/ClaudeAI [🎯 PROMOTE]')
    expect(formatted.description).toContain('Is Claude down?')
    expect(formatted.description).toContain('ai-watch.dev/is-claude-api-down')
    // #548 — the promote share link carries the Reddit-channel utm (after the #539 ?e=reddit hint).
    expect(formatted.description).toContain('?e=reddit&utm_source=reddit&utm_medium=social&utm_campaign=outage')
    expect(formatted.description).not.toContain('Suggested reply')
    expect(formatted.color).toBe(0x3fb950)
  })

  it('renders the share link as INLINE CODE so an operator click cannot enter the reddit bucket', () => {
    // The same measurement rule the #1182 engage block carries, on the OTHER operator surface that
    // emits utm_source=reddit. It matters more here, not less: this alert's whole purpose is "go
    // engage with this post", so it is the likelier click. `classifyReferrer` reads utm first, so a
    // click from Discord lands in the same `reddit` bucket as a real visitor and is inseparable
    // afterwards. Asserted in both directions — the backticked form present AND the bare
    // auto-linking form absent, since Discord auto-links any bare URL.
    const alert: RedditAlert = {
      key: 'reddit:seen:z1', subreddit: 'ClaudeAI', type: 'outage',
      post: { id: 'z1', title: 'Is Claude down?', author: 'u', subreddit: 'ClaudeAI', score: 5, url: 'https://reddit.com/x', createdUtc: Math.floor(Date.now() / 1000) - 60 },
    }
    const link = 'https://ai-watch.dev/is-claude-api-down?e=reddit&utm_source=reddit&utm_medium=social&utm_campaign=outage'
    const { description } = formatRedditAlert(alert)
    expect(description).toContain(`\`${link}\``)
    expect(description).not.toContain(`🔗 ${link}\n`)
    expect(description.endsWith(`🔗 ${link}`)).toBe(false)
  })

  it('filters promotable alerts from mixed list (integration)', () => {
    const alerts: RedditAlert[] = [
      { key: 'k1', subreddit: 'ClaudeAI', type: 'outage' as const, post: { id: '1', title: 'Is Claude down?', author: 'a', subreddit: 'ClaudeAI', score: 5, url: '', createdUtc: 0 } },
      { key: 'k2', subreddit: 'OpenAI', type: 'outage' as const, post: { id: '2', title: 'OpenAI outage lasted 3 hours', author: 'b', subreddit: 'OpenAI', score: 20, url: '', createdUtc: 0 } },
      { key: 'k3', subreddit: 'ChatGPT', type: 'outage' as const, post: { id: '3', title: 'Anyone having issues with ChatGPT?', author: 'c', subreddit: 'ChatGPT', score: 8, url: '', createdUtc: 0 } },
    ]
    const promotable = alerts.filter(a => isPromotable(a.post.title))
    expect(promotable).toHaveLength(2)
    expect(promotable[0].post.id).toBe('1')
    expect(promotable[1].post.id).toBe('3')
  })

  it('#539: defuses bare claude.ai in the post title + tags the share link ?e=reddit', () => {
    const alert: RedditAlert = {
      key: 'reddit:seen:c1', subreddit: 'ClaudeAI', type: 'outage',
      post: { id: 'c1', title: 'claude.ai is down again', author: 'u', subreddit: 'ClaudeAI', score: 9, url: 'https://reddit.com/x', createdUtc: Math.floor(Date.now() / 1000) - 60 },
    }
    const formatted = formatRedditAlert(alert)
    expect(formatted.description).toContain('claude ai is down again') // brand defused
    expect(formatted.description).not.toContain('claude.ai')
    expect(formatted.description).toContain('ai-watch.dev/is-claude-api-down?e=reddit') // source-namespaced share link
  })

  it('omits Is X Down link for unknown subreddit', () => {
    const alert: RedditAlert = {
      key: 'reddit:seen:xyz',
      subreddit: 'UnknownSub',
      type: 'outage',
      post: {
        id: 'xyz',
        title: 'Is this service down?',
        author: 'user',
        subreddit: 'UnknownSub',
        score: 1,
        url: 'https://www.reddit.com/r/UnknownSub/comments/xyz/',
        createdUtc: Math.floor(Date.now() / 1000) - 60,
      },
    }
    const formatted = formatRedditAlert(alert)
    expect(formatted.description).not.toContain('is-')
    expect(formatted.title).toContain('PROMOTE')
  })

  it('#820 — drops the upvotes clause (not "0 upvotes") when score is unknown', () => {
    const alert: RedditAlert = {
      key: 'reddit:seen:noscore', subreddit: 'ClaudeAI', type: 'outage',
      post: { id: 'noscore', title: 'Is Claude down?', author: 'u', subreddit: 'ClaudeAI', url: 'https://reddit.com/x', createdUtc: Math.floor(Date.now() / 1000) - 60 }, // score omitted
    }
    const { description } = formatRedditAlert(alert)
    expect(description).not.toContain('upvotes')
    expect(description).not.toContain('undefined')
  })
})

describe('formatCompetitiveAlert / formatSecurityAlert — #820 optional score', () => {
  const baseAlert = (type: 'competitive' | 'security'): RedditAlert => ({
    key: 'reddit:seen:x', subreddit: 'devops', type,
    post: { id: 'x', title: 'a post', author: 'u', subreddit: 'devops', url: 'https://reddit.com/x', createdUtc: Math.floor(Date.now() / 1000) - 60 },
  })

  it('formatCompetitiveAlert drops the upvotes clause when score is unknown', () => {
    const { description } = formatCompetitiveAlert(baseAlert('competitive'))
    expect(description).not.toContain('upvotes')
    expect(description).not.toContain('undefined')
  })

  it('formatSecurityAlert drops the upvotes clause when score is unknown', () => {
    const { description } = formatSecurityAlert(baseAlert('security'))
    expect(description).not.toContain('upvotes')
    expect(description).not.toContain('undefined')
  })

  it('both still show the upvotes clause when score IS known', () => {
    const withScore = (a: RedditAlert): RedditAlert => ({ ...a, post: { ...a.post, score: 7 } })
    expect(formatCompetitiveAlert(withScore(baseAlert('competitive'))).description).toContain('7 upvotes')
    expect(formatSecurityAlert(withScore(baseAlert('security'))).description).toContain('7 upvotes')
  })
})

describe('REDDIT_TARGETS — outage-mode scan targets (#280)', () => {
  // Locks a hardcoded subset of REDDIT_TARGETS in outage mode. It does not read the playbook —
  // #1182 deleted the playbook's per-sub cron column because nothing pinned it. So this guards
  // against silently dropping a scan target, not against doc drift.
  const modeOf = (service: string) =>
    service === '_competitive' ? 'competitive'
      : service === '_security' ? 'security' : 'outage'

  it('keeps the named subs in outage mode', () => {
    const subsInOutageMode = REDDIT_TARGETS
      .filter(t => modeOf(t.service) === 'outage')
      .map(t => t.subreddit)
    // Subs the cron must keep auto-detecting outage posts in, for the Discord 🎯 PROMOTE alert
    expect(subsInOutageMode).toContain('ClaudeAI')
    expect(subsInOutageMode).toContain('ChatGPT')
    expect(subsInOutageMode).toContain('OpenAI')
    // #280: r/LocalLLaMA switched from competitive → outage.
    expect(subsInOutageMode).toContain('LocalLLaMA')
    // #280: r/AINews added for press-adjacent outage threads.
    expect(subsInOutageMode).toContain('AINews')
  })

  it('keeps coding agent subs in outage mode (existing coverage)', () => {
    const subsInOutageMode = REDDIT_TARGETS
      .filter(t => modeOf(t.service) === 'outage')
      .map(t => t.subreddit)
    expect(subsInOutageMode).toContain('ClaudeCode')
    expect(subsInOutageMode).toContain('cursor')
    expect(subsInOutageMode).toContain('windsurf')
    expect(subsInOutageMode).toContain('Codeium')
  })

  it('keeps competitive-only subs in competitive mode (not outage)', () => {
    const competitive = REDDIT_TARGETS.filter(t => modeOf(t.service) === 'competitive').map(t => t.subreddit)
    expect(competitive).toContain('devops')
    expect(competitive).toContain('artificial')
    // Guard against regression: LocalLLaMA must not be demoted back to competitive
    expect(competitive).not.toContain('LocalLLaMA')
  })

  it('keeps security subs in security mode', () => {
    const security = REDDIT_TARGETS.filter(t => modeOf(t.service) === 'security').map(t => t.subreddit)
    expect(security).toContain('netsec')
    expect(security).toContain('cybersecurity')
  })

  it('does not monitor r/MachineLearning yet — deferred pending stricter matcher (#280)', () => {
    const subs = REDDIT_TARGETS.map(t => t.subreddit)
    // Playbook says r/MachineLearning is out-of-scope for auto-detection because
    // research posts naturally contain outage keywords ("broken loss curve", etc.).
    // Adding it without a service-name-required matcher would spam Discord.
    expect(subs).not.toContain('MachineLearning')
  })

  it('uses only known service-field conventions', () => {
    // _competitive and _security are special markers; everything else falls to outage mode.
    // A typo like '_competetive' would silently route to outage — this test catches that.
    const specialMarkers = new Set(['_competitive', '_security'])
    for (const target of REDDIT_TARGETS) {
      if (target.service.startsWith('_')) {
        expect(specialMarkers.has(target.service)).toBe(true)
      }
    }
  })
})

// ── #820 source-health observability ───────────────────────────────────────────
// The bug this fixes is not "Reddit is blocked" — it is that being blocked was INVISIBLE.
// `fetchSubreddit` returned [] on a 403 and the daily summary counts `reddit:seen:*` keys, so a
// total block rendered identically to a quiet day. These pin the three-state fold that makes the
// difference legible. Repairing the fetch itself is the remaining half of #820.
describe('#820 source health', () => {
  it('isDeadStatus classifies only auth/block statuses (401/403) — NOT 429', () => {
    // #820 round 1 — 429 used to fold into 'dead' alongside a real block, which made an operator
    // read "the endpoint is refusing us" when the true cause (rate-limiting on shared Cloudflare
    // egress, measured empirically) usually resolves on its own with no code change needed.
    for (const s of [401, 403]) expect(isDeadStatus(s)).toBe(true)
    for (const s of [200, 404, 429, 500, 502, 503]) expect(isDeadStatus(s)).toBe(false)
  })

  it('isThrottledStatus classifies only 429', () => {
    expect(isThrottledStatus(429)).toBe(true)
    for (const s of [200, 401, 403, 404, 500]) expect(isThrottledStatus(s)).toBe(false)
  })

  it('some alive + some genuinely blocked (401/403) is PARTIAL, not healthy', () => {
    // The blind spot a boolean fold had: 12 of 13 blocked with one success read as fully healthy,
    // and a partial block is a plausible shape for an IP/endpoint-scoped block spreading or healing.
    expect(decideSourceHealth(['ok', 'dead', 'transient'])).toBe('partial')
    expect(decideSourceHealth(['dead', 'ok'])).toBe('partial')
  })

  it('some alive + some throttled (no dead) is its own THROTTLED state, not partial', () => {
    // Ranked separately from 'partial': a real block is more actionable than a rate limit, so if
    // both were present 'partial' should still win (covered below) — but throttled-only alongside
    // real successes must not escalate to the same alarm as a genuine block.
    expect(decideSourceHealth(['ok', 'throttled'])).toBe('throttled')
    expect(decideSourceHealth(['throttled', 'ok', 'throttled'])).toBe('throttled')
  })

  it('dead outranks throttled when both are present with zero ok — a real block is still the story', () => {
    expect(decideSourceHealth(['dead', 'throttled'])).toBe('mark')
  })

  it('round 6 — dead outranks throttled even with ok present too (partial, not the quiet throttled tone)', () => {
    // The 'some alive + some throttled' test above only proves throttled wins over NOTHING; this is
    // the actual precedence claim ("if both were present partial should still win") that test's own
    // comment makes but never checks. Verified by mutation: swapping the `ok>0&&dead>0` / `ok>0&&
    // throttled>0` checks in decideSourceHealth left every other test green — this is the one that
    // would have caught it. A genuine 401/403 block must never render with 🐢's "usually self-heals"
    // tone just because one OTHER subreddit also happened to be merely rate-limited that run.
    expect(decideSourceHealth(['ok', 'dead', 'throttled'])).toBe('partial')
  })

  it('all-clear only when nothing was blocked or throttled', () => {
    expect(decideSourceHealth(['ok'])).toBe('clear')
    expect(decideSourceHealth(['ok', 'transient', 'ok'])).toBe('clear')
  })

  it('blocks with zero OK mark the source dead', () => {
    expect(decideSourceHealth(['dead', 'dead'])).toBe('mark')
    expect(decideSourceHealth(['transient', 'dead'])).toBe('mark')
  })

  it('#820 round 2 fix — zero ok, zero dead, some throttled folds into BUMP, not an immediate THROTTLED marker', () => {
    // The round-1 bug: this used to return 'throttled' directly, which (a) applied the quiet 🐢
    // tone to what could be a total detection outage and (b) reset the transient streak on every
    // occurrence, so a genuinely sustained all-429 run could never escalate to an alarm. Folding it
    // into 'bump' routes it through the same streak-based escalation transient failures use — the
    // escalated reason is a single terminal 'streak' (see `detectRedditPosts`'s 'bump' case); the
    // throttling possibility is carried in that reason's daily-summary MESSAGE, not a second reason
    // value (round 3 tried a second value and it broke `at`-timestamp preservation — see
    // `decideSourceHealth`'s docstring).
    expect(decideSourceHealth(['throttled', 'throttled', 'transient'])).toBe('bump')
    expect(decideSourceHealth(['throttled', 'throttled'])).toBe('bump')
  })

  it('an all-transient run bumps the streak instead of fabricating a marker', () => {
    // No response at all proves nothing: it must neither set a marker off one blip nor wipe a
    // real one. Only a sustained streak escalates.
    expect(decideSourceHealth(['transient', 'transient'])).toBe('bump')
    expect(decideSourceHealth([])).toBe('bump')
  })

  it('escalates only once the transient streak reaches the limit', () => {
    expect(transientStreakEscalates(1)).toBe(false)
    expect(transientStreakEscalates(2)).toBe(false)
    expect(transientStreakEscalates(3)).toBe(true)
    expect(transientStreakEscalates(9)).toBe(true)
  })

  it('readRedditSourceDead reports healthy only for a genuinely absent marker', async () => {
    const kv = (value: string | null) => ({ get: async () => value }) as unknown as KVNamespace
    expect(await readRedditSourceDead(kv(null))).toBeNull()
    expect(await readRedditSourceDead(kv('{"reason":"block","at":123}'))).toEqual({ reason: 'block', at: 123 })
  })

  it('a KV read failure reports UNKNOWN, never healthy', async () => {
    // The asymmetry decides it: a false alarm costs one dismissible Discord line, a false all-clear
    // cost weeks of undetected darkness — which is this issue. A reader of unhealth must not answer
    // "healthy" when it cannot answer at all.
    const kv = { get: async () => { throw new Error('kv down') } } as unknown as KVNamespace
    expect(await readRedditSourceDead(kv)).toBe('unknown')
  })

  it('a malformed marker reports UNKNOWN, not healthy', async () => {
    // Otherwise a shape drift means the marker is written hourly and ignored forever, in silence.
    const kv = (value: string) => ({ get: async () => value }) as unknown as KVNamespace
    expect(await readRedditSourceDead(kv('not json'))).toBe('unknown')
    expect(await readRedditSourceDead(kv('{"at":123}'))).toBe('unknown') // no reason → not a marker
  })

  it('re-marking the same reason preserves the ORIGINAL timestamp', async () => {
    // The fold re-marks every hourly run while unhealthy, and the summary reads the key seconds
    // after the scan writes it. If `at` were re-stamped, the reported age would be "for 0m"
    // forever — reading as a fresh blip for a source dark since June. This is the production
    // sequence, not a hand-built fixture: mark, wait, mark again.
    const store: Record<string, string> = {}
    const kv = {
      get: async (k: string) => store[k] ?? null,
      put: async (k: string, v: string) => { store[k] = v },
      delete: async (k: string) => { delete store[k] },
    } as unknown as KVNamespace

    await markRedditSourceDead(kv, 'block')
    const first = JSON.parse(store['reddit:source-dead']).at
    await new Promise((r) => setTimeout(r, 15))
    await markRedditSourceDead(kv, 'block')
    expect(JSON.parse(store['reddit:source-dead']).at).toBe(first)

    // A CHANGED reason is a new event, so the clock restarts.
    await markRedditSourceDead(kv, 'partial')
    expect(JSON.parse(store['reddit:source-dead']).at).toBeGreaterThan(first)
  })

  it('an unrecognised reason reports UNKNOWN rather than a confident wrong diagnosis', async () => {
    // The summary's ternary has no default arm: anything not partial/streak/throttled renders the
    // assertive "the listing feed returned a block status". A drifted reason must not take that branch.
    const kv = (value: string) => ({ get: async () => value }) as unknown as KVNamespace
    expect(await readRedditSourceDead(kv('{"reason":"token","at":123}'))).toBe('unknown')
    expect(await readRedditSourceDead(kv('{"reason":"","at":123}'))).toBe('unknown')
    expect(await readRedditSourceDead(kv('{"reason":"block","at":"nope"}'))).toBe('unknown')
    expect(await readRedditSourceDead(kv('{"reason":"partial","at":9}'))).toEqual({ reason: 'partial', at: 9 })
  })

  it('"throttled" (#820 round 1) is a recognised reason, not treated as drift', async () => {
    const kv = (value: string) => ({ get: async () => value }) as unknown as KVNamespace
    expect(await readRedditSourceDead(kv('{"reason":"throttled","at":9}'))).toEqual({ reason: 'throttled', at: 9 })
  })

  // isRedditAtomFeed (the #820 endpoint-swap successor to this JSON-shape check) has its own
  // describe block above, alongside the rest of the Atom-parsing tests.
})

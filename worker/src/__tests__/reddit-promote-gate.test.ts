import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  promoteReason, promoteStatusGate, promoteJoinReading, promoteJoinIds, gatePromotes, isPromotable,
  buildPromoteRecord, PROMOTE_RECORD_PREFIX, PROMOTE_RECORD_TTL_SEC, REDDIT_TARGETS,
} from '../reddit'
import type { PromoteJoinReading } from '../reddit'
import { SERVICES } from '../services'
import { detectRedditPosts } from '../reddit'
import { UPSTREAM_DEPS } from '../upstream-link'
import type { ServiceStatusValue } from '../status-verdict'

// #1315 — the promote gate. `PROMOTABLE_STRONG` matches a bare `\bdown\b`, which is also the English
// verb particle, so non-outage posts reached the promote path.

/** A map of services we DID read this cycle. */
const read = (m: Record<string, ServiceStatusValue>): Map<string, PromoteJoinReading> =>
  new Map(Object.entries(m).map(([id, status]) => [id, { status, sourceRead: true }]))

describe('#1315 promoteReason', () => {
  it('names each promotion path', () => {
    expect(promoteReason('Is Claude down?')).toBe('question')
    expect(promoteReason('Anyone else seeing an outage')).toBe('anyone-outage')
    expect(promoteReason('help me, what is going on')).toBe('seeking-help')
    // megathread: declarative, strong keyword, and only when a real age is passed
    expect(promoteReason('Claude API is down for everyone', 60)).toBe('megathread')
    expect(promoteReason('Claude API is down for everyone')).toBeNull()
  })

  it('returns null for an unrelated title', () => {
    expect(promoteReason('Best Qwen quantization GGUF', 60)).toBeNull()
  })

  it('isPromotable agrees with promoteReason, both directions', () => {
    for (const t of [
      'Is Claude down?', 'Anyone else seeing an outage', 'help me, what is going on',
      'Claude API is down for everyone', 'Best Qwen quantization GGUF',
      'TIME Magazine interview with Sam Altman about why OpenAI is slowing down development',
    ]) expect(isPromotable(t, 60)).toBe(promoteReason(t, 60) !== null)
  })
})

// The gate's first cut read the bare status enum and therefore failed CLOSED: services.ts publishes
// `operational` for a source it could not read.
describe('#1315 promoteJoinReading — the status enum alone is not a reading', () => {
  it('a source we did not read is not vouched, however green it looks', () => {
    expect(promoteJoinReading({ status: 'operational' })).toEqual({ status: 'operational', sourceRead: true })
    expect(promoteJoinReading({ status: 'operational', sourceUnknown: true }).sourceRead).toBe(false)
    expect(promoteJoinReading({ status: 'operational', sourceDead: true }).sourceRead).toBe(false)
  })
})

describe('#1315 promoteStatusGate — fail-open is the safety property', () => {
  it('DOWNGRADES only on a positive healthy reading of every joined service', () => {
    expect(promoteStatusGate(['openai'], read({ openai: 'operational' }))).toBe('downgrade-healthy')
    expect(gatePromotes('downgrade-healthy')).toBe(false)
  })

  it('ALLOWS when the service is affected', () => {
    for (const s of ['degraded', 'down'] as ServiceStatusValue[]) {
      expect(promoteStatusGate(['claude'], read({ claude: s }))).toBe('allow')
    }
  })

  // Each of these would put the wrong label on a delivered alert if it downgraded instead.
  it('ALLOWS on an unread source that still publishes `operational`', () => {
    const m = new Map([['claude', { status: 'operational' as ServiceStatusValue, sourceRead: false }]])
    expect(promoteStatusGate(['claude'], m)).toBe('allow-unreadable')
  })
  it('ALLOWS on an `unknown` verdict — neither an outage nor an all-clear (#1233)', () => {
    expect(promoteStatusGate(['claude'], read({ claude: 'unknown' }))).toBe('allow-unreadable')
  })
  it('ALLOWS when we hold no reading for that id', () => {
    expect(promoteStatusGate(['claude'], read({}))).toBe('allow-unreadable')
  })
  it('ALLOWS when the whole map is empty — a cycle that read nothing suppresses nothing', () => {
    expect(gatePromotes(promoteStatusGate(['claude'], new Map()))).toBe(true)
  })
  it('ALLOWS a gate-exempt subreddit', () => {
    expect(promoteStatusGate(undefined, read({ claude: 'operational' }))).toBe('allow-exempt')
    expect(promoteStatusGate([], read({ claude: 'operational' }))).toBe('allow-exempt')
  })

  it('only `downgrade-healthy` blocks', () => {
    expect(gatePromotes('allow')).toBe(true)
    expect(gatePromotes('allow-exempt')).toBe(true)
    expect(gatePromotes('allow-unreadable')).toBe(true)
  })
})

// A subreddit spans several services, so the any-affected rule is what keeps a single-surface
// outage labelled as one.
describe('#1315 multi-service join', () => {
  it('ANY affected member allows, even when the others are healthy', () => {
    expect(promoteStatusGate(
      ['claude', 'claudeai', 'claudecode'],
      read({ claude: 'operational', claudeai: 'down', claudecode: 'operational' }),
    )).toBe('allow')
  })

  it('a claude.ai-only outage keeps r/ClaudeAI promotable', () => {
    const target = REDDIT_TARGETS.find(t => t.subreddit === 'ClaudeAI')
    expect(gatePromotes(promoteStatusGate(
      promoteJoinIds(target?.statusId),
      read({ claude: 'operational', claudeai: 'degraded', claudecode: 'operational' }),
    ))).toBe(true)
  })

  it('a ChatGPT-only outage keeps r/OpenAI promotable', () => {
    const target = REDDIT_TARGETS.find(t => t.subreddit === 'OpenAI')
    expect(gatePromotes(promoteStatusGate(
      promoteJoinIds(target?.statusId),
      read({ openai: 'operational', chatgpt: 'down', codex: 'operational' }),
    ))).toBe(true)
  })

  it('downgrades only when EVERY member reads healthy', () => {
    expect(promoteStatusGate(
      ['claude', 'claudeai', 'claudecode'],
      read({ claude: 'operational', claudeai: 'operational', claudecode: 'operational' }),
    )).toBe('downgrade-healthy')
  })

  it('one unread member is enough to allow, even if the rest read healthy', () => {
    const m = read({ claude: 'operational', claudecode: 'operational' })
    m.set('claudeai', { status: 'operational', sourceRead: false })
    expect(promoteStatusGate(['claude', 'claudeai', 'claudecode'], m)).toBe('allow-unreadable')
  })
})

describe('#1315 the observed false positives', () => {
  // Fired to Discord 2026-09-01 18:00 UTC, r/OpenAI t3_1w4hjpa, 1.2h old.
  const altman = 'TIME Magazine interview with Sam Altman about why OpenAI is slowing down development'
  // Found 2026-09-02 by replaying live feeds through the shipped code; never reached Discord.
  const scroll = 'Anyone else having a glitch today where the text box doesn’t scroll down as you type'

  it('both still match the title filter — #296’s recall is not spent', () => {
    expect(promoteReason(altman, 60)).toBe('megathread')
    expect(promoteReason(scroll, 60)).toBe('anyone-outage')
  })

  it('both are downgraded once every joined service reads healthy', () => {
    expect(gatePromotes(promoteStatusGate(['openai', 'chatgpt', 'codex'],
      read({ openai: 'operational', chatgpt: 'operational', codex: 'operational' })))).toBe(false)
    expect(gatePromotes(promoteStatusGate(['chatgpt', 'openai'],
      read({ chatgpt: 'operational', openai: 'operational' })))).toBe(false)
  })

  it('a real outage post during a real outage still goes through', () => {
    expect(promoteReason('Claude is down for everyone right now', 60)).not.toBeNull()
    expect(gatePromotes(promoteStatusGate(['claude'], read({ claude: 'down' })))).toBe(true)
  })
})

describe('#1315 promoteJoinIds — the join set is derived, not hand-listed', () => {
  const ids = new Set(SERVICES.map(s => s.id))

  it('includes every surface of the anchor’s provider', () => {
    // Three hand-written sets were silently narrowed under review before this was derived; each of
    // those narrowings is now unrepresentable rather than merely tested for.
    for (const anchor of ['claudeai', 'claudecode', 'claude']) {
      expect(promoteJoinIds(anchor)).toEqual(expect.arrayContaining(['claude', 'claudeai', 'claudecode']))
    }
    for (const anchor of ['chatgpt', 'openai', 'codex']) {
      expect(promoteJoinIds(anchor)).toEqual(expect.arrayContaining(['chatgpt', 'openai', 'codex']))
    }
  })

  it('includes a DECLARED upstream that we actually monitor', () => {
    expect(promoteJoinIds('cursor')).toEqual(expect.arrayContaining(['cursor', 'claude']))
  })

  it('drops an upstream that is not a monitored service', () => {
    // chatgpt/codex declare `github-platform`, a feed with no card and so no status to read (#1072).
    for (const id of promoteJoinIds('chatgpt') ?? []) expect(ids).toContain(id)
  })

  // Grouping by `provider` instead of `statusUrl` passes every other assertion here, so this names
  // the concrete pair that separates the two rules rather than restating the implementation.
  it('does NOT join two products that share a vendor but not a status source', () => {
    const azure = SERVICES.find(x => x.id === 'azureopenai')
    const copilot = SERVICES.find(x => x.id === 'copilot')
    expect(azure?.provider, 'fixture premise: same vendor').toBe(copilot?.provider)
    expect(azure?.statusUrl, 'fixture premise: different status page').not.toBe(copilot?.statusUrl)
    // An Azure OpenAI incident must not open the gate for a GitHub Copilot subreddit.
    expect(promoteJoinIds('copilot')).not.toContain('azureopenai')
    expect(promoteJoinIds('azureopenai')).not.toContain('copilot')
  })

  it('never reaches beyond the status source and its declared upstreams', () => {
    for (const anchor of ['claudeai', 'chatgpt', 'cursor', 'windsurf']) {
      const src = SERVICES.find(x => x.id === anchor)?.statusUrl
      for (const id of promoteJoinIds(anchor) ?? []) {
        const sameSource = SERVICES.find(x => x.id === id)?.statusUrl === src
        const declared = UPSTREAM_DEPS.some(d => promoteJoinIds(anchor)?.includes(d.id) && d.upstreamIds.includes(id))
        expect(sameSource || declared, `${anchor} → ${id} shares neither source nor a declared link`).toBe(true)
      }
    }
  })

  it('a service with no siblings and no upstream joins only itself', () => {
    expect(promoteJoinIds('windsurf')).toEqual(['windsurf'])
  })

  it('is undefined for a gate-exempt target, and every id it yields is real', () => {
    expect(promoteJoinIds(undefined)).toBeUndefined()
    for (const t of REDDIT_TARGETS) {
      for (const id of promoteJoinIds(t.statusId) ?? []) expect(ids).toContain(id)
    }
  })

  // Deriving the SET removed every hand-written membership, but left one hand-written value: the
  // anchor. Pointing r/ClaudeAI at `cursor` type-checks and every other test still passes, so the
  // wrong-join class survives at reduced surface unless the anchor itself is pinned.
  it('the anchor is the service the subreddit is named for', () => {
    // The one exception is historical: r/Codeium is the old name of the product now called Windsurf.
    const RENAMED: Record<string, string> = { Codeium: 'windsurf' }
    for (const t of REDDIT_TARGETS) {
      if (!t.statusId) continue
      const expected = RENAMED[t.subreddit] ?? t.subreddit.toLowerCase()
      expect(t.statusId, `r/${t.subreddit} is anchored at ${t.statusId}`).toBe(expected)
    }
  })

  it('outage-mode subs carry an anchor unless deliberately exempt; other modes never do', () => {
    const EXEMPT = new Set(['LocalLLaMA', 'AINews'])
    for (const t of REDDIT_TARGETS) {
      const broad = t.service === '_competitive' || t.service === '_security'
      if (broad || EXEMPT.has(t.subreddit)) expect(t.statusId, `${t.subreddit} must stay gate-exempt`).toBeUndefined()
      else expect(t.statusId, `${t.subreddit} needs an anchor`).toBeTruthy()
    }
  })
})

// The derivation reaches production through ONE hand-written expression in `detectRedditPosts`.
// Deleting it makes `statusIds` undefined for every alert, so the gate answers `allow-exempt` for
// every post and the whole feature is inert — with `statusIds?` optional, neither the type checker
// nor any other test notices. Driving the real `detectRedditPosts` is what closes that
// ("순수fn 초록 ≠ 배선 초록", debugging_fix_the_called_path_not_the_tested_twin).
describe('#1315 detectRedditPosts attaches the DERIVED join set to each alert', () => {
  const entry = (id: string, title: string, sub: string) =>
    `<entry><author><name>/u/a</name></author><id>${id}</id>` +
    `<link href="https://www.reddit.com/r/${sub}/comments/${id.replace('t3_', '')}/" />` +
    `<published>${new Date().toISOString()}</published><updated>${new Date().toISOString()}</updated>` +
    `<title>${title}</title></entry>`
  const feed = (entries: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`

  const kv = { get: async () => null, put: async () => {}, delete: async () => {} } as unknown as KVNamespace

  afterEach(() => { vi.restoreAllMocks() })

  it('an r/ClaudeAI alert carries all three Anthropic surfaces, not just the anchor', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
      String(url).includes('/r/ClaudeAI/')
        ? new Response(feed(entry('t3_join1', 'Is Claude down?', 'ClaudeAI')), { status: 200 })
        : new Response(null, { status: 429 }))
    const alerts = await detectRedditPosts(kv)
    const a = alerts.find(x => x.post.id === 't3_join1')
    expect(a, 'the ClaudeAI alert was not produced').toBeTruthy()
    expect(a?.statusIds).toEqual(expect.arrayContaining(['claude', 'claudeai', 'claudecode']))
  })

  it('an r/cursor alert carries its declared upstream', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
      String(url).includes('/r/cursor/')
        ? new Response(feed(entry('t3_join2', 'Is Cursor down?', 'cursor')), { status: 200 })
        : new Response(null, { status: 429 }))
    const alerts = await detectRedditPosts(kv)
    expect(alerts.find(x => x.post.id === 't3_join2')?.statusIds).toEqual(expect.arrayContaining(['cursor', 'claude']))
  })

  it('a gate-exempt subreddit produces an alert with no join set', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
      String(url).includes('/r/LocalLLaMA/')
        ? new Response(feed(entry('t3_join3', 'Is Claude down?', 'LocalLLaMA')), { status: 200 })
        : new Response(null, { status: 429 }))
    const alerts = await detectRedditPosts(kv)
    const a = alerts.find(x => x.post.id === 't3_join3')
    expect(a, 'the LocalLLaMA alert was not produced').toBeTruthy()
    expect(a?.statusIds).toBeUndefined()
  })
})

describe('#1315 buildPromoteRecord', () => {
  it('captures every joined service’s reading at decision time', () => {
    const { key, value } = buildPromoteRecord({
      postId: 't3_abc', subreddit: 'OpenAI', title: 'slowing down', reason: 'megathread',
      statusIds: ['openai', 'chatgpt'], statusById: read({ openai: 'operational' }),
      verdict: 'downgrade-healthy', sent: false, ageSec: 4321.7, now: new Date('2026-09-02T07:00:00Z'),
    })
    expect(key).toBe(`${PROMOTE_RECORD_PREFIX}t3_abc`)
    expect(value.statusIds).toEqual(['openai', 'chatgpt'])
    // an id we held nothing for is recorded as null, not dropped
    expect(value.statusAtDecision).toEqual({ openai: { status: 'operational', sourceRead: true }, chatgpt: null })
    expect(value.reason).toBe('megathread')
    expect(value.verdict).toBe('downgrade-healthy')
    expect(value.sent).toBe(false)
    expect(value.ageSec).toBe(4322)
    expect(value.at).toBe('2026-09-02T07:00:00.000Z')
  })

  it('records nulls for a gate-exempt subreddit rather than inventing a join', () => {
    const { value } = buildPromoteRecord({
      postId: 't3_x', subreddit: 'LocalLLaMA', title: 'anything', reason: 'question',
      statusById: read({ claude: 'down' }), verdict: 'allow-exempt', sent: true, ageSec: 10,
    })
    expect(value.statusIds).toBeNull()
    expect(value.statusAtDecision).toBeNull()
  })

  it('the TTL matches the 90d documented in kv-schema.md', () => {
    expect(PROMOTE_RECORD_TTL_SEC).toBe(90 * 86400)
  })
})

// #1315 — the promote gate's composition, driven through the REAL `scheduled()` handler.
//
// An earlier cut of this file asserted the composition by matching the source text of index.ts, on
// the stated premise that "nothing in this repo invokes the scheduled handler". That premise was
// false — `cache-reseed-wiring.test.ts` and `kv-read-census.test.ts` both drive it — and the premise
// was taken from a sibling file's header rather than checked. It also produced assertions that could
// not see the properties that matter: which keys land in `reddit:seen:*`, whether the gate runs
// before the send cap, and whether `sent` reflects delivery. All three are behavioural, and all three
// are driven here.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'
import type { RedditAlert } from '../reddit'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})
vi.mock('../reddit', async () => {
  const actual = await vi.importActual<typeof import('../reddit')>('../reddit')
  return { ...actual, detectRedditPosts: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'
import { detectRedditPosts, PROMOTE_RECORD_PREFIX, PROMOTE_RECORD_TTL_SEC } from '../reddit'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
// Minute 2 so the hourly Reddit block runs (`getUTCMinutes() < 5`); mid-month and off 09:00/10:00 so
// neither the monthly nor the daily-summary branch is entangled (the trap cache-reseed-wiring hit).
const event = { scheduledTime: Date.parse('2026-08-12T12:02:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent

function statuses(over: Record<string, Partial<ServiceStatus>> = {}): ServiceStatus[] {
  return SERVICES.map(s => ({
    id: s.id, name: s.name, status: 'operational', incidents: [], ...(over[s.id] ?? {}),
  } as unknown as ServiceStatus))
}

let idSeq = 0
function post(title: string, statusIds: readonly string[] | undefined, subreddit = 'ClaudeAI'): RedditAlert {
  const id = `t3_${++idSeq}`
  return {
    key: `reddit:seen:${id}`, subreddit, type: 'outage', statusIds,
    post: { id, title, author: 'a', subreddit, url: `https://www.reddit.com/r/${subreddit}/comments/${id}/`, createdUtc: event.scheduledTime / 1000 - 600 },
  } as RedditAlert
}

function fakeKv(failPrefix?: string) {
  const store = new Map<string, string>()
  // `ttl` is captured, not discarded: the documented 90d retention reaches KV only through this
  // argument, so dropping it here would let the window shrink to seconds with the suite green.
  const puts: Array<{ key: string; value: string; ttl?: number }> = []
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      if (failPrefix && k.startsWith(failPrefix)) throw new Error('kv down')
      puts.push({ key: k, value: v, ttl: opts?.expirationTtl }); store.set(k, v)
    },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
  return { kv, puts }
}

async function runCron(alerts: RedditAlert[], over: Record<string, Partial<ServiceStatus>> = {}, webhookOk = true, failPrefix?: string) {
  const { kv, puts } = fakeKv(failPrefix)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const errors: string[] = []
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')) })
  const svc = statuses(over)
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: svc, enriched: svc, pageComponents: {}, upstreamFeeds: [] } as never)
  vi.mocked(detectRedditPosts).mockResolvedValue(alerts)
  const discord: string[] = []
  const embeds: Array<{ title?: string; description?: string; color?: number }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('example.invalid')) {
      discord.push(u)
      // The rendered embed is the operator-visible artifact — the label lives only here, so a test
      // that asserts the verdict without reading it would miss a wrong label entirely.
      try { for (const e of JSON.parse(String(init?.body ?? '{}')).embeds ?? []) embeds.push(e) } catch { /* non-embed post */ }
      return new Response(null, { status: webhookOk ? 204 : 500 })
    }
    return new Response('{}', { status: 200 })
  })
  await workerModule.scheduled(event, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' } as never, ctx)
  const promoteLast = puts.filter(p => p.key === 'reddit:promote:last').map(p => JSON.parse(p.value))
  const seen = puts.filter(p => p.key.startsWith('reddit:seen:')).map(p => p.key)
  const recordPuts = puts.filter(p => p.key.startsWith(PROMOTE_RECORD_PREFIX))
  const records = recordPuts.map(p => JSON.parse(p.value))
  return { seen, records, recordPuts, promoteLast, discordSends: discord.length, embeds, errors }
}

describe('#1315 promote gate — driven through the real scheduled() handler', () => {
  afterEach(() => { vi.restoreAllMocks() })

  // The gate downgrades; it never withholds. Nothing is retried, so nothing can age out unseen.
  it('still SENDS a post whose services all read healthy — downgraded, not withheld', async () => {
    const p = post('Is Claude down?', ['claude', 'claudeai'])
    const { seen, records, discordSends, embeds } = await runCron([p])
    expect(discordSends).toBe(1)
    expect(seen).toContain(p.key)
    expect(records[0]?.verdict).toBe('downgrade-healthy')
    expect(records[0]?.sent).toBe(true)
    expect(embeds[0]?.title).toContain('[monitor]')
    expect(embeds[0]?.title).not.toContain('PROMOTE')
    expect(embeds[0]?.description).toContain('our status reads operational')
  })

  it('labels it 🎯 PROMOTE when a joined service is affected, and offers the share link', async () => {
    const p = post('Is Claude down?', ['claude', 'claudeai'])
    const { embeds } = await runCron([p], { claudeai: { status: 'down' } })
    expect(embeds[0]?.title).toContain('🎯 PROMOTE')
    expect(embeds[0]?.description).toContain('ai-watch.dev/is-')
    expect(embeds[0]?.description).not.toContain('our status reads operational')
  })

  it('records `allow` when a joined service is actually affected', async () => {
    const p = post('Is Claude down?', ['claude', 'claudeai'])
    const { seen, records, discordSends } = await runCron([p], { claudeai: { status: 'down' } })
    expect(discordSends).toBe(1)
    expect(seen).toContain(p.key)
    expect(records[0]?.verdict).toBe('allow')
    expect(records[0]?.sent).toBe(true)
  })

  // The membership property no source-text assertion could see.
  // `kv-schema.md` defines `reddit:promote:last` as the trace that a `[🎯 PROMOTE]` alert fired. This
  // loop now carries downgraded alerts too, so a `[monitor]` post writing that key would read as a
  // promote that never happened.
  it('a downgraded alert does NOT write the PROMOTE-only marker', async () => {
    const p = post('Is Claude down?', ['claude'])
    const { promoteLast, discordSends } = await runCron([p])
    expect(discordSends).toBe(1)          // it was sent
    expect(promoteLast).toHaveLength(0)   // but it is not a promote
  })

  // #1202's property, behaviourally: the marker must mean DELIVERED, not attempted. A source-text
  // guard cannot hold this — the one in `reddit-source-dead-wiring` matched any `if (sent && …)` in
  // the loop, so dropping `sent` from the marker's own gate while adding an unrelated `if (sent && …)`
  // elsewhere left the whole suite green.
  it('a promotable alert whose webhook FAILS writes no marker', async () => {
    const p = post('Is Claude down?', ['claude'])
    const { promoteLast, records } = await runCron([p], { claude: { status: 'down' } }, false)
    expect(records[0]?.verdict).toBe('allow')   // it was a promote
    expect(records[0]?.sent).toBe(false)        // that did not reach Discord
    expect(promoteLast).toHaveLength(0)         // so it left no "delivered" trace
  })

  it('a promoted alert DOES write the marker', async () => {
    const p = post('Is Claude down?', ['claude'])
    const { promoteLast } = await runCron([p], { claude: { status: 'down' } })
    expect(promoteLast).toHaveLength(1)
    expect(promoteLast[0].postId).toBe(p.post.id)
  })

  it('a post that is not promotable BY TITLE is still marked seen', async () => {
    const p = post('Best Qwen quantization GGUF', ['claude'])
    const { seen, records } = await runCron([p])
    expect(seen).toContain(p.key)
    expect(records).toHaveLength(0)   // never reached the gate, so nothing to record
  })

  it('an unread status source keeps the PROMOTE label — no quiet relabelling on a broken read', async () => {
    const p = post('Is Claude down?', ['claude'])
    // `services.ts` publishes `operational` for a source it could not read; only the flag differs.
    const { records, embeds } = await runCron([p], { claude: { status: 'operational', sourceUnknown: true } })
    expect(records[0]?.verdict).toBe('allow-unreadable')
    expect(embeds[0]?.title).toContain('🎯 PROMOTE')
  })

  it('a gate-exempt subreddit is promoted regardless of status', async () => {
    const p = post('Is Claude down?', undefined, 'LocalLLaMA')
    const { discordSends, records } = await runCron([p])
    expect(discordSends).toBeGreaterThan(0)
    expect(records[0]?.verdict).toBe('allow-exempt')
  })

  // The 3-slot cap is now the only place a post can still be dropped, so a promotable post must
  // outrank downgraded ones for those slots — otherwise a real outage loses its slot to noise.
  it('a promotable post wins a send slot ahead of downgraded ones', async () => {
    const noise = [1, 2, 3].map(() => post('Is Claude down?', ['claude']))
    const real = post('Is ChatGPT down?', ['chatgpt'])
    const { discordSends, records } = await runCron([...noise, real], { chatgpt: { status: 'down' } })
    expect(discordSends).toBe(3)                                  // the cap, not the gate
    const promoted = records.find(r => r.verdict === 'allow')
    expect(promoted?.postId).toBe(real.post.id)
    expect(promoted?.sent).toBe(true)
  })

  it('`sent` records delivery, not selection — a failed webhook is recorded as not sent', async () => {
    const p = post('Is Claude down?', ['claude'])
    const { records, seen } = await runCron([p], { claude: { status: 'down' } }, false)
    expect(records[0]?.verdict).toBe('allow')
    expect(records[0]?.sent).toBe(false)
    expect(seen).toContain(p.key)   // unchanged: the seen key is not gated on delivery
  })

  // Without this the instrument can fail wholesale and read as "the gate reached no decisions" —
  // the exact ambiguity the record exists to remove.
  it('logs when the record write fails instead of losing the instrument silently', async () => {
    const p = post('Is Claude down?', ['claude'])
    const { records, errors, discordSends } = await runCron([p], {}, true, PROMOTE_RECORD_PREFIX)
    expect(records).toHaveLength(0)                       // the write did fail
    expect(discordSends).toBe(1)                          // and it cost no alert
    expect(errors.some(e => e.includes('promote-record write failed'))).toBe(true)
  })

  // The constant is asserted elsewhere; this pins that it actually reaches KV. Without it the
  // documented 90d window can become seconds and the forensic read returns an empty list — the
  // same "did the gate never fire, or did the record die?" ambiguity the record exists to remove.
  it('writes the record with the documented 90d retention', async () => {
    const p = post('Is Claude down?', ['claude'])
    const { recordPuts } = await runCron([p])
    expect(recordPuts).toHaveLength(1)
    expect(recordPuts[0].ttl).toBe(PROMOTE_RECORD_TTL_SEC)
    expect(PROMOTE_RECORD_TTL_SEC).toBe(90 * 86400)
  })

  it('records the reading of every joined service at decision time', async () => {
    const p = post('Is Claude down?', ['claude', 'claudeai'])
    const { records } = await runCron([p], { claudeai: { status: 'down' } })
    expect(records[0]?.statusIds).toEqual(['claude', 'claudeai'])
    expect(records[0]?.statusAtDecision.claude).toEqual({ status: 'operational', sourceRead: true })
    expect(records[0]?.statusAtDecision.claudeai).toEqual({ status: 'down', sourceRead: true })
  })
})

import { describe, it, expect, vi } from 'vitest'
import {
  ENRICH_MAX_PER_RUN, ENRICH_PENDING_KEY, ENRICH_WINDOW_MS, insertAnalysis, messageEditUrl, parseMessageId, parsePending,
  runEnrichment, withWaitParam, type EnrichRecord,
} from '../alert-enrich'
import { DISCORD_EMBED_DESC_MAX } from '../alerts'

const HOOK = 'https://discord.com/api/webhooks/123/abc'
const NOW = Date.parse('2026-11-06T10:00:00Z')

function kvOf(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  const puts: string[] = []
  const ttls: Array<number | undefined> = []
  return {
    store,
    puts,
    ttls,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string, o?: { expirationTtl?: number }) => { puts.push(k); ttls.push(o?.expirationTtl); store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
    },
  }
}

const rec = (over: Partial<EnrichRecord> = {}): EnrichRecord => ({
  messageId: '111', svcId: 'mistral', incId: 'inc-1', title: 'T', color: 1, sentAt: '2026-11-06T09:55:00.000Z',
  full: 'HEAD\nREST\nOPS', core: 'HEAD\nREST', at: 4, expiresAt: NOW + 60_000, ...over,
})

describe('webhook URLs', () => {
  it('withWaitParam adds wait=true and keeps an existing thread_id', () => {
    expect(withWaitParam(HOOK)).toBe(`${HOOK}?wait=true`)
    expect(new URL(withWaitParam(`${HOOK}?thread_id=9`)).searchParams.get('thread_id')).toBe('9')
  })

  it('messageEditUrl targets the message, keeps thread_id and drops wait', () => {
    expect(messageEditUrl(HOOK, '555')).toBe(`${HOOK}/messages/555`)
    expect(messageEditUrl(`${HOOK}/`, '555')).toBe(`${HOOK}/messages/555`)
    const u = new URL(messageEditUrl(`${HOOK}?thread_id=9&wait=true`, '555'))
    expect(u.pathname).toBe('/api/webhooks/123/abc/messages/555')
    expect(u.searchParams.get('thread_id')).toBe('9')
    expect(u.searchParams.has('wait')).toBe(false)
  })
})

describe('parseMessageId', () => {
  it.each([
    [{ id: '1234567890' }, '1234567890'],
    [{ id: 1234567890 }, null],
    [{ id: 'abc' }, null],
    [{}, null],
    [null, null],
    ['1234', null],
  ])('%j → %j', (body, expected) => {
    expect(parseMessageId(body)).toBe(expected)
  })
})

describe('insertAnalysis', () => {
  const section = '\n┈┈\n🤖 **AI ANALYSIS** [Beta]\nsummary'

  it('puts the section where the sender would have, matching a send that had it', () => {
    const sentWith = ['HEAD', section, 'REST', 'OPS'].join('\n')
    expect(insertAnalysis(rec(), section)).toBe(sentWith)
  })

  it('defuses claude.ai inside the section, as the sender does', () => {
    expect(insertAnalysis(rec(), '\nsee claude.ai')).toBe('HEAD\n\nsee claude ai\nREST\nOPS')
  })

  it('falls back to the shared part when the full description would pass the cap', () => {
    const ops = 'x'.repeat(DISCORD_EMBED_DESC_MAX - 'HEAD\nREST\n'.length)
    const r = rec({ full: `HEAD\nREST\n${ops}` })
    expect(r.full.length).toBe(DISCORD_EMBED_DESC_MAX)
    expect(insertAnalysis(r, section)).toBe(['HEAD', section, 'REST'].join('\n'))
  })

  it('returns null when even the shared part would pass the cap', () => {
    const big = 'y'.repeat(DISCORD_EMBED_DESC_MAX)
    expect(insertAnalysis(rec({ full: `HEAD\n${big}`, core: `HEAD\n${big}` }), section)).toBeNull()
  })
})

describe('parsePending', () => {
  it('reads a stored list and drops malformed rows', () => {
    const good = rec()
    expect(parsePending(JSON.stringify([good, { messageId: 1 }, null, { ...good, at: '4' }]))).toEqual([good])
  })

  it.each([null, ''])('%j reads as empty', (raw) => {
    expect(parsePending(raw)).toEqual([])
  })

  it.each(['not json', '{"a":1}'])('%j is unreadable, not empty', (raw) => {
    expect(parsePending(raw)).toBeNull()
  })
})

describe('runEnrichment', () => {
  const section = async () => '\nAI'
  const none = async () => null

  it('edits a queued alert whose analysis is ready and empties the queue', async () => {
    const { kv, store, ttls } = kvOf()
    const patch = vi.fn().mockResolvedValue(true)
    const counts = await runEnrichment(kv, [rec()], section, patch, NOW)
    expect(counts).toEqual({ enriched: 1, failed: 0, expired: 0 })
    expect(patch).toHaveBeenCalledWith(rec(), 'HEAD\n\nAI\nREST\nOPS')
    expect(parsePending(store.get(ENRICH_PENDING_KEY) ?? null)!).toEqual([])
    expect(ttls).toEqual([7200])
  })

  it('keeps a record whose analysis has not landed, and edits it on a later run', async () => {
    const { kv, store } = kvOf()
    const patch = vi.fn().mockResolvedValue(true)
    expect(await runEnrichment(kv, [rec()], none, patch, NOW)).toEqual({ enriched: 0, failed: 0, expired: 0 })
    expect(parsePending(store.get(ENRICH_PENDING_KEY) ?? null)!).toEqual([rec()])
    expect(await runEnrichment(kv, [], section, patch, NOW + 300_000 - 60_000)).toEqual({ enriched: 1, failed: 0, expired: 0 })
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it('drops a record whose window passed without an analysis', async () => {
    const { kv, store } = kvOf({ [ENRICH_PENDING_KEY]: JSON.stringify([rec({ expiresAt: NOW })]) })
    expect(await runEnrichment(kv, [], none, vi.fn(), NOW)).toEqual({ enriched: 0, failed: 0, expired: 1 })
    expect(parsePending(store.get(ENRICH_PENDING_KEY) ?? null)!).toEqual([])
  })

  it('counts a failed edit once and does not retry it', async () => {
    const { kv, store } = kvOf()
    const patch = vi.fn().mockResolvedValue(false)
    expect(await runEnrichment(kv, [rec()], section, patch, NOW)).toEqual({ enriched: 0, failed: 1, expired: 0 })
    expect(parsePending(store.get(ENRICH_PENDING_KEY) ?? null)!).toEqual([])
  })

  it('counts a throwing edit as failed', async () => {
    const { kv } = kvOf()
    const patch = vi.fn().mockRejectedValue(new Error('network'))
    expect(await runEnrichment(kv, [rec()], section, patch, NOW)).toEqual({ enriched: 0, failed: 1, expired: 0 })
  })

  it('counts a section too long for the embed as failed, without calling Discord', async () => {
    const { kv } = kvOf()
    const patch = vi.fn().mockResolvedValue(true)
    const long = async () => `\n${'z'.repeat(DISCORD_EMBED_DESC_MAX)}`
    expect(await runEnrichment(kv, [rec()], long, patch, NOW)).toEqual({ enriched: 0, failed: 1, expired: 0 })
    expect(patch).not.toHaveBeenCalled()
  })

  it('treats a throwing section read as not ready', async () => {
    const { kv, store } = kvOf()
    const read = async () => { throw new Error('kv') }
    expect(await runEnrichment(kv, [rec()], read, vi.fn(), NOW)).toEqual({ enriched: 0, failed: 0, expired: 0 })
    expect(parsePending(store.get(ENRICH_PENDING_KEY) ?? null)!).toHaveLength(1)
  })

  it(`edits at most ${ENRICH_MAX_PER_RUN} per run and keeps the rest`, async () => {
    const { kv, store } = kvOf()
    const patch = vi.fn().mockResolvedValue(true)
    const many = Array.from({ length: ENRICH_MAX_PER_RUN + 2 }, (_, i) => rec({ messageId: String(i) }))
    expect(await runEnrichment(kv, many, section, patch, NOW)).toEqual({ enriched: ENRICH_MAX_PER_RUN, failed: 0, expired: 0 })
    expect(parsePending(store.get(ENRICH_PENDING_KEY) ?? null)!.map((r) => r.messageId)).toEqual(['5', '6'])
  })

  it('keeps the stored queue past its latest record\'s window', async () => {
    const { kv, ttls } = kvOf()
    await runEnrichment(kv, [rec({ expiresAt: NOW + 3_600_000 }), rec({ expiresAt: NOW + 600_000 })], none, vi.fn(), NOW)
    expect(ttls).toEqual([3600 + 7200])
  })

  it('counts an alert whose analysis never lands as expired, against a store that honours the TTL', async () => {
    let clock = NOW
    const store = new Map<string, { v: string; until: number }>()
    const kv = {
      get: async (k: string) => { const e = store.get(k); return e && clock < e.until ? e.v : null },
      put: async (k: string, v: string, o?: { expirationTtl?: number }) => { store.set(k, { v, until: clock + (o?.expirationTtl ?? Infinity) * 1000 }) },
      delete: async (k: string) => { store.delete(k) },
    }
    let expired = 0
    expired += (await runEnrichment(kv, [rec({ expiresAt: NOW + ENRICH_WINDOW_MS + 7_000 })], none, vi.fn(), clock)).expired
    for (let k = 1; k <= 30; k++) {
      clock = NOW + k * 300_000
      expired += (await runEnrichment(kv, [], none, vi.fn(), clock)).expired
    }
    expect(expired).toBe(1)
  })

  it.each([
    ['a read that throws', { get: async () => { throw new Error('kv down') } }],
    ['a value that is not a queue', { get: async () => 'not json' }],
  ])('leaves the stored queue alone after %s, and counts the new alerts as failed', async (_, broken) => {
    const { kv, store, puts } = kvOf({ [ENRICH_PENDING_KEY]: JSON.stringify([rec({ messageId: '1' })]) })
    const counts = await runEnrichment({ ...kv, ...broken }, [rec({ messageId: '3' })], section, vi.fn(), NOW)
    expect(counts).toEqual({ enriched: 0, failed: 1, expired: 0 })
    expect(puts).toEqual([])
    expect(parsePending(store.get(ENRICH_PENDING_KEY) ?? null)!.map((r) => r.messageId)).toEqual(['1'])
  })

  it('edits nothing when the queue cannot be updated, so a later run edits each alert once', async () => {
    const { kv, store } = kvOf({ [ENRICH_PENDING_KEY]: JSON.stringify([rec({ messageId: '1' })]) })
    const failing = { ...kv, put: async () => { throw new Error('kv down') } }
    const patch = vi.fn().mockResolvedValue(true)
    expect(await runEnrichment(failing, [rec({ messageId: '3' })], section, patch, NOW)).toEqual({ enriched: 0, failed: 1, expired: 0 })
    expect(patch).not.toHaveBeenCalled()
    expect(await runEnrichment(kv, [], section, patch, NOW)).toEqual({ enriched: 1, failed: 0, expired: 0 })
    expect(await runEnrichment(kv, [], section, patch, NOW)).toEqual({ enriched: 0, failed: 0, expired: 0 })
    expect(patch).toHaveBeenCalledTimes(1)
    expect(parsePending(store.get(ENRICH_PENDING_KEY) ?? null)!).toEqual([])
  })

  it('writes nothing when there is nothing queued', async () => {
    const { kv, puts } = kvOf()
    await runEnrichment(kv, [], section, vi.fn(), NOW)
    expect(puts).toEqual([])
  })

  it('writes nothing when a stored record is still waiting and nothing was added', async () => {
    const { kv, puts } = kvOf({ [ENRICH_PENDING_KEY]: JSON.stringify([rec()]) })
    await runEnrichment(kv, [], none, vi.fn(), NOW)
    expect(puts).toEqual([])
  })
})

import { describe, it, expect, vi } from 'vitest'
import {
  sha256Hex,
  generateCode,
  encryptUrl,
  decryptUrl,
  isValidEncKey,
  normalizeFilters,
  shouldDeliver,
  classifyDelivery,
  reserveConfirmBudget,
  listConfirmedHashes,
  subscribe,
  confirm,
  updateFilters,
  unsubscribe,
  deliverToSubscribers,
  readConfirmed,
  readPending,
  CONFIRM_BUDGET_MAX,
  MAX_FAIL_COUNT,
  SUB_PREFIX,
  type SubscriptionFilters,
} from '../webhook-subscriptions'
import type { AlertFeedEntry } from '../alert-feed'
// Parity guard: the former client-side relay decision (#475) the worker must stay byte-identical to.
// Namespace import (not named) — the SPA module lives outside the worker vitest root and a named
// import trips a vitest module-resolution quirk; the namespace form resolves cleanly.
import * as clientRelay from '../../../src/utils/webhookAlerts'

// In-memory KV mock supporting get/put(+metadata)/delete/list(prefix,cursor). TTL ignored (tests
// don't advance wall-clock across TTLs).
function makeKV() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async ({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) => {
      const all = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort()
      // Paginate in pages of 2 to exercise the cursor loop in listConfirmedHashes.
      const start = cursor ? parseInt(cursor, 10) : 0
      const page = all.slice(start, start + 2)
      const next = start + 2
      const complete = next >= all.length
      return { keys: page.map((name) => ({ name })), list_complete: complete, cursor: complete ? undefined : String(next) }
    },
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> }
}

const KEY = 'a'.repeat(64) // valid AES-256 hex key
const URL_OK = 'https://discord.com/api/webhooks/123456789/abcdefgABCDEFG_token-xyz'
const URL_LEGACY = 'https://discordapp.com/api/webhooks/123/tok'
const URL_BAD = 'https://evil.example.com/api/webhooks/123/tok'

const FILTERS_ALL: SubscriptionFilters = { alertCondition: 'all', alertTarget: 'all', alertServices: [], alertIncidents: true }

function feedEntry(over: Partial<AlertFeedEntry>): AlertFeedEntry {
  return { key: 'alerted:new:i1', kind: 'new', svcIds: ['claude'], embed: { title: 't', description: 'd', color: 1 }, ts: 1, ...over }
}

describe('sha256Hex / generateCode', () => {
  it('hashes deterministically (64 hex)', async () => {
    const h1 = await sha256Hex(URL_OK)
    const h2 = await sha256Hex(URL_OK)
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[a-f0-9]{64}$/)
  })
  it('generates 6-digit codes', () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(/^\d{6}$/)
  })
})

describe('AES-GCM encrypt/decrypt', () => {
  it('round-trips the URL', async () => {
    const enc = await encryptUrl(URL_OK, KEY)
    expect(enc.startsWith('v1.')).toBe(true)
    expect(enc).not.toContain(URL_OK) // ciphertext, not plaintext
    expect(await decryptUrl(enc, KEY)).toBe(URL_OK)
  })
  it('uses a fresh IV each time (ciphertext differs)', async () => {
    expect(await encryptUrl(URL_OK, KEY)).not.toBe(await encryptUrl(URL_OK, KEY))
  })
  it('fails closed on invalid key', async () => {
    expect(isValidEncKey(undefined)).toBe(false)
    expect(isValidEncKey('short')).toBe(false)
    expect(isValidEncKey(KEY)).toBe(true)
    await expect(encryptUrl(URL_OK, 'short')).rejects.toThrow()
  })
  it('returns null on tamper / wrong key / malformation', async () => {
    const enc = await encryptUrl(URL_OK, KEY)
    expect(await decryptUrl(enc, 'b'.repeat(64))).toBeNull() // wrong key → GCM auth fail
    expect(await decryptUrl('garbage', KEY)).toBeNull()
    expect(await decryptUrl('v2.' + enc.slice(3), KEY)).toBeNull() // unknown keyId
  })
})

describe('normalizeFilters', () => {
  it('defaults missing/invalid to permissive baseline', () => {
    expect(normalizeFilters(undefined)).toEqual({ alertCondition: 'all', alertTarget: 'all', alertServices: [], alertIncidents: true })
    expect(normalizeFilters({ alertCondition: 'bogus', alertTarget: 'x', alertIncidents: false }))
      .toEqual({ alertCondition: 'all', alertTarget: 'all', alertServices: [], alertIncidents: false })
  })
  it('keeps valid values + caps services', () => {
    const f = normalizeFilters({ alertCondition: 'down', alertTarget: 'custom', alertServices: ['claude', 'openai', 5], alertIncidents: true })
    expect(f.alertCondition).toBe('down')
    expect(f.alertTarget).toBe('custom')
    expect(f.alertServices).toEqual(['claude', 'openai'])
  })
  it('caps alertServices at 100 entries (stored-size DoS guard)', () => {
    const many = Array.from({ length: 250 }, (_, i) => `svc${i}`)
    expect(normalizeFilters({ alertServices: many }).alertServices).toHaveLength(100)
  })
})

describe('shouldDeliver (parity with client shouldRelay)', () => {
  it('custom target requires a matching service', () => {
    const f: SubscriptionFilters = { ...FILTERS_ALL, alertTarget: 'custom', alertServices: ['openai'] }
    expect(shouldDeliver(feedEntry({ svcIds: ['claude'] }), f)).toBe(false)
    expect(shouldDeliver(feedEntry({ svcIds: ['openai'] }), f)).toBe(true)
  })
  it('incident kinds gated by alertIncidents', () => {
    expect(shouldDeliver(feedEntry({ kind: 'new' }), { ...FILTERS_ALL, alertIncidents: false })).toBe(false)
    expect(shouldDeliver(feedEntry({ kind: 'resolved' }), FILTERS_ALL)).toBe(true)
  })
  it("condition 'down' drops degraded but keeps down/recovered", () => {
    const f: SubscriptionFilters = { ...FILTERS_ALL, alertCondition: 'down' }
    expect(shouldDeliver(feedEntry({ kind: 'degraded' }), f)).toBe(false)
    expect(shouldDeliver(feedEntry({ kind: 'down' }), f)).toBe(true)
    expect(shouldDeliver(feedEntry({ kind: 'recovered' }), f)).toBe(true)
  })
  // Pins the #475 "byte-identical" contract: the worker's shouldDeliver must agree with the former
  // client shouldRelay (src/utils/webhookAlerts.js) for every (kind × filter) combination, so server
  // delivery (PR3) matches what the browser relay did. If either drifts, this fails.
  it('agrees with the client shouldRelay over the full kind × filter matrix', () => {
    const kinds: AlertFeedEntry['kind'][] = ['new', 'resolved', 'down', 'degraded', 'recovered']
    const conditions: Array<'down' | 'all'> = ['down', 'all']
    const targets: Array<'all' | 'custom'> = ['all', 'custom']
    const serviceSets = [[], ['claude'], ['openai']]
    const incidentsFlags = [true, false]
    const svcIdSets = [['claude'], ['openai'], ['claude', 'openai'], []]
    for (const kind of kinds)
      for (const alertCondition of conditions)
        for (const alertTarget of targets)
          for (const alertServices of serviceSets)
            for (const alertIncidents of incidentsFlags)
              for (const svcIds of svcIdSets) {
                const entry = feedEntry({ kind, svcIds })
                const filters = { alertCondition, alertTarget, alertServices, alertIncidents }
                expect(shouldDeliver(entry, filters)).toBe(clientRelay.shouldRelay(entry, filters))
              }
  })
})

describe('reserveConfirmBudget — fail-open on KV read error', () => {
  it('allows (returns true) and does not throw when the KV read fails', async () => {
    const kv = { get: async () => { throw new Error('kv down') }, put: async () => {} } as unknown as KVNamespace
    expect(await reserveConfirmBudget(kv, '2026-05-29T00')).toBe(true)
  })
})

describe('classifyDelivery', () => {
  it('prunes on 410/404, succeeds on 2xx, retries otherwise', () => {
    expect(classifyDelivery(410)).toBe('prune')
    expect(classifyDelivery(404)).toBe('prune')
    expect(classifyDelivery(204)).toBe('success')
    expect(classifyDelivery(200)).toBe('success')
    expect(classifyDelivery(429)).toBe('retry')
    expect(classifyDelivery(500)).toBe('retry')
    expect(classifyDelivery(null)).toBe('retry')
  })
})

describe('reserveConfirmBudget', () => {
  it('allows up to the cap then blocks', async () => {
    const kv = makeKV()
    kv._store.set('webhook:confirm:budget:2026-05-29T00', String(CONFIRM_BUDGET_MAX - 1))
    expect(await reserveConfirmBudget(kv, '2026-05-29T00')).toBe(true)  // hits the cap
    expect(await reserveConfirmBudget(kv, '2026-05-29T00')).toBe(false) // over
  })
})

describe('listConfirmedHashes (cursor pagination)', () => {
  it('returns every hash across pages', async () => {
    const kv = makeKV()
    for (let i = 0; i < 5; i++) kv._store.set(`${SUB_PREFIX}hash${i}`, '{}')
    kv._store.set('webhook:pending:other', '{}') // must be ignored (wrong prefix)
    const hashes = await listConfirmedHashes(kv)
    expect(hashes.sort()).toEqual(['hash0', 'hash1', 'hash2', 'hash3', 'hash4'])
  })
})

describe('subscribe → confirm flow', () => {
  it('rejects bad host (SSRF), incl. accepting legacy discordapp.com', async () => {
    const kv = makeKV()
    const post = vi.fn(async () => true)
    const bad = await subscribe(kv, KEY, URL_BAD, FILTERS_ALL, '2026-05-29T00', 'now', post)
    expect(bad).toEqual({ ok: false, status: 403, error: 'Webhook URL not allowed' })
    expect(post).not.toHaveBeenCalled()
    const legacy = await subscribe(kv, KEY, URL_LEGACY, FILTERS_ALL, '2026-05-29T00', 'now', post)
    expect(legacy.ok).toBe(true)
  })
  it('fails closed without a valid enc key', async () => {
    const kv = makeKV()
    const r = await subscribe(kv, undefined, URL_OK, FILTERS_ALL, '2026-05-29T00', 'now', async () => true)
    expect(r).toEqual({ ok: false, status: 503, error: 'Subscriptions unavailable' })
  })
  it('does not store pending if the confirm message fails to send', async () => {
    const kv = makeKV()
    const r = await subscribe(kv, KEY, URL_OK, FILTERS_ALL, '2026-05-29T00', 'now', async () => false)
    expect(r.ok).toBe(false)
    expect(await readPending(kv, await sha256Hex(URL_OK))).toBeNull()
  })
  it('stores pending then confirms with the right code → permanent sub', async () => {
    const kv = makeKV()
    let captured = ''
    const r = await subscribe(kv, KEY, URL_OK, FILTERS_ALL, '2026-05-29T00', 'now', async (_u, code) => { captured = code; return true })
    expect(r.ok).toBe(true)
    const hash = (r as { ok: true; hash: string }).hash
    expect(await readPending(kv, hash)).not.toBeNull()

    // A wrong code (guaranteed != captured) is rejected and must NOT consume the pending row.
    const wrong = captured === '111111' ? '222222' : '111111'
    expect((await confirm(kv, hash, wrong, 'now')).ok).toBe(false)
    expect(await readPending(kv, hash)).not.toBeNull()
    const good = await confirm(kv, hash, captured, 'now')
    expect(good.ok).toBe(true)
    const sub = await readConfirmed(kv, hash)
    expect(sub?.type).toBe('discord')
    expect(sub?.failCount).toBe(0)
    expect(await readPending(kv, hash)).toBeNull() // pending consumed
    // stored URL is encrypted, decryptable back to the original
    expect(sub!.encUrl).not.toContain(URL_OK)
    expect(await decryptUrl(sub!.encUrl, KEY)).toBe(URL_OK)
  })
  it('confirm on missing/expired pending → 410', async () => {
    const kv = makeKV()
    const r = await confirm(kv, 'a'.repeat(64), '123456', 'now')
    expect(r).toEqual({ ok: false, status: 410, error: 'Confirmation expired or not found' })
  })
  it('confirm rejects malformed hash/code with 400 and does not touch KV', async () => {
    const kv = makeKV()
    const getSpy = vi.spyOn(kv, 'get')
    expect((await confirm(kv, 'short', '123456', 'now')).ok).toBe(false)
    expect((await confirm(kv, 'a'.repeat(64), '12', 'now'))).toEqual({ ok: false, status: 400, error: 'Invalid request' })
    expect(getSpy).not.toHaveBeenCalled() // validation rejects before any KV read
  })
  it('re-subscribe on an already-confirmed channel is an idempotent no-op (no send, no budget charge)', async () => {
    const kv = makeKV()
    const hash = await sha256Hex(URL_OK)
    kv._store.set(`${SUB_PREFIX}${hash}`, JSON.stringify({ encUrl: await encryptUrl(URL_OK, KEY), filters: FILTERS_ALL, type: 'discord', registeredAt: 'x', failCount: 0 }))
    const post = vi.fn(async () => true)
    const r = await subscribe(kv, KEY, URL_OK, FILTERS_ALL, '2026-05-29T00', 'now', post)
    expect(r).toEqual({ ok: true, hash, status: 'confirmed' })
    expect(post).not.toHaveBeenCalled() // no channel re-spam
    expect(kv._store.has('webhook:confirm:budget:2026-05-29T00')).toBe(false) // no budget charged
  })
  it('re-subscribe while a confirmation is pending does not re-send or re-charge', async () => {
    const kv = makeKV()
    const post = vi.fn(async () => true)
    const first = await subscribe(kv, KEY, URL_OK, FILTERS_ALL, '2026-05-29T00', 'now', post)
    expect(first.ok && first.status).toBe('sent')
    expect(post).toHaveBeenCalledTimes(1)
    const second = await subscribe(kv, KEY, URL_OK, FILTERS_ALL, '2026-05-29T00', 'now', post)
    expect(second.ok && second.status).toBe('pending')
    expect(post).toHaveBeenCalledTimes(1) // not re-sent
  })
  it('confirm maps a KV write failure to 500 (not 400)', async () => {
    const kv = makeKV()
    let captured = ''
    const r = await subscribe(kv, KEY, URL_OK, FILTERS_ALL, '2026-05-29T00', 'now', async (_u, c) => { captured = c; return true })
    const hash = (r as { ok: true; hash: string }).hash
    vi.spyOn(kv, 'put').mockRejectedValueOnce(new Error('kv down'))
    const c = await confirm(kv, hash, captured, 'now')
    expect(c).toEqual({ ok: false, status: 500, error: 'Storage error' })
  })
})

describe('updateFilters / unsubscribe', () => {
  it('updates filters on a confirmed sub without OTP', async () => {
    const kv = makeKV()
    const hash = await sha256Hex(URL_OK)
    kv._store.set(`${SUB_PREFIX}${hash}`, JSON.stringify({ encUrl: await encryptUrl(URL_OK, KEY), filters: FILTERS_ALL, type: 'discord', registeredAt: 'x', failCount: 0 }))
    const r = await updateFilters(kv, hash, { alertCondition: 'down', alertTarget: 'custom', alertServices: ['claude'], alertIncidents: false })
    expect(r.ok).toBe(true)
    const sub = await readConfirmed(kv, hash)
    expect(sub?.filters.alertCondition).toBe('down')
    expect(sub?.filters.alertServices).toEqual(['claude'])
  })
  it('update on unknown hash → 404', async () => {
    const kv = makeKV()
    expect(await updateFilters(kv, 'b'.repeat(64), FILTERS_ALL)).toEqual({ ok: false, status: 404, error: 'Subscription not found' })
  })
  it('unsubscribe deletes the sub (idempotent)', async () => {
    const kv = makeKV()
    const hash = await sha256Hex(URL_OK)
    kv._store.set(`${SUB_PREFIX}${hash}`, '{}')
    expect((await unsubscribe(kv, hash)).ok).toBe(true)
    expect(await readConfirmed(kv, hash)).toBeNull()
    expect((await unsubscribe(kv, hash)).ok).toBe(true) // idempotent
  })
})

describe('deliverToSubscribers', () => {
  async function seedSub(kv: ReturnType<typeof makeKV>, url: string, filters: SubscriptionFilters, failCount = 0) {
    const hash = await sha256Hex(url)
    kv._store.set(`${SUB_PREFIX}${hash}`, JSON.stringify({ encUrl: await encryptUrl(url, KEY), filters, type: 'discord', registeredAt: 'x', failCount }))
    return hash
  }

  it('delivers matching entries, dedups on re-run', async () => {
    const kv = makeKV()
    await seedSub(kv, URL_OK, FILTERS_ALL)
    const feed = [feedEntry({ key: 'alerted:new:i1' })]
    const post = vi.fn(async () => 204)
    const s1 = await deliverToSubscribers(kv, KEY, feed, post, 1)
    expect(s1.delivered).toBe(1)
    expect(post).toHaveBeenCalledTimes(1)
    // second run: same entry already marked sent → no re-deliver
    const s2 = await deliverToSubscribers(kv, KEY, feed, post, 2)
    expect(s2.delivered).toBe(0)
    expect(post).toHaveBeenCalledTimes(1)
  })
  it('applies per-sub filters', async () => {
    const kv = makeKV()
    await seedSub(kv, URL_OK, { ...FILTERS_ALL, alertTarget: 'custom', alertServices: ['openai'] })
    const feed = [feedEntry({ svcIds: ['claude'] })] // not in custom list
    const post = vi.fn(async () => 204)
    const stats = await deliverToSubscribers(kv, KEY, feed, post, 1)
    expect(stats.delivered).toBe(0)
    expect(post).not.toHaveBeenCalled()
  })
  it('prunes immediately on 410', async () => {
    const kv = makeKV()
    const hash = await seedSub(kv, URL_OK, FILTERS_ALL)
    const stats = await deliverToSubscribers(kv, KEY, [feedEntry({})], async () => 410, 1)
    expect(stats.pruned).toBe(1)
    expect(kv._store.has(`${SUB_PREFIX}${hash}`)).toBe(false)
  })
  it('prunes after MAX_FAIL_COUNT consecutive failures, not before', async () => {
    const kv = makeKV()
    const hash = await seedSub(kv, URL_OK, FILTERS_ALL, MAX_FAIL_COUNT - 1)
    const stats = await deliverToSubscribers(kv, KEY, [feedEntry({})], async () => 500, 1)
    expect(stats.pruned).toBe(1) // failCount was MAX-1, this failure tips it over
    expect(kv._store.has(`${SUB_PREFIX}${hash}`)).toBe(false)
  })
  it('does not prune on a single transient failure', async () => {
    const kv = makeKV()
    const hash = await seedSub(kv, URL_OK, FILTERS_ALL, 0)
    await deliverToSubscribers(kv, KEY, [feedEntry({})], async () => 500, 1)
    const sub = await readConfirmed(kv, hash)
    expect(sub?.failCount).toBe(1)
    expect(kv._store.has(`${SUB_PREFIX}${hash}`)).toBe(true)
  })
  it('resets failCount on a successful cycle', async () => {
    const kv = makeKV()
    const hash = await seedSub(kv, URL_OK, FILTERS_ALL, 3)
    await deliverToSubscribers(kv, KEY, [feedEntry({})], async () => 204, 1)
    expect((await readConfirmed(kv, hash))?.failCount).toBe(0)
  })
  it('no-ops without a valid enc key', async () => {
    const kv = makeKV()
    await seedSub(kv, URL_OK, FILTERS_ALL)
    const post = vi.fn(async () => 204)
    const stats = await deliverToSubscribers(kv, undefined, [feedEntry({})], post, 1)
    expect(stats).toEqual({ attempted: 0, delivered: 0, pruned: 0, failed: 0, rejected: 0 })
    expect(post).not.toHaveBeenCalled()
  })
  it('no-ops on an empty feed', async () => {
    const kv = makeKV()
    await seedSub(kv, URL_OK, FILTERS_ALL)
    const post = vi.fn(async () => 204)
    const stats = await deliverToSubscribers(kv, KEY, [], post, 1)
    expect(stats).toEqual({ attempted: 0, delivered: 0, pruned: 0, failed: 0, rejected: 0 })
    expect(post).not.toHaveBeenCalled()
  })
  it('prunes an undecryptable row (corrupt/rotated-away encUrl) without delivering', async () => {
    const kv = makeKV()
    const hash = await sha256Hex(URL_OK)
    // Structurally malformed encUrl (not the keyId.iv.ct shape) → decryptUrl returns null → prune.
    kv._store.set(`${SUB_PREFIX}${hash}`, JSON.stringify({ encUrl: 'garbage-no-dots', filters: FILTERS_ALL, type: 'discord', registeredAt: 'x', failCount: 0 }))
    const post = vi.fn(async () => 204)
    const stats = await deliverToSubscribers(kv, KEY, [feedEntry({})], post, 1)
    expect(stats.pruned).toBe(1)
    expect(post).not.toHaveBeenCalled()
    expect(kv._store.has(`${SUB_PREFIX}${hash}`)).toBe(false)
  })
  it('multi-entry feed: bumps failCount once per cycle, not per entry', async () => {
    const kv = makeKV()
    const hash = await seedSub(kv, URL_OK, FILTERS_ALL, 0)
    const feed = [feedEntry({ key: 'alerted:new:i1' }), feedEntry({ key: 'alerted:new:i2' })]
    await deliverToSubscribers(kv, KEY, feed, async () => 500, 1)
    expect((await readConfirmed(kv, hash))?.failCount).toBe(1) // one bump for the whole cycle, not 2
  })
  it('multi-entry feed: a 410 mid-loop prunes and stops delivering remaining entries', async () => {
    const kv = makeKV()
    const hash = await seedSub(kv, URL_OK, FILTERS_ALL)
    const feed = [feedEntry({ key: 'alerted:new:i1' }), feedEntry({ key: 'alerted:new:i2' })]
    const post = vi.fn(async () => 410)
    const stats = await deliverToSubscribers(kv, KEY, feed, post, 1)
    expect(stats.pruned).toBe(1)
    expect(post).toHaveBeenCalledTimes(1) // stopped after the first entry's 410
    expect(kv._store.has(`${SUB_PREFIX}${hash}`)).toBe(false)
  })
})

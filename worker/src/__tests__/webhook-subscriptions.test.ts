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
  isSubscriberHash,
  subscribe,
  confirm,
  updateFilters,
  unsubscribe,
  deliverToSubscribers,
  toPerUserEntry,
  computeSubscriberDelta,
  readConfirmed,
  readPending,
  CONFIRM_BUDGET_MAX,
  MAX_FAIL_COUNT,
  SUB_PREFIX,
  type SubscriptionFilters,
} from '../webhook-subscriptions'
import type { AlertFeedEntry } from '../alert-feed'

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

describe('shouldDeliver — per-user delivery filter (ported from the former client shouldRelay, #475)', () => {
  it('custom target requires a matching service', () => {
    const f: SubscriptionFilters = { ...FILTERS_ALL, alertTarget: 'custom', alertServices: ['openai'] }
    expect(shouldDeliver(feedEntry({ svcIds: ['claude'] }), f)).toBe(false)
    expect(shouldDeliver(feedEntry({ svcIds: ['openai'] }), f)).toBe(true)
    expect(shouldDeliver(feedEntry({ svcIds: ['claude', 'openai'] }), f)).toBe(true) // any match passes
  })
  it('incident kinds gated by alertIncidents', () => {
    expect(shouldDeliver(feedEntry({ kind: 'new' }), { ...FILTERS_ALL, alertIncidents: false })).toBe(false)
    expect(shouldDeliver(feedEntry({ kind: 'resolved' }), { ...FILTERS_ALL, alertIncidents: false })).toBe(false)
    expect(shouldDeliver(feedEntry({ kind: 'new' }), FILTERS_ALL)).toBe(true)
    expect(shouldDeliver(feedEntry({ kind: 'resolved' }), FILTERS_ALL)).toBe(true)
  })
  it("condition 'down' drops degraded but keeps down/recovered; 'all' keeps everything", () => {
    const down: SubscriptionFilters = { ...FILTERS_ALL, alertCondition: 'down' }
    expect(shouldDeliver(feedEntry({ kind: 'degraded' }), down)).toBe(false)
    expect(shouldDeliver(feedEntry({ kind: 'down' }), down)).toBe(true)
    expect(shouldDeliver(feedEntry({ kind: 'recovered' }), down)).toBe(true)
    expect(shouldDeliver(feedEntry({ kind: 'degraded' }), FILTERS_ALL)).toBe(true)
  })
  it('never delivers an unknown kind', () => {
    expect(shouldDeliver(feedEntry({ kind: 'bogus' as AlertFeedEntry['kind'] }), FILTERS_ALL)).toBe(false)
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
  const hex = (i: number) => i.toString(16).padStart(64, '0') // a 64-char hex subscriber hash

  it('returns every hash across pages', async () => {
    const kv = makeKV()
    for (let i = 0; i < 5; i++) kv._store.set(`${SUB_PREFIX}${hex(i)}`, '{}')
    kv._store.set('webhook:pending:other', '{}') // must be ignored (wrong prefix)
    const hashes = await listConfirmedHashes(kv)
    expect(hashes.sort()).toEqual([hex(0), hex(1), hex(2), hex(3), hex(4)])
  })

  it('#1011 — excludes webhook:sub:count:{date} snapshot keys that share the prefix', async () => {
    const kv = makeKV()
    // 2 real subscribers + 7 daily count snapshots, exactly the prod-KV shape (real=2, listed=9).
    kv._store.set(`${SUB_PREFIX}${hex(1)}`, '{}')
    kv._store.set(`${SUB_PREFIX}${hex(2)}`, '{}')
    for (let d = 8; d <= 14; d++) kv._store.set(`${SUB_PREFIX}count:2026-07-${d}`, '3')
    const hashes = await listConfirmedHashes(kv)
    expect(hashes.sort()).toEqual([hex(1), hex(2)]) // only the real hashes — count keys dropped
    expect(hashes).toHaveLength(2) // not 9
  })
})

describe('isSubscriberHash (#1011)', () => {
  it('accepts a 64-char lowercase-hex hash', () => {
    expect(isSubscriberHash('a'.repeat(64))).toBe(true)
    expect(isSubscriberHash('0123456789abcdef'.repeat(4))).toBe(true)
  })
  it('rejects the count-snapshot suffix and any non-hash shape', () => {
    expect(isSubscriberHash('count:2026-07-08')).toBe(false)
    expect(isSubscriberHash('A'.repeat(64))).toBe(false) // uppercase not emitted by sha256Hex
    expect(isSubscriberHash('a'.repeat(63))).toBe(false) // too short
    expect(isSubscriberHash('a'.repeat(65))).toBe(false) // too long
    expect(isSubscriberHash('')).toBe(false)
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

describe('toPerUserEntry — per-user is-down link rewrite (#726, #936 UTM)', () => {
  const desc = (link: string) => `🔴 Down\n[View on AIWatch](${link})`
  // #936 — the operator View link is now UTM-tagged (query BEFORE the '#'); the per-user rewrite
  // re-tags the is-down link so per-user clicks attribute the same (discord/notification).
  const UTM = 'utm_source=discord&utm_medium=notification&utm_campaign=outage'
  const opLink = (id: string) => `https://ai-watch.dev/?${UTM}#${id}` // matches appendUtm(alert.url,'discord')

  it('rewrites the operator dashboard link to the tagged is-down page', () => {
    const out = toPerUserEntry(feedEntry({ svcIds: ['claude'], embed: { title: 't', description: desc(opLink('claude')), color: 1 } }))
    expect(out.embed.description).toContain(`[View on AIWatch](https://ai-watch.dev/is-claude-down?${UTM})`)
    expect(out.embed.description).not.toContain('ai-watch.dev/?' + UTM + '#claude')
  })

  it('uses the is-down slug for dash-dropped ids (claudecode → claude-code)', () => {
    const out = toPerUserEntry(feedEntry({ embed: { title: 't', description: desc(opLink('claudecode')), color: 1 } }))
    expect(out.embed.description).toContain(`https://ai-watch.dev/is-claude-code-down?${UTM}`)
  })

  it('also tolerates a BARE (untagged) dashboard link — regex robustness', () => {
    const out = toPerUserEntry(feedEntry({ svcIds: ['claude'], embed: { title: 't', description: desc('https://ai-watch.dev/#claude'), color: 1 } }))
    expect(out.embed.description).toContain(`https://ai-watch.dev/is-claude-down?${UTM}`)
  })

  it('keeps a tagged DASHBOARD link for a no-is-down-page service (azureopenai) — no-op, same entry ref', () => {
    const entry = feedEntry({ embed: { title: 't', description: desc(opLink('azureopenai')), color: 1 } })
    const out = toPerUserEntry(entry)
    expect(out).toBe(entry) // unchanged → same reference (azureopenai has no is-down page; already tagged)
    expect(out.embed.description).toContain(`https://ai-watch.dev/?${UTM}#azureopenai`)
  })

  it('preserves title/color and returns the same entry when there is no dashboard link', () => {
    const entry = feedEntry({ embed: { title: 'Title', description: 'no link here', color: 42 } })
    const out = toPerUserEntry(entry)
    expect(out).toBe(entry)
    expect(out.embed.title).toBe('Title')
    expect(out.embed.color).toBe(42)
  })

  // Pins the cross-file invariant: the rewrite must match the EXACT `[View on AIWatch](${appendUtm(alert.url,'discord')})`
  // markup index.ts emits. If the host/format ever drifts there, this breaks the build rather than
  // silently shipping the operator link to every general subscriber.
  it('rewrites the exact tagged "[View on AIWatch](…)" markup the operator embed emits (format pin)', () => {
    const operatorLink = `[View on AIWatch](${opLink('openai')})`
    const out = toPerUserEntry(feedEntry({ svcIds: ['openai'], embed: { title: 't', description: `🔴 Down\n${operatorLink}`, color: 1 } }))
    expect(out.embed.description).toContain(`[View on AIWatch](https://ai-watch.dev/is-openai-down?${UTM})`)
    expect(out.embed.description).not.toContain(operatorLink)
  })

  // The `/g` flag is load-bearing: a future description section could add a second dashboard link.
  it('rewrites EVERY dashboard link (global), each to its own tagged is-down page', () => {
    const out = toPerUserEntry(feedEntry({ svcIds: ['claude', 'openai'], embed: { title: 't', description: `${desc(opLink('claude'))}\nalso [b](${opLink('openai')})`, color: 1 } }))
    expect(out.embed.description).toContain(`https://ai-watch.dev/is-claude-down?${UTM}`)
    expect(out.embed.description).toContain(`https://ai-watch.dev/is-openai-down?${UTM}`)
    expect(out.embed.description).not.toContain('#claude')
    expect(out.embed.description).not.toContain('#openai')
  })

  // Mixed eligibility in one description: the per-link isDownUrl branch diverges within a single pass.
  it('rewrites an is-down-eligible service but leaves a tagged dashboard link for a no-page service', () => {
    const out = toPerUserEntry(feedEntry({ svcIds: ['claude', 'bedrock'], embed: { title: 't', description: `${desc(opLink('claude'))}\nalso [b](${opLink('bedrock')})`, color: 1 } }))
    expect(out.embed.description).toContain(`https://ai-watch.dev/is-claude-down?${UTM}`)
    expect(out.embed.description).toContain(`https://ai-watch.dev/?${UTM}#bedrock`) // no is-down page → tagged dashboard hash kept
    expect(out.embed.description).not.toContain('#claude')
  })

  it('is idempotent — a second pass over an already-rewritten entry is a no-op (same ref)', () => {
    const once = toPerUserEntry(feedEntry({ svcIds: ['claude'], embed: { title: 't', description: desc(opLink('claude')), color: 1 } }))
    const twice = toPerUserEntry(once)
    expect(twice).toBe(once)
    expect(twice.embed.description).toContain(`https://ai-watch.dev/is-claude-down?${UTM}`)
  })

  it('does not mutate the input entry (returns a copy)', () => {
    const entry = feedEntry({ svcIds: ['claude'], embed: { title: 't', description: desc(opLink('claude')), color: 1 } })
    toPerUserEntry(entry)
    expect(entry.embed.description).toContain(`?${UTM}#claude`) // original untouched
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
  it('#726 — delivers the per-user (is-down) link, not the operator dashboard link', async () => {
    const kv = makeKV()
    await seedSub(kv, URL_OK, FILTERS_ALL)
    const feed = [feedEntry({ svcIds: ['claude'], embed: { title: 't', description: '🔴 Down\n[View on AIWatch](https://ai-watch.dev/#claude)', color: 1 } })]
    let sentDesc = ''
    const post = vi.fn(async (_url: string, entry: AlertFeedEntry) => { sentDesc = entry.embed.description; return 204 })
    await deliverToSubscribers(kv, KEY, feed, post, 1)
    expect(sentDesc).toContain('https://ai-watch.dev/is-claude-down')
    expect(sentDesc).not.toContain('ai-watch.dev/#claude')
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
  it('#1011 — never delivers to or prunes webhook:sub:count:{date} snapshot keys', async () => {
    // Pre-fix these count keys leaked out of listConfirmedHashes into delivery, where readConfirmed
    // returned the bare count value → decrypt failed → deleteConfirmed PRUNED the snapshot (a
    // destructive side effect on the second consumer, not just a miscount).
    const kv = makeKV()
    await seedSub(kv, URL_OK, FILTERS_ALL) // 1 real subscriber
    for (let d = 8; d <= 14; d++) kv._store.set(`${SUB_PREFIX}count:2026-07-${d}`, '3')
    const post = vi.fn(async () => 204)
    const stats = await deliverToSubscribers(kv, KEY, [feedEntry({})], post, 1)
    expect(stats.delivered).toBe(1) // only the real sub
    expect(stats.pruned).toBe(0)    // count keys were never handed to delivery, so never pruned
    expect(post).toHaveBeenCalledTimes(1)
    for (let d = 8; d <= 14; d++) expect(kv._store.has(`${SUB_PREFIX}count:2026-07-${d}`)).toBe(true)
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

describe('computeSubscriberDelta (#548)', () => {
  it('returns the signed day-over-day delta against a prior snapshot', () => {
    expect(computeSubscriberDelta(15, '12')).toBe(3)   // growth
    expect(computeSubscriberDelta(10, '12')).toBe(-2)  // churn (signed, reported honestly)
    expect(computeSubscriberDelta(12, '12')).toBe(0)   // no change
  })
  it('returns null when there is no prior snapshot (first day / KV gap)', () => {
    expect(computeSubscriberDelta(15, null)).toBeNull()
  })
  it('returns null for a corrupt snapshot value rather than NaN', () => {
    expect(computeSubscriberDelta(15, 'oops')).toBeNull()
    expect(computeSubscriberDelta(15, '')).toBeNull()
  })
})

import { describe, it, expect, vi } from 'vitest'
import {
  parseInstallFilters,
  signState,
  verifyState,
  buildAuthorizeUrl,
  readCookie,
  stateCookie,
  randomToken,
  exchangeCode,
  completeInstall,
  resolveManageToken,
  manageSlack,
  buildWelcomeMessage,
  SLACK_ACCESS_URL,
  handleSlackOAuthRoute,
  handleSlackManageRequest,
} from '../slack'
import { discordToSlackMrkdwn, toSlackPayload, classifySlackDelivery, postSlackAlert } from '../slack-message'
import {
  deliverToSubscribers,
  listConfirmedSubs,
  listConfirmedHashes,
  countByType,
  readConfirmed,
  putConfirmed,
  unsubscribe,
  decryptUrl,
  encryptUrl,
  sha256Hex,
  SLACK_CHANNEL_PREFIX,
  SLACK_MANAGE_PREFIX,
  SUB_PREFIX,
  MAX_FAIL_COUNT,
  type SubscriptionFilters,
} from '../webhook-subscriptions'
import type { AlertFeedEntry } from '../alert-feed'

// A fetch stand-in for Slack's webhook endpoint. It builds a real Request, so a request the runtime
// would refuse (a GET with a body) throws here too, and it throws when called bound, as the Workers
// runtime does for its global fetch.
function slackFetch(status: number, body: string) {
  const calls: Array<[string, RequestInit]> = []
  const fn = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    if (this !== undefined) throw new TypeError('Illegal invocation')
    const req = new Request(input, init)
    calls.push([req.url, { ...init, method: req.method }])
    return Promise.resolve(new Response(body, { status }))
  }
  return Object.assign(fn as unknown as typeof fetch, { calls })
}

// In-memory KV with list metadata, which listConfirmedSubs reads the sub type from.
function makeKV() {
  const store = new Map<string, string>()
  const meta = new Map<string, unknown>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, opts?: { metadata?: unknown }) => {
      store.set(k, v)
      if (opts?.metadata !== undefined) meta.set(k, opts.metadata)
      else meta.delete(k)
    },
    delete: async (k: string) => { store.delete(k); meta.delete(k) },
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort().map((name) => ({ name, metadata: meta.get(name) })),
      list_complete: true,
    }),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> }
}

const KEY = 'b'.repeat(64)
const SECRET = 'slack-client-secret'
const HOOK_A = 'https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa'
const HOOK_B = 'https://hooks.slack.com/services/T0001/B0002/bbbbbbbbbbbbbbbbbbbbbbbb'
const FILTERS_ALL: SubscriptionFilters = { alertCondition: 'all', alertTarget: 'all', alertServices: [], alertIncidents: true }
const NOW = '2026-10-03T00:00:00.000Z'

function feedEntry(over: Partial<AlertFeedEntry> = {}): AlertFeedEntry {
  return { key: 'alerted:new:i1', kind: 'new', svcIds: ['claude'], embed: { title: 'Claude down', description: 'body', color: 0xff0000 }, ts: 1, ...over }
}

describe('parseInstallFilters', () => {
  it('scopes to the known services in ?services=', () => {
    const f = parseInstallFilters(new URLSearchParams('services=claude,openai,claude'))
    expect(f).toEqual({ alertCondition: 'all', alertTarget: 'custom', alertServices: ['claude', 'openai'], alertIncidents: true })
  })
  it('drops unknown ids and falls back to every service when none is left', () => {
    expect(parseInstallFilters(new URLSearchParams('services=nope,also-nope'))).toEqual(FILTERS_ALL)
    expect(parseInstallFilters(new URLSearchParams(''))).toEqual(FILTERS_ALL)
  })
  it('reads condition=down and incidents=0', () => {
    const f = parseInstallFilters(new URLSearchParams('condition=down&incidents=0'))
    expect(f.alertCondition).toBe('down')
    expect(f.alertIncidents).toBe(false)
  })
})

describe('signed OAuth state', () => {
  const filters = parseInstallFilters(new URLSearchParams('services=claude'))
  it('round-trips the filters when signature, expiry and cookie nonce all hold', async () => {
    const state = await signState('nonce-1', filters, 2_000, SECRET)
    expect(await verifyState(state, SECRET, 'nonce-1', 1_000)).toEqual(filters)
  })
  it('rejects an expired state', async () => {
    const state = await signState('nonce-1', filters, 2_000, SECRET)
    expect(await verifyState(state, SECRET, 'nonce-1', 2_001)).toBeNull()
  })
  it('rejects a state whose nonce is not the installer cookie, or with no cookie', async () => {
    const state = await signState('nonce-1', filters, 2_000, SECRET)
    expect(await verifyState(state, SECRET, 'nonce-2', 1_000)).toBeNull()
    expect(await verifyState(state, SECRET, null, 1_000)).toBeNull()
  })
  it('rejects a tampered body and a state signed with another secret', async () => {
    const state = await signState('nonce-1', filters, 2_000, SECRET)
    const [body, sig] = state.split('.')
    const forged = btoa(JSON.stringify({ n: 'nonce-1', f: FILTERS_ALL, e: 9_999 })).replace(/=+$/, '')
    expect(await verifyState(`${forged}.${sig}`, SECRET, 'nonce-1', 1_000)).toBeNull()
    expect(await verifyState(`${body}.${sig}`, 'other-secret', 'nonce-1', 1_000)).toBeNull()
    expect(await verifyState('garbage', SECRET, 'nonce-1', 1_000)).toBeNull()
  })
})

describe('authorize URL + cookie helpers', () => {
  it('requests only the incoming-webhook scope with the given redirect and state', () => {
    const u = new URL(buildAuthorizeUrl('cid', 'https://w.example/api/slack/oauth', 'st'))
    expect(u.origin + u.pathname).toBe('https://slack.com/oauth/v2/authorize')
    expect(u.searchParams.get('scope')).toBe('incoming-webhook')
    expect(u.searchParams.get('client_id')).toBe('cid')
    expect(u.searchParams.get('redirect_uri')).toBe('https://w.example/api/slack/oauth')
    expect(u.searchParams.get('state')).toBe('st')
  })
  it('reads the nonce back from a Cookie header', () => {
    expect(readCookie('a=1; aiwatch_slack_state=xyz; b=2', 'aiwatch_slack_state')).toBe('xyz')
    expect(readCookie('a=1', 'aiwatch_slack_state')).toBeNull()
    expect(readCookie(null, 'aiwatch_slack_state')).toBeNull()
  })
  it('sets an HttpOnly Secure Lax cookie scoped to /api/slack', () => {
    expect(stateCookie('n')).toBe('aiwatch_slack_state=n; Max-Age=600; Path=/api/slack; HttpOnly; Secure; SameSite=Lax')
  })
  it('makes 43-char base64url tokens', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomToken()).not.toBe(randomToken())
  })
})

describe('exchangeCode', () => {
  const okBody = { ok: true, team: { id: 'T0001' }, incoming_webhook: { url: HOOK_A, channel_id: 'C0001' } }
  it('posts the code with Basic auth and returns the webhook, team and channel', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(okBody)))
    const r = await exchangeCode(fetchFn as unknown as typeof fetch, 'cid', 'sec', 'code-1', 'https://w/cb')
    expect(r).toEqual({ ok: true, webhookUrl: HOOK_A, teamId: 'T0001', channelId: 'C0001' })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(SLACK_ACCESS_URL)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('cid:sec')}`)
    expect(init.body).toBe('code=code-1&redirect_uri=https%3A%2F%2Fw%2Fcb')
  })
  it('returns Slack\'s error string when ok is false', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ ok: false, error: 'invalid_code' }))
    expect(await exchangeCode(fetchFn as unknown as typeof fetch, 'c', 's', 'x', 'r')).toEqual({ ok: false, error: 'invalid_code' })
  })
  it('refuses a webhook URL that is not on hooks.slack.com', async () => {
    const body = { ...okBody, incoming_webhook: { url: 'https://evil.example/x', channel_id: 'C1' } }
    const fetchFn = async () => new Response(JSON.stringify(body))
    expect((await exchangeCode(fetchFn as unknown as typeof fetch, 'c', 's', 'x', 'r')).ok).toBe(false)
  })
  it('reports a network failure instead of throwing', async () => {
    const fetchFn = async () => { throw new Error('boom') }
    expect(await exchangeCode(fetchFn as unknown as typeof fetch, 'c', 's', 'x', 'r')).toEqual({ ok: false, error: 'boom' })
  })
})

describe('completeInstall', () => {
  const install = { webhookUrl: HOOK_A, teamId: 'T0001', channelId: 'C0001' }

  it('stores an encrypted Slack sub with both index keys, typed in list metadata', async () => {
    const kv = makeKV()
    const r = await completeInstall(kv, KEY, install, FILTERS_ALL, NOW)
    expect(r).not.toBeNull()
    const sub = await readConfirmed(kv, r!.hash)
    expect(sub?.type).toBe('slack')
    expect(await decryptUrl(sub!.encUrl, KEY)).toBe(HOOK_A)
    expect(r!.hash).toBe(await sha256Hex(HOOK_A))
    expect(kv._store.get(`${SLACK_MANAGE_PREFIX}${sub!.manageTokenHash}`)).toBe(r!.hash)
    expect(kv._store.get(`${SLACK_CHANNEL_PREFIX}${sub!.channelKey}`)).toBe(r!.hash)
    expect(await listConfirmedSubs(kv)).toEqual([{ hash: r!.hash, type: 'slack' }])
  })

  it('a reinstall to the same channel replaces the earlier sub and kills its manage link', async () => {
    const kv = makeKV()
    const first = await completeInstall(kv, KEY, install, FILTERS_ALL, NOW)
    const second = await completeInstall(kv, KEY, { ...install, webhookUrl: HOOK_B }, FILTERS_ALL, NOW)
    expect(await listConfirmedHashes(kv)).toEqual([second!.hash])
    expect(await resolveManageToken(kv, first!.manageToken)).toBeNull()
    expect((await resolveManageToken(kv, second!.manageToken))?.hash).toBe(second!.hash)
  })

  it('a different channel in the same workspace is a separate sub', async () => {
    const kv = makeKV()
    await completeInstall(kv, KEY, install, FILTERS_ALL, NOW)
    await completeInstall(kv, KEY, { webhookUrl: HOOK_B, teamId: 'T0001', channelId: 'C0002' }, FILTERS_ALL, NOW)
    expect((await listConfirmedHashes(kv)).length).toBe(2)
  })

  it('returns null when the store write fails', async () => {
    const kv = makeKV()
    kv.put = async () => { throw new Error('kv down') }
    expect(await completeInstall(kv, KEY, install, FILTERS_ALL, NOW)).toBeNull()
  })
})

describe('manage link', () => {
  async function installed() {
    const kv = makeKV()
    const r = await completeInstall(kv, KEY, { webhookUrl: HOOK_A, teamId: 'T1', channelId: 'C1' }, FILTERS_ALL, NOW)
    return { kv, ...r! }
  }

  it('get returns the stored filters', async () => {
    const { kv, manageToken } = await installed()
    expect(await manageSlack(kv, manageToken, 'get', undefined)).toEqual({ ok: true, filters: FILTERS_ALL })
  })

  it('update normalizes the filters and drops unknown service ids', async () => {
    const { kv, manageToken, hash } = await installed()
    const r = await manageSlack(kv, manageToken, 'update', { alertTarget: 'custom', alertServices: ['claude', 'bogus'], alertCondition: 'down', alertIncidents: false })
    expect(r).toEqual({ ok: true, filters: { alertTarget: 'custom', alertServices: ['claude'], alertCondition: 'down', alertIncidents: false } })
    expect((await readConfirmed(kv, hash))?.filters.alertServices).toEqual(['claude'])
    expect((await readConfirmed(kv, hash))?.type).toBe('slack')
  })

  it('unsubscribe deletes the sub and both index keys, after which the token is dead', async () => {
    const { kv, manageToken, hash } = await installed()
    expect(await manageSlack(kv, manageToken, 'unsubscribe', undefined)).toEqual({ ok: true })
    expect(await readConfirmed(kv, hash)).toBeNull()
    expect([...kv._store.keys()].filter((k) => k.startsWith('slack:'))).toEqual([])
    expect(await manageSlack(kv, manageToken, 'get', undefined)).toMatchObject({ ok: false, status: 404 })
  })

  it('rejects an unknown action, a malformed token and a wrong token', async () => {
    const { kv, manageToken } = await installed()
    expect(await manageSlack(kv, manageToken, 'drop-table', undefined)).toMatchObject({ ok: false, status: 400 })
    expect(await manageSlack(kv, 'short', 'get', undefined)).toMatchObject({ ok: false, status: 404 })
    expect(await manageSlack(kv, randomToken(), 'get', undefined)).toMatchObject({ ok: false, status: 404 })
  })

  it('the webhook URL hash is not a manage token', async () => {
    const { kv, hash } = await installed()
    expect(await resolveManageToken(kv, hash)).toBeNull()
  })

  it('the hash-only unsubscribe path also clears the Slack index keys', async () => {
    const { kv, hash, manageToken } = await installed()
    await unsubscribe(kv, hash)
    expect([...kv._store.keys()].filter((k) => k.startsWith('slack:'))).toEqual([])
    expect(await resolveManageToken(kv, manageToken)).toBeNull()
  })
})

describe('discordToSlackMrkdwn', () => {
  it('converts markdown links to Slack links', () => {
    expect(discordToSlackMrkdwn('[View on AIWatch](https://ai-watch.dev/is-claude-down?utm_source=slack&utm_medium=notification)'))
      .toBe('<https://ai-watch.dev/is-claude-down?utm_source=slack&utm_medium=notification|View on AIWatch>')
  })
  it('converts bold, italic and strikethrough', () => {
    expect(discordToSlackMrkdwn('**SUGGESTED FALLBACK** and *note* and ~~old~~')).toBe('*SUGGESTED FALLBACK* and _note_ and ~old~')
  })
  it('escapes &, < and > outside links', () => {
    expect(discordToSlackMrkdwn('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })
  it('leaves bullets and a lone asterisk alone', () => {
    expect(discordToSlackMrkdwn('• one\n• two\n5 * 3')).toBe('• one\n• two\n5 * 3')
  })
  it('replaces a | in a link label, which would end the Slack label early', () => {
    expect(discordToSlackMrkdwn('[a|b](https://e.x)')).toBe('<https://e.x|a¦b>')
  })
  it('keeps text on both sides of a link', () => {
    expect(discordToSlackMrkdwn('**A** [x](https://e.x/y) **B**')).toBe('*A* <https://e.x/y|x> *B*')
  })
})

describe('toSlackPayload', () => {
  it('puts the escaped title on top and the converted body in a colored attachment', () => {
    const p = toSlackPayload(feedEntry({ embed: { title: 'Claude <down>', description: '**x**', color: 0x00ff00 } }))
    expect(p.text).toBe('*Claude &lt;down&gt;*')
    expect(p.attachments[0]).toMatchObject({ color: '#00ff00', text: '*x*', mrkdwn_in: ['text'], footer: 'AIWatch' })
  })
})

describe('toSlackPayload — the is-down link stays out of the collapsible attachment', () => {
  const DIV = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈'
  const withView = (kind: AlertFeedEntry['kind']) => feedEntry({
    kind,
    embed: { title: '🔴 Claude API — New Incident', description: `Errors\n${DIV}\n**X**\n${DIV}\n[View on AIWatch](https://ai-watch.dev/is-claude-api-down?utm_source=slack)`, color: 1 },
  })

  it('links the title line to the View on AIWatch target, asks Slack to unfurl it, and drops that line from the body', () => {
    const p = toSlackPayload(withView('new'))
    expect(p.text).toBe('*<https://ai-watch.dev/is-claude-api-down?utm_source=slack|🔴 Claude API — New Incident>*')
    expect(p.unfurl_links).toBe(true)
    expect((p.attachments[0] as { text: string }).text).toBe(`Errors\n${DIV}\n*X*`)
  })

  it.each([
    ['resolved', 'resolved'],
    ['recovered', 'resolved'],
    ['withdrawn', 'withdrawn'],
    ['down', 'down'],
    ['degraded', 'degraded'],
  ] as const)('a %s alert pins the unfurled card with ?e=%s', (kind, hint) => {
    expect(toSlackPayload(withView(kind)).text).toContain(`?utm_source=slack&e=${hint}|`)
  })

  it('a description without that link gets an unlinked title, no unfurl, and an unchanged body', () => {
    const p = toSlackPayload(feedEntry({ embed: { title: 't', description: 'plain [other](https://e.x)', color: 1 } }))
    expect(p.text).toBe('*t*')
    expect(p).not.toHaveProperty('unfurl_links')
    expect((p.attachments[0] as { text: string }).text).toBe('plain <https://e.x|other>')
  })
})

describe('buildWelcomeMessage', () => {
  it('names the subscribed services and carries the manage link', () => {
    const f: SubscriptionFilters = { alertCondition: 'down', alertTarget: 'custom', alertServices: ['claude', 'openai'], alertIncidents: false }
    const { text } = buildWelcomeMessage(f, 'https://ai-watch.dev/slack/manage#t=TOKEN')
    expect(text).toContain('Services: Claude API, OpenAI API')
    expect(text).toContain('Status changes: outages only')
    expect(text).toContain('Incident updates: off')
    expect(text).toContain('<https://ai-watch.dev/slack/manage#t=TOKEN|Change services or unsubscribe>')
  })
  it('says every service for an unscoped install', () => {
    expect(buildWelcomeMessage(FILTERS_ALL, 'https://x').text).toContain('Services: every service AIWatch monitors')
  })
})

describe('classifySlackDelivery — measured (status, body) pairs, #1581 comment 2026-10-03', () => {
  it.each([
    [200, 'ok', 'success'],
    [400, 'invalid_payload', 'payload-error'],
    [404, 'no_active_hooks', 'prune'],
    [404, 'no_service', 'prune'],
    [404, 'no_team', 'prune'],
  ] as const)('%i %s → %s', (status, body, expected) => {
    expect(classifySlackDelivery(status, body)).toBe(expected)
  })
  it.each([
    [403, 'action_prohibited', 'prune'],
    [404, 'channel_not_found', 'prune'],
    [410, 'channel_is_archived', 'prune'],
    [500, 'rollup_error', 'retry'],
    [null, '', 'retry'],
    [404, 'something_new', 'retry'],
    [400, 'some_unlisted_code', 'retry'],
    [400, '<html>Bad Request</html>', 'retry'],
    [404, 'team_disabled', 'prune'],
    [403, 'invalid_token', 'prune'],
  ] as const)('documented/other: %s %s → %s', (status, body, expected) => {
    expect(classifySlackDelivery(status, body)).toBe(expected)
  })
})

describe('deliverToSubscribers with Slack subs', () => {
  const discordPost = vi.fn(async () => 200)

  it('posts a Slack sub through Slack with an is-down link tagged slack, never through the Discord poster', async () => {
    const kv = makeKV()
    await completeInstall(kv, KEY, { webhookUrl: HOOK_A, teamId: 'T1', channelId: 'C1' }, FILTERS_ALL, NOW)
    const fetchFn = slackFetch(200, 'ok')
    const entry = feedEntry({ embed: { title: 't', description: '┈┈\n[View on AIWatch](https://ai-watch.dev/#claude)', color: 1 } })
    const stats = await deliverToSubscribers(kv, KEY, [entry], discordPost, 0, fetchFn)
    expect(stats.delivered).toBe(1)
    expect(discordPost).not.toHaveBeenCalled()
    expect(fetchFn.calls[0][0]).toBe(HOOK_A)
    expect(JSON.parse(String(fetchFn.calls[0][1].body)).text).toContain('is-claude-api-down?utm_source=slack')
  })

  it('an invalid_payload keeps the sub and does not count toward the prune threshold', async () => {
    const kv = makeKV()
    const r = await completeInstall(kv, KEY, { webhookUrl: HOOK_A, teamId: 'T1', channelId: 'C1' }, FILTERS_ALL, NOW)
    for (let i = 0; i < MAX_FAIL_COUNT + 1; i++) {
      await deliverToSubscribers(kv, KEY, [feedEntry({ key: `alerted:new:i${i}` })], discordPost, 0, slackFetch(400, 'invalid_payload'))
    }
    const sub = await readConfirmed(kv, r!.hash)
    expect(sub).not.toBeNull()
    expect(sub!.failCount).toBe(0)
  })

  it('a network failure keeps the sub, counts one failure, and leaves the alert unmarked for retry', async () => {
    const kv = makeKV()
    const r = await completeInstall(kv, KEY, { webhookUrl: HOOK_A, teamId: 'T1', channelId: 'C1' }, FILTERS_ALL, NOW)
    const fetchFn = async () => { throw new Error('reset') }
    const stats = await deliverToSubscribers(kv, KEY, [feedEntry()], discordPost, 0, fetchFn as unknown as typeof fetch)
    expect(stats).toMatchObject({ delivered: 0, pruned: 0, failed: 1 })
    expect((await readConfirmed(kv, r!.hash))?.failCount).toBe(1)
    expect([...kv._store.keys()].some((k) => k.startsWith('webhook:sent:'))).toBe(false)
  })

  it('no_service prunes the sub together with its manage and channel keys', async () => {
    const kv = makeKV()
    const r = await completeInstall(kv, KEY, { webhookUrl: HOOK_A, teamId: 'T1', channelId: 'C1' }, FILTERS_ALL, NOW)
    const stats = await deliverToSubscribers(kv, KEY, [feedEntry()], discordPost, 0, slackFetch(404, 'no_service'))
    expect(stats.pruned).toBe(1)
    expect(await readConfirmed(kv, r!.hash)).toBeNull()
    expect([...kv._store.keys()].filter((k) => k.startsWith('slack:'))).toEqual([])
  })

  it('a Discord sub still goes through the Discord poster and prunes on its 404', async () => {
    const kv = makeKV()
    const hash = 'c'.repeat(64)
    await putConfirmed(kv, hash, { encUrl: await encryptUrl('https://discord.com/api/webhooks/1/x', KEY), filters: FILTERS_ALL, type: 'discord', registeredAt: NOW, failCount: 0 })
    const post = vi.fn(async () => 404)
    const fetchFn = slackFetch(200, 'ok')
    const stats = await deliverToSubscribers(kv, KEY, [feedEntry()], post, 0, fetchFn)
    expect(post).toHaveBeenCalledTimes(1)
    expect(fetchFn.calls).toEqual([])
    expect(stats.pruned).toBe(1)
  })
})

describe('typed subscriber counts', () => {
  it('a sub without type metadata counts as Discord', async () => {
    const kv = makeKV()
    kv._store.set(`${SUB_PREFIX}${'d'.repeat(64)}`, '{}')
    await completeInstall(kv, KEY, { webhookUrl: HOOK_A, teamId: 'T1', channelId: 'C1' }, FILTERS_ALL, NOW)
    expect(countByType(await listConfirmedSubs(kv))).toEqual({ discord: 1, slack: 1 })
  })
})

describe('guards without other coverage (#1581 review round 1)', () => {
  const install = { webhookUrl: HOOK_A, teamId: 'T1', channelId: 'C1' }

  it('a manage key whose row carries a different token hash does not resolve', async () => {
    const kv = makeKV()
    const r = await completeInstall(kv, KEY, install, FILTERS_ALL, NOW)
    const stale = randomToken()
    kv._store.set(`${SLACK_MANAGE_PREFIX}${await sha256Hex(stale)}`, r!.hash)
    expect(await resolveManageToken(kv, stale)).toBeNull()
  })

  it('a manage token never resolves to a Discord row', async () => {
    const kv = makeKV()
    const token = randomToken()
    const tokenHash = await sha256Hex(token)
    const hash = 'e'.repeat(64)
    await putConfirmed(kv, hash, { encUrl: 'x', filters: FILTERS_ALL, type: 'discord', registeredAt: NOW, failCount: 0, manageTokenHash: tokenHash })
    kv._store.set(`${SLACK_MANAGE_PREFIX}${tokenHash}`, hash)
    expect(await resolveManageToken(kv, token)).toBeNull()
  })

  it('a reinstall that returns the same webhook URL keeps the row it just wrote', async () => {
    const kv = makeKV()
    await completeInstall(kv, KEY, install, FILTERS_ALL, NOW)
    const again = await completeInstall(kv, KEY, install, FILTERS_ALL, NOW)
    expect(await readConfirmed(kv, again!.hash)).not.toBeNull()
    expect((await resolveManageToken(kv, again!.manageToken))?.hash).toBe(again!.hash)
  })

  it('the MAX_FAIL_COUNT prune clears the Slack index keys', async () => {
    const kv = makeKV()
    await completeInstall(kv, KEY, install, FILTERS_ALL, NOW)
    for (let i = 0; i < MAX_FAIL_COUNT; i++) {
      await deliverToSubscribers(kv, KEY, [feedEntry({ key: `alerted:new:r${i}` })], async () => 200, 0, slackFetch(500, 'rollup_error'))
    }
    expect([...kv._store.keys()]).toEqual([])
  })

  it('the undecryptable-row prune clears the Slack index keys', async () => {
    const kv = makeKV()
    await completeInstall(kv, KEY, install, FILTERS_ALL, NOW)
    await deliverToSubscribers(kv, 'f'.repeat(64), [feedEntry()], async () => 200, 0)
    expect([...kv._store.keys()]).toEqual([])
  })
})

describe('postSlackAlert', () => {
  it('posts the Slack payload, unbound, and returns the status with Slack\'s error string', async () => {
    const fetchFn = slackFetch(404, 'no_service')
    const entry = feedEntry()
    expect(await postSlackAlert(fetchFn, HOOK_A, entry)).toEqual({ status: 404, body: 'no_service' })
    expect(fetchFn.calls[0][0]).toBe(HOOK_A)
    expect(fetchFn.calls[0][1].method).toBe('POST')
    const sent = JSON.parse(String(fetchFn.calls[0][1].body))
    const expected = toSlackPayload(entry)
    expect(sent.text).toBe(expected.text)
    expect(sent.attachments[0].text).toBe((expected.attachments[0] as { text: string }).text)
  })
  it('never fetches a decrypted URL that is not a Slack webhook', async () => {
    const fetchFn = slackFetch(200, 'ok')
    expect(await postSlackAlert(fetchFn, 'https://evil.example/x', feedEntry())).toEqual({ status: 403, body: 'invalid_url' })
    expect(fetchFn.calls).toEqual([])
  })
  it('reports a network failure as a status-less response', async () => {
    const fetchFn = async () => { throw new Error('reset') }
    expect(await postSlackAlert(fetchFn as unknown as typeof fetch, HOOK_A, feedEntry())).toEqual({ status: null, body: '' })
  })
})

describe('handleSlackManageRequest', () => {
  const req = (body: unknown) => new Request('https://w.example/api/slack/manage', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })

  it('passes the token, action and filters through and answers with the stored filters', async () => {
    const kv = makeKV()
    const r = await completeInstall(kv, KEY, { webhookUrl: HOOK_A, teamId: 'T1', channelId: 'C1' }, FILTERS_ALL, NOW)
    const res = await handleSlackManageRequest(req({ token: r!.manageToken, action: 'update', filters: { alertTarget: 'custom', alertServices: ['openai'] } }), kv, { 'Access-Control-Allow-Origin': 'https://ai-watch.dev' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai-watch.dev')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(((await res.json()) as { filters: SubscriptionFilters }).filters.alertServices).toEqual(['openai'])
    expect((await readConfirmed(kv, r!.hash))?.filters.alertServices).toEqual(['openai'])
  })
  it('a wrong token is 404, a non-string token is 404, and a bad body is 500', async () => {
    const kv = makeKV()
    expect((await handleSlackManageRequest(req({ token: randomToken(), action: 'get' }), kv, {})).status).toBe(404)
    expect((await handleSlackManageRequest(req({ token: 42, action: 'get' }), kv, {})).status).toBe(404)
    expect((await handleSlackManageRequest(req('not json'), kv, {})).status).toBe(500)
  })
})

describe('handleSlackOAuthRoute', () => {
  const okExchange = { ok: true, team: { id: 'T1' }, incoming_webhook: { url: HOOK_A, channel_id: 'C1' } }

  function env(kv: KVNamespace, fetchFn: typeof fetch, over: Partial<Parameters<typeof handleSlackOAuthRoute>[1]> = {}) {
    return { kv, encKey: KEY, clientId: 'cid', clientSecret: SECRET, redirectUri: undefined, site: 'https://ai-watch.dev/', fetchFn, nowMs: 1_000_000, ...over }
  }

  async function startInstall(kv: KVNamespace, query = 'services=claude') {
    const res = await handleSlackOAuthRoute(new Request(`https://w.example/api/slack/install?${query}`), env(kv, fetch))
    const cookie = res.headers.get('Set-Cookie')!.split(';')[0]
    const state = new URL(res.headers.get('Location')!).searchParams.get('state')!
    return { res, cookie, state }
  }

  it('without credentials or an encryption key, redirects to the unavailable result', async () => {
    const kv = makeKV()
    for (const over of [{ clientId: undefined }, { clientSecret: undefined }, { encKey: 'short' }]) {
      const res = await handleSlackOAuthRoute(new Request('https://w.example/api/slack/install'), env(kv, fetch, over))
      expect(res.headers.get('Location')).toBe('https://ai-watch.dev/slack?result=unavailable')
    }
  })

  it('install redirects to Slack with this worker\'s callback and sets the nonce cookie', async () => {
    const { res, cookie } = await startInstall(makeKV())
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('Location')!)
    expect(loc.origin).toBe('https://slack.com')
    expect(loc.searchParams.get('redirect_uri')).toBe('https://w.example/api/slack/oauth')
    expect(cookie).toMatch(/^aiwatch_slack_state=[A-Za-z0-9_-]{43}$/)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('a completed callback stores the sub, posts the welcome message with the manage link, and clears the cookie', async () => {
    const kv = makeKV()
    const { cookie, state } = await startInstall(kv)
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      return req.url === SLACK_ACCESS_URL ? new Response(JSON.stringify(okExchange)) : new Response(req.method === 'POST' ? 'ok' : 'bad_method', { status: req.method === 'POST' ? 200 : 405 })
    })
    const res = await handleSlackOAuthRoute(
      new Request(`https://w.example/api/slack/oauth?code=c1&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie } }),
      env(kv, fetchFn as unknown as typeof fetch),
    )
    expect(res.headers.get('Location')).toBe('https://ai-watch.dev/slack?result=installed')
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const subs = await listConfirmedSubs(kv)
    expect(subs).toEqual([{ hash: await sha256Hex(HOOK_A), type: 'slack' }])
    expect((await readConfirmed(kv, subs[0].hash))?.filters.alertServices).toEqual(['claude'])
    const welcome = fetchFn.mock.calls.find((c) => String(c[0]) === HOOK_A) as unknown as [string, RequestInit]
    expect(welcome[1].method).toBe('POST')
    expect(String(welcome[1].body)).toContain('https://ai-watch.dev/slack/manage#t=')
  })

  it('calls the injected fetch unbound, as the Workers runtime requires for the global fetch', async () => {
    const kv = makeKV()
    const { cookie, state } = await startInstall(kv)
    const calls: string[] = []
    const fetchFn = function (this: unknown, input: RequestInfo | URL) {
      if (this !== undefined) throw new TypeError('Illegal invocation: function called with incorrect `this` reference')
      calls.push(String(input))
      return Promise.resolve(String(input) === SLACK_ACCESS_URL ? new Response(JSON.stringify(okExchange)) : new Response('ok'))
    }
    await handleSlackOAuthRoute(
      new Request(`https://w.example/api/slack/oauth?code=c1&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie } }),
      env(kv, fetchFn as unknown as typeof fetch),
    )
    expect(calls).toEqual([SLACK_ACCESS_URL, HOOK_A])
  })

  it('a denied consent redirects to the denied result without calling Slack', async () => {
    const fetchFn = vi.fn()
    const res = await handleSlackOAuthRoute(new Request('https://w.example/api/slack/oauth?error=access_denied'), env(makeKV(), fetchFn as unknown as typeof fetch))
    expect(res.headers.get('Location')).toBe('https://ai-watch.dev/slack?result=denied')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('a callback without the installer cookie is expired and never exchanges the code', async () => {
    const kv = makeKV()
    const { state } = await startInstall(kv)
    const fetchFn = vi.fn()
    const res = await handleSlackOAuthRoute(new Request(`https://w.example/api/slack/oauth?code=c1&state=${encodeURIComponent(state)}`), env(kv, fetchFn as unknown as typeof fetch))
    expect(res.headers.get('Location')).toBe('https://ai-watch.dev/slack?result=expired')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('a failed code exchange redirects to the error result and stores nothing', async () => {
    const kv = makeKV()
    const { cookie, state } = await startInstall(kv)
    const fetchFn = async () => new Response(JSON.stringify({ ok: false, error: 'invalid_code' }))
    const res = await handleSlackOAuthRoute(
      new Request(`https://w.example/api/slack/oauth?code=c1&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie } }),
      env(kv, fetchFn as unknown as typeof fetch),
    )
    expect(res.headers.get('Location')).toBe('https://ai-watch.dev/slack?result=error')
    expect(await listConfirmedSubs(kv)).toEqual([])
  })
})

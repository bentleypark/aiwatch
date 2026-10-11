import { describe, it, expect } from 'vitest'
import type { AlertCandidate } from '../alerts'
import {
  buildXReplyMarkMessage,
  buildXReplyMarkUrl,
  handleXReplyMarkRequest,
  verifyXReplyMark,
  XREPLY_PREFIX,
  XREPLY_TTL_S,
  xReplyMarkTarget,
} from '../x-reply-mark'

const SECRET = 'test-secret'
const NOW = Date.parse('2026-10-11T12:00:00Z')

function fakeKv() {
  const puts: { key: string; value: string; opts?: { expirationTtl?: number } }[] = []
  return {
    puts,
    kv: { put: async (key: string, value: string, opts?: { expirationTtl?: number }) => { puts.push({ key, value, opts }) } } as unknown as KVNamespace,
  }
}

const get = (url: string, ua = 'Mozilla/5.0 (iPhone)') => new Request(url, { headers: { 'User-Agent': ua } })

describe('x reply mark (#1653)', () => {
  it('records the mark a signed link carries, keyed by the incident', async () => {
    const { kv, puts } = fakeKv()
    const res = await handleXReplyMarkRequest(get(await buildXReplyMarkUrl(SECRET, 'inc1', 'claude', 'replied')), kv, SECRET, NOW)
    expect(res.status).toBe(200)
    expect(puts).toEqual([{
      key: `${XREPLY_PREFIX}inc1`,
      value: JSON.stringify({ mark: 'replied', svc: 'claude', at: '2026-10-11T12:00:00.000Z' }),
      opts: { expirationTtl: XREPLY_TTL_S },
    }])
  })

  it('records "nothing to reply to" as its own mark', async () => {
    const { kv, puts } = fakeKv()
    await handleXReplyMarkRequest(get(await buildXReplyMarkUrl(SECRET, 'inc1', 'claude', 'none')), kv, SECRET, NOW)
    expect(JSON.parse(puts[0].value).mark).toBe('none')
  })

  it('rejects a link whose mark, incident or service was changed after signing', async () => {
    const url = new URL(await buildXReplyMarkUrl(SECRET, 'inc1', 'claude', 'none'))
    for (const [k, v] of [['m', 'replied'], ['t', 'inc2'], ['s', 'openai']] as const) {
      const tampered = new URL(url)
      tampered.searchParams.set(k, v)
      const { kv, puts } = fakeKv()
      expect((await handleXReplyMarkRequest(get(tampered.toString()), kv, SECRET, NOW)).status).toBe(403)
      expect(puts).toEqual([])
    }
  })

  it('rejects a link signed with another secret', async () => {
    const { kv, puts } = fakeKv()
    const res = await handleXReplyMarkRequest(get(await buildXReplyMarkUrl('other', 'inc1', 'claude', 'replied')), kv, SECRET, NOW)
    expect(res.status).toBe(403)
    expect(puts).toEqual([])
  })

  it('does not record a link-preview fetch', async () => {
    const { kv, puts } = fakeKv()
    const url = await buildXReplyMarkUrl(SECRET, 'inc1', 'claude', 'replied')
    const res = await handleXReplyMarkRequest(get(url, 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'), kv, SECRET, NOW)
    expect(res.status).toBe(204)
    expect(puts).toEqual([])
  })

  it('says the mark was not recorded when the KV write fails, so the operator retries', async () => {
    const kv = { put: async () => { throw new Error('kv down') } } as unknown as KVNamespace
    const res = await handleXReplyMarkRequest(get(await buildXReplyMarkUrl(SECRET, 'inc1', 'claude', 'replied')), kv, SECRET, NOW)
    expect(res.status).toBe(500)
  })

  it('records nothing for a non-GET request', async () => {
    const { kv, puts } = fakeKv()
    const url = await buildXReplyMarkUrl(SECRET, 'inc1', 'claude', 'replied')
    const res = await handleXReplyMarkRequest(new Request(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } }), kv, SECRET, NOW)
    expect(res.status).toBe(405)
    expect(puts).toEqual([])
  })

  it('refuses when the signing secret is not configured', async () => {
    const { kv, puts } = fakeKv()
    const res = await handleXReplyMarkRequest(get(await buildXReplyMarkUrl(SECRET, 'inc1', 'claude', 'replied')), kv, undefined, NOW)
    expect(res.status).toBe(503)
    expect(puts).toEqual([])
  })

  it('rejects an unknown mark even before the signature check', async () => {
    const params = new URL(await buildXReplyMarkUrl(SECRET, 'inc1', 'claude', 'replied')).searchParams
    params.set('m', 'maybe')
    expect(await verifyXReplyMark(params, SECRET)).toBeNull()
  })

  it('targets only an incident-opening alert that carries a reply draft', () => {
    const reply = { serviceId: 'claude' }
    const alert = (key: string) => ({ key } as AlertCandidate)
    expect(xReplyMarkTarget(alert('alerted:new:inc1'), reply)).toEqual({ token: 'inc1', svc: 'claude' })
    expect(xReplyMarkTarget(alert('alerted:new:inc1'), null)).toBeNull()
    expect(xReplyMarkTarget(alert('alerted:res:inc1'), reply)).toBeNull()
    expect(xReplyMarkTarget(alert('alerted:down:claude'), reply)).toBeNull()
  })

  it('puts both signed links in one operator message', async () => {
    const msg = await buildXReplyMarkMessage(SECRET, 'inc1', 'claude')
    expect(msg).toContain(await buildXReplyMarkUrl(SECRET, 'inc1', 'claude', 'replied'))
    expect(msg).toContain(await buildXReplyMarkUrl(SECRET, 'inc1', 'claude', 'none'))
  })
})

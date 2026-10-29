import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { headerAddress, isMistralRootlyNotification, MISTRAL_WAKE_KEY } from '../mistral-email'
import workerModule from '../index'
import { mockKV } from './helpers/unreadable-source'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Header block of a captured .eml → Headers, with RFC 5322 folding undone. */
function headersOf(file: string): Headers {
  const raw = readFileSync(join(__dirname, 'fixtures', file), 'utf8')
  const block = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ')
  const h = new Headers()
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(':')
    h.append(line.slice(0, i), line.slice(i + 1).trim())
  }
  return h
}

const INVESTIGATING = 'mistral-rootly-investigating.eml'
const RESOLVED = 'mistral-rootly-resolved.eml'

function withHeader(file: string, name: string, value: string): Headers {
  const h = headersOf(file)
  h.set(name, value)
  return h
}

describe('isMistralRootlyNotification (#1510 Part B)', () => {
  it('accepts both captured notifications', () => {
    expect(isMistralRootlyNotification(headersOf(INVESTIGATING))).toBe(true)
    expect(isMistralRootlyNotification(headersOf(RESOLVED))).toBe(true)
  })

  it.each([
    ['another domain', 'Rootly <no-reply@rootly.com.evil.example>'],
    ['a look-alike domain', 'Rootly <no-reply@evilrootly.com>'],
    ['a subdomain', 'Rootly <no-reply@mail.rootly.com>'],
    ['a display name only claiming rootly', 'no-reply@rootly.com <attacker@evil.example>'],
    ['an empty From', ''],
  ])('rejects %s', (_label, from) => {
    expect(isMistralRootlyNotification(withHeader(INVESTIGATING, 'from', from))).toBe(false)
  })

  it('rejects a missing From', () => {
    const h = headersOf(INVESTIGATING)
    h.delete('from')
    expect(isMistralRootlyNotification(h)).toBe(false)
  })

  it('rejects a Rootly mail for another organisation', () => {
    expect(isMistralRootlyNotification(withHeader(INVESTIGATING, 'subject', 'Acme | Incident update: API down | Investigating'))).toBe(false)
  })
})

describe('headerAddress', () => {
  it.each([
    ['Rootly <No-Reply@Rootly.com>', 'no-reply@rootly.com'],
    ['no-reply@rootly.com', 'no-reply@rootly.com'],
    ['Rootly', null],
    [null, null],
  ])('%s → %s', (input, out) => {
    expect(headerAddress(input)).toBe(out)
  })
})

describe('worker email() handler (#1510 Part B, #1851)', () => {
  function message(headers: Headers, forward = vi.fn(async () => ({}))) {
    return { from: 'bounces@em8626.rootly.com', to: 'mistral-status@example.test', headers, forward, raw: new ReadableStream(), rawSize: 0, canBeForwarded: true, setReject: vi.fn(), reply: vi.fn() }
  }

  async function run(msg: ReturnType<typeof message>, env: Record<string, unknown>) {
    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {} }
    await workerModule.email(msg as unknown as ForwardableEmailMessage, env as never, ctx as unknown as ExecutionContext)
    await Promise.all(pending)
  }

  it('a notification sets the reader wake flag, dispatches nothing, and forwards the mail', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const kv = mockKV()
    const msg = message(headersOf(INVESTIGATING))
    await run(msg, { STATUS_CACHE: kv, GH_DISPATCH_TOKEN: 't', MISTRAL_EMAIL_FORWARD_TO: 'ops@example.test' })
    expect(kv.put).toHaveBeenCalledWith(MISTRAL_WAKE_KEY, '1', { expirationTtl: 3600 })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(msg.forward).toHaveBeenCalledWith('ops@example.test')
  })

  it('a resolved notification wakes the reader too', async () => {
    const kv = mockKV()
    await run(message(headersOf(RESOLVED)), { STATUS_CACHE: kv })
    expect(kv.put).toHaveBeenCalledWith(MISTRAL_WAKE_KEY, '1', { expirationTtl: 3600 })
  })

  it('a mail that is not a Mistral notification sets nothing and is still forwarded', async () => {
    const kv = mockKV()
    const msg = message(withHeader(INVESTIGATING, 'from', 'Rootly <no-reply@evil.example>'))
    await run(msg, { STATUS_CACHE: kv, MISTRAL_EMAIL_FORWARD_TO: 'ops@example.test' })
    expect(kv.put).not.toHaveBeenCalled()
    expect(msg.forward).toHaveBeenCalledWith('ops@example.test')
  })

  it('a failing wake write or forward does not throw', async () => {
    const kv = mockKV()
    kv.put.mockRejectedValueOnce(new Error('KV down'))
    const msg = message(headersOf(INVESTIGATING), vi.fn(async () => { throw new Error('destination not verified') }))
    await expect(run(msg, { STATUS_CACHE: kv, MISTRAL_EMAIL_FORWARD_TO: 'ops@example.test' })).resolves.toBeUndefined()
  })
})

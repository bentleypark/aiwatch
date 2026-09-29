import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { headerAddress, isMistralRootlyNotification } from '../mistral-email'
import { MISTRAL_EMAIL_DISPATCH_CONFIG, MISTRAL_DISPATCH_CONFIG } from '../workflow-dispatch'
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

describe('worker email() handler (#1510 Part B)', () => {
  const GH = 'https://api.github.com/repos/bentleypark/aiwatch/actions/workflows/mistral-feed.yml/dispatches'

  function stubFetch() {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === GH) return new Response(null, { status: 204 })
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchSpy)
    return fetchSpy
  }

  function message(headers: Headers, forward = vi.fn(async () => ({}))) {
    return { from: 'bounces@em8626.rootly.com', to: 'mistral-status@example.test', headers, forward, raw: new ReadableStream(), rawSize: 0, canBeForwarded: true, setReject: vi.fn(), reply: vi.fn() }
  }

  async function run(msg: ReturnType<typeof message>, env: Record<string, unknown>) {
    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {} }
    await workerModule.email(msg as unknown as ForwardableEmailMessage, env as never, ctx as unknown as ExecutionContext)
    await Promise.all(pending)
  }

  const dispatches = (spy: ReturnType<typeof stubFetch>) => spy.mock.calls.filter(([u]) => String(u) === GH).length

  it('a notification dispatches the scrape and forwards the mail', async () => {
    const fetchSpy = stubFetch()
    const kv = mockKV()
    const msg = message(headersOf(INVESTIGATING))
    await run(msg, { STATUS_CACHE: kv, GH_DISPATCH_TOKEN: 't', MISTRAL_EMAIL_FORWARD_TO: 'ops@example.test' })
    expect(dispatches(fetchSpy)).toBe(1)
    expect(kv.put).toHaveBeenCalledWith(MISTRAL_EMAIL_DISPATCH_CONFIG.cooldownKey, '1', { expirationTtl: 300 })
    expect(msg.forward).toHaveBeenCalledWith('ops@example.test')
  })

  it('dispatches even while the cron cooldown is running', async () => {
    const fetchSpy = stubFetch()
    const kv = mockKV({ [MISTRAL_DISPATCH_CONFIG.cooldownKey]: '1' })
    await run(message(headersOf(INVESTIGATING)), { STATUS_CACHE: kv, GH_DISPATCH_TOKEN: 't' })
    expect(dispatches(fetchSpy)).toBe(1)
  })

  it('a second mail inside the throttle does not dispatch again', async () => {
    const fetchSpy = stubFetch()
    const kv = mockKV()
    const env = { STATUS_CACHE: kv, GH_DISPATCH_TOKEN: 't' }
    await run(message(headersOf(INVESTIGATING)), env)
    await run(message(headersOf(RESOLVED)), env)
    expect(dispatches(fetchSpy)).toBe(1)
  })

  it('a mail that is not a Mistral notification dispatches nothing and is still forwarded', async () => {
    const fetchSpy = stubFetch()
    const kv = mockKV()
    const msg = message(withHeader(INVESTIGATING, 'from', 'Rootly <no-reply@evil.example>'))
    await run(msg, { STATUS_CACHE: kv, GH_DISPATCH_TOKEN: 't', MISTRAL_EMAIL_FORWARD_TO: 'ops@example.test' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(msg.forward).toHaveBeenCalledWith('ops@example.test')
  })

  it('a failing forward does not throw', async () => {
    stubFetch()
    const msg = message(headersOf(INVESTIGATING), vi.fn(async () => { throw new Error('destination not verified') }))
    await expect(run(msg, { STATUS_CACHE: mockKV(), GH_DISPATCH_TOKEN: 't', MISTRAL_EMAIL_FORWARD_TO: 'ops@example.test' })).resolves.toBeUndefined()
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PROBE_TARGETS } from '../../../worker/src/probe'
import {
  DEVICE_CHECK_READABLE, DEVICE_CHECK_UNREADABLE, DEVICE_CHECK_CLIENT_JS,
  deviceCheckTarget, deviceCheckConnectSrc, renderDeviceCheck,
  deviceCheckGroupTargets, deviceCheckGroupConnectSrc, renderDeviceCheckGroup,
} from '../device-check'
import { FAMILY_GROUPS, SERVICE_ID_TO_SLUG, SLUG_TO_SERVICE } from '../../_is-down/slug-map'

// #2009 — which providers a visitor's browser can read, the page block, and the shipped click handler.

interface Outcome { kind: 'http' | 'timeout' | 'error'; status?: number; host: string; ms: number; preflight?: boolean }
interface Client {
  deviceCheckLine: (o: Outcome) => string
  deviceCheckClass: (o: Outcome) => string
  runDeviceCheck: (btn: Element) => void
  closeDeviceCheck: (btn: Element) => void
}

function loadClient(): Client {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${DEVICE_CHECK_CLIENT_JS}\nreturn { deviceCheckLine: deviceCheckLine, deviceCheckClass: deviceCheckClass, runDeviceCheck: runDeviceCheck, closeDeviceCheck: closeDeviceCheck };`)() as Client
}

describe('readable / unreadable partition', () => {
  const probeIds = PROBE_TARGETS.map((t) => t.id)

  it('covers every probe target exactly once, so a new target forces a decision', () => {
    const readable = Object.keys(DEVICE_CHECK_READABLE)
    expect([...readable, ...DEVICE_CHECK_UNREADABLE].sort()).toEqual([...probeIds].sort())
    expect(readable.filter((id) => DEVICE_CHECK_UNREADABLE.includes(id))).toEqual([])
  })

  it('every readable target is a plain https origin path and only Claude carries a request header', () => {
    for (const id of Object.keys(DEVICE_CHECK_READABLE)) {
      const t = deviceCheckTarget(id)!
      expect(t, id).not.toBeNull()
      expect(new URL(t.url).protocol, id).toBe('https:')
      expect(t.origin, id).toBe(`https://${t.host}`)
      expect(`${t.url}${t.host}`, id).not.toMatch(/["'<>&\s]/)
    }
    const withHeader = Object.entries(DEVICE_CHECK_READABLE).filter(([, s]) => s.header).map(([id]) => id)
    expect(withHeader).toEqual(['claude'])
    expect(deviceCheckTarget('claude')!.header).toBe('anthropic-dangerous-direct-browser-access:true')
  })
})

describe('deviceCheckTarget / deviceCheckConnectSrc', () => {
  it('never borrows another service\'s endpoint — Codex signed in with ChatGPT does not call api.openai.com', () => {
    for (const id of ['claudecode', 'codex']) {
      expect(deviceCheckTarget(id), id).toBeNull()
      expect(renderDeviceCheck(id), id).toBe('')
    }
  })

  it('is null for an unreadable provider and for an id with no probe', () => {
    expect(deviceCheckTarget('replicate')).toBeNull()
    expect(deviceCheckTarget('cursor')).toBeNull()
    expect(deviceCheckTarget('chatgpt')).toBeNull()
  })

  it('asks the page CSP for exactly one origin, or none', () => {
    expect(deviceCheckConnectSrc('openai')).toEqual(['https://api.openai.com'])
    expect(deviceCheckConnectSrc('replicate')).toEqual([])
  })
})

describe('renderDeviceCheck', () => {
  it('renders nothing for an unreadable provider', () => {
    expect(renderDeviceCheck('replicate')).toBe('')
    expect(renderDeviceCheck('chatgpt')).toBe('')
  })

  it('renders the button, the target and the click wiring for a readable one', () => {
    const html = renderDeviceCheck('openai')
    expect(html).toContain('data-url="https://api.openai.com/v1/models"')
    expect(html).toContain('data-action="device-check"')
    expect(html).toContain('data-ga="click_device_check"')
    expect(html).toContain('data-ga-svc="openai"')
    expect(html).not.toContain('data-hdr=')
    expect(html).toContain(`<script>${DEVICE_CHECK_CLIENT_JS}`)
  })

  it('renders the answer and note elements empty, with the note text carried in data-note', () => {
    const html = renderDeviceCheck('openai')
    expect(html).toMatch(/<p data-device-out aria-live="polite"><\/p>/)
    expect(html).toMatch(/<p class="dc-note" data-device-note><\/p>/)
    expect(html).toContain('data-note="The request goes straight from your browser, not through AIWatch."')
  })

  it('labels the button like the report button: a hidden icon, then two words', () => {
    expect(renderDeviceCheck('openai')).toContain('><span aria-hidden="true">🌐</span> <span data-device-label>Check connection</span></button>')
  })

  it('carries the Claude request header on the block', () => {
    expect(renderDeviceCheck('claude')).toContain('data-hdr="anthropic-dangerous-direct-browser-access:true"')
  })

  it('does not promise a request count — a header makes the browser add a preflight', () => {
    for (const id of ['claude', 'openai']) expect(renderDeviceCheck(id)).not.toMatch(/one request|single request/i)
  })
})

describe('deviceCheckLine / deviceCheckClass', () => {
  const c = loadClient()
  const base = { host: 'api.openai.com', ms: 182 }

  it.each([
    [{ kind: 'http', status: 200 }, 'ok', 'Your connection reached api.openai.com. It replied in 182 ms (HTTP 200).'],
    [{ kind: 'http', status: 401 }, 'ok', 'Your connection reached api.openai.com. It replied in 182 ms (HTTP 401).'],
    [{ kind: 'http', status: 403 }, 'ok', 'Your connection reached api.openai.com. It replied in 182 ms (HTTP 403).'],
    [{ kind: 'http', status: 429 }, 'ok', 'Your connection reached api.openai.com. It replied in 182 ms (HTTP 429).'],
    [{ kind: 'http', status: 503 }, 'server_error', 'Your connection reached api.openai.com, but the provider answered with an error (HTTP 503) after 182 ms.'],
    [{ kind: 'http', status: 401, preflight: true }, 'ok', 'Your connection reached api.openai.com. It replied in 182 ms, which may include a browser permission check (HTTP 401).'],
    [{ kind: 'http', status: 500, preflight: true }, 'server_error', 'Your connection reached api.openai.com, but the provider answered with an error (HTTP 500) after 182 ms, which may include a browser permission check.'],
    [{ kind: 'timeout' }, 'timeout', 'No reply from api.openai.com within 8 seconds. Your network, a VPN or firewall, or the provider itself could be the cause. This test cannot tell which.'],
    [{ kind: 'error' }, 'error', 'Could not reach api.openai.com. Your network, a VPN, ad blocker or firewall, the provider being down, or the provider not accepting requests from a browser could each cause this. This test cannot tell which.'],
  ] as Array<[Partial<Outcome>, string, string]>)('%j → %s', (o, cls, line) => {
    const full = { ...base, ...o } as Outcome
    expect(c.deviceCheckLine(full)).toBe(line)
    expect(c.deviceCheckClass(full)).toBe(cls)
  })

  it('never draws a verdict about who is at fault', () => {
    const outcomes = [200, 401, 403, 404, 429, 503].map((status) => ({ kind: 'http', status })).concat([{ kind: 'timeout' }, { kind: 'error' }] as never[]) as Array<Partial<Outcome>>
    for (const o of outcomes) {
      expect(c.deviceCheckLine({ ...base, ...o } as Outcome)).not.toMatch(/just you|your fault|is down|is up|working|normal|expected|should see|no API key/i)
    }
  })
})

describe('a click on a rendered button reaches the check through the block\'s own script', () => {
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

  it('click → runDeviceCheck → one fetch to the probe URL, with no page dispatcher present', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 401, body: null })
    vi.stubGlobal('fetch', fetchMock)
    const inline = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    const block = renderDeviceCheck('openai')
    document.body.innerHTML = block.replace(/<script>[\s\S]*<\/script>/, '')
    const scripts = inline(block)
    expect(scripts).toHaveLength(1)
    ;(0, eval)(scripts[0])

    document.querySelector('button')!.click()
    await Promise.resolve()

    expect(fetchMock.mock.calls.filter(([u]) => u === 'https://api.openai.com/v1/models')).toHaveLength(1)
  })

  it('the close button on the rendered card empties it', () => {
    const block = renderDeviceCheck('openai')
    document.body.innerHTML = block.replace(/<script>[\s\S]*<\/script>/, '')
    ;(0, eval)([...block.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1])
    const out = document.querySelector('[data-device-out]')!
    out.textContent = 'Your connection reached api.openai.com.'

    ;(document.querySelector('[data-action="device-check-close"]') as HTMLButtonElement).click()

    expect(out.textContent).toBe('')
  })
})

describe('family pages', () => {
  const nameOf = (id: string) => SLUG_TO_SERVICE[SERVICE_ID_TO_SLUG[id]]?.name ?? id
  const members = (family: string) => FAMILY_GROUPS[family].members.map((id) => ({ id, name: nameOf(id) }))

  it.each([
    ['claude', 'api.anthropic.com', 'claude'],
    ['openai', 'api.openai.com', 'openai'],
    ['xai', 'api.x.ai', 'xai'],
  ])('%s has exactly one testable host, %s', (family, host, id) => {
    const entries = deviceCheckGroupTargets(members(family))
    expect(entries).toHaveLength(1)
    expect(entries[0].target.host).toBe(host)
    expect(entries[0].svcId).toBe(id)
    expect(entries[0].name).toBe(nameOf(id))
    expect(deviceCheckGroupConnectSrc(members(family))).toEqual([`https://${host}`])
  })

  it('says only whose address it is and that it is not a website, never what other products call', () => {
    expect(renderDeviceCheckGroup(members('claude'))).toContain('data-note="api.anthropic.com is the address of Claude API (not a website). The request goes straight from your browser, not through AIWatch."')
    expect(renderDeviceCheckGroup(members('openai'))).toContain('data-note="api.openai.com is the address of OpenAI API (not a website). The request goes straight from your browser, not through AIWatch."')
    expect(renderDeviceCheckGroup(members('xai'))).toContain('data-note="api.x.ai is the address of SpaceXSI API (not a website). The request goes straight from your browser, not through AIWatch."')
    for (const family of Object.keys(FAMILY_GROUPS)) {
      expect(renderDeviceCheckGroup(members(family)), family).not.toMatch(/does not test|Claude Code|Codex|ChatGPT|claude\.ai|Grok|Cursor/)
    }
  })

  it('renders one block per family page and no script of its own, counted as a group-page click', () => {
    for (const family of Object.keys(FAMILY_GROUPS)) {
      const html = renderDeviceCheckGroup(members(family))
      expect(html.match(/data-device-check /g)).toHaveLength(1)
      expect(html).not.toContain('<script')
      expect(html).toContain('data-ga-loc="is_down_group_page"')
      expect(html).toContain('data-action="device-check"')
    }
  })

  it('renders nothing when no member has a readable host', () => {
    expect(renderDeviceCheckGroup([])).toBe('')
    expect(renderDeviceCheckGroup([{ id: 'claudeai', name: 'claude.ai' }])).toBe('')
    expect(deviceCheckGroupConnectSrc([{ id: 'cursor', name: 'Cursor' }])).toEqual([])
  })
})

describe('runDeviceCheck', () => {
  const c = loadClient()
  let fetchMock: ReturnType<typeof vi.fn>

  function mount(svc: string): { btn: HTMLButtonElement; out: Element } {
    document.body.innerHTML = renderDeviceCheck(svc).replace(/<script>[\s\S]*<\/script>/, '')
    return { btn: document.querySelector('button')!, out: document.querySelector('[data-device-out]')! }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('makes one credential-less cross-origin GET to the probe URL and prints the answer', async () => {
    const cancel = vi.fn()
    fetchMock.mockResolvedValue({ status: 401, body: { cancel } })
    const { btn, out } = mount('openai')
    const text = btn.querySelector('[data-device-label]')!
    const icon = btn.querySelector('[aria-hidden="true"]')!
    expect(text.textContent).toBe('Check connection')

    c.runDeviceCheck(btn)
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    expect(text.textContent).toBe('Checking…')
    expect(icon.textContent).toBe('🌐')
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/models')
    expect(init).toMatchObject({ method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: {} })
    expect(cancel).toHaveBeenCalled()
    expect(out.textContent).toMatch(/^Your connection reached api\.openai\.com\. It replied in \d+ ms \(HTTP 401\)\./)
    expect(btn.hasAttribute('aria-disabled')).toBe(false)
    expect(text.textContent).toBe('Check connection')
    expect(icon.textContent).toBe('🌐')
  })

  it('fills the note only together with the answer', async () => {
    fetchMock.mockResolvedValue({ status: 401, body: null })
    const { btn } = mount('openai')
    const note = document.querySelector('[data-device-note]')!
    expect(note.textContent).toBe('')
    c.runDeviceCheck(btn)
    await vi.advanceTimersByTimeAsync(0)
    expect(note.textContent).toBe('The request goes straight from your browser, not through AIWatch.')
  })

  it('closing the card empties it and puts focus back on the button', async () => {
    fetchMock.mockResolvedValue({ status: 401, body: null })
    const { btn, out } = mount('openai')
    c.runDeviceCheck(btn)
    await vi.advanceTimersByTimeAsync(0)
    expect(out.textContent).not.toBe('')
    const close = document.querySelector('[data-action="device-check-close"]') as HTMLButtonElement
    c.closeDeviceCheck(close)
    expect(out.textContent).toBe('')
    expect(document.querySelector('[data-device-note]')!.textContent).toBe('')
    expect(document.activeElement).toBe(btn)
  })

  it('sends the Claude request header and says the time may include a preflight', async () => {
    fetchMock.mockResolvedValue({ status: 401, body: null })
    const { btn, out } = mount('claude')
    c.runDeviceCheck(btn)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'anthropic-dangerous-direct-browser-access': 'true' })
    expect(out.textContent).toContain('which may include a browser permission check')
  })

  it('reports a rejected request as no answer, not as an outage', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const { btn, out } = mount('openai')
    c.runDeviceCheck(btn)
    await vi.advanceTimersByTimeAsync(0)
    expect(out.textContent).toMatch(/^Could not reach api\.openai\.com\./)
  })

  it('gives up after 8 s and says so', async () => {
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    }))
    const { btn, out } = mount('openai')
    c.runDeviceCheck(btn)
    await vi.advanceTimersByTimeAsync(7999)
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    await vi.advanceTimersByTimeAsync(1)
    expect(out.textContent).toMatch(/^No reply from api\.openai\.com within 8 seconds\./)
    expect(btn.hasAttribute('aria-disabled')).toBe(false)
  })

  it('ignores a second click while a check is running', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    const { btn } = mount('openai')
    c.runDeviceCheck(btn)
    c.runDeviceCheck(btn)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a non-https target', () => {
    const { btn } = mount('openai')
    document.querySelector('[data-device-check]')!.setAttribute('data-url', 'http://api.openai.com/v1/models')
    c.runDeviceCheck(btn)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports the outcome class to gtag when present', async () => {
    const gtag = vi.fn()
    vi.stubGlobal('gtag', gtag)
    fetchMock.mockResolvedValue({ status: 503, body: null })
    const { btn } = mount('openai')
    c.runDeviceCheck(btn)
    await vi.advanceTimersByTimeAsync(0)
    expect(gtag).toHaveBeenCalledWith('event', 'device_check_result', { service_id: 'openai', outcome: 'server_error' })
  })
})

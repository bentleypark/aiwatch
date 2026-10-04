import { describe, it, expect, vi, afterEach } from 'vitest'
import handler, { renderManage, renderResult } from '../slack-alerts'

const TOKEN = 'a'.repeat(43)
const API = 'https://aiwatch-worker.p2c2kbf.workers.dev/api/slack/manage'

describe('/slack result page', () => {
  it.each(['installed', 'denied', 'expired', 'error', 'unavailable'])('renders the %s result', async (result) => {
    const res = await handler(new Request(`https://ai-watch.dev/api/slack-alerts?result=${result}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy')).toContain("script-src 'self' 'nonce-")
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(await res.text()).toContain('<meta name="robots" content="noindex">')
  })
  it('offers a retry only when the install did not succeed', () => {
    expect(renderResult('installed', 'n')).not.toContain('Add to Slack again')
    expect(renderResult('denied', 'n')).toContain('href="https://aiwatch-worker.p2c2kbf.workers.dev/api/slack/install">Add to Slack again')
  })
  it('an unknown result renders the error state, never the raw value', () => {
    const html = renderResult('<script>x</script>', 'n')
    expect(html).toContain('The Slack install did not finish')
    expect(html).not.toContain('<script>x</script>')
  })
})

describe('/slack/manage', () => {
  it('serves the manage view, which talks to the production worker', async () => {
    const res = await handler(new Request('https://ai-watch.dev/api/slack-alerts?view=manage'))
    const html = await res.text()
    expect(html).toContain('Slack alert settings')
    expect(html).toContain('"https://aiwatch-worker.p2c2kbf.workers.dev/api/slack/manage"')
  })

  describe('in a browser', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
      document.body.innerHTML = ''
    })

    function boot(hash: string, responses: Array<{ status: number; body: unknown }>) {
      const html = renderManage('n')
      document.body.innerHTML = html.slice(html.indexOf('<main'), html.indexOf('</main>') + 7)
      const fetchMock = vi.fn(async () => {
        const r = responses.shift()!
        return new Response(JSON.stringify(r.body), { status: r.status })
      })
      vi.stubGlobal('fetch', fetchMock)
      vi.stubGlobal('location', { hash })
      const script = html.slice(html.indexOf('<script nonce="n">') + '<script nonce="n">'.length, html.lastIndexOf('</script>'))
      new Function(script)()
      return fetchMock
    }

    const filters = { alertTarget: 'custom', alertServices: ['claude'], alertCondition: 'down', alertIncidents: false }
    const services = [{ id: 'claude', name: 'Claude API' }, { id: 'openai', name: 'OpenAI API' }, { id: 'bedrock', name: 'Amazon Bedrock' }]

    it('reads the token from the fragment, loads the filters, and renders them', async () => {
      const fetchMock = boot(`#t=${TOKEN}`, [{ status: 200, body: { ok: true, filters, services } }])
      await vi.waitFor(() => expect((document.getElementById('form') as HTMLFormElement).hidden).toBe(false))
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe(API)
      expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN, action: 'get' })
      expect((document.querySelector('input[value="claude"]') as HTMLInputElement).checked).toBe(true)
      expect((document.querySelector('input[name="target"][value="custom"]') as HTMLInputElement).checked).toBe(true)
      expect((document.querySelector('input[name="condition"][value="down"]') as HTMLInputElement).checked).toBe(true)
      expect((document.getElementById('incidents') as HTMLInputElement).checked).toBe(false)
      expect([...document.querySelectorAll('#svcs label')].map((l) => l.textContent!.trim())).toEqual(['Claude API', 'OpenAI API', 'Amazon Bedrock'])
      expect(document.querySelectorAll('#svcs h3')).toHaveLength(0)
    })

    it('saves the edited filters', async () => {
      const fetchMock = boot(`#t=${TOKEN}`, [{ status: 200, body: { ok: true, filters, services } }, { status: 200, body: { ok: true } }])
      await vi.waitFor(() => expect((document.getElementById('form') as HTMLFormElement).hidden).toBe(false))
      ;(document.querySelector('input[value="openai"]') as HTMLInputElement).checked = true
      ;(document.getElementById('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }))
      await vi.waitFor(() => expect(document.getElementById('msg')!.textContent).toBe('✓ Saved.'))
      const body = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))
      expect(body).toEqual({ token: TOKEN, action: 'update', filters: { alertTarget: 'custom', alertServices: ['claude', 'openai'], alertCondition: 'down', alertIncidents: false } })
    })

    it('groups the services under their category headings', async () => {
      const grouped = [
        { id: 'claude', name: 'Claude API', group: 'LLM APIs' },
        { id: 'openai', name: 'OpenAI API', group: 'LLM APIs' },
        { id: 'cursor', name: 'Cursor', group: 'Coding Agents' },
      ]
      boot(`#t=${TOKEN}`, [{ status: 200, body: { ok: true, filters, services: grouped } }])
      await vi.waitFor(() => expect((document.getElementById('form') as HTMLFormElement).hidden).toBe(false))
      expect([...document.getElementById('svcs')!.children].map((el) => `${el.tagName}:${el.textContent!.trim()}`))
        .toEqual(['H3:LLM APIs', 'LABEL:Claude API', 'LABEL:OpenAI API', 'H3:Coding Agents', 'LABEL:Cursor'])
    })

    it('a stored service that is no longer listed sits under its own heading', async () => {
      const grouped = [{ id: 'claude', name: 'Claude API', group: 'LLM APIs' }, { id: 'chatgpt', name: 'ChatGPT', group: 'AI Apps' }]
      boot(`#t=${TOKEN}`, [{ status: 200, body: { ok: true, filters: { ...filters, alertServices: ['claude', 'retiredsvc'] }, services: grouped } }])
      await vi.waitFor(() => expect((document.getElementById('form') as HTMLFormElement).hidden).toBe(false))
      expect([...document.getElementById('svcs')!.children].map((el) => `${el.tagName}:${el.textContent!.trim()}`))
        .toEqual(['H3:LLM APIs', 'LABEL:Claude API', 'H3:AI Apps', 'LABEL:ChatGPT', 'H3:Other', 'LABEL:retiredsvc'])
    })

    it('picking a service on an every-service channel saves just that service', async () => {
      const all = { alertTarget: 'all', alertServices: [], alertCondition: 'all', alertIncidents: true }
      const fetchMock = boot(`#t=${TOKEN}`, [{ status: 200, body: { ok: true, filters: all, services } }, { status: 200, body: { ok: true } }])
      await vi.waitFor(() => expect((document.getElementById('form') as HTMLFormElement).hidden).toBe(false))
      ;(document.querySelector('input[value="openai"]') as HTMLInputElement).click()
      expect((document.querySelector('input[name="target"][value="custom"]') as HTMLInputElement).checked).toBe(true)
      ;(document.getElementById('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }))
      await vi.waitFor(() => expect(document.getElementById('msg')!.textContent).toBe('✓ Saved.'))
      const body = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))
      expect(body.filters).toEqual({ alertTarget: 'custom', alertServices: ['openai'], alertCondition: 'all', alertIncidents: true })
    })

    it('passing through every service and back keeps the picked services', async () => {
      boot(`#t=${TOKEN}`, [{ status: 200, body: { ok: true, filters, services } }])
      await vi.waitFor(() => expect((document.getElementById('form') as HTMLFormElement).hidden).toBe(false))
      ;(document.querySelector('input[name="target"][value="all"]') as HTMLInputElement).click()
      ;(document.querySelector('input[name="target"][value="custom"]') as HTMLInputElement).click()
      expect([...document.querySelectorAll<HTMLInputElement>('#svcs input:checked')].map((b) => b.value)).toEqual(['claude'])
    })

    it('refuses to save "only these" with no service picked, and calls nothing', async () => {
      const fetchMock = boot(`#t=${TOKEN}`, [{ status: 200, body: { ok: true, filters, services } }])
      await vi.waitFor(() => expect((document.getElementById('form') as HTMLFormElement).hidden).toBe(false))
      ;(document.querySelector('input[value="claude"]') as HTMLInputElement).checked = false
      ;(document.getElementById('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }))
      expect(document.getElementById('msg')!.textContent).toBe('Pick at least one service, or choose every service.')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('unsubscribes after confirmation', async () => {
      vi.stubGlobal('confirm', () => true)
      const fetchMock = boot(`#t=${TOKEN}`, [{ status: 200, body: { ok: true, filters, services } }, { status: 200, body: { ok: true } }])
      await vi.waitFor(() => expect((document.getElementById('form') as HTMLFormElement).hidden).toBe(false))
      ;(document.getElementById('unsub') as HTMLButtonElement).click()
      await vi.waitFor(() => expect(document.getElementById('status')!.textContent).toContain('Unsubscribed'))
      expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)).action).toBe('unsubscribe')
    })

    it('a missing token never calls the worker', () => {
      const fetchMock = boot('', [])
      expect(fetchMock).not.toHaveBeenCalled()
      expect(document.getElementById('status')!.textContent).toContain('This link is incomplete')
    })

    it('an unknown or removed subscription says so', async () => {
      boot(`#t=${TOKEN}`, [{ status: 404, body: { error: 'Subscription not found' } }])
      await vi.waitFor(() => expect(document.getElementById('status')!.textContent).toContain('no longer subscribed'))
    })
  })
})

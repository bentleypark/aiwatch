// #1959 — the "Affected now" block: the incident banner and the incident-ordered list in one container.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement, act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import en from '../../locales/en'
import { formatDate } from '../../utils/time'

const trackEvent = vi.fn()
const setPage = vi.fn()
beforeEach(() => { trackEvent.mockClear(); setPage.mockClear() })

const inc = (id, title, status = 'investigating', startedAt = new Date(Date.now() - 3_600_000).toISOString()) =>
  ({ id, title, status, impact: 'major', startedAt, resolvedAt: null, duration: null, timeline: [] })
const svc = (id, name, provider, category, status, incidents, extra = {}) =>
  ({ id, name, provider, category, status, latency: 100, uptime30d: 99.5, incidents, ...extra })

const SERVICES = [
  svc('openai', 'OpenAI API', 'OpenAI', 'api', 'degraded', [inc('o-1', 'OpenAI latency')]),
  svc('chatgpt', 'ChatGPT', 'OpenAI', 'app', 'degraded', [inc('c-1', 'ChatGPT image errors')]),
  svc('claude', 'Claude API', 'Anthropic', 'api', 'down', [inc('a-1', 'Anthropic outage')]),
  svc('cohere', 'Cohere API', 'Cohere', 'api', 'operational', [], { aiwatchScore: 90 }),
]
const ALL = ['openai', 'chatgpt', 'claude', 'cohere']
const WITH_QUIET = [
  ...SERVICES,
  svc('groq', 'GroqCloud', 'Groq', 'api', 'operational', [inc('g-1', 'Groq notice')]),
  svc('mistral', 'Mistral API', 'Mistral', 'api', 'operational', [inc('m-1', 'Mistral fix', 'monitoring')]),
  // A regional outage with a healthy region left: the banner recommends "Switch region" for it.
  svc('pinecone', 'Pinecone', 'Pinecone', 'api', 'degraded', [{ ...inc('p-1', '[AWS][us-east-1] 5xx errors on read'), impact: 'major', componentNames: ['AWS us-east-1'] }]),
]
const ALL_WITH_QUIET = [...ALL, 'groq', 'mistral', 'pinecone']
const quiet = [
  svc('openai', 'OpenAI API', 'OpenAI', 'api', 'operational', [inc('o-9', 'OpenAI notice')]),
  svc('cohere', 'Cohere API', 'Cohere', 'api', 'operational', [], { aiwatchScore: 90 }),
]

async function setup(enabledServices, services, lang) {
  vi.resetModules()
  vi.doMock('../../hooks/useLang', () => ({ useLang: () => ({ t: (k) => en[k] ?? k, lang }) }))
  vi.doMock('../../hooks/usePolling', () => ({
    usePolling: () => ({
      services, recentlyRecovered: {}, aiAnalysis: {}, loading: false, error: null,
      lastUpdated: new Date().toISOString(), refresh: () => {}, probeServiceIds: [], probe24h: [],
      reportFeed: [], supplyChainBanner: null,
    }),
  }))
  vi.doMock('../../hooks/useSettings', () => ({ useSettings: () => ({ settings: { enabledServices } }) }))
  vi.doMock('../../utils/pageContext', () => ({ usePage: () => ({ page: 'overview', setPage, categoryFilter: 'all', setCategoryFilter: () => {} }) }))
  vi.doMock('../../utils/analytics', () => ({ trackEvent }))
  return (await import('../Overview')).default
}

async function renderOverview(enabledServices, services = SERVICES, lang = 'en') {
  const Overview = await setup(enabledServices, services, lang)
  return renderToStaticMarkup(createElement(Overview))
}

const parse = (html) => { const host = document.createElement('div'); host.innerHTML = html; return host }
const rootOf = async (...args) => parse(await renderOverview(...args)).querySelector('[data-testid="affected-now"]')
const members = (html) => (html.match(/data-testid="affected-member"/g) ?? []).length
const summaryOf = (root) => root.querySelector('[data-testid="affected-summary"]').textContent.replace(/\s+/g, ' ').trim()

describe('#1959 Affected now follows the enabled services', () => {
  it('lists every enabled affected service', async () => {
    expect(members(await renderOverview(ALL))).toBe(3)
  })

  it('leaves out a service the user switched off', async () => {
    expect(members(await renderOverview(['openai', 'claude', 'cohere']))).toBe(2)
  })

  it('has no item cap', async () => {
    const ids = ['openai', 'claude', 'gemini', 'mistral', 'groq', 'cohere', 'together', 'fireworks']
    const many = ids.map((id) => svc(id, id, id, 'api', 'degraded', [inc(`i-${id}`, `incident ${id}`)]))
    expect((await rootOf(ids, many)).querySelectorAll('[data-testid="affected-entry"]').length).toBe(8)
  })
})

describe('#1959 the banner and the list are one block', () => {
  it('opens with the header, then a summary that holds the counts and nothing else', async () => {
    const root = await rootOf(ALL)
    expect(root.firstElementChild.tagName).toBe('H2')
    expect(summaryOf(root)).toBe('🔴 Down 1 · ⚠️ Degraded 2')
  })

  it('shows one count, with no separator, when only one kind exists', async () => {
    const degraded = [svc('openai', 'OpenAI API', 'OpenAI', 'api', 'degraded', [inc('o-1', 'OpenAI latency')])]
    const down = [svc('claude', 'Claude API', 'Anthropic', 'api', 'down', [inc('a-1', 'Anthropic outage')])]
    expect(summaryOf(await rootOf(['openai'], degraded))).toBe('⚠️ Degraded 1')
    expect(summaryOf(await rootOf(['claude'], down))).toBe('🔴 Down 1')
  })

  it('holds the incident link, the fallback line and every entry in one container', async () => {
    const root = await rootOf(ALL)
    expect(root.textContent).toContain('View incident details')
    expect(root.textContent).toContain('Suggested fallback:')
    expect(root.querySelectorAll('[data-testid="affected-entry"]').length).toBe(3)
  })

  it('keeps the subscribe row and the Investigating and Monitoring lines inside it', async () => {
    const root = await rootOf(ALL_WITH_QUIET, WITH_QUIET)
    for (const text of ['Investigating (1):', 'Monitoring (1):', en['slack.install.cta'], en['rss.copy.subscribe']]) {
      expect(root.textContent, `${text} should be inside the block`).toContain(text)
    }
  })

  it('runs in the designed order, with the entries last', async () => {
    const root = await rootOf(ALL_WITH_QUIET, WITH_QUIET)
    const text = root.textContent
    const order = ['Affected now', '🔴 Down 1', 'Investigating (1):', 'Monitoring (1):', 'View incident details',
      en['slack.install.cta'], en['rss.copy.subscribe'], en['overview.banner.regionSwitch'], 'Suggested fallback:', root.querySelector('[data-testid="affected-entry"]').textContent.slice(0, 20)]
    const at = order.map((needle) => text.indexOf(needle))
    order.forEach((needle, i) => expect(at[i], `${needle} is missing`).toBeGreaterThan(-1))
    for (let i = 1; i < order.length; i++) expect(at[i], `${order[i]} should come after ${order[i - 1]}`).toBeGreaterThan(at[i - 1])
  })

  it('writes the start time in the viewer language', async () => {
    const startedAt = '2026-11-10T03:00:00.000Z'
    const one = [svc('openai', 'OpenAI API', 'OpenAI', 'api', 'degraded', [inc('o-1', 'OpenAI latency', 'investigating', startedAt)])]
    expect(formatDate(startedAt, 'ko')).not.toBe(formatDate(startedAt, 'en'))
    expect((await rootOf(['openai'], one, 'ko')).textContent).toContain(formatDate(startedAt, 'ko'))
  })
})

describe('#1959 with incidents on operational services only', () => {
  it('keeps the Investigating line and shows no Affected now header or block', async () => {
    const html = await renderOverview(['openai', 'cohere'], quiet)
    expect(html).toContain('Investigating (1):')
    expect(html).not.toContain('Affected now')
    expect(html).not.toContain('data-testid="affected-now"')
  })
})

describe('#1959 clicking a member', () => {
  it('fires select_service with the block as its location and opens that service', async () => {
    const Overview = await setup(ALL, SERVICES, 'en')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(createElement(Overview)) })
    const member = [...container.querySelectorAll('[data-testid="affected-member"]')].find((b) => b.textContent.includes('ChatGPT'))
    await act(async () => { member.click() })
    expect(trackEvent).toHaveBeenCalledWith('select_service', { service_id: 'chatgpt', location: 'affected_now' })
    expect(setPage).toHaveBeenCalledWith({ name: 'service', serviceId: 'chatgpt' })
    await act(async () => { root.unmount() })
    container.remove()
  })
})

describe('#1959 the left stripe', () => {
  it('belongs to the entries, not to the block around them', async () => {
    const root = await rootOf(ALL)
    expect(root.getAttribute('style')).not.toContain('border-left')
    expect(root.querySelector('[data-testid="affected-entry"]').getAttribute('style')).toContain('border-left')
  })

  it('stays blue on a banner that has only Investigating and Monitoring lines', async () => {
    const host = parse(await renderOverview(['openai', 'cohere'], quiet))
    const banner = [...host.querySelectorAll('span')].find((e) => e.textContent === 'Investigating (1):').closest('.rounded-lg')
    expect(banner.getAttribute('style')).toContain('border-left:3px solid var(--blue)')
  })
})


describe('#1959 the incident header opens the timeline', () => {
  const STEP = { stage: 'identified', text: 'Root cause found in the gateway', at: new Date(Date.now() - 1_800_000).toISOString() }
  const withTimeline = (id, title) => ({ ...inc(id, title), timeline: [STEP] })
  const FIXTURE = [
    svc('openai', 'OpenAI API', 'OpenAI', 'api', 'degraded', [withTimeline('o-1', 'OpenAI latency')]),
    svc('claude', 'Claude API', 'Anthropic', 'api', 'down', [inc('a-1', 'Anthropic outage')]),
  ]

  async function mount() {
    const Overview = await setup(['openai', 'claude'], FIXTURE, 'en')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(createElement(Overview)) })
    const entryOf = (title) => [...container.querySelectorAll('[data-testid="affected-entry"]')].find((e) => e.textContent.includes(title))
    const cleanup = async () => { await act(async () => { root.unmount() }); container.remove() }
    return { entryOf, cleanup }
  }

  it('toggles the timeline on a header click, and a second click closes it', async () => {
    const { entryOf, cleanup } = await mount()
    const header = entryOf('OpenAI latency').querySelector('[data-testid="affected-incident-header"]')
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(entryOf('OpenAI latency').querySelector('[data-testid="incident-timeline"]')).toBeNull()
    await act(async () => { header.click() })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(entryOf('OpenAI latency').querySelector('[data-testid="incident-timeline"]').textContent).toContain('Root cause found in the gateway')
    await act(async () => { header.click() })
    expect(entryOf('OpenAI latency').querySelector('[data-testid="incident-timeline"]')).toBeNull()
    await cleanup()
  })

  it('is a focusable button, and Enter and Space open it without scrolling the page', async () => {
    const { entryOf, cleanup } = await mount()
    const header = entryOf('OpenAI latency').querySelector('[data-testid="affected-incident-header"]')
    expect(header.getAttribute('role')).toBe('button')
    expect(header.getAttribute('tabindex')).toBe('0')
    const press = (key) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      header.dispatchEvent(event)
      return event
    }
    for (const key of ['Enter', ' ']) {
      let event
      await act(async () => { event = press(key) })
      expect(event.defaultPrevented).toBe(true)
      expect(header.getAttribute('aria-expanded')).toBe('true')
      await act(async () => { press(key) })
      expect(header.getAttribute('aria-expanded')).toBe('false')
    }
    let other
    await act(async () => { other = press('a') })
    expect(other.defaultPrevented).toBe(false)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    await cleanup()
  })

  it('leaves a header with no timeline steps inert', async () => {
    const { entryOf, cleanup } = await mount()
    const header = entryOf('Anthropic outage').querySelector('[data-testid="affected-incident-header"]')
    expect(header.getAttribute('role')).toBeNull()
    expect(header.hasAttribute('aria-expanded')).toBe(false)
    await act(async () => { header.click() })
    expect(entryOf('Anthropic outage').querySelector('[data-testid="incident-timeline"]')).toBeNull()
    await cleanup()
  })

  it('keeps a member click on the service page, and opening the timeline does not fire it', async () => {
    const { entryOf, cleanup } = await mount()
    const entry = entryOf('OpenAI latency')
    await act(async () => { entry.querySelector('[data-testid="affected-incident-header"]').click() })
    expect(setPage).not.toHaveBeenCalled()
    expect(trackEvent).not.toHaveBeenCalled()
    await act(async () => { entry.querySelector('[data-testid="affected-member"]').click() })
    expect(trackEvent).toHaveBeenCalledWith('select_service', { service_id: 'openai', location: 'affected_now' })
    expect(setPage).toHaveBeenCalledWith({ name: 'service', serviceId: 'openai' })
    await cleanup()
  })
})

describe('#1978 a member row shows the service\'s other open incidents', () => {
  const hr = (h) => new Date(Date.now() - h * 3_600_000).toISOString()
  const replicate = svc('replicate', 'Replicate', 'Replicate', 'api', 'degraded', [
    inc('r-registry', 'Replicate Model Registry Unavailable', 'identified', hr(30)),
    inc('r-issue', 'Replicate Issue', 'investigating', hr(1)),
    inc('r-mon', 'Replicate webhook delays', 'monitoring', hr(2)),
  ])

  it('lists them inside the member button under the anchor incident, newest first, with a monitoring label', async () => {
    const root = await rootOf(['replicate'], [replicate])
    const entry = root.querySelector('[data-testid="affected-entry"]')
    expect(entry.querySelector('[data-testid="affected-incident-header"]').textContent).toContain('Replicate Issue')
    const lines = [...entry.querySelectorAll('[data-testid="affected-member"] [data-testid="affected-other-incident"]')]
      .map((n) => n.textContent.replace(/\s+/g, ' ').trim())
    expect(lines).toEqual([
      `${en['overview.affected.alsoOpen']} · Replicate webhook delays · ${en['overview.incidents.monitoring']}`,
      `${en['overview.affected.alsoOpen']} · Replicate Model Registry Unavailable`,
    ])
  })

  it('heads the entry with the higher-impact incident and lists the newer, lower-impact one under the row', async () => {
    const fireworks = svc('fireworks', 'Fireworks AI', 'Fireworks', 'api', 'down', [
      { ...inc('f-bc', 'Outage in BC Clusters', 'identified', hr(5)), impact: 'major' },
      { ...inc('f-kimi', 'Service Degradation for Kimi K3 Fast', 'investigating', hr(1)), impact: 'minor' },
    ])
    const root = await rootOf(['fireworks'], [fireworks])
    const entry = root.querySelector('[data-testid="affected-entry"]')
    expect(entry.querySelector('[data-testid="affected-incident-header"]').textContent).toContain('Outage in BC Clusters')
    expect([...entry.querySelectorAll('[data-testid="affected-other-incident"]')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()))
      .toEqual([`${en['overview.affected.alsoOpen']} · Service Degradation for Kimi K3 Fast`])
  })

  it('shows nothing extra for a service with one open incident', async () => {
    const root = await rootOf(ALL)
    expect(root.querySelectorAll('[data-testid="affected-other-incident"]').length).toBe(0)
  })
})

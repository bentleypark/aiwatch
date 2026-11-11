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


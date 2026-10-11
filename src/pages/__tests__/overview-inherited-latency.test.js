import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import en from '../../locales/en'

vi.mock('../../hooks/useLang', () => ({ useLang: () => ({ t: (k) => en[k] ?? k, lang: 'en' }) }))

const claude = { id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', status: 'operational', latency: 69, uptime30d: 99.86, incidents: [] }
const claudecode = { id: 'claudecode', name: 'Claude Code', provider: 'Anthropic', category: 'agent', status: 'operational', latency: null, uptime30d: 99.82, incidents: [], probeInheritedFrom: 'claude' }

async function renderOverview(enabledServices) {
  vi.resetModules()
  vi.doMock('../../hooks/usePolling', () => ({
    usePolling: () => ({
      services: [claude, claudecode], recentlyRecovered: {}, aiAnalysis: {}, loading: false, error: null,
      lastUpdated: new Date().toISOString(), refresh: () => {}, probeServiceIds: ['claude'],
      probe24h: [
        { t: new Date(Date.now() - 3_600_000).toISOString(), data: { claude: { status: 401, rtt: 999 } } },
        { t: new Date().toISOString(), data: { claude: { status: 401, rtt: 69 } } },
      ],
      reportFeed: [], supplyChainBanner: null,
    }),
  }))
  vi.doMock('../../hooks/useSettings', () => ({ useSettings: () => ({ settings: { enabledServices } }) }))
  vi.doMock('../../utils/pageContext', () => ({ usePage: () => ({ page: 'overview', setPage: () => {} }) }))
  vi.doMock('../../utils/analytics', () => ({ trackEvent: () => {} }))
  const { default: Overview } = await import('../Overview')
  return renderToStaticMarkup(createElement(Overview))
}

const card = (html, name) => {
  const start = html.indexOf(`>${name}</div>`)
  expect(start).toBeGreaterThan(-1)
  return html.slice(start, html.indexOf('</button>', start))
}

describe('#1661 Overview card latency for an inherited service', () => {
  it("shows the parent's probe RTT, labeled with the parent", async () => {
    const html = await renderOverview(['claude', 'claudecode'])
    const cc = card(html, 'Claude Code')
    expect(cc).toContain('>69ms<')
    expect(cc).toContain('>via Claude API<')
  })

  it('names the parent even when the user has disabled its card', async () => {
    const html = await renderOverview(['claudecode'])
    expect(card(html, 'Claude Code')).toContain('>via Claude API<')
  })
})

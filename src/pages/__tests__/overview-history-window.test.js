import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import en from '../../locales/en'

vi.mock('../../hooks/useLang', () => ({ useLang: () => ({ t: (k) => en[k] ?? k, lang: 'en' }) }))

const svc = (id, calendarDays) => ({
  id, name: id, provider: id, category: 'api', status: 'operational', latency: null, uptime30d: null, incidents: [],
  ...(calendarDays != null ? { calendarDays } : {}),
})

async function barsFor(service) {
  vi.resetModules()
  vi.doMock('../../hooks/usePolling', () => ({
    usePolling: () => ({
      services: [service], recentlyRecovered: {}, aiAnalysis: {}, loading: false, error: null,
      lastUpdated: new Date().toISOString(), refresh: () => {}, probeServiceIds: [], probe24h: [],
      reportFeed: [], supplyChainBanner: null,
    }),
  }))
  vi.doMock('../../hooks/useSettings', () => ({ useSettings: () => ({ settings: { enabledServices: [service.id] } }) }))
  vi.doMock('../../utils/pageContext', () => ({ usePage: () => ({ page: 'overview', setPage: () => {} }) }))
  vi.doMock('../../utils/analytics', () => ({ trackEvent: () => {} }))
  const { default: Overview } = await import('../Overview')
  const html = renderToStaticMarkup(createElement(Overview))
  return [...html.matchAll(/<div class="flex gap-\[2px\] items-end"[^>]*aria-hidden="true">((?:<div class="flex-1 rounded-sm[^>]*><\/div>)*)<\/div>/g)]
    .map((m) => m[1].match(/<div /g)?.length ?? 0)
}

describe('#1406 — the Overview history bars draw the window the worker decided', () => {
  it.each([[30, 30], [14, 14], [undefined, 14]])('calendarDays %s → %i bars on every card', async (calendarDays, bars) => {
    const counts = await barsFor(svc('x', calendarDays))
    expect(counts.length, 'premise: the card renders its history bars').toBeGreaterThan(0)
    for (const n of counts) expect(n).toBe(bars)
  })
})

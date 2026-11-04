import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatMaintenanceRange } from '../../utils/maintenance'

// #1405 — the format is unit-tested in maintenance.test.js; this pins the two call sites.

const WINDOW = {
  id: 'd6t9c8tqbz25', title: 'EU cluster storage maintenance',
  scheduledFor: '2099-11-04T04:00:00.000Z', scheduledUntil: '2099-11-04T10:00:00.000Z',
  componentNames: ['API (api.bfl.ai)', 'API EU (api.eu.bfl.ai)'],
}
const SECOND = { id: 'later', title: 'Gateway upgrade', scheduledFor: '2099-11-10T01:00:00.000Z', scheduledUntil: null, componentNames: [] }
const UNREADABLE = { id: 'broken', title: 'Unreadable window', scheduledFor: 'not a date', scheduledUntil: null, componentNames: [] }
const ONGOING = { ...WINDOW, id: 'now', scheduledFor: '2000-01-01T00:00:00.000Z' }
const bfl = (over = {}) => ({
  id: 'bfl', name: 'Black Forest Labs (FLUX)', provider: 'Black Forest Labs', category: 'api',
  status: 'operational', latency: null, uptime30d: 100, incidents: [], ...over,
})

let services = []
let lang = 'en'
vi.mock('../../hooks/useLang', async () => {
  const { default: en } = await import('../../locales/en.js')
  return { useLang: () => ({ t: (k) => en[k] ?? k, lang }) }
})
vi.mock('../../utils/pageContext', () => ({ usePage: () => ({ page: 'overview', setPage: () => {} }) }))
vi.mock('../../hooks/usePolling', () => ({
  usePolling: () => ({
    services, loading: false, error: null, probe24h: [], probeServiceIds: [], refresh: () => {},
    recentlyRecovered: new Set(), securityAlerts: [], reportFeed: [], aiAnalysis: {}, lastUpdated: new Date(),
  }),
}))

const { default: ServiceDetails } = await import('../ServiceDetails')
const { default: Overview } = await import('../Overview')
const details = () => renderToStaticMarkup(createElement(ServiceDetails, { serviceId: 'bfl' }))
const overview = () => renderToStaticMarkup(createElement(Overview))
const escape = (s) => s.replace(/&/g, '&amp;')
const count = (html, s) => html.split(s).length - 1

describe('#1405 ServiceDetails maintenance section', () => {
  it('shows every window with its range and affected components, in the viewer language', () => {
    lang = 'ko'
    services = [bfl({ scheduledMaintenances: [SECOND, UNREADABLE, WINDOW] })]
    const html = details()
    lang = 'en'
    expect(count(html, 'data-testid="scheduled-maintenance"')).toBe(1)
    expect(html).toContain('EU cluster storage maintenance')
    expect(html).toContain('Gateway upgrade')
    expect(html).toContain(escape(formatMaintenanceRange(WINDOW, 'ko')))
    expect(html).toContain(escape(formatMaintenanceRange(SECOND, 'ko')))
    expect(count(html, 'Affected: ')).toBe(1)
    expect(html).toContain('Affected: API (api.bfl.ai), API EU (api.eu.bfl.ai)')
    expect(html).toContain('>Scheduled Maintenance<')
    expect(html).toContain('Announced by the provider; not counted in status, uptime or Score')
    expect(html).not.toContain('Unreadable window')
    expect(html.indexOf('EU cluster storage maintenance')).toBeLessThan(html.indexOf('Gateway upgrade'))
  })

  it('labels each window ongoing or upcoming, as the Overview chip does', () => {
    services = [bfl({ scheduledMaintenances: [SECOND, ONGOING] })]
    const html = details()
    expect(html).toMatch(/>In maintenance<\/span><span[^>]*>EU cluster storage maintenance</)
    expect(html).toMatch(/>Maintenance planned<\/span><span[^>]*>Gateway upgrade</)
  })

  it('puts every window in one section, ongoing first, below the component breakdown and directly above Incident History', () => {
    services = [bfl({ components: [{ id: 'api', name: 'API', status: 'operational' }], scheduledMaintenances: [SECOND, ONGOING] })]
    const html = details()
    const section = html.indexOf('data-testid="scheduled-maintenance"')
    const breakdown = html.indexOf('>Component Status')
    const history = html.indexOf('>Incident History')
    expect(count(html, '>Scheduled Maintenance<')).toBe(1)
    expect(breakdown).toBeGreaterThan(-1)
    expect(section).toBeGreaterThan(breakdown)
    expect(html.indexOf('EU cluster storage maintenance')).toBeGreaterThan(section)
    expect(html.indexOf('Gateway upgrade')).toBeGreaterThan(html.indexOf('EU cluster storage maintenance'))
    expect(history).toBeGreaterThan(html.indexOf('Gateway upgrade'))
  })

  it('shows the provider note once, under its own window', () => {
    services = [bfl({ scheduledMaintenances: [{ ...WINDOW, description: 'No downtime is expected.' }, SECOND] })]
    const html = details()
    expect(count(html, 'No downtime is expected.')).toBe(1)
    expect(html.indexOf('No downtime is expected.')).toBeLessThan(html.indexOf('Gateway upgrade'))
    expect(html.indexOf('No downtime is expected.')).toBeGreaterThan(html.indexOf('EU cluster storage maintenance'))
  })

  it('renders nothing when there is no window', () => {
    services = [bfl()]
    expect(details()).not.toContain('scheduled-maintenance')
  })
})

describe('#1405 Overview card chip', () => {
  it('appears in both card layouts, says upcoming, and carries the range in the viewer language', () => {
    lang = 'ko'
    services = [bfl({ scheduledMaintenances: [WINDOW] })]
    const html = overview()
    lang = 'en'
    expect(count(html, 'data-testid="maintenance-chip"')).toBe(2)
    expect(count(html, '>Maintenance planned<')).toBe(2)
    expect(html).toContain(`title="EU cluster storage maintenance · ${escape(formatMaintenanceRange(WINDOW, 'ko'))}"`)
    expect(formatMaintenanceRange(WINDOW, 'ko')).not.toBe(formatMaintenanceRange(WINDOW, 'en'))
  })

  it('reads the earliest window, so an ongoing one is not hidden behind a later upcoming one', () => {
    services = [bfl({ scheduledMaintenances: [SECOND, UNREADABLE, ONGOING] })]
    const html = overview()
    expect(count(html, '>In maintenance<')).toBe(2)
    expect(html).not.toContain('Maintenance planned')
    expect(html).toContain('title="EU cluster storage maintenance · ')
  })

  it('renders nothing when there is no window', () => {
    services = [bfl()]
    expect(overview()).not.toContain('maintenance-chip')
  })
})

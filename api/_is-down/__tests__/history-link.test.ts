// #1612 — the is-down "View 30-day history" link and its consent-free click beacon.
import { describe, it, expect, vi } from 'vitest'
import { renderIncidents, renderDelegatedListeners, type ServiceData } from '../html-template'

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const inc = (startedAt: string) => ({ id: startedAt, title: 'Elevated errors', status: 'resolved', impact: 'minor', startedAt, resolvedAt: startedAt, duration: '10m', timeline: [] })
const svc = (over: Partial<ServiceData>): ServiceData => ({ id: 'openai', name: 'OpenAI API', status: 'operational', incidents: [], ...over } as unknown as ServiceData)

const HREF = 'href="https://ai-watch.dev/#incidents?service=openai&amp;period=30"'

describe('renderIncidents — 30-day history link (#1612)', () => {
  it('links to the service-scoped 30-day Incidents view under a non-empty list', () => {
    const html = renderIncidents(svc({ incidents: [inc(daysAgo(2))] as never }))
    expect(html).toContain(HREF)
    expect(html).toContain('data-ga="click_incident_history"')
    expect(html).toContain('data-ga-svc="openai"')
  })

  it('still links when the 7-day window is empty — older incidents are what the link is for', () => {
    const html = renderIncidents(svc({ incidents: [inc(daysAgo(20))] as never }))
    expect(html).toContain('No incidents in the last 7 days')
    expect(html).toContain(HREF)
  })

  it('omits the link for a stale source, whose section says history is unavailable', () => {
    const html = renderIncidents(svc({ incidentSourceStale: true, incidents: [inc(daysAgo(2))] as never }))
    expect(html).toContain('Incident history unavailable')
    expect(html).not.toContain('click_incident_history')
  })
})

function runListener(active: boolean, dataset: Record<string, string>) {
  const listener = renderDelegatedListeners('openai', active)
  const body = listener.replace(/^<script>/, '').replace(/<\/script>\s*$/, '')
  const fetchMock = vi.fn(() => Promise.resolve())
  let onClick: ((e: unknown) => void) | undefined
  const document = { referrer: '', addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'click') onClick = fn } }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('document', 'fetch', 'location', 'gtag', body)(document, fetchMock, { search: '' }, undefined)
  fetchMock.mockClear()
  onClick!({ target: { closest: (sel: string) => (sel === '[data-ga]' ? { dataset } : null) } })
  return fetchMock
}

describe('delegated listener — history-click beacon (#1612)', () => {
  it('posts the clicked service and the page outage flag to /api/history-click', () => {
    const fetchMock = runListener(true, { ga: 'click_incident_history', gaSvc: 'openai', gaLoc: 'is_down_page' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string; keepalive: boolean }]
    expect(url).toMatch(/\/api\/history-click$/)
    expect(init.keepalive).toBe(true)
    // A same-tab navigation follows the click: no custom Content-Type, so no preflight to lose on unload.
    expect((init as { headers?: unknown }).headers).toBeUndefined()
    expect(JSON.parse(init.body)).toEqual({ svc: 'openai', active: true, surface: 'service' })
  })

  it('carries active:false on a clear page', () => {
    const fetchMock = runListener(false, { ga: 'click_incident_history', gaSvc: 'openai' })
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toEqual({ svc: 'openai', active: false, surface: 'service' })
  })

  it('sends nothing for other data-ga clicks', () => {
    expect(runListener(true, { ga: 'click_ranking', gaLoc: 'is_down_page' })).not.toHaveBeenCalled()
  })
})

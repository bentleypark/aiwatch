import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'
import { parseIncidentIoReportedDays } from '../parsers/incident-io'
import { pageHtml, summary, fakeKv, type Entry } from './helpers/incident-io-page'

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()

afterEach(() => vi.unstubAllGlobals())

async function run(id: string, published: string, outageHours?: number, reportedSince?: string) {
  const cfg = SERVICES.find((s) => s.id === id)!
  const reportedIds = [cfg.incidentIoComponentId].flat() as string[]
  const scopeIds = [...new Set([...(cfg.statusComponentIds ?? []), ...reportedIds])]
  const entries: Entry[] = scopeIds.map((cid) => (
    cid === reportedIds[0] ? { id: cid, published, since: reportedSince } : { id: cid, published: '100.00' }
  ))
  const outage = outageHours ? { id: reportedIds[0], hours: outageHours } : undefined
  const { kv } = fakeKv()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200 })))
  return fetchService(
    cfg,
    { summary: summary(entries, cfg.name) as never, incidents: null, uptimeHtml: pageHtml(entries, outage) } as never,
    kv as never,
    {},
  )
}

describe('the page figure shown beside ours carries its period', () => {
  it.each(['cohere', 'groq', 'perplexity', 'turbopuffer'])('%s: 90 days for a component with older records', async (id) => {
    const svc = await run(id, '99.50', 1)
    expect(svc.uptime30d).toBe(99.86)
    expect(svc.uptimeReported).toBe(99.5)
    expect(svc.uptimeReportedDays).toBe(90)
  })

  it('states the component\'s own age when its records are younger than 90 days', async () => {
    const svc = await run('cohere', '99.50', 1, ago(45))
    expect(svc.uptimeReported).toBe(99.5)
    expect(svc.uptimeReportedDays).toBe(45)
  })

  it('shows neither figure nor period when the page agrees with our number', async () => {
    const svc = await run('cohere', '99.86', 1)
    expect(svc.uptimeReported).toBeUndefined()
    expect(svc.uptimeReportedDays).toBeUndefined()
  })

  it('shows no period for a page-wide scope, which withholds the figure', async () => {
    const svc = await run('fireworks', '99.50', 1)
    expect(svc.uptimeReported).toBeUndefined()
    expect(svc.uptimeReportedDays).toBeUndefined()
  })
})

describe('parseIncidentIoReportedDays', () => {
  const days = (entries: Entry[], ids: string | string[], group?: string) => parseIncidentIoReportedDays(pageHtml(entries), ids, group, Date.now())

  it('caps at 90 days, and counts whole days of age below that', () => {
    expect(days([{ id: 'A', since: ago(400) }], 'A')).toBe(90)
    expect(days([{ id: 'A', since: ago(30) }], 'A')).toBe(30)
  })

  it('reads the age of the component whose figure is the lowest of a list, not the youngest or the oldest', () => {
    const young = { id: 'B', since: ago(30), published: '99.00' }
    expect(days([{ id: 'A', since: ago(300), published: '100.00' }, young], ['A', 'B'])).toBe(30)
    expect(days([{ id: 'A', since: ago(300), published: '99.00' }, { id: 'B', since: ago(30), published: '100.00' }], ['A', 'B'])).toBe(90)
  })

  it('reads the group entry\'s own age when the page displays a group figure', () => {
    const entries: Entry[] = [
      { id: 'A', since: ago(400), published: '100.00' },
      { id: '$undefined', group: 'G1', since: ago(400), published: '99.97' },
      { id: '$undefined', group: 'G2', since: ago(20), published: '99.10' },
    ]
    expect(days(entries, 'A', 'G1')).toBe(90)
    expect(days(entries, 'A', 'G2')).toBe(20)
  })

  it.each([
    ['an unreadable start date', [{ id: 'A', since: null }]],
    ['a component under a day old', [{ id: 'A', since: ago(0.5) }]],
    ['a figure the page hides', [{ id: 'A', published: '$undefined' }]],
    ['a component the page does not list', [{ id: 'OTHER' }]],
  ] as [string, Entry[]][])('is null for %s', (_, entries) => {
    expect(days(entries, 'A')).toBeNull()
  })
})

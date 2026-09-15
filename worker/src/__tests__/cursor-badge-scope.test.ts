import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'
import type { ServiceConfig } from '../types'

// #1420 — Cursor incident `dj4cgfmwgm65` (critical, 2026-09-03 13:41→17:07Z) as status.cursor.com
// served it at ~17:02Z: still `identified`, with Automations/Cloud Agents already recovered and
// Review Agents + Grok Bot in `major_outage` (the state its 17:07 resolve update records as
// `old_status`). Updates are copied from the live incidents.json, minus the not-yet-posted resolve.

const cfg = (id: string): ServiceConfig => {
  const c = SERVICES.find((s) => s.id === id)
  if (!c) throw new Error(`missing SERVICES config: ${id}`)
  return c
}

const component = (id: string, name: string, status: string, position: number, created: string, startDate: string) => ({
  id, name, status, created_at: created, updated_at: '2026-09-03T17:02:00.000Z', position, description: null,
  showcase: true, start_date: startDate, group_id: null, page_id: '0tp9ssgtptvs', group: false,
  only_show_if_degraded: false,
})

const COMPONENTS_AT_1702 = [
  component('k0trcq273dr6', 'Automations', 'operational', 7, '2026-04-09T12:49:50.813Z', '2026-01-01'),
  component('2x2chyqwmkzl', 'Review Agents', 'major_outage', 8, '2026-04-09T12:50:23.139Z', '2026-01-01'),
  component('vsny1qv7v86c', 'CLI', 'operational', 9, '2026-04-09T12:50:51.849Z', '2026-01-01'),
  component('mwv1g9sc7kdh', 'Cloud Agents', 'operational', 10, '2026-04-09T12:51:12.021Z', '2026-01-01'),
  component('jh0714rgjgt4', 'cursor.com', 'operational', 11, '2026-04-09T12:51:33.290Z', '2026-01-01'),
  component('rflc60xp5jp2', 'IDE', 'operational', 12, '2026-04-09T12:51:46.876Z', '2026-01-01'),
  component('xwjpvdf81qh9', 'Origin', 'operational', 13, '2026-08-17T15:24:19.328Z', '2026-08-17'),
  component('sm5wkcnqkvr9', 'Grok Bot', 'major_outage', 14, '2026-08-17T16:57:56.065Z', '2026-08-10'),
]

const OPEN_INCIDENT = {
  id: 'dj4cgfmwgm65',
  name: 'Investigating service degradation',
  status: 'identified',
  created_at: '2026-09-03T13:41:00.000Z',
  updated_at: '2026-09-03T15:33:57.938Z',
  monitoring_at: null,
  resolved_at: null,
  impact: 'critical',
  shortlink: 'https://stspg.io/my6v5jj14wyg',
  started_at: '2026-09-03T13:41:00.000Z',
  page_id: '0tp9ssgtptvs',
  incident_updates: [
    {
      status: 'identified', created_at: '2026-09-03T15:33:57.938Z',
      body: 'We have identified the cause and are actively working on a mitigation.', affected_components: null,
    },
    {
      status: 'investigating', created_at: '2026-09-03T13:41:25.141Z',
      body: 'We are investigating a service degradation affecting All Grok Models, Automations, Cloud Agents, Grok Bot and Review Agents',
      affected_components: [
        { code: 'k0trcq273dr6', name: 'Automations', old_status: 'operational', new_status: 'degraded_performance' },
        { code: '2x2chyqwmkzl', name: 'Review Agents', old_status: 'operational', new_status: 'degraded_performance' },
        { code: 'mwv1g9sc7kdh', name: 'Cloud Agents', old_status: 'operational', new_status: 'degraded_performance' },
        { code: 'sm5wkcnqkvr9', name: 'Grok Bot', old_status: 'operational', new_status: 'degraded_performance' },
      ],
    },
  ],
  components: COMPONENTS_AT_1702.filter((c) => ['k0trcq273dr6', '2x2chyqwmkzl', 'mwv1g9sc7kdh', 'sm5wkcnqkvr9'].includes(c.id)),
}

describe('#1420 Cursor badge scope — the 2026-09-03 17:02Z state through fetchService', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const fetchCursorAt1702 = () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    return fetchService(cfg('cursor'), {
      summary: {
        status: { indicator: 'major', description: 'Partial System Outage' },
        components: COMPONENTS_AT_1702,
        incidents: [OPEN_INCIDENT],
      } as never,
      incidents: { incidents: [OPEN_INCIDENT] } as never,
      latency: 120,
    } as never, undefined, {})
  }

  it('an open incident on Review Agents keeps the badge non-operational', async () => {
    const svc = await fetchCursorAt1702()
    expect(svc.status).not.toBe('operational')
  })

  it('the still-open critical incident stays on the card', async () => {
    const svc = await fetchCursorAt1702()
    expect(svc.incidents.map((i) => i.id)).toContain('dj4cgfmwgm65')
  })
})

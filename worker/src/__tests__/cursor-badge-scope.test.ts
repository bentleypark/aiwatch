import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'
import type { ServiceConfig } from '../types'
import { EXCLUDE_FALLBACK } from '../fallback'

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

// #1814 — components as status.x.ai/api/compat/summary.json served them on 2026-10-28 (Cursor page).
const liveComponent = (id: string, name: string, status: string, position: number) => ({
  id, name, status, created_at: '2026-10-28T09:14:35.193Z', updated_at: '2026-10-28T09:14:35.193Z', position,
  description: null, showcase: true, start_date: null, group_id: null, page_id: '0tp9ssgtptvs', group: false,
  only_show_if_degraded: false,
})
const LIVE = (statuses: Record<string, string> = {}) => [
  ['cursor-ios', 'Cursor IDE (iOS)', 1], ['rflc60xp5jp2', 'IDE', 2], ['mwv1g9sc7kdh', 'Cloud Agents', 3], ['vsny1qv7v86c', 'CLI', 4],
  ['k0trcq273dr6', 'Automations', 5], ['bugbot', 'BugBot', 6], ['2x2chyqwmkzl', 'Review Agents', 7], ['sm5wkcnqkvr9', 'Grok Bot', 8],
  ['jh0714rgjgt4', 'cursor.com', 9], ['xwjpvdf81qh9', 'Origin', 10], ['enterprise-dashboard', 'Enterprise Dashboard', 11],
].map(([id, name, pos]) => liveComponent(id as string, name as string, statuses[id as string] ?? 'operational', pos as number))

const xaiIncident = (id: string, name: string, status: string, componentIds: string[], statuses: Record<string, string>) => ({
  id, name, status, impact: 'minor', created_at: '2026-10-27T07:33:08.000Z', updated_at: '2026-10-27T08:18:40.000Z',
  started_at: '2026-10-27T07:33:08.000Z', monitoring_at: null, resolved_at: status === 'resolved' ? '2026-10-27T08:18:40.000Z' : null,
  shortlink: `https://status.x.ai/history?incident=automations%2F${id}`, page_id: '0tp9ssgtptvs',
  components: LIVE(statuses).filter((c) => componentIds.includes(c.id)),
  incident_updates: [{
    id: `evt_${id}`, status, body: 'We are investigating elevated errors.', incident_id: id,
    created_at: '2026-10-27T07:33:08.000Z', updated_at: '2026-10-27T07:33:08.000Z', display_at: '2026-10-27T07:33:08.000Z',
    affected_components: componentIds.map((c) => ({ code: c, name: LIVE().find((x) => x.id === c)!.name, old_status: 'operational', new_status: statuses[c] ?? 'operational' })),
  }],
})

describe('#1814 Cursor components added after the move to status.x.ai', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const fetchCursor = (statuses: Record<string, string>, incidents: unknown[]) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    return fetchService(cfg('cursor'), {
      summary: { status: { indicator: 'minor', description: 'Partially Degraded Service' }, components: LIVE(statuses), incidents } as never,
      incidents: { incidents } as never,
    } as never, undefined, {})
  }

  it.each([['bugbot', 'BugBot'], ['cursor-ios', 'Cursor IDE (iOS)']])('an open incident on %s alone keeps the badge non-operational and stays on the card', async (id) => {
    const inc = xaiIncident(`ps_${id}`, 'Elevated errors', 'investigating', [id], { [id]: 'degraded_performance' })
    const svc = await fetchCursor({ [id]: 'degraded_performance' }, [inc])
    expect(svc.status).not.toBe('operational')
    expect(svc.incidents.map((i) => i.id)).toEqual([inc.id])
  })

  it('an Enterprise Dashboard-only incident is a reference incident, and the outage leaves the badge operational', async () => {
    const inc = xaiIncident('ps_dashboard', 'Enterprise Dashboard unavailable', 'resolved', ['enterprise-dashboard'], { 'enterprise-dashboard': 'major_outage' })
    const svc = await fetchCursor({ 'enterprise-dashboard': 'major_outage' }, [inc])
    expect(svc.status).toBe('operational')
    expect(svc.incidents).toEqual([])
    expect(svc.referenceIncidents?.map((i) => i.id)).toEqual([inc.id])
  })

  it('an open incident on Origin alone keeps the badge non-operational and stays on the card', async () => {
    const inc = xaiIncident('ps_origin', 'Origin pushes failing', 'investigating', ['xwjpvdf81qh9'], { xwjpvdf81qh9: 'partial_outage' })
    const svc = await fetchCursor({ xwjpvdf81qh9: 'partial_outage' }, [inc])
    expect(svc.status).not.toBe('operational')
    expect(svc.incidents.map((i) => i.id)).toEqual([inc.id])
  })

  it.each(['investigating', 'resolved'])('a %s incident tagged Grok Bot alone leaves the card and the badge', async (status) => {
    const inc = xaiIncident('ps_grokbot', 'Delayed responses in Grok Bot', status, ['sm5wkcnqkvr9'], { sm5wkcnqkvr9: 'major_outage' })
    const svc = await fetchCursor({ sm5wkcnqkvr9: 'major_outage' }, [inc])
    expect(svc.status).toBe('operational')
    expect(svc.incidents).toEqual([])
    expect(svc.components?.map((c) => c.name)).not.toContain('Grok Bot')
  })

  it('an incident tagged Grok Bot and Cloud Agents stays on the card', async () => {
    const inc = xaiIncident('ps_shared', 'Some Cloud Agents and Grok Bot sessions may fail to start', 'resolved', ['mwv1g9sc7kdh', 'sm5wkcnqkvr9'], {})
    const svc = await fetchCursor({}, [inc])
    expect(svc.incidents.map((i) => i.id)).toEqual([inc.id])
  })

  it('an incident tagged cursor.com and Grok Bot leaves both cursor lists — it belongs to the Grok Bot card (#1837)', async () => {
    const inc = xaiIncident('qy67qt0s4n18', 'Investigating service degradation', 'resolved', ['jh0714rgjgt4', 'sm5wkcnqkvr9'], {})
    const svc = await fetchCursor({}, [inc])
    expect(svc.incidents).toEqual([])
    expect(svc.referenceIncidents ?? []).toEqual([])
  })

  it('a cursor.com-only incident is a reference incident', async () => {
    const inc = xaiIncident('ps_payments', 'Payment System Sync Issues', 'resolved', ['jh0714rgjgt4'], { jh0714rgjgt4: 'degraded_performance' })
    const svc = await fetchCursor({ jh0714rgjgt4: 'degraded_performance' }, [inc])
    expect(svc.status).toBe('operational')
    expect(svc.incidents).toEqual([])
    expect(svc.referenceIncidents?.map((i) => i.id)).toEqual([inc.id])
  })
})

// #1837 — the Grok Bot card reads the same page as cursor and keeps only the Grok Bot component's incidents.
describe('#1837 Grok Bot card on Cursor\'s status page', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const fetchOn = (id: string, statuses: Record<string, string>, incidents: unknown[]) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    return fetchService(cfg(id), {
      summary: { status: { indicator: 'minor', description: 'Partially Degraded Service' }, components: LIVE(statuses), incidents } as never,
      incidents: { incidents } as never,
    } as never, undefined, {})
  }

  it('an open Grok Bot-only incident is on the Grok Bot card, which turns non-operational, and not on cursor', async () => {
    const inc = xaiIncident('ps_grokbot', 'Delayed responses in Grok Bot', 'investigating', ['sm5wkcnqkvr9'], { sm5wkcnqkvr9: 'major_outage' })
    const grokbot = await fetchOn('grokbot', { sm5wkcnqkvr9: 'major_outage' }, [inc])
    const cursor = await fetchOn('cursor', { sm5wkcnqkvr9: 'major_outage' }, [inc])
    expect(grokbot.status).not.toBe('operational')
    expect(grokbot.incidents.map((i) => i.id)).toEqual([inc.id])
    expect(cursor.status).toBe('operational')
    expect(cursor.incidents).toEqual([])
  })

  it('a resolved Grok Bot + Cloud Agents incident is on both cards', async () => {
    const inc = xaiIncident('ps_shared', 'Some Cloud Agents and Grok Bot sessions may fail to start', 'resolved', ['mwv1g9sc7kdh', 'sm5wkcnqkvr9'], {})
    expect((await fetchOn('grokbot', {}, [inc])).incidents.map((i) => i.id)).toEqual([inc.id])
    expect((await fetchOn('cursor', {}, [inc])).incidents.map((i) => i.id)).toEqual([inc.id])
  })

  it('an open Cloud Agents-only outage leaves the Grok Bot card operational and empty', async () => {
    const inc = xaiIncident('ps_agents', 'Cloud Agents failing to start', 'investigating', ['mwv1g9sc7kdh'], { mwv1g9sc7kdh: 'major_outage' })
    const grokbot = await fetchOn('grokbot', { mwv1g9sc7kdh: 'major_outage' }, [inc])
    expect(grokbot.status).toBe('operational')
    expect(grokbot.incidents).toEqual([])
  })

  it('a resolved cursor.com-only incident is not on the Grok Bot card', async () => {
    const inc = xaiIncident('ps_payments', 'Payment System Sync Issues', 'resolved', ['jh0714rgjgt4'], {})
    expect((await fetchOn('grokbot', {}, [inc])).incidents).toEqual([])
  })
})

it('#1837 Grok Bot is never recommended as a fallback', () => {
  expect(EXCLUDE_FALLBACK).toContain('grokbot')
})

import { describe, it, expect } from 'vitest'
import { buildMaintenanceAlerts, sinkDeferrableAlerts, isNonOutageAlert, buildTweetDrafts, buildReplyDraft, pushTargetFor, type AlertCandidate } from '../alerts'
import { kindFromKey, buildFeedEntry, type AlertFeedEntry } from '../alert-feed'
import { shouldDeliver, normalizeFilters, type SubscriptionFilters } from '../webhook-subscriptions'
import { parseInstallFilters, buildWelcomeMessage, buildGoodbyeMessage } from '../slack'
import type { ServiceStatus } from '../types'

const NOW = Date.parse('2026-11-04T02:00:00.000Z')

type Window = NonNullable<ServiceStatus['scheduledMaintenances']>[number]

function win(over: Partial<Window> = {}): Window {
  return {
    id: 'mw1',
    title: 'EU cluster storage maintenance',
    scheduledFor: '2026-11-04T04:00:00.000Z',
    scheduledUntil: '2026-11-04T10:00:00.000Z',
    componentNames: ['API (api.bfl.ai)', 'API EU (api.eu.bfl.ai)'],
    ...over,
  }
}

function svc(id: string, windows: Window[], over: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    id, name: id.toUpperCase(), provider: id.toUpperCase(), category: 'api', status: 'operational', latency: null,
    uptime30d: null, lastChecked: '2026-11-04T02:00:00.000Z', incidents: [], scheduledMaintenances: windows, ...over,
  } as ServiceStatus
}

describe('buildMaintenanceAlerts (#1405)', () => {
  it('announces an upcoming window under alerted:mnt:', () => {
    const [a] = buildMaintenanceAlerts([svc('bfl', [win()])], NOW)
    expect(a.key).toBe('alerted:mnt:mw1')
    expect(kindFromKey(a.key)).toBe('maintenance')
    expect(a.title).toBe('🔧 BFL — Maintenance Scheduled')
    expect(a.description).toBe('EU cluster storage maintenance\n🕒 2026-11-04 04:00 UTC → 2026-11-04 10:00 UTC\nComponents: API (api.bfl.ai), API EU (api.eu.bfl.ai)')
    expect(a.svcIds).toEqual(['bfl'])
  })

  it('switches to alerted:mnt-start: once the window is ongoing, so an announced window also gets a start alert', () => {
    const at = Date.parse('2026-11-04T04:00:00.000Z')
    const [a] = buildMaintenanceAlerts([svc('bfl', [win()])], at)
    expect(a.key).toBe('alerted:mnt-start:mw1')
    expect(kindFromKey(a.key)).toBe('maintenance-started')
    expect(a.title).toBe('🔧 BFL — Maintenance Started')
  })

  it('emits nothing for a window that has ended', () => {
    expect(buildMaintenanceAlerts([svc('bfl', [win()])], Date.parse('2026-11-04T10:00:01.000Z'))).toEqual([])
  })

  it('groups one window shared by several services into one alert carrying every service', () => {
    const alerts = buildMaintenanceAlerts([
      svc('claude', [win({ componentNames: ['A'] })], { name: 'Claude API', provider: 'Anthropic' }),
      svc('claudeai', [win({ componentNames: ['A', 'B'] })], { name: 'claude.ai', provider: 'Anthropic' }),
      svc('openai', [win({ id: 'other' })]),
    ], NOW)
    expect(alerts.map((a) => a.key)).toEqual(['alerted:mnt:mw1', 'alerted:mnt:other'])
    expect(alerts[0].svcIds).toEqual(['claude', 'claudeai'])
    expect(alerts[0].title).toBe('🔧 Anthropic (Claude API, claude.ai) — Maintenance Scheduled')
    expect(alerts[0].description).toContain('Components: A, B')
  })

  it('says so when the provider published no end time, and omits an empty component line', () => {
    const [a] = buildMaintenanceAlerts([svc('bfl', [win({ scheduledUntil: null, componentNames: [] })])], NOW)
    expect(a.description).toBe('EU cluster storage maintenance\n🕒 2026-11-04 04:00 UTC → no end time published')
  })

  it('keeps the dedup key for a year, whatever the window dates, so a reschedule or an open-ended window does not re-send', () => {
    for (const w of [win(), win({ scheduledUntil: null }), win({ scheduledFor: '2026-12-01T00:00:00.000Z', scheduledUntil: '2026-12-01T01:00:00.000Z' })]) {
      for (const at of [NOW, Date.parse('2026-11-04T05:00:00.000Z')]) {
        for (const a of buildMaintenanceAlerts([svc('bfl', [w])], at)) expect(a.dedupTtlS).toBe(365 * 86_400)
      }
    }
  })
})

describe('maintenance alerts are not outage alerts (#1405)', () => {
  const services = [svc('claude', [win()], { name: 'Claude API', provider: 'Anthropic', status: 'down' })]
  const [alert] = buildMaintenanceAlerts(services, NOW)

  it('isNonOutageAlert holds for both maintenance kinds', () => {
    expect(isNonOutageAlert({}, 'maintenance')).toBe(true)
    expect(isNonOutageAlert({}, 'maintenance-started')).toBe(true)
    expect(isNonOutageAlert({}, 'new')).toBe(false)
  })

  it('produces no tweet draft, reply draft or phone push', () => {
    const scored = services.map((s) => ({ ...s, score: 90 })) as Parameters<typeof buildTweetDrafts>[1]
    expect(buildTweetDrafts(alert, scored)).toEqual([])
    expect(buildReplyDraft(alert, scored)).toBeNull()
    expect(pushTargetFor(alert, services)).toBeNull()
  })
})

describe('sinkDeferrableAlerts (#1106/#1405)', () => {
  const a = (key: string) => ({ key, title: key, description: '', color: 0, url: '' }) as AlertCandidate
  it('orders live alerts, then withdrawals, then maintenance, keeping order within each', () => {
    const out = sinkDeferrableAlerts([a('alerted:mnt:1'), a('alerted:wd:1'), a('alerted:down:x'), a('alerted:mnt-start:2'), a('alerted:new:2')])
    expect(out.map((x) => x.key)).toEqual(['alerted:down:x', 'alerted:new:2', 'alerted:wd:1', 'alerted:mnt:1', 'alerted:mnt-start:2'])
  })
})

describe('subscriber opt-in (#1405)', () => {
  const base: SubscriptionFilters = { alertCondition: 'all', alertTarget: 'all', alertServices: [], alertIncidents: true, alertMaintenance: false }
  const entry = (kind: AlertFeedEntry['kind']): AlertFeedEntry => ({ key: `alerted:mnt:1`, kind, svcIds: ['bfl'], embed: { title: 't', description: 'd', color: 1 }, ts: 1 })

  it('delivers maintenance only to a subscriber who turned it on', () => {
    for (const kind of ['maintenance', 'maintenance-started'] as const) {
      expect(shouldDeliver(entry(kind), base)).toBe(false)
      expect(shouldDeliver(entry(kind), { ...base, alertMaintenance: true })).toBe(true)
      expect(shouldDeliver(entry(kind), { ...base, alertMaintenance: true, alertIncidents: false, alertCondition: 'down' })).toBe(true)
      expect(shouldDeliver(entry(kind), { ...base, alertMaintenance: true, alertTarget: 'custom', alertServices: ['openai'] })).toBe(false)
    }
  })

  it('a subscription stored before the field existed, as delivery reads it from KV, gets none', () => {
    const stored = JSON.parse(JSON.stringify({ alertCondition: 'all', alertTarget: 'all', alertServices: [], alertIncidents: true })) as SubscriptionFilters
    expect(shouldDeliver(entry('maintenance'), stored)).toBe(false)
    expect(shouldDeliver(entry('maintenance-started'), stored)).toBe(false)
  })

  it('normalizeFilters defaults the field to off', () => {
    expect(normalizeFilters({ alertIncidents: true }).alertMaintenance).toBe(false)
    expect(normalizeFilters({ alertMaintenance: 'yes' }).alertMaintenance).toBe(false)
    expect(normalizeFilters({ alertMaintenance: true }).alertMaintenance).toBe(true)
  })

  it('feed entry built from the alert carries the maintenance kind and its services', () => {
    const [alert] = buildMaintenanceAlerts([svc('bfl', [win()])], NOW)
    const fe = buildFeedEntry(alert, 'desc', [])
    expect(fe?.kind).toBe('maintenance')
    expect(fe?.svcIds).toEqual(['bfl'])
  })

  it('Slack install, welcome and re-add link carry the setting', () => {
    expect(parseInstallFilters(new URLSearchParams('maintenance=1')).alertMaintenance).toBe(true)
    expect(parseInstallFilters(new URLSearchParams('')).alertMaintenance).toBe(false)
    expect(buildWelcomeMessage({ ...base, alertMaintenance: true }, 'https://m').text).toContain('Scheduled maintenance: on')
    expect(buildWelcomeMessage(base, 'https://m').text).toContain('Scheduled maintenance: off')
    expect(buildGoodbyeMessage('https://ai-watch.dev', 'https://w/install', { ...base, alertMaintenance: true }).text).toContain('https://w/install?maintenance=1')
    expect(buildGoodbyeMessage('https://ai-watch.dev', 'https://w/install', base).text).not.toContain('maintenance=1')
  })
})

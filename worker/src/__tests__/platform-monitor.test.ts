import { describe, it, expect, vi } from 'vitest'
import {
  formatPlatformOutageAlert,
  formatPlatformRecoveryAlert,
  platformStatusKey,
  platformAlertKey,
  countPlatformServices,
  type PlatformStatus,
} from '../platform-monitor'

describe('formatPlatformOutageAlert', () => {
  it('formats degraded alert with incident', () => {
    const status: PlatformStatus = {
      platform: 'Atlassian Statuspage',
      status: 'degraded',
      components: { 'Hosted Pages': 'degraded', 'HTTPS Pages': 'operational', 'Public API': 'operational' },
      checkedAt: '2026-04-09T00:15:00Z',
      incident: 'Unable to open manage portal and StatusPage intermittently',
    }
    const alert = formatPlatformOutageAlert(status, 12, 30)
    expect(alert.title).toContain('🟡')
    expect(alert.title).toContain('Atlassian Statuspage')
    expect(alert.description).toContain('metastatuspage.com')
    expect(alert.description).toContain('12/30')
    expect(alert.description).toContain('Unable to open manage portal')
    expect(alert.color).toBe(0xF0B232) // amber for degraded
  })

  it('formats down alert', () => {
    const status: PlatformStatus = {
      platform: 'Atlassian Statuspage',
      status: 'down',
      components: { 'Hosted Pages': 'down', 'HTTPS Pages': 'down', 'Public API': 'down' },
      checkedAt: '2026-04-09T00:15:00Z',
    }
    const alert = formatPlatformOutageAlert(status, 12, 30)
    expect(alert.title).toContain('🔴')
    expect(alert.color).toBe(0xED4245) // red for down
  })
})

describe('formatPlatformRecoveryAlert', () => {
  it('formats recovery alert', () => {
    const alert = formatPlatformRecoveryAlert('Atlassian Statuspage', 12)
    expect(alert.title).toContain('🟢')
    expect(alert.title).toContain('Recovered')
    expect(alert.description).toContain('12')
    expect(alert.color).toBe(0x57F287) // green
  })
})

describe('platformStatusKey / platformAlertKey', () => {
  it('returns correct KV keys', () => {
    expect(platformStatusKey('atlassian')).toBe('platform:status:atlassian')
    expect(platformAlertKey('atlassian')).toBe('alerted:platform:atlassian')
  })
})

describe('countPlatformServices', () => {
  it('counts Atlassian services by apiUrl pattern', () => {
    const configs = [
      { apiUrl: 'https://status.claude.com/api/v2/summary.json' },
      { apiUrl: 'https://status.deepseek.com/api/v2/summary.json' },
      { apiUrl: null }, // no apiUrl
      { apiUrl: 'https://status.together.ai/feed' }, // not Atlassian
    ]
    expect(countPlatformServices(configs as any, 'atlassian')).toBe(2)
  })

  it('returns 0 for empty configs', () => {
    expect(countPlatformServices([], 'atlassian')).toBe(0)
  })
})

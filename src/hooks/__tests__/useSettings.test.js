import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { normalizeAlertCondition } from '../useSettings'

describe('normalizeAlertCondition (#470 — Alert Conditions migration)', () => {
  it("migrates the removed 'degraded' value to 'all' (preserves alert-on-every-change behavior)", () => {
    expect(normalizeAlertCondition('degraded', 'down')).toBe('all')
  })

  it('passes through the supported values', () => {
    expect(normalizeAlertCondition('down', 'all')).toBe('down')
    expect(normalizeAlertCondition('all', 'down')).toBe('all')
  })

  it('falls back for unknown/undefined values', () => {
    expect(normalizeAlertCondition(undefined, 'down')).toBe('down')
    expect(normalizeAlertCondition('bogus', 'all')).toBe('all')
  })
})

// Persistence of the monitored-services toggle across a remount. The hook state is seeded from
// localStorage on mount, so a "remount" is a fresh render of a component that calls useSettings().
describe('useSettings enabledServices persistence', () => {
  async function mount() {
    vi.resetModules()
    const { useSettings } = await import('../useSettings')
    const { ALL_SERVICE_IDS, SETTINGS_STORAGE_KEY } = await import('../../utils/constants')
    let api
    function Probe() {
      api = useSettings()
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    return { ...api, ALL_SERVICE_IDS, SETTINGS_STORAGE_KEY }
  }

  beforeEach(() => localStorage.clear())

  it('keeps a service the user switched off after a remount', async () => {
    const first = await mount()
    const off = first.ALL_SERVICE_IDS.filter((id) => id !== 'chatgpt')
    first.save({ enabledServices: off })
    const second = await mount()
    expect(second.settings.enabledServices).not.toContain('chatgpt')
    expect(second.settings.enabledServices).toHaveLength(first.ALL_SERVICE_IDS.length - 1)
  })

  it('keeps every service off when the user switched them all off', async () => {
    const first = await mount()
    first.save({ enabledServices: [] })
    const second = await mount()
    expect(second.settings.enabledServices).toEqual([])
  })

  it('enables a service added to the product after the user saved', async () => {
    const first = await mount()
    const added = first.ALL_SERVICE_IDS[first.ALL_SERVICE_IDS.length - 1]
    const seen = first.ALL_SERVICE_IDS.filter((id) => id !== added && id !== 'chatgpt')
    first.save({ enabledServices: seen })
    // The user saved before `added` existed: rewrite the record the way an older build would have.
    const rec = JSON.parse(localStorage.getItem(first.SETTINGS_STORAGE_KEY))
    rec.disabledServices = rec.disabledServices?.filter((id) => id !== added)
    localStorage.setItem(first.SETTINGS_STORAGE_KEY, JSON.stringify(rec))
    const second = await mount()
    expect(second.settings.enabledServices).toContain(added)
    expect(second.settings.enabledServices).not.toContain('chatgpt')
  })

  it('a record saved before disabledServices existed resolves to every service (legacy migration)', async () => {
    const { ALL_SERVICE_IDS, SETTINGS_STORAGE_KEY } = await mount()
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ period: '7d', sla: 99.9, enabledServices: ['claude'] }))
    const { settings } = await mount()
    expect([...settings.enabledServices].sort()).toEqual([...ALL_SERVICE_IDS].sort())
  })

  it('ignores ids that are no longer monitored in the stored disabled list', async () => {
    const { ALL_SERVICE_IDS, SETTINGS_STORAGE_KEY } = await mount()
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ enabledServices: [], disabledServices: ['chatgpt', 'retired-svc'] }))
    const { settings } = await mount()
    expect(settings.enabledServices).toHaveLength(ALL_SERVICE_IDS.length - 1)
    expect(settings.enabledServices).not.toContain('chatgpt')
  })
})

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

// #1405 — the stored setting reaches the toggle: useSettings reads it, Settings renders it.

const store = new Map()
beforeAll(() => {
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => store.clear(),
  })
})

vi.mock('../../hooks/useLang', async () => {
  const { default: en } = await import('../../locales/en.js')
  return { useLang: () => ({ t: (k) => en[k] ?? k, lang: 'en', setLang: () => {} }) }
})
vi.mock('../../hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: () => {} }) }))
vi.mock('../../hooks/usePolling', () => ({ usePolling: () => ({ services: [] }) }))
const updateWebhookFilters = vi.fn(async () => ({ ok: true }))
vi.mock('../../utils/webhookSubscription', async (orig) => ({
  ...(await orig()),
  getLocalSubStatus: async () => 'confirmed',
  updateWebhookFilters: (...a) => updateWebhookFilters(...a),
}))

async function render(stored) {
  vi.resetModules()
  store.clear()
  if (stored) store.set('aiwatch-settings', JSON.stringify(stored))
  const { useSettings } = await import('../../hooks/useSettings')
  const { default: Settings } = await import('../Settings')
  let seen
  const Probe = () => { seen = useSettings().settings; return null }
  const html = renderToStaticMarkup(createElement('div', null, createElement(Probe), createElement(Settings)))
  return { seen, html }
}

function maintenanceToggle(html) {
  const label = html.indexOf('Alert when AIWatch first sees a scheduled maintenance window')
  expect(label).toBeGreaterThan(-1)
  return /aria-checked="(true|false)"/.exec(html.slice(label))?.[1]
}

describe('maintenance alert setting (#1405)', () => {
  it('a stored opt-in is read and shown switched on', async () => {
    const { seen, html } = await render({ alertMaintenance: true })
    expect(seen.alertMaintenance).toBe(true)
    expect(maintenanceToggle(html)).toBe('true')
  })

  it('the Add to Slack link carries the on-screen alert settings', async () => {
    const slackHref = (html) => /href="([^"]*\/api\/slack\/install[^"]*)"/.exec(html)?.[1]?.replaceAll('&amp;', '&')
    expect(slackHref((await render(null)).html)).toBe('https://aiwatch-worker.p2c2kbf.workers.dev/api/slack/install?condition=down')
    expect(slackHref((await render({ alertCondition: 'all' })).html)).toBe('https://aiwatch-worker.p2c2kbf.workers.dev/api/slack/install')
    const { html } = await render({ alertMaintenance: true, alertCondition: 'down', alertIncidents: false, alertTarget: 'custom', alertServices: ['claude'] })
    expect(slackHref(html)).toBe('https://aiwatch-worker.p2c2kbf.workers.dev/api/slack/install?services=claude&condition=down&incidents=0&maintenance=1')
  })

  it('Add to Slack is disabled while Custom has no service selected, so it cannot install for every service', async () => {
    const { html } = await render({ alertTarget: 'custom', alertServices: [] })
    expect(html).not.toContain('/api/slack/install')
    expect(html).toMatch(/<a role="link" aria-disabled="true" aria-describedby="slack-install-blocked"[^>]*>.*?Add to Slack<\/a><div id="slack-install-blocked"[^>]*>Select at least one service under Alert Targets to add AIWatch to Slack\.<\/div>/)
    expect(html.match(/No services selected — you won&#x27;t receive any alerts\./g)).toHaveLength(1)
  })

  it('defaults to off, including for settings saved before the field existed', async () => {
    for (const stored of [null, { alertIncidents: true }, { alertMaintenance: 'yes' }]) {
      const { seen, html } = await render(stored)
      expect(seen.alertMaintenance).toBe(false)
      expect(maintenanceToggle(html)).toBe('false')
    }
  })
})

describe('turning the maintenance toggle on for a confirmed subscription (#1405)', () => {
  it('offers the filter update and sends the new setting', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.resetModules()
    store.clear()
    store.set('aiwatch-settings', JSON.stringify({ discordUrl: 'https://discord.com/api/webhooks/1/a' }))
    const { default: Settings } = await import('../Settings')
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    await act(async () => { root.render(createElement(Settings)) })
    const buttonText = () => [...el.querySelectorAll('button')].map((b) => b.textContent)
    expect(buttonText()).not.toContain('Update alert filters')

    const rows = [...el.querySelectorAll('[role="switch"]')]
    const toggle = rows.find((b) => b.closest('div')?.parentElement?.textContent?.includes('Scheduled Maintenance Alerts'))
    await act(async () => { toggle.click() })
    const update = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Update alert filters')
    expect(update).toBeTruthy()
    await act(async () => { update.click() })
    expect(updateWebhookFilters).toHaveBeenCalledWith('https://discord.com/api/webhooks/1/a', expect.objectContaining({ alertMaintenance: true }))
    expect(JSON.parse(store.get('aiwatch-settings')).alertMaintenance).toBe(true)
    await act(async () => { root.unmount() })
    el.remove()
  })
})

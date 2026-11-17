// #2013 — Recent Incidents rows open their detail as an anchored popover, one level deep.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import en from '../../locales/en'

const { IncidentItem, GroupIncidentItem } = await import('../Overview')
const t = (k) => en[k] ?? k

const H = 3_600_000
const step = (text, msAgo) => ({ stage: 'investigating', text, at: new Date(Date.now() - msAgo).toISOString() })
const incident = (id, title, timeline = [step(`${title} update`, H)]) => ({
  id, title, status: 'resolved', impact: 'minor',
  startedAt: new Date(Date.now() - 2 * H).toISOString(), resolvedAt: new Date(Date.now() - H).toISOString(),
  duration: '1h', serviceName: 'Fireworks AI', affectedNames: ['Fireworks AI'], timeline,
})
const groupOf = (entries) => ({
  kind: 'group', count: entries.length, normalizedTitle: 'Flap', heading: 'Flap',
  rangeStart: entries[entries.length - 1].startedAt, rangeEnd: entries[0].startedAt,
  statusCounts: { resolved: entries.length }, uniformStatus: true, entries,
})

afterEach(() => { delete HTMLElement.prototype.hidePopover })

async function mount(element, { popover }) {
  if (popover) HTMLElement.prototype.hidePopover = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(element) })
  const cleanup = async () => { await act(async () => { root.unmount() }); container.remove() }
  return { container, cleanup }
}

const openPanel = (panel) => act(async () => {
  const event = new Event('beforetoggle')
  Object.defineProperty(event, 'newState', { value: 'open' })
  panel.dispatchEvent(event)
})

describe('#2013 Recent Incidents rows with the Popover API', () => {
  it('a single row is a popover button for a dialog that holds its timeline', async () => {
    const { container, cleanup } = await mount(createElement(IncidentItem, { incident: incident('i-1', 'Gateway errors'), lang: 'en', t }), { popover: true })
    const header = container.querySelector('[data-testid="incident-row-header"]')
    const panel = container.querySelector('[data-testid="incident-timeline-panel"]')
    expect(header.tagName).toBe('BUTTON')
    expect(panel.tagName).toBe('DIALOG')
    expect(panel.getAttribute('popover')).toBe('auto')
    expect(header.getAttribute('popovertarget')).toBe(panel.id)
    expect(document.getElementById(panel.getAttribute('aria-labelledby')).textContent).toBe('Fireworks AI — Gateway errors')
    expect(panel.childElementCount).toBe(1)
    await openPanel(panel)
    expect(panel.querySelector('[data-testid="incident-timeline"]').textContent).toContain('Gateway errors update')
    await cleanup()
  })

  it('a grouped row floats its entry list, and the entries inside it expand inline instead of opening another panel', async () => {
    const group = groupOf([incident('g-1', 'First flap'), incident('g-2', 'Second flap')])
    const { container, cleanup } = await mount(createElement(GroupIncidentItem, { group, lang: 'en', t }), { popover: true })
    const header = container.querySelector('[data-testid="incident-group-header"]')
    const panel = container.querySelector('[data-testid="incident-group-panel"]')
    expect(header.tagName).toBe('BUTTON')
    expect(header.getAttribute('popovertarget')).toBe(panel.id)
    await openPanel(panel)
    const entries = [...panel.querySelectorAll('[data-testid="incident-row-header"]')]
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.tagName === 'SUMMARY' && e.parentElement.tagName === 'DETAILS')).toBe(true)
    expect(panel.querySelectorAll('dialog')).toHaveLength(0)
    await act(async () => { entries[1].click() })
    expect(panel.querySelector('[data-testid="incident-timeline"]').textContent).toContain('Second flap update')
    await cleanup()
  })
})

describe('#2013 Recent Incidents rows without the Popover API', () => {
  it('a single row is a details summary that opens its timeline in place', async () => {
    const { container, cleanup } = await mount(createElement(IncidentItem, { incident: incident('i-2', 'Gateway errors'), lang: 'en', t }), { popover: false })
    const header = container.querySelector('[data-testid="incident-row-header"]')
    expect(header.tagName).toBe('SUMMARY')
    expect(header.parentElement.tagName).toBe('DETAILS')
    expect(container.querySelector('dialog')).toBeNull()
    await act(async () => { header.click() })
    expect(header.parentElement.open).toBe(true)
    expect(container.querySelector('[data-testid="incident-timeline"]').textContent).toContain('Gateway errors update')
    await cleanup()
  })

  it('a row with nothing to show is not interactive', async () => {
    const { container, cleanup } = await mount(createElement(IncidentItem, { incident: incident('i-3', 'Blip', []), lang: 'en', t }), { popover: true })
    const header = container.querySelector('[data-testid="incident-row-header"]')
    expect(header.tagName).toBe('DIV')
    expect(header.hasAttribute('role')).toBe(false)
    expect(container.querySelector('dialog')).toBeNull()
    await cleanup()
  })
})

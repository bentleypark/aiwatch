// #1715 — the Overview "Recent Incidents" row for a `status_history`-derived incident must respond to a
// click, as the service detail row does (#1292).
//
// The row gated its click on `hasTimeline = incident.timeline.length > 0`, and a synthesized incident
// carries an empty timeline by construction, so on the Overview it was inert while the same incident
// expanded on the detail page and the Incidents page.
//
// SSR render, so `expanded` is always false: the collapsed row's clickability AFFORDANCE
// (`cursor-pointer`, emitted only when the row will respond to a click) is asserted there, in both
// directions. The click itself and the note it reveals are asserted by opening the row in a DOM.
import { describe, it, expect, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'

const { IncidentItem } = await import('../Overview')

const STRINGS = {
  'incidents.derived.dayTotal': 'that day',
  'incidents.status.ongoing': 'Ongoing',
  'incidents.status.resolved': 'Resolved',
}
const t = (k) => STRINGS[k] ?? k

const base = {
  id: 'x', title: 'MiniMax M3 — down', status: 'resolved', impact: 'minor',
  startedAt: '2026-10-16T19:00:00.000Z', resolvedAt: '2026-10-16T20:04:18.000Z',
  duration: '1h 5m', timeline: [], serviceName: 'Together AI', serviceId: 'together',
}
const derived = { ...base, derived: 'status_history', derivedDay: '2026-10-16' }
const withTimeline = { ...base, timeline: [{ stage: 'resolved', text: 'Recovered', at: base.resolvedAt }] }

const renderItem = (incident) =>
  renderToStaticMarkup(createElement(IncidentItem, { incident, lang: 'en', t }))

describe('#1715 — Overview incident row expandability', () => {
  it('makes a status_history-derived row expandable despite its empty timeline', () => {
    expect(renderItem(derived)).toContain('cursor-pointer')
  })

  it('leaves an ORDINARY incident with an empty timeline inert', () => {
    expect(renderItem(base)).not.toContain('cursor-pointer')
  })

  it('keeps a real timeline expandable', () => {
    expect(renderItem(withTimeline)).toContain('cursor-pointer')
  })
})

describe('#1715 — opening the Overview incident row', () => {
  let container = null
  afterEach(() => { container?.remove(); container = null })
  const tag = (k) => `T:${k}`

  const openRow = async (incident) => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(createElement(IncidentItem, { incident, lang: 'en', t: tag })) })
    const row = container.firstElementChild.firstElementChild
    await act(async () => { row.click() })
    return { html: container.innerHTML, expandable: row.className.includes('cursor-pointer') }
  }

  it('a derived row opens and shows the derived note, not the empty-timeline copy', async () => {
    const { html, expandable } = await openRow(derived)
    expect(expandable, 'the row stopped being clickable').toBe(true)
    expect(html).toContain('T:incidents.derived.note')
    expect(html).not.toContain('T:incidents.timeline.empty')
  })

  it('an ordinary empty-timeline row stays closed when clicked', async () => {
    const { html, expandable } = await openRow(base)
    expect(expandable).toBe(false)
    expect(html).not.toContain('T:incidents.timeline.empty')
    expect(html).not.toContain('T:incidents.derived.note')
  })

  it('a row with a real timeline opens and shows it', async () => {
    const { html, expandable } = await openRow(withTimeline)
    expect(expandable).toBe(true)
    expect(html).toContain('Recovered')
    expect(html).not.toContain('T:incidents.derived.note')
  })
})

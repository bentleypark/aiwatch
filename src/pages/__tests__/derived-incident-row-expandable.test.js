// #1292 — a `status_history`-derived incident row must be expandable on the SERVICE DETAIL page.
//
// The row gated its click on `hasTimeline = incident.timeline.length > 0`, and a synthesized incident
// carries an empty timeline by construction (the provider published no event log). On `together` that
// made 42 of 43 rows silently inert: clicking did nothing, nothing marked them as unclickable, and the
// `incidents.derived.note` explanation was reachable only from the Incidents page.
//
// SSR render, so `expanded` is always false — what is asserted is the collapsed row's clickability
// AFFORDANCE (`cursor-pointer`, which the component emits only when it will respond to a click) plus
// the panel's own rendering of the note. Both directions are pinned: reverting the gate to
// `hasTimeline` turns the derived case red, and widening it to every incident turns the ordinary
// empty-timeline case red.
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { IncidentRow } = await import('../ServiceDetails')
const IncidentTimeline = (await import('../../components/IncidentTimeline')).default
const ROW_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../ServiceDetails.jsx'), 'utf-8')

const NOTE = 'The provider did not publish this as an incident.'
const STRINGS = {
  'incidents.derived.note': NOTE,
  'incidents.derived.dayTotal': 'that day',
  'incidents.timeline.empty': 'No timeline data available',
  'incidents.duration.ongoing': 'Ongoing',
  'incidents.status.resolved': 'Resolved',
}
const t = (k) => STRINGS[k] ?? k

const base = {
  id: 'x', title: 'api.hconeai.com — recovered', status: 'resolved', impact: 'minor',
  startedAt: '2026-08-16T12:00:00.000Z', resolvedAt: '2026-08-16T23:36:00.000Z',
  duration: '11h 36m', timeline: [],
}
const derived = { ...base, derived: 'status_history', derivedDay: '2026-08-16' }
const withTimeline = { ...base, timeline: [{ stage: 'resolved', text: 'Recovered', at: base.resolvedAt }] }

const renderRow = (incident) =>
  renderToStaticMarkup(createElement(IncidentRow, { incident, isRecentlyRecovered: false, t, lang: 'en' }))

describe('#1292 — ServiceDetails incident row expandability', () => {
  it('makes a status_history-derived row expandable despite its empty timeline', () => {
    expect(renderRow(derived)).toContain('cursor-pointer')
  })

  it('leaves an ORDINARY incident with an empty timeline inert', () => {
    // The other direction: the fix must not make every row clickable, or it opens a panel that says
    // "no timeline data available" on incidents the provider simply gave no updates for.
    expect(renderRow(base)).not.toContain('cursor-pointer')
  })

  it('keeps a real timeline expandable', () => {
    expect(renderRow(withTimeline)).toContain('cursor-pointer')
  })

  it('renders the derived note in the panel an empty timeline would otherwise leave blank', () => {
    const html = renderToStaticMarkup(createElement(IncidentTimeline, {
      title: derived.title, subtitle: 'Aug 16', timeline: [], note: t('incidents.derived.note'),
      onClose: () => {}, hideHeader: true, t, lang: 'en',
    }))
    expect(html).toContain(NOTE)
    expect(html).not.toContain(STRINGS['incidents.timeline.empty'])
  })

  // The two assertions above render `IncidentTimeline` DIRECTLY, so they pass whether or not
  // ServiceDetails actually passes it a note — verified by mutation: deleting the `note=` line from
  // the page left all of them green. An SSR render cannot reach the expanded panel (`expanded` starts
  // false and there is no click), so the wiring is pinned by scanning the source, the same mechanism
  // `derived-date-precision-wiring.test.js` uses for the same reason.
  it('WIRES that note from ServiceDetails, not just from the component in isolation', () => {
    const el = ROW_SRC.match(/<IncidentTimeline\b[\s\S]*?\/>/)
    expect(el, 'ServiceDetails no longer renders an IncidentTimeline — this scan has gone blind').not.toBeNull()
    expect(el[0], 'ServiceDetails renders IncidentTimeline without passing the derived note')
      .toMatch(/note=\{[^}]*derived\.note/)
  })

  it('gates the CLICK on the same flag as the cursor, not just the cursor', () => {
    // `renderToStaticMarkup` emits no event handlers, so every assertion above passes on a row whose
    // className is gated on `expandable` while its `onClick` is still gated on `hasTimeline` — a row
    // that shows a pointer cursor and does nothing, which is the #1292 defect this file exists for.
    // Reverting the two gates together is caught above; reverting only the handler is caught here.
    expect(ROW_SRC, 'the click gate and the cursor gate have diverged — a row can look clickable and be inert')
      .toMatch(/onClick=\{expandable \?/)
    expect(ROW_SRC).toMatch(/\$\{expandable \? 'cursor-pointer/)
  })

  it('still falls back to the empty-timeline copy when no note is given', () => {
    const html = renderToStaticMarkup(createElement(IncidentTimeline, {
      title: base.title, subtitle: 'Aug 16', timeline: [],
      onClose: () => {}, hideHeader: true, t, lang: 'en',
    }))
    expect(html).toContain(STRINGS['incidents.timeline.empty'])
  })
})

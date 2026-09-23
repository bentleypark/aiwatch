// #1480 — which note an incident row carries, pinned by DRIVING the decision and by RENDERING it.
//
// Two earlier guards in this PR passed for the wrong reason, and both are why this file is shaped the
// way it is. One compared where the key names appear in each page's source, so it passed with the
// branch dead and with the order swapped. The next asserted only one population, so a hardcoded note
// was indistinguishable from a chosen one.
//
// The axis that decides whether a note is SEEN is the timeline, not where the row came from:
// `IncidentTimeline` renders `note` only when the timeline is empty (#1292 built that slot as the
// substitute for "no timeline data"). An archive-served row is empty by construction, and a live one
// can be too. Both shapes are asserted below.
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { incidentNoteKey, incidentNote } from '../incidentNote'

const at = '2026-09-11T08:00:00.000Z'
const resolved = { id: 'x', status: 'resolved', startedAt: at, resolvedAt: at }
const t = (k) => `T:${k}`

describe('#1480 incidentNoteKey', () => {
  it('gives a zero-length record its OWN note, though it also carries startUnknown', () => {
    expect(incidentNoteKey({ ...resolved, startUnknown: true, zeroLengthRecord: true }))
      .toBe('incidents.zeroLengthRecord.note')
  })

  it('gives a #1390-anchored record the note that licenses its Resolved label', () => {
    expect(incidentNoteKey({ ...resolved, startUnknown: true }))
      .toBe('incidents.startUnknown.note')
  })

  it('gives a status_history row the derived note, ahead of either', () => {
    expect(incidentNoteKey({ ...resolved, derived: 'status_history', startUnknown: true, zeroLengthRecord: true }))
      .toBe('incidents.derived.note')
  })

  it('gives an ordinary incident none', () => {
    expect(incidentNoteKey({ ...resolved, duration: '1h 0m' })).toBeUndefined()
  })
})

describe('#1480 incidentNote', () => {
  it('renders through t() only when there is a note', () => {
    expect(incidentNote({ ...resolved, zeroLengthRecord: true }, t)).toBe('T:incidents.zeroLengthRecord.note')
    expect(incidentNote({ ...resolved }, t)).toBeUndefined()
  })
})

// ── what a reader actually gets ──────────────────────────────────────────────

const live = { ...resolved, serviceName: 'Azure OpenAI', title: 'Service disruption', duration: null,
  timeline: [{ stage: 'resolved', text: 'Service has recovered', at }] }
const noTimeline = { ...live, timeline: [] } // archive rows always; a live row can be too (windsurf 550t8qt2ms4h)

describe('#1480 Incidents panel — all three populations, on the shape the note reaches', () => {
  const panelOf = async (incident) => {
    const { DetailPanel } = await import('../../pages/Incidents')
    return renderToStaticMarkup(createElement(DetailPanel, { incident, onClose: () => {}, t, lang: 'en' }))
  }

  // Asserting only the zero-length case cannot tell the page apart from one that hardcodes that note.
  it.each([
    ['zero-length', { startUnknown: true, zeroLengthRecord: true }, 'incidents.zeroLengthRecord.note'],
    ['#1390-anchored', { startUnknown: true }, 'incidents.startUnknown.note'],
    ['status_history', { derived: 'status_history', derivedDay: '2026-09-11' }, 'incidents.derived.note'],
  ])('an empty-timeline %s row shows its own note', async (_label, flags, key) => {
    const html = await panelOf({ ...noTimeline, ...flags })
    expect(html, 'the page is not routing this population through incidentNote').toContain(`T:${key}`)
    for (const other of ['incidents.zeroLengthRecord.note', 'incidents.startUnknown.note', 'incidents.derived.note']) {
      if (other !== key) expect(html, `it also showed ${other}`).not.toContain(`T:${other}`)
    }
  })

  it('an ordinary empty-timeline row still says the timeline is empty, not a note', async () => {
    expect(await panelOf(noTimeline)).toContain('T:incidents.timeline.empty')
  })

  it('a row WITH a timeline shows it and no note — the slot is the empty-timeline substitute', async () => {
    // Not a defect of #1480: `IncidentTimeline` has one body slot, so a record carrying an event log
    // shows the log. Pinned because it is what makes the note's visibility a property of the timeline.
    const html = await panelOf({ ...live, startUnknown: true, zeroLengthRecord: true })
    expect(html).toContain('Service has recovered')
    expect(html).not.toContain('T:incidents.zeroLengthRecord.note')
  })
})

describe('#1480 ServiceDetails — the note reached by opening the row', () => {
  let container = null
  afterEach(() => { container?.remove(); container = null })

  const openRow = async (incident) => {
    const { IncidentRow } = await import('../../pages/ServiceDetails')
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(createElement(IncidentRow, { incident, isRecentlyRecovered: false, t, lang: 'en' })) })
    const row = container.querySelector('.cursor-pointer')
    if (row) await act(async () => { row.click() })
    return { html: container.innerHTML, expandable: !!row }
  }

  it('a live zero-length row opens and shows its timeline', async () => {
    const { html, expandable } = await openRow({ ...live, startUnknown: true, zeroLengthRecord: true })
    expect(expandable, 'the row stopped being clickable').toBe(true)
    expect(html).toContain('Service has recovered')
  })

  it('a status_history row opens and shows the derived note — the one note reachable here', async () => {
    // `expandable = hasTimeline || isDerived`, so an empty-timeline row is clickable ONLY when derived.
    const { html, expandable } = await openRow({ ...noTimeline, derived: 'status_history', derivedDay: '2026-09-11' })
    expect(expandable).toBe(true)
    expect(html).toContain('T:incidents.derived.note')
  })
})

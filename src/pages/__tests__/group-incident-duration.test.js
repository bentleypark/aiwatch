import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// SSR render of the Overview "Recent Incidents" collapsed GROUP row. Pins the
// fix where a ×N flap group showed only the NEWEST flip's duration instead of
// the SUM (and guards the "34m total total" double-label regression). t is a
// prop, so no context/provider is needed. Collapsed (useState(false)) render
// emits only the summary line — exactly what we assert.
const { GroupIncidentItem } = await import('../Overview')

// Stub t with the real en strings for the keys this row uses, so the `{d}`
// interpolation in the label is exercised (an identity stub would leave `{d}`
// unreplaced and hide the label composition under test).
const STRINGS = {
  'overview.incidents.total': '{d} total',
  'incidents.duration.ongoing': 'Ongoing',
  'overview.incidents.monitoring': 'Monitoring',
  'incidents.status.ongoing': 'In Progress',
}
const t = (k) => STRINGS[k] ?? k
const render = (group) => renderToStaticMarkup(createElement(GroupIncidentItem, { group, lang: 'en', t }))

// One flap entry: sumGroupDuration derives minutes from resolvedAt − startedAt.
const flap = (startISO, durMin) => ({
  id: `f-${startISO}`, title: 'GPT OSS 20B — recovered', status: 'resolved', impact: 'minor',
  startedAt: startISO, resolvedAt: new Date(new Date(startISO).getTime() + durMin * 60_000).toISOString(),
  duration: `${durMin}m`, serviceName: 'Fireworks AI', affectedNames: ['Fireworks AI'], timeline: [],
})

const groupOf = (entries) => ({
  kind: 'group', count: entries.length, normalizedTitle: 'GPT OSS 20B',
  rangeStart: entries[entries.length - 1].startedAt, rangeEnd: entries[0].startedAt,
  statusCounts: entries.reduce((m, e) => ({ ...m, [e.status]: (m[e.status] ?? 0) + 1 }), {}),
  uniformStatus: new Set(entries.map((e) => e.status)).size === 1, entries,
})

describe('GroupIncidentItem — summed group duration (Overview Recent Incidents)', () => {
  it('shows the SUM of all flips labeled "total", not just the newest entry', () => {
    // newest first (entries[0] is the representative): 5m + 20m + 9m = 34m
    const html = render(groupOf([
      flap('2026-07-08T07:13:25.000Z', 5),
      flap('2026-07-08T06:30:38.000Z', 20),
      flap('2026-07-08T03:31:00.000Z', 9),
    ]))
    expect(html).toContain('34m total')       // the SUM, with our label
    expect(html).not.toContain('total total') // the double-label regression is gone
  })

  it('does not regress to the newest-only duration (5m) for a ×3 group', () => {
    const html = render(groupOf([
      flap('2026-07-08T07:13:25.000Z', 5),
      flap('2026-07-08T06:30:38.000Z', 20),
      flap('2026-07-08T03:31:00.000Z', 9),
    ]))
    // the standalone newest "5m" (without the summed 34m) must not be the shown duration
    expect(html).not.toMatch(/>\s*5m\s*</)
  })

  it('appends the ongoing marker when some entries are still active', () => {
    const active = { id: 'a1', title: 'GPT OSS 20B — recovered', status: 'investigating', impact: 'minor',
      startedAt: '2026-07-08T08:00:00.000Z', duration: null, serviceName: 'Fireworks AI', affectedNames: ['Fireworks AI'], timeline: [] }
    const html = render(groupOf([active, flap('2026-07-08T06:30:38.000Z', 20)]))
    expect(html).toContain('20m total') // sum of the resolved entry
    expect(html).toContain('Ongoing')   // + ongoing marker
  })
})

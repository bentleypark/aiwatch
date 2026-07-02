import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// SSR render of the dashboard ComponentBreakdown — the mirror of the is-down
// renderComponents (api/_is-down/html-template.ts). The two reimplement the SAME
// interleave algorithm by hand, so this pins the dashboard copy independently
// (feedback_verify_both_dashboard_and_isdown: breakdown changes must hold on BOTH
// surfaces). t is passed as a prop, so no context/provider is needed. Collapsed
// groups (useState(false)) don't emit members in static markup, so we assert the
// SECTION order via group-header names + surface-row names.
const { ComponentBreakdown } = await import('../ServiceDetails')

const t = (k) => k // identity — assert structure, not localized copy
const render = (service) => renderToStaticMarkup(createElement(ComponentBreakdown, { service, t }))

describe('ComponentBreakdown — componentGroupsInline interleave (replicate layout)', () => {
  const replicateLike = {
    componentGroupsInline: true,
    components: [
      { id: 'http', name: 'HTTP API', status: 'operational', group: 'API' },
      { id: 'stream', name: 'Streaming API', status: 'operational', group: 'API' },
      { id: 'h100', name: 'H100 Hardware', status: 'degraded', group: 'Inference and Training' },
      { id: 'cpu', name: 'CPU Hardware', status: 'operational', group: 'Inference and Training' },
      { id: 'play', name: 'Playground', status: 'operational', group: 'Website' },
      { id: 'reg', name: 'Replicate Registry', status: 'operational' }, // surface run
      { id: 'models', name: 'Official Models', status: 'operational' }, // surface run
      { id: 'bill', name: 'Billing', status: 'operational', group: 'Support' },
      { id: 'tix', name: 'Support Tickets', status: 'operational', group: 'Support' },
    ],
  }

  it('renders sections in component-array order: groups + surface run interleaved, Support LAST', () => {
    const html = render(replicateLike)
    const pos = (s) => html.indexOf(s)
    expect(pos('>API<')).toBeGreaterThan(-1)
    // API → Inference and Training → Website → [Registry, Official Models surfaces] → Support
    expect(pos('>API<')).toBeLessThan(pos('Inference and Training'))
    expect(pos('Inference and Training')).toBeLessThan(pos('>Website<'))
    expect(pos('>Website<')).toBeLessThan(pos('Replicate Registry'))
    expect(pos('Replicate Registry')).toBeLessThan(pos('Official Models'))
    // the load-bearing property: the Support GROUP renders AFTER the ungrouped surface rows
    expect(pos('Official Models')).toBeLessThan(pos('>Support<'))
  })

  it('a degraded member surfaces a non-operational status label on its collapsed group header', () => {
    const html = render(replicateLike)
    // the Inference and Training header reflects worst-of (h100 degraded) even while collapsed
    const headerEnd = html.indexOf('>Website<')
    expect(html.slice(0, headerEnd)).toContain('status.degraded')
  })

  it('default (no componentGroupsInline) keeps surfaces-first even when a group appears first in the array', () => {
    const html = render({
      components: [
        { id: 'h100', name: 'H100 Hardware', status: 'degraded', group: 'Inference and Training' },
        { id: 'reg', name: 'Replicate Registry', status: 'operational' }, // surface
      ],
    })
    expect(html.indexOf('Replicate Registry')).toBeLessThan(html.indexOf('Inference and Training'))
  })

  it('returns null markup when there are no components', () => {
    expect(render({ components: [] })).toBe('')
  })
})

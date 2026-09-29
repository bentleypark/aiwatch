// #756 — pin the image-generation sibling config (Black Forest Labs / FLUX) added so Stability AI is
// no longer a single-service category. A wrong source URL / component id would silently break incident
// or uptime matching with no runtime signal, so pin the load-bearing fields (verified 2026-06-24).
// Mirrors observability-services-config.test.ts (#601).

import { describe, it, expect } from 'vitest'
import { SERVICES, resolveSvcComponents, orderByPagePosition, MODEL_GROUP } from '../services'
import { API_TIER, EXCLUDE_FALLBACK, TIER_LABEL } from '../fallback'

describe('#756 Black Forest Labs (FLUX) image sibling config', () => {
  it('BFL is an Atlassian Statuspage service scoped to the API + image group', () => {
    const s = SERVICES.find((x) => x.id === 'bfl')
    expect(s, 'bfl missing from SERVICES').toBeDefined()
    expect(s!.name).toBe('Black Forest Labs (FLUX)')
    expect(s!.provider).toBe('Black Forest Labs')
    expect(s!.category).toBe('api')
    expect(s!.apiUrl).toBe('https://status.bfl.ml/api/v2/summary.json')
    expect(s!.statusUrl).toBe('https://status.bfl.ml')
    // The developer-facing API component.
    expect(s!.statusComponentId).toBe('ws9rrzk6n2j7')
    // Badge worst-of (#379): API + the "Image Generation Services" group roll-up.
    expect(s!.statusComponentIds).toEqual(['ws9rrzk6n2j7', 'm991l9z7y6jj'])
    // Single-tenant page → no incidentKeywords needed.
    expect(s!.incidentKeywords).toBeUndefined()
  })

  it('BFL uses the displayAllComponents breakdown in page order (#606, #1525)', () => {
    const s = SERVICES.find((x) => x.id === 'bfl')!
    expect(s.displayAllComponents).toBe(true)
    expect(s.componentGroupsInline).toBe(true)
  })

  // #1525 — summary.json as published on status.bfl.ml 2026-09-29 (trimmed): API order is not page
  // order, two group headers each carry their members via `group_id`.
  const IMG = 'm991l9z7y6jj'
  const VID = 'x16d9nh49hch'
  const bflSummary = {
    components: [
      { id: 'lzj5bpsmhwt6', name: 'FLUX 1.1 [pro]', status: 'operational', group: false, group_id: IMG, position: 1 },
      { id: 'ygnttdvrl2pj', name: 'Flux.3', status: 'operational', group: false, group_id: VID, position: 1 },
      { id: '70p23r3xs7b0', name: 'FLUX.1 [pro]', status: 'operational', group: false, group_id: IMG, position: 2 },
      { id: IMG, name: 'Image Generation Services', status: 'operational', group: true, group_id: null, position: 4 },
      { id: '8jg9v8zhstys', name: 'Finetuning', status: 'operational', group: false, group_id: null, position: 5 },
      { id: 'ws9rrzk6n2j7', name: 'API (api.bfl.ai)', status: 'operational', group: false, group_id: null, position: 6 },
      { id: VID, name: 'Video Generation Services', status: 'operational', group: true, group_id: null, position: 7 },
      { id: 'cw5sckn8002d', name: 'API EU (api.eu.bfl.ai)', status: 'operational', group: false, group_id: null, position: 8 },
      { id: 'wb9xb021290k', name: 'API US (api.us.bfl.ai)', status: 'major_outage', group: false, group_id: null, position: 9 },
      { id: 'k1f1dgrqqc9g', name: 'FLUX.2', status: 'degraded_performance', group: false, group_id: IMG, position: 10 },
    ],
  }

  it('#1525 — breakdown follows the page: its own groups, its position order, no group headers', () => {
    const s = SERVICES.find((x) => x.id === 'bfl')!
    const comps = resolveSvcComponents(s, bflSummary)
    expect(comps.map((c) => [c.name, c.group ?? null])).toEqual([
      ['FLUX 1.1 [pro]', 'Image Generation Services'],
      ['FLUX.1 [pro]', 'Image Generation Services'],
      ['FLUX.2', 'Image Generation Services'],
      ['Finetuning', null],
      ['API (api.bfl.ai)', null],
      ['Flux.3', 'Video Generation Services'],
      ['API EU (api.eu.bfl.ai)', null],
      ['API US (api.us.bfl.ai)', null],
    ])
    expect(comps.find((c) => c.name === 'API US (api.us.bfl.ai)')!.status).toBe('down')
  })

  it('#1525 — a page with no published groups keeps the surfaces/Models split', () => {
    const comps = resolveSvcComponents(
      { displayAllComponents: true, componentSurfaces: ['API'] },
      { components: [
        { id: 'a', name: 'API', status: 'operational' },
        { id: 'b', name: 'model-x', status: 'operational' },
      ] },
    )
    expect(comps.map((c) => [c.name, c.group ?? null])).toEqual([['API', null], ['model-x', MODEL_GROUP]])
  })

  it('#1525 — a curated componentGroups label still wins on a page that publishes groups', () => {
    const comps = resolveSvcComponents(
      { displayAllComponents: true, componentGroups: { x: 'Curated' } },
      { components: [
        { id: 'g', name: 'PageGroup', status: 'operational', group: true, position: 1 },
        { id: 'y', name: 'Y', status: 'operational', group_id: 'g', position: 1 },
        { id: 'x', name: 'X', status: 'operational', group_id: 'g', position: 2 },
      ] },
    )
    expect(comps.map((c) => [c.name, c.group ?? null])).toEqual([['Y', 'PageGroup'], ['X', 'Curated']])
  })

  it('#1525 — a member whose group header is absent is ordered as a top-level row', () => {
    const ordered = orderByPagePosition(
      [
        { id: 'g', name: 'G', status: 'operational', group: true, position: 2 },
        { id: 'm', name: 'M', status: 'operational', group_id: 'g', position: 1 },
        { id: 'o', name: 'Orphan', status: 'operational', group_id: 'gone', position: 1 },
        { id: 't', name: 'Top', status: 'operational', position: 3 },
      ],
      new Map([['g', 'G']]),
    )
    expect(ordered.map((c) => c.name)).toEqual(['Orphan', 'G', 'M', 'Top'])
  })

  it('Stability + BFL share fallback tier 7 (Image) and neither is excluded', () => {
    for (const id of ['stability', 'bfl']) {
      expect(API_TIER[id], `${id} tier`).toBe(7)
      expect(EXCLUDE_FALLBACK.includes(id), `${id} must NOT be in EXCLUDE_FALLBACK`).toBe(false)
    }
    expect(TIER_LABEL[7]).toBe('Image')
  })
})

// #756 — pin the image-generation sibling config (Black Forest Labs / FLUX) added so Stability AI is
// no longer a single-service category. A wrong source URL / component id would silently break incident
// or uptime matching with no runtime signal, so pin the load-bearing fields (verified 2026-06-24).
// Mirrors observability-services-config.test.ts (#601).

import { describe, it, expect } from 'vitest'
import { SERVICES, resolveSvcComponents, MODEL_GROUP } from '../services'
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
    // Primary (uptime parsing / calendar) = the developer-facing API component.
    expect(s!.statusComponentId).toBe('ws9rrzk6n2j7')
    // Badge worst-of (#379): API + the "Image Generation Services" group roll-up.
    expect(s!.statusComponentIds).toEqual(['ws9rrzk6n2j7', 'm991l9z7y6jj'])
    // Single-tenant page → no incidentKeywords needed.
    expect(s!.incidentKeywords).toBeUndefined()
  })

  it('BFL uses the displayAllComponents per-model breakdown (#606)', () => {
    const s = SERVICES.find((x) => x.id === 'bfl')!
    expect(s.displayAllComponents).toBe(true)
    expect(s.componentSurfaces).toEqual(['API (api.bfl.ai)', 'Finetuning'])
    // The group-header component is denylisted so it isn't double-counted with its children.
    expect(s.componentDenylist).toEqual(['Image Generation Services'])
  })

  it('breakdown keeps API + Finetuning individual and folds FLUX models into the Models group', () => {
    const s = SERVICES.find((x) => x.id === 'bfl')!
    const summary = {
      components: [
        { id: 'ws9rrzk6n2j7', name: 'API (api.bfl.ai)', status: 'operational' },
        { id: '8jg9v8zhstys', name: 'Finetuning', status: 'operational' },
        { id: 'm991l9z7y6jj', name: 'Image Generation Services', status: 'operational' },
        { id: 'lzj5bpsmhwt6', name: 'FLUX 1.1 [pro]', status: 'operational' },
        { id: 'k1f1dgrqqc9g', name: 'FLUX.2', status: 'degraded_performance' },
      ],
    }
    const comps = resolveSvcComponents(s, summary)
    const byName = Object.fromEntries(comps.map((c) => [c.name, c]))
    // Denylisted group-header is absent.
    expect(byName['Image Generation Services']).toBeUndefined()
    // Surfaces stay ungrouped.
    expect(byName['API (api.bfl.ai)'].group).toBeUndefined()
    expect(byName['Finetuning'].group).toBeUndefined()
    // FLUX model tiers fold into the collapsed Models group.
    expect(byName['FLUX 1.1 [pro]'].group).toBe(MODEL_GROUP)
    expect(byName['FLUX.2'].group).toBe(MODEL_GROUP)
  })

  it('Stability + BFL share fallback tier 7 (Image) and neither is excluded', () => {
    for (const id of ['stability', 'bfl']) {
      expect(API_TIER[id], `${id} tier`).toBe(7)
      expect(EXCLUDE_FALLBACK.includes(id), `${id} must NOT be in EXCLUDE_FALLBACK`).toBe(false)
    }
    expect(TIER_LABEL[7]).toBe('Image')
  })
})

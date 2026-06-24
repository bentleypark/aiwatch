// #758 — pin the fal.ai service config. fal is a generative-media inference platform (image/video/
// audio/3D, 600+ models) added as a Replicate/Hugging Face peer. Its status page is Instatus (Next.js),
// so it reuses the Perplexity config shape: a wrong statusComponent / incidentKeywords would silently
// break uptime parsing or badge scoping with no runtime signal — pin the load-bearing fields.
// Mirrors image-services-config.test.ts (#756) / observability-services-config.test.ts (#601).

import { describe, it, expect } from 'vitest'
import { SERVICES } from '../services'
import { EXCLUDE_FALLBACK, API_TIER } from '../fallback'
import { PROBE_TARGETS } from '../probe'

describe('#758 fal.ai inference service config', () => {
  it('fal is an Instatus (Next.js) service scoped to the API component', () => {
    const s = SERVICES.find((x) => x.id === 'fal')
    expect(s, 'fal missing from SERVICES').toBeDefined()
    expect(s!.name).toBe('fal.ai')
    expect(s!.provider).toBe('fal')
    expect(s!.category).toBe('api')
    // Instatus page — scraped via instatusUrl, no Atlassian summary.json.
    expect(s!.apiUrl).toBeNull()
    expect(s!.statusUrl).toBe('https://status.fal.ai')
    expect(s!.instatusUrl).toBe('https://status.fal.ai')
    // statusComponent 'API' drives the official uptime% (parseInstatusNextUptime).
    expect(s!.statusComponent).toBe('API')
    // incidentKeywords ['api'] scopes the badge/list to API-affecting incidents (drops Website-only).
    expect(s!.incidentKeywords).toEqual(['api'])
  })

  it('fal is excluded from fallback (self-serve inference platform, like Replicate/Hugging Face)', () => {
    expect(EXCLUDE_FALLBACK.includes('fal'), 'fal must be in EXCLUDE_FALLBACK').toBe(true)
    // Excluded peers carry no API_TIER entry (never surface as the affected service in a fallback flow).
    expect(API_TIER['fal']).toBeUndefined()
    expect(EXCLUDE_FALLBACK.includes('replicate')).toBe(true)
    expect(EXCLUDE_FALLBACK.includes('huggingface')).toBe(true)
  })

  it('fal has a probe target on the real inference gateway', () => {
    const t = PROBE_TARGETS.find((x) => x.id === 'fal')
    expect(t, 'fal probe target missing').toBeDefined()
    expect(t!.url).toBe('https://fal.run/fal-ai/flux/dev')
  })
})

import { describe, it, expect } from 'vitest'
import { edgeFallbackLead } from '../edge-fallback-text'

describe('edgeFallbackLead', () => {
  it('is-down: the degraded-page text, with the CDN copy mentioned', () => {
    const lead = edgeFallbackLead('is-down', 'worker_timeout')
    expect(lead).toContain('Status data is temporarily unavailable')
    expect(lead).toContain('stale-if-error')
  })

  it.each(['worker_http_502', 'parse_error', 'worker_unreachable', 'unexpected_error'])('is-down-group %s: names the family page and claims nothing the reason does not carry', (reason) => {
    const lead = edgeFallbackLead('is-down-group', reason)
    expect(lead).toContain('family page')
    expect(lead).toContain('stale-if-error')
    expect(lead).not.toContain('temporarily unavailable')
    expect(lead).not.toContain('"unknown"')
    expect(lead).not.toContain('fetch failed')
  })

  it.each(['reports'])('%s: names its GitHub Pages upstream and claims nothing about the Worker', (surface) => {
    const lead = edgeFallbackLead(surface, 'upstream_502')
    expect(lead).toContain('GitHub Pages')
    expect(lead).not.toContain('Worker fetch')
    expect(lead).not.toContain('temporarily unavailable')
  })

  it.each(['is-down', 'is-down-group'])('%s: a served-copy reason says the page came from the last-good copy', (surface) => {
    expect(edgeFallbackLead(surface, 'worker_http_502_served_copy')).toContain('last-good copy in Vercel Blob')
  })

  it.each([
    ['is-down', 'worker_timeout', true],
    ['is-down', 'service_missing', true],
    ['is-down', 'worker_timeout_served_copy', false],
    ['is-down-group', 'worker_http_502', true],
    ['is-down-group', 'service_missing', false],
    ['is-down-group', 'worker_http_502_served_copy', false],
    ['reports', 'upstream_502', false],
  ] as const)('%s / %s: mentions the CDN copy: %s', (surface, reason, mentions) => {
    expect(edgeFallbackLead(surface, reason).includes('stale-if-error')).toBe(mentions)
  })

  it.each(['is-down', 'is-down-group'])('%s: service_missing names the id lists to compare and claims nothing about the Worker answer', (surface) => {
    const lead = edgeFallbackLead(surface, 'service_missing')
    expect(lead).toContain('SLUG_TO_SERVICE or FAMILY_GROUPS')
    expect(lead).toContain('worker/src/services.ts')
    expect(lead).not.toContain('200')
    expect(lead).not.toContain('"unknown"')
    expect(lead).not.toContain('temporarily unavailable')
    expect(lead).not.toContain('fetch failed')
  })
})

import { describe, it, expect } from 'vitest'
import { buildShareUrl } from '../_is-down/share-url'
import { renderShareButtons, type ServiceData } from '../_is-down/html-template'
import type { ServiceSEO } from '../_is-down/seo-content'

const CANON = 'https://ai-watch.dev/is-claude-down'

const SEO: ServiceSEO = { displayName: 'Claude', description: '', insight: '', whenDown: '', faqs: [] }
const incident = (id: string, status = 'investigating') => ({
  id, title: 'Elevated errors', status, impact: 'major', startedAt: '2026-07-18T00:00:00Z', duration: null,
})
const svc = (status: string, incidents: ServiceData['incidents'] = []): ServiceData => ({
  id: 'claude', name: 'Claude', provider: 'Anthropic', category: 'api', status,
  latency: null, uptime30d: null, lastChecked: '', incidents, aiwatchScore: null, scoreGrade: null,
})

describe('buildShareUrl — UTM (#842-B) + OG pin (#1063)', () => {
  it('pins ?e=<status> AND tags campaign=outage per channel', () => {
    // #1063: the shared URL now leads with the OG status pin (?e=), then the #842-B UTM.
    expect(buildShareUrl(CANON, 'down', 'x')).toBe(
      `${CANON}?e=down&utm_source=x&utm_medium=social&utm_campaign=outage`,
    )
    expect(buildShareUrl(CANON, 'down', 'threads')).toBe(
      `${CANON}?e=down&utm_source=threads&utm_medium=social&utm_campaign=outage`,
    )
    expect(buildShareUrl(CANON, 'down', 'copy')).toBe(
      `${CANON}?e=down&utm_source=copy-link&utm_medium=share&utm_campaign=outage`,
    )
  })

  it('pins e=degraded on a degraded share (outage-moment audience)', () => {
    const u = buildShareUrl(CANON, 'degraded', 'x')
    expect(u).toContain('e=degraded')
    expect(u).toContain('utm_source=x')
    expect(u).toContain('utm_campaign=outage')
  })

  it('appends &i=<incidentToken> when an incident is active — the per-outage card identity (#804)', () => {
    expect(buildShareUrl(CANON, 'down', 'x', 'g613ntyj2pwf')).toBe(
      `${CANON}?e=down&utm_source=x&utm_medium=social&utm_campaign=outage&i=g613ntyj2pwf`,
    )
    // absent/null token → pin without a per-incident identity (still a fresh card vs operational)
    expect(buildShareUrl(CANON, 'down', 'x', null)).not.toContain('&i=')
    expect(buildShareUrl(CANON, 'down', 'x')).not.toContain('&i=')
  })

  it('url-encodes an incident token with query-unsafe chars', () => {
    expect(buildShareUrl(CANON, 'down', 'x', 'a&b=c')).toContain('&i=a%26b%3Dc')
  })

  it('the built outage URL parses back to the e/i params the destination page reads (non-bare og:url)', () => {
    // The pin only works if is-down.ts's url.searchParams.get('e'|'i') sees them — prove they survive.
    const params = new URL(buildShareUrl(CANON, 'degraded', 'x', 'inc1')).searchParams
    expect(params.get('e')).toBe('degraded')
    expect(params.get('i')).toBe('inc1')
  })

  it('leaves canonical untouched for non-outage statuses (no URL — no pin — is shared then)', () => {
    expect(buildShareUrl(CANON, 'operational', 'x')).toBe(CANON)
    expect(buildShareUrl(CANON, 'unknown', 'copy')).toBe(CANON)
    // a token never resurrects a URL for a non-outage status
    expect(buildShareUrl(CANON, 'operational', 'x', 'inc1')).toBe(CANON)
  })
})

// Guards the WIRING: a regression that reverts a share URL → bare canonical (the exact bug #1063
// fixes) or drops the incident token would slip past the pure-fn test above but fail here.
// Deterministic given status + incidents (the random text templates don't touch the share URLs).
describe('renderShareButtons pin + UTM wiring (#1063 / #842-B)', () => {
  it('pins e= AND tags UTM on the X, Threads and Copy share URLs of a down page', () => {
    const html = renderShareButtons(SEO, svc('down'), CANON, '')
    // X + Threads embed encodeURIComponent(buildShareUrl(...)) → ?→%3F, =→%3D, &→%26
    expect(html).toContain('e%3Ddown%26utm_source%3Dx%26utm_medium%3Dsocial%26utm_campaign%3Doutage')
    expect(html).toContain('e%3Ddown%26utm_source%3Dthreads')
    // Copy embeds the raw URL in an HTML-escaped data-text attribute (&→&amp;)
    expect(html).toContain('e=down&amp;utm_source=copy-link&amp;utm_medium=share&amp;utm_campaign=outage')
  })

  it('threads the active incident id into every share URL as &i= (#804 card identity)', () => {
    const html = renderShareButtons(SEO, svc('degraded', [incident('g613ntyj2pwf')]), CANON, '')
    expect(html).toContain('e%3Ddegraded')          // pinned
    expect(html).toContain('%26i%3Dg613ntyj2pwf')   // X/Threads encoded &i=
    expect(html).toContain('&amp;i=g613ntyj2pwf')    // copy data-text &i=
  })

  it('skips resolved incidents when choosing the token — only an ACTIVE outage pins an identity', () => {
    const html = renderShareButtons(SEO, svc('degraded', [incident('res1', 'resolved'), incident('act2')]), CANON, '')
    expect(html).toContain('i%3Dact2')
    expect(html).not.toContain('i%3Dres1')
  })

  it('picks the FIRST unresolved incident when several are active (most-recent-first order)', () => {
    const html = renderShareButtons(SEO, svc('degraded', [incident('a1'), incident('a2')]), CANON, '')
    expect(html).toContain('i%3Da1')
    expect(html).not.toContain('i%3Da2')
  })

  it('still pins e= with no &i= when there is no active incident (empty list)', () => {
    const html = renderShareButtons(SEO, svc('down'), CANON, '')
    expect(html).toContain('e%3Ddown')
    expect(html).not.toContain('%26i%3D')
  })

  it('pins e= with no &i= when the list is non-empty but every incident is resolved', () => {
    // Distinct branch from the empty list: `find` returns undefined (not `?.` short-circuit). A
    // regression to `incidents[0].id` (take-first-regardless) would ship a resolved id here.
    const html = renderShareButtons(SEO, svc('degraded', [incident('res1', 'resolved'), incident('res2', 'resolved')]), CANON, '')
    expect(html).toContain('e%3Ddegraded')
    expect(html).not.toContain('%26i%3D')
  })

  it('shares the BARE canonical (no pin, no UTM) on an unknown page — unknown is not an outage status', () => {
    // Documents the corrected contract: unknown DOES share a URL (the bare canonical), unlike
    // operational (text-only). It carries no ?e= (not a HINT_TO_OG_STATUS key) and no UTM.
    const html = renderShareButtons(SEO, svc('unknown'), CANON, '')
    expect(html).toContain(encodeURIComponent(CANON)) // a URL IS shared…
    expect(html).not.toContain('e%3D')                // …but unpinned…
    expect(html).not.toContain('utm_')                // …and untagged
  })

  it('shares no URL (no pin, no UTM) on an operational page (text-only share)', () => {
    const html = renderShareButtons(SEO, svc('operational'), CANON, '')
    expect(html).not.toContain('utm_')
    expect(html).not.toContain('e%3D')
  })
})

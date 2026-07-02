import { describe, it, expect } from 'vitest'
import { buildShareUrl } from '../is-down/share-url'
import { renderShareButtons, type ServiceData } from '../is-down/html-template'
import type { ServiceSEO } from '../is-down/seo-content'

const CANON = 'https://ai-watch.dev/is-claude-down'

const SEO: ServiceSEO = { displayName: 'Claude', description: '', insight: '', whenDown: '', faqs: [] }
const svc = (status: string): ServiceData => ({
  id: 'claude', name: 'Claude', provider: 'Anthropic', category: 'api', status,
  latency: null, uptime30d: null, lastChecked: '', incidents: [], aiwatchScore: null, scoreGrade: null,
})

describe('buildShareUrl (#842-B)', () => {
  it('tags an outage (down) share per channel with campaign=outage', () => {
    expect(buildShareUrl(CANON, 'down', 'x')).toBe(
      `${CANON}?utm_source=x&utm_medium=social&utm_campaign=outage`,
    )
    expect(buildShareUrl(CANON, 'down', 'threads')).toBe(
      `${CANON}?utm_source=threads&utm_medium=social&utm_campaign=outage`,
    )
    expect(buildShareUrl(CANON, 'down', 'copy')).toBe(
      `${CANON}?utm_source=copy-link&utm_medium=share&utm_campaign=outage`,
    )
  })

  it('tags a degraded share too (outage-moment audience)', () => {
    expect(buildShareUrl(CANON, 'degraded', 'x')).toContain('utm_source=x')
    expect(buildShareUrl(CANON, 'degraded', 'x')).toContain('utm_campaign=outage')
  })

  it('leaves canonical untouched for non-outage statuses (no URL is shared then)', () => {
    expect(buildShareUrl(CANON, 'operational', 'x')).toBe(CANON)
    expect(buildShareUrl(CANON, 'unknown', 'copy')).toBe(CANON)
  })

  it('uses & as the separator when the URL already has a query string', () => {
    expect(buildShareUrl(`${CANON}?e=down`, 'down', 'x')).toBe(
      `${CANON}?e=down&utm_source=x&utm_medium=social&utm_campaign=outage`,
    )
  })
})

// Guards the WIRING: a regression that reverts copyShareUrl→canonical (the exact bug this fixes)
// would slip past the pure-fn test above but fail here. Deterministic given status + canonical
// (the random text templates don't touch the share URLs), so no prod-data dependency.
describe('renderShareButtons UTM wiring (#842-B)', () => {
  it('tags the X, Threads and Copy share URLs on a down page', () => {
    const html = renderShareButtons(SEO, svc('down'), CANON, '')
    // X + Threads embed encodeURIComponent(buildShareUrl(...)) → &→%26
    expect(html).toContain('utm_source%3Dx%26utm_medium%3Dsocial%26utm_campaign%3Doutage')
    expect(html).toContain('utm_source%3Dthreads%26utm_medium%3Dsocial%26utm_campaign%3Doutage')
    // Copy embeds the raw URL in an HTML-escaped data-text attribute (&→&amp;)
    expect(html).toContain('utm_source=copy-link&amp;utm_medium=share&amp;utm_campaign=outage')
  })

  it('tags a degraded page too', () => {
    expect(renderShareButtons(SEO, svc('degraded'), CANON, '')).toContain('utm_campaign%3Doutage')
  })

  it('shares no UTM on an operational page (text-only share)', () => {
    expect(renderShareButtons(SEO, svc('operational'), CANON, '')).not.toContain('utm_')
  })
})

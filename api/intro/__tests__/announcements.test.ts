import { describe, it, expect } from 'vitest'
import {
  resolveAnnouncement,
  resolveAnnouncementFrom,
  ANNOUNCEMENTS,
  type AnnouncementMap,
} from '../announcements'
import { renderLandingPage } from '../html-template'
import handler from '../../intro'

const FIXTURE: AnnouncementMap = {
  launch: { html: '🚀 We launched', href: 'https://ai-watch.dev/' },
  notice: { html: 'Heads up' },
}

describe('resolveAnnouncementFrom', () => {
  it('returns null for empty / missing keys', () => {
    expect(resolveAnnouncementFrom(FIXTURE, null)).toBeNull()
    expect(resolveAnnouncementFrom(FIXTURE, undefined)).toBeNull()
    expect(resolveAnnouncementFrom(FIXTURE, '')).toBeNull()
  })

  it('returns null for unknown keys', () => {
    expect(resolveAnnouncementFrom(FIXTURE, 'does-not-exist')).toBeNull()
  })

  it('returns the matching announcement with id derived from the key', () => {
    expect(resolveAnnouncementFrom(FIXTURE, 'launch')).toEqual({
      id: 'launch',
      html: '🚀 We launched',
      href: 'https://ai-watch.dev/',
    })
    expect(resolveAnnouncementFrom(FIXTURE, 'notice')).toEqual({ id: 'notice', html: 'Heads up' })
  })

  it('does not resolve inherited / prototype keys', () => {
    expect(resolveAnnouncementFrom(FIXTURE, '__proto__')).toBeNull()
    expect(resolveAnnouncementFrom(FIXTURE, 'constructor')).toBeNull()
    expect(resolveAnnouncementFrom(FIXTURE, 'hasOwnProperty')).toBeNull()
  })
})

describe('resolveAnnouncement (default config)', () => {
  it('ships with no active announcements so the banner is hidden by default', () => {
    expect(Object.keys(ANNOUNCEMENTS)).toHaveLength(0)
    expect(resolveAnnouncement('anything')).toBeNull()
    expect(resolveAnnouncement(null)).toBeNull()
  })
})

describe('renderLandingPage announcement banner', () => {
  it('omits the banner element entirely when no announcement is given', () => {
    const html = renderLandingPage()
    expect(html).not.toContain('id="announcement-banner"')
    expect(html).not.toContain('Product Hunters')
    expect(html).not.toContain('producthunt.com')
  })

  it('renders a link banner (with rel=noopener + GA4 tracking) when an announcement has an href', () => {
    const html = renderLandingPage({ announcement: { id: 'launch', html: '🚀 We launched', href: 'https://ai-watch.dev/' } })
    expect(html).toContain('id="announcement-banner"')
    expect(html).toContain('🚀 We launched')
    expect(html).toContain('href="https://ai-watch.dev/"')
    // click-through must open safely and be tracked
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
    expect(html).toContain("click_announcement")
    expect(html).toContain("id:'launch'")
  })

  it('renders a plain span banner (no anchor, no tracking) when an announcement has no href', () => {
    const html = renderLandingPage({ announcement: { id: 'notice', html: 'Heads up' } })
    // isolate the banner element to assert directly on its markup
    const banner = html.slice(html.indexOf('id="announcement-banner"'))
    const bannerEl = banner.slice(0, banner.indexOf('</div>') + 6)
    expect(bannerEl).toContain('Heads up')
    expect(bannerEl).not.toContain('<a ')
    expect(bannerEl).not.toContain('onclick')
    expect(bannerEl).not.toContain('click_announcement')
  })
})

describe('intro handler wiring (?banner → resolve → render)', () => {
  const get = (path: string) => handler(new Request(`https://ai-watch.dev${path}`))

  it('serves /intro with a static, query-independent cache policy and no Vary', async () => {
    const res = await get('/intro')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=3600, stale-while-revalidate=86400')
    expect(res.headers.get('Vary')).toBeNull()
  })

  it('reads ?banner but renders no banner for an unknown key (empty default map)', async () => {
    const res = await get('/intro?banner=anything')
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).not.toContain('id="announcement-banner"')
  })

  it('no longer reacts to the old ?ref=producthunt trigger', async () => {
    const html = await (await get('/intro?ref=producthunt')).text()
    expect(html).not.toContain('id="announcement-banner"')
    expect(html).not.toContain('Product Hunters')
  })
})

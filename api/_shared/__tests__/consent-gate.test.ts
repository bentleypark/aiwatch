// #2070 — no gtag.js and no GA4 queue on an Edge page until analytics consent is 'granted'. The shipped
// inline scripts are executed, so a loader that comes back as a `<script src>` tag or a `gtag` defined
// before consent fails here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { consentInitScript, GA4_MEASUREMENT_ID } from '../consent-init'
import { cookieBannerHtml } from '../cookie-banner'
import { extractInlineScripts } from '../csp-hash'

const KEY = 'aiwatch-cookie-consent'
const LOADER = `https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}`

type GaWindow = { gtag?: (...a: unknown[]) => void; dataLayer?: ArrayLike<unknown>[]; aiwatchStartAnalytics?: () => void }
const w = window as unknown as GaWindow & { happyDOM: { settings: { disableJavaScriptFileLoading: boolean } } }

const loaders = () => [...document.querySelectorAll('script[src*="googletagmanager.com"]')] as HTMLScriptElement[]
const queued = () => (w.dataLayer ?? []).map((args) => Array.from(args))
const run = (html: string) => { for (const body of extractInlineScripts(html)) new Function(body)() }

function stubConsent(consent: string | null, opts: { read?: 'throws'; write?: 'throws' } = {}) {
  const store = new Map<string, string>(consent === null ? [] : [[KEY, consent]])
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => { if (opts.read === 'throws') throw new Error('no storage'); return store.get(k) ?? null },
    setItem: (k: string, v: string) => { if (opts.write === 'throws') throw new Error('quota'); store.set(k, v) },
  })
}

function loadPage(nonce?: string) {
  run(consentInitScript(nonce))
  const host = document.createElement('div')
  host.innerHTML = cookieBannerHtml(nonce)
  document.body.appendChild(host)
  run(cookieBannerHtml(nonce))
}

const click = (choice: 'accept' | 'essential') =>
  (document.querySelector(`[data-aiwatch-cb="${choice}"]`) as HTMLButtonElement).click()

const reset = () => {
  for (const s of loaders()) s.remove()
  document.body.innerHTML = ''
  delete w.gtag
  delete w.dataLayer
  delete w.aiwatchStartAnalytics
}

beforeEach(() => { w.happyDOM.settings.disableJavaScriptFileLoading = true; reset() })
afterEach(() => { vi.unstubAllGlobals(); reset() })

describe('Edge consent gate: nothing reaches Google before consent (#2070)', () => {
  it('ships no external script tag, so the browser requests nothing on its own', () => {
    expect(consentInitScript('N1')).not.toMatch(/<script[^>]*\ssrc=/)
  })

  it.each([
    ['no choice yet', null, {}],
    ['Essential Only', 'denied', {}],
    ['an unknown stored value', 'yes', {}],
    ['unreadable storage', 'granted', { read: 'throws' as const }],
  ])('%s: no loader, no gtag, no queue', (_label, consent, opts) => {
    stubConsent(consent, opts)
    loadPage()
    expect(loaders()).toHaveLength(0)
    expect(w.gtag).toBeUndefined()
    expect(w.dataLayer).toBeUndefined()
  })

  it('accepted earlier: loads gtag.js with analytics granted and the ad signals denied', () => {
    stubConsent('granted')
    loadPage()
    expect(loaders().map((s) => [s.src, s.async])).toEqual([[LOADER, true]])
    expect(queued().map((c) => c.slice(0, 2).map(String))).toEqual([
      ['js', expect.any(String)],
      ['consent', 'default'],
      ['consent', 'update'],
      ['config', GA4_MEASUREMENT_ID],
    ])
    expect(queued()[1][2]).toEqual({ analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' })
    expect(queued()[2][2]).toEqual({ analytics_storage: 'granted' })
  })

  it('stamps the injected loader with the nonce of the inline script', () => {
    stubConsent('granted')
    vi.spyOn(document, 'currentScript', 'get').mockReturnValue({ nonce: 'NONCE123' } as unknown as HTMLScriptElement)
    run(consentInitScript('NONCE123'))
    vi.restoreAllMocks()
    expect(loaders()[0].nonce).toBe('NONCE123')
  })

  it('Accept All starts GA on that page view, and events from before it are not replayed', () => {
    stubConsent(null)
    loadPage()
    // The guard every Edge click handler uses.
    if (typeof w.gtag === 'function') w.gtag('event', 'before_consent')
    click('accept')
    expect(loaders().map((s) => s.src)).toEqual([LOADER])
    expect(queued().map((c) => c[0])).toEqual(['js', 'consent', 'consent', 'config'])
  })

  it('Essential Only on the banner loads nothing', () => {
    stubConsent(null)
    loadPage()
    click('essential')
    expect(loaders()).toHaveLength(0)
    expect(w.gtag).toBeUndefined()
  })

  it('Accept All that cannot be stored loads nothing', () => {
    stubConsent(null, { write: 'throws' })
    loadPage()
    click('accept')
    expect(loaders()).toHaveLength(0)
    expect(w.gtag).toBeUndefined()
  })
})

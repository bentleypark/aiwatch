import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { consentInitScript } from '../consent-init'
import { cookieBannerHtml } from '../cookie-banner'
import { extractInlineScripts } from '../csp-hash'

const w = window as unknown as { happyDOM: { setURL(u: string): void; settings: { disableJavaScriptFileLoading: boolean } } }
const has = (name: string) => new RegExp(`(^|;\\s*)${name}=`).test(document.cookie)

function stubConsent(consent: string | null) {
  const store = new Map<string, string>(consent === null ? [] : [['aiwatch-cookie-consent', consent]])
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) })
}

beforeEach(() => {
  w.happyDOM.settings.disableJavaScriptFileLoading = true
  w.happyDOM.setURL('https://ai-watch.dev/is-claude-down')
  for (const n of ['_clck', '_clsk', '_ga']) document.cookie = `${n}=x;path=/`
})
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('Clarity first-party cookies are purged with the GA ones (#2024)', () => {
  it.each([['denied'], [null]])('Edge consent-init on load, consent %s', (consent) => {
    stubConsent(consent)
    for (const body of extractInlineScripts(consentInitScript())) new Function(body)()
    expect([has('_clck'), has('_clsk'), has('_ga')]).toEqual([false, false, false])
  })

  it('Edge consent-init leaves them when consent is granted', () => {
    stubConsent('granted')
    for (const body of extractInlineScripts(consentInitScript())) new Function(body)()
    expect([has('_clck'), has('_clsk')]).toEqual([true, true])
  })

  it('Edge banner Essential Only', () => {
    stubConsent(null)
    document.body.innerHTML = cookieBannerHtml()
    for (const body of extractInlineScripts(cookieBannerHtml())) new Function(body)()
    ;(document.querySelector('[data-aiwatch-cb="essential"]') as HTMLButtonElement).click()
    expect([has('_clck'), has('_clsk'), has('_ga')]).toEqual([false, false, false])
  })
})

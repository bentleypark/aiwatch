// #2024 — Microsoft Clarity session replay, for visitors who granted analytics consent only.
// Clarity is never loaded before consent: its no-consent mode still records, one id per page view
// (Clarity Consent API v2 docs).

// Same value as CLARITY_PROJECT_ID in api/_shared/clarity.ts (pinned by api/_shared/__tests__/clarity.test.ts).
export const CLARITY_ID = 'zfdscev1gz'
export const CLARITY_HOST = 'ai-watch.dev'

const ID_RE = /^[a-z0-9]{6,20}$/i

export function shouldLoadClarity({ id, consent, host }) {
  return host === CLARITY_HOST && ID_RE.test(id ?? '') && consent === 'granted'
}

export function clarityTagUrl(id) {
  return `https://www.clarity.ms/tag/${encodeURIComponent(id)}`
}

export const CLARITY_COOKIES = ['_clck', '_clsk']

export function clearClarityCookies() {
  const h = location.hostname
  const exp = 'expires=Thu, 01 Jan 1970 00:00:00 GMT'
  for (const n of CLARITY_COOKIES) {
    document.cookie = `${n}=;${exp};path=/;domain=.${h};SameSite=Lax`
    document.cookie = `${n}=;${exp};path=/;domain=${h};SameSite=Lax`
    document.cookie = `${n}=;${exp};path=/;SameSite=Lax`
  }
}

export function initClarity(consent, { id = CLARITY_ID, host = location.hostname } = {}) {
  if (consent === 'denied') clearClarityCookies()
  if (!shouldLoadClarity({ id, consent, host })) return false
  if (document.querySelector('script[src^="https://www.clarity.ms/tag/"]')) return false
  window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments) }
  window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' })
  const script = document.createElement('script')
  script.async = true
  script.src = clarityTagUrl(id)
  document.head.appendChild(script)
  return true
}

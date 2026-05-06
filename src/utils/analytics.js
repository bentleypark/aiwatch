// GA4 Analytics utility — all functions are no-op when VITE_GA4_ID is not set
// or when user has not consented to cookies.
// Usage: import { trackEvent, trackPageView, initGA, hasConsent, setConsent } from '../utils/analytics'

const GA_ID = import.meta.env.VITE_GA4_ID || ''
const IS_ENABLED = GA_ID.startsWith('G-')
const CONSENT_KEY = 'aiwatch-cookie-consent'

// Read consent state: 'granted' | 'denied' | null (not yet asked)
export function hasConsent() {
  try { return localStorage.getItem(CONSENT_KEY) } catch { return null }
}

// #352: ad_storage / ad_user_data / ad_personalization stay 'denied' even on Accept —
// AIWatch does not display advertisements and the Privacy Policy commits to this.
// Only `analytics_storage` flips to 'granted' when the user accepts.

// Remove _ga / _gid / _gcl_au cookies across all common scope variants (host-only,
// .domain, with/without subdomain). Idempotent — safe to call when no cookies exist.
function clearAnalyticsCookies() {
  const hostname = location.hostname
  const expire = 'expires=Thu, 01 Jan 1970 00:00:00 GMT'
  document.cookie.split(';').forEach((c) => {
    const name = c.split('=')[0].trim()
    if (name.startsWith('_ga') || name.startsWith('_gid') || name.startsWith('_gcl_au')) {
      document.cookie = `${name}=;${expire};path=/;domain=.${hostname};SameSite=Lax`
      document.cookie = `${name}=;${expire};path=/;domain=${hostname};SameSite=Lax`
      document.cookie = `${name}=;${expire};path=/;SameSite=Lax`
    }
  })
}

// Save consent and initialize or disable GA4 accordingly.
// Accept-failure gating mirrors the inline cookie banner (api/_shared/cookie-banner.ts):
// if persisting `'granted'` to localStorage throws (quota exceeded, disabled storage,
// sandboxed contexts), do NOT call initGA() AND return false so the caller can keep
// the banner visible. Otherwise the page-view runs under upgraded consent that was
// never stored — next page load the banner reappears and the user thinks Accept did
// nothing, while GA4 already wrote `_ga` cookies for this session. The Essential-Only
// branch always returns true: the default state is already denied so the banner is
// safe to dismiss even when persistence failed.
// Returns true when the user's choice was applied (banner should hide), false when
// Accept failed to persist (banner should stay visible so the user can retry).
export function setConsent(granted) {
  let stored = false
  try {
    localStorage.setItem(CONSENT_KEY, granted ? 'granted' : 'denied')
    stored = true
  } catch { /* ignore — handled via `stored` flag below */ }
  if (granted) {
    if (!stored) return false
    initGA()
    return true
  }
  // Revoke: disable GA and remove cookies
  if (window.gtag) {
    window.gtag('consent', 'update', {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    })
  }
  clearAnalyticsCookies()
  return true
}

// Set consent default to denied — called at app startup before any GA interaction.
// Also reconciles state: if a prior session left analytics cookies but consent is now
// 'denied' (e.g., user manually set localStorage to 'denied' without re-running the
// banner flow), purge them on this load. Mirrors the Edge SSR / Jekyll inline behavior
// so the Privacy Policy's documented "manual revoke" path actually works on the SPA.
export function initConsentDefault() {
  if (!IS_ENABLED) return
  window.dataLayer = window.dataLayer || []
  window.gtag = function () { window.dataLayer.push(arguments) }
  window.gtag('consent', 'default', {
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  })
  if (hasConsent() === 'denied') clearAnalyticsCookies()
}

// Dynamically inject gtag.js script and initialize GA4
export function initGA() {
  if (!IS_ENABLED) return
  if (hasConsent() !== 'granted') return

  // Avoid double-injection
  if (document.querySelector(`script[src*="googletagmanager"]`)) return

  const script = document.createElement('script')
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`
  document.head.appendChild(script)

  window.gtag('consent', 'update', { analytics_storage: 'granted' })
  window.gtag('js', new Date())
  window.gtag('config', GA_ID, {
    send_page_view: false, // We send page_view manually via trackPageView
  })
}

// Track page view — called on SPA page transitions
export function trackPageView(pageName, params = {}) {
  if (!IS_ENABLED || hasConsent() !== 'granted') return
  window.gtag?.('event', 'page_view', {
    page_title: pageName,
    ...params,
  })
}

// Track custom event
export function trackEvent(eventName, params = {}) {
  if (!IS_ENABLED || hasConsent() !== 'granted') return
  window.gtag?.('event', eventName, params)
}

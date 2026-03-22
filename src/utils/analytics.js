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

// Save consent and initialize or disable GA4 accordingly
export function setConsent(granted) {
  try { localStorage.setItem(CONSENT_KEY, granted ? 'granted' : 'denied') } catch { /* ignore */ }
  if (granted) {
    initGA()
  } else {
    // Revoke: disable GA and remove cookies
    if (window.gtag) {
      window.gtag('consent', 'update', { analytics_storage: 'denied' })
    }
    // Remove GA cookies (_ga, _gid) with multiple domain variants for reliability
    document.cookie.split(';').forEach((c) => {
      const name = c.split('=')[0].trim()
      if (name.startsWith('_ga') || name.startsWith('_gid')) {
        const hostname = location.hostname
        const expire = 'expires=Thu, 01 Jan 1970 00:00:00 GMT'
        document.cookie = `${name}=;${expire};path=/;domain=.${hostname};SameSite=Lax`
        document.cookie = `${name}=;${expire};path=/;domain=${hostname};SameSite=Lax`
        document.cookie = `${name}=;${expire};path=/;SameSite=Lax`
      }
    })
  }
}

// Set consent default to denied — called at app startup before any GA interaction
export function initConsentDefault() {
  if (!IS_ENABLED) return
  window.dataLayer = window.dataLayer || []
  window.gtag = function () { window.dataLayer.push(arguments) }
  window.gtag('consent', 'default', { analytics_storage: 'denied' })
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

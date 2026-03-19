// GA4 Analytics utility — all functions are no-op when VITE_GA4_ID is not set.
// Usage: import { trackEvent, trackPageView } from '../utils/analytics'

const GA_ID = import.meta.env.VITE_GA4_ID || ''
const IS_ENABLED = GA_ID.startsWith('G-')

// Dynamically inject gtag.js script and initialize GA4
export function initGA() {
  if (!IS_ENABLED) return

  // Avoid double-injection
  if (document.querySelector(`script[src*="googletagmanager"]`)) return

  const script = document.createElement('script')
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`
  document.head.appendChild(script)

  window.dataLayer = window.dataLayer || []
  window.gtag = function () { window.dataLayer.push(arguments) }
  window.gtag('js', new Date())
  window.gtag('config', GA_ID, {
    send_page_view: false, // We send page_view manually via trackPageView
  })
}

// Track page view — called on SPA page transitions
export function trackPageView(pageName, params = {}) {
  if (!IS_ENABLED) return
  window.gtag?.('event', 'page_view', {
    page_title: pageName,
    ...params,
  })
}

// Track custom event
export function trackEvent(eventName, params = {}) {
  if (!IS_ENABLED) return
  window.gtag?.('event', eventName, params)
}

// Hash-based SPA routing helpers (no React Router). Extracted from App.jsx so the
// routing logic — including the #673 legacy #about-score → /methodology#score redirect —
// is unit-testable without mounting the whole App tree.
import { ALL_SERVICE_IDS } from './constants'

export const PAGE_NAMES = ['overview', 'latency', 'incidents', 'uptime', 'settings', 'ranking', 'statusline']

// #546: a `?focus=<section>` suffix on a page hash (e.g. #settings?focus=alerts from the
// Is-X-Down "Notify Me When Fixed" CTA) deep-links to a section so the outage visitor isn't
// dropped at the page top. The page id itself is still split off before this, so routing is unaffected.
export function hashToFocus(hash) {
  const q = hash.split('?')[1]
  return q ? new URLSearchParams(q).get('focus') : null
}

export function hashToPage(hash) {
  const id = hash.replace(/^#/, '').split(/[?&#]/)[0]
  if (!id) return { name: 'overview' }
  // #673: the in-dashboard #about-score page was unified into the public /methodology page.
  // Redirect legacy hash links (bookmarks + the monthly report's ai-watch.dev/#about-score)
  // to the Score section of the new page so nothing 404s.
  if (id === 'about-score') {
    window.location.replace('/methodology#score')
    return { name: 'overview' }
  }
  if (PAGE_NAMES.includes(id)) {
    const page = { name: id }
    if (id === 'settings') {
      const focus = hashToFocus(hash)
      if (focus) page.focus = focus
    }
    return page
  }
  if (ALL_SERVICE_IDS.includes(id)) return { name: 'service', serviceId: id }
  // Invalid hash — clean up URL and fallback to overview
  window.history.replaceState(null, '', window.location.pathname)
  return { name: 'overview' }
}

export function pageToHash(page) {
  if (page.name === 'service') return `#${page.serviceId}`
  if (page.name === 'overview') return ''
  return `#${page.name}`
}

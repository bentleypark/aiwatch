const CDN_COPY_NOTE = ' Visitors may still have received the CDN\'s last good copy (`stale-if-error`, #1531).'

function leadText(surface: string, reason: string): string {
  if (reason.endsWith('_served_copy')) {
    return 'Vercel Edge rendered the page from the hourly last-good copy in Vercel Blob (#1531) because the upstream Worker fetch failed.'
  }
  if (reason === 'service_missing') {
    return 'A service id the Edge page asked for was not in the Worker status response it used. Compare the Edge id list (SLUG_TO_SERVICE or FAMILY_GROUPS) with worker/src/services.ts.'
  }
  if (surface === 'reports') {
    return 'The reports proxy could not get a good response from its upstream (GitHub Pages).'
  }
  if (surface === 'is-down-group') {
    return 'Vercel Edge served the family page in a degraded state.'
  }
  return 'Vercel Edge rendered the degraded "Status data is temporarily unavailable" page because the upstream Worker fetch failed.'
}

function cdnMayHaveAnswered(surface: string, reason: string): boolean {
  if (reason.endsWith('_served_copy')) return false
  if (surface === 'is-down') return true
  return surface === 'is-down-group' && reason !== 'service_missing'
}

export function edgeFallbackLead(surface: string, reason: string): string {
  return cdnMayHaveAnswered(surface, reason) ? leadText(surface, reason) + CDN_COPY_NOTE : leadText(surface, reason)
}

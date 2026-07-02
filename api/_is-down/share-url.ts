// Outage-share UTM tagging — #842-B (#547 attribution gap).
//
// The is-down share bar (X / Threads / Copy Link) shared the bare `canonical` page URL with NO UTM,
// so outage-moment inflow arriving via the X app — which strips the HTTP referrer — collapsed to
// GA4 `(direct)/(none)` (≈91% of the #547 outage analysis), making the outage-moment audience
// invisible by source. We tag the SHARED url per channel; the page's `<link rel=canonical>` stays
// clean for SEO (utm_* affect GA attribution ONLY, not the indexed URL — search/canonical dedup
// drop query params, and the is-down Edge ignores unknown ones, so the page renders identically).
// `campaign=outage` matches the operator X_UTM (alerts.ts) + the RSS/Reddit appendUtm
// (worker/src/utils.ts) so every share channel rolls up under one GA4 campaign.
//
// Scoped to outage shares only: the share bar attaches a URL solely on down/degraded (operational
// shares are text-only), which is precisely the outage-moment audience this is meant to attribute.

export type ShareChannel = 'x' | 'threads' | 'copy'

// medium: x/threads land as social; a copied link's destination is unknown, so tag it 'share'.
const CHANNEL_UTM: Record<ShareChannel, { source: string; medium: string }> = {
  x: { source: 'x', medium: 'social' },
  threads: { source: 'threads', medium: 'social' },
  copy: { source: 'copy-link', medium: 'share' },
}

/**
 * Append per-channel UTM to a shared is-down URL. Returns `canonical` unchanged for any non-outage
 * status (operational shares carry no URL anyway) so the tag only ever rides an outage-moment share.
 * Pure — safe to unit-test apart from the template. `sep` mirrors appendUtm (worker/src/utils.ts).
 */
export function buildShareUrl(canonical: string, status: string, channel: ShareChannel): string {
  if (status !== 'down' && status !== 'degraded') return canonical
  const { source, medium } = CHANNEL_UTM[channel]
  const sep = canonical.includes('?') ? '&' : '?'
  return `${canonical}${sep}utm_source=${source}&utm_medium=${medium}&utm_campaign=outage`
}

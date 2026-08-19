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
//
// #1063 — the shared URL ALSO carries the OG status pin `?e=<status>` (+ the per-incident `&i=<id>`
// token) the operator tweet path already emits (`buildTweetForService` in worker/src/alerts.ts).
// Without it the destination page renders a status-invariant BARE og:url, and X/Threads/FB dedupe the
// unfurled card BY og:url — so a public "Post" during an outage kept showing the pre-outage
// (operational) card X had cached from a routine crawl. `?e=` pins the card's status to the share
// moment; `&i=` (the active incident id) makes each outage a distinct og:url identity so the platform
// re-scrapes a fresh card (#804). We reuse `appendStatusHint` (the SAME `?e=` primitive the worker
// path uses) so the `?e=` PIN can't drift between the two surfaces. The `&i=` token is chosen by each
// CALLER, not here, and the rules differ — so two surfaces sharing one outage pool onto one card only
// when their callers happen to pick the same incident (#1243). `status` is only ever 'down'/'degraded' here
// (the early return below), both valid HINT_TO_OG_STATUS keys — no operational/unknown hint ever ships.

import { appendStatusHint } from '../../worker/src/utils'

export type ShareChannel = 'x' | 'threads' | 'copy'

// medium: x/threads land as social; a copied link's destination is unknown, so tag it 'share'.
const CHANNEL_UTM: Record<ShareChannel, { source: string; medium: string }> = {
  x: { source: 'x', medium: 'social' },
  threads: { source: 'threads', medium: 'social' },
  copy: { source: 'copy-link', medium: 'share' },
}

/**
 * Build a shared is-down URL for an outage: the OG status pin `?e=<status>` + per-channel UTM +
 * (when an incident is active) the `&i=<incidentToken>` card-identity token. Returns `canonical`
 * unchanged for `operational` (a text-only share, no URL) — and for any OTHER non-outage status
 * (`unknown`), where the caller still shares this BARE canonical: `unknown` isn't an outage status
 * and isn't a HINT_TO_OG_STATUS key, so it gets no pin and no UTM, just the plain page URL.
 * Ordering (`?e=` then `&utm_*` then `&i=`) mirrors the operator tweet path (`buildTweetForService`).
 * The utm params are stripped when the destination rebuilds og:url from just `e`+`i`, so the two
 * surfaces' resulting OG:URLS (not the shared links, which differ per channel by utm) pool onto one
 * card per outage. Pure — safe to unit-test apart from the template.
 */
export function buildShareUrl(
  canonical: string,
  status: string,
  channel: ShareChannel,
  incidentToken?: string | null,
): string {
  if (status !== 'down' && status !== 'degraded') return canonical
  const { source, medium } = CHANNEL_UTM[channel]
  const pinned = appendStatusHint(canonical, status) // …?e=down|degraded (canonical is query-less → '?')
  const tagged = `${pinned}&utm_source=${source}&utm_medium=${medium}&utm_campaign=outage`
  return incidentToken ? `${tagged}&i=${encodeURIComponent(incidentToken)}` : tagged
}

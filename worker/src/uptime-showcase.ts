// #1389 — Atlassian's lazy uptime showcase.
//
// On 2026-09-10 Atlassian Statuspage rolled out `LAZY_UPTIME_SHOWCASE`: the status document stopped
// embedding the `window.uptimeData = {…}` blob (a multi-MB inline payload that was truncating large
// pages) and now renders each eligible component as a `[data-uptime-lazy="<code>"]` placeholder, with
// the browser fetching the bars on scroll from `/uptime_showcase`. Every Atlassian-sourced service lost
// `uptime30d` that day, dropping from `high` to `medium` confidence and out of the primary ranking
// table (#1186) — and the parser returned null silently, because "no inline blob" is also the correct,
// expected outcome on an incident.io page.
//
// This module is the replacement transport, and ONLY the transport: the returned `timelines` object has
// the identical `{code: {days: [{date, outages: {p, m}}]}}` shape, so it feeds the same
// `computeUptimeData` the inline blob fed. AIWatch still COMPUTES uptime from the per-day outage
// seconds (#1006) — the response's own `values[]` (the provider's 30/60/90-day percentages) is read by
// nothing here on purpose.
//
// Payload shape, measured against the live endpoint 2026-09-11 (`status.cursor.com`, and the same
// shape on all 13 lazy pages): `{components, timelines, values}`, `timelines[code].days` = 90 entries,
// chronological oldest→newest — so the `slice(-windowDays)` tail assumption `computeUptimeDataSingle`
// has always made holds for this transport too. A component the page does not publish comes back as
// HTTP 200 with `timelines: {}`, NOT a 404.

import { parseUptimeShowcase, type UptimeTimelines } from './parsers/statuspage'
import { fetchWithTimeout } from './utils'

export function showcaseUrl(statusUrl: string, codes: string[]): string {
  return `${statusUrl.replace(/\/$/, '')}/uptime_showcase?components=${encodeURIComponent(codes.join(','))}`
}

/**
 * Fetch one page's uptime timelines. `null` on any failure — the caller then computes no uptime for
 * that cycle, which is what a failed inline-blob page already did.
 *
 * Fail-open by design: this must never be able to publish a WRONG uptime. Every failure mode (network
 * throw, non-2xx, non-JSON, no `timelines` key) yields null → `uptime30d: null` → the service falls
 * back to the no-uptime Score path, the state it is in today.
 *
 * Three outcomes, not two, and the third is the one the design turns on: real per-day data, an EMPTY
 * `{}` map (the page publishes nothing for the requested components — a real answer, and the caller
 * must fall through to the inline blob rather than treat it as data), or null (we could not read it).
 *
 * A SHORT response — some requested codes absent, from an id rotation or a server-side batch cap — is
 * deliberately returned as-is rather than failed closed. `computeUptimeData`'s multi-id branch already
 * takes the worst-of over whatever resolved and warns `N/M configured components absent`, naming the
 * service; that is the pre-existing behaviour of the inline path and this transport does not change it.
 * Warning again here would say less (no service id) and fire on every cycle for a page that is simply
 * publishing less than we ask for.
 */
export async function fetchUptimeShowcase(
  statusUrl: string,
  codes: string[],
  timeoutMs = 5000,
): Promise<UptimeTimelines | null> {
  if (codes.length === 0) return null
  let payload: unknown
  try {
    const res = await fetchWithTimeout(showcaseUrl(statusUrl, codes), timeoutMs, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      // Unexpected by construction — the caller only reaches here for a page that advertised lazy
      // placeholders — so it is worth a line. A page that has NOT rolled out the showcase answers 404,
      // which is why this is a warn and not an error.
      console.warn(`[uptime-showcase] ${statusUrl} returned HTTP ${res.status}`)
      res.body?.cancel()
      return null
    }
    payload = await res.json()
  } catch (err) {
    console.warn(`[uptime-showcase] ${statusUrl} fetch failed:`, err instanceof Error ? err.message : err)
    return null
  }
  const timelines = parseUptimeShowcase(payload)
  if (!timelines) {
    console.warn(`[uptime-showcase] ${statusUrl} answered 200 with no \`timelines\` object — upstream shape change?`)
    return null
  }
  return timelines
}

// #842-B — the consent-free outage-moment audience beacon, as one primitive both is-down surfaces
// emit.
//
// It was inline in `_is-down/html-template.ts` and therefore fired only on PER-SERVICE pages. #1193
// made that a measurement hole rather than a coverage gap: the operator Reddit block now hands out
// the provider GROUP link for a family-wide incident, so the visits it is supposed to measure landed
// on `/is-<family>-down` — a page that posted nothing, so a Reddit visitor arriving on a group link
// was invisible to `audienceBySource`. Extracted here so the second surface is a
// caller rather than a copy.
//
// `svc` MUST be a real service id: `parsePageviewBody` (worker/src/outage-audience.ts) validates it
// against SERVICES and drops the row otherwise, which would be a silent zero. A family slug is a URL
// slug, not necessarily a service id, so a family page passes one of its members instead.

/**
 * The beacon body, inlined into a `<script>` the caller already emits (both callers hash their own
 * page CSP over the rendered HTML, so there is nothing to register here).
 *
 * `active` is the SSR-time outage status. Both surfaces are edge-cached, so within that window a
 * cached page can tag a view with a stale flag — the metric is an approximate consent-free proxy,
 * documented as such on the worker side.
 *
 * `surface` (#1280) is what the WORKER cannot infer — each caller declares its own, because it is the
 * only place that knows. Why `svc` alone is not enough: worker/src/outage-audience.ts.
 */
export function audienceBeaconScript(svcId: string, active: boolean, surface: 'service' | 'group'): string {
  return `(function () {
  try {
    var u = new URLSearchParams(location.search).get('utm_source') || '';
    var r = '';
    try { if (document.referrer) r = new URL(document.referrer).hostname; } catch (e0) {}
    fetch('https://aiwatch-worker.p2c2kbf.workers.dev/api/pageview', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ svc: ${JSON.stringify(svcId)}, ref: r, utm: u, active: ${active ? 'true' : 'false'}, surface: ${JSON.stringify(surface)} }) }).catch(function () {});
  } catch (e1) {}
})();`
}

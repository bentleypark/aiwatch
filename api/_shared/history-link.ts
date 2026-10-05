// #1612 — the "30-day history" link to the dashboard Incidents page, and its consent-free click
// beacon, as one primitive the per-service and family is-down pages both emit.

function historyLinkHref(svcId: string): string {
  return `https://ai-watch.dev/#incidents?service=${encodeURIComponent(svcId)}&amp;period=30`
}

/** Attributes for one link; `svcId` must already be HTML-safe (a SERVICES id). */
export function historyLinkAttrs(svcId: string, gaLoc: 'is_down_page' | 'is_down_group_page'): string {
  return `href="${historyLinkHref(svcId)}" data-ga="click_incident_history" data-ga-loc="${gaLoc}" data-ga-svc="${svcId}"`
}

/** A statement for a delegated click listener that has the clicked element's dataset in `d`. */
export function historyClickBeacon(active: boolean, surface: 'service' | 'group'): string {
  return `if (d.ga === 'click_incident_history' && d.gaSvc) {
      try { fetch('https://aiwatch-worker.p2c2kbf.workers.dev/api/history-click', { method: 'POST', keepalive: true, body: JSON.stringify({ svc: d.gaSvc, active: ${active ? 'true' : 'false'}, surface: ${JSON.stringify(surface)} }) }).catch(function () {}); } catch (e3) {}
    }`
}

// Single source of the endpoints the extension talks to (#837).
// WORKER_BASE is the only cross-origin host the extension is granted in
// manifest.json host_permissions — it talks to the AIWatch API and NOTHING else.
//
// LOCAL VERIFY: to test against `wrangler dev`, temporarily set WORKER_BASE to
// 'http://localhost:8788' AND add 'http://localhost:8788/*' to manifest.json
// host_permissions. Revert BOTH before committing (the shipped build is prod-only).
export const WORKER_BASE = 'https://aiwatch-worker.p2c2kbf.workers.dev'
export const SITE_BASE = 'https://ai-watch.dev'

// The lite projection the extension polls (PR1 #841): the 3 Anthropic surfaces +
// status/score/grade/fallback + active incidents + gated crowd reports (~0.6 KB).
export const STATUS_URL = `${WORKER_BASE}/api/status/cached?src=ext-claude`
export const REPORT_URL = `${WORKER_BASE}/api/report-issue`
// Per-surface "Is X Down?" deep links are built from SITE_BASE + render.js isDownPath();
// the footer "Open full status" goes to the SITE_BASE dashboard (the whole board).

// #936 — tag the outbound site links so click-through inflow attributes to `utm_source=extension`
// instead of collapsing to (direct) — the extension carries no HTTP referrer. It's an always-on
// product surface, not an outage campaign, so source+medium only (no utm_campaign). Kept in plain JS
// here because the extension bundle cannot import the worker's appendUtm.
export function withExtUtm(url) {
  return `${url}${url.includes('?') ? '&' : '?'}utm_source=extension&utm_medium=referral`
}

// Poll cadence — 2 min (AIWatch data updates on the */5 cron; 2 min catches an
// alert-edge cache refresh #488 within ~2 min without redundant fetches). The popup
// always does a fresh fetch on open regardless of this cadence.
export const POLL_PERIOD_MINUTES = 2

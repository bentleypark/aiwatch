// #1369 — "has this browser already reported this service TODAY?", in one place.
//
// The server's rule (`worker/src/report.ts`) is one counted report per IP per service per UTC day:
// the dedup key is date-scoped AND carries an 86_400s TTL, so it rolls over on its own. The client
// guard exists only to reflect that rule in the UI, and it used to store a bare `'1'` — which
// localStorage never expires, so one report locked the service on that browser forever, while the
// copy ("You already reported this service today") promised otherwise.
//
// The fix stores the UTC date as the VALUE and gates on equality with today. UTC, not local, because
// `reportDateKey` in `worker/src/report.ts` is `toISOString().slice(0, 10)` — a local-date client
// would disagree with the server for part of every day in every non-UTC timezone.
//
// The date is in the value rather than the key on purpose: `aiwatch-reported-{svc}-{date}` would
// accumulate one dead entry per service per day in localStorage forever, with nothing to prune it.
//
// This module is the SPA's copy. The Edge is-down template carries the same rule as inline browser
// source (`REPORT_GUARD_CLIENT_JS` in `api/_is-down/html-template.ts`) because the two surfaces share
// no bundle — the Edge one is text emitted into a `<script>`, not an import. That duplication is
// deliberate and pinned by `api/_is-down/__tests__/report-guard-sync.test.ts`, which EXECUTES the
// shipped Edge source against these functions.

export const REPORT_GUARD_PREFIX = 'aiwatch-reported-'

/** localStorage key for one service's guard. One key per service, reused every day. */
export function reportGuardKey(svcId) {
  return `${REPORT_GUARD_PREFIX}${svcId}`
}

/** UTC date stamp `YYYY-MM-DD` — the stored value, and what today is compared against.
 *  Same expression as the server's `reportDateKey`. */
export function reportGuardDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10)
}

/** Has this browser already reported `svcId` today?
 *
 *  Equality with today's stamp, NOT presence — that is the whole fix. It also makes every browser
 *  currently locked out self-heal on first load: the legacy value is `'1'`, which is not a date, so
 *  the guard opens with no migration. A future-dated or garbage value likewise fails equality and
 *  opens the guard; failing OPEN is the right direction, since the server still dedups. */
export function hasReportedToday(svcId, now = Date.now()) {
  try {
    return localStorage.getItem(reportGuardKey(svcId)) === reportGuardDay(now)
  } catch {
    return false // private mode / storage disabled — never block the user on our own guard
  }
}

/** Record that `svcId` was reported today. */
export function markReportedToday(svcId, now = Date.now()) {
  try {
    localStorage.setItem(reportGuardKey(svcId), reportGuardDay(now))
  } catch {
    /* private mode — the server-side dedup still holds */
  }
}

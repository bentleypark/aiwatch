// #1389 / #957 — "this service stopped publishing uptime" operator alert.
//
// The gap this closes, in the words of the incident that forced it: on 2026-09-10 Atlassian moved the
// uptime payload off the status document, 14 services went to `uptime30d: null` in one cycle, and
// NOTHING said so. Every existing backstop keys on the source being unreachable —
// `checkPersistentFetchFailures` (#500) on 1h+ of failed fetches, `decideSourceDeadAction` (#689) on a
// 4xx, `trackComponentMiss` (#135) on a component id that no longer resolves — and here the page
// answered 200 with a perfectly good component list. Only the NUMBER was gone. The visible effect was
// confined to things nobody is paged about: the Score switching to the no-uptime path, and the service
// leaving the high-confidence ranking table (#1186).
//
// The signal is `trackUptimeReading` (utils.ts), which records per service WHEN the published
// `uptime30d` went missing, at the one place that sees the final value rather than any single parser's
// opinion. That placement is deliberate: it makes a vendor migration detectable by the same machinery
// as a payload shape change, because from the reader's side those are the same event.
//
// The tracker records the absence; this sweep reports it. Keep that split — two earlier attempts judged
// source readability per-cycle inside the tracker, and both were wrong: one froze an armed clock, the
// other could be starved by blip frequency. A wall-clock "since" has neither property.
//
// KNOWN, ACCEPTED OVERLAP: this asks nothing about what the other operator alerts are doing, so a
// service whose page is unreachable (#500), 4xx (#689) or whose component id rotated (#135) produces
// their message AND, 6h in, this one. Bounded — 7d dedup, and the 30d retention prune caps a permanent
// loss at roughly five sends before silence — and the two messages say different things (theirs names
// the source state, this one says how long the DATA has been gone).
//
// Three attempts to suppress that overlap were each wrong in a new way, and the third is why there is
// no fourth: the markers those alerts keep do not mean what suppression needs them to mean. #135 writes
// its marker even when the Discord POST fails (`index.ts`, and the #1179 block right below it says so
// about its older sibling), so suppressing on it would have silenced BOTH alerts for 24h about a
// service nobody was ever told about. #689 writes its marker while deliberately suppressing its own
// send under #800. And this sweep runs BEFORE two of the three writers in the cron, so a marker's TTL
// rollover lapsed the suppression once a day anyway. Trading a bounded duplicate for a possible silence
// is the wrong trade for a detector that exists because a silence cost a day (#1389).
//
// The one suppression that remains is `suppressedIds` — config-declared, not inferred from another
// alert's bookkeeping.
//
// Mirrors `persistent-failure.ts` in structure — sweep the tracking blob once per cron cycle, one
// Discord alert per service, deduped in KV, whole sweep wrapped so it can never affect the cron's main
// alert path.

import { kvPut, readTrackingState, shouldAlertUptimeMissing, formatUptimeMissingAlert, type KVLike } from './utils'

type DiscordSend = (
  webhookUrl: string,
  embed: { title: string; description: string; color: number },
) => Promise<boolean>

/** Re-alert cadence for a service whose uptime stays gone. 7 days, not the 24h the fetch-failure alert
 *  uses: an unreachable status page is often transient and worth a daily nudge, whereas a source that
 *  stopped publishing uptime is a CONFIG job — the fix is a code change (a new parser, a new component
 *  id, a new vendor), so re-asking daily while that PR is being written is pure noise. */
const UPTIME_MISSING_DEDUP_TTL_S = 604_800 // 7d

export async function checkUptimeLiveness(
  kv: KVLike | undefined,
  discordUrl: string | undefined,
  services: Array<{ id: string; name: string; statusUrl: string }>,
  nowMs: number,
  send: DiscordSend,
  // Services whose status source is a KNOWN, acknowledged dead end (`statusSourceDeactivated`, #800).
  // The operator already has an open item for those; a second alert saying the uptime is also gone adds
  // nothing. Same suppression set the persistent-failure sweep takes.
  suppressedIds: Set<string> = new Set(),
): Promise<void> {
  if (!kv || !discordUrl) return
  try {
    const byId = new Map(services.map((s) => [s.id, s]))
    // Read back from KV rather than taking the in-memory blob: this runs once per cron cycle, not per
    // service. KV is eventually consistent, so the sweep can see a blob one cycle stale — harmless,
    // because `uptimeMissingSince` is set once on the leading edge and never moves, which makes the
    // effective threshold "6h, plus at most one cycle" rather than a missed alert.
    const store = await readTrackingState(kv)
    for (const [svcId, entry] of Object.entries(store)) {
      if (suppressedIds.has(svcId)) continue
      if (!shouldAlertUptimeMissing(entry, nowMs)) continue
      // A service dropped from SERVICES keeps no entry (`fetchAllServices` prunes retired ids), but a
      // rename racing this sweep would leave one — skip rather than alert about an id with no page to
      // point the operator at.
      const svc = byId.get(svcId)
      if (!svc) continue
      const dedupKey = `alerted:uptime-missing:${svcId}`
      // A failed dedup READ falls toward alerting (the right direction — better a duplicate than a
      // miss), but it is logged: unlogged, a KV read outage re-sends every armed alert every five
      // minutes with nothing to explain why the operator is being spammed.
      let alreadySent: string | null = null
      try {
        alreadySent = await kv.get(dedupKey)
      } catch (err) {
        console.warn(`[cron] uptime-liveness dedup read failed for ${svcId} — may re-alert:`, err instanceof Error ? err.message : err)
      }
      if (alreadySent) continue
      const ok = await send(discordUrl, {
        title: `📉 ${svc.name} — uptime has stopped publishing`,
        description: formatUptimeMissingAlert(svc.name, entry.uptimeMissingSince!, entry.uptimeSeenAt, svc.statusUrl, nowMs),
        color: 0x9b59b6, // purple — a DATA-quality alarm, not a service outage (red) or a source block (amber)
      })
      // Only on a successful send, so a failed Discord POST retries next cron instead of being
      // swallowed by its own dedup marker. A failed WRITE is logged rather than discarded: it turns the
      // 7-day cadence into a five-minute loop, and at 7 days the silent version of that bug would take
      // a week of noise before anyone connected it to this key.
      if (ok && !(await kvPut(kv, dedupKey, '1', { expirationTtl: UPTIME_MISSING_DEDUP_TTL_S }))) {
        console.warn(`[cron] uptime-liveness alerted ${svcId} but could not persist ${dedupKey} — will re-alert next cycle`)
      }
    }
  } catch (err) {
    // The whole sweep, not per service: `sendDiscordAlert` and `kvPut` both catch internally and return
    // a boolean, and `readTrackingState` fails open, so nothing in the loop has a live throw path today.
    // This is the structural guarantee that the cron's main alert path cannot be taken down by this
    // one — the cost being that a future throwing `send` would drop the rest of the sweep, which on the
    // 2026-09-10 shape is 14 services at once.
    console.error('[cron] uptime-liveness check failed:', err instanceof Error ? err.message : err)
  }
}

// #1106 — withdrawn-incident tombstones.
//
// A provider sometimes DELETES an incident from its own status page instead of resolving it. The
// #975 phantom prune correctly removes the stranded accumulator row (see `prunePhantomIncidents`),
// but every notification channel that already fired a 🔴 New alert is then left with a thread that
// never closes: the Discord resolved branch and the RSS `:resolved` item are both built from an
// incident PRESENT in the live list with `status === 'resolved'`, and a deleted incident never
// appears that way again.
//
// The prune is the only moment we still hold the incident's title + start time, so this module
// captures them as a short-lived TOMBSTONE. That tombstone is the input the Discord withdrawal alert
// (`buildWithdrawalAlerts`) and the RSS `withdrawn` item render from — without it neither emitter has
// any material to render, because the incident no longer exists anywhere upstream or in our data.
//
// Deliberately a SINGLE roster key rather than one key per incident: the RSS renderer has to
// ENUMERATE tombstones (it is not looking up a known id), and KV `list` is eventually consistent and
// adds a round trip to a request-path handler. The roster is tiny (a withdrawal is rare), self-prunes
// by age on every write, and is hard-capped.

import type { MonthlyIncidents } from './monthly-archive'
import type { ServiceStatus } from './types'
import { kvPut } from './utils'
import type { KVLike } from './utils'

/** What we still know about an incident after the provider deleted it upstream. */
export interface WithdrawnIncident {
  svcId: string
  incId: string
  title: string
  /** ISO — the incident's own start. NOT rendered by either emitter today; captured because the
   *  prune is the last moment it exists anywhere, and how long the outage had been claimed before
   *  the provider withdrew it is the obvious next thing a notice would want to say. Holds
   *  `prunedAt >= startedAt` by construction — a future consumer computing an age depends on it. */
  startedAt: string
  /** ISO — when the prune removed the accumulator row, i.e. when AIWatch learned of the withdrawal. */
  prunedAt: string
}

export const WITHDRAWN_KEY = 'incidents:withdrawn'
/** 6d. Nothing reads a tombstone after its two emitters have consumed it — their own dedup markers
 *  (`alerted:wd:{incId}`, the feed guid) are what prevent a re-fire, NOT this TTL. So the only thing
 *  this window has to cover is how long a notice can legitimately be WAITING.
 *
 *  It was 48h, sized for "long enough for both emitters to fire" — which assumes the only delay is
 *  our own cadence. `withdrawalHold`'s `incident-running` breaks that assumption: it clears only when
 *  the PROVIDER closes the incident the withdrawn one duplicated, on the provider's schedule. #1153's
 *  case sat in `monitoring` for 11h+ while the provider's own indicator read "All Systems
 *  Operational", so the loss this module documents as "accepted … only if that state outlasts the
 *  roster" was on track to be the ordinary outcome rather than the edge case.
 *
 *  6d and not 7d: `buildWithdrawalAlerts` skips any tombstone absent from `announcedIncIds`, which is
 *  built from `alerted:new:{incId}` (`ALERTED_NEW_TTL_S`, 7d). Once that marker expires the notice is
 *  structurally impossible. The two clocks differ — this window is measured from `prunedAt`, the
 *  marker from the announcement (≈ `startedAt`) — so `WITHDRAWN_TTL_S < ALERTED_NEW_TTL_S` does NOT
 *  make the roster tail-free: the real point past which no notice can go out is
 *  `min(prunedAt + 6d, startedAt + 7d)`, and when a provider withdraws late (`prunedAt` well after
 *  `startedAt`) the marker binds first, leaving a tail during which the roster still holds the entry
 *  but nothing can be emitted (`isPermanentlyUnclosed` in withdrawal-log.ts computes exactly that min,
 *  and `index.ts` already logs "this thread can never be closed" off `startedAt`). 6d is chosen as the
 *  largest round window that both saves the ordinary case — a withdrawal within a day of the start,
 *  where `prunedAt + 6d` binds and there is no tail — and stays strictly under the marker so the
 *  common case has no dead tail at all. It also keeps 6d < 7d, which independently guarantees the
 *  `alerted:wd:` re-fire dedup (written 7d from SEND) always outlives the tombstone. */
export const WITHDRAWN_TTL_S = 6 * 24 * 3600
/** The KEY outlives the entry window by a day on purpose. If the two expired together, the ordinary
 *  case — one tombstone, no further withdrawal inside the entry window — would evict the key at the same instant
 *  the entry aged out, so `readWithdrawn` would take its `!raw` path and the "expired without ever
 *  notifying" warning could only ever fire in the minority case where a LATER write had refreshed
 *  the key. The extra day makes that diagnostic reachable in the common case, and it costs nothing:
 *  the entry filter, not the key TTL, is what decides whether a tombstone is still live. */
const WITHDRAWN_KEY_TTL_S = WITHDRAWN_TTL_S + 86400
/** Response-size guard, mirroring the alert feed's cap. A withdrawal is rare (single digits per
 *  month); this only bounds a pathological provider that mass-deletes its incident history. */
const WITHDRAWN_MAX = 50

/**
 * Which incident ids disappeared from the accumulator between `existing` and `updated`.
 *
 * `accumulateMonthlyIncidents` only ever ADDS to `incidentIds` — the #975 phantom prune is the sole
 * path that removes one — so an id present before and absent after was pruned, i.e. deleted upstream.
 * Deriving it here keeps `prunePhantomIncidents` pure and its signature (and every one of its call
 * sites and tests) untouched.
 *
 * Fail-safe in the direction of emitting NOTHING:
 *   - a service missing from `updated` yields no tombstones. The prune always carries every service
 *     key through, so this cannot happen from a prune; if it ever does, it is some other mutation and
 *     inventing "the provider withdrew it" from it would be a fabrication.
 *   - an id with no surviving DETAIL row in `existing` is skipped. We would have no title or start
 *     time to render, and a tombstone with placeholder text is worse than silence. (Unreachable in
 *     practice: the prune only ever walks detail rows, so a truncated-away id is never pruned.)
 */
export function diffPrunedIncidents(
  existing: MonthlyIncidents | null,
  updated: MonthlyIncidents,
  prunedAt: string,
): WithdrawnIncident[] {
  const out: WithdrawnIncident[] = []
  for (const [svcId, before] of Object.entries(existing?.services ?? {})) {
    const after = updated?.services?.[svcId]
    // Both skips below are documented as unreachable. Log them anyway: if either ever fires a
    // withdrawal is lost, and without a line the "unreachable" reasoning can never be falsified.
    if (!after) {
      console.warn('[withdrawn] service key vanished from the accumulator — not treating as a withdrawal:', svcId)
      continue
    }
    const survivors = new Set(after.incidentIds ?? [])
    for (const id of before.incidentIds ?? []) {
      if (survivors.has(id)) continue
      const detail = (before.incidents ?? []).find((e) => e.id === id)
      if (!detail) {
        console.warn('[withdrawn] pruned id has no detail row — nothing to render a notice from:', `${svcId}/${id}`)
        continue
      }
      out.push({ svcId, incId: id, title: detail.title, startedAt: detail.startedAt, prunedAt })
    }
  }
  return out
}

/** Why a withdrawal notice is being withheld — `null` means "safe to announce". A discriminant
 *  rather than a boolean because the three cases mean different things to an operator reading the
 *  log ("the provider undid it" / "a replacement outage is running" / "we are blind right now"). */
export type WithdrawalHold = 'republished-same-id' | 'incident-running' | 'source-unreadable' | null

/**
 * Is this service's CURRENT state incompatible with announcing the withdrawal? Both emitters apply
 * this same rule, so neither channel can publish a retraction the other considers unsafe. (They
 * apply it to their OWN view of the live list — the cron uses this cycle's freshly-fetched
 * `scored`, the feed uses the `services:latest` cache — so a service whose state changes between
 * those two reads can still differ for a cycle. The RULE is shared; the input is each channel's.)
 *
 * Three ways a tombstone stops being a safe withdrawal:
 *
 * 1. **Re-published under the SAME id, on ANY service.** The incident is simply live again; a
 *    retraction beside its own active item is self-contradictory. Checked across every service, not
 *    just this tombstone's own: one id routinely spans several surfaces, and a provider that
 *    re-lists it on only some of them would otherwise have the feed carry the same id as both live
 *    and retracted at once.
 *
 * 2. **The service is not cleanly operational** — an UNRESOLVED incident is running, or its status
 *    is anything but `operational`. This is the #975 prune's own motivating case, and the one that
 *    can make us publish something false. Pinecone deleted `xqp5fkvlyg6t` and re-published the same
 *    outage as `m3wrr6csl9jm` with a reworded title and a BACKDATED start
 *    (`prunePhantomIncidents` doc): the old id is pruned, so a naive reading says "withdrawn" while
 *    the outage runs on under a new id. We cannot tell that apart from a genuine withdrawal — the
 *    ids differ and the titles were reworded, which is exactly why #975 exists — so we do not try.
 *    Note the prune's guard 3 requires a live incident that started STRICTLY EARLIER, so "an earlier
 *    live incident exists" is true on EVERY prune and cannot discriminate; its *resolution status*
 *    can, because guard 3 is satisfied by resolved incidents too. The `status` half additionally
 *    covers the prune's OTHER documented residual — a still-open incident retitled out of
 *    `filterIncidents` keyword attribution, which is absent from `incidents` by definition and so
 *    invisible to the incident test, yet leaves the service visibly degraded/down.
 *
 * 3. **We could not read the provider's status page this cycle** (`sourceDead`/`sourceUnknown`). A
 *    fetch failure yields an EMPTY incident list, which is indistinguishable from "nothing is
 *    running" — so without this the retraction would publish on precisely the cycle where we have no
 *    evidence for it, and the tests in 1-2 would silently stop discriminating. Same posture as
 *    #1004's `unknown` OG card: when blind, do not assert.
 *
 * In #1106's evidencing Mistral case the service was operational with every surviving live incident
 * resolved (Conversations 10m, Batch 1h 2m, Vibe), so the notice still goes out.
 *
 * A hold is normally a DELAY, not a loss: the tombstone lives 6d and the cron re-evaluates every 5
 * minutes, so the notice goes out once the service is readable and clean again. It becomes a loss
 * only if that state outlasts the roster — accepted, and the right way round, because a fabricated
 * closing notice for a running outage is worse than a late one. The caller logs every hold, so the
 * loss is at least diagnosable.
 */
export function withdrawalHold(
  incId: string,
  svc: Pick<ServiceStatus, 'status' | 'incidents' | 'sourceDead' | 'sourceUnknown'> | undefined,
  // Every incident id live on ANY monitored service this cycle. Required (#970's rule) so a caller
  // cannot quietly fall back to the per-service view: one incident id routinely spans several
  // surfaces (Anthropic publishes one id for Claude API / claude.ai / Claude Code), and a provider
  // that re-lists it on only SOME of them leaves the others' tombstones looking withdrawn. Emitting
  // then puts the same id in the feed as both live and retracted, and the retraction even borrows
  // the live surface's name through the provider-grouped title.
  liveIncidentIdsAnywhere: ReadonlySet<string>,
): WithdrawalHold {
  if (liveIncidentIdsAnywhere.has(incId)) return 'republished-same-id'
  // No service in this cycle's list at all — a rename/removal, or a whole-fetch failure
  // (`prunePhantomIncidents` treats those identically). Either way we cannot evaluate the tests
  // below, which is exactly case 3.
  if (!svc) return 'source-unreadable'
  if (svc.sourceDead || svc.sourceUnknown) return 'source-unreadable'
  const live = svc.incidents ?? []
  if (live.some((i) => i.status !== 'resolved')) return 'incident-running'
  if (svc.status !== 'operational') return 'incident-running'
  return null
}

/** The `liveIncidentIdsAnywhere` argument above, built once per cycle from the full service list. */
export function liveIncidentIds(services: ReadonlyArray<Pick<ServiceStatus, 'incidents'>>): Set<string> {
  const ids = new Set<string>()
  for (const s of services) for (const i of s.incidents ?? []) ids.add(i.id)
  return ids
}

/**
 * Merge fresh tombstones into the stored roster: FIRST write wins per (svcId, incId), entries older
 * than the TTL are dropped, and the result is capped to the newest `WITHDRAWN_MAX`.
 *
 * The age and unparseable-`prunedAt` filters here are defence in depth, not the enforcer:
 * `readWithdrawn` already applied both to the `existing` this receives, and `fresh` is stamped with
 * `new Date().toISOString()` at the prune. They exist so the merge is correct on its own terms for
 * any caller, and are exercised directly by unit tests rather than through the production path.
 *
 * First-write-wins is what makes the append idempotent — a re-prune (or the daily accumulator pass
 * running over the same cycle) must not refresh `prunedAt`, because both emitters derive their
 * ordering from it and a moving timestamp would let the RSS item's pubDate drift after it was served.
 */
export function mergeWithdrawn(
  existing: WithdrawnIncident[],
  fresh: WithdrawnIncident[],
  nowMs: number,
): WithdrawnIncident[] {
  const seen = new Set<string>()
  const merged: WithdrawnIncident[] = []
  for (const w of [...existing, ...fresh]) {
    const key = `${w.svcId}:${w.incId}`
    if (seen.has(key)) continue
    const at = new Date(w.prunedAt).getTime()
    // An unorderable `prunedAt` is DROPPED, not kept. It is not harmless on the RSS side: `rfc822`
    // maps a NaN date to the epoch, so the item would render as `Thu, 01 Jan 1970`, sort dead last,
    // and be discarded by every reader comparing pubDate against its last-poll watermark — a
    // retraction that ships to Discord and silently never reaches Slack (#750's failure mode).
    if (Number.isNaN(at)) {
      console.warn('[withdrawn] dropping tombstone with unparseable prunedAt:', `${w.svcId}/${w.incId}`, JSON.stringify(w.prunedAt))
      continue
    }
    if (nowMs - at > WITHDRAWN_TTL_S * 1000) continue
    seen.add(key)
    merged.push(w)
  }
  // Oldest-first ordering means the cap evicts the oldest — which are the entries most likely to
  // still be waiting on a gate, so say so rather than losing them silently.
  if (merged.length > WITHDRAWN_MAX) {
    const dropped = merged.slice(0, merged.length - WITHDRAWN_MAX)
    console.warn(`[withdrawn] roster over ${WITHDRAWN_MAX} — evicting ${dropped.length} oldest, these will never notify:`, dropped.map((w) => `${w.svcId}/${w.incId}`).join(', '))
  }
  return merged.slice(-WITHDRAWN_MAX)
}

/** Is this a tombstone we wrote, with every field an emitter needs? The roster is a short-lived KV
 *  value, so a rollback or a future field rename leaves the PREVIOUS shape readable for as long as
 *  the entry window — and a malformed element is not a missed notice but an exception (`sanitize(w.title)` on
 *  `undefined` throws), which would drop that cycle's whole withdrawal build into `cronAlertCheck`'s
 *  catch and lose every pending notice with it. This check is also what makes the read fail-CLOSED
 *  rather than handing an emitter a half-built record. ISO-ness and `prunedAt >= startedAt` are
 *  NOT checked: those hold by construction in `diffPrunedIncidents`, and a date check here would buy
 *  nothing the emitters don't already tolerate. */
function isTombstone(v: unknown): v is WithdrawnIncident {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (['svcId', 'incId', 'title', 'startedAt', 'prunedAt'] as const)
    .every((k) => typeof r[k] === 'string' && r[k] !== '')
}

/** Read the tombstone roster, dropping anything malformed or past the TTL. A missing / corrupt /
 *  unreadable value yields `[]`, which every consumer treats as "no withdrawals" and emits nothing —
 *  **fail-closed**, deliberately: this roster can only ever ADD a notification, so a read blip must
 *  never be able to fabricate one, and the next cycle retries from the same durable value.
 *
 *  Age is filtered HERE and not only in `mergeWithdrawn` because the entry TTL and the KEY's TTL are
 *  different clocks: every write refreshes the key to `WITHDRAWN_KEY_TTL_S`, so with a trickle of new
 *  tombstones an old entry could otherwise outlive its own window and keep appearing in the feed.
 *  Filtering on read makes the roster's contents a function of time alone, not of write cadence. */
export async function readWithdrawn(
  kv: KVLike | KVNamespace,
  nowMs: number = Date.now(),
  // Aging out is the ONE terminal way a tombstone leaves the system without ever notifying, so it
  // must be observable — but this function is also on the `/feed` REQUEST path, where an entry stays
  // filterable for as long as the (write-refreshed) key lives and a log would fire once per poll.
  // The cron passes `true` (it runs every 5 min, so the line is bounded and reads as a state); the
  // feed handler leaves it off. Same split the repo makes for the #283/#983 flap line.
  logExpired = false,
): Promise<WithdrawnIncident[]> {
  let raw: string | null
  try {
    raw = await kv.get(WITHDRAWN_KEY)
  } catch (err) {
    console.warn('[withdrawn] roster read failed, treating as empty:', err instanceof Error ? err.message : String(err))
    return []
  }
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Log the value, not just the failure: the next `appendWithdrawn` read-modify-writes over this
    // blob, permanently discarding every pending tombstone it held, so this is the only chance to
    // make the loss reconstructible.
    console.error('[withdrawn] roster is corrupt and will be overwritten on the next write:', raw.slice(0, 200))
    return []
  }
  if (!Array.isArray(parsed)) return []
  const valid = parsed.filter(isTombstone)
  if (valid.length !== parsed.length) {
    console.warn(`[withdrawn] dropped ${parsed.length - valid.length} malformed roster entr${parsed.length - valid.length === 1 ? 'y' : 'ies'} (shape drift across a rollback?)`)
  }
  const fresh: WithdrawnIncident[] = []
  for (const w of valid) {
    const at = new Date(w.prunedAt).getTime()
    if (!Number.isNaN(at) && nowMs - at <= WITHDRAWN_TTL_S * 1000) { fresh.push(w); continue }
    // #1153 cadence note: an aged-out entry is preserved verbatim in storage until the next
    // `appendWithdrawn` compacts (the hourly `refreshWithdrawnKey` re-puts raw, on purpose), so a
    // SIBLING still-live entry keeps the key alive and this warning re-fires every cron cycle for as
    // long as that sibling's window — no longer bounded by a fixed key TTL. Acceptable: it is a
    // repeated STATE line (same cadence/reasoning as the flap-suppressed and held-notice lines), never
    // a re-fired notice — `alerted:wd:`/the feed guid guard the emission, and this branch emits none.
    if (logExpired) {
      console.warn(`[withdrawn] tombstone expired without ever notifying — the ${'🔴'} thread for this incident will never be closed:`, `${w.svcId}/${w.incId}`, `pruned ${w.prunedAt}`)
    }
  }
  return fresh
}

/** Append tombstones to the roster (read-modify-write; withdrawals are rare, so the write budget is
 *  negligible). Best-effort — a failure means the withdrawal notice is missed for these incidents,
 *  which is the pre-#1106 behaviour, so it must never break the accumulator that called it. */
export async function appendWithdrawn(
  kv: KVLike | KVNamespace,
  fresh: WithdrawnIncident[],
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (fresh.length === 0) return true
  const merged = mergeWithdrawn(await readWithdrawn(kv, nowMs), fresh, nowMs)
  const ok = await kvPut(kv, WITHDRAWN_KEY, JSON.stringify(merged), { expirationTtl: WITHDRAWN_KEY_TTL_S })
  if (!ok) {
    console.error('[withdrawn] roster write FAILED — these withdrawals will never notify:', fresh.map((w) => `${w.svcId}/${w.incId}`).join(', '))
  }
  return ok
}

/**
 * Should this cron cycle re-put the roster purely to refresh the KEY's TTL?
 *
 * The key's TTL is fixed at write time, and `appendWithdrawn` (the prune) is the only writer. That is
 * self-consistent while `WITHDRAWN_KEY_TTL_S` is derived from the CURRENT `WITHDRAWN_TTL_S` — a key
 * written at prune time always outlives the entry window it was sized for. It stops being
 * self-consistent the moment that constant changes: keys already in KV keep the TTL they were written
 * with, so a widened entry window is silently capped by the old key life and the extra days exist only
 * in the read filter, never in storage. #1153 is exactly that — a tombstone pruned under the old 48h
 * constant, whose notice the widened window is supposed to save.
 *
 * Re-putting on a bounded cadence makes the key's TTL a DERIVED value again instead of one frozen at
 * whatever the constant happened to be when the prune ran. Hourly (the cron runs every 5 minutes, so
 * `minutes < 5` fires once per hour — the same slot idiom the daily/weekly jobs use), and only while a
 * live tombstone is actually waiting: ≤24 writes/day during a pending withdrawal, which are single
 * digits per MONTH, and 0 writes otherwise. The free-tier KV budget does not notice it.
 *
 * Not a `refreshedAt` field on the roster value: that would change the stored shape from a bare array,
 * and `isTombstone`/`Array.isArray` make a shape change unreadable across a rollback for the entry
 * window's whole length — the exact hazard those guards exist for. A stateless cadence buys the same
 * bound with nothing new to migrate.
 */
export function shouldRefreshWithdrawnKey(tombstones: WithdrawnIncident[], nowMs: number): boolean {
  // No live tombstone → nothing to keep alive. Also the common case by far, so this is what keeps the
  // write count at zero outside a pending withdrawal.
  if (tombstones.length === 0) return false
  return new Date(nowMs).getUTCMinutes() < 5
}

/**
 * Re-put the roster to refresh its key TTL, if this cycle is due. Returns whether a write happened.
 *
 * `tombstones` is the caller's already-read snapshot, used ONLY as the cadence gate (is a withdrawal
 * pending, and is this the hourly slot). The value actually written is the roster re-read from KV
 * here and re-put VERBATIM — never `JSON.stringify(tombstones)`. Two reasons, both load-bearing:
 *
 *   1. Race safety. `appendWithdrawn` read-modify-writes this same key earlier in the SAME cron tick,
 *      and KV is eventually consistent with a ~60s per-colo read cache (`get` takes no `cacheTtl`), so
 *      the caller's snapshot can be the PRE-append roster. Re-serialising it would overwrite a
 *      just-appended tombstone out of existence — turning the DELAY this feature accepts into the
 *      permanent LOSS it exists to prevent (#1153 review). Re-reading immediately before the put
 *      shrinks the window to the KV round trip, the same exposure `appendWithdrawn` already carries.
 *   2. No compaction. `readWithdrawn` SKIPS expired / shape-drift entries; it does not delete them.
 *      Re-serialising its output would physically drop them within the hour, defeating both the
 *      `logExpired` age-out diagnostic (`readWithdrawn`) and the "previous shape stays readable for
 *      the entry window" guarantee (`isTombstone`). A verbatim re-put touches only the TTL.
 *
 * Best-effort by design: a read or write failure leaves the key on its existing TTL (the pre-#1153
 * behaviour), and the next hourly slot retries. It must never break the alert build that calls it.
 */
export async function refreshWithdrawnKey(
  kv: KVLike | KVNamespace,
  tombstones: WithdrawnIncident[],
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!shouldRefreshWithdrawnKey(tombstones, nowMs)) return false
  let raw: string | null
  try {
    raw = await kv.get(WITHDRAWN_KEY)
  } catch (err) {
    console.warn('[withdrawn] roster key-TTL refresh read failed — the key keeps its existing expiry, retrying next hour:', err instanceof Error ? err.message : String(err))
    return false
  }
  // Nothing stored (evicted between the caller's read and now, or already gone) → nothing to refresh.
  if (!raw) return false
  const ok = await kvPut(kv, WITHDRAWN_KEY, raw, { expirationTtl: WITHDRAWN_KEY_TTL_S })
  if (!ok) {
    // Warn, not error: nothing is lost yet — the key keeps the TTL it already had. It matters only if
    // every remaining slot before that expiry also fails, so a single line per failed slot is enough.
    console.warn('[withdrawn] roster key-TTL refresh write FAILED — the key keeps its existing expiry, retrying next hour:', tombstones.map((w) => `${w.svcId}/${w.incId}`).join(', '))
  }
  return ok
}

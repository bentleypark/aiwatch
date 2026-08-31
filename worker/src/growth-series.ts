// Durable daily series for the consent-free growth metrics (#986, refs #547 · #842).
//
// WHY: #547's remaining item is "measure lift vs the 3→0 baseline" — did making the low-friction
// channel the primary CTA raise conversion? Conversion IS already measured server-side and
// consent-free (`webhook:sub:count` completions, `referral:out` clicks, WAE `isdown-view` views),
// unlike the cookie-gated GA4 events, which only see visitors who accepted a banner mid-outage.
//
// The blocker was never the analysis. It was that nothing kept a SERIES:
//   referral:out:{date}       2d TTL
//   webhook:sub:count:{date}  7d TTL
//   monthly-archive           does not store any of them
// The cron read each once, printed it into the Discord daily report, and let it expire. A lift
// comparison needs weeks of daily rows ("outage days vs quiet days", "before vs after #567"), so the
// measurement was un-runnable both retroactively (already expired) and going forward (would expire
// before enough accrued). A single failed cron day was an unrecoverable hole.
//
// This mirrors the pattern `probe-degradation:monthly` / `security:monthly` already use: at the moment
// the cron holds the values for the Discord report, append one row to a permanent monthly key. One
// KV write per day; one key per month. It cost zero extra reads until #1117, which added three (the
// suppression list + two `incidents:monthly` month keys) to count the outage axis.
//
// SNAPSHOT, NOT DELTA: we store `subscribers` (the confirmed-subscription count) rather than only
// `subscriberNewToday`. A delta is comparable solely against the day before it; a snapshot lets any
// later window be differenced — which is exactly what a lift comparison needs.
//
// ATTRIBUTION CAVEAT: rows dated before 2026-07-08 would be attribution-blind (#936 closed the UTM
// leaks that collapsed inbound to `(direct)`). Accrual starts after it, so every row here is clean.

import type { KVLike } from './utils'
import { kvPut } from './utils'
import type { AudienceCounts } from './outage-audience'
import type { FeedPollsByTarget, PluginTrafficCounts, StatuslineTrafficCounts } from './api-traffic'
import { isMeasuredFeedPolls, isMeasuredExtPolls, isMeasuredPluginPolls, isMeasuredStatuslinePolls, readExtPolls, readPluginPolls, readStatuslinePolls, type FeedPollsVerdict, type FeedPollsRead } from './api-traffic'
import type { PollsVerdict, ExtPollsRead, PluginPollsRead, StatuslinePollsRead } from './api-traffic'
import type { MonthlyIncidents } from './monthly-archive'

/** Rows kept per monthly key. ~31 days; the cap is a corruption guard, not a retention policy. */
export const GROWTH_SERIES_CAP = 40

export interface GrowthDailyRow {
  date: string // YYYY-MM-DD
  // Alerts SENT between 00:00 and 09:00 UTC of `date`, read from the `alert:count:{date}` daily
  // accumulator — NOT the cron cycle's own counters (a cycle-scoped count would record an 04:00 outage
  // as a quiet day). This is NOT the outage-day axis, despite once being described as one: the key is
  // read at the 09:00 run, so it can only ever hold the first 9 hours. See
  // `incidentsStartedInWindow` below (#1117), which is the axis. Kept because it is still a true
  // narrower fact, and repointing a field at a new source under its old name is the #1055 mistake.
  alertedIncidents: number | null // null = could not read the accumulator (≠ a quiet day)
  alertedResolved: number | null
  referralTotal: number | null // consent-free outbound clicks (#842). null = read failed; 0 = nobody clicked
  subscribers: number | null // consent-free completion SNAPSHOT. null = read failed
  subscriberNewToday: number | null // null on a first day or a corrupt baseline (#548 semantics)
  audienceTotal: number | null // is-down views, 24h (WAE)
  audienceActiveTotal: number | null // views during an active outage — the sponsor evidence
  // Deliberately `Record<string, number>` and NOT `Record<AudienceSource, number>`: this is a durable
  // KV series, so rows keep the vocabulary that was live when they were written and a row must stay
  // readable after the enum moves on. The cost is that widening `AudienceSource` does NOT produce a
  // type error here (#1055 widened it by 3 buckets) — the exhaustive sites `tsc` does catch are
  // `AUDIENCE_LABEL` (daily-summary.ts) and `zeroBySource()` (outage-audience.ts). NOTE that is the
  // tsc-caught subset, not the full widening checklist: `AUDIENCE_SOURCES` must be widened too and
  // `tsc` does NOT catch it — the canonical checklist lives next to the union in outage-audience.ts.
  // So when reading
  // this field across a deploy boundary, treat a missing key as "not classified then", never as 0:
  // `direct` before the #1055 deploy absorbed reddit/hn/refhost/self-referrals and is NOT comparable
  // to `direct` after it. Key COUNT discriminates the version, but only on rows where the WAE read
  // SUCCEEDED — a failed/unconfigured read stores `null` here, not a 9-key map (see the `?? null` at
  // the write site). The deploy date is to be recorded in docs/reference/kv-schema.md's
  // `growth:daily` row.
  audienceBySource: Record<string, number> | null
  // #1280 — the same window's views keyed by SCREEN: surface (`service`/`group`/`unknown`) → service
  // id, plus the `__unknown__` sentinel for a row whose id could not be read → count.
  // `audienceBySource` above says where a visitor came FROM; this says what they LOOKED AT, which
  // nothing recorded before.
  //
  // States match `audienceBySource` exactly — a map on a successful read, `null` when it failed,
  // ABSENT on a row predating this field. Absent is not zero. No read-verdict field: this map comes
  // from the same parse as `audienceBySource`, so the two are null together.
  //
  // A service id here does not name a screen on its own — read the (surface, id) PAIR. Why:
  // outage-audience.ts.
  audienceByScreen?: Record<string, Record<string, number>> | null
  // #1273 — feed-poll volume for the window: feed (canonical service ids plus the
  // `__all__`/`__unknown__` sentinels) → client class → count. This is the durable
  // half of the RSS/Slack retention proxy: #548 already computed a 24h number but only printed it into
  // the Discord report, so no window was ever comparable to another and "did subscriptions step up
  // after the outage?" had no dataset — the same gap this whole file was created to close for the
  // other counters.
  //
  // THREE states, and they are not interchangeable:
  //   a map  → read succeeded; a key absent WITHIN the map means that feed/class had no polls (= 0)
  //   null   → nothing was stored. WHY is `feedPollsRead` below, never inferable from the `null`
  //            itself: a failed query, a quiet window and a window of thousands of polls that carried
  //            no blobs all land here, and reading them as one fact points at the wrong remedy.
  //            Recoverable only within the day: a later same-date run whose read succeeds replaces it
  //            (`preserveMeasured` guards only the other direction).
  //   absent → the row predates #1273. NOT zero, and not a failure either: nothing was instrumented.
  // Reading `absent` as 0 would manufacture a step-up on the deploy date out of nothing.
  //
  // The day of deploy is a mixed row: its 24h AE window straddles the deploy, so it stores a map
  // covering only the instrumented part, indistinguishable from a complete one. Which row that is
  // cannot be recovered from the series — the deploy date goes in docs/reference/kv-schema.md's
  // `growth:daily` cell, as `audienceBySource` already does for #1055.
  //
  // The window is the AE query's rolling `NOW() - INTERVAL '1' DAY`, i.e. the same 24h span the
  // `audience*` fields above are queried over. No separate anchor field: one would assert an
  // independence these three fields do not have. Note `outageWindowEnd` names that span's end only
  // when the incident read succeeded — it is written conditionally, so a row can carry `feedPolls`
  // with no anchor recorded anywhere.
  feedPolls?: FeedPollsByTarget | null
  // #1273 — why `feedPolls` is what it is. `ok` iff a map was stored. Absent on a pre-#1273 row, and
  // on nothing else: the write site sets it on every run.
  feedPollsRead?: FeedPollsVerdict
  // #1293 — the OTHER retention clients' 24h poll volume, kept for the same reason `feedPolls` is
  // and previously discarded the same way: both were queried once a day for the Discord line and
  // thrown away, so no window was ever comparable to another. The 2026-08-30 extension audit had to
  // quote a 9-day-old figure because that day's did not exist anywhere, and "did an outage add
  // extension users?" had no dataset at all.
  //
  // States mirror `feedPolls`: a value when the read succeeded, `null` when it did not, ABSENT on a
  // row predating this field. Absent is NOT zero — reading it as zero would manufacture a step-up on
  // the deploy date out of nothing, the trap #1055 and #1273 both name.
  //
  // THREE verdicts (`ok`/`zero`/`failed`), one fewer than `feedPolls`. A reported zero keeps its VALUE
  // — these fields can hold it, so it never needs a `null` to stand in — but it does NOT arrive as
  // `ok`: a window nobody polled and a recorder that wrote nothing are the same reading. Each verdict
  // is keyed on the quantity its counter EXISTS TO MEASURE, not on a payload total: `pluginPolls` on
  // `monitor` (not the pair — briefings would certify a monitor zero), `statuslinePolls` on
  // `serverRenderTotal` (not `total` — the legacy proxy cohort would do the same). `readExtPolls`,
  // `readPluginPolls` and `readStatuslinePolls` carry the per-counter limits.
  //
  // ⚠️ NO counter here applies an operator exclusion — the code corrects for nothing. What that means
  // in practice differs per counter and has CHANGED, so read this with the deploy boundary in hand:
  //
  //   - EXTENSION: the operator's browser carries it and cannot be excluded server-side (no identity;
  //     adding one breaks the published no-analytics promise). A browser running all day contributes
  //     24h, which is what makes `total − 24h` a usable lower bound rather than a correction.
  //   - PLUGIN MONITOR + STATUSLINE: the operator DISABLED both locally to measure external usage, so
  //     from that point these read near zero BY CONSTRUCTION. That is the measurement working, not
  //     adoption collapsing — and re-enabling either produces a step-up that is operator traffic, not
  //     growth. Before that window their share was dominant (each concurrent session runs its own
  //     monitor), so the two sides of the boundary are not comparable.
  //
  // Excluding operator usage in CODE was left out of scope on #1293; the window above is a manual
  // exclusion and its start date belongs in the kv-schema `growth:daily` cell beside the deploy
  // boundaries. Read all three as CHANGE, never as a population.
  //
  // Deploy day is a mixed row here too (the AE window straddles it) and which row that is cannot be
  // recovered from the series — the boundary goes in docs/reference/kv-schema.md's `growth:daily`
  // cell, beside the `feedPolls` (#1273) and `audienceByScreen` (#1280) boundaries.
  extPolls?: number | null
  extPollsRead?: PollsVerdict
  // The plugin's two indexes stay SEPARATE (`aiwatch-monitor` background polls vs `aiwatch-brief`
  // on-demand `/aiwatch` runs) because they measure different things — uptime vs engagement — and
  // summing them would make a burst of briefings look like installs.
  pluginPolls?: PluginTrafficCounts | null
  pluginPollsRead?: PollsVerdict
  // #1293 Part F — the THIRD counter the cron queried for a Discord line and threw away. Added in the
  // same change as the other two because the operator disabled their own statusline at the same time
  // as the plugin monitor, so the clean external-usage window it opened was evaporating daily.
  //
  // Stored as RAW COUNTS with no derived figure, unlike the two above: a statusline renders on Claude
  // Code events rather than on a timer, so there is no poll interval to divide by and no client count
  // to derive. Anything that invents one here is wrong.
  statuslinePolls?: StatuslineTrafficCounts | null
  statuslinePollsRead?: PollsVerdict
  // #1117 — the WINDOW-ALIGNED outage axis. `alertedIncidents` above is not one (see its comment).
  // The gap it left, measured on production 2026-07-22: `alert:count:2026-07-21` held 23 alerts for the
  // full day while the 07-21 row recorded 1, because the row was written 9 hours into that date.
  // It instead counts from the durable `incidents:monthly` record over the SAME 24h window the
  // audience fields were queried over, so the two axes in a row describe the same span.
  //
  // It is a DIFFERENT QUANTITY from `alertedIncidents`, not a corrected version of it — do not expect
  // the 23 above to reappear here. Alerts and incidents diverge in both directions: a #882 hold
  // suppresses an alert for an incident that is still recorded, while one alert carrying merged
  // incidents increments the alert counter once per merged incident (`_mergedKeys.length`). For the
  // same 07-21 window this axis counts 12. Do not re-point it at an alert source without renaming, or
  // a window spanning the change silently mixes two definitions (the #1055 `direct`-bucket lesson).
  //
  // STARTS ONLY, on purpose. A resolved-in-window twin was drafted and dropped: `incidents:monthly`
  // buckets an incident under the month of its `startedAt` and only the CURRENT month is ever
  // re-accumulated, so an incident that starts in July and resolves in August keeps `resolvedAt: null`
  // in the July key forever — no run can write it. A resolution axis would therefore have been a
  // silent lower bound, which is the failure this issue exists to remove, and nothing here needs it:
  // the lift comparison asks whether an outage HAPPENED that day.
  //
  // TWO states only — ABSENT (not counted yet) or a number. Deliberately NOT the `null = read failed`
  // convention the fields above use: those read TTL'd keys that are gone by the next run, so a failure
  // there is permanent and must be recorded. The incident record is retained ~60 days, so a failed
  // read here is RETRYABLE — leaving the field absent lets a later run fill it, where writing `null`
  // would freeze a recoverable gap. **Retryable only within the row's own month**, though:
  // `recordGrowthDaily` opens one key per month, so once the month rolls over an unfilled row stays
  // unfilled forever.
  //
  // A number here is a count over a covered window: the writer refuses to count unless every month the
  // window touches was read AND parsed into the expected shape, so a missing or shapeless accumulator
  // yields ABSENT rather than a quiet day — the failure #1117 exists to remove. Counts are
  // post-suppression (#904) as the suppression layer reports it; an unreadable list aborts rather than
  // counting unfiltered. See `countIncidentsInWindow` for the one accepted lower bound (detail-list
  // truncation past 200/service/month, never yet observed).
  //
  // Known boundary limitation: an incident enters `incidents:monthly` only once a */5 cycle has fetched
  // it, so one starting in the last minutes before the window end can be absent from the snapshot and
  // then land in no window at all (tomorrow's starts where this one ended). Small and deterministic;
  // documented rather than papered over. NOTE the accumulation for THIS cycle has already run by the
  // time the block below reads the key (`cronAlertCheck` is awaited first) — the residual gap is
  // upstream detection latency plus KV read-after-write consistency, not ordering.
  incidentsStartedInWindow?: number
  // ISO end of the window the field above was counted over (start = end − 24h). Self-describing
  // on purpose: a live write anchors on the actual run instant, a backfill on the nominal 09:00 UTC
  // run. Those coincide within minutes on a normal day and by up to ~1h05m on a catch-up run (the only
  // other admitted window is 10:00–10:04, `isInSummaryWindow`). Storing it lets a reader see which
  // anchor a row got instead of assuming. It also discriminates a backfilled row from a live one,
  // which matters because a backfill applies TODAY's suppression list to an older window.
  outageWindowEnd?: string
}

/** The audience fields are a WAE `NOW() - INTERVAL '1' DAY` query, so the outage axis matches it. */
const OUTAGE_WINDOW_MS = 24 * 60 * 60 * 1000

/** The nominal daily-summary run instant for a row's date (the cron window is 09:00–09:04 UTC, with a
 *  10:00–10:04 catch-up; a backfilled row is anchored here, a live one on the actual run instant). */
export function nominalWindowEnd(date: string): string {
  return `${date}T09:00:00.000Z`
}

/**
 * `2026-07` → `2026-06`. Pure, and deliberately string arithmetic.
 *
 * `new Date(d); d.setUTCMonth(d.getUTCMonth() - 1)` is the obvious spelling and it is WRONG here: it
 * keeps the day-of-month, so a day the target month lacks overflows forward — on 2026-07-31 it yields
 * July again, and the previous month is never read at all. That produced a real defect in review: the
 * first-of-month row's window reaches into the previous month, so it would have been backfilled from
 * the wrong key and frozen (rows carrying the axis are never recomputed).
 */
export function previousPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/**
 * The `YYYY-MM` periods a row's 24h window touches — its own, plus the previous one when the window
 * reaches back across a month boundary. Pure. The caller uses this to refuse to count a window whose
 * months it could not all read (an unread month would silently count as zero incidents).
 */
export function periodsCoveringWindow(windowEndIso: string): string[] {
  const end = Date.parse(windowEndIso)
  if (!Number.isFinite(end)) return []
  const endPeriod = new Date(end).toISOString().slice(0, 7)
  const startPeriod = new Date(end - OUTAGE_WINDOW_MS).toISOString().slice(0, 7)
  return startPeriod === endPeriod ? [endPeriod] : [startPeriod, endPeriod]
}

/**
 * Count incidents that STARTED within `[endMs - 24h, endMs)`, across one or more monthly accumulators
 * (a window on the 1st of a month reaches into the previous one). Pure.
 *
 * Deduped by service+incident id, since an incident can appear in two month keys. An entry with an
 * unparseable/absent timestamp — or no id at all — is SKIPPED rather than counted: an unknown start
 * time is not evidence of a start inside the window, and id-less entries would otherwise all collapse
 * onto one dedup key and count as one.
 *
 * ACCEPTED LOWER BOUND: the accumulator caps per-service DETAIL at 200/month, dropping the OLDEST rows
 * first while keeping `incidentIds` whole, and pre-#375 entries have no detail list at all. Such
 * entries are undercounted here. A gate on this was drafted and REMOVED: truncation drops oldest-first,
 * so a live 24h window can only lose an entry if ONE service logged 200+ incidents within those 24
 * hours, while the gate — one flag across both month keys — would have refused every remaining day of
 * that month AND the whole backfill, destroying correct rows to avoid a miscount that has never
 * occurred (0 of 69 service-months as of 2026-07-22). The undercount is the cheaper failure.
 *
 * THROWS on a non-finite `endMs`. A count over an undefined window is not a quiet day, and returning
 * `0` here would be indistinguishable from one — then frozen onto the row, which is the exact failure
 * mode this whole change removes.
 */
export function countIncidentsInWindow(
  sources: Array<MonthlyIncidents | null | undefined>,
  endMs: number,
): { started: number } {
  if (!Number.isFinite(endMs)) throw new RangeError(`countIncidentsInWindow: non-finite window end (${endMs})`)
  const startMs = endMs - OUTAGE_WINDOW_MS
  const startedSeen = new Set<string>()
  const inWindow = (iso: string | null | undefined): boolean => {
    if (!iso) return false
    const t = Date.parse(iso)
    return Number.isFinite(t) && t >= startMs && t < endMs
  }
  for (const src of sources) {
    if (!src || typeof src !== 'object' || !src.services) continue
    for (const [svcId, data] of Object.entries(src.services)) {
      for (const inc of data?.incidents ?? []) {
        if (!inc?.id) continue // no dedup key — merging them would count N as 1
        // #1292 — a `status_history`-derived row is one downtime DAY, not one incident START. This is
        // the outage-day AXIS the growth series is read on (#1117), so counting days as starts would
        // inflate it for a service whose feed died — and this key has no TTL to age the error out.
        if ((inc as { derived?: string }).derived === 'status_history') continue
        if (inWindow(inc.startedAt)) startedSeen.add(`${svcId}::${inc.id}`)
      }
    }
  }
  return { started: startedSeen.size }
}

/**
 * #1117 — fill the window-aligned axis on rows that predate it. Pure.
 *
 * `compute` returns null for a row it cannot cover (its window falls outside the retained incident
 * record, or the read failed); such rows are left ABSENT so a later run can still fill them — writing
 * `null` there would freeze a recoverable gap into a permanent "could not read".
 *
 * Rows that already carry the field are never recomputed: the suppression list moves over time, so a
 * re-run could silently restate history.
 */
export function fillOutageWindows(
  rows: GrowthDailyRow[],
  compute: (date: string) => { started: number; windowEnd: string } | null,
): GrowthDailyRow[] {
  return rows.map((r) => {
    if (r.incidentsStartedInWindow !== undefined) return r
    const c = compute(r.date)
    if (!c) return r
    return { ...r, incidentsStartedInWindow: c.started, outageWindowEnd: c.windowEnd }
  })
}

/**
 * The caller resolves null-vs-zero, because only the caller knows which happened. "No referrals
 * today" and "the referral key could not be read" are different facts, and a lift comparison that
 * cannot tell them apart will read a broken day as a quiet one — the precise error this dataset is
 * built to avoid. So every field arrives already disambiguated.
 */
export interface GrowthDailyInputs {
  date: string
  alertCounts: { incidents?: number; resolved?: number } | null | undefined
  referralTotal: number | null
  subscribers: number | null
  subscriberNewToday: number | null
  audience: AudienceCounts | null | undefined
  // #1117 — null/undefined when the incident record could not be read; the fields are then left
  // ABSENT so a later run's backfill can still supply them (see the field docs above).
  outage: { started: number; windowEnd: string } | null | undefined
  // #1273 — the whole verdict, not the map alone: the two are a pair (`polls` is non-null on exactly
  // one verdict) and passing them separately is what let a stored map sit beside a failure verdict.
  // REQUIRED (not optional) so `tsc` names every call site: an optional dimension is how a derived
  // set silently re-empties (#970).
  feedPolls: FeedPollsRead
  // #1293 — same pairing and the same REQUIRED-ness, for the same #970 reason.
  extPolls: ExtPollsRead
  pluginPolls: PluginPollsRead
  statuslinePolls: StatuslinePollsRead
}

/** `growth:daily:{YYYY-MM}` — permanent, no TTL. One key per month. */
export function growthSeriesKey(period: string): string {
  return `growth:daily:${period}`
}

/** `2026-07-10` → `2026-07`. Pure. */
export function periodOf(date: string): string {
  return date.slice(0, 7)
}

/** One day's row from what the cron already holds at daily-summary time. Pure. */
export function buildGrowthDailyRow(i: GrowthDailyInputs): GrowthDailyRow {
  // An ABSENT `alert:count:{date}` key means no alert fired today — a genuine quiet day, so 0.
  // A failed READ is the caller's job to surface as `null` (it passes `alertCounts: undefined`
  // only when the key was absent; on a read error it must pass a row-skipping decision instead).
  return {
    date: i.date,
    alertedIncidents: i.alertCounts ? (i.alertCounts.incidents ?? 0) : 0,
    alertedResolved: i.alertCounts ? (i.alertCounts.resolved ?? 0) : 0,
    referralTotal: i.referralTotal,
    subscribers: i.subscribers,
    subscriberNewToday: i.subscriberNewToday,
    audienceTotal: i.audience?.total ?? null,
    audienceActiveTotal: i.audience?.activeTotal ?? null,
    audienceBySource: i.audience?.bySource ?? null,
    audienceByScreen: i.audience?.byScreen ?? null,
    feedPolls: i.feedPolls.polls,
    feedPollsRead: i.feedPolls.verdict,
    extPolls: i.extPolls.polls,
    extPollsRead: i.extPolls.verdict,
    pluginPolls: i.pluginPolls.counts,
    pluginPollsRead: i.pluginPolls.verdict,
    statuslinePolls: i.statuslinePolls.counts,
    statuslinePollsRead: i.statuslinePolls.verdict,
    ...(i.outage ? { incidentsStartedInWindow: i.outage.started, outageWindowEnd: i.outage.windowEnd } : {}),
  }
}

/**
 * Append (or replace) one row, keeping the series sorted and capped. Pure and **idempotent**: a
 * catch-up cron re-running the same date overwrites that row instead of duplicating it.
 * A corrupt/absent existing value degrades to a fresh series rather than throwing — losing history is
 * bad, aborting the Discord report is worse.
 */
export function appendGrowthDaily(existing: unknown, row: GrowthDailyRow): GrowthDailyRow[] {
  const rows = Array.isArray(existing) ? existing.filter((r): r is GrowthDailyRow => isRow(r)) : []
  const prior = rows.find((r) => r.date === row.date)
  const merged = [...rows.filter((r) => r.date !== row.date), preserveMeasured(prior, row)]
  merged.sort((a, b) => a.date.localeCompare(b.date))
  return merged.slice(-GROWTH_SERIES_CAP)
}

/**
 * Same-date replacement must not DOWNGRADE a measurement to "we could not read it" (#1273).
 *
 * The 10:00 catch-up re-runs a date whose 09:00 run wrote a row but not its marker (a Discord throw,
 * or `kvPut` swallowing the marker write). If that second run's read yields nothing, the whole-row
 * replace would drop a measured 24h window from a key with no TTL and no backfill path —
 * `recordGrowthDaily`'s own docstring states the doctrine: losing a day to a skipped write is
 * recoverable, overwriting is not. The sibling outage axis avoids the same trap by leaving its field
 * ABSENT rather than freezing a recoverable gap.
 *
 * "Is this a measurement?" is `isMeasuredFeedPolls`, not a rule restated here — the two sites
 * disagreeing about `{}` is the defect this shape exists to prevent. Both ends go through it, so a
 * corrupt or empty prior cannot be resurrected over an honest failure either.
 *
 * Covers `feedPolls`, the three #1293 poll counters and the AUDIENCE group. The other nullable fields
 * read TTL'd keys that really are gone by the next run, so for them a re-run's `null` is the best
 * available value.
 *
 * #1280 — the audience fields do NOT belong to that TTL rationale: `queryOutageAudience` reads the
 * Analytics Engine SQL API, so its `null` is a failed request, not an expiry. Overwriting a real
 * measurement with it destroys the value permanently — this key has no TTL and no backfill. The four
 * fields travel as ONE group because they come from one `AudienceCounts`. Pure.
 */
function preserveMeasured(prior: GrowthDailyRow | undefined, row: GrowthDailyRow): GrowthDailyRow {
  if (!prior) return row
  let out = row
  // `feedPollsRead` travels WITH the map it explains. Carrying the map alone would leave the later
  // run's failure verdict sitting beside a measurement, which is the same one-value-two-stories
  // defect the verdict was added to end.
  if (!isMeasuredFeedPolls(row.feedPolls) && isMeasuredFeedPolls(prior.feedPolls)) {
    out = { ...out, feedPolls: prior.feedPolls, feedPollsRead: prior.feedPollsRead }
  }
  // #1293 — same doctrine for the two poll counters, with one difference that matters: `0` is
  // a MEASUREMENT here, not an empty one. Hence `== null` on the re-run side (it catches `undefined`
  // too and leaves `0` alone); a truthiness check would resurrect a stale count over a genuine quiet
  // day, inventing traffic that never happened in a key with no TTL and no backfill.
  //
  // The PRIOR side goes through the same predicate a fresh read does, not a `!= null`. `isRow` admits
  // any object with a string `date`, so a bare null-check would restore `"2010"`, `-5` or
  // `{monitor: null}` over an honest failure and file it as measured — the exact defect
  // the inline note inside `isMeasuredFeedPolls` records having happened once already. The verdict is re-derived
  // rather than copied from the prior, so a restored value cannot arrive under a contradictory (or
  // absent) verdict.
  // The restored verdict is re-derived by running the prior back through the SAME reader the live path
  // uses, rather than being copied from the prior or hardcoded. Copying can resurrect a contradictory
  // (or absent) verdict; hardcoding `'ok'` was correct only while `ok` and `failed` were the only
  // verdicts, and would now label a restored `0` as unambiguous — the exact distinction the `zero`
  // verdict was added to preserve. The readers also do the field-by-field copy, so a corrupt prior's
  // junk keys cannot ride into a permanent row.
  if (row.extPolls == null && isMeasuredExtPolls(prior.extPolls)) {
    const restored = readExtPolls(prior.extPolls)
    out = { ...out, extPolls: restored.polls, extPollsRead: restored.verdict }
  }
  if (row.pluginPolls == null && isMeasuredPluginPolls(prior.pluginPolls)) {
    const restored = readPluginPolls(prior.pluginPolls)
    out = { ...out, pluginPolls: restored.counts, pluginPollsRead: restored.verdict }
  }
  if (row.statuslinePolls == null && isMeasuredStatuslinePolls(prior.statuslinePolls)) {
    const restored = readStatuslinePolls(prior.statuslinePolls)
    out = { ...out, statuslinePolls: restored.counts, statuslinePollsRead: restored.verdict }
  }
  // `audienceTotal` discriminates the group: `null` only on a failed read, a real `0` on a quiet day.
  if (row.audienceTotal == null && prior.audienceTotal != null) {
    out = {
      ...out,
      audienceTotal: prior.audienceTotal,
      audienceActiveTotal: prior.audienceActiveTotal,
      audienceBySource: prior.audienceBySource,
      audienceByScreen: prior.audienceByScreen, // ABSENT on a pre-#1280 prior; must not become null
    }
  }
  return out
}

function isRow(r: unknown): r is GrowthDailyRow {
  return !!r && typeof r === 'object' && typeof (r as GrowthDailyRow).date === 'string'
}

/** Parse a stored series, tolerating absence and corruption. Pure. */
export function parseGrowthSeries(raw: string | null | undefined): GrowthDailyRow[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter(isRow) : []
  } catch {
    return []
  }
}

/**
 * Read-modify-write today's row into the permanent monthly key. Best-effort for the *write*; strict
 * about the *read*.
 *
 * A thrown `kv.get` (5xx, rate-limit, network blip) must NOT be collapsed to `null`: this key is an
 * accumulator with no TTL and no recovery path, so treating a failed read as "absent" would rewrite
 * the whole month as a single row and silently destroy every day accrued so far. On a read failure we
 * skip the write entirely and lose one day, which is recoverable; overwriting is not.
 *
 * A genuinely absent key (first day of the month) is `null` and correctly seeds an empty series.
 */
export async function recordGrowthDaily(
  kv: KVLike,
  row: GrowthDailyRow,
  // #1117 — optional pass over the merged series to fill the window-aligned axis on older rows.
  // Applied to the whole series (not just today's row) because the fix is retroactive: the incident
  // record it reads from outlives the TTL'd counter the broken axis used.
  backfill?: (rows: GrowthDailyRow[]) => GrowthDailyRow[],
): Promise<boolean> {
  const key = growthSeriesKey(periodOf(row.date))
  let raw: string | null
  try {
    raw = await kv.get(key)
  } catch (err) {
    console.warn('[growth-series] read failed, skipping write to protect history:', err instanceof Error ? err.message : err)
    return false
  }
  const appended = appendGrowthDaily(parseGrowthSeries(raw), row)
  // The backfill is a bonus pass over arbitrary stored rows; a throw in it must never cost TODAY's row.
  // Today's inputs (referral:out 2d, webhook:sub:count 7d, the WAE query) cannot be re-derived
  // tomorrow, and the backfill only ever fills rows that already exist — so losing the write loses the
  // day permanently, while losing the backfill costs nothing a later run can't redo.
  let next = appended
  if (backfill) {
    try {
      next = backfill(appended)
    } catch (err) {
      console.warn('[growth-series] backfill failed, writing today only:', err instanceof Error ? err.message : err)
      next = appended
    }
  }
  return await kvPut(kv, key, JSON.stringify(next)) // no expirationTtl → permanent
}

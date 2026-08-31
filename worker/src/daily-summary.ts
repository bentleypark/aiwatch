// Daily Summary — expanded Discord report at UTC 09:00 (KST 18:00)

import type { ServiceStatus } from './types'
import { isAffectedStatus, isUnreadableStatus } from './status-verdict'
import type { ProbeSnapshot } from './probe'
import type { VitalsDaily } from './vitals'
import { formatVitalsSection } from './vitals'
import { aggregateProbeDaily } from './probe-archival'
import { formatReportCountsSection } from './report'
import type { AccuracyStats } from './incident-history'
import type { SourceHealthRead } from './reddit'
import type { AiUsageCounters } from './ai-analysis'
import { AUDIENCE_SOURCES, AUDIENCE_SURFACES, AUDIENCE_SURFACE_UNKNOWN, type AudienceByScreen, type AudienceCounts, type AudienceSource } from './outage-audience'
import { FAMILY_OF_SERVICE } from './alerts'
import { clientMinutesFromPolls, formatClientTime, EXT_POLL_PERIOD_MINUTES, PLUGIN_POLL_PERIOD_SECONDS } from './api-traffic'
import type { StatuslineTrafficCounts, StatuslineTrafficDelta, BadgeTrafficCounts, FeedTrafficCounts, FeedPollsByTarget } from './api-traffic'
import { BADGE_UNKNOWN_SERVICE, FEED_UNKNOWN_TARGET, rollupByClient, subscriberFeeds, type AllFeedState } from './api-traffic'

// #679 — the "detection lead" (faster-than-official) metric was removed (structurally null — status-page
// polling is always later than the official publish; #464 already retired the framing). The RTT-degradation
// classifier below is the KEPT, separate part: it flags probe-spike degradations the official pages miss.
export type DegradationOutcome = 'degradation' | 'degradation_nostatus'

/** Classify a probe-spike degradation by whether the service's official status already reflects it.
 *  svcStatusOperational === true → the status page shows nothing → 'degradation_nostatus' (our edge).
 *  Pure + side-effect-free so the rising-edge decision is unit-testable; KV I/O stays in index.ts. */
export function classifyDegradation(svcStatusOperational: boolean): DegradationOutcome {
  return svcStatusOperational ? 'degradation_nostatus' : 'degradation'
}

/**
 * Rough per-successful-Sonnet-call cost, USD.
 *
 * #955: was 0.006, sized for Sonnet 4 at `max_tokens: 300`. Sonnet 5 keeps the $3/$15-per-MTok
 * sticker but our prompt now carries the RAG history block and the ceiling is 600 output tokens
 * — roughly 1.5k in + 300 out ≈ $0.0045 + $0.0045. Only SUCCESSES are billed here: a 404 or a
 * pre-response abort costs nothing, which is why the line counts `sonnet`, not `sonnetAttempts`.
 */
export const SONNET_COST_PER_CALL_USD = 0.009

/**
 * Render the 🤖 AI Analysis Usage section, or '' when nothing ran today.
 *
 * Surfaces ATTEMPTS alongside successes (#955). The old line showed `Sonnet: 0` whether the
 * fallback was never reached or reached and 404ing on every single call — which is precisely
 * how a retired model id went unnoticed for weeks.
 */
export function formatAiUsageSection(aiUsage: AiUsageCounters | null): string {
  if (!aiUsage || aiUsage.calls <= 0) return ''
  const gemma = aiUsage.gemma ?? 0
  const sonnet = aiUsage.sonnet ?? 0
  const gemmaAttempts = aiUsage.gemmaAttempts ?? 0
  const sonnetAttempts = aiUsage.sonnetAttempts ?? 0
  const timedOut = aiUsage.timedOut ?? 0

  const cost = (sonnet * SONNET_COST_PER_CALL_USD).toFixed(3)
  const outcomes = [`${aiUsage.success} success`, `${aiUsage.failed} failed`]
  if (timedOut > 0) outcomes.push(`${timedOut} timed out`)

  // "3/7" reads as succeeded/attempted. Attempt counts are absent on pre-#955 days, so fall
  // back to the bare success count rather than printing a misleading "0 attempts".
  const gemmaCell = gemmaAttempts > 0 ? `${gemma}/${gemmaAttempts}` : `${gemma}`
  const sonnetCell = sonnetAttempts > 0 ? `${sonnet}/${sonnetAttempts}` : `${sonnet}`
  const breakdown = gemmaAttempts || sonnetAttempts || gemma || sonnet
    ? ` (Gemma: ${gemmaCell}, Sonnet: ${sonnetCell})`
    : ''

  const lines = [
    '\n🤖 **AI Analysis Usage**',
    `   Today: ${aiUsage.calls} calls (${outcomes.join(', ')})${breakdown}`,
    `   Est. cost: $${cost} (Sonnet only)`,
  ]
  // A fallback that is always reached and never succeeds is a broken fallback, not bad luck.
  if (sonnetAttempts > 0 && sonnet === 0) {
    lines.push(`   ⚠️ Sonnet fallback: ${sonnetAttempts} attempts, 0 successes — check the model id / API key`)
  }
  return lines.join('\n')
}

export interface DailySummaryData {
  services: ServiceStatus[]
  aiUsage: AiUsageCounters | null
  latencySnapshots: Array<{ t: string; data: Record<string, number> }>
  incidentCountToday: { newCount: number; resolvedCount: number }
  alertCounts?: { incidents: number; resolved: number; down: number; degraded: number; recovered: number } | null
  // #815 — Tier-1 ntfy phone pushes delivered today (#778); makes the otherwise-unobservable push visible.
  pushCount?: number | null
  // #842 — consent-free outbound-referral counts (is-down "Open ↗" beacon) — the sponsor-evidence
  // metric ("we sent N users to alternatives at the failover moment"). null/absent until a click lands.
  referralCounts?: { total: number; byService: Record<string, number> } | null
  // #827 Feature 1 — AI recovery-prediction accuracy aggregated across the durable incident:history
  // corpus (predicted vs actual). Absent/empty until the corpus accumulates resolved incidents.
  accuracy?: AccuracyStats | null
  // Discord-only since #467 — Slack moved to native /feed RSS (no per-user webhook registered or proxied).
  // #548 — newToday is the signed day-over-day delta of confirmed subscribers (null = no prior baseline).
  webhookCounts?: { discord: number; newToday?: number | null }
  deliveryCounts?: { discord: number; failed: number } | null
  redditCount: number
  // #820 — Reddit source health: a marker (blocked / partially blocked / unreachable streak),
  // `'unknown'` when KV could not be read, or null/absent when healthy. Surfaces a warning so
  // "403 → 0 posts" is never read as a quiet day.
  redditSourceDead?: SourceHealthRead
  securityCount?: number
  vitals?: VitalsDaily | null
  probeSnapshots?: ProbeSnapshot[]
  fetchFailureCounts?: Record<string, number>   // svcId → times degraded threshold hit today
  crossValidSuppressed?: Record<string, number> // svcId → times probe overrode to operational
  degradationCounts?: Record<string, number>          // svcId → RTT degradation spikes today (#464)
  degradationNoStatusCounts?: Record<string, number>  // svcId → degradations NOT on official status page
  // #518 — public API (/api/v1) traffic: last-24h counts (from WAE) + the running cumulative total
  // (folded into a permanent KV counter once/day). Absent (null) when the SQL API isn't configured.
  v1Traffic?: {
    today: { all: number; service: number; total: number }
    cumulative: number
    since: string
  } | null
  // #548 — feed-poll volume (last-24h, from WAE): the consent-free retention proxy. Absent (null)
  // when the SQL API isn't configured. No cumulative — the daily value (a post-outage step-up) is the signal.
  // `newItems` (#748) — incidents AIWatch first-detected in the 24h window (alert-worthy events),
  // distinct from the mostly-empty poll volume; absent when the KV read failed.
  feedTraffic?: (FeedTrafficCounts & { newItems?: number }) | null
  // #1157 — badge-request volume (last-24h, from WAE): SVG status-badge embeds (READMEs, status
  // pages) as a retention/distribution signal, mirroring #518/#548. Absent (null) when the SQL API
  // isn't configured. No cumulative — same rationale as feedTraffic (a daily snapshot is the signal).
  badgeTraffic?: BadgeTrafficCounts | null
  // #842-B — consent-free outage-moment audience (is-down page-load beacon → WAE): last-24h views by
  // inbound source (x/search/feed/direct), split by whether the service was in an active outage. The
  // sponsor-evidence "outage-spike audience" (#637/#803). Absent (null) when the AE SQL isn't configured.
  audience?: AudienceCounts | null
  // #837 — Chrome-extension activity (consent-free engagement proxy): last-24h poll volume (WAE
  // `ext-claude` tag; null when the SQL API isn't configured) + today's extension-sourced report
  // count (KV). Absent when neither signal exists → section omitted.
  extActivity?: { polls: number | null; reports: number } | null
  // #918 — Claude Code statusline poll volume (last-24h, WAE `statusline-*` tags): the consent-free
  // adoption proxy #400 Phase 1 needs. #944 splits it into two cohorts (server-render presets vs the
  // legacy `proxy` catch-all) + a day-over-day delta. Absent (null) when the SQL API isn't configured;
  // a poll ≈ active-usage proxy (Claude Code re-renders per prompt), not a user count.
  statuslineTraffic?: (StatuslineTrafficCounts & { delta?: StatuslineTrafficDelta | null }) | null
  // #920 — Claude Code PLUGIN usage (last-24h, WAE `aiwatch-monitor` + `aiwatch-brief` tags): the
  // consent-free plugin-adoption proxy (monitor polls ≈ installs × up-time; briefings ≈ engagement).
  // Absent (null) when the SQL API isn't configured. Same not-a-user-count caveat as statusline.
  pluginTraffic?: { monitor: number; brief: number } | null
  // #575 Phase A — crowd "Report an issue" counts today (svcId → count). Internal demand signal
  // only (coverage priority); never a public "N reporting" verdict. Empty/absent → section omitted.
  reportCounts?: Record<string, number>
}

/** How long the source has been dark, for the #820 warning. Coarse on purpose — the operator needs
 *  "an hour" vs "all day", not precision. */
export function formatDarkFor(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'duration unknown'
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `for ${mins}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `for ${hours}h` : `for ${Math.floor(hours / 24)}d+`
}

export function buildDailySummary(data: DailySummaryData): string {
  const { services, aiUsage, latencySnapshots, incidentCountToday, alertCounts, pushCount, webhookCounts, deliveryCounts, redditCount, vitals, fetchFailureCounts, crossValidSuppressed, degradationCounts, degradationNoStatusCounts } = data
  const total = services.length
  const operational = services.filter(s => s.status === 'operational').length
  const degraded = services.filter(s => s.status === 'degraded').length
  const down = services.filter(s => s.status === 'down').length
  // #1233 — services whose status source AIWatch could not read. Counted separately and printed, not
  // folded into any of the three above: without its own part the four counts silently stop summing to
  // `total`, and the reader has no way to tell whether the missing services were fine.
  const unreadable = services.filter(s => isUnreadableStatus(s.status)).length

  const lines: string[] = []

  // Section 1: Service overview
  const statusParts = [`${operational} operational`]
  if (degraded > 0) statusParts.push(`${degraded} degraded`)
  if (down > 0) statusParts.push(`${down} down`)
  if (unreadable > 0) statusParts.push(`${unreadable} source unreadable`)
  lines.push(`📡 **Services**: ${total} monitored · ${statusParts.join(' · ')}`)

  // Section 2: Active issues
  // #1233 — `isAffectedStatus`: an unreadable source is not an active issue. It is disclosed by the
  // count in Section 1 instead, where it makes no claim about the service.
  const activeIssues = services.filter(s => isAffectedStatus(s.status))
  if (activeIssues.length > 0) {
    const issueList = activeIssues.map(s => {
      const activeInc = (s.incidents ?? []).find(i => i.status !== 'resolved')
      const status = activeInc ? activeInc.status : s.status
      const duration = activeInc ? formatDurationFromStart(activeInc.startedAt) : ''
      return `${s.status === 'down' ? '🔴' : '🟡'} ${s.name} (${status}${duration ? `, ${duration}` : ''})`
    }).join('\n')
    lines.push(`\n🔔 **Active Issues**\n${issueList}`)
  }

  // Section 3: AI Analysis usage
  const aiUsageLine = formatAiUsageSection(aiUsage)
  if (aiUsageLine) lines.push(aiUsageLine)

  // #827 Feature 1 — AI recovery-prediction accuracy (predicted vs actual, across the durable corpus)
  const accuracyLine = formatAccuracyLine(data.accuracy)
  if (accuracyLine) lines.push(accuracyLine)

  // Section 4: Uptime Best/Worst — only services that report an official uptime%. #713: services with
  // no official uptime now leave `uptime30d` null (no estimate), so the null check alone excludes them.
  const withUptime = services.filter(s => s.uptime30d != null && !isNaN(s.uptime30d!))
  if (withUptime.length >= 3) {
    const sorted = [...withUptime].sort((a, b) => (b.uptime30d ?? 0) - (a.uptime30d ?? 0))
    const best = sorted.slice(0, 2).map(s => `${s.name} ${s.uptime30d!.toFixed(2)}%`).join(' · ')
    const worst = sorted.slice(-2).reverse().map(s => `${s.name} ${s.uptime30d!.toFixed(2)}%`).join(' · ')
    lines.push(`\n📈 **Uptime**\n   Best: ${best}\n   Worst: ${worst}`)
  }

  // Section 5: Probe RTT (24h) — replaces status page latency with direct API endpoint measurement
  const probeSnaps = data.probeSnapshots ?? []
  if (probeSnaps.length > 0) {
    // TODO(#132): pass incident windows to exclude RTT during outages — see probe-archival.ts:202
    const probeDaily = aggregateProbeDaily(probeSnaps)
    const probeEntries = Object.entries(probeDaily).filter(([, v]) => v.p75 > 0)
    if (probeEntries.length >= 3) {
      const sorted = probeEntries.sort((a, b) => a[1].p75 - b[1].p75)
      const nameMap = new Map(services.map(s => [s.id, s.name]))
      const fastest = sorted.slice(0, 3).map(([id, s]) => `${nameMap.get(id) ?? id} ${s.p75}ms`).join(' · ')
      const slowest = sorted.slice(-2).reverse().map(([id, s]) => `${nameMap.get(id) ?? id} ${s.p75}ms`).join(' · ')
      const spikeServices = probeEntries.filter(([, s]) => s.spikes > 0)
      const spikeLine = spikeServices.length > 0
        ? `\n   Spikes: ${spikeServices.map(([id, s]) => `${nameMap.get(id) ?? id} (${s.spikes})`).join(', ')}`
        : ''
      lines.push(`\n⚡ **API Response Time (p75)**\n   Fastest: ${fastest}\n   Slowest: ${slowest}${spikeLine}`)
    }
  } else {
    // Fallback to status page latency if no probe data
    const latencyAvg = computeLatencyAvg(latencySnapshots)
    const latencyEntries = Object.entries(latencyAvg).filter(([, v]) => v > 0)
    if (latencyEntries.length >= 3) {
      const sorted = latencyEntries.sort((a, b) => a[1] - b[1])
      const nameMap = new Map(services.map(s => [s.id, s.name]))
      const fastest = sorted.slice(0, 2).map(([id, ms]) => `${nameMap.get(id) ?? id} ${Math.round(ms)}ms`).join(' · ')
      const slowest = sorted.slice(-2).reverse().map(([id, ms]) => `${nameMap.get(id) ?? id} ${Math.round(ms)}ms`).join(' · ')
      lines.push(`\n⚡ **Latency (24h avg)**\n   Fastest: ${fastest}\n   Slowest: ${slowest}`)
    }
  }

  // Section 6: Daily alert count + Reddit
  if (alertCounts) {
    const total = alertCounts.incidents + alertCounts.resolved + alertCounts.down + alertCounts.degraded + alertCounts.recovered
    if (total > 0) {
      const parts: string[] = []
      if (alertCounts.incidents > 0) parts.push(`${alertCounts.incidents} incidents`)
      if (alertCounts.resolved > 0) parts.push(`${alertCounts.resolved} resolved`)
      if (alertCounts.down > 0) parts.push(`${alertCounts.down} down`)
      if (alertCounts.degraded > 0) parts.push(`${alertCounts.degraded} degraded`)
      if (alertCounts.recovered > 0) parts.push(`${alertCounts.recovered} recovered`)
      lines.push(`\n📬 **Alerts Sent Today**: ${total} (${parts.join(', ')})`)
    }
  } else {
    // Fallback: use current cron cycle counts
    const incParts: string[] = []
    if (incidentCountToday.newCount > 0) incParts.push(`${incidentCountToday.newCount} new`)
    if (incidentCountToday.resolvedCount > 0) incParts.push(`${incidentCountToday.resolvedCount} resolved`)
    if (incParts.length > 0) lines.push(`\n📬 **Alerts Sent Today**: ${incParts.join(' · ')}`)
  }
  // #815 — Tier-1 ntfy phone-push count (#778). Makes the otherwise-unobservable push visible so the
  // operator can confirm it fires on a real incident (closes the #778 verify gap).
  const pushLine = formatPushLine(pushCount)
  if (pushLine) lines.push(pushLine)
  // #842 — outbound-referral count (is-down "Open ↗" clicks, consent-free). The Rung-1 sponsor evidence.
  const referralLine = formatReferralLine(data.referralCounts, data.services)
  if (referralLine) lines.push(referralLine)
  // #842-B — outage-moment audience by source (is-down views, consent-free). 근거 ① for the sponsor.
  const audienceLine = formatAudienceLine(data.audience)
  if (audienceLine) lines.push(audienceLine)
  if (deliveryCounts && (deliveryCounts.discord > 0 || deliveryCounts.failed > 0)) {
    const failText = deliveryCounts.failed > 0 ? ` (${deliveryCounts.failed} failed)` : ''
    lines.push(`📨 **User Webhook Delivery**: ${deliveryCounts.discord} Discord${failText}`)
  }
  if (webhookCounts) {
    lines.push(`🔗 **Active Discord Webhooks**: ${webhookCounts.discord}${formatSubscriberDelta(webhookCounts.newToday)}`)
  }
  // Health outranks the count. `reddit:seen:*` keys live 24h, so a source that dies at noon still
  // shows a real non-zero count — and printing it would read as health on the very day detection
  // went dark. The reason is carried through because the remediations differ: `block` is the
  // listing feed itself refusing us (401/403 — a real endpoint problem), `streak` points at our own
  // egress, `partial` mixes a real block with real successes.
  //
  // `throttled` (429, quiet tone) is deliberately narrow (#820 round 2/3): it only fires alongside
  // real evidence this run got SOME posts through (`decideSourceHealth`'s ok>0 branch) — live
  // testing found Reddit rate-limits ~85% of requests against the shared Cloudflare egress-IP pool
  // as a matter of course, REGARDLESS of our own request pacing, so a single run with partial
  // coverage is expected, usually self-healing noise, not an operator action item; alarming on every
  // such run would be the "cry wolf" pattern that trains the operator to stop reading this line. But
  // a run with ZERO evidence of life is indistinguishable from a real outage on its own — that case
  // does NOT take this quiet branch; it accumulates via the same streak mechanism plain-transient
  // failures use and only reaches this function as `streak` once sustained, which is why `streak`'s
  // message below names all three possible causes rather than assuming it's an egress problem (round 2
  // tried a separate `throttled-streak` reason for the throttle-flavored case, but a streak whose
  // flavor flips between runs kept re-stamping the marker's `at` to "now" on every flip via
  // `markRedditSourceDead`'s reason-changed-is-a-new-event rule, understating how long a genuinely
  // sustained outage had been running — one terminal reason avoids that).
  const health = data.redditSourceDead
  if (health === 'unknown') {
    lines.push('⚠️ **Reddit source health UNKNOWN**: KV read failed — cannot confirm detection is live')
  } else if (health?.reason === 'throttled') {
    const countSuffix = redditCount > 0 ? ` — ${redditCount} posts still detected today` : ''
    lines.push(`🐢 **Reddit rate-limited**: HTTP 429 on some subreddits this run (shared egress IP, not a code issue — usually self-heals)${countSuffix}`)
  } else if (health) {
    const age = formatDarkFor(Date.now() - health.at)
    const detail = health.reason === 'partial' ? 'some subreddits blocked (401/403) — detection is partly dark'
      : health.reason === 'streak' ? 'no subreddit returned a usable response for 3+ runs — could be an egress/connectivity issue, a 200 bot wall (body present but not a valid Atom feed), or sustained Reddit rate-limiting (429) on the shared Cloudflare egress IP; check recent Worker logs for the per-run status codes AND bodies'
      : 'the listing feed returned a block status (401/403) — detection is dark'
    lines.push(`⚠️ **Reddit source DOWN**: ${detail} (${age})`)
  } else if (redditCount > 0) {
    lines.push(`📢 **Reddit**: ${redditCount} posts detected`)
  }
  if (data.securityCount && data.securityCount > 0) lines.push(`🔒 **Security**: ${data.securityCount} alerts detected`)

  // Section: Web Vitals
  if (vitals && vitals.count > 0) {
    lines.push(formatVitalsSection(vitals))
  }

  // Section: Status page fetch failures (#500) — surfaces structural URL blocks early.
  // fetch-fail:daily = times the degraded threshold was hit today (transient: 1-2, structural: 5+).
  // cross-valid:suppressed = subset where probe confirmed the API was healthy (false positives caught).
  if (fetchFailureCounts && Object.keys(fetchFailureCounts).length > 0) {
    const nameMap = new Map(services.map(s => [s.id, s.name]))
    const items = Object.entries(fetchFailureCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([id, total]) => {
        const suppressed = crossValidSuppressed?.[id] ?? 0
        const real = Math.max(0, total - suppressed)
        const detail = suppressed === total
          ? `all false positives — probe healthy`
          : suppressed > 0
            ? `${real} real, ${suppressed} probe-suppressed`
            : `${real} real`
        return `   ${nameMap.get(id) ?? id}: ${total}× threshold hit (${detail})`
      })
      .join('\n')
    lines.push(`\n⚠️ **Status Page Fetch Failures Today** (#500)\n${items}`)
  }

  // Section: RTT degradation detection (#464) — the honest differentiator that replaced the
  // unverifiable "faster than official" claim. probe-degradation:daily = every probe RTT spike;
  // :nostatus = the subset where the official status page showed nothing (our edge).
  const degSection = formatDegradationSection(degradationCounts, degradationNoStatusCounts, services)
  if (degSection) lines.push(degSection)

  // Section: public API (/api/v1) traffic (#518) — usage leading indicator for product decisions.
  const v1Section = formatV1TrafficSection(data.v1Traffic)
  if (v1Section) lines.push(v1Section)

  // Section: feed-poll volume (#548) — consent-free retention proxy (post-outage step-up = retained subs).
  const feedSection = formatFeedTrafficSection(data.feedTraffic)
  if (feedSection) lines.push(feedSection)

  // Section: badge-request volume (#1157) — SVG status-badge embed signal (READMEs, status pages).
  const badgeSection = formatBadgeTrafficSection(data.badgeTraffic)
  if (badgeSection) lines.push(badgeSection)

  // Section: Chrome-extension activity (#837) — consent-free usage proxy (poll volume + ext reports).
  const extSection = formatExtActivitySection(data.extActivity)
  if (extSection) lines.push(extSection)

  // Section: statusline poll volume (#918) — consent-free adoption proxy for the Claude Code
  // statusline snippets (#400 Phase 1 measurement gate).
  const statuslineSection = formatStatuslineTrafficSection(data.statuslineTraffic)
  if (statuslineSection) lines.push(statuslineSection)

  // Section: Claude Code plugin usage (#920) — monitor polls + /aiwatch briefings.
  const pluginSection = formatPluginTrafficSection(data.pluginTraffic)
  if (pluginSection) lines.push(pluginSection)

  // Section: crowd "Report an issue" counts (#575 Phase A) — internal demand signal only.
  if (data.reportCounts) {
    const nameOf = new Map(services.map((s) => [s.id, s.name]))
    const reportSection = formatReportCountsSection(data.reportCounts, (id) => nameOf.get(id) ?? id)
    if (reportSection) lines.push(reportSection)
  }

  return lines.join('\n')
}

// #548 — render the signed day-over-day subscriber delta as a compact suffix on the webhook line.
// Empty when null (no baseline) or 0 (no change) so the line stays clean. Unicode minus to match the
// brand's status-hint style and avoid an ASCII hyphen reading as a list bullet in Discord.
export function formatSubscriberDelta(newToday: number | null | undefined): string {
  if (newToday == null || newToday === 0) return ''
  return newToday > 0 ? ` (+${newToday} today)` : ` (−${Math.abs(newToday)} today)`
}

// #815 — Tier-1 ntfy phone-push count line (#778). Empty when no push fired today (or absent), so the
// daily summary stays clean on quiet days; a non-zero count is the operator's confirmation the push
// path actually fires on a real incident. Pure + unit-tested.
export function formatPushLine(pushCount: number | null | undefined): string {
  if (!pushCount || pushCount <= 0) return ''
  return `\n📱 **Tier-1 Pushes Sent**: ${pushCount}`
}

/** #842 — outbound-referral count line: total is-down "Open ↗" click-throughs (consent-free beacon),
 *  with a top-3 destination breakdown. Empty until ≥1 click, so the summary stays clean. This is the
 *  Rung-1 sponsor evidence ("we send outage-moment users to the alternative"). Pure + unit-tested. */
export function formatReferralLine(
  referralCounts: { total: number; byService: Record<string, number> } | null | undefined,
  services: ServiceStatus[],
): string {
  if (!referralCounts || referralCounts.total <= 0) return ''
  const nameOf = new Map(services.map((s) => [s.id, s.name]))
  // Self-guard byService (defense-in-depth — the caller already validates, but this exported pure
  // fn shouldn't throw if a future caller passes a malformed object).
  const byService = referralCounts.byService && typeof referralCounts.byService === 'object' ? referralCounts.byService : {}
  const top = Object.entries(byService)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, n]) => `${nameOf.get(id) ?? id} ${n}`)
    .join(' · ')
  return `\n🔗 **Outbound Referrals**: ${referralCounts.total}${top ? ` (${top})` : ''}`
}

// #1055 — 'refhost' reads as "other referrer" in the operator line: the bucket means we saw a
// referring host but don't name it, and 'other-ref' says that more plainly than the field name does.
const AUDIENCE_LABEL: Record<AudienceSource, string> = { x: 'X', search: 'search', feed: 'feed', owned: 'owned', direct: 'direct', plugin: 'plugin', reddit: 'Reddit', hn: 'HN', refhost: 'other-ref' }

/** #842-B — outage-moment audience line (consent-free is-down views by source). The active-outage
 *  subset (the sponsor-evidence "outage-spike audience") first, then the whole day, then the screens.
 *  Zero buckets are dropped so the line stays readable. Empty (section omitted) when the WAE
 *  read was unconfigured/null or there were no views. Pure + unit-tested.
 *
 *  #1280 — this used to branch on `activeTotal > 0`, and the branch cost two things. (1) The
 *  breakdown it printed was `activeBySource` but it sat beside `total`, so it read as a
 *  decomposition of the bigger number: on 2026-08-25 the line said `1 during outages — X 1 · 36
 *  total views` while X had in fact sent 21 of those 36. (2) The `total` breakdown was computed
 *  ONLY in the no-outage branch, so the day's channel mix was hidden on exactly the days traffic
 *  spikes — the 2026-08-25 strategy review had to read `growth:daily` from production KV to get a
 *  trend this line already had the data for. Both numbers now render unconditionally with their own
 *  breakdown attached, and the header no longer changes with the branch: a reader never has to
 *  detect which shape produced the text to know which number `X 21` decomposes. */
export function formatAudienceLine(audience: AudienceCounts | null | undefined): string {
  if (!audience || audience.total <= 0) return ''
  const breakdown = (by: Record<AudienceSource, number>): string =>
    AUDIENCE_SOURCES.filter((s) => by[s] > 0).map((s) => `${AUDIENCE_LABEL[s]} ${by[s]}`).join(' · ')
  const row = (n: number, by: Record<AudienceSource, number>): string => {
    const detail = breakdown(by)
    return detail ? `${n} — ${detail}` : `${n}`
  }
  return (
    `\n👥 **is-down Audience** (24h)\n` +
    `   During outages: ${row(audience.activeTotal, audience.activeBySource)}\n` +
    `   All views: ${row(audience.total, audience.bySource)}` +
    formatAudienceScreenRow(audience.byScreen)
  )
}

/** Max screens named before the rest collapse into a `+N more` tail, so the row cannot wrap into a
 *  wall of text in a Discord embed. */
export const AUDIENCE_SCREEN_TOP_N = 4

/**
 * #1280 — the screen row: WHICH is-down page the day's views landed on. `''` when nothing is
 * attributable. Group ids are resolved to their family before labelling (see outage-audience.ts for
 * why the reported id is not the page). Shape is pinned by `toBe` in daily-summary.test.ts.
 */
export function formatAudienceScreenRow(byScreen: AudienceByScreen | null | undefined): string {
  if (!byScreen) return ''
  const totals = new Map<string, number>()
  for (const surface of AUDIENCE_SURFACES) {
    for (const [svc, n] of Object.entries(byScreen[surface] ?? {})) {
      if (n <= 0) continue
      const label = surface === 'group' ? `${FAMILY_OF_SERVICE[svc]?.slug ?? svc} (group)` : svc
      totals.set(label, (totals.get(label) ?? 0) + n)
    }
  }
  const unattributed = Object.values(byScreen[AUDIENCE_SURFACE_UNKNOWN] ?? {}).reduce((a, b) => a + b, 0)
  if (totals.size === 0 && unattributed === 0) return ''
  const named = [...totals].map(([label, n]) => ({ label, n }))
  named.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
  const shown = named.slice(0, AUDIENCE_SCREEN_TOP_N)
  const hiddenViews = named.slice(AUDIENCE_SCREEN_TOP_N).reduce((a, s) => a + s.n, 0)
  const parts = shown.map((s) => `${s.label} ${s.n}`)
  if (named.length > shown.length) parts.push(`+${named.length - shown.length} more (${hiddenViews})`)
  if (unattributed > 0) parts.push(`${unattributed} unattributed`)
  return `\n   Screens: ${parts.join(' · ')}`
}

/** #827 Feature 1 — AI recovery-prediction accuracy, rendered as a labeled multi-line block so an
 *  operator can read it cold weeks later without decoding jargon. Three plain-language lines, all
 *  anchored on the predicted recovery estimate (its upper bound):
 *    - On-target % = share that recovered within the predicted time (accuracyOf 'accurate' band)
 *    - Typical miss = median absolute distance from the estimate (how far off when wrong-ish)
 *    - Bias        = whether the model leans optimistic (under) or cautious (over)
 *  Empty until the corpus has ≥1 predicted+resolved incident → the whole block is omitted (no "0%"). */
export function formatAccuracyLine(accuracy: AccuracyStats | null | undefined): string {
  if (!accuracy || accuracy.total === 0) return ''
  const pct = Math.round(accuracy.hitRate * 100)
  const err = accuracy.medianAbsErrorHours
  const errStr = err < 1 ? `${Math.round(err * 60)}m` : `${err.toFixed(1)}h`
  const bias = accuracy.underPredicted > accuracy.overPredicted
    ? 'under-estimates (incidents ran longer than predicted)'
    : accuracy.overPredicted > accuracy.underPredicted
      ? 'over-estimates (recovered faster than predicted)'
      : 'balanced (no consistent over/under lean)'
  return `\n🎯 **AI Recovery Prediction Accuracy** (${accuracy.total} forecast${accuracy.total === 1 ? '' : 's'} scored)`
    + `\n   On-target: ${pct}% — actual recovery landed within the predicted time`
    + `\n   Typical miss: ${errStr} off the estimate`
    + `\n   Bias: ${bias}`
}

/**
 * Format the feed-poll volume as a Discord section (#548). Empty string when unavailable (SQL API not
 * configured) so the caller skips it. The per-service split shares the v1 caveat (counts include any
 * malformed /feed/:slug path), so it's shown with `~`. Both counts are WAE sampling estimates
 * (SUM(_sample_interval)); the day-over-day *step-up* is the signal, not the absolute precision.
 * #748 — appends "· N new items": incidents AIWatch first-detected in the window (the alert-worthy
 * event count), so the poll volume isn't misread as "alerts sent" (polls are mostly empty no-ops).
 */
export function formatFeedTrafficSection(
  feed: DailySummaryData['feedTraffic'],
): string {
  if (!feed) return ''
  const newItems = feed.newItems != null
    ? ` · ${feed.newItems} new item${feed.newItems === 1 ? '' : 's'}`
    : ''
  return (
    `\n📡 **Feed Polls (RSS/Slack)**\n` +
    `   Last 24h: ${feed.total} polls (all-feed ${feed.all} · per-service ~${feed.service})${newItems}` +
    formatFeedClientLine(rollupByClient(feed.byFeed), feed.total, feed.byFeed[FEED_UNKNOWN_TARGET] ?? {}) +
    formatSubscribedFeedsLine(feed.byFeed)
  )
}

/**
 * Render the #1273 client-class split as an indented sub-line, e.g. `   Clients: slack 12 · bot 3`.
 * Empty string when nothing was classified, so a window whose rows all predate #1273 renders exactly
 * the pre-#1273 section rather than an empty "Clients:" label. This path renders the LIVE Analytics
 * Engine window, never a stored `growth:daily` row. Pure.
 *
 * `total` and `byUnknown` are both REQUIRED, not optional: omitting either silences a term of the
 * residual, and an optional dimension that silently empties a derived value is the failure this module
 * argues against at `recordFeedTraffic` and `GrowthDailyInputs.feedPolls` (#970).
 *
 * Ordered by count desc, ties by class name, so the line changes only when the data does.
 */
export function formatFeedClientLine(byClient: Record<string, number>, total: number, byUnknown: Record<string, number>): string {
  const entries = Object.entries(byClient)
  const unservedTotal = Object.values(byUnknown).reduce((acc, n) => acc + n, 0)
  // Not `entries.length === 0` alone: a window whose ONLY traffic is 404-answered has no classes to
  // list, and returning early there suppressed the `unserved` term in precisely the case it exists
  // for — a 404 wave large enough to be the whole window rendered as nothing at all.
  if (entries.length === 0 && unservedTotal === 0) return ''
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const classified = entries.reduce((acc, [, n]) => acc + n, 0)
  // The classes sum to LESS than the headline total for two different reasons, and one label cannot
  // carry both: `unserved` is traffic to a feed URL the handler does not serve (the `__unknown__`
  // bucket `rollupByClient` drops — a 400 on an invalid segment or a 404 on an unknown one),
  // `unclassified` is a row carrying no client blob. Separate terms make the arithmetic close.
  const unclassified = total - classified - unservedTotal
  const tail =
    (unservedTotal > 0 ? ` · ${unservedTotal} unserved` : '') +
    (unclassified > 0 ? ` · ${unclassified} unclassified` : '')
  const head = entries.map(([k, n]) => `${k} ${n}`).join(' · ')
  return `\n   Clients: ${head || '—'}${tail}`
}

/** How many feed names to spell out before collapsing the rest into "+N more". */
const SUBSCRIBED_FEEDS_SHOWN = 6

/**
 * The phrase each all-feed state contributes to the `Feeds:` line; `''` contributes no term.
 *
 * A `Record` keyed by the union, not a ternary chain — the same shape `AUDIENCE_LABEL` above uses for
 * its own union, and for the reason `api-traffic.ts`'s `FEED_CLIENT_IS_SUBSCRIBER` writes down in
 * full. A fourth `AllFeedState` added to a chain falls through to `''` and its term goes silent,
 * which is the regression `AllFeedState` was introduced to repair; as a `Record` it is a compile
 * error instead. It also single-sources a phrase the two call sites below used to spell separately.
 *
 * `subscriber floor` says whose polls the floor counts: the headline two lines up reports the
 * all-feed's traffic across EVERY client class, so without that word a crawler-heavy window reads as
 * a large poll count sitting below a small floor.
 */
const ALL_FEED_LABEL: Record<AllFeedState, string> = {
  subscribed: 'all-feed active',
  'below-floor': 'all-feed below subscriber floor',
  none: '',
}

/**
 * Render the feeds a SUBSCRIBER-class client polled (#1273):
 * `Feeds: 2 per-service subscribed (claude, chatgpt) · all-feed active`.
 *
 * The per-service/all-feed split is decided by `subscriberFeeds`, not here — see its docstring for
 * why the all-feed is never inside the count, and for the ways this number undercounts. Empty string
 * when nothing qualifies at all — a window of pure crawler traffic renders no line. Pure.
 */
export function formatSubscribedFeedsLine(byFeed: FeedPollsByTarget): string {
  const { perService, allFeed, belowFloor } = subscriberFeeds(byFeed)
  // The integer names its POPULATION: `below-floor` gives the all-feed a term sharing these words for
  // the first time, and unqualified the two read as one tally — which puts the all-feed back inside a
  // per-service count, the +1-by-construction the split exists to prevent, from the other side.
  const floorNote = belowFloor > 0 ? ` · ${belowFloor} per-service below floor` : ''
  const label = ALL_FEED_LABEL[allFeed]
  if (perService.length === 0) {
    if (!label && !floorNote) return ''
    return `\n   Feeds: 0 per-service subscribed${label ? ` (${label})` : ''}${floorNote}`
  }
  // Count-desc order comes from `subscriberFeeds`; the cap means a newly-subscribed low-volume feed
  // is the first name truncated into `+N more`, while still being counted.
  const shown = perService.slice(0, SUBSCRIBED_FEEDS_SHOWN)
  const more = perService.length - shown.length
  return `\n   Feeds: ${perService.length} per-service subscribed (${shown.join(', ')}${more > 0 ? `, +${more} more` : ''})` +
    (label ? ` · ${label}` : '') + floorNote
}

/**
 * Format the badge-request volume as a Discord section (#1157). Empty string when unavailable (SQL
 * API not configured, or zero requests today) so the caller skips it. Shows the last-24h total plus,
 * when present, the top-3 requested KNOWN serviceIds — the SVG status badges (READMEs, status pages)
 * most actively embedded. The BADGE_UNKNOWN_SERVICE bucket (not-found/retired/typo'd ids, see
 * api-traffic.ts) is excluded from the top-3 ranking (it isn't a real service) and instead reported
 * as a separate "N unknown-id" suffix when present. WAE sampling estimate (SUM(_sample_interval)),
 * like the other traffic sections. Pure.
 */
export function formatBadgeTrafficSection(
  badge: DailySummaryData['badgeTraffic'],
): string {
  if (!badge || badge.total <= 0) return ''
  const unknown = badge.byService[BADGE_UNKNOWN_SERVICE] ?? 0
  const top = Object.entries(badge.byService)
    .filter(([id, n]) => id !== BADGE_UNKNOWN_SERVICE && n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, n]) => `${id} ${n}`)
    .join(' · ')
  const topSuffix = top ? ` (${top})` : ''
  const unknownSuffix = unknown > 0 ? ` · ${unknown} unknown-id` : ''
  return (
    `\n🖼️ **Badge Requests**\n` +
    `   Last 24h: ${badge.total}${topSuffix}${unknownSuffix}`
  )
}

/**
 * Format the Chrome-extension activity as a Discord section (#837). Empty string when unavailable
 * so the caller skips it. Two consent-free signals: last-24h poll volume (WAE `ext-claude` tag — a
 * WAE sampling estimate, shown with `~`; omitted from the line whenever the read did not produce a
 * usable number — polls === null, which since #1293 also covers a malformed AE body, not only an
 * unconfigured SQL API) and today's extension-sourced "Report an issue" count (KV). The real active-user
 * trend lives in the Chrome Web Store dashboard (WAU); this is the in-product engagement proxy.
 *
 * #1293 — the poll total is rendered WITH the running time it represents. A bare `~2010 status polls`
 * is not a number a human reads, and the conversion used to be documented as a step for the reader to
 * perform by hand: during the 2026-08-30 audit nobody had performed it until the poll period was dug
 * out of `extension/config.js`. A rule that asks for mental arithmetic is not a rule. The interval comes
 * from `EXT_POLL_PERIOD_MINUTES`, so changing the extension's alarm changes this line with it.
 *
 * Rendered as DURATION, not as a client count — see `clientMinutesFromPolls` for why a poll total cannot
 * yield a count and why a figure shaped like one is the expensive misreading here. The figure INCLUDES
 * the operator's own browser (a deliberate #1293 decision — excluding it costs dogfooding), which is also
 * what makes it subtractable: a browser running all day is 24h of the total. Pure.
 */
export function formatExtActivitySection(
  ext: DailySummaryData['extActivity'],
): string {
  if (!ext) return ''
  const parts: string[] = []
  if (ext.polls != null) {
    const mins = clientMinutesFromPolls(ext.polls, EXT_POLL_PERIOD_MINUTES)
    // On `null` render the raw total rather than nothing, so a bad constant degrades the line instead
    // of hiding the measurement behind it.
    // `incl. operator` belongs on the LINE, not only in the field docs: the reader of a Discord number
    // is not the reader of the schema. It is also load-bearing arithmetic here — a browser left running
    // all day contributes 24h, so `total − 24h` is a legible lower bound on external usage.
    parts.push(mins == null ? `~${ext.polls} status polls` : `~${ext.polls} status polls ≈ ${formatClientTime(mins, 'browser')} (incl. operator)`)
  }
  if (ext.reports > 0) parts.push(`${ext.reports} issue report${ext.reports === 1 ? '' : 's'}`)
  if (parts.length === 0) return ''
  return `\n🧩 **Chrome Extension**\n   Last 24h: ${parts.join(' · ')}`
}

/** ` (▲+312 vs yesterday)` / ` (▼-540 vs yesterday)` / ` (±0 vs yesterday)`; '' when no baseline
 *  (null delta — first day or corrupt snapshot). A negative delta already carries its own `-` sign. */
export function formatStatuslineDeltaSuffix(delta: number | null | undefined): string {
  if (delta == null) return ''
  if (delta > 0) return ` (▲+${delta} vs yesterday)`
  if (delta < 0) return ` (▼${delta} vs yesterday)`
  return ` (±0 vs yesterday)`
}

/**
 * Format the Claude Code statusline poll volume as a Discord section (#918; #944 cohort-split).
 * Empty string when unavailable (SQL API not configured) OR the 24h grand total is 0, so the caller
 * skips it. Renders TWO cohorts on separate lines instead of one blended total (#944):
 *   • Server-render (#918) — path-tagged presets, the adoption signal we want to GROW (+ per-preset
 *     breakdown, highest-first).
 *   • Legacy/untagged (apex proxy) — the `?src=statusline-proxy` catch-all: pre-#918 jq installs PLUS
 *     any other apex /api/status/cached traffic. NOT a pure adoption signal (it never fully migrates
 *     to zero while the apex rewrite exists), so labelled neutrally — no "migrating" trend claim.
 * Each carries a day-over-day delta (▲/▼ vs yesterday) when a baseline exists. Counts are WAE
 * sampling estimates (SUM(_sample_interval)), shown with `~`; the day-over-day step-up is the signal,
 * not absolute precision. A poll ≈ active-usage proxy (re-renders per prompt), NOT a user count. Pure.
 */
export function formatStatuslineTrafficSection(
  statusline: DailySummaryData['statuslineTraffic'],
): string {
  // #1293 — symmetric with the plugin section: only a MISSING read is silent. Suppressing on
  // `total <= 0` made a measured quiet window indistinguishable from an unconfigured or failed read on
  // the daily surface, which is the distinction the operator-exclusion window exists to see.
  if (!statusline) return ''
  if (statusline.total <= 0) {
    return `\n🖥️ **Statusline**\n   Last 24h: no polls (read OK — no traffic, or the recorder wrote nothing)`
  }
  const delta = statusline.delta
  const breakdown = Object.entries(statusline.byPreset)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([preset, n]) => `${preset} ${n}`)
    .join(' · ')
  const lines = [
    `\n📟 **Statusline Polls (Claude Code)**`,
    `   Server-render (#918): ~${statusline.serverRenderTotal}${formatStatuslineDeltaSuffix(delta?.serverRender)}`,
  ]
  if (breakdown) lines.push(`     ${breakdown}`)
  if (statusline.legacyProxy > 0) {
    lines.push(`   Legacy/untagged (apex proxy): ~${statusline.legacyProxy}${formatStatuslineDeltaSuffix(delta?.legacyProxy)}`)
  }
  return lines.join('\n')
}

/**
 * Format the Claude Code PLUGIN usage as a Discord section (#920). Empty string ONLY when there was no
 * read at all (`null`/`undefined` — SQL API not configured, or the query failed); a measured `{0, 0}`
 * renders a quiet-window line instead of vanishing (see the #1293 note below). Shows the last-24h background-monitor poll volume + on-demand /aiwatch briefings.
 * WAE sampling estimates (shown with `~`); the day-over-day step-up is the signal. A poll ≈
 * active-usage proxy (the monitor polls every 60s while a session is open), NOT a user count.
 *
 * #1293 — the monitor total carries its running-time conversion for the same reason the extension's
 * does. Two caveats this line must not lose. First, the interval assumes `AIWATCH_POLL_SECONDS` is at
 * its DEFAULT: unlike the extension's compiled-in period a user can set it either way with no minimum
 * clamp, so the figure can err in BOTH directions. Second, `no operator exclusion` states the
 * COUNTER'S RULE and not a claim about today's number — the operator has their own monitor disabled to
 * measure external usage, so their share is currently nil, but re-enabling it would make each
 * concurrent session contribute a full day again. The rule holds either way; a claim about presence
 * would not. Briefings are NOT converted: on-demand runs have no rate.
 */
export function formatPluginTrafficSection(
  plugin: DailySummaryData['pluginTraffic'],
): string {
  // #1293 — a wholly quiet window RENDERS, it is not suppressed. It used to return '' for
  // `{0,0}`, which made a measured zero and an unconfigured/failed read look identical on the only
  // surface anyone reads daily. That was tolerable while the operator's own monitor guaranteed a
  // non-zero number; they disabled it to measure external usage, so zero is now the expected reading
  // and the distinction it hides is the one the window was opened to see. `null` (no read) still
  // omits the section — that genuinely has nothing to say.
  if (!plugin) return ''
  if (plugin.monitor <= 0 && plugin.brief <= 0) {
    return `\n🧩 **Plugin (Claude Code)**\n   Last 24h: no polls (read OK — no traffic, or the recorder wrote nothing)`
  }
  const parts: string[] = []
  if (plugin.monitor > 0) {
    const mins = clientMinutesFromPolls(plugin.monitor, PLUGIN_POLL_PERIOD_SECONDS / 60)
    // `no operator exclusion` states the COUNTER'S RULE, not a claim about who is in today's number.
    // `incl. operator` would be false right now — the operator disabled their own monitor to measure
    // external usage — but true again the moment they re-enable it, and the code cannot know which.
    // The rule holds either way; a claim about presence would not.
    parts.push(mins == null ? `~${plugin.monitor} monitor polls` : `~${plugin.monitor} monitor polls ≈ ${formatClientTime(mins, 'session')} (default interval, no operator exclusion)`)
  }
  if (plugin.brief > 0) parts.push(`~${plugin.brief} /aiwatch briefings`)
  return `\n🧩 **Plugin (Claude Code)**\n   Last 24h: ${parts.join(' · ')}`
}

/**
 * Format the /api/v1 traffic counters as a Discord section (#518).
 * Returns empty string when traffic data is unavailable (SQL API not configured) so the caller
 * skips the section. Shows the last-24h total (with the all-vs-per-service split) and the running
 * cumulative since first measurement. Two approximations are surfaced honestly with `~`:
 *  - per-service counts include malformed/404 per-service paths (recorded before handler validation),
 *  - the cumulative is a once/day snapshot of a 24h rolling window, so it can drift or miss a skipped day.
 * The 24h total (the clean signal) is shown without `~`.
 */
export function formatV1TrafficSection(
  v1: DailySummaryData['v1Traffic'],
): string {
  if (!v1) return ''
  const { today, cumulative, since } = v1
  return (
    `\n🔌 **Public API (/api/v1)**\n` +
    `   Last 24h: ${today.total} (all-services ${today.all} · per-service ~${today.service})\n` +
    `   Cumulative: ~${cumulative} (since ${since})`
  )
}

/**
 * Format the RTT-degradation daily counters as a Discord section (#464).
 * Returns empty string when no degradations were recorded (caller skips the section).
 * The `not on official status page` total is the headline differentiator — degradations status
 * pages never report. Per-service breakdown sorted by total spikes descending.
 */
export function formatDegradationSection(
  degradationCounts: Record<string, number> | undefined,
  degradationNoStatusCounts: Record<string, number> | undefined,
  services: ServiceStatus[],
): string {
  if (!degradationCounts || Object.keys(degradationCounts).length === 0) return ''
  const nameMap = new Map(services.map(s => [s.id, s.name]))
  const totalSpikes = Object.values(degradationCounts).reduce((a, b) => a + b, 0)
  const totalNoStatus = Object.values(degradationNoStatusCounts ?? {}).reduce((a, b) => a + b, 0)
  const items = Object.entries(degradationCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([id, total]) => {
      const ns = degradationNoStatusCounts?.[id] ?? 0
      const detail = ns > 0 ? `${ns} not on official status page` : 'all reflected on status page'
      return `   ${nameMap.get(id) ?? id}: ${total} RTT spike${total === 1 ? '' : 's'} (${detail})`
    })
    .join('\n')
  return `\n📈 **RTT Degradations (~48h)** — ${totalSpikes} total · ${totalNoStatus} not on official status pages\n${items}`
}

/**
 * Check if the current time falls within a daily summary window.
 * Normal window: UTC 09:00-09:04. Catch-up window: UTC 10:00-10:04.
 * Pure function — KV dedup is handled separately by the caller.
 */
export function isInSummaryWindow(
  utcHours: number,
  utcMinutes: number,
): { inWindow: boolean; isCatchUp: boolean } {
  const isNormalWindow = utcHours === 9 && utcMinutes < 5
  const isCatchUpWindow = utcHours === 10 && utcMinutes < 5
  if (!isNormalWindow && !isCatchUpWindow) return { inWindow: false, isCatchUp: false }
  return { inWindow: true, isCatchUp: !isNormalWindow }
}

function formatDurationFromStart(startedAt: string): string {
  const diff = Date.now() - new Date(startedAt).getTime()
  if (isNaN(diff) || diff < 0) return ''
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  return `${days}d`
}

export function computeLatencyAvg(snapshots: Array<{ t: string; data: Record<string, number> }>): Record<string, number> {
  const sums: Record<string, number> = {}
  const counts: Record<string, number> = {}
  for (const snap of snapshots) {
    for (const [id, ms] of Object.entries(snap.data)) {
      sums[id] = (sums[id] ?? 0) + ms
      counts[id] = (counts[id] ?? 0) + 1
    }
  }
  const avg: Record<string, number> = {}
  for (const id of Object.keys(sums)) {
    avg[id] = sums[id] / counts[id]
  }
  return avg
}

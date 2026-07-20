// #1072 — NON-CARDED upstream feeds: a status source AIWatch reads ONLY to answer "is this upstream
// impacted right now?" for `upstream-link.ts` (#1053). It is deliberately NOT a service:
//   - no card, no is-down page, no Score, no uptime, no daily counters, no service-count change
//   - the only consumer is gate 4/5 of `buildUpstreamLinks`
//
// Why this layer had to exist. On 2026-07-19/20 a GitHub Actions outage took ChatGPT and Codex with
// it, and OpenAI said so in its own title (`Elevated errors for GitHub-dependent ChatGPT and Codex
// workflows`). #1053 could not fire, and could never fire for GitHub, because its upstream must be a
// monitored `services[]` entry that is itself impacted — and the only GitHub entry we have is
// `copilot`, scoped to component ids `pjmpxvq2cmr2` + `cnnb39dkkk82` — both of which, as observed on
// 2026-07-20, stayed `operational` for the whole incident while `Actions` / `API Requests` broke.
//
// The tempting fix — adding those component ids to `copilot.statusComponentIds` — is the #1008
// cross-product attribution bug: `Actions` is not part of Copilot, so every Actions outage would
// redden the Copilot badge and damage its uptime/Score while Copilot itself is fine. A feed keeps the
// signal and the badge separate, which is the entire point.
//
// Precedent for a non-service health source: `supply-chain.ts` consumes `bedrock.awsRegionHealth`.
// The difference is that one rides on a real service; this one has no service to ride on.

import type { Incident, ServiceStatus } from './types'
import { type StatuspageResponse, normalizeStatus, parseIncidents } from './parsers/statuspage'

/**
 * The shape `buildUpstreamLinks` needs from an upstream — the whole contract, and deliberately NOT
 * `ServiceStatus`.
 *
 * A feed has no honest `category` (GitHub Actions is not `api`/`app`/`agent`), no `provider` we
 * display, no `latency`, and no `uptime30d` we are entitled to compute — it is not monitored, it is
 * consulted. Typing it as a `ServiceStatus` would force four lies into the object and, worse, would
 * let it be passed anywhere a service is accepted (scoring, counters, badges) with the type-checker
 * approving. The narrow type IS the guard rail.
 */
export type UpstreamCandidate = Pick<ServiceStatus, 'id' | 'name' | 'status' | 'incidents'> & {
  /** The upstream's OWN public status page. Present on feeds, absent on services — deliberately, and
   *  not an oversight: a service upstream is linked to its AIWatch is-down page instead (keeping the
   *  reader on the site), and `ServiceStatus` does not carry `statusUrl` anyway — it lives on
   *  `ServiceConfig`, which never reaches this layer. So `undefined` here means "link internally",
   *  which is exactly right for every service.
   *
   *  A feed has no is-down page, so without this the row would name an outage and give the reader
   *  nowhere to check it. */
  statusUrl?: string
}

export interface UpstreamFeedConfig {
  /** The upstream's id, as referenced by `UPSTREAM_DEPS[].upstreamIds`. Namespaced with a `-platform`
   *  suffix so it can never collide with a real service id (pinned by a test — the collision would
   *  otherwise resolve silently to the service). It surfaces publicly only as
   *  `upstreamLinks[].upstream[].id`, and only when a link actually fires. */
  id: string
  /** Display name — what the is-down note prints. */
  name: string
  /** MUST be a page some service already fetches, so the feed costs ZERO extra subrequests: it is
   *  built from `fetchAllServices`'s existing prefetch map. `githubstatus.com` is already fetched for
   *  `copilot`. A feed on an unfetched page would need its own request, which is a different (and
   *  more expensive) design decision than this one — assert the reuse rather than assume it. */
  apiUrl: string
  /** The upstream's human-facing status page — where a reader goes to check the outage themselves.
   *  Required on a feed (unlike on `UpstreamCandidate`, where absence is meaningful): a feed with no
   *  is-down page AND no official link is a dead end, so there is no valid config without it. */
  statusUrl: string
  /** The components that CONSTITUTE this upstream, by Atlassian component id. Ids, not names,
   *  because a name is not a stable key on a status page (status.openai.com carries two components
   *  both literally named "Login" — see the `Incident.componentIds` note in types.ts). */
  componentIds: string[]
}

/**
 * The declared feeds. CURATED, one entry per real observed dependency — the same evidence bar
 * `UPSTREAM_DEPS` holds itself to, for the same reason: an inferred dependency map is how a
 * correlation layer starts printing coincidences.
 *
 * GitHub — `Actions` + `API Requests`. Scoped to exactly the two components observed impacted in the
 * evidenced incident. `Issues` and `Pages` degraded in that same incident and are deliberately absent:
 * no dependent has ever attributed an outage to them, and widening the feed widens what can trip gate
 * 4 without widening what it can explain. Add a component when an incident shows it mattered.
 */
export const UPSTREAM_FEEDS: UpstreamFeedConfig[] = [
  {
    id: 'github-platform',
    name: 'GitHub',
    apiUrl: 'https://www.githubstatus.com/api/v2/summary.json',
    statusUrl: 'https://www.githubstatus.com',
    componentIds: [
      'br0l2tvcx85d', // Actions
      'brv1bkgrwx7q', // API Requests
    ],
  },
]

/** Every input `normalizeStatus` recognizes — page INDICATORS (`none`/`minor`/`major`/`critical`) and
 *  component STATUSES both, because that function serves both and its switch does not separate them.
 *  So this guard is looser than a component-only vocabulary would be: a component reporting `none`
 *  would not warn. That is acceptable (the miss is a value that maps correctly anyway) and stated
 *  rather than implied by the name.
 *
 *  Duplicated from the switch arms ON PURPOSE and kept beside the warn that reads it: the point is to
 *  detect a value that function does NOT know, so deriving the set from it would be circular.
 *  `parsers/statuspage.ts` stays the source of truth. Drift in the two directions is not symmetric:
 *   - a case ADDED there and not here → spurious warns until it is added (benign, self-announcing).
 *   - a case REMOVED/renamed there and not here → that status silently falls to the default
 *     `operational` arm AND this guard stays quiet, i.e. it disables itself in the one scenario it
 *     exists for. That direction is pinned by a test asserting each mapping still holds. */
const KNOWN_NORMALIZE_STATUS_INPUTS = new Set([
  'none', 'operational',
  'minor', 'degraded_performance', 'partial_outage',
  'major', 'critical', 'major_outage',
])

/**
 * `console.warn`/`error` throttled per distinct message.
 *
 * `buildUpstreamFeeds` runs inside `fetchAllServices`, which `/api/status` calls on EVERY request
 * (only the KV write is throttled) — so with a 60s dashboard poll per open tab this is a per-request
 * path. Every condition these logs report is PERSISTENT, not transient: drifted component ids never
 * heal, `under_maintenance` lasts hours, a component-less incident lasts the whole outage. Logging
 * them per request would emit thousands of identical lines an hour, which destroys the diagnostic
 * value the logs exist for (the signal is buried by its own repetition) and spends Workers Logs
 * volume against a budget this project treats as an architectural constraint.
 *
 * Module-level state is per-isolate, exactly like `index.ts`'s `lastKvWrite` throttle. That means a
 * cold isolate re-logs — which is the behaviour we want: the ceiling is on repetition, not on ever
 * being told. Keyed by the full message so a CHANGED condition (a different component drifting)
 * reports immediately instead of hiding behind the previous one's window.
 */
const lastLogged = new Map<string, number>()
const LOG_THROTTLE_MS = 10 * 60 * 1000

function throttledLog(level: 'warn' | 'error', msg: string, now: number): void {
  // The key space is bounded in practice — the messages interpolate config constants plus component
  // names/statuses off the page, which are single digits. But "in practice" is an argument about
  // today's remote payload, not a property of this code, and the map never evicts. One line makes it
  // a fact. Clearing wholesale (rather than LRU) is deliberate: the only cost is re-logging sooner.
  if (lastLogged.size > 64) lastLogged.clear()
  const prev = lastLogged.get(msg)
  if (prev != null && now - prev < LOG_THROTTLE_MS) return
  lastLogged.set(msg, now)
  if (level === 'error') console.error(msg)
  else console.warn(msg)
}

/** Test seam: the throttle is module state, so a test asserting a log fires must be able to clear it
 *  (otherwise a later test silently inherits an earlier one's window and asserts nothing). */
export function __resetLogThrottleForTests(): void { lastLogged.clear() }

/** Worst-of, matching how `services.ts` resolves a multi-component service. */
function worstOf(statuses: Array<'operational' | 'degraded' | 'down'>): 'operational' | 'degraded' | 'down' {
  if (statuses.includes('down')) return 'down'
  if (statuses.includes('degraded')) return 'degraded'
  return 'operational'
}

/**
 * Build one feed's candidate from an ALREADY-FETCHED status-page summary, or null when the page
 * cannot answer.
 *
 * Null when NONE of the configured component ids resolve. That is fail-closed and it is the case
 * worth logging loudly: the ids are hard-coded, so a page that renames or re-ids its components turns
 * this feed into a permanent silent no-op — a dead upstream link nobody would notice, because the
 * feature's normal state is also silence (it fires a handful of times a year). A PARTIAL resolve is
 * NOT null: the feed still has a real answer from the components that did resolve, and it warns.
 *
 * Incidents are filtered to the feed's own components by NAME, not id, even though the config is
 * id-keyed. The asymmetry is forced by the payload, not chosen: `parseIncidents` output carries
 * `componentNames` and no `componentIds` (only `attachIncidentIoComponentIds` ever writes those, for
 * a different page format), and the Statuspage incident payload's `components[]` is name-only in our
 * type. So the names are DERIVED HERE from the id lookup rather than written into the config — the
 * config keeps its single stable key, and a component rename follows automatically instead of
 * silently emptying the filter.
 */
export function buildUpstreamFeedStatus(
  cfg: UpstreamFeedConfig,
  summary: StatuspageResponse | undefined,
  now: number = Date.now(),
): UpstreamCandidate | null {
  const all = summary?.components
  if (!Array.isArray(all) || all.length === 0) {
    throttledLog('warn', `[upstream-feed] ${cfg.id}: summary carried no components — feed unavailable this cycle`, now)
    return null
  }

  const matched = cfg.componentIds
    .map((id) => all.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => c != null)

  if (matched.length === 0) {
    throttledLog('error',
      `[upstream-feed] ${cfg.id}: NONE of the configured component ids resolved on ${cfg.apiUrl} — ` +
      `the page's component ids have drifted and this feed is now a silent no-op. Configured: ${cfg.componentIds.join(', ')}`,
      now)
    return null
  }
  if (matched.length < cfg.componentIds.length) {
    const missing = cfg.componentIds.filter((id) => !all.some((c) => c.id === id))
    throttledLog('warn', `[upstream-feed] ${cfg.id}: component ids did not resolve: ${missing.join(', ')} — feed built from the rest`, now)
  }

  // A status vocabulary this parser does not know maps to `operational` (`normalizeStatus`'s default
  // arm). For a SERVICE that mistake is self-reporting — the card goes green while the provider's page
  // is red and someone says so. A feed has no card, no badge and no Score, so the same mistake is
  // indistinguishable from health and gate 4 just declines forever. `under_maintenance` is a real
  // Statuspage component status that already falls through that arm today.
  for (const c of matched) {
    if (!KNOWN_NORMALIZE_STATUS_INPUTS.has(c.status)) {
      throttledLog('warn',
        `[upstream-feed] ${cfg.id}: component "${c.name}" reports unrecognized status "${c.status}" — ` +
        `normalizeStatus treats it as operational, so this feed will read healthy while the page may not be`,
        now)
    }
  }

  const status = worstOf(matched.map((c) => normalizeStatus(c.status)))
  const ownNames = new Set(matched.map((c) => c.name))
  const incidents: Incident[] = parseIncidents(summary!).filter((inc) =>
    (inc.componentNames ?? []).some((n) => ownNames.has(n)),
  )

  // Status comes from component IDS, incidents from component NAMES (the asymmetry documented above),
  // so the two halves can disagree — and only the id half has a guard. This is the disagreement that
  // matters: the feed says "impacted" but can name no incident, so gate 5 finds no cause and the link
  // stays silent THROUGH a live outage. Not hypothetical — GitHub publishes incidents with no
  // component association at all (`ph5nns5y4gxj` on 2026-07-20 had `components: []` and every update
  // carrying `affected_components: null`), and had the Actions incident taken that shape, this feature
  // would have shipped, gone quiet, and looked correct. The feed can detect the contradiction itself,
  // so it must say so.
  if (status !== 'operational' && incidents.length === 0) {
    throttledLog('warn',
      `[upstream-feed] ${cfg.id}: components report "${status}" but NO incident attributes to ` +
      `[${[...ownNames].join(', ')}] — the upstream link cannot quote a cause and will stay silent ` +
      `through this outage. Likely the page published the incident without component associations.`,
      now)
  }

  return { id: cfg.id, name: cfg.name, status, incidents, statusUrl: cfg.statusUrl }
}

/**
 * Every declared feed that could be built this cycle.
 *
 * `prefetched` is keyed by `apiUrl` — the same map `fetchAllServices` already built for services, so
 * a feed on an already-fetched page adds no network cost. A feed whose page failed to prefetch is
 * simply absent this cycle (the link stays quiet), which is the correct fail-closed behaviour: with
 * no upstream status we have nothing we could honestly claim.
 */
export function buildUpstreamFeeds(
  prefetched: Map<string, { summary: StatuspageResponse }>,
  now: number = Date.now(),
): UpstreamCandidate[] {
  const out: UpstreamCandidate[] = []
  for (const cfg of UPSTREAM_FEEDS) {
    const data = prefetched.get(cfg.apiUrl)
    if (!data) {
      throttledLog('warn', `[upstream-feed] ${cfg.id}: ${cfg.apiUrl} was not prefetched this cycle — feed skipped`, now)
      continue
    }
    const feed = buildUpstreamFeedStatus(cfg, data.summary, now)
    if (feed) out.push(feed)
  }
  return out
}

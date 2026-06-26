// Shared type definitions for AIWatch Worker

export interface TimelineEntry {
  stage: 'investigating' | 'identified' | 'monitoring' | 'resolved'
  text: string | null
  at: string
}

export interface Incident {
  id: string
  title: string
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
  impact: 'minor' | 'major' | 'critical' | null
  componentNames?: string[]
  startedAt: string
  resolvedAt?: string | null
  duration: string | null
  timeline: TimelineEntry[]
}

/** A single status-page component preserved for the per-component breakdown (#604).
 *  Only the availability-relevant subset configured via `statusComponentIds` is kept —
 *  Billing/Support etc. are intentionally excluded to match the badge's curated scope. */
export interface ServiceComponent {
  id: string
  name: string
  status: 'operational' | 'degraded' | 'down'
  // #606 — optional group label for the collapsible breakdown. Components sharing a
  // group (e.g. 'Models') collapse under one header row; ungrouped components ("surfaces"
  // like API/Console) render individually. Set by the worker in displayAllComponents mode
  // (everything not in componentSurfaces → the Models group); absent for curated services.
  group?: string
}

export interface ServiceStatus {
  id: string
  name: string
  provider: string
  category: 'api' | 'app' | 'agent'
  status: 'operational' | 'degraded' | 'down'
  latency: number | null
  uptime30d: number | null
  lastChecked: string
  incidents: Incident[]
  /** #574 — set ONLY on `bedrock`: currently-degraded AWS regions derived from the same AWS Health
   *  public-events fetch (all AWS services, via parseAwsRegionHealth). The supply-chain banner reads
   *  this off the bedrock entry to correlate a cloud-region issue with AWS-dependent AI services.
   *  Rides on bedrock's ServiceStatus → persisted in services:latest (live + cached both have it). */
  awsRegionHealth?: Record<string, { level: 'degraded' | 'down'; summary?: string }>
  /** #575 Phase B — an active consecutive probe-RTT spike (≥3 cycles >3× median or failed), via
   *  detectConsecutiveSpikes. An independent "the API looks unhealthy" signal. Used to cross-match
   *  crowd reports: an operational page + a probe spike + enough crowd reports surfaces the gated
   *  "Recent user reports" early-warning. Absent when no spike / no probe data. */
  probeSpike?: boolean
  /** #604 — per-component snapshot for multi-component services (cerebras / cursor /
   *  copilot / windsurf / langsmith / runway). The curated `statusComponentIds` subset,
   *  worst-of'd into `status` above but retained here for the ServiceDetails / is-down
   *  breakdown. Present only when ≥2 components matched; absent otherwise. */
  components?: ServiceComponent[]
  // Per-day impact for the status calendar. Keys are either a bare UTC date `YYYY-MM-DD`
  // (statuspage/betterstack — already the source's daily bucket) OR a full ISO timestamp
  // (incident.io — so the client can bucket the real instant into the VIEWER's local day, fixing the
  // UTC-vs-local off-by-one; #693 follow-up). buildCalendarFromIncidents handles both key forms.
  dailyImpact?: Record<string, DailyImpactLevel>
  calendarDays?: number
  uptimeSource?: 'official' | 'platform_avg' // #713 — 'estimate' removed; no invented uptime
  detectedAt?: string
  /** BetterStack only: count of resources reporting a real issue (degraded/downtime)
   *  while the service stays operational under the <30% threshold (#447). UI shows a
   *  "N affected" badge; absent when 0. */
  partialCount?: number
  /** #591 — the service's incident source is known-stale (its status page migrated to a
   *  platform AIWatch can't reach server-side, so the feed AIWatch reads is frozen — e.g.
   *  DeepSeek → Flashduty, #507). The incident list/uptime read as current but aren't, which
   *  inflates the Score (an empty 30-day incident window scores full incidents+recovery). All
   *  ranking surfaces exclude these (like estimate-only services) so a frozen feed can't rank.
   *  Declared per-service via ServiceConfig.incidentSourceStale; absent when false. */
  incidentSourceStale?: boolean
  /** #689 — the status-page API returned a 4xx (the page is deactivated/gone, e.g. Character.AI's
   *  Statuspage → 401 "page inactive"). The service is shown operational+stale (not a false degraded);
   *  this flag lets the cron send a distinct "status source inactive" operator alert (not a misleading
   *  "degraded" alert) so the source death is judged accurately. Runtime-only; absent when the source
   *  responds. */
  sourceDead?: boolean
  /** #714 — set on a transient/indeterminate fetch outcome (the status-page fetch threw, or the
   *  summary.json returned 5xx) — as opposed to `sourceDead` (a confirmed 4xx, incl. 429) or a clean
   *  success (neither flag = alive).
   *  Mutually exclusive with `sourceDead` (set on disjoint return paths). The source-inactive operator
   *  alert reads this so a single transient hiccup mid-dead-source is held as 'unknown' rather than
   *  misread as a 'recovered' signal (the #714 Inactive/Recovered flap). Runtime-only. */
  sourceUnknown?: boolean
  /** #689 — set when `sourceDead` AND a healthy direct probe independently confirms the service is
   *  reachable (the 2nd case: a PROBED service whose status PAGE died but whose API still responds).
   *  Then the badge stays operational (probe-backed) instead of "Unknown"; the un-probed case
   *  (sourceDead without this) shows "Unknown". Set by the cross-validation in `fetchAllServices`. */
  probeConfirmed?: boolean
}

export type DailyImpactLevel = 'minor' | 'major' | 'critical'

export interface ServiceConfig {
  id: string
  name: string
  provider: string
  category: 'api' | 'app' | 'agent'
  statusUrl: string
  apiUrl: string | null
  instatusUrl?: string
  gcloudProduct?: string
  gcloudProductId?: string
  // Dual-source flag: fetch aistudio.google.com/status in parallel with
  // the gcloud Vertex feed. Incidents from both sources are merged; IDs get
  // 'vertex:' / 'aistudio:' prefixes to avoid collision (#310).
  aistudioStatus?: boolean
  rssFeedUrl?: string
  incidentKeywords?: string[]
  incidentExclude?: string[]
  // #683 — exact-component-name incident scoping for a SHARED status page where this is the only
  // AIWatch service but siblings' component incidents leak (Junie on status.jetbrains.ai: a
  // Grazie-only incident must NOT attribute to Junie). When set, filterIncidents keeps an incident
  // only if its `componentNames` contains an EXACT (case-insensitive) match — NOT substring, so
  // 'AI Platform' can't collide with the sibling 'AI Platform China'. Takes precedence over
  // incidentKeywords; an untagged incident (no componentNames) matches nothing and is dropped.
  incidentComponents?: string[]
  incidentIoBaseUrl?: string
  statusComponent?: string
  statusComponentId?: string
  // Optional: multiple components to track for the badge (worst-status wins).
  // When set, the dashboard status is `down` if any component is `major_outage`,
  // `degraded` if any is `partial_outage`/`degraded_performance`, else `operational`.
  // `statusComponentId` remains the *primary* component used for uptime parsing,
  // calendar days, and component-miss alerting; this list adds extra surfaces
  // whose health should also flip the badge (e.g. Cursor IDE primary +
  // Cloud Agents/Automations as user-impacting agentic surfaces).
  // An empty array `[]` is treated as if the field were absent — the resolver
  // falls through to the single-`statusComponentId` path. Only use this for
  // sibling surfaces of the *same* product (cursor IDE + cursor Cloud Agents);
  // dependency tracking (e.g. Claude Code → Claude API) creates badge/incident
  // asymmetry when the dependency's incidents don't match the service's
  // `incidentKeywords` filter. See #379 review for the trade-off.
  statusComponentIds?: string[]
  // #606 — display-only per-component breakdown list, DECOUPLED from the badge.
  // `statusComponentIds` drives both the worst-of badge AND the #604 breakdown; this
  // field drives ONLY the breakdown (read by resolveSvcComponents, never resolveSvcStatus),
  // so a service whose badge stays on the overall page indicator (no statusComponentIds)
  // can still surface a curated component card without changing its status determination.
  // Use for single-owner statuspages with rich components (elevenlabs, replicate) where
  // worst-of'ing every component into the badge would be too noisy (e.g. a Billing blip).
  // When both are set, the breakdown prefers displayComponentIds.
  displayComponentIds?: string[]
  // #606 Category A (cohere/groq) — DYNAMIC breakdown for per-model statuspages with
  // many, frequently-changing components. Instead of a hardcoded id list (which goes
  // stale as models ship/retire), surface EVERY page component except `componentDenylist`
  // names. Zero model-churn maintenance. The UI collapses the (long) list to a
  // "N of M operational" summary + non-operational rows when it exceeds a threshold.
  // Display-only (never feeds resolveSvcStatus), like displayComponentIds; takes
  // precedence over both id lists when set. Pair with componentDenylist.
  displayAllComponents?: boolean
  // Names (case-insensitive exact match) excluded from the displayAllComponents set —
  // non-availability surfaces like Docs/Website. Kept small + stable (unlike the model list).
  componentDenylist?: string[]
  // Names (case-insensitive) treated as individual "surface" rows in the breakdown; every
  // OTHER displayAllComponents component is folded into a collapsible "Models" group (#606,
  // matching the official status page's Endpoints/Models split). e.g. groq: ['API'];
  // cohere: ['Coral','Infrastructure','Playground','embeddings']. Empty/absent → all grouped.
  componentSurfaces?: string[]
  // #606 Cat B — source the breakdown's component LIST from this URL (an Atlassian/incident.io
  // `components.json`) instead of the `apiUrl` summary.json. Needed when a shared status page
  // exposes more components in components.json than summary.json (e.g. status.openai.com:
  // FedRAMP, Chat Completions, the separate API Login). Status/incidents/uptime still come from
  // summary.json; only resolveSvcComponents reads this. Falls back to summary.json on fetch error.
  componentsUrl?: string
  incidentIoComponentId?: string
  incidentIoGroupId?: string       // incident.io group uptime (e.g. "APIs" aggregate)
  betterStackUrl?: string
  onlineOrNotUrl?: string
  onlineOrNotComponent?: string
  // #677 — AWS Health Dashboard public events JSON API (start+end+typeCode per incident). Replaced
  // the legacy per-region RSS for Bedrock: real start/end timestamps → correct duration, one event
  // per incident (no per-update-epoch guid split / 1m floor / double-count). Plain fetch, no scrape.
  awsHealthApi?: { url: string; service: string }
  azureRssUrl?: string // Azure OpenAI still uses the Azure status RSS (reuses parseAwsRssIncidents)
  // BetterStack RSS emits "<model> — recovered" per auto-recovery blip; a single day can
  // produce 10-20 alerts per affected model. Opt-in suppression dedups by normalized title
  // in a 60-minute window. See #283 and isFlapSuppressible() in alerts.ts.
  flapSuppression?: boolean
  // #792 — hold ANY new non-major incident one cron cycle (reuses the #633 pending:new gate) for
  // services that fire frequent short `minor` blips AND backdate their resolution (e.g. Langfuse:
  // many <30m ingestion/latency incidents). Without it, a blip already resolving when our */5 cron
  // first catches it fires a New+Resolved Discord double-alert the live dashboard never reflects.
  // Distinct from flapSuppression (which only holds the BetterStack "— down/recovered" title shape).
  // See isShortIncidentHoldable() in alerts.ts. `major` + Tier-1 always alert immediately.
  holdShortIncidents?: boolean
  // #591 — mark a service whose status page migrated to a server-side-unreachable platform, so
  // the feed AIWatch reads is FROZEN (e.g. DeepSeek → Flashduty, #507). Propagated to
  // ServiceStatus.incidentSourceStale → all ranking surfaces exclude it (a frozen empty 30-day
  // incident window would otherwise inflate the Score). REMOVE once the feed is reachable again.
  incidentSourceStale?: boolean
  // #618 — the service's live status comes from a browser-rendered Flashduty feed pushed to KV by
  // the deepseek-feed GitHub Action (status.deepseek.com is bot-walled to a plain Worker fetch).
  // When set, fetchService reads DEEPSEEK_FEED_KV_KEY first; a FRESH feed supersedes apiUrl and
  // clears incidentSourceStale, while a missing/expired feed falls through to apiUrl (the frozen
  // Atlassian mirror) keeping incidentSourceStale. Pairs with incidentSourceStale (the fallback).
  flashdutyFeed?: boolean
  // #618 option A — scope the Flashduty feed to a single component id (the API surface), excluding
  // sibling consumer-app components (e.g. DeepSeek's Web Chat) from the badge/incidents/uptime/score
  // — the same api-vs-app split as OpenAI API (incidentExclude:['chatgpt']). Absent → whole feed.
  flashdutyPrimaryComponentId?: string
}

export interface ProbeSummary {
  p50: number
  p95: number
  cvCombined: number
  validDays: number // how many days contributed to this summary
}

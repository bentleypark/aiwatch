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
  // #1032 — the status-page component IDS this incident affects, tagged at the source from the
  // incident.io page HTML's `component_impacts` (`attachIncidentIoComponentIds`). Distinct from
  // `componentNames` on purpose: status.openai.com has TWO components both literally named "Login"
  // (one in the APIs group → openai, one in the ChatGPT group → chatgpt; verified live 2026-07-16 via
  // components.json), so a name can NOT disambiguate them and every name-keyed rule (#359 bypass,
  // #683 `incidentComponents`) is structurally blind here.
  //
  // Written ONLY by `attachIncidentIoComponentIds`, which must never touch `componentNames`: the
  // EMPTINESS of `componentNames` is what `filterByComponentStatus` (#970) reads as "untagged →
  // drop", and langsmith/langfuse are badge-id-scoped, so tagging them page-wide would silently flip
  // their behaviour despite having no stake in #1032. (`includeUntaggedIncidents` keys on that
  // emptiness too, but only for `incidentKeywords`-scoped services — which those two are not.)
  //
  // TWO judgement readers today, both intersecting it with this service's badge group and both gated on
  // `canIdBypass`: `filterIncidents`' exclude-bypass (#1032) and `filterByComponentStatus`' active-keep
  // (#1104). (`fetchService` also reads it for its join-health warn — a diagnostic, not a judgement.)
  // That is a fact, not a rule the type can enforce — the field is serialized onto /api/status
  // like `autoMonitor` (#983), so treat a new reader as a decision to make, not a violation. NOT index-aligned with `componentNames`, and the
  // two may come from different sources (e.g. `parsers/aws.ts` writes AWS REGIONS into
  // `componentNames`, which have no component id at all).
  componentIds?: string[]
  startedAt: string
  resolvedAt?: string | null
  duration: string | null
  timeline: TimelineEntry[]
  // #983 — this incident was opened by the provider's AUTO-MONITOR, not written by a human.
  // Stamped in services.ts from `ServiceConfig.autoMonitorTitles`; serialized on /api/status so the
  // SPA + is-down SSR grouping read the same tag the alert path does (the #940 "tag at the source"
  // precedent). Everything downstream previously inferred "a human wrote this" from `impact != null`
  // / `impact !== 'major'`, which is false for an Atlassian page: Statuspage DERIVES `impact` from
  // component status, so one sub-component at `major_outage` yields `impact: 'major'` on a 6-minute
  // machine-emitted blip. Absent (undefined) on every untagged service — never assume `false`.
  autoMonitor?: boolean
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
  /** #802 — days AIWatch has monitored this service, from `ServiceConfig.addedAt` (now − addedAt).
   *  ABSENT when the service has no `addedAt` (= an established service well past the window → treated
   *  as full coverage). A service with `coverageDays < 30` is excluded from the Reliability Ranking
   *  (its incident/recovery/responsiveness Score components are based on a thin observed window, so it
   *  would rank off insufficient data) and routed to the "Insufficient Data" group until 30d accrue. */
  coverageDays?: number
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
  /** When true, the breakdown UI renders its sections (each componentGroups group as a collapsible
   *  block; each consecutive run of ungrouped components as a surface grid) in COMPONENT-ARRAY order —
   *  groups interleaved among surfaces exactly where the curated `displayComponentIds` array places
   *  their first member — instead of the default "surfaces grid first, then all groups". Lets a curated
   *  array fully control layout (replicate: API · Inference and Training · Website groups, then the
   *  Registry/Official Models surface rows, then the Support group). Propagated from config via `base`. */
  componentGroupsInline?: boolean
  // Per-day impact for the status calendar. Keys are either a bare UTC date `YYYY-MM-DD`
  // (statuspage/betterstack — already the source's daily bucket) OR a full ISO timestamp
  // (incident.io — so the client can bucket the real instant into the VIEWER's local day, fixing the
  // UTC-vs-local off-by-one; #693 follow-up). buildCalendarFromIncidents handles both key forms.
  dailyImpact?: Record<string, DailyImpactLevel>
  calendarDays?: number
  /** #1017 — TODAY's weighted outage seconds (UTC calendar day, [startOfTodayUTC, now]). Populated
   *  by all 5 "official" uptime sources, via two different mechanisms: incident.io / Instatus /
   *  Flashduty / OnlineOrNot compute it with a SECOND, cheap `weightedDowntimeSeconds` call over the
   *  same `intervals[]` already built for their 30-day `uptime30d` figure (today's window instead of
   *  30d); Atlassian Statuspage instead reads the provider's own last-published per-day bucket
   *  directly (it doesn't build an `OutageInterval[]` at all — see statuspage.ts). Absent for Better
   *  Stack (`platform_avg` — a genuinely different weighting scheme, #1110, mixing it into this field
   *  would misrepresent the archive) and for any service with no uptime source at all.
   *
   *  Folded into the `daily:{date}` KV counter (index.ts `cacheWrite`) every cycle — the SAME write
   *  as `officialUptime`, so this durably archives one weighted-seconds figure per service per day
   *  via `history:{date}` (90d) with +0 new KV writes. That durable record is what lets the calendar
   *  survive a provider status-page migration (`uptimeWindowDays` below drops when the LIVE page's
   *  history resets) — the archive keeps what the live page has since forgotten. */
  todayWeightedOutageSec?: number
  /** Where `uptime30d` came from — the reader MUST know, because they are not the same kind of number.
   *  #713 — 'estimate' removed; no invented uptime.
   *  #1006 —
   *    'official'      → AIWatch's OWN computation over the trailing 30 days, from the provider's
   *                      published per-day / impact records, with the weights on /methodology. Atlassian,
   *                      incident.io, Instatus, OnlineOrNot and Flashduty — the five sources that carry
   *                      the PROVIDER's own records. (Better Stack is computed by us too, but from a
   *                      monitor rather than the provider, hence 'platform_avg' below.) Instatus's
   *                      Next.js path is itself an exception on the weights: a provider-published
   *                      `customImpactPercentage` wins over 1.0/0.3 (#1110).
   *    'platform_avg'  → an AIWatch computation over BetterStack's OWN monitoring history
   *                      (`status_history`) rather than the provider's incident declarations, averaged
   *                      across the page's resources. The label marks a DIFFERENT computation, not just
   *                      different evidence (#1110): `parseBetterStackUptime` ignores severity — every
   *                      measured `downtime_duration` second counts at weight 1.0, `downtime` and
   *                      `degraded` alike — and measures each resource only over the days it was
   *                      monitored (`not_monitored` days leave the denominator) before averaging, so one
   *                      page's figure can blend a 7-day monitor with 30-day ones. It emits no
   *                      `uptimeWindowDays`. Do not describe it as "the same window and weights as
   *                      'official'"; it is neither. */
  uptimeSource?: 'official' | 'platform_avg'
  /** #1006 — the % the PROVIDER displays on its own status page, when AIWatch's own 30-day figure differs
   *  from it (Atlassian: their ~90-day window; incident.io: their published aggregate). A disclosure, not
   *  the metric: #41 deliberately reproduced the provider's number, so the detail page shows it beside
   *  ours instead of dropping it. Absent when the two agree, or when there is nothing to compare. */
  uptimeReported?: number
  /** #1006 — the period `uptimeReported` covers, when we know it (Atlassian: the ~90 days its page
   *  embeds and shows a desktop visitor). Absent for incident.io, whose pages publish an aggregate
   *  without stating its window. */
  uptimeReportedDays?: number
  /** #1006 — days the uptime figure actually covers, when the provider's records don't reach back the
   *  full 30 (a status-page migration creates a NEW component and resets its clock — #1004). ABSENT
   *  when the window is whole, which is the normal case. The UI states the real window rather than
   *  passing a short one off as a 30-day figure. */
  uptimeWindowDays?: number
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
  /** #1004 — set when a fetch-failure `degraded` is CORROBORATED by our own probe (the service is
   *  probed, and the probe is not healthy). The UI neutralises an unreadable-source `degraded` into an
   *  "unknown" badge; this flag says "don't — independent evidence backs this outage", so it stays
   *  amber. Distinct from `probeConfirmed` (which is about `sourceDead` + a HEALTHY probe). Set by the
   *  cross-validation in `fetchAllServices`. */
  probeContradicted?: boolean
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
  // AIWatch service but siblings' component incidents leak (Junie on the shared JetBrains page: a
  // Grazie-only incident must NOT attribute to Junie). When set, filterIncidents keeps an incident
  // only if its `componentNames` contains an EXACT (case-insensitive) match — NOT substring, so
  // 'AI Platform' can't collide with the sibling 'AI Platform China'. Takes precedence over
  // incidentKeywords; an untagged incident (no componentNames) matches nothing and is dropped.
  incidentComponents?: string[]
  incidentIoBaseUrl?: string
  // #1066 — this apiUrl is an incident.io "global"/multi-region page whose Atlassian v2 compat API
  // returns `components: []` (the live data is only in the page-root RSC). When set, fetchService
  // reconstructs the summary.json shape (components + indicator + incidents) from that HTML via
  // parseIncidentIoGlobalPage, so the rest of the pipeline runs unchanged. Requires statusUrl to point
  // at the RSC page (apiUrl's baseUrl minus /api/v2).
  incidentIoGlobalPage?: boolean
  statusComponent?: string
  statusComponentId?: string
  // #934/#1090 — opt-in: on a SHARED status page, an EXCLUDE-ONLY service (no positive
  // incidentKeywords/incidentComponents) keeps an incident in filterByComponentStatus only if the
  // incident named a component in THIS service's badge group. Prevents a sibling-component-only
  // incident (e.g. a Claude-Code-only "GitHub failures" incident, componentNames: ['Claude Code'])
  // from cross-attributing to Claude API. Set on `claude` ONLY — single-tenant services
  // (mistral/perplexity/fal) have no sibling to leak from and a broad statusComponent ('API') would
  // wrongly drop a specific-component incident; keyword-scoped siblings (claudeai/claudecode) already
  // scope upstream and could drop 'across surfaces' incidents. Off by default.
  //
  // #934 named this `scopeResolvedToComponent` and applied it to resolved/monitoring incidents only,
  // because it lived inside filterByComponentStatus's `componentStatus === 'operational'` gate. So
  // WHILE OUR COMPONENT WAS OPERATIONAL, active incidents were covered by the #970 branch and
  // resolved/monitoring ones by this flag — and once our own component was degraded the early return
  // skipped both. #1090 hoisted it above that gate; it is no longer resolved-only, hence the rename.
  scopeIncidentsToComponent?: boolean
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
  // #1177 — Instatus ONLY (read inside fetchService's `instatusUrl` branch; silently inert on an
  // Atlassian / incident.io / BetterStack service, so setting it there does nothing). This card
  // represents EVERY component it displays, not just `statusComponent`: uptime is computed over the
  // whole `displayComponentIds` set, worst-of — the same aggregation the Nuxt GROUP path already
  // applies to its members.
  //
  // Set it TOGETHER WITH dropping `incidentKeywords`, because the two express ONE decision and split
  // apart they re-create the bug this fixes (the full case is in
  // docs/reference/status-determination.md, "When the card displays a component, that component is the
  // service"). Wide incidents + narrow uptime leaves "1 incident listed, uptime 100%"; narrow incidents
  // + wide uptime is the same contradiction reversed. `perplexity-scope.test.ts` sweeps SERVICES so the
  // pair cannot drift apart in-repo.
  //
  // Dropping `incidentKeywords` also widens the BADGE, which is the most user-visible half: on this
  // branch the Instatus badge is `hasOngoing ? 'degraded' : httpStatus` over the post-filter list, so
  // an ongoing incident on ANY displayed component now degrades the card (and with it the Discord
  // alert, the RSS entry and the /is-*-down answer).
  //
  // Off by default: a service whose card is deliberately an API-surface view (fal, mistral) keeps its
  // keyword scoping and its single-component uptime, and must NOT be swept along by this flag.
  uptimeOverDisplayComponents?: boolean
  // Per-component-id → group label, mirroring the OFFICIAL status page's component groups
  // (the v2 summary/components JSON does NOT expose group membership, so it must be curated
  // here). Applied in the explicit-id breakdown path (displayComponentIds, or the statusComponentIds
  // fallback): a matched component whose id is
  // present is tagged `group: <label>` so the UI collapses same-label components under one
  // header (worst-of status shown on the collapsed header), exactly like the dynamic
  // `MODEL_GROUP` path. Ids absent from this map render as individual top-level surface rows.
  // e.g. replicate: the 5 "Inference and Training" GPU/CPU hardware ids → 'Inference and Training'.
  componentGroups?: Record<string, string>
  // When true, the breakdown renders its sections (group blocks + surface-run grids) in component-ARRAY
  // order (groups interleaved among surfaces where the displayComponentIds array places them), for
  // services whose curated array defines the official-page layout (replicate). Default (absent) =
  // surfaces-grid-first-then-groups, matching cohere/groq/bfl where surface rows lead + 'Models' trails.
  componentGroupsInline?: boolean
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
  // exposes more components in components.json than summary.json. NOT display-only: the resolved list is what
  // the badge worst-of resolves `statusComponentIds` against, so a service whose ids the summary.json
  // window serves only in part badges on a subset without it (#1175) —
  // `grep breakdownComponents worker/src/services.ts` for the full consumer set. Falls back to
  // summary.json on fetch error.
  componentsUrl?: string
  // A list is a worst-of (min) across the components — for a page whose only components are
  // per-region endpoints and which publishes no group aggregate (turbopuffer, #857). Unlike
  // `statusComponentId`/`statusComponentIds` (two fields because they carry two DIFFERENT roles —
  // calendar/miss anchor vs badge group), this field has a single role (which components to read
  // uptime from), so the list form generalizes it rather than needing a sibling field.
  // The tuple forbids `[]`, which would be silently truthy: it passes the `needsHtml` gate, runs the
  // parser over zero ids, and yields null — reinstating the exact silent uptime drop #857 fixed.
  incidentIoComponentId?: string | [string, ...string[]]
  /** #367 → #1006 — the incident.io GROUP aggregate id (e.g. OpenAI's "APIs" group). Its role changed:
   *  it no longer feeds `uptime30d` (that is computed from component_impacts over a common 30 days now).
   *  It identifies the number the page actually DISPLAYS for this service — status.openai.com shows the
   *  group figure (APIs 99.97%), not the member component's (API 100.00%) — so `uptimeReported` reads it
   *  and the detail page can put the provider's own number beside ours. Omit when the page has no group. */
  incidentIoGroupId?: string
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
  // #983 — EXACT-match patterns for this provider's machine-emitted incident titles. A matching
  // incident gets `Incident.autoMonitor = true` (see tagAutoMonitorIncidents in services.ts), which
  // makes it hold-eligible + flap-suppressible REGARDLESS of `impact`, and groupable in the UI.
  // Needed for a page whose auto-monitor opens a brand-new incident per blip under one fixed title
  // (Twelve Labs: "Some API features are experiencing issues" ×4 on 2026-07-09, 5–16m each, 3 of
  // them `impact: 'major'` purely because one sub-component read `major_outage`).
  // Anchor every pattern (`^…$`): a substring match would swallow the provider's real, human-written
  // incidents, which use distinct titles ("Search API failure", "API server failure"). `critical` is
  // never held/suppressed even when tagged, so a genuine broad outage always alerts immediately.
  autoMonitorTitles?: RegExp[]
  // #989 — rewrite a non-English incident title to English. Moonshot's status page is Atlassian with
  // rich data, but every incident title is Chinese; `sanitize()` passes non-ASCII through untouched, so
  // without this the title would land verbatim on the dashboard, RSS, Discord, and the AI prompt (the
  // only non-English source among all services). Case/whitespace-insensitive match (via
  // `normalizeTitleKey`, aligned to the `autoMonitorTitles` regexes so every tagged variant translates);
  // an unmapped title passes through unchanged (never dropped — the provider's auto-monitor emits
  // inconsistent casing/spacing, so a new variant must degrade to the original). Applied by `applyTitleMap` at the
  // OUTPUT of the incident pipeline (after filterIncidents / includeUntaggedIncidents /
  // filterByComponentStatus), so every filter above still matches the ORIGINAL title. Deterministic, so
  // `flapSuppressionKey` stays stable. A static map beats a translation call here: the page emits a
  // handful of fixed titles, so this is zero-latency, no LLM round-trip, and offline-testable.
  titleMap?: Record<string, string>
  // #591 — mark a service whose status page migrated to a server-side-unreachable platform, so
  // the feed AIWatch reads is FROZEN (e.g. DeepSeek → Flashduty, #507). Propagated to
  // ServiceStatus.incidentSourceStale → all ranking surfaces exclude it (a frozen empty 30-day
  // incident window would otherwise inflate the Score). REMOVE once the feed is reachable again.
  incidentSourceStale?: boolean
  // #800 — the status page is a KNOWN, acknowledged, long-running DEACTIVATION (e.g. Character.AI's
  // Statuspage went "Page Inactive"/401 ~2026-06-18 with no replacement, #689). The runtime sourceDead
  // path still shows the service operational+stale + excluded from rankings; this flag only SUPPRESSES
  // the recurring operator alerts the operator has already acknowledged: the #500 persistent-failure
  // (daily) sweep skips it, and the #689 source-dead RISING-edge "Inactive" (weekly) is suppressed
  // (marker still written so a RECOVERY is still detected + notified). REMOVE when the page reactivates.
  statusSourceDeactivated?: boolean
  // #802 — ISO date (YYYY-MM-DD) AIWatch began monitoring this service. Used to derive
  // ServiceStatus.coverageDays (now − addedAt); a service with <30 days of coverage is held out of the
  // Reliability Ranking (thin observed window → inflated Score). ABSENT = an established service (added
  // well before the 30-day window) → treated as full coverage. Stamp on EVERY newly-added service (see
  // the adding-a-service checklist); old services are intentionally left absent.
  addedAt?: string
  // #618 — the service's live status comes from a browser-rendered Flashduty feed pushed to KV by
  // the deepseek-feed GitHub Action (status.deepseek.com is bot-walled to a plain Worker fetch).
  // When set, fetchService reads DEEPSEEK_FEED_KV_KEY first; a FRESH feed supersedes apiUrl and
  // clears incidentSourceStale, while a missing/expired feed falls through to apiUrl (the frozen
  // Atlassian mirror) keeping incidentSourceStale. Pairs with incidentSourceStale (the fallback).
  flashdutyFeed?: boolean
  // #618 option A — scope the Flashduty feed to a component id, or a SET of ids (worst-of — #1171,
  // when the provider's status page splits one surface into several components, e.g. DeepSeek's V4
  // reorg turning one "API Service" into "V4 Pro API" + "V4 Flash API"), excluding sibling
  // consumer-app components (e.g. DeepSeek's Web Chat) from the badge/incidents/uptime/score — the
  // same api-vs-app split as OpenAI API (incidentExclude:['chatgpt']). Absent → whole feed. The tuple
  // (mirroring incidentIoComponentId below) forbids `[]`, which would be silently truthy: it would run
  // the parser over zero ids and reinstate the exact silent uptime drop #1171 fixed. Unrelated to
  // `statusComponentIds` above — that's the Statuspage.io-API path; this only applies when
  // `flashdutyFeed: true` (the browser-scraped-feed path, currently DeepSeek only).
  flashdutyPrimaryComponentId?: string | [string, ...string[]]
}

export interface ProbeSummary {
  p50: number
  p95: number
  cvCombined: number
  validDays: number // how many days contributed to this summary
}

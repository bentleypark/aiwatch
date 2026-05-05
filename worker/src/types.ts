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
  dailyImpact?: Record<string, DailyImpactLevel>
  calendarDays?: number
  uptimeSource?: 'official' | 'platform_avg' | 'estimate'
  detectedAt?: string
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
  incidentIoComponentId?: string
  incidentIoGroupId?: string       // incident.io group uptime (e.g. "APIs" aggregate)
  betterStackUrl?: string
  onlineOrNotUrl?: string
  onlineOrNotComponent?: string
  awsRssUrls?: string[]
  azureRssUrl?: string
  // BetterStack RSS emits "<model> — recovered" per auto-recovery blip; a single day can
  // produce 10-20 alerts per affected model. Opt-in suppression dedups by normalized title
  // in a 60-minute window. See #283 and isFlapSuppressible() in alerts.ts.
  flapSuppression?: boolean
}

export interface ProbeSummary {
  p50: number
  p95: number
  cvCombined: number
  validDays: number // how many days contributed to this summary
}

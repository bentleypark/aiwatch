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
  probeSummary?: ProbeSummary
}

export interface ProbeSummary {
  p50: number      // average daily p50 RTT (ms) over 7 days
  p95: number      // average daily p95 RTT (ms) over 7 days
  cvCombined: number // 0.3 × day-to-day CV + 0.7 × (p95-p50)/p50 spread
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
  rssFeedUrl?: string
  incidentKeywords?: string[]
  incidentExclude?: string[]
  incidentIoBaseUrl?: string
  statusComponent?: string
  statusComponentId?: string
  incidentIoComponentId?: string
  incidentIoGroupId?: string       // incident.io group uptime (e.g. "APIs" aggregate)
  betterStackUrl?: string
  onlineOrNotUrl?: string
  onlineOrNotComponent?: string
  awsRssUrls?: string[]
  azureRssUrl?: string
}

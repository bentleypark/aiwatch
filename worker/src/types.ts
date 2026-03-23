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
  duration: string | null
  timeline: TimelineEntry[]
}

export interface ServiceStatus {
  id: string
  name: string
  provider: string
  category: 'api' | 'webapp' | 'agent'
  status: 'operational' | 'degraded' | 'down'
  latency: number | null
  uptime30d: number | null
  lastChecked: string
  incidents: Incident[]
  dailyImpact?: Record<string, DailyImpactLevel>
  calendarDays?: number
  uptimeSource?: 'official' | 'platform_avg' | 'estimate'
}

export type DailyImpactLevel = 'minor' | 'major' | 'critical'

export interface ServiceConfig {
  id: string
  name: string
  provider: string
  category: 'api' | 'webapp' | 'agent'
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
  betterStackUrl?: string
  onlineOrNotUrl?: string
  onlineOrNotComponent?: string
}

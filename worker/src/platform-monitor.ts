// Platform Monitor — proactive monitoring of status page platform health
// Checks metastatuspage.com (Atlassian Statuspage's own status page) to detect
// platform-wide outages before individual service fetch failures accumulate.

import { type StatuspageResponse, normalizeStatus } from './parsers/statuspage'
import { fetchWithTimeout } from './utils'

export interface PlatformStatus {
  platform: string
  status: 'operational' | 'degraded' | 'down'
  components: Record<string, string> // component name → status
  checkedAt: string
  incident?: string // active incident title, if any
}

// Key components that affect AIWatch-monitored services
const ATLASSIAN_KEY_COMPONENTS = ['Hosted Pages', 'HTTPS Pages', 'Public API']

const PLATFORM_CONFIGS = [
  {
    id: 'atlassian',
    name: 'Atlassian Statuspage',
    apiUrl: 'https://metastatuspage.com/api/v2/summary.json',
    keyComponents: ATLASSIAN_KEY_COMPONENTS,
  },
] as const

export type PlatformId = typeof PLATFORM_CONFIGS[number]['id']

/** Fetch and parse platform status from metastatuspage.
 *  Returns null on fetch failure (conservative — don't assume platform is down). */
export async function checkPlatformStatus(platformId: PlatformId): Promise<PlatformStatus | null> {
  const config = PLATFORM_CONFIGS.find(p => p.id === platformId)
  if (!config) {
    console.error(`[platform-monitor] Unknown platform ID: ${platformId}`)
    return null
  }

  try {
    const res = await fetchWithTimeout(config.apiUrl, 5000)
    if (!res.ok) {
      console.warn(`[platform-monitor] ${config.name} returned HTTP ${res.status}`)
      res.body?.cancel()
      return null
    }

    let data: StatuspageResponse
    try {
      data = await res.json()
    } catch (parseErr) {
      console.warn(`[platform-monitor] ${config.name} returned invalid JSON (HTTP ${res.status}, Content-Type: ${res.headers.get('content-type')})`)
      return null
    }

    const components: Record<string, string> = {}
    let worstStatus: 'operational' | 'degraded' | 'down' = 'operational'

    for (const comp of data.components ?? []) {
      if (config.keyComponents.includes(comp.name)) {
        const normalized = normalizeStatus(comp.status)
        components[comp.name] = normalized
        if (normalized === 'down') worstStatus = 'down'
        else if (normalized === 'degraded' && worstStatus !== 'down') worstStatus = 'degraded'
      }
    }

    if (Object.keys(components).length === 0) {
      console.warn(`[platform-monitor] ${config.name}: no key components found — API format may have changed`)
    }

    // Check for active incidents
    const activeIncident = (data.incidents ?? []).find(
      i => i.status !== 'resolved' && i.status !== 'postmortem',
    )

    return {
      platform: config.name,
      status: worstStatus,
      components,
      checkedAt: new Date().toISOString(),
      incident: activeIncident?.name,
    }
  } catch (err) {
    console.warn(`[platform-monitor] ${config.name} check failed:`, err instanceof Error ? err.message : err)
    return null
  }
}

/** Format Discord embed for platform outage alert */
export function formatPlatformOutageAlert(
  status: PlatformStatus,
  affectedCount: number,
  totalCount: number,
): { title: string; description: string; color: number } {
  const statusEmoji = status.status === 'down' ? '🔴' : '🟡'
  const compLines = Object.entries(status.components)
    .map(([name, s]) => {
      const emoji = s === 'operational' ? '🟢' : s === 'degraded' ? '🟡' : '🔴'
      return `${emoji} ${name}: ${s}`
    })
    .join('\n')

  const lines = [
    `Source: \`metastatuspage.com\``,
    compLines,
  ]
  if (status.incident) {
    lines.push(`\n📋 **Active Incident**: ${status.incident}`)
  }
  lines.push(`\n${affectedCount}/${totalCount} AIWatch services on this platform — holding previous status`)

  return {
    title: `${statusEmoji} Status Page Platform Outage — ${status.platform}`,
    description: lines.join('\n'),
    color: status.status === 'down' ? 0xED4245 : 0xF0B232,
  }
}

/** Format Discord embed for platform recovery alert */
export function formatPlatformRecoveryAlert(
  platform: string,
  affectedCount: number,
): { title: string; description: string; color: number } {
  return {
    title: `🟢 Status Page Platform Recovered — ${platform}`,
    description: `Source: \`metastatuspage.com\` reports all key components operational\n${affectedCount} AIWatch services returning to live status`,
    color: 0x57F287,
  }
}

/** Get the KV key for platform status cache */
export function platformStatusKey(platformId: string): string {
  return `platform:status:${platformId}`
}

/** Get the KV key for platform alert dedup */
export function platformAlertKey(platformId: string): string {
  return `alerted:platform:${platformId}`
}

/** Count services on a given platform */
export function countPlatformServices(
  configs: Array<{ apiUrl: string | null }>,
  platformId: PlatformId,
): number {
  if (platformId === 'atlassian') {
    return configs.filter(c => c.apiUrl?.includes('/api/v2/summary.json')).length
  }
  return 0
}

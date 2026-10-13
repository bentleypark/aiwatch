// #1686 — the status of the platforms AIWatch itself runs on, for the operator channel only.
// Distinct from platform-monitor.ts, which watches the status-page platform our DATA comes from.
// Components are pinned by id; names are only for display.

import { normalizeStatus } from './parsers/statuspage'
import { fetchWithTimeout, kvPut } from './utils'

export type InfraPlatformId = 'cloudflare' | 'vercel' | 'github'

export const INFRA_PLATFORMS: ReadonlyArray<{
  id: InfraPlatformId
  name: string
  summaryUrl: string
  components: Readonly<Record<string, string>>
}> = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    summaryUrl: 'https://www.cloudflarestatus.com/api/v2/summary.json',
    components: {
      '57srcl8zcn7c': 'Workers',
      tmh50tx2nprs: 'Workers KV',
      zvm7mqn92xzc: 'Workers AI',
      '0311l882p558': 'AI Gateway',
      gjb0yzvvrpf6: 'Email Routing',
      '4n0gb0kh02gf': 'Network',
      v4s7np92f0dh: 'Seoul (ICN)',
    },
  },
  {
    id: 'vercel',
    name: 'Vercel',
    summaryUrl: 'https://www.vercel-status.com/api/v2/summary.json',
    components: {
      '7ckq6xr6nsbv': 'Builds',
      hpqj1ys9gr78: 'Git Integrations',
      kgcsn9c73xzf: 'Functions',
      '4byczsw70cgb': 'DNS',
      tlk2qz3jz4rf: 'Seoul (ICN1)',
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    summaryUrl: 'https://www.githubstatus.com/api/v2/summary.json',
    components: {
      '8l4ygp009s5s': 'Git Operations',
      br0l2tvcx85d: 'Actions',
      '4230lsnqdsld': 'Webhooks',
      brv1bkgrwx7q: 'API Requests',
    },
  },
]

export interface InfraPlatformStatus {
  id: InfraPlatformId
  name: string
  status: 'operational' | 'degraded' | 'down'
  /** Tracked components that are not operational. */
  affected: Array<{ name: string; status: 'degraded' | 'down' }>
  /** Unresolved incidents that name a tracked component. */
  incidents: string[]
  /** Tracked ids the page no longer publishes — a removed or re-keyed component. */
  missing: string[]
}

interface SummaryJson {
  components?: Array<{ id?: string; status?: string }>
  incidents?: Array<{ name?: string; status?: string; components?: Array<{ id?: string }> }>
}

export function parseInfraSummary(platform: (typeof INFRA_PLATFORMS)[number], json: unknown): InfraPlatformStatus | null {
  const data = json as SummaryJson
  if (!data || !Array.isArray(data.components)) return null
  const byId = new Map(data.components.filter((c) => typeof c.id === 'string').map((c) => [c.id as string, c]))
  const affected: InfraPlatformStatus['affected'] = []
  const missing: string[] = []
  for (const [id, name] of Object.entries(platform.components)) {
    const comp = byId.get(id)
    if (!comp) { missing.push(id); continue }
    const s = normalizeStatus(comp.status ?? '')
    if (s === 'degraded' || s === 'down') affected.push({ name, status: s })
  }
  const tracked = new Set(Object.keys(platform.components))
  const incidents = (data.incidents ?? [])
    .filter((i) => i.status !== 'resolved' && i.status !== 'postmortem')
    .filter((i) => (i.components ?? []).some((c) => typeof c.id === 'string' && tracked.has(c.id)))
    .map((i) => i.name ?? '(untitled incident)')
  const status = affected.some((a) => a.status === 'down') ? 'down' : affected.length > 0 ? 'degraded' : 'operational'
  return { id: platform.id, name: platform.name, status, affected, incidents, missing }
}

/** One cycle's read of every platform. A platform whose page cannot be read is left out, never
 *  reported as operational. */
export async function checkInfraStatus(fetchImpl: typeof fetchWithTimeout = fetchWithTimeout): Promise<InfraPlatformStatus[]> {
  const results = await Promise.all(INFRA_PLATFORMS.map(async (platform) => {
    try {
      const res = await fetchImpl(platform.summaryUrl, 5000)
      if (!res.ok) {
        res.body?.cancel()
        console.warn(`[infra-status] ${platform.name} returned HTTP ${res.status}`)
        return null
      }
      const parsed = parseInfraSummary(platform, await res.json())
      if (!parsed) console.warn(`[infra-status] ${platform.name} summary has no components array`)
      else if (parsed.missing.length > 0) console.warn(`[infra-status] ${platform.name} no longer publishes tracked component(s): ${parsed.missing.join(', ')}`)
      return parsed
    } catch (err) {
      console.warn(`[infra-status] ${platform.name} check failed:`, err instanceof Error ? err.message : err)
      return null
    }
  }))
  return results.filter((r): r is InfraPlatformStatus => r !== null)
}

export const INFRA_STATUS_KEY = 'infra:status'
export const infraAlertKey = (id: InfraPlatformId): string => `alerted:infra:${id}`

/** One line per platform, for the operator embed and as context on a real-user latency alert. */
export function formatInfraLine(s: InfraPlatformStatus): string {
  const emoji = s.status === 'down' ? '🔴' : s.status === 'degraded' ? '🟡' : '🟢'
  const parts = s.affected.map((a) => `${a.name} ${a.status}`)
  const incident = s.incidents.length > 0 ? ` — ${s.incidents.join('; ')}` : ''
  return `${emoji} **${s.name}**${parts.length > 0 ? `: ${parts.join(', ')}` : ''}${incident}`
}

export function formatInfraAlert(s: InfraPlatformStatus): { title: string; description: string; color: number } {
  return {
    title: `${s.status === 'down' ? '🔴' : '🟡'} AIWatch infrastructure — ${s.name} ${s.status}`,
    description: formatInfraLine(s),
    color: s.status === 'down' ? 0xED4245 : 0xF0B232,
  }
}

export function formatInfraRecovery(name: string): { title: string; description: string; color: number } {
  return {
    title: `🟢 AIWatch infrastructure — ${name} recovered`,
    description: `Every tracked ${name} component is operational again.`,
    color: 0x57F287,
  }
}

type Embed = { title: string; description: string; color: number }

export const ALERT_TTL_S = 7200

/** One cron cycle: publish the statuses for the latency alert to read (only while one is affected;
 *  the 15-minute TTL clears it after a recovery), then alert on a platform
 *  turning non-operational and on its recovery: at most one alert and one recovery per platform
 *  per ALERT_TTL_S hold. */
export async function runInfraStatusCycle(
  kv: KVNamespace,
  send: (embed: Embed) => Promise<boolean>,
  statuses: InfraPlatformStatus[],
): Promise<void> {
  if (statuses.some((s) => s.status !== 'operational')) {
    await kvPut(kv, INFRA_STATUS_KEY, JSON.stringify(statuses), { expirationTtl: 900 })
  }
  for (const s of statuses) {
    const key = infraAlertKey(s.id)
    const state = await kv.get(key).catch(() => null)
    if (s.status !== 'operational' && !state) {
      if (await send(formatInfraAlert(s))) await kvPut(kv, key, 'affected', { expirationTtl: ALERT_TTL_S })
    } else if (s.status === 'operational' && state === 'affected') {
      if (await send(formatInfraRecovery(s.name))) await kvPut(kv, key, 'recovered', { expirationTtl: ALERT_TTL_S })
    }
  }
}

/** Non-operational platforms from the last cycle, as lines for another alert. */
export async function readInfraContext(kv: KVNamespace): Promise<string[]> {
  try {
    const raw = await kv.get(INFRA_STATUS_KEY)
    if (!raw) return []
    const statuses = JSON.parse(raw) as InfraPlatformStatus[]
    return Array.isArray(statuses) ? statuses.filter((s) => s.status !== 'operational').map(formatInfraLine) : []
  } catch {
    return []
  }
}

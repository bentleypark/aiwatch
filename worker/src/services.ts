// Service status fetching and parsing for all monitored AI services.
// Most status pages use Atlassian Statuspage (status.io) or similar APIs.

export interface TimelineEntry {
  stage: 'investigating' | 'identified' | 'monitoring' | 'resolved'
  text: string | null
  at: string
}

export interface Incident {
  id: string
  title: string
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
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
}

// ── Status Page Configs ──

interface ServiceConfig {
  id: string
  name: string
  provider: string
  category: 'api' | 'webapp' | 'agent'
  statusUrl: string
  apiUrl: string | null  // Atlassian Statuspage API endpoint if available
  instatusUrl?: string   // Instatus (Nuxt SSR) incidents page URL
  gcloudProduct?: string // Google Cloud product name filter for incidents.json
}

const SERVICES: ServiceConfig[] = [
  // AI API Services
  { id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json' },
  { id: 'openai', name: 'OpenAI API', provider: 'OpenAI', category: 'api', statusUrl: 'https://status.openai.com', apiUrl: 'https://status.openai.com/api/v2/summary.json' },
  { id: 'gemini', name: 'Gemini API', provider: 'Google', category: 'api', statusUrl: 'https://status.cloud.google.com', apiUrl: null, gcloudProduct: 'Vertex Gemini API' },
  { id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', category: 'api', statusUrl: 'https://status.mistral.ai', apiUrl: null, instatusUrl: 'https://status.mistral.ai/incidents/page/1' },
  { id: 'cohere', name: 'Cohere API', provider: 'Cohere', category: 'api', statusUrl: 'https://status.cohere.com', apiUrl: 'https://status.cohere.com/api/v2/summary.json' },
  { id: 'groq', name: 'Groq Cloud', provider: 'Groq', category: 'api', statusUrl: 'https://groqstatus.com', apiUrl: 'https://groqstatus.com/api/v2/summary.json' },
  { id: 'together', name: 'Together AI', provider: 'Together', category: 'api', statusUrl: 'https://status.together.ai', apiUrl: null },
  { id: 'perplexity', name: 'Perplexity', provider: 'Perplexity AI', category: 'api', statusUrl: 'https://status.perplexity.com', apiUrl: null },
  { id: 'huggingface', name: 'Hugging Face', provider: 'Hugging Face', category: 'api', statusUrl: 'https://status.huggingface.co', apiUrl: null },
  { id: 'replicate', name: 'Replicate', provider: 'Replicate', category: 'api', statusUrl: 'https://www.replicatestatus.com', apiUrl: 'https://www.replicatestatus.com/api/v2/summary.json' },
  { id: 'elevenlabs', name: 'ElevenLabs', provider: 'ElevenLabs', category: 'api', statusUrl: 'https://status.elevenlabs.io', apiUrl: 'https://status.elevenlabs.io/api/v2/summary.json' },
  { id: 'xai', name: 'xAI (Grok)', provider: 'xAI', category: 'api', statusUrl: 'https://status.x.ai', apiUrl: null },
  { id: 'deepseek', name: 'DeepSeek API', provider: 'DeepSeek', category: 'api', statusUrl: 'https://status.deepseek.com', apiUrl: 'https://status.deepseek.com/api/v2/summary.json' },
  // AI Web Apps
  { id: 'claudeai', name: 'claude.ai', provider: 'Anthropic', category: 'webapp', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json' },
  { id: 'chatgpt', name: 'ChatGPT', provider: 'OpenAI', category: 'webapp', statusUrl: 'https://status.openai.com', apiUrl: 'https://status.openai.com/api/v2/summary.json' },
  // Coding Agents
  { id: 'claudecode', name: 'Claude Code', provider: 'Anthropic', category: 'agent', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json' },
  { id: 'copilot', name: 'GitHub Copilot', provider: 'Microsoft', category: 'agent', statusUrl: 'https://githubstatus.com', apiUrl: 'https://www.githubstatus.com/api/v2/summary.json' },
  { id: 'cursor', name: 'Cursor', provider: 'Anysphere', category: 'agent', statusUrl: 'https://status.cursor.com', apiUrl: 'https://status.cursor.com/api/v2/summary.json' },
  { id: 'windsurf', name: 'Windsurf', provider: 'Codeium', category: 'agent', statusUrl: 'https://status.windsurf.com', apiUrl: 'https://status.windsurf.com/api/v2/summary.json' },
]

// ── Statuspage API Parser (Atlassian format) ──

interface StatuspageResponse {
  status: { indicator: string; description: string }
  components?: Array<{ name: string; status: string }>
  incidents?: Array<{
    id: string
    name: string
    status: string
    created_at: string
    resolved_at: string | null
    incident_updates?: Array<{ status: string; body: string; created_at: string }>
  }>
}

function normalizeStatus(indicator: string): 'operational' | 'degraded' | 'down' {
  switch (indicator) {
    case 'none':
    case 'operational':
      return 'operational'
    case 'minor':
    case 'degraded_performance':
    case 'partial_outage':
      return 'degraded'
    case 'major':
    case 'critical':
    case 'major_outage':
      return 'down'
    default:
      return 'operational'
  }
}

function parseIncidents(data: StatuspageResponse): Incident[] {
  return (data.incidents ?? []).slice(0, 5).map((inc) => {
    const duration = inc.resolved_at
      ? formatDuration(new Date(inc.created_at), new Date(inc.resolved_at))
      : null
    const timeline: TimelineEntry[] = (inc.incident_updates ?? [])
      .map((u) => ({
        stage: u.status === 'resolved' ? 'resolved' as const
          : u.status === 'monitoring' ? 'monitoring' as const
          : u.status === 'identified' ? 'identified' as const
          : 'investigating' as const,
        text: u.body || null,
        at: u.created_at,
      }))
      .reverse() // oldest first

    return {
      id: inc.id,
      title: inc.name,
      status: inc.status === 'resolved' ? 'resolved'
        : inc.status === 'monitoring' ? 'monitoring'
        : inc.status === 'identified' ? 'identified'
        : 'investigating',
      startedAt: inc.created_at,
      duration,
      timeline,
    }
  })
}

// ── Google Cloud Status Parser — incidents.json with product filtering ──

interface GCloudIncident {
  id: string
  service_name: string
  severity: string
  begin: string
  end: string | null
  affected_products?: Array<{ title: string; id: string }>
  most_recent_update?: { status: string; text: string }
  updates?: Array<{ status: string; when: string; text: string }>
}

function parseGCloudIncidents(data: GCloudIncident[], productFilter: string): Incident[] {
  return data
    .filter((inc) =>
      inc.affected_products?.some((p) => p.title === productFilter) ||
      inc.service_name?.toLowerCase().includes(productFilter.toLowerCase())
    )
    .slice(0, 5)
    .flatMap((inc) => {
      try {
        const duration = inc.end
          ? formatDuration(new Date(inc.begin), new Date(inc.end))
          : null
        const status = inc.most_recent_update?.status
        const timeline: TimelineEntry[] = (inc.updates ?? [])
          .map((u) => ({
            stage: u.status === 'AVAILABLE' ? 'resolved' as const
              : u.status === 'SERVICE_DISRUPTION' ? 'investigating' as const
              : u.status === 'SERVICE_INFORMATION' ? 'identified' as const
              : 'investigating' as const,
            text: u.text?.replace(/^#.*\n/gm, '').replace(/\*\*/g, '').trim().substring(0, 200) || null,
            at: u.when,
          }))
          .reverse()

        return [{
          id: inc.id,
          title: `${inc.service_name} — ${inc.severity}`,
          status: status === 'AVAILABLE' ? 'resolved' as const
            : status === 'SERVICE_DISRUPTION' ? 'investigating' as const
            : 'investigating' as const,
          startedAt: inc.begin,
          duration,
          timeline,
        }]
      } catch { return [] }
    })
}

// ── Instatus (Nuxt SSR) Parser — for status pages like Mistral ──

function parseInstatusIncidents(html: string): Incident[] {
  // Extract Nuxt SSR payload — match everything between the script tags, let JSON.parse validate
  const match = html.match(/__NUXT_DATA__[^>]*>([\s\S]*?)<\/script/)
  if (!match) return []
  try {
    const arr: unknown[] = JSON.parse(match[1])

    // Find the data refs object containing an 'incidents-by-date' key (avoid hardcoded index)
    const dataRefs = arr.find(
      (item): item is Record<string, number> =>
        typeof item === 'object' && item !== null && !Array.isArray(item) &&
        Object.keys(item).some((k) => k.startsWith('incidents-by-date'))
    )
    if (!dataRefs) return []
    const incKey = Object.keys(dataRefs).find((k) => k.startsWith('incidents-by-date'))!
    const incObj = arr[dataRefs[incKey]] as { incidents?: number } | undefined
    if (!incObj?.incidents) return []
    const incIndices = arr[incObj.incidents] as number[]
    if (!Array.isArray(incIndices)) return []

    // Parse each incident with per-item error isolation
    return incIndices.slice(0, 5).flatMap((idx) => {
      try {
        const inc = arr[idx] as Record<string, number>
        if (!inc || typeof inc !== 'object') return []
        const name = arr[inc.name] as string
        const status = (arr[inc.lastUpdateStatus] as string) ?? ''
        const createdAt = arr[inc.created_at] as string
        const durationSec = arr[inc.duration] as number | null

        // Parse incident updates
        const updatesArr = arr[inc.incidentUpdates] as number[] | undefined
        const timeline: TimelineEntry[] = (updatesArr ?? []).flatMap((ui) => {
          try {
            const u = arr[ui] as Record<string, number>
            if (!u || typeof u !== 'object') return []
            const uStatus = (arr[u.status] as string) ?? ''
            return [{
              stage: uStatus === 'RESOLVED' ? 'resolved' as const
                : uStatus === 'MONITORING' ? 'monitoring' as const
                : uStatus === 'IDENTIFIED' ? 'identified' as const
                : 'investigating' as const,
              text: (arr[u.description] as string) || null,
              at: arr[u.created_at] as string,
            }]
          } catch { return [] }
        }).reverse()

        return [{
          id: arr[inc.id] as string,
          title: name,
          status: status === 'RESOLVED' ? 'resolved' as const
            : status === 'MONITORING' ? 'monitoring' as const
            : status === 'IDENTIFIED' ? 'identified' as const
            : 'investigating' as const,
          startedAt: createdAt,
          duration: durationSec ? formatDuration(new Date(createdAt), new Date(new Date(createdAt).getTime() + durationSec * 1000)) : null,
          timeline,
        }]
      } catch { return [] }
    })
  } catch {
    return []
  }
}

function formatDuration(start: Date, end: Date): string {
  const diffMs = end.getTime() - start.getTime()
  const hours = Math.floor(diffMs / 3_600_000)
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

// ── Fetch with Timeout ──

async function fetchWithTimeout(url: string, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

// Retry once on failure to reduce false-positive 'down' from transient network issues
// Retry uses shorter timeout to keep total budget under ~12s per service
async function fetchWithRetry(url: string, timeoutMs = 8000): Promise<Response> {
  try {
    return await fetchWithTimeout(url, timeoutMs)
  } catch (err) {
    console.warn(`[fetchWithRetry] first attempt failed for ${url}, retrying...`)
    await new Promise((r) => setTimeout(r, 1000))
    try {
      return await fetchWithTimeout(url, Math.min(timeoutMs, 3000))
    } catch (retryErr) {
      console.error(`[fetchWithRetry] retry also failed for ${url}`)
      throw retryErr
    }
  }
}

// ── Fetch Single Service ──
// NOTE: `latency` measures status page response time, not actual AI API latency.
// This is a known v1 limitation — real API latency measurement is planned for a future phase.
// For services without `apiUrl`, status is based on HTTP reachability of the status page (200 = operational).
// This may not reflect actual service outages if the status page itself remains up.

async function fetchService(config: ServiceConfig): Promise<ServiceStatus> {
  const now = new Date().toISOString()
  const base: ServiceStatus = {
    id: config.id,
    name: config.name,
    provider: config.provider,
    category: config.category,
    status: 'operational',
    latency: null,
    uptime30d: null,
    lastChecked: now,
    incidents: [],
  }

  try {
    if (config.apiUrl) {
      // Atlassian Statuspage API — fetch summary + recent incidents in parallel
      const baseUrl = config.apiUrl.replace('/summary.json', '')
      const start = Date.now()
      const [summaryRes, incidentsRes] = await Promise.all([
        fetchWithRetry(config.apiUrl),
        fetchWithRetry(`${baseUrl}/incidents.json`).catch((err) => { console.warn(`[fetchService] ${config.id} incidents.json failed:`, err.message); return null }),
      ])
      const latency = Date.now() - start

      if (!summaryRes.ok) return { ...base, status: 'degraded' }

      const summaryData: StatuspageResponse = await summaryRes.json()
      // incidents.json has full history; summary.json only has active ones
      let incidents: Incident[] = []
      if (incidentsRes?.ok) {
        const incData: StatuspageResponse = await incidentsRes.json()
        incidents = parseIncidents(incData)
      } else {
        incidents = parseIncidents(summaryData)
      }

      return {
        ...base,
        status: normalizeStatus(summaryData.status?.indicator ?? 'none'),
        latency: config.category === 'api' ? latency : null,
        incidents,
      }
    } else {
      // No Statuspage API — HTTP check + optional scraping (parallel)
      const start = Date.now()
      const scrapeUrl = config.instatusUrl || (config.gcloudProduct ? 'https://status.cloud.google.com/incidents.json' : null)
      const [res, scrapeRes] = await Promise.all([
        fetchWithRetry(config.statusUrl),
        scrapeUrl
          ? fetchWithRetry(scrapeUrl).catch((err) => {
              console.warn(`[fetchService] ${config.id} scrape failed:`, err.message)
              return null
            })
          : Promise.resolve(null),
      ])
      const latency = Date.now() - start

      let incidents: Incident[] = []
      if (scrapeRes?.ok) {
        if (config.instatusUrl) {
          incidents = parseInstatusIncidents(await scrapeRes.text())
        } else if (config.gcloudProduct) {
          const data: GCloudIncident[] = await scrapeRes.json()
          incidents = parseGCloudIncidents(data, config.gcloudProduct)
        }
      }

      return {
        ...base,
        status: res.ok ? 'operational' : 'degraded',
        latency: config.category === 'api' ? latency : null,
        incidents,
      }
    }
  } catch (err) {
    console.error(`[fetchService] ${config.id} failed:`, err)
    return { ...base, status: 'down' }
  }
}

// ── Fetch All Services (parallel) ──

export async function fetchAllServices(): Promise<ServiceStatus[]> {
  const results = await Promise.allSettled(
    SERVICES.map((config) => fetchService(config))
  )

  return results.map((result, i) => {
    if (result.status === 'fulfilled') return result.value
    // Fallback for rejected promises
    return {
      id: SERVICES[i].id,
      name: SERVICES[i].name,
      provider: SERVICES[i].provider,
      category: SERVICES[i].category,
      status: 'down' as const,
      latency: null,
      uptime30d: null,
      lastChecked: new Date().toISOString(),
      incidents: [],
    }
  })
}

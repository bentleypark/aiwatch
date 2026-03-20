// Service status fetching and parsing for all monitored AI services.
// Most status pages use Atlassian Statuspage (status.io) or similar APIs.

export interface Incident {
  id: string
  title: string
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
  startedAt: string
  duration: string | null
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
}

const SERVICES: ServiceConfig[] = [
  // AI API Services
  { id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json' },
  { id: 'openai', name: 'OpenAI API', provider: 'OpenAI', category: 'api', statusUrl: 'https://status.openai.com', apiUrl: 'https://status.openai.com/api/v2/summary.json' },
  { id: 'gemini', name: 'Gemini API', provider: 'Google', category: 'api', statusUrl: 'https://status.cloud.google.com', apiUrl: null },
  { id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', category: 'api', statusUrl: 'https://status.mistral.ai', apiUrl: 'https://status.mistral.ai/api/v2/summary.json' },
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
    incident_updates?: Array<{ status: string; created_at: string }>
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
    return {
      id: inc.id,
      title: inc.name,
      status: inc.status === 'resolved' ? 'resolved'
        : inc.status === 'monitoring' ? 'monitoring'
        : inc.status === 'identified' ? 'identified'
        : 'investigating',
      startedAt: inc.created_at,
      duration,
    }
  })
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
        fetchWithTimeout(config.apiUrl),
        fetchWithTimeout(`${baseUrl}/incidents.json`).catch(() => null),
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
      // No API — simple HTTP check
      const start = Date.now()
      const res = await fetchWithTimeout(config.statusUrl)
      const latency = Date.now() - start

      return {
        ...base,
        status: res.ok ? 'operational' : 'degraded',
        latency: config.category === 'api' ? latency : null,
      }
    }
  } catch {
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

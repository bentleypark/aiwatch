// Service status fetching and parsing for all monitored AI services.

import type { Incident, ServiceStatus, ServiceConfig, DailyImpactLevel } from './types'
export type { ServiceStatus } from './types'
import { fetchWithTimeout, trackFetchFailure, resetFetchFailure } from './utils'
import { type StatuspageResponse, normalizeStatus, parseIncidents, parseUptimeData } from './parsers/statuspage'
import { parseIncidentIoUptime, parseIncidentIoComponentImpacts, computeUptimeFromIncidents, enrichIncidentIoText } from './parsers/incident-io'
import { type GCloudIncident, parseGCloudIncidents } from './parsers/gcloud'
import { parseInstatusIncidents } from './parsers/instatus'
import { parseRssIncidents, parseXaiRssIncidents, type BetterStackIndex, parseBetterStackStatus, parseBetterStackUptime, parseBetterStackDailyImpact } from './parsers/betterstack'
import { parseOnlineOrNotIncidents, parseOnlineOrNotUptime } from './parsers/onlineornot'
import { parseAwsRssIncidents, deriveAwsStatus } from './parsers/aws'

const SERVICES: ServiceConfig[] = [
  // AI API Services
  { id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json', incidentExclude: ['claude.ai', 'claude code', 'claude desktop'], statusComponent: 'Claude API', statusComponentId: 'k8w3r06qmzrp' },
  { id: 'openai', name: 'OpenAI API', provider: 'OpenAI', category: 'api', statusUrl: 'https://status.openai.com', apiUrl: 'https://status.openai.com/api/v2/summary.json', incidentExclude: ['chatgpt', 'excel plugin', 'gpts', 'voice mode', 'deep research', 'pinned', 'sora', 'sign-in', 'conversation', 'workspaces', 'logged out', 'codex', 'support chat', 'file', 'download', 'preview', 'upload', 'project files'], statusComponent: 'Chat Completions', incidentIoBaseUrl: 'https://status.openai.com/incidents', incidentIoComponentId: '01JMXBRMFE6N2NNT7DG6XZQ6PW', incidentKeywords: ['api', 'us-east-1', 'us-west-2', 'eu-central-1'] },
  { id: 'gemini', name: 'Gemini API', provider: 'Google', category: 'api', statusUrl: 'https://status.cloud.google.com', apiUrl: null, gcloudProduct: 'Vertex Gemini API', gcloudProductId: 'Z0FZJAMvEB4j3NbCJs6B', incidentKeywords: ['vertex', 'gemini', 'us-central1', 'europe-west1', 'asia-northeast1'] },
  { id: 'bedrock', name: 'Amazon Bedrock', provider: 'AWS', category: 'api', statusUrl: 'https://health.aws.amazon.com/health/status', apiUrl: null, awsRssUrls: [
    'https://status.aws.amazon.com/rss/bedrock-us-east-1.rss',
    'https://status.aws.amazon.com/rss/bedrock-us-west-2.rss',
    'https://status.aws.amazon.com/rss/bedrock-eu-west-1.rss',
    'https://status.aws.amazon.com/rss/bedrock-ap-northeast-1.rss',
  ] },
  { id: 'azureopenai', name: 'Azure OpenAI', provider: 'Microsoft', category: 'api', statusUrl: 'https://azure.status.microsoft/en-us/status', apiUrl: null, azureRssUrl: 'https://rssfeed.azure.status.microsoft/en-us/status/feed/', incidentKeywords: ['Azure OpenAI'] },
  { id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', category: 'api', statusUrl: 'https://status.mistral.ai', apiUrl: null, instatusUrl: 'https://status.mistral.ai/incidents/page/1' },
  { id: 'cohere', name: 'Cohere API', provider: 'Cohere', category: 'api', statusUrl: 'https://status.cohere.com', apiUrl: 'https://status.cohere.com/api/v2/summary.json', incidentIoBaseUrl: 'https://status.cohere.com/incidents', incidentIoComponentId: '01HQ6CA39NZ5X3PRFPN71Q89TE' },
  { id: 'groq', name: 'Groq Cloud', provider: 'Groq', category: 'api', statusUrl: 'https://groqstatus.com', apiUrl: 'https://groqstatus.com/api/v2/summary.json', incidentIoBaseUrl: 'https://groqstatus.com/incidents', incidentIoComponentId: '01K053E2FAKWKEYHXEV7WAHJBM' },
  { id: 'together', name: 'Together AI', provider: 'Together', category: 'api', statusUrl: 'https://status.together.ai', apiUrl: null, rssFeedUrl: 'https://status.together.ai/feed', betterStackUrl: 'https://status.together.ai' },
  { id: 'perplexity', name: 'Perplexity', provider: 'Perplexity AI', category: 'api', statusUrl: 'https://status.perplexity.com', apiUrl: null, instatusUrl: 'https://status.perplexity.com' },
  { id: 'xai', name: 'xAI (Grok)', provider: 'xAI', category: 'api', statusUrl: 'https://status.x.ai', apiUrl: null, rssFeedUrl: 'https://status.x.ai/feed.xml', incidentKeywords: ['api'], incidentExclude: ['[API Console]', 'Test+Incident'] },
  { id: 'deepseek', name: 'DeepSeek API', provider: 'DeepSeek', category: 'api', statusUrl: 'https://status.deepseek.com', apiUrl: 'https://status.deepseek.com/api/v2/summary.json', statusComponentId: 'j4n367d9mh3x', incidentKeywords: ['api'] },
  { id: 'openrouter', name: 'OpenRouter', provider: 'OpenRouter', category: 'api', statusUrl: 'https://status.openrouter.ai', apiUrl: null, onlineOrNotUrl: 'https://status.openrouter.ai', onlineOrNotComponent: 'Chat (/api/v1/chat/completions)' },
  // Voice & Speech AI
  { id: 'elevenlabs', name: 'ElevenLabs', provider: 'ElevenLabs', category: 'api', statusUrl: 'https://status.elevenlabs.io', apiUrl: 'https://status.elevenlabs.io/api/v2/summary.json', incidentIoBaseUrl: 'https://status.elevenlabs.io/incidents', incidentIoComponentId: '01JP2RQVGDHPEEDAFM5KV2MH9P', incidentExclude: ['webpage'] },
  { id: 'assemblyai', name: 'AssemblyAI', provider: 'AssemblyAI', category: 'api', statusUrl: 'https://status.assemblyai.com', apiUrl: 'https://status.assemblyai.com/api/v2/summary.json', statusComponentId: '50txf4qfk2kv' },
  { id: 'deepgram', name: 'Deepgram', provider: 'Deepgram', category: 'api', statusUrl: 'https://status.deepgram.com', apiUrl: 'https://status.deepgram.com/api/v2/summary.json', statusComponentId: 'cv8l6gg3cb9d' },
  // Inference / Infrastructure
  { id: 'huggingface', name: 'Hugging Face', provider: 'Hugging Face', category: 'api', statusUrl: 'https://status.huggingface.co', apiUrl: null, rssFeedUrl: 'https://status.huggingface.co/feed', betterStackUrl: 'https://status.huggingface.co' },
  { id: 'replicate', name: 'Replicate', provider: 'Replicate', category: 'api', statusUrl: 'https://www.replicatestatus.com', apiUrl: 'https://www.replicatestatus.com/api/v2/summary.json', incidentIoBaseUrl: 'https://www.replicatestatus.com/incidents', incidentIoComponentId: '01JRJYHBWCXHFZ0NHMP1N7T2G3' },
  { id: 'pinecone', name: 'Pinecone', provider: 'Pinecone', category: 'api', statusUrl: 'https://status.pinecone.io', apiUrl: 'https://status.pinecone.io/api/v2/summary.json', statusComponentId: 'r7tngp2p3sjd' },
  { id: 'stability', name: 'Stability AI', provider: 'Stability AI', category: 'api', statusUrl: 'https://status.stability.ai', apiUrl: 'https://status.stability.ai/api/v2/summary.json', incidentIoBaseUrl: 'https://status.stability.ai/incidents', incidentIoComponentId: '01JW9J39X55NDFZTZT3K5NYR48' },
  // AI Apps
  { id: 'claudeai', name: 'claude.ai', provider: 'Anthropic', category: 'app', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json', incidentKeywords: ['claude.ai', 'across surfaces', 'claude desktop'], statusComponent: 'claude.ai', statusComponentId: 'rwppv331jlwc' },
  { id: 'characterai', name: 'Character.AI', provider: 'Character AI', category: 'app', statusUrl: 'https://status.character.ai', apiUrl: 'https://status.character.ai/api/v2/summary.json', statusComponentId: 'fw8g76r7dqcl' },
  { id: 'chatgpt', name: 'ChatGPT', provider: 'OpenAI', category: 'app', statusUrl: 'https://status.openai.com', apiUrl: 'https://status.openai.com/api/v2/summary.json', incidentKeywords: ['chatgpt', 'conversation', 'pinned', 'file', 'download', 'upload', 'us-east-1', 'us-west-2', 'eu-central-1'], incidentIoBaseUrl: 'https://status.openai.com/incidents', incidentIoComponentId: '01JMXBNJXGV1T5GT2M9XA83XNG' },
  // Coding Agents
  { id: 'claudecode', name: 'Claude Code', provider: 'Anthropic', category: 'agent', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json', incidentKeywords: ['claude code', 'across surfaces'], statusComponent: 'Claude Code', statusComponentId: 'yyzkbfz2thpt' },
  { id: 'copilot', name: 'GitHub Copilot', provider: 'Microsoft', category: 'agent', statusUrl: 'https://githubstatus.com', apiUrl: 'https://www.githubstatus.com/api/v2/summary.json', statusComponentId: 'pjmpxvq2cmr2' },
  { id: 'cursor', name: 'Cursor', provider: 'Anysphere', category: 'agent', statusUrl: 'https://status.cursor.com', apiUrl: 'https://status.cursor.com/api/v2/summary.json', statusComponentId: '92rkl6jnscl8' },
  { id: 'windsurf', name: 'Windsurf', provider: 'Codeium', category: 'agent', statusUrl: 'https://status.windsurf.com', apiUrl: 'https://status.windsurf.com/api/v2/summary.json', statusComponentId: 'r5wf1ykd7y1m' },
]

function filterIncidents(incidents: Incident[], config: ServiceConfig): Incident[] {
  const { incidentKeywords, incidentExclude } = config
  return incidents.filter((inc) => {
    const title = inc.title.toLowerCase()
    if (incidentExclude?.some((kw) => title.includes(kw.toLowerCase()))) return false
    if (incidentKeywords && incidentKeywords.length > 0) {
      // Match against title OR affected component names
      const compNames = (inc.componentNames ?? []).map((n) => n.toLowerCase())
      return incidentKeywords.some((kw) => {
        const kwLower = kw.toLowerCase()
        return title.includes(kwLower) || compNames.some((n) => n.includes(kwLower))
      })
    }
    return true
  })
}

// Retry once on failure to reduce false-positive 'down' from transient network issues
// Retry uses shorter timeout to keep total wall-clock time under ~12s per service
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

// ── Prefetched Atlassian API Data ──
// Services sharing the same status page (claude/claudeai/claudecode → status.claude.com;
// openai/chatgpt → status.openai.com) would otherwise each make 2 duplicate requests.
// Pre-fetching deduplicates these, saving 6 subrequests (36→30 base) and freeing
// budget for incident text enrichment scraping.

interface PrefetchedData {
  summary: StatuspageResponse
  incidents: StatuspageResponse | null
  latency: number
  uptimeHtml?: string  // Status page HTML for uptimeData parsing
}

// ── Fetch Single Service ──
// NOTE: `latency` measures status page response time, not actual AI API latency.
// This is a known v1 limitation — real API latency measurement is planned for a future phase.
// For services without `apiUrl`, status is based on HTTP reachability of the status page (200 = operational).
// This may not reflect actual service outages if the status page itself remains up.

async function fetchService(config: ServiceConfig, prefetched?: PrefetchedData, kv?: KVNamespace): Promise<ServiceStatus> {
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
      // Atlassian Statuspage API — use pre-fetched data when available, else fetch directly
      let summaryData: StatuspageResponse
      let latency: number
      let rawIncData: StatuspageResponse | null

      if (prefetched) {
        summaryData = prefetched.summary
        latency = prefetched.latency
        rawIncData = prefetched.incidents
      } else {
        const baseUrl = config.apiUrl.replace('/summary.json', '')
        const start = Date.now()
        const [summaryRes, incidentsRes] = await Promise.all([
          fetchWithRetry(config.apiUrl),
          fetchWithRetry(`${baseUrl}/incidents.json`).catch((err) => { console.warn(`[fetchService] ${config.id} incidents.json failed:`, err.message); return null }),
        ])
        latency = Date.now() - start
        if (!summaryRes.ok) {
          console.error(`[fetchService] ${config.id} summary.json returned HTTP ${summaryRes.status}`)
          return { ...base, status: 'degraded' }
        }
        summaryData = await summaryRes.json()
        rawIncData = incidentsRes?.ok ? await incidentsRes.json() : null
      }

      // incidents.json has full history; summary.json only has active ones
      let incidents: Incident[] = []
      const pageUrls = new Map<string, string>()
      if (rawIncData) {
        incidents = parseIncidents(rawIncData)
        // Build shortlink map: incidentId → detail page URL (used by enrichIncidentIoText)
        for (const inc of rawIncData.incidents ?? []) {
          if (inc.shortlink) pageUrls.set(inc.id, inc.shortlink)
        }
      } else {
        incidents = parseIncidents(summaryData)
        for (const inc of summaryData.incidents ?? []) {
          if (inc.shortlink) pageUrls.set(inc.id, inc.shortlink)
        }
      }

      let filtered = filterIncidents(incidents, config)
      // If service has keyword filters, is degraded/down, but no ongoing incidents matched,
      // include untagged incidents (provider didn't tag components on the incident)
      if (filtered.filter((i) => i.status !== 'resolved').length === 0 && config.incidentKeywords) {
        const svcStatus = normalizeStatus(summaryData.status?.indicator ?? 'none')
        if (svcStatus !== 'operational') {
          const untagged = incidents.filter((inc) =>
            inc.status !== 'resolved' &&
            (inc.componentNames ?? []).length === 0 &&
            !config.incidentExclude?.some((kw) => inc.title.toLowerCase().includes(kw.toLowerCase()))
          )
          filtered = [...filtered, ...untagged].sort((a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
          )
        }
      }
      if (config.incidentIoBaseUrl) {
        filtered = await enrichIncidentIoText(filtered, config.incidentIoBaseUrl, pageUrls, kv)
      }

      // Compute daily impact for calendar from uptimeData HTML (Statuspage services only).
      // Daily impact for calendar: Statuspage uptimeData OR incident.io component_impacts
      const uptimeResult = (prefetched?.uptimeHtml && config.statusComponentId)
        ? parseUptimeData(prefetched.uptimeHtml, config.statusComponentId)
        : null
      const ioDailyImpact = (prefetched?.uptimeHtml && config.incidentIoComponentId)
        ? parseIncidentIoComponentImpacts(prefetched.uptimeHtml, config.incidentIoComponentId)
        : null
      const dailyImpact = uptimeResult?.dailyImpact
        ?? (ioDailyImpact && Object.keys(ioDailyImpact).length > 0 ? ioDailyImpact : null)

      // Uptime%: Statuspage uptimeData > incident.io component_uptimes > incident duration estimate
      let uptimeValue: number | null = null
      let uptimeSrc: 'official' | 'estimate' | undefined
      if (uptimeResult?.uptimePercent != null) {
        uptimeValue = uptimeResult.uptimePercent
        uptimeSrc = 'official'
      } else if (prefetched?.uptimeHtml && config.incidentIoComponentId) {
        const ioUptime = parseIncidentIoUptime(prefetched.uptimeHtml, config.incidentIoComponentId)
        if (ioUptime != null) {
          uptimeValue = ioUptime
          uptimeSrc = 'official'
        } else {
          // Fallback for services without component_uptimes (Replicate, ElevenLabs)
          uptimeValue = computeUptimeFromIncidents(filtered)
          uptimeSrc = 'estimate'
        }
      } else if (config.incidentIoComponentId) {
        uptimeValue = computeUptimeFromIncidents(filtered)
        uptimeSrc = 'estimate'
      }

      // Augment dailyImpact with ongoing incidents (source data only includes resolved)
      // Only augment when service itself is non-operational (avoid marking calendar for
      // unrelated incidents that passed through filters but don't affect this component)
      const svcStatus = (() => {
        const overall = normalizeStatus(summaryData.status?.indicator ?? 'none')
        if (!config.statusComponent && !config.statusComponentId) return overall
        const comp = config.statusComponent
          ? summaryData.components?.find((c) => c.name.startsWith(config.statusComponent))
          : summaryData.components?.find((c) => c.id === config.statusComponentId)
        return comp ? normalizeStatus(comp.status) : overall
      })()
      const augmentedImpact = dailyImpact ? { ...dailyImpact } : {}
      if (svcStatus !== 'operational') {
        for (const inc of filtered) {
          if (inc.status !== 'resolved') {
            const day = inc.startedAt.split('T')[0]
            if (day && !augmentedImpact[day]) {
              augmentedImpact[day] = inc.impact === 'major' || inc.impact === 'critical' ? 'critical'
                : inc.impact === 'minor' ? 'minor' : 'major'
            }
          }
        }
      }

      return {
        ...base,
        status: svcStatus,
        latency: config.category === 'api' ? latency : null,
        incidents: filtered,
        ...(Object.keys(augmentedImpact).length > 0 ? { dailyImpact: augmentedImpact } : {}),
        calendarDays: config.statusComponentId ? 30 : 14,
        ...(uptimeValue != null ? { uptime30d: uptimeValue, uptimeSource: uptimeSrc } : {}),
      }
    } else {
      // No Statuspage API — HTTP check + optional scraping (parallel)
      // Uses fetchWithTimeout (no retry) to stay within 50-subrequest budget
      // AWS RSS — multi-region parallel fetch, OR logic (any region degraded → degraded)
      if (config.awsRssUrls) {
        const start = Date.now()
        const regionResults = await Promise.all(
          config.awsRssUrls.map(async (url) => {
            const region = url.match(/bedrock-(.+)\.rss/)?.[1] ?? 'unknown'
            try {
              const res = await fetchWithTimeout(url, 5000)
              if (!res.ok) {
                console.warn(`[fetchService] ${config.id} AWS RSS ${region} HTTP ${res.status}`)
                return { region, incidents: [] as Incident[], ok: false }
              }
              const incidents = parseAwsRssIncidents(await res.text())
              // Tag incidents with region via componentNames
              for (const inc of incidents) {
                inc.componentNames = [region]
              }
              return { region, incidents, ok: true }
            } catch (err) {
              console.warn(`[fetchService] ${config.id} AWS RSS ${region} failed:`, err instanceof Error ? err.message : err)
              return { region, incidents: [] as Incident[], ok: false }
            }
          })
        )
        const latency = Date.now() - start
        const okCount = regionResults.filter((r) => r.ok).length
        if (okCount === 0) {
          const shouldDegrade = await trackFetchFailure(kv, config.id)
          return { ...base, status: shouldDegrade ? 'degraded' : 'operational', incidents: [], latency: config.category === 'api' ? latency : null }
        }
        await resetFetchFailure(kv, config.id)
        if (okCount < regionResults.length) {
          console.warn(`[fetchService] ${config.id} AWS RSS: ${okCount}/${regionResults.length} regions responded`)
        }
        // Merge incidents from all regions, deduplicate by ID, merge componentNames for global incidents
        const seenMap = new Map<string, Incident>()
        const allIncidents: Incident[] = []
        for (const r of regionResults) {
          for (const inc of r.incidents) {
            const existing = seenMap.get(inc.id)
            if (existing) {
              // Global incident: merge region tags
              const regions = new Set(existing.componentNames ?? [])
              for (const name of inc.componentNames ?? []) regions.add(name)
              existing.componentNames = [...regions]
            } else {
              seenMap.set(inc.id, inc)
              allIncidents.push(inc)
            }
          }
        }
        allIncidents.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
        const filtered = filterIncidents(allIncidents, config)
        // Estimate uptime from incidents; no incidents = 100% (RSS confirmed reachable)
        const uptimeEst = computeUptimeFromIncidents(filtered) ?? 100
        return {
          ...base,
          status: deriveAwsStatus(filtered),
          latency: config.category === 'api' ? latency : null,
          incidents: filtered,
          calendarDays: 14,
          uptime30d: uptimeEst,
          uptimeSource: 'estimate' as const,
        }
      }

      // Azure RSS — single feed, keyword-filtered (reuses AWS parser)
      if (config.azureRssUrl) {
        const start = Date.now()
        const rssRes = await fetchWithTimeout(config.azureRssUrl, 8000).catch((err) => {
          console.warn(`[fetchService] ${config.id} Azure RSS failed:`, err instanceof Error ? err.message : err)
          return null
        })
        const latency = Date.now() - start
        if (!rssRes || !rssRes.ok) {
          if (rssRes) console.warn(`[fetchService] ${config.id} Azure RSS HTTP ${rssRes.status}`)
          const shouldDegrade = await trackFetchFailure(kv, config.id)
          return { ...base, status: shouldDegrade ? 'degraded' : 'operational', incidents: [], latency: config.category === 'api' ? latency : null }
        }
        await resetFetchFailure(kv, config.id)
        const incidents = parseAwsRssIncidents(await rssRes.text())
        const filtered = filterIncidents(incidents, config)
        const uptimeEst = computeUptimeFromIncidents(filtered) ?? 100
        return {
          ...base,
          status: deriveAwsStatus(filtered),
          latency: config.category === 'api' ? latency : null,
          incidents: filtered,
          calendarDays: 14,
          uptime30d: uptimeEst,
          uptimeSource: 'estimate' as const,
        }
      }

      const start = Date.now()
      const scrapeUrl = config.instatusUrl || config.rssFeedUrl || (config.gcloudProduct ? 'https://status.cloud.google.com/incidents.json' : null)
      const [res, scrapeRes, betterStackRes] = await Promise.all([
        fetchWithTimeout(config.statusUrl),
        scrapeUrl
          ? fetchWithTimeout(scrapeUrl).catch((err) => {
              console.warn(`[fetchService] ${config.id} scrape failed:`, err instanceof Error ? err.message : err)
              return null
            })
          : Promise.resolve(null),
        config.betterStackUrl
          ? fetchWithTimeout(`${config.betterStackUrl}/index.json`, 5000).catch((err) => {
              console.warn(`[fetchService] ${config.id} BetterStack uptime fetch failed:`, err instanceof Error ? err.message : err)
              return null
            })
          : Promise.resolve(null),
      ])
      const latency = Date.now() - start

      let incidents: Incident[] = []
      if (config.onlineOrNotUrl && res.ok) {
        const html = await res.text()
        incidents = parseOnlineOrNotIncidents(html)
        if (config.onlineOrNotComponent) {
          const uptime = parseOnlineOrNotUptime(html, config.onlineOrNotComponent)
          if (uptime != null) {
            base.uptime30d = uptime
            base.uptimeSource = 'platform_avg'
          } else {
            console.warn(`[fetchService] ${config.id} OnlineOrNot uptime not found for component: ${config.onlineOrNotComponent}`)
          }
        }
      } else if (config.onlineOrNotUrl && !res.ok) {
        console.warn(`[fetchService] ${config.id} OnlineOrNot status page returned ${res.status}`)
      } else if (scrapeRes?.ok) {
        if (config.instatusUrl) {
          incidents = parseInstatusIncidents(await scrapeRes.text())
        } else if (config.rssFeedUrl) {
          const rssText = await scrapeRes.text()
          incidents = config.rssFeedUrl.includes('status.x.ai')
            ? parseXaiRssIncidents(rssText)
            : parseRssIncidents(rssText)
        } else if (config.gcloudProduct) {
          const data: GCloudIncident[] = await scrapeRes.json()
          incidents = parseGCloudIncidents(data, config.gcloudProduct, config.gcloudProductId)
        }
      }

      // Better Stack uptime + status: parse /index.json for aggregate_state and availability
      let betterStackUptime: number | null = null
      let betterStackStat: 'operational' | 'degraded' | 'down' | null = null
      let bsDailyImpact: Record<string, DailyImpactLevel> | null = null
      if (betterStackRes?.ok) {
        try {
          const bsData: BetterStackIndex = await betterStackRes.json()
          betterStackUptime = parseBetterStackUptime(bsData)
          betterStackStat = parseBetterStackStatus(bsData)
          bsDailyImpact = parseBetterStackDailyImpact(bsData)
        } catch (err) {
          console.warn(`[fetchService] ${config.id} BetterStack parse failed:`, err instanceof Error ? err.message : err)
        }
      }

      const filtered = filterIncidents(incidents, config)
      // Prefer BetterStack aggregate_state (authoritative platform status),
      // then fall back to RSS incident check, then HTTP check
      const hasOngoing = filtered.some((i) => i.status !== 'resolved')
      const httpStatus = res.ok || res.status === 403 ? 'operational' : 'degraded'
      const derivedStatus = betterStackStat ?? (hasOngoing ? 'degraded' : httpStatus)

      return {
        ...base,
        status: derivedStatus,
        latency: config.category === 'api' ? latency : null,
        incidents: filtered,
        calendarDays: bsDailyImpact ? 30 : 14,
        ...(bsDailyImpact ? { dailyImpact: bsDailyImpact } : {}),
        ...(betterStackUptime != null ? { uptime30d: betterStackUptime, uptimeSource: 'platform_avg' as const } : {}),
      }
    }
  } catch (err) {
    // Fetch failure (timeout/network) ≠ confirmed outage → degraded, not down
    // Only Statuspage API indicator 'major'/'critical' should produce 'down'
    console.error(`[fetchService] ${config.id} failed:`, err)
    return { ...base, status: 'degraded' }
  }
}

// ── Fetch All Services (parallel, with KV fallback) ──

export const CACHE_KEY = 'services:latest'

export async function fetchAllServices(kv?: KVNamespace): Promise<{ raw: ServiceStatus[]; enriched: ServiceStatus[] }> {
  // Pre-fetch unique Atlassian status API endpoints once.
  // Services sharing a status page (claude+claudeai+claudecode, openai+chatgpt) would each fetch
  // the same URLs independently. Deduplicating saves 6 subrequests, freeing budget for enrichment.
  const uniqueApiUrls = [...new Set(SERVICES.filter((s) => s.apiUrl).map((s) => s.apiUrl!))]
  const prefetchMap = new Map<string, PrefetchedData>()
  await Promise.all(uniqueApiUrls.map(async (apiUrl) => {
    const baseUrl = apiUrl.replace('/summary.json', '')
    const start = Date.now()
    try {
      // Use fetchWithTimeout (no retry) — prefetch failure falls through to direct fetch
      // in fetchService, so retrying here would waste 2 subrequests before the fallback.
      const [summaryRes, incidentsRes] = await Promise.all([
        fetchWithTimeout(apiUrl, 8000),
        fetchWithTimeout(`${baseUrl}/incidents.json`, 8000).catch((err) => {
          console.warn(`[prefetch] incidents.json failed for ${baseUrl}:`, err.message)
          return null
        }),
      ])
      const latency = Date.now() - start
      if (!summaryRes.ok) {
        console.warn(`[prefetch] ${apiUrl} returned HTTP ${summaryRes.status} — skipping; fetchService will fetch directly`)
        return
      }
      const summary: StatuspageResponse = await summaryRes.json()
      const incidents: StatuspageResponse | null = incidentsRes?.ok ? await incidentsRes.json() : null
      // Fetch status page HTML for uptimeData/component_uptimes parsing
      const statusUrl = baseUrl.replace('/api/v2', '')
      const needsHtml = SERVICES.some((s) => s.apiUrl === apiUrl && (s.statusComponentId || s.incidentIoComponentId))
      let uptimeHtml: string | undefined
      if (needsHtml) {
        try {
          const htmlRes = await fetchWithTimeout(statusUrl, 5000)
          if (htmlRes.ok) uptimeHtml = await htmlRes.text()
        } catch { /* non-critical — fallback to incidents API */ }
      }
      prefetchMap.set(apiUrl, { summary, incidents, latency, uptimeHtml })
    } catch (err) {
      const isJsonErr = err instanceof SyntaxError
      console.warn(`[prefetch] ${isJsonErr ? 'JSON parse' : 'network'} failure for ${baseUrl}:`, err instanceof Error ? err.message : err)
    }
  }))

  const results = await Promise.allSettled(
    SERVICES.map((config) => fetchService(config, config.apiUrl ? prefetchMap.get(config.apiUrl) : undefined, kv))
  )

  // Raw results (for caching — no fallback substitution)
  const raw: ServiceStatus[] = results.map((result, i) => {
    if (result.status === 'fulfilled') return result.value
    return {
      id: SERVICES[i].id,
      name: SERVICES[i].name,
      provider: SERVICES[i].provider,
      category: SERVICES[i].category,
      status: 'degraded' as const,
      latency: null,
      uptime30d: null,
      lastChecked: new Date().toISOString(),
      incidents: [],
    }
  })

  // Read cached snapshot for fallback (only if needed)
  let cachedServices: ServiceStatus[] | null = null
  const needsFallback = raw.some((s) => s.status === 'degraded')
  if (needsFallback && kv) {
    const cached = await kv.get(CACHE_KEY).catch(() => null)
    if (cached) {
      try { cachedServices = JSON.parse(cached).services } catch { console.warn('[fetchAllServices] corrupt services cache in KV — fallback not available') }
    }
  }

  // Enriched results (with cache fallback for degraded services)
  const enriched: ServiceStatus[] = raw.map((svc) => {
    if (svc.status === 'degraded' && cachedServices) {
      const prev = cachedServices.find((s) => s.id === svc.id)
      if (prev && prev.status === 'operational') {
        return { ...prev, lastChecked: svc.lastChecked }
      }
    }
    return svc
  })

  return { raw, enriched }
}

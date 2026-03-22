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
  dailyImpact?: Record<string, 'minor' | 'major' | 'critical'>
  calendarDays?: number  // 30 for Statuspage (accurate), 14 for incident.io (API limit)
  uptimeSource?: 'official' | 'platform_avg' | 'estimate'  // official=Statuspage/incident.io, platform_avg=Better Stack avg, estimate=incident duration
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
  gcloudProductId?: string // Google Cloud product ID for more precise filtering
  rssFeedUrl?: string    // Better Stack RSS feed URL for incidents
  incidentKeywords?: string[]  // Only show incidents matching these keywords (case-insensitive)
  incidentExclude?: string[]   // Exclude incidents matching these keywords
  incidentIoBaseUrl?: string   // incident.io status page base URL — scrape update text for active incidents
  statusComponent?: string     // Statuspage component name for incident filtering
  statusComponentId?: string   // Statuspage component ID for uptimeData calendar parsing
  incidentIoComponentId?: string // incident.io component ID for uptime calculation from incidents
  betterStackUrl?: string        // Better Stack status page base URL for /index.json uptime API
}

const SERVICES: ServiceConfig[] = [
  // AI API Services
  { id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json', incidentExclude: ['claude.ai', 'claude code'], statusComponent: 'Claude API', statusComponentId: 'k8w3r06qmzrp' },
  { id: 'openai', name: 'OpenAI API', provider: 'OpenAI', category: 'api', statusUrl: 'https://status.openai.com', apiUrl: 'https://status.openai.com/api/v2/summary.json', incidentExclude: ['chatgpt', 'excel plugin', 'gpts', 'voice mode', 'deep research', 'pinned', 'sora', 'sign-in', 'conversation', 'workspaces', 'logged out', 'codex', 'support chat'], incidentIoBaseUrl: 'https://status.openai.com/incidents', incidentIoComponentId: '01JMXBRMFE6N2NNT7DG6XZQ6PW' },
  { id: 'gemini', name: 'Gemini API', provider: 'Google', category: 'api', statusUrl: 'https://status.cloud.google.com', apiUrl: null, gcloudProduct: 'Vertex Gemini API', gcloudProductId: 'Z0FZJAMvEB4j3NbCJs6B' },
  { id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', category: 'api', statusUrl: 'https://status.mistral.ai', apiUrl: null, instatusUrl: 'https://status.mistral.ai/incidents/page/1' },
  { id: 'cohere', name: 'Cohere API', provider: 'Cohere', category: 'api', statusUrl: 'https://status.cohere.com', apiUrl: 'https://status.cohere.com/api/v2/summary.json', incidentIoBaseUrl: 'https://status.cohere.com/incidents', incidentIoComponentId: '01HQ6CA39NZ5X3PRFPN71Q89TE' },
  { id: 'groq', name: 'Groq Cloud', provider: 'Groq', category: 'api', statusUrl: 'https://groqstatus.com', apiUrl: 'https://groqstatus.com/api/v2/summary.json', incidentIoBaseUrl: 'https://groqstatus.com/incidents', incidentIoComponentId: '01K053E2FAKWKEYHXEV7WAHJBM' },
  { id: 'together', name: 'Together AI', provider: 'Together', category: 'api', statusUrl: 'https://status.together.ai', apiUrl: null, rssFeedUrl: 'https://status.together.ai/feed', betterStackUrl: 'https://status.together.ai' },
  { id: 'perplexity', name: 'Perplexity', provider: 'Perplexity AI', category: 'api', statusUrl: 'https://status.perplexity.com', apiUrl: null, instatusUrl: 'https://status.perplexity.com' },
  { id: 'huggingface', name: 'Hugging Face', provider: 'Hugging Face', category: 'api', statusUrl: 'https://status.huggingface.co', apiUrl: null, rssFeedUrl: 'https://status.huggingface.co/feed', betterStackUrl: 'https://status.huggingface.co' },
  { id: 'replicate', name: 'Replicate', provider: 'Replicate', category: 'api', statusUrl: 'https://www.replicatestatus.com', apiUrl: 'https://www.replicatestatus.com/api/v2/summary.json', incidentIoBaseUrl: 'https://www.replicatestatus.com/incidents', incidentIoComponentId: '01JRJYHBWCXHFZ0NHMP1N7T2G3' },
  { id: 'elevenlabs', name: 'ElevenLabs', provider: 'ElevenLabs', category: 'api', statusUrl: 'https://status.elevenlabs.io', apiUrl: 'https://status.elevenlabs.io/api/v2/summary.json', incidentIoBaseUrl: 'https://status.elevenlabs.io/incidents', incidentIoComponentId: '01JP2RQVGDHPEEDAFM5KV2MH9P', incidentExclude: ['sip', 'webpage'] },
  { id: 'xai', name: 'xAI (Grok)', provider: 'xAI', category: 'api', statusUrl: 'https://status.x.ai', apiUrl: null, rssFeedUrl: 'https://status.x.ai/feed.xml', incidentKeywords: ['api'] },
  { id: 'deepseek', name: 'DeepSeek API', provider: 'DeepSeek', category: 'api', statusUrl: 'https://status.deepseek.com', apiUrl: 'https://status.deepseek.com/api/v2/summary.json', statusComponentId: 'j4n367d9mh3x', incidentKeywords: ['api'] },
  // AI Web Apps
  { id: 'claudeai', name: 'claude.ai', provider: 'Anthropic', category: 'webapp', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json', incidentKeywords: ['claude.ai', 'across surfaces'], statusComponent: 'claude.ai', statusComponentId: 'rwppv331jlwc' },
  { id: 'chatgpt', name: 'ChatGPT', provider: 'OpenAI', category: 'webapp', statusUrl: 'https://status.openai.com', apiUrl: 'https://status.openai.com/api/v2/summary.json', incidentKeywords: ['chatgpt', 'conversation', 'pinned'], incidentIoBaseUrl: 'https://status.openai.com/incidents', statusComponent: 'ChatGPT', incidentIoComponentId: '01JMXBNJXGV1T5GT2M9XA83XNG' },
  // Coding Agents
  { id: 'claudecode', name: 'Claude Code', provider: 'Anthropic', category: 'agent', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json', incidentKeywords: ['claude code', 'across surfaces'], statusComponent: 'Claude Code', statusComponentId: 'yyzkbfz2thpt' },
  { id: 'copilot', name: 'GitHub Copilot', provider: 'Microsoft', category: 'agent', statusUrl: 'https://githubstatus.com', apiUrl: 'https://www.githubstatus.com/api/v2/summary.json', statusComponentId: 'pjmpxvq2cmr2' },
  { id: 'cursor', name: 'Cursor', provider: 'Anysphere', category: 'agent', statusUrl: 'https://status.cursor.com', apiUrl: 'https://status.cursor.com/api/v2/summary.json', statusComponentId: '92rkl6jnscl8' },
  { id: 'windsurf', name: 'Windsurf', provider: 'Codeium', category: 'agent', statusUrl: 'https://status.windsurf.com', apiUrl: 'https://status.windsurf.com/api/v2/summary.json', statusComponentId: 'r5wf1ykd7y1m' },
]

// ── Statuspage API Parser (Atlassian format) ──

interface StatuspageResponse {
  status: { indicator: string; description: string }
  components?: Array<{ name: string; status: string }>
  incidents?: Array<{
    id: string
    name: string
    status: string
    impact: string
    created_at: string
    resolved_at: string | null
    shortlink?: string
    components?: Array<{ name: string }>
    incident_updates?: Array<{
      status: string; body: string; created_at: string; display_at?: string
      affected_components?: Array<{ code: string; name: string; new_status: string }>
    }>
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
  return (data.incidents ?? []).map((inc) => {
    const duration = inc.resolved_at
      ? formatDuration(new Date(inc.created_at), new Date(inc.resolved_at))
      : null
    const rawTimeline: TimelineEntry[] = (inc.incident_updates ?? [])
      .map((u) => ({
        stage: u.status === 'resolved' ? 'resolved' as const
          : u.status === 'monitoring' ? 'monitoring' as const
          : u.status === 'identified' ? 'identified' as const
          : 'investigating' as const,
        text: u.body || null,
        at: u.display_at ?? u.created_at,
      }))
      .reverse() // oldest first
    // Deduplicate: keep one entry per stage+time (removes duplicate updates)
    const seen = new Set<string>()
    const timeline = rawTimeline.filter((t) => {
      const key = `${t.stage}:${t.at}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const impact = inc.impact === 'critical' ? 'critical' as const
      : inc.impact === 'major' ? 'major' as const
      : inc.impact === 'minor' ? 'minor' as const
      : null

    const componentNames = inc.components?.map((c) => c.name) ?? []

    return {
      id: inc.id,
      title: inc.name,
      status: (inc.status === 'resolved' || inc.status === 'postmortem') ? 'resolved'
        : inc.status === 'monitoring' ? 'monitoring'
        : inc.status === 'identified' ? 'identified'
        : 'investigating',
      impact,
      ...(componentNames.length > 0 ? { componentNames } : {}),
      startedAt: inc.created_at,
      duration,
      timeline,
    }
  })
}

// ── Better Stack RSS Feed Parser — for HuggingFace, Together ──
// RSS items come in pairs: "X went down" + "X recovered", grouped by guid

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, '') // strip HTML tags
}

function isValidDate(s: string): boolean {
  return !isNaN(new Date(s).getTime())
}

function parseRssIncidents(xml: string): Incident[] {
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g)
  if (!items) return []

  // Group by guid (same guid = same incident)
  const groups = new Map<string, Array<{ title: string; date: string; desc: string }>>()
  for (const item of items) {
    const guid = item.match(/<guid>(.*?)<\/guid>/)?.[1]
    if (!guid) continue // skip items without guid
    const date = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? ''
    if (!isValidDate(date)) continue // skip malformed dates
    const title = decodeXmlEntities(item.match(/<title>(.*?)<\/title>/)?.[1] ?? '')
    const desc = decodeXmlEntities(item.match(/<description>(.*?)<\/description>/)?.[1] ?? '')
    if (!groups.has(guid)) groups.set(guid, [])
    groups.get(guid)!.push({ title, date, desc })
  }

  // Convert each group to an Incident (limit to 5)
  const incidents: Incident[] = []
  for (const [guid, events] of groups) {
    if (incidents.length >= 5) break
    events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    const first = events[0]
    const last = events[events.length - 1]
    const isResolved = last.title.toLowerCase().includes('recovered')
    const startedAt = new Date(first.date).toISOString()
    const duration = isResolved
      ? formatDuration(new Date(first.date), new Date(last.date))
      : null
    const component = first.title.replace(/ went down$/i, '').replace(/ recovered$/i, '')

    incidents.push({
      id: guid.split('#')[1] ?? guid,
      title: `${component} — ${isResolved ? 'recovered' : 'down'}`,
      status: isResolved ? 'resolved' : 'investigating',
      impact: null,
      startedAt,
      duration,
      timeline: events.map((e, idx) => ({
        stage: (isResolved && idx === events.length - 1) ? 'resolved' as const : 'investigating' as const,
        text: e.desc || e.title,
        at: new Date(e.date).toISOString(),
      })),
    })
  }
  return incidents
}

// ── xAI RSS Feed Parser — custom format with HTML description containing updates ──
// Each <item> is a single incident with all updates in the description.
// Title format: "[Component] incident title"

function parseXaiRssIncidents(xml: string): Incident[] {
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g)
  if (!items) return []

  const incidents: Incident[] = []
  for (const item of items) {
    const title = item.match(/<title>(.*?)<\/title>/)?.[1] ?? ''
    const guid = item.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] ?? ''
    if (!guid) continue

    // Extract status and resolved date from description
    const desc = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ?? ''
    const statusMatch = desc.match(/Status:\s*(\w+)/)
    const resolvedMatch = desc.match(/Resolved:\s*([^<]+)/)
    const isResolved = statusMatch?.[1] === 'RESOLVED'

    // Extract timeline updates from description HTML (assumes flat <div> structure)
    const updateBlocks = desc.match(/<div>([\s\S]*?)<\/div>/g) ?? []
    const timeline: TimelineEntry[] = updateBlocks.flatMap((block) => {
      const dateMatch = block.match(/<strong>(.*?)<\/strong>/)
      const titleMatch = block.match(/<h3>(.*?)<\/h3>/)
      const textMatch = block.match(/<p>(?!<strong>)(.*?)<\/p>/g)
      if (!dateMatch) return []
      const parsedDate = new Date(dateMatch[1])
      if (isNaN(parsedDate.getTime())) return []
      const at = parsedDate.toISOString()
      const stage = titleMatch?.[1]?.toLowerCase().includes('resolved') ? 'resolved' as const
        : titleMatch?.[1]?.toLowerCase().includes('monitor') ? 'monitoring' as const
        : titleMatch?.[1]?.toLowerCase().includes('identif') ? 'identified' as const
        : 'investigating' as const
      const text = textMatch?.map(p => decodeXmlEntities(p.replace(/<[^>]*>/g, ''))).join(' ').trim() || null
      return [{ stage, text, at }]
    }).reverse() // oldest first

    const startedAt = timeline.length > 0 ? timeline[0].at : new Date().toISOString()
    const resolvedDate = resolvedMatch ? new Date(resolvedMatch[1].trim()) : null
    const resolvedAt = (resolvedDate && !isNaN(resolvedDate.getTime())) ? resolvedDate : null
    const duration = (isResolved && resolvedAt && timeline.length > 0)
      ? formatDuration(new Date(startedAt), resolvedAt)
      : null

    incidents.push({
      id: guid,
      title,
      status: isResolved ? 'resolved' : 'investigating',
      impact: null,
      startedAt,
      duration,
      timeline,
    })
  }
  return incidents
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

function parseGCloudIncidents(data: GCloudIncident[], productFilter: string, productId?: string): Incident[] {
  return data
    .filter((inc) =>
      (productId && inc.affected_products?.some((p) => p.id === productId)) ||
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

        const impact = inc.severity === 'high' ? 'major' as const
          : inc.severity === 'medium' ? 'minor' as const
          : null
        return [{
          id: inc.id,
          title: `${inc.service_name} — ${inc.severity}`,
          status: status === 'AVAILABLE' ? 'resolved' as const
            : status === 'SERVICE_DISRUPTION' ? 'investigating' as const
            : 'investigating' as const,
          impact,
          startedAt: inc.begin,
          duration,
          timeline,
        }]
      } catch { return [] }
    })
}

// ── Instatus (Next.js SSR) Parser — for status pages like Perplexity ──
// The Next.js version embeds incident data in __next_f.push chunks as a
// "notices" object: { id: { name, impact, started, resolved, status, components } }

function parseInstatusNextIncidents(html: string): Incident[] {
  try {
    // Next.js SSR payload has escaped quotes: notices\":{\"id\":{...}}
    // Find the notices section and unescape
    const match = html.match(/notices\\":\{(\\"[a-z0-9][\s\S]*?)\},\\"metrics/)
    if (!match) return []
    // Unescape the JSON: \" → "
    const raw = '{' + match[1].replace(/\\"/g, '"') + '}'
    const notices = JSON.parse(raw) as Record<string, {
      id: string; name: { default: string }; impact: string
      started: string; resolved: string | null; status: string
    }>

    const incidents: Incident[] = []
    for (const notice of Object.values(notices)) {
      if (incidents.length >= 5) break
      const startDate = new Date(notice.started)
      if (isNaN(startDate.getTime())) continue
      const resolvedDate = notice.resolved ? new Date(notice.resolved) : null
      const isResolved = notice.status === 'RESOLVED'

      const timeline: TimelineEntry[] = [
        { stage: 'investigating' as const, text: notice.name.default, at: startDate.toISOString() },
      ]
      if (isResolved && resolvedDate && !isNaN(resolvedDate.getTime())) {
        timeline.push({ stage: 'resolved' as const, text: 'Resolved', at: resolvedDate.toISOString() })
      }

      incidents.push({
        id: notice.id,
        title: notice.name.default,
        status: isResolved ? 'resolved' : 'investigating',
        impact: notice.impact === 'MAJOROUTAGE' ? 'major' : notice.impact === 'PARTIALOUTAGE' ? 'minor' : null,
        startedAt: startDate.toISOString(),
        duration: (isResolved && resolvedDate && !isNaN(resolvedDate.getTime()))
          ? formatDuration(startDate, resolvedDate)
          : null,
        timeline,
      })
    }
    return incidents
  } catch (err) {
    console.warn('[parseInstatusNext] failed:', err instanceof Error ? err.message : err)
    return []
  }
}

// ── Instatus (Nuxt SSR) Parser — for status pages like Mistral ──

function parseInstatusIncidents(html: string): Incident[] {
  // Instatus has two SSR formats: Nuxt (__NUXT_DATA__) and Next.js (__next_f)
  if (!html.includes('__NUXT_DATA__') && html.includes('__next_f')) {
    return parseInstatusNextIncidents(html)
  }
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
          impact: null,
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

// ── Statuspage uptimeData Parser ──
// Parses the embedded uptimeData from status page HTML to get accurate per-component
// daily outage data (p=partial seconds, m=major seconds). This is the same data
// Statuspage uses to render its own calendar, so it's 100% accurate.

interface UptimeDayEntry {
  date: string
  outages?: { p?: number; m?: number }
  related_events?: Array<{ name: string }>
}

type DailyImpactLevel = 'minor' | 'major' | 'critical'

interface UptimeDataResult {
  dailyImpact: Record<string, DailyImpactLevel>
  uptimePercent: number | null
}

function parseUptimeData(html: string, componentId: string): UptimeDataResult {
  const result: UptimeDataResult = { dailyImpact: {}, uptimePercent: null }
  // Find "var uptimeData = " then extract JSON by brace counting (50KB+ object)
  const prefix = 'var uptimeData = '
  const startIdx = html.indexOf(prefix)
  if (startIdx === -1) return result
  const jsonStart = startIdx + prefix.length
  let depth = 0
  let jsonEnd = -1
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break } }
  }
  if (jsonEnd === -1) return result
  try {
    // Structure: { componentId: { component: {...}, days: [{date, outages: {p, m}}] } }
    const data = JSON.parse(html.substring(jsonStart, jsonEnd)) as Record<string, { days?: UptimeDayEntry[] }>
    const comp = data[componentId]
    if (!comp?.days || !Array.isArray(comp.days)) return result

    let totalWeightedSec = 0
    let validDays = 0

    for (const day of comp.days) {
      if (!day.date) continue
      // Days with outages property defined (even if empty) count as valid data points
      if (day.outages !== undefined) validDays++
      if (!day.outages) continue
      const m = day.outages.m ?? 0
      const p = day.outages.p ?? 0
      // Statuspage weights: major=100%, partial=30% (Atlassian default)
      totalWeightedSec += m + 0.3 * p
      if (m > 0 && m > p) result.dailyImpact[day.date] = 'critical'  // major outage dominant → red
      else if (p > 0 || m > 0) result.dailyImpact[day.date] = 'major'  // partial outage dominant → orange
    }

    // Compute uptime%: (1 - weightedOutage / totalWindow) × 100
    if (validDays > 0) {
      result.uptimePercent = Math.round((1 - totalWeightedSec / (validDays * 86400)) * 10000) / 100
    }
  } catch (err) {
    console.warn('[parseUptimeData] failed to parse uptimeData:', err instanceof Error ? err.message : err)
  }
  return result
}

// ── incident.io Uptime Parser ──
// Extracts per-component uptime% directly from the status page HTML.
// The __next_f.push SSR payload contains a component_uptimes array with official uptime values.

function parseIncidentIoUptime(html: string, componentId: string): number | null {
  const chunks = html.match(/self\.__next_f\.push\(\[1,([\s\S]*?)\]\)\s*<\/script/g) ?? []
  for (const chunk of chunks) {
    if (!chunk.includes('component_uptimes')) continue
    // Find our componentId and its uptime value in escaped JSON
    // Format: \"component_id\":\"<id>\",...,\"uptime\":\"99.99\"
    const re = new RegExp(
      `\\\\"component_id\\\\":\\\\"${componentId}\\\\"[\\s\\S]*?\\\\"uptime\\\\":\\\\"([^\\\\"]*)\\\\"`
    )
    const match = chunk.match(re)
    if (!match) continue
    const raw = match[1]
    if (raw === '$undefined' || raw === '') return null
    const pct = parseFloat(raw)
    if (isNaN(pct) || pct < 0 || pct > 100) {
      console.warn(`[parseIncidentIoUptime] unexpected uptime value "${raw}" for ${componentId}`)
      return null
    }
    return pct
  }
  return null
}

// ── incident.io Component Impacts Parser ──
// Extracts per-component daily impact levels from component_impacts in the status page HTML.
// Used to build accurate 30-day status calendars for incident.io services.

function parseIncidentIoComponentImpacts(html: string, componentId: string): Record<string, DailyImpactLevel> {
  const result: Record<string, DailyImpactLevel> = {}
  const chunks = html.match(/self\.__next_f\.push\(\[1,([\s\S]*?)\]\)\s*<\/script/g) ?? []
  for (const chunk of chunks) {
    if (!chunk.includes('component_impacts')) continue
    // Extract array between component_impacts and component_uptimes
    const idx1 = chunk.indexOf('component_impacts')
    const idx2 = chunk.indexOf('component_uptimes')
    if (idx1 === -1 || idx2 === -1 || idx2 <= idx1) continue
    const segment = chunk.substring(idx1, idx2)
    const arrStart = segment.indexOf('[')
    const arrEnd = segment.lastIndexOf(']')
    if (arrStart === -1 || arrEnd === -1) continue
    let raw = segment.substring(arrStart, arrEnd + 1)
    // Unescape: \\" → "
    raw = raw.replace(/\\"/g, '"')
    raw = raw.replace(/"\$undefined"/g, 'null')

    try {
      const impacts = JSON.parse(raw) as Array<{
        component_id: string; start_at: string; end_at: string; status: string
      }>
      // Filter by target component for Phase 1 accuracy; Phase 2 (incidents) fills in other components
      const mine = impacts.filter((i) => i.component_id === componentId)
      for (const impact of mine) {
        const start = new Date(impact.start_at)
        const end = new Date(impact.end_at)
        if (isNaN(start.getTime()) || isNaN(end.getTime())) continue
        // Skip impacts shorter than 10 minutes (matches official calendar threshold)
        if (end.getTime() - start.getTime() < 600_000) continue

        // Map status to DailyImpactLevel
        const level: DailyImpactLevel =
          impact.status === 'full_outage' ? 'critical'
          : impact.status === 'partial_outage' ? 'major'
          : 'minor' // degraded_performance

        // Mark each UTC day the impact spans
        const dayMs = 86_400_000
        const startDay = new Date(start.toISOString().split('T')[0]).getTime()
        const endDay = new Date(end.toISOString().split('T')[0]).getTime()
        for (let d = startDay; d <= endDay; d += dayMs) {
          const dateStr = new Date(d).toISOString().split('T')[0]
          // Keep worst level per day: critical > major > minor
          const existing = result[dateStr]
          if (!existing || level === 'critical' || (level === 'major' && existing === 'minor')) {
            result[dateStr] = level
          }
        }
      }
    } catch (err) {
      console.warn('[parseIncidentIoComponentImpacts] parse failed:', err instanceof Error ? err.message : err)
    }
    break
  }
  return result
}

// ── incident.io Uptime Calculator (fallback) ──
// Computes uptime% from filtered incident durations over a 90-day window.
// Used when component_uptimes is unavailable ($undefined).

function computeUptimeFromIncidents(incidents: Incident[]): number | null {
  // No incidents at all → return null (no data) rather than asserting 100%
  if (incidents.length === 0) return null

  const now = Date.now()
  const windowMs = 90 * 86_400_000
  const windowStart = now - windowMs

  // Collect outage intervals, then merge overlapping ones to avoid double-counting
  const intervals: Array<{ start: number; end: number }> = []
  for (const inc of incidents) {
    const start = new Date(inc.startedAt).getTime()
    if (isNaN(start)) continue

    let endMs: number
    if (inc.status === 'resolved' && inc.duration) {
      const hours = parseInt(inc.duration.match(/(\d+)h/)?.[1] ?? '0')
      const mins = parseInt(inc.duration.match(/(\d+)m/)?.[1] ?? '0')
      endMs = start + (hours * 3600 + mins * 60) * 1000
      // Fallback: if duration parsed to 0, try resolved timestamp from timeline
      if (endMs === start) {
        const resolvedEntry = inc.timeline.find((t) => t.stage === 'resolved')
        if (resolvedEntry) {
          const resolvedMs = new Date(resolvedEntry.at).getTime()
          if (!isNaN(resolvedMs) && resolvedMs > start) endMs = resolvedMs
        }
      }
    } else if (inc.status === 'resolved') {
      // No duration string — try resolved timestamp from timeline
      const resolvedEntry = inc.timeline.find((t) => t.stage === 'resolved')
      if (resolvedEntry) {
        const resolvedMs = new Date(resolvedEntry.at).getTime()
        if (!isNaN(resolvedMs) && resolvedMs > start) endMs = resolvedMs
        else continue
      } else {
        continue
      }
    } else {
      endMs = now // unresolved → ongoing outage
    }

    // Clamp to 90-day window
    if (endMs > windowStart && start < now) {
      intervals.push({ start: Math.max(start, windowStart), end: Math.min(endMs, now) })
    }
  }

  // Merge overlapping intervals to prevent double-counting
  if (intervals.length === 0) return 100
  intervals.sort((a, b) => a.start - b.start)
  let totalOutageMs = 0
  let curStart = intervals[0].start
  let curEnd = intervals[0].end
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].start <= curEnd) {
      curEnd = Math.max(curEnd, intervals[i].end)
    } else {
      totalOutageMs += curEnd - curStart
      curStart = intervals[i].start
      curEnd = intervals[i].end
    }
  }
  totalOutageMs += curEnd - curStart

  return Math.max(0, Math.round((1 - totalOutageMs / windowMs) * 10000) / 100)
}

// ── Better Stack Uptime Parser ──
// Fetches /index.json from Better Stack status pages and returns average availability.

interface BetterStackIndex {
  included?: Array<{
    type: string
    attributes?: { availability?: number }
  }>
}

function parseBetterStackUptime(data: BetterStackIndex): number | null {
  const resources = (data.included ?? []).filter(
    (r) => r.type === 'status_page_resource' && r.attributes?.availability != null
  )
  if (resources.length === 0) return null

  const sum = resources.reduce((acc, r) => acc + (r.attributes!.availability! * 100), 0)
  const avg = Math.round((sum / resources.length) * 100) / 100

  if (avg < 0 || avg > 100) {
    console.warn(`[parseBetterStackUptime] computed ${avg}% out of range — API format may have changed`)
    return null
  }
  return avg
}

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

// ── incident.io HTML Scraper — for services that migrated from Atlassian (e.g. OpenAI) ──
// The /api/v2/incidents.json compatibility endpoint returns empty update bodies.
// For active (non-resolved) incidents, scrape the incident detail page to get message_string.

interface IncidentIoUpdate {
  stage: TimelineEntry['stage']
  text: string
  at: string
}

function parseIncidentIoUpdates(html: string): IncidentIoUpdate[] {
  const results: IncidentIoUpdate[] = []
  const chunks = html.match(/self\.__next_f\.push\(\[1,([\s\S]*?)\]\)\s*<\/script/g) ?? []
  for (const chunk of chunks) {
    // Quotes inside __next_f JS strings are escaped as \" so match \\"...\\"
    const re = /\\"message_string\\":\\"((?:[^\\"\\\\]|\\\\.)*)\\",\\"published_at\\":\\"([^\\"]+)\\",\\"to_status\\":\\"([^\\"]+)\\"/g
    let m
    while ((m = re.exec(chunk)) !== null) {
      const [, rawText, at, toStatus] = m
      if (!rawText) continue
      // Unescape JS-string double-encoding (\\n → \n, \\\\ → \\, etc.)
      let text: string
      try { text = JSON.parse(`"${rawText}"`) } catch { text = rawText }
      const stage: TimelineEntry['stage'] =
        toStatus === 'resolved' ? 'resolved'
        : toStatus === 'monitoring' ? 'monitoring'
        : toStatus === 'identified' ? 'identified'
        : 'investigating'
      results.push({ stage, text, at })
    }
  }
  return results
}

// ── Incident Text KV Cache ──
// Scraped timeline text is stored per-incident so subsequent invocations skip scraping.
// KV reads do not count toward the 50-subrequest limit, so we read for every incident freely.
// Keys: inctext:{incidentId}  Values: { textByKey: {"stage:at": text|null}, cachedAt: string }
// TTL: 90 days for resolved (rarely changes after resolution), 30 min for active (may get new updates).

interface IncidentTextCache {
  textByKey: Record<string, string | null>  // key = "stage:at" (matches parseIncidents dedup key)
  cachedAt: string
}

async function readIncidentTextCache(kv: KVNamespace, incidentIds: string[]): Promise<Map<string, IncidentTextCache>> {
  const results = await Promise.all(
    incidentIds.map((id) =>
      kv.get(`inctext:${id}`).catch((err) => {
        console.error(`[inctext cache] KV read failed for ${id}:`, err instanceof Error ? err.message : err)
        return null
      })
    )
  )
  const map = new Map<string, IncidentTextCache>()
  results.forEach((raw, i) => {
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      // Runtime shape check — guards against schema changes or corrupt entries causing applyTextCache to throw
      if (parsed && typeof parsed === 'object' && typeof parsed.textByKey === 'object' && parsed.textByKey !== null) {
        map.set(incidentIds[i], parsed as IncidentTextCache)
      } else {
        console.warn(`[inctext cache] unexpected shape for incident ${incidentIds[i]} — discarding`)
      }
    } catch {
      console.warn(`[inctext cache] corrupt KV entry for incident ${incidentIds[i]} — discarding`)
    }
  })
  return map
}

function applyTextCache(inc: Incident, cache: IncidentTextCache): Incident {
  return {
    ...inc,
    timeline: inc.timeline.map((entry) => {
      if (entry.text !== null) return entry
      const cached = cache.textByKey[`${entry.stage}:${entry.at}`]
      // cached===undefined means key absent (not yet scraped); null means scraped but no text found
      return cached !== undefined ? { ...entry, text: cached } : entry
    }),
  }
}

function buildTextCache(inc: Incident): IncidentTextCache {
  const textByKey: Record<string, string | null> = {}
  for (const entry of inc.timeline) textByKey[`${entry.stage}:${entry.at}`] = entry.text
  return { textByKey, cachedAt: new Date().toISOString() }
}

// pageUrls: incidentId → direct detail page URL (from Atlassian API shortlink).
// Constructing URLs from inc.id is unreliable because incident.io Atlassian-compat IDs
// may differ from the native ULID used in detail page URLs.
async function enrichIncidentIoText(incidents: Incident[], baseUrl: string, pageUrls: Map<string, string>, kv?: KVNamespace): Promise<Incident[]> {
  // Phase 1: Apply cached text from KV for all incidents that have null-text entries.
  // KV reads do not count toward the 50 subrequest limit, so we read for all candidates freely.
  let workingIncidents = incidents
  const needsText = incidents.filter((inc) => inc.timeline.some((t) => !t.text))
  if (kv && needsText.length > 0) {
    const cacheMap = await readIncidentTextCache(kv, needsText.map((i) => i.id))
    if (cacheMap.size > 0) {
      workingIncidents = incidents.map((inc) => {
        const cached = cacheMap.get(inc.id)
        return cached ? applyTextCache(inc, cached) : inc
      })
    }
  }

  // Phase 2: Scrape incidents still missing text after cache application (up to budget=1).
  // Budget = 1 per service: 44 base requests + 6 services × 1 = 50 (at Cloudflare free tier limit).
  // Prioritise: non-resolved first (may get new updates), then most recently started.
  const toEnrich = workingIncidents
    .filter((inc) => inc.timeline.some((t) => !t.text))
    .sort((a, b) => {
      const resolvedDiff = (a.status === 'resolved' ? 1 : 0) - (b.status === 'resolved' ? 1 : 0)
      if (resolvedDiff !== 0) return resolvedDiff
      return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    })
    .slice(0, 1)

  if (toEnrich.length === 0) return workingIncidents

  const enriched = new Map<string, Incident>()
  await Promise.all(toEnrich.map(async (inc) => {
    try {
      const url = pageUrls.get(inc.id) ?? `${baseUrl}/${inc.id}`
      const res = await fetchWithTimeout(url, 5000)
      if (!res.ok) {
        console.warn(`[enrichIncidentIoText] ${inc.id} returned HTTP ${res.status}`)
        return
      }
      const html = await res.text()
      const allUpdates = parseIncidentIoUpdates(html)
      if (allUpdates.length === 0) {
        console.warn(`[enrichIncidentIoText] ${inc.id} — page fetched OK but no updates parsed (HTML structure may have changed)`)
        return
      }

      // The incident.io SSR payload may include updates from multiple incidents.
      // Scope to updates within the target incident's time window (±1h) to avoid
      // cross-incident pollution (e.g., Pinned chats entries appearing in SSO incident).
      const entryTimes = inc.timeline.map((t) => new Date(t.at).getTime())
      const windowStart = Math.min(...entryTimes) - 3_600_000
      const windowEnd   = Math.max(...entryTimes) + 3_600_000
      const updates = allUpdates.filter((u) => {
        const t = new Date(u.at).getTime()
        return t >= windowStart && t <= windowEnd
      })
      if (updates.length === 0) {
        console.warn(`[enrichIncidentIoText] ${inc.id} — ${allUpdates.length} updates found but all filtered by time window`)
        return
      }

      const STAGE_ORDER: Record<string, number> = { investigating: 0, identified: 1, monitoring: 2, resolved: 3 }
      const usedUpdateIndices = new Set<number>()

      const enrichedIncident: Incident = {
        ...inc,
        timeline: inc.timeline.map((entry) => {
          if (entry.text) return entry
          const entryMs = new Date(entry.at).getTime()
          // 1st: exact match — same stage + within 10 min (handles most cases)
          const exactIdx = updates.findIndex((u, i) =>
            !usedUpdateIndices.has(i) &&
            u.stage === entry.stage &&
            Math.abs(new Date(u.at).getTime() - entryMs) < 600_000
          )
          if (exactIdx !== -1) {
            usedUpdateIndices.add(exactIdx)
            return { ...entry, text: updates[exactIdx].text }
          }
          // 2nd: timestamp-only match within 10 min — handles stage label mismatch between
          // incident.io HTML and Atlassian-compat API (they use different status vocabularies).
          // Only allow adjacent stages (investigating↔identified, identified↔monitoring,
          // monitoring↔resolved) to avoid assigning clearly wrong text across distant stages.
          const candidates = updates
            .map((u, i) => ({ u, i }))
            .filter(({ u, i }) => {
              if (usedUpdateIndices.has(i)) return false
              const dist = Math.abs((STAGE_ORDER[entry.stage] ?? 0) - (STAGE_ORDER[u.stage] ?? 0))
              return dist <= 1 && Math.abs(new Date(u.at).getTime() - entryMs) < 600_000
            })
            .sort((a, b) => Math.abs(new Date(a.u.at).getTime() - entryMs) - Math.abs(new Date(b.u.at).getTime() - entryMs))
          if (candidates.length > 0) {
            usedUpdateIndices.add(candidates[0].i)
            return { ...entry, text: candidates[0].u.text }
          }
          return entry
        }),
      }
      enriched.set(inc.id, enrichedIncident)

      // Phase 3: Persist scraped text to KV. Must be awaited — unawaited KV writes are cancelled
      // when the Worker terminates after the response. Latency is negligible (~10-50ms) since
      // we already spent up to 5s on HTTP scraping. A single write failure is non-critical
      // (next invocation re-scrapes), but persistent failures exhaust the enrichment budget.
      // Resolved: 90-day TTL (rarely changes). Active: 30-min TTL (may receive new updates).
      if (kv) {
        const ttl = enrichedIncident.status === 'resolved' ? 90 * 86_400 : 30 * 60
        try {
          const payload = JSON.stringify(buildTextCache(enrichedIncident))
          await kv.put(`inctext:${inc.id}`, payload, { expirationTtl: ttl })
            .catch((err) => console.error(`[inctext cache] write failed for ${inc.id}:`, err))
        } catch (buildErr) {
          console.error(`[inctext cache] failed to serialize cache for ${inc.id}:`, buildErr instanceof Error ? buildErr.message : buildErr)
        }
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError'
      if (isTimeout) {
        console.error(`[enrichIncidentIoText] timeout enriching ${inc.id}`)
      } else {
        console.warn(`[enrichIncidentIoText] failed to enrich ${inc.id}:`, err instanceof Error ? err.message : err)
      }
    }
  }))

  return workingIncidents.map((inc) => enriched.get(inc.id) ?? inc)
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

      return {
        ...base,
        status: normalizeStatus(summaryData.status?.indicator ?? 'none'),
        latency: config.category === 'api' ? latency : null,
        incidents: filtered,
        ...(dailyImpact && Object.keys(dailyImpact).length > 0 ? { dailyImpact } : {}),
        calendarDays: config.statusComponentId ? 30 : 14,
        ...(uptimeValue != null ? { uptime30d: uptimeValue, uptimeSource: uptimeSrc } : {}),
      }
    } else {
      // No Statuspage API — HTTP check + optional scraping (parallel)
      // Uses fetchWithTimeout (no retry) to stay within 50-subrequest budget
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
      if (scrapeRes?.ok) {
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

      // Better Stack uptime: parse /index.json for average availability
      let betterStackUptime: number | null = null
      if (betterStackRes?.ok) {
        try {
          const bsData: BetterStackIndex = await betterStackRes.json()
          betterStackUptime = parseBetterStackUptime(bsData)
        } catch (err) {
          console.warn(`[fetchService] ${config.id} BetterStack uptime parse failed:`, err instanceof Error ? err.message : err)
        }
      }

      const filtered = filterIncidents(incidents, config)
      // For GCloud services: use ongoing incidents (unresolved) to determine status
      // instead of HTTP check against the generic status.cloud.google.com page
      const hasOngoing = config.gcloudProduct && filtered.some((i) => i.status !== 'resolved')
      const httpStatus = res.ok || res.status === 403 ? 'operational' : 'degraded'

      return {
        ...base,
        status: hasOngoing ? 'degraded' : httpStatus,
        latency: config.category === 'api' ? latency : null,
        incidents: filtered,
        calendarDays: 14,
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

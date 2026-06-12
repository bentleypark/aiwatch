// Service status fetching and parsing for all monitored AI services.

import type { Incident, ServiceStatus, ServiceComponent, ServiceConfig, DailyImpactLevel } from './types'
export type { ServiceStatus } from './types'
import { fetchWithTimeout, formatDuration, trackFetchFailure, resetFetchFailure, trackComponentMiss, resetComponentMiss, kvPut } from './utils'
import { isProbeHealthy, type ProbeSnapshot } from './probe'
import { platformStatusKey, type PlatformStatus } from './platform-monitor'
import { type StatuspageResponse, normalizeStatus, parseIncidents, parseUptimeData } from './parsers/statuspage'
import { parseIncidentIoUptime, parseIncidentIoComponentImpacts, computeUptimeFromIncidents, enrichIncidentIoText } from './parsers/incident-io'
import { type GCloudIncident, parseGCloudIncidents } from './parsers/gcloud'
import {
  AISTUDIO_ENDPOINT,
  AISTUDIO_HEADERS,
  AISTUDIO_BODY,
  AISTUDIO_COMPONENT,
  parseAistudioIncidents,
  computeDailyImpactFromIncidents,
} from './parsers/aistudio'
import { parseInstatusIncidents } from './parsers/instatus'
import { parseRssIncidents, parseXaiRssIncidents, type BetterStackIndex, parseBetterStackStatus, parseBetterStackUptime, parseBetterStackDailyImpact, parseBetterStackResolvedIds, parseBetterStackMaintenanceIds, parseBetterStackPartialCount } from './parsers/betterstack'
import { parseOnlineOrNotIncidents, parseOnlineOrNotUptime } from './parsers/onlineornot'
import { parseAwsRssIncidents, deriveAwsStatus } from './parsers/aws'

export const SERVICES: ServiceConfig[] = [
  // AI API Services
  { id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json', incidentExclude: ['claude.ai', 'claude code', 'claude desktop', 'cowork'], statusComponent: 'Claude API', statusComponentId: 'k8w3r06qmzrp' },
  { id: 'openai', name: 'OpenAI API', provider: 'OpenAI', category: 'api', statusUrl: 'https://status.openai.com', apiUrl: 'https://status.openai.com/api/v2/summary.json', incidentExclude: ['chatgpt', 'excel plugin', 'gpts', 'voice mode', 'deep research', 'pinned', 'sora', 'sign-in', 'login', 'conversation', 'workspaces', 'logged out', 'codex', 'support chat', 'file', 'download', 'preview', 'upload', 'project files'], incidentIoBaseUrl: 'https://status.openai.com/incidents', incidentIoComponentId: '01JMXBRMFE6N2NNT7DG6XZQ6PW', incidentIoGroupId: '01K5H8S53SY1KMS4GQMNMQM1K5', incidentKeywords: ['api', 'us-east-1', 'us-west-2', 'eu-central-1'] },
  { id: 'gemini', name: 'Gemini API', provider: 'Google', category: 'api', statusUrl: 'https://aistudio.google.com/status', apiUrl: null, gcloudProduct: 'Vertex Gemini API', gcloudProductId: 'Z0FZJAMvEB4j3NbCJs6B', aistudioStatus: true, incidentKeywords: ['vertex', 'gemini', 'us-central1', 'europe-west1', 'asia-northeast1'] },
  { id: 'bedrock', name: 'Amazon Bedrock', provider: 'AWS', category: 'api', statusUrl: 'https://health.aws.amazon.com/health/status', apiUrl: null, awsRssUrls: [
    'https://status.aws.amazon.com/rss/bedrock-us-east-1.rss',
    'https://status.aws.amazon.com/rss/bedrock-us-west-2.rss',
    'https://status.aws.amazon.com/rss/bedrock-eu-west-1.rss',
    'https://status.aws.amazon.com/rss/bedrock-ap-northeast-1.rss',
  ] },
  { id: 'azureopenai', name: 'Azure OpenAI', provider: 'Microsoft', category: 'api', statusUrl: 'https://azure.status.microsoft/en-us/status', apiUrl: null, azureRssUrl: 'https://rssfeed.azure.status.microsoft/en-us/status/feed/', incidentKeywords: ['Azure OpenAI'] },
  { id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', category: 'api', statusUrl: 'https://status.mistral.ai', apiUrl: null, instatusUrl: 'https://status.mistral.ai/incidents/page/1' },
  // displayAllComponents (#606): per-model statuspage — show every model/surface except Docs/Website
  // (dynamic, so new/retired models need no config edit). componentSurfaces stay as individual rows;
  // the rest fold into a collapsible "Models" group (matches the official Endpoints/Models split).
  { id: 'cohere', name: 'Cohere API', provider: 'Cohere', category: 'api', statusUrl: 'https://status.cohere.com', apiUrl: 'https://status.cohere.com/api/v2/summary.json', incidentIoBaseUrl: 'https://status.cohere.com/incidents', incidentIoComponentId: '01HQ6CA39NZ5X3PRFPN71Q89TE', displayAllComponents: true, componentDenylist: ['Docs', 'Website'], componentSurfaces: ['Coral', 'Infrastructure', 'Playground', 'embeddings'] },
  { id: 'groq', name: 'Groq Cloud', provider: 'Groq', category: 'api', statusUrl: 'https://groqstatus.com', apiUrl: 'https://groqstatus.com/api/v2/summary.json', incidentIoBaseUrl: 'https://groqstatus.com/incidents', incidentIoComponentId: '01K053E2FAKWKEYHXEV7WAHJBM', displayAllComponents: true, componentDenylist: ['Docs', 'Website'], componentSurfaces: ['API'] },
  { id: 'together', name: 'Together AI', provider: 'Together', category: 'api', statusUrl: 'https://status.together.ai', apiUrl: null, rssFeedUrl: 'https://status.together.ai/feed', betterStackUrl: 'https://status.together.ai', flapSuppression: true },
  { id: 'fireworks', name: 'Fireworks AI', provider: 'Fireworks', category: 'api', statusUrl: 'https://status.fireworks.ai', apiUrl: null, rssFeedUrl: 'https://status.fireworks.ai/feed', betterStackUrl: 'https://status.fireworks.ai', flapSuppression: true },
  // Cerebras Inference (#391) — Atlassian Statuspage, 5 components: 4 model surfaces + Developer Console.
  // Multi-component worst-of (#379): statusComponentIds lists all 5 so any degraded model degrades the
  // service; statusComponentId (Developer Console) is the primary for uptime parsing / calendar /
  // component-miss alerting. Single-tenant page → no incidentKeywords needed.
  { id: 'cerebras', name: 'Cerebras Inference', provider: 'Cerebras', category: 'api', statusUrl: 'https://status.cerebras.ai', apiUrl: 'https://status.cerebras.ai/api/v2/summary.json', statusComponentId: '83h1cchw4vs4', statusComponentIds: ['83h1cchw4vs4', '7xvps6c9lqwc', 'bhqw2gr7r710', 'hgfykfsb36gn', '8ygyx5vydlm2'] },
  { id: 'perplexity', name: 'Perplexity', provider: 'Perplexity AI', category: 'api', statusUrl: 'https://status.perplexity.com', apiUrl: null, instatusUrl: 'https://status.perplexity.com' },
  { id: 'xai', name: 'xAI (Grok)', provider: 'xAI', category: 'api', statusUrl: 'https://status.x.ai', apiUrl: null, rssFeedUrl: 'https://status.x.ai/feed.xml', incidentKeywords: ['api'], incidentExclude: ['[API Console]', 'Test+Incident'] },
  // status.deepseek.com blocks Cloudflare Workers IPs (SSL reset); deepseek.statuspage.io is the
  // Atlassian-hosted mirror that's accessible from Workers — same component IDs, same data (#498).
  // #591/#507 — that mirror FROZE at 2026-05-08 (DeepSeek migrated to Flashduty, unreachable
  // server-side); it still returns 200 with stale data, so the feed reads as current but isn't.
  // `incidentSourceStale` excludes it from all Score rankings until the feed is reachable again.
  { id: 'deepseek', name: 'DeepSeek API', provider: 'DeepSeek', category: 'api', statusUrl: 'https://status.deepseek.com', apiUrl: 'https://deepseek.statuspage.io/api/v2/summary.json', statusComponentId: 'j4n367d9mh3x', incidentKeywords: ['api'], incidentSourceStale: true },
  { id: 'openrouter', name: 'OpenRouter', provider: 'OpenRouter', category: 'api', statusUrl: 'https://status.openrouter.ai', apiUrl: null, onlineOrNotUrl: 'https://status.openrouter.ai', onlineOrNotComponent: 'Chat (/api/v1/chat/completions)' },
  // Voice & Speech AI
  // displayComponentIds (#606): curated availability surfaces for the breakdown card —
  // TTS, STT, Conversations, RAG, Telephony, Other API endpoints (excludes UI/Quality/ElevenCreative/Other).
  // Display-only: badge stays on the overall page indicator (no statusComponentIds).
  { id: 'elevenlabs', name: 'ElevenLabs', provider: 'ElevenLabs', category: 'api', statusUrl: 'https://status.elevenlabs.io', apiUrl: 'https://status.elevenlabs.io/api/v2/summary.json', incidentIoBaseUrl: 'https://status.elevenlabs.io/incidents', incidentIoComponentId: '01JP2RQVGDHPEEDAFM5KV2MH9P', incidentExclude: ['webpage'], displayComponentIds: ['01JP2RQVGDHPEEDAFM5KV2MH9P', '01JYDTNNSJBT4X90MAC47YPM9S', '01JY3H5SJJZNC33AYMAE4SK4TH', '01JY3H5SJJD2BMSGSW5FZE08ST', '01JY3H5SJJJG47J60JPKX882H8', '01JY3H5SJJFKTXYQHG5A8Z1KYH'] },
  { id: 'assemblyai', name: 'AssemblyAI', provider: 'AssemblyAI', category: 'api', statusUrl: 'https://status.assemblyai.com', apiUrl: 'https://status.assemblyai.com/api/v2/summary.json', statusComponentId: '50txf4qfk2kv' },
  { id: 'deepgram', name: 'Deepgram', provider: 'Deepgram', category: 'api', statusUrl: 'https://status.deepgram.com', apiUrl: 'https://status.deepgram.com/api/v2/summary.json', statusComponentId: 'cv8l6gg3cb9d' },
  // Inference / Infrastructure
  { id: 'huggingface', name: 'Hugging Face', provider: 'Hugging Face', category: 'api', statusUrl: 'https://status.huggingface.co', apiUrl: null, rssFeedUrl: 'https://status.huggingface.co/feed', betterStackUrl: 'https://status.huggingface.co', flapSuppression: true },
  // displayComponentIds (#606): curated API/product surfaces — HTTP API, Streaming API, Registry,
  // Official Models, Playground (excludes Billing/Support/Home Page/Hardware×5). Display-only.
  { id: 'replicate', name: 'Replicate', provider: 'Replicate', category: 'api', statusUrl: 'https://www.replicatestatus.com', apiUrl: 'https://www.replicatestatus.com/api/v2/summary.json', incidentIoBaseUrl: 'https://www.replicatestatus.com/incidents', incidentIoComponentId: '01JRJYHBWCXHFZ0NHMP1N7T2G3', displayComponentIds: ['01JRJYHBWCXHFZ0NHMP1N7T2G3', '01JRJYHBWC358ZXKRXZD0BENPD', '01JXJT0JC265GZN0BAJ446XBD2', '01JS0AB43BGQC1H06HKGPHP1F2', '01J5NNACBNTG5GR693P6RH5Q6J'] },
  { id: 'pinecone', name: 'Pinecone', provider: 'Pinecone', category: 'api', statusUrl: 'https://status.pinecone.io', apiUrl: 'https://status.pinecone.io/api/v2/summary.json', statusComponentId: 'r7tngp2p3sjd' },
  { id: 'stability', name: 'Stability AI', provider: 'Stability AI', category: 'api', statusUrl: 'https://status.stability.ai', apiUrl: 'https://status.stability.ai/api/v2/summary.json', incidentIoBaseUrl: 'https://status.stability.ai/incidents', incidentIoComponentId: '01JW9J39X55NDFZTZT3K5NYR48' },
  { id: 'voyageai', name: 'Voyage AI', provider: 'Voyage AI', category: 'api', statusUrl: 'https://voyageai-status.statuspage.io', apiUrl: 'https://voyageai-status.statuspage.io/api/v2/summary.json', statusComponentId: 'g74wmxgm0zxr' },
  { id: 'modal', name: 'Modal', provider: 'Modal', category: 'api', statusUrl: 'https://status.modal.com', apiUrl: null, rssFeedUrl: 'https://status.modal.com/feed', betterStackUrl: 'https://status.modal.com', flapSuppression: true },
  // LangSmith (#561) — LangChain's hosted observability/eval platform. incident.io page exposes a
  // statuspage v2-compatible API so statuspage.ts covers it. Multi-component worst-of (#379): badge
  // tracks the three load-bearing surfaces (Run Ingestion + API + Application); the other components
  // (Billing, Sandboxes, Bulk Exports, PromptHub, Fleet, Deployments Data/Control Plane) are excluded
  // so non-availability blips don't flip the badge. Single-tenant (dedicated) page → no
  // incidentKeywords needed. is-down slug is 'langchain' (see slug-map.ts / rss.ts).
  // Official 30-day uptime comes from the incident.io `component_uptimes` of the API component
  // (incidentIoComponentId, 98.48%-class) — NOT the statuspage uptime-showcase (incident.io pages
  // don't emit it) — so without this the resolver would fall through to null ("Not provided"). The
  // API surface is the developer-facing one and tracks the real incident activity; Run Ingestion
  // reads ~100% despite the incidents, so it would understate. That API component is also
  // statusComponentIds[1], so it doubles as one of the three worst-of badge inputs AND (via
  // incidentIoComponentId) the source of official uptime + calendar impact + text enrichment.
  { id: 'langsmith', name: 'LangChain (LangSmith)', provider: 'LangChain', category: 'api', statusUrl: 'https://status.smith.langchain.com', apiUrl: 'https://status.smith.langchain.com/api/v2/summary.json', statusComponentId: '01JT46QKH7HC0HA6RHD82GQYME', statusComponentIds: ['01JT46QKH7HC0HA6RHD82GQYME', '01JT46QKH7CWH1K3K3CAVMSQ7E', '01JT46QKH7PSQYR4CKSVXJ7PHS'], incidentIoBaseUrl: 'https://status.smith.langchain.com/incidents', incidentIoComponentId: '01JT46QKH7CWH1K3K3CAVMSQ7E' },
  // Runway (#393) — hosted generative-video AI (Gen-4 / Act-Two), AIWatch's first video provider. Native
  // Atlassian Statuspage (page s9lfdrzmhryw) → statuspage.ts covers it, no new parser. Multi-component
  // worst-of (#379): badge tracks the three availability surfaces (Public API + App + Backend); Billing +
  // Support are excluded so non-availability blips don't flip the badge. Single-tenant page → no
  // incidentKeywords. Probe-less (API requires auth). is-down slug == id ('runway'), so no slug override.
  // Lumped under `inference` for now (avoid a single-member video category until Luma/Pika are added).
  { id: 'runway', name: 'Runway', provider: 'Runway', category: 'api', statusUrl: 'https://status.runwayml.com', apiUrl: 'https://status.runwayml.com/api/v2/summary.json', statusComponentId: 'w3jcq3dwljp4', statusComponentIds: ['w3jcq3dwljp4', '2fr8tksxj5ns', 'hl94rh0mg6xt'] },
  // Luma / Dream Machine (#602, #601 Phase 1) — generative-video AI (Dream Machine, Ray, UNI-1), added
  // as a Runway sibling. Better Stack status page (status.lumalabs.ai) → betterstack.ts parser via
  // rssFeedUrl (incidents) + betterStackUrl /index.json (status + uptime). flapSuppression: true — the
  // page auto-emits "X went down/recovered/degraded" model blips (#283/#597). Video-native, so no
  // component scoping needed. is-down slug == id ('luma'). Probe-less (API auth-gated).
  { id: 'luma', name: 'Luma (Dream Machine)', provider: 'Luma', category: 'api', statusUrl: 'https://status.lumalabs.ai', apiUrl: null, rssFeedUrl: 'https://status.lumalabs.ai/feed', betterStackUrl: 'https://status.lumalabs.ai', flapSuppression: true },
  // AI Apps
  { id: 'claudeai', name: 'claude.ai', provider: 'Anthropic', category: 'app', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json', incidentKeywords: ['claude.ai', 'across surfaces', 'claude desktop'], statusComponent: 'claude.ai', statusComponentId: 'rwppv331jlwc' },
  { id: 'characterai', name: 'Character.AI', provider: 'Character AI', category: 'app', statusUrl: 'https://status.character.ai', apiUrl: 'https://status.character.ai/api/v2/summary.json', statusComponentId: 'fw8g76r7dqcl' },
  // ChatGPT has no single umbrella status-page component, but status.openai.com
  // does publish a ChatGPT group aggregate over its sub-components — that's the
  // user-facing uptime number on the page. Status determination still uses the
  // overall indicator + incidentKeywords filter with the "no relevant unresolved
  // incidents → operational" cross-contamination guard (#292); the new
  // incidentIoComponentId / incidentIoGroupId pair only feeds parseIncidentIoUptime
  // (#367), not the status path. Component fallback is Conversations
  // (01JMXBNJXGV1T5GT2M9XA83XNG, 99.92% sample) — not perfect coverage but a
  // reasonable proxy if OpenAI ever restructures the ChatGPT group.
  { id: 'chatgpt', name: 'ChatGPT', provider: 'OpenAI', category: 'app', statusUrl: 'https://status.openai.com', apiUrl: 'https://status.openai.com/api/v2/summary.json', incidentKeywords: ['chatgpt', 'conversation', 'login', 'pinned', 'file', 'download', 'upload', 'us-east-1', 'us-west-2', 'eu-central-1'], incidentIoBaseUrl: 'https://status.openai.com/incidents', incidentIoComponentId: '01JMXBNJXGV1T5GT2M9XA83XNG', incidentIoGroupId: '01K5H8S53SY1KMS4GQMNMZXTR1' },
  // Coding Agents
  // claudecode intentionally tracks only the Claude Code component for the badge.
  // Adding Claude API as a multi-component dependency would conflict with the
  // existing `incidentKeywords` filter (`['claude code', 'across surfaces']`):
  // an API-only incident would flip the badge to degraded but be dropped from
  // the visible incident list, leaving users staring at a degraded card with no
  // explanation. Track only Claude Code here; users see Claude API outages on
  // the separate `claude` (Claude API) card. See #379 for the multi-component
  // pattern and the review trade-off that kept claudecode single-component.
  { id: 'claudecode', name: 'Claude Code', provider: 'Anthropic', category: 'agent', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json', incidentKeywords: ['claude code', 'across surfaces'], statusComponent: 'Claude Code', statusComponentId: 'yyzkbfz2thpt' },
  // OpenAI Codex (coding agent): published across 4 distinct surface components on
  // status.openai.com (Codex Web / Codex API / CLI / VS Code extension) with a
  // Codex group aggregate over all four. Same #292 pattern as chatgpt — overall
  // indicator + incidentKeywords filter, cross-contamination guard in fetchService
  // blocks OpenAI API / ChatGPT incidents from bleeding through.
  //
  // Uptime source: Codex group aggregate (#367 — '01KMKF9EBTCD8BN9PG8DJZXRSQ').
  // Matches what OpenAI publishes on status.openai.com. The original #301 scoping
  // to the Codex API component alone produced 100% while OpenAI's published Codex
  // group sat at 99.98%; the dashboard now mirrors what users see upstream.
  // incidentIoComponentId stays set to Codex API as a fallback — if the group
  // ID becomes invalid, the parser falls through to the per-component lookup
  // rather than returning null. Surface-specific outages (e.g., Codex Web only)
  // still surface via incidentKeywords in Recent Incidents.
  { id: 'codex', name: 'Codex', provider: 'OpenAI', category: 'agent', statusUrl: 'https://status.openai.com', apiUrl: 'https://status.openai.com/api/v2/summary.json', incidentKeywords: ['codex', 'cli', 'vs code'], incidentIoBaseUrl: 'https://status.openai.com/incidents', incidentIoComponentId: '01KMP3KP5MGE23B80K1EK4S8PV', incidentIoGroupId: '01KMKF9EBTCD8BN9PG8DJZXRSQ' },
  // cursor badge reflects worst-of: IDE primary + Cloud Agents + Automations + CLI (#379).
  // Bugbot/cursor.com/Marketplace are auxiliary surfaces and intentionally excluded.
  { id: 'cursor', name: 'Cursor', provider: 'Anysphere', category: 'agent', statusUrl: 'https://status.cursor.com', apiUrl: 'https://status.cursor.com/api/v2/summary.json', statusComponentId: 'rflc60xp5jp2', statusComponentIds: ['rflc60xp5jp2', 'mwv1g9sc7kdh', 'k0trcq273dr6', 'vsny1qv7v86c'] },
  // copilot badge reflects worst-of: Copilot + Copilot AI Model Providers (direct upstream) (#379).
  { id: 'copilot', name: 'GitHub Copilot', provider: 'Microsoft', category: 'agent', statusUrl: 'https://githubstatus.com', apiUrl: 'https://www.githubstatus.com/api/v2/summary.json', statusComponentId: 'pjmpxvq2cmr2', statusComponentIds: ['pjmpxvq2cmr2', 'cnnb39dkkk82'], incidentKeywords: ['copilot'] },
  // windsurf badge reflects worst-of: Cascade primary + Windsurf Tab (autocomplete agent surface) (#379).
  { id: 'windsurf', name: 'Windsurf', provider: 'Codeium', category: 'agent', statusUrl: 'https://status.windsurf.com', apiUrl: 'https://status.windsurf.com/api/v2/summary.json', statusComponentId: 'r5wf1ykd7y1m', statusComponentIds: ['r5wf1ykd7y1m', '8q19cygxvshj'] },
  { id: 'junie', name: 'Junie', provider: 'JetBrains', category: 'agent', statusUrl: 'https://status.jetbrains.ai', apiUrl: 'https://status.jetbrains.ai/api/v2/summary.json', statusComponentId: '9vbyyqkkjxl4' },
]

/**
 * Merge aistudio incidents into the primary (vertex) list for gemini (#310).
 * Never throws: HTTP errors, invalid JSON, and parser exceptions all fall
 * back silently to the primary list and increment `parseErrors` so the
 * fetch-failure counter can degrade the service after repeated failures.
 * Response body is cancelled on every non-consumed path.
 */
export async function mergeAistudioIncidents(
  primary: Incident[],
  aistudioRes: Response,
  serviceId: string,
): Promise<{ incidents: Incident[]; merged: number; parseErrors: number }> {
  const cancelBody = () => {
    aistudioRes.body?.cancel().catch((e) =>
      console.warn(`[fetchService] ${serviceId} aistudio body cancel failed:`, e),
    )
  }
  if (!aistudioRes.ok) {
    console.warn(`[fetchService] ${serviceId} aistudio HTTP ${aistudioRes.status}`)
    cancelBody()
    return { incidents: primary, merged: 0, parseErrors: 0 }
  }
  try {
    const raw = await aistudioRes.json()
    const extras = parseAistudioIncidents(raw, {
      componentFilter: [AISTUDIO_COMPONENT.API],
    })
    // Cross-source audit trail (helps diagnose divergence / shape drift in tail logs)
    if (primary.length > 0 || extras.length > 0) {
      console.info(`[${serviceId}] merged vertex=${primary.length} aistudio=${extras.length}`)
    }
    return { incidents: [...primary, ...extras], merged: extras.length, parseErrors: 0 }
  } catch (err) {
    console.warn(
      `[fetchService] ${serviceId} aistudio parse failed:`,
      err instanceof Error ? err.message : err,
    )
    cancelBody()
    return { incidents: primary, merged: 0, parseErrors: 1 }
  }
}

type NormalizedStatus = 'operational' | 'degraded' | 'down'
const STATUS_RANK: Record<NormalizedStatus, number> = { operational: 0, degraded: 1, down: 2 }

/**
 * Pick the worst status across multiple components (down > degraded > operational).
 * Used for `statusComponentIds` multi-component badge resolution: when any tracked
 * surface is degraded, the service's badge reflects the worst case.
 */
// #606 — group label applied to non-surface components in displayAllComponents mode.
// Flows through as ServiceComponent.group; the UI collapses same-group components under it.
export const MODEL_GROUP = 'Models'

export function worstStatus(statuses: NormalizedStatus[]): NormalizedStatus {
  return statuses.reduce<NormalizedStatus>(
    (worst, s) => (STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst),
    'operational',
  )
}

// Loose shape used by resolveSvcStatus so the same function can serve both the
// production fetchService loop (where summaryData is StatuspageResponse) and
// tests (where it's a hand-rolled fixture). Only the fields actually read are
// declared — adding StatuspageResponse here would force the test to import
// types from a parser module unnecessarily.
type StatusResolverSummary = {
  status?: { indicator?: string } | null
  components?: Array<{ id: string; name: string; status: string }>
}
type StatusResolverConfig = Pick<ServiceConfig, 'statusComponent' | 'statusComponentId' | 'statusComponentIds' | 'displayComponentIds' | 'displayAllComponents' | 'componentDenylist' | 'componentSurfaces'>

/**
 * Resolve a service's overall badge status from its config + status page summary.
 *
 * **Single source of truth** — production (`fetchService` loop) and the
 * status-determination unit tests both call this directly so the test mirror
 * cannot drift from the runtime logic.
 *
 * Branch order (each step is taken only if the prior didn't return):
 *   1. **No component configured** — fall back to overall page indicator, but
 *      if every matching incident is resolved, claim `operational` to suppress
 *      cross-contamination from sibling services on shared status pages
 *      (e.g. an OpenAI-API-only incident must not flip ChatGPT to degraded).
 *   2. **`statusComponentIds` worst-of (#379)** — when configured AND non-empty
 *      AND `components` is present, pick the worst normalized status across
 *      the resolved subset (`down > degraded > operational`). If none of the
 *      configured ids resolve in the page's components (drift), fall back to
 *      the overall indicator; the separate component-miss alert path picks
 *      the drift up so operators can reconcile.
 *   3. **Single-component** (`statusComponent` name-prefix match OR
 *      `statusComponentId` exact match) — use that component's status; fall
 *      back to overall if neither matches.
 */
export function resolveSvcStatus(
  config: StatusResolverConfig,
  summaryData: StatusResolverSummary,
  filtered: Array<{ status: string }>,
): NormalizedStatus {
  const overall = normalizeStatus(summaryData.status?.indicator ?? 'none')
  if (!config.statusComponent && !config.statusComponentId && !config.statusComponentIds) {
    if (overall !== 'operational' && filtered.filter((i) => i.status !== 'resolved').length === 0) {
      return 'operational'
    }
    return overall
  }
  if (config.statusComponentIds && config.statusComponentIds.length > 0 && summaryData.components) {
    const matched = config.statusComponentIds
      .map((id) => summaryData.components!.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => c != null)
    if (matched.length > 0) {
      return worstStatus(matched.map((c) => normalizeStatus(c.status)))
    }
    return overall
  }
  const comp = config.statusComponent
    ? summaryData.components?.find((c) => c.name.startsWith(config.statusComponent!))
    : summaryData.components?.find((c) => c.id === config.statusComponentId)
  return comp ? normalizeStatus(comp.status) : overall
}

/**
 * Resolve the curated per-component snapshot for the #604 breakdown — the *display*
 * counterpart to the worst-of: `resolveSvcStatus` collapses the `statusComponentIds`
 * subset into one badge; this preserves each matched component (same availability-relevant
 * set) with its own normalized status, in the configured order.
 *
 * Component source, in precedence order:
 *   1. `displayAllComponents` (#606 cohere/groq) — DYNAMIC: every page component except
 *      `componentDenylist` names (case-insensitive). For per-model statuspages where a
 *      hardcoded id list would go stale; the UI collapses the long list. Takes precedence.
 *   2. `displayComponentIds ?? statusComponentIds` (#606/#604) — an explicit curated allowlist
 *      (display-only, decoupled from the badge) or the multi-component badge ids reused.
 *
 * Self-gates to the display rule: returns the matched subset ONLY when **≥2** components
 * resolve, else `[]`. A single row is redundant with the badge, so the ≥2 gate lives
 * here (not at the caller) — there is exactly one consumer (the `components` field), so
 * folding the rule in keeps it a single pure, fully-testable unit.
 *
 * Returns `[]` when: no component source configured, no page `components`, fewer than 2
 * components resolve (incl. status-page drift), or none resolve.
 */
export function resolveSvcComponents(
  config: StatusResolverConfig,
  summaryData: StatusResolverSummary,
): ServiceComponent[] {
  if (!summaryData.components) return []

  // 1. Dynamic mode — all components minus the (small, stable) denylist by name. Each
  // non-surface component is tagged `group: 'Models'` so the UI collapses them under one
  // header (#606); `componentSurfaces` names stay ungrouped as individual rows.
  if (config.displayAllComponents) {
    const deny = new Set((config.componentDenylist ?? []).map((n) => n.toLowerCase()))
    const surfaces = new Set((config.componentSurfaces ?? []).map((n) => n.toLowerCase()))
    const matched = summaryData.components
      .filter((c) => !deny.has(c.name.toLowerCase()))
      .map((c) => ({
        id: c.id,
        name: c.name,
        status: normalizeStatus(c.status),
        ...(surfaces.has(c.name.toLowerCase()) ? {} : { group: MODEL_GROUP }),
      }))
    return matched.length >= 2 ? matched : []
  }

  // 2. Explicit id allowlist (displayComponentIds) or reused badge ids (statusComponentIds).
  const ids = config.displayComponentIds ?? config.statusComponentIds
  if (!ids || ids.length === 0) return []
  const matched = ids
    .map((id) => summaryData.components!.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => c != null)
    .map((c) => ({ id: c.id, name: c.name, status: normalizeStatus(c.status) }))
  // ≥2 only — a one-row breakdown adds nothing the badge doesn't already say.
  return matched.length >= 2 ? matched : []
}

export function filterIncidents(incidents: Incident[], config: ServiceConfig): Incident[] {
  const { incidentKeywords, incidentExclude } = config
  return incidents.filter((inc) => {
    const title = inc.title.toLowerCase()
    if (incidentExclude?.some((kw) => title.includes(kw.toLowerCase()))) {
      // Bypass exclude when the incident explicitly lists this service's component.
      // Prevents e.g. "claude.ai and API unavailable" from being dropped from the
      // Claude API service just because the title matches the 'claude.ai' exclude
      // pattern (#357).
      if (config.statusComponent) {
        const compLower = config.statusComponent.toLowerCase()
        const incCompNames = (inc.componentNames ?? []).map((n) => n.toLowerCase())
        if (incCompNames.some((n) => n.startsWith(compLower))) return true
      }
      return false
    }
    // aistudio incidents are component-filtered at the parser (components: [API])
    // so the keyword filter — designed to disambiguate the shared gcloud Vertex
    // feed — doesn't apply and would drop legitimate Gemini events whose titles
    // don't mention "gemini" (e.g. "Batch API outage", "File API document
    // processing outage"). See #310.
    if (inc.id.startsWith('aistudio:')) return true
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

/**
 * Filter out active incidents when the service's component is operational (#228).
 * Providers like Anthropic bulk-link incidents to all components even when only one is affected.
 * If this service's component is operational, remove unresolved incidents to prevent cross-contamination.
 */
export function filterByComponentStatus(incidents: Incident[], componentStatus: string, config: ServiceConfig): Incident[] {
  if (componentStatus !== 'operational') return incidents
  if (!config.statusComponentId && !config.statusComponent) return incidents
  return incidents.filter(i => i.status === 'resolved' || i.status === 'monitoring')
}

/**
 * Include untagged incidents when keyword-filtered service has no active incidents
 * but the service's status is non-operational. Checks component-specific status when
 * available to prevent cross-contamination (e.g., API incident on ChatGPT).
 */
export function includeUntaggedIncidents(
  filtered: Incident[],
  allIncidents: Incident[],
  config: ServiceConfig,
  components: Array<{ id: string; name: string; status: string }>,
  overallIndicator: string,
): Incident[] {
  if (filtered.some((i) => i.status !== 'resolved')) return filtered
  if (!config.incidentKeywords || config.incidentKeywords.length === 0) return filtered

  // Use component-specific status when available, otherwise overall page status
  const comp = config.statusComponent
    ? components?.find((c) => c.name.startsWith(config.statusComponent!))
    : config.statusComponentId
      ? components?.find((c) => c.id === config.statusComponentId)
      : null
  const svcStatus = comp
    ? normalizeStatus(comp.status)
    : normalizeStatus(overallIndicator)
  if (svcStatus === 'operational') return filtered

  const untagged = allIncidents.filter((inc) =>
    inc.status !== 'resolved' &&
    (inc.componentNames ?? []).length === 0 &&
    !config.incidentExclude?.some((kw) => inc.title.toLowerCase().includes(kw.toLowerCase()))
  )
  return [...filtered, ...untagged].sort((a, b) =>
    new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  )
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
  let parseErrors = 0 // Track internal parse/fetch failures — prevents resetFetchFailure from masking repeated errors
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
    // #591 — propagated from config to every return path (all spread `...base`), so a stale-source
    // service is flagged regardless of which fetch branch produces its status.
    ...(config.incidentSourceStale ? { incidentSourceStale: true } : {}),
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
          fetchWithRetry(`${baseUrl}/incidents.json`).catch((err) => { console.warn(`[fetchService] ${config.id} incidents.json failed:`, err.message); parseErrors++; return null }),
        ])
        latency = Date.now() - start
        if (!summaryRes.ok) {
          console.error(`[fetchService] ${config.id} summary.json returned HTTP ${summaryRes.status}`)
          summaryRes.body?.cancel()
          incidentsRes?.body?.cancel()
          const shouldDegrade = await trackFetchFailure(kv, config.id)
          return { ...base, status: shouldDegrade ? 'degraded' : 'operational' }
        }
        summaryData = await summaryRes.json()
        if (incidentsRes?.ok) {
          rawIncData = await incidentsRes.json()
        } else {
          if (incidentsRes) console.warn(`[fetchService] ${config.id} incidents.json returned HTTP ${incidentsRes.status}`)
          incidentsRes?.body?.cancel()
          rawIncData = null
        }
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

      // Compute svcStatus BEFORE includeUntaggedIncidents so the
      // cross-contamination guard (#361) can suppress untagged-include for
      // services on shared status pages whose keyword filter found nothing.
      // Without this ordering, an untagged ChatGPT-only incident on
      // status.openai.com leaks into Codex's filtered set: filterIncidents
      // (correctly) drops it, then includeUntaggedIncidents adds it back
      // because Codex has no statusComponent/Id and the page overall is
      // non-operational. Computing svcStatus first lets the no-component
      // branch detect the empty-filtered case and treat the service as
      // operational, suppressing untagged-include entirely.
      const svcStatus = resolveSvcStatus(config, summaryData, filtered)

      // Only fall back to untagged-include when this service is genuinely
      // non-operational. Operational services per the cross-contamination
      // guard above cannot legitimately have untagged incidents to surface.
      if (svcStatus !== 'operational') {
        filtered = includeUntaggedIncidents(filtered, incidents, config, summaryData.components ?? [], summaryData.status?.indicator ?? 'none')
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
        const ioUptime = parseIncidentIoUptime(prefetched.uptimeHtml, config.incidentIoComponentId, config.incidentIoGroupId)
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

      // Filter out active incidents when component is operational (#228)
      filtered = filterByComponentStatus(filtered, svcStatus, config)

      // Track component ID misses for migration detection (#135).
      // Primary statusComponentId drives the alerted-on tracker. Additional ids
      // from statusComponentIds (#379) are warn-logged so operators can reconcile
      // without triggering Discord alerts that would fire repeatedly per surface.
      if (config.statusComponentId && summaryData.components) {
        const compFound = summaryData.components.some((c) => c.id === config.statusComponentId)
        if (!compFound) {
          const available = summaryData.components.map((c) => `${c.id}:${c.name}`).join(', ')
          console.warn(`[fetchService] Component ID not found: ${config.id} (${config.statusComponentId}). Available: ${available}`)
          await trackComponentMiss(kv, config.id)
        } else {
          await resetComponentMiss(kv, config.id)
        }
      }
      if (config.statusComponentIds && summaryData.components) {
        const missing = config.statusComponentIds.filter(
          (id) => id !== config.statusComponentId && !summaryData.components!.some((c) => c.id === id),
        )
        if (missing.length > 0) {
          console.warn(`[fetchService] ${config.id} additional component ids missing: ${missing.join(', ')}`)
        }
      }
      // #606 — same drift signal for the display-only breakdown list. These services have
      // no statusComponentId/Ids, so without this a renamed/removed curated component would
      // silently shrink the breakdown card (or drop it under the ≥2 gate) with no operator signal.
      if (config.displayComponentIds && summaryData.components) {
        const missing = config.displayComponentIds.filter(
          (id) => !summaryData.components!.some((c) => c.id === id),
        )
        if (missing.length > 0) {
          console.warn(`[fetchService] ${config.id} displayComponentIds missing (breakdown drift): ${missing.join(', ')}`)
        }
      }
      // Augment dailyImpact with ongoing incidents (source data only includes resolved).
      // Only when the service itself is non-operational, to avoid marking the calendar
      // for unrelated incidents that survived the filters but don't affect this component.
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

      // Successful fetch — reset or track based on parse errors
      if (parseErrors > 0) {
        console.warn(`[fetchService] ${config.id} completed with ${parseErrors} parse error(s)`)
        await trackFetchFailure(kv, config.id)
      } else {
        await resetFetchFailure(kv, config.id)
      }

      // #604 — preserve the curated per-component snapshot for the breakdown UI.
      // resolveSvcComponents self-gates to ≥2 matched (a single component is redundant with the badge).
      const components = resolveSvcComponents(config, summaryData)

      return {
        ...base,
        status: svcStatus,
        latency: config.category === 'api' ? latency : null,
        incidents: filtered,
        ...(components.length > 0 ? { components } : {}),
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
                res.body?.cancel()
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
        // Uptime semantics — match the main incident.io path (line 326):
        //   - 0 incidents → 100% (RSS confirmed reachable, no measurable outage)
        //   - >0 incidents but all unparseable → null (omit uptime30d to avoid claiming 100%)
        //   - otherwise → computed weighted uptime
        const uptimeRaw = computeUptimeFromIncidents(filtered)
        const uptimeEst = filtered.length === 0 ? 100 : uptimeRaw
        return {
          ...base,
          status: deriveAwsStatus(filtered),
          latency: config.category === 'api' ? latency : null,
          incidents: filtered,
          calendarDays: 14,
          ...(uptimeEst != null ? { uptime30d: uptimeEst, uptimeSource: 'estimate' as const } : {}),
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
          if (rssRes) { console.warn(`[fetchService] ${config.id} Azure RSS HTTP ${rssRes.status}`); rssRes.body?.cancel() }
          const shouldDegrade = await trackFetchFailure(kv, config.id)
          return { ...base, status: shouldDegrade ? 'degraded' : 'operational', incidents: [], latency: config.category === 'api' ? latency : null }
        }
        await resetFetchFailure(kv, config.id)
        const incidents = parseAwsRssIncidents(await rssRes.text())
        const filtered = filterIncidents(incidents, config)
        // Same uptime semantics as the AWS RSS path above — propagate null instead of
        // silently claiming 100% when all incidents were unparseable.
        const uptimeRaw = computeUptimeFromIncidents(filtered)
        const uptimeEst = filtered.length === 0 ? 100 : uptimeRaw
        return {
          ...base,
          status: deriveAwsStatus(filtered),
          latency: config.category === 'api' ? latency : null,
          incidents: filtered,
          calendarDays: 14,
          ...(uptimeEst != null ? { uptime30d: uptimeEst, uptimeSource: 'estimate' as const } : {}),
        }
      }

      const start = Date.now()
      const scrapeUrl = config.instatusUrl || config.rssFeedUrl || (config.gcloudProduct ? 'https://status.cloud.google.com/incidents.json' : null)
      const [res, scrapeRes, betterStackRes, aistudioRes] = await Promise.all([
        fetchWithTimeout(config.statusUrl),
        scrapeUrl
          ? fetchWithTimeout(scrapeUrl).catch((err) => {
              console.warn(`[fetchService] ${config.id} scrape failed:`, err instanceof Error ? err.message : err)
              parseErrors++
              return null
            })
          : Promise.resolve(null),
        config.betterStackUrl
          ? fetchWithTimeout(`${config.betterStackUrl}/index.json`, 5000).catch((err) => {
              console.warn(`[fetchService] ${config.id} BetterStack uptime fetch failed:`, err instanceof Error ? err.message : err)
              parseErrors++
              return null
            })
          : Promise.resolve(null),
        // aistudio.google.com/status is a secondary source for the gemini service (#310).
        // Failure is silent — never break the primary gcloud Vertex feed if Google
        // rotates the public API key or tightens referer enforcement.
        config.aistudioStatus
          ? fetchWithTimeout(AISTUDIO_ENDPOINT, 5000, {
              method: 'POST',
              headers: AISTUDIO_HEADERS,
              body: AISTUDIO_BODY,
            }).catch((err) => {
              console.warn(`[fetchService] ${config.id} aistudio fetch failed:`, err instanceof Error ? err.message : err)
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
        res.body?.cancel()
      } else if (scrapeRes?.ok) {
        // Cancel statusUrl response body — only res.ok/status is needed for BetterStack/RSS services
        res.body?.cancel()
        if (config.instatusUrl) {
          incidents = parseInstatusIncidents(await scrapeRes.text())
        } else if (config.rssFeedUrl) {
          const rssText = await scrapeRes.text()
          incidents = config.rssFeedUrl.includes('status.x.ai')
            ? parseXaiRssIncidents(rssText)
            : parseRssIncidents(rssText)
        } else if (config.gcloudProduct) {
          const data: GCloudIncident[] = await scrapeRes.json()
          const vertexIncidents = parseGCloudIncidents(data, config.gcloudProduct, config.gcloudProductId)
          if (config.aistudioStatus) {
            for (const inc of vertexIncidents) inc.id = `vertex:${inc.id}`
          }
          incidents = vertexIncidents
        }
      } else {
        // No parser matched — cancel unconsumed response bodies to free connections
        res.body?.cancel()
        scrapeRes?.body?.cancel()
      }

      if (config.aistudioStatus && aistudioRes) {
        const merge = await mergeAistudioIncidents(incidents, aistudioRes, config.id)
        incidents = merge.incidents
        parseErrors += merge.parseErrors
      }

      // Better Stack uptime + status: parse /index.json for aggregate_state and availability
      let betterStackUptime: number | null = null
      let betterStackStat: 'operational' | 'degraded' | 'down' | null = null
      let betterStackPartial = 0
      let bsDailyImpact: Record<string, DailyImpactLevel> | null = null
      if (betterStackRes && !betterStackRes.ok) {
        console.warn(`[fetchService] ${config.id} BetterStack index.json returned HTTP ${betterStackRes.status}`)
        betterStackRes.body?.cancel()
      }
      if (betterStackRes?.ok) {
        try {
          const bsData: BetterStackIndex = await betterStackRes.json()
          betterStackUptime = parseBetterStackUptime(bsData)
          betterStackStat = parseBetterStackStatus(bsData)
          betterStackPartial = parseBetterStackPartialCount(bsData)
          bsDailyImpact = parseBetterStackDailyImpact(bsData)
          // Filter out planned-maintenance events (report_type='maintenance') — signal 3 of 3.
          // Catches custom-titled maintenance events like "Authorization System Restart" (#503)
          // where the title contains no maintenance keyword (signal 1) and pubDate is not future (signal 2).
          const maintenanceIds = parseBetterStackMaintenanceIds(bsData)
          if (maintenanceIds.size > 0) {
            const before = incidents.length
            incidents = incidents.filter(inc => !maintenanceIds.has(inc.id))
            if (incidents.length < before) {
              console.debug(`[fetchService] ${config.id} filtered ${before - incidents.length} maintenance incident(s) via index.json report_type`)
            }
          }
          // Reconcile RSS incidents with index.json resolved status (authoritative)
          const resolvedIds = parseBetterStackResolvedIds(bsData)
          if (resolvedIds.size > 0) {
            let matched = 0
            for (const inc of incidents) {
              if (inc.status !== 'resolved' && resolvedIds.has(inc.id)) {
                matched++
                inc.status = 'resolved'
                if (!inc.resolvedAt && inc.timeline?.length) {
                  inc.resolvedAt = inc.timeline[inc.timeline.length - 1].at
                  const last = inc.timeline[inc.timeline.length - 1]
                  if (last.stage !== 'resolved') last.stage = 'resolved'
                }
                if (!inc.duration && inc.startedAt && inc.resolvedAt) {
                  inc.duration = formatDuration(new Date(inc.startedAt), new Date(inc.resolvedAt))
                }
                inc.title = inc.title.replace(/ — down$/, ' — recovered')
              }
            }
            const unresolved = incidents.filter(i => i.status !== 'resolved')
            if (matched === 0 && unresolved.length > 0) {
              console.debug(`[fetchService] ${config.id} resolvedIds=[${[...resolvedIds].join(',')}] but no RSS IDs matched (RSS IDs: ${incidents.map(i => i.id).join(',')})`)
            }
          }
        } catch (err) {
          console.warn(`[fetchService] ${config.id} BetterStack parse failed:`, err instanceof Error ? err.message : err)
          parseErrors++
        }
      }

      const filtered = filterIncidents(incidents, config)
      const hasOngoing = filtered.some((i) => i.status !== 'resolved')
      const httpStatus = res.ok || res.status === 403 ? 'operational' : 'degraded'
      // BetterStack: use aggregate_state + resource threshold only (RSS items are per-model
      // monitoring events, not service-level incidents — using them triggers false degraded)
      // Non-BetterStack: use RSS incidents for status determination
      const derivedStatus = config.betterStackUrl
        ? (betterStackStat ?? httpStatus)
        : (hasOngoing ? 'degraded' : httpStatus)

      // Successful fetch — reset or track based on parse errors
      if (parseErrors > 0) {
        console.warn(`[fetchService] ${config.id} completed with ${parseErrors} parse error(s)`)
        await trackFetchFailure(kv, config.id)
      } else {
        await resetFetchFailure(kv, config.id)
      }

      // aistudio has no uptime/impact RPC — derive dailyImpact from the
      // post-filter incident list so gemini's 30-day calendar renders.
      const aistudioDailyImpact = config.aistudioStatus
        ? computeDailyImpactFromIncidents(filtered)
        : null

      const dailyImpact = bsDailyImpact ?? aistudioDailyImpact
      const has30dCalendar = bsDailyImpact != null || aistudioDailyImpact != null

      return {
        ...base,
        status: derivedStatus,
        latency: config.category === 'api' ? latency : null,
        incidents: filtered,
        calendarDays: has30dCalendar ? 30 : 14,
        ...(dailyImpact && Object.keys(dailyImpact).length > 0 ? { dailyImpact } : {}),
        ...(betterStackUptime != null ? { uptime30d: betterStackUptime, uptimeSource: 'platform_avg' as const } : {}),
        ...(betterStackPartial > 0 ? { partialCount: betterStackPartial } : {}),
      }
    }
  } catch (err) {
    // Fetch failure (timeout/network) ≠ confirmed outage.
    // Require 3 consecutive failures before marking degraded to avoid transient timeout noise
    // (e.g., Together's status page is slow ~3s, intermittent timeouts under load).
    console.error(`[fetchService] ${config.id} failed:`, err)
    const shouldDegrade = await trackFetchFailure(kv, config.id)
    return { ...base, status: shouldDegrade ? 'degraded' : 'operational' }
  }
}

// ── Fetch All Services (parallel, with KV fallback) ──

export const CACHE_KEY = 'services:latest'

/** Service IDs that use statusComponentId — used by cron for component mismatch alerts */
export const COMPONENT_ID_SERVICES: { id: string; name: string; statusComponentId: string }[] =
  SERVICES.filter((s) => s.statusComponentId).map((s) => ({ id: s.id, name: s.name, statusComponentId: s.statusComponentId! }))

// ── Platform grouping for quorum-based outage detection ──
// When 70%+ of services on the same status page platform fail simultaneously,
// it's likely a platform outage (e.g., Atlassian Statuspage down), not individual service failures.

type StatusPlatform = 'atlassian' | 'incident-io' | 'betterstack' | 'instatus' | 'other'

function getServicePlatform(config: ServiceConfig): StatusPlatform {
  if (config.apiUrl?.includes('/api/v2/summary.json')) return 'atlassian'
  if (config.incidentIoBaseUrl) return 'incident-io'
  if (config.betterStackUrl) return 'betterstack'
  if (config.instatusUrl) return 'instatus'
  return 'other'
}

/** Detect platform-level outage: 70%+ simultaneous fetch failures on a platform.
 *  Returns set of service IDs affected by platform outage. */
export function detectPlatformOutage(
  services: ServiceStatus[],
  configs: ServiceConfig[],
  threshold = 0.7,
): Set<string> {
  if (services.length !== configs.length) {
    console.error(`[detectPlatformOutage] array length mismatch: ${services.length} services vs ${configs.length} configs — skipping`)
    return new Set<string>()
  }
  const platformGroups = new Map<StatusPlatform, { total: number; degraded: number; ids: string[] }>()

  for (let i = 0; i < services.length; i++) {
    const platform = getServicePlatform(configs[i])
    if (platform === 'other') continue
    if (!platformGroups.has(platform)) platformGroups.set(platform, { total: 0, degraded: 0, ids: [] })
    const group = platformGroups.get(platform)!
    group.total++
    group.ids.push(services[i].id)
    if (services[i].status === 'degraded' && services[i].incidents.length === 0) {
      // degraded with no incidents = likely fetch failure, not real incident
      group.degraded++
    }
  }

  const affected = new Set<string>()
  for (const [platform, group] of platformGroups) {
    if (group.total >= 3 && group.degraded / group.total >= threshold) {
      console.warn(`[platform-outage] ${platform}: ${group.degraded}/${group.total} services failed — platform outage detected`)
      for (const id of group.ids) affected.add(id)
    }
  }
  return affected
}

/**
 * Increment the daily "probe overrode a status-page degraded status" suppression counter.
 * Surfaced in the daily summary alongside fetch-fail:daily to distinguish a probe-healthy
 * false positive from a real outage where the probe also spiked. Never throws — kvPut
 * swallows + logs its own KV failures (returns false). Extracted + unit-tested because the
 * inline call previously shipped with `kvPut` un-imported, throwing a ReferenceError that
 * crashed all of fetchAllServices() (#501).
 */
export async function recordProbeSuppression(kv: KVNamespace, svcId: string, date: string): Promise<void> {
  const supKey = `cross-valid:suppressed:${svcId}:${date}`
  const prev = parseInt(await kv.get(supKey).catch(() => null) ?? '0', 10) || 0
  await kvPut(kv, supKey, String(prev + 1), { expirationTtl: 172800 })
}

export async function fetchAllServices(kv?: KVNamespace, probeSnapshots?: ProbeSnapshot[]): Promise<{ raw: ServiceStatus[]; enriched: ServiceStatus[] }> {
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
        summaryRes.body?.cancel()
        incidentsRes?.body?.cancel()
        return
      }
      const summary: StatuspageResponse = await summaryRes.json()
      let incidents: StatuspageResponse | null = null
      if (incidentsRes?.ok) {
        incidents = await incidentsRes.json()
      } else {
        incidentsRes?.body?.cancel()
      }
      // Fetch status page HTML for uptimeData/component_uptimes parsing
      const statusUrl = baseUrl.replace('/api/v2', '')
      const needsHtml = SERVICES.some((s) => s.apiUrl === apiUrl && (s.statusComponentId || s.incidentIoComponentId))
      let uptimeHtml: string | undefined
      if (needsHtml) {
        try {
          const htmlRes = await fetchWithTimeout(statusUrl, 5000)
          if (htmlRes.ok) uptimeHtml = await htmlRes.text()
          else htmlRes.body?.cancel()
        } catch (err) { console.warn(`[prefetch] HTML fetch failed for ${statusUrl}:`, err instanceof Error ? err.message : err) }
      }
      prefetchMap.set(apiUrl, { summary, incidents, latency, uptimeHtml })
    } catch (err) {
      const isJsonErr = err instanceof SyntaxError
      console.warn(`[prefetch] ${isJsonErr ? 'JSON parse' : 'network'} failure for ${baseUrl}:`, err instanceof Error ? err.message : err)
    }
  }))

  // Batch services to avoid exceeding Cloudflare Workers concurrent connection limit.
  // BetterStack services use 3 connections each (statusUrl + RSS + index.json);
  // 30 services in parallel would create ~60-90 concurrent connections.
  const BATCH_SIZE = 10
  const results: PromiseSettledResult<ServiceStatus>[] = []
  try {
    for (let i = 0; i < SERVICES.length; i += BATCH_SIZE) {
      const batch = SERVICES.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.allSettled(
        batch.map((config) => fetchService(config, config.apiUrl ? prefetchMap.get(config.apiUrl) : undefined, kv))
      )
      results.push(...batchResults)
    }
  } catch (err) {
    console.error(`[fetchAllServices] batch loop failed at index ${results.length}/${SERVICES.length}:`, err)
    // Fill remaining with rejected results to maintain index alignment
    while (results.length < SERVICES.length) {
      results.push({ status: 'rejected' as const, reason: err })
    }
  }

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
      // #591 — carry the stale flag even on a total fetch reject (fetchService's success paths set it
      // via `base`; this fresh-object fallback must too, so a stale service stays ranking-excluded).
      ...(SERVICES[i].incidentSourceStale ? { incidentSourceStale: true } : {}),
    }
  })

  // Cross-validate: override false-positive degraded status when probe RTT confirms service is healthy.
  // Order: Phase 3 (metastatuspage) → Phase 2 (quorum) → Phase 1 (probe)
  // Earlier phases see original degraded counts before later phases mutate them.
  const degradedFromFetch = raw.filter(s => s.status === 'degraded' && s.incidents.length === 0)
  if (degradedFromFetch.length > 0) {
    // Phase 3: Metastatuspage preemptive signal (if platform status was cached by cron)
    // Only overrides services where probe also confirms healthy (or no probe data exists).
    // This prevents hiding real outages that coincide with platform issues.
    if (kv) {
      try {
        const atlassianRaw = await kv.get(platformStatusKey('atlassian')).catch(() => null)
        if (atlassianRaw) {
          const platformStatus: PlatformStatus = JSON.parse(atlassianRaw)
          if (platformStatus.status !== 'operational') {
            for (const svc of raw) {
              if (svc.status !== 'degraded' || svc.incidents.length > 0) continue
              const config = SERVICES.find(c => c.id === svc.id)
              if (!config || getServicePlatform(config) !== 'atlassian') continue
              // If probe data shows spike, this is a real outage — don't override
              if (probeSnapshots && probeSnapshots.length > 0 && svc.id in (probeSnapshots[probeSnapshots.length - 1]?.data ?? {})) {
                if (!isProbeHealthy(probeSnapshots, svc.id)) {
                  console.log(`[cross-validation] ${svc.id}: metastatuspage degraded but probe confirms issue — keeping degraded`)
                  continue
                }
              }
              console.log(`[cross-validation] ${svc.id}: metastatuspage reports ${platformStatus.status} — holding operational`)
              svc.status = 'operational'
            }
          }
        }
      } catch (err) {
        console.warn('[cross-validation] metastatuspage KV read/parse failed, falling back to Phase 2:', err instanceof Error ? err.message : err)
      }
    }

    // Phase 2: Platform quorum detection (independent of probe data)
    // Runs after Phase 3 — catches cases where metastatuspage itself is unreachable
    const platformAffected = detectPlatformOutage(raw, SERVICES)
    if (platformAffected.size > 0) {
      for (const svc of raw) {
        if (svc.status === 'degraded' && svc.incidents.length === 0 && platformAffected.has(svc.id)) {
          console.log(`[cross-validation] ${svc.id}: platform outage detected — holding operational`)
          svc.status = 'operational'
        }
      }
    }

    // Phase 1: Probe-based cross-validation (requires probe data)
    if (probeSnapshots && probeSnapshots.length > 0) {
      const date = new Date().toISOString().split('T')[0]
      for (const svc of degradedFromFetch) {
        if (svc.status === 'degraded' && isProbeHealthy(probeSnapshots, svc.id)) {
          console.log(`[cross-validation] ${svc.id}: status page down but probe RTT normal — holding operational`)
          svc.status = 'operational'
          // Daily suppression counter — see recordProbeSuppression() docstring.
          if (kv) await recordProbeSuppression(kv, svc.id, date)
        }
      }
    }
  }

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

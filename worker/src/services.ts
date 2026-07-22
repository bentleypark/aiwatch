// Service status fetching and parsing for all monitored AI services.

import type { Incident, ServiceStatus, ServiceComponent, ServiceConfig, DailyImpactLevel } from './types'
export type { ServiceStatus } from './types'
import { recordParseFailure } from './parse-failure-log'
import { fetchWithTimeout, formatDuration, trackFetchFailure, resetFetchFailure, trackComponentMiss, resetComponentMiss, kvPut, isNonReliabilityAdvisory } from './utils'
import { isProbeHealthy, isProbeFailing, detectConsecutiveSpikes, type ProbeSnapshot } from './probe'
import { readSuppressions, applySuppressions } from './suppression'
import { buildUpstreamFeeds, type UpstreamCandidate } from './upstream-feed'
import { platformStatusKey, type PlatformStatus } from './platform-monitor'
import { type StatuspageResponse, normalizeStatus, parseIncidents, parseUptimeData } from './parsers/statuspage'
import { parseFlashdutyFeed, DEEPSEEK_FEED_KV_KEY, DEEPSEEK_FEED_SOFT_STALE_S, type StoredFlashdutyFeed } from './parsers/flashduty'
import { computeIncidentIoUptime, parseIncidentIoReportedUptime, parseIncidentIoComponentImpacts, attachIncidentIoComponentNames, attachIncidentIoComponentIds, enrichIncidentIoText, parseIncidentIoGlobalPage } from './parsers/incident-io'
import { type GCloudIncident, parseGCloudIncidents } from './parsers/gcloud'
import {
  AISTUDIO_ENDPOINT,
  AISTUDIO_HEADERS,
  AISTUDIO_BODY,
  AISTUDIO_COMPONENT,
  parseAistudioIncidents,
  computeDailyImpactFromIncidents,
} from './parsers/aistudio'
import { parseInstatusIncidentsResult, type InstatusParseFailure, parseInstatusUptime, parseInstatusReportedUptime, parseInstatusUptimeDays, parseInstatusComponents } from './parsers/instatus'
import { parseRssIncidents, parseXaiRssIncidents, type BetterStackIndex, parseBetterStackStatus, parseBetterStackUptime, parseBetterStackReportedUptime, parseBetterStackDailyImpact, parseBetterStackResolvedIds, parseBetterStackMaintenanceIds, parseBetterStackPartialCount, parseBetterStackComponents } from './parsers/betterstack'
import { parseOnlineOrNotIncidents, computeOnlineOrNotUptime } from './parsers/onlineornot'
import { parseAwsRssIncidents, parseAwsHealthEvents, parseAwsRegionHealth, decodeAwsHealthJson, deriveAwsStatus } from './parsers/aws'
import { mergeXaiRegionalIncidents } from './xai-regions'

// #990 — OpenAI (openai/chatgpt/codex all share status.openai.com) occasionally posts a
// "kitchen-sink" advisory scoped to a gov-compliance ENVIRONMENT (e.g. the 2026-07 "Codex, workspace
// analytics, conversation search, … download endpoint not working in FedRAMP workspaces"),
// impact:minor, componentNames:[]. Its title enumerates many product names, so the substring
// attribution in filterIncidents pulls it onto ChatGPT + Codex, firing New+Resolved alerts for what
// is not a general-availability outage. A structural "drop minor+untagged" rule was rejected — it
// would silently drop legitimate minor incidents, the same class of invisible loss #970 fixed for
// impact:none incidents; the only signal is the title wording, which a denylist token keys on
// without that blast radius across 18+ statuspage services.
//
// Spread into chatgpt + codex ONLY, NOT openai: openai already drops the kitchen-sink advisory via
// its existing tokens (codex/conversation/chatgpt/download), AND #693 deliberately KEEPS a genuine
// FedRAMP *API* degradation ("FedRAMP workspaces and API orgs have degraded performance") under
// openai — a 'fedramp' exclude on openai would regress that. chatgpt/codex never match that API-only
// title (leak guard, #693), so excluding 'fedramp' there is safe. Vetoed BEFORE incidentKeywords;
// neither sets statusComponent so the #359 exclude-bypass can't fire → clean drop.
export const ENVIRONMENT_SCOPE_EXCLUDE = ['fedramp']

export const SERVICES: ServiceConfig[] = [
  // AI API Services
  // #934/#1090 — scopeIncidentsToComponent: claude is EXCLUDE-only (no positive incidentKeywords) on the shared
  // status.claude.com page, so a Claude-Code-only incident cross-attributed to Claude API — at ANY incident
  // status, and (the #1090 half) whether or not Claude API was itself degraded at the time. See
  // filterByComponentStatus. claudeai/claudecode are keyword-scoped and do NOT set this.
  { id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json', incidentExclude: ['claude.ai', 'claude code', 'claude desktop', 'cowork'], statusComponent: 'Claude API', statusComponentId: 'k8w3r06qmzrp', scopeIncidentsToComponent: true },
  // displayComponentIds (#606 Cat B): the official "APIs" group (12) + "Platform" group (FedRAMP,
  // Ads Manager) on the shared status.openai.com page (incident.io). Display-only allowlist (badge
  // unchanged — no statusComponentId); disjoint from chatgpt/codex (pinned by the shared-page no-leak
  // test). componentsUrl sources the list from components.json (31) since summary.json (25) omits
  // Chat Completions / Embeddings / Moderations / the API Login / FedRAMP / Ads Manager.
  // #693 — incidentExclude uses 'chatgpt workspaces' (NOT a bare 'workspaces'): FedRAMP is a curated
  // openai surface (above), so an API-affecting "FedRAMP workspaces and API orgs …" incident must
  // surface here; a bare 'workspaces' dropped it. ChatGPT consumer/Team Workspaces incidents are
  // still excluded via 'chatgpt'/'login'/'conversation' + the narrowed term, and an incident only
  // reaches openai if it also matches the api/region incidentKeywords. NOTE: openai has no
  // statusComponentId, so its badge falls back to the overall page indicator once ANY matching
  // unresolved incident survives the filter (status-determination step 4). Surfacing the FedRAMP
  // incident therefore ALSO flips the openai badge to the page's overall status (e.g. degraded /
  // "Partial System Degradation") — accepted in #693: it mirrors what OpenAI itself reports, and the
  // surfaced incident clarifies the FedRAMP scope.
  { id: 'openai', name: 'OpenAI API', provider: 'OpenAI', category: 'api', statusUrl: 'https://status.openai.com', apiUrl: 'https://status.openai.com/api/v2/summary.json', componentsUrl: 'https://status.openai.com/api/v2/components.json', incidentExclude: ['chatgpt', 'excel plugin', 'gpts', 'voice mode', 'deep research', 'pinned', 'sora', 'sign-in', 'login', 'conversation', 'chatgpt workspaces', 'logged out', 'codex', 'support chat', 'file', 'download', 'preview', 'upload', 'project files'], incidentIoBaseUrl: 'https://status.openai.com/incidents', incidentIoComponentId: '01JMXBRMFE6N2NNT7DG6XZQ6PW', incidentIoGroupId: '01K5H8S53SY1KMS4GQMNMQM1K5', incidentKeywords: ['api', 'us-east-1', 'us-west-2', 'eu-central-1'], statusComponentId: '01JMXBRMFE6N2NNT7DG6XZQ6PW', statusComponentIds: ['01JMXBRMFE6N2NNT7DG6XZQ6PW', '01JP8CD9JR3HR6Y7G4Q75N4DVW', '01JMXBRMFEMZK0HPK19RYET250', '01JMXBRMFEV0AJ0VVS68N9CD6R', '01JMXBRMFE4MAP2BHSJNZ787WX', '01JMXBRMFE5ESNNV8JDHVCGSRD', '01JMXBRMFEKVBWKK82B44QFMCE', '01JMXBRMFEVZ7E0X9GD9FWR9WX', '01JMXBRMFEQW613TFE89F45035', '01JMXBRMFESJCBGJR10PDD3WCQ', '01JSM5RTJWHRWDTS6Q604VEW3B', '01K9G527YRPY1EFRMHTKB5BKT5'], displayComponentIds: ['01JP8CD9JR3HR6Y7G4Q75N4DVW', '01JMXBRMFEMZK0HPK19RYET250', '01JMXBRMFE4MAP2BHSJNZ787WX', '01JMXBRMFE5ESNNV8JDHVCGSRD', '01JMXBRMFEKVBWKK82B44QFMCE', '01JMXBRMFEQW613TFE89F45035', '01JMXBRMFESJCBGJR10PDD3WCQ', '01K9G527YRPY1EFRMHTKB5BKT5', '01JMXBRMFE6N2NNT7DG6XZQ6PW', '01JMXBRMFEV0AJ0VVS68N9CD6R', '01JMXBRMFEVZ7E0X9GD9FWR9WX', '01JSM5RTJWHRWDTS6Q604VEW3B'] },
  { id: 'gemini', name: 'Gemini API', provider: 'Google', category: 'api', statusUrl: 'https://aistudio.google.com/status', apiUrl: null, gcloudProduct: 'Vertex Gemini API', gcloudProductId: 'Z0FZJAMvEB4j3NbCJs6B', aistudioStatus: true, incidentKeywords: ['vertex', 'gemini', 'us-central1', 'europe-west1', 'asia-northeast1'] },
  { id: 'bedrock', name: 'Amazon Bedrock', provider: 'AWS', category: 'api', statusUrl: 'https://health.aws.amazon.com/health/status', apiUrl: null,
    // #677 — AWS Health public events JSON (all regions in one fetch, real start+end timestamps)
    // replaces the per-region RSS that floored resolved durations to 1m + double-counted incidents.
    awsHealthApi: { url: 'https://health.aws.amazon.com/public/events', service: 'BEDROCK' } },
  { id: 'azureopenai', name: 'Azure OpenAI', provider: 'Microsoft', category: 'api', statusUrl: 'https://azure.status.microsoft/en-us/status', apiUrl: null, azureRssUrl: 'https://rssfeed.azure.status.microsoft/en-us/status/feed/', incidentKeywords: ['Azure OpenAI'] },
  // #623 — status.mistral.ai (Instatus, Nuxt) lists API components ("Chat Completions API", …)
  // alongside non-API surfaces (Le Chat consumer app, Le Console, Documentation, Website). The Nuxt
  // parser appends the affected component to the incident title ("… · Le Chat"), so a denylist scopes
  // the "Mistral API" badge/incidents/Score to the API only — the api-vs-app split (cf. OpenAI API
  // excludes ChatGPT). Denylist (not an `['api']` allowlist) so a real API incident is never dropped.
  // Known limitation: the Nuxt parser tags the title with only servicesArr[0] (first affected
  // component) and doesn't populate componentNames, so a *combined* Le-Chat+API incident that lists
  // Le Chat first would be dropped despite affecting the API. Low-probability; revisit if observed.
  // #627 — statusComponent 'API' selects the Instatus "API" group component for the official uptime%
  // (status.mistral.ai groups all API endpoints under it; → ~99.6% instead of "Not provided").
  // #929 — holdShortIncidents: the Instatus auto-monitor posts frequent very short-lived
  // "○○ API Degraded" MEDIUM (→ minor) incidents that self-resolve in seconds/minutes and are then
  // pruned from the page, so the */5 cron fired a phantom "New Incident" alert on each (e.g. the
  // 2026-07-03 AI Registry Prompts/Skills flaps). Same knob Langfuse uses (#792): a non-major NEW
  // incident is held ~2 cron cycles before alerting, so a self-resolving flap never fires while a
  // genuine longer incident (e.g. the 120h Fine Tuning degradation) still alerts.
  // #761 — instatusUrl points at `/activity/page/1`, the incidents listing's CURRENT home. Mistral
  // moved it: `/incidents/page/1` now 301s there (verified 2026-07-20). `fetchWithTimeout` follows
  // redirects, so the stale URL still parsed and the drift was invisible. Fixed because the scrape
  // fetch fails SILENTLY, not loudly: it has its own `.catch` (→ `null`, `parseErrors++`), and the
  // Instatus return path calls `trackFetchFailure` but DISCARDS its `shouldDegrade` — the status it
  // returns is derived from the ROOT `statusUrl` response instead. So a throwing scrape URL doesn't
  // degrade the service; it empties `incidents`, risking a false RECOVERY (an ongoing incident
  // vanishing) plus the loss of uptime + the components snapshot. Removing the hop also removes that
  // exposure on the */5 cron. The root `statusUrl` still serves the component tree + uptime.
  // #761 — displayComponentIds: the 12 components of Mistral's own "API" group. The 5 "Services"
  // components (Le Console/Documentation/Vibe/Document Library/Website) are omitted so the breakdown
  // stays an API-surface card — NOT because incidentExclude covers them: it is a substring match on
  // the incident TITLE (['le chat','le console','documentation','website']) and drops only 3 of the 5
  // ('Vibe' matches nothing; 'documentation' is not a substring of 'document library'). See the
  // CAVEAT on routingTier in fallback.ts for what that divergence costs. NO
  // componentGroups: a single group label would collapse all 12 into one row (ServiceDetails groups
  // by label), destroying the per-component visibility this card exists for — the 12 names are
  // already self-describing. Display-only (#606): components[] never feeds the badge — on this branch the
  // badge is `hasOngoing ? 'degraded' : httpStatus` (the filtered incident list + the root page's
  // HTTP status); statusComponent feeds only the uptime% and the #359 exclude-bypass.
  { id: 'mistral', name: 'Mistral API', provider: 'Mistral AI', category: 'api', statusUrl: 'https://status.mistral.ai', apiUrl: null, instatusUrl: 'https://status.mistral.ai/activity/page/1', incidentExclude: ['le chat', 'le console', 'documentation', 'website'], statusComponent: 'API', holdShortIncidents: true, displayComponentIds: ['c4869a5a-054c-4c1b-88d1-3d195ba58511', '6d1417e5-81f5-44f4-bfd4-d2eb44d95988', '09f74bbf-a6e6-4751-a057-70da6c502c06', 'd7e0541d-b743-4cad-96cb-dd1395422904', '9f01cfda-c067-426b-b1aa-081541169174', 'd8e1e02e-48a4-4d97-8168-a8aabc1c51fb', '033ab409-a16e-4574-aef5-f2f0afc1f6cd', '4051fbf9-fea4-434a-90c1-b347c16e02ba', '78e74758-aa8f-4067-9147-d7f1ab90849a', '02a249ad-72d5-432a-8937-a5ab69a0b7f8', '7fadf202-f02f-40a2-84a4-c4f4041b7865', 'bd64fd4f-286c-4a86-bd31-006a7ea5aa03'] },
  // displayAllComponents (#606): per-model statuspage — show every model/surface except Docs/Website
  // (dynamic, so new/retired models need no config edit). componentSurfaces stay as individual rows;
  // the rest fold into a collapsible "Models" group (matches the official Endpoints/Models split).
  { id: 'cohere', name: 'Cohere API', provider: 'Cohere', category: 'api', statusUrl: 'https://status.cohere.com', apiUrl: 'https://status.cohere.com/api/v2/summary.json', incidentIoBaseUrl: 'https://status.cohere.com/incidents', incidentIoComponentId: '01HQ6CA39NZ5X3PRFPN71Q89TE', displayAllComponents: true, componentDenylist: ['Docs', 'Website'], componentSurfaces: ['Coral', 'Infrastructure', 'Playground', 'embeddings'] },
  { id: 'groq', name: 'Groq Cloud', provider: 'Groq', category: 'api', statusUrl: 'https://groqstatus.com', apiUrl: 'https://groqstatus.com/api/v2/summary.json', incidentIoBaseUrl: 'https://groqstatus.com/incidents', incidentIoComponentId: '01K053E2FAKWKEYHXEV7WAHJBM', displayAllComponents: true, componentDenylist: ['Docs', 'Website'], componentSurfaces: ['API'] },
  { id: 'together', name: 'Together AI', provider: 'Together', category: 'api', statusUrl: 'https://status.together.ai', apiUrl: null, rssFeedUrl: 'https://status.together.ai/feed', betterStackUrl: 'https://status.together.ai', flapSuppression: true, componentDenylist: ['Website'] },
  { id: 'fireworks', name: 'Fireworks AI', provider: 'Fireworks', category: 'api', statusUrl: 'https://status.fireworks.ai', apiUrl: null, rssFeedUrl: 'https://status.fireworks.ai/feed', betterStackUrl: 'https://status.fireworks.ai', flapSuppression: true, componentDenylist: ['Website'] },
  // Cerebras Inference (#391, #992) — Atlassian Statuspage, single-tenant, per-model. Its model lineup
  // churns (models added/retired), so instead of a hardcoded statusComponentIds allowlist (which went
  // stale — 2 dead ids + a missing new Gemma4-31B-Multimodal, #992) it runs DYNAMIC (displayAllComponents,
  // like cohere/groq): the breakdown lists every live component and the badge worst-ofs them (the #992
  // resolveSvcStatus dynamic branch), so a new/retired model needs no config edit. statusComponentId
  // (Developer Console) stays the primary for uptime parsing / calendar / component-miss alerting;
  // Developer Console is a componentSurfaces row (models fold into the collapsible "Models" group).
  // componentDenylist mirrors the cohere/groq convention — a future non-availability component
  // (Website/Docs) must not enter the dynamic worst-of badge or the breakdown.
  { id: 'cerebras', name: 'Cerebras Inference', provider: 'Cerebras', category: 'api', statusUrl: 'https://status.cerebras.ai', apiUrl: 'https://status.cerebras.ai/api/v2/summary.json', statusComponentId: '83h1cchw4vs4', displayAllComponents: true, componentSurfaces: ['Developer Console'], componentDenylist: ['Website', 'Docs'] },
  // #623 — status.perplexity.com (Instatus, Next.js) has 3 components: "API" (Sonar) + "Website"
  // (the consumer perplexity.ai) + "Computer" (agentic/computer-use surface, added #911).
  // The Next.js parser now resolves each incident's affected components
  // → componentNames (#623), so `incidentKeywords: ['api']` (matched against componentNames) scopes
  // the badge/Score to the API: a Website-only incident is dropped, a Website+API incident kept (it
  // affects the API). Allowlist is correct here — the API component is literally named "API", and
  // unlike a title-denylist it keeps a multi-component "Website and API" incident.
  // #635 — statusComponent 'API' selects the Instatus "API" component for the official uptime% (the
  // Next.js payload carries componentsUptime[id].uptime, ~90d) instead of "Not provided".
  // displayComponentIds (#761): top-level Instatus components API (Sonar) + Website + Computer (#911).
  // Display-only — badge stays on statusComponent 'API'. Next.js Instatus exposes per-component status.
  { id: 'perplexity', name: 'Perplexity', provider: 'Perplexity AI', category: 'api', statusUrl: 'https://status.perplexity.com', apiUrl: null, instatusUrl: 'https://status.perplexity.com', incidentKeywords: ['api'], statusComponent: 'API', displayComponentIds: ['clyiakn7i60113hvojwho6za6j', 'clyi6jhgg31469ihojbwbsmeeg', 'cmr18ih7201l20rqmap66bx4l'] },
  { id: 'xai', name: 'xAI (Grok)', provider: 'xAI', category: 'api', statusUrl: 'https://status.x.ai', apiUrl: null, rssFeedUrl: 'https://status.x.ai/feed.xml', incidentKeywords: ['api'], incidentExclude: ['[API Console]', 'Test+Incident'] },
  // status.deepseek.com (Flashduty, #507) blocks NON-BROWSER TLS fingerprints — a Worker fetch()
  // is reset at the TLS layer regardless of egress IP (verified 2026-06-12: a real Chromium from
  // the SAME IP succeeds where curl/fetch are reset, so it's a JA3/bot wall, NOT an IP block).
  // #618 — a scheduled GitHub Action browser-renders the page and POSTs the Flashduty feed to
  // /api/internal/deepseek-feed → KV. `flashdutyFeed` makes fetchService prefer that KV feed (fresh
  // → supersedes the mirror, clears the stale flag). The deepseek.statuspage.io Atlassian mirror
  // (#498) is the FALLBACK when the feed is missing/expired — it FROZE at 2026-05-08 (#591/#507),
  // returning 200 with stale data, so `incidentSourceStale` keeps it out of Score rankings then.
  { id: 'deepseek', name: 'DeepSeek API', provider: 'DeepSeek', category: 'api', statusUrl: 'https://status.deepseek.com', apiUrl: 'https://deepseek.statuspage.io/api/v2/summary.json', statusComponentId: 'j4n367d9mh3x', incidentKeywords: ['api'], incidentSourceStale: true, flashdutyFeed: true, flashdutyPrimaryComponentId: '01KR3NC9ETZYF436Z8YT1HM047' },
  // #989 — Kimi (Moonshot AI). Atlassian Statuspage, data-rich (verified 2026-07-18: x-statuspage-version
  // header + window.uptimeData for the badge component). `.cn` is a CNAME to Statuspage (AtlassianEdge)
  // so a Worker fetch reaches it — no China-network risk, no mirror needed.
  //   • statusComponentId 'Open API' drives the badge + uptime; the model components are display-only
  //     (displayComponentIds, #606) — NOT the badge, so a model-component change can't flip the card
  //     (which would drag status-edge alerts + cache refresh). componentGroups folds the six `* Model`
  //     components under one collapsible "Models" header (replicate pattern); Open API + API Service
  //     stay as ungrouped surface rows.
  //   • The auto-monitor opens frequent `critical` incidents titled `Agentic 模型错误报警` that attach to
  //     no component (verified 2026-07-18) and carry paperwork-inflated durations (recorded hours vs
  //     minutes of real impact — the #1019 pattern). autoMonitorTitles tags them → grouped in the UI +
  //     excluded from the Score (isReliabilityIncident, #989) as an unusable signal — see that helper
  //     for the accepted limitation. titleMap renders the Chinese titles English on every surface.
  //   • NO holdShortIncidents/flapSuppression: a `critical` incident bypasses every hold/flap path
  //     (alerts.ts), so both are inert here — the Discord flood is prevented instead by
  //     filterByComponentStatus (#970: an active non-null-impact incident is dropped while Open API is
  //     operational). Plain LLM at API_TIER 2 (fallback.ts); the fallback capability nuance is tracked
  //     on #1062 (unbuilt) — no per-service entry needed here.
  { id: 'kimi', name: 'Kimi (Moonshot AI)', provider: 'Moonshot AI', category: 'api', statusUrl: 'https://status.moonshot.cn', apiUrl: 'https://status.moonshot.cn/api/v2/summary.json', statusComponentId: '8psr5dfdld0s', displayComponentIds: ['8psr5dfdld0s', 'rf64wcbxt3r2', 'x0zsqgy57b75', 'z2zfp65lvb2z', 'lk7q3z0fcylp', 'p1j9ttb7jwhp', '8rkd3yj051gl', 'wmn9wzv84k1v'], componentGroups: { 'x0zsqgy57b75': 'Models', 'z2zfp65lvb2z': 'Models', 'lk7q3z0fcylp': 'Models', 'p1j9ttb7jwhp': 'Models', '8rkd3yj051gl': 'Models', 'wmn9wzv84k1v': 'Models' }, autoMonitorTitles: [/^agentic\s*模型错误报警$/i], titleMap: { 'Agentic 模型错误报警': 'Agentic model error alert', 'agentic模型错误报警': 'Agentic model error alert', '搜索请求出现大量报错': 'Elevated search request error rate', '短信登录异常': 'SMS login failure', 'deep research workflow错误率异常': 'Deep Research workflow error rate anomaly' }, addedAt: '2026-07-18' },
  { id: 'openrouter', name: 'OpenRouter', provider: 'OpenRouter', category: 'api', statusUrl: 'https://status.openrouter.ai', apiUrl: null, onlineOrNotUrl: 'https://status.openrouter.ai', onlineOrNotComponent: 'Chat (/api/v1/chat/completions)' },
  // Voice & Speech AI
  // displayComponentIds (#606): curated availability surfaces for the breakdown card —
  // TTS, STT, Conversations, RAG, Telephony, Other API endpoints, + ElevenCreative (excludes UI/Quality/Other).
  // #685 — ElevenCreative (01JJM5RKYAEWNM3XYRHXM8FJQ3) is the ONLY component reflecting Dubbing health
  // (a Voice-domain product within the ElevenCreative suite; no standalone Dubbing component exists). It
  // was previously omitted, so a Dubbing/ElevenCreative degradation flipped the badge (overall indicator)
  // while the breakdown stayed all-operational — a visible contradiction. The row label reads
  // 'ElevenCreative' (broader suite), the accepted trade-off since no finer-grained component exists.
  // Display-only: badge stays on the overall page indicator (no statusComponentIds).
  // #1006 — uptime scoped to the badge/detail components (Text-to-Speech + STT + Conversations + RAG +
  // Telephony + …), not just Text-to-Speech: they are distinct product surfaces, and an STT outage was
  // showing in the incident list while uptime, read from TTS alone, sat at 100%.
  { id: 'elevenlabs', name: 'ElevenLabs', provider: 'ElevenLabs', category: 'api', statusUrl: 'https://status.elevenlabs.io', apiUrl: 'https://status.elevenlabs.io/api/v2/summary.json', incidentIoBaseUrl: 'https://status.elevenlabs.io/incidents', incidentIoComponentId: '01JP2RQVGDHPEEDAFM5KV2MH9P', incidentExclude: ['webpage'], displayComponentIds: ['01JP2RQVGDHPEEDAFM5KV2MH9P', '01JYDTNNSJBT4X90MAC47YPM9S', '01JY3H5SJJZNC33AYMAE4SK4TH', '01JY3H5SJJD2BMSGSW5FZE08ST', '01JY3H5SJJJG47J60JPKX882H8', '01JY3H5SJJFKTXYQHG5A8Z1KYH', '01JJM5RKYAEWNM3XYRHXM8FJQ3'] },
  // displayComponentIds (#606): curated user-facing API surfaces for assemblyai + deepgram
  // (excludes internal infra / Website / Billing / Docs, and the badge's umbrella statusComponentId
  // — the card shows the per-surface children). Display-only — badge stays on statusComponentId.
  // #692 — deepgram includes BOTH '...Voice Agent API' (r2z04fcdhhzb) AND its sibling 'Voice Agent
  // API: Downstream Providers' (7n3stjcbj4bx, a third-party dependency e.g. Gemini), kept adjacent.
  // Deepgram degrades only the Downstream component during a provider outage, so omitting it hid a
  // real degradation behind an operational base row — surfacing it makes the breakdown honest.
  { id: 'assemblyai', name: 'AssemblyAI', provider: 'AssemblyAI', category: 'api', statusUrl: 'https://status.assemblyai.com', apiUrl: 'https://status.assemblyai.com/api/v2/summary.json', statusComponentId: '50txf4qfk2kv', displayComponentIds: ['kygwc83t1rfg', '20vm7q71wjcn', 'trxjzz9bwdmc', 'psxcg5mfhznq', 'rfh9swc12f9h', '12wrfd55ml3r'] },
  { id: 'deepgram', name: 'Deepgram', provider: 'Deepgram', category: 'api', statusUrl: 'https://status.deepgram.com', apiUrl: 'https://status.deepgram.com/api/v2/summary.json', statusComponentId: 'cv8l6gg3cb9d', displayComponentIds: ['m49xkwqkc4kh', 's6v5z4lsl658', '6854s60zwxgw', 'r2z04fcdhhzb', '7n3stjcbj4bx', 'jgfq9ffjsfqk', 'vm1x1v101qtn', 'cvbdk3fslx9v', 't80v4qz2jdsf'] },
  // Inference / Infrastructure
  { id: 'huggingface', name: 'Hugging Face', provider: 'Hugging Face', category: 'api', statusUrl: 'https://status.huggingface.co', apiUrl: null, rssFeedUrl: 'https://status.huggingface.co/feed', betterStackUrl: 'https://status.huggingface.co', flapSuppression: true, componentDenylist: ['Website'] },
  // displayComponentIds (#606): mirrors the official replicatestatus.com component groups (the v2 JSON
  // omits group membership, so it's curated here). Array order = DISPLAY order; with componentGroupsInline
  // the breakdown renders each section where its first member sits in the array:
  //   API = HTTP API, Streaming API
  //   Inference and Training = H100/A100/L40S/T4/CPU Hardware (so a GPU-capacity degradation shows)
  //   Website = Playground
  //   (ungrouped surfaces) = Replicate Registry (r8.im), Official Models
  //   Support = Billing, Support Tickets  (renders AFTER the surface rows, per the official page)
  // Excludes Home Page. Display-only (decoupled from the worst-of badge).
  // #1006 — uptime is a worst-of over the SAME components the badge + detail page show
  // (displayComponentIds), not the single HTTP API component. Its GPU hardware (H100/A100/L40S/T4) is
  // core availability — a model can't run without it — but uptime read only HTTP API, so a multi-day
  // H100 degradation showed in the incident list beside a spotless 100%.
  { id: 'replicate', name: 'Replicate', provider: 'Replicate', category: 'api', statusUrl: 'https://www.replicatestatus.com', apiUrl: 'https://www.replicatestatus.com/api/v2/summary.json', incidentIoBaseUrl: 'https://www.replicatestatus.com/incidents', incidentIoComponentId: ['01JRJYHBWCXHFZ0NHMP1N7T2G3', '01JRJYHBWC358ZXKRXZD0BENPD', '01JRG9WZ84ABEY9ZJBB72CJBS8', '01JRGA5ZQKJX2NMG45VCFP9Y9C', '01JRGA5ZQKF3SW674WMFD92PAC', '01JS0A88GKRF5DNW74REX185D3', '01JS0A88GKZAMP8BD3W9BCCBWX', '01J5NNACBNTG5GR693P6RH5Q6J', '01JXJT0JC265GZN0BAJ446XBD2', '01JS0AB43BGQC1H06HKGPHP1F2', '01JS0AB43BH206N6Z4WNSB0Z0F', '01JS0AB43BNHTEGYYQBSWS3KDP'], displayComponentIds: ['01JRJYHBWCXHFZ0NHMP1N7T2G3', '01JRJYHBWC358ZXKRXZD0BENPD', '01JRG9WZ84ABEY9ZJBB72CJBS8', '01JRGA5ZQKJX2NMG45VCFP9Y9C', '01JRGA5ZQKF3SW674WMFD92PAC', '01JS0A88GKRF5DNW74REX185D3', '01JS0A88GKZAMP8BD3W9BCCBWX', '01J5NNACBNTG5GR693P6RH5Q6J', '01JXJT0JC265GZN0BAJ446XBD2', '01JS0AB43BGQC1H06HKGPHP1F2', '01JS0AB43BH206N6Z4WNSB0Z0F', '01JS0AB43BNHTEGYYQBSWS3KDP'], componentGroups: { '01JRJYHBWCXHFZ0NHMP1N7T2G3': 'API', '01JRJYHBWC358ZXKRXZD0BENPD': 'API', '01JRG9WZ84ABEY9ZJBB72CJBS8': 'Inference and Training', '01JRGA5ZQKJX2NMG45VCFP9Y9C': 'Inference and Training', '01JRGA5ZQKF3SW674WMFD92PAC': 'Inference and Training', '01JS0A88GKRF5DNW74REX185D3': 'Inference and Training', '01JS0A88GKZAMP8BD3W9BCCBWX': 'Inference and Training', '01J5NNACBNTG5GR693P6RH5Q6J': 'Website', '01JS0AB43BH206N6Z4WNSB0Z0F': 'Support', '01JS0AB43BNHTEGYYQBSWS3KDP': 'Support' }, componentGroupsInline: true },
  // fal.ai (#758) — generative-media inference platform (image/video/audio/3D, 600+ models incl.
  // FLUX/Kling/Hailuo). Peer of Replicate/Hugging Face. Instatus (Next.js) page like Perplexity:
  // `statusComponent: 'API'` selects the Instatus "API" group component for the official uptime%
  // (parseInstatusNextUptime), and `incidentKeywords: ['api']` (matched against componentNames, #623)
  // scopes the badge + incident list to API-affecting incidents — a Website/Dashboard-only incident is
  // dropped. Single-tenant page → no incidentExclude needed.
  // displayComponentIds (#761): ALL top-level Instatus components — API, Website, Official Models
  // (uniform "show every top-level component" rule, same as perplexity). Display-only — badge stays on
  // statusComponent 'API'. Next.js Instatus exposes per-component status.
  { id: 'fal', name: 'fal.ai', provider: 'fal', category: 'api', statusUrl: 'https://status.fal.ai', apiUrl: null, instatusUrl: 'https://status.fal.ai', incidentKeywords: ['api'], statusComponent: 'API', displayComponentIds: ['clzmj6mnv0283gwmwtdqtt9u3', 'clzmj6mni0276gwmw95xftvtd', 'clzu5ivf0385762icocgwepue4u'], addedAt: '2026-06-24' }, // #802
  // displayComponentIds (#606): pinecone's FUNCTIONAL surfaces (Console, Pod/Serverless Indexes
  // group headers, Index Management, Inference, Assistant). The 22 region components are excluded
  // — the Region card already covers per-region status. Display-only — badge stays on statusComponentId.
  { id: 'pinecone', name: 'Pinecone', provider: 'Pinecone', category: 'api', statusUrl: 'https://status.pinecone.io', apiUrl: 'https://status.pinecone.io/api/v2/summary.json', statusComponentId: 'r7tngp2p3sjd', displayComponentIds: ['jhky1rj0ps27', 'g7400gqyfhh9', 'r7tngp2p3sjd', 'hrgtfbcqygpc', '34h37xk5ltv1', 'pxr1b208pdh1'] },
  // turbopuffer (#857) — serverless vector-search DB; the Vector fallback sibling for Pinecone (un-blocks
  // the vector sub-tier, #601 → both un-excluded from EXCLUDE_FALLBACK, API_TIER 8). Single-tenant page,
  // no incidentKeywords needed. It serves a Statuspage-compatible summary.json but is an **incident.io**
  // page (ULID component ids, `component_uptimes`) — the same shape as langsmith below. Correcting the
  // original config: it was read as an Atlassian Statuspage, so neither statusComponentId (→ parseUptimeData,
  // Atlassian-only) nor incidentIoComponentId was set; `needsHtml` therefore never fetched the status HTML
  // and uptime30d stayed null, dropping the 40-pt uptime component (score 73/fair/medium instead of
  // 84/good/high). The page published uptime the whole time (display_uptime_mode 'chart_and_percentage'
  // as of 2026-07). Should it ever flip to 'chart_only' the values become "$undefined" and this degrades
  // to "No official uptime" — the honest state, not a misreading.
  // Uptime = worst-of across the 15 per-region API components. There is no group aggregate to read
  // (every component is ungrouped), so a single region would be an arbitrary pick that reports 100%
  // while another region is down; worst-of matches the statusComponentIds badge convention (#379).
  // `Dashboard` (01K0Q5QSJV9KAZMEMMQ0NCHD9E) is deliberately EXCLUDED because it is not an API surface —
  // same principle as langsmith's uptime (count only representative API surfaces), though the direction
  // differs: excluding Run Ingestion stopped an over-good ~100% from hiding incidents, while excluding
  // Dashboard stops a non-API component from dragging the worst-of down. A new region must be added here;
  // `computeIncidentIoUptime` warns when a configured id no longer resolves (ULID rotation), and
  // turbopuffer-uptime.test.ts pins the roster against the Dashboard id.
  // The badge still rides the overall page indicator (status-determination step 4) — a region belongs on a
  // Region card, not the badge/breakdown — so no statusComponentId / displayComponentIds. Score keeps its
  // probe (api.turbopuffer.com → {"status":"🐡"}) and the #802 coverage gate still holds it out of the
  // ranking until 30d of coverage accrue, independent of this uptime fix.
  { id: 'turbopuffer', name: 'turbopuffer', provider: 'turbopuffer', category: 'api', statusUrl: 'https://status.turbopuffer.com', apiUrl: 'https://status.turbopuffer.com/api/v2/summary.json', incidentIoComponentId: ['01KMGBMBN2JWWWC92RADN719MQ', '01K0Q28Y8010Y0QES8NQ9TSA0N', '01K0Q28Y8002ZDVXC1HEM8WBRA', '01KMGBMBN2VKMTFD9T6WBBY1DQ', '01KMGBMBN2JJYP251E9JA8WB1H', '01K0Q28Y80F4SGGMEYYG7G9GWZ', '01K0Q28Y80DA6WT9WN08K0N96C', '01K0Q28Y801TPC8YT7PS1CXVMR', '01KMGBMBN21AW19JHKPFJJJFN1', '01K0Q28Y80TDVJ2HYNEJ99W98G', '01K0Q28Y80K7Y1SSEX7Z2NYXNK', '01K0Q28Y80NZ19ARGHR79HTKZJ', '01K0Q1X4P70458SR04MTQ2CA7F', '01K0Q28Y80TXNQD9N86J2EXSRT', '01K0Q28Y80N7CW8FF73CEVK0YD'], addedAt: '2026-07-01' }, // #802 / #857
  { id: 'stability', name: 'Stability AI', provider: 'Stability AI', category: 'api', statusUrl: 'https://status.stability.ai', apiUrl: 'https://status.stability.ai/api/v2/summary.json', incidentIoBaseUrl: 'https://status.stability.ai/incidents', incidentIoComponentId: '01JW9J39X55NDFZTZT3K5NYR48' },
  // Black Forest Labs / FLUX (#756) — image-generation sibling for Stability AI (un-blocks the image
  // fallback sub-tier, #601). Single-tenant Atlassian Statuspage (no incidentKeywords needed). Badge
  // worst-of (#379): the developer-facing API surface + the "Image Generation Services" group (rolls
  // up every FLUX model tier), so a single model-tier blip doesn't flip the badge unless API or the
  // whole image group degrades. statusComponentId (API) is the primary for uptime parsing / calendar.
  // Per-component breakdown (#606): displayAllComponents per-model page — API + Finetuning stay
  // individual surfaces; the FLUX model tiers fold into the collapsed "Models" group; the "Image
  // Generation Services" group-header component is denylisted (its children are already shown).
  { id: 'bfl', name: 'Black Forest Labs (FLUX)', provider: 'Black Forest Labs', category: 'api', statusUrl: 'https://status.bfl.ml', apiUrl: 'https://status.bfl.ml/api/v2/summary.json', statusComponentId: 'ws9rrzk6n2j7', statusComponentIds: ['ws9rrzk6n2j7', 'm991l9z7y6jj'], displayAllComponents: true, componentDenylist: ['Image Generation Services'], componentSurfaces: ['API (api.bfl.ai)', 'Finetuning'], addedAt: '2026-06-24' }, // #802
  // displayComponentIds (#606): API + User Dashboard. Display-only.
  { id: 'voyageai', name: 'Voyage AI', provider: 'Voyage AI', category: 'api', statusUrl: 'https://voyageai-status.statuspage.io', apiUrl: 'https://voyageai-status.statuspage.io/api/v2/summary.json', statusComponentId: 'g74wmxgm0zxr', displayComponentIds: ['g74wmxgm0zxr', 'p4zzcfjd8p5q'] },
  { id: 'modal', name: 'Modal', provider: 'Modal', category: 'api', statusUrl: 'https://status.modal.com', apiUrl: null, rssFeedUrl: 'https://status.modal.com/feed', betterStackUrl: 'https://status.modal.com', flapSuppression: true, componentDenylist: ['Website'] },
  // Twelve Labs (#839) — video understanding / multimodal AI platform (search, embed, analyze over
  // video via Marengo & Pegasus foundation models). Atlassian Statuspage (page 5j9dmpdjtybc) →
  // statuspage.ts covers it, no new parser. Single-owner page → no incidentKeywords needed.
  // Category inference (not video-gen: Twelve Labs is search/embed/analyze, not generation).
  // EXCLUDE_FALLBACK: no API_TIER; video understanding has no clean substitute.
  // displayComponentIds (#606): all 10 individual API surfaces (Search/Embed/Analyze/Index/Video
  // list) under the API group. Excludes Platform/Playground/Dashboard (non-API surfaces).
  // #983 — Twelve Labs' Statuspage auto-monitor opens a BRAND-NEW incident per component blip, all
  // under one fixed title, and Statuspage stamps `impact: 'major'` on it whenever the affected
  // sub-component reads `major_outage`. On 2026-07-09 that produced four 5–16m incidents with
  // identical titles + identical machine-emitted timeline text. `autoMonitorTitles` tags them so the
  // alert path may hold/dedup them (impact is component-derived, not editorial) and the UI groups
  // them into one ×N row; `flapSuppression` then dedups a repeat within the 60-min window (#283).
  // The provider's REAL, human-written incidents use distinct titles ("Search API failure", "API
  // server failure") and never match this anchored pattern.
  { id: 'twelvelabs', name: 'Twelve Labs', provider: 'Twelve Labs', category: 'api', statusUrl: 'https://status.twelvelabs.io', apiUrl: 'https://status.twelvelabs.io/api/v2/summary.json', statusComponentId: 'mvv53x91b74m', displayComponentIds: ['mrclkkqtj01j', '2zsl201s8df5', 'jnvb5r3v74q1', '751304vy1s9x', 'hr353rqqmwmk', 'yklrkrhkd1by', '3t1cjx55dyrf', '2k0gnkk2kjmz', 'j21c5rdfj8kf', '91lzwtn6071h'], autoMonitorTitles: [/^Some API features are experiencing issues\.?$/i], flapSuppression: true, addedAt: '2026-07-02' },
  // LangSmith (#561) — LangChain's hosted observability/eval platform on an incident.io page. Since #1066
  // that page is a "global"/multi-region page whose Atlassian v2 compat API returns `components: []`, so
  // it is NO LONGER covered by statuspage.ts directly — `incidentIoGlobalPage` routes it through
  // parseIncidentIoGlobalPage (see the #1066 note below). Multi-component worst-of (#379): badge
  // tracks the three load-bearing surfaces (Run Ingestion + API + Application); the other components
  // (Billing, Sandboxes, Bulk Exports, PromptHub, Fleet, Deployments Data/Control Plane) are excluded
  // so non-availability blips don't flip the badge. Single-tenant (dedicated) page → no
  // incidentKeywords needed. is-down slug is 'langchain' (see slug-map.ts / rss.ts).
  // Official 30-day uptime is COMPUTED from the API component's `component_impacts` (#1006), and its
  // published `component_uptimes` figure is surfaced as `uptimeReported` — NOT the statuspage uptime-
  // showcase (incident.io pages don't emit it). The API surface is the developer-facing one and tracks
  // the real incident activity; Run Ingestion reads ~100% despite the incidents, so it would understate.
  // That API component is also statusComponentIds[1], so it doubles as one of the three worst-of badge
  // inputs AND (via incidentIoComponentId) the source of official uptime + calendar impact + text enrichment.
  // #1066 — `displayComponentIds` shows ALL 10 page components in the breakdown (decoupled from the
  // 3-component badge, #606): the badge stays on the availability core (API/Run Ingestion/Application)
  // so a Billing/Bulk-Exports blip can't flip it, while the dashboard mirrors the official page's full
  // component list. Order: badge core first, then the remaining surfaces.
  // #1066 — LangSmith migrated to an incident.io "global"/multi-region page: status.smith.langchain.com
  // now 301s to global.status.smith.langchain.com/gcp-us, whose Atlassian v2 compat API returns
  // `components: []`. `incidentIoGlobalPage` routes it through parseIncidentIoGlobalPage, which rebuilds
  // the summary.json shape from the page-root RSC. Component ids ALL rotated (01JT46QKH7… → 01KX6FV0RR…);
  // the badge worst-of is still Run Ingestion + API + Application, incidentIoComponentId is still the API
  // component (whose published `component_uptimes` figure — a rolling window, not consumed by the Score —
  // becomes uptimeReported), and statusComponentId (Run Ingestion) stays the
  // calendar/miss anchor. New components' data_available_since is 2026-07-10, so uptime reports a <30-day
  // window until the migration clock catches up (#1006 uptimeWindowDays).
  { id: 'langsmith', name: 'LangChain (LangSmith)', provider: 'LangChain', category: 'api', statusUrl: 'https://global.status.smith.langchain.com/gcp-us', apiUrl: 'https://global.status.smith.langchain.com/gcp-us/api/v2/summary.json', incidentIoGlobalPage: true, statusComponentId: '01KX6FV0RR5XXJ0SM3NXZRKMBY', statusComponentIds: ['01KX6FV0RR5XXJ0SM3NXZRKMBY', '01KX6FV0RRSSTKC5V2GPAMCEQR', '01KX6FV0RRKA56PXCRWEHJTMXM'], displayComponentIds: ['01KX6FV0RRSSTKC5V2GPAMCEQR', '01KX6FV0RR5XXJ0SM3NXZRKMBY', '01KX6FV0RRKA56PXCRWEHJTMXM', '01KX6FV0RR6F81Q8VM6KMACNXQ', '01KX6FV0RR46HM5EVSKG4BVY01', '01KX6FV0RRY9DS9G7ZGB46MQQ2', '01KX6FV0RRHHPK0Y474ESRYV0X', '01KX6FV0RRSDVTKHP03BBR1799', '01KX6FV0RR5Q12SE5Q6SH2RF8E', '01KX6FV0RR0E7AJPG60HR2ZTT9'], incidentIoBaseUrl: 'https://global.status.smith.langchain.com/gcp-us/incidents', incidentIoComponentId: '01KX6FV0RRSSTKC5V2GPAMCEQR', addedAt: '2026-06-11' }, // #802
  // #601 — LLM observability siblings for LangSmith (un-blocks the observability fallback sub-tier).
  // Helicone: Better Stack (mirror together/luma — official uptime + RSS). Langfuse: incident.io
  // (mirror langsmith — summary.json + incidents). Both data-rich (verified uptime / incident history).
  // Langfuse note: its status page region-duplicates the core components (Ingestion/Public/Prompts API
  // appear once per region). The badge worst-of (`statusComponentIds`) deliberately scopes to the
  // PRIMARY region's Ingestion/Public/Prompts — a single-region incident in a non-primary region won't
  // escalate the live badge, but it STILL surfaces in the incident list/calendar (incidentIoBaseUrl is
  // not component-scoped). Acceptable: a real Langfuse outage hits the primary region; widen the ID set
  // here if cross-region badge escalation is later wanted.
  { id: 'helicone', name: 'Helicone', provider: 'Helicone', category: 'api', statusUrl: 'https://status.helicone.ai', apiUrl: null, rssFeedUrl: 'https://status.helicone.ai/feed', betterStackUrl: 'https://status.helicone.ai', flapSuppression: true, componentDenylist: ['Website'], addedAt: '2026-06-23' }, // #802
  { id: 'langfuse', name: 'Langfuse', provider: 'Langfuse', category: 'api', statusUrl: 'https://status.langfuse.com', apiUrl: 'https://status.langfuse.com/api/v2/summary.json', statusComponentId: '01KS5BHY7AKJD8YEM4MFYMB35Z', statusComponentIds: ['01KS5BHY7AKJD8YEM4MFYMB35Z', '01KS5BHY7AX99XYA7AS7AAP7QG', '01KS5BHY7AH52EZHZQ9TYD53TY'], incidentIoBaseUrl: 'https://status.langfuse.com/incidents', incidentIoComponentId: '01KS5BHY7AKJD8YEM4MFYMB35Z', holdShortIncidents: true, addedAt: '2026-06-23' }, // #802
  // Runway (#393) — hosted generative-video AI (Gen-4 / Act-Two), AIWatch's first video provider. Native
  // Atlassian Statuspage (page s9lfdrzmhryw) → statuspage.ts covers it, no new parser. Multi-component
  // worst-of (#379): badge tracks the three availability surfaces (Public API + App + Backend); Billing +
  // Support are excluded so non-availability blips don't flip the badge. Single-tenant page → no
  // incidentKeywords. Probed since #678 (api.runwayml.com/v1/tasks → 401, auth not needed for RTT).
  // is-down slug == id ('runway'), so no slug override.
  // Lumped under `inference` for now (avoid a single-member video category until Luma/Pika are added).
  { id: 'runway', name: 'Runway', provider: 'Runway', category: 'api', statusUrl: 'https://status.runwayml.com', apiUrl: 'https://status.runwayml.com/api/v2/summary.json', statusComponentId: 'w3jcq3dwljp4', statusComponentIds: ['w3jcq3dwljp4', '2fr8tksxj5ns', 'hl94rh0mg6xt'], addedAt: '2026-06-11' }, // #802
  // Luma / Dream Machine (#602, #601 Phase 1) — generative-video AI (Dream Machine, Ray, UNI-1), added
  // as a Runway sibling. Better Stack status page (status.lumalabs.ai) → betterstack.ts parser via
  // rssFeedUrl (incidents) + betterStackUrl /index.json (status + uptime). flapSuppression: true — the
  // page auto-emits "X went down/recovered/degraded" model blips (#283/#597). Video-native, so no
  // component scoping needed. is-down slug == id ('luma'). Probed since #678 (dream-machine/v1/generations → 403).
  { id: 'luma', name: 'Luma (Dream Machine)', provider: 'Luma', category: 'api', statusUrl: 'https://status.lumalabs.ai', apiUrl: null, rssFeedUrl: 'https://status.lumalabs.ai/feed', betterStackUrl: 'https://status.lumalabs.ai', flapSuppression: true, componentDenylist: ['Website'], addedAt: '2026-06-12' }, // #802
  // AI Apps
  { id: 'claudeai', name: 'claude.ai', provider: 'Anthropic', category: 'app', statusUrl: 'https://status.claude.com', apiUrl: 'https://status.claude.com/api/v2/summary.json', incidentKeywords: ['claude.ai', 'across surfaces', 'claude desktop'], statusComponent: 'claude.ai', statusComponentId: 'rwppv331jlwc' },
  // displayComponentIds (#606): all Character.AI surfaces (single-owner page). Display-only.
  { id: 'characterai', name: 'Character.AI', provider: 'Character AI', category: 'app', statusUrl: 'https://status.character.ai', apiUrl: 'https://status.character.ai/api/v2/summary.json', statusComponentId: 'fw8g76r7dqcl', displayComponentIds: ['fw8g76r7dqcl', 'ngscynkb3c53', 'v58xb4x4tg0l', '8b8kpp2h7w82', 'dtcqb0ffqv21'], statusSourceDeactivated: true }, // #800 — Statuspage deactivated (401) since ~2026-06-18 (#689), no replacement; suppress recurring dead-source alerts. REMOVE when the page reactivates.
  // ChatGPT has no single umbrella status-page component. Status determination uses the overall
  // indicator + incidentKeywords filter with the "no relevant unresolved incidents → operational"
  // cross-contamination guard (#292); `incidentIoComponentId` only feeds uptime, not the status path.
  // #1006 — uptime is now COMPUTED from the impact records of the ChatGPT badge scope (the full
  // `statusComponentIds` worst-of, matching the badge), over a common 30 days, instead of copying the
  // page's published ChatGPT-group aggregate (#367). That aggregate is
  // not a 30-day figure and OpenAI's page excludes degraded/partial states from it, so it was never
  // comparable with any other service's number. `incidentIoGroupId` survives with a NEW job: it is the
  // figure the page actually DISPLAYS for this service, so `uptimeReported` reads it and the detail page
  // can show the provider's own number beside ours. Conversations carries the real incident activity.
  // displayComponentIds (#606 Cat B): the official "ChatGPT" group (12) on status.openai.com.
  // Display-only; disjoint from openai/codex. Compliance API + Agent belong to ChatGPT per the
  // official grouping (not the API group, despite the names). Login here is the ChatGPT Login
  // (the APIs group has a separate API-Login id absent from summary.json).
  // #1008: "Codex in ChatGPT Desktop" (01KMKFAMWKQ81YWSE1Z18R6VHR) is officially a ChatGPT-group
  //   component (Codex surfaced inside the ChatGPT desktop app, sits between ChatGPT Atlas / ChatGPT
  //   Work on the official page), so it belongs here — NOT under codex, where it used to be
  //   mis-attributed and let a ChatGPT-only incident flip the Codex badge to degraded.
  { id: 'chatgpt', name: 'ChatGPT', provider: 'OpenAI', category: 'app', statusUrl: 'https://status.openai.com', apiUrl: 'https://status.openai.com/api/v2/summary.json', incidentKeywords: ['chatgpt', 'conversation', 'login', 'pinned', 'file', 'download', 'upload', 'us-east-1', 'us-west-2', 'eu-central-1'], incidentExclude: [...ENVIRONMENT_SCOPE_EXCLUDE], incidentIoBaseUrl: 'https://status.openai.com/incidents', incidentIoComponentId: '01JMXBNJXGV1T5GT2M9XA83XNG', incidentIoGroupId: '01K5H8S53SY1KMS4GQMNMZXTR1', statusComponentId: '01JMXBNJXGV1T5GT2M9XA83XNG', statusComponentIds: ['01JMXBNJXGV1T5GT2M9XA83XNG', '01JMXBNJXGKKP51D4DEJ2HZJ8Q', '01JMXBNJXGGT5SR5DB9J7GYY48', '01JSFK5QX36ZRW0TW0ZV0ZYFXQ', '01JSYVYQSWMJ9QG35XHP08BHA7', '01K8C008QVXHA6JX98PAS42VPD', '01K6TVGGGDCP0PPGCHXAG3AQX8', '01JQ7EKW990MSPSWVXC7VPV2ZJ', '01JMXBNJXG1S2D9V65P1ZZTD94', '01JMXBNJXG1YMQPPCPCQX3MPA2', '01JSG1XMJ9RVJJQ0E85NVSJ2AZ', '01KMKFAMWKQ81YWSE1Z18R6VHR'], displayComponentIds: ['01K8C008QVXHA6JX98PAS42VPD', '01JMXBNJXGV1T5GT2M9XA83XNG', '01K6TVGGGDCP0PPGCHXAG3AQX8', '01JSYVYQSWMJ9QG35XHP08BHA7', '01JMXBNJXGKKP51D4DEJ2HZJ8Q', '01JSFK5QX36ZRW0TW0ZV0ZYFXQ', '01JQ7EKW990MSPSWVXC7VPV2ZJ', '01JMXBNJXGGT5SR5DB9J7GYY48', '01JMXBNJXG1S2D9V65P1ZZTD94', '01JMXBNJXG1YMQPPCPCQX3MPA2', '01JSG1XMJ9RVJJQ0E85NVSJ2AZ', '01KMKFAMWKQ81YWSE1Z18R6VHR'] },
  // #619 — DeepSeek's consumer app (chat.deepseek.com, "DeepSeek App"). Same Flashduty feed as
  // DeepSeek API (#618), scoped to the Web Chat component — the api-vs-app split mirror of
  // OpenAI API↔ChatGPT. Feed-only (no apiUrl): when the scraper feed is fresh it supersedes +
  // clears incidentSourceStale; when absent, fetchService returns an empty stale base (it does NOT
  // fetch the bot-walled status.deepseek.com directly). incidentSourceStale is the feed-absent flag.
  { id: 'deepseekapp', name: 'DeepSeek App', provider: 'DeepSeek', category: 'app', statusUrl: 'https://status.deepseek.com', apiUrl: null, incidentSourceStale: true, flashdutyFeed: true, flashdutyPrimaryComponentId: '01KR3NC9ETESRRQ4GABE0TGW53', addedAt: '2026-06-12' }, // #802
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
  // displayComponentIds (#606 Cat B): the official "Codex" group (4) on status.openai.com —
  // Codex API + CLI + VS Code extension + Codex Web. Display-only; disjoint from openai/chatgpt.
  // #1008: "Codex in ChatGPT Desktop" (01KMKFAMWKQ81YWSE1Z18R6VHR) is NOT a Codex-group component —
  //   it's officially in the ChatGPT group (Codex surfaced inside the ChatGPT desktop app, sits among
  //   ChatGPT Atlas / ChatGPT Work on the page). It was mis-attributed here, so a ChatGPT-only
  //   incident flipped it to partial_outage and dragged the Codex badge to degraded while the real
  //   Codex product (API/CLI/VS Code/Web) was operational. Removed from BOTH arrays and moved to
  //   chatgpt where it belongs.
  { id: 'codex', name: 'Codex', provider: 'OpenAI', category: 'agent', statusUrl: 'https://status.openai.com', apiUrl: 'https://status.openai.com/api/v2/summary.json', componentsUrl: 'https://status.openai.com/api/v2/components.json', incidentKeywords: ['codex', 'cli', 'vs code'], incidentExclude: [...ENVIRONMENT_SCOPE_EXCLUDE], incidentIoBaseUrl: 'https://status.openai.com/incidents', incidentIoComponentId: '01KMP3KP5MGE23B80K1EK4S8PV', incidentIoGroupId: '01KMKF9EBTCD8BN9PG8DJZXRSQ', statusComponentId: '01KMP3KP5MGE23B80K1EK4S8PV', statusComponentIds: ['01KMP3KP5MGE23B80K1EK4S8PV', '01KMKFAMWKNQ84Z1766MV08ZDE', '01KMP3KP5M8X0EBTVW6KN327EE', '01JVCV8YSWZFRSM1G5CVP253SK'], displayComponentIds: ['01KMKFAMWKNQ84Z1766MV08ZDE', '01KMP3KP5M8X0EBTVW6KN327EE', '01JVCV8YSWZFRSM1G5CVP253SK', '01KMP3KP5MGE23B80K1EK4S8PV'] },
  // cursor badge reflects worst-of: IDE primary + Cloud Agents + Automations + CLI (#379).
  // Bugbot/cursor.com/Marketplace are auxiliary surfaces and intentionally excluded.
  { id: 'cursor', name: 'Cursor', provider: 'Anysphere', category: 'agent', statusUrl: 'https://status.cursor.com', apiUrl: 'https://status.cursor.com/api/v2/summary.json', statusComponentId: 'rflc60xp5jp2', statusComponentIds: ['rflc60xp5jp2', 'mwv1g9sc7kdh', 'k0trcq273dr6', 'vsny1qv7v86c'] },
  // copilot badge reflects worst-of: Copilot + Copilot AI Model Providers (direct upstream) (#379).
  { id: 'copilot', name: 'GitHub Copilot', provider: 'Microsoft', category: 'agent', statusUrl: 'https://githubstatus.com', apiUrl: 'https://www.githubstatus.com/api/v2/summary.json', statusComponentId: 'pjmpxvq2cmr2', statusComponentIds: ['pjmpxvq2cmr2', 'cnnb39dkkk82'], incidentKeywords: ['copilot'] },
  // windsurf badge reflects worst-of: Cascade primary + Windsurf Tab (autocomplete agent surface) (#379).
  { id: 'windsurf', name: 'Windsurf', provider: 'Codeium', category: 'agent', statusUrl: 'https://status.windsurf.com', apiUrl: 'https://status.windsurf.com/api/v2/summary.json', statusComponentId: 'r5wf1ykd7y1m', statusComponentIds: ['r5wf1ykd7y1m', '8q19cygxvshj'] },
  // #1004 — JetBrains migrated this page Atlassian Statuspage (status.jetbrains.ai) → incident.io
  // (status.jetbrains.cloud) on 2026-07-09, then ~2026-07-15 REMOVED the standalone "Junie" component
  // the first migration adopted (→ #135 component-miss alert + null uptime/Score). Junie's status now
  // spans the TWO components that carry JetBrains' OWN AI-platform health:
  //   • "JetBrains AI" (01KX3EN535A0SKSZK3S84949V1) — the KB-named roll-up (SUPPORT-A-2595 tells users
  //     to check "JetBrains AI Status" for Junie). But created 2026-07-09 with ZERO incident history +
  //     ~6d of data — a near-empty new component on its own.
  //   • "JetBrains Central Console" (01KST6ZB60NWW1MAB3ECRMJFS0) — the AI GATEWAY that actually carries
  //     the platform incidents. Cross-checked against OUR OWN pre-migration Junie archive: "AI Platform
  //     LLM APIs outage" (2026-05-29), auth degradations, quota — all now tag Central Console; NONE tag
  //     "JetBrains AI". Data since 2026-05-29 → full 30d window, uptime ~99.95%.
  // Badge + uptime run on Central Console ALONE; JetBrains AI rides along only in the breakdown +
  // incident scope. Why not a worst-of-both badge (statusComponentIds): uptime is computed over the
  // SAME scope as the badge (`statusComponentIds ?? incidentIoComponentId`, the #1006 invariant that
  // keeps uptime/calendar/badge aligned), and computeIncidentIoUptime reports the SHORTEST covered
  // window across that scope. JetBrains AI's records start 2026-07-09 (~6d), so putting it in the badge
  // scope pins uptimeWindowDays to 6 while the % reflects Console's 30 days — an incoherent "99.8% over
  // 6d". Console's records reach 2026-05-29 → the honest 30d window. JetBrains AI is 100%/empty anyway,
  // so the badge loses nothing by resolving on Console.
  //   • displayComponentIds lists BOTH (≥2 → a real 2-row breakdown that discloses the JetBrains AI
  //     roll-up the KB names, alongside the Console gateway).
  //   • incidentComponents scopes to BOTH names, so if JetBrains ever starts tagging incidents on the
  //     "JetBrains AI" component we catch them without a config change. Today they all tag Console.
  // We EXCLUDE the upstream provider components (Anthropic/OpenAI/Gemini — their own cards; #683
  // neutrality) and Grazie (sibling NLP product; #683 drops Grazie-only incidents).
  // The #802 coverage gate keys on `addedAt`, not the provider window — junie is established (no
  // addedAt) → full coverage, high-confidence Score.
  { id: 'junie', name: 'Junie', provider: 'JetBrains', category: 'agent', statusUrl: 'https://status.jetbrains.cloud', apiUrl: 'https://status.jetbrains.cloud/api/v2/summary.json', statusComponentId: '01KST6ZB60NWW1MAB3ECRMJFS0', incidentIoBaseUrl: 'https://status.jetbrains.cloud/incidents', incidentIoComponentId: '01KST6ZB60NWW1MAB3ECRMJFS0', displayComponentIds: ['01KST6ZB60NWW1MAB3ECRMJFS0', '01KX3EN535A0SKSZK3S84949V1'], incidentComponents: ['JetBrains AI', 'JetBrains Central Console'] },
]

/**
 * Merge aistudio incidents into the primary (vertex) list for gemini (#310).
 * Never throws: HTTP errors, invalid JSON, and parser exceptions all fall
 * back silently to the primary list and increment `parseErrors` so the
 * fetch-failure counter can degrade the service after repeated failures.
 * Response body is cancelled on every non-consumed path.
 */
// #717 — how long a held aistudio incident may be carried over across failed fetches before it's
// dropped. The cache `cachedAt` can't bound this (every cron write refreshes it, even while it's
// carrying the held incident), so the cap is on the incident's own age: an aistudio incident still
// "active" 24h after it started, with no successful refresh confirming it, is almost certainly
// resolved-but-stuck — stop pinning it. A genuinely shorter intermittent outage self-corrects the
// moment one aistudio fetch succeeds (a success returns the authoritative set, incl. resolution).
export const AISTUDIO_CARRYOVER_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * #717 — Pick the last-known **active** `aistudio:` incidents from a previous snapshot to carry over
 * when the live aistudio fetch fails (threw / non-OK / unparseable). The gated aistudio source is
 * intermittent, and silently dropping its incidents on a transient failure made a Gemini incident
 * flap in/out of the dashboard per refresh (badge flipping operational⇄degraded). Holding the last
 * known active incidents keeps the display stable until a successful fetch reasserts the truth.
 * Pure (no I/O) so it's unit-testable. Resolved incidents are NOT carried (they don't affect the
 * badge and a successful fetch will re-list them); incidents older than the age cap are dropped.
 */
export function carryOverAistudioIncidents(
  prevIncidents: Incident[] | undefined,
  now: number,
  maxAgeMs: number = AISTUDIO_CARRYOVER_MAX_AGE_MS,
): Incident[] {
  if (!prevIncidents) return []
  return prevIncidents.filter((i) => {
    if (!i.id.startsWith('aistudio:')) return false
    if (i.status === 'resolved') return false
    const started = Date.parse(i.startedAt ?? '')
    if (Number.isFinite(started) && now - started > maxAgeMs) return false
    return true
  })
}

export async function mergeAistudioIncidents(
  primary: Incident[],
  // #717 — null when the aistudio fetch THREW upstream (caught → null). All three failure modes
  // (threw / non-OK / unparseable) funnel through the single `holdAndReturn` path so they share
  // one tested code path instead of a duplicated inline hold at the call site.
  aistudioRes: Response | null,
  serviceId: string,
  // #717 — invoked ONLY on a failed aistudio read to recover the last-known active aistudio
  // incidents instead of silently returning vertex-only. Lazy so the happy path pays no KV read.
  getCarryOver?: () => Promise<Incident[]>,
): Promise<{ incidents: Incident[]; merged: number; parseErrors: number; held: number }> {
  const cancelBody = () => {
    aistudioRes?.body?.cancel().catch((e) =>
      console.warn(`[fetchService] ${serviceId} aistudio body cancel failed:`, e),
    )
  }
  const holdAndReturn = async (parseErrors: number, reason: string) => {
    // Defense-in-depth: carry-over is resilience code — it must never throw into the primary fetch
    // path it exists to protect. getCarryOver already defends internally; this is a belt-and-braces
    // guard so a future change there can't take down an otherwise-successful service result.
    let held: Incident[] = []
    try {
      held = getCarryOver ? await getCarryOver() : []
    } catch (err) {
      console.warn(`[fetchService] ${serviceId} aistudio carry-over read threw:`, err instanceof Error ? err.message : err)
    }
    if (held.length > 0) {
      console.info(`[${serviceId}] aistudio read failed (${reason}) — held ${held.length} last-known incident(s)`)
    }
    return { incidents: [...primary, ...held], merged: 0, parseErrors, held: held.length }
  }
  if (!aistudioRes) {
    return holdAndReturn(0, 'fetch threw')
  }
  if (!aistudioRes.ok) {
    console.warn(`[fetchService] ${serviceId} aistudio HTTP ${aistudioRes.status}`)
    cancelBody()
    return holdAndReturn(0, `HTTP ${aistudioRes.status}`)
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
    return { incidents: [...primary, ...extras], merged: extras.length, parseErrors: 0, held: 0 }
  } catch (err) {
    console.warn(
      `[fetchService] ${serviceId} aistudio parse failed:`,
      err instanceof Error ? err.message : err,
    )
    cancelBody()
    return holdAndReturn(1, 'parse failed')
  }
}

/**
 * #717 — Read the last-known active aistudio incidents for a service from the cached snapshot
 * (`services:latest`). Returns [] on ANY miss/corruption/throw — a single outer try/catch makes the
 * never-throw contract structural (the fetch path relies on it, and it runs AFTER the primary fetch,
 * so a throw here would discard an otherwise-successful result). CACHE_KEY is referenced at call
 * time (defined later in module init), so the forward reference is safe. Age-capped via
 * `carryOverAistudioIncidents`. Exported for unit testing of the KV-read branches.
 */
export async function readLastKnownAistudioIncidents(
  kv: KVNamespace | undefined,
  serviceId: string,
  now: number,
): Promise<Incident[]> {
  if (!kv) return []
  try {
    const raw = await kv.get(CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { services?: ServiceStatus[] }
    const prev = parsed.services?.find((s) => s.id === serviceId)
    return carryOverAistudioIncidents(prev?.incidents, now)
  } catch (err) {
    console.warn(`[fetchService] ${serviceId} aistudio carry-over read failed:`, err instanceof Error ? err.message : err)
    return []
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
type StatusResolverConfig = Pick<ServiceConfig, 'statusComponent' | 'statusComponentId' | 'statusComponentIds' | 'displayComponentIds' | 'displayAllComponents' | 'componentDenylist' | 'componentSurfaces' | 'componentGroups'>

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
 *   2.5. **`displayAllComponents` dynamic worst-of (#992)** — worst-of every
 *      shown component (all page components minus `componentDenylist`), so a
 *      churny per-model page (Cerebras) tracks new/retired models with no config
 *      edit. After #379 (BFL keeps its curated worst-of), before single-component.
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
  // 2.5. Dynamic mode (#992) — displayAllComponents services badge = worst-of every shown component
  //   (all page components minus componentDenylist names), mirroring the resolveSvcComponents dynamic
  //   breakdown so a new/churned model degrades the badge with NO config edit. Positioned AFTER the
  //   statusComponentIds branch (BFL has BOTH and keeps its curated worst-of) and BEFORE the single-
  //   component branch (so a dynamic service's uptime-primary statusComponentId — e.g. Cerebras'
  //   Developer Console — does not pin the badge to that one component). cohere/groq/together have no
  //   statusComponent* so they returned at branch 1 (overall indicator) already; they never reach here.
  if (config.displayAllComponents && summaryData.components) {
    const deny = new Set((config.componentDenylist ?? []).map((n) => n.toLowerCase()))
    const shown = summaryData.components.filter((c) => !deny.has(c.name.toLowerCase()))
    if (shown.length > 0) {
      return worstStatus(shown.map((c) => normalizeStatus(c.status)))
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
  // `componentGroups` (optional) tags a matched id with its official-status-page group label so
  // the UI collapses same-label components under one header (worst-of on the collapsed header);
  // ids absent from the map stay as individual top-level surface rows.
  const ids = config.displayComponentIds ?? config.statusComponentIds
  if (!ids || ids.length === 0) return []
  const groups = config.componentGroups
  const matched = ids
    .map((id) => summaryData.components!.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => c != null)
    .map((c) => ({
      id: c.id,
      name: c.name,
      status: normalizeStatus(c.status),
      ...(groups?.[c.id] ? { group: groups[c.id] } : {}),
    }))
  // ≥2 only — a one-row breakdown adds nothing the badge doesn't already say.
  return matched.length >= 2 ? matched : []
}

/**
 * #606 Cat B — pick the component list the breakdown resolves from. When a `componentsUrl`
 * (components.json) fetch yields a non-empty array, use it (a superset of summary.json's
 * components on shared pages, e.g. status.openai.com); otherwise fall back to summary.json's.
 * Pure so the merge decision is unit-testable; the fetch itself stays in fetchService.
 */
export function pickBreakdownComponents(
  summaryComponents: Array<{ id: string; name: string; status: string }> | undefined,
  fetchedComponents: unknown,
): Array<{ id: string; name: string; status: string }> | undefined {
  if (Array.isArray(fetchedComponents) && fetchedComponents.length > 0) {
    return fetchedComponents as Array<{ id: string; name: string; status: string }>
  }
  return summaryComponents
}

/** #802 — minimum days of AIWatch coverage before a service is eligible for the Reliability Ranking. */
export const MIN_COVERAGE_DAYS = 30

/** #1006 — the uptime window AIWatch presents and scores on, computed by us from the provider's own
 *  records. #1110 — this constant governs the Atlassian + incident.io branch ONLY (the two reads at the
 *  `parseUptimeData` / `computeIncidentIoUptime` call sites): `parseBetterStackUptime`, the Instatus
 *  paths and `computeOnlineOrNotUptime` carry their own `windowDays = 30` default and never import it,
 *  and `platform_avg` narrows its denominator per resource. So do NOT read this as "one window for
 *  every service" — that claim was retracted; see `/methodology` §3 and status-determination.md. */
export const UPTIME_WINDOW_DAYS = 30


/** #809 — id → static `addedAt` ISO date, only for services that carry one. Persisted per-service into
 *  the monthly archive (`/api/report`) so the report-side coverage gate (aiwatch-reports#45) can detect
 *  a service added mid-month by comparing this STATIC date to the report month — `coverageDays` (live,
 *  now-relative) is unusable for a historical month. Absent id = established service = full coverage. */
export const SERVICE_ADDED_AT: Record<string, string> = Object.fromEntries(
  SERVICES.filter((s) => s.addedAt).map((s) => [s.id, s.addedAt as string]),
)

/** #802 — whole days AIWatch has monitored a service, from its `addedAt` date. null when `addedAt` is
 *  absent (an established service → treated as full coverage). Floor of (now − addedAt) in days, never
 *  negative; null on an unparseable date (fail-open: no coverage gate). Pure — unit-tested. */
export function coverageDaysFrom(addedAt: string | undefined, nowIso: string): number | null {
  if (!addedAt) return null
  const ms = Date.parse(nowIso) - Date.parse(addedAt)
  if (Number.isNaN(ms)) return null
  return Math.max(0, Math.floor(ms / 86_400_000))
}

/** #909 — did a service exist during the archive month? A service added AFTER the month never
 *  existed in it; a post-month archive REBUILD (which reads the current services:latest roster)
 *  would otherwise inject it with null month data, leaking into a historical report's monitored
 *  count / "zero incidents" line / uptime+latency tables. Compares the static `addedAt` DATE to the
 *  month's last day (both `YYYY-MM-DD`, lexicographic — slice guards an ISO datetime `addedAt`).
 *  Absent `addedAt` (established service) and genuine mid-month adds (`addedAt ≤ month-end`) are KEPT;
 *  only post-month additions are dropped. Fail-open: a malformed `addedAt` is kept. Pure — unit-tested. */
export function existedInMonth(addedAt: string | undefined, monthEndDate: string): boolean {
  if (!addedAt) return true
  const date = addedAt.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return true // malformed → fail-open (keep, never silently drop a real service)
  return date <= monthEndDate
}

/** #983 — does this incident's title match one of the provider's machine-emitted auto-monitor titles?
 *  Pure. Exact (anchored) patterns only — see `ServiceConfig.autoMonitorTitles`. A service with no
 *  patterns can never tag, so this is opt-in per service. Unit-tested. */
export function isAutoMonitorIncident(inc: Incident, config: ServiceConfig): boolean {
  const patterns = config.autoMonitorTitles
  if (!patterns || patterns.length === 0) return false
  const title = inc.title.trim()
  return patterns.some((re) => re.test(title))
}

/** #983 — stamp `autoMonitor` on every machine-emitted incident. Applied ONCE, to the ServiceStatus
 *  `fetchService` returns, so it survives every parse branch, `filterIncidents`, `includeUntaggedIncidents`
 *  (which re-adds from the RAW parsed array and would bypass a tag stamped inside filterIncidents) and
 *  the aistudio/xAI source merges. It never touches `title` — the #940 review Critical: a title rewrite
 *  before `filterIncidents` drops the incident wholesale when an `incidentKeywords` token lives in the
 *  title. Returns the SAME array reference when nothing matched, so untagged services allocate nothing. */
export function tagAutoMonitorIncidents(incidents: Incident[], config: ServiceConfig): Incident[] {
  if (!config.autoMonitorTitles?.length || incidents.length === 0) return incidents
  let tagged = false
  const out = incidents.map((inc) => {
    if (!isAutoMonitorIncident(inc, config)) return inc
    tagged = true
    return { ...inc, autoMonitor: true }
  })
  return tagged ? out : incidents
}

/** #1032 — can the id-keyed exclude-bypass ever fire for this service? It needs all three: an
 *  `incidentExclude` to veto an incident in the first place, a `statusComponentIds` badge group to
 *  intersect against, and an incident.io page to read `component_impacts` from. Exactly
 *  openai/chatgpt/codex today — the set the blast-radius replay measured (pinned by
 *  `openai-login-attribution.test.ts`, so a config edit that widens or empties it fails loudly).
 *
 *  ONE predicate for EVERY end — the fetch gate (does this service need the page HTML?) and both
 *  readers (`filterIncidents`' #1032 exclude-bypass and `filterByComponentStatus`' #1104 active-keep).
 *  Encoding it per-site is how they silently drift apart into a bypass that never fires: the fetch side
 *  stops supplying `componentIds` and a reader just... never matches, with no error. Same
 *  fix-the-called-path lesson as #966. */
export function canIdBypass(config: ServiceConfig): boolean {
  return !!(config.incidentIoComponentId && config.incidentExclude?.length && config.statusComponentIds?.length)
}

export function filterIncidents(incidents: Incident[], config: ServiceConfig): Incident[] {
  const { incidentKeywords, incidentExclude, incidentComponents } = config
  return incidents.filter((inc) => {
    const title = inc.title.toLowerCase()
    if (incidentExclude?.some((kw) => title.includes(kw.toLowerCase()))) {
      // Bypass exclude when the incident explicitly lists this service's component.
      // Prevents e.g. "claude.ai and API unavailable" from being dropped from the
      // Claude API service just because the title matches the 'claude.ai' exclude
      // pattern (#359).
      if (config.statusComponent) {
        const compLower = config.statusComponent.toLowerCase()
        const incCompNames = (inc.componentNames ?? []).map((n) => n.toLowerCase())
        if (incCompNames.some((n) => n.startsWith(compLower))) return true
      }
      // #1032 — the same bypass on an ID axis, for a service scoped by `statusComponentIds` rather than
      // a `statusComponent` NAME. openai sets no `statusComponent`, so the branch above never runs for
      // it: its 'login' exclude vetoed by title an incident OpenAI itself had tagged onto the API-group
      // Login component, and the openai card showed `degraded` (badge = statusComponentIds worst-of)
      // with an empty incident list. A name-keyed fix could not have been added either — status.openai.com
      // carries TWO components both literally named "Login" (APIs group → openai, ChatGPT group →
      // chatgpt; verified live 2026-07-16 via components.json), so names cannot tell them apart and only
      // the ids can. When the provider tags an incident onto a component in OUR badge group, that is the
      // provider asserting it affects us: it outranks a title substring guess.
      //
      // `componentIds` is tagged at the source from the page HTML (`attachIncidentIoComponentIds`);
      // absent ⇒ no bypass ⇒ pre-#1032 behaviour, so a missing/shape-changed page fails CLOSED (the
      // fetch side warns when that happens — a silent revert to the bug is the failure mode here).
      // Non-regressive by construction, not by luck: an incident only bypasses if its ids intersect
      // this service's own badge group, so the #990 FedRAMP advisory (tagged 'FedRAMP', an id in NO
      // service's `statusComponentIds`) can never reach chatgpt/codex through here.
      if (canIdBypass(config) && inc.componentIds?.length) {
        const badgeIds = config.statusComponentIds!
        if (inc.componentIds.some((id) => badgeIds.includes(id))) return true
      }
      return false
    }
    // aistudio incidents are component-filtered at the parser (components: [API])
    // so the keyword filter — designed to disambiguate the shared gcloud Vertex
    // feed — doesn't apply and would drop legitimate Gemini events whose titles
    // don't mention "gemini" (e.g. "Batch API outage", "File API document
    // processing outage"). See #310.
    if (inc.id.startsWith('aistudio:')) return true
    // #683 — exact-component-name scoping for a SHARED status page where this is the only AIWatch
    // service but siblings' incidents leak (Junie on the shared JetBrains page: a Grazie-only incident
    // must NOT attribute to Junie). EXACT (case-insensitive) match, NOT substring, so 'AI Platform'
    // can't collide with the sibling 'AI Platform China'. An untagged incident (no componentNames)
    // matches nothing → dropped (real Junie incidents always list 'Junie'). Takes precedence over
    // incidentKeywords (a service sets one or the other).
    if (incidentComponents && incidentComponents.length > 0) {
      const allow = new Set(incidentComponents.map((n) => n.toLowerCase()))
      return (inc.componentNames ?? []).some((n) => allow.has(n.toLowerCase()))
    }
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

/** Normalize a title for `titleMap` lookup: lowercase + strip ALL whitespace. This matches the
 *  flexibility of the `autoMonitorTitles` regexes (`/i` + `\s*`), so a title the tagger matched is a
 *  title the map recognizes — otherwise a casing/spacing variant is tagged `autoMonitor` but NOT
 *  translated, silently surfacing the original (non-English) string downstream (#989 review). */
function normalizeTitleKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '')
}

/**
 * #989 — rewrite non-English incident titles to English via a per-service `titleMap` (Moonshot's
 * Atlassian page emits Chinese titles). Applied to the OUTPUT of the incident pipeline — AFTER
 * filterIncidents / includeUntaggedIncidents / filterByComponentStatus — so every filter above still
 * matches the ORIGINAL title (incidentExclude, incidentKeywords, the #970 component guard read the
 * source string) while every downstream consumer (dashboard, RSS, Discord, the AI prompt,
 * flapSuppressionKey, the #827 corpus) sees the English one. This ordering avoids the #940 class of bug
 * (a title transform BEFORE the filter dropping incidents whose keyword tokens it destroyed).
 *
 * Match is case/whitespace-insensitive (`normalizeTitleKey`), aligned to the `autoMonitorTitles`
 * regexes so every tagged variant translates. An unmapped title passes through UNCHANGED — never
 * dropped. No `titleMap` → identity (same reference). ANY unmapped incident whose title still carries
 * CJK text warns loudly (not just `autoMonitor` ones — a real gateway incident arrives in Chinese too,
 * and its untranslated headline is the class most worth surfacing): the map is missing an entry and the
 * raw title would ship untranslated to the dashboard/RSS/Discord/AI prompt — a config gap made visible
 * rather than silent. Pure aside from that diagnostic; exported for unit testing.
 */
export function applyTitleMap(incidents: Incident[], config: ServiceConfig): Incident[] {
  const map = config.titleMap
  if (!map) return incidents
  const lookup = new Map<string, string>()
  for (const [k, v] of Object.entries(map)) lookup.set(normalizeTitleKey(k), v)
  return incidents.map((inc) => {
    const mapped = lookup.get(normalizeTitleKey(inc.title))
    if (mapped) return { ...inc, title: mapped }
    // Unmapped → pass through. A title still carrying CJK on a titleMap service is a config gap (a
    // variant the map lacks) — warn so it isn't silent, whether or not it was autoMonitor-tagged.
    if (/[㐀-鿿]/.test(inc.title)) {
      console.warn(`[applyTitleMap] ${config.id}: incident title not in titleMap — untranslated non-English text will surface${inc.autoMonitor ? ' (autoMonitor)' : ''}: ${JSON.stringify(inc.title)}`)
    }
    return inc
  })
}

/** #1104 — `${serviceId}:${incidentId}:${hourBucket}` already warned about in THIS isolate. Log
 *  throttle only; nothing reads it for a decision, so isolate recycling losing it is harmless (it just
 *  re-arms the warn). Hour-bucketed and deleted on the keep path so recurrence stays visible. */
const warnedMissingJoin = new Set<string>()
const missingJoinKey = (serviceId: string, incidentId: string) =>
  `${serviceId}:${incidentId}:${Math.floor(Date.now() / 3_600_000)}`

/** Test-only. The Set is module state, so without this a test asserting "the warn fired once" silently
 *  reads 0 the moment any earlier test drives the same (service, incident) through the drop — and a 0
 *  reads as "the warn stopped working", the very thing that assertion exists to catch. */
export function __resetMissingJoinWarnThrottle(): void { warnedMissingJoin.clear() }

/**
 * Two independent rules, in order:
 *   1. `scopeIncidentsToComponent` (#934/#1090, opt-in — `claude` only) — drop any incident whose
 *      `componentNames` name no component in THIS service's badge group, regardless of the incident's
 *      status AND regardless of our own. Untagged ⇒ keep (fail-open).
 *   2. #228/#970 (not flag-gated) — when our component is `operational`, drop ACTIVE incidents, since
 *      providers like Anthropic bulk-link an incident to every component even when one is affected.
 *
 * #934 — rule 1, first version. The operational branch retained ALL resolved/monitoring incidents,
 * which cross-attributed a sibling-component-only incident to this service ONCE IT RESOLVED. `claude`
 * (Claude API) has no positive `incidentKeywords` — it relies on title-based `incidentExclude` + this
 * component-status guard — so a Claude-Code-only incident whose title names no exclude keyword (the
 * 2026-07-06 "Claude Tag seeing elevated GitHub operation failures", componentNames: ['Claude Code'])
 * stayed in claude's candidate set. While active it was hidden here (Claude API component operational
 * → drop unresolved); the moment it RESOLVED this guard kept it → it surfaced under Claude API + fired
 * a Claude-API-included recovery alert. #934 therefore scoped resolved/monitoring incidents by name.
 *
 * #1090 — but #934 put that check INSIDE the `componentStatus === 'operational'` gate, so it could
 * only ever run while our component was fine. Once `claude` was degraded by an unrelated incident the
 * early return skipped BOTH rules and a Claude-Code-only incident was attributed to Claude API again
 * (2026-07-20, verified in production). Rule 1 was hoisted above the gate and now applies to every
 * incident status; membership widened from `statusComponent` prefix-only to badge-group-or-prefix, so
 * one predicate (`inBadgeGroup`) answers this question for both rules. Extensionally identical for
 * `claude` today — its badge group resolves to ['claude api (api.anthropic.com)', 'claude api'], both
 * of which prefix-match — so the widening is latent until a future opt-in sets `statusComponentIds` ALONGSIDE a `statusComponent`
 * name — ids alone leave rule 1 inactive entirely (see the INACTIVE warn below).
 *
 * Rule 1 is default-off so single-tenant services (mistral/perplexity/fal, whose broad
 * `statusComponent: 'API'` would wrongly drop a specific-component incident) and keyword-scoped
 * siblings (claudeai/claudecode) are byte-unchanged in BOTH branches. Rule 2 is NOT flag-gated, so it
 * does apply to claudeai/claudecode — they set `apiUrl` + `statusComponentId` and so reach this guard.
 *
 * #970 — the active-drop rests on the premise "our component is operational ⇒ this incident is not
 * about us". That premise only holds when the incident degraded SOME component, i.e. `impact >= minor`
 * (Statuspage derives `impact` from the worst status of the components linked to the incident — unless
 * the provider sets an `impact_override`, the one case where `none` does not imply "nothing degraded").
 * For an `impact: none` incident there is no degraded sibling to contrast against, so "our component is
 * operational" carries zero information and the guard
 * discarded a genuine incident on every cron cycle — invisibly, because `buildIncidentAlerts` then saw
 * an empty list (no New alert) and the resolved path requires a prior New alert to fire. Runway's
 * 2026-07-08 "Aleph 2.0 delayed generations" (impact none, 23min) reached NEITHER Discord nor Slack,
 * yet surfaced on the dashboard once resolved (resolved incidents pass this guard). Every
 * component-scoped Statuspage service was exposed (18 of them at the time).
 *
 * So an ACTIVE incident survives an operational component on the NAME axis only when BOTH hold:
 *   1. `impact == null` (Statuspage `none`) — the provider itself claims no availability impact, and
 *   2. its `componentNames` name a component in THIS service's badge group.
 * Both are required on that axis. (#1104 adds a second, independent survival path on the ID axis —
 * `componentIds` ∩ this service's badge-group ids — which is impact-INdependent; see the comment at
 * the keep itself. Read the two as separate routes, not as extra clauses of this one.)
 * Anthropic's bulk-link — the #228 target — attaches 4 of 6 components, a strict
 * subset that DOES intersect the Claude API badge group, so (2) alone would regress #228; its impact is
 * always `minor`/`major`, so (1) is what separates the two. (2) then keeps a Billing/Support-only
 * `impact: none` incident (outside the badge group) from alerting. An UNTAGGED `impact: none` incident
 * is dropped rather than fail-open: on a shared page it would otherwise leak onto every sibling service.
 *
 * The `impact === null` ⇒ Statuspage `none` reading only holds for STATUSPAGE-sourced incidents (see
 * `parsers/statuspage.ts`, which maps anything outside {critical,major,minor} to null). Other parsers
 * (instatus/betterstack) also null out an UNMAPPED severity, where null means "unknown", not "none".
 * The sole call site is inside the statuspage `apiUrl` branch, so the invariant holds — keep it that way.
 *
 * Every drop here is a *silent* one (no alert, no dashboard row until it resolves) — that silence IS
 * bug #970. So the two cases where we cannot actually judge are made observable rather than quiet:
 *   - badge group unresolvable (`components` empty / every configured id missing from the page) → we
 *     have nothing to match against, so FAIL OPEN (keep + warn). Dropping a real alert is worse than a
 *     phantom, the same trade `shouldHoldNewIncident` makes. A partially-resolved group is already
 *     surfaced by the #135 miss-check below (primary id → Discord; secondary ids → warn).
 *   - untagged `impact: none` → still dropped (shared-page leak), but warn so it is never invisible.
 */

export function filterByComponentStatus(
  incidents: Incident[],
  componentStatus: NormalizedStatus,
  config: ServiceConfig,
  components: Array<{ id: string; name: string }>,
): Incident[] {
  if (!config.statusComponentId && !config.statusComponent) return incidents
  const ownComponent = config.statusComponent?.toLowerCase()
  const ids = badgeGroupIds(config)
  const badgeGroup = badgeGroupNames(config, components)
  // Ids were configured but NONE resolved (and no `statusComponent` name to fall back on) → the badge
  // group is empty for a reason we cannot distinguish from "matches nothing". Never silently drop on it.
  const unjudgeable = badgeGroup.size === 0 && ids.length > 0
  // Id-resolved names match exactly (same page, same strings); `statusComponent` is a PREFIX by the
  // #359 convention ('Claude API' must match the page's 'Claude API (api.anthropic.com)').
  const inBadgeGroup = (names: string[]) =>
    names.some(n => badgeGroup.has(n) || (ownComponent !== undefined && n.startsWith(ownComponent)))

  // #1090 — "does this incident involve MY component?" is independent of whether I am CURRENTLY
  // degraded, so this scoping runs BEFORE the operational gate below. #934 put the same question
  // inside that gate, so a sibling-component-only incident was scoped out only while our component
  // was operational: once `claude` was degraded by an unrelated incident, a Claude-Code-only one was
  // attributed to Claude API (2026-07-20 'Fable 5 requiring usage credits on Max plans', tagged
  // `Claude Code` alone). `claude` has no positive `incidentKeywords` and its title-based
  // `incidentExclude` names no keyword in that title, so nothing else stopped it — and since the
  // filtered list is passed on unchanged, it REACHES the card, the Score inputs (`score.ts`) and
  // `buildIncidentAlerts` (traced through the call graph; the wrong-service alert was not itself
  // observed). Opt-in (claude only) for the reasons in types.ts. Untagged ⇒ ambiguous ⇒ keep.
  // No `!unjudgeable` term here — it could not change the outcome. This rule already requires
  // `ownComponent`, and `inBadgeGroup`'s `startsWith(ownComponent)` fallback is live whenever that is
  // truthy, so an empty badge group can never make the predicate reject everything. (NOT because
  // `badgeGroupNames` always seeds the set with `statusComponent`: its `displayAllComponents` branch
  // returns before that line. No service can reach the gap today — cerebras is the only such shape
  // and sets no `statusComponent` — but the guarantee comes from the prefix fallback, not the seed.)
  const scoped = config.scopeIncidentsToComponent && ownComponent
    ? incidents.filter(i => {
        const names = (i.componentNames ?? []).map(n => n.toLowerCase())
        return names.length === 0 || inBadgeGroup(names)
      })
    : incidents

  // #1090 — the operational branch drops on a self-consistent premise ("we are fine ⇒ not ours").
  // Scoping while we are DEGRADED has no such premise: something is wrong with us and we may have
  // just discarded the only record of it. A degraded badge with an empty incident list is the exact
  // state #1032 filed as a bug, so make the contradiction observable rather than shipping it quietly
  // (#970/#983: a judgement drop must never be silent).
  if (config.scopeIncidentsToComponent && componentStatus !== 'operational' && incidents.length > 0 && scoped.length === 0) {
    console.warn(`[filterByComponentStatus] #1090 ${config.id}: component is ${componentStatus} but component-scoping dropped all ${incidents.length} candidate incident(s) (${incidents.map(i => `${i.id}:[${(i.componentNames ?? []).join('|')}]`).join(', ')}) — a non-operational badge with no incident left to explain it`)
  }
  // A service that opts in with ids but no `statusComponent` NAME silently gets no scoping at all
  // (`openai` is shaped that way today, so this is a realistic next opt-in). Warn rather than no-op.
  // Only that shape reaches here: with NEITHER an id nor a name the early return above already left.
  if (config.scopeIncidentsToComponent && !ownComponent) {
    console.warn(`[filterByComponentStatus] #1090 ${config.id}: scopeIncidentsToComponent is set but no statusComponent NAME is configured — component scoping is INACTIVE for this service`)
  }

  if (componentStatus !== 'operational') return scoped
  return scoped.filter(i => {
    const names = (i.componentNames ?? []).map(n => n.toLowerCase())
    // An active incident survives an operational component by ONE of two independent routes: the ID
    // axis (#1104, immediately below — impact-independent) or the NAME axis (#970, further down —
    // `impact: none` + a badge-group name). Neither implies the other.
    if (i.status !== 'resolved' && i.status !== 'monitoring') {
      // #1104 — the provider tagged this incident onto a component in OUR badge group, so it WAS ours.
      // "We are operational now" is not evidence it never was: an impact window can CLOSE while the
      // incident stays open. Observed 2026-07-21 on openai — `Images` (a badge component) ran
      // partial_outage 12:25→13:31Z on an incident still `identified` at 14:16Z. Dropping it there
      // removed an incident we had already alerted on at 12:33Z, so the is-down page the alert's tweet
      // draft links to rendered "Is OpenAI Down? Operational" with nothing to explain it, for the whole
      // remaining window. Same evidence the #1032 exclude bypass already trusts, which `filterIncidents`
      // acts on one step earlier and this gate then discarded — so it is gated on the SAME `canIdBypass`
      // predicate, per its "ONE predicate for BOTH ends" rule, rather than re-deriving the shape here.
      //
      // Deliberately ABOVE the `impact !== null` drop: the keep is impact-INdependent. A provider's
      // per-component impact RECORD outranks the incident-level impact field — the record is what says
      // it touched us. ID-keyed, not name-keyed: names collide across product groups on a shared page
      // (two "Login" on status.openai.com — the #1032 finding); `componentNames` is a bare tag with no
      // impact window, so keying on it would readmit the over-tagging this rule exists to filter (#228).
      // Matched against `badgeGroupIds(config)`, which is `statusComponentIds ?? [statusComponentId]` —
      // marginally broader than #1032's `statusComponentIds!` in principle, but provably the same set on
      // THIS path: `canIdBypass` itself requires `statusComponentIds?.length`, so `badgeGroupIds` can never
      // fall through to `[statusComponentId]` here. A guarantee, not a config coincidence — do not
      // "align" one side to the other on the assumption that it is.
      //
      // `unjudgeable` is a NAME-resolution failure — every configured id missing from the page's
      // component list, which `badgeGroupNames` can only reach for an id-configured service (it seeds
      // the set with `config.statusComponent`, so a name-configured one never qualifies). It does not
      // apply on this axis: the id intersection needs no resolved name, so a
      // match here is a verdict, not a guess. The BADGE is untouched either way — `svcStatus` is resolved
      // BEFORE this filter runs and merely passed in as `componentStatus`; nothing downstream re-derives
      // status from the returned array. That ORDERING is the guarantee, not any property of this code.
      if (canIdBypass(config) && i.componentIds?.some(cid => ids.includes(cid))) {
        // Re-arm the drop warn below: a later cycle whose join breaks again is a NEW event, not a
        // repeat of the one already logged.
        warnedMissingJoin.delete(missingJoinKey(config.id, i.id))
        return true
      }
      if (i.impact !== null) {
        // #1104 — a MISSING id-join is not a negative verdict, and the two are structurally distinct:
        // `attachIncidentIoComponentIds` writes `componentIds` only when the join produced ids (never an
        // empty array), so absent ⇒ we never got evidence, present-but-no-intersection ⇒ the provider
        // says it is a sibling's. Only the first is a guess, so only the first warns. The call-site warn
        // (`fetchService`) cannot cover this: it is `!tagged.some(...)`, so ONE joining incident silences
        // the whole cycle — and the join is partial in normal operation (measured under #1032 at that
        // call site). Without this line the #1104 keep
        // fails exactly the way #1104 itself failed: silently, with the card back to green and nothing
        // in the logs to distinguish it. What this line does NOT tell you is whether the miss is
        // SYSTEMIC (the HTML was absent or its shape drifted, so nothing joined) or isolated to this
        // one incident — this function cannot see that from here, and the `[fetchService]` warn only
        // fires when NOTHING joined, i.e. never in the common partial-join case. A known limitation,
        // written down rather than left to be rediscovered.
        //
        // The Set is module state and there are MANY isolates, so the real rate is one line per
        // (service, incident, hour) PER ISOLATE, not one per hour. Every failure mode of the throttle
        // is fail-open (more logging), which is the correct direction for a diagnostic.
        //
        // Throttled, NOT silenced. This runs inside `fetchAllServices`, which runs on EVERY /api/status
        // request — not once per cron tick — so an unjoinable open incident would otherwise emit a line
        // per request per service (~1440/day for one polling tab). The key carries an HOUR bucket rather
        // than being permanent: "is this still happening at 16:00?" has to remain answerable, which a
        // once-per-isolate-ever line cannot answer. The keep path also DELETES the key, so a
        // drop → keep → drop transition re-warns instead of going quiet on the second drop — which is
        // the harmful one, since by then the incident is already alerted on and already on the card.
        if (canIdBypass(config) && !i.componentIds?.length && !warnedMissingJoin.has(missingJoinKey(config.id, i.id))) {
          if (warnedMissingJoin.size >= 500) warnedMissingJoin.clear()
          warnedMissingJoin.add(missingJoinKey(config.id, i.id))
          console.warn(`[filterByComponentStatus] #1104 ${config.id}: dropping active incident ${i.id} — it joined NO component_impacts row from the HTML we had this cycle, so the evidence is MISSING, not negative, and the id keep could not judge it`)
        }
        // LIMITATION, by decision. Both the keep and the warn are gated on `canIdBypass`, i.e. exactly
        // openai/chatgpt/codex — because per-component impact WINDOWS are the evidence the keep needs,
        // and only incident.io publishes them. But the failure #1104 filed (an incident we already
        // alerted on vanishing from the card while the alert's link reads Operational) is not
        // openai-specific: for the other services reaching this gate, this `return false` is still
        // silent. Widening the warn alone would emit a line on every ordinary #970 drop, which is the
        // normal case for them and would bury the signal. Recorded so the uncovered span is a known
        // limit rather than an undiscovered blind spot.
        return false
      }
      if (unjudgeable) {
        console.warn(`[filterByComponentStatus] #970 ${config.id}: badge group unresolvable (${ids.join(',')}) — keeping impact:none incident ${i.id} rather than dropping it silently`)
        return true
      }
      // `names` empty ⇒ `some()` is false ⇒ untagged. Warn: we cannot attribute it, so the drop is a
      // guess, not a verdict. A TAGGED non-match (e.g. Billing-only) is a confident drop — no warn.
      if (names.length === 0) {
        console.warn(`[filterByComponentStatus] #970 ${config.id}: dropping UNTAGGED impact:none incident ${i.id} (no componentNames to attribute it by)`)
        return false
      }
      return inBadgeGroup(names)
    }
    // resolved/monitoring: already scoped above when the service opts in (#1090), so nothing further.
    return true
  })
}

/** The component ids this service's badge is scoped to (#970 helper) — `statusComponentIds` when set,
 *  else the single `statusComponentId`, else none (a `statusComponent`-name-only service). */
function badgeGroupIds(config: ServiceConfig): string[] {
  return config.statusComponentIds ?? (config.statusComponentId ? [config.statusComponentId] : [])
}

/**
 * The lowercased component NAMES that make up this service's badge group (#970 helper).
 * `statusComponentIds`/`statusComponentId` are page component IDs, while an `Incident` carries
 * component NAMES — so resolve ids → names through the page's component list. `statusComponent` is
 * already a name (a prefix by the #359 convention), so it joins the set directly. An id we cannot
 * resolve (component renamed/removed) contributes nothing; the caller distinguishes "resolved to
 * nothing" (unjudgeable → fail open) from "matched nothing" (a real non-membership verdict).
 */
export function badgeGroupNames(
  config: ServiceConfig,
  components: Array<{ id: string; name: string }>,
): Set<string> {
  // #992 — a DYNAMIC (displayAllComponents) service's badge group is EVERY shown component (all page
  // components minus componentDenylist), matching its #992 dynamic worst-of badge. Without this the
  // group would collapse to the single statusComponentId (Cerebras' Developer Console) and #970 would
  // silently drop an active impact:none incident naming any OTHER Cerebras model. The guard MIRRORS
  // resolveSvcStatus branch precedence exactly: a service with BOTH flags (BFL) resolves its BADGE via
  // the statusComponentIds worst-of (branch 2, NOT the 2.5 dynamic branch), so its keep-group must stay
  // the curated ids too — else the group would broaden past the badge and #970 would KEEP an impact:none
  // incident the curated badge doesn't cover. So dynamic-group ONLY when there's no statusComponentIds.
  if (config.displayAllComponents && !(config.statusComponentIds && config.statusComponentIds.length > 0)) {
    const deny = new Set((config.componentDenylist ?? []).map((n) => n.toLowerCase()))
    const names = new Set<string>()
    for (const c of components) {
      const lower = c.name.toLowerCase()
      if (!deny.has(lower)) names.add(lower)
    }
    return names
  }
  const names = new Set<string>()
  for (const id of badgeGroupIds(config)) {
    const match = components.find(c => c.id === id)
    if (match) names.add(match.name.toLowerCase())
  }
  if (config.statusComponent) names.add(config.statusComponent.toLowerCase())
  return names
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

// #618 — read the browser-rendered Flashduty feed (pushed to KV by the deepseek-feed Action) and
// normalize it into a ServiceStatus. Returns null when the KV key is absent/expired/corrupt so the
// caller falls through to the frozen-mirror apiUrl path (which keeps incidentSourceStale). On a
// fresh feed the result intentionally DROPS the stale flag — the data is now live, not frozen.
async function readFlashdutyStatus(kv: KVNamespace, config: ServiceConfig, base: ServiceStatus, now: string): Promise<ServiceStatus | null> {
  let raw: string | null
  try {
    raw = await kv.get(DEEPSEEK_FEED_KV_KEY)
  } catch (err) {
    console.warn(`[fetchService] ${base.id} flashduty KV read failed:`, err instanceof Error ? err.message : err)
    return null
  }
  if (!raw) return null
  let parsed
  let fetchedAt: string | undefined
  try {
    const stored = JSON.parse(raw) as StoredFlashdutyFeed
    fetchedAt = stored.fetchedAt
    parsed = parseFlashdutyFeed(stored.feed, { primaryComponentId: config.flashdutyPrimaryComponentId })
  } catch (err) {
    console.warn(`[fetchService] ${base.id} flashduty parse failed:`, err instanceof Error ? err.message : err)
    return null
  }
  const result: ServiceStatus = {
    ...base,
    status: parsed.status,
    lastChecked: now,
    incidents: parsed.incidents,
    // #1006 — COMPUTED over the trailing 30 days from the feed's `component_impacts` intervals, like
    // every other source; the feed's own `component_uptimes` aggregate is used only as the roster.
    ...(parsed.uptime30d != null ? { uptime30d: parsed.uptime30d, uptimeSource: 'official' as const } : {}),
    ...(Object.keys(parsed.dailyImpact).length > 0 ? { dailyImpact: parsed.dailyImpact } : {}),
    ...(parsed.components.length >= 2 ? { components: parsed.components } : {}),
  }
  // A FRESH feed (≤ soft-stale window) → no longer stale: strip the config's incidentSourceStale so
  // ranking/fallback re-include DeepSeek with trustworthy data. An AGING feed (older than the soft
  // window but not yet KV-expired) still serves its live badge/incidents but KEEPS incidentSourceStale
  // so the stale snapshot can't inflate the Score ranking until a fresh scraper push lands.
  const ageS = (Date.parse(now) - Date.parse(fetchedAt ?? '')) / 1000
  const fresh = Number.isFinite(ageS) && ageS <= DEEPSEEK_FEED_SOFT_STALE_S
  if (fresh) delete (result as { incidentSourceStale?: boolean }).incidentSourceStale
  return result
}

/** #689 — Classify a non-OK status-page API response (a real HTTP status from `summaryRes.status`).
 *  A 4xx means the page is gone / deactivated / misconfigured (the SOURCE is dead, not the service) →
 *  treat as a stale dead-source (operational, out of rankings), NOT degraded. A 5xx is transient → the
 *  existing trackFetchFailure → degraded path. (A genuine network error throws and is caught upstream,
 *  so it never reaches here; the defensive 0 → 'transient' only matters in tests.) Exported for testing. */
export function classifyStatusPageFailure(httpStatus: number): 'dead-source' | 'transient' {
  return httpStatus >= 400 && httpStatus < 500 ? 'dead-source' : 'transient'
}

/** #983 — the single tagging choke point. `fetchServiceUntagged` has ~10 return paths (flashduty feed,
 *  summary.json, AWS health, Azure RSS, BetterStack/Instatus/xAI/aistudio, plus the early operational
 *  and error bases); stamping `autoMonitor` on its result covers all of them, and is safe AFTER
 *  filtering because the tag is additive (no `title` mutation → `filterIncidents` is unaffected).
 *
 *  #989 — `applyTitleMap` (non-English → English) runs HERE too, and ORDER MATTERS: tag FIRST, then
 *  map. `autoMonitorTitles` patterns match the provider's ORIGINAL title (Moonshot's Chinese
 *  `Agentic 模型错误报警`, case-insensitively — robust to the auto-monitor's casing drift); mapping first
 *  would leave the tagger matching an English string its Chinese patterns never hit (the tag would
 *  silently never apply — grouping + Score-exclusion both break). Map is likewise AFTER `filterIncidents`
 *  (inside untagged), so every filter still reads the original title (#940). */
// Exported ONLY so a test can drive the REAL production call path end-to-end (parse → filterIncidents
// → includeUntaggedIncidents → tag → titleMap). Unit-testing the pure helpers alone would leave this
// wrapper unguarded: drop a call here, or swap the tag/map order, and every pure test stays green while
// the tag never reaches /api/status (the #966 / #940 "tested twin" failure class — a swapped tag/map
// order was caught in local verification before this shipped).
export async function fetchService(config: ServiceConfig, prefetched?: PrefetchedData, kv?: KVNamespace): Promise<ServiceStatus> {
  const svc = await fetchServiceUntagged(config, prefetched, kv)
  const tagged = tagAutoMonitorIncidents(svc.incidents, config)  // matches ORIGINAL (e.g. Chinese) titles
  const incidents = applyTitleMap(tagged, config)                // THEN rewrite to English
  return incidents === svc.incidents ? svc : { ...svc, incidents }
}

async function fetchServiceUntagged(config: ServiceConfig, prefetched?: PrefetchedData, kv?: KVNamespace): Promise<ServiceStatus> {
  const now = new Date().toISOString()
  let parseErrors = 0 // Track internal parse/fetch failures — prevents resetFetchFailure from masking repeated errors
  // #1089 — set when the Instatus incident parse failed STRUCTURALLY (payload shape moved), as
  // opposed to a page that genuinely lists no incidents. Only the former may not derive a status.
  let instatusParseFailure: InstatusParseFailure | null = null
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
    // #802 — coverage days from addedAt (absent when established), propagated like incidentSourceStale
    // so the ranking gate sees it on every return path. Computed once here at the service's lastChecked.
    ...(config.addedAt ? { coverageDays: coverageDaysFrom(config.addedAt, now) ?? undefined } : {}),
    // Propagated like the flags above so the breakdown order is known on every return path.
    ...(config.componentGroupsInline ? { componentGroupsInline: true } : {}),
  }

  try {
    // #618 — DeepSeek: prefer the browser-rendered Flashduty feed cached in KV by the scraper Action.
    // Fresh feed supersedes the frozen Atlassian mirror and clears incidentSourceStale; missing/
    // expired feed falls through to the apiUrl path below (which keeps the stale flag from base).
    if (config.flashdutyFeed && kv) {
      const fed = await readFlashdutyStatus(kv, config, base, now)
      if (fed) return fed
      // Feed-only service (no apiUrl fallback, e.g. DeepSeek App) and the feed is absent/expired:
      // return an empty stale base rather than fetching the bot-walled statusUrl below (which would
      // reset and falsely mark degraded). base carries incidentSourceStale from config.
      if (!config.apiUrl) return base
    }

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
          // #689 — a 4xx means the status page itself is GONE / deactivated / misconfigured (e.g.
          // Character.AI deactivated its Statuspage → 302 to an inactive page → 401 "page inactive"),
          // NOT that the service is degraded. Don't trackFetchFailure → degraded (a false positive);
          // return a stale base flagged out of rankings (incidentSourceStale). We KEEP fetching apiUrl
          // every cycle, so it auto-recovers to real status the moment the page returns 200. A 5xx /
          // network error stays in the transient trackFetchFailure → degraded path below.
          if (classifyStatusPageFailure(summaryRes.status) === 'dead-source') {
            return { ...base, status: 'operational', incidentSourceStale: true, sourceDead: true }
          }
          // #714 — a 5xx is an INDETERMINATE source verdict, not a recovery. Flag `sourceUnknown` so
          // the source-inactive alert HOLDS a prior dead state this cycle instead of misreading the
          // non-4xx outcome as "source recovered" (the Inactive/Recovered flap). (A 4xx — incl. 429 —
          // is classified `dead-source` above, NOT unknown.)
          const shouldDegrade = await trackFetchFailure(kv, config.id)
          return { ...base, status: shouldDegrade ? 'degraded' : 'operational', sourceUnknown: true }
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

      // #1066 — incident.io "global"/multi-region pages (LangSmith migrated to one) serve `components: []`
      // from the Atlassian v2 compat API; the live data is only in the page-root RSC (`uptimeHtml`). Rebuild
      // a summary.json-shaped object from that HTML so everything below (status resolution, incident parse,
      // calendar, the #135 miss-tracker) runs unchanged. Done here, before the incidents parse, so the
      // rebuilt `incidents` are what parseIncidents reads.
      let uptimeHtml = prefetched?.uptimeHtml
      if (config.incidentIoGlobalPage) {
        if (!uptimeHtml) {
          try {
            const htmlRes = await fetchWithTimeout(config.statusUrl, 5000)
            if (htmlRes.ok) uptimeHtml = await htmlRes.text()
            else { console.warn(`[fetchService] ${config.id} global-page HTML returned HTTP ${htmlRes.status}`); htmlRes.body?.cancel() }
          } catch (err) { console.warn(`[fetchService] ${config.id} global-page HTML fetch failed:`, err instanceof Error ? err.message : err) }
        }
        const rebuilt = uptimeHtml ? parseIncidentIoGlobalPage(uptimeHtml) : null
        if (rebuilt) {
          summaryData = rebuilt
          rawIncData = rebuilt
        } else {
          // Reconstruction failed (no component catalog, or the load-bearing `incidents` array was
          // present-but-unparseable) — the source is UNREADABLE. Do NOT leave the empty summary.json in
          // place: with statusComponentIds set + `components: []`, resolveSvcStatus finds no match and
          // returns the overall indicator (`none`) = a fabricated OPERATIONAL badge during a possible
          // outage. Instead flag `sourceUnknown` + trackFetchFailure — the same path a 5xx summary takes
          // above — so the badge withholds (→ `unknown` after the strike threshold, the #1004 display
          // rule) rather than inventing operational (#713). Auto-recovers the moment the RSC parses again.
          console.warn(`[fetchService] ${config.id}: incidentIoGlobalPage RSC unreadable (HTML ${uptimeHtml ? 'present — upstream shape change?' : 'MISSING'}) — withholding status this cycle`)
          const shouldDegrade = await trackFetchFailure(kv, config.id)
          return { ...base, status: shouldDegrade ? 'degraded' : 'operational', sourceUnknown: true }
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

      // #1004 — incident.io's Statuspage-compat API returns `components: []` on every incident (verified
      // on all four incident.io pages we monitor), so a service scoped by `incidentComponents` would have
      // EVERY incident dropped by the filter below — silently and forever, because the
      // `includeUntaggedIncidents` valve is gated on `incidentKeywords`, which such a service doesn't set.
      // The tags are rebuilt from the page HTML's `component_impacts`, which makes that HTML LOAD-BEARING
      // for correctness, not just for uptime. The prefetch may not have it (its own fetch 5s-timed out,
      // or the whole prefetch entry is missing because summary.json failed that cycle and fetchService
      // re-fetched it above) — so fetch it here rather than silently dropping every incident.
      // (uptimeHtml is declared + possibly populated above for the #1066 global-page rebuild.)
      const tagsNeedHtml = !!(config.incidentComponents && config.incidentIoComponentId)
      // #1032 — the id-axis twin (`canIdBypass`: exclude + badge group + incident.io page). Exactly
      // openai/chatgpt/codex today — the same set the blast-radius replay measured, so the gate states
      // the reachable set rather than widening it. Deliberately NOT "every incident.io service":
      // `attachIncidentIoComponentIds` is cheap but its output would then ride the KV/API payload for
      // the OTHER 9 incident.io services, which can never use it.
      //
      // Side effect worth knowing: this admits openai/chatgpt/codex to the 3s re-fetch below, which was
      // `incidentComponents`-only before. On a cycle where the PREFETCH's own HTML fetch failed, that
      // re-fetched HTML now also reaches `parseUptimeData` / `parseIncidentIoComponentImpacts` /
      // `computeIncidentIoUptime` for these three — so uptime/calendar values appear where the cycle
      // previously yielded `null`. A strict improvement (fewer null cycles), but a real behaviour change
      // outside the #1032 blast radius, and it costs one serial 3s fetch on that failure path only.
      const idsNeedHtml = canIdBypass(config)
      if (!uptimeHtml && (tagsNeedHtml || idsNeedHtml)) {
        try {
          // 3s, not the prefetch's 5s: the prefetch already waited on this same host this cycle, so a
          // serial 5+5s would eat the batch's budget on exactly the page that's already slow.
          const htmlRes = await fetchWithTimeout(config.statusUrl, 3000)
          if (htmlRes.ok) uptimeHtml = await htmlRes.text()
          else {
            // #1032 — a non-OK response logged NOTHING before, and three more services now depend on
            // this HTML for incident-attribution correctness. "MISSING" downstream doesn't say WHY, and
            // 403 (bot-wall — status.deepseek.com already does this) vs 503 are opposite diagnoses.
            console.warn(`[fetchService] ${config.id} status-page HTML returned HTTP ${htmlRes.status}`)
            htmlRes.body?.cancel()
          }
        } catch (err) {
          console.warn(`[fetchService] ${config.id} status-page HTML fetch failed:`, err instanceof Error ? err.message : err)
        }
      }
      if (tagsNeedHtml) {
        // Must precede filterIncidents: a transform after the filter can't resurrect what it dropped (#940).
        const tagged = uptimeHtml
          ? attachIncidentIoComponentNames(incidents, uptimeHtml, summaryData.components ?? [])
          : incidents
        // Fail LOUD, not silent — and OUTSIDE the html guard, so the "no HTML at all" case (the one that
        // drops every incident) is the loudest, not the quietest. Covers both: HTML missing, and HTML
        // present but its shape changed upstream.
        if (incidents.length > 0 && !tagged.some((i) => (i.componentNames ?? []).length > 0)) {
          console.warn(
            `[fetchService] ${config.id}: incidentComponents is set but NO incident could be tagged from ` +
            `component_impacts (uptimeHtml ${uptimeHtml ? 'present — upstream shape change?' : 'MISSING'}) — ` +
            'every incident will be filtered out this cycle',
          )
        }
        incidents = tagged
      }
      if (idsNeedHtml) {
        // Must precede filterIncidents, same reason as #1004 above (#940).
        const tagged = uptimeHtml ? attachIncidentIoComponentIds(incidents, uptimeHtml) : incidents
        // Fail LOUD — and OUTSIDE the html guard, so the "no HTML at all" case is the loudest, not the
        // quietest (the #1004 shape). Without this the #1032 failure mode is invisible: nothing gets
        // tagged, the bypass never fires, and the openai card silently reverts to `degraded` + empty
        // incident list — the exact bug #1032 fixed — with nothing in the logs.
        //
        // Checks CONTENT, not the array reference. `attachIncidentIoComponentIds` returns the same
        // reference only when `component_impacts` is entirely absent — but that array also drives the
        // 30/90-day calendar (`parseIncidentIoComponentImpacts`), so it spans the historical window and
        // is populated on any normal page load regardless of whether the CURRENT incidents join it. A
        // reference check would therefore be silent on the likeliest drift: `status_page_incident_id`
        // diverging from the v2 API's incident id (the #940 id-scheme lesson), where the map is
        // non-empty, `.map()` allocates, and nothing is tagged. Quiet in normal operation — 23 of the
        // 25 live incidents on the page join today, so this only fires when the join breaks entirely.
        if (incidents.length > 0 && !tagged.some((i) => (i.componentIds ?? []).length > 0)) {
          console.warn(
            `[fetchService] ${config.id}: canIdBypass but NO incident could be tagged with component_impacts ` +
            `ids (uptimeHtml ${uptimeHtml ? 'present — upstream shape change?' : 'MISSING'}) — the #1032 ` +
            'exclude-bypass cannot fire this cycle',
          )
        }
        incidents = tagged
      }

      let filtered = filterIncidents(incidents, config)

      // #606 Cat B / #693 follow-up — source the component list from componentsUrl (components.json, a
      // SUPERSET on shared pages like status.openai.com) when set, else summary.json. The page OVERALL
      // indicator, incidents, and uptime still come from summaryData; only the component LIST changes —
      // and it's now read by the BADGE worst-of, the component-miss alert, AND the breakdown alike. This
      // matters because OpenAI's summary.json OMITS core API components (Chat Completions / Embeddings /
      // Moderations); without the superset the badge couldn't see a Chat Completions outage and the
      // statusComponentId miss-check false-fired the migration alert every cycle. One fetch, moved up.
      let breakdownComponents = summaryData.components
      if (config.componentsUrl) {
        const cRes = await fetchWithTimeout(config.componentsUrl, 8000).catch(() => null)
        if (cRes?.ok) {
          try {
            const cJson = await cRes.json() as { components?: unknown }
            breakdownComponents = pickBreakdownComponents(summaryData.components, cJson.components)
          } catch (err) {
            console.warn(`[fetchService] ${config.id} components.json parse failed — using summary.json:`, err instanceof Error ? err.message : err)
          }
        } else cRes?.body?.cancel()
      }
      const badgeSummary = { ...summaryData, components: breakdownComponents }

      // Compute svcStatus BEFORE includeUntaggedIncidents so the
      // cross-contamination guard (#361) can suppress untagged-include for
      // services on shared status pages whose keyword filter found nothing.
      // Without this ordering, an untagged ChatGPT-only incident on
      // status.openai.com leaks into Codex's filtered set: filterIncidents
      // (correctly) drops it, then includeUntaggedIncidents adds it back
      // because the page overall is non-operational. Computing svcStatus first
      // lets resolveSvcStatus detect the empty-filtered case (its scoped
      // statusComponentIds worst-of finds no Codex-component problem) and treat
      // the service as operational, suppressing untagged-include entirely.
      // (Pre-#693 Codex had no statusComponentId and this rode the no-component
      // branch; #693 gave it a scoped worst-of, which now serves the same role.)
      const svcStatus = resolveSvcStatus(config, badgeSummary, filtered)

      // Only fall back to untagged-include when this service is genuinely
      // non-operational. Operational services per the cross-contamination
      // guard above cannot legitimately have untagged incidents to surface.
      if (svcStatus !== 'operational') {
        filtered = includeUntaggedIncidents(filtered, incidents, config, breakdownComponents ?? [], summaryData.status?.indicator ?? 'none')
      }
      if (config.incidentIoBaseUrl) {
        filtered = await enrichIncidentIoText(filtered, config.incidentIoBaseUrl, pageUrls, kv)
      }

      // Compute daily impact for calendar from uptimeData HTML (Statuspage services only).
      // Daily impact for calendar: Statuspage uptimeData OR incident.io component_impacts
      const uptimeResult = (uptimeHtml && config.statusComponentId)
        // #1006 — the same scope the badge + calendar use (worst-of, #379), not the single primary
        // component: a multi-component service showed outages in its incident list while uptime, read
        // from one component, sat at 100%.
        ? parseUptimeData(uptimeHtml, config.statusComponentIds ?? config.statusComponentId)
        : null
      // Aggregate the impact calendar over the whole badge group (statusComponentIds) when set, so a
      // multi-component service's calendar matches its badge scope + the official group calendar
      // (#693 follow-up); else the single primary component. incident.io HTML carries impacts for ALL
      // components (incl. ones absent from summary.json), so the group calendar can be more complete
      // than the summary.json-sourced badge.
      const ioDailyImpact = (uptimeHtml && config.incidentIoComponentId)
        ? parseIncidentIoComponentImpacts(uptimeHtml, config.statusComponentIds ?? config.incidentIoComponentId)
        : null
      // Statuspage uptimeData is the preferred per-day source — but ONLY when it actually produced
      // days. For an incident.io service, parseUptimeData(incident.io HTML) returns an EMPTY map, which
      // must NOT clobber the incident.io impacts (the #693-follow-up calendar-blank regression). So
      // fall through to ioDailyImpact unless the Statuspage map is non-empty.
      const statuspageDaily = uptimeResult?.dailyImpact
      const dailyImpact = (statuspageDaily && Object.keys(statuspageDaily).length > 0)
        ? statuspageDaily
        : (ioDailyImpact && Object.keys(ioDailyImpact).length > 0 ? ioDailyImpact : null)

      // Uptime% — AIWatch COMPUTES it, from the provider's own published records. The two branches below
      // (Atlassian + incident.io) share ONE formula and ONE window (30 days); #1110 — the other sources
      // do NOT, so this sentence stops here and does not generalise to every service:
      //   Atlassian    → parseUptimeData sums the per-day outage SECONDS the page publishes, over the
      //                  TRAILING 30 of the ~90 days it embeds (#1006 — the pre-fix code divided by all
      //                  90, so `uptime30d` held a ninety-day figure).
      //   incident.io  → computeIncidentIoUptime sums the component_impacts intervals over 30 days.
      // Both use the weights on /methodology (full outage 1.0, partial/degraded 0.3, announced
      // maintenance excluded). This is what makes the Score coherent — its other components (Incidents
      // 25, Recovery 15) are 30-day — and the Reliability Ranking comparable at all.
      //
      // `uptimeReported` is set ONLY for incident.io, where the page publishes ONE fixed aggregate that
      // genuinely differs from our measure (LangSmith's page really does show 98.48% while its trailing-30
      // record is spotless). An Atlassian page has no such single number — its window follows the viewport
      // (90/60/30 days) — so there is nothing to place beside ours.
      let uptimeValue: number | null = null
      let uptimeSrc: 'official' | undefined
      let uptimeWindow: number | undefined
      let uptimeRep: number | undefined
      let uptimeRepDays: number | undefined
      if (uptimeResult?.uptimePercent != null) {
        uptimeValue = uptimeResult.uptimePercent
        uptimeSrc = 'official'
        if (uptimeResult.windowDays != null && uptimeResult.windowDays < UPTIME_WINDOW_DAYS) uptimeWindow = uptimeResult.windowDays
        // The provider's own figure IS shown for Atlassian too — the ~90-day number a desktop visitor
        // sees on their page (status.claude.com: "90 days ago … 99.58%"). Its period is stated, because
        // theirs isn't fixed: the page renders 30 / 60 / 90 days depending on viewport width.
        if (uptimeResult.uptimeReported != null && uptimeResult.uptimeReported !== uptimeValue) {
          uptimeRep = uptimeResult.uptimeReported
          uptimeRepDays = uptimeResult.uptimeReportedDays ?? undefined
        }
      } else if (uptimeHtml && config.incidentIoComponentId) {
        // #1006 — uptime is computed over the SAME component scope the badge and the impact calendar use
        // (`statusComponentIds`, worst-of per #379), not over the single `incidentIoComponentId`.
        // LangSmith exposed the gap: its badge spans API + Run Ingestion + Application, but uptime read
        // only the API component — so a partial outage on Run Ingestion showed up in the incident list
        // while uptime sat at a spotless 100%. The old 90-day published figure happened to be low enough
        // that nobody noticed; computing an honest 30 days made the mismatch visible.
        // `incidentIoComponentId` still identifies which figure the PAGE displays (uptimeReported).
        const uptimeScope = config.statusComponentIds ?? config.incidentIoComponentId
        const io = computeIncidentIoUptime(uptimeHtml, uptimeScope, Date.now())
        if (io) {
          uptimeValue = io.pct
          uptimeSrc = 'official'
          // A status-page migration creates a NEW component whose records may not reach back 30 days.
          // The figure is honest for the days it covers — surface WHICH, rather than passing a short
          // window off as a 30-day one. Absent when the window is whole. (junie itself dodges this by
          // sourcing uptime from the older Central Console component — see its config comment.)
          if (io.days < UPTIME_WINDOW_DAYS) uptimeWindow = io.days
          const reported = parseIncidentIoReportedUptime(uptimeHtml, config.incidentIoComponentId, config.incidentIoGroupId)
          // Shown whenever it differs at all — no "meaningful gap" threshold. A cutoff would be an
          // editorial judgement made from one day's snapshot, and it would give the reader an invisible
          // rule ("why does LangSmith show two numbers and OpenAI one?"). A near-identical pair is not
          // noise either: it CORROBORATES our figure against the provider's. Identical → nothing to say.
          if (reported != null && reported !== uptimeValue) uptimeRep = reported
        }
        // #713 — NO invented uptime. A component the page does not track at all (no
        // `data_available_since`) yields null here rather than a fabricated 100%: absence of impact
        // records is not evidence of absence of downtime. The service is then scored on its incidents +
        // recovery (+ probe), and the display reads "No official uptime".
      }
      // (a bare incidentIoComponentId with no uptime HTML also leaves uptime null — same #713 rule.)

      // Component-scope the incidents, then drop active ones when our component is operational
      // (#934/#1090 + #228). #970 — pass the resolved component list (the SAME superset the badge
      // resolves from) so the guard can map `statusComponentIds` → component NAMES and keep an
      // `impact: none` incident that genuinely names one of our badge-group components. `?? []`
      // mirrors includeUntaggedIncidents above. For the #970 branch an empty list still means fail
      // OPEN + warn; #1090's scoping does NOT consult `unjudgeable`, so for an opting-in service the
      // prefix fallback keeps judging (and a sibling-tagged incident is still dropped) — see its doc.
      filtered = filterByComponentStatus(filtered, svcStatus, config, breakdownComponents ?? [])

      // Track component ID misses for migration detection (#135).
      // Primary statusComponentId drives the alerted-on tracker. Additional ids
      // from statusComponentIds (#379) are warn-logged so operators can reconcile
      // without triggering Discord alerts that would fire repeatedly per surface.
      // Track component ID misses against breakdownComponents (the SAME superset the badge resolves
      // from) — so a components.json-only primary (OpenAI's Chat Completions, absent from summary.json)
      // is correctly found and the migration alert (#135) doesn't false-fire (#693 follow-up).
      if (config.statusComponentId && breakdownComponents) {
        const compFound = breakdownComponents.some((c) => c.id === config.statusComponentId)
        if (!compFound) {
          const available = breakdownComponents.map((c) => `${c.id}:${c.name}`).join(', ')
          console.warn(`[fetchService] Component ID not found: ${config.id} (${config.statusComponentId}). Available: ${available}`)
          await trackComponentMiss(kv, config.id)
        } else {
          await resetComponentMiss(kv, config.id)
        }
      }
      if (config.statusComponentIds && breakdownComponents) {
        const missing = config.statusComponentIds.filter(
          (id) => id !== config.statusComponentId && !breakdownComponents!.some((c) => c.id === id),
        )
        if (missing.length > 0) {
          console.warn(`[fetchService] ${config.id} additional component ids missing: ${missing.join(', ')}`)
        }
      }
      // #606 — drift signal for the display-only breakdown list. These services have no
      // statusComponentId/Ids, so without this a renamed/removed curated component would silently
      // shrink the breakdown (or drop it under the ≥2 gate) with no operator signal. Checks
      // breakdownComponents (the resolved source), so componentsUrl-backed ids aren't false-flagged.
      if (config.displayComponentIds && breakdownComponents) {
        const missing = config.displayComponentIds.filter(
          (id) => !breakdownComponents!.some((c) => c.id === id),
        )
        if (missing.length > 0) {
          console.warn(`[fetchService] ${config.id} displayComponentIds missing (breakdown drift): ${missing.join(', ')}`)
        }
      }
      // #662 — dailyImpact is kept as a PURE official record (no ongoing-incident augmentation here).
      // The removed augment keyed an ongoing incident by its UTC `startedAt` day, so Phase 1's
      // noon-UTC→local remap could land the cell on a different local day than the incident's true
      // local start; it also only ever painted the single start day (never extended to "today") and
      // used a coarser severity map (major→critical/red). That forward-fill now lives in the frontend
      // calendar (Phase 3, source-aware), which keys the incident directly in local time so "today" is
      // unambiguous. (dailyImpact is consumed only by buildCalendarFromIncidents.)

      // Successful fetch — reset or track based on parse errors
      if (parseErrors > 0) {
        console.warn(`[fetchService] ${config.id} completed with ${parseErrors} parse error(s)`)
        await trackFetchFailure(kv, config.id)
      } else {
        await resetFetchFailure(kv, config.id)
      }

      // #604 — preserve the curated per-component snapshot for the breakdown UI (source picked above).
      // resolveSvcComponents self-gates to ≥2 matched (a single component is redundant with the badge).
      const components = resolveSvcComponents(config, { ...summaryData, components: breakdownComponents })

      return {
        ...base,
        status: svcStatus,
        latency: config.category === 'api' ? latency : null,
        incidents: filtered,
        ...(components.length > 0 ? { components } : {}),
        ...(dailyImpact && Object.keys(dailyImpact).length > 0 ? { dailyImpact } : {}),
        calendarDays: config.statusComponentId ? 30 : 14,
        ...(uptimeValue != null ? { uptime30d: uptimeValue, uptimeSource: uptimeSrc } : {}),
        ...(uptimeWindow != null ? { uptimeWindowDays: uptimeWindow } : {}),
        ...(uptimeRep != null ? { uptimeReported: uptimeRep } : {}),
        ...(uptimeRepDays != null ? { uptimeReportedDays: uptimeRepDays } : {}),
      }
    } else {
      // No Statuspage API — HTTP check + optional scraping (parallel)
      // Uses fetchWithTimeout (no retry) to stay within 50-subrequest budget
      // #677 — AWS Health public events JSON API (one fetch, all regions, real start+end timestamps)
      if (config.awsHealthApi) {
        const start = Date.now()
        const res = await fetchWithTimeout(config.awsHealthApi.url, 8000, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIWatch/1.0; +https://ai-watch.dev)' },
        }).catch((err) => {
          console.warn(`[fetchService] ${config.id} AWS Health API failed:`, err instanceof Error ? err.message : err)
          return null
        })
        const latency = Date.now() - start
        if (!res || !res.ok) {
          if (res) { console.warn(`[fetchService] ${config.id} AWS Health API HTTP ${res.status}`); res.body?.cancel() }
          const shouldDegrade = await trackFetchFailure(kv, config.id)
          return { ...base, status: shouldDegrade ? 'degraded' : 'operational', incidents: [], latency: config.category === 'api' ? latency : null }
        }
        // Decode the utf-16 (BOM-detected) JSON. A 200 with an unparseable body means the endpoint's
        // shape/encoding drifted \u2014 treat that like a fetch failure (degrade + trip the persistent-block
        // alert) instead of resetting the failure counter and silently showing "operational, no
        // incidents", which would hide a real outage on this undocumented endpoint (#677 review).
        let json: unknown = null
        try {
          json = decodeAwsHealthJson(await res.arrayBuffer(), res.headers.get('content-type'))
        } catch (err) {
          console.warn(`[fetchService] ${config.id} AWS Health API decode/parse failed (ct=${res.headers.get('content-type')}):`, err instanceof Error ? err.message : err)
        }
        if (json === null) {
          const shouldDegrade = await trackFetchFailure(kv, config.id)
          return { ...base, status: shouldDegrade ? 'degraded' : 'operational', incidents: [], latency: config.category === 'api' ? latency : null }
        }
        await resetFetchFailure(kv, config.id)
        const incidents = parseAwsHealthEvents(json, config.awsHealthApi.service)
        const filtered = filterIncidents(incidents, config)
        // #574 — derive currently-degraded AWS regions from the SAME events JSON (all AWS services),
        // attached to bedrock so the supply-chain banner can correlate without an extra fetch.
        const awsRegionHealth = config.id === 'bedrock' ? parseAwsRegionHealth(json) : undefined
        // #713 — AWS Health is an incident feed, NOT a rolling uptime %. We do NOT invent an estimate:
        // uptime stays null (display: "No official uptime — incident-tracked") and the Score is computed
        // on incidents + recovery only. The honest "official-first, no fabricated value" position.
        return {
          ...base,
          status: deriveAwsStatus(filtered),
          latency: config.category === 'api' ? latency : null,
          incidents: filtered,
          calendarDays: 14,
          ...(awsRegionHealth && Object.keys(awsRegionHealth).length > 0 ? { awsRegionHealth } : {}),
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
        // #713 — Azure RSS is an incident feed, not a rolling uptime %. No invented estimate: uptime
        // stays null ("No official uptime — incident-tracked"), Score computed on incidents + recovery.
        return {
          ...base,
          status: deriveAwsStatus(filtered),
          latency: config.category === 'api' ? latency : null,
          incidents: filtered,
          calendarDays: 14,
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
      let instatusUptime: number | null = null // #627 — Instatus per-component official uptime%
      let instatusReported: number | null = null // #1006 — the page's own published aggregate (disclosure)
      let instatusReportedDays: number | null = null
      let instatusComponents: ServiceComponent[] = [] // #761 — Instatus per-component snapshot (Next.js reads a published status; Nuxt derives one)
      if (config.onlineOrNotUrl && res.ok) {
        const html = await res.text()
        incidents = parseOnlineOrNotIncidents(html)
        // #1006 — computed over the trailing 30 days from the page's own incident records (started/ended/
        // impact), instead of reading its aggregate over an unknown period. It's
        // the PROVIDER's own status page (not a third-party monitor), so this is 'official', not platform.
        const uptime = computeOnlineOrNotUptime(html)
        if (uptime != null) {
          base.uptime30d = uptime
          base.uptimeSource = 'official'
        } else {
          console.warn(`[fetchService] ${config.id} OnlineOrNot uptime could not be computed (payload shape change?)`)
        }
      } else if (config.onlineOrNotUrl && !res.ok) {
        console.warn(`[fetchService] ${config.id} OnlineOrNot status page returned ${res.status}`)
        res.body?.cancel()
      } else if (config.instatusUrl) {
        // #1089 — this arm is entered for an Instatus service even when the scrape did NOT come back
        // ok, deliberately. Gating it on `scrapeRes?.ok` (the original shape) meant a failed scrape
        // skipped the whole block — including the MAIN-PAGE read below, which is a separate fetch and
        // usually still fine. That turned one unreadable incident list into a total loss of uptime +
        // the components snapshot. The scrape result is now checked inside, so the two fetches fail
        // independently, as they actually do.
        // #1089 — a STRUCTURAL parse failure must not read as "no incidents". On this branch the
        // badge is `hasOngoing ? 'degraded' : httpStatus`, so an empty list is what makes a service
        // look operational; collapsing a failed parse to `[]` published a false RECOVERY while the
        // incident was still open upstream (observed 2026-07-20, Mistral). The gap was already
        // written down at the top of this file in #761's note — that fix removed one trigger (a
        // 301'ing scrape URL), not the class.
        const parsed = scrapeRes?.ok
          ? parseInstatusIncidentsResult(await scrapeRes.text())
          // The scrape fetch itself failed (`.catch(() => null)`) or returned non-ok. The 404 case is
          // #761's URL-drift scenario — the likeliest real trigger — and it left `incidents` empty
          // with no marker, falling through to `httpStatus` exactly as a bad parse did.
          : ({ ok: false, reason: 'scrape-unreadable' } as const)
        if (!scrapeRes?.ok) {
          console.warn(`[fetchService] ${config.id} Instatus scrape unreadable (${scrapeRes == null ? 'fetch failed' : `HTTP ${scrapeRes.status}`}) — NOT treating as "no incidents"`)
          scrapeRes?.body?.cancel()
        }
        if (parsed.ok) {
          incidents = parsed.incidents
        } else {
          instatusParseFailure = parsed.reason
          console.warn(`[fetchService] ${config.id} Instatus incident parse failed (${parsed.reason}) — NOT treating as "no incidents"`)
          // Deliberately NOT `parseErrors++`: the guard below returns before this branch's
          // `if (parseErrors > 0)` accounting can run, so incrementing here would look like it
          // books the failure while doing nothing. The guard calls `trackFetchFailure` itself —
          // one accounting site, reachable.
        }
        // #627/#635 — Instatus exposes uptime per component (no summary.json). It lives on the MAIN
        // status page (res = statusUrl), not the /incidents listing scraped above — so read res
        // here to extract the named component's uptime% (mistral 'API' Nuxt flat-ref; perplexity
        // 'API' Next.js componentsUptime[id].uptime). Else it shows "Not provided".
        // #761 — the same main-page HTML also carries the per-component snapshot (Next.js publishes a
        // per-component status; Nuxt has none, so parseInstatusComponents derives it from that page's
        // component tree + ongoing-incident attribution), so read it ONCE for uptime + components.
        if (res.ok) {
          const mainHtml = await res.text()
          if (config.statusComponent) {
            instatusUptime = parseInstatusUptime(mainHtml, config.statusComponent)
            // #1006 — the % the page itself shows (over its own ~90-day period), for the side-by-side
            // disclosure. Only kept when it differs from our computed figure.
            instatusReported = parseInstatusReportedUptime(mainHtml, config.statusComponent)
            instatusReportedDays = parseInstatusUptimeDays(mainHtml)
          }
          const instatusComps = parseInstatusComponents(mainHtml)
          if (instatusComps.length > 0) {
            instatusComponents = resolveSvcComponents(config, { components: instatusComps })
            // #761 — the #606 curated-id drift signal above is inside the ATLASSIAN branch and gates on
            // `breakdownComponents`, so it never sees Instatus services (fal/perplexity/mistral) even
            // though they carry the same hand-maintained `displayComponentIds`. Mistral's is another
            // hand-maintained 12-id list; a rotated/renamed id would drop the breakdown
            // under the ≥2 gate AND silently revert #1062 routing (components.length === 0 →
            // routingTier null). Same warn, applied to the branch that actually produced these.
            if (config.displayComponentIds) {
              const missing = config.displayComponentIds.filter(
                (id) => !instatusComps.some((c) => c.id === id),
              )
              if (missing.length > 0) {
                console.warn(`[fetchService] ${config.id} displayComponentIds missing (Instatus breakdown drift): ${missing.join(', ')}`)
              }
            }
          } else if (config.displayComponentIds) {
            // A service we asserted SHOULD have a breakdown produced none. Distinguishes "parse
            // yielded nothing" from the ordinary "this page has no components" case, which the
            // bare `length > 0` guard otherwise collapses together.
            console.warn(`[fetchService] ${config.id} has displayComponentIds but the Instatus page yielded no components (parse/shape drift?)`)
          }
        } else {
          res.body?.cancel()
        }
      } else if (scrapeRes?.ok) {
        // Cancel statusUrl response body — only res.ok/status is needed for RSS / gcloud services
        res.body?.cancel()
        if (config.rssFeedUrl) {
          const rssText = await scrapeRes.text()
          incidents = config.rssFeedUrl.includes('status.x.ai')
            // #940 — collapse xAI per-region incidents (same event across us-east-1/eu-west-1/…) to
            // ONE canonical incident at the source, so the dashboard list, Analyze modal, RSS/Slack
            // feed, and Discord new+resolved alerts all see a single incident (the older per-surface
            // merges were cycle-local and leaked duplicates across cron cycles).
            ? mergeXaiRegionalIncidents(parseXaiRssIncidents(rssText))
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

      if (config.aistudioStatus) {
        // #717 — recover the last-known active aistudio incidents from the prior snapshot when the
        // gated/intermittent aistudio read fails (threw → null / non-OK / unparseable), instead of
        // silently dropping to vertex-only (which made a Gemini incident flap in/out of the dashboard
        // per refresh). All three failure modes funnel through mergeAistudioIncidents; the KV read is
        // lazy (only on a failed read).
        const getCarryOver = () => readLastKnownAistudioIncidents(kv, config.id, Date.now())
        const merge = await mergeAistudioIncidents(incidents, aistudioRes, config.id, getCarryOver)
        incidents = merge.incidents
        parseErrors += merge.parseErrors
      }

      // Better Stack uptime + status: parse /index.json for aggregate_state and availability
      let betterStackUptime: number | null = null
      let betterStackReported: number | null = null // #1006 — the page's displayed availability (disclosure)
      let betterStackStat: 'operational' | 'degraded' | 'down' | null = null
      let betterStackPartial = 0
      let betterStackComponents: ServiceComponent[] = []
      let bsDailyImpact: Record<string, DailyImpactLevel> | null = null
      if (betterStackRes && !betterStackRes.ok) {
        console.warn(`[fetchService] ${config.id} BetterStack index.json returned HTTP ${betterStackRes.status}`)
        betterStackRes.body?.cancel()
      }
      if (betterStackRes?.ok) {
        try {
          const bsData: BetterStackIndex = await betterStackRes.json()
          betterStackUptime = parseBetterStackUptime(bsData)
          betterStackReported = parseBetterStackReportedUptime(bsData)
          betterStackStat = parseBetterStackStatus(bsData)
          betterStackPartial = parseBetterStackPartialCount(bsData)
          // #606 Cat C — per-resource breakdown grouped by status_page_section (display-only;
          // status/uptime/incidents are unchanged). componentDenylist drops noise sections (e.g. Website).
          betterStackComponents = parseBetterStackComponents(bsData, { denylist: config.componentDenylist })
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

      // #1089 — the incident list is unreadable, so `hasOngoing === false` above carries no
      // information and `derivedStatus` must not be published. Route through the SAME primitive the
      // two sibling unknown-source paths already use (the summary 5xx / throw returns below):
      // `sourceUnknown` + `trackFetchFailure`'s consecutive-failure gate, so the UI says "we cannot
      // read this source" (`svc.sourceUnknown.*`, #1004) instead of showing a green badge, and a
      // single transient blip does not fabricate an outage either. This closes the case #761's note
      // at the top of this file described but only mitigated: the discarded `shouldDegrade`.
      if (instatusParseFailure) {
        // #1089 follow-up — book EVERY failure, not just the 3-strike crossings `trackFetchFailure`
        // records. A single failed cycle already drops the service out of `/api/statusline/down` and
        // makes the plugin monitor emit a false "✅ recovered", so the rising-edge counter is blind to
        // the metric the remaining decision needs. 30d retention, so a weekly check sees the window.
        await recordParseFailure(kv, Date.now(), config.id, instatusParseFailure)
        const shouldDegrade = await trackFetchFailure(kv, config.id)
        return {
          ...base,
          status: shouldDegrade ? 'degraded' : 'operational',
          sourceUnknown: true,
          // Carry what WAS measured successfully. The main-page fetch is independent of the scrape, so
          // uptime + components usually survive a scrape/parse failure — dropping them would turn one
          // unreadable list into a wholesale data loss. `latency` mirrors the four sibling early
          // returns in this function; `uptimeSource` must travel WITH `uptime30d` or the figure ships
          // without provenance and the UI/archive treat it as unavailable.
          latency: config.category === 'api' ? latency : null,
          uptime30d: instatusUptime ?? base.uptime30d,
          ...(instatusUptime != null ? { uptimeSource: 'official' as const } : {}),
          // #1006's side-by-side disclosure comes from the SAME independent main-page fetch as
          // `instatusUptime`, so carrying one without the others would silently drop the
          // comparison on every parse failure.
          ...(instatusReported != null ? { uptimeReported: instatusReported } : {}),
          ...(instatusReportedDays != null ? { uptimeReportedDays: instatusReportedDays } : {}),
          ...(instatusComponents.length > 0 ? { components: instatusComponents } : {}),
        }
      }

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
        ...(betterStackUptime != null
          ? {
              uptime30d: betterStackUptime,
              uptimeSource: 'platform_avg' as const,
              // #1006 — Better Stack's own displayed availability (over its ~90-day window), shown beside
              // our 30-day figure when it differs.
              ...(betterStackReported != null && betterStackReported !== betterStackUptime
                ? { uptimeReported: betterStackReported, uptimeReportedDays: 90 }
                : {}),
            }
          : instatusUptime != null
            // #627 — Instatus component uptime. #1006 — COMPUTED by us over the trailing 30 days from the
            // page's own outage records (Next.js `componentsUptime[].outages`, Nuxt `days[].events`), not
            // copied from its published aggregate (their pages declare `maxUptimeDays: 90`).
            ? {
                uptime30d: instatusUptime,
                uptimeSource: 'official' as const,
                ...(instatusReported != null && instatusReported !== instatusUptime
                  ? { uptimeReported: instatusReported, ...(instatusReportedDays != null ? { uptimeReportedDays: instatusReportedDays } : {}) }
                  : {}),
              }
            : {}),
        ...(betterStackPartial > 0 ? { partialCount: betterStackPartial } : {}),
        ...(betterStackComponents.length > 0
          ? { components: betterStackComponents }
          : instatusComponents.length > 0
            ? { components: instatusComponents } // #761 — Instatus per-component snapshot (Next.js + Nuxt)
            : {}),
      }
    }
  } catch (err) {
    // Fetch failure (timeout/network) ≠ confirmed outage.
    // Require 3 consecutive failures before marking degraded to avoid transient timeout noise
    // (e.g., Together's status page is slow ~3s, intermittent timeouts under load).
    console.error(`[fetchService] ${config.id} failed:`, err)
    // #714 — a thrown fetch (timeout / connection reset / the cross-host 302→4xx redirect-follow
    // throwing from CF egress) is an INDETERMINATE verdict, NOT a recovery. Flag `sourceUnknown` so the
    // source-inactive alert holds a prior dead state instead of misreading the throw as "recovered"
    // (the #714 flap reproduced only from CF egress, where the redirect intermittently throws).
    const shouldDegrade = await trackFetchFailure(kv, config.id)
    return { ...base, status: shouldDegrade ? 'degraded' : 'operational', sourceUnknown: true }
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

/**
 * #1021 — down-classify a NON-reliability advisory incident (usage-limits / quota / billing / deprecation
 * / model-access, no outage signal) to `impact: null`, generalizing the #707 AWS-Health carve-out to EVERY
 * provider. A quota notice a provider posts as a `minor` status-page "incident" (e.g. Codex's June "Usage
 * Limits Depleting Faster Than Expected", 72h) is not an availability outage, so counting its duration as
 * downtime inflates `totalDowntimeMin` and drops the Score. Applied at the SINGLE fetchAllServices choke
 * point (alongside #904 suppression) so every downstream consumer of the returned list sees it consistently:
 *   - the live /api/status list;
 *   - the live Score (calculateAIWatchScore already excludes null-impact per #707/#261);
 *   - the go-forward monthly accumulator (stores `impact` from svc.incidents → future archives read null);
 *   - the cron alert path — `buildIncidentAlerts` REFRAMES an advisory informational (ℹ️ / blurple /
 *     "Advisory", no fallback), so the Discord alert, the Slack/RSS feed, and the #486 user webhooks (which
 *     all inherit the alert object) no longer frame a quota notice as a red "🔴 New Incident" outage;
 *     `buildTweetDrafts` skips it (no "X is having an outage" tweet); and the #778 operator phone push
 *     already keyed off `impact == null` (`pushTargetFor`) so it stays silent. That reframing is title-keyed
 *     in alerts.ts (not this null impact), so a mis-parsed null-impact REAL incident keeps the outage alert.
 *     Flap/hold (`isFlapNotice`) is unchanged (both `minor` and `null` fall through to the title-shape test,
 *     which a usage-limit title does not match).
 * The incident stays in the LIST (unlike suppression, which drops it) — it's reclassified informational,
 * exactly as an AWS advisory or a post-mortem already is. PURE (new objects; never mutates the input or a
 * shared cache ref). An OUTAGE_SIGNAL term in the title always wins (isNonReliabilityAdvisory) — a real
 * fault is never hidden (the false-positive that would HIDE an outage is the dangerous direction).
 */
export function downclassifyAdvisoryIncidents(services: ServiceStatus[]): ServiceStatus[] {
  return services.map((svc) => {
    if (!svc.incidents.some((i) => i.impact != null && isNonReliabilityAdvisory(i.title ?? ''))) return svc
    return {
      ...svc,
      incidents: svc.incidents.map((i) =>
        i.impact != null && isNonReliabilityAdvisory(i.title ?? '') ? { ...i, impact: null } : i,
      ),
    }
  })
}

export async function fetchAllServices(kv?: KVNamespace, probeSnapshots?: ProbeSnapshot[]): Promise<{ raw: ServiceStatus[]; enriched: ServiceStatus[]; pageComponents: Record<string, Array<{ id: string; name: string }>>; upstreamFeeds: UpstreamCandidate[] }> {
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

  // #992 — per-page raw component list (apiUrl → {id,name}[]) harvested from the prefetch, for the
  // cron's new-component change detector. Only successfully-prefetched Statuspage/incident.io pages
  // carry a components array; a page that failed prefetch this cycle is simply checked next cycle.
  const pageComponents: Record<string, Array<{ id: string; name: string }>> = {}
  for (const [apiUrl, data] of prefetchMap) {
    const comps = data.summary?.components
    if (Array.isArray(comps) && comps.length > 0) {
      pageComponents[apiUrl] = comps.map((c) => ({ id: c.id, name: c.name }))
    }
  }

  // #1072 — non-carded upstream feeds, built from the SAME prefetch map (zero extra subrequests).
  // These never enter `raw`/`enriched`: they are not services, and everything downstream of this
  // function (scoring, daily counters, alerts, badges, the service count) must never see them.
  const upstreamFeeds = buildUpstreamFeeds(prefetchMap)

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
        if (svc.status !== 'degraded') continue
        if (isProbeHealthy(probeSnapshots, svc.id)) {
          console.log(`[cross-validation] ${svc.id}: status page down but probe RTT normal — holding operational`)
          svc.status = 'operational'
          // Daily suppression counter — see recordProbeSuppression() docstring.
          if (kv) await recordProbeSuppression(kv, svc.id, date)
        } else if (isProbeFailing(probeSnapshots, svc.id)) {
          // #1004 — the probe INDEPENDENTLY corroborates the outage: the status page is unreadable AND
          // our direct call to the service is failing. The UI neutralises a fetch-failure `degraded` into
          // an "unknown" badge ("we can't read the source"), which would be a false reassurance here —
          // this `degraded` is backed by evidence. Mark it so the display keeps it amber. A service with
          // no probe (junie) or with too few samples to judge stays neutral, which is the honest default.
          svc.probeContradicted = true
        }
      }
    }
  }

  // #689 — for status-source-dead services (4xx → `sourceDead`, already `operational`), mark whether
  // a healthy direct probe INDEPENDENTLY confirms reachability. The 2nd case: a PROBED service whose
  // status PAGE died but whose API still responds → `probeConfirmed` → the UI keeps the operational
  // badge (probe-backed). The un-probed case (e.g. Character.AI, an app) gets no probe → stays
  // `sourceDead` only → the UI shows a neutral "Unknown". Runs outside the degraded block above since
  // sourceDead services are operational, not in `degradedFromFetch`.
  if (probeSnapshots && probeSnapshots.length > 0) {
    for (const svc of raw) {
      if (svc.sourceDead && isProbeHealthy(probeSnapshots, svc.id)) svc.probeConfirmed = true
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

  // #575 Phase B — flag an active consecutive probe-RTT spike per service (reuses the same probe
  // snapshots as the cross-validation above; no extra fetch). The crowd-report display gate
  // cross-matches this: an operational page + a probe spike + enough crowd reports = early warning.
  if (probeSnapshots && probeSnapshots.length > 0) {
    const spiking = new Set(detectConsecutiveSpikes(probeSnapshots, enriched.map((s) => s.id)).map((sp) => sp.serviceId))
    for (const svc of enriched) {
      if (spiking.has(svc.id)) svc.probeSpike = true
    }
  }

  // #904 — operator suppression layer: drop policy-hidden incidents from every downstream consumer
  // (live /api/status list, scoreFor, the go-forward monthly accumulator, and the services:latest
  // cache) in one place. Applied AFTER attribution/status determination so the badge (already scoped
  // by e.g. #741) is unaffected — this only removes the incident from the LIST + Score inputs. Empty
  // list is identity (no churn); a KV read failure falls back to "nothing suppressed".
  const suppressions = await readSuppressions(kv)
  // #1021 — down-classify usage-limits/quota advisories to null impact BEFORE suppression (order-free:
  // suppression drops incidents, this only reclassifies survivors' impact) so the live Score + go-forward
  // accumulator never count a quota notice as downtime. Applied in the same one place as #904, for the same
  // "every downstream consumer, once" reason.
  return {
    raw: applySuppressions(downclassifyAdvisoryIncidents(raw), suppressions),
    enriched: applySuppressions(downclassifyAdvisoryIncidents(enriched), suppressions),
    pageComponents,
    // NOT suppression-filtered: `applySuppressions` is an operator layer over AIWatch's OWN service
    // incidents (#904), and a feed has no card, no Score and no accumulator for a suppression to
    // protect. Passing it through would also let an operator silently disable an upstream
    // attribution from a UI built for a different purpose.
    upstreamFeeds,
  }
}

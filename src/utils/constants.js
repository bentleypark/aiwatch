import { regionStatusOf } from './regionStatus'

export const VALID_THEMES = ['dark', 'light', 'system']

export const THEME_STORAGE_KEY = 'aiwatch-theme'

export const LANG_STORAGE_KEY = 'aiwatch-lang'

export const VALID_LANGS = ['ko', 'en']

export const SETTINGS_STORAGE_KEY = 'aiwatch-settings'

export const VALID_PERIODS = ['7d', '30d', '90d']

// API services (latency tracked)
export const API_SERVICE_IDS = [
  'claude', 'openai', 'gemini', 'mistral', 'cohere', 'groq',
  'together', 'fireworks', 'cerebras', 'perplexity', 'huggingface', 'replicate', 'fal',
  'elevenlabs', 'xai', 'deepseek', 'openrouter', 'bedrock', 'azureopenai',
  'pinecone', 'stability', 'bfl', 'voyageai', 'modal', 'langsmith', 'helicone', 'langfuse', 'runway', 'luma', 'assemblyai', 'deepgram',
]

// AI web apps (no latency — web services, ordered before related API)
export const APP_SERVICE_IDS = ['claudeai', 'chatgpt', 'characterai', 'deepseekapp']

// Coding agents
export const AGENT_SERVICE_IDS = ['claudecode', 'codex', 'cursor', 'copilot', 'windsurf', 'junie']

// Display order: app → LLM → voice → inference → agent
export const SERVICE_AND_APP_IDS = [
  // app
  'claudeai', 'chatgpt', 'characterai', 'deepseekapp',
  // LLM API
  'claude', 'openai', 'gemini', 'bedrock', 'azureopenai', 'mistral', 'cohere', 'groq',
  'together', 'fireworks', 'cerebras', 'perplexity', 'xai', 'deepseek', 'openrouter',
  // voice & speech AI
  'elevenlabs', 'assemblyai', 'deepgram',
  // inference / infrastructure
  'huggingface', 'replicate', 'fal', 'pinecone', 'stability', 'bfl', 'voyageai', 'modal',
  // LLM observability (#601)
  'langsmith', 'helicone', 'langfuse',
  // video-gen
  'runway', 'luma',
]

// All service IDs
export const ALL_SERVICE_IDS = [...SERVICE_AND_APP_IDS, ...AGENT_SERVICE_IDS]

// Sidebar category filters — splits Worker's 'api' into LLM vs Voice/Inference
// Order is dev-audience-first (#658): LLM APIs → Coding Agents → Voice → Inference & Infra →
// Video → AI Apps. The dashboard's primary audience is developers/infra, who check LLM-API and
// coding-agent status first; consumer AI Apps (ChatGPT / claude.ai) sit last because the public
// "is X down?" demand for those is already served by the is-down SEO pages. This object's key
// order drives BOTH the Sidebar filter chips and the Overview per-category sections (SECTION_KEYS
// in src/pages/Overview.jsx — keep in sync).
export const SERVICE_CATEGORIES = {
  all:       { labelKey: 'filter.all',       ids: null }, // null = show all
  llm:       { labelKey: 'filter.llm',       ids: ['claude', 'openai', 'gemini', 'bedrock', 'azureopenai', 'mistral', 'cohere', 'groq', 'together', 'fireworks', 'cerebras', 'perplexity', 'xai', 'deepseek', 'openrouter'] },
  agents:    { labelKey: 'filter.agents',    ids: ['claudecode', 'codex', 'cursor', 'copilot', 'windsurf', 'junie'] },
  voice:     { labelKey: 'filter.voice',     ids: ['elevenlabs', 'assemblyai', 'deepgram'] }, // #658 — STT/TTS
  inference: { labelKey: 'filter.inference', ids: ['huggingface', 'replicate', 'fal', 'modal', 'voyageai', 'pinecone'] }, // catch-all for non-LLM API infra: model-hosting (hf/replicate/fal/modal) + embeddings (voyageai) + vector (pinecone). Observability (#601) and image (#756) split out to their own categories; remaining single-service sub-domains stay here until they gain siblings
  observability: { labelKey: 'filter.observability', ids: ['langsmith', 'helicone', 'langfuse'] }, // #601 — LLM observability/eval split out (LangSmith + Helicone + Langfuse recommend each other, fallback tier 6)
  video:     { labelKey: 'filter.video',     ids: ['runway', 'luma'] }, // #658 — video-gen (align membership with #601 fallback sub-tier)
  image:     { labelKey: 'filter.image',     ids: ['stability', 'bfl'] }, // #756 — image-gen split out (Stability + FLUX recommend each other, fallback tier 7); mirrors the video/observability precedent
  apps:      { labelKey: 'filter.apps',      ids: ['claudeai', 'chatgpt', 'characterai', 'deepseekapp'] },
}

// #676 — the rankable category buckets in #658 canonical order (LLM → Agents → Voice → Inference →
// Observability → Video → Apps), excluding `all` (ids:null). Single source of truth for ordering a flat service list.
const RANKABLE_CATEGORY_KEYS = Object.keys(SERVICE_CATEGORIES).filter((k) => SERVICE_CATEGORIES[k].ids)

// #676 — a service's category rank = the index of its bucket in RANKABLE_CATEGORY_KEYS, so a flat
// service list can be sorted to mirror the filter chips + Overview sections (Agents before Apps, Apps
// last). Unknown id → Infinity (sorts last). Used by the Sidebar service list; shareable by any
// consumer that needs the canonical category order.
export function categoryRankOf(id) {
  const r = RANKABLE_CATEGORY_KEYS.findIndex((k) => SERVICE_CATEGORIES[k].ids.includes(id))
  return r === -1 ? Infinity : r
}

// Services excluded from fallback recommendations (not interchangeable with LLM APIs)
// Keep in sync with worker/src/fallback.ts EXCLUDE_FALLBACK
export const EXCLUDE_FALLBACK = ['replicate', 'huggingface', 'fal', 'pinecone', 'voyageai', 'modal', 'characterai', 'bedrock', 'azureopenai'] // #756 — stability un-excluded (image sibling FLUX added); #758 — fal excluded (self-serve inference platform, like replicate/huggingface)

// #842 — outbound referral wedge. Product/homepage URL per service that can be RECOMMENDED as a
// fallback (Analyze modal / Overview ActionBanner), so an outage-moment visitor can ACT on the
// (Score-ranked, UNPAID) recommendation — and AIWatch can measure the referral (the Rung-1 sponsor
// evidence, #637/#842). NOT an endorsement or paid placement — disclosed + rel="nofollow", rankings
// stay Score-only. Kept BYTE-IDENTICAL to the Edge mirror in api/is-down/slug-map.ts (pinned by
// service-site-url-sync test). A missing id → no outbound affordance (graceful).
export const SERVICE_SITE_URL = {
  // LLM APIs
  claude: 'https://claude.com', openai: 'https://platform.openai.com', gemini: 'https://ai.google.dev',
  mistral: 'https://mistral.ai', cohere: 'https://cohere.com', groq: 'https://groq.com',
  together: 'https://together.ai', fireworks: 'https://fireworks.ai', cerebras: 'https://cerebras.ai',
  deepseek: 'https://www.deepseek.com', xai: 'https://x.ai', perplexity: 'https://www.perplexity.ai',
  openrouter: 'https://openrouter.ai',
  // Voice & speech
  elevenlabs: 'https://elevenlabs.io', assemblyai: 'https://www.assemblyai.com', deepgram: 'https://deepgram.com',
  // Image
  stability: 'https://stability.ai', bfl: 'https://bfl.ai',
  // Video
  runway: 'https://runwayml.com', luma: 'https://lumalabs.ai/dream-machine',
  // Observability
  langsmith: 'https://www.langchain.com/langsmith', helicone: 'https://helicone.ai', langfuse: 'https://langfuse.com',
  // Coding agents
  cursor: 'https://cursor.com', copilot: 'https://github.com/features/copilot', windsurf: 'https://windsurf.com',
  junie: 'https://junie.jetbrains.com', claudecode: 'https://claude.com/product/claude-code', codex: 'https://developers.openai.com/codex',
  // Apps
  chatgpt: 'https://chatgpt.com', claudeai: 'https://claude.ai', deepseekapp: 'https://chat.deepseek.com',
}

/** Disclosed outbound referral URL for a recommended alternative (appends `ref=ai-watch.dev`).
 *  Returns null when no curated URL → caller omits the "Open ↗" affordance. Mirror of the Edge helper. */
export function outboundReferralUrl(id) {
  const base = SERVICE_SITE_URL[id]
  if (!base) return null
  return `${base}${base.includes('?') ? '&' : '?'}ref=ai-watch.dev`
}

// Worker base for the consent-free referral beacon (mirrors src/utils/vitals.js ENDPOINT derivation).
const REFERRAL_WORKER_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:8788').replace(/\/api\/status$/, '')

/** #842 — fire a CONSENT-FREE beacon to the worker referral counter (the honest sponsor-evidence
 *  number; GA's outbound_fallback_click is the consent-gated floor). Best-effort, fire-and-forget.
 *  DEPLOY-ORDER DEPENDENCY: the `POST /api/referral` endpoint ships in #851 — until that worker is
 *  deployed the beacon 404s (harmless, dropped), so merge/deploy #851's worker before this matters. */
export function sendReferralBeacon(fromId, toId) {
  if (!toId) return
  try {
    fetch(`${REFERRAL_WORKER_BASE}/api/referral`, {
      method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromId || '', to: toId }),
    }).catch(() => {})
  } catch { /* fire-and-forget */ }
}

// Per-service incident RSS feed (#432). The feed URL uses the /is-{slug}-down
// page slug, which differs from the worker service ID for the few services
// whose slug carries a dash. Mirror of SERVICE_ID_TO_SLUG in
// api/is-down/slug-map.ts (overrides only) — pinned by feed-slug.test.js.
const FEED_SLUG_OVERRIDE = {
  claudecode:  'claude-code',
  copilot:     'github-copilot',
  claudeai:    'claude-ai',
  characterai: 'character-ai',
  langsmith:   'langchain',
  deepseekapp: 'deepseek-app',
  bfl:         'flux', // #756 — SEO-friendly "is flux down" slug
}

// Services with no /is-{slug}-down page and therefore no RSS feed — estimate-only
// sources excluded per #263. Matches worker/src/rss.ts NO_IS_DOWN_PAGE.
export const NO_FEED_SERVICES = ['bedrock', 'azureopenai']

// Per-service incident RSS feed URL, or null when the service has no feed.
export function feedUrlOf(serviceId) {
  if (!serviceId || NO_FEED_SERVICES.includes(serviceId)) return null
  return `https://ai-watch.dev/feed/${FEED_SLUG_OVERRIDE[serviceId] ?? serviceId}`
}

// All-services incident feed — surfaced wherever a global subscribe affordance
// makes sense (Settings Alerts, incident banner, sidebar footer — #433).
export const ALL_SERVICES_FEED_URL = 'https://ai-watch.dev/feed.xml'

// Fallback tier priority — API services (1-4) and coding agents (11-13) use distinct number ranges
// so TIER_LABEL maps each tier number to one unambiguous label. Within a category, getFallbacks
// orders by tier-distance then by Score.
//
// Cross-mirror sync test (worker/src/__tests__/api-tier-sync.test.ts) asserts byte-for-byte equality
// against worker/src/fallback.ts API_TIER. api/is-down.ts inline copy is checked via string-match.
// All three must move together.
export const API_TIER = {
  claude: 1, openai: 1, gemini: 1,
  mistral: 2, cohere: 2, groq: 2, together: 2, fireworks: 2, cerebras: 2, deepseek: 2, xai: 2, perplexity: 2,
  bedrock: 3, azureopenai: 3, openrouter: 3,
  elevenlabs: 4, assemblyai: 4, deepgram: 4,
  // Tier 5 = generative Video (#602 / #601 step B) — keep in sync with worker/src/fallback.ts.
  runway: 5, luma: 5,
  // Tier 6 = LLM Observability (#601) — LangSmith + Helicone + Langfuse; LangSmith un-excluded.
  langsmith: 6, helicone: 6, langfuse: 6,
  // Tier 7 = Image generation (#756) — Stability + FLUX; both un-excluded (≥2 members).
  stability: 7, bfl: 7,
  claudecode: 11, codex: 11,
  cursor: 12, windsurf: 12,
  copilot: 13, junie: 13,
  chatgpt: 21, claudeai: 21, characterai: 21, deepseekapp: 21,
}

// Sync target for worker/src/fallback.ts TIER_LABEL. Pre-#403 this lived inline in Overview.jsx;
// promoted here so the sync test can compare both copies via a single import without parsing JSX.
export const TIER_LABEL = {
  1: 'LLM', 2: 'LLM', 3: 'Infra', 4: 'Voice', 5: 'Video', 6: 'Observability', 7: 'Image',
  11: 'CLI Agent', 12: 'IDE Agent', 13: 'Plugin Agent',
  21: 'AI Apps',
}

// #403 — warn-once helper that surfaces silent missing-id lookups in the dev console without
// changing runtime behavior. Mirrors worker/src/fallback.ts tierFor; the parallel implementation
// is intentional (the worker can't import frontend code at runtime).
const warnedTierIds = new Set()
export function tierFor(id) {
  const t = API_TIER[id]
  if (t !== undefined) return t
  if (!warnedTierIds.has(id)) {
    warnedTierIds.add(id)
    console.warn(`[fallback] no API_TIER for service "${id}" — falling back to 99 (Score-only ordering)`)
  }
  return 99
}

const warnedLabelTiers = new Set()
export function tierLabelFor(tier) {
  const l = TIER_LABEL[tier]
  if (l !== undefined) return l
  if (!warnedLabelTiers.has(tier)) {
    warnedLabelTiers.add(tier)
    console.warn(`[fallback] no TIER_LABEL for tier ${tier} — grouped fallback display will degrade to bare category label`)
  }
  return undefined
}

// #707/#811 — MIRROR of worker/src/utils.ts `isNonReliabilityAdvisory` (+ the two regexes). A NON-
// reliability advisory (compliance / export-control / access revocation OR suspension / deprecation /
// scheduled change) with NO outage signal must not disqualify an operational fallback candidate (#811 —
// a Claude model-access suspension must not exclude Claude Code when ChatGPT is down). Parity with the
// worker copy is pinned by a sync test. An outage-signal term ALWAYS wins (never hide a real fault).
const NON_RELIABILITY_RE =
  /export control|compliance|regulatory|revoke|revoked|revoking|suspend(?:ed|ing|s)?|deprecat|end[ -]of[ -]life|retir(?:e|ed|ing|ement)|sunset|discontinu|scheduled (?:maintenance|change)/i
const OUTAGE_SIGNAL_RE =
  /error rate|elevated error|5xx|disruption|outage|partial outage|degraded|unable to|throttl|increased latency|timeouts?|failure|not responding|impair/i
export function isNonReliabilityAdvisory(text) {
  return !!text && NON_RELIABILITY_RE.test(text) && !OUTAGE_SIGNAL_RE.test(text)
}

/**
 * Whether a service has an unresolved RELIABILITY incident (investigating/identified/monitoring — anything
 * not 'resolved'). A service can be `status: 'operational'` while carrying such an incident (the phase
 * hasn't flipped its status, or the impact is minor), and recommending it as a healthy fallback is
 * misleading — the Overview banner shows it as an active incident on the same screen (#550).
 * #811 — a non-reliability ADVISORY (access suspension / compliance / deprecation, no outage signal) is
 * NOT a reliability incident, so it does not disqualify an otherwise-operational candidate.
 * @param {object} s - Service (needs .incidents)
 * @returns {boolean}
 */
export function hasActiveIncident(s) {
  return (s?.incidents ?? []).some(i => i.status !== 'resolved' && !isNonReliabilityAdvisory(i.title ?? ''))
}

/**
 * Get top 2 fallback recommendations for a service, sorted by tier proximity + AIWatch Score.
 * A candidate must be genuinely clean: operational AND no unresolved incident (#550).
 * @param {object} service - Source service (needs .id, .category)
 * @param {object[]} allServices - All services (needs .id, .category, .status, .incidents, .aiwatchScore)
 * @returns {{ id: string, name: string, aiwatchScore: number | null }[]}
 */
export function getFallbacks(service, allServices) {
  if (!service || !Array.isArray(allServices) || EXCLUDE_FALLBACK.includes(service.id)) return []
  const sourceTier = tierFor(service.id)
  return allServices
    // #616 — exclude stale-source services (#591): ranking-excluded → not a trusted fallback either
    .filter(s => s.category === service.category && s.id !== service.id && s.status === 'operational' && !hasActiveIncident(s) && !s.incidentSourceStale && !EXCLUDE_FALLBACK.includes(s.id))
    .sort((a, b) => {
      const distA = Math.abs(tierFor(a.id) - sourceTier)
      const distB = Math.abs(tierFor(b.id) - sourceTier)
      if (distA !== distB) return distA - distB
      return (b.aiwatchScore ?? 0) - (a.aiwatchScore ?? 0)
    })
    .slice(0, 2)
    .map(s => ({ id: s.id, name: s.name, aiwatchScore: s.aiwatchScore ?? null }))
}

const CATEGORY_LABEL = { api: 'API', app: 'AI Apps', agent: 'Coding' }

/**
 * Group fallback recommendations by category (with API-tier subdivision) for a
 * multi-service incident, so surfaces that group several affected services into
 * one card (Overview ActionBanner, AnalysisModal) show per-category alternatives
 * instead of collapsing to a single affected service's category (#445).
 *
 * Shares the per-category "label → list" SHAPE with the Discord
 * `buildGroupedFallbackText` (worker/src/fallback.ts). The CANDIDATE-selection rule
 * is now the same on both surfaces — a candidate just has to be live-clean
 * (operational, no active incident, non-stale; enforced by getFallbacks via
 * #550/#616), with no same-provider exclusion on either. This helper only
 * additionally applies a `perGroup` cap (the dashboard banner is a cramped single
 * row; Discord is a roomy multi-line embed), a display bound — not a candidate
 * filter. Pinned by the #554 parity-guard tests on both surfaces
 * (`src/utils/__tests__/constants.test.js` + `worker/src/__tests__/fallback.test.ts`);
 * re-adding a provider exclusion to either breaks them.
 *
 * #554 — the former blanket "exclude any candidate sharing a provider with an
 * affected service" rule was REMOVED: it existed only here (never in the worker
 * or is-down), so the two surfaces recommended different sets for the same
 * incident, and it dropped an operational sibling (e.g. claude.ai for ChatGPT
 * when only Claude Code was degraded) → ChatGPT got zero fallback. The genuine
 * correlated-risk case (the candidate itself is hit) is already caught by the
 * candidate's own hasActiveIncident/status filter (#550), so the provider rule
 * was redundant there and harmful in the operational-sibling case.
 *
 * When the affected services span a single group, each group shows up to 2
 * alternatives; with multiple groups, 1 each (to bound banner width).
 *
 * @param {object[]} affected - Affected services (need .id, .category)
 * @param {object[]} allServices - All services (need .id, .category, .status, .incidents, .aiwatchScore)
 * @returns {{ category: string, label: string, items: { id: string, name: string, aiwatchScore: number | null }[] }[]}
 */
export function getGroupedFallbacks(affected, allServices) {
  if (!Array.isArray(affected) || !Array.isArray(allServices)) return []
  // Defensive: getFallbacks already excludes non-operational AND active-incident candidates (#550),
  // so this set currently never drops anything — kept as a guard in case that contract changes.
  const nonOperationalIds = new Set(allServices.filter(s => s.status !== 'operational' || hasActiveIncident(s)).map(s => s.id))
  const eligibleAffected = affected.filter(a => !EXCLUDE_FALLBACK.includes(a.id))
  const numGroups = new Set(eligibleAffected.map(a => {
    const tierLabel = tierLabelFor(tierFor(a.id))
    return tierLabel ? `${a.category}:${tierLabel}` : a.category
  })).size
  const perGroup = numGroups === 1 ? 2 : 1
  const seenGroups = new Set()
  const groups = []
  for (const svc of affected) {
    if (EXCLUDE_FALLBACK.includes(svc.id)) continue
    const tierLabel = tierLabelFor(tierFor(svc.id))
    const groupKey = tierLabel ? `${svc.category}:${tierLabel}` : svc.category
    if (seenGroups.has(groupKey)) continue
    seenGroups.add(groupKey)
    // #554 — selection parity with the worker: keep only the live-clean guard (getFallbacks
    // already enforces it; nonOperationalIds is a defensive backstop). No same-provider exclusion.
    const candidates = getFallbacks(svc, allServices).filter(f => !nonOperationalIds.has(f.id))
    if (candidates.length === 0) continue
    const label = tierLabel || CATEGORY_LABEL[svc.category] || svc.category
    groups.push({ category: svc.category, label, items: candidates.slice(0, perGroup) })
  }
  return groups
}

/**
 * #641 — whether a service already has an actionable region-switch recommendation. Mirrors the
 * ActionBanner `regionRecs` filter + the is-down `renderRegionRecommendation` render condition.
 * NOTE: the web predicate intentionally OMITS `hasGlobalIncident` (a coexisting global outage) —
 * matching how the region link itself is rendered on the web surfaces. The Worker's `buildRegionHint`
 * additionally guards `hasGlobalIncident`, so Discord is marginally stricter; that asymmetry is
 * pre-existing in the region-link logic and inherited here, not introduced by #641.
 */
export function hasRegionSwitch(service) {
  const rs = regionStatusOf(service)
  return !!(rs && rs.hasRegionSpecific && !rs.allDown && rs.recommendedRegion)
}

/**
 * #641 — per-service variant of getGroupedFallbacks that EXCLUDES services which already have a
 * region-switch recommendation: a region-specific outage is solved by the cheaper same-provider
 * region switch, so a cross-provider fallback alongside it is redundant noise. Per-service — an
 * affected service WITHOUT a region switch keeps its cross-service fallback.
 */
export function getGroupedFallbacksExcludingRegionSwitchable(affected, allServices) {
  if (!Array.isArray(affected)) return []
  return getGroupedFallbacks(affected.filter(s => !hasRegionSwitch(s)), allServices)
}

/**
 * Whether to surface fallback recommendations for a group of affected services.
 *
 * Gated on service STATUS (not the AI's `needsFallback` flag) so the Analyze
 * modal stays consistent with the Overview ActionBanner, which shows fallbacks
 * for any `down`/`degraded` service (#454). The AI may classify partial
 * degradation as `needsFallback: false`, which previously hid the modal's
 * recommendations for degraded incidents while Overview still showed them.
 *
 * @param {object[]} svcs - Services in the group (need .id, .status)
 * @param {boolean} allRecovered - True if every analysis in the group is resolved
 * @returns {boolean}
 */
export function shouldShowFallback(svcs, allRecovered) {
  if (allRecovered || !Array.isArray(svcs) || svcs.length === 0) return false
  if (!svcs.some(s => s.status !== 'operational')) return false
  if (svcs.every(s => EXCLUDE_FALLBACK.includes(s.id))) return false
  return true
}

// 'degraded' was removed (#470): with 3 statuses it behaved identically to 'all' (every change
// involves a non-operational state), so it was a redundant, mislabeled option. useSettings
// migrates any stored 'degraded' → 'all'.
export const VALID_ALERT_CONDITIONS = ['down', 'all']

export const DEFAULT_SETTINGS = {
  period: '7d',
  sla: 99.9,
  enabledServices: ALL_SERVICE_IDS,
  discordUrl: '',
  alertCondition: 'down',  // 'down' | 'all'  (#470 removed 'degraded')
  alertTarget: 'all',      // 'all' | 'custom'
  alertServices: ALL_SERVICE_IDS,
  alertIncidents: true,    // on by default — a configured Discord webhook gets incident alerts without a second opt-in (no-op until discordUrl is set)
}

export const SCORE_BG_CLASS = {
  excellent: 'bg-[var(--green)]',
  good: 'bg-[var(--green)]',
  fair: 'bg-[var(--yellow)]',
  degrading: 'bg-[var(--amber)]',
  unstable: 'bg-[var(--red)]',
}

export const SCORE_TEXT_CLASS = {
  excellent: 'text-[var(--green)]',
  good: 'text-[var(--green)]',
  fair: 'text-[var(--yellow)]',
  degrading: 'text-[var(--amber)]',
  unstable: 'text-[var(--red)]',
}

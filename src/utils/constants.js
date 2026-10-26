import { regionStatusOf } from './regionStatus'
import { isDisplayAffected } from './statusDisplay'
import { substituteGroupsFor, pickSubstitutes, flattenSubstitutes } from '../../api/_shared/substitutes'
import {
  EXCLUDE_FALLBACK, ROUTE_SUPPRESS, tierFor, tierLabelFor, isSpecializedSubTier, sharesCapability,
  CAPABILITY_LABEL, CAPABILITY_TAG_LABEL, isCapabilityProvider, REQUIRED_CAPABILITY, REQUIRED_CAPABILITY_LABEL,
  meetsRequiredCapability, routingTier, routedCapability, capabilityTagsOf, effectiveTierFor, hasActiveIncident,
  orderForFallback,
} from '../../worker/src/fallback'

export {
  EXCLUDE_FALLBACK, API_TIER, isSpecializedSubTier, CAPABILITY_TIER,
  COMPONENT_CAPABILITY, CAPABILITY_PROVIDERS, hasActiveIncident,
} from '../../worker/src/fallback'

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
  'elevenlabs', 'xai', 'deepseek', 'kimi', 'openrouter', 'bedrock', 'azureopenai',
  'pinecone', 'turbopuffer', 'stability', 'bfl', 'voyageai', 'jina', 'modal', 'twelvelabs', 'langsmith', 'helicone', 'langfuse', 'runway', 'luma', 'assemblyai', 'deepgram', 'fishaudio',
]

// AI web apps (no latency — web services, ordered before related API)
export const APP_SERVICE_IDS = ['claudeai', 'chatgpt', 'characterai', 'deepseekapp', 'grok', 'kimiapp']

// Coding agents
export const AGENT_SERVICE_IDS = ['claudecode', 'codex', 'cursor', 'copilot', 'windsurf', 'junie']

// Display order: app → LLM → voice → inference → agent
export const SERVICE_AND_APP_IDS = [
  // app
  'claudeai', 'chatgpt', 'characterai', 'deepseekapp', 'grok', 'kimiapp',
  // LLM API
  'claude', 'openai', 'gemini', 'xai', 'mistral', 'bedrock', 'azureopenai', 'cohere', 'groq',
  'together', 'fireworks', 'cerebras', 'perplexity', 'deepseek', 'kimi', 'openrouter',
  // voice & speech AI
  'elevenlabs', 'assemblyai', 'deepgram', 'fishaudio',
  // inference / infrastructure
  'huggingface', 'replicate', 'fal', 'pinecone', 'turbopuffer', 'stability', 'bfl', 'voyageai', 'jina', 'modal', 'twelvelabs',
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
  llm:       { labelKey: 'filter.llm',       ids: ['claude', 'openai', 'gemini', 'xai', 'mistral', 'bedrock', 'azureopenai', 'cohere', 'groq', 'together', 'fireworks', 'cerebras', 'perplexity', 'deepseek', 'kimi', 'openrouter'] },
  agents:    { labelKey: 'filter.agents',    ids: ['claudecode', 'codex', 'cursor', 'copilot', 'windsurf', 'junie'] },
  voice:     { labelKey: 'filter.voice',     ids: ['elevenlabs', 'assemblyai', 'deepgram', 'fishaudio'] }, // #658 — STT/TTS
  inference: { labelKey: 'filter.inference', ids: ['huggingface', 'replicate', 'fal', 'modal', 'voyageai', 'jina', 'pinecone', 'turbopuffer', 'twelvelabs'] }, // catch-all for non-LLM API infra: model-hosting (hf/replicate/fal/modal) + embeddings (voyageai) + vector (pinecone/turbopuffer, #857). Observability (#601) and image (#756) split out to their own categories; vector stays here as a sidebar group (its ≥2-member split is a fallback tier only, #857) — remaining single-service sub-domains stay until they gain siblings
  observability: { labelKey: 'filter.observability', ids: ['langsmith', 'helicone', 'langfuse'] }, // #601 — LLM observability/eval split out (LangSmith + Helicone + Langfuse recommend each other, fallback tier 6)
  video:     { labelKey: 'filter.video',     ids: ['runway', 'luma'] }, // #658 — video-gen (align membership with #601 fallback sub-tier)
  image:     { labelKey: 'filter.image',     ids: ['stability', 'bfl'] }, // #756 — image-gen split out (Stability + FLUX recommend each other, fallback tier 7); mirrors the video/observability precedent
  apps:      { labelKey: 'filter.apps',      ids: ['claudeai', 'chatgpt', 'characterai', 'deepseekapp', 'grok', 'kimiapp'] },
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


// #842 — outbound referral wedge. Product/homepage URL per service that can be RECOMMENDED as a
// fallback (Analyze modal / Overview ActionBanner), so an outage-moment visitor can ACT on the
// (Score-ranked, UNPAID) recommendation — and AIWatch can measure the referral (the Rung-1 sponsor
// evidence, #637/#842). NOT an endorsement or paid placement — disclosed + rel="nofollow", rankings
// stay Score-only. Kept BYTE-IDENTICAL to the Edge mirror in api/_is-down/slug-map.ts (pinned by
// service-site-url-sync test). A missing id → no outbound affordance (graceful).
export const SERVICE_SITE_URL = {
  // LLM APIs
  claude: 'https://claude.com', openai: 'https://platform.openai.com', gemini: 'https://ai.google.dev',
  mistral: 'https://mistral.ai', cohere: 'https://cohere.com', groq: 'https://groq.com',
  together: 'https://together.ai', fireworks: 'https://fireworks.ai', cerebras: 'https://cerebras.ai',
  deepseek: 'https://www.deepseek.com', kimi: 'https://www.moonshot.ai', xai: 'https://x.ai', perplexity: 'https://www.perplexity.ai',
  openrouter: 'https://openrouter.ai',
  // Voice & speech
  elevenlabs: 'https://elevenlabs.io', assemblyai: 'https://www.assemblyai.com', deepgram: 'https://deepgram.com', fishaudio: 'https://fish.audio',
  // Vector DB (#857) — pinecone + turbopuffer are now fallback candidates (Tier 8); keep in sync with api/is-down/slug-map.ts
  pinecone: 'https://www.pinecone.io', turbopuffer: 'https://turbopuffer.com',
  // Embeddings (#880) — voyageai + jina are now fallback candidates (Tier 9)
  voyageai: 'https://www.voyageai.com', jina: 'https://jina.ai',
  // Image
  // #1119 — MIRROR of api/_is-down/slug-map.ts (see there for the full rationale): Brand Studio is
  // Stability's consumer image product, so an image recommendation reached from an app-category outage
  // lands on a surface a non-developer can use. `bfl` stays on the root — its Playground redirects to a
  // sign-in wall before any generation (confirmed in a browser 2026-07-23), so it has no no-signup
  // surface to send an outage-moment user to. Deliberate asymmetry with Stability's free-entry product.
  stability: 'https://stability.ai/brandstudio', bfl: 'https://bfl.ai',
  // Video
  runway: 'https://runwayml.com', luma: 'https://lumalabs.ai/dream-machine',
  // Observability
  langsmith: 'https://www.langchain.com/langsmith', helicone: 'https://helicone.ai', langfuse: 'https://langfuse.com',
  // Coding agents
  cursor: 'https://cursor.com', copilot: 'https://github.com/features/copilot', windsurf: 'https://devin.ai/desktop',
  junie: 'https://junie.jetbrains.com', claudecode: 'https://claude.com/product/claude-code', codex: 'https://developers.openai.com/codex',
  // Apps
  chatgpt: 'https://chatgpt.com', claudeai: 'https://claude.ai', deepseekapp: 'https://chat.deepseek.com', grok: 'https://grok.com', kimiapp: 'https://www.kimi.com',
}

/** Disclosed outbound referral URL for a recommended alternative (appends `ref=ai-watch.dev`).
 *  Returns null when no curated URL → caller omits the "Open ↗" affordance. Mirror of the Edge helper. */
export function outboundReferralUrl(id) {
  const base = SERVICE_SITE_URL[id]
  if (!base) return null
  return `${base}${base.includes('?') ? '&' : '?'}ref=ai-watch.dev`
}

// Worker base for the consent-free referral beacon (mirrors src/utils/vitals.js ENDPOINT derivation).
// `import.meta.env &&` guards a non-Vite import of this module (e.g. a Node/SSR context where
// `import.meta.env` is undefined) so the top-level read can't throw. constants.js is imported widely.
const REFERRAL_WORKER_BASE = ((import.meta.env && import.meta.env.VITE_API_URL) || 'http://localhost:8788').replace(/\/api\/status$/, '')

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
// api/_is-down/slug-map.ts (overrides only) — pinned by feed-slug.test.js.
const FEED_SLUG_OVERRIDE = {
  claudecode:  'claude-code',
  copilot:     'github-copilot',
  claudeai:    'claude-ai',
  characterai: 'character-ai',
  langsmith:   'langchain',
  deepseekapp: 'deepseek-app',
  kimiapp: 'kimi-app', // #1731
  bfl:         'flux', // #756 — SEO-friendly "is flux down" slug
  fishaudio:   'fish-audio', // #1549
  // #1164 — /is-claude-down and /is-openai-down became provider-family group pages; the
  // single-service pages moved to '-api' slugs.
  claude:      'claude-api',
  openai:      'openai-api',
  // #1165/#1586 — /is-xai-down became the SpaceXSI/Grok family group page; the single-service SpaceXSI API page
  // moved to 'xai-api'. 'grok' (the new consumer-app id) needs no override — its slug == id.
  xai:         'xai-api',
  windsurf:    'devin-desktop', // #1430 — Windsurf was renamed Devin Desktop
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

/**
 * Get top 2 fallback recommendations for a service, ordered by tier proximity then by
 * `orderForFallback` (#1186 — a confidence-aware proportional interleave, not a raw Score sort).
 * A candidate must be genuinely clean: operational AND no unresolved incident (#550).
 * @param {object} service - Source service (needs .id, .category)
 * @param {object[]} allServices - All services (needs .id, .category, .status, .incidents, .aiwatchScore)
 * @returns {{ id: string, name: string, aiwatchScore: number | null }[]}
 */
const isLiveCandidate = (s) => s.status === 'operational' && !hasActiveIncident(s) && !s.incidentSourceStale

export function getFallbacks(service, allServices) {
  if (!service || !Array.isArray(allServices) || EXCLUDE_FALLBACK.includes(service.id)) return []
  if (service.fallbackSuppressed) return [] // #880 — the worker's verdict: outage outside the fallback scope
  // #1062 facet B — a single secondary-capability outage (e.g. OpenAI 'Images') routes to that
  // capability's tier; a secondary cap with no peer tier (realtime) suppresses.
  const routed = routingTier(service)
  if (routed === ROUTE_SUPPRESS) return []
  const listed = substituteFallbacks(service, allServices)
  if (listed) return flattenSubstitutes(listed)
  const sourceTier = routed ?? tierFor(service.id)
  // #859 — specialized sub-tier source → same-tier candidates only (no cross-tier bleed)
  const sameTierOnly = isSpecializedSubTier(sourceTier)
  const inSourceTier = (id) => tierFor(id) === sourceTier
  const admittedBySubTier = (id) => inSourceTier(id) || isCapabilityProvider(id, sourceTier)
  // #1119 — MIRROR of the worker rule (see worker/src/fallback.ts getFallbacks for the full rationale):
  // a ROUTED outage draws from the CAPABILITY's tier, so the source's category must not gate it (an
  // `app` ChatGPT image outage has to reach the `api` image tier). Only the routed path relaxes; the
  // condition is `routed > 0` so ROUTE_SUPPRESS stays suppressed by its early return alone; the routed
  // branch pins to `inSourceTier` (NOT the facet-C-widened form, which would answer a ChatGPT image
  // outage with "try OpenAI API"); api → app/agent stays impossible because no CAPABILITY_TIER value is
  // an app/agent tier, no app/agent id sits in a specialized tier, and CAPABILITY_PROVIDERS holds none.
  const routedCross = routed !== null && routed > 0
  const eligible = allServices
    // #616 — exclude stale-source services (#591): ranking-excluded → not a trusted fallback either
    // #1119 — EXCLUDE_FALLBACK first, so a tier lookup never sees the deliberately-untiered
    // services and `tierFor`'s warn-once keeps meaning "someone forgot a tier entry" (#402/#403).
    .filter(s => !EXCLUDE_FALLBACK.includes(s.id) && s.id !== service.id
      && (routedCross ? inSourceTier(s.id) : s.category === service.category)
      && isLiveCandidate(s)
      // #1062 facet C — a specialized sub-tier (Image/Video/Voice) also admits the multimodal providers of
      // its capability (OpenAI), ranked after the dedicated sibling by tier distance.
      && (sameTierOnly ? admittedBySubTier(s.id) : !isSpecializedSubTier(tierFor(s.id)))
      // #1062 — within a capability-mixed tier (Voice), only a candidate sharing a capability qualifies
      && sharesCapability(service.id, s.id, capabilityTagsOf(service))
      // #1725 — MIRROR: a ROUTED outage draws from the routed tier, where the list does not apply
      && (routedCross || meetsRequiredCapability(service.id, s.id)))
  return orderForFallback(eligible, sourceTier)
    .slice(0, 2)
    .map(s => ({ id: s.id, name: s.name, aiwatchScore: s.aiwatchScore ?? null }))
}

// #1753 — MIRROR of worker substituteFallbacks: a listed service's substitutes per group, or null.
export function substituteFallbacks(service, allServices) {
  const groups = substituteGroupsFor(service.id, routedCapability(service), service.components)
  if (!groups) return null
  if (service.fallbackSuppressed || routingTier(service) === ROUTE_SUPPRESS) return []
  const clean = allServices.filter(s => !EXCLUDE_FALLBACK.includes(s.id) && s.id !== service.id
    && isLiveCandidate(s))
  return pickSubstitutes(groups, clean, (inGroup) => orderForFallback(inGroup, tierFor(service.id)))
    .map(({ group, items }) => ({ group, items: items.map(s => ({ id: s.id, name: s.name, aiwatchScore: s.aiwatchScore ?? null })) }))
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
  // #1062 facet B — key/label by the EFFECTIVE tier (routed capability tier for a secondary-only outage)
  // so a routed OpenAI-'Images' outage groups + reads as "Image", not the source's LLM tier. Resolve each
  // anchor's candidates FIRST and keep only groups that render: a routed service that SUPPRESSES
  // (Realtime) yields none and its effectiveTierFor falls back to its own (LLM) tier — so
  // reserving that key pre-resolve dropped a later genuine-LLM sibling's group and inflated numGroups.
  // First-non-empty-per-key wins; numGroups is the count of rendered groups.
  const seenGroups = new Set()
  const resolved = []
  // #1753 — MIRROR: unlisted anchors resolve first.
  const listedOf = new Map(affected.map(s => [s.id, substituteFallbacks(s, allServices)]))
  for (const svc of [...affected.filter(s => !listedOf.get(s.id)), ...affected.filter(s => listedOf.get(s.id))]) {
    if (EXCLUDE_FALLBACK.includes(svc.id)) continue
    const listed = listedOf.get(svc.id)
    if (listed) {
      for (const { group, items } of listed) {
        const key = `${svc.category}:${group.label}`
        if (seenGroups.has(key)) continue
        seenGroups.add(key)
        resolved.push({ category: svc.category, label: group.label, candidates: items })
      }
      continue
    }
    // #1119 — MIRROR of worker groupKeyOf (see there for the full rule): the key groups anchors that
    // draw from the same pool. A ROUTED anchor's pool depends on its routed tier AND on its own
    // capabilityTagsOf tag (#1129, facet A), so the key encodes both: routed anchors at one tier share
    // a key across categories (`openai` + `chatgpt` route together off one status page and otherwise
    // produce two identical groups, collapsing perGroup 2→1) ONLY when their tags also match. A routed
    // and a NON-routed anchor at the same tier stay separate on purpose: their pools differ (facet C
    // admits openai for a plain Stability outage, the routed branch does not), so merging them would
    // answer one anchor with the other's candidates, decided by array order. This surface reaches that
    // shape — Overview passes the WHOLE affected board, not one incident's surfaces.
    // `tierLabelFor` is called only on the non-routed branch, matching the worker's early return — it
    // warns once per unlabelled tier, and a one-sided warn is the kind of drift #402/#403 guards against.
    const routed = routingTier(svc)
    const isRouted = routed !== null && routed > 0
    const tierLabel = isRouted ? null : tierLabelFor(effectiveTierFor(svc))
    const baseKey = tierLabel ? `${svc.category}:${tierLabel}` : svc.category
    // #1725 — MIRROR: a source with a required capability has its own pool, so its own group
    const groupKey = isRouted ? `routed:${routed}:${(capabilityTagsOf(svc) ?? []).join('|')}` : (REQUIRED_CAPABILITY[svc.id] ? `${baseKey}:${REQUIRED_CAPABILITY[svc.id]}` : baseKey)
    if (seenGroups.has(groupKey)) continue
    // #554 — selection parity with the worker: keep only the live-clean guard (getFallbacks
    // already enforces it; nonOperationalIds is a defensive backstop). No same-provider exclusion.
    const candidates = getFallbacks(svc, allServices).filter(f => !nonOperationalIds.has(f.id))
    if (candidates.length === 0) continue // suppressed / no candidate → does NOT reserve the key
    seenGroups.add(groupKey)
    // #1062 facet B — a routed group is labelled by the affected CAPABILITY ("Image generation") so the
    // recommendation self-describes WHY it switched; a non-routed group keeps its tier/category label.
    const cap = routedCapability(svc)
    // #1129 — a routed AUDIO group is labelled by the anchor's single capabilityTagsOf sub-tag
    // ('Text to speech' / 'Speech to text') instead of the shared 'Audio / speech', so two split Voice
    // groups don't render as duplicate labels. Untagged / both-tagged anchors fall through to the
    // capability label. Guarded on cap === 'audio' — see CAPABILITY_TAG_LABEL. MIRROR of the worker.
    const tags = capabilityTagsOf(svc) ?? []
    const subLabel = cap === 'audio' && tags.length === 1 ? CAPABILITY_TAG_LABEL[tags[0]] : undefined
    const need = REQUIRED_CAPABILITY[svc.id]
    const baseLabel = cap ? (subLabel ?? CAPABILITY_LABEL[cap]) : (tierLabel || CATEGORY_LABEL[svc.category] || svc.category)
    const label = need && !cap ? `${baseLabel} (${REQUIRED_CAPABILITY_LABEL[need]})` : baseLabel
    resolved.push({ category: svc.category, label, capability: cap || undefined, candidates })
  }
  const idsOf = g => g.candidates.map(c => c.id).join('\n')
  const distinct = resolved.filter((g, i) => !resolved.slice(0, i).some(h => h.label === g.label && idsOf(h) === idsOf(g)))
  const perGroup = distinct.length === 1 ? 2 : 1
  return distinct.map(g =>({ category: g.category, label: g.label, ...(g.capability ? { capability: g.capability } : {}), items: g.candidates.slice(0, perGroup) }))
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
  // #1004 — the DISPLAY state, matching the Overview ActionBanner this is documented to stay consistent
  // with. A service whose status source we can't read must never trigger a "switch to X" recommendation:
  // we'd be telling users to abandon a service we just admitted we can't see.
  if (!svcs.some(isDisplayAffected)) return false
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

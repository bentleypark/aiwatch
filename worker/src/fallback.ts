// Fallback recommendation logic for incident alerts

import { isNonReliabilityAdvisory } from './utils'

// Keep in sync with src/utils/constants.js EXCLUDE_FALLBACK
// #756 — stability un-excluded now that the image category has ≥2 members (Stability + FLUX recommend
// each other in Tier 7); bfl is fallback-eligible from the start (never added here).
// #857 — pinecone un-excluded now that the vector category has ≥2 members (Pinecone + turbopuffer recommend
// each other in Tier 8); turbopuffer is fallback-eligible from the start (never added here).
export const EXCLUDE_FALLBACK = ['replicate', 'huggingface', 'fal', 'voyageai', 'modal', 'characterai', 'bedrock', 'azureopenai', 'twelvelabs']

// Tier-based priority — same-tier services sorted by Score, then adjacent tiers by distance.
// API tiers (1-8) and the agent tier (11) use distinct number ranges so TIER_LABEL stays unambiguous
// and the category filter in getFallbacks prevents API ↔ agent leakage on every NON-routed path.
// #1119 narrowed that claim: a capability-ROUTED source is pinned to the routed TIER instead of its
// category, so an agent source can route INTO an api sub-tier (intended). The reverse cannot happen —
// no CAPABILITY_TIER value is an agent/app tier.
//
// #1027 — all six coding agents share ONE tier (11). The old CLI/IDE/Plugin sub-tiers (11/12/13)
// encoded a delivery-FORM axis that no longer distinguishes agents — each now ships both a CLI and an
// IDE surface — so a single-form label was inaccurate and the IDE-vs-Plugin split was arbitrary.
// Agents now fall back by Score within the category, like ties inside an LLM tier. Keeping a defined
// tier (vs the pre-#402 `?? 99` fall-through) still suppresses the tierFor warn-once.
//
// TRADE-OFF (honest): this RE-EXPOSES the #402 failure mode — a shallow-history agent whose Score is
// *inflated* (few incidents → high, non-null Score) ranking #1 for an unrelated agent outage — WITHIN
// the agent category. The old sub-tiers masked it via form-proximity; #1027 adds NO structural guard.
// getFallbacks (below) sorts on raw aiwatchScore and does NOT consult the coverage gate (#802 is a
// rankings-page-only exclusion) or confidence withholding (#713 nulls a Score only when a service has
// neither official uptime nor a probe — every agent HAS official uptime, so #713 never fires for them).
// Only a genuinely null Score sinks, via `?? 0`. Mitigation is procedural, not structural: verify after
// adding any new agent that it doesn't dominate the fallback slot on an unrelated outage. This is an
// accepted trade-off of design A (Score-neutral ordering over a form axis that no longer discriminates).
//
// Exported for the cross-mirror sync test (worker/src/__tests__/api-tier-sync.test.ts) — that test
// is the only safeguard against drift between the three independent copies of this map (#403).
export const API_TIER: Record<string, number> = {
  claude: 1, openai: 1, gemini: 1,
  mistral: 2, cohere: 2, groq: 2, together: 2, fireworks: 2, cerebras: 2, deepseek: 2, kimi: 2, xai: 2, perplexity: 2,
  bedrock: 3, azureopenai: 3, openrouter: 3,
  elevenlabs: 4, assemblyai: 4, deepgram: 4,
  // Tier 5 = generative Video (#602 / #601 step B). A distinct tier so a degraded video service
  // recommends its video sibling (distance 0) over a tier-3 LLM router / infra service.
  runway: 5, luma: 5,
  // Tier 6 = LLM Observability (#601 step B). LangSmith + Helicone + Langfuse recommend each other;
  // LangSmith un-excluded from EXCLUDE_FALLBACK now that the category has ≥2 members.
  langsmith: 6, helicone: 6, langfuse: 6,
  // Tier 7 = Image generation (#756 / #601 step B). Stability + FLUX recommend each other; both
  // un-excluded from EXCLUDE_FALLBACK now that the category has ≥2 members. A distinct tier so a
  // degraded image service recommends its image sibling (distance 0) over an LLM/voice/infra service.
  stability: 7, bfl: 7,
  // Tier 8 = Vector database (#857 / #601 step B). Pinecone + turbopuffer recommend each other; pinecone
  // un-excluded from EXCLUDE_FALLBACK now that the category has ≥2 members. A distinct tier so a degraded
  // vector DB recommends its vector sibling (distance 0) over an LLM/voice/image/infra service.
  pinecone: 8, turbopuffer: 8,
  // Tier 11 = Coding agents (#1027) — one tier for all six; multi-form (CLI + IDE), Score-ordered.
  claudecode: 11, codex: 11, cursor: 11, windsurf: 11, copilot: 11, junie: 11,
  // App-category services. All four share tier 21, so same-tier distance collapses to 0
  // across every pairing and ordering reduces to Score — identical to the pre-#403 `?? 99`
  // fall-through, just without the warn-once noise. Entries exist only to suppress the
  // `tierFor` warn-once that would otherwise fire whenever chatgpt/claudeai/deepseekapp surface as
  // the affected service in a fallback flow (Character.AI is in EXCLUDE_FALLBACK so it never does).
  chatgpt: 21, claudeai: 21, characterai: 21, deepseekapp: 21,
}

// #403 — surfaces the silent-fallback failure mode that produced #402 (Junie-as-#1) without
// changing the runtime behavior. When a service id isn't in API_TIER (typo, forgotten entry on a
// new service, partial cross-mirror sync), the lookup still resolves to 99 — but the Cloudflare
// Worker logs now carry a one-time breadcrumb so the next "why is fallback ordering weird?" debug
// session has a starting point. Module-scoped Set so the warning is throttled per worker isolate;
// repeated calls for the same id stay quiet.
const warnedTierIds = new Set<string>()
// #1119 — throttles the "routed but nobody survived" warning below, per (source, tier), per isolate.
const warnedEmptyRoutes = new Set<string>()
export function tierFor(id: string): number {
  const t = API_TIER[id]
  if (t !== undefined) return t
  if (!warnedTierIds.has(id)) {
    warnedTierIds.add(id)
    console.warn(`[fallback] no API_TIER for service "${id}" — falling back to 99 (Score-only ordering)`)
  }
  return 99
}

interface FallbackCandidate {
  id: string
  category: string
  name: string
  status: string
  /** #550 — used to exclude candidates with an unresolved incident (operational-but-incident).
   *  #811 — `title` lets `hasActiveIncident` ignore a non-reliability ADVISORY (access suspension /
   *  compliance / deprecation), which must NOT disqualify an otherwise-operational candidate. */
  incidents?: Array<{ status: string; title?: string }>
  /** #616 — stale incident source (#591). Excluded from Score ranking, so it must also be excluded
   *  as a fallback candidate: recommending a service we don't trust enough to rank contradicts the
   *  same product surface. */
  incidentSourceStale?: boolean
  aiwatchScore?: number | null
  /** #1062 facet B — per-component status snapshot (ServiceStatus.components, #604). Read by
   *  `routingTier` to detect a secondary-capability-only outage (OpenAI 'Images' down while 'Chat
   *  Completions' operational) and route the fallback to that capability's tier. Absent for services
   *  with <2 matched components; those fall to the default. Mistral's Nuxt page now supplies 12
   *  (#761 — derived from its component tree + ongoing-incident attribution). */
  components?: Array<{ name: string; status: string }>
  /** #554 — provider is intentionally NOT read by selection here: the worker has no same-provider
   *  exclusion (the dashboard dropped its dashboard-only one for parity). Carried only so the #554
   *  parity-guard test can prove a same-provider clean candidate is kept — re-adding a provider
   *  filter that reads this field would break that test, catching the drift. */
  provider?: string
}

/** #550 — a service with an unresolved RELIABILITY incident (investigating/identified/monitoring) is not
 *  a healthy fallback even when its computed status is still 'operational' (the partial-degradation case).
 *  #811 — but a non-reliability ADVISORY (e.g. a Claude model-access suspension: operational badge, no
 *  outage signal) must NOT disqualify the candidate — recommending Claude Code when ChatGPT is down is
 *  correct even while Anthropic carries a Mythos/Fable access-suspension notice. An outage-signal title
 *  still counts (isNonReliabilityAdvisory returns false for it), preserving #550 for genuine degradations. */
function hasActiveIncident(s: FallbackCandidate): boolean {
  return (s.incidents ?? []).some(i => i.status !== 'resolved' && !isNonReliabilityAdvisory(i.title ?? ''))
}

// #859 — a specialized non-LLM API sub-tier only recommends its OWN tier. Cross-tier fill (fill top-2
// by tier distance) is correct for the LLM tiers (1 Major LLM / 2 LLM / 3 Infra-router: any LLM API
// substitutes another) but wrong for the specialized sub-tiers — Voice (4) / Video (5) / Observability
// (6) / Image (7) / Vector (8) are NOT mutually substitutable, so a degraded vector DB must not be
// offered an image model as its 2nd recommendation (the exact reason these were split into their own
// tiers in #601/#602/#756/#857). Range 4–10 covers the current + near-future API sub-tiers; agents
// (11) and apps (21) are separate CATEGORIES (filtered by `category` in getFallbacks) and keep
// cross-tier fill within their category, so they're intentionally excluded.
// #1119 exception: that reasoning holds for a NON-routed source only. A routed source is evaluated at
// the CAPABILITY's tier, not its own — so a tier-21 ChatGPT whose 'Image Generation' component is down
// has sourceTier 7, which IS specialized: it gets same-tier-only treatment and no category filter.
export function isSpecializedSubTier(tier: number): boolean {
  return tier >= 4 && tier <= 10
}

// #1062 — capability sub-tags for services whose fallback TIER is not internally substitutable. The
// Voice tier (4) mixes speech-to-text and text-to-speech, which do NOT substitute for each other, so
// `isSpecializedSubTier`'s same-tier gate alone still cross-recommended STT↔TTS (ElevenLabs down →
// AssemblyAI). Each tag is AIWatch's MODELLING of a service's primary substitutable capability, not a
// claim about the vendor's full API surface: `elevenlabs:['tts']` (text-to-speech), `assemblyai:['stt']`
// (transcription), `deepgram:['stt','tts']` (both). A service ABSENT from this map is not capability-
// gated — tier proximity governs it exactly as before, so this narrows nothing outside the listed
// services. Keep the three copies in lockstep with src/utils/constants.js + the api/is-down.ts inline
// copy: api-tier-sync.test.ts deep-equals the DATA on all three and asserts the is-down filter WIRING;
// the 3-line sharesCapability body is kept identical by hand.
export const SERVICE_CAPABILITY: Record<string, string[]> = {
  elevenlabs: ['tts'],
  assemblyai: ['stt'],
  deepgram: ['stt', 'tts'],
}

// #1062 — two services are mutually substitutable only if they share ≥1 capability. When EITHER lacks a
// tag the pair is NOT capability-gated (returns true → tier logic alone decides), so this is a no-op for
// every tier without SERVICE_CAPABILITY entries. (The empty-candidate-set → suppress consequence is
// getFallbacks' emergent behavior; it lives at the call-site comment + docs, not on this pure predicate.)
export function sharesCapability(a: string, b: string): boolean {
  const ca = SERVICE_CAPABILITY[a]
  const cb = SERVICE_CAPABILITY[b]
  if (!ca || !cb) return true
  return ca.some((c) => cb.includes(c))
}

// #1062 facet B — a status-page component NAME (keyword) → the capability it represents. A multi-
// capability service's page names distinct surfaces ("Images"/"Audio"/"Embeddings"/"Sora") separately
// from its primary LLM/chat surface ("Chat Completions"/"Responses"). First match wins; anything
// unmatched is the primary capability 'llm'. Keep in lockstep with the two mirrors + api-tier-sync.test.ts.
// FRAGILITY (accepted): the signal is coupled to today's status-page component NAMES and the list order.
// First-match means "Realtime Audio" would map to `audio` (matched before `realtime`); a rename that
// drops the keyword (OpenAI 'Images' → 'DALL·E') silently falls to `llm` → default LLM peers. Both fail
// SAFE (a wrong reroute never happens, only a missed one), so this is a best-effort signal, not a
// guarantee — re-check the map when a monitored multi-capability service renames a component.
export const COMPONENT_CAPABILITY: Array<[RegExp, string]> = [
  [/image/i, 'image'],
  [/\b(sora|video)\b/i, 'video'],
  [/audio|speech|voice|transcri/i, 'audio'],
  [/embed/i, 'embeddings'],
  [/realtime/i, 'realtime'],
]
export function capabilityOfComponent(name: string): string {
  for (const [re, cap] of COMPONENT_CAPABILITY) if (re.test(name)) return cap
  return 'llm'
}

// #1062 facet B — the fallback TIER a degraded secondary capability routes to. A capability ABSENT from
// this map (the mechanical suppress trigger, via routingTier's `cap in CAPABILITY_TIER ? … : SUPPRESS`)
// has no monitored substitute → suppressed rather than mis-recommended. `embeddings`: no entry because
// there is no embeddings tier — Voyage is both EXCLUDE_FALLBACK'd and untiered; enabling it needs #880 to
// add a sibling + an API_TIER embeddings tier AND an entry here. `realtime`: no peer at all. Keep in lockstep.
// LIVE CONSEQUENCE of the missing `embeddings` entry, recorded so it is a decision and not a
// side effect: an embeddings-ONLY outage at a service whose components[] names an embeddings surface
// emits NO fallback on any surface (RSS item, Discord alert, is-down card, Analyze modal) instead of
// the pre-#1062 default LLM peers. That is already live for OpenAI and Cohere (whose components
// include `embeddings`/`embed-*`), and #761 adds Mistral (`Embeddings API`) to the same behaviour —
// deliberately, so all three act alike rather than Mistral keeping a wrong-capability recommendation.
// #880 (Jina sibling + an embeddings tier + un-excluding Voyage) is what flips all of them to routing.
export const CAPABILITY_TIER: Record<string, number> = {
  image: 7, // Stability / FLUX
  video: 5, // Runway / Luma
  // Voice tier. NB facet A's STT/TTS gate does NOT apply to a routed audio outage: the routed source
  // (e.g. OpenAI) is untagged in SERVICE_CAPABILITY, so sharesCapability(source, voice-svc) is always
  // true and ALL Voice services are eligible. That is acceptable here — OpenAI's 'Audio' component
  // covers both Whisper (STT) and TTS, so recommending the whole Voice tier is correct, not a facet-A miss.
  audio: 4,
}
// Sentinel: a single secondary-capability outage whose capability has no available peer tier → emit
// nothing (route-else-suppress) rather than fall through to a wrong-capability LLM peer.
const ROUTE_SUPPRESS = -1

// #1062 facet B — the human label a ROUTED group is shown under, so the recommendation self-describes
// WHY it switched: a routed OpenAI-'Images' outage reads "Image generation → Stability AI · FLUX", not a
// bare tier "Image → …" that leaves the reader guessing why an image tool is offered for an OpenAI
// outage. Distinct from TIER_LABEL (the category, "Image"): this names the affected CAPABILITY. Keep in
// lockstep with the two mirrors (pinned by api-tier-sync.test.ts). Only the routable caps need an entry.
export const CAPABILITY_LABEL: Record<string, string> = {
  image: 'Image generation',
  video: 'Video generation',
  audio: 'Audio / speech',
}

// #1062 facet C — the REVERSE of routing: multimodal LLM services that ALSO provide a specialized
// capability via a MONITORED component, so a DEDICATED capability service's outage (Stability image /
// Runway video / ElevenLabs voice) can recommend them too, not only its same-tier sibling. Only OpenAI
// qualifies today: it exposes `Images` / `Sora` / `Audio` as monitored statusComponentIds, so its
// overall status (worst-of those) is a faithful proxy for the capability's health — an operational
// OpenAI necessarily has an operational image/video/audio component. Gemini's Imagen/Veo are SEPARATE
// Vertex products AIWatch does not monitor (no components[]), so it cannot be included faithfully.
// Keep in lockstep with the two mirrors (pinned by api-tier-sync.test.ts).
export const CAPABILITY_PROVIDERS: Record<string, string[]> = {
  image: ['openai'],
  video: ['openai'],
  audio: ['openai'],
}

// #1062 facet C — is `candidateId` a cross-tier provider of the capability whose dedicated tier is
// `sourceTier`? getFallbacks uses it to widen a specialized sub-tier's candidate pool (Image 7 / Video 5 /
// Voice 4) to the multimodal providers, which the tier-distance sort then ranks AFTER the dedicated
// sibling. Returns false for tiers with no capability (observability/vector) or a non-provider candidate.
// The candidate's normal operational/clean filter still applies, so a degraded OpenAI is never offered.
export function isCapabilityProvider(candidateId: string, sourceTier: number): boolean {
  const cap = Object.keys(CAPABILITY_TIER).find((k) => CAPABILITY_TIER[k] === sourceTier)
  return cap ? (CAPABILITY_PROVIDERS[cap]?.includes(candidateId) ?? false) : false
}

// #1062 facet B — when a multi-capability service is non-operational ONLY because a SECONDARY-capability
// component is degraded (its primary LLM/chat surface still operational), the fallback must route to that
// capability's tier — recommending LLM peers is wrong (OpenAI 'Images' down does not make Claude, which
// has no image-generation API, a substitute). Returns:
//   • null           → no routing; use the source's own tier. The safe default, taken when the primary
//                      ('llm') surface is among the degraded components, when there is no per-component
//                      signal (no components[]) or none is actually non-operational, OR ≥2 DISTINCT
//                      secondary capabilities are degraded (ambiguous — don't guess which to route to).
//   • ROUTE_SUPPRESS → exactly one secondary capability degraded but it has no available peer tier —
//                      because it has no CAPABILITY_TIER entry (`realtime`; `embeddings`, whose peer
//                      Voyage is both EXCLUDE_FALLBACK'd AND untiered until #880) → suppress.
//   • a tier number  → route candidates to that capability's tier.
// Requires components[]. No enumeration of "which services are multi-capability" is kept here: the
// set is emergent (any service whose components[] names a surface COMPONENT_CAPABILITY matches), the
// two previous attempts to list it were both wrong, and a stale list reads as a guarantee. Derive it
// from SERVICES × COMPONENT_CAPABILITY if you need it.
// Mistral (#761) is worth one note because its components[] is DERIVED, not published: its Nuxt page
// exposes no component status, so the snapshot comes from the component tree overlaid with each
// ongoing incident's own `services[]` attribution. A live "Audio API Degraded" therefore routes to
// the Voice tier — the case #1062 originally reported.
// CAVEAT: components[] is sourced from `displayComponentIds` while the OVERALL status that gates
// anchoring is resolved separately (statusComponentIds, or — for Mistral — from incidents). When the
// two disagree, the component that drove the outage can be ABSENT from components[] → degraded.size
// === 0 → default tier. This is live for Mistral, not hypothetical: displayComponentIds covers only
// its 12 "API"-group components, so an incident on the "Services" group's `Vibe` or `Document
// Library` (neither of which `incidentExclude` drops) degrades the badge while every listed component
// still reads operational. Acceptable — it fails to the default, never to a wrong capability — but do
// not assume the two sets agree; verify when adding a service.
export function routingTier(svc: FallbackCandidate | undefined): number | null {
  const comps = svc?.components
  if (!comps || comps.length === 0) return null
  const degraded = new Set(
    comps.filter((c) => c.status !== 'operational').map((c) => capabilityOfComponent(c.name)),
  )
  if (degraded.size === 0 || degraded.has('llm') || degraded.size > 1) return null
  const cap = [...degraded][0]
  return cap in CAPABILITY_TIER ? CAPABILITY_TIER[cap] : ROUTE_SUPPRESS
}

// #1062 facet B — the affected secondary CAPABILITY when this outage ROUTES (a single non-llm cap with a
// peer tier), else null. Companion to routingTier: routedCapability(svc) is non-null ⟺ routingTier(svc)
// is a positive tier (pinned by a unit test). getGroupedFallbacks reads it to LABEL the routed group by
// capability ("Image generation") instead of the bare tier ("Image"), so the routing is self-describing.
export function routedCapability(svc: FallbackCandidate | undefined): string | null {
  const comps = svc?.components
  if (!comps || comps.length === 0) return null
  const degraded = new Set(
    comps.filter((c) => c.status !== 'operational').map((c) => capabilityOfComponent(c.name)),
  )
  if (degraded.size !== 1) return null
  const cap = [...degraded][0]
  return cap !== 'llm' && cap in CAPABILITY_TIER ? cap : null
}

// #1062 facet B — the tier a service's fallback group is drawn from + LABELLED by: the routed capability
// tier for a secondary-only outage, else the service's own tier. Used by getGroupedFallbacks so a routed
// OpenAI-'Images' outage draws from tier 7 (Stability/FLUX) not LLM. (A suppressed route keeps the
// service's own tier for labelling, but getFallbacks returns [] so the group is dropped before display.)
export function effectiveTierFor(svc: FallbackCandidate): number {
  const routed = routingTier(svc)
  return routed !== null && routed !== ROUTE_SUPPRESS ? routed : tierFor(svc.id)
}

export function getFallbacks(
  serviceId: string,
  category: string,
  services: FallbackCandidate[],
): Array<{ name: string; score: number | null }> {
  if (EXCLUDE_FALLBACK.includes(serviceId)) return []
  // #1062 facet B — if the outage is a single secondary-capability component (e.g. OpenAI 'Images'),
  // route candidates to that capability's tier; if it has no peer tier (realtime/embeddings), suppress.
  const routed = routingTier(services.find(s => s.id === serviceId))
  if (routed === ROUTE_SUPPRESS) return []
  const sourceTier = routed ?? tierFor(serviceId)
  // #859 — for a specialized sub-tier source, restrict candidates to the SAME tier (no cross-tier bleed).
  const sameTierOnly = isSpecializedSubTier(sourceTier)
  const inSourceTier = (id: string) => tierFor(id) === sourceTier
  const admittedBySubTier = (id: string) => inSourceTier(id) || isCapabilityProvider(id, sourceTier)
  // #1119 — a ROUTED outage draws candidates from the CAPABILITY's tier, so the source's own category
  // must not gate them: the image tier lives in `api` while the source (ChatGPT) is an `app`, and the
  // unconditional category filter emptied the pool → the card showed NO recommendation at all. That is
  // worse than the pre-#1062 default AND worse than what a service with NO components[] gets (DeepSeek
  // App, which publishes no components at all, still recommends claude.ai) — precision in our data was
  // reducing the recommendation to zero. Scope of the relaxation, deliberately narrow:
  //   • only when routing fired; every non-routed path keeps `s.category === category` untouched.
  //   • `routed > 0`, NOT `routed !== null`. ROUTE_SUPPRESS (-1) already returned above, so today the
  //     two spellings select the same rows — the difference is COUNTERFACTUAL and about failing loudly:
  //     if that early return is ever removed or reordered, `!== null` would absorb a suppressed route
  //     into this branch, where it still yields [] by accident (tier -1 matches nothing) and all four
  //     ROUTE_SUPPRESS tests stay green. `routed > 0` sends it to the category filter instead, which
  //     returns real candidates and fails them — measured: removing the early return kills 4 tests
  //     under this spelling and 0 under `!== null`.
  //   • candidates stay pinned to the routed tier. Stated HERE rather than leaned on via `sameTierOnly`,
  //     so a CAPABILITY_TIER entry added outside the specialized range could never silently widen this
  //     to "every operational service in every category".
  //   • the routed branch uses `inSourceTier`, NOT the facet-C-widened `admittedBySubTier`. Facet C
  //     exists so a DEDICATED capability service's outage can also offer the multimodal provider
  //     (Stability down → OpenAI); pulling that into the cross-category branch would answer a routed
  //     ChatGPT image outage with "try OpenAI API" — the same provider, off the same status page, and a
  //     developer console offered to a consumer. The dedicated tier is the right pool for a routed
  //     source. (`CAPABILITY_PROVIDERS` holds one entry today, `openai`, so this subtracts that one.)
  //   • app (21) / agent (11) can never be a routing DESTINATION: every CAPABILITY_TIER value is an api
  //     sub-tier, no app/agent id sits in a specialized tier, and CAPABILITY_PROVIDERS holds no app/agent
  //     id. All three legs are pinned by the INVARIANT test — the sentence is load-bearing, not decorative.
  // An agent-category source may route too (a hypothetical Cursor 'Audio'-only outage → Voice tier).
  // That is INTENDED, not an oversight: capability equality holds regardless of category. No agent
  // component name we currently configure matches COMPONENT_CAPABILITY, so it is unreachable today —
  // recorded so it doesn't read as a bug. (Component NAMES are live status-page data; a provider rename
  // could make it reachable with no signal here.)
  const routedCross = routed !== null && routed > 0
  const picked = services
    // The two id-only guards run FIRST, before any tier lookup. Six of the nine EXCLUDE_FALLBACK
    // members are deliberately absent from API_TIER, and the source itself may be an id it doesn't
    // carry — so
    // letting a tier lookup see either fires `tierFor`'s warn-once, the #402/#403 "someone forgot a tier
    // entry" breadcrumb, for services where nothing is wrong. On the Edge mirror that warn set is
    // per-REQUEST, so it would be false alarms on every routed page view, drowning the real signal.
    .filter(s => !EXCLUDE_FALLBACK.includes(s.id) && s.id !== serviceId
      && (routedCross ? inSourceTier(s.id) : s.category === category)
      && s.status === 'operational' && !hasActiveIncident(s) && !s.incidentSourceStale
      // #1062 facet C — a specialized sub-tier (Image/Video/Voice) also admits the multimodal providers of
      // its capability (OpenAI), which the tier-distance sort ranks after the dedicated sibling.
      && (!sameTierOnly || admittedBySubTier(s.id))
      // #1062 — within a capability-mixed tier (Voice), only a candidate sharing a capability qualifies
      && sharesCapability(serviceId, s.id))
    .sort((a, b) => {
      // Prefer same or adjacent tier to the affected service
      const tierA = tierFor(a.id)
      const tierB = tierFor(b.id)
      const distA = Math.abs(tierA - sourceTier)
      const distB = Math.abs(tierB - sourceTier)
      if (distA !== distB) return distA - distB
      // Within same tier distance, sort by Score descending
      return (b.aiwatchScore ?? 0) - (a.aiwatchScore ?? 0)
    })
    .slice(0, 2)
  // #1119 — a routed outage that finds NOBODY is indistinguishable, on every surface, from an outage
  // that never routed: both render nothing. That silence is what let this bug live for weeks. Every
  // routable tier has only 2-3 members, so one sibling incident empties the pool again. Warn once per
  // (source, tier) so the next occurrence leaves a breadcrumb in the Worker logs instead of nothing.
  if (routedCross && picked.length === 0) {
    const key = `${serviceId}:${sourceTier}`
    if (!warnedEmptyRoutes.has(key)) {
      warnedEmptyRoutes.add(key)
      console.warn(`[fallback] "${serviceId}" routed to tier ${sourceTier} but no candidate survived — no recommendation will render on any surface`)
    }
  }
  return picked.map(s => ({ name: s.name, score: s.aiwatchScore ?? null }))
}

export function buildFallbackText(fallbacks: Array<{ name: string; score: number | null }>): string {
  // #641 — no recommendation → emit nothing (the Discord embed omits an empty fallbackText). We
  // don't assert "no fallback available": that's a subjective claim from our own (incomplete)
  // coverage and may be inaccurate — "we have no recommendation" ≠ "no alternative exists".
  if (fallbacks.length === 0) return ''
  const list = fallbacks.map((f, i) => {
    const label = f.score != null ? `${f.name} (Score ${f.score})` : f.name
    return label
  }).join(' · ')
  return `👉 Suggested fallback: ${list}`
}

const CATEGORY_LABEL: Record<string, string> = {
  api: 'API', app: 'AI Apps', agent: 'Coding Agent',
}
// #1027 — coding agents collapse to a single "Coding Agent" label (was CLI/IDE/Plugin Agent). It
// matches CATEGORY_LABEL[agent], mirroring how tier 21 matches CATEGORY_LABEL[app], so the grouped
// fallback line reads "Coding Agent: Claude Code (Score 90)". LLM / Voice / Infra stay bare because
// those abbreviations are already self-identifying as service categories in the API space.
// Exported for the cross-mirror sync test (#403). Mirrored as TIER_LABEL in src/utils/constants.js;
// Overview.jsx imports from there so there is no third inline copy to drift against.
export const TIER_LABEL: Record<number, string> = {
  1: 'LLM', 2: 'LLM', 3: 'Infra', 4: 'Voice', 5: 'Video', 6: 'Observability', 7: 'Image', 8: 'Vector',
  11: 'Coding Agent', // #1027 — single tier for all coding agents (matches CATEGORY_LABEL[agent])
  21: 'AI Apps', // matches CATEGORY_LABEL[app] so the existing buildGroupedFallbackText copy stays consistent
}

// #403 — same shape as tierFor, for tier numbers that lack a label. Returns undefined (not a
// sentinel string) because the call sites use `tierLabel ? … : fallback` semantics — a sentinel
// would break that branch. The warning is the operator-visibility part; the return is identical
// to the bare lookup it replaces.
const warnedLabelTiers = new Set<number>()
export function tierLabelFor(tier: number): string | undefined {
  const l = TIER_LABEL[tier]
  if (l !== undefined) return l
  if (!warnedLabelTiers.has(tier)) {
    warnedLabelTiers.add(tier)
    console.warn(`[fallback] no TIER_LABEL for tier ${tier} — grouped fallback display will degrade to bare category label`)
  }
  return undefined
}

/**
 * #781 — structured per-category grouped fallbacks for a (possibly multi-surface) incident. ONE group
 * per distinct `category:tierLabel` — or, at a SPECIALIZED tier, per `tier:<n>` with no category
 * prefix (#1119) — among the affected, non-operational services; within a group the candidates come
 * from getFallbacks (operational + incident-free, Score-ordered) — same category, EXCEPT a #1119
 * routed group, whose candidates come from the routed capability's tier instead.
 *
 * perGroup mirrors the frontend `getGroupedFallbacks` (src/utils/constants.js) for dashboard parity:
 * **2 when there is a single group** (a same-category incident → top-2 alternatives, the old flat
 * behavior), **1 when there are multiple groups** (a multi-category incident → one alternative per
 * category, so the line stays scannable). Free of I/O and of any dependence on call order, though
 * `getFallbacks` beneath it may emit a throttled #1119 warn; the worker surfaces (Discord alert via
 * buildGroupedFallbackText, RSS feed via fallbackLine) render this structure their own way.
 */
export function getGroupedFallbacks(
  affectedServiceIds: string[],
  services: FallbackCandidate[],
): Array<{ label: string; capability?: string; fallbacks: Array<{ name: string; score: number | null }> }> {
  const groupKeyOf = (svc: FallbackCandidate) => {
    // #1062 facet B — key by the EFFECTIVE tier (routed capability tier for a secondary-only outage),
    // so a routed OpenAI-'Images' outage groups + labels as Image, not the source's LLM tier.
    // #1119 — the key groups anchors that draw from the same POOL. It does that on two of the three
    // axes a pool depends on, and the third is a pre-existing limitation recorded at the end of this
    // comment — do not read the rule as a full partition.
    // A ROUTED anchor's pool is determined by its routed tier (`inSourceTier`, no category, no facet-C
    // widening), so routed anchors at one tier share a key regardless of category:
    // `openai` (api) and `chatgpt` (app) read the SAME status page and route together on one image
    // incident, and under the old `category:tierLabel` key they produced two groups of identical
    // content — rendered twice, and `resolved.length` 1→2 collapsed perGroup 2→1 so the second
    // alternative silently vanished. A NON-routed anchor keeps `category:tierLabel`.
    //
    // A routed and a non-routed anchor at the SAME tier deliberately stay SEPARATE, even though that
    // costs a perGroup slot. Their pools are genuinely different, so merging them answers one anchor
    // with the other's candidates: facet C admits `openai` for a plain Stability outage but the routed
    // branch excludes it, so a merged Image group hands a routed ChatGPT image outage "try OpenAI API"
    // — the exact recommendation `inSourceTier` exists to prevent, re-entering one level up. Facet A is
    // the same shape in Voice: a plain ElevenLabs (TTS) outage excludes AssemblyAI (STT), a routed
    // anchor does not, and whichever anchor happens to be first in the array would decide. Two honest
    // groups beat one that is wrong for half its anchors — that is the trade this key makes.
    //
    // Self-exclusion does NOT break the merge, though `getFallbacks` drops `s.id === serviceId`:
    // anchoring and candidacy are exact complements (anchor = non-operational OR carrying an incident;
    // candidate = operational AND clean), so a co-anchor is never in the other's pool to begin with.
    //
    // KNOWN LIMITATION, pre-existing and not fixed here: the routed pool also depends on the ANCHOR's
    // own `SERVICE_CAPABILITY` tag via `sharesCapability`, which this key does not encode. Two routed
    // Voice-tier anchors whose tags differ — a TAGGED one (`elevenlabs` tts / `assemblyai` stt) and an
    // UNTAGGED one (OpenAI `Audio`, Mistral `Audio API`, a ChatGPT `Voice Mode`) — therefore share a
    // group whose contents are decided by array order, and the tagged anchor can be answered with the
    // wrong half of the Voice tier (ElevenLabs TTS → AssemblyAI STT, the case #1062 facet A exists to
    // prevent). Tier 4 only, and `deepgram` never diverges (it carries both tags). Pre-#1119 both
    // anchors keyed `api:Voice` and collapsed identically, so this is neither introduced nor repaired
    // by #1119 — it is named here so the rule above is not mistaken for a guarantee it does not make.
    // Tracked in #1129, which is why the behaviour is pinned as OBSERVED in fallback.test.ts rather
    // than left undiscovered: that test is the assertion #1129 flips.
    const routed = routingTier(svc)
    if (routed !== null && routed > 0) return `routed:${routed}`
    const tierLabel = tierLabelFor(effectiveTierFor(svc))
    return tierLabel ? `${svc.category}:${tierLabel}` : svc.category
  }
  // An affected surface anchors a group when it's genuinely having a problem — non-operational OR
  // operational-but-carrying-an-active-incident (#550, the partial-degradation case where status stays
  // 'operational'). Matches the frontend getGroupedFallbacks intent (which trusts its `affected` list);
  // here the list comes from the incident's own surfaces, so an operational member is the #550 edge, not
  // a clean service. EXCLUDE_FALLBACK members never anchor (we have no recommendation discipline for them).
  const eligible = affectedServiceIds
    .map(id => services.find(s => s.id === id))
    .filter((s): s is FallbackCandidate =>
      !!s && !EXCLUDE_FALLBACK.includes(s.id) && (s.status !== 'operational' || hasActiveIncident(s)))
  // #1062 facet B — resolve each anchor's candidates FIRST, keeping only groups that will actually
  // render. A routed service that SUPPRESSES (Realtime/embeddings) yields no candidates, and its
  // `effectiveTierFor` falls back to its own (LLM) tier — so if it reserved the `api:LLM` key (as a
  // pre-resolve `seen.add` did), a later genuinely-LLM-down sibling sharing that key was silently
  // dropped, and it also inflated `numGroups`, needlessly narrowing surviving groups to perGroup=1.
  // First-NON-EMPTY-per-key wins; numGroups is the count of rendered groups.
  const resolved: Array<{ label: string; capability?: string; fallbacks: Array<{ name: string; score: number | null }> }> = []
  const seen = new Set<string>()
  for (const svc of eligible) {
    const key = groupKeyOf(svc)
    if (seen.has(key)) continue
    const fbs = getFallbacks(svc.id, svc.category, services)
    if (fbs.length === 0) continue // suppressed / no candidate → does NOT reserve the key
    seen.add(key)
    // #1062 facet B — a routed group is labelled by the affected CAPABILITY ("Image generation"), so the
    // recommendation self-describes WHY it switched; a non-routed group keeps its tier/category label.
    const cap = routedCapability(svc)
    const label = cap ? CAPABILITY_LABEL[cap] : (tierLabelFor(effectiveTierFor(svc)) || CATEGORY_LABEL[svc.category] || svc.category)
    resolved.push({ label, ...(cap ? { capability: cap } : {}), fallbacks: fbs })
  }
  const perGroup = resolved.length <= 1 ? 2 : 1
  return resolved.map(g => ({ label: g.label, ...(g.capability ? { capability: g.capability } : {}), fallbacks: g.fallbacks.slice(0, perGroup) }))
}

export function buildGroupedFallbackText(
  affectedServiceIds: string[],
  services: FallbackCandidate[],
): string {
  const groups = getGroupedFallbacks(affectedServiceIds, services)
  if (groups.length === 0) return '' // #641 — no recommendation → emit nothing (see buildFallbackText)
  const lines = groups.map(g => {
    const list = g.fallbacks.map(f => (f.score != null ? `${f.name} (Score ${f.score})` : f.name)).join(' · ')
    return `${g.label}: ${list}`
  })
  return `👉 Suggested fallback:\n${lines.join('\n')}`
}

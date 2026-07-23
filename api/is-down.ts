// Vercel Edge Function — "Is X Down?" SSR pages

import { SLUG_TO_SERVICE } from './_is-down/slug-map'
import { getSEOContent } from './_is-down/seo-content'
import { renderPage } from './_is-down/html-template'
import { cspForHtml } from './_shared/csp-hash'
import { computeRankPosition } from './_is-down/ranking'
import { regionStatusOf, type RegionStatusResult } from './_is-down/region-status'
import { buildSupplyChainNote, type SupplyChainBannerLike, type SupplyChainNote } from './_is-down/supply-chain-note'
import { buildUpstreamNote, type UpstreamLinkLike, type UpstreamNote } from './_is-down/upstream-note'

export const config = { runtime: 'edge' }

const WORKER_API = 'https://aiwatch-worker.p2c2kbf.workers.dev'
// Keep in sync with worker/src/fallback.ts and src/utils/constants.js
const EXCLUDE_FALLBACK = ['replicate', 'huggingface', 'fal', 'voyageai', 'modal', 'characterai', 'bedrock', 'azureopenai', 'twelvelabs'] // #756 — stability un-excluded (image sibling FLUX added); #758 — fal excluded (self-serve inference platform); #857 — pinecone un-excluded (vector sibling turbopuffer added, tier 8)

// #378: notify the Worker when this Edge Function falls back to a degraded
// render so an operator Discord alert fires. Worker handles 5-min KV dedup, so
// fan-out across concurrent requests collapses to a single notice per surface
// per slug per 5min. Awaited with a tight timeout so the user-facing fallback
// response isn't blocked when the Worker is the very thing that's unhealthy —
// 500ms is enough for a healthy Worker to respond from the same edge region
// and short enough that a fully-down Worker doesn't compound the user wait.
const ALERT_TIMEOUT_MS = 500

async function notifyEdgeFallback(slug: string, reason: string): Promise<void> {
  const token = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.EDGE_ALERT_TOKEN
  if (!token) return  // not configured → skip silently in local/preview
  try {
    await fetch(`${WORKER_API}/api/internal/edge-fallback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ surface: 'is-down', slug, reason }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    })
  } catch (err) {
    // Swallow — the alert is best-effort. The user-facing fallback render is
    // unaffected; if alerting itself is broken, that is a separate signal.
    console.warn(`[is-down/${slug}] edge-fallback alert dispatch failed:`, err instanceof Error ? err.message : err)
  }
}

// Per-isolate dedup for repeated ops signals — re-fires on cold start / per isolate in
// the fleet, which gives operators enough visibility on deploy without log-volume
// scaling with request rate.
const warnedExcludedSlugs = new Set<string>()       // target passed isFinite but failed hasReliableData
const warnedMissingSlugs = new Set<string>()        // SLUG_TO_SERVICE id not present in API response
const warnedDroppedScoreKeys = new Set<string>()    // services with non-finite aiwatchScore in API response

export default async function handler(req: Request) {
  try {
    const url = new URL(req.url)
    const slug = url.searchParams.get('slug') ?? ''
    // Social share status hint (`?e=`, #539): pins the OG card status to the share moment so a
    // tweet's unfurled card matches the post (not the live status, which may have drifted by then).
    const ogStatusHint = url.searchParams.get('e')
    // #804 — per-incident token (`&i=`, appended by buildTweetDrafts/buildReplyDraft). Included in
    // og:url ONLY so a NEW outage is a distinct social card from the prior `?e=down` share (platforms
    // cache the card by og:url for ~7d). It only namespaces a cache key, so sanitize defensively:
    // restrict to id-safe chars + cap length (the real ids are short alphanumeric statuspage ids).
    // NOTE colon-bearing ids (e.g. Gemini's `aistudio:`/`vertex:`-prefixed incident ids, reachable via
    // the reply draft) are intentionally COLLAPSED here (`:` stripped) — the strip is deterministic, so
    // the token stays stable across re-shares of the same incident and unique-enough across incidents.
    const rawIncidentToken = url.searchParams.get('i')
    const ogIncidentToken = rawIncidentToken
      ? rawIncidentToken.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || null
      : null

    const entry = SLUG_TO_SERVICE[slug]
    if (!entry) {
      return new Response('Not Found', { status: 404 })
    }

    const seo = getSEOContent(slug)
    if (!seo) {
      return new Response('Not Found', { status: 404 })
    }

    // Single API call to the KV-backed /api/status/cached (fast SSR). The cron refreshes that cache
    // on every status-change edge (#488), so an incident is visible here within one cron cycle —
    // without paying the ~34-service live fan-out of /api/status on this high-traffic SEO surface.
    let serviceData = null
    let fallbacks: Array<{ id: string; name: string; score: number | null; status: string }> = []
    // #1062 facet B — set when the outage ROUTES to a capability tier (OpenAI 'Images' down → image tier),
    // so the Alternatives block heading names the affected capability ("… for image generation").
    let fallbackCapabilityLabel: string | undefined
    let aiInsight: { summary: string; estimatedRecovery: string; affectedScope: string[]; analyzedAt: string; needsFallback?: boolean; resolvedAt?: string; estimatedRecoveryHours?: number; firstEstimatedRecoveryHours?: number; startedAt?: string } | null = null
    // #926 — the worker returns ONE analysis per active incident (aiAnalysis: Record<svcId, AIAnalysisResult[]>).
    // Keep the FULL array for the visible AI Analysis card (parity with the dashboard AnalysisModal, which
    // renders every incident); `aiInsight` above stays the primary [0] used by the meta/share/OG surfaces,
    // which can only carry a single summary.
    let aiInsights: Array<{ summary: string; estimatedRecovery: string; affectedScope: string[]; analyzedAt: string; needsFallback?: boolean; resolvedAt?: string; estimatedRecoveryHours?: number; firstEstimatedRecoveryHours?: number; startedAt?: string; incidentTitle?: string }> = []
    // #574 — supply-chain note for THIS service (set if it's in the banner's affectedNow/mayBeAffected).
    let supplyChainNote: SupplyChainNote | null = null
    let upstreamNote: UpstreamNote | null = null
    // Track the precise reason for the fallback render so the Discord alert can
    // distinguish operational classes (timeout vs HTTP failure vs missing service
    // vs JSON parse error). Defaults to a generic label that should never ship —
    // overwritten below before use.
    let fallbackReason: string = 'unknown'

    const result = await Promise.allSettled([
      fetch(`${WORKER_API}/api/status/cached`, { signal: AbortSignal.timeout(5000) }),
    ])

    if (result[0].status === 'fulfilled' && result[0].value.ok) {
      try {
        const data = await result[0].value.json() as {
          services: Array<{
            id: string; name: string; category: string; status: string
            latency: number | null; uptime30d: number | null; uptimeSource?: string
            lastChecked: string; incidents: unknown[]; aiwatchScore?: number | null
            scoreGrade?: string | null; scoreConfidence?: string; incidentSourceStale?: boolean
            partialCount?: number // #722 — BetterStack sub-threshold affected-resource count
            // #1004 — source liveness. The template renders an honest "Unknown" instead of a Yes/No
            // answer when AIWatch could not READ the provider's page (a `degraded` from the 3-strike
            // fetch-failure fallback is a statement about our fetch, not about the service).
            sourceDead?: boolean; sourceUnknown?: boolean
            probeConfirmed?: boolean; probeContradicted?: boolean
            components?: Array<{ id: string; name: string; status: 'operational' | 'degraded' | 'down'; group?: string }>
            componentGroupsInline?: boolean // array-order (groups interleaved) breakdown layout (replicate)
          }>
          // #926 — the worker returns an ARRAY per service (one entry per active incident). The prior
          // non-array annotation was wrong (a runtime array was silently collapsed to [0]); the Array.isArray
          // guard below still tolerates a stray single object defensively.
          aiAnalysis?: Record<string, Array<{ summary: string; estimatedRecovery: string; affectedScope: string[]; needsFallback?: boolean; analyzedAt: string; incidentId: string; resolvedAt?: string; estimatedRecoveryHours?: number; firstEstimatedRecoveryHours?: number }>>
          // #574 — supply-chain banner: when this service is in affectedNow/mayBeAffected, render a note.
          // Shape declared once, next to the logic that reads it — two copies of one wire contract drift.
          supplyChainBanner?: SupplyChainBannerLike
          // #1053 — cross-provider upstream links (a dependent's own incident blames a provider that is
          // itself down). Optional: a worker predating #1053 omits the key entirely (deploy skew).
          upstreamLinks?: UpstreamLinkLike[]
        }
        const allServices = data.services ?? []

        // Extract target service
        const target = allServices.find(s => s.id === entry.id)
        if (target) {
          serviceData = target
        } else {
          // Distinct fallback reason — JSON was valid but the slug isn't in the
          // services array (config drift between SLUG_TO_SERVICE and the Worker's
          // SERVICES list). Different operational class than a parse failure.
          fallbackReason = 'service_missing'
          if (!warnedMissingSlugs.has(slug)) {
            warnedMissingSlugs.add(slug)
            console.error(`[is-down/${slug}] service id "${entry.id}" not in API response — SLUG_TO_SERVICE is out of sync with worker/src/services.ts`)
          }
        }

        // Calculate rank by AIWatch Score — match dashboard logic (src/pages/Ranking.jsx):
        // 1. A service is score-rankable when its feed is live AND `scoreConfidence !== 'low'` — EXACT
        //    mirror of serviceReliability.js:hasReliableScoreData (#713). `low` confidence means the
        //    worker found NEITHER an official uptime % NOR a real probe (e.g. Bedrock/Azure — scored on
        //    only incidents+recovery, which over-scores under the rescale), so it's excluded from the
        //    rank; a `high`/`medium` service (has official uptime, or a probe) is ranked. Keeps this in
        //    lockstep with the dashboard (avoids the cross-surface drift #591/#713).
        // 2. Use competition ranking (1, 2, 4=, 4=, 4=, 7=, ...) based on rounded score,
        //    not array index — otherwise tied services display different ranks per service
        if (Number.isFinite(target?.aiwatchScore)) {
          // #802 — ALSO exclude a recently-added service (<30d coverage) from the ranked set: its
          // incident/recovery/responsiveness Score components are based on a thin observed window, so it
          // would rank off insufficient data. `coverageDays` absent = established → full coverage.
          const hasReliableData = (s: { scoreConfidence?: string; incidentSourceStale?: boolean; coverageDays?: number }) =>
            !s.incidentSourceStale && s.scoreConfidence !== 'low' && (s.coverageDays == null || s.coverageDays >= 30)
          const targetScore = Math.round(target!.aiwatchScore as number)
          if (!hasReliableData(target!)) {
            // Target itself fails the reliability filter — dedup'd to avoid log spam
            if (!warnedExcludedSlugs.has(slug)) {
              warnedExcludedSlugs.add(slug)
              console.warn(`[is-down/${slug}] target excluded from ranked set (low-confidence score — no official uptime + no probe, or stale incident source #591/#713) — check SLUG_TO_SERVICE vs scoreConfidence/incidentSourceStale`)
            }
          } else {
            // Use Number.isFinite instead of != null so NaN scores (from a corrupt pipeline)
            // don't silently corrupt the sort order or tie-count. Dedup by dropped-ids set
            // so a persistently-NaN service doesn't spam logs on every request.
            const dropped = allServices.filter(s => s.aiwatchScore != null && !Number.isFinite(s.aiwatchScore))
            if (dropped.length > 0) {
              const key = dropped.map(d => d.id).sort().join(',')
              if (!warnedDroppedScoreKeys.has(key)) {
                warnedDroppedScoreKeys.add(key)
                console.error(`[is-down] non-finite aiwatchScore for: ${key}`)
              }
            }
            const scored = allServices
              .filter(s => Number.isFinite(s.aiwatchScore) && hasReliableData(s))
              .sort((a, b) => (b.aiwatchScore as number) - (a.aiwatchScore as number))
            // #787 — rank by ROUNDED score (competition ranking: tied services share the first
            // position), derivation extracted to the pure computeRankPosition for deterministic tests.
            const { rank, tied: isTied, total } = computeRankPosition(scored as Array<{ aiwatchScore: number }>, targetScore)
            if (rank > 0) {
              (serviceData as any).rank = rank;
              (serviceData as any).rankTied = isTied;
              (serviceData as any).totalRanked = total
            } else {
              // Should be unreachable — target passed all filters but isn't in scored.
              // Log so the asymmetry between target-check and filter-check is visible.
              console.error(
                `[is-down/${slug}] rank lookup failed despite passing filters: ` +
                `targetScore=${targetScore}, scoredLen=${scored.length}, ` +
                `sampleScores=${scored.slice(0, 5).map(s => Math.round(s.aiwatchScore as number)).join(',')}`,
              )
            }
          }
        } else if (target?.aiwatchScore != null) {
          // Target has a non-null but non-finite score (NaN/Infinity) — hard pipeline bug.
          console.error(`[is-down/${slug}] target.aiwatchScore is not finite:`, target.aiwatchScore)
        }

        // Build fallbacks from same data (tier-based priority for API services + coding agents)
        // Cross-mirror sync test (worker/src/__tests__/api-tier-sync.test.ts) reads this file via fs
        // and asserts every key in worker/src/fallback.ts API_TIER appears here, so a partial sync
        // fails CI. The inline copy is necessary because the Edge Function bundle can't pull from
        // worker/src/* (separate compilation surface).
        const API_TIER: Record<string, number> = {
          claude: 1, openai: 1, gemini: 1,
          mistral: 2, cohere: 2, groq: 2, together: 2, fireworks: 2, cerebras: 2, deepseek: 2, kimi: 2, xai: 2, perplexity: 2,
          bedrock: 3, azureopenai: 3, openrouter: 3,
          elevenlabs: 4, assemblyai: 4, deepgram: 4,
          runway: 5, luma: 5, // Video (#602 / #601 step B) — keep in sync with worker/src/fallback.ts
          langsmith: 6, helicone: 6, langfuse: 6, // Observability (#601) — keep in sync with worker/src/fallback.ts
          stability: 7, bfl: 7, // Image (#756) — keep in sync with worker/src/fallback.ts
          pinecone: 8, turbopuffer: 8, // Vector (#857) — keep in sync with worker/src/fallback.ts
          claudecode: 11, codex: 11, cursor: 11, windsurf: 11, copilot: 11, junie: 11, // Coding agents (#1027) — one tier; keep in sync with worker/src/fallback.ts
          chatgpt: 21, claudeai: 21, characterai: 21, deepseekapp: 21,
        }
        // Inline tierFor — same warn-once shape as worker/src/fallback.ts and src/utils/constants.js.
        // The Edge Function runs once per request so the warned set is functionally a one-shot per
        // request, not per session — still useful for surfacing typos in the access log.
        const warnedTierIds = new Set<string>()
        const tierFor = (id: string): number => {
          const t = API_TIER[id]
          if (t !== undefined) return t
          if (!warnedTierIds.has(id)) {
            warnedTierIds.add(id)
            console.warn(`[is-down/${slug}] no API_TIER for service "${id}" — falling back to 99 (Score-only ordering)`)
          }
          return 99
        }
        // #1062 — inline mirror of worker/src/fallback.ts SERVICE_CAPABILITY / sharesCapability. The Voice
        // tier (4) mixes STT/TTS (AIWatch models elevenlabs=tts, assemblyai=stt, deepgram=both — the
        // primary substitutable capability, not the vendor's full surface), so the same-tier gate alone
        // still cross-recommended STT↔TTS. A service absent from the map is not capability-gated.
        // api-tier-sync.test.ts deep-equals this DATA block vs the worker copy AND asserts the filter still
        // calls sharesCapability below; the 3-line body is kept identical to the worker copy by hand.
        const SERVICE_CAPABILITY: Record<string, string[]> = {
          elevenlabs: ['tts'], assemblyai: ['stt'], deepgram: ['stt', 'tts'],
        }
        const sharesCapability = (a: string, b: string): boolean => {
          const ca = SERVICE_CAPABILITY[a], cb = SERVICE_CAPABILITY[b]
          if (!ca || !cb) return true
          return ca.some(c => cb.includes(c))
        }
        // #1062 facet B — inline mirror of worker/src/fallback.ts routingTier. When THIS service's own
        // component snapshot shows ONLY a single secondary-capability surface degraded (e.g. OpenAI
        // 'Images' down, 'Chat Completions' operational), route the fallback to that capability's tier
        // instead of LLM peers; a capability with no CAPABILITY_TIER entry (realtime; embeddings until #880
        // adds a tier) suppresses. Keep identical to the worker copy: api-tier-sync.test.ts pins this via
        // SOURCE match (Edge can't be imported) — CAPABILITY_TIER deep-equal, each COMPONENT_CAPABILITY
        // [regex, cap] literal, the routingTier guards (has('llm') / size>1 / route-else-suppress), and the
        // routingTier(target) wiring. Not execution-verified; keep the body byte-identical to the worker.
        const COMPONENT_CAPABILITY: Array<[RegExp, string]> = [
          [/image/i, 'image'], [/\b(sora|video)\b/i, 'video'],
          [/audio|speech|voice|transcri/i, 'audio'], [/embed/i, 'embeddings'], [/realtime/i, 'realtime'],
        ]
        const CAPABILITY_TIER: Record<string, number> = { image: 7, video: 5, audio: 4 }
        const CAPABILITY_LABEL: Record<string, string> = { image: 'Image generation', video: 'Video generation', audio: 'Audio / speech' }
        // #1062 facet C — inline mirror. Multimodal providers admitted into a dedicated capability tier's
        // candidate pool (only OpenAI has monitored image/video/audio components → faithful health proxy).
        const CAPABILITY_PROVIDERS: Record<string, string[]> = { image: ['openai'], video: ['openai'], audio: ['openai'] }
        const isCapabilityProvider = (candidateId: string, srcTier: number): boolean => {
          const cap = Object.keys(CAPABILITY_TIER).find(k => CAPABILITY_TIER[k] === srcTier)
          return cap ? (CAPABILITY_PROVIDERS[cap]?.includes(candidateId) ?? false) : false
        }
        const ROUTE_SUPPRESS = -1
        const routingTier = (svc?: { components?: Array<{ name: string; status: string }> }): number | null => {
          const comps = svc?.components
          if (!comps || comps.length === 0) return null
          const degraded = new Set(comps.filter(c => c.status !== 'operational').map(c => {
            for (const [re, cap] of COMPONENT_CAPABILITY) if (re.test(c.name)) return cap
            return 'llm'
          }))
          if (degraded.size === 0 || degraded.has('llm') || degraded.size > 1) return null
          const cap = [...degraded][0]
          return cap in CAPABILITY_TIER ? CAPABILITY_TIER[cap] : ROUTE_SUPPRESS
        }
        const routed = routingTier(target)
        // #1062 facet B — human label for a routed outage's capability, so the is-down "🔄 Alternatives"
        // heading reads "Alternatives for image generation" (self-describing). Derived by inverting
        // CAPABILITY_TIER on the routed tier (injective); undefined when the outage does not route.
        if (typeof routed === 'number' && routed > 0) {
          const cap = Object.keys(CAPABILITY_TIER).find(k => CAPABILITY_TIER[k] === routed)
          fallbackCapabilityLabel = cap ? CAPABILITY_LABEL[cap] : undefined
        }
        if (!EXCLUDE_FALLBACK.includes(entry.id) && routed !== ROUTE_SUPPRESS) {
          const sourceTier = routed ?? tierFor(entry.id)
          // #859 — a specialized non-LLM API sub-tier (Voice 4 / Video 5 / Observability 6 / Image 7 /
          // Vector 8) recommends its OWN tier only (no cross-tier bleed); LLM tiers 1-3 keep cross-tier
          // fill. Mirror of worker/src/fallback.ts isSpecializedSubTier (range 4-10). Inline here like tierFor.
          const sameTierOnly = sourceTier >= 4 && sourceTier <= 10
          const inSourceTier = (id: string) => tierFor(id) === sourceTier
          const admittedBySubTier = (id: string) => inSourceTier(id) || isCapabilityProvider(id, sourceTier)
          // #1119 — inline mirror of the worker rule (full rationale in worker/src/fallback.ts
          // getFallbacks): a ROUTED outage draws from the CAPABILITY's tier, so the source's category
          // must not gate it — an `app` ChatGPT image outage has to reach the `api` image tier, which
          // the unconditional category filter emptied into NO recommendation at all. Only the routed
          // path relaxes; `routed > 0` keeps ROUTE_SUPPRESS suppressed by its own guard alone; the
          // routed branch pins to `inSourceTier` (NOT the facet-C-widened form, which would answer a
          // routed ChatGPT image outage with "try OpenAI API" — same provider, developer console);
          // api → app/agent stays impossible because no CAPABILITY_TIER value is an app/agent tier.
          const routedCross = routed !== null && routed > 0
          fallbacks = allServices
            // #550 — exclude candidates with an unresolved incident even if status is still 'operational'.
            // Deliberately BROADER than BOTH `hasLiveIncident` (_is-down/html-template.ts), which excludes
            // `monitoring`, AND worker `fallback.ts`'s own gate, which exempts #811 advisory titles. Not a
            // mirror of either — the divergence is the point:
            // recommending a service whose recovery is only just being confirmed is a
            // worse error than omitting it, so this gate stays conservative. #1104 widened the window
            // this fires in — an incident now survives our own component's recovery — see
            // docs/reference/status-determination.md.
            // #616 — exclude stale-source services (#591): ranking-excluded → not a trusted fallback either.
            // #1119 — EXCLUDE_FALLBACK first, so a tier lookup never sees the six deliberately-untiered
            // services. `warnedTierIds` above is per-REQUEST on the Edge, so a routed page would
            // otherwise log six "no API_TIER" false alarms on EVERY view (#402/#403 breadcrumb).
            .filter(s => !EXCLUDE_FALLBACK.includes(s.id) && s.id !== entry.id
              && (routedCross ? inSourceTier(s.id) : s.category === entry.category)
              && s.status === 'operational'
              && !(s.incidents ?? []).some(i => (i as { status?: string }).status !== 'resolved')
              && !s.incidentSourceStale
              // #1062 facet C — a specialized sub-tier also admits the multimodal providers of its capability
              && (!sameTierOnly || admittedBySubTier(s.id))
              // #1062 — within a capability-mixed tier (Voice), only a capability-sharing candidate qualifies
              && sharesCapability(entry.id, s.id))
            .sort((a, b) => {
              const distA = Math.abs(tierFor(a.id) - sourceTier)
              const distB = Math.abs(tierFor(b.id) - sourceTier)
              if (distA !== distB) return distA - distB
              return ((b as any).aiwatchScore ?? 0) - ((a as any).aiwatchScore ?? 0)
            })
            .slice(0, 2)
            .map(s => ({ id: s.id, name: s.name, score: (s as any).aiwatchScore ?? null, status: s.status }))
        }

        // Extract AI analysis for this service. #926 — take the WHOLE array (one entry per active
        // incident), not just [0], so a multi-incident service renders every AI card (dashboard parity).
        const analyses = data.aiAnalysis?.[entry.id]
        const analysisList = Array.isArray(analyses) ? analyses : analyses ? [analyses] : []
        // Show AI insight if analysis exists (incident may be active even when status is operational)
        if (analysisList.length > 0) {
          // #827 F4 — attach each matching incident's startedAt so a RESOLVED card can show
          // "predicted vs actual" (actual = startedAt→resolvedAt); estimatedRecoveryHours rides on
          // the analysis. Incidents live on the fetched SERVICE (`target`), NOT the slug-config
          // `entry` (which has no `incidents`). `target` may be undefined on the `service_missing`
          // config-drift path (which doesn't return) while `aiAnalysis` still has an entry — optional-
          // chain so we never throw to the fallback render; absent → the card shows the bare estimate.
          const incidents = (target?.incidents as Array<{ id?: string; startedAt?: string; title?: string }> | undefined) ?? []
          aiInsights = analysisList
            .map(a => {
              const inc = incidents.find(i => i.id === a.incidentId)
              // #926 — carry the incident title too so a multi-incident card can label each sub-block
              // (the dashboard modal does the same, keyed on incidentId).
              return { ...a, ...(inc?.startedAt ? { startedAt: inc.startedAt } : {}), ...(inc?.title ? { incidentTitle: inc.title } : {}) }
            })
            // #926 — order newest-incident-first so the AI card lines up with the "Recent Incidents"
            // section on the same page. That section sorts status-tier-then-recency (active before
            // resolved), so this pure startedAt-desc order matches it in the dominant all-active case;
            // a mixed active+recently-resolved set can differ, which is acceptable. startedAt-less last.
            .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
          aiInsight = aiInsights[0] // primary (freshest incident) — meta/share/OG carry a single summary
        }

        // #574/#1000 — supply-chain note (region choice is load-bearing; see supply-chain-note.ts).
        supplyChainNote = buildSupplyChainNote(data.supplyChainBanner, entry.id)
        // #1053 — cross-provider upstream note (the dependent's OWN claim; see upstream-note.ts).
        upstreamNote = buildUpstreamNote(data.upstreamLinks, entry.id)
      } catch (parseErr) {
        fallbackReason = 'parse_error'
        console.error(`[is-down/${slug}] JSON parse failed:`, parseErr instanceof Error ? parseErr.message : parseErr)
      }
    } else if (result[0].status === 'fulfilled' && !result[0].value.ok) {
      fallbackReason = `worker_http_${result[0].value.status}`
      console.error(`[is-down/${slug}] API returned HTTP ${result[0].value.status}`)
    } else if (result[0].status === 'rejected') {
      const err = result[0].reason
      fallbackReason = err?.name === 'AbortError' ? 'worker_timeout' : 'worker_unreachable'
      console.error(`[is-down/${slug}] API fetch ${err?.name === 'AbortError' ? 'timeout' : 'failed'}:`, err?.message)
    }

    // Region recommendation (refs #422 Phase 2). regionStatusOf returns null
    // when the service has no region map, no relevant incident, or every
    // region is hit — the template's renderRegionRecommendation treats null
    // as "skip the line entirely" so passing it directly is safe.
    let regionRec: RegionStatusResult | null = null
    if (serviceData) {
      try {
        regionRec = regionStatusOf(serviceData)
      } catch (regionErr) {
        // Region computation is best-effort — never block the page render.
        // Edge logs the error so a future drift between the Worker's incident
        // shape and our `IncidentLike` type is visible.
        console.warn(`[is-down/${slug}] regionStatusOf threw:`, regionErr instanceof Error ? regionErr.message : regionErr)
      }
    }

    // #641 — when a region switch is offered (the cheaper same-provider fix for a region-specific
    // outage), suppress the cross-service fallback so the page doesn't push a redundant full provider
    // switch alongside it. Condition mirrors renderRegionRecommendation + the ActionBanner.
    if (regionRec && regionRec.hasRegionSpecific && !regionRec.allDown && regionRec.recommendedRegion) {
      fallbacks = []
    }

    // #575 — GATED crowd-report display. Fetch recent user reports ONLY when an independent signal
    // already shows a problem (official degraded/down, OR a BetterStack sub-threshold `partial`).
    // When the official status is operational with no signal we skip the fetch entirely, so the
    // public report list can NEVER contradict an `operational` page (the load-bearing constraint).
    let reports: Array<{ cat: string; desc: string; ts: number }> = []
    if (serviceData && (serviceData.status !== 'operational' || (serviceData.partialCount ?? 0) > 0)) {
      try {
        const r = await fetch(`${WORKER_API}/api/report-feed?svc=${encodeURIComponent(entry.id)}`, { signal: AbortSignal.timeout(2000) })
        if (r.ok) reports = ((await r.json()) as { reports?: Array<{ cat: string; desc: string; ts: number }> }).reports ?? []
      } catch (err) {
        console.warn(`[is-down/${slug}] report-feed fetch failed:`, err instanceof Error ? err.message : err)
      }
    }

    const html = renderPage(slug, serviceData as Parameters<typeof renderPage>[1], seo, fallbacks, aiInsight, regionRec, reports, ogStatusHint, supplyChainNote, ogIncidentToken, aiInsights, upstreamNote, fallbackCapabilityLabel)

    // #378: when the upstream Worker fetch failed and we're rendering the
    // "Status data is temporarily unavailable" fallback, the response must NOT
    // be cached the same way as a successful render. Otherwise a sub-minute
    // Worker blip poisons the Vercel CDN cache for ~6 minutes per region
    // (s-maxage=60 + stale-while-revalidate=300). Diverge both the status code
    // and the Cache-Control so a retry gets a fresh fetch, and notify the
    // Worker so the operator gets a Discord alert.
    const isFallback = serviceData === null
    if (isFallback) await notifyEdgeFallback(slug, fallbackReason)
    // #482 — HASH-based CSP (not nonce): hash THIS response's inline scripts so the policy is
    // derived from the served content. Unlike a random nonce, a content hash stays valid when the
    // page is edge-cached (the cached header's hashes match the cached body), so /is-down keeps its
    // s-maxage=60 edge cache (it's the busiest, outage-viral SEO surface). ENFORCING (Phase 3); the
    // SPA's vercel.json Report-Only header co-applies but never blocks, so the hash policy enforces.
    const csp = await cspForHtml(html, { enforce: true })
    return new Response(html, {
      status: isFallback ? 503 : 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': isFallback
          ? 'no-store, max-age=0, must-revalidate'
          : 'public, s-maxage=60, stale-while-revalidate=300',
        [csp.key]: csp.value,
      },
    })
  } catch (err) {
    console.error('[is-down] Unhandled error:', err instanceof Error ? err.stack : err)
    return new Response(
      '<!DOCTYPE html><html><head><title>AIWatch - Temporarily Unavailable</title></head><body style="background:#080c10;color:#e6edf3;font-family:sans-serif;text-align:center;padding:60px"><h1>Something went wrong</h1><p>Please try again or visit <a href="https://ai-watch.dev" style="color:#58a6ff">AIWatch</a>.</p></body></html>',
      { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } },
    )
  }
}

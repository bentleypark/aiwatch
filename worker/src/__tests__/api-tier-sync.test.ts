// #403 — pin the cross-mirror sync of API_TIER.
//
// Two copies live in this repo (src/utils/constants.js imports the worker's since #1191):
//   1. worker/src/fallback.ts     — canonical (Discord alerts, /api/status fallback recommendations)
//   2. api/is-down.ts             — Edge SSR (Is X Down? pages, inline because of the separate
//                                              compilation surface)
//
// Pre-#403 these were synced only by a comment ("Keep in sync with..."). The Junie-as-#1 bug
// (#402) was the symptom of that drift discipline failing in the *agent* slice; the same failure
// mode is latent for any future cross-mirror update. This test fails CI when the two diverge.
//
// File 2 (api/is-down.ts) can't be imported here — Edge Functions and Workers are different
// compilation surfaces and api/is-down.ts pulls in @vercel/edge types. Read it via fs and check
// every canonical key appears as a `<key>: <number>,` line.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { API_TIER as workerTier, TIER_LABEL as workerLabel, EXCLUDE_FALLBACK as workerExclude, isSpecializedSubTier as workerIsSpecialized, SERVICE_CAPABILITY as workerCap, sharesCapability as workerShares, CAPABILITY_TIER as workerCapTier, capabilityOfComponent as workerCapOf, COMPONENT_CAPABILITY as workerCompCap, CAPABILITY_LABEL as workerCapLabel, CAPABILITY_TAG_LABEL as workerCapTagLabel, routedCapability as workerRoutedCap, routingTier as workerRoutingTier, CAPABILITY_PROVIDERS as workerCapProv, isCapabilityProvider as workerIsCapProv, COMPONENT_AUDIO_TAG as workerAudioTag } from '../fallback'

import { REQUIRED_CAPABILITY as workerRequired, REQUIRED_CAPABILITY_PROVIDERS as workerRequiredProviders, REQUIRED_CAPABILITY_LABEL as workerRequiredLabel } from '../fallback'

const REPO_ROOT = join(__dirname, '..', '..', '..')

describe('API_TIER cross-mirror sync (#403)', () => {
  it('api/is-down.ts inline copy contains every canonical key', () => {
    // The inline literal looks like:  claudecode: 11, codex: 11,
    // We don't reconstruct the full object (would force the file into Vitest's module graph and
    // bring in the @vercel/edge runtime). String-match is sufficient because the canonical
    // worker source is the comparison target — if the inline copy adds a stray key the worker
    // doesn't have, it won't match any worker key here so we'd miss that direction; but the
    // failure mode #403 actually cares about (forgotten add) is fully covered.
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    // Scope to the API_TIER block so we don't accidentally match a key name appearing elsewhere
    // in the file (e.g., a service id in a regex). The block ends at the `}` that closes the
    // object literal — there's exactly one such literal in this file, opened on the line that
    // declares `const API_TIER`.
    const blockMatch = isDownSource.match(/const API_TIER:\s*Record<[^>]+>\s*=\s*\{([\s\S]*?)\n\s*\}/)
    expect(blockMatch, 'API_TIER block not found in api/is-down.ts').not.toBeNull()
    const block = blockMatch![1]
    for (const id of Object.keys(workerTier)) {
      // Match `<id>:` exactly so a typo like `claudecodes:` doesn't pass via substring containment.
      const re = new RegExp(`(^|\\s|,)${id}:\\s*\\d+`)
      expect(re.test(block), `api/is-down.ts API_TIER missing canonical key "${id}"`).toBe(true)
    }
  })

  it('every API_TIER value matches across worker and api/is-down.ts inline', () => {
    // Stronger than the key-presence check above — if the inline literal carries a different
    // tier number for a known id, the cross-surface recommendation diverges silently. Worth
    // catching even though the human reviewer would likely notice the visible change.
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    const blockMatch = isDownSource.match(/const API_TIER:\s*Record<[^>]+>\s*=\s*\{([\s\S]*?)\n\s*\}/)
    const block = blockMatch![1]
    for (const [id, expectedTier] of Object.entries(workerTier)) {
      const re = new RegExp(`(^|\\s|,)${id}:\\s*(\\d+(?:\\.\\d+)?)`)
      const m = block.match(re)
      expect(m, `key "${id}" not found in api/is-down.ts API_TIER`).not.toBeNull()
      expect(Number(m![2]), `tier mismatch for "${id}": worker=${expectedTier}, is-down=${m![2]}`).toBe(expectedTier)
    }
  })
})

describe('TIER_LABEL coverage (#403)', () => {
  it('every API_TIER value has a matching TIER_LABEL entry', () => {
    // Without this guarantee, `tierLabelFor` returns undefined for known tiers and the grouped
    // fallback display silently degrades to bare category labels — exactly the scenario #403
    // is meant to surface. Catching the gap at test time avoids relying on runtime warnings.
    const tierValues = new Set(Object.values(workerTier))
    for (const tier of tierValues) {
      expect(workerLabel[tier], `tier ${tier} appears in API_TIER but has no TIER_LABEL entry`).toBeDefined()
    }
  })
})

// #857 — pin the cross-mirror sync of EXCLUDE_FALLBACK. Same two copies as API_TIER; before #857 this
// list was synced only by a "keep in sync" comment. A forgotten drop of a member (e.g. un-excluding
// pinecone on the dashboard but not on Is-X-Down / Discord) would make a service recommendable on some
// surfaces but not others — the exact drift class #403 built the API_TIER guard for.
describe('EXCLUDE_FALLBACK cross-mirror sync (#857)', () => {
  it('api/is-down.ts inline copy contains every canonical member', () => {
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    // The inline literal: const EXCLUDE_FALLBACK = ['replicate', 'huggingface', ...]
    const blockMatch = isDownSource.match(/const EXCLUDE_FALLBACK\s*=\s*\[([\s\S]*?)\]/)
    expect(blockMatch, 'EXCLUDE_FALLBACK literal not found in api/is-down.ts').not.toBeNull()
    const block = blockMatch![1]
    for (const id of workerExclude) {
      const re = new RegExp(`['"]${id}['"]`)
      expect(re.test(block), `api/is-down.ts EXCLUDE_FALLBACK missing canonical member "${id}"`).toBe(true)
    }
    // And the other direction for the un-exclusion that motivated this test: a member the worker
    // dropped must not linger in the inline copy (pinecone was un-excluded in #857).
    for (const dropped of ['pinecone', 'turbopuffer']) {
      const re = new RegExp(`['"]${dropped}['"]`)
      expect(re.test(block), `api/is-down.ts EXCLUDE_FALLBACK must not contain un-excluded "${dropped}"`).toBe(false)
    }
  })
})

// #859 — pin the worker ↔ is-down parity of isSpecializedSubTier. A drift here would
// make the SEO is-down pages recommend a cross-tier service while the dashboard/Discord do not (or vice
// versa) — the exact silent-divergence class this file exists to prevent.
describe('isSpecializedSubTier cross-mirror sync (#859)', () => {
  it('worker boundaries', () => {
    // Explicit boundary pins so the intent (specialized API sub-tiers 4-10 only) is documented.
    expect([3, 11, 21, 99].some(workerIsSpecialized)).toBe(false) // LLM-router / agents / apps / unknown
    expect([4, 5, 6, 7, 8, 9, 10].every(workerIsSpecialized)).toBe(true) // Voice..Vector (+ headroom)
  })

  it('api/is-down.ts inline range literal matches the worker predicate bounds', () => {
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    // Match the inline `sourceTier >= N && sourceTier <= M` (the #859 sameTierOnly gate).
    const m = isDownSource.match(/sourceTier\s*>=\s*(\d+)\s*&&\s*sourceTier\s*<=\s*(\d+)/)
    expect(m, 'is-down.ts #859 sameTierOnly range literal not found').not.toBeNull()
    const [lo, hi] = [Number(m![1]), Number(m![2])]
    // Derive the worker's true bounds by scanning, so a future range change only needs the two source
    // edits — this test re-derives rather than hardcoding 4/10.
    let workerLo = -1, workerHi = -1
    for (let t = 0; t <= 30; t++) {
      if (workerIsSpecialized(t)) { if (workerLo === -1) workerLo = t; workerHi = t }
    }
    expect(lo, 'is-down lower bound must match worker isSpecializedSubTier').toBe(workerLo)
    expect(hi, 'is-down upper bound must match worker isSpecializedSubTier').toBe(workerHi)
  })
})

// #1062 — pin the worker ↔ is-down parity of SERVICE_CAPABILITY / sharesCapability. A drift
// here would make one surface cross-recommend STT↔TTS while
// another suppresses it — the same silent-divergence class this file guards for API_TIER.
describe('SERVICE_CAPABILITY cross-mirror sync (#1062)', () => {
  it('the STT/TTS intent holds: TTS↔STT do NOT share, Deepgram bridges both', () => {
    // ElevenLabs (TTS) and AssemblyAI (STT) are not mutually substitutable; Deepgram (both) is.
    expect(workerShares('elevenlabs', 'assemblyai')).toBe(false)
    expect(workerShares('elevenlabs', 'deepgram')).toBe(true)
    expect(workerShares('assemblyai', 'deepgram')).toBe(true)
    // An untagged service pair (LLM tier) is never capability-gated — governed by tier logic alone.
    expect(workerShares('openai', 'claude')).toBe(true)
    expect(workerShares('elevenlabs', 'openai')).toBe(true) // one side untagged → not gated
  })

  it('api/is-down.ts inline copy is EXACTLY the canonical map (bidirectional — no extra service / over-broad cap)', () => {
    // Parse the inline literal into an object and deep-equal it against the worker map, mirroring how
    // workerCap is locked. A one-directional subset check (canonical ⊆ inline) would MISS
    // the drift that re-introduces this very bug: an over-broad inline cap like `elevenlabs:['tts','stt']`
    // would make the Edge surface cross-recommend AssemblyAI to a TTS caller. toEqual catches extras too.
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    const blockMatch = isDownSource.match(/const SERVICE_CAPABILITY:\s*Record<[^>]+>\s*=\s*\{([\s\S]*?)\}/)
    expect(blockMatch, 'SERVICE_CAPABILITY block not found in api/is-down.ts').not.toBeNull()
    const block = blockMatch![1]
    const inlineCap: Record<string, string[]> = {}
    for (const m of block.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
      inlineCap[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map(c => c[1])
    }
    expect(inlineCap).toEqual(workerCap)
  })

  it('api/is-down.ts wires the capability gate into the fallback filter (wiring, not just data)', () => {
    // The pure fn / data parity above does not prove the inline getFallbacks actually CALLS the gate —
    // the "순수fn 초록 ≠ 배선 초록" trap. Assert the filter chain still invokes sharesCapability on the
    // Edge surface so a silent removal of the clause (re-opening the STT↔TTS cross-recommendation on
    // is-down) fails CI. Regex-level because the Edge module can't be imported here (see file header).
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    expect(/sharesCapability\(\s*entry\.id\s*,\s*s\.id\s*,\s*targetTags\s*\)/.test(isDownSource),
      'api/is-down.ts fallback filter no longer calls sharesCapability(entry.id, s.id, targetTags)').toBe(true)
  })
})

// #1062 facet B — pin the worker ↔ is-down parity of the capability-ROUTING maps
// (COMPONENT_CAPABILITY via capabilityOfComponent + CAPABILITY_TIER). A drift would make one surface
// route an OpenAI-Images outage to the Image tier while another recommends LLM peers.
describe('CAPABILITY_TIER / capabilityOfComponent cross-mirror sync (#1062 facet B)', () => {
  it('the routing intent holds: modality names map to their capability, else llm', () => {
    expect(workerCapOf('Images')).toBe('image')
    expect(workerCapOf('Sora')).toBe('video')
    expect(workerCapOf('Audio')).toBe('audio')
    expect(workerCapOf('Realtime')).toBe('realtime')
    expect(workerCapOf('Embeddings')).toBe('embeddings')
    expect(workerCapOf('Chat Completions')).toBe('llm')
    // image/video/audio/embeddings route to a tier; realtime deliberately absent (→ suppress).
    expect(workerCapTier).toEqual({ image: 7, video: 5, audio: 4, embeddings: 9 })
  })

  it('api/is-down.ts inline CAPABILITY_TIER is EXACTLY the canonical map', () => {
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    const m = isDownSource.match(/const CAPABILITY_TIER:\s*Record<[^>]+>\s*=\s*\{([^}]*)\}/)
    expect(m, 'CAPABILITY_TIER literal not found in api/is-down.ts').not.toBeNull()
    const inline: Record<string, number> = {}
    for (const e of m![1].matchAll(/(\w+):\s*(\d+)/g)) inline[e[1]] = Number(e[2])
    expect(inline).toEqual(workerCapTier)
  })

  it('api/is-down.ts inline COMPONENT_CAPABILITY carries every canonical regex LITERAL + guards + wires routingTier', () => {
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    // Match to the outer array's closing `]` on its own line — the pairs contain nested `[...]`, so a
    // non-greedy `]` would stop at the first inner bracket.
    const block = isDownSource.match(/const COMPONENT_CAPABILITY:\s*Array<\[RegExp, string\]>\s*=\s*\[([\s\S]*?)\n\s*\]/)
    expect(block, 'COMPONENT_CAPABILITY block not found in api/is-down.ts').not.toBeNull()
    // Pin each canonical [regex, capability] PAIR verbatim — `[/audio|speech|voice|transcri/i, 'audio']` —
    // so weakening an is-down regex (dropping `voice`, or /image/i→/images/i) fails CI, not just a dropped
    // capability string. The Edge module can't be imported, so this literal-match is the strongest pin here.
    for (const [re, cap] of workerCompCap) {
      const pair = `[/${re.source}/${re.flags}, '${cap}']`
      expect(block![1].includes(pair), `api/is-down.ts COMPONENT_CAPABILITY missing exact pair ${pair}`).toBe(true)
    }
    // Pin the routingTier BODY guards too (control-flow copy, not data) so a dropped branch fails CI.
    expect(/degraded\.has\('llm'\)/.test(isDownSource), 'is-down routingTier lost the has(llm) guard').toBe(true)
    expect(/degraded\.size\s*>\s*1/.test(isDownSource), 'is-down routingTier lost the size>1 guard').toBe(true)
    expect(/cap in CAPABILITY_TIER \? CAPABILITY_TIER\[cap\] : ROUTE_SUPPRESS/.test(isDownSource),
      'is-down routingTier lost the route-else-suppress').toBe(true)
    // Wiring: the fallback path must actually consult routingTier on the fetched service.
    expect(/routingTier\(target\)/.test(isDownSource), 'api/is-down.ts no longer calls routingTier(target)').toBe(true)
  })

  it('#1119 — api/is-down.ts inline copy relaxes the category filter ONLY on the routed path', () => {
    // The Edge module can't be imported, so the rule is pinned by source match like the rest of this
    // inline mirror. Four separate things must survive, because each fails differently:
    //   1. the ternary itself — without it the routed ChatGPT card silently shows no Alternatives again
    //   2. `routed > 0` as the condition — counterfactually: if the suppress guard below is ever
    //      removed, `routed !== null` would absorb ROUTE_SUPPRESS (-1) into this branch, where it still
    //      yields nothing by accident (tier -1 matches nothing) and no test notices
    //   3. the suppress guard itself, which must remain the thing that actually suppresses
    //   4. the tier pin on the relaxed branch, and that it is the NON-widened `inSourceTier` — the
    //      facet-C form would answer a routed ChatGPT image outage with "try OpenAI API"
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    expect(/routedCross \? inSourceTier\(s\.id\) : s\.category === entry\.category/.test(isDownSource),
      'is-down lost the #1119 routed-vs-category ternary').toBe(true)
    expect(/const routedCross = routed !== null && routed > 0/.test(isDownSource),
      'is-down routedCross must require a POSITIVE tier, not merely non-null').toBe(true)
    expect(/routed !== ROUTE_SUPPRESS/.test(isDownSource),
      'is-down lost the route-else-suppress guard around the fallback block').toBe(true)
    expect(/const inSourceTier = \(id: string\) => tierFor\(id\) === sourceTier/.test(isDownSource),
      'is-down lost the #1119 routed-tier pin').toBe(true)
    // COUNT, not presence. Every assertion above is `RegExp.test`, which an ADDED line cannot break —
    // re-appending `&& s.category === entry.category` to the filter reverts #1119 on the public surface
    // with all of them still green (measured). Pinning the category comparison to exactly ONE
    // occurrence kills that bypass, since the ternary already contains the only legitimate one.
    expect((isDownSource.match(/s\.category === entry\.category/g) ?? []).length,
      'api/is-down.ts must compare category exactly once — inside the #1119 ternary').toBe(1)
    // Ordering: EXCLUDE_FALLBACK must be evaluated BEFORE any tier lookup, or `tierFor`'s warn-once
    // fires for the deliberately-untiered services — and on the Edge that set is per-REQUEST.
    expect(/\.filter\(s => !EXCLUDE_FALLBACK\.includes\(s\.id\) && s\.id !== entry\.id\s*\n\s*&& \(routedCross \?/.test(isDownSource),
      'is-down must test the id-only guards before the routed-tier lookup').toBe(true)
  })

  it('only routable caps have a CAPABILITY_LABEL', () => {
    // Every label key must be a routable capability (has a CAPABILITY_TIER entry) — a label for a
    // suppressed cap (embeddings/realtime) would never render, signalling a mistake.
    for (const cap of Object.keys(workerCapLabel)) {
      expect(cap in workerCapTier, `CAPABILITY_LABEL has '${cap}' but it has no CAPABILITY_TIER entry`).toBe(true)
    }
  })

  it('#1698 — COMPONENT_AUDIO_TAG worker ≡ is-down literal', () => {
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    for (const [re, tag] of workerAudioTag) {
      const pair = `[/${re.source}/${re.flags}, '${tag}']`
      expect(isDownSource.includes(pair), `api/is-down.ts COMPONENT_AUDIO_TAG missing exact pair ${pair}`).toBe(true)
    }
    expect(isDownSource.includes('if (SERVICE_CAPABILITY[entry.id]) return SERVICE_CAPABILITY[entry.id]'), 'is-down targetTags lost the own-tag-first return').toBe(true)
    expect(isDownSource.includes('return tags.size === 1 ? [...tags] : undefined'), 'is-down targetTags lost the single-tag rule').toBe(true)
  })

  it('#1129 — every CAPABILITY_TAG_LABEL key is a real SERVICE_CAPABILITY sub-tag', () => {
    // A label for a sub-tag no service carries would never render — guard against a dead entry.
    const realTags = new Set(Object.values(workerCap).flat())
    for (const tag of Object.keys(workerCapTagLabel)) {
      expect(realTags.has(tag), `CAPABILITY_TAG_LABEL has '${tag}' but no SERVICE_CAPABILITY entry uses it`).toBe(true)
    }
  })

  it('routedCapability is non-null ⟺ routingTier is a positive tier', () => {
    const comps = (arr: Array<[string, string]>) => arr.map(([name, status]) => ({ name, status }))
    const fixtures = [
      { components: comps([['Chat Completions', 'operational'], ['Images', 'down']]) },        // route image
      { components: comps([['Chat Completions', 'operational'], ['Sora', 'down']]) },           // route video
      { components: comps([['Chat Completions', 'operational'], ['Audio', 'degraded']]) },      // route audio
      { components: comps([['Chat Completions', 'operational'], ['Realtime', 'down']]) },       // suppress
      { components: comps([['Chat Completions', 'operational'], ['Embeddings', 'down']]) },     // suppress
      { components: comps([['Chat Completions', 'down'], ['Images', 'down']]) },                // default (llm)
      { components: comps([['Images', 'down'], ['Audio', 'down']]) },                           // default (≥2)
      { components: [] },                                                                        // default (none)
      { id: 'x' },                                                                               // default (no comps)
    ]
    for (const f of fixtures) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = { id: 'openai', category: 'api', status: 'down', ...f } as any
      const wCap = workerRoutedCap(svc)
      const tier = workerRoutingTier(svc)
      const isPositiveTier = typeof tier === 'number' && tier > 0
      expect(wCap !== null, `routedCapability non-null must match routingTier positive-tier for ${JSON.stringify(f)}`).toBe(isPositiveTier)
    }
  })

  it('api/is-down.ts inline CAPABILITY_LABEL ≡ canonical (used in the Alternatives heading)', () => {
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    const m = isDownSource.match(/const CAPABILITY_LABEL:\s*Record<[^>]+>\s*=\s*\{([^}]*)\}/)
    expect(m, 'CAPABILITY_LABEL literal not found in api/is-down.ts').not.toBeNull()
    const inline: Record<string, string> = {}
    for (const e of m![1].matchAll(/(\w+):\s*'([^']*)'/g)) inline[e[1]] = e[2]
    expect(inline).toEqual(workerCapLabel)
  })

  it('every CAPABILITY_PROVIDERS capability has a tier, and OpenAI provides only the capability tiers (#1062 facet C)', () => {
    // Every provider capability must have a CAPABILITY_TIER entry (else isCapabilityProvider never fires).
    for (const cap of Object.keys(workerCapProv)) {
      expect(cap in workerCapTier, `CAPABILITY_PROVIDERS has '${cap}' but no CAPABILITY_TIER entry`).toBe(true)
    }
    // Intent: OpenAI provides the 3 capability tiers, not the LLM/observability/vector tiers.
    expect([4, 5, 7].every(t => workerIsCapProv('openai', t))).toBe(true)
    expect([1, 6, 8].some(t => workerIsCapProv('openai', t))).toBe(false)
  })

  it('api/is-down.ts inline CAPABILITY_PROVIDERS ≡ canonical + wires isCapabilityProvider into the filter', () => {
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    const m = isDownSource.match(/const CAPABILITY_PROVIDERS:\s*Record<[^>]+>\s*=\s*\{([^}]*)\}/)
    expect(m, 'CAPABILITY_PROVIDERS literal not found in api/is-down.ts').not.toBeNull()
    const inline: Record<string, string[]> = {}
    for (const e of m![1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) inline[e[1]] = [...e[2].matchAll(/'([^']+)'/g)].map(x => x[1])
    expect(inline).toEqual(workerCapProv)
    // #1119 — the filter now reaches isCapabilityProvider through the `admittedBySubTier` helper (the
    // facet-C widening clause only — the routed branch deliberately uses `inSourceTier`), so pin it
    // rather than a bare call site: that is the single place the widening can be dropped.
    expect(/const admittedBySubTier = \(id: string\) => inSourceTier\(id\) \|\| isCapabilityProvider\(id, sourceTier\)/.test(isDownSource),
      'is-down no longer widens the candidate pool via isCapabilityProvider').toBe(true)
    expect(/sameTierOnly \? admittedBySubTier\(s\.id\) :/.test(isDownSource),
      'is-down filter no longer applies the facet-C widening clause').toBe(true)
  })

  it('every REQUIRED_CAPABILITY has providers and a label (#1725)', () => {
    for (const cap of Object.values(workerRequired)) {
      expect(cap in workerRequiredProviders, `REQUIRED_CAPABILITY needs '${cap}' in REQUIRED_CAPABILITY_PROVIDERS`).toBe(true)
      expect(cap in workerRequiredLabel, `REQUIRED_CAPABILITY needs '${cap}' in REQUIRED_CAPABILITY_LABEL`).toBe(true)
    }
  })

  it('api/is-down.ts inline REQUIRED_CAPABILITY* ≡ canonical + wires meetsRequiredCapability into the filter (#1725)', () => {
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    const req = isDownSource.match(/const REQUIRED_CAPABILITY:\s*Record<[^>]+>\s*=\s*\{([^}]*)\}/)
    expect(req, 'REQUIRED_CAPABILITY literal not found in api/is-down.ts').not.toBeNull()
    const inlineReq: Record<string, string> = {}
    for (const e of req![1].matchAll(/(\w+):\s*'([^']*)'/g)) inlineReq[e[1]] = e[2]
    expect(inlineReq).toEqual(workerRequired)
    const prov = isDownSource.match(/const REQUIRED_CAPABILITY_PROVIDERS:\s*Record<[^>]+>\s*=\s*\{([^}]*)\}/)
    expect(prov, 'REQUIRED_CAPABILITY_PROVIDERS literal not found in api/is-down.ts').not.toBeNull()
    const inlineProv: Record<string, string[]> = {}
    for (const e of prov![1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) inlineProv[e[1]] = [...e[2].matchAll(/'([^']+)'/g)].map(x => x[1])
    expect(inlineProv).toEqual(workerRequiredProviders)
    expect(/\(routedCross \|\| meetsRequiredCapability\(entry\.id, s\.id\)\)/.test(isDownSource),
      'is-down filter no longer applies the required-capability clause').toBe(true)
  })
})

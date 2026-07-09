import { describe, test, expect } from 'vitest'
import { regionStatusOf, classifyIncident, SERVICE_REGIONS, REGION_DOCS_URL, REGION_SWITCHABLE } from '../regionStatus'
import { hasRegionSwitch } from '../constants'

describe('classifyIncident', () => {
  test('returns "down" on outage/down/unavailable keywords', () => {
    expect(classifyIncident('Pinecone is down')).toBe('down')
    expect(classifyIncident('Service outage detected')).toBe('down')
    expect(classifyIncident('API unavailable')).toBe('down')
  })

  test('returns "degraded_perf" on latency/slow/timeout/delay keywords', () => {
    expect(classifyIncident('Increased latency on us-east-1')).toBe('degraded_perf')
    expect(classifyIncident('Slow responses')).toBe('degraded_perf')
    expect(classifyIncident('Request timeout')).toBe('degraded_perf')
    expect(classifyIncident('Processing delay')).toBe('degraded_perf')
  })

  test('returns "inference" on inference/model/vertex/bedrock keywords', () => {
    expect(classifyIncident('Inference layer issue')).toBe('inference')
    expect(classifyIncident('Grok model misbehaving')).toBe('inference')
    expect(classifyIncident('Vertex regional issue')).toBe('inference')
  })

  test('falls back to "incident" when no keyword matches', () => {
    expect(classifyIncident('General investigation')).toBe('incident')
    expect(classifyIncident('')).toBe('incident')
    expect(classifyIncident(null)).toBe('incident')
    expect(classifyIncident(undefined)).toBe('incident')
  })

  test('handles non-string input defensively', () => {
    expect(classifyIncident(123)).toBe('incident')
    expect(classifyIncident({})).toBe('incident')
  })
})

describe('regionStatusOf — null guards', () => {
  test('returns null for unknown service id (no region map)', () => {
    expect(regionStatusOf({ id: 'unknown-service', incidents: [] })).toBeNull()
  })

  test('returns null for missing / non-object service', () => {
    expect(regionStatusOf(null)).toBeNull()
    expect(regionStatusOf(undefined)).toBeNull()
    expect(regionStatusOf('pinecone')).toBeNull()
  })

  test('returns null when service has region map but no ongoing incidents AND not always-show', () => {
    // pinecone has a region map, but no incident → skip (alwaysShow=false)
    expect(regionStatusOf({ id: 'pinecone', incidents: [] })).toBeNull()
  })

  test('returns result for always-show services even without incidents (bedrock / azureopenai)', () => {
    // Bedrock + Azure OpenAI render the card unconditionally so users can confirm
    // "regions look healthy" at a glance — without this, an operational state is
    // indistinguishable from "no region data".
    const bedrock = regionStatusOf({ id: 'bedrock', incidents: [] })
    expect(bedrock).not.toBeNull()
    expect(bedrock.allDown).toBe(false)
    expect(bedrock.okRegions.length).toBe(bedrock.regions.length)
    expect(bedrock.ongoingCount).toBe(0)
    expect(bedrock.hasRegionSpecific).toBe(false)

    const azure = regionStatusOf({ id: 'azureopenai', incidents: [] })
    expect(azure).not.toBeNull()
    expect(azure.okRegions.length).toBe(azure.regions.length)
  })
})

describe('regionStatusOf — region matching via incident title', () => {
  test('marks regions matching incident title substring as incident', () => {
    // Title contains the literal region key `AWS us-east-1` (space form). Real
    // Pinecone incidents sometimes use bracket form `[AWS][us-east-1]` instead,
    // which substring-match misses — those cases are matched via componentNames
    // (next describe block) since Atlassian Statuspage always populates that
    // field. Title-substring matching covers feeds that don't have structured
    // components (e.g., RSS-only sources).
    const result = regionStatusOf({
      id: 'pinecone',
      incidents: [{ id: 'p1', status: 'investigating', title: 'AWS us-east-1 5xx errors on read' }],
    })
    expect(result).not.toBeNull()
    expect(result.hasRegionSpecific).toBe(true)
    expect(result.allDown).toBe(false)

    const usEast = result.regions.find((r) => r.key === 'AWS us-east-1')
    expect(usEast.status).toBe('incident')
    // Title contains no down/latency/inference keywords → generic 'incident'
    expect(usEast.type).toBe('incident')

    const usWest = result.regions.find((r) => r.key === 'AWS us-west-2')
    expect(usWest.status).toBe('ok')
  })

  test('recommendedRegion is first OK by SERVICE_REGIONS array order', () => {
    // Pinecone array order: AWS us-east-1, AWS us-west-2, AWS eu-west-1,
    // Azure eastus2, GCP us-central1, GCP europe-west4. Knock out us-east-1 via
    // componentNames (mirrors the real Pinecone Atlassian Statuspage payload —
    // titles use bracket form `[AWS][us-east-1]` which substring-match misses,
    // but components always carry the structured `AWS us-east-1` string).
    // First OK should be us-west-2 (same-cloud first by design).
    const result = regionStatusOf({
      id: 'pinecone',
      incidents: [{
        id: 'p1',
        status: 'investigating',
        title: '[AWS][us-east-1] 5xx errors on read',
        componentNames: ['AWS us-east-1'],
      }],
    })
    expect(result.recommendedRegion?.key).toBe('AWS us-west-2')
    expect(result.recommendedRegion?.label).toBe('AWS US West')
  })

  test('first-match-wins when two ongoing incidents claim the same region with different types', () => {
    // Deliberate semantic — see comment in regionStatus.js where the guard
    // `if (status[r.key].status === 'ok')` lives. Old ServiceDetails.jsx
    // overwrote on every match (last-wins), causing badge color flips across
    // re-renders when upstream re-sorted `service.incidents`. Today's behavior
    // is deterministic: the FIRST matching incident in array order owns the
    // type. Test both orderings to lock the contract.
    const downFirst = regionStatusOf({
      id: 'pinecone',
      incidents: [
        { id: 'a', status: 'investigating', title: 'AWS us-east-1 outage', componentNames: ['AWS us-east-1'] },
        { id: 'b', status: 'investigating', title: 'AWS us-east-1 latency', componentNames: ['AWS us-east-1'] },
      ],
    })
    expect(downFirst.regions.find((r) => r.key === 'AWS us-east-1').type).toBe('down')

    const latencyFirst = regionStatusOf({
      id: 'pinecone',
      incidents: [
        { id: 'b', status: 'investigating', title: 'AWS us-east-1 latency', componentNames: ['AWS us-east-1'] },
        { id: 'a', status: 'investigating', title: 'AWS us-east-1 outage', componentNames: ['AWS us-east-1'] },
      ],
    })
    expect(latencyFirst.regions.find((r) => r.key === 'AWS us-east-1').type).toBe('degraded_perf')
  })

  test('classifies multiple per-region incidents independently by their own title', () => {
    const result = regionStatusOf({
      id: 'gemini',
      incidents: [
        { id: 'g1', status: 'investigating', title: 'us-central1 vertex inference slowness' },
        { id: 'g2', status: 'investigating', title: 'europe-west1 latency spike' },
      ],
    })
    const us = result.regions.find((r) => r.key === 'us-central1')
    const eu = result.regions.find((r) => r.key === 'europe-west1')
    const asia = result.regions.find((r) => r.key === 'asia-northeast1')
    expect(us.status).toBe('incident')
    expect(eu.status).toBe('incident')
    expect(asia.status).toBe('ok')
    expect(result.hasRegionSpecific).toBe(true)
  })
})

describe('regionStatusOf — region matching via componentNames (Bedrock / Azure pattern)', () => {
  test('matches via componentNames when title omits the region key', () => {
    // AWS RSS / Azure RSS sometimes encode the region in the component name
    // ("us-east-1") rather than the title prose ("5xx errors on read"). The
    // matcher walks both surfaces so either source counts.
    const result = regionStatusOf({
      id: 'bedrock',
      incidents: [{
        id: 'b1',
        status: 'investigating',
        title: 'Increased error rates',
        componentNames: ['Amazon Bedrock (us-east-1)'],
      }],
    })
    const usEast = result.regions.find((r) => r.key === 'us-east-1')
    expect(usEast.status).toBe('incident')
    expect(result.hasRegionSpecific).toBe(true)
  })

  test('componentNames matching is case-insensitive', () => {
    const result = regionStatusOf({
      id: 'bedrock',
      incidents: [{ id: 'b1', status: 'investigating', title: 'foo', componentNames: ['US-EAST-1 issue'] }],
    })
    expect(result.regions.find((r) => r.key === 'us-east-1').status).toBe('incident')
  })
})

describe('regionStatusOf — global-incident fallback', () => {
  test('marks all regions as incident when title has no region match', () => {
    const result = regionStatusOf({
      id: 'pinecone',
      incidents: [{ id: 'p1', status: 'investigating', title: 'API authentication broken' }],
    })
    expect(result.hasRegionSpecific).toBe(false)
    expect(result.hasGlobalIncident).toBe(true)
    expect(result.allDown).toBe(true)
    expect(result.recommendedRegion).toBeNull()
    expect(result.regions.every((r) => r.status === 'incident')).toBe(true)
  })

  test('global-incident type is taken from the first ongoing incident', () => {
    const result = regionStatusOf({
      id: 'pinecone',
      incidents: [
        { id: 'p1', status: 'investigating', title: 'Service outage in progress' },
        { id: 'p2', status: 'investigating', title: 'Latency degradation' },
      ],
    })
    expect(result.regions.every((r) => r.type === 'down')).toBe(true)
  })
})

describe('regionStatusOf — region-aware but not region-switchable (#973)', () => {
  test('openai: per-region status still resolves, but no region is recommended', () => {
    // OpenAI names regions in incident text yet exposes no selectable region endpoint. Showing
    // "which region is down" is useful; telling the reader to switch to another is not actionable.
    const result = regionStatusOf({
      id: 'openai',
      status: 'degraded',
      incidents: [{ id: 'r1', status: 'investigating', title: 'Elevated errors in us-east-1' }],
    })
    expect(result).not.toBeNull()
    expect(result.hasRegionSpecific).toBe(true)
    expect(result.regions.find((r) => r.key === 'us-east-1').status).toBe('incident')
    expect(result.okRegions.map((r) => r.key)).toEqual(['us-west-2', 'eu-central-1'])
    // The recommendation — and with it every surface that guards on it — goes quiet.
    expect(result.recommendedRegion).toBeNull()
    expect(result.docsUrl).toBeUndefined()
  })

  test('openai is excluded from region-switch recommendations, so it keeps its cross-service fallback', () => {
    // hasRegionSwitch drives getGroupedFallbacksExcludingRegionSwitchable (#641): a service with
    // no executable region switch must NOT be filtered out of the cross-service fallback list.
    const openai = {
      id: 'openai',
      status: 'degraded',
      incidents: [{ id: 'r1', status: 'investigating', title: 'Elevated errors in us-east-1' }],
    }
    expect(hasRegionSwitch(openai)).toBe(false)
  })

  test('pinecone (switchable) still recommends the next healthy region', () => {
    // Guards the gate from over-reaching: switchable services keep the recommendation.
    const pinecone = {
      id: 'pinecone',
      incidents: [{ id: 'p1', status: 'investigating', title: 'AWS us-east-1 degraded' }],
    }
    expect(regionStatusOf(pinecone).recommendedRegion.key).toBe('AWS us-west-2')
    expect(hasRegionSwitch(pinecone)).toBe(true)
  })

  test('every service with a docs link is switchable (no unreachable links)', () => {
    // chatgpt used to hold a REGION_DOCS_URL entry with no SERVICE_REGIONS map, so regionStatusOf
    // returned null before ever reading it — the url never rendered anywhere (#973).
    for (const id of Object.keys(REGION_DOCS_URL)) {
      expect(REGION_SWITCHABLE.has(id), `${id} has a docs link but is not switchable`).toBe(true)
      expect(SERVICE_REGIONS[id], `${id} has a docs link but no region map`).toBeDefined()
    }
  })
})

describe('regionStatusOf — FedRAMP excluded from region computation (#693)', () => {
  test('openai with ONLY a FedRAMP incident → null (no card, not all-regions-down)', () => {
    // The region-less FedRAMP title would otherwise trip the global fallback and paint
    // all 3 commercial regions down. Excluded → no ongoing incident → card hidden (openai
    // is not an always-show service), matching the pre-#693 behavior.
    const result = regionStatusOf({
      id: 'openai',
      status: 'degraded',
      incidents: [
        { id: 'fr1', status: 'investigating', title: 'FedRAMP workspaces and API orgs have degraded performance' },
      ],
    })
    expect(result).toBeNull()
  })

  test('FedRAMP ignored but a separate us-east-1 incident still marks only that region', () => {
    const result = regionStatusOf({
      id: 'openai',
      status: 'degraded',
      incidents: [
        { id: 'fr1', status: 'investigating', title: 'FedRAMP workspaces and API orgs have degraded performance' },
        { id: 'r1', status: 'investigating', title: 'Elevated errors in us-east-1' },
      ],
    })
    expect(result.allDown).toBe(false)
    expect(result.hasGlobalIncident).toBe(false) // FedRAMP no longer counts as a global incident
    expect(result.ongoingCount).toBe(1) // FedRAMP filtered out
    const east = result.regions.find((r) => r.key === 'us-east-1')
    const west = result.regions.find((r) => r.key === 'us-west-2')
    expect(east.status).toBe('incident')
    expect(west.status).toBe('ok')
  })

  test('a FedRAMP incident that ALSO names a real region is NOT dropped (only that region marked)', () => {
    // The exclusion is gated on "no tracked region mentioned" — a co-mentioned region survives.
    const result = regionStatusOf({
      id: 'openai',
      status: 'degraded',
      incidents: [
        { id: 'fr2', status: 'investigating', title: 'Elevated errors in us-east-1 and FedRAMP workspaces' },
      ],
    })
    expect(result).not.toBeNull()
    expect(result.ongoingCount).toBe(1) // kept — it names us-east-1
    expect(result.allDown).toBe(false)
    expect(result.regions.find((r) => r.key === 'us-east-1').status).toBe('incident')
    expect(result.regions.find((r) => r.key === 'us-west-2').status).toBe('ok')
  })
})

describe('regionStatusOf — hasGlobalIncident flag (#422)', () => {
  test('false when every ongoing incident matches a region', () => {
    const result = regionStatusOf({
      id: 'pinecone',
      incidents: [{ id: 'p1', status: 'investigating', title: 'AWS us-east-1 degraded' }],
    })
    expect(result.hasRegionSpecific).toBe(true)
    expect(result.hasGlobalIncident).toBe(false)
  })

  test('true when a global incident coexists with a region-specific one (region marking unchanged)', () => {
    const result = regionStatusOf({
      id: 'pinecone',
      incidents: [
        { id: 'p1', status: 'investigating', title: 'AWS us-east-1 degraded' },
        { id: 'p2', status: 'investigating', title: 'API authentication broken' }, // matches no region
      ],
    })
    // Both flags true; region marking is intentionally unchanged — only us-east-1 down,
    // so the SPA/Edge render exactly as before (allDown stays false). The flag is what
    // lets the Worker hint suppress in this mixed case.
    expect(result.hasRegionSpecific).toBe(true)
    expect(result.hasGlobalIncident).toBe(true)
    expect(result.allDown).toBe(false)
    expect(result.okRegions.length).toBeGreaterThan(0)
  })
})

describe('regionStatusOf — incident filtering', () => {
  test('skips resolved incidents (only ongoing affect region status)', () => {
    const result = regionStatusOf({
      id: 'pinecone',
      incidents: [
        { id: 'p-old', status: 'resolved', title: 'AWS us-east-1 outage', componentNames: ['AWS us-east-1'] },
        { id: 'p-new', status: 'investigating', title: 'AWS us-west-2 issue', componentNames: ['AWS us-west-2'] },
      ],
    })
    expect(result.regions.find((r) => r.key === 'AWS us-east-1').status).toBe('ok')
    expect(result.regions.find((r) => r.key === 'AWS us-west-2').status).toBe('incident')
  })

  test('resolved + ongoing on the same region key — region picks up the ongoing type, count excludes resolved', () => {
    // Today the resolved filter at the top of regionStatusOf removes resolved
    // entries before the matching loop runs, so this works by construction.
    // If a future refactor moves the resolved skip into the inner loop (e.g.,
    // `if (inc.status === 'resolved') continue`) without removing them from
    // the `ongoing` array, `ongoingCount` would inflate and the resolved
    // incident's classification could leak into the badge. Pin both.
    const result = regionStatusOf({
      id: 'pinecone',
      incidents: [
        { id: 'p-old', status: 'resolved', title: 'AWS us-east-1 prior outage', componentNames: ['AWS us-east-1'] },
        { id: 'p-new', status: 'investigating', title: 'AWS us-east-1 latency', componentNames: ['AWS us-east-1'] },
      ],
    })
    // Region picks up the ONGOING incident's type, not the resolved 'down'.
    expect(result.regions.find((r) => r.key === 'AWS us-east-1').type).toBe('degraded_perf')
    expect(result.regions.find((r) => r.key === 'AWS us-east-1').status).toBe('incident')
    // Only one ongoing — resolved must not inflate the count.
    expect(result.ongoingCount).toBe(1)
  })

  test('skips aistudio:-prefixed incidents (Gemini direct API has no region breakdown)', () => {
    // worker/src/services.ts merges Vertex (gcloud) + AI Studio feeds for Gemini;
    // AI Studio entries get an aistudio: prefix and represent the global direct
    // API surface. Including them in region status would over-warn — the gcloud
    // entries are the only ones with region info.
    const result = regionStatusOf({
      id: 'gemini',
      incidents: [
        { id: 'aistudio:global-1', status: 'investigating', title: 'Gemini API issue' },
      ],
    })
    // All aistudio incidents filtered → ongoingCount===0; no always-show for gemini
    expect(result).toBeNull()
  })

  test('does not crash on incidents with missing / malformed fields', () => {
    // Defensive against upstream feed glitches. Skips bad entries silently.
    const result = regionStatusOf({
      id: 'pinecone',
      incidents: [
        null,
        {},
        { title: 'no id' },
        { id: 'no-title', status: 'investigating' },
        { id: 'good', status: 'investigating', title: 'AWS us-east-1 issue' },
      ],
    })
    expect(result).not.toBeNull()
    expect(result.regions.find((r) => r.key === 'AWS us-east-1').status).toBe('incident')
  })
})

describe('regionStatusOf — docsUrl pass-through', () => {
  test('returns docsUrl when service has a mapping', () => {
    const result = regionStatusOf({
      id: 'pinecone',
      incidents: [{ id: 'p1', status: 'investigating', title: 'AWS us-east-1 issue' }],
    })
    // #973 — asserting only the HOST let a rotted path through: the old
    // `troubleshooting/available-cloud-regions` 301'd to the top of an unrelated guide while
    // still matching /pinecone\.io/ (and still returning 200). Pin the path + the section
    // anchor, which is what actually lands the reader on the region list.
    expect(result.docsUrl).toBe('https://docs.pinecone.io/guides/index-data/create-an-index#cloud-regions')
  })

  test('docsUrl is undefined for services without a mapping', () => {
    // bedrock has a docsUrl in the map; if it didn't, this would be undefined.
    // Sanity-check with a hypothetical service via regionDefs override.
    const result = regionStatusOf(
      { id: 'fake-service', incidents: [{ id: 'x', status: 'investigating', title: 'foo' }] },
      { regions: [{ key: 'r1', label: 'R1' }] },
    )
    expect(result.docsUrl).toBeUndefined()
  })

  test('xai has NO docsUrl — xAI removed its regions doc page (#560)', () => {
    // xai IS region-aware (SERVICE_REGIONS.xai us-east-1/eu-west-1), so a region incident
    // yields a result — but its docs page (docs.x.ai/docs/regions) 404s and was removed with
    // no live replacement, so the "learn more" link must be absent. Pre-fix this returned the
    // dead URL; this test fails if anyone re-adds a (likely still-dead) REGION_DOCS_URL.xai.
    const result = regionStatusOf({
      id: 'xai',
      incidents: [{ id: 'x1', status: 'investigating', title: 'Elevated errors in eu-west-1' }],
    })
    expect(result).not.toBeNull()
    expect(result.docsUrl).toBeUndefined()
  })
})

describe('SERVICE_REGIONS — invariants', () => {
  test('every region entry has both `key` and `label` strings', () => {
    for (const [svcId, regions] of Object.entries(SERVICE_REGIONS)) {
      expect(Array.isArray(regions), `${svcId} regions must be an array`).toBe(true)
      expect(regions.length, `${svcId} has at least 1 region`).toBeGreaterThan(0)
      for (const r of regions) {
        expect(typeof r.key, `${svcId}.${r.key} key must be a string`).toBe('string')
        expect(typeof r.label, `${svcId}.${r.label} label must be a string`).toBe('string')
        expect(r.key.length).toBeGreaterThan(0)
        expect(r.label.length).toBeGreaterThan(0)
      }
    }
  })

  test('region keys within a service are unique (no accidental duplicates)', () => {
    for (const [svcId, regions] of Object.entries(SERVICE_REGIONS)) {
      const keys = regions.map((r) => r.key)
      const unique = new Set(keys)
      expect(unique.size, `${svcId} has duplicate region keys: ${keys}`).toBe(keys.length)
    }
  })
})

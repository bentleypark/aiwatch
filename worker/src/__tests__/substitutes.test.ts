import { describe, it, expect } from 'vitest'
import { SERVICES } from '../services'
import { API_TIER } from '../fallback'
import { SUBSTITUTES, COMPONENT_SUBSTITUTES, substituteGroupsFor, pickSubstitutes, substituteFaqAnswer } from '../../../api/_shared/substitutes'

const categoryOf = new Map(SERVICES.map((s) => [s.id, s.category]))
const tierIds = (tier: number) => Object.keys(API_TIER).filter((id) => API_TIER[id] === tier).sort()

describe('#1753 — SUBSTITUTES data', () => {
  for (const [source, groups] of Object.entries(SUBSTITUTES)) {
    it(`${source}: every candidate is a monitored service of the same category, never the source itself`, () => {
      expect(categoryOf.has(source)).toBe(true)
      for (const g of groups) {
        for (const id of g.ids) {
          expect(categoryOf.get(id), `${source} → ${id}`).toBe(categoryOf.get(source))
          expect(id).not.toBe(source)
        }
      }
    })

    it(`${source}: one group per label, so its groups never merge with each other`, () => {
      const labels = groups.map((g) => g.label)
      expect(new Set(labels).size).toBe(labels.length)
    })
  }

  it('an LLM or LLM Hosting group draws from exactly that tier', () => {
    for (const groups of Object.values(SUBSTITUTES)) {
      for (const g of groups) {
        if (g.label === 'LLM') expect([...g.ids].sort()).toEqual(tierIds(1))
        if (g.label === 'LLM Hosting') expect([...g.ids].sort()).toEqual(tierIds(2))
      }
    }
  })

  it('every evidence entry names an https page and an ISO day', () => {
    for (const groups of Object.values(SUBSTITUTES)) {
      for (const g of groups) {
        for (const e of g.evidence ?? []) {
          expect(e.url).toMatch(/^https:\/\//)
          expect(e.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        }
      }
    }
  })
})

describe('#1753 — substituteGroupsFor', () => {
  it('a service without a list keeps tier routing', () => {
    expect(substituteGroupsFor('claude', null)).toBeNull()
  })

  it('an unrouted outage gets every group, a routed one keeps tier routing', () => {
    expect(substituteGroupsFor('cohere', null)?.map((g) => g.label)).toEqual(['LLM', 'Embeddings'])
    expect(substituteGroupsFor('cohere', 'embeddings')).toBeNull()
  })
})

describe('#1741 — COMPONENT_SUBSTITUTES', () => {
  for (const [source, entry] of Object.entries(COMPONENT_SUBSTITUTES)) {
    it(`${source}: every candidate is a monitored service of the same category, never the source, one group per label`, () => {
      expect(categoryOf.has(source)).toBe(true)
      for (const g of entry.groups) {
        for (const id of g.ids) {
          expect(categoryOf.get(id), `${source} → ${id}`).toBe(categoryOf.get(source))
          expect(id).not.toBe(source)
        }
      }
      expect(new Set(entry.groups.map((g) => g.label)).size).toBe(entry.groups.length)
    })
  }

  const bfl = (down: string[]) => ['API (api.bfl.ai)', 'FLUX.2', 'Flux.3']
    .map((name) => ({ name, status: down.includes(name) ? 'down' : 'operational' }))

  it('a Flux.3-only outage gets both the image and the video group', () => {
    expect(substituteGroupsFor('bfl', null, bfl(['Flux.3']))?.map((g) => g.label)).toEqual(['Image', 'Video'])
  })

  it('any other BFL outage keeps tier routing', () => {
    expect(substituteGroupsFor('bfl', null, bfl(['FLUX.2']))).toBeNull()
    expect(substituteGroupsFor('bfl', null, bfl(['Flux.3', 'FLUX.2']))).toBeNull()
    expect(substituteGroupsFor('bfl', null, bfl([]))).toBeNull()
    expect(substituteGroupsFor('bfl', null)).toBeNull()
  })

  it('a routed outage keeps tier routing', () => {
    expect(substituteGroupsFor('bfl', 'video', bfl(['Flux.3']))).toBeNull()
  })

  it('a degraded component counts as part of the outage, not only a down one', () => {
    const mixed = [{ name: 'Flux.3', status: 'down' }, { name: 'FLUX.2', status: 'degraded' }, { name: 'API (api.bfl.ai)', status: 'operational' }]
    expect(substituteGroupsFor('bfl', null, mixed)).toBeNull()
    const degradedOnly = [{ name: 'Flux.3', status: 'degraded' }, { name: 'FLUX.2', status: 'operational' }]
    expect(substituteGroupsFor('bfl', null, degradedOnly)?.map((g) => g.label)).toEqual(['Image', 'Video'])
  })
})

describe('#1753 — pickSubstitutes', () => {
  const groups = [
    { use: 'a', label: 'A', ids: ['x', 'y', 'z'] },
    { use: 'b', label: 'B', ids: ['w'] },
  ]

  it('keeps only each group\'s own candidates, in the caller\'s order, capped per group, and drops empty groups', () => {
    const picked = pickSubstitutes(groups, [{ id: 'z' }, { id: 'x' }, { id: 'y' }, { id: 'q' }], (c) => [...c].reverse(), 2)
    expect(picked.map((p) => [p.group.label, p.items.map((i) => i.id)])).toEqual([['A', ['y', 'x']]])
  })
})

describe('#1753 — substituteFaqAnswer', () => {
  it('names every listed service under its use, sharing a common API suffix', () => {
    const answer = substituteFaqAnswer('Cohere', SUBSTITUTES.cohere, (id) => ({ claude: 'Claude API', openai: 'OpenAI API', gemini: 'Gemini API', xai: 'SpaceXSI API', mistral: 'Mistral API' })[id] ?? id.toUpperCase())
    expect(answer).toBe('When Cohere is down, these AIWatch-monitored services can stand in. For chat and generation: the Claude, OpenAI, Gemini, SpaceXSI or Mistral API. For embeddings and reranking: VOYAGEAI or JINA. AIWatch shows current availability for each.')
  })
})

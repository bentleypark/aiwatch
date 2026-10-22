import { describe, it, expect } from 'vitest'
import { SERVICES } from '../services'
import { API_TIER } from '../fallback'
import { SUBSTITUTES, substituteGroupsFor, pickSubstitutes, substituteFaqAnswer } from '../../../api/_shared/substitutes'

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
    const answer = substituteFaqAnswer('Cohere', SUBSTITUTES.cohere, (id) => ({ claude: 'Claude API', openai: 'OpenAI API', gemini: 'Gemini API', xai: 'SpaceXAI API', mistral: 'Mistral API' })[id] ?? id.toUpperCase())
    expect(answer).toBe('When Cohere is down, these AIWatch-monitored services can stand in. For chat and generation: the Claude, OpenAI, Gemini, SpaceXAI or Mistral API. For embeddings and reranking: VOYAGEAI or JINA. AIWatch shows current availability for each.')
  })
})

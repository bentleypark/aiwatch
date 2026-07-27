// #1164 — referential integrity for FAMILY_GROUPS (provider-family group pages: /is-claude-down,
// /is-openai-down). Nothing else in the codebase validates these invariants: a typo'd member id
// would silently render that member as "Unknown" in production with no test failure (the group page
// never fabricates a status, so a bad id degrades gracefully — but gracefully-wrong still ships
// unnoticed without this check). A slug that drifts from its own map key would desync the page's
// canonical/og:url/member-link generation (all keyed off `.slug`) from its own routing (keyed off the
// map key) — also silent, also worth pinning.

import { describe, it, expect } from 'vitest'
import { FAMILY_GROUPS, SERVICE_ID_TO_SLUG } from '../slug-map'

describe('FAMILY_GROUPS (#1164)', () => {
  it('every member id is a real, canonical service (resolves via SERVICE_ID_TO_SLUG)', () => {
    for (const [familyKey, family] of Object.entries(FAMILY_GROUPS)) {
      for (const id of family.members) {
        expect(SERVICE_ID_TO_SLUG[id], `FAMILY_GROUPS['${familyKey}'].members includes unknown id '${id}'`).toBeDefined()
      }
    }
  })

  it('each map key equals its own .slug — routing (keyed by map key) and rendering (keyed by .slug) must agree', () => {
    for (const [familyKey, family] of Object.entries(FAMILY_GROUPS)) {
      expect(family.slug, `FAMILY_GROUPS['${familyKey}'].slug should equal its own key`).toBe(familyKey)
    }
  })

  it('every family has at least 2 members — a 1-member "family" is not a group', () => {
    for (const [familyKey, family] of Object.entries(FAMILY_GROUPS)) {
      expect(family.members.length, `FAMILY_GROUPS['${familyKey}'] has fewer than 2 members`).toBeGreaterThanOrEqual(2)
    }
  })

  it('no service id belongs to more than one family', () => {
    const seen = new Map<string, string>()
    for (const [familyKey, family] of Object.entries(FAMILY_GROUPS)) {
      for (const id of family.members) {
        const owner = seen.get(id)
        expect(owner, `service id '${id}' claimed by both '${owner}' and '${familyKey}'`).toBeUndefined()
        seen.set(id, familyKey)
      }
    }
  })

  // #1165 — xai family added (xAI API + Grok consumer app + Cursor, per SpaceX/Anysphere deal).
  it('covers exactly the agreed Anthropic/OpenAI/xAI families (3 groups, 9 services)', () => {
    expect(Object.keys(FAMILY_GROUPS).sort()).toEqual(['claude', 'openai', 'xai'])
    expect(FAMILY_GROUPS.claude.members.slice().sort()).toEqual(['claude', 'claudeai', 'claudecode'])
    expect(FAMILY_GROUPS.openai.members.slice().sort()).toEqual(['chatgpt', 'codex', 'openai'])
    expect(FAMILY_GROUPS.xai.members.slice().sort()).toEqual(['cursor', 'grok', 'xai'])
  })
})

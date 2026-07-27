import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseFlashdutyFeed, type FlashdutyFeed } from '../flashduty'
import fixture from '../../__tests__/fixtures/deepseek-flashduty-v4.json'

// #1171 — DeepSeek's status page reorganized around its V4 models, retiring the single "API 服务"
// and "网页对话服务" components `flashdutyPrimaryComponentId` used to point at (a bare string) and
// replacing them with 2 API components (V4 Pro / V4 Flash) and 5 chat/app components (Instant/Expert/
// Vision Mode, File Upload, Search). A single-id scope matched NOTHING in the reorganized feed, so
// `computeFlashdutyUptime`'s `roster.length === 0` guard silently returned null for both deepseek and
// deepseekapp. This fixture is a REAL capture (2026-07-27) of the post-reorg feed, verifying the
// array-scoped `primaryComponentId` (worst-of across the set) actually resolves it.
const feed = fixture as FlashdutyFeed
const CAPTURED_AT = Date.parse('2026-07-27T01:25:53.656Z')

const API_IDS: [string, ...string[]] = ['01KY4MVS8BM3F9JSYWACGQVG7A', '01KY4MVS8BSBSVW6053QJ37RJE']
const APP_IDS: [string, ...string[]] = [
  '01KY4ND2PNYT9FY5W4ZH80VGJ4', '01KY4ND2PN1CCNW2MFT5VW713H', '01KY4ND2PNJ6MFA4VJ0DSN6M2J',
  '01KY4ND2PNNFFY6QKV67WFJW8N', '01KY4ND2PN6EFSJ4RDYDJYPMNK',
]

describe('parseFlashdutyFeed — array primaryComponentId (#1171)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('a single stale id (the pre-reorg "API 服务") matches nothing in the reorganized feed — the bug', () => {
    const stale = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: '01KR3NC9ETZYF436Z8YT1HM047' })
    expect(stale.flashdutyUptime).toBeNull()
    expect(stale.components).toHaveLength(0)
  })

  it('warns when a scoped id matches 0 of a non-empty feed — the staleness guard this bug was missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: '01KR3NC9ETZYF436Z8YT1HM047' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('primaryComponentId matched 0 of'))
    warn.mockClear()
    parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: API_IDS })
    expect(warn).not.toHaveBeenCalled() // a real match must not warn
  })

  it('the new API component pair resolves a real (non-null) worst-of uptime', () => {
    const api = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: API_IDS })
    expect(api.flashdutyUptime).not.toBeNull()
    expect(api.flashdutyUptime!.pct).toBeGreaterThan(0)
    expect(api.flashdutyUptime!.pct).toBeLessThanOrEqual(100)
    expect(api.components.map((c) => c.id).sort()).toEqual([...API_IDS].sort())
  })

  it('reportedUptime (#1171) is the feed\'s OWN published uptime for the scoped roster, separate from our 30-day recompute', () => {
    // status.deepseek.com's "System status" page itself shows 99.90% for both (standalone, no
    // section) API components — distinct from AIWatch's independently-computed 30-day flashdutyUptime.pct.
    const api = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: API_IDS })
    expect(api.reportedUptime).toBe(99.9)
    expect(api.reportedUptime).not.toBe(api.flashdutyUptime!.pct)

    // The 5 App components all belong to ONE named section ("对话服务/Chat Service"), and the scope
    // covers it exactly — so this reads the section's OWN published uptime (99.74%), not worst-of the
    // leaf component_uptimes (99.73%, the two aren't equal because the provider computes the section
    // figure from its own section_impacts log, not from the leaves).
    const app = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: APP_IDS })
    expect(app.reportedUptime).toBe(99.74)
    expect(app.reportedUptime).not.toBe(app.flashdutyUptime!.pct)
  })

  it('reportedUptime falls back to leaf worst-of for a PARTIAL slice of a section', () => {
    // Only 2 of the section's 5 members in scope — must NOT read the whole-section 99.74% figure,
    // since that number describes all 5, not this subset.
    const partial = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: [APP_IDS[0], APP_IDS[1]] })
    expect(partial.reportedUptime).toBe(99.73) // worst-of the 2 leaves, not the section's 99.74
  })

  it('reportedUptime falls back to leaf worst-of when the scope is the whole section PLUS an unrelated standalone component', () => {
    // Regression test for a real bug caught in review: `sectionIds.size === 1` alone doesn't reject a
    // standalone (no section_id) component mixed into the scope, because a component with no section_id
    // is filtered OUT before that size check — so "all 5 App section members + 1 unrelated API id" used
    // to wrongly read the section's 99.74% (which describes only the 5, not this 6-component mix).
    // Set the extra component's own leaf uptime to a stark 50 so a wrong section-value read (99.74) is
    // unmistakably distinguishable from the correct worst-of-6 fallback (50).
    const mixedFeed: FlashdutyFeed = {
      ...feed,
      structure: {
        ...feed.structure,
        component_uptimes: (feed.structure!.component_uptimes ?? []).map((u) =>
          u.component_id === API_IDS[0] ? { ...u, uptime: 50 } : u,
        ),
      },
    }
    const mixed = parseFlashdutyFeed(mixedFeed, { nowMs: CAPTURED_AT, primaryComponentId: [...APP_IDS, API_IDS[0]] })
    expect(mixed.reportedUptime).toBe(50) // worst-of the mixed 6, NOT the section's 99.74
  })

  it('reportedUptime falls back to leaf worst-of when a matched section has no published section_uptimes entry', () => {
    const noSectionUptime: FlashdutyFeed = {
      ...feed,
      structure: { ...feed.structure, section_uptimes: [] },
    }
    const app = parseFlashdutyFeed(noSectionUptime, { nowMs: CAPTURED_AT, primaryComponentId: APP_IDS })
    expect(app.reportedUptime).toBe(99.73) // no section figure to read — leaf worst-of instead
  })

  it('reportedUptime is null under the same no-match condition as flashdutyUptime', () => {
    const stale = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: '01KR3NC9ETZYF436Z8YT1HM047' })
    expect(stale.reportedUptime).toBeNull()
  })

  it('the new app/chat component set (5) resolves a real (non-null) worst-of uptime', () => {
    const app = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: APP_IDS })
    expect(app.flashdutyUptime).not.toBeNull()
    expect(app.flashdutyUptime!.pct).toBeGreaterThan(0)
    expect(app.flashdutyUptime!.pct).toBeLessThanOrEqual(100)
    expect(app.components.map((c) => c.id).sort()).toEqual([...APP_IDS].sort())
  })

  it('component names are English-cleaned (CJK stripped) now that this breakdown actually renders', () => {
    // #1171 review finding — before this fix, both services matched 0 components so this breakdown
    // never reached ServiceDetails; now that it does, the feed's raw bilingual names must not leak
    // CJK text onto an English UI.
    const api = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: API_IDS })
    const app = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: APP_IDS })
    expect(api.components.map((c) => c.name).sort()).toEqual([
      'DeepSeek V4 Flash API (API Service)',
      'DeepSeek V4 Pro API (API Service)',
    ])
    expect(app.components.map((c) => c.name).sort()).toEqual([
      'Expert Mode', 'File Upload Service', 'Instant Mode', 'Search Service', 'Vision Mode',
    ])
    for (const c of [...api.components, ...app.components]) expect(c.name).not.toMatch(/[一-鿿]/)
  })

  it('API and App scopes are disjoint and each picks up real incident history', () => {
    const api = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: API_IDS })
    const app = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: APP_IDS })
    expect(api.incidents.length).toBeGreaterThan(0)
    expect(app.incidents.length).toBeGreaterThan(0)
    // no component overlap between the two scoped breakdowns
    const apiCompIds = new Set(api.components.map((c) => c.id))
    for (const id of app.components.map((c) => c.id)) expect(apiCompIds.has(id)).toBe(false)
  })

  it('attributes a real API-only incident to the API scope and excludes it from the App scope', () => {
    // "DeepSeek API 性능下降" (change_id 6750347231287) touches ONLY the two API components in the
    // real fixture. Pinning this specific id (not just a length check) catches a bug where
    // `changeAffectsComponent`'s `.includes()` only checked ONE of the two array members.
    const api = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: API_IDS })
    const app = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: APP_IDS })
    expect(api.incidents.find((i) => i.id === 'flashduty:6750347231287')).toBeDefined()
    expect(app.incidents.find((i) => i.id === 'flashduty:6750347231287')).toBeUndefined()
  })

  it('attributes a real App-only incident to the App scope and excludes it from the API scope', () => {
    // "DeepSeek 网页端搜索不可用" (Web Search unavailable, change_id 6741259174287) touches ONLY
    // Instant Mode + Expert Mode — 2 of the 5 App components, none of the API ones.
    const api = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: API_IDS })
    const app = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: APP_IDS })
    expect(app.incidents.find((i) => i.id === 'flashduty:6741259174287')).toBeDefined()
    expect(api.incidents.find((i) => i.id === 'flashduty:6741259174287')).toBeUndefined()
  })

  it('scopes dailyImpact to the array set, same as incidents/uptime', () => {
    const api = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: API_IDS })
    expect(Object.keys(api.dailyImpact).length).toBeGreaterThan(0)
    expect(Object.values(api.dailyImpact).every((v) => ['minor', 'major', 'critical'].includes(v))).toBe(true)
  })

  it('a live incident on one API component flips the API-scoped badge to down, but does NOT leak into the App-scoped badge', () => {
    // Mirrors the single-id file's "a Web-Chat-only active incident does NOT flip the API badge" case,
    // for the array-scoped path — exercises `liveStatusByComp`'s `.includes()` guard specifically,
    // which none of the uptime/incidents-count assertions above touch.
    const withActive: FlashdutyFeed = {
      ...feed,
      active: {
        page: feed.active?.page,
        active_changes: [
          {
            change_id: 999001,
            title: 'V4 Pro API outage',
            status: 'investigating',
            start_at_seconds: 1781000000,
            affected_components: [{ component_id: API_IDS[0], name: 'DeepSeek V4 Pro API', status: 'full_outage' }],
            updates: [{ at_seconds: 1781000000, status: 'investigating', component_changes: [{ component_id: API_IDS[0], status: 'full_outage' }] }],
          },
        ],
      },
    }
    const api = parseFlashdutyFeed(withActive, { primaryComponentId: API_IDS })
    expect(api.status).toBe('down')
    expect(api.components.find((c) => c.id === API_IDS[0])!.status).toBe('down')
    expect(api.components.find((c) => c.id === API_IDS[1])!.status).toBe('operational') // sibling API component unaffected

    const app = parseFlashdutyFeed(withActive, { primaryComponentId: APP_IDS })
    expect(app.status).toBe('operational') // App scope entirely unaffected by an API-only incident
    expect(app.incidents.find((i) => i.id === 'flashduty:999001')).toBeUndefined()
  })

  it('a mixed set (one API id the bare-string API still recognizes + one new sibling) worst-of matches both', () => {
    // Regression guard for the array-normalization itself: passing a 2-element array where only ONE
    // id is present in the roster must still resolve via that one id, not silently fail closed.
    const mixed = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: [API_IDS[0], 'nonexistent-id'] })
    expect(mixed.flashdutyUptime).not.toBeNull()
    expect(mixed.components.map((c) => c.id)).toEqual([API_IDS[0]])
  })

  it('a malformed comma-joined single string is a valid-typed no-op, not a crash — degrades the same as any typo’d single id', () => {
    // `[string, ...string[]]` (types.ts) closes off the EMPTY-array footgun at compile time, but a
    // single comma-joined string ('idA,idB') is still a type-valid `string` — it just matches no real
    // component id, same as any other typo would. Pinning this as a known, accepted degrade (silent
    // no-match, not a throw) rather than leaving it undiscovered.
    const malformed = parseFlashdutyFeed(feed, { nowMs: CAPTURED_AT, primaryComponentId: `${API_IDS[0]},${API_IDS[1]}` })
    expect(malformed.flashdutyUptime).toBeNull()
    expect(malformed.components).toHaveLength(0)
  })
})

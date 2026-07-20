import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildUpstreamFeedStatus, buildUpstreamFeeds, UPSTREAM_FEEDS, __resetLogThrottleForTests, type UpstreamFeedConfig } from '../upstream-feed'
import { SERVICES } from '../services'
import { type StatuspageResponse, normalizeStatus } from '../parsers/statuspage'

// The component ids and statuses below are the REAL githubstatus.com/api/v2/summary.json payload as
// captured on 2026-07-20T00:4x during the evidenced outage — the incident that motivated #1072. The
// two component ids in the fixture are the two the shipped config names, so a drifted config fails
// this file rather than going quiet in production.
//
// The `Copilot` / `Copilot AI Model Providers` components are included at `operational` on purpose:
// they are the ONLY GitHub components AIWatch monitors (as `copilot`), and their being green during a
// GitHub Actions outage is the entire reason a separate feed had to exist. A fixture without them
// would quietly drop the fact the feature is justified by.
const GITHUB_SUMMARY: StatuspageResponse = {
  status: { indicator: 'minor', description: 'Minor Service Outage' },
  components: [
    { id: '8l4ygp009s5s', name: 'Git Operations', status: 'operational' },
    { id: 'brv1bkgrwx7q', name: 'API Requests', status: 'partial_outage' },
    { id: 'kr09ddfgbfsf', name: 'Issues', status: 'degraded_performance' },
    { id: 'hhtssxt0f5v2', name: 'Pull Requests', status: 'operational' },
    { id: 'br0l2tvcx85d', name: 'Actions', status: 'partial_outage' },
    { id: 'vg70hn9s2tyj', name: 'Pages', status: 'degraded_performance' },
    { id: 'pjmpxvq2cmr2', name: 'Copilot', status: 'operational' },
    { id: 'h2ftsgbw7kmk', name: 'Codespaces', status: 'operational' },
    { id: 'cnnb39dkkk82', name: 'Copilot AI Model Providers', status: 'operational' },
  ],
  incidents: [
    {
      id: '8vfyvq16hzh9',
      name: 'Incident with GitHub Actions',
      status: 'investigating',
      impact: 'critical',
      created_at: '2026-07-19T23:34:03.457Z',
      resolved_at: null,
      components: [
        { name: 'API Requests' }, { name: 'Issues' }, { name: 'Actions' }, { name: 'Pages' },
      ],
      incident_updates: [],
    },
    {
      // The page's OTHER live incident, verbatim — and a better specificity case than anything
      // invented: GitHub filed it with `components: []` and every update carrying
      // `affected_components: null`, so `resolveComponentNames` recovers NOTHING for it and the feed
      // must drop it. It matters because it started LATER (00:25) than the Actions incident (23:34)
      // and still before the dependent's 00:34 claim — so if it survived the filter, gate 5's
      // most-recent-before pick would quote THIS vague title instead of the Actions one. Verified
      // against the live worker on 2026-07-20: the emitted link names `8vfyvq16hzh9`.
      id: 'ph5nns5y4gxj',
      name: 'Disruption with some GitHub services',
      status: 'investigating',
      impact: 'major',
      created_at: '2026-07-20T00:25:09.568Z',
      resolved_at: null,
      components: [],
      incident_updates: [
        { status: 'investigating', body: 'We are investigating reports of degraded performance.', created_at: '2026-07-20T00:25:09.568Z', affected_components: null },
      ],
    },
  ],
}

const GITHUB_CFG = UPSTREAM_FEEDS.find((f) => f.id === 'github-platform')!

let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
  // The log throttle is module state. Without this, the FIRST test to trigger a message wins and
  // every later test asserting the same message passes vacuously against an empty spy.
  __resetLogThrottleForTests()
})
afterEach(() => { warn.mockRestore(); error.mockRestore() })

/** Everything warned so far, joined — the spy's `calls` is loosely typed, so narrow it in one place
 *  rather than at each assertion. */
const warnText = () => (warn.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n')

describe('buildUpstreamFeedStatus (#1072)', () => {
  it('builds the GitHub feed from the evidenced payload — degraded, with only its own incident', () => {
    const feed = buildUpstreamFeedStatus(GITHUB_CFG, GITHUB_SUMMARY)!
    expect(feed.id).toBe('github-platform')
    expect(feed.name).toBe('GitHub')
    expect(feed.status).toBe('degraded') // partial_outage → degraded (normalizeStatus)
    expect(feed.incidents.map((i) => i.id)).toEqual(['8vfyvq16hzh9'])
    expect(feed.incidents[0].startedAt).toBe('2026-07-19T23:34:03.457Z')
  })

  it('does NOT inherit the page-level indicator (the whole point of scoping to components)', () => {
    // If the feed read `status.indicator` it would go degraded on ANY GitHub incident — including one
    // confined to components no dependent has ever blamed (Codespaces, Pull Requests). Scoped to its
    // own components, a page-wide `minor` with those two green must read operational.
    const healthyComponents: StatuspageResponse = {
      ...GITHUB_SUMMARY,
      components: GITHUB_SUMMARY.components!.map((c) => ({ ...c, status: 'operational' })),
    }
    expect(buildUpstreamFeedStatus(GITHUB_CFG, healthyComponents)!.status).toBe('operational')
  })

  it('takes the WORST of its components', () => {
    const majorOutage: StatuspageResponse = {
      ...GITHUB_SUMMARY,
      components: GITHUB_SUMMARY.components!.map((c) =>
        c.id === 'br0l2tvcx85d' ? { ...c, status: 'major_outage' } : c),
    }
    expect(buildUpstreamFeedStatus(GITHUB_CFG, majorOutage)!.status).toBe('down')
  })

  it('returns null and logs an ERROR when no configured component id resolves (the silent-no-op trap)', () => {
    // A status page re-ids its components and this feed becomes a permanent no-op. Because the
    // feature's healthy state is ALSO silence, nothing else would ever surface it — so the null must
    // come with a loud log, and this pins that it does.
    const reIded: StatuspageResponse = {
      ...GITHUB_SUMMARY,
      components: [{ id: 'brand-new-id', name: 'Actions', status: 'partial_outage' }],
    }
    expect(buildUpstreamFeedStatus(GITHUB_CFG, reIded)).toBeNull()
    expect(error).toHaveBeenCalled()
    expect(String(error.mock.calls[0][0])).toContain('github-platform')
  })

  it('builds from the surviving components on a PARTIAL id miss, and warns', () => {
    const oneMissing: StatuspageResponse = {
      ...GITHUB_SUMMARY,
      components: GITHUB_SUMMARY.components!.filter((c) => c.id !== 'brv1bkgrwx7q'),
    }
    const feed = buildUpstreamFeedStatus(GITHUB_CFG, oneMissing)!
    expect(feed.status).toBe('degraded') // Actions alone still answers
    expect(warn).toHaveBeenCalled()
    // The incident stays attributable: it names Actions, which did resolve.
    expect(feed.incidents.map((i) => i.id)).toEqual(['8vfyvq16hzh9'])
  })

  it('returns null when the summary carried no components at all', () => {
    expect(buildUpstreamFeedStatus(GITHUB_CFG, { status: { indicator: 'none', description: '' } })).toBeNull()
    expect(buildUpstreamFeedStatus(GITHUB_CFG, undefined)).toBeNull()
  })

  it('drops a component-less incident even though it is MORE RECENT than the one it keeps', () => {
    // See the fixture note on ph5nns5y4gxj: this is the ordering trap. Both incidents are live and
    // both predate the dependent's claim, so a feed that failed to filter would hand gate 5 a newer,
    // vaguer incident ("Disruption with some GitHub services") and the is-down note would quote that
    // instead of the Actions outage the dependent actually meant.
    const feed = buildUpstreamFeedStatus(GITHUB_CFG, GITHUB_SUMMARY)!
    expect(feed.incidents.map((i) => i.id)).toEqual(['8vfyvq16hzh9'])
    expect(feed.incidents.some((i) => i.id === 'ph5nns5y4gxj')).toBe(false)
  })
})

describe('buildUpstreamFeeds (#1072)', () => {
  it('builds every declared feed whose page was prefetched', () => {
    const map = new Map([[GITHUB_CFG.apiUrl, { summary: GITHUB_SUMMARY }]])
    const feeds = buildUpstreamFeeds(map)
    expect(feeds.map((f) => f.id)).toContain('github-platform')
  })

  it('skips (and warns about) a feed whose page failed to prefetch — fail closed, never a partial claim', () => {
    expect(buildUpstreamFeeds(new Map())).toEqual([])
    expect(warn).toHaveBeenCalled()
  })
})

describe('UPSTREAM_FEEDS config integrity', () => {
  it('every feed reuses a page some SERVICE already fetches (a feed must cost zero extra subrequests)', () => {
    // The zero-cost claim in the module header is load-bearing: the feeds are built from
    // fetchAllServices' EXISTING prefetch map, which is keyed by service apiUrl. A feed pointing at an
    // unfetched page is not "slightly more expensive" — it is silently never built at all, because
    // nothing would ever put that key in the map.
    const fetched = new Set(SERVICES.map((s) => s.apiUrl).filter(Boolean))
    for (const f of UPSTREAM_FEEDS) {
      expect(fetched.has(f.apiUrl), `feed "${f.id}" page ${f.apiUrl} is not fetched by any service`).toBe(true)
    }
  })

  it('declares at least one component id per feed', () => {
    for (const f of UPSTREAM_FEEDS) {
      expect(f.componentIds.length, `feed "${f.id}"`).toBeGreaterThan(0)
    }
  })

  it('does not claim a component that a SERVICE already badges (the #1008 attribution split)', () => {
    // The design rule this whole module exists to honour: a feed's components and a service's badge
    // components must be disjoint. Overlap would mean one component both reddening a service badge and
    // driving an upstream claim — reintroducing the cross-product misattribution from the other side.
    const badged = new Set(SERVICES.flatMap((s) => s.statusComponentIds ?? (s.statusComponentId ? [s.statusComponentId] : [])))
    for (const f of UPSTREAM_FEEDS) {
      for (const id of f.componentIds) {
        expect(badged.has(id), `feed "${f.id}" claims component ${id}, which a service already badges`).toBe(false)
      }
    }
  })
})

// A type-level pin, not a runtime one: UpstreamFeedConfig must stay assignable from a literal, so a
// future required field can't be added without every declared feed being updated.
const _cfgShape: UpstreamFeedConfig = { id: 'x', name: 'X', apiUrl: 'https://x/api/v2/summary.json', statusUrl: 'https://x', componentIds: ['a'] }
void _cfgShape

describe('feed statusUrl (#1072)', () => {
  it('carries the official status page onto the candidate', () => {
    expect(buildUpstreamFeedStatus(GITHUB_CFG, GITHUB_SUMMARY)!.statusUrl).toBe('https://www.githubstatus.com')
  })

  it('every feed declares an http(s) statusUrl (a feed with no is-down page and no link is a dead end)', () => {
    for (const f of UPSTREAM_FEEDS) {
      expect(f.statusUrl, `feed "${f.id}"`).toMatch(/^https?:\/\//)
    }
  })
})

// The payload-shape drift warns (#1072). Config drift was already guarded; these cover the
// drift that happens DURING an outage, where the feature's failure looks identical to its healthy
// silence and no card exists to contradict it.
describe('payload-shape drift warnings (#1072)', () => {
  it('warns when components report impacted but NO incident attributes to them', () => {
    // The state gate 5 cannot act on: the feed says impacted and can name no cause, so the upstream
    // link stays silent through a live outage. GitHub really does publish component-less incidents
    // (ph5nns5y4gxj above), so this is reachable, not defensive padding.
    const noAttribution: StatuspageResponse = {
      ...GITHUB_SUMMARY,
      incidents: [GITHUB_SUMMARY.incidents!.find((i) => i.id === 'ph5nns5y4gxj')!],
    }
    const feed = buildUpstreamFeedStatus(GITHUB_CFG, noAttribution)!
    expect(feed.status).toBe('degraded')
    expect(feed.incidents).toEqual([])
    expect(warnText()).toContain('NO incident attributes')
  })

  it('does NOT warn when the feed is impacted AND can name an incident', () => {
    buildUpstreamFeedStatus(GITHUB_CFG, GITHUB_SUMMARY)
    expect(warnText()).not.toContain('NO incident attributes')
  })

  it('does NOT warn when the feed is healthy with no incidents (the normal quiet state)', () => {
    const healthy: StatuspageResponse = {
      ...GITHUB_SUMMARY,
      components: GITHUB_SUMMARY.components!.map((c) => ({ ...c, status: 'operational' })),
      incidents: [],
    }
    buildUpstreamFeedStatus(GITHUB_CFG, healthy)
    expect(warnText()).not.toContain('NO incident attributes')
  })

  it('warns on a component status normalizeStatus does not recognize', () => {
    // `under_maintenance` is a real Statuspage component status that falls through normalizeStatus's
    // default arm to `operational`. On a service that surfaces as a wrongly-green card someone
    // reports; on a feed there is no card, so nothing would ever contradict it.
    const unknown: StatuspageResponse = {
      ...GITHUB_SUMMARY,
      components: GITHUB_SUMMARY.components!.map((c) =>
        c.id === 'br0l2tvcx85d' ? { ...c, status: 'under_maintenance' } : c),
    }
    buildUpstreamFeedStatus(GITHUB_CFG, unknown)
    expect(warnText()).toContain('unrecognized status "under_maintenance"')
  })

  it('does NOT warn for any status the parser knows', () => {
    buildUpstreamFeedStatus(GITHUB_CFG, GITHUB_SUMMARY)
    expect(warnText()).not.toContain('unrecognized status')
  })
})

describe('log throttling (#1072)', () => {
  // buildUpstreamFeeds runs inside fetchAllServices, which /api/status calls per REQUEST (only the KV
  // write is throttled). Every condition these logs report persists for hours-to-days, so un-throttled
  // they would emit thousands of identical lines an hour and bury the signal they exist to provide.
  const drifted: StatuspageResponse = {
    ...GITHUB_SUMMARY,
    components: [{ id: 'brand-new-id', name: 'Actions', status: 'partial_outage' }],
  }

  it('logs a persistent condition ONCE across repeated calls in the window', () => {
    const t = 1_700_000_000_000
    for (let i = 0; i < 50; i++) buildUpstreamFeedStatus(GITHUB_CFG, drifted, t + i * 1000)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('logs again once the window has elapsed — the ceiling is on repetition, not on being told', () => {
    const t = 1_700_000_000_000
    buildUpstreamFeedStatus(GITHUB_CFG, drifted, t)
    buildUpstreamFeedStatus(GITHUB_CFG, drifted, t + 10 * 60 * 1000 + 1)
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('a DIFFERENT condition reports immediately instead of hiding behind the first', () => {
    // Keyed by full message, so a second drifting component is not masked by the first one's window.
    const t = 1_700_000_000_000
    const unknownStatus: StatuspageResponse = {
      ...GITHUB_SUMMARY,
      components: GITHUB_SUMMARY.components!.map((c) =>
        c.id === 'br0l2tvcx85d' ? { ...c, status: 'under_maintenance' } : c),
    }
    buildUpstreamFeedStatus(GITHUB_CFG, unknownStatus, t)
    const noAttribution: StatuspageResponse = {
      ...GITHUB_SUMMARY,
      incidents: [GITHUB_SUMMARY.incidents!.find((i) => i.id === 'ph5nns5y4gxj')!],
    }
    buildUpstreamFeedStatus(GITHUB_CFG, noAttribution, t + 1000)
    const msg = warnText()
    expect(msg).toContain('unrecognized status')
    expect(msg).toContain('NO incident attributes')
  })
})

describe('normalizeStatus drift guard (#1072)', () => {
  it('every non-operational input this feed knows still maps away from operational', () => {
    // The DANGEROUS drift direction. If a case is removed or renamed in parsers/statuspage.ts without
    // updating KNOWN_NORMALIZE_STATUS_INPUTS, that status silently falls to the default `operational`
    // arm AND the unrecognized-status warn stays quiet — the guard disables itself in exactly the
    // scenario it exists for. Prose cannot enforce that; this can.
    for (const s of ['minor', 'degraded_performance', 'partial_outage', 'major', 'critical', 'major_outage']) {
      expect(normalizeStatus(s), s).not.toBe('operational')
    }
    // `none`/`operational` are behaviourally indistinguishable from the default arm, so they are not
    // assertable here — stated so the omission reads as a known limit, not an oversight.
  })
})

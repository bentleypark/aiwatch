import { describe, it, expect, vi } from 'vitest'
import { buildUpstreamLinks, namesUpstream, normalizeForMatch, UPSTREAM_DEPS } from '../upstream-link'
import { UPSTREAM_FEEDS, type UpstreamCandidate } from '../upstream-feed'
import { causalIncidents } from '../incident-text'
import { SERVICES } from '../services'
import type { ServiceStatus, Incident } from '../types'

// The two EVIDENCED outages below are read off the wire: ids, titles and timestamps as the providers
// emitted them (HF/Replicate recovered from GET /api/report?month=2026-07; cursor/claude captured from
// /api/status/cached during the live outage). Their titles and timestamps match UPSTREAM_DEPS'
// evidence block, which records those and nothing else — THIS file is the only home of the ids, on
// purpose: an earlier revision restated them in that block as abbreviated `#f2c4fda9…c3310` strings
// and the hand-typed elision spliced one incident's head onto another's tail. One fact, one place.
//
// Nothing here is rounded or back-computed: a fixture that drifts from the shape real data takes is a
// test that passes for the wrong reason, and a tidy `hf1`/`rp1` under a "real data" label is how that
// starts. The id SHAPES differ by parser — BetterStack `#<sha256>`, incident.io ULID, Statuspage short
// token — which the placeholders had flattened into one tidy family.
//
// Everything else here — REPLICATE_H100, and the fixtures inside individual tests (stale incidents,
// window boundaries, the multi-dependent case) — is a deliberately CONSTRUCTED scenario and says so
// where it appears. None of them claim to be observed.
const inc = (
  id: string,
  title: string,
  startedAt: string,
  opts: { timelineText?: string; componentNames?: string[]; status?: Incident['status']; impact?: Incident['impact'] } = {},
): Incident =>
  ({
    id,
    title,
    status: opts.status ?? 'investigating',
    impact: opts.impact === undefined ? 'minor' : opts.impact,
    startedAt,
    duration: null,
    ...(opts.componentNames ? { componentNames: opts.componentNames } : {}),
    timeline: opts.timelineText ? [{ stage: 'investigating', text: opts.timelineText, at: startedAt }] : [],
  }) as Incident

const NAMES: Record<string, string> = {
  claude: 'Claude API',
  claudeai: 'claude.ai',
  claudecode: 'Claude Code',
  cursor: 'Cursor',
  replicate: 'Replicate',
  huggingface: 'Hugging Face',
}
const svc = (id: string, status: ServiceStatus['status'], incidents: Incident[] = []): ServiceStatus =>
  ({ id, name: NAMES[id] ?? id, status, incidents }) as ServiceStatus

// `buildUpstreamLinks` takes `now` as a REQUIRED param (it gates claim freshness), so every test
// states its clock. Two clocks because the two evidenced outages are on different days — a single NOW
// would push the 07-16 claims past the 24h freshness gate and every HF test would fail for a reason
// that has nothing to do with what it asserts.
const NOW_HF = Date.parse('2026-07-16T09:00:00Z')      // ~28m after the replicate claim
const NOW_CURSOR = Date.parse('2026-07-17T09:00:00Z')  // ~1h43m after the cursor claim
const build = (services: ServiceStatus[], now: number = NOW_HF, feeds: UpstreamCandidate[] = []) =>
  buildUpstreamLinks(services, feeds, now)

// --- the two evidenced outages, verbatim -------------------------------------------------------
// 2026-07-16: huggingface down 07:55:33Z → replicate 'HuggingFace download issues' 08:31:53Z (+36m)
const HF_HUB_DOWN = inc('#f2c4fda9badba95128e25e85914727efd6d44476a8434b4e8f57fdc0ccf5912c', 'Huggingface Hub — down', '2026-07-16T07:55:33.000Z')
const HF_JOBS_DOWN = inc('#faf2ef3b9e8295a81f3dbec198498685ec22ba2df6f5bdad655690c1cb7c3310', 'Jobs — down', '2026-07-16T07:57:01.000Z')
const REPLICATE_HF = inc('01KXN0VFGEEGTX7S8GE91WERCM', 'HuggingFace download issues', '2026-07-16T08:31:53Z')

// --- CONSTRUCTED, not observed ------------------------------------------------------------------
// Replicate's own self-inflicted incident: a REAL title (it opened `High contention on H100 hardware`
// on 2026-07-10), but a synthetic id and a synthetic FRESH timestamp — and the freshness is the point.
// Its real 2026-07-10 stamp is 6d before NOW_HF, so gate 3's now-anchor would reject it and the
// specificity test below would pass on the FRESHNESS path without ever reaching the naming check it
// exists to test. "Use the real data" is the wrong instinct here: the fixture has to be fresh so that
// NAMING is the only thing left to fail on.
const REPLICATE_H100 = inc('rp-h100', 'High contention on H100 hardware', '2026-07-16T08:31:53Z')

// 2026-07-17: claude 06:47:54.909Z → cursor 'Investigating Anthropic degradation' 07:17:15.075Z (+29m)
const CLAUDE_ERRORS = inc('7gpjd8n56rlq', 'Elevated errors on Sonnet 5 and Haiku 4.5', '2026-07-17T06:47:54.909Z')
const CURSOR_ANTHROPIC = inc('htxx9vp5s24f', 'Investigating Anthropic degradation', '2026-07-17T07:17:15.075Z')

describe('buildUpstreamLinks (#1053) — the two evidenced cross-provider outages', () => {
  it('links replicate → hugging face (dependent names the upstream, upstream started 36m earlier)', () => {
    const links = build([
      svc('huggingface', 'down', [HF_HUB_DOWN, HF_JOBS_DOWN]),
      svc('replicate', 'degraded', [REPLICATE_HF]),
    ])
    expect(links).toHaveLength(1)
    expect(links[0].id).toBe('replicate')
    expect(links[0].incidentTitle).toBe('HuggingFace download issues')
    // the claim's own startedAt is serialized so the client can show the LEAD TIME (the +36m that
    // makes the link legible). Without it the is-down section silently loses that clause.
    expect(links[0].startedAt).toBe('2026-07-16T08:31:53Z')
    // toEqual, NOT toMatchObject: a subset match let `startedAt` silently drop off this entry, and it
    // is the field the whole lead-time clause is derived from (the Edge fixture hand-supplies it, so
    // the two hand-maintained copies of this wire shape never confront each other).
    expect(links[0].upstream).toEqual([{
      id: 'huggingface',
      name: 'Hugging Face',
      status: 'down',
      incidentId: '#faf2ef3b9e8295a81f3dbec198498685ec22ba2df6f5bdad655690c1cb7c3310', // MOST RECENT qualifying (07:57:01 > 07:55:33)
      incidentTitle: 'Jobs — down',
      startedAt: '2026-07-16T07:57:01.000Z',
    }])
  })

  it('quotes the most recent upstream incident, NOT a stale long-running one', () => {
    // The bug the first implementation shipped: only `impact: null` is filtered, so a weeks-old
    // `minor` advisory stays "active" — and an ascending sort made THAT the quoted chain-starter.
    // The card would read `Hugging Face — Down · "Minor: docs search slow" · Started 7d ago`.
    const stale = inc('old', 'Minor: docs search slow', '2026-07-09T00:00:00Z')
    const links = build([
      svc('huggingface', 'down', [stale, HF_HUB_DOWN]),
      svc('replicate', 'degraded', [REPLICATE_HF]),
    ])
    expect(links[0].upstream[0].incidentId).toBe(HF_HUB_DOWN.id)
    expect(links[0].upstream[0].incidentTitle).not.toContain('docs search slow')
  })

  it('takes the MOST RECENT naming incident as the claim, symmetric with the upstream pick', () => {
    const first = inc('rp-a', 'HuggingFace download issues', '2026-07-16T08:31:53Z')
    const later = inc('rp-b', 'HuggingFace mirror still failing', '2026-07-16T10:00:00Z')
    const links = build([
      svc('huggingface', 'down', [HF_HUB_DOWN]),
      svc('replicate', 'degraded', [first, later]), // deliberately out of order
    ])
    expect(links[0].incidentId).toBe('rp-b')
    expect(links[0].startedAt).toBe('2026-07-16T10:00:00Z')
  })

  it('a STALE dependent claim does not drag gate 5\'s window backwards', () => {
    // claim.at is gate 5's upper bound, so an earliest-claim pick failed BOTH ways here: it would
    // quote an 8d-old upstream minor (false card) AND reject the real same-day incident (false
    // negative). The fresh claim must win so the fresh upstream incident is the one admitted.
    const staleClaim = inc('rp-old', 'HuggingFace mirror lag', '2026-07-09T00:00:00Z') // 7d old, open
    const freshClaim = inc('rp-new', 'HuggingFace download issues', '2026-07-16T08:31:53Z')
    const links = build([
      svc('huggingface', 'down', [HF_HUB_DOWN]), // 2026-07-16T07:55:33 — AFTER the stale claim
      svc('replicate', 'degraded', [staleClaim, freshClaim]),
    ])
    expect(links).toHaveLength(1)
    expect(links[0].incidentId).toBe('rp-new')
    expect(links[0].upstream[0].incidentId).toBe(HF_HUB_DOWN.id) // today's real incident, not nothing
  })

  it('gate 3 FRESHNESS: a STALE-ONLY claim is rejected, however close its upstream sits', () => {
    // The card the module exists to prevent, and the case a RELATIVE window cannot reach: two
    // mutually-close stale incidents sit inside `CAUSE_WINDOW_MS` of EACH OTHER. Without the
    // now-anchor this renders `Hugging Face — Down · "Minor: docs search slow" · Started 7d ago`
    // while HF is genuinely down today for an unrelated reason — AND today's real HF incident is
    // excluded, because it started after the stale claim. Verified reproducible before the fix.
    const staleClaim = inc('rp-old', 'HuggingFace mirror lag', '2026-07-09T00:00:00Z')
    const staleUpstream = inc('hf-old', 'Minor: docs search slow', '2026-07-08T23:00:00Z') // 1h before
    const links = build([
      svc('huggingface', 'down', [staleUpstream, HF_HUB_DOWN]),
      svc('replicate', 'degraded', [staleClaim]), // the ONLY naming incident, and it is 7d old
    ])
    expect(links).toEqual([])
  })

  it('gate 3 FRESHNESS: the claim is measured against NOW, not against the upstream', () => {
    // Mutation guard in the other direction: a fresh claim must still link. Pins that the now-anchor
    // is a bound, not an always-reject.
    const links = build([
      svc('huggingface', 'down', [HF_HUB_DOWN]),
      svc('replicate', 'degraded', [REPLICATE_HF]),
    ], Date.parse('2026-07-17T08:30:00Z')) // 23h58m after the claim — just inside
    expect(links).toHaveLength(1)
    expect(build([
      svc('huggingface', 'down', [HF_HUB_DOWN]),
      svc('replicate', 'degraded', [REPLICATE_HF]),
    ], Date.parse('2026-07-17T08:32:00Z'))).toEqual([]) // 24h00m07s after — just outside
  })

  it('links EVERY qualifying dependent, not just the first (a `break` would pass every other test)', () => {
    // Both UPSTREAM_DEPS entries firing at once — a wide outage. Every other fixture yields <=1 link,
    // so `break`/`return [links[0]]` after the push survives the whole suite.
    const now = Date.parse('2026-07-16T09:00:00Z')
    const links = build([
      svc('huggingface', 'down', [HF_HUB_DOWN]),
      svc('replicate', 'degraded', [REPLICATE_HF]),
      svc('claude', 'degraded', [inc('an9', 'Elevated errors on Sonnet 5', '2026-07-16T08:00:00Z')]),
      svc('cursor', 'degraded', [inc('cu9', 'Investigating Anthropic degradation', '2026-07-16T08:20:00Z')]),
    ], now)
    expect(links.map((l) => l.id).sort()).toEqual(['cursor', 'replicate'])
  })

  it('an unparseable UPSTREAM startedAt drops that candidate (gate 5\'s c.at != null filter)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(build([
        svc('huggingface', 'down', [inc('hf-bad', 'Huggingface Hub — down', 'not-a-date')]),
        svc('replicate', 'degraded', [REPLICATE_HF]),
      ])).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('gate 5 WINDOW: an upstream incident older than 24h before the claim is not a plausible trigger', () => {
    const ancient = inc('hf-old', 'Minor: docs search slow', '2026-07-14T00:00:00Z') // >24h before
    const links = build([
      svc('huggingface', 'down', [ancient]),
      svc('replicate', 'degraded', [REPLICATE_HF]), // 2026-07-16T08:31:53Z
    ])
    expect(links).toEqual([]) // no card at all — better than "Started 2d ago" beside a fresh outage
  })

  it('gate 5 WINDOW boundary: EXACTLY 24h before the claim is admitted (the <= is load-bearing)', () => {
    // The claim is 2026-07-16T08:31:53Z. Loose fixtures (23h31m in / 56h31m out) left every constant
    // in [23h32m, 56h31m] passing — 24h could silently become 48h — and `<=` -> `<` survived too.
    const exactly24h = inc('hf-edge', 'Huggingface Hub — down', '2026-07-15T08:31:53Z')
    expect(build([
      svc('huggingface', 'down', [exactly24h]),
      svc('replicate', 'degraded', [REPLICATE_HF]),
    ])[0].upstream[0].incidentId).toBe('hf-edge')
  })

  it('gate 5 WINDOW boundary: 1ms beyond 24h is rejected (pins the constant to a point)', () => {
    const justOver = inc('hf-over', 'Huggingface Hub — down', '2026-07-15T08:31:52.999Z')
    expect(build([
      svc('huggingface', 'down', [justOver]),
      svc('replicate', 'degraded', [REPLICATE_HF]),
    ])).toEqual([])
  })

  it('gate 5 compares with <=, so a SIMULTANEOUS upstream incident links (0 lead is legal)', () => {
    // Both halves document this — the Edge renders a 0 lead as "less than a minute" — but every other
    // fixture is strictly ordered, so `<=` → `<` would survive the whole suite unnoticed, quietly
    // narrowing the gate. (It would NOT kill the Edge's `mins < 1` branch: a sub-30s lead rounds to 0
    // too. The point here is the boundary itself, not that branch.)
    const sameInstant = inc('hf-eq', 'Huggingface Hub — down', '2026-07-16T08:31:53Z')
    const links = build([
      svc('huggingface', 'down', [sameInstant]),
      svc('replicate', 'degraded', [REPLICATE_HF]), // identical startedAt
    ])
    expect(links[0].upstream[0].incidentId).toBe('hf-eq')
  })

  it('links cursor → claude (the API only, not the claude.ai / Claude Code sibling surfaces)', () => {
    const links = build([
      svc('claude', 'degraded', [CLAUDE_ERRORS]),
      svc('claudeai', 'degraded', [CLAUDE_ERRORS]),
      svc('claudecode', 'degraded', [CLAUDE_ERRORS]),
      svc('cursor', 'degraded', [CURSOR_ANTHROPIC]),
    ], NOW_CURSOR)
    expect(links).toHaveLength(1)
    expect(links[0].id).toBe('cursor')
    // claudeai/claudecode are the SAME Anthropic incident on sibling surfaces — pointing a Cursor
    // user at claude.ai is noise, not the cause.
    expect(links[0].upstream.map((u) => u.id)).toEqual(['claude'])
    expect(links[0].upstream[0].incidentTitle).toBe('Elevated errors on Sonnet 5 and Haiku 4.5')
  })
})

describe('buildUpstreamLinks — the gates', () => {
  it('gate 2: dependent operational → no link even though the upstream is down (no static banner)', () => {
    // The dependent CARRIES the naming incident and is still `operational` — status resolution is
    // component-scoped, so an open incident does not imply a degraded badge. Without a live incident
    // here the assertion would pass on the empty-incident path and never exercise gate 2 at all.
    const links = build([
      svc('huggingface', 'down', [HF_HUB_DOWN]),
      svc('replicate', 'operational', [REPLICATE_HF]),
    ])
    expect(links).toEqual([])
  })

  it('gate 3 (SPECIFICITY): replicate degraded by its OWN H100 incident while HF is down → no link', () => {
    // The real 2026-07 pair. A static "replicate depends on huggingface" map would wrongly decorate
    // this; naming is what separates it from the real case.
    const links = build([
      svc('huggingface', 'down', [HF_HUB_DOWN]),
      svc('replicate', 'degraded', [REPLICATE_H100]),
    ])
    expect(links).toEqual([])
  })

  it('gate 4: dependent names the upstream but the upstream is healthy → no link', () => {
    // The upstream has an OPEN incident yet resolves `operational` (component-scoped). Gate 4 is what
    // withholds the link; an empty-incident upstream would fail on the no-cause path instead and
    // leave gate 4 untested.
    const links = build([
      svc('huggingface', 'operational', [HF_HUB_DOWN]),
      svc('replicate', 'degraded', [REPLICATE_HF]),
    ])
    expect(links).toEqual([])
  })

  it('gate 5: upstream incident started AFTER the dependent claim → no link (causality runs one way)', () => {
    const lateUpstream = inc('hf9', 'Huggingface Hub — down', '2026-07-16T09:00:00Z') // after 08:31:53
    const links = build([
      svc('huggingface', 'down', [lateUpstream]),
      svc('replicate', 'degraded', [REPLICATE_HF]),
    ])
    expect(links).toEqual([])
  })

  it('gate 1: an undeclared pair is never linked, however suggestive the text', () => {
    // cohere is not in UPSTREAM_DEPS; the text names an upstream that is genuinely down.
    const links = build([
      svc('huggingface', 'down', [HF_HUB_DOWN]),
      svc('cohere', 'degraded', [inc('c1', 'HuggingFace download issues', '2026-07-16T08:31:53Z')]),
    ])
    expect(links).toEqual([])
  })

  it('an unparseable dependent startedAt fails closed AND warns (a parser defect must not be silent)', () => {
    // `startedAt` is required in types.ts, so this is a parser defect, and the resulting drop is
    // byte-identical to a healthy gate. The warn is the only thing that makes it greppable — so it is
    // part of the behaviour, not decoration.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const links = build([
        svc('huggingface', 'down', [HF_HUB_DOWN]),
        svc('replicate', 'degraded', [inc('rp9', 'HuggingFace download issues', 'not-a-date')]),
      ])
      expect(links).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unparseable startedAt'), 'not-a-date')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('buildUpstreamLinks — what counts as the dependent naming its upstream', () => {
  it('catches a mention that appears ONLY in the timeline, not the title', () => {
    // The shape supply-chain.ts hit for real (#574 doc): the title carries a human phrase, the
    // upstream is named only in an update body.
    const timelineOnly = inc('rp2', 'Elevated error rate on model downloads', '2026-07-16T08:31:53Z', {
      timelineText: 'Downloads are failing because of an ongoing Hugging Face incident.',
    })
    const links = build([
      svc('huggingface', 'down', [HF_HUB_DOWN]),
      svc('replicate', 'degraded', [timelineOnly]),
    ])
    expect(links).toHaveLength(1)
    expect(links[0].upstream[0].id).toBe('huggingface')
  })

  it('catches a mention that appears only in componentNames', () => {
    const viaComponent = inc('rp3', 'Downloads degraded', '2026-07-16T08:31:53Z', { componentNames: ['HuggingFace mirror'] })
    const links = build([
      svc('huggingface', 'down', [HF_HUB_DOWN]),
      svc('replicate', 'degraded', [viaComponent]),
    ])
    expect(links).toHaveLength(1)
  })

  it('a RESOLVED dependent incident cannot carry the claim', () => {
    const resolved = inc('rp4', 'HuggingFace download issues', '2026-07-16T08:31:53Z', { status: 'resolved' })
    expect(build([svc('huggingface', 'down', [HF_HUB_DOWN]), svc('replicate', 'degraded', [resolved])])).toEqual([])
  })

  it('an impact:null dependent incident cannot carry the claim (provider says no availability impact)', () => {
    const advisory = inc('rp5', 'HuggingFace download issues', '2026-07-16T08:31:53Z', { impact: null })
    expect(build([svc('huggingface', 'down', [HF_HUB_DOWN]), svc('replicate', 'degraded', [advisory])])).toEqual([])
  })

  it('an impact:null UPSTREAM incident cannot be the cause', () => {
    const advisory = inc('hf8', 'Huggingface Hub — down', '2026-07-16T07:55:33.000Z', { impact: null })
    expect(build([svc('huggingface', 'down', [advisory]), svc('replicate', 'degraded', [REPLICATE_HF])])).toEqual([])
  })
})

describe('normalizeForMatch / namesUpstream — spelling variants of one brand', () => {
  it.each([
    ['HuggingFace download issues', true], // Replicate's real spelling (no space)
    ['Hugging Face is down', true], // our own config's spelling (with space)
    ['hugging-face mirror lag', true],
    ['Elevated errors on our own GPUs', false],
  ])('%s → %s', (text, expected) => {
    expect(namesUpstream(text, ['huggingface'])).toBe(expected)
  })

  it('normalizes case, spacing and punctuation to one form', () => {
    expect(normalizeForMatch('Hugging Face')).toBe(normalizeForMatch('HuggingFace'))
    expect(normalizeForMatch('claude.ai')).toBe('claudeai')
  })

  it('aliases in the map are matched regardless of how they are written there', () => {
    expect(namesUpstream('an Anthropic degradation', ['Anthropic'])).toBe(true)
  })
})

describe('UPSTREAM_DEPS — the curation discipline', () => {
  // THE pin. The dep map is the one piece of pure config the whole feature rests on, and a wrong id
  // is byte-identical to success: `byId.get('curser')` returns undefined, `isImpacted(undefined)` is
  // false, and the `continue` reads exactly like a healthy gate 2/gate 4. Every test stays green, the
  // card never renders again, and the only way to notice is to catch a live cross-provider outage and
  // spot an absent card — something that happens a handful of times a year. Not hypothetical here:
  // service ids have been renamed before (junie-migration.test.ts, the #940 id-scheme change).
  // Same idiom as feed-slug-sync / service-site-url-sync / stale-source-config.
  it('every declared id + upstreamId exists in SERVICES (or, for an upstream, in UPSTREAM_FEEDS) — a rename is a silent no-op forever', () => {
    const ids = new Set(SERVICES.map((s) => s.id))
    const feedIds = new Set(UPSTREAM_FEEDS.map((f) => f.id))
    for (const dep of UPSTREAM_DEPS) {
      // A DEPENDENT must still be a real service: the link annotates its card / is-down page, and a
      // feed has neither. #1072 widened only the upstream side.
      expect(ids, `dependent "${dep.id}"`).toContain(dep.id)
      for (const up of dep.upstreamIds) {
        expect(
          ids.has(up) || feedIds.has(up),
          `${dep.id} → upstream "${up}" is in neither SERVICES nor UPSTREAM_FEEDS`,
        ).toBe(true)
      }
    }
  })

  it('no UPSTREAM_FEEDS id collides with a real service id (the collision resolves to the service, silently)', () => {
    // buildUpstreamLinks lets services win an id collision on purpose (a real service is the better
    // answer), which makes a colliding feed id a SILENT no-op — the feed is built and cached
    // while never being consulted. (It is not "shipped": upstreamFeeds rides only in the KV snapshot,
    // never in a response body.) Catch it here rather than as a dead upstream link.
    const ids = new Set(SERVICES.map((s) => s.id))
    for (const f of UPSTREAM_FEEDS) {
      expect(ids.has(f.id), `feed "${f.id}" shadows a service id`).toBe(false)
    }
  })

  it('no alias normalizes to empty (an empty alias makes gate 3 match EVERY incident)', () => {
    // The one failure that breaks the feature's ethic in the OVER-claiming direction: `n.includes('')`
    // is true for all text, so gate 3 collapses to always-pass and every incident of the dependent
    // gets attributed upstream. A literal '' is normalization-stable, so the check below cannot see it.
    for (const dep of UPSTREAM_DEPS) {
      for (const a of dep.aliases) {
        expect(normalizeForMatch(a).length, `${dep.id}: alias "${a}"`).toBeGreaterThan(0)
      }
    }
  })

  it('at least one alias per dep matches the upstream\'s own name or provider (catches a typo)', () => {
    // A typo that is already lowercase and separator-free ('anthropc') passes the stability check
    // below, then matches nothing forever — indistinguishable from gate 3 staying quiet. Anchoring to
    // the upstream's real name/provider catches it. Asserted over AT LEAST ONE alias, not every one:
    // a legitimate future alias may be a token matching neither ("HF", "the Hub"), and this must not
    // block correct curation.
    for (const dep of UPSTREAM_DEPS) {
      const anchors = dep.upstreamIds.flatMap((id) => {
        const cfg = SERVICES.find((s) => s.id === id)
        if (cfg) return [normalizeForMatch(cfg.name), normalizeForMatch(cfg.provider)]
        // #1072 — a feed upstream has a display name but no `provider` (it is consulted, not monitored).
        const feed = UPSTREAM_FEEDS.find((f) => f.id === id)!
        return [normalizeForMatch(feed.name)]
      })
      const hit = dep.aliases.some((a) => anchors.includes(normalizeForMatch(a)))
      expect(hit, `${dep.id}: no alias of [${dep.aliases}] matches any of [${anchors}]`).toBe(true)
    }
  })

  it('every declared alias is normalization-stable (a style/consistency rule, not a safety one)', () => {
    // NOT a safety check: `namesUpstream` normalizes the alias AT MATCH TIME, so an un-normalized
    // alias like 'Hugging Face' matches perfectly well — the test three blocks up proves exactly that.
    // The earlier claim that such an alias "can never match" was false. This keeps the map in one form.
    for (const dep of UPSTREAM_DEPS) {
      for (const a of dep.aliases) {
        expect(normalizeForMatch(a), `${dep.id}: alias "${a}"`).toBe(a)
      }
    }
  })

  it('does NOT alias "claude" for cursor — a model the dependent resells is not a blame token', () => {
    const cursor = UPSTREAM_DEPS.find((d) => d.id === 'cursor')!
    expect(cursor.aliases).not.toContain('claude')
    // ...so Cursor's own model-routing incident stays unattributed even while Anthropic is degraded.
    const links = build([
      svc('claude', 'degraded', [CLAUDE_ERRORS]),
      svc('cursor', 'degraded', [inc('cu9', 'Claude 3.5 Sonnet unavailable in Cursor', '2026-07-17T07:17:15.075Z')]),
    ], NOW_CURSOR)
    expect(links).toEqual([])
  })
})

describe('causalIncidents (#1053 — the primitive shared with supply-chain.ts)', () => {
  it('harvests title + componentNames + timeline into one searchable string', () => {
    const i = inc('x', 'Title here', '2026-07-16T00:00:00Z', { timelineText: 'body text', componentNames: ['Comp A'] })
    const [got] = causalIncidents(svc('replicate', 'degraded', [i]))
    expect(got.text).toContain('Title here')
    expect(got.text).toContain('Comp A')
    expect(got.text).toContain('body text')
  })

  it('drops resolved and impact:null incidents', () => {
    const s = svc('replicate', 'degraded', [
      inc('a', 'live', '2026-07-16T00:00:00Z'),
      inc('b', 'closed', '2026-07-16T00:00:00Z', { status: 'resolved' }),
      inc('c', 'advisory', '2026-07-16T00:00:00Z', { impact: null }),
    ])
    expect(causalIncidents(s).map(({ inc: i }) => i.id)).toEqual(['a'])
  })

  it('tolerates a service with no incidents array at all', () => {
    expect(causalIncidents({ id: 'x', name: 'X', status: 'operational' } as ServiceStatus)).toEqual([])
  })
})

// --- #1072: a NON-CARDED feed as the upstream ---------------------------------------------------
// The evidenced outage of 2026-07-20. TITLES, TIMESTAMPS and the GitHub id are read off the wire
// (githubstatus.com/api/v2/summary.json for the GitHub side, GET /api/status/cached for the OpenAI
// side); the OpenAI incident id is synthetic and labelled as such below. This is the case the feature
// exists for:
// GitHub is not a monitored service, and the GitHub components AIWatch DOES monitor (copilot's
// `Copilot` + `Copilot AI Model Providers`) were `operational` for the entire incident — so before
// #1072 no arrangement of services could have produced this link.
describe('feed upstreams (#1072)', () => {
  const NOW_GH = Date.parse('2026-07-20T01:00:00Z') // ~25m after the OpenAI claim
  // Titles and timestamps are wire-verbatim. The GitHub id is real (`8vfyvq16hzh9`, Statuspage short
  // token — it is also asserted in upstream-feed.test.ts, which is the fixture that reads it off the
  // payload). The OpenAI id is SYNTHETIC and shaped like the incident.io ULID it stands in for: this
  // file asserts titles and ordering, never that id, so carrying a second hand-typed copy of a real
  // 26-char ULID would be a fact no test can see — the exact way the #1053 review found one incident's
  // head spliced onto another's tail. A synthetic id that ANNOUNCES itself cannot be mistaken for
  // provenance; a hand-typed real one can.
  const GH_ACTIONS = inc('8vfyvq16hzh9', 'Incident with GitHub Actions', '2026-07-19T23:34:03.457Z', {
    componentNames: ['Actions', 'API Requests'],
  })
  // Both OpenAI surfaces carry this one incident — they are siblings of the same status page.
  const OPENAI_GH = inc('SYNTHETIC-OPENAI-ULID-0001', 'Elevated errors for GitHub-dependent ChatGPT and Codex workflows', '2026-07-20T00:34:34Z')
  const githubFeed = (status: 'operational' | 'degraded' | 'down', incidents = [GH_ACTIONS]): UpstreamCandidate =>
    ({ id: 'github-platform', name: 'GitHub', status, incidents })

  it('links chatgpt to the GitHub feed on the evidenced outage', () => {
    const links = build([svc('chatgpt', 'degraded', [OPENAI_GH])], NOW_GH, [githubFeed('degraded')])
    expect(links).toHaveLength(1)
    expect(links[0].id).toBe('chatgpt')
    expect(links[0].incidentTitle).toBe(OPENAI_GH.title)
    expect(links[0].upstream).toHaveLength(1)
    expect(links[0].upstream[0]).toMatchObject({
      id: 'github-platform',
      name: 'GitHub',
      status: 'degraded',
      incidentTitle: 'Incident with GitHub Actions',
      startedAt: '2026-07-19T23:34:03.457Z',
    })
  })

  it('links codex from the SAME feed instance (gate 2 is per-dependent, so both surfaces render)', () => {
    const links = build(
      [svc('chatgpt', 'degraded', [OPENAI_GH]), svc('codex', 'degraded', [OPENAI_GH])],
      NOW_GH,
      [githubFeed('degraded')],
    )
    expect(links.map((l) => l.id).sort()).toEqual(['chatgpt', 'codex'])
  })

  it('stays quiet when the dependent blames GitHub but GitHub is healthy (gate 4 — the false-positive containment)', () => {
    // This is the case that justifies admitting the broad `github` alias at all: a dependent's OWN
    // integration bug names the same token. Without a concurrent GitHub outage there is no link.
    const links = build([svc('codex', 'degraded', [OPENAI_GH])], NOW_GH, [githubFeed('operational')])
    expect(links).toEqual([])
  })

  it('stays quiet when no feeds are supplied at all (a pre-#1072 cached snapshot)', () => {
    // The deploy-skew path: /api/status/cached reads `cached.upstreamFeeds ?? []` off a snapshot
    // written before this feature shipped. Must degrade to silence, never to a half-built link.
    const links = build([svc('chatgpt', 'degraded', [OPENAI_GH])], NOW_GH, [])
    expect(links).toEqual([])
  })

  it('a feed is never treated as a DEPENDENT even if it names an upstream', () => {
    // Feeds are upstream-only. Passing one whose own incident text names another upstream must not
    // manufacture a link keyed on the feed — it has no card to annotate.
    const chatty: UpstreamCandidate = {
      id: 'github-platform', name: 'GitHub', status: 'degraded',
      incidents: [inc('gh-2', 'Degraded due to an Anthropic issue', '2026-07-20T00:00:00Z')],
    }
    const links = build([svc('claude', 'down', [inc('c1', 'API errors', '2026-07-19T23:00:00Z')])], NOW_GH, [chatty])
    expect(links.find((l) => l.id === 'github-platform')).toBeUndefined()
  })

  it('a service wins an id collision with a feed (the feed is shadowed, not merged)', () => {
    // Pins the documented precedence in buildUpstreamLinks. The sync test above forbids this config,
    // so this asserts the RUNTIME behaviour that test's failure message describes.
    const shadow: UpstreamCandidate = { id: 'huggingface', name: 'Not Hugging Face', status: 'down', incidents: [GH_ACTIONS] }
    const links = build(
      [svc('replicate', 'degraded', [REPLICATE_HF]), svc('huggingface', 'down', [HF_HUB_DOWN])],
      NOW_HF,
      [shadow],
    )
    expect(links).toHaveLength(1)
    expect(links[0].upstream[0].name).toBe('Hugging Face') // the service, not the shadowing feed
  })
})

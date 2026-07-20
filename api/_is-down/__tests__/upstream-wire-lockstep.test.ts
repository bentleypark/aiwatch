// #1053 — the ONE test that makes the two hand-maintained copies of the wire contract confront each
// other. Everything else in this feature's suite is one-sided:
//
//   - worker/src/__tests__/upstream-link.test.ts asserts against the WORKER's own `UpstreamLink`
//   - api/_is-down/__tests__/upstream-note.test.ts hand-builds an `UpstreamLinkLike` fixture
//   - `typecheck:worker` does not cover api/, and there is no typecheck script for api/ at all
//
// So renaming `incidentTitle` → `title` on the worker's `UpstreamLink` leaves EVERY suite green and
// every typecheck green, while the card renders empty in production — during the handful-of-times-a-
// year outage that is the only moment anyone would see it. The upstream-note.test.ts comment named
// that hole ("the two hand-maintained copies of this wire shape never confront each other") without
// closing it; this closes it.
//
// The join has to be at RUNTIME, not a type-only import: vitest strips types via esbuild, so a
// `const wire: UpstreamLinkLike[] = links` assignment would be inert. So this drives the worker's real
// `buildUpstreamLinks` and feeds its actual output straight into the Edge's `buildUpstreamNote` with
// NO cast — if the field names diverge, the note comes out wrong and the render assertion fails.
//
// Precedent for reaching across the worker/Edge boundary in a test: api/_methodology/__tests__/
// html-template.test.ts imports PROBE_TARGETS from worker/src/probe for exactly this lockstep reason.
// `worker/src/upstream-link.ts` is portable: it imports `./types` (type-only, erased) and the runtime
// value `causalIncidents` from `./incident-text` — which itself imports only types. So the whole graph
// pulls in no workers-types and no bindings.

import { describe, it, expect } from 'vitest'
import { buildUpstreamLinks } from '../../../worker/src/upstream-link'
import type { ServiceStatus, Incident } from '../../../worker/src/types'
import { buildUpstreamNote } from '../upstream-note'
import { renderUpstreamNote, renderDelegatedListeners } from '../html-template'

// The real 2026-07-17 outage's titles and timestamps. The incident IDS here are deliberately
// synthetic: nothing in this file reads one, so carrying the real wire ids would be a second
// hand-maintained home for a fact that lives — and is asserted — in
// worker/src/__tests__/upstream-link.test.ts. A copy no test can see is how the two drift apart.
const inc = (id: string, title: string, startedAt: string): Incident =>
  ({ id, title, status: 'identified', impact: 'minor', startedAt, duration: null, timeline: [] }) as Incident

const svc = (id: string, name: string, status: ServiceStatus['status'], incidents: Incident[]): ServiceStatus =>
  ({ id, name, status, incidents }) as ServiceStatus

const LIVE_OUTAGE: ServiceStatus[] = [
  svc('claude', 'Claude API', 'degraded', [inc('upstream-inc', 'Elevated errors on Sonnet 5 and Haiku 4.5', '2026-07-17T06:47:54.909Z')]),
  svc('cursor', 'Cursor', 'degraded', [inc('dependent-inc', 'Investigating Anthropic degradation', '2026-07-17T07:17:15.075Z')]),
]
// `now` must be passed explicitly. Nothing type-checks api/ (there is no typecheck script for it and
// `typecheck:worker` excludes it), so omitting it here would NOT fail the build — esbuild strips the
// types, `now` arrives `undefined`, `undefined - claim.at` is NaN, `NaN > CAUSE_WINDOW_MS` is false,
// and the freshness gate silently waves everything through with the suite still green. Which is the
// same class of hole this whole file exists to close.
const NOW = Date.parse('2026-07-17T08:00:00Z') // ~43m after the cursor claim

describe('worker UpstreamLink → Edge UpstreamLinkLike wire lockstep (#1053)', () => {
  const links = buildUpstreamLinks(LIVE_OUTAGE, [], NOW)

  it('the worker emits a link for the evidenced outage', () => {
    expect(links).toHaveLength(1) // guards the rest of this file from passing vacuously
  })

  it('the Edge reads the worker\'s ACTUAL output — no hand-written fixture, no cast', () => {
    // links is UpstreamLink[]; buildUpstreamNote takes UpstreamLinkLike[]. This assignment is the
    // contract: a field the Edge declares but the worker no longer emits fails right here.
    const note = buildUpstreamNote(links, 'cursor')
    expect(note).not.toBeNull()
    expect(note!.fromId).toBe('cursor')
    expect(note!.incidentTitle).toBe('Investigating Anthropic degradation')
    expect(note!.upstream).toEqual([{
      id: 'claude',
      name: 'Claude API',
      status: 'degraded',
      incidentTitle: 'Elevated errors on Sonnet 5 and Haiku 4.5',
      startedAt: '2026-07-17T06:47:54.909Z',
      href: '/is-claude-down',
      external: false, // a SERVICE upstream keeps the reader on AIWatch
      leadMinutes: 29, // derived across the boundary: worker startedAt(s) → Edge arithmetic
    }])
  })

  it('renders end-to-end from real worker output', () => {
    const html = renderUpstreamNote(buildUpstreamNote(links, 'cursor'), 'Cursor')
    expect(html).toContain('Related Upstream Incident')
    expect(html).toContain('Elevated errors on Sonnet 5 and Haiku 4.5')
    expect(html).toContain('29m before Cursor&rsquo;s report')
  })

})

// #1072 — the same runtime join, for the NON-CARDED feed upstream. This is where `statusUrl` gets
// proven end-to-end: it is born in the worker's `UPSTREAM_FEEDS`, ridden through `buildUpstreamLinks`
// as an optional wire field, re-declared by hand in the Edge's `UpstreamLinkLike`, and turned into an
// href by `buildUpstreamNote`. Four hand-maintained hops, none of them type-checked together
// (`typecheck:worker` excludes api/), so only a runtime join can catch a rename.
describe('feed upstream → external status link (#1072)', () => {
  const GH_FEED = [{
    id: 'github-platform',
    name: 'GitHub',
    status: 'degraded' as const,
    statusUrl: 'https://www.githubstatus.com',
    incidents: [inc('gh-inc', 'Incident with GitHub Actions', '2026-07-19T23:34:03.457Z')],
  }]
  const OPENAI_OUTAGE = [
    svc('chatgpt', 'ChatGPT', 'degraded', [inc('openai-inc', 'Elevated errors for GitHub-dependent ChatGPT and Codex workflows', '2026-07-20T00:34:34Z')]),
  ]
  const NOW_GH = Date.parse('2026-07-20T01:00:00Z')
  const ghLinks = buildUpstreamLinks(OPENAI_OUTAGE, GH_FEED, NOW_GH)

  it('the worker emits the link with statusUrl on the wire', () => {
    expect(ghLinks).toHaveLength(1)
    expect(ghLinks[0].upstream[0].statusUrl).toBe('https://www.githubstatus.com')
  })

  it('the Edge turns it into an EXTERNAL href (no is-down page exists for a feed)', () => {
    const note = buildUpstreamNote(ghLinks, 'chatgpt')!
    expect(note.upstream[0].href).toBe('https://www.githubstatus.com')
    expect(note.upstream[0].external).toBe(true)
  })

  it('renders a new-tab link with the external GA destination', () => {
    const html = renderUpstreamNote(buildUpstreamNote(ghLinks, 'chatgpt'), 'ChatGPT')
    expect(html).toContain('href="https://www.githubstatus.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('data-ga-dest="external"')
    expect(html).toContain('Check GitHub status')
    // The event name stays `upstream_link` — NOT outbound_fallback_click, whose #842 referral beacon
    // feeds the sponsor figure and must not absorb status-page clicks.
    expect(html).toContain('data-ga="upstream_link"')
    expect(html).not.toContain('outbound_fallback_click')
  })

  it('the delegated listener actually FORWARDS data-ga-dest to gtag', () => {
    // Rendering the attribute is only half the wiring. The listener builds its gtag params from an
    // explicit dataset allowlist, so an attribute with no matching branch is written into the DOM and
    // then silently dropped — and a `toContain('data-ga-dest=…')` assertion passes straight over that
    // gap. Pin both halves, in one place, so they can only drift together.
    const listener = renderDelegatedListeners('chatgpt', true)
    expect(listener).toContain('d.gaDest')
    expect(listener).toMatch(/if \(d\.gaDest\)\s*p\.\w+\s*=\s*d\.gaDest/)
  })

  it('every data-ga-* attribute the upstream row emits has a listener branch', () => {
    // The general form of the bug above: any future data-ga-* on this row is inert unless the
    // allowlist knows it. Derive the attributes from the rendered row rather than listing them, so a
    // newly-added one is covered without anyone remembering to extend this test.
    const html = renderUpstreamNote(buildUpstreamNote(ghLinks, 'chatgpt'), 'ChatGPT')
    const listener = renderDelegatedListeners('chatgpt', true)
    const attrs = [...html.matchAll(/data-ga-([a-z-]+)=/g)].map((m) => m[1])
    expect(attrs.length).toBeGreaterThan(0)
    for (const a of attrs) {
      // kebab → camel, matching how the DOM builds dataset keys: data-ga-from-service → d.gaFromService
      const key = 'ga' + a.replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase()).replace(/^./, (ch) => ch.toUpperCase())
      expect(listener, `no listener branch for data-ga-${a} (d.${key})`).toContain(`d.${key}`)
    }
  })

  it('falls back to a LINKLESS row when the worker predates statusUrl (deploy skew)', () => {
    // The asymmetry `upstream-note.ts` mandates: Vercel ships the Edge on merge while the worker
    // deploy is manual, so an old worker serves the feed WITHOUT statusUrl. Must degrade to the
    // pre-#1072 linkless row, never to a broken `href="undefined"`.
    const stale = [{ ...ghLinks[0], upstream: [{ ...ghLinks[0].upstream[0], statusUrl: undefined }] }]
    const note = buildUpstreamNote(stale, 'chatgpt')!
    expect(note.upstream[0].href).toBeNull()
    expect(note.upstream[0].external).toBe(false)
    const html = renderUpstreamNote(note, 'ChatGPT')
    expect(html).toContain('Incident with GitHub Actions') // the row itself still renders
    expect(html).not.toContain('href="undefined"')
    expect(html).not.toContain('Check GitHub status')
  })
})

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// #1268 — the CALL SITE for the probe-backed disclosure. The worker half (`probeConfirmed` is set when
// Phase-1 cross-validation overrides an unreadable-source verdict back to `operational`) is pinned in
// `worker/src/__tests__/deleted-source-not-ranked.test.ts`; a green flag on the wire is not a green
// card. This is the `live-incident-wiring.test.js` pattern, and it exists because the state it covers
// is the one that LOOKS like it needs no note: the pill is green, so a missing banner reads as normal.
//
// The state: Character.AI's status source is unreadable, our own probe reaches the service, so the
// worker publishes `operational` — a green backed by OUR measurement, not the provider's. Before this
// change the card said only "OPERATIONAL", with the score and incident counts it had computed from a
// feed it never read.
//
// All three fixtures discriminate; each one flips if a different half of the change is reverted.

vi.mock('../../hooks/useLang', () => ({ useLang: () => ({ t: (k) => k, lang: 'en' }) }))
vi.mock('../../utils/pageContext', () => ({ usePage: () => ({ page: 'service', setPage: () => {} }) }))
vi.mock('../../utils/analytics', () => ({ trackEvent: () => {} }))
vi.mock('../../utils/chartLoader', () => ({ ensureChart: () => Promise.resolve(null) }))

let CURRENT = null
vi.mock('../../hooks/usePolling', () => ({
  usePolling: () => ({
    services: CURRENT ? [CURRENT] : [], loading: false, error: null,
    probe24h: [], latency24h: [], probeServiceIds: [], refresh: () => {},
    recentlyRecovered: {}, securityAlerts: [], reportFeed: {},
  }),
}))

const { default: ServiceDetails } = await import('../ServiceDetails')

const service = (over = {}) => ({
  id: 'characterai', name: 'Character.AI', provider: 'Character AI', category: 'app',
  status: 'operational', latency: null, uptime30d: null, lastChecked: new Date().toISOString(),
  incidents: [], ...over,
})

/** Rendered with `t` mocked to the identity, so the assertions name the LOCALE KEY rather than copy —
 *  a copy edit must not redden this file, but dropping the variant must. */
const render = (svc) => {
  CURRENT = svc
  return renderToStaticMarkup(createElement(ServiceDetails, { serviceId: svc.id }))
}

describe('#1268 — the unreadable-source banner on ServiceDetails', () => {
  it('a probe-backed green carries the note, in its probe variant', () => {
    // THE discriminating case, and the one that shipped bare: status is `operational`, so neither
    // pre-existing arm fires (`sourceDead` is false; the `status === 'unknown'` arm is false because
    // the cross-validation already overrode the verdict).
    // Faithful to the wire: an override-to-operational carries the flag too, because
    // `withUnreadFeedFlag` set it upstream in `fetchService` before cross-validation ran. The first
    // version of this fixture omitted it and pinned a state the worker never publishes.
    const html = render(service({ sourceUnknown: true, probeConfirmed: true, incidentSourceStale: true }))
    expect(html).toContain('svc.sourceUnknown.title')
    expect(html).toContain('svc.sourceUnknown.bodyProbe')
    // Shape-independent: `bodyProbe` contains `body` as a substring, so a plain `not.toContain` would
    // always fire. A trailing-delimiter test would work only because the key happens to be the last text
    // node before `</div>` — one space after `{t(...)}` and it silences itself while staying green.
    expect(html).not.toMatch(/svc\.sourceUnknown\.body(?!Probe)/)
  })

  it('an unreadable source with NO probe override keeps the plain variant', () => {
    // Guards the body-variant picker in the other direction: `bodyProbe` must not swallow the case it
    // was added beside.
    const html = render(service({ status: 'unknown', sourceUnknown: true }))
    expect(html).toContain('svc.sourceUnknown.title')
    expect(html).toContain('svc.sourceUnknown.body')
    expect(html).not.toContain('svc.sourceUnknown.bodyProbe')
  })

  it('a FIRST-STRIKE unreadable read shows no banner at all', () => {
    // The flap-suppression case. Under the 3-strike threshold the worker publishes `operational` with
    // `sourceUnknown` and no `probeConfirmed` — a single failed poll of a source that may just be
    // blipping. Widening the new arm to bare `sourceUnknown` would put "AIWatch can't read this
    // provider's status page" on every service the moment one poll hiccups, and nothing else pins that.
    const html = render(service({ sourceUnknown: true }))
    // Positive anchor first: a pure-negative assertion cannot tell "no banner" from "no component", and
    // this file's mocks are exactly what could silently produce the latter.
    expect(html).toContain('Character.AI')
    expect(html).not.toContain('svc.sourceUnknown.title')
  })

  it('a PLATFORM-held green carries the note too — the note follows the blanking', () => {
    // Phase 2 (quorum) / Phase 3 (metastatuspage) also force `operational`, and unlike the probe pass
    // they record no provenance at all. The flag is still set, so uptime, incidents, the calendar and
    // the ranking are all blanked — and before this the card showed that behind a green pill with
    // nothing explaining it. Phase 2 fires at platform scale, so it is a whole-roster event.
    const html = render(service({ sourceUnknown: true, incidentSourceStale: true, uptime30d: 99.9 }))
    expect(html).toContain('svc.sourceUnknown.title')
    expect(html).toContain('svc.sourceUnknown.body')
    expect(html).not.toContain('svc.sourceUnknown.bodyProbe')  // no probe → claim no measurement
    expect(html).not.toContain('99.9')                          // premise: the data IS blanked
  })

  it('a probe-CORROBORATED outage gets the AFFECTED sentence, not the "not impaired" one', () => {
    // Phase 1's `isProbeFailing` arm promotes the verdict to `degraded` + `probeContradicted`: our own
    // probe independently confirms the outage. `sourceFlagsOf` strips `sourceUnknown` there for exactly
    // that reason (#1004, re-cut in #1233), and the flag set upstream outlives the promotion. The card
    // still blanks uptime, Incidents, MTTR, the Score section and the calendar, so it needs a note —
    // just not one closing "it does NOT mean the service is impaired" beside an amber pill.
    const html = render(service({ status: 'degraded', sourceUnknown: true, probeContradicted: true, incidentSourceStale: true }))
    expect(html).toContain('svc.sourceUnknown.title')
    expect(html).toContain('svc.sourceUnknown.bodyAffected')
    expect(html).not.toMatch(/svc\.sourceUnknown\.body(?!Affected)/)
  })

  it('an aging relay serving a live DOWN badge gets the same treatment', () => {
    // The dashboard twin of the is-down finding: `readFlashdutyStatus` keeps the flag past the 1h
    // soft-stale window while still serving the relayed feed's live badge, which can be `down`.
    const html = render(service({ status: 'down', incidentSourceStale: true }))
    expect(html).toContain('svc.sourceUnknown.bodyAffected')
  })

  it('a healthy service shows no banner (no over-application)', () => {
    const html = render(service({ uptime30d: 99.9 }))
    expect(html).toContain('Character.AI')
    expect(html).not.toContain('svc.sourceUnknown.title')
    expect(html).not.toContain('svc.sourceDead.title')
  })
})

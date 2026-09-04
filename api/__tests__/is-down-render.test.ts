import { describe, it, expect } from 'vitest'
import { renderDelegatedListeners, resolveBeaconSvcId, buildMetaDescription, renderPage, hasLiveIncident, exceededRecoveryTextEn, FAR_EXCEEDED_FACTOR as EDGE_FAR_EXCEEDED_FACTOR } from '../_is-down/html-template'
import { FAR_EXCEEDED_FACTOR as FRONTEND_FAR_EXCEEDED_FACTOR } from '../../src/utils/predictionAccuracy'
import { getSEOContent } from '../_is-down/seo-content'
import { SLUG_TO_SERVICE } from '../_is-down/slug-map'

// Guard for #842-B: the audience beacon + click delegation live inside ONE `<script>` template
// literal. A stray backtick in a comment there once truncated the literal → the Edge SSR built a
// broken page (500 FUNCTION_INVOCATION_FAILED), which vitest's transform tolerated but Vercel's
// esbuild rejected — so unit tests were green while every is-down page (and the consent banner it
// carries) failed in CI Edge E2E. This asserts the rendered script is INTACT end-to-end.
describe('renderDelegatedListeners integrity (#842-B)', () => {
  const html = renderDelegatedListeners('claude', true)

  it('renders a single complete <script> ... </script> block', () => {
    expect(html.startsWith('<script>')).toBe(true)
    expect(html.trimEnd().endsWith('</script>')).toBe(true)
    // Exactly one script open/close — a truncated template literal would drop the tail entirely.
    expect(html.match(/<script>/g)?.length).toBe(1)
    expect(html.match(/<\/script>/g)?.length).toBe(1)
  })

  it('contains BOTH the audience beacon (top) and the click delegation (tail)', () => {
    // The beacon is emitted before the click listener; asserting the tail proves the literal
    // wasn't cut short after the beacon comment (the exact regression this guards).
    expect(html).toContain('/api/pageview')
    expect(html).toContain("addEventListener('click'")
    expect(html).toContain('outbound_fallback_click') // referral beacon still present
  })

  // #1280 — the per-service page must declare its own surface. Without this the worker has no way to
  // tell this view from a GROUP-page view: the group page posts one of its members' service ids by
  // design, so `svc` alone identifies neither the screen nor even a stable service (the member it
  // reports changes with the family's status). The two pages are pinned in two files because they are
  // two Functions; the group half lives in is-down-group.test.ts.
  it('declares the service surface in the beacon body (#1280)', () => {
    expect(html).toContain('surface: "service"')
    expect(html).not.toContain('surface: "group"')
  })

  it('reduces the referrer to a bare HOSTNAME before sending it (#1055 contract)', () => {
    // classifyReferrer's host patterns are all `$`-anchored, so they only work on a bare hostname.
    // If this ever sent `document.referrer` raw, EVERY host bucket (reddit/hn/search/x/owned) would
    // silently fall through to `refhost`: reddit/hn pinned at zero, refhost absorbing everything,
    // and the daily is-down Audience line looking perfectly plausible throughout — re-introducing the
    // "inbound is unreadable" state #1055 exists to fix. Worker-side pin: outage-audience.test.ts
    // asserts a full URL classifies as `refhost`, not `reddit`.
    expect(html).toContain('new URL(document.referrer).hostname')
  })

  it('injects the svc id + active flag as safe literals', () => {
    expect(renderDelegatedListeners('claude', true)).toContain('svc: "claude"')
    expect(renderDelegatedListeners('claude', true)).toContain('active: true')
    expect(renderDelegatedListeners('openai', false)).toContain('active: false')
  })
})

// #1287 — the beacon's service id on the path where the status read FAILED, which includes the paths
// where the worker is under strain, i.e. the outage window this metric measures.
describe('resolveBeaconSvcId (#1287 — the id survives a failed status read)', () => {
  // The whole defect in one case. `claude-api` is the slug, `claude` is the id; posting the slug was a
  // 400 and the view was DELETED — not booked as unknown, absent, and absent reads as nobody visiting.
  it('resolves a slug whose id differs, with no service data', () => {
    expect(resolveBeaconSvcId('claude-api', null)).toBe('claude')
    expect(resolveBeaconSvcId('claude-code', null)).toBe('claudecode')
    expect(resolveBeaconSvcId('openai-api', null)).toBe('openai')
    expect(resolveBeaconSvcId('flux', null)).toBe('bfl')
    expect(resolveBeaconSvcId('langchain', null)).toBe('langsmith')
  })

  // Every one of the 10 slug != id pages, read off the map rather than hand-listed: a future rename
  // that reintroduces a mismatch is covered without editing this test.
  it('never returns a bare slug for any page whose slug is not its id', () => {
    const mismatched = Object.entries(SLUG_TO_SERVICE).filter(([slug, e]) => slug !== e.id)
    expect(mismatched.length).toBeGreaterThan(0) // the test is vacuous if the map ever flattens
    for (const [slug, entry] of mismatched) {
      expect(resolveBeaconSvcId(slug, null), `slug ${slug} still posts a slug`).toBe(entry.id)
    }
  })

  // The 33 slug == id pages cannot distinguish the bug from the fix — stated so the case above is not
  // mistaken for redundant coverage.
  it('is unchanged for a slug that already equals its id', () => {
    expect(resolveBeaconSvcId('gemini', null)).toBe('gemini')
  })

  // The helper is not the fix — the CALL SITE is. Reverting `renderPage` to `service?.id ?? slug`
  // while leaving this helper and all its tests intact passed the whole suite, which is exactly the
  // "guard planted where the test calls, not where production calls" recurrence this repo has
  // recorded twice (#966, #1268). These two render through `renderPage`, so the wire is pinned.
  //
  // `service: null` is the state under test.
  it('renderPage emits the ID, not the slug, when the status read failed', () => {
    const html = renderPage('claude-api', null as never, getSEOContent('claude-api')!, [], null)
    expect(html).toContain('svc: "claude"')
    expect(html).not.toContain('svc: "claude-api"')
  })

  it('renderPage does the same for a non-Anthropic mismatch', () => {
    const html = renderPage('flux', null as never, getSEOContent('flux')!, [], null)
    expect(html).toContain('svc: "bfl"')
    expect(html).not.toContain('svc: "flux"')
  })
})

describe('buildMetaDescription — recovery estimate exceeded (Mistral 2–4h on a days-long incident)', () => {
  const seo = getSEOContent('claude-api')!
  const degraded = { status: 'degraded' } as unknown as Parameters<typeof buildMetaDescription>[1]
  const recent = new Date(Date.now() - 60_000).toISOString() // 1 min ago

  it('shows "Exceeded typical pattern" (not the stale range) for an active incident past its estimate', () => {
    const desc = buildMetaDescription(seo, degraded, {
      summary: 'Ongoing degradation.', estimatedRecovery: '2–4h', estimatedRecoveryHours: 4,
      startedAt: '2020-01-01T00:00:00.000Z', // long past any estimate
    })
    expect(desc).toContain('Exceeded typical pattern')
    expect(desc).not.toContain('2–4h')
  })

  it('parity: derives the bound from the display string when the numeric field is absent', () => {
    const desc = buildMetaDescription(seo, degraded, {
      summary: 'Ongoing degradation.', estimatedRecovery: '2–4h', // no estimatedRecoveryHours
      startedAt: '2020-01-01T00:00:00.000Z',
    })
    expect(desc).toContain('Exceeded typical pattern')
  })

  it('still shows the range while within the estimated window', () => {
    const desc = buildMetaDescription(seo, degraded, {
      summary: 'Ongoing degradation.', estimatedRecovery: '2–4h', estimatedRecoveryHours: 4,
      startedAt: recent,
    })
    expect(desc).toContain('2–4h')
    expect(desc).not.toContain('Exceeded typical pattern')
  })

  it('meta/share keep the terse "Exceeded typical pattern" wording (not the elapsed detail)', () => {
    const desc = buildMetaDescription(seo, degraded, {
      summary: 'Ongoing degradation.', estimatedRecovery: '2–4h', estimatedRecoveryHours: 4,
      startedAt: '2020-01-01T00:00:00.000Z',
    })
    expect(desc).toContain('Exceeded typical pattern')
    expect(desc).not.toContain('Ongoing ~')
  })
})

describe('exceededRecoveryTextEn (is-down AI card — elapsed vs estimate)', () => {
  const now = new Date('2026-07-02T03:24:57.000Z').getTime()
  it('renders "Ongoing ~12h · exceeded ~2–4h est." for the Fine-Tuning incident', () => {
    expect(exceededRecoveryTextEn(
      { estimatedRecovery: '2–4h', estimatedRecoveryHours: 4, startedAt: '2026-07-01T15:38:30.837Z' }, now,
    )).toBe('Ongoing ~12h · exceeded ~2–4h est.')
  })
  it('derives the range from the numeric bound when the display string is N/A', () => {
    expect(exceededRecoveryTextEn(
      { estimatedRecovery: 'N/A', estimatedRecoveryHours: 4, startedAt: '2026-07-01T15:38:30.837Z' }, now,
    )).toBe('Ongoing ~12h · exceeded ~4h est.')
  })
  it('falls back to terse wording when startedAt is missing', () => {
    expect(exceededRecoveryTextEn({ estimatedRecovery: '2–4h' }, now)).toBe('Exceeded typical pattern')
  })
  // #900 — parity with the frontend: drop the stale range once FAR past the estimate
  it('drops the stale range when > 3× over (69h vs 4–8h → "far exceeded est.")', () => {
    const started = new Date(now - 69 * 3_600_000).toISOString()
    expect(exceededRecoveryTextEn(
      { estimatedRecovery: '4–8h', estimatedRecoveryHours: 8, startedAt: started }, now,
    )).toBe('Ongoing ~69h · far exceeded est.')
  })
  it('keeps the range at exactly 3×, drops it just past (boundary — catches an Edge-side factor bump)', () => {
    const at3x = new Date(now - 12 * 3_600_000).toISOString() // 12h = 3× the 4h upper bound
    expect(exceededRecoveryTextEn(
      { estimatedRecovery: '2–4h', estimatedRecoveryHours: 4, startedAt: at3x }, now,
    )).toBe('Ongoing ~12h · exceeded ~2–4h est.')
    const justPast = new Date(now - 13 * 3_600_000).toISOString() // 13h > 12h (3×) → far
    expect(exceededRecoveryTextEn(
      { estimatedRecovery: '2–4h', estimatedRecoveryHours: 4, startedAt: justPast }, now,
    )).toBe('Ongoing ~13h · far exceeded est.')
  })
  // #900 — the two mirrored constants must stay equal (repo parity convention; direct pin, not just a comment)
  it('FAR_EXCEEDED_FACTOR is identical across the frontend + Edge mirrors', () => {
    expect(EDGE_FAR_EXCEEDED_FACTOR).toBe(FRONTEND_FAR_EXCEEDED_FACTOR)
  })
})

// #1004 — the is-down page is the widest-reach surface AIWatch has: its <title> and meta description
// ARE the Google answer to "is X down". Both were driven by the raw `status`, so a `degraded` that only
// ever meant "our fetch failed 3 times" got published as "Issues — X is having problems right now".
// That is exactly what JetBrains' status-page migration did to Junie. When AIWatch cannot READ the
// source it must not answer Yes or No.
describe('is-down publishes no verdict when the status source is unreadable (#1004)', () => {
  const seo = getSEOContent('junie')!
  const base = {
    id: 'junie', name: 'Junie', provider: 'JetBrains', category: 'agent',
    latency: null, uptime30d: null, lastChecked: new Date().toISOString(),
    incidents: [], aiwatchScore: null, scoreGrade: null,
  }

  it('a fetch-failure degraded (sourceUnknown) answers "Unknown", not "Issues"', () => {
    const desc = buildMetaDescription(seo, { ...base, status: 'degraded', sourceUnknown: true } as never, null)
    expect(desc).toContain('Unknown')
    expect(desc).toContain("can't read the provider's status page")
    expect(desc).not.toContain('is having problems right now')
  })

  it('a dead source (4xx, #689) is equally unanswerable — it never reached is-down before', () => {
    const desc = buildMetaDescription(seo, { ...base, status: 'operational', sourceDead: true } as never, null)
    expect(desc).toContain('Unknown')
    expect(desc).not.toContain('is operational')
  })

  it('but a probe-CORROBORATED degraded still answers "Issues" — the outage is real', () => {
    const desc = buildMetaDescription(
      seo, { ...base, status: 'degraded', sourceUnknown: true, probeContradicted: true } as never, null,
    )
    expect(desc).toContain('is having problems right now')
    expect(desc).not.toContain('Unknown')
  })

  it('and a probe-CONFIRMED dead source still answers "No" (#689 — the API answers our probe)', () => {
    const desc = buildMetaDescription(
      seo, { ...base, status: 'operational', sourceDead: true, probeConfirmed: true } as never, null,
    )
    expect(desc).toContain('is operational')
  })

  it('an ordinary operational service is untouched', () => {
    const desc = buildMetaDescription(seo, { ...base, status: 'operational' } as never, null)
    expect(desc).toContain('No —')
    expect(desc).toContain('is operational')
  })
})

// The whole PAGE, not just the meta description: the title, the CTA that sits directly under the status
// header (#297), the share/copy payload and the og:image all derived the verdict from the RAW status
// independently. Fixing them one at a time left the page asserting and denying the outage in adjacent
// paragraphs. One render, one set of assertions — revert any single call site and this fails.
describe('the whole is-down page agrees when the source is unreadable (#1004)', () => {
  const seo = getSEOContent('junie')!
  const base = {
    id: 'junie', name: 'Junie', provider: 'JetBrains', category: 'agent',
    latency: null, uptime30d: null, lastChecked: new Date().toISOString(),
    incidents: [], aiwatchScore: null, scoreGrade: null,
  }
  const render = (svc: object) => renderPage('junie', svc as never, seo, [], null)

  it('an unreadable source publishes NO verdict anywhere on the page', () => {
    const html = render({ ...base, status: 'degraded', sourceUnknown: true })
    expect(html).toContain('Status Unknown')                        // <title>
    expect(html).toContain('status page right now')                  // CTA (apostrophes are entity-escaped)
    expect(html).not.toContain('is having problems right now')       // header answer
    expect(html).not.toContain('is having issues right now')         // CTA (the #297 contradiction)
    expect(html).not.toContain('Degraded Performance')               // share payload
    expect(html).toContain('status=unknown')                         // og:image params
    expect(html).not.toContain('status=degraded')
  })

  // #1233 — the SAME invariant against the shape the worker actually sends now. The case above drives
  // the LEGACY pair (`degraded` + `sourceUnknown`) and is kept as the transitional control, because a
  // payload cached before the change still looks like that for the life of the cache. Production is now
  // `status: 'unknown'`, and nothing asserted that until this case: `isStatusUnknown`'s new first clause
  // could be deleted with the whole suite green.
  it('...and the same holds for the raw `unknown` status the worker now publishes', () => {
    const html = render({ ...base, status: 'unknown', sourceUnknown: true })
    expect(html).toContain('Status Unknown')
    expect(html).toContain('status page right now')
    expect(html).not.toContain('is having problems right now')
    expect(html).not.toContain('is having issues right now')
    expect(html).not.toContain('Degraded Performance')
    expect(html).toContain('status=unknown')
    expect(html).not.toContain('status=degraded')
  })

  // #1233 — the "🔄 Alternatives" block gated on `serviceStatus !== 'operational'`, a two-valued test
  // that `'unknown'` passes. The page then recommended switching away from a service whose own headline
  // says the status could not be confirmed. Reachable because the AI card renders from `ai:analysis:*`
  // KV, which outlives the wire incident list an unreadable payload no longer carries.
  it('publishes NO alternatives block for an unreadable source, even with an analysed incident', () => {
    const insight = {
      summary: 'Investigating elevated errors.', estimatedRecovery: '~1h',
      affectedScope: ['API'], analyzedAt: new Date().toISOString(), needsFallback: true,
    }
    const fallbacks = [{ id: 'cursor', name: 'Cursor', score: 88, status: 'operational' }]
    // Asserted on the AI card's own "🔄 Alternatives" marker, NOT on the candidate's name: the page
    // also carries a permanent, status-independent Alternatives SEO section, so `not.toContain('Cursor')`
    // would fail on content that is correct.
    const html = renderPage('junie', { ...base, status: 'unknown', sourceUnknown: true } as never, seo, fallbacks, insight as never)
    expect(html).not.toContain('🔄 Alternatives')

    // Control: the identical payload with a CONFIRMED outage still recommends.
    const confirmed = renderPage('junie', { ...base, status: 'down' } as never, seo, fallbacks, insight as never)
    expect(confirmed).toContain('🔄 Alternatives')
  })

  it('a probe-corroborated outage still publishes the outage everywhere', () => {
    const html = render({ ...base, status: 'degraded', sourceUnknown: true, probeContradicted: true })
    expect(html).toContain('Having Issues')                          // <title>
    expect(html).toContain('is having issues right now')             // CTA
    expect(html).toContain('status=degraded')                        // og:image
    expect(html).not.toContain('Status Unknown')
  })

  // #1233 round-3 review — every status lookup in this template ended on the red/"Down" arm, so a value
  // the file does not recognise (an older cached payload, a future union member) published a fabricated
  // outage into the <title>, the meta description, og:title and the H1 — the highest-reach surface
  // AIWatch has, and the last one still failing dangerous after `statusVerdict` and `og.ts` were fixed.
  it('an UNRECOGNISED status publishes the neutral non-answer, never a fabricated outage', () => {
    const html = render({ ...base, status: 'maintenance' })
    expect(html).toContain('Status Unknown')
    expect(html).not.toContain('Down Right Now')
    expect(html).not.toContain('is down right now')
    expect(html).toContain('#8b949e')   // the neutral status colour
    // Not asserted: the absence of `#f85149` — that token also appears in static page CSS unrelated to
    // the status verdict, so a blanket check would fail on content that is correct.
  })

  it('control: a genuine `down` still publishes the outage', () => {
    const html = render({ ...base, status: 'down' })
    expect(html).toContain('Down Right Now')
    expect(html).toContain('is down right now')
  })

  it('an ordinary operational page is untouched', () => {
    const html = render({ ...base, status: 'operational', uptime30d: 99.9 })
    expect(html).toContain('Operational')
    expect(html).toContain('Get notified the next time Junie goes down.')
    expect(html).not.toContain('Status Unknown')
  })

  it('#744 partial is NOT swept up: the title/SEO answer still says operational', () => {
    const html = render({ ...base, status: 'operational', partialCount: 2 })
    expect(html).toContain('Is Junie Down? Operational')
    expect(html).not.toContain('Status Unknown')
  })
})

// #1104 made "green badge + ongoing incident" an ORDINARY state — #970's `impact: none` keep and the
// `unjudgeable` fail-open already made it reachable (the worker now keeps an incident whose
// impact window on our component has closed while the incident stays open). The analysis card derived
// "resolved" from the badge, so in exactly that state it labelled a live incident Resolved — directly
// above an incident row its own `inc.status` renders as Investigating, on the page the alert links to.
describe('the analysis card asks the INCIDENT, not the badge (#1104)', () => {
  const seo = getSEOContent('junie')!
  const base = {
    id: 'junie', name: 'Junie', provider: 'JetBrains', category: 'agent',
    latency: null, uptime30d: null, lastChecked: new Date().toISOString(),
    incidents: [], aiwatchScore: null, scoreGrade: null,
  }
  const insight = {
    summary: 'Image generation is unavailable for some users.',
    estimatedRecovery: '~1h', affectedScope: ['Images'],
    analyzedAt: new Date().toISOString(), needsFallback: true,
  }
  const ongoing = { id: 'i1', title: 'Image generation unavailable', status: 'identified', impact: 'major', startedAt: new Date().toISOString(), duration: null }
  const done = { ...ongoing, id: 'i2', status: 'resolved', duration: '1h 6m' }
  const render = (svc: object) => renderPage('junie', svc as never, seo, [{ name: 'Alt', score: 90 } as never], insight as never)

  it('an ongoing incident under a green badge is NOT labelled Resolved', () => {
    const html = render({ ...base, status: 'operational', incidents: [ongoing] })
    expect(html).toContain('Is Junie Down? Operational')   // the badge answer is unchanged — correct
    expect(html).toContain('Investigating')                // the incident row says it is live…
    expect(html).not.toContain('Post-Incident Analysis')   // …so the card must not say it is over
    expect(html).not.toContain('>Resolved<')
  })

  it('once the incident really is resolved, the card goes back to Post-Incident (no over-correction)', () => {
    const html = render({ ...base, status: 'operational', incidents: [done] })
    expect(html).toContain('Post-Incident Analysis')
  })

  it('an operational badge still suppresses the Alternatives block, ongoing incident or not', () => {
    // Gated on the BADGE deliberately: recommending an alternative while we answer "Operational" at the
    // top of the page would contradict it. Pins that #1104 did NOT widen the fallback surface.
    expect(render({ ...base, status: 'operational', incidents: [ongoing] })).not.toContain('🔄 Alternatives')
    expect(render({ ...base, status: 'degraded', incidents: [ongoing] })).toContain('🔄 Alternatives')
  })

  it('a RESOLVED analysis is not re-opened by an unrelated sibling incident', () => {
    // A `monitoring` sibling is the provider confirming recovery, so it must NOT hold a resolved card
    // open — `hasLiveIncident` excludes it for the same reason /api/status/cached does when picking
    // which analyses to send. Pins the cut itself: count `monitoring` as live and this card wrongly
    // reads "ongoing", printing a live recovery estimate next to its own "✅ Recovered".
    const resolvedInsight = { ...insight, resolvedAt: new Date().toISOString(), startedAt: new Date(Date.now() - 4e6).toISOString() }
    const html = renderPage('junie', { ...base, status: 'operational', incidents: [done, { ...ongoing, id: 'i3', status: 'monitoring' }] } as never, seo, [] as never, resolvedInsight as never)
    expect(html).toContain('Post-Incident Analysis')
  })

  it('a resolved analysis is NOT stamped Resolved while a live incident is on the page', () => {
    // The trap in the other direction, and the reason there is no "every insight has resolvedAt"
    // override: /api/status/cached fills the recovered-analysis branch whenever the ACTIVE branch
    // produced nothing — not when nothing is active. So a card can hold only resolved analyses while an
    // `identified` incident is live (its own analysis lost the cron's 15s budget, or the provider
    // re-opened an incident we already stamped resolvedAt). An override would print "Resolved" above
    // "Investigating" — #1104 again, one level up.
    const resolvedInsight = { ...insight, resolvedAt: new Date().toISOString(), startedAt: new Date(Date.now() - 4e6).toISOString() }
    const html = renderPage('junie', { ...base, status: 'operational', incidents: [done, ongoing] } as never, seo, [] as never, resolvedInsight as never)
    expect(html).toContain('Investigating')
    expect(html).not.toContain('Post-Incident Analysis')
  })

  it('an incident open longer than the 7-day window still appears in the section (#1104)', () => {
    // Otherwise the ongoing analysis card sits above "No incidents in the last 7 days" — a false
    // all-clear. The window is for CLOSED incidents; an open one is current whatever its start date.
    const old = { ...ongoing, id: 'i9', startedAt: new Date(Date.now() - 12 * 86_400_000).toISOString() }
    const html = render({ ...base, status: 'operational', incidents: [old] })
    expect(html).not.toContain('No incidents in the last 7 days')
    expect(html).toContain('Investigating')
    // …and the heading says so. A guard's default is to pass: without this the qualifier can be
    // deleted and the heading goes back to claiming a window its own list no longer obeys.
    expect(html).toContain('+ still open')
  })

  it('explains the green-badge-plus-open-incident state in the header (#1104)', () => {
    // Withholding the "Resolved" label fixed the false claim but left a page that answers
    // "Operational" directly above an Investigating row with nothing reconciling the two — and the AI
    // card cannot do it, since it renders as '' whenever no analysis exists (a brand-new incident, or
    // one whose analysis lost the cron's 15s budget). This is the surface #1104 was filed about, so
    // the explanation cannot depend on the analysis being there.
    const html = renderPage('junie', { ...base, status: 'operational', incidents: [ongoing] } as never, seo, [] as never, null as never)
    expect(html).not.toContain('Post-Incident Analysis')
    expect(html).toContain("are operational, but the provider's incident below is still open")
  })

  it('does not explain a state that is not happening', () => {
    // The control: the note is conditional, not unconditional decoration.
    expect(render({ ...base, status: 'operational', incidents: [done] })).not.toContain('incident below is still open')
    expect(render({ ...base, status: 'degraded', incidents: [ongoing] })).not.toContain('incident below is still open')
  })

  it('withholds the note in the partial state, whose header already answers otherwise', () => {
    // A `partial` header reads "Partial — X has N components affected (operational overall)". A note
    // saying our components are operational would deny the line directly above it — and sub-threshold
    // BetterStack per-model churn makes this state MORE common than the #1104 one the note is for.
    const html = render({ ...base, status: 'operational', partialCount: 2, incidents: [ongoing] })
    expect(html).toContain('components affected')
    expect(html).not.toContain('incident below is still open')
  })

  it('withholds the note when the source is unreadable — we publish no verdict then (#1004)', () => {
    // `asserted`, not raw `status` — and this fixture is what makes that choice load-bearing:
    // `isStatusUnknown` is `sourceDead && !probeConfirmed`, which does not look at `status`, so the raw
    // field still reads 'operational' while the page answers "Unknown". Gating on `service.status`
    // would print "our components are operational" under a header that refuses to say so (#1004).
    const html = render({ ...base, status: 'operational', sourceDead: true, incidents: [ongoing] })
    expect(html).not.toContain('incident below is still open')
  })

  it('lists an out-of-window monitoring incident but does not call it still open (#1104)', () => {
    // Two cuts, on purpose. MEMBERSHIP matches the dashboard (`ServiceDetails` lists any unresolved
    // incident regardless of age) — narrowing it dropped the row here while the dashboard kept it, and
    // this page's own header still cited it as "Last incident … (ongoing)" above "No incidents in the
    // last 7 days". The QUALIFIER uses the live cut, so a `monitoring` row is not called "still open"
    // on a page whose AI card heads that same incident "Post-Incident Analysis".
    const oldMonitoring = { ...ongoing, id: 'i8', status: 'monitoring', startedAt: new Date(Date.now() - 12 * 86_400_000).toISOString() }
    const html = render({ ...base, status: 'operational', incidents: [oldMonitoring, done] })
    expect(html).not.toContain('No incidents in the last 7 days')
    expect(html).toContain('Monitoring')
    expect(html).not.toContain('+ still open')
  })

  it('drops the still-open qualifier on a stale source (#591)', () => {
    // A frozen array's "open" incident is frozen too; claiming it is CURRENTLY open is the false
    // currency the stale branch exists to avoid. The header note above is excluded for the same
    // reason — both are pinned here because they are two separate conditions with one rationale.
    const old = { ...ongoing, id: 'i7', startedAt: new Date(Date.now() - 12 * 86_400_000).toISOString() }
    const html = render({ ...base, status: 'operational', incidentSourceStale: true, incidents: [old] })
    expect(html).toContain('Incident history unavailable')
    expect(html).not.toContain('+ still open')
    // …and the header note is excluded for the SAME reason, not just the heading. It says "the
    // provider's incident below is still open" and there is no row below to point at, so it would be
    // both dangling and a present-tense claim about a frozen array.
    expect(html).not.toContain('incident below is still open')
  })

  it('hasLiveIncident excludes monitoring — the same cut the worker makes for active analyses', () => {
    // "monitoring = recovery confirmed" (worker index.ts). Counting it as live is what would let a
    // sibling hold a genuinely resolved card open.
    expect(hasLiveIncident({ incidents: [done] } as never)).toBe(false)
    expect(hasLiveIncident({ incidents: [{ ...ongoing, status: 'monitoring' }] } as never)).toBe(false)
    expect(hasLiveIncident({ incidents: [ongoing] } as never)).toBe(true)
    expect(hasLiveIncident({ incidents: [] } as never)).toBe(false)
    expect(hasLiveIncident(null)).toBe(false)
  })

  it('a multi-incident card keeps each sub-block self-consistent (#1104)', () => {
    // Card-level "resolved" used to drive the per-block outcome line, so on a mixed card the RESOLVED
    // analysis printed a live "Est. Recovery" directly above its own "✅ Recovered" line.
    const resolvedInsight = { ...insight, incidentTitle: 'A', resolvedAt: new Date().toISOString(), startedAt: new Date(Date.now() - 4e6).toISOString(), estimatedRecoveryHours: 1, firstEstimatedRecoveryHours: 1 }
    const liveInsight = { ...insight, incidentTitle: 'B' }
    // 11th arg = `aiInsights`, the per-incident LIST (#926); the scalar 5th stays the meta/share primary.
    const html = renderPage('junie', { ...base, status: 'operational', incidents: [done, ongoing] } as never, seo, [] as never,
      resolvedInsight as never, null, undefined, null, null, null, [resolvedInsight, liveInsight] as never)
    expect(html).toContain('Predicted vs actual')  // the resolved block scores itself…
    expect(html).toContain('Est. Recovery')        // …while the live one still shows an estimate
  })
})

describe('#1292 — a reconstructed timestamp is not published at minute precision', () => {
  // A status_history-derived incident's `startedAt` is OUR anchor (the status page's local midnight),
  // not a provider-published instant — the invariant every renderer here was built on. Printing it
  // beside the real duration would assert a window the provider's own page contradicts, on the SEO
  // answer surface. Same principle as #713 (invent no uptime) and #1006 (compute, never copy).
  const seo = getSEOContent('helicone')!
  // Dated RELATIVE to now: `renderIncidents` drops a resolved incident older than 7 days, so a
  // fixed-date fixture would render only the header and leave `renderIncidentSingle` — the second
  // changed call site — unexecuted, passing on the header alone.
  const startedAt = new Date(Date.now() - 2 * 86_400_000)
  const resolvedAt = new Date(startedAt.getTime() + 62_280_000)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const dayStr = `${MONTHS[startedAt.getUTCMonth()]} ${startedAt.getUTCDate()}`
  const timeStr = `${dayStr}, ${String(startedAt.getUTCHours()).padStart(2, '0')}:${String(startedAt.getUTCMinutes()).padStart(2, '0')} UTC`

  const base = {
    id: 'helicone', name: 'Helicone', provider: 'Helicone', category: 'api', status: 'operational',
    latency: null, uptime30d: 96.68, lastChecked: new Date().toISOString(),
    incidents: [], aiwatchScore: null, scoreGrade: null,
  }
  const inc = {
    id: 'bs-hist:8603734:day', title: 'eu.api.helicone.ai — recovered', status: 'resolved',
    impact: 'minor', startedAt: startedAt.toISOString(), resolvedAt: resolvedAt.toISOString(),
    duration: '17h 18m', timeline: [],
  }
  const render = (incident: object) => renderPage('helicone', { ...base, incidents: [incident] } as never, seo, [], null)

  it('drops the time of day in BOTH the header and the incident row, and says why', () => {
    const html = render({ ...inc, derived: 'status_history' })
    expect(html).toContain(`Last incident: ${dayStr} &mdash;`)
    expect(html).toContain('start time not published')
    // The per-incident meta line is the second call site; without it the assertion below passes on
    // the header alone. `renderIncidentSingle` runs only because the fixture is inside the 7d window.
    expect(html).toContain('incident-meta')
    expect(html).not.toContain(timeStr)
  })

  it('prints the STATED day, not the day its anchor happens to fall on', () => {
    // Round 9's failure mode, one layer down: the fixture above carries `derived` but no `derivedDay`,
    // so `formatDate`'s derivedDay branch never executes and `dayStr` is exactly what the UNFIXED code
    // printed. Strip derivedDay handling out of formatDate entirely and those assertions still pass.
    // Here the anchor is deliberately on the day BEFORE the stated one — the UTC+13 shape — so the two
    // answers differ and only the right one can satisfy this.
    const anchor = new Date(Date.now() - 2 * 86_400_000)
    const stated = new Date(anchor.getTime() + 86_400_000)
    const statedStr = `${MONTHS[stated.getUTCMonth()]} ${stated.getUTCDate()}`
    const anchorStr = `${MONTHS[anchor.getUTCMonth()]} ${anchor.getUTCDate()}`
    expect(statedStr, 'the fixture must actually straddle a day boundary').not.toBe(anchorStr)

    const html = render({
      ...inc, derived: 'status_history',
      derivedDay: stated.toISOString().slice(0, 10),
      startedAt: anchor.toISOString(),
      resolvedAt: new Date(anchor.getTime() + 62_280_000).toISOString(),
    })
    expect(html).toContain(`Last incident: ${statedStr} &mdash;`)
    expect(html, 'the anchor date must not reach the page').not.toContain(`Last incident: ${anchorStr} &mdash;`)
  })

  it('CONTROL — a provider-published incident keeps its time of day on both, and gains no qualifier', () => {
    const html = render(inc)
    expect(html).toContain(timeStr)
    expect(html).not.toContain('start time not published')
  })

  it('does not publish an average recovery time built from a derived duration', () => {
    // `buildDataSummary` averaged every resolved incident's duration with no guard, so the green
    // "AIWatch Data" block stated a fabricated recovery figure on the SEO answer surface.
    expect(render({ ...inc, derived: 'status_history' })).not.toContain('average recovery time')
    expect(render(inc), 'a real incident still reports one').toContain('average recovery time')
  })
})

// #1328 - the is-down AI card renders the same analysis prose the dashboard modal does, and shares
// its defect: nothing rewrites it at resolution, so a resolved card carried the status sentence
// written while the incident was still being investigated. The card already gates its "Recovered"
// line on `insight.resolvedAt`; the perishable half of the prose now uses the same gate.
describe('is-down AI card summary/progress split (#1328)', () => {
  const seo = getSEOContent('junie')!
  const base = {
    id: 'junie', name: 'Junie', provider: 'JetBrains', category: 'agent',
    latency: null, uptime30d: null, lastChecked: new Date().toISOString(),
    incidents: [], aiwatchScore: null, scoreGrade: null,
  }
  const ongoing = { id: 'i1', title: 'Image generation unavailable', status: 'identified', impact: 'major', startedAt: new Date(Date.now() - 4e6).toISOString(), duration: null }
  const done = { ...ongoing, id: 'i2', status: 'resolved', duration: '1h 6m' }

  const DURABLE = 'Elevated error rates on the Messages API.'
  const PERISHABLE = 'Currently investigating, no improvement yet.'
  const live = {
    summary: DURABLE, progress: PERISHABLE,
    estimatedRecovery: '~1h', affectedScope: ['Messages API'],
    analyzedAt: new Date().toISOString(), needsFallback: true,
    startedAt: ongoing.startedAt,
  }
  const resolved = { ...live, resolvedAt: new Date().toISOString(), estimatedRecoveryHours: 1, firstEstimatedRecoveryHours: 1 }
  const render = (svc: object, insight: object) =>
    renderPage('junie', svc as never, seo, [] as never, insight as never, null, undefined, null, null, null, [insight] as never)

  it('a RESOLVED card drops the progress half and keeps the durable one', () => {
    const html = render({ ...base, status: 'operational', incidents: [done] }, resolved)
    expect(html).toContain(DURABLE)
    expect(html).not.toContain(PERISHABLE)
  })

  it('a LIVE card still shows both halves', () => {
    const html = render({ ...base, status: 'degraded', incidents: [ongoing] }, live)
    expect(html).toContain(DURABLE)
    expect(html).toContain(PERISHABLE)
  })

  it('an analysis written before the split renders unchanged in both states', () => {
    // The legacy shape IS production until the worker redeploys and re-analyses, so this case has to
    // detect its own failure mode — which is a stray SEPARATOR, not a leaked `undefined`: `esc()`
    // returns '' for null, so `undefined` can never reach this HTML and asserting its absence would
    // be a dead assertion. Expressed markup-tolerantly so a `<span>` around the summary does not
    // turn it red.
    // Scoped to the CARD paragraph, not the page: the summary also appears in the meta/share text,
    // where a following space is normal — `not.toContain(DURABLE + ' ')` fails on the healthy page.
    // `DURABLE + '</p>'` says the paragraph ends immediately after the summary, which is exactly the
    // stray-separator defect. (`undefined` is unassertable here: `esc()` returns '' for null.)
    const legacyLive = { ...live, progress: undefined }
    expect(render({ ...base, status: 'degraded', incidents: [ongoing] }, legacyLive)).toContain(DURABLE + '</p>')
    const legacyDone = { ...resolved, progress: undefined }
    expect(render({ ...base, status: 'operational', incidents: [done] }, legacyDone)).toContain(DURABLE + '</p>')
  })
})

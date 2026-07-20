import { describe, it, expect } from 'vitest'
import { renderDelegatedListeners, buildMetaDescription, renderPage, exceededRecoveryTextEn, FAR_EXCEEDED_FACTOR as EDGE_FAR_EXCEEDED_FACTOR } from '../_is-down/html-template'
import { FAR_EXCEEDED_FACTOR as FRONTEND_FAR_EXCEEDED_FACTOR } from '../../src/utils/predictionAccuracy'
import { getSEOContent } from '../_is-down/seo-content'

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

  it('reduces the referrer to a bare HOSTNAME before sending it (#1055 contract)', () => {
    // classifyReferrer's host patterns are all `$`-anchored, so they only work on a bare hostname.
    // If this ever sent `document.referrer` raw, EVERY host bucket (reddit/hn/search/x/owned) would
    // silently fall through to `refhost`: reddit/hn pinned at zero, refhost absorbing everything,
    // and the daily Outage Audience line looking perfectly plausible throughout — re-introducing the
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

describe('buildMetaDescription — recovery estimate exceeded (Mistral 2–4h on a days-long incident)', () => {
  const seo = getSEOContent('claude')!
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

  it('a probe-corroborated outage still publishes the outage everywhere', () => {
    const html = render({ ...base, status: 'degraded', sourceUnknown: true, probeContradicted: true })
    expect(html).toContain('Having Issues')                          // <title>
    expect(html).toContain('is having issues right now')             // CTA
    expect(html).toContain('status=degraded')                        // og:image
    expect(html).not.toContain('Status Unknown')
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

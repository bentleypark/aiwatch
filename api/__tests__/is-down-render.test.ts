import { describe, it, expect } from 'vitest'
import { renderDelegatedListeners, buildMetaDescription, exceededRecoveryTextEn } from '../_is-down/html-template'
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
})

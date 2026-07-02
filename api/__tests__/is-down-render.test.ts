import { describe, it, expect } from 'vitest'
import { renderDelegatedListeners } from '../_is-down/html-template'

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

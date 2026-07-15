// #936 — the extension tags its outbound site links with utm_source=extension (it can't import the
// worker's appendUtm, so it has its own tiny helper). Pin the format + the ?/& separator logic.
import { describe, it, expect } from 'vitest'
import { withExtUtm, SITE_BASE } from './config.js'

describe('withExtUtm (#936)', () => {
  it('appends utm_source=extension&utm_medium=referral to a clean is-down deep link', () => {
    expect(withExtUtm(`${SITE_BASE}/is-claude-down`)).toBe(
      'https://ai-watch.dev/is-claude-down?utm_source=extension&utm_medium=referral',
    )
  })

  it('tags the bare dashboard root', () => {
    expect(withExtUtm(SITE_BASE)).toBe('https://ai-watch.dev?utm_source=extension&utm_medium=referral')
  })

  it('uses & when the URL already carries a query', () => {
    expect(withExtUtm('https://ai-watch.dev/is-openai-down?e=down')).toBe(
      'https://ai-watch.dev/is-openai-down?e=down&utm_source=extension&utm_medium=referral',
    )
  })
})

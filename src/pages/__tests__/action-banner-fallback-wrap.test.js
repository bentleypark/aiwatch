import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The banner header renders RssCopyIcon, which calls useLang() and needs a
// LangProvider context we don't set up here. Stub it — it's irrelevant to the
// fallback-line structure under test.
vi.mock('../../components/RssCopyIcon', () => ({ default: () => null }))

// #903 — the mobile ActionBanner "Suggested fallback" line clipped the trailing
// "Open ↗" pill on narrow widths because the inter-item separator ", " was rendered
// INSIDE each item's `white-space:nowrap` span, gluing two alternatives onto one
// line with no break opportunity. The fix moves ", " OUTSIDE the nowrap span so a
// line break can occur BETWEEN alternatives while the name+pill stay glued.
//
// We render to a static SSR string (renderToStaticMarkup) — no layout engine is
// involved, so we can't assert pixel overflow here. Instead we pin the DOM STRUCTURE
// that causes/cures it: the comma must be a sibling text node of the nowrap span,
// never its first child. (The pixel behavior itself was verified manually in-browser
// at mobile width: old structure → single row + pill overflows; fixed → wraps to a
// second row, no overflow.)
const { ActionBanner } = await import('../Overview')

const t = (k) => k // identity — assert structure, not localized copy

// One degraded LLM service + two operational same-tier LLM alternatives → a single
// fallback category with TWO items, i.e. the ", "-separated shape from the bug.
const services = [
  { id: 'mistral', name: 'Mistral API', category: 'api', status: 'degraded', incidents: [], aiwatchScore: 69 },
  { id: 'cohere', name: 'Cohere API', category: 'api', status: 'operational', incidents: [], aiwatchScore: 90 },
  { id: 'cerebras', name: 'Cerebras Inference', category: 'api', status: 'operational', incidents: [], aiwatchScore: 89 },
]

const render = () => renderToStaticMarkup(createElement(ActionBanner, { services, setPage: () => {}, t }))

describe('#903 — ActionBanner fallback line wraps between alternatives', () => {
  it('renders both same-category alternatives', () => {
    const html = render()
    expect(html).toContain('Cohere API')
    expect(html).toContain('Cerebras Inference')
  })

  it('places the ", " separator OUTSIDE the nowrap span (break opportunity between items)', () => {
    const html = render()
    // OLD bug shape: comma is the first thing inside a nowrap span. Must NOT appear.
    expect(html).not.toMatch(/white-space:nowrap">\s*,/)
    // FIXED shape: a nowrap item span closes, then ", ", then the next nowrap item span opens.
    expect(html).toMatch(/<\/span>,\s*<span style="white-space:nowrap"/)
  })

  it('keeps each item name+pill together inside a nowrap span (intra-item no-wrap preserved)', () => {
    const html = render()
    // At least two nowrap item spans (one per alternative).
    const nowrapSpans = html.match(/<span style="white-space:nowrap"/g) || []
    expect(nowrapSpans.length).toBeGreaterThanOrEqual(2)
  })

  it('renders the trailing "Open ↗" pill for each alternative (the element #903 clipped)', () => {
    const html = render()
    // The whole point of #903 is that the trailing outbound pill overflowed — assert it
    // actually renders (both alternatives have an outbound URL), so a future change that
    // dropped the pill can't leave the structural assertions passing on a gutted feature.
    const pills = html.match(/rel="nofollow noopener noreferrer"/g) || []
    expect(pills.length).toBe(2)
  })
})

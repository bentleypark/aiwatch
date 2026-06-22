import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// useLang reads context; stub it so t(key) === key — lets us assert which label key
// the pill rendered without a provider. (No RTL in this project; SSR render is enough.)
vi.mock('../../hooks/useLang', () => ({ useLang: () => ({ t: (k) => k }) }))

const { default: StatusPill } = await import('../StatusPill')

const render = (props) => renderToStaticMarkup(createElement(StatusPill, props))

// #722/#744 — the JSX render of the intermediate "Partial" pill. The decision
// (resolveStatusDisplay) is unit-tested separately; this pins the component wiring:
// the label key, the yellow class, and the SINGLE merged chip (⚠ Partial · N).
describe('StatusPill render (#722/#744 partial)', () => {
  it('renders a SINGLE yellow Partial pill with the count folded in (⚠ Partial · N) when operational + partialCount>0', () => {
    const html = render({ status: 'operational', partialCount: 3 })
    expect(html).toContain('status.partial')          // pill label key
    expect(html).toContain('status-bg-yellow')        // yellow state, not green
    expect(html).toContain('⚠')                       // warning glyph in the pill
    expect(html).toContain('· 3')                      // count folded into the pill
    expect(html).not.toContain('status.partial.suffix') // the old separate count chip is gone
    expect(html).not.toContain('status-bg-green')
    // single chip — the yellow class appears exactly once (was twice: pill + count chip)
    expect((html.match(/status-bg-yellow/g) || []).length).toBe(1)
  })

  it('renders a bare green Operational pill (no chip) when nothing is affected', () => {
    const html = render({ status: 'operational', partialCount: 0 })
    expect(html).toContain('status.operational')
    expect(html).toContain('status-bg-green')
    expect(html).not.toContain('⚠')
    expect(html).not.toContain('status.partial')
  })

  it('renders the real status (no partial promotion) for degraded/down', () => {
    expect(render({ status: 'degraded', partialCount: 5 })).toContain('status.degraded')
    expect(render({ status: 'degraded', partialCount: 5 })).not.toContain('⚠')
    expect(render({ status: 'down', partialCount: 5 })).toContain('status.down')
  })

  it('renders a neutral Unknown pill (no partial chip) when sourceDead', () => {
    const html = render({ status: 'operational', partialCount: 2, sourceDead: true })
    expect(html).toContain('status.unknown')
    expect(html).not.toContain('⚠')
    expect(html).not.toContain('status.partial')
  })
})

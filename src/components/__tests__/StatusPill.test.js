import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// useLang reads context; stub it so t(key) === key — lets us assert which label key
// the pill rendered without a provider. (No RTL in this project; SSR render is enough.)
vi.mock('../../hooks/useLang', () => ({ useLang: () => ({ t: (k) => k }) }))

const { default: StatusPill } = await import('../StatusPill')

const render = (props) => renderToStaticMarkup(createElement(StatusPill, props))

// #722 — the JSX render of the intermediate "Partial" pill + "⚠ N affected" chip.
// The decision (resolveStatusDisplay) is unit-tested separately; this pins the
// component wiring: which label key, the yellow class, and the count chip.
describe('StatusPill render (#722 partial)', () => {
  it('renders a yellow Partial pill + count chip when operational with partialCount>0', () => {
    const html = render({ status: 'operational', partialCount: 3 })
    expect(html).toContain('status.partial')          // pill label key
    expect(html).toContain('status-bg-yellow')        // yellow state, not green
    expect(html).toContain('⚠ 3')                     // affected-count chip
    expect(html).toContain('status.partial.suffix')   // chip suffix key
    expect(html).not.toContain('status-bg-green')
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

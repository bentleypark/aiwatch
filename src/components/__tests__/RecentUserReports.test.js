import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../hooks/useLang', () => ({ useLang: () => ({ t: (k) => k }) }))

const { default: RecentUserReports } = await import('../RecentUserReports')

const render = (items) => renderToStaticMarkup(createElement(RecentUserReports, { items }))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RecentUserReports time labels', () => {
  it('keeps sub-hour reports in minutes instead of rounding them up to an hour', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const html = render([
      { cat: 'errors', desc: 'Spiking', ts: 1_000_000 - 35 * 60_000 },
    ])

    expect(html).toContain('35m ago')
    expect(html).not.toContain('1h ago')
  })

  it('floors hour labels', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const html = render([
      { cat: 'errors', desc: 'Spiking', ts: 1_000_000 - 90 * 60_000 },
    ])

    expect(html).toContain('1h ago')
    expect(html).not.toContain('2h ago')
  })
})

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// #1328 — nothing rewrites the analysis prose at resolution: `markIncidentResolved` stamps
// `resolvedAt` on the stored value and returns, so the summary a resolved row shows is the one
// written while the incident was `investigating`. Observed in production: a row carrying the
// `Resolved` pill and `✅ Recovered: 8m ago` whose body read "The situation is currently in the
// initial investigation stage with no improvement reported yet."
//
// The fix splits the model's answer: `summary` (durable — what was wrong) and `progress`
// (perishable — where it stood). Only the perishable half is dropped once resolved, so the row keeps
// the one thing the structured lines below it cannot say: what the outage was about.
//
// Pins the CALL SITE, not a helper: the defect is a surface that renders the wrong half.

vi.mock('../../hooks/useLang', () => ({ useLang: () => ({ t: (k) => k, lang: 'en' }) }))

const DURABLE = 'Elevated error rates on the Messages API.'
const PERISHABLE = 'Currently in the initial investigation stage with no improvement reported yet.'

const analysis = (over = {}) => ({
  summary: DURABLE,
  progress: PERISHABLE,
  estimatedRecovery: '30m-1h', estimatedRecoveryHours: 1, affectedScope: ['Messages API'],
  analyzedAt: new Date().toISOString(), incidentId: 'inc-1', ...over,
})
const service = (over = {}) => ({
  id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api',
  status: 'operational', latency: 130, uptime30d: 99.7, incidents: [], ...over,
})
const CLOSED = { id: 'inc-1', title: 'Elevated errors', status: 'resolved', startedAt: new Date(Date.now() - 4e6).toISOString(), duration: '39m' }
const LIVE = { id: 'inc-1', title: 'Elevated errors', status: 'identified', startedAt: new Date(Date.now() - 4e6).toISOString() }

const { default: AnalysisModal } = await import('../AnalysisModal')
const render = (services, aiAnalysis) =>
  renderToStaticMarkup(createElement(AnalysisModal, { aiAnalysis, services, onClose: () => {} }))

describe('AnalysisModal progress/summary split (#1328)', () => {
  it('a RESOLVED row drops the progress half and keeps the durable one', () => {
    const resolved = analysis({ resolvedAt: new Date().toISOString(), startedAt: CLOSED.startedAt })
    const html = render([service({ incidents: [CLOSED] })], { claude: [resolved] })
    expect(html).toContain(DURABLE)          // "what was this outage about" survives
    expect(html).not.toContain(PERISHABLE)   // the sentence that contradicted the Resolved pill
  })

  it('an UNRESOLVED row still shows both halves — the reading experience is unchanged', () => {
    const html = render([service({ status: 'degraded', incidents: [LIVE] })], { claude: [analysis()] })
    expect(html).toContain(DURABLE)
    expect(html).toContain(PERISHABLE)
  })

  it('caps the PAIR at 500 chars, not each half', () => {
    // The row used to render one field; it now renders two. Slicing them separately would quietly
    // double what a live row can print. Fixture picked so the bound is read off the OUTPUT: 400 + 1
    // space + 400 truncates to 400 A's, a space and 99 B's, so `B*100` appearing means the cap was
    // applied per-half (or dropped) rather than to the joined pair.
    const long = analysis({ summary: 'A'.repeat(400), progress: 'B'.repeat(400) })
    const html = render([service({ status: 'degraded', incidents: [LIVE] })], { claude: [long] })
    expect(html).toContain('B'.repeat(99))
    expect(html).not.toContain('B'.repeat(100))
  })

  it('an analysis written before the split renders exactly as it did', () => {
    // Every stored analysis is `progress`-less until the worker redeploys and re-analyses, so this
    // is the state production is in on the day this ships — in BOTH incident states.
    //
    // The legacy failure is a stray SEPARATOR after the summary, not a missing summary — measured,
    // not assumed: dropping the truthiness guard renders `…Messages API. ` on the live path and
    // `…Messages API. false` on the resolved one (`false && undefined` stringifies). `toContain`
    // passes through both. Asserting the absence of a trailing separator catches them without
    // pinning markup or styling — an earlier version selected on `line-height:1.6` and turned red
    // on a CSS tweak.
    const legacy = { ...analysis(), progress: undefined }
    const live = render([service({ status: 'degraded', incidents: [LIVE] })], { claude: [legacy] })
    expect(live).toContain(DURABLE)
    expect(live).not.toContain(DURABLE + ' ')
    const done = render(
      [service({ incidents: [CLOSED] })],
      { claude: [{ ...legacy, resolvedAt: new Date().toISOString(), startedAt: CLOSED.startedAt }] },
    )
    expect(done).toContain(DURABLE)
    expect(done).not.toContain(DURABLE + ' ')
  })
})

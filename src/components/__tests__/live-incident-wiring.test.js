import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// #1104 — the DECISION (`readsResolved` / `showRecoveredChip`) is unit-tested in `liveIncident.test.js`.
// This file pins the CALL SITES, because a green pure function is not a green call site
// (`feedback_mutation_test_both_directions`) and this change's failure mode is precisely a surface
// that forgot to ask.
//
// Every fixture here is chosen to DISCRIMINATE — each one flips if its fix is reverted. That is not
// automatic: the first version of this file used a live incident whose analysis had no `resolvedAt`,
// where the OLD expression `allRecovered || (isAllResolved && !hasActiveInc)` already evaluated false,
// so all three assertions passed against the unfixed code. The state that actually regressed is the
// one below: every analysis carries `resolvedAt` WHILE an incident is still live — which is ordinary,
// since /api/status/cached fills its recovered-analysis branch whenever the ACTIVE branch produced
// nothing, not when nothing is active.

vi.mock('../../hooks/useLang', () => ({ useLang: () => ({ t: (k) => k, lang: 'en' }) }))

const LIVE = { id: 'inc-live', title: 'Image generation unavailable', status: 'identified', startedAt: new Date().toISOString() }
const CLOSED = { id: 'inc-done', title: 'Elevated errors', status: 'resolved', startedAt: new Date().toISOString(), duration: '42m' }

const analysis = (over = {}) => ({
  summary: 'Image generation requests are failing for a subset of users.',
  estimatedRecovery: '1-2h', estimatedRecoveryHours: 2, affectedScope: ['Images'],
  analyzedAt: new Date().toISOString(), incidentId: 'inc-done', ...over,
})
const service = (over = {}) => ({
  id: 'openai', name: 'OpenAI API', provider: 'OpenAI', category: 'api',
  status: 'operational', latency: 130, uptime30d: 99.7, incidents: [], ...over,
})
const RESOLVED_ANALYSIS = analysis({ resolvedAt: new Date().toISOString(), startedAt: new Date(Date.now() - 4e6).toISOString() })

const { default: AnalysisModal } = await import('../AnalysisModal')
const renderModal = (services, aiAnalysis) =>
  renderToStaticMarkup(createElement(AnalysisModal, { aiAnalysis, services, onClose: () => {} }))

describe('AnalysisModal "Resolved" pill wiring (#1104)', () => {
  it('withholds the pill when every analysis is resolved but an incident is still live', () => {
    // THE discriminating case. Old expression: `allRecovered` is true → pill renders over a live
    // incident. New: `readsResolved(svcs)` asks the SERVICE, so it does not.
    const html = renderModal([service({ incidents: [LIVE, CLOSED] })], { openai: [RESOLVED_ANALYSIS] })
    expect(html).not.toContain('>Resolved<')
    // …and the reader is told why, rather than being left with an unexplained card. This half is
    // discriminating too: the pre-#1104 `isolatedModelIssue` required `!allRecovered`, which is false here.
    expect(html).toContain('Isolated issue')
  })

  it('still renders the pill when the service is operational and nothing is open', () => {
    // The control — without it the assertion above would also pass on a component that never renders
    // the pill at all.
    const html = renderModal([service({ incidents: [CLOSED] })], { openai: [RESOLVED_ANALYSIS] })
    expect(html).toContain('>Resolved<')
    expect(html).not.toContain('Isolated issue')
  })

  it('withholds the pill for a live incident that has no analysis of its own', () => {
    // The modal draws from `aiAnalysis` alone, so this incident has no row here — the badge is the
    // only thing that would have spoken for it, and the badge is green.
    const html = renderModal([service({ incidents: [LIVE, CLOSED] })], { openai: [analysis()] })
    expect(html).not.toContain('>Resolved<')
  })
})

// The Overview page reads everything from four hooks and takes no props, so the whole page renders
// server-side with those stubbed. Rendering the PAGE (not the card) is what makes this a wiring test:
// reverting `showRecoveredChip(recentlyRecovered, svc)` to `!!recentlyRecovered[svc.id]` turns the
// first assertion red. Passing the boolean straight into ServiceCard, as an earlier version did, pins
// only the chip markup and leaves the call site free to regress.
//
// KNOWN GAP: the ServiceDetails header chip is the same one-line call and is NOT rendered here — that
// page pulls charts and ~20 hooks, so the render would be mostly mock. It routes through the same
// `showRecoveredChip`, so the two cannot decide differently; what is unpinned is whether it still
// calls it. Stated rather than implied.
const overviewHarness = (services, recentlyRecovered) => {
  vi.doMock('../../hooks/usePolling', () => ({
    usePolling: () => ({
      services, recentlyRecovered, aiAnalysis: {}, loading: false, error: null,
      lastUpdated: new Date().toISOString(), refresh: () => {}, probeServiceIds: [],
      reportFeed: [], supplyChainBanner: null,
    }),
  }))
  vi.doMock('../../hooks/useSettings', () => ({ useSettings: () => ({ settings: { enabledServices: services.map((s) => s.id) } }) }))
  vi.doMock('../../utils/pageContext', () => ({ usePage: () => ({ page: 'overview', setPage: () => {} }) }))
  vi.doMock('../../utils/analytics', () => ({ trackEvent: () => {} }))
}

describe('Overview "Recently Resolved" chip wiring (#1104)', () => {
  const svc = (over = {}) => service({ ...over })

  it('withholds the chip when the service still carries a live incident', async () => {
    vi.resetModules()
    overviewHarness([svc({ incidents: [LIVE, CLOSED] })], { openai: ['inc-done'] })
    const { default: Overview } = await import('../../pages/Overview')
    const html = renderToStaticMarkup(createElement(Overview))
    expect(html).not.toContain('overview.recovered')
  })

  it('renders the chip when the marker points at the only, resolved incident', async () => {
    vi.resetModules()
    overviewHarness([svc({ incidents: [CLOSED] })], { openai: ['inc-done'] })
    const { default: Overview } = await import('../../pages/Overview')
    const html = renderToStaticMarkup(createElement(Overview))
    expect(html).toContain('overview.recovered')
  })
})

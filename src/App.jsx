import { useState, useEffect, useCallback, lazy, Suspense, Component } from 'react'
import { useTheme } from './hooks/useTheme'
import { useLang, LangProvider } from './hooks/useLang'
import { initConsentDefault, initGA, trackPageView, trackEvent } from './utils/analytics'
import { PageContext } from './utils/pageContext'
import { PollingProvider } from './hooks/usePolling'
import { useSettings } from './hooks/useSettings'
import Layout from './components/Layout'
import Topbar from './components/Topbar'
import TickerBar from './components/TickerBar'
import Sidebar from './components/Sidebar'
import Modal from './components/Modal'
import CookieBanner from './components/CookieBanner'
import InstallBanner from './components/InstallBanner'
import { PrivacyContent, TermsContent } from './components/LegalContent'
import Overview from './pages/Overview'

function lazyWithRetry(importFn) {
  return lazy(() =>
    importFn().catch(() =>
      new Promise((resolve) => setTimeout(resolve, 1500)).then(importFn)
    )
  )
}

const Latency = lazyWithRetry(() => import('./pages/Latency'))
const Incidents = lazyWithRetry(() => import('./pages/Incidents'))
const Uptime = lazyWithRetry(() => import('./pages/Uptime'))
const ServiceDetails = lazyWithRetry(() => import('./pages/ServiceDetails'))
const Settings = lazyWithRetry(() => import('./pages/Settings'))
const AboutScore = lazyWithRetry(() => import('./pages/AboutScore'))
const Ranking = lazyWithRetry(() => import('./pages/Ranking'))

class ChunkErrorBoundary extends Component {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          <p className="text-[var(--text1)]" style={{ marginBottom: '1rem' }}>
            Failed to load this page.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mono text-[12px] text-[var(--text0)] bg-[var(--bg3)] border border-[var(--border)] rounded-md hover:bg-[var(--bg4)] transition-colors cursor-pointer"
            style={{ padding: '6px 16px' }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

import { ALL_SERVICE_IDS } from './utils/constants'
import { initVitals } from './utils/vitals'

const PAGE_NAMES = ['overview', 'latency', 'incidents', 'uptime', 'settings', 'about-score', 'ranking']

function hashToPage(hash) {
  const id = hash.replace(/^#/, '').split(/[?&#]/)[0]
  if (!id) return { name: 'overview' }
  if (PAGE_NAMES.includes(id)) return { name: id }
  if (ALL_SERVICE_IDS.includes(id)) return { name: 'service', serviceId: id }
  // Invalid hash — clean up URL and fallback to overview
  window.history.replaceState(null, '', window.location.pathname)
  return { name: 'overview' }
}

function pageToHash(page) {
  if (page.name === 'service') return `#${page.serviceId}`
  if (page.name === 'overview') return ''
  return `#${page.name}`
}

function resolvePage(page) {
  switch (page.name) {
    case 'overview':  return <Overview />
    case 'latency':   return <Latency />
    case 'incidents': return <Incidents />
    case 'uptime':    return <Uptime />
    case 'service':   return <ServiceDetails serviceId={page.serviceId} />
    case 'settings':  return <Settings />
    case 'about-score': return <AboutScore />
    case 'ranking':     return <Ranking />
    default:          return <Overview />
  }
}

export default function App() {
  return (
    <LangProvider>
      <AppInner />
    </LangProvider>
  )
}

function AppInner() {
  const [page, setPageState] = useState(() => hashToPage(window.location.hash))
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [modal, setModal] = useState(null) // null | 'privacy' | 'terms'
  const [categoryFilter, setCategoryFilter] = useState('all')
  useTheme()
  const { t } = useLang()
  const { settings } = useSettings()

  // Sync page → hash
  const setPage = useCallback((p) => {
    setPageState(p)
    const hash = pageToHash(p)
    const currentHash = window.location.hash === '#' ? '' : window.location.hash
    if (currentHash !== hash) {
      window.history.pushState(null, '', hash || window.location.pathname)
    }
  }, [])

  // Sync hash → page (browser back/forward)
  useEffect(() => {
    const onPopState = () => setPageState(hashToPage(window.location.hash))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Initialize GA4 once on mount
  useEffect(() => { initConsentDefault(); initGA(); initVitals() }, [])

  // Track page views + scroll to top on SPA navigation
  useEffect(() => {
    window.scrollTo(0, 0)
    trackPageView(page.name, page.serviceId ? { service_id: page.serviceId } : {})
  }, [page])

  const tickerBar = <TickerBar />
  const sidebar = <Sidebar visibleServiceIds={settings.enabledServices} onNavigate={() => setSidebarOpen(false)} />
  const footer = (
    <div>
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 mono text-[var(--text0)]" style={{ fontSize: '13px', fontWeight: 600, letterSpacing: '-0.3px' }}>
            <img src="/favicon.png" alt="" width={18} height={18} style={{ borderRadius: 3 }} />
            AI<span className="text-[var(--green)]">Watch</span>
          </span>
          <span className="hidden md:inline mono text-[10px] text-[var(--text2)]">
            {t('footer.copyright')}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => { setModal('privacy'); trackEvent('open_legal', { type: 'privacy' }) }}
            className="mono text-[11px] text-[var(--text2)] hover:text-[var(--text0)] transition-colors cursor-pointer"
            style={{ background: 'none', border: 'none' }}
          >
            {t('footer.privacy')}
          </button>
          <span className="text-[11px] text-[var(--text2)] opacity-40">·</span>
          <button
            onClick={() => { setModal('terms'); trackEvent('open_legal', { type: 'terms' }) }}
            className="mono text-[11px] text-[var(--text2)] hover:text-[var(--text0)] transition-colors cursor-pointer"
            style={{ background: 'none', border: 'none' }}
          >
            {t('footer.terms')}
          </button>
          <span className="text-[11px] text-[var(--text2)] opacity-40">·</span>
          <a
            href="mailto:contact@ai-watch.dev"
            className="mono text-[11px] text-[var(--text2)] hover:text-[var(--text0)] transition-colors"
          >
            contact@ai-watch.dev
          </a>
        </div>
      </div>
    </div>
  )

  return (
    <PollingProvider>
    <PageContext.Provider value={{ page, setPage, categoryFilter, setCategoryFilter }}>
      <Layout
        topbar={<Topbar onMenuToggle={() => setSidebarOpen((o) => !o)} />}

        tickerBar={tickerBar}
        sidebar={sidebar}
        footer={footer}
        sidebarOpen={sidebarOpen}
        onSidebarClose={() => setSidebarOpen(false)}
      >
        <ChunkErrorBoundary>
          <Suspense fallback={<div style={{ padding: '2rem', textAlign: 'center' }}><span className="text-[var(--text2)] mono text-[12px]">Loading…</span></div>}>
            {resolvePage(page)}
          </Suspense>
        </ChunkErrorBoundary>
      </Layout>

      {/* Legal modals */}
      <Modal
        isOpen={modal === 'privacy'}
        onClose={() => setModal(null)}
        title={t('footer.privacy')}
      >
        <PrivacyContent />
      </Modal>

      <Modal
        isOpen={modal === 'terms'}
        onClose={() => setModal(null)}
        title={t('footer.terms')}
      >
        <TermsContent />
      </Modal>

      <CookieBanner />
      <InstallBanner />
    </PageContext.Provider>
    </PollingProvider>
  )
}

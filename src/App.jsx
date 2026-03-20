import { useState, useEffect } from 'react'
import { useTheme } from './hooks/useTheme'
import { useLang, LangProvider } from './hooks/useLang'
import { initGA, trackPageView, trackEvent } from './utils/analytics'
import { PageContext } from './utils/pageContext'
import { PollingProvider } from './hooks/usePolling'
import Layout from './components/Layout'
import Topbar, { MobileActionBar } from './components/Topbar'
import TickerBar from './components/TickerBar'
import Sidebar from './components/Sidebar'
import Modal from './components/Modal'
import { PrivacyContent, TermsContent } from './components/LegalContent'
import Overview from './pages/Overview'
import Latency from './pages/Latency'
import Incidents from './pages/Incidents'
import Uptime from './pages/Uptime'
import ServiceDetails from './pages/ServiceDetails'
import Settings from './pages/Settings'

const DEFAULT_PAGE = { name: 'overview' }

function resolvePage(page) {
  switch (page.name) {
    case 'overview':  return <Overview />
    case 'latency':   return <Latency />
    case 'incidents': return <Incidents />
    case 'uptime':    return <Uptime />
    case 'service':   return <ServiceDetails serviceId={page.serviceId} />
    case 'settings':  return <Settings />
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
  const [page, setPage] = useState(DEFAULT_PAGE)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [modal, setModal] = useState(null) // null | 'privacy' | 'terms'
  useTheme()
  const { t } = useLang()

  // Initialize GA4 once on mount
  useEffect(() => { initGA() }, [])

  // Track page views on SPA navigation
  useEffect(() => {
    trackPageView(page.name, page.serviceId ? { service_id: page.serviceId } : {})
  }, [page])

  const tickerBar = <TickerBar />
  const sidebar = <Sidebar onNavigate={() => setSidebarOpen(false)} />
  const footer = (
    <div>
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="mono text-[var(--text0)]" style={{ fontSize: '13px', fontWeight: 600, letterSpacing: '-0.3px' }}>
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
    <PageContext.Provider value={{ page, setPage }}>
      <Layout
        topbar={<Topbar onMenuToggle={() => setSidebarOpen((o) => !o)} />}
        mobileActionBar={<MobileActionBar />}
        tickerBar={tickerBar}
        sidebar={sidebar}
        footer={footer}
        sidebarOpen={sidebarOpen}
        onSidebarClose={() => setSidebarOpen(false)}
      >
        {resolvePage(page)}
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
    </PageContext.Provider>
    </PollingProvider>
  )
}

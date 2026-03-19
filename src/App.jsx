import { useState } from 'react'
import { useTheme } from './hooks/useTheme'
import { useLang } from './hooks/useLang'
import { PageContext } from './utils/pageContext'
import Layout from './components/Layout'
import Topbar, { MobileActionBar } from './components/Topbar'
import TickerBar from './components/TickerBar'
import Sidebar from './components/Sidebar'
import Overview from './pages/Overview'
import Latency from './pages/Latency'
import Incidents from './pages/Incidents'
import Uptime from './pages/Uptime'
import ServiceDetails from './pages/ServiceDetails'
import Settings from './pages/Settings'

// currentPage shape: { name: 'overview'|'latency'|'incidents'|'uptime'|'service'|'settings', serviceId?: string }
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
  const [page, setPage] = useState(DEFAULT_PAGE)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  useTheme()
  const { t } = useLang()

  const tickerBar = <TickerBar />
  const sidebar = <Sidebar />
  const footer = (
    <div className="px-4 md:px-6 py-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="mono font-semibold text-sm">
            <span className="text-[var(--text0)]">AI</span>
            <span className="text-[var(--green)]">Watch</span>
          </span>
          <span className="hidden md:inline mono text-[10px] text-[var(--text2)]">
            {t('footer.copyright')}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Privacy/Terms modals pending — Issue #19 */}
          <span className="mono text-[11px] text-[var(--text2)] cursor-default">
            {t('footer.privacy')}
          </span>
          <span className="text-[11px] text-[var(--text2)] opacity-40">|</span>
          <span className="mono text-[11px] text-[var(--text2)] cursor-default">
            {t('footer.terms')}
          </span>
          <span className="text-[11px] text-[var(--text2)] opacity-40">|</span>
          <a
            href="mailto:contact@aiwatch.dev"
            className="mono text-[11px] text-[var(--text2)] hover:text-[var(--text0)] transition-colors"
          >
            contact@aiwatch.dev
          </a>
        </div>
      </div>
    </div>
  )

  return (
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
    </PageContext.Provider>
  )
}

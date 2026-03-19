import { useState } from 'react'
import { useTheme } from './hooks/useTheme'
import { useLang } from './hooks/useLang'
import { PageContext } from './utils/pageContext'
import Layout from './components/Layout'
import Topbar from './components/Topbar'
import TickerBar from './components/TickerBar'
import Overview from './pages/Overview'
import Latency from './pages/Latency'
import Incidents from './pages/Incidents'
import Uptime from './pages/Uptime'
import ServiceDetails from './pages/ServiceDetails'
import Settings from './pages/Settings'

// currentPage shape: { name: string, serviceId?: string }
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

  // Sidebar (#7) and Footer (#19) pending
  const tickerBar = <TickerBar />
  const sidebar = (
    <nav className="p-4 mono text-xs text-[var(--text2)]">sidebar placeholder</nav>
  )
  const footer = (
    <div className="px-6 py-3 mono text-xs text-[var(--text2)]">
      {t('footer.copyright')}
    </div>
  )

  return (
    <PageContext.Provider value={{ page, setPage }}>
      <Layout
        topbar={<Topbar onMenuToggle={() => setSidebarOpen((o) => !o)} />}
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

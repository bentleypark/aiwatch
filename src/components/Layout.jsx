// Layout shell — owns structural grid only.
// Desktop: Topbar(48px) + Ticker(34px) = 82px fixed header, then Grid (220px sidebar + 1fr content).
// Mobile: Topbar(48px) + ActionBar(~36px) = ~84px, sidebar as overlay.
// NOTE: Tailwind v4 cannot scan template literals with variables — use hardcoded class strings.

export const TOPBAR_H = 48
export const TICKER_H = 34
export const HEADER_H = TOPBAR_H + TICKER_H // 82px
export const SIDEBAR_W = 220

export default function Layout({
  children,
  topbar,
  tickerBar,
  sidebar,
  footer,
  mobileActionBar,
  sidebarOpen = false,
  onSidebarClose,
}) {
  return (
    <div className="min-h-screen bg-[var(--bg0)]">
      {/* Topbar — fixed full width, 48px */}
      <header
        className="fixed inset-x-0 top-0 z-[60] h-[48px] flex items-center
                   bg-[var(--bg1)] border-b border-[var(--border)]"
      >
        {topbar}
      </header>

      {/* Ticker Bar — fixed full width, 34px, below Topbar. Hidden on mobile. */}
      <div
        className="fixed inset-x-0 top-[48px] h-[34px] z-[50] hidden md:flex items-center
                   bg-[var(--bg2)] border-b border-[var(--border)]"
      >
        {tickerBar}
      </div>

      {/* Mobile Action Bar — below topbar on mobile only */}
      <div className="fixed inset-x-0 top-[48px] z-[55] md:hidden">
        {mobileActionBar}
      </div>

      {/* Body — .header-offset: mobile 84px, desktop 82px (see index.css) */}
      <div className="header-offset">
        <div className="md:grid" style={{ gridTemplateColumns: '220px 1fr' }}>

          {/* Desktop sidebar — sticky, z-[51] above ticker bar so buttons are clickable */}
          <aside
            className="hidden md:block sticky top-[82px] h-[calc(100vh-82px)] z-[51]
                       overflow-y-auto overflow-x-hidden
                       bg-[var(--bg1)] border-r border-[var(--border)]"
          >
            {sidebar}
          </aside>

          {/* Content + Footer */}
          <div className="flex flex-col min-h-[calc(100vh-82px)]">
            <main className="flex-1" style={{ paddingTop: '20px' }}>
              {children}
            </main>
            <footer className="bg-[var(--bg1)] border-t border-[var(--border)]">
              {footer}
            </footer>
          </div>
        </div>
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <>
          <div
            className="fixed inset-0 z-[70] bg-black/50 md:hidden"
            onClick={onSidebarClose}
            aria-hidden="true"
          />
          <aside
            className="fixed left-0 top-0 z-[80] h-full w-[220px] pt-[48px]
                       overflow-y-auto overflow-x-hidden md:hidden
                       bg-[var(--bg1)] border-r border-[var(--border)]"
          >
            {sidebar}
          </aside>
        </>
      )}
    </div>
  )
}

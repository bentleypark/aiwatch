// Layout shell — owns structural grid only.
// Desktop: Topbar(48px) + Ticker(34px) = 82px fixed header, then Grid (220px sidebar + 1fr content).
// Mobile: Topbar(48px) + ActionBar(~36px) = ~84px, sidebar as overlay.

const TOPBAR_H = 48
const TICKER_H = 34
const HEADER_H = TOPBAR_H + TICKER_H // 82px
const SIDEBAR_W = 220
const MOBILE_ACTION_BAR_H = 36
const MOBILE_HEADER_H = TOPBAR_H + MOBILE_ACTION_BAR_H // ~84px

export { TOPBAR_H, TICKER_H, HEADER_H, SIDEBAR_W }

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
      {/* Topbar — fixed full width, 48px, highest z */}
      <header
        className={`fixed inset-x-0 top-0 z-[60] h-[${TOPBAR_H}px] flex items-center
                   bg-[var(--bg1)] border-b border-[var(--border)]`}
      >
        {topbar}
      </header>

      {/* Ticker Bar — fixed full width, 34px, below Topbar. Hidden on mobile. */}
      <div
        className={`fixed inset-x-0 top-[${TOPBAR_H}px] h-[${TICKER_H}px] z-[50] hidden md:flex items-center
                   bg-[var(--bg2)] border-b border-[var(--border)]`}
      >
        {tickerBar}
      </div>

      {/* Mobile Action Bar — below topbar on mobile only */}
      <div className={`fixed inset-x-0 top-[${TOPBAR_H}px] z-[55] md:hidden`}>
        {mobileActionBar}
      </div>

      {/* Body — push content below fixed headers. Uses CSS utility class for responsive padding. */}
      <div className="header-offset">
        <div className="md:grid" style={{ gridTemplateColumns: `${SIDEBAR_W}px 1fr` }}>

          {/* Desktop sidebar — sticky, z-[51] so it renders above ticker bar */}
          <aside
            className={`hidden md:block sticky top-[${HEADER_H}px] h-[calc(100vh-${HEADER_H}px)] z-[51]
                       overflow-y-auto overflow-x-hidden
                       bg-[var(--bg1)] border-r border-[var(--border)]`}
          >
            {sidebar}
          </aside>

          {/* Content + Footer */}
          <div className={`flex flex-col min-h-[calc(100vh-${HEADER_H}px)]`}>
            <main className="flex-1">
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
            className={`fixed left-0 top-0 z-[80] h-full w-[${SIDEBAR_W}px] pt-[${TOPBAR_H}px]
                       overflow-y-auto overflow-x-hidden md:hidden
                       bg-[var(--bg1)] border-r border-[var(--border)]`}
          >
            {sidebar}
          </aside>
        </>
      )}
    </div>
  )
}

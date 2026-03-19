// Layout shell — owns structural grid only.
// Topbar, TickerBar, Sidebar, and Footer are injected as render props.

const TOPBAR_H = 48
const TICKER_H = 34
const HEADER_H = TOPBAR_H + TICKER_H // 82px
const SIDEBAR_W = 220

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
      {/* Topbar — fixed, 48px, z-[60] (above mobile drawer) */}
      <header
        className="fixed inset-x-0 top-0 z-[60] h-[48px] flex items-center
                   bg-[var(--bg1)] border-b border-[var(--border)]"
      >
        {topbar}
      </header>

      {/* Ticker Bar — fixed, 34px, below Topbar. Hidden on mobile. */}
      <div
        className="fixed inset-x-0 top-[48px] h-[34px] z-40 hidden md:flex items-center
                   bg-[var(--bg2)] border-b border-[var(--border)]"
      >
        {tickerBar}
      </div>

      {/* Mobile Action Bar — sits below topbar, above content on mobile only */}
      <div className="fixed inset-x-0 top-[48px] z-[55] md:hidden">
        {mobileActionBar}
      </div>

      {/* Body — pt accounts for topbar+actionbar on mobile, topbar+ticker on desktop */}
      <div className="flex pt-[84px] md:pt-[82px]">
        {/* Desktop sidebar — fixed left, hidden on mobile */}
        <aside
          className="fixed left-0 top-[82px] w-[220px] h-[calc(100vh-82px)]
                     hidden md:block overflow-y-auto z-30
                     bg-[var(--bg1)] border-r border-[var(--border)]"
        >
          {sidebar}
        </aside>

        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/50 md:hidden"
              onClick={onSidebarClose}
              aria-hidden="true"
            />
            {/* Drawer — z-50, below topbar z-[60] */}
            <aside
              className="fixed left-0 top-0 z-50 h-full w-[220px] pt-[48px]
                         overflow-y-auto md:hidden
                         bg-[var(--bg1)] border-r border-[var(--border)]"
            >
              {sidebar}
            </aside>
          </>
        )}

        {/* Content Area — full width on mobile, offset by sidebar on md+ */}
        <main className="flex-1 w-full md:ml-[220px] min-h-[calc(100vh-82px)]">
          {children}
        </main>
      </div>

      {/* Footer — offset by sidebar on md+ */}
      <footer className="md:ml-[220px] bg-[var(--bg1)] border-t border-[var(--border)]">
        {footer}
      </footer>
    </div>
  )
}

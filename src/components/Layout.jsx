// Layout shell — individual regions (Topbar, TickerBar, Sidebar, Footer)
// are implemented in Issues #5–#7. This file owns the structural grid only.

const TOPBAR_H = 48
const TICKER_H = 34
const HEADER_H = TOPBAR_H + TICKER_H // 82px
const SIDEBAR_W = 220

export { TOPBAR_H, TICKER_H, HEADER_H, SIDEBAR_W }

export default function Layout({ children, topbar, tickerBar, sidebar, footer }) {
  return (
    <div className="min-h-screen bg-[var(--bg0)]">
      {/* Topbar — fixed, 48px, z-50 */}
      <header
        className="fixed inset-x-0 top-0 z-50 flex items-center
                   bg-[var(--bg1)] border-b border-[var(--border)]"
        style={{ height: TOPBAR_H }}
      >
        {topbar}
      </header>

      {/* Ticker Bar — fixed, 34px, directly below Topbar. Hidden on mobile. */}
      <div
        className="fixed inset-x-0 z-40 hidden md:flex items-center
                   bg-[var(--bg2)] border-b border-[var(--border)]"
        style={{ top: TOPBAR_H, height: TICKER_H }}
      >
        {tickerBar}
      </div>

      {/* Body — pt-[48px] on mobile (no ticker), pt-[82px] on md+ */}
      <div className="flex pt-[48px] md:pt-[82px]">
        {/* Sidebar — fixed left, hidden on mobile (overlay handled in Issue #7) */}
        <aside
          className="fixed left-0 hidden md:block overflow-y-auto
                     bg-[var(--bg1)] border-r border-[var(--border)]"
          style={{
            top: HEADER_H,
            width: SIDEBAR_W,
            height: `calc(100vh - ${HEADER_H}px)`,
          }}
        >
          {sidebar}
        </aside>

        {/* Content Area — full width on mobile, offset by sidebar on md+ */}
        <main className={`flex-1 w-full md:ml-[${SIDEBAR_W}px] min-h-[calc(100vh-${HEADER_H}px)]`}>
          {children}
        </main>
      </div>

      {/* Footer — offset by sidebar on md+ */}
      <footer
        className={`md:ml-[${SIDEBAR_W}px] bg-[var(--bg1)] border-t border-[var(--border)]`}
      >
        {footer}
      </footer>
    </div>
  )
}

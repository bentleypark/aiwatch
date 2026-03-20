import { useCallback } from 'react'
import { usePage } from '../utils/pageContext'
import { useLang } from '../hooks/useLang'
import { usePolling } from '../hooks/usePolling'
import { formatTime } from '../utils/time'
import { trackEvent } from '../utils/analytics'

const VERSION = 'v1.0.0'

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path
        d="M6.5 1.5h3l.4 1.7a5.5 5.5 0 011.3.7l1.6-.6 1.5 2.6-1.2 1.1a5.5 5.5 0 010 1.5l1.2 1.1-1.5 2.6-1.6-.6a5.5 5.5 0 01-1.3.7l-.4 1.7h-3l-.4-1.7a5.5 5.5 0 01-1.3-.7l-1.6.6-1.5-2.6 1.2-1.1a5.5 5.5 0 010-1.5L2.7 5.9l1.5-2.6 1.6.6a5.5 5.5 0 011.3-.7z"
        stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function HamburgerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export default function Topbar({ onMenuToggle }) {
  const { page, setPage } = usePage()
  const { lang, t } = useLang()
  const { lastUpdated, refresh, refreshing } = usePolling()
  const isSettings = page.name === 'settings'

  const handleRefresh = useCallback(() => {
    if (refreshing) return
    trackEvent('click_refresh')
    refresh()
  }, [refreshing, refresh])

  const refreshLabel = refreshing ? t('topbar.refresh.loading') : t('topbar.refresh')

  return (
    <div className="flex items-center justify-between w-full" style={{ padding: '0 20px' }}>
      {/* Left: hamburger (mobile) + logo mark + logo text */}
      <div className="flex items-center gap-2.5">
        <button
          className="btn-topbar md:hidden flex items-center justify-center"
          style={{ padding: '6px', width: '32px', height: '32px', borderRadius: '6px' }}
          onClick={onMenuToggle}
          aria-label={t('topbar.menu.open')}
        >
          <HamburgerIcon />
        </button>

        <div className="w-[26px] h-[26px] bg-[var(--green)] rounded-[6px] flex items-center justify-center">
          <span className="w-2.5 h-2.5 border-2 border-[var(--bg0)] rounded-full" />
        </div>

        <span className="mono font-semibold text-[15px] select-none tracking-[-0.3px]">
          <span className="text-[var(--text0)]">AI</span>
          <span className="text-[var(--green)]">Watch</span>
        </span>
      </div>

      {/* Center: LIVE · time — hidden on mobile */}
      <div className="hidden md:flex items-center gap-1.5 mono text-[11px] text-[var(--text2)]">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] animate-[pulse_2s_ease-in-out_infinite]" />
        <span>{t('topbar.live')} · {lastUpdated ? formatTime(lastUpdated, lang) : '—'}</span>
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-2">
        <span className="hidden md:inline mono text-[10px] text-[var(--text2)]">{VERSION}</span>

        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="btn-topbar hidden md:inline-block"
        >
          {refreshLabel}
        </button>

        {/* Analyze — disabled with hover/focus tooltip */}
        <div className="hidden md:block relative group">
          <button
            aria-disabled="true"
            tabIndex={0}
            aria-describedby="analyze-tooltip"
            className="btn-topbar-disabled"
            onClick={(e) => { e.preventDefault(); trackEvent('click_analyze') }}
          >
            {t('topbar.analyze')} ↗
          </button>
          <div
            id="analyze-tooltip"
            role="tooltip"
            className="absolute top-[calc(100%+8px)] right-0 z-[200] bg-[var(--bg2)] border border-[var(--border-hi)] rounded-[6px] whitespace-nowrap opacity-0 -translate-y-1 pointer-events-none group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 transition-all duration-150"
            style={{ padding: '8px 12px' }}
          >
            <div className="absolute -top-[5px] right-3.5 w-2 h-2 rotate-45 bg-[var(--bg2)] border-t border-l border-[var(--border-hi)]" />
            <div className="mono text-[10px] text-[var(--blue)] tracking-wide flex items-center gap-1.5 mb-1">
              <span className="w-[5px] h-[5px] rounded-full bg-[var(--blue)]" />
              {t('topbar.analyze.tooltip.title')}
            </div>
            <div className="mono text-[10px] text-[var(--text2)] leading-relaxed">
              {t('topbar.analyze.tooltip.body')}
            </div>
          </div>
        </div>

        {/* Settings — gear icon + text */}
        <button
          onClick={() => setPage({ name: 'settings' })}
          className="btn-topbar"
          style={{
            display: 'flex', alignItems: 'center', gap: '5px',
            ...(isSettings ? { color: 'var(--green)', borderColor: 'var(--green)', background: 'var(--bg3)' } : {}),
          }}
          aria-label={t('nav.settings')}
        >
          <GearIcon />
          <span className="hidden md:inline">{t('nav.settings')}</span>
        </button>
      </div>
    </div>
  )
}

// Mobile Action Bar — rendered by Layout below the fixed topbar
export function MobileActionBar() {
  const { lang, t } = useLang()
  const { refresh, refreshing, lastUpdated } = usePolling()

  const handleRefresh = useCallback(() => {
    if (refreshing) return
    trackEvent('click_refresh')
    refresh()
  }, [refreshing, refresh])

  const refreshLabel = refreshing ? t('topbar.refresh.loading') : t('topbar.refresh')

  return (
    <div className="flex items-center gap-2 bg-[var(--bg1)] border-b border-[var(--border)]" style={{ padding: '8px 14px' }}>
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] animate-[pulse_2s_ease-in-out_infinite]" />
      <span className="mono text-[10px] text-[var(--text2)]">{t('topbar.live')} · {lastUpdated ? formatTime(lastUpdated, lang) : '—'}</span>
      <button
        onClick={handleRefresh}
        disabled={refreshing}
        className="btn-topbar ml-auto"
        style={{ fontSize: '11px', padding: '4px 10px' }}
      >
        {refreshLabel}
      </button>
    </div>
  )
}

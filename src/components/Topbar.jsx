import { useState, useCallback } from 'react'
import { usePage } from '../utils/pageContext'
import { useLang } from '../hooks/useLang'
import { formatTime } from '../utils/time'

const VERSION = 'v1.0.0'

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.6 3.6l.85.85M11.55 11.55l.85.85M3.6 12.4l.85-.85M11.55 4.45l.85-.85"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
      />
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

// Button style matching design mockup: 5px 12px padding, 5px radius, border-hi, 11px mono
const btnStyle = { padding: '5px 12px', borderRadius: '5px', letterSpacing: '0.3px' }
const btnCls = 'mono text-[11px] border border-[var(--border-hi)] bg-transparent text-[var(--text1)] cursor-pointer hover:bg-[var(--bg3)] hover:text-[var(--text0)] transition-all'

export default function Topbar({ onRefresh, onMenuToggle }) {
  const { setPage } = usePage()
  const { lang, t } = useLang()
  const [lastRefresh, setLastRefresh] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await onRefresh?.()
    } finally {
      setLastRefresh(new Date())
      setRefreshing(false)
    }
  }, [refreshing, onRefresh])

  const refreshLabel = refreshing
    ? '...'
    : lastRefresh
    ? `${formatTime(lastRefresh, lang)} ${t('topbar.refreshed')}`
    : t('topbar.refresh')

  return (
    <div className="flex items-center justify-between w-full" style={{ padding: '0 20px' }}>
      {/* Left: hamburger (mobile) + logo mark + logo text */}
      <div className="flex items-center gap-2.5">
        <button
          className="md:hidden flex items-center justify-center w-8 h-8 rounded
                     border border-[var(--border-hi)] bg-transparent text-[var(--text1)]
                     hover:bg-[var(--bg3)] hover:text-[var(--text0)] transition-all"
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
        <span>
          {t('topbar.live')}
          {lastRefresh ? ` · ${formatTime(lastRefresh, lang)}` : ' · —'}
        </span>
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-2">
        <span className="hidden md:inline mono text-[10px] text-[var(--text2)]">{VERSION}</span>

        <button
          onClick={handleRefresh}
          disabled={refreshing}
          style={btnStyle}
          className={`hidden md:inline-block ${btnCls} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {refreshLabel}
        </button>

        {/* Analyze — disabled with hover/focus tooltip */}
        <div className="hidden md:block relative group">
          <button
            aria-disabled="true"
            tabIndex={0}
            aria-describedby="analyze-tooltip"
            style={btnStyle}
            className={`${btnCls} opacity-50 cursor-not-allowed`}
            onClick={(e) => e.preventDefault()}
          >
            {t('topbar.analyze')} ↗
          </button>
          <div
            id="analyze-tooltip"
            role="tooltip"
            className="absolute top-[calc(100%+8px)] right-0 z-[200]
                        bg-[var(--bg2)] border border-[var(--border-hi)] rounded-[6px]
                        px-3 py-2 whitespace-nowrap
                        opacity-0 -translate-y-1 pointer-events-none
                        group-hover:opacity-100 group-hover:translate-y-0
                        group-focus-within:opacity-100 group-focus-within:translate-y-0
                        transition-all duration-150"
          >
            <div className="absolute -top-[5px] right-3.5 w-2 h-2 rotate-45
                            bg-[var(--bg2)] border-t border-l border-[var(--border-hi)]" />
            <div className="mono text-[10px] text-[var(--blue)] tracking-wide flex items-center gap-1.5 mb-1">
              <span className="w-[5px] h-[5px] rounded-full bg-[var(--blue)]" />
              {t('topbar.analyze.tooltip.title')}
            </div>
            <div className="mono text-[10px] text-[var(--text2)] leading-relaxed">
              {t('topbar.analyze.tooltip.body')}
            </div>
          </div>
        </div>

        {/* Settings — SVG icon + text */}
        <button
          onClick={() => setPage({ name: 'settings' })}
          style={{ ...btnStyle, display: 'flex', alignItems: 'center', gap: '5px' }}
          className={`${btnCls}`}
          aria-label={t('nav.settings')}
        >
          <GearIcon />
          <span className="hidden md:inline">Settings</span>
        </button>
      </div>
    </div>
  )
}

// Mobile Action Bar — rendered by Layout below the fixed topbar
export function MobileActionBar({ onRefresh }) {
  const { lang, t } = useLang()
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(null)

  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await onRefresh?.()
    } finally {
      setLastRefresh(new Date())
      setRefreshing(false)
    }
  }, [refreshing, onRefresh])

  const refreshLabel = refreshing
    ? '...'
    : lastRefresh
    ? `${formatTime(lastRefresh, lang)} ${t('topbar.refreshed')}`
    : t('topbar.refresh')

  return (
    <div className="flex items-center gap-2 px-3.5 py-2
                    bg-[var(--bg1)] border-b border-[var(--border)]">
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] animate-[pulse_2s_ease-in-out_infinite]" />
      <span className="mono text-[10px] text-[var(--text2)]">{t('topbar.live')}</span>
      <button
        onClick={handleRefresh}
        disabled={refreshing}
        className="ml-auto mono text-[11px] px-2.5 py-1 rounded border
                   border-[var(--border-hi)] bg-transparent text-[var(--text1)]
                   hover:bg-[var(--bg3)] disabled:opacity-50 disabled:cursor-not-allowed
                   transition-all"
      >
        {refreshLabel}
      </button>
    </div>
  )
}

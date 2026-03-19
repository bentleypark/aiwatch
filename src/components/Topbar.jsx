import { useState, useCallback } from 'react'
import { usePage } from '../utils/pageContext'
import { useLang } from '../hooks/useLang'

const VERSION = 'v1.0.0'

const LOCALE_MAP = { ko: 'ko-KR', en: 'en-US' }

function formatTime(date, lang) {
  return date.toLocaleTimeString(LOCALE_MAP[lang] ?? 'ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export default function Topbar({ onRefresh, onMenuToggle }) {
  const { setPage } = usePage()
  const { lang, t } = useLang()
  const [lastRefresh, setLastRefresh] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      // TODO: pass onRefresh from usePolling when implemented
      await onRefresh?.()
    } finally {
      setLastRefresh(new Date())
      setRefreshing(false)
    }
  }, [refreshing, onRefresh])

  return (
    <div className="flex items-center justify-between w-full px-4">
      {/* Left: hamburger (mobile) + logo + LIVE */}
      <div className="flex items-center gap-3">
        {/* Hamburger — mobile only */}
        <button
          className="md:hidden flex flex-col gap-[5px] p-1"
          onClick={onMenuToggle}
          aria-label={t('topbar.menu.open')}
        >
          <span className="block w-5 h-px bg-[var(--text1)]" />
          <span className="block w-5 h-px bg-[var(--text1)]" />
          <span className="block w-5 h-px bg-[var(--text1)]" />
        </button>

        {/* Logo */}
        <span className="mono font-semibold text-sm select-none">
          <span className="text-[var(--text0)]">AI</span>
          <span className="text-[var(--green)]">Watch</span>
        </span>

        {/* LIVE indicator — hidden on mobile */}
        <span className="hidden md:flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--green)] opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--green)]" />
          </span>
          <span className="mono text-xs text-[var(--green)]">{t('topbar.live')}</span>
        </span>
      </div>

      {/* Right: actions + version */}
      <div className="flex items-center gap-2">
        {/* Version — hidden on mobile */}
        <span className="hidden md:inline mono text-xs text-[var(--text2)]">{VERSION}</span>

        {/* Refresh button */}
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="mono text-xs px-3 py-1 rounded border
                     border-[var(--border)] bg-[var(--bg2)] text-[var(--text1)]
                     hover:bg-[var(--bg3)] hover:text-[var(--text0)]
                     disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors"
        >
          {refreshing
            ? '...'
            : lastRefresh
            ? `${formatTime(lastRefresh, lang)} ${t('topbar.refreshed')}`
            : t('topbar.refresh')}
        </button>

        {/* Analyze button — Phase 3, disabled */}
        <button
          disabled
          className="hidden md:inline mono text-xs px-3 py-1 rounded border
                     border-[var(--border)] bg-[var(--bg2)] text-[var(--text2)]
                     opacity-50 cursor-not-allowed"
          title={t('topbar.analyze.soon')}
        >
          {t('topbar.analyze')}
          <span className="ml-1 text-[10px] text-[var(--amber)]">
            {t('topbar.analyze.soon')}
          </span>
        </button>

        {/* Settings button */}
        <button
          onClick={() => setPage({ name: 'settings' })}
          className="mono text-base px-2 py-1 rounded border
                     border-[var(--border)] bg-[var(--bg2)] text-[var(--text1)]
                     hover:bg-[var(--bg3)] hover:text-[var(--text0)]
                     transition-colors"
          aria-label={t('nav.settings')}
        >
          ⚙
        </button>
      </div>
    </div>
  )
}

import { useCallback, useState } from 'react'
import { usePage } from '../utils/pageContext'
import { useLang } from '../hooks/useLang'
import { usePolling } from '../hooks/usePolling'
import { useGitHubStars } from '../hooks/useGitHubStars'
import { formatTime } from '../utils/time'
import { trackEvent } from '../utils/analytics'
import AnalysisModal from './AnalysisModal'

const VERSION = `v${__APP_VERSION__}`
const GITHUB_URL = 'https://github.com/bentleypark/aiwatch'

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
  const { services, lastUpdated, refresh, refreshing, aiAnalysis } = usePolling()
  const stars = useGitHubStars()
  const isSettings = page.name === 'settings'
  const [showAnalysis, setShowAnalysis] = useState(false)
  // Only show Analyze button as active when there are analyses for services with active incidents
  const hasAnalysis = Object.entries(aiAnalysis ?? {}).some(([svcId, analysis]) => {
    const svc = services.find(s => s.id === svcId)
    return svc && (svc.incidents ?? []).some(i => i.status !== 'resolved' && i.id === analysis.incidentId)
  })

  const handleRefresh = useCallback(() => {
    if (refreshing) return
    trackEvent('click_refresh')
    refresh()
  }, [refreshing, refresh])

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

        <a href="/" className="flex items-center gap-2.5 no-underline" onClick={(e) => { e.preventDefault(); window.location.href = window.location.pathname }}>
          <img src="/favicon.png" alt="" width={28} height={28} className="rounded-[4px]" />
          <span className="mono font-semibold text-[15px] select-none tracking-[-0.3px]">
            <span className="text-[var(--text0)]">AI</span>
            <span className="text-[var(--green)]">Watch</span>
          </span>
        </a>
      </div>

      {/* Center: LIVE · time */}
      <div className="flex items-center gap-1.5 mono text-[10px] md:text-[11px] text-[var(--text2)] min-w-0">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] animate-[pulse_2s_ease-in-out_infinite]" />
        <span>{t('topbar.live')} · {lastUpdated ? formatTime(lastUpdated, lang) : '—'}</span>
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-2">
        <span className="hidden md:inline mono text-[10px] text-[var(--text2)]">{VERSION}</span>

        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 mono text-[10px] text-[var(--text2)] hover:text-[var(--text0)] transition-colors"
          onClick={() => trackEvent('click_github_header')}
          aria-label="GitHub"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          <span className="hidden md:inline">{stars != null && stars >= 100 ? `★ ${stars}` : 'GitHub'}</span>
        </a>

        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="topbar-action"
          aria-label={t('topbar.refresh')}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className={refreshing ? 'animate-spin' : ''}>
            <path d="M14 8A6 6 0 114.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M4.5 0.5v3h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="hidden md:inline">{refreshing ? t('topbar.refresh.loading').replace('↻ ', '') : t('topbar.refresh').replace('↻ ', '')}</span>
        </button>

        {/* Analyze — mobile: icon-only when active, desktop: full button */}
        {hasAnalysis && (
          <button
            className="md:hidden relative"
            style={{ fontSize: '14px', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            onClick={() => { setShowAnalysis(true); trackEvent('click_analyze', { has_analysis: true, count: Object.keys(aiAnalysis).length }) }}
            aria-label={t('topbar.analyze')}
          >
            🤖
            <span className="absolute rounded-full" style={{ top: '-2px', right: '-2px', width: '6px', height: '6px', background: 'var(--green)' }} />
          </button>
        )}
        <div className="hidden md:block relative group">
          {hasAnalysis ? (
            <button
              className="btn-topbar"
              onClick={() => { setShowAnalysis(true); trackEvent('click_analyze', { has_analysis: true, count: Object.keys(aiAnalysis).length }) }}
            >
              🤖 {t('topbar.analyze')} <span className="mono text-[8px] rounded" style={{ color: 'var(--purple)', background: 'rgba(124,58,237,0.15)', padding: '1px 4px', verticalAlign: 'middle', position: 'relative', top: '-1px' }}>Beta</span>
            </button>
          ) : (
            <button
              aria-disabled="true"
              tabIndex={0}
              aria-describedby="analyze-tooltip"
              className="btn-topbar-disabled"
              onClick={(e) => { e.preventDefault(); trackEvent('click_analyze') }}
            >
              {t('topbar.analyze')} ↗
            </button>
          )}
          {!hasAnalysis && (
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
          )}
        </div>

        {/* Settings — gear icon + text */}
        <button
          onClick={() => setPage({ name: 'settings' })}
          className="topbar-action"
          style={{
            ...(isSettings ? { color: 'var(--green)', borderColor: 'var(--green)', background: 'var(--bg3)' } : {}),
          }}
          aria-label={t('nav.settings')}
        >
          <GearIcon />
          <span className="hidden md:inline">{t('nav.settings')}</span>
        </button>
      </div>
      {showAnalysis && hasAnalysis && (
        <AnalysisModal aiAnalysis={aiAnalysis} services={services} onClose={() => setShowAnalysis(false)} />
      )}
    </div>
  )
}


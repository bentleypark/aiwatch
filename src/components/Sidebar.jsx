// Sidebar — Dashboard menu + 13 AI service list with live polling data.
// Layout matches design mockup: section titles, nav items with icons/badges, uptime badges.

import { useMemo } from 'react'
import { usePage } from '../utils/pageContext'
import { useLang } from '../hooks/useLang'
import { usePolling } from '../hooks/usePolling'
import { trackEvent } from '../utils/analytics'
import { SERVICE_CATEGORIES, ALL_SERVICES_FEED_URL, categoryRankOf } from '../utils/constants'
import { isUnreliableUptime } from '../utils/serviceReliability'
import RssCopyIcon from './RssCopyIcon'

const EMPTY = []

// ── Nav icons (14×14 SVGs from design mockup) ───────────

function IconGrid() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.6 }}>
      <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function IconChart() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.6 }}>
      <path d="M2 10L5 7L7 9L10 5L12 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconClock() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.6 }}>
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 4V7L9 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function IconTarget() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.6 }}>
      <path d="M7 1v2M7 11v2M1 7h2M11 7h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function IconTrophy() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.6 }}>
      <path d="M4 2h6v4a3 3 0 01-6 0V2z" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 9v2M5 12h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function IconReport() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.6 }}>
      <rect x="2" y="1" width="10" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 4h4M5 7h4M5 10h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function IconBook() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.6 }}>
      <path d="M7 3.4C5.8 2.5 4 2.3 2.4 2.9v8c1.6-.6 3.4-.4 4.6.5 1.2-.9 3-1.1 4.6-.5v-8C10 2.3 8.2 2.5 7 3.4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M7 3.4v8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function IconSend() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.6 }}>
      <path d="M2 2l10 5-10 5V8l6-1-6-1V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

function IconBadge() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.6 }}>
      <path d="M2.6 2.6h4.6c.3 0 .6.1.8.4l3.4 3.4c.4.4.4 1 0 1.4l-3 3c-.4.4-1 .4-1.4 0L3.6 7.4a1.1 1.1 0 0 1-.4-.8V2.6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="5" cy="5" r="0.9" fill="currentColor" />
    </svg>
  )
}

function IconTerminal() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.6 }}>
      <rect x="1.5" y="2.5" width="11" height="9" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 6l2 1.5L4 9M7 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconPlugin() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.6 }}>
      <path d="M8.6 2.2a1.2 1.2 0 0 0-2.4 0v.9H3.3v2.9h-.9a1.2 1.2 0 1 0 0 2.4h.9v2.9h2.9v-.9a1.2 1.2 0 0 1 2.4 0v.9h2.9V8.4h.9a1.2 1.2 0 1 0 0-2.4h-.9V3.1H8.6v-.9z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  )
}

const NAV_ICONS = { overview: IconGrid, latency: IconChart, incidents: IconClock, uptime: IconTarget, ranking: IconTrophy }

const DASHBOARD_ITEMS = [
  { name: 'overview', labelKey: 'nav.overview' },
  { name: 'latency', labelKey: 'nav.latency' },
  { name: 'incidents', labelKey: 'nav.incidents' },
  { name: 'uptime', labelKey: 'nav.uptime' },
  { name: 'ranking', labelKey: 'nav.ranking' },
]

const STATUS_DOT_CLASS = {
  operational: 'bg-[var(--green)]',
  degraded: 'bg-[var(--amber)]',
  down: 'bg-[var(--red)]',
}

function uptimeBadgeCls(uptime) {
  if (uptime >= 99) return 'bg-[var(--status-bg-green)] text-[var(--green)]'
  if (uptime >= 97) return 'bg-[var(--status-bg-amber)] text-[var(--amber)]'
  return 'bg-[var(--status-bg-red)] text-[var(--red)]'
}

// Shared nav-item style matching design mockup exactly
const navItemStyle = { padding: '7px 8px', gap: '8px', borderRadius: '6px', fontSize: '12px', position: 'relative' }
const activeBarStyle = { position: 'absolute', left: 0, top: '4px', bottom: '4px', width: '2px', borderRadius: '2px', background: 'var(--green)' }
const sectionTitleStyle = { padding: '6px 8px', letterSpacing: '0.12em', fontSize: '9px', textTransform: 'uppercase', color: 'var(--text2)', fontFamily: 'var(--font-mono)' }
const badgeStyle = { padding: '1px 5px', borderRadius: '3px', fontSize: '9px', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }
const uptimeBadgeStyle = { ...badgeStyle, whiteSpace: 'nowrap', minWidth: '46px', textAlign: 'right' }

function ServiceNavItem({ svc, page, setPage, onNavigate }) {
  const active = page.name === 'service' && page.serviceId === svc.id
  const dotClass = STATUS_DOT_CLASS[svc.status] ?? STATUS_DOT_CLASS.operational
  const hasUptime = svc.uptime30d != null && !isUnreliableUptime(svc) // #591 — hide frozen stale uptime too
  const badgeCls = hasUptime ? uptimeBadgeCls(svc.uptime30d) : 'bg-[var(--bg3)] text-[var(--text2)]'
  const statusTextCls = svc.status === 'degraded' ? 'text-[var(--amber)]'
    : svc.status === 'down' ? 'text-[var(--red)]' : null

  return (
    <button
      onClick={() => { trackEvent('view_service', { service_id: svc.id }); setPage({ name: 'service', serviceId: svc.id }); onNavigate?.() }}
      aria-current={active ? 'page' : undefined}
      className={`w-full text-left flex items-center transition-all cursor-pointer
        ${active ? `bg-[var(--bg3)] ${statusTextCls ?? 'text-[var(--text0)]'}`
          : `${statusTextCls ?? 'text-[var(--text1)]'} hover:bg-[var(--bg3)] hover:text-[var(--text0)]`}`}
      style={navItemStyle}
    >
      {active && <span style={activeBarStyle} />}
      <span className={`rounded-full shrink-0 ${dotClass}`} style={{ width: '6px', height: '6px' }} aria-hidden="true" />
      <span className="flex-1 min-w-0 truncate">{svc.name}</span>
      {hasUptime && (
        <span className={`shrink-0 ${badgeCls}`} style={uptimeBadgeStyle}>
          {svc.uptime30d.toFixed(2)}%
        </span>
      )}
    </button>
  )
}

const CATEGORY_KEYS = Object.keys(SERVICE_CATEGORIES)

export default function Sidebar({ visibleServiceIds, onNavigate }) {
  const { page, setPage, categoryFilter, setCategoryFilter } = usePage()
  const { t } = useLang()
  const { services: rawServices } = usePolling()
  const services = rawServices ?? EMPTY

  const visibleServices = visibleServiceIds
    ? services.filter((s) => visibleServiceIds.includes(s.id))
    : services

  const categoryIds = SERVICE_CATEGORIES[categoryFilter]?.ids
  const categoryServices = categoryIds
    ? visibleServices.filter((s) => categoryIds.includes(s.id))
    : visibleServices
  // #676 — order the flat list by category rank (LLM → Agents → Voice → Inference → Video → Apps) so it
  // matches the filter chips + Overview sections (Apps last, Agents directly after LLM) instead of the
  // raw worker order (api → apps → agents). Stable sort keeps the worker order WITHIN each bucket.
  const orderedServices = [...categoryServices].sort((a, b) => categoryRankOf(a.id) - categoryRankOf(b.id))

  const issueCount = useMemo(() => services.filter((s) => s.status !== 'operational').length, [services])
  // Count only unresolved incidents (investigating/identified/monitoring), deduplicated
  const incidentCount = useMemo(() => {
    const seen = new Set()
    return services.reduce((sum, s) =>
      sum + (s.incidents ?? []).filter((inc) => {
        if (seen.has(inc.id)) return false
        seen.add(inc.id)
        return inc.status !== 'resolved'
      }).length
    , 0)
  }, [services])

  return (
    <div className="flex flex-col h-full" style={{ padding: '16px 0' }}>

      {/* ── Dashboard section ── */}
      {/* NOTE: inline styles used because Tailwind v4 fails to apply certain utilities
           (py-[7px], px-[8px], gap-[8px]) on button elements due to base layer reset. */}
      <nav style={{ padding: '0 12px', marginBottom: '8px' }} aria-label="Dashboard">
        <div style={sectionTitleStyle}>{t('nav.dashboard')}</div>
        {DASHBOARD_ITEMS.map((item) => {
          const active = page.name === item.name
          const Icon = NAV_ICONS[item.name]
          const badge =
            item.name === 'overview' && issueCount > 0
              ? { count: issueCount, cls: 'bg-[var(--status-bg-red)] text-[var(--red)]' }
              : item.name === 'incidents' && incidentCount > 0
              ? { count: incidentCount, cls: 'bg-[var(--status-bg-red)] text-[var(--red)]' }
              : null

          return (
            <button
              key={item.name}
              onClick={() => { trackEvent('navigate_page', { page: item.name }); setPage({ name: item.name }); onNavigate?.() }}
              aria-current={active ? 'page' : undefined}
              className={`w-full text-left flex items-center transition-all cursor-pointer
                ${active ? 'bg-[var(--bg3)] text-[var(--text0)]' : 'text-[var(--text1)] hover:bg-[var(--bg3)] hover:text-[var(--text0)]'}`}
              style={navItemStyle}
            >
              {active && <span style={activeBarStyle} />}
              <span className="shrink-0">{Icon && <Icon />}</span>
              {t(item.labelKey)}
              {badge && (
                <span className={badge.cls} style={badgeStyle}>{badge.count}</span>
              )}
            </button>
          )
        })}
        <a
          href="/reports/"
          onClick={() => { trackEvent('click_reports', {}); onNavigate?.() }}
          className="w-full text-left flex items-center transition-all cursor-pointer text-[var(--text1)] hover:bg-[var(--bg3)] hover:text-[var(--text0)]"
          style={navItemStyle}
        >
          <span className="shrink-0"><IconReport /></span>
          {t('nav.reports')}
        </a>
        {/* #673 — external link to the public /methodology page (Edge route, not a SPA page) */}
        <a
          href="/methodology"
          onClick={() => { trackEvent('click_methodology', { location: 'sidebar' }); onNavigate?.() }}
          className="w-full text-left flex items-center transition-all cursor-pointer text-[var(--text1)] hover:bg-[var(--bg3)] hover:text-[var(--text0)]"
          style={navItemStyle}
        >
          <span className="shrink-0"><IconBook /></span>
          {t('nav.methodology')}
        </a>
        {/* #805 — external link to the public /badges gallery (Edge route, not a SPA page) */}
        <a
          href="/badges"
          onClick={() => { trackEvent('click_badges', { location: 'sidebar' }); onNavigate?.() }}
          className="w-full text-left flex items-center transition-all cursor-pointer text-[var(--text1)] hover:bg-[var(--bg3)] hover:text-[var(--text0)]"
          style={navItemStyle}
        >
          <span className="shrink-0"><IconBadge /></span>
          {t('nav.badges')}
        </a>
        {/* "Request a service" is a feedback link, not a Claude Code integration — grouped with the data/resources items above the divider. */}
        <a
          href="https://github.com/bentleypark/aiwatch/issues/new?template=service_request.md"
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => { trackEvent('click_request_service', {}); onNavigate?.() }}
          className="w-full text-left flex items-center transition-all cursor-pointer text-[var(--text1)] hover:bg-[var(--bg3)] hover:text-[var(--text0)]"
          style={navItemStyle}
        >
          <span className="shrink-0"><IconSend /></span>
          {t('nav.requestService')}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ marginLeft: 'auto', opacity: 0.4 }}>
            <path d="M3 1h6v6M9 1L4 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
        {/* Divider — separates the data/resources group above from the Claude Code integrations below.
            aria-hidden because this sits inside the nav landmark and is purely visual. */}
        <div aria-hidden="true" style={{ height: '1px', background: 'var(--border)', margin: '6px 0' }} />
        {/* #920 — Claude Code integrations group: the statusline SPA guide + the /plugin Edge landing. */}
        <div style={sectionTitleStyle}>{t('nav.claudeCode')}</div>
        {(() => {
          const isStatuslineActive = page.name === 'statusline'
          return (
            <button
              onClick={() => { trackEvent('navigate_page', { page: 'statusline' }); setPage({ name: 'statusline' }); onNavigate?.() }}
              aria-current={isStatuslineActive ? 'page' : undefined}
              className={`w-full text-left flex items-center transition-all cursor-pointer
                ${isStatuslineActive ? 'bg-[var(--bg3)] text-[var(--text0)]' : 'text-[var(--text1)] hover:bg-[var(--bg3)] hover:text-[var(--text0)]'}`}
              style={navItemStyle}
            >
              {isStatuslineActive && <span style={activeBarStyle} />}
              <span className="shrink-0"><IconTerminal /></span>
              {t('nav.statusline')}
            </button>
          )
        })()}
        {/* #920 — external link to the public /plugin landing (Edge route, not a SPA page) */}
        <a
          href="/plugin"
          onClick={() => { trackEvent('click_plugin', { location: 'sidebar' }); onNavigate?.() }}
          className="w-full text-left flex items-center transition-all cursor-pointer text-[var(--text1)] hover:bg-[var(--bg3)] hover:text-[var(--text0)]"
          style={navItemStyle}
        >
          <span className="shrink-0"><IconPlugin /></span>
          {t('nav.plugin')}
          {/* #920 — plugin is pre-marketplace-approval; mirrors the AI Analysis "Beta" pill convention */}
          <span className="mono" style={{ marginLeft: '6px', color: 'var(--purple)', background: 'rgba(124,58,237,0.15)', padding: '1px 5px', borderRadius: '3px', fontSize: '9px' }}>Beta</span>
        </a>
      </nav>

      {/* ── Divider ── */}
      <div style={{ height: '1px', background: 'var(--border)', margin: '8px 12px' }} />

      {/* ── Category filter tabs ── */}
      <div style={{ padding: '0 12px', marginBottom: '4px' }}>
        <div style={sectionTitleStyle}>{t('nav.services')}</div>
        <div className="flex flex-wrap" style={{ gap: '3px' }}>
          {CATEGORY_KEYS.map((key) => (
            <button
              key={key}
              onClick={() => { setCategoryFilter(key); trackEvent('category_filter', { category: key }) }}
              className="mono text-[9px] rounded transition-all cursor-pointer"
              style={{
                padding: '3px 7px',
                letterSpacing: '0.03em',
                background: categoryFilter === key ? 'var(--bg4)' : 'transparent',
                color: categoryFilter === key ? 'var(--text0)' : 'var(--text2)',
                border: categoryFilter === key ? '1px solid var(--border-hi)' : '1px solid transparent',
              }}
            >
              {t(SERVICE_CATEGORIES[key].labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Filtered service list — single flat list in #658 category order (#676).
           flex-1 min-h-0 so the list takes the remaining height and scrolls WITHIN itself
           (not the whole sidebar), keeping the footer pinned + always-visible regardless of
           how many services are listed (#601 — broke at 39 services without this). ── */}
      <nav className="flex-1 min-h-0 overflow-y-auto" style={{ padding: '0 12px' }} aria-label={t('nav.services')}>
        {orderedServices.map((svc) => (
          <ServiceNavItem key={svc.id} svc={svc} page={page} setPage={setPage} onNavigate={onNavigate} />
        ))}
      </nav>

      {/* ── Footer ── */}
      <div className="mt-auto">
        <div style={{ height: '1px', background: 'var(--border)', margin: '8px 12px' }} />
        <div style={{ padding: '0 12px' }}>
          <div className="text-[var(--text2)] flex items-center" style={{ padding: '6px 8px', letterSpacing: '0.06em', fontSize: '9px', gap: '7px' }}>
            <span>aiwatch.dev · v{__APP_VERSION__}</span>
            {/* Passive always-visible subscribe affordance (#433) */}
            <RssCopyIcon url={ALL_SERVICES_FEED_URL} location="sidebar" size={11} />
          </div>
        </div>
      </div>
    </div>
  )
}

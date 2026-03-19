// Sidebar — Dashboard menu + 13 AI service list with live polling data.
// Layout matches design mockup: section titles, nav items with icons/badges, uptime badges.

import { useMemo } from 'react'
import { usePage } from '../utils/pageContext'
import { useLang } from '../hooks/useLang'
import { usePolling } from '../hooks/usePolling'

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

const NAV_ICONS = { overview: IconGrid, latency: IconChart, incidents: IconClock, uptime: IconTarget }

const DASHBOARD_ITEMS = [
  { name: 'overview', labelKey: 'nav.overview' },
  { name: 'latency', labelKey: 'nav.latency' },
  { name: 'incidents', labelKey: 'nav.incidents' },
  { name: 'uptime', labelKey: 'nav.uptime' },
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

function ServiceNavItem({ svc, page, setPage }) {
  const active = page.name === 'service' && page.serviceId === svc.id
  const dotClass = STATUS_DOT_CLASS[svc.status] ?? STATUS_DOT_CLASS.operational
  const badgeCls = uptimeBadgeCls(svc.uptime30d ?? 100)
  const statusTextCls = svc.status === 'degraded' ? 'text-[var(--amber)]'
    : svc.status === 'down' ? 'text-[var(--red)]' : null

  return (
    <button
      onClick={() => setPage({ name: 'service', serviceId: svc.id })}
      aria-current={active ? 'page' : undefined}
      className={`w-full text-left flex items-center transition-all cursor-pointer
        ${active ? 'bg-[var(--bg3)] text-[var(--text0)]'
          : `${statusTextCls ?? 'text-[var(--text1)]'} hover:bg-[var(--bg3)] hover:text-[var(--text0)]`}`}
      style={navItemStyle}
    >
      {active && <span style={activeBarStyle} />}
      <span className={`rounded-full shrink-0 ${dotClass}`} style={{ width: '6px', height: '6px' }} aria-hidden="true" />
      <span className="flex-1 min-w-0 truncate">{svc.name}</span>
      <span className={`shrink-0 ${badgeCls}`} style={badgeStyle}>
        {(svc.uptime30d ?? 0).toFixed(1)}%
      </span>
    </button>
  )
}

export default function Sidebar({ visibleServiceIds }) {
  const { page, setPage } = usePage()
  const { t } = useLang()
  const { services: rawServices } = usePolling()
  const services = rawServices ?? EMPTY

  const visibleServices = visibleServiceIds
    ? services.filter((s) => visibleServiceIds.includes(s.id))
    : services

  const issueCount = useMemo(() => services.filter((s) => s.status !== 'operational').length, [services])
  const incidentCount = useMemo(() => services.reduce((sum, s) => sum + (s.incidents?.length ?? 0), 0), [services])

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
              onClick={() => setPage({ name: item.name })}
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
      </nav>

      {/* ── Divider ── */}
      <div style={{ height: '1px', background: 'var(--border)', margin: '8px 12px' }} />

      {/* ── Services section (API + WebApp) ── */}
      <div style={{ padding: '0 12px', marginBottom: '0' }}>
        <div style={sectionTitleStyle}>{t('nav.services')}</div>
      </div>
      <nav className="overflow-y-auto" style={{ padding: '0 12px' }}>
        {visibleServices.filter((s) => s.category !== 'agent').map((svc) => (
          <ServiceNavItem key={svc.id} svc={svc} page={page} setPage={setPage} />
        ))}
      </nav>

      {/* ── Coding Agents section ── */}
      {visibleServices.some((s) => s.category === 'agent') && (
        <>
          <div style={{ height: '1px', background: 'var(--border)', margin: '8px 12px' }} />
          <div style={{ padding: '0 12px', marginBottom: '0' }}>
            <div style={sectionTitleStyle}>{t('nav.agents')}</div>
          </div>
          <nav className="overflow-y-auto" style={{ padding: '0 12px' }}>
            {visibleServices.filter((s) => s.category === 'agent').map((svc) => (
              <ServiceNavItem key={svc.id} svc={svc} page={page} setPage={setPage} />
            ))}
          </nav>
        </>
      )}

      {/* ── Footer ── */}
      <div className="mt-auto">
        <div style={{ height: '1px', background: 'var(--border)', margin: '8px 12px' }} />
        <div style={{ padding: '0 12px' }}>
          <div className="text-[var(--text2)]" style={{ padding: '6px 8px', letterSpacing: '0.06em', fontSize: '9px' }}>
            {t('sidebar.footer')}
          </div>
        </div>
      </div>
    </div>
  )
}
